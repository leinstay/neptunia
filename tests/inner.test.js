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
  budgetsOf,
  capRefusal,
  chainBudget,
  coalesceGroup,
  createCostMeter,
  createInnerLife,
  currentChannelOf,
  drawReviewAt,
  emptyState,
  errandRefusal,
  feedbackFacts,
  hourWeights,
  innerSettings,
  reviewWake,
  turnReserve,
  wakeOfDue,
  DELIVERY_SKILLS,
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

test('inner: the turn gets the channel that asked as a delivery channel only for an intention someone else set; the feedback wake carries it on', async () => {
  const asked = { ...intention('i1', { purpose: 'send the cats' }), provenance: { kind: 'self', channelId: 'c1', scope: 'group', participants: ['u1'] } };
  const alone = { ...intention('i2', { channelId: 'c2' }), provenance: { kind: 'self', channelId: 'c2', scope: 'group', participants: [] } };
  const first = setup({ records: [asked] });
  await first.inner.tick();
  assert.deepEqual([...first.turns.calls[0].inner.deliveryChannels], ['c1']);
  assert.deepEqual(first.turns.calls[0].inner.wake.delivery, ['chan-c1']);
  const second = setup({ records: [alone] });
  await second.inner.tick();
  assert.equal(second.turns.calls[0].inner.deliveryChannels.size, 0);
  assert.equal(second.turns.calls[0].inner.wake.delivery, undefined);
  // The feedback turn of the asked intention keeps the delivery channel.
  const episode = { turnId: 't-1', shadow: false, channelId: 'c1', findings: [], actions: [] };
  const turns = fakeTurns({ answer: () => ({ ...lostTurn(), inner: { ...lostTurn().inner, episode } }) });
  const again = setup({ records: [{ ...asked }], turns, hot: hotWith({ innerLife: { mode: 'live' } }) });
  await again.inner.tick();
  clock.t = NOW + MINUTE_MS;
  await again.inner.tick();
  assert.deepEqual([...again.turns.calls[1].inner.deliveryChannels], ['c1']);
  assert.equal(again.turns.calls[1].inner.wake.kind, 'feedback');
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

test('turnReserve: the estimate, or the costliest kept inner turn\'s real cost when more', () => {
  const settings = innerSettings(hotWith().config);
  assert.equal(turnReserve(emptyState(), settings), 0.15);
  assert.equal(turnReserve({ ...emptyState(), turns: [{ at: NOW, usd: 0.1 }, { at: NOW, usd: 0.42 }, { at: NOW }] }, settings), 0.42);
});

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

test('inner: a turn that cost more than the estimate raises the next reservation; the day is refused before it goes over', async () => {
  const { meter, emit } = ownMeter();
  const turns = fakeTurns({
    answer: () => {
      emit({ msg: 'llm: usage', role: 'core', cost: 0.2 });
      emit({ msg: 'llm: usage', role: 'core', cost: 0.2 });
      return { outcome: 'spoke', inner: { actions: [], turnId: `t-${turns.calls.length}` } };
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
      emit({ msg: 'llm: usage', role: 'core', cost: 0.3 });
      asked.push(params.inner.spendAllowed());
      emit({ msg: 'llm: usage', role: 'core', cost: 0.3 });
      asked.push(params.inner.spendAllowed());
      return { outcome: 'spoke', inner: { actions: [], turnId: `t-${turns.calls.length}` } };
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
      return { outcome: 'spoke', inner: { actions: [], turnId: 't-hold' } };
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
      return { outcome: 'spoke', inner: { actions: [], turnId: 't-r' } };
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
  assert.equal(run.turns.calls.filter((call) => call.inner.wake.kind !== 'feedback').length, 1, 'no wake past the expiry (the one more turn is the feedback on the no-channel drop)');
  assert.equal(run.turns.calls.length, 2);
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

test('feedbackFacts: a call that ended unknown or refused, an intention closed with nothing delivered, the loop cut, a wake dropped or held; nothing when all went through', () => {
  assert.ok(WAKE_KINDS.includes('feedback'));
  assert.deepEqual(DELIVERY_SKILLS, ['message.create', 'draw.create', 'task.run', 'diary.post']);
  const facts = feedbackFacts(lostTurn(), { named: ['i1'], intentions: [intention('i1', { purpose: 'send a cat meme' })], wakes: [{ id: 'inner.wake:intention_due:i7:1', kind: 'intention_due', code: 'no-channel', intentionIds: ['i7'] }] });
  assert.deepEqual(facts, [
    { kind: 'callFailed', skill: 'message.create', status: 'refused', code: 'destination-required' },
    { kind: 'callFailed', skill: 'web.search', status: 'timeout', code: 'timeout' },
    { kind: 'doneWithoutDelivery', intentionId: 'i1', purpose: 'send a cat meme' },
    { kind: 'loopCut', cut: 'steps', droppedCalls: 1, steps: 2 },
    { kind: 'wakeDropped', id: 'inner.wake:intention_due:i7:1', wake: 'intention_due', code: 'no-channel', intentionId: 'i7', purpose: '' },
  ]);
  // A refused call carries its code; an executed delivery makes the done intention no fact; a loop that ended on its own is none.
  const delivered = feedbackFacts({ inner: { actions: [{ skill: 'message.create', status: 'executed', result: 'ok' }, { skill: 'intent.update', status: 'executed', result: 'ok', intentionId: 'i1', state: 'done' }, { skill: 'draw.create', status: 'refused', result: 'refused', code: 'inner-post-cap' }], intentIds: ['i1'], loop: { steps: 3, cut: null, droppedCalls: 0 } } });
  assert.deepEqual(delivered, [{ kind: 'callFailed', skill: 'draw.create', status: 'refused', code: 'inner-post-cap' }]);
  // A done set in shadow (proposed) closed nothing: no fact; without an id on the action the one named id counts.
  assert.deepEqual(feedbackFacts({ inner: { actions: [{ skill: 'intent.update', status: 'proposed', result: 'ok', intentionId: 'i1', state: 'done' }], intentIds: ['i1'] } }), []);
  assert.deepEqual(feedbackFacts({ inner: { actions: [{ skill: 'intent.update', status: 'executed', result: 'ok', state: 'done' }], intentIds: ['i2'] } }), [{ kind: 'doneWithoutDelivery', intentionId: 'i2', purpose: '' }]);
  // A wake held on a cap: its code.
  assert.deepEqual(feedbackFacts({ inner: {} }, { wakes: [{ id: 'w', kind: 'attend', code: 'per-hour', intentionIds: ['i3'] }], intentions: [intention('i3', { purpose: 'listen' })] }), [{ kind: 'wakeDropped', id: 'w', wake: 'attend', code: 'per-hour', intentionId: 'i3', purpose: 'listen' }]);
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
  assert.equal(params.inner.wake.budgets.chain.used, 1, 'the feedback turn counts against the chain like any turn');
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

test('inner: a wake of hers dropped as no-channel, or held on a cap with its due time over an hour past, is told once at her next turn', async () => {
  // i9 lands in a channel the client cannot fetch: dropped no-channel at the first drain; i1 runs at the next.
  const run = setup({ records: [intention('i9', { dueAt: NOW - 2 * MINUTE_MS, channelId: 'c9', purpose: 'announce the game night' }), intention('i1', { dueAt: NOW - MINUTE_MS })], hot: hotWith({ innerLife: { mode: 'live' } }) });
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 0);
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 1);
  assert.equal(run.turns.calls[0].inner.wake.intentions[0].id, 'i1');
  const queue = run.inner.state(GUILD).queue;
  assert.equal(queue.length, 1);
  assert.equal(queue[0].kind, 'feedback');
  assert.deepEqual(queue[0].facts, [{ kind: 'wakeDropped', id: `inner.wake:intention_due:i9:${NOW - 2 * MINUTE_MS}`, wake: 'intention_due', code: 'no-channel', intentionId: 'i9', purpose: 'announce the game night' }]);
  assert.equal(run.inner.state(GUILD).handled[`inner.wake:intention_due:i9:${NOW - 2 * MINUTE_MS}`].told, true);
  // The feedback turn, then another due intention: the drop is told once.
  clock.t = NOW + MINUTE_MS;
  await run.inner.tick();
  assert.equal(run.turns.calls[1].inner.wake.kind, 'feedback');
  run.intentions.records.push(intention('i2', { dueAt: NOW + 2 * MINUTE_MS, channelId: 'c2' }));
  clock.t = NOW + 3 * MINUTE_MS;
  await run.inner.tick();
  assert.equal(run.turns.calls.length, 3);
  assert.deepEqual(run.inner.state(GUILD).queue, [], 'nothing left to tell: no feedback wake');

  // An attend wake held on the attention's own per-day bound (the one cap other wakes pass): told once its due time is an hour past.
  const lines = [seen('m1', { by: 'u1', at: NOW - 5 * MINUTE_MS })];
  const held = attentionSetup({ lines, perDay: 1, innerLife: { mode: 'live' } });
  await held.inner.tick();
  assert.equal(held.turns.calls.length, 1, 'the first burst of the day');
  held.record.lines.push(seen('m2', { by: 'u2', at: NOW + 10 * MINUTE_MS }));
  clock.t = NOW + 12 * MINUTE_MS;
  assert.deepEqual((await held.inner.tick()).drained, { refused: 'attend-per-day' });
  // A due intention half an hour later: the held wake is not an hour past yet, no fact.
  held.service.set(GUILD, { purpose: 'say hi', dueAt: NOW + 30 * MINUTE_MS, channelId: 'c1', scope: 'group' });
  clock.t = NOW + 31 * MINUTE_MS;
  await held.inner.tick();
  assert.equal(held.turns.calls.length, 2);
  assert.deepEqual(held.inner.state(GUILD).queue.map((wake) => wake.kind), ['attend'], 'no feedback wake yet');
  // Over an hour past its due time, the next turn names it; the one after does not.
  held.service.set(GUILD, { purpose: 'say bye', dueAt: NOW + 80 * MINUTE_MS, channelId: 'c1', scope: 'group' });
  clock.t = NOW + 81 * MINUTE_MS;
  await held.inner.tick();
  assert.equal(held.turns.calls.length, 3);
  const feedback = held.inner.state(GUILD).queue.find((wake) => wake.kind === 'feedback');
  assert.ok(feedback, 'the held attend wake is a fact of this turn');
  assert.deepEqual(feedback.facts.map((fact) => `${fact.kind}:${fact.wake}:${fact.intentionId}:${fact.code}:${fact.purpose}`), [`wakeDropped:attend:${held.id}:attend-per-day:listen there`]);
  assert.equal(feedback.channelId, 'c1');
  assert.equal(held.inner.state(GUILD).queue.find((wake) => wake.kind === 'attend').told, true);
  clock.t = NOW + 82 * MINUTE_MS;
  await held.inner.tick();
  assert.equal(held.turns.calls[3].inner.wake.kind, 'feedback');
  held.service.set(GUILD, { purpose: 'say more', dueAt: NOW + 83 * MINUTE_MS, channelId: 'c1', scope: 'group' });
  clock.t = NOW + 84 * MINUTE_MS;
  await held.inner.tick();
  assert.equal(held.turns.calls.length, 5);
  assert.deepEqual(held.inner.state(GUILD).queue.map((wake) => wake.kind), ['attend'], 'told once');
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
