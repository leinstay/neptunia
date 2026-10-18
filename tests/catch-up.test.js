// Tests for src/behavior/catch-up.js: the messages posted while the bot was down, read once at
// start and handed to the live message handler's catch-up path (src/behavior/pipeline.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createOfflineCatchUp, planChannel } from '../src/behavior/catch-up.js';
import { createMessageHandler } from '../src/behavior/pipeline.js';
import { createTagHistory } from '../src/behavior/mention.js';
import { deepMerge } from '../src/config.js';
import { createDiscordInterface, normalizeOptions, toEvent } from '../src/interface/discord.js';

const DISCORD = createDiscordInterface().capabilities;
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
    overrides,
  );
}

const silentLog = { info() {}, warn() {}, error() {} };

function fakeGuild() {
  return { id: 'g1', members: { me: { displayName: 'Ζωή' } } };
}

function fakeChannel(id, guild) {
  return {
    id,
    guild,
    isThread: () => false,
    viewable: true,
    permissionsFor: () => ({ has: () => true }),
    messages: { cache: new Map(), fetch: async () => null },
  };
}

function fakeMessage({ id, channel, ts, content = 'γεια σου', authorId = 'u1', mention = false }) {
  return {
    id,
    system: false,
    webhookId: null,
    author: { id: authorId, bot: false, globalName: 'Ελένη', username: 'eleni' },
    member: { displayName: 'Ελένη' },
    guild: channel.guild,
    channel,
    channelId: channel.id,
    cleanContent: content,
    content,
    createdTimestamp: ts,
    reference: null,
    mentions: { users: new Map(mention ? [[SELF, { id: SELF }]] : []) },
    attachments: new Map(),
    stickers: new Map(),
  };
}

