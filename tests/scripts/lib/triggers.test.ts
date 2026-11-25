// Tests for scripts/lib/triggers.ts: the trigger list of scripts/replay.ts --loop-triggers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTriggers } from '../../../scripts/lib/triggers.ts';

const CH = '123456789012345678';
const M1 = '223456789012345678';
const M2 = '323456789012345678';

test('parseTriggers reads channel, trigger and an optional turn id, skipping comments', () => {
  const text = `# the harness set\n${CH} ${M1}\n\n  ${CH}   ${M2} t-9c2e-1  # with its turn\n`;
  assert.deepEqual(parseTriggers(text), [
    { placeId: CH, triggerId: M1, turnId: null },
    { placeId: CH, triggerId: M2, turnId: 't-9c2e-1' },
  ]);
  assert.throws(() => parseTriggers(`${CH}\n`), /line 1/);
  assert.throws(() => parseTriggers(`${CH} ${M1}\n${CH} abc\n`), /line 2/);
  assert.throws(() => parseTriggers(`${CH} ${M1} not-a-turn\n`), /line 1/);
});
