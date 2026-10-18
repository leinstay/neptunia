// Tests for src/llm/limits.js: the per-turn / per-batch collector of the limits that bit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMIT_KINDS, createLimits } from '../src/llm/limits.js';

test('limits: collects and lists', () => {
  const limits = createLimits();
  assert.deepEqual(limits.list(), []);
  limits.add({ kind: 'message-cut', where: 'post', lost: 312 });
  limits.add({ kind: 'output-cap', where: 'completion' });
  limits.add({ kind: 'clamp', where: 'users.relationship', lost: 40, detail: 'first write' });
  assert.deepEqual(limits.list(), [
    { kind: 'message-cut', where: 'post', lost: 312 },
    { kind: 'output-cap', where: 'completion', lost: null },
    { kind: 'clamp', where: 'users.relationship', lost: 40, detail: 'first write' },
  ]);
  // The list is a copy: changing it never changes the collector.
  limits.list().pop();
  limits.list()[0].lost = 0;
  assert.equal(limits.list().length, 3);
  assert.equal(limits.list()[0].lost, 312);
});

test('limits: an entry without a known kind is ignored; a lost amount that is not a number is null', () => {
  const limits = createLimits();
  limits.add({ kind: 'not-a-limit', where: 'x', lost: 1 });
  limits.add(null);
  limits.add({ kind: 'daily-cap', where: 'llm.maxRequestsPerDay', lost: 'many' });
  limits.add({ kind: 'helper-timeout', where: 7, detail: 3 });
  assert.deepEqual(limits.list(), [
    { kind: 'daily-cap', where: 'llm.maxRequestsPerDay', lost: null },
    { kind: 'helper-timeout', where: null, lost: null },
  ]);
  assert.deepEqual(LIMIT_KINDS, ['budget-drop', 'estimate-off', 'output-cap', 'message-cut', 'message-merge', 'preview-cut', 'helper-timeout', 'helper-fallback', 'daily-cap', 'over-limit', 'clamp']);
});
