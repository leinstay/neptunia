// src/memory/db/inspection-values.ts: the typed values of the owner's storage inspection. A value keeps its storage class
// and its exact bytes: an integer is its decimal text, because a 64-bit integer does not fit a JavaScript number, and a
// blob is base64. Contract, plan 2026-11-04-cli-and-memory task 6 and "Shared memory reader contracts":
//   inspectionValueOf(storage: 'null' | 'integer' | 'real' | 'text' | 'blob', raw: unknown): InspectionValue
//   sqlValueOf(value: InspectionValue): null | string | number | bigint | Uint8Array
//   isInspectionValue(input: unknown): input is InspectionValue
// A value that cannot be represented exactly throws an Error with `code` INSPECTION_BAD_VALUE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectionValueOf, isInspectionValue, sqlValueOf } from '../src/memory/db/inspection-values.ts';
import type { InspectionValue } from '../src/memory/db/inspection-values.ts';

const BAD_VALUE = { code: 'INSPECTION_BAD_VALUE' };

test('an integer beyond the safe range keeps every digit', () => {
  // Bug: the reader goes through a JavaScript number and 2^63-1 comes back rounded.
  const value = inspectionValueOf('integer', 9223372036854775807n);
  assert.deepEqual(value, { kind: 'integer', value: '9223372036854775807' });
  assert.equal(sqlValueOf(value), 9223372036854775807n);
});

test('the smallest 64-bit integer keeps its sign and digits', () => {
  const value = inspectionValueOf('integer', -9223372036854775808n);
  assert.deepEqual(value, { kind: 'integer', value: '-9223372036854775808' });
  assert.equal(sqlValueOf(value), -9223372036854775808n);
});

test('a number already past the safe range is refused rather than reported as exact', () => {
  // Bug: a statement read without bigints hands over 2^53+1 rounded, and the export calls it exact.
  assert.throws(() => inspectionValueOf('integer', 2 ** 53 + 2), BAD_VALUE);
});

test('a real and an integer of the same magnitude stay different kinds', () => {
  // Bug: `Number.isInteger(42)` decides the kind, so the REAL 42.0 is reported as an integer.
  assert.deepEqual(inspectionValueOf('real', 42), { kind: 'real', value: 42 });
  assert.deepEqual(inspectionValueOf('integer', 42), { kind: 'integer', value: '42' });
});

test('null and empty text stay two values', () => {
  // Bug: `value || null` turns an empty stored text into a missing one.
  assert.deepEqual(inspectionValueOf('null', null), { kind: 'null' });
  assert.deepEqual(inspectionValueOf('text', ''), { kind: 'text', value: '' });
  assert.equal(sqlValueOf({ kind: 'null' }), null);
  assert.equal(sqlValueOf({ kind: 'text', value: '' }), '');
});

test('JSON text comes back byte for byte, its spacing and key order untouched', () => {
  // Bug: the reader parses JSON columns and serializes them again.
  const stored = ' {"z" : 1,\n "a":[ 1,2 ], "ά": "é"} ';
  assert.deepEqual(inspectionValueOf('text', stored), { kind: 'text', value: stored });
});

test('a blob of every byte value round-trips through base64', () => {
  // Bug: a blob decoded as UTF-8 text loses the bytes that are not valid UTF-8.
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
  const value = inspectionValueOf('blob', bytes);
  assert.deepEqual(value, { kind: 'blob', encoding: 'base64', value: Buffer.from(bytes).toString('base64') });
  const back = sqlValueOf(value);
  assert.ok(back instanceof Uint8Array);
  assert.deepEqual(Buffer.from(back), Buffer.from(bytes));
});

test('an empty blob is a blob and not null or empty text', () => {
  const value = inspectionValueOf('blob', new Uint8Array(0));
  assert.deepEqual(value, { kind: 'blob', encoding: 'base64', value: '' });
  const back = sqlValueOf(value);
  assert.ok(back instanceof Uint8Array);
  assert.equal(back.length, 0);
});

const BAD_SQL_VALUES: ReadonlyArray<readonly [string, InspectionValue]> = [
  ['an integer that is no integer', { kind: 'integer', value: '12a' }],
  ['an integer past 64 bits', { kind: 'integer', value: '9223372036854775808' }],
  ['base64 with foreign characters', { kind: 'blob', encoding: 'base64', value: '***' }],
];

for (const [label, value] of BAD_SQL_VALUES) {
  test(`a filter value is refused when it holds ${label}`, () => {
    // Bug: the bad value is bound as text, matches nothing and the owner reads an empty table as a fact.
    assert.throws(() => sqlValueOf(value), BAD_VALUE);
  });
}

const NOT_VALUES: ReadonlyArray<readonly [string, unknown]> = [
  ['an unknown kind', { kind: 'date', value: '2026' }],
  ['a text without its value', { kind: 'text' }],
  ['an integer given as a number', { kind: 'integer', value: 42 }],
  ['a real given as text', { kind: 'real', value: '1.5' }],
  ['a blob in another encoding', { kind: 'blob', encoding: 'hex', value: '00' }],
  ['no object at all', 'text'],
  ['null', null],
];

for (const [label, value] of NOT_VALUES) {
  test(`a value from a command line is not an inspection value when it is ${label}`, () => {
    // Bug: a filter parsed from a typed word reaches the binding unchecked.
    assert.equal(isInspectionValue(value), false);
  });
}

const VALUES: ReadonlyArray<InspectionValue> = [
  { kind: 'null' },
  { kind: 'text', value: '' },
  { kind: 'integer', value: '-1' },
  { kind: 'real', value: 1.5 },
  { kind: 'blob', encoding: 'base64', value: 'AA==' },
];

for (const value of VALUES) {
  test(`${value.kind} in its documented shape is an inspection value`, () => {
    assert.equal(isInspectionValue(value), true);
  });
}
