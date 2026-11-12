// src/turn/request/attitudes.ts: the words of the `<attitudes>` block of `<self>` (spec 2026-11-12-what-the-frame-dropped,
// slice 3). Signatures:
//   type AttitudeWords = { labels: Labels; who: (person: string) => string }
//   attitudesText(list: ReadonlyArray<StrongAttitude>, words: AttitudeWords): string
// The text has no tags: `attitudes.header`, then one `attitudes.line` per person in the order given, `{who}` from `who`
// and `{band}` the word of `affinity.bands` for the band of the score. Pure, so the tests hand it labels of their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attitudesText } from '../src/turn/request/attitudes.ts';
import type { AttitudeWords } from '../src/turn/request/attitudes.ts';
import type { StrongAttitude } from '../src/memory/db/frame-reads.ts';
import type { Labels } from '../src/turn/request/types.ts';
import { shippedLabels } from './fixtures/shipped-labels.ts';

const BANDS = {
  hostile: 'B-hostile',
  dislike: 'B-dislike',
  cool: 'B-cool',
  neutral: 'B-neutral',
  warm: 'B-warm',
  fond: 'B-fond',
  devoted: 'B-devoted',
};
const OWN_LABELS: Labels = {
  ...shippedLabels,
  affinity: { bands: BANDS },
  attitudes: { header: 'FELT:', line: '* {who} / {band}' },
};
const words = (over: Partial<AttitudeWords> = {}): AttitudeWords => ({
  labels: OWN_LABELS,
  who: (person) => `W(${person})`,
  ...over,
});
const at = (person: string, score: number): StrongAttitude => ({ person, score, at: '2026-11-05' });
const labelled = (attitudes: Labels['attitudes']): AttitudeWords => words({ labels: { ...OWN_LABELS, attitudes } });

test('the text is the header and one line per person in the order given', () => {
  // Bug: the list is sorted again (the read already ordered it), or the header or a line is lost.
  const text = attitudesText([at('p1', -30), at('p2', 70), at('p3', 10)], words());
  assert.deepEqual(text.split('\n'), ['FELT:', '* W(p1) / B-dislike', '* W(p2) / B-devoted', '* W(p3) / B-warm']);
});

test('{who} is what the words give for the person id, never the id', () => {
  // Bug: the line carries the stored person id, or a name of its own, where the request names the person by handle.
  const text = attitudesText([at('person:x:9', 40)], words({ who: () => '@uabc1: Nina' }));
  assert.deepEqual(text.split('\n')[1], '* @uabc1: Nina / B-fond');
});

test('the band word follows the score at each edge of the bands', () => {
  // Bug: an edge falls on the wrong side (the bands are <= -60, <= -25, <= -8, < 8, < 25, < 60, else devoted), or the
  // band is looked up by a label key that does not exist.
  const edges: Array<[number, string]> = [
    [-60, 'B-hostile'],
    [-59.9, 'B-dislike'],
    [-25, 'B-dislike'],
    [-24.9, 'B-cool'],
    [-8, 'B-cool'],
    [8, 'B-warm'],
    [24.9, 'B-warm'],
    [25, 'B-fond'],
    [59.9, 'B-fond'],
    [60, 'B-devoted'],
    [100, 'B-devoted'],
  ];
  const lines = attitudesText(
    edges.map(([score], index) => at(`p${index}`, score)),
    words()
  )
    .split('\n')
    .slice(1);
  assert.deepEqual(
    lines.map((line) => line.split(' / ')[1]),
    edges.map(([, band]) => band)
  );
});

test('an empty list gives an empty text, with no header', () => {
  // Bug: a header stands over no one.
  assert.equal(attitudesText([], words()), '');
});

test('a missing header gives an empty text', () => {
  // Bug: the block opens with the word "undefined" or an empty line, or the lines stand with no header.
  assert.equal(attitudesText([at('p1', 40)], labelled({ line: '* {who} / {band}' })), '');
});

test('a missing line label gives an empty text', () => {
  // Bug: a header stands over lines that are the string "undefined".
  assert.equal(attitudesText([at('p1', 40)], labelled({ header: 'FELT:' })), '');
});
