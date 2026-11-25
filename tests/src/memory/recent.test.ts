// Tests for src/memory/recent.ts: the fold of a text, the live view of the recent lines and the account id of a raw
// value. Pure, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldText, liveRecent, accountIdOf } from '../../../src/memory/recent.ts';
import { tokenIds } from '../../../src/memory/mentions.ts';
import { HOUR_MS } from '../../../src/time.ts';

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const NOW_ISO = new Date(NOW).toISOString();
const NIKOS = '222222222222222222';
const AGORA = '900000000000000001';

/** A stored line as the store holds it. */
function line(id: number, fields: Record<string, unknown> = {}) {
  const text = (fields.text as string | undefined) ?? `γραμμή ${id}`;
  return { id, at: NOW - HOUR_MS, addedAt: NOW_ISO, placeId: AGORA, text, who: tokenIds(text), weight: 2, ...fields };
}

// --- foldText ------------------------------------------------------------------

test('recent: foldText strips accents (an accented e folds to e) and case', () => {
  assert.equal(foldText('Café  ÉTÉ\n'), 'cafe ete');
  assert.equal(foldText('  Η Ελένη   ΈΦΕΡΕ\tκαφέ '), 'η ελενη εφερε καφε');
  assert.equal(foldText('Ἀθήνα'), 'αθηνα');
});

// --- liveRecent ------------------------------------------------------------------

test('recent: liveRecent shows only the lines inside the window', () => {
  const lines = [
    line(1, { at: NOW - 73 * HOUR_MS }),
    line(2, { at: NOW - HOUR_MS }),
    line(3, { at: NOW - 72 * HOUR_MS }),
    line(4, { at: NOW - 30 * HOUR_MS }),
  ];
  assert.deepEqual(
    liveRecent(lines, { now: NOW, hours: 72 }).map((l) => l.id),
    [2, 3, 4],
    'stored order, the edge included'
  );
  assert.deepEqual(
    liveRecent(lines, { now: NOW, hours: 24 }).map((l) => l.id),
    [2]
  );
  assert.equal(lines.length, 4, 'never mutated');
});

test('recent: accountIdOf gives an id as a string, anything else null', () => {
  assert.equal(accountIdOf(NIKOS), NIKOS);
  assert.equal(accountIdOf(42), '42');
  for (const raw of ['', null, Number.NaN, {}, [NIKOS]]) assert.equal(accountIdOf(raw), null, String(raw));
});
