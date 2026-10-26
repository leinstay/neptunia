// Tests for the persona's view of her errands in a turn (src/errands/blocks.js, src/behavior/turn.js)
// and the turn an errand's end opens (src/errands/turns.js): the `<tasks>` block is in the
// request's tail while she has an open or newly finished errand and gone when she has none; a
// finished errand opens her own turn in the conversation it was asked in, with `<task_result>`
// (its text, its sources numbered, its files as handles), through the fake interface
// (src/interface/fake.js); a turn held back by the attention is tried again later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRunner as createRealTurnRunner } from '../src/behavior/turn.js';
import { userText } from '../src/behavior/prompt.js';
import { createFakeAdapter } from '../src/interface/fake.js';
import { tasksBlockText, taskResultText } from '../src/errands/blocks.js';
import { createTaskTurns, taskCompletedEvent } from '../src/errands/turns.js';
import { createEventDoor } from '../src/interface/door.js';
import { validateEvent } from '../src/protocol/index.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { onWorld, useIface, world } from './fixtures/turn-world.ts';

// The conversations are held by a fake interface named `fake`.
useIface('fake');
const createTurnRunner = onWorld(createRealTurnRunner);

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

/** A channel of guild g1 whose history is `historyMessages`; `fetch(id)` gives one of them. */
function fakeChannel({ historyMessages = [] } = {}) {
  return world().channel({ id: 'c1', name: 'general', guildId: 'g1', historyMessages });
}

function fakeStore() {
  return {
    getGuild: () => ({}),
    getUser: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    state: { data: {}, markDirty() {} },
  };
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
        vision: {
          maxImages: 2,
          tokensPerImage: 400,
          imageSize: 512,
          recentImages: 0,
          recentImageMinutes: 0,
          maxBytes: 1_500_000,
          fetchTimeoutMs: 10_000,
        },
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
  const read = [];
  const failed = [];
  return {
    tasks,
    seen,
    read,
    failed,
    view: () => tasks,
    markSeen: ({ guildId, ids }) => seen.push({ guildId, ids }),
    markRead: ({ guildId, ids }) => read.push({ guildId, ids }),
    markResultFailed: ({ guildId, ids }) => failed.push({ guildId, ids }),
    budget: () => ({ spent: false }),
    fileOf: () => null,
  };
}

const runningTask = {
  id: 'tab01',
  agent: 'scout',
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
  agent: 'scout',
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
  assert.ok(line.startsWith('tab01 | scout | running | 7 min | find the release notes'));
  assert.ok(line.length < 200, 'the goal is cut to 120 characters');
  assert.equal(tasksBlockText([], labels, { now: NOW }), '');
  assert.equal(tasksBlockText([runningTask], {}, { now: NOW }), '');
  const result = taskResultText(doneTask, labels, { maxChars: 30 }).split('\n');
  assert.equal(result[0], 'errand tab02 (scout) ended done: find a meme');
  assert.equal(result[1], labels.tasks.result.text);
  assert.ok(result[2].length <= 31, 'the result text cut to maxChars');
  assert.deepEqual(result.slice(3), [
    'sources:',
    '1. https://example.org/board/1',
    '2. https://example.org/board/2',
    'files:',
    'file:tab02/meme.png | image/png | 2048 bytes',
  ]);
  const failed = taskResultText({ ...doneTask, state: 'failed', error: 'withheld-path', result: null }, labels).split(
    '\n'
  );
  assert.deepEqual(failed, [
    'errand tab02 (scout) ended failed: find a meme',
    'no result text',
    'error: withheld-path',
  ]);
  assert.equal(taskResultText(doneTask, {}), '');
});

test('tasksBlockText / taskResultText: expired files show the expired state word and no handle', () => {
  const expired = { ...doneTask, filesExpired: true };
  const withWord = {
    ...labels,
    tasks: { ...labels.tasks, states: { ...labels.tasks.states, expired: 'done, files gone' } },
  };
  assert.ok(
    tasksBlockText([expired], withWord, { now: NOW })
      .split('\n')[1]
      .startsWith('tab02 | scout | done, files gone | 3 min')
  );
  const result = taskResultText(expired, withWord).split('\n');
  assert.equal(result[0], 'errand tab02 (scout) ended done, files gone: find a meme');
  assert.ok(
    !result.includes('files:') && !result.some((line) => line.startsWith('file:')),
    'no handle of an expired file'
  );
  // Without the label, the state's own word.
  assert.ok(tasksBlockText([expired], labels, { now: NOW }).split('\n')[1].startsWith('tab02 | scout | done | 3 min'));
  assert.equal(taskResultText(expired, labels).split('\n')[0], 'errand tab02 (scout) ended done: find a meme');
});

