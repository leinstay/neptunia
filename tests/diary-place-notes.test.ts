// What a diary plan reads of the places she knows: the owner's decision of 2026-11-05 removed the first place as a home,
// so the notes come from every top place the entry's readers may see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diaryPlaceNotes } from '../src/turn/diary.ts';

const NOTES: Record<string, object> = {
  'place:one': { patterns: 'short lines', injokes: ['the lamp'], learned: [{ text: 'ask first' }] },
  'place:two': { patterns: 'long threads', injokes: ['the kettle'], learned: [] },
};
const store = { getPlace: (placeId: string) => NOTES[placeId] ?? null };

test('one top place gives its notes untouched', () => {
  // Bug: the request of a one-server install changes because the notes went through a merge.
  assert.equal(diaryPlaceNotes(store, ['place:one'], 'place:one'), NOTES['place:one']);
});

test('an entry posted inside one server reads that server alone', () => {
  // Bug: an in-joke of a second server reaches readers who have never seen it.
  assert.deepEqual(diaryPlaceNotes(store, ['place:one', 'place:two'], 'place:two'), {
    patterns: 'long threads',
    injokes: ['the kettle'],
    learned: [],
  });
});

test('an entry posted in no server reads every top place, never only the first', () => {
  // Bug: the first place stands in as a home and the second server is forgotten in her diary.
  assert.deepEqual(diaryPlaceNotes(store, ['place:one', 'place:two'], null), {
    patterns: 'short lines\nlong threads',
    injokes: ['the lamp', 'the kettle'],
    learned: [{ text: 'ask first' }],
  });
});

test('no top place reads the persona', () => {
  // Bug: a core with no server yet throws, or invents a place, when her first entry is due.
  const asked: Array<string> = [];
  diaryPlaceNotes({ getPlace: (id) => (asked.push(id), null) }, [], null);
  assert.deepEqual(asked, ['persona:local']);
});
