// Pure logic for a member's remembered interests: atomic `{ topic, note,
// weight, firstSeen, lastSeen }` items, incrementally updated by the analyzer
// (add/update/seen/remove) instead of a prose blob rewritten batch after
// batch -- see docs/prompt-contract.md ("Interests are atomic items",
// "Confirmation (the "(?)" mechanism)" and "Dates come from the messages", in
// "The analyzer") and src/memory/update.js#applyMemoryUpdate, which routes
// the model's `users.<id>.interests` through this module via
// src/memory/store.js#applyProfileOps. `normalizeInterests` validates
// whatever a profile's `interests` field currently holds on disk.
//
// Confirmation: `weight` counts the separate OCCASIONS a topic was observed,
// not how many ops mentioned it. A brand new item starts at weight 1, or 0
// when the op carries `sure: false`. `add`/`update` of an already-known topic
// and `seen` are each a SIGHTING; a sighting raises the weight by 1 only when
// the person's messages that produced it (`opts.seenAt`) are at least
// `opts.confirmGapHours` away from the item's stored `lastSeen` (a null
// `lastSeen` counts as far away) -- so one conversation split across several
// analyzer batches counts once. At most one bump per item per call,
// regardless of how many ops in that call target it. `sure: false` on an
// EXISTING item changes nothing at all, not even the note or the dates.
// `firstSeen`/`lastSeen` are min/max'd against `opts.seenAt` (the time of the
// person's message, not the wall clock the analyzer happened to run at), so
// history fed out of order (the memory warmup, src/memory/warmup.js) still ends up with
// correct dates.

import { topByRank } from './ranking.js';
import { clampText, stripUrls } from './clamp.js';
import { HOUR_MS } from '../time.js';

/** `memory.confirmGapHours` when it is missing (config.json carries the same). */
export const DEFAULT_CONFIRM_GAP_HOURS = 12;

/**
 * The identity a topic is compared by: trimmed, whitespace-collapsed,
 * lowercased (case-insensitive, Unicode-aware via the JS locale-agnostic
 * `toLowerCase`, the same approach src/memory/lore.js#normalizeTitle uses for
 * lorebook titles). Never stored -- comparison only. Reused as-is by
 * src/memory/details.js for a detail's text identity.
 * @param {string} topic
 */
