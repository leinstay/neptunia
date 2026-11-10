// Tests for src/memory/episodes.ts: sortEpisodesForDisplay (rendering order),
// topEpisodes (the top N shown for a member asked about) and the episode rules other modules share
// (episodeDate in both forms, isSameEpisode). Pure; the
// import-graph test reads source files only.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sortEpisodesForDisplay, topEpisodes, episodeDate, isSameEpisode } from '../src/memory/episodes.ts';
import type { Untyped } from '../src/tools/types.ts';

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0); // 2026-09-21

function stored(list: Array<[string, string, number, string | null]>) {
  return list.map(([date, what, weight, addedAt]) => ({ date, what, quote: '', feeling: '', weight, addedAt }));
}

// ---- sortEpisodesForDisplay ---------------------------------------------------

test('sortEpisodesForDisplay: heaviest weight first', () => {
  const episodes = stored([
    ['2026-01-01', 'light', 1, 'a'],
    ['2026-01-01', 'heavy', 5, 'b'],
  ]);
  assert.deepEqual(
    sortEpisodesForDisplay(episodes).map((e) => loose(e).what),
    ['heavy', 'light']
  );
});

test('sortEpisodesForDisplay: among equal weights, newest (by date) first', () => {
  const episodes = stored([
    ['2026-01-01', 'older', 3, 'a'],
    ['2026-03-01', 'newer', 3, 'b'],
  ]);
  assert.deepEqual(
    sortEpisodesForDisplay(episodes).map((e) => loose(e).what),
    ['newer', 'older']
  );
});

test('sortEpisodesForDisplay: does not mutate its input', () => {
  const episodes = stored([
    ['2026-01-01', 'a', 1, 'x'],
    ['2026-01-02', 'b', 5, 'y'],
  ]);
  const copy = episodes.map((e: Untyped) => ({ ...e }));
  sortEpisodesForDisplay(episodes);
  assert.deepEqual(episodes, copy);
});

// ---- topEpisodes ----------------------------------------------------------------

test('episodes: topEpisodes keeps the heaviest then newest', () => {
  const episodes = stored([
    ['2026-01-01', 'ελαφρύ παλιό', 1, 'a'],
    ['2026-02-01', 'βαρύ παλιό', 4, 'b'],
    ['2026-03-01', 'βαρύ νέο', 4, 'c'],
    ['2026-03-02', 'μεσαίο', 2, 'd'],
    ['2026-03-03', 'ελαφρύ νέο', 1, 'e'],
  ]);
  assert.deepEqual(
    topEpisodes(episodes, 3).map((e) => loose(e).what),
    ['βαρύ νέο', 'βαρύ παλιό', 'μεσαίο']
  );
  assert.deepEqual(
    topEpisodes(episodes, 10).map((e) => loose(e).what),
    sortEpisodesForDisplay(episodes).map((e) => loose(e).what),
    'fewer than max -> all of them'
  );
});

test('episodes: topEpisodes gives none for a max that is not a positive integer, or no list', () => {
  const episodes = stored([['2026-01-01', 'στιγμή', 3, 'a']]);
  // @ts-expect-error: the test passes junk the signature refuses, to check how the function copes with it
  for (const max of [0, 1.5, '3']) assert.deepEqual(topEpisodes(episodes, max), [], String(max));
  assert.deepEqual(topEpisodes(undefined, 3), []);
});

test('episodes: topEpisodes does not mutate its input', () => {
  const episodes = stored([
    ['2026-01-01', 'a', 1, 'x'],
    ['2026-01-02', 'b', 5, 'y'],
  ]);
  const copy = episodes.map((e: Untyped) => ({ ...e }));
  topEpisodes(episodes, 1);
  assert.deepEqual(episodes, copy);
});

// ---- the shared episode rules ------------------------------------------------------

test('episodeDate: a YYYY-MM-DD string is kept, anything else falls back to the UTC day of now', () => {
  assert.equal(episodeDate('2025-01-01', NOW), '2025-01-01');
  for (const raw of ['not-a-date', ' 2025-01-01', '2025-1-1', undefined, 20250101]) {
    assert.equal(episodeDate(raw, NOW), '2026-09-21', String(raw));
  }
  assert.equal(episodeDate(undefined, Date.UTC(2026, 8, 21, 23, 59, 59)), '2026-09-21', 'the UTC day, not a local one');
});

test('episodeDate: a clock that is given but is no time is an error when the fallback is needed', () => {
  // @ts-expect-error: the test passes junk the signature refuses, to check how the function copes with it
  for (const clock of [NaN, 'τώρα']) assert.throws(() => episodeDate('ποτέ', clock), RangeError, String(clock));
  for (const clock of [NaN, 'τώρα'])
    // @ts-expect-error: the test passes junk the signature refuses, to check how the function copes with it
    assert.equal(episodeDate('2025-01-01', clock), '2025-01-01', `a usable date never reads the clock: ${clock}`);
});

test('episodeDate: without a clock it tests a stored date, the date itself or an empty string', () => {
  assert.equal(episodeDate('2025-01-01'), '2025-01-01');
  assert.equal(episodeDate('1999-12-31', undefined), '1999-12-31');
  const unusable = ['ποτέ', '2025-01-01 ', '2025-01-01T00:00:00Z', undefined, 20250101];
  for (const raw of unusable) {
    assert.equal(episodeDate(raw), '', String(raw));
    assert.equal(episodeDate(raw, undefined), '', `${String(raw)}: an undefined clock is the same form, not an error`);
  }
});

test('isSameEpisode: the same date and the same what once trimmed, whitespace-collapsed and lower-cased', () => {
  const a = { date: '2026-01-01', what: '  Η Zoë  ΤΡΑΓΟΎΔΗΣΕ\tστο κανάλι ', quote: '' };
  const b = { date: '2026-01-01', what: 'η zoë τραγούδησε στο κανάλι', quote: '' };
  assert.equal(isSameEpisode(a, b), true);
  assert.equal(isSameEpisode(b, a), true, 'symmetric');
  assert.equal(
    isSameEpisode(a, { ...b, date: '2026-01-02' }),
    false,
    'the same what on another date is another moment'
  );
  assert.equal(isSameEpisode(a, { ...b, what: 'η zoë τραγούδησε' }), false);
});

test('isSameEpisode: an identical non-empty quote is the same moment, whatever the date and what', () => {
  const a = { date: '2026-01-01', what: 'υποσχέθηκε κάτι', quote: 'δεν φεύγω ποτέ' };
  const b = { date: '2026-05-05', what: 'μια άλλη διατύπωση', quote: 'δεν φεύγω ποτέ' };
  assert.equal(isSameEpisode(a, b), true);
  assert.equal(isSameEpisode(a, { ...b, quote: 'Δεν φεύγω ποτέ' }), false, 'a quote is compared verbatim');
  assert.equal(
    isSameEpisode({ ...a, quote: '' }, { ...b, quote: '' }),
    false,
    'two empty quotes are no match by themselves'
  );
});

test('isSameEpisode: a stored entry that is not an object, or has no what, never throws', () => {
  const candidate = { date: '2026-01-01', what: 'κάτι', quote: '' };
  for (const junk of [null, 'κάτι']) {
    // @ts-expect-error: the test passes junk the signature refuses, to check how the function copes with it
    assert.equal(isSameEpisode(junk, candidate), false, String(junk));
    // @ts-expect-error: the test passes junk the signature refuses, to check how the function copes with it
    assert.equal(isSameEpisode(candidate, junk), false, String(junk));
  }
  assert.equal(isSameEpisode({ date: '2026-01-01', what: 42 }, candidate), false);
});
