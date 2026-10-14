// The recent store, pure: short dated lines about the last few days that fit
// no long-term kind of memory (an episode, lore, a self fact, a lesson) yet
// matter for the next days. The analyzer writes them (src/memory/update.js);
// src/memory/store.js keeps them in data/guilds/<id>/recent.json and runs every
// write through `mergeRecent`. The clock is passed in (`now`); only a missing
// one falls back to the wall clock.
//
// One number rules a line's life (the lead's ruling: no separate, longer
// retention): it lives `memory.recentHours` after its moment (`at`, the time of
// the message it is about) and is dropped at the next write past that, never on
// read. So a hot LOWERING of `memory.recentHours` narrows the view at once and,
// at the next write (the analyzer's next batch), deletes every line older than
// the new number; raising it again brings none of them back. Besides expiry a
// line leaves only through the storage cap (`memory.maxRecentStored`: when a
// write adds lines, the lightest, then the oldest go), an explicit remove of its
// id (the analyzer takes back a line that is wrong), a forget of a member it
// names (`purgeRecentFor`) or a wipe of the guild (src/memory/store.js). A line
// is never promoted: nothing here copies or moves it into another store.
//
// Every line records the channel it comes from (`channelId`): a later view
// shows a line only where that channel's audience allows it, so a line without
// one is never stored (counted `noChannel`). `who` (the member ids its `<@id>`
// tokens name) is computed from the text here, never taken from the model.
//
// `foldText` is the project's one diacritic fold (lower case, NFD, combining
// marks removed, whitespace collapsed): the duplicate test here, and any later
// text matching that must ignore accents, use this copy. Besides accents it
// folds letters that NFD splits into a base letter and a mark, e.g. U+0451
// into U+0435 and U+0439 into U+0438: harmless for duplicates, but it widens a
// whole-word match.
//
// `recentView` is the view by time a turn shows as `<recent>` (built by
// src/behavior/prompt.js): the live lines a caller's audience predicate lets
// through, then the moments of members (src/memory/episodes.js) that fall inside
// the same window, read from the profiles by reference and never copied here.
// It only ranks; the request builder renders, caps and re-orders by time. A
// stored moment has no time of its own, only its `date` (the day the model
// wrote, in the server's zone) and `addedAt` (when the analyzer stored it, or
// the last sampled message for the warmup): both have to fall in the window
// (see `momentAt`).

import { isPlainObject } from '../config.js';
import { DAY_MS, HOUR_MS } from '../time.js';
import { clampText, oneLine, stripUrls } from './clamp.js';
import { topEpisodes } from './episodes.js';
import { isWordChar, occursAsWholeWord, tokenIds } from './mentions.js';

/**
 * config.json's own values for the recent layer's settings, the code fallbacks
 * when a deployment's config lacks a key: `memory.recentHours` (`hours`),
 * `memory.maxRecentStored` (`maxStored`), `memory.maxNewRecent` (`maxNew`),
 * `memory.recentChars` (`chars`) and `memory.recentShown` (`shown`, the live
 * lines the analyzer is shown).
 */
export const RECENT_DEFAULTS = Object.freeze({ hours: 72, maxStored: 150, maxNew: 3, chars: 160, shown: 12 });

/** The lightest and heaviest weight a line can carry, and the weight it gets when none (or no integer) is given. */
const MIN_WEIGHT = 1;
const MAX_WEIGHT = 3;
const DEFAULT_WEIGHT = 2;

/** The fewest letters and digits a member name (once folded) needs for a purge to match it as a
 * word: symbols and underscores do not count, so a name like `-_-` matches nothing. */
const MIN_PURGE_NAME = 3;

/**
 * The most moments of one member the view offers (the lead's ruling: at most two
 * per member), unless a caller passes `perMember` to `recentView`.
 */
export const RECENT_EPISODES_PER_MEMBER = 2;

/** A stored episode date: `YYYY-MM-DD` (src/memory/episodes.js keeps no other form). */
const EPISODE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** How far ahead of UTC a time zone can be: a date the model wrote in the server's zone can be
 * "today" there while its UTC day has not begun yet. */
const MAX_ZONE_AHEAD_MS = 14 * HOUR_MS;

