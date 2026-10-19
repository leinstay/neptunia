// Tests for the inner life's scheduler (src/behavior/inner.js): what is due is listed and handed
// through the event door as wakes, compatible wakes coalesce into one inner turn, a wake waits
// while the attention is held, the state survives a restart, the daily review falls inside her
// active hours, the caps refuse a turn, the kill switch stops and drops, and the journal records
// it all. A fake turn runner, intention service and record; a temp data directory; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  budgetsOf,
  capRefusal,
  chainBudget,
  coalesceGroup,
  createInnerLife,
  drawReviewAt,
  emptyState,
  hourWeights,
  innerSettings,
  reviewWake,
  wakeOfDue,
} from '../src/behavior/inner.js';
import { createEventDoor } from '../src/interface/door.js';
import { localHour } from '../src/format.js';
import { HOUR_MS, MINUTE_MS, DAY_MS, zonedEpoch } from '../src/time.js';
import { tempDir } from './fixtures/tmp.js';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const SILENT = { info() {}, warn() {}, error() {} };
const GUILD = 'g1';

/** A seeded stream in [0, 1) (mulberry32). */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function intention(id, { dueAt = NOW - MINUTE_MS, channelId = 'c1', chainId = null, status = 'pending', purpose = `purpose ${id}` } = {}) {
  return { id, status, purpose, dueAt, chainId, destination: null, provenance: { kind: 'self', channelId, scope: 'group' }, createdAt: NOW - DAY_MS, updatedAt: NOW - DAY_MS, expiresAt: NOW + 7 * DAY_MS };
}

/** A fake intention service over `records` (mutable): due ones are pending with a passed dueAt. */
function fakeIntentions(records) {
  return {
    records,
    due: () => records.filter((r) => r.status === 'pending' && Number.isFinite(r.dueAt) && r.dueAt <= NOW + 10 * DAY_MS && r.dueAt <= clock.t).map((r) => ({ intention: r, reason: 'due', at: r.dueAt })),
    reconcile: () => ({ arrived: 0, missing: 0, deadline: 0, expired: 0 }),
    list: () => records.filter((r) => ['pending', 'waiting', 'proposed'].includes(r.status)),
    store: () => ({ get: (id) => records.find((r) => r.id === id) ?? null }),
  };
}

const clock = { t: NOW };

/** A fake turn runner: records every call, answers `answer(params)` (default a silent skip). */
function fakeTurns({ answer = null } = {}) {
  const calls = [];
  const turns = {
    busy: false,
    calls,
    isAnyBusy: () => turns.busy,
    runTurn: async (params) => {
      calls.push(params);
      if (answer) return answer(params);
      return { outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], stray: null, turnId: `t-${calls.length}` } };
    },
  };
  return turns;
}

function fakeClient(ids = ['c1', 'c2', 'c3']) {
  const channels = new Map(ids.map((id) => [id, { id, name: `chan-${id}`, guild: { id: GUILD } }]));
  return { channels: { cache: channels, fetch: async (id) => channels.get(id) ?? null } };
}

function hotWith({ features = {}, innerLife = {}, timezone = 'UTC' } = {}) {
  return {
    config: {
      bot: { timezone },
      features: { innerLife: true, intentions: true, journal: true, ...features },
      mention: { oneAtATime: true },
      innerLife: { mode: 'shadow', tickSeconds: 60, queueMax: 20, chatMessages: 30, estimatedTurnUsd: 0.15, review: { enabled: false, historyDays: 14 }, caps: { perDay: 24, perHour: 4, perChain: 3, usdPerDay: 4, publicPostsPerDay: 2 }, ...innerLife },
    },
  };
}