export function normalizeTopic(topic) {
  return String(topic ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * The storage cap actually enforced: `max(storedMax, shownMax)` -- see
 * docs/prompt-contract.md, "More is stored than shown, and rank
 * decays with age". A deployment can show fewer than it stores, but never
 * store fewer than it shows, even when misconfigured. Neither value given ->
 * no cap (`Infinity`), same as before this feature existed. Shared by
 * interests, details (src/memory/details.js) and aliases
 * (src/memory/aliases.js) -- same trade-off, three item kinds; details.js
 * also imports `evictToCapacity`, `minIso`, `maxIso` and `isFarEnough` below.
 * @param {number} [storedMax]
 * @param {number} [shownMax]
 */
export function effectiveStorageCap(storedMax, shownMax) {
  const stored = Number.isInteger(storedMax) ? storedMax : -Infinity;
  const shown = Number.isInteger(shownMax) ? shownMax : -Infinity;
  const cap = Math.max(stored, shown);
  return Number.isFinite(cap) ? cap : Infinity;
}

/**
 * Drop items over `cap`, keeping the highest-ranked ones (see
 * src/memory/ranking.js#topByRank) while preserving `items`' own relative
 * order among the survivors -- eviction never reshuffles storage order, it
 * only decides who stays. What leaves is returned too, in storage order, so a
 * caller can keep it elsewhere before the list is written (the archive).
 * @param {object[]} items
 * @param {number} cap
 * @param {number} [halfLifeDays]
 * @returns {{ kept: object[], dropped: object[] }}  `kept` is `items` itself when nothing leaves.
 */
export function evictToCapacity(items, cap, halfLifeDays) {
  if (!Number.isFinite(cap) || items.length <= cap) return { kept: items, dropped: [] };
  const keep = new Set(topByRank(items, cap, halfLifeDays));
  return { kept: items.filter((item) => keep.has(item)), dropped: items.filter((item) => !keep.has(item)) };
}

/**
 * `value` with `list` attached under `key` as a NON-enumerable property: how a merge whose
 * return is a plain list (or an object stored as it is) also hands back what it dropped, without
 * changing what existing callers compare, spread or write to disk (JSON and object spread skip
 * it). The one copy, shared by the ranked items here, src/memory/affinity.js#applyDelta and
 * src/memory/store.js. Mutates and returns `value`.
 * @template T
 * @param {T} value
 * @param {string} key
 * @param {object[]} list
 * @returns {T}
 */
export function attachDropped(value, key, list) {
  Object.defineProperty(value, key, { value: list, enumerable: false, configurable: true, writable: true });
  return value;
}

/** Earlier of two ISO date strings; a missing one never wins. */
export function minIso(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return a < b ? a : b;
}

/** Later of two ISO date strings; a missing one never wins. */
export function maxIso(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * Whether a sighting at `seenAt` (ms) is far enough from `priorLastSeenIso`
 * to count as a NEW occasion rather than the same conversation continuing: a
 * missing or unparsable stored date counts as far away (nothing to compare
 * against, so it can only heal an item stuck at its starting weight).
 * @param {number} seenAt
 * @param {string|null} priorLastSeenIso
 * @param {number} gapMs
 * @returns {boolean}
 */
export function isFarEnough(seenAt, priorLastSeenIso, gapMs) {
  if (!priorLastSeenIso) return true;
  const priorMs = Date.parse(priorLastSeenIso);
  if (!Number.isFinite(priorMs)) return true;
  return Math.abs(seenAt - priorMs) >= gapMs;
}

/** A `YYYY-MM-DD` string that is a real calendar day, else null. */
export function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? value : null;
}

/** The validity fields a ranked item (interest, detail, alias) may carry. */
export const VALIDITY_FIELDS = Object.freeze(['recordedAt', 'validFrom', 'validTo', 'supersededBy', 'conflictSetId']);

/**
 * Copy the validity fields `raw` holds onto `item` (a normalised stored item): each one kept
 * only when present as a non-empty string or null; anything else is left out. An item that
 * never had one gets none, so an old item loads unchanged.
 * @param {object} item  Mutated.
 * @param {object} raw
 * @returns {object} `item`
 */
export function copyValidity(item, raw) {
  for (const key of VALIDITY_FIELDS) {
    if (!Object.hasOwn(raw, key)) continue;
    const value = raw[key];
    if (value === null || (typeof value === 'string' && value)) item[key] = value;
  }
  return item;
}

/** Whether a stored item is open: its `validTo` is unset (null or absent). */
export function isOpen(item) {
  return item?.validTo === undefined || item?.validTo === null;
}

/**
 * Apply the validity requests of one merge (`applyRankedOps` below,
 * src/memory/details.js#applyDetailOps) to `items` (the merged list, mutated). Each request is
 * `{ item, supersedes, validFrom, conflict }`, `item` the stored item an add/update op wrote;
 * a request that touches something sets `validFrom` (a real day) on that item, and
 * `recordedAt` when it has none. Then:
 *
 * - `supersedes` names another OPEN item of the list (by `itemId`, else through
 *   `findOther`): that one is closed -- `validTo` = the op's `validFrom` when given, else
 *   `batchDay`; `supersededBy` = the writing item's `itemId` -- and moves out of `items`
 *   into the returned list. Closing is not losing: a closed item is never in `dropped`.
 * - `conflict` names another open item: both get one `conflictSetId` (the named item's own,
 *   else its `itemId`).
 *
 * An item without an `itemId` gets one from `mintId` when it needs one and `mintId` is given.
 * A request naming the item itself, nothing, or a closed item changes nothing.
 * @param {object[]} items
 * @param {Array<{ item: object, supersedes?: unknown, validFrom?: unknown, conflict?: unknown }>} requests
 * @param {{ batchDay: string, recordedAt: string, mintId?: () => string,
 *   findOther: (ref: unknown) => (object|undefined) }} opts
 * @returns {object[]} The items closed, in the order closed.
 */
export function applyValidity(items, requests, { batchDay, recordedAt, mintId, findOther }) {
  const closed = [];
  const find = (ref) => {
    if (ref === undefined || ref === null || ref === '') return undefined;
    const byId = typeof ref === 'string' ? items.find((item) => item.itemId === ref) : undefined;
    return byId ?? findOther(ref);
  };
  const ensureId = (item) => {
    if (!(typeof item.itemId === 'string' && item.itemId) && typeof mintId === 'function') item.itemId = mintId();
    return typeof item.itemId === 'string' && item.itemId ? item.itemId : null;
  };
  const usable = (other, item) => other !== undefined && other !== item && isOpen(other) && items.includes(other);
  for (const { item, supersedes, validFrom, conflict } of requests) {
    if (!items.includes(item)) continue;
    const from = validDay(validFrom);
    const target = find(supersedes);
    const other = find(conflict);
    const closes = usable(target, item);
    const conflicts = usable(other, item);
    if (!from && !closes && !conflicts) continue;
    if (from) item.validFrom = from;
    if (!item.recordedAt) item.recordedAt = recordedAt;
    if (closes) {
      target.validTo = from ?? batchDay;
      target.supersededBy = ensureId(item);
      items.splice(items.indexOf(target), 1);
      closed.push(target);
    }
    if (conflicts) {
      const setId = other.conflictSetId ?? ensureId(other);
      if (setId) {
        ensureId(item);
        other.conflictSetId = setId;
        item.conflictSetId = setId;
      }
    }
  }
  return closed;
}

/**
 * Whether a stored item (interest or detail; anything with a `weight`) counts
 * as CONFIRMED for the chat model -- see docs/prompt-contract.md,
 * "Confirmation". Below this, the chat model sees it with `labels.profile.unsureMark`.
 * @param {{ weight?: number }} item
 * @param {number} [confirmAfter]
 */
export function isConfirmed(item, confirmAfter = 2) {
  return (item?.weight ?? 0) >= confirmAfter;
}

/**
 * Whether a stored item's `lastSeen` is old enough to render with
 * `labels.profile.staleMark` -- see docs/prompt-contract.md, "Dates
 * come from the messages". An unknown `lastSeen`, or a `staleDays` that is
 * not a positive number (feature off / not configured), is never stale.
 * @param {{ lastSeen?: string|null }} item
 * @param {number} nowMs
 * @param {number} [staleDays]
 */
export function isStale(item, nowMs, staleDays) {
  if (!Number.isFinite(staleDays) || staleDays <= 0) return false;
  const lastSeen = item?.lastSeen;
  if (!lastSeen) return false;
  const lastSeenMs = Date.parse(lastSeen);
  if (!Number.isFinite(lastSeenMs)) return false;
  return (nowMs - lastSeenMs) / (24 * HOUR_MS) > staleDays;
}

/**
 * Generic sighting-merge core shared by interests (`topic`/`note`) and
 * aliases (src/memory/aliases.js -- a bare `name`, no note): same
 * confirmation/gap/date/eviction bookkeeping either way, only the field
 * names and whether there is a "note" differ. `identityField` names the
 * item's identity string; `noteField`, when given, is an optional extra text
 * field copied onto a sighted item (omit it for an item kind that has none,
 * like an alias). Pure: `existing` is never mutated. Garbage in `ops` (wrong
 * types, malformed items) is silently skipped, never thrown on.
 *
 * - `add` of an unknown identity inserts it with weight 1, or 0 when the op
 *   carries `sure: false` (only meaningful when `noteField` is set -- a bare
 *   string op, as aliases use, is always sure).
 * - `add`/`update` of a known identity (case-insensitive via
 *   `normalizeTopic`), and `seen`, are each a sighting: see the module header
 *   comment for the weight-bump/gap rule. The note (when `noteField` is set)
 *   is replaced whenever the incoming one is non-empty, regardless of the gap.
 * - `update` of an unknown identity behaves exactly like `add`.
 * - `seen` never creates a new item.
 * - An op (`add`/`update`) with `sure: false` on an EXISTING item changes
 *   nothing at all, not even the note or the dates.
 * - `remove` deletes the item matching that identity, if any.
 * - The identity and the note lose their links (src/memory/clamp.js#stripUrls),
 *   then the identity is clamped to `identityChars`, the note (if any) to
 *   `noteChars`; an item whose identity is empty after that is rejected
 *   outright.
 * - Once over `opts.cap`, the lowest-RANKED items are evicted first (see
 *   src/memory/ranking.js#rank, driven by `halfLifeDays`) -- this runs on
 *   every call, even one with no ops, so a profile left over-stuffed by a
 *   lowered cap self-heals on its first update.
 * - Every stored item that leaves (a `remove`, then the eviction) is on the
 *   returned list's non-enumerable `dropped` (see `attachDropped`), as
 *   stored (its `itemId` included); `[]` when none left.
 * - An `add`/`update` object may carry `supersedes` (an `itemId`, else an
 *   identity), `validFrom` (`YYYY-MM-DD`) and `conflict` (an `itemId`, else an
 *   identity) -- see `applyValidity`; the items it closes are on the
 *   non-enumerable `closed` (`[]` when none), never in `dropped`. `mintId`
 *   gives a writing item its `itemId` when it needs one. A new item gets
 *   `recordedAt`, the ISO time of `now` (else `seenAt`).
 *
 * @param {object[]|undefined} existing
 * @param {{ add?: unknown, update?: unknown, seen?: unknown, remove?: unknown }} ops  Untrusted, model-extracted.
 * @param {{ identityField: string, noteField?: string, identityChars?: number, noteChars?: number,
 *   confirmGapHours?: number, seenAt?: number, halfLifeDays?: number, cap?: number, clampTolerance?: number,
 *   mintId?: () => string, now?: number }} opts
 *   The identity (`topic`/`name`) is a HARD clamp (no tolerance, still boundary-safe -- see
 *   src/memory/clamp.js); the note, when there is one, is clamped with `clampTolerance`
 *   (soft by default) since it is free text, not an identity.
 * @returns {object[]}
 */
export function applyRankedOps(
  existing,
  ops,
  { identityField, noteField, identityChars, noteChars, confirmGapHours, seenAt = Date.now(), halfLifeDays, cap, clampTolerance, mintId, now } = {},
) {
  const items = Array.isArray(existing) ? existing.map((item) => ({ ...item })) : [];
  const validity = [];
  const priorLastSeen = items.map((item) => item.lastSeen ?? null);
  const seenAtIso = new Date(seenAt).toISOString();
  const recordedAt = new Date(Number.isFinite(now) ? now : seenAt).toISOString();
  const gapMs = (Number.isFinite(confirmGapHours) ? confirmGapHours : DEFAULT_CONFIRM_GAP_HOURS) * HOUR_MS;
  const bumped = new Set();
  const removed = [];

  function findIndex(identity) {
    const norm = normalizeTopic(identity);
    return items.findIndex((item) => normalizeTopic(item[identityField]) === norm);
  }

  function sight(raw, { allowCreate }) {
    let identity;
    let note;
    let sure = true;
    if (noteField) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      identity = typeof raw[identityField] === 'string' ? clampText(stripUrls(raw[identityField]), identityChars, { tolerance: 1 }) : '';
      note = typeof raw[noteField] === 'string' ? clampText(stripUrls(raw[noteField]), noteChars, { tolerance: clampTolerance }) : '';
      sure = raw.sure !== false;
    } else {
      const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw[identityField] : raw;
      identity = typeof value === 'string' ? clampText(stripUrls(value), identityChars, { tolerance: 1 }) : '';
    }
    if (!identity) return;
    const index = findIndex(identity);
    // supersedes / validFrom / conflict ride on an object op; applied once every op is merged.
    const wantValidity = (item) => {
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw.supersedes !== undefined || raw.validFrom !== undefined || raw.conflict !== undefined)) {
        validity.push({ item, supersedes: raw.supersedes, validFrom: raw.validFrom, conflict: raw.conflict });
      }
    };

    if (index === -1) {
      if (!allowCreate) return;
      const item = { [identityField]: identity, weight: sure ? 1 : 0, firstSeen: seenAtIso, lastSeen: seenAtIso, recordedAt };
      if (noteField) item[noteField] = note;
      items.push(item);
      wantValidity(item);
      return;
    }

    if (!sure) return; // sure: false on an existing item changes nothing at all

    const item = items[index];
    wantValidity(item);
    if (noteField && note) item[noteField] = note;
    item.firstSeen = minIso(item.firstSeen, seenAtIso);
    item.lastSeen = maxIso(item.lastSeen, seenAtIso);
    if (!bumped.has(index)) {
      bumped.add(index);
      if (isFarEnough(seenAt, priorLastSeen[index], gapMs)) item.weight += 1;
    }
  }

  if (ops && typeof ops === 'object' && !Array.isArray(ops)) {
    for (const raw of Array.isArray(ops.add) ? ops.add : []) sight(raw, { allowCreate: true });
    for (const raw of Array.isArray(ops.update) ? ops.update : []) sight(raw, { allowCreate: true });
    for (const raw of Array.isArray(ops.seen) ? ops.seen : []) {
      if (typeof raw === 'string') sight(noteField ? { [identityField]: raw } : raw, { allowCreate: false });
    }
    for (const raw of Array.isArray(ops.remove) ? ops.remove : []) {
      if (typeof raw !== 'string') continue;
      const index = findIndex(raw);
      if (index !== -1) removed.push(...items.splice(index, 1));
    }
  }

  const closed = applyValidity(items, validity, {
    batchDay: seenAtIso.slice(0, 10),
    recordedAt,
    mintId,
    findOther: (ref) => (typeof ref === 'string' && ref.trim() ? items[findIndex(ref)] : undefined),
  });

  const { kept, dropped } = evictToCapacity(items, Number.isFinite(cap) ? cap : Infinity, halfLifeDays);

  return attachDropped(attachDropped(kept, 'dropped', [...removed, ...dropped]), 'closed', closed);
}

