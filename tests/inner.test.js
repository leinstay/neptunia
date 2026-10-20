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
  attendWake,
  placesPage,
  chainBudget,
  coalesceGroup,
  createCostMeter,
  createInnerLife,
  currentChannelOf,
  drawHeartbeatAt,
  drawReviewAt,
  heartbeatWake,
  emptyState,
  feedbackFacts,
  hourWeights,
  innerSettings,
  reviewWake,
  wakeOfDue,
  DELIVERY_SKILLS,
  turnsToday,
  WAKE_KINDS,
} from '../src/behavior/inner.js';
import { createEventDoor } from '../src/interface/door.js';
import { createIntentionStores } from '../src/intentions/store.js';
import { createIntentionService } from '../src/intentions/service.js';
import { createIntention } from '../src/intentions/model.js';
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
    store: () => ({ get: (id) => records.find((r) => r.id === id) ?? null, list: () => records }),
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
      return { outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], turnId: `t-${calls.length}` } };
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
      innerLife: { mode: 'shadow', tickSeconds: 60, queueMax: 20, chatMessages: 30, review: { enabled: false, historyDays: 14 }, heartbeat: { enabled: false }, caps: { perChain: 3 }, ...innerLife },
    },
  };
}

/** One inner life over a temp data dir with a real door; `records` its intentions. */
function setup({ records = [], hot = hotWith(), turns = fakeTurns(), dataDir = tempDir('nep-inner-'), record = null, meterUsd = 0.1, meter = null, rng = seeded(7), client = fakeClient(), peopleWaiting = () => false, onEpisode = null, service = null, log = SILENT } = {}) {
  const journal = [];
  const intentions = service ?? fakeIntentions(records);
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
    meter: meter ?? { run: async (fn) => ({ result: await fn(), usd: meterUsd, requests: 1, voice: 1 }) },
    rng,
    now: () => clock.t,
    onEpisode,
    log,
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
  assert.equal(params.inner.wake.budgets.day, undefined);
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

test('inner: no count of turns refuses one: a day and an hour of turns all run', async () => {
  const run = setup({ records: [intention('i1', { dueAt: NOW - 3 * MINUTE_MS }), intention('i2', { dueAt: NOW - 2 * MINUTE_MS, channelId: 'c2' }), intention('i3', { dueAt: NOW - MINUTE_MS, channelId: 'c3' })], hot: hotWith({ innerLife: { caps: { perDay: 1, perHour: 1, perChain: 3 } } }) });
  for (let i = 0; i < 3; i += 1) assert.equal((await run.inner.tick()).drained.outcome, 'skip');
  assert.equal(run.turns.calls.length, 3);
  await settle();
  assert.equal(run.journal.filter((r) => r.event === 'capped').length, 0);
});

test('inner: a chain past its cap is held, not dropped: its wake waits capped per-chain and runs after the local midnight', async () => {
  const caps = { perChain: 1 };
  const run = setup({ records: [intention('i1', { chainId: 'k' }), intention('i2', { chainId: 'k', channelId: 'c2' })], hot: hotWith({ innerLife: { caps } }) });
  await run.inner.tick();
  assert.deepEqual((await run.inner.tick()).drained, { refused: 'per-chain' });
  // The hold is told by a feedback wake (no turn was coming to carry it); no cap holds that.
  assert.deepEqual(run.inner.state(GUILD).queue.map((wake) => wake.kind), ['intention_due', 'feedback']);
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 2);
  assert.equal(run.turns.calls[1].inner.wake.kind, 'feedback');
  assert.equal(run.inner.state(GUILD).queue.length, 1, 'the held wake stays queued');
  assert.equal(run.inner.state(GUILD).queue[0].capped, 'per-chain');
  assert.equal(Object.keys(run.inner.state(GUILD).handled).filter((id) => !id.includes(':feedback:')).length, 1, 'only the first intention wake is handled');
  await settle();
  assert.equal(run.journal.filter((r) => r.event === 'capped' && r.cap === 'per-chain').length, 1, 'journalled once per wake');
  // Later the same day it still waits; the local midnight releases it.
  clock.t = NOW + 6 * HOUR_MS;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 2);
  clock.t = NOW + 13 * HOUR_MS;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 3);
  assert.equal(run.turns.calls[2].channel.id, 'c2');
  assert.equal(run.inner.state(GUILD).queue.length, 0);
});

test('inner: a wake of another chain that shares the conversation of a held one runs now and leaves the held one queued', async () => {
  const run = setup({ records: [intention('i1', { chainId: 'k', dueAt: NOW - 3 * MINUTE_MS }), intention('i2', { dueAt: NOW - 2 * MINUTE_MS })], hot: hotWith({ innerLife: { caps: { perChain: 1 } } }) });
  run.turns.busy = true;
  await run.inner.tick();
  run.inner.state(GUILD).turns.push({ at: NOW - MINUTE_MS, chainId: 'chain:k', outcome: 'spoke' });
  run.turns.busy = false;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 1);
  assert.deepEqual(run.turns.calls[0].inner.wake.intentions.map((r) => r.id), ['i2']);
  assert.equal(run.turns.calls[0].inner.wake.budgets.chain.cap, 1);
  const queue = run.inner.state(GUILD).queue;
  assert.deepEqual(queue.map((wake) => `${wake.intentionIds[0]}:${wake.capped}`), ['i1:per-chain']);
});

test('coalesceGroup: a wake the caller holds is left out of every group, a review included', () => {
  const held = { id: 'h', kind: 'intention_due', channelId: 'c1', dueAt: 1 };
  const mate = { id: 'a', kind: 'intention_due', channelId: 'c1', dueAt: 2 };
  const review = reviewWake('2026-10-19', 3);
  const isHeld = (wake) => wake.id === 'h';
  assert.deepEqual(coalesceGroup([held, mate, review], isHeld).map((w) => w.id), ['a', review.id]);
  assert.deepEqual(coalesceGroup([held, review], isHeld).map((w) => w.id), [review.id]);
  assert.deepEqual(coalesceGroup([held], isHeld), []);
});

test('chainBudget and turnsToday: counted on the local day, a failed attempt is no turn', () => {
  const day = Date.parse('2026-10-19T00:00:00Z');
  const state = { ...emptyState(), turns: [{ at: day - HOUR_MS, chainId: 'a' }, { at: day + HOUR_MS, chainId: 'a' }, { at: day + 2 * HOUR_MS, chainId: 'a', failed: true }, { at: day + 3 * HOUR_MS, chainId: 'b' }] };
  assert.deepEqual(chainBudget(state, 'a', 3, { now: NOW, timezone: 'UTC' }), { used: 1, cap: 3, left: 2 });
  assert.deepEqual(chainBudget(state, 'a', 1, { now: NOW, timezone: 'UTC' }), { used: 1, cap: 1, left: 0 });
  assert.equal(chainBudget(state, 'a', 3, { now: NOW + DAY_MS, timezone: 'UTC' }).used, 0, 'the next local day starts at nothing');
  assert.equal(turnsToday(state, { now: NOW, timezone: 'UTC' }), 2);
});

test('inner: the turn is handed no post counter and no delivery channels: nothing counts posts', async () => {
  const run = setup({ records: [intention('i1')], hot: hotWith({ innerLife: { mode: 'live' } }) });
  await run.inner.tick();
  assert.equal(run.turns.calls[0].inner.shadow, false);
  assert.equal(run.turns.calls[0].inner.postAllowed, undefined);
  assert.equal(run.turns.calls[0].inner.onPosted, undefined);
  assert.equal(run.turns.calls[0].inner.deliveryChannels, undefined);
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
  const turns = fakeTurns({ answer: () => ({ outcome: 'spoke', shadow: true, inner: { actions: [{ skill: 'message.create', status: 'proposed', result: 'ok', code: 'shadow', target: { channel: 'c2' } }], turnId: 't-9' } }) });
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
  assert.equal(run.inner.status(GUILD).spentUsd, 0.62);
});

test('wakeOfDue: a wait past its deadline names its errand; the chain is the intention\'s', () => {
  const wake = wakeOfDue({ intention: { ...intention('i1', { chainId: 'k' }), status: 'waiting', awaitingTaskId: 'T1' }, reason: 'wait-deadline', at: 5 });
  assert.equal(wake.kind, 'errand_deadline');
  assert.equal(wake.id, 'inner.wake:errand_deadline:i1:T1');
  assert.equal(wake.chainId, 'chain:k');
  assert.equal(wakeOfDue({ intention: intention('i2'), reason: 'due', at: 7 }).chainId, 'intention:i2');
});

test('inner: what one drain hands off (a stale wake) and keeps (the wake of a held chain) is all on disk afterwards', async () => {
  const dataDir = tempDir('nep-inner-drain-');
  const records = [intention('i1', { dueAt: NOW - 3 * MINUTE_MS }), intention('i2', { dueAt: NOW - 2 * MINUTE_MS, chainId: 'k' })];
  const hot = hotWith({ innerLife: { caps: { perChain: 1 } } });
  const run = setup({ records, dataDir, hot });
  run.turns.busy = true;
  await run.inner.tick();
  // Chain k already spent; i1 closed meanwhile.
  run.inner.state(GUILD).turns.push({ at: NOW - MINUTE_MS, chainId: 'chain:k', outcome: 'spoke' });
  records[0].status = 'done';
  run.turns.busy = false;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 0);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'guilds', GUILD, 'inner.json'), 'utf8'));
  assert.deepEqual(onDisk.queue.filter((wake) => wake.kind !== 'feedback').map((wake) => `${wake.intentionIds[0]}:${wake.capped}`), ['i2:per-chain']);
  assert.deepEqual(onDisk.queue.filter((wake) => wake.kind === 'feedback').map((wake) => wake.factIds.length), [1], 'the hold, told by a feedback wake');
  assert.deepEqual(onDisk.facts.map((fact) => `${fact.kind}:${fact.code}`), ['wakeDropped:stale', 'wakeHeld:per-chain']);
  assert.deepEqual(Object.values(onDisk.handled).map((entry) => entry.outcome), ['stale']);
});

test('inner: a state file that cannot be read is moved aside, journalled and told as a stateLost fact, never a silent empty start', async () => {
  const dataDir = tempDir('nep-inner-lost-');
  const dir = path.join(dataDir, 'guilds', GUILD);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'inner.json'), '{"queue": [');
  const run = setup({ dataDir });
  const state = run.inner.state(GUILD);
  assert.deepEqual(state.queue, [], 'she starts empty');
  const aside = fs.readdirSync(dir).filter((name) => name.startsWith('inner.json.bad-'));
  assert.equal(aside.length, 1, 'the old file is kept');
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{"queue": [');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'inner.json'), 'utf8')).facts.map((fact) => [fact.kind, fact.code, fact.told]), [['stateLost', 'parse', false]]);
  await settle();
  assert.deepEqual(run.journal.filter((fields) => fields.event === 'stateLost').map((fields) => [fields.code, fields.kept]), [['parse', true]]);
  // Told once at her next turn, in a server channel or in a wake, and not in a private chat.
  assert.deepEqual(run.inner.facts.pending(GUILD, { channelId: 'c1', privateChat: false }).map((fact) => fact.kind), ['stateLost']);
  assert.deepEqual(run.inner.facts.pending(GUILD, { channelId: 'd1', privateChat: true }), []);
  // A missing file is a first start, not a loss.
  const fresh = setup({ dataDir: tempDir('nep-inner-fresh-') });
  assert.deepEqual(fresh.inner.state(GUILD).facts ?? [], []);
});

