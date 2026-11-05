// Scoped text candidates of semantic memory, stage S6: `searchSemantic` reads version-scoped documents through the
// audience of the issued context, and its rank comes from what that context can see. The non-interference tests compare a
// whole public answer before and after private rows are added, so a global statistic, a candidate cut or a popularity
// count that reads private rows changes the answer and fails. Each adversarial test proves the private row findable
// through the internal context first. Synthetic content only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { pendingSemanticEmbeddings, searchSemantic, semanticCacheKey } from '../src/memory/db/semantic-search.ts';
import type { SemanticSearchInput } from '../src/memory/db/semantic-search.ts';
import type { Context } from '../src/memory/db/scope.ts';
import { wrongly } from './fixtures/loose-types.ts';
import {
  ALEX,
  ALEX_ACCOUNT,
  MIRA,
  addEntity,
  addSource,
  candidate,
  commit,
  sameAs,
  semanticWorld,
  successor,
  worksOn,
} from './fixtures/memory-db/semantic-world.ts';
import type { World } from './fixtures/memory-db/semantic-world.ts';

const MODEL = 'fixture/embedding';
const search = (text: string, change: Partial<SemanticSearchInput> = {}): SemanticSearchInput => ({
  text,
  limit: 10,
  recordedBefore: null,
  vector: null,
  model: null,
  ...change,
});
const versions = (world: World, ctx: Context, input: SemanticSearchInput): Array<string> =>
  searchSemantic(world.db, ctx, input).hits.map((hit) => hit.versionId);
const written = (result: object): { claimId: string; versionId: string } =>
  result as { claimId: string; versionId: string };
const property = (entityId: string, status: string, sources: Array<string>) =>
  candidate(
    'project.status',
    'property',
    [
      { role: 'project', position: 0, ref: { kind: 'entity', id: entityId } },
      { role: 'status', position: 0, literal: status },
    ],
    sources,
    { text: `the project is at ${status}` }
  );
/** A unit vector along one axis, as a stored embedding and a query both are. */
const axis = (index: number, dims = 4): Array<number> =>
  Array.from({ length: dims }, (_, at) => (at === index ? 1 : 0));
const embed = (world: World, documentKey: string, vector: ReadonlyArray<number>, model = MODEL): void => {
  applyMemoryWrite(world.handle, {
    kind: 'semantic-embedding',
    documentKey,
    model,
    vector: [...vector],
    now: world.now(),
  });
};

// ---- lexical findability ---------------------------------------------------------------------------------------------

test('a label is findable by its text', () => {
  // Bug: names reach no search document, so a project cannot be found by what it is called.
  const world = semanticWorld();
  const lumen = addEntity(world, 'project', 'Lumen', [addSource(world, 'public', 'one')]);
  const [hit] = searchSemantic(world.db, world.contexts.group, search('lumen')).hits;
  assert.deepEqual([hit?.versionId, hit?.ref], [lumen.versionId, { kind: 'entity', id: lumen.entityId }]);
  world.handle.close();
});

test('a property literal is findable', () => {
  // Bug: only the prose is indexed, and a structured value is invisible to words.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const fact = written(
    commit(
      world,
      candidate(
        'project.status',
        'property',
        [
          { role: 'project', position: 0, ref: { kind: 'entity', id: entityId } },
          { role: 'status', position: 0, literal: 'zeppelin' },
        ],
        [source],
        { text: 'its state, in her words' }
      )
    )
  );
  assert.deepEqual(versions(world, world.contexts.group, search('zeppelin')), [fact.versionId]);
  world.handle.close();
});

test('a concept and a relation text are findable', () => {
  // Bug: a kind of assertion is left out of the document builder.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const echo = addEntity(world, 'concept', 'Echo', [source]);
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const fact = written(
    commit(world, worksOn(ALEX, entityId, [source], { text: 'a quarrel about harmonica practice' }))
  );
  assert.deepEqual(versions(world, world.contexts.group, search('echo')), [echo.versionId]);
  assert.deepEqual(versions(world, world.contexts.group, search('harmonica')), [fact.versionId]);
  world.handle.close();
});

test('a word inside a stored text finds it with diacritics folded', () => {
  // Bug: a name with an accent cannot be found by someone who types it plain.
  const world = semanticWorld();
  const cafe = addEntity(world, 'location', 'Café Ωμέγα', [addSource(world, 'public', 'one')]);
  assert.deepEqual(versions(world, world.contexts.group, search('cafe')), [cafe.versionId]);
  world.handle.close();
});

