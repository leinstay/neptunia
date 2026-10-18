// Tests for the persona's own tools in a turn (features.coreTools, src/behavior/turn.js): off,
// every request of a turn is the snapshot of the engine before them; on, her calls run, the turn
// continues with what they gave back and a call in that continuation runs too (the tool loop,
// bounded by skills.loop), several reads of one answer run together. Over a real admin and the
// fake interface adapter (src/interface/fake.js); no network, no data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTurnRunner, loopSettings } from '../src/behavior/turn.js';
import { userText } from '../src/behavior/prompt.js';
import { fill } from '../src/format.js';
import { createFakeAdapter } from '../src/interface/fake.js';
import { createDiscordInterface } from '../src/interface/discord.js';
import { createJournal } from '../src/memory/journal.js';
import '../src/ops/index.js';
import { skillRegistry } from '../src/skills/registry.js';
import { createAdmin } from '../src/admin.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

const DISCORD = createDiscordInterface().capabilities;
const NOW = Date.parse('2026-10-17T12:00:00Z');

function rawMessage({ id, authorId = 'u1', authorName = 'Alice', ts = NOW - 1000, content = 'hey bot' }) {
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

function normalizedTrigger(raw) {
  return { id: raw.id, channelId: raw.channelId, authorId: raw.author.id, authorName: raw.author.globalName, self: false, bot: false, content: raw.cleanContent, ts: raw.createdTimestamp, replyToId: null, attachments: [], stickers: [] };
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
        if (arg && typeof arg === 'object' && 'limit' in arg) return new Map(historyMessages.map((m) => [m.id, m]));
        return historyMessages.find((m) => m.id === arg) ?? null;
      },
    },
  };
}

function fakeStore({ profiles = [] } = {}) {
  return {
    getGuild: () => ({}),
    getUser: (guildId, id) => profiles.find((profile) => profile.id === id) ?? null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => profiles,
    countUsers: () => profiles.length,
    getLore: () => [],
    getMediaCache: () => ({}),
    state: { data: {}, markDirty() {} },
  };
}

function hotWith({ features = {}, skills = {}, access = {}, config = {} } = {}) {
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
      features: { memory: true, reactions: true, multiMessage: true, typingSimulation: false, vision: false, followUpContinuation: true, callMarkers: true, ...features },
      models: { base: { analyzer: 'x/text', reasoner: 'x/reason' } },
      media: { maxPerTurn: 6, filePreviewChars: 500 },
      gifs: { maxPerDay: 40 },
      skills: { safeMode: false, resultMaxChars: 2000, callTimeoutMs: 120000, ...skills },
      ...config,
    },
    prompts: {
      'system-prompt': 'You are a regular member of this chat, not an assistant.',
      'character-card': 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      reply: 'Someone called you: {{author}}.',
      interject: 'Jump into the conversation.',
      initiate: 'Start a topic.',
      lookup: 'Decide whether {{name}} needs to look something up.',
      labels,
    },
  };
}

function personaGrants(names) {
  return Object.fromEntries(names.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }]));
}

/** An LLM answering `answers` in turn (the last one repeats); the search classifier answers `classifier` and is counted apart. */
function sequenceLlm(answers, classifier = 'none') {
  const calls = [];
  const classifierCalls = [];
  return {
    calls,
    classifierCalls,
    complete: async (messages) => {
      if (messages[0].content.startsWith('Decide whether')) {
        classifierCalls.push(messages);
        return { text: classifier, usage: {}, estimated: 5 };
      }
      calls.push(messages);
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
      return { text: answer, usage: {}, estimated: 10 };
    },
  };
}

function journalOverMemory() {
  const lines = [];
  const appendStore = { append: async (file, line) => lines.push({ file, record: JSON.parse(line) }), async *iterate() {} };
  let n = 0;
  const journal = createJournal({ appendStore, dataDir: 'fake-data', config: () => ({ thinkChars: 4000 }), now: () => NOW, uuid: () => `u${(n += 1)}` });
  return { journal, lines };
}

/**
 * One mention by Alice (u1, an owner) in #general (c1) answered with `answers` in turn, with the
 * tool loop on (`coreTools`) and `loop` as skills.loop; `allowed` skills granted to the persona;
 * `wrapCommand` wraps the admin's runCommand; `runner` and `adminExtra` go to the runner and the
 * admin as they are.
 */
