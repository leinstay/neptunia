// The memory-read collector (spec 2026-10-24-memory-store, section 10): what a request carried from memory, as
// `{ kind, id }` in the memory's own identity (an item's `itemId`, a channel id, a lore entry's id, a message id).
// The block builders of src/turn/request/ fill it; no rendered text depends on it. Kinds: claim, episode, item,
// channel, place_note, lore, recent_line, participation, source. Items without an `itemId` are not recorded.

import type { MemoryRead } from './types.ts';

const READ_BLOCKS = ['about_chat', 'people', 'server', 'lore', 'recent', 'participation', 'retrieved'];

/**
 * Each read names the block it was rendered in (the tag of the user content) and, once the collector is done, its place
 * in the request (`ord`, following the order the blocks have in the content); the per-turn record keeps both.
 */
export function ordered(reads: Array<MemoryRead>): Array<MemoryRead & { ord: number }> {
  const rank = (read: MemoryRead) => READ_BLOCKS.indexOf(read.block ?? '');
  return [...new Map(reads.map((read) => [`${read.kind}\u0000${read.id}`, read])).values()]
    .sort((a, b) => rank(a) - rank(b))
    .map((read, ord) => ({ ...read, ord }));
}

/** Notes each of `items` that has an `itemId` as a read of `kind`; nothing without a collector. */
export function noteItems(
  reads: Array<MemoryRead> | null | undefined,
  kind: string,
  items: ReadonlyArray<{ readonly itemId?: unknown } | null | undefined>
): void {
  if (!Array.isArray(reads)) return;
  for (const item of items) if (typeof item?.itemId === 'string' && item.itemId) reads.push({ kind, id: item.itemId });
}