test('inner: what a turn did and found is handed to her memory, shadow or not; a turn without an episode hands nothing', async () => {
  const episode = { turnId: 't-1', shadow: true, channelId: 'c1', findings: [{ skill: 'web.search', args: {}, text: 'x' }] };
  const handed = [];
  const turns = fakeTurns({ answer: () => ({ outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], turnId: 't-1', episode } }) });
  const run = setup({ records: [intention('i1'), intention('i2', { channelId: 'c2' })], turns, onEpisode: (guildId, given) => handed.push({ guildId, given }) });
  await run.inner.tick();
  assert.deepEqual(handed, [{ guildId: GUILD, given: episode }]);
  const quiet = setup({ records: [intention('i3')], onEpisode: (guildId, given) => handed.push({ guildId, given }) });
  await quiet.inner.tick();
  assert.equal(handed.length, 1);
  // A memory that throws never breaks the inner life.
  const broken = setup({ records: [intention('i4')], turns: fakeTurns({ answer: () => ({ outcome: 'skip', inner: { actions: [], turnId: 't-2', episode } }) }), onEpisode: () => { throw new Error('boom'); } });
  const result = await broken.inner.tick();
  assert.equal(result.ran, true);
});

/** A real cost meter over its own listeners, and `emit` to log a line into it. */
function ownMeter() {
  const listeners = new Set();
  const meter = createCostMeter({ subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)) });
  return { meter, emit: (entry) => listeners.forEach((fn) => fn(entry)) };
}

test('createCostMeter: running() says what the run has cost so far and its costliest request; zeros outside it', async () => {
  const { meter, emit } = ownMeter();
  const seen = [];
  const out = await meter.run(async () => {
    emit({ msg: 'llm: usage', role: 'core', cost: 0.2 });
    seen.push(meter.running());
    emit({ msg: 'llm: usage', role: 'helper', upstreamCost: 0.05, cost: 9 });
    seen.push(meter.running());
  });
  assert.deepEqual(seen, [{ usd: 0.2, peak: 0.2 }, { usd: 0.25, peak: 0.2 }]);
  assert.deepEqual([out.usd, out.requests, out.voice], [0.25, 2, 1]);
  assert.deepEqual(meter.running(), { usd: 0, peak: 0 });
});

test('inner: what turns cost never refuses the next one; the day\'s spend is only reported', async () => {
  const { meter, emit } = ownMeter();
  const turns = fakeTurns({
    answer: () => {
      emit({ msg: 'llm: usage', role: 'core', cost: 5 });
      emit({ msg: 'llm: usage', role: 'core', cost: 5 });
      return { outcome: 'spoke', inner: { actions: [], turnId: `t-${turns.calls.length}` } };
    },
  });
  const records = [intention('i1', { dueAt: NOW - 3 * MINUTE_MS }), intention('i2', { dueAt: NOW - 2 * MINUTE_MS, channelId: 'c2' }), intention('i3', { dueAt: NOW - MINUTE_MS, channelId: 'c3' })];
  const run = setup({ records, turns, meter });
  await run.inner.tick();
  await run.inner.tick();
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 3);
  assert.equal(run.inner.status(GUILD).spentUsd, 30);
});

test('inner: an errand an inner turn handed off has its cost recorded when it ends, as a figure with no hold', async () => {
  clock.t = NOW;
  const turns = fakeTurns({ answer: () => ({ outcome: 'spoke', inner: { actions: [], turnId: 't-e' } }) });
  const run = setup({ records: [intention('i1')], turns, hot: hotWith({ innerLife: { mode: 'live' } }) });
  await run.inner.tick();
  await settle();
  assert.equal(run.inner.onTaskFinished({ id: 'k1', origin: { turnId: 't-e' }, usage: { usd: 0.25 } }, GUILD), true);
  assert.equal(run.inner.onTaskFinished({ id: 'k2', origin: { turnId: 'elsewhere' }, usage: { usd: 0.25 } }, GUILD), false);
  assert.equal(run.inner.status(GUILD).spentUsd, 0.35, 'the turn\'s real 0.1 and the errand\'s 0.25');
  await settle();
  const cost = run.journal.find((r) => r.event === 'errand-cost');
  assert.equal(cost.taskId, 'k1');
  assert.equal(cost.usd, 0.25);
  assert.equal('heldUsd' in cost, false);
});

test('inner status: chains, spend, open intentions, the next wake and the last turn for the status card', async () => {
  const run = setup({
    records: [
      intention('i1', { dueAt: NOW - MINUTE_MS, chainId: 'k1' }),
      intention('i2', { dueAt: NOW + 3 * HOUR_MS, status: 'waiting' }),
      intention('i3', { dueAt: NOW + HOUR_MS, status: 'pending' }),
      intention('i4', { dueAt: null, status: 'proposed' }),
    ],
    meterUsd: 0.25,
  });
  const before = run.inner.status(GUILD);
  assert.equal(before.lastTurn, null);
  assert.equal(before.chains, 0);
  assert.deepEqual(before.intentions, { pending: 2, waiting: 1, proposed: 1 });
  assert.deepEqual(before.next, { at: NOW - MINUTE_MS, kind: 'intention' });
  await run.inner.tick();
  clock.t = NOW + MINUTE_MS;
  const after = run.inner.status(GUILD);
  assert.equal(after.turnsToday, 1);
  assert.equal(after.chains, 1);
  assert.equal(after.spentUsd, 0.25);
  assert.deepEqual(after.lastTurn, { at: NOW, outcome: 'skip' });
  assert.deepEqual(after.next, { at: NOW + HOUR_MS, kind: 'intention' }, 'the next intention to come due, the handled one behind');
});

// ---- recurring intentions ------------------------------------------------------------

/** The production intention service over the inner life's temp data directory. */
function realIntentions(hot, dataDir) {
  hot.config.intentions = { expiresDays: 14, recurringExpiresDays: 30, maxOpen: 20, maxCandidates: 5, candidateExpiresHours: 48, waitHours: 2 };
  return createIntentionService({ stores: createIntentionStores({ dataDir, now: () => clock.t, log: SILENT }), hot, getGuildId: () => GUILD, now: () => clock.t, log: SILENT });
}

test('inner: a recurring intention advances when its wake is disposed of -- recurred when her turn named it, missed when not; one wake per occurrence; each occurrence is its own chain', async () => {
  const dataDir = tempDir('nep-inner-');
  const hot = hotWith();
  const service = realIntentions(hot, dataDir);
  let named = ['x'];
  const turns = fakeTurns({ answer: () => ({ outcome: 'spoke', inner: { actions: [], intentIds: named, turnId: 't-r' } }) });
  const run = setup({ service, hot, turns, dataDir });
  const first = NOW - MINUTE_MS;
  const set = service.set(GUILD, { purpose: 'look for memes', dueAt: first, every: { period: 'day', at: null }, channelId: 'c1', scope: 'group' });
  assert.equal(set.ok, true, set.code);
  const id = set.intention.id;
  named = [id];
  await run.inner.tick();
  await settle();
  assert.equal(run.turns.calls.length, 1);
  assert.equal(run.turns.calls[0].inner.wake.chainId, `intention:${id}:${first}`, 'this occurrence\'s own chain');
  assert.equal(run.turns.calls[0].inner.wake.notes, undefined, 'not the last occurrence');
  let record = service.store(GUILD).get(id);
  assert.equal(record.status, 'pending');
  assert.equal(record.dueAt, first + DAY_MS, 'the next occurrence, after the turn');
  assert.equal(record.history.at(-1).code, 'recurred');
  assert.deepEqual(run.journal.filter((r) => r.event === 'recurred').map((r) => [r.intentionId, r.code, r.outcome]), [[id, 'recurred', 'spoke']]);
  // The same occurrence never wakes her twice: the next tick lists nothing new.
  const again = await run.inner.tick();
  assert.equal(again.submitted, 0);
  assert.equal(run.turns.calls.length, 1);
  assert.deepEqual(run.inner.status(GUILD).next, { at: first + DAY_MS, kind: 'intention' });
  // The next day, a turn that names nothing: the occurrence is missed, the intention goes on.
  named = [];
  clock.t = first + DAY_MS + MINUTE_MS;
  await run.inner.tick();
  await settle();
  assert.equal(run.turns.calls.length, 2);
  assert.equal(run.turns.calls[1].inner.wake.chainId, `intention:${id}:${first + DAY_MS}`);
  record = service.store(GUILD).get(id);
  assert.equal(record.history.at(-1).code, 'missed');
  assert.equal(record.dueAt, first + 2 * DAY_MS);
  // Two occurrences, two chains: the per-chain cap bounds one occurrence, not the intention's life.
  assert.equal(run.inner.status(GUILD).chains, 1, 'one chain today');
  const state = run.inner.state(GUILD);
  assert.equal(new Set(state.turns.map((turn) => turn.chainId)).size, 2);
});