async function coreTurn({ answers, allowed = ['lore.list', 'memory.server.read'], coreTools = true, loop = {}, features = {}, journal = null, wrapCommand = null, runner = {}, adminExtra = {}, store = fakeStore(), content = 'βρες κάτι', classifier = 'none', config = {} }) {
  const history = [rawMessage({ id: 'm0', ts: NOW - 5000, authorId: 'u2', authorName: 'Zoë', content: 'καλημέρα' }), rawMessage({ id: 'm1', content })];
  const hot = hotWith({
    features: { coreTools, journal: Boolean(journal), ...features },
    skills: { loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4, ...loop } },
    access: personaGrants(allowed),
    config,
  });
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW });
  port.seed('c1', { authorId: 'u2', messageId: 'm0', text: 'καλημέρα' });
  port.seed('c1', { authorId: 'u1', messageId: 'm1', text: content });
  const client = { user: { id: 'self-id', username: 'Bot' }, channels: { cache: new Map() } };
  const admin = createAdmin({ discord: DISCORD, hot, store, client, getGuildId: () => 'g1', port, ...adminExtra });
  const runCommand = wrapCommand ? wrapCommand(admin.runCommand) : admin.runCommand;
  const llm = sequenceLlm(answers, classifier);
  const calibrator = { ratio: 1, apply: (value) => value, observe: () => {} };
  const turns = createTurnRunner({ discord: DISCORD, hot, store, llm, calibrator, client, now: () => NOW, port, skills: skillRegistry(), journal, runCommand, runOwnCommand: admin.runOwnCommand, ...runner });
  const { result, logs } = await withCapturedLogs(() => turns.runTurn({ channel: fakeChannel(history), mode: 'reply', trigger: normalizedTrigger(history[1]), triggerKind: 'mention' }));
  const sends = port.calls.filter((call) => call.op === 'send').map((call) => ({ to: call.args[0].conversationId, ...call.args[1] }));
  return { result, logs, llm, sends, hot };
}

/** The user text of the turn's request `i`. */
function requestText(llm, i) {
  return userText(llm.calls[i][1].content);
}

/** The `<result skill status>` blocks of a request text, in order, as `skill:status`. */
function resultSkills(text) {
  return [...text.matchAll(/<result skill="([^"]+)" status="([^"]+)">/g)].map((match) => `${match[1]}:${match[2]}`);
}

test('core tools off: every request of the representative turns is the snapshot of the engine before the tool loop, the switch absent or false', async () => {
  const { coreToolsOffScenes } = await import('./fixtures/core-tools-scenes.js');
  const snapshot = JSON.parse(fs.readFileSync(new URL('./fixtures/core-tools-off.json', import.meta.url), 'utf8'));
  const load = (path) => import(new URL(`../${path}`, import.meta.url));
  for (const coreTools of [undefined, false]) {
    const { result } = await withCapturedLogs(() => coreToolsOffScenes(load, { coreTools }));
    assert.deepEqual(result, snapshot, `coreTools: ${coreTools}`);
  }
});

test('tool loop: a call in the continuation runs and the turn continues again, the results appended in order, the cached parts the reply\'s', async () => {
  const run = await coreTurn({ answers: ['<msg>κοιτάζω</msg><call skill="lore.list"/>', '<msg>και οι κανόνες</msg><call skill="memory.server.read"/>', '<msg>τέλος</msg>'] });
  assert.equal(run.result.outcome, 'spoke');
  assert.equal(run.llm.calls.length, 3, 'the reply, then two steps');
  assert.deepEqual(run.sends.map((send) => send.text), ['κοιτάζω', 'και οι κανόνες', 'τέλος']);
  const second = requestText(run.llm, 1);
  const third = requestText(run.llm, 2);
  assert.deepEqual(resultSkills(second), ['lore.list:ok']);
  assert.deepEqual(resultSkills(third), ['lore.list:ok', 'memory.server.read:ok'], 'the earlier result stays, the new one after it');
  assert.ok(second.includes(fill(labels.task.continueTools, { skill: 'lore.list' })), second);
  assert.ok(third.includes(fill(labels.task.continueTools, { skill: 'lore.list, memory.server.read' })), third);
  const first = run.llm.calls[0][1].content;
  for (const i of [1, 2]) {
    assert.deepEqual(run.llm.calls[i][0], run.llm.calls[0][0], 'the same system prompt');
    for (let part = 0; part < first.length - 1; part += 1) assert.deepEqual(run.llm.calls[i][1].content[part], first[part], 'the cached parts are the same');
  }
  // Her posts of both earlier steps are her lines of the last request's transcript.
  const chat = third.slice(third.indexOf('<chat>'), third.indexOf('</chat>'));
  assert.ok(chat.includes('κοιτάζω') && chat.includes('και οι κανόνες'), chat);
  const loop = run.logs.find((entry) => entry.msg === 'skills: loop');
  assert.deepEqual([loop.steps, loop.calls], [2, 2]);
  assert.ok(!run.logs.some((entry) => entry.msg === 'skills: extra-call'));
});

