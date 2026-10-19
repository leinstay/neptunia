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
  createCostMeter,
  createInnerLife,
  drawReviewAt,
  emptyState,
  errandRefusal,
  hourWeights,
  innerSettings,
  reviewWake,
  turnReserve,
  wakeOfDue,
} from '../src/behavior/inner.js';
import { createEventDoor } from '../src/interface/door.js';
import { createIntentionStores } from '../src/intentions/store.js';
import { createIntentionService } from '../src/intentions/service.js';
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
function setup({ records = [], hot = hotWith(), turns = fakeTurns(), dataDir = tempDir('nep-inner-'), record = null, meterUsd = 0.1, meter = null, rng = seeded(7), client = fakeClient(), peopleWaiting = () => false, onEpisode = null, errandLimitUsd = null, service = null } = {}) {
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
    errandLimitUsd,
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

test('inner: what a turn did and found is handed to her memory, shadow or not; a turn without an episode hands nothing', async () => {
  const episode = { turnId: 't-1', shadow: true, channelId: 'c1', findings: [{ skill: 'web.search', args: {}, text: 'x' }] };
  const handed = [];
  const turns = fakeTurns({ answer: () => ({ outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], stray: null, turnId: 't-1', episode } }) });
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

test('turnReserve: the estimate, or the costliest kept inner turn\'s real cost when more', () => {
  const settings = innerSettings(hotWith().config);
  assert.equal(turnReserve(emptyState(), settings), 0.15);
  assert.equal(turnReserve({ ...emptyState(), turns: [{ at: NOW, usd: 0.1 }, { at: NOW, usd: 0.42 }, { at: NOW }] }, settings), 0.42);
});

test('createCostMeter: running() says what the run has cost so far and its costliest request; zeros outside it', async () => {
  const { meter, emit } = ownMeter();
  const seen = [];
  const out = await meter.run(async () => {
    emit({ msg: 'llm: usage', role: 'voice', cost: 0.2 });
    seen.push(meter.running());
    emit({ msg: 'llm: usage', role: 'helper', upstreamCost: 0.05, cost: 9 });
    seen.push(meter.running());
  });
  assert.deepEqual(seen, [{ usd: 0.2, peak: 0.2 }, { usd: 0.25, peak: 0.2 }]);
  assert.deepEqual([out.usd, out.requests, out.voice], [0.25, 2, 1]);
  assert.deepEqual(meter.running(), { usd: 0, peak: 0 });
});

test('inner: a turn that cost more than the estimate raises the next reservation; the day is refused before it goes over', async () => {
  const { meter, emit } = ownMeter();
  const turns = fakeTurns({
    answer: () => {
      emit({ msg: 'llm: usage', role: 'voice', cost: 0.2 });
      emit({ msg: 'llm: usage', role: 'voice', cost: 0.2 });
      return { outcome: 'spoke', inner: { actions: [], stray: null, turnId: `t-${turns.calls.length}` } };
    },
  });
  const records = [intention('i1', { dueAt: NOW - 3 * MINUTE_MS }), intention('i2', { dueAt: NOW - 2 * MINUTE_MS, channelId: 'c2' }), intention('i3', { dueAt: NOW - MINUTE_MS, channelId: 'c3' })];
  const run = setup({ records, turns, meter, hot: hotWith({ innerLife: { estimatedTurnUsd: 0.15, caps: { perDay: 24, perHour: 4, perChain: 3, usdPerDay: 1, publicPostsPerDay: 2 } } }) });
  await run.inner.tick();
  await run.inner.tick();
  // 0.8 really spent: with the estimate alone (0.15) a third turn would run and end the day at 1.2.
  assert.deepEqual((await run.inner.tick()).drained, { refused: 'usd-per-day' });
  assert.equal(run.turns.calls.length, 2);
  assert.equal(run.inner.status(GUILD).budgets.usd.used, 0.8);
  await settle();
  assert.deepEqual(run.journal.filter((r) => r.event === 'turn').map((r) => r.cost.reservedUsd), [0.15, 0.4]);
  // The next day the real total starts again from nothing.
  clock.t = NOW + DAY_MS;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 3);
});

