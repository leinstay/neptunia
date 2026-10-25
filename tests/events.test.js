import test from 'node:test';
import assert from 'node:assert/strict';

import { createMessageHandler } from '../src/behavior/pipeline.js';
import { createTurnRunner } from '../src/behavior/turn.js';
import { userText } from '../src/behavior/prompt.js';
import { fill } from '../src/format.js';
import { createTagHistory } from '../src/behavior/mention.js';
import { pingStatus } from '../src/behavior/elsewhere.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageReferenceType, PermissionFlagsBits } from 'discord.js';
import { deepMerge } from '../src/config.js';
import { DailyCapError } from '../src/llm/openrouter.js';
import { ROLE_DEFAULTS } from '../src/llm/roles.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { createStore } from '../src/memory/store.js';
import { createDiscordAdapter, createDiscordInterface, normalizeMessage, normalizeOptions, toEvent } from '../src/interface/discord.js';
import { createActivity } from '../src/behavior/activity.js';
import { tempDir } from './fixtures/tmp.js';

/** The Discord functions the pipeline is given, the real ones src/index.js passes. */
const DISCORD = createDiscordInterface().capabilities;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// The tracked defaults only -- never the deployment's config.local.json, so
// the suite passes the same on every machine.
const DEFAULT_CONFIG = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json'), 'utf8'),
);

// The settings the behaviour tests below rely on, pinned here so a tuned default never breaks them.
// DEFAULT_CONFIG stays the raw shipped file for the "code fallback equals config.json" checks.
const PINNED = {
  mention: {
    ignoreChance: 0,
    nameTriggerChance: 1,
    oneAtATime: true,
    pendingMinutes: 10,
    maxPending: 3,
    pendingSameChannel: true,
    switchDelayMs: [2000, 9000],
    followUpMinutes: 15,
    followUpClassifyReplies: true,
    followUpOverheard: true,
    followUpMaxOutputTokens: 8,
    followUpNoStreak: 3,
    followUpAliases: 5,
  },
  memory: { aliasHalfLifeDays: 365 },
  elsewhere: { settleSeconds: 90, settleMaxSeconds: 300 },
  media: { prefillPerMessage: 2, video: { prefillPerMessage: 1 } },
  llm: { helperTimeoutMs: 30000 },
};

function baseConfig(overrides = {}) {
  return deepMerge(deepMerge(structuredClone(DEFAULT_CONFIG), structuredClone(PINNED)), overrides);
}

function fakeGuild(id = 'g1', displayName = 'Ζωή') {
  return { id, members: { me: { displayName } } };
}

function fakeChannel(id, guild, overrides = {}) {
  return {
    id,
    guild,
    isThread: () => false,
    viewable: true,
    permissionsFor: () => ({ has: () => true }),
    messages: { cache: new Map(), fetch: async () => null },
    ...overrides,
  };
}

function fakeMessage(overrides = {}) {
  const guild = 'guild' in overrides ? overrides.guild : fakeGuild();
  const channel = overrides.channel ?? fakeChannel('c1', guild);
  return {
    system: false,
    webhookId: null,
    author: { id: 'u1', bot: false, globalName: 'User', username: 'user' },
    member: { displayName: 'User' },
    guild,
    channel,
    channelId: channel?.id,
    cleanContent: 'hello there',
    createdTimestamp: Date.now(),
    reference: null,
    mentions: { users: new Map() },
    attachments: new Map(),
    stickers: new Map(),
    ...overrides,
  };
}

function fakeClient() {
  return { user: { id: 'self1', username: 'Neptunia' } };
}

function recorder() {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
  };
  fn.calls = calls;
  return fn;
}

function fakeTurns({ runTurn, isBusy, isAnyBusy } = {}) {
  const notePost = recorder();
  return {
    notePost,
    runTurn: runTurn ?? (async () => ({ outcome: 'spoke' })),
    isBusy: isBusy ?? (() => false),
    isAnyBusy: isAnyBusy ?? (() => false),
    lastPostAt: () => 0,
    notePostCalls: notePost.calls,
  };
}

function fakeSpontaneous() {
  const onMessage = recorder();
  return { onMessage, onMessageCalls: onMessage.calls };
}

function fakeMemory({ observe } = {}) {
  const calls = [];
  return {
    observe:
      observe ??
      ((...args) => {
        calls.push(args);
      }),
    observeCalls: calls,
  };
}

function scripted(values) {
  const queue = [...values];
  return () => {
    if (queue.length === 0) throw new Error('scripted rng ran out of values');
    return queue.shift();
  };
}

/** An injectable `now()` whose value can be moved forward with `.set(ms)`. */
function mutableNow(start) {
  let t = start;
  const fn = () => t;
  fn.set = (v) => {
    t = v;
  };
  return fn;
}

/** A fakeChannel whose message `messageId` is already cached -- messageStillExists finds it without a fetch. */
function fakeChannelWithMessage(id, guild, messageId, overrides = {}) {
  return fakeChannel(id, guild, {
    messages: { cache: new Map([[messageId, {}]]), fetch: async () => ({}) },
    ...overrides,
  });
}

function fakeStore(profiles = {}) {
  const calls = [];
  return {
    getUser: (guildId, userId) => {
      calls.push([guildId, userId]);
      return profiles[userId] ?? null;
    },
    getUserCalls: calls,
  };
}

function fakeDescriber() {
  const calls = [];
  return {
    calls,
    describeMany: async (guildId, items) => {
      calls.push({ guildId, items });
      return { descriptions: new Map(), newCount: 0 };
    },
  };
}

function makeHandler({
  config,
  turns,
  spontaneous,
  memory,
  tagHistory,
  rng,
  now,
  sleep,
  client,
  store,
  getGuildId,
  describer,
  prompts,
  llm,
  lookup,
  timers,
  activity,
  record,
  missed,
} = {}) {
  const hot = prompts !== undefined ? { config: config ?? baseConfig(), prompts } : { config: config ?? baseConfig() };
  const discord = client ?? fakeClient();
  const handler = createMessageHandler({
    hot,
    store: store ?? fakeStore(),
    client: discord,
    discord: DISCORD,
    turns: turns ?? fakeTurns(),
    spontaneous: spontaneous ?? fakeSpontaneous(),
    memory: memory ?? fakeMemory(),
    tagHistory: tagHistory ?? createTagHistory(),
    getGuildId: getGuildId ?? (() => 'g1'),
    describer,
    llm,
    lookup,
    rng: rng ?? Math.random,
    now,
    sleep,
    timers,
    activity,
    record,
    missed,
  });
  return asDiscordEvents(handler, hot, discord);
}

/**
 * The handler driven as src/index.js drives it: each fake discord.js message (or update, or
 * deletion) becomes its protocol event (interfaces/discord/collect.js#toEvent) at the moment of the
 * call, with the options read from the live config then.
 */
function asDiscordEvents(handler, hot, client) {
  const options = () => normalizeOptions(hot.config);
  const driven = (message) => handler(toEvent(message, client.user.id, options()));
  driven.onMessageUpdate = (oldMessage, newMessage) => handler.onMessageUpdate(toEvent(newMessage, client.user.id, { ...options(), edit: true, previous: oldMessage }));
  driven.onMessageDelete = (message) => handler.onMessageDelete(toEvent(message, client.user.id, { deleted: true }));
  driven.drainPending = (...args) => handler.drainPending(...args);
  driven.clearPending = (...args) => handler.clearPending(...args);
  driven.stop = (...args) => handler.stop(...args);
  return driven;
}

/** A discord.js attachments Map with one classifiable image entry. */
function pictureAttachments(count = 1) {
  const entries = [];
  for (let i = 1; i <= count; i += 1) {
    entries.push([`a${i}`, { id: `a${i}`, contentType: 'image/png', name: `${i}.png`, url: `https://cdn.discordapp.com/x/${i}.png` }]);
  }
  return new Map(entries);
}

// ---------------------------------------------------------------------------
// The address classifier (features.followUp) -- fixtures.

/** A raw discord.js-shaped message, minimal enough for normalizeMessage / fetchHistory. */
function rawHistoryMessage({ id, authorId = 'u1', authorName = 'Alice', ts, content = 'hi', channelId = 'c1' }) {
  return {
    id,
    channelId,
    author: { id: authorId, bot: false, globalName: authorName, username: authorName },
    member: { displayName: authorName },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    mentions: { users: new Map() },
    attachments: new Map(),
    stickers: new Map(),
  };
}

/** A fakeChannel whose messages.fetch({limit}) serves `historyMessages` (see fetchHistory). */
function fakeChannelWithHistory(id, guild, historyMessages = [], overrides = {}) {
  return fakeChannel(id, guild, {
    messages: {
      cache: new Map(),
      fetch: async (arg) => {
        if (arg && typeof arg === 'object' && 'limit' in arg) {
          return new Map(historyMessages.map((m) => [m.id, m]));
        }
        return null;
      },
    },
    ...overrides,
  });
}

function fakeAddressPrompts() {
  return {
    'system-prompt': 'system',
    'character-card': 'card',
    format: 'format',
    reply: 'Someone called you: {{author}}.',
    interject: 'interject',
    initiate: 'initiate',
    memory: 'memory',
    address: 'You are {{name}}. Is the candidate message addressed to you? Answer yes or no.',
    labels,
  };
}

/** A controllable fake LLM client (src/llm/openrouter.js#createLlm shape): `respond(text)` resolves
 * every currently-queued call, `fail(err)` rejects it instead -- lets a test hold a call open to
 * probe single-flight behaviour before letting it settle. */
function fakeFollowUpLlm() {
  const calls = [];
  let resolvers = [];
  return {
    calls,
    complete: (messages, options) =>
      new Promise((resolve, reject) => {
        calls.push({ messages, options });
        resolvers.push({ resolve, reject });
      }),
    respond(text) {
      const pending = resolvers;
      resolvers = [];
      for (const { resolve } of pending) resolve({ text, usage: {}, estimated: 1 });
    },
    fail(err) {
      const pending = resolvers;
      resolvers = [];
      for (const { reject } of pending) reject(err);
    },
  };
}

/** Sends the persona's own message through the handler, opening/extending the follow-up window. */
async function openFollowUpWindow(handler, { guild, channel, ts }) {
  await handler({
    system: false,
    webhookId: null,
    author: { id: 'self1', bot: true, globalName: 'Neptunia', username: 'neptunia' },
    member: { displayName: 'Neptunia' },
    guild,
    channel,
    channelId: channel.id,
    cleanContent: 'here you go',
    createdTimestamp: ts,
    reference: null,
    mentions: { users: new Map() },
    attachments: new Map(),
    stickers: new Map(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// /nep pause: while paused, nothing here may observe, trigger, run a
// turn or eavesdrop -- a burst of otherwise-triggering messages is a no-op.
test('events: while paused, a burst of messages triggers no observe, no trigger, no turn, no eavesdrop', async () => {
  let runTurnCalls = 0;
  const turns = fakeTurns({ runTurn: async () => { runTurnCalls += 1; return { outcome: 'spoke' }; } });
  const spontaneous = fakeSpontaneous();
  const memory = fakeMemory();
  const store = { state: { data: { paused: true } }, getUser: () => null };
  const handler = makeHandler({ turns, spontaneous, memory, store });

  const guild = fakeGuild();
  const channel = fakeChannel('c1', guild);
  await handler(fakeMessage({ id: 'm1', guild, channel, channelId: 'c1', cleanContent: 'plain chat' }));
  await handler(fakeMessage({
    id: 'm2',
    guild,
    channel,
    channelId: 'c1',
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
  }));
  await handler(fakeMessage({ id: 'm3', guild, channel, channelId: 'c1', author: { id: 'self1', bot: true, globalName: 'Neptunia', username: 'neptunia' } }));

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
  assert.equal(memory.observeCalls[0][0], 'g1');
  assert.equal(memory.observeCalls[0][1].self, true);
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
  assert.equal(store.state.data.followUpWindows, undefined, 'no follow-up window opened');

  // An ordinary message of its own still does both.
  await handler(fakeMessage({ author: { id: 'self1', bot: true, globalName: 'Neptunia', username: 'neptunia' }, cleanContent: 'τι νέα;' }));
  assert.equal(memory.observeCalls.length, 1);
  assert.ok(store.state.data.followUpWindows?.c1, 'window opened by real speech');
});

test('events: another bot is ignored entirely', async () => {
  const turns = fakeTurns();
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ turns, memory, spontaneous });

  const message = fakeMessage({ author: { id: 'otherbot', bot: true, globalName: 'Other', username: 'other' } });
  await handler(message);

  assert.equal(memory.observeCalls.length, 0);
  assert.equal(spontaneous.onMessageCalls.length, 0);
  assert.equal(turns.notePostCalls.length, 0);
});

test('events: a plain message is observed and handed to the spontaneous scheduler, no turn', async () => {
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const turns = fakeTurns();
  const handler = makeHandler({ memory, spontaneous, turns });

  const message = fakeMessage({ cleanContent: 'ένα μήνυμα χωρίς πρόκληση' });
  await handler(message);

  assert.equal(memory.observeCalls.length, 1);
  assert.equal(spontaneous.onMessageCalls.length, 1);
  assert.equal(spontaneous.onMessageCalls[0][0], message.channel);
  assert.equal(spontaneous.onMessageCalls[0][1].content, 'ένα μήνυμα χωρίς πρόκληση');
});

test('events: a mention with rng above ignoreChance runs a reply turn', async () => {
  let seenArgs = null;
  const turns = fakeTurns({
    runTurn: async (args) => {
      seenArgs = args;
      return { outcome: 'spoke' };
    },
  });
  const memory = fakeMemory();
  const handler = makeHandler({ turns, memory, rng: scripted([0.99]) });

  const message = fakeMessage({
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
  });
  await handler(message);
  // let the fire-and-forget runTurn promise settle
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(seenArgs, 'expected runTurn to be called');
  assert.equal(seenArgs.channel, message.channel);
  assert.equal(seenArgs.mode, 'reply');
  assert.equal(seenArgs.triggerKind, 'mention');
  assert.equal(seenArgs.trigger.content, 'γεια');
  assert.equal(memory.observeCalls.length, 1);
});

test('events: a mention with rng below ignoreChance is observed but not answered', async () => {
  let called = false;
  const config = baseConfig({ mention: { ignoreChance: 0.5 } });
  const turns = fakeTurns({ runTurn: async () => { called = true; return { outcome: 'spoke' }; } });
  const memory = fakeMemory();
  const handler = makeHandler({ config, turns, memory, rng: scripted([0.0]) });

  const message = fakeMessage({
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
  });
  await handler(message);
  await Promise.resolve();

  assert.equal(called, false);
  assert.equal(memory.observeCalls.length, 1);
});

test('events: a reply to its own message is detected as kind "reply"', async () => {
  let seenArgs = null;
  const turns = fakeTurns({
    runTurn: async (args) => {
      seenArgs = args;
      return { outcome: 'spoke' };
    },
  });
  const guild = fakeGuild();
  const channel = fakeChannel('c1', guild, {
    messages: { cache: new Map([['m100', { author: { id: 'self1' } }]]), fetch: async () => null },
  });
  const handler = makeHandler({ turns, rng: scripted([0.99]) });

  const message = fakeMessage({
    guild,
    channel,
    channelId: 'c1',
    cleanContent: 'έχεις δίκιο',
    reference: { messageId: 'm100' },
  });
  await handler(message);
  await Promise.resolve();

  assert.ok(seenArgs);
  assert.equal(seenArgs.triggerKind, 'reply');
});

test('events: an untagged reply meets followUpIgnoreChance, a reply with a typed tag meets ignoreChance', async () => {
  // [label, message fields, expected reason]
  const cases = [
    ['no ping', {}, 'ignored:follow-up'],
    ['reply ping only', { content: 'έχεις δίκιο', mentions: { users: new Map([['self1', { id: 'self1' }]]), repliedUser: { id: 'self1' } } }, 'ignored:follow-up'],
    ['typed tag', { content: '<@self1> έχεις δίκιο', mentions: { users: new Map([['self1', { id: 'self1' }]]), repliedUser: { id: 'self1' } } }, 'respond'],
  ];
  for (const [label, extra, reason] of cases) {
    const turns = recordingTurns();
    const config = baseConfig({ mention: { ignoreChance: 0, followUpIgnoreChance: 1 } });
    const guild = fakeGuild();
    const channel = fakeChannel('c1', guild, {
      messages: { cache: new Map([['m100', { author: { id: 'self1' } }]]), fetch: async () => null },
    });
    const handler = makeHandler({ config, turns, rng: () => 0.5 });
    const { logs } = await withCapturedLogs(async () => {
      await handler(fakeMessage({ guild, channel, channelId: 'c1', cleanContent: 'έχεις δίκιο', reference: { messageId: 'm100' }, ...extra }));
      await Promise.resolve();
    });
    const decided = logs.filter((l) => l.msg === 'mention: decided').map((l) => [l.kind, l.reason]);
    assert.deepEqual(decided, [['reply', reason]], label);
    assert.equal(turns.calls.length, reason === 'respond' ? 1 : 0, label);
  }
});

test('events: a name trigger respects config.mention.nameTriggerChance', async () => {
  let calls = 0;
  const config = baseConfig({ bot: { nameTriggers: ['νεπτούνια'] }, mention: { nameTriggerChance: 0.5 } });
  const turnsRespond = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });
  const handlerRespond = makeHandler({ config, turns: turnsRespond, rng: scripted([0.1]) });
  const message1 = fakeMessage({ cleanContent: 'γεια νεπτούνια όμορφη' });
  await handlerRespond(message1);
  await Promise.resolve();
  assert.equal(calls, 1, 'rng below nameTriggerChance should respond');

  const turnsIgnore = fakeTurns({ runTurn: async () => { calls += 1; return { outcome: 'spoke' }; } });
  const handlerIgnore = makeHandler({ config, turns: turnsIgnore, rng: scripted([0.99]) });
  const message2 = fakeMessage({ cleanContent: 'γεια νεπτούνια όμορφη' });
  await handlerIgnore(message2);
  await Promise.resolve();
  assert.equal(calls, 1, 'rng above nameTriggerChance should not respond');
});

test('events: a leftover bot.channels deny key is ignored; the message is observed as anywhere else', async () => {
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const config = baseConfig({ bot: { channels: { allow: ['elsewhere'], deny: ['c1'] } } });
  const handler = makeHandler({ config, memory, spontaneous });

  const message = fakeMessage({ cleanContent: 'just chatting' });
  await handler(message);

  assert.equal(memory.observeCalls.length, 1);
  assert.equal(spontaneous.onMessageCalls.length, 1);
});

test('events: a message from a guild other than the one this instance serves is ignored entirely', async () => {
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const turns = fakeTurns();
  const handler = makeHandler({ memory, spontaneous, turns, getGuildId: () => 'the-served-guild' });

  const message = fakeMessage({ guild: fakeGuild('some-other-guild'), cleanContent: 'just chatting' });
  await handler(message);

  assert.equal(memory.observeCalls.length, 0);
  assert.equal(spontaneous.onMessageCalls.length, 0);
  assert.equal(turns.notePostCalls.length, 0);
});

test('events: a foreign-guild message is ignored even when the instance has not resolved a guild yet', async () => {
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ memory, spontaneous, getGuildId: () => null });

  const message = fakeMessage();
  await handler(message);

  assert.equal(memory.observeCalls.length, 0);
  assert.equal(spontaneous.onMessageCalls.length, 0);
});

test('events: a throwing dependency does not escape the handler', async () => {
  const memory = fakeMemory({
    observe: () => {
      throw new Error('boom');
    },
  });
  const handler = makeHandler({ memory });

  const message = fakeMessage({ cleanContent: 'οτιδήποτε' });
  await assert.doesNotReject(() => handler(message));
});

// ---------------------------------------------------------------------------
// features.* switches — each masks one input of detectTrigger, or short-
// circuits a whole side effect, without detectTrigger itself changing.

test('features.mentions=false: a plain @mention is no longer a trigger', async () => {
  let called = false;
  const spontaneous = fakeSpontaneous();
  const turns = fakeTurns({ runTurn: async () => { called = true; return { outcome: 'spoke' }; } });
  const config = baseConfig({ features: { mentions: false } });
  const handler = makeHandler({ config, turns, spontaneous, rng: scripted([0.99]) });

  const message = fakeMessage({
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
  });
  await handler(message);
  await Promise.resolve();

  assert.equal(called, false);
  assert.equal(spontaneous.onMessageCalls.length, 1);
});

test('features.replies=false: a reply to its own message is no longer a trigger by itself', async () => {
  let called = false;
  const spontaneous = fakeSpontaneous();
  const turns = fakeTurns({ runTurn: async () => { called = true; return { outcome: 'spoke' }; } });
  const guild = fakeGuild();
  const channel = fakeChannel('c1', guild, {
    messages: { cache: new Map([['m100', { author: { id: 'self1' } }]]), fetch: async () => null },
  });
  const config = baseConfig({ features: { replies: false } });
  const handler = makeHandler({ config, turns, spontaneous, rng: scripted([0.99]) });

  const message = fakeMessage({ guild, channel, channelId: 'c1', cleanContent: 'έχεις δίκιο', reference: { messageId: 'm100' } });
  await handler(message);
  await Promise.resolve();

  assert.equal(called, false);
  assert.equal(spontaneous.onMessageCalls.length, 1);
});

test('features.replies=false: a reply that also pings still counts as a mention', async () => {
  let seenArgs = null;
  const turns = fakeTurns({
    runTurn: async (args) => {
      seenArgs = args;
      return { outcome: 'spoke' };
    },
  });
  const guild = fakeGuild();
  const channel = fakeChannel('c1', guild, {
    messages: { cache: new Map([['m100', { author: { id: 'self1' } }]]), fetch: async () => null },
  });
  const config = baseConfig({ features: { replies: false } });
  const handler = makeHandler({ config, turns, rng: scripted([0.99]) });

  const message = fakeMessage({
    guild,
    channel,
    channelId: 'c1',
    cleanContent: 'έχεις δίκιο',
    reference: { messageId: 'm100' },
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
  });
  await handler(message);
  await Promise.resolve();

  assert.ok(seenArgs, 'expected runTurn to be called');
  assert.equal(seenArgs.triggerKind, 'mention');
});

test('features.nameTriggers=false: a name is never a trigger, even when configured', async () => {
  let called = false;
  const spontaneous = fakeSpontaneous();
  const turns = fakeTurns({ runTurn: async () => { called = true; return { outcome: 'spoke' }; } });
  const config = baseConfig({ bot: { nameTriggers: ['νεπτούνια'] }, features: { nameTriggers: false } });
  const handler = makeHandler({ config, turns, spontaneous, rng: scripted([0.1]) });

  const message = fakeMessage({ cleanContent: 'γεια νεπτούνια όμορφη' });
  await handler(message);
  await Promise.resolve();

  assert.equal(called, false);
  assert.equal(spontaneous.onMessageCalls.length, 1);
});

test('features.memory=false: a regular message is never observed', async () => {
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const config = baseConfig({ features: { memory: false } });
  const handler = makeHandler({ config, memory, spontaneous });

  const message = fakeMessage({ cleanContent: 'ένα απλό μήνυμα' });
  await handler(message);

  assert.equal(memory.observeCalls.length, 0);
  assert.equal(spontaneous.onMessageCalls.length, 1);
});

test('features.memory=false: its own message still notes the post, but is never observed', async () => {
  const turns = fakeTurns();
  const memory = fakeMemory();
  const config = baseConfig({ features: { memory: false } });
  const handler = makeHandler({ config, turns, memory });

  const message = fakeMessage({ author: { id: 'self1', bot: true, globalName: 'Bot', username: 'bot' } });
  await handler(message);

  assert.equal(turns.notePostCalls.length, 1);
  assert.equal(memory.observeCalls.length, 0);
});

test('a config with no "features" key at all behaves as if every switch were on', async () => {
  let called = false;
  const config = baseConfig();
  delete config.features;
  const turns = fakeTurns({ runTurn: async () => { called = true; return { outcome: 'spoke' }; } });
  const handler = makeHandler({ config, turns, rng: scripted([0.99]) });

  const message = fakeMessage({
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
  });
  await handler(message);
  await Promise.resolve();

  assert.equal(called, true);
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
  assert.deepEqual(memory.observeCalls[0][2], { direct: true });
});

test('events: a non-triggering message is observed with direct: false', async () => {
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ memory, spontaneous });

  const message = fakeMessage({ cleanContent: 'ένα μήνυμα χωρίς πρόκληση' });
  await handler(message);

  assert.equal(memory.observeCalls.length, 1);
  assert.deepEqual(memory.observeCalls[0][2], { direct: false });
});

test('events: affinityScore is read from the caller\'s stored profile and passed to decideMention', async () => {
  let seenArgs = null;
  const turns = fakeTurns({
    runTurn: async (args) => {
      seenArgs = args;
      return { outcome: 'spoke' };
    },
  });
  const store = fakeStore({ u1: { affinity: { score: -42 } } });
  const handler = makeHandler({ turns, store, rng: scripted([0.99]) });

  const message = fakeMessage({
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
  });
  await handler(message);
  await Promise.resolve();

  assert.ok(seenArgs, 'expected the ignore-chance to allow the turn');
  assert.ok(store.getUserCalls.some(([guildId, userId]) => guildId === 'g1' && userId === 'u1'));
});

test('features.relationships=false: affinityScore is never looked up or passed', async () => {
  const store = fakeStore({ u1: { affinity: { score: -100 } } });
  const config = baseConfig({ features: { relationships: false } });
  const handler = makeHandler({ config, store, rng: scripted([0.99]) });

  const message = fakeMessage({
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
  });
  await handler(message);
  await Promise.resolve();

  assert.equal(store.getUserCalls.length, 0, 'store.getUser must not be called when relationships is off');
});

// ---------------------------------------------------------------------------
// bot.dryRunChannelId: the dry-run mirror channel (src/behavior/turn.js)
// carries the persona's own rehearsal output and is the owner's private test
// room. It goes back to being ignored entirely: nothing there is observed or
// triggers anything.

test('events: any message in the dry-run mirror channel is ignored entirely', async () => {
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const turns = fakeTurns();
  const config = baseConfig({ bot: { dryRunChannelId: 'mirror1' } });
  const channel = fakeChannel('mirror1', fakeGuild());
  const handler = makeHandler({ config, memory, spontaneous, turns });

  const message = fakeMessage({ channel, channelId: 'mirror1', cleanContent: 'just chatting, no command' });
  await handler(message);

  assert.equal(memory.observeCalls.length, 0);
  assert.equal(spontaneous.onMessageCalls.length, 0);
  assert.equal(turns.notePostCalls.length, 0);
});

test("events: the persona's own messages mirrored into the dry-run channel are never observed", async () => {
  const memory = fakeMemory();
  const turns = fakeTurns();
  const config = baseConfig({ bot: { dryRunChannelId: 'mirror1' } });
  const channel = fakeChannel('mirror1', fakeGuild());
  const handler = makeHandler({ config, memory, turns });

  const message = fakeMessage({
    channel,
    channelId: 'mirror1',
    author: { id: 'self1', bot: true, globalName: 'Bot', username: 'bot' },
  });
  await handler(message);

  assert.equal(memory.observeCalls.length, 0);
  assert.equal(turns.notePostCalls.length, 0);
});

// ---------------------------------------------------------------------------
// features.mediaDescriptions: fire-and-forget describer pre-fetch from the
// message path (src/memory/describe.js's cache), so the live memory analyzer
// (src/memory/update.js#analyze) finds a caption already cached.

// features.videoDescriptions + media.video.prefill: a posted video is watched
// fire-and-forget, at most one per message.

function fakeVideoDescriber() {
  const base = fakeDescriber();
  const videoCalls = [];
  return {
    ...base,
    videoCalls,
    describeVideos: async (guildId, items) => {
      videoCalls.push({ guildId, items });
      return { videos: new Map(), newCount: 0 };
    },
  };
}

/** A discord.js attachments Map with `count` video entries. */
function videoAttachments(count = 1) {
  const entries = [];
  for (let i = 1; i <= count; i += 1) {
    entries.push([`v${i}`, { id: `v${i}`, contentType: 'video/mp4', name: `${i}.mp4`, url: `https://cdn.discordapp.com/x/${i}.mp4`, duration: 10 }]);
  }
  return new Map(entries);
}

test('events: media.video.prefill on watches one video per message, fire-and-forget', async () => {
  const describer = fakeVideoDescriber();
  const config = baseConfig({ features: { videoDescriptions: true }, media: { video: { prefill: true } } });
  const handler = makeHandler({ config, describer });

  await handler(fakeMessage({ cleanContent: 'look', attachments: videoAttachments(2) }));

  assert.equal(describer.videoCalls.length, 1);
  assert.equal(describer.videoCalls[0].guildId, 'g1');
  assert.deepEqual(
    describer.videoCalls[0].items.map((item) => item.itemId),
    ['v1'],
  );
});

test('events: a typed video-site link is prefilled too (normalizeMessage got media.video.sites)', async () => {
  const describer = fakeVideoDescriber();
  const config = baseConfig({ features: { videoDescriptions: true }, media: { video: { prefill: true, sites: ['youtube.com'] } } });
  const handler = makeHandler({ config, describer });

  await handler(fakeMessage({ cleanContent: 'regarde https://www.youtube.com/watch?v=abc' }));

  assert.equal(describer.videoCalls.length, 1);
  assert.equal(describer.videoCalls[0].items[0].source, 'link');
});

test('events: no video prefill when media.video.prefill is off, videoDescriptions is off or mediaDescriptions is off', async () => {
  for (const overrides of [
    { features: { videoDescriptions: true }, media: { video: { prefill: false } } },
    { features: { videoDescriptions: false }, media: { video: { prefill: true } } },
    { features: { mediaDescriptions: false, videoDescriptions: true }, media: { video: { prefill: true } } },
  ]) {
    const describer = fakeVideoDescriber();
    const handler = makeHandler({ config: baseConfig(overrides), describer });

    await handler(fakeMessage({ cleanContent: 'look', attachments: videoAttachments(1) }));

    assert.equal(describer.videoCalls.length, 0);
  }
});

test('events: features.mediaDescriptions off makes zero describer calls from the message path', async () => {
  const describer = fakeDescriber();
  const config = baseConfig({ features: { mediaDescriptions: false } });
  const handler = makeHandler({ config, describer });

  const message = fakeMessage({ cleanContent: 'look at this', attachments: pictureAttachments(1) });
  await handler(message);

  assert.equal(describer.calls.length, 0);
});

test('events: features.mediaDescriptions on fires a fire-and-forget describer call for an observed human message\'s pictures', async () => {
  const describer = fakeDescriber();
  const config = baseConfig({ features: { mediaDescriptions: true } });
  const handler = makeHandler({ config, describer });

  const message = fakeMessage({ cleanContent: 'look at this', attachments: pictureAttachments(1) });
  await handler(message);

  assert.equal(describer.calls.length, 1);
  assert.equal(describer.calls[0].items[0].itemId, 'a1');
});

test('events: media.prefillPerMessage caps the pictures handed to the describer, read per message; a missing key falls back to the config.json value', async () => {
  const describer = fakeDescriber();
  const config = baseConfig({ features: { mediaDescriptions: true }, media: { prefillPerMessage: 3 } });
  const handler = makeHandler({ config, describer });
  await handler(fakeMessage({ cleanContent: 'lots of pics', attachments: pictureAttachments(4) }));
  assert.deepEqual(describer.calls[0].items.map((item) => item.itemId), ['a1', 'a2', 'a3']);

  config.media.prefillPerMessage = 0; // a live edit: no picture prefill at all
  await handler(fakeMessage({ cleanContent: 'lots of pics', attachments: pictureAttachments(4) }));
  assert.equal(describer.calls.length, 1);

  delete config.media.prefillPerMessage;
  await handler(fakeMessage({ cleanContent: 'lots of pics', attachments: pictureAttachments(DEFAULT_CONFIG.media.prefillPerMessage + 1) }));
  assert.equal(describer.calls.length, 2);
  assert.equal(describer.calls[1].items.length, DEFAULT_CONFIG.media.prefillPerMessage);
});

test('events: media.video.prefillPerMessage caps the videos watched ahead per message; a missing key falls back to the config.json value', async () => {
  const describer = fakeVideoDescriber();
  const config = baseConfig({ features: { videoDescriptions: true }, media: { video: { prefill: true, prefillPerMessage: 2 } } });
  const handler = makeHandler({ config, describer });
  await handler(fakeMessage({ cleanContent: 'look', attachments: videoAttachments(3) }));
  assert.deepEqual(describer.videoCalls[0].items.map((item) => item.itemId), ['v1', 'v2']);

  config.media.video.prefillPerMessage = 0; // a live edit: no video prefill at all
  await handler(fakeMessage({ cleanContent: 'look', attachments: videoAttachments(3) }));
  assert.equal(describer.videoCalls.length, 1);

  delete config.media.video.prefillPerMessage;
  await handler(fakeMessage({ cleanContent: 'look', attachments: videoAttachments(DEFAULT_CONFIG.media.video.prefillPerMessage + 1) }));
  assert.equal(describer.videoCalls.length, 2);
  assert.equal(describer.videoCalls[1].items.length, DEFAULT_CONFIG.media.video.prefillPerMessage);
});

test('events: a picture-format sticker warms the describer cache too', async () => {
  const describer = fakeDescriber();
  const config = baseConfig({ features: { mediaDescriptions: true } });
  const handler = makeHandler({ config, describer });

  const message = fakeMessage({ stickers: new Map([['s1', { id: 's1', name: 'pepe', format: 1 }]]) });
  await handler(message);

  assert.equal(describer.calls.length, 1);
  assert.equal(describer.calls[0].items[0].itemId, 'sticker:s1');
});

test('events: a custom emoji in the text warms the describer cache too', async () => {
  const describer = fakeDescriber();
  const config = baseConfig({ features: { mediaDescriptions: true } });
  const handler = makeHandler({ config, describer });

  const message = fakeMessage({ cleanContent: 'nice <:pog:111>' });
  await handler(message);

  assert.equal(describer.calls.length, 1);
  assert.equal(describer.calls[0].items[0].itemId, 'emoji:111');
});

test('events: pictures come before a message\'s emoji within the shared 2-per-message cap', async () => {
  const describer = fakeDescriber();
  const config = baseConfig({ features: { mediaDescriptions: true } });
  const handler = makeHandler({ config, describer });

  const message = fakeMessage({
    cleanContent: 'look <:pog:111>',
    attachments: pictureAttachments(1),
    stickers: new Map([['s1', { id: 's1', name: 'pepe', format: 1 }]]),
  });
  await handler(message);

  assert.equal(describer.calls.length, 1);
  assert.deepEqual(
    describer.calls[0].items.map((i) => i.itemId),
    ['a1', 'sticker:s1'],
    'the attachment and the sticker (both pictures) fill the cap before the emoji is ever considered',
  );
});

test('events: the dry-run mirror channel never triggers a describer call, even with a picture', async () => {
  const describer = fakeDescriber();
  const config = baseConfig({ features: { mediaDescriptions: true }, bot: { dryRunChannelId: 'mirror1' } });
  const channel = fakeChannel('mirror1', fakeGuild());
  const handler = makeHandler({ config, describer });

  const message = fakeMessage({ channel, channelId: 'mirror1', cleanContent: 'look', attachments: pictureAttachments(1) });
  await handler(message);

  assert.equal(describer.calls.length, 0);
});

test('events: the persona\'s own message never triggers a describer call', async () => {
  const describer = fakeDescriber();
  const config = baseConfig({ features: { mediaDescriptions: true } });
  const handler = makeHandler({ config, describer });

  const message = fakeMessage({
    author: { id: 'self1', bot: true, globalName: 'Neptunia', username: 'neptunia' },
    attachments: pictureAttachments(1),
  });
  await handler(message);

  assert.equal(describer.calls.length, 0);
});

// ---------------------------------------------------------------------------
// One attention (mention.oneAtATime) -- a direct ping (mention/reply)
// that arrives while a turn is running elsewhere is remembered as pending
// instead of dropped; drainPending() (called in production once a turn
// frees its channel, see src/behavior/turn.js's setOnIdle) answers the
// oldest one through the normal reply path after a human switch pause.

function directPingMessage(overrides = {}) {
  return fakeMessage({
    id: 'm1',
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
    ...overrides,
  });
}

test('events: a direct ping elsewhere becomes pending and is answered after the running turn plus the switch pause', async () => {
  let seenArgs = null;
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => true,
    runTurn: async (args) => {
      seenArgs = args;
      return { outcome: 'spoke' };
    },
  });
  const sleepCalls = [];
  const sleep = async (ms) => {
    sleepCalls.push(ms);
  };
  const handler = makeHandler({ turns, sleep, rng: scripted([0.5, 0.99]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  const message = directPingMessage({ guild, channel, channelId: 'c1' });
  await handler(message);

  assert.equal(seenArgs, null, 'must not run immediately while busy elsewhere');

  await handler.drainPending();

  assert.ok(seenArgs, 'expected the deferred turn to run once drained');
  assert.equal(seenArgs.channel, channel);
  assert.equal(seenArgs.mode, 'reply');
  assert.equal(seenArgs.triggerKind, 'mention');
  assert.equal(seenArgs.trigger.content, 'γεια');
  assert.deepEqual(sleepCalls, [5500], 'between(switchDelayMs=[2000,9000], rng=0.5) -- the human switch pause');
});

for (const [roll, answered] of [[0.2, true], [0.7, false]]) {
  test(`events: a name call elsewhere while busy is held under mention.oneAtATime and rolled when drained (roll ${roll})`, async () => {
    const calls = [];
    const turns = fakeTurns({
      isBusy: () => false,
      isAnyBusy: () => true,
      runTurn: async (args) => {
        calls.push(args);
        return { outcome: 'spoke' };
      },
    });
    const tagHistory = countingTagHistory();
    const config = baseConfig({ bot: { nameTriggers: ['νεπτούνια'] }, mention: { nameTriggerChance: 0.5 } });
    // Exactly two values: the switch pause and the name-trigger roll at drain time -- none on arrival.
    const handler = makeHandler({ config, turns, tagHistory, sleep: async () => {}, rng: scripted([0.5, roll]) });

    const guild = fakeGuild();
    const channel = fakeChannelWithMessage('c1', guild, 'm1');
    const { logs } = await withCapturedLogs(async () => {
      await handler(fakeMessage({ id: 'm1', guild, channel, channelId: 'c1', cleanContent: 'γεια νεπτούνια όμορφη' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(calls.length, 0, 'not run while the attention is taken');
    assert.equal(tagHistory.hits, 0, 'counted at drain time, not on arrival');
    assert.equal(logs.some((entry) => entry.msg === 'mention: decided'), false, 'not rolled on arrival');
    assert.equal(logs.some((entry) => entry.msg === 'mention: dropped'), false, 'nothing dropped');
    const deferred = logs.filter((entry) => entry.msg === 'mention: deferred');
    assert.deepEqual(deferred.map(({ channel: id, kind, sameChannel }) => [id, kind, sameChannel]), [['c1', 'name', false]]);

    const drained = await withCapturedLogs(() => handler.drainPending());
    const decided = drained.logs.filter((entry) => entry.msg === 'mention: decided');
    assert.deepEqual(
      decided.map(({ kind, reason, deferred: held }) => [kind, reason, held]),
      [['name', answered ? 'name' : 'name-unnoticed', true]],
    );
    assert.equal(tagHistory.hits, 1);
    assert.equal(calls.length, answered ? 1 : 0);
    if (answered) {
      assert.equal(calls[0].channel, channel);
      assert.equal(calls[0].trigger.id, 'm1');
      assert.equal(calls[0].triggerKind, 'name');
    }
  });
}

/**
 * Turns whose channel `c1` is busy until `.finish()`: runTurn answers 'busy' while it is, records
 * every call, and `spokeAfterSeeing` reports the ids passed in `seen`.
 */
function busyChannelTurns({ seen = [] } = {}) {
  let busy = true;
  const calls = [];
  const turns = fakeTurns({
    isBusy: (id) => busy && id === 'c1',
    isAnyBusy: () => busy,
    runTurn: async (args) => {
      calls.push(args);
      return { outcome: busy && args.channel.id === 'c1' ? 'busy' : 'spoke' };
    },
  });
  turns.spokeAfterSeeing = (channelId, messageId) => channelId === 'c1' && seen.includes(messageId);
  turns.calls = calls;
  turns.finish = () => {
    busy = false;
  };
  return turns;
}

/** tagHistory that counts its hits, to prove a deferred ping is not counted on arrival. */
function countingTagHistory() {
  const inner = createTagHistory();
  const tags = { hits: 0, hit: (...args) => ((tags.hits += 1), inner.hit(...args)) };
  return tags;
}

for (const oneAtATime of [true, false]) {
  test(`events: a mention in the channel whose turn is running is deferred, answered after it (oneAtATime=${oneAtATime})`, async () => {
    const turns = busyChannelTurns();
    const tagHistory = countingTagHistory();
    const config = baseConfig({ mention: { oneAtATime } });
    // Exactly two values: the switch pause and decideMention at drain time -- none on arrival.
    const handler = makeHandler({ config, turns, tagHistory, sleep: async () => {}, rng: scripted([0.5, 0.99]) });

    const guild = fakeGuild();
    const channel = fakeChannelWithMessage('c1', guild, 'm1');
    const { logs } = await withCapturedLogs(() => handler(directPingMessage({ guild, channel, channelId: 'c1' })));

    assert.equal(turns.calls.length, 0, 'not run against the busy channel');
    assert.equal(tagHistory.hits, 0, 'counted at drain time, not on arrival');
    const deferred = logs.find((entry) => entry.msg === 'mention: deferred');
    assert.ok(deferred, 'logged as deferred');
    assert.equal(deferred.sameChannel, true);

    turns.finish();
    await handler.drainPending();

    assert.equal(turns.calls.length, 1);
    assert.equal(turns.calls[0].channel, channel);
    assert.equal(turns.calls[0].trigger.id, 'm1');
    assert.equal(turns.calls[0].triggerKind, 'mention');
    assert.equal(tagHistory.hits, 1);
  });
}

test('events: a reply to the persona in the channel whose turn is running is deferred and answered after it', async () => {
  const turns = busyChannelTurns();
  const handler = makeHandler({ turns, sleep: async () => {}, rng: scripted([0.5, 0.99]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  channel.messages.cache.set('m0', { author: { id: 'self1' } });
  await handler(fakeMessage({ id: 'm1', guild, channel, channelId: 'c1', cleanContent: 'γεια', reference: { messageId: 'm0' } }));
  assert.equal(turns.calls.length, 0);

  turns.finish();
  await handler.drainPending();

  assert.equal(turns.calls.length, 1);
  assert.equal(turns.calls[0].trigger.id, 'm1');
  assert.equal(turns.calls[0].triggerKind, 'reply');
});

test('events: a name trigger in the channel whose turn is running is deferred and answered after it', async () => {
  const turns = busyChannelTurns();
  const tagHistory = countingTagHistory();
  const config = baseConfig({ bot: { nameTriggers: ['νεπτούνια'] } });
  // Exactly two values: the switch pause and the name-trigger roll at drain time -- none on arrival.
  const handler = makeHandler({ config, turns, tagHistory, sleep: async () => {}, rng: scripted([0.5, 0.2]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  const { logs } = await withCapturedLogs(async () => {
    await handler(fakeMessage({ id: 'm1', guild, channel, channelId: 'c1', cleanContent: 'γεια νεπτούνια' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(turns.calls.length, 0, 'not run against the busy channel');
  assert.equal(tagHistory.hits, 0, 'counted at drain time, not on arrival');
  assert.equal(logs.some((entry) => entry.msg === 'mention: decided'), false, 'not rolled on arrival');
  assert.equal(logs.some((entry) => entry.msg === 'mention: dropped'), false, 'nothing dropped');
  const deferred = logs.filter((entry) => entry.msg === 'mention: deferred');
  assert.deepEqual(deferred.map(({ channel: id, kind, sameChannel }) => [id, kind, sameChannel]), [['c1', 'name', true]]);

  turns.finish();
  const drained = await withCapturedLogs(() => handler.drainPending());

  assert.equal(turns.calls.length, 1);
  assert.equal(turns.calls[0].channel, channel);
  assert.equal(turns.calls[0].trigger.id, 'm1');
  assert.equal(turns.calls[0].triggerKind, 'name');
  assert.equal(tagHistory.hits, 1);
  const decided = drained.logs.filter((entry) => entry.msg === 'mention: decided');
  assert.deepEqual(decided.map(({ kind, reason, deferred: held }) => [kind, reason, held]), [['name', 'name', true]]);
});

test('events: mention.pendingSameChannel=false restores the busy drop for a same-channel mention, read hot', async () => {
  const turns = busyChannelTurns();
  const tagHistory = countingTagHistory();
  const config = baseConfig({ mention: { pendingSameChannel: false } });
  // No rng value: the busy drop comes before decideMention; the drain must find nothing.
  const handler = makeHandler({ config, turns, tagHistory, sleep: async () => {}, rng: scripted([]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  const { logs } = await withCapturedLogs(async () => {
    await handler(directPingMessage({ guild, channel, channelId: 'c1' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(turns.calls.length, 0, 'dropped before it is decided: no turn is asked for');
  assert.equal(tagHistory.hits, 0, 'not counted');
  assert.equal(logs.some((entry) => entry.msg === 'mention: decided'), false, 'no ignore roll');
  assert.ok(logs.some((entry) => entry.msg === 'mention: dropped' && entry.reason === 'busy' && entry.kind === 'mention'));

  turns.finish();
  await handler.drainPending();
  assert.equal(turns.calls.length, 0, 'nothing was queued');
});

test('events: mention.pendingSameChannel=false drops a same-channel name call like a mention', async () => {
  const turns = busyChannelTurns();
  const tagHistory = countingTagHistory();
  const config = baseConfig({ bot: { nameTriggers: ['νεπτούνια'] }, mention: { pendingSameChannel: false } });
  // No rng value: the busy drop comes before the name-trigger roll; the drain must find nothing.
  const handler = makeHandler({ config, turns, tagHistory, sleep: async () => {}, rng: scripted([]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  const { logs } = await withCapturedLogs(async () => {
    await handler(fakeMessage({ id: 'm1', guild, channel, channelId: 'c1', cleanContent: 'γεια νεπτούνια' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(turns.calls.length, 0, 'dropped before it is decided: no turn is asked for');
  assert.equal(tagHistory.hits, 0, 'not counted');
  assert.equal(logs.some((entry) => entry.msg === 'mention: decided'), false, 'no roll');
  assert.equal(logs.some((entry) => entry.msg === 'mention: deferred'), false, 'not held');
  assert.deepEqual(
    logs.filter((entry) => entry.msg === 'mention: dropped').map(({ channel: id, kind, reason }) => [id, kind, reason]),
    [['c1', 'name', 'busy']],
  );

  turns.finish();
  await handler.drainPending();
  assert.equal(turns.calls.length, 0, 'nothing was queued');
});

test('events: a deferred ping the last speaking turn already had in view is not answered again', async () => {
  const turns = busyChannelTurns({ seen: ['m1'] });
  const handler = makeHandler({ turns, sleep: async () => {}, rng: scripted([0.5]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));

  turns.finish();
  const { logs } = await withCapturedLogs(() => handler.drainPending());

  assert.equal(turns.calls.length, 0, 'the running turn already answered it');
  assert.ok(logs.some((entry) => entry.msg === 'mention: already answered' && entry.channel === 'c1'));
});

test('events: a newer direct ping in the same channel waits beside the older one; both are answered in arrival order', async () => {
  const seen = [];
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => true,
    runTurn: async (args) => {
      seen.push(args.trigger.content);
      return { outcome: 'spoke' };
    },
  });
  const handler = makeHandler({ turns, sleep: async () => {}, rng: scripted([0.5, 0.99, 0.5, 0.99]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm2');
  channel.messages.cache.set('m1', {});

  await handler(directPingMessage({ id: 'm1', guild, channel, channelId: 'c1', cleanContent: 'first' }));
  await handler(directPingMessage({ id: 'm2', guild, channel, channelId: 'c1', cleanContent: 'second' }));
  await new Promise((resolve) => setImmediate(resolve));

  await handler.drainPending();

  assert.deepEqual(seen, ['first', 'second'], 'no call takes another one\'s place');
});

test('events: mention.maxPending caps distinct pending channels, dropping the oldest', async () => {
  const config = baseConfig({ mention: { maxPending: 2 } });
  const answeredChannels = [];
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => true,
    runTurn: async (args) => {
      answeredChannels.push(args.channel.id);
      return { outcome: 'spoke' };
    },
  });
  const handler = makeHandler({ config, turns, sleep: async () => {}, rng: scripted([0.5, 0.99, 0.5, 0.99]) });

  const guild = fakeGuild();
  for (const id of ['c1', 'c2', 'c3']) {
    const channel = fakeChannelWithMessage(id, guild, `m-${id}`);
    await handler(directPingMessage({ id: `m-${id}`, guild, channel, channelId: id, cleanContent: id }));
  }

  await handler.drainPending();

  assert.deepEqual(answeredChannels.sort(), ['c2', 'c3'], 'c1 (the oldest) was evicted once maxPending=2 was exceeded');
});

test('events: a call evicted from a full pending queue is a pending-full missed fact with its message', async () => {
  const missed = recordingMissed();
  const config = baseConfig({ mention: { maxPending: 2 } });
  const turns = fakeTurns({ isBusy: () => false, isAnyBusy: () => true, runTurn: async () => ({ outcome: 'spoke' }) });
  const handler = makeHandler({ config, turns, sleep: async () => {}, rng: scripted([0.5, 0.99, 0.5, 0.99]), missed });
  const guild = fakeGuild();
  for (const id of ['c1', 'c2', 'c3']) {
    const channel = fakeChannelWithMessage(id, guild, `m-${id}`);
    await handler(directPingMessage({ id: `m-${id}`, guild, channel, channelId: id, cleanContent: id }));
  }
  assert.deepEqual(missed.facts.map((fact) => [fact.reason, fact.message.id, fact.message.channelId]), [['pending-full', 'm-c1', 'c1']]);
});

test('events: a call that waited past mention.pendingMinutes is a pending-expired missed fact', async () => {
  const missed = recordingMissed();
  const config = baseConfig();
  const turns = fakeTurns({ isBusy: () => false, isAnyBusy: () => true, runTurn: async () => ({ outcome: 'spoke' }) });
  const clock = mutableNow(0);
  const handler = makeHandler({ config, turns, sleep: async () => {}, now: clock, rng: scripted([]), missed });
  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));
  clock.set(config.mention.pendingMinutes * 60_000 + 1);
  await handler.drainPending();
  assert.deepEqual(missed.facts.map((fact) => [fact.reason, fact.message.id]), [['pending-expired', 'm1']]);
});

// /nep pause: clearPending() drops every queued ping without answering any of them.
test('events: clearPending empties the pending queue -- drainPending afterwards answers nothing', async () => {
  let called = false;
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => true,
    runTurn: async () => {
      called = true;
      return { outcome: 'spoke' };
    },
  });
  const handler = makeHandler({ turns, sleep: async () => {}, rng: scripted([]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  await handler(directPingMessage({ id: 'm1', guild, channel, channelId: 'c1' }));

  handler.clearPending();
  await handler.drainPending();

  assert.equal(called, false, 'the cleared ping must never be answered');
});

test('events: the ignore decision is rolled at pick-up time, not when the ping arrived', async () => {
  let respondedArgs = null;
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => true,
    runTurn: async (args) => {
      respondedArgs = args;
      return { outcome: 'spoke' };
    },
  });
  // Exactly one value for the switch-delay sample, one for decideMention -- if
  // arrival wrongly rolled decideMention too, this queue would run out and throw.
  const config = baseConfig({ mention: { ignoreChance: 0.5 } });
  const handler = makeHandler({ config, turns, sleep: async () => {}, rng: scripted([0.5, 0]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  await assert.doesNotReject(() => handler(directPingMessage({ guild, channel, channelId: 'c1' })));

  await handler.drainPending();

  assert.equal(respondedArgs, null, 'rng=0 at pick-up time is below the configured ignoreChance (0.5): ignored');
});

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
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));

  const { logs } = await withCapturedLogs(() => handler.drainPending());

  assert.equal(called, false);
  assert.deepEqual(
    logs.filter((entry) => entry.msg === 'mention: dropped').map(({ channel: id, kind, reason }) => [id, kind, reason]),
    [['c1', 'mention', 'gone']],
  );
  assert.equal(logs.some((entry) => entry.msg === 'mention: decided'), false, 'no ignore roll');
});

test('events: a pending ping whose message fetch fails is dropped as fetch-failed; a Discord not-found is gone', async () => {
  for (const [label, error, reason] of [
    ['a server error', Object.assign(new Error('Service Unavailable'), { status: 503 }), 'fetch-failed'],
    ['Unknown Message', Object.assign(new Error('Unknown Message'), { status: 404, code: 10008 }), 'gone'],
  ]) {
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
    const channel = fakeChannel('c1', guild, {
      messages: {
        cache: new Map(),
        fetch: async () => {
          throw error;
        },
      },
    });
    await handler(directPingMessage({ guild, channel, channelId: 'c1' }));

    const { logs } = await withCapturedLogs(() => handler.drainPending());

    assert.equal(called, false, label);
    assert.deepEqual(
      logs.filter((entry) => entry.msg === 'mention: dropped').map(({ channel: id, kind, reason: why }) => [id, kind, why]),
      [['c1', 'mention', reason]],
      label,
    );
  }
});

for (const { kind, extra } of [
  { kind: 'mention', extra: {} },
  { kind: 'reply', extra: { mentions: { users: new Map() }, reference: { messageId: 'm0' } } },
  { kind: 'name', extra: { mentions: { users: new Map() }, cleanContent: 'γεια νεπτούνια' } },
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
    channel.messages.cache.set('m0', { author: { id: 'self1' } });
    const { logs } = await withCapturedLogs(async () => {
      await handler(directPingMessage({ guild, channel, channelId: 'c1', ...extra }));
      await handler.drainPending();
    });

    assert.equal(called, false, 'no turn starts');
    const dropped = logs.filter((entry) => entry.msg === 'mention: dropped');
    assert.equal(dropped.length, 1, 'logged exactly once');
    assert.equal(dropped[0].channel, 'c1');
    assert.equal(dropped[0].kind, kind);
    assert.equal(dropped[0].reason, 'cannot-send');
    assert.equal(logs.some((entry) => entry.msg === 'mention: deferred'), false, 'no pending entry');
    assert.equal(logs.some((entry) => entry.msg === 'mention: decided'), false, 'no ignore roll');
  });
}

test('events: a pending ping whose channel lost send permission is dropped with a cannot-send log line', async () => {
  let called = false;
  let canSendNow = true;
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
  const channel = fakeChannelWithMessage('c1', guild, 'm1', { permissionsFor: () => ({ has: () => canSendNow }) });
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));

  canSendNow = false; // permission lost while the ping was pending
  const { logs } = await withCapturedLogs(() => handler.drainPending());

  assert.equal(called, false);
  const dropped = logs.filter((entry) => entry.msg === 'mention: dropped');
  assert.equal(dropped.length, 1, 'logged exactly once');
  assert.equal(dropped[0].channel, 'c1');
  assert.equal(dropped[0].kind, 'mention');
  assert.equal(dropped[0].reason, 'cannot-send');
  assert.equal(logs.some((entry) => entry.msg === 'mention: decided'), false, 'no ignore roll');
});

test('events: several pending pings drain oldest first, one at a time (never concurrently)', async () => {
  const order = [];
  let concurrent = 0;
  let sawConcurrency = false;
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => true,
    runTurn: async (args) => {
      concurrent += 1;
      if (concurrent > 1) sawConcurrency = true;
      order.push(args.channel.id);
      await Promise.resolve();
      concurrent -= 1;
      return { outcome: 'spoke' };
    },
  });
  let t = 1_000_000;
  const now = () => (t += 1);
  const handler = makeHandler({ turns, sleep: async () => {}, now, rng: scripted([0.5, 0.99, 0.5, 0.99, 0.5, 0.99]) });

  const guild = fakeGuild();
  for (const id of ['c1', 'c2', 'c3']) {
    const channel = fakeChannelWithMessage(id, guild, `m-${id}`);
    await handler(directPingMessage({ id: `m-${id}`, guild, channel, channelId: id, cleanContent: id }));
  }

  await handler.drainPending();

  assert.deepEqual(order, ['c1', 'c2', 'c3'], 'oldest arrival first');
  assert.equal(sawConcurrency, false, 'never more than one deferred turn in flight at once');
});

test('events: a hot change to mention.oneAtATime is picked up without recreating the handler', async () => {
  const config = baseConfig();
  const answeredChannels = [];
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => true,
    runTurn: async (args) => {
      answeredChannels.push(args.channel.id);
      return { outcome: 'spoke' };
    },
  });
  const sleepCalls = [];
  const sleep = async (ms) => {
    sleepCalls.push(ms);
  };
  // 1st value: channel "b"'s IMMEDIATE decideMention (oneAtATime off, no delay involved).
  // 2nd value: the switch-delay sample for "a" at drain time (irrelevant here, switchDelayMs is fixed).
  // 3rd value: "a"'s decideMention at drain time.
  const handler = makeHandler({ config, turns, sleep, rng: scripted([0.5, 0.5, 0.99]) });

  const guild = fakeGuild();
  const channelA = fakeChannelWithMessage('a', guild, 'm-a');
  await handler(directPingMessage({ id: 'm-a', guild, channel: channelA, channelId: 'a', cleanContent: 'a' }));
  assert.equal(answeredChannels.length, 0, 'oneAtATime true (default): deferred, not run immediately');

  config.mention.oneAtATime = false;
  const channelB = fakeChannelWithMessage('b', guild, 'm-b');
  await handler(directPingMessage({ id: 'm-b', guild, channel: channelB, channelId: 'b', cleanContent: 'b' }));
  await Promise.resolve();
  assert.deepEqual(answeredChannels, ['b'], 'oneAtATime=false: runs immediately, ignoring busy elsewhere');

  config.mention.oneAtATime = true;
  config.mention.switchDelayMs = [1234, 1234];
  await handler.drainPending();
  assert.deepEqual(sleepCalls, [1234], 'the new switchDelayMs is read fresh at drain time');
  assert.deepEqual(answeredChannels.sort(), ['a', 'b'], 'the earlier pending ping for "a" is still answered once re-enabled');
});

test('events: a hot change to mention.pendingMinutes is picked up (a shorter window expires sooner)', async () => {
  let called = false;
  const config = baseConfig();
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => true,
    runTurn: async () => {
      called = true;
      return { outcome: 'spoke' };
    },
  });
  const clock = mutableNow(0);
  const handler = makeHandler({ config, turns, sleep: async () => {}, now: clock, rng: scripted([]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));

  config.mention.pendingMinutes = 1; // was 10
  clock.set(90_000); // 1.5 minutes later -- expired only under the new, shorter window
  await handler.drainPending();

  assert.equal(called, false);
});

// A turn that starts during the drain's switch pause makes the drain's
// runTurn answer 'busy': the picked-up ping goes back into the queue (its
// original arrivedAt kept, its `respond` decision carried) and the pass stops
// until the running turn ends and calls drainPending again.

/**
 * Turns where another channel ('other') is running a turn while `busy` is set: runTurn answers
 * 'busy' then (one attention), records every call. `startDuringPause()` is meant for the
 * injected sleep: the first switch pause starts that other turn.
 */
function pauseRaceTurns() {
  const state = { busy: true };
  const calls = [];
  const turns = fakeTurns({
    isBusy: (id) => state.busy && id === 'other',
    isAnyBusy: () => state.busy,
    runTurn: async (args) => {
      calls.push(args);
      return { outcome: state.busy ? 'busy' : 'spoke' };
    },
  });
  turns.calls = calls;
  turns.state = state;
  return turns;
}

test('events: a drained ping whose turn finds another one running is re-queued and answered on the next drain, decided once', async () => {
  const turns = pauseRaceTurns();
  const tagHistory = countingTagHistory();
  let pauses = 0;
  const sleep = async () => {
    pauses += 1;
    if (pauses === 1) turns.state.busy = true; // a fresh turn starts during the first switch pause
  };
  // Exactly three values: switch pause, decideMention, switch pause on the retry -- a second roll would run out.
  const handler = makeHandler({ turns, tagHistory, sleep, rng: scripted([0.5, 0.99, 0.5]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));
  assert.equal(turns.calls.length, 0, 'deferred');

  turns.state.busy = false;
  const first = await withCapturedLogs(() => handler.drainPending());
  assert.equal(turns.calls.length, 1, 'one attempt, answered busy');
  const again = first.logs.find((entry) => entry.msg === 'mention: deferred again' && entry.reason === 'busy');
  assert.ok(again, 'the re-queue is logged');
  assert.equal(again.channel, 'c1');
  assert.equal(again.kind, 'mention');
  assert.equal(again.pending, 1);

  turns.state.busy = false; // the other turn ends; its onIdle drains again
  const second = await withCapturedLogs(() => handler.drainPending());
  assert.equal(turns.calls.length, 2);
  assert.equal(turns.calls[1].trigger.id, 'm1');
  assert.equal(turns.calls[1].triggerKind, 'mention');
  assert.equal(tagHistory.hits, 1, 'counted toward spamThreshold once');
  const decided = [...first.logs, ...second.logs].filter((entry) => entry.msg === 'mention: decided');
  assert.equal(decided.length, 1, 'one decision for the ping');
  assert.equal(pauses, 2, 'the switch pause stays on the retry');
});

test('events: a re-queued ping keeps its original arrivedAt and expires mention.pendingMinutes after it', async () => {
  const turns = pauseRaceTurns();
  const clock = mutableNow(0);
  const sleep = async () => {
    turns.state.busy = true;
  };
  const handler = makeHandler({ turns, sleep, now: clock, rng: scripted([0.5, 0.99]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));

  turns.state.busy = false;
  clock.set(5 * 60_000);
  await handler.drainPending();
  assert.equal(turns.calls.length, 1, 'busy, re-queued');

  turns.state.busy = false;
  clock.set(10 * 60_000); // 10 minutes after the ORIGINAL arrival, 5 after the re-queue
  const { logs } = await withCapturedLogs(() => handler.drainPending());
  assert.equal(turns.calls.length, 1, 'not answered');
  assert.ok(logs.some((entry) => entry.msg === 'mention: expired' && entry.channel === 'c1'));
});

test('events: a newer ping queued in the same channel during the switch pause waits behind the re-queued one', async () => {
  const turns = pauseRaceTurns();
  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  channel.messages.cache.set('m2', {});
  let handler = null;
  let pauses = 0;
  const sleep = async () => {
    pauses += 1;
    if (pauses !== 1) return;
    turns.state.busy = true;
    await handler(directPingMessage({ id: 'm2', guild, channel, channelId: 'c1', cleanContent: 'second' }));
  };
  const tagHistory = countingTagHistory();
  // m1: pause, roll; m1 again: pause (already decided); m2: pause, roll.
  handler = makeHandler({ turns, tagHistory, sleep, rng: scripted([0.5, 0.99, 0.5, 0.5, 0.99]) });

  await handler(directPingMessage({ guild, channel, channelId: 'c1', cleanContent: 'first' }));
  turns.state.busy = false;
  const first = await withCapturedLogs(() => handler.drainPending());
  assert.equal(turns.calls.length, 1);
  assert.equal(first.logs.some((entry) => entry.msg === 'mention: dropped'), false, 'nothing leaves the queue');
  const again = first.logs.find((entry) => entry.msg === 'mention: deferred again');
  assert.ok(again, 'the busy ping goes back');
  assert.equal(again.queued, 2, 'beside the newer call of its author');

  turns.state.busy = false;
  await handler.drainPending();
  assert.deepEqual(turns.calls.map((c) => c.trigger.id), ['m1', 'm1', 'm2'], 'm1 tried, then answered, then the newer m2');
  assert.equal(tagHistory.hits, 2, 'm2 is a separate call, decided on its own');
});

test('events: one busy result is one runTurn attempt per drain pass (no tight loop)', async () => {
  const turns = pauseRaceTurns();
  const sleep = async () => {
    turns.state.busy = true; // another turn starts during every pause and never ends here
  };
  const handler = makeHandler({ turns, sleep, rng: () => 0.99 });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));

  turns.state.busy = false;
  await handler.drainPending();
  assert.equal(turns.calls.length, 1);
  turns.state.busy = false;
  await handler.drainPending();
  assert.equal(turns.calls.length, 2, 'still queued, one attempt per pass');
});

test('events: a busy result when nothing is busy any more continues the same pass', async () => {
  let attempts = 0;
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => false, // the blocking turn already ended by the time the drain looks
    runTurn: async () => {
      attempts += 1;
      return { outcome: attempts === 1 ? 'busy' : 'spoke' };
    },
  });
  const handler = makeHandler({ turns, sleep: async () => {}, rng: scripted([0.5, 0.99, 0.5]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  // Queue it: busy elsewhere on arrival.
  turns.isAnyBusy = () => true;
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));
  turns.isAnyBusy = () => false;

  await handler.drainPending();
  assert.equal(attempts, 2, 'retried in the same pass, answered');
});

test('events: an onIdle drain arriving while the busy drain is still finishing does not strand the re-queued ping', async () => {
  const state = { busy: false };
  const calls = [];
  let handler = null;
  let idleDrain = null;
  const turns = fakeTurns({
    isBusy: () => false,
    isAnyBusy: () => state.busy,
    runTurn: async (args) => {
      calls.push(args);
      if (calls.length === 1) {
        // The blocking turn ends right away and fires onIdle before the drain sees the result.
        Promise.resolve().then(() => {
          state.busy = false;
          idleDrain = handler.drainPending();
        });
        return { outcome: 'busy' };
      }
      return { outcome: 'spoke' };
    },
  });
  handler = makeHandler({ turns, sleep: async () => {}, rng: scripted([0.5, 0.99, 0.5]) });

  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  state.busy = true;
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));
  state.busy = true; // still busy while the drain's turn is refused

  await handler.drainPending();
  await idleDrain;
  assert.equal(calls.length, 2, 'the re-queued ping was answered');
});

// ---------------------------------------------------------------------------
// The address classifier (features.followUp) -- an untagged follow-up
// message inside a window the persona opened by answering is checked by
// address.md before it is (or is not) answered.

test('follow-up: the classifier request is address.md as system and a <candidate> block in the user message', async () => {
  const llm = fakeFollowUpLlm();
  const config = baseConfig();
  const handler = makeHandler({ config, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild('g1', 'Neptunia');
  const t0 = Date.now();
  const history = [rawHistoryMessage({ id: 'h1', authorId: 'u1', authorName: 'Alice', ts: t0, content: 'earlier message' })];
  const channel = fakeChannelWithHistory('c1', guild, history);
  await openFollowUpWindow(handler, { guild, channel, ts: t0 + 1000 });

  const msg = fakeMessage({ id: 'm-candidate', guild, channel, channelId: 'c1', cleanContent: 'is this for you', createdTimestamp: t0 + 2000 });
  const p = handler(msg);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(llm.calls.length, 1);
  const [{ messages, options }] = llm.calls;
  assert.equal(messages[0].role, 'system');
  assert.ok(messages[0].content.includes('Neptunia'), 'the {{name}} placeholder is filled');
  assert.equal(messages[1].role, 'user');
  assert.ok(messages[1].content.includes('<candidate>'));
  assert.ok(messages[1].content.includes('is this for you'));
  assert.ok(messages[1].content.includes('earlier message'), 'the channel context is included');
  assert.equal(options.maxOutputTokens, config.mention.followUpMaxOutputTokens, 'mention.followUpMaxOutputTokens');
  assert.equal(options.model, config.models.base.analyzer, 'models.base.analyzer');
  assert.equal(options.role, 'analyzer', 'routed as the analyzer');
  assert.equal(options.countAgainstDailyCap, true);
  assert.equal(options.skipCalibration, true);
  assert.equal(options.timeoutMs, config.llm.helperTimeoutMs, 'llm.helperTimeoutMs, never the turn-length llm.timeoutMs');
  assert.equal(options.purpose, 'address', 'named on the usage line');
  assert.equal(options.helper, true, 'spelled by helperRequestOptions, so llm.hedge applies');
  assert.equal('long' in options, false, 'a one-word answer: the short hedge limit');

  llm.respond('no');
  await p;
});

test('follow-up: the address classifier timeout is llm.helperTimeoutMs, read at each call; a missing key falls back to the config.json value', async () => {
  const llm = fakeFollowUpLlm();
  // Every answer below is "no": the streak limit is kept out of the way.
  const config = baseConfig({ llm: { timeoutMs: 300000, helperTimeoutMs: 12000 }, mention: { followUpNoStreak: 10 } });
  const handler = makeHandler({ config, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild('g1', 'Neptunia');
  const t0 = Date.now();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: t0 + 1000 });

  const ask = async (id, ts) => {
    const p = handler(fakeMessage({ id, guild, channel, channelId: 'c1', cleanContent: 'is this for you', createdTimestamp: ts }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    llm.respond('no');
    await p;
  };
  await ask('m-first', t0 + 2000);
  config.llm.helperTimeoutMs = 7000; // a hot edit between two calls
  await ask('m-second', t0 + 3000);
  delete config.llm.helperTimeoutMs; // an older config.local.json layer without the key
  await ask('m-third', t0 + 4000);

  assert.deepEqual(llm.calls.map((call) => call.options.timeoutMs), [12000, 7000, DEFAULT_CONFIG.llm.helperTimeoutMs]);
  assert.deepEqual(llm.calls.map((call) => call.options.purpose), ['address', 'address', 'address']);
});

test('follow-up: the address classifier model is models.base.analyzer over the deprecated keys, its own default when it is null', async () => {
  const cases = [
    {
      label: 'models.base.analyzer wins over the deprecated llm.classifierModel and mention.followUpModel',
      overrides: { models: { base: { analyzer: 'x/classifier' } }, llm: { classifierModel: 'x/old' }, mention: { followUpModel: 'x/older' } },
      expected: () => 'x/classifier',
    },
    {
      label: 'models.base.analyzer null is the analyzer default, never the vision model',
      overrides: { models: { base: { analyzer: null, vision: 'x/vision' } } },
      expected: () => ROLE_DEFAULTS.analyzer,
    },
  ];
  for (const { label, overrides, expected } of cases) {
    const llm = fakeFollowUpLlm();
    const config = baseConfig(overrides);
    const handler = makeHandler({ config, llm, prompts: fakeAddressPrompts() });
    const guild = fakeGuild('g1', 'Neptunia');
    const t0 = Date.now();
    const channel = fakeChannelWithHistory('c1', guild, []);
    await openFollowUpWindow(handler, { guild, channel, ts: t0 + 1000 });

    const p = handler(fakeMessage({ id: 'm-candidate', guild, channel, channelId: 'c1', cleanContent: 'is this for you', createdTimestamp: t0 + 2000 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(llm.calls.length, 1, label);
    assert.equal(llm.calls[0].options.model, expected(config), label);

    llm.respond('no');
    await p;
  }
});

test('follow-up: an empty or blank classifier answer is logged as a failure with its model and counts as "no"', async () => {
  for (const answer of ['', '  \n\t ']) {
    const llm = fakeFollowUpLlm();
    const turns = recordingTurns();
    const spontaneous = fakeSpontaneous();
    const config = baseConfig({ models: { base: { analyzer: 'x/text' } } });
    const handler = makeHandler({ config, turns, spontaneous, llm, prompts: fakeAddressPrompts() });
    const guild = fakeGuild();
    const channel = fakeChannelWithHistory('c1', guild, []);
    await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

    const { logs } = await withCapturedLogs(async () => {
      const p = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'plain follow-up' }));
      await tick();
      llm.respond(answer);
      await p;
    });
    const failed = logs.find((l) => l.msg === 'follow-up: classifier failed');
    assert.ok(failed, JSON.stringify(answer));
    assert.equal(failed.level, 'warn');
    assert.equal(failed.channel, 'c1');
    assert.equal(failed.reason, 'empty');
    assert.equal(failed.model, 'x/text');
    assert.equal(logs.find((l) => l.msg === 'follow-up: verdict')?.verdict, 'no');
    assert.equal(turns.calls.length, 0, 'no reply turn');
    assert.equal(spontaneous.onMessageCalls.length, 0, 'handled as a "no", not handed to spontaneous');
  }
});

test('follow-up: three empty classifier answers in a row close the window, like three failed calls', async () => {
  const clock = mutableNow(0);
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ spontaneous, now: clock, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: clock() });

  for (let i = 0; i < 3; i += 1) {
    const p = handler(fakeMessage({ id: `m${i}`, guild, channel, channelId: 'c1', cleanContent: `plain ${i}`, createdTimestamp: clock() }));
    await tick();
    llm.respond('');
    await p;
  }
  await handler(fakeMessage({ id: 'm4', guild, channel, channelId: 'c1', cleanContent: 'plain 4', createdTimestamp: clock() }));

  assert.equal(llm.calls.length, 3, 'the no-streak closed the window');
  assert.equal(spontaneous.onMessageCalls.length, 1);
});

test('follow-up: the classifier system prompt carries the bare display name, no braces around it', async () => {
  const llm = fakeFollowUpLlm();
  const guild = fakeGuild('g1', 'Nepτune');
  // The served guild's own member name (the default getSelfName reads the client's guild cache).
  const client = { ...fakeClient(), guilds: { cache: new Map([['g1', guild]]) } };
  const handler = makeHandler({ llm, client, prompts: fakeAddressPrompts() });
  const t0 = Date.now();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: t0 + 1000 });

  const msg = fakeMessage({ id: 'm-candidate', guild, channel, channelId: 'c1', cleanContent: 'is this for you', createdTimestamp: t0 + 2000 });
  const p = handler(msg);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(llm.calls.length, 1);
  const system = llm.calls[0].messages[0].content;
  assert.ok(system.startsWith('You are Nepτune. '), 'the {{name}} placeholder is replaced whole');
  assert.ok(!system.includes('{') && !system.includes('}'), 'no brace is left around the name');

  llm.respond('no');
  await p;
});

test('follow-up: the window opens on send and expires after followUpMinutes', async () => {
  const clock = mutableNow(0);
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ spontaneous, now: clock, llm, prompts: fakeAddressPrompts() });

  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: clock() });

  const msg1 = fakeMessage({ guild, channel, channelId: 'c1', cleanContent: 'plain follow-up', createdTimestamp: clock() });
  const p1 = handler(msg1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(llm.calls.length, 1, 'inside the window, a plain message reaches the classifier');
  llm.respond('no');
  await p1;

  clock.set(16 * 60_000); // past the default followUpMinutes=15
  const msg2 = fakeMessage({
    guild,
    channel,
    channelId: 'c1',
    cleanContent: 'too late',
    createdTimestamp: clock(),
    author: { id: 'u2', bot: false, globalName: 'Bob', username: 'bob' },
  });
  await handler(msg2);

  assert.equal(llm.calls.length, 1, 'once the window expired, the classifier is not consulted again');
  assert.equal(spontaneous.onMessageCalls.length, 1, 'the expired-window message falls back to the spontaneous scheduler');
});

test('follow-up: a reply carrying only the implicit reply ping reaches the classifier', async () => {
  const llm = fakeFollowUpLlm();
  const handler = makeHandler({ llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const msg = fakeMessage({
    guild,
    channel,
    channelId: 'c1',
    content: 'and what do you think',
    cleanContent: 'and what do you think',
    reference: { messageId: 'm-other' },
    mentions: { users: new Map([['u2', { id: 'u2' }]]), repliedUser: { id: 'u2' } },
  });
  const pending = handler(msg);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(llm.calls.length, 1, 'the reply ping is not a mention of another member');
  llm.respond('no');
  await pending;
});

test('follow-up: a reply that also mentions a third member is "no" without consulting the model', async () => {
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ spontaneous, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  await handler(fakeMessage({
    guild,
    channel,
    channelId: 'c1',
    content: '<@u3> look at this',
    cleanContent: '@Carol look at this',
    reference: { messageId: 'm-other' },
    mentions: { users: new Map([['u2', { id: 'u2' }], ['u3', { id: 'u3' }]]), repliedUser: { id: 'u2' } },
  }));

  assert.equal(llm.calls.length, 0);
  assert.equal(spontaneous.onMessageCalls.length, 0, 'handled by the pre-filter, not handed to spontaneous');
});

test('follow-up: mention.followUpClassifyReplies=false pre-filters any reply, read hot', async () => {
  const config = baseConfig({ mention: { followUpClassifyReplies: false } });
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ config, spontaneous, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const reply = (id) =>
    fakeMessage({ id, guild, channel, channelId: 'c1', cleanContent: 'replying to someone else', reference: { messageId: 'm-other' } });
  await handler(reply('m1'));
  assert.equal(llm.calls.length, 0, 'switch off: a reply never reaches the model');
  assert.equal(spontaneous.onMessageCalls.length, 0);

  config.mention.followUpClassifyReplies = true;
  const pending = handler(reply('m2'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(llm.calls.length, 1, 'switched back on without recreating the handler');
  llm.respond('no');
  await pending;
});

test('follow-up: a mention of another member is "no" without consulting the model', async () => {
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ spontaneous, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const msg = fakeMessage({
    guild,
    channel,
    channelId: 'c1',
    cleanContent: '@Bob check this out',
    mentions: { users: new Map([['u2', { id: 'u2' }]]) },
  });
  await handler(msg);

  assert.equal(llm.calls.length, 0, 'a mention of another member never reaches the model');
  assert.equal(spontaneous.onMessageCalls.length, 0);
});

test('follow-up: a "yes" verdict runs a reply turn with the candidate as the target', async () => {
  const llm = fakeFollowUpLlm();
  let seenArgs = null;
  const turns = fakeTurns({
    runTurn: async (args) => {
      seenArgs = args;
      return { outcome: 'spoke' };
    },
  });
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ turns, spontaneous, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const msg = fakeMessage({ id: 'm-candidate', guild, channel, channelId: 'c1', cleanContent: 'so what do you think' });
  const p = handler(msg);
  await new Promise((resolve) => setTimeout(resolve, 0));
  llm.respond('yes');
  await p;

  assert.ok(seenArgs, 'expected the reply turn to run');
  assert.equal(seenArgs.mode, 'reply');
  assert.equal(seenArgs.triggerKind, 'followUp');
  assert.equal(seenArgs.trigger.id, 'm-candidate', 'the candidate is the target, so replyTo works');
  assert.equal(seenArgs.trigger.content, 'so what do you think');
  assert.equal(seenArgs.channel, channel);
  assert.equal(spontaneous.onMessageCalls.length, 0);
});

test('follow-up: three "no" verdicts in a row close the window (the default followUpNoStreak)', async () => {
  const clock = mutableNow(0);
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ spontaneous, now: clock, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: clock() });

  for (let i = 0; i < 3; i += 1) {
    const msg = fakeMessage({ id: `m${i}`, guild, channel, channelId: 'c1', cleanContent: `plain ${i}`, createdTimestamp: clock() });
    const p = handler(msg);
    await new Promise((resolve) => setTimeout(resolve, 0));
    llm.respond('no');
    await p;
  }
  assert.equal(llm.calls.length, 3);
  assert.equal(spontaneous.onMessageCalls.length, 0, 'every one of the 3 was still handled by the classifier itself');

  const msg4 = fakeMessage({ id: 'm4', guild, channel, channelId: 'c1', cleanContent: 'plain 4', createdTimestamp: clock() });
  await handler(msg4);

  assert.equal(llm.calls.length, 3, 'the window is closed now, the classifier is not consulted a 4th time');
  assert.equal(spontaneous.onMessageCalls.length, 1, 'falls back to the spontaneous scheduler once the window is closed');
});

test('follow-up: a missing prompts.address is a "no" without calling the model', async () => {
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const prompts = { ...fakeAddressPrompts(), address: undefined };
  const handler = makeHandler({ spontaneous, llm, prompts });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const msg = fakeMessage({ guild, channel, channelId: 'c1', cleanContent: 'plain follow-up' });
  await handler(msg);

  assert.equal(llm.calls.length, 0);
  assert.equal(spontaneous.onMessageCalls.length, 0, 'still handled (as a no), not handed to spontaneous');
});

test('features.followUp=false: an open window is never consulted, falls back to spontaneous', async () => {
  const config = baseConfig({ features: { followUp: false } });
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ config, spontaneous, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const msg = fakeMessage({ guild, channel, channelId: 'c1', cleanContent: 'plain follow-up' });
  await handler(msg);

  assert.equal(llm.calls.length, 0);
  assert.equal(spontaneous.onMessageCalls.length, 1);
});

test('follow-up: a message that carries a trigger is never sent to the classifier, even inside an open window', async () => {
  const llm = fakeFollowUpLlm();
  let seenArgs = null;
  const turns = fakeTurns({
    runTurn: async (args) => {
      seenArgs = args;
      return { outcome: 'spoke' };
    },
  });
  const handler = makeHandler({ turns, llm, prompts: fakeAddressPrompts(), rng: scripted([0.99]) });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const msg = fakeMessage({
    guild,
    channel,
    channelId: 'c1',
    cleanContent: 'γεια',
    mentions: { users: new Map([['self1', { id: 'self1' }]]) },
  });
  await handler(msg);
  await Promise.resolve();

  assert.equal(llm.calls.length, 0, 'the normal trigger path never touches the classifier');
  assert.ok(seenArgs, 'the normal mention path still runs a turn');
  assert.equal(seenArgs.triggerKind, 'mention');
});

test('follow-up: at most one classifier call in flight per channel', async () => {
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ spontaneous, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const msg1 = fakeMessage({
    id: 'm1',
    guild,
    channel,
    channelId: 'c1',
    cleanContent: 'first',
    author: { id: 'u1', bot: false, globalName: 'Alice', username: 'alice' },
  });
  const p1 = handler(msg1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(llm.calls.length, 1);

  const msg2 = fakeMessage({
    id: 'm2',
    guild,
    channel,
    channelId: 'c1',
    cleanContent: 'second',
    author: { id: 'u2', bot: false, globalName: 'Bob', username: 'bob' },
  });
  await handler(msg2); // must not start a second classifier call while the first is in flight

  assert.equal(llm.calls.length, 1, 'the second message found a call already in flight for this channel');
  assert.equal(spontaneous.onMessageCalls.length, 0, 'left alone entirely, not handed to spontaneous either');

  llm.respond('no');
  await p1;
});

/** A plain untagged message in channel c1 from `authorId`. */
function plainFollowUpMessage({ id, guild, channel, content, authorId = 'u2', authorName = 'Bob', ts = Date.now() }) {
  return fakeMessage({
    id,
    guild,
    channel,
    channelId: channel.id,
    cleanContent: content,
    createdTimestamp: ts,
    author: { id: authorId, bot: false, globalName: authorName, username: authorName.toLowerCase() },
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('follow-up: a message arriving while a call is in flight is classified after a "no"', async () => {
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ spontaneous, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const { logs } = await withCapturedLogs(async () => {
    const p1 = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'forwarded picture', authorId: 'u1', authorName: 'Alice' }));
    await tick();
    assert.equal(llm.calls.length, 1);

    const handled = await handler(plainFollowUpMessage({ id: 'm2', guild, channel, content: 'what do you make of this' }));
    assert.equal(handled, undefined, 'onMessage itself returns nothing');
    assert.equal(llm.calls.length, 1, 'no second call while the first is in flight');

    llm.respond('no');
    await p1;
    await tick();

    assert.equal(llm.calls.length, 2, 'the held message is classified once the "no" came back');
    const user = llm.calls[1].messages[1].content;
    assert.match(user, /<candidate>[\s\S]*what do you make of this[\s\S]*<\/candidate>/);

    llm.respond('no');
    await tick();
  });

  assert.equal(spontaneous.onMessageCalls.length, 0, 'neither message is handed to the spontaneous scheduler');
  const verdicts = logs.filter((e) => e.msg === 'follow-up: verdict');
  assert.deepEqual(
    verdicts.map((e) => e.author),
    ['u1', 'u2'],
    'each classified message logs its own verdict',
  );
  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes('what do you make of this'), 'no message content in the logs');
  assert.ok(!serialized.includes('forwarded picture'), 'no message content in the logs');
});

test('follow-up: a message held during the call is discarded after a "yes" (the turn reads it in the history)', async () => {
  const llm = fakeFollowUpLlm();
  const turnTargets = [];
  const turns = fakeTurns({
    runTurn: async (args) => {
      turnTargets.push(args.trigger.id);
      return { outcome: 'spoke' };
    },
  });
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ turns, spontaneous, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const p1 = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'first', authorId: 'u1', authorName: 'Alice' }));
  await tick();
  await handler(plainFollowUpMessage({ id: 'm2', guild, channel, content: 'second' }));

  llm.respond('yes');
  await p1;
  await tick();

  assert.equal(llm.calls.length, 1, 'the held message is not classified after a "yes"');
  assert.deepEqual(turnTargets, ['m1'], 'one turn, for the message that got the "yes"');
  assert.equal(spontaneous.onMessageCalls.length, 0);

  // The slot is free again: the next plain message is classified as usual.
  const p3 = handler(plainFollowUpMessage({ id: 'm3', guild, channel, content: 'third' }));
  await tick();
  assert.equal(llm.calls.length, 2);
  llm.respond('no');
  await p3;
});

test('follow-up: only the latest of several messages held during one call is classified', async () => {
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ spontaneous, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const p1 = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'first', authorId: 'u1', authorName: 'Alice' }));
  await tick();
  await handler(plainFollowUpMessage({ id: 'm2', guild, channel, content: 'second' }));
  await handler(plainFollowUpMessage({ id: 'm3', guild, channel, content: 'third', authorId: 'u3', authorName: 'Chloé' }));
  assert.equal(llm.calls.length, 1);

  llm.respond('no');
  await p1;
  await tick();

  assert.equal(llm.calls.length, 2, 'one follow-up call, not one per held message');
  const user = llm.calls[1].messages[1].content;
  assert.match(user, /<candidate>[\s\S]*third[\s\S]*<\/candidate>/);
  assert.doesNotMatch(user, /<candidate>[\s\S]*second[\s\S]*<\/candidate>/);

  llm.respond('no');
  await tick();
  await tick();
  assert.equal(llm.calls.length, 2, 'the replaced message is never classified');
  assert.equal(spontaneous.onMessageCalls.length, 0);
});

test('follow-up: a held message is dropped when the window expired by the time the call ends', async () => {
  const clock = mutableNow(0);
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ spontaneous, now: clock, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: clock() });

  const p1 = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'first', authorId: 'u1', authorName: 'Alice', ts: clock() }));
  await tick();
  await handler(plainFollowUpMessage({ id: 'm2', guild, channel, content: 'second', ts: clock() }));

  clock.set(16 * 60_000); // past the default followUpMinutes=15
  llm.respond('no');
  await p1;
  await tick();

  assert.equal(llm.calls.length, 1, 'the window closed meanwhile: the held message is not classified');
  assert.equal(spontaneous.onMessageCalls.length, 0);
});

test('follow-up: a held message is dropped when a "no" streak closed the window', async () => {
  const config = baseConfig({ mention: { followUpNoStreak: 1 } });
  const llm = fakeFollowUpLlm();
  const handler = makeHandler({ config, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const p1 = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'first', authorId: 'u1', authorName: 'Alice' }));
  await tick();
  await handler(plainFollowUpMessage({ id: 'm2', guild, channel, content: 'second' }));
  llm.respond('no');
  await p1;
  await tick();

  assert.equal(llm.calls.length, 1, 'the one "no" closed the window, nothing left to classify');
});

test('follow-up: with mention.classifyWhileBusy off, a held message is dropped when the channel is busy by the time the call ends', async () => {
  let busy = false;
  const turns = fakeTurns({ isBusy: () => busy, isAnyBusy: () => busy });
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const config = baseConfig({ mention: { classifyWhileBusy: false } });
  const handler = makeHandler({ config, turns, spontaneous, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const p1 = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'first', authorId: 'u1', authorName: 'Alice' }));
  await tick();
  await handler(plainFollowUpMessage({ id: 'm2', guild, channel, content: 'second' }));

  busy = true;
  llm.respond('no');
  await p1;
  await tick();

  assert.equal(llm.calls.length, 1, 'a turn is running in the channel: the held message is not classified');
  assert.equal(spontaneous.onMessageCalls.length, 0);

  // Nothing stays held: once the channel is free, a new message is classified on its own.
  busy = false;
  const p3 = handler(plainFollowUpMessage({ id: 'm3', guild, channel, content: 'third' }));
  await tick();
  assert.equal(llm.calls.length, 2);
  assert.match(llm.calls[1].messages[1].content, /<candidate>[\s\S]*third/);
  llm.respond('no');
  await p3;
  await tick();
  assert.equal(llm.calls.length, 2);
});

test('follow-up: a held message is dropped when the bot was paused meanwhile, nothing marked dirty', async () => {
  const store = fakeStateStore();
  const llm = fakeFollowUpLlm();
  const handler = makeHandler({ store, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const p1 = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'first', authorId: 'u1', authorName: 'Alice' }));
  await tick();
  await handler(plainFollowUpMessage({ id: 'm2', guild, channel, content: 'second' }));
  llm.respond('no');
  store.state.data.paused = true;
  const dirtyBefore = store.dirtyCount;
  await p1;
  await tick();

  assert.equal(llm.calls.length, 1, 'paused: the held message is not classified');
  assert.equal(store.dirtyCount - dirtyBefore, 1, 'only the in-flight "no" bumped the streak, the held one did not');
});

test('follow-up: a hot change to mention.followUpMinutes is picked up without recreating the handler', async () => {
  const clock = mutableNow(0);
  const config = baseConfig();
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ config, spontaneous, now: clock, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: clock() });

  config.mention.followUpMinutes = 1; // was 15

  clock.set(90_000); // 1.5 min: inside the old default, past the new shorter one
  const msg = fakeMessage({ guild, channel, channelId: 'c1', cleanContent: 'plain follow-up' });
  await handler(msg);

  assert.equal(llm.calls.length, 0, 'the shorter window (read live) had already expired');
  assert.equal(spontaneous.onMessageCalls.length, 1);
});

// ---------------------------------------------------------------------------
// Follow-up windows survive a restart: mirrored into store.state.data.followUpWindows.

/** A fakeStore with a real-shaped `state` ({ data, markDirty }) that counts markDirty calls. */
function fakeStateStore(data = {}) {
  const store = fakeStore();
  store.dirtyCount = 0;
  store.state = {
    data,
    markDirty() {
      store.dirtyCount += 1;
    },
  };
  return store;
}

test('follow-up persistence: an open window survives a re-created handler with the same state', async () => {
  const clock = mutableNow(10_000);
  const store = fakeStateStore();
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  const first = makeHandler({ store, now: clock, llm: fakeFollowUpLlm(), prompts: fakeAddressPrompts() });
  await openFollowUpWindow(first, { guild, channel, ts: clock() });

  assert.deepEqual(store.state.data.followUpWindows, { c1: { openedAt: 10_000, lastAnswerAt: 10_000, noStreak: 0 } });
  assert.ok(store.dirtyCount > 0, 'opening a window marks the state dirty');

  clock.set(40_000); // "restart" half a minute later, well inside followUpMinutes=15
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const second = makeHandler({ store, spontaneous, now: clock, llm, prompts: fakeAddressPrompts() });
  const msg = fakeMessage({ guild, channel, channelId: 'c1', cleanContent: 'plain follow-up', createdTimestamp: clock() });
  const p = second(msg);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(llm.calls.length, 1, 'the restored window sends the untagged message to the classifier');
  llm.respond('no');
  await p;

  assert.equal(spontaneous.onMessageCalls.length, 0);
  assert.equal(store.state.data.followUpWindows.c1.noStreak, 1, 'the streak change is mirrored too');
});

test('follow-up persistence: an expired window is dropped on load', async () => {
  const store = fakeStateStore({
    followUpWindows: {
      old: { openedAt: 0, lastAnswerAt: 0, noStreak: 0 },
      fresh: { openedAt: 950_000, lastAnswerAt: 950_000, noStreak: 1 },
    },
  });
  const clock = mutableNow(960_000); // 16 min: past followUpMinutes=15 for "old", 10 s for "fresh"
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ store, spontaneous, now: clock, llm, prompts: fakeAddressPrompts() });

  assert.deepEqual(Object.keys(store.state.data.followUpWindows), ['fresh'], 'the expired key is deleted from state');
  assert.ok(store.dirtyCount > 0);

  const guild = fakeGuild();
  const oldChannel = fakeChannelWithHistory('old', guild, []);
  await handler(fakeMessage({ guild, channel: oldChannel, channelId: 'old', cleanContent: 'plain', createdTimestamp: clock() }));
  assert.equal(llm.calls.length, 0, 'the dropped window is not consulted');
  assert.equal(spontaneous.onMessageCalls.length, 1);
});

test('follow-up persistence: closing the window by the "no" streak removes its key from state', async () => {
  const clock = mutableNow(0);
  const store = fakeStateStore();
  const llm = fakeFollowUpLlm();
  const handler = makeHandler({ store, now: clock, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: clock() });

  for (let i = 0; i < 3; i += 1) {
    const p = handler(fakeMessage({ id: `m${i}`, guild, channel, channelId: 'c1', cleanContent: `plain ${i}`, createdTimestamp: clock() }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    llm.respond('no');
    await p;
  }

  assert.equal(Object.hasOwn(store.state.data.followUpWindows, 'c1'), false, 'the closed window is gone from state');
});

test('follow-up persistence: an expired window is removed from state when next consulted', async () => {
  const clock = mutableNow(0);
  const store = fakeStateStore();
  const handler = makeHandler({ store, now: clock, llm: fakeFollowUpLlm(), prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: clock() });

  clock.set(16 * 60_000); // past the default followUpMinutes=15
  await handler(fakeMessage({ guild, channel, channelId: 'c1', cleanContent: 'too late', createdTimestamp: clock() }));

  assert.equal(Object.hasOwn(store.state.data.followUpWindows, 'c1'), false);
});

test('follow-up persistence: no message text ever reaches the state', async () => {
  const clock = mutableNow(0);
  const store = fakeStateStore();
  const llm = fakeFollowUpLlm();
  const handler = makeHandler({ store, now: clock, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: clock() });
  const p = handler(fakeMessage({ guild, channel, channelId: 'c1', cleanContent: 'ένα μυστικό μήνυμα', createdTimestamp: clock() }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  llm.respond('no');
  await p;

  const saved = store.state.data.followUpWindows.c1;
  assert.deepEqual(Object.keys(saved).sort(), ['lastAnswerAt', 'noStreak', 'openedAt']);
  for (const value of Object.values(saved)) assert.equal(typeof value, 'number');
  const json = JSON.stringify(store.state.data);
  assert.ok(!json.includes('μυστικό') && !json.includes('here you go'), 'neither the member\'s nor the persona\'s text is stored');
});

// ---------------------------------------------------------------------------
// features.webLookup + web.links.prefill: a posted link is read
// fire-and-forget, at most one per message, never a video-site or gif link.

function fakeLookup() {
  const readCalls = [];
  return {
    readCalls,
    readLinks: async (guildId, links, options) => {
      readCalls.push({ guildId, links, options });
      return { reads: new Map(), newCount: 0 };
    },
  };
}

const LINK_EMBEDS = [
  { url: 'https://www.youtube.com/watch?v=abc', title: 'v', provider: { name: 'YouTube' } },
  { url: 'https://tenor.com/view/x', provider: { name: 'Tenor' } },
  { url: 'https://example.org/a', title: 'Crêpes' },
  { url: 'https://example.org/b', title: 'Galettes' },
];

function webConfig(overrides = {}) {
  return baseConfig(deepMerge({ features: { webLookup: true }, web: { links: { enabled: true, prefill: true } } }, overrides));
}

test('events: web.links.prefill on reads the first readable link of a message, fire-and-forget', async () => {
  const lookup = fakeLookup();
  const handler = makeHandler({ config: webConfig(), lookup });

  await handler(fakeMessage({ id: 'm1', cleanContent: 'κοίτα', embeds: LINK_EMBEDS }));

  assert.equal(lookup.readCalls.length, 1);
  assert.equal(lookup.readCalls[0].guildId, 'g1');
  assert.deepEqual(
    lookup.readCalls[0].links.map((link) => link.url),
    ['https://example.org/a'],
    'the video-site and gif embeds are skipped, one link only',
  );
});

test('events: no link prefill when webLookup is off or missing, links are disabled or prefill is off', async () => {
  const missing = webConfig();
  delete missing.features.webLookup;
  for (const config of [
    webConfig({ features: { webLookup: false } }),
    missing,
    webConfig({ web: { links: { enabled: false } } }),
    webConfig({ web: { links: { prefill: false } } }),
    baseConfig(),
  ]) {
    const lookup = fakeLookup();
    const handler = makeHandler({ config, lookup });
    await handler(fakeMessage({ id: 'm1', cleanContent: 'κοίτα', embeds: LINK_EMBEDS }));
    assert.equal(lookup.readCalls.length, 0);
  }
});

/** A lookup whose every prefill read is a new fetch attempt (newCount = the links it was allowed). */
function attemptingLookup({ attempted = true } = {}) {
  const readCalls = [];
  return {
    readCalls,
    readLinks: async (guildId, links, options) => {
      readCalls.push({ guildId, links, options });
      return { reads: new Map(), newCount: attempted ? Math.min(links.length, options?.maxNew ?? Infinity) : 0 };
    },
  };
}

/** A message from `authorId` carrying one readable link of its own. */
function linkMessage(id, authorId) {
  return fakeMessage({
    id,
    cleanContent: 'κοίτα',
    author: { id: authorId, bot: false, globalName: authorId, username: authorId },
    embeds: [{ url: `https://example.org/${id}`, title: 'Crêpes' }],
  });
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('events: link prefill is capped per member per day by web.links.prefillPerUserPerDay; others are unaffected', async () => {
  const lookup = attemptingLookup();
  const handler = makeHandler({ config: webConfig({ web: { links: { prefillPerUserPerDay: 2 } } }), lookup, now: () => Date.UTC(2026, 8, 20, 10) });
  for (const id of ['m1', 'm2', 'm3', 'm4']) {
    await handler(linkMessage(id, 'u1'));
    await settle();
  }
  assert.deepEqual(lookup.readCalls.map((c) => c.links[0].url), ['https://example.org/m1', 'https://example.org/m2']);
  assert.ok(lookup.readCalls.every((c) => c.options.maxNew === 1));

  await handler(linkMessage('m5', 'u2'));
  await settle();
  assert.equal(lookup.readCalls.length, 3, 'another member still gets a prefill');
  assert.equal(lookup.readCalls[2].links[0].url, 'https://example.org/m5');
});

test('events: the per-member prefill count resets on a new UTC day', async () => {
  let now = Date.UTC(2026, 8, 20, 23, 59);
  const lookup = attemptingLookup();
  const handler = makeHandler({ config: webConfig({ web: { links: { prefillPerUserPerDay: 1 } } }), lookup, now: () => now });
  await handler(linkMessage('m1', 'u1'));
  await settle();
  await handler(linkMessage('m2', 'u1'));
  await settle();
  assert.equal(lookup.readCalls.length, 1);
  now = Date.UTC(2026, 8, 21, 0, 1);
  await handler(linkMessage('m3', 'u1'));
  await settle();
  assert.equal(lookup.readCalls.length, 2);
});

test('events: a prefill that fetched nothing new (a cache hit) does not count toward the member limit', async () => {
  const lookup = attemptingLookup({ attempted: false });
  const handler = makeHandler({ config: webConfig({ web: { links: { prefillPerUserPerDay: 1 } } }), lookup });
  for (const id of ['m1', 'm2', 'm3']) {
    await handler(linkMessage(id, 'u1'));
    await settle();
  }
  assert.equal(lookup.readCalls.length, 3);
});

test('events: prefillPerUserPerDay 0 turns the link prefill off; a missing key falls back to the config.json value', async () => {
  const off = attemptingLookup();
  const offHandler = makeHandler({ config: webConfig({ web: { links: { prefillPerUserPerDay: 0 } } }), lookup: off });
  await offHandler(linkMessage('m1', 'u1'));
  await settle();
  assert.equal(off.readCalls.length, 0);

  const config = webConfig();
  delete config.web.links.prefillPerUserPerDay;
  const byDefault = attemptingLookup();
  const handler = makeHandler({ config, lookup: byDefault });
  const perDay = DEFAULT_CONFIG.web.links.prefillPerUserPerDay;
  for (let i = 0; i < perDay + 2; i += 1) {
    await handler(linkMessage(`n${i}`, 'u1'));
    await settle();
  }
  assert.equal(byDefault.readCalls.length, perDay);
});

test('events: a message with no readable link never calls readLinks; a lookup failure is swallowed', async () => {
  const lookup = fakeLookup();
  await makeHandler({ config: webConfig(), lookup })(fakeMessage({ id: 'm1', cleanContent: 'just words' }));
  assert.equal(lookup.readCalls.length, 0);

  const failing = { readLinks: async () => { throw new Error('boom'); } };
  await makeHandler({ config: webConfig(), lookup: failing })(fakeMessage({ id: 'm2', cleanContent: 'κοίτα', embeds: LINK_EMBEDS }));
  await new Promise((resolve) => setImmediate(resolve));
});

// ---------------------------------------------------------------------------
// Private chat (features.privateMessages): a DM from a member of the served
// guild runs through privateGate (src/behavior/private.js) and, when it
// passes, a reply turn with the pinned guildId. Limit notices: a triggered
// turn refused by a rail gets one plain line naming the limit.

const TODAY = '2026-09-29';
const TODAY_MS = Date.parse(`${TODAY}T12:00:00Z`);

function privateConfig(overrides = {}) {
  return baseConfig(deepMerge({ features: { privateMessages: true }, bot: { owners: ['owner1'] }, private: { maxPerUserPerDay: 100 } }, overrides));
}

function fakeDmChannel(id = 'dm1', recipientId = 'u1', overrides = {}) {
  const sent = [];
  return {
    id,
    type: 'DM',
    guild: null,
    recipientId,
    sent,
    send: async (payload) => {
      sent.push(payload);
      return { id: `sent${sent.length}` };
    },
    messages: { cache: new Map([['dm-m1', {}]]), fetch: async () => ({}) },
    ...overrides,
  };
}

function fakeDmMessage(overrides = {}) {
  const channel = overrides.channel ?? fakeDmChannel();
  return fakeMessage({ id: 'dm-m1', guild: null, member: null, channel, channelId: channel.id, cleanContent: 'γεια σου', ...overrides });
}

/** A client whose served guild knows `members` (cache) and can fetch `fetchable` ones. */
function fakeDmClient({ members = ['u1', 'owner1'], fetchable = [] } = {}) {
  const fetchCalls = [];
  const guild = {
    id: 'g1',
    members: {
      me: { displayName: 'Ζωή' },
      cache: new Map(members.map((id) => [id, { id }])),
      fetch: async (id) => {
        fetchCalls.push(id);
        if (fetchable.includes(id)) return { id };
        throw new Error('Unknown Member');
      },
    },
  };
  return { user: { id: 'self1', username: 'Neptunia' }, guilds: { cache: new Map([['g1', guild]]) }, fetchCalls };
}

/** A store with public profiles and private files; records the private bookkeeping calls. */
function fakePrivateStore({ profiles = { u1: { affinity: { score: 10 } }, owner1: { affinity: { score: -50 } } }, privates = {} } = {}) {
  const bumps = [];
  const noticed = [];
  return {
    state: { data: {} },
    getUser: (guildId, userId) => profiles[userId] ?? null,
    getPrivate: (guildId, userId) => privates[userId] ?? null,
    bumpPrivateReplies: (guildId, userId, today) => {
      bumps.push([guildId, userId, today]);
    },
    markPrivateNoticed: (guildId, userId, today) => {
      noticed.push([guildId, userId, today]);
      privates[userId] = { ...(privates[userId] ?? {}), replies: { ...(privates[userId]?.replies ?? {}), noticedDay: today } };
    },
    bumps,
    noticed,
  };
}

function recordingTurns(result = { outcome: 'spoke' }, extra = {}) {
  const calls = [];
  const turns = fakeTurns({
    runTurn: async (args) => {
      calls.push(args);
      return result;
    },
    ...extra,
  });
  turns.calls = calls;
  return turns;
}

function makeDmHandler({ config, store, client, turns, memory, ...rest } = {}) {
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

test('private: every gate reason drops the DM without a turn or an observe', async () => {
  const cases = [
    { reason: 'off', config: baseConfig({ bot: { owners: ['owner1'] } }) },
    { reason: 'not-member', client: fakeDmClient({ members: [] }) },
    { reason: 'unknown', store: fakePrivateStore({ profiles: {} }) },
    { reason: 'affinity', store: fakePrivateStore({ profiles: { u1: { affinity: { score: 4 } } } }) },
    {
      reason: 'cap',
      store: fakePrivateStore({ privates: { u1: { replies: { day: TODAY, count: 100, noticedDay: TODAY } } } }),
    },
  ];
  for (const { reason, ...deps } of cases) {
    const turns = recordingTurns();
    const memory = fakeMemory();
    const spontaneous = fakeSpontaneous();
    const handler = makeDmHandler({ turns, memory, spontaneous, ...deps });
    const message = fakeDmMessage();
    await handler(message);
    await settle();
    assert.equal(turns.calls.length, 0, `${reason}: no turn`);
    assert.equal(memory.observeCalls.length, 0, `${reason}: no observe`);
    assert.equal(spontaneous.onMessageCalls.length, 0, `${reason}: no eavesdrop`);
    assert.equal(message.channel.sent.length, 0, `${reason}: nothing sent`);
  }
});

test("activity: a member's server message is noted under its channel; the persona's own message is not", async () => {
  const activity = createActivity();
  const t = Date.now();
  const handler = makeHandler({ activity });
  await handler(fakeMessage({ id: 'm1', createdTimestamp: t - 2000 }));
  await handler(fakeMessage({ id: 'm2', author: { id: 'self1', bot: true, username: 'Neptunia' }, cleanContent: 'γεια', createdTimestamp: t }));
  await settle();
  assert.equal(activity.lastAt('c1', 'u1'), t - 2000);
  assert.equal(activity.lastAt('c1', 'self1'), null);
});

test("activity: a member's DM is noted under the DM channel; the persona's own DM message is not", async () => {
  const activity = createActivity();
  const handler = makeDmHandler({ activity });
  await handler(fakeDmMessage({ createdTimestamp: TODAY_MS - 3000 }));
  await handler(fakeDmMessage({ id: 'dm-own', author: { id: 'self1', bot: true, username: 'Neptunia' }, createdTimestamp: TODAY_MS }));
  await settle();
  assert.equal(activity.lastAt('dm1', 'u1'), TODAY_MS - 3000);
  assert.equal(activity.lastAt('dm1', 'self1'), null);
});

test('private: a member missing from the cache is fetched; a fetched member passes', async () => {
  const client = fakeDmClient({ members: [], fetchable: ['u1'] });
  const turns = recordingTurns();
  const handler = makeDmHandler({ client, turns });
  await handler(fakeDmMessage());
  await settle();
  assert.deepEqual(client.fetchCalls, ['u1']);
  assert.equal(turns.calls.length, 1);
});

test('private: an unknown author or one below minAffinity never triggers a member fetch', async () => {
  const cases = [
    { reason: 'unknown', store: fakePrivateStore({ profiles: {} }) },
    { reason: 'affinity', store: fakePrivateStore({ profiles: { u1: { affinity: { score: 4 } } } }) },
  ];
  for (const { reason, store } of cases) {
    const client = fakeDmClient({ members: [], fetchable: ['u1'] });
    const turns = recordingTurns();
    const handler = makeDmHandler({ client, turns, store });
    const { logs } = await withCapturedLogs(async () => {
      await handler(fakeDmMessage());
      await settle();
    });
    assert.deepEqual(client.fetchCalls, [], `${reason}: no REST call`);
    assert.equal(turns.calls.length, 0, `${reason}: no turn`);
    assert.equal(logs.find((l) => l.msg === 'private: dropped')?.reason, reason);
  }
});

test('private: an owner below minAffinity is still answered (owners bypass the threshold)', async () => {
  const turns = recordingTurns();
  const handler = makeDmHandler({ turns });
  await handler(fakeDmMessage({ author: { id: 'owner1', bot: false, globalName: 'Owner', username: 'owner' } }));
  await settle();
  assert.equal(turns.calls.length, 1);
});

test('private: the daily cap posts the limit notice once a day and marks it noticed', async () => {
  const store = fakePrivateStore({ privates: { u1: { replies: { day: TODAY, count: 100, noticedDay: '2026-09-28' } } } });
  const turns = recordingTurns();
  const memory = fakeMemory();
  const channel = fakeDmChannel();
  const handler = makeDmHandler({ store, turns, memory });

  await handler(fakeDmMessage({ channel }));
  await settle();
  await handler(fakeDmMessage({ channel, id: 'dm-m2' }));
  await settle();

  assert.equal(channel.sent.length, 1, 'one notice, not one per message');
  assert.equal(channel.sent[0].content, 'limit reached (private.maxPerUserPerDay, 100/100)');
  assert.deepEqual(channel.sent[0].allowedMentions, { parse: [] });
  assert.equal(channel.sent[0].reply.messageReference, 'dm-m1');
  assert.deepEqual(store.noticed, [['g1', 'u1', TODAY]]);
  assert.equal(turns.calls.length, 0);
  assert.equal(memory.observeCalls.length, 0);
});

test("private: an owner's cap notice names private.maxPerOwnerPerDay", async () => {
  const store = fakePrivateStore({ privates: { owner1: { replies: { day: TODAY, count: 200, noticedDay: '' } } } });
  const channel = fakeDmChannel('dm2', 'owner1');
  const handler = makeDmHandler({ store });
  await handler(fakeDmMessage({ channel, author: { id: 'owner1', bot: false, globalName: 'Owner', username: 'owner' } }));
  await settle();
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, 'limit reached (private.maxPerOwnerPerDay, 200/200)');
});

test('private: a DM that passes is observed privately, answered with the pinned guildId, then counted', async () => {
  const store = fakePrivateStore();
  const turns = recordingTurns();
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const channel = fakeDmChannel();
  const handler = makeDmHandler({ store, turns, memory, spontaneous });

  await handler(fakeDmMessage({ channel }));
  await settle();

  assert.equal(memory.observeCalls.length, 1);
  assert.equal(memory.observeCalls[0][0], 'g1');
  assert.equal(memory.observeCalls[0][1].content, 'γεια σου');
  assert.deepEqual(memory.observeCalls[0][2], { direct: true, private: 'u1' });
  assert.equal(turns.calls.length, 1);
  const args = turns.calls[0];
  assert.equal(args.channel, channel);
  assert.equal(args.guildId, 'g1');
  assert.equal(args.mode, 'reply');
  assert.equal(args.triggerKind, 'private');
  assert.equal(args.trigger.id, 'dm-m1');
  assert.deepEqual(store.bumps, [['g1', 'u1', TODAY]]);
  assert.equal(spontaneous.onMessageCalls.length, 0);
  assert.equal(channel.sent.length, 0);
});

test('private: a turn that never reached the model is not counted against the daily cap', async () => {
  for (const outcome of ['refused', 'busy', 'paused', 'error', 'not-now']) {
    const store = fakePrivateStore();
    const handler = makeDmHandler({ store, turns: recordingTurns({ outcome }) });
    await handler(fakeDmMessage());
    await settle();
    assert.deepEqual(store.bumps, [], outcome);
  }
});

test('private: a turn that reached the model and chose silence (skip) counts against the daily cap', async () => {
  const store = fakePrivateStore();
  const handler = makeDmHandler({ store, turns: recordingTurns({ outcome: 'skip' }) });
  await handler(fakeDmMessage());
  await settle();
  assert.deepEqual(store.bumps, [['g1', 'u1', TODAY]]);
});

test('private: a DM refused by a rail posts the limit notice', async () => {
  const channel = fakeDmChannel();
  const turns = recordingTurns({ outcome: 'refused', limit: { key: 'llm.maxRequestsPerDay', used: 800, cap: 800 } });
  const store = fakePrivateStore();
  const handler = makeDmHandler({ turns, store });
  await handler(fakeDmMessage({ channel }));
  await settle();
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, 'limit reached (llm.maxRequestsPerDay, 800/800)');
  assert.deepEqual(store.bumps, []);
});

test('private: while busy elsewhere the DM is pending as "private"; the drain passes guildId and counts the reply', async () => {
  let busy = true;
  const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
  const store = fakePrivateStore();
  const memory = fakeMemory();
  const channel = fakeDmChannel();
  // A private ping is never rolled for the ignore chance: an rng that would ignore any ping.
  const handler = makeDmHandler({ turns, store, memory, sleep: async () => {}, rng: () => 0 });

  const { logs } = await withCapturedLogs(async () => {
    await handler(fakeDmMessage({ channel }));
    await settle();
  });
  const deferred = logs.find((l) => l.msg === 'mention: deferred');
  assert.ok(deferred);
  assert.equal(deferred.kind, 'private');
  assert.equal(turns.calls.length, 0);
  assert.equal(memory.observeCalls.length, 1, 'observed on arrival');

  busy = false;
  await handler.drainPending();

  assert.equal(turns.calls.length, 1);
  assert.equal(turns.calls[0].guildId, 'g1');
  assert.equal(turns.calls[0].triggerKind, 'private');
  assert.equal(turns.calls[0].channel, channel);
  assert.deepEqual(store.bumps, [['g1', 'u1', TODAY]]);
});

test('private: a drained DM whose turn finds another one running is re-queued and answered on the next drain', async () => {
  const state = { busy: true };
  const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => state.busy });
  const runOriginal = turns.runTurn;
  turns.runTurn = async (args) => (state.busy ? (turns.calls.push(args), { outcome: 'busy' }) : runOriginal(args));
  const store = fakePrivateStore();
  const channel = fakeDmChannel();
  let pauses = 0;
  const sleep = async () => {
    pauses += 1;
    if (pauses === 1) state.busy = true;
  };
  const handler = makeDmHandler({ turns, store, sleep, rng: () => 0 });

  await handler(fakeDmMessage({ channel }));
  await settle();
  state.busy = false;
  const { logs } = await withCapturedLogs(() => handler.drainPending());
  assert.equal(turns.calls.length, 1);
  assert.deepEqual(store.bumps, [], 'a busy turn is not counted');
  const again = logs.find((l) => l.msg === 'mention: deferred again' && l.reason === 'busy');
  assert.ok(again);
  assert.equal(again.kind, 'private');
  assert.equal(again.channel, 'dm1');

  state.busy = false;
  await handler.drainPending();
  assert.equal(turns.calls.length, 2);
  assert.equal(turns.calls[1].trigger.id, 'dm-m1');
  assert.equal(turns.calls[1].guildId, 'g1');
  assert.deepEqual(store.bumps, [['g1', 'u1', TODAY]]);
});

/** A DM queued while busy elsewhere; `change` runs before the drain. Returns what the drain did. */
async function drainAfter(change, { privates = {} } = {}) {
  let busy = true;
  const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
  const profiles = { u1: { affinity: { score: 10 } } };
  const store = fakePrivateStore({ profiles, privates });
  const config = privateConfig();
  const channel = fakeDmChannel();
  const handler = makeDmHandler({ turns, store, config, sleep: async () => {} });
  await handler(fakeDmMessage({ channel }));
  await settle();
  assert.equal(turns.calls.length, 0, 'queued, not answered');

  change({ profiles, privates, config });
  busy = false;
  const { logs } = await withCapturedLogs(() => handler.drainPending());
  return { turns, store, channel, logs };
}

test('private: a queued DM whose author was forgotten meanwhile is dropped at drain time', async () => {
  const { turns, store, channel, logs } = await drainAfter(({ profiles }) => {
    delete profiles.u1; // /nep memory forget
  });
  assert.equal(turns.calls.length, 0);
  assert.deepEqual(store.bumps, []);
  assert.equal(channel.sent.length, 0);
  assert.equal(logs.find((l) => l.msg === 'private: dropped')?.reason, 'unknown');
});

test('private: a queued DM is dropped at drain time once the previous turn hit the cap, with the once-a-day notice', async () => {
  const { turns, store, channel, logs } = await drainAfter(({ privates }) => {
    privates.u1 = { replies: { day: TODAY, count: 100, noticedDay: '' } };
  });
  assert.equal(turns.calls.length, 0);
  assert.deepEqual(store.bumps, []);
  assert.equal(logs.find((l) => l.msg === 'private: dropped')?.reason, 'cap');
  assert.deepEqual(store.noticed, [['g1', 'u1', TODAY]]);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, 'limit reached (private.maxPerUserPerDay, 100/100)');
  assert.equal(channel.sent[0].reply.messageReference, 'dm-m1');
});

test('private: a queued DM is dropped at drain time when features.privateMessages was switched off', async () => {
  const { turns, store, channel, logs } = await drainAfter(({ config }) => {
    config.features.privateMessages = false;
  });
  assert.equal(turns.calls.length, 0);
  assert.deepEqual(store.bumps, []);
  assert.equal(channel.sent.length, 0);
  assert.equal(logs.find((l) => l.msg === 'private: dropped')?.reason, 'off');
});

test("private: the persona's own DM message is noted and observed privately under the partner's id", async () => {
  const turns = recordingTurns();
  const memory = fakeMemory();
  const channel = fakeDmChannel('dm1', 'u1');
  const handler = makeDmHandler({ turns, memory });
  const message = fakeDmMessage({ channel, author: { id: 'self1', bot: true, globalName: 'Neptunia', username: 'neptunia' } });
  await handler(message);
  await settle();

  assert.deepEqual(turns.notePostCalls, [['dm1', message.createdTimestamp]]);
  assert.equal(memory.observeCalls.length, 1);
  assert.equal(memory.observeCalls[0][0], 'g1');
  assert.equal(memory.observeCalls[0][1].self, true);
  assert.deepEqual(memory.observeCalls[0][2], { private: 'u1' });
  assert.equal(turns.calls.length, 0);
});

test("private: the persona's own DM message without a usable partner id is only noted", async () => {
  for (const [label, channel] of [
    ['missing', fakeDmChannel('dm1', 'u1', { recipientId: undefined })],
    ['self', fakeDmChannel('dm1', 'self1')],
  ]) {
    const turns = recordingTurns();
    const memory = fakeMemory();
    const handler = makeDmHandler({ turns, memory });
    const message = fakeDmMessage({ channel, author: { id: 'self1', bot: true, globalName: 'Neptunia', username: 'neptunia' } });
    await handler(message);
    await settle();
    assert.deepEqual(turns.notePostCalls, [['dm1', message.createdTimestamp]], label);
    assert.equal(memory.observeCalls.length, 0, label);
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

test('private: another bot in a DM is ignored', async () => {
  const turns = recordingTurns();
  const memory = fakeMemory();
  const handler = makeDmHandler({ turns, memory });
  await handler(fakeDmMessage({ author: { id: 'otherbot', bot: true, globalName: 'Other', username: 'other' } }));
  await settle();
  assert.equal(turns.calls.length, 0);
  assert.equal(memory.observeCalls.length, 0);
  assert.equal(turns.notePostCalls.length, 0);
});

// --- Limit notices on triggered guild turns ---------------------------------

function refusedTurns() {
  return recordingTurns({ outcome: 'refused', limit: { key: 'llm.maxRequestsPerDay', used: 800, cap: 800 } });
}

function sendingChannel(id = 'c1', guild = fakeGuild()) {
  const sent = [];
  const channel = fakeChannelWithMessage(id, guild, 'm1', {
    send: async (payload) => {
      sent.push(payload);
      return { id: 'notice1' };
    },
  });
  channel.sent = sent;
  return channel;
}

test('limits: a mention refused by a rail posts the notice as a plain reply to the trigger', async () => {
  const turns = refusedTurns();
  const guild = fakeGuild();
  const channel = sendingChannel('c1', guild);
  const handler = makeHandler({ turns, rng: scripted([0.99]), prompts: { labels } });
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));
  await settle();

  assert.equal(turns.calls.length, 1);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, 'limit reached (llm.maxRequestsPerDay, 800/800)');
  assert.deepEqual(channel.sent[0].allowedMentions, { parse: [] });
  assert.equal(channel.sent[0].reply.messageReference, 'm1');
});

test('limits: a pending mention refused at drain time posts the notice', async () => {
  let busy = true;
  const turns = recordingTurns(
    { outcome: 'refused', limit: { key: 'llm.maxRequestTokens', used: 51000, cap: 50000 } },
    { isAnyBusy: () => busy },
  );
  const guild = fakeGuild();
  const channel = sendingChannel('c1', guild);
  const handler = makeHandler({ turns, rng: scripted([0.5, 0.99]), sleep: async () => {}, prompts: { labels } });
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));
  busy = false;
  await handler.drainPending();

  assert.equal(turns.calls.length, 1);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, 'limit reached (llm.maxRequestTokens, 51000/50000)');
});

test('limits: a refusal with no limit, or another outcome, posts nothing', async () => {
  for (const result of [{ outcome: 'refused', limit: null }, { outcome: 'error' }, { outcome: 'skip' }]) {
    const guild = fakeGuild();
    const channel = sendingChannel('c1', guild);
    const handler = makeHandler({ turns: recordingTurns(result), rng: scripted([0.99]), prompts: { labels } });
    await handler(directPingMessage({ guild, channel, channelId: 'c1' }));
    await settle();
    assert.equal(channel.sent.length, 0, JSON.stringify(result));
  }
});

test('limits: in dry-run the notice is logged and mirrored, never sent to the channel', async () => {
  const guild = fakeGuild();
  const channel = sendingChannel('c1', guild);
  const mirrored = [];
  const client = { ...fakeClient(), channels: { fetch: async () => ({ send: async (payload) => mirrored.push(payload) }) } };
  const config = baseConfig({ features: { dryRun: true }, bot: { dryRunChannelId: 'mirror1' } });
  const handler = makeHandler({ config, client, turns: refusedTurns(), rng: scripted([0.99]), prompts: { labels } });
  const { logs } = await withCapturedLogs(async () => {
    await handler(directPingMessage({ guild, channel, channelId: 'c1' }));
    await settle();
  });
  assert.equal(channel.sent.length, 0);
  const line = logs.find((l) => l.msg === 'dry-run: would notify limit');
  assert.ok(line);
  assert.equal(line.key, 'llm.maxRequestsPerDay');
  assert.equal(line.used, 800);
  assert.equal(line.cap, 800);
  assert.equal(mirrored.length, 1);
  assert.deepEqual(mirrored[0].allowedMentions, { parse: [] });
});

test('limits: a follow-up turn refused by a rail posts the notice', async () => {
  const llm = fakeFollowUpLlm();
  const turns = refusedTurns();
  const guild = fakeGuild();
  const sent = [];
  const channel = fakeChannelWithHistory('c1', guild, [], {
    send: async (payload) => {
      sent.push(payload);
      return { id: 'notice1' };
    },
  });
  const handler = makeHandler({ turns, llm, prompts: fakeAddressPrompts() });
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const p = handler(fakeMessage({ id: 'm-candidate', guild, channel, channelId: 'c1', cleanContent: 'so what do you think' }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  llm.respond('yes');
  await p;
  await settle();

  assert.equal(turns.calls.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, 'limit reached (llm.maxRequestsPerDay, 800/800)');
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
  assert.equal(sent[0].reply, undefined, 'a follow-up never posts as a Discord reply, its notice neither');
});

// ---------------------------------------------------------------------------
// The address classifier sees media captions the describer already cached:
// a sticker- or picture-only answer is not a bare `[sticker: name]`.

/** A describer fake with the cache-only accessor; `describeMany` (the prefill) waits on `gate` when given. */
function fakeCachingDescriber(cached = new Map(), { gate } = {}) {
  const calls = [];
  const cachedCalls = [];
  return {
    calls,
    cachedCalls,
    describeMany: async (guildId, items) => {
      calls.push({ guildId, items });
      if (gate) await gate;
      return { descriptions: new Map(), newCount: 0 };
    },
    cachedDescriptions: (guildId, items) => {
      cachedCalls.push({ guildId, items });
      return new Map(items.filter((item) => cached.has(item.itemId)).map((item) => [item.itemId, cached.get(item.itemId)]));
    },
  };
}

function stickerOnlyMessage({ guild, channel, id = 'm-sticker' }) {
  return fakeMessage({
    id,
    guild,
    channel,
    channelId: channel.id,
    cleanContent: '',
    stickers: new Map([['s1', { id: 's1', name: 'pingo', format: 1 }]]),
  });
}

test('follow-up: a sticker-only candidate with a cached caption reaches the classifier with the caption', async () => {
  const llm = fakeFollowUpLlm();
  const describer = fakeCachingDescriber(new Map([['sticker:s1', 'a penguin waving hello']]));
  const config = baseConfig({ features: { mediaDescriptions: true } });
  const handler = makeHandler({ config, llm, describer, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const p = handler(stickerOnlyMessage({ guild, channel }));
  await tick();

  assert.equal(llm.calls.length, 1, 'only the classifier call; the cache read makes none');
  assert.match(llm.calls[0].messages[1].content, /<candidate>\n[^\n]*\[sticker: pingo: a penguin waving hello\]\n<\/candidate>/);
  assert.equal(describer.cachedCalls.length, 1);
  assert.equal(describer.cachedCalls[0].guildId, 'g1');
  assert.ok(describer.cachedCalls[0].items.some((item) => item.itemId === 'sticker:s1'));

  llm.respond('no');
  await p;
});

test('follow-up: a sticker-only candidate with no cached caption renders as a bare sticker, as before', async () => {
  const llm = fakeFollowUpLlm();
  const describer = fakeCachingDescriber();
  const config = baseConfig({ features: { mediaDescriptions: true } });
  const handler = makeHandler({ config, llm, describer, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const p = handler(stickerOnlyMessage({ guild, channel }));
  await tick();

  assert.equal(llm.calls.length, 1);
  assert.match(llm.calls[0].messages[1].content, /<candidate>\n[^\n]*\[sticker: pingo\]\n<\/candidate>/);

  llm.respond('no');
  await p;
});

test("follow-up: the classifier waits for the candidate's own picture prefill, with no second describe request", async () => {
  const llm = fakeFollowUpLlm();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const cached = new Map();
  const describer = fakeCachingDescriber(cached, { gate });
  const config = baseConfig({ features: { mediaDescriptions: true } });
  const handler = makeHandler({ config, llm, describer, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const p = handler(stickerOnlyMessage({ guild, channel }));
  await tick();
  assert.equal(describer.calls.length, 1, 'the prefill started');
  assert.equal(llm.calls.length, 0, 'the classifier is not asked while the prefill is in flight');

  cached.set('sticker:s1', 'a penguin waving hello');
  release();
  await tick();

  assert.equal(describer.calls.length, 1, 'the prefill is awaited, never repeated');
  assert.equal(llm.calls.length, 1);
  assert.match(llm.calls[0].messages[1].content, /\[sticker: pingo: a penguin waving hello\]/);

  llm.respond('no');
  await p;
});

test('follow-up: with mediaDescriptions off the describer is never consulted and the sticker stays bare', async () => {
  const llm = fakeFollowUpLlm();
  const describer = fakeCachingDescriber(new Map([['sticker:s1', 'a penguin waving hello']]));
  const config = baseConfig({ features: { mediaDescriptions: false } });
  const handler = makeHandler({ config, llm, describer, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const p = handler(stickerOnlyMessage({ guild, channel }));
  await tick();

  assert.equal(describer.calls.length, 0);
  assert.equal(describer.cachedCalls.length, 0);
  assert.match(llm.calls[0].messages[1].content, /\[sticker: pingo\]\n<\/candidate>/);

  llm.respond('no');
  await p;
});

// ---------------------------------------------------------------------------
// The address classifier -- the <author> block: who the candidate's author is
// known as (stored aliases, ranked, capped by mention.followUpAliases), so the
// classifier can connect a nickname in the persona's line to the member.

/** A stored profile whose aliases rank in the listed order (equal dates: rank follows weight). */
function profileWithAliases(id, names) {
  const seen = '2026-01-01T00:00:00.000Z';
  return {
    id,
    names: ['Ελένη'],
    aliases: names.map((name, i) => ({ name, weight: names.length - i, firstSeen: seen, lastSeen: seen })),
  };
}

/** The `<author>` line as `labels.address.author` renders it. */
function authorLine(name, aliases) {
  return labels.address.author.replace('{name}', name).replace('{aliases}', aliases);
}

/** Runs one candidate from `authorId` through an open window; resolves to the classifier's user message. */
async function classifierUserMessage({ store, config, prompts = fakeAddressPrompts(), authorId = 'u7', authorName = 'Ελένη' }) {
  const llm = fakeFollowUpLlm();
  const handler = makeHandler({ llm, prompts, store, config });
  const guild = fakeGuild('g1', 'Neptunia');
  const t0 = Date.now();
  const history = [rawHistoryMessage({ id: 'h1', authorId: 'u1', authorName: 'Alice', ts: t0, content: 'earlier message' })];
  const channel = fakeChannelWithHistory('c1', guild, history);
  await openFollowUpWindow(handler, { guild, channel, ts: t0 + 1000 });
  const msg = fakeMessage({
    id: 'm-candidate',
    guild,
    channel,
    channelId: 'c1',
    author: { id: authorId, bot: false, globalName: authorName, username: 'el' },
    member: { displayName: authorName },
    cleanContent: 'and you too',
    createdTimestamp: t0 + 2000,
  });
  const p = handler(msg);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(llm.calls.length, 1, 'the classifier was asked');
  const user = llm.calls[0].messages[1].content;
  llm.respond('no');
  await p;
  return user;
}

test('follow-up author: the request carries an <author> block with the top-ranked aliases, capped at mention.followUpAliases', async () => {
  const aliases = ['Λένα', 'Ελενάκι', 'Nélé', 'Lèna', 'Hélène', 'Éli', 'Nènè'];
  const store = fakeStore({ u7: profileWithAliases('u7', aliases) });
  const user = await classifierUserMessage({ store });

  const line = authorLine('Ελένη', 'Λένα, Ελενάκι, Nélé, Lèna, Hélène');
  assert.ok(user.includes(`<author>\n${line}\n</author>`), 'the default followUpAliases (5), best rank first');
  assert.ok(!user.includes('Éli') && !user.includes('Nènè'), 'aliases past the cap are left out');
  const authorAt = user.indexOf('<author>');
  assert.ok(authorAt > user.indexOf('earlier message'), 'after the transcript');
  assert.ok(authorAt < user.indexOf('<candidate>'), 'before the candidate');
  assert.deepEqual(store.getUserCalls, [['g1', 'u7']], 'the candidate author profile, read once');
});

test('follow-up author: ranking decays with memory.aliasHalfLifeDays, like the persona request', async () => {
  const profile = {
    id: 'u7',
    names: ['Ελένη'],
    aliases: [
      { name: 'Λένα', weight: 2, firstSeen: '2020-01-01T00:00:00.000Z', lastSeen: '2020-01-01T00:00:00.000Z' },
      { name: 'Nélé', weight: 1, firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z' },
    ],
  };
  const user = await classifierUserMessage({ store: fakeStore({ u7: profile }) });
  assert.ok(user.includes(authorLine('Ελένη', 'Nélé, Λένα')),'the recent alias outranks the old heavier one');
});

test('follow-up author: a profile without aliases, or no stored profile, adds no <author> block', async () => {
  const cases = [
    { label: 'a profile without aliases', profiles: { u7: { id: 'u7', names: ['Ελένη'], aliases: [] } } },
    { label: 'no stored profile', profiles: {} },
  ];
  for (const { label, profiles } of cases) {
    const store = fakeStore(profiles);
    const user = await classifierUserMessage({ store });
    assert.ok(!user.includes('<author>'), `${label}: no <author> block`);
    assert.ok(user.includes('<candidate>') && user.includes('and you too'), `${label}: the candidate is still sent`);
    assert.deepEqual(store.getUserCalls, [['g1', 'u7']], `${label}: the candidate author's profile, read once`);
  }
});

test('follow-up author: followUpAliases 0 adds no <author> block', async () => {
  const store = fakeStore({ u7: profileWithAliases('u7', ['Λένα']) });
  const user = await classifierUserMessage({ store, config: baseConfig({ mention: { followUpAliases: 0 } }) });
  assert.ok(!user.includes('<author>'));
});

test('follow-up author: without labels.address.author the block is omitted', async () => {
  const store = fakeStore({ u7: profileWithAliases('u7', ['Λένα']) });
  const prompts = { ...fakeAddressPrompts(), labels: { ...labels, address: undefined } };
  const user = await classifierUserMessage({ store, prompts });
  assert.ok(!user.includes('<author>'));
  assert.ok(!user.includes('Λένα'));
});

test('follow-up author: reading the profile writes nothing', async () => {
  const profile = profileWithAliases('u7', ['Λένα', 'Ελενάκι']);
  const before = structuredClone(profile);
  const touched = [];
  const base = fakeStore({ u7: profile });
  const store = new Proxy(base, {
    get(target, key) {
      if (key !== 'getUser' && key !== 'getUserCalls' && typeof key === 'string') touched.push(key);
      return target[key];
    },
  });
  const user = await classifierUserMessage({ store });
  assert.ok(user.includes('<author>'));
  assert.deepEqual(profile, before, 'the stored profile is unchanged');
  assert.deepEqual(touched.filter((key) => key !== 'state' && key !== 'then'), [], 'no store method other than getUser');
});

// ---------------------------------------------------------------------------
// Audit fixes: the follow-up gate and one attention, the drain under a pause,
// forwards, classifier failures, the drain re-checking switches, embed text.

test('follow-up: with one attention and mention.classifyWhileBusy off, a turn running in another channel skips the classifier (no paid call)', async () => {
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const turns = fakeTurns({ isBusy: () => false, isAnyBusy: () => true });
  const config = baseConfig({ mention: { classifyWhileBusy: false } });
  const handler = makeHandler({ config, turns, spontaneous, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const p = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'plain follow-up' }));
  await tick();
  assert.equal(llm.calls.length, 0, 'busy elsewhere: the classifier is never asked');
  await p;
  assert.equal(spontaneous.onMessageCalls.length, 1, 'falls back to the usual handling');
});

test('follow-up: with mention.oneAtATime off, a turn in another channel does not block the classifier', async () => {
  const llm = fakeFollowUpLlm();
  const config = baseConfig({ mention: { oneAtATime: false } });
  const turns = fakeTurns({ isBusy: () => false, isAnyBusy: () => true });
  const handler = makeHandler({ config, turns, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const p = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'plain follow-up' }));
  await tick();
  assert.equal(llm.calls.length, 1);
  llm.respond('no');
  await p;
});

test('follow-up: a "yes" that finds a turn started elsewhere runs no turn now: it is deferred, and with mention.classifyWhileBusy off the held message says busy', async () => {
  const llm = fakeFollowUpLlm();
  let anyBusy = false;
  const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => anyBusy });
  const config = baseConfig({ mention: { classifyWhileBusy: false } });
  const handler = makeHandler({ config, turns, llm, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const { logs } = await withCapturedLogs(async () => {
    const p1 = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'first', authorId: 'u1', authorName: 'Alice' }));
    await tick();
    await handler(plainFollowUpMessage({ id: 'm2', guild, channel, content: 'second' }));
    anyBusy = true; // a turn started in another channel while the classifier was thinking
    llm.respond('yes');
    await p1;
    await tick();
  });

  assert.equal(turns.calls.length, 0, 'no turn while another one is running');
  assert.equal(llm.calls.length, 1, 'the held message is not classified either');
  assert.equal(logs.some((l) => l.msg === 'follow-up: dropped'), false, 'the "yes" is not lost');
  const deferred = logs.find((l) => l.msg === 'follow-up: deferred');
  assert.ok(deferred, 'the "yes" waits in the pending queue');
  assert.equal(deferred.channel, 'c1');
  assert.equal(deferred.message, 'm1');
  const held = logs.find((l) => l.msg === 'follow-up: held message dropped');
  assert.equal(held?.reason, 'busy', 'no turn ran, so the held message is not dropped as "turn"');
});

// ---------------------------------------------------------------------------
// A follow-up "yes" that found the attention taken waits in the pending
// queue like a direct call, and is picked up when the running turn ends.

/**
 * Turns whose attention is taken in `busyIn` while `.busy` is true: runTurn records every call and
 * answers 'spoke'; busyChannels names the running turn's channel.
 */
function attentionTurns(busyIn = 'c9') {
  const calls = [];
  const turns = fakeTurns({
    isBusy: (id) => turns.busy && id === busyIn,
    isAnyBusy: () => turns.busy,
    runTurn: async (args) => {
      calls.push(args);
      return { outcome: 'spoke' };
    },
  });
  turns.busy = false;
  turns.busyChannels = () => (turns.busy ? [busyIn] : []);
  turns.calls = calls;
  return turns;
}

const FOLLOW_UP_T0 = 1_000_000;

/**
 * A follow-up window opened in c1 at FOLLOW_UP_T0, then one message per answer in `answers`
 * (`m1`, `m2`, ... by u1, a second apart), each classified while a turn starts in `busyIn`: the
 * attention is free when the message arrives and taken before the verdict comes back.
 * `beforeAnswer` runs right before each answer.
 */
async function deferredFollowUps({ answers = ['yes'], busyIn = 'c9', config = baseConfig(), beforeAnswer, tagHistory, missed } = {}) {
  const clock = mutableNow(FOLLOW_UP_T0);
  const llm = fakeFollowUpLlm();
  const turns = attentionTurns(busyIn);
  const handler = makeHandler({ config, turns, llm, tagHistory, now: clock, sleep: async () => {}, rng: () => 0.5, prompts: fakeAddressPrompts(), missed });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: FOLLOW_UP_T0 });
  const { logs } = await withCapturedLogs(async () => {
    for (const [i, answer] of answers.entries()) {
      const id = `m${i + 1}`;
      const ts = FOLLOW_UP_T0 + (i + 1) * 1000;
      clock.set(ts);
      channel.messages.cache.set(id, {});
      turns.busy = false;
      const p = handler(plainFollowUpMessage({ id, guild, channel, content: 'and then?', authorId: 'u1', authorName: 'Élodie', ts }));
      await tick();
      turns.busy = true; // the turn started while the classifier was thinking
      beforeAnswer?.();
      llm.respond(answer);
      await p;
      await tick();
    }
  });
  return { clock, llm, turns, handler, guild, channel, logs };
}

/** The running turn ends and the drain runs (onIdle): resolves the drain's log lines. */
async function endTurnAndDrain(scene) {
  scene.turns.busy = false;
  const { logs } = await withCapturedLogs(() => scene.handler.drainPending());
  return logs;
}

test('follow-up: a "yes" during a turn elsewhere is deferred, then picked up and answered once the turn ends', async () => {
  const tagHistory = countingTagHistory();
  const scene = await deferredFollowUps({ tagHistory });
  assert.equal(scene.turns.calls.length, 0, 'no turn while the attention is taken');
  assert.equal(tagHistory.hits, 0, 'counted when picked up, not on deferral');
  const deferred = scene.logs.filter((l) => l.msg === 'follow-up: deferred');
  assert.deepEqual(
    deferred.map(({ channel, author, message, runningIn, sameChannel }) => [channel, author, message, runningIn, sameChannel]),
    [['c1', 'u1', 'm1', 'c9', false]],
  );

  const logs = await endTurnAndDrain(scene);
  assert.deepEqual(
    logs.filter((l) => l.msg === 'follow-up: picked up').map((l) => [l.channel, l.kind, l.message]),
    [['c1', 'followUp', 'm1']],
  );
  assert.deepEqual(logs.filter((l) => l.msg === 'mention: decided').map(({ kind, reason, deferred }) => [kind, reason, deferred]), [['followUp', 'respond', true]], 'rolled once, when picked up');
  assert.equal(scene.turns.calls.length, 1);
  const [call] = scene.turns.calls;
  assert.equal(call.channel, scene.channel);
  assert.equal(call.mode, 'reply');
  assert.equal(call.triggerKind, 'followUp');
  assert.equal(call.trigger.id, 'm1');
  assert.equal(tagHistory.hits, 1);
});

test('follow-up: a deferred "yes" the followUpIgnoreChance roll lets pass runs no turn when picked up', async () => {
  const tagHistory = countingTagHistory();
  const config = baseConfig({ mention: { ignoreChance: 0, followUpIgnoreChance: 1 } });
  const scene = await deferredFollowUps({ config, tagHistory });
  const logs = await endTurnAndDrain(scene);
  assert.deepEqual(
    logs.filter((l) => l.msg === 'mention: decided').map(({ kind, reason, deferred }) => [kind, reason, deferred]),
    [['followUp', 'ignored:follow-up', true]],
  );
  assert.equal(scene.turns.calls.length, 0);
  assert.equal(tagHistory.hits, 1, 'still counted for spam');
});

test('follow-up: a live "yes" the followUpIgnoreChance roll lets pass runs no turn and leaves the window open', async () => {
  const tagHistory = countingTagHistory();
  const llm = fakeFollowUpLlm();
  const turns = recordingTurns();
  const store = fakeStateStore();
  const config = baseConfig({ mention: { ignoreChance: 0, followUpIgnoreChance: 1, followUpNoStreak: 1 } });
  const handler = makeHandler({ config, turns, llm, tagHistory, store, rng: () => 0.5, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const { logs } = await withCapturedLogs(async () => {
    const p = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'and then?' }));
    await tick();
    llm.respond('yes');
    await p;
  });
  assert.equal(turns.calls.length, 0);
  assert.deepEqual(
    logs.filter((l) => l.msg === 'mention: decided').map(({ kind, reason }) => [kind, reason]),
    [['followUp', 'ignored:follow-up']],
  );
  assert.equal(tagHistory.hits, 1, 'still counted for spam');
  assert.equal(store.state.data.followUpWindows.c1.noStreak, 0, 'the no-streak is not bumped');
  assert.equal(logs.some((l) => l.msg === 'follow-up: window closed'), false);

  // The window is still open: the next line goes to the classifier again.
  const p2 = handler(plainFollowUpMessage({ id: 'm2', guild, channel, content: 'well?' }));
  await tick();
  assert.equal(llm.calls.length, 2);
  llm.respond('no');
  await p2;
});

test('follow-up: an "overheard" answer is never rolled for followUpIgnoreChance', async () => {
  const config = baseConfig({ mention: { followUpIgnoreChance: 1 } });
  const { llm, handler, guild, channel, turns } = await overheardScene({ config });
  const { logs } = await withCapturedLogs(async () => {
    const p = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'she always says that' }));
    await tick();
    llm.respond('overheard');
    await p;
  });
  assert.deepEqual(turns.calls.map((c) => c.triggerKind), ['overheard']);
  assert.equal(logs.some((l) => l.msg === 'mention: decided'), false);
});

test('follow-up: a "yes" during a spontaneous turn in its own channel that ends not-now is answered after it', async () => {
  const scene = await deferredFollowUps({ busyIn: 'c1' });
  const deferred = scene.logs.find((l) => l.msg === 'follow-up: deferred');
  assert.equal(deferred?.runningIn, 'c1');
  assert.equal(deferred.sameChannel, true);
  assert.equal(scene.turns.calls.length, 0);

  // The spontaneous turn ends not-now: nothing was posted, the window is as it was.
  const logs = await endTurnAndDrain(scene);
  assert.deepEqual(followUpDropped(logs), []);
  assert.equal(scene.turns.calls.length, 1);
  assert.equal(scene.turns.calls[0].trigger.id, 'm1');
  assert.equal(scene.turns.calls[0].triggerKind, 'followUp');
});

test('follow-up: a line that arrived after the running turn fetched its history is drained, not dropped as answered', async () => {
  const scene = await deferredFollowUps({ busyIn: 'c1' });
  // The running turn in c1 posts after the line, from a history fetched before it arrived.
  await openFollowUpWindow(scene.handler, { guild: scene.guild, channel: scene.channel, ts: FOLLOW_UP_T0 + 5000 });
  scene.turns.spokeAfterSeeing = () => false;
  const logs = await endTurnAndDrain(scene);
  assert.deepEqual(followUpDropped(logs), []);
  assert.deepEqual(startedTurns(scene.turns), [['m1', 'followUp']]);
});

test('follow-up: a deferred "yes" is dropped when its window closed while it waited', async () => {
  const config = baseConfig({ mention: { followUpMinutes: 5, pendingMinutes: 10 } });
  const scene = await deferredFollowUps({ config });
  scene.clock.set(FOLLOW_UP_T0 + 6 * 60_000); // past the window, not past pendingMinutes
  const logs = await endTurnAndDrain(scene);
  assert.equal(scene.turns.calls.length, 0);
  assert.deepEqual(followUpDropped(logs), [['m1', 'closed']]);
});

test('follow-up: a deferred "yes" replaced by a newer one is a replaced-deferred fact with both ids', async () => {
  const missed = recordingMissed();
  await deferredFollowUps({ answers: ['yes', 'yes'], missed });
  assert.deepEqual(missed.facts.map((f) => [f.reason, f.message.id, f.replacedBy]), [['replaced-deferred', 'm1', 'm2']]);
  assert.equal(missed.facts[0].message.authorId, 'u1');
});

test('follow-up: a newer deferred "yes" in the same channel replaces the older one', async () => {
  const scene = await deferredFollowUps({ answers: ['yes', 'yes'] });
  assert.deepEqual(scene.logs.filter((l) => l.msg === 'follow-up: deferred').map((l) => l.message), ['m1', 'm2']);
  assert.deepEqual(followUpDropped(scene.logs), [['m1', 'newer']]);

  await endTurnAndDrain(scene);
  assert.deepEqual(scene.turns.calls.map((c) => c.trigger.id), ['m2']);
});

test('follow-up: with features.followUp turned off before the "yes" meets the running turn, nothing is deferred', async () => {
  const config = baseConfig();
  const scene = await deferredFollowUps({ config, beforeAnswer: () => (config.features.followUp = false) });
  assert.equal(scene.logs.some((l) => l.msg === 'follow-up: deferred'), false);
  assert.deepEqual(followUpDropped(scene.logs), [['m1', 'busy']]);
  await endTurnAndDrain(scene);
  assert.equal(scene.turns.calls.length, 0);
});

test('follow-up: pendingOverheard off drops it as before', async () => {
  const scene = await deferredFollowUps({ answers: ['overheard'], config: baseConfig({ mention: { pendingOverheard: false } }) });
  assert.equal(scene.logs.some((l) => l.msg === 'follow-up: deferred'), false);
  assert.deepEqual(followUpDropped(scene.logs), [['m1', 'busy']]);
  await endTurnAndDrain(scene);
  assert.equal(scene.turns.calls.length, 0);
});

// ---------------------------------------------------------------------------
// The address classifier's third answer: "overheard", a line about the
// persona said to someone else or to the room (mention.followUpOverheard).

/** Opens a follow-up window in c1 and returns the pieces an overheard test needs. */
async function overheardScene({ config, turns = recordingTurns(), tagHistory, channelOverrides, store, now } = {}) {
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ config, turns, spontaneous, tagHistory, llm, store, now, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, [], channelOverrides);
  await openFollowUpWindow(handler, { guild, channel, ts: (now ?? Date.now)() });
  return { llm, spontaneous, handler, guild, channel, turns };
}

test('follow-up: an "overheard" answer runs a reply turn with triggerKind overheard on the candidate', async () => {
  const { llm, spontaneous, handler, guild, channel, turns } = await overheardScene();

  const p = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'she always says that' }));
  await tick();
  llm.respond('Overheard.');
  await p;

  assert.equal(turns.calls.length, 1);
  assert.equal(turns.calls[0].mode, 'reply');
  assert.equal(turns.calls[0].triggerKind, 'overheard');
  assert.equal(turns.calls[0].trigger.id, 'm1');
  assert.equal(turns.calls[0].channel, channel);
  assert.equal(spontaneous.onMessageCalls.length, 0);
});

test('follow-up: with mention.followUpOverheard off (read hot) an "overheard" answer runs a plain followUp turn', async () => {
  const config = baseConfig();
  const tagHistory = countingTagHistory();
  const { llm, handler, guild, channel, turns } = await overheardScene({ config, tagHistory });
  config.mention.followUpOverheard = false;

  const { logs } = await withCapturedLogs(async () => {
    const p = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'she always says that' }));
    await tick();
    llm.respond('overheard');
    await p;
  });

  assert.equal(turns.calls.length, 1);
  assert.equal(turns.calls[0].triggerKind, 'followUp');
  assert.equal(tagHistory.hits, 1, 'counted like any follow-up');
  assert.equal(logs.find((l) => l.msg === 'follow-up: verdict').answer, 'overheard', 'the log keeps the real answer');
});

test('follow-up: verdict logs the answer (yes, overheard, no) next to the two-way verdict', async () => {
  for (const [text, answer, verdict] of [['yes', 'yes', 'yes'], ['overheard', 'overheard', 'yes'], ['no', 'no', 'no'], ['about', 'no', 'no']]) {
    const { llm, handler, guild, channel } = await overheardScene();
    const { logs } = await withCapturedLogs(async () => {
      const p = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'λοιπόν' }));
      await tick();
      llm.respond(text);
      await p;
    });
    const line = logs.find((l) => l.msg === 'follow-up: verdict');
    assert.equal(line.answer, answer, text);
    assert.equal(line.verdict, verdict, text);
  }
});

test('follow-up: a pre-filtered or prompt-less "no" logs answer no too', async () => {
  const { handler, guild, channel } = await overheardScene();
  const { logs } = await withCapturedLogs(() =>
    handler(fakeMessage({ guild, channel, channelId: 'c1', cleanContent: '@Bob look', mentions: { users: new Map([['u2', { id: 'u2' }]]) } })),
  );
  assert.equal(logs.find((l) => l.msg === 'follow-up: verdict').answer, 'no');

  const spontaneous = fakeSpontaneous();
  const missing = makeHandler({ spontaneous, llm: fakeFollowUpLlm(), prompts: { ...fakeAddressPrompts(), address: undefined } });
  await openFollowUpWindow(missing, { guild, channel, ts: Date.now() });
  const second = await withCapturedLogs(() => missing(plainFollowUpMessage({ id: 'm2', guild, channel, content: 'λοιπόν' })));
  assert.equal(second.logs.find((l) => l.msg === 'follow-up: verdict').answer, 'no');
});

test('follow-up: an "overheard" answer neither bumps the no-streak nor counts toward tagHistory; a "yes" still counts', async () => {
  const tagHistory = countingTagHistory();
  const { llm, handler, guild, channel, turns } = await overheardScene({ tagHistory });

  for (let i = 0; i < 3; i += 1) {
    const p = handler(plainFollowUpMessage({ id: `m${i}`, guild, channel, content: `she ${i}` }));
    await tick();
    llm.respond('overheard');
    await p;
  }
  assert.equal(turns.calls.length, 3);
  assert.equal(tagHistory.hits, 0, 'talk about the persona is not a call to it');

  const p4 = handler(plainFollowUpMessage({ id: 'm4', guild, channel, content: 'and you?' }));
  await tick();
  assert.equal(llm.calls.length, 4, 'three overheard answers in a row keep the window open');
  llm.respond('yes');
  await p4;
  assert.equal(tagHistory.hits, 1, 'a "yes" is still counted');
  assert.deepEqual(turns.calls.map((c) => c.triggerKind), ['overheard', 'overheard', 'overheard', 'followUp']);
});

test('follow-up: with mention.pendingOverheard off, an "overheard" answer that finds a turn started elsewhere runs no turn and is dropped as busy', async () => {
  let anyBusy = false;
  const { llm, handler, guild, channel, turns } = await overheardScene({
    config: baseConfig({ mention: { pendingOverheard: false } }),
    turns: recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => anyBusy }),
  });

  const { logs } = await withCapturedLogs(async () => {
    const p = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'she again' }));
    await tick();
    anyBusy = true;
    llm.respond('overheard');
    await p;
  });

  assert.equal(turns.calls.length, 0);
  const dropped = logs.find((l) => l.msg === 'follow-up: dropped');
  assert.equal(dropped?.reason, 'busy');
  assert.equal(dropped.message, 'm1');
});

test('limits: an overheard turn refused by a rail posts no notice', async () => {
  const sent = [];
  const send = async (payload) => {
    sent.push(payload);
    return { id: 'notice1' };
  };
  const { llm, handler, guild, channel, turns } = await overheardScene({ turns: refusedTurns(), channelOverrides: { send } });

  const p = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'she again' }));
  await tick();
  llm.respond('overheard');
  await p;
  await settle();

  assert.equal(turns.calls.length, 1);
  assert.equal(turns.calls[0].triggerKind, 'overheard');
  assert.equal(sent.length, 0, 'nobody asked: no limit notice');
});

/**
 * m1 is classified; m2 arrives meanwhile and is held (`held`: its content, every other key spread
 * onto the message). `beforeAnswer` runs right before m1's answer `first` comes back; the rest of
 * the options go to overheardScene. Resolves once that answer was settled.
 */
async function overheardWithHeld({ first = 'overheard', held = { content: 'and you, what do you say?' }, beforeAnswer, ...sceneOptions } = {}) {
  const scene = await overheardScene(sceneOptions);
  const { llm, handler, guild, channel } = scene;
  const ts = (sceneOptions.now ?? Date.now)();
  const { content, ...heldExtra } = held;
  const captured = await withCapturedLogs(async () => {
    const p1 = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'she always says that', authorId: 'u1', authorName: 'Élodie', ts }));
    await tick();
    await handler({ ...plainFollowUpMessage({ id: 'm2', guild, channel, content, ts }), ...heldExtra });
    beforeAnswer?.();
    llm.respond(first);
    await p1;
    await tick();
  });
  return { ...scene, logs: captured.logs };
}

/** overheardWithHeld, then m3 arrives while m2's call is pending and is held in its turn. */
async function overheardChain(options = {}) {
  const scene = await overheardWithHeld(options);
  const { llm, handler, guild, channel } = scene;
  assert.equal(llm.calls.length, 2, 'm2 is being classified');
  const { logs } = await withCapturedLogs(() =>
    handler(plainFollowUpMessage({ id: 'm3', guild, channel, content: 'μάλλον', authorId: 'u3', authorName: 'Chloé' })),
  );
  assert.deepEqual(heldLines(logs), ['m3'], 'm3 is held behind m2');
  return { ...scene, logs: [...scene.logs, ...logs] };
}

/** Answers every classifier call in flight with `text`, then lets the held messages move: the log lines it caused. */
async function answerFollowUp(llm, text) {
  const { logs } = await withCapturedLogs(async () => {
    llm.respond(text);
    await tick();
  });
  return logs;
}

const heldLines = (logs) => logs.filter((l) => l.msg === 'follow-up: held while a classifier call is in flight').map((l) => l.message);
const heldDropped = (logs) => logs.filter((l) => l.msg === 'follow-up: held message dropped').map((l) => [l.message, l.reason]);
const followUpDropped = (logs) => logs.filter((l) => l.msg === 'follow-up: dropped').map((l) => [l.message, l.reason]);
const startedTurns = (turns) => turns.calls.map((c) => [c.trigger.id, c.triggerKind]);

test('follow-up: a message held during an "overheard" call is classified before any turn; a "yes" on it starts the follow-up turn for it', async () => {
  const { llm, turns, logs } = await overheardWithHeld();

  assert.equal(turns.calls.length, 0, 'no turn before the held message is classified');
  assert.equal(llm.calls.length, 2);
  assert.match(llm.calls[1].messages[1].content, /<candidate>[\s\S]*and you, what do you say\?[\s\S]*<\/candidate>/);
  assert.equal(logs.some((l) => l.msg === 'follow-up: held message dropped'), false);

  const { logs: after } = await withCapturedLogs(async () => {
    llm.respond('yes');
    await tick();
  });
  assert.deepEqual(turns.calls.map((c) => [c.trigger.id, c.triggerKind]), [['m2', 'followUp']]);
  const dropped = after.find((l) => l.msg === 'follow-up: dropped');
  assert.deepEqual([dropped?.message, dropped?.reason], ['m1', 'newer'], 'the overheard line gives way to the newer one');
});

test('follow-up: an "overheard" answer on the held message starts the overheard turn for that newer line', async () => {
  const { llm, turns } = await overheardWithHeld({ held: { content: 'yes, she does that' } });
  assert.equal(turns.calls.length, 0);
  llm.respond('overheard');
  await tick();
  assert.deepEqual(turns.calls.map((c) => [c.trigger.id, c.triggerKind]), [['m2', 'overheard']]);
});

test('follow-up: a "no" on the held message starts the overheard turn for the original candidate', async () => {
  const { llm, turns } = await overheardWithHeld({ held: { content: 'anyway, lunch?' } });
  assert.equal(turns.calls.length, 0);
  llm.respond('no');
  await tick();
  assert.deepEqual(turns.calls.map((c) => [c.trigger.id, c.triggerKind]), [['m1', 'overheard']]);
});

test('follow-up: a message the pre-filter answers "no" on arrival is never held: the overheard turn starts right away', async () => {
  const { llm, turns, logs } = await overheardWithHeld({
    held: { content: '@Carol look', mentions: { users: new Map([['u3', { id: 'u3' }]]) } },
  });
  assert.equal(llm.calls.length, 1, 'the pre-filter answers without the model');
  assert.deepEqual(heldLines(logs), [], 'answered before the in-flight check, nothing is held');
  assert.deepEqual(turns.calls.map((c) => [c.trigger.id, c.triggerKind]), [['m1', 'overheard']]);
});

test('follow-up: a held message the pre-filter answers "no" on its re-check lets the overheard turn start for the original candidate', async () => {
  const config = baseConfig();
  const { llm, turns, logs } = await overheardWithHeld({
    config,
    // A reply to another member reaches the classifier on arrival, so it is held...
    held: { content: 'right?', reference: { messageId: 'm-other' } },
    // ...and replies are pre-filtered by the time m1's answer comes back.
    beforeAnswer: () => {
      config.mention.followUpClassifyReplies = false;
    },
  });
  assert.deepEqual(heldLines(logs), ['m2'], 'm2 was really held');
  assert.equal(llm.calls.length, 1, 'the pre-filter answers without the model');
  const verdicts = logs.filter((l) => l.msg === 'follow-up: verdict').map((l) => [l.author, l.answer]);
  assert.deepEqual(verdicts, [['u1', 'overheard'], ['u2', 'no']]);
  assert.deepEqual(heldDropped(logs), []);
  assert.deepEqual(startedTurns(turns), [['m1', 'overheard']]);
});

test('follow-up: with mention.followUpOverheard off, an "overheard" answer drops the held message like a "yes"', async () => {
  const { llm, turns, logs } = await overheardWithHeld({ config: baseConfig({ mention: { followUpOverheard: false } }) });
  assert.equal(llm.calls.length, 1, 'the held message is not classified');
  assert.deepEqual(turns.calls.map((c) => [c.trigger.id, c.triggerKind]), [['m1', 'followUp']]);
  assert.equal(logs.find((l) => l.msg === 'follow-up: held message dropped')?.reason, 'turn');
});

test('follow-up: mention.followUpOverheard switched off while an overheard line waits on a held message starts a followUp turn for it', async () => {
  const config = baseConfig();
  const tagHistory = countingTagHistory();
  const { llm, turns } = await overheardWithHeld({ config, tagHistory });
  assert.equal(llm.calls.length, 2, 'the held message is being classified');
  assert.equal(turns.calls.length, 0, 'the overheard line waits on it');

  // The owner turns the overheard kind off before the held message's verdict lands.
  config.mention.followUpOverheard = false;
  const logs = await answerFollowUp(llm, 'no');

  assert.deepEqual(startedTurns(turns), [['m1', 'followUp']], 'the kind is read when the waiting line starts');
  assert.deepEqual(followUpDropped(logs), []);
  assert.equal(tagHistory.hits, 1, 'counted like any follow-up');
});

// The waiting overheard line starts after at least one more classifier call: the
// gate's checks that do not depend on the window are read again at that moment.
// [what the test calls it, the logged reason, () => ({ options for the scene, block() })]
const WAITING_LINE_BLOCKERS = [
  [
    'the bot is paused',
    'paused',
    () => {
      const store = fakeStateStore();
      return { options: { store }, block: () => (store.state.data.paused = true) };
    },
  ],
  [
    'features.followUp is off',
    'off',
    () => {
      const config = baseConfig();
      return { options: { config }, block: () => (config.features.followUp = false) };
    },
  ],
  [
    'features.mentions is off',
    'off',
    () => {
      const config = baseConfig();
      return { options: { config }, block: () => (config.features.mentions = false) };
    },
  ],
  [
    'the bot lost Send Messages',
    'cannot-send',
    () => {
      let sendAllowed = true;
      const permissionsFor = () => ({ has: (flag) => sendAllowed || flag !== PermissionFlagsBits.SendMessages });
      return { options: { channelOverrides: { permissionsFor } }, block: () => (sendAllowed = false) };
    },
  ],
];

for (const [when, reason, makeBlocker] of WAITING_LINE_BLOCKERS) {
  test(`follow-up: an overheard line waiting on a held message is dropped as ${reason} when ${when} meanwhile`, async () => {
    const { options, block } = makeBlocker();
    const { llm, turns } = await overheardWithHeld(options);
    assert.equal(llm.calls.length, 2, 'the held message is being classified');

    block();
    const logs = await answerFollowUp(llm, 'no');
    assert.equal(turns.calls.length, 0, 'no turn starts');
    assert.deepEqual(followUpDropped(logs), [['m1', reason]]);
  });

  test(`follow-up: when ${when}, the held message and the overheard line waiting on it are both dropped as ${reason}`, async () => {
    const { options, block } = makeBlocker();
    const { llm, turns, logs } = await overheardWithHeld({ ...options, beforeAnswer: block });
    assert.equal(llm.calls.length, 1, 'the held message is not classified');
    assert.equal(turns.calls.length, 0, 'no turn starts');
    assert.deepEqual(heldDropped(logs), [['m2', reason]]);
    assert.deepEqual(followUpDropped(logs), [['m1', reason]]);
  });
}

test('follow-up: with mention.classifyWhileBusy and mention.pendingOverheard off, a held message dropped as busy drops the overheard line waiting on it as busy too', async () => {
  let anyBusy = false;
  const { llm, turns, logs } = await overheardWithHeld({
    config: baseConfig({ mention: { classifyWhileBusy: false, pendingOverheard: false } }),
    turns: recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => anyBusy }),
    beforeAnswer: () => (anyBusy = true),
  });
  assert.equal(llm.calls.length, 1, 'the held message is not classified');
  assert.equal(turns.calls.length, 0, 'no turn starts');
  assert.deepEqual(heldDropped(logs), [['m2', 'busy']]);
  assert.deepEqual(followUpDropped(logs), [['m1', 'busy']]);
});

test('follow-up: with mention.pendingOverheard off, an overheard line that waited meets a turn started elsewhere: dropped as busy, no turn', async () => {
  let anyBusy = false;
  const { llm, turns } = await overheardWithHeld({
    config: baseConfig({ mention: { pendingOverheard: false } }),
    turns: recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => anyBusy }),
  });
  assert.equal(llm.calls.length, 2, 'the held message is being classified');

  anyBusy = true;
  const logs = await answerFollowUp(llm, 'no');
  assert.equal(turns.calls.length, 0, 'no turn starts');
  assert.deepEqual(followUpDropped(logs), [['m1', 'busy']]);
});

test('follow-up: a held message dropped because the window expired lets the overheard line waiting on it start', async () => {
  const clock = mutableNow(0);
  const { llm, turns, logs } = await overheardWithHeld({ now: clock, beforeAnswer: () => clock.set(16 * 60_000) });
  assert.equal(llm.calls.length, 1, 'the held message is not classified');
  assert.deepEqual(heldDropped(logs), [['m2', 'closed']]);
  assert.deepEqual(followUpDropped(logs), []);
  assert.deepEqual(startedTurns(turns), [['m1', 'overheard']], 'classified while the window was open, it still gets its turn');
});

test('follow-up: a message held while the held one is classified is classified too before the waiting overheard line starts', async () => {
  const { llm, turns, handler, guild, channel } = await overheardChain();

  await answerFollowUp(llm, 'no');
  assert.equal(llm.calls.length, 3, 'm3 is classified next');
  assert.match(llm.calls[2].messages[1].content, /<candidate>[\s\S]*μάλλον[\s\S]*<\/candidate>/);
  assert.equal(turns.calls.length, 0, 'm1 still waits');

  const logs = await answerFollowUp(llm, 'no');
  assert.deepEqual(startedTurns(turns), [['m1', 'overheard']]);
  assert.deepEqual(followUpDropped(logs), []);

  // The slot is free again: the next plain message is classified as usual.
  await withCapturedLogs(async () => {
    const p4 = handler(plainFollowUpMessage({ id: 'm4', guild, channel, content: 'λοιπόν' }));
    await tick();
    assert.equal(llm.calls.length, 4);
    llm.respond('no');
    await p4;
  });
});

for (const [answer, expected] of [
  ['yes', [['m3', 'followUp']]],
  ['overheard', [['m3', 'overheard']]],
]) {
  test(`follow-up: a "${answer}" on the second held message drops the waiting overheard line as newer and starts that message's turn`, async () => {
    const { llm, turns } = await overheardChain();
    await answerFollowUp(llm, 'no');
    assert.equal(llm.calls.length, 3);

    const logs = await answerFollowUp(llm, answer);
    assert.deepEqual(startedTurns(turns), expected);
    assert.deepEqual(followUpDropped(logs), [['m1', 'newer']]);
  });
}

test('follow-up: an "overheard" on a held message with a newer one held makes it the waiting line in place of the original', async () => {
  const { llm, turns } = await overheardChain();

  const logs = await answerFollowUp(llm, 'overheard');
  assert.equal(turns.calls.length, 0, 'm2 waits on m3');
  assert.deepEqual(followUpDropped(logs), [['m1', 'newer']]);
  assert.equal(llm.calls.length, 3, 'm3 is classified next');

  await answerFollowUp(llm, 'no');
  assert.deepEqual(startedTurns(turns), [['m2', 'overheard']]);
});

test('follow-up: a "no" streak that closes the window mid-chain drops the next held message and the waiting overheard line starts', async () => {
  const { llm, turns } = await overheardChain({ config: baseConfig({ mention: { followUpNoStreak: 1 } }) });

  const logs = await answerFollowUp(llm, 'no');
  assert.equal(llm.calls.length, 2, 'm3 is not classified');
  assert.deepEqual(heldDropped(logs), [['m3', 'closed']]);
  assert.deepEqual(startedTurns(turns), [['m1', 'overheard']]);
});

test('events: drainPending does nothing while paused; the queued ping waits for the pause to end', async () => {
  let busy = true;
  const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
  const store = fakeStateStore();
  const handler = makeHandler({ turns, store, sleep: async () => {}, rng: scripted([0.5, 0.99]) });
  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));

  store.state.data.paused = true;
  busy = false;
  await handler.drainPending();
  assert.equal(turns.calls.length, 0, 'paused: nothing is picked up');

  store.state.data.paused = false;
  await handler.drainPending();
  assert.equal(turns.calls.length, 1, 'the ping was never popped');
});

test('events: a pause landing during the switch pause stops the drain before the turn', async () => {
  let busy = true;
  const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
  const store = fakeStateStore();
  const sleep = async () => {
    store.state.data.paused = true;
  };
  const handler = makeHandler({ turns, store, sleep, rng: scripted([0.5, 0.99]) });
  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));

  busy = false;
  await handler.drainPending();
  assert.equal(turns.calls.length, 0);
});

test('private: a pause landing during the switch pause drops the drained DM: no turn, no notice, nothing marked', async () => {
  let busy = true;
  const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
  const privates = {};
  const store = fakePrivateStore({ privates });
  const channel = fakeDmChannel();
  const sleep = async () => {
    store.state.data.paused = true;
  };
  const handler = makeDmHandler({ turns, store, sleep });
  await handler(fakeDmMessage({ channel }));
  await settle();

  privates.u1 = { replies: { day: TODAY, count: 100, noticedDay: '' } };
  busy = false;
  await handler.drainPending();

  assert.equal(turns.calls.length, 0);
  assert.deepEqual(store.noticed, [], 'nothing marked while paused');
  assert.equal(channel.sent.length, 0);
});

test('follow-up persistence: while paused an expired window stays in state and nothing is marked dirty', () => {
  const store = fakeStateStore({
    paused: true,
    followUpWindows: {
      old: { openedAt: 0, lastAnswerAt: 0, noStreak: 0 },
      fresh: { openedAt: 950_000, lastAnswerAt: 950_000, noStreak: 1 },
    },
  });
  makeHandler({ store, now: mutableNow(960_000), llm: fakeFollowUpLlm(), prompts: fakeAddressPrompts() });

  assert.deepEqual(Object.keys(store.state.data.followUpWindows).sort(), ['fresh', 'old']);
  assert.equal(store.dirtyCount, 0);
});

test("events: forwarding one of the persona's own messages is not a reply to it", async () => {
  const turns = recordingTurns();
  const spontaneous = fakeSpontaneous();
  const guild = fakeGuild();
  const channel = fakeChannel('c1', guild, {
    messages: { cache: new Map([['m100', { author: { id: 'self1' } }]]), fetch: async () => null },
  });
  const config = baseConfig({ bot: { nameTriggers: [] } });
  const handler = makeHandler({ config, turns, spontaneous, rng: scripted([]) });

  await handler(fakeMessage({
    guild,
    channel,
    channelId: 'c1',
    cleanContent: '',
    reference: { messageId: 'm100', channelId: 'c1', type: MessageReferenceType.Forward },
  }));
  await settle();

  assert.equal(turns.calls.length, 0, 'a forward is no trigger');
  assert.equal(spontaneous.onMessageCalls.length, 1);
});

test('events: a message that replies to nothing fetches no message; a reply target missing from the cache is fetched', async () => {
  const fetched = [];
  let target = { author: { id: 'self1' } };
  const guild = fakeGuild();
  const channel = fakeChannel('c1', guild, {
    messages: {
      cache: new Map(),
      fetch: async (arg) => {
        fetched.push(arg);
        if (target instanceof Error) throw target;
        return target;
      },
    },
  });
  const turns = recordingTurns();
  const config = baseConfig({ bot: { nameTriggers: [] } });
  const handler = makeHandler({ config, turns, rng: () => 0.99 });

  const { logs } = await withCapturedLogs(async () => {
    await handler(fakeMessage({ id: 'm1', guild, channel, channelId: 'c1', cleanContent: 'καλημέρα' }));
    assert.deepEqual(fetched, [], 'no reply: nothing to look up, not even a page of the channel');

    await handler(fakeMessage({ id: 'm2', guild, channel, channelId: 'c1', cleanContent: 'ναι', reference: { messageId: 'm0' } }));
    await settle();
    assert.deepEqual(fetched, ['m0'], 'the reply target is fetched by its id');
    assert.deepEqual(turns.calls.map((args) => [args.trigger.id, args.triggerKind]), [['m2', 'reply']]);

    // A target that cannot be fetched is no reply to the persona, and nothing escapes the handler.
    target = new Error('Service Unavailable');
    await handler(fakeMessage({ id: 'm3', guild, channel, channelId: 'c1', cleanContent: 'όχι', reference: { messageId: 'm9' } }));
    await settle();
  });
  assert.deepEqual(fetched, ['m0', 'm9']);
  assert.equal(turns.calls.length, 1, 'the unresolved reply runs no turn');
  assert.equal(logs.some((entry) => entry.msg === 'events: message handler failed'), false);
});

test('follow-up: a failure while building the classifier request is not reported as a missing prompts.address', async () => {
  const llm = fakeFollowUpLlm();
  const prompts = fakeAddressPrompts();
  const handler = makeHandler({ llm, prompts });
  const guild = fakeGuild();
  const channel = fakeChannel('c1', guild, {
    messages: {
      cache: new Map(),
      fetch: async () => {
        throw new Error('Missing Access');
      },
    },
  });
  await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

  const first = await withCapturedLogs(async () => {
    await handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'plain follow-up' }));
    await tick();
  });
  assert.equal(llm.calls.length, 0);
  assert.ok(first.logs.some((l) => l.msg === 'follow-up: building the classifier request failed'));
  assert.equal(first.logs.some((l) => l.msg.startsWith('follow-up: prompts.address is missing')), false);

  // The real cause still gets its warning afterwards.
  prompts.address = undefined;
  const second = await withCapturedLogs(async () => {
    await handler(plainFollowUpMessage({ id: 'm2', guild, channel, content: 'plain again' }));
    await tick();
  });
  assert.ok(second.logs.some((l) => l.msg.startsWith('follow-up: prompts.address is missing')));
});

test('follow-up: a failed classifier call is logged with its error, not only as a "no"', async () => {
  const cases = [
    { label: 'an ordinary error', error: new Error('boom') },
    // The daily cap refuses before any request leaves: the same logged "no", never thrown.
    { label: 'a DailyCapError', error: new DailyCapError('daily LLM request cap reached (300)') },
  ];
  for (const { label, error } of cases) {
    const llm = fakeFollowUpLlm();
    const spontaneous = fakeSpontaneous();
    const handler = makeHandler({ spontaneous, llm, prompts: fakeAddressPrompts() });
    const guild = fakeGuild();
    const channel = fakeChannelWithHistory('c1', guild, []);
    await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

    const { logs } = await withCapturedLogs(async () => {
      const p = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'plain follow-up' }));
      await tick();
      llm.fail(error);
      await p;
    });
    const failed = logs.find((l) => l.msg === 'follow-up: classifier failed');
    assert.ok(failed, `${label}: logged as a failed call`);
    assert.equal(failed.level, 'warn', label);
    assert.equal(failed.channel, 'c1', label);
    assert.equal(failed.error.message, error.message, label);
    assert.equal(logs.find((l) => l.msg === 'follow-up: verdict')?.verdict, 'no', `${label}: a "no"`);
    assert.equal(spontaneous.onMessageCalls.length, 0, `${label}: still handled as a "no", not handed to spontaneous`);
  }
});

// ---------------------------------------------------------------------------
// mention.failOpenMinutes -- a failed classifier call (thrown or empty) keeps an
// active one-to-one exchange: the facts are the channel history its request fetched.

/**
 * One classifier failure in channel c1 with Bob (u2) writing to the persona: a line by
 * `preceding`, the persona's line `agoMs` before the candidate (a reply to that line, unless
 * `reply` is false), then `between` (raw lines after hers), then Bob's candidate. `failure` is
 * `'throw'`, `'empty'` or an answer word (a working classifier).
 */
async function failOpenScenario({ agoMs = 60_000, between = [], failure = 'throw', reply = true, preceding = 'u2', mention = {}, extra, missed } = {}) {
  const llm = fakeFollowUpLlm();
  const turns = recordingTurns();
  const spontaneous = fakeSpontaneous();
  const config = baseConfig({ mention: { failOpenMinutes: 3, ...mention } });
  const handler = makeHandler({ config, turns, spontaneous, llm, prompts: fakeAddressPrompts(), missed });
  const guild = fakeGuild();
  const t0 = Date.now();
  const herTs = t0 - agoMs;
  const herLine = {
    ...rawHistoryMessage({ id: 'h-her', authorId: 'self1', authorName: 'Ζωή', ts: herTs, content: 'her answer' }),
    reference: reply ? { messageId: 'h-asked' } : null,
  };
  const history = [
    rawHistoryMessage({ id: 'h-asked', authorId: preceding, authorName: preceding === 'u2' ? 'Bob' : 'Carla', ts: herTs - 20_000, content: 'a question' }),
    herLine,
    ...between,
  ];
  const channel = fakeChannelWithHistory('c1', guild, history);
  await openFollowUpWindow(handler, { guild, channel, ts: herTs });

  const { logs } = await withCapturedLogs(async () => {
    const p = handler(plainFollowUpMessage({ id: 'm-candidate', guild, channel, content: 'and then?', ts: t0 }));
    await tick();
    if (failure === 'throw') llm.fail(new Error('timeout'));
    else if (failure === 'empty') llm.respond('');
    else llm.respond(failure);
    await p;
    await tick();
    if (extra) await extra({ handler, llm, guild, channel, t0 });
  });
  return { turns, spontaneous, llm, logs };
}

test('follow-up: a thrown classifier call keeps a one-to-one exchange whose last line of hers answered this author a minute ago', async () => {
  const { turns, logs, llm } = await failOpenScenario({
    // With a no-streak limit of 1, a counted "no" would close the window before the next line.
    mention: { followUpNoStreak: 1 },
    extra: async ({ handler, llm, guild, channel, t0 }) => {
      const p = handler(plainFollowUpMessage({ id: 'm-next', guild, channel, content: 'still there?', ts: t0 + 1000 }));
      await tick();
      llm.respond('no');
      await p;
    },
  });
  assert.equal(turns.calls.length, 1, 'a reply turn');
  assert.equal(turns.calls[0].trigger.id, 'm-candidate');
  assert.equal(turns.calls[0].triggerKind, 'followUp');
  const open = logs.find((l) => l.msg === 'follow-up: fail-open');
  assert.ok(open, 'logged');
  assert.equal(open.channel, 'c1');
  assert.equal(open.author, 'u2');
  assert.equal(open.reason, 'classifier-failed');
  assert.equal(open.open, true);
  assert.ok(!JSON.stringify(open).includes('and then?'), 'no message contents');
  assert.equal(logs.find((l) => l.msg === 'follow-up: verdict')?.verdict, 'yes');
  assert.equal(llm.calls.length, 2, 'a fail-open "yes" leaves the no-streak alone: the window is still open');
});

test('follow-up: an empty classifier answer keeps the same one-to-one exchange', async () => {
  const { turns, logs } = await failOpenScenario({ failure: 'empty' });
  assert.equal(turns.calls.length, 1, 'a reply turn');
  const open = logs.find((l) => l.msg === 'follow-up: fail-open');
  assert.equal(open?.reason, 'empty');
  assert.equal(open?.open, true);
});

test('follow-up: a failed classifier keeps the exchange when this author\'s line directly preceded hers', async () => {
  const { turns } = await failOpenScenario({ reply: false });
  assert.equal(turns.calls.length, 1);
});

test('follow-up: a failed classifier is a "no" when the exchange is not an active one-to-one', async () => {
  const cases = [
    {
      label: 'another member wrote between her line and this message',
      between: [rawHistoryMessage({ id: 'h-carla', authorId: 'u3', authorName: 'Carla', ts: Date.now() - 30_000, content: 'me too' })],
    },
    { label: 'her line is ten minutes old', agoMs: 10 * 60_000 },
    { label: 'her line answered someone else', preceding: 'u3' },
    { label: 'her line followed someone else', reply: false, preceding: 'u3' },
    { label: 'mention.failOpenMinutes 0 switches it off', mention: { failOpenMinutes: 0 } },
  ];
  for (const failure of ['throw', 'empty']) {
    for (const { label, ...scenario } of cases) {
      const { turns, spontaneous, logs } = await failOpenScenario({ failure, ...scenario });
      assert.equal(turns.calls.length, 0, `${failure}, ${label}: no reply turn`);
      assert.equal(spontaneous.onMessageCalls.length, 0, `${failure}, ${label}: still handled`);
      assert.equal(logs.find((l) => l.msg === 'follow-up: verdict')?.verdict, 'no', `${failure}, ${label}`);
      const open = logs.find((l) => l.msg === 'follow-up: fail-open');
      if (scenario.mention?.failOpenMinutes === 0) assert.equal(open, undefined, `${failure}, ${label}: switched off, not logged`);
      else assert.equal(open?.open, false, `${failure}, ${label}`);
    }
  }
});

/** A src/behavior/missed.js stand-in recording the facts and the activity it is told of. */
function recordingMissed() {
  const facts = [];
  const activity = [];
  return {
    facts,
    activity,
    noteFact: (fact) => facts.push(fact),
    noteActivity: (channelId, at) => activity.push([channelId, at]),
  };
}

test('follow-up: a failed classifier is a missed-answer fact, gate-failopen when it keeps the exchange, gate-failed otherwise', async () => {
  const kept = recordingMissed();
  await failOpenScenario({ failure: 'throw', missed: kept });
  assert.deepEqual(kept.facts.map((f) => [f.reason, f.message.id, f.failure]), [['gate-failopen', 'm-candidate', 'classifier-failed']]);
  assert.ok(kept.activity.some(([channelId]) => channelId === 'c1'), 'the message is activity in its channel');

  const dropped = recordingMissed();
  await failOpenScenario({ failure: 'empty', preceding: 'u3', missed: dropped });
  assert.deepEqual(dropped.facts.map((f) => [f.reason, f.message.id, f.failure]), [['gate-failed', 'm-candidate', 'empty']]);

  const off = recordingMissed();
  await failOpenScenario({ failure: 'throw', mention: { failOpenMinutes: 0 }, missed: off });
  assert.deepEqual(off.facts.map((f) => f.reason), ['gate-failed'], 'fail-open switched off: still a failed gate');

  for (const answer of ['no', 'yes']) {
    const working = recordingMissed();
    await failOpenScenario({ failure: answer, missed: working });
    assert.deepEqual(working.facts, [], `${answer}: a working classifier is no fact`);
  }
});

test('follow-up: a working classifier answer is never overridden by the fail-open facts', async () => {
  for (const [answer, expectedTurns] of [['no', 0], ['yes', 1]]) {
    const { turns, logs } = await failOpenScenario({ failure: answer });
    assert.equal(turns.calls.length, expectedTurns, answer);
    assert.equal(logs.find((l) => l.msg === 'follow-up: fail-open'), undefined, `${answer}: no fail-open`);
    assert.equal(logs.find((l) => l.msg === 'follow-up: verdict')?.answer, answer);
  }
});

test('events: a bot.channels deny key added while a mention waits is ignored at drain time', async () => {
  let busy = true;
  const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
  const config = baseConfig();
  const handler = makeHandler({ config, turns, sleep: async () => {}, rng: scripted([0.5, 0.99]) });
  const guild = fakeGuild();
  const channel = fakeChannelWithMessage('c1', guild, 'm1');
  await handler(directPingMessage({ guild, channel, channelId: 'c1' }));

  config.bot.channels = { allow: [], deny: ['c1'] };
  busy = false;
  await handler.drainPending();
  assert.equal(turns.calls.length, 1);
});

test('events: a queued mention or reply whose switch was turned off meanwhile is not answered at drain time', async () => {
  for (const [kind, switchName] of [['mention', 'mentions'], ['reply', 'replies']]) {
    let busy = true;
    const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
    const config = baseConfig();
    const handler = makeHandler({ config, turns, sleep: async () => {}, rng: scripted([0.5, 0.99]) });
    const guild = fakeGuild();
    const channel = fakeChannelWithMessage('c1', guild, 'm1');
    channel.messages.cache.set('m0', { author: { id: 'self1' } });
    const message =
      kind === 'mention'
        ? directPingMessage({ guild, channel, channelId: 'c1' })
        : fakeMessage({ id: 'm1', guild, channel, channelId: 'c1', cleanContent: 'γεια', reference: { messageId: 'm0' } });
    await handler(message);

    config.features[switchName] = false;
    busy = false;
    await handler.drainPending();
    assert.equal(turns.calls.length, 0, kind);
  }
});

test('events: a queued name call answers to features.nameTriggers at drain time, not features.mentions', async () => {
  for (const [switchName, answered] of [['nameTriggers', false], ['mentions', true]]) {
    let busy = true;
    const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
    const config = baseConfig({ bot: { nameTriggers: ['νεπτούνια'] } });
    const handler = makeHandler({ config, turns, sleep: async () => {}, rng: scripted(answered ? [0.5, 0.2] : [0.5]) });
    const guild = fakeGuild();
    const channel = fakeChannelWithMessage('c1', guild, 'm1');
    await handler(fakeMessage({ id: 'm1', guild, channel, channelId: 'c1', cleanContent: 'γεια νεπτούνια' }));

    config.features[switchName] = false;
    busy = false;
    const { logs } = await withCapturedLogs(() => handler.drainPending());
    assert.equal(turns.calls.length, answered ? 1 : 0, switchName);
    assert.deepEqual(
      logs.filter((entry) => entry.msg === 'mention: dropped').map(({ kind, reason }) => [kind, reason]),
      answered ? [] : [['name', 'off']],
      switchName,
    );
    if (answered) assert.equal(turns.calls[0].triggerKind, 'name');
  }
});

// ---------------------------------------------------------------------------
// Calls from a channel the persona can read but not write in (features.elsewhere): recorded in
// the ring (state.json `elsewherePings`), answered in the main channel once the source settles.

const VIEW = PermissionFlagsBits.ViewChannel;
const SEND = PermissionFlagsBits.SendMessages;
const ROUTE_T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const SECOND = 1000;

/** ROUTE_T0 plus `seconds`. */
const routeAt = (seconds) => ROUTE_T0 + seconds * SECOND;

/**
 * Fake timers for the settle wait: `set` records each timer (with `unref`), `clear` marks it;
 * `live()` lists the ones neither cleared nor fired; `fire()` runs those (`fireOne(timer)` just
 * that one), then lets the turn's promise chain settle.
 */
function fakeTimers() {
  const all = [];
  const timers = {
    all,
    set(fn, ms) {
      const timer = { fn, ms, cleared: false, fired: false, unrefed: false };
      timer.unref = () => {
        timer.unrefed = true;
        return timer;
      };
      all.push(timer);
      return timer;
    },
    clear(timer) {
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
    async fireOne(timer) {
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
    roles: { everyone, cache: new Map([[everyone.id, everyone], [regular.id, regular]]) },
    channels: { cache: new Map() },
  };
}

/**
 * A text channel of a routeGuild, no overwrites. `send`: the bot may send there (it may always
 * view, read and react). `viewers`: the ids of the roles that can view it (@everyone is `g1`).
 * Its message cache answers `messages.fetch` too (a message deleted from it is gone); `sent`
 * records what the bot posted.
 */
function routeChannel(guild, id, { send = true, viewers = ['g1', 'r1'] } = {}) {
  const me = guild.members.me;
  const cache = new Map();
  const sent = [];
  const channel = fakeChannel(id, guild, {
    name: id,
    isTextBased: () => true,
    permissionOverwrites: { cache: new Map() },
    permissionsFor: (target) =>
      target === me
        ? { has: (flag) => send || flag !== SEND }
        : { has: (flag) => flag === VIEW && viewers.includes(target?.id) },
    messages: { cache, fetch: async (messageId) => cache.get(messageId) ?? null },
    send: async (payload) => {
      sent.push(payload);
      return { id: `sent-${sent.length}` };
    },
  });
  channel.sent = sent;
  guild.channels.cache.set(id, channel);
  return channel;
}

/**
 * The sources `s1` and `s2` (the bot reads them, cannot write in them) and the main channel
 * `d1` (`memory.mainChannelIds`), a state store, fake timers and a clock at ROUTE_T0. `config`
 * merges over the shipped defaults plus the main channel and a name trigger. `spontaneous`
 * replaces the default fake scheduler.
 */
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
} = {}) {
  const config = baseConfig(deepMerge({ memory: { mainChannelIds: ['d1'] }, bot: { nameTriggers: ['νεπτούνια'] } }, overrides));
  const guild = routeGuild();
  const source = routeChannel(guild, 's1', { send: false, viewers: sourceViewers });
  const source2 = routeChannel(guild, 's2', { send: false });
  const main = routeChannel(guild, 'd1', { send: mainCanSend });
  const clock = mutableNow(ROUTE_T0);
  const timers = fakeTimers();
  const handler = makeHandler({ config, turns, store, now: clock, timers, rng, prompts, tagHistory, spontaneous, sleep: async () => {} });
  return { config, guild, source, source2, main, sourceViewers, clock, timers, handler, turns, store };
}

/**
 * A member's message in `channel` written at `ts`: a mention of the persona unless `mention` is
 * false; `replyTo` makes it a reply to that message id.
 */
function routeMessage(channel, { id, ts, mention = true, authorId = 'u1', authorName = 'Ελένη', content = 'γεια σου', replyTo = null }) {
  return fakeMessage({
    id,
    guild: channel.guild,
    channel,
    channelId: channel.id,
    author: { id: authorId, bot: false, globalName: authorName, username: authorName },
    member: { displayName: authorName },
    cleanContent: content,
    createdTimestamp: ts,
    reference: replyTo ? { messageId: replyTo } : null,
    mentions: { users: new Map(mention ? [['self1', { id: 'self1' }]] : []) },
  });
}

/** Move the scene's clock to `seconds` after ROUTE_T0 and hand it a message written then (cached in its channel). */
async function routeSend(scene, channel, seconds, spec) {
  scene.clock.set(routeAt(seconds));
  const message = routeMessage(channel, { ts: routeAt(seconds), ...spec });
  channel.messages.cache.set(message.id, message);
  await scene.handler(message);
}

/** Move the clock to `seconds` after ROUTE_T0 and fire every live settle timer. */
async function routeFire(scene, seconds) {
  scene.clock.set(routeAt(seconds));
  await scene.timers.fire();
}

const byMsg = (logs, msg) => logs.filter((entry) => entry.msg === msg);

test('events: a ping in a read-only channel waits for the settle, then runs a reply turn in the main channel with its source', async () => {
  const scene = routeScene();
  const { logs } = await withCapturedLogs(async () => {
    await routeSend(scene, scene.source, 0, { id: 'm1' });
    assert.equal(scene.turns.calls.length, 0, 'nothing runs before the source settles');
    assert.equal(scene.timers.live().length, 1, 'one settle timer for the source');
    assert.equal(scene.timers.live()[0].ms, 90 * SECOND, 'elsewhere.settleSeconds after the call');
    assert.equal(scene.timers.live()[0].unrefed, true, 'the timer never keeps the process alive');
    await routeFire(scene, 90);
  });

  assert.equal(scene.turns.calls.length, 1);
  const args = scene.turns.calls[0];
  assert.equal(args.channel, scene.main, 'the turn posts in the main channel');
  assert.equal(args.mode, 'reply');
  assert.equal(args.triggerKind, 'mention');
  assert.equal(args.trigger.id, 'm1');
  assert.equal(args.trigger.channelId, 's1');
  assert.deepEqual(args.source, { channelId: 's1', reason: 'routed' });

  assert.deepEqual(
    byMsg(logs, 'elsewhere: settling').map(({ source, kind, message, destination }) => ({ source, kind, message, destination })),
    [{ source: 's1', kind: 'ping', message: 'm1', destination: 'd1' }],
  );
  const [settled] = byMsg(logs, 'elsewhere: settled');
  assert.equal(settled.source, 's1');
  assert.equal(settled.kind, 'ping');
  assert.equal(settled.waitedMs, 90 * SECOND);
  assert.equal(settled.moved, 0);
  const [decided] = byMsg(logs, 'mention: decided');
  assert.equal(decided.channel, 's1', 'the call is decided where it was written');
  assert.equal(decided.destination, 'd1');
  assert.equal(byMsg(logs, 'mention: dropped').length, 0);
});

test('events: the ring keeps elsewhere.rememberPings calls, read when each call arrives', async () => {
  const scene = routeScene({ config: { elsewhere: { rememberPings: 3 } } });
  await routeSend(scene, scene.source, 0, { id: 'm1' });
  await routeSend(scene, scene.source, 10, { id: 'm2', authorId: 'u2', authorName: 'Ίων' });
  assert.deepEqual(scene.store.state.data.elsewherePings.map((entry) => entry.messageId), ['m1', 'm2']);

  // The owner lowers the cap while the bot runs: the next call is kept under the new one.
  scene.config.elsewhere.rememberPings = 2;
  await routeSend(scene, scene.source, 20, { id: 'm3', authorId: 'u3', authorName: 'Χλόη' });
  assert.deepEqual(scene.store.state.data.elsewherePings.map((entry) => entry.messageId), ['m2', 'm3']);

  scene.config.elsewhere.rememberPings = 1;
  await routeSend(scene, scene.source, 30, { id: 'm4' });
  assert.deepEqual(scene.store.state.data.elsewherePings.map((entry) => entry.messageId), ['m4']);
});

test('events: elsewhere.settleSeconds and settleMaxSeconds are read each time the wait moves', async () => {
  const scene = routeScene();
  const note = (id) => ({ id, mention: false, authorId: 'u2', authorName: 'Ίων', content: 'σημείωση' });
  await routeSend(scene, scene.source, 0, { id: 'm1' });
  assert.deepEqual(scene.timers.live().map((timer) => timer.ms), [90 * SECOND]);

  scene.config.elsewhere.settleSeconds = 30;
  await routeSend(scene, scene.source, 10, note('m2'));
  assert.deepEqual(scene.timers.live().map((timer) => timer.ms), [30 * SECOND], 'due 30 s after the message at 10 s');

  scene.config.elsewhere.settleMaxSeconds = 20;
  await routeSend(scene, scene.source, 15, note('m3'));
  assert.deepEqual(scene.timers.live().map((timer) => timer.ms), [5 * SECOND], 'never later than 20 s after the call');

  const { logs } = await withCapturedLogs(() => routeFire(scene, 20));
  assert.equal(byMsg(logs, 'elsewhere: settled')[0].waitedMs, 20 * SECOND);
  assert.equal(scene.turns.calls.length, 1);
});

test('events: each new message in the source moves the settle, never past settleMaxSeconds', async () => {
  const scene = routeScene();
  const { logs } = await withCapturedLogs(async () => {
    await routeSend(scene, scene.source, 0, { id: 'm1' });
    for (const [seconds, id] of [[60, 'm2'], [140, 'm3'], [220, 'm4'], [290, 'm5']]) {
      await routeSend(scene, scene.source, seconds, { id, mention: false, authorId: 'u2', authorName: 'Ίων', content: 'σημείωση' });
    }
    // 0 -> due 90; 60 -> 150; 140 -> 230; 220 -> min(310, 300) = 300; 290 -> still 300 (no new timer).
    assert.deepEqual(scene.timers.all.map((timer) => timer.ms), [90, 90, 90, 80].map((s) => s * SECOND));
    assert.deepEqual(scene.timers.live().map((timer) => timer.ms), [80 * SECOND]);
    await routeFire(scene, 300);
  });

  assert.equal(scene.turns.calls.length, 1);
  assert.equal(scene.turns.calls[0].trigger.id, 'm1');
  const [settled] = byMsg(logs, 'elsewhere: settled');
  assert.equal(settled.waitedMs, 300 * SECOND, 'elsewhere.settleMaxSeconds after the first call');
  assert.equal(settled.moved, 3, 'the last message no longer pushed the due time');
});

test('events: a newer call in the same source replaces the waiting one', async () => {
  const scene = routeScene();
  const { logs } = await withCapturedLogs(async () => {
    await routeSend(scene, scene.source, 0, { id: 'm1' });
    await routeSend(scene, scene.source, 30, { id: 'm2', authorId: 'u2', authorName: 'Ίων' });
    assert.deepEqual(scene.timers.live().map((timer) => timer.ms), [90 * SECOND], 'the burst settles 90 s after the newer call');
    await routeFire(scene, 120);
  });

  const [replaced] = byMsg(logs, 'elsewhere: dropped');
  assert.equal(replaced.source, 's1');
  assert.equal(replaced.kind, 'ping');
  assert.equal(replaced.reason, 'replaced');
  assert.equal(replaced.message, 'm1');
  assert.equal(byMsg(logs, 'elsewhere: settling').length, 1, 'one wait for the burst');
  assert.deepEqual(scene.turns.calls.map((args) => args.trigger.id), ['m2'], 'only the newer call is answered');
  assert.deepEqual(scene.store.state.data.elsewherePings.map((entry) => entry.messageId), ['m1', 'm2'], 'both stay in the ring');
  assert.equal(byMsg(logs, 'elsewhere: settled')[0].waitedMs, 120 * SECOND);
});

test('events: a name call never replaces a waiting mention', async () => {
  const scene = routeScene();
  const { logs } = await withCapturedLogs(async () => {
    await routeSend(scene, scene.source, 0, { id: 'm1' });
    await routeSend(scene, scene.source, 30, { id: 'm2', mention: false, authorId: 'u2', authorName: 'Ίων', content: 'η νεπτούνια είναι αστεία' });
    assert.deepEqual(scene.timers.live().map((timer) => timer.ms), [90 * SECOND], 'the weaker call still moves the wait');
    await routeFire(scene, 120);
  });

  const dropped = byMsg(logs, 'elsewhere: dropped');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].source, 's1');
  assert.equal(dropped[0].message, 'm2', 'the name call is the one dropped');
  assert.equal(dropped[0].reason, 'outranked');
  assert.deepEqual(scene.turns.calls.map((args) => [args.trigger.id, args.triggerKind]), [['m1', 'mention']]);
  assert.deepEqual(scene.store.state.data.elsewherePings.map((entry) => entry.messageId), ['m1', 'm2'], 'both stay in the ring');
});

test('events: a mention replaces a waiting name call', async () => {
  const scene = routeScene();
  const { logs } = await withCapturedLogs(async () => {
    await routeSend(scene, scene.source, 0, { id: 'm1', mention: false, content: 'νεπτούνια, δες εδώ' });
    await routeSend(scene, scene.source, 30, { id: 'm2', authorId: 'u2', authorName: 'Ίων' });
    await routeFire(scene, 120);
  });

  const [replaced] = byMsg(logs, 'elsewhere: dropped');
  assert.equal(replaced.message, 'm1');
  assert.equal(replaced.reason, 'replaced');
  assert.deepEqual(scene.turns.calls.map((args) => [args.trigger.id, args.triggerKind]), [['m2', 'mention']]);
});

test('events: settle waits are per source: a call in another read-only channel arms its own', async () => {
  const scene = routeScene();
  const { logs } = await withCapturedLogs(async () => {
    await routeSend(scene, scene.source, 0, { id: 'm1' });
    await routeSend(scene, scene.source2, 30, { id: 'm2', authorId: 'u2', authorName: 'Ίων' });
    await routeSend(scene, scene.source2, 60, { id: 'm3', mention: false, authorId: 'u3', authorName: 'Χλόη', content: 'σημείωση' });

    const [s1Timer] = scene.timers.all;
    assert.equal(scene.timers.all.length, 3, 's1 armed, s2 armed, s2 moved');
    assert.equal(s1Timer.cleared, false, 'traffic in s2 never moves the wait of s1');
    assert.equal(s1Timer.ms, 90 * SECOND);
    assert.equal(scene.timers.live().length, 2);

    scene.clock.set(routeAt(90));
    await scene.timers.fireOne(s1Timer);
    assert.deepEqual(scene.turns.calls.map((args) => [args.source.channelId, args.trigger.id]), [['s1', 'm1']]);
    assert.deepEqual(scene.timers.live().map((timer) => timer.ms), [90 * SECOND], 's2 still waits, due 90 s after its last message');
    await routeFire(scene, 150);
  });

  assert.deepEqual(
    scene.turns.calls.map((args) => [args.channel.id, args.source.channelId, args.trigger.id]),
    [['d1', 's1', 'm1'], ['d1', 's2', 'm2']],
  );
  assert.deepEqual(byMsg(logs, 'elsewhere: settling').map((entry) => [entry.source, entry.message]), [['s1', 'm1'], ['s2', 'm2']]);
  assert.equal(byMsg(logs, 'elsewhere: dropped').length, 0, 'nothing replaced across sources');
  assert.deepEqual(byMsg(logs, 'elsewhere: settled').map((entry) => [entry.source, entry.waitedMs]), [['s1', 90 * SECOND], ['s2', 120 * SECOND]]);
});

test('events: a call another turn already showed and answered is not answered again when the settle fires', async () => {
  const spokeSaw = new Map();
  const turns = recordingTurns();
  turns.spokeAfterSeeing = (channelId, messageId) => spokeSaw.get(channelId)?.has(messageId) ?? false;
  const scene = routeScene({ turns });
  // Earlier calls in the ring: m0 in the source, x1 in another read-only channel.
  scene.store.state.data.elsewherePings = [
    { messageId: 'm0', channelId: 's1', ts: routeAt(-600), answeredAt: null, skippedAt: null },
    { messageId: 'x1', channelId: 's2', ts: routeAt(-500), answeredAt: null, skippedAt: null },
  ];
  await routeSend(scene, scene.source, 0, { id: 'm1' });
  await routeSend(scene, scene.source, 5, { id: 'm2', authorId: 'u2', authorName: 'Ίων' });
  // During the wait a turn in the main channel pulled s1, showed both calls of this settle
  // (m2 took m1's place) and spoke -- m0 was not in its view; s2 was shown by another turn.
  spokeSaw.set('s1', new Set(['n0', 'm1', 'm2']));
  spokeSaw.set('s2', new Set(['x1']));
  const { logs } = await withCapturedLogs(() => routeFire(scene, 95));

  assert.equal(turns.calls.length, 0);
  const [answered] = byMsg(logs, 'mention: already answered');
  assert.equal(answered.channel, 's1');
  assert.equal(answered.kind, 'mention');
  assert.equal(byMsg(logs, 'mention: decided').length, 0, 'never counted or rolled again');
  // The call it had in hand and the one it replaced are no longer presented as waiting by a
  // later pull; a call that turn never showed, or one of another channel, is left as it was.
  assert.deepEqual(ringStates(scene), { m0: 'unanswered', x1: 'unanswered', m1: 'skipped', m2: 'skipped' });
  const m1 = scene.store.state.data.elsewherePings.find((entry) => entry.messageId === 'm1');
  assert.deepEqual([m1.answeredAt, m1.skippedAt], [null, routeAt(95)]);
  assert.deepEqual(
    byMsg(logs, 'elsewhere: marked').map(({ source, message, status }) => [source, message, status]),
    [['s1', 'm2', 'skipped'], ['s1', 'm1', 'skipped']],
  );

  // A call that turn did not have in view is still answered.
  await routeSend(scene, scene.source, 100, { id: 'm3', authorId: 'u3', authorName: 'Χλόη' });
  await routeFire(scene, 190);
  assert.deepEqual(turns.calls.map((args) => args.trigger.id), ['m3']);
});

test('events: a settled call the ring holds as answered starts no turn, though no turn remembers showing it', async () => {
  // During the wait a turn in the main channel pulled s1 and answered the call (the turn stamps
  // the ring: src/behavior/turn.js#stampShownCalls); a later turn's view of s1 no longer holds it.
  const turns = recordingTurns();
  turns.spokeAfterSeeing = () => false;
  const scene = routeScene({ turns });
  await routeSend(scene, scene.source, 0, { id: 'm1' });
  await routeSend(scene, scene.source, 5, { id: 'm2', authorId: 'u2', authorName: 'Ίων' });
  scene.store.state.data.elsewherePings.find((entry) => entry.messageId === 'm2').answeredAt = routeAt(40);
  const dirty = scene.store.dirtyCount;
  const { logs } = await withCapturedLogs(() => routeFire(scene, 95));

  assert.equal(turns.calls.length, 0);
  assert.deepEqual(
    byMsg(logs, 'mention: already answered').map(({ channel, kind, reason }) => [channel, kind, reason]),
    [['s1', 'mention', 'ring']],
  );
  assert.equal(byMsg(logs, 'mention: decided').length, 0, 'never counted or rolled');
  assert.equal(byMsg(logs, 'mention: dropped').length, 0);
  // The turn that answered stamped what it showed; nothing is stamped here.
  assert.deepEqual(ringStates(scene), { m1: 'unanswered', m2: 'answered' });
  assert.equal(byMsg(logs, 'elsewhere: marked').length, 0);
  assert.equal(scene.store.dirtyCount, dirty);

  // Only an answer closes a settled call: one the ring holds as skipped (shown in passing) still gets its turn.
  await routeSend(scene, scene.source, 100, { id: 'm3', authorId: 'u3', authorName: 'Χλόη' });
  scene.store.state.data.elsewherePings.find((entry) => entry.messageId === 'm3').skippedAt = routeAt(120);
  await routeFire(scene, 190);
  assert.deepEqual(turns.calls.map((args) => args.trigger.id), ['m3']);
});

/** Replace the message lookup of `channel` with `answer`, counted: `count` is how many fetches were made. */
function countLookups(channel, answer) {
  const lookups = { count: 0 };
  channel.messages.fetch = async (...args) => {
    lookups.count += 1;
    return answer(...args);
  };
  return lookups;
}

// How the lookup of a call's message can come back empty-handed.
const LOOKUP_MISSES = [
  ['deleted', async () => null],
  [
    'the fetch fails',
    async () => {
      throw Object.assign(new Error('Service Unavailable'), { status: 503 });
    },
  ],
];

test('events: a settled call the ring holds as answered is logged as answered, never as gone or fetch-failed, and costs no lookup', async () => {
  for (const [label, answer] of LOOKUP_MISSES) {
    const scene = routeScene();
    await routeSend(scene, scene.source, 0, { id: 'm1' });
    // A turn in the main channel pulled s1, answered the call and stamped the ring; then the
    // call's message left the cache (deleted, or swept) and cannot be looked up any more.
    scene.store.state.data.elsewherePings[0].answeredAt = routeAt(40);
    scene.source.messages.cache.delete('m1');
    const lookups = countLookups(scene.source, answer);
    const { logs } = await withCapturedLogs(() => routeFire(scene, 90));

    assert.equal(scene.turns.calls.length, 0, label);
    assert.deepEqual(
      byMsg(logs, 'mention: already answered').map(({ channel, kind, reason }) => [channel, kind, reason]),
      [['s1', 'mention', 'ring']],
      label,
    );
    assert.equal(byMsg(logs, 'mention: dropped').length, 0, `${label}: an answered call is not reported as lost`);
    assert.equal(lookups.count, 0, `${label}: no lookup for a call already answered`);
    assert.deepEqual(ringStates(scene), { m1: 'answered' }, label);
  }
});

test('events: a settled call answered while its message is looked up is not answered again', async () => {
  for (const [label, answer] of [['found', async () => ({ id: 'm1' })], ...LOOKUP_MISSES]) {
    const scene = routeScene();
    await routeSend(scene, scene.source, 0, { id: 'm1' });
    // Swept from the cache, so the settle has to fetch it. While that fetch is in flight a turn
    // in the main channel that showed the call speaks and stamps the ring.
    scene.source.messages.cache.delete('m1');
    const lookups = countLookups(scene.source, async () => {
      scene.store.state.data.elsewherePings[0].answeredAt = routeAt(90);
      return answer();
    });
    const { logs } = await withCapturedLogs(() => routeFire(scene, 90));

    assert.equal(lookups.count, 1, label);
    assert.equal(scene.turns.calls.length, 0, label);
    assert.deepEqual(
      byMsg(logs, 'mention: already answered').map(({ channel, kind, reason }) => [channel, kind, reason]),
      [['s1', 'mention', 'ring']],
      label,
    );
    assert.equal(byMsg(logs, 'mention: dropped').length, 0, label);
    assert.equal(byMsg(logs, 'mention: decided').length, 0, `${label}: never counted or rolled`);
  }
});

test('events: a call deleted during the settle wait is dropped with reason gone', async () => {
  const scene = routeScene();
  await routeSend(scene, scene.source, 0, { id: 'm1' });
  scene.source.messages.cache.delete('m1');
  const { logs } = await withCapturedLogs(() => routeFire(scene, 90));

  assert.equal(scene.turns.calls.length, 0);
  assert.equal(byMsg(logs, 'mention: decided').length, 0, 'never counted or rolled');
  assert.deepEqual(
    byMsg(logs, 'mention: dropped').map(({ channel, kind, reason, destination }) => [channel, kind, reason, destination]),
    [['s1', 'mention', 'gone', undefined]],
    'dropped before a destination is resolved',
  );
  assert.equal(byMsg(logs, 'elsewhere: dropped').length, 0);
});

test('events: a settled call whose message fetch fails is dropped as fetch-failed and stays unanswered', async () => {
  const scene = routeScene();
  await routeSend(scene, scene.source, 0, { id: 'm1' });
  scene.source.messages.cache.delete('m1');
  scene.source.messages.fetch = async () => {
    throw Object.assign(new Error('Service Unavailable'), { status: 503 });
  };
  const { logs } = await withCapturedLogs(() => routeFire(scene, 90));

  assert.equal(scene.turns.calls.length, 0);
  assert.deepEqual(
    byMsg(logs, 'mention: dropped').map(({ channel, kind, reason }) => [channel, kind, reason]),
    [['s1', 'mention', 'fetch-failed']],
  );
  assert.equal(byMsg(logs, 'mention: decided').length, 0);
  assert.equal(byMsg(logs, 'elsewhere: settle failed').length, 0, 'a failed fetch is a drop, not a settle failure');
  assert.deepEqual(ringStates(scene), { m1: 'unanswered' });
});

test('events: stop clears every settle wait, and a timer that fires late starts nothing', async () => {
  const scene = routeScene();
  await routeSend(scene, scene.source, 0, { id: 'm1' });
  await routeSend(scene, scene.source2, 10, { id: 'm2', authorId: 'u2', authorName: 'Ίων' });
  assert.equal(scene.timers.live().length, 2);

  scene.handler.stop();
  assert.equal(scene.timers.live().length, 0, 'every timer cleared');
  scene.clock.set(routeAt(90));
  for (const timer of scene.timers.all) await scene.timers.fireOne(timer);
  assert.equal(scene.turns.calls.length, 0);
});

test('events: a pause clears armed settle timers; nothing fires afterwards', async () => {
  const scene = routeScene();
  await routeSend(scene, scene.source, 0, { id: 'm1' });
  await routeSend(scene, scene.source2, 10, { id: 'm2', authorId: 'u2', authorName: 'Ίων' });
  assert.equal(scene.timers.live().length, 2);

  const { logs } = await withCapturedLogs(() => scene.handler.clearPending());
  assert.equal(scene.timers.live().length, 0, 'every settle timer cleared');
  assert.deepEqual(
    byMsg(logs, 'elsewhere: dropped').map(({ source, kind, message, reason }) => [source, kind, message, reason]),
    [
      ['s1', 'ping', 'm1', 'paused'],
      ['s2', 'ping', 'm2', 'paused'],
    ],
  );

  // A timer that fires anyway starts nothing.
  const late = await withCapturedLogs(async () => {
    scene.clock.set(routeAt(120));
    for (const timer of scene.timers.all) await scene.timers.fireOne(timer);
    await scene.handler.drainPending();
  });
  assert.equal(scene.turns.calls.length, 0);
  assert.equal(byMsg(late.logs, 'elsewhere: settled').length, 0);
  assert.deepEqual(scene.store.state.data.elsewherePings.map((entry) => entry.answeredAt), [null, null], 'both stay unanswered in the ring');

  // A later message in the source arms nothing old; a new call there arms a wait of its own.
  const armed = scene.timers.all.length;
  await routeSend(scene, scene.source, 130, { id: 'm3', mention: false, authorId: 'u3', authorName: 'Χλόη', content: 'σημείωση' });
  assert.equal(scene.timers.all.length, armed, 'nothing to move or re-arm');
  const fresh = await withCapturedLogs(async () => {
    await routeSend(scene, scene.source, 140, { id: 'm4', authorId: 'u3', authorName: 'Χλόη' });
    await routeFire(scene, 230);
  });
  assert.deepEqual(byMsg(fresh.logs, 'elsewhere: settling').map(({ source, message }) => [source, message]), [['s1', 'm4']]);
  assert.deepEqual(scene.turns.calls.map((args) => args.trigger.id), ['m4'], 'only the new call is answered');
});

test('events: clearPending drops a queued routed ping with the rest of the queue', async () => {
  let busy = true;
  const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
  const scene = routeScene({ turns });
  await routeSend(scene, scene.source, 0, { id: 'm1' });
  const queued = await withCapturedLogs(() => routeFire(scene, 90));
  assert.deepEqual(
    byMsg(queued.logs, 'mention: deferred').map(({ channel, destination }) => [channel, destination]),
    [['s1', 'd1']],
    'the routed call waits in the queue, not dropped',
  );
  scene.handler.clearPending();
  busy = false;
  await scene.handler.drainPending();

  assert.equal(turns.calls.length, 0);
});

test('events: the settle wait marks no turn busy: a call in the main channel meanwhile is answered at once', async () => {
  const busy = new Set();
  const turns = recordingTurns({ outcome: 'spoke' }, { isBusy: (id) => busy.has(id), isAnyBusy: () => busy.size > 0 });
  const scene = routeScene({ turns });
  await routeSend(scene, scene.source, 0, { id: 'm1' });
  assert.equal(turns.isAnyBusy(), false, 'waiting holds no attention');

  await routeSend(scene, scene.main, 10, { id: 'm2', authorId: 'u2', authorName: 'Ίων' });
  assert.equal(turns.calls.length, 1, 'the call in the main channel runs now');
  assert.equal(turns.calls[0].channel, scene.main);
  assert.equal('source' in turns.calls[0], false);
  assert.equal(scene.timers.all.length, 1, 'a message in another channel does not move the settle');

  await routeFire(scene, 90);
  assert.equal(turns.calls.length, 2);
  assert.deepEqual(turns.calls[1].source, { channelId: 's1', reason: 'routed' });
});

test('events: features.elsewhere off drops the ping with cannot-send and route off', async () => {
  const scene = routeScene({ config: { features: { elsewhere: false } } });
  const { logs } = await withCapturedLogs(() => routeSend(scene, scene.source, 0, { id: 'm1' }));

  const dropped = byMsg(logs, 'mention: dropped');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].channel, 's1');
  assert.equal(dropped[0].kind, 'mention');
  assert.equal(dropped[0].reason, 'cannot-send');
  assert.equal(dropped[0].route, 'off');
  assert.equal(scene.timers.all.length, 0, 'no settle');
  assert.equal(scene.store.state.data.elsewherePings, undefined, 'not in the ring');
  assert.equal(scene.turns.calls.length, 0);
});

for (const [when, config, mainCanSend] of [
  ['memory.mainChannelIds is empty', { memory: { mainChannelIds: [] } }, true],
  ['the main channel is the source itself', { memory: { mainChannelIds: ['s1'] } }, true],
  ['the main channel is unknown', { memory: { mainChannelIds: ['d9'] } }, true],
  ['the bot cannot send in the main channel', {}, false],
]) {
  test(`events: no usable main channel drops with route no-destination (${when})`, async () => {
    const scene = routeScene({ config, mainCanSend });
    const { logs } = await withCapturedLogs(() => routeSend(scene, scene.source, 0, { id: 'm1' }));

    const dropped = byMsg(logs, 'mention: dropped');
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].reason, 'cannot-send');
    assert.equal(dropped[0].route, 'no-destination');
    assert.equal(scene.timers.all.length, 0);
    assert.equal(scene.store.state.data.elsewherePings, undefined);
  });
}

test('events: the audience rail drops a ping from a narrower channel with route audience', async () => {
  // @everyone views the main channel; only one role views the source.
  const scene = routeScene({ sourceViewers: ['r1'] });
  const { logs } = await withCapturedLogs(() => routeSend(scene, scene.source, 0, { id: 'm1' }));

  const dropped = byMsg(logs, 'mention: dropped');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].reason, 'cannot-send');
  assert.equal(dropped[0].route, 'audience');
  assert.equal(scene.timers.all.length, 0);
  assert.equal(scene.store.state.data.elsewherePings, undefined);
});

test('events: context.pull.sameAudience false lets a ping from a narrower channel through', async () => {
  const scene = routeScene({ sourceViewers: ['r1'], config: { context: { pull: { sameAudience: false } } } });
  await routeSend(scene, scene.source, 0, { id: 'm1' });
  await routeFire(scene, 90);
  assert.equal(scene.turns.calls.length, 1);
  assert.equal(scene.turns.calls[0].channel, scene.main);
});

test('events: a settle that fires while paused drops the call (paused)', async () => {
  const scene = routeScene();
  await routeSend(scene, scene.source, 0, { id: 'm1' });
  scene.store.state.data.paused = true;
  const { logs } = await withCapturedLogs(() => routeFire(scene, 90));

  assert.equal(scene.turns.calls.length, 0);
  const dropped = byMsg(logs, 'elsewhere: dropped');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].source, 's1');
  assert.equal(dropped[0].reason, 'paused');
  assert.equal(byMsg(logs, 'mention: decided').length, 0, 'never counted or rolled');
  assert.equal(scene.store.state.data.elsewherePings[0].answeredAt, null, 'the call stays unanswered in the ring');
});

for (const [reason, change] of [
  ['off', (scene) => (scene.config.features.elsewhere = false)],
  ['no-destination', (scene) => (scene.config.memory.mainChannelIds = [])],
  // @everyone loses the source; the main channel stays visible to everyone.
  ['audience', (scene) => scene.sourceViewers.splice(scene.sourceViewers.indexOf('g1'), 1)],
]) {
  test(`events: the route is checked again when the settle fires (${reason})`, async () => {
    const scene = routeScene();
    await routeSend(scene, scene.source, 0, { id: 'm1' });
    change(scene);
    const { logs } = await withCapturedLogs(() => routeFire(scene, 90));

    assert.equal(scene.turns.calls.length, 0);
    const dropped = byMsg(logs, 'elsewhere: dropped');
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].reason, reason);
  });
}

test('events: a routed call whose switch was turned off during the settle is not answered', async () => {
  const mention = { id: 'm1' };
  // A reply to the persona's own line in s1 (cached as hers), not a mention.
  const reply = { id: 'm1', mention: false, replyTo: 'm0', content: 'έχεις δίκιο' };
  const name = { id: 'm1', mention: false, content: 'νεπτούνια, δες εδώ' };
  for (const [label, call, kind, reason, change] of [
    ['mentions off', mention, 'mention', 'off', (config) => (config.features.mentions = false)],
    ['replies off', reply, 'reply', 'off', (config) => (config.features.replies = false)],
    ['nameTriggers off', name, 'name', 'off', (config) => (config.features.nameTriggers = false)],
  ]) {
    const scene = routeScene();
    scene.source.messages.cache.set('m0', { id: 'm0', author: { id: 'self1' } });
    await routeSend(scene, scene.source, 0, call);
    assert.equal(scene.timers.live().length, 1, `${label}: armed`);
    change(scene.config);
    const { logs } = await withCapturedLogs(() => routeFire(scene, 90));

    assert.equal(scene.turns.calls.length, 0, label);
    const dropped = byMsg(logs, 'mention: dropped');
    assert.equal(dropped.length, 1, label);
    assert.equal(dropped[0].channel, 's1', label);
    assert.equal(dropped[0].kind, kind, label);
    assert.equal(dropped[0].reason, reason, label);
    assert.equal(dropped[0].destination, undefined, 'dropped before a destination is resolved');
  }
});

test('events: the busy rules of a routed call are keyed by the main channel', async () => {
  // oneAtATime off: only a turn in the channel the routed turn posts in holds it back.
  for (const [busyId, expectTurn] of [['s1', true], ['d1', false]]) {
    const turns = recordingTurns({ outcome: 'spoke' }, { isBusy: (id) => id === busyId, isAnyBusy: () => true });
    const scene = routeScene({ turns, config: { mention: { oneAtATime: false } } });
    await routeSend(scene, scene.source, 0, { id: 'm1' });
    const { logs } = await withCapturedLogs(() => routeFire(scene, 90));

    assert.equal(turns.calls.length, expectTurn ? 1 : 0, `busy ${busyId}`);
    assert.equal(byMsg(logs, 'mention: dropped').length, 0, `busy ${busyId}: nothing dropped`);
    const deferred = byMsg(logs, 'mention: deferred');
    assert.equal(deferred.length, expectTurn ? 0 : 1, `busy ${busyId}`);
    if (!expectTurn) {
      assert.deepEqual(
        [deferred[0].channel, deferred[0].destination, deferred[0].sameChannel],
        ['s1', 'd1', true],
        'queued under its source; the busy check names the main channel',
      );
    }
  }
});

/** Lets the bot keep viewing `channel` but no longer send there. */
function revokeSend(scene, channel) {
  const original = channel.permissionsFor;
  channel.permissionsFor = (target) => (target === scene.guild.members.me ? { has: (flag) => flag !== SEND } : original(target));
}

test('events: a routed ping during a turn is queued under its source and drained into the destination', async () => {
  let busy = false;
  const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
  const scene = routeScene({ turns });
  await routeSend(scene, scene.source, 0, { id: 'm1' });
  busy = true;
  const { logs } = await withCapturedLogs(async () => {
    await routeFire(scene, 90);
    assert.equal(turns.calls.length, 0, 'held while the attention is taken');
    busy = false;
    scene.clock.set(routeAt(120));
    await scene.handler.drainPending();
  });

  const [deferred] = byMsg(logs, 'mention: deferred');
  assert.deepEqual(
    [deferred.channel, deferred.kind, deferred.destination, deferred.sameChannel, deferred.pending],
    ['s1', 'mention', 'd1', false, 1],
  );
  const [picked] = byMsg(logs, 'mention: picked up');
  assert.deepEqual([picked.channel, picked.destination], ['s1', 'd1']);
  const [decided] = byMsg(logs, 'mention: decided');
  assert.deepEqual([decided.channel, decided.destination, decided.deferred], ['s1', 'd1', true], 'counted and rolled at the drain');
  assert.equal(turns.calls.length, 1);
  const args = turns.calls[0];
  assert.equal(args.channel, scene.main, 'the drained turn posts in the main channel');
  assert.deepEqual(args.source, { channelId: 's1', reason: 'routed' });
  assert.deepEqual([args.mode, args.triggerKind, args.trigger.id], ['reply', 'mention', 'm1']);
  assert.equal(byMsg(logs, 'mention: dropped').length, 0);
  assert.equal(scene.store.state.data.elsewherePings[0].answeredAt, routeAt(120), 'answered once its drained turn spoke');
});

test("events: a routed ping at mention.maxPending evicts the oldest waiting call, the main channel's too, logged with counts", async () => {
  let busy = false;
  const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
  const scene = routeScene({ turns });
  const [c2, c3] = ['c2', 'c3'].map((id) => routeChannel(scene.guild, id));
  await routeSend(scene, scene.source, 0, { id: 'm1' });
  busy = true;
  // Three calls in writable channels, the main channel's first, wait for the running turn (mention.maxPending is 3).
  for (const [index, channel] of [scene.main, c2, c3].entries()) {
    await routeSend(scene, channel, 10 + index, { id: `w${index + 1}`, authorId: `u${index + 2}`, authorName: 'Ίων' });
  }
  const { logs } = await withCapturedLogs(async () => {
    await routeFire(scene, 90);
    busy = false;
    await scene.handler.drainPending();
  });

  const dropped = byMsg(logs, 'mention: dropped');
  assert.equal(dropped.length, 1);
  assert.deepEqual(
    [dropped[0].channel, dropped[0].kind, dropped[0].reason, dropped[0].pending, dropped[0].maxPending],
    ['d1', 'mention', 'full', 3, 3],
    "the main channel's own call, the oldest, made room -- logged with the counts",
  );
  assert.equal('destination' in dropped[0], false, 'the evicted call was written in the main channel itself');
  assert.equal(byMsg(logs, 'mention: deferred').at(-1).pending, 3);
  assert.deepEqual(
    turns.calls.map((args) => [args.channel.id, args.trigger.id, args.source?.channelId ?? null]),
    [['c2', 'w2', null], ['c3', 'w3', null], ['d1', 'm1', 's1']],
    'oldest first, the routed call into the main channel',
  );
});

test("events: a queued routed ping never replaces the main channel's own pending ping", async () => {
  let busy = true;
  const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
  const scene = routeScene({ turns });
  await routeSend(scene, scene.main, 0, { id: 'w1', authorId: 'u2', authorName: 'Ίων' });
  await routeSend(scene, scene.source, 5, { id: 'm1' });
  const { logs } = await withCapturedLogs(async () => {
    await routeFire(scene, 95);
    busy = false;
    await scene.handler.drainPending();
  });

  assert.equal(byMsg(logs, 'mention: dropped').length, 0);
  assert.deepEqual(
    turns.calls.map((args) => [args.channel.id, args.trigger.id, args.source?.channelId ?? null]),
    [['d1', 'w1', null], ['d1', 'm1', 's1']],
  );
});

test('events: a drained routed ping whose turn finds the attention taken is queued again with its destination', async () => {
  // oneAtATime off: only a turn in the main channel holds the routed call back -- never one in its source.
  const busyIds = new Set(['d1']);
  const results = [{ outcome: 'busy' }, { outcome: 'spoke' }];
  const calls = [];
  const turns = fakeTurns({
    isBusy: (id) => busyIds.has(id),
    isAnyBusy: () => busyIds.size > 0,
    runTurn: async (args) => {
      calls.push(args);
      // A turn starts in the main channel during the switch pause of the first attempt.
      if (calls.length === 1) busyIds.add('d1');
      return results.shift();
    },
  });
  const scene = routeScene({ turns, config: { mention: { oneAtATime: false } } });
  await routeSend(scene, scene.source, 0, { id: 'm1' });
  await routeFire(scene, 90);
  busyIds.clear();

  const first = await withCapturedLogs(() => scene.handler.drainPending());
  assert.equal(calls.length, 1, 'the pass stops while the main channel is busy');
  const [again] = byMsg(first.logs, 'mention: deferred again');
  assert.deepEqual([again.channel, again.destination, again.reason], ['s1', 'd1', 'busy']);

  busyIds.clear();
  const second = await withCapturedLogs(() => scene.handler.drainPending());
  assert.equal(calls.length, 2);
  assert.equal(calls[1].channel, scene.main);
  assert.deepEqual(calls[1].source, { channelId: 's1', reason: 'routed' });
  assert.equal(byMsg([...first.logs, ...second.logs], 'mention: decided').length, 1, 'decided once');
  assert.equal(scene.store.state.data.elsewherePings[0].answeredAt, routeAt(90));
});

test('events: the drain drops a routed ping when the destination can no longer send', async () => {
  let busy = true;
  const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
  const scene = routeScene({ turns });
  await routeSend(scene, scene.source, 0, { id: 'm1' });
  await routeFire(scene, 90);
  revokeSend(scene, scene.main);
  busy = false;
  const { logs } = await withCapturedLogs(() => scene.handler.drainPending());

  assert.equal(turns.calls.length, 0);
  const [dropped] = byMsg(logs, 'mention: dropped');
  assert.deepEqual(
    [dropped.channel, dropped.kind, dropped.reason, dropped.route, dropped.destination],
    ['s1', 'mention', 'cannot-send', 'no-destination', 'd1'],
    'no other main channel to take it: dropped by its route, with the code',
  );
  assert.equal(byMsg(logs, 'mention: decided').length, 0, 'never counted or rolled');
  assert.equal(scene.store.state.data.elsewherePings[0].answeredAt, null);
});

test('events: a drained routed ping posts in the main channel resolved now, not the one it waited with', async () => {
  for (const [label, mainBefore, change] of [
    ['the first main channel lost Send', ['d1', 'd2'], (scene) => revokeSend(scene, scene.main)],
    ['the main channel list changed', ['d1'], (scene) => (scene.config.memory.mainChannelIds = ['d2'])],
    [
      'the list changed after the old main channel lost Send',
      ['d1'],
      (scene) => {
        revokeSend(scene, scene.main);
        scene.config.memory.mainChannelIds = ['d2'];
      },
    ],
  ]) {
    let busy = true;
    const turns = recordingTurns({ outcome: 'spoke', mode: 'reply', delivered: true }, { isAnyBusy: () => busy });
    const scene = routeScene({ turns, config: { memory: { mainChannelIds: mainBefore } } });
    const second = routeChannel(scene.guild, 'd2');
    await routeSend(scene, scene.source, 0, { id: 'm1' });
    const { logs } = await withCapturedLogs(async () => {
      await routeFire(scene, 90);
      change(scene);
      busy = false;
      scene.clock.set(routeAt(120));
      await scene.handler.drainPending();
    });

    assert.equal(byMsg(logs, 'mention: deferred')[0].destination, 'd1', `${label}: it waited with d1`);
    assert.equal(byMsg(logs, 'mention: dropped').length, 0, label);
    assert.equal(turns.calls.length, 1, label);
    assert.equal(turns.calls[0].channel, second, `${label}: the turn posts in d2`);
    assert.deepEqual(turns.calls[0].source, { channelId: 's1', reason: 'routed' }, label);
    const [decided] = byMsg(logs, 'mention: decided');
    assert.deepEqual([decided.channel, decided.destination], ['s1', 'd2'], label);
    assert.equal(scene.store.state.data.elsewherePings[0].answeredAt, routeAt(120), label);
  }
});

for (const [reason, change] of [
  ['off', (scene) => (scene.config.features.elsewhere = false)],
  ['no-destination', (scene) => (scene.config.memory.mainChannelIds = [])],
  // @everyone loses the source; the main channel stays visible to everyone.
  ['audience', (scene) => scene.sourceViewers.splice(scene.sourceViewers.indexOf('g1'), 1)],
]) {
  test(`events: the drain checks the route of a queued routed ping again (${reason})`, async () => {
    let busy = true;
    const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
    const scene = routeScene({ turns });
    await routeSend(scene, scene.source, 0, { id: 'm1' });
    await routeFire(scene, 90);
    change(scene);
    busy = false;
    const { logs } = await withCapturedLogs(() => scene.handler.drainPending());

    assert.equal(turns.calls.length, 0);
    const [dropped] = byMsg(logs, 'mention: dropped');
    assert.deepEqual([dropped.channel, dropped.reason, dropped.route, dropped.destination], ['s1', 'cannot-send', reason, 'd1']);
    assert.equal(byMsg(logs, 'mention: decided').length, 0);
  });
}

test('events: a queued routed ping a turn already showed and answered is not answered again', async () => {
  let busy = true;
  let shown = false;
  const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
  turns.spokeAfterSeeing = (channelId, messageId) => shown && channelId === 's1' && messageId === 'm1';
  const scene = routeScene({ turns });
  await routeSend(scene, scene.source, 0, { id: 'm1' });
  await routeFire(scene, 90);
  // The running turn pulled s1, showed the queued call and spoke.
  shown = true;
  busy = false;
  scene.clock.set(routeAt(100));
  const { logs } = await withCapturedLogs(() => scene.handler.drainPending());

  assert.equal(turns.calls.length, 0);
  assert.deepEqual(
    byMsg(logs, 'mention: already answered').map((entry) => [entry.channel, entry.destination]),
    [['s1', 'd1']],
    'traceable to the main channel like every drain line of a routed call',
  );
  assert.equal(byMsg(logs, 'mention: decided').length, 0);
  // No later pull presents the call as waiting.
  const [entry] = scene.store.state.data.elsewherePings;
  assert.deepEqual([entry.answeredAt, entry.skippedAt], [null, routeAt(100)]);
  assert.deepEqual(byMsg(logs, 'elsewhere: marked').map(({ message, status }) => [message, status]), [['m1', 'skipped']]);
});

test('events: a queued routed ping the ring holds as answered is not answered again, though no turn remembers showing it', async () => {
  let busy = true;
  const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
  turns.spokeAfterSeeing = () => false;
  const scene = routeScene({ turns });
  await routeSend(scene, scene.source, 0, { id: 'm1' });
  await routeFire(scene, 90);
  // The running turn pulled s1 and answered the queued call; it stamped the ring, and the
  // view a later turn left in memory no longer holds the call.
  scene.store.state.data.elsewherePings[0].answeredAt = routeAt(95);
  busy = false;
  scene.clock.set(routeAt(100));
  const dirty = scene.store.dirtyCount;
  const { logs } = await withCapturedLogs(() => scene.handler.drainPending());

  assert.equal(turns.calls.length, 0);
  assert.deepEqual(
    byMsg(logs, 'mention: already answered').map(({ channel, kind, reason, destination }) => [channel, kind, reason, destination]),
    [['s1', 'mention', 'ring', 'd1']],
  );
  assert.equal(byMsg(logs, 'mention: decided').length, 0, 'never counted or rolled');
  assert.deepEqual(ringStates(scene), { m1: 'answered' });
  assert.equal(byMsg(logs, 'elsewhere: marked').length, 0);
  assert.equal(scene.store.dirtyCount, dirty);
});

/** A scene whose call `m1` of s1 settled while a turn was running: it waits in the queue. `release()` ends that turn. */
async function queuedRouteScene() {
  let busy = true;
  const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
  turns.spokeAfterSeeing = () => false;
  const scene = routeScene({ turns });
  await routeSend(scene, scene.source, 0, { id: 'm1' });
  await routeFire(scene, 90);
  scene.release = () => {
    busy = false;
    scene.clock.set(routeAt(100));
  };
  return scene;
}

test('events: a queued routed ping the ring holds as answered is logged as answered, never as gone or fetch-failed, and costs no lookup', async () => {
  for (const [label, answer] of LOOKUP_MISSES) {
    const scene = await queuedRouteScene();
    // The running turn pulled s1, answered the queued call and stamped the ring; then the call's
    // message left the cache (deleted, or swept) and cannot be looked up any more.
    scene.store.state.data.elsewherePings[0].answeredAt = routeAt(95);
    scene.source.messages.cache.delete('m1');
    const lookups = countLookups(scene.source, answer);
    scene.release();
    const { logs } = await withCapturedLogs(() => scene.handler.drainPending());

    assert.equal(scene.turns.calls.length, 0, label);
    assert.deepEqual(
      byMsg(logs, 'mention: already answered').map(({ channel, kind, reason, destination }) => [channel, kind, reason, destination]),
      [['s1', 'mention', 'ring', 'd1']],
      label,
    );
    assert.equal(byMsg(logs, 'mention: dropped').length, 0, `${label}: an answered call is not reported as lost`);
    assert.equal(lookups.count, 0, `${label}: no lookup for a call already answered`);
    assert.deepEqual(ringStates(scene), { m1: 'answered' }, label);
  }
});

test('events: a queued routed ping answered while its message is looked up is not answered again', async () => {
  for (const [label, answer] of [['found', async () => ({ id: 'm1' })], ...LOOKUP_MISSES]) {
    const scene = await queuedRouteScene();
    // Swept from the cache, so the drain has to fetch it. While that fetch is in flight another
    // turn that showed the call speaks and stamps the ring.
    scene.source.messages.cache.delete('m1');
    const lookups = countLookups(scene.source, async () => {
      scene.store.state.data.elsewherePings[0].answeredAt = routeAt(100);
      return answer();
    });
    scene.release();
    const { logs } = await withCapturedLogs(() => scene.handler.drainPending());

    assert.equal(lookups.count, 1, label);
    assert.equal(scene.turns.calls.length, 0, label);
    assert.deepEqual(
      byMsg(logs, 'mention: already answered').map(({ channel, kind, reason, destination }) => [channel, kind, reason, destination]),
      [['s1', 'mention', 'ring', 'd1']],
      label,
    );
    assert.equal(byMsg(logs, 'mention: dropped').length, 0, label);
    assert.equal(byMsg(logs, 'mention: decided').length, 0, `${label}: never counted or rolled`);
  }
});

test('events: queued routed pings a speaking turn already showed are each dropped as already answered, the ring stamped skipped', async () => {
  let busy = true;
  const seen = new Set();
  const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
  turns.spokeAfterSeeing = (channelId, messageId) => channelId === 's1' && seen.has(messageId);
  const scene = routeScene({ turns });
  // m1 waits in the queue; m2, a later call of the same source, waits beside it.
  await routeSend(scene, scene.source, 0, { id: 'm1' });
  await routeFire(scene, 90);
  await routeSend(scene, scene.source, 100, { id: 'm2', authorId: 'u2', authorName: 'Ίων' });
  await routeFire(scene, 190);
  // The running turn pulled s1, showed both calls and spoke.
  for (const id of ['m1', 'm2']) seen.add(id);
  busy = false;
  scene.clock.set(routeAt(200));
  const { logs } = await withCapturedLogs(() => scene.handler.drainPending());

  assert.equal(turns.calls.length, 0);
  assert.deepEqual(byMsg(logs, 'mention: already answered').map((line) => line.channel), ['s1', 's1'], 'the seen rule still holds for routed calls');
  assert.deepEqual(ringStates(scene), { m1: 'skipped', m2: 'skipped' });
});

test('events: a routed ping enters the ring and is marked answered when the turn spoke', async () => {
  const scene = routeScene();
  await routeSend(scene, scene.source, 0, { id: 'm1', ts: routeAt(-5) });
  assert.deepEqual(scene.store.state.data.elsewherePings, [
    { messageId: 'm1', channelId: 's1', ts: routeAt(-5), answeredAt: null, skippedAt: null },
  ]);
  const dirty = scene.store.dirtyCount;
  const { logs } = await withCapturedLogs(() => routeFire(scene, 90));

  assert.deepEqual(scene.store.state.data.elsewherePings, [
    { messageId: 'm1', channelId: 's1', ts: routeAt(-5), answeredAt: routeAt(90), skippedAt: null },
  ]);
  assert.ok(scene.store.dirtyCount > dirty, 'the ring is marked dirty');
  assert.deepEqual(
    byMsg(logs, 'elsewhere: marked').map(({ source, message, status }) => ({ source, message, status })),
    [{ source: 's1', message: 'm1', status: 'answered' }],
  );
});

test('events: a routed call the persona let pass is marked skipped, one whose turn did not reach a decision stays unanswered', async () => {
  for (const [result, status] of [
    [{ outcome: 'skip', mode: 'reply' }, 'skipped'],
    // It chose to answer, but nothing reached the chat (its only reaction was dropped or refused).
    [{ outcome: 'spoke', mode: 'reply', delivered: false }, 'skipped'],
    [{ outcome: 'error' }, 'unanswered'],
    [{ outcome: 'refused', limit: null }, 'unanswered'],
    [{ outcome: 'paused' }, 'unanswered'],
  ]) {
    const scene = routeScene({ turns: recordingTurns(result) });
    await routeSend(scene, scene.source, 0, { id: 'm1' });
    const { logs } = await withCapturedLogs(() => routeFire(scene, 90));

    const [entry] = scene.store.state.data.elsewherePings;
    assert.equal(scene.turns.calls.length, 1, result.outcome);
    assert.deepEqual(
      [entry.answeredAt, entry.skippedAt],
      status === 'skipped' ? [null, routeAt(90)] : [null, null],
      result.outcome,
    );
    assert.deepEqual(byMsg(logs, 'elsewhere: marked').map((line) => line.status), status === 'skipped' ? ['skipped'] : [], result.outcome);
  }
});

test('events: dry run never marks a ring entry answered', async () => {
  const scene = routeScene({ turns: recordingTurns({ outcome: 'spoke', mode: 'reply', dryRun: true }), config: { features: { dryRun: true } } });
  await routeSend(scene, scene.source, 0, { id: 'm1' });
  const dirty = scene.store.dirtyCount;
  const { logs } = await withCapturedLogs(() => routeFire(scene, 90));

  assert.equal(scene.turns.calls.length, 1);
  const [entry] = scene.store.state.data.elsewherePings;
  assert.deepEqual([entry.answeredAt, entry.skippedAt], [null, null], 'nothing reached the chat');
  assert.equal(scene.store.dirtyCount, dirty);
  assert.equal(byMsg(logs, 'elsewhere: marked').length, 0);

  // A dry-run skip is the persona's silence like any skip (a skip claims no answer): stamped skipped.
  const quiet = routeScene({ turns: recordingTurns({ outcome: 'skip', mode: 'reply' }), config: { features: { dryRun: true } } });
  await routeSend(quiet, quiet.source, 0, { id: 'm1' });
  const skipped = await withCapturedLogs(() => routeFire(quiet, 90));
  const [silent] = quiet.store.state.data.elsewherePings;
  assert.deepEqual([silent.answeredAt, silent.skippedAt], [null, routeAt(90)]);
  assert.deepEqual(byMsg(skipped.logs, 'elsewhere: marked').map((line) => line.status), ['skipped']);
});

/** The state of each ring entry by message id: `answered`, `skipped` or `unanswered`. */
function ringStates(scene) {
  return Object.fromEntries(scene.store.state.data.elsewherePings.map((entry) => [entry.messageId, pingStatus(entry)]));
}

test("events: a routed turn's outcome stamps its own call only; the other calls it showed are the turn's to stamp", async () => {
  // m1 and m2 in one settle: the newer m2 takes the wait. A real turn that showed m1 stamps it
  // itself -- answered when its output answered m1, skipped otherwise (src/behavior/turn.js,
  // tests/turn.test.js); the fake turn here stamps nothing, so m1 shows what the caller does.
  for (const [label, result, states, marked] of [
    ['spoke', { outcome: 'spoke', mode: 'reply', delivered: true }, { m1: 'unanswered', m2: 'answered' }, [['m2', 'answered']]],
    ['skip', { outcome: 'skip', mode: 'reply' }, { m1: 'unanswered', m2: 'skipped' }, [['m2', 'skipped']]],
    ['dry run', { outcome: 'spoke', mode: 'reply', dryRun: true }, { m1: 'unanswered', m2: 'unanswered' }, []],
    ['error', { outcome: 'error' }, { m1: 'unanswered', m2: 'unanswered' }, []],
  ]) {
    const scene = routeScene({ turns: recordingTurns(result) });
    await routeSend(scene, scene.source, 0, { id: 'm1' });
    await routeSend(scene, scene.source, 20, { id: 'm2', authorId: 'u2', authorName: 'Ίων' });
    const { logs } = await withCapturedLogs(() => routeFire(scene, 110));

    assert.deepEqual(scene.turns.calls.map((args) => args.trigger.id), ['m2'], label);
    assert.deepEqual(ringStates(scene), states, label);
    assert.deepEqual(byMsg(logs, 'elsewhere: marked').map(({ message, status }) => [message, status]), marked, label);
  }

  // Earlier stamps are kept and only what changed is logged; a call skipped during its wait (a
  // turn that showed it chose silence) is answered when its own routed turn reaches the chat.
  const scene = routeScene({ turns: recordingTurns({ outcome: 'spoke', mode: 'reply', delivered: true }) });
  scene.store.state.data.elsewherePings = [
    { messageId: 'm0', channelId: 's1', ts: routeAt(-60), answeredAt: routeAt(-30), skippedAt: null },
    { messageId: 'm1', channelId: 's1', ts: routeAt(-20), answeredAt: null, skippedAt: routeAt(-10) },
  ];
  await routeSend(scene, scene.source, 0, { id: 'm2' });
  scene.store.state.data.elsewherePings.find((entry) => entry.messageId === 'm2').skippedAt = routeAt(30);
  const { logs } = await withCapturedLogs(() => routeFire(scene, 90));
  assert.deepEqual(ringStates(scene), { m0: 'answered', m1: 'skipped', m2: 'answered' });
  assert.deepEqual(byMsg(logs, 'elsewhere: marked').map(({ message, status }) => [message, status]), [['m2', 'answered']], 'only what changed is logged');
});

test('events: a routed call the ignore roll lets pass is stamped skipped and runs no turn', async () => {
  // The live path once the settle is over, and the drain of a call queued meanwhile.
  for (const queued of [false, true]) {
    let busy = queued;
    const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
    const scene = routeScene({ turns, config: { mention: { ignoreChance: 1 } } });
    await routeSend(scene, scene.source, 0, { id: 'm1' });
    const { logs } = await withCapturedLogs(async () => {
      await routeFire(scene, 90);
      busy = false;
      if (queued) {
        scene.clock.set(routeAt(100));
        await scene.handler.drainPending();
      }
    });

    assert.equal(turns.calls.length, 0, `queued ${queued}`);
    const [decided] = byMsg(logs, 'mention: decided');
    assert.deepEqual([decided.reason, decided.destination], ['ignored:random', 'd1'], `queued ${queued}`);
    const [entry] = scene.store.state.data.elsewherePings;
    assert.deepEqual([entry.answeredAt, entry.skippedAt], [null, routeAt(queued ? 100 : 90)], `queued ${queued}`);
    assert.deepEqual(byMsg(logs, 'elsewhere: marked').map(({ source, message, status }) => [source, message, status]), [['s1', 'm1', 'skipped']]);
  }
});

test('events: a routed call the ignore roll lets pass takes the calls its settle replaced with it; queued calls are decided each', async () => {
  // The settle groups a burst into one decision: a call a newer one replaced in the settle wait,
  // or a weaker one the waiting call outranked, shares its decline. Calls that each waited in
  // the pending queue are messages of their own: each meets the ignore roll.
  const mention = (id, authorId = 'u1') => ({ id, authorId, authorName: 'Ίων' });
  const name = (id) => ({ id, mention: false, authorId: 'u3', authorName: 'Χλόη', content: 'η νεπτούνια είναι αστεία' });
  // [label, calls as [seconds, spec], the settle fire after each call (none: one fire after both,
  // nothing held), the authors of the calls that were decided]
  const cases = [
    ['replaced in the settle', [[0, mention('m1')], [20, mention('m2', 'u2')]], [], ['u2']],
    ['outranked in the settle', [[0, mention('m1')], [20, name('m2')]], [], ['u1']],
    ['each waiting in the pending queue', [[0, mention('m1')], [100, mention('m2', 'u2')]], [90, 190], ['u1', 'u2']],
  ];
  for (const [label, calls, fires, decidedAuthors] of cases) {
    let busy = fires.length > 0;
    const turns = recordingTurns({ outcome: 'spoke' }, { isAnyBusy: () => busy });
    const scene = routeScene({ turns, config: { mention: { ignoreChance: 1 } } });
    // m0, an older call no turn ever showed (lost in a restart), is not part of this burst.
    scene.store.state.data.elsewherePings = [{ messageId: 'm0', channelId: 's1', ts: routeAt(-600), answeredAt: null, skippedAt: null }];
    const { logs } = await withCapturedLogs(async () => {
      for (const [index, [seconds, spec]] of calls.entries()) {
        await routeSend(scene, scene.source, seconds, spec);
        if (fires[index] !== undefined) await routeFire(scene, fires[index]);
      }
      if (fires.length === 0) await routeFire(scene, 110);
      busy = false;
      scene.clock.set(routeAt(200));
      await scene.handler.drainPending();
    });

    assert.equal(turns.calls.length, 0, label);
    const decided = byMsg(logs, 'mention: decided');
    assert.deepEqual(
      decided.map((line) => [line.reason, line.author, line.channel, line.destination]),
      decidedAuthors.map((author) => ['ignored:random', author, 's1', 'd1']),
      `${label}: one decision per message`,
    );
    assert.deepEqual(ringStates(scene), { m0: 'unanswered', m1: 'skipped', m2: 'skipped' }, label);
    assert.deepEqual(
      byMsg(logs, 'elsewhere: marked').map(({ source, message, status }) => [source, message, status]).sort((a, b) => a[1].localeCompare(b[1])),
      [['s1', 'm1', 'skipped'], ['s1', 'm2', 'skipped']],
      label,
    );
  }
});

test('events: a routed call queued after an older one from its source waits beside it; each gets its own turn', async () => {
  let busy = false;
  const turns = recordingTurns({ outcome: 'spoke', mode: 'reply', delivered: true }, { isAnyBusy: () => busy });
  const scene = routeScene({ turns });
  await routeSend(scene, scene.source, 0, { id: 'm1' });
  busy = true;
  const { logs } = await withCapturedLogs(async () => {
    await routeFire(scene, 90);
    await routeSend(scene, scene.source, 100, { id: 'm2', authorId: 'u2', authorName: 'Ίων' });
    await routeFire(scene, 190);
    busy = false;
    await scene.handler.drainPending();
  });

  assert.deepEqual(byMsg(logs, 'mention: deferred').map(({ channel, destination }) => [channel, destination]), [['s1', 'd1'], ['s1', 'd1']]);
  assert.deepEqual(byMsg(logs, 'mention: dropped'), [], 'no call leaves the queue');
  assert.deepEqual(turns.calls.map((args) => args.trigger.id), ['m1', 'm2']);
  assert.equal(turns.calls.every((args) => args.queued === null), true, 'a routed call names no queued call');
  // Each turn spoke: the caller stamps each call by its own turn.
  assert.deepEqual(ringStates(scene), { m1: 'answered', m2: 'answered' });
});

test('events: a routed turn that ends while paused leaves the ring untouched', async () => {
  const scene = routeScene({ turns: fakeTurns() });
  scene.turns.runTurn = async () => {
    // The owner pauses while the turn runs: nothing may mark the store dirty afterwards.
    scene.store.state.data.paused = true;
    return { outcome: 'spoke' };
  };
  await routeSend(scene, scene.source, 0, { id: 'm1' });
  const dirty = scene.store.dirtyCount;
  await routeFire(scene, 90);

  assert.equal(scene.store.state.data.elsewherePings[0].answeredAt, null);
  assert.equal(scene.store.dirtyCount, dirty);
});

test('events: a routed name call while busy is held and answered in the main channel once the attention frees', async () => {
  let busy = true;
  const turns = recordingTurns({ outcome: 'spoke', mode: 'reply', delivered: true }, { isAnyBusy: () => busy });
  // Exactly two values: the switch pause and the name-trigger roll at drain time.
  const scene = routeScene({ turns, rng: scripted([0.5, 0.2]) });
  await routeSend(scene, scene.source, 0, { id: 'm1', mention: false, content: 'νεπτούνια, δες εδώ' });
  const { logs } = await withCapturedLogs(() => routeFire(scene, 90));

  assert.equal(turns.calls.length, 0, 'not run while the attention is taken');
  assert.deepEqual(byMsg(logs, 'mention: dropped'), [], 'nothing dropped');
  assert.equal(byMsg(logs, 'mention: decided').length, 0, 'not rolled on arrival');
  assert.deepEqual(
    byMsg(logs, 'mention: deferred').map(({ channel, kind, destination }) => [channel, kind, destination]),
    [['s1', 'name', 'd1']],
  );

  busy = false;
  const drained = await withCapturedLogs(() => scene.handler.drainPending());
  assert.deepEqual(
    byMsg(drained.logs, 'mention: decided').map(({ kind, reason, channel, destination }) => [kind, reason, channel, destination]),
    [['name', 'name', 's1', 'd1']],
  );
  assert.equal(turns.calls.length, 1);
  assert.equal(turns.calls[0].channel, scene.main);
  assert.equal(turns.calls[0].triggerKind, 'name');
  assert.deepEqual(turns.calls[0].source, { channelId: 's1', reason: 'routed' });
  assert.deepEqual(ringStates(scene), { m1: 'answered' });
});

test('events: a routed name call whose main channel is busy is held before the dice and rolled at drain time', async () => {
  // oneAtATime off: the turn running in the main channel is the one that holds the call back.
  let busy = true;
  const tagHistory = countingTagHistory();
  const turns = recordingTurns({ outcome: 'spoke' }, { isBusy: (id) => busy && id === 'd1', isAnyBusy: () => busy });
  // Exactly two values, both at drain time: the switch pause and the name-trigger roll (above the chance).
  const scene = routeScene({ turns, tagHistory, rng: scripted([0.5, 0.7]), config: { mention: { oneAtATime: false, nameTriggerChance: 0.5 } } });
  await routeSend(scene, scene.source, 0, { id: 'm1', mention: false, content: 'νεπτούνια, δες εδώ' });
  const { logs } = await withCapturedLogs(() => routeFire(scene, 90));

  assert.equal(turns.calls.length, 0);
  assert.equal(tagHistory.hits, 0, 'not counted on arrival');
  assert.equal(byMsg(logs, 'mention: decided').length, 0, 'not rolled on arrival');
  assert.deepEqual(byMsg(logs, 'mention: dropped'), [], 'nothing dropped');
  assert.deepEqual(
    byMsg(logs, 'mention: deferred').map(({ channel, kind, sameChannel, destination }) => [channel, kind, sameChannel, destination]),
    [['s1', 'name', true, 'd1']],
  );
  assert.equal(byMsg(logs, 'elsewhere: settle failed').length, 0);
  // Waiting is not her choice: the call is neither answered nor skipped yet.
  assert.deepEqual(ringStates(scene), { m1: 'unanswered' });
  assert.equal(byMsg(logs, 'elsewhere: marked').length, 0);

  busy = false;
  const drained = await withCapturedLogs(() => scene.handler.drainPending());
  assert.equal(tagHistory.hits, 1, 'counted once, at drain time');
  assert.deepEqual(
    byMsg(drained.logs, 'mention: decided').map(({ kind, reason, deferred }) => [kind, reason, deferred]),
    [['name', 'name-unnoticed', true]],
  );
  assert.equal(turns.calls.length, 0, 'the roll let it pass');
  // Letting it pass is her choice: stamped skipped.
  assert.deepEqual(ringStates(scene), { m1: 'skipped' });
});

test('events: a refused routed turn posts the notice in the destination, not as a reply', async () => {
  const limit = { key: 'llm.maxRequestsPerDay', used: 800, cap: 800 };
  // The live path and the drain of a queued call alike.
  for (const queued of [false, true]) {
    let busy = queued;
    const turns = recordingTurns({ outcome: 'refused', limit }, { isAnyBusy: () => busy });
    const scene = routeScene({ turns, prompts: { labels } });
    await routeSend(scene, scene.source, 0, { id: 'm1' });
    const { logs } = await withCapturedLogs(async () => {
      await routeFire(scene, 90);
      busy = false;
      if (queued) await scene.handler.drainPending();
    });

    assert.equal(turns.calls.length, 1, `queued ${queued}`);
    assert.deepEqual(
      scene.main.sent,
      [{ content: 'limit reached (llm.maxRequestsPerDay, 800/800)', reply: undefined, allowedMentions: { parse: [] } }],
      `queued ${queued}: one plain line in the main channel, quoting nothing`,
    );
    assert.equal(scene.source.sent.length, 0, 'never in the channel it cannot write in');
    assert.deepEqual(byMsg(logs, 'limits: notice sent').map((entry) => entry.channel), ['d1']);
    assert.equal(scene.store.state.data.elsewherePings[0].answeredAt, null, 'a refusal answers nothing');
  }

  // Dry-run: logged and mirrored under the main channel, sent nowhere.
  const mirrored = [];
  const turns = recordingTurns({ outcome: 'refused', limit });
  const scene = routeScene({ turns, prompts: { labels }, config: { features: { dryRun: true }, bot: { dryRunChannelId: 'mirror1' } } });
  const mirrorHot = { config: scene.config, prompts: { labels } };
  const mirrorClient = { ...fakeClient(), channels: { fetch: async () => ({ send: async (payload) => mirrored.push(payload) }) } };
  scene.handler = asDiscordEvents(createMessageHandler({
    hot: mirrorHot,
    store: scene.store,
    client: mirrorClient,
    discord: DISCORD,
    turns,
    spontaneous: fakeSpontaneous(),
    memory: fakeMemory(),
    tagHistory: createTagHistory(),
    getGuildId: () => 'g1',
    rng: () => 0.5,
    now: scene.clock,
    sleep: async () => {},
    timers: scene.timers,
  }), mirrorHot, mirrorClient);
  await routeSend(scene, scene.source, 0, { id: 'm1' });
  const { logs } = await withCapturedLogs(() => routeFire(scene, 90));

  assert.deepEqual([scene.main.sent, scene.source.sent], [[], []]);
  assert.deepEqual(byMsg(logs, 'dry-run: would notify limit').map((entry) => entry.channel), ['d1']);
  assert.equal(mirrored.length, 1);
  assert.ok(mirrored[0].content.startsWith('[dry-run] #d1 · limit'), mirrored[0].content);
});

test('events: a settle whose turn throws is logged and never escapes the timer', async () => {
  const turns = fakeTurns({
    runTurn: () => {
      throw new Error('boom');
    },
  });
  const scene = routeScene({ turns });
  await routeSend(scene, scene.source, 0, { id: 'm1' });
  const { logs } = await withCapturedLogs(() => routeFire(scene, 90));

  const [failed] = byMsg(logs, 'elsewhere: settle failed');
  assert.equal(failed.source, 's1');
});

test('events: a name written in a read-only channel is routed and rolls the ordinary name-trigger chance', async () => {
  for (const [roll, answered] of [[0.7, false], [0.2, true]]) {
    const scene = routeScene({ config: { mention: { nameTriggerChance: 0.5 } }, rng: scripted([roll]) });
    await routeSend(scene, scene.source, 0, { id: 'm1', mention: false, content: 'νεπτούνια, δες εδώ' });
    assert.equal(scene.store.state.data.elsewherePings.length, 1, 'a name call enters the ring too');
    const { logs } = await withCapturedLogs(() => routeFire(scene, 90));

    const [decided] = byMsg(logs, 'mention: decided');
    assert.equal(decided.kind, 'name');
    assert.equal(decided.reason, answered ? 'name' : 'name-unnoticed');
    assert.equal(scene.turns.calls.length, answered ? 1 : 0);
    if (answered) {
      assert.equal(scene.turns.calls[0].triggerKind, 'name');
      assert.deepEqual(scene.turns.calls[0].source, { channelId: 's1', reason: 'routed' });
    }
    // She may skip a name there like anywhere: a later pull never presents it as waiting.
    assert.deepEqual(ringStates(scene), { m1: answered ? 'answered' : 'skipped' }, `roll ${roll}`);
  }
});

test('events: a restart during the settle wait loses the timer and leaves the ring entry unanswered', async () => {
  const store = fakeStateStore();
  const before = routeScene({ store });
  await routeSend(before, before.source, 0, { id: 'm1' });
  assert.equal(before.timers.live().length, 1);

  // The process restarts: the old timer is gone with it, the state survives.
  const after = routeScene({ store });
  await routeFire(after, 300);
  assert.equal(after.timers.all.length, 0, 'nothing re-arms a lost wait');
  assert.equal(after.turns.calls.length, 0);
  assert.equal(before.turns.calls.length, 0);
  assert.deepEqual(store.state.data.elsewherePings, [
    { messageId: 'm1', channelId: 's1', ts: routeAt(0), answeredAt: null, skippedAt: null },
  ]);
});

test('events: a call answered before a restart is not answered again when the same message reaches the new process', async () => {
  const store = fakeStateStore();
  const before = routeScene({ store });
  await routeSend(before, before.source, 0, { id: 'm1' });
  await routeFire(before, 90);
  assert.deepEqual(before.turns.calls.map((args) => args.trigger.id), ['m1']);
  assert.deepEqual(ringStates(before), { m1: 'answered' });

  // The process restarts: no turn in memory remembers that answer, the ring in state.json does.
  // The gateway hands the same call over once more.
  const after = routeScene({ store, rng: scripted([]) });
  const { logs } = await withCapturedLogs(async () => {
    await routeSend(after, after.source, 100, { id: 'm1', ts: routeAt(0) });
    await routeFire(after, 190);
  });

  assert.equal(after.turns.calls.length, 0);
  assert.deepEqual(byMsg(logs, 'mention: already answered').map(({ channel, reason }) => [channel, reason]), [['s1', 'ring']]);
  assert.equal(byMsg(logs, 'mention: decided').length, 0, 'never counted or rolled again');
  assert.deepEqual(store.state.data.elsewherePings, [
    { messageId: 'm1', channelId: 's1', ts: routeAt(0), answeredAt: routeAt(90), skippedAt: null },
  ]);
});

test('events: a call in a writable channel is untouched by routing', async () => {
  const scene = routeScene();
  const { logs } = await withCapturedLogs(() => routeSend(scene, scene.main, 0, { id: 'm1' }));

  assert.equal(scene.turns.calls.length, 1, 'answered at once');
  const args = scene.turns.calls[0];
  assert.equal(args.channel, scene.main);
  assert.equal('source' in args, false);
  assert.equal(scene.timers.all.length, 0);
  assert.equal(scene.store.state.data.elsewherePings, undefined);
  assert.equal(byMsg(logs, 'mention: decided')[0].destination, undefined);
});

// ---------------------------------------------------------------------------
// Noticed comments: an eavesdrop hit on an untriggered message in a read-only
// channel (spontaneous.noticeElsewhere) arms a settle wait of kind `noticed`;
// when it is over, spontaneous.runNoticed runs the comment. events.js is only
// the glue: the rails and the roll are the scheduler's.

/**
 * A fake scheduler for the noticed path: `noticeElsewhere` answers `hit` (recording its calls),
 * `runNoticed` records the source it got and answers `result`.
 */
function noticingSpontaneous({ hit = true, result = { outcome: 'spoke' } } = {}) {
  const fake = fakeSpontaneous();
  fake.noticeCalls = [];
  fake.runCalls = [];
  fake.noticeElsewhere = (channel, normalized) => {
    fake.noticeCalls.push({ channel, normalized });
    return hit;
  };
  fake.runNoticed = async (channel) => {
    fake.runCalls.push(channel);
    return result;
  };
  return fake;
}

/** An untriggered member line in `channel`. */
const plainLine = (id, extra = {}) => ({ id, mention: false, authorId: 'u2', authorName: 'Ίων', content: 'σημείωση', ...extra });

test('events: an eavesdrop hit in a read-only channel settles, then runs the noticed turn', async () => {
  const spontaneous = noticingSpontaneous();
  const scene = routeScene({ spontaneous });
  const { logs } = await withCapturedLogs(async () => {
    await routeSend(scene, scene.source, 0, plainLine('m1'));
    assert.equal(spontaneous.noticeCalls.length, 1);
    assert.equal(spontaneous.noticeCalls[0].channel, scene.source);
    assert.equal(spontaneous.noticeCalls[0].normalized.id, 'm1');
    assert.equal(scene.timers.live().length, 1, 'one settle timer for the source');
    assert.equal(scene.timers.live()[0].ms, 90 * SECOND);

    await routeSend(scene, scene.source, 30, plainLine('m2', { authorId: 'u3', authorName: 'Χλόη' }));
    assert.equal(spontaneous.noticeCalls.length, 1, 'a wait already armed in the source asks no second roll');
    assert.equal(spontaneous.runCalls.length, 0, 'nothing runs before the source settles');
    await routeFire(scene, 120);
  });

  assert.deepEqual(spontaneous.runCalls, [scene.source], 'the noticed comment runs on its source');
  assert.equal(scene.turns.calls.length, 0, 'the turn is the scheduler\'s, not a call\'s');
  assert.equal(scene.store.state.data.elsewherePings, undefined, 'a noticed message is no call of the ring');
  assert.deepEqual(
    byMsg(logs, 'elsewhere: settling').map(({ source, kind, message, destination }) => ({ source, kind, message, destination })),
    [{ source: 's1', kind: 'noticed', message: 'm1', destination: 'd1' }],
  );
  const [settled] = byMsg(logs, 'elsewhere: settled');
  assert.equal(settled.kind, 'noticed');
  assert.equal(settled.waitedMs, 120 * SECOND);
  assert.equal(settled.moved, 1);
  assert.equal(byMsg(logs, 'elsewhere: dropped').length, 0);
});

test('events: a call arriving during a noticed settle takes its place', async () => {
  const spontaneous = noticingSpontaneous();
  const scene = routeScene({ spontaneous });
  const { logs } = await withCapturedLogs(async () => {
    await routeSend(scene, scene.source, 0, plainLine('m1'));
    await routeSend(scene, scene.source, 30, { id: 'm2' });
    assert.equal(scene.timers.live().length, 1, 'still one wait for the source');
    await routeFire(scene, 120);
  });

  assert.equal(spontaneous.runCalls.length, 0, 'no noticed comment once a call took the wait');
  assert.equal(scene.turns.calls.length, 1);
  const [args] = scene.turns.calls;
  assert.equal(args.channel, scene.main);
  assert.equal(args.trigger.id, 'm2');
  assert.deepEqual(args.source, { channelId: 's1', reason: 'routed' });
  assert.deepEqual(
    byMsg(logs, 'elsewhere: dropped').map(({ source, kind, message, reason }) => [source, kind, message, reason]),
    [['s1', 'noticed', 'm1', 'replaced']],
  );
  assert.equal(byMsg(logs, 'elsewhere: settled')[0].kind, 'ping');
  assert.equal(byMsg(logs, 'elsewhere: settled')[0].waitedMs, 120 * SECOND, 'the wait keeps its start');
  assert.deepEqual(scene.store.state.data.elsewherePings.map((entry) => entry.messageId), ['m2'], 'only the call is in the ring');
});

test('events: a noticed settle that ends while paused runs nothing', async () => {
  const spontaneous = noticingSpontaneous();
  const scene = routeScene({ spontaneous });
  await routeSend(scene, scene.source, 0, plainLine('m1'));
  scene.store.state.data.paused = true;
  const { logs } = await withCapturedLogs(() => routeFire(scene, 90));
  assert.equal(spontaneous.runCalls.length, 0);
  assert.deepEqual(
    byMsg(logs, 'elsewhere: dropped').map(({ kind, reason }) => [kind, reason]),
    [['noticed', 'paused']],
  );
});

test('events: an eavesdrop miss, or a writable channel, arms no noticed settle', async () => {
  const miss = noticingSpontaneous({ hit: false });
  const missScene = routeScene({ spontaneous: miss });
  await routeSend(missScene, missScene.source, 0, plainLine('m1'));
  assert.equal(miss.noticeCalls.length, 1);
  assert.equal(missScene.timers.all.length, 0, 'a miss arms nothing');

  const writable = noticingSpontaneous();
  const writableScene = routeScene({ spontaneous: writable });
  await routeSend(writableScene, writableScene.main, 0, plainLine('m1'));
  assert.equal(writable.noticeCalls.length, 0, 'a channel the bot can send in is never a source');
  assert.equal(writable.onMessageCalls.length, 1, 'its ordinary eavesdrop is unchanged');
  assert.equal(writableScene.timers.all.length, 0);
});

// ---------------------------------------------------------------------------
// Room questions (spontaneous.roomQuestionChance) -- a line put to everyone
// present, outside any follow-up window, that failed the eavesdrop roll may
// roll the room chance; the room classifier (room.md) then says yes or no,
// and a yes schedules an unprompted turn about that line.

const ROOM_T0 = Date.UTC(2026, 0, 5, 12, 0, 0);

/** A spontaneous scheduler stand-in: onMessage answers `scheduled`, eavesdropReady answers `ready`. */
function roomSpontaneous({ scheduled = false, ready = true } = {}) {
  const calls = [];
  const readyCalls = [];
  return {
    calls,
    readyCalls,
    onMessage: (...args) => {
      calls.push(args);
      return typeof scheduled === 'function' ? scheduled(...args) : scheduled;
    },
    eavesdropReady: (channel) => {
      readyCalls.push(channel);
      return ready;
    },
  };
}

function fakeRoomPrompts() {
  return { ...fakeAddressPrompts(), room: 'You watch the room for {{name}}. Is the candidate put to everyone? Answer yes or no.' };
}

/** A channel holding one earlier line, the room scene's clock fixed at ROOM_T0. */
function roomChannel(id = 'c1', guild = fakeGuild('g1', 'Neptunia')) {
  const history = [rawHistoryMessage({ id: `${id}-h1`, authorId: 'u2', authorName: 'Ἀλέξης', ts: ROOM_T0 - 60000, content: 'earlier line', channelId: id })];
  return fakeChannelWithHistory(id, guild, history);
}

function roomMessage(channel, overrides = {}) {
  return fakeMessage({
    id: 'm-room',
    guild: channel.guild,
    channel,
    channelId: channel.id,
    author: { id: 'u7', bot: false, globalName: 'Ελένη', username: 'el' },
    member: { displayName: 'Ελένη' },
    cleanContent: 'ποιος θέλει καφέ;',
    createdTimestamp: ROOM_T0 - 1000,
    ...overrides,
  });
}

/** Lets the handler reach a pending classifier call. */
const tickOnce = () => new Promise((resolve) => setTimeout(resolve, 0));

test('follow-up: the address request is byte-identical to the one before the room classifier shared its builder', async () => {
  const store = fakeStore({ u7: profileWithAliases('u7', ['Λένα', 'Ελενάκι']) });
  const llm = fakeFollowUpLlm();
  const handler = makeHandler({ llm, prompts: fakeAddressPrompts(), store, now: () => ROOM_T0 });
  const guild = fakeGuild('g1', 'Neptunia');
  const history = [rawHistoryMessage({ id: 'h1', authorId: 'u1', authorName: 'Alice', ts: ROOM_T0 - 60000, content: 'earlier message' })];
  const channel = fakeChannelWithHistory('c1', guild, history);
  await openFollowUpWindow(handler, { guild, channel, ts: ROOM_T0 - 30000 });
  const p = handler(roomMessage(channel, { id: 'm-candidate', cleanContent: 'and you too' }));
  await tickOnce();
  assert.equal(llm.calls.length, 1);
  const [{ messages }] = llm.calls;
  // Pinned from the request built before the extraction (the same fixtures, the same clock).
  assert.deepEqual(messages, [
    { role: 'system', content: 'You are Neptunia. Is the candidate message addressed to you? Answer yes or no.' },
    {
      role: 'user',
      content:
        '=== Mon, January 5 ===\n#1 [11:59] Alice: earlier message\n<author>\nΕλένη -- known as: Λένα, Ελενάκι\n</author>\n' +
        '<candidate>\n#2 [11:59] Ελένη: and you too\n</candidate>',
    },
  ]);
  llm.respond('no');
  await p;
});

test('events: a failed eavesdrop roll may roll roomQuestionChance and ask the room classifier', async () => {
  const llm = fakeFollowUpLlm();
  const spontaneous = roomSpontaneous();
  // The chance is set here, so the test does not move with the shipped default.
  const config = baseConfig({ spontaneous: { roomQuestionChance: 0.5 } });
  const handler = makeHandler({ llm, spontaneous, config, prompts: fakeRoomPrompts(), rng: scripted([0.49]), now: () => ROOM_T0 });
  const channel = roomChannel();
  const p = handler(roomMessage(channel));
  await tickOnce();

  assert.equal(llm.calls.length, 1, 'the room classifier was asked');
  const [{ messages, options }] = llm.calls;
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, 'You watch the room for Neptunia. Is the candidate put to everyone? Answer yes or no.', 'room.md, {{name}} filled');
  assert.equal(messages[1].role, 'user');
  assert.match(messages[1].content, /earlier line[\s\S]*<candidate>\n[^\n]*ποιος θέλει καφέ;\n<\/candidate>$/, 'the transcript, then the candidate');
  assert.deepEqual(
    { ...options },
    {
      model: config.models.base.analyzer,
      role: 'analyzer',
      maxOutputTokens: config.mention.followUpMaxOutputTokens,
      countAgainstDailyCap: true,
      skipCalibration: true,
      timeoutMs: config.llm.helperTimeoutMs,
      purpose: 'room',
      signal: undefined,
      helper: true,
    },
    'the helper request options: the analyzer role, mention.followUpMaxOutputTokens, the daily cap, llm.helperTimeoutMs',
  );
  llm.respond('no');
  await p;

  // The roll is strict: at the chance itself the classifier is not asked.
  const llm2 = fakeFollowUpLlm();
  const handler2 = makeHandler({ llm: llm2, spontaneous: roomSpontaneous(), config, prompts: fakeRoomPrompts(), rng: scripted([0.5]), now: () => ROOM_T0 });
  await handler2(roomMessage(roomChannel()));
  assert.equal(llm2.calls.length, 0);
});

test('events: the room classifier is never asked when the eavesdrop rails fail', async () => {
  const noRoll = () => {
    throw new Error('no room roll');
  };
  const llm = fakeFollowUpLlm();
  const spontaneous = roomSpontaneous({ ready: false });
  const handler = makeHandler({ llm, spontaneous, prompts: fakeRoomPrompts(), rng: noRoll, now: () => ROOM_T0 });
  const channel = roomChannel();
  await handler(roomMessage(channel));
  assert.equal(spontaneous.readyCalls.length, 1, 'the rails were asked');
  assert.equal(spontaneous.readyCalls[0], channel);
  assert.equal(llm.calls.length, 0);

  // The pre-filter: a reply or a member mention, or no text, is never a room line.
  const ready = roomSpontaneous();
  const handler2 = makeHandler({ llm, spontaneous: ready, prompts: fakeRoomPrompts(), rng: noRoll, now: () => ROOM_T0 });
  await handler2(roomMessage(channel, { id: 'm-r1', reference: { messageId: 'other' } }));
  await handler2(roomMessage(channel, { id: 'm-r2', mentions: { users: new Map([['u2', { id: 'u2' }]]) } }));
  await handler2(roomMessage(channel, { id: 'm-r3', cleanContent: '   ' }));
  assert.equal(llm.calls.length, 0);

  // An eavesdrop that scheduled leaves nothing to the room path.
  const hit = roomSpontaneous({ scheduled: true });
  const handler3 = makeHandler({ llm, spontaneous: hit, prompts: fakeRoomPrompts(), rng: noRoll, now: () => ROOM_T0 });
  await handler3(roomMessage(channel));
  assert.equal(hit.readyCalls.length, 0);
  assert.equal(llm.calls.length, 0);
});

test('events: roomQuestionChance 0 never asks', async () => {
  const llm = fakeFollowUpLlm();
  const spontaneous = roomSpontaneous();
  const config = baseConfig({ spontaneous: { roomQuestionChance: 0 } });
  const handler = makeHandler({ llm, spontaneous, config, prompts: fakeRoomPrompts(), rng: () => 0, now: () => ROOM_T0 });
  const { logs } = await withCapturedLogs(() => handler(roomMessage(roomChannel())));
  assert.equal(llm.calls.length, 0);
  assert.equal(spontaneous.readyCalls.length, 0, 'not even the rails are read');
  assert.equal(logs.some((entry) => entry.msg?.startsWith('room:')), false, 'silent');
});

test('events: a yes schedules the room turn, a no leaves the message', async () => {
  for (const [answer, scheduled] of [['yes', true], ['Yes.', true], ['no', false], ['overheard', false]]) {
    const llm = fakeFollowUpLlm();
    const spontaneous = roomSpontaneous();
    const handler = makeHandler({ llm, spontaneous, prompts: fakeRoomPrompts(), rng: scripted([0]), now: () => ROOM_T0 });
    const channel = roomChannel();
    const { logs } = await withCapturedLogs(async () => {
      const p = handler(roomMessage(channel));
      await tickOnce();
      llm.respond(answer);
      await p;
    });
    assert.equal(spontaneous.calls.length, scheduled ? 2 : 1, answer);
    const [first] = spontaneous.calls;
    assert.equal(first.length, 2, 'the ordinary eavesdrop comes first, no options');
    if (scheduled) {
      const [roomChannelArg, roomLine, options] = spontaneous.calls[1];
      assert.equal(roomChannelArg, channel);
      assert.equal(roomLine, first[1], 'the same message is the focus');
      assert.deepEqual(options, { room: true });
    }
    const verdict = logs.find((entry) => entry.msg === 'room: verdict');
    assert.equal(verdict?.answer, scheduled ? 'yes' : 'no', answer);
    assert.equal(verdict.channel, 'c1');
    assert.equal(verdict.author, 'u7');
    assert.equal(typeof verdict.ms, 'number');
    assert.ok(!JSON.stringify(logs).includes('καφέ'), 'no message text in the logs');
  }
});

test('events: a failed or empty room classifier call schedules nothing and says why', async () => {
  const rows = [
    ['an error', (llm) => llm.fail(Object.assign(new Error('boom'), { statusCode: 503 })), { reason: 'llm-error', status: 503 }],
    ['the daily cap', (llm) => llm.fail(new DailyCapError('cap')), { reason: 'daily-cap', status: null }],
    ['an empty answer', (llm) => llm.respond('   '), { reason: 'empty', status: null }],
  ];
  for (const [label, settle, expected] of rows) {
    const llm = fakeFollowUpLlm();
    const spontaneous = roomSpontaneous();
    const handler = makeHandler({ llm, spontaneous, prompts: fakeRoomPrompts(), rng: scripted([0]), now: () => ROOM_T0 });
    const { logs } = await withCapturedLogs(async () => {
      const p = handler(roomMessage(roomChannel()));
      await tickOnce();
      settle(llm);
      await p;
    });
    assert.equal(spontaneous.calls.length, 1, `${label}: nothing scheduled`);
    const failed = logs.find((entry) => entry.msg === 'room: classifier failed');
    assert.equal(failed?.channel, 'c1', label);
    assert.equal(failed.reason, expected.reason, label);
    assert.equal(failed.status, expected.status, label);
    assert.equal(logs.some((entry) => entry.msg === 'room: verdict'), false, `${label}: no verdict`);
  }

  // No room.md: skipped with its code, nothing asked.
  const llm = fakeFollowUpLlm();
  const handler = makeHandler({ llm, spontaneous: roomSpontaneous(), prompts: fakeAddressPrompts(), rng: scripted([0]), now: () => ROOM_T0 });
  const { logs } = await withCapturedLogs(() => handler(roomMessage(roomChannel())));
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(
    logs.filter((entry) => entry.msg === 'room: skipped').map((entry) => [entry.channel, entry.reason]),
    [['c1', 'no-prompt']],
  );
});

test('events: one room call per channel at a time', async () => {
  const llm = fakeFollowUpLlm();
  const spontaneous = roomSpontaneous();
  const handler = makeHandler({ llm, spontaneous, prompts: fakeRoomPrompts(), rng: () => 0, now: () => ROOM_T0 });
  const guild = fakeGuild('g1', 'Neptunia');
  const c1 = roomChannel('c1', guild);
  const c2 = roomChannel('c2', guild);
  const { logs } = await withCapturedLogs(async () => {
    const first = handler(roomMessage(c1, { id: 'm1' }));
    await tickOnce();
    await handler(roomMessage(c1, { id: 'm2' }));
    assert.equal(llm.calls.length, 1, 'the second line of c1 is skipped while the first is classified');
    const other = handler(roomMessage(c2, { id: 'm3' }));
    await tickOnce();
    assert.equal(llm.calls.length, 2, 'another channel has its own slot');
    llm.respond('no');
    await Promise.all([first, other]);
    const third = handler(roomMessage(c1, { id: 'm4' }));
    await tickOnce();
    assert.equal(llm.calls.length, 3, 'the slot is free again once the call ended');
    llm.respond('no');
    await third;
  });
  assert.deepEqual(
    logs.filter((entry) => entry.msg === 'room: skipped').map((entry) => [entry.channel, entry.reason]),
    [['c1', 'in-flight']],
  );
});

test('events: a message inside an open follow-up window never reaches the room path', async () => {
  // The address classifier handles it: one address call, no room call.
  const llm = fakeFollowUpLlm();
  const spontaneous = roomSpontaneous();
  const handler = makeHandler({ llm, spontaneous, prompts: fakeRoomPrompts(), rng: () => 0, now: () => ROOM_T0 });
  const channel = roomChannel();
  await openFollowUpWindow(handler, { guild: channel.guild, channel, ts: ROOM_T0 - 30000 });
  const p = handler(roomMessage(channel));
  await tickOnce();
  assert.equal(llm.calls.length, 1);
  assert.match(llm.calls[0].messages[0].content, /addressed to you/, 'the address classifier, not room.md');
  llm.respond('no');
  await p;
  assert.equal(llm.calls.length, 1);
  assert.equal(spontaneous.readyCalls.length, 0);

  // An open window the address classifier passed over (features.followUp off here): still no room path.
  const config = baseConfig({ features: { followUp: false } });
  const llm2 = fakeFollowUpLlm();
  const spontaneous2 = roomSpontaneous();
  const handler2 = makeHandler({ llm: llm2, spontaneous: spontaneous2, config, prompts: fakeRoomPrompts(), rng: () => 0, now: () => ROOM_T0 });
  const channel2 = roomChannel();
  await openFollowUpWindow(handler2, { guild: channel2.guild, channel: channel2, ts: ROOM_T0 - 30000 });
  await handler2(roomMessage(channel2));
  assert.equal(spontaneous2.calls.length, 1, 'the ordinary eavesdrop still sees it');
  assert.equal(llm2.calls.length, 0);
  assert.equal(spontaneous2.readyCalls.length, 0);
});

// ---------------------------------------------------------------------------
// The pause notice: while paused (/nep pause) a direct call gets one plain
// line (labels.limits.paused), at most once per channel per
// mention.pauseNoticeMinutes; nothing else happens and nothing is marked dirty.

const PAUSE_T0 = Date.UTC(2026, 9, 5, 12, 0, 0);

function pauseConfig(overrides = {}) {
  return baseConfig(
    deepMerge(
      { features: { pauseNotice: true, dryRun: false }, mention: { pauseNoticeMinutes: 10 }, bot: { nameTriggers: ['νεπτούνια'] } },
      overrides,
    ),
  );
}

/** A paused state that counts every markDirty call. */
function pausedState(data = {}) {
  const state = { data: { paused: true, ...data }, dirty: 0 };
  state.markDirty = () => {
    state.dirty += 1;
  };
  return state;
}

/** A guild channel that records its sends and holds m0 (the persona's) and m-other (someone else's). */
function pausedChannel(id = 'c1', guild = fakeGuild(), overrides = {}) {
  const channel = sendingChannel(id, guild);
  channel.messages.cache.set('m0', { author: { id: 'self1' } });
  channel.messages.cache.set('m-other', { author: { id: 'u2' } });
  return Object.assign(channel, overrides);
}

function pausedScene(options = {}) {
  const { config = pauseConfig(), now = mutableNow(PAUSE_T0), client } = options;
  const prompts = 'prompts' in options ? options.prompts : { labels };
  const state = pausedState();
  const store = { state, getUser: () => null };
  const turns = recordingTurns();
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const llm = fakeFollowUpLlm();
  const handler = makeHandler({ config, prompts, store, turns, memory, spontaneous, llm, now, client, rng: scripted([]) });
  return { handler, state, store, turns, memory, spontaneous, llm, now };
}

function assertPausedQuiet(scene, label) {
  assert.equal(scene.turns.calls.length, 0, `${label}: no turn`);
  assert.equal(scene.turns.notePostCalls.length, 0, `${label}: no post noted`);
  assert.equal(scene.memory.observeCalls.length, 0, `${label}: no observe`);
  assert.equal(scene.spontaneous.onMessageCalls.length, 0, `${label}: no eavesdrop`);
  assert.equal(scene.llm.calls.length, 0, `${label}: no model request`);
  assert.equal(scene.state.dirty, 0, `${label}: nothing marked dirty`);
  assert.deepEqual(Object.keys(scene.state.data), ['paused'], `${label}: the state is untouched`);
}

const PAUSED_CALLS = [
  { kind: 'mention', extra: {} },
  { kind: 'reply', extra: { mentions: { users: new Map() }, reference: { messageId: 'm0' } } },
  { kind: 'name', extra: { mentions: { users: new Map() }, cleanContent: 'γεια νεπτούνια' } },
];

for (const { kind, extra } of PAUSED_CALLS) {
  test(`pause notice: a ${kind} while paused gets the notice once, as a reply, and nothing else`, async () => {
    const scene = pausedScene();
    const guild = fakeGuild();
    const channel = pausedChannel('c1', guild);
    const { logs } = await withCapturedLogs(async () => {
      await scene.handler(directPingMessage({ guild, channel, channelId: 'c1', ...extra }));
      await settle();
    });
    assert.equal(channel.sent.length, 1);
    assert.equal(channel.sent[0].content, labels.limits.paused);
    assert.equal(channel.sent[0].reply.messageReference, 'm1');
    assert.deepEqual(channel.sent[0].allowedMentions, { parse: [] });
    const lines = logs.filter((l) => l.msg === 'limits: pause notice');
    assert.deepEqual(lines.map((l) => [l.channel, l.kind]), [['c1', kind]]);
    assertPausedQuiet(scene, kind);
  });
}

test('pause notice: a line that is not a direct call stays silent', async () => {
  const cases = [
    { label: 'ordinary line', message: (guild, channel) => fakeMessage({ id: 'm1', guild, channel, channelId: 'c1', cleanContent: 'καλημέρα' }) },
    {
      label: 'reply to someone else',
      message: (guild, channel) => fakeMessage({ id: 'm1', guild, channel, channelId: 'c1', cleanContent: 'ναι', reference: { messageId: 'm-other' } }),
    },
    {
      label: 'another bot',
      message: (guild, channel) => directPingMessage({ guild, channel, channelId: 'c1', author: { id: 'b2', bot: true, globalName: 'Bot', username: 'bot' } }),
    },
    {
      label: 'its own message',
      message: (guild, channel) => directPingMessage({ guild, channel, channelId: 'c1', author: { id: 'self1', bot: true, globalName: 'Self', username: 'self' } }),
    },
    { label: 'system message', message: (guild, channel) => directPingMessage({ guild, channel, channelId: 'c1', system: true }) },
    { label: 'other guild', message: (guild, channel) => directPingMessage({ guild: fakeGuild('g2'), channel, channelId: 'c1' }) },
  ];
  for (const { label, message } of cases) {
    const scene = pausedScene();
    const guild = fakeGuild();
    const channel = pausedChannel('c1', guild);
    await scene.handler(message(guild, channel));
    await settle();
    assert.equal(channel.sent.length, 0, label);
    assertPausedQuiet(scene, label);
  }
});

test('pause notice: a call where the bot may not answer stays silent', async () => {
  const cases = [
    { label: 'cannot send', config: pauseConfig(), overrides: { permissionsFor: () => ({ has: () => false }) } },
    { label: 'dry-run mirror', config: pauseConfig({ bot: { dryRunChannelId: 'c1' } }), overrides: {} },
    { label: 'thread', config: pauseConfig(), overrides: { isThread: () => true } },
    { label: 'mentions off', config: pauseConfig({ features: { mentions: false } }), overrides: {} },
  ];
  for (const { label, config, overrides } of cases) {
    const scene = pausedScene({ config });
    const guild = fakeGuild();
    const channel = pausedChannel('c1', guild, overrides);
    await scene.handler(directPingMessage({ guild, channel, channelId: 'c1' }));
    await settle();
    assert.equal(channel.sent.length, 0, label);
    assertPausedQuiet(scene, label);
  }
});

test('pause notice: a second call inside the interval posts nothing and logs nothing; one after it posts again', async () => {
  const scene = pausedScene();
  const guild = fakeGuild();
  const channel = pausedChannel('c1', guild);
  const other = pausedChannel('c2', guild);
  const { logs } = await withCapturedLogs(async () => {
    await scene.handler(directPingMessage({ id: 'm1', guild, channel, channelId: 'c1' }));
    scene.now.set(PAUSE_T0 + 9 * 60 * 1000);
    await scene.handler(directPingMessage({ id: 'm2', guild, channel, channelId: 'c1' }));
    await scene.handler(directPingMessage({ id: 'm3', guild, channel: other, channelId: 'c2' }));
  });
  assert.equal(channel.sent.length, 1, 'inside the interval: nothing');
  assert.equal(other.sent.length, 1, 'the interval is per channel');
  assert.equal(logs.filter((l) => l.msg === 'limits: pause notice').length, 2);

  scene.now.set(PAUSE_T0 + 10 * 60 * 1000);
  await scene.handler(directPingMessage({ id: 'm4', guild, channel, channelId: 'c1' }));
  assert.equal(channel.sent.length, 2, 'after the interval: again');
  assert.equal(channel.sent[1].reply.messageReference, 'm4');
  assertPausedQuiet(scene, 'interval');
});

test('pause notice: an interval of 0 lets every call get one', async () => {
  const scene = pausedScene({ config: pauseConfig({ mention: { pauseNoticeMinutes: 0 } }) });
  const guild = fakeGuild();
  const channel = pausedChannel('c1', guild);
  await scene.handler(directPingMessage({ id: 'm1', guild, channel, channelId: 'c1' }));
  await scene.handler(directPingMessage({ id: 'm2', guild, channel, channelId: 'c1' }));
  assert.equal(channel.sent.length, 2);
});

test('pause notice: the switch off or a missing label posts nothing', async () => {
  const cases = [
    { label: 'switch off', config: pauseConfig({ features: { pauseNotice: false } }), prompts: { labels } },
    { label: 'no label', config: pauseConfig(), prompts: { labels: { ...labels, limits: { notice: labels.limits.notice } } } },
    { label: 'empty label', config: pauseConfig(), prompts: { labels: { ...labels, limits: { ...labels.limits, paused: '' } } } },
    { label: 'no prompts', config: pauseConfig(), prompts: undefined },
  ];
  for (const { label, config, prompts } of cases) {
    const scene = pausedScene({ config, prompts });
    const guild = fakeGuild();
    const channel = pausedChannel('c1', guild);
    await scene.handler(directPingMessage({ guild, channel, channelId: 'c1' }));
    await settle();
    assert.equal(channel.sent.length, 0, label);
    assertPausedQuiet(scene, label);
  }
});

test('pause notice: in a dry run it is mirrored, never posted', async () => {
  const mirrored = [];
  const client = { ...fakeClient(), channels: { fetch: async () => ({ send: async (payload) => mirrored.push(payload) }) } };
  const scene = pausedScene({ config: pauseConfig({ features: { dryRun: true }, bot: { dryRunChannelId: 'mirror1' } }), client });
  const guild = fakeGuild();
  const channel = pausedChannel('c1', guild);
  await scene.handler(directPingMessage({ guild, channel, channelId: 'c1' }));
  await settle();
  assert.equal(channel.sent.length, 0);
  assert.equal(mirrored.length, 1);
  assert.ok(mirrored[0].content.endsWith(`\n${labels.limits.paused}`));
  assertPausedQuiet(scene, 'dry run');
});

function pausedDmScene(storeOptions, clientOptions) {
  const store = fakePrivateStore(storeOptions);
  store.state = pausedState();
  const turns = recordingTurns();
  const memory = fakeMemory();
  const spontaneous = fakeSpontaneous();
  const llm = fakeFollowUpLlm();
  const config = privateConfig({ features: { pauseNotice: true, dryRun: false }, mention: { pauseNoticeMinutes: 10 } });
  const handler = makeDmHandler({ config, store, turns, memory, spontaneous, llm, client: fakeDmClient(clientOptions) });
  return { handler, store, state: store.state, turns, memory, spontaneous, llm };
}

test('pause notice: a private message from someone the gate lets through gets it like a private limit notice', async () => {
  const scene = pausedDmScene();
  const message = fakeDmMessage();
  const { logs } = await withCapturedLogs(async () => {
    await scene.handler(message);
    await settle();
  });
  assert.equal(message.channel.sent.length, 1);
  assert.equal(message.channel.sent[0].content, labels.limits.paused);
  assert.equal(message.channel.sent[0].reply.messageReference, 'dm-m1', 'quoted like the private limit notice');
  assert.deepEqual(message.channel.sent[0].allowedMentions, { parse: [] });
  assert.deepEqual(logs.filter((l) => l.msg === 'limits: pause notice').map((l) => [l.channel, l.kind]), [['dm1', 'private']]);
  assert.deepEqual([scene.store.bumps, scene.store.noticed], [[], []]);
  assertPausedQuiet(scene, 'private');
});

test('pause notice: the private daily cap alone does not withhold it', async () => {
  const scene = pausedDmScene({ privates: { u1: { replies: { day: TODAY, count: 100 } } } });
  const message = fakeDmMessage();
  await scene.handler(message);
  await settle();
  assert.equal(message.channel.sent.length, 1);
  assert.equal(message.channel.sent[0].content, labels.limits.paused);
  assert.deepEqual(scene.store.noticed, [], 'no cap notice is marked while paused');
  assertPausedQuiet(scene, 'cap');
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
    assert.equal(message.channel.sent.length, 0, label);
    assertPausedQuiet(scene, label);
  }
});

// ---------------------------------------------------------------------------
// Several calls, one attention: the real turn runner (src/behavior/turn.js) behind the handler.
// A message that holds several requests is answered part by part; every waiting call gets its
// own turn, in arrival order; a call about something still waiting is folded into it.

const LIVE_T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const LIVE_SPLIT = 'ποιος είναι ο Νίκος; κοίτα το κανάλι της Ελένης, και πες μου αν το μιμίδιο είναι αστείο.';
const LIVE_PARTS = ['ποιος είναι ο Νίκος', 'κοίτα το κανάλι της Ελένης', 'το μιμίδιο είναι αστείο;'];
const LIVE_NAMES = { u1: 'Alice', u2: 'Léa' };

/**
 * Like withCapturedLogs, but the entries are visible to `fn` while it runs (`fn(logs)`), so a
 * scene can wait for a log line. Only the logger's own lines are captured.
 */
async function withLiveLogs(fn) {
  const original = process.stdout.write;
  const logs = [];
  process.stdout.write = function write(chunk, ...rest) {
    if (typeof chunk === 'string' && chunk.startsWith('{"level"')) {
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue;
        try {
          logs.push(JSON.parse(line));
        } catch {
          // a truncated line -- ignore
        }
      }
      const callback = rest.find((arg) => typeof arg === 'function');
      if (callback) callback();
      return true;
    }
    return original.call(process.stdout, chunk, ...rest);
  };
  try {
    await fn(logs);
  } finally {
    process.stdout.write = original;
  }
  return { logs };
}

/** Resolves after `check()` holds, or after a bounded number of event-loop turns (no wall clock). */
async function tickUntil(check, rounds = 500) {
  for (let i = 0; i < rounds && !check(); i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * A server channel (or, `dm`, a private chat with u1) whose history is every message sent so far,
 * a real turn runner, and the handler, wired as src/index.js wires them. `talk(index)` answers the
 * talk requests (it may return a promise: a gate holding the turn); `split` and `merge` the
 * splitter and the merge classifier (a string, an Error, or a function of the call's index).
 * `prompts.split` / `prompts.merge` exist only when their answer is given.
 */
function liveScene({ dm = false, talk = () => '<msg>ok</msg>', split, merge, labels: ownLabels = labels, config: overrides = {} } = {}) {
  const config = baseConfig(
    deepMerge(
      {
        features: { typingSimulation: false, memory: false, privateMessages: true, imageGeneration: false, mediaDescriptions: false, channelPull: false, recent: false },
        split: { minChars: 20, minPartChars: 0, maxTasks: 4, contextMessages: 2, maxOutputTokens: 50 },
        mention: { ignoreChance: 0, repeatPenalty: 0, spamThreshold: 50, maxPending: 6, pendingMinutes: 10 },
      },
      overrides,
    ),
  );
  const prompts = {
    'system-prompt': 'SYSTEM',
    'character-card': 'CARD',
    rules: 'RULES',
    format: 'FORMAT',
    reply: 'Reply to {{author}}.',
    labels: ownLabels,
    ...(split !== undefined ? { split: 'Split for {{name}}, at most {{maxTasks}}.' } : {}),
    ...(merge !== undefined ? { merge: 'Merge for {{name}}.' } : {}),
  };
  const hot = { config, prompts };
  const calls = { talk: [], split: [], merge: [] };
  const answer = async (spec, index) => {
    const value = typeof spec === 'function' ? await spec(index) : spec;
    if (value instanceof Error) throw value;
    return { text: value, usage: {}, estimated: 10 };
  };
  const llm = {
    complete: async (messages, options) => {
      const kind = options?.purpose === 'split' ? 'split' : options?.purpose === 'merge' ? 'merge' : 'talk';
      calls[kind].push({ messages, options });
      const spec = kind === 'split' ? split : kind === 'merge' ? merge : talk;
      return answer(spec, calls[kind].length - 1);
    },
  };
  let t = LIVE_T0;
  const now = () => t;
  const history = [];
  const sent = [];
  const client = fakeDmClient();
  const store = fakePrivateStore();
  store.state.markDirty = () => {};
  const guild = dm ? null : { id: 'g1', members: { me: { displayName: 'Ζωή' } }, channels: { cache: new Map() } };
  const messages = {
    cache: new Map(),
    fetch: async (arg) => (arg && typeof arg === 'object' ? new Map(history.map((m) => [m.id, m])) : (history.find((m) => m.id === arg) ?? null)),
  };
  const send = async (payload) => {
    sent.push(payload);
    return { id: `sent-${sent.length}` };
  };
  const channel = dm
    ? fakeDmChannel('dm1', 'u1', { messages, sendTyping: async () => {}, send })
    : fakeChannel('c1', guild, { name: 'general', messages, sendTyping: async () => {}, send });
  const tagHistory = countingTagHistory();
  const turns = createTurnRunner({ discord: DISCORD, createPort: createDiscordAdapter, hot, store, llm, calibrator: { ratio: 1, apply: (n) => n, observe: () => {} }, client, now, schedule: () => () => {} });
  const handler = asDiscordEvents(createMessageHandler({
    hot,
    store,
    client,
    discord: DISCORD,
    turns,
    spontaneous: fakeSpontaneous(),
    memory: fakeMemory(),
    tagHistory,
    getGuildId: () => 'g1',
    llm,
    rng: () => 0.5,
    now,
    sleep: async () => {},
  }), hot, client);
  turns.setOnIdle(() => handler.drainPending());
  /** A call of `authorId` (a mention on the server, any DM in private), one second after the last. */
  const call = async (id, authorId, content) => {
    t += 1000;
    const author = { id: authorId, bot: false, globalName: LIVE_NAMES[authorId], username: LIVE_NAMES[authorId] };
    const message = fakeMessage({
      id,
      guild,
      channel,
      channelId: channel.id,
      author,
      member: dm ? null : { displayName: LIVE_NAMES[authorId] },
      cleanContent: content,
      createdTimestamp: t,
      mentions: { users: new Map(dm ? [] : [['self1', { id: 'self1' }]]) },
    });
    history.push(message);
    await handler(message);
  };
  return { calls, call, sent, store, turns, handler, tagHistory };
}

/** A talk answer that holds the first talk request until `open()`. */
function heldFirst() {
  let open;
  const held = new Promise((resolve) => {
    open = resolve;
  });
  const talk = (index) => (index === 0 ? held.then(() => '<msg>ok</msg>') : '<msg>ok</msg>');
  return { talk, open: () => open() };
}

/** The `<task>` block of a talk request. */
function liveTask(call) {
  return /<task>\n([\s\S]*?)\n<\/task>/.exec(userText(call.messages[1].content))?.[1] ?? '';
}

/** Who each talk request answered: the author its task names. */
function answeredAuthors(calls) {
  return calls.talk.map((call) => /^Reply to ([^.]+)\./.exec(liveTask(call))?.[1] ?? null);
}

test('events: a message with several requests is answered part by part; a call arriving mid-chain waits and is answered after the last part', async () => {
  // The call that arrives meanwhile: the same author's (it has the parts to be folded into; no
  // merge prompt here, so it is new) or another member's.
  for (const [authorId, name] of [['u1', 'Alice'], ['u2', 'Léa']]) {
    const { talk, open } = heldFirst();
    const scene = liveScene({ talk, split: LIVE_PARTS.map((part) => `- ${part}`).join('\n') });
    const { logs } = await withLiveLogs(async (logs) => {
      await scene.call('m1', 'u1', LIVE_SPLIT);
      await tickUntil(() => scene.calls.talk.length === 1);
      await scene.call('m2', authorId, 'και κάτι άλλο');
      await tickUntil(() => logs.some((line) => line.msg === 'mention: deferred'));
      open();
      await tickUntil(() => scene.calls.talk.length === 4);
    });

    assert.equal(scene.calls.split.length, 1, `${name}: the splitter is asked for the long call only`);
    assert.deepEqual(answeredAuthors(scene.calls), ['Alice', 'Alice', 'Alice', name], `${name}: after the last part`);
    assert.deepEqual(
      scene.calls.talk.slice(0, 3).map((call, i) => liveTask(call).includes(fill(labels.task.part, { index: i + 1, total: 3, part: LIVE_PARTS[i], others: '' }).split('\n')[0])),
      [true, true, true],
    );
    assert.deepEqual(logs.filter((line) => line.msg === 'turn: part').map((line) => line.outcome), ['spoke', 'spoke', 'spoke']);
    // The ignore roll: once for the split message, once for the queued call.
    assert.deepEqual(logs.filter((line) => line.msg === 'mention: decided').map((line) => line.author), ['u1', authorId]);
    assert.equal(scene.tagHistory.hits, 2);
    assert.equal(logs.filter((line) => line.msg === 'mention: already answered').length, 0, `${name}: not dropped as seen by a later part`);
  }
});

test('events: five calls in a row from one author while she is busy get five turns, in arrival order', async () => {
  const { talk, open } = heldFirst();
  const scene = liveScene({ talk });
  const texts = ['ένα', 'δύο', 'τρία', 'τέσσερα', 'πέντε'];
  const { logs } = await withLiveLogs(async (logs) => {
    await scene.call('m1', 'u1', texts[0]);
    await tickUntil(() => scene.calls.talk.length === 1);
    for (const [i, text] of texts.slice(1).entries()) await scene.call(`m${i + 2}`, 'u1', text);
    await tickUntil(() => logs.filter((line) => line.msg === 'mention: deferred').length === 4);
    open();
    await tickUntil(() => scene.calls.talk.length === 5);
  });

  assert.equal(scene.calls.talk.length, 5);
  assert.equal(logs.filter((line) => line.msg === 'mention: already answered').length, 0, 'none dropped as seen');
  assert.deepEqual(logs.filter((line) => line.msg === 'mention: deferred').map((line) => line.queued), [1, 2, 3, 4]);
  // The turn of m2 names the author's calls still waiting, so it leaves them to their own turns.
  assert.ok(liveTask(scene.calls.talk[1]).endsWith(fill(labels.task.queued, { others: '1. τρία; 2. τέσσερα; 3. πέντε' })));
  assert.ok(liveTask(scene.calls.talk[4]).endsWith('Reply to Alice.'), 'the last one has nothing left to name');
  assert.deepEqual(logs.filter((line) => line.msg === 'merge: failed').map((line) => line.reason), ['no-prompt', 'no-prompt', 'no-prompt'], 'no merge prompt: each call is new');
});

test('events: with an older labels file, a call the speaking turn had in view is dropped as today', async () => {
  const { talk, open } = heldFirst();
  const { queued: _queued, ...noQueued } = labels.task;
  const scene = liveScene({ talk, labels: { ...labels, task: noQueued } });
  const { logs } = await withLiveLogs(async (logs) => {
    await scene.call('m1', 'u1', 'ένα');
    await tickUntil(() => scene.calls.talk.length === 1);
    for (const [i, text] of ['δύο', 'τρία', 'τέσσερα'].entries()) await scene.call(`m${i + 2}`, 'u1', text);
    await tickUntil(() => logs.filter((line) => line.msg === 'mention: deferred').length === 3);
    open();
    await tickUntil(() => logs.filter((line) => line.msg === 'mention: already answered').length === 2);
  });
  assert.equal(scene.calls.talk.length, 2, 'm1, then m2 whose turn saw m3 and m4');
});

test('events: calls of two authors waiting in one channel each get their own turn, in arrival order, each request naming the other\'s', async () => {
  const { talk, open } = heldFirst();
  const scene = liveScene({ talk });
  const { logs } = await withLiveLogs(async (logs) => {
    await scene.call('m1', 'u1', 'ένα');
    await tickUntil(() => scene.calls.talk.length === 1);
    await scene.call('m2', 'u2', 'δύο');
    await scene.call('m3', 'u1', 'τρία');
    await scene.call('m4', 'u2', 'τέσσερα');
    await tickUntil(() => logs.filter((line) => line.msg === 'mention: deferred').length === 3);
    open();
    await tickUntil(() => scene.calls.talk.length === 4);
  });
  assert.deepEqual(answeredAuthors(scene.calls), ['Alice', 'Léa', 'Alice', 'Léa']);
  assert.equal(logs.filter((line) => line.msg === 'mention: already answered').length, 0, 'none dropped as seen');
  // m2 (Léa): her own m4 under task.queued, Alice's m3 under task.queuedOthers.
  assert.ok(
    liveTask(scene.calls.talk[1]).endsWith(
      [fill(labels.task.queued, { others: '1. τέσσερα' }), fill(labels.task.queuedOthers, { others: '1. Alice: τρία' })].join('\n\n'),
    ),
  );
  // m3 (Alice): Léa's m4 under task.queuedOthers.
  assert.ok(liveTask(scene.calls.talk[2]).endsWith(fill(labels.task.queuedOthers, { others: '1. Léa: τέσσερα' })));
  assert.ok(liveTask(scene.calls.talk[3]).endsWith('Reply to Léa.'), 'nothing left to name');
});

test('events: without labels.task.queuedOthers, another author\'s queued call the speaking turn had in view is dropped as seen', async () => {
  const { talk, open } = heldFirst();
  const { queuedOthers: _others, ...older } = labels.task;
  const scene = liveScene({ talk, labels: { ...labels, task: older } });
  const { logs } = await withLiveLogs(async (logs) => {
    await scene.call('m1', 'u1', 'ένα');
    await tickUntil(() => scene.calls.talk.length === 1);
    await scene.call('m2', 'u2', 'δύο');
    await scene.call('m3', 'u1', 'τρία');
    await scene.call('m4', 'u2', 'τέσσερα');
    await tickUntil(() => logs.filter((line) => line.msg === 'mention: deferred').length === 3);
    open();
    await tickUntil(() => logs.some((line) => line.msg === 'mention: already answered') && scene.calls.talk.length === 3);
  });
  assert.deepEqual(answeredAuthors(scene.calls), ['Alice', 'Léa', 'Léa'], 'm3 was in view of Léa\'s turn and not named; her own m4 was named');
  assert.equal(liveTask(scene.calls.talk[1]).includes('τρία'), false);
});

test('events: a call the merge classifier folds into a waiting call gets no turn; that call\'s turn names it', async () => {
  const { talk, open } = heldFirst();
  const scene = liveScene({ talk, merge: '1' });
  const { logs } = await withLiveLogs(async (logs) => {
    await scene.call('m1', 'u1', 'ένα');
    await tickUntil(() => scene.calls.talk.length === 1);
    await scene.call('m2', 'u1', 'ποιος είναι ο Νίκος;');
    await scene.call('m3', 'u1', 'λοιπόν, ο Νίκος;');
    await tickUntil(() => scene.calls.merge.length === 1);
    await tickUntil(() => logs.some((line) => line.msg === 'merge: verdict'));
    open();
    await tickUntil(() => scene.calls.talk.length === 2);
    await tickUntil(() => false, 50);
  });

  assert.equal(scene.calls.talk.length, 2, 'm3 has no turn of its own');
  assert.ok(liveTask(scene.calls.talk[1]).endsWith(fill(labels.task.added, { added: 'λοιπόν, ο Νίκος;' })));
  const [merge] = scene.calls.merge;
  assert.equal(merge.messages[0].content, 'Merge for Ζωή.');
  assert.equal(merge.messages[1].content, '<waiting>\n1. ποιος είναι ο Νίκος;\n</waiting>\n<candidate>\nAlice: λοιπόν, ο Νίκος;\n</candidate>');
  assert.deepEqual([merge.options.role, merge.options.purpose, merge.options.helper], ['analyzer', 'merge', true]);
  const verdict = logs.find((line) => line.msg === 'merge: verdict');
  assert.deepEqual([verdict.channel, verdict.waiting, verdict.answer, typeof verdict.ms], ['c1', 1, 'item', 'number']);
  assert.equal(scene.tagHistory.hits, 3, 'the folded call still counts toward the repeat and spam counters');
  assert.deepEqual(logs.filter((line) => line.msg === 'mention: decided').map((line) => line.author), ['u1', 'u1'], 'one roll per answered call');
});

test('events: a merge classifier that says new, fails or is missing leaves the call its own turn', async () => {
  for (const merge of ['new', Object.assign(new Error('down'), { statusCode: 503 }), 'maybe', undefined]) {
    const { talk, open } = heldFirst();
    const scene = liveScene({ talk, merge });
    const { logs } = await withLiveLogs(async (logs) => {
      await scene.call('m1', 'u1', 'ένα');
      await tickUntil(() => scene.calls.talk.length === 1);
      await scene.call('m2', 'u1', 'δύο');
      await scene.call('m3', 'u1', 'τρία');
      await tickUntil(() => logs.filter((line) => line.msg === 'mention: deferred').length === 2);
      open();
      await tickUntil(() => scene.calls.talk.length === 3);
    });
    assert.equal(scene.calls.talk.length, 3, String(merge));
    if (merge === 'new') assert.equal(logs.find((line) => line.msg === 'merge: verdict').answer, 'new');
    else assert.ok(logs.some((line) => line.msg === 'merge: failed'), String(merge));
  }
});

test('events: a call folded into a part of a running chain reaches that part\'s request', async () => {
  const { talk, open } = heldFirst();
  const scene = liveScene({ talk, split: LIVE_PARTS.map((part) => `- ${part}`).join('\n'), merge: '1' });
  const { logs } = await withLiveLogs(async (logs) => {
    await scene.call('m1', 'u1', LIVE_SPLIT);
    await tickUntil(() => scene.calls.talk.length === 1);
    await scene.call('m2', 'u1', 'και το κανάλι;');
    await tickUntil(() => logs.some((line) => line.msg === 'merge: verdict'));
    open();
    await tickUntil(() => scene.calls.talk.length === 3);
    await tickUntil(() => false, 50);
  });
  assert.equal(scene.calls.talk.length, 3, 'no turn of its own');
  assert.equal(scene.calls.merge[0].messages[1].content.split('\n</waiting>')[0], `<waiting>\n1. ${LIVE_PARTS[1]}\n2. ${LIVE_PARTS[2]}`);
  assert.ok(liveTask(scene.calls.talk[1]).endsWith(fill(labels.task.added, { added: 'και το κανάλι;' })));
  assert.equal(liveTask(scene.calls.talk[2]).includes('και το κανάλι;'), false);
});

test('events: mention.maxPending evicts the oldest waiting call of an author too', async () => {
  const { talk, open } = heldFirst();
  const scene = liveScene({ talk, config: { mention: { maxPending: 2 } } });
  const { logs } = await withLiveLogs(async (logs) => {
    await scene.call('m1', 'u1', 'ένα');
    await tickUntil(() => scene.calls.talk.length === 1);
    for (const [i, text] of ['δύο', 'τρία', 'τέσσερα'].entries()) await scene.call(`m${i + 2}`, 'u1', text);
    await tickUntil(() => logs.some((line) => line.msg === 'mention: dropped' && line.reason === 'full'));
    open();
    await tickUntil(() => scene.calls.talk.length === 3);
  });
  assert.equal(scene.calls.talk.length, 3);
  assert.ok(liveTask(scene.calls.talk[1]).startsWith('Reply to Alice.'));
  assert.equal(liveTask(scene.calls.talk[1]).includes('δύο'), false, 'm2, the oldest, was evicted');
});

test('private: DMs queue and fold the same way; one incoming message counts once toward the daily cap', async () => {
  const { talk, open } = heldFirst();
  // The first merge call: `new`; the second folds into item 3 (parts 2 and 3, then the queued DM).
  const merge = (index) => (index === 0 ? 'new' : '3');
  const scene = liveScene({ dm: true, talk, split: LIVE_PARTS.map((part) => `- ${part}`).join('\n'), merge });
  const { logs } = await withLiveLogs(async (logs) => {
    await scene.call('dm-1', 'u1', LIVE_SPLIT);
    await tickUntil(() => scene.calls.talk.length === 1);
    await scene.call('dm-2', 'u1', 'και κάτι άλλο');
    await tickUntil(() => logs.some((line) => line.msg === 'mention: deferred'));
    await scene.call('dm-3', 'u1', 'λοιπόν;');
    await tickUntil(() => scene.calls.merge.length === 2 && logs.filter((line) => line.msg === 'merge: verdict').length === 2);
    open();
    await tickUntil(() => scene.calls.talk.length === 4);
    await tickUntil(() => scene.store.bumps.length === 2);
  });
  assert.equal(scene.calls.talk.length, 4, 'three parts, then the queued DM; the folded one has no turn');
  assert.ok(liveTask(scene.calls.talk[3]).endsWith(fill(labels.task.added, { added: 'λοιπόν;' })));
  assert.deepEqual(scene.store.bumps.map(([, userId]) => userId), ['u1', 'u1'], 'the split DM once, the queued DM once');
});

// ---------------------------------------------------------------------------
// A follow-up candidate that arrives while a turn is already running is still
// classified (mention.classifyWhileBusy); a "yes" waits in the pending queue.

/**
 * A follow-up window opened in c1 at FOLLOW_UP_T0, then a turn already running in `busyIn` before
 * any candidate arrives. `send(id, content)` hands one plain line by u1 to the handler, a second
 * after the previous one, and returns the handler's promise.
 */
async function busyFollowUpScene({ busyIn = 'c9', config = baseConfig() } = {}) {
  const clock = mutableNow(FOLLOW_UP_T0);
  const llm = fakeFollowUpLlm();
  const spontaneous = fakeSpontaneous();
  const turns = attentionTurns(busyIn);
  const handler = makeHandler({ config, turns, llm, spontaneous, now: clock, sleep: async () => {}, rng: () => 0.5, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: FOLLOW_UP_T0 });
  turns.busy = true;
  let sent = 0;
  const send = (id, content = 'and then?') => {
    sent += 1;
    const ts = FOLLOW_UP_T0 + sent * 1000;
    clock.set(ts);
    channel.messages.cache.set(id, {});
    return handler(plainFollowUpMessage({ id, guild, channel, content, authorId: 'u1', authorName: 'Élodie', ts }));
  };
  return { clock, llm, spontaneous, turns, handler, guild, channel, send };
}

/** Sends `id` into a busy scene and answers its classifier call with `answer`: resolves the logs. */
async function busyCandidate(scene, id, answer) {
  const { logs } = await withCapturedLogs(async () => {
    const p = scene.send(id);
    await tick();
    scene.llm.respond(answer);
    await p;
    await tick();
  });
  return logs;
}

const deferredOf = (logs) =>
  logs.filter((l) => l.msg === 'follow-up: deferred').map(({ channel, message, runningIn, sameChannel }) => [channel, message, runningIn, sameChannel]);

test('follow-up: a candidate arriving during a turn in another channel is classified; a "yes" is deferred, then answered when the turn ends', async () => {
  const scene = await busyFollowUpScene();
  const logs = await busyCandidate(scene, 'm1', 'yes');
  assert.equal(scene.llm.calls.length, 1, 'the classifier is asked while the turn runs');
  assert.equal(scene.turns.calls.length, 0, 'no turn while the attention is taken');
  assert.equal(scene.spontaneous.onMessageCalls.length, 0, 'handled by the follow-up path');
  assert.deepEqual(deferredOf(logs), [['c1', 'm1', 'c9', false]]);

  const drain = await endTurnAndDrain(scene);
  assert.deepEqual(followUpDropped(drain), []);
  assert.deepEqual(
    drain.filter((l) => l.msg === 'mention: decided').map(({ kind, reason, deferred }) => [kind, reason, deferred]),
    [['followUp', 'respond', true]],
    'rolled once, when picked up',
  );
  assert.deepEqual(startedTurns(scene.turns), [['m1', 'followUp']]);
});

test('follow-up: a candidate arriving during a turn in its own channel is classified; a "yes" is deferred under pendingSameChannel and answered after it', async () => {
  const scene = await busyFollowUpScene({ busyIn: 'c1' });
  const logs = await busyCandidate(scene, 'm1', 'yes');
  assert.equal(scene.llm.calls.length, 1);
  assert.deepEqual(deferredOf(logs), [['c1', 'm1', 'c1', true]]);

  const drain = await endTurnAndDrain(scene);
  assert.deepEqual(followUpDropped(drain), []);
  assert.deepEqual(startedTurns(scene.turns), [['m1', 'followUp']]);
});

test('follow-up: with mention.pendingSameChannel off, a candidate in its own busy channel is not classified (its "yes" could not wait)', async () => {
  const scene = await busyFollowUpScene({ busyIn: 'c1', config: baseConfig({ mention: { pendingSameChannel: false } }) });
  await scene.send('m1');
  await tick();
  assert.equal(scene.llm.calls.length, 0);
  assert.equal(scene.spontaneous.onMessageCalls.length, 1, 'falls back to the usual handling');
});

test('follow-up: a "no" on a candidate classified during a busy turn defers nothing and starts nothing', async () => {
  const scene = await busyFollowUpScene();
  const logs = await busyCandidate(scene, 'm1', 'no');
  assert.deepEqual(deferredOf(logs), []);
  assert.deepEqual(followUpDropped(logs), []);
  assert.deepEqual(
    logs.filter((l) => l.msg === 'follow-up: verdict').map((l) => [l.author, l.answer]),
    [['u1', 'no']],
  );
  assert.equal(scene.spontaneous.onMessageCalls.length, 0);
  await endTurnAndDrain(scene);
  assert.equal(scene.turns.calls.length, 0);
});

test('follow-up: with mention.pendingOverheard off, an "overheard" on a candidate classified during a busy turn is dropped as busy, not deferred', async () => {
  const scene = await busyFollowUpScene({ config: baseConfig({ mention: { pendingOverheard: false } }) });
  const logs = await busyCandidate(scene, 'm1', 'overheard');
  assert.equal(scene.llm.calls.length, 1);
  assert.deepEqual(deferredOf(logs), []);
  assert.deepEqual(followUpDropped(logs), [['m1', 'busy']]);
  await endTurnAndDrain(scene);
  assert.equal(scene.turns.calls.length, 0);
});

test('follow-up: with mention.classifyWhileBusy off (read hot), a candidate during a busy turn skips the classifier as before', async () => {
  const config = baseConfig();
  const scene = await busyFollowUpScene({ config });
  config.mention.classifyWhileBusy = false;
  await scene.send('m1');
  await tick();
  assert.equal(scene.llm.calls.length, 0, 'no paid call');
  assert.equal(scene.spontaneous.onMessageCalls.length, 1, 'falls back to the usual handling');

  // Switched back on: the next candidate is classified again.
  config.mention.classifyWhileBusy = true;
  const p = scene.send('m2');
  await tick();
  assert.equal(scene.llm.calls.length, 1);
  scene.llm.respond('no');
  await p;
});

test('follow-up: a missing mention.classifyWhileBusy counts as on', async () => {
  const config = baseConfig();
  delete config.mention.classifyWhileBusy;
  const scene = await busyFollowUpScene({ config });
  await busyCandidate(scene, 'm1', 'yes');
  assert.equal(scene.llm.calls.length, 1);
  await endTurnAndDrain(scene);
  assert.deepEqual(startedTurns(scene.turns), [['m1', 'followUp']]);
});

test('follow-up: a burst of three candidates during one busy turn costs one classifier call at a time; the newest held one wins', async () => {
  const scene = await busyFollowUpScene();
  const { logs } = await withCapturedLogs(async () => {
    const p1 = scene.send('m1', 'first');
    await tick();
    await scene.send('m2', 'second');
    await scene.send('m3', 'third');
    assert.equal(scene.llm.calls.length, 1, 'the two later lines are held, not classified');

    scene.llm.respond('yes');
    await p1;
    await tick();
    assert.equal(scene.llm.calls.length, 2, 'the newest held line is classified next');
    assert.match(scene.llm.calls[1].messages[1].content, /<candidate>[\s\S]*third[\s\S]*<\/candidate>/);

    scene.llm.respond('yes');
    await tick();
    await tick();
  });
  assert.equal(scene.llm.calls.length, 2, 'the replaced line is never classified');
  assert.deepEqual(
    logs.filter((l) => l.msg === 'follow-up: held while a classifier call is in flight').map((l) => [l.message, l.replaced]),
    [
      ['m2', false],
      ['m3', true],
    ],
  );
  assert.deepEqual(
    deferredOf(logs).map((row) => row[1]),
    ['m1', 'm3'],
  );
  assert.deepEqual(followUpDropped(logs), [['m1', 'newer']]);
  assert.equal(scene.turns.calls.length, 0);

  await endTurnAndDrain(scene);
  assert.deepEqual(startedTurns(scene.turns), [['m3', 'followUp']]);
});

test('follow-up: a line the turn had in its history is dropped as answered', async () => {
  const scene = await busyFollowUpScene({ busyIn: 'c1' });
  await busyCandidate(scene, 'm1', 'yes');
  // The running turn in c1 posts after the candidate, with the candidate in its history.
  await openFollowUpWindow(scene.handler, { guild: scene.guild, channel: scene.channel, ts: FOLLOW_UP_T0 + 5000 });
  scene.turns.spokeAfterSeeing = (channelId, messageId) => channelId === 'c1' && messageId === 'm1';
  const drain = await endTurnAndDrain(scene);
  assert.equal(scene.turns.calls.length, 0, 'not answered a second time');
  assert.deepEqual(followUpDropped(drain), [['m1', 'answered']]);
});

test('follow-up: a "yes" classified during the turn is dropped as closed at pickup when a "no" streak closed the window meanwhile', async () => {
  const scene = await busyFollowUpScene({ config: baseConfig({ mention: { followUpNoStreak: 2 } }) });
  await busyCandidate(scene, 'm1', 'yes');
  await busyCandidate(scene, 'm2', 'no');
  await busyCandidate(scene, 'm3', 'no');
  const drain = await endTurnAndDrain(scene);
  assert.equal(scene.turns.calls.length, 0);
  assert.deepEqual(followUpDropped(drain), [['m1', 'closed']]);
});

// ---------------------------------------------------------------------------
// onMessageUpdate: Discord attaches some embeds (a Tenor link's `gifv` one)
// after messageCreate, in a messageUpdate. What the message as it was did not
// carry is counted into the GIF library and prefilled.

const TENOR_LINK = 'https://tenor.com/view/dancing-cat-123';
const TENOR_GIFV = {
  type: 'gifv',
  url: TENOR_LINK,
  provider: { name: 'Tenor' },
  thumbnail: { url: 'https://media.tenor.com/abc/cat.png' },
  video: { url: 'https://media.tenor.com/abc/cat.mp4' },
};

/** A real store over a temporary data dir (never the deployment's data/). */
function tmpStore() {
  return createStore({ dataDir: tempDir('nep-events-update-') });
}

/** The message as messageCreate saw it (a bare link) and as messageUpdate carries it (with the embed). */
function tenorPost(overrides = {}) {
  const guild = overrides.guild ?? fakeGuild();
  const channel = overrides.channel ?? fakeChannel('c1', guild);
  const base = { id: 'm1', guild, channel, channelId: channel.id, cleanContent: TENOR_LINK, content: TENOR_LINK, embeds: [], ...overrides };
  return { created: fakeMessage(base), updated: fakeMessage({ ...base, embeds: [TENOR_GIFV] }) };
}

function updateScene({ config, describer } = {}) {
  const store = tmpStore();
  const memory = fakeMemory();
  const turns = fakeTurns();
  const spontaneous = fakeSpontaneous();
  const handler = makeHandler({ config, store, memory, turns, spontaneous, describer });
  return { store, memory, turns, spontaneous, handler };
}

function gifEntries(store) {
  return Object.values(store.getGifs('g1').entries);
}

test('onMessageUpdate: a late gifv embed is counted into the library and prefilled', async () => {
  const describer = fakeDescriber();
  const scene = updateScene({ config: baseConfig({ features: { mediaDescriptions: true } }), describer });
  const { created, updated } = tenorPost();
  assert.deepEqual(normalizeMessage(created, 'self1').links, [], 'the create event carried a bare link');

  const { logs } = await withCapturedLogs(() => scene.handler.onMessageUpdate(created, updated));

  const entries = gifEntries(scene.store);
  assert.equal(entries.length, 1, 'the library gained the Tenor GIF');
  assert.equal(entries[0].url, TENOR_LINK);
  assert.equal(entries[0].count, 1);
  assert.equal(entries[0].itemId, 'm1#e0');
  const folded = logs.filter((entry) => entry.msg === 'events: embeds folded');
  assert.equal(folded.length, 1);
  assert.equal(folded[0].embeds, 1);
  assert.equal(folded[0].messageId, 'm1');
  assert.equal(folded[0].channelId, 'c1');
  assert.equal(describer.calls.length, 1, 'the late GIF is prefilled like one on arrival');
  assert.deepEqual(describer.calls[0].items.map((item) => item.itemId), ['m1#e0']);
  // Never treated as a new message.
  assert.equal(scene.memory.observeCalls.length, 0);
  assert.equal(scene.spontaneous.onMessageCalls.length, 0);
  assert.equal(scene.turns.notePostCalls.length, 0);

  // A second update with the same embed (an edit) counts nothing again.
  await withCapturedLogs(() => scene.handler.onMessageUpdate(updated, updated));
  assert.equal(gifEntries(scene.store)[0].count, 1);
  assert.equal(describer.calls.length, 1);
});

test('onMessageUpdate: ignores the persona\'s own messages, other guilds and updates without embeds', async () => {
  const self = { id: 'self1', bot: true, globalName: 'Bot', username: 'bot' };
  const other = fakeGuild('g2');
  const cases = [
    tenorPost({ author: self }),
    tenorPost({ author: { id: 'b2', bot: true, globalName: 'Other', username: 'other' } }),
    tenorPost({ guild: other, channel: fakeChannel('c1', other) }),
  ];
  for (const { created, updated } of cases) {
    const scene = updateScene();
    const { logs } = await withCapturedLogs(() => scene.handler.onMessageUpdate(created, updated));
    assert.equal(gifEntries(scene.store).length, 0);
    assert.equal(logs.some((entry) => entry.msg.startsWith('events: embeds')), false);
  }

  const scene = updateScene();
  const { created } = tenorPost();
  const edited = fakeMessage({ ...created, cleanContent: 'edited text', content: 'edited text', embeds: [] });
  await scene.handler.onMessageUpdate(created, edited);
  assert.equal(gifEntries(scene.store).length, 0, 'an edit without embeds counts nothing');
});

test('onMessageUpdate: without the message as it was, a late embed is an accepted miss', async () => {
  const scene = updateScene();
  const { updated } = tenorPost();
  const { logs } = await withCapturedLogs(() => scene.handler.onMessageUpdate(null, updated));
  assert.equal(gifEntries(scene.store).length, 0, 'an accepted miss: nothing recorded');
  const late = logs.filter((entry) => entry.msg === 'events: embeds late');
  assert.equal(late.length, 1);
  assert.equal(late[0].embeds, 1);
});

test('onMessageUpdate: off with features.embedUpdates false', async () => {
  const scene = updateScene({ config: baseConfig({ features: { embedUpdates: false } }) });
  const { created, updated } = tenorPost();
  const { logs } = await withCapturedLogs(() => scene.handler.onMessageUpdate(created, updated));
  assert.equal(gifEntries(scene.store).length, 0);
  assert.equal(logs.some((entry) => entry.msg.startsWith('events: embeds')), false);
});

// ---------------------------------------------------------------------------
// mention.pendingOverheard: an "overheard" verdict that finds the attention
// taken waits in the pending queue like a "yes", keeping its kind; one entry
// per channel, a waiting followUp outranking a later overheard line.

const PENDING_OVERHEARD = { mention: { pendingOverheard: true } };

test('follow-up: an overheard verdict during a running turn is deferred and drained as an overheard turn', async () => {
  const tagHistory = countingTagHistory();
  const scene = await deferredFollowUps({ answers: ['overheard'], config: baseConfig(PENDING_OVERHEARD), tagHistory });
  assert.equal(scene.turns.calls.length, 0, 'no turn while the attention is taken');
  assert.deepEqual(followUpDropped(scene.logs), [], 'not dropped');
  const deferred = scene.logs.filter((l) => l.msg === 'follow-up: deferred');
  assert.deepEqual(
    deferred.map(({ channel, message, runningIn, sameChannel, kind }) => [channel, message, runningIn, sameChannel, kind]),
    [['c1', 'm1', 'c9', false, 'overheard']],
  );

  const logs = await endTurnAndDrain(scene);
  assert.deepEqual(logs.filter((l) => l.msg === 'follow-up: picked up').map((l) => [l.channel, l.kind, l.message]), [['c1', 'overheard', 'm1']]);
  assert.equal(logs.some((l) => l.msg === 'mention: decided'), false, 'never rolled for the ignore chance');
  assert.deepEqual(startedTurns(scene.turns), [['m1', 'overheard']]);
  assert.equal(scene.turns.calls[0].mode, 'reply');
  assert.equal(scene.turns.calls[0].channel, scene.channel);
  assert.equal(tagHistory.hits, 0, 'talk about the persona is never counted for spam');
});

test('follow-up: an overheard turn whose runTurn answers busy is deferred, then drained with its kind', async () => {
  const clock = mutableNow(FOLLOW_UP_T0);
  const llm = fakeFollowUpLlm();
  const results = [{ outcome: 'busy' }, { outcome: 'spoke' }];
  const calls = [];
  const turns = fakeTurns({
    runTurn: async (args) => {
      calls.push(args);
      return results.shift();
    },
  });
  const handler = makeHandler({ config: baseConfig(PENDING_OVERHEARD), turns, llm, now: clock, sleep: async () => {}, rng: () => 0.5, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const channel = fakeChannelWithHistory('c1', guild, []);
  await openFollowUpWindow(handler, { guild, channel, ts: FOLLOW_UP_T0 });
  clock.set(FOLLOW_UP_T0 + 1000);
  channel.messages.cache.set('m1', {});

  const { logs } = await withCapturedLogs(async () => {
    const p = handler(plainFollowUpMessage({ id: 'm1', guild, channel, content: 'she again', authorId: 'u1', authorName: 'Élodie', ts: FOLLOW_UP_T0 + 1000 }));
    await tick();
    llm.respond('overheard');
    await p;
    for (let i = 0; i < 5; i += 1) await settle();
  });

  assert.deepEqual(followUpDropped(logs), []);
  assert.deepEqual(logs.filter((l) => l.msg === 'follow-up: deferred').map((l) => [l.message, l.kind]), [['m1', 'overheard']]);
  assert.deepEqual(calls.map((c) => [c.trigger.id, c.triggerKind]), [['m1', 'overheard'], ['m1', 'overheard']]);
});

test('follow-up: a pending followUp is not replaced by a later overheard', async () => {
  const scene = await busyFollowUpScene({ config: baseConfig(PENDING_OVERHEARD) });
  const first = await busyCandidate(scene, 'm1', 'yes');
  const second = await busyCandidate(scene, 'm2', 'overheard');
  assert.deepEqual(deferredOf(first), [['c1', 'm1', 'c9', false]]);
  assert.deepEqual(deferredOf(second), [], 'the overheard line does not take the slot');
  assert.deepEqual(followUpDropped(second), [['m2', 'outranked']]);

  const drain = await endTurnAndDrain(scene);
  assert.deepEqual(followUpDropped(drain), []);
  assert.deepEqual(startedTurns(scene.turns), [['m1', 'followUp']]);
});

test('follow-up: a pending overheard is replaced by a later followUp', async () => {
  const scene = await busyFollowUpScene({ config: baseConfig(PENDING_OVERHEARD) });
  await busyCandidate(scene, 'm1', 'overheard');
  const second = await busyCandidate(scene, 'm2', 'yes');
  assert.deepEqual(followUpDropped(second), [['m1', 'newer']]);
  assert.deepEqual(deferredOf(second), [['c1', 'm2', 'c9', false]]);

  await endTurnAndDrain(scene);
  assert.deepEqual(startedTurns(scene.turns), [['m2', 'followUp']]);
});

test('follow-up: a pending overheard is replaced by a later direct mention in its channel', async () => {
  const scene = await busyFollowUpScene({ config: baseConfig(PENDING_OVERHEARD) });
  await busyCandidate(scene, 'm1', 'overheard');
  scene.channel.messages.cache.set('m2', {});
  const { logs } = await withCapturedLogs(() =>
    scene.handler(directPingMessage({ id: 'm2', guild: scene.guild, channel: scene.channel, channelId: 'c1', createdTimestamp: FOLLOW_UP_T0 + 5000 })),
  );
  assert.deepEqual(followUpDropped(logs), [['m1', 'newer']]);
  assert.equal(logs.filter((l) => l.msg === 'mention: deferred').length, 1);

  await endTurnAndDrain(scene);
  assert.deepEqual(startedTurns(scene.turns), [['m2', 'mention']]);
});

test('follow-up: a waiting followUp stays beside a later direct mention with pendingOverheard on, as before', async () => {
  const scene = await busyFollowUpScene({ config: baseConfig(PENDING_OVERHEARD) });
  await busyCandidate(scene, 'm1', 'yes');
  scene.channel.messages.cache.set('m2', {});
  const { logs } = await withCapturedLogs(() =>
    scene.handler(directPingMessage({ id: 'm2', guild: scene.guild, channel: scene.channel, channelId: 'c1', createdTimestamp: FOLLOW_UP_T0 + 5000 })),
  );
  assert.deepEqual(followUpDropped(logs), []);
  await endTurnAndDrain(scene);
  assert.deepEqual(startedTurns(scene.turns).map(([id]) => id), ['m1', 'm2']);
});

test('follow-up: a deferred overheard line is not shown to another turn of its channel as a waiting call', async () => {
  const scene = await busyFollowUpScene({ config: baseConfig(PENDING_OVERHEARD) });
  // A direct mention queued first, then the overheard line of the same channel (a later
  // direct call would take its place, so the mention must come before it).
  scene.channel.messages.cache.set('m0', {});
  await withCapturedLogs(() =>
    scene.handler(directPingMessage({ id: 'm0', guild: scene.guild, channel: scene.channel, channelId: 'c1', createdTimestamp: FOLLOW_UP_T0 + 500 })),
  );
  await busyCandidate(scene, 'm1', 'overheard');
  // What each turn would show as waiting, read when it starts (queued is read lazily).
  const shown = [];
  const run = scene.turns.runTurn;
  scene.turns.runTurn = (args) => (shown.push([args.trigger.id, args.queued?.() ?? null]), run(args));
  // The fake turn never posts, so the drain answers both; the mention first.
  await endTurnAndDrain(scene);
  assert.deepEqual(startedTurns(scene.turns), [['m0', 'mention'], ['m1', 'overheard']]);
  assert.deepEqual(shown[0], ['m0', []], 'the overheard line is not a call waiting for its turn');
});

test('follow-up: three messages in a row keep the newest in the slot and the drained turn reads them from history', async () => {
  const clock = mutableNow(FOLLOW_UP_T0);
  const llm = fakeFollowUpLlm();
  const turns = attentionTurns('c9');
  const handler = makeHandler({ config: baseConfig(PENDING_OVERHEARD), turns, llm, now: clock, sleep: async () => {}, rng: () => 0.5, prompts: fakeAddressPrompts() });
  const guild = fakeGuild();
  const history = [];
  const channel = fakeChannelWithHistory('c1', guild, history);
  await openFollowUpWindow(handler, { guild, channel, ts: FOLLOW_UP_T0 });
  turns.busy = true;

  const allLogs = [];
  for (const [i, content] of ['she said so', 'ask her', 'Zoé knows'].entries()) {
    const id = `m${i + 1}`;
    const ts = FOLLOW_UP_T0 + (i + 1) * 1000;
    clock.set(ts);
    const message = plainFollowUpMessage({ id, guild, channel, content, authorId: 'u1', authorName: 'Élodie', ts });
    history.push(message);
    channel.messages.cache.set(id, message);
    const { logs } = await withCapturedLogs(async () => {
      const p = handler(message);
      await tick();
      llm.respond('overheard');
      await p;
      await tick();
    });
    allLogs.push(...logs);
  }

  assert.equal(llm.calls.length, 3, 'each line was classified');
  assert.deepEqual(followUpDropped(allLogs), [['m1', 'newer'], ['m2', 'newer']]);
  const deferred = allLogs.filter((l) => l.msg === 'follow-up: deferred');
  assert.deepEqual(deferred.map((l) => l.message), ['m1', 'm2', 'm3']);
  assert.equal(deferred.at(-1).pending, 1, 'the slot holds one entry');

  turns.busy = false;
  await withCapturedLogs(() => handler.drainPending());
  assert.deepEqual(startedTurns(turns), [['m3', 'overheard']], 'the slot held the last one');
  const fetched = await turns.calls[0].channel.messages.fetch({ limit: 50 });
  assert.deepEqual([...fetched.keys()], ['m1', 'm2', 'm3'], 'the drained turn reads all three in the history');
});

test('follow-up: an overheard line that arrived after the running turn fetched its history is drained, not dropped as answered', async () => {
  const scene = await deferredFollowUps({ busyIn: 'c1', answers: ['overheard'], config: baseConfig({ mention: { pendingOverheard: true } }) });
  await openFollowUpWindow(scene.handler, { guild: scene.guild, channel: scene.channel, ts: FOLLOW_UP_T0 + 5000 });
  scene.turns.spokeAfterSeeing = () => false;
  const logs = await endTurnAndDrain(scene);
  assert.deepEqual(followUpDropped(logs), []);
  assert.deepEqual(startedTurns(scene.turns), [['m1', 'overheard']]);
});

// ---- participation: a member's line right after the persona's own ----------------------------

/** A store with the participation store, one episode in c1 whose own line is at `ownAt`. */
function participationEventsStore(ownAt) {
  let value = {
    nextId: 2,
    episodes: [
      {
        id: 'p1',
        channelId: 'c1',
        continues: null,
        messages: [{ id: 'own1', ts: ownAt, authorId: 'self1', name: 'Ζωή', self: true, text: 'ναι', replyTo: null, caption: null }],
      },
    ],
  };
  const writes = [];
  const reads = [];
  return {
    ...fakeStore(),
    writes,
    reads,
    current: () => value,
    getParticipation: () => {
      reads.push(1);
      return structuredClone(value);
    },
    setParticipation: (guildId, state, opts) => {
      writes.push({ guildId, opts });
      value = structuredClone(state);
    },
  };
}

test('onMessage: a member line soon after the persona spoke joins her participation episode, once', async () => {
  const ownAt = Date.UTC(2026, 9, 10, 12, 0, 0);
  const store = participationEventsStore(ownAt);
  const turns = { ...fakeTurns(), lastPostAt: () => ownAt };
  const guild = fakeGuild();
  const channel = fakeChannel('c1', guild);
  const now = mutableNow(ownAt + 60_000);
  const handler = makeHandler({ store, turns, now, config: baseConfig({ participation: { followMinutes: 10, linesAfter: 1 } }) });
  const { logs } = await withCapturedLogs(async () => {
    await handler(fakeMessage({ id: 'f1', guild, channel, channelId: 'c1', createdTimestamp: ownAt + 60_000, cleanContent: 'ευχαριστώ' }));
    await handler(fakeMessage({ id: 'f2', guild, channel, channelId: 'c1', createdTimestamp: ownAt + 90_000, cleanContent: 'και κάτι ακόμα' }));
  });
  assert.equal(store.writes.length, 1, 'the second line is past linesAfter: nothing changes, nothing is written');
  assert.deepEqual(store.current().episodes[0].messages.map((m) => m.id), ['own1', 'f1']);
  assert.equal(store.current().episodes[0].messages[1].name, 'User');
  assert.equal(store.writes[0].opts.now, ownAt + 60_000);
  const recorded = logs.filter((l) => l.msg === 'participation: recorded');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].following, true);
  assert.ok(!JSON.stringify(logs).includes('ευχαριστώ'), 'no text in the logs');
});

test('onMessage: no recent own post, the switch off, a bot or the diary channel never touch the participation store', async () => {
  const ownAt = Date.UTC(2026, 9, 10, 12, 0, 0);
  const guild = fakeGuild();
  const channel = fakeChannel('c1', guild);
  const line = (extra = {}) => fakeMessage({ id: 'f1', guild, channel, channelId: 'c1', createdTimestamp: ownAt + 60_000, ...extra });

  const stale = participationEventsStore(ownAt);
  await withCapturedLogs(() => makeHandler({ store: stale, turns: { ...fakeTurns(), lastPostAt: () => ownAt - 3_600_000 } })(line()));
  assert.equal(stale.reads.length, 0, 'the persona has not posted here lately: the store is not even read');

  const off = participationEventsStore(ownAt);
  await withCapturedLogs(() => makeHandler({ store: off, turns: { ...fakeTurns(), lastPostAt: () => ownAt }, config: baseConfig({ features: { participation: false } }) })(line()));
  assert.equal(off.writes.length + off.reads.length, 0);

  const bot = participationEventsStore(ownAt);
  await withCapturedLogs(() => makeHandler({ store: bot, turns: { ...fakeTurns(), lastPostAt: () => ownAt } })(line({ author: { id: 'b9', bot: true, globalName: 'Bot', username: 'bot' } })));
  assert.equal(bot.writes.length, 0);

  const diary = participationEventsStore(ownAt);
  await withCapturedLogs(() => makeHandler({ store: diary, turns: { ...fakeTurns(), lastPostAt: () => ownAt }, config: baseConfig({ diary: { channelId: 'c1' } }) })(line()));
  assert.equal(diary.writes.length, 0);
});

// ---------------------------------------------------------------------------
// The record (src/memory/record.js): a deleted message and an edit.

test('events: a deleted message writes a deleted line and an edit writes revision 2', async () => {
  const appended = [];
  const record = { append: async (guildId, lines, opts) => { appended.push({ guildId, lines, opts }); return { written: lines.length, duplicates: 0 }; } };
  const config = baseConfig({ features: { record: true } });
  const store = tmpStore();
  const at = Date.UTC(2026, 9, 13, 10, 0, 0);
  const handler = makeHandler({ config, store, record, now: () => at });
  const created = fakeMessage({ id: 'm1', content: 'πρώτα', cleanContent: 'πρώτα', createdTimestamp: at - 60_000, mentions: { users: new Map([['u2', {}]]) } });

  await handler.onMessageDelete(created);
  assert.equal(appended.length, 1);
  const [deleted] = appended[0].lines;
  assert.equal(appended[0].guildId, 'g1');
  assert.equal(deleted.kind, 'deleted');
  assert.equal(deleted.messageId, 'm1');
  assert.equal(deleted.occurredAt, new Date(at - 60_000).toISOString(), 'dated by the message itself');
  assert.equal(deleted.recordedAt, new Date(at).toISOString(), 'the deletion time is kept as the write time');
  assert.deepEqual(deleted.scope, { channel: 'c1' });
  assert.deepEqual(deleted.participants, ['u1']);
  assert.equal('text' in deleted, false);

  // An update that only attaches embeds is no edit.
  const embedded = fakeMessage({ ...created, embeds: [TENOR_GIFV] });
  await withCapturedLogs(() => handler.onMessageUpdate(created, embedded));
  assert.equal(appended.length, 1);

  const edited = fakeMessage({ ...created, content: 'μετά', cleanContent: 'μετά' });
  await withCapturedLogs(() => handler.onMessageUpdate(created, edited));
  assert.equal(appended.length, 2);
  const [edit] = appended[1].lines;
  assert.equal(edit.kind, 'seen');
  assert.equal(edit.messageId, 'm1');
  assert.equal(edit.revision, 2);
  assert.equal(edit.text, 'μετά');
  assert.equal(edit.by, 'u1');
  assert.deepEqual(edit.mentions, ['u2']);
  assert.equal(edit.occurredAt, new Date(at - 60_000).toISOString(), 'dated by the message, like its first line');

  const again = fakeMessage({ ...created, content: 'τρίτο', cleanContent: 'τρίτο' });
  await withCapturedLogs(() => handler.onMessageUpdate(edited, again));
  assert.equal(appended[2].lines[0].revision, 3);

  // Another bot, another guild, or features.record off: nothing.
  const otherBot = fakeMessage({ ...created, author: { id: 'b2', bot: true, globalName: 'B', username: 'b' } });
  await handler.onMessageDelete(otherBot);
  const elsewhere = fakeMessage({ ...created, guild: fakeGuild('g2'), channel: fakeChannel('c9', fakeGuild('g2')) });
  await handler.onMessageDelete(elsewhere);
  config.features.record = false;
  await handler.onMessageDelete(created);
  assert.equal(appended.length, 3);
});
