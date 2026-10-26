// Tests for src/behavior/catch-up.js with the live message handler behind it (src/behavior/pipeline.js#catchUpMessage):
// the messages posted while the bot was down are read once at start through the interface and handed to the handler's
// catch-up path. The unit side (which conversations are read, which events are kept, the tally) is tests/catch-up-reads.test.ts;
// here a real handler answers: a mention starts one turn, an older line is only observed, a message the live path also
// delivers is handled once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createOfflineCatchUp } from '../src/behavior/catch-up.js';
import { createMessageHandler } from '../src/behavior/pipeline.js';
import { createTagHistory } from '../src/behavior/mention.js';
import { deepMerge } from '../src/config.js';
import { onWorldIface, useIface, useSelf, world } from './fixtures/turn-world.ts';
import { IFACE, channel, message, rig } from './fixtures/reads-rig.ts';

// The conversations are held by a fake interface named `fake`, where the persona is `self1`.
useIface('fake');
useSelf('self1');
const SHIPPED = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const MIN = 60_000;
const NOW = Date.parse('2026-10-18T12:00:00Z');
const LAST_SEEN = NOW - 30 * MIN;
const SELF = 'self1';

/** The tracked config with the settings these tests rely on set here. */
function config(overrides = {}) {
  return deepMerge(
    deepMerge(structuredClone(SHIPPED), {
      features: { offlineCatchUp: true, journal: false },
      offlineCatchUp: { windowMinutes: 15, maxMessages: 50 },
      mention: { ignoreChance: 0, nameTriggerChance: 1, oneAtATime: true, pendingSameChannel: true },
    }),
    overrides
  );
}

const silentLog = { info() {}, warn() {}, error() {} };

/** The event of a message in `room` that mentions the persona when `mention` is set. */
function eventIn(room, { id, ts, content = 'γεια σου', authorId = 'u1', mention = false }) {
  const event = message(room, id, ts, content, { authorId, authorName: 'Ελένη' });
  if (mention) {
    event.addressing = { ...event.addressing, mentioned: true, mentionedUserIds: [SELF] };
  }
  return event;
}

/** The live handler with fakes around it, and what reached the turn runner and memory. */
function harness({ hot, channels = [{ id: 'c1', lastMessageAt: LAST_SEEN }], paused = false } = {}) {
  // The live handler reads the conversations it meets through the world's own reads.
  for (const { id } of channels) world().channel({ id, name: id });
  const turnsStarted = [];
  const observed = [];
  const store = { state: { data: { paused } }, listChannels: () => channels, getUser: () => null };
  const handler = createMessageHandler({
    hot,
    store,
    reads: world().reads,
    selfId: () => SELF,
    getSelfName: () => 'Ζωή',
    port: world().port,
    turns: {
      notePost() {},
      runTurn: async (args) => {
        turnsStarted.push(args);
        return { outcome: 'spoke' };
      },
      isBusy: () => false,
      isAnyBusy: () => false,
      lastPostAt: () => 0,
    },
    spontaneous: { onMessage: () => assert.fail('the catch-up never eavesdrops') },
    memory: { observe: (guildId, normalized) => observed.push(normalized.id) },
    tagHistory: createTagHistory(),
    getGuildId: () => 'g1',
    rng: () => 0.99,
    now: () => NOW,
  });
  const live = (event) => handler(onWorldIface(event));
  const deliver = (event, options) => handler.catchUp(onWorldIface(event), options);
  return { handler, live, deliver, store, turnsStarted, observed };
}

/** A catch-up over the interface `fake` holding `rooms` (conversation info with its events). */
function catchUp(h, hot, { rooms, journal = null, log = silentLog }) {
  const fake = rig();
  for (const { info, events } of rooms) {
    fake.fake.seedConversation(info);
    for (const event of events) fake.fake.seedEvent(event);
  }
  const service = createOfflineCatchUp({
    hot,
    store: h.store,
    iface: IFACE,
    reads: fake.reads,
    deliver: h.deliver,
    journal,
    now: () => NOW,
    log,
  });
  return { ...service, fake: fake.fake };
}

/** Let the fire-and-forget runTurn promises settle. */
async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