/**
 * Strip ONE trailing parenthetical qualifier off a topic: `Name (qualifier)`
 * -> `{ topic: 'Name', qualifier: 'qualifier' }` (both trimmed) -- fixes the
 * near-duplicate topics the analyzer tends to write (`anime` / `anime
 * (bleak/hopeless)`). Left alone (`qualifier: ''`,
 * `topic` returned as trimmed but otherwise untouched) when: the text does
 * not end in `)`; the parenthesis is unbalanced (no matching `(`); the topic
 * would be empty once stripped (the text is ONLY a parenthetical); or the
 * parenthetical itself is empty. One level of nesting inside the qualifier is
 * handled (the OUTERMOST trailing group is the one stripped).
 * @param {string} raw
 * @returns {{ topic: string, qualifier: string }}
 */
export function stripTrailingParenthetical(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed.endsWith(')')) return { topic: trimmed, qualifier: '' };

  let depth = 0;
  let openIndex = -1;
  for (let i = trimmed.length - 1; i >= 0; i -= 1) {
    const ch = trimmed[i];
    if (ch === ')') depth += 1;
    else if (ch === '(') {
      depth -= 1;
      if (depth === 0) {
        openIndex = i;
        break;
      }
    }
  }
  if (openIndex === -1) return { topic: trimmed, qualifier: '' }; // unbalanced -- leave alone

  const before = trimmed.slice(0, openIndex).trim();
  const qualifier = trimmed.slice(openIndex + 1, trimmed.length - 1).trim();
  if (!before || !qualifier) return { topic: trimmed, qualifier: '' }; // only a parenthetical, or an empty one

  return { topic: before, qualifier };
}