test('inner: a dropped wake of a recurring intention (no channel, overflow, stale) still advances it; the last occurrence before expiry carries its note', async () => {
  const dataDir = tempDir('nep-inner-');
  const hot = hotWith({ innerLife: { queueMax: 1 } });
  const service = realIntentions(hot, dataDir);
  const turns = fakeTurns();
  const run = setup({ service, hot, turns, dataDir });
  const first = NOW - MINUTE_MS;
  // No usable conversation: dropped, missed, advanced.
  const nowhere = service.set(GUILD, { purpose: 'nowhere', dueAt: first, every: { period: '12h', at: null }, channelId: 'c-gone', scope: 'group' }).intention;
  await run.inner.tick();
  await settle();
  assert.equal(run.turns.calls.length, 0);
  assert.ok(run.journal.some((r) => r.event === 'no-channel'));
  let record = service.store(GUILD).get(nowhere.id);
  assert.equal(record.history.at(-1).code, 'missed');
  assert.equal(record.dueAt, first + 12 * HOUR_MS);
  // The queue full: the overflowing wake is handled, its intention advanced.
  run.turns.busy = true;
  const held = service.set(GUILD, { purpose: 'held', dueAt: first, channelId: 'c1', scope: 'group' }).intention;
  await run.inner.tick();
  assert.equal(run.inner.state(GUILD).queue.map((w) => w.intentionIds[0]).join(), held.id);
  const over = service.set(GUILD, { purpose: 'over', dueAt: first, every: { period: 'day', at: null }, channelId: 'c1', scope: 'group' }).intention;
  await run.inner.tick();
  await settle();
  assert.ok(run.journal.some((r) => r.event === 'overflow'));
  assert.equal(service.store(GUILD).get(over.id).history.at(-1).code, 'missed');
  assert.ok(service.store(GUILD).get(over.id).dueAt > clock.t);
  // Stale: the intention closed meanwhile is cancelled, nothing to advance; the others are untouched.
  service.cancel(GUILD, held.id);
  run.turns.busy = false;
  await run.inner.tick();
  await settle();
  assert.ok(run.journal.some((r) => r.event === 'stale'));
  assert.equal(run.turns.calls.length, 0);
  // The last occurrence before the expiry: the wake carries the note; after it the expiry wins.
  const last = service.set(GUILD, { purpose: 'last one', dueAt: first, every: { period: 'day', at: null }, expiresAt: NOW + 12 * HOUR_MS, channelId: 'c2', scope: 'group' }).intention;
  await run.inner.tick();
  await settle();
  assert.equal(run.turns.calls.length, 1);
  assert.deepEqual(run.turns.calls[0].inner.wake.notes, { [last.id]: 'last-occurrence' });
  record = service.store(GUILD).get(last.id);
  assert.ok(record.dueAt > record.expiresAt, 'the next occurrence lies past the expiry');
  clock.t = NOW + 12 * HOUR_MS;
  await run.inner.tick();
  await settle();
  assert.equal(service.store(GUILD).get(last.id).status, 'expired');
  assert.equal(run.turns.calls.length, 1, 'no wake past the expiry');
  // The three drops reached her in the wake of the one turn that ran.
  assert.deepEqual(run.turns.calls[0].inner.wake.facts.map((fact) => `${fact.code}:${fact.why ?? ''}`), ['no-channel:unavailable', 'overflow:', 'stale:cancelled']);
});

test('inner: a review tells her once which intentions of hers expired untouched -- the newest first, capped with the rest counted, never a candidate; a held review lists them again; the rest come next time', async () => {
  const dataDir = tempDir('nep-inner-');
  const hot = hotWith({ innerLife: { review: { enabled: true, historyDays: 14, expiredMax: 2 } } });
  const service = realIntentions(hot, dataDir);
  let held = true;
  const turns = fakeTurns({ answer: () => (held ? { outcome: 'busy' } : { outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], turnId: 't-rv' } }) });
  const lines = [];
  for (let d = 1; d <= 5; d += 1) lines.push({ kind: 'said', occurredAt: new Date(Date.parse('2026-10-19T15:20:00Z') - d * DAY_MS).toISOString(), scope: { channel: 'c1' } });
  const record = { async *iterate() { for (const line of lines) yield line; } };
  const run = setup({ service, hot, turns, dataDir, record });
  // Three of hers with no due time, set a day ago, expiring one after another; one alive; a candidate that expires too.
  clock.t = NOW - DAY_MS;
  const a = service.set(GUILD, { purpose: 'first', expiresAt: NOW - 3 * HOUR_MS, channelId: 'c1', scope: 'group' }).intention;
  const b = service.set(GUILD, { purpose: 'second', expiresAt: NOW - 2 * HOUR_MS, channelId: 'c1', scope: 'group' }).intention;
  const c = service.set(GUILD, { purpose: 'third', expiresAt: NOW - HOUR_MS, channelId: 'c1', scope: 'group' }).intention;
  service.set(GUILD, { purpose: 'alive', channelId: 'c1', scope: 'group' });
  const candidate = createIntention({ purpose: 'never hers', provenance: { kind: 'candidate', span: 'x' }, expiresAt: NOW - 30 * MINUTE_MS, now: clock.t, id: 'i0cand000' }).intention;
  assert.equal(service.store(GUILD).add(candidate).ok, true);
  for (const t of [NOW - 3 * HOUR_MS, NOW - 2 * HOUR_MS, NOW - HOUR_MS, NOW]) {
    clock.t = t;
    service.list(GUILD);
  }
  assert.deepEqual(service.list(GUILD, { closed: true }).filter((r) => r.status === 'expired').map((r) => r.id).sort(), [a.id, b.id, c.id, candidate.id].sort());
  // The review drawn at noon, run at its moment: held by the runner, it lists them and marks nothing.
  await run.inner.tick();
  const review = run.inner.status(GUILD).review;
  clock.t = review.at + MINUTE_MS;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 1);
  const expected = { items: [{ id: c.id, purpose: 'third', at: NOW - HOUR_MS }, { id: b.id, purpose: 'second', at: NOW - 2 * HOUR_MS }], more: 1 };
  assert.deepEqual(run.turns.calls[0].inner.wake.expired, expected);
  assert.equal(service.store(GUILD).get(c.id).expiredShownAt, undefined, 'a held review shows nothing');
  // Free: the same list, then the listed ones are marked at the turn's end; the one past the cap is not.
  held = false;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 2);
  assert.deepEqual(run.turns.calls[1].inner.wake.expired, expected);
  assert.equal(service.store(GUILD).get(c.id).expiredShownAt, clock.t);
  assert.equal(service.store(GUILD).get(b.id).expiredShownAt, clock.t);
  assert.equal(service.store(GUILD).get(a.id).expiredShownAt, undefined);
  assert.equal(service.store(GUILD).get(candidate.id).expiredShownAt, undefined, 'a candidate is never listed nor marked');
  // The next day's review carries the one that was counted but not listed; the day after, nothing.
  clock.t = Date.parse('2026-10-20T08:00:00Z');
  await run.inner.tick();
  clock.t = run.inner.status(GUILD).review.at + MINUTE_MS;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 3);
  assert.deepEqual(run.turns.calls[2].inner.wake.expired, { items: [{ id: a.id, purpose: 'first', at: NOW - 3 * HOUR_MS }], more: 0 });
  assert.equal(service.store(GUILD).get(a.id).expiredShownAt, clock.t);
  clock.t = Date.parse('2026-10-21T08:00:00Z');
  await run.inner.tick();
  clock.t = run.inner.status(GUILD).review.at + MINUTE_MS;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 4);
  assert.equal(run.turns.calls[3].inner.wake.expired, undefined, 'nothing left to tell');
  assert.equal(run.turns.calls[3].inner.wake.kind, 'review');
});

// ---- her attention ------------------------------------------------------------------------

/** A fake record over `lines` (`{ kind, messageId, occurredAt, by, scope }`): iterate filters by `from`. */
function fakeRecord(lines) {
  return {
    lines,
    async *iterate(_guild, { from } = {}) {
      const since = from ? Date.parse(from) : -Infinity;
      for (const line of lines) if (Date.parse(line.occurredAt) >= since) yield line;
    },
  };
}

/** One observed line of `by` in `channel` at `at` (her own when `said`). */
function seen(id, { channel = 'c2', by = 'u1', at = NOW - 5 * MINUTE_MS, said = false } = {}) {
  return { kind: said ? 'said' : 'seen', messageId: id, occurredAt: new Date(at).toISOString(), ...(said ? {} : { by }), scope: { channel } };
}

/** An inner life over the real service with an attention on `place`, the clock at NOW. */
function attentionSetup({ place = 'c2', people = [], settle = 60, perDay = 12, lines = [], turns = fakeTurns(), innerLife = {}, places = null, nameOf = null, canSend = () => true } = {}) {
  const dataDir = tempDir('nep-inner-');
  const hot = hotWith({ innerLife });
  const service = realIntentions(hot, dataDir);
  const record = fakeRecord(lines);
  const journal = [];
  let inner;
  const door = createEventDoor({ handlers: { 'inner.wake': (event) => inner.onWake(event) }, log: SILENT });
  inner = createInnerLife({
    hot,
    dataDir,
    turns,
    intentions: service,
    record,
    places,
    nameOf,
    journal: { inner: async (guildId, fields) => journal.push(fields) },
    client: fakeClient(),
    discord: { canSend },
    submit: (event) => door.submit(event),
    store: { state: { data: {} } },
    getGuildId: () => GUILD,
    meter: { run: async (fn) => ({ result: await fn(), usd: 0.1, requests: 1, voice: 1 }) },
    rng: seeded(3),
    now: () => clock.t,
    log: SILENT,
  });
  // Set an hour ago: lines before an attention was set are never new to it.
  clock.t = NOW - HOUR_MS;
  const set = service.set(GUILD, { purpose: 'listen there', attend: { place, people, settle, perDay }, channelId: 'c1', scope: 'group' });
  clock.t = NOW;
  assert.equal(set.ok, true, set.code);
  return { inner, turns, journal, service, record, id: set.intention.id, hot };
}

test('attendWake: lines of others since her last look, settled, make one wake named by the newest line; her own lines and other people never count', () => {
  const record = { id: 'ia', attend: { place: 'c2', people: [], settle: 60, perDay: 12, today: null } };
  const lines = [{ id: 'm1', at: NOW - 3 * MINUTE_MS, by: 'u1' }, { id: 'm2', at: NOW - 2 * MINUTE_MS, by: 'u2' }, { id: 'm3', at: NOW - 90_000, by: null, said: true }];
  const wake = attendWake(record, lines, { now: NOW, since: NOW - HOUR_MS });
  assert.equal(wake.id, 'inner.wake:attend:ia:m2', 'the newest line that counts, not her own');
  assert.deepEqual([wake.kind, wake.channelId, wake.chainId, wake.dueAt, wake.intentionIds], ['attend', 'c2', 'attend:ia:m2', NOW - 2 * MINUTE_MS + 60_000, ['ia']]);
  assert.deepEqual(wake.attend, { place: 'c2', lines: 2, people: ['u1', 'u2'], since: NOW - HOUR_MS, newestAt: NOW - 2 * MINUTE_MS, newestId: 'm2' });
  assert.equal(attendWake(record, lines, { now: NOW - 100_000 }), null, 'the newest line is younger than the settle: the place is still talking');
  assert.equal(attendWake(record, [lines[2]], { now: NOW }), null, 'her own line alone wakes nobody');
  assert.equal(attendWake(record, [], { now: NOW }), null);
  const only = { ...record, attend: { ...record.attend, people: ['u2'] } };
  assert.deepEqual(attendWake(only, lines, { now: NOW }).attend.people, ['u2']);
  assert.equal(attendWake(only, [lines[0]], { now: NOW }), null, 'a line by someone else does not count for a people attention');
  assert.equal(attendWake({ ...record, attend: { ...record.attend, settle: 0 } }, [{ id: 'm9', at: NOW, by: 'u1' }], { now: NOW }).id, 'inner.wake:attend:ia:m9', 'settle 0 wakes at once');
});

