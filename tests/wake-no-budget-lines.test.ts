// The owner's word of 2026-11-06: no budget line reaches her turns, because the ways a budget is counted are too many.
// A request holds neither the `labels.wake.budgets` lead nor a line per budget ("turns for this thread: ...",
// "until <Sunday>: N turns of M"), and the prompt of an inner turn no longer tells her to live on them. The limits
// themselves stay: a chain past `wakes.caps.perChain` is still held. Over the turn harness with the shipped inner
// prompt, and the inner scheduler's rig for the cap. Synthetic Greek text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { intention, hotWith, setup } from './fixtures/inner-rig.ts';

// The limits are not the lines: with the lines gone, a chain at its cap is still held until the next local day.
test('a chain past wakes.caps.perChain is still held after the budget lines left the wake', async () => {
  const run = setup({
    records: [intention('i1', { chainId: 'k' }), intention('i2', { chainId: 'k', placeId: 'c2' })],
    hot: hotWith({ wakes: { caps: { perChain: 1 } } }),
  });
  await run.inner.tick();
  // The lead: the turn calls get a name, so the read stays three segments deep (R.2).
  const turnCalls = run.turns.calls;
  assert.equal(turnCalls.length, 1, 'the first wake of the chain runs');
  assert.deepEqual((await run.inner.tick()).drained, { refused: 'per-chain' });
  assert.equal(run.inner.state().queue.find((wake) => wake.kind !== 'feedback')?.capped, 'per-chain');
});
