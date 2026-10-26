import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitText } from '../src/protocol/split-text.ts';

const size = (part: string): number => [...part].length;

test('returns one empty part when the text is empty', () => {
  const parts = splitText('', 10);
  assert.deepEqual(parts, ['']);
});

test('returns one part when the text is exactly maxChars long', () => {
  const text = 'abcdefghij';
  const parts = splitText(text, 10);
  assert.equal(parts.join(''), text);
  assert.deepEqual(parts, [text]);
});

test('returns one part when the text is shorter than maxChars', () => {
  const text = 'short';
  const parts = splitText(text, 10);
  assert.equal(parts.join(''), text);
  assert.deepEqual(parts, [text]);
});

test('throws when maxChars is zero', () => {
  assert.throws(() => splitText('abc', 0));
});

test('throws when maxChars is negative', () => {
  assert.throws(() => splitText('abc', -1));
});

test('cuts a long unbroken word into parts of at most maxChars and joins back to the input', () => {
  const text = 'abcdefghijklmnopqrstuvwxyz';
  const parts = splitText(text, 10);
  assert.equal(parts.join(''), text);
  assert.deepEqual(parts, ['abcdefghij', 'klmnopqrst', 'uvwxyz']);
});

test('counts code points, not UTF-16 units, when the text is astral characters', () => {
  const text = '\u{1F600}'.repeat(10);
  const parts = splitText(text, 4);
  assert.equal(parts.join(''), text);
  assert.deepEqual(parts.map(size), [4, 4, 2]);
});

test('cuts after the last newline in the window when the window holds one', () => {
  const text = 'aaa\nbbb\nccc';
  const parts = splitText(text, 9);
  assert.equal(parts.join(''), text);
  assert.deepEqual(parts, ['aaa\nbbb\n', 'ccc']);
});

test('prefers the last newline over a later space in the window', () => {
  const text = 'aa\nb cc dd';
  const parts = splitText(text, 8);
  assert.equal(parts.join(''), text);
  assert.deepEqual(parts, ['aa\n', 'b cc dd']);
});

test('cuts after the last whitespace in the window when there is no newline', () => {
  const text = 'hello world foo';
  const parts = splitText(text, 8);
  assert.equal(parts.join(''), text);
  assert.deepEqual(parts, ['hello ', 'world ', 'foo']);
});

test('keeps a whitespace that ends exactly at the window edge in the earlier part', () => {
  const text = 'abcdefg hij';
  const parts = splitText(text, 8);
  assert.equal(parts.join(''), text);
  assert.deepEqual(parts, ['abcdefg ', 'hij']);
});

test('never splits a skin-tone emoji when it straddles the window edge', () => {
  const text = 'aaa\u{1F44D}\u{1F3FD}bbb';
  const parts = splitText(text, 4);
  assert.equal(parts.join(''), text);
  assert.deepEqual(parts, ['aaa', '\u{1F44D}\u{1F3FD}bb', 'b']);
});

test('never splits a family sequence when it straddles the window edge', () => {
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
  const text = `ab${family}cd`;
  const parts = splitText(text, 5);
  assert.equal(parts.join(''), text);
  assert.deepEqual(parts, ['ab', family, 'cd']);
});

test('cuts a Greek word that is too long for the window between graphemes', () => {
  const alpha = 'ά';
  const beta = 'β́';
  const gamma = 'γ́';
  const delta = 'δ́';
  const text = alpha + beta + gamma + delta;
  const parts = splitText(text, 3);
  assert.equal(parts.join(''), text);
  assert.deepEqual(parts, [alpha, beta, gamma, delta]);
});

test('keeps a mention intact when the window edge falls inside it', () => {
  const text = 'xxxxxxxx<@123>yyyy';
  const parts = splitText(text, 12);
  assert.equal(parts.join(''), text);
  assert.deepEqual(parts, ['xxxxxxxx', '<@123>yyyy']);
});

test('keeps a custom emoji markup intact when the window edge falls inside it', () => {
  const text = 'yyyyyyyy<:name:123>zz';
  const parts = splitText(text, 12);
  assert.equal(parts.join(''), text);
  assert.deepEqual(parts, ['yyyyyyyy', '<:name:123>z', 'z']);
});

test('keeps a token of exactly 64 characters intact', () => {
  const token = `<${'a'.repeat(62)}>`;
  const text = `${'x'.repeat(10)}${token}`;
  const parts = splitText(text, 70);
  assert.equal(token.length, 64);
  assert.equal(parts.join(''), text);
  assert.deepEqual(parts, ['x'.repeat(10), token]);
});

test('still honours maxChars when an angle-bracket run is longer than 64 characters', () => {
  const text = `<${'a'.repeat(70)}>`;
  const parts = splitText(text, 20);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every((part) => size(part) <= 20));
});