test('placesPage: filtered by name, sorted recent, name or lines, paged with the total and how many more', () => {
  const rows = [
    { id: 'a', name: 'alpha', lines: 3, people: 2, newestAt: NOW - HOUR_MS },
    { id: 'b', name: 'bêta', lines: 9, people: 4, newestAt: NOW },
    { id: 'c', name: 'gamma', lines: 0, people: 0, newestAt: null },
    { id: 'd', name: 'alps', lines: 1, people: 1, newestAt: NOW - 2 * HOUR_MS },
  ];
  assert.deepEqual(placesPage(rows).items.map((r) => r.id), ['b', 'a', 'd', 'c'], 'recent: the newest first, a silent place last');
  assert.deepEqual(placesPage(rows, { sort: 'name' }).items.map((r) => r.id), ['a', 'd', 'b', 'c']);
  assert.deepEqual(placesPage(rows, { sort: 'lines' }).items.map((r) => r.id), ['b', 'a', 'd', 'c']);
  assert.deepEqual(placesPage(rows, { filter: 'ALP' }).items.map((r) => r.id), ['a', 'd']);
  assert.deepEqual(placesPage(rows, { filter: 'beta' }).items.map((r) => r.id), ['b'], 'accents folded');
  const page = placesPage(rows, { pageSize: 3 });
  assert.deepEqual([page.total, page.page, page.pageSize, page.more, page.items.length], [4, 1, 3, 1, 3]);
  const second = placesPage(rows, { pageSize: 3, page: 2 });
  assert.deepEqual([second.more, second.items.map((r) => r.id)], [0, ['c']]);
  assert.deepEqual(placesPage(rows, { pageSize: 3, page: 9 }).items, []);
});

test('inner: an attention wakes her on the place\'s settled lines since her last look, with the whole burst and the places page; nothing elsewhere; the same lines never twice', async () => {
  const lines = [seen('m1', { by: 'u1', at: NOW - 4 * MINUTE_MS }), seen('m2', { by: 'u2', at: NOW - 3 * MINUTE_MS }), seen('m3', { channel: 'c3', by: 'u3', at: NOW - 3 * MINUTE_MS })];
  const run = attentionSetup({ lines, nameOf: (_g, id) => ({ u1: 'Ana', u2: 'Nikos' })[id] ?? null, places: () => [{ id: 'c1', name: 'general', writable: true }, { id: 'c2', name: 'garden', writable: true }, { id: 'c3', name: 'news', writable: false }] });
  const first = await run.inner.tick();
  assert.equal(first.submitted, 1, 'the attended place only');
  assert.equal(run.turns.calls.length, 1);
  const wake = run.turns.calls[0].inner.wake;
  assert.equal(run.turns.calls[0].channel.id, 'c2');
  assert.equal(wake.kind, 'attend');
  assert.equal(wake.chainId, `attend:${run.id}:m2`);
  const item = wake.items[0];
  assert.deepEqual([item.kind, item.intentionIds, item.attend.place, item.attend.placeName, item.attend.lines, item.attend.people, item.attend.peopleNames], ['attend', [run.id], 'c2', 'garden', 2, ['u1', 'u2'], ['Ana', 'Nikos']]);
  assert.equal(item.attend.since, run.service.store(GUILD).get(run.id).createdAt, 'nothing before the attention was set is new');
  assert.deepEqual(wake.intentions.map((r) => r.id), [run.id]);
  // The places page: every published place, the lines since her last look, the read-only one listed.
  assert.equal(wake.places.total, 3);
  assert.deepEqual(wake.places.items.map((p) => [p.id, p.lines, p.people, p.writable, p.attended]), [['c2', 2, 2, true, true], ['c3', 1, 1, false, false], ['c1', 0, 0, true, false]]);
  assert.equal(run.journal.find((r) => r.event === 'wake').wake.id, `inner.wake:attend:${run.id}:m2`);
  assert.deepEqual(run.journal.find((r) => r.event === 'wake').wake.place, 'c2');
  assert.deepEqual(run.service.attendToday(GUILD, run.id), { day: '2026-10-19', wakes: 1 });
  // The same lines wake her no more: her look is the handled wake.
  clock.t = NOW + 5 * MINUTE_MS;
  const second = await run.inner.tick();
  assert.equal(second.submitted, 0);
  assert.equal(run.turns.calls.length, 1);
  assert.deepEqual(run.inner.places(GUILD).items.find((p) => p.id === 'c2').lines, 0, 'the page counts from her last look');
  // A new line after her look, settled: a new wake named by it.
  run.record.lines.push(seen('m4', { by: 'u1', at: NOW + 6 * MINUTE_MS }));
  clock.t = NOW + 6 * MINUTE_MS + 30_000;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 1, 'still talking: the settle has not passed');
  clock.t = NOW + 8 * MINUTE_MS;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 2);
  assert.equal(run.turns.calls[1].inner.wake.items[0].attend.lines, 1);
  assert.deepEqual(run.service.attendToday(GUILD, run.id), { day: '2026-10-19', wakes: 2 });
  const turnNote = run.journal.filter((r) => r.event === 'turn').at(-1);
  assert.deepEqual([turnNote.wakes[0].kind, turnNote.wakes[0].place, turnNote.wakes[0].lines], ['attend', 'c2', 1]);
});

test('inner: her own line in the place is a look; a newer burst replaces the queued wake, nothing lost; with people only their lines count', async () => {
  const turns = fakeTurns();
  turns.busy = true;
  const lines = [seen('m1', { by: 'u1', at: NOW - 10 * MINUTE_MS }), seen('m2', { at: NOW - 8 * MINUTE_MS, said: true }), seen('m3', { by: 'u2', at: NOW - 4 * MINUTE_MS })];
  const run = attentionSetup({ lines, turns, people: ['u2', 'u3'] });
  await run.inner.tick();
  let queue = run.inner.state(GUILD).queue;
  assert.deepEqual(queue.map((w) => [w.id, w.attend.lines]), [[`inner.wake:attend:${run.id}:m3`, 1]], 'only u2\'s line after her own line counts');
  // More lines while the attention is held: the queued wake takes the newest line's id.
  run.record.lines.push(seen('m4', { by: 'u1', at: NOW + MINUTE_MS }), seen('m5', { by: 'u3', at: NOW + 2 * MINUTE_MS }));
  clock.t = NOW + 4 * MINUTE_MS;
  await run.inner.tick();
  queue = run.inner.state(GUILD).queue;
  assert.deepEqual(queue.map((w) => [w.id, w.attend.lines, w.attend.people]), [[`inner.wake:attend:${run.id}:m5`, 2, ['u2', 'u3']]], 'one queued wake per attention');
  assert.deepEqual(run.journal.filter((r) => r.event === 'replaced').map((r) => [r.wake.id, r.by]), [[`inner.wake:attend:${run.id}:m3`, `inner.wake:attend:${run.id}:m5`]]);
  turns.busy = false;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 1);
  assert.equal(run.turns.calls[0].inner.wake.items[0].attend.lines, 2);
  assert.equal(run.inner.state(GUILD).queue.length, 0);
});

test('inner: past the attention\'s own perDay the wake waits as capped and runs the next local day; the other wakes go on; a read-only place still wakes her', async () => {
  const lines = [seen('m1', { by: 'u1', at: NOW - 5 * MINUTE_MS })];
  const canSend = (channel) => channel.id !== 'c2';
  const run = attentionSetup({ lines, perDay: 1, canSend });
  // A due intention elsewhere and the attention: both run; the attention in a place she cannot write in.
  run.service.set(GUILD, { purpose: 'say hi', dueAt: NOW - MINUTE_MS, channelId: 'c1', scope: 'group' });
  await run.inner.tick();
  await run.inner.tick();
  assert.deepEqual(run.turns.calls.map((c) => [c.channel.id, c.inner.wake.kind]).sort(), [['c1', 'intention_due'], ['c2', 'attend']]);
  // The second burst of the day waits.
  run.record.lines.push(seen('m2', { by: 'u2', at: NOW + 10 * MINUTE_MS }));
  clock.t = NOW + 12 * MINUTE_MS;
  const capped = await run.inner.tick();
  assert.deepEqual(capped.drained, { refused: 'attend-per-day' });
  assert.equal(run.turns.calls.length, 2);
  await settle();
  assert.deepEqual(run.journal.filter((r) => r.event === 'capped').map((r) => r.cap), ['attend-per-day']);
  assert.equal(run.inner.state(GUILD).queue[0].capped, 'attend-per-day');
  const status = run.inner.status(GUILD);
  assert.deepEqual(status.attention, { open: 1, listed: 2, run: 1, spoken: 0, skipped: 1, waiting: 1 });
  // Another due intention is not held back by it.
  run.service.set(GUILD, { purpose: 'say bye', dueAt: NOW + 11 * MINUTE_MS, channelId: 'c1', scope: 'group' });
  clock.t = NOW + 13 * MINUTE_MS;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 3);
  assert.equal(run.turns.calls[2].inner.wake.kind, 'intention_due');
  assert.equal(run.inner.state(GUILD).queue.length, 1, 'the capped attend wake still waits');
  // The next local day it runs, and counts on that day.
  clock.t = NOW + DAY_MS;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 4);
  assert.equal(run.turns.calls[3].inner.wake.kind, 'attend');
  assert.deepEqual(run.service.attendToday(GUILD, run.id), { day: '2026-10-20', wakes: 1 });
  assert.equal(run.journal.filter((r) => r.event === 'capped').length, 1, 'journalled once per wake');
});

test('inner: a cancelled attention wakes her no more and its queued wake is stale; places() lists, filters and pages the published places', async () => {
  const turns = fakeTurns();
  turns.busy = true;
  const lines = [seen('m1', { by: 'u1', at: NOW - 5 * MINUTE_MS }), seen('m2', { channel: 'c3', by: 'u2', at: NOW - 2 * MINUTE_MS })];
  const run = attentionSetup({ lines, turns, places: () => [{ id: 'c1', name: 'general', writable: true }, { id: 'c2', name: 'garden', writable: true }, { id: 'c3', name: 'news', writable: false }] });
  await run.inner.tick();
  assert.equal(run.inner.state(GUILD).queue.length, 1);
  const page = run.inner.places(GUILD, { sort: 'name', pageSize: 2 });
  assert.deepEqual([page.total, page.more, page.items.map((p) => p.name)], [3, 1, ['garden', 'general']]);
  assert.deepEqual(run.inner.places(GUILD, { filter: 'new' }).items.map((p) => [p.name, p.lines, p.writable, p.attended]), [['news', 1, false, false]]);
  assert.deepEqual(run.inner.places(GUILD, { sort: 'lines', page: 2, pageSize: 2 }).items.map((p) => p.name), ['general']);
  assert.equal(run.service.cancel(GUILD, run.id).ok, true);
  turns.busy = false;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 0);
  assert.equal(run.inner.state(GUILD).queue.length, 0);
  assert.equal(run.inner.state(GUILD).handled[`inner.wake:attend:${run.id}:m1`].outcome, 'stale');
  run.record.lines.push(seen('m3', { by: 'u1', at: NOW + MINUTE_MS }));
  clock.t = NOW + 5 * MINUTE_MS;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 0, 'nothing reseeds a cancelled attention');
  assert.deepEqual(run.inner.status(GUILD).attention, { open: 0, listed: 1, run: 0, spoken: 0, skipped: 0, waiting: 0 });
});

