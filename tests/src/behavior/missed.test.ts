// Missed answers (src/behavior/missed.ts): the candidate registry fed from facts, its
// resolution by later turns, the delayed sweep with its code filter and helper, the recovery
// turn, the restart reconciliation and the day's figures. Two later sections cover the sweep's strict JSON answer and
// the registries of every place on every interface.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  MISSED_FORMAT,
  MISSED_VERDICTS,
  UNCHECKED,
  addCandidate,
  buildCheckRequest,
  createMissed,
  expiryMs,
  isQuestion,
  missedCounts,
  missedSettings,
  missedStatusLine,
  parseMissedAnswer,
  pruneCandidates,
  reconcileFromRecords,
  resolveByTurn,
  resolvedInHistory,
  stateForVerdict,
  sweepDueAt,
  sweepPlan,
} from '../../../src/behavior/missed.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { createReads } from '../../../src/interface/reads.ts';
import type { ChatInfo } from '../../../src/protocol/adapter.ts';
import { labels } from '../../fixtures/labels.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import { channel as channelOf } from '../../fixtures/reads-rig.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { openTestMemory } from '../../fixtures/memory-db/service.ts';
import { useIface, world, useSelf, worldChannels } from '../../fixtures/turn-world.ts';
import { noMediaNames } from '../../fixtures/media-namer.ts';
import { fileURLToPath } from 'node:url';
import { SnowflakeUtil } from 'discord.js';
import { joinLabels } from '../../../src/config/labels.ts';
import { deepMerge } from '../../../src/config.ts';
import { MINUTE_MS } from '../../../src/time.ts';
import { normalizeMessage } from '../../../interfaces/discord/index.ts';
import { withTextPreviews } from '../../../src/media/text-preview.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { loose } from '../../fixtures/as-options.ts';
import { chainsOf } from '../../fixtures/chains.ts';

// The chats are held by a fake interface named `fake`.
useIface('fake');

type Candidate = Parameters<typeof resolvedInHistory>[0];
// What the fakes record of a recovery turn and of a helper call: the fields the tests read.
type TurnCall = {
  triggerKind: string;
  mode: string;
  trigger: { id: string };
  missed: Array<unknown>;
  stillDue: () => boolean;
  chat: { chatId: string };
  placeId: string;
};
type LlmCall = { messages: Array<{ content: string }>; options: { purpose: string; role: string } };

const T0 = Date.parse('2026-10-14T12:00:00.000Z');
const MIN = 60_000;
const SELF = 'self1';

// A normalized message (interfaces/discord/collect.ts#normalizeMessage's shape, the fields read here).
function msg({
  id,
  authorId = 'u1',
  authorName = 'Élodie',
  content = 'και λοιπόν',
  ts = T0,
  self = false,
  replyToId = null,
  placeId = 'c1',
}: {
  id: string;
  authorId?: string;
  authorName?: string;
  content?: string;
  ts?: number;
  self?: boolean;
  replyToId?: string | null;
  placeId?: string;
}) {
  return {
    id,
    placeId,
    authorId: self ? SELF : authorId,
    authorName: self ? 'Bot' : authorName,
    self,
    bot: false,
    content,
    ts,
    replyToId,
    mentionedAccountIds: [],
    mentionedChannelIds: [],
    attachments: [],
    links: [],
    stickers: [],
    emojis: [],
    reactions: [],
    forwarded: [],
  };
}

