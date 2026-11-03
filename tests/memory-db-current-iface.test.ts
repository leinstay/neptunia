// src/memory/db/current-iface.ts: the interface of the current event, carried through its awaits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentIface, withIface } from '../src/memory/db/current-iface.ts';

test('two events at once each keep their own interface across awaits', async () => {
  // Bug: a member of the second interface is written under the first because the two events interleave.
  const seen: Array<string | null> = [];
  const work = async (iface: string, ms: number) =>
    withIface(iface, async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      seen.push(`${iface}=${currentIface() ?? ''}`);
    });
  await Promise.all([work('one', 10), work('two', 1)]);
  assert.deepEqual(seen, ['two=two', 'one=one']);
  assert.equal(currentIface(), null);
});
