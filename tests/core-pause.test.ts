// Pause as the owner gives it from the command line: `neptunia -p /pause` and `neptunia -p /resume`
// (bin/neptunia.ts) against the core with its interfaces as units (tests/fixtures/core-units.ts), the fake interface
// a unit child. While paused, admission stops and active turns finish. Every event is still observed into memory, and
// nothing is dropped. A delivery the core committed before the pause is sent. On resume, the messages that arrived
// during the pause reach her once, through the catch-up path. A restart while paused stays paused. The tests watch the
// model's requests, what the fake posted and the memory rows, never a label's wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANSWER,
  helloTaken,
  mention,
  postedOnce,
  runCli,
  seenIds,
  settle,
  startUnitsCore,
  startedUnit,
  until,
  withRig,
} from './fixtures/core-units.ts';

/** The catch-up path the resume uses is on; everything else stays as the rig sets it. */
const CONFIG = { features: { offlineCatchUp: true } };

// Case 5 of PR D.
test('pause sends the reply already on its way, keeps a message that arrives, and resume answers it once', async () => {
  await withRig({ config: CONFIG }, async ({ dirs, llm, units, cores, logs }) => {
    cores.push(await startUnitsCore(dirs, llm));
    const unit = await startedUnit(dirs);
    units.push(unit);

    // Her reply to m1 is committed and waits at the interface when the pause comes.
    await unit.ask({ op: 'hold' }, 'done');
    const held = unit.told('held');
    assert.equal(await (await unit.emit(mention('m1', 'hello bot'))).acked, 'ok');
    await held;
    const pausing = runCli(dirs, ['-p', '/pause']);
    // The pause reaches the core just after its command line said hello. The short wait after the hello is the one
    // wall-clock bound: a slow run lets the reply go before the pause, which this test then does not catch.
    await until(() => helloTaken(logs, 'cli'), 'the hello of the command line');
    await settle(300);
    await unit.ask({ op: 'release' }, 'done');
    const paused = await pausing;
    assert.equal(paused.code, 0, paused.stderr.slice(-2000));
    assert.deepEqual(await postedOnce(unit, 1), [ANSWER], 'the committed reply went out');

    assert.equal(await (await unit.emit(mention('m2', 'are you still there'))).acked, 'ok');
    await settle(600);
    assert.equal(llm.requests.length, 1, 'no turn while paused');
    assert.deepEqual(seenIds(dirs), ['m1', 'm2'], 'the message of the pause is observed');

    const resumed = await runCli(dirs, ['-p', '/resume']);
    assert.equal(resumed.code, 0, resumed.stderr.slice(-2000));
    await until(() => llm.requests.length >= 2, 'the turn of the kept message');
    assert.ok(JSON.stringify(llm.requests[1]).includes('are you still there'));
    assert.deepEqual(await postedOnce(unit, 2), [ANSWER, ANSWER]);
    await settle(600);
    assert.equal(llm.requests.length, 2, 'the kept message reached her once');
    assert.deepEqual(await unit.posted('c1'), [ANSWER, ANSWER], 'her answer to it was sent once');
    assert.deepEqual(seenIds(dirs), ['m1', 'm2'], 'the resume observed nothing twice');
  });
});

// Case 6 of PR D.
test('a core restarted while paused stays paused until resume, then answers the message once', async () => {
  await withRig({ config: CONFIG }, async ({ dirs, llm, units, cores }) => {
    const first = await startUnitsCore(dirs, llm);
    cores.push(first);
    const paused = await runCli(dirs, ['-p', '/pause']);
    assert.equal(paused.code, 0, paused.stderr.slice(-2000));
    await first.stop();

    cores.push(await startUnitsCore(dirs, llm));
    const unit = await startedUnit(dirs);
    units.push(unit);
    assert.equal(await (await unit.emit(mention('m1', 'hello bot'))).acked, 'ok');
    await settle(600);
    assert.equal(llm.requests.length, 0, 'the restarted core is still paused');
    assert.deepEqual(seenIds(dirs), ['m1'], 'the message is observed while paused');

    const resumed = await runCli(dirs, ['-p', '/resume']);
    assert.equal(resumed.code, 0, resumed.stderr.slice(-2000));
    await until(() => llm.requests.length >= 1, 'the turn of the kept message');
    assert.deepEqual(await postedOnce(unit, 1), [ANSWER]);
    await settle(600);
    assert.equal(llm.requests.length, 1, 'the kept message reached her once');
    assert.deepEqual(await unit.posted('c1'), [ANSWER]);
  });
});