test('inner: inside a turn spendAllowed counts the day\'s real spend, the turn\'s so far and one more request as costly as its costliest', async () => {
  const { meter, emit } = ownMeter();
  const asked = [];
  const turns = fakeTurns({
    answer: (params) => {
      asked.push(params.inner.spendAllowed());
      emit({ msg: 'llm: usage', role: 'voice', cost: 0.3 });
      asked.push(params.inner.spendAllowed());
      emit({ msg: 'llm: usage', role: 'voice', cost: 0.3 });
      asked.push(params.inner.spendAllowed());
      return { outcome: 'spoke', inner: { actions: [], stray: null, turnId: `t-${turns.calls.length}` } };
    },
  });
  const caps = { perDay: 24, perHour: 4, perChain: 3, usdPerDay: 0.8, publicPostsPerDay: 2 };
  const run = setup({ records: [intention('i1'), intention('i2', { channelId: 'c2' })], turns, meter, hot: hotWith({ innerLife: { estimatedTurnUsd: 0.15, caps } }) });
  await run.inner.tick();
  // Before anything 0; then 0.3 + 0.3 = 0.6; then 0.6 + 0.3 = 0.9 over 0.8: no further call or request.
  assert.deepEqual(asked, [true, true, false]);
  // The turn's real 0.6 counts: the next turn (reserving 0.6) is refused, not admitted on the estimate.
  assert.deepEqual((await run.inner.tick()).drained, { refused: 'usd-per-day' });
});

// ---- errands an inner turn hands off hold their most possible cost ----------------------------

test('errandRefusal: an errand fits when the day, the turn\'s share and its hold stay within the ceiling; an unknown limit never fits', () => {
  assert.equal(errandRefusal({ used: 0.4, cap: 1 }, 0.15, 0.4), null);
  assert.equal(errandRefusal({ used: 0.5, cap: 1 }, 0.15, 0.4), 'inner-usd-cap');
  assert.equal(errandRefusal({ used: 0, cap: 1 }, 0, Number.NaN), 'inner-usd-cap');
});

test('budgetsOf: an errand hold counts as spent until its end, whatever day it was taken', () => {
  const settings = innerSettings(hotWith().config);
  const state = { ...emptyState(), holds: [{ id: 'h1', agent: 'web', usd: 0.4, at: NOW - DAY_MS, until: NOW + HOUR_MS, taskId: 'k1', key: null }] };
  assert.equal(budgetsOf(state, settings, { now: NOW, timezone: 'UTC' }).usd.used, 0.4);
  assert.equal(budgetsOf(state, settings, { now: NOW + HOUR_MS, timezone: 'UTC' }).usd.used, 0);
});

/** A live inner life whose one turn asks to hand off `count` errands of the web agent (each binds to `k<n>`). */
function errandSetup({ count, records = [intention('i1')], usdPerDay = 1, limit = 0.4, dataDir = tempDir('nep-inner-hold-'), maxMinutes = 60 } = {}) {
  const answers = [];
  const turns = fakeTurns({
    answer: (params) => {
      for (let n = 1; n <= count; n += 1) {
        const held = params.inner.reserveErrand({ agent: 'web', key: `t-hold.1:${n}` });
        answers.push(held);
        if (held.ok) params.inner.bindErrand(held.id, `k${n}`);
      }
      return { outcome: 'spoke', inner: { actions: [], stray: null, turnId: 't-hold' } };
    },
  });
  const hot = hotWith({ innerLife: { mode: 'live', errandReserveMaxMinutes: maxMinutes, caps: { perDay: 24, perHour: 4, perChain: 3, usdPerDay, publicPostsPerDay: 2 } } });
  const run = setup({ records, turns, hot, dataDir, meterUsd: 0.1, errandLimitUsd: (agent) => (agent === 'web' ? limit : null) });
  return { ...run, answers };
}

