import test from 'node:test';
import assert from 'node:assert/strict';
import { deepMerge } from '../../../src/config.ts';
import { labels } from '../../fixtures/labels.ts';
import {
  baseConfig,
  fakeAddressPrompts,
  fakeChannel,
  fakeChannelWithHistory,
  fakeChannelWithMessage,
  fakeFollowUpLlm,
  fakeGuild,
  fakeMemory,
  fakeMessage,
  fakeSpontaneous,
  fakeTurns,
  lineOf,
  makeHandler,
  noticesOf,
  openFollowUpWindow,
  scripted,
  textsOf,
} from '../../fixtures/events-rig.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { freshWorld, seedExisting, useIface, useSelf, world } from '../../fixtures/turn-world.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { table, wrongly } from '../../fixtures/loose-types.ts';
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

test('events: a pending ping whose message no longer exists is dropped with reason gone', async () => {
  let called = false;
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => true,
    runTurn: async () => {
      called = true;
      return { outcome: 'spoke' };
    },
  });
  const handler = makeHandler({ turns, sleep: async () => {}, rng: scripted([0.5]) });

  const guild = fakeGuild();
  // Default fakeChannel: empty cache, fetch resolves null -- the message is gone.
  const channel = fakeChannel('c1', guild);
  await handler(directPingMessage({ guild, channel, placeId: 'c1' }));

  const { logs } = await withCapturedLogs(() => handler.drainPending());

  assert.equal(called, false);
  assert.deepEqual(
    logs.filter((entry) => entry.msg === 'mention: dropped').map(({ channel: id, kind, reason }) => [id, kind, reason]),
    [['c1', 'mention', 'gone']]
  );
  assert.equal(
    logs.some((entry) => entry.msg === 'mention: decided'),
    false,
    'no ignore roll'
  );
});

test('events: a pending ping whose message fetch fails is dropped as fetch-failed; a Discord not-found is gone', async () => {
  for (const [label, breakLookup, reason] of table([
    ['a server error', () => world().failRead('fetchMessages', 'c1'), 'fetch-failed'],
    ['Unknown Message', () => {}, 'gone'],
  ])) {
    freshWorld();
    let called = false;
    const turns = fakeTurns({
      isBusy: () => false,
      isAnyBusy: () => true,
      runTurn: async () => {
        called = true;
        return { outcome: 'spoke' };
      },
    });
    const handler = makeHandler({ turns, sleep: async () => {}, rng: scripted([0.5]) });
    const guild = fakeGuild();
    const channel = fakeChannel('c1', guild);
    await handler(directPingMessage({ guild, channel, placeId: 'c1' }));
    breakLookup();

    const { logs } = await withCapturedLogs(() => handler.drainPending());

    assert.equal(called, false, wrongly(label));
    assert.deepEqual(
      logs
        .filter((entry) => entry.msg === 'mention: dropped')
        .map(({ channel: id, kind, reason: why }) => [id, kind, why]),
      [['c1', 'mention', reason]],
      wrongly(label)
    );
  }
});

