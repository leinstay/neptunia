// src/turn/request/inner-block.ts: `<inner>`, her own state that lasts between turns (plan 2026-11-06-turn-frame,
// slice 4 (a)). Contract:
//   innerBlockOf({ myDay: Array<string>, intentions: string | null, errands: string | null, feedback: string | null,
//     previousThink: { text; relation: 'same' | 'earlier'; ageMs?: number } | null }, labels: Labels,
//     resolveRef: (text: string) => string): string
// Every stored text in it passes through `resolveRef` (src/turn/request/refs.ts), so a line's identity never reaches
// the model raw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { innerBlockOf } from '../src/turn/request/inner-block.ts';
import { shippedLabels } from './fixtures/shipped-labels.ts';

const EMPTY = { myDay: [], intentions: null, errands: null, feedback: null, previousThink: null };
const resolveRef = (text: string): string => text.replaceAll('src:fake:m77:1', '#12');

test('an intention renders through resolveRef, with no identity left raw', () => {
  // Bug: an intention made in an earlier turn carries `src:` identities she cannot read.
  const text = innerBlockOf({ ...EMPTY, intentions: 'απάντησε στο src:fake:m77:1' }, shippedLabels, resolveRef);
  assert.ok(text.includes('απάντησε στο #12'));
  assert.doesNotMatch(text, /src:fake/);
});

test('the previous think renders through resolveRef too', () => {
  // Bug: only intentions are resolved, and her unresolved thought quotes an identity.
  const previousThink = { text: 'περιμένω το src:fake:m77:1', relation: 'same' as const };
  const text = innerBlockOf({ ...EMPTY, previousThink }, shippedLabels, resolveRef);
  assert.ok(text.includes('#12'));
  assert.doesNotMatch(text, /src:fake/);
});

test('nothing of her own state renders no text', () => {
  // Bug: an empty `<inner>` with empty subtags reaches the request.
  assert.equal(innerBlockOf(EMPTY, shippedLabels, resolveRef).trim(), '');
});
