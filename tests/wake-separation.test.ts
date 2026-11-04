// Which wake delivers a landed result, and what never gates a wake (plan section 7, the owner's word of 2026-11-04). A
// merged fix reaches her only in the selfimprovement wake, once, through the durable outbox, marked delivered only after
// that turn committed; a heartbeat neither shows nor marks it. No random source suppresses a wake. Over a real board and
// a fake turn runner (tests/fixtures/wake-life.ts). `guard:` names a test of what already works and must keep working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ackOutbox, proposalsOf } from '../src/behavior/selfimprovement-view.ts';
import { landedFor } from '../src/selfimprovement/landed.ts';
import { landTaskDirectly, selfimprovementWorld } from './fixtures/selfimprovement-rig.ts';
import { callsOf, wakeLife } from './fixtures/wake-life.ts';

const at = (text: string): number => Date.parse(text);
const DAY = 86_400_000;
const LANDED = { title: 'Lift the web.read timeout', files: ['src/web/read.ts'], pr: 12, decidedBy: 'owner' } as const;
const EVERY = { enabled: true, everyMinutes: 120, jitterMinutes: 0 };

test('a heartbeat wake with a landed row leaves it undelivered and out of its request', async (t) => {
  // Bug: the heartbeat takes the development receipt, so the selfimprovement wake never learns of its own merge.
  const world = selfimprovementWorld(t);
  landTaskDirectly(world, { ...LANDED, files: [...LANDED.files] });
  const run = wakeLife(world.caller, {
    start: at('2026-11-03T00:30:00Z'),
    heartbeat: EVERY,
    selfimprovement: { enabled: false },
  });
  await run.life.tick();
  run.clock.t = at('2026-11-03T02:31:00Z');
  await run.life.tick();
  const [beat] = callsOf(run, 'heartbeat');
  assert.ok(beat, 'the heartbeat ran');
  assert.ok(!JSON.stringify(beat.inner.wake).includes(LANDED.title), 'not in the request');
  assert.equal((await landedFor(world.caller)).landed.length, 1, 'still undelivered');
});

test('after a heartbeat the selfimprovement wake delivers the landed row once, and marks it only after its turn committed', async (t) => {
  // Bug: the row is marked before the turn commits, or the wake after it tells her about the same merge again.
  const world = selfimprovementWorld(t);
  landTaskDirectly(world, { ...LANDED, files: [...LANDED.files] });
  const undeliveredDuringTurn: Array<number> = [];
  const run = wakeLife(world.caller, {
    start: at('2026-11-03T00:30:00Z'),
    heartbeat: EVERY,
    onTurn: async (call) => {
      if (call.inner.wake.kind === 'selfimprovement')
        undeliveredDuringTurn.push((await landedFor(world.caller)).landed.length);
    },
  });
  await run.life.tick();
  run.clock.t = at('2026-11-03T02:31:00Z');
  await run.life.tick();
  run.clock.t = at('2026-11-03T03:01:00Z');
  await run.life.tick();
  const [first] = callsOf(run, 'selfimprovement');
  assert.deepEqual(
    first?.inner.wake.selfimprovement?.news.landed.map((one) => one.title),
    [LANDED.title]
  );
  assert.deepEqual(undeliveredDuringTurn, [1]);
  assert.equal((await landedFor(world.caller)).landed.length, 0);
  run.clock.t = at('2026-11-04T03:01:00Z');
  await run.life.tick();
  assert.deepEqual(callsOf(run, 'selfimprovement')[1]?.inner.wake.selfimprovement?.news.landed, []);
});

test('guard: a selfimprovement turn that ended in an error leaves the landed row for a later wake', async (t) => {
  const world = selfimprovementWorld(t);
  landTaskDirectly(world, { ...LANDED, files: [...LANDED.files] });
  const run = wakeLife(world.caller, { start: at('2026-11-03T02:00:00Z') });
  await run.life.tick();
  run.next.outcome = 'error';
  run.clock.t = at('2026-11-03T03:01:00Z');
  await run.life.tick();
  assert.equal((await landedFor(world.caller)).landed.length, 1);
  run.next.outcome = 'skip';
  // The first tick after the failure takes the feedback wake it left, the next one the day's wake.
  run.clock.t = at('2026-11-04T03:01:00Z');
  await run.life.tick();
  run.clock.t = at('2026-11-04T03:02:00Z');
  await run.life.tick();
  const shown = callsOf(run, 'selfimprovement').at(-1)?.inner.wake.selfimprovement?.news.landed;
  assert.equal(shown?.length, 1);
  assert.equal((await landedFor(world.caller)).landed.length, 0);
});

test('marking the rows a wake showed leaves a row between them that it did not show', async (t) => {
  // Bug: the mark goes up to the highest number shown, so a result that arrived while the view was read is lost unseen.
  const world = selfimprovementWorld(t);
  landTaskDirectly(world, null);
  landTaskDirectly(world, null);
  landTaskDirectly(world, null);
  const rows = (await proposalsOf(world.caller)).outbox.map((row) => Number(row.seq));
  assert.equal(rows.length, 3);
  await ackOutbox(world.caller, [rows[0] ?? 0, rows[2] ?? 0]);
  assert.deepEqual(
    (await proposalsOf(world.caller)).outbox.map((row) => Number(row.seq)),
    [rows[1]]
  );
});

