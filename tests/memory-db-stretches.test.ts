// Tests for src/memory/db/stretches.ts#stretchesOf: her lines cut into stretches by place and by her silence, the one
// cut `<my_day>` and the memory session share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stretchesOf } from '../src/memory/db/stretches.ts';

const MIN = 60_000;

test('a silence of 31 minutes in one place starts a new stretch and one of 29 does not', () => {
  // Bug: the cut is not the half hour, so a conversation is split or two are joined.
  const cut = (gap: number) =>
    stretchesOf([
      { placeId: 'p', at: 0 },
      { placeId: 'p', at: gap * MIN },
    ]).map((one) => [one.at, one.end]);
  assert.deepEqual(cut(31), [
    [0, 0],
    [31 * MIN, 31 * MIN],
  ]);
  assert.deepEqual(cut(29), [[0, 29 * MIN]]);
});

test('lines of another place in between neither cut a stretch nor join it', () => {
  // Bug: the silence is measured over every place, so a line elsewhere keeps or breaks a talk.
  const stretches = stretchesOf([
    { placeId: 'a', at: 0 },
    { placeId: 'b', at: 10 * MIN },
    { placeId: 'a', at: 20 * MIN },
  ]);
  assert.deepEqual(
    stretches.map((one) => [one.placeId, one.lines.length]),
    [
      ['a', 2],
      ['b', 1],
    ]
  );
});
