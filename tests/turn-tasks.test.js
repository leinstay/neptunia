// Tests for the persona's view of her errands in a turn (src/errands/blocks.js, src/behavior/turn.js)
// and the turn an errand's end opens (src/errands/turns.js): the `<tasks>` block is in the
// request's tail while she has an open or newly finished errand and gone when she has none; a
// finished errand opens her own turn in the conversation it was asked in, with `<task_result>`
// (its text, its sources numbered, its files as handles), through the fake interface
// (src/interface/fake.js); a turn held back by the attention is tried again later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRunner } from '../src/behavior/turn.js';
import { userText } from '../src/behavior/prompt.js';
import { createFakeAdapter } from '../src/interface/fake.js';
import { tasksBlockText, taskResultText } from '../src/errands/blocks.js';
import { createTaskTurns } from '../src/errands/turns.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const MINUTE = 60_000;

/** A discord.js-shaped raw message, just enough for normalizeMessage. */
function rawMessage({ id, authorId = 'u1', authorName = 'Zoë', ts = NOW - 10 * MINUTE, content = 'βρες μου κάτι' }) {
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

/** A channel of guild g1 whose history is `historyMessages`; `fetch(id)` gives one of them. */
function fakeChannel({ historyMessages = [] } = {}) {
  const guild = { id: 'g1', members: { me: { displayName: 'Bot' } }, channels: { cache: new Map() } };
  return {
    id: 'c1',
    name: 'general',
    guild,
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

function fakeStore() {
  return { getGuild: () => ({}), getUser: () => null, listChannels: () => [], listUserProfiles: () => [], getLore: () => [], state: { data: {}, markDirty() {} } };
}

function fakeHot() {
  return {
    config: {
      bot: { timezone: 'UTC', dryRunChannelId: '' },
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
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      features: { typingSimulation: false },
      media: { maxPerTurn: 6, filePreviewChars: 500 },
      mention: { oneAtATime: true },
      agents: { resultMaxChars: 40, resultCooldownSeconds: 60, resultRetrySeconds: 30 },
    },
    prompts: {
      'system-prompt': 'You are a regular member of this chat, not an assistant.',
      'character-card': 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      reply: 'Someone called you: {{author}}.',
      interject: 'Jump into the conversation.',
      initiate: 'Start a topic.',
      labels,
    },
  };
}

function fakeLlm(responseText) {
  const calls = [];
  return {
    calls,
    complete: async (messages) => {
      calls.push(messages);
      return { text: responseText, usage: {}, estimated: 10 };
    },
  };
}

/** The errand service as the turn sees it: `view` lists `tasks`, `markSeen` is recorded. */
function fakeErrands(tasks = []) {
  const seen = [];
  return {
    tasks,
    seen,
    view: () => tasks,
    markSeen: ({ guildId, ids }) => seen.push({ guildId, ids }),
    budget: () => ({ spent: false }),
    fileOf: () => null,
  };
}

const runningTask = {
  id: 'tab01',
  agent: 'web',
  goal: `find the release notes of the new version ${'and more '.repeat(20)}`,
  state: 'running',
  createdAt: NOW - 7 * MINUTE,
  origin: { channelId: 'c1', messageId: 'm1' },
  requester: { userId: 'u1', kind: 'member' },
  scope: 'group',
  result: null,
  error: null,
};

const doneTask = {
  id: 'tab02',
  agent: 'web',
  goal: 'find a meme',
  state: 'done',
  createdAt: NOW - 3 * MINUTE,
  origin: { channelId: 'c1', messageId: 'm1' },
  requester: { userId: 'u1', kind: 'member' },
  scope: 'group',
  result: {
    text: 'Found one on a public board; it is about cats and keyboards, posted this morning.',
    sources: ['https://example.org/board/1', 'https://example.org/board/2'],
    files: [{ path: '/elsewhere/meme.png', name: 'meme.png', contentType: 'image/png', bytes: 2048 }],
  },
  error: null,
  usage: { usd: 0.02, steps: 4 },
};

test('tasksBlockText / taskResultText: every word from labels.tasks; none without tasks or labels', () => {
  const text = tasksBlockText([runningTask], labels, { now: NOW });
  const [header, line] = text.split('\n');
  assert.equal(header, labels.tasks.header);
  assert.ok(line.startsWith('tab01 | web | running | 7 min | find the release notes'));
  assert.ok(line.length < 200, 'the goal is cut to 120 characters');
  assert.equal(tasksBlockText([], labels, { now: NOW }), '');
  assert.equal(tasksBlockText([runningTask], {}, { now: NOW }), '');
  const result = taskResultText(doneTask, labels, { maxChars: 30 }).split('\n');
  assert.equal(result[0], 'errand tab02 (web) ended done: find a meme');
  assert.equal(result[1], labels.tasks.result.text);
  assert.ok(result[2].length <= 31, 'the result text cut to maxChars');
  assert.deepEqual(result.slice(3), ['sources:', '1. https://example.org/board/1', '2. https://example.org/board/2', 'files:', 'file:tab02/meme.png | image/png | 2048 bytes']);
  const failed = taskResultText({ ...doneTask, state: 'failed', error: 'withheld-path', result: null }, labels).split('\n');
  assert.deepEqual(failed, ['errand tab02 (web) ended failed: find a meme', 'no result text', 'error: withheld-path']);
  assert.equal(taskResultText(doneTask, {}), '');
});

test('<tasks>: an open errand is in the request tail; with none, the block is gone', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeChannel({ historyMessages: [raw] });
  const errands = fakeErrands([runningTask]);
  const llm = fakeLlm('<skip/>');
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id' });
  const turns = createTurnRunner({ hot: fakeHot(), store: fakeStore(), llm, calibrator: { ratio: 1, apply: (n) => n, observe: () => {} }, client: { user: { id: 'self-id', username: 'Bot' } }, port, errands, now: () => NOW });
  await withCapturedLogs(async () => {
    const first = await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
    assert.equal(first.outcome, 'skip');
    const text = userText(llm.calls[0][1].content);
    assert.ok(text.includes(`<tasks>\n${labels.tasks.header}\ntab01 | web | running | 7 min | find the release notes`), 'the block with its line');
    const tail = llm.calls[0][1].content.at(-1);
    assert.equal(tail.cacheSegment, undefined, 'in the tail, never a cached part');
    assert.ok(tail.text.indexOf('<tasks>') < tail.text.indexOf('<chat>'), 'before the chat');
    assert.deepEqual(errands.seen, [], 'an open errand is not marked seen');
    errands.tasks.length = 0;
    await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
    assert.equal(userText(llm.calls[1][1].content).includes('<tasks>'), false, 'no errand, no block');
  });
});

test('<tasks>: a finished errand she has not seen is marked seen once a turn of hers showed it', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeChannel({ historyMessages: [raw] });
  const errands = fakeErrands([runningTask, doneTask]);
  const llm = fakeLlm('<skip/>');
  const turns = createTurnRunner({ hot: fakeHot(), store: fakeStore(), llm, calibrator: { ratio: 1, apply: (n) => n, observe: () => {} }, client: { user: { id: 'self-id', username: 'Bot' } }, port: createFakeAdapter({ iface: 'fake', selfId: 'self-id' }), errands, now: () => NOW });
  await withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' }));
  assert.ok(userText(llm.calls[0][1].content).includes('tab02 | web | done | 3 min | find a meme'));
  assert.deepEqual(errands.seen, [{ guildId: 'g1', ids: ['tab02'] }]);
});

test('task turns: a finished errand opens her turn where it was asked, with <task_result>, through the interface', async () => {
  const raw = rawMessage({ id: 'm1', content: 'βρες μου ένα meme' });
  const channel = fakeChannel({ historyMessages: [raw] });
  const errands = fakeErrands([doneTask]);
  const llm = fakeLlm('<msg reply="#1">βρήκα κάτι</msg>');
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id' });
  const hot = fakeHot();
  const client = { user: { id: 'self-id', username: 'Bot' }, channels: { fetch: async (id) => (id === 'c1' ? channel : null) } };
  const turns = createTurnRunner({ hot, store: fakeStore(), llm, calibrator: { ratio: 1, apply: (n) => n, observe: () => {} }, client, port, errands, now: () => NOW });
  const taskTurns = createTaskTurns({ hot, client, turns, errands, getGuildId: () => 'g1', now: () => NOW });
  const { result } = await withCapturedLogs(() => taskTurns.onFinished(doneTask, 'g1'));
  assert.equal(result.outcome, 'spoke');
  assert.equal(llm.calls.length, 1);
  const text = userText(llm.calls[0][1].content);
  assert.ok(text.includes('<task_result>\nerrand tab02 (web) ended done: find a meme\nresult:\n'), 'the block, its header first');
  assert.ok(text.includes('sources:\n1. https://example.org/board/1\n2. https://example.org/board/2'), 'the sources numbered');
  assert.ok(text.includes('files:\nfile:tab02/meme.png | image/png | 2048 bytes'), 'the file as its handle');
  assert.ok(!text.includes('posted this morning'), 'the text cut to agents.resultMaxChars');
  assert.equal(text.includes('<tasks>'), false, 'the errand of this turn is not listed twice');
  const sends = port.calls.filter((call) => call.op === 'send');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].args[1].text, 'βρήκα κάτι');
  assert.deepEqual(sends[0].args[1].replyTo, { iface: 'fake', conversationId: 'c1', messageId: 'm1' }, 'her answer replies to the message that asked');
  assert.deepEqual(errands.seen.at(-1), { guildId: 'g1', ids: ['tab02'] });
});

