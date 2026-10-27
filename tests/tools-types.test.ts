// src/tools/types.ts: the functions that narrow an `unknown` read from a config, a result or the model's arguments. A wrong
// shape is an empty value, never an exception.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idText, isObj, listOf, objOf, textOf } from '../src/tools/types.ts';

test('takes a plain object for a record and nothing else', () => {
  assert.equal(isObj({ a: 1 }), true);
  for (const other of [null, undefined, [], 'text', 5, () => ({})]) assert.equal(isObj(other), false);
});

test('gives the object itself, or an empty one for a value that is not a record', () => {
  const given = { a: 1 };
  assert.equal(objOf(given), given);
  assert.deepEqual(objOf(null), {});
  assert.deepEqual(objOf([1, 2]), {});
});

test('gives the list itself, or an empty one for a value that is not a list', () => {
  const given = [1, 2];
  assert.equal(listOf(given), given);
  assert.deepEqual(listOf({ length: 2 }), []);
});

test('gives a string as it is and the empty string for anything else', () => {
  assert.equal(textOf('abc'), 'abc');
  assert.equal(textOf(5), '');
  assert.equal(textOf(undefined), '');
});

test('writes a string or a number as an id and anything else as the empty string', () => {
  assert.equal(idText('u1'), 'u1');
  assert.equal(idText(42), '42');
  assert.equal(idText({ id: 'u1' }), '');
  assert.equal(idText(null), '');
});
