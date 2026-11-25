import test from 'node:test';
import assert from 'node:assert/strict';
import { deepMerge } from '../../../src/config.ts';
import { labels } from '../../fixtures/labels.ts';
import {
  baseConfig,
  fakeChannelWithMessage,
  fakeFollowUpLlm,
  fakeGuild,
  fakeMemory,
  fakeMessage,
  fakeSpontaneous,
  fakeTurns,
  lineOf,
  makeHandler,
  mutableNow,
  noticesOf,
  scripted,
} from '../../fixtures/events-rig.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { freshWorld, seedExisting, syncStub, useIface, useSelf, world } from '../../fixtures/turn-world.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import { OWNER_PERSON, ownedBy } from '../../fixtures/owner-accounts.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';

useIface('fake');
useSelf('self1');

// ---------------------------------------------------------------------------
// One attention (mention.oneAtATime) -- a direct ping (mention/reply)
// that arrives while a turn is running elsewhere is remembered as pending
// instead of dropped; drainPending() (called in production once a turn
// frees its channel, see src/behavior/turn.ts's setOnIdle) answers the
// oldest one through the normal reply path after a human switch pause.

function directPingMessage(overrides: Record<string, Untyped> = {}) {
  return fakeMessage({
    id: 'm1',
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
    ...overrides,
  });
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// Private chat (features.privateMessages): a DM from a member of the served
// guild runs through privateGate (src/behavior/private.ts) and, when it
// passes, a reply turn with the pinned placeId. Limit notices: a triggered
// turn refused by a rail gets one plain line naming the limit.

const TODAY = '2026-09-29';
const TODAY_MS = Date.parse(`${TODAY}T12:00:00Z`);

function privateConfig(overrides: Record<string, Untyped> = {}) {
  return baseConfig(
    deepMerge(
      // PR 7d: features.privateMessages is the key dm.enabled, and the daily reply caps are gone.
      { bot: { ownerPerson: OWNER_PERSON }, dm: { enabled: true } },
      overrides
    )
  );
}

function fakeDmChannel(id = 'dm1', recipientId = 'u1', overrides: Record<string, Untyped> = {}) {
  const sent: Array<Untyped> = [];
  world().channel({ id, dm: true, partnerId: recipientId ?? null }, { keep: true });
  seedExisting(id, 'dm-m1');
  return {
    id,
    type: 'DM',
    guild: null,
    recipientId,
    sent,
    send: async (payload: Record<string, Untyped>) => {
      sent.push(payload);
      return { id: `sent${sent.length}` };
    },
    messages: { cache: new Map([['dm-m1', {}]]), fetch: async () => ({}) },
    ...overrides,
  };
}

function fakeDmMessage(overrides: Record<string, Untyped> = {}) {
  const channel = overrides.channel ?? fakeDmChannel();
  return fakeMessage({
    id: 'dm-m1',
    guild: null,
    member: null,
    channel,
    placeId: channel.id,
    cleanContent: 'γεια σου',
    ...overrides,
  });
}

/** A client of a served root the interface knows `members` and `fetchable` ones of; `fetchCalls` lists each member read. */
function fakeDmClient({
  members = ['u1', 'owner1'],
  fetchable = [],
}: { members?: Untyped; fetchable?: Array<Untyped> } = {}) {
  const fetchCalls: Array<Untyped> = [];
  return { user: { id: 'self1', username: 'Neptunia' }, fetchCalls, knows: [...members, ...fetchable] };
}

/** A store with public profiles and private files; records the private bookkeeping calls. */
function fakePrivateStore({
  profiles = { u1: { affinity: { score: 10 } }, owner1: { affinity: { score: -50 } } },
  privates = {},
}: { profiles?: Untyped; privates?: Record<string, Untyped> } = {}) {
  return {
    state: { data: {} },
    getUser: (accountId: string) => profiles[accountId] ?? null,
    getPrivate: (accountId: string) => privates[accountId] ?? null,
    // PR 7d: memory is code, so the real turn reads these of the store.
    getPlace: () => ({}),
    listChannels: () => [],
    listUserProfiles: () => [],
    countUsers: () => Object.keys(profiles).length,
    getLore: () => [],
    liveRules: () => [],
    ...objectMediaCache({}),
  };
}

function recordingTurns(result = { outcome: 'spoke' }, extra = {}) {
  const calls: Array<Untyped> = [];
  const turns: Record<string, Untyped> = fakeTurns({
    runTurn: async (args: Record<string, Untyped>) => {
      calls.push(args);
      return result;
    },
    ...extra,
  });
  turns.calls = calls;
  return turns;
}

function makeDmHandler({
  config,
  store,
  client,
  turns,
  memory,
  ...rest
}: { config?: Untyped; store?: Untyped; client?: Untyped; turns?: Untyped; memory?: Untyped; rest?: Untyped } = {}) {
  return makeHandler({
    config: config ?? privateConfig(),
    store: store ?? fakePrivateStore(),
    client: client ?? fakeDmClient(),
    turns: turns ?? recordingTurns(),
    memory: memory ?? fakeMemory(),
    prompts: { labels },
    now: () => TODAY_MS,
    ...rest,
  });
}

const sendingChannel = (id = 'c1', guild = fakeGuild()) => fakeChannelWithMessage(id, guild, 'm1');

// ---------------------------------------------------------------------------
// The pause notice: while paused (/nep pause) a direct call gets one plain
// line (labels.limits.paused), at most once per channel per
// mention.pauseNoticeMinutes; nothing else happens and nothing is marked dirty.

const PAUSE_T0 = Date.UTC(2026, 9, 5, 12, 0, 0);

function pauseConfig(overrides: Record<string, Untyped> = {}) {
  return baseConfig(
    deepMerge(
      {
        features: { pauseNotice: true, dryRun: false },
        mention: { pauseNoticeMinutes: 10 },
        bot: { nameTriggers: ['νεπτούνια'] },
      },
      overrides
    )
  );
}

/** A paused state that counts every markDirty call. */
function pausedState(data = {}) {
  const state: Untyped = { data: { paused: true, ...data }, dirty: 0 };
  state.markDirty = () => {
    state.dirty += 1;
  };
  return state;
}

/** A guild channel that records its sends and holds m0 (the persona's) and m-other (someone else's). */
function pausedChannel(id = 'c1', guild = fakeGuild(), overrides: Record<string, Untyped> = {}) {
  const channel = sendingChannel(id, guild);
  const { cache } = channel.messages;
  cache.set('m0', { author: { id: 'self1' } });
  const { cache: cacheValue } = channel.messages;
  cacheValue.set('m-other', { author: { id: 'u2' } });
  Object.assign(channel, overrides);
  syncStub(channel);
  return channel;
}

function pausedScene(options = {}) {
  freshWorld();
  const { config = pauseConfig(), now = mutableNow(PAUSE_T0), client }: Record<string, Untyped> = options;
  const prompts = 'prompts' in options ? wrongly<Record<string, Untyped>>(options.prompts) : { labels };
  const state = pausedState();
  const store = { state, getUser: () => null };
  const turns = recordingTurns();
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const llm = fakeFollowUpLlm();
  const handler = makeHandler({
    config,
    prompts,
    store,
    turns,
    memory,
    spontaneous,
    llm,
    now,
    client,
    rng: scripted([]),
  });
  return { handler, state, store, turns, memory, spontaneous, llm, now };
}

function assertPausedQuiet(scene: Record<string, Untyped>, label: string) {
  const { calls } = scene.turns;
  assert.equal(calls.length, 0, `${label}: no turn`);
  const { notePostCalls } = scene.turns;
  assert.equal(notePostCalls.length, 0, `${label}: no post noted`);
  const { observeCalls } = scene.memory;
  assert.equal(observeCalls.length, 0, `${label}: no observe`);
  const { onMessageCalls } = scene.spontaneous;
  assert.equal(onMessageCalls.length, 0, `${label}: no eavesdrop`);
  const { calls: callsValue } = scene.llm;
  assert.equal(callsValue.length, 0, `${label}: no model request`);
  assert.equal(scene.state.dirty, 0, `${label}: nothing marked dirty`);
  assert.deepEqual(Object.keys(scene.state.data), ['paused'], `${label}: the state is untouched`);
}

const PAUSED_CALLS = [
  { kind: 'mention', extra: {} },
  { kind: 'reply', extra: { mentions: { users: new Map() }, reference: { messageId: 'm0' } } },
];

for (const { kind, extra } of PAUSED_CALLS) {
  test(`pause notice: a ${kind} while paused gets the notice once, as a reply, and nothing else`, async () => {
    const scene = pausedScene();
    const guild = fakeGuild();
    const channel = pausedChannel('c1', guild);
    const { logs } = await withCapturedLogs(async () => {
      await scene.handler(directPingMessage({ guild, channel, placeId: 'c1', ...extra }));
      await settle();
    });
    assert.deepEqual(noticesOf(scene.handler, 'c1'), [lineOf(labels.limits.paused, 'c1', 'm1')]);
    const lines = logs.filter((l) => l.msg === 'limits: pause notice');
    assert.deepEqual(
      lines.map((l) => [l.channel, l.kind]),
      [['c1', kind]]
    );
    assertPausedQuiet(scene, kind);
  });
}

test('pause notice: a line that is not a direct call stays silent', async () => {
  const cases = [
    {
      label: 'ordinary line',
      message: (guild: Record<string, Untyped>, channel: Record<string, Untyped>) =>
        fakeMessage({ id: 'm1', guild, channel, placeId: 'c1', cleanContent: 'καλημέρα' }),
    },
    {
      label: 'reply to someone else',
      message: (guild: Record<string, Untyped>, channel: Record<string, Untyped>) =>
        fakeMessage({
          id: 'm1',
          guild,
          channel,
          placeId: 'c1',
          cleanContent: 'ναι',
          reference: { messageId: 'm-other' },
        }),
    },
    // Another bot's direct call gets the notice like anyone's, so it is no case here.
    {
      label: 'its own message',
      message: (guild: Record<string, Untyped>, channel: Record<string, Untyped>) =>
        directPingMessage({
          guild,
          channel,
          placeId: 'c1',
          author: { id: 'self1', bot: true, globalName: 'Self', username: 'self' },
        }),
    },
    {
      label: 'system message',
      message: (guild: Record<string, Untyped>, channel: Record<string, Untyped>) =>
        directPingMessage({ guild, channel, placeId: 'c1', system: true }),
    },
    {
      label: 'other guild',
      message: (guild: Record<string, Untyped>, channel: Record<string, Untyped>) =>
        directPingMessage({ guild: fakeGuild('g2'), channel, placeId: 'c1' }),
    },
  ];
  for (const { label, message } of cases) {
    const scene = pausedScene();
    const guild = fakeGuild();
    const channel = pausedChannel('c1', guild);
    await scene.handler(message(guild, channel));
    await settle();
    assert.deepEqual(noticesOf(scene.handler, 'c1'), [], label);
    assertPausedQuiet(scene, label);
  }
});

// Plan 2026-11-04-cli-and-memory B1: threads count as followed places, so the thread case went.
test('pause notice: a call where the bot may not answer stays silent', async () => {
  const cases = [
    { label: 'cannot send', config: pauseConfig(), overrides: { permissionsFor: () => ({ has: () => false }) } },
  ];
  for (const { label, config, overrides } of cases) {
    const scene = pausedScene({ config });
    const guild = fakeGuild();
    const channel = pausedChannel('c1', guild, overrides);
    await scene.handler(directPingMessage({ guild, channel, placeId: 'c1' }));
    await settle();
    assert.deepEqual(noticesOf(scene.handler, 'c1'), [], label);
    assertPausedQuiet(scene, label);
  }
});

test('pause notice: a second call inside the interval posts nothing and logs nothing; one after it posts again', async () => {
  const scene = pausedScene();
  const guild = fakeGuild();
  const channel = pausedChannel('c1', guild);
  const other = pausedChannel('c2', guild);
  const { logs } = await withCapturedLogs(async () => {
    await scene.handler(directPingMessage({ id: 'm1', guild, channel, placeId: 'c1' }));
    scene.now.set(PAUSE_T0 + 9 * 60 * 1000);
    await scene.handler(directPingMessage({ id: 'm2', guild, channel, placeId: 'c1' }));
    await scene.handler(directPingMessage({ id: 'm3', guild, channel: other, placeId: 'c2' }));
  });
  assert.equal(noticesOf(scene.handler, 'c1').length, 1, 'inside the interval: nothing');
  assert.equal(noticesOf(scene.handler, 'c2').length, 1, 'the interval is per channel');
  assert.equal(logs.filter((l) => l.msg === 'limits: pause notice').length, 2);

  scene.now.set(PAUSE_T0 + 10 * 60 * 1000);
  await scene.handler(directPingMessage({ id: 'm4', guild, channel, placeId: 'c1' }));
  assert.equal(noticesOf(scene.handler, 'c1').length, 2, 'after the interval: again');
  assert.equal(noticesOf(scene.handler, 'c1')[1]?.replyTo?.messageId, 'm4');
  assertPausedQuiet(scene, 'interval');
});

test('pause notice: a missing label posts nothing', async () => {
  const cases = [
    {
      label: 'no label',
      config: pauseConfig(),
      prompts: { labels: { ...labels, limits: { notice: labels.limits.notice } } },
    },
    {
      label: 'empty label',
      config: pauseConfig(),
      prompts: { labels: { ...labels, limits: { ...labels.limits, paused: '' } } },
    },
    { label: 'no prompts', config: pauseConfig(), prompts: undefined },
  ];
  for (const { label, config, prompts } of cases) {
    const scene = pausedScene({ config, prompts });
    const guild = fakeGuild();
    const channel = pausedChannel('c1', guild);
    await scene.handler(directPingMessage({ guild, channel, placeId: 'c1' }));
    await settle();
    assert.deepEqual(noticesOf(scene.handler, 'c1'), [], label);
    assertPausedQuiet(scene, label);
  }
});

function pausedDmScene(storeOptions?: Record<string, Untyped>, clientOptions?: Record<string, Untyped>) {
  const store = fakePrivateStore(storeOptions);
  store.state = pausedState();
  const turns = recordingTurns();
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const llm = fakeFollowUpLlm();
  const config = privateConfig({ features: { pauseNotice: true, dryRun: false }, mention: { pauseNoticeMinutes: 10 } });
  const handler = makeDmHandler(
    wrongly({
      config,
      store,
      turns,
      memory,
      spontaneous,
      llm,
      client: fakeDmClient(clientOptions),
    })
  );
  return { handler, store, state: store.state, turns, memory, spontaneous, llm };
}

test('pause notice: a private message from someone the gate lets through gets it', async () => {
  const scene = pausedDmScene();
  const message = fakeDmMessage();
  const { logs } = await withCapturedLogs(async () => {
    await scene.handler(message);
    await settle();
  });
  assert.deepEqual(
    noticesOf(scene.handler, 'dm1'),
    [lineOf(labels.limits.paused, 'dm1', 'dm-m1')],
    'quoted like the private limit notice'
  );
  assert.deepEqual(
    logs.filter((l) => l.msg === 'limits: pause notice').map((l) => [l.channel, l.kind]),
    [['dm1', 'private']]
  );
  assertPausedQuiet(scene, 'private');
});

test('pause notice: a private message the gate refuses gets nothing', async () => {
  const cases = [
    { label: 'not a member', store: undefined, client: { members: [] } },
    { label: 'unknown', store: { profiles: {} }, client: undefined },
    { label: 'affinity', store: { profiles: { u1: { affinity: { score: 4 } } } }, client: undefined },
  ];
  for (const { label, store, client } of cases) {
    const scene = pausedDmScene(store, client);
    const message = fakeDmMessage();
    await scene.handler(message);
    await settle();
    assert.deepEqual(noticesOf(scene.handler, 'dm1'), [], label);
    assertPausedQuiet(scene, label);
  }
});

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['owner1']);