test('a query of FTS syntax is searched as words and never throws', () => {
  // Bug: a member's quote or a dash reaches MATCH as syntax, and the turn's retrieval fails.
  const world = semanticWorld();
  addEntity(world, 'project', 'Lumen', [addSource(world, 'public', 'one')]);
  for (const text of ['"', 'lumen OR', 'NEAR(', 'a-b*', '']) {
    assert.doesNotThrow(() => searchSemantic(world.db, world.contexts.group, search(text)), text);
  }
  world.handle.close();
});

test('an empty text finds nothing and asks for nothing', () => {
  // Bug: an empty query returns the whole corpus inside a prompt budget.
  const world = semanticWorld();
  addEntity(world, 'project', 'Lumen', [addSource(world, 'public', 'one')]);
  assert.deepEqual(searchSemantic(world.db, world.contexts.group, search('   ')).hits, []);
  world.handle.close();
});

test('a read needs a context', () => {
  // Bug: a missing context reads every audience.
  const world = semanticWorld();
  assert.throws(() => searchSemantic(world.db, wrongly<Context>(null), search('lumen')), /context/);
  world.handle.close();
});

test('a limit caps the hits and the total counts only what the context can see', () => {
  // Bug: the limit is applied before the audience filter, or the total reveals hidden matches.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'one');
  const secret = addSource(world, 'alex', 'two');
  for (let index = 0; index < 4; index += 1) addEntity(world, 'project', `Lumen ${index}`, [open]);
  for (let index = 0; index < 3; index += 1)
    addEntity(world, 'project', `Lumen hidden ${index}`, [secret], world.contexts.alex);
  const found = searchSemantic(world.db, world.contexts.group, search('lumen', { limit: 2 }));
  assert.equal(found.hits.length, 2);
  assert.equal(found.visibleTotal, 4);
  world.handle.close();
});

test('a version recorded after the cutoff is not found at that cutoff', () => {
  // Bug: a historical question is answered with what was only learned later.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const early = addEntity(world, 'project', 'Lumen early', [source]);
  const at = world.db.prepare('SELECT recorded_at FROM claim_versions WHERE id = ?').get(early.versionId)?.recorded_at;
  const cutoff = new Date(Date.parse(String(at)) + 500).toISOString();
  addEntity(world, 'project', 'Lumen late', [source]);
  assert.deepEqual(versions(world, world.contexts.group, search('lumen', { recordedBefore: cutoff })), [
    early.versionId,
  ]);
  world.handle.close();
});

// ---- non-interference ------------------------------------------------------------------------------------------------

/** A public corpus with a clear order, its answer for a query, and that answer again after `adding` ran. */
function assertPublicAnswerSurvives(
  adding: (world: World) => void,
  query = 'lumen',
  change: Partial<SemanticSearchInput> = {}
) {
  const world = semanticWorld();
  const open = addSource(world, 'public', 'one');
  const a = addEntity(world, 'project', 'Lumen', [open]);
  addEntity(world, 'project', 'Lumen Lumen Lumen', [open]);
  addEntity(world, 'project', 'Lumen archive of old orbis notes', [open]);
  commit(world, worksOn(ALEX, a.entityId, [open], { text: 'lumen is what Alex works on, with orbis' }));
  const input = search(query, change);
  const before = searchSemantic(world.db, world.contexts.group, input);
  assert.ok(before.hits.length > 0, 'the public query found nothing to protect');
  adding(world);
  assert.deepEqual(searchSemantic(world.db, world.contexts.group, input), before);
  assert.deepEqual(searchSemantic(world.db, world.contexts.mira, input), before);
  world.handle.close();
}

test('private documents that repeat the query word leave the public answer, order and total unchanged', () => {
  // Bug: corpus-global term statistics let hidden rows reorder a public result.
  assertPublicAnswerSurvives((world) => {
    const secret = addSource(world, 'alex', 'private');
    for (let index = 0; index < 30; index += 1)
      addEntity(world, 'project', `Lumen lumen ${index}`, [secret], world.contexts.alex);
    assert.ok(searchSemantic(world.db, world.contexts.internal, search('lumen', { limit: 100 })).hits.length > 30);
  });
});

