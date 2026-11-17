// Tests for src/memory/plain-description.ts: the cleanup of a final media description, which drops markdown emphasis
// and layout and turns an em dash into a comma. Fixed strings, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainDescription } from '../src/memory/plain-description.ts';

test('plainDescription: double asterisks around words leave the words', () => {
  assert.equal(plainDescription('a **grey cat** sleeps'), 'a grey cat sleeps');
});

test('plainDescription: single asterisks around words leave the words', () => {
  assert.equal(plainDescription('a *grey cat* sleeps'), 'a grey cat sleeps');
});

test('plainDescription: double underscores around words leave the words', () => {
  assert.equal(plainDescription('a __grey cat__ sleeps'), 'a grey cat sleeps');
});

test('plainDescription: single underscores around words leave the words', () => {
  assert.equal(plainDescription('a _grey cat_ sleeps'), 'a grey cat sleeps');
});

test('plainDescription: backticks are dropped', () => {
  assert.equal(plainDescription('the screen reads `npm test`'), 'the screen reads npm test');
});

test('plainDescription: a heading mark at a line start is dropped', () => {
  assert.equal(plainDescription('# A street at night'), 'A street at night');
});

test('plainDescription: a list bullet at a line start is dropped', () => {
  assert.equal(plainDescription('- a cat\n* a dog'), 'a cat\na dog');
});

test('plainDescription: a spaced em dash becomes a comma', () => {
  assert.equal(plainDescription('a cat — asleep'), 'a cat, asleep');
});

test('plainDescription: an unspaced em dash becomes a comma', () => {
  assert.equal(plainDescription('a cat—asleep'), 'a cat, asleep');
});

test('plainDescription: a lone asterisk inside a word stays', () => {
  // Bug: a censored word on a sign loses its asterisk and reads as the uncensored word.
  assert.equal(plainDescription('a sign reads f*ck off'), 'a sign reads f*ck off');
});

test('plainDescription: underscores inside names stay', () => {
  // Bug: an emoji or file name loses its underscore and no longer matches what people typed.
  assert.equal(plainDescription('the pepe_cop emoji over snake_case code'), 'the pepe_cop emoji over snake_case code');
});

test('plainDescription: a hyphen and an en dash stay', () => {
  assert.equal(plainDescription('a well-lit room, 1990–1995'), 'a well-lit room, 1990–1995');
});

test('plainDescription: text with no mark is returned unchanged', () => {
  const text = 'A grey cat sleeps on a red couch.';
  assert.equal(plainDescription(text), text);
});