// ---- feedback on her own turn ----------------------------------------------------------

/** A turn result of the real case: a post refused, a search timed out, the intention closed as done. */
function lostTurn(turnId = 't-1') {
  return {
    outcome: 'spoke',
    inner: {
      actions: [
        { skill: 'message.create', status: 'refused', result: 'refused', code: 'destination-required', target: {} },
        { skill: 'intent.update', status: 'executed', result: 'ok', target: {}, intentionId: 'i1', state: 'done' },
        { skill: 'web.search', status: 'executed', result: 'unknown', code: 'timeout', target: {} },
      ],
      intentIds: ['i1'],
      loop: { steps: 2, cut: 'steps', droppedCalls: 1 },
      turnId,
    },
  };
}

test('feedbackFacts: a call that did not go ok, an intention closed with nothing delivered, the loop cut; nothing when all went through', () => {
  assert.ok(WAKE_KINDS.includes('feedback'));
  assert.deepEqual(DELIVERY_SKILLS, ['message.create', 'draw.create', 'task.run']);
  const facts = feedbackFacts(lostTurn(), { named: ['i1'], intentions: [intention('i1', { purpose: 'send a cat meme' })] });
  assert.deepEqual(facts, [
    { kind: 'callFailed', skill: 'message.create', status: 'refused', code: 'destination-required' },
    { kind: 'callFailed', skill: 'web.search', status: 'timeout', code: 'timeout' },
    { kind: 'doneWithoutDelivery', intentionId: 'i1', purpose: 'send a cat meme' },
    { kind: 'loopCut', cut: 'steps', droppedCalls: 1, steps: 2 },
  ]);
  // A refused call carries its code; an executed delivery makes the done intention no fact; a loop that ended on its own is none.
  const delivered = feedbackFacts({ inner: { actions: [{ skill: 'message.create', status: 'executed', result: 'ok' }, { skill: 'intent.update', status: 'executed', result: 'ok', intentionId: 'i1', state: 'done' }, { skill: 'draw.create', status: 'refused', result: 'refused', code: 'inner-stopped' }], intentIds: ['i1'], loop: { steps: 3, cut: null, droppedCalls: 0 } } });
  assert.deepEqual(delivered, [{ kind: 'callFailed', skill: 'draw.create', status: 'refused', code: 'inner-stopped' }]);
  // A done set in shadow (proposed) closed nothing: no fact; without an id on the action the one named id counts.
  assert.deepEqual(feedbackFacts({ inner: { actions: [{ skill: 'intent.update', status: 'proposed', result: 'ok', intentionId: 'i1', state: 'done' }], intentIds: ['i1'] } }), []);
  assert.deepEqual(feedbackFacts({ inner: { actions: [{ skill: 'intent.update', status: 'executed', result: 'ok', state: 'done' }], intentIds: ['i2'] } }), [{ kind: 'doneWithoutDelivery', intentionId: 'i2', purpose: '' }]);
  assert.deepEqual(feedbackFacts({ outcome: 'skip', inner: { actions: [], intentIds: [], loop: { steps: 0, cut: null, droppedCalls: 0 } } }), []);
  assert.deepEqual(feedbackFacts(null), []);
});

test('inner: a turn that lost something queues one feedback wake in its chain and conversation, due at the next tick, with the facts; the feedback turn gets none of its own (journalled only)', async () => {
  const handed = [];
  const episode = { turnId: 't-1', shadow: false, channelId: 'c1', findings: [], actions: [] };
  const turns = fakeTurns({ answer: () => ({ ...lostTurn(), inner: { ...lostTurn().inner, episode } }) });
  const run = setup({ records: [intention('i1', { purpose: 'send a cat meme' })], turns, hot: hotWith({ innerLife: { mode: 'live' } }), onEpisode: (guildId, given) => handed.push(given) });
  const first = await run.inner.tick();
  assert.equal(first.drained.feedback, 'inner.wake:feedback:t-1');
  assert.equal(run.turns.calls.length, 1);
  const queued = run.inner.state(GUILD).queue;
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, 'feedback');
  assert.equal(queued[0].chainId, 'intention:i1');
  assert.equal(queued[0].channelId, 'c1');
  assert.equal(queued[0].dueAt, NOW);
  assert.deepEqual(queued[0].facts.map((fact) => fact.kind), ['callFailed', 'callFailed', 'doneWithoutDelivery', 'loopCut']);
  // The same facts rode the turn's episode to her memory.
  assert.deepEqual(handed[0].feedback.map((fact) => fact.kind), ['callFailed', 'callFailed', 'doneWithoutDelivery', 'loopCut']);
  // The next tick runs the feedback turn: the same chain and channel, the facts on its wake item.
  clock.t = NOW + MINUTE_MS;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 2);
  const params = run.turns.calls[1];
  assert.equal(params.channel.id, 'c1');
  assert.equal(params.inner.wake.kind, 'feedback');
  assert.equal(params.inner.wake.chainId, 'intention:i1');
  assert.deepEqual(params.inner.wake.items[0].facts[0], { kind: 'callFailed', skill: 'message.create', status: 'refused', code: 'destination-required' });
  assert.equal(params.inner.wake.items[0].facts[2].purpose, 'send a cat meme');
  assert.equal(params.inner.wake.budgets.chain.used, 1, 'the turn it reports used the chain once');
  assert.equal(chainBudget(run.inner.state(GUILD), 'intention:i1', 3, { now: clock.t, timezone: 'UTC' }).used, 1, 'the feedback turn does not count against the chain');
  // The feedback turn lost the same things again: journalled, never a second wake.
  clock.t = NOW + 2 * MINUTE_MS;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 2, 'no feedback on a feedback turn');
  assert.deepEqual(run.inner.state(GUILD).queue, []);
  await settle();
  const notes = run.journal.filter((entry) => entry.event === 'turn');
  assert.equal(notes.length, 2);
  assert.equal(notes[0].feedback.wake, 'inner.wake:feedback:t-1');
  assert.deepEqual(notes[0].loop, { steps: 2, cut: 'steps', droppedCalls: 1 });
  assert.equal(notes[1].feedback.wake, null);
  assert.deepEqual(notes[1].feedback.facts.map((fact) => fact.kind), ['callFailed', 'callFailed', 'doneWithoutDelivery', 'loopCut']);
  const wakeNote = run.journal.find((entry) => entry.event === 'wake' && entry.wake.kind === 'feedback');
  assert.equal(wakeNote.wake.turnId, 't-1');
  assert.equal(wakeNote.wake.facts.length, 4);
  // A turn that lost nothing queues nothing.
  const quiet = setup({ records: [intention('i2')] });
  const result = await quiet.inner.tick();
  assert.equal(result.drained.feedback, undefined);
  assert.deepEqual(quiet.inner.state(GUILD).queue, []);
  await settle();
  assert.deepEqual(quiet.journal.find((entry) => entry.event === 'turn').feedback, { facts: [], wake: null });
});

test('currentChannelOf: the cause of the wake picks the channel -- destination or the asking channel, the place, the errand\'s channel, the reported turn\'s; a review or no channel has none', () => {
  const due = (extra = {}) => ({ kind: 'intention_due', intentionIds: ['i1'], channelId: 'c1', privateChat: false, ...extra });
  assert.deepEqual(currentChannelOf([due()], [intention('i1')]), { channelId: 'c1', why: 'asked' });
  assert.deepEqual(currentChannelOf([due({ channelId: 'c2' })], [{ ...intention('i1'), destination: 'c2' }]), { channelId: 'c2', why: 'destination' });
  assert.deepEqual(currentChannelOf([due({ privateChat: true })], [{ ...intention('i1'), destination: 'c2' }]), { channelId: 'c1', why: 'asked' }, 'a private chat is where it was asked');
  assert.deepEqual(currentChannelOf([{ kind: 'attend', intentionIds: ['i1'], channelId: 'c3' }]), { channelId: 'c3', why: 'attend' });
  assert.deepEqual(currentChannelOf([{ kind: 'errand_deadline', intentionIds: ['i1'], channelId: 'c4' }]), { channelId: 'c4', why: 'errand' });
  assert.deepEqual(currentChannelOf([{ kind: 'feedback', channelId: 'c1', here: 'c5' }]), { channelId: 'c5', why: 'feedback' });
  assert.deepEqual(currentChannelOf([{ kind: 'feedback', channelId: 'c1', here: null }]), { channelId: null, why: null }, 'the reported turn had none');
  assert.deepEqual(currentChannelOf([{ kind: 'feedback', channelId: 'c1' }]), { channelId: 'c1', why: 'feedback' }, 'a wake queued before the field existed');
  assert.deepEqual(currentChannelOf([reviewWake('2026-10-19', NOW)]), { channelId: null, why: null });
  assert.deepEqual(currentChannelOf([reviewWake('2026-10-19', NOW), due()], [intention('i1')]), { channelId: 'c1', why: 'asked' }, 'the review joins another cause, which decides');
  assert.deepEqual(currentChannelOf([due({ channelId: null })]), { channelId: null, why: null });
});

test('inner: the turn is given the current channel and the wake says where and why; a review has none and says so; the feedback wake carries it on', async () => {
  const dest = { ...intention('i1'), destination: 'c2' };
  const run = setup({ records: [dest] });
  await run.inner.tick();
  const given = run.turns.calls[0];
  assert.equal(given.channel.id, 'c2');
  assert.equal(given.inner.currentChannel, 'c2');
  assert.deepEqual(given.inner.wake.here, { channel: 'chan-c2', why: 'destination' });
  const asked = setup({ records: [intention('i1')] });
  await asked.inner.tick();
  assert.equal(asked.turns.calls[0].inner.currentChannel, 'c1');
  assert.equal(asked.turns.calls[0].inner.wake.here.why, 'asked');
  // The day's review: the turn still runs somewhere (her recent channel) but has no current channel.
  const lines = [{ kind: 'said', occurredAt: new Date(NOW - DAY_MS).toISOString(), scope: { channel: 'c3' } }];
  const record = { async *iterate() { for (const line of lines) yield line; } };
  const review = setup({ record, hot: hotWith({ innerLife: { review: { enabled: true, historyDays: 14 } } }) });
  clock.t = Date.parse('2026-10-19T08:00:00Z');
  await review.inner.tick();
  clock.t = review.inner.status(GUILD).review.at + MINUTE_MS;
  await review.inner.tick();
  assert.equal(review.turns.calls[0].channel.id, 'c3');
  assert.equal(review.turns.calls[0].inner.currentChannel, null);
  assert.equal(review.turns.calls[0].inner.wake.here, null);
  // A feedback wake keeps the reported turn's current channel, and the next turn is given it.
  const episode = { turnId: 't-1', shadow: false, channelId: 'c2', findings: [], actions: [] };
  const turns = fakeTurns({ answer: () => ({ ...lostTurn(), inner: { ...lostTurn().inner, episode } }) });
  const again = setup({ records: [{ ...dest }], turns, hot: hotWith({ innerLife: { mode: 'live' } }) });
  await again.inner.tick();
  assert.equal(again.inner.state(GUILD).queue[0].here, 'c2');
  clock.t = NOW + MINUTE_MS;
  await again.inner.tick();
  assert.equal(again.turns.calls[1].inner.currentChannel, 'c2');
  assert.equal(again.turns.calls[1].inner.wake.here.why, 'feedback');
});

