// Tests for the failed addressed turns told at her next request in the channel
// (src/behavior/turn.js, src/behavior/prompt.js#renderTasks): an addressed reply turn that ended
// `error` with nothing posted is kept per channel (at most context.failedTurnsKept, 24 hours); the
// next request there ends its task with one labels.task.failedEarlier line per entry, then the
// entries are gone. Fake client, fake llm, injected clock; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRunner, sendHash, settleUnknownSends } from '../src/behavior/turn.js';
import { createLocalFacts } from '../src/behavior/inner.js';
import { DailyCapError } from '../src/llm/openrouter.js';
import { fill, formatClock, formatDate } from '../src/format.js';
import { userText } from '../src/behavior/prompt.js';
import { createFakeAdapter } from '../src/interface/fake.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { createDiscordInterface } from '../src/interface/discord.js';

const DISCORD = createDiscordInterface().capabilities;
const NOW = Date.parse('2026-10-19T12:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const clock = { t: NOW };

function rawMessage({ id, authorId = 'u1', authorName = 'Zoë', ts = NOW - 10 * MINUTE, content = 'καλημέρα' }) {
  return {
    id,
    channelId: '77',
    author: { id: authorId, bot: false, globalName: authorName, username: authorName },
    member: { displayName: authorName },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
}

function triggerOf(raw) {
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

function fakeChannel(historyMessages) {
  const guild = { id: '55', members: { me: { displayName: 'Bot' } }, channels: { cache: new Map() } };
  return {
    id: '77',
    name: 'general',
    guild,
    sendTyping: async () => {},
    send: async () => ({ id: 'sent' }),
    messages: {
      cache: new Map(),
      fetch: async (arg) =>
        arg && typeof arg === 'object' && 'limit' in arg
          ? new Map(historyMessages.map((m) => [m.id, m]))
          : (historyMessages.find((m) => m.id === arg) ?? null),
    },
  };
}

const store = {
  getGuild: () => ({}),
  getUser: () => null,
  listChannels: () => [],
  listUserProfiles: () => [],
  getLore: () => [],
  state: { data: {}, markDirty() {} },
};

function hotWith(context = {}) {
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
        failedTurnsKept: 3,
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
        ...context,
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      features: { typingSimulation: false },
      media: { maxPerTurn: 6, filePreviewChars: 500 },
      mention: { oneAtATime: true },
    },
    prompts: {
      'system-prompt': 'You are a regular member of this chat.',
      'character-card': 'You are friendly and terse.',
      format: 'Use <msg> tags.',
      reply: 'Someone called you: {{author}}.',
      interject: 'Jump in.',
      initiate: 'Start a topic.',
      labels,
    },
  };
}

/** A runner whose llm throws while `fail.on` and answers a skip otherwise. */
function setup({ history, context } = {}) {
  const channel = fakeChannel(history);
  const fail = { on: true, error: Object.assign(new Error('OpenRouter HTTP 429'), { statusCode: 429, body: '{}' }) };
  const calls = [];
  const llm = {
    complete: async (messages) => {
      calls.push(messages);
      if (fail.on) throw fail.error;
      return { text: '<skip/>', usage: {}, estimated: 10 };
    },
  };
  const turns = createTurnRunner({
    discord: DISCORD,
    hot: hotWith(context),
    store,
    llm,
    calibrator: { ratio: 1, apply: (n) => n, observe: () => {} },
    client: { user: { id: 'self-id', username: 'Bot' } },
    port: createFakeAdapter({ iface: 'fake', selfId: 'self-id' }),
    now: () => clock.t,
  });
  const run = (raw, triggerKind = 'mention') =>
    withCapturedLogs(() => turns.runTurn({ channel, mode: 'reply', trigger: triggerOf(raw), triggerKind }));
  const taskOf = (call = calls.length - 1) =>
    userText(calls[call][1].content)
      .split('\n')
      .filter((line) => line.startsWith('unanswered:'));
  return { run, fail, calls, taskOf, turns };
}

test.beforeEach(() => {
  clock.t = NOW;
});

test('a failed addressed turn carries its code and is told at the next request there, once: the number, the person, the age', async () => {
  const first = rawMessage({ id: '101' });
  const second = rawMessage({ id: '102', authorId: 'u2', authorName: 'Αλέξης', ts: NOW + 4 * MINUTE });
  const { run, fail, taskOf, calls } = setup({ history: [first, second] });
  const failed = await run(first);
  assert.equal(failed.result.outcome, 'error');
  assert.equal(failed.result.reason, 'provider-limit');
  fail.on = false;
  clock.t = NOW + 5 * MINUTE;
  const next = await run(second);
  assert.equal(next.result.outcome, 'skip');
  assert.deepEqual(taskOf(1), ['unanswered: Zoë #1 5 min ago (provider-limit)']);
  await run(second);
  assert.deepEqual(taskOf(2), [], 'cleared once shown and answered');
  assert.equal(calls.length, 3);
});

test('a failed message outside the transcript is named by its link; an overheard turn is not kept', async () => {
  const first = rawMessage({ id: '101' });
  const second = rawMessage({ id: '102', ts: NOW + MINUTE });
  const { run, fail, taskOf } = setup({ history: [second] });
  await run(first);
  await run(rawMessage({ id: '103' }), 'overheard');
  fail.on = false;
  await run(second);
  const lines = taskOf(2);
  assert.equal(lines.length, 1, 'only the addressed failure');
  assert.match(lines[0], /^unanswered: Zoë https:\/\/discord\.com\/channels\/55\/77\/101 /);
});

test('at most context.failedTurnsKept entries per channel, the newest; none older than 24 hours', async () => {
  const messages = ['101', '102', '103', '104'].map((id, i) => rawMessage({ id, ts: NOW - (10 - i) * MINUTE }));
  const { run, fail, taskOf } = setup({ history: messages });
  for (const raw of messages) {
    clock.t += MINUTE;
    await run(raw);
  }
  fail.on = false;
  clock.t += MINUTE;
  await run(rawMessage({ id: '105' }));
  assert.deepEqual(
    taskOf(4).map((line) => line.split(' ')[2]),
    ['#2', '#3', '#4']
  );

  const aged = setup({ history: messages });
  await aged.run(messages[0]);
  aged.fail.on = false;
  clock.t = NOW + 25 * HOUR;
  await aged.run(rawMessage({ id: '106' }));
  assert.deepEqual(aged.taskOf(1), [], 'past 24 hours it is forgotten');
});

test('the entries stay when the request that showed them fails too; a retry of the same message is not told about itself', async () => {
  const first = rawMessage({ id: '101' });
  const second = rawMessage({ id: '102', ts: NOW + MINUTE });
  const { run, fail, taskOf, calls } = setup({ history: [first, second] });
  await run(first);
  clock.t = NOW + 2 * MINUTE;
  await run(second);
  assert.equal(taskOf(1).length, 1);
  fail.on = false;
  clock.t = NOW + 3 * MINUTE;
  await run(second);
  assert.equal(taskOf(2).length, 1, 'the first failure is told; the message being answered is not');
  clock.t = NOW + 4 * MINUTE;
  await run(rawMessage({ id: '103', ts: NOW + 3 * MINUTE }));
  assert.equal(calls.length, 4);
  assert.deepEqual(taskOf(3), [], 'the retry that spoke or skipped cleared them');
});

test('a turn stopped by a rail is kept like an error: told at the next request there with the reason', async () => {
  const first = rawMessage({ id: '101' });
  const second = rawMessage({ id: '102', ts: NOW + MINUTE });
  const { run, fail, taskOf } = setup({ history: [first, second] });
  fail.error = new DailyCapError('daily LLM request cap reached');
  const stopped = await run(first);
  assert.equal(stopped.result.outcome, 'refused');
  fail.on = false;
  clock.t = NOW + 2 * MINUTE;
  await run(second);
  assert.equal(taskOf(1).length, 1, 'told');
  assert.match(taskOf(1)[0], /^unanswered: Zoë #1 2 min ago \(\S+\)$/);
});

test("facts kept for the channel (a drop, a hold) reach an addressed request there in a block before the task, once; a private chat's and another channel's do not", async () => {
  const first = rawMessage({ id: '101' });
  const { run, fail, calls, turns } = setup({ history: [first] });
  fail.on = false;
  const source = createLocalFacts({ now: () => clock.t });
  turns.setFactsSource(source);
  const dropped = {
    kind: 'wakeDropped',
    wakeId: 'w1',
    wake: 'intention_due',
    code: 'stale',
    why: 'done',
    intentionId: 'i1',
    purpose: 'say hi',
  };
  source.add('55', { ...dropped, channelId: '77', privateChat: false });
  source.add('55', {
    kind: 'wakeHeld',
    wakeId: 'w2',
    wake: 'intention_due',
    code: 'per-chain',
    intentionId: 'i2',
    purpose: 'later',
    until: NOW + 6 * HOUR,
    channelId: null,
    privateChat: false,
  });
  source.add('55', { ...dropped, intentionId: 'i3', purpose: 'in a private chat', channelId: '88', privateChat: true });
  source.add('55', { ...dropped, intentionId: 'i4', purpose: 'elsewhere', channelId: '99', privateChat: false });
  await run(first);
  const text = userText(calls[0][1].content);
  const block = /<wake>\n([\s\S]*?)\n<\/wake>/.exec(text)?.[1] ?? '';
  const lines = block.split('\n');
  assert.equal(lines[0], labels.wake.feedbackInTurn);
  assert.deepEqual(lines.slice(1), [
    '* wake intention_due i1 say hi stale is done',
    `* held intention_due i2 later per-chain until ${formatDate(NOW + 6 * HOUR, 'UTC', 'en-US')} ${formatClock(NOW + 6 * HOUR, 'UTC', 'en-US')}`,
  ]);
  assert.ok(text.indexOf('<wake>') < text.indexOf('<task>'));
  assert.equal(
    source.pending(null, { channelId: '88', privateChat: true }).length,
    1,
    "the private chat's fact is still waiting for that chat"
  );
  assert.equal(source.pending(null, { channelId: '99', privateChat: false }).length, 1);
  // Told once a completed answer carried them.
  await run(first);
  assert.equal(userText(calls[1][1].content).includes('<wake>'), false);
  assert.equal(source.pending(null, { channelId: '77', privateChat: false }).length, 0);
});

test('sendHash and settleUnknownSends: the hash covers the start of the text with whitespace folded; only a later line of hers with that hash settles the fact', () => {
  assert.equal(sendHash('a  b\n c'), sendHash(' a b c '));
  assert.notEqual(sendHash('a b c'), sendHash('a b d'));
  assert.equal(
    sendHash(`${'x'.repeat(80)}tail`),
    sendHash(`${'x'.repeat(80)}other`),
    'a trailing link or a cut changes nothing'
  );
  const fact = { id: 'f1', kind: 'sendFailed', unknown: true, hash: sendHash('ένα'), at: NOW };
  const known = { id: 'f2', kind: 'sendFailed', code: 'http-403', at: NOW };
  const line = (over) => ({ self: true, content: 'ένα', ts: NOW + 1000, ...over });
  assert.deepEqual(settleUnknownSends([fact, known], [line()]), { kept: [known], dropped: [fact] });
  assert.deepEqual(settleUnknownSends([fact], [line({ self: false })]).kept, [fact], 'not hers');
  assert.deepEqual(settleUnknownSends([fact], [line({ content: 'δύο' })]).kept, [fact], 'another text');
  assert.deepEqual(settleUnknownSends([fact], [line({ ts: NOW - 5 * MINUTE })]).kept, [fact], 'older than the send');
  assert.deepEqual(
    settleUnknownSends([known], []),
    { kept: [known], dropped: [] },
    'a send that failed for sure is never looked for'
  );
});

test('a send whose answer never came: her next addressed turn looks for it among her own lines; found, nothing is told; not found, it is told as unclear', async () => {
  const sentText = 'ένα μήνυμα που ίσως έφτασε';
  const unknownSend = {
    kind: 'sendFailed',
    code: 'error',
    n: 0,
    total: 1,
    unknown: true,
    hash: sendHash(sentText),
    channelId: '77',
    privateChat: false,
    at: NOW - 2 * MINUTE,
  };
  const first = rawMessage({ id: '101' });

  const found = setup({
    history: [
      rawMessage({ id: '100', authorId: 'self-id', authorName: 'Bot', ts: NOW - MINUTE, content: sentText }),
      first,
    ],
  });
  found.fail.on = false;
  const foundSource = createLocalFacts({ now: () => clock.t });
  found.turns.setFactsSource(foundSource);
  foundSource.add('55', unknownSend);
  await found.run(first);
  assert.equal(userText(found.calls[0][1].content).includes('<wake>'), false, 'it went out: nothing to tell');
  assert.equal(foundSource.pending(null, { channelId: '77', privateChat: false }).length, 0, 'and the fact is gone');

  const missing = setup({ history: [first] });
  missing.fail.on = false;
  const missingSource = createLocalFacts({ now: () => clock.t });
  missing.turns.setFactsSource(missingSource);
  missingSource.add('55', unknownSend);
  await missing.run(first);
  const block = /<wake>\n([\s\S]*?)\n<\/wake>/.exec(userText(missing.calls[0][1].content))?.[1] ?? '';
  assert.deepEqual(block.split('\n').slice(1), [
    `* ${fill(labels.wake.feedback.sendUnknown, { code: 'error', n: '0', total: '1' })}`,
  ]);
});