test('taskResultText: the withheld paths close the block in labels.tasks.result.withheld; without the label, no line', () => {
  const withheld = { ...doneTask, result: { ...doneTask.result, withheld: ['/etc/shadow', '/srv/app/.env'] } };
  const withLabel = {
    ...labels,
    tasks: { ...labels.tasks, result: { ...labels.tasks.result, withheld: 'not readable here: {paths}' } },
  };
  const lines = taskResultText(withheld, withLabel).split('\n');
  assert.equal(lines.at(-1), 'not readable here: /etc/shadow, /srv/app/.env');
  assert.equal(lines.at(-2), 'file:tab02/meme.png | image/png | 2048 bytes', 'after the text and the files');
  const without = taskResultText(withheld, labels).split('\n');
  assert.equal(without.at(-1), 'file:tab02/meme.png | image/png | 2048 bytes');
  assert.equal(taskResultText(doneTask, withLabel), taskResultText(doneTask, labels), 'no withheld path, no line');
  const failed = taskResultText(
    { ...withheld, state: 'failed', error: 'withheld-path', result: { text: '', withheld: ['/etc/shadow'] } },
    withLabel
  ).split('\n');
  assert.deepEqual(failed, [
    'errand tab02 (scout) ended failed: find a meme',
    'no result text',
    'error: withheld-path',
    'not readable here: /etc/shadow',
  ]);
});

test('taskResultText: the files the runner held back follow the withheld line in labels.tasks.result.held, with no handle; without the label, no line', () => {
  const held = {
    ...doneTask,
    result: { ...doneTask.result, withheld: ['/etc/shadow'], filesDropped: [{ name: 'x.env', reason: 'secret' }] },
  };
  const withLabels = {
    ...labels,
    tasks: {
      ...labels.tasks,
      result: { ...labels.tasks.result, withheld: 'not readable here: {paths}', held: 'not delivered: {names}' },
    },
  };
  const lines = taskResultText(held, withLabels).split('\n');
  assert.deepEqual(lines.slice(-2), ['not readable here: /etc/shadow', 'not delivered: x.env']);
  assert.ok(!lines.some((line) => line.includes('file:tab02/x.env')), 'no handle for a held-back file');
  const names = { ...held, result: { ...held.result, filesDropped: ['x.env', 'id_rsa', '', 7] } };
  assert.equal(
    taskResultText(names, withLabels).split('\n').at(-1),
    'not delivered: x.env, id_rsa',
    'the record keeps names'
  );
  const noLabel = { ...labels, tasks: { ...labels.tasks, result: { ...labels.tasks.result, held: undefined } } };
  assert.ok(!taskResultText(held, noLabel).includes('x.env'));
  assert.equal(
    taskResultText({ ...held, result: { ...held.result, filesDropped: [] } }, withLabels)
      .split('\n')
      .at(-1),
    'not readable here: /etc/shadow',
    'none held, no line'
  );
});

test('<tasks>: an open errand is in the request tail; with none, the block is gone', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeChannel({ historyMessages: [raw] });
  const errands = fakeErrands([runningTask]);
  const llm = fakeLlm('<skip/>');
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id' });
  const turns = createTurnRunner({
    hot: fakeHot(),
    store: fakeStore(),
    llm,
    calibrator: { ratio: 1, apply: (n) => n, observe: () => {} },
    port,
    errands,
    now: () => NOW,
  });
  await withCapturedLogs(async () => {
    const first = await turns.runTurn({
      channel,
      mode: 'reply',
      trigger: normalizedTrigger(raw),
      triggerKind: 'mention',
    });
    assert.equal(first.outcome, 'skip');
    const text = userText(llm.calls[0][1].content);
    assert.ok(
      text.includes(`<tasks>\n${labels.tasks.header}\ntab01 | scout | running | 7 min | find the release notes`),
      'the block with its line'
    );
    const tail = llm.calls[0][1].content.at(-1);
    assert.equal(tail.cacheSegment, undefined, 'in the tail, never a cached part');
    assert.ok(tail.text.indexOf('<tasks>') < tail.text.indexOf('<chat>'), 'before the chat');
    assert.deepEqual(errands.seen, [], 'an open errand is not marked seen');
    errands.tasks.length = 0;
    await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
    assert.equal(userText(llm.calls[1][1].content).includes('<tasks>'), false, 'no errand, no block');
  });
});

