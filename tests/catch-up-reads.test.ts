// The offline catch-up (src/behavior/catch-up.js) over the interface's reads: for each conversation the store knows,
// `conversationInfo.lastMessageAt` says whether the platform holds anything newer than the last message the persona saw,
// `history` gives the newest messages as whole `message.received` events, and the ones after the last seen go to the
// message handler's catch-up path as they are, oldest first across conversations, each once. No event is built from a
// platform message: the interface's own events are the input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MessageEvent } from '../src/protocol/adapter.ts';
import { IFACE, SELF_ID, channel, message, rig } from './fixtures/reads-rig.ts';
import { createOfflineCatchUp, planChannel } from '../src/behavior/catch-up.js';

type Delivery = { event: MessageEvent; trigger: boolean };
const MIN = 60_000;
const NOW = Date.parse('2026-10-18T12:00:00Z');
const LAST_SEEN = NOW - 30 * MIN;
const GUILD = 'g1';

function config(extra: object = {}) {
  return {
    features: { offlineCatchUp: true, journal: false },
    offlineCatchUp: { windowMinutes: 15, maxMessages: 50 },
    bot: { dryRunChannelId: '' },
    ...extra,
  };
}

type Setup = {
  settings?: object;
  paused?: boolean;
  channels?: Array<{ id: string; lastMessageAt: number }>;
  outcome?: (event: MessageEvent) => string | Error;
  reads?: ReadonlyArray<string>;
  journal?: { system: (guildId: string, record: object) => Promise<void> } | null;
};

