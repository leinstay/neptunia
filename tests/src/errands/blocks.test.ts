// Tests for src/errands/blocks.ts: the `<errands>` block of a request and the `<errand_result>` of a result turn,
// every word from labels.errands, a long result summarized once, and the files a result names.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { errandsBlockText, errandResultText } from '../../../src/errands/blocks.ts';

import { labels } from '../../fixtures/labels.ts';

import { useIface, world } from '../../fixtures/turn-world.ts';
import { userText } from '../../../src/behavior/prompt.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { createTurnRunner } from '../../fixtures/turn-runner.ts';
import type { Untyped } from '../../../src/tools/types.ts';

// The casts through `Parameters<typeof f>` hand a function a fake that carries only the fields the test reads.

// The chats are held by a fake interface named `fake`.
useIface('fake');

const NOW = Date.parse('2026-10-17T12:00:00Z');
const MINUTE = 60_000;

const runningTask = {
  id: 'tab01',
  agent: 'scout',
  goal: `find the release notes of the new version ${'and more '.repeat(20)}`,
  state: 'running',
  createdAt: NOW - 7 * MINUTE,
  origin: { placeId: 'c1', messageId: 'm1' },
  requester: { accountId: 'u1', kind: 'member' },
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
  origin: { placeId: 'c1', messageId: 'm1' },
  requester: { accountId: 'u1', kind: 'member' },
  scope: 'group',
  result: {
    text: 'Found one on a public board; it is about cats and keyboards, posted this morning.',
    sources: ['https://example.org/board/1', 'https://example.org/board/2'],
    files: [{ path: '/elsewhere/meme.png', name: 'meme.png', contentType: 'image/png', bytes: 2048 }],
  },
  error: null,
  usage: { usd: 0.02, steps: 4 },
};

// An errand's goal in the block is kept whole, and a text over its bound is summarized or kept whole, never cut.
test('errandsBlockText / errandResultText: every word from labels.errands; none without tasks or labels', async () => {
  const text = errandsBlockText([runningTask], labels, { now: NOW });
  const [header, line] = text.split('\n');
  assert.equal(header, labels.errands.header);
  assert.ok(line.startsWith('tab01 | scout | running | 7 min | find the release notes'));
  assert.ok(line.includes(runningTask.goal.trim()), 'the goal is kept whole');
  assert.equal(errandsBlockText([], labels, { now: NOW }), '');
  assert.equal(errandsBlockText([runningTask], {}, { now: NOW }), '');
  const result = (
    await errandResultText(doneTask as unknown as Parameters<typeof errandResultText>[0], labels, {
      maxChars: 30,
    })
  ).split('\n');
  assert.equal(result[0], 'errand tab02 (scout) ended done: find a meme');
  const { result: resultLabels } = labels.errands;
  assert.equal(result[1], resultLabels.text);
  assert.equal(result[2], doneTask.result.text, 'without a summarizer the result text is kept whole');
  assert.deepEqual(result.slice(3), [
    'sources:',
    '1. https://example.org/board/1',
    '2. https://example.org/board/2',
    'files:',
    'file:tab02/meme.png | image/png | 2048 bytes',
  ]);
  const failed = (
    await errandResultText(
      { ...doneTask, state: 'failed', error: 'withheld-path', result: null } as unknown as Parameters<
        typeof errandResultText
      >[0],
      labels
    )
  ).split('\n');
  assert.deepEqual(failed, [
    'errand tab02 (scout) ended failed: find a meme',
    'no result text',
    'error: withheld-path',
  ]);
  assert.equal(await errandResultText(doneTask as unknown as Parameters<typeof errandResultText>[0], {}), '');
});

/** A fake summarizer: its calls in order, and `answer` for a text over the bound; a text within it comes back as it is. */
function fakeSummarize(answer: string) {
  const calls: Array<{ text: string; options: { maxChars: number; kind: 'text' } }> = [];
  const summarize = (text: string, options: { maxChars: number; kind: 'text' }): Promise<string> => {
    calls.push({ text, options });
    return Promise.resolve(Array.from(text).length > options.maxChars ? answer : text);
  };
  return { calls, summarize };
}

const RETOLD = 'STAND-IN: a shorter retelling of the result follows.';
const retoldLabels = {
  ...labels,
  errands: { ...labels.errands, result: { ...labels.errands.result, retold: RETOLD } },
};
const asErrand = (errand: unknown) => errand as Parameters<typeof errandResultText>[0];