/** One inner life over a temp data dir with a real door; `records` its intentions. */
function setup({ records = [], hot = hotWith(), turns = fakeTurns(), dataDir = tempDir('nep-inner-'), record = null, meterUsd = 0.1, rng = seeded(7), client = fakeClient(), peopleWaiting = () => false } = {}) {
  const journal = [];
  const intentions = fakeIntentions(records);
  let inner;
  const door = createEventDoor({ handlers: { 'inner.wake': (event) => inner.onWake(event) }, log: SILENT });
  inner = createInnerLife({
    hot,
    dataDir,
    turns,
    intentions,
    record,
    journal: { inner: async (guildId, fields) => journal.push(fields) },
    client,
    discord: { canSend: () => true },
    submit: (event) => door.submit(event),
    store: { state: { data: {} } },
    getGuildId: () => GUILD,
    peopleWaiting,
    meter: { run: async (fn) => ({ result: await fn(), usd: meterUsd, requests: 1, voice: 1 }) },
    rng,
    now: () => clock.t,
    log: SILENT,
  });
  return { inner, turns, journal, intentions, dataDir, door, hot };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test.beforeEach(() => {
  clock.t = NOW;
});

test('inner: the switch off lists nothing, runs nothing and writes no state', async () => {
  const run = setup({ records: [intention('i1')], hot: hotWith({ features: { innerLife: false } }) });
  const result = await run.inner.tick();
  assert.deepEqual(result, { ran: false, reason: 'off' });
  assert.equal(run.turns.calls.length, 0);
  assert.equal(fs.existsSync(path.join(run.dataDir, 'guilds', GUILD, 'inner.json')), false);
});

test('inner: a due intention is one wake through the door and one inner turn; the next tick does not wake her again', async () => {
  const run = setup({ records: [intention('i1')] });
  const first = await run.inner.tick();
  assert.equal(first.submitted, 1);
  assert.equal(run.turns.calls.length, 1);
  const params = run.turns.calls[0];
  assert.equal(params.mode, 'inner');
  assert.equal(params.trigger, undefined, 'no fabricated message');
  assert.equal(params.channel.id, 'c1');
  assert.equal(params.inner.shadow, true);
  assert.equal(params.inner.wake.kind, 'intention_due');
  assert.deepEqual(params.inner.wake.items.map((item) => item.kind), ['intention_due']);
  assert.deepEqual(params.inner.wake.intentions.map((r) => r.id), ['i1']);
  assert.equal(params.inner.wake.budgets.day.left, 24);
  assert.equal(params.inner.wake.budgets.chain.left, 3);
  const second = await run.inner.tick();
  assert.equal(second.submitted, 0);
  assert.equal(run.turns.calls.length, 1, 'the same due time wakes her once');
  // A new due time is a new wake.
  run.intentions.records[0].dueAt = NOW;
  clock.t = NOW + MINUTE_MS;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 2);
});

test('inner: wakes of one conversation and the day\'s review coalesce into one turn; another conversation waits for its own', async () => {
  const run = setup({ records: [intention('i1', { dueAt: NOW - 3 * MINUTE_MS }), intention('i2', { dueAt: NOW - 2 * MINUTE_MS, channelId: 'c2' }), intention('i3', { dueAt: NOW - MINUTE_MS })] });
  run.turns.busy = true;
  await run.inner.tick();
  await run.inner.onWake({ kind: 'inner.wake', at: NOW, id: reviewWake('2026-10-19', NOW - 30 * MINUTE_MS).id, guildId: GUILD, wake: reviewWake('2026-10-19', NOW - 30 * MINUTE_MS) });
  assert.equal(run.inner.status(GUILD).queue.length, 4);
  run.turns.busy = false;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 1);
  const wake = run.turns.calls[0].inner.wake;
  assert.equal(run.turns.calls[0].channel.id, 'c1');
  assert.deepEqual(wake.items.map((item) => item.kind).sort(), ['intention_due', 'intention_due', 'review']);
  assert.deepEqual(wake.intentions.map((r) => r.id).sort(), ['i1', 'i3']);
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 2);
  assert.equal(run.turns.calls[1].channel.id, 'c2');
  await settle();
  const turn = run.journal.find((r) => r.event === 'turn');
  assert.equal(turn.coalesced.length, 3, 'the coalesced ids are journalled');
});

