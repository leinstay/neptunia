// Tests for the inner turn (src/behavior/turn.js, mode `inner`; docs/inner-life.md): no message
// is fabricated, the request carries `<wake>` and the inner task, her reads run; in shadow mode
// nothing else does (proposed, journalled as shadow, no call mark), live her calls run through
// the gateway on her own grants, the kill switch is asked right before an action, the public post
// cap refuses, text outside a call reaches nobody, and an ordinary turn's request is unchanged by
// the switch. Over a real admin and the fake interface adapter; no network, no data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRunner } from '../src/behavior/turn.js';
import { userText } from '../src/behavior/prompt.js';
import { createFakeAdapter } from '../src/interface/fake.js';
import { createDiscordInterface } from '../src/interface/discord.js';
import { createJournal, callMarksOf } from '../src/memory/journal.js';
import '../src/ops/index.js';
import { skillRegistry } from '../src/skills/registry.js';
import { checkSkill } from '../src/skills/gateway.js';
import { createAdmin } from '../src/admin.js';
import { wakeBlockText } from '../src/behavior/wake.js';
import { wakeLanes } from '../src/behavior/prefetch.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

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

function fakeChannel(historyMessages) {
  return {
    id: 'c1',
    name: 'general',
    guild: { id: 'g1', members: { me: { displayName: 'Bot' } }, channels: { cache: new Map() } },
    viewable: true,
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
      models: { base: { analyzer: 'x/text' } },
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
      return { text: answer, usage: {}, estimated: 10 };
    },
  };
}

function journalOverMemory() {
  const lines = [];
  const appendStore = { append: async (file, line) => lines.push(JSON.parse(line)), async *iterate() {} };
  let n = 0;
  const journal = createJournal({ appendStore, dataDir: 'fake-data', config: () => ({ thinkChars: 4000 }), now: () => NOW, uuid: () => `u${(n += 1)}` });
  return { journal, lines };
}

const WAKE = {
  kind: 'intention_due',
  items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], taskId: null }],
  intentions: [{ id: 'i1', purpose: 'πες καλημέρα στο κανάλι', dueAt: NOW - 60_000 }],
  now: NOW,
  timezone: 'UTC',
  channels: [],
  budgets: {
    day: { used: 1, cap: 24, left: 23, resetAt: Date.parse('2026-10-20T00:00:00Z') },
    hour: { used: 1, cap: 4, left: 3, resetAt: NOW + 3_000_000 },
    chain: { used: 0, cap: 3, left: 3 },
    usd: { used: 0.15, cap: 4, left: 3.85, resetAt: Date.parse('2026-10-20T00:00:00Z') },
    posts: { used: 0, cap: 2, left: 2, resetAt: Date.parse('2026-10-20T00:00:00Z') },
  },
};

/**
 * One inner turn in #general (c1) answered with `answers`; `shadow` its mode; `gate` overrides of
 * the inner parameter (mayAct, postAllowed, onPosted).
 */
async function innerTurn({ answers, shadow = true, gate = {}, journal = null, allowed = ['lore.list'], onCall = null, features = {} }) {
  const history = [rawMessage({ id: 'm0', ts: NOW - 120_000, content: 'πρώτο' }), rawMessage({ id: 'm1', authorId: 'u2', authorName: 'Zoë', content: 'δεύτερο' }), rawMessage({ id: 'm2', ts: NOW - 30_000, content: 'τρίτο' })];
  const hot = hotWith({ features: { journal: Boolean(journal), ...features }, access: personaGrants(allowed) });
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW });
  for (const m of history) port.seed('c1', { authorId: m.author.id, messageId: m.id, text: m.cleanContent });
  const client = { user: { id: 'self-id', username: 'Bot' }, channels: { cache: new Map() } };
  const store = fakeStore();
  const admin = createAdmin({ discord: DISCORD, hot, store, client, getGuildId: () => 'g1', port });
  const llm = sequenceLlm(answers, { onCall });
  const calibrator = { ratio: 1, apply: (value) => value, observe: () => {} };
  const turns = createTurnRunner({ discord: DISCORD, hot, store, llm, calibrator, client, now: () => NOW, port, skills: skillRegistry(), journal, runCommand: admin.runCommand, runOwnCommand: admin.runOwnCommand, runInitiativeCommand: admin.runInitiativeCommand });
  const posted = [];
  const inner = { wake: WAKE, shadow, mayAct: () => true, postAllowed: () => true, onPosted: () => posted.push(NOW), ...gate };
  const { result, logs } = await withCapturedLogs(() => turns.runTurn({ channel: fakeChannel(history), guildId: 'g1', mode: 'inner', triggerKind: 'inner', inner }));
  const sends = port.calls.filter((call) => call.op === 'send').map((call) => ({ to: call.args[0].conversationId, ...call.args[1] }));
  return { result, logs, llm, sends, posted };
}

