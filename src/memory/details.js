// Pure logic for a member's remembered "details" -- short atomic facts, each
// item `{ id, text, weight, firstSeen, lastSeen }`, incrementally updated by
// the analyzer (add/seen/remove) with the same confirmation/date mechanics as
// src/memory/interests.js#applyInterestOps -- see
// docs/prompt-contract.md, "Details are atomic items too" and
// "Confirmation (the "(?)" mechanism), same for interests and details". A
// detail's `id` is a per-profile incrementing integer (`opts.nextId` in,
// `nextId` out -- the caller, src/memory/store.js#applyProfileOps, persists
// it on the profile) that is never reused, even for a removed item.
// `normalizeDetails` validates whatever a profile's `details` field currently
// holds on disk. The same mechanics serve the guild's `learned` list (things
// people taught the persona, see src/memory/store.js#applyLearnedOps), whose
// items may also carry `from` -- the teacher's `<@id>` token.

import {
  DEFAULT_CONFIRM_GAP_HOURS,
  applyValidity,
  copyValidity,
  effectiveStorageCap,
  evictToCapacity,
  isFarEnough,
  maxIso,
  minIso,
  normalizeTopic,
} from './interests.js';
import { clampText, stripUrls } from './clamp.js';
import { HOUR_MS } from '../time.js';

function normalizedNextId(startId) {
  return Number.isInteger(startId) && startId >= 1 ? startId : 1;
}

/** An item's optional `from` (who taught it -- guild `learned` items, see
 * src/memory/store.js#applyLearnedOps): kept only as a non-empty string,
 * trimmed; anything else -> `undefined`, so the key is never stored. */
function teacherOf(from) {
  if (typeof from !== 'string') return undefined;
  const trimmed = from.trim();
  return trimmed || undefined;
}

/**
 * Merge one analyzer batch's detail ops into a member's stored list. Pure:
 * `existing` is never mutated.
 *
 * - `add` of text with no matching stored item (identity: trimmed,
 *   whitespace-collapsed, lowercased -- see `normalizeTopic`) inserts it with
 *   a fresh id, weight 1, or 0 when the op carries `sure: false`.
 * - `add` of already-known text, and `seen` (by numeric id or by exact stored
 *   text), are each a sighting: see src/memory/interests.js's header comment
 *   for the weight-bump/gap rule, identical here. `sure: false` on an
 *   EXISTING item changes nothing at all.
 * - `remove` (by id or by exact stored text) deletes the matching item.
 * - `text` is clamped to `fieldChars`; an item whose text is empty after
 *   trimming is rejected outright.
 * - An add item's optional `from` (`{ text, from, sure }`, who taught it --
 *   guild `learned` items) is stored on a NEW item when it is a non-empty
 *   string, trimmed; anything else is dropped. A sighting of an existing
 *   item never rewrites its stored `from`. Items without one keep the exact
 *   shape they always had (no `from` key at all).
 * - Once over the storage cap (`max(maxDetailsStored, maxDetails)` -- see
 *   docs/prompt-contract.md, "More is stored than shown, and rank
 *   decays with age"), the lowest-RANKED items are evicted first (see
 *   src/memory/ranking.js#rank, driven by `halfLifeDays`).
 * - `dropped` lists every stored item that left (a `remove`, then the
 *   eviction), as stored (its `itemId` included).
 * - An `add` object may carry `supersedes` (an `itemId`, else a numeric id or
 *   the exact stored text), `validFrom` (`YYYY-MM-DD`) and `conflict` (same
 *   references) -- see src/memory/interests.js#applyValidity; `closed` lists the
 *   items a `supersedes` closed, never in `dropped`. `mintId` gives a writing
 *   item its `itemId` when it needs one. A new item gets `recordedAt`, the ISO
 *   time of `now` (else `seenAt`).
 *
 * @param {object[]|undefined} existing  Stored details.
 * @param {{ add?: unknown, seen?: unknown, remove?: unknown }} ops  Untrusted, model-extracted.
 * @param {{ maxDetails?: number, maxDetailsStored?: number, fieldChars?: number, confirmGapHours?: number,
 *   seenAt?: number, nextId?: number, halfLifeDays?: number, clampTolerance?: number,
 *   mintId?: () => string, now?: number, validity?: boolean }} [opts]
 *   `validity: false` (the guild's lessons) stamps no `recordedAt` and ignores the validity fields.
 *   `text` is free prose: its links go (src/memory/clamp.js#stripUrls), then it is clamped
 *   tolerantly (see src/memory/clamp.js) with `clampTolerance`; a text left empty adds nothing.
 * @returns {{ items: object[], nextId: number, dropped: object[], closed: object[] }}
 */