/** The facts of the state as `kind:code:why`, oldest first. */
const factLines = (run) => run.inner.state(GUILD).facts.map((fact) => [fact.kind, fact.code, fact.why].filter(Boolean).join(':'));

test('inner: a wake of hers dropped no-channel is a fact at that moment (where, why), shown in the wake of her next turn and told once that turn completed; no feedback wake is needed', async () => {
  // i9 lands in a channel the client cannot fetch: dropped no-channel at the first drain; i1 runs at the next.
  const run = setup({ records: [intention('i9', { dueAt: NOW - 2 * MINUTE_MS, channelId: 'c9', purpose: 'announce the game night' }), intention('i1', { dueAt: NOW - MINUTE_MS })], hot: hotWith({ innerLife: { mode: 'live' } }) });
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 0);
  const [fact] = run.inner.state(GUILD).facts;
  assert.deepEqual([fact.kind, fact.code, fact.why, fact.wake, fact.intentionId, fact.purpose, fact.channelId, fact.privateChat, fact.told], ['wakeDropped', 'no-channel', 'unavailable', 'intention_due', 'i9', 'announce the game night', 'c9', false, false]);
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 1);
  assert.deepEqual(run.turns.calls[0].inner.wake.facts, [{ kind: 'wakeDropped', wakeId: `inner.wake:intention_due:i9:${NOW - 2 * MINUTE_MS}`, wake: 'intention_due', code: 'no-channel', why: 'unavailable', intentionId: 'i9', purpose: 'announce the game night' }]);
  assert.ok(run.inner.state(GUILD).facts[0].told, 'told once the turn completed');
  assert.deepEqual(run.inner.state(GUILD).queue, [], 'the turn carried it: no feedback wake');
  // Another due intention: nothing is repeated.
  run.intentions.records.push(intention('i2', { dueAt: NOW + 2 * MINUTE_MS, channelId: 'c2' }));
  clock.t = NOW + 3 * MINUTE_MS;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 2);
  assert.equal(run.turns.calls[1].inner.wake.facts, undefined);
});

test('inner: a fact is told only after a model answer that carried it completed -- an error leaves it, the retry shows it again', async () => {
  let runs = 0;
  const turns = fakeTurns({ answer: () => (++runs === 1 ? { outcome: 'error', reason: 'provider-limit' } : { outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], turnId: `t-${runs}` } }) });
  const run = setup({ records: [intention('i9', { dueAt: NOW - 2 * MINUTE_MS, channelId: 'c9' }), intention('i1', { dueAt: NOW - MINUTE_MS })], turns });
  await run.inner.tick();
  await run.inner.tick();
  assert.equal(run.turns.calls[0].inner.wake.facts.length, 1);
  assert.equal(run.inner.state(GUILD).facts.find((fact) => fact.kind === 'wakeDropped').told, false, 'the turn erred: not told');
  clock.t = NOW + MINUTE_MS;
  await run.inner.tick();
  assert.equal(run.turns.calls[1].inner.wake.facts.map((fact) => fact.kind).join(), 'wakeDropped,turnFailed', 'shown again with the failure of the first try');
  assert.ok(run.inner.state(GUILD).facts.every((fact) => fact.told));
});

test('inner: every wake outcome other than a turn is a wakeDropped fact at the moment: stopped, overflow, stale (done, cancelled, forgotten), no-channel (unavailable, dm-off)', async () => {
  const client = fakeClient();
  client.channels.cache.set('d1', { id: 'd1', name: 'dm', guild: null });
  const direct = { ...intention('i5', { channelId: 'd1' }), provenance: { kind: 'self', channelId: 'd1', scope: 'dm' } };
  const run = setup({ records: [intention('i1'), intention('i2'), intention('i3')], hot: hotWith({ innerLife: { queueMax: 4 } }), client });
  run.turns.busy = true;
  await run.inner.tick();
  assert.equal(run.inner.state(GUILD).queue.length, 3);
  run.intentions.records[0].status = 'cancelled';
  run.intentions.records[1].status = 'done';
  run.intentions.records.splice(2, 1);
  run.turns.busy = false;
  await run.inner.tick();
  assert.deepEqual(factLines(run), ['wakeDropped:stale:cancelled', 'wakeDropped:stale:done', 'wakeDropped:stale:forgotten']);
  // A private chat while private chats are off, and a place that cannot be fetched.
  run.intentions.records.push(direct, intention('i6', { channelId: 'c9', dueAt: NOW - 30_000 }));
  await run.inner.tick();
  await run.inner.tick();
  assert.deepEqual(factLines(run).slice(3).sort(), ['wakeDropped:no-channel:dm-off', 'wakeDropped:no-channel:unavailable']);
  const dm = run.inner.state(GUILD).facts.find((fact) => fact.why === 'dm-off');
  assert.deepEqual([dm.channelId, dm.privateChat], ['d1', true]);
  // The queue full: the overflowing wake is dropped on the spot; the stop drops what waits.
  const full = setup({ records: [intention('i1'), intention('i2')], hot: hotWith({ innerLife: { queueMax: 1 } }) });
  full.turns.busy = true;
  await full.inner.tick();
  assert.deepEqual(factLines(full), ['wakeDropped:overflow']);
  full.inner.stop(GUILD, { by: 'owner' });
  assert.deepEqual(factLines(full), ['wakeDropped:overflow', 'wakeDropped:stopped']);
  assert.equal(full.inner.state(GUILD).facts[1].purpose, 'purpose i1');
});

test('inner: a wake held on the attention\'s own per-day bound is a wakeHeld fact once, with the local midnight it waits for; the next turn shows it, once', async () => {
  const lines = [seen('m1', { by: 'u1', at: NOW - 5 * MINUTE_MS })];
  const held = attentionSetup({ lines, perDay: 1, innerLife: { mode: 'live' } });
  await held.inner.tick();
  assert.equal(held.turns.calls.length, 1, 'the first burst of the day');
  held.record.lines.push(seen('m2', { by: 'u2', at: NOW + 10 * MINUTE_MS }));
  clock.t = NOW + 12 * MINUTE_MS;
  assert.deepEqual((await held.inner.tick()).drained, { refused: 'attend-per-day' });
  const facts = held.inner.state(GUILD).facts;
  assert.equal(facts.length, 1);
  assert.deepEqual([facts[0].kind, facts[0].code, facts[0].intentionId, facts[0].purpose, facts[0].until, facts[0].told], ['wakeHeld', 'attend-per-day', held.id, 'listen there', Date.parse('2026-10-20T00:00:00Z'), false]);
  await held.inner.tick();
  assert.equal(held.inner.state(GUILD).facts.length, 1, 'told once, not at every tick');
  // A due intention runs a turn: it shows the hold.
  held.service.set(GUILD, { purpose: 'say hi', dueAt: NOW + 30 * MINUTE_MS, channelId: 'c1', scope: 'group' });
  clock.t = NOW + 31 * MINUTE_MS;
  await held.inner.tick();
  assert.equal(held.turns.calls.length, 2);
  assert.deepEqual(held.turns.calls[1].inner.wake.facts, [{ kind: 'wakeHeld', wakeId: facts[0].wakeId, wake: 'attend', code: 'attend-per-day', intentionId: held.id, purpose: 'listen there', until: Date.parse('2026-10-20T00:00:00Z') }]);
  assert.ok(held.inner.state(GUILD).facts[0].told);
  held.service.set(GUILD, { purpose: 'say bye', dueAt: NOW + 40 * MINUTE_MS, channelId: 'c1', scope: 'group' });
  clock.t = NOW + 41 * MINUTE_MS;
  await held.inner.tick();
  assert.equal(held.turns.calls[2].inner.wake.facts, undefined, 'told once');
});

test('inner: a chain held on its per-chain cap with no turn coming is told by a feedback wake that no cap holds and no other wake joins, and that does not count against the chain', async () => {
  const k1 = { ...intention('i1', { chainId: 'k' }), purpose: 'first' };
  const run = setup({ records: [k1], hot: hotWith({ innerLife: { mode: 'live', caps: { perChain: 1 } } }) });
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 1);
  run.intentions.records.push({ ...intention('i2', { chainId: 'k', dueAt: NOW - 30_000 }), purpose: 'second' });
  clock.t = NOW + MINUTE_MS;
  assert.deepEqual((await run.inner.tick()).drained, { refused: 'per-chain' });
  const queue = run.inner.state(GUILD).queue;
  assert.deepEqual(queue.map((wake) => [wake.kind, wake.capped ?? null]), [['intention_due', 'per-chain'], ['feedback', null]]);
  assert.equal(queue[1].channelId, 'c1');
  // Next tick: the feedback turn runs although its chain is full, alone, with the hold.
  clock.t = NOW + 2 * MINUTE_MS;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 2);
  const params = run.turns.calls[1];
  assert.equal(params.inner.wake.kind, 'feedback');
  assert.deepEqual(params.inner.wake.items.map((item) => item.kind), ['feedback'], 'not coalesced with anything');
  assert.deepEqual(params.inner.wake.items[0].facts, [{ kind: 'wakeHeld', wakeId: queue[0].id, wake: 'intention_due', code: 'per-chain', intentionId: 'i2', purpose: 'second', until: Date.parse('2026-10-20T00:00:00Z') }]);
  assert.equal(chainBudget(run.inner.state(GUILD), 'chain:k', 1, { now: clock.t, timezone: 'UTC' }).used, 1, 'the feedback turn is no turn of the chain');
  assert.ok(run.inner.state(GUILD).facts.every((fact) => fact.told));
  assert.deepEqual(run.inner.state(GUILD).queue.map((wake) => wake.kind), ['intention_due'], 'the held wake waits for the next day');
});

test('inner: a feedback wake whose facts an earlier turn already carried is handled without a turn', async () => {
  const lines = [seen('m1', { by: 'u1', at: NOW - 5 * MINUTE_MS })];
  const turns = failingTurns(99, 'cut-off');
  const run = attentionSetup({ lines, turns });
  await run.inner.tick();
  const state = run.inner.state(GUILD);
  const feedback = state.queue.find((wake) => wake.kind === 'feedback');
  assert.ok(feedback, 'the failed wake left a feedback wake');
  run.inner.facts.markTold(GUILD, state.facts.map((fact) => fact.id));
  const before = turns.calls.length;
  clock.t = NOW + 10 * MINUTE_MS;
  await run.inner.tick();
  assert.equal(turns.calls.length, before, 'no turn was run for it');
  assert.equal(run.inner.state(GUILD).queue.some((wake) => wake.id === feedback.id), false);
  assert.equal(run.inner.state(GUILD).handled[feedback.id].outcome, 'told');
});

