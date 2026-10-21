// Tests for what a heartbeat turn may do (docs/inner-life.md "What a heartbeat may do"): with
// innerLife.heartbeat.intentionsOnly only an intention change and a skip are accepted (anything else is
// refused heartbeat-only and she reads why), the turn ends after the first change that goes through with no
// further request, the engine stamps origin `heartbeat` on what the turn creates and the updates keep it,
// the caps (maxOpen, maxRecurring) refuse naming the open ones, and the switch gives the earlier
// behaviour back. Over a real admin, a real intention service on a temp data dir and the fake interface
// adapter; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRunner } from '../src/behavior/turn.js';
import { userText } from '../src/behavior/prompt.js';
import { createFakeAdapter } from '../src/interface/fake.js';
import { createDiscordInterface } from '../src/interface/discord.js';
import '../src/ops/index.js';
import { skillRegistry } from '../src/skills/registry.js';
import { createAdmin } from '../src/admin.js';
import { createIntentionStores } from '../src/intentions/store.js';
import { createIntentionService } from '../src/intentions/service.js';
import { buildHeartbeatFacts } from '../src/behavior/heartbeat-view.js';
import { wakeBlockText } from '../src/behavior/wake.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { call, completionOf, toolAnswer } from './fixtures/tool-answers.js';
import { tempDir } from './fixtures/tmp.js';

const DISCORD = createDiscordInterface().capabilities;
const NOW = Date.parse('2026-10-19T12:00:00Z');
const INNER_TASK = 'Nobody wrote to you; read the wake block.';

function rawMessage({ id, authorId = 'u1', authorName = 'Alice', ts = NOW - 60_000, content = 'καλημέρα' }) {
  return {
    id,
    channelId: 'c1',
    author: { id: authorId, bot: false, globalName: authorName, username: authorName },
    member: { displayName: authorName },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
}

/** The channel c1 over `historyMessages`; `listed`: whether the guild's channel directory lists it. */
function fakeChannel(historyMessages, { listed = true } = {}) {
  const channel = {
    id: 'c1',
    name: 'general',
    guild: { id: 'g1', members: { me: { displayName: 'Bot' } }, channels: { cache: new Map() } },
    viewable: true,
    isTextBased: () => true,
    isThread: () => false,
    parent: null,
    permissionsFor: () => ({ has: () => true }),
    sendTyping: async () => {},
    send: async () => ({ id: 'sent' }),
    messages: {
      cache: new Map(),
      fetch: async (arg) => {
        if (arg && typeof arg === 'object' && 'limit' in arg) return new Map(historyMessages.slice(-arg.limit).map((m) => [m.id, m]));
        return historyMessages.find((m) => m.id === arg) ?? null;
      },
    },
  };
  if (listed) channel.guild.channels.cache.set(channel.id, channel);
  return channel;
}

function fakeStore() {
  return {
    getGuild: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    countUsers: () => 0,
    getLore: () => [],
    getMediaCache: () => ({}),
    state: { data: {}, markDirty() {} },
  };
}

function hotWith({ features = {}, access = {}, innerLife = {} } = {}) {
  return {
    config: {
      bot: { timezone: 'UTC', dryRunChannelId: '', owners: ['u1'], access },
      context: {
        channelMessages: 100, neighborMessages: 5, neighborMaxAgeMinutes: 60, neighborMaxChannels: 8, maxMessageChars: 800,
        gapMarkerMinutes: 20, otherProfiles: 6, caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0, maxBytes: 1_500_000, fetchTimeoutMs: 10_000 },
        pull: { scanMessages: 20, maxChannels: 1, sameAudience: true },
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      features: { memory: true, reactions: true, multiMessage: true, typingSimulation: false, vision: false, followUpContinuation: true, callMarkers: true, coreTools: true, ...features },
      models: { helpers: { analyzer: 'x/text' } },
      media: { maxPerTurn: 6, filePreviewChars: 500 },
      gifs: { maxPerDay: 40 },
      skills: { safeMode: false, resultMaxChars: 2000, callTimeoutMs: 120000, loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 } },
      innerLife: { mode: 'shadow', chatMessages: 2, ...innerLife },
    },
    prompts: {
      'system-prompt': 'You are a regular member of this chat, not an assistant.',
      'character-card': 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      reply: 'Someone called you: {{author}}.',
      interject: 'Jump into the conversation.',
      initiate: 'Start a topic.',
      inner: INNER_TASK,
      labels,
    },
  };
}

function personaGrants(names) {
  return Object.fromEntries(names.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }]));
}

