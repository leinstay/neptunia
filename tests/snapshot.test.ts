import test from 'node:test';
import assert from 'node:assert/strict';
import type { Audience, ChatInfo } from '../src/protocol/adapter.ts';
import {
  audienceAllows,
  isReadable,
  isWritable,
  railAudience,
  snapshotOf,
  takeSnapshot,
} from '../src/behavior/snapshot.ts';
import { world } from './fixtures/turn-world.ts';

const ZOE = '730000000000000001';
const IASON = '730000000000000002';
const SAME_AUDIENCE = { context: { pull: { sameAudience: true } } };
const RAIL_OFF = { context: { pull: { sameAudience: false } } };

function audience(over: Partial<Audience> = {}): Audience {
  return {
    everyone: true,
    groups: [],
    groupAllow: [],
    groupDeny: [],
    memberAllow: [],
    memberDeny: [],
    memberGroups: {},
    ...over,
  };
}

function info(id: string, over: Partial<ChatInfo> = {}): ChatInfo {
  return {
    id,
    kind: 'channel',
    rootId: 'g1',
    name: id,
    topic: null,
    chatType: 'channel',
    iface: 'fake',
    permissions: { read: true, send: true, attach: true, react: true },
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
    audience: audience(),
    ...over,
  };
}

test('audienceAllows passes the same audience and refuses a narrower source or no destination unless the rail is off', () => {
  const main = info('main');
  const open = info('open');
  const narrow = info('narrow', { audience: audience({ memberDeny: [ZOE] }) });
  assert.equal(audienceAllows(main, open, SAME_AUDIENCE), true);
  assert.equal(audienceAllows(main, narrow, SAME_AUDIENCE), false, 'a member denied on the source only');
  assert.equal(audienceAllows(null, open, SAME_AUDIENCE), false, 'no destination never qualifies');
  assert.equal(audienceAllows(main, narrow, RAIL_OFF), true);
  assert.equal(audienceAllows(null, narrow, RAIL_OFF), true);
});

test('audienceAllows lets a private chat in on exactly the sources its partner can view, whatever the audience rail', () => {
  const open = info('open', { viewers: { [IASON]: true, [ZOE]: true } });
  const closed = info('closed', { viewers: { [IASON]: false, [ZOE]: true } });
  const named = info('named', { viewers: { [IASON]: true, [ZOE]: false } });
  const dm = info('dm', { kind: 'dm', rootId: null, audience: null });
  for (const rail of [SAME_AUDIENCE, RAIL_OFF]) {
    assert.equal(audienceAllows(dm, open, rail, { partnerId: IASON }), true);
    assert.equal(audienceAllows(dm, closed, rail, { partnerId: ZOE }), true, 'her role views it');
    assert.equal(audienceAllows(dm, closed, rail, { partnerId: IASON }), false, 'he holds no role that views it');
    assert.equal(audienceAllows(dm, named, rail, { partnerId: ZOE }), false, 'denied by name');
    assert.equal(audienceAllows(dm, named, rail, { partnerId: IASON }), true);
    assert.equal(audienceAllows(dm, open, rail), false, 'no partner never qualifies');
  }
});

test('isReadable refuses a thread, a private chat and an unreadable chat', () => {
  assert.equal(isReadable(info('open')), true);
  assert.equal(isReadable(info('thread', { kind: 'thread' })), false);
  assert.equal(isReadable(info('dm', { kind: 'dm', rootId: null })), false);
  assert.equal(
    isReadable(info('hidden', { permissions: { read: false, send: true, attach: true, react: true } })),
    false
  );
});

test('isWritable needs a readable chat she can send in', () => {
  assert.equal(isWritable(info('open')), true);
  assert.equal(
    isWritable(info('selfreflection', { permissions: { read: true, send: false, attach: true, react: true } })),
    false
  );
  assert.equal(
    isWritable(info('blind', { permissions: { read: false, send: true, attach: true, react: true } })),
    false
  );
});

test('railAudience turns the lists of the wire into the sets the rail compares and gives null for no audience', () => {
  const rail = railAudience(
    audience({ everyone: false, groups: ['r1'], memberDeny: [ZOE], memberGroups: { [IASON]: ['r1', 'r2'] } })
  );
  assert.equal(rail?.everyone, false);
  assert.deepEqual([...(rail?.roles ?? [])], ['r1']);
  assert.deepEqual([...(rail?.memberDeny ?? [])], [ZOE]);
  assert.deepEqual([...(rail?.memberRoles.get(IASON) ?? [])], ['r1', 'r2']);
  assert.equal(railAudience(null), null);
});

test('snapshotOf finds a chat of its listing by id and none otherwise', () => {
  const snapshot = snapshotOf('g1', {
    chats: [info('c1'), info('c2')],
    groups: [{ id: 'r1', name: 'Friends' }],
  });
  assert.equal(snapshot.get('c2')?.id, 'c2');
  assert.equal(snapshot.get('c9'), null);
  assert.deepEqual(snapshot.groups, [{ id: 'r1', name: 'Friends' }]);
});

test('takeSnapshot lists the root once with the audience and the viewers asked for', async () => {
  world().channel({ id: 'c1', placeId: 'g1', viewers: { [ZOE]: false } });
  const snapshot = await takeSnapshot(world().reads, 'g1', [ZOE]);
  assert.deepEqual(snapshot?.get('c1')?.viewers, { [ZOE]: false });
  const asked = world().port.calls.filter((call) => call.op === 'chats');
  assert.deepEqual(
    asked.map((call) => call.args[0]),
    [{ placeId: 'g1', audience: true, viewers: [ZOE] }]
  );
});

test('takeSnapshot gives null when the interface offers no listing', async () => {
  world().port.calls.length = 0;
  world().intercept('chats', () => ({
    status: 'unsupported',
    error: { code: 'unsupported', retryable: false, retryAfterMs: null },
  }));
  assert.equal(await takeSnapshot(world().reads, 'g1'), null);
});
