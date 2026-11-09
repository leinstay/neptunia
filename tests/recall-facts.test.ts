// What a turn's prefetch takes from a retrieved page, and the query it asks with. The reads themselves are in
// tests/memory-retrieval-consumers.test.ts.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { factExcerpts, prefetchInput, searchEpisodes } from '../src/behavior/recall-facts.ts';
import { pendingObjectEmbeds } from '../src/memory/db/object-vectors.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import { dmContext, groupContext } from '../src/memory/db/scope.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { AT, NOW, addDm, addPerson, noteInterface, openWorld } from './fixtures/memory-db/mind-world.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';
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

// ---- episodes by meaning -------------------------------------------------------------------------------------------

const EMBEDDER = 'test/embedder';
const PERSON = 'person:discord:e1';
const worlds: Array<World> = [];
after(() => {
  for (const one of worlds) one.close();
});

/** A world with one person, their direct chat, and the episodes given, each with its vector. */
function episodeWorld(
  episodes: ReadonlyArray<{ id: string; what: string; vector: ReadonlyArray<number>; dm?: boolean }>
): { w: World; dm: string } {
  const w = openWorld();
  worlds.push(w);
  noteInterface(w, 'discord', [{ id: 'g1', name: 'Ágora' }]);
  addPerson(w.db, { id: PERSON, accounts: [{ id: 'discord:e1', iface: 'discord', native: 'e1', names: ['Eléni'] }] });
  const dm = addDm(w.db, { iface: 'discord', native: 'e1', person: PERSON, account: 'discord:e1' });
  for (const one of episodes) {
    const scope = one.dm
      ? { scope_kind: 'dm', scope_iface: 'discord', scope_dm: PERSON, audience_id: `aud:dm:${dm}` }
      : { scope_kind: 'group', scope_iface: 'discord', scope_dm: null };
    insertRows(w.db, {
      episodes: [
        {
          id: one.id,
          kind: 'episode',
          subject_id: PERSON,
          date: '2026-10-30',
          what: one.what,
          created_at: AT,
          ...scope,
        },
      ],
    });
    const pending = pendingObjectEmbeds(w.db, { model: EMBEDDER, limit: 100 }).find((row) => row.itemId === one.id);
    assert.ok(pending, `${one.id} is pending`);
    const { kind, itemId, audienceId, hash } = pending;
    applyMemoryWrite(w.handle, {
      kind: 'object-embedding',
      model: EMBEDDER,
      now: NOW,
      items: [{ kind, itemId, audienceId, hash, vector: one.vector }],
    });
  }
  return { w, dm };
}

const config = (episodes: number) => ({ memoryDb: { retrieval: { episodes } }, recall: { db: { minMeaning: 0.35 } } });

test('an English search finds a Greek episode by its vector, with its date, and leaves a far one out', () => {
  // Bug: memory.search reads claims only, so a remembered moment never answers a question in another language.
  const { w } = episodeWorld([
    { id: 'ep:near', what: 'Χόρεψε στη γιορτή', vector: [1, 0, 0] },
    { id: 'ep:far', what: 'Έχασε το λεωφορείο', vector: [0, 1, 0] },
  ]);
  const found = searchEpisodes({
    db: w.db,
    ctx: groupContext('discord'),
    vector: [1, 0, 0],
    model: EMBEDDER,
    config: config(3),
  });
  assert.deepEqual(found, [{ id: 'ep:near', date: '2026-10-30', text: 'Χόρεψε στη γιορτή' }]);
});

test('a DM episode never answers a group search and does answer in its own chat', () => {
  // Bug: the episode list reads every vector, so a private moment surfaces in a public search.
  const { w, dm } = episodeWorld([{ id: 'ep:dm', what: 'Μου είπε ένα μυστικό', vector: [1, 0, 0], dm: true }]);
  const asked = { vector: [1, 0, 0], model: EMBEDDER, config: config(3) };
  assert.deepEqual(searchEpisodes({ db: w.db, ctx: groupContext('discord'), ...asked }), []);
  assert.deepEqual(
    searchEpisodes({ db: w.db, ctx: dmContext(PERSON, 'discord', dm), ...asked }).map((one) => one.id),
    ['ep:dm']
  );
});

test('the episodes stop at memoryDb.retrieval.episodes, and none come without a query vector', () => {
  // Bug: every meant episode lands in the result, or a lexical search shows episodes at random.
  const { w } = episodeWorld([
    { id: 'ep:a', what: 'Πρώτο', vector: [1, 0, 0] },
    { id: 'ep:b', what: 'Δεύτερο', vector: [0.9, 0.1, 0] },
  ]);
  const ctx = groupContext('discord');
  assert.deepEqual(
    searchEpisodes({ db: w.db, ctx, vector: [1, 0, 0], model: EMBEDDER, config: config(1) }).map((one) => one.id),
    ['ep:a']
  );
  assert.deepEqual(searchEpisodes({ db: w.db, ctx, vector: [1, 0, 0], model: EMBEDDER, config: config(0) }), []);
  assert.deepEqual(searchEpisodes({ db: w.db, ctx, vector: null, model: EMBEDDER, config: config(3) }), []);
});