export function applyDetailOps(
  existing,
  ops,
  { maxDetails, maxDetailsStored, fieldChars, confirmGapHours, seenAt = Date.now(), nextId, halfLifeDays, clampTolerance, mintId, now, validity: withValidity = true } = {},
) {
  const items = Array.isArray(existing) ? existing.map((item) => ({ ...item })) : [];
  const removed = [];
  const validity = [];
  const priorLastSeen = items.map((item) => item.lastSeen ?? null);
  const seenAtIso = new Date(seenAt).toISOString();
  const recordedAt = new Date(Number.isFinite(now) ? now : seenAt).toISOString();
  const gapMs = (Number.isFinite(confirmGapHours) ? confirmGapHours : DEFAULT_CONFIRM_GAP_HOURS) * HOUR_MS;
  const bumped = new Set();
  let id = normalizedNextId(nextId);

  function findIndex(identifier) {
    if (typeof identifier === 'number') return items.findIndex((item) => item.id === identifier);
    if (typeof identifier === 'string') {
      const norm = normalizeTopic(identifier);
      return items.findIndex((item) => normalizeTopic(item.text) === norm);
    }
    return -1;
  }

  function sightExisting(index) {
    const item = items[index];
    item.firstSeen = minIso(item.firstSeen, seenAtIso);
    item.lastSeen = maxIso(item.lastSeen, seenAtIso);
    if (!bumped.has(index)) {
      bumped.add(index);
      if (isFarEnough(seenAt, priorLastSeen[index], gapMs)) item.weight += 1;
    }
  }

  function add(raw) {
    const isObj = raw && typeof raw === 'object' && !Array.isArray(raw);
    if (!isObj && typeof raw !== 'string') return;
    const value = isObj ? raw.text : raw;
    const text = clampText(typeof value === 'string' ? stripUrls(value) : value, fieldChars, { tolerance: clampTolerance });
    if (!text) return;
    const sure = isObj ? raw.sure !== false : true;
    const from = isObj ? teacherOf(raw.from) : undefined;
    const index = findIndex(text);
    // supersedes / validFrom / conflict ride on an object op; applied once every op is merged.
    const wantValidity = (item) => {
      if (withValidity && isObj && (raw.supersedes !== undefined || raw.validFrom !== undefined || raw.conflict !== undefined)) {
        validity.push({ item, supersedes: raw.supersedes, validFrom: raw.validFrom, conflict: raw.conflict });
      }
    };
    if (index === -1) {
      const item = { id, text, weight: sure ? 1 : 0, firstSeen: seenAtIso, lastSeen: seenAtIso };
      if (withValidity) item.recordedAt = recordedAt;
      if (from) item.from = from;
      items.push(item);
      wantValidity(item);
      id += 1;
      return;
    }
    if (!sure) return; // sure: false on an existing item changes nothing at all
    sightExisting(index);
    wantValidity(items[index]);
  }

  function seen(raw) {
    if (typeof raw !== 'number' && typeof raw !== 'string') return;
    const index = findIndex(raw);
    if (index === -1) return;
    sightExisting(index);
  }

  function remove(raw) {
    if (typeof raw !== 'number' && typeof raw !== 'string') return;
    const index = findIndex(raw);
    if (index !== -1) removed.push(...items.splice(index, 1));
  }

  if (ops && typeof ops === 'object' && !Array.isArray(ops)) {
    for (const raw of Array.isArray(ops.add) ? ops.add : []) add(raw);
    for (const raw of Array.isArray(ops.seen) ? ops.seen : []) seen(raw);
    for (const raw of Array.isArray(ops.remove) ? ops.remove : []) remove(raw);
  }

  const closed = applyValidity(items, validity, {
    batchDay: seenAtIso.slice(0, 10),
    recordedAt,
    mintId,
    findOther: (ref) => (typeof ref === 'number' || (typeof ref === 'string' && ref.trim()) ? items[findIndex(ref)] : undefined),
  });

  const cap = effectiveStorageCap(maxDetailsStored, maxDetails);
  const { kept, dropped } = evictToCapacity(items, cap, halfLifeDays);

  return { items: kept, nextId: id, dropped: [...removed, ...dropped], closed };
}

/**
 * Validate whatever a profile's `details` field currently holds on disk: an
 * ARRAY is checked item by item (untrusted JSON, possibly hand-edited while
 * paused) -- a valid integer `id` is kept, otherwise one is assigned fresh
 * off `startId` so the sequence never collides; an optional `from` survives
 * only as a non-empty string (see `applyDetailOps`), an optional `itemId`
 * likewise (kept, never added), and the validity fields
 * (src/memory/interests.js#copyValidity); anything else ->
 * `{ items: [], nextId: startId }`. Never throws on garbage.
 * @param {unknown} value
 * @param {number} [startId]
 * @returns {{ items: object[], nextId: number }}
 */
export function normalizeDetails(value, startId = 1) {
  let id = normalizedNextId(startId);
  const items = [];
  if (Array.isArray(value)) {
    for (const raw of value) {
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.text === 'string') {
        const text = raw.text.trim();
        if (!text) continue;
        const weight = Number.isInteger(raw.weight) ? raw.weight : 1;
        const firstSeen = typeof raw.firstSeen === 'string' ? raw.firstSeen : null;
        const lastSeen = typeof raw.lastSeen === 'string' ? raw.lastSeen : null;
        const itemId = Number.isInteger(raw.id) && raw.id >= 1 ? raw.id : id;
        if (itemId >= id) id = itemId + 1;
        const item = { id: itemId, text, weight, firstSeen, lastSeen };
        const from = teacherOf(raw.from);
        if (from) item.from = from;
        if (typeof raw.itemId === 'string' && raw.itemId) item.itemId = raw.itemId;
        copyValidity(item, raw);
        items.push(item);
      }
    }
  }
  return { items, nextId: id };
}