test('coalesceGroup: a private chat\'s wake never takes the review; only reviews go alone', () => {
  const dm = { id: 'a', kind: 'intention_due', channelId: 'd1', privateChat: true, dueAt: 1 };
  const review = reviewWake('2026-10-19', 2);
  assert.deepEqual(coalesceGroup([review, dm]).map((w) => w.id), ['a']);
  assert.deepEqual(coalesceGroup([review]).map((w) => w.id), [review.id]);
});

test('inner: while a turn holds the attention or a ping waits the wake keeps its due time, then runs once free', async () => {
  let waiting = true;
  const run = setup({ records: [intention('i1', { dueAt: NOW - 5 * MINUTE_MS })], peopleWaiting: () => waiting });
  run.turns.busy = true;
  const held = await run.inner.tick();
  assert.deepEqual(held.drained, { deferred: 'busy' });
  run.turns.busy = false;
  const people = await run.inner.tick();
  assert.deepEqual(people.drained, { deferred: 'people' });
  assert.equal(run.turns.calls.length, 0);
  assert.equal(run.inner.status(GUILD).queue[0].dueAt, NOW - 5 * MINUTE_MS);
  waiting = false;
  clock.t = NOW + 10 * MINUTE_MS;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 1);
});

test('inner: a turn held back by the runner (busy) leaves its wakes queued', async () => {
  const turns = fakeTurns({ answer: () => ({ outcome: 'busy' }) });
  const run = setup({ records: [intention('i1')], turns });
  await run.inner.tick();
  assert.equal(run.inner.status(GUILD).queue.length, 1);
});

test('inner: the queue, the handled wakes and the stop survive a restart; missed ticks coalesce into the first one after it', async () => {
  const dataDir = tempDir('nep-inner-restart-');
  const records = [intention('i1', { dueAt: NOW - HOUR_MS }), intention('i2', { dueAt: NOW - 30 * MINUTE_MS })];
  const first = setup({ records, dataDir });
  first.turns.busy = true;
  await first.inner.tick();
  assert.equal(first.inner.status(GUILD).queue.length, 2);
  // A new process over the same data directory, hours later.
  clock.t = NOW + 3 * HOUR_MS;
  const second = setup({ records, dataDir });
  assert.equal(second.inner.status(GUILD).queue.length, 2);
  await second.inner.tick();
  assert.equal(second.turns.calls.length, 1, 'one turn for both');
  assert.equal(second.turns.calls[0].inner.wake.items.length, 2);
  // Handled survives: a third process lists nothing new.
  const third = setup({ records, dataDir });
  await third.inner.tick();
  assert.equal(third.turns.calls.length, 0);
  third.inner.stop(GUILD, { by: 'owner' });
  const fourth = setup({ records, dataDir });
  assert.equal(fourth.inner.status(GUILD).stopped, true);
  assert.deepEqual(await fourth.inner.tick(), { ran: false, reason: 'stopped' });
});

test('drawReviewAt: a seeded draw falls in an hour she speaks in, never before notBefore; none left is null', () => {
  const timezone = 'Europe/Athens';
  const weights = new Array(24).fill(0);
  weights[20] = 5;
  weights[21] = 1;
  for (let seed = 1; seed <= 50; seed += 1) {
    const at = drawReviewAt({ day: '2026-10-19', weights, timezone, rng: seeded(seed), notBefore: NOW });
    assert.ok([20, 21].includes(localHour(at, timezone)), `seed ${seed}`);
    assert.ok(at >= NOW);
  }
  assert.equal(drawReviewAt({ day: '2026-10-19', weights, timezone, rng: seeded(1), notBefore: zonedEpoch('2026-10-19', 22, 0, timezone) }), null);
  // No line of hers at all: every hour left is offered alike.
  const any = drawReviewAt({ day: '2026-10-19', weights: new Array(24).fill(0), timezone: 'UTC', rng: seeded(3), notBefore: NOW });
  assert.ok(any >= NOW && any < zonedEpoch('2026-10-20', 0, 0, 'UTC'));
  // The same seed, the same moment.
  assert.equal(drawReviewAt({ day: '2026-10-19', weights, timezone, rng: seeded(9) }), drawReviewAt({ day: '2026-10-19', weights, timezone, rng: seeded(9) }));
});