test('inner: errands an inner turn hands off hold their limit from dispatch; one past the day\'s dollars is refused; holds survive a restart; an end replaces its hold with the real cost', async () => {
  clock.t = NOW;
  const run = errandSetup({ count: 3 });
  await run.inner.tick();
  await settle();
  // 0 + 0.15 (the turn's reservation) + 0.4 fits; 0.4 + 0.15 + 0.4 fits; 0.8 + 0.15 + 0.4 does not.
  assert.deepEqual(run.answers.map((a) => a.ok), [true, true, false]);
  assert.equal(run.answers[2].code, 'inner-usd-cap');
  assert.equal(run.inner.status(GUILD).budgets.usd.used, 0.9, 'the turn\'s real 0.1 and two holds of 0.4');
  assert.equal(run.journal.filter((r) => r.event === 'errand-held').length, 2);
  assert.equal(run.journal.filter((r) => r.event === 'errand-refused').length, 1);
  const onDisk = JSON.parse(fs.readFileSync(path.join(run.dataDir, 'guilds', GUILD, 'inner.json'), 'utf8'));
  assert.deepEqual(onDisk.holds.map((h) => [h.taskId, h.usd]), [['k1', 0.4], ['k2', 0.4]]);
  // A restart reads the holds back.
  const again = setup({ records: [], dataDir: run.dataDir, hot: run.hot, errandLimitUsd: () => 0.4 });
  assert.equal(again.inner.status(GUILD).budgets.usd.used, 0.9);
  // The first errand ends at 0.25: its hold gives way to what it cost. One by its call's key.
  assert.equal(again.inner.onTaskFinished({ id: 'k1', origin: { turnId: 't-hold' }, usage: { usd: 0.25 } }, GUILD), true);
  assert.equal(again.inner.status(GUILD).budgets.usd.used, 0.75);
  assert.equal(again.inner.onTaskFinished({ id: 'other', idempotencyKey: 't-hold.1:2', origin: { turnId: 't-hold' }, usage: { usd: 0 } }, GUILD), false);
  assert.equal(again.inner.status(GUILD).budgets.usd.used, 0.35);
  assert.deepEqual(again.inner.state(GUILD).holds, []);
});

test('inner: a lost errand releases its hold at the wait\'s deadline when that comes first, else after errandReserveMaxMinutes', async () => {
  clock.t = NOW;
  const waiting = { ...intention('i9', { dueAt: null }), status: 'waiting', awaitingTaskId: 'k1', waitDeadline: NOW + 20 * MINUTE_MS };
  const run = errandSetup({ count: 1, records: [intention('i1'), waiting] });
  await run.inner.tick();
  assert.equal(run.inner.status(GUILD).budgets.usd.used, 0.5);
  clock.t = NOW + 19 * MINUTE_MS;
  await run.inner.tick();
  assert.equal(run.inner.state(GUILD).holds.length, 1);
  clock.t = NOW + 20 * MINUTE_MS;
  await run.inner.tick();
  await settle();
  assert.deepEqual(run.inner.state(GUILD).holds, []);
  assert.equal(run.inner.status(GUILD).budgets.usd.used, 0.1);
  assert.deepEqual(run.journal.filter((r) => r.event === 'errand-released').map((r) => [r.taskId, r.reason]), [['k1', 'lost']]);

  clock.t = NOW;
  const plain = errandSetup({ count: 1, maxMinutes: 30 });
  await plain.inner.tick();
  clock.t = NOW + 29 * MINUTE_MS;
  await plain.inner.tick();
  assert.equal(plain.inner.state(GUILD).holds.length, 1);
  clock.t = NOW + 30 * MINUTE_MS;
  await plain.inner.tick();
  assert.deepEqual(plain.inner.state(GUILD).holds, []);
  clock.t = NOW;
});

test('inner: a hold whose call handed nothing off is released at once; without errandLimitUsd a turn gets no hold hooks', async () => {
  clock.t = NOW;
  let released = null;
  const turns = fakeTurns({
    answer: (params) => {
      const held = params.inner.reserveErrand({ agent: 'web', key: 'k' });
      released = params.inner.releaseErrand(held.id);
      return { outcome: 'spoke', inner: { actions: [], stray: null, turnId: 't-r' } };
    },
  });
  const run = setup({ records: [intention('i1')], turns, hot: hotWith({ innerLife: { mode: 'live' } }), errandLimitUsd: () => 0.4 });
  await run.inner.tick();
  await settle();
  assert.equal(released, true);
  assert.deepEqual(run.inner.state(GUILD).holds, []);
  assert.ok(run.journal.some((r) => r.event === 'errand-released' && r.reason === 'not-dispatched'));
  const bare = setup({ records: [intention('i2')] });
  await bare.inner.tick();
  assert.equal(bare.turns.calls[0].inner.reserveErrand, undefined);
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
  assert.equal(after.budgets.day.used, 1);
  assert.equal(after.chains, 1);
  assert.equal(after.spentUsd, 0.25);
  assert.equal(after.heldUsd, 0);
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
  const turns = fakeTurns({ answer: () => ({ outcome: 'spoke', inner: { actions: [], intentIds: named, stray: null, turnId: 't-r' } }) });
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
  assert.equal(Object.keys(state.chains).length, 2);
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
});