test('inner turn: no message is fabricated; the request carries <wake>, the inner task and the bounded slice of the channel', async () => {
  const run = await innerTurn({ answers: ['<skip/>'] });
  const text = userText(run.llm.calls[0][1].content);
  assert.ok(text.includes(`<wake>\n${labels.wake.header}`), text);
  assert.ok(text.includes('πες καλημέρα στο κανάλι'));
  assert.ok(text.includes(`<task>\n${INNER_TASK}\n</task>`));
  assert.ok(!text.includes('πρώτο'), 'innerLife.chatMessages bounds the slice');
  assert.ok(text.includes('τρίτο'));
  assert.equal(run.result.outcome, 'skip');
  assert.equal(run.result.reason, 'nothing-to-do');
});

test('inner turn: what she writes outside a call reaches nobody and is counted; the turn is silence', async () => {
  const run = await innerTurn({ answers: ['<msg>γεια σας</msg><react to="#2">👍</react>'] });
  assert.deepEqual(run.sends, []);
  assert.equal(run.result.outcome, 'skip');
  assert.equal(run.result.reason, 'nothing-to-do');
  assert.equal(run.result.inner.stray.messages, 1);
});

test('inner turn, shadow: a read runs, a post is only proposed and journalled as shadow, with no call mark', async () => {
  const { journal, lines } = journalOverMemory();
  const run = await innerTurn({ answers: ['<call skill="lore.list"/><call skill="message.create">καλημέρα σε όλους</call>', '<skip/>'], journal });
  assert.deepEqual(run.sends, [], 'nothing left the turn');
  assert.deepEqual(run.result.inner.actions.map((a) => `${a.skill}:${a.status}`), ['lore.list:executed', 'message.create:proposed']);
  assert.equal(run.result.shadow, true);
  assert.equal(run.posted.length, 0);
  assert.equal(run.llm.calls.length, 2, 'the read came back to her');
  const skillLines = lines.filter((l) => l.kind === 'action' && l.name === 'skill');
  const proposed = skillLines.filter((l) => l.input?.skill === 'message.create');
  assert.deepEqual(proposed.map((l) => l.phase), ['proposed']);
  assert.equal(proposed[0].shadow, true);
  // A shadow turn leaves no call mark at all, after a restart either: nobody saw it.
  assert.deepEqual(callMarksOf(lines).calls, []);
  const readOp = skillLines.find((l) => l.input?.skill === 'lore.list').opId;
  const read = skillLines.filter((l) => l.opId === readOp).map((l) => l.phase);
  assert.deepEqual(read, ['proposed', 'started', 'succeeded'], 'the read ran on her own initiative');
  const start = lines.find((l) => l.kind === 'turn.start');
  assert.equal(start.mode, 'inner');
  assert.equal(start.trigger.kind, 'inner');
});

test('inner turn, live: her post runs through the gateway on her own grant and counts as a public post', async () => {
  const run = await innerTurn({ answers: ['<call skill="message.create">καλημέρα σε όλους</call>'], shadow: false });
  assert.equal(run.sends.length, 1);
  assert.equal(run.sends[0].to, 'c1');
  assert.equal(run.sends[0].text, 'καλημέρα σε όλους');
  assert.deepEqual(run.result.inner.actions.map((a) => `${a.skill}:${a.status}`), ['message.create:executed']);
  assert.equal(run.posted.length, 1);
  assert.equal(run.result.outcome, 'spoke');
  assert.equal(run.result.delivered, true);
});

test('inner turn, live: a stop between her answer and the action refuses the action', async () => {
  let stopped = false;
  const run = await innerTurn({ answers: ['<call skill="message.create">καλημέρα</call>', '<skip/>'], shadow: false, gate: { mayAct: () => !stopped }, onCall: () => (stopped = true) });
  assert.deepEqual(run.sends, []);
  assert.deepEqual(run.result.inner.actions.map((a) => `${a.skill}:${a.status}:${a.code}`), ['message.create:refused:inner-stopped']);
});

