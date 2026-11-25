// interfaces/cli/galaxy.ts: the frames of the header's galaxy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { galaxyFrame, reducedMotion } from '../../../interfaces/cli/galaxy.ts';

test('the galaxy turns tick by tick, repeats, and stands still under reduced motion', () => {
  // Bug: frames change size and flicker the input below them, or motion ignores the owner's setting.
  const first = galaxyFrame(0);
  assert.equal(first.length, 5);
  assert.ok(first.every((row) => row.length === 13));
  assert.notDeepEqual(galaxyFrame(1), first);
  assert.deepEqual(galaxyFrame(24), first);
  assert.equal(reducedMotion({ NEPTUNIA_REDUCED_MOTION: '1' }), true);
  assert.equal(reducedMotion({ TERM: 'xterm' }), false);
});