function sequenceLlm(answers, { onCall = null } = {}) {
  const calls = [];
  return {
    calls,
    complete: async (messages) => {
      calls.push(messages);
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (onCall) onCall(calls.length);
      return completionOf(answer);
    },
  };
}

const BEAT_WAKE = {
  kind: 'heartbeat',
  items: [{ kind: 'heartbeat', reason: 'heartbeat', intentionIds: [], taskId: null }],
  intentions: [],
  now: NOW,
  timezone: 'UTC',
  channels: [],
  chainId: 'heartbeat:1',
  budgets: { chain: { used: 0, cap: 3, left: 3 } },
};
const DUE_WAKE = { ...BEAT_WAKE, kind: 'intention_due', items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], taskId: null }], chainId: 'i1' };
const GRANTS = ['lore.list', 'message.create', 'intent.set', 'intent.update', 'intent.cancel'];

/** A real intention service over a temp data dir (guild g1) and a clock fixed at NOW. */
function intentionService(hot) {
  const stores = createIntentionStores({ dataDir: tempDir('nep-hb-intents-'), now: () => NOW });
  return createIntentionService({ stores, hot, getGuildId: () => 'g1', now: () => NOW, log: { info() {}, warn() {} } });
}

/**
 * One live inner turn in #general answered with `answers`, over the real intention service. `wake` is the turn's
 * wake (a heartbeat by default), `beat` the `innerLife.heartbeat` section of the turn's config, `seed(service)`
 * what exists before the turn.
 */
async function liveTurn({ answers, wake = BEAT_WAKE, beat = {}, seed = null, intentionsCfg = {} }) {
  const history = [rawMessage({ id: 'm0', ts: NOW - 120_000, content: 'πρώτο' })];
  const hot = hotWith({ features: { intentions: true }, access: personaGrants(GRANTS), innerLife: { mode: 'live', heartbeat: beat } });
  hot.config.intentions = { expiresDays: 14, maxOpen: 20, ...intentionsCfg };
  const intentions = intentionService(hot);
  seed?.(intentions);
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW });
  for (const m of history) port.seed('c1', { authorId: m.author.id, messageId: m.id, text: m.cleanContent });
  const client = { user: { id: 'self-id', username: 'Bot' }, channels: { cache: new Map() } };
  const store = fakeStore();
  const admin = createAdmin({ discord: DISCORD, hot, store, client, getGuildId: () => 'g1', port, intentions });
  const llm = sequenceLlm(typeof answers === 'function' ? answers(intentions) : answers);
  const calibrator = { ratio: 1, apply: (value) => value, observe: () => {} };
  const turns = createTurnRunner({ discord: DISCORD, hot, store, llm, calibrator, client, now: () => NOW, port, skills: skillRegistry(), journal: null, runOp: admin.runSkillOp, runOwnOp: admin.runOwnSkillOp, runInitiativeOp: admin.runInitiativeSkillOp, intentions });
  const inner = { wake, shadow: false, mayAct: () => true, currentChannel: null };
  const { result, logs } = await withCapturedLogs(() => turns.runTurn({ channel: fakeChannel(history), guildId: 'g1', mode: 'inner', triggerKind: 'inner', inner }));
  const sends = port.calls.filter((call) => call.op === 'send');
  return { result, logs, llm, sends, intentions, hot, list: () => intentions.list('g1', { all: true, closed: true }) };
}

const THINK = '<think>STEP 4. So: write it.</think>';
const SET = (text, extra = {}) => toolAnswer(THINK, [call('intent.set', { due: '0m', text, ...extra })]);
/** What she read of the calls of request `i`: the content of its tool messages, in order. */
const readOf = (run, i) => run.llm.calls[i].filter((message) => message.role === 'tool').map((message) => (typeof message.content === 'string' ? message.content : message.content.map((part) => part.text).join(''))).join('\n');
const actionsOf = (run) => run.result.inner.actions.map((a) => `${a.skill}:${a.status}:${a.code ?? a.result}`);

test('heartbeat turn: a post and a read are refused heartbeat-only, she reads why, then one intent.set ends the turn with no further request', async () => {
  const run = await liveTurn({ answers: [toolAnswer(THINK, [call('message.create', { text: 'γεια' }), call('lore.list')]), SET('check the thread in #general and answer if it is still open')] });
  assert.deepEqual(actionsOf(run), ['message.create:refused:heartbeat-only', 'lore.list:refused:heartbeat-only', 'intent.set:executed:ok']);
  assert.deepEqual(run.sends, [], 'nothing was posted');
  assert.equal(run.llm.calls.length, 2, 'the refusal step, and no request after the change');
  assert.ok(readOf(run, 1).includes(labels.skills.result.reasons['heartbeat-only']), 'she reads the refusal');
  assert.equal(run.list().length, 1);
  assert.ok(run.logs.some((log) => log.msg === 'heartbeat: call refused' && log.skill === 'lore.list'), 'the refusal is logged');
});

