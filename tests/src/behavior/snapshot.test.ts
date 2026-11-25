import test from 'node:test';
import assert from 'node:assert/strict';
import type { Audience, ChatInfo } from '../../../src/protocol/adapter.ts';
import { audienceAllows, isReadable, railAudience, snapshotOf, takeSnapshot } from '../../../src/behavior/snapshot.ts';
import { world } from '../../fixtures/turn-world.ts';
import { channelInfo, deliver, until, withFakeCore } from '../../fixtures/core-over-fake.ts';
import type { Fake } from '../../fixtures/core-over-fake.ts';

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
    assert.equal(audienceAllows(dm, closed, rail, { partnerId: ZOE }), true, "Zoe's role views it");
    assert.equal(audienceAllows(dm, closed, rail, { partnerId: IASON }), false, 'Iason holds no role that views it');
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

const NOW = Date.now();
const CONFIG = {
  context: { neighborMessages: 5, neighborMaxAgeMinutes: 60, neighborMaxChannels: 8, pull: { sameAudience: false } },
  features: { channelPull: true, participation: true, channelRoute: true },
};

function seed(fake: Fake): void {
  fake.seedChat(channelInfo('c1', { name: 'general', lastMessageAt: NOW - 1000 }));
  for (const [id, name] of [
    ['c2', 'garden'],
    ['c3', 'music'],
    ['c4', 'cooking'],
  ] as const) {
    fake.seedChat(channelInfo(id, { name, lastMessageAt: NOW - 90_000 }));
    deliver(fake, { id: `${id}-1`, chatId: id, text: `news from ${name}`, at: NOW - 90_000, authorId: 'u2' });
  }
}

// PR 7d: the offline catch-up and the emoji backfill are code, so the core lists the chats itself at its start;
// the listing of a turn attempt is the one that asks for the audiences.
const listings = (calls: ReadonlyArray<{ op: string; args: ReadonlyArray<unknown> }>): number =>
  calls.filter((c) => c.op === 'chats' && (c.args[0] as { audience?: boolean } | undefined)?.audience === true).length;

test('takes one chats listing for one attempt however many rails read it', async () => {
  await withFakeCore({ config: CONFIG, seed }, async (rig) => {
    const before = listings(rig.fake.calls);
    await rig.emit(deliver(rig.fake, { id: 'm1', text: 'hello', at: NOW - 500, mention: true }));
    await until(() => rig.posted('c1').length === 1);
    assert.equal(listings(rig.fake.calls) - before, 1);
  });
});

test('takes a new listing for the next attempt', async () => {
  await withFakeCore({ config: CONFIG, seed }, async (rig) => {
    const before = listings(rig.fake.calls);
    await rig.emit(deliver(rig.fake, { id: 'm1', text: 'hello', at: NOW - 500, mention: true }));
    await until(() => rig.posted('c1').length === 1);
    await rig.emit(deliver(rig.fake, { id: 'm2', text: 'and again', at: NOW - 100, mention: true }));
    await until(() => rig.posted('c1').length === 2);
    assert.equal(listings(rig.fake.calls) - before, 2);
  });
});

test('asks the listing for the audience of every chat and the speaker as viewer', async () => {
  await withFakeCore({ config: CONFIG, seed }, async (rig) => {
    await rig.emit(deliver(rig.fake, { id: 'm1', text: 'hello', at: NOW - 500, mention: true }));
    await until(() => rig.posted('c1').length === 1);
    const calls = rig.fake.calls;
    const call = calls.filter((c) => c.op === 'chats').at(-1);
    assert.deepEqual(call?.args[0], { placeId: 'g1', audience: true, viewers: [] });
  });
});
