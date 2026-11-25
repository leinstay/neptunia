import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freezePerBucket, gifLine } from '../../../../src/behavior/prompt.ts';
import { rankGifs } from '../../../../src/memory/gifs.ts';
import { labels } from '../../../fixtures/labels.ts';

const HOUR = 3_600_000;

const MINUTE = 60_000;

// An hour edge: the bucket of a one-hour TTL starts here.
const EDGE = Date.UTC(2026, 8, 20, 10, 0, 0);

test('freezePerBucket: one value per bucket and signature; no map computes every time', () => {
  const freeze = new Map();
  let calls = 0;
  const compute = () => {
    calls += 1;
    return [`v${calls}`];
  };
  const at = (now: number, signature?: string) =>
    freezePerBucket(freeze, 'k', { now, bucketMs: HOUR, signature }, compute);
  assert.deepEqual(at(EDGE + MINUTE), ['v1']);
  assert.deepEqual(at(EDGE + 59 * MINUTE), ['v1']);
  assert.deepEqual(at(EDGE + 59 * MINUTE, 'other'), ['v2'], 'a new signature computes again');
  assert.deepEqual(at(EDGE + HOUR, 'other'), ['v3'], 'the next bucket computes again');
  const held = at(EDGE + HOUR + MINUTE, 'other');
  held.push('changed');
  assert.deepEqual(at(EDGE + HOUR + 2 * MINUTE, 'other'), ['v3'], 'a caller never changes what is held');
  assert.deepEqual(freezePerBucket(null, 'k', { now: EDGE, bucketMs: HOUR }, compute), ['v4']);
});

const NOW = Date.UTC(2026, 8, 20, 10, 0, 0);

const DAY = 86_400_000;

/** A library entry: a link GIF keyed `k<n>` with handle `g<n>`. */
function linkEntry(n: number, count: number, last = NOW - DAY) {
  return {
    id: `g${n}`,
    kind: 'link',
    url: `https://tenor.com/view/gif-${n}`,
    site: 'Tenor',
    name: `Danse ${n}`,
    itemId: `k${n}`,
    messageId: `m${n}`,
    placeId: 'c1',
    count,
    last,
    firstSeen: last,
  };
}

function library(entries: Array<{ itemId: string; [key: string]: unknown }>, nextId = 100) {
  return { nextId, entries: Object.fromEntries(entries.map((entry) => [entry.itemId, entry])), backfill: null };
}

/** B7: the lines media.find writes, in rank order: the same line a GIF's entry always had. */
function findLines(gifs: unknown, mediaCache: object | undefined, given: Record<string, unknown> = labels) {
  return rankGifs(gifs, 30).map((entry) => gifLine(entry, mediaCache, given, { ownMarkHours: 0, now: 0 }));
}

const THREE = library([linkEntry(1, 2), linkEntry(2, 9), linkEntry(3, 5)]);

// PR 7d: `gifs.max` is the constant 25, so the library holds 26 entries.
test("gifLine: the cached caption under the entry's itemId, entryNoText otherwise", () => {
  const mediaCache = {
    k2: { text: 'a cat dancing on a ὄρνις', ts: NOW },
    k3: { miss: 'error', ts: NOW },
  };
  const lines = findLines(THREE, mediaCache);
  assert.deepEqual(lines, ['g2 -- a cat dancing on a ὄρνις', 'g3', 'g1']);
});

/** A full-sentence caption of about 190 characters, the shape the describer stores. */
function longCaption(n: number) {
  return `Un chat roux numéro ${n} danse sur une table de cuisine en agitant les pattes, puis il glisse lentement et tombe sur le dos pendant que quelqu'un rit derrière la caméra du téléphone.`;
}

// A GIF is shown whole in its line; the cut at 70 characters goes.
test('gifLine: a 190-character caption is shown whole, with no ellipsis', () => {
  const caption = longCaption(2);
  const mediaCache = { k2: { text: caption, ts: NOW, watched: true, gif: true } };
  const lines = findLines(THREE, mediaCache);
  assert.equal(lines[0], `g2 -- ${caption}`);
});
