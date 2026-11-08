// The unrecorded mark of src/turn/unrecorded.ts: a turn over a line of the `service` client carries it through every
// await, and no other work sees it, so the journal, the facts and the owner's chat decide by it at the moment of use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUnrecorded, runUnrecorded } from '../src/turn/unrecorded.ts';

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('unrecorded work keeps its mark after an await and inside a timer it started', async () => {
  // Bug: the mark is lost at the first await, so her reply after the model call is stored as a line again.
  const seen = await runUnrecorded(true, async () => {
    await tick(5);
    const afterAwait = isUnrecorded();
    const inTimer = await new Promise<boolean>((resolve) => setTimeout(() => resolve(isUnrecorded()), 5));
    return { afterAwait, inTimer };
  });
  assert.deepEqual(seen, { afterAwait: true, inTimer: true });
});

test('work run with false is not unrecorded', async () => {
  // Bug: every turn runs unrecorded, so the owner's own lines and her answers to him are never stored.
  assert.equal(await runUnrecorded(false, () => Promise.resolve(isUnrecorded())), false);
});

test('a turn of the owner running beside an unrecorded one is not marked', async () => {
  // Bug: the mark is a shared flag, so an owner turn that overlaps a check loses its record.
  const both = await Promise.all([
    runUnrecorded(true, async () => {
      await tick(10);
      return isUnrecorded();
    }),
    runUnrecorded(false, async () => {
      await tick(5);
      return isUnrecorded();
    }),
  ]);
  assert.deepEqual(both, [true, false]);
  assert.equal(isUnrecorded(), false, 'nothing outside the work is marked');
});
