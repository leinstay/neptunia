import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageHandler } from '../../../src/behavior/pipeline.ts';
import { createTagHistory } from '../../../src/behavior/mention.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { createReads } from '../../../src/interface/reads.ts';
import type { MessageEvent } from '../../../src/protocol/adapter.ts';
import type { MessageReceived } from '../../../src/protocol/events.ts';
import {
  baseConfig,
  fakeChannel,
  fakeChannelWithMessage,
  fakeGuild,
  fakeMemory,
  fakeMessage,
  fakeSpontaneous,
  fakeStore,
  fakeTurns,
  makeHandler,
  mutableNow,
  scripted,
} from '../../fixtures/events-rig.ts';
import { labels } from '../../fixtures/labels.ts';
import { wrongly, table } from '../../fixtures/loose-types.ts';
import { channel as channelOf } from '../../fixtures/reads-rig.ts';
import { PermissionFlagsBits } from 'discord.js';
import { deepMerge } from '../../../src/config.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { createActivity } from '../../../src/behavior/activity.ts';
import { freshWorld, seedExisting, useIface, useSelf, world } from '../../fixtures/turn-world.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { OWNER_PERSON, ownedBy } from '../../fixtures/owner-accounts.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';
import {
  channelInfo,
  deliver,
  until,
  withFakeCore,
  settle as pipelineNoRawSettle,
} from '../../fixtures/core-over-fake.ts';
import type { Fake } from '../../fixtures/core-over-fake.ts';

// The door's screen (src/pipeline/handle-message.ts#DoorScreen): before any turn or memory reads a new line, the screen
// may drop it (the right link code from the account that asked) so that no turn starts and nothing is observed, or pass
// it on. A fake adapter, a fake turn runner and a recording memory; the screen itself is a stand-in.

const NOW = Date.parse('2026-11-08T12:00:00Z');
const SELF = 'self-id';

type Rig = { say: (id: string, text: string) => Promise<void>; started: Array<string>; observed: Array<string> };

function rig(verdict: (event: MessageEvent) => 'pass' | 'observe' | 'drop'): Rig {
  const fake = createFakeAdapter({ iface: 'chatnet', selfId: SELF });
  fake.seedChat(channelOf('c1', { iface: 'chatnet', name: 'c1', kind: 'channel', rootId: 'g1' }));
  const reads = createReads(fake, { info() {}, warn() {}, error() {} });
  const started: Array<string> = [];
  const observed: Array<string> = [];
  const handler = createMessageHandler(
    wrongly<Parameters<typeof createMessageHandler>[0]>({
      hot: {
        config: baseConfig({ bot: { timezone: 'UTC' }, address: { attentionMinutes: 30, maxTurnsPerAuthor: 100 } }),
        prompts: { 'classify/address': 'Is it said to {{name}}?', labels },
      },
      store: { state: { data: {}, markDirty() {} }, getUser: () => ({ names: ['Member'], affinity: { score: 0 } }) },
      reads,
      selfId: () => SELF,
      getSelfName: () => 'Nova',
      turns: {
        notePost() {},
        isBusy: () => false,
        isAnyBusy: () => false,
        spokeAfterSeeing: () => false,
        lastPostAt: () => 0,
        runTurn: (asked: { trigger: { id: string } }) => {
          started.push(asked.trigger.id);
          return Promise.resolve({ outcome: 'spoke' });
        },
      },
      memory: { observe: (_place: string, line: { id: string }) => observed.push(line.id) },
      tagHistory: createTagHistory(),
      isServedRoot: () => true,
      rootsOf: () => [],
      llm: { complete: () => Promise.resolve({ text: '{"answer":"yes"}', usage: {}, estimated: 1 }) },
      now: () => NOW,
      missed: { noteFact() {}, noteActivity() {}, noteNotAddressed() {} },
      selfNames: () => [],
      screen: { screen: (event: MessageEvent) => Promise.resolve(verdict(event)) },
      port: fake,
    })
  );
  async function say(id: string, text: string): Promise<void> {
    const event: MessageReceived = wrongly<MessageReceived>({
      kind: 'message.received',
      iface: 'chatnet',
      at: NOW,
      id: `chatnet:message:${id}`,
      chat: { id: 'c1', kind: 'channel', rootId: 'g1', name: 'c1' },
      message: {
        id,
        author: { id: 'a1', name: 'Eleni', self: false, bot: false },
        content: text,
        sourceText: text,
        system: false,
        at: NOW,
        replyToId: null,
        replyPingAccountId: null,
        forwardedFrom: null,
        attachments: [],
        links: [],
        forwarded: [],
        stickers: [],
        emojis: [],
        reactions: [],
      },
      addressing: { mentioned: true, replyToSelf: false, mentionedAccountIds: [SELF], mentionedChatIds: [] },
    });
    fake.seedEvent(wrongly<MessageEvent>(event));
    await handler(wrongly<MessageReceived>(event));
  }
  return { say, started, observed };
}