/** An `add`/`update` item: its `topic` gets a trailing parenthetical stripped
 * off; the qualifier itself is stashed on `_qualifier` rather than applied to
 * `note` right away -- whether it may fill the note depends on whether the
 * TARGET item (found only once `existing` has been resolved/collapsed) would
 * otherwise have no note at all, so that decision is made later by
 * `fillQualifierNotes`. Non-objects/missing `topic` pass through untouched. */
function stripParentheticalFromNotedItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.topic !== 'string') return raw;
  const { topic, qualifier } = stripTrailingParenthetical(raw.topic);
  if (!qualifier) return raw;
  return { ...raw, topic, _qualifier: qualifier };
}

/** A `seen`/`remove` plain-string topic, with a trailing parenthetical stripped off, if any. */
function stripParentheticalFromPlainTopic(raw) {
  if (typeof raw !== 'string') return raw;
  const { topic, qualifier } = stripTrailingParenthetical(raw);
  return qualifier ? topic : raw;
}

/** `ops`, with every topic in `add`/`update`/`seen`/`remove` stripped of a
 * trailing parenthetical (see `stripTrailingParenthetical`) -- so a sighting
 * of `anime (bleak/hopeless)` becomes a sighting of the plain, already-stored
 * `anime` instead of a near-duplicate. */