/**
 * The recent layer's settings, read from `config` at the moment of use: null when
 * `features.recent` is false (a missing key counts as on), else the numbers with
 * `RECENT_DEFAULTS` as fallbacks, plus `memory.clampTolerance` (undefined when
 * missing: src/memory/clamp.js then uses its own default). The result can be
 * spread into the options of `mergeRecent` / src/memory/store.js#applyRecentOps.
 * @param {object} config
 * @returns {{ hours: number, maxStored: number, maxNew: number, chars: number, shown: number,
 *   clampTolerance: number|undefined } | null}
 */
export function recentSettings(config) {
  if (config?.features?.recent === false) return null;
  const memory = isPlainObject(config?.memory) ? config.memory : {};
  return {
    hours: memory.recentHours ?? RECENT_DEFAULTS.hours,
    maxStored: memory.maxRecentStored ?? RECENT_DEFAULTS.maxStored,
    maxNew: memory.maxNewRecent ?? RECENT_DEFAULTS.maxNew,
    chars: memory.recentChars ?? RECENT_DEFAULTS.chars,
    shown: memory.recentShown ?? RECENT_DEFAULTS.shown,
    clampTolerance: memory.clampTolerance,
  };
}

/**
 * The store of a guild nothing was written to yet.
 * @returns {{ nextId: number, lines: object[] }}
 */
export function emptyRecent() {
  return { nextId: 1, lines: [] };
}

/**
 * `text` folded for comparison: lower case, NFD, combining marks (`\p{M}`)
 * removed, every run of whitespace one space, trimmed. Never stored. A
 * null/undefined `text` folds to ''.
 * @param {unknown} text
 * @returns {string}
 */
export function foldText(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** `raw` as a line's weight: an integer clamped to 1..3, anything else 2. */
function weightOf(raw) {
  if (!Number.isInteger(raw)) return DEFAULT_WEIGHT;
  return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, raw));
}