test('a line the screen drops starts no turn and is not observed', async () => {
  const { say, started, observed } = rig((event) => (event.message.content === 'ABCD2345' ? 'drop' : 'pass'));
  await say('m1', 'ABCD2345');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(started, []);
  assert.deepEqual(observed, []);
});

test('a line the screen passes reaches memory and its turn', async () => {
  const { say, started, observed } = rig(() => 'pass');
  await say('m2', 'Nova, hello');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(observed, ['m2']);
  assert.deepEqual(started, ['m2']);
});

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

function fakeStateStore(data: Record<string, Untyped> = {}) {
  const base = fakeStore();
  const store = Object.assign(base, {
    dirtyCount: 0,
    state: {
      data,
      markDirty() {
        store.dirtyCount += 1;
      },
    },
  });
  return store;
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

// ---------------------------------------------------------------------------
// Calls from a channel the persona can read but not write in. The routed call is gone
// (no home place and no equivalent), and with it the fifty tests that pinned its settle wait
// (src/pipeline/settle.ts), its route (`routeFor`, `usableDestination`), its queue entry (`destination`, `superseded`) and
// its stamps on the ring from the pipeline. No other behaviour of the pipeline rested on them; the tests below state what
// holds instead.

const VIEW = PermissionFlagsBits.ViewChannel;
const SEND = PermissionFlagsBits.SendMessages;
const ROUTE_T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const SECOND = 1000;

/** ROUTE_T0 plus `seconds`. */
const routeAt = (seconds: number) => ROUTE_T0 + seconds * SECOND;

/**
 * Fake timers for the settle wait: `set` records each timer (with `unref`), `clear` marks it;
 * `live()` lists the ones neither cleared nor fired; `fire()` runs those (`fireOne(timer)` just
 * that one), then lets the turn's promise chain settle.
 */
function fakeTimers() {
  const all: Array<Untyped> = [];
  const timers = {
    all,
    set(fn: string, ms: Array<Record<string, Untyped>>) {
      const timer: Record<string, Untyped> = { fn, ms, cleared: false, fired: false, unrefed: false };
      timer.unref = () => {
        timer.unrefed = true;
        return timer;
      };
      all.push(timer);
      return timer;
    },
    clear(timer: Record<string, Untyped>) {
      if (timer) timer.cleared = true;
    },
    live: () => all.filter((timer) => !timer.cleared && !timer.fired),
    async fire() {
      for (const timer of timers.live()) {
        timer.fired = true;
        timer.fn();
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
    async fireOne(timer: Record<string, Untyped>) {
      timer.fired = true;
      timer.fn();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  return timers;
}

/** A guild for routed calls: @everyone (its id is the guild's), one more role, the bot member, a channel cache. */
function routeGuild() {
  const everyone = { id: 'g1' };
  const regular = { id: 'r1' };
  return {
    id: 'g1',
    members: { me: { id: 'self1', displayName: 'Ζωή' } },
    roles: {
      everyone,
      cache: new Map([
        [everyone.id, everyone],
        [regular.id, regular],
      ]),
    },
    channels: { cache: new Map() },
  };
}

/**
 * A text channel of a routeGuild, no overwrites. `send`: the bot may send there (it may always
 * view, read and react). `viewers`: the ids of the roles that can view it (@everyone is `g1`).
 * `sent` records what the bot posted.
 */
function routeChannel(
  guild: Record<string, Untyped>,
  id: string,
  { send = true, viewers = ['g1', 'r1'] }: { send?: boolean; viewers?: Untyped } = {}
) {
  const me = guild.members.me;
  const cache = new Map();
  const channel: Record<string, Untyped> = fakeChannel(id, guild, {
    name: id,
    isTextBased: () => true,
    permissionOverwrites: { cache: new Map() },
    permissionsFor: (target: Record<string, Untyped>) =>
      target === me
        ? { has: (flag: bigint) => send || flag !== SEND }
        : { has: (flag: bigint) => flag === VIEW && viewers.includes(target?.id) },
    messages: { cache, fetch: async (messageId: string) => cache.get(messageId) ?? null },
  });
  const noOverwrites = { groupAllow: [], groupDeny: [], memberAllow: [], memberDeny: [], memberGroups: {} };
  const audienceOf = (roles: Array<string>) => ({
    ...noOverwrites,
    everyone: roles.includes('g1'),
    groups: roles.filter((role: string) => role !== 'g1'),
  });
  const held = world().channel(
    { id, placeId: guild.id, name: id, permissions: { send }, audience: audienceOf(viewers) },
    { keep: true }
  );
  Object.defineProperty(channel, 'sent', { get: () => held.sent });
  channel.setViewers = (roles: Array<string>) => held.update({ audience: audienceOf(roles) });
  channel.revokeSend = () => held.permit({ send: false });
  const { cache: cacheValue } = guild.channels;
  cacheValue.set(id, channel);
  return channel;
}

/**
 * The sources `s1` and `s2` (the bot reads them, cannot write in them) and the main channel
 * `d1` (`memory.mainChannelIds`), a state store, fake timers and a clock at ROUTE_T0. `config`
 * merges over the shipped defaults plus the main channel and a name trigger. `spontaneous`
 * replaces the default fake scheduler.
 */
type RouteScene = ReturnType<typeof routeScene>;

function routeScene({
  config: overrides = {},
  turns = recordingTurns(),
  sourceViewers = ['g1', 'r1'],
  mainCanSend = true,
  store = fakeStateStore(),
  rng = () => 0.5,
  prompts,
  tagHistory,
  spontaneous,
}: {
  config?: Record<string, Untyped>;
  turns?: Untyped;
  sourceViewers?: Untyped;
  mainCanSend?: boolean;
  store?: Untyped;
  rng?: Untyped;
  prompts?: Untyped;
  tagHistory?: Untyped;
  spontaneous?: Untyped;
} = {}) {
  freshWorld();
  const config = baseConfig(deepMerge({ bot: { nameTriggers: ['νεπτούνια'] } }, overrides));
  const guild = routeGuild();
  const source = routeChannel(guild, 's1', { send: false, viewers: sourceViewers });
  const source2 = routeChannel(guild, 's2', { send: false });
  const main = routeChannel(guild, 'd1', { send: mainCanSend });
  const clock = mutableNow(ROUTE_T0);
  const timers = fakeTimers();
  const handler = makeHandler({
    config,
    turns,
    store,
    now: clock,
    timers,
    rng,
    prompts,
    tagHistory,
    spontaneous,
    sleep: async () => {},
  });
  return { config, guild, source, source2, main, sourceViewers, clock, timers, handler, turns, store };
}

/**
 * A member's message in `channel` written at `ts`: a mention of the persona unless `mention` is
 * false; `replyTo` makes it a reply to that message id.
 */
function routeMessage(
  channel: Record<string, Untyped>,
  {
    id,
    ts,
    mention = true,
    authorId = 'u1',
    authorName = 'Ελένη',
    content = 'γεια σου',
    replyTo = null,
  }: Record<string, Untyped>
) {
  return fakeMessage({
    id,
    guild: channel.guild,
    channel,
    placeId: channel.id,
    author: { id: authorId, bot: false, globalName: authorName, username: authorName },
    member: { displayName: authorName },
    cleanContent: content,
    createdTimestamp: ts,
    reference: replyTo ? { messageId: replyTo } : null,
    mentions: { users: new Map(mention ? [['self1', { id: 'self1' }]] : []) },
  });
}

/** Move the scene's clock to `seconds` after ROUTE_T0 and hand it a message written then (cached in its channel). */
async function routeSend(
  scene: RouteScene,
  channel: Record<string, Untyped>,
  seconds: number,
  spec: Record<string, Untyped>
) {
  scene.clock.set(routeAt(seconds));
  const message: Record<string, Untyped> = routeMessage(channel, { ts: routeAt(seconds), ...spec });
  const { cache } = channel.messages;
  cache.set(message.id, message);
  world().seed(channel.id, [message]);
  await scene.handler(message);
}

const byMsg = (logs: Record<string, Untyped>, msg: string) =>
  logs.filter((entry: Record<string, Untyped>) => entry.msg === msg);
describe('events of the pipeline', () => {
  let stopOwners: Array<() => void> = [];
  before(() => {
    useIface('fake');
    useSelf('self1');
    stopOwners = [ownedBy(['owner1'])];
  });
  after(() => {
    useIface('discord');
    useSelf('self-id');
    for (const stop of stopOwners) stop();
  });

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  // /nep pause: while paused, nothing here may observe, trigger, run a
  // turn or eavesdrop -- a burst of otherwise-triggering messages is a no-op.
  test('events: while paused, a burst of messages triggers no observe, no trigger, no turn, no eavesdrop', async () => {
    let runTurnCalls = 0;
    const turns = fakeTurns({
      runTurn: async () => {
        runTurnCalls += 1;
        return { outcome: 'spoke' };
      },
    });
    const spontaneous = fakeSpontaneous();
    const memory = fakeMemory();
    const store = { state: { data: { paused: true } }, getUser: () => null };
    const handler = makeHandler({ turns, spontaneous, memory, store });

    const guild = fakeGuild();
    const channel = fakeChannel('c1', guild);
    await handler(fakeMessage({ id: 'm1', guild, channel, placeId: 'c1', cleanContent: 'plain chat' }));
    await handler(
      fakeMessage({
        id: 'm2',
        guild,
        channel,
        placeId: 'c1',
        cleanContent: 'γεια',
        mentions: { users: new Map([['self1', { id: 'self1' }]]) },
      })
    );
    await handler(
      fakeMessage({
        id: 'm3',
        guild,
        channel,
        placeId: 'c1',
        author: { id: 'self1', bot: true, globalName: 'Neptunia', username: 'neptunia' },
      })
    );

    assert.equal(memory.observeCalls.length, 0);
    assert.equal(spontaneous.onMessageCalls.length, 0);
    assert.equal(turns.notePostCalls.length, 0);
    assert.equal(runTurnCalls, 0);
  });

  test('events: its own message notes the post and is observed, never turned into a turn', async () => {
    const turns = fakeTurns();
    const memory = fakeMemory();
    const spontaneous = fakeSpontaneous();
    const handler = makeHandler({ turns, memory, spontaneous });

    const message = fakeMessage({ author: { id: 'self1', bot: true, globalName: 'Neptunia', username: 'neptunia' } });
    await handler(message);

    assert.equal(turns.notePostCalls.length, 1);
    assert.deepEqual(turns.notePostCalls[0], ['c1', message.createdTimestamp]);
    assert.equal(memory.observeCalls.length, 1);
    const firstObserveCall = memory.observeCalls[0];
    assert.equal(firstObserveCall[0], 'g1');
    assert.equal(firstObserveCall[1].self, true);
  });

  test('events: its own limit notice notes the post but never reaches memory or opens a follow-up window', async () => {
    const turns = fakeTurns();
    const memory = fakeMemory();
    const store = fakeStateStore({});
    const handler = makeHandler({ turns, memory, store, prompts: { labels } });

    const message = fakeMessage({
      author: { id: 'self1', bot: true, globalName: 'Neptunia', username: 'neptunia' },
      cleanContent: 'limit reached (llm.maxRequestsPerDay, 800/800)',
    });
    await handler(message);

    assert.deepEqual(turns.notePostCalls, [['c1', message.createdTimestamp]]);
    assert.equal(memory.observeCalls.length, 0);
    const { data } = store.state;
    assert.equal(data.addressAttention, undefined, 'no attention opened');

    // An ordinary message of its own still does both.
    await handler(
      fakeMessage({
        author: { id: 'self1', bot: true, globalName: 'Neptunia', username: 'neptunia' },
        cleanContent: 'τι νέα;',
      })
    );
    assert.equal(memory.observeCalls.length, 1);
    const { data: dataValue } = store.state;
    assert.equal(
      Object.keys(wrongly<Record<string, number>>(dataValue.addressAttention)).length,
      1,
      'attention opened by real speech'
    );
  });

  // A bot is a person to the persona, so another bot's line is observed like a member's.
  test("events: another bot's line is observed like a member's", async () => {
    const turns = fakeTurns();
    const memory = fakeMemory();
    const spontaneous = fakeSpontaneous();
    const handler = makeHandler({ turns, memory, spontaneous });

    const message = fakeMessage({ author: { id: 'otherbot', bot: true, globalName: 'Other', username: 'other' } });
    await handler(message);

    assert.equal(memory.observeCalls.length, 1);
    assert.equal(turns.notePostCalls.length, 0, 'not a post of the persona');
  });

  test('events: a message from a guild other than the one this instance serves is ignored entirely', async () => {
    const memory = fakeMemory();
    const spontaneous = fakeSpontaneous();
    const turns = fakeTurns();
    const handler = makeHandler({
      memory,
      spontaneous,
      turns,
      placeIdOfHome: () => 'the-served-guild',
    });

    const message = fakeMessage({ guild: fakeGuild('some-other-guild'), cleanContent: 'just chatting' });
    await handler(message);

    assert.equal(memory.observeCalls.length, 0);
    assert.equal(spontaneous.onMessageCalls.length, 0);
    assert.equal(turns.notePostCalls.length, 0);
  });

  test('events: a foreign-guild message is ignored even when the instance has not resolved a guild yet', async () => {
    const memory = fakeMemory();
    const spontaneous = fakeSpontaneous();
    const handler = makeHandler({ memory, spontaneous, placeIdOfHome: () => null });

    const message = fakeMessage();
    await handler(message);

    assert.equal(memory.observeCalls.length, 0);
    assert.equal(spontaneous.onMessageCalls.length, 0);
  });

  // ---------------------------------------------------------------------------
  // relationships: `direct` on observe, affinityScore into decideMention

  test('events: a triggering message is observed with direct: true', async () => {
    const memory = fakeMemory();
    const handler = makeHandler({ memory, rng: scripted([0.99]) });

    const message = fakeMessage({
      cleanContent: 'γεια',
      mentions: { users: new Map([['self1', { id: 'self1' }]]) },
    });
    await handler(message);
    await Promise.resolve();

    assert.equal(memory.observeCalls.length, 1);
    const firstObserveCall = memory.observeCalls[0];
    assert.deepEqual(firstObserveCall[2], { direct: true });
  });
});

describe('events of the pipeline', () => {
  let stopOwners: Array<() => void> = [];
  before(() => {
    useIface('fake');
    useSelf('self1');
    stopOwners = [ownedBy(['owner1'])];
  });
  after(() => {
    useIface('discord');
    useSelf('self-id');
    for (const stop of stopOwners) stop();
  });

  test('events: a non-triggering message is observed with direct: false', async () => {
    const memory = fakeMemory();
    const spontaneous = fakeSpontaneous();
    const handler = makeHandler({ memory, spontaneous });

    const message = fakeMessage({ cleanContent: 'ένα μήνυμα χωρίς πρόκληση' });
    await handler(message);

    assert.equal(memory.observeCalls.length, 1);
    const firstObserveCall = memory.observeCalls[0];
    assert.deepEqual(firstObserveCall[2], { direct: false });
  });

  for (const { kind, extra } of [
    { kind: 'mention', extra: {} },
    { kind: 'reply', extra: { mentions: { users: new Map() }, reference: { messageId: 'm0' } } },
  ]) {
    test(`events: a ${kind} trigger in a channel without send permission is dropped with a cannot-send log line`, async () => {
      let called = false;
      const turns = fakeTurns({
        isBusy: () => false,
        // Busy elsewhere: a direct call would be queued if the permission check let it through.
        isAnyBusy: () => true,
        runTurn: async () => {
          called = true;
          return { outcome: 'spoke' };
        },
      });
      const config = baseConfig({ bot: { nameTriggers: ['νεπτούνια'] } });
      // No rng values: neither the ignore roll nor the switch pause may run.
      const handler = makeHandler({ config, turns, sleep: async () => {}, rng: scripted([]) });

      const guild = fakeGuild();
      const channel = fakeChannelWithMessage('c1', guild, 'm1', { permissionsFor: () => ({ has: () => false }) });
      const { cache } = channel.messages;
      cache.set('m0', { author: { id: 'self1' } });
      const { logs } = await withCapturedLogs(async () => {
        await handler(directPingMessage({ guild, channel, placeId: 'c1', ...extra }));
        await handler.drainPending();
      });

      assert.equal(called, false, 'no turn starts');
      const dropped = logs.filter((entry) => entry.msg === 'mention: dropped');
      assert.equal(dropped.length, 1, 'logged exactly once');
      assert.equal(dropped[0].channel, 'c1');
      assert.equal(dropped[0].kind, kind);
      assert.equal(dropped[0].reason, 'cannot-send');
      assert.equal(
        logs.some((entry) => entry.msg === 'mention: deferred'),
        false,
        'no pending entry'
      );
      assert.equal(
        logs.some((entry) => entry.msg === 'mention: decided'),
        false,
        'no ignore roll'
      );
    });
  }

  test("activity: a member's server message is noted under its channel; the persona's own message is not", async () => {
    const activity = createActivity();
    const t = Date.now();
    const handler = makeHandler({ activity });
    await handler(fakeMessage({ id: 'm1', createdTimestamp: t - 2000 }));
    await handler(
      fakeMessage({
        id: 'm2',
        author: { id: 'self1', bot: true, username: 'Neptunia' },
        cleanContent: 'γεια',
        createdTimestamp: t,
      })
    );
    await settle();
    assert.equal(activity.lastAt('c1', 'u1'), t - 2000);
    assert.equal(activity.lastAt('c1', 'self1'), null);
  });

  test("activity: a member's DM is noted under the DM channel; the persona's own DM message is not", async () => {
    const activity = createActivity();
    const handler = makeDmHandler(wrongly({ activity }));
    await handler(fakeDmMessage({ createdTimestamp: TODAY_MS - 3000 }));
    await handler(
      fakeDmMessage({
        id: 'dm-own',
        author: { id: 'self1', bot: true, username: 'Neptunia' },
        createdTimestamp: TODAY_MS,
      })
    );
    await settle();
    assert.equal(activity.lastAt('dm1', 'u1'), TODAY_MS - 3000);
    assert.equal(activity.lastAt('dm1', 'self1'), null);
  });

  test("private: the persona's own DM message is noted and observed privately under the partner's id", async () => {
    const turns = recordingTurns();
    const memory = fakeMemory();
    const channel = fakeDmChannel('dm1', 'u1');
    const handler = makeDmHandler({ turns, memory });
    const message = fakeDmMessage({
      channel,
      author: { id: 'self1', bot: true, globalName: 'Neptunia', username: 'neptunia' },
    });
    await handler(message);
    await settle();

    assert.deepEqual(turns.notePostCalls, [['dm1', message.createdTimestamp]]);
    assert.equal(memory.observeCalls.length, 1);
    // A DM has no root: it is observed under its own place.
    const firstObserveCall = memory.observeCalls[0];
    assert.equal(firstObserveCall[0], 'dm1');
    assert.equal(firstObserveCall[1].self, true);
    assert.deepEqual(firstObserveCall[2], { private: 'u1' });
    assert.equal(turns.calls.length, 0);
  });

  test("private: the persona's own DM message without a usable partner id is only noted", async () => {
    for (const [label, channel] of table([
      ['missing', fakeDmChannel('dm1', 'u1', { recipientId: undefined })],
      ['self', fakeDmChannel('dm1', 'self1')],
    ])) {
      const turns = recordingTurns();
      const memory = fakeMemory();
      const handler = makeDmHandler({ turns, memory });
      const message = fakeDmMessage({
        channel,
        author: { id: 'self1', bot: true, globalName: 'Neptunia', username: 'neptunia' },
      });
      await handler(message);
      await settle();
      assert.deepEqual(turns.notePostCalls, [['dm1', message.createdTimestamp]], wrongly(label));
      assert.equal(memory.observeCalls.length, 0, wrongly(label));
    }
  });

  test("private: the persona's own limit notice in a DM is noted but never observed", async () => {
    const turns = recordingTurns();
    const memory = fakeMemory();
    const channel = fakeDmChannel('dm1', 'u1');
    const handler = makeDmHandler({ turns, memory });
    const message = fakeDmMessage({
      channel,
      author: { id: 'self1', bot: true, globalName: 'Neptunia', username: 'neptunia' },
      cleanContent: 'limit reached (private.maxPerUserPerDay, 100/100)',
    });
    await handler(message);
    await settle();
    assert.deepEqual(turns.notePostCalls, [['dm1', message.createdTimestamp]]);
    assert.equal(memory.observeCalls.length, 0);
  });
});

describe('events of the pipeline', () => {
  let stopOwners: Array<() => void> = [];
  before(() => {
    useIface('fake');
    useSelf('self1');
    stopOwners = [ownedBy(['owner1'])];
  });
  after(() => {
    useIface('discord');
    useSelf('self-id');
    for (const stop of stopOwners) stop();
  });

  test('events: a call where the persona cannot write starts no wait and no turn, keeps nothing and leaves a trace', async () => {
    // Bug: a call from a read-only channel comes back later as words in a channel nobody chose.
    const scene = routeScene();
    const { logs } = await withCapturedLogs(() => routeSend(scene, scene.source, 0, { id: 'm1' }));

    const dropped = byMsg(logs, 'mention: dropped');
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].reason, 'cannot-send');
    const { all } = scene.timers;
    assert.equal(all.length, 0);
    const { calls } = scene.turns;
    assert.equal(calls.length, 0);
    const { state } = scene.store;
    assert.equal(state.data.elsewherePings, undefined);
  });
});

// A bot is a person to the persona (src/pipeline/handle-message.ts): a line a bot or a webhook
// writes is stored like a member's, and a bot that names the persona starts a turn as a member would. The core over the
// fake interface (tests/fixtures/core-over-fake.ts). Synthetic lines, in Greek.

const PIPELINE_HANDLE_MESSAGE_NOW = Date.now();
const seed = (fake: Fake): void => fake.seedChat(channelInfo('c1', { name: 'general' }));

test("stores a bot's line as a seen line", async () => {
  await withFakeCore({ seed }, async (rig) => {
    const line = deliver(rig.fake, {
      id: 'b1',
      text: 'ο καιρός αύριο: βροχή',
      at: PIPELINE_HANDLE_MESSAGE_NOW - 1000,
      authorId: 'bot1',
      bot: true,
    });
    assert.equal(await rig.emit(line), 'ok');
    await until(() => rig.linesOf('b1').length > 0);
    assert.deepEqual(
      rig.linesOf('b1').map((row) => [row.kind, row.text]),
      [['seen', 'ο καιρός αύριο: βροχή']]
    );
  });
});

test('answers a bot that names the persona as the persona answers a member', async () => {
  await withFakeCore({ seed }, async (rig) => {
    const call = deliver(rig.fake, {
      id: 'b2',
      text: 'γεια σου',
      at: PIPELINE_HANDLE_MESSAGE_NOW - 1000,
      authorId: 'bot1',
      bot: true,
      mention: true,
    });
    assert.equal(await rig.emit(call), 'ok');
    await until(() => rig.posted('c1').length === 1);
    assert.equal(rig.requests.length, 1);
  });
});

test('stores a line of the persona that carries a pairing phrase when its echo arrives', async () => {
  const text =
    'Your one-time pairing phrase is: πέτρα δέντρο νερό φωτιά αέρας χώμα. Type /interfaces pair followed by these six words in her command line within an hour.';
  await withFakeCore({ seed }, async (rig) => {
    assert.equal(
      await rig.emit(
        deliver(rig.fake, { id: 'k1', text, at: PIPELINE_HANDLE_MESSAGE_NOW - 1000, authorId: 'self-id' })
      ),
      'ok'
    );
    await until(() => rig.linesOf('k1').length > 0);
    assert.equal(rig.linesOf('k1')[0]?.text, text);
  });
});

// The message pipeline on events alone: no platform message object, no raw handle. The core over the fake interface
// (tests/fixtures/core-over-fake.ts) gets whole `message.received` events. A system message is ignored, a late embed is
// folded into the gif library from the edit event's `previous`, a partial edit is completed by asking the adapter for
// the message, and a deletion is dated by `message.at` and carries `message.author.id`.

const PIPELINE_NO_RAW_NOW = Date.now();

function pipelineNoRawSeed(fake: Fake): void {
  fake.seedChat(channelInfo('c1', { name: 'general' }));
}

test('answers a member message that reaches the core as plain data', async () => {
  const { result } = await withFakeCore({ seed: pipelineNoRawSeed }, async (rig) => {
    assert.equal(
      await rig.emit(deliver(rig.fake, { id: 'm1', text: 'hello', at: PIPELINE_NO_RAW_NOW - 500, mention: true })),
      'ok'
    );
    await until(() => rig.posted('c1').length === 1);
    return rig.requests.length;
  });
  assert.equal(result, 1);
});

test('ignores a system message that names the persona', async () => {
  await withFakeCore({ seed: pipelineNoRawSeed }, async (rig) => {
    const joined = deliver(rig.fake, {
      id: 'm1',
      text: 'welcome',
      at: PIPELINE_NO_RAW_NOW - 500,
      mention: true,
      system: true,
    });
    assert.equal(await rig.emit(joined), 'ok');
    await pipelineNoRawSettle();
    assert.equal(rig.requests.length, 0);
    assert.deepEqual(rig.posted('c1'), []);
  });
});