// The `message.received` event of a line, as an interface delivers it (the line it gives back is the line).
function eventOfLine(line: ReturnType<typeof msg>) {
  return {
    kind: 'message.received',
    iface: 'fake',
    at: line.ts,
    id: `fake:message:${line.id}`,
    chat: { id: line.placeId, kind: 'channel', rootId: 'g1', name: line.placeId },
    message: {
      id: line.id,
      author: { id: line.authorId, name: line.authorName, self: line.self, bot: line.bot },
      content: line.content,
      sourceText: line.content,
      system: false,
      at: line.ts,
      replyToId: line.replyToId,
      replyPingAccountId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
  };
}

/** A fact as createMissed's noteFact takes it. */
const fact = (reason: string, message: object, extra: object = {}) => ({ reason, message, ...extra });

function settings(overrides: Record<string, unknown> = {}) {
  return { ...missedSettings({}), ...overrides };
}

// The switches are code (the recovery turn included) and the context measures constants.
function baseConfig(overrides: { missed?: object } = {}) {
  return {
    bot: { timezone: 'UTC' },
    missed: { ...(overrides.missed ?? {}) },
    models: {},
    llm: {},
  };
}

/** A clock the test moves by hand. */
function handClock(start = T0) {
  let at = start;
  const clock = () => at;
  clock.set = (value: number) => {
    at = value;
  };
  clock.advance = (ms: number) => {
    at += ms;
  };
  return clock;
}

/** Timers fired by hand: `due()` lists their times, `fireAll()` runs the ones set so far, earliest first, each awaited. */
function handTimers(clock: ReturnType<typeof handClock>) {
  const pending = new Map<number, { fn: () => unknown; at: number }>();
  let next = 1;
  return {
    set(fn: () => unknown, ms: number) {
      const id = next++;
      pending.set(id, { fn, at: clock() + ms });
      return id;
    },
    clear(id: number) {
      pending.delete(id);
    },
    due: () => [...pending.values()].map((entry) => entry.at).sort((a, b) => a - b),
    size: () => pending.size,
    async fireAll() {
      const entries = [...pending.entries()].sort((a, b) => a[1].at - b[1].at);
      for (const [id, entry] of entries) {
        if (!pending.has(id)) continue;
        pending.delete(id);
        clock.set(Math.max(clock(), entry.at));
        await entry.fn();
      }
      // The journal lines are written behind the sweep.
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

/** A recording journal: `answer` lines kept as records; `read` serves `records`. */
function fakeJournal(records: Array<{ occurredAt: string } & Record<string, unknown>> = []) {
  const answers: Array<Record<string, unknown>> = [];
  return {
    answers,
    answer: async (placeId: string, record: object) => {
      answers.push({ kind: 'answer', holder: placeId, ...record });
    },
    read: async (placeId: string, { day }: { day: string }) =>
      records.filter((record) => record.occurredAt.slice(0, 10) === day),
  };
}

/** A helper llm answering `answer` (a string, an Error to throw, or a function of the call). */
function fakeLlm(answer: string | Error | ((messages: unknown) => string | Error) = '') {
  const calls: Array<LlmCall> = [];
  return {
    calls,
    complete: async (messages: LlmCall['messages'], options: LlmCall['options']) => {
      calls.push({ messages, options });
      const value = typeof answer === 'function' ? answer(messages) : answer;
      if (value instanceof Error) throw value;
      return { text: value };
    },
  };
}

/** A turn runner: records runTurn calls; `links` maps the persona's posted ids to their triggers. */
function fakeTurns({
  outcome = 'spoke',
  links = new Map<string, unknown>(),
  busy = false,
  onRun = null,
}: {
  outcome?: string;
  links?: Map<string, unknown>;
  busy?: boolean;
  onRun?: ((params: TurnCall) => unknown) | null;
} = {}) {
  const calls: Array<TurnCall> = [];
  const turns = {
    calls,
    busy,
    lastPost: 0,
    triggerOf: (id: string) => links.get(id) ?? null,
    lastPostAt: () => turns.lastPost,
    isBusy: () => turns.busy,
    isAnyBusy: () => turns.busy,
    runTurn: async (params: TurnCall) => {
      calls.push(params);
      if (onRun) return onRun(params);
      return { outcome };
    },
  };
  return turns;
}

function fakeLog() {
  const lines: Array<Record<string, unknown>> = [];
  const push =
    (level: string) =>
    (msg: string, fields: object = {}) =>
      lines.push({ level, msg, ...fields });
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

function tmpData() {
  return tempDir('nep-missed-');
}

/** One createMissed with fakes; `history` is what every channel fetch returns. */
function scene({
  config = baseConfig(),
  history = [],
  llm = fakeLlm(''),
  turns = fakeTurns(),
  journal = fakeJournal(),
  paused = false,
  canSend = () => true,
  dataDir = tmpData(),
  prompts = { 'classify/missed': 'Check for {{name}}.', labels },
  channels = [],
  memoryDb,
}: {
  config?: ReturnType<typeof baseConfig>;
  history?: Array<ReturnType<typeof msg>>;
  llm?: ReturnType<typeof fakeLlm>;
  turns?: ReturnType<typeof fakeTurns>;
  journal?: ReturnType<typeof fakeJournal>;
  paused?: boolean;
  canSend?: (channel: { id: string }) => boolean;
  dataDir?: string;
  memoryDb?: Pick<Awaited<ReturnType<typeof openTestMemory>>['memoryDb'], 'readHandle' | 'writeOperational'>;
  prompts?: Record<string, unknown>;
  channels?: Array<{ id: string; recipientId: string }>;
} = {}) {
  const clock = handClock();
  const timers = handTimers(clock);
  const log = fakeLog();
  const store = { state: { data: { paused } }, mediaNameOf: noMediaNames };
  // #general (c1) of the root, and the other chats the test names (a private chat: `recipientId`).
  const channel = world().channel({ id: 'c1', placeId: 'g1', permissions: { send: canSend({ id: 'c1' }) } });
  const partners = new Map<string, string>();
  const others = channels;
  for (const extra of others) {
    world().channel({ id: extra.id, dm: true, partnerId: extra.recipientId });
    partners.set(extra.id, extra.recipientId);
  }
  const hot = { config, prompts };
  // What every chat's history holds: the lines of the test, seeded as events when they are set.
  const fetched = {
    set history(lines: Array<ReturnType<typeof msg>>) {
      for (const line of lines) {
        world().port.seedEvent(eventOfLine(line) as Parameters<ReturnType<typeof world>['port']['seedEvent']>[0]);
      }
    },
  };
  fetched.history = history;
  const inner = createMissed({
    hot,
    store,
    journal,
    llm,
    turns,
    reads: world().reads,
    partnerOf: (id: string) => partners.get(id) ?? null,
    getSelfName: () => 'Bot',
    dataDir,
    ...(memoryDb ? { memoryDb } : {}),
    now: clock,
    timers,
    log,
  });
  // A fact, an activity and a turn's end name their interface, each caller does.
  const missed = {
    ...inner,
    noteFact: (fact: Parameters<typeof inner.noteFact>[0]) => inner.noteFact({ iface: 'fake', ...fact }),
    noteActivity: (placeId: string, at?: number) => inner.noteActivity(placeId, at, 'fake'),
    onTurnEnd: (end: Parameters<typeof inner.onTurnEnd>[0]) => inner.onTurnEnd({ iface: 'fake', ...end }),
    sweep: (placeId: string) => inner.sweep('fake', placeId),
  };
  return { missed, clock, timers, log, store, journal, llm, turns, hot, fetched, dataDir, channel };
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

// ---- the pure core ------------------------------------------------------------------

test('addCandidate: one candidate per message; an open one takes the latest reason and turn, a closed one is left alone', () => {
  const first = addCandidate([], { messageId: 'm1', placeId: 'c1', authorId: 'u1', at: T0, reason: 'gate-failopen' });
  assert.equal(first.added, true);
  assert.deepEqual(
    { ...first.candidate },
    {
      messageId: 'm1',
      placeId: 'c1',
      authorId: 'u1',
      at: T0,
      reason: 'gate-failopen',
      question: false,
      turnIds: [],
      state: 'pending',
      attempts: 0,
      verdict: null,
      checkedAt: null,
      updatedAt: T0,
    }
  );
  const again = addCandidate(
    first.list,
    { messageId: 'm1', placeId: 'c1', authorId: 'u1', at: T0, reason: 'turn-error', turnId: 't-1' },
    { now: T0 + 5 }
  );
  assert.equal(again.added, false);
  assert.equal(again.list.length, 1);
  assert.equal(again.candidate!.reason, 'turn-error');
  assert.deepEqual(again.candidate!.turnIds, ['t-1']);
  const closed = again.list.map((candidate) => ({ ...candidate, state: 'resolved' }));
  const late = addCandidate(closed, { messageId: 'm1', placeId: 'c1', at: T0, reason: 'not-now' });
  assert.equal(late.list, closed, 'a resolved message never comes back');
  assert.equal(
    addCandidate([], { messageId: 'm2', placeId: 'c1', at: T0, reason: 'skip' }).added,
    false,
    'not a reason'
  );
});

test('isQuestion and expiryMs: a question mark (ASCII or full-width) gets the longer expiry', () => {
  assert.equal(isQuestion('τι ώρα είναι;'), false, 'the Greek question mark is a semicolon: no');
  assert.equal(isQuestion('à quelle heure?'), true);
  assert.equal(isQuestion(`naze${String.fromCharCode(0xff1f)}`), true);
  assert.equal(isQuestion(null), false);
  const s = settings({ expireMinutes: 5, questionExpireMinutes: 15 });
  assert.equal(expiryMs({ question: false }, s), 5 * MIN);
  assert.equal(expiryMs({ question: true }, s), 15 * MIN);
});

test('resolveByTurn: a later turn resolves by its trigger, by a reply, or by a later line of the same author; skip only by its trigger', () => {
  let list: Array<Candidate> = [];
  for (const [id, authorId] of [
    ['m1', 'u1'],
    ['m2', 'u2'],
    ['m3', 'u3'],
  ])
    list = addCandidate(list, { messageId: id, placeId: 'c1', authorId, at: T0, reason: 'gate-failed' }).list;
  list = addCandidate(list, { messageId: 'm9', placeId: 'c2', authorId: 'u1', at: T0, reason: 'gate-failed' }).list;

  const spoke = resolveByTurn(list, {
    placeId: 'c1',
    triggerId: 'm5',
    triggerAuthorId: 'u1',
    triggerAt: T0 + 1000,
    outcome: 'spoke',
    replyTargets: ['m2'],
    turnId: 't-1',
    at: T0 + 2000,
  });
  assert.deepEqual(
    spoke.resolved.map(({ messageId, by }) => [messageId, by]),
    [
      ['m1', 'author'],
      ['m2', 'reply'],
    ]
  );
  assert.equal(spoke.list.find((c) => c.messageId === 'm9')!.state, 'pending', 'another channel is not touched');
  assert.deepEqual(spoke.list.find((c) => c.messageId === 'm1')!.turnIds, ['t-1']);

  const skipped = resolveByTurn(list, {
    placeId: 'c1',
    triggerId: 'm3',
    triggerAuthorId: 'u1',
    triggerAt: T0 + 1000,
    outcome: 'skip',
    at: T0 + 2000,
  });
  assert.deepEqual(
    skipped.resolved.map(({ messageId, by }) => [messageId, by]),
    [['m3', 'trigger']],
    'a skip answers its own trigger only'
  );

  for (const outcome of ['error', 'not-now', 'refused', 'busy', 'paused']) {
    assert.deepEqual(resolveByTurn(list, { placeId: 'c1', triggerId: 'm1', outcome, at: T0 }).resolved, [], outcome);
  }
  const earlier = resolveByTurn(list, {
    placeId: 'c1',
    triggerId: 'm0',
    triggerAuthorId: 'u1',
    triggerAt: T0 - 1,
    outcome: 'spoke',
    at: T0 + 1,
  });
  assert.deepEqual(earlier.resolved, [], 'a message of the author older than the candidate does not answer it');
});

test("resolvedInHistory: the persona's later line replying to it, started by it, or by a later message of its author", () => {
  const candidate = { messageId: 'm1', authorId: 'u1', at: T0 };
  const links = new Map([
    ['s2', 'm1'],
    ['s3', 'm2'],
    ['s4', 'm3'],
  ]);
  const triggerOf = (id: string) => links.get(id) ?? null;
  const base = [
    msg({ id: 'm1', ts: T0 }),
    msg({ id: 'm2', ts: T0 + 1000 }),
    msg({ id: 'm3', authorId: 'u2', ts: T0 + 1500 }),
  ];
  assert.equal(
    resolvedInHistory(
      candidate as Candidate,
      [...base, msg({ id: 's1', self: true, ts: T0 + 2000, replyToId: 'm1' })],
      triggerOf
    ),
    'reply'
  );
  assert.equal(
    resolvedInHistory(candidate as Candidate, [...base, msg({ id: 's2', self: true, ts: T0 + 2000 })], triggerOf),
    'trigger'
  );
  assert.equal(
    resolvedInHistory(candidate as Candidate, [...base, msg({ id: 's3', self: true, ts: T0 + 2000 })], triggerOf),
    'author'
  );
  assert.equal(
    resolvedInHistory(candidate as Candidate, [...base, msg({ id: 's4', self: true, ts: T0 + 2000 })], triggerOf),
    null,
    "another member's line"
  );
  assert.equal(
    resolvedInHistory(
      candidate as Candidate,
      [msg({ id: 's1', self: true, ts: T0 - 1000, replyToId: 'm1' }), ...base],
      triggerOf
    ),
    null,
    'before it'
  );
});

test('sweepPlan: expired, answered in the history, out of the window, owed already, and the rest to check', () => {
  const s = settings({ expireMinutes: 5, questionExpireMinutes: 15 });
  const now = T0 + 10 * MIN;
  let list: Array<Candidate> = [];
  const add = (messageId: string, at: number, extra = {}) => {
    list = addCandidate(list, { messageId, placeId: 'c1', authorId: 'u1', at, reason: 'gate-failed', ...extra }).list;
  };
  add('old', now - 6 * MIN);
  add('oldQuestion', now - 6 * MIN, { question: true });
  add('answered', now - 2 * MIN);
  add('gone', now - 2 * MIN);
  add('owed', now - 2 * MIN);
  add('fresh', now - 1 * MIN);
  list = list.map((c) => (c.messageId === 'owed' ? { ...c, verdict: 'owed' } : c));
  list = addCandidate(list, { messageId: 'other', placeId: 'c2', at: now, reason: 'gate-failed' }).list;
  const history = [
    msg({ id: 'oldQuestion', ts: now - 6 * MIN }),
    msg({ id: 'answered', ts: now - 2 * MIN }),
    msg({ id: 'owed', ts: now - 2 * MIN }),
    msg({ id: 'fresh', ts: now - MIN }),
    msg({ id: 's1', self: true, ts: now - 30_000, replyToId: 'answered' }),
  ];
  const plan = sweepPlan(list, 'c1', { now, settings: s, history, triggerOf: () => null });
  assert.deepEqual(
    plan.expired.map((c) => c.messageId),
    ['old']
  );
  assert.deepEqual(
    plan.resolved.map(({ candidate, by }) => [candidate.messageId, by]),
    [['answered', 'history-reply']]
  );
  assert.deepEqual(
    plan.notShown.map((c) => c.messageId),
    ['gone']
  );
  assert.deepEqual(
    plan.owed.map((c) => c.messageId),
    ['owed']
  );
  assert.deepEqual(
    plan.check.map((c) => c.messageId),
    ['oldQuestion', 'fresh'],
    'a question lives 15 minutes'
  );
});

test('stateForVerdict: owed waits for its recovery only with recovery on', () => {
  assert.equal(stateForVerdict('owed', true), 'pending');
  assert.equal(stateForVerdict('owed', false), 'dismissed');
  assert.equal(stateForVerdict('resolved', false), 'resolved');
  for (const verdict of ['intentional-skip', 'stale', 'uncertain', UNCHECKED])
    assert.equal(stateForVerdict(verdict, true), 'dismissed', verdict);
});

test('sweepDueAt: the delay after the last event, never past the cap from the first', () => {
  const s = settings({ sweepDelaySeconds: 90, sweepMaxDelaySeconds: 240 });
  assert.equal(sweepDueAt({ firstAt: T0, lastAt: T0 }, s), T0 + 90_000);
  assert.equal(sweepDueAt({ firstAt: T0, lastAt: T0 + 60_000 }, s), T0 + 150_000);
  assert.equal(sweepDueAt({ firstAt: T0, lastAt: T0 + 200_000 }, s), T0 + 240_000);
});

test('pruneCandidates: a day at most, closed ones go first past the cap', () => {
  const list = [
    { messageId: 'a', at: T0 - 2 * 24 * 60 * MIN, state: 'pending' },
    { messageId: 'b', at: T0 - 30 * MIN, state: 'resolved', updatedAt: T0 - 29 * MIN },
    { messageId: 'c', at: T0 - 20 * MIN, state: 'pending' },
    { messageId: 'd', at: T0 - 10 * MIN, state: 'dismissed', updatedAt: T0 - 9 * MIN },
  ];
  assert.deepEqual(
    pruneCandidates(list as Array<Candidate>, T0).map((c) => c.messageId),
    ['b', 'c', 'd']
  );
  assert.deepEqual(
    pruneCandidates(list as Array<Candidate>, T0, 2).map((c) => c.messageId),
    ['c', 'd']
  );
});

test('missedCounts and missedStatusLine: distinct candidates by first reason, verdicts, recovered messages', () => {
  const records = [
    { kind: 'answer', event: 'fact', reason: 'gate-failed', messageId: 'm1' },
    { kind: 'answer', event: 'fact', reason: 'turn-error', messageId: 'm1' },
    { kind: 'answer', event: 'fact', reason: 'replaced-deferred', messageId: 'm2' },
    { kind: 'answer', event: 'verdict', verdict: 'owed', messageId: 'm1' },
    { kind: 'answer', event: 'verdict', verdict: 'stale', messageId: 'm2' },
    { kind: 'answer', event: 'recovery', outcome: 'spoke', messageIds: ['m1'] },
    { kind: 'turn', outcome: 'spoke' },
  ];
  const counts = missedCounts(records);
  assert.deepEqual(counts, {
    candidates: 2,
    owed: 1,
    recovered: 1,
    byReason: { 'gate-failed': 1, 'replaced-deferred': 1 },
    byVerdict: { owed: 1, stale: 1 },
  });
  assert.equal(missedStatusLine(counts), 'missed: 2 candidates, 1 owed, 1 recovered');
});

test("buildCheckRequest: the transcript from a few lines before the earliest candidate, the persona's trigger markers, one numbered line per candidate", () => {
  const history = [];
  for (let i = 1; i <= 8; i += 1) history.push(msg({ id: `p${i}`, content: `γραμμή ${i}`, ts: T0 + i * 1000 }));
  history.push(msg({ id: 'm1', content: 'πού είσαι?', ts: T0 + 9000 }));
  history.push(msg({ id: 's1', self: true, content: 'εδώ', ts: T0 + 10_000 }));
  history.push(msg({ id: 'm2', authorId: 'u2', authorName: 'Zoë', content: 'και εγώ', ts: T0 + 11_000 }));
  const request = buildCheckRequest({
    mediaNameOf: noMediaNames,
    prompt: 'Check for {{name}}.',
    labels,
    config: baseConfig(),
    selfName: 'Bot',
    history,
    candidates: [
      { messageId: 'm1', reason: 'gate-failed' },
      { messageId: 'm2', reason: 'turn-error' },
      { messageId: 'zz', reason: 'not-now' },
    ],
    triggerOf: (id) => (id === 's1' ? 'p8' : null),
    now: T0 + 20_000,
  });
  assert.equal(request!.system, 'Check for Bot.');
  assert.ok(!request!.user.includes('γραμμή 3'), 'older lines cut');
  assert.ok(request!.user.includes('γραμμή 4'));
  assert.ok(request!.user.includes('(turn triggered by #5)'), request!.user);
  assert.ok(request!.user.endsWith('<candidates>\n1: #6 gate-failed\n2: #8 turn-error\n</candidates>'), request!.user);
  assert.deepEqual(
    request!.candidates.map((c) => c.messageId),
    ['m1', 'm2']
  );
  assert.equal(
    // @ts-expect-error `now` is left out: a request with an empty prompt is null whatever the clock
    buildCheckRequest({ prompt: ' ', labels, config: baseConfig(), selfName: 'Bot', history, candidates: [] }),
    null
  );
});

// ---- the registry: facts --------------------------------------------------------------

test('createMissed: the address helper\'s "no" is journaled as an address record with ids and no text, and is no candidate', async () => {
  const { missed, journal } = scene();
  missed.noteNotAddressed(msg({ id: 'm9', content: 'secret words' }));
  await flush();
  assert.deepEqual(missed.candidates(), []);
  const [entry] = journal.answers;
  assert.equal(entry.event, 'address');
  assert.equal(entry.verdict, 'not-addressed');
  assert.equal(entry.messageId, 'm9');
  assert.equal(entry.placeId, 'c1');
  assert.equal(entry.at, new Date(T0).toISOString());
  assert.ok(!JSON.stringify(journal.answers).includes('secret'));
});

test('createMissed: every fact source makes the right candidate, journaled with ids and no text', async () => {
  const { missed, journal } = scene();
  missed.noteFact(fact('gate-failed', msg({ id: 'm1', content: 'πού;' }), { failure: 'classifier-failed' }));
  missed.noteFact(fact('gate-failopen', msg({ id: 'm2', content: 'à quoi bon?' }), { failure: 'empty' }));
  missed.noteFact(fact('replaced-deferred', msg({ id: 'm3' }), { replacedBy: 'm4' }));
  const trigger = (id: string) => ({ id, authorId: 'u1', placeId: 'c1', ts: T0, content: 'ναι' });
  missed.onTurnEnd({
    chatId: 'c1',
    trigger: trigger('m5'),
    triggerKind: 'mention',
    outcome: 'error',
    reason: null,
    turnId: 't-5',
  });
  missed.onTurnEnd({
    chatId: 'c1',
    trigger: trigger('m6'),
    triggerKind: 'followUp',
    outcome: 'error',
    reason: 'too-slow',
  });
  missed.onTurnEnd({ chatId: 'c1', trigger: trigger('m7'), triggerKind: 'reply', outcome: 'not-now' });
  const byId = Object.fromEntries(missed.candidates().map((c) => [c.messageId, c]));
  assert.deepEqual(
    Object.values(byId).map((c) => [c.messageId, c.reason, c.state]),
    [
      ['m1', 'gate-failed', 'pending'],
      ['m2', 'gate-failopen', 'pending'],
      ['m3', 'replaced-deferred', 'pending'],
      ['m5', 'turn-error', 'pending'],
      ['m6', 'turn-dropped', 'pending'],
      ['m7', 'not-now', 'pending'],
    ]
  );
  assert.equal(byId.m2.question, true);
  assert.deepEqual(byId.m5.turnIds, ['t-5']);
  await flush();
  const facts = journal.answers.filter((record) => record.event === 'fact');
  assert.deepEqual(
    facts.map((record) => [record.messageId, record.reason]),
    Object.values(byId).map((c) => [c.messageId, c.reason])
  );
  const replaced = facts.find((record) => record.reason === 'replaced-deferred');
  assert.deepEqual(replaced!.sourceMessageIds, ['m3', 'm4']);
  assert.equal(replaced!.replacedBy, 'm4');
  assert.equal(facts[0].failure, 'classifier-failed');
  assert.equal(facts[0].placeId, 'c1');
  assert.deepEqual(facts[0].participants, ['u1']);
  assert.equal(facts[0].at, new Date(T0).toISOString());
  assert.ok(!JSON.stringify(journal.answers).includes('πού'), 'no message text in the journal');
});

test('createMissed: a skip, a refusal, an overheard line, a routed call and a recovery turn never make a candidate', () => {
  const { missed } = scene();
  const trigger = { id: 'm1', authorId: 'u1', placeId: 'c1', ts: T0, content: '' };
  missed.onTurnEnd({ chatId: 'c1', trigger, triggerKind: 'mention', outcome: 'skip' });
  missed.onTurnEnd({ chatId: 'c1', trigger, triggerKind: 'mention', outcome: 'refused' });
  missed.onTurnEnd({ chatId: 'c1', trigger, triggerKind: 'mention', outcome: 'busy' });
  missed.onTurnEnd({ chatId: 'c1', trigger, triggerKind: 'overheard', outcome: 'error' });
  missed.onTurnEnd({ chatId: 'c1', trigger, triggerKind: 'mention', outcome: 'error', routed: true });
  missed.onTurnEnd({
    chatId: 'c1',
    trigger,
    triggerKind: 'missed',
    outcome: 'not-now',
    reason: 'answered-meanwhile',
  });
  missed.onTurnEnd({ chatId: 'c1', trigger: null, mode: 'auto', outcome: 'not-now' });
  assert.deepEqual(missed.candidates(), []);
});

test("createMissed: a later turn of the persona's resolves the candidate, journaled resolved", async () => {
  const { missed, journal } = scene();
  missed.noteFact(fact('gate-failed', msg({ id: 'm1', ts: T0 })));
  missed.noteFact(fact('gate-failed', msg({ id: 'm2', authorId: 'u2', ts: T0 })));
  missed.onTurnEnd({
    chatId: 'c1',
    trigger: { id: 'm3', authorId: 'u1', ts: T0 + 1000 },
    triggerKind: 'mention',
    outcome: 'spoke',
    replyTargets: [],
    turnId: 't-9',
  });
  const states = Object.fromEntries(missed.candidates().map((c) => [c.messageId, c.state]));
  assert.deepEqual(states, { m1: 'resolved', m2: 'pending' });
  await flush();
  const resolved = journal.answers.filter((record) => record.event === 'resolved');
  assert.deepEqual(
    resolved.map((record) => [record.messageId, record.by, record.turnId]),
    [['m1', 'author', 't-9']]
  );
});

test('createMissed: the registry is written atomically to data/places/<id>/missed.json', async () => {
  const { missed, dataDir } = scene();
  // A candidate lands under its own place, the chat it was written in.
  await missed.start('c1');
  missed.noteFact(fact('gate-failed', msg({ id: 'm1' })));
  await missed.save();
  const file = path.join(dataDir, 'places', 'c1', 'missed.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.v, 1);
  assert.deepEqual(
    saved.candidates.map((c: { messageId: string }) => c.messageId),
    ['m1']
  );
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('createMissed: nothing is written before it is started on a named place', async () => {
  // Bug: a registry with no place named lands in whichever place came first.
  const { missed, dataDir } = scene();
  missed.noteFact(fact('gate-failed', msg({ id: 'm1' })));
  await missed.save();
  assert.equal(fs.existsSync(path.join(dataDir, 'places')), false);
  await missed.start('g1');
  await missed.save();
  assert.equal(fs.existsSync(path.join(dataDir, 'places', 'g1', 'missed.json')), true);
});

test('createMissed: nothing is written while paused', async () => {
  const { missed, dataDir } = scene({ paused: true });
  await missed.start('g1');
  missed.noteFact(fact('gate-failed', msg({ id: 'm1' })));
  await missed.save();
  assert.equal(fs.existsSync(path.join(dataDir, 'places', 'g1', 'missed.json')), false);
});

// ---- the sweep --------------------------------------------------------------------------

test('createMissed: the sweep waits sweepDelaySeconds after the last event, pushed back by activity up to the cap', () => {
  const { missed, clock, timers } = scene({
    config: baseConfig({ missed: { sweepDelaySeconds: 90, sweepMaxDelaySeconds: 240 } }),
  });
  missed.noteFact(fact('gate-failed', msg({ id: 'm1' })));
  assert.deepEqual(timers.due(), [T0 + 90_000]);
  clock.advance(60_000);
  missed.noteActivity('c1', clock());
  assert.deepEqual(timers.due(), [T0 + 150_000]);
  clock.advance(120_000);
  missed.noteActivity('c1', clock());
  assert.deepEqual(timers.due(), [T0 + 240_000], 'never past the cap');
  missed.noteActivity('c9', clock());
  assert.equal(timers.size(), 1, 'activity elsewhere arms nothing');
});

// The recovery turn is code, so the owed one gets its turn.
test('createMissed: the sweep filters by code and asks the helper once for the rest; the owed one gets its turn', async () => {
  const history = [
    msg({ id: 'm1', content: 'πού είσαι;', ts: T0 }),
    msg({ id: 'm2', authorId: 'u2', authorName: 'Zoë', ts: T0 + 1000 }),
    msg({ id: 'm3', authorId: 'u3', authorName: 'Léa', ts: T0 + 2000 }),
    msg({ id: 's1', self: true, ts: T0 + 3000, replyToId: 'm3' }),
  ];
  const llm = fakeLlm('{"verdicts":[{"n":1,"verdict":"owed"},{"n":2,"verdict":"stale"}]}');
  const turns = fakeTurns();
  const { missed, timers, journal, clock } = scene({ history, llm, turns });
  missed.noteFact(fact('gate-failed', history[0]));
  missed.noteFact(fact('turn-error', history[1]));
  missed.noteFact(fact('gate-failopen', history[2]));
  missed.noteFact(fact('gate-failed', msg({ id: 'old', ts: T0 - 10 * MIN })));
  await timers.fireAll();
  assert.equal(clock(), T0 + 90_000);
  assert.equal(llm.calls.length, 1, 'one helper call for the channel');
  const [helperCall] = llm.calls;
  assert.equal(helperCall.options.purpose, 'missed');
  assert.equal(helperCall.options.role, 'analyzer');
  const userMessage = helperCall.messages[1];
  const asked = userMessage.content;
  assert.ok(asked.includes('1: #1 gate-failed\n2: #2 turn-error'), asked);
  assert.equal(turns.calls.length, 1, 'one recovery turn for the owed line');
  const states = Object.fromEntries(missed.candidates().map((c) => [c.messageId, [c.state, c.verdict]]));
  assert.deepEqual(states, {
    m1: ['resolved', 'owed'],
    m2: ['dismissed', 'stale'],
    m3: ['resolved', null],
    old: ['expired', null],
  });
  await flush();
  const verdicts = journal.answers.filter((record) => record.event === 'verdict');
  assert.deepEqual(
    verdicts.map((record) => [record.messageId, record.verdict, record.by, record.shadow]),
    [
      ['m1', 'owed', 'model', false],
      ['m2', 'stale', 'model', false],
    ]
  );
  assert.deepEqual(
    journal.answers.filter((r) => r.event === 'resolved').map((r) => [r.messageId, r.by]),
    [['m3', 'history-reply']]
  );
  assert.deepEqual(
    journal.answers.filter((r) => r.event === 'expired').map((r) => r.messageId),
    ['old']
  );
});

test('createMissed: a failed or timed-out helper leaves every candidate unchecked, never owed', async () => {
  for (const answer of [new Error('timeout'), '']) {
    const history = [msg({ id: 'm1', ts: T0 })];
    const turns = fakeTurns();
    const { missed, timers, journal } = scene({
      history,
      llm: fakeLlm(answer),
      turns,
      config: baseConfig(),
    });
    missed.noteFact(fact('gate-failed', history[0]));
    await timers.fireAll();
    assert.deepEqual(
      missed.candidates().map((c) => [c.state, c.verdict]),
      [['dismissed', UNCHECKED]],
      String(answer)
    );
    assert.equal(turns.calls.length, 0);
    await flush();
    assert.equal(journal.answers.find((r) => r.event === 'verdict')?.verdict, UNCHECKED);
  }
});

test('createMissed: no sweep while paused', async () => {
  const history = [msg({ id: 'm1', ts: T0 })];
  const llm = fakeLlm('{"verdicts":[{"n":1,"verdict":"owed"}]}');
  const { missed, timers, store } = scene({ history, llm });
  missed.noteFact(fact('gate-failed', history[0]));
  const { data } = store.state;
  data.paused = true;
  await timers.fireAll();
  assert.equal(llm.calls.length, 0);
  assert.equal(missed.candidates()[0].state, 'pending');
});

// ---- recovery ---------------------------------------------------------------------------

test('createMissed: recovery starts one turn per channel with every owed candidate, the earliest as trigger', async () => {
  const history = [
    msg({ id: 'm1', content: 'πού είσαι;', ts: T0 }),
    msg({ id: 'm2', authorId: 'u2', authorName: 'Zoë', content: 'και η απάντηση;', ts: T0 + 1000 }),
  ];
  const turns = fakeTurns({ outcome: 'spoke' });
  const { missed, timers, journal } = scene({
    history,
    llm: fakeLlm('{"verdicts":[{"n":1,"verdict":"owed"},{"n":2,"verdict":"owed"}]}'),
    turns,
    config: baseConfig(),
  });
  missed.noteFact(fact('gate-failed', history[1]));
  missed.noteFact(fact('turn-error', history[0]));
  await timers.fireAll();
  assert.equal(turns.calls.length, 1);
  const call = turns.calls[0];
  assert.equal(call.triggerKind, 'missed');
  assert.equal(call.mode, 'reply');
  assert.equal(call.trigger.id, 'm1', 'the earliest');
  assert.deepEqual(call.missed, [
    { id: 'm1', author: 'Élodie', text: 'πού είσαι;' },
    { id: 'm2', author: 'Zoë', text: 'και η απάντηση;' },
  ]);
  assert.equal(typeof call.stillDue, 'function');
  assert.deepEqual(
    missed.candidates().map((c) => [c.messageId, c.state, c.attempts]),
    [
      ['m2', 'resolved', 1],
      ['m1', 'resolved', 1],
    ]
  );
  await flush();
  const recovery = journal.answers.find((record) => record.event === 'recovery');
  assert.deepEqual([recovery!.messageIds, recovery!.triggerId, recovery!.outcome], [['m1', 'm2'], 'm1', 'spoke']);
});

test('createMissed: a second owed candidate inside the channel cooldown waits for it; one attempt per candidate', async () => {
  const history = [msg({ id: 'm1', ts: T0 })];
  const turns = fakeTurns({ outcome: 'error' });
  const llm = fakeLlm('{"verdicts":[{"n":1,"verdict":"owed"}]}');
  const { missed, timers, clock, fetched } = scene({
    history,
    llm,
    turns,
    config: baseConfig(),
  });
  missed.noteFact(fact('gate-failed', history[0]));
  await timers.fireAll();
  assert.equal(turns.calls.length, 1);
  assert.equal(missed.candidates()[0].state, 'dismissed', 'a failed recovery is not tried again');

  clock.advance(30_000);
  const second = msg({ id: 'm2', ts: clock() });
  fetched.history = [second];
  missed.noteFact(fact('gate-failed', second));
  await timers.fireAll();
  assert.equal(turns.calls.length, 1, 'held by the cooldown');
  assert.deepEqual(
    missed.candidates().map((c) => [c.messageId, c.state, c.verdict]),
    [
      ['m1', 'dismissed', 'owed'],
      ['m2', 'pending', 'owed'],
    ]
  );
  assert.equal(timers.size(), 1, 'a sweep re-armed for the end of the cooldown');
  assert.ok(timers.due()[0] >= T0 + 90_000 + 5 * MIN, 'not before the cooldown ends');

  turns.runTurn = async (params) => {
    turns.calls.push(params);
    return { outcome: 'spoke' };
  };
  await timers.fireAll();
  assert.equal(llm.calls.length, 2, 'an owed candidate is not asked about twice');
  assert.equal(turns.calls.length, 2);
  const laterTurn = turns.calls[1];
  assert.equal(laterTurn.trigger.id, 'm2');
});

test('createMissed: the pre-post check fails once the persona spoke in the channel or another turn answered it', async () => {
  const history = [msg({ id: 'm1', ts: T0 })];
  let checks: Array<boolean> = [];
  const turns = fakeTurns({
    onRun: (params: TurnCall) => {
      checks.push(params.stillDue());
      // Another turn of the persona's answers the message while the recovery prepares.
      missed.onTurnEnd({
        chatId: 'c1',
        trigger: { id: 'm1', authorId: 'u1', ts: T0 },
        triggerKind: 'mention',
        outcome: 'spoke',
      });
      checks.push(params.stillDue());
      return { outcome: 'not-now', reason: 'answered-meanwhile' };
    },
  });
  const { missed, timers } = scene({
    history,
    llm: fakeLlm('{"verdicts":[{"n":1,"verdict":"owed"}]}'),
    turns,
    config: baseConfig(),
  });
  missed.noteFact(fact('gate-failed', history[0]));
  await timers.fireAll();
  assert.deepEqual(checks, [true, false]);
  assert.equal(missed.candidates()[0].state, 'resolved', 'answered by the other turn');

  // A post of the persona's in the channel since the recovery started.
  checks = [];
  const second = scene({
    history,
    llm: fakeLlm('{"verdicts":[{"n":1,"verdict":"owed"}]}'),
    turns: fakeTurns({ onRun: (params: TurnCall) => checks.push(params.stillDue()) && { outcome: 'not-now' } }),
    config: baseConfig(),
  });
  second.missed.noteFact(fact('gate-failed', history[0]));
  second.turns.lastPost = T0 + 10 * MIN;
  await second.timers.fireAll();
  assert.deepEqual(checks, [false]);
});

test('createMissed: no recovery where the bot cannot write, and a busy attention holds it', async () => {
  const history = [msg({ id: 'm1', ts: T0 })];
  const mute = scene({
    history,
    llm: fakeLlm('{"verdicts":[{"n":1,"verdict":"owed"}]}'),
    canSend: () => false,
    config: baseConfig(),
  });
  mute.missed.noteFact(fact('gate-failed', history[0]));
  await mute.timers.fireAll();
  const muteCalls = mute.turns.calls;
  assert.equal(muteCalls.length, 0);
  assert.equal(mute.missed.candidates()[0].state, 'dismissed');

  const busy = scene({
    history,
    llm: fakeLlm('{"verdicts":[{"n":1,"verdict":"owed"}]}'),
    turns: fakeTurns({ busy: true }),
    config: baseConfig(),
  });
  busy.missed.noteFact(fact('gate-failed', history[0]));
  await busy.timers.fireAll();
  const busyCalls = busy.turns.calls;
  assert.equal(busyCalls.length, 0);
  assert.deepEqual(
    busy.missed.candidates().map((c) => [c.state, c.attempts]),
    [['pending', 0]]
  );
  assert.equal(busy.timers.size(), 1);
});

test('createMissed: the reasons of a call that left the pending queue are candidates', () => {
  const { missed } = scene();
  for (const reason of ['pending-full', 'pending-expired', 'pending-outranked'])
    missed.noteFact(fact(reason, msg({ id: `m-${reason}` })));
  assert.deepEqual(
    missed.candidates().map((c) => c.reason),
    ['pending-full', 'pending-expired', 'pending-outranked']
  );
});

test("createMissed: a private chat's fact goes to that person's private journal and its recovery turn runs in the chat only after the gate", async () => {
  const dm = { id: 'd1', recipientId: 'u1' };
  const history = [msg({ id: 'm1', ts: T0, placeId: 'd1' })];
  const config = baseConfig();
  const refused = scene({ history, llm: fakeLlm('{"verdicts":[{"n":1,"verdict":"owed"}]}'), channels: [dm], config });
  refused.missed.noteFact(fact('pending-full', history[0]));
  await refused.timers.fireAll();
  await flush();
  const refusedAnswers = refused.journal.answers;
  assert.equal(refusedAnswers.find((record) => record.event === 'fact')!.holder, 'd1');
  const refusedCalls = refused.turns.calls;
  assert.equal(refusedCalls.length, 0, 'no gate, no recovery');
  assert.deepEqual(
    refused.missed.candidates().map((c) => [c.placeId, c.state]),
    [['d1', 'dismissed']]
  );

  const seen: Array<Array<unknown>> = [];
  const allowed = scene({ history, llm: fakeLlm('{"verdicts":[{"n":1,"verdict":"owed"}]}'), channels: [dm], config });
  allowed.missed.setPrivateRecovery({
    allow: async (channel: { id: string }, trigger: { id: string }) => seen.push(['allow', channel.id, trigger.id]) > 0,
    after: async (channel: { id: string }, trigger: unknown, result: { outcome: string }) =>
      seen.push(['after', channel.id, result.outcome]),
  });
  allowed.missed.noteFact(fact('pending-expired', history[0]));
  await allowed.timers.fireAll();
  const allowedCalls = allowed.turns.calls;
  assert.equal(allowedCalls.length, 1);
  const recovery = allowedCalls[0];
  assert.equal(recovery.chat.chatId, 'd1');
  assert.equal('placeId' in recovery, false, 'a private chat is served on behalf of no other place');
  assert.deepEqual(seen, [
    ['allow', 'd1', 'm1'],
    ['after', 'd1', 'spoke'],
  ]);
});

// ---- restart ------------------------------------------------------------------------------

test('reconcileFromRecords: facts of the last hour come back; later verdicts and turns close them', () => {
  const at = (ms: number) => new Date(ms).toISOString();
  const now = T0 + 30 * MIN;
  const scope = { channel: 'c1' };
  const records = [
    {
      kind: 'answer',
      event: 'fact',
      occurredAt: at(T0 - 2 * 60 * MIN),
      scope,
      messageId: 'ancient',
      reason: 'gate-failed',
      at: at(T0 - 2 * 60 * MIN),
    },
    {
      kind: 'answer',
      event: 'fact',
      occurredAt: at(T0),
      scope,
      messageId: 'm1',
      authorId: 'u1',
      reason: 'gate-failed',
      at: at(T0),
      question: true,
    },
    {
      kind: 'answer',
      event: 'fact',
      occurredAt: at(T0 + MIN),
      scope,
      messageId: 'm2',
      authorId: 'u2',
      reason: 'turn-error',
      at: at(T0 + MIN),
    },
    {
      kind: 'answer',
      event: 'fact',
      occurredAt: at(T0 + MIN),
      scope,
      messageId: 'm3',
      authorId: 'u3',
      reason: 'not-now',
      at: at(T0 + MIN),
    },
    {
      kind: 'answer',
      event: 'fact',
      occurredAt: at(T0 + MIN),
      scope,
      messageId: 'm4',
      authorId: 'u4',
      reason: 'gate-failed',
      at: at(T0 + MIN),
    },
    { kind: 'answer', event: 'verdict', occurredAt: at(T0 + 3 * MIN), scope, messageId: 'm2', verdict: 'stale' },
    {
      kind: 'turn.start',
      occurredAt: at(T0 + 4 * MIN),
      scope,
      turnId: 't-1',
      trigger: { kind: 'mention', messageId: 'm3', authorId: 'u3' },
    },
    {
      kind: 'turn',
      occurredAt: at(T0 + 5 * MIN),
      scope,
      turnId: 't-1',
      outcome: 'spoke',
      posted: [{ messageId: 's1', replyTo: 'm3' }],
    },
    { kind: 'answer', event: 'recovery', occurredAt: at(T0 + 6 * MIN), scope, messageIds: ['m4'], outcome: 'error' },
  ];
  const { list, added, closed } = reconcileFromRecords([], records, { now });
  assert.equal(added, 4);
  assert.equal(closed, 3);
  assert.deepEqual(
    list.map((c) => [c.messageId, c.state]),
    [
      ['m1', 'pending'],
      ['m2', 'dismissed'],
      ['m3', 'resolved'],
      ['m4', 'dismissed'],
    ]
  );
  assert.equal(list[0].question, true);
  assert.equal(list[0].at, T0);
});

test('createMissed: a restart loads missed.json, reconciles the journal of the last hour and arms the sweep', async () => {
  const dataDir = tmpData();
  const first = scene({ dataDir });
  // A candidate lands under its own place, and a stored fact names its interface.
  await first.missed.start('c1');
  first.missed.noteFact(fact('gate-failed', msg({ id: 'm1' })));
  await first.missed.save();

  const at = new Date(T0 + MIN).toISOString();
  const journal = fakeJournal([
    {
      kind: 'answer',
      event: 'fact',
      iface: 'fake',
      occurredAt: at,
      scope: { channel: 'c1' },
      messageId: 'm2',
      authorId: 'u2',
      reason: 'replaced-deferred',
      at,
    },
    {
      kind: 'turn.start',
      occurredAt: at,
      scope: { channel: 'c1' },
      turnId: 't-2',
      trigger: { messageId: 'm1', authorId: 'u1' },
    },
    { kind: 'turn', occurredAt: at, scope: { channel: 'c1' }, turnId: 't-2', outcome: 'skip', posted: [] },
  ]);
  const second = scene({ dataDir, journal });
  second.clock.set(T0 + 2 * MIN);
  await second.missed.start('c1');
  assert.deepEqual(
    second.missed.candidates().map((c) => [c.messageId, c.state]),
    [
      ['m1', 'resolved'],
      ['m2', 'pending'],
    ]
  );
  assert.equal(second.timers.size(), 1, 'a sweep for the pending one');
  const logged = second.log.lines;
  assert.ok(logged.some((line) => line.msg === 'missed: reconciled' && line.added === 1 && line.closed === 1));
});

test('createMissed: a broken missed.json is moved aside, never overwritten in place', async () => {
  const dataDir = tmpData();
  const dir = path.join(dataDir, 'places', 'g1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'missed.json'), '{ broken');
  const { missed } = scene({ dataDir });
  await missed.start('g1');
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('missed.json.bad-')));
  assert.deepEqual(missed.candidates(), []);
});

test("createMissed: a turn that ended in an error keeps its reason as the fact's failure; one without a reason has none", async () => {
  const { missed, journal } = scene();
  const trigger = (id: string) => ({ id, authorId: 'u1', placeId: 'c1', ts: T0, content: 'ναι' });
  missed.onTurnEnd({
    chatId: 'c1',
    trigger: trigger('m1'),
    triggerKind: 'mention',
    outcome: 'error',
    reason: 'cut-off',
    turnId: 't-1',
  });
  missed.onTurnEnd({
    chatId: 'c1',
    trigger: trigger('m2'),
    triggerKind: 'reply',
    outcome: 'error',
    reason: null,
  });
  assert.deepEqual(
    missed.candidates().map((c) => [c.messageId, c.reason, c.state]),
    [
      ['m1', 'turn-error', 'pending'],
      ['m2', 'turn-error', 'pending'],
    ]
  );
  await flush();
  const facts = journal.answers.filter((record) => record.event === 'fact');
  assert.deepEqual(
    facts.map((record) => [record.messageId, record.reason, record.failure ?? null, record.turnId ?? null]),
    [
      ['m1', 'turn-error', 'cut-off', 't-1'],
      ['m2', 'turn-error', null, null],
    ]
  );
});

test("createMissed: a failed turn opened by a finished errand (task) is a candidate like a failed mention, a private chat's too", () => {
  const { missed } = scene();
  const trigger = (id: string) => ({ id, authorId: 'u1', placeId: 'c1', ts: T0, content: 'ναι' });
  missed.onTurnEnd({
    chatId: 'c1',
    trigger: trigger('m1'),
    triggerKind: 'errand',
    outcome: 'error',
    reason: 'cut-off',
  });
  missed.onTurnEnd({
    chatId: 'd1',
    trigger: { ...trigger('m2'), placeId: 'd1' },
    triggerKind: 'private',
    outcome: 'error',
    dmChat: true,
  });
  assert.deepEqual(
    missed.candidates().map((c) => [c.messageId, c.reason, c.placeId]),
    [
      ['m1', 'turn-error', 'c1'],
      ['m2', 'turn-error', 'd1'],
    ]
  );
});

test('missed candidates saved through the writer survive reopening without missed.json', async () => {
  let memory = await openTestMemory({ now: () => T0 });
  const dataDir = memory.dataDir;
  let current = scene({ dataDir, memoryDb: memory.memoryDb });
  const file = path.join(dataDir, 'places/c1/missed.json');
  try {
    // A candidate lands under its own place.
    await current.missed.start('c1');
    current.missed.noteFact(fact('gate-failed', msg({ id: 'persisted-candidate' })));
    await current.missed.save();
    assert.equal(fs.existsSync(file), false);
    current.missed.stop();
    await memory.close();
    memory = await openTestMemory({ dataDir, now: () => T0 });
    current = scene({ dataDir, memoryDb: memory.memoryDb });
    await current.missed.start('c1');
    assert.deepEqual(
      current.missed.candidates().map((candidate) => [candidate.messageId, candidate.state]),
      [['persisted-candidate', 'pending']]
    );
    assert.equal(fs.existsSync(file), false);
  } finally {
    current.missed.stop();
    await memory.close();
  }
});

// --- the strict JSON answer of the sweep ------------------------------------------------------
// The sweep's analyzer call is read by parseMissedAnswer: the request hands the client MISSED_FORMAT as
// `responseFormat`, an object `{ "verdicts": [{ "n": number, "verdict": one of MISSED_VERDICTS }] }` gives the verdicts
// the `n: word` lines gave (a candidate with no verdict, or with two different ones, is `uncertain`), every other
// answer, the old lines included, is an unreadable answer that leaves every candidate `uncertain`, and a blank answer
// leaves every one `unchecked`.

const JSON_T0 = Date.UTC(2026, 10, 6, 12, 0, 0);

/** A normalized member line of #c1, as a fact carries it. */
function jsonMemberLine(id: string, ts: number) {
  return {
    id,
    placeId: 'c1',
    authorId: `u-${id}`,
    authorName: `Member ${id}`,
    self: false,
    bot: false,
    content: 'και λοιπόν;',
    ts,
    replyToId: null,
    mentionedAccountIds: [],
  };
}

type JsonMemberLine = ReturnType<typeof jsonMemberLine>;
type SeedEvent = ReturnType<typeof world>['port']['seedEvent'];

/** The `message.received` event of a line, as the interface delivers it. */
function jsonEventOf(line: JsonMemberLine): Parameters<SeedEvent>[0] {
  return {
    kind: 'message.received',
    iface: 'fake',
    at: line.ts,
    id: `fake:message:${line.id}`,
    chat: { id: 'c1', kind: 'channel', rootId: 'g1', name: 'c1' },
    message: {
      id: line.id,
      author: { id: line.authorId, name: line.authorName, self: false, bot: false },
      content: line.content,
      sourceText: line.content,
      system: false,
      at: line.ts,
      replyToId: null,
      replyPingAccountId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
  };
}

type Sent = { options: { responseFormat?: unknown; purpose?: unknown } };

/**
 * Three candidates of #c1 (`m1`, `m2`, `m3`, numbered 1 to 3 in the request), one sweep whose analyzer answers
 * `text`. Resolves each candidate's verdict, in order, and the request options.
 */
async function sweep(text: string) {
  const lines = [
    jsonMemberLine('m1', JSON_T0),
    jsonMemberLine('m2', JSON_T0 + 1000),
    jsonMemberLine('m3', JSON_T0 + 2000),
  ];
  world().channel({ id: 'c1', placeId: 'g1' });
  for (const line of lines) world().port.seedEvent(jsonEventOf(line));
  const sent: Array<Sent> = [];
  const quiet = { info() {}, warn() {}, error() {} };
  const missed = createMissed({
    hot: {
      config: { bot: { timezone: 'UTC' }, missed: {}, models: {}, llm: {} },
      prompts: { 'classify/missed': 'Check for {{name}}.', labels },
    },
    store: { mediaNameOf: noMediaNames, state: { data: {} } },
    llm: {
      complete: (_messages: unknown, options: Sent['options']) => {
        sent.push({ options });
        return Promise.resolve({ text });
      },
    },
    turns: {
      triggerOf: () => null,
      lastPostAt: () => 0,
      isBusy: () => true,
      isAnyBusy: () => true,
      runTurn: () => Promise.resolve({ outcome: 'spoke' }),
    },
    reads: world().reads,
    getSelfName: () => 'Nova',
    dataDir: tempDir('nep-missed-json-'),
    now: () => JSON_T0 + 60_000,
    timers: { set: () => null, clear() {} },
    log: quiet,
  });
  for (const line of lines) missed.noteFact({ reason: 'gate-failed', message: line, iface: 'fake' });
  await missed.sweep('fake', 'c1');
  const byId = new Map(missed.candidates().map((candidate) => [candidate.messageId, candidate.verdict]));
  return { verdicts: lines.map((line) => byId.get(line.id) ?? null), sent };
}

/** Answers that are not the object, or whose `verdicts` is not a list: each leaves every candidate uncertain. */
const UNREADABLE = [
  '1: owed\n2: stale\n3: resolved',
  '1. owed',
  'owed',
  'All three are owed.',
  '{}',
  '{"verdict":[{"n":1,"verdict":"owed"}]}',
  '{"verdicts":"owed"}',
  '{"verdicts":null}',
  '{"verdicts":{"n":1,"verdict":"owed"}}',
  '[{"n":1,"verdict":"owed"}]',
  '"owed"',
  'null',
  '{"verdicts":[{"n":1,"verdict":"owed"}]',
  '```json\n{"verdicts":[{"n":1,"verdict":"owed"}]}\n```',
];

const ALL_UNCERTAIN = ['uncertain', 'uncertain', 'uncertain'];

type Schema = {
  type?: unknown;
  additionalProperties?: unknown;
  required?: Array<string>;
  properties?: Record<string, Schema & { items?: Schema; enum?: Array<string> }>;
};

test('the missed check hands the client MISSED_FORMAT as its responseFormat', async () => {
  const { sent } = await sweep('{"verdicts":[]}');
  assert.equal(sent.length, 1);
  const [request] = sent;
  assert.equal(request.options.purpose, 'missed');
  assert.deepEqual(request.options.responseFormat, MISSED_FORMAT);
});

test('MISSED_FORMAT is a closed object holding a list of closed entries of a number and one of the five verdicts', () => {
  assert.match(MISSED_FORMAT.name, /^[A-Za-z0-9_-]{1,64}$/);
  const schema = MISSED_FORMAT.schema as Schema;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['verdicts']);
  assert.deepEqual(Object.keys(schema.properties ?? {}), ['verdicts']);
  const list = schema.properties?.verdicts;
  assert.equal(list?.type, 'array');
  const entry = list?.items;
  assert.equal(entry?.type, 'object');
  assert.equal(entry?.additionalProperties, false);
  assert.deepEqual([...(entry?.required ?? [])].sort(), ['n', 'verdict']);
  const fields = entry?.properties;
  assert.equal(fields?.n?.type, 'integer');
  assert.deepEqual([...(fields?.verdict?.enum ?? [])].sort(), [...MISSED_VERDICTS].sort());
});

test('a well-formed answer gives each candidate the verdict of its number, in any order', async () => {
  const answer = {
    verdicts: [
      { n: 3, verdict: 'stale' },
      { n: 1, verdict: 'owed' },
      { n: 2, verdict: 'intentional-skip' },
    ],
  };
  const { verdicts } = await sweep(JSON.stringify(answer));
  assert.deepEqual(verdicts, ['owed', 'intentional-skip', 'stale']);
});

test('a candidate no entry names is uncertain, the others keep theirs', async () => {
  const { verdicts } = await sweep(JSON.stringify({ verdicts: [{ n: 2, verdict: 'resolved' }] }));
  assert.deepEqual(verdicts, ['uncertain', 'resolved', 'uncertain']);
});

test('an unreadable answer, the old lines included, leaves every candidate uncertain', async () => {
  for (const text of UNREADABLE) {
    const { verdicts } = await sweep(text);
    assert.deepEqual(verdicts, ALL_UNCERTAIN, JSON.stringify(text));
  }
});

test('a blank answer leaves every candidate unchecked', async () => {
  const { verdicts } = await sweep('  ');
  assert.deepEqual(verdicts, [UNCHECKED, UNCHECKED, UNCHECKED]);
});

test('parseMissedAnswer reads one verdict per number of the object text', () => {
  const answer = JSON.stringify({
    verdicts: [
      { n: 2, verdict: 'resolved' },
      { n: 1, verdict: 'owed' },
      { n: 4, verdict: 'stale' },
      { n: 3, verdict: 'uncertain' },
    ],
  });
  assert.deepEqual(parseMissedAnswer(answer, 4), {
    verdicts: ['owed', 'resolved', 'uncertain', 'stale'],
    empty: false,
  });
});

test('parseMissedAnswer makes a candidate named twice with different verdicts uncertain, twice alike keeps it', () => {
  const answer = JSON.stringify({
    verdicts: [
      { n: 1, verdict: 'owed' },
      { n: 1, verdict: 'stale' },
      { n: 2, verdict: 'resolved' },
      { n: 2, verdict: 'resolved' },
    ],
  });
  assert.deepEqual(parseMissedAnswer(answer, 2).verdicts, ['uncertain', 'resolved']);
});

test('parseMissedAnswer skips an entry with a number outside the candidates or a verdict outside the five', () => {
  const answer = JSON.stringify({
    verdicts: [
      { n: 1, verdict: 'owed' },
      { n: 2, verdict: 'maybe' },
      { n: 9, verdict: 'stale' },
      { n: 0, verdict: 'stale' },
      { n: 3, verdict: 'OWED' },
    ],
  });
  assert.deepEqual(parseMissedAnswer(answer, 3).verdicts, ['owed', 'uncertain', 'uncertain']);
});

test('parseMissedAnswer skips an entry of the wrong shape and keeps the others', () => {
  const answer = JSON.stringify({
    verdicts: [
      { n: '1', verdict: 'owed' },
      { n: 2 },
      { n: 1.5, verdict: 'stale' },
      null,
      'owed',
      { n: 3, verdict: 'resolved' },
    ],
  });
  assert.deepEqual(parseMissedAnswer(answer, 3).verdicts, ['uncertain', 'uncertain', 'resolved']);
});

test('parseMissedAnswer leaves every candidate uncertain for an unreadable answer and unchecked for no answer', () => {
  for (const text of UNREADABLE) {
    assert.deepEqual(parseMissedAnswer(text, 3), { verdicts: ALL_UNCERTAIN, empty: false }, JSON.stringify(text));
  }
  for (const text of ['', '   ', null, undefined]) {
    assert.deepEqual(
      parseMissedAnswer(text, 2),
      { verdicts: [UNCHECKED, UNCHECKED], empty: true },
      JSON.stringify(text)
    );
  }
});

// --- every group place and every DM on every interface ----------------------------------------
// Each place has a registry of its own. `createMissed` takes no `iface`; `noteFact({ reason, message, iface })` names
// the line's interface and the candidate keeps it, so its sweep reads its chat there and its recovery turn runs there.
// `start(placeId)` adds the stored registry of that place to the ones already started; `save()` writes each candidate
// under the unit `missed` of its own place.

const PLACES_T0 = Date.parse('2026-11-05T12:00:00Z');
const PLACES_MINUTE = 60_000;

type Spot = { iface: string; place: Partial<ChatInfo> & { id: string } };

const GROUP_A: Spot = { iface: 'alpha', place: { id: 'c1', kind: 'channel', rootId: 'g1' } };
const GROUP_B: Spot = { iface: 'beta', place: { id: 'r1', kind: 'channel', rootId: 'r1' } };
const DM_B: Spot = { iface: 'beta', place: { id: 'd1', kind: 'dm', chatType: 'dm', rootId: null, partnerId: 'u1' } };
/** A place on another interface under the native id of GROUP_A. */
const TWIN: Spot = { iface: 'beta', place: { id: 'c1', kind: 'channel', rootId: 'r9' } };

type PlacesLlmCall = { user: string; options: { purpose?: string } };
type PlacesTurnCall = { chat: { iface: string; chatId: string }; triggerKind: string };

function placesMemberLine(spot: Spot, id: string, at: number) {
  return {
    id,
    placeId: spot.place.id,
    authorId: 'u1',
    authorName: 'Eleni',
    self: false,
    bot: false,
    content: 'έχεις νέα;',
    ts: at,
    replyToId: null,
  };
}

function placesEventOf(spot: Spot, line: ReturnType<typeof placesMemberLine>) {
  return {
    kind: 'message.received',
    iface: spot.iface,
    at: line.ts,
    id: `${spot.iface}:message:${line.id}`,
    // The place carries its own `id`, so it is not written twice.
    chat: { kind: 'channel', name: spot.place.id, ...spot.place },
    message: {
      id: line.id,
      author: { id: line.authorId, name: line.authorName, self: false, bot: false },
      content: line.content,
      sourceText: line.content,
      system: false,
      at: line.ts,
      replyToId: null,
      replyPingAccountId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
  };
}

/** One registry over a fake adapter per interface, with hand timers and a fake model. */
function placesScene({
  spots,
  answer = '{"verdicts":[{"n":1,"verdict":"uncertain"}]}',
  memoryDb,
  partners = {},
}: {
  spots: Array<Spot>;
  answer?: string;
  memoryDb?: unknown;
  partners?: Record<string, string>;
}) {
  const quiet = { info() {}, warn() {}, error() {} };
  const fakes = new Map<string, ReturnType<typeof createFakeAdapter>>();
  const readsOf = new Map<string, ReturnType<typeof createReads>>();
  const adapterOf = (iface: string) => {
    let fake = fakes.get(iface);
    if (!fake) {
      fake = createFakeAdapter({ iface, selfId: 'self-id' });
      fakes.set(iface, fake);
      readsOf.set(iface, createReads(fake, quiet));
    }
    return fake;
  };
  for (const spot of spots)
    adapterOf(spot.iface).seedChat(channelOf(spot.place.id, { iface: spot.iface, ...spot.place }));
  const reads = new Proxy(
    {},
    {
      get:
        (_target, name: string) =>
        (first: { iface?: string }, ...rest: Array<unknown>) => {
          const target = readsOf.get(String(first?.iface)) as unknown as
            Record<string, (...args: Array<unknown>) => unknown> | undefined;
          return target ? target[name]?.(first, ...rest) : Promise.resolve(null);
        },
    }
  );
  const pending: Array<() => unknown> = [];
  const llmCalls: Array<PlacesLlmCall> = [];
  const turnCalls: Array<PlacesTurnCall> = [];
  let at = PLACES_T0;
  const missed = createMissed(
    wrongly<Parameters<typeof createMissed>[0]>({
      hot: {
        config: { bot: { timezone: 'UTC' }, missed: {}, models: {}, llm: {} },
        prompts: { 'classify/missed': 'Check {{name}}.', labels },
      },
      store: { state: { data: { paused: false } }, mediaNameOf: noMediaNames },
      journal: null,
      llm: {
        complete: (messages: Array<{ content: unknown }>, options: PlacesLlmCall['options']) => {
          llmCalls.push({ user: JSON.stringify(messages[1]?.content), options });
          return Promise.resolve({ text: answer });
        },
      },
      turns: {
        triggerOf: () => null,
        lastPostAt: () => 0,
        isBusy: () => false,
        isAnyBusy: () => false,
        runTurn: (params: PlacesTurnCall) => {
          turnCalls.push(params);
          return Promise.resolve({ outcome: 'spoke' });
        },
      },
      reads,
      partnerOf: (id: string) => partners[id] ?? null,
      getSelfName: () => 'Nova',
      dataDir: tempDir('nep-missed-places-'),
      ...(memoryDb ? { memoryDb } : {}),
      now: () => at,
      timers: {
        set: (fn: () => unknown) => {
          pending.push(fn);
          return pending.length;
        },
        clear() {},
      },
      log: quiet,
    })
  );
  /** Seeds a line of `spot` into that interface's history. */
  function seedLine(spot: Spot, id: string) {
    const line = placesMemberLine(spot, id, at);
    const event = placesEventOf(spot, line);
    adapterOf(spot.iface).seedEvent(wrongly<Parameters<ReturnType<typeof createFakeAdapter>['seedEvent']>[0]>(event));
    return line;
  }
  /** Notes a failed gate on a line of `spot`. */
  function failGate(spot: Spot, id: string) {
    missed.noteFact(wrongly({ reason: 'gate-failed', message: seedLine(spot, id), iface: spot.iface }));
  }
  /** Moves past the sweep delay and fires every armed sweep. */
  async function sweep() {
    at += 2 * PLACES_MINUTE;
    for (const fn of pending.splice(0)) await fn();
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }
  return { missed, failGate, seedLine, sweep, llmCalls, turnCalls };
}

test('a candidate on a second interface is checked in its own place', async () => {
  // Bug: `iface()` answers one interface, so the sweep finds no chat and the owed line is lost.
  const run = placesScene({ spots: [GROUP_A, GROUP_B] });
  await run.missed.start('r1');
  run.failGate(GROUP_B, 'm1');
  await run.sweep();
  assert.deepEqual(
    run.llmCalls.map((call) => call.options.purpose),
    ['missed']
  );
});

test('a candidate in a DM on a second interface is checked in that DM', async () => {
  // Bug: the private path assumes the home interface.
  const run = placesScene({ spots: [GROUP_A, DM_B], partners: { d1: 'u1' } });
  await run.missed.start('d1');
  run.failGate(DM_B, 'm1');
  await run.sweep();
  assert.equal(run.llmCalls.length, 1);
});

test('two candidates under one native id on two interfaces are checked apart', async () => {
  // Bug: the sweep is keyed by the native id, so one interface's place swallows the other's line.
  const run = placesScene({ spots: [GROUP_A, TWIN] });
  await run.missed.start('c1');
  run.failGate(GROUP_A, 'm1');
  run.failGate(TWIN, 'm2');
  await run.sweep();
  assert.equal(run.llmCalls.length, 2);
});

test('an owed line on a second interface gets its recovery turn there', async () => {
  // Bug: the recovery turn opens on the home interface, or none opens at all.
  const run = placesScene({ spots: [GROUP_A, GROUP_B], answer: '{"verdicts":[{"n":1,"verdict":"owed"}]}' });
  await run.missed.start('r1');
  run.failGate(GROUP_B, 'm1');
  await run.sweep();
  assert.equal(run.turnCalls.length, 1);
  const [recovery] = run.turnCalls;
  assert.deepEqual(recovery?.chat, { iface: 'beta', chatId: 'r1' });
  assert.equal(recovery?.triggerKind, 'missed');
});

test('starting a second place keeps the candidates of the first', async () => {
  // Bug: `start` replaces the one registry, so the second place wipes the first from memory.
  const { memoryDb } = await openTestMemory();
  const run = placesScene({ spots: [GROUP_A, GROUP_B], memoryDb });
  await run.missed.start('c1');
  run.failGate(GROUP_A, 'm1');
  await run.missed.start('r1');
  assert.deepEqual(
    run.missed.candidates().map((candidate) => candidate.messageId),
    ['m1']
  );
});

test('each candidate is stored under its own place and comes back with that place alone', async () => {
  // Bug: every candidate lands in the unit of the one loaded place, so a place's registry holds another's lines.
  const { memoryDb } = await openTestMemory();
  const first = placesScene({ spots: [GROUP_A, GROUP_B, DM_B], memoryDb, partners: { d1: 'u1' } });
  await first.missed.start('c1');
  await first.missed.start('r1');
  await first.missed.start('d1');
  first.failGate(GROUP_A, 'm1');
  first.failGate(GROUP_B, 'm2');
  first.failGate(DM_B, 'm3');
  await first.missed.save();

  for (const [place, expected] of [
    ['c1', 'm1'],
    ['r1', 'm2'],
    ['d1', 'm3'],
  ] as const) {
    const after = placesScene({ spots: [GROUP_A, GROUP_B, DM_B], memoryDb, partners: { d1: 'u1' } });
    await after.missed.start(place);
    assert.deepEqual(
      after.missed.candidates().map((candidate) => candidate.messageId),
      [expected],
      place
    );
  }
});

test('a candidate comes back after a restart with its interface, and its sweep runs there', async () => {
  // Bug: the stored candidate loses `iface`, so a recovery after a restart reads the wrong interface.
  const { memoryDb } = await openTestMemory();
  const first = placesScene({ spots: [GROUP_A, GROUP_B], memoryDb });
  await first.missed.start('r1');
  first.failGate(GROUP_B, 'm1');
  await first.missed.save();

  const after = placesScene({ spots: [GROUP_A, GROUP_B], memoryDb });
  after.seedLine(GROUP_B, 'm1');
  await after.missed.start('r1');
  await after.sweep();
  assert.equal(after.llmCalls.length, 1);
});

test('a place with nothing stored starts with an empty registry', async () => {
  // Bug: a place never seen before throws at start and stops the core from coming up.
  const { memoryDb } = await openTestMemory();
  const run = placesScene({ spots: [GROUP_B], memoryDb });
  await run.missed.start('r1');
  assert.deepEqual(run.missed.candidates(), []);
});

const worldChannelsOf = (channels: Parameters<typeof worldChannels>[1]) => worldChannels(GUILD, channels);

/** The fixed words of a label before its first placeholder. */
const labelHead = (label: string) => label.split('{')[0];

const promptsShippedCreateMissed = loose(createMissed);

// ---- the shipped layer --------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const PROMPTS_DIR = path.join(ROOT, 'prompts');

/** The tracked prompt files at any depth, by key: the path relative to prompts/ without `.md`, `/` between the parts. */
const PROMPT_FILES = fs
  .readdirSync(PROMPTS_DIR, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.md'))
  .map((file) => file.slice(0, -'.md'.length).split(path.sep).join('/'))
  .sort();

const BOM = String.fromCharCode(0xfeff);

/** `prompts/<name>.md` as src/hot.ts reads it: the BOM and carriage returns dropped, trimmed. */
function readPrompt(name: string) {
  const text = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8');
  return (text.startsWith(BOM) ? text.slice(1) : text).replace(/\r\n/g, '\n').trim();
}

/** The tracked layer alone: config/ with the labels read joined, and prompts/, never a local override. */
const SHIPPED = {
  config: JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8')),
  prompts: {
    ...Object.fromEntries(PROMPT_FILES.map((name) => [name, readPrompt(name)])),
    labels: joinLabels(JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'labels.json'), 'utf8'))),
  },
};

// The shipped labels carry the keys of the contract (the fixture covers every one).
const LABELS = SHIPPED.prompts.labels as typeof labels;

/**
 * A prompt that carries `{{` or a `{key}` as text on purpose: its file name -> `{ literal, why }`.
 * The literal may remain in a request; anything else in braces may not. None today.
 */
const LITERAL_BRACES: Record<string, { literal: string; why: string }> = {};

/** `text` without the literals of LITERAL_BRACES. */
function withoutLiterals(text: string) {
  let rest = text;
  for (const { literal } of Object.values(LITERAL_BRACES)) rest = rest.split(literal).join('');
  return rest;
}

// The rules prompt reaches a request only while the memory table `rules` holds a rule (src/rules-list.ts). The requests
// here are built with no memory, the way a deployment starts, so it stays in NOT_BUILT: putting it in SYSTEM would mean
// a rule in every fixture, and tests/src/rules-list.test.ts already checks the block with and without one.
const SYSTEM = ['main', 'persona', 'format'];

/** Every kind of diary entry and the prompt file of its own task, which follows the common `diary/task.md`. */
const DIARY_KIND_FILES: Record<string, string> = Object.fromEntries(
  ['story', 'selfPicture', 'picture', 'photoset', 'randomSet', 'news', 'facts', 'thought', 'people', 'meme'].map(
    (kind) => [kind, `diary/kinds/${kind}`]
  )
);

/** The prompt files each request below must carry whole, by request. */
const LOADS = {
  reply: [...SYSTEM, 'turn/reply'],
  followUp: [...SYSTEM, 'turn/follow'],
  overheard: [...SYSTEM, 'turn/overheard'],
  errandResult: [...SYSTEM, 'turn/errand'],
  private: [...SYSTEM, 'turn/reply', 'turn/private'],
  draw: ['draw', 'appearance'],
  ...Object.fromEntries(
    Object.entries(DIARY_KIND_FILES).map(([kind, file]) => [`diary ${kind}`, [...SYSTEM, 'diary/task', file]])
  ),
  inner: [...SYSTEM, 'turn/inner'],
  heartbeat: [...SYSTEM, 'heartbeat/task'],
  describe: ['describe/picture'],
  avatar: ['describe/avatar'],
  describeGif: ['describe/gif'],
  describeVideo: ['describe/video'],
  rewatchAnswer: ['describe/rewatch'],
  searchSummary: ['summarize/search'],
  split: ['classify/split'],
  merge: ['classify/merge'],
  missed: ['classify/missed'],
  mediaPick: ['classify/pick'],
  humanizer: ['humanizer/linter', 'humanizer/editor'],
  turn: [...SYSTEM, 'turn/reply'],
};

/** The shipped config.json with `overrides` deep-merged over a fresh copy. */
function shippedConfig(overrides: Record<string, unknown> = {}) {
  const on = {
    models: { routes: chainsOf({ vision: 'x/vision', video: 'x/video', drawing: 'x/drawing', speech: 'x/speech' }) },
  }; // off when shipped
  return deepMerge(deepMerge(structuredClone(SHIPPED.config), on), overrides);
}

/** A live view over the shipped layer, the config overridden as given. */
function shippedHot(overrides: Record<string, unknown> = {}) {
  return { config: shippedConfig(overrides), prompts: SHIPPED.prompts };
}

// ---- the checks -----------------------------------------------------------------

/** The text of one message content: a string as is, an array of parts as its text parts. */
function contentText(content: unknown) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/** Every text a request carries, as one string. */
function requestText(messages: Array<{ content: unknown }>) {
  return messages.map((message) => contentText(message.content)).join('\n\n');
}

/** The double-brace sequences left in `text`, LITERAL_BRACES aside. */
function strayPlaceholders(text: string) {
  return [...new Set(withoutLiterals(text).match(/\{\{[^{}\n]{0,40}\}\}|\{\{/g) ?? [])];
}

/** The single-brace `{key}` label placeholders left in `text`, LITERAL_BRACES aside. */
function strayLabelKeys(text: string) {
  return [...new Set(withoutLiterals(text).match(/\{[A-Za-z_]\w*\}/g) ?? [])];
}

/** The lines of prompt `name` without a placeholder: a request that loads the file carries each one verbatim. */
function literalLines(name: string) {
  const text = (SHIPPED.prompts as Record<string, unknown>)[name] as string;
  assert.equal(typeof text, 'string', `prompts/${name}.md is not loaded`);
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.includes('{{'));
}

/**
 * Asserts one built request: no `{{placeholder}}` and no label `{key}` left, every prompt file of
 * `files` carried whole, every block of `blocks` rendered. Returns the request's text.
 */
function assertFilled(
  messages: unknown,
  { files = [], blocks = [] }: { files?: Array<string>; blocks?: Array<string> },
  where: string
) {
  assert.ok(Array.isArray(messages) && messages.length > 0, `${where}: no request was built`);
  const text = requestText(messages);
  assert.deepEqual(strayPlaceholders(text), [], `${where}: a placeholder reached the request unfilled`);
  assert.deepEqual(strayLabelKeys(text), [], `${where}: a label placeholder reached the request unfilled`);
  for (const name of files) {
    const missing = literalLines(name).filter((line) => !text.includes(line));
    assert.equal(
      missing.length,
      0,
      `${where}: prompts/${name}.md is not carried whole, e.g. ${JSON.stringify(missing.slice(0, 2))}`
    );
  }
  for (const tag of blocks) {
    if (tag === 'tempo') {
      // Slice 2 (g): `<tempo>` is the foot of `<chat>`, not a block, so its verdict line ends the chat's body.
      const chat = /<chat>\n([\s\S]*?)\n<\/chat>/.exec(text)?.[1] ?? '';
      const verdict = labelHead(LABELS.tempo.verdict);
      assert.ok(chat.split('\n').at(-1)?.startsWith(verdict), `${where}: no tempo at the foot of <chat>`);
      continue;
    }
    assert.ok(text.includes(`<${tag}>\n`), `${where}: no <${tag}> block`);
  }
  return text;
}

// ---- the scene: one server, its members and channels --------------------------------

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

const GUILD = '600000000000000001';

const SELF_ID = '900000000000000001';

const SELF_NAME = 'Zoë';

const ANA = '411111111111111111';

const NIKOS = '422222222222222222';

const BJORN = '433333333333333333';

const GENERAL = '700000000000000001';

const GARDEN = '700000000000000002';

const DIARY = '700000000000000003';

const CHANNEL_INCREMENT: Record<string, bigint> = { [GENERAL]: 1n, [GARDEN]: 2n, [DIARY]: 3n };

const PEOPLE = {
  [ANA]: { id: ANA, name: 'Ana' },
  [NIKOS]: { id: NIKOS, name: 'Nikos' },
  [BJORN]: { id: BJORN, name: 'Björn' },
  [SELF_ID]: { id: SELF_ID, name: SELF_NAME },
};

/**
 * A discord.js-shaped message, enough for normalizeMessage: `author` a PEOPLE entry, media as
 * plain lists (attachments `{ id, name, contentType, url, size?, duration? }`, embeds as Discord
 * sends them, stickers `{ id, name, format }`, reactions `{ name, id?, count, me? }`).
 */
function rawMessage(
  channel: { id: string; name: string | null; category?: string | null; topic?: string | null },
  {
    ts,
    author,
    content = '',
    attachments = [],
    embeds = [],
    stickers = [],
    reactions = [],
    replyTo = null,
    mentions = [],
    forwarded = null,
  }: {
    ts: number;
    author: { id: string; name: string };
    content?: string;
    attachments?: Array<{ id: string; [key: string]: unknown }>;
    embeds?: Array<unknown>;
    stickers?: Array<{ id: string; [key: string]: unknown }>;
    reactions?: Array<{ name: string; id?: string; count: number; me?: boolean }>;
    replyTo?: string | null;
    mentions?: Array<string>;
    forwarded?: string | null;
  }
) {
  // The same id on every call: the time, and the channel as the increment.
  const id = SnowflakeUtil.generate({ timestamp: ts, increment: CHANNEL_INCREMENT[channel.id] ?? 0n }).toString();
  return {
    id,
    channelId: channel.id,
    channel: {
      name: channel.name,
      parent: channel.category ? { name: channel.category } : null,
      topic: channel.topic ?? null,
    },
    guild: null,
    author: { id: author.id, bot: false, globalName: author.name, username: author.name },
    member: { displayName: author.name },
    content,
    cleanContent: content,
    createdTimestamp: ts,
    reference: replyTo ? { messageId: replyTo } : null,
    attachments: new Map(attachments.map((a) => [a.id, a])),
    embeds,
    stickers: new Map(stickers.map((s) => [s.id, s])),
    messageSnapshots: new Map(
      forwarded
        ? [
            [
              'fwd',
              { content: forwarded, cleanContent: forwarded, attachments: new Map(), embeds: [], stickers: new Map() },
            ],
          ]
        : []
    ),
    mentions: { users: new Map(mentions.map((accountId) => [accountId, { id: accountId }])) },
    reactions: {
      cache: new Map(
        reactions.map((r, i) => [
          String(i),
          { emoji: { name: r.name, id: r.id ?? null }, count: r.count, me: r.me ?? false },
        ])
      ),
    },
    flags: { has: () => false },
  };
}

const GENERAL_INFO = { id: GENERAL, name: 'général', category: 'Café', topic: 'tout et rien' };

const GIF_EMBED = {
  url: 'https://tenor.com/view/cat-wave-123',
  provider: { name: 'Tenor' },
  thumbnail: { url: 'https://media.tenor.com/cat.png' },
  video: { url: 'https://media.tenor.com/cat.mp4' },
};

const PAGE_EMBED = {
  url: 'https://example.org/tomates',
  title: 'Tomates en pot',
  description: 'Comment cultiver des tomates sur un balcon',
};

/** The chat of #général the turn answers, oldest first: every kind of media the transcript renders. */
function generalRaws() {
  const at = (minutes: number) => NOW - minutes * MINUTE_MS;
  const raws: Array<ReturnType<typeof rawMessage>> = [];
  const add = (fields: Parameters<typeof rawMessage>[1]) => {
    const raw = rawMessage(GENERAL_INFO, fields);
    raws.push(raw);
    return raw;
  };
  add({
    ts: at(55),
    author: PEOPLE[NIKOS],
    content: 'bonjour à tous, la tomate a gelé',
    reactions: [
      { name: '🍅', count: 3 },
      { name: 'zoe_wave', id: 'E1', count: 1, me: true },
    ],
  });
  const own = add({ ts: at(50), author: PEOPLE[SELF_ID], content: 'oh non, pauvre tomate' });
  add({
    ts: at(45),
    author: PEOPLE[BJORN],
    content: 'la preuve',
    attachments: [
      {
        id: '800000000000000001',
        name: 'photo.png',
        contentType: 'image/png',
        url: 'https://cdn.discordapp.com/attachments/1/2/photo.png',
        size: 2000,
      },
    ],
  });
  add({
    ts: at(40),
    author: PEOPLE[NIKOS],
    content: 'regardez https://tenor.com/view/cat-wave-123',
    embeds: [GIF_EMBED],
  });
  const video = add({
    ts: at(35),
    author: PEOPLE[ANA],
    content: 'une vidéo des oranges',
    attachments: [
      {
        id: '800000000000000002',
        name: 'oranges.mp4',
        contentType: 'video/mp4',
        url: 'https://cdn.discordapp.com/attachments/1/2/oranges.mp4',
        size: 90000,
        duration: 20,
      },
    ],
  });
  add({ ts: at(30), author: PEOPLE[BJORN], content: 'un article https://example.org/tomates', embeds: [PAGE_EMBED] });
  add({
    ts: at(26),
    author: PEOPLE[ANA],
    content: '',
    stickers: [{ id: '810000000000000001', name: 'tomato_dance', format: 1 }],
  });
  add({
    ts: at(22),
    author: PEOPLE[NIKOS],
    content: 'mes graines',
    attachments: [
      {
        id: '800000000000000003',
        name: 'graines.txt',
        contentType: 'text/plain',
        url: 'https://cdn.discordapp.com/attachments/1/2/graines.txt',
        size: 40,
      },
    ],
  });
  add({ ts: at(18), author: PEOPLE[BJORN], content: 'vu ailleurs', forwarded: 'le gel arrive mardi' });
  add({ ts: at(14), author: PEOPLE[SELF_ID], content: 'jolie vidéo', replyTo: video.id });
  add({ ts: at(10), author: PEOPLE[NIKOS], content: 'Zoë, tu as aimé ?', replyTo: own.id });
  add({
    ts: at(2),
    author: PEOPLE[ANA],
    content: '@Zoë de quelle couleur sont les oranges dans la vidéo ? et quand gèle la tomate ?',
    mentions: [SELF_ID],
  });
  return raws;
}

const normalize = (raws: Array<ReturnType<typeof rawMessage>>) =>
  raws.map((raw) => {
    const media = SHIPPED.config.media;
    const line = normalizeMessage(raw, SELF_ID, {
      videoSites: media.video.sites,
    });
    // The interface's line names its channel natively; the core reads the same line under its place.
    return { ...line, placeId: line.channelId };
  });

/** A fetch stand-in for text attachment previews: every file reads the same short text. */
const previewFetch = async () => ({
  ok: true,
  headers: { get: () => null },
  text: async () => 'graines: tomate, basilic, ail',
});

/** The #général chat, normalized, text previews filled, oldest first. */
async function generalHistory() {
  return withTextPreviews(normalize(generalRaws()), 500, previewFetch);
}

/** A fake `llm.complete` recording every request and answering `answer(messages, options)`. */
function recordingLlm(answer: (messages: Array<{ content: unknown }>, options: { purpose?: string }) => unknown) {
  const calls: Array<{ messages: Array<{ content: unknown }>; options: { purpose?: string }; text: string }> = [];
  return {
    calls,
    complete: async (messages: Array<{ content: unknown }>, options: { purpose?: string } = {}) => {
      calls.push({ messages, options, text: requestText(messages) });
      const text = await answer(messages, options);
      return { text, usage: { prompt_tokens: 100, completion_tokens: 10 }, estimated: 100, finishReason: 'stop' };
    },
  };
}

describe('with the shipped prompts', () => {
  before(() => {
    useSelf('900000000000000001');
  });
  after(() => {
    useSelf('self-id');
  });

  // Split, merge and missed answer in strict JSON.
  test('createMissed: the missed-answer check fills classify/missed.md', async () => {
    const history = await generalHistory();
    const candidate = history.findLast((message) => !message.self);
    const llm = recordingLlm(() => '{"verdicts":[{"n":1,"verdict":"stale"}]}');
    worldChannelsOf([[GENERAL_INFO, generalRaws()]]);
    const dataDir = tempDir('nep-shipped-missed-');
    const missed = promptsShippedCreateMissed({
      hot: shippedHot(),
      store: { state: { data: {} }, mediaNameOf: noMediaNames },
      llm,
      turns: { triggerOf: () => null },
      reads: world().reads,
      isServedRoot: (id: unknown) => id === GUILD,
      getSelfName: () => SELF_NAME,
      dataDir,
      now: () => candidate!.ts + MINUTE_MS,
      timers: { set: () => null, clear() {} },
    });
    try {
      await withCapturedLogs(async () => {
        missed.noteFact({ reason: 'gate-failed', message: candidate, iface: world().port.iface });
        await missed.sweep(world().port.iface, GENERAL);
      });
      assert.equal(llm.calls.length, 1, 'one check for the channel');
      const call = llm.calls[0];
      assertFilled(call.messages, { files: LOADS.missed, blocks: ['candidates'] }, 'missed');
      const call2 = llm.calls[0];
      assert.equal(call2.options.purpose, 'missed');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