test('hourWeights: only her own lines count, by local hour', () => {
  const lines = [
    { kind: 'said', occurredAt: '2026-10-18T17:10:00Z' },
    { kind: 'said', occurredAt: '2026-10-17T17:50:00Z' },
    { kind: 'seen', occurredAt: '2026-10-17T05:00:00Z' },
  ];
  const weights = hourWeights(lines, 'Europe/Athens');
  assert.equal(weights[20], 2);
  assert.equal(weights.reduce((a, b) => a + b, 0), 2);
});

test('inner: the day\'s review is drawn once from her record inside her hours, wakes her once, and is re-drawn the next day', async () => {
  const lines = [];
  for (let d = 1; d <= 5; d += 1) lines.push({ kind: 'said', occurredAt: new Date(Date.parse('2026-10-19T15:20:00Z') - d * DAY_MS).toISOString(), scope: { channel: 'c3' } });
  const record = { async *iterate() { for (const line of lines) yield line; } };
  const run = setup({ record, hot: hotWith({ innerLife: { review: { enabled: true, historyDays: 14 } } }) });
  clock.t = Date.parse('2026-10-19T08:00:00Z');
  await run.inner.tick();
  const review = run.inner.status(GUILD).review;
  assert.equal(review.day, '2026-10-19');
  assert.equal(new Date(review.at).getUTCHours(), 15);
  assert.equal(run.turns.calls.length, 0, 'not yet');
  clock.t = review.at + MINUTE_MS;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 1);
  assert.equal(run.turns.calls[0].inner.wake.kind, 'review');
  assert.equal(run.turns.calls[0].channel.id, 'c3', 'the channel she was last active in');
  assert.deepEqual(run.turns.calls[0].inner.wake.channels, ['chan-c3']);
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 1, 'once a day');
  clock.t = Date.parse('2026-10-20T08:00:00Z');
  await run.inner.tick();
  assert.equal(run.inner.status(GUILD).review.day, '2026-10-20');
  await settle();
  assert.equal(run.journal.filter((r) => r.event === 'review-drawn').length, 2);
});

test('inner: the day cap refuses the next turn and journals it once per wake', async () => {
  const run = setup({ records: [intention('i1', { dueAt: NOW - 2 * MINUTE_MS }), intention('i2', { dueAt: NOW - MINUTE_MS, channelId: 'c2' })], hot: hotWith({ innerLife: { caps: { perDay: 1, perHour: 4, perChain: 3, usdPerDay: 4, publicPostsPerDay: 2 } } }) });
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 1);
  const refused = await run.inner.tick();
  assert.deepEqual(refused.drained, { refused: 'per-day' });
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 1);
  await settle();
  assert.equal(run.journal.filter((r) => r.event === 'capped' && r.cap === 'per-day').length, 1);
  // The next local day it runs.
  clock.t = NOW + DAY_MS;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 2);
});

test('inner: the hour cap rolls, the chain cap ends the chain, the dollar cap counts the reserve', async () => {
  const caps = { perDay: 24, perHour: 1, perChain: 3, usdPerDay: 4, publicPostsPerDay: 2 };
  const hourly = setup({ records: [intention('i1', { dueAt: NOW - 2 * MINUTE_MS }), intention('i2', { dueAt: NOW - MINUTE_MS, channelId: 'c2' })], hot: hotWith({ innerLife: { caps } }) });
  await hourly.inner.tick();
  assert.deepEqual((await hourly.inner.tick()).drained, { refused: 'per-hour' });
  clock.t = NOW + HOUR_MS + MINUTE_MS;
  await hourly.inner.tick();
  assert.equal(hourly.turns.calls.length, 2);

  clock.t = NOW;
  const chained = setup({ records: [intention('i1', { chainId: 'k' }), intention('i2', { chainId: 'k', channelId: 'c2' })], hot: hotWith({ innerLife: { caps: { ...caps, perHour: 4, perChain: 1 } } }) });
  await chained.inner.tick();
  assert.deepEqual((await chained.inner.tick()).drained, { refused: 'per-chain' });
  assert.equal(chained.inner.status(GUILD).queue.length, 0, 'a spent chain\'s wakes are done with');
  assert.equal(chained.turns.calls.length, 1);

  const poor = setup({ records: [intention('i1')], hot: hotWith({ innerLife: { estimatedTurnUsd: 0.15, caps: { ...caps, usdPerDay: 0.1 } } }) });
  assert.deepEqual((await poor.inner.tick()).drained, { refused: 'usd-per-day' });
  assert.equal(poor.turns.calls.length, 0);
});