// A text over its bound is summarized or kept whole, never cut.
test('errandResultText: a result over maxChars goes to summarize once and its summary stands in the block, told by result.retold', async () => {
  // Catches: a long result cut with an ellipsis, or summarized without the persona being told it is a retelling.
  const whole = `${doneTask.result.text} ${'More of what the agent found on the board. '.repeat(3)}`.trim();
  const { calls, summarize } = fakeSummarize('A board post about cats and keyboards.');
  const lines = (
    await errandResultText(asErrand({ ...doneTask, result: { ...doneTask.result, text: whole } }), retoldLabels, {
      maxChars: 60,
      summarize,
    })
  ).split('\n');
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.text, whole, 'the whole result goes to the summarizer');
  assert.deepEqual(call.options, { maxChars: 60, kind: 'text' });
  assert.ok(lines.includes('A board post about cats and keyboards.'), JSON.stringify(lines));
  assert.ok(lines.includes(RETOLD), 'the block says the result is retold');
  assert.ok(!lines.some((line) => line.includes('More of what')), 'the long text itself is not shown');
});

// A text over its bound is summarized or kept whole, never cut.
test('errandResultText: a result within maxChars is shown as it is, with no result.retold line', async () => {
  // Catches: a short result rewritten, or the retelling label printed for every result.
  const { summarize } = fakeSummarize('never shown');
  const lines = (await errandResultText(asErrand(doneTask), retoldLabels, { maxChars: 3000, summarize })).split('\n');
  assert.equal(lines[2], doneTask.result.text);
  assert.ok(!lines.includes(RETOLD));
});

// A text over its bound is summarized or kept whole, never cut.
test('errandResultText: a summary still over maxChars is shown whole', async () => {
  // Catches: the summary itself cut at the bound.
  const long = `${'A summary that runs past its bound. '.repeat(4)}end.`;
  const { summarize } = fakeSummarize(long);
  const lines = (await errandResultText(asErrand(doneTask), retoldLabels, { maxChars: 30, summarize })).split('\n');
  assert.ok(lines.includes(long), JSON.stringify(lines));
});

test('errandsBlockText / errandResultText: expired files show the expired state word and no handle', async () => {
  const expired = { ...doneTask, filesExpired: true };
  const withWord = {
    ...labels,
    errands: { ...labels.errands, states: { ...labels.errands.states, expired: 'done, files gone' } },
  };
  assert.ok(
    errandsBlockText([expired], withWord, { now: NOW })
      .split('\n')[1]
      .startsWith('tab02 | scout | done, files gone | 3 min')
  );
  const result = (await errandResultText(expired as unknown as Parameters<typeof errandResultText>[0], withWord)).split(
    '\n'
  );
  assert.equal(result[0], 'errand tab02 (scout) ended done, files gone: find a meme');
  assert.ok(
    !result.includes('files:') && !result.some((line) => line.startsWith('file:')),
    'no handle of an expired file'
  );
  // Without the label, the state's own word.
  assert.ok(
    errandsBlockText([expired], labels, { now: NOW }).split('\n')[1].startsWith('tab02 | scout | done | 3 min')
  );
  assert.equal(
    (await errandResultText(expired as unknown as Parameters<typeof errandResultText>[0], labels)).split('\n')[0],
    'errand tab02 (scout) ended done: find a meme'
  );
});

test('errandResultText: the files the runner held back close the block in labels.errands.result.held, with no handle; without the label, no line', async () => {
  const held = {
    ...doneTask,
    result: { ...doneTask.result, filesDropped: [{ name: 'x.env', reason: 'secret' }] },
  };
  const withLabels = {
    ...labels,
    errands: {
      ...labels.errands,
      result: { ...labels.errands.result, held: 'not delivered: {names}' },
    },
  };
  const lines = (await errandResultText(held as unknown as Parameters<typeof errandResultText>[0], withLabels)).split(
    '\n'
  );
  assert.deepEqual(lines.slice(-2), ['file:tab02/meme.png | image/png | 2048 bytes', 'not delivered: x.env']);
  assert.ok(!lines.some((line) => line.includes('file:tab02/x.env')), 'no handle for a held-back file');
  const names = { ...held, result: { ...held.result, filesDropped: ['x.env', 'id_rsa', '', 7] } };
  assert.equal(
    (await errandResultText(names as unknown as Parameters<typeof errandResultText>[0], withLabels)).split('\n').at(-1),
    'not delivered: x.env, id_rsa',
    'the record keeps names'
  );
  const noLabel = { ...labels, errands: { ...labels.errands, result: { ...labels.errands.result, held: undefined } } };
  assert.ok(
    !(await errandResultText(held as unknown as Parameters<typeof errandResultText>[0], noLabel)).includes('x.env')
  );
  assert.equal(
    (
      await errandResultText(
        { ...held, result: { ...held.result, filesDropped: [] } } as unknown as Parameters<typeof errandResultText>[0],
        withLabels
      )
    )
      .split('\n')
      .at(-1),
    'file:tab02/meme.png | image/png | 2048 bytes',
    'none held, no line'
  );
});

