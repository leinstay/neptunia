// A member's remembered interests: atomic `{ topic, note, weight, firstSeen, lastSeen }` items, as a profile or a
// private layer stores them (docs/prompt-contract.md, "Interests are atomic items"), and the rules every ranked item
// (an interest, a detail, an alias) is read by. `weight` counts the separate occasions a topic was observed: an item
// counts as confirmed from `isConfirmed`, and as stale from `isStale`. `normalizeInterests` validates whatever a
// profile's `interests` field holds when src/memory/store.ts reads it.

import { HOUR_MS } from '../time.ts';
import { isFiniteNumber, isIntegerNumber } from './types.ts';
import type { Untyped } from './types.ts';

/**
 * The identity a topic is compared by: trimmed, whitespace-collapsed,
 * lowercased (case-insensitive, Unicode-aware via the JS locale-agnostic
 * `toLowerCase`, the same approach src/memory/lore.ts#normalizeTitle uses for
 * lorebook titles). Never stored -- comparison only.
 */
export function normalizeTopic(topic: Untyped): string {
  return String(topic ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** The fields the validity rules read and write on a stored claim (an interest, a detail, an alias, a real name). */
export type ValidityFields = {
  [field: string]: Untyped;
  itemId?: string;
  recordedAt?: string;
  validFrom?: string;
  validTo?: string | null;
  supersededBy?: string | null;
  conflictSetId?: string | null;
};

/** A stored ranked item (an interest, a detail, an alias): its sightings and validity, and its own fields. */
export type RankedItem = ValidityFields & {
  weight: number;
  firstSeen: string | null;
  lastSeen: string | null;
};

/** A `YYYY-MM-DD` string that is a real calendar day, else null. */
export function validDay(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return isFiniteNumber(ms) && new Date(ms).toISOString().slice(0, 10) === value ? value : null;
}

/** The validity fields a ranked item (interest, detail, alias) may carry. */
export const VALIDITY_FIELDS = Object.freeze(['recordedAt', 'validFrom', 'validTo', 'supersededBy', 'conflictSetId']);

/**
 * Copy the validity fields `raw` holds onto `item` (a normalised stored item): each one kept
 * only when present as a non-empty string or null; anything else is left out. An item that
 * never had one gets none, so an old item loads unchanged.
 * @param item  Mutated.
 * @returns `item`
 */
export function copyValidity(item: RankedItem, raw: Untyped): RankedItem {
  for (const key of VALIDITY_FIELDS) {
    if (!Object.hasOwn(raw, key)) continue;
    const value = raw[key];
    if (value === null || (typeof value === 'string' && value)) item[key] = value;
  }
  return item;
}

/** Whether a stored item is open: its `validTo` is unset (null or absent). */
export function isOpen(item: Untyped): boolean {
  return item?.validTo === undefined || item?.validTo === null;
}

/**
 * Whether a stored item (interest or detail; anything with a `weight`) counts
 * as CONFIRMED for the chat model -- see docs/prompt-contract.md,
 * "Confirmation". Below this, the chat model sees it with `labels.profile.unsureMark`.
 */
export function isConfirmed(item: { weight?: number }, confirmAfter: number = 2): boolean {
  return (item?.weight ?? 0) >= confirmAfter;
}

/**
 * Whether a stored item's `lastSeen` is old enough to render with
 * `labels.profile.staleMark` -- see docs/prompt-contract.md, "Dates
 * come from the messages". An unknown `lastSeen`, or a `staleDays` that is
 * not a positive number (feature off / not configured), is never stale.
 */
export function isStale(item: { lastSeen?: string | null }, nowMs: number, staleDays?: number): boolean {
  if (!isFiniteNumber(staleDays) || staleDays <= 0) return false;
  const lastSeen = item?.lastSeen;
  if (!lastSeen) return false;
  const lastSeenMs = Date.parse(lastSeen);
  if (!isFiniteNumber(lastSeenMs)) return false;
  return (nowMs - lastSeenMs) / (24 * HOUR_MS) > staleDays;
}

/**
 * Validate whatever a profile's `interests` field currently holds on disk:
 * an ARRAY is checked item by item (unknown/garbage entries dropped, missing
 * fields defaulted, an optional non-empty string `itemId` and the validity fields
 * (`copyValidity`) kept, never added --
 * untrusted JSON, possibly hand-edited while paused);
 * anything that is not an array becomes `[]`.
 */
export function normalizeInterests(value: unknown): Array<object> {
  if (!Array.isArray(value)) return [];
  const out: Array<Untyped> = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const topic = typeof raw.topic === 'string' ? raw.topic.trim() : '';
    if (!topic) continue;
    const note = typeof raw.note === 'string' ? raw.note.trim() : '';
    const weight = isIntegerNumber(raw.weight) ? raw.weight : 1;
    const firstSeen = typeof raw.firstSeen === 'string' ? raw.firstSeen : null;
    const lastSeen = typeof raw.lastSeen === 'string' ? raw.lastSeen : null;
    const item: RankedItem = { topic, note, weight, firstSeen, lastSeen };
    if (typeof raw.itemId === 'string' && raw.itemId) item.itemId = raw.itemId;
    copyValidity(item, raw);
    out.push(item);
  }
  return out;
}