test('task turns: held back while the attention is taken, tried again after agents.resultRetrySeconds', async () => {
  const runs = [];
  let busy = true;
  const turns = { isBusy: () => false, isAnyBusy: () => busy, runTurn: async (params) => { runs.push(params); return { outcome: 'skip' }; } };
  const timers = [];
  const errands = fakeErrands();
  const channel = fakeChannel({ historyMessages: [rawMessage({ id: 'm1' })] });
  const client = { user: { id: 'self-id' }, channels: { fetch: async () => channel } };
  const taskTurns = createTaskTurns({ hot: fakeHot(), client, turns, errands, now: () => NOW, setTimer: (fn, ms) => timers.push({ fn, ms }) });
  await withCapturedLogs(async () => {
    await taskTurns.onFinished(doneTask, 'g1');
    assert.equal(runs.length, 0, 'nothing runs while a turn holds the attention');
    assert.deepEqual(timers.map((t) => t.ms), [30_000]);
    busy = false;
    timers.shift().fn();
    for (let i = 0; i < 50 && runs.length === 0; i += 1) await new Promise((r) => setImmediate(r));
  });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].triggerKind, 'task');
  assert.equal(runs[0].mode, 'reply');
  assert.equal(runs[0].trigger.id, 'm1');
  assert.equal(runs[0].taskResult.id, 'tab02');
  assert.deepEqual(runs[0].requester, { id: 'u1' });
  assert.deepEqual(errands.seen, [{ guildId: 'g1', ids: ['tab02'] }]);
});
