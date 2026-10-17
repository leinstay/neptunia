// Missed answers (src/behavior/missed.js): the candidate registry fed from facts, its
// resolution by later turns, the delayed sweep with its code filter and helper, the recovery
// turn behind features.missedRecovery, the restart reconciliation and the day's figures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MISSED_REASONS,
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
} from '../src/behavior/missed.js';
import { labels } from './fixtures/labels.js';

const T0 = Date.parse('2026-10-14T12:00:00.000Z');
const MIN = 60_000;
const SELF = 'self1';

/** A normalized message (interfaces/discord/collect.js#normalizeMessage's shape, the fields read here). */
function msg({ id, authorId = 'u1', authorName = 'Élodie', content = 'και λοιπόν', ts = T0, self = false, replyToId = null, channelId = 'c1' }) {
  return {
    id,
    channelId,
    authorId: self ? SELF : authorId,
    authorName: self ? 'Bot' : authorName,
    self,
    bot: false,
    content,
    ts,
    replyToId,
    mentionedUserIds: [],
    mentionedChannelIds: [],
    attachments: [],
    links: [],
    stickers: [],
    emojis: [],
    reactions: [],
    forwarded: [],
  };
}

/** A fact as createMissed's noteFact takes it. */
const fact = (reason, message, extra = {}) => ({ reason, message, ...extra });

function settings(overrides = {}) {
  return { ...missedSettings({}), ...overrides };
}

function baseConfig(overrides = {}) {
  return {
    features: { journal: true, missedAnswers: true, missedRecovery: false, ...(overrides.features ?? {}) },
    bot: { timezone: 'UTC' },
    context: { gapMarkerMinutes: 30, maxMessageChars: 2000, replyQuoteChars: 80 },
    mention: { oneAtATime: true },
    missed: { ...(overrides.missed ?? {}) },
    roles: {},
    llm: {},
  };
}

/** A clock the test moves by hand. */
function handClock(start = T0) {
  let at = start;
  const clock = () => at;
  clock.set = (value) => {
    at = value;
  };
  clock.advance = (ms) => {
    at += ms;
  };
  return clock;
}