test('tool loop: several calls of one answer run together, both results come back in one step; past maxCallsPerStep the rest is dropped', async () => {
  const events = [];
  const wrapCommand = (runCommand) => async (key, args, context) => {
    events.push(`start:${key}`);
    await new Promise((resolve) => setImmediate(resolve));
    events.push(`end:${key}`);
    return runCommand(key, args, context);
  };
  const run = await coreTurn({ answers: ['<call skill="lore.list"/><call skill="memory.server.read"/>', '<msg>έτοιμο</msg>'], wrapCommand });
  assert.deepEqual(events, ['start:lore.list', 'start:memory.server', 'end:lore.list', 'end:memory.server'], 'the reads run alongside each other');
  assert.equal(run.llm.calls.length, 2);
  assert.deepEqual(resultSkills(requestText(run.llm, 1)), ['lore.list:ok', 'memory.server.read:ok']);
  assert.deepEqual(run.sends.map((send) => send.text), ['έτοιμο']);
  const capped = await coreTurn({ answers: ['<call skill="lore.list"/><call skill="memory.server.read"/>', '<msg>έτοιμο</msg>'], loop: { maxCallsPerStep: 1 } });
  assert.deepEqual(resultSkills(requestText(capped.llm, 1)), ['lore.list:ok']);
  assert.ok(capped.logs.some((entry) => entry.msg === 'skills: extra-call' && entry.loop === true && entry.count === 1));
});

test('tool loop: skills.loop.maxSteps -- the last step says no call will run, a call in it is dropped, logged and journaled as a limit', async () => {
  const { journal, lines } = journalOverMemory();
  const run = await coreTurn({ answers: ['<call skill="lore.list"/>', '<msg>ακόμα ένα</msg><call skill="memory.server.read"/>', '<msg>ποτέ</msg>'], loop: { maxSteps: 1 }, journal });
  assert.equal(run.llm.calls.length, 2, 'no request after the last step');
  const last = requestText(run.llm, 1);
  assert.ok(last.includes(fill(labels.task.continueToolsLast, { skill: 'lore.list' })), last);
  assert.deepEqual(run.sends.map((send) => send.text), ['ακόμα ένα'], 'the rest of her answer is acted on');
  assert.ok(!run.logs.some((entry) => entry.msg === 'skills: called' && entry.skill === 'memory.server.read'), 'the dropped call never runs');
  const cap = run.logs.find((entry) => entry.msg === 'skills: loop cap');
  assert.deepEqual([cap.reason, cap.dropped, cap.step], ['steps', 1, 1]);
  const turn = lines.map(({ record }) => record).find((record) => record.kind === 'turn');
  assert.ok(turn.limits.some((limit) => limit.kind === 'loop-cap' && limit.detail === 'steps' && limit.lost === 1), JSON.stringify(turn.limits));
});

test('tool loop: skills.loop.timeBudgetMs spent -- the next request is her last, its call dropped with reason time', async () => {
  let ms = NOW;
  const run = await coreTurn({ answers: ['<call skill="lore.list"/>', '<msg>αργά</msg><call skill="memory.server.read"/>'], loop: { timeBudgetMs: 50 }, runner: { now: () => (ms += 30) } });
  assert.equal(run.llm.calls.length, 2);
  assert.ok(requestText(run.llm, 1).includes(fill(labels.task.continueToolsLast, { skill: 'lore.list' })));
  assert.equal(run.logs.find((entry) => entry.msg === 'skills: loop cap')?.reason, 'time');
  assert.deepEqual(run.sends.map((send) => send.text), ['αργά']);
});

test('tool loop off: a call in the follow-up is dropped as before, one follow-up only', async () => {
  const run = await coreTurn({ coreTools: false, answers: ['<call skill="lore.list"/>', '<msg>ένα</msg><call skill="memory.server.read"/>', '<msg>ποτέ</msg>'] });
  assert.equal(run.llm.calls.length, 2);
  assert.ok(run.logs.some((entry) => entry.msg === 'skills: extra-call' && entry.followUp === true));
  assert.ok(!run.logs.some((entry) => entry.msg === 'skills: loop'));
});

test('loopSettings: a missing or unusable value takes config.json\'s', () => {
  const tracked = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8')).skills.loop;
  assert.deepEqual(loopSettings({}), tracked);
  assert.deepEqual(loopSettings({ skills: { loop: { maxSteps: 0, timeBudgetMs: -1, maxCallsPerStep: 1.5 } } }), tracked);
  assert.deepEqual(loopSettings({ skills: { loop: { maxSteps: 5, timeBudgetMs: 900, maxCallsPerStep: 2 } } }), { maxSteps: 5, timeBudgetMs: 900, maxCallsPerStep: 2 });
});
