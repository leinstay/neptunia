// The owner's no-catch-up policy of 2026-11-02 through the real core: nothing is read or answered on its own after an
// absence. The model is a function that records its requests, so nothing calls a provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mention, settle, startUnitsCore, startedUnit, postedOnce, withRig } from './fixtures/core-units.ts';

test('a restart reads no missed history and starts no turn over it, and the next message is answered', async () => {
  // Bug: the start catches up on what was said during the downtime, or answers a question hours old.
  await withRig({}, async ({ dirs, llm, units, cores }) => {
    const first = await startUnitsCore(dirs, llm);
    cores.push(first);
    const before = await startedUnit(dirs);
    units.push(before);
    assert.equal(await (await before.emit(mention('m1', 'hello bot'))).acked, 'ok');
    await postedOnce(before, 1);
    await first.stop();
    await before.kill();

    cores.push(await startUnitsCore(dirs, llm));
    const after = await startedUnit(dirs);
    units.push(after);
    await settle(600);
    assert.equal(llm.requests.length, 1, 'no turn at the start');
    assert.equal(await (await after.emit(mention('m2', 'are you back'))).acked, 'ok');
    await postedOnce(after, 1);
    assert.equal(llm.requests.length, 2);
  });
});
