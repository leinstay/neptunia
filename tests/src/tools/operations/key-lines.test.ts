// Tests for src/tools/operations/key-lines.ts: the key lines appended to the `keys.base` field, over a fake client.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withKeyLines } from '../../../../src/tools/operations/key-lines.ts';

const hot = {
  prompts: {
    labels: { status: { costs: { keyState: '{role} runs on {key}{since}', keySince: ', switched {when}' } } },
  },
};

const llm = {
  keyStates: () => [
    { role: 'core', key: 'main', switchedAt: null },
    { role: 'memory', key: 'spare', switchedAt: Date.UTC(2026, 10, 3, 14, 5, 30) },
  ],
};

test('withKeyLines: puts one line per role after the given lines, with the switch minute in UTC', () => {
  assert.equal(
    withKeyLines(['base line'], { llm, hot }),
    'base line\ncore runs on main\nmemory runs on spare, switched 2026-11-03 14:05 UTC'
  );
});

test('withKeyLines: a client without a key reader gives the given lines alone', () => {
  assert.equal(withKeyLines(['first', 'second'], { llm: {}, hot }), 'first\nsecond');
  assert.equal(withKeyLines(['first'], { llm: null, hot }), 'first');
});