test('private documents with the other query word leave a two-word answer unchanged', () => {
  // Bug: a hidden row changes which term counts as rare in a multi-word query.
  assertPublicAnswerSurvives((world) => {
    const secret = addSource(world, 'alex', 'private');
    for (let index = 0; index < 30; index += 1)
      addEntity(world, 'project', `Orbis ${index}`, [secret], world.contexts.alex);
  }, 'lumen orbis');
});

test('private aliases on public entities leave the public answer unchanged', () => {
  // Bug: alias popularity counts rows the context may not read.
  assertPublicAnswerSurvives((world) => {
    const secret = addSource(world, 'alex', 'private');
    const first = world.db.prepare('SELECT id FROM semantic_entities ORDER BY rowid LIMIT 1').get();
    for (let index = 0; index < 10; index += 1) {
      commit(
        world,
        candidate(
          'entity.label',
          'label',
          [
            { role: 'entity', position: 0, ref: { kind: 'entity', id: String(first?.id) } },
            { role: 'alias', position: 0, literal: `lumen nickname ${index}` },
            { role: 'language', position: 0, literal: 'en' },
          ],
          [secret]
        ),
        world.contexts.alex
      );
    }
  });
});

test('many private incident edges on one public entity leave the public answer unchanged', () => {
  // Bug: degree counts hidden assertions, and a hub rises in public because of what was said in private.
  assertPublicAnswerSurvives((world) => {
    const secret = addSource(world, 'alex', 'private');
    const lumen = world.db.prepare('SELECT id FROM semantic_entities ORDER BY rowid DESC LIMIT 1').get();
    for (let index = 0; index < 20; index += 1) {
      commit(world, worksOn(MIRA, String(lumen?.id), [secret], { text: `private edge ${index}` }), world.contexts.alex);
    }
  });
});

test('a private document never crowds a public one out of a small candidate cut', () => {
  // Bug: candidates are cut before the audience filter, and a group finds nothing at all.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'one');
  const secret = addSource(world, 'alex', 'two');
  for (let index = 0; index < 40; index += 1)
    addEntity(world, 'project', `Lumen Lumen Lumen ${index}`, [secret], world.contexts.alex);
  const pub = addEntity(world, 'project', 'A long public name that says lumen once among many other words', [open]);
  assert.deepEqual(versions(world, world.contexts.group, search('lumen', { limit: 1 })), [pub.versionId]);
  world.handle.close();
});

test('each private reader finds their own document and not the other partner', () => {
  // Bug: a search filters public from private and stops there, so every DM reads every DM.
  const world = semanticWorld();
  const alex = addEntity(world, 'project', 'Moth one', [addSource(world, 'alex', 'a')], world.contexts.alex);
  const mira = addEntity(world, 'project', 'Moth two', [addSource(world, 'mira', 'b')], world.contexts.mira);
  assert.deepEqual(versions(world, world.contexts.alex, search('moth')), [alex.versionId]);
  assert.deepEqual(versions(world, world.contexts.mira, search('moth')), [mira.versionId]);
  assert.deepEqual(versions(world, world.contexts.group, search('moth')), []);
  assert.deepEqual(versions(world, world.contexts.groups, search('moth')), []);
  assert.equal(versions(world, world.contexts.internal, search('moth')).length, 2);
  world.handle.close();
});

test('an internal-audience document is findable only internally', () => {
  // Bug: a fact from two different DMs reaches an outward context by its text.
  const world = semanticWorld();
  const a = addSource(world, 'alex', 'a');
  const b = addSource(world, 'mira', 'b');
  const { entityId } = addEntity(world, 'project', 'Lumen', [addSource(world, 'public', 'one')]);
  const fact = written(
    commit(world, worksOn(ALEX, entityId, [a, b], { text: 'xylophone across two chats' }), world.contexts.internal)
  );
  assert.deepEqual(versions(world, world.contexts.internal, search('xylophone')), [fact.versionId]);
  assert.deepEqual(versions(world, world.contexts.alex, search('xylophone')), []);
  assert.deepEqual(versions(world, world.contexts.group, search('xylophone')), []);
  world.handle.close();
});

// ---- vectors ---------------------------------------------------------------------------------------------------------