/** A plain untagged message in channel c1 from `authorId`. */
function plainFollowUpMessage({
  id,
  guild,
  channel,
  content,
  authorId = 'u2',
  authorName = 'Bob',
  ts = Date.now(),
}: Record<string, Untyped>) {
  return fakeMessage({
    id,
    guild,
    channel,
    placeId: channel.id,
    cleanContent: content,
    createdTimestamp: ts,
    author: { id: authorId, bot: false, globalName: authorName, username: authorName.toLowerCase() },
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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

test('private: a DM refused by a rail posts the limit notice', async () => {
  const channel = fakeDmChannel();
  const turns = recordingTurns(
    wrongly({ outcome: 'refused', limit: { key: 'llm.maxRequestsPerDay', used: 800, cap: 800 } })
  );
  const store = fakePrivateStore();
  const handler = makeDmHandler({ turns, store });
  await handler(fakeDmMessage({ channel }));
  await settle();
  assert.deepEqual(textsOf(handler, channel.id), ['limit reached (llm.maxRequestsPerDay, 800/800)']);
});

// --- Limit notices on triggered guild turns ---------------------------------

function refusedTurns() {
  return recordingTurns(wrongly({ outcome: 'refused', limit: { key: 'llm.maxRequestsPerDay', used: 800, cap: 800 } }));
}

const sendingChannel = (id = 'c1', guild = fakeGuild()) => fakeChannelWithMessage(id, guild, 'm1');

test('limits: a mention refused by a rail posts the notice as a plain reply to the trigger', async () => {
  const turns = refusedTurns();
  const guild = fakeGuild();
  const channel = sendingChannel('c1', guild);
  const handler = makeHandler({ turns, rng: scripted([0.99]), prompts: { labels } });
  await handler(directPingMessage({ guild, channel, placeId: 'c1' }));
  await settle();

  assert.equal(turns.calls.length, 1);
  assert.deepEqual(noticesOf(handler, 'c1'), [lineOf('limit reached (llm.maxRequestsPerDay, 800/800)', 'c1', 'm1')]);
});

test('limits: a pending mention refused at drain time posts the notice', async () => {
  let busy = true;
  const turns = recordingTurns(
    wrongly({ outcome: 'refused', limit: { key: 'llm.maxRequestTokens', used: 51000, cap: 50000 } }),
    { isAnyBusy: () => busy }
  );
  const guild = fakeGuild();
  const channel = sendingChannel('c1', guild);
  const handler = makeHandler({ turns, rng: scripted([0.5, 0.99]), sleep: async () => {}, prompts: { labels } });
  await handler(directPingMessage({ guild, channel, placeId: 'c1' }));
  busy = false;
  await handler.drainPending();

  assert.equal(turns.calls.length, 1);
  assert.deepEqual(textsOf(handler, 'c1'), ['limit reached (llm.maxRequestTokens, 51000/50000)']);
});

test('limits: a refusal with no limit, or another outcome, posts nothing', async () => {
  for (const result of [{ outcome: 'refused', limit: null }, { outcome: 'error' }, { outcome: 'skip' }]) {
    const guild = fakeGuild();
    const channel = sendingChannel('c1', guild);
    const handler = makeHandler({ turns: recordingTurns(result), rng: scripted([0.99]), prompts: { labels } });
    await handler(directPingMessage({ guild, channel, placeId: 'c1' }));
    await settle();
    assert.deepEqual(noticesOf(handler, 'c1'), [], JSON.stringify(result));
  }
});

test('limits: a follow-up turn refused by a rail posts the notice', async () => {
  const llm = fakeFollowUpLlm();
  const turns = refusedTurns();
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  const handler = makeHandler({ turns, llm, prompts: fakeAddressPrompts() });
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const p = handler(
    fakeMessage({ id: 'm-candidate', guild, channel, placeId: 'c1', cleanContent: 'so what do you think' })
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  llm.respond('yes');
  await p;
  await settle();

  assert.equal(turns.calls.length, 1);
  assert.deepEqual(
    noticesOf(handler, 'c1'),
    [lineOf('limit reached (llm.maxRequestsPerDay, 800/800)')],
    'a follow-up never posts as a reply, its notice neither'
  );
});

// ---------------------------------------------------------------------------
// The address classifier's third answer: "overheard", a line about the
// persona said to someone else or to the room (mention.followUpOverheard).

/** Opens a follow-up window in c1 and returns the pieces an overheard test needs. */
async function overheardScene({
  config,
  turns = recordingTurns(),
  tagHistory,
  channelOverrides,
  store,
  now,
}: {
  config?: Untyped;
  turns?: Untyped;
  tagHistory?: Untyped;
  channelOverrides?: Untyped;
  store?: Untyped;
  now?: Untyped;
} = {}) {
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({
    config,
    turns,
    spontaneous,
    tagHistory,
    llm,
    store,
    now,
    prompts: fakeAddressPrompts(),
  });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, [], channelOverrides);
  await openFollowUpWindow(handler, { guild, channel, ts: (now ?? Date.now)() });
  return { llm, spontaneous, handler, guild, channel, turns };
}

test('limits: an overheard turn refused by a rail posts no notice', async () => {
  const { llm, handler, guild, channel, turns } = await overheardScene({ turns: refusedTurns() });

  const p = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'she again' }));
  await tick();
  llm.respond('overheard');
  await p;
  await settle();

  assert.equal(turns.calls.length, 1);
  const firstCall = turns.calls[0];
  assert.equal(firstCall.triggerKind, 'overheard');
  assert.deepEqual(noticesOf(handler, 'c1'), [], 'nobody asked: no limit notice');
});

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['owner1']);