test('inner: a fact of a private chat is shown only in that chat, a fact of the server never in a private chat; pending facts are kept seven days, told ones a day', async () => {
  const run = setup({ hot: hotWith({ innerLife: { mode: 'live' } }) });
  const { facts } = run.inner;
  facts.add(GUILD, { kind: 'sendFailed', code: 'forbidden', n: 0, total: 1, channelId: 'd1', privateChat: true, at: NOW });
  facts.add(GUILD, { kind: 'sendFailed', code: 'forbidden', n: 0, total: 2, channelId: 'c2', privateChat: false, at: NOW });
  facts.add(GUILD, { kind: 'callFailed', skill: 'web.read', status: 'failed', code: 'error', channelId: null, privateChat: false, at: NOW });
  const codes = (scope) => facts.pending(GUILD, scope).map((fact) => `${fact.kind}:${fact.channelId}`);
  assert.deepEqual(codes({ channelId: 'd1', privateChat: true }), ['sendFailed:d1']);
  assert.deepEqual(codes({ channelId: 'd2', privateChat: true }), [], 'another private chat sees none');
  assert.deepEqual(codes({ channelId: 'c1', privateChat: false }), ['callFailed:null'], 'an addressed server turn: its channel and the channel-less');
  assert.deepEqual(codes({ channelId: 'c1', privateChat: false, anywhere: true }), ['sendFailed:c2', 'callFailed:null'], 'an inner turn: the whole server, no private chat');
  // An inner turn in the server never shows the private fact.
  run.intentions.records.push(intention('i1'));
  await run.inner.tick();
  assert.deepEqual(run.turns.calls[0].inner.wake.facts.map((fact) => fact.kind + (fact.total ?? '')), ['sendFailed2', 'callFailed']);
  assert.deepEqual(codes({ channelId: 'd1', privateChat: true }), ['sendFailed:d1']);
  // The keep times.
  const state = run.inner.state(GUILD);
  state.facts[0].at = NOW - 8 * DAY_MS;
  clock.t = NOW + 12 * HOUR_MS;
  facts.markTold(GUILD, []);
  assert.deepEqual(state.facts.map((fact) => fact.kind + (fact.privateChat ? ':dm' : '')), ['sendFailed', 'callFailed'], 'the private fact waited past seven days and is gone; the told ones are half a day old');
  clock.t = NOW + 2 * DAY_MS;
  facts.markTold(GUILD, []);
  assert.deepEqual(state.facts, [], 'told facts go after a day');
});

test('inner: a turn that ended error journals its code and the status shows the last error; a thrown provider error is mapped', async () => {
  const limit = Object.assign(new Error('OpenRouter HTTP 429'), { statusCode: 429, body: '{}' });
  const turns = fakeTurns({ answer: () => { throw limit; } });
  const run = setup({ records: [intention('i1')], turns });
  await run.inner.tick();
  const record = run.journal.find((r) => r.event === 'turn');
  assert.equal(record.outcome, 'error');
  assert.deepEqual(record.error, { code: 'provider-limit' });
  assert.deepEqual(run.inner.status(GUILD).lastError, { at: NOW, code: 'provider-limit' });
  const reported = setup({ records: [intention('i1')], turns: fakeTurns({ answer: () => ({ outcome: 'error', reason: 'timeout' }) }) });
  await reported.inner.tick();
  assert.deepEqual(reported.journal.find((r) => r.event === 'turn').error, { code: 'timeout' });
  const fine = setup({ records: [intention('i1')] });
  await fine.inner.tick();
  assert.equal(fine.journal.find((r) => r.event === 'turn').error, undefined);
  assert.equal(fine.inner.status(GUILD).lastError, null);
});

/** A turn runner failing with `code` the first `fails` runs, then answering a silent skip. */
function failingTurns(fails, code = 'provider-limit') {
  let runs = 0;
  return fakeTurns({ answer: () => (++runs <= fails ? { outcome: 'error', reason: code } : { outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], turnId: `t-${runs}` } }) });
}

test('inner retry: a turn ending error re-queues its wakes after the first delay, not handled, the caps and the chain untouched', async () => {
  const run = setup({ records: [intention('i1')], turns: failingTurns(1) });
  await run.inner.tick();
  const status = run.inner.status(GUILD);
  assert.equal(status.queue.length, 1);
  assert.equal(status.queue[0].dueAt, NOW - MINUTE_MS, 'the original due time stays');
  const queued = run.inner.state(GUILD).queue[0];
  assert.equal(queued.retry, 1);
  assert.equal(queued.firstFailedAt, NOW);
  assert.equal(queued.notBefore, NOW + MINUTE_MS);
  assert.equal(queued.lastCode, 'provider-limit');
  assert.equal(run.inner.state(GUILD).handled[queued.id], undefined);
  assert.equal(status.turnsToday, 0);
  assert.equal(chainBudget(run.inner.state(GUILD), queued.chainId, 3, { now: NOW, timezone: 'UTC' }).used, 0);
  assert.equal(run.journal.find((r) => r.event === 'retry').retry, 1);
  // Before the delay nothing runs; the wake is not woken twice either.
  clock.t = NOW + 30_000;
  assert.deepEqual((await run.inner.tick()).drained, { deferred: 'retry' });
  assert.equal(run.turns.calls.length, 1);
});

test('inner retry: the second failure waits the second delay; a success after a retry shows the delayed line data and clears the queue', async () => {
  const run = setup({ records: [intention('i1')], turns: failingTurns(2) });
  await run.inner.tick();
  clock.t = NOW + MINUTE_MS;
  await run.inner.tick();
  const queued = run.inner.state(GUILD).queue[0];
  assert.equal(queued.retry, 2);
  assert.equal(queued.firstFailedAt, NOW);
  assert.equal(queued.notBefore, NOW + MINUTE_MS + 5 * MINUTE_MS);
  clock.t = NOW + 6 * MINUTE_MS;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 3);
  const info = run.turns.calls[2].inner.wake;
  assert.deepEqual(info.items[0].delayed, { minutes: 7, code: 'provider-limit' });
  assert.equal(run.turns.calls[0].inner.wake.items[0].delayed, undefined);
  assert.equal(run.inner.state(GUILD).queue.length, 0);
  assert.equal(run.inner.state(GUILD).handled[queued.id].outcome, 'skip');
  assert.equal(run.inner.status(GUILD).turnsToday, 1, 'only the turn that ran counts');
});

test('inner retry: the last delay repeats; past retry.maxHours the wake is dropped provider and she is told at her next turn', async () => {
  const hot = hotWith({ innerLife: { retry: { delaysMinutes: [1, 2], maxHours: 1 } } });
  const run = setup({ records: [intention('i1')], turns: failingTurns(99), hot });
  await run.inner.tick();
  clock.t = NOW + MINUTE_MS;
  await run.inner.tick();
  clock.t = NOW + 3 * MINUTE_MS;
  await run.inner.tick();
  assert.equal(run.inner.state(GUILD).queue[0].retry, 3);
  assert.equal(run.inner.state(GUILD).queue[0].notBefore, NOW + 5 * MINUTE_MS, 'the second delay repeats');
  clock.t = NOW + 61 * MINUTE_MS;
  const before = run.turns.calls.length;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, before + 1);
  const state = run.inner.state(GUILD);
  const dropped = Object.values(state.handled).find((entry) => entry.outcome === 'provider');
  assert.ok(dropped, 'handled with outcome provider');
  const feedback = run.journal.filter((r) => r.event === 'turn').at(-1).feedback.facts;
  assert.deepEqual(feedback.map((fact) => `${fact.kind}:${fact.code}`), ['turnFailed:provider-limit']);
  const drop = state.facts.find((fact) => fact.kind === 'wakeDropped');
  assert.deepEqual([drop.code, drop.why, drop.intentionId], ['provider', 'provider-limit', 'i1'], 'a fact at the moment of the drop');
  assert.equal(drop.told, false, 'the feedback turn that carries it has not run yet');
});

test('inner retry: a retried wake is not coalesced with a fresh wake of the same conversation', async () => {
  const run = setup({ records: [intention('i1', { dueAt: NOW - 5 * MINUTE_MS })], turns: failingTurns(1) });
  await run.inner.tick();
  clock.t = NOW + 2 * MINUTE_MS;
  run.intentions.records.push(intention('i2', { dueAt: NOW + MINUTE_MS }));
  await run.inner.tick();
  await run.inner.tick();
  const groups = run.turns.calls.slice(1).map((call) => call.inner.wake.items.map((item) => item.intentionIds[0]));
  assert.deepEqual(groups, [['i1'], ['i2']]);
});

test('inner retry: coalesceGroup keeps a retry group apart from fresh wakes', () => {
  const base = { kind: 'intention_due', channelId: 'c1', chainId: 'a', intentionIds: ['x'] };
  const retried = { ...base, id: 'w1', dueAt: 1, retry: 1, firstFailedAt: 5 };
  const fresh = { ...base, id: 'w2', dueAt: 2, intentionIds: ['y'] };
  assert.deepEqual(coalesceGroup([fresh, retried]).map((wake) => wake.id), ['w1']);
  assert.deepEqual(coalesceGroup([fresh]).map((wake) => wake.id), ['w2']);
  const mate = { ...base, id: 'w3', dueAt: 3, retry: 1, firstFailedAt: 5 };
  assert.deepEqual(coalesceGroup([mate, retried, fresh]).map((wake) => wake.id), ['w1', 'w3']);
});

test('inner retry: a one-off\'s due moment that met an error that is not a provider failure (cut-off) is tried once more after the first delay, then dropped and told with the code', async () => {
  const run = setup({ records: [intention('i1')], turns: failingTurns(99, 'cut-off') });
  await run.inner.tick();
  let state = run.inner.state(GUILD);
  assert.deepEqual(state.queue.map((wake) => [wake.retry, wake.notBefore]), [['error', NOW + MINUTE_MS]], 'not handled: its due moment comes back once');
  assert.deepEqual(run.journal.find((r) => r.event === 'turn').error, { code: 'cut-off' });
  assert.equal(run.journal.filter((r) => r.event === 'retry').length, 1);
  assert.deepEqual(factLines(run), ['turnFailed:cut-off'], 'the failure is a fact; no feedback wake while the wake comes back');
  assert.equal(state.queue.some((wake) => wake.kind === 'feedback'), false);
  clock.t = NOW + MINUTE_MS;
  await run.inner.tick();
  state = run.inner.state(GUILD);
  assert.equal(Object.values(state.handled)[0].outcome, 'error');
  assert.deepEqual(state.facts.map((fact) => `${fact.kind}:${fact.code}:${fact.why ?? ''}`), ['turnFailed:cut-off:', 'wakeDropped:error:cut-off', 'turnFailed:cut-off:']);
  assert.deepEqual(state.queue.map((wake) => wake.kind), ['feedback'], 'now she is told by a wake of her own');
  assert.equal(run.turns.calls.length, 2);
});