test('inner turn, live: a public post past the day\'s cap is refused; a read still runs', async () => {
  const run = await innerTurn({ answers: ['<call skill="lore.list"/><call skill="message.create">καλημέρα</call>', '<skip/>'], shadow: false, gate: { postAllowed: () => false } });
  assert.deepEqual(run.sends, []);
  assert.deepEqual(run.result.inner.actions.map((a) => `${a.skill}:${a.status}`), ['lore.list:executed', 'message.create:refused']);
  assert.equal(run.result.inner.actions[1].code, 'inner-post-cap');
});

test('inner turn: an ordinary reply\'s request is the same with the inner life on or off', async () => {
  const requestOf = async (innerLife) => {
    const history = [rawMessage({ id: 'm1', content: 'γεια' })];
    const hot = hotWith({ features: { innerLife } });
    const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW });
    const client = { user: { id: 'self-id', username: 'Bot' }, channels: { cache: new Map() } };
    const llm = sequenceLlm(['<skip/>']);
    const calibrator = { ratio: 1, apply: (value) => value, observe: () => {} };
    const turns = createTurnRunner({ discord: DISCORD, hot, store: fakeStore(), llm, calibrator, client, now: () => NOW, port, skills: skillRegistry() });
    const trigger = { id: 'm1', channelId: 'c1', authorId: 'u1', authorName: 'Alice', self: false, bot: false, content: 'γεια', ts: NOW - 60_000, replyToId: null, attachments: [], stickers: [] };
    await withCapturedLogs(() => turns.runTurn({ channel: fakeChannel(history), mode: 'reply', trigger, triggerKind: 'mention' }));
    return llm.calls[0];
  };
  const off = await requestOf(false);
  const on = await requestOf(true);
  assert.deepEqual(on, off);
  assert.ok(!userText(off[1].content).includes('<wake>'));
});

test('gateway: with nobody asking only a read runs, unless the turn is her own initiative', () => {
  const config = { features: { skills: true }, bot: { owners: ['u1'], access: personaGrants(['lore.add']) }, skills: { safeMode: false } };
  const call = { skill: 'lore.add', args: { title: 'x', keys: 'x', text: 'y' }, principal: { kind: 'persona' }, requester: null, audience: { conversationId: 'c1' } };
  const unasked = checkSkill({ ...call, context: { config, selfId: 'self-id', registry: skillRegistry() } });
  assert.equal(unasked.ok, false);
  assert.equal(unasked.reason, 'no-requester');
  const own = checkSkill({ ...call, context: { config, selfId: 'self-id', registry: skillRegistry(), ownInitiative: true } });
  assert.notEqual(own.reason, 'no-requester');
  // Her grant still decides.
  const ungranted = checkSkill({ ...call, context: { config: { ...config, bot: { ...config.bot, access: {} } }, selfId: 'self-id', registry: skillRegistry(), ownInitiative: true } });
  assert.equal(ungranted.ok, false);
  assert.notEqual(ungranted.reason, 'no-requester');
});

test('wakeBlockText: the wake, the moment and the budgets as facts; none without its header', () => {
  const text = wakeBlockText({ ...WAKE, channels: ['général'] }, labels);
  const lines = text.split('\n');
  assert.equal(lines[0], labels.wake.header);
  assert.ok(lines.some((line) => line.startsWith('due: i1 πες καλημέρα')), text);
  assert.ok(lines.some((line) => line.startsWith('now: ')));
  assert.ok(lines.includes('recent channels: #général'));
  assert.ok(lines.includes('day 23/24 until 10/20/2026 12:00 AM') || lines.some((line) => line.startsWith('day 23/24 until ')), text);
  assert.ok(lines.includes('chain 3/3'));
  assert.equal(wakeBlockText(WAKE, { ...labels, wake: undefined }), '');
});

test('wakeLanes: the purposes of the intentions as one wake lane; none for a review alone', () => {
  assert.deepEqual(wakeLanes(['a', ' b ']), { lanes: [{ kind: 'wake', text: 'a\nb', words: 'a\nb' }], skip: null });
  assert.deepEqual(wakeLanes([]), { lanes: [], skip: 'no-trigger' });
});
