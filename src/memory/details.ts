// A member's remembered "details": short atomic facts, each item `{ id, text, weight, firstSeen, lastSeen }`, as a
// profile or a private layer stores them (docs/prompt-contract.md, "Details are atomic items too"). A detail's `id` is
// a per-profile integer that is never reused, even for a removed item. `normalizeDetails` validates whatever a
// profile's `details` field holds when src/memory/store.ts reads it. The same validation serves the place's `learned`
// list (things people taught the persona), whose items may also carry `from`, the teacher's `<@id>` token.

import { copyValidity } from './interests.ts';
import { isIntegerNumber } from './types.ts';
import type { RankedItem } from './interests.ts';
import type { Untyped } from './types.ts';

function normalizedNextId(startId: Untyped) {
  return isIntegerNumber(startId) && startId >= 1 ? startId : 1;
}

/** An item's optional `from` (who taught it -- place `learned` items): kept only as a non-empty string,
 * trimmed; anything else -> `undefined`, so the key is never stored. */
function teacherOf(from: Untyped) {
  if (typeof from !== 'string') return undefined;
  const trimmed = from.trim();
  return trimmed || undefined;
}

/**
 * Validate whatever a profile's `details` field currently holds on disk: an
 * ARRAY is checked item by item (untrusted JSON, possibly hand-edited while
 * paused) -- a valid integer `id` is kept, otherwise one is assigned fresh
 * off `startId` so the sequence never collides; an optional `from` survives
 * only as a non-empty string, trimmed, an optional `itemId`
 * likewise (kept, never added), and the validity fields
 * (src/memory/interests.ts#copyValidity); anything else ->
 * `{ items: [], nextId: startId }`. Never throws on garbage.
 */
export function normalizeDetails(value: unknown, startId: number = 1): { items: Array<object>; nextId: number } {
  let id = normalizedNextId(startId);
  const items = [];
  if (Array.isArray(value)) {
    for (const raw of value) {
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.text === 'string') {
        const text = raw.text.trim();
        if (!text) continue;
        const weight = isIntegerNumber(raw.weight) ? raw.weight : 1;
        const firstSeen = typeof raw.firstSeen === 'string' ? raw.firstSeen : null;
        const lastSeen = typeof raw.lastSeen === 'string' ? raw.lastSeen : null;
        const itemId = isIntegerNumber(raw.id) && raw.id >= 1 ? raw.id : id;
        if (itemId >= id) id = itemId + 1;
        const item: RankedItem = { id: itemId, text, weight, firstSeen, lastSeen };
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
