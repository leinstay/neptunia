// Tests for src/behavior/turn.js: the pure helpers (between, typingMs,
// resolveMentions) plus one integration-style suite for createTurnRunner
// itself, driven with fake discord.js-shaped objects, a fake LLM and a fake
// store -- proving the feature switches (reactions, multiMessage,
// typingSimulation, memory) are applied where this module is responsible for
// them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PermissionFlagsBits, SnowflakeUtil } from 'discord.js';
import {
  resolveMentions,
  createTurnRunner,
  parseRewatchPickDetailed,
  usableDestination,
  postLedgerSize,
  appendPostLedger,
  paceSettings,
} from '../src/behavior/turn.js';
import { between, typingMs } from '../src/behavior/random.js';
import { fillPromptTemplate, userText as textOf } from '../src/behavior/prompt.js';
import { fill, formatClock, formatDate } from '../src/discord/format.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { ImageCapError, ImageGenError } from '../src/llm/images.js';
import { DailyCapError, TokenLimitError } from '../src/llm/openrouter.js';
import { pingStatus } from '../src/behavior/elsewhere.js';
import { findGif } from '../src/memory/gifs.js';
import { createJournal } from '../src/memory/journal.js';

function rngReturning(value) {
  return () => value;
}

test('between: rng=0.5 returns the midpoint', () => {
  assert.equal(between([10, 20], rngReturning(0.5)), 15);
});

test('typingMs: clamps below minMs for very short text', () => {
  const cfg = { msPerChar: [1, 1], minMs: 900, maxMs: 12000 };
  const ms = typingMs('a', cfg, rngReturning(0)); // 1 char * 1ms/char = 1ms, way under minMs
  assert.equal(ms, 900);
});

test('typingMs: clamps above maxMs for very long text', () => {
  const cfg = { msPerChar: [100, 100], minMs: 900, maxMs: 12000 };
  const ms = typingMs('a'.repeat(1000), cfg, rngReturning(0)); // 100,000ms, way over maxMs
  assert.equal(ms, 12000);
});

test('typingMs: within range uses length * msPerChar (rounded)', () => {
  const cfg = { msPerChar: [10, 10], minMs: 0, maxMs: 100000 };
  const ms = typingMs('a'.repeat(20), cfg, rngReturning(0));
  assert.equal(ms, 200);
});

function historyMsg(authorName, authorId, overrides = {}) {
  return { authorName, authorId, self: false, bot: false, ...overrides };
}

test('resolveMentions: replaces a known @name with a real Discord mention', () => {
  const history = [historyMsg('Alice', 'u1')];
  const result = resolveMentions('γεια @Alice πώς είσαι', history);
  assert.equal(result.text, 'γεια <@u1> πώς είσαι');
  assert.deepEqual(result.userIds, ['u1']);
});

test('resolveMentions: an unknown name is left untouched', () => {
  const history = [historyMsg('Alice', 'u1')];
  const result = resolveMentions('γεια @Ghost', history);
  assert.equal(result.text, 'γεια @Ghost');
  assert.deepEqual(result.userIds, []);
});

test('resolveMentions: excludes its own lines and bot lines from candidates', () => {
  const history = [
    historyMsg('Zoë', 'self-id', { self: true }),
    historyMsg('SomeBot', 'bot-id', { bot: true }),
    historyMsg('Alice', 'u1'),
  ];
  const result = resolveMentions('@Zoë @SomeBot @Alice', history);
  assert.equal(result.text, '@Zoë @SomeBot <@u1>');
  assert.deepEqual(result.userIds, ['u1']);
});

test('resolveMentions: longer names are matched before their shorter prefixes', () => {
  const history = [historyMsg('Anna', 'short-id'), historyMsg('AnnaMaria', 'long-id')];
  const result = resolveMentions('γεια @AnnaMaria', history);
  // Must not first match "@Anna" inside "@AnnaMaria" and leave "Maria" dangling.
  assert.equal(result.text, 'γεια <@long-id>');
  assert.deepEqual(result.userIds, ['long-id']);
});

test('resolveMentions: replaces every occurrence of the same name', () => {
  const history = [historyMsg('Alice', 'u1')];
  const result = resolveMentions('@Alice γεια @Alice', history);
  assert.equal(result.text, '<@u1> γεια <@u1>');
  assert.deepEqual(result.userIds, ['u1']);
});

test('resolveMentions: deduplicates authors that appear more than once in history', () => {
  const history = [historyMsg('Alice', 'u1'), historyMsg('Alice', 'u1', { content: 'again' })];
  const result = resolveMentions('@Alice', history);
  assert.deepEqual(result.userIds, ['u1']);
});

test('resolveMentions: a stored multi-word name of a member shown resolves', () => {
  const history = [historyMsg('Whammy', 'u3')];
  const known = [{ name: 'Más tarde nunca', id: 'u3' }, { name: 'Whammy', id: 'u3' }];
  const result = resolveMentions('@Más tarde nunca ναι', history, known);
  assert.equal(result.text, '<@u3> ναι');
  assert.deepEqual(result.userIds, ['u3']);
});

test('resolveMentions: a transcript author wins a name a stored profile shares', () => {
  const history = [historyMsg('Bob', 'u2')];
  const result = resolveMentions('@Bob ναι', history, [{ name: 'Bob', id: 'u7' }]);
  assert.equal(result.text, '<@u2> ναι');
  assert.deepEqual(result.userIds, ['u2']);
});

test('resolveMentions: a name only a member not handed over carries stays text', () => {
  // The caller hands over the members the request showed; anyone else is no candidate.
  const history = [historyMsg('Alice', 'u1')];
  const result = resolveMentions('@Ταξιάρχης γεια', history, [{ name: 'Αλίκη', id: 'u1' }]);
  assert.equal(result.text, '@Ταξιάρχης γεια');
  assert.deepEqual(result.userIds, []);
});

test('resolveMentions: a stored name containing a shorter transcript name is matched first', () => {
  const history = [historyMsg('Anna', 'short-id')];
  const result = resolveMentions('@Anna María, @Anna', history, [{ name: 'Anna María', id: 'long-id' }]);
  assert.equal(result.text, '<@long-id>, <@short-id>');
  assert.deepEqual(result.userIds, ['long-id', 'short-id']);
});

test('resolveMentions: the first member handed over keeps a stored name two share; empty names are skipped', () => {
  const known = [{ name: 'Zoé', id: 'z1' }, { name: 'Zoé', id: 'z2' }, { name: '', id: 'z3' }, { name: ' ', id: 'z4' }];
  const result = resolveMentions('@Zoé @ x', [], known);
  assert.equal(result.text, '<@z1> @ x');
  assert.deepEqual(result.userIds, ['z1']);
});

// ---------------------------------------------------------------------------
// createTurnRunner — integration-style, fake channel/llm/store/hot.

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);

/** A discord.js-shaped raw message, just enough for normalizeMessage. */
function rawMessage({
  id,
  authorId = 'u1',
  authorName = 'Alice',
  ts = NOW - 1000,
  content = 'hey bot',
  attachments = new Map(),
  stickers = new Map(),
}) {
  return {
    id,
    channelId: 'c1',
    author: { id: authorId, bot: false, globalName: authorName, username: authorName },
    member: { displayName: authorName },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments,
    stickers,
  };
}

/** The normalized shape events.js would hand to runTurn as `trigger`. */
function normalizedTrigger(raw) {
  return {
    id: raw.id,
    channelId: raw.channelId,
    authorId: raw.author.id,
    authorName: raw.author.globalName,
    self: false,
    bot: false,
    content: raw.cleanContent,
    ts: raw.createdTimestamp,
    replyToId: null,
    attachments: [],
    stickers: [],
  };
}

/** `dm: true` is a private (DM) channel: no guild, no name, no member permissions. */
function fakeTurnChannel({ id = 'c1', name = 'general', guildId = 'g1', historyMessages = [], attachFiles = true, dm = false } = {}) {
  const guild = dm ? null : { id: guildId, members: { me: { displayName: 'Bot' } }, channels: { cache: new Map() } };
  const sent = [];
  const typingCalls = [];
  const reactCalls = [];
  const channel = {
    id,
    name: dm ? null : name,
    guild,
    viewable: true,
    // Every permission is granted, Attach Files only when `attachFiles`; a DM has no permissions to resolve.
    permissionsFor: dm
      ? () => {
          throw new Error('a DM channel has no member permissions');
        }
      : () => ({ has: (flag) => attachFiles || flag !== PermissionFlagsBits.AttachFiles }),
    sendTyping: async () => {
      typingCalls.push(Date.now());
    },
    send: async (payload) => {
      sent.push(payload);
      return { id: `sent-${sent.length}` };
    },
    messages: {
      cache: new Map(),
      fetch: async (arg) => {
        if (arg && typeof arg === 'object' && 'limit' in arg) {
          return new Map(historyMessages.map((m) => [m.id, m]));
        }
        const target = historyMessages.find((m) => m.id === arg);
        if (!target) throw new Error(`fixture message not found: ${arg}`);
        return { react: async (emoji) => reactCalls.push({ id: arg, emoji }) };
      },
    },
    sent,
    typingCalls,
    reactCalls,
  };
  return channel;
}

function fakeLlm(responseText) {
  const calls = [];
  const optionCalls = [];
  return {
    calls,
    optionCalls,
    complete: async (messages, options) => {
      calls.push(messages);
      optionCalls.push(options);
      return { text: responseText, usage: {}, estimated: 10 };
    },
  };
}

function fakeStore({ guildMemory = {}, userProfiles = {}, channels = [], loreEntries = [], privateProfiles = {}, mediaCache = {} } = {}) {
  const guildCalls = [];
  const privateCalls = [];
  return {
    guildCalls,
    privateCalls,
    getGuild: (guildId) => {
      guildCalls.push(guildId);
      return guildMemory;
    },
    getUser: (guildId, userId) => userProfiles[userId] ?? null,
    getPrivate: (guildId, userId) => {
      privateCalls.push({ guildId, userId });
      return privateProfiles[userId] ?? null;
    },
    listChannels: () => channels,
    listUserProfiles: () => Object.values(userProfiles),
    getLore: () => loreEntries,
    getMediaCache: () => mediaCache,
    state: { data: {}, markDirty() {} },
  };
}

function identityCalibrator() {
  return { ratio: 1, apply: (n) => n, observe: () => {} };
}

// The switches that count as on when their key is missing, set here so no test leans on that fallback.
const SWITCHES_ON = {
  memory: true,
  reactions: true,
  multiMessage: true,
  typingSimulation: true,
  customEmoji: true,
  gifs: true,
  imageGeneration: true,
  channelPull: true,
  elsewhere: true,
  recent: true,
  videoRewatch: true,
  imageRelook: true,
  videoDescriptions: true,
  attachedDescriptions: true,
  vision: true,
  privateLikeServer: true,
};

function fakeHot(featureOverrides = {}, botOverrides = {}, configOverrides = {}) {
  return {
    config: {
      bot: { timezone: 'UTC', dryRunChannelId: '', ...botOverrides },
      context: {
        channelMessages: 100,
        neighborMessages: 5,
        neighborMaxAgeMinutes: 60,
        neighborMaxChannels: 8,
        maxMessageChars: 800,
        gapMarkerMinutes: 20,
        otherProfiles: 6,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0, maxBytes: 1_500_000, fetchTimeoutMs: 10_000 },
        pull: { scanMessages: 20, maxChannels: 1, sameAudience: true },
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      features: { ...SWITCHES_ON, ...featureOverrides },
      media: { maxPerTurn: 6, filePreviewChars: 500 },
      gifs: { maxPerDay: 40 },
      mentor: { anchor: { ledgerSize: 50 } },
      ...configOverrides,
    },
    prompts: {
      'system-prompt': 'You are a regular member of this chat, not an assistant.',
      'character-card': 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      reply: 'Someone called you: {{author}}.',
      interject: 'Jump into the conversation.',
      initiate: 'Start a topic.',
      memory: 'Summarize what happened.',
      labels,
    },
  };
}

function fakeClient(overrides = {}) {
  return { user: { id: 'self-id', username: 'Bot' }, ...overrides };
}

/** A fake createImageFetcher()-shaped dependency (see src/discord/fetch-image.js). `result` may be
 * `null` (every download fails), a fixed success object, or `(url, options) => result|null`. */
function fakeImageFetcher(result = { dataUrl: 'data:image/webp;base64,ZmFrZQ==', bytes: 4, contentType: 'image/webp' }) {
  const calls = [];
  return {
    calls,
    fetchAsDataUrl: async (url, options) => {
      calls.push({ url, options });
      return typeof result === 'function' ? result(url, options) : result;
    },
  };
}


// /nep pause: no new turn may start while paused -- a reply, an
// interject, an initiate, an eavesdrop or a forced turn alike, whatever the mode.
test('runTurn: refuses with outcome "paused" while store.state.data.paused is true, before touching the LLM or busy', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>hi</msg>');
  const store = fakeStore();
  store.state.data.paused = true;
  const hot = fakeHot();
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'paused');
  assert.equal(llm.calls.length, 0, 'the LLM must never be called while paused');
  assert.equal(turns.isBusy(channel.id), false, 'the channel is never marked busy for a refused turn');
});

// /nep interject, /nep initiate: forced is passed straight through to
// buildRequest, which appends prompts.forced (when present) to the task text.
test('runTurn: forced=true appends prompts.forced to the task text sent to the LLM', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<skip/>');
  const store = fakeStore();
  const hot = fakeHot();
  hot.prompts.forced = 'FORCED_TASK_TEXT';
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  await turns.runTurn({ channel, mode: 'interject', forced: true });

  assert.equal(llm.calls.length, 1);
  const userText = textOf(llm.calls[0][1].content);
  assert.ok(userText.includes('FORCED_TASK_TEXT'));
});

test('runTurn: forced defaults to false -- prompts.forced is never appended for an ordinary spontaneous turn', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<skip/>');
  const store = fakeStore();
  const hot = fakeHot();
  hot.prompts.forced = 'FORCED_TASK_TEXT';
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  await turns.runTurn({ channel, mode: 'interject' });

  assert.equal(llm.calls.length, 1);
  const userText = textOf(llm.calls[0][1].content);
  assert.ok(!userText.includes('FORCED_TASK_TEXT'));
});

test('waitIdle: resolves immediately when no turn is in flight', async () => {
  const store = fakeStore();
  const hot = fakeHot();
  const turns = createTurnRunner({ hot, store, llm: fakeLlm('<msg>hi</msg>'), calibrator: identityCalibrator(), client: fakeClient() });

  let resolved = false;
  turns.waitIdle().then(() => { resolved = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(resolved, true);
});

test('waitIdle: resolves only once every in-flight turn has finished', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const store = fakeStore();
  const hot = fakeHot();
  let releaseLlm;
  const llm = { complete: () => new Promise((resolve) => { releaseLlm = () => resolve({ text: '<msg>hi</msg>', usage: {}, estimated: 1 }); }) };
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  const turnPromise = turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
  // Let runTurn's own awaits (fetchHistory, withTextPreviews, fetchNeighbors,
  // buildRequest...) settle before it reaches the still-pending LLM call.
  await new Promise((resolve) => setTimeout(resolve, 0));

  let idleResolved = false;
  const idlePromise = turns.waitIdle().then(() => { idleResolved = true; });
  assert.equal(idleResolved, false, 'must not resolve while the turn is still in flight');

  releaseLlm();
  await turnPromise;
  await idlePromise;
  assert.equal(idleResolved, true);
});

test('createTurnRunner: features.reactions=false drops reactions; nothing else to do means outcome "skip"', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<react to="#1">💀</react>');
  const store = fakeStore();
  const hot = fakeHot({ reactions: false });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'skip');
  assert.equal(channel.sent.length, 0);
  assert.equal(channel.reactCalls.length, 0);
});

test('createTurnRunner: features.multiMessage=false keeps only the first <msg>', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>First</msg><msg>Second</msg>');
  const store = fakeStore();
  const hot = fakeHot({ multiMessage: false });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, 'First');
});

test('createTurnRunner: features.typingSimulation=false skips sendTyping and every artificial delay', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>Hello there</msg>');
  const store = fakeStore();
  const hot = fakeHot({ typingSimulation: false });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  const started = Date.now();
  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
  const elapsed = Date.now() - started;

  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.typingCalls.length, 0);
  assert.equal(channel.sent.length, 1);
  assert.ok(elapsed < 200, `expected no artificial delay, took ${elapsed}ms`);
});

test('createTurnRunner: features.memory=true renders <people> and <about_chat>', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore({
    guildMemory: { patterns: 'lots of emoji' },
    userProfiles: { u1: { id: 'u1', names: ['Alice'], character: 'friendly' } },
  });
  const hot = fakeHot({});
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  const userMessage = textOf(llm.calls[0][1].content);
  assert.ok(userMessage.includes('<people>'));
  assert.ok(userMessage.includes('<about_chat>'));
});

test('createTurnRunner: features.memory=false sends no <people> or <about_chat> block', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore({
    guildMemory: { patterns: 'lots of emoji' },
    userProfiles: { u1: { id: 'u1', names: ['Alice'], character: 'friendly' } },
  });
  const hot = fakeHot({ memory: false });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  const userMessage = textOf(llm.calls[0][1].content);
  assert.equal(typeof userMessage, 'string');
  assert.ok(!userMessage.includes('<people>'));
  assert.ok(!userMessage.includes('<about_chat>'));
});

test('createTurnRunner: features.memory=true renders the <server> channel map', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore({
    channels: [{ id: 'c1', name: 'general', category: null, topic: null, purpose: '', topics: '', tone: '', days: {}, lastMessageAt: null }],
  });
  const hot = fakeHot({});
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  const userMessage = textOf(llm.calls[0][1].content);
  assert.ok(userMessage.includes('<server>'));
  assert.ok(userMessage.includes(`# general${labels.server.currentMark}`));
});

test('createTurnRunner: features.memory=false sends no <server> block, even with channels on record', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore({
    channels: [{ id: 'c1', name: 'general', category: null, topic: null, purpose: '', topics: '', tone: '', days: {}, lastMessageAt: null }],
  });
  const hot = fakeHot({ memory: false });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  const userMessage = textOf(llm.calls[0][1].content);
  assert.ok(!userMessage.includes('<server>'));
});

test('createTurnRunner: features.memory=true renders <lore> from the guild lorebook', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const loreEntries = [{ id: 'l1', title: 'The Great Flood', keys: ['never-mentioned'], text: 'It flooded once.', always: true, source: 'analyzer', weight: 3 }];
  const store = fakeStore({ loreEntries });
  const hot = fakeHot({});
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  const userMessage = textOf(llm.calls[0][1].content);
  assert.ok(userMessage.includes('<lore>'));
  assert.ok(userMessage.includes('The Great Flood'));
});

test('createTurnRunner: features.memory=false sends no <lore> block, even with lore on record', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const loreEntries = [{ id: 'l1', title: 'The Great Flood', keys: ['never-mentioned'], text: 'It flooded once.', always: true, source: 'analyzer', weight: 3 }];
  const store = fakeStore({ loreEntries });
  const hot = fakeHot({ memory: false });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  const userMessage = textOf(llm.calls[0][1].content);
  assert.ok(!userMessage.includes('<lore>'));
});

// ---------------------------------------------------------------------------
// features.mediaDescriptions -- describing pictures that are not attached.

function fakeDescriber(descriptionsById) {
  const calls = [];
  return {
    calls,
    describeMany: async (guildId, items, options) => {
      calls.push({ guildId, items, options });
      const descriptions = new Map();
      for (const item of items) {
        if (descriptionsById[item.itemId]) descriptions.set(item.itemId, descriptionsById[item.itemId]);
      }
      return { descriptions, newCount: descriptions.size };
    },
  };
}

/** fakeDescriber plus describeVideos: every candidate in `statesById` gets that state. */
function fakeVideoDescriber(statesById, descriptionsById = {}) {
  const base = fakeDescriber(descriptionsById);
  const videoCalls = [];
  return {
    ...base,
    videoCalls,
    describeVideos: async (guildId, items, options) => {
      videoCalls.push({ guildId, items, options });
      const videos = new Map();
      for (const item of items) {
        if (statesById[item.itemId]) videos.set(item.itemId, statesById[item.itemId]);
      }
      return { videos, newCount: videos.size };
    },
  };
}

function videoAttachmentRaw(id, ts, attachmentId, name) {
  return rawMessage({
    id,
    ts,
    attachments: new Map([
      [attachmentId, { id: attachmentId, contentType: 'video/mp4', name, url: `https://cdn.discordapp.com/attachments/1/2/${name}`, duration: 20 }],
    ]),
  });
}

const VIDEO_TURN_CONFIG = {
  media: { maxPerTurn: 6, filePreviewChars: 500, video: { maxPerTurn: 1, sites: ['youtube.com'] } },
};

test('createTurnRunner: features.videoDescriptions on -- videos newest first, capped at media.video.maxPerTurn, rendered watched', async () => {
  const older = videoAttachmentRaw('m1', NOW - 5000, 'va', 'older.mp4');
  const newer = rawMessage({ id: 'm2', ts: NOW - 1000, content: 'look https://www.youtube.com/watch?v=abc' });
  const channel = fakeTurnChannel({ historyMessages: [older, newer] });
  const llm = fakeLlm('<msg>ok</msg>');
  const hot = fakeHot({ mediaDescriptions: true, videoDescriptions: true, vision: false }, {}, VIDEO_TURN_CONFIG);
  const describer = fakeVideoDescriber({ va: { state: 'watched', text: 'κάποιος χορεύει' } });
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), describer });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(newer), triggerKind: 'mention' });

  assert.equal(describer.videoCalls.length, 1);
  const { guildId, items, options } = describer.videoCalls[0];
  assert.equal(guildId, 'g1');
  assert.deepEqual(
    items.map((item) => item.source),
    ['link', 'attachment'],
    'the newest message first; the typed video link is found because fetchHistory got media.video.sites',
  );
  assert.equal(items[1].itemId, 'va');
  assert.deepEqual(options, { maxNew: 1 }, 'every describer request counts: no daily-cap option is passed');
  const userMessage = textOf(llm.calls[0][1].content);
  const watched = labels.transcript.videoWatched
    .replace('{name}', 'older.mp4')
    .replace('{duration}', '0:20')
    .replace('{text}', 'κάποιος χορεύει');
  assert.ok(userMessage.includes(watched));
});

test('createTurnRunner: videoDescriptions off, or mediaDescriptions off, never calls describeVideos', async () => {
  for (const features of [
    { mediaDescriptions: true, videoDescriptions: false },
    { mediaDescriptions: false, videoDescriptions: true },
  ]) {
    const raw = videoAttachmentRaw('m1', NOW - 1000, 'va', 'clip.mp4');
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    const hot = fakeHot(features, {}, VIDEO_TURN_CONFIG);
    const describer = fakeVideoDescriber({ va: { state: 'watched', text: 'x' } });
    const turns = createTurnRunner({ hot, store: fakeStore(), llm: fakeLlm('<msg>ok</msg>'), calibrator: identityCalibrator(), client: fakeClient(), describer });

    await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

    assert.equal(describer.videoCalls.length, 0);
  }
});

test('createTurnRunner: features.mediaDescriptions off never calls the describer', async () => {
  const raw = rawMessage({
    id: 'm1',
    attachments: new Map([['img1', { id: 'img1', contentType: 'image/png', name: 'pic.png', url: 'https://cdn/pic.png' }]]),
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({ mediaDescriptions: false });
  const describer = fakeDescriber({ img1: 'a cat' });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), describer });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(describer.calls.length, 0);
});

test('createTurnRunner: features.mediaDescriptions on describes an un-attached picture and it renders imageDescribed', async () => {
  const raw = rawMessage({
    id: 'm1',
    attachments: new Map([['img1', { id: 'img1', contentType: 'image/png', name: 'pic.png', url: 'https://cdn/pic.png' }]]),
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({ mediaDescriptions: true });
  const describer = fakeDescriber({ img1: 'a grey cat' });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), describer });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(describer.calls.length, 1);
  assert.equal(describer.calls[0].items[0].itemId, 'img1');
  assert.equal(describer.calls[0].options.maxNew, 6);
  const userMessage = textOf(llm.calls[0][1].content);
  assert.ok(userMessage.includes(labels.transcript.imageDescribed.replace('{text}', 'a grey cat')));
});

// features.attachedDescriptions -- a picture attached as image_url also gets the helper's caption.

function attachedPictureTurn({ features, media, newer = false }) {
  const pic = { id: 'i1', contentType: 'image/png', name: 'one.png', url: 'https://cdn.discordapp.com/x/one.png' };
  const raw = rawMessage({ id: 'm2', attachments: new Map([['i1', pic]]) });
  const history = [raw];
  if (newer) {
    // A picture posted right after the trigger: newer, but not attached (recentImages is 0).
    const other = { id: 'o1', contentType: 'image/png', name: 'other.png', url: 'https://cdn.discordapp.com/x/other.png' };
    history.push(rawMessage({ id: 'm3', ts: NOW - 500, attachments: new Map([['o1', other]]) }));
  }
  const channel = fakeTurnChannel({ historyMessages: history });
  const llm = fakeLlm('<msg>ok</msg>');
  const hot = fakeHot(features, {}, media ? { media } : {});
  // Like fakeDescriber, but honours maxNew the way describeMany does (every caption here is new).
  const captions = { i1: 'a grey cat', o1: 'a red fox' };
  const describer = {
    calls: [],
    describeMany: async (guildId, items, options) => {
      describer.calls.push({ guildId, items, options });
      const descriptions = new Map();
      for (const item of items) {
        if (descriptions.size >= (options?.maxNew ?? Infinity)) break;
        if (captions[item.itemId]) descriptions.set(item.itemId, captions[item.itemId]);
      }
      return { descriptions, newCount: descriptions.size };
    },
  };
  const turns = createTurnRunner({
    hot,
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    describer,
    imageFetcher: fakeImageFetcher(),
  });
  const trigger = {
    ...normalizedTrigger(raw),
    attachments: [{ id: 'i1', kind: 'image', url: pic.url, name: 'one.png' }],
  };
  return { channel, llm, describer, turns, trigger };
}

function userText(llm) {
  return textOf(llm.calls[0][1].content);
}

test('createTurnRunner: features.attachedDescriptions on -- an attached picture is described and its caption sits with the marker', async () => {
  const { channel, llm, describer, turns, trigger } = attachedPictureTurn({ features: { mediaDescriptions: true, attachedDescriptions: true } });

  await turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' });

  assert.equal(describer.calls.length, 1);
  assert.deepEqual(describer.calls[0].items.map((item) => item.itemId), ['i1']);
  assert.ok(llm.calls[0][1].content.some((p) => p.type === 'image_url'), 'the picture is still attached as an image_url part');
  const text = userText(llm);
  assert.ok(text.includes(labels.transcript.imageAttachedDescribed.replace('{n}', '1').replace('{text}', 'a grey cat')));
});

test('createTurnRunner: features.attachedDescriptions false -- the attached picture is never sent to the describer, today\'s line', async () => {
  const { channel, llm, describer, turns, trigger } = attachedPictureTurn({ features: { mediaDescriptions: true, attachedDescriptions: false } });

  await turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' });

  const described = describer.calls.flatMap((call) => call.items.map((item) => item.itemId));
  assert.ok(!described.includes('i1'));
  const text = userText(llm);
  assert.ok(text.includes(labels.transcript.imageAttached.replace('{n}', '1')));
  assert.ok(!text.includes('a grey cat'));
});

test('createTurnRunner: features.attachedDescriptions on -- attached pictures come first, media.maxPerTurn still caps new captions', async () => {
  const { channel, llm, describer, turns, trigger } = attachedPictureTurn({
    features: { mediaDescriptions: true, attachedDescriptions: true },
    media: { maxPerTurn: 1, filePreviewChars: 500 },
    newer: true,
  });

  await turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' });

  assert.equal(describer.calls.length, 1);
  assert.deepEqual(describer.calls[0].items.map((item) => item.itemId), ['i1', 'o1'], 'the attached picture first, even ahead of a newer un-attached one');
  assert.equal(describer.calls[0].options.maxNew, 1);
  const text = userText(llm);
  assert.ok(text.includes(labels.transcript.imageAttachedDescribed.replace('{n}', '1').replace('{text}', 'a grey cat')));
  assert.ok(!text.includes('a red fox'), 'the one new caption of this turn went to the attached picture');
});

test('createTurnRunner: features.mediaDescriptions on describes a picture-format sticker via the same describer/cache path', async () => {
  const raw = rawMessage({
    id: 'm1',
    stickers: new Map([['s1', { id: 's1', name: 'pepe', format: 1 }]]),
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({ mediaDescriptions: true });
  const describer = fakeDescriber({ 'sticker:s1': 'a frog gives a thumbs up' });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), describer });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(describer.calls.length, 1);
  assert.equal(describer.calls[0].items[0].itemId, 'sticker:s1');
  const userMessage = textOf(llm.calls[0][1].content);
  assert.ok(
    userMessage.includes(labels.transcript.stickerDescribed.replace('{name}', 'pepe').replace('{text}', 'a frog gives a thumbs up')),
  );
});

test('createTurnRunner: features.mediaDescriptions on describes a custom emoji in the text, appended as an extra tag', async () => {
  const raw = rawMessage({ id: 'm1', content: 'nice <:pog:111> job' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({ mediaDescriptions: true });
  const describer = fakeDescriber({ 'emoji:111': 'a surprised cat face' });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), describer });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(describer.calls.length, 1);
  assert.equal(describer.calls[0].items[0].itemId, 'emoji:111');
  const userMessage = textOf(llm.calls[0][1].content);
  assert.ok(userMessage.includes('nice :pog: job'));
  assert.ok(userMessage.includes(labels.transcript.emojiDescribed.replace('{name}', 'pog').replace('{text}', 'a surprised cat face')));
});

// Pictures in a neighbour channel's lines: the captions the describer's cache already holds, never a request.

/**
 * A reply turn in c1 whose guild has one neighbour channel, c2, with a recent message carrying two
 * pictures: np1 (its caption is in the cache) and np2 (not cached). The fake describer's
 * cachedDescriptions answers from `cached` alone; describeMany records every call.
 */
function neighborPictureTurn(features) {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const posted = {
    ...rawMessage({
      id: 'n1',
      authorId: 'u2',
      authorName: 'Bob',
      ts: NOW - 2000,
      content: 'look',
      attachments: new Map([
        ['np1', { id: 'np1', contentType: 'image/png', name: 'cat.png', url: 'https://cdn.discordapp.com/x/cat.png' }],
        ['np2', { id: 'np2', contentType: 'image/png', name: 'dog.png', url: 'https://cdn.discordapp.com/x/dog.png' }],
      ]),
    }),
    channelId: 'c2',
  };
  const neighbor = {
    ...fakeTurnChannel({ id: 'c2', name: 'random', historyMessages: [posted] }),
    guild: channel.guild,
    isTextBased: () => true,
    isThread: () => false,
    lastMessageId: SnowflakeUtil.generate({ timestamp: NOW - 2000 }).toString(),
  };
  channel.guild.channels.cache.set(neighbor.id, neighbor);
  const cached = { np1: 'a sleeping cat' };
  const describer = {
    calls: [],
    cachedCalls: [],
    describeMany: async (guildId, items, options) => {
      describer.calls.push({ guildId, items, options });
      return { descriptions: new Map(), newCount: 0 };
    },
    cachedDescriptions: (guildId, items) => {
      describer.cachedCalls.push({ guildId, items });
      return new Map(items.filter((item) => cached[item.itemId]).map((item) => [item.itemId, cached[item.itemId]]));
    },
  };
  const llm = fakeLlm('<msg>ok</msg>');
  const turns = createTurnRunner({
    hot: fakeHot(features),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    describer,
    now: () => NOW,
  });
  return { channel, llm, describer, turns, trigger: normalizedTrigger(raw) };
}

/** The `<other_channels>` body of the first request the fake LLM received. */
function otherChannelsSent(llm) {
  return userText(llm).split('<other_channels>\n')[1].split('\n</other_channels>')[0];
}

test('runTurn: a neighbour picture already in the describer cache renders with its caption; an uncached one stays blind', async () => {
  const { channel, llm, describer, turns, trigger } = neighborPictureTurn({ mediaDescriptions: true });

  await turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' });

  assert.equal(describer.cachedCalls.length, 1);
  assert.equal(describer.cachedCalls[0].guildId, 'g1');
  assert.deepEqual(describer.cachedCalls[0].items.map((item) => item.itemId).sort(), ['np1', 'np2']);
  const others = otherChannelsSent(llm);
  assert.ok(others.includes('# random'), others);
  assert.ok(others.includes(fill(labels.transcript.imageDescribed, { text: 'a sleeping cat' })), others);
  assert.ok(others.includes(labels.transcript.image), 'the uncached picture keeps its blind form');
});

test('runTurn: no describe request is made for a neighbour picture', async () => {
  const { channel, describer, turns, trigger } = neighborPictureTurn({ mediaDescriptions: true });

  await turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' });

  const requested = describer.calls.flatMap((call) => call.items.map((item) => item.itemId));
  assert.ok(!requested.includes('np1') && !requested.includes('np2'), JSON.stringify(requested));
});

test('runTurn: features.mediaDescriptions off leaves a neighbour picture blind and never reads the cache', async () => {
  const { channel, llm, describer, turns, trigger } = neighborPictureTurn({ mediaDescriptions: false });

  await turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' });

  assert.equal(describer.cachedCalls.length, 0);
  assert.equal(describer.calls.length, 0);
  const others = otherChannelsSent(llm);
  assert.ok(!others.includes('a sleeping cat'), others);
  assert.ok(others.includes(labels.transcript.image));
});

test('createTurnRunner: a text attachment is fetched lazily and rendered via filePreview', async () => {
  const raw = rawMessage({
    id: 'm1',
    attachments: new Map([['t1', { id: 't1', contentType: 'text/plain', name: 'notes.txt', url: 'https://cdn/notes.txt' }]]),
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  let fetchedUrl = null;
  const fetchImpl = async (url) => {
    fetchedUrl = url;
    return { ok: true, headers: { get: () => null }, text: async () => 'the file says hello' };
  };
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), fetchImpl });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(fetchedUrl, 'https://cdn/notes.txt');
  const userMessage = textOf(llm.calls[0][1].content);
  assert.ok(userMessage.includes(labels.transcript.filePreview.replace('{name}', 'notes.txt').replace('{text}', 'the file says hello')));
});

test('createTurnRunner: a text-attachment fetch failure falls back to the plain file form', async () => {
  const raw = rawMessage({
    id: 'm1',
    attachments: new Map([['t1', { id: 't1', contentType: 'text/plain', name: 'notes.txt', url: 'https://cdn/notes.txt' }]]),
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), fetchImpl });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  const userMessage = textOf(llm.calls[0][1].content);
  assert.ok(userMessage.includes(labels.transcript.file.replace('{name}', 'notes.txt')));
});

// ---------------------------------------------------------------------------
// A provider that rejects the images (4xx) retries text-only -- the retry
// must never resend text still claiming a picture is attached.

function fakeLlmRejectingImagesOnce(statusCode, responseText) {
  const calls = [];
  const optionCalls = [];
  let first = true;
  return {
    calls,
    optionCalls,
    complete: async (messages, options) => {
      calls.push(messages);
      optionCalls.push(options);
      if (first) {
        first = false;
        const err = new Error('bad request');
        err.statusCode = statusCode;
        throw err;
      }
      return { text: responseText, usage: {}, estimated: 10 };
    },
  };
}

function videoTrigger(raw) {
  return {
    ...normalizedTrigger(raw),
    attachments: [
      { id: 'v1', kind: 'video', url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4', name: 'clip.mp4', durationSec: 34 },
    ],
  };
}

test('createTurnRunner: a 4xx image error (download succeeded, the provider itself still rejects) retries text-only, rendering the video blind (frameAttached dropped)', async () => {
  const raw = rawMessage({
    id: 'm1',
    attachments: new Map([
      ['v1', { id: 'v1', contentType: 'video/mp4', name: 'clip.mp4', url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4', duration: 34 }],
    ]),
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlmRejectingImagesOnce(400, '<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  const imageFetcher = fakeImageFetcher();
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), imageFetcher });

  const trigger = videoTrigger(raw);

  const result = await turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  assert.equal(llm.calls.length, 2, 'the first (image) attempt and the text-only retry');

  const firstUser = llm.calls[0][1].content;
  assert.ok(firstUser.some((p) => p.type === 'image_url'), 'the first attempt carries image_url parts');
  const firstText = firstUser.find((p) => p.type === 'text').text;
  assert.ok(firstText.includes(labels.transcript.frameAttached.replace('{n}', '1')));
  const firstImage = firstUser.find((p) => p.type === 'image_url');
  assert.ok(firstImage.image_url.url.startsWith('data:'), 'the downloaded picture is sent as a data: URL, never the bare CDN URL');

  const secondParts = llm.calls[1][1].content;
  assert.ok(Array.isArray(secondParts) && secondParts.every((p) => p.type === 'text'), 'the retry sends text parts only, no image_url parts');
  const secondUser = textOf(secondParts);
  assert.ok(secondUser.includes('[video: clip.mp4, 0:34]'), 'the video still renders in its blind form');
  assert.ok(!secondUser.includes('still frame'), 'frameAttached must not survive into the text-only retry');
});

// A rate limit / quota (429) or a request timeout (408) says nothing about the
// pictures: the client already retried it, so a text-only resend would only
// double a doomed request while the persona's one attention waits.
test('createTurnRunner: a 429 with pictures attached -- no text-only resend, the turn ends in error', async () => {
  const raw = videoRaw();
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlmRejectingImagesOnce(429, '<msg>never posted</msg>');
  const turns = createTurnRunner({
    hot: fakeHot({}),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    imageFetcher: fakeImageFetcher(),
  });

  const { result } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: videoTrigger(raw), triggerKind: 'mention' }),
  );

  assert.equal(result.outcome, 'error');
  assert.equal(llm.calls.length, 1, 'the model is called once, never resent text-only');
  assert.ok(llm.calls[0][1].content.some((p) => p.type === 'image_url'), 'the one call carried the pictures');
  assert.equal(channel.sent.length, 0);
});

test('createTurnRunner: a 4xx with no pictures in the request -- nothing to strip, so no resend, the turn ends in error', async () => {
  const raw = rawMessage({ id: 'm1', content: 'hello there' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlmRejectingImagesOnce(400, '<msg>never posted</msg>');
  const turns = createTurnRunner({
    hot: fakeHot({}),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    imageFetcher: fakeImageFetcher(),
  });

  const { result } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }),
  );

  assert.ok(llm.calls[0][1].content.every((p) => p.type === 'text'), 'the request carried no picture');
  assert.equal(result.outcome, 'error');
  assert.equal(llm.calls.length, 1, 'the model is called once, never resent');
  assert.equal(channel.sent.length, 0);
});

// ---------------------------------------------------------------------------
// The picture is downloaded and inlined as a data: URL BEFORE the model
// ever sees the request -- the provider's own fetcher gets a 403 from
// Discord on some CDN hosts even though our server fetches the same URL
// fine. A failed download drops EVERY picture of the turn (never a partial,
// mis-numbered set) and falls back to plain text.

function videoRaw(id = 'm1') {
  return rawMessage({
    id,
    attachments: new Map([
      ['v1', { id: 'v1', contentType: 'video/mp4', name: 'clip.mp4', url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4', duration: 34 }],
    ]),
  });
}

test('createTurnRunner: a picture is downloaded and sent as a data: URL, never the bare Discord CDN URL', async () => {
  const raw = videoRaw();
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  const imageFetcher = fakeImageFetcher();
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), imageFetcher });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: videoTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  assert.equal(imageFetcher.calls.length, 1);
  assert.equal(imageFetcher.calls[0].url.includes('clip.mp4'), true);
  assert.deepEqual(imageFetcher.calls[0].options, { maxBytes: 1_500_000, timeoutMs: 10_000 });
  const userContent = llm.calls[0][1].content;
  const imagePart = userContent.find((p) => p.type === 'image_url');
  assert.equal(imagePart.image_url.url, 'data:image/webp;base64,ZmFrZQ==');
});

test('createTurnRunner: a failed download drops EVERY picture of the turn -- sent as plain text, rendering blind, not attached', async () => {
  const raw = videoRaw();
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  const imageFetcher = fakeImageFetcher(null); // every download fails
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), imageFetcher });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: videoTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  const parts = llm.calls[0][1].content;
  assert.ok(parts.every((p) => p.type === 'text'), 'no image_url parts must be sent once any download failed');
  const userContent = textOf(parts);
  assert.ok(userContent.includes('[video: clip.mp4, 0:34]'), 'the video renders in its blind form');
  assert.ok(!userContent.includes('still frame'), 'frameAttached must not survive a dropped picture');
});

test('createTurnRunner: with two pictures, one failed download drops BOTH -- never a partial, mis-numbered set', async () => {
  const raw = rawMessage({
    id: 'm1',
    attachments: new Map([
      ['i1', { id: 'i1', contentType: 'image/png', name: 'one.png', url: 'https://cdn.discordapp.com/x/one.png' }],
      ['i2', { id: 'i2', contentType: 'image/png', name: 'two.png', url: 'https://cdn.discordapp.com/x/two.png' }],
    ]),
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  // one.png succeeds, two.png fails.
  const imageFetcher = fakeImageFetcher((url) =>
    url.includes('one.png') ? { dataUrl: 'data:image/png;base64,b25l', bytes: 3, contentType: 'image/png' } : null,
  );
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), imageFetcher });

  const trigger = {
    ...normalizedTrigger(raw),
    attachments: [
      { id: 'i1', kind: 'image', url: 'https://cdn.discordapp.com/x/one.png', name: 'one.png' },
      { id: 'i2', kind: 'image', url: 'https://cdn.discordapp.com/x/two.png', name: 'two.png' },
    ],
  };

  const result = await turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  const parts = llm.calls[0][1].content;
  assert.ok(parts.every((p) => p.type === 'text'), 'both pictures must be dropped, not just the failed one');
  const userContent = textOf(parts);
  assert.ok(
    !userContent.includes(labels.transcript.imageAttached.replace('{n}', '1')) &&
      !userContent.includes(labels.transcript.imageAttached.replace('{n}', '2')),
    'neither picture is claimed as attached once one download failed',
  );
  assert.ok(userContent.includes(labels.transcript.image), 'both pictures render in their plain blind form');
});

test('createTurnRunner: when every picture downloads fine, all are kept as data: URLs in transcript order', async () => {
  const raw = rawMessage({
    id: 'm1',
    attachments: new Map([
      ['i1', { id: 'i1', contentType: 'image/png', name: 'one.png', url: 'https://cdn.discordapp.com/x/one.png' }],
      ['i2', { id: 'i2', contentType: 'image/png', name: 'two.png', url: 'https://cdn.discordapp.com/x/two.png' }],
    ]),
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok</msg>');
  const store = fakeStore();
  const hot = fakeHot({});
  const imageFetcher = fakeImageFetcher((url) => ({
    dataUrl: url.includes('one.png') ? 'data:image/png;base64,ONE' : 'data:image/png;base64,TWO',
    bytes: 3,
    contentType: 'image/png',
  }));
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), imageFetcher });

  const trigger = {
    ...normalizedTrigger(raw),
    attachments: [
      { id: 'i1', kind: 'image', url: 'https://cdn.discordapp.com/x/one.png', name: 'one.png' },
      { id: 'i2', kind: 'image', url: 'https://cdn.discordapp.com/x/two.png', name: 'two.png' },
    ],
  };

  const result = await turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  const userContent = llm.calls[0][1].content;
  const imageParts = userContent.filter((p) => p.type === 'image_url');
  assert.equal(imageParts.length, 2);
  assert.deepEqual(
    imageParts.map((p) => p.image_url.url),
    ['data:image/png;base64,ONE', 'data:image/png;base64,TWO'],
    'pictures are kept in the order they appear in the transcript',
  );
});

// ---------------------------------------------------------------------------
// features.dryRun -- the persona thinks and decides for real, but never
// touches the target channel; instead it logs, and optionally mirrors, what
// it would have done.

/** fakeStore whose guild keeps `pingsOff`, the members who turned the persona's notifications off. */
function storeWithPingsOff(pingsOff) {
  const store = fakeStore();
  store.pingsCalls = [];
  store.isPingsOff = (guildId, userId) => {
    store.pingsCalls.push([guildId, userId]);
    return pingsOff.includes(userId);
  };
  return store;
}

/** One reply turn in c1: Bob's older line, then Alice's trigger; the persona replies to the reply="#2" line. */
async function runPingsTurn(store, answer) {
  const bob = rawMessage({ id: 'm0', authorId: 'u2', authorName: 'Bob', ts: NOW - 5000, content: 'ola' });
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [bob, raw] });
  const turns = createTurnRunner({ hot: fakeHot(), store, llm: fakeLlm(answer), calibrator: identityCalibrator(), client: fakeClient() });
  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
  assert.equal(result.outcome, 'spoke');
  return channel;
}

test('runTurn: a reply to a member with pings off does not ping them; their mention stays in the text but notifies nobody', async () => {
  const store = storeWithPingsOff(['u1']);
  const channel = await runPingsTurn(store, '<msg reply="#2">@Alice @Bob ναι</msg>');

  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, '<@u1> <@u2> ναι', 'the text is never changed');
  assert.deepEqual(channel.sent[0].reply, { messageReference: 'm1', failIfNotExists: false });
  assert.deepEqual(channel.sent[0].allowedMentions, { parse: [], users: ['u2'], repliedUser: false });
  assert.ok(store.pingsCalls.every(([guildId]) => guildId === 'g1'));
});

test('runTurn: a mentioned member with pings off is left out of users while the replied author with pings on is still pinged', async () => {
  const channel = await runPingsTurn(storeWithPingsOff(['u2']), '<msg reply="#2">@Bob ναι</msg>');

  assert.equal(channel.sent[0].content, '<@u2> ναι');
  assert.deepEqual(channel.sent[0].allowedMentions, { parse: [], users: [], repliedUser: true });
});

test('runTurn: with nobody in pingsOff the reply and the mentions notify as before', async () => {
  const channel = await runPingsTurn(storeWithPingsOff([]), '<msg reply="#2">@Alice @Bob ναι</msg>');

  assert.deepEqual(channel.sent[0].reply, { messageReference: 'm1', failIfNotExists: false });
  assert.deepEqual(channel.sent[0].allowedMentions, { parse: [], users: ['u1', 'u2'], repliedUser: true });
});

test('createTurnRunner: features.dryRun=true sends and reacts nowhere, only logs, and paces itself as if it had spoken', async () => {
  const raw = rawMessage({ id: 'm1', authorName: 'Alice' });
  const channel = fakeTurnChannel({ id: 'c1', name: 'general', historyMessages: [raw] });
  const llm = fakeLlm('<msg reply="#1">Hello there</msg><react to="#1">\u{1F389}</react>');
  const store = fakeStore();
  const hot = fakeHot({ dryRun: true });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  const before = turns.lastPostAt('c1');
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }),
  );

  assert.equal(result.outcome, 'spoke');
  assert.equal(result.dryRun, true);
  assert.equal(channel.sent.length, 0);
  assert.equal(channel.typingCalls.length, 0);
  assert.equal(channel.reactCalls.length, 0);
  assert.ok(turns.lastPostAt('c1') > before, 'lastPostAt must advance as if the persona had actually spoken');

  const sendLine = logs.find((l) => l.msg === 'dry-run: would send');
  const reactLine = logs.find((l) => l.msg === 'dry-run: would react');
  assert.ok(sendLine, 'expected a "dry-run: would send" log line');
  assert.equal(sendLine.replyTo, 'm1');
  assert.equal(sendLine.text, 'Hello there');
  assert.ok(reactLine, 'expected a "dry-run: would react" log line');
  assert.equal(reactLine.to, 'm1');
  assert.equal(reactLine.emoji, '\u{1F389}');
});

test('createTurnRunner: features.dryRun=true mirrors each action into bot.dryRunChannelId, without real mentions', async () => {
  const raw = rawMessage({ id: 'm1', authorName: 'Alice' });
  const channel = fakeTurnChannel({ id: 'c1', name: 'general', historyMessages: [raw] });
  const llm = fakeLlm('<msg reply="#1">hi @Alice</msg>');
  const store = fakeStore();
  const hot = fakeHot({ dryRun: true }, { dryRunChannelId: 'mirror1' });
  const mirrorSent = [];
  const client = fakeClient({
    channels: {
      fetch: async (id) => {
        assert.equal(id, 'mirror1');
        return {
          send: async (payload) => {
            mirrorSent.push(payload);
            return { id: 'mirror-msg-1' };
          },
        };
      },
    },
  });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  assert.equal(mirrorSent.length, 1);
  assert.deepEqual(mirrorSent[0].allowedMentions, { parse: [] });
  const [, ...bodyLines] = mirrorSent[0].content.split('\n');
  assert.equal(bodyLines.join('\n'), 'hi @Alice');
  assert.ok(!mirrorSent[0].content.includes('<@'), 'a mirrored @name must never resolve to a real mention');
});

test('createTurnRunner: features.dryRun=true with no bot.dryRunChannelId configured mirrors nothing', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = fakeLlm('<msg>hello</msg>');
  const store = fakeStore();
  const hot = fakeHot({ dryRun: true });
  let fetchCalled = false;
  const client = fakeClient({ channels: { fetch: async () => { fetchCalled = true; return null; } } });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  assert.equal(fetchCalled, false, 'an empty dryRunChannelId must never be fetched');
});

test('createTurnRunner: features.dryRun=true swallows a mirror channel failure and still finishes the turn', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = fakeLlm('<msg>hello</msg>');
  const store = fakeStore();
  const hot = fakeHot({ dryRun: true }, { dryRunChannelId: 'mirror1' });
  const client = fakeClient({
    channels: {
      fetch: async () => {
        throw new Error('missing access');
      },
    },
  });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client });

  const { result } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }),
  );

  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent.length, 0);
});

test('createTurnRunner: features.dryRun=false sends for real even when bot.dryRunChannelId is set', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'c1', historyMessages: [raw] });
  const llm = fakeLlm('<msg>hello</msg>');
  const store = fakeStore();
  const hot = fakeHot({ dryRun: false }, { dryRunChannelId: 'mirror1' });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient() });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  assert.equal(result.dryRun, undefined);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, 'hello');
});

// ---------------------------------------------------------------------------
// The re-watch on a question (features.videoRewatch).

/** The pick alone, as maybeRewatch reads it. */
const parseRewatchPick = (raw, count) => parseRewatchPickDetailed(raw, count).pick;

test('parseRewatchPick: none (any case), garbage, an ordinal out of range or an empty question -> null', () => {
  for (const raw of ['none', 'NONE', '  None  ', '', '1', 'maybe the first one', '3 | what colour?', '0 | what?', '1 |   ', ' | what?', 'va | what?', '1.5 | what?', '-1 | what?', null]) {
    assert.equal(parseRewatchPick(raw, 2), null, String(raw));
  }
});

test('parseRewatchPick: <n> | <question> picks that ordinal; only the first line counts; the question is cut to 300 chars', () => {
  assert.deepEqual(parseRewatchPick('  2 |  τι χρώμα έχει;  \n1 | other', 2), {
    n: 2,
    question: 'τι χρώμα έχει;',
    retry: false,
  });
  const long = parseRewatchPick(`1 | ${'é'.repeat(400)}`, 2);
  assert.equal([...long.question].length, 300);
});

test('parseRewatchPick: #n and n. prefixes are tolerated', () => {
  for (const raw of ['#2 | τι χρώμα;', '2. | τι χρώμα;', '# 2 | τι χρώμα;', '#2. | τι χρώμα;']) {
    assert.deepEqual(parseRewatchPick(raw, 2), { n: 2, question: 'τι χρώμα;', retry: false }, raw);
  }
  assert.equal(parseRewatchPick('#3 | τι χρώμα;', 2), null);
});

test('parseRewatchPick: <n> | retry (any case) sets retry; anything longer is a question', () => {
  assert.deepEqual(parseRewatchPick('1 | retry', 1), { n: 1, question: 'retry', retry: true });
  assert.equal(parseRewatchPick('1 |  RETRY  ', 1).retry, true);
  assert.equal(parseRewatchPick('1 | Retry', 1).retry, true);
  assert.equal(parseRewatchPick('1 | retry it please', 1).retry, false);
  assert.equal(parseRewatchPick('1 | retry?', 1).retry, false);
});

test('parseRewatchPickDetailed: each null answer carries its reason code; a pick carries ok', () => {
  const cases = [
    ['none', 'none'],
    ['  NONE  \n1 | x', 'none'],
    ['', 'empty'],
    ['  \n \n', 'empty'],
    [null, 'empty'],
    ['maybe the first one', 'no-bar'],
    ['1', 'no-bar'],
    ['3 | what colour?', 'unknown-id'],
    ['0 | what colour?', 'unknown-id'],
    ['va | what colour?', 'unknown-id'],
    ['1234567890123456789 | what colour?', 'unknown-id'],
    [' | what?', 'unknown-id'],
    ['1 |   ', 'no-question'],
  ];
  for (const [raw, reason] of cases) {
    assert.deepEqual(parseRewatchPickDetailed(raw, 2), { pick: null, reason }, String(raw));
  }
  assert.deepEqual(parseRewatchPickDetailed('1 | τι χρώμα;', 2), {
    pick: { n: 1, question: 'τι χρώμα;', retry: false },
    reason: 'ok',
  });
  assert.deepEqual(parseRewatchPickDetailed('1 | retry', 2), { pick: { n: 1, question: 'retry', retry: true }, reason: 'ok' });
  assert.deepEqual(parseRewatchPickDetailed('1 | x', 0), { pick: null, reason: 'unknown-id' }, 'no candidates');
});

/** fakeVideoDescriber plus rewatchVideo, answering every call with `answer`. */
function fakeRewatchDescriber(statesById, answer = { question: 'q', text: 'κόκκινο' }) {
  const base = fakeVideoDescriber(statesById);
  const rewatchCalls = [];
  return {
    ...base,
    rewatchCalls,
    rewatchVideo: async (guildId, item, question) => {
      rewatchCalls.push({ guildId, item, question });
      return answer ? { ...answer, question } : null;
    },
  };
}

/** An llm fake routing the re-watch classifier (system = REWATCH_SYSTEM) apart from the turn itself. */
const REWATCH_SYSTEM = 'Pick the video the message to {{name}} asks about; {{name}} saw them.';
function rewatchLlm(classifierText, turnText = '<msg>ok</msg>') {
  const classifierCalls = [];
  const turnCalls = [];
  return {
    classifierCalls,
    turnCalls,
    complete: async (messages, options) => {
      if (messages[0].content.startsWith('Pick the video')) {
        classifierCalls.push({ messages, options });
        if (classifierText instanceof Error) throw classifierText;
        return { text: classifierText, usage: {}, estimated: 5 };
      }
      turnCalls.push({ messages, options });
      return { text: turnText, usage: {}, estimated: 10 };
    },
  };
}

function rewatchHot(features = {}, video = {}, config = {}) {
  const hot = fakeHot(
    { mediaDescriptions: true, videoDescriptions: true, vision: false, ...features },
    {},
    {
      classifier: { media: 'x/haiku' },
      media: {
        maxPerTurn: 6,
        filePreviewChars: 500,
        video: {
          maxPerTurn: 1,
          sites: ['youtube.com'],
          ...video,
          // The re-watch settings the tests below rely on; a test passing its own `rewatch` overrides single keys.
          rewatch: { recentMessages: 60, maxCandidates: 6, contextMessages: 50, classifierMaxOutputTokens: 120, ...video.rewatch },
        },
      },
      ...config,
    },
  );
  hot.config.llm.timeoutMs = 300_000;
  hot.config.llm.helperTimeoutMs = 25_000;
  hot.prompts.rewatch = REWATCH_SYSTEM;
  return hot;
}

/** A watched video message, then the trigger asking about it. */
function rewatchScene(triggerContent = 'τι χρώμα είναι το αυτοκίνητο;') {
  const video = videoAttachmentRaw('m1', NOW - 5000, 'va', 'clip.mp4');
  const trigger = rawMessage({ id: 'm2', ts: NOW - 1000, authorName: 'Zoë', content: triggerContent });
  return { video, trigger, channel: fakeTurnChannel({ historyMessages: [video, trigger] }) };
}

async function runRewatch({ hot = rewatchHot(), llm = rewatchLlm('1 | τι χρώμα;'), describer, scene = rewatchScene(), turn } = {}) {
  const d = describer ?? fakeRewatchDescriber({ va: { state: 'watched', text: 'ένα αυτοκίνητο περνά' } });
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), describer: d });
  await turns.runTurn(turn ?? { channel: scene.channel, mode: 'reply', trigger: normalizedTrigger(scene.trigger), triggerKind: 'mention' });
  return { describer: d, llm };
}

test('createTurnRunner: rewatch -- the classifier gets the watched videos and the trigger, then one second look fills videoAnswered', async () => {
  const { describer, llm } = await runRewatch();

  assert.equal(llm.classifierCalls.length, 1);
  const { messages, options } = llm.classifierCalls[0];
  assert.equal(messages[0].content, 'Pick the video the message to Bot asks about; Bot saw them.', '{{name}} is the persona\'s display name');
  const [transcriptPart, videosPart] = textOf(messages[1].content).split('\n<media>\n');
  assert.ok(transcriptPart.startsWith('<transcript>\n') && transcriptPart.endsWith('\n</transcript>'), 'the transcript comes first');
  assert.equal(
    `<media>\n${videosPart}`,
    '<media>\n1 | video | clip.mp4 | watched | ένα αυτοκίνητο περνά\n</media>\n<candidate>\nZoë: τι χρώμα είναι το αυτοκίνητο;\n</candidate>',
  );
  assert.equal(options.model, 'x/haiku', 'no text classifier model -> the media model');
  assert.equal(options.maxOutputTokens, 120);
  assert.equal(options.timeoutMs, 25_000, 'a helper: llm.helperTimeoutMs, not the reply timeout');
  assert.equal(options.countAgainstDailyCap, true);
  assert.equal(options.skipCalibration, true);
  assert.equal(options.purpose, 'rewatch');

  assert.equal(describer.rewatchCalls.length, 1);
  assert.equal(describer.rewatchCalls[0].item.itemId, 'va');
  assert.equal(describer.rewatchCalls[0].question, 'τι χρώμα;');
  const userMessage = textOf(llm.turnCalls[0].messages[1].content);
  const watched = fill(labels.transcript.videoWatched, { name: 'clip.mp4', duration: '0:20', text: 'ένα αυτοκίνητο περνά' });
  const answered = fill(labels.transcript.videoAnswered, { question: 'τι χρώμα;', text: 'κόκκινο' });
  assert.ok(userMessage.includes(`${watched} ${answered}`), 'the answer follows the watched tag');
});

test('createTurnRunner: rewatch -- the classifier model is classifierTextModel (classifier.text, then classifier.media); the deprecated keys and a stale rewatch.model are ignored', async () => {
  const withText = rewatchHot({}, { rewatch: { model: 'x/pick' } }, { classifier: { text: 'x/text' }, mention: { followUpModel: 'x/older' } });
  withText.config.llm.classifierModel = 'x/old';
  assert.equal((await runRewatch({ hot: withText })).llm.classifierCalls[0].options.model, 'x/text');
  const withOld = rewatchHot({}, { rewatch: { model: 'x/pick' } }, { mention: { followUpModel: 'x/older' } });
  withOld.config.llm.classifierModel = 'x/old';
  assert.equal((await runRewatch({ hot: withOld })).llm.classifierCalls[0].options.model, 'x/haiku', 'classifier.media, never a deprecated key');
  const withMedia = await runRewatch({ hot: rewatchHot({}, { rewatch: { model: 'x/pick' } }, { classifier: { media: 'x/vision' } }) });
  assert.equal(withMedia.llm.classifierCalls[0].options.model, 'x/vision');
  const staleMedia = rewatchHot({}, { rewatch: { model: 'x/pick' } }, { classifier: {} });
  staleMedia.config.media.model = 'x/old-media';
  const withNone = await runRewatch({ hot: staleMedia });
  assert.equal(withNone.llm.classifierCalls[0].options.model, undefined, 'the deprecated media.model is no fallback');
});

test('createTurnRunner: rewatch -- the classifier answer cap is media.video.rewatch.classifierMaxOutputTokens', async () => {
  const set = await runRewatch({ hot: rewatchHot({}, { rewatch: { classifierMaxOutputTokens: 90 } }) });
  assert.equal(set.llm.classifierCalls[0].options.maxOutputTokens, 90);
});

test('createTurnRunner: rewatch -- none, garbage, an unknown id or a classifier error stop without a second look', async () => {
  for (const reply of ['none', 'I think the first video', '2 | τι χρώμα;', new Error('boom')]) {
    const { describer, llm } = await runRewatch({ llm: rewatchLlm(reply) });
    assert.equal(llm.classifierCalls.length, 1);
    assert.equal(describer.rewatchCalls.length, 0, String(reply));
    assert.equal(llm.turnCalls.length, 1, 'the turn itself still runs');
    assert.ok(!textOf(llm.turnCalls[0].messages[1].content).includes('looked again'));
  }
});

test('createTurnRunner: rewatch -- never on a spontaneous turn (no trigger)', async () => {
  const scene = rewatchScene();
  const { describer, llm } = await runRewatch({ scene, turn: { channel: scene.channel, mode: 'interject' } });
  assert.equal(describer.videoCalls.length, 1, 'videos are still watched');
  assert.equal(llm.classifierCalls.length, 0);
  assert.equal(describer.rewatchCalls.length, 0);
});

test('createTurnRunner: rewatch -- no watched video in the last rewatch.recentMessages messages -> no classifier call', async () => {
  const outOfWindow = await runRewatch({ hot: rewatchHot({}, { rewatch: { recentMessages: 1 } }) });
  assert.equal(outOfWindow.llm.classifierCalls.length, 0);
  const notWatched = await runRewatch({ describer: fakeRewatchDescriber({ va: { state: 'limit', reason: 'length' } }) });
  assert.equal(notWatched.llm.classifierCalls.length, 0);
  assert.equal(notWatched.describer.rewatchCalls.length, 0);
});

test('createTurnRunner: rewatch -- features.videoRewatch false, video vision off, or no prompts.rewatch -> no classifier call', async () => {
  const noPrompt = rewatchHot();
  delete noPrompt.prompts.rewatch;
  for (const hot of [rewatchHot({ videoRewatch: false }), rewatchHot({ videoDescriptions: false }), noPrompt]) {
    const { describer, llm } = await runRewatch({ hot });
    assert.equal(llm.classifierCalls.length, 0);
    assert.equal(describer.rewatchCalls.length, 0);
  }
});

test('createTurnRunner: rewatch -- a second look that returns null leaves the video watched, without an answer', async () => {
  const describer = fakeRewatchDescriber({ va: { state: 'watched', text: 'ένα αυτοκίνητο περνά' } }, null);
  const { llm } = await runRewatch({ describer });
  assert.equal(describer.rewatchCalls.length, 1);
  const userMessage = textOf(llm.turnCalls[0].messages[1].content);
  assert.ok(userMessage.includes(fill(labels.transcript.videoWatched, { name: 'clip.mp4', duration: '0:20', text: 'ένα αυτοκίνητο περνά' })));
  assert.ok(!userMessage.includes('looked again'));
});

test('createTurnRunner: rewatch -- logs rewatch: classified with counts only, never the question', async () => {
  const { logs } = await withCapturedLogs(() => runRewatch());
  const line = logs.find((entry) => entry.msg === 'rewatch: classified' || JSON.stringify(entry).includes('rewatch: classified'));
  assert.ok(line);
  const all = JSON.stringify(logs);
  assert.ok(all.includes('"picked":true'));
  assert.ok(all.includes('"candidates":1'));
  assert.ok(!all.includes('τι χρώμα'));
});

test('createTurnRunner: rewatch -- the ordinal maps back to the candidate, 1 for the newest', async () => {
  const messages = [];
  const states = {};
  for (let i = 1; i <= 3; i += 1) {
    messages.push(videoAttachmentRaw(`m${i}`, NOW - 100_000 + i * 1000, `v${i}`, `clip${i}.mp4`));
    states[`v${i}`] = { state: 'watched', text: `scène ${i}` };
  }
  const trigger = rawMessage({ id: 'mt', ts: NOW - 1000, authorName: 'Zoë', content: 'τι χρώμα;' });
  const scene = { trigger, channel: fakeTurnChannel({ historyMessages: [...messages, trigger] }) };
  for (const [reply, itemId] of [['1 | τι χρώμα;', 'v3'], ['#2 | τι χρώμα;', 'v2'], ['3. | τι χρώμα;', 'v1']]) {
    const describer = fakeRewatchDescriber(states);
    await runRewatch({ scene, llm: rewatchLlm(reply), describer });
    assert.equal(describer.rewatchCalls.length, 1, reply);
    assert.equal(describer.rewatchCalls[0].item.itemId, itemId, reply);
  }
  const describer = fakeRewatchDescriber(states);
  const { logs } = await withCapturedLogs(() => runRewatch({ scene, llm: rewatchLlm('4 | τι χρώμα;'), describer }));
  assert.equal(describer.rewatchCalls.length, 0, 'an ordinal past the list picks nothing');
  assert.equal(logs.find((entry) => entry.msg === 'rewatch: classified').parse, 'unknown-id');
});

test('createTurnRunner: rewatch -- the <media> block lists at most maxCandidates watched videos, newest first', async () => {
  const messages = [];
  const states = {};
  for (let i = 1; i <= 7; i += 1) {
    messages.push(videoAttachmentRaw(`m${i}`, NOW - 100_000 + i * 1000, `v${i}`, `clip${i}.mp4`));
    states[`v${i}`] = { state: 'watched', text: `scène ${i}` };
  }
  const trigger = rawMessage({ id: 'mt', ts: NOW - 1000, authorName: 'Zoë', content: 'τι χρώμα;' });
  const scene = { trigger, channel: fakeTurnChannel({ historyMessages: [...messages, trigger] }) };
  const run = (hot) => runRewatch({ hot, scene, llm: rewatchLlm('none'), describer: fakeRewatchDescriber(states) });

  const { llm } = await run(rewatchHot());
  const block = llm.classifierCalls[0].messages[1].content.split('<media>\n')[1].split('\n</media>')[0].split('\n');
  assert.deepEqual(block, [7, 6, 5, 4, 3, 2].map((i, k) => `${k + 1} | video | clip${i}.mp4 | watched | scène ${i}`));

  const capped = await run(rewatchHot({}, { rewatch: { maxCandidates: 2 } }));
  const cappedBlock = capped.llm.classifierCalls[0].messages[1].content.split('<media>\n')[1].split('\n</media>')[0].split('\n');
  assert.deepEqual(cappedBlock, ['1 | video | clip7.mp4 | watched | scène 7', '2 | video | clip6.mp4 | watched | scène 6']);
});

/**
 * fakeRewatchDescriber whose describeVideos reports `newCount` fetch attempts
 * this turn (default none: every state came from the cache) and whose
 * describeVideo answers a forced retry with `retried`.
 */
function fakeRetryDescriber(statesById, retried = { state: 'watched', text: 'τώρα φορτώνει' }, { newCount = 0 } = {}) {
  const base = fakeRewatchDescriber(statesById);
  const retryCalls = [];
  return {
    ...base,
    retryCalls,
    describeVideos: async (guildId, items, options) => {
      const { videos } = await base.describeVideos(guildId, items, options);
      return { videos, newCount };
    },
    describeVideo: async (guildId, item, options) => {
      retryCalls.push({ guildId, item, options });
      return retried;
    },
  };
}

test('createTurnRunner: rewatch -- a video that did not load is offered as not loaded, with an empty account', async () => {
  const describer = fakeRetryDescriber({ va: { state: 'error' } });
  const { llm } = await runRewatch({ describer, llm: rewatchLlm('none') });
  assert.equal(llm.classifierCalls.length, 1);
  assert.ok(llm.classifierCalls[0].messages[1].content.startsWith('<transcript>\n'));
  assert.ok(
    llm.classifierCalls[0].messages[1].content.endsWith(
      '\n</transcript>\n<media>\n1 | video | clip.mp4 | not loaded |\n</media>\n<candidate>\nZoë: τι χρώμα είναι το αυτοκίνητο;\n</candidate>',
    ),
  );
  assert.equal(describer.retryCalls.length, 0);
});

test('createTurnRunner: rewatch -- <id> | retry on a video that did not load tries it once more, forced, and the transcript shows it watched', async () => {
  const describer = fakeRetryDescriber({ va: { state: 'error' } });
  const { result, logs } = await withCapturedLogs(() => runRewatch({ describer, llm: rewatchLlm('1 | retry') }));

  assert.equal(describer.retryCalls.length, 1);
  assert.equal(describer.retryCalls[0].item.itemId, 'va');
  assert.equal(describer.retryCalls[0].options.force, true);
  assert.equal(describer.rewatchCalls.length, 0, 'the retry is the one re-watch of this turn');
  const userMessage = textOf(result.llm.turnCalls[0].messages[1].content);
  assert.ok(userMessage.includes(fill(labels.transcript.videoWatched, { name: 'clip.mp4', duration: '0:20', text: 'τώρα φορτώνει' })));
  assert.ok(!userMessage.includes('not watched'));
  const line = logs.find((entry) => entry.msg === 'rewatch: classified');
  assert.equal(line.picked, true);
  assert.ok(!JSON.stringify(logs).includes('τώρα φορτώνει'));
});

test('createTurnRunner: rewatch -- a retry that fails again replaces the state with the new one', async () => {
  const describer = fakeRetryDescriber({ va: { state: 'error' } }, { state: 'limit', reason: 'size' });
  const { llm } = await runRewatch({ describer, llm: rewatchLlm('1 | retry') });
  assert.equal(describer.retryCalls.length, 1);
  const userMessage = textOf(llm.turnCalls[0].messages[1].content);
  const reason = labels.transcript.videoReason.size;
  assert.ok(userMessage.includes(fill(labels.transcript.videoNotWatched, { name: 'clip.mp4', duration: '0:20', reason })));
});

test('createTurnRunner: rewatch -- retry on a watched video, or a question on one that did not load, does nothing', async () => {
  const cases = [
    { states: { va: { state: 'watched', text: 'ένα αυτοκίνητο περνά' } }, reply: '1 | retry' },
    { states: { va: { state: 'error' } }, reply: '1 | τι χρώμα;' },
  ];
  for (const { states, reply } of cases) {
    const describer = fakeRetryDescriber(states);
    const { logs } = await withCapturedLogs(() => runRewatch({ describer, llm: rewatchLlm(reply) }));
    assert.equal(describer.retryCalls.length, 0, reply);
    assert.equal(describer.rewatchCalls.length, 0, reply);
    const line = logs.find((entry) => entry.msg === 'rewatch: classified');
    assert.equal(line.picked, false, reply);
  }
});

test('createTurnRunner: rewatch -- maxCandidates counts watched and not-loaded videos together, newest first', async () => {
  const messages = [];
  const states = {};
  for (let i = 1; i <= 4; i += 1) {
    messages.push(videoAttachmentRaw(`m${i}`, NOW - 100_000 + i * 1000, `v${i}`, `clip${i}.mp4`));
    states[`v${i}`] = i % 2 === 0 ? { state: 'error' } : { state: 'watched', text: `scène ${i}` };
  }
  const trigger = rawMessage({ id: 'mt', ts: NOW - 1000, authorName: 'Zoë', content: 'και τώρα;' });
  const scene = { trigger, channel: fakeTurnChannel({ historyMessages: [...messages, trigger] }) };
  const { llm } = await runRewatch({
    hot: rewatchHot({}, { rewatch: { maxCandidates: 3 } }),
    scene,
    llm: rewatchLlm('none'),
    describer: fakeRetryDescriber(states),
  });
  const block = llm.classifierCalls[0].messages[1].content.split('<media>\n')[1].split('\n</media>')[0].split('\n');
  assert.deepEqual(block, ['1 | video | clip4.mp4 | not loaded |', '2 | video | clip3.mp4 | watched | scène 3', '3 | video | clip2.mp4 | not loaded |']);
});

test('createTurnRunner: rewatch -- a video that did not load is still offered and retried after this turn spent media.video.maxPerTurn attempts', async () => {
  const describer = fakeRetryDescriber({ va: { state: 'error' } }, undefined, { newCount: 1 });
  const { result, logs } = await withCapturedLogs(() => runRewatch({ describer, llm: rewatchLlm('1 | retry') }));
  assert.ok(result.llm.classifierCalls[0].messages[1].content.includes('1 | video | clip.mp4 | not loaded |'), 'still offered');
  assert.equal(describer.retryCalls.length, 1);
  assert.equal(describer.retryCalls[0].options.force, true);
  assert.ok(!logs.some((entry) => entry.msg === 'rewatch: skipped'));
  const line = logs.find((entry) => entry.msg === 'rewatch: classified');
  assert.equal(line.retryAllowed, true);
  assert.equal(line.picked, true);
});

/** A video, `fillers` chat lines (every third one the persona's own), then the trigger. */
function rewatchContextScene(fillers) {
  const video = videoAttachmentRaw('m0', NOW - 100_000, 'va', 'clip.mp4');
  const between = Array.from({ length: fillers }, (_, i) =>
    i % 3 === 1
      ? rawMessage({ id: `f${i}`, ts: NOW - 90_000 + i * 1000, authorId: 'self-id', authorName: 'Bot', content: `ligne ${i}` })
      : rawMessage({ id: `f${i}`, ts: NOW - 90_000 + i * 1000, authorName: 'Zoë', content: `ligne ${i}` }),
  );
  const trigger = rawMessage({ id: 'mt', ts: NOW - 1000, authorName: 'Zoë', content: 'τι χρώμα έχει;' });
  return { trigger, channel: fakeTurnChannel({ historyMessages: [video, ...between, trigger] }) };
}

/** The lines between <transcript> and </transcript>, or null when the block is absent. */
function rewatchTranscriptLines(content) {
  if (!content.startsWith('<transcript>\n')) return null;
  return content.slice('<transcript>\n'.length, content.indexOf('\n</transcript>\n<media>\n')).split('\n');
}

test('createTurnRunner: rewatch -- the <transcript> block holds the last contextMessages before the trigger, the persona marked, the trigger only in <candidate>', async () => {
  const { llm } = await runRewatch({
    hot: rewatchHot({}, { rewatch: { contextMessages: 3 } }),
    scene: rewatchContextScene(10),
    llm: rewatchLlm('none'),
  });
  const content = llm.classifierCalls[0].messages[1].content;
  const items = rewatchTranscriptLines(content).slice(1);
  assert.equal(items.length, 3);
  const self = fill(labels.self, { name: 'Bot' });
  assert.match(items[0], /^#1 \[\d\d:\d\d\] /);
  assert.ok(items[0].endsWith(`] ${self}: ligne 7`), 'the persona\'s own line is marked');
  assert.match(items[1], /^#2 \[\d\d:\d\d\] Zoë: ligne 8$/);
  assert.match(items[2], /^#3 \[\d\d:\d\d\] Zoë: ligne 9$/);
  assert.equal(content.split('τι χρώμα έχει;').length, 2, 'the trigger appears once');
  assert.ok(content.endsWith('<candidate>\nZoë: τι χρώμα έχει;\n</candidate>'));
});

test('createTurnRunner: rewatch -- contextMessages 0 omits the <transcript> block', async () => {
  const { llm } = await runRewatch({
    hot: rewatchHot({}, { rewatch: { contextMessages: 0 } }),
    scene: rewatchContextScene(4),
    llm: rewatchLlm('none'),
  });
  const content = llm.classifierCalls[0].messages[1].content;
  assert.ok(!content.includes('<transcript>'));
  assert.ok(content.startsWith('<media>\n1 | video | clip.mp4 | watched |'));
});

test('createTurnRunner: rewatch -- a video that did not load renders its not-watched tag inside the <transcript> block', async () => {
  const describer = fakeRetryDescriber({ va: { state: 'error' } });
  const { llm } = await runRewatch({ describer, llm: rewatchLlm('none') });
  const items = rewatchTranscriptLines(llm.classifierCalls[0].messages[1].content).slice(1);
  assert.equal(items.length, 1, 'the video message only; the trigger stays in <candidate>');
  const tag = fill(labels.transcript.videoNotWatched, { name: 'clip.mp4', duration: '0:20', reason: labels.transcript.videoReason.error });
  assert.ok(items[0].endsWith(`Alice: hey bot ${tag}`), items[0]);
});

// The second look at a picture on a question (features.imageRelook).

/** A raw message carrying one attached picture. */
function pictureRaw(id, ts, attachmentId, name, author = {}) {
  return rawMessage({
    id,
    ts,
    ...author,
    attachments: new Map([[attachmentId, { id: attachmentId, contentType: 'image/png', name, url: `https://cdn.discordapp.com/attachments/1/2/${name}` }]]),
  });
}

/**
 * fakeRetryDescriber plus captions (`captions`, served by describeMany and cachedDescriptions)
 * and relookImage, answering every call with `answer`.
 */
function fakeRelookDescriber(statesById = {}, captions = {}, answer = 'pas de chargeur, un reflet de la fenêtre') {
  const base = fakeRetryDescriber(statesById);
  const relookCalls = [];
  const captionsOf = (items) => new Map(items.filter((item) => captions[item.itemId]).map((item) => [item.itemId, captions[item.itemId]]));
  return {
    ...base,
    describeMany: async (guildId, items) => ({ descriptions: captionsOf(items), newCount: 0 }),
    cachedDescriptions: (guildId, items) => captionsOf(items),
    relookCalls,
    relookImage: async (guildId, item, question) => {
      relookCalls.push({ guildId, item, question });
      return answer ? { question, text: answer } : null;
    },
  };
}

/** A picture by Alice, then the trigger making a claim about it. */
function relookScene(history = [pictureRaw('m1', NOW - 5000, 'pa', 'singes.png')]) {
  const trigger = rawMessage({ id: 'mt', ts: NOW - 1000, authorName: 'Zoë', content: 'il y a un chargeur dans sa pupille' });
  return { trigger, channel: fakeTurnChannel({ historyMessages: [...history, trigger] }) };
}

async function runRelook({
  hot = rewatchHot({ vision: true }),
  llm = rewatchLlm('1 | y a-t-il un chargeur dans la pupille ?'),
  describer = fakeRelookDescriber({}, { pa: 'deux singes sur une branche' }),
  scene = relookScene(),
} = {}) {
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), describer, imageFetcher: fakeImageFetcher() });
  await turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: normalizedTrigger(scene.trigger), triggerKind: 'mention' });
  return { describer, llm };
}

/** The lines of the `<media>` block of the first classifier call. */
function mediaLines(llm) {
  return llm.classifierCalls[0].messages[1].content.split('<media>\n')[1].split('\n</media>')[0].split('\n');
}

test('createTurnRunner: relook -- a claimed detail of a recent picture picks it; the request carries imageAnswered with the answer', async () => {
  const { describer, llm } = await runRelook();

  assert.equal(llm.classifierCalls.length, 1);
  assert.deepEqual(mediaLines(llm), ['1 | picture | singes.png | described | deux singes sur une branche']);
  assert.equal(describer.relookCalls.length, 1);
  assert.equal(describer.relookCalls[0].guildId, 'g1');
  assert.equal(describer.relookCalls[0].item.itemId, 'pa');
  assert.equal(describer.relookCalls[0].question, 'y a-t-il un chargeur dans la pupille ?');
  assert.equal(describer.rewatchCalls.length, 0);
  const userMessage = textOf(llm.turnCalls[0].messages[1].content);
  const tag = fill(labels.transcript.imageAnswered, { question: 'y a-t-il un chargeur dans la pupille ?', text: 'pas de chargeur, un reflet de la fenêtre' });
  assert.ok(userMessage.includes(`${fill(labels.transcript.imageDescribed, { text: 'deux singes sur une branche' })} ${tag}`), 'the answer sits right after the picture tag');
});

test('createTurnRunner: relook -- the persona\'s own posted picture is a candidate', async () => {
  const own = pictureRaw('m1', NOW - 5000, 'pa', 'image.png', { authorId: 'self-id', authorName: 'Bot' });
  const { describer, llm } = await runRelook({ scene: relookScene([own]) });
  assert.deepEqual(mediaLines(llm), ['1 | picture | image.png | described | deux singes sur une branche']);
  assert.equal(describer.relookCalls.length, 1);
  assert.equal(describer.relookCalls[0].item.itemId, 'pa');
});

test('createTurnRunner: relook -- with the second-look counter spent no picture is offered and the classifier is not asked', async () => {
  const describer = fakeRelookDescriber({}, { pa: 'deux singes sur une branche' });
  describer.videoCapsLeft = () => ({ video: 5, rewatch: 0 });
  const { result } = await withCapturedLogs(() => runRelook({ describer }));
  assert.equal(result.llm.classifierCalls.length, 0);
  assert.equal(describer.relookCalls.length, 0);

  // Nothing a retry could serve either: the classifier is skipped as capped.
  delete describer.describeVideo;
  const capped = await withCapturedLogs(() => runRelook({ describer }));
  assert.equal(capped.result.llm.classifierCalls.length, 0);
  assert.equal(describer.relookCalls.length, 0);
  assert.ok(capped.logs.some((entry) => entry.msg === 'rewatch: skipped' && entry.reason === 'cap'));
});

test('createTurnRunner: relook -- imageRelook or vision off removes the pictures; the videos keep their second look', async () => {
  const video = videoAttachmentRaw('m1', NOW - 9000, 'va', 'clip.mp4');
  const picture = pictureRaw('m2', NOW - 5000, 'pa', 'singes.png');
  const states = { va: { state: 'watched', text: 'ένα αυτοκίνητο περνά' } };
  const run = (hot) =>
    runRelook({ hot, scene: relookScene([video, picture]), llm: rewatchLlm('1 | τι χρώμα;'), describer: fakeRelookDescriber(states, { pa: 'deux singes' }) });

  const on = await run(rewatchHot({ vision: true, imageRelook: true }));
  assert.deepEqual(mediaLines(on.llm), ['1 | video | clip.mp4 | watched | ένα αυτοκίνητο περνά', '2 | picture | singes.png | described | deux singes']);

  for (const hot of [rewatchHot({ vision: true, imageRelook: false }), rewatchHot({ vision: false, imageRelook: true })]) {
    const { describer, llm } = await run(hot);
    assert.deepEqual(mediaLines(llm), ['1 | video | clip.mp4 | watched | ένα αυτοκίνητο περνά']);
    assert.equal(describer.rewatchCalls.length, 1);
    assert.equal(describer.rewatchCalls[0].item.itemId, 'va');
    assert.equal(describer.relookCalls.length, 0);
    assert.ok(textOf(llm.turnCalls[0].messages[1].content).includes(fill(labels.transcript.videoAnswered, { question: 'τι χρώμα;', text: 'κόκκινο' })));
  }
});

test('createTurnRunner: relook -- with video vision off the pictures are still offered', async () => {
  const { describer, llm } = await runRelook({ hot: rewatchHot({ vision: true, videoDescriptions: false }) });
  assert.deepEqual(mediaLines(llm), ['1 | picture | singes.png | described | deux singes sur une branche']);
  assert.equal(describer.relookCalls.length, 1);
});

test('createTurnRunner: relook -- retry never applies to a picture', async () => {
  const describer = fakeRelookDescriber({}, { pa: 'deux singes sur une branche' });
  const { result, logs } = await withCapturedLogs(() => runRelook({ describer, llm: rewatchLlm('1 | retry') }));
  assert.equal(result.llm.classifierCalls.length, 1);
  assert.equal(describer.relookCalls.length, 0);
  assert.equal(describer.retryCalls.length, 0);
  const line = logs.find((entry) => entry.msg === 'rewatch: classified');
  assert.equal(line.target, 'picture');
  assert.equal(line.kind, 'retry');
  assert.equal(line.picked, false);
});

test('createTurnRunner: relook -- maxCandidates caps the merged list: the videos first, then the pictures, each newest first', async () => {
  const history = [
    pictureRaw('m1', NOW - 50_000, 'p1', 'one.png'),
    videoAttachmentRaw('m2', NOW - 40_000, 'v1', 'clip1.mp4'),
    pictureRaw('m3', NOW - 30_000, 'p2', 'two.png'),
    videoAttachmentRaw('m4', NOW - 20_000, 'v2', 'clip2.mp4'),
  ];
  const states = { v1: { state: 'watched', text: 'scène 1' }, v2: { state: 'watched', text: 'scène 2' } };
  const describer = fakeRelookDescriber(states, {});
  const { llm } = await runRelook({
    hot: rewatchHot({ vision: true }, { rewatch: { maxCandidates: 3 } }),
    scene: relookScene(history),
    llm: rewatchLlm('3 | combien de singes ?'),
    describer,
  });
  assert.deepEqual(mediaLines(llm), ['1 | video | clip2.mp4 | watched | scène 2', '2 | video | clip1.mp4 | watched | scène 1', '3 | picture | two.png | described |']);
  assert.equal(describer.relookCalls.length, 1);
  assert.equal(describer.relookCalls[0].item.itemId, 'p2');
});

// The second look at a watched GIF (features.videoRewatch): listed as a video.

/** A raw message carrying one tenor gifv embed (item id `<id>#e0`, named after its site). */
function gifEmbedRaw(id, ts) {
  return linkRaw(
    id,
    ts,
    [
      {
        type: 'gifv',
        url: 'https://tenor.com/view/miroir-1',
        provider: { name: 'Tenor' },
        thumbnail: { url: 'https://media.tenor.com/x/still.png' },
        video: { url: 'https://media.tenor.com/x/loop.mp4' },
      },
    ],
    '',
  );
}

/**
 * fakeRelookDescriber plus watchedGifs (the ids of `watched` with their caption; none with
 * media.gif.watch false, as the real describer's) and rewatchGif, answering with `answer`.
 */
function fakeGifRewatchDescriber(hot, { states = {}, watched = {}, answer = 'une autre femme dans le miroir' } = {}) {
  const base = fakeRelookDescriber(states, {});
  const gifRewatchCalls = [];
  return {
    ...base,
    watchedGifs: (guildId, items) =>
      hot.config.media?.gif?.watch === false
        ? new Map()
        : new Map(items.filter((item) => item.kind === 'gif' && watched[item.itemId]).map((item) => [item.itemId, watched[item.itemId]])),
    gifRewatchCalls,
    rewatchGif: async (guildId, item, question) => {
      gifRewatchCalls.push({ guildId, item, question });
      return answer ? { question, text: answer } : null;
    },
  };
}

function gifRewatchScene(history = [gifEmbedRaw('m1', NOW - 5000)]) {
  const trigger = rawMessage({ id: 'mt', ts: NOW - 1000, authorName: 'Zoë', content: 'à la fin le miroir montre une autre personne' });
  return { trigger, channel: fakeTurnChannel({ historyMessages: [...history, trigger] }) };
}

async function runGifRewatch({ hot = rewatchHot(), llm = rewatchLlm('1 | qui est dans le miroir à la fin ?'), describer, scene = gifRewatchScene() } = {}) {
  const d = describer ?? fakeGifRewatchDescriber(hot, { watched: { 'm1#e0': 'une femme se regarde dans un miroir' } });
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), describer: d, imageFetcher: fakeImageFetcher() });
  await turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: normalizedTrigger(scene.trigger), triggerKind: 'mention' });
  return { describer: d, llm };
}

test('createTurnRunner: rewatch -- a watched GIF is offered as a watched video and a pick re-watches it; the answer reaches the request', async () => {
  const { result, logs } = await withCapturedLogs(() => runGifRewatch());
  const { describer, llm } = result;

  assert.equal(llm.classifierCalls.length, 1);
  assert.deepEqual(mediaLines(llm), ['1 | video | Tenor | watched | une femme se regarde dans un miroir']);
  assert.equal(describer.gifRewatchCalls.length, 1);
  assert.equal(describer.gifRewatchCalls[0].guildId, 'g1');
  assert.equal(describer.gifRewatchCalls[0].item.itemId, 'm1#e0');
  assert.equal(describer.gifRewatchCalls[0].question, 'qui est dans le miroir à la fin ?');
  assert.equal(describer.rewatchCalls.length, 0);
  assert.equal(describer.relookCalls.length, 0);
  const line = logs.find((entry) => entry.msg === 'rewatch: classified');
  assert.deepEqual(line.offered, { watched: 0, notLoaded: 0, gifs: 1, pictures: 0 });
  assert.equal(line.target, 'gif');
  assert.equal(line.picked, true);
  assert.ok(!JSON.stringify(logs).includes('miroir'), 'never the question or the caption');
  const tag = fill(labels.transcript.videoAnswered, { question: 'qui est dans le miroir à la fin ?', text: 'une autre femme dans le miroir' });
  assert.ok(textOf(llm.turnCalls[0].messages[1].content).includes(tag), 'the answer sits in the transcript as a video answer');
});

test('createTurnRunner: rewatch -- a GIF that was not watched, GIF watching off or videoRewatch off offers no GIF', async () => {
  const notWatched = rewatchHot();
  const off = rewatchHot();
  off.config.media.gif = { watch: false };
  const cases = [
    [notWatched, (hot) => fakeGifRewatchDescriber(hot, { watched: {} })],
    [off, (hot) => fakeGifRewatchDescriber(hot, { watched: { 'm1#e0': 'une femme' } })],
    [rewatchHot({ videoRewatch: false }), (hot) => fakeGifRewatchDescriber(hot, { watched: { 'm1#e0': 'une femme' } })],
  ];
  for (const [hot, make] of cases) {
    const describer = make(hot);
    const { result, logs } = await withCapturedLogs(() => runGifRewatch({ hot, describer }));
    assert.equal(result.llm.classifierCalls.length, 0);
    assert.equal(describer.gifRewatchCalls.length, 0);
    assert.ok(!logs.some((entry) => entry.msg === 'rewatch: classified'));
  }
});

test('createTurnRunner: rewatch -- a retry on a GIF does nothing; a spent GIF watch counter keeps the GIF off the list', async () => {
  const retry = await withCapturedLogs(() => runGifRewatch({ llm: rewatchLlm('1 | retry') }));
  assert.equal(retry.result.describer.gifRewatchCalls.length, 0);
  assert.equal(retry.logs.find((entry) => entry.msg === 'rewatch: classified').picked, false);

  const hot = rewatchHot();
  const describer = fakeGifRewatchDescriber(hot, { watched: { 'm1#e0': 'une femme' } });
  describer.videoCapsLeft = () => ({ video: 5, rewatch: 5, gif: 0 });
  delete describer.describeVideo;
  const capped = await withCapturedLogs(() => runGifRewatch({ hot, describer }));
  assert.equal(capped.result.llm.classifierCalls.length, 0);
  assert.equal(describer.gifRewatchCalls.length, 0);
});

test('createTurnRunner: rewatch -- a watched video and a watched GIF: the video first, a pick of the video re-watches only the video', async () => {
  const hot = rewatchHot();
  const describer = fakeGifRewatchDescriber(hot, {
    states: { va: { state: 'watched', text: 'ένα αυτοκίνητο περνά' } },
    watched: { 'm2#e0': 'une femme se regarde dans un miroir' },
  });
  const scene = gifRewatchScene([videoAttachmentRaw('m1', NOW - 9000, 'va', 'clip.mp4'), gifEmbedRaw('m2', NOW - 5000)]);
  const { llm } = await runGifRewatch({ hot, describer, scene, llm: rewatchLlm('1 | τι χρώμα;') });
  assert.deepEqual(mediaLines(llm), ['1 | video | clip.mp4 | watched | ένα αυτοκίνητο περνά', '2 | video | Tenor | watched | une femme se regarde dans un miroir']);
  assert.equal(describer.rewatchCalls.length, 1);
  assert.equal(describer.rewatchCalls[0].item.itemId, 'va');
  assert.equal(describer.gifRewatchCalls.length, 0);
  assert.ok(textOf(llm.turnCalls[0].messages[1].content).includes(fill(labels.transcript.videoAnswered, { question: 'τι χρώμα;', text: 'κόκκινο' })));
});

// ---------------------------------------------------------------------------
// The web lookup: read links and the search on a question.

/** A raw message carrying link embeds. */
function linkRaw(id, ts, embeds, content = 'κοίτα αυτό') {
  return { ...rawMessage({ id, ts, content }), embeds };
}

const PAGE_EMBED = { url: 'https://example.org/a', title: 'Crêpes', description: null, provider: null, thumbnail: null };

/** A fake createLookup()-shaped dependency. */
function fakeLookup({ reads = {}, searchResult = { query: 'q', text: 'ευρήματα', sources: [{ title: 'Un', url: 'https://www.example.com/1', site: 'example.com' }] }, hasKey = true } = {}) {
  const readCalls = [];
  const searchCalls = [];
  return {
    readCalls,
    searchCalls,
    readLinks: async (guildId, links, options) => {
      readCalls.push({ guildId, links, options });
      const map = new Map();
      for (const link of links) if (reads[link.id]) map.set(link.id, reads[link.id]);
      return { reads: map, newCount: map.size };
    },
    search: async (guildId, query) => {
      searchCalls.push({ guildId, query });
      return searchResult ? { ...searchResult, query } : null;
    },
    hasSearch: () => hasKey,
  };
}

const LOOKUP_SYSTEM = 'Decide whether {{name}} needs to look something up.';
/** An llm fake routing the search classifier (system starts with "Decide whether") apart from the turn. */
function lookupLlm(classifierText = 'none', turnText = '<msg>ok</msg>') {
  const classifierCalls = [];
  const turnCalls = [];
  return {
    classifierCalls,
    turnCalls,
    complete: async (messages, options) => {
      if (messages[0].content.startsWith('Decide whether')) {
        classifierCalls.push({ messages, options });
        if (classifierText instanceof Error) throw classifierText;
        return { text: classifierText, usage: {}, estimated: 5 };
      }
      turnCalls.push({ messages, options });
      return { text: turnText, usage: {}, estimated: 10 };
    },
  };
}

function lookupHot(features = {}, web = {}, config = {}) {
  const hot = fakeHot(
    { webLookup: true, vision: false, ...features },
    {},
    {
      classifier: { text: 'x/text' },
      media: { maxPerTurn: 6, filePreviewChars: 500, video: { sites: ['youtube.com'] } },
      web: {
        maxPerDay: 60,
        links: { enabled: true, maxPerTurn: 2, ...web.links },
        search: { enabled: true, maxPerTurn: 1, contextMessages: 50, ...web.search },
      },
      ...config,
    },
  );
  hot.config.llm.timeoutMs = 300_000;
  hot.config.llm.helperTimeoutMs = 25_000;
  hot.prompts.lookup = LOOKUP_SYSTEM;
  return hot;
}

async function runLookupTurn({ hot = lookupHot(), llm = lookupLlm(), lookup = fakeLookup(), history, trigger = true, now } = {}) {
  const messages = history ?? [
    linkRaw('m1', NOW - 5000, [
      PAGE_EMBED,
      { url: 'https://www.youtube.com/watch?v=abc', title: 'v', provider: { name: 'YouTube' } },
      { url: 'https://tenor.com/view/x', provider: { name: 'Tenor' } },
    ]),
    rawMessage({ id: 'm2', ts: NOW - 1000, authorName: 'Zoë', content: 'ποιος κέρδισε τον τελικό;' }),
  ];
  const channel = fakeTurnChannel({ historyMessages: messages });
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), lookup, ...(now ? { now } : {}) });
  const last = messages[messages.length - 1];
  const turn = trigger
    ? { channel, mode: 'reply', trigger: normalizedTrigger(last), triggerKind: 'mention' }
    : { channel, mode: 'interject' };
  const result = await turns.runTurn(turn);
  return { result, llm, lookup };
}

test('createTurnRunner: lookup -- readable links (no video site, no gif) go to readLinks newest first; reads reach the transcript', async () => {
  const lookup = fakeLookup({ reads: { 'm1#e0': 'une recette, trois œufs' } });
  const { llm } = await runLookupTurn({ lookup });

  assert.equal(lookup.readCalls.length, 1);
  const { guildId, links, options } = lookup.readCalls[0];
  assert.equal(guildId, 'g1');
  assert.deepEqual(links.map((l) => l.id), ['m1#e0']);
  assert.equal(links[0].url, 'https://example.org/a');
  assert.equal(options.maxNew, 2);
  const userMessage = textOf(llm.turnCalls[0].messages[1].content);
  assert.ok(userMessage.includes('[link: example.org — Crêpes] [page read: une recette, trois œufs]'), userMessage);
});

test('createTurnRunner: lookup -- links are offered newest message first', async () => {
  const lookup = fakeLookup();
  const history = [
    linkRaw('m1', NOW - 9000, [PAGE_EMBED]),
    linkRaw('m2', NOW - 5000, [{ ...PAGE_EMBED, url: 'https://example.org/b', title: 'B' }]),
    rawMessage({ id: 'm3', ts: NOW - 1000, content: 'λοιπόν;' }),
  ];
  await runLookupTurn({ lookup, history });
  assert.deepEqual(lookup.readCalls[0].links.map((l) => l.id), ['m2#e0', 'm1#e0']);
});

test('createTurnRunner: lookup -- the classifier gets the transcript and the candidate; a query becomes a <lookup> block', async () => {
  const llm = lookupLlm('champions final winner 2026');
  const lookup = fakeLookup({ reads: { 'm1#e0': 'une recette' } });
  await runLookupTurn({ llm, lookup });

  assert.equal(llm.classifierCalls.length, 1);
  const { messages, options } = llm.classifierCalls[0];
  assert.equal(messages[0].content, 'Decide whether Bot needs to look something up.');
  const user = textOf(messages[1].content);
  assert.ok(user.startsWith('<transcript>\n'));
  assert.ok(user.includes('[page read: une recette]'), 'the classifier transcript carries the reads');
  assert.ok(user.endsWith('</transcript>\n<candidate>\nZoë: ποιος κέρδισε τον τελικό;\n</candidate>'), user);
  assert.ok(!user.split('<candidate>')[0].includes('ποιος κέρδισε'), 'the trigger only in <candidate>');
  assert.equal(options.model, 'x/text');
  assert.equal(options.timeoutMs, 25_000, 'a helper: llm.helperTimeoutMs, not the reply timeout');
  assert.equal(options.skipCalibration, true);
  assert.equal(options.countAgainstDailyCap, true);
  assert.equal(options.purpose, 'lookup');

  assert.deepEqual(lookup.searchCalls, [{ guildId: 'g1', query: 'champions final winner 2026' }]);
  const turnUser = textOf(llm.turnCalls[0].messages[1].content);
  const block = [
    fill(labels.lookup.header, { query: 'champions final winner 2026' }),
    'ευρήματα',
    fill(labels.lookup.sources, { list: 'example.com' }),
  ].join('\n');
  assert.ok(turnUser.includes(`<lookup>\n${block}\n</lookup>`), turnUser);
});

test('createTurnRunner: lookup -- the classifier answer cap is web.search.classifierMaxOutputTokens', async () => {
  const set = await runLookupTurn({ hot: lookupHot({}, { search: { classifierMaxOutputTokens: 45 } }), llm: lookupLlm('none') });
  assert.equal(set.llm.classifierCalls[0].options.maxOutputTokens, 45);
});

test('createTurnRunner: lookup -- {{today}} in the classifier prompt is the injected clock\'s date in bot.timezone, {{name}} still filled', async () => {
  const hot = lookupHot();
  hot.prompts.lookup = 'Decide whether {{name}} needs to look something up. Today is {{today}}; {{name}} again.';
  const llm = lookupLlm('none');
  // 23:30 UTC on the last day of the year is already New Year's Day in Tokyo (UTC+9),
  // the zone the answer's `when:` range is read in.
  hot.config.bot.timezone = 'Asia/Tokyo';
  await runLookupTurn({ hot, llm, now: () => Date.UTC(2031, 11, 31, 23, 30, 0) });
  assert.equal(llm.classifierCalls[0].messages[0].content, 'Decide whether Bot needs to look something up. Today is 2032-01-01; Bot again.');
});

test('createTurnRunner: lookup -- a classifier prompt without {{today}} passes through unchanged apart from {{name}}', async () => {
  const hot = lookupHot();
  hot.prompts.lookup = 'Decide whether {{name}} should search; keep {{other}} as it is.';
  const llm = lookupLlm('none');
  await runLookupTurn({ hot, llm, now: () => Date.UTC(2031, 0, 2, 3, 4, 5) });
  assert.equal(llm.classifierCalls[0].messages[0].content, 'Decide whether Bot should search; keep {{other}} as it is.');
});

test('createTurnRunner: lookup -- contextMessages 0 omits the <transcript> block', async () => {
  const llm = lookupLlm('none');
  await runLookupTurn({ llm, hot: lookupHot({}, { search: { contextMessages: 0 } }) });
  assert.equal(llm.classifierCalls[0].messages[1].content, '<candidate>\nZoë: ποιος κέρδισε τον τελικό;\n</candidate>');
});

test('createTurnRunner: lookup -- none, an empty answer or a classifier error -> no search, no <lookup> block', async () => {
  for (const answer of ['none', '', new Error('boom')]) {
    const lookup = fakeLookup();
    const { llm, result } = await runLookupTurn({ llm: lookupLlm(answer), lookup });
    assert.equal(result.outcome, 'spoke');
    assert.equal(lookup.searchCalls.length, 0);
    assert.ok(!textOf(llm.turnCalls[0].messages[1].content).includes('\n<lookup>\n'));
  }
});

test('createTurnRunner: lookup -- a search returning null leaves no <lookup> block', async () => {
  const lookup = fakeLookup({ searchResult: null });
  const { llm } = await runLookupTurn({ llm: lookupLlm('x y'), lookup });
  assert.equal(lookup.searchCalls.length, 1);
  assert.ok(!textOf(llm.turnCalls[0].messages[1].content).includes('\n<lookup>\n'));
});

test('createTurnRunner: lookup -- only on a direct address: a spontaneous turn reads links but never classifies', async () => {
  const lookup = fakeLookup();
  const { llm } = await runLookupTurn({ lookup, llm: lookupLlm('x y'), trigger: false });
  assert.equal(lookup.readCalls.length, 1);
  assert.equal(llm.classifierCalls.length, 0);
  assert.equal(lookup.searchCalls.length, 0);
});

test('createTurnRunner: lookup -- one classifier call and at most one search per turn', async () => {
  const lookup = fakeLookup();
  const { llm } = await runLookupTurn({ lookup, llm: lookupLlm('first query\nsecond query') });
  assert.equal(llm.classifierCalls.length, 1);
  assert.deepEqual(lookup.searchCalls.map((c) => c.query), ['first query']);
});

test('createTurnRunner: lookup -- no key, no prompt, search disabled or maxPerTurn 0 -> no classifier call', async () => {
  const noPrompt = lookupHot();
  delete noPrompt.prompts.lookup;
  const cases = [
    { hot: lookupHot(), lookup: fakeLookup({ hasKey: false }) },
    { hot: noPrompt, lookup: fakeLookup() },
    { hot: lookupHot({}, { search: { enabled: false } }), lookup: fakeLookup() },
    { hot: lookupHot({}, { search: { maxPerTurn: 0 } }), lookup: fakeLookup() },
  ];
  for (const { hot, lookup } of cases) {
    const { llm } = await runLookupTurn({ hot, lookup, llm: lookupLlm('x y') });
    assert.equal(llm.classifierCalls.length, 0);
    assert.equal(lookup.searchCalls.length, 0);
  }
});

test('createTurnRunner: lookup -- links disabled -> no readLinks, the search still runs', async () => {
  const lookup = fakeLookup();
  await runLookupTurn({ hot: lookupHot({}, { links: { enabled: false } }), lookup, llm: lookupLlm('x y') });
  assert.equal(lookup.readCalls.length, 0);
  assert.equal(lookup.searchCalls.length, 1);
});

test('createTurnRunner: lookup -- features.webLookup off -> zero lookup calls and no classifier call', async () => {
  const lookup = fakeLookup();
  const { llm } = await runLookupTurn({ hot: lookupHot({ webLookup: false }), lookup, llm: lookupLlm('x y') });
  assert.equal(lookup.readCalls.length, 0);
  assert.equal(lookup.searchCalls.length, 0);
  assert.equal(llm.classifierCalls.length, 0);
  assert.equal(llm.turnCalls.length, 1);
});

test('createTurnRunner: lookup -- senses.search reaches the request only when lookup.hasSearch() is true', async () => {
  for (const hasKey of [true, false]) {
    const { llm } = await runLookupTurn({ lookup: fakeLookup({ hasKey }) });
    const user = textOf(llm.turnCalls[0].messages[1].content);
    assert.equal(user.includes(labels.senses.search), hasKey);
    assert.ok(user.includes(labels.senses.linksRead), 'reading links needs no search key');
  }
});

// ---------------------------------------------------------------------------
// Recall: the search of the server's own history beside the web search.

const RECALL_TEXT = 'Ana a tiré sur le lapin le 1er octobre.';

/** A fake createRecall()-shaped dependency: `available()` as given; `run()` records its arguments, then resolves `result`. */
function fakeRecall({ available = true, result = { text: RECALL_TEXT, stretch: null, people: [] }, events = null } = {}) {
  const runCalls = [];
  return {
    runCalls,
    available: () => available,
    run: async (args) => {
      runCalls.push(args);
      events?.push('server:start');
      await new Promise((resolve) => setImmediate(resolve));
      events?.push('server:end');
      return { stats: {}, ...result };
    },
  };
}

/** One reply turn (`dm`: a private chat served for g1) with a web lookup and a recall wired. */
async function runRecallTurn({ hot = lookupHot(), llm, lookup = fakeLookup(), recall = fakeRecall(), dm = false, client = fakeClient() } = {}) {
  const messages = [
    rawMessage({ id: 'm1', ts: NOW - 5000, content: 'καλημέρα' }),
    rawMessage({ id: 'm2', ts: NOW - 1000, authorName: 'Zoë', content: 'ποιος σκότωσε το κουνέλι;' }),
  ];
  const channel = fakeTurnChannel({ historyMessages: messages, ...(dm ? { id: 'dm1', dm: true } : {}) });
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client, lookup, recall, now: () => NOW });
  const trigger = normalizedTrigger(messages[1]);
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, ...(dm ? { guildId: 'g1' } : {}), mode: 'reply', trigger, triggerKind: dm ? 'private' : 'mention' }),
  );
  return { result, logs, llm, lookup, recall, channel, trigger };
}

/** The `<lookup>` block of the turn's request, or null. */
function turnLookupOf(llm) {
  const match = /<lookup>\n([\s\S]*?)\n<\/lookup>/.exec(textOf(llm.turnCalls[0].messages[1].content));
  return match ? match[1] : null;
}

/** The web part fakeLookup's result renders for `query`, as before recall. */
function webPartOf(query) {
  return [fill(labels.lookup.header, { query }), 'ευρήματα', fill(labels.lookup.sources, { list: 'example.com' })].join('\n');
}

test('createTurnRunner: recall -- a server: answer runs recall with the trigger, the turn\'s chat and the parsed forms; its text sits under the server header', async () => {
  const llm = lookupLlm('server: κουνέλι, κουνελιού');
  const { recall, lookup, trigger, channel } = await runRecallTurn({ llm });
  assert.equal(lookup.searchCalls.length, 0, 'no web query was asked');
  assert.equal(recall.runCalls.length, 1);
  const args = recall.runCalls[0];
  assert.equal(args.channel, channel);
  assert.equal(args.guild, channel.guild);
  assert.equal(args.guildId, 'g1');
  assert.equal(args.selfId, 'self-id');
  assert.equal(args.selfName, 'Bot');
  assert.equal(args.candidate.id, trigger.id);
  assert.deepEqual(args.history.map((m) => m.id), ['m1', 'm2']);
  assert.deepEqual(args.context.map((m) => m.id), ['m1', 'm2'], 'the summary\'s context: the lines the classifier read');
  assert.deepEqual(args.server, { forms: ['κουνέλι', 'κουνελιού'], who: [], from: null, to: null });
  assert.equal(turnLookupOf(llm), [labels.lookup.serverHeader, RECALL_TEXT].join('\n'));
});

test('createTurnRunner: recall -- web: and server: run both searches in parallel; the block carries the both-note, then both parts', async () => {
  const events = [];
  const lookup = fakeLookup();
  const search = lookup.search;
  lookup.search = async (...args) => {
    events.push('web:start');
    await new Promise((resolve) => setImmediate(resolve));
    const found = await search(...args);
    events.push('web:end');
    return found;
  };
  const llm = lookupLlm('web: lapin chasse saison\nserver: κουνέλι');
  const { recall } = await runRecallTurn({ llm, lookup, recall: fakeRecall({ events }) });
  assert.equal(recall.runCalls.length, 1);
  assert.deepEqual(lookup.searchCalls.map((c) => c.query), ['lapin chasse saison']);
  assert.deepEqual(events.slice(0, 2).sort(), ['server:start', 'web:start'], 'both started before either ended');
  assert.equal(
    turnLookupOf(llm),
    [labels.lookup.bothNote, labels.lookup.webHeader, webPartOf('lapin chasse saison'), labels.lookup.serverHeader, RECALL_TEXT].join('\n'),
  );
});

test('createTurnRunner: recall -- a web-only or an old unlabelled answer runs no recall and renders the block exactly as before', async () => {
  for (const answer of ['web: champions final', 'champions final']) {
    const llm = lookupLlm(answer);
    const { recall, lookup } = await runRecallTurn({ llm });
    assert.equal(recall.runCalls.length, 0, answer);
    assert.deepEqual(lookup.searchCalls.map((c) => c.query), ['champions final'], answer);
    assert.equal(turnLookupOf(llm), webPartOf('champions final'), answer);
  }
});

test('createTurnRunner: recall -- unavailable: a server: line is ignored and recall is never run; with no web search either, no classifier call', async () => {
  const llm = lookupLlm('web: champions final\nserver: κουνέλι');
  const { recall, lookup } = await runRecallTurn({ llm, recall: fakeRecall({ available: false }) });
  assert.equal(recall.runCalls.length, 0);
  assert.equal(lookup.searchCalls.length, 1);
  assert.equal(turnLookupOf(llm), webPartOf('champions final'));

  const none = await runRecallTurn({ llm: lookupLlm('server: κουνέλι'), lookup: fakeLookup({ hasKey: false }), recall: fakeRecall({ available: false }) });
  assert.equal(none.llm.classifierCalls.length, 0);
  assert.equal(none.recall.runCalls.length, 0);
});

test('createTurnRunner: recall -- with the web search unable to run, the classifier still runs for the server search', async () => {
  const cases = [
    { hot: lookupHot({ webLookup: false }), lookup: null },
    { hot: lookupHot(), lookup: fakeLookup({ hasKey: false }) },
  ];
  for (const { hot, lookup } of cases) {
    const llm = lookupLlm('web: champions final\nserver: κουνέλι');
    const { recall } = await runRecallTurn({ hot, llm, lookup });
    assert.equal(llm.classifierCalls.length, 1);
    assert.equal(recall.runCalls.length, 1);
    assert.equal(lookup?.searchCalls.length ?? 0, 0, 'the web part the answer asked for is not run');
    assert.equal(turnLookupOf(llm), [labels.lookup.serverHeader, RECALL_TEXT].join('\n'));
  }
});

/** A client serving g1, where the DM partner u1 (the trigger's author) is fetched as `partner`. */
function partnerClient() {
  const guild = { id: 'g1', members: { me: { displayName: 'Bot' } }, channels: { cache: new Map() } };
  const partner = { id: 'u1', guild };
  guild.members.fetch = async (id) => (id === 'u1' ? partner : null);
  return { client: fakeClient({ guilds: { cache: new Map([['g1', guild]]) } }), guild, partner };
}

test('createTurnRunner: recall -- a private chat runs recall on its partner\'s behalf in the served guild', async () => {
  const { client, guild, partner } = partnerClient();
  const { result, recall, channel, lookup, llm } = await runRecallTurn({ llm: lookupLlm('server: κουνέλι'), dm: true, client });
  assert.equal(result.outcome, 'spoke');
  assert.equal(recall.runCalls.length, 1);
  const args = recall.runCalls[0];
  assert.equal(args.channel, channel);
  assert.equal(args.guild, guild);
  assert.equal(args.guildId, 'g1');
  assert.equal(args.partner, partner);
  assert.deepEqual(args.server, { forms: ['κουνέλι'], who: [], from: null, to: null });
  assert.equal(lookup.searchCalls.length, 0);
  assert.equal(turnLookupOf(llm), [labels.lookup.serverHeader, RECALL_TEXT].join('\n'));
});

test('createTurnRunner: recall -- features.privateLikeServer off: a private chat never runs recall, its partner at hand or not', async () => {
  const { client } = partnerClient();
  const off = await runRecallTurn({ hot: lookupHot({ privateLikeServer: false }), llm: lookupLlm('web: champions final\nserver: κουνέλι'), dm: true, client });
  assert.equal(off.result.outcome, 'spoke');
  assert.equal(off.recall.runCalls.length, 0);
  assert.equal(off.lookup.searchCalls.length, 1);
  assert.equal(turnLookupOf(off.llm), webPartOf('champions final'));

  const noWeb = await runRecallTurn({
    hot: lookupHot({ webLookup: false, privateLikeServer: false }),
    llm: lookupLlm('server: κουνέλι'),
    lookup: null,
    dm: true,
    client: partnerClient().client,
  });
  assert.equal(noWeb.llm.classifierCalls.length, 0, 'nothing can run: no classifier');
  assert.equal(noWeb.recall.runCalls.length, 0);
});

test('createTurnRunner: recall -- a private chat without its partner as a guild member never runs recall', async () => {
  const withWeb = await runRecallTurn({ llm: lookupLlm('web: champions final\nserver: κουνέλι'), dm: true });
  assert.equal(withWeb.result.outcome, 'spoke');
  assert.equal(withWeb.recall.runCalls.length, 0);
  assert.equal(withWeb.lookup.searchCalls.length, 1);
  assert.equal(turnLookupOf(withWeb.llm), webPartOf('champions final'));

  const noWeb = await runRecallTurn({ hot: lookupHot({ webLookup: false }), llm: lookupLlm('server: κουνέλι'), lookup: null, dm: true });
  assert.equal(noWeb.llm.classifierCalls.length, 0, 'nothing can run: no classifier');
  assert.equal(noWeb.recall.runCalls.length, 0);
});

test('createTurnRunner: recall -- a recall that found nothing leaves no server part', async () => {
  const nothing = () => fakeRecall({ result: { text: null, stretch: null, people: [] } });
  const both = await runRecallTurn({ llm: lookupLlm('web: champions final\nserver: κουνέλι'), recall: nothing() });
  assert.equal(both.recall.runCalls.length, 1);
  assert.equal(turnLookupOf(both.llm), webPartOf('champions final'));

  const alone = await runRecallTurn({ llm: lookupLlm('server: κουνέλι'), recall: nothing() });
  assert.equal(alone.recall.runCalls.length, 1);
  assert.equal(turnLookupOf(alone.llm), null);
});

test('createTurnRunner: recall -- senses.recall reaches the request only on a server turn where the runner is available', async () => {
  const sensesHas = ({ llm }) => textOf(llm.turnCalls[0].messages[1].content).includes(labels.senses.recall);
  const throwing = { ...fakeRecall(), available: () => { throw new Error('boom'); } };
  const noRun = { available: () => true };
  const cases = [
    { name: 'available', run: { recall: fakeRecall() }, expected: true },
    { name: 'available, no web lookup either', run: { hot: lookupHot({ webLookup: false }), lookup: null, recall: fakeRecall() }, expected: true },
    { name: 'unavailable', run: { recall: fakeRecall({ available: false }) }, expected: false },
    { name: 'not wired', run: { recall: null }, expected: false },
    { name: 'no run function', run: { recall: noRun }, expected: false },
    { name: 'available() throws', run: { recall: throwing }, expected: false },
    { name: 'private chat', run: { recall: fakeRecall(), dm: true }, expected: false },
  ];
  for (const { name, run, expected } of cases) {
    const turn = await runRecallTurn({ llm: lookupLlm('x y'), ...run });
    assert.equal(turn.result.outcome, 'spoke', name);
    assert.equal(sensesHas(turn), expected, name);
  }
});

test('createTurnRunner: recall -- a stretch from recall reaches the block under its header', async () => {
  const stretch = { channelId: 'c2', channelName: 'jardin', startTs: NOW - 3 * 24 * 3_600_000, lines: '>> [11:00] Ana: le lapin' };
  const llm = lookupLlm('server: κουνέλι');
  await runRecallTurn({ llm, recall: fakeRecall({ result: { text: RECALL_TEXT, stretch, people: [] } }) });
  const heading = fill(labels.lookup.stretch, { date: new Date(stretch.startTs).toISOString().slice(0, 10), channel: 'jardin' });
  assert.equal(turnLookupOf(llm), [labels.lookup.serverHeader, RECALL_TEXT, heading, stretch.lines].join('\n'));
});

test('createTurnRunner: recall -- lookup: classified carries what was asked as flags and counts, never a query, a form or a name', async () => {
  const llm = lookupLlm('web: requête secrète\nserver: λαγός, λαγού\nwho: Ἀλέξανδρος\nwhen: 2026-09-01');
  const { logs, recall } = await runRecallTurn({ llm });
  const line = logs.find((l) => l.msg === 'lookup: classified');
  assert.ok(line);
  assert.equal(line.picked, true);
  assert.equal(line.parse, 'ok');
  assert.equal(line.web, true);
  assert.equal(line.server, true);
  assert.equal(line.forms, 2);
  assert.equal(line.who, 1);
  assert.equal(line.ranged, true);
  assert.equal(recall.runCalls[0].server.from, Date.UTC(2026, 8, 1), 'when: is read in the bot time zone');
  const all = JSON.stringify(logs);
  for (const secret of ['secrète', 'λαγ', 'λέξανδρ']) assert.ok(!all.includes(secret), secret);
});

// ---------------------------------------------------------------------------
// Drawing: the persona's <draw> goes to the image client after its messages;
// a failed generation gets its own follow-up turn.

const DRAW_IMAGE_CFG = { maxPromptChars: 800, reference: 'avatar', referenceMaxBytes: 4_000_000 };

/** A fake createImageGen()-shaped dependency (see src/llm/images.js). */
function fakeImages({ error = null, mediaType = 'image/png', quota = { used: 0, cap: 5, userUsed: 0, userCap: 3, spent: false, userSpent: false } } = {}) {
  const generateCalls = [];
  const quotaCalls = [];
  return {
    generateCalls,
    quotaCalls,
    generate: async (args) => {
      generateCalls.push(args);
      if (error) throw error;
      return { buffer: Buffer.from('fake picture'), mediaType, cost: 0.02, usage: {}, model: 'fake/model', seconds: 1.5 };
    },
    quota: (args) => {
      quotaCalls.push(args);
      return quota;
    },
  };
}

/** A fake LLM answering each call with the next text of `answers` (the last one repeats). */
function sequenceLlm(answers) {
  const calls = [];
  return {
    calls,
    complete: async (messages) => {
      calls.push(messages);
      return { text: answers[Math.min(calls.length - 1, answers.length - 1)], usage: {}, estimated: 10 };
    },
  };
}

function drawHot(features = {}, image = {}, bot = {}) {
  const hot = fakeHot({ typingSimulation: false, ...features }, bot, { image: { ...DRAW_IMAGE_CFG, ...image } });
  hot.prompts.draw = 'Drawing for {{name}}.\n\n{{appearance}}\n\n{{request}}';
  hot.prompts.appearance = '{{name}} wears a green scarf.';
  hot.prompts.reply = 'Someone called you: {{author}}, they {{trigger}}.';
  return hot;
}

async function runDrawTurn({ answers, hot = drawHot(), images = fakeImages(), client = fakeClient(), imageFetcher = fakeImageFetcher(), withTrigger = true, attachFiles = true, triggerKind = 'mention' } = {}) {
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', content: 'draw me a cat' });
  const channel = fakeTurnChannel({ id: 'c1', name: 'general', historyMessages: [raw], attachFiles });
  const llm = sequenceLlm(answers);
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client, images, imageFetcher });
  const params = withTrigger
    ? { channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind }
    : { channel, mode: 'interject' };
  const { result, logs } = await withCapturedLogs(() => turns.runTurn(params));
  return { result, logs, channel, llm, images, imageFetcher, turns };
}

function userTextOf(messages) {
  const content = textOf(messages[1].content);
  return Array.isArray(content) ? content.find((part) => part.type === 'text').text : content;
}

test('runTurn: a <draw> after <msg> posts the messages then a file', async () => {
  const { result, channel, images } = await runDrawTurn({ answers: ['<msg>one sec</msg><msg>here</msg><draw reply="#1">a cat on a roof</draw>'] });

  assert.equal(result.outcome, 'spoke');
  assert.equal(result.drawFailed, undefined);
  assert.equal(channel.sent.length, 3);
  assert.equal(channel.sent[0].content, 'one sec');
  assert.equal(channel.sent[1].content, 'here');
  const file = channel.sent[2];
  assert.equal(file.content, undefined);
  assert.equal(file.files.length, 1);
  assert.ok(file.files[0].name.endsWith('.png'));
  assert.ok(Buffer.isBuffer(file.files[0].attachment));
  assert.deepEqual(file.reply, { messageReference: 'm1', failIfNotExists: false });
  assert.deepEqual(file.allowedMentions, { parse: [] });

  assert.equal(images.generateCalls.length, 1);
  const call = images.generateCalls[0];
  assert.equal(call.userId, 'u1');
  assert.equal(call.reference, null, 'a non-self picture never carries the avatar');
  assert.equal(call.prompt, 'Drawing for Bot.\n\na cat on a roof');
});

test('runTurn: the file name follows the media type (image/jpeg -> .jpg)', async () => {
  const { channel } = await runDrawTurn({ answers: ['<draw>a cat</draw>'], images: fakeImages({ mediaType: 'image/jpeg' }) });
  assert.equal(channel.sent[0].files[0].name, 'image.jpg');
});

test('runTurn: the draw request is clamped to image.maxPromptChars', async () => {
  const { images } = await runDrawTurn({ answers: ['<draw>abcdefghij</draw>'], hot: drawHot({}, { maxPromptChars: 4 }) });
  assert.ok(images.generateCalls[0].prompt.endsWith('\n\nabcd'));
});

test('runTurn: a self <draw> passes the avatar as reference', async () => {
  const avatarCalls = [];
  const client = fakeClient();
  client.user.displayAvatarURL = (options) => {
    avatarCalls.push(options);
    return 'https://cdn.example.com/avatar.png';
  };
  const imageFetcher = fakeImageFetcher({ dataUrl: 'data:image/png;base64,YXZhdGFy', bytes: 6, contentType: 'image/png' });
  const { images } = await runDrawTurn({ answers: ['<draw self="yes">me waving</draw>'], client, imageFetcher });

  assert.deepEqual(avatarCalls, [{ extension: 'png', size: 1024, forceStatic: true }]);
  assert.equal(imageFetcher.calls.length, 1);
  assert.equal(imageFetcher.calls[0].url, 'https://cdn.example.com/avatar.png');
  assert.equal(imageFetcher.calls[0].options.maxBytes, DRAW_IMAGE_CFG.referenceMaxBytes);
  assert.equal(imageFetcher.calls[0].options.timeoutMs, 10_000);
  assert.equal(images.generateCalls[0].reference, 'data:image/png;base64,YXZhdGFy');
  assert.ok(images.generateCalls[0].prompt.includes('Bot wears a green scarf.'), 'a self picture carries the appearance');
});

test('runTurn: reference none skips the avatar', async () => {
  let avatarAsked = false;
  const client = fakeClient();
  client.user.displayAvatarURL = () => {
    avatarAsked = true;
    return 'https://cdn.example.com/avatar.png';
  };
  const { images, imageFetcher } = await runDrawTurn({ answers: ['<draw self="yes">me waving</draw>'], hot: drawHot({}, { reference: 'none' }), client });

  assert.equal(avatarAsked, false);
  assert.equal(imageFetcher.calls.length, 0);
  assert.equal(images.generateCalls[0].reference, null);
});

test('runTurn: an avatar that cannot be fetched is logged and the picture is drawn without it', async () => {
  const client = fakeClient();
  client.user.displayAvatarURL = () => 'https://cdn.example.com/avatar.png';
  const { images, channel, logs } = await runDrawTurn({ answers: ['<draw self="yes">me</draw>'], client, imageFetcher: fakeImageFetcher(null) });

  assert.ok(logs.some((l) => l.msg === 'turn: avatar reference unavailable'));
  assert.equal(images.generateCalls[0].reference, null);
  assert.equal(channel.sent.length, 1);
});

test('runTurn: dry-run logs the draw prompt and never calls generate', async () => {
  const mirrorSent = [];
  const client = fakeClient({ channels: { fetch: async () => ({ send: async (payload) => mirrorSent.push(payload) }) } });
  const { result, logs, channel, images } = await runDrawTurn({
    answers: ['<draw self="yes">me on a bicycle</draw>'],
    hot: drawHot({ dryRun: true }, {}, { dryRunChannelId: 'mirror1' }),
    client,
  });

  assert.equal(result.outcome, 'spoke');
  assert.equal(result.dryRun, true);
  assert.equal(result.drawFailed, undefined);
  assert.equal(images.generateCalls.length, 0);
  assert.equal(channel.sent.length, 0);
  const line = logs.find((l) => l.msg === 'dry-run: would draw');
  assert.ok(line);
  // The full image prompt: the fixture's draw prompt, the appearance (a self picture) and the request.
  assert.ok(line.prompt.includes('Drawing for Bot.'), 'the draw prompt file is in the logged prompt');
  assert.ok(line.prompt.includes('Bot wears a green scarf.'), 'the appearance is in the logged prompt');
  assert.ok(line.prompt.endsWith('me on a bicycle'), 'the request is in the logged prompt');
  assert.equal(line.prompt, 'Drawing for Bot.\n\nBot wears a green scarf.\n\nme on a bicycle');
  assert.equal(mirrorSent.length, 1);
  assert.ok(mirrorSent[0].content.endsWith(`\n${line.prompt}`), 'the mirror carries the whole prompt');
});

test('runTurn: dry-run mirrors a long draw prompt in numbered parts that each fit a Discord message', async () => {
  const mirrorSent = [];
  const client = fakeClient({ channels: { fetch: async () => ({ send: async (payload) => mirrorSent.push(payload) }) } });
  const hot = drawHot({ dryRun: true }, {}, { dryRunChannelId: 'mirror1' });
  hot.prompts.draw = `${'style line é\n'.repeat(300)}{{request}}`;
  const { logs } = await runDrawTurn({ answers: ['<draw>a cat</draw>'], hot, client });

  const prompt = logs.find((l) => l.msg === 'dry-run: would draw').prompt;
  assert.ok(prompt.length > 2000);
  assert.ok(mirrorSent.length >= 2);
  const bodies = mirrorSent.map((payload, i) => {
    const [header, ...body] = payload.content.split('\n');
    assert.ok([...payload.content].length <= 2000, 'every part fits one Discord message');
    assert.ok(header.includes(`(${i + 1}/${mirrorSent.length})`), 'the part is numbered');
    return body.join('\n');
  });
  assert.equal(bodies.join('\n'), prompt, 'the parts put together are the whole prompt');
});

test('runTurn: a failed generation runs a second turn with triggerKind drawFailed', async () => {
  const { result, llm, channel, images } = await runDrawTurn({
    answers: ['<msg>on it</msg><draw>a cat</draw>', '<msg>it did not work</msg><draw>a cat again</draw>'],
    images: fakeImages({ error: new ImageGenError('moderation') }),
  });

  assert.equal(result.outcome, 'spoke');
  assert.equal(result.drawFailed, 'moderation');
  assert.equal(llm.calls.length, 2, 'exactly one extra turn');
  assert.ok(userTextOf(llm.calls[0]).includes(labels.senses.draw), 'the first turn offers drawing');
  const second = userTextOf(llm.calls[1]);
  assert.ok(second.includes(fill(labels.triggers.drawFailed, { reason: labels.draw.reasons.moderation })));
  for (const line of [labels.senses.draw, labels.senses.drawSpent, labels.senses.drawSpentUser]) {
    assert.ok(!second.includes(line), 'the drawFailed turn offers no drawing');
  }
  assert.equal(images.generateCalls.length, 1, 'the <draw> of the second answer is dropped');
  assert.deepEqual(channel.sent.map((p) => p.content), ['on it', 'it did not work']);
});

test('runTurn: the drawFailed turn reruns neither the re-watch nor the search classifier', async () => {
  const hot = rewatchHot({ webLookup: true }, {}, {
    image: { ...DRAW_IMAGE_CFG },
    web: { maxPerDay: 60, links: { enabled: true, maxPerTurn: 2 }, search: { enabled: true, maxPerTurn: 1, contextMessages: 50 } },
  });
  hot.prompts.lookup = LOOKUP_SYSTEM;
  hot.prompts.draw = 'Drawing for {{name}}.\n\n{{request}}';
  const classifierCalls = { rewatch: 0, lookup: 0 };
  const turnAnswers = ['<msg>on it</msg><draw>a red car</draw>', '<msg>it did not work</msg>'];
  let turnCount = 0;
  const llm = {
    complete: async (messages) => {
      const system = messages[0].content;
      if (system.startsWith('Pick the video')) {
        classifierCalls.rewatch += 1;
        return { text: 'none', usage: {}, estimated: 5 };
      }
      if (system.startsWith('Decide whether')) {
        classifierCalls.lookup += 1;
        return { text: 'none', usage: {}, estimated: 5 };
      }
      const text = turnAnswers[Math.min(turnCount, turnAnswers.length - 1)];
      turnCount += 1;
      return { text, usage: {}, estimated: 10 };
    },
  };
  const scene = rewatchScene();
  const turns = createTurnRunner({
    hot,
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    describer: fakeRewatchDescriber({ va: { state: 'watched', text: 'ένα αυτοκίνητο περνά' } }),
    lookup: fakeLookup(),
    images: fakeImages({ error: new ImageGenError('moderation') }),
    imageFetcher: fakeImageFetcher(),
  });
  const result = await turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: normalizedTrigger(scene.trigger), triggerKind: 'mention' });

  assert.equal(result.drawFailed, 'moderation');
  assert.equal(turnCount, 2, 'the drawFailed turn ran');
  assert.deepEqual(classifierCalls, { rewatch: 1, lookup: 1 }, 'each classifier once, for the first turn only');
});

test('runTurn: an upload failure counts as a failed drawing', async () => {
  const hot = drawHot();
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const send = channel.send;
  channel.send = async (payload) => {
    if (payload.files) throw new Error('upload rejected');
    return send(payload);
  };
  const llm = sequenceLlm(['<draw>a cat</draw>', '<msg>no</msg>']);
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), images: fakeImages() });
  const { result } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));

  assert.equal(result.drawFailed, 'error');
  assert.equal(llm.calls.length, 2);
  assert.deepEqual(channel.sent.map((p) => p.content), ['no']);
  assert.equal(turns.isAnyBusy(), false);
});

test('runTurn: a failed generation without a trigger runs no second turn', async () => {
  const { result, llm, logs, images } = await runDrawTurn({
    answers: ['<draw>a sunset</draw>'],
    images: fakeImages({ error: new ImageGenError('timeout') }),
    withTrigger: false,
  });

  assert.equal(result.outcome, 'spoke');
  assert.equal(result.drawFailed, 'timeout');
  assert.equal(llm.calls.length, 1);
  assert.equal(images.generateCalls[0].userId, null);
  const line = logs.find((l) => l.msg === 'turn: draw failed');
  assert.ok(line);
  assert.equal(line.reason, 'timeout');
});

test('runTurn: features.imageGeneration false drops the tag', async () => {
  const { result, channel, images, llm } = await runDrawTurn({
    answers: ['<msg>hi</msg><draw>a cat</draw>'],
    hot: drawHot({ imageGeneration: false }),
  });

  assert.equal(result.outcome, 'spoke');
  assert.equal(images.generateCalls.length, 0);
  assert.equal(images.quotaCalls.length, 0, 'no quota lookup without the feature');
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].files, undefined);
  assert.ok(!userTextOf(llm.calls[0]).includes(labels.senses.draw));
});

test('runTurn: a channel without Attach Files offers no drawing and never generates', async () => {
  const { result, channel, images, llm } = await runDrawTurn({
    answers: ['<msg>hi</msg><draw>a cat</draw>'],
    attachFiles: false,
  });

  assert.equal(result.outcome, 'spoke');
  assert.equal(result.drawFailed, undefined);
  assert.equal(images.generateCalls.length, 0, 'nothing is generated (or paid for)');
  assert.equal(images.quotaCalls.length, 0, 'no quota lookup where no file can be posted');
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].files, undefined);
  assert.ok(!userTextOf(llm.calls[0]).includes(labels.senses.draw), 'no drawing line in the senses');
  assert.equal(llm.calls.length, 1, 'no drawFailed turn');
});

test('runTurn: a <draw> alone with the feature off, or without an image client, is a skip', async () => {
  const off = await runDrawTurn({ answers: ['<draw>a cat</draw>'], hot: drawHot({ imageGeneration: false }) });
  assert.equal(off.result.outcome, 'skip');
  assert.equal(off.channel.sent.length, 0);

  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const turns = createTurnRunner({ hot: drawHot(), store: fakeStore(), llm: sequenceLlm(['<draw>a cat</draw>']), calibrator: identityCalibrator(), client: fakeClient() });
  const { result } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
  assert.equal(result.outcome, 'skip');
  assert.equal(channel.sent.length, 0);
});

test('runTurn: a <draw> alone is a spoken turn', async () => {
  const { result, channel, llm, images, logs } = await runDrawTurn({ answers: ['<draw>a cat</draw>'] });

  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, undefined);
  assert.equal(channel.sent[0].files.length, 1);
  assert.equal(channel.typingCalls.length, 0);
  assert.deepEqual(images.quotaCalls, [{ userId: 'u1' }]);
  assert.ok(userTextOf(llm.calls[0]).includes(labels.senses.draw), 'the draw sense reaches the request');
  const answered = logs.find((l) => l.msg === 'turn: model answered');
  assert.equal(answered.draw, true);
  const drew = logs.find((l) => l.msg === 'turn: drew');
  assert.ok(drew);
  assert.equal(drew.channel, 'c1');
  assert.equal(drew.self, false);
  assert.equal(drew.bytes, Buffer.byteLength('fake picture'));
  assert.ok(!JSON.stringify(logs).includes('a cat'), 'the draw prompt is never logged outside dry-run');
});

test('runTurn: a follow-up turn posts the picture without a Discord reply', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const turns = createTurnRunner({ hot: drawHot(), store: fakeStore(), llm: sequenceLlm(['<draw reply="#1">a cat</draw>']), calibrator: identityCalibrator(), client: fakeClient(), images: fakeImages() });
  await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'followUp' }));
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].reply, undefined);
});

test('runTurn: a failed drawing fires onIdle once, only after the drawFailed turn has sent', async () => {
  const order = [];
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const send = channel.send;
  channel.send = async (payload) => {
    order.push(`send:${payload.content}`);
    return send(payload);
  };
  const llm = sequenceLlm(['<msg>on it</msg><draw>a cat</draw>', '<msg>it did not work</msg>']);
  const turns = createTurnRunner({
    hot: drawHot(),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    images: fakeImages({ error: new ImageGenError('timeout') }),
  });
  turns.setOnIdle(() => order.push('idle'));

  await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(order, ['send:on it', 'send:it did not work', 'idle']);
});

test('runTurn: waitIdle() during a failed drawing resolves only after the drawFailed turn', async () => {
  const order = [];
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const send = channel.send;
  channel.send = async (payload) => {
    order.push(`send:${payload.content}`);
    return send(payload);
  };
  const llm = sequenceLlm(['<draw>a cat</draw>', '<msg>it did not work</msg>']);
  let turns;
  const images = {
    quota: () => ({ spent: false, userSpent: false }),
    generate: async () => {
      // Asked while the first turn is still in flight, like /nep pause would.
      turns.waitIdle().then(() => order.push('idle'));
      throw new ImageGenError('moderation');
    },
  };
  turns = createTurnRunner({ hot: drawHot(), store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), images });

  await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(order, ['send:it did not work', 'idle']);
});

test('runTurn: a drawFailed turn that fails itself still fires onIdle once', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  let calls = 0;
  const llm = {
    complete: async () => {
      calls += 1;
      if (calls > 1) throw new Error('provider down');
      return { text: '<draw>a cat</draw>', usage: {}, estimated: 1 };
    },
  };
  const turns = createTurnRunner({
    hot: drawHot(),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    images: fakeImages({ error: new ImageGenError('error') }),
  });
  let idle = 0;
  turns.setOnIdle(() => {
    idle += 1;
  });

  await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls, 2);
  assert.equal(idle, 1);
  assert.equal(turns.isAnyBusy(), false);
});

test('runTurn: a failed drawing without a trigger fires onIdle once, right away', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const turns = createTurnRunner({
    hot: drawHot(),
    store: fakeStore(),
    llm: sequenceLlm(['<draw>a sunset</draw>']),
    calibrator: identityCalibrator(),
    client: fakeClient(),
    images: fakeImages({ error: new ImageGenError('timeout') }),
  });
  let idle = 0;
  turns.setOnIdle(() => {
    idle += 1;
  });

  await withCapturedLogs(() => turns.runTurn({ channel, mode: 'interject' }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(idle, 1);
});

// --- private (DM) turns --------------------------------------------------------

function privateHot(features = {}) {
  const hot = drawHot(features);
  hot.prompts.reply = 'Someone called you: {{author}}, they {{trigger}}. You are {{name}}.';
  hot.prompts.private = 'PRIVATE_TASK with {{author}} as {{name}}';
  return hot;
}

function privateStore() {
  return fakeStore({
    userProfiles: { u1: { id: 'u1', names: ['Alice'], relationship: 'PUBLIC_REL', affinity: { score: 10, reason: 'public reason', history: [] } } },
    privateProfiles: { u1: { relationship: 'PRIVATE_REL', details: [{ id: 1, text: 'PRIVATE_DETAIL', weight: 1 }], affinity: { score: 5, reason: '', history: [] } } },
    channels: [{ id: 'dm1', name: 'dm', lastMessageAt: NOW, days: {} }],
  });
}

/** The client of a bot serving guild g1, where its display name is `GuildBot`. */
function guildClient() {
  return fakeClient({ guilds: { cache: new Map([['g1', { id: 'g1', members: { me: { displayName: 'GuildBot' } } }]]) } });
}

async function runPrivateTurn({ answers = ['<msg reply="#1">hi</msg>'], hot = privateHot(), store = privateStore(), images = fakeImages(), client = guildClient(), guildId = 'g1' } = {}) {
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', content: 'hey' });
  const channel = fakeTurnChannel({ id: 'dm1', dm: true, historyMessages: [raw] });
  const llm = sequenceLlm(answers);
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client, images });
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, guildId, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'private' }),
  );
  return { result, logs, channel, llm, store, images, turns };
}

test('runTurn: a private turn takes guildId from params and reads the private layer of the trigger author', async () => {
  const { result, channel, store } = await runPrivateTurn();

  assert.equal(result.outcome, 'spoke');
  // The request's guild memory: nothing reads the guild again before the message is posted.
  assert.deepEqual(store.guildCalls, ['g1']);
  assert.deepEqual(store.privateCalls, [{ guildId: 'g1', userId: 'u1' }]);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, 'hi');
  assert.deepEqual(channel.sent[0].reply, { messageReference: 'm1', failIfNotExists: false }, 'a private reply may quote the trigger');
});

test('runTurn: a private request carries the private prompt, the private trigger label and the merged profile, no server or neighbours', async () => {
  const { llm } = await runPrivateTurn();
  const user = userTextOf(llm.calls[0]);

  assert.ok(user.includes(`Someone called you: Alice, they ${labels.triggers.private}. You are GuildBot.`), 'selfName comes from the served guild');
  assert.ok(user.includes('PRIVATE_TASK with Alice as GuildBot'));
  assert.ok(user.includes('PUBLIC_REL') && user.includes('PRIVATE_REL') && user.includes('PRIVATE_DETAIL'));
  assert.ok(user.includes('attitude: 15 '), 'the attitude is the public and private scores added');
  assert.ok(user.includes(labels.senses.privateChat));
  assert.ok(!user.includes('<server>'));
  assert.ok(!user.includes('<other_channels>'));
});

test('runTurn: a private turn falls back to the bot user name when the served guild is not cached', async () => {
  const { llm } = await runPrivateTurn({ client: fakeClient({ guilds: { cache: new Map() } }) });
  assert.ok(userTextOf(llm.calls[0]).includes('You are Bot.'));
});

test('runTurn: the injected clock stamps lastPostAt and the turn\'s own time', async () => {
  const raw = rawMessage({ id: 'm1', ts: NOW - 1000 });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>hi</msg>');
  const turns = createTurnRunner({ hot: fakeHot(), store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), now: () => NOW });
  const { logs } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
  assert.equal(channel.sent.length, 1);
  assert.equal(turns.lastPostAt('c1'), NOW);
  assert.equal(logs.find((l) => l.msg === 'turn: sent').secondsSinceTrigger, 0);
  assert.equal(logs.find((l) => l.msg === 'turn: model answered').secondsToAnswer, 0);
});

test('runTurn: a failing typing indicator does not stop the message', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  channel.sendTyping = async () => {
    throw new Error('Missing Permissions');
  };
  const turns = createTurnRunner({ hot: fakeHot(), store: fakeStore(), llm: fakeLlm('<msg>hi</msg>'), calibrator: identityCalibrator(), client: fakeClient() });
  await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
  assert.equal(channel.sent.length, 1);
});

test('runTurn: a dry-run private turn is mirrored without a channel name, never as "#null"', async () => {
  const mirrored = [];
  const client = { ...guildClient(), channels: { fetch: async () => ({ send: async (payload) => mirrored.push(payload) }) } };
  const hot = privateHot({ dryRun: true });
  hot.config.bot.dryRunChannelId = 'mirror1';
  const { channel } = await runPrivateTurn({ hot, client });
  assert.equal(channel.sent.length, 0);
  assert.equal(mirrored.length, 1);
  assert.ok(!mirrored[0].content.split('\n')[0].includes('#null'), mirrored[0].content);
});

test('runTurn: a private turn may draw (no Attach Files check in a DM), counted for the DM partner', async () => {
  const { result, channel, images } = await runPrivateTurn({ answers: ['<msg>sure</msg><draw>a cat</draw>'] });

  assert.equal(result.outcome, 'spoke');
  assert.equal(images.generateCalls.length, 1);
  assert.equal(images.generateCalls[0].userId, 'u1');
  assert.equal(images.generateCalls[0].prompt, 'Drawing for GuildBot.\n\na cat');
  assert.equal(channel.sent.length, 2);
  assert.equal(channel.sent[1].files.length, 1);
});

test('runTurn: a guild channel keeps its own guild id even when a guildId param is passed', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ guildId: 'g1', historyMessages: [raw] });
  const store = fakeStore();
  const hot = fakeHot();
  hot.prompts.private = 'PRIVATE_TASK';
  const turns = createTurnRunner({ hot, store, llm: fakeLlm('<skip/>'), calibrator: identityCalibrator(), client: fakeClient() });

  await turns.runTurn({ channel, guildId: 'other', mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.deepEqual(store.guildCalls, ['g1']);
  assert.equal(store.privateCalls.length, 0, 'a guild turn never reads the private layer');
});

test('runTurn: a guild turn never carries the private prompt or the private senses line', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<skip/>');
  const hot = fakeHot({ privateMessages: true });
  hot.prompts.private = 'PRIVATE_TASK';
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient() });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  const user = textOf(llm.calls[0][1].content);
  assert.ok(!user.includes('PRIVATE_TASK'));
  assert.ok(!user.includes(labels.senses.privateChat));
  assert.ok(user.includes(labels.senses.privateAware));
});

test('runTurn: a channel without a guild and no guildId param throws a clear error and leaves nothing busy', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ id: 'dm1', dm: true, historyMessages: [raw] });
  const llm = fakeLlm('<msg>hi</msg>');
  const turns = createTurnRunner({ hot: fakeHot(), store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient() });

  await assert.rejects(
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'private' }),
    /guildId/,
  );
  assert.equal(llm.calls.length, 0);
  assert.equal(turns.isAnyBusy(), false);
});

// --- limits --------------------------------------------------------------------

function throwingLlm(error) {
  const calls = [];
  return {
    calls,
    complete: async (messages) => {
      calls.push(messages);
      throw error;
    },
  };
}

test('runTurn: a daily request cap or a token cap refusal returns outcome refused with the limit', async () => {
  for (const [error, limit] of [
    [Object.assign(new DailyCapError('cap'), { key: 'llm.maxRequestsPerDay', used: 300, cap: 300 }), { key: 'llm.maxRequestsPerDay', used: 300, cap: 300 }],
    [Object.assign(new TokenLimitError('tokens'), { key: 'llm.maxRequestTokens', used: 51000, cap: 50000 }), { key: 'llm.maxRequestTokens', used: 51000, cap: 50000 }],
  ]) {
    const raw = rawMessage({ id: 'm1' });
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    const turns = createTurnRunner({ hot: fakeHot(), store: fakeStore(), llm: throwingLlm(error), calibrator: identityCalibrator(), client: fakeClient() });
    const { result } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));

    assert.deepEqual(result, { outcome: 'refused', limit });
    assert.equal(channel.sent.length, 0, 'the turn itself posts nothing; the caller decides on the notice');
  }
});

function imageCap(reason, key, used, cap) {
  return Object.assign(new ImageCapError(reason), { key, used, cap });
}

test('runTurn: a drawing refused by an image cap posts the limit notice as a plain reply and runs no second turn', async () => {
  for (const [reason, key] of [['daily', 'image.maxPerDay'], ['userDaily', 'image.maxPerUserPerDay']]) {
    const { result, llm, channel, logs } = await runDrawTurn({
      answers: ['<msg>on it</msg><draw reply="#1">a cat</draw>', '<msg>should never be asked</msg>'],
      images: fakeImages({ error: imageCap(reason, key, 3, 3) }),
    });

    assert.equal(result.outcome, 'spoke');
    assert.equal(result.drawFailed, undefined);
    assert.equal(llm.calls.length, 1, 'no drawFailed turn');
    assert.equal(channel.sent.length, 2);
    assert.equal(channel.sent[0].content, 'on it');
    assert.deepEqual(channel.sent[1], {
      content: fill(labels.limits.notice, { limit: key, used: 3, cap: 3 }),
      reply: { messageReference: 'm1', failIfNotExists: false },
      allowedMentions: { parse: [] },
    });
    assert.ok(logs.some((l) => l.msg === 'turn: draw refused by a limit'));
    assert.equal(logs.some((l) => l.msg === 'turn: draw failed'), false);
  }
});

test('runTurn: an image cap notice in a private chat replies to the trigger too', async () => {
  const { result, llm, channel } = await runPrivateTurn({
    answers: ['<draw>a cat</draw>'],
    images: fakeImages({ error: imageCap('userDaily', 'image.maxPerUserPerDay', 2, 2) }),
  });

  assert.equal(result.drawFailed, undefined);
  assert.equal(llm.calls.length, 1);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].content, fill(labels.limits.notice, { limit: 'image.maxPerUserPerDay', used: 2, cap: 2 }));
  assert.deepEqual(channel.sent[0].reply, { messageReference: 'm1', failIfNotExists: false });
  assert.deepEqual(channel.sent[0].allowedMentions, { parse: [] });
});

test('runTurn: an image cap with no limits.notice label posts nothing and still runs no second turn', async () => {
  const hot = drawHot();
  hot.prompts.labels = { ...labels, limits: undefined };
  const { result, llm, channel } = await runDrawTurn({
    answers: ['<msg>on it</msg><draw>a cat</draw>', '<msg>no</msg>'],
    hot,
    images: fakeImages({ error: imageCap('daily', 'image.maxPerDay', 5, 5) }),
  });

  assert.equal(result.drawFailed, undefined);
  assert.equal(llm.calls.length, 1);
  assert.deepEqual(channel.sent.map((p) => p.content), ['on it']);
});

test('runTurn: an image cap on a follow-up turn posts the notice without quoting the trigger', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const turns = createTurnRunner({
    hot: drawHot(),
    store: fakeStore(),
    llm: sequenceLlm(['<draw reply="#1">a cat</draw>']),
    calibrator: identityCalibrator(),
    client: fakeClient(),
    images: fakeImages({ error: imageCap('daily', 'image.maxPerDay', 5, 5) }),
  });
  await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'followUp' }));

  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].reply, undefined);
});

test('runTurn: an image cap notice while dry-run is on is logged and mirrored, never sent', async () => {
  const mirrorSent = [];
  const client = fakeClient({ channels: { fetch: async () => ({ send: async (payload) => mirrorSent.push(payload) }) } });
  const hot = drawHot({}, {}, { dryRunChannelId: 'mirror1' });
  const images = fakeImages();
  // The owner switches dry-run on while the picture is being made: read at the moment of use.
  images.generate = async () => {
    hot.config.features.dryRun = true;
    throw imageCap('daily', 'image.maxPerDay', 5, 5);
  };
  const { result, channel, logs } = await runDrawTurn({ answers: ['<msg>on it</msg><draw>a cat</draw>'], hot, images, client });

  assert.equal(result.drawFailed, undefined);
  assert.deepEqual(channel.sent.map((p) => p.content), ['on it'], 'the notice is never sent to the channel');
  assert.ok(logs.some((l) => l.msg === 'dry-run: would notify limit'));
  assert.equal(mirrorSent.length, 1);
  assert.ok(mirrorSent[0].content.endsWith(fill(labels.limits.notice, { limit: 'image.maxPerDay', used: 5, cap: 5 })));
  assert.deepEqual(mirrorSent[0].allowedMentions, { parse: [] });
});

test('runTurn: the drawFailed turn of a private chat keeps the guildId', async () => {
  const { result, llm, store } = await runPrivateTurn({
    answers: ['<draw>a cat</draw>', '<msg>it failed</msg>'],
    images: fakeImages({ error: new ImageGenError('moderation') }),
  });

  assert.equal(result.drawFailed, 'moderation');
  assert.equal(llm.calls.length, 2);
  // Each turn's request: nothing reads the guild again before the message is posted.
  assert.deepEqual(store.guildCalls, ['g1', 'g1']);
  assert.ok(userTextOf(llm.calls[1]).includes(fill(labels.triggers.drawFailed, { reason: labels.draw.reasons.moderation })));
});

test('runTurn: an image cap on a spontaneous turn stays silent -- no notice, no file, only a log line', async () => {
  const { result, llm, channel, logs } = await runDrawTurn({
    answers: ['<msg>look at this sunset</msg><draw>a sunset</draw>', '<msg>should never be asked</msg>'],
    images: fakeImages({ error: imageCap('daily', 'image.maxPerDay', 5, 5) }),
    withTrigger: false,
  });

  assert.equal(result.outcome, 'spoke');
  assert.equal(result.drawFailed, undefined);
  assert.equal(llm.calls.length, 1, 'no drawFailed turn');
  assert.deepEqual(channel.sent.map((p) => p.content), ['look at this sunset'], 'nobody asked: no notice');
  assert.ok(channel.sent.every((p) => p.files === undefined), 'no file');
  assert.ok(logs.some((l) => l.msg === 'turn: draw refused by a limit'));
  assert.equal(logs.some((l) => l.msg === 'dry-run: would notify limit'), false);
});

// The server's custom emoji (features.customEmoji, src/discord/emoji.js).
function fakeEmojiIndex() {
  const emojis = [
    { id: '111111111111111111', name: 'pepe_cry', animated: false },
    { id: '222222222222222222', name: 'dance', animated: true },
  ];
  return { byName: (name) => emojis.find((e) => e.name === name) ?? null, list: () => emojis.map((e) => ({ ...e })) };
}

test('createTurnRunner: the request carries <emoji> ranked by guild.emojiUsage, with cached captions', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<skip/>');
  const store = fakeStore({
    guildMemory: { emojiUsage: { '222222222222222222': { name: 'dance', count: 4, last: Date.now() } } },
    mediaCache: { 'emoji:222222222222222222': { text: 'a spinning figure', ts: 1 } },
  });
  const turns = createTurnRunner({
    hot: fakeHot(),
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    emoji: fakeEmojiIndex(),
  });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  const user = textOf(llm.calls[0][1].content);
  const text = Array.isArray(user) ? user.find((part) => part.type === 'text').text : user;
  const block = /<emoji>\n([\s\S]*?)\n<\/emoji>/.exec(text);
  assert.ok(block, 'an <emoji> block is sent');
  assert.deepEqual(block[1].split('\n'), [labels.emoji.header, ':dance: -- a spinning figure', ':pepe_cry:']);
  assert.ok(text.includes(labels.senses.customEmoji));
});

test('createTurnRunner: an outgoing :name: becomes the custom emoji, next to a resolved mention', async () => {
  const raw = rawMessage({ id: 'm1', authorName: 'Zoé' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>@Zoé :dance: ok :unknown:</msg><react to="#1">:pepe_cry:</react>');
  const turns = createTurnRunner({
    hot: fakeHot(),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    emoji: fakeEmojiIndex(),
  });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent[0].content, '<@u1> <a:dance:222222222222222222> ok :unknown:');
  assert.deepEqual(channel.sent[0].allowedMentions.users, ['u1']);
  assert.deepEqual(channel.reactCalls, [{ id: 'm1', emoji: '<:pepe_cry:111111111111111111>' }]);
});

test('createTurnRunner: an unknown custom emoji reaction is dropped, a unicode one still goes through', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<react to="#1">:nope:</react><react to="#1">🔥</react>');
  const turns = createTurnRunner({
    hot: fakeHot(),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    emoji: fakeEmojiIndex(),
  });

  await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.deepEqual(channel.reactCalls, [{ id: 'm1', emoji: '🔥' }]);
});

test('createTurnRunner: features.customEmoji=false leaves :name: as text and drops a custom reaction', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<msg>ok :dance:</msg><react to="#1">:pepe_cry:</react>');
  const turns = createTurnRunner({
    hot: fakeHot({ customEmoji: false }),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    emoji: fakeEmojiIndex(),
  });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent[0].content, 'ok :dance:');
  assert.equal(channel.reactCalls.length, 0);
});

test('createTurnRunner: only a custom reaction the index does not know means outcome "skip"', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const turns = createTurnRunner({
    hot: fakeHot(),
    store: fakeStore(),
    llm: fakeLlm('<react to="#1">:nope:</react>'),
    calibrator: identityCalibrator(),
    client: fakeClient(),
    emoji: fakeEmojiIndex(),
  });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'skip');
  assert.equal(channel.reactCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Provider routing: every request says which role makes it (llm.providerByModel
// keys of the form "<prefix>@<role>").

test('createTurnRunner: the persona turn is requested as role voice, purpose reply', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlm('<skip/>');
  // No drop bar (pace.dropAfterMs): with one, the request also carries the bar's timeout and signal.
  const hot = fakeHot();
  hot.config.pace = { dropAfterMs: 0 };
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient() });
  await turns.runTurn({ channel, mode: 'interject' });
  assert.equal(llm.optionCalls.length, 1);
  assert.deepEqual(llm.optionCalls[0], { role: 'voice', purpose: 'reply' }, 'only the role and the purpose: llm.model and every other setting stay the defaults');
  assert.equal('cache' in llm.optionCalls[0], false, 'the cache policy decides: the reply is the request it marks');
});

test('createTurnRunner: the text-only retry after a 4xx image error is requested as the reply too', async () => {
  const raw = rawMessage({
    id: 'm1',
    attachments: new Map([
      ['v1', { id: 'v1', contentType: 'video/mp4', name: 'clip.mp4', url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4', duration: 34 }],
    ]),
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = fakeLlmRejectingImagesOnce(400, '<msg>ok</msg>');
  const turns = createTurnRunner({ hot: fakeHot({}), store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), imageFetcher: fakeImageFetcher() });
  await turns.runTurn({ channel, mode: 'reply', trigger: videoTrigger(raw), triggerKind: 'mention' });
  assert.equal(llm.optionCalls.length, 2);
  assert.deepEqual(llm.optionCalls.map((o) => [o?.role, o?.purpose]), [['voice', 'reply'], ['voice', 'reply']]);
});

test('createTurnRunner: the rewatch and lookup classifiers are requested as classifier.text, the turn as voice', async () => {
  const rewatch = await runRewatch();
  assert.equal(rewatch.llm.classifierCalls[0].options.role, 'classifier.text');
  assert.equal(rewatch.llm.turnCalls[0].options.role, 'voice');
  const lookup = await runLookupTurn();
  assert.equal(lookup.llm.classifierCalls[0].options.role, 'classifier.text');
  assert.equal(lookup.llm.turnCalls[0].options.role, 'voice');
});

/** A store with one link GIF `g1` in the library (no other GIF state). */
function gifStore() {
  return { ...fakeStore(), findGif: (guildId, id) => (id === 'g1' ? { id: 'g1', kind: 'link', url: 'https://tenor.com/view/chat-qui-danse-1' } : null) };
}

// ---- format.stripDashes ------------------------------------------------------------------

/** One reply turn answered with `reply` under `format`; what was posted and the logs. */
async function dashTurn(reply, format) {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const turns = createTurnRunner({ hot: fakeHot({}, {}, { format }), store: fakeStore(), llm: fakeLlm(reply), calibrator: identityCalibrator(), client: fakeClient() });
  const { logs } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
  return { sent: channel.sent.map((payload) => payload.content), logs };
}

test('runTurn: format.stripDashes on posts a reply without its em/en dashes, drops a message left empty and logs the count', async () => {
  const { sent, logs } = await dashTurn('<msg>ωραίο — πολύ–ωραίο, peut-être</msg><msg>—</msg>', { stripDashes: true });
  assert.deepEqual(sent, ['ωραίο πολύ ωραίο, peut-être']);
  const line = logs.find((entry) => entry.msg === 'turn: dashes stripped');
  assert.ok(line, 'logged once');
  assert.equal(line.count, 3);
  assert.equal(line.channel, 'c1');
  assert.equal(logs.filter((entry) => entry.msg === 'turn: dashes stripped').length, 1);
  assert.ok(!JSON.stringify(line).includes('ωραίο'), 'never the text');
});

test('runTurn: format.stripDashes false posts the dashes as written, no log', async () => {
  const { sent, logs } = await dashTurn('<msg>ωραίο — πολύ</msg>', { stripDashes: false });
  assert.deepEqual(sent, ['ωραίο — πολύ']);
  assert.equal(logs.some((entry) => entry.msg === 'turn: dashes stripped'), false);
});

// ---------------------------------------------------------------------------
// An overheard turn (triggerKind 'overheard'): a line about the persona, said
// to someone else or to the room. It posts plain like a follow-up, runs no
// trigger-only helper, and nobody asked for its drawing.

test('runTurn: an overheard or follow-up turn ignores reply="#n" and sends plain; a mention keeps it as a Discord reply', async () => {
  const cases = [
    { triggerKind: 'overheard', reply: undefined },
    { triggerKind: 'followUp', reply: undefined },
    { triggerKind: 'mention', reply: { messageReference: 'm1', failIfNotExists: false } },
  ];
  for (const c of cases) {
    const raw = rawMessage({ id: 'm1', authorName: 'Élodie' });
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    const turns = createTurnRunner({ hot: fakeHot(), store: fakeStore(), llm: fakeLlm('<msg reply="#1">ναι, εγώ</msg>'), calibrator: identityCalibrator(), client: fakeClient() });
    const { result } = await withCapturedLogs(() =>
      turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: c.triggerKind }),
    );
    assert.equal(result.outcome, 'spoke', c.triggerKind);
    assert.equal(channel.sent.length, 1, c.triggerKind);
    assert.deepEqual(channel.sent[0].reply, c.reply, c.triggerKind);
  }
});

test('runTurn: an overheard turn posts its GIF plain', async () => {
  for (const [triggerKind, reply] of [['overheard', undefined], ['mention', { messageReference: 'm1', failIfNotExists: false }]]) {
    const raw = rawMessage({ id: 'm1' });
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    const turns = createTurnRunner({ hot: fakeHot(), store: gifStore(), llm: fakeLlm('<gif reply="#1">g1</gif>'), calibrator: identityCalibrator(), client: fakeClient() });
    await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind }));
    assert.equal(channel.sent.length, 1, triggerKind);
    assert.equal(channel.sent[0].content, 'https://tenor.com/view/chat-qui-danse-1', triggerKind);
    assert.deepEqual(channel.sent[0].reply, reply, triggerKind);
  }
});

test('runTurn: an overheard turn draws unasked: a plain post, no member charged, the quota read without a member', async () => {
  const { result, channel, images } = await runDrawTurn({ answers: ['<draw reply="#1">a cat</draw>'], triggerKind: 'overheard' });

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(images.quotaCalls, [{ userId: null }]);
  assert.equal(images.generateCalls.length, 1);
  assert.equal(images.generateCalls[0].userId, null);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].files.length, 1);
  assert.equal(channel.sent[0].reply, undefined);
});

test('runTurn: an image cap on an overheard turn posts no notice and runs no second turn', async () => {
  const { result, llm, channel, logs } = await runDrawTurn({
    answers: ['<msg>κοίτα</msg><draw reply="#1">a cat</draw>', '<msg>should never be asked</msg>'],
    images: fakeImages({ error: imageCap('daily', 'image.maxPerDay', 5, 5) }),
    triggerKind: 'overheard',
  });

  assert.equal(result.outcome, 'spoke');
  assert.equal(result.drawFailed, undefined);
  assert.equal(llm.calls.length, 1, 'no drawFailed turn');
  assert.deepEqual(channel.sent.map((p) => p.content), ['κοίτα'], 'nobody asked: no notice');
  assert.ok(logs.some((l) => l.msg === 'turn: draw refused by a limit'));
});

test('runTurn: a failed drawing on an overheard turn starts no drawFailed turn and fires onIdle once, right away', async () => {
  const raw = rawMessage({ id: 'm1', authorName: 'Élodie' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = sequenceLlm(['<msg>on it</msg><draw>a cat</draw>', '<msg>should never be asked</msg>']);
  const turns = createTurnRunner({
    hot: drawHot(),
    store: fakeStore(),
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    images: fakeImages({ error: new ImageGenError('timeout') }),
  });
  let idle = 0;
  turns.setOnIdle(() => {
    idle += 1;
  });

  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'overheard' }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(result.drawFailed, 'timeout');
  assert.equal(llm.calls.length, 1, 'no drawFailed turn');
  assert.deepEqual(channel.sent.map((p) => p.content), ['on it']);
  assert.equal(idle, 1, 'the pending queue is drained after this turn');
  assert.equal(turns.isAnyBusy(), false);
  assert.ok(logs.find((l) => l.msg === 'turn: draw failed'));
  assert.equal(logs.some((l) => l.msg === 'turn: draw failure answered'), false);
});

test('runTurn: an overheard turn runs neither the re-watch nor the search classifier; a mention in the same scene runs both', async () => {
  for (const [triggerKind, expected] of [['mention', { rewatch: 1, lookup: 1 }], ['overheard', { rewatch: 0, lookup: 0 }]]) {
    const hot = rewatchHot({ webLookup: true }, {}, {
      web: { maxPerDay: 60, links: { enabled: true, maxPerTurn: 2 }, search: { enabled: true, maxPerTurn: 1, contextMessages: 50 } },
    });
    hot.prompts.lookup = LOOKUP_SYSTEM;
    const classifierCalls = { rewatch: 0, lookup: 0 };
    const llm = {
      complete: async (messages) => {
        const system = messages[0].content;
        if (system.startsWith('Pick the video')) classifierCalls.rewatch += 1;
        else if (system.startsWith('Decide whether')) classifierCalls.lookup += 1;
        else return { text: '<msg>ok</msg>', usage: {}, estimated: 10 };
        return { text: 'none', usage: {}, estimated: 5 };
      },
    };
    const scene = rewatchScene();
    const lookup = fakeLookup();
    const turns = createTurnRunner({
      hot,
      store: fakeStore(),
      llm,
      calibrator: identityCalibrator(),
      client: fakeClient(),
      describer: fakeRewatchDescriber({ va: { state: 'watched', text: 'ένα αυτοκίνητο περνά' } }),
      lookup,
      imageFetcher: fakeImageFetcher(),
    });
    const { result } = await withCapturedLogs(() =>
      turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: normalizedTrigger(scene.trigger), triggerKind }),
    );

    assert.equal(result.outcome, 'spoke', triggerKind);
    assert.deepEqual(classifierCalls, expected, triggerKind);
    assert.equal(lookup.searchCalls.length, 0, triggerKind);
  }
});

// --- another channel pulled into a turn (<channel_view>): the inputs ----------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Other channels of the guild, snowflake-shaped: a `<#id>` mention is only read for such ids.
const DIARY = '100000000000000002';
const NOTES = '100000000000000003';

/** A raw message of channel `channelId`; `raw` is Discord's own text (`<#id>` tokens), `content` the clean one. */
function lineIn(channelId, { raw, ...fields }) {
  const message = { ...rawMessage(fields), channelId };
  if (raw !== undefined) message.content = raw;
  return message;
}

/**
 * Another text channel of `turnChannel`'s guild the bot may read, holding `messages`; its newest
 * message is at `lastTs` (a neighbour when within the last hour of NOW). `readOnly`: the bot
 * cannot send there. `fetchFails`: every history fetch throws. Records every fetch in `fetches`.
 */
function addChannel(turnChannel, { id, name, messages = [], lastTs = messages.at(-1)?.createdTimestamp ?? NOW - 3 * HOUR, readOnly = false, fetchFails = false }) {
  const base = fakeTurnChannel({ id, name, historyMessages: messages });
  const fetches = [];
  const other = {
    ...base,
    guild: turnChannel.guild,
    isTextBased: () => true,
    isThread: () => false,
    lastMessageId: SnowflakeUtil.generate({ timestamp: lastTs }).toString(),
    permissionsFor: () => ({ has: (flag) => !readOnly || flag !== PermissionFlagsBits.SendMessages }),
    fetches,
    messages: {
      cache: new Map(),
      fetch: async (arg) => {
        fetches.push(arg);
        if (fetchFails) throw new Error('fixture: fetch failed');
        return base.messages.fetch(arg);
      },
    },
  };
  turnChannel.guild.channels.cache.set(id, other);
  return other;
}

/** The diary channel's lines: two by Éloïse, `ago` before NOW, the second one with a picture. */
function diaryLines(ago = 3 * HOUR) {
  const wall = { id: 'dp1', contentType: 'image/png', name: 'wall.png', url: 'https://cdn.discordapp.com/x/wall.png' };
  return [
    lineIn(DIARY, { id: 'd1', authorId: 'u3', authorName: 'Éloïse', ts: NOW - ago, content: 'σήμερα έβαψα τον τοίχο μπλε' }),
    lineIn(DIARY, { id: 'd2', authorId: 'u3', authorName: 'Éloïse', ts: NOW - ago + MINUTE, content: 'και μετά κοιμήθηκα', attachments: new Map([['dp1', wall]]) }),
  ];
}

/**
 * A turn in #general (c1) whose history holds Bob's line naming #diary (DIARY) -- a real `<#id>`
 * token unless `mention` is false -- and Alice's call after it. The guild holds the diary channel.
 */
function pullScene({ features = {}, context = {}, config = {}, bot = {}, mention = true, diary = {}, between = [], routeChannels, describer, images, store = fakeStore(), llm = fakeLlm('<msg>ok</msg>') } = {}) {
  const asked = lineIn('c1', { id: 'm1', authorId: 'u2', authorName: 'Bob', ts: NOW - 5 * MINUTE, content: 'είδες το #diary;', raw: mention ? `είδες το <#${DIARY}>;` : 'είδες το #diary;' });
  const call = lineIn('c1', { id: 'm9', ts: NOW - 1000, content: 'λοιπόν;' });
  const channel = fakeTurnChannel({ historyMessages: [asked, ...between, call] });
  const other = addChannel(channel, { id: DIARY, name: 'diary', messages: diaryLines(), ...diary });
  const hot = fakeHot(features, bot, config);
  hot.config.context = { ...hot.config.context, ...context };
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), describer, routeChannels, images, imageFetcher: fakeImageFetcher(), now: () => NOW });
  return { channel, other, hot, llm, store, turns, trigger: normalizedTrigger(call) };
}

/** Makes the fixture channel `channel` a text channel listed in its own guild, as a main channel must be. */
function registerTextChannel(channel) {
  channel.isTextBased = () => true;
  channel.isThread = () => false;
  channel.guild.channels.cache.set(channel.id, channel);
  return channel;
}

/** A describer like pullDescriber whose cache read throws (a corrupt media cache). */
function throwingCacheDescriber() {
  return {
    ...pullDescriber(),
    cachedDescriptions: () => {
      throw new Error('fixture: corrupt media cache');
    },
  };
}

/** A store like fakeStore whose ring of calls (`state.json` `elsewherePings`) cannot be read. */
function unreadableRingStore() {
  const store = fakeStore();
  Object.defineProperty(store.state.data, 'elsewherePings', {
    get() {
      throw new Error('fixture: unreadable state');
    },
  });
  return store;
}

/** The `<channel_view>` body of the first request, or null when the request has none. */
function channelViewOf(llm) {
  const text = userText(llm);
  return text.includes('<channel_view>') ? text.split('<channel_view>\n')[1].split('\n</channel_view>')[0] : null;
}

/** A describer with an empty cache whose describeMany captions every item, recording each call in `calls` and `events`. */
function pullDescriber(events = []) {
  const calls = [];
  return {
    calls,
    events,
    cachedDescriptions: () => new Map(),
    describeMany: async (guildId, items, options) => {
      const ids = items.map((item) => item.itemId);
      calls.push({ ids, options });
      events.push(`describe:${ids.join(',')}`);
      return { descriptions: new Map(items.map((item) => [item.itemId, `caption of ${item.itemId}`])), newCount: items.length };
    },
  };
}

/** The describeMany calls that asked for item `itemId`. */
function callsFor(describer, itemId) {
  return describer.calls.filter((call) => call.ids.includes(itemId));
}

test('runTurn: an explicit channel mention in the last scanMessages pulls that channel', async () => {
  const { turns, channel, other, llm, trigger } = pullScene();

  const { result } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' }));

  assert.equal(result.outcome, 'spoke');
  const view = channelViewOf(llm);
  assert.ok(view, 'the request carries <channel_view>');
  assert.ok(view.includes('channel #diary'), view);
  assert.ok(view.includes('σήμερα έβαψα τον τοίχο μπλε') && view.includes('και μετά κοιμήθηκα'), view);
  assert.ok(view.includes('#3 ') && view.includes('#4 '), 'the pulled lines are numbered on after the chat');
  assert.equal(other.fetches.length, 1, 'one page of the pulled channel');

  // A mention older than the scanned span pulls nothing.
  const filler = lineIn('c1', { id: 'm5', authorId: 'u2', authorName: 'Bob', ts: NOW - 4 * MINUTE, content: 'τέλος πάντων' });
  const older = pullScene({ context: { pull: { scanMessages: 1 } }, between: [filler] });
  await withCapturedLogs(() => older.turns.runTurn({ channel: older.channel, mode: 'reply', trigger: older.trigger, triggerKind: 'mention' }));
  assert.equal(channelViewOf(older.llm), null);
  assert.equal(older.other.fetches.length, 0);
});

test('runTurn: a channel mention in the trigger itself pulls that channel', async () => {
  const { turns, channel, llm, trigger } = pullScene({ mention: false });

  await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: { ...trigger, mentionedChannelIds: [DIARY] }, triggerKind: 'mention' }));

  assert.ok(channelViewOf(llm)?.includes('σήμερα έβαψα τον τοίχο μπλε'));
});

test('runTurn: a spontaneous turn pulls a channel mentioned in its history', async () => {
  const describer = pullDescriber();
  const { turns, channel, llm } = pullScene({ features: { mediaDescriptions: true }, describer });
  const seen = [];

  const { result } = await withCapturedLogs(() =>
    turns.runTurn({
      channel,
      mode: 'auto',
      chooseMode: (history, now, context) => {
        seen.push({ pulled: context.pulled, describeCalls: describer.calls.length });
        return 'interject';
      },
    }),
  );

  assert.equal(result.outcome, 'spoke');
  assert.ok(channelViewOf(llm)?.includes('και μετά κοιμήθηκα'));
  // The mention is pulled before the mode is chosen, and the chooser sees it.
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].pulled.map((entry) => [entry.channelId, entry.reason]), [[DIARY, 'mention']]);
  assert.equal(seen[0].describeCalls, 0, 'no caption was asked before the chooser chose');
});

test('runTurn: features.channelPull off pulls nothing for a mention and builds the request as without the channel', async () => {
  const off = pullScene({ features: { channelPull: false } });
  const { logs } = await withCapturedLogs(() => off.turns.runTurn({ channel: off.channel, mode: 'reply', trigger: off.trigger, triggerKind: 'mention' }));

  assert.equal(off.other.fetches.length, 0, 'the mentioned channel is never fetched');
  assert.equal(channelViewOf(off.llm), null);
  assert.equal(logs.some((l) => l.msg.startsWith('pull: ')), false);

  // The same scene with no mention at all: byte for byte the same request.
  const plain = pullScene({ features: { channelPull: false }, mention: false });
  await withCapturedLogs(() => plain.turns.runTurn({ channel: plain.channel, mode: 'reply', trigger: plain.trigger, triggerKind: 'mention' }));
  assert.deepEqual(off.llm.calls[0], plain.llm.calls[0]);
});

test('runTurn: with nothing to pull the request is the one built without the pull machinery', async () => {
  const hook = [];
  const none = pullScene({ mention: false, routeChannels: async (args) => (hook.push(args), []) });
  const off = pullScene({ mention: false, features: { channelPull: false } });

  const { logs } = await withCapturedLogs(() => none.turns.runTurn({ channel: none.channel, mode: 'reply', trigger: none.trigger, triggerKind: 'mention' }));
  await withCapturedLogs(() => off.turns.runTurn({ channel: off.channel, mode: 'reply', trigger: off.trigger, triggerKind: 'mention' }));

  assert.equal(hook.length, 1, 'the hook was asked');
  assert.deepEqual(none.llm.calls[0], off.llm.calls[0]);
  assert.equal(logs.some((l) => l.msg.startsWith('pull: ')), false);
  const answered = logs.find((l) => l.msg === 'turn: model answered');
  assert.equal('source' in answered || 'pulled' in answered || 'focus' in answered, false, 'no pull fields on an ordinary turn');
});

test('runTurn: route hook ids are pulled after explicit mentions', async () => {
  const hookCalls = [];
  const scene = pullScene({
    context: { pull: { maxChannels: 2 } },
    routeChannels: async (args) => {
      hookCalls.push(args);
      return [NOTES, DIARY];
    },
  });
  addChannel(scene.channel, {
    id: NOTES,
    name: 'notes',
    messages: [lineIn(NOTES, { id: 'n1', authorId: 'u4', authorName: 'Zoë', ts: NOW - 2 * HOUR, content: 'σημειώσεις για αύριο' })],
  });

  await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  assert.equal(hookCalls.length, 1);
  assert.deepEqual(hookCalls[0].history.map((m) => m.id), ['m1', 'm9']);
  const view = channelViewOf(scene.llm);
  assert.ok(view.indexOf('channel #diary') < view.indexOf('channel #notes'), view);
  assert.ok(view.includes('σημειώσεις για αύριο'));
});

test('runTurn: the route hook is not asked once the mentions fill every slot, nor while features.channelPull is off', async () => {
  for (const features of [{}, { channelPull: false }]) {
    let asked = 0;
    const scene = pullScene({
      features,
      routeChannels: async () => {
        asked += 1;
        return [];
      },
    });
    await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));
    assert.equal(asked, 0, JSON.stringify(features));
  }
});

test('runTurn: context.pull.maxChannels caps the pulled channels, the newest mention first', async () => {
  const newer = lineIn('c1', { id: 'm5', authorId: 'u2', authorName: 'Bob', ts: NOW - 4 * MINUTE, content: 'και το #notes', raw: `και το <#${NOTES}>` });
  const scene = pullScene({ between: [newer] });
  const notes = addChannel(scene.channel, {
    id: NOTES,
    name: 'notes',
    messages: [lineIn(NOTES, { id: 'n1', authorId: 'u4', authorName: 'Zoë', ts: NOW - 2 * HOUR, content: 'σημειώσεις για αύριο' })],
  });

  await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  const view = channelViewOf(scene.llm);
  assert.ok(view.includes('channel #notes') && !view.includes('channel #diary'), view);
  assert.equal(scene.other.fetches.length, 0);
  assert.equal(notes.fetches.length, 1);
});

test('runTurn: a pulled channel is left out of the neighbours', async () => {
  const diary = { messages: diaryLines(10 * MINUTE) };
  const pulled = pullScene({ diary });
  await withCapturedLogs(() => pulled.turns.runTurn({ channel: pulled.channel, mode: 'reply', trigger: pulled.trigger, triggerKind: 'mention' }));

  assert.ok(channelViewOf(pulled.llm)?.includes('σήμερα έβαψα τον τοίχο μπλε'));
  assert.equal(userText(pulled.llm).includes('# diary'), false, 'not shown again among the neighbours');

  // Not pulled, the same channel is an ordinary neighbour.
  const neighbour = pullScene({ diary, features: { channelPull: false } });
  await withCapturedLogs(() => neighbour.turns.runTurn({ channel: neighbour.channel, mode: 'reply', trigger: neighbour.trigger, triggerKind: 'mention' }));
  assert.ok(otherChannelsSent(neighbour.llm).includes('# diary'));
});

test('runTurn: a noticed turn passes the pulled source to chooseMode', async () => {
  const seen = [];
  const { turns, channel, llm } = pullScene({ mention: false });

  const { result } = await withCapturedLogs(() =>
    turns.runTurn({
      channel,
      mode: 'auto',
      source: { channelId: DIARY, reason: 'noticed' },
      chooseMode: (history, now, context) => {
        seen.push({ history, now, context });
        return null;
      },
    }),
  );

  assert.equal(result.outcome, 'not-now');
  assert.equal(llm.calls.length, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].now, NOW);
  assert.deepEqual(seen[0].history.map((m) => m.id), ['m1', 'm9'], "the chooser still gets the turn channel's history");
  const [source] = seen[0].context.pulled;
  assert.equal(seen[0].context.pulled.length, 1);
  assert.equal(source.channelId, DIARY);
  assert.equal(source.reason, 'noticed');
  assert.deepEqual(source.messages.map((m) => m.id), ['d1', 'd2']);
});

test('runTurn: a routed turn whose source cannot be pulled ends in error, a noticed one in not-now', async () => {
  for (const [reason, outcome] of [['routed', 'error'], ['noticed', 'not-now']]) {
    const { turns, channel, llm } = pullScene({ mention: false });
    let chosen = 0;
    const { result, logs } = await withCapturedLogs(() =>
      turns.runTurn({
        channel,
        mode: reason === 'routed' ? 'reply' : 'auto',
        source: { channelId: 'c9', reason },
        chooseMode: () => {
          chosen += 1;
          return 'elsewhere';
        },
      }),
    );

    assert.equal(result.outcome, outcome, reason);
    assert.equal(llm.calls.length, 0, reason);
    assert.equal(chosen, 0, `${reason}: no chooser without the source`);
    assert.equal(turns.isBusy('c1'), false);
    assert.ok(logs.some((l) => l.msg === 'pull: skipped' && l.source === 'c9' && l.reason === 'not-found'), reason);
    const unavailable = logs.find((l) => l.msg === 'turn: source unavailable');
    if (reason === 'routed') assert.deepEqual([unavailable.channel, unavailable.source, unavailable.reason], ['c1', 'c9', 'not-found']);
    else assert.equal(unavailable, undefined);
  }
});

test('runTurn: fresh captions for a pulled channel are asked only once the turn is certain to run', async () => {
  // A chooser that says not-now: nothing is asked, the cache alone was read.
  const quiet = pullDescriber();
  const notNow = pullScene({ features: { mediaDescriptions: true }, describer: quiet });
  const { result } = await withCapturedLogs(() => notNow.turns.runTurn({ channel: notNow.channel, mode: 'auto', chooseMode: () => null }));
  assert.equal(result.outcome, 'not-now');
  assert.equal(quiet.calls.length, 0);

  // A chooser that picks a mode: the caption is asked after it chose, and reaches the block.
  const events = [];
  const chosen = pullDescriber(events);
  const live = pullScene({ features: { mediaDescriptions: true }, describer: chosen });
  await withCapturedLogs(() =>
    live.turns.runTurn({
      channel: live.channel,
      mode: 'auto',
      chooseMode: () => {
        events.push('chooser');
        return 'interject';
      },
    }),
  );
  assert.deepEqual(callsFor(chosen, 'dp1').map((call) => call.options), [{ maxNew: 1 }]);
  assert.ok(events.indexOf('chooser') < events.indexOf('describe:dp1'), events.join(' '));
  assert.ok(channelViewOf(live.llm).includes('caption of dp1'));

  // No chooser at all: asked with the fetch, once.
  const direct = pullDescriber();
  const reply = pullScene({ features: { mediaDescriptions: true }, describer: direct });
  await withCapturedLogs(() => reply.turns.runTurn({ channel: reply.channel, mode: 'reply', trigger: reply.trigger, triggerKind: 'mention' }));
  assert.equal(callsFor(direct, 'dp1').length, 1);
  assert.ok(channelViewOf(reply.llm).includes('caption of dp1'));
});

test('runTurn: a failed, refused or throwing pull never fails the turn', async () => {
  const failing = pullScene({ diary: { fetchFails: true } });
  const failed = await withCapturedLogs(() => failing.turns.runTurn({ channel: failing.channel, mode: 'reply', trigger: failing.trigger, triggerKind: 'mention' }));
  assert.equal(failed.result.outcome, 'spoke');
  assert.equal(channelViewOf(failing.llm), null);
  assert.ok(failed.logs.some((l) => l.msg === 'pull: skipped' && l.source === DIARY && l.reason === 'fetch-failed'));

  const denied = pullScene({ bot: { channels: { deny: [DIARY] } } });
  const refused = await withCapturedLogs(() => denied.turns.runTurn({ channel: denied.channel, mode: 'reply', trigger: denied.trigger, triggerKind: 'mention' }));
  assert.equal(refused.result.outcome, 'spoke');
  assert.equal(denied.other.fetches.length, 0, 'a refused channel is never fetched');
  const skipped = refused.logs.find((l) => l.msg === 'pull: skipped');
  assert.deepEqual([skipped.channel, skipped.source, skipped.reason, skipped.pullReason], ['c1', DIARY, 'denied', 'mention']);

  const throwing = pullScene({
    mention: false,
    routeChannels: async () => {
      throw new Error('fixture: route classifier down');
    },
  });
  const thrown = await withCapturedLogs(() => throwing.turns.runTurn({ channel: throwing.channel, mode: 'reply', trigger: throwing.trigger, triggerKind: 'mention' }));
  assert.equal(thrown.result.outcome, 'spoke');
  assert.ok(thrown.logs.some((l) => l.msg === 'pull: route failed' && l.channel === 'c1'));
});

test('runTurn: a private chat whose partner cannot be fetched as a guild member never pulls a channel', async () => {
  let asked = 0;
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', content: 'hey' });
  const channel = fakeTurnChannel({ id: 'dm1', dm: true, historyMessages: [raw] });
  const llm = sequenceLlm(['<msg>hi</msg>']);
  const turns = createTurnRunner({
    hot: privateHot(),
    store: privateStore(),
    llm,
    calibrator: identityCalibrator(),
    client: guildClient(),
    images: fakeImages(),
    routeChannels: async () => {
      asked += 1;
      return [DIARY];
    },
  });

  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, guildId: 'g1', mode: 'reply', trigger: { ...normalizedTrigger(raw), mentionedChannelIds: [DIARY] }, triggerKind: 'private' }),
  );

  assert.equal(result.outcome, 'spoke');
  assert.equal(asked, 0);
  assert.equal(userTextOf(llm.calls[0]).includes('<channel_view>'), false);
  assert.equal(logs.some((l) => l.msg.startsWith('pull: ')), false);
});

/**
 * A private chat (dm1) served for g1, whose guild holds #diary (DIARY). Alice (u1), the partner,
 * is fetched from the guild (`memberFetches`); `canView`: whether she has View Channel on #diary.
 * `mention`: her call names #diary with a real `<#id>`.
 */
function privatePullScene({ features = {}, canView = true, mention = false, routeChannels } = {}) {
  const server = fakeTurnChannel({ id: 'c1' });
  const guild = server.guild;
  const partner = { id: 'u1', guild };
  const memberFetches = [];
  guild.members.fetch = async (id) => {
    memberFetches.push(id);
    return partner;
  };
  const diary = addChannel(server, { id: DIARY, name: 'diary', messages: diaryLines() });
  const botView = diary.permissionsFor;
  diary.permissionsFor = (target) => (target === partner ? { has: (flag) => canView || flag !== PermissionFlagsBits.ViewChannel } : botView(target));
  const call = lineIn('dm1', { id: 'p1', authorId: 'u1', authorName: 'Alice', ts: NOW - 1000, content: 'τι γράφει το ημερολόγιο;' });
  const channel = fakeTurnChannel({ id: 'dm1', dm: true, historyMessages: [call] });
  const llm = sequenceLlm(['<msg>ok</msg>']);
  const client = fakeClient({ guilds: { cache: new Map([['g1', guild]]) } });
  const turns = createTurnRunner({
    hot: privateHot(features),
    store: privateStore(),
    llm,
    calibrator: identityCalibrator(),
    client,
    images: fakeImages(),
    imageFetcher: fakeImageFetcher(),
    routeChannels,
    now: () => NOW,
  });
  const trigger = { ...normalizedTrigger(call), ...(mention ? { mentionedChannelIds: [DIARY] } : {}) };
  const run = () => withCapturedLogs(() => turns.runTurn({ channel, guildId: 'g1', mode: 'reply', trigger, triggerKind: 'private' }));
  return { channel, diary, guild, partner, memberFetches, llm, run };
}

/** A route hook that names #diary and records its arguments. */
function diaryHook() {
  const calls = [];
  const hook = async (args) => {
    calls.push(args);
    return [DIARY];
  };
  return { calls, hook };
}

test('runTurn: a private chat asks the route hook for its partner and pulls the picked channel the partner can view', async () => {
  const { calls, hook } = diaryHook();
  const scene = privatePullScene({ routeChannels: hook });

  const { result, logs } = await scene.run();

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(scene.memberFetches, ['u1']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, scene.channel);
  assert.equal(calls[0].guild, scene.guild, 'judged in the served guild');
  assert.equal(calls[0].partner, scene.partner);
  assert.equal(calls[0].triggerKind, 'private');
  assert.deepEqual(calls[0].history.map((m) => m.id), ['p1']);
  assert.ok(scene.diary.fetches.length > 0, 'the picked channel was fetched');
  const pulled = logs.find((l) => l.msg === 'pull: channel');
  assert.deepEqual([pulled?.channel, pulled?.source, pulled?.pullReason], ['dm1', DIARY, 'route']);
});

test('runTurn: a private chat never pulls a picked channel its partner cannot view', async () => {
  const { calls, hook } = diaryHook();
  const scene = privatePullScene({ routeChannels: hook, canView: false });

  const { result, logs } = await scene.run();

  assert.equal(result.outcome, 'spoke');
  assert.equal(calls.length, 1);
  assert.deepEqual(scene.diary.fetches, []);
  assert.equal(logs.some((l) => l.msg === 'pull: channel'), false);
  const skipped = logs.find((l) => l.msg === 'pull: skipped');
  assert.deepEqual([skipped?.source, skipped?.reason, skipped?.pullReason], [DIARY, 'audience', 'route']);
});

test('runTurn: a private chat pulls an explicitly mentioned channel only when its partner can view it', async () => {
  const seen = await privatePullScene({ mention: true }).run();
  assert.ok(seen.logs.some((l) => l.msg === 'pull: channel' && l.source === DIARY && l.pullReason === 'mention'));

  const hidden = privatePullScene({ mention: true, canView: false });
  const { logs } = await hidden.run();
  assert.deepEqual(hidden.diary.fetches, []);
  const skipped = logs.find((l) => l.msg === 'pull: skipped');
  assert.deepEqual([skipped?.source, skipped?.reason, skipped?.pullReason], [DIARY, 'audience', 'mention']);
});

test('runTurn: features.privateLikeServer off -- a private chat asks no route hook, pulls no mention and fetches no partner', async () => {
  const { calls, hook } = diaryHook();
  const scene = privatePullScene({ features: { privateLikeServer: false }, mention: true, routeChannels: hook });

  const { result, logs } = await scene.run();

  assert.equal(result.outcome, 'spoke');
  assert.equal(calls.length, 0);
  assert.deepEqual(scene.memberFetches, []);
  assert.deepEqual(scene.diary.fetches, []);
  assert.equal(logs.some((l) => l.msg.startsWith('pull: ')), false);
});

test('runTurn: a private chat whose partner left the guild pulls nothing and logs the failed fetch', async () => {
  const { calls, hook } = diaryHook();
  const scene = privatePullScene({ mention: true, routeChannels: hook });
  scene.guild.members.fetch = async () => {
    throw new Error('Unknown Member');
  };

  const { result, logs } = await scene.run();

  assert.equal(result.outcome, 'spoke');
  assert.equal(calls.length, 0);
  assert.deepEqual(scene.diary.fetches, []);
  const failed = logs.find((l) => l.msg === 'turn: partner failed');
  assert.deepEqual([failed?.guildId, failed?.userId], ['g1', 'u1']);
});

/**
 * A call to the persona in the read-only #diary (c2), answered in #general (c1): the source holds
 * the diary lines, `before`, Alice's call and `after`; #general holds one line by Bob.
 */
function routedScene({
  features = {},
  hot = fakeHot(features),
  describer,
  llm = fakeLlm('<msg>ok</msg>'),
  lookup,
  callAttachments,
  chat = [lineIn('c1', { id: 'm1', authorId: 'u2', authorName: 'Bob', ts: NOW - 5 * MINUTE, content: 'καλημέρα σε όλους' })],
  callTs = NOW - 2 * MINUTE,
  before = [],
  after = [],
  routeChannels,
  store = fakeStore(),
  client = fakeClient(),
  images,
} = {}) {
  const channel = fakeTurnChannel({ historyMessages: chat });
  const call = lineIn(DIARY, { id: 'd3', ts: callTs, content: '@Bot τι λες για τον τοίχο;', attachments: callAttachments });
  const other = addChannel(channel, { id: DIARY, name: 'diary', messages: [...diaryLines(), ...before, call, ...after], readOnly: true });
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client, describer, lookup, routeChannels, images, imageFetcher: fakeImageFetcher(), now: () => NOW });
  const trigger = { ...normalizedTrigger(call), mentionedUserIds: ['self-id'] };
  const params = { channel, mode: 'reply', trigger, triggerKind: 'mention', source: { channelId: DIARY, reason: 'routed' } };
  return { channel, other, hot, llm, store, turns, trigger, params };
}

/** Makes #general (c1) the scene's main channel: `memory.mainChannelIds` and a usable text channel. */
function asMainChannel(scene) {
  registerTextChannel(scene.channel);
  scene.hot.config.memory = { ...scene.hot.config.memory, mainChannelIds: ['c1'] };
  return scene;
}

test('runTurn: a routed turn pulls its source with the call and builds the request in the destination', async () => {
  const scene = asMainChannel(routedScene());

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  const view = channelViewOf(scene.llm);
  assert.ok(view.includes('@Bot τι λες για τον τοίχο;') && view.includes('σήμερα έβαψα τον τοίχο μπλε'), view);
  assert.ok(view.includes(labels.server.readOnly), 'the source is marked read-only');
  // The request knows the turn's source: the task says where the call came from and where the words go.
  assert.ok(userText(scene.llm).includes(fill(labels.elsewhere.called, { channel: 'diary', destination: 'general' })));
  const pulled = logs.find((l) => l.msg === 'pull: channel');
  assert.deepEqual([pulled.channel, pulled.source, pulled.pullReason], ['c1', DIARY, 'routed']);
  const answered = logs.find((l) => l.msg === 'turn: model answered');
  assert.deepEqual([answered.channel, answered.source, answered.pulled], ['c1', DIARY, 1]);
  assert.equal(answered.budget.pulled.kept, 1, 'the pulled block is in the budget');
  assert.equal('focus' in answered, false);
});

test('runTurn: a routed call older than the window is still shown with its source', async () => {
  // Five newer lines fill the window; the call, three hours old, is outside it.
  const after = [0, 1, 2, 3, 4].map((i) =>
    lineIn(DIARY, { id: `d${4 + i}`, authorId: 'u4', authorName: 'Zoë', ts: NOW - 30 * MINUTE + i * MINUTE, content: `γραμμή ${i + 1} για τον κήπο` }),
  );
  const scene = routedScene({ callTs: NOW - 3 * HOUR + 2 * MINUTE, after });

  const { result } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  const view = channelViewOf(scene.llm);
  assert.ok(view.includes('γραμμή 5 για τον κήπο'), view);
  assert.ok(view.includes('@Bot τι λες για τον τοίχο;'), 'the call is shown although the window left it out');
  assert.equal(view.includes('σήμερα έβαψα τον τοίχο μπλε'), false, 'the older lines stay out of the window');
});

test("runTurn: a pulled channel shows the ring's earlier unanswered call with its mark", async () => {
  const earlier = lineIn(DIARY, { id: 'd0', authorId: 'u4', authorName: 'Zoë', ts: NOW - 5 * HOUR, content: '@Bot είσαι εδώ;' });
  const diary = { messages: [earlier, ...diaryLines()] };
  const context = { pull: { minMessages: 1 } };
  const earlierHeader = labels.pull.earlierPings.split('{date}')[0];

  const store = fakeStore();
  store.state.data.elsewherePings = [{ messageId: 'd0', channelId: DIARY, ts: NOW - 5 * HOUR, answeredAt: null, skippedAt: null }];
  const ringed = pullScene({ store, context, diary });
  await withCapturedLogs(() => ringed.turns.runTurn({ channel: ringed.channel, mode: 'reply', trigger: ringed.trigger, triggerKind: 'mention' }));
  const view = channelViewOf(ringed.llm);
  assert.ok(view.includes('@Bot είσαι εδώ;'), view);
  assert.ok(view.includes(earlierHeader), view);
  assert.ok(view.includes(labels.pull.pingUnanswered), view);

  // Without the ring entry the old line is outside the window and nothing is marked.
  const plain = pullScene({ context, diary });
  await withCapturedLogs(() => plain.turns.runTurn({ channel: plain.channel, mode: 'reply', trigger: plain.trigger, triggerKind: 'mention' }));
  const plainView = channelViewOf(plain.llm);
  assert.equal(plainView.includes('@Bot είσαι εδώ;') || plainView.includes(earlierHeader) || plainView.includes(labels.pull.pingUnanswered), false, plainView);
});

test("runTurn: on a routed turn the search classifier reads the source channel's lines", async () => {
  const llm = lookupLlm('none');
  const scene = routedScene({ hot: lookupHot(), llm, lookup: fakeLookup() });

  await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(llm.classifierCalls.length, 1);
  const user = llm.classifierCalls[0].messages[1].content;
  assert.ok(user.includes('σήμερα έβαψα τον τοίχο μπλε'), user);
  assert.ok(!user.includes('καλημέρα σε όλους'), "the destination's chat is not the call's context");
  assert.ok(user.includes('<candidate>\nAlice: @Bot τι λες για τον τοίχο;'), user);
});

test("runTurn: a routed call's pictures are captioned through the pull, never as the chat's attached pictures", async () => {
  const photo = { id: 'cp1', contentType: 'image/png', name: 'photo.png', url: 'https://cdn.discordapp.com/x/photo.png' };
  const describer = pullDescriber();
  const scene = routedScene({ features: { mediaDescriptions: true }, describer, callAttachments: new Map([['cp1', photo]]) });
  scene.params.trigger = { ...scene.params.trigger, attachments: [{ id: 'cp1', kind: 'image', url: photo.url, name: 'photo.png' }] };

  await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.deepEqual(callsFor(describer, 'cp1').map((call) => call.options), [{ maxNew: 1 }]);
  assert.equal(scene.llm.calls[0][1].content.some((p) => p.type === 'image_url'), false, 'nothing is attached for vision');
  assert.ok(channelViewOf(scene.llm).includes('caption of cp1'));
});

test('runTurn: a focus line reaches the task', async () => {
  const { turns, channel, llm } = pullScene({ mention: false });
  const focus = normalizedTrigger(lineIn('c1', { id: 'm1', authorId: 'u2', authorName: 'Bob', ts: NOW - 5 * MINUTE, content: 'είδες το #diary;' }));

  await withCapturedLogs(() => turns.runTurn({ channel, mode: 'interject', focus }));

  assert.ok(userText(llm).includes(fill(labels.room.focus, { author: 'Bob', target: '#1' })));
});

test('runTurn: a read-only neighbour is marked in the server map', async () => {
  const store = fakeStore({ channels: [{ id: DIARY, name: 'diary', lastMessageAt: NOW - 10 * MINUTE, days: {} }] });
  for (const readOnly of [true, false]) {
    const scene = pullScene({ features: { channelPull: false }, diary: { messages: diaryLines(10 * MINUTE), readOnly }, store });
    await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));
    const server = userText(scene.llm).split('<server>\n')[1].split('\n</server>')[0];
    assert.ok(server.includes('diary'), server);
    assert.equal(server.includes(labels.server.readOnly), readOnly, server);
  }
});

test('runTurn: senses name the main channel where calls from read-only channels are answered', async () => {
  for (const [features, expected] of [[{}, true], [{ elsewhere: false }, false]]) {
    const scene = pullScene({ mention: false, features, config: { memory: { mainChannelIds: ['c1'] } } });
    registerTextChannel(scene.channel);
    await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));
    assert.equal(userText(scene.llm).includes(fill(labels.senses.elsewhere, { destination: 'general' })), expected, JSON.stringify(features));
  }
});

test('runTurn: senses name only a usable main channel, the first one in list order', async () => {
  const sensesPrefix = labels.senses.elsewhere.split('{destination}')[0];
  const cases = [
    { name: 'cannot send', main: ['c5'], add: (scene) => addChannel(scene.channel, { id: 'c5', name: 'lounge', readOnly: true }), expected: null },
    { name: 'thread', main: ['c5'], add: (scene) => Object.assign(addChannel(scene.channel, { id: 'c5', name: 'lounge' }), { isThread: () => true }), expected: null },
    { name: 'denied', main: ['c5'], bot: { channels: { deny: ['c5'] } }, add: (scene) => addChannel(scene.channel, { id: 'c5', name: 'lounge' }), expected: null },
    {
      name: 'first usable',
      main: ['c5', 'c6'],
      add: (scene) => {
        addChannel(scene.channel, { id: 'c5', name: 'lounge', readOnly: true });
        addChannel(scene.channel, { id: 'c6', name: 'hall' });
      },
      expected: 'hall',
    },
  ];
  for (const { name, main, bot = {}, add, expected } of cases) {
    const scene = pullScene({ mention: false, bot, config: { memory: { mainChannelIds: main } } });
    add(scene);
    await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));
    const text = userText(scene.llm);
    if (expected) assert.ok(text.includes(fill(labels.senses.elsewhere, { destination: expected })), name);
    else assert.equal(text.includes(sensesPrefix), false, name);
  }
});

test('usableDestination: the first usable main channel, never the excepted one; off and none carry their codes', () => {
  const general = registerTextChannel(fakeTurnChannel());
  const hall = addChannel(general, { id: 'c6', name: 'hall' });
  const config = { bot: {}, features: {}, memory: { mainChannelIds: ['c1', 'c6'] } };

  assert.deepEqual(usableDestination(general.guild, config), { channel: general, reason: null });
  assert.deepEqual(usableDestination(general.guild, config, { exceptId: 'c1' }), { channel: hall, reason: null });
  assert.deepEqual(usableDestination(general.guild, { ...config, features: { elsewhere: false } }), { channel: null, reason: 'off' });
  assert.deepEqual(usableDestination(general.guild, { ...config, memory: { mainChannelIds: [] } }), { channel: null, reason: 'no-destination' });
  assert.deepEqual(usableDestination(null, config), { channel: null, reason: 'no-destination' }, 'a private chat has none');
});

test("runTurn: on a routed turn the re-watch classifier is not asked about the destination's videos", async () => {
  // #general holds a watched clip and one that did not load; the call in #diary asks to try again.
  const chat = () => [videoAttachmentRaw('m1', NOW - 10 * MINUTE, 'va', 'clip.mp4'), videoAttachmentRaw('m2', NOW - 8 * MINUTE, 'vb', 'other.mp4')];
  const scene = (llm, describer) => routedScene({ hot: rewatchHot(), llm, describer, chat: chat() });
  const states = { va: { state: 'watched', text: 'ένα αυτοκίνητο περνά' }, vb: { state: 'error' } };

  const llm = rewatchLlm('1 | retry');
  const describer = fakeRetryDescriber(states);
  const routed = scene(llm, describer);
  const { result, logs } = await withCapturedLogs(() => routed.turns.runTurn(routed.params));

  assert.equal(result.outcome, 'spoke');
  assert.equal(llm.classifierCalls.length, 0, 'no re-watch classifier request');
  assert.equal(describer.retryCalls.length + describer.rewatchCalls.length, 0, 'nothing watched again');
  const skipped = logs.find((l) => l.msg === 'rewatch: skipped');
  assert.deepEqual([skipped.channel, skipped.reason], ['c1', 'routed']);

  // The same call without its source (an ordinary turn here) is offered the videos.
  const controlLlm = rewatchLlm('1 | retry');
  const control = scene(controlLlm, fakeRetryDescriber(states));
  await withCapturedLogs(() => control.turns.runTurn({ ...control.params, source: null }));
  assert.equal(controlLlm.classifierCalls.length, 1);
});

test("runTurn: on a routed turn the route hook reads the source channel's lines", async () => {
  const hookCalls = [];
  const scene = routedScene({
    routeChannels: async (args) => {
      hookCalls.push(args);
      return [];
    },
  });
  scene.hot.config.context.pull = { maxChannels: 2 };

  const { result } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  assert.equal(hookCalls.length, 1);
  assert.equal(hookCalls[0].channel, scene.channel, 'asked for the destination');
  assert.deepEqual(hookCalls[0].history.map((m) => m.id), ['d1', 'd2', 'd3'], "the call's channel, not the destination's chat");
});

test('runTurn: the drawFailed turn after a pull asks neither the route hook nor a fresh caption again', async () => {
  let asked = 0;
  const describer = pullDescriber();
  const scene = pullScene({
    features: { mediaDescriptions: true, typingSimulation: false },
    context: { pull: { maxChannels: 2 } },
    config: { image: { ...DRAW_IMAGE_CFG } },
    describer,
    images: fakeImages({ error: new ImageGenError('moderation') }),
    llm: sequenceLlm(['<msg>on it</msg><draw>a blue wall</draw>', '<msg>it did not work</msg>']),
    routeChannels: async () => {
      asked += 1;
      return [];
    },
  });
  scene.hot.prompts.draw = 'Drawing for {{name}}.\n\n{{request}}';

  const { result } = await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  assert.equal(result.drawFailed, 'moderation');
  assert.equal(scene.llm.calls.length, 2, 'the drawFailed turn ran');
  assert.equal(asked, 1, 'the hook is asked for the first turn only');
  assert.equal(callsFor(describer, 'dp1').length, 1, 'the pulled picture is described once');
  assert.equal(describer.calls.filter((call) => call.options?.maxNew === 1).length, 1, 'no other fresh caption request');
  assert.ok(userTextOf(scene.llm.calls[1]).includes('σήμερα έβαψα τον τοίχο μπλε'), 'the second turn still shows the channel');
});

test('runTurn: a pull that throws never fails an ordinary turn; a routed one ends in error, a noticed one in not-now', async () => {
  // A corrupt media cache throws inside fetchPull; an unreadable ring throws before any fetch.
  // `perChannel`: the failure is caught for its channel alone (the log names it and why it was pulled).
  const scenes = [
    ['fetchPull throws', (options) => ({ ...options, features: { mediaDescriptions: true }, describer: throwingCacheDescriber() }), true],
    ['the pull itself throws', (options) => ({ ...options, store: unreadableRingStore() }), false],
  ];
  const failedLine = (logs, pullReason, perChannel) =>
    logs.find((l) => l.msg === 'pull: failed' && l.channel === 'c1' && (perChannel ? l.source === DIARY && l.pullReason === pullReason : l.source === undefined));
  for (const [name, withFailure, perChannel] of scenes) {
    const ordinary = pullScene(withFailure({}));
    const plain = await withCapturedLogs(() => ordinary.turns.runTurn({ channel: ordinary.channel, mode: 'reply', trigger: ordinary.trigger, triggerKind: 'mention' }));
    assert.equal(plain.result.outcome, 'spoke', name);
    assert.equal(channelViewOf(ordinary.llm), null, name);
    assert.ok(failedLine(plain.logs, 'mention', perChannel), name);

    const routed = routedScene(withFailure({}));
    const call = await withCapturedLogs(() => routed.turns.runTurn(routed.params));
    assert.equal(call.result.outcome, 'error', name);
    assert.equal(routed.llm.calls.length, 0, name);
    assert.ok(failedLine(call.logs, 'routed', perChannel), name);
    const unavailable = call.logs.find((l) => l.msg === 'turn: source unavailable');
    assert.deepEqual([unavailable.channel, unavailable.source, unavailable.reason], ['c1', DIARY, 'error'], name);

    const noticed = pullScene(withFailure({ mention: false }));
    let chosen = 0;
    const comment = await withCapturedLogs(() =>
      noticed.turns.runTurn({
        channel: noticed.channel,
        mode: 'auto',
        source: { channelId: DIARY, reason: 'noticed' },
        chooseMode: () => {
          chosen += 1;
          return 'interject';
        },
      }),
    );
    assert.equal(comment.result.outcome, 'not-now', name);
    assert.equal(chosen, 0, name);
    assert.ok(failedLine(comment.logs, 'noticed', perChannel), name);
    assert.equal(comment.logs.some((l) => l.msg === 'turn: source unavailable'), false, name);
  }
});

test('runTurn: a pulled channel whose fetch throws costs only that channel', async () => {
  // #diary has a picture and the cache read throws for it; #notes has none and is pulled.
  const newer = lineIn('c1', { id: 'm5', authorId: 'u2', authorName: 'Bob', ts: NOW - 4 * MINUTE, content: 'και το #notes', raw: `και το <#${NOTES}>` });
  const describer = {
    ...pullDescriber(),
    cachedDescriptions: (guildId, items) => {
      if (items.some((item) => item.itemId === 'dp1')) throw new Error('fixture: corrupt media cache');
      return new Map();
    },
  };
  const scene = pullScene({ features: { mediaDescriptions: true }, describer, context: { pull: { maxChannels: 2 } }, between: [newer] });
  addChannel(scene.channel, { id: NOTES, name: 'notes', messages: [lineIn(NOTES, { id: 'n1', authorId: 'u4', authorName: 'Zoë', ts: NOW - 2 * HOUR, content: 'σημειώσεις για αύριο' })] });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  assert.equal(result.outcome, 'spoke');
  const view = channelViewOf(scene.llm);
  assert.ok(view.includes('σημειώσεις για αύριο') && !view.includes('σήμερα έβαψα τον τοίχο μπλε'), view);
  const failed = logs.find((l) => l.msg === 'pull: failed');
  assert.deepEqual([failed.channel, failed.source, failed.pullReason], ['c1', DIARY, 'mention']);
});

test('runTurn: fresh captions that fail after a chooser leave the cached ones', async () => {
  const door = { id: 'dp2', contentType: 'image/png', name: 'door.png', url: 'https://cdn.discordapp.com/x/door.png' };
  const [first, second] = diaryLines();
  const messages = [{ ...first, attachments: new Map([['dp2', door]]) }, second];
  let reads = 0;
  const describer = {
    ...pullDescriber(),
    // The fetch finds one caption in the cache; the second read, for the fresh captions, throws.
    cachedDescriptions: () => {
      reads += 1;
      if (reads > 1) throw new Error('fixture: corrupt media cache');
      return new Map([['dp1', 'cached caption of dp1']]);
    },
  };
  const scene = pullScene({ features: { mediaDescriptions: true }, describer, diary: { messages } });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'auto', chooseMode: () => 'interject' }));

  assert.equal(result.outcome, 'spoke');
  assert.equal(reads, 2);
  const failed = logs.find((l) => l.msg === 'pull: captions failed');
  assert.deepEqual([failed.channel, failed.source], ['c1', DIARY]);
  assert.ok(channelViewOf(scene.llm).includes('cached caption of dp1'));
  assert.equal(callsFor(describer, 'dp2').length, 0, 'no fresh caption was asked');
});

test('runTurn: a pull candidate whose check throws is left out, and a routed turn keeps its source', async () => {
  const named = lineIn('c1', { id: 'm1', authorId: 'u2', authorName: 'Bob', ts: NOW - 5 * MINUTE, content: 'και το #notes', raw: `και το <#${NOTES}>` });
  const scene = routedScene({ chat: [named] });
  scene.hot.config.context.pull = { maxChannels: 2 };
  const notes = addChannel(scene.channel, { id: NOTES, name: 'notes', messages: [lineIn(NOTES, { id: 'n1', authorId: 'u4', authorName: 'Zoë', ts: NOW - 2 * HOUR, content: 'σημειώσεις για αύριο' })] });
  Object.defineProperty(notes, 'permissionOverwrites', {
    get() {
      throw new Error('fixture: broken channel');
    },
  });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  const view = channelViewOf(scene.llm);
  assert.ok(view.includes('@Bot τι λες για τον τοίχο;') && !view.includes('σημειώσεις για αύριο'), view);
  assert.equal(notes.fetches.length, 0);
  const failed = logs.find((l) => l.msg === 'pull: failed');
  assert.deepEqual([failed.channel, failed.source, failed.pullReason], ['c1', NOTES, 'mention']);
  assert.equal(logs.some((l) => l.msg === 'pull: skipped' && l.source === NOTES), false, 'logged once, as a failure');
  assert.equal(logs.some((l) => l.msg === 'turn: source unavailable'), false);
});

test('runTurn: without labels.pull.header only the source is pulled, with cached captions only', async () => {
  const { pull, ...unlabelled } = labels;
  assert.ok(pull.header, 'the fixture has the label the live layer lacks here');

  // A mention and a route hook: nothing is fetched or asked, one no-label line.
  let asked = 0;
  const describer = pullDescriber();
  const mention = pullScene({
    features: { mediaDescriptions: true },
    context: { pull: { maxChannels: 2 } },
    describer,
    routeChannels: async () => {
      asked += 1;
      return [NOTES];
    },
  });
  mention.hot.prompts.labels = unlabelled;
  const plain = await withCapturedLogs(() => mention.turns.runTurn({ channel: mention.channel, mode: 'reply', trigger: mention.trigger, triggerKind: 'mention' }));
  assert.equal(plain.result.outcome, 'spoke');
  assert.equal(mention.other.fetches.length, 0);
  assert.equal(asked, 0);
  assert.equal(callsFor(describer, 'dp1').length, 0);
  assert.deepEqual(plain.logs.filter((l) => l.msg.startsWith('pull: ')).map((l) => [l.msg, l.channel, l.reason]), [['pull: skipped', 'c1', 'no-label']]);

  // A routed turn: its source is pulled, no fresh caption is asked.
  const routedDescriber = pullDescriber();
  const routed = routedScene({ features: { mediaDescriptions: true }, describer: routedDescriber });
  routed.hot.prompts.labels = unlabelled;
  const call = await withCapturedLogs(() => routed.turns.runTurn(routed.params));
  assert.equal(call.result.outcome, 'spoke');
  assert.ok(call.logs.some((l) => l.msg === 'pull: channel' && l.source === DIARY));
  assert.equal(callsFor(routedDescriber, 'dp1').length, 0);

  // A noticed turn whose chooser picks a mode: no fresh caption after it either.
  const noticedDescriber = pullDescriber();
  const noticed = pullScene({ mention: false, features: { mediaDescriptions: true }, describer: noticedDescriber });
  noticed.hot.prompts.labels = unlabelled;
  const comment = await withCapturedLogs(() =>
    noticed.turns.runTurn({ channel: noticed.channel, mode: 'auto', source: { channelId: DIARY, reason: 'noticed' }, chooseMode: () => 'interject' }),
  );
  assert.equal(comment.result.outcome, 'spoke');
  assert.equal(callsFor(noticedDescriber, 'dp1').length, 0);
  assert.equal(comment.logs.some((l) => l.msg === 'pull: captions'), false);

  // Nothing to pull: no line at all.
  const quiet = pullScene({ mention: false });
  quiet.hot.prompts.labels = unlabelled;
  const none = await withCapturedLogs(() => quiet.turns.runTurn({ channel: quiet.channel, mode: 'reply', trigger: quiet.trigger, triggerKind: 'mention' }));
  assert.equal(none.logs.some((l) => l.msg.startsWith('pull: ')), false);
});

// --- another channel pulled into a turn (<channel_view>): the outputs ---------------------------
// In pullScene the chat is #1 m1 (Bob), #2 m9 (Alice, the trigger) and the diary #3 d1, #4 d2;
// in routedScene the chat is #1 m1 (Bob) and the diary #2 d1, #3 d2, #4 d3 (the call).

/** Discord's jump link to a diary line of the fixture guild g1. */
function diaryLink(messageId) {
  return `https://discord.com/channels/g1/${DIARY}/${messageId}`;
}

/** `text` with the jump link to diary line `messageId`, joined through the fixture's labels.elsewhere.link. */
function linked(text, messageId) {
  return fill(labels.elsewhere.link, { text, link: diaryLink(messageId) });
}

/** A client whose dry-run mirror channel records every post in `mirrored`. */
function mirrorClient(mirrored) {
  return fakeClient({ channels: { fetch: async () => ({ send: async (payload) => mirrored.push(payload) }) } });
}

/** Lets the bot read `channel` but not put a reaction there. */
function denyReactions(channel) {
  channel.permissionsFor = () => ({ has: (flag) => flag !== PermissionFlagsBits.AddReactions });
}

test('runTurn: a reaction to a pulled line reacts in the source channel, one to a chat line stays here', async () => {
  const scene = pullScene({ features: { typingSimulation: false }, llm: fakeLlm('<react to="#3">🎉</react><react to="#2">👍</react>') });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(scene.other.reactCalls, [{ id: 'd1', emoji: '🎉' }]);
  assert.deepEqual(scene.channel.reactCalls, [{ id: 'm9', emoji: '👍' }]);
  assert.equal(logs.some((l) => l.msg === 'turn: reaction dropped'), false);
});

test('runTurn: a reaction to a pulled line is dropped where the bot cannot react', async () => {
  const scene = pullScene({ features: { typingSimulation: false }, llm: fakeLlm('<react to="#3">🎉</react><react to="#2">👍</react>') });
  denyReactions(scene.other);

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  assert.equal(result.outcome, 'spoke');
  assert.ok(channelViewOf(scene.llm), 'the channel is still shown');
  assert.deepEqual(scene.other.reactCalls, []);
  assert.deepEqual(scene.channel.reactCalls, [{ id: 'm9', emoji: '👍' }], 'a reaction on a chat line is unchanged');
  const dropped = logs.filter((l) => l.msg === 'turn: reaction dropped');
  assert.deepEqual(dropped.map((l) => [l.channel, l.source, l.reason]), [['c1', DIARY, 'cannot-react']]);
});

test('runTurn: a reply to a pulled line posts plain here with one jump link to that line', async () => {
  const scene = pullScene({
    features: { typingSimulation: false },
    llm: fakeLlm('<msg reply="#3">ωραίο μπλε</msg><msg reply="#3">πολύ ωραίο</msg><msg reply="#2">ναι, το είδα</msg>'),
  });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  assert.equal(result.outcome, 'spoke');
  const [first, second, third] = scene.channel.sent;
  assert.equal(first.content, linked('ωραίο μπλε', 'd1'));
  assert.equal(first.reply, undefined, 'never a Discord reply across channels');
  assert.equal(second.content, 'πολύ ωραίο', 'a second reply to the same line adds no second link');
  assert.equal(second.reply, undefined);
  assert.equal(third.content, 'ναι, το είδα');
  assert.equal(third.reply.messageReference, 'm9', 'a reply to a chat line is unchanged');
  assert.equal(scene.other.sent.length, 0, 'nothing is posted in the pulled channel');
  const sent = logs.filter((l) => l.msg === 'turn: sent');
  assert.deepEqual(sent.map((l) => l.link ?? false), [true, false, false]);
  assert.equal(sent.some((l) => 'source' in l), false, 'a turn without a source logs none');
});

test('runTurn: a routed turn posts in the destination with the link to the call on its first message', async () => {
  const scene = routedScene({
    features: { typingSimulation: false },
    llm: fakeLlm('<msg>καλημέρα</msg><msg reply="#4">ναι, μπλε</msg><msg reply="#2">κι αυτό ωραίο</msg>'),
  });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(
    scene.channel.sent.map((post) => post.content),
    [linked('καλημέρα', 'd3'), 'ναι, μπλε', linked('κι αυτό ωραίο', 'd1')],
    'the call once, on the first message; another pulled line it answers gets its own',
  );
  assert.ok(scene.channel.sent.every((post) => post.reply === undefined), 'never a Discord reply to the call');
  assert.equal(scene.other.sent.length, 0, 'nothing is posted in the source');
  const sent = logs.filter((l) => l.msg === 'turn: sent');
  assert.deepEqual(sent.map((l) => [l.channel, l.source, l.link ?? false]), [['c1', DIARY, true], ['c1', DIARY, false], ['c1', DIARY, true]]);
});

test('runTurn: a noticed turn links its first message to the newest line of its source shown', async () => {
  const scene = pullScene({ mention: false, features: { typingSimulation: false }, llm: fakeLlm('<msg>τι ωραίο χρώμα</msg>') });

  const { result } = await withCapturedLogs(() =>
    scene.turns.runTurn({ channel: scene.channel, mode: 'auto', source: { channelId: DIARY, reason: 'noticed' }, chooseMode: () => 'interject' }),
  );

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(scene.channel.sent.map((post) => [post.content, post.reply]), [[linked('τι ωραίο χρώμα', 'd2'), undefined]]);
});

test('runTurn: @name of a pulled author resolves to a mention', async () => {
  const scene = routedScene({ features: { typingSimulation: false }, llm: fakeLlm('<msg>@Éloïse ωραίος τοίχος</msg>') });

  await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  const [post] = scene.channel.sent;
  assert.equal(post.content, linked('<@u3> ωραίος τοίχος', 'd3'));
  assert.deepEqual(post.allowedMentions.users, ['u3']);
});

test('runTurn: a picture or a GIF answering a pulled line posts plain with its jump link', async () => {
  const scene = routedScene({ hot: drawHot(), images: fakeImages(), store: gifStore(), llm: fakeLlm('<gif reply="#4">g1</gif><draw reply="#2">a blue wall</draw>') });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  const [gif, picture] = scene.channel.sent;
  assert.deepEqual([gif.content, gif.reply], [linked('https://tenor.com/view/chat-qui-danse-1', 'd3'), undefined], 'the media URL first, so it still embeds');
  assert.equal(picture.files.length, 1);
  assert.equal(picture.reply, undefined);
  assert.equal(picture.content, diaryLink('d1'), 'the picture carries the link to the line it answers');
  assert.equal(scene.other.sent.length, 0);
  assert.equal(logs.find((l) => l.msg === 'turn: gif sent').link, true);
  assert.equal(logs.find((l) => l.msg === 'turn: drew').link, true);
});

test('runTurn: a GIF alone answering a routed call links the call; after a message it carries none', async () => {
  const alone = routedScene({ features: { typingSimulation: false }, store: gifStore(), llm: fakeLlm('<gif>g1</gif>') });
  await withCapturedLogs(() => alone.turns.runTurn(alone.params));
  assert.deepEqual(alone.channel.sent.map((post) => [post.content, post.reply]), [[linked('https://tenor.com/view/chat-qui-danse-1', 'd3'), undefined]]);

  const after = routedScene({ features: { typingSimulation: false }, store: gifStore(), llm: fakeLlm('<msg>κοίτα</msg><gif>g1</gif>') });
  const { logs } = await withCapturedLogs(() => after.turns.runTurn(after.params));
  assert.deepEqual(after.channel.sent.map((post) => post.content), [linked('κοίτα', 'd3'), 'https://tenor.com/view/chat-qui-danse-1'], 'one link per turn, on its first post');
  assert.equal('link' in logs.find((l) => l.msg === 'turn: gif sent'), false);
});

test('runTurn: a follow-up reply to a pulled line posts plain with its jump link', async () => {
  const scene = pullScene({ features: { typingSimulation: false }, llm: fakeLlm('<msg reply="#3">ωραίο μπλε</msg><msg reply="#2">ναι</msg>') });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'followUp' }));

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(
    scene.channel.sent.map((post) => [post.content, post.reply]),
    [
      [linked('ωραίο μπλε', 'd1'), undefined],
      ['ναι', undefined],
    ],
    'a follow-up quotes nothing, yet links the pulled line it answers',
  );
  assert.deepEqual(logs.filter((l) => l.msg === 'turn: sent').map((l) => l.link ?? false), [true, false]);
});

test('runTurn: a chat author wins @name over a pulled author with the same display name', async () => {
  const namesake = lineIn(DIARY, { id: 'd5', authorId: 'u7', authorName: 'Bob', ts: NOW - 3 * HOUR + 2 * MINUTE, content: 'κι εγώ' });
  const scene = pullScene({ features: { typingSimulation: false }, diary: { messages: [...diaryLines(), namesake] }, llm: fakeLlm('<msg>@Bob ναι</msg>') });

  await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  assert.ok(channelViewOf(scene.llm).includes('κι εγώ'), 'the namesake is shown');
  const [post] = scene.channel.sent;
  assert.equal(post.content, '<@u2> ναι');
  assert.deepEqual(post.allowedMentions.users, ['u2']);
});

test('runTurn: @name of an author whose pulled block the budget dropped stays text', async () => {
  const caps = { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, pulled: 1 };
  const scene = pullScene({ features: { typingSimulation: false }, context: { caps }, llm: fakeLlm('<msg>@Éloïse γεια</msg>') });

  await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  assert.equal(channelViewOf(scene.llm), null, 'the block was cut');
  const [post] = scene.channel.sent;
  assert.equal(post.content, '@Éloïse γεια');
  assert.deepEqual(post.allowedMentions.users, []);
});

/** A store remembering the diary's author by a nickname of several words (her pulled lines carry her global name). */
function nicknameStore(extra = {}) {
  return fakeStore({ userProfiles: { u3: { id: 'u3', names: ['Éloïse de Vaux', 'Éloïse'] }, ...extra } });
}

test('runTurn: @name of a pulled author resolves by the stored nickname', async () => {
  const scene = pullScene({ features: { typingSimulation: false }, store: nicknameStore(), llm: fakeLlm('<msg>@Éloïse de Vaux ωραίο μπλε</msg>') });

  await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  const [post] = scene.channel.sent;
  assert.equal(post.content, '<@u3> ωραίο μπλε', 'the longer stored name wins over the display name it starts with');
  assert.deepEqual(post.allowedMentions.users, ['u3']);
});

test('runTurn: in dry-run the stored nickname of a pulled author resolves the same way', async () => {
  const scene = pullScene({ features: { typingSimulation: false, dryRun: true }, store: nicknameStore(), llm: fakeLlm('<msg>@Éloïse de Vaux ωραίο μπλε</msg>') });

  const { logs } = await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  assert.equal(scene.channel.sent.length, 0);
  assert.equal(logs.find((l) => l.msg === 'dry-run: would send').text, '<@u3> ωραίο μπλε');
});

test('runTurn: the stored name of a member the request did not show stays text', async () => {
  const store = nicknameStore({ u9: { id: 'u9', names: ['Ταξιάρχης Μέγας'], character: 'ήσυχος' } });
  const scene = pullScene({ features: { typingSimulation: false }, store, llm: fakeLlm('<msg>@Ταξιάρχης Μέγας γεια</msg>') });

  await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  const [post] = scene.channel.sent;
  assert.equal(post.content, '@Ταξιάρχης Μέγας γεια');
  assert.deepEqual(post.allowedMentions.users, []);
});

test('runTurn: the stored nickname of an author whose pulled block the budget dropped stays text', async () => {
  // Her profile holds names only, so `<people>` has nothing to show of her either.
  const caps = { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, pulled: 1 };
  const scene = pullScene({ features: { typingSimulation: false }, context: { caps }, store: nicknameStore(), llm: fakeLlm('<msg>@Éloïse de Vaux γεια</msg>') });

  await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  assert.equal(channelViewOf(scene.llm), null, 'the block was cut');
  const [post] = scene.channel.sent;
  assert.equal(post.content, '@Éloïse de Vaux γεια');
  assert.deepEqual(post.allowedMentions.users, []);
});

test('runTurn: @name resolves by a stored name of a member <people> shows', async () => {
  // Bob speaks in the chat under his display name; the persona remembers him by another one.
  const store = fakeStore({ userProfiles: { u2: { id: 'u2', names: ['Bob', 'Roberto Sáenz'], character: 'ήρεμος' } } });
  const scene = pullScene({ features: { typingSimulation: false }, store, llm: fakeLlm('<msg>@Roberto Sáenz ναι</msg>') });

  await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  const [post] = scene.channel.sent;
  assert.equal(post.content, '<@u2> ναι');
  assert.deepEqual(post.allowedMentions.users, ['u2']);
});

test('runTurn: a noticed turn whose source block the budget dropped posts no link', async () => {
  const caps = { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, pulled: 1 };
  const scene = pullScene({ mention: false, context: { caps }, features: { typingSimulation: false }, llm: fakeLlm('<msg>τι ωραίο χρώμα</msg>') });

  const { result, logs } = await withCapturedLogs(() =>
    scene.turns.runTurn({ channel: scene.channel, mode: 'auto', source: { channelId: DIARY, reason: 'noticed' }, chooseMode: () => 'interject' }),
  );

  assert.equal(result.outcome, 'spoke');
  assert.equal(channelViewOf(scene.llm), null, 'nothing of the source was shown');
  assert.deepEqual(scene.channel.sent.map((post) => post.content), ['τι ωραίο χρώμα']);
  assert.equal('link' in logs.find((l) => l.msg === 'turn: sent'), false);
});

test('runTurn: a reaction on a pulled line whose channel is gone is dropped as not-found', async () => {
  for (const dryRun of [false, true]) {
    let guild = null;
    const calls = [];
    // The pulled channel leaves the guild's cache while the model answers.
    const llm = {
      calls,
      complete: async (messages) => {
        calls.push(messages);
        guild.channels.cache.delete(DIARY);
        return { text: '<react to="#3">🎉</react>', usage: {}, estimated: 10 };
      },
    };
    const scene = pullScene({ features: { typingSimulation: false, dryRun }, llm });
    guild = scene.channel.guild;

    const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

    assert.equal(result.outcome, 'spoke', `dryRun ${dryRun}`);
    assert.ok(channelViewOf(scene.llm), 'the channel was shown');
    assert.deepEqual([scene.other.reactCalls, scene.channel.reactCalls], [[], []], `dryRun ${dryRun}`);
    const dropped = logs.filter((l) => l.msg === 'turn: reaction dropped');
    assert.deepEqual(dropped.map((l) => [l.channel, l.source, l.reason]), [['c1', DIARY, 'not-found']], `dryRun ${dryRun}`);
    assert.equal(logs.some((l) => l.msg === 'dry-run: would react' || l.msg === 'turn: reaction failed'), false, `dryRun ${dryRun}`);
  }
});

test('runTurn: labels.elsewhere.link is read at the moment of use; without it the link follows a newline', async () => {
  const scene = routedScene({ features: { typingSimulation: false }, llm: fakeLlm('<msg>ναι</msg>') });
  const run = () => withCapturedLogs(() => scene.turns.runTurn(scene.params));

  await run();
  scene.hot.prompts.labels = { ...labels, elsewhere: { ...labels.elsewhere, link: '{text} -> {link}' } };
  await run();
  const { elsewhere, ...withoutElsewhere } = labels;
  scene.hot.prompts.labels = { ...withoutElsewhere, elsewhere: { called: elsewhere.called } };
  await run();

  assert.deepEqual(scene.channel.sent.map((post) => post.content), [
    `ναι [from ${diaryLink('d3')}]`,
    `ναι -> ${diaryLink('d3')}`,
    `ναι\n${diaryLink('d3')}`,
  ]);
});

test('runTurn: a message near the length limit is cut so its link still fits one Discord message', async () => {
  const long = `${'a'.repeat(1850)}${' :dance:'.repeat(5)}`;
  const scene = routedScene({ features: { typingSimulation: false }, llm: fakeLlm(`<msg>${long}</msg>`) });
  const turns = createTurnRunner({ hot: scene.hot, store: fakeStore(), llm: scene.llm, calibrator: identityCalibrator(), client: fakeClient(), emoji: fakeEmojiIndex(), imageFetcher: fakeImageFetcher(), now: () => NOW });

  const { result } = await withCapturedLogs(() => turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  const [post] = scene.channel.sent;
  const tail = ` [from ${diaryLink('d3')}]`;
  assert.ok(post.content.endsWith(tail), 'the link is kept');
  assert.ok([...post.content].length <= 2000, `${[...post.content].length} characters`);
  assert.ok(post.content.startsWith('a'.repeat(1850)), 'the text is cut at its end');
  assert.equal(/<[^>]*$/.test(post.content.slice(0, -tail.length)), false, 'no custom emoji token is cut in half');
});

test('runTurn: a pulled channel gets its seen mark and its spokeSaw ids', async () => {
  const scene = routedScene({ features: { typingSimulation: false } });

  const { result } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(scene.store.state.data.elsewhereSeen, { [DIARY]: NOW - 2 * MINUTE }, 'the newest line shown');
  for (const id of ['d1', 'd2', 'd3']) assert.equal(scene.turns.spokeAfterSeeing(DIARY, id), true, id);
  assert.equal(scene.turns.spokeAfterSeeing(DIARY, 'm1'), false);
  assert.equal(scene.turns.spokeAfterSeeing('c1', 'm1'), true, "the destination's own history as before");
});

test('runTurn: a pulled channel the bot can write in gets a seen mark but no spokeSaw ids', async () => {
  const scene = pullScene({ features: { typingSimulation: false } });

  await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

  assert.deepEqual(scene.store.state.data.elsewhereSeen, { [DIARY]: NOW - 3 * HOUR + MINUTE });
  assert.equal(scene.turns.spokeAfterSeeing(DIARY, 'd1'), false, 'a call written there is answered there');
  assert.equal(scene.turns.spokeAfterSeeing('c1', 'm9'), true);
});

test('runTurn: the seen mark follows the request sent: set on a skip, never for a block the budget dropped', async () => {
  const skipped = routedScene({ llm: fakeLlm('<skip/>') });
  const skip = await withCapturedLogs(() => skipped.turns.runTurn(skipped.params));
  assert.equal(skip.result.outcome, 'skip');
  assert.deepEqual(skipped.store.state.data.elsewhereSeen, { [DIARY]: NOW - 2 * MINUTE }, 'a skip saw the block');
  assert.equal(skipped.turns.spokeAfterSeeing(DIARY, 'd3'), false, 'no spokeSaw without speaking');

  // A channel the bot cannot write in, the one kind that gets spokeSaw ids: shown -> its ids,
  // cut by the budget -> none.
  const kept = pullScene({ diary: { readOnly: true } });
  const shown = await withCapturedLogs(() => kept.turns.runTurn({ channel: kept.channel, mode: 'reply', trigger: kept.trigger, triggerKind: 'mention' }));
  assert.equal(shown.result.outcome, 'spoke');
  assert.ok(channelViewOf(kept.llm), 'the control shows the block');
  assert.equal(kept.turns.spokeAfterSeeing(DIARY, 'd1'), true, 'the control records what it showed');

  const caps = { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, pulled: 1 };
  const dropped = pullScene({ diary: { readOnly: true }, context: { caps } });
  const cut = await withCapturedLogs(() => dropped.turns.runTurn({ channel: dropped.channel, mode: 'reply', trigger: dropped.trigger, triggerKind: 'mention' }));
  assert.equal(cut.result.outcome, 'spoke');
  assert.equal(dropped.other.fetches.length, 1, 'the channel was pulled');
  assert.equal(channelViewOf(dropped.llm), null, 'and its block cut by the budget');
  assert.equal(dropped.store.state.data.elsewhereSeen, undefined);
  assert.equal(dropped.turns.spokeAfterSeeing(DIARY, 'd1'), false);
});

test('runTurn: a dry-run routed turn acts nowhere, yet marks what it saw', async () => {
  const answer = '<react to="#2">🎉</react><react to="#1">👍</react><msg reply="#4">ναι, μπλε</msg>';
  const scene = routedScene({ hot: fakeHot({ dryRun: true }, { dryRunChannelId: 'mirror1' }), client: mirrorClient([]), llm: fakeLlm(answer) });

  const { result } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.deepEqual([result.outcome, result.dryRun], ['spoke', true]);
  assert.deepEqual([scene.other.reactCalls, scene.channel.reactCalls, scene.channel.sent, scene.other.sent], [[], [], [], []]);
  assert.deepEqual(scene.store.state.data.elsewhereSeen, { [DIARY]: NOW - 2 * MINUTE }, 'dry-run included');
  assert.equal(scene.turns.spokeAfterSeeing(DIARY, 'd3'), true);
});

test('runTurn: an image cap on a routed turn posts the notice in the destination, never as a reply to the call', async () => {
  const scene = routedScene({
    hot: drawHot(),
    images: fakeImages({ error: imageCap('userDaily', 'image.maxPerUserPerDay', 3, 3) }),
    llm: fakeLlm('<msg reply="#4">μισό λεπτό</msg><draw reply="#4">a blue wall</draw>'),
  });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  assert.equal(result.drawFailed, undefined);
  assert.equal(scene.llm.calls.length, 1, 'no drawFailed turn');
  assert.deepEqual(scene.channel.sent, [
    { content: linked('μισό λεπτό', 'd3'), reply: undefined, allowedMentions: { parse: [], users: [], repliedUser: true } },
    { content: fill(labels.limits.notice, { limit: 'image.maxPerUserPerDay', used: 3, cap: 3 }), reply: undefined, allowedMentions: { parse: [] } },
  ]);
  assert.equal(scene.other.sent.length, 0, 'nothing in the source');
  assert.equal(logs.find((l) => l.msg === 'turn: draw refused by a limit').asked, true, 'the caller asked: the notice follows');
});

test('runTurn: a routed turn that only reacts on its call counts as spoke', async () => {
  const scene = routedScene({ features: { typingSimulation: false }, llm: fakeLlm('<react to="#4">👍</react>') });

  const { result } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke', 'the caller of a routed turn marks the call answered on spoke');
  assert.equal(result.delivered, true, 'the reaction was put');
  assert.deepEqual(scene.other.reactCalls, [{ id: 'd3', emoji: '👍' }]);
  assert.deepEqual(scene.channel.sent, []);
});

test('runTurn: a turn whose output never reached the chat reports delivered false', async () => {
  const quiet = { typingSimulation: false };
  // The bot may not react in the source: the one reaction, on the call, is dropped.
  const denied = routedScene({ features: quiet, llm: fakeLlm('<react to="#4">👍</react>') });
  denyReactions(denied.other);
  const dropped = await withCapturedLogs(() => denied.turns.runTurn(denied.params));
  assert.deepEqual([dropped.result.outcome, dropped.result.delivered], ['spoke', false]);
  assert.deepEqual([denied.other.reactCalls, denied.channel.sent], [[], []]);
  assert.ok(dropped.logs.some((l) => l.msg === 'turn: reaction dropped' && l.reason === 'cannot-react'));

  // Discord refuses the reaction on a chat line.
  const refusing = routedScene({ features: quiet, llm: fakeLlm('<react to="#1">👍</react>') });
  const fetchMessages = refusing.channel.messages.fetch;
  refusing.channel.messages.fetch = async (arg) =>
    arg && typeof arg === 'object'
      ? fetchMessages(arg)
      : {
          react: async () => {
            throw new Error('fixture: reaction refused');
          },
        };
  const failed = await withCapturedLogs(() => refusing.turns.runTurn(refusing.params));
  assert.deepEqual([failed.result.outcome, failed.result.delivered], ['spoke', false]);
  assert.ok(failed.logs.some((l) => l.msg === 'turn: reaction failed'));

  // A picture an image cap refused: the limit notice is not an answer.
  const capped = routedScene({ hot: drawHot(), images: fakeImages({ error: imageCap('userDaily', 'image.maxPerUserPerDay', 3, 3) }), llm: fakeLlm('<draw reply="#4">a blue wall</draw>') });
  const refused = await withCapturedLogs(() => capped.turns.runTurn(capped.params));
  assert.deepEqual([refused.result.outcome, refused.result.delivered], ['spoke', false]);
  assert.equal(capped.channel.sent.length, 1, 'only the notice');

  // A message, a picture, or the drawFailed turn's message reached the chat.
  const said = routedScene({ features: quiet });
  assert.equal((await withCapturedLogs(() => said.turns.runTurn(said.params))).result.delivered, true);
  const drawn = routedScene({ hot: drawHot(), images: fakeImages(), llm: fakeLlm('<draw reply="#4">a blue wall</draw>') });
  assert.equal((await withCapturedLogs(() => drawn.turns.runTurn(drawn.params))).result.delivered, true);
  const failedDraw = routedScene({
    hot: drawHot(),
    images: fakeImages({ error: new ImageGenError('moderation') }),
    llm: sequenceLlm(['<draw reply="#4">a blue wall</draw>', '<msg>δεν βγήκε</msg>']),
  });
  const explained = await withCapturedLogs(() => failedDraw.turns.runTurn(failedDraw.params));
  assert.deepEqual([explained.result.drawFailed, explained.result.delivered], ['moderation', true], 'the failure was answered in the chat');
});

// --- the ring of calls after a turn that showed some (state.json `elsewherePings`) --------------

/** A ring entry for the diary line `line`, unanswered and unskipped. */
function ringEntry(line) {
  return { messageId: line.id, channelId: DIARY, ts: line.createdTimestamp, answeredAt: null, skippedAt: null };
}

/** The state of each ring entry of `store` by message id: `answered`, `skipped` or `unanswered`. */
function ringStates(store) {
  return Object.fromEntries(store.state.data.elsewherePings.map((entry) => [entry.messageId, pingStatus(entry)]));
}

/** The `elsewhere: marked` lines of `logs` as [source, message, status], sorted by message id. */
function markedLines(logs) {
  return logs
    .filter((l) => l.msg === 'elsewhere: marked')
    .map(({ source, message, status }) => [source, message, status])
    .sort((a, b) => a[1].localeCompare(b[1]));
}

/**
 * pullScene options whose read-only #diary holds two calls to the persona before its lines (e1 by
 * Zoë, e2 by Chloé, both in the ring): in the request #3 e1, #4 e2, #5 d1, #6 d2.
 */
function ringedDiary(options = {}) {
  const calls = [
    lineIn(DIARY, { id: 'e1', authorId: 'u4', authorName: 'Zoë', ts: NOW - 3 * HOUR - 10 * MINUTE, content: '@Bot είσαι εδώ;' }),
    lineIn(DIARY, { id: 'e2', authorId: 'u5', authorName: 'Chloé', ts: NOW - 3 * HOUR - 5 * MINUTE, content: '@Bot καλημέρα' }),
  ];
  const store = fakeStore();
  store.state.data.elsewherePings = calls.map(ringEntry);
  const { diary = {}, ...rest } = options;
  return { store, ...rest, diary: { messages: [...calls, ...diaryLines()], readOnly: true, ...diary } };
}

test('runTurn: a turn that showed calls of a read-only channel stamps them: answered when its output answered them, skipped otherwise', async () => {
  const quiet = { typingSimulation: false };
  for (const [label, answer, states] of [
    ['a reply to e1', '<msg reply="#3">ναι, εδώ είμαι</msg>', { e1: 'answered', e2: 'skipped' }],
    ['a reaction on e2', '<react to="#4">👍</react>', { e1: 'skipped', e2: 'answered' }],
    ['a GIF answering e2', '<msg>χα</msg><gif reply="#4">g1</gif>', { e1: 'skipped', e2: 'answered' }],
    ['a picture answering e1', '<draw reply="#3">a blue wall</draw>', { e1: 'answered', e2: 'skipped' }],
    ['a reply to a diary line that is no call', '<msg reply="#5">ωραίο</msg>', { e1: 'skipped', e2: 'skipped' }],
    ['a message answering no pulled line', '<msg>καλημέρα</msg>', { e1: 'skipped', e2: 'skipped' }],
  ]) {
    const drawing = answer.includes('<draw');
    const scene = pullScene(
      ringedDiary({
        features: quiet,
        llm: fakeLlm(answer),
        ...(drawing ? { config: { image: { ...DRAW_IMAGE_CFG } }, images: fakeImages() } : {}),
      }),
    );
    if (drawing) scene.hot.prompts.draw = 'Drawing for {{name}}.\n\n{{request}}';
    scene.store.findGif = gifStore().findGif;

    const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));

    assert.equal(result.outcome, 'spoke', label);
    assert.ok(channelViewOf(scene.llm).includes('@Bot είσαι εδώ;'), label);
    assert.deepEqual(ringStates(scene.store), states, label);
    assert.deepEqual(markedLines(logs), Object.entries(states).map(([id, status]) => [DIARY, id, status]), label);
    for (const entry of scene.store.state.data.elsewherePings) {
      assert.equal(entry.answeredAt ?? entry.skippedAt, NOW, `${label}: stamped at the turn's clock`);
    }
  }

  // The reply to e1 posts in the chat with its jump link, never as a Discord reply across channels.
  const replied = pullScene(ringedDiary({ features: quiet, llm: fakeLlm('<msg reply="#3">ναι, εδώ είμαι</msg>') }));
  await withCapturedLogs(() => replied.turns.runTurn({ channel: replied.channel, mode: 'reply', trigger: replied.trigger, triggerKind: 'mention' }));
  assert.deepEqual(replied.channel.sent.map((post) => [post.content, post.reply]), [[linked('ναι, εδώ είμαι', 'e1'), undefined]]);
});

test('runTurn: a turn that chose silence stamps the calls it showed skipped; a rehearsal, a dropped block or a writable channel stamps none', async () => {
  const silent = pullScene(ringedDiary({ llm: fakeLlm('<skip/>') }));
  const skip = await withCapturedLogs(() => silent.turns.runTurn({ channel: silent.channel, mode: 'reply', trigger: silent.trigger, triggerKind: 'mention' }));
  assert.equal(skip.result.outcome, 'skip');
  assert.deepEqual(ringStates(silent.store), { e1: 'skipped', e2: 'skipped' }, 'she had them in view and chose silence');
  assert.deepEqual(markedLines(skip.logs), [[DIARY, 'e1', 'skipped'], [DIARY, 'e2', 'skipped']]);

  const caps = { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, pulled: 1 };
  const cases = [
    // A rehearsal reached nobody: nothing answered, nothing let pass.
    ['dry run', ringedDiary({ features: { dryRun: true }, llm: fakeLlm('<msg reply="#3">ναι</msg>') }), 'spoke'],
    ['the block cut by the budget', ringedDiary({ context: { caps } }), 'spoke'],
    ['a skip whose block was cut', ringedDiary({ context: { caps }, llm: fakeLlm('<skip/>') }), 'skip'],
    // A call written where the bot can write is answered there, not by being shown here.
    ['a writable channel', ringedDiary({ diary: { readOnly: false }, llm: fakeLlm('<msg reply="#3">ναι</msg>') }), 'spoke'],
  ];
  for (const [label, options, outcome] of cases) {
    const scene = pullScene(options);
    const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: scene.trigger, triggerKind: 'mention' }));
    assert.equal(result.outcome, outcome, label);
    assert.deepEqual(ringStates(scene.store), { e1: 'unanswered', e2: 'unanswered' }, label);
    assert.deepEqual(markedLines(logs), [], label);
  }

  // Paused while the turn ran (the owner may be editing data/): the ring is left as it was.
  const paused = pullScene(ringedDiary());
  paused.llm.complete = async () => {
    paused.store.state.data.paused = true;
    return { text: '<msg reply="#3">ναι</msg>', usage: {}, estimated: 10 };
  };
  const late = await withCapturedLogs(() => paused.turns.runTurn({ channel: paused.channel, mode: 'reply', trigger: paused.trigger, triggerKind: 'mention' }));
  assert.equal(late.result.outcome, 'spoke');
  assert.deepEqual(ringStates(paused.store), { e1: 'unanswered', e2: 'unanswered' });
});

test('runTurn: a routed turn stamps the other calls it showed and leaves its own call to its caller', async () => {
  // The diary in the request: #2 d1, #3 d2, #4 e1 (an earlier call by Zoë), #5 d3 (the routed call).
  const earlier = lineIn(DIARY, { id: 'e1', authorId: 'u4', authorName: 'Zoë', ts: NOW - 4 * MINUTE, content: '@Bot είσαι εδώ;' });
  for (const [label, answer, outcome, states] of [
    ['a reply to the earlier call', '<msg reply="#4">ναι, Zoë</msg>', 'spoke', { e1: 'answered', d3: 'unanswered' }],
    ['a reply to its own call', '<msg reply="#5">ναι</msg>', 'spoke', { e1: 'skipped', d3: 'unanswered' }],
    ['silence', '<skip/>', 'skip', { e1: 'skipped', d3: 'unanswered' }],
  ]) {
    const scene = routedScene({ features: { typingSimulation: false }, before: [earlier], llm: fakeLlm(answer) });
    scene.store.state.data.elsewherePings = [ringEntry(earlier), ringEntry({ id: 'd3', createdTimestamp: NOW - 2 * MINUTE })];

    const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

    assert.equal(result.outcome, outcome, label);
    assert.deepEqual(ringStates(scene.store), states, `${label}: the routed call is stamped by its caller (src/discord/events.js)`);
    assert.deepEqual(markedLines(logs), [[DIARY, 'e1', states.e1]], label);
    assert.equal('sourceShownIds' in result, false, label);
  }
});

test('runTurn: a drawFailed turn after a routed one keeps the source', async () => {
  const scene = routedScene({
    hot: drawHot(),
    images: fakeImages({ error: new ImageGenError('moderation') }),
    llm: sequenceLlm(['<msg reply="#4">μισό λεπτό</msg><draw reply="#4">a blue wall</draw>', '<msg>δεν βγήκε</msg>']),
  });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.drawFailed, 'moderation');
  assert.equal(scene.llm.calls.length, 2, 'the drawFailed turn ran');
  const second = userTextOf(scene.llm.calls[1]);
  assert.ok(second.includes('<channel_view>') && second.includes('@Bot τι λες για τον τοίχο;'), 'the second turn still shows the call');
  assert.deepEqual(scene.channel.sent.map((post) => [post.content, post.reply]), [
    [linked('μισό λεπτό', 'd3'), undefined],
    [linked('δεν βγήκε', 'd3'), undefined],
  ]);
  const answered = logs.filter((l) => l.msg === 'turn: model answered');
  assert.deepEqual(answered.map((l) => [l.trigger, l.source]), [['mention', DIARY], ['drawFailed', DIARY]]);
});

// --- <recent>: the recent lines a turn may show -------------------------------------------------

const OPEN_ROOM = '100000000000000011';
const STAFF_ROOM = '100000000000000012';
const STAFF_ROLE = '100000000000000099';

/**
 * Gives `guild` its roles -- @everyone (the guild's id) and a staff role -- and two more text
 * channels the bot reads (quiet: never a neighbour): #open, which every role can view, and
 * #staff, which only the staff role can. A fakeTurnChannel grants every permission, so the
 * turn's own channel is viewable by every role.
 */
function audienceGuild(guild) {
  const everyone = { id: guild.id };
  const staff = { id: STAFF_ROLE };
  guild.roles = { everyone, cache: new Map([[everyone.id, everyone], [staff.id, staff]]) };
  const room = (id, name, viewers) =>
    guild.channels.cache.set(id, {
      id,
      name,
      guild,
      isTextBased: () => true,
      isThread: () => false,
      permissionsFor: (target) =>
        target === guild.members.me ? { has: () => true } : { has: (flag) => flag === PermissionFlagsBits.ViewChannel && viewers.includes(target?.id) },
    });
  room(OPEN_ROOM, 'open', [everyone.id, staff.id]);
  room(STAFF_ROOM, 'staff', [staff.id]);
  return guild;
}

/** Three live lines: one of #general (c1), one of #open, one of #staff. */
function threeRooms() {
  return [
    { id: 1, at: NOW - 3 * HOUR, addedAt: null, channelId: 'c1', text: 'εδώ το πρωί', who: [], weight: 2 },
    { id: 2, at: NOW - 2 * HOUR, addedAt: null, channelId: OPEN_ROOM, text: 'στην αυλή', who: [], weight: 2 },
    { id: 3, at: NOW - HOUR, addedAt: null, channelId: STAFF_ROOM, text: 'στο γραφείο', who: [], weight: 2 },
  ];
}

/** A store like fakeStore that also holds `lines` as the guild's recent lines; `recentReads` counts the reads. */
function recentStore(lines, base) {
  const store = fakeStore(base);
  store.recentReads = 0;
  store.getRecent = () => {
    store.recentReads += 1;
    return { nextId: lines.length + 1, lines: structuredClone(lines) };
  };
  return store;
}

/** The `recent: shown` entries of `logs`, without the logger's own fields. */
function recentShownLogs(logs) {
  return logs.filter((entry) => entry.msg === 'recent: shown').map(({ level, time, msg, ...fields }) => fields);
}

test("turn: <recent> shows this channel's lines and those of channels everyone here can read, never a narrower channel's", async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  audienceGuild(channel.guild);
  const store = recentStore(threeRooms(), { channels: [{ id: OPEN_ROOM, name: 'open' }] });
  const llm = fakeLlm('<skip/>');
  const turns = createTurnRunner({ hot: fakeHot(), store, llm, calibrator: identityCalibrator(), client: fakeClient(), now: () => NOW });

  const { result } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));

  assert.equal(result.outcome, 'skip');
  const text = userText(llm);
  const recent = text.split('<recent>\n')[1].split('\n</recent>')[0];
  assert.ok(recent.includes('εδώ το πρωί'), "this channel's line");
  const at = NOW - 2 * HOUR;
  const openLine = fill(labels.recent.lineIn, { date: formatDate(at, 'UTC', labels.locale), time: formatClock(at, 'UTC', labels.locale), channel: 'open', text: 'στην αυλή' });
  assert.ok(recent.includes(openLine), 'named by its channel');
  assert.ok(!text.includes('στο γραφείο'), 'a channel only the staff can read never reaches #general');

  // In #staff, whose readers can all read #general and #open, all three are shown.
  const staffChannel = { ...fakeTurnChannel({ id: STAFF_ROOM, historyMessages: [{ ...raw, channelId: STAFF_ROOM }] }), guild: channel.guild };
  staffChannel.permissionsFor = channel.guild.channels.cache.get(STAFF_ROOM).permissionsFor;
  const staffLlm = fakeLlm('<skip/>');
  const staffTurns = createTurnRunner({ hot: fakeHot(), store, llm: staffLlm, calibrator: identityCalibrator(), client: fakeClient(), now: () => NOW });
  registerTextChannel(channel);
  await withCapturedLogs(() =>
    staffTurns.runTurn({ channel: staffChannel, mode: 'reply', trigger: { ...normalizedTrigger(raw), channelId: STAFF_ROOM }, triggerKind: 'mention' }),
  );
  assert.ok(userText(staffLlm).includes('στο γραφείο') && userText(staffLlm).includes('στην αυλή') && userText(staffLlm).includes('εδώ το πρωί'));
});

test('turn: a private chat shows only the recent lines of channels everyone on the server can read', async () => {
  const general = fakeTurnChannel({ id: 'c1' });
  const guild = audienceGuild(general.guild);
  registerTextChannel(general);
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', content: 'hey' });
  const dm = fakeTurnChannel({ id: 'dm1', dm: true, historyMessages: [raw] });
  const store = recentStore(threeRooms());
  const llm = fakeLlm('<skip/>');
  const client = fakeClient({ guilds: { cache: new Map([[guild.id, guild]]) } });
  const turns = createTurnRunner({ hot: fakeHot(), store, llm, calibrator: identityCalibrator(), client, now: () => NOW });

  await withCapturedLogs(() => turns.runTurn({ channel: dm, guildId: guild.id, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'private' }));

  const text = userText(llm);
  assert.ok(text.includes('εδώ το πρωί') && text.includes('στην αυλή'), 'channels every member can read');
  assert.ok(!text.includes('στο γραφείο'));

  // A role denied on #open hides it from some members: it is no longer every member's.
  guild.channels.cache.get(OPEN_ROOM).permissionOverwrites = {
    cache: new Map([[STAFF_ROLE, { id: STAFF_ROLE, type: 0, allow: { has: () => false }, deny: { has: (flag) => flag === PermissionFlagsBits.ViewChannel } }]]),
  };
  const deniedLlm = fakeLlm('<skip/>');
  const denied = createTurnRunner({ hot: fakeHot(), store, llm: deniedLlm, calibrator: identityCalibrator(), client, now: () => NOW });
  await withCapturedLogs(() => denied.runTurn({ channel: dm, guildId: guild.id, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'private' }));
  assert.ok(userText(deniedLlm).includes('εδώ το πρωί') && !userText(deniedLlm).includes('στην αυλή'));
});

test('turn: with no live line <recent> still shows the moments of the last hours, and a line hidden here changes nothing', async () => {
  const nikos = {
    id: 'u9',
    names: ['Nikos'],
    episodes: [{ date: '2026-09-19', what: 'η στιγμή του Nikos', quote: '', feeling: '', weight: 3, addedAt: new Date(NOW - 20 * HOUR).toISOString() }],
  };
  const run = async (lines) => {
    const raw = rawMessage({ id: 'm1' });
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    audienceGuild(channel.guild);
    const llm = fakeLlm('<skip/>');
    const store = recentStore(lines, { userProfiles: { u9: nikos } });
    const turns = createTurnRunner({ hot: fakeHot(), store, llm, calibrator: identityCalibrator(), client: fakeClient(), now: () => NOW });
    const { logs } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
    return { text: userText(llm), logs };
  };
  const quiet = await run([]);
  const moment = fill(labels.recent.episode, { date: formatDate(Date.parse('2026-09-19T12:00:00Z'), 'UTC', labels.locale), name: 'Nikos', what: 'η στιγμή του Nikos' });
  assert.ok(quiet.text.includes(`<recent>\n${fill(labels.recent.header, { hours: 72 })}\n${moment}\n</recent>`), 'an empty store still shows the moments');

  const staffOnly = await run([threeRooms()[2]]);
  assert.equal(staffOnly.text, quiet.text, 'a line only #staff can read neither switches the moments on nor off');
});

test('turn: features.recent false, memory off or a store without the recent store read nothing and change nothing', async () => {
  const run = async ({ store, features = {} }) => {
    const raw = rawMessage({ id: 'm1' });
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    audienceGuild(channel.guild);
    const llm = fakeLlm('<skip/>');
    const turns = createTurnRunner({ hot: fakeHot(features), store, llm, calibrator: identityCalibrator(), client: fakeClient(), now: () => NOW });
    const { result, logs } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
    return { result, logs, sent: llm.calls[0] };
  };
  const before = await run({ store: fakeStore() });
  assert.equal(before.result.outcome, 'skip', 'a store without getRecent never breaks a turn');
  assert.ok(!userTextOf(before.sent).includes('<recent>'));

  for (const [label, features] of [['recent off', { recent: false }], ['memory off', { memory: false }]]) {
    const store = recentStore(threeRooms());
    const { result, logs, sent } = await run({ store, features });
    assert.equal(result.outcome, 'skip', label);
    assert.equal(store.recentReads, 0, label);
    assert.ok(!userTextOf(sent).includes('<recent>'), label);
    assert.deepEqual(recentShownLogs(logs), [], label);
  }
  const offBefore = await run({ store: fakeStore(), features: { recent: false } });
  const off = await run({ store: recentStore(threeRooms()), features: { recent: false } });
  assert.deepEqual(off.sent, offBefore.sent, 'the request is the one built without the store');

  const empty = await run({ store: recentStore([]) });
  assert.deepEqual(empty.sent, before.sent, 'an empty store and no moment in the window: the request as before');
  assert.deepEqual(recentShownLogs(empty.logs), []);

  // A store whose read throws: logged, no block, the turn goes on.
  const broken = fakeStore();
  broken.getRecent = () => {
    throw new Error('fixture: unreadable recent store');
  };
  const failed = await run({ store: broken });
  assert.equal(failed.result.outcome, 'skip');
  assert.deepEqual(failed.sent, before.sent);
  assert.ok(failed.logs.some((entry) => entry.msg === 'recent: failed' && entry.channel === 'c1'));
});

// --- the request input, named in full (src/behavior/turn-input.js) ----------------------------

/** Makes #open and #staff of audienceGuild active neighbours (a fresh line each), recording their fetches. */
function activeRooms(guild) {
  const fetched = [];
  for (const [id, text] of [[OPEN_ROOM, 'στην αυλή τώρα'], [STAFF_ROOM, 'στο γραφείο τώρα']]) {
    const room = guild.channels.cache.get(id);
    const line = lineIn(id, { id: `${id}-1`, authorId: 'u5', authorName: 'Inès', ts: NOW - 2 * MINUTE, content: text });
    Object.assign(room, {
      viewable: true,
      lastMessageId: SnowflakeUtil.generate({ timestamp: NOW - 2 * MINUTE }).toString(),
      messages: {
        cache: new Map(),
        fetch: async () => {
          fetched.push(id);
          return new Map([[line.id, line]]);
        },
      },
    });
  }
  return fetched;
}

test('runTurn: a neighbour whose audience the channel does not cover is left out of <other_channels> and <server>, unfetched', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  audienceGuild(channel.guild);
  const fetched = activeRooms(channel.guild);
  const store = fakeStore({
    channels: [
      { id: 'c1', name: 'general', days: {} },
      { id: OPEN_ROOM, name: 'open', note: 'η αυλή του σπιτιού', days: {} },
      { id: STAFF_ROOM, name: 'staff', note: 'το γραφείο της ομάδας', days: {} },
    ],
  });
  const llm = fakeLlm('<skip/>');
  const turns = createTurnRunner({ hot: fakeHot(), store, llm, calibrator: identityCalibrator(), client: fakeClient(), now: () => NOW });

  const { logs } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));

  const text = userText(llm);
  assert.ok(text.includes('στην αυλή τώρα'), 'the covered neighbour is shown');
  assert.ok(!text.includes('στο γραφείο τώρα'), "the staff room's lines stay out");
  assert.ok(!text.includes('το γραφείο της ομάδας'), "the staff room's note stays out of <server>");
  assert.deepEqual(fetched, [OPEN_ROOM], 'the refused neighbour costs no history fetch');
  assert.equal(logs.find((l) => l.msg === 'turn: model answered').neighborsHidden, 1);
});

// --- I-7: destinations, the post ledger, send failures, the drawFailed turn, dry-run, caps -------

test('usableDestination: the dry-run mirror or a channel the bot cannot read is never the destination', () => {
  const general = registerTextChannel(fakeTurnChannel());
  const hall = addChannel(general, { id: 'c6', name: 'hall' });
  const config = { bot: { dryRunChannelId: 'c1' }, features: {}, memory: { mainChannelIds: ['c1', 'c6'] } };
  assert.equal(usableDestination(general.guild, config).channel, hall, 'the mirror is passed over');
  hall.permissionsFor = () => ({ has: (flag) => flag !== PermissionFlagsBits.ReadMessageHistory });
  assert.deepEqual(usableDestination(general.guild, config), { channel: null, reason: 'no-destination' }, 'unreadable: not usable');
});

/**
 * A follow-up turn in #general (c1) answering Alice's line m1 after Bob's m0. `answer` is the
 * model's text, or a `complete` function; `configure` sees the channel, store and hot first.
 */
async function ledgerTurn({ features = {}, answer = '<msg>ένα</msg><msg>δύο</msg>', mentor, configure } = {}) {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [rawMessage({ id: 'm0', ts: NOW - 5000, authorId: 'u2', authorName: 'Bob' }), raw] });
  const store = fakeStore();
  const hot = fakeHot({ typingSimulation: false, ...features }, {}, mentor ? { mentor } : {});
  const llm = typeof answer === 'function' ? { complete: answer } : fakeLlm(answer);
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), now: () => NOW });
  configure?.({ channel, store, hot });
  const { result, logs } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'followUp' }));
  return { result, logs, channel, store, turns };
}

test('runTurn: with features.mentor on, every posted message leaves a ledger entry naming its turn', async () => {
  const { result, store } = await ledgerTurn({ features: { mentor: true } });
  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(store.state.data.postLedger, [
    { messageId: 'sent-1', channelId: 'c1', mode: 'reply', triggerKind: 'followUp', triggerId: 'm1', newestHistoryId: 'm1', sourceChannelId: null, at: NOW },
    { messageId: 'sent-2', channelId: 'c1', mode: 'reply', triggerKind: 'followUp', triggerId: 'm1', newestHistoryId: 'm1', sourceChannelId: null, at: NOW },
  ]);
});

test('runTurn: the ledger keeps the newest mentor.anchor.ledgerSize entries', async () => {
  const older = [{ messageId: 'x1' }, { messageId: 'x2' }];
  const { store } = await ledgerTurn({
    features: { mentor: true },
    mentor: { anchor: { ledgerSize: 3 } },
    configure: ({ store: s }) => {
      s.state.data.postLedger = older;
    },
  });
  assert.deepEqual(store.state.data.postLedger.map((entry) => entry.messageId), ['x2', 'sent-1', 'sent-2']);
  assert.deepEqual(older.map((entry) => entry.messageId), ['x1', 'x2'], 'the stored list is not changed in place');
});

test('runTurn: no ledger entry with the mentor off, while paused, or in a dry run', async () => {
  for (const features of [{}, { mentor: false }, { mentor: true, dryRun: true }]) {
    const { result, store } = await ledgerTurn({ features });
    assert.equal(result.outcome, 'spoke', JSON.stringify(features));
    assert.equal('postLedger' in store.state.data, false, JSON.stringify(features));
  }
  // Paused while the turn was already running (a pause waits for it): nothing is written.
  let state;
  const { result, store } = await ledgerTurn({
    features: { mentor: true },
    configure: ({ store: s }) => {
      state = s.state.data;
    },
    answer: async () => {
      state.paused = true;
      return { text: '<msg>ένα</msg>', usage: {}, estimated: 1 };
    },
  });
  assert.equal(result.outcome, 'spoke');
  assert.equal('postLedger' in store.state.data, false);
});

test("postLedgerSize: the code fallback is config.json's mentor.anchor.ledgerSize", () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.equal(postLedgerSize({}), shipped.mentor.anchor.ledgerSize);
  assert.equal(postLedgerSize({ mentor: { anchor: { ledgerSize: 7.9 } } }), 7);
  assert.equal(postLedgerSize({ mentor: { anchor: { ledgerSize: 0 } } }), 0);
  assert.equal(postLedgerSize({ mentor: { anchor: { ledgerSize: -1 } } }), postLedgerSize({}));
});

test('appendPostLedger: appends, keeps the newest size entries, a non-list is empty, 0 keeps none', () => {
  const entry = (id) => ({ messageId: id });
  assert.deepEqual(appendPostLedger([entry('a'), entry('b')], entry('c'), 2), [entry('b'), entry('c')]);
  assert.deepEqual(appendPostLedger(undefined, entry('a'), 5), [entry('a')]);
  assert.deepEqual(appendPostLedger({ length: 1 }, entry('a'), 5), [entry('a')]);
  assert.deepEqual(appendPostLedger([entry('a')], entry('b'), 0), []);
});

test('runTurn: a second message that fails to send ends the turn as spoke with what reached the chat', async () => {
  const { result, logs, channel, turns } = await ledgerTurn({
    answer: '<msg>ένα</msg><msg>δύο</msg><msg>τρία</msg>',
    configure: ({ channel: c }) => {
      const send = c.send;
      c.send = async (payload) => {
        if (payload.content === 'δύο') throw new Error('fixture: Missing Permissions');
        return send(payload);
      };
    },
  });
  assert.deepEqual({ outcome: result.outcome, delivered: result.delivered }, { outcome: 'spoke', delivered: true });
  assert.deepEqual(channel.sent.map((payload) => payload.content), ['ένα'], 'nothing after the failed message');
  const failed = logs.find((entry) => entry.msg === 'turn: send failed');
  assert.deepEqual([failed.level, failed.channel, failed.index], ['warn', 'c1', 1]);
  assert.equal(turns.spokeAfterSeeing('c1', 'm1'), true, 'the turn noted what it had in view');
});

test('runTurn: a first message that fails to send ends spoke with nothing delivered', async () => {
  const { result, channel } = await ledgerTurn({
    configure: ({ channel: c }) => {
      c.send = async () => {
        throw new Error('fixture: Missing Permissions');
      };
    },
  });
  assert.deepEqual({ outcome: result.outcome, delivered: result.delivered }, { outcome: 'spoke', delivered: false });
  assert.equal(channel.sent.length, 0);
});

test('runTurn: a post that grew past 2000 characters once its mentions expanded is cut to fit, never inside a mention', async () => {
  const { channel } = await ledgerTurn({ answer: `<msg>${'α'.repeat(1880)} @Bob @Bob @Bob @Bob</msg>` });
  const [payload] = channel.sent;
  assert.ok([...payload.content].length <= 2000, String([...payload.content].length));
  assert.ok(payload.content.lastIndexOf('<') <= payload.content.lastIndexOf('>'), 'no half mention at the end');
  assert.ok(payload.content.includes('<@u2>'), 'the mentions that fit stay');
});

test('runTurn: the drawFailed turn after a follow-up posts plain, after a mention as a reply', async () => {
  for (const [triggerKind, reply] of [['followUp', undefined], ['mention', { messageReference: 'm1', failIfNotExists: false }]]) {
    const { channel, llm } = await runDrawTurn({
      triggerKind,
      answers: ['<draw>a cat</draw>', '<msg reply="#1">δεν βγήκε</msg>'],
      images: fakeImages({ error: new ImageGenError('moderation') }),
    });
    assert.equal(llm.calls.length, 2, triggerKind);
    assert.deepEqual(channel.sent.map((payload) => payload.reply), [reply], triggerKind);
  }
});

test('runTurn: a reaction stamps no lastPostAt, in a dry run or for real', async () => {
  const raw = rawMessage({ id: 'm1', authorName: 'Élodie' });
  const channel = fakeTurnChannel({ id: 'c1', name: 'general', historyMessages: [raw] });
  const hot = fakeHot({ dryRun: true });
  const turns = createTurnRunner({ hot, store: fakeStore(), llm: fakeLlm('<react to="#1">👍</react>'), calibrator: identityCalibrator(), client: fakeClient(), now: () => NOW });
  await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
  assert.equal(turns.lastPostAt('c1'), 0);

  const real = fakeTurnChannel({ id: 'c1', name: 'general', historyMessages: [raw] });
  const live = createTurnRunner({ hot: fakeHot({ typingSimulation: false }), store: fakeStore(), llm: fakeLlm('<react to="#1">👍</react>'), calibrator: identityCalibrator(), client: fakeClient(), now: () => NOW });
  await withCapturedLogs(() => live.runTurn({ channel: real, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
  assert.equal(real.reactCalls.length, 1);
  assert.equal(live.lastPostAt('c1'), 0);
});

test('runTurn: the search classifier is not asked when no web slot is left today', async () => {
  for (const [left, asked] of [[0, 0], [3, 1]]) {
    const llm = lookupLlm('champions final winner 2026');
    const lookup = { ...fakeLookup(), webCapLeft: () => left };
    const { logs } = await withCapturedLogs(() => runLookupTurn({ llm, lookup }));
    assert.equal(llm.classifierCalls.length, asked, String(left));
    assert.equal(lookup.searchCalls.length, asked, String(left));
    assert.equal(logs.some((entry) => entry.msg === 'lookup: skipped' && entry.reason === 'cap'), !asked, String(left));
  }
});

test('runTurn: the re-watch classifier is not asked when no video slot is left; with only re-watches spent, failed videos alone are offered', async () => {
  const spent = fakeRewatchDescriber({ va: { state: 'watched', text: 'ένα αυτοκίνητο περνά' } });
  spent.videoCapsLeft = () => ({ video: 0, rewatch: 5 });
  const capped = await withCapturedLogs(() => runRewatch({ describer: spent }));
  assert.equal(capped.result.llm.classifierCalls.length, 0);
  assert.ok(capped.logs.some((entry) => entry.msg === 'rewatch: skipped' && entry.reason === 'cap'));

  const noQuestions = fakeRewatchDescriber({ va: { state: 'watched', text: 'ένα αυτοκίνητο περνά' } });
  noQuestions.videoCapsLeft = () => ({ video: 5, rewatch: 0 });
  const quiet = await withCapturedLogs(() => runRewatch({ describer: noQuestions }));
  assert.equal(quiet.result.llm.classifierCalls.length, 0, 'no retry possible, no question allowed');

  const retry = fakeRewatchDescriber({ va: { state: 'watched', text: 'ένα αυτοκίνητο περνά' }, vb: { state: 'error', reason: 'fetch' } });
  retry.describeVideo = async () => null;
  retry.videoCapsLeft = () => ({ video: 5, rewatch: 0 });
  const scene = rewatchScene();
  const broken = videoAttachmentRaw('m0', NOW - 9000, 'vb', 'broken.mp4');
  scene.channel = fakeTurnChannel({ historyMessages: [broken, scene.video, scene.trigger] });
  const offered = await withCapturedLogs(() => runRewatch({ describer: retry, scene, llm: rewatchLlm('none') }));
  const [call] = offered.result.llm.classifierCalls;
  const videos = textOf(call.messages[1].content).split('<media>\n')[1].split('\n</media>')[0];
  assert.deepEqual(videos.split('\n').map((line) => line.split(' | ')[2]), ['broken.mp4'], 'only the video that did not load');
});

test('runTurn: the GIF and the picture a turn posts get their ledger entries too', async () => {
  const { store } = await ledgerTurn({
    features: { mentor: true },
    answer: '<msg>ένα</msg><gif>g1</gif>',
    configure: ({ store: s }) => {
      s.findGif = gifStore().findGif;
    },
  });
  assert.deepEqual(store.state.data.postLedger.map((entry) => entry.messageId), ['sent-1', 'sent-2']);

  const hot = drawHot({ mentor: true });
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const drawStore = fakeStore();
  const turns = createTurnRunner({ hot, store: drawStore, llm: fakeLlm('<draw>a cat</draw>'), calibrator: identityCalibrator(), client: fakeClient(), images: fakeImages(), imageFetcher: fakeImageFetcher(), now: () => NOW });
  await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
  assert.deepEqual(drawStore.state.data.postLedger, [
    { messageId: 'sent-1', channelId: 'c1', mode: 'reply', triggerKind: 'mention', triggerId: 'm1', newestHistoryId: 'm1', sourceChannelId: null, at: NOW },
  ]);
});

test('runTurn: a routed answer records the call it answered and its source channel', async () => {
  const scene = asMainChannel(routedScene({ features: { mentor: true } }));
  await withCapturedLogs(() => scene.turns.runTurn(scene.params));
  assert.deepEqual(scene.store.state.data.postLedger, [
    { messageId: 'sent-1', channelId: 'c1', mode: 'reply', triggerKind: 'mention', triggerId: 'd3', newestHistoryId: 'm1', sourceChannelId: DIARY, at: NOW },
  ]);
});

// ---------------------------------------------------------------------------
// Pace: the helpers before the reply request run together, under one deadline (pace.*).

/** A promise with its resolve and reject handed out. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A fake `schedule`: every timer is kept with its delay and fired by hand. */
function fakeSchedule() {
  const timers = [];
  return {
    timers,
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false, fired: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    live: () => timers.filter((timer) => !timer.cancelled && !timer.fired),
    fire(timer) {
      timer.fired = true;
      timer.fn();
    },
  };
}

/** Let pending callbacks run, one round of immediates at a time, until `done()` holds (at most `rounds`). */
async function settleUntil(done = () => false, rounds = 50) {
  for (let i = 0; i < rounds && !done(); i += 1) await new Promise((resolve) => setImmediate(resolve));
}

// The pace every test below sets for itself; a test passing its own `pace` overrides single keys.
const TEST_PACE = { prepareMs: 1000, prepareSearchMs: 3000, dropAfterMs: 0, replyHedgeMs: 0, typingWhilePreparing: false };

function paceHot(features = {}, pace = {}) {
  const hot = lookupHot({ mediaDescriptions: true, ...features });
  hot.config.pace = { ...TEST_PACE, ...pace };
  return hot;
}

/**
 * A reply turn whose chat holds a picture (img1) and a page link (m2#e0) before the trigger. The
 * describer's caption and the lookup's read answer once `caption` / `read` (deferreds) settle,
 * at once without them; the lookup has no search, so no classifier runs.
 */
function paceScene({ hot = paceHot(), caption = null, read = null, clock = () => NOW, llm = fakeLlm('<msg>ok</msg>'), timers = fakeSchedule() } = {}) {
  const picture = rawMessage({
    id: 'm1',
    ts: NOW - 9000,
    attachments: new Map([['img1', { id: 'img1', contentType: 'image/png', name: 'pic.png', url: 'https://cdn/pic.png' }]]),
  });
  const link = linkRaw('m2', NOW - 5000, [PAGE_EMBED]);
  const trigger = rawMessage({ id: 'm3', ts: NOW - 1000, authorName: 'Zoë', content: 'τι λες;' });
  const channel = fakeTurnChannel({ historyMessages: [picture, link, trigger] });
  const describer = {
    calls: 0,
    describeMany: async () => {
      describer.calls += 1;
      await caption?.promise;
      return { descriptions: new Map([['img1', 'a grey cat']]), newCount: 1 };
    },
  };
  const lookup = {
    calls: 0,
    readLinks: async () => {
      lookup.calls += 1;
      await read?.promise;
      return { reads: new Map([['m2#e0', 'une recette']]), newCount: 1 };
    },
  };
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), describer, lookup, now: clock, schedule: timers.schedule });
  const params = { channel, mode: 'reply', trigger: normalizedTrigger(trigger), triggerKind: 'mention' };
  return { turns, params, channel, llm, describer, lookup, timers };
}

const CAPTION_SHOWN = fill(labels.transcript.imageDescribed, { text: 'a grey cat' });
const READ_SHOWN = fill(labels.transcript.linkRead, { text: 'une recette' });

test('paceSettings: 0, a negative value or a non-number turns a limit off; a missing key keeps a positive limit', () => {
  const missing = paceSettings({});
  assert.ok(missing.prepareMs > 0 && missing.prepareSearchMs > 0 && missing.prepareMediaMs > 0);
  assert.equal(missing.typingWhilePreparing, false, 'the early indicator is opt-in');
  for (const off of [0, -5, '6000', null, Number.NaN, Infinity]) {
    const pace = paceSettings({ pace: { prepareMs: off, prepareSearchMs: off, prepareMediaMs: off } });
    assert.equal(pace.prepareMs, null, String(off));
    assert.equal(pace.prepareSearchMs, null, String(off));
    assert.equal(pace.prepareMediaMs, null, String(off));
  }
  assert.ok(missing.dropAfterMs > 0);
  assert.equal(paceSettings({ pace: { dropAfterMs: 0 } }).dropAfterMs, null);
  assert.ok(missing.replyHedgeMs > 0);
  for (const off of [0, -5, '500', null, Number.NaN, Infinity]) {
    assert.equal(paceSettings({ pace: { replyHedgeMs: off } }).replyHedgeMs, null, String(off));
  }
  assert.deepEqual(paceSettings({ pace: { prepareMs: 2500, prepareSearchMs: 7000, prepareMediaMs: 8000, dropAfterMs: 9000, replyHedgeMs: 4000, typingWhilePreparing: false, unpromptedWaits: false, settleMs: 3000, settleMaxMs: 9000 } }), {
    prepareMs: 2500,
    prepareSearchMs: 7000,
    prepareMediaMs: 8000,
    dropAfterMs: 9000,
    replyHedgeMs: 4000,
    typingWhilePreparing: false,
    unpromptedWaits: false,
    settleMs: 3000,
    settleMaxMs: 9000,
  });
  assert.deepEqual(paceSettings({ pace: 'fast' }), missing, 'a group that is not an object counts as missing');
});

// pace.settleMs: a turn answering a person waits, once it holds the attention, until that
// person has been quiet for settleMs, so a thought posted as several quick messages is read whole.
const SETTLE_PACE = { prepareMs: 0, prepareSearchMs: 0, prepareMediaMs: 0, dropAfterMs: 0, replyHedgeMs: 0, typingWhilePreparing: false, unpromptedWaits: true, settleMaxMs: 15000 };

/** A reply scene whose `schedule` moves the clock by each delay and fires at once; history fetches are timed. */
function settleScene({ settleMs, activity }) {
  const clock = { t: NOW };
  const raw = rawMessage({ id: 'm1', ts: NOW - 1000 });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const fetchedAt = [];
  const fetchAll = channel.messages.fetch;
  channel.messages.fetch = async (arg) => {
    if (arg && typeof arg === 'object' && 'limit' in arg) fetchedAt.push(clock.t);
    return fetchAll(arg);
  };
  const waits = [];
  const schedule = (fn, ms) => {
    waits.push(ms);
    clock.t += ms;
    activity?.onWait?.(clock.t);
    setImmediate(fn);
    return () => {};
  };
  const hot = fakeHot({}, {}, { pace: { ...SETTLE_PACE, settleMs } });
  const turns = createTurnRunner({ hot, store: fakeStore(), llm: fakeLlm('<msg>ok</msg>'), calibrator: identityCalibrator(), client: fakeClient(), now: () => clock.t, schedule, activity });
  return { turns, channel, raw, fetchedAt, waits };
}

test('paceSettings: settleMs is 0 (off) for 0, a negative value or a non-number; settleMaxMs is null for those', () => {
  for (const off of [0, -5, '500', null, Number.NaN, Infinity]) {
    const pace = paceSettings({ pace: { settleMs: off, settleMaxMs: off } });
    assert.equal(pace.settleMs, 0, String(off));
    assert.equal(pace.settleMaxMs, null, String(off));
  }
  assert.equal(paceSettings({ pace: { settleMs: 2500 } }).settleMs, 2500);
});

test('runTurn: with pace.settleMs the history is read only once the author has been quiet that long', async () => {
  // The author wrote at NOW - 1000; during the first pause they write once more (500 ms before it ends).
  let last = NOW - 1000;
  const activity = {
    lastAt: (channelId, authorId) => (channelId === 'c1' && authorId === 'u1' ? last : null),
    onWait(t) {
      if (t === NOW + 250) last = t - 500;
    },
  };
  const scene = settleScene({ settleMs: 4000, activity });
  const { result, logs } = await withCapturedLogs(() =>
    scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: normalizedTrigger(scene.raw), triggerKind: 'mention' }),
  );

  assert.equal(result.outcome, 'spoke');
  // Quiet from NOW - 250 for 4000 ms: the history is read at NOW + 3750, after every pause.
  assert.equal(scene.waits.reduce((sum, ms) => sum + ms, 0), 3750);
  assert.ok(scene.waits.length > 1 && scene.waits.every((ms) => ms > 0 && ms <= 250), String(scene.waits));
  assert.deepEqual(scene.fetchedAt.slice(0, 1), [NOW + 3750]);
  const timings = logs.find((l) => l.msg === 'turn: timings');
  assert.equal(timings.settleMs, 3750);
  assert.equal(timings.totalMs, 0, 'the turn clock starts after the settle');
});

test('runTurn: settle off, no tracker or no author to wait for -- no pause before the history', async () => {
  const recent = { lastAt: () => NOW - 100 };
  for (const [name, settleMs, activity, params] of [
    ['settleMs 0', 0, recent, {}],
    ['no tracker', 4000, undefined, {}],
    ['spontaneous', 4000, recent, { mode: 'interject', trigger: null, triggerKind: null }],
  ]) {
    const scene = settleScene({ settleMs, activity });
    const { logs } = await withCapturedLogs(() =>
      scene.turns.runTurn({ channel: scene.channel, mode: 'reply', trigger: normalizedTrigger(scene.raw), triggerKind: 'mention', ...params }),
    );
    assert.deepEqual(scene.waits, [], name);
    assert.deepEqual(scene.fetchedAt.slice(0, 1), [NOW], name);
    assert.equal(logs.find((l) => l.msg === 'turn: timings').settleMs, 0, name);
  }
});

test('runTurn: the helpers before the reply request overlap -- two slow ones take the time of one', async () => {
  let t = NOW;
  const caption = deferred();
  const read = deferred();
  const scene = paceScene({ caption, read, clock: () => t });

  const running = withCapturedLogs(() => scene.turns.runTurn(scene.params));
  await settleUntil(() => scene.describer.calls > 0 && scene.lookup.calls > 0);
  assert.deepEqual([scene.describer.calls, scene.lookup.calls], [1, 1], 'both asked before either answered');
  assert.equal(scene.llm.calls.length, 0);
  t = NOW + 1000;
  caption.resolve();
  read.resolve();
  const { result, logs } = await running;

  assert.equal(result.outcome, 'spoke');
  const timings = logs.find((l) => l.msg === 'turn: timings');
  assert.equal(timings.stages.captions, 1000);
  assert.equal(timings.stages.links, 1000);
  assert.equal(timings.prepareMs, 1000, 'the maximum of the two, not their sum');
  const user = userText(scene.llm);
  assert.ok(user.includes(CAPTION_SHOWN) && user.includes(READ_SHOWN), user);
});

test('runTurn: with every helper in time the request is the one built without a deadline', async () => {
  const withDeadline = paceScene();
  const { logs } = await withCapturedLogs(() => withDeadline.turns.runTurn(withDeadline.params));
  const waiting = paceScene({ hot: paceHot({}, { prepareMs: 0, prepareSearchMs: 0 }) });
  await withCapturedLogs(() => waiting.turns.runTurn(waiting.params));

  assert.deepEqual(withDeadline.llm.calls[0], waiting.llm.calls[0]);
  const user = userText(withDeadline.llm);
  assert.ok(user.includes(CAPTION_SHOWN) && user.includes(READ_SHOWN), user);
  assert.deepEqual(logs.find((l) => l.msg === 'turn: timings').late, []);
  assert.ok(withDeadline.timers.timers.every((timer) => timer.cancelled && !timer.fired), 'the deadline is cleared once everything is in');
});

test('runTurn: a helper past pace.prepareMs is left out and named in late; its late result changes nothing', async () => {
  const caption = deferred();
  const scene = paceScene({ caption });

  const running = withCapturedLogs(() => scene.turns.runTurn(scene.params));
  await settleUntil(() => scene.describer.calls > 0 && scene.timers.live().length > 0);
  const [deadline] = scene.timers.live();
  assert.equal(deadline.ms, TEST_PACE.prepareMs);
  scene.timers.fire(deadline);
  const { result, logs } = await running;

  assert.equal(result.outcome, 'spoke');
  const user = userText(scene.llm);
  assert.ok(!user.includes('a grey cat'), 'the late caption is absent');
  assert.ok(user.includes(READ_SHOWN), 'the read in time is there');
  const timings = logs.find((l) => l.msg === 'turn: timings');
  assert.deepEqual(timings.late, ['captions']);
  assert.equal(timings.stages.captions, null);
  assert.equal(typeof timings.stages.links, 'number');

  const { logs: after } = await withCapturedLogs(async () => {
    caption.resolve();
    await settleUntil();
  });
  assert.equal(scene.llm.calls.length, 1, 'nothing more reaches the model');
  assert.equal(scene.channel.sent.length, 1);
  assert.deepEqual(
    after.filter((l) => l.msg === 'turn: stage late').map((l) => [l.stage, typeof l.ms]),
    [['captions', 'number']],
  );
});

test('runTurn: a helper that fails after the deadline throws nothing and changes nothing', async () => {
  const caption = deferred();
  const scene = paceScene({ caption });
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const running = withCapturedLogs(() => scene.turns.runTurn(scene.params));
    await settleUntil(() => scene.describer.calls > 0 && scene.timers.live().length > 0);
    scene.timers.fire(scene.timers.live()[0]);
    const { result } = await running;
    assert.equal(result.outcome, 'spoke');

    const { logs } = await withCapturedLogs(async () => {
      caption.reject(new Error('describer down'));
      await settleUntil();
    });
    assert.deepEqual(unhandled, []);
    assert.equal(scene.llm.calls.length, 1);
    assert.equal(scene.channel.sent.length, 1);
    assert.ok(logs.some((l) => l.msg === 'turn: stage failed' && l.stage === 'captions'));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('runTurn: pace.prepareMs 0 waits for every helper, however slow', async () => {
  const caption = deferred();
  const scene = paceScene({ caption, hot: paceHot({}, { prepareMs: 0 }) });

  const running = withCapturedLogs(() => scene.turns.runTurn(scene.params));
  await settleUntil(() => scene.describer.calls > 0);
  await settleUntil();
  assert.equal(scene.timers.timers.length, 0, 'no deadline is set');
  assert.equal(scene.llm.calls.length, 0, 'the turn still waits');
  caption.resolve();
  const { logs } = await running;

  assert.ok(userText(scene.llm).includes(CAPTION_SHOWN));
  assert.deepEqual(logs.find((l) => l.msg === 'turn: timings').late, []);
});

test('paceSettings: unpromptedWaits is on unless it is exactly false', () => {
  assert.equal(paceSettings({ pace: { unpromptedWaits: false } }).unpromptedWaits, false);
  for (const on of [true, undefined, null, 0, 'false']) {
    assert.equal(paceSettings({ pace: { unpromptedWaits: on } }).unpromptedWaits, true, String(on));
  }
});

// A turn nobody waits for (pace.unpromptedWaits): a spontaneous one and an overheard line.
const UNHURRIED_TURNS = [
  ['an initiate turn', (scene) => ({ channel: scene.channel, mode: 'initiate' })],
  ['an overheard line', (scene) => ({ ...scene.params, triggerKind: 'overheard' })],
];

for (const [name, paramsOf] of UNHURRIED_TURNS) {
  test(`runTurn: ${name} with pace.unpromptedWaits on has no deadline and no bar -- it waits for a slow helper`, async () => {
    const caption = deferred();
    const scene = paceScene({ caption, hot: paceHot({}, { prepareMs: 1000, prepareSearchMs: 3000, dropAfterMs: 5000, unpromptedWaits: true }) });

    const running = withCapturedLogs(() => scene.turns.runTurn(paramsOf(scene)));
    await settleUntil(() => scene.describer.calls > 0);
    await settleUntil();
    assert.equal(scene.timers.timers.length, 0, 'neither a deadline nor a bar is set');
    assert.equal(scene.llm.calls.length, 0, 'the turn still waits');
    caption.resolve();
    const { result, logs } = await running;

    assert.equal(result.outcome, 'spoke');
    assert.ok(userText(scene.llm).includes(CAPTION_SHOWN), 'the slow caption enters the request');
    const timings = logs.find((l) => l.msg === 'turn: timings');
    assert.deepEqual(timings.late, []);
    assert.equal(typeof timings.stages.captions, 'number');
  });
}

test('runTurn: a mention with pace.unpromptedWaits on still cuts a slow helper at pace.prepareMs', async () => {
  const caption = deferred();
  const scene = paceScene({ caption, hot: paceHot({}, { prepareMs: 1000, dropAfterMs: 0, unpromptedWaits: true }) });

  const running = withCapturedLogs(() => scene.turns.runTurn(scene.params));
  await settleUntil(() => scene.describer.calls > 0 && scene.timers.live().length > 0);
  const [deadline] = scene.timers.live();
  assert.equal(deadline.ms, 1000);
  scene.timers.fire(deadline);
  const { result, logs } = await running;

  assert.equal(result.outcome, 'spoke');
  assert.ok(!userText(scene.llm).includes('a grey cat'), 'the late caption is absent');
  assert.deepEqual(logs.find((l) => l.msg === 'turn: timings').late, ['captions']);
  caption.resolve();
});

test('runTurn: with pace.unpromptedWaits false an initiate turn cuts a slow helper at pace.prepareMs, like a mention', async () => {
  const caption = deferred();
  const scene = paceScene({ caption, hot: paceHot({}, { prepareMs: 1000, dropAfterMs: 0, unpromptedWaits: false }) });

  const running = withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'initiate' }));
  await settleUntil(() => scene.describer.calls > 0 && scene.timers.live().length > 0);
  const [deadline] = scene.timers.live();
  assert.equal(deadline.ms, 1000);
  scene.timers.fire(deadline);
  const { result, logs } = await running;

  assert.equal(result.outcome, 'spoke');
  assert.ok(!userText(scene.llm).includes('a grey cat'), 'the late caption is absent');
  const timings = logs.find((l) => l.msg === 'turn: timings');
  assert.deepEqual([timings.mode, timings.triggerKind, timings.late], ['initiate', null, ['captions']]);
  caption.resolve();
});

test('runTurn: a search the classifier asks for moves the deadline to pace.prepareSearchMs, counted from the turn start', async () => {
  let t = NOW;
  const search = deferred();
  const lookup = fakeLookup();
  const searchOnce = lookup.search;
  lookup.search = async (guildId, query) => {
    await search.promise;
    return searchOnce(guildId, query);
  };
  const base = lookupLlm('champions final winner 2026');
  const llm = {
    ...base,
    complete: async (messages, options) => {
      if (messages[0].content.startsWith('Decide whether')) t = NOW + 500;
      return base.complete(messages, options);
    },
  };
  const hot = lookupHot();
  hot.config.pace = { ...TEST_PACE };
  const timers = fakeSchedule();
  const trigger = rawMessage({ id: 'm1', ts: NOW - 1000, authorName: 'Zoë', content: 'ποιος κέρδισε τον τελικό;' });
  const channel = fakeTurnChannel({ historyMessages: [trigger] });
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), lookup, now: () => t, schedule: timers.schedule });

  const running = withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(trigger), triggerKind: 'mention' }));
  await settleUntil(() => timers.timers.length > 1);
  const [first, second] = timers.timers;
  assert.equal(first.ms, TEST_PACE.prepareMs);
  assert.equal(first.cancelled, true, 'the first deadline is replaced');
  assert.equal(second.ms, TEST_PACE.prepareSearchMs - 500, 'the longer limit, less the time already spent');
  assert.equal(second.cancelled, false);
  search.resolve();
  const { logs } = await running;

  assert.ok(textOf(base.turnCalls[0].messages[1].content).includes('<lookup>'), 'the search arrived in time');
  const timings = logs.find((l) => l.msg === 'turn: timings');
  assert.deepEqual(timings.late, []);
  assert.equal(timings.stages.lookup, 500);
});

/**
 * A mention whose search classifier answers `classifierText` only once `verdict` (a deferred)
 * settles, under the test pace (prepareMs 1000, prepareSearchMs 3000) on a fake clock (`clock.t`).
 */
function slowClassifierScene(classifierText, verdict) {
  const clock = { t: NOW };
  const lookup = fakeLookup();
  const base = lookupLlm(classifierText);
  const llm = {
    ...base,
    complete: async (messages, options) => {
      if (messages[0].content.startsWith('Decide whether')) await verdict.promise;
      return base.complete(messages, options);
    },
  };
  const hot = lookupHot();
  hot.config.pace = { ...TEST_PACE };
  const timers = fakeSchedule();
  const trigger = rawMessage({ id: 'm1', ts: NOW - 1000, authorName: 'Zoë', content: 'ποιος κέρδισε τον τελικό;' });
  const channel = fakeTurnChannel({ historyMessages: [trigger] });
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), lookup, now: () => clock.t, schedule: timers.schedule });
  const params = { channel, mode: 'reply', trigger: normalizedTrigger(trigger), triggerKind: 'mention' };
  return { clock, base, timers, turns, params };
}

/** Run the scene's turn up to the base deadline firing at pace.prepareMs; returns the running turn and the timer left. */
async function pastBaseDeadline(scene) {
  const running = withCapturedLogs(() => scene.turns.runTurn(scene.params));
  await settleUntil(() => scene.timers.live().length > 0);
  const [first] = scene.timers.live();
  assert.equal(first.ms, TEST_PACE.prepareMs);
  scene.clock.t = NOW + TEST_PACE.prepareMs;
  scene.timers.fire(first);
  await settleUntil();
  assert.equal(scene.base.turnCalls.length, 0, 'no request while the classifier is still out');
  const live = scene.timers.live();
  assert.equal(live.length, 1, 'one deadline at a time');
  assert.equal(live[0].ms, TEST_PACE.prepareSearchMs - TEST_PACE.prepareMs, 'held at most until pace.prepareSearchMs from the turn start');
  return { running, first, held: live[0] };
}

test('runTurn: a search classifier slower than pace.prepareMs holds the deadline; its search lands in the request', async () => {
  const verdict = deferred();
  const scene = slowClassifierScene('champions final winner 2026', verdict);
  const { running, first } = await pastBaseDeadline(scene);
  scene.clock.t = NOW + 1500;
  verdict.resolve();
  const { result, logs } = await running;

  assert.equal(result.outcome, 'spoke');
  assert.ok(textOf(scene.base.turnCalls[0].messages[1].content).includes('ευρήματα'), 'the search arrived in time');
  assert.deepEqual(logs.find((l) => l.msg === 'turn: timings').late, []);
  assert.ok(!logs.some((l) => l.msg === 'turn: stage late' && l.stage === 'lookup'));
  assert.ok(scene.timers.timers.every((timer) => !timer.fired || timer === first), 'only the base deadline fired');
});

test('runTurn: a slow search classifier answering no search lets the request go out at its verdict', async () => {
  const verdict = deferred();
  const scene = slowClassifierScene('none', verdict);
  const { running, held } = await pastBaseDeadline(scene);
  scene.clock.t = NOW + 1500;
  verdict.resolve();
  const { result, logs } = await running;

  assert.equal(result.outcome, 'spoke');
  assert.equal(held.fired, false, 'not kept until pace.prepareSearchMs');
  assert.equal(held.cancelled, true);
  const timings = logs.find((l) => l.msg === 'turn: timings');
  assert.equal(timings.prepareMs, 1500, 'the request is built when the verdict arrives');
  assert.deepEqual(timings.late, []);
  assert.ok(!textOf(scene.base.turnCalls[0].messages[1].content).includes('ευρήματα'));
});

test('runTurn: a search classifier slower than pace.prepareSearchMs is left out at pace.prepareSearchMs', async () => {
  const verdict = deferred();
  const scene = slowClassifierScene('champions final winner 2026', verdict);
  const { running, held } = await pastBaseDeadline(scene);
  scene.clock.t = NOW + TEST_PACE.prepareSearchMs;
  scene.timers.fire(held);
  const { result, logs } = await running;

  assert.equal(result.outcome, 'spoke');
  assert.equal(scene.base.turnCalls.length, 1);
  assert.ok(!textOf(scene.base.turnCalls[0].messages[1].content).includes('ευρήματα'), 'went out without the search');
  const timings = logs.find((l) => l.msg === 'turn: timings');
  assert.equal(timings.prepareMs, TEST_PACE.prepareSearchMs);
  assert.deepEqual(timings.late, ['lookup']);
  verdict.resolve();
});

const WATCHED_TEXT = 'ένα ποτάμι κάτω από τη γέφυρα';

/**
 * A mention with a video attachment (va, clip.mov): on the trigger itself (`where: 'trigger'`),
 * on the older line the trigger replies to (`'replied'`), or on an older line only
 * (`'history'`). The video describer watches it once `watch` (a deferred) settles; `hot`
 * defaults to video vision on with the test pace and `pace` over it.
 */
function videoPaceScene({ pace = {}, where = 'trigger', watch = null, clock = () => NOW, hot = null, llm = fakeLlm('<msg>ok</msg>'), lookup = undefined, content = 'το βλέπεις;' } = {}) {
  const turnHot = hot ?? fakeHot({ mediaDescriptions: true, videoDescriptions: true, vision: false }, {}, VIDEO_TURN_CONFIG);
  turnHot.config.pace = { ...TEST_PACE, ...pace };
  const older = where === 'trigger' ? rawMessage({ id: 'm1', ts: NOW - 9000, content: 'γεια' }) : videoAttachmentRaw('m1', NOW - 9000, 'va', 'clip.mov');
  const trigger = where === 'trigger' ? videoAttachmentRaw('m2', NOW - 1000, 'va', 'clip.mov') : rawMessage({ id: 'm2', ts: NOW - 1000 });
  trigger.cleanContent = content;
  const channel = fakeTurnChannel({ historyMessages: [older, trigger] });
  const describer = fakeVideoDescriber({});
  describer.describeVideos = async (guildId, items, options) => {
    describer.videoCalls.push({ guildId, items, options });
    await watch?.promise;
    return { videos: new Map([['va', { state: 'watched', text: WATCHED_TEXT }]]), newCount: 1 };
  };
  const timers = fakeSchedule();
  const turns = createTurnRunner({ hot: turnHot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), describer, lookup, now: clock, schedule: timers.schedule });
  const called = { ...normalizedTrigger(trigger), replyToId: where === 'replied' ? 'm1' : null };
  const params = { channel, mode: 'reply', trigger: called, triggerKind: 'mention' };
  return { turns, params, channel, llm, describer, timers };
}

test('runTurn: a video on the trigger moves the deadline to pace.prepareMediaMs; a watch at 3 s makes it into the request', async () => {
  let t = NOW;
  const watch = deferred();
  const scene = videoPaceScene({ pace: { prepareMs: 1000, prepareMediaMs: 5000 }, watch, clock: () => t });

  const running = withCapturedLogs(() => scene.turns.runTurn(scene.params));
  await settleUntil(() => scene.describer.videoCalls.length > 0 && scene.timers.live().length > 0);
  const [first] = scene.timers.timers;
  assert.equal(first.ms, 1000);
  assert.equal(first.cancelled, true, 'the first deadline is replaced');
  assert.deepEqual(scene.timers.live().map((timer) => timer.ms), [5000]);
  t = NOW + 3000;
  watch.resolve();
  const { result, logs } = await running;

  assert.equal(result.outcome, 'spoke');
  assert.ok(userText(scene.llm).includes(WATCHED_TEXT), 'the watched video is in the request');
  const timings = logs.find((l) => l.msg === 'turn: timings');
  assert.deepEqual(timings.late, []);
  assert.equal(timings.stages.videos, 3000);
});

test('runTurn: pace.prepareMediaMs 0 leaves a video on the trigger under pace.prepareMs', async () => {
  const watch = deferred();
  const scene = videoPaceScene({ pace: { prepareMs: 1000, prepareMediaMs: 0 }, watch });

  const running = withCapturedLogs(() => scene.turns.runTurn(scene.params));
  await settleUntil(() => scene.describer.videoCalls.length > 0 && scene.timers.live().length > 0);
  await settleUntil();
  assert.deepEqual(scene.timers.timers.map((timer) => timer.ms), [1000], 'no extension');
  scene.timers.fire(scene.timers.live()[0]);
  const { result, logs } = await running;

  assert.equal(result.outcome, 'spoke');
  assert.ok(!userText(scene.llm).includes(WATCHED_TEXT), 'the late watch is absent');
  assert.deepEqual(logs.find((l) => l.msg === 'turn: timings').late, ['videos']);
  watch.resolve();
});

test('runTurn: a video whose watch misses the deadline renders not watched, still loading, never as its bare still frame', async () => {
  const watch = deferred();
  const scene = videoPaceScene({ pace: { prepareMs: 1000, prepareMediaMs: 5000 }, watch });
  scene.describer.describeMany = async (guildId, items) => ({
    descriptions: new Map(items.filter((item) => item.itemId === 'va').map((item) => [item.itemId, 'μια γέφυρα'])),
    newCount: 1,
  });

  const running = withCapturedLogs(() => scene.turns.runTurn(scene.params));
  await settleUntil(() => scene.describer.videoCalls.length > 0 && scene.timers.live().length > 0);
  await settleUntil();
  assert.deepEqual(scene.timers.live().map((timer) => timer.ms), [5000]);
  scene.timers.fire(scene.timers.live()[0]);
  const { result, logs } = await running;

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(logs.find((l) => l.msg === 'turn: timings').late, ['videos']);
  const text = userText(scene.llm);
  const pending = labels.transcript.videoNotWatchedFrame
    .replace('{name}', 'clip.mov')
    .replace('{duration}', '0:20')
    .replace('{reason}', labels.transcript.videoReason.pending)
    .replace('{text}', 'μια γέφυρα');
  assert.ok(text.includes(pending), 'the late video is named not watched, still loading, with its frame');
  const bare = labels.transcript.videoDescribed.replace('{name}', 'clip.mov').replace('{duration}', '0:20').replace('{text}', 'μια γέφυρα');
  assert.ok(!text.includes(bare), 'never the bare still-frame form');
  assert.ok(!text.includes(WATCHED_TEXT));
  watch.resolve();
});

test('runTurn: a late video stage keeps the states the cache holds; only the video still loading is pending', async () => {
  const watch = deferred();
  const hot = fakeHot({ mediaDescriptions: true, videoDescriptions: true, vision: false }, {}, VIDEO_TURN_CONFIG);
  hot.config.pace = { ...TEST_PACE, prepareMs: 1000, prepareMediaMs: 5000 };
  // An older line with a video watched on an earlier turn (served from the cache), and the call with a new one.
  const older = videoAttachmentRaw('m1', NOW - 9000, 'vo', 'old.mp4');
  const trigger = videoAttachmentRaw('m2', NOW - 1000, 'va', 'clip.mov');
  trigger.cleanContent = 'το βλέπεις;';
  const channel = fakeTurnChannel({ historyMessages: [older, trigger] });
  const llm = fakeLlm('<msg>ok</msg>');
  const describer = fakeVideoDescriber({});
  describer.describeVideos = async (guildId, items, options) => {
    describer.videoCalls.push({ guildId, items, options });
    await watch.promise;
    return { videos: new Map([['va', { state: 'watched', text: WATCHED_TEXT }]]), newCount: 1 };
  };
  describer.cachedVideos = async (guildId, items) =>
    new Map(items.filter((item) => item.itemId === 'vo').map((item) => [item.itemId, { state: 'watched', text: 'ένα παλιό βίντεο' }]));
  const timers = fakeSchedule();
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), describer, now: () => NOW, schedule: timers.schedule });

  const running = withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(trigger), triggerKind: 'mention' }));
  await settleUntil(() => describer.videoCalls.length > 0 && timers.live().length > 0);
  await settleUntil();
  timers.fire(timers.live()[0]);
  const { logs } = await running;

  assert.deepEqual(logs.find((l) => l.msg === 'turn: timings').late, ['videos']);
  const text = userText(llm);
  const pending = labels.transcript.videoNotWatched
    .replace('{name}', 'clip.mov')
    .replace('{duration}', '0:20')
    .replace('{reason}', labels.transcript.videoReason.pending);
  assert.ok(text.includes(pending), 'the video still loading is pending');
  const watched = labels.transcript.videoWatched.replace('{name}', 'old.mp4').replace('{duration}', '0:20').replace('{text}', 'ένα παλιό βίντεο');
  assert.ok(text.includes(watched), 'the older video keeps its cached watched state');
  watch.resolve();
});

test('runTurn: a video only on an older line keeps pace.prepareMs; one on the line the trigger replies to extends it', async () => {
  const watch = deferred();
  const scene = videoPaceScene({ pace: { prepareMs: 1000, prepareMediaMs: 5000 }, where: 'history', watch });

  const running = withCapturedLogs(() => scene.turns.runTurn(scene.params));
  await settleUntil(() => scene.describer.videoCalls.length > 0 && scene.timers.live().length > 0);
  await settleUntil();
  assert.deepEqual(scene.timers.timers.map((timer) => timer.ms), [1000], 'an older video does not extend the deadline');
  scene.timers.fire(scene.timers.live()[0]);
  const { logs } = await running;
  assert.deepEqual(logs.find((l) => l.msg === 'turn: timings').late, ['videos']);
  watch.resolve();

  const replied = videoPaceScene({ pace: { prepareMs: 1000, prepareMediaMs: 5000 }, where: 'replied' });
  const { logs: repliedLogs } = await withCapturedLogs(() => replied.turns.runTurn(replied.params));
  assert.deepEqual(replied.timers.timers.map((timer) => timer.ms), [1000, 5000], 'the replied-to video extends it');
  assert.deepEqual(repliedLogs.find((l) => l.msg === 'turn: timings').late, []);
});

test('runTurn: a search and a video on the trigger both extend the deadline -- the larger limit wins', async () => {
  for (const [searchMs, expected] of [
    [3000, [1000, 5000]],
    [8000, [1000, 5000, 7500]],
  ]) {
    let t = NOW;
    const search = deferred();
    const lookup = fakeLookup();
    const searchOnce = lookup.search;
    let searched = 0;
    lookup.search = async (guildId, query) => {
      searched += 1;
      await search.promise;
      return searchOnce(guildId, query);
    };
    const base = lookupLlm('champions final winner 2026');
    const llm = {
      ...base,
      complete: async (messages, options) => {
        if (messages[0].content.startsWith('Decide whether')) t = NOW + 500;
        return base.complete(messages, options);
      },
    };
    const hot = lookupHot({ mediaDescriptions: true, videoDescriptions: true });
    const scene = videoPaceScene({ pace: { prepareMs: 1000, prepareSearchMs: searchMs, prepareMediaMs: 5000 }, hot, llm, lookup, clock: () => t, content: 'ποιος κέρδισε τον τελικό;' });

    const running = withCapturedLogs(() => scene.turns.runTurn(scene.params));
    await settleUntil(() => searched > 0);
    assert.deepEqual(scene.timers.timers.map((timer) => timer.ms), expected, `prepareSearchMs ${searchMs}`);
    assert.equal(scene.timers.live().length, 1, 'one deadline at a time');
    assert.equal(scene.timers.live()[0].ms, expected.at(-1));
    search.resolve();
    const { logs } = await running;
    assert.deepEqual(logs.find((l) => l.msg === 'turn: timings').late, []);
  }
});

test('runTurn: turn: timings carries every stage, null for one that did not run', async () => {
  let t = NOW;
  const caption = deferred();
  const base = fakeLlm('<msg>ok</msg>');
  const llm = {
    ...base,
    complete: async (messages, options) => {
      t += 2000;
      return base.complete(messages, options);
    },
  };
  const scene = paceScene({ caption, clock: () => t, llm });
  const fetchMessages = scene.channel.messages.fetch;
  scene.channel.messages.fetch = async (arg) => {
    if (arg && typeof arg === 'object' && 'limit' in arg) t += 100;
    return fetchMessages(arg);
  };

  const running = withCapturedLogs(() => scene.turns.runTurn(scene.params));
  await settleUntil(() => scene.describer.calls > 0);
  await settleUntil();
  t = NOW + 1100;
  caption.resolve();
  const { logs } = await running;

  const timings = logs.find((l) => l.msg === 'turn: timings');
  assert.deepEqual(Object.keys(timings.stages), ['history', 'previews', 'captions', 'videos', 'rewatch', 'links', 'lookup', 'neighbors', 'pulled', 'participation']);
  assert.equal(timings.stages.history, 100);
  assert.equal(timings.stages.captions, 1000);
  for (const name of ['previews', 'links', 'neighbors', 'pulled']) assert.equal(typeof timings.stages[name], 'number', name);
  for (const name of ['videos', 'rewatch', 'lookup', 'participation']) assert.equal(timings.stages[name], null, name);
  assert.deepEqual(
    [timings.channel, timings.mode, timings.triggerKind, timings.prepareMs, timings.replyMs, timings.totalMs, timings.late],
    ['c1', 'reply', 'mention', 1100, 2000, 3100, []],
  );
  assert.ok(logs.some((l) => l.msg === 'turn: model answered' && 'secondsToAnswer' in l));
});

/** An llm fake that notes how many typing indicators the channel had when the reply request came. */
function typingAtTalk(channel) {
  const base = fakeLlm('<msg>ok</msg>');
  const seen = [];
  return {
    ...base,
    seen,
    complete: async (messages, options) => {
      seen.push(channel.typingCalls.length);
      return base.complete(messages, options);
    },
  };
}

test('runTurn: a direct call shows the typing indicator while it prepares and refreshes it', async () => {
  const caption = deferred();
  const hot = paceHot({}, { typingWhilePreparing: true });
  const scene = paceScene({ caption, hot });
  const llm = typingAtTalk(scene.channel);
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), describer: scene.describer, lookup: scene.lookup, now: () => NOW, schedule: scene.timers.schedule });

  const running = withCapturedLogs(() => turns.runTurn(scene.params));
  await settleUntil(() => scene.describer.calls > 0 && scene.channel.typingCalls.length > 0);
  assert.equal(scene.channel.typingCalls.length, 1, 'sent once as the turn starts preparing');
  const refresh = scene.timers.live().find((timer) => timer.ms !== TEST_PACE.prepareMs);
  assert.ok(refresh, 'a refresh is scheduled');
  scene.timers.fire(refresh);
  await settleUntil(() => scene.channel.typingCalls.length > 1);
  assert.equal(scene.channel.typingCalls.length, 2, 'refreshed while preparing');
  caption.resolve();
  const { result } = await running;

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(llm.seen, [2]);
  assert.deepEqual(scene.timers.live(), [], 'nothing is refreshed once the preparation is over');
});

test('runTurn: no typing indicator while preparing an unprompted turn, nor in a dry run', async () => {
  const hot = paceHot({}, { typingWhilePreparing: true });
  const spontaneous = paceScene({ hot });
  const llm = typingAtTalk(spontaneous.channel);
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), describer: spontaneous.describer, lookup: spontaneous.lookup, now: () => NOW, schedule: spontaneous.timers.schedule });
  await withCapturedLogs(() => turns.runTurn({ channel: spontaneous.channel, mode: 'interject' }));
  assert.deepEqual(llm.seen, [0]);
  assert.ok(spontaneous.timers.timers.every((timer) => timer.ms === TEST_PACE.prepareMs), 'no refresh is scheduled');

  const dry = paceScene({ hot: paceHot({ dryRun: true }, { typingWhilePreparing: true }) });
  const { result } = await withCapturedLogs(() => dry.turns.runTurn(dry.params));
  assert.equal(result.dryRun, true);
  assert.equal(dry.channel.typingCalls.length, 0);
});

// The drop bar (pace.dropAfterMs): the answer must be in hand by then, or the turn is dropped unposted.

const BAR_MS = 5000;

/** An llm fake whose talk request runs `talk(messages, options)`; every call's options are kept. */
function barLlm(talk) {
  const optionCalls = [];
  return {
    optionCalls,
    complete: async (messages, options) => {
      optionCalls.push(options);
      return talk(messages, options, optionCalls.length);
    },
  };
}

test('runTurn: an answer in hand just before pace.dropAfterMs is posted, the reply request bounded by the time left', async () => {
  let t = NOW;
  const llm = barLlm(async () => {
    t = NOW + BAR_MS - 1;
    return { text: '<msg>ok</msg>', usage: {}, estimated: 10 };
  });
  const hot = paceHot({}, { dropAfterMs: BAR_MS });
  hot.config.llm.timeoutMs = 300_000;
  const scene = paceScene({ hot, llm, clock: () => t });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  assert.equal(scene.channel.sent.length, 1);
  assert.equal(logs.some((l) => l.msg === 'turn: dropped'), false);
  const [options] = llm.optionCalls;
  assert.equal(options.role, 'voice');
  assert.equal(options.purpose, 'reply');
  assert.equal(options.timeoutMs, BAR_MS, 'the smaller of llm.timeoutMs and the time left');
  assert.equal(options.signal.aborted, false);
  assert.deepEqual(scene.timers.live(), [], 'the bar is cleared once the answer is in hand');
});

test('runTurn: a talk request still out at pace.dropAfterMs is aborted; nothing is posted, the turn ends in error and the queue drains', async () => {
  const answer = deferred();
  const llm = barLlm(() => answer.promise);
  const hot = paceHot({}, { dropAfterMs: BAR_MS, typingWhilePreparing: true });
  const scene = paceScene({ hot, llm, clock: () => NOW });
  let idle = 0;
  scene.turns.setOnIdle(() => {
    idle += 1;
  });

  const running = withCapturedLogs(() => scene.turns.runTurn(scene.params));
  await settleUntil(() => llm.optionCalls.length > 0);
  const bar = scene.timers.live().find((timer) => timer.ms === BAR_MS);
  assert.ok(bar, 'the bar is set from the turn start');
  assert.ok(scene.timers.live().some((timer) => timer.ms !== BAR_MS), 'the typing indicator is refreshed through the reply request');
  scene.timers.fire(bar);
  const { result, logs } = await running;
  await settleUntil(() => idle > 0);

  assert.equal(result.outcome, 'error');
  assert.equal(llm.optionCalls[0].signal.aborted, true, 'the reply request is aborted');
  assert.equal(scene.channel.sent.length, 0);
  const dropped = logs.find((l) => l.msg === 'turn: dropped');
  assert.deepEqual(
    [dropped.channel, dropped.mode, dropped.triggerKind, dropped.reason, typeof dropped.seconds],
    ['c1', 'reply', 'mention', 'too-slow', 'number'],
  );
  assert.deepEqual(scene.timers.live(), [], 'the typing indicator is no longer refreshed');
  assert.equal(idle, 1, 'the pending queue drains as after any finished turn');
  assert.equal(scene.turns.isAnyBusy(), false);

  answer.resolve({ text: '<msg>late</msg>', usage: {}, estimated: 10 });
  await settleUntil();
  assert.equal(scene.channel.sent.length, 0, 'a late answer is never posted');
});

test('runTurn: no text-only resend is made once no time is left before pace.dropAfterMs', async () => {
  let t = NOW;
  const raw = rawMessage({
    id: 'm1',
    attachments: new Map([
      ['v1', { id: 'v1', contentType: 'video/mp4', name: 'clip.mp4', url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4', duration: 34 }],
    ]),
  });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const llm = barLlm(async () => {
    t = NOW + BAR_MS;
    const err = new Error('bad request');
    err.statusCode = 400;
    throw err;
  });
  const hot = fakeHot({});
  hot.config.pace = { ...TEST_PACE, dropAfterMs: BAR_MS };
  const timers = fakeSchedule();
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), imageFetcher: fakeImageFetcher(), now: () => t, schedule: timers.schedule });

  const { result, logs } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: videoTrigger(raw), triggerKind: 'mention' }));

  assert.equal(llm.optionCalls.length, 1, 'the resend is never asked');
  assert.equal(result.outcome, 'error');
  assert.equal(channel.sent.length, 0);
  assert.ok(logs.some((l) => l.msg === 'turn: dropped' && l.reason === 'too-slow'));
});

// The reply hedge (pace.replyHedgeMs): only the reply request of a turn with a bar carries one.

test('runTurn: a direct call with a bar passes pace.replyHedgeMs to the reply request as its hedge, cut at the same timeout', async () => {
  const llm = barLlm(async () => ({ text: '<msg>ok</msg>', usage: {}, estimated: 10 }));
  const hot = paceHot({}, { dropAfterMs: BAR_MS, replyHedgeMs: 500 });
  hot.config.llm.timeoutMs = 300_000;
  const scene = paceScene({ hot, llm, clock: () => NOW });

  const { result } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  const [options] = llm.optionCalls;
  assert.equal(options.timeoutMs, BAR_MS);
  assert.deepEqual(options.hedge, { afterMs: 500, timeoutMs: BAR_MS }, 'attempt 2 at 500 ms, both ended at the bar');
  assert.equal(options.helper, undefined, 'still no helper request');
});

test('runTurn: pace.replyHedgeMs 0, or not below the time left to the bar, sends the reply request without a hedge', async () => {
  for (const replyHedgeMs of [0, BAR_MS]) {
    const llm = barLlm(async () => ({ text: '<msg>ok</msg>', usage: {}, estimated: 10 }));
    const hot = paceHot({}, { dropAfterMs: BAR_MS, replyHedgeMs });
    hot.config.llm.timeoutMs = 300_000;
    const scene = paceScene({ hot, llm, clock: () => NOW });

    const { result } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

    assert.equal(result.outcome, 'spoke', String(replyHedgeMs));
    const [options] = llm.optionCalls;
    assert.equal('hedge' in options, false, String(replyHedgeMs));
    assert.equal(options.timeoutMs, BAR_MS, String(replyHedgeMs));
  }
});

test('runTurn: an initiate turn with pace.unpromptedWaits on has no bar, so its reply request is never hedged', async () => {
  const llm = barLlm(async () => ({ text: '<msg>ok</msg>', usage: {}, estimated: 10 }));
  const scene = paceScene({ hot: paceHot({}, { dropAfterMs: BAR_MS, replyHedgeMs: 500, unpromptedWaits: true }), llm, clock: () => NOW });

  const { result } = await withCapturedLogs(() => scene.turns.runTurn({ channel: scene.channel, mode: 'initiate' }));

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(llm.optionCalls, [{ role: 'voice', purpose: 'reply' }]);
});

test('runTurn: pace.dropAfterMs 0 sets no bar -- a slow answer is still posted, the request as before', async () => {
  let t = NOW;
  const llm = barLlm(async () => {
    t = NOW + 10 * 60_000;
    return { text: '<msg>ok</msg>', usage: {}, estimated: 10 };
  });
  const scene = paceScene({ hot: paceHot({}, { dropAfterMs: 0 }), llm, clock: () => t });

  const { result, logs } = await withCapturedLogs(() => scene.turns.runTurn(scene.params));

  assert.equal(result.outcome, 'spoke');
  assert.equal(scene.channel.sent.length, 1);
  assert.deepEqual(llm.optionCalls, [{ role: 'voice', purpose: 'reply' }]);
  assert.equal(logs.some((l) => l.msg === 'turn: dropped'), false);
  assert.ok(scene.timers.timers.every((timer) => timer.ms === TEST_PACE.prepareMs), 'only the preparation deadline');
});

test('runTurn: a private chat message shows the typing indicator while its turn prepares', async () => {
  const hot = privateHot({ typingSimulation: true });
  hot.config.pace = { ...TEST_PACE, typingWhilePreparing: true };
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', content: 'hey' });
  const channel = fakeTurnChannel({ id: 'dm1', dm: true, historyMessages: [raw] });
  const llm = typingAtTalk(channel);
  const timers = fakeSchedule();
  const turns = createTurnRunner({ hot, store: privateStore(), llm, calibrator: identityCalibrator(), client: guildClient(), images: fakeImages(), now: () => NOW, schedule: timers.schedule });

  const { result } = await withCapturedLogs(() =>
    turns.runTurn({ channel, guildId: 'g1', mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'private' }),
  );

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(llm.seen, [1], 'typing before the reply request');
});

// ---------------------------------------------------------------------------
// A message that holds several requests: the splitter (prompts/split.md) and the chain of parts.

const SPLIT_SYSTEM = 'Split this call to {{name}} into at most {{maxTasks}} parts.';
const SPLIT_TEXT = 'ποιος είναι ο Νίκος; κοίτα το κανάλι της Ελένης, και πες μου αν το μιμίδιο είναι αστείο.';
const SPLIT_PARTS = ['ποιος είναι ο Νίκος', 'κοίτα το κανάλι της Ελένης', 'το μιμίδιο είναι αστείο;'];
const PARTS_ANSWER = SPLIT_PARTS.map((part) => `- ${part}`).join('\n');

/**
 * An llm fake routing by request purpose: the splitter (`split`), the search classifier
 * (`lookup`), everything else is the reply request. Each answer is a string, an Error to throw,
 * or a function of the call's index (0-based, per kind) giving one of those or a promise.
 */
function splitLlm({ split = PARTS_ANSWER, lookup = 'none', talk = '<msg reply="#2">ok</msg>' } = {}) {
  const calls = { split: [], lookup: [], talk: [] };
  const answer = async (spec, index) => {
    const value = typeof spec === 'function' ? await spec(index) : spec;
    if (value instanceof Error) throw value;
    return { text: value, usage: {}, estimated: 10 };
  };
  return {
    calls,
    complete: async (messages, options) => {
      const kind = options?.purpose === 'split' ? 'split' : options?.purpose === 'lookup' ? 'lookup' : 'talk';
      calls[kind].push({ messages, options });
      const spec = kind === 'split' ? split : kind === 'lookup' ? lookup : talk;
      return answer(spec, calls[kind].length - 1);
    },
  };
}

/** The settings the split tests rely on, set here: the pre-filter, the cap, and the pace. */
function splitHot({ features = {}, split = {}, labels: ownLabels } = {}) {
  const hot = lookupHot(
    { typingSimulation: false, ...features },
    {},
    {
      split: { minChars: 20, minPartChars: 0, maxTasks: 4, contextMessages: 2, maxOutputTokens: 50, ...split },
      pace: { prepareMs: 5000, prepareSearchMs: 5000, dropAfterMs: 60000, typingWhilePreparing: false },
    },
  );
  hot.prompts.split = SPLIT_SYSTEM;
  if (ownLabels) hot.prompts.labels = ownLabels;
  return hot;
}

/** A schedule whose timers fire only when `fire(ms)` is called (the turn's clock stands still at NOW). */
function manualSchedule() {
  const timers = [];
  const schedule = (fn, ms) => {
    const timer = { fn, ms, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  schedule.fire = (ms) => {
    for (const timer of timers.filter((t) => t.ms === ms && !t.cancelled)) {
      timer.cancelled = true;
      timer.fn();
    }
  };
  return schedule;
}

/** One reply turn on a call with `content`, under the split settings. */
async function runSplitTurn({ hot = splitHot(), llm = splitLlm(), content = SPLIT_TEXT, triggerKind = 'mention', extra = {}, turnExtra = {}, schedule = manualSchedule() } = {}) {
  const raw = rawMessage({ id: 'm2', ts: NOW - 1000, content });
  const channel = fakeTurnChannel({ historyMessages: [rawMessage({ id: 'm1', ts: NOW - 5000, authorId: 'u2', authorName: 'Léa', content: 'καλημέρα' }), raw] });
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), lookup: fakeLookup(), now: () => NOW, schedule, ...extra });
  const trigger = normalizedTrigger(raw);
  const { result, logs } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger, triggerKind, ...turnExtra }));
  return { result, logs, llm, channel, turns, trigger };
}

/** The `<candidate>` text a classifier request carried. */
function candidateOf(call) {
  return /<candidate>\n[^:]*: ([\s\S]*?)\n<\/candidate>/.exec(textOf(call.messages[1].content))?.[1] ?? null;
}

/** The `<task>` block of a talk request. */
function taskOf(call) {
  return /<task>\n([\s\S]*?)\n<\/task>/.exec(userTextOf(call.messages))?.[1] ?? '';
}

/** labels.task.part as the request renders it for part `index` of SPLIT_PARTS (no queued call). */
function partLabel(index, parts = SPLIT_PARTS) {
  const others = parts.map((text, i) => (i + 1 === index ? null : `${i + 1}. ${text}`)).filter(Boolean).join('; ');
  return fill(labels.task.part, { index, total: parts.length, part: parts[index - 1], others });
}

test('runTurn: a short or unstructured call never asks the splitter', async () => {
  for (const content of ['γεια σου', 'a'.repeat(60)]) {
    const { llm, result } = await runSplitTurn({ content });
    assert.equal(llm.calls.split.length, 0, content);
    assert.equal(llm.calls.talk.length, 1);
    assert.equal(result.outcome, 'spoke');
  }
});

test('runTurn: a `one` verdict leaves the turn exactly as without the splitter', async () => {
  const off = splitHot();
  delete off.prompts.split;
  const before = await runSplitTurn({ hot: off });
  const after = await runSplitTurn({ llm: splitLlm({ split: 'one' }) });

  assert.equal(before.llm.calls.split.length, 0);
  assert.equal(after.llm.calls.split.length, 1);
  assert.deepEqual(after.llm.calls.talk.map((call) => call.messages), before.llm.calls.talk.map((call) => call.messages), 'the same talk request');
  assert.deepEqual(after.llm.calls.lookup.map((call) => call.messages), before.llm.calls.lookup.map((call) => call.messages), 'the search classifier asked once, the same way');
  assert.deepEqual(after.channel.sent, before.channel.sent);
  assert.deepEqual(after.result, before.result);
  const verdict = after.logs.find((line) => line.msg === 'split: verdict');
  assert.deepEqual([verdict.channel, verdict.parts, typeof verdict.ms], ['c1', 1, 'number']);
  assert.equal(after.logs.some((line) => line.msg === 'turn: part'), false);
});

test('runTurn: the splitter request fills split.md and carries the transcript and the candidate', async () => {
  const { llm } = await runSplitTurn({ llm: splitLlm({ split: 'one' }) });
  const [call] = llm.calls.split;
  assert.equal(call.messages[0].content, fillPromptTemplate(SPLIT_SYSTEM, { name: 'Bot', maxTasks: 4 }));
  assert.ok(textOf(call.messages[1].content).startsWith('<transcript>\n'));
  assert.equal(candidateOf(call), SPLIT_TEXT);
  assert.deepEqual([call.options.role, call.options.purpose, call.options.maxOutputTokens, call.options.helper], ['classifier.text', 'split', 50, true]);
});

test('runTurn: a failed, empty or unparsable splitter answer is one request', async () => {
  for (const split of [Object.assign(new Error('boom'), { statusCode: 503 }), '   ', '- only one']) {
    const { llm, logs, result } = await runSplitTurn({ llm: splitLlm({ split }) });
    assert.equal(llm.calls.talk.length, 1);
    assert.equal(taskOf(llm.calls.talk[0]).includes('parts'), false);
    assert.equal(result.outcome, 'spoke');
    const failed = logs.find((line) => line.msg === 'split: failed');
    assert.ok(failed, String(split));
    assert.ok(['llm-error', 'empty', 'unparsed'].includes(failed.reason));
  }
});

test('runTurn: a splitter still thinking at the deadline is one request; its late verdict is only logged', async () => {
  let release;
  const late = new Promise((resolve) => {
    release = resolve;
  });
  const schedule = manualSchedule();
  const llm = splitLlm({ split: () => late });
  const raw = rawMessage({ id: 'm2', ts: NOW - 1000, content: SPLIT_TEXT });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  const turns = createTurnRunner({ hot: splitHot(), store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), lookup: fakeLookup(), now: () => NOW, schedule });
  const { logs } = await withCapturedLogs(async () => {
    const running = turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
    for (let i = 0; i < 20 && llm.calls.split.length === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(llm.calls.talk.length, 0, 'the turn waits for the splitter like any stage');
    schedule.fire(5000);
    const result = await running;
    assert.equal(result.outcome, 'spoke');
    release(PARTS_ANSWER);
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(llm.calls.talk.length, 1, 'one turn, for the whole message');
  const verdict = logs.find((line) => line.msg === 'split: verdict');
  assert.deepEqual([verdict.parts, verdict.late], [3, true]);
});

test('runTurn: parts in time become one turn per part, in order, each helper judging its part', async () => {
  const { llm, logs, result, channel } = await runSplitTurn();

  assert.equal(llm.calls.talk.length, 3);
  // The search classifier: every part asks it with its own text (the whole message's may have started first).
  const candidates = llm.calls.lookup.map(candidateOf);
  assert.deepEqual(candidates.filter((text) => text !== SPLIT_TEXT), SPLIT_PARTS);
  assert.ok(candidates.filter((text) => text === SPLIT_TEXT).length <= 1);
  // The persona's request names the part it answers now and the others.
  assert.deepEqual(llm.calls.talk.map((call) => taskOf(call).endsWith(partLabel(llm.calls.talk.indexOf(call) + 1))), [true, true, true]);
  // The first answer replies to the message, the later ones post plain.
  assert.deepEqual(channel.sent.map((payload) => payload.reply?.messageReference ?? null), ['m2', null, null]);
  assert.deepEqual(logs.filter((line) => line.msg === 'turn: part').map(({ channel: id, index, total, outcome }) => [id, index, total, outcome]), [
    ['c1', 1, 3, 'spoke'],
    ['c1', 2, 3, 'spoke'],
    ['c1', 3, 3, 'spoke'],
  ]);
  assert.deepEqual(result, { outcome: 'spoke', mode: 'reply', delivered: true });
  const lines = logs.filter((line) => line.msg.startsWith('split:') || line.msg === 'turn: part');
  assert.equal(JSON.stringify(lines).includes('Νίκος'), false, 'counts and codes only, never a part');
});

test('runTurn: the route hook judges each part\'s text', async () => {
  const seen = [];
  const routeChannels = async ({ trigger }) => {
    seen.push(trigger.content);
    return [];
  };
  await runSplitTurn({ extra: { routeChannels } });
  assert.deepEqual(seen.filter((text) => text !== SPLIT_TEXT), SPLIT_PARTS);
});

test('runTurn: the persona may stay silent on a part; a failed part does not stop the next', async () => {
  const talk = (index) => (index === 0 ? new Error('provider down') : index === 1 ? '<skip/>' : '<msg>τρία</msg>');
  const { logs, result, channel } = await runSplitTurn({ llm: splitLlm({ talk }) });
  assert.deepEqual(logs.filter((line) => line.msg === 'turn: part').map((line) => line.outcome), ['error', 'skip', 'spoke']);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].reply, undefined, 'a later part posts plain');
  assert.equal(result.outcome, 'spoke');
});

test('runTurn: a chain where no part spoke gives the first skip, else the first part\'s result', async () => {
  const silent = await runSplitTurn({ llm: splitLlm({ talk: '<skip/>' }) });
  assert.deepEqual(silent.result, { outcome: 'skip', mode: 'reply' });
  const failing = await runSplitTurn({ llm: splitLlm({ talk: new Error('down') }) });
  assert.equal(failing.result.outcome, 'error');
});

test('runTurn: split.maxTasks cuts the parts', async () => {
  const { llm } = await runSplitTurn({ hot: splitHot({ split: { maxTasks: 2 } }), llm: splitLlm({ split: `${PARTS_ANSWER}\n- και κάτι ακόμα` }) });
  assert.equal(llm.calls.talk.length, 2);
  assert.ok(taskOf(llm.calls.talk[0]).endsWith(partLabel(1, SPLIT_PARTS.slice(0, 2))));
});

test('runTurn: an overheard line, a drawFailed turn or an unprompted turn never asks the splitter', async () => {
  const overheard = await runSplitTurn({ triggerKind: 'overheard' });
  assert.equal(overheard.llm.calls.split.length, 0);
  const llm = splitLlm();
  const channel = fakeTurnChannel({ historyMessages: [rawMessage({ id: 'm2', ts: NOW - 1000, content: SPLIT_TEXT })] });
  const turns = createTurnRunner({ hot: splitHot(), store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), now: () => NOW, schedule: manualSchedule() });
  await turns.runTurn({ channel, mode: 'interject' });
  assert.equal(llm.calls.split.length, 0);
});

test('runTurn: an older labels file without labels.task.part never starts a chain; a missing split.md logs no-prompt', async () => {
  const { task, ...older } = labels;
  const old = await runSplitTurn({ hot: splitHot({ labels: older }) });
  assert.equal(old.llm.calls.split.length, 0);
  assert.equal(old.llm.calls.talk.length, 1);

  const hot = splitHot();
  delete hot.prompts.split;
  const { logs, llm } = await runSplitTurn({ hot });
  assert.equal(llm.calls.split.length, 0);
  assert.deepEqual(logs.filter((line) => line.msg === 'split: skipped').map(({ channel, reason }) => [channel, reason]), [['c1', 'no-prompt']]);
});

test('runTurn: features.splitTasks false asks no splitter', async () => {
  const { llm } = await runSplitTurn({ hot: splitHot({ features: { splitTasks: false } }) });
  assert.equal(llm.calls.split.length, 0);
});

test('runTurn: the chain holds the one attention to its end and notifies idle once', async () => {
  const other = fakeTurnChannel({ id: 'c9' });
  let idle = 0;
  const busyDuring = [];
  let turnsRef = null;
  const talk = async (index) => {
    busyDuring.push(turnsRef.isAnyBusy());
    if (index === 0) {
      const elsewhere = await turnsRef.runTurn({ channel: other, mode: 'interject' });
      busyDuring.push(elsewhere.outcome);
    }
    return '<msg>ok</msg>';
  };
  const llm = splitLlm({ talk });
  const raw = rawMessage({ id: 'm2', ts: NOW - 1000, content: SPLIT_TEXT });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  turnsRef = createTurnRunner({ hot: splitHot(), store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), lookup: fakeLookup(), now: () => NOW, schedule: manualSchedule() });
  turnsRef.setOnIdle(() => {
    idle += 1;
  });
  const waited = turnsRef.waitIdle();
  let waitedDone = false;
  waited.then(() => {
    waitedDone = true;
  });
  await turnsRef.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(busyDuring, [true, 'busy', true, true]);
  assert.equal(idle, 1, 'one notification, once the chain is over');
  assert.equal(waitedDone, true);
  assert.equal(turnsRef.isAnyBusy(), false);
});

test('runTurn: a pause or a warmup ends the chain before its next part', async () => {
  for (const reason of ['paused', 'warmup']) {
    const store = fakeStore();
    let warming = false;
    const talk = () => {
      if (reason === 'paused') store.state.data.paused = true;
      else warming = true;
      return '<msg>ok</msg>';
    };
    const llm = splitLlm({ talk });
    const raw = rawMessage({ id: 'm2', ts: NOW - 1000, content: SPLIT_TEXT });
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    const turns = createTurnRunner({ hot: splitHot(), store, llm, calibrator: identityCalibrator(), client: fakeClient(), lookup: fakeLookup(), now: () => NOW, schedule: manualSchedule(), isWarmingUp: () => warming });
    const { logs, result } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
    assert.equal(llm.calls.talk.length, 1, reason);
    assert.deepEqual(logs.filter((line) => line.msg === 'turn: chain stopped').map(({ reason: why, index, total }) => [why, index, total]), [[reason, 2, 3]]);
    assert.equal(result.outcome, 'spoke');
    assert.equal(turns.isAnyBusy(), false);
  }
});

test('runTurn: a dry run mirrors each part with its number in the header', async () => {
  const mirrored = [];
  const hot = splitHot({ features: { dryRun: true } });
  hot.config.bot.dryRunChannelId = 'mirror1';
  const { result } = await runSplitTurn({ hot, llm: splitLlm({ talk: '<msg>ok</msg>' }), extra: { client: mirrorClient(mirrored) } });
  assert.deepEqual(result, { outcome: 'spoke', mode: 'reply', dryRun: true });
  assert.deepEqual(
    mirrored.map((payload) => /· part (\d)\/(\d)/.exec(payload.content)?.slice(1).join('/')),
    ['1/3', '2/3', '3/3'],
  );
});

test('runTurn: the parts not started yet are the author\'s waiting items; a message folded into one reaches its request', async () => {
  let turnsRef = null;
  const seen = [];
  const talk = (index) => {
    if (index === 0) {
      seen.push(turnsRef.waitingParts('c1', 'u1'), turnsRef.waitingParts('c1', 'u2'));
      seen.push(turnsRef.addToPart('c1', 'u1', 2, { id: 'f1', text: 'και το δεύτερο;', ts: NOW }));
      seen.push(turnsRef.addToPart('c1', 'u1', 1, { id: 'f2', text: 'όχι', ts: NOW }));
    }
    return '<msg>ok</msg>';
  };
  const llm = splitLlm({ talk });
  const raw = rawMessage({ id: 'm2', ts: NOW - 1000, content: SPLIT_TEXT });
  const channel = fakeTurnChannel({ historyMessages: [raw] });
  turnsRef = createTurnRunner({ hot: splitHot(), store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), lookup: fakeLookup(), now: () => NOW, schedule: manualSchedule() });
  await turnsRef.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.deepEqual(seen, [[{ index: 2, text: SPLIT_PARTS[1] }, { index: 3, text: SPLIT_PARTS[2] }], [], true, false]);
  assert.ok(taskOf(llm.calls.talk[1]).endsWith(fill(labels.task.added, { added: 'και το δεύτερο;' })));
  assert.equal(taskOf(llm.calls.talk[2]).includes('και το δεύτερο;'), false);
  assert.deepEqual(turnsRef.waitingParts('c1', 'u1'), [], 'nothing waits once the chain is over');
});

test('runTurn: a part\'s others name the author\'s queued calls after the parts', async () => {
  const queued = () => [{ id: 'm7', text: 'και ένα ακόμα' }];
  const { llm } = await runSplitTurn({ turnExtra: { queued } });
  const others = '2. κοίτα το κανάλι της Ελένης; 3. το μιμίδιο είναι αστείο;; 4. και ένα ακόμα';
  assert.ok(taskOf(llm.calls.talk[0]).endsWith(fill(labels.task.part, { index: 1, total: 3, part: SPLIT_PARTS[0], others })));
});

test('runTurn: queued calls named in the request are not counted as seen; without labels.task.queued they are', async () => {
  const history = [rawMessage({ id: 'm1', ts: NOW - 3000, content: 'πρώτο' }), rawMessage({ id: 'm3', ts: NOW - 2000, content: 'δεύτερο' })];
  const run = async (hot) => {
    const llm = splitLlm({ talk: '<msg>ok</msg>' });
    const channel = fakeTurnChannel({ historyMessages: history });
    const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), now: () => NOW, schedule: manualSchedule() });
    const queued = () => [{ id: 'm3', text: 'δεύτερο' }];
    const added = [{ id: 'm4', text: 'λοιπόν;', ts: NOW }];
    await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(history[0]), triggerKind: 'mention', queued, added });
    return { turns, task: taskOf(llm.calls.talk[0]) };
  };
  const named = await run(splitHot());
  assert.ok(named.task.endsWith([fill(labels.task.queued, { others: '1. δεύτερο' }), fill(labels.task.added, { added: 'λοιπόν;' })].join('\n\n')));
  assert.equal(named.turns.spokeAfterSeeing('c1', 'm3'), false, 'left to its own turn');
  assert.equal(named.turns.spokeAfterSeeing('c1', 'm1'), true);

  const { queued: _queued, ...noQueued } = labels.task;
  const older = await run(splitHot({ labels: { ...labels, task: noQueued } }));
  assert.equal(older.task.includes('δεύτερο'), false);
  assert.equal(older.turns.spokeAfterSeeing('c1', 'm3'), true, 'the old rule: seen is answered');
});

test('runTurn: another member\'s waiting call is named under labels.task.queuedOthers and not counted as seen; without the label it is', async () => {
  const history = [
    rawMessage({ id: 'm1', ts: NOW - 3000, content: 'πρώτο' }),
    rawMessage({ id: 'm2', ts: NOW - 2500, authorId: 'u2', authorName: 'Léa', content: 'άλλο' }),
    rawMessage({ id: 'm3', ts: NOW - 2000, content: 'δεύτερο' }),
  ];
  const run = async (hot) => {
    const llm = splitLlm({ talk: '<msg>ok</msg>' });
    const channel = fakeTurnChannel({ historyMessages: history });
    const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), now: () => NOW, schedule: manualSchedule() });
    const queued = () => [
      { id: 'm2', text: 'άλλο', author: 'Léa' },
      { id: 'm3', text: 'δεύτερο' },
    ];
    await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(history[0]), triggerKind: 'mention', queued });
    return { turns, task: taskOf(llm.calls.talk[0]) };
  };
  const named = await run(splitHot());
  assert.ok(named.task.endsWith([fill(labels.task.queued, { others: '1. δεύτερο' }), fill(labels.task.queuedOthers, { others: '1. Léa: άλλο' })].join('\n\n')));
  assert.equal(named.turns.spokeAfterSeeing('c1', 'm2'), false, 'left to its own turn');
  assert.equal(named.turns.spokeAfterSeeing('c1', 'm3'), false);

  const { queuedOthers: _others, ...older } = labels.task;
  const old = await run(splitHot({ labels: { ...labels, task: older } }));
  assert.equal(old.task.includes('άλλο'), false);
  assert.equal(old.turns.spokeAfterSeeing('c1', 'm2'), true, 'the old rule for another member\'s call');
  assert.equal(old.turns.spokeAfterSeeing('c1', 'm3'), false, 'the author\'s own call is still named under task.queued');
});

// ---------------------------------------------------------------------------
// The GIF picker (src/behavior/gif-pick.js): a short reply is shown with the
// WHOLE captioned library to one classifier request; a handle it names is
// posted instead of the text.

const GIF_PICK_PROMPT = 'Pick a GIF for what {{name}} wrote.';
const PICK_LIBRARY_SIZE = 50;
const PICK_SETTINGS = { maxChars: 20, contextMessages: 2, maxOutputTokens: 17 };

/**
 * A library of PICK_LIBRARY_SIZE link GIFs, every one captioned: g1 the most used, g50 used
 * once long ago (it never makes a top slice), so a pick of g50 proves the whole library is shown.
 */
function pickLibrary() {
  const entries = {};
  const mediaCache = {};
  for (let i = 1; i <= PICK_LIBRARY_SIZE; i += 1) {
    entries[`k${i}`] = { id: `g${i}`, kind: 'link', url: `https://tenor.com/view/gif-${i}`, itemId: `item-${i}`, messageId: `m-${i}`, channelId: 'c1', count: PICK_LIBRARY_SIZE + 1 - i, last: NOW - i * 3_600_000 };
    mediaCache[`item-${i}`] = { text: `λεζάντα ${i}` };
  }
  return { gifs: { nextId: PICK_LIBRARY_SIZE + 1, entries }, mediaCache };
}

/** fakeStore with pickLibrary (or `library`), the real findGif over it and the own-post stamps recorded. */
function pickStore({ library = pickLibrary(), data = {} } = {}) {
  const store = fakeStore({ mediaCache: library.mediaCache });
  store.state = { data, markDirty() {} };
  store.getGifs = () => library.gifs;
  store.findGif = (guildId, handle) => findGif(library.gifs, handle);
  store.ownGifs = [];
  store.recordOwnGif = (guildId, key, ts) => store.ownGifs.push({ guildId, key, ts });
  return store;
}

/** A fake LLM answering the turn with `reply` and the picker with `pick` (a function may wait or throw). */
function pickLlm({ reply, pick = 'none' }) {
  const calls = [];
  return {
    calls,
    complete: async (messages, options) => {
      calls.push({ messages, options });
      const answer = options?.purpose === 'gif-pick' ? pick : reply;
      return { text: typeof answer === 'function' ? await answer() : answer, usage: {}, estimated: 10 };
    },
  };
}

/** The two chat lines of a picker turn: an older one, then the trigger. */
function pickHistory() {
  return [rawMessage({ id: 'm0', ts: NOW - 5000, content: 'καλημέρα' }), rawMessage({ id: 'm1', ts: NOW - 1000, content: 'θα έρθεις απόψε;' })];
}

/** A hot config for the picker: its prompt and its own gifs values. */
function pickHot({ features = {}, prompts = {}, pickSettings = PICK_SETTINGS, maxPerDay = 40, typing = null } = {}) {
  const hot = fakeHot(
    { typingSimulation: typing !== null, ...features },
    {},
    {
      gifs: { maxPerDay, reactionChars: 40, actionChars: 70, ownMarkHours: 24, halfLifeDays: 30, pick: pickSettings },
      classifier: { text: 'cheap/classifier' },
      ...(typing ? { typing: { reactionDelayMs: [0, 0], betweenMessagesMs: [0, 0], ...typing } } : {}),
    },
  );
  Object.assign(hot.prompts, { 'gif-pick': GIF_PICK_PROMPT }, prompts);
  for (const [name, text] of Object.entries(prompts)) if (text === null) delete hot.prompts[name];
  return hot;
}

async function runPickTurn({ reply = '<msg reply="#2">ναι, φυσικά, έλα</msg>', pick = 'none', store = pickStore(), typing = null, raws = pickHistory(), triggerRaw = raws.at(-1), failGif = false, ...hotOptions } = {}) {
  const channel = fakeTurnChannel({ historyMessages: raws });
  const sendTimes = [];
  const send = channel.send;
  channel.send = async (payload) => {
    sendTimes.push(Date.now());
    if (failGif && String(payload.content).startsWith('https://tenor.com/')) throw new Error('Missing Permissions');
    return send(payload);
  };
  const llm = pickLlm({ reply, pick });
  const turns = createTurnRunner({ hot: pickHot({ ...hotOptions, typing }), store, llm, calibrator: identityCalibrator(), client: fakeClient(), now: () => NOW });
  const { result, logs } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(triggerRaw), triggerKind: 'mention' }));
  const picks = llm.calls.filter((call) => call.options?.purpose === 'gif-pick');
  const sent = () => channel.sent.map((payload) => payload.content);
  return { result, logs, channel, picks, store, sent, sendTimes };
}

test('runTurn: a short reply is shown with the whole captioned library; a picked handle posts that GIF and no text', async () => {
  const { result, logs, channel, picks, store, sent } = await runPickTurn({ pick: ' G50 ' });

  assert.equal(result.outcome, 'spoke');
  assert.equal(picks.length, 1, 'one pick request');
  const [system, user] = picks[0].messages;
  assert.deepEqual(system, { role: 'system', content: 'Pick a GIF for what Bot wrote.' });
  assert.equal(user.content.length, 2, 'two text parts');
  assert.equal(user.content[0].cacheSegment, 'stable', 'the library part is the cache segment');
  assert.equal(user.content[1].cacheSegment, undefined, 'the per-turn part is untagged');
  assert.ok(user.content[0].text.startsWith('<gifs>\n') && user.content[0].text.endsWith('</gifs>\n\n'), 'part 1 is the library block and its separator');
  assert.ok(user.content[1].text.startsWith('<context>\n'), 'part 2 starts at the context');
  const blocks = textOf(user.content).split('\n\n');
  assert.equal(blocks.length, 3);
  assert.match(blocks[1], /^<context>\n[\s\S]*καλημέρα[\s\S]*θα έρθεις απόψε;\n<\/context>$/, 'the last contextMessages lines as the transcript renders them');
  const marker = fill(labels.transcript.replyTo, { index: 2, author: 'Alice', quote: 'θα έρθεις απόψε;' });
  assert.equal(blocks[2], `<reply>\n${marker} ναι, φυσικά, έλα\n</reply>`, 'the reply names the line it answers');
  assert.ok(blocks[0].startsWith('<gifs>\n') && blocks[2].endsWith('</reply>'), 'the library leads the request, the reply ends it');
  const gifLines = blocks[0].replace(/^<gifs>\n/, '').replace(/\n<\/gifs>$/, '').split('\n');
  assert.equal(gifLines.length, PICK_LIBRARY_SIZE, 'the whole library, not a top slice');
  assert.deepEqual([gifLines[0], gifLines.at(-1)], ['g1 -- λεζάντα 1', 'g50 -- λεζάντα 50'], 'in rank order');
  const { options } = picks[0];
  assert.deepEqual([options.role, options.purpose, options.maxOutputTokens, options.model, options.countAgainstDailyCap], ['classifier.text', 'gif-pick', 17, 'cheap/classifier', true]);

  assert.deepEqual(sent(), ['https://tenor.com/view/gif-50'], 'the GIF, no text');
  assert.equal(channel.sent[0].reply.messageReference, 'm1', 'replying where the first message would have');
  assert.deepEqual(store.ownGifs, [{ guildId: 'g1', key: 'k50', ts: NOW }]);
  assert.equal(store.state.data.gifCount, 1, 'counted against gifs.maxPerDay');
  const picked = logs.find((entry) => entry.msg === 'gifs: picked');
  assert.deepEqual([picked.channel, picked.handle, picked.library], ['c1', true, PICK_LIBRARY_SIZE]);
  assert.equal(JSON.stringify(logs.filter((entry) => entry.msg.startsWith('gifs:'))).includes('λεζάντα'), false, 'counts only');
});

test('runTurn: the picker leaves out uncaptioned GIFs and acts only on a listed handle', async () => {
  const library = pickLibrary();
  delete library.mediaCache['item-7'];
  const { picks, sent, logs } = await runPickTurn({ store: pickStore({ library }), pick: 'g7' });
  assert.equal(textOf(picks[0].messages[1].content).includes('g7 --'), false, 'g7 has no caption');
  assert.deepEqual(sent(), ['ναι, φυσικά, έλα'], 'an unlisted handle posts the text');
  const picked = logs.find((entry) => entry.msg === 'gifs: picked');
  assert.deepEqual([picked.handle, picked.library], [false, PICK_LIBRARY_SIZE - 1]);
});

test('runTurn: the picker answering none or something unreadable posts the text', async () => {
  for (const pick of ['none', 'g3 maybe']) {
    const { picks, sent, logs } = await runPickTurn({ pick });
    assert.equal(picks.length, 1, pick);
    assert.deepEqual(sent(), ['ναι, φυσικά, έλα'], pick);
    assert.equal(logs.find((entry) => entry.msg === 'gifs: picked').handle, false, pick);
  }
});

test('runTurn: a failed pick request logs gifs: pick failed and posts the text', async () => {
  const { sent, logs } = await runPickTurn({
    pick: () => {
      throw Object.assign(new Error('upstream'), { statusCode: 503 });
    },
  });
  assert.deepEqual(sent(), ['ναι, φυσικά, έλα']);
  assert.equal(logs.find((entry) => entry.msg === 'gifs: pick failed').status, 503);
});

test('runTurn: no pick for a reply over maxChars or a turn posting its own GIF', async () => {
  const long = await runPickTurn({ reply: '<msg>ναι, φυσικά, έλα απόψε</msg>', pick: 'g1' });
  assert.equal(long.picks.length, 0, 'over maxChars');
  assert.deepEqual(long.sent(), ['ναι, φυσικά, έλα απόψε']);
  const wider = await runPickTurn({ reply: '<msg>ναι, φυσικά, έλα απόψε</msg>', pick: 'g1', pickSettings: { ...PICK_SETTINGS, maxChars: 30 } });
  assert.equal(wider.picks.length, 1, 'maxChars read now');

  const own = await runPickTurn({ reply: '<msg>χα</msg><gif>g2</gif>', pick: 'g1' });
  assert.equal(own.picks.length, 0, 'the turn posts a GIF already');
  assert.deepEqual(own.sent(), ['χα', 'https://tenor.com/view/gif-2']);
});

test('runTurn: no pick with the daily GIF cap spent, a switch off, no prompt or no captioned GIF', async () => {
  const spent = await runPickTurn({ pick: 'g1', store: pickStore({ data: { gifDay: '2026-09-20', gifCount: 3 } }), maxPerDay: 3 });
  assert.equal(spent.picks.length, 0, 'gifs.maxPerDay spent');
  assert.deepEqual(spent.sent(), ['ναι, φυσικά, έλα']);
  const room = await runPickTurn({ pick: 'g1', store: pickStore({ data: { gifDay: '2026-09-20', gifCount: 2 } }), maxPerDay: 3 });
  assert.equal(room.picks.length, 1, 'one GIF left today');

  const off = await runPickTurn({ pick: 'g1', features: { gifPicker: false } });
  assert.equal(off.picks.length, 0, 'features.gifPicker false');
  const gifsOff = await runPickTurn({ pick: 'g1', features: { gifs: false } });
  assert.equal(gifsOff.picks.length, 0, 'features.gifs false');
  const noPrompt = await runPickTurn({ pick: 'g1', prompts: { 'gif-pick': null } });
  assert.equal(noPrompt.picks.length, 0, 'no prompts/gif-pick.md');
  const empty = await runPickTurn({ pick: 'g1', store: pickStore({ library: { gifs: { nextId: 1, entries: {} }, mediaCache: {} } }) });
  assert.equal(empty.picks.length, 0, 'no captioned GIF');
});

test('runTurn: a dry run asks the picker and logs the GIF it would post, posting nothing', async () => {
  const { channel, picks, logs, store } = await runPickTurn({ pick: 'g50', features: { dryRun: true } });
  assert.equal(picks.length, 1);
  assert.equal(channel.sent.length, 0);
  assert.equal(logs.some((entry) => entry.msg === 'dry-run: would send'), false, 'no text');
  const gif = logs.find((entry) => entry.msg === 'dry-run: would send gif');
  assert.deepEqual([gif.gif, gif.replyTo], ['g50', 'm1']);
  assert.deepEqual([store.ownGifs, store.state.data.gifCount], [[], undefined], 'nothing counted or stamped');
});

/** Four chat lines: the trigger (m1) is followed by two later lines from someone else. */
function laterLinesHistory() {
  return [
    rawMessage({ id: 'm0', ts: NOW - 9000, content: 'καλημέρα' }),
    rawMessage({ id: 'm1', ts: NOW - 7000, content: 'θα έρθεις απόψε;' }),
    rawMessage({ id: 'm2', ts: NOW - 5000, authorId: 'u2', authorName: 'Zoé', content: 'κι εγώ ρωτάω' }),
    rawMessage({ id: 'm3', ts: NOW - 3000, authorId: 'u2', authorName: 'Zoé', content: 'λοιπόν;' }),
  ];
}

test('runTurn: the picker\'s context brings in an older answered trigger, first, and the reply names it', async () => {
  const raws = laterLinesHistory();
  const { picks } = await runPickTurn({ raws, triggerRaw: raws[1], reply: '<msg>ναι, φυσικά</msg>' });
  assert.equal(picks.length, 1);
  const [, context, reply] = textOf(picks[0].messages[1].content).split('\n\n');
  assert.match(context, /^<context>\n[^#\n]*\n#1 [^\n]*Alice: θα έρθεις απόψε;\n#2 [^\n]*κι εγώ ρωτάω\n#3 [^\n]*λοιπόν;\n<\/context>$/, 'the answered line with its author, then the last two lines');
  const marker = fill(labels.transcript.replyTo, { index: 1, author: 'Alice', quote: 'θα έρθεις απόψε;' });
  assert.equal(reply, `<reply>\n${marker} ναι, φυσικά\n</reply>`);
});

test('runTurn: the picker names the line the first message replies to, when it is not the last', async () => {
  const raws = laterLinesHistory();
  const { picks } = await runPickTurn({ raws, reply: '<msg reply="#3">χα, ναι</msg>' });
  const [, context, reply] = textOf(picks[0].messages[1].content).split('\n\n');
  assert.match(context, /^<context>\n[^#\n]*\n#1 [^\n]*κι εγώ ρωτάω\n#2 [^\n]*λοιπόν;\n<\/context>$/);
  const marker = fill(labels.transcript.replyTo, { index: 1, author: 'Zoé', quote: 'κι εγώ ρωτάω' });
  assert.equal(reply, `<reply>\n${marker} χα, ναι\n</reply>`);
});

test('runTurn: with several messages a picked GIF replaces the first one only; the rest follow in order', async () => {
  const reply = '<msg reply="#2">χα</msg><msg>και κάτι ακόμα πιο μακρύ από είκοσι</msg><msg>τέλος</msg>';
  const { picks, sent, channel, store } = await runPickTurn({ reply, pick: 'g50' });
  assert.equal(picks.length, 1, 'only the first message counts toward gifs.pick.maxChars');
  assert.equal(textOf(picks[0].messages[1].content).split('\n\n')[2].endsWith(' χα\n</reply>'), true, 'the picker sees the message it would replace');
  assert.deepEqual(sent(), ['https://tenor.com/view/gif-50', 'και κάτι ακόμα πιο μακρύ από είκοσι', 'τέλος']);
  assert.equal(channel.sent[0].reply.messageReference, 'm1', 'the GIF replies where the first message would have');
  assert.deepEqual(store.ownGifs.map((own) => own.key), ['k50']);

  const dry = await runPickTurn({ reply, pick: 'g50', features: { dryRun: true } });
  const order = dry.logs.filter((entry) => entry.msg === 'dry-run: would send gif' || entry.msg === 'dry-run: would send').map((entry) => entry.gif ?? entry.text);
  assert.deepEqual(order, ['g50', 'και κάτι ακόμα πιο μακρύ από είκοσι', 'τέλος'], 'a dry run mirrors the same order');
});

test('runTurn: a picked GIF that fails to send leaves the first message to be posted as written, then the rest', async () => {
  const reply = '<msg reply="#2">χα</msg><msg>τέλος</msg>';
  const { sent, channel, logs, store } = await runPickTurn({ reply, pick: 'g50', failGif: true });
  assert.ok(logs.some((entry) => entry.msg === 'turn: gif failed'), 'the failed GIF is logged');
  assert.deepEqual(sent(), ['χα', 'τέλος'], 'nothing is lost');
  assert.equal(channel.sent[0].reply.messageReference, 'm1', 'the first message replies as written');
  assert.deepEqual(store.ownGifs, [], 'no own post recorded');
});

test('runTurn: gifs.pick.maxChars gates the first message only', async () => {
  const long = await runPickTurn({ reply: '<msg>και κάτι ακόμα πιο μακρύ από είκοσι</msg><msg>χα</msg>', pick: 'g1' });
  assert.equal(long.picks.length, 0, 'a long first message is never replaced');
  assert.deepEqual(long.sent(), ['και κάτι ακόμα πιο μακρύ από είκοσι', 'χα']);
});

test('runTurn: the picker runs alongside the first message\'s typing time', async () => {
  let askedAt = null;
  const pick = () => {
    askedAt = Date.now();
    return new Promise((resolve) => setTimeout(() => resolve('none'), 150));
  };
  const { sendTimes, sent } = await runPickTurn({ reply: '<msg>ναι</msg>', pick, typing: { msPerChar: [0, 0], minMs: 150, maxMs: 150 } });
  assert.deepEqual(sent(), ['ναι']);
  assert.ok(askedAt !== null && askedAt <= sendTimes[0], 'the picker is asked before the send');
  const together = sendTimes[0] - askedAt;
  assert.ok(together >= 140 && together < 270, `the picker and the typing ran together (${together} ms)`);
});

// ---------------------------------------------------------------------------
// Reply parents outside the window: a reply to a message older than the last
// context.channelMessages lines has its parent fetched by id and prepended.

/** A raw reply to `parentId` (see rawMessage). */
function rawReplyTo(parentId, fields) {
  return { ...rawMessage(fields), reference: { messageId: parentId } };
}

/** fakeTurnChannel whose by-id fetch also serves `stored` (raw messages outside the window); `fetchedIds` records every by-id fetch. */
function replyParentChannel(historyMessages, stored = []) {
  const channel = fakeTurnChannel({ historyMessages });
  const byId = new Map(stored.map((m) => [m.id, m]));
  const fetchedIds = [];
  const base = channel.messages.fetch;
  channel.messages.fetch = async (arg) => {
    if (typeof arg === 'string') {
      fetchedIds.push(arg);
      if (byId.has(arg)) return byId.get(arg);
    }
    return base(arg);
  };
  channel.fetchedIds = fetchedIds;
  return channel;
}

/** The video-stage hot config with the reply-parent settings set by the test. */
function replyParentHot({ fetchReplyParents = true, replyParentsFor = 3, replyParentsMax = 4 } = {}) {
  const hot = fakeHot({ mediaDescriptions: true, videoDescriptions: true, vision: false }, {}, VIDEO_TURN_CONFIG);
  Object.assign(hot.config.context, { fetchReplyParents, replyParentsFor, replyParentsMax });
  return hot;
}

const OLD_PARENT_TS = NOW - 2 * 60 * 60 * 1000;

async function runReplyParentTurn({ hot = replyParentHot(), historyMessages, stored, trigger }) {
  const channel = replyParentChannel(historyMessages, stored);
  const llm = fakeLlm('<msg>ok</msg>');
  const describer = fakeVideoDescriber({});
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), describer });
  const { result, logs } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger, triggerKind: 'mention' }));
  return { result, logs, channel, describer, userMessage: textOf(llm.calls[0]?.[1].content) };
}

test('createTurnRunner: a trigger replying outside the window -- its parent is fetched, prepended, rendered as the reply target, and its link reaches the video stage', async () => {
  const parent = rawMessage({ id: 'p1', authorId: 'u2', authorName: 'Bob', ts: OLD_PARENT_TS, content: 'δείτε https://www.youtube.com/watch?v=abc' });
  const triggerRaw = rawReplyTo('p1', { id: 'm2', ts: NOW - 1000, content: 'react to the video above' });
  const { result, channel, describer, userMessage } = await runReplyParentTurn({
    historyMessages: [rawMessage({ id: 'm1', ts: NOW - 5000, content: 'καλημέρα' }), triggerRaw],
    stored: [parent],
    trigger: { ...normalizedTrigger(triggerRaw), replyToId: 'p1' },
  });

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(channel.fetchedIds, ['p1']);
  assert.ok(userMessage.includes('(replying to #1, Bob: '), 'the reply names the prepended parent as the oldest line');
  assert.ok(!userMessage.includes(labels.transcript.replyToOld));
  assert.ok(userMessage.indexOf('δείτε') < userMessage.indexOf('καλημέρα'), 'the parent is the oldest line');
  const items = describer.videoCalls[0].items;
  assert.ok(items.some((item) => item.source === 'link' && item.messageId === 'p1' && item.url === 'https://www.youtube.com/watch?v=abc'));
});

test('createTurnRunner: a reply whose parent is inside the window fetches nothing', async () => {
  const parent = rawMessage({ id: 'p1', authorId: 'u2', authorName: 'Bob', ts: NOW - 5000, content: 'δείτε' });
  const triggerRaw = rawReplyTo('p1', { id: 'm2', ts: NOW - 1000 });
  const { channel, userMessage } = await runReplyParentTurn({
    historyMessages: [parent, triggerRaw],
    trigger: { ...normalizedTrigger(triggerRaw), replyToId: 'p1' },
  });

  assert.deepEqual(channel.fetchedIds, []);
  assert.ok(userMessage.includes('(replying to #1, Bob: '));
});

test('createTurnRunner: a chain of two outside the window -- the parent and its own parent are both prepended, oldest first', async () => {
  const root = rawMessage({ id: 'p1', authorId: 'u3', authorName: 'Chloé', ts: OLD_PARENT_TS, content: 'ρίζα' });
  const middle = rawReplyTo('p1', { id: 'p2', authorId: 'u2', authorName: 'Bob', ts: OLD_PARENT_TS + 1000, content: 'μέση' });
  const triggerRaw = rawReplyTo('p2', { id: 'm2', ts: NOW - 1000 });
  const { channel, userMessage } = await runReplyParentTurn({
    historyMessages: [triggerRaw],
    stored: [root, middle],
    trigger: { ...normalizedTrigger(triggerRaw), replyToId: 'p2' },
  });

  assert.deepEqual(channel.fetchedIds, ['p2', 'p1']);
  assert.ok(userMessage.includes('(replying to #1, Chloé: '), 'the middle line replies to the root');
  assert.ok(userMessage.includes('(replying to #2, Bob: '), 'the trigger replies to the middle line');
  assert.ok(!userMessage.includes(labels.transcript.replyToOld));
});

test('createTurnRunner: context.replyParentsMax caps the fetched parents, context.replyParentsFor picks the window lines asked about', async () => {
  const stored = ['pa', 'pb', 'pc'].map((id, i) => rawMessage({ id, authorId: 'u2', authorName: 'Bob', ts: OLD_PARENT_TS + i }));
  const historyMessages = [
    rawReplyTo('pa', { id: 'm1', ts: NOW - 3000 }),
    rawReplyTo('pb', { id: 'm2', ts: NOW - 2000 }),
    rawReplyTo('pc', { id: 'm3', ts: NOW - 1000 }),
  ];
  const capped = await runReplyParentTurn({ hot: replyParentHot({ replyParentsMax: 2 }), historyMessages, stored, trigger: { ...normalizedTrigger(historyMessages[2]), replyToId: 'pc' } });
  assert.deepEqual(capped.channel.fetchedIds, ['pc', 'pb']);

  const lastOne = await runReplyParentTurn({ hot: replyParentHot({ replyParentsFor: 1 }), historyMessages, stored, trigger: { ...normalizedTrigger(historyMessages[2]), replyToId: 'pc' } });
  assert.deepEqual(lastOne.channel.fetchedIds, ['pc']);
});

test('createTurnRunner: a deleted reply parent is skipped and logged, the turn still speaks', async () => {
  const triggerRaw = rawReplyTo('gone', { id: 'm2', ts: NOW - 1000 });
  const { result, logs, channel, userMessage } = await runReplyParentTurn({
    historyMessages: [triggerRaw],
    trigger: { ...normalizedTrigger(triggerRaw), replyToId: 'gone' },
  });

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(channel.fetchedIds, ['gone']);
  const missing = logs.filter((entry) => entry.msg === 'collect: parent missing');
  assert.deepEqual(missing.map((entry) => [entry.channel, entry.messageId]), [['c1', 'gone']]);
  assert.ok(userMessage.includes(labels.transcript.replyToOld));
});

test('createTurnRunner: context.fetchReplyParents off -- no parent is fetched, the reply reads as one to an older message', async () => {
  const parent = rawMessage({ id: 'p1', authorId: 'u2', authorName: 'Bob', ts: OLD_PARENT_TS });
  const triggerRaw = rawReplyTo('p1', { id: 'm2', ts: NOW - 1000 });
  const { channel, userMessage } = await runReplyParentTurn({
    hot: replyParentHot({ fetchReplyParents: false }),
    historyMessages: [triggerRaw],
    stored: [parent],
    trigger: { ...normalizedTrigger(triggerRaw), replyToId: 'p1' },
  });

  assert.deepEqual(channel.fetchedIds, []);
  assert.ok(userMessage.includes(labels.transcript.replyToOld));
});

// ---------------------------------------------------------------------------
// Participation: recording the persona's sent lines, the pick classifier, the block.

/** A fake store with the participation store: get returns a copy, set records each write. */
function participationStore(initial = { episodes: [], nextId: 1 }, base = fakeStore({ channels: [{ id: 'c2', name: 'journal', purpose: 'a reading log' }] })) {
  let value = structuredClone(initial);
  const writes = [];
  return Object.assign(base, {
    writes,
    current: () => value,
    getParticipation: () => structuredClone(value),
    setParticipation: (guildId, state, opts) => {
      writes.push({ guildId, state, opts });
      value = structuredClone(state);
    },
  });
}

/** One stored episode of channel `channelId`, the persona's line `ageMinutes` old. */
function storedEpisode(id, channelId, ageMinutes, ownText, memberText = 'μια ερώτηση') {
  const at = NOW - ageMinutes * 60_000;
  return {
    id,
    channelId,
    continues: null,
    messages: [
      { id: `${id}-q`, ts: at - 60_000, authorId: 'u9', name: 'Ana', self: false, text: memberText, replyTo: null, caption: null },
      { id: `${id}-a`, ts: at, authorId: 'self-id', name: 'Bot', self: true, text: ownText, replyTo: null, caption: null },
    ],
  };
}

/** The turn's channel c1 with #journal (c2) and #jardin (c3) in its guild, everyone seeing all three. */
function participationChannel(historyMessages) {
  const channel = fakeTurnChannel({ id: 'c1', name: 'general', historyMessages });
  for (const [id, name] of [['c2', 'journal'], ['c3', 'jardin']]) {
    channel.guild.channels.cache.set(id, { id, name, guild: channel.guild, viewable: true, permissionsFor: () => ({ has: () => true }) });
  }
  channel.guild.channels.cache.set('c1', channel);
  return channel;
}

async function runParticipationTurn({ answers, store = participationStore(), hot = fakeHot({ typingSimulation: false }), history } = {}) {
  const raws = history ?? [
    rawMessage({ id: 'm0', authorId: 'u2', authorName: 'Bob', ts: NOW - 5000, content: 'πρώτη γραμμή' }),
    rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', ts: NOW - 1000, content: 'θυμάσαι το βιβλίο;' }),
  ];
  const channel = participationChannel(raws);
  const llm = sequenceLlm(answers);
  const turns = createTurnRunner({ hot, store, llm, calibrator: identityCalibrator(), client: fakeClient(), now: () => NOW });
  const params = { channel, mode: 'reply', trigger: normalizedTrigger(raws.at(-1)), triggerKind: 'mention' };
  const { result, logs } = await withCapturedLogs(() => turns.runTurn(params));
  return { result, logs, channel, llm, store };
}

test('runTurn: each message sent is recorded as participation with the history lines before it', async () => {
  const { result, store, logs } = await runParticipationTurn({ answers: ['<msg reply="#2">στο ράφι</msg><msg>το είδα χθες</msg>'] });
  assert.equal(result.outcome, 'spoke');
  assert.equal(store.writes.length, 2, 'one write per message sent');
  const [episode] = store.current().episodes;
  assert.equal(episode.channelId, 'c1');
  assert.deepEqual(episode.messages.map((m) => m.id), ['m0', 'm1', 'sent-1', 'sent-2']);
  const own = episode.messages.find((m) => m.id === 'sent-1');
  assert.equal(own.self, true);
  assert.equal(own.authorId, 'self-id');
  assert.equal(own.name, 'Bot');
  assert.equal(own.text, 'στο ράφι');
  assert.equal(own.replyTo, 'm1');
  assert.equal(episode.messages.find((m) => m.id === 'm1').name, 'Alice');
  assert.equal(store.writes[0].opts.now, NOW);
  assert.equal(store.writes[0].opts.settings.hours, 72);
  const recorded = logs.filter((l) => l.msg === 'participation: recorded');
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0].channel, 'c1');
  assert.equal(recorded[1].episodes, 1);
  assert.ok(!JSON.stringify(recorded).includes('ράφι'), 'no text in the log');
});

test('runTurn: a reply to a line older than the lines before it records that line as the parent', async () => {
  const hot = fakeHot({ typingSimulation: false }, {}, { participation: { linesBefore: 1 } });
  const raws = [
    rawMessage({ id: 'm0', authorId: 'u2', authorName: 'Bob', ts: NOW - 9000, content: 'η αρχή' }),
    rawMessage({ id: 'mx', authorId: 'u3', authorName: 'Cleo', ts: NOW - 5000, content: 'κάτι άλλο' }),
    rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', ts: NOW - 1000, content: 'θυμάσαι;' }),
  ];
  const { store } = await runParticipationTurn({ hot, history: raws, answers: ['<msg reply="#1">ναι, αυτό</msg>'] });
  const [episode] = store.current().episodes;
  assert.deepEqual(episode.messages.map((m) => m.id), ['m0', 'm1', 'sent-1'], 'm1 is the one line before, m0 the parent; mx is left out');
  assert.equal(episode.messages.find((m) => m.id === 'sent-1').replyTo, 'm0');
});

test('runTurn: a dry run, the switch off and a private chat record nothing', async () => {
  const dry = await runParticipationTurn({ hot: fakeHot({ typingSimulation: false, dryRun: true }), answers: ['<msg>ναι</msg>'] });
  assert.equal(dry.result.outcome, 'spoke');
  assert.equal(dry.store.writes.length, 0);
  const off = await runParticipationTurn({ hot: fakeHot({ typingSimulation: false, participation: false }), answers: ['<msg>ναι</msg>'] });
  assert.equal(off.channel.sent.length, 1);
  assert.equal(off.store.writes.length, 0);
  const store = participationStore({ episodes: [], nextId: 1 }, privateStore());
  const dm = await runPrivateTurn({ store });
  assert.equal(dm.channel.sent.length, 1);
  assert.equal(store.writes.length, 0);
  assert.ok(!textOf(dm.llm.calls.at(-1)[1].content).includes('<participation>'), 'no block in a private chat');
});

test('runTurn: the pick classifier runs beside the turn and its pick reaches the <participation> block', async () => {
  const store = participationStore({ episodes: [storedEpisode('p1', 'c2', 120, 'στο ράφι είναι'), storedEpisode('p2', 'c3', 30, 'ωραία λουλούδια')], nextId: 3 });
  const hot = fakeHot({ typingSimulation: false }, {}, { participation: { shown: 1 } });
  hot.prompts['participation-pick'] = 'Pick for {{name}}.';
  const { llm, logs, result } = await runParticipationTurn({ hot, store, answers: ['2', '<msg>ναι</msg>'] });
  assert.equal(result.outcome, 'spoke');
  assert.equal(llm.calls.length, 2);
  assert.equal(llm.calls[0][0].content, 'Pick for Bot.');
  assert.ok(
    textOf(llm.calls[0][1].content).includes('<episodes>\n1 | #jardin | 30 min | Ana: μια ερώτηση | Bot: ωραία λουλούδια\n2 | #journal | 2 h | Ana: μια ερώτηση | Bot: στο ράφι είναι\n</episodes>'),
    textOf(llm.calls[0][1].content),
  );
  const user = textOf(llm.calls[1][1].content);
  assert.ok(user.includes('<participation>') && user.includes('#journal (a reading log):') && user.includes('στο ράφι είναι'), 'the picked older episode is shown');
  assert.ok(!user.includes('ωραία λουλούδια'), 'shown: 1 leaves the newest out for the pick');
  assert.ok(user.includes(labels.senses.participation));
  const answered = logs.find((l) => l.msg === 'turn: model answered');
  assert.equal(answered.budget.participation.shown, 1);
  const timings = logs.find((l) => l.msg === 'turn: timings');
  assert.equal(typeof timings.stages.participation, 'number');
});

test('runTurn: without the pick prompt the newest episodes are shown and the classifier is skipped', async () => {
  const store = participationStore({ episodes: [storedEpisode('p1', 'c2', 120, 'στο ράφι είναι'), storedEpisode('p2', 'c3', 30, 'ωραία λουλούδια')], nextId: 3 });
  const hot = fakeHot({ typingSimulation: false }, {}, { participation: { shown: 1 } });
  const { llm, logs } = await runParticipationTurn({ hot, store, answers: ['<msg>ναι</msg>'] });
  assert.equal(llm.calls.length, 1, 'only the reply request');
  const user = textOf(llm.calls[0][1].content);
  assert.ok(user.includes('ωραία λουλούδια') && !user.includes('στο ράφι είναι'));
  assert.equal(logs.find((l) => l.msg === 'participation: skipped')?.reason, 'no-prompt');
});

test('runTurn: the model answered log line carries the user message segments, hashes only', async () => {
  const { logs } = await runDrawTurn({ answers: ['<draw>a cat</draw>'] });
  const answered = logs.find((l) => l.msg === 'turn: model answered');
  assert.ok(Array.isArray(answered.segments) && answered.segments.length >= 1);
  assert.equal(answered.segments.at(-1).segment, 'tail');
  for (const s of answered.segments) {
    assert.deepEqual(Object.keys(s).sort(), ['chars', 'hash', 'segment']);
    assert.match(s.hash, /^[0-9a-f]{8}$/);
    assert.ok(s.chars > 0);
  }
});

/** A real journal over a fake append store that keeps every line in memory. */
function journalOverMemory() {
  const lines = [];
  const appendStore = {
    append: async (file, line) => {
      lines.push({ file, record: JSON.parse(line) });
    },
    async *iterate() {},
  };
  let n = 0;
  const journal = createJournal({ appendStore, dataDir: 'fake-data', config: () => ({ thinkChars: 4000 }), now: () => NOW, uuid: () => `u${(n += 1)}` });
  return { journal, lines };
}

/** An LLM whose one answer reports provider usage: 700 completion tokens, 300 of the prompt cached. */
function usageLlm(text) {
  const calls = [];
  return {
    calls,
    complete: async (messages) => {
      calls.push(messages);
      return {
        text,
        usage: { prompt_tokens: 1500, completion_tokens: 700, prompt_tokens_details: { cached_tokens: 300 } },
        promptTokens: 1500,
        estimated: 1400,
      };
    },
  };
}

test('turn: writes turn.start and turn records when the journal is on', async () => {
  const earlier = rawMessage({ id: 'm0', authorId: 'u2', authorName: 'Zoé', ts: NOW - 5000, content: 'καλημέρα' });
  const raw = rawMessage({ id: 'm1', authorId: 'u1', authorName: 'Alice', ts: NOW - 1000 });
  const channel = fakeTurnChannel({ historyMessages: [earlier, raw] });
  const llm = usageLlm('<think>Η Αλίκη με φωνάζει.</think><msg reply="#2">γεια</msg><react to="#1">\u{1F389}</react>');
  const hot = fakeHot({ journal: true, typingSimulation: false }, {}, { llm: { maxRequestTokens: 50000, safetyMargin: 0.9, maxOutputTokens: 700 } });
  const { journal, lines } = journalOverMemory();
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: identityCalibrator(), client: fakeClient(), journal });

  const result = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });

  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(lines.map(({ record }) => record.kind), ['turn.start', 'turn']);
  const [start, turn] = lines.map(({ record }) => record);
  assert.equal(lines[0].file, lines[1].file);
  assert.ok(lines[0].file.endsWith('2026-09-20.jsonl'));
  assert.equal(result.turnId, start.turnId);
  assert.equal(result.attemptId, 1);
  assert.equal(start.mode, 'reply');
  assert.deepEqual(start.trigger, { kind: 'mention', messageId: 'm1', authorId: 'u1' });
  assert.deepEqual(start.scope, { channel: 'c1' });
  assert.equal(turn.turnId, start.turnId);
  assert.equal(turn.attemptId, 1);
  assert.equal(turn.outcome, 'spoke');
  assert.equal(turn.reason, null);
  assert.deepEqual(turn.seen, { messageIds: ['m0', 'm1'], parents: [], parts: { images: [], filePreviews: [] } });
  assert.deepEqual(turn.sourceMessageIds, ['m0', 'm1']);
  assert.deepEqual([...turn.participants].sort(), ['u1', 'u2']);
  assert.equal(turn.think, 'Η Αλίκη με φωνάζει.');
  assert.deepEqual(turn.posted, [{ messageId: 'sent-1', replyTo: 'm1' }]);
  assert.deepEqual(turn.reactions, [{ to: 'm0', emoji: '\u{1F389}' }]);
  assert.deepEqual(turn.actions, []);
  assert.deepEqual(turn.usage, { prompt: 1500, cached: 300, completion: 700 });
  assert.equal(typeof turn.budget.dropped, 'object');
  assert.deepEqual(turn.limits.filter((limit) => limit.kind === 'output-cap'), [{ kind: 'output-cap', where: 'completion', lost: null }]);
  for (const limit of turn.limits.filter((entry) => entry.kind === 'budget-drop')) {
    assert.equal(turn.budget.dropped[limit.where], limit.lost);
  }

  // The switch off (read at the moment of use): nothing more is written.
  hot.config.features.journal = false;
  const off = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
  assert.equal(off.outcome, 'spoke');
  assert.equal(lines.length, 2);
  assert.equal('turnId' in off, false);

  // A budget that drops chat lines: the drop is named in budget.dropped and in limits.
  hot.config.features.journal = true;
  hot.config.llm = { maxRequestTokens: 500, safetyMargin: 1, maxOutputTokens: 4000 };
  const crowded = [];
  for (let i = 0; i < 12; i += 1) crowded.push(rawMessage({ id: `k${i}`, authorId: 'u2', ts: NOW - 60_000 + i * 1000, content: 'λέξη '.repeat(30) }));
  const last = crowded.at(-1);
  await turns.runTurn({ channel: fakeTurnChannel({ historyMessages: crowded }), mode: 'reply', trigger: normalizedTrigger(last), triggerKind: 'mention' });
  const tight = lines.at(-1).record;
  assert.equal(tight.kind, 'turn');
  assert.ok(tight.budget.dropped.chat > 0, JSON.stringify(tight.budget));
  assert.deepEqual(tight.limits, [{ kind: 'budget-drop', where: 'chat', lost: tight.budget.dropped.chat }]);
  assert.equal(tight.seen.messageIds.length, 12 - tight.budget.dropped.chat);
});

test('turn: logs thinkChars not think when the journal is on', async () => {
  const raw = rawMessage({ id: 'm1' });
  const answer = '<think>Ζωή μιλά</think><msg>γεια</msg>';
  const run = async (features, journal) => {
    const channel = fakeTurnChannel({ historyMessages: [raw] });
    const turns = createTurnRunner({ hot: fakeHot({ typingSimulation: false, ...features }), store: fakeStore(), llm: fakeLlm(answer), calibrator: identityCalibrator(), client: fakeClient(), journal });
    const { logs } = await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
    return logs.find((l) => l.msg === 'turn: model answered');
  };

  const on = await run({ journal: true }, journalOverMemory().journal);
  assert.equal(on.thinkChars, 8);
  assert.equal('think' in on, false);

  const off = await run({ journal: false }, journalOverMemory().journal);
  assert.equal(off.think, 'Ζωή μιλά');
  assert.equal('thinkChars' in off, false);
});
