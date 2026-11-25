// The recent store, pure: short dated lines about the last few days that fit no long-term kind of memory (an
// episode, lore, a self fact, a lesson) yet matter for the next days. src/memory/store.ts reads them from the place's
// recent unit and normalises them (`normalizeRecent`). A line lives `memory.recentHours` after its moment (`at`, the
// time of the message it is about): `liveRecent` is the view by time and removes nothing. A line is never promoted:
// nothing here copies or moves it into another store.
//
// Every line records the channel it comes from (`placeId`): a later view
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
// through, then the moments of members (src/memory/episodes.ts) that fall inside
// the same window, read from the profiles by reference and never copied here.
// It only ranks; the request builder renders, caps and re-orders by time. A
// stored moment has no time of its own, only its `date` (the day the model
// wrote, in the server's zone) and `addedAt` (when the analyzer stored it):
// both have to fall in the window
// (see `momentAt`).

import { isRecord, isFiniteNumber, isIntegerNumber } from './types.ts';
import { HOUR_MS } from '../time.ts';
import { oneLine } from './clamp.ts';
import { tokenIds } from './mentions.ts';
import { MEMORY_LIMITS } from './text-limits.ts';
import type { Untyped } from './types.ts';

/** The window of the view when a caller names none: `memory.recentHours` (`hours`) of config.json. */
const RECENT_DEFAULTS = Object.freeze({ hours: 72 });

/** The lightest and heaviest weight a line can carry, and the weight it gets when none (or no integer) is given. */
const MIN_WEIGHT = 1;
const MAX_WEIGHT = 3;
const DEFAULT_WEIGHT = 2;

/**
 * The recent layer's live window (`MEMORY_LIMITS.recentHours` of src/memory/text-limits.ts), the `hours` its readers
 * pass to `liveRecent`. The live config holds none of it.
 */
export const recentSettings: (config?: unknown) => { hours: number } = () => ({
  hours: MEMORY_LIMITS.recentHours,
});

/** One line of the recent store: a message-sized note of the last days, with the members its text names. */
export type RecentLine = {
  id: number;
  at: number;
  addedAt: string | null;
  placeId: string;
  text: string;
  who: Array<string>;
  weight: number;
  itemId?: string;
};

/**
 * The store of a place nothing was written to yet.
 */
export function emptyRecent(): { nextId: number; lines: Array<RecentLine> } {
  return { nextId: 1, lines: [] };
}

/**
 * `text` folded for comparison: lower case, NFD, combining marks (`\p{M}`)
 * removed, every run of whitespace one space, trimmed. Never stored. A
 * null/undefined `text` folds to ''.
 */
export function foldText(text: unknown): string {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** `raw` as a line's weight: an integer clamped to 1..3, anything else 2. */
function weightOf(raw: unknown): number {
  if (!isIntegerNumber(raw)) return DEFAULT_WEIGHT;
  return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, raw));
}

/** `raw` as a channel id: a non-empty string, trimmed; anything else null. */
function channelIdOf(raw: Untyped) {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/** The start of the window `hours` back from `now` (epoch ms): `hours` a finite number of at
 * least 0, else `RECENT_DEFAULTS.hours`; `now` a finite number, else the wall clock. */
function windowStart(now: number, hours: unknown) {
  const span = typeof hours === 'number' && isFiniteNumber(hours) && hours >= 0 ? hours : RECENT_DEFAULTS.hours;
  return now - span * HOUR_MS;
}

/** `raw` as a clock reading: a finite number, else the wall clock. */
function nowOf(raw: unknown): number {
  return isFiniteNumber(raw) ? raw : Date.now();
}

/** `raw` as a stored line id: a positive integer, or a string of digits naming one; else null. */
function lineIdOf(raw: Untyped) {
  const n = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  return isIntegerNumber(n) && n >= 1 ? n : null;
}

/**
 * A stored value (untrusted: possibly hand-edited while paused, or from an
 * older version) as the store holds it. A line that is not an object, or lacks
 * a positive integer `id`, a finite `at`, a non-empty `text` or a non-empty
 * string `placeId`, is dropped. A line whose id an earlier line already holds
 * gets a fresh id: the stored `nextId` or the one after the highest id,
 * whichever is larger, so a healed line never takes an id a gone line once held.
 * `text` is kept on one line, `weight` clamped to 1..3 (else 2), `who`
 * recomputed from the text, `addedAt` kept when it is a string, else null,
 * an optional non-empty string `itemId` kept (never added).
 * `nextId` ends above every id. Pure: `value` is never mutated, and the result
 * normalises to itself.
 */
export function normalizeRecent(value: unknown): { nextId: number; lines: Array<RecentLine> } {
  const source = isRecord(value) ? value : {};
  const valid: Array<RecentLine> = [];
  for (const raw of Array.isArray(source.lines) ? source.lines : []) {
    if (!isRecord(raw)) continue;
    const id = isIntegerNumber(raw.id) && raw.id >= 1 ? raw.id : null;
    const text = typeof raw.text === 'string' ? oneLine(raw.text) : '';
    const placeId = channelIdOf(raw.placeId);
    if (id === null || !isFiniteNumber(raw.at) || !text || placeId === null) continue;
    const line: RecentLine = {
      id,
      at: raw.at,
      addedAt: typeof raw.addedAt === 'string' ? raw.addedAt : null,
      placeId,
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

/**
 * The lines still inside the window: a moment at or after `now - hours`, in
 * stored order. Reading only: nothing is removed. `hours` falls back to `RECENT_DEFAULTS.hours`; a non-finite `now`
 * reads the wall clock.
 */
export function liveRecent(lines: unknown, { now, hours }: { now?: number; hours?: number } = {}): Array<RecentLine> {
  if (!Array.isArray(lines)) return [];
  const cutoff = windowStart(nowOf(now), hours);
  return lines.filter((line) => isRecord(line) && isFiniteNumber(line.at) && line.at >= cutoff);
}

/**
 * An id (a member's, a profile's, a channel's, a message's) as a string: a
 * finite number as its decimal form, a non-empty string as it is, anything
 * else null. The one copy for the recent view, the request builder
 * (src/behavior/prompt.js) and src/behavior/elsewhere.ts.
 */
export function accountIdOf(raw: unknown): string | null {
  if (typeof raw === 'number' && isFiniteNumber(raw)) return String(raw);
  return typeof raw === 'string' && raw !== '' ? raw : null;
}