test('<tasks>: a finished errand she has not read is listed with its marker and nothing is marked by showing it', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeChannel({ historyMessages: [raw] });
  const errands = fakeErrands([runningTask, doneTask]);
  const llm = fakeLlm('<skip/>');
  const turns = createTurnRunner({
    hot: fakeHot(),
    store: fakeStore(),
    llm,
    calibrator: { ratio: 1, apply: (n) => n, observe: () => {} },
    port: createFakeAdapter({ iface: 'fake', selfId: 'self-id' }),
    errands,
    now: () => NOW,
  });
  await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' })
  );
  assert.ok(userText(llm.calls[0][1].content).includes('tab02 | scout | done | 3 min | find a meme [unread]'));
  assert.deepEqual(errands.seen, [], 'appearing in <tasks> marks nothing');
  assert.deepEqual(errands.read, []);
});

test('task turns: a finished errand opens her turn where it was asked, with <task_result>, through the interface', async () => {
  const raw = rawMessage({ id: 'm1', content: 'βρες μου ένα meme' });
  fakeChannel({ historyMessages: [raw] });
  const errands = fakeErrands([doneTask]);
  const llm = fakeLlm('<msg reply="#1">βρήκα κάτι</msg>');
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id' });
  const hot = fakeHot();
  const turns = createTurnRunner({
    hot,
    store: fakeStore(),
    llm,
    calibrator: { ratio: 1, apply: (n) => n, observe: () => {} },
    port,
    errands,
    now: () => NOW,
  });
  const taskTurns = createTaskTurns({
    hot,
    reads: world().reads,
    iface: () => 'fake',
    turns,
    errands,
    getGuildId: () => 'g1',
    now: () => NOW,
  });
  const { result } = await withCapturedLogs(() => taskTurns.onFinished(doneTask, 'g1'));
  assert.equal(result.outcome, 'spoke');
  assert.equal(llm.calls.length, 1);
  const text = userText(llm.calls[0][1].content);
  assert.ok(
    text.includes('<task_result>\nerrand tab02 (scout) ended done: find a meme\nresult:\n'),
    'the block, its header first'
  );
  assert.ok(
    text.includes('sources:\n1. https://example.org/board/1\n2. https://example.org/board/2'),
    'the sources numbered'
  );
  assert.ok(text.includes('files:\nfile:tab02/meme.png | image/png | 2048 bytes'), 'the file as its handle');
  assert.ok(!text.includes('posted this morning'), 'the text cut to agents.resultMaxChars');
  assert.equal(text.includes('<tasks>'), false, 'the errand of this turn is not listed twice');
  const sends = port.calls.filter((call) => call.op === 'send');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].args[1].text, 'βρήκα κάτι');
  assert.deepEqual(
    sends[0].args[1].replyTo,
    { iface: 'fake', conversationId: 'c1', messageId: 'm1' },
    'her answer replies to the message that asked'
  );
  assert.deepEqual(errands.seen.at(-1), { guildId: 'g1', ids: ['tab02'] });
});