test('errandsBlockText: unread results carry the marker, the error code and the failed-turn note; the cap counts the rest', () => {
  const withError = { ...labels, errands: { ...labels.errands, line: '{id} | {state} {error} | {goal}' } };
  const failed = { ...doneTask, id: 'tab03', state: 'failed', error: 'timeout', resultTurnFailed: true, result: null };
  const lines = errandsBlockText([runningTask, failed], withError, { now: NOW }).split('\n');
  assert.ok(lines[1].startsWith('tab01 | running  | find the release notes'));
  assert.ok(!lines[1].includes('[unread]'));
  assert.equal(lines[2], 'tab03 | failed timeout | find a meme [unread] [result turn failed]');
  const many = ['a1', 'a2', 'a3', 'a4'].map((id, i) => ({ ...doneTask, id, createdAt: NOW - (10 - i) * MINUTE }));
  const capped = errandsBlockText([runningTask, ...many], labels, { now: NOW, unreadShown: 2 }).split('\n');
  assert.deepEqual(capped.map((line) => line.split(' | ')[0]).slice(1), ['tab01', 'a1', 'a2', '[2 more unread]']);
  const noMore = errandsBlockText(
    many,
    { ...labels, errands: { ...labels.errands, unreadMore: undefined } },
    { now: NOW, unreadShown: 1 }
  ).split('\n');
  assert.equal(noMore.length, 2, 'without the label, no count line');
  assert.equal(errandsBlockText(many, labels, { now: NOW }).split('\n').length, 5, 'the default shows five or fewer');
  assert.equal(
    errandsBlockText(
      Array.from({ length: 7 }, (_, i) => ({ ...doneTask, id: `b${i}` })),
      labels,
      { now: NOW }
    )
      .split('\n')
      .at(-1),
    '[2 more unread]'
  );
});

const noticeLabels = {
  errands: {
    states: { done: 'done', failed: 'failed' },
    result: {
      header: 'errand {id} ({agent}) ended {state}: {goal}',
      text: 'text:',
      empty: 'no text',
      error: 'error: {error}',
      searchFailed: 'The web search failed {count} times.',
    },
  },
};

const record = (result: Record<string, unknown>) =>
  ({
    id: 'e1',
    agent: 'scout',
    goal: 'find the notes',
    state: 'done',
    error: null,
    result,
  }) as unknown as Parameters<typeof errandResultText>[0];

test('the result the persona reads says the web search failed N times, with the count', async () => {
  // Catches: a failed web search staying silent in an errand that otherwise looks done.
  const lines = (
    await errandResultText(record({ text: 'found', sources: [], files: [], searchFailures: 3 }), noticeLabels)
  ).split('\n');
  assert.ok(
    lines.includes('The web search failed 3 times.'),
    `the notice is a line of the result: ${JSON.stringify(lines)}`
  );
});

test('the result the persona reads has no search notice when the count is zero or missing', async () => {
  // Catches: the notice printed for every errand.
  for (const searchFailures of [0, undefined]) {
    const text = await errandResultText(
      record({ text: 'found', sources: [], files: [], searchFailures }),
      noticeLabels
    );
    assert.equal(text.includes('web search'), false);
  }
});

test('a failed errand that counted failed searches still says so beside its error', async () => {
  // Catches: the notice kept for done errands only, hiding the likely cause of a run that ended empty.
  const failed = {
    ...record({ text: '', sources: [], files: [], searchFailures: 1 }),
    state: 'failed',
    error: 'empty-answer',
  };
  const text = await errandResultText(failed as unknown as Parameters<typeof errandResultText>[0], noticeLabels);
  assert.ok(text.includes('error: empty-answer'));
  assert.ok(text.includes('The web search failed 1 times.'));
});