function embedded() {
  const world = semanticWorld();
  const open = addSource(world, 'public', 'one');
  const secret = addSource(world, 'alex', 'two');
  const pub = addEntity(world, 'project', 'Lumen', [open]);
  const hidden = addEntity(world, 'project', 'Moth', [secret], world.contexts.alex);
  const pending = pendingSemanticEmbeddings(world.db, { model: MODEL, limit: 10 });
  const keyOf = (versionId: string): string => {
    const found = pending.find((one) => one.versionId === versionId);
    assert.ok(found, `no pending embedding for ${versionId}`);
    return found.documentKey;
  };
  return { world, pub, hidden, pending, keyOf };
}

test('a missing embedding leaves lexical results whole', () => {
  // Bug: a document with no vector drops out of a search that holds a query vector.
  const { world, pub } = embedded();
  const found = searchSemantic(world.db, world.contexts.group, search('lumen', { vector: axis(0), model: MODEL }));
  assert.deepEqual(
    found.hits.map((hit) => hit.versionId),
    [pub.versionId]
  );
  assert.deepEqual(found.hits[0]?.streams, ['lexical']);
  world.handle.close();
});

test('an embedded document is found by meaning with no shared word', () => {
  // Bug: the vector stream is never read for semantic documents.
  const { world, pub, keyOf } = embedded();
  embed(world, keyOf(pub.versionId), axis(0));
  const found = searchSemantic(world.db, world.contexts.group, search('zzzz', { vector: axis(0), model: MODEL }));
  assert.deepEqual(
    found.hits.map((hit) => [hit.versionId, hit.streams]),
    [[pub.versionId, ['vector']]]
  );
  assert.equal(typeof found.hits[0]?.similarity, 'number');
  world.handle.close();
});

test('a private vector nearest to the query never appears and never displaces a public one', () => {
  // Bug: ANN takes the top N across audiences, then filters, and a group gets nothing.
  const { world, pub, hidden, keyOf } = embedded();
  embed(world, keyOf(pub.versionId), [0.6, 0.8, 0, 0]);
  embed(world, keyOf(hidden.versionId), axis(0));
  const input = search('zzzz', { vector: axis(0), model: MODEL, limit: 1 });
  assert.deepEqual(versions(world, world.contexts.internal, input), [hidden.versionId]);
  assert.deepEqual(versions(world, world.contexts.group, input), [pub.versionId]);
  assert.deepEqual(versions(world, world.contexts.mira, input), [pub.versionId]);
  world.handle.close();
});

test('a vector of another model or dimension is not compared', () => {
  // Bug: a model change makes cosine meaningless, yet its scores rank the turn's memory.
  const { world, pub, keyOf } = embedded();
  embed(world, keyOf(pub.versionId), axis(0));
  assert.deepEqual(
    versions(world, world.contexts.group, search('zzzz', { vector: axis(0), model: 'other/model' })),
    []
  );
  assert.deepEqual(versions(world, world.contexts.group, search('zzzz', { vector: axis(0, 8), model: MODEL })), []);
  world.handle.close();
});

test('a version with the same text, model and dimensions reuses its embedding', () => {
  // Bug: each confirmation pays for a new embedding of unchanged words.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const first = written(commit(world, worksOn(ALEX, entityId, [source], { text: 'unchanged words' })));
  for (const one of pendingSemanticEmbeddings(world.db, { model: MODEL, limit: 10 }))
    embed(world, one.documentKey, axis(1));
  const second = written(
    commit(world, worksOn(ALEX, entityId, [source], { ...successor(first), text: 'unchanged words' }))
  );
  assert.deepEqual(
    pendingSemanticEmbeddings(world.db, { model: MODEL, limit: 10 }).filter(
      (one) => one.versionId === second.versionId
    ),
    []
  );
  assert.ok(
    versions(world, world.contexts.group, search('zzzz', { vector: axis(1), model: MODEL })).includes(second.versionId)
  );
  world.handle.close();
});

test('a semantic vector key cannot collide with a source chunk key', () => {
  // Bug: an equal chunk key overwrites a source's vector, and plain recall loses a line.
  const { world, pub, keyOf } = embedded();
  world.db
    .prepare('INSERT INTO vectors (item_id, chunk_key, model, dims, bytes) VALUES (?, ?, ?, 4, ?)')
    .run('src:1', pub.versionId, MODEL, new Uint8Array(16));
  embed(world, keyOf(pub.versionId), axis(0));
  const row = world.db.prepare('SELECT item_id FROM vectors WHERE chunk_key = ?').get(pub.versionId);
  assert.equal(row?.item_id, 'src:1');
  assert.doesNotMatch(keyOf(pub.versionId), /^src:/);
  world.handle.close();
});