/** `raw` as a channel id: a non-empty string, trimmed; anything else null. */
function channelIdOf(raw) {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/** A finite number of at least 0, floored, or `fallback`. */
function countOr(raw, fallback) {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

/** The start of the window `hours` back from `now` (epoch ms): `hours` a finite number of at
 * least 0, else `RECENT_DEFAULTS.hours`; `now` a finite number, else the wall clock. */
function windowStart(now, hours) {
  const span = typeof hours === 'number' && Number.isFinite(hours) && hours >= 0 ? hours : RECENT_DEFAULTS.hours;
  return now - span * HOUR_MS;
}

/** `raw` as a clock reading: a finite number, else the wall clock. */
function nowOf(raw) {
  return Number.isFinite(raw) ? raw : Date.now();
}

/** `raw` as a stored line id: a positive integer, or a string of digits naming one; else null. */
function lineIdOf(raw) {
  const n = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * A stored value (untrusted: possibly hand-edited while paused, or from an
 * older version) as the store holds it. A line that is not an object, or lacks
 * a positive integer `id`, a finite `at`, a non-empty `text` or a non-empty
 * string `channelId`, is dropped. A line whose id an earlier line already holds
 * gets a fresh id: the stored `nextId` or the one after the highest id,
 * whichever is larger, so a healed line never takes an id a gone line once held.
 * `text` is kept on one line, `weight` clamped (see `mergeRecent`), `who`
 * recomputed from the text, `addedAt` kept when it is a string, else null,
 * an optional non-empty string `itemId` kept (never added).
 * `nextId` ends above every id. Pure: `value` is never mutated, and the result
 * normalises to itself.
 * @param {unknown} value
 * @returns {{ nextId: number, lines: object[] }}
 */
export function normalizeRecent(value) {
  const source = isPlainObject(value) ? value : {};
  const valid = [];
  for (const raw of Array.isArray(source.lines) ? source.lines : []) {
    if (!isPlainObject(raw)) continue;
    const id = Number.isInteger(raw.id) && raw.id >= 1 ? raw.id : null;
    const text = typeof raw.text === 'string' ? oneLine(raw.text) : '';
    const channelId = channelIdOf(raw.channelId);
    if (id === null || !Number.isFinite(raw.at) || !text || channelId === null) continue;
    const line = {
      id,
      at: raw.at,
      addedAt: typeof raw.addedAt === 'string' ? raw.addedAt : null,
      channelId,
      text,
      who: tokenIds(text),
      weight: weightOf(raw.weight),
    };
    if (typeof raw.itemId === 'string' && raw.itemId) line.itemId = raw.itemId;
    valid.push(line);
  }
  const storedNext = lineIdOf(source.nextId) ?? 1;
  let lastId = Math.max(storedNext - 1, ...valid.map((line) => line.id));
  const seen = new Set();
  const lines = valid.map((line) => {
    if (!seen.has(line.id)) {
      seen.add(line.id);
      return line;
    }
    lastId += 1;
    seen.add(lastId);
    return { ...line, id: lastId };
  });
  return { nextId: lastId + 1, lines };
}

/** Ascending sort key for eviction: the lightest first, then the oldest moment, then the lowest id. */
function evictionOrder(a, b) {
  return a.weight - b.weight || a.at - b.at || a.id - b.id;
}

/**
 * One write of the recent store: expiry, the analyzer's removes, then its new
 * lines. Pure: `stored` is never mutated. The steps, in order:
 *   1. lines whose moment is older than `now - hours` are dropped (`expired`);
 *   2. the stored lines whose ids `removeIds` lists are dropped (`removed`; an id
 *      not stored, or given to a line by this same call, removes nothing);
 *   3. each incoming item `{ text, at, channelId, weight }` is sanitized:
 *      `text` without its links (src/memory/clamp.js#stripUrls), kept on one line and cut to `chars` at a clean boundary
 *      (src/memory/clamp.js#clampText with `clampTolerance`), `weight` an integer
 *      clamped to 1..3 (else 2), `at` a finite number (else `now`). An item that
 *      is not an object or whose text comes out empty is dropped (`invalid`),
 *      then one that names no channel (`noChannel`), then one whose moment is
 *      already past the window (`stale`). Anything else the item carries (`who`,
 *      `id`, `addedAt`) is ignored;
 *   4. an item whose folded text (`foldText`) equals a remaining stored line's
 *      or an earlier kept item's is dropped (`duplicate`);
 *   5. the first `maxNew` items are kept, the rest dropped (`overCap`);
 *   6. when items are kept and the store would hold more than `maxStored`, the
 *      lightest, then the oldest moment, then the lowest id go, a kept item
 *      ranking after every stored line of the same weight and moment: a stored
 *      line that goes counts in `evicted`, a kept item that goes at once is not
 *      added and counts in `overCap`. The rest keep their order. A cap lowered
 *      while nothing is kept cuts nothing;
 *   7. each item still kept gets the next id, `addedAt` (the ISO time of `now`)
 *      and `who` (src/memory/mentions.js#tokenIds of its text), appended in
 *      order (`added`). An id is never used up by an item that is not added.
 * Missing options fall back to `RECENT_DEFAULTS` (config.json's values); a
 * non-finite `now` reads the wall clock.
 * @param {unknown} stored     The store's value (normalised first, see `normalizeRecent`).
 * @param {unknown} incoming   New items; anything but an array adds nothing.
 * @param {{ now?: number, hours?: number, maxStored?: number, maxNew?: number, chars?: number,
 *   clampTolerance?: number, removeIds?: unknown[] }} [opts]
 * @returns {{ value: { nextId: number, lines: object[] }, added: number, removed: number,
 *   expired: number, evicted: number, dropped: number, invalid: number, noChannel: number,
 *   stale: number, duplicate: number, overCap: number, droppedLines: object[] }}  `added`, `removed`, `expired` and
 *   `evicted` count stored lines (the store holds `before - expired - removed - evicted + added`);
 *   `dropped` counts the incoming items not added, the sum of `invalid`, `noChannel`, `stale`,
 *   `duplicate` and `overCap`. `droppedLines`: the stored lines that left, as normalised (their
 *   `itemId` included) -- the expired, then the removed, then the evicted, each in stored order.
 */
export function mergeRecent(stored, incoming, opts = {}) {
  const options = isPlainObject(opts) ? opts : {};
  const now = nowOf(options.now);
  const cutoff = windowStart(now, options.hours);
  const maxStored = countOr(options.maxStored, RECENT_DEFAULTS.maxStored);
  const maxNew = countOr(options.maxNew, RECENT_DEFAULTS.maxNew);
  const chars = options.chars ?? RECENT_DEFAULTS.chars;

  const base = normalizeRecent(stored);
  const live = base.lines.filter((line) => line.at >= cutoff);
  const expired = base.lines.length - live.length;
  const expiredLines = base.lines.filter((line) => line.at < cutoff);

  const removing = new Set((Array.isArray(options.removeIds) ? options.removeIds : []).map(lineIdOf).filter((id) => id !== null));
  const kept = live.filter((line) => !removing.has(line.id));
  const removed = live.length - kept.length;
  const removedLines = live.filter((line) => removing.has(line.id));

  const items = Array.isArray(incoming) ? incoming : [];
  const held = new Set(kept.map((line) => foldText(line.text)));
  const fresh = [];
  const why = { invalid: 0, noChannel: 0, stale: 0, duplicate: 0, overCap: 0 };
  for (const raw of items) {
    const text = isPlainObject(raw) && typeof raw.text === 'string' ? clampText(oneLine(stripUrls(raw.text)), chars, { tolerance: options.clampTolerance }) : '';
    const channelId = isPlainObject(raw) ? channelIdOf(raw.channelId) : null;
    const at = isPlainObject(raw) && Number.isFinite(raw.at) ? raw.at : now;
    const key = foldText(text);
    const reason = !text
      ? 'invalid'
      : channelId === null
        ? 'noChannel'
        : at < cutoff
          ? 'stale'
          : held.has(key)
            ? 'duplicate'
            : fresh.length >= maxNew
              ? 'overCap'
              : null;
    if (reason) {
      why[reason] += 1;
      continue;
    }
    held.add(key);
    fresh.push({ at, channelId, text, weight: weightOf(raw.weight) });
  }

  // The storage cap ranks a kept item by a provisional id from `base.nextId` on, above every stored
  // id (normalizeRecent); only the items it leaves get their real ids, so one it takes at once uses
  // none up.
  let survivors = [...kept, ...fresh.map((item, i) => ({ ...item, id: base.nextId + i }))];
  let evicted = 0;
  let evictedLines = [];
  if (fresh.length > 0 && survivors.length > maxStored) {
    const going = new Set([...survivors].sort(evictionOrder).slice(0, survivors.length - maxStored).map((line) => line.id));
    evictedLines = kept.filter((line) => going.has(line.id));
    evicted = evictedLines.length;
    why.overCap += going.size - evicted;
    survivors = survivors.filter((line) => !going.has(line.id));
  }

  let nextId = base.nextId;
  let added = 0;
  const addedAt = new Date(now).toISOString();
  const lines = survivors.map((line) => {
    if (line.id < base.nextId) return line; // a stored line
    const id = nextId;
    nextId += 1;
    added += 1;
    return { id, at: line.at, addedAt, channelId: line.channelId, text: line.text, who: tokenIds(line.text), weight: line.weight };
  });

  const dropped = why.invalid + why.noChannel + why.stale + why.duplicate + why.overCap;
  const droppedLines = [...expiredLines, ...removedLines, ...evictedLines];
  return { value: { nextId, lines }, added, removed, expired, evicted, dropped, ...why, droppedLines };
}

/**
 * The lines still inside the window: a moment at or after `now - hours`, in
 * stored order. Reading only -- nothing is removed (expiry is `mergeRecent`'s,
 * at a write). `hours` falls back to `RECENT_DEFAULTS.hours`; a non-finite `now`
 * reads the wall clock.
 * @param {unknown} lines
 * @param {{ now: number, hours?: number }} opts
 * @returns {object[]}
 */
export function liveRecent(lines, { now, hours } = {}) {
  if (!Array.isArray(lines)) return [];
  const cutoff = windowStart(nowOf(now), hours);
  return lines.filter((line) => isPlainObject(line) && Number.isFinite(line.at) && line.at >= cutoff);
}

/**
 * The store without the lines about one member, for a forget: a line goes when
 * its `who` holds `userId`, its text holds the token `<@userId>` (the one case
 * `who` misses: an id outside the snowflake range forms no token), or its
 * folded text holds one of `names` (the member's stored names and aliases,
 * folded, each with at least 3 letters or digits: a name of symbols alone
 * would match symbol runs in anyone's line) as a whole word
 * (src/memory/mentions.js#occursAsWholeWord). Pure: `stored` is never mutated;
 * `nextId` is kept.
 * @param {unknown} stored
 * @param {string} userId
 * @param {unknown[]} [names]
 * @returns {{ value: { nextId: number, lines: object[] }, removed: number }}
 */
export function purgeRecentFor(stored, userId, names = []) {
  const base = normalizeRecent(stored);
  const id = String(userId);
  const token = `<@${id}>`;
  const folded = [
    ...new Set((Array.isArray(names) ? names : []).filter((name) => typeof name === 'string').map(foldText)),
  ].filter((name) => [...name].filter((ch) => isWordChar(ch) && ch !== '_').length >= MIN_PURGE_NAME);
  const lines = base.lines.filter((line) => {
    if (line.who.includes(id) || line.text.includes(token)) return false;
    const text = foldText(line.text);
    return !folded.some((name) => occursAsWholeWord(text, name));
  });
  return { value: { nextId: base.nextId, lines }, removed: base.lines.length - lines.length };
}

/**
 * The key of one remembered moment of a member: `profileId|date|what`, the
 * fields src/memory/episodes.js treats as its identity. A caller that already
 * shows some moments elsewhere in a request passes their keys to `recentView`
 * so it never repeats them.
 * @param {string|number} profileId
 * @param {{ date?: string, what?: string }} ep
 * @returns {string}
 */
export function episodeKey(profileId, ep) {
  return `${profileId}|${ep?.date}|${ep?.what}`;
}

/**
 * Where a stored moment sits in the window that starts at `cutoff` and ends at
 * `clock`: noon UTC of its `date`, a key for ordering by time only (the request
 * builder renders the date from the stored `date` itself, never from this
 * time), or null when it is outside. A moment is inside when
 *   - its `date` is a `YYYY-MM-DD` whose day (UTC) ends at or after `cutoff`:
 *     a date counts until the end of its day (a date the model wrote in the
 *     server's zone may thus count a few hours longer or shorter than that local
 *     day), and does not begin later than `clock` plus the widest zone offset (a
 *     date still ahead of every zone's today is a mistake, not a moment); and
 *   - its `addedAt`, when it is a time that parses, lies between `cutoff` and
 *     `clock`. Every moment stored by src/memory/episodes.js#mergeEpisodes
 *     carries one: the analyzer's clock at the batch, a little after the
 *     moment, so a moment leaves the window by its time, not by its calendar
 *     day. The date still has to qualify: the warmup stamps old moments with a
 *     recent `addedAt` (the member's last sampled message).
 * A moment without a parsable `addedAt` (written before the field existed, or by
 * hand) is judged by its date alone.
 */
function momentAt(ep, cutoff, clock) {
  if (typeof ep.date !== 'string' || !EPISODE_DATE_RE.test(ep.date)) return null;
  const dayStart = Date.parse(`${ep.date}T00:00:00.000Z`);
  if (!Number.isFinite(dayStart)) return null;
  if (dayStart + DAY_MS - 1 < cutoff || dayStart > clock + MAX_ZONE_AHEAD_MS) return null;
  const stored = typeof ep.addedAt === 'string' ? Date.parse(ep.addedAt) : NaN;
  if (Number.isFinite(stored) && (stored < cutoff || stored > clock)) return null;
  return dayStart + DAY_MS / 2;
}

/**
 * An id (a member's, a profile's, a channel's, a message's) as a string: a
 * finite number as its decimal form, a non-empty string as it is, anything
 * else null. The one copy for the recent view, the request builder
 * (src/behavior/prompt.js) and src/behavior/elsewhere.js (which cannot be its
 * home: it imports src/memory/update.js, which imports this module).
 * @param {unknown} raw
 * @returns {string|null}
 */
export function memberIdOf(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/**
 * The view of the last `hours` before `now` -- what a turn's `<recent>` block
 * may show -- in the order a capped block should take it (the lead's ruling):
 *   1. the live lines (`liveRecent`) whose source channel `isShown` accepts,
 *      the ones about a focus member first (their `who`, or the tokens of
 *      their text, holds an id of `focusIds`), each group heavier, then newer,
 *      then the higher id;
 *   2. then the moments of the members of `profiles` inside the window, at
 *      most `perMember` per member (the heaviest, then newest of theirs, as
 *      src/memory/episodes.js#topEpisodes orders them), the focus members'
 *      first, each group heavier, then newer.
 * Every line comes before every moment, so a capped block that takes the items
 * in this order never trades a line for a moment. Which moments are inside the
 * window: see `momentAt` (by the time it was stored and by its date). A moment
 * whose key (`episodeKey`) is in `excludeEpisodeKeys` -- one the request already
 * shows elsewhere -- is left out (`repeated`); so is a line `isShown` refuses
 * (`hidden`). Without `isShown` no line is shown: the audience is the caller's
 * to give. `perMember` is a whole number of at least 0 (0: no moment), anything
 * else `RECENT_EPISODES_PER_MEMBER`. A profile, line or moment that is
 * malformed is passed over. Pure: nothing is mutated, and every item points at
 * the stored line or moment itself.
 * @param {{ lines?: unknown, profiles?: unknown, now?: number, hours?: number,
 *   focusIds?: Iterable<string>, excludeEpisodeKeys?: Set<string>,
 *   isShown?: (channelId: string|null) => boolean, perMember?: number }} [args]
 * @returns {{ items: Array<{ kind: 'line', at: number, focus: boolean, line: object }
 *   | { kind: 'episode', at: number, focus: boolean, profileId: string, name: string|null, episode: object }>,
 *   hidden: number, repeated: number }}  `at`: a line's moment, a moment's noon UTC of its date
 *   (for ordering; a moment's shown date is its stored `date`); `name`: the profile's current
 *   stored name, null when it has none.
 */
export function recentView({ lines, profiles, now, hours, focusIds, excludeEpisodeKeys, isShown, perMember } = {}) {
  const clock = nowOf(now);
  const cutoff = windowStart(clock, hours);
  const focus = new Set([...(focusIds ?? [])].map(memberIdOf).filter(Boolean));
  const excluded = excludeEpisodeKeys instanceof Set ? excludeEpisodeKeys : new Set();
  const shows = typeof isShown === 'function' ? isShown : () => false;
  const most = Number.isInteger(perMember) && perMember >= 0 ? perMember : RECENT_EPISODES_PER_MEMBER;

  let hidden = 0;
  const shownLines = [];
  for (const line of liveRecent(lines, { now: clock, hours })) {
    if (typeof line.text !== 'string' || !line.text) continue;
    if (!shows(line.channelId ?? null)) {
      hidden += 1;
      continue;
    }
    const who = Array.isArray(line.who) ? line.who : tokenIds(line.text);
    shownLines.push({ kind: 'line', at: line.at, focus: who.some((id) => focus.has(String(id))), line });
  }
  shownLines.sort(
    (a, b) =>
      Number(b.focus) - Number(a.focus) ||
      weightOf(b.line.weight) - weightOf(a.line.weight) ||
      b.at - a.at ||
      (Number(b.line.id) || 0) - (Number(a.line.id) || 0),
  );

  let repeated = 0;
  const moments = [];
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    if (!isPlainObject(profile)) continue;
    const profileId = memberIdOf(profile.id);
    if (profileId === null) continue;
    const inWindow = [];
    const atOf = new Map();
    for (const ep of Array.isArray(profile.episodes) ? profile.episodes : []) {
      if (!isPlainObject(ep) || typeof ep.what !== 'string' || !ep.what.trim()) continue;
      const at = momentAt(ep, cutoff, clock);
      if (at === null) continue;
      if (excluded.has(episodeKey(profileId, ep))) {
        repeated += 1;
        continue;
      }
      inWindow.push(ep);
      atOf.set(ep, at);
    }
    const name = typeof profile.names?.[0] === 'string' && profile.names[0] ? profile.names[0] : null;
    const focused = focus.has(profileId);
    for (const episode of topEpisodes(inWindow, most)) {
      moments.push({ kind: 'episode', at: atOf.get(episode), focus: focused, profileId, name, episode });
    }
  }
  moments.sort(
    (a, b) =>
      Number(b.focus) - Number(a.focus) ||
      (Number(b.episode.weight) || 0) - (Number(a.episode.weight) || 0) ||
      b.at - a.at ||
      String(b.episode.addedAt ?? '').localeCompare(String(a.episode.addedAt ?? '')),
  );

  return { items: [...shownLines, ...moments], hidden, repeated };
}
