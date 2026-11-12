// src/memory/db/script-key.ts: the key by which a word of Cyrillic letters and the same word in Latin letters compare equal
// (spec 2026-11-12-names-across-scripts, slice 1). Contract:
//   scriptKey(word: string): string     a folded word with every letter of one script standing as the letter of the other
//                                       that people type for it; digits and Latin letters stand as themselves
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scriptKey } from '../src/memory/db/script-key.ts';

test('a word in Cyrillic letters and the same word in Latin letters give one key', () => {
  // Bug: the two spellings of one name keep two keys, so the name written in the other script finds nothing.
  assert.equal(scriptKey('вокзал'), scriptKey('vokzal'));
});

test('a word and an unrelated word of the other script give different keys', () => {
  // Bug: the table folds so much that any two words of similar length collide.
  assert.notEqual(scriptKey('вокзал'), scriptKey('kino'));
});

test('digits and Latin letters stand as themselves', () => {
  // Bug: the key rewrites a digit or a Latin letter, so "3d" is lost or collides with another word.
  assert.equal(scriptKey('3d'), '3d');
  assert.notEqual(scriptKey('3d'), scriptKey('4d'));
});