function setup(options: Setup = {}) {
  const world = rig(options.reads === undefined ? {} : { reads: options.reads });
  const delivered: Array<Delivery> = [];
  const catchUp = createOfflineCatchUp({
    hot: { config: config(options.settings) },
    store: {
      state: { data: { paused: options.paused === true } },
      listChannels: () => options.channels ?? [{ id: 'c1', lastMessageAt: LAST_SEEN }],
    },
    iface: IFACE,
    reads: world.reads,
    deliver: (event, { trigger }) => {
      delivered.push({ event, trigger });
      const outcome = options.outcome?.(event) ?? 'observed';
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
    journal: options.journal ?? null,
    now: () => NOW,
    log: { info() {}, warn() {}, error() {} },
  });
  return { ...world, catchUp, delivered };
}

const ids = (items: Array<Delivery>): Array<string> => items.map((item) => item.event.message.id);

test('delivers what came after the last seen message, oldest first across conversations, each once and whole', async () => {
  const { catchUp, delivered, fake } = setup({
    channels: [
      { id: 'c1', lastMessageAt: LAST_SEEN },
      { id: 'c2', lastMessageAt: LAST_SEEN },
    ],
  });
  const one = channel('c1', { lastMessageAt: NOW - 5 * MIN });
  const two = channel('c2', { lastMessageAt: NOW - 10 * MIN });
  fake.seedConversation(one);
  fake.seedConversation(two);
  fake.seedEvent(message(one, 'a-old', NOW - 40 * MIN, 'before the restart'));
  fake.seedEvent(message(one, 'a-2', NOW - 20 * MIN, 'while it was down'));
  fake.seedEvent(message(one, 'a-3', NOW - 5 * MIN, 'later'));
  fake.seedEvent(message(two, 'b-1', NOW - 10 * MIN, 'elsewhere'));
  await catchUp.run(GUILD);
  assert.deepEqual(ids(delivered), ['a-2', 'b-1', 'a-3']);
  assert.equal(delivered[1]?.event.kind, 'message.received');
  assert.equal(delivered[1]?.event.conversation.id, 'c2');
});

test('lets only a message inside the window and after her own post start a turn', async () => {
  const { catchUp, delivered, fake } = setup();
  const room = channel('c1', { lastMessageAt: NOW - 3 * MIN });
  fake.seedConversation(room);
  fake.seedEvent(message(room, 'old', NOW - 25 * MIN, 'too old to answer'));
  fake.seedEvent(message(room, 'before-own', NOW - 12 * MIN, 'asked before she spoke'));
  fake.seedEvent(message(room, 'own', NOW - 10 * MIN, 'her answer', { authorId: SELF_ID }));
  fake.seedEvent(message(room, 'after-own', NOW - 3 * MIN, 'asked after she spoke'));
  await catchUp.run(GUILD);
  assert.deepEqual(
    delivered.map((item) => [item.event.message.id, item.trigger]),
    [
      ['old', false],
      ['before-own', false],
      ['own', false],
      ['after-own', true],
    ]
  );
});

test('reads the newest `offlineCatchUp.maxMessages` messages of a conversation and no more', async () => {
  const { catchUp, fake } = setup({ settings: { offlineCatchUp: { windowMinutes: 15, maxMessages: 7 } } });
  const room = channel('c1', { lastMessageAt: NOW - MIN });
  fake.seedConversation(room);
  fake.seedEvent(message(room, 'm1', NOW - MIN, 'hello'));
  await catchUp.run(GUILD);
  const queries = fake.calls.filter((call) => call.op === 'history').map((call) => call.args[1]);
  assert.deepEqual(queries, [{ limit: 7 }]);
});

test('does not read a conversation whose newest message is no newer than the last seen', async () => {
  const { catchUp, delivered, asked, fake } = setup();
  const room = channel('c1', { lastMessageAt: LAST_SEEN });
  fake.seedConversation(room);
  fake.seedEvent(message(room, 'm1', LAST_SEEN, 'already seen'));
  await catchUp.run(GUILD);
  assert.deepEqual(asked('history'), []);
  assert.deepEqual(delivered, []);
});

test('reads a conversation whose newest time is unknown', async () => {
  const { catchUp, delivered, fake } = setup();
  const room = channel('c1', { lastMessageAt: null });
  fake.seedConversation(room);
  fake.seedEvent(message(room, 'm1', NOW - 5 * MIN, 'hello'));
  await catchUp.run(GUILD);
  assert.deepEqual(ids(delivered), ['m1']);
});

test('leaves a conversation the persona cannot read, and the dry-run mirror, alone', async () => {
  const { catchUp, asked, fake } = setup({
    channels: [
      { id: 'c1', lastMessageAt: LAST_SEEN },
      { id: 'mirror', lastMessageAt: LAST_SEEN },
    ],
    settings: { bot: { dryRunChannelId: 'mirror' } },
  });
  fake.seedConversation(
    channel('c1', {
      lastMessageAt: NOW,
      permissions: { read: false, send: false, attach: false, react: false },
    })
  );
  fake.seedConversation(channel('mirror', { lastMessageAt: NOW }));
  await catchUp.run(GUILD);
  assert.deepEqual(asked('history'), []);
  assert.deepEqual(asked('conversationInfo'), [{ iface: IFACE, conversationId: 'c1' }]);
});

test('finishes with no conversation read when the interface cannot describe conversations', async () => {
  const { catchUp, delivered } = setup({ reads: ['messages.history'] });
  assert.deepEqual(await catchUp.run(GUILD), { channels: [], failed: 0 });
  assert.deepEqual(delivered, []);
});

test('counts a conversation whose history fails and goes on with the next', async () => {
  const { catchUp, delivered, fake } = setup({
    channels: [
      { id: 'c1', lastMessageAt: LAST_SEEN },
      { id: 'c2', lastMessageAt: LAST_SEEN },
    ],
  });
  const one = channel('c1', { lastMessageAt: NOW - MIN });
  const two = channel('c2', { lastMessageAt: NOW - MIN });
  fake.seedConversation(one);
  fake.seedConversation(two);
  fake.seedEvent(message(two, 'b-1', NOW - 2 * MIN, 'hello'));
  fake.failNext('history', { status: 'failed', error: { code: 'down', retryable: true } });
  const result = await catchUp.run(GUILD);
  assert.equal(result?.failed, 1);
  assert.deepEqual(ids(delivered), ['b-1']);
});

test('tallies the outcome of each delivery per conversation, a delivery that throws counting as ignored', async () => {
  const { catchUp, fake } = setup({
    outcome: (event) => (event.message.id === 'm2' ? new Error('handler failed') : 'triggered'),
  });
  const room = channel('c1', { lastMessageAt: NOW - MIN });
  fake.seedConversation(room);
  fake.seedEvent(message(room, 'm1', NOW - 3 * MIN, 'one'));
  fake.seedEvent(message(room, 'm2', NOW - 2 * MIN, 'two'));
  const result = await catchUp.run(GUILD);
  assert.deepEqual(result?.channels, [
    { channelId: 'c1', fetched: 2, observed: 0, triggered: 1, duplicate: 0, ignored: 1 },
  ]);
});

test('does nothing while paused or with the switch off, and reads nothing', async () => {
  const paused = setup({ paused: true });
  assert.equal(await paused.catchUp.run(GUILD), null);
  const off = setup({ settings: { features: { offlineCatchUp: false } } });
  assert.equal(await off.catchUp.run(GUILD), null);
  assert.deepEqual([...paused.fake.calls, ...off.fake.calls], []);
});

test('plans the events after the last seen, oldest first, from their own times and authors', () => {
  const room = channel('c1');
  const events = [
    message(room, 'b', NOW - 20 * MIN, 'second'),
    message(room, 'a', NOW - 40 * MIN, 'before the last seen'),
    message(room, 'c', NOW - 5 * MIN, 'third', { authorId: SELF_ID }),
  ];
  const plan = planChannel(events, { lastSeenAt: LAST_SEEN, nowMs: NOW, windowMs: 15 * MIN });
  assert.deepEqual(
    plan.map((item: { event: MessageEvent; trigger: boolean }) => [item.event.message.id, item.trigger]),
    [
      ['b', false],
      ['c', false],
    ]
  );
});