test('the pending list is bounded and asks for no model', () => {
  // Bug: a backlog embeds the whole corpus in one writer turn.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  for (let index = 0; index < 5; index += 1) addEntity(world, 'project', `Lumen ${index}`, [source]);
  assert.equal(pendingSemanticEmbeddings(world.db, { model: MODEL, limit: 2 }).length, 2);
  world.handle.close();
});

// ---- cache keys ------------------------------------------------------------------------------------------------------

const CHANGES: ReadonlyArray<
  [
    string,
    (
      world: World,
      fixture: { entityId: string; other: string; source: string; fact: { claimId: string; versionId: string } }
    ) => void,
  ]
> = [
  [
    'a new label',
    (world, { entityId, source }) => {
      commit(
        world,
        candidate(
          'entity.label',
          'label',
          [
            { role: 'entity', position: 0, ref: { kind: 'entity', id: entityId } },
            { role: 'alias', position: 0, literal: 'moth' },
            { role: 'language', position: 0, literal: 'en' },
          ],
          [source]
        )
      );
    },
  ],
  [
    'a merge',
    (world, { entityId, other, source }) => {
      commit(world, sameAs(entityId, other, [source]));
    },
  ],
  [
    'a retirement',
    (world, { entityId, source, fact }) => {
      commit(world, worksOn(ALEX, entityId, [source], successor(fact, { state: 'retired' })));
    },
  ],
  [
    'new conflicting evidence',
    (world, { entityId, source, fact }) => {
      commit(
        world,
        worksOn(ALEX, entityId, [source], successor(fact, { evidence: [{ sourceId: source, role: 'conflicts' }] }))
      );
    },
  ],
  [
    'a revoked account link',
    (world) => {
      applyMemoryWrite(world.handle, { kind: 'person-link', op: 'unbind', accountId: ALEX_ACCOUNT, now: world.now() });
    },
  ],
];

for (const [name, change] of CHANGES) {
  test(`a cached result stops being reused after ${name}`, () => {
    // Bug: a cached answer keeps a retired fact, an old name or a revoked person's private facts.
    const world = semanticWorld();
    const source = addSource(world, 'public', 'one');
    const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
    const { entityId: other } = addEntity(world, 'project', 'Orbis', [source]);
    const fact = written(commit(world, worksOn(ALEX, entityId, [source])));
    const query = search('lumen');
    const before = semanticCacheKey(world.db, world.contexts.alex, query);
    assert.equal(semanticCacheKey(world.db, world.contexts.alex, query), before);
    change(world, { entityId, other, source, fact });
    assert.notEqual(semanticCacheKey(world.db, world.contexts.alex, query), before);
    world.handle.close();
  });
}

test('a private answer and a public answer never share a cache key', () => {
  // Bug: a private result seeds a public cache entry.
  const world = semanticWorld();
  const query = search('lumen');
  const keys = [world.contexts.group, world.contexts.alex, world.contexts.mira, world.contexts.internal].map((ctx) =>
    semanticCacheKey(world.db, ctx, query)
  );
  assert.equal(new Set(keys).size, keys.length);
  world.handle.close();
});

test('another query or budget makes another key', () => {
  // Bug: a small page is served for a larger one.
  const world = semanticWorld();
  const base = semanticCacheKey(world.db, world.contexts.group, search('lumen'));
  assert.notEqual(semanticCacheKey(world.db, world.contexts.group, search('orbis')), base);
  assert.notEqual(semanticCacheKey(world.db, world.contexts.group, search('lumen', { limit: 3 })), base);
  world.handle.close();
});

// ---- the older stream ------------------------------------------------------------------------------------------------

test('a semantic document leaves the source search tables untouched', () => {
  // Bug: a semantic document lands in `sources`, so plain recall returns her notes as chat lines.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'plain words');
  const before = world.db.prepare('SELECT COUNT(*) AS n FROM sources').get()?.n;
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  commit(world, property(entityId, 'prototype', [source]));
  assert.equal(world.db.prepare('SELECT COUNT(*) AS n FROM sources').get()?.n, before);
  assert.equal(world.db.prepare("SELECT COUNT(*) AS n FROM sources_fts WHERE sources_fts MATCH 'lumen'").get()?.n, 0);
  world.handle.close();
});
