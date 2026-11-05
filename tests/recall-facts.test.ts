// What a turn's prefetch takes from a retrieved page, and the query it asks with. The reads themselves are in
// tests/memory-retrieval-consumers.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factExcerpts, prefetchInput } from '../src/behavior/recall-facts.ts';
import type { MemoryPage, RetrievedAssertion } from '../src/memory/db/semantic-types.ts';

const fact = (assertionKind: RetrievedAssertion['assertionKind'], text: string): RetrievedAssertion => ({
  claimId: 'clm:1',
  versionId: `cv:${text}`,
  assertionKind,
  text,
  polarity: 'negative',
  state: 'disputed',
  arguments: [],
  evidence: [],
  dependencies: [],
  needsReview: false,
});
const page = (...assertions: Array<RetrievedAssertion>): MemoryPage => ({
  assertions,
  sourceIds: [],
  paths: [],
  next: null,
  partialReason: null,
  ambiguous: [],
  signals: [],
});

test('a memory with only names and plain claims adds no excerpt', () => {
  // Bug: every existing request changes bytes on the day the service ships.
  assert.deepEqual(factExcerpts(page(fact('label', 'Lumen'), fact('text', 'likes tea'))), []);
  assert.deepEqual(factExcerpts(null), []);
});

test('a structured fact keeps its version, its standing and her words', () => {
  // Bug: a disputed negative fact reaches the turn as a plain statement, or its read cannot be recorded.
  const [one] = factExcerpts(page(fact('relation', 'not on Lumen')));
  assert.deepEqual(
    [one.source, one.versionId, one.state, one.polarity, one.lines],
    ['semantic', 'cv:not on Lumen', 'disputed', 'negative', 'not on Lumen']
  );
});

test('a DM prefetch anchors on its partner once, and a group on its place', () => {
  // Bug: the partner counts twice, or a place from another turn becomes an anchor.
  const dm = prefetchInput({ kind: 'dm', person: 'person:a', destination: 'place:dm' }, 'hello', [
    'person:a',
    'person:b',
  ]);
  assert.deepEqual(dm, {
    purpose: 'prefetch',
    text: 'hello',
    people: ['person:a', 'person:b'],
    place: 'place:dm',
    entities: [],
  });
  assert.deepEqual(prefetchInput({ kind: 'group' }, null, []), {
    purpose: 'prefetch',
    text: '',
    people: [],
    place: null,
    entities: [],
  });
});