/** Timers fired by hand: `due()` lists their times, `fireAll()` runs the ones set so far, earliest first, each awaited. */
function handTimers(clock) {
  const pending = new Map();
  let next = 1;
  return {
    set(fn, ms) {
      const id = next++;
      pending.set(id, { fn, at: clock() + ms });
      return id;
    },
    clear(id) {
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
function fakeJournal(records = []) {
  const answers = [];
  return {
    answers,
    answer: async (guildId, record) => {
      answers.push({ kind: 'answer', guildId, ...record });
    },
    read: async (guildId, { day }) => records.filter((record) => record.occurredAt.slice(0, 10) === day),
  };
}

/** A helper llm answering `answer` (a string, an Error to throw, or a function of the call). */
function fakeLlm(answer = '') {
  const calls = [];
  return {
    calls,
    complete: async (messages, options) => {
      calls.push({ messages, options });
      const value = typeof answer === 'function' ? answer(messages) : answer;
      if (value instanceof Error) throw value;
      return { text: value };
    },
  };
}

/** A turn runner: records runTurn calls; `links` maps the persona's posted ids to their triggers. */
function fakeTurns({ outcome = 'spoke', links = new Map(), busy = false, onRun = null } = {}) {
  const calls = [];
  const turns = {
    calls,
    busy,
    lastPost: 0,
    triggerOf: (id) => links.get(id) ?? null,
    lastPostAt: () => turns.lastPost,
    isBusy: () => turns.busy,
    isAnyBusy: () => turns.busy,
    runTurn: async (params) => {
      calls.push(params);
      if (onRun) return onRun(params);
      return { outcome };
    },
  };
  return turns;
}

function fakeLog() {
  const lines = [];
  const push = (level) => (msg, fields = {}) => lines.push({ level, msg, ...fields });
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

function tmpData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nep-missed-'));
}

/** One createMissed with fakes; `history` is what every channel fetch returns. */
function scene({ config = baseConfig(), history = [], llm = fakeLlm(''), turns = fakeTurns(), journal = fakeJournal(), paused = false, canSend = () => true, dataDir = tmpData(), prompts = { missed: 'Check for {{name}}.', labels } } = {}) {
  const clock = handClock();
  const timers = handTimers(clock);
  const log = fakeLog();
  const store = { state: { data: { paused } } };
  const channel = { id: 'c1', guild: { id: 'g1' } };
  const client = { user: { id: SELF, username: 'Bot' }, channels: { cache: new Map([['c1', channel]]) } };
  const hot = { config, prompts };
  const fetched = { history };
  const missed = createMissed({
    hot,
    store,
    journal,
    llm,
    turns,
    client,
    getGuildId: () => 'g1',
    getSelfName: () => 'Bot',
    dataDir,
    now: clock,
    timers,
    fetchHistory: async () => fetched.history,
    canSend,
    log,
  });
  return { missed, clock, timers, log, store, journal, llm, turns, hot, fetched, dataDir, channel };
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

// ---- the pure core ------------------------------------------------------------------

test('addCandidate: one candidate per message; an open one takes the latest reason and turn, a closed one is left alone', () => {
  const first = addCandidate([], { messageId: 'm1', channelId: 'c1', authorId: 'u1', at: T0, reason: 'gate-failopen' });
  assert.equal(first.added, true);
  assert.deepEqual(
    { ...first.candidate },
    { messageId: 'm1', channelId: 'c1', authorId: 'u1', at: T0, reason: 'gate-failopen', question: false, turnIds: [], state: 'pending', attempts: 0, verdict: null, checkedAt: null, updatedAt: T0 },
  );
  const again = addCandidate(first.list, { messageId: 'm1', channelId: 'c1', authorId: 'u1', at: T0, reason: 'turn-error', turnId: 't-1' }, { now: T0 + 5 });
  assert.equal(again.added, false);
  assert.equal(again.list.length, 1);
  assert.equal(again.candidate.reason, 'turn-error');
  assert.deepEqual(again.candidate.turnIds, ['t-1']);
  const closed = again.list.map((candidate) => ({ ...candidate, state: 'resolved' }));
  const late = addCandidate(closed, { messageId: 'm1', channelId: 'c1', at: T0, reason: 'not-now' });
  assert.equal(late.list, closed, 'a resolved message never comes back');
  assert.equal(addCandidate([], { messageId: 'm2', channelId: 'c1', at: T0, reason: 'skip' }).added, false, 'not a reason');
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
  let list = [];
  for (const [id, authorId] of [['m1', 'u1'], ['m2', 'u2'], ['m3', 'u3']]) list = addCandidate(list, { messageId: id, channelId: 'c1', authorId, at: T0, reason: 'gate-failed' }).list;
  list = addCandidate(list, { messageId: 'm9', channelId: 'c2', authorId: 'u1', at: T0, reason: 'gate-failed' }).list;

  const spoke = resolveByTurn(list, { channelId: 'c1', triggerId: 'm5', triggerAuthorId: 'u1', triggerAt: T0 + 1000, outcome: 'spoke', replyTargets: ['m2'], turnId: 't-1', at: T0 + 2000 });
  assert.deepEqual(spoke.resolved.map(({ messageId, by }) => [messageId, by]), [['m1', 'author'], ['m2', 'reply']]);
  assert.equal(spoke.list.find((c) => c.messageId === 'm9').state, 'pending', 'another channel is not touched');
  assert.deepEqual(spoke.list.find((c) => c.messageId === 'm1').turnIds, ['t-1']);

  const skipped = resolveByTurn(list, { channelId: 'c1', triggerId: 'm3', triggerAuthorId: 'u1', triggerAt: T0 + 1000, outcome: 'skip', at: T0 + 2000 });
  assert.deepEqual(skipped.resolved.map(({ messageId, by }) => [messageId, by]), [['m3', 'trigger']], 'a skip answers its own trigger only');

  for (const outcome of ['error', 'not-now', 'refused', 'busy', 'paused']) {
    assert.deepEqual(resolveByTurn(list, { channelId: 'c1', triggerId: 'm1', outcome, at: T0 }).resolved, [], outcome);
  }
  const earlier = resolveByTurn(list, { channelId: 'c1', triggerId: 'm0', triggerAuthorId: 'u1', triggerAt: T0 - 1, outcome: 'spoke', at: T0 + 1 });
  assert.deepEqual(earlier.resolved, [], 'a message of the author older than the candidate does not answer it');
});

test('resolvedInHistory: her later line replying to it, started by it, or by a later message of its author', () => {
  const candidate = { messageId: 'm1', authorId: 'u1', at: T0 };
  const links = new Map([['s2', 'm1'], ['s3', 'm2'], ['s4', 'm3']]);
  const triggerOf = (id) => links.get(id) ?? null;
  const base = [msg({ id: 'm1', ts: T0 }), msg({ id: 'm2', ts: T0 + 1000 }), msg({ id: 'm3', authorId: 'u2', ts: T0 + 1500 })];
  assert.equal(resolvedInHistory(candidate, [...base, msg({ id: 's1', self: true, ts: T0 + 2000, replyToId: 'm1' })], triggerOf), 'reply');
  assert.equal(resolvedInHistory(candidate, [...base, msg({ id: 's2', self: true, ts: T0 + 2000 })], triggerOf), 'trigger');
  assert.equal(resolvedInHistory(candidate, [...base, msg({ id: 's3', self: true, ts: T0 + 2000 })], triggerOf), 'author');
  assert.equal(resolvedInHistory(candidate, [...base, msg({ id: 's4', self: true, ts: T0 + 2000 })], triggerOf), null, 'another member\'s line');
  assert.equal(resolvedInHistory(candidate, [msg({ id: 's1', self: true, ts: T0 - 1000, replyToId: 'm1' }), ...base], triggerOf), null, 'before it');
});

test('sweepPlan: expired, answered in the history, out of the window, owed already, and the rest to check', () => {
  const s = settings({ expireMinutes: 5, questionExpireMinutes: 15 });
  const now = T0 + 10 * MIN;
  let list = [];
  const add = (messageId, at, extra = {}) => {
    list = addCandidate(list, { messageId, channelId: 'c1', authorId: 'u1', at, reason: 'gate-failed', ...extra }).list;
  };
  add('old', now - 6 * MIN);
  add('oldQuestion', now - 6 * MIN, { question: true });
  add('answered', now - 2 * MIN);
  add('gone', now - 2 * MIN);
  add('owed', now - 2 * MIN);
  add('fresh', now - 1 * MIN);
  list = list.map((c) => (c.messageId === 'owed' ? { ...c, verdict: 'owed' } : c));
  list = addCandidate(list, { messageId: 'other', channelId: 'c2', at: now, reason: 'gate-failed' }).list;
  const history = [
    msg({ id: 'oldQuestion', ts: now - 6 * MIN }),
    msg({ id: 'answered', ts: now - 2 * MIN }),
    msg({ id: 'owed', ts: now - 2 * MIN }),
    msg({ id: 'fresh', ts: now - MIN }),
    msg({ id: 's1', self: true, ts: now - 30_000, replyToId: 'answered' }),
  ];
  const plan = sweepPlan(list, 'c1', { now, settings: s, history, triggerOf: () => null });
  assert.deepEqual(plan.expired.map((c) => c.messageId), ['old']);
  assert.deepEqual(plan.resolved.map(({ candidate, by }) => [candidate.messageId, by]), [['answered', 'history-reply']]);
  assert.deepEqual(plan.notShown.map((c) => c.messageId), ['gone']);
  assert.deepEqual(plan.owed.map((c) => c.messageId), ['owed']);
  assert.deepEqual(plan.check.map((c) => c.messageId), ['oldQuestion', 'fresh'], 'a question lives 15 minutes');
});

test('parseMissedAnswer: one verdict per line; a missing or conflicting one is uncertain; an empty answer is unchecked', () => {
  assert.deepEqual(parseMissedAnswer('1: owed\n2. Resolved\n3) intentional-skip\n4 - stale', 4).verdicts, ['owed', 'resolved', 'intentional-skip', 'stale']);
  assert.deepEqual(parseMissedAnswer('2: owed\n9: owed\nnoise', 3).verdicts, ['uncertain', 'owed', 'uncertain']);
  assert.deepEqual(parseMissedAnswer('1: owed\n1: stale', 1).verdicts, ['uncertain']);
  assert.deepEqual(parseMissedAnswer('1: maybe', 1).verdicts, ['uncertain']);
  assert.deepEqual(parseMissedAnswer('  ', 2), { verdicts: [UNCHECKED, UNCHECKED], empty: true });
});

test('stateForVerdict: owed waits for its recovery only with recovery on', () => {
  assert.equal(stateForVerdict('owed', true), 'pending');
  assert.equal(stateForVerdict('owed', false), 'dismissed');
  assert.equal(stateForVerdict('resolved', false), 'resolved');
  for (const verdict of ['intentional-skip', 'stale', 'uncertain', UNCHECKED]) assert.equal(stateForVerdict(verdict, true), 'dismissed', verdict);
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
  assert.deepEqual(pruneCandidates(list, T0).map((c) => c.messageId), ['b', 'c', 'd']);
  assert.deepEqual(pruneCandidates(list, T0, 2).map((c) => c.messageId), ['c', 'd']);
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
  assert.deepEqual(counts, { candidates: 2, owed: 1, recovered: 1, byReason: { 'gate-failed': 1, 'replaced-deferred': 1 }, byVerdict: { owed: 1, stale: 1 } });
  assert.equal(missedStatusLine(counts), 'missed: 2 candidates, 1 owed, 1 recovered');
});

test('buildCheckRequest: the transcript from a few lines before the earliest candidate, her trigger markers, one numbered line per candidate', () => {
  const history = [];
  for (let i = 1; i <= 8; i += 1) history.push(msg({ id: `p${i}`, content: `γραμμή ${i}`, ts: T0 + i * 1000 }));
  history.push(msg({ id: 'm1', content: 'πού είσαι?', ts: T0 + 9000 }));
  history.push(msg({ id: 's1', self: true, content: 'εδώ', ts: T0 + 10_000 }));
  history.push(msg({ id: 'm2', authorId: 'u2', authorName: 'Zoë', content: 'και εγώ', ts: T0 + 11_000 }));
  const request = buildCheckRequest({
    prompt: 'Check for {{name}}.',
    labels,
    config: baseConfig(),
    selfName: 'Bot',
    history,
    candidates: [{ messageId: 'm1', reason: 'gate-failed' }, { messageId: 'm2', reason: 'turn-error' }, { messageId: 'zz', reason: 'not-now' }],
    triggerOf: (id) => (id === 's1' ? 'p8' : null),
    now: T0 + 20_000,
  });
  assert.equal(request.system, 'Check for Bot.');
  assert.ok(!request.user.includes('γραμμή 3'), 'older lines cut');
  assert.ok(request.user.includes('γραμμή 4'));
  assert.ok(request.user.includes('(turn triggered by #5)'), request.user);
  assert.ok(request.user.endsWith('<candidates>\n1: #6 gate-failed\n2: #8 turn-error\n</candidates>'), request.user);
  assert.deepEqual(request.candidates.map((c) => c.messageId), ['m1', 'm2']);
  assert.equal(buildCheckRequest({ prompt: ' ', labels, config: baseConfig(), selfName: 'Bot', history, candidates: [] }), null);
});

// ---- the registry: facts --------------------------------------------------------------

test('createMissed: every fact source makes the right candidate, journaled with ids and no text', async () => {
  const { missed, journal } = scene();
  missed.noteFact(fact('gate-failed', msg({ id: 'm1', content: 'πού;' }), { failure: 'classifier-failed' }));
  missed.noteFact(fact('gate-failopen', msg({ id: 'm2', content: 'à quoi bon?' }), { failure: 'empty' }));
  missed.noteFact(fact('replaced-deferred', msg({ id: 'm3' }), { replacedBy: 'm4' }));
  const trigger = (id) => ({ id, authorId: 'u1', channelId: 'c1', ts: T0, content: 'ναι' });
  missed.onTurnEnd({ channelId: 'c1', trigger: trigger('m5'), triggerKind: 'mention', outcome: 'error', reason: null, turnId: 't-5' });
  missed.onTurnEnd({ channelId: 'c1', trigger: trigger('m6'), triggerKind: 'followUp', outcome: 'error', reason: 'too-slow' });
  missed.onTurnEnd({ channelId: 'c1', trigger: trigger('m7'), triggerKind: 'name', outcome: 'not-now' });
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
    ],
  );
  assert.equal(byId.m2.question, true);
  assert.deepEqual(byId.m5.turnIds, ['t-5']);
  await flush();
  const facts = journal.answers.filter((record) => record.event === 'fact');
  assert.deepEqual(facts.map((record) => [record.messageId, record.reason]), Object.values(byId).map((c) => [c.messageId, c.reason]));
  const replaced = facts.find((record) => record.reason === 'replaced-deferred');
  assert.deepEqual(replaced.sourceMessageIds, ['m3', 'm4']);
  assert.equal(replaced.replacedBy, 'm4');
  assert.equal(facts[0].failure, 'classifier-failed');
  assert.equal(facts[0].channelId, 'c1');
  assert.deepEqual(facts[0].participants, ['u1']);
  assert.equal(facts[0].at, new Date(T0).toISOString());
  assert.ok(!JSON.stringify(journal.answers).includes('πού'), 'no message text in the journal');
});

test('createMissed: a skip, a refusal, an overheard line, a routed call, a private chat and a recovery turn never make a candidate', () => {
  const { missed } = scene();
  const trigger = { id: 'm1', authorId: 'u1', channelId: 'c1', ts: T0, content: '' };
  missed.onTurnEnd({ channelId: 'c1', trigger, triggerKind: 'mention', outcome: 'skip' });
  missed.onTurnEnd({ channelId: 'c1', trigger, triggerKind: 'mention', outcome: 'refused' });
  missed.onTurnEnd({ channelId: 'c1', trigger, triggerKind: 'mention', outcome: 'busy' });
  missed.onTurnEnd({ channelId: 'c1', trigger, triggerKind: 'overheard', outcome: 'error' });
  missed.onTurnEnd({ channelId: 'c1', trigger, triggerKind: 'mention', outcome: 'error', routed: true });
  missed.onTurnEnd({ channelId: 'd1', trigger, triggerKind: 'private', outcome: 'error', privateChat: true });
  missed.onTurnEnd({ channelId: 'c1', trigger, triggerKind: 'missed', outcome: 'not-now', reason: 'answered-meanwhile' });
  missed.onTurnEnd({ channelId: 'c1', trigger: null, mode: 'auto', outcome: 'not-now' });
  assert.deepEqual(missed.candidates(), []);
});

test('createMissed: features.missedAnswers off notes nothing', () => {
  const { missed, timers } = scene({ config: baseConfig({ features: { missedAnswers: false } }) });
  missed.noteFact(fact('gate-failed', msg({ id: 'm1' })));
  missed.onTurnEnd({ channelId: 'c1', trigger: { id: 'm2', authorId: 'u1', ts: T0 }, triggerKind: 'mention', outcome: 'error' });
  assert.deepEqual(missed.candidates(), []);
  assert.equal(timers.size(), 0);
});

test('createMissed: a later turn of hers resolves the candidate, journaled resolved', async () => {
  const { missed, journal } = scene();
  missed.noteFact(fact('gate-failed', msg({ id: 'm1', ts: T0 })));
  missed.noteFact(fact('gate-failed', msg({ id: 'm2', authorId: 'u2', ts: T0 })));
  missed.onTurnEnd({ channelId: 'c1', trigger: { id: 'm3', authorId: 'u1', ts: T0 + 1000 }, triggerKind: 'mention', outcome: 'spoke', replyTargets: [], turnId: 't-9' });
  const states = Object.fromEntries(missed.candidates().map((c) => [c.messageId, c.state]));
  assert.deepEqual(states, { m1: 'resolved', m2: 'pending' });
  await flush();
  const resolved = journal.answers.filter((record) => record.event === 'resolved');
  assert.deepEqual(resolved.map((record) => [record.messageId, record.by, record.turnId]), [['m1', 'author', 't-9']]);
});

test('createMissed: the registry is written atomically to data/guilds/<id>/missed.json', async () => {
  const { missed, dataDir } = scene();
  missed.noteFact(fact('gate-failed', msg({ id: 'm1' })));
  await missed.save();
  const file = path.join(dataDir, 'guilds', 'g1', 'missed.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.v, 1);
  assert.deepEqual(saved.candidates.map((c) => c.messageId), ['m1']);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('createMissed: nothing is written while paused', async () => {
  const { missed, dataDir } = scene({ paused: true });
  missed.noteFact(fact('gate-failed', msg({ id: 'm1' })));
  await missed.save();
  assert.equal(fs.existsSync(path.join(dataDir, 'guilds', 'g1', 'missed.json')), false);
});

// ---- the sweep --------------------------------------------------------------------------

test('createMissed: the sweep waits sweepDelaySeconds after the last event, pushed back by activity up to the cap', () => {
  const { missed, clock, timers } = scene({ config: baseConfig({ missed: { sweepDelaySeconds: 90, sweepMaxDelaySeconds: 240 } }) });
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

test('createMissed: the sweep filters by code, asks the helper once for the rest, and in shadow mode posts nothing', async () => {
  const history = [
    msg({ id: 'm1', content: 'πού είσαι;', ts: T0 }),
    msg({ id: 'm2', authorId: 'u2', authorName: 'Zoë', ts: T0 + 1000 }),
    msg({ id: 'm3', authorId: 'u3', authorName: 'Léa', ts: T0 + 2000 }),
    msg({ id: 's1', self: true, ts: T0 + 3000, replyToId: 'm3' }),
  ];
  const llm = fakeLlm('1: owed\n2: stale');
  const turns = fakeTurns();
  const { missed, timers, journal, clock } = scene({ history, llm, turns });
  missed.noteFact(fact('gate-failed', history[0]));
  missed.noteFact(fact('turn-error', history[1]));
  missed.noteFact(fact('gate-failopen', history[2]));
  missed.noteFact(fact('gate-failed', msg({ id: 'old', ts: T0 - 10 * MIN })));
  await timers.fireAll();
  assert.equal(clock(), T0 + 90_000);
  assert.equal(llm.calls.length, 1, 'one helper call for the channel');
  assert.equal(llm.calls[0].options.purpose, 'missed');
  assert.equal(llm.calls[0].options.role, 'analyzer');
  assert.ok(llm.calls[0].messages[1].content.includes('1: #1 gate-failed\n2: #2 turn-error'), llm.calls[0].messages[1].content);
  assert.equal(turns.calls.length, 0, 'shadow mode: no turn');
  const states = Object.fromEntries(missed.candidates().map((c) => [c.messageId, [c.state, c.verdict]]));
  assert.deepEqual(states, { m1: ['dismissed', 'owed'], m2: ['dismissed', 'stale'], m3: ['resolved', null], old: ['expired', null] });
  await flush();
  const verdicts = journal.answers.filter((record) => record.event === 'verdict');
  assert.deepEqual(verdicts.map((record) => [record.messageId, record.verdict, record.by, record.shadow]), [['m1', 'owed', 'model', true], ['m2', 'stale', 'model', false]]);
  assert.deepEqual(journal.answers.filter((r) => r.event === 'resolved').map((r) => [r.messageId, r.by]), [['m3', 'history-reply']]);
  assert.deepEqual(journal.answers.filter((r) => r.event === 'expired').map((r) => r.messageId), ['old']);
});

test('createMissed: a failed or timed-out helper leaves every candidate unchecked, never owed', async () => {
  for (const answer of [new Error('timeout'), '']) {
    const history = [msg({ id: 'm1', ts: T0 })];
    const turns = fakeTurns();
    const { missed, timers, journal } = scene({ history, llm: fakeLlm(answer), turns, config: baseConfig({ features: { missedRecovery: true } }) });
    missed.noteFact(fact('gate-failed', history[0]));
    await timers.fireAll();
    assert.deepEqual(missed.candidates().map((c) => [c.state, c.verdict]), [['dismissed', UNCHECKED]], String(answer));
    assert.equal(turns.calls.length, 0);
    await flush();
    assert.equal(journal.answers.find((r) => r.event === 'verdict')?.verdict, UNCHECKED);
  }
});

test('createMissed: no sweep while paused', async () => {
  const history = [msg({ id: 'm1', ts: T0 })];
  const llm = fakeLlm('1: owed');
  const { missed, timers, store } = scene({ history, llm });
  missed.noteFact(fact('gate-failed', history[0]));
  store.state.data.paused = true;
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
  const { missed, timers, journal } = scene({ history, llm: fakeLlm('1: owed\n2: owed'), turns, config: baseConfig({ features: { missedRecovery: true } }) });
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
  assert.deepEqual(missed.candidates().map((c) => [c.messageId, c.state, c.attempts]), [['m2', 'resolved', 1], ['m1', 'resolved', 1]]);
  await flush();
  const recovery = journal.answers.find((record) => record.event === 'recovery');
  assert.deepEqual([recovery.messageIds, recovery.triggerId, recovery.outcome], [['m1', 'm2'], 'm1', 'spoke']);
});

test('createMissed: a second owed candidate inside the channel cooldown waits for it; one attempt per candidate', async () => {
  const history = [msg({ id: 'm1', ts: T0 })];
  const turns = fakeTurns({ outcome: 'error' });
  const llm = fakeLlm('1: owed');
  const { missed, timers, clock, fetched } = scene({ history, llm, turns, config: baseConfig({ features: { missedRecovery: true }, missed: { channelCooldownMinutes: 5 } }) });
  missed.noteFact(fact('gate-failed', history[0]));
  await timers.fireAll();
  assert.equal(turns.calls.length, 1);
  assert.equal(missed.candidates()[0].state, 'dismissed', 'a failed recovery is not tried again');

  clock.advance(30_000);
  const second = msg({ id: 'm2', ts: clock() });
  fetched.history = [...history, second];
  missed.noteFact(fact('gate-failed', second));
  await timers.fireAll();
  assert.equal(turns.calls.length, 1, 'held by the cooldown');
  assert.deepEqual(missed.candidates().map((c) => [c.messageId, c.state, c.verdict]), [['m1', 'dismissed', 'owed'], ['m2', 'pending', 'owed']]);
  assert.equal(timers.size(), 1, 'a sweep re-armed for the end of the cooldown');
  assert.ok(timers.due()[0] >= T0 + 90_000 + 5 * MIN, 'not before the cooldown ends');

  turns.runTurn = async (params) => {
    turns.calls.push(params);
    return { outcome: 'spoke' };
  };
  await timers.fireAll();
  assert.equal(llm.calls.length, 2, 'an owed candidate is not asked about twice');
  assert.equal(turns.calls.length, 2);
  assert.equal(turns.calls[1].trigger.id, 'm2');
});

test('createMissed: the pre-post check fails once she spoke in the channel or another turn answered it', async () => {
  const history = [msg({ id: 'm1', ts: T0 })];
  let checks = [];
  const turns = fakeTurns({
    onRun: (params) => {
      checks.push(params.stillDue());
      // Another turn of hers answers the message while the recovery prepares.
      missed.onTurnEnd({ channelId: 'c1', trigger: { id: 'm1', authorId: 'u1', ts: T0 }, triggerKind: 'mention', outcome: 'spoke' });
      checks.push(params.stillDue());
      return { outcome: 'not-now', reason: 'answered-meanwhile' };
    },
  });
  const { missed, timers } = scene({ history, llm: fakeLlm('1: owed'), turns, config: baseConfig({ features: { missedRecovery: true } }) });
  missed.noteFact(fact('gate-failed', history[0]));
  await timers.fireAll();
  assert.deepEqual(checks, [true, false]);
  assert.equal(missed.candidates()[0].state, 'resolved', 'answered by the other turn');

  // A post of hers in the channel since the recovery started.
  checks = [];
  const second = scene({ history, llm: fakeLlm('1: owed'), turns: fakeTurns({ onRun: (params) => checks.push(params.stillDue()) && { outcome: 'not-now' } }), config: baseConfig({ features: { missedRecovery: true } }) });
  second.missed.noteFact(fact('gate-failed', history[0]));
  second.turns.lastPost = T0 + 10 * MIN;
  await second.timers.fireAll();
  assert.deepEqual(checks, [false]);
});

test('createMissed: no recovery where the bot cannot write, and a busy attention holds it', async () => {
  const history = [msg({ id: 'm1', ts: T0 })];
  const mute = scene({ history, llm: fakeLlm('1: owed'), canSend: () => false, config: baseConfig({ features: { missedRecovery: true } }) });
  mute.missed.noteFact(fact('gate-failed', history[0]));
  await mute.timers.fireAll();
  assert.equal(mute.turns.calls.length, 0);
  assert.equal(mute.missed.candidates()[0].state, 'dismissed');

  const busy = scene({ history, llm: fakeLlm('1: owed'), turns: fakeTurns({ busy: true }), config: baseConfig({ features: { missedRecovery: true } }) });
  busy.missed.noteFact(fact('gate-failed', history[0]));
  await busy.timers.fireAll();
  assert.equal(busy.turns.calls.length, 0);
  assert.deepEqual(busy.missed.candidates().map((c) => [c.state, c.attempts]), [['pending', 0]]);
  assert.equal(busy.timers.size(), 1);
});

// ---- restart ------------------------------------------------------------------------------

test('reconcileFromRecords: facts of the last hour come back; later verdicts and turns close them', () => {
  const at = (ms) => new Date(ms).toISOString();
  const now = T0 + 30 * MIN;
  const scope = { channel: 'c1' };
  const records = [
    { kind: 'answer', event: 'fact', occurredAt: at(T0 - 2 * 60 * MIN), scope, messageId: 'ancient', reason: 'gate-failed', at: at(T0 - 2 * 60 * MIN) },
    { kind: 'answer', event: 'fact', occurredAt: at(T0), scope, messageId: 'm1', authorId: 'u1', reason: 'gate-failed', at: at(T0), question: true },
    { kind: 'answer', event: 'fact', occurredAt: at(T0 + MIN), scope, messageId: 'm2', authorId: 'u2', reason: 'turn-error', at: at(T0 + MIN) },
    { kind: 'answer', event: 'fact', occurredAt: at(T0 + MIN), scope, messageId: 'm3', authorId: 'u3', reason: 'not-now', at: at(T0 + MIN) },
    { kind: 'answer', event: 'fact', occurredAt: at(T0 + MIN), scope, messageId: 'm4', authorId: 'u4', reason: 'gate-failed', at: at(T0 + MIN) },
    { kind: 'answer', event: 'verdict', occurredAt: at(T0 + 3 * MIN), scope, messageId: 'm2', verdict: 'stale' },
    { kind: 'turn.start', occurredAt: at(T0 + 4 * MIN), scope, turnId: 't-1', trigger: { kind: 'mention', messageId: 'm3', authorId: 'u3' } },
    { kind: 'turn', occurredAt: at(T0 + 5 * MIN), scope, turnId: 't-1', outcome: 'spoke', posted: [{ messageId: 's1', replyTo: 'm3' }] },
    { kind: 'answer', event: 'recovery', occurredAt: at(T0 + 6 * MIN), scope, messageIds: ['m4'], outcome: 'error' },
  ];
  const { list, added, closed } = reconcileFromRecords([], records, { now });
  assert.equal(added, 4);
  assert.equal(closed, 3);
  assert.deepEqual(list.map((c) => [c.messageId, c.state]), [['m1', 'pending'], ['m2', 'dismissed'], ['m3', 'resolved'], ['m4', 'dismissed']]);
  assert.equal(list[0].question, true);
  assert.equal(list[0].at, T0);
});

test('createMissed: a restart loads missed.json, reconciles the journal of the last hour and arms the sweep', async () => {
  const dataDir = tmpData();
  const first = scene({ dataDir });
  first.missed.noteFact(fact('gate-failed', msg({ id: 'm1' })));
  await first.missed.save();

  const at = new Date(T0 + MIN).toISOString();
  const journal = fakeJournal([
    { kind: 'answer', event: 'fact', occurredAt: at, scope: { channel: 'c1' }, messageId: 'm2', authorId: 'u2', reason: 'replaced-deferred', at },
    { kind: 'turn.start', occurredAt: at, scope: { channel: 'c1' }, turnId: 't-2', trigger: { messageId: 'm1', authorId: 'u1' } },
    { kind: 'turn', occurredAt: at, scope: { channel: 'c1' }, turnId: 't-2', outcome: 'skip', posted: [] },
  ]);
  const second = scene({ dataDir, journal });
  second.clock.set(T0 + 2 * MIN);
  await second.missed.start('g1');
  assert.deepEqual(second.missed.candidates().map((c) => [c.messageId, c.state]), [['m1', 'resolved'], ['m2', 'pending']]);
  assert.equal(second.timers.size(), 1, 'a sweep for the pending one');
  assert.ok(second.log.lines.some((line) => line.msg === 'missed: reconciled' && line.added === 1 && line.closed === 1));
});

test('createMissed: a broken missed.json is moved aside, never overwritten in place', async () => {
  const dataDir = tmpData();
  const dir = path.join(dataDir, 'guilds', 'g1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'missed.json'), '{ broken');
  const { missed } = scene({ dataDir });
  await missed.start('g1');
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith('missed.json.bad-')));
  assert.deepEqual(missed.candidates(), []);
});

test('missed: every reason code is kebab-case', () => {
  for (const reason of MISSED_REASONS) assert.match(reason, /^[a-z]+(-[a-z]+)*$/);
});

test('createMissed: a turn that ended in an error keeps its reason as the fact\'s failure; one without a reason has none', async () => {
  const { missed, journal } = scene();
  const trigger = (id) => ({ id, authorId: 'u1', channelId: 'c1', ts: T0, content: 'ναι' });
  missed.onTurnEnd({ channelId: 'c1', trigger: trigger('m1'), triggerKind: 'mention', outcome: 'error', reason: 'cut-off', turnId: 't-1' });
  missed.onTurnEnd({ channelId: 'c1', trigger: trigger('m2'), triggerKind: 'reply', outcome: 'error', reason: null });
  assert.deepEqual(missed.candidates().map((c) => [c.messageId, c.reason, c.state]), [['m1', 'turn-error', 'pending'], ['m2', 'turn-error', 'pending']]);
  await flush();
  const facts = journal.answers.filter((record) => record.event === 'fact');
  assert.deepEqual(facts.map((record) => [record.messageId, record.reason, record.failure ?? null, record.turnId ?? null]), [['m1', 'turn-error', 'cut-off', 't-1'], ['m2', 'turn-error', null, null]]);
});
