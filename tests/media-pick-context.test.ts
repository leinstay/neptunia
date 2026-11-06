// The media pick's context and its answer's reading (src/behavior/media-pick.ts): the pure tests of the GIF picker that
// survive stage B7 of plan 2026-11-04-cli-and-memory, moved here beside the contract tests of tests/media-pick.test.ts.
// The candidate list replaced the whole library, so its rendering tests went with it, and tests/gif-library.test.ts holds
// what a candidate is; a caption the describer wrote is read by captionOfCached below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMediaPick, pickContext } from '../src/behavior/media-pick.ts';
import { captionOfCached } from '../src/memory/gifs.ts';
import { wrongly } from './fixtures/loose-types.ts';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

/** A chat line of the picker's history. */
function line(id: string) {
  return { id, ts: NOW, authorName: 'Zoé', content: `λόγια ${id}` };
}

test('pickContext: the last contextMessages lines; the answered line among them is named by its place', () => {
  const history = ['m1', 'm2', 'm3', 'm4', 'm5'].map(line);
  const last = pickContext(history, { contextMessages: 3, answeredId: 'm5' });
  assert.deepEqual([last.messages.map((m) => m.id), last.answeredIndex], [['m3', 'm4', 'm5'], 3]);
  const inside = pickContext(history, { contextMessages: 3, answeredId: 'm4' });
  assert.deepEqual(
    [inside.messages.map((m) => m.id), inside.answeredIndex],
    [['m3', 'm4', 'm5'], 2],
    'not the last line'
  );
});

test('pickContext: an older answered line comes first, before the last lines', () => {
  const history = ['m1', 'm2', 'm3', 'm4', 'm5'].map(line);
  const older = pickContext(history, { contextMessages: 2, answeredId: 'm1' });
  assert.deepEqual([older.messages.map((m) => m.id), older.answeredIndex], [['m1', 'm4', 'm5'], 1]);
});

test('pickContext: an unknown answered line, none, or 0 context lines mark nothing', () => {
  const history = ['m1', 'm2', 'm3'].map(line);
  assert.deepEqual(pickContext(history, { contextMessages: 2, answeredId: 'elsewhere' }), {
    messages: history.slice(1),
    answeredIndex: null,
  });
  assert.deepEqual(pickContext(history, { contextMessages: 2 }), { messages: history.slice(1), answeredIndex: null });
  assert.deepEqual(pickContext(history, { contextMessages: 0, answeredId: 'm1' }), {
    messages: [],
    answeredIndex: null,
  });
  assert.deepEqual(pickContext(wrongly<Array<{ id?: unknown }>>(null), { contextMessages: 2, answeredId: 'm1' }), {
    messages: [],
    answeredIndex: null,
  });
});

const offer = (gifs: Array<string>) => ({ gifs, emoji: [], actions: [] });

test('parseMediaPick: a single line naming a listed handle, trimmed and in any case, returns the listed handle', () => {
  const handles = ['g1', 'g12', 'g172'];
  // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
  assert.deepEqual(parseMediaPick('{"pick":"gif","name":"g172"}', offer(handles)), { kind: 'gif', handle: 'g172' });
  assert.deepEqual(parseMediaPick('{"pick":"gif","name":"G12"}', offer(handles)), { kind: 'gif', handle: 'g12' });
});

test('parseMediaPick: none, an unlisted handle, extra text, several lines or no text are none', () => {
  const handles = ['g1', 'g12'];
  for (const answer of ['none', 'NONE', 'gif g2', 'gif g1 fits', 'gif g1\ngif g12', '`gif g1`', '', null, undefined]) {
    assert.deepEqual(parseMediaPick(answer, offer(handles)), { kind: 'none' }, String(answer));
  }
  assert.deepEqual(parseMediaPick('gif g1', offer([])), { kind: 'none' });
});

test('captionOfCached: the three fields of a watched GIF joined, an older caption as it is, a miss or nothing empty', () => {
  const watched = { text: 'a cat lifts', reaction: 'firm agreement', action: 'a cat lifts', screen: 'ναί.' };
  assert.equal(captionOfCached(watched), 'firm agreement; a cat lifts; ναί.');
  assert.equal(captionOfCached({ text: ' a man runs ' }), 'a man runs');
  assert.equal(captionOfCached({ miss: 'error', text: 'x' }), '');
  assert.equal(captionOfCached(undefined), '');
});
