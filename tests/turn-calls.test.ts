import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callViewOf, searchHandles, type SearchRefs } from '../src/turn/calls.ts';
import { memorySearchText } from '../src/tools/tools.ts';
import { labels } from './fixtures/labels.ts';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const first = { sourceId: 'opaque-source-one', placeId: 'place-one', iface: 'other' };
const second = { sourceId: 'opaque-source-two', placeId: 'place-two', iface: 'foreign' };

function quote(stored: typeof first, text: string) {
  return {
    placeId: 'same-room',
    channelName: 'stored room',
    startTs: NOW,
    lines: text,
    entries: [{ id: 'same-native', text, stored, message: { id: 'same-native', content: text } }],
  };
}

function view(draft: { searchRefs?: SearchRefs }) {
  return callViewOf({
    channel: { id: 'current-room', communityId: 'g1' },
    currentIface: 'primary',
    idByIndex: new Map([[1, 'transcript-one']]),
    lines: [{ id: 'transcript-one', authorId: 'reader' }],
    searchRefs: draft.searchRefs,
  });
}

test('quoted handles retain distinct stored identities when native IDs collide across calls', () => {
  const draft: { searchRefs?: SearchRefs; handleFloor?: number } = { handleFloor: 2 };
  const refs = searchHandles(draft);
  const base = refs.next();
  memorySearchText([quote(first, 'first-evidence')], { labels, refs });
  memorySearchText([quote(second, 'second-evidence')], { labels, refs });
  const current = view(draft);
  assert.deepEqual(current.messageAt?.(base)?.stored, first);
  assert.deepEqual(current.messageAt?.(base + 1)?.stored, second);
  assert.deepEqual(draft.searchRefs?.bySourceId?.get(first.sourceId)?.message, {
    id: 'same-native',
    content: 'first-evidence',
  });
  assert.deepEqual(draft.searchRefs?.bySourceId?.get(second.sourceId)?.message, {
    id: 'same-native',
    content: 'second-evidence',
  });
});

test('registering the same stored source again preserves earlier handles and the other colliding source', () => {
  const draft: { searchRefs?: SearchRefs; handleFloor?: number } = { handleFloor: 2 };
  const refs = searchHandles(draft);
  const base = refs.next();
  memorySearchText([quote(first, 'first-evidence'), quote(second, 'second-evidence')], { labels, refs });
  memorySearchText([quote(first, 'first-evidence')], { labels, refs });
  const current = view(draft);
  assert.deepEqual(
    [current.messageAt?.(base)?.stored, current.messageAt?.(base + 1)?.stored, current.messageAt?.(base + 2)?.stored],
    [first, second, first]
  );
  assert.deepEqual([...(draft.searchRefs?.bySourceId?.keys() ?? [])].sort(), [first.sourceId, second.sourceId].sort());
});

test('a cut stored quote creates no resolvable handle while transcript numbers retain native identity', () => {
  const draft: { searchRefs?: SearchRefs; handleFloor?: number } = { handleFloor: 2 };
  const refs = searchHandles(draft);
  const base = refs.next();
  const one = quote(first, 'short');
  one.entries.push({
    id: 'same-native',
    text: 'x'.repeat(100),
    stored: second,
    message: { id: 'same-native', content: 'cut-evidence' },
  });
  memorySearchText([one], { labels, refs, windowChars: 30 });
  const current = view(draft);
  assert.deepEqual(current.messageAt?.(base)?.stored, first);
  assert.equal(current.messageAt?.(base + 1), null);
  assert.deepEqual(current.messageAt?.(1)?.native, {
    iface: 'primary',
    conversationId: 'current-room',
    messageId: 'transcript-one',
  });
});