test('task turns: held back while the attention is taken, tried again after agents.resultRetrySeconds', async () => {
  const runs = [];
  let busy = true;
  const turns = {
    isBusy: () => false,
    isAnyBusy: () => busy,
    runTurn: async (params) => {
      runs.push(params);
      return { outcome: 'skip' };
    },
  };
  const timers = [];
  const errands = fakeErrands();
  fakeChannel({ historyMessages: [rawMessage({ id: 'm1' })] });
  const taskTurns = createTaskTurns({
    hot: fakeHot(),
    reads: world().reads,
    iface: () => 'fake',
    turns,
    errands,
    now: () => NOW,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
  });
  await withCapturedLogs(async () => {
    await taskTurns.onFinished(doneTask, 'g1');
    assert.equal(runs.length, 0, 'nothing runs while a turn holds the attention');
    assert.deepEqual(
      timers.map((t) => t.ms),
      [30_000]
    );
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

test('task turns: an errand end enters through the event door as task.completed, once, and opens the same turn', async () => {
  const runs = [];
  const turns = {
    isBusy: () => false,
    isAnyBusy: () => false,
    runTurn: async (params) => {
      runs.push(params);
      return { outcome: 'spoke' };
    },
  };
  fakeChannel({ historyMessages: [rawMessage({ id: 'm1' })] });
  const errands = fakeErrands();
  const taskTurns = createTaskTurns({
    hot: fakeHot(),
    reads: world().reads,
    iface: () => 'fake',
    turns,
    errands,
    now: () => NOW,
  });
  const door = createEventDoor({ handlers: { 'task.completed': (event) => taskTurns.onEvent(event) } });
  const event = taskCompletedEvent(doneTask, 'g1', () => NOW);
  assert.deepEqual(validateEvent(event), { ok: true });
  assert.deepEqual(
    { ...event, raw: undefined },
    { kind: 'task.completed', at: NOW, communityId: 'g1', taskId: 'tab02', status: 'done', raw: undefined }
  );
  const first = await withCapturedLogs(() => door.submit(event));
  assert.equal(first.result.status, 'ok');
  assert.deepEqual(
    (await door.submit(taskCompletedEvent(doneTask, 'g1', () => NOW + 5))).status,
    'duplicate',
    'the same end delivered twice runs no second turn'
  );
  assert.equal(runs.length, 1);
  assert.equal(runs[0].triggerKind, 'task');
  assert.equal(runs[0].taskResult.id, 'tab02');
  assert.deepEqual(errands.seen, [{ guildId: 'g1', ids: ['tab02'] }]);
});

test("task turns: an event without the task in hand asks the guild's task store; an unknown task opens nothing", async () => {
  const runs = [];
  const turns = {
    isBusy: () => false,
    isAnyBusy: () => false,
    runTurn: async (params) => {
      runs.push(params);
      return { outcome: 'spoke' };
    },
  };
  fakeChannel({ historyMessages: [rawMessage({ id: 'm1' })] });
  const errands = {
    ...fakeErrands(),
    store: (guildId) => (guildId === 'g1' ? { get: (id) => (id === 'tab02' ? doneTask : null) } : null),
  };
  const taskTurns = createTaskTurns({
    hot: fakeHot(),
    reads: world().reads,
    iface: () => 'fake',
    turns,
    errands,
    now: () => NOW,
  });
  const { raw: _raw, ...bare } = taskCompletedEvent(doneTask, 'g1', () => NOW);
  await withCapturedLogs(async () => {
    assert.equal(await taskTurns.onEvent({ ...bare, taskId: 'nope' }), null);
    assert.equal(runs.length, 0);
    await taskTurns.onEvent(bare);
  });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].taskResult.id, 'tab02');
});

/** Let the promises a fired timer started run. */
async function flush() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('tasksBlockText: unread results carry the marker, the error code and the failed-turn note; the cap counts the rest', () => {
  const withError = { ...labels, tasks: { ...labels.tasks, line: '{id} | {state} {error} | {goal}' } };
  const failed = { ...doneTask, id: 'tab03', state: 'failed', error: 'timeout', resultTurnFailed: true, result: null };
  const lines = tasksBlockText([runningTask, failed], withError, { now: NOW }).split('\n');
  assert.ok(lines[1].startsWith('tab01 | running  | find the release notes'));
  assert.ok(!lines[1].includes('[unread]'));
  assert.equal(lines[2], 'tab03 | failed timeout | find a meme [unread] [result turn failed]');
  const many = ['a1', 'a2', 'a3', 'a4'].map((id, i) => ({ ...doneTask, id, createdAt: NOW - (10 - i) * MINUTE }));
  const capped = tasksBlockText([runningTask, ...many], labels, { now: NOW, unreadShown: 2 }).split('\n');
  assert.deepEqual(capped.map((line) => line.split(' | ')[0]).slice(1), ['tab01', 'a1', 'a2', '[2 more unread]']);
  const noMore = tasksBlockText(
    many,
    { ...labels, tasks: { ...labels.tasks, unreadMore: undefined } },
    { now: NOW, unreadShown: 1 }
  ).split('\n');
  assert.equal(noMore.length, 2, 'without the label, no count line');
  assert.equal(tasksBlockText(many, labels, { now: NOW }).split('\n').length, 5, 'the default shows five or fewer');
  assert.equal(
    tasksBlockText(
      Array.from({ length: 7 }, (_, i) => ({ ...doneTask, id: `b${i}` })),
      labels,
      { now: NOW }
    )
      .split('\n')
      .at(-1),
    '[2 more unread]'
  );
});

test('task turns: a result turn that spoke or chose silence marks the task seen and read', async () => {
  for (const outcome of ['spoke', 'skip']) {
    const errands = fakeErrands();
    const turns = { isBusy: () => false, isAnyBusy: () => false, runTurn: async () => ({ outcome }) };
    fakeChannel({ historyMessages: [rawMessage({ id: 'm1' })] });
    const taskTurns = createTaskTurns({
      hot: fakeHot(),
      reads: world().reads,
      iface: () => 'fake',
      turns,
      errands,
      now: () => NOW,
      setTimer: () => null,
    });
    await withCapturedLogs(() => taskTurns.onFinished(doneTask, 'g1'));
    assert.deepEqual(errands.seen, [{ guildId: 'g1', ids: ['tab02'] }], outcome);
    assert.deepEqual(errands.read, [{ guildId: 'g1', ids: ['tab02'] }], outcome);
  }
});

test('task turns: a result turn that ended error or refused marks nothing and is tried again; a rehearsal marks nothing and is not retried', async () => {
  const outcomes = [{ outcome: 'error' }, { outcome: 'refused' }, { outcome: 'spoke' }];
  const runs = [];
  const turns = {
    isBusy: () => false,
    isAnyBusy: () => false,
    runTurn: async (params) => {
      runs.push(params);
      return outcomes[runs.length - 1];
    },
  };
  const timers = [];
  const errands = fakeErrands();
  fakeChannel({ historyMessages: [rawMessage({ id: 'm1' })] });
  const taskTurns = createTaskTurns({
    hot: fakeHot(),
    reads: world().reads,
    iface: () => 'fake',
    turns,
    errands,
    now: () => NOW,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
  });
  await withCapturedLogs(async () => {
    await taskTurns.onFinished(doneTask, 'g1');
    assert.deepEqual(
      [errands.seen.length, errands.read.length, timers.length],
      [0, 0, 1],
      'error: nothing marked, a retry waits'
    );
    timers.shift().fn();
    await flush();
    assert.deepEqual([errands.seen.length, errands.read.length, timers.length], [0, 0, 1], 'refused: the same');
    timers.shift().fn();
    await flush();
  });
  assert.equal(runs.length, 3);
  assert.deepEqual(errands.read, [{ guildId: 'g1', ids: ['tab02'] }], 'the third try spoke: read');
  const dry = fakeErrands();
  const dryTurns = createTaskTurns({
    hot: fakeHot(),
    reads: world().reads,
    iface: () => 'fake',
    turns: { isBusy: () => false, isAnyBusy: () => false, runTurn: async () => ({ outcome: 'spoke', dryRun: true }) },
    errands: dry,
    now: () => NOW,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
  });
  await withCapturedLogs(() => dryTurns.onFinished(doneTask, 'g1'));
  assert.deepEqual([dry.seen, dry.read, timers.length], [[], [], 0]);
});

test('task turns: after the attempts a result that never got its turn stays unread and is noted as failed', async () => {
  const turns = { isBusy: () => false, isAnyBusy: () => false, runTurn: async () => ({ outcome: 'error' }) };
  const timers = [];
  const errands = fakeErrands();
  fakeChannel({ historyMessages: [rawMessage({ id: 'm1' })] });
  const taskTurns = createTaskTurns({
    hot: fakeHot(),
    reads: world().reads,
    iface: () => 'fake',
    turns,
    errands,
    now: () => NOW,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
  });
  await withCapturedLogs(async () => {
    await taskTurns.onFinished(doneTask, 'g1');
    for (let i = 0; i < 40 && timers.length > 0; i += 1) {
      timers.shift().fn();
      await flush();
    }
  });
  assert.deepEqual([errands.seen, errands.read], [[], []]);
  assert.deepEqual(errands.failed, [{ guildId: 'g1', ids: ['tab02'] }]);
});
