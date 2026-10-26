import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTscOutput, compareToBaseline } from '../tools/type-baseline.mjs';

const line = (file, code) => `${file}(3,5): error ${code}: Parameter 'x' implicitly has an 'any' type.`;

test('parseTscOutput: counts errors per file and code from real tsc lines', () => {
  const out = [
    "src/a.js(36,20): error TS7006: Parameter 'argv' implicitly has an 'any' type.",
    "src/a.js(43,7): error TS7053: Element implicitly has an 'any' type.",
    "  Type 'null' is not assignable to type 'object'.",
    "src/a.js(50,9): error TS7006: Parameter 'y' implicitly has an 'any' type.",
    line('tests/b.test.js', 'TS2339'),
  ].join('\n');
  assert.deepEqual(parseTscOutput(out), {
    'src/a.js': { TS7006: 2, TS7053: 1 },
    'tests/b.test.js': { TS2339: 1 },
  });
});

test('parseTscOutput: returns an empty map for empty output', () => {
  assert.deepEqual(parseTscOutput(''), {});
});

test('compareToBaseline: passes when the counts are equal', () => {
  const base = { 'src/a.js': { TS7006: 2 } };
  const result = compareToBaseline(base, { 'src/a.js': { TS7006: 2 } });
  assert.deepEqual(result.grew, []);
  assert.deepEqual(result.shrank, []);
});

test('compareToBaseline: refuses a count above the baseline', () => {
  const result = compareToBaseline({ 'src/a.js': { TS7006: 2 } }, { 'src/a.js': { TS7006: 3 } });
  assert.deepEqual(result.grew, [{ file: 'src/a.js', code: 'TS7006', was: 2, now: 3 }]);
  assert.deepEqual(result.shrank, []);
});

test('compareToBaseline: refuses a new file and code pair', () => {
  const base = { 'src/a.js': { TS7006: 2 } };
  const current = { 'src/a.js': { TS7006: 2, TS2322: 1 }, 'src/new.js': { TS7006: 1 } };
  const result = compareToBaseline(base, current);
  assert.deepEqual(result.grew, [
    { file: 'src/a.js', code: 'TS2322', was: 0, now: 1 },
    { file: 'src/new.js', code: 'TS7006', was: 0, now: 1 },
  ]);
});

test('compareToBaseline: reports a count below the baseline as a shrink', () => {
  const base = { 'src/a.js': { TS7006: 2 }, 'src/gone.js': { TS2322: 4 } };
  const result = compareToBaseline(base, { 'src/a.js': { TS7006: 1 } });
  assert.deepEqual(result.grew, []);
  assert.deepEqual(result.shrank, [
    { file: 'src/a.js', code: 'TS7006', was: 2, now: 1 },
    { file: 'src/gone.js', code: 'TS2322', was: 4, now: 0 },
  ]);
});

test('compareToBaseline: an empty baseline refuses every error', () => {
  const result = compareToBaseline({}, { 'src/a.js': { TS7006: 1 } });
  assert.equal(result.grew.length, 1);
});
