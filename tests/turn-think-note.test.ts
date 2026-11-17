// The think of an answer as the command line's status row carries it (src/turn/think-note.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thinkNote } from '../src/turn/think-note.ts';

test('folds the line breaks of a think into single spaces', () => {
  assert.equal(thinkNote('Πρώτα διαβάζω.\n\n  Μετά απαντώ.\r\nΤέλος.'), 'Πρώτα διαβάζω. Μετά απαντώ. Τέλος.');
});

// The owner on 2026-11-16: a think in the status row is kept whole; the limit of 400 is gone.
test('keeps a long think whole', () => {
  const note = thinkNote(`${'😀'.repeat(500)}\n${'x'.repeat(500)}`);
  assert.equal(note, `${'😀'.repeat(500)} ${'x'.repeat(500)}`);
});

test('gives nothing for a think of blanks alone', () => {
  assert.equal(thinkNote(' \n\t '), null);
});