test('catch-up: a mention after the last seen message starts one turn; the plain line before it is only observed', async () => {
  const hot = { config: config() };
  const h = harness({ hot });
  const room = channel('c1', { lastMessageAt: NOW - 2 * MIN });
  const result = await catchUp(h, hot, {
    rooms: [
      {
        info: room,
        events: [
          eventIn(room, { id: '100', ts: LAST_SEEN - MIN, content: 'παλιό' }),
          eventIn(room, { id: '110', ts: NOW - 3 * MIN, content: 'απλή κουβέντα' }),
          eventIn(room, { id: '120', ts: NOW - 2 * MIN, content: 'δες αυτό', mention: true }),
        ],
      },
    ],
  }).run('g1');
  await settle();

  assert.deepEqual(h.observed, ['110', '120']);
  assert.equal(h.turnsStarted.length, 1);
  assert.equal(h.turnsStarted[0].trigger.id, '120');
  assert.equal(h.turnsStarted[0].triggerKind, 'mention');
  assert.deepEqual(result.channels, [
    { channelId: 'c1', fetched: 2, observed: 1, triggered: 1, duplicate: 0, ignored: 0 },
  ]);
});

test('catch-up: a mention older than the window is observed but starts nothing', async () => {
  const hot = { config: config() };
  const h = harness({ hot });
  const room = channel('c1', { lastMessageAt: NOW - 20 * MIN });
  await catchUp(h, hot, {
    rooms: [{ info: room, events: [eventIn(room, { id: '120', ts: NOW - 20 * MIN, mention: true })] }],
  }).run('g1');
  await settle();

  assert.deepEqual(h.observed, ['120']);
  assert.equal(h.turnsStarted.length, 0);
});

test('catch-up: a message the gateway also delivers is answered once, whichever path comes first', async () => {
  const hot = { config: config() };
  const room = channel('c1', { lastMessageAt: NOW - MIN });
  const tag = eventIn(room, { id: '130', ts: NOW - MIN, mention: true });

  // The live path first, then the catch-up's read returns it too.
  const first = harness({ hot });
  await first.live(tag);
  const result = await catchUp(first, hot, { rooms: [{ info: room, events: [tag] }] }).run('g1');
  await settle();
  assert.equal(first.turnsStarted.length, 1);
  assert.equal(first.observed.length, 1);
  assert.equal(result.channels[0].duplicate, 1);

  // The catch-up first, then the live path delivers the same message.
  const second = harness({ hot });
  await catchUp(second, hot, { rooms: [{ info: room, events: [tag] }] }).run('g1');
  await second.live(tag);
  await settle();
  assert.equal(second.turnsStarted.length, 1);
  assert.equal(second.observed.length, 1);
});

test('catch-up: a conversation whose history fails is logged by its id alone, and the next one is still caught up', async () => {
  const hot = { config: config() };
  const warnings = [];
  const log = { ...silentLog, warn: (msg, meta) => warnings.push([msg, meta]) };
  const mixed = harness({
    hot,
    channels: [
      { id: 'c1', lastMessageAt: LAST_SEEN },
      { id: 'c2', lastMessageAt: LAST_SEEN },
    ],
  });
  const one = channel('c1', { lastMessageAt: NOW - MIN });
  const two = channel('c2', { lastMessageAt: NOW - MIN });
  const run = catchUp(mixed, hot, {
    log,
    rooms: [
      { info: one, events: [eventIn(one, { id: '139', ts: NOW - MIN })] },
      { info: two, events: [eventIn(two, { id: '140', ts: NOW - MIN, mention: true })] },
    ],
  });
  // The first read of history (c1's) fails.
  run.fake.failNext('history', { status: 'failed', error: { code: 'down', retryable: true } });
  const result = await run.run('g1');
  await settle();
  assert.equal(result.failed, 1);
  assert.deepEqual(warnings, [['catch-up: fetch failed', { channelId: 'c1' }]]);
  assert.equal(mixed.turnsStarted.length, 1, 'the conversation after the failed one is still caught up');
});

test('catch-up: the counts per channel reach the journal as one system record', async () => {
  const hot = { config: config({ features: { journal: true } }) };
  const h = harness({ hot });
  const room = channel('c1', { lastMessageAt: NOW - MIN });
  const records = [];
  await catchUp(h, hot, {
    journal: { system: async (guildId, record) => records.push([guildId, record]) },
    rooms: [{ info: room, events: [eventIn(room, { id: '150', ts: NOW - MIN, mention: true })] }],
  }).run('g1');
  await settle();
  assert.deepEqual(records, [
    [
      'g1',
      {
        event: 'catch-up',
        by: 'service',
        channels: [{ channelId: 'c1', fetched: 1, observed: 0, triggered: 1, duplicate: 0, ignored: 0 }],
        failed: 0,
      },
    ],
  ]);
});
