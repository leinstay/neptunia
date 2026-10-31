// The memory-read collector (spec 2026-10-24-memory-store, section 10): what a request carried from memory, as
// `{ kind, id }` in the memory's own identity (an item's `itemId`, a channel id, a lore entry's id, a message id).
// The block builders of src/turn/request/ fill it; no rendered text depends on it. Kinds: claim, episode, item,
// channel, guild_note, lore, recent_line, participation, source. Items without an `itemId` are not recorded.

import type { Prefetch } from './recall.ts';
import type { Fit, MemoryRead } from './types.ts';

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

/** The ids of the offered items whose texts the budget kept (`keptTexts` is a subsequence of `items`, in order). */
export function keptIdsOf(
  items: ReadonlyArray<string>,
  ids: ReadonlyArray<string | null | undefined>,
  keptTexts: ReadonlyArray<string>
): Array<string> {
  const out: Array<string> = [];
  let next = 0;
  for (let i = 0; i < items.length && next < keptTexts.length; i += 1) {
    if (items[i] !== keptTexts[next]) continue;
    next += 1;
    const id = ids[i];
    if (id !== undefined && id !== null) out.push(id);
  }
  return out;
}

/**
 * The rest of the collector, once the budget is spent: the profiles shown, the server channels, guild notes and lore
 * kept, and what the prefetch offered while `<retrieved>` was kept.
 */
// health: allow complexity until 2027-04-01 -- moved from buildRequest in src/behavior/prompt.js in stage 5d, a pure split
export function collectReads(
  memoryReads: Array<MemoryRead>,
  kept: Fit['kept'],
  given: {
    prefetch?: Prefetch | null;
    interlocutorShown: { reads: Array<MemoryRead> };
    serverOffered: Array<string>;
    serverIds: Array<string | null>;
    aboutOffered: Array<string>;
    aboutIds: Array<string | null>;
    loreOffered: Array<string>;
    loreIds: Array<string | null>;
  },
  keptPeopleEntries: Array<{ reads?: Array<MemoryRead> }>
): void {
  const { interlocutorShown, serverOffered, serverIds, aboutOffered, aboutIds, loreOffered, loreIds } = given;
  if ((kept.interlocutor ?? []).length > 0)
    memoryReads.push(...interlocutorShown.reads.map((read) => ({ ...read, block: 'people' })));
  for (const entry of keptPeopleEntries)
    memoryReads.push(...(entry.reads ?? []).map((read) => ({ ...read, block: 'people' })));
  for (const id of keptIdsOf(serverOffered, serverIds, kept.server ?? []))
    memoryReads.push({ kind: 'channel', id, block: 'server' });
  for (const id of keptIdsOf(aboutOffered, aboutIds, kept.aboutChat ?? []))
    memoryReads.push({ kind: 'guild_note', id, block: 'about_chat' });
  for (const id of keptIdsOf(loreOffered, loreIds, kept.lore ?? []))
    memoryReads.push({ kind: 'lore', id, block: 'lore' });
  if ((kept.prefetch ?? []).length > 0) {
    for (const excerpt of Array.isArray(given.prefetch?.excerpts) ? given.prefetch.excerpts : []) {
      if (typeof excerpt?.lines !== 'string' || !excerpt.lines.trim()) continue;
      if (excerpt.source === 'memory') {
        if (typeof excerpt.id === 'string' && excerpt.id)
          memoryReads.push({ kind: 'item', id: excerpt.id, block: 'retrieved' });
      } else {
        for (const id of Array.isArray(excerpt.hitIds) ? excerpt.hitIds : [])
          if (typeof id === 'string' && id) memoryReads.push({ kind: 'source', id, block: 'retrieved' });
      }
    }
  }
}
