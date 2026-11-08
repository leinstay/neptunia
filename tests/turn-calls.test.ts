import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/tools/operations/index.ts';
import { CHANNEL_HANDLE_PREFIX, HANDLE_DIGITS, handleOf } from '../src/behavior/handles.ts';
import { resolveCall } from '../src/tools/executors.ts';
import { skillRegistry } from '../src/tools/registry.ts';
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
    channel: { id: 'current-room', rootId: 'g1' },
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
    chatId: 'current-room',
    messageId: 'transcript-one',
  });
});

test('a #handle and an @handle she carries from an earlier request resolve in a call when the place and member are known', () => {
  // Bug: a handle of a channel or member this request did not show was refused as unknown in a tool argument.
  const known = callViewOf({
    channel: { id: 'current-room', rootId: 'g1' },
    placeId: 'g1',
    memoryOn: true,
    store: {
      listChannels: () => [{ id: 'kitchen-room', name: 'kitchen' }],
      listUserProfiles: () => [{ id: 'member-7', names: ['Zoe'] }],
    },
    skills: skillRegistry(),
    channelHandles: new Map(),
    memberHandles: new Map(),
  });
  const read = resolveCall(
    {
      skill: 'memory.channel.read',
      args: { place: `#${handleOf('kitchen-room', HANDLE_DIGITS, CHANNEL_HANDLE_PREFIX)}` },
    },
    known
  ) as { args?: Record<string, unknown> };
  assert.equal(read.args?.place, 'kitchen-room');
  const set = resolveCall(
    { skill: 'intention.set', args: { text: 'ask', due: '1h', people: `@${handleOf('member-7')}` } },
    known
  ) as { args?: Record<string, unknown> };
  assert.equal(set.args?.people, 'member-7');
});
