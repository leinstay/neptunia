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

// Two native ids whose four-digit handles collide (the pair of tests/handles.test.ts).
const OLDER = '400000000000807738';
const NEWER = '400000000005693761';

/**
 * The view of a turn on the command line: a private chat with no root, no snapshot, the memory's places known.
 * `knownPlaces` were place ids the view parsed a native id out of. Each place carries its stored native id instead
 * (plan 2026-11-08 ids-by-links, slice 7: no id is worked out from the text of another), so the cases below give it.
 */
function commandLineView(knownPlaces: ReadonlyArray<{ id: string; nativeId: string | null }>) {
  return callViewOf({
    channel: { id: 'owner', rootId: null },
    currentIface: 'cli',
    placeId: 'cli:dm:owner',
    skills: skillRegistry(),
    channelHandles: new Map(),
    knownPlaces,
  });
}

const placeOf = (resolved: unknown): unknown => (resolved as { args?: Record<string, unknown> }).args?.place;

test("a channel's #handle she carries from another interface resolves to that place's id on the command line", () => {
  // Bug: a handle carried from a turn on another interface resolved only over the turn's own channels, so the call
  // read the command line chat itself and answered unsupported.
  const handle = handleOf('far-room', HANDLE_DIGITS, CHANNEL_HANDLE_PREFIX);
  const view = commandLineView([
    { id: 'other:channel:far-room', nativeId: 'far-room' },
    { id: 'cli:dm:owner', nativeId: null },
  ]);
  for (const skill of ['conversation.read', 'memory.channel.read'])
    assert.equal(placeOf(resolveCall({ skill, args: { place: `#${handle}` } }, view)), 'other:channel:far-room');
});

test('a known channel whose place id spells no native id resolves its #handle to that place from its stored native id', () => {
  // Bug: the handles were widened over the native id parsed out of each place id, so a channel with an opaque place id
  // had no handle and her call read the command line chat instead.
  const handle = handleOf('far-room', HANDLE_DIGITS, CHANNEL_HANDLE_PREFIX);
  const view = commandLineView([{ id: 'place:far', nativeId: 'far-room' }]);
  assert.equal(
    placeOf(resolveCall({ skill: 'memory.channel.read', args: { place: `#${handle}` } }, view)),
    'place:far'
  );
});

test('a handle two known places of different interfaces share stays unresolved', () => {
  const view = commandLineView([
    { id: 'other:channel:' + OLDER, nativeId: OLDER },
    { id: 'foreign:channel:' + NEWER, nativeId: NEWER },
  ]);
  const shared = handleOf(OLDER, HANDLE_DIGITS, CHANNEL_HANDLE_PREFIX);
  const read = resolveCall({ skill: 'memory.channel.read', args: { place: `#${shared}` } }, view);
  assert.equal(placeOf(read), undefined, 'neither place is guessed');
  const longer = handleOf(NEWER, HANDLE_DIGITS + 1, CHANNEL_HANDLE_PREFIX);
  const one = resolveCall({ skill: 'memory.channel.read', args: { place: `#${longer}` } }, view);
  assert.equal(placeOf(one), `foreign:channel:${NEWER}`, 'the lengthened handle names one place');
});

test("a direct chat's place gives no channel handle", () => {
  // Bug: a partner's id hashed as a channel would let a #handle name a private chat. A stored DM place holds no native
  // id of its own, so the partner's id in its place id reaches no handle.
  const view = commandLineView([{ id: 'other:dm:partner-3', nativeId: null }]);
  const handle = handleOf('partner-3', HANDLE_DIGITS, CHANNEL_HANDLE_PREFIX);
  assert.equal(placeOf(resolveCall({ skill: 'memory.channel.read', args: { place: `#${handle}` } }, view)), undefined);
});

test("a handle the request showed for another interface's channel resolves to that place's id", () => {
  // Bug: the command line request shows a channel of another interface by its native id, which the call then read as
  // a chat of the command line.
  const handle = handleOf('far-room', HANDLE_DIGITS, CHANNEL_HANDLE_PREFIX);
  const view = callViewOf({
    channel: { id: 'owner', rootId: null },
    currentIface: 'cli',
    placeId: 'cli:dm:owner',
    skills: skillRegistry(),
    channelHandles: new Map([[handle, 'far-room']]),
    knownPlaces: [{ id: 'other:channel:far-room', nativeId: 'far-room' }],
  });
  const read = resolveCall({ skill: 'memory.channel.read', args: { place: `#${handle}` } }, view);
  assert.equal(placeOf(read), 'other:channel:far-room');
});

test("a handle of the turn's own channel keeps its native id when the memory knows the place too", () => {
  const handle = handleOf('kitchen-room', HANDLE_DIGITS, CHANNEL_HANDLE_PREFIX);
  const view = callViewOf({
    channel: { id: 'current-room', rootId: 'g1' },
    currentIface: 'primary',
    placeId: 'g1',
    store: { listChannels: () => [{ id: 'kitchen-room', name: 'kitchen' }], listUserProfiles: () => [] },
    skills: skillRegistry(),
    channelHandles: new Map(),
    knownPlaces: [{ id: 'primary:channel:kitchen-room', nativeId: 'kitchen-room' }],
  });
  const read = resolveCall({ skill: 'memory.channel.read', args: { place: `#${handle}` } }, view);
  assert.equal(placeOf(read), 'kitchen-room');
});