test('heartbeat turn: the first change that goes through ends the turn at once; a skip is one request', async () => {
  const set = await liveTurn({ answers: [SET('look at the diary draft'), '<skip/>'] });
  assert.equal(set.llm.calls.length, 1, 'no acknowledgement step');
  assert.deepEqual(actionsOf(set), ['intent.set:executed:ok']);
  const skip = await liveTurn({ answers: [`${THINK}<skip/>`] });
  assert.equal(skip.llm.calls.length, 1);
  assert.equal(skip.result.outcome, 'skip');
  assert.deepEqual(skip.list(), []);
});

test('heartbeat turn: a second intention call in the same step is refused, and a refused change does not end the turn', async () => {
  const two = await liveTurn({ answers: [toolAnswer(`${THINK}`, [call('intent.set', { due: `1h`, text: `first thing` }), call('intent.set', { due: `2h`, text: `second thing` })]), '<skip/>'] });
  assert.deepEqual(actionsOf(two), ['intent.set:executed:ok', 'intent.set:refused:heartbeat-only']);
  assert.equal(two.list().length, 1);
  assert.equal(two.llm.calls.length, 1);
  const bad = await liveTurn({ answers: [toolAnswer(`${THINK}`, [call('intent.set', { due: `soon`, text: `a thing` })]), SET('a thing')] });
  assert.deepEqual(actionsOf(bad), ['intent.set:executed:bad-time', 'intent.set:executed:ok']);
  assert.equal(bad.llm.calls.length, 2, 'she saw the failure and corrected the call');
});

test('heartbeat turn: the engine stamps origin heartbeat on what it creates; an update keeps it, a heartbeat updating another one does not relabel it', async () => {
  const run = await liveTurn({
    answers: (service) => [toolAnswer(`${THINK}`, [call('intent.update', { id: `${service.list('g1', { all: true })[0].id}`, text: `new words` })])],
    seed: (service) => service.set('g1', { purpose: 'her own earlier one', dueAt: NOW + 3_600_000 }),
  });
  assert.deepEqual(actionsOf(run), ['intent.update:executed:ok']);
  assert.equal(run.list()[0].purpose, 'new words');
  assert.equal(run.list()[0].origin, undefined, 'not relabelled');
  const made = await liveTurn({ answers: [SET('made by a heartbeat')] });
  assert.equal(made.list()[0].origin, 'heartbeat', 'stamped by the engine');
  const id = made.list()[0].id;
  assert.equal(made.intentions.update('g1', id, { purpose: 'reworded', by: 'persona' }).intention.origin, 'heartbeat');
  assert.equal(made.intentions.update('g1', id, { dueAt: NOW + 7_200_000 }).intention.origin, 'heartbeat');
});

test('intent.set outside a heartbeat carries no origin and no heartbeat cap', async () => {
  const run = await liveTurn({
    wake: DUE_WAKE,
    answers: [SET('one'), '<skip/>'],
    seed: (service) => {
      for (const n of [1, 2, 3]) service.set('g1', { purpose: `from a heartbeat ${n}`, dueAt: NOW + n * 3_600_000, origin: 'heartbeat' });
    },
  });
  assert.equal(run.list().length, 4);
  assert.equal(run.list().find((r) => r.purpose === 'one').origin, undefined);
});

test('heartbeat caps: at maxOpen intent.set is refused heartbeat-cap and the result names the open ones; closing one frees the room', async () => {
  const seed = (service) => {
    for (const n of [1, 2, 3]) service.set('g1', { purpose: `heartbeat thing ${n}`, dueAt: NOW + n * 3_600_000, origin: 'heartbeat' });
  };
  const run = await liveTurn({ answers: [SET('a fourth'), '<skip/>'], seed });
  assert.deepEqual(actionsOf(run), ['intent.set:executed:heartbeat-cap']);
  assert.equal(run.list().length, 3);
  const ids = run.list().map((r) => r.id);
  const shown = readOf(run, 1);
  for (const id of ids) assert.ok(shown.includes(id), `the result names ${id}`);
  assert.ok(shown.includes('heartbeat thing 2'));
  const freed = await liveTurn({ answers: [SET('a fourth')], seed: (service) => { seed(service); const first = service.list('g1', { all: true })[0]; service.cancel('g1', first.id, { all: true }); } });
  assert.deepEqual(actionsOf(freed), ['intent.set:executed:ok']);
  const own = await liveTurn({ answers: [SET('a fourth'), '<skip/>'], beat: { maxOpen: 4 }, seed });
  assert.deepEqual(actionsOf(own), ['intent.set:executed:ok'], 'a turn sets its own cap');
});

