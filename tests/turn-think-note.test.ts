// The think of an answer as the command line's status row carries it (src/turn/think-note.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thinkNote } from '../src/turn/think-note.ts';

test('folds the line breaks of a think into single spaces', () => {
  assert.equal(thinkNote('Πρώτα διαβάζω.\n\n  Μετά απαντώ.\r\nΤέλος.'), 'Πρώτα διαβάζω. Μετά απαντώ. Τέλος.');
});

test('cuts a long think at 400 code points and never inside a pair', () => {
  const note = thinkNote('😀'.repeat(500));
  assert.equal(Array.from(note ?? '').length, 400);
  assert.equal(note, '😀'.repeat(400));
});

test('gives nothing for a think of blanks alone', () => {
  assert.equal(thinkNote(' \n\t '), null);
});