function stripParentheticalTopics(ops) {
  if (!ops || typeof ops !== 'object' || Array.isArray(ops)) return ops;
  return {
    ...ops,
    add: Array.isArray(ops.add) ? ops.add.map(stripParentheticalFromNotedItem) : ops.add,
    update: Array.isArray(ops.update) ? ops.update.map(stripParentheticalFromNotedItem) : ops.update,
    seen: Array.isArray(ops.seen) ? ops.seen.map(stripParentheticalFromPlainTopic) : ops.seen,
    remove: Array.isArray(ops.remove) ? ops.remove.map(stripParentheticalFromPlainTopic) : ops.remove,
  };
}

/** Every plain-form topic (already parenthetical-stripped, `normalizeTopic`'d)
 * that `ops`' add/update/seen/remove target. */
function targetTopics(ops) {
  const targets = new Set();
  const collect = (list, field) => {
    for (const raw of Array.isArray(list) ? list : []) {
      const topic = field ? raw?.[field] : raw;
      if (typeof topic === 'string' && topic.trim()) targets.add(normalizeTopic(topic));
    }
  };
  collect(ops?.add, 'topic');
  collect(ops?.update, 'topic');
  collect(ops?.seen);
  collect(ops?.remove);
  return targets;
}

/** Which of two stored items' notes survives a collapse: the heavier item's;
 * a tie in weight goes to the one with the newer `lastSeen`; either way, an
 * empty winning note falls back to the other item's note. */