/** The live handler with fakes around it, and what reached the turn runner and memory. */
function harness({ hot, channels = [{ id: 'c1', lastMessageAt: LAST_SEEN }], paused = false } = {}) {
  const turnsStarted = [];
  const observed = [];
  const store = { state: { data: { paused } }, listChannels: () => channels, getUser: () => null };
  const handler = createMessageHandler({
    hot,
    store,
    client: { user: { id: SELF, username: 'Neptunia' } },
    discord: DISCORD,
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
  const live = (message) => handler(toEvent(message, SELF, normalizeOptions(hot.config)));
  const deliver = (message, options) => handler.catchUp(toEvent(message, SELF, normalizeOptions(hot.config)), options);
  return { handler, live, deliver, store, turnsStarted, observed };
}

function catchUp(h, hot, { fetchRecent, channelInfo, journal = null, log = silentLog } = {}) {
  return createOfflineCatchUp({
    hot,
    store: h.store,
    selfId: () => SELF,
    channelInfo: channelInfo ?? (() => ({ available: true, latestAt: null })),
    fetchRecent,
    deliver: h.deliver,
    journal,
    now: () => NOW,
    log,
  });
}

/** Let the fire-and-forget runTurn promises settle. */
async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

test('planChannel: keeps what came after the last seen message, oldest first, a call only inside the window and before her own post', () => {
  const at = (id, minutesAgo, authorId = 'u1') => ({ id, createdTimestamp: NOW - minutesAgo * MIN, author: { id: authorId } });
  const messages = [at('105', 2), at('101', 40), at('103', 20), at('104', 5, SELF), at('106', 1)];
  const plan = planChannel(messages, { lastSeenAt: LAST_SEEN, nowMs: NOW, windowMs: 15 * MIN, selfId: SELF });
  assert.deepEqual(
    plan.map((item) => [item.message.id, item.trigger]),
    [
      ['103', false], // older than the window
      ['104', false], // her own
      ['105', true],
      ['106', true],
    ],
  );
  const beforeHer = planChannel([at('201', 3), at('202', 2, SELF)], { lastSeenAt: LAST_SEEN, nowMs: NOW, windowMs: 15 * MIN, selfId: SELF });
  assert.equal(beforeHer[0].trigger, false, 'she already posted in the channel after it');
});

test('catch-up: a mention after the last seen message starts one turn; the plain line before it is only observed', async () => {
  const hot = { config: config() };
  const h = harness({ hot });
  const channel = fakeChannel('c1', fakeGuild());
  const seen = fakeMessage({ id: '100', channel, ts: LAST_SEEN - MIN, content: 'παλιό' });
  const plain = fakeMessage({ id: '110', channel, ts: NOW - 3 * MIN, content: 'απλή κουβέντα' });
  const tag = fakeMessage({ id: '120', channel, ts: NOW - 2 * MIN, content: 'δες αυτό', mention: true });
  const fetches = [];
  const result = await catchUp(h, hot, {
    fetchRecent: async (channelId, limit) => {
      fetches.push([channelId, limit]);
      return [tag, plain, seen];
    },
  }).run('g1');
  await settle();

  assert.deepEqual(fetches, [['c1', 50]]);
  assert.deepEqual(h.observed, ['110', '120']);
  assert.equal(h.turnsStarted.length, 1);
  assert.equal(h.turnsStarted[0].trigger.id, '120');
  assert.equal(h.turnsStarted[0].triggerKind, 'mention');
  assert.deepEqual(result.channels, [{ channelId: 'c1', fetched: 2, observed: 1, triggered: 1, duplicate: 0, ignored: 0 }]);
});

test('catch-up: a mention older than the window is observed but starts nothing', async () => {
  const hot = { config: config() };
  const h = harness({ hot });
  const channel = fakeChannel('c1', fakeGuild());
  const stale = fakeMessage({ id: '120', channel, ts: NOW - 20 * MIN, mention: true });
  await catchUp(h, hot, { fetchRecent: async () => [stale] }).run('g1');
  await settle();

  assert.deepEqual(h.observed, ['120']);
  assert.equal(h.turnsStarted.length, 0);
});

test('catch-up: a message the gateway also delivers is answered once, whichever path comes first', async () => {
  const hot = { config: config() };
  const channel = fakeChannel('c1', fakeGuild());

  // The gateway first, then the catch-up's fetch returns it too.
  const first = harness({ hot });
  const tag = fakeMessage({ id: '130', channel, ts: NOW - MIN, mention: true });
  await first.live(tag);
  const result = await catchUp(first, hot, { fetchRecent: async () => [tag] }).run('g1');
  await settle();
  assert.equal(first.turnsStarted.length, 1);
  assert.equal(first.observed.length, 1);
  assert.equal(result.channels[0].duplicate, 1);

  // The catch-up first, then the gateway delivers the same message.
  const second = harness({ hot });
  await catchUp(second, hot, { fetchRecent: async () => [tag] }).run('g1');
  await second.live(tag);
  await settle();
  assert.equal(second.turnsStarted.length, 1);
  assert.equal(second.observed.length, 1);
});

test('catch-up: no channels, a failed fetch, a channel with nothing new and the switch off never block or throw', async () => {
  const hot = { config: config() };
  const channel = fakeChannel('c2', fakeGuild());

  const none = harness({ hot, channels: [] });
  const empty = await catchUp(none, hot, { fetchRecent: async () => assert.fail('nothing to fetch') }).run('g1');
  assert.deepEqual(empty, { channels: [], failed: 0 });

  const warnings = [];
  const log = { ...silentLog, warn: (msg, meta) => warnings.push([msg, meta]) };
  const mixed = harness({
    hot,
    channels: [
      { id: 'c1', lastMessageAt: LAST_SEEN },
      { id: 'c2', lastMessageAt: LAST_SEEN },
      { id: 'c3', lastMessageAt: LAST_SEEN },
    ],
  });
  const result = await catchUp(mixed, hot, {
    log,
    // c3: Discord's last message is the one the bot saw -- not fetched at all.
    channelInfo: (id) => ({ available: true, latestAt: id === 'c3' ? LAST_SEEN : null }),
    fetchRecent: async (channelId) => {
      if (channelId === 'c1') throw Object.assign(new Error('Missing Access'), { code: 50001 });
      if (channelId === 'c3') assert.fail('nothing new in c3');
      return [fakeMessage({ id: '140', channel, ts: NOW - MIN, mention: true })];
    },
  }).run('g1');
  await settle();
  assert.equal(result.failed, 1);
  assert.deepEqual(warnings, [['catch-up: fetch failed', { channelId: 'c1', code: 50001, name: 'Error' }]]);
  assert.equal(mixed.turnsStarted.length, 1, 'the channel after the failed one is still caught up');

  const offHot = { config: config({ features: { offlineCatchUp: false } }) };
  const off = harness({ hot: offHot });
  assert.equal(await catchUp(off, offHot, { fetchRecent: async () => assert.fail('switched off') }).run('g1'), null);

  const paused = harness({ hot, paused: true });
  assert.equal(await catchUp(paused, hot, { fetchRecent: async () => assert.fail('paused') }).run('g1'), null);
});

test('catch-up: the counts per channel reach the journal as one system record', async () => {
  const hot = { config: config({ features: { journal: true } }) };
  const h = harness({ hot });
  const channel = fakeChannel('c1', fakeGuild());
  const records = [];
  await catchUp(h, hot, {
    journal: { system: async (guildId, record) => records.push([guildId, record]) },
    fetchRecent: async () => [fakeMessage({ id: '150', channel, ts: NOW - MIN, mention: true })],
  }).run('g1');
  await settle();
  assert.deepEqual(records, [['g1', { event: 'catch-up', by: 'service', channels: [{ channelId: 'c1', fetched: 1, observed: 0, triggered: 1, duplicate: 0, ignored: 0 }], failed: 0 }]]);
});