test('heartbeat caps: one recurring at most, for a new one and for a one-off made recurring', async () => {
  const seed = (service) => {
    service.set('g1', { purpose: 'regular thing', dueAt: NOW + 3_600_000, every: { period: 'day', at: null }, origin: 'heartbeat' });
    service.set('g1', { purpose: 'one-off', dueAt: NOW + 7_200_000, origin: 'heartbeat' });
  };
  const fresh = await liveTurn({ answers: [SET('another regular', { every: 'day' }), '<skip/>'], seed });
  assert.deepEqual(actionsOf(fresh), ['intent.set:executed:heartbeat-recurring-cap']);
  const plain = await liveTurn({ answers: [SET('plain one')], seed });
  assert.deepEqual(actionsOf(plain), ['intent.set:executed:ok']);
  const made = await liveTurn({ answers: (service) => [toolAnswer(`${THINK}`, [call('intent.update', { id: `${service.list('g1', { all: true }).find((r) => r.purpose === 'one-off').id}`, every: `day` })]), '<skip/>'], seed });
  assert.deepEqual(actionsOf(made), ['intent.update:executed:heartbeat-recurring-cap']);
  assert.equal(made.list().filter((r) => r.every).length, 1);
  const other = await liveTurn({ answers: [SET('x', { every: 'day' })], beat: { maxRecurring: 2 }, seed });
  assert.deepEqual(actionsOf(other), ['intent.set:executed:ok']);
  assert.equal(other.list().filter((r) => r.every).length, 2);
});

test('heartbeat turn: the switch off gives the earlier behaviour back (a post goes out and the change is no end of the turn by itself); the origin is still stamped', async () => {
  const run = await liveTurn({ answers: [toolAnswer(`${THINK}`, [call('message.create', { channel: `#general`, text: `καλημέρα` }), call('intent.set', { due: `1h`, text: `later` })]), '<skip/>'], beat: { intentionsOnly: false } });
  assert.deepEqual(actionsOf(run), ['message.create:executed:ok', 'intent.set:executed:ok']);
  assert.equal(run.sends.length, 1);
  assert.equal(run.llm.calls.length, 1, 'the post and the change both went through: nothing is left to read');
  assert.equal(run.list()[0].origin, 'heartbeat');
});

test('an intention_due turn is not limited to intention changes', async () => {
  const run = await liveTurn({ wake: { ...DUE_WAKE, intentions: [{ id: 'i1', purpose: 'say hello', dueAt: NOW }] }, answers: [toolAnswer(`${THINK}`, [call('message.create', { channel: `#general`, text: `γεια` })]), '<skip/>'] });
  assert.equal(run.sends.length, 1);
});

test('the heartbeat view marks an open intention a heartbeat made; the wake words it compactly and says what the wake accepts only with the switch on', async () => {
  const record = (id, extra = {}) => ({ id, status: 'pending', purpose: `purpose ${id}`, dueAt: NOW + 3_600_000, provenance: { kind: 'self' }, createdAt: NOW, updatedAt: NOW, expiresAt: NOW + 86_400_000, ...extra });
  const view = async (settings) => buildHeartbeatFacts({ guildId: 'g1', now: NOW, since: NOW - 3_600_000, placeName: (id) => id, settings, record: { iterate: async function* iterate() {} }, intentions: [record('ia', { origin: 'heartbeat' }), record('ib')] });
  const on = await view({ intentionsOnly: true });
  assert.deepEqual(on.life.open.items.map((item) => item.origin ?? null), ['heartbeat', null]);
  const text = wakeBlockText({ ...BEAT_WAKE, heartbeat: on }, labels).split('\n');
  const lineOf = (id) => text.find((line) => line.startsWith(`${id} ·`));
  assert.ok(lineOf('ia').endsWith(labels.wake.heartbeat.openOrigin), lineOf('ia'));
  assert.ok(!lineOf('ib').includes(labels.wake.heartbeat.openOrigin), 'an intention of hers has no mark');
  assert.ok(text.includes(labels.wake.heartbeat.intentionsOnly));
  const off = await view({ intentionsOnly: false });
  assert.ok(!wakeBlockText({ ...BEAT_WAKE, heartbeat: off }, labels).includes(labels.wake.heartbeat.intentionsOnly));
});
