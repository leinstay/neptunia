// Tests for src/behavior/turn-input.js: the turn's request input names every
// input src/behavior/prompt.js#buildRequest reads, and a key left out throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TURN_INPUT_KEYS, turnRequestInput } from '../src/behavior/turn-input.js';

/** Every input buildRequest reads: the keys it destructures from `input` and each `input.<key>` of its body. */
function buildRequestInputs() {
  const source = fs.readFileSync(new URL('../src/behavior/prompt.js', import.meta.url), 'utf8');
  const start = source.indexOf('export function buildRequest(input) {');
  assert.ok(start >= 0, 'buildRequest is where this test reads it');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  const destructured = /const \{([^}]*)\} = input;/.exec(body);
  assert.ok(destructured, 'buildRequest destructures its input');
  const keys = destructured[1]
    .split(',')
    .map((part) => part.trim().split(/[\s=:]/)[0])
    .filter(Boolean);
  for (const match of body.matchAll(/\binput\.(\w+)/g)) keys.push(match[1]);
  return new Set(keys);
}

/** A context naming every key, each with a distinct marker value. */
function fullContext() {
  return Object.fromEntries(TURN_INPUT_KEYS.map((key, i) => [key, { marker: i }]));
}

test('TURN_INPUT_KEYS: exactly the inputs buildRequest reads, each once', () => {
  assert.equal(new Set(TURN_INPUT_KEYS).size, TURN_INPUT_KEYS.length);
  assert.deepEqual(new Set(TURN_INPUT_KEYS), buildRequestInputs());
});

test('turnRequestInput: passes every named key through, in the list order, and nothing else', () => {
  const ctx = fullContext();
  const input = turnRequestInput(ctx);
  assert.deepEqual(Object.keys(input), [...TURN_INPUT_KEYS]);
  for (const key of TURN_INPUT_KEYS) assert.equal(input[key], ctx[key], key);
});

test('turnRequestInput: null is a deliberately absent input and passes as null', () => {
  const ctx = { ...fullContext(), drawQuota: null, recentLines: null };
  const input = turnRequestInput(ctx);
  assert.equal(input.drawQuota, null);
  assert.equal(input.recentLines, null);
});

test('turnRequestInput: a named key that holds undefined is left out, never a failed turn', () => {
  const input = turnRequestInput({ ...fullContext(), gifs: undefined });
  assert.equal('gifs' in input, false);
});

test('turnRequestInput: a key missing from the context throws, naming it', () => {
  const missing = fullContext();
  delete missing.focus;
  assert.throws(() => turnRequestInput(missing), /focus/);
});

test('turnRequestInput: recallAvailable is a named input beside searchAvailable; leaving it out throws', () => {
  assert.equal(TURN_INPUT_KEYS.indexOf('recallAvailable'), TURN_INPUT_KEYS.indexOf('searchAvailable') + 1);
  const ctx = fullContext();
  assert.equal(turnRequestInput({ ...ctx, recallAvailable: false }).recallAvailable, false);
  delete ctx.recallAvailable;
  assert.throws(() => turnRequestInput(ctx), /recallAvailable/);
});

test('turnRequestInput: a key buildRequest does not read throws, naming it', () => {
  assert.throws(() => turnRequestInput({ ...fullContext(), neighbours: [] }), /neighbours/);
});

test('turnRequestInput: no context throws', () => {
  assert.throws(() => turnRequestInput(undefined));
  assert.throws(() => turnRequestInput(null));
});
