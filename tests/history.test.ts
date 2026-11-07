// Tests for src/turn/history.ts#orderedHistory: every line of a turn's chat and every call mark of hers, sorted by time
// once, after the reply parents, the deleted placeholders and the continuation lines are in. A mark is a line of its own
// (`self: true`, `kind: 'call'`, the call's time). Plan 2026-11-06-turn-frame, slice 2 (a). Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Line } from '../src/behavior/lines.ts';
import { orderedHistory } from '../src/turn/history.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 5, 10, 0, 0);
const NOW = T0 + 60 * MIN;
const PLACE = 'discord:channel:room-1';

/** A line of the chat by Zoé, or hers with `self`. */
function line(id: string, ts: number, self = false): Line {
  return {
    id,
    placeId: PLACE,
    authorId: self ? 'me' : 'u1',
    authorName: self ? 'Nept' : 'Zoé',
    content: id,
    self,
    ts,
    reactions: [],
  };
}

/** One call of hers made in this place, as the journal's call marks hold it. */
const mark = (at: number) => ({ placeId: PLACE, at, skill: 'memory.search', status: 'ok' });

/** The order of the result: a line by its id, a call mark as `mark`. */
const orderOf = (lines: ReadonlyArray<Line>) => lines.map((one) => (one.kind === 'call' ? 'mark' : one.id));

test('a call mark made between two messages stands between them, as a line of hers at the call time', () => {
  // Bug: a mark rides on the line before it, or after her last line, and her call reads as later than what answered it.
  const result = orderedHistory([line('m1', T0), line('m2', T0 + 10 * MIN)], [mark(T0 + 5 * MIN)], NOW);
  assert.deepEqual(orderOf(result), ['m1', 'mark', 'm2']);
  const own = result.find((one) => one.kind === 'call');
  assert.equal(own?.self, true);
  assert.equal(own?.ts, T0 + 5 * MIN);
});

test('a call mark at the same instant as a message comes after the message', () => {
  // Bug: the tie falls to input order, so the call reads as made before the message that led to it.
  const result = orderedHistory([line('m1', T0), line('m2', T0 + 5 * MIN)], [mark(T0 + 5 * MIN)], NOW);
  assert.deepEqual(orderOf(result), ['m1', 'm2', 'mark']);
});

test('a continuation line older than a line of the base history sorts before it', () => {
  // Bug: the continuation's lines are appended after the base, so a line written earlier is numbered later.
  const result = orderedHistory([line('b1', T0), line('b2', T0 + 10 * MIN), line('c1', T0 + 5 * MIN, true)], [], NOW);
  assert.deepEqual(orderOf(result), ['b1', 'c1', 'b2']);
});