for (const value of [0, 0.999]) {
  test(`guard: thirty days in a row each have their daily selfimprovement wake whatever the random source says (rng ${value})`, async (t) => {
    // The plan's "rare useful outcomes" is her decision: a gate, a quota or a forced wake count would be the bug here.
    const world = selfimprovementWorld(t);
    const start = at('2026-11-03T02:00:00Z');
    const run = wakeLife(world.caller, { start, rng: () => value });
    await run.life.tick();
    for (let day = 0; day < 30; day += 1) {
      run.clock.t = start + 3_600_000 + day * DAY;
      await run.life.tick();
    }
    const wakes = callsOf(run, 'selfimprovement');
    assert.equal(wakes.length, 30);
    assert.ok(wakes.every((call) => JSON.stringify(call.inner.wake).includes('"reason":"daily"')));
  });
}

for (const value of [0, 0.999]) {
  test(`guard: the random jitter of a heartbeat moves its moment and never drops it (rng ${value})`, async (t) => {
    const world = selfimprovementWorld(t);
    const run = wakeLife(world.caller, {
      start: at('2026-11-03T00:00:00Z'),
      heartbeat: { enabled: true, everyMinutes: 120, jitterMinutes: 60 },
      selfimprovement: { enabled: false },
      rng: () => value,
    });
    await run.life.tick();
    for (let tick = 1; tick <= 24 * 12; tick += 1) {
      run.clock.t = at('2026-11-03T00:00:00Z') + tick * 300_000;
      await run.life.tick();
    }
    assert.ok(callsOf(run, 'heartbeat').length >= 7, String(callsOf(run, 'heartbeat').length));
  });
}

test('guard: with the mechanic off no selfimprovement wake runs, and the heartbeat keeps its own schedule', async (t) => {
  const world = selfimprovementWorld(t);
  const run = wakeLife(world.caller, {
    start: at('2026-11-03T00:30:00Z'),
    heartbeat: EVERY,
    selfimprovement: { enabled: false, at: '03:00', failuresPerShape: 3 },
  });
  await run.life.tick();
  run.clock.t = at('2026-11-03T03:01:00Z');
  await run.life.tick();
  assert.deepEqual(callsOf(run, 'selfimprovement'), []);
  assert.equal(callsOf(run, 'heartbeat').length, 1);
});

test('guard: with the heartbeat off the selfimprovement wake keeps its own schedule', async (t) => {
  const world = selfimprovementWorld(t);
  const run = wakeLife(world.caller, { start: at('2026-11-03T02:00:00Z'), heartbeat: { enabled: false } });
  await run.life.tick();
  run.clock.t = at('2026-11-03T03:01:00Z');
  await run.life.tick();
  assert.equal(callsOf(run, 'selfimprovement').length, 1);
  assert.deepEqual(callsOf(run, 'heartbeat'), []);
});

test('a heartbeat that shares its moment with the selfimprovement wake runs at the next tick, once', async (t) => {
  // Bug: the selfimprovement wake goes first in the queue, and the heartbeat behind it is starved or lost.
  const world = selfimprovementWorld(t);
  const run = wakeLife(world.caller, {
    start: at('2026-11-03T00:30:00Z'),
    heartbeat: { enabled: true, everyMinutes: 150, jitterMinutes: 0 },
  });
  await run.life.tick();
  run.clock.t = at('2026-11-03T03:01:00Z');
  await run.life.tick();
  assert.deepEqual(
    run.calls.map((call) => call.inner.wake.kind),
    ['selfimprovement']
  );
  run.clock.t = at('2026-11-03T03:02:00Z');
  await run.life.tick();
  assert.deepEqual(
    run.calls.map((call) => call.inner.wake.kind),
    ['selfimprovement', 'heartbeat']
  );
  run.clock.t = at('2026-11-03T03:03:00Z');
  await run.life.tick();
  assert.equal(run.calls.length, 2, 'neither runs twice');
});

test('a selfimprovement wake waiting for its retry does not hold back the heartbeat, and comes back after it', async (t) => {
  // Bug: a provider failure keeps the selfimprovement wake at the head of the queue, and no heartbeat runs while it retries.
  const world = selfimprovementWorld(t);
  const run = wakeLife(world.caller, {
    start: at('2026-11-03T00:30:00Z'),
    heartbeat: { enabled: true, everyMinutes: 150, jitterMinutes: 0 },
  });
  await run.life.tick();
  run.next.outcome = 'error';
  run.next.reason = 'provider-error';
  run.clock.t = at('2026-11-03T03:01:00Z');
  await run.life.tick();
  run.next.outcome = 'skip';
  delete run.next.reason;
  // The first retry waits a minute: this tick falls inside that wait.
  run.clock.t = at('2026-11-03T03:01:30Z');
  await run.life.tick();
  assert.deepEqual(
    run.calls.map((call) => call.inner.wake.kind),
    ['selfimprovement', 'heartbeat']
  );
  run.clock.t = at('2026-11-03T03:03:00Z');
  await run.life.tick();
  assert.equal(callsOf(run, 'selfimprovement').length, 2, 'the failed wake is not lost');
});