function pickSurvivingNote(a, b) {
  const aWeight = a.weight ?? 0;
  const bWeight = b.weight ?? 0;
  let winner;
  if (aWeight !== bWeight) {
    winner = aWeight > bWeight ? a : b;
  } else {
    winner = (a.lastSeen ?? '') >= (b.lastSeen ?? '') ? a : b;
  }
  const loser = winner === a ? b : a;
  return winner.note || loser.note || '';
}

/** Merge two stored interest items that turned out to be the same topic
 * (a topic still carrying a trailing qualifier and its plain form): the heavier weight,
 * the earliest firstSeen, the latest lastSeen, and the note of the heavier
 * item (ties: the newer lastSeen), falling back to the other's note if that
 * one is empty -- see `pickSurvivingNote`. */
function mergeInterestItems(primary, other) {
  return {
    ...primary,
    weight: Math.max(primary.weight, other.weight),
    firstSeen: minIso(primary.firstSeen, other.firstSeen),
    lastSeen: maxIso(primary.lastSeen, other.lastSeen),
    note: pickSurvivingNote(primary, other),
  };
}

/**
 * Fold a stored topic that still carries a trailing `(qualifier)` baked into
 * its `topic` (data edited by hand, or written by a caller that did not
 * strip one) into its plain form: a stored item whose plain form is targeted
 * by an incoming op (see `targetTopics`) is rewritten to the plain form; any
 * items that now -- or already did -- share the same plain form
 * (case-insensitively) are merged into one via `mergeInterestItems`; each
 * stored item folded into an earlier one is pushed onto `merged`, as stored.
 * @param {object[]|undefined} existing
 * @param {object} strippedOps  Already run through `stripParentheticalTopics`.
 * @param {object[]} [merged]   Collects the items folded away (mutated).
 * @returns {object[]|undefined}
 */
function resolveParentheticalVariants(existing, strippedOps, merged = []) {
  if (!Array.isArray(existing) || existing.length === 0) return existing;

  const targets = targetTopics(strippedOps);
  let items = existing;
  if (targets.size > 0) {
    items = items.map((item) => {
      if (typeof item.topic !== 'string') return item;
      const { topic: plain, qualifier } = stripTrailingParenthetical(item.topic);
      return qualifier && targets.has(normalizeTopic(plain)) ? { ...item, topic: plain } : item;
    });
  }

  const order = [];
  const indexByKey = new Map();
  items.forEach((item, index) => {
    const key = normalizeTopic(item.topic);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, order.length);
      order.push(item);
    } else {
      order[existingIndex] = mergeInterestItems(order[existingIndex], item);
      merged.push(existing[index]);
    }
  });
  return order;
}

/**
 * Decide, for every `add`/`update` item carrying a stashed `_qualifier` (see
 * `stripParentheticalFromNotedItem`), whether that qualifier may fill `note`:
 * only when the item would otherwise end up with NO note at all -- a
 * non-empty incoming `note` always wins outright (the qualifier is simply
 * dropped), and an existing stored item's non-empty note is never overwritten
 * by a qualifier either (only a genuinely non-empty incoming note may replace
 * it, same as any other note). `resolvedExisting` must already be the
 * collapsed/rewritten array from `resolveParentheticalVariants`, so the
 * lookup sees the one note that will actually be sighted.
 * @param {object} strippedOps
 * @param {object[]|undefined} resolvedExisting
 * @returns {object}
 */