test('inner retry: a review or an attention wake that met a cut-off error is handled at once and told; only a one-off intention gets the one more try', async () => {
  const lines = [seen('m1', { by: 'u1', at: NOW - 5 * MINUTE_MS })];
  const run = attentionSetup({ lines, turns: failingTurns(99, 'cut-off') });
  await run.inner.tick();
  const state = run.inner.state(GUILD);
  assert.deepEqual(state.queue.map((wake) => wake.kind), ['feedback'], 'only the feedback wake is left');
  assert.deepEqual(state.facts.filter((fact) => fact.kind === 'wakeDropped').map((fact) => `${fact.wake}:${fact.code}:${fact.why}`), ['attend:error:cut-off']);
});

// --- The heartbeat ------------------------------------------------------------------------------

const BEAT = { heartbeat: { enabled: true, everyMinutes: 180, jitterMinutes: 60 } };
const sayings = () => ({ async *iterate() { yield { kind: 'said', occurredAt: new Date(NOW - HOUR_MS).toISOString(), scope: { channel: 'c3' } }; } });

test('drawHeartbeatAt: the interval with an even jitter either way, never less than a minute', () => {
  const draw = (r, extra = {}) => drawHeartbeatAt({ from: NOW, everyMinutes: 180, jitterMinutes: 60, rng: () => r, ...extra });
  assert.equal(draw(0), NOW + 120 * MINUTE_MS);
  assert.equal(draw(0.5), NOW + 180 * MINUTE_MS);
  assert.ok(draw(0.999999) <= NOW + 240 * MINUTE_MS && draw(0.999999) > NOW + 239 * MINUTE_MS);
  assert.equal(draw(0, { everyMinutes: 10, jitterMinutes: 60 }), NOW + MINUTE_MS);
});

test('innerSettings: the heartbeat defaults and a bad value taking the default', () => {
  const d = innerSettings({}).heartbeat;
  assert.deepEqual([d.enabled, d.everyMinutes, d.jitterMinutes, d.people, d.filteredShown, d.closedShown], [true, 180, 60, 8, 10, 10]);
  const set = innerSettings({ innerLife: { heartbeat: { enabled: false, everyMinutes: 'x', people: 3 } } }).heartbeat;
  assert.deepEqual([set.enabled, set.everyMinutes, set.people], [false, 180, 3]);
});

test('heartbeat: the first tick draws the moment with the jitter and keeps it in the state; it survives a restart', async () => {
  const dataDir = tempDir('nep-inner-');
  const run = setup({ dataDir, record: sayings(), hot: hotWith({ innerLife: BEAT }), rng: () => 0.5 });
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 0);
  assert.deepEqual(run.inner.state(GUILD).heartbeat, { nextAt: NOW + 180 * MINUTE_MS, lastAt: null });
  assert.deepEqual(run.inner.status(GUILD).heartbeat, { nextAt: NOW + 180 * MINUTE_MS, lastAt: null });
  const again = setup({ dataDir, record: sayings(), hot: hotWith({ innerLife: BEAT }), rng: () => 0 });
  assert.equal(again.inner.state(GUILD).heartbeat.nextAt, NOW + 180 * MINUTE_MS);
  await again.inner.tick();
  assert.equal(again.inner.state(GUILD).heartbeat.nextAt, NOW + 180 * MINUTE_MS, 'a drawn moment is not drawn again');
  await settle();
  assert.equal(run.journal.filter((r) => r.event === 'heartbeat-drawn').length, 1);
});

test('heartbeat: off draws nothing and wakes nobody; the status says so', async () => {
  const run = setup({ hot: hotWith({ innerLife: { heartbeat: { enabled: false } } }) });
  await run.inner.tick();
  assert.equal(run.inner.state(GUILD).heartbeat, null);
  assert.equal(run.inner.status(GUILD).heartbeat, null);
});

test('heartbeat: at its moment one turn runs in the channel she spoke in, with no current channel, its own chain and the facts; the next moment is drawn from the run', async () => {
  const run = setup({ record: sayings(), hot: hotWith({ innerLife: BEAT }), rng: () => 0.5 });
  await run.inner.tick();
  const due = NOW + 180 * MINUTE_MS;
  clock.t = due + MINUTE_MS;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 1);
  const call = run.turns.calls[0];
  assert.equal(call.inner.wake.kind, 'heartbeat');
  assert.equal(call.channel.id, 'c3');
  assert.equal(call.inner.currentChannel, null);
  assert.equal(call.inner.wake.here, null);
  assert.equal(call.inner.wake.chainId, `heartbeat:${due}`);
  assert.deepEqual(Object.keys(call.inner.wake.heartbeat).sort(), ['activity', 'agents', 'intentionsOnly', 'life', 'maxTokens', 'people', 'places', 'refs', 'since', 'skills']);
  await run.inner.tick();
  assert.deepEqual(run.inner.state(GUILD).heartbeat, { nextAt: clock.t + 180 * MINUTE_MS, lastAt: due + MINUTE_MS });
  assert.equal(run.turns.calls.length, 1, 'once per moment');
  // The next one is a wake of its own id and chain.
  clock.t = run.inner.state(GUILD).heartbeat.nextAt + MINUTE_MS;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 2);
  assert.notEqual(run.turns.calls[1].inner.wake.chainId, call.inner.wake.chainId);
});

test('heartbeat: never coalesced with another wake and never held behind one: it goes alone first, the intention at the next tick', async () => {
  const run = setup({ records: [intention('i1', { channelId: 'c1', dueAt: NOW + 181 * MINUTE_MS })], record: sayings(), hot: hotWith({ innerLife: BEAT }), rng: () => 0.5 });
  await run.inner.tick();
  clock.t = NOW + 182 * MINUTE_MS;
  await run.inner.tick();
  assert.deepEqual(run.turns.calls.map((call) => call.inner.wake.items.map((item) => item.kind)), [['heartbeat']]);
  await run.inner.tick();
  assert.deepEqual(run.turns.calls.map((call) => call.inner.wake.items.map((item) => item.kind)), [['heartbeat'], ['intention_due']]);
  assert.deepEqual(coalesceGroup([wakeOfDue({ intention: intention('i2'), reason: 'due', at: 1 }), heartbeatWake(2), reviewWake('2026-10-19', 3)]).map((wake) => wake.kind), ['heartbeat']);
});

test('heartbeat: an intention it makes due now is not run inside the heartbeat; the next tick wakes her for it as an ordinary intention_due turn', async () => {
  const dataDir = tempDir('nep-inner-');
  const hot = hotWith({ innerLife: BEAT });
  const service = createIntentionService({ stores: createIntentionStores({ dataDir, now: () => clock.t }), hot, getGuildId: () => GUILD, now: () => clock.t, log: SILENT });
  const lines = [];
  const log = { info: (msg, fields) => lines.push({ msg, ...fields }), warn() {}, error() {} };
  const turns = fakeTurns({
    answer: (params) => {
      if (params.inner.wake.kind === 'heartbeat') {
        const made = service.set(GUILD, { purpose: 'look at the thread', dueAt: clock.t, destination: 'c1', origin: 'heartbeat' });
        return { outcome: 'spoke', inner: { actions: [{ skill: 'intent.set', status: 'executed', result: 'ok', createdId: made.intention.id }], intentIds: [], turnId: 't-beat' } };
      }
      return { outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], intentIds: [], turnId: 't-due' } };
    },
  });
  const run = setup({ service, turns, record: sayings(), hot, rng: () => 0.5, dataDir, log });
  await run.inner.tick();
  clock.t = NOW + 182 * MINUTE_MS;
  await run.inner.tick();
  assert.deepEqual(turns.calls.map((call) => call.inner.wake.kind), ['heartbeat'], 'the heartbeat turn ran alone');
  const outcome = lines.find((line) => line.msg === 'inner: heartbeat outcome');
  assert.deepEqual([outcome.result, outcome.skill, outcome.openFromHeartbeat, outcome.refused], ['change', 'intent.set', 1, []]);
  assert.equal(outcome.intentionId, service.list(GUILD, { all: true })[0].id);
  await run.inner.tick();
  assert.deepEqual(turns.calls.map((call) => call.inner.wake.kind), ['heartbeat', 'intention_due']);
  assert.equal(turns.calls[1].inner.wake.intentions[0].origin, 'heartbeat');
  const due = lines.find((line) => line.msg === 'inner: heartbeat intention due');
  assert.deepEqual([due.intentionId, due.result, due.recurring], [outcome.intentionId, 'no-op', false]);
});

test('heartbeat: a running turn holds it to the next tick, due time kept; its chain cap is its own, so a chain of another kind at its cap does not touch it', async () => {
  const turns = fakeTurns();
  const run = setup({ turns, record: sayings(), hot: hotWith({ innerLife: { ...BEAT, caps: { perChain: 1 } } }), rng: () => 0.5 });
  await run.inner.tick();
  clock.t = NOW + 181 * MINUTE_MS;
  turns.busy = true;
  const held = await run.inner.tick();
  assert.equal(turns.calls.length, 0);
  assert.equal(held.drained.deferred, 'busy');
  assert.equal(run.inner.state(GUILD).queue[0].kind, 'heartbeat');
  turns.busy = false;
  await run.inner.tick();
  assert.equal(turns.calls.length, 1);
  assert.deepEqual(run.inner.state(GUILD).queue, []);
  await run.inner.tick();
  clock.t = run.inner.state(GUILD).heartbeat.nextAt + MINUTE_MS;
  await run.inner.tick();
  assert.equal(turns.calls.length, 2, 'a perChain of 1 holds no second heartbeat: each has its own chain');
});

test('heartbeat: the review keeps working unchanged beside it', async () => {
  const lines = [];
  for (let d = 1; d <= 5; d += 1) lines.push({ kind: 'said', occurredAt: new Date(Date.parse('2026-10-19T15:20:00Z') - d * DAY_MS).toISOString(), scope: { channel: 'c3' } });
  const record = { async *iterate() { for (const line of lines) yield line; } };
  const run = setup({ record, hot: hotWith({ innerLife: { ...BEAT, review: { enabled: true, historyDays: 14 } } }), rng: () => 0.5 });
  clock.t = Date.parse('2026-10-19T08:00:00Z');
  await run.inner.tick();
  const review = run.inner.status(GUILD).review;
  clock.t = review.at + MINUTE_MS;
  await run.inner.tick();
  await run.inner.tick();
  const kinds = run.turns.calls.map((call) => call.inner.wake.kind);
  assert.ok(kinds.includes('review'));
  assert.equal(run.turns.calls.find((call) => call.inner.wake.kind === 'review').channel.id, 'c3');
});
