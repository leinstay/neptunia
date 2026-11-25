// The paging every owner read of memory shares: refusals with a stable `code`, the checks of a page limit, and a cursor
// bound to what it pages. A cursor is opaque base64url over a hash of its binding (the reader, the context, the filters, the
// snapshot) and the position to go on from, so one replayed under anything else is refused and never starts over.

import { createHash } from 'node:crypto';
import { allowedAudience, AUD_INTERNAL } from './scope.ts';
import type { Context } from './scope.ts';

/** One page of an owner read: what it holds, the moment it came from, where to go on and what it left out. */
export type Page<TItem> = {
  items: Array<TItem>;
  /** The snapshot the page read, '' for a read over a connection no snapshot holds. */
  snapshot: string;
  next: string | null;
  total: number | null;
  truncated: boolean;
  reason: 'page' | 'depth' | 'value' | null;
};

/** An Error the commands answer by its `code`; `message` names tables and columns, never a stored value. */
export const coded = (code: string, message: string): Error => Object.assign(new Error(message), { code });

/** Refuses a limit that is no positive whole number. */
export function checkLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0)
    throw coded('INSPECTION_BAD_LIMIT', 'a page limit is a positive whole number');
  return limit;
}

const hashOf = (binding: unknown): string =>
  createHash('sha256').update(JSON.stringify(binding)).digest('base64url').slice(0, 22);

/** The cursor that goes on after `position` under `binding`. */
export function cursorOf(binding: unknown, position: unknown): string {
  return Buffer.from(JSON.stringify({ b: hashOf(binding), p: position })).toString('base64url');
}

/** The position of `cursor`, null for a first page; a cursor of any other binding is refused. */
export function positionOf(cursor: string | null | undefined, binding: unknown): unknown {
  if (cursor === null || cursor === undefined) return null;
  const refused = coded('INSPECTION_BAD_CURSOR', 'that cursor does not belong to this read');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw refused;
  }
  if (parsed === null || typeof parsed !== 'object') throw refused;
  const { b, p } = parsed as { b?: unknown; p?: unknown };
  if (b !== hashOf(binding) || p === undefined || p === null) throw refused;
  return p;
}

/** What of a context a cursor is bound to. Throws without a valid context. */
export function contextBinding(context: Context): unknown {
  allowedAudience({ audience_id: AUD_INTERNAL }, context);
  const { internal, groups, kind, iface, person, place, linked } = context;
  return { internal, groups, kind, iface, person, place, linked };
}

/** The page of `rows`, read one past `limit`, keyed by `keyOf` of its last item. */
export function keysetPage<TItem>(
  rows: ReadonlyArray<TItem>,
  limit: number,
  total: number,
  binding: unknown,
  keyOf: (item: TItem) => unknown
): Page<TItem> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const next = rows.length > limit && last !== undefined ? cursorOf(binding, keyOf(last)) : null;
  return { items, snapshot: '', next, total, truncated: next !== null, reason: next === null ? null : 'page' };
}