function fillQualifierNotes(strippedOps, resolvedExisting) {
  if (!strippedOps || typeof strippedOps !== 'object' || Array.isArray(strippedOps)) return strippedOps;
  const byTopic = new Map((Array.isArray(resolvedExisting) ? resolvedExisting : []).map((item) => [normalizeTopic(item.topic), item]));

  const fillItem = (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw._qualifier) return raw;
    const { _qualifier: qualifier, ...rest } = raw;
    if (typeof rest.note === 'string' && rest.note.trim()) return rest; // a genuine incoming note always wins
    const existingItem = byTopic.get(normalizeTopic(rest.topic));
    if (existingItem && existingItem.note) return rest; // the stored note stays untouched
    return { ...rest, note: qualifier }; // a brand new item, or one with no note yet
  };

  return {
    ...strippedOps,
    add: Array.isArray(strippedOps.add) ? strippedOps.add.map(fillItem) : strippedOps.add,
    update: Array.isArray(strippedOps.update) ? strippedOps.update.map(fillItem) : strippedOps.update,
  };
}

/**
 * Merge one analyzer batch's interest ops into a member's stored list -- see
 * `applyRankedOps` above for the full sighting/eviction rules; this is a
 * thin wrapper fixing `identityField: 'topic'`, `noteField: 'note'` and the
 * storage cap (`max(maxInterestsStored, maxInterests)`, see
 * docs/prompt-contract.md, "More is stored than shown, and rank
 * decays with age"). Before that, it strips a trailing `(qualifier)` off
 * every incoming topic (see `stripTrailingParenthetical`), resolves any
 * stored topic that still carries one (see `resolveParentheticalVariants`),
 * then decides whether the stripped qualifier may fill an item's note (see
 * `fillQualifierNotes`). The returned list's non-enumerable `dropped` holds
 * every stored item that left: folded into another by that resolution, then
 * what `applyRankedOps` reports; its non-enumerable `closed` the items a
 * `supersedes` closed (see `applyValidity`).
 * @param {object[]|undefined} existing  Stored interests.
 * @param {{ add?: unknown, update?: unknown, seen?: unknown, remove?: unknown }} ops  Untrusted, model-extracted.
 * @param {{ maxInterests?: number, maxInterestsStored?: number, topicChars?: number, noteChars?: number,
 *   confirmGapHours?: number, seenAt?: number, halfLifeDays?: number, clampTolerance?: number,
 *   mintId?: () => string, now?: number }} [opts]
 * @returns {object[]}
 */
export function applyInterestOps(
  existing,
  ops,
  { maxInterests, maxInterestsStored, topicChars, noteChars, confirmGapHours, seenAt = Date.now(), halfLifeDays, clampTolerance, mintId, now } = {},
) {
  const strippedOps = stripParentheticalTopics(ops);
  const merged = [];
  const resolvedExisting = resolveParentheticalVariants(existing, strippedOps, merged);
  const finalOps = fillQualifierNotes(strippedOps, resolvedExisting);
  const items = applyRankedOps(resolvedExisting, finalOps, {
    identityField: 'topic',
    noteField: 'note',
    identityChars: topicChars,
    noteChars,
    confirmGapHours,
    seenAt,
    halfLifeDays,
    clampTolerance,
    mintId,
    now,
    cap: effectiveStorageCap(maxInterestsStored, maxInterests),
  });
  return attachDropped(items, 'dropped', [...merged, ...items.dropped]);
}

/**
 * Validate whatever a profile's `interests` field currently holds on disk:
 * an ARRAY is checked item by item (unknown/garbage entries dropped, missing
 * fields defaulted, an optional non-empty string `itemId` and the validity fields
 * (`copyValidity`) kept, never added --
 * untrusted JSON, possibly hand-edited while paused);
 * anything that is not an array becomes `[]`.
 * @param {unknown} value
 * @returns {object[]}
 */
export function normalizeInterests(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const topic = typeof raw.topic === 'string' ? raw.topic.trim() : '';
    if (!topic) continue;
    const note = typeof raw.note === 'string' ? raw.note.trim() : '';
    const weight = Number.isInteger(raw.weight) ? raw.weight : 1;
    const firstSeen = typeof raw.firstSeen === 'string' ? raw.firstSeen : null;
    const lastSeen = typeof raw.lastSeen === 'string' ? raw.lastSeen : null;
    const item = { topic, note, weight, firstSeen, lastSeen };
    if (typeof raw.itemId === 'string' && raw.itemId) item.itemId = raw.itemId;
    copyValidity(item, raw);
    out.push(item);
  }
  return out;
}