test('budgetsOf and capRefusal: the facts she is given and the order of the caps', () => {
  const settings = innerSettings(hotWith().config);
  const state = { ...emptyState(), turns: [{ at: NOW - 10 * MINUTE_MS, chainId: 'a', usd: 1 }], spend: [{ at: NOW - 10 * MINUTE_MS, usd: 1 }], posts: [NOW - MINUTE_MS] };
  const b = budgetsOf(state, settings, { now: NOW, timezone: 'UTC', reserved: 0.5 });
  assert.deepEqual(b.day, { used: 1, cap: 24, left: 23, resetAt: Date.parse('2026-10-20T00:00:00Z') });
  assert.equal(b.hour.resetAt, NOW + 50 * MINUTE_MS);
  assert.equal(b.usd.used, 1.5);
  assert.equal(b.usd.left, 2.5);
  assert.equal(b.posts.left, 1);
  assert.equal(capRefusal(b, chainBudget(state, 'a', 3), 0.15), null);
  assert.equal(capRefusal(b, chainBudget({ ...state, chains: { a: { turns: 3, lastAt: NOW } } }, 'a', 3), 0.15), 'per-chain');
  assert.equal(capRefusal({ ...b, usd: { ...b.usd, used: 3.9 } }, chainBudget(state, 'a', 3), 0.15), 'usd-per-day');
});

test('inner: the public post cap is asked by the turn, and each post counts', async () => {
  const turns = fakeTurns({
    answer: (params) => {
      const allowed = [];
      for (let i = 0; i < 3; i += 1) {
        allowed.push(params.inner.postAllowed());
        if (allowed[i]) params.inner.onPosted();
      }
      return { outcome: 'spoke', inner: { actions: [], turnId: 't1' }, allowed };
    },
  });
  const run = setup({ records: [intention('i1')], turns, hot: hotWith({ innerLife: { mode: 'live' } }) });
  await run.inner.tick();
  assert.equal(run.turns.calls[0].inner.shadow, false);
  assert.equal(run.inner.status(GUILD).budgets.posts.used, 2);
});

test('inner: stop drops the queue and is seen by a running turn before its next action; start releases it', async () => {
  let seenDuringTurn = null;
  let run;
  const turns = fakeTurns({
    answer: (params) => {
      const before = params.inner.mayAct();
      run.inner.stop(GUILD, { by: 'owner' });
      seenDuringTurn = { before, after: params.inner.mayAct() };
      return { outcome: 'spoke', inner: { actions: [], turnId: 't1' } };
    },
  });
  run = setup({ records: [intention('i1', { dueAt: NOW - 2 * MINUTE_MS }), intention('i2', { dueAt: NOW - MINUTE_MS, channelId: 'c2' })], turns });
  await run.inner.tick();
  assert.deepEqual(seenDuringTurn, { before: true, after: false });
  assert.equal(run.inner.status(GUILD).queue.length, 0, 'the other wake was dropped');
  assert.deepEqual(await run.inner.tick(), { ran: false, reason: 'stopped' });
  assert.equal((await run.inner.onWake({ kind: 'inner.wake', at: NOW, id: 'x', guildId: GUILD, wake: reviewWake('2026-10-19', NOW) })).status, 'stopped');
  await settle();
  const stopped = run.journal.find((r) => r.event === 'stopped');
  assert.equal(stopped.dropped, 1);
  run.inner.start(GUILD);
  assert.equal(run.inner.status(GUILD).stopped, false);
});