/** A discord.js-shaped raw message, just enough for normalizeMessage. */
function rawMessage({
  id,
  authorId = 'u1',
  authorName = 'Zoë',
  ts = NOW - 10 * MINUTE,
  content = 'βρες μου κάτι',
}: {
  id: string;
  authorId?: string;
  authorName?: string;
  ts?: number;
  content?: string;
}) {
  return {
    id,
    placeId: 'c1',
    author: { id: authorId, bot: false, globalName: authorName, username: authorName },
    member: { displayName: authorName },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
}

function normalizedTrigger(raw: ReturnType<typeof rawMessage>) {
  return {
    id: raw.id,
    placeId: raw.placeId,
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
function fakeChannel({ historyMessages = [] }: { historyMessages?: Array<Record<string, unknown>> } = {}) {
  return world().channel({ id: 'c1', name: 'general', placeId: 'g1', historyMessages });
}

function fakeStore() {
  return {
    getPlace: () => ({}),
    getUser: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    liveRules: () => [],
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
      errands: { resultMaxChars: 40, resultCooldownSeconds: 60, resultRetrySeconds: 30 },
    },
    prompts: {
      main: 'You are a regular member of this chat, not an assistant.',
      persona: 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      'turn/reply': 'Someone called you: {{author}}.',
      interject: 'Jump into the chat.',
      initiate: 'Start a topic.',
      labels,
    },
  };
}

function fakeLlm(responseText: string) {
  const calls: Array<Untyped> = [];
  return {
    calls,
    complete: async (messages: unknown) => {
      calls.push(messages);
      return { text: responseText, usage: {}, estimated: 10 };
    },
  };
}

/** The errand service as the turn sees it: `view` lists `tasks`, `markSeen` is recorded. */
function fakeErrands(tasks = []) {
  const seen: Array<{ ids: Array<string> }> = [];
  const read: Array<{ ids: Array<string> }> = [];
  const failed: Array<{ ids: Array<string> }> = [];
  return {
    tasks,
    seen,
    read,
    failed,
    view: () => tasks,
    markSeen: ({ ids }: { ids: Array<string> }) => seen.push({ ids }),
    markRead: ({ ids }: { ids: Array<string> }) => read.push({ ids }),
    markResultFailed: ({ ids }: { ids: Array<string> }) => failed.push({ ids }),
    budget: () => ({ spent: false }),
    fileOf: () => null,
  };
}

const errandRunningTask = {
  id: 'tab01',
  agent: 'scout',
  goal: `find the release notes of the new version ${'and more '.repeat(20)}`,
  state: 'running',
  createdAt: NOW - 7 * MINUTE,
  origin: { placeId: 'c1', messageId: 'm1' },
  requester: { accountId: 'u1', kind: 'member' },
  scope: 'group',
  result: null,
  error: null,
};

const errandDoneTask = {
  id: 'tab02',
  agent: 'scout',
  goal: 'find a meme',
  state: 'done',
  createdAt: NOW - 3 * MINUTE,
  origin: { placeId: 'c1', messageId: 'm1' },
  requester: { accountId: 'u1', kind: 'member' },
  scope: 'group',
  result: {
    text: 'Found one on a public board; it is about cats and keyboards, posted this morning.',
    sources: ['https://example.org/board/1', 'https://example.org/board/2'],
    files: [{ path: '/elsewhere/meme.png', name: 'meme.png', contentType: 'image/png', bytes: 2048 }],
  },
  error: null,
  usage: { usd: 0.02, steps: 4 },
};

test('<errands>: an open errand is in the request tail; with none, the block is gone', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeChannel({ historyMessages: [raw] });
  const errands = fakeErrands([errandRunningTask] as unknown as Parameters<typeof fakeErrands>[0]);
  const llm = fakeLlm('<skip/>');
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id' });
  const turns = createTurnRunner({
    hot: fakeHot(),
    store: fakeStore(),
    llm,
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
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
    const firstCall = llm.calls[0];
    const text = userText(firstCall[1].content);
    assert.ok(
      text.includes(`<errands>\n${labels.errands.header}\ntab01 | scout | running | 7 min | find the release notes`),
      'the block with its line'
    );
    const llmFirstCall = llm.calls[0];
    const content = llmFirstCall[1].content;
    const tail = content.at(-1);
    assert.equal(tail.cacheSegment, undefined, 'in the tail, never a cached part');
    // The owner's decision of 2026-11-11 (cache layout): `<inner>` with the persona's errands stands after `<chat>`.
    assert.ok(tail.text.indexOf('<errands>') > tail.text.indexOf('</chat>'), 'after the chat');
    assert.deepEqual(errands.seen, [], 'an open errand is not marked seen');
    errands.tasks.length = 0;
    await turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' });
    const secondCall = llm.calls[1];
    assert.equal(userText(secondCall[1].content).includes('<errands>'), false, 'no errand, no block');
  });
});

test('<errands>: a finished errand the persona has not read is listed with its marker and nothing is marked by showing it', async () => {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeChannel({ historyMessages: [raw] });
  const errands = fakeErrands([errandRunningTask, errandDoneTask] as unknown as Parameters<typeof fakeErrands>[0]);
  const llm = fakeLlm('<skip/>');
  const turns = createTurnRunner({
    hot: fakeHot(),
    store: fakeStore(),
    llm,
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    port: createFakeAdapter({ iface: 'fake', selfId: 'self-id' }),
    errands,
    now: () => NOW,
  });
  await withCapturedLogs(() =>
    turns.runTurn({ channel, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' })
  );
  const firstCall = llm.calls[0];
  assert.ok(userText(firstCall[1].content).includes('tab02 | scout | done | 3 min | find a meme [unread]'));
  assert.deepEqual(errands.seen, [], 'appearing in <errands> marks nothing');
  assert.deepEqual(errands.read, []);
});