test('inner: a wake whose intention closed meanwhile is stale; a full queue records the overflow', async () => {
  const records = [intention('i1')];
  const run = setup({ records, hot: hotWith({ innerLife: { queueMax: 1 } }) });
  run.turns.busy = true;
  await run.inner.tick();
  const over = await run.inner.onWake({ kind: 'inner.wake', at: NOW, id: 'w2', guildId: GUILD, wake: reviewWake('2026-10-19', NOW) });
  assert.equal(over.status, 'overflow');
  records[0].status = 'cancelled';
  run.turns.busy = false;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 0);
  await settle();
  assert.ok(run.journal.some((r) => r.event === 'overflow'));
  assert.ok(run.journal.some((r) => r.event === 'stale'));
});

test('inner: the journal records the wake and the turn with its outcome, actions and cost; an errand it handed off adds its cost', async () => {
  const turns = fakeTurns({ answer: () => ({ outcome: 'spoke', shadow: true, inner: { actions: [{ skill: 'message.create', status: 'proposed', result: 'ok', code: 'shadow', target: { channel: 'c2' } }], stray: { messages: 1, reactions: 0, gif: 0, draw: 0 }, turnId: 't-9' } }) });
  const run = setup({ records: [intention('i1')], turns, meterUsd: 0.12 });
  await run.inner.tick();
  await settle();
  const wake = run.journal.find((r) => r.event === 'wake');
  assert.equal(wake.wake.kind, 'intention_due');
  const turn = run.journal.find((r) => r.event === 'turn');
  assert.equal(turn.outcome, 'spoke');
  assert.equal(turn.shadow, true);
  assert.deepEqual(turn.actions.map((a) => a.status), ['proposed']);
  assert.equal(turn.cost.usd, 0.12);
  assert.equal(turn.turnId, 't-9');
  assert.equal(run.inner.onTaskFinished({ id: 'k1', origin: { turnId: 't-9' }, usage: { usd: 0.5 } }, GUILD), true);
  assert.equal(run.inner.onTaskFinished({ id: 'k2', origin: { turnId: 'other' }, usage: { usd: 0.5 } }, GUILD), false);
  assert.equal(run.inner.status(GUILD).budgets.usd.used, 0.62);
});

test('wakeOfDue: a wait past its deadline names its errand; the chain is the intention\'s', () => {
  const wake = wakeOfDue({ intention: { ...intention('i1', { chainId: 'k' }), status: 'waiting', awaitingTaskId: 'T1' }, reason: 'wait-deadline', at: 5 });
  assert.equal(wake.kind, 'errand_deadline');
  assert.equal(wake.id, 'inner.wake:errand_deadline:i1:T1');
  assert.equal(wake.chainId, 'chain:k');
  assert.equal(wakeOfDue({ intention: intention('i2'), reason: 'due', at: 7 }).chainId, 'intention:i2');
});

test('inner: what one drain hands off (a stale wake, then a spent chain) is all on disk afterwards', async () => {
  const dataDir = tempDir('nep-inner-drain-');
  const records = [intention('i1', { dueAt: NOW - 3 * MINUTE_MS }), intention('i2', { dueAt: NOW - 2 * MINUTE_MS, chainId: 'k' })];
  const hot = hotWith({ innerLife: { caps: { perDay: 24, perHour: 4, perChain: 1, usdPerDay: 4, publicPostsPerDay: 2 } } });
  const run = setup({ records, dataDir, hot });
  run.turns.busy = true;
  await run.inner.tick();
  // Chain k already spent; i1 closed meanwhile.
  run.inner.state(GUILD).chains['chain:k'] = { turns: 1, lastAt: NOW };
  records[0].status = 'done';
  run.turns.busy = false;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 0);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'guilds', GUILD, 'inner.json'), 'utf8'));
  assert.deepEqual(onDisk.queue, []);
  assert.deepEqual(Object.values(onDisk.handled).map((entry) => entry.outcome).sort(), ['chain-cap', 'stale']);
});
