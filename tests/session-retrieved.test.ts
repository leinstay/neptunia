// The `<retrieved>` block of a memory session: what it shows gets a handle and a read, and what it does not show gets
// neither. Real temporary database, synthetic content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingSemanticEmbeddings } from '../src/memory/db/semantic-search.ts';
import { readRetrieved, retrievedLines } from '../src/memory/db/session-retrieved.ts';
import type { MemoryPage } from '../src/memory/db/semantic-types.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import type { Config } from '../src/memory/db/types.ts';
import { ALEX, ROOM, START, addEntity, addSource, semanticWorld } from './fixtures/memory-db/semantic-world.ts';

function render(world: ReturnType<typeof semanticWorld>, ctx: typeof world.contexts.group, retrieved: MemoryPage) {
  const out = {
    sources: new Map<string, string>(),
    versions: new Map<string, string>(),
    entities: new Map<string, string>(),
    reads: [] as Array<[string, unknown]>,
  };
  const { lines, lineNumber } = retrievedLines({
    db: world.db,
    ctx,
    retrieved,
    cutoffIso: '2030-01-01T00:00:00.000Z',
    lineNumber: 5,
    sources: out.sources,
    versions: out.versions,
    entities: out.entities,
    read: (kind, id) => out.reads.push([kind, id]),
    timeOf: () => 'time',
  });
  return { ...out, lines, lineNumber };
}
const pageOf = (entityId: string, versionId: string, sourceId: string): MemoryPage => ({
  assertions: [
    {
      claimId: 'clm:1',
      versionId,
      text: 'Lumen shipped',
      polarity: 'negative',
      state: 'current',
      arguments: [{ role: 'project', position: 0, ref: { kind: 'entity', id: entityId } }],
      evidence: [{ sourceId, role: 'supports' }],
      dependencies: [],
      needsReview: false,
    },
  ],
  sourceIds: [],
  paths: [],
  next: null,
  partialReason: null,
  ambiguous: [],
  signals: [],
});

test('a fact, its entity and its line get handles, numbered on past the batch', () => {
  // Bug: a retrieved line takes a batch number, so a citation lands on another line.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'an old line');
  const { entityId, versionId } = addEntity(world, 'project', 'Lumen', [source]);
  const out = render(world, world.contexts.group, pageOf(entityId, versionId, source));
  assert.equal(out.versions.get('v1'), versionId);
  assert.equal(out.entities.get('x1'), entityId);
  assert.equal(out.sources.get('#6'), source);
  assert.equal(out.lineNumber, 6);
  assert.deepEqual(out.lines, ['[x1] Lumen', '[v1] (current, not so) Lumen shipped {x1}', '#6 [time] an old line']);
  assert.ok(out.reads.some(([kind, id]) => kind === 'source_id' && id === source));
  world.handle.close();
});

test('a line this context may not read gets no number and no read', () => {
  // Bug: a displayed claim licenses a citation of a private line the batch's audience never saw.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'open');
  const hidden = addSource(world, 'alex', 'between us');
  const { entityId, versionId } = addEntity(world, 'project', 'Lumen', [open]);
  const out = render(world, world.contexts.group, pageOf(entityId, versionId, hidden));
  assert.deepEqual([...out.sources.values()], []);
  assert.ok(!out.reads.some(([, id]) => id === hidden));
  assert.ok(!out.lines.join('\n').includes('between us'));
  assert.ok(ALEX);
  world.handle.close();
});

// ---- the batch's embedding -----------------------------------------------------------------------------------------

const EMBEDDER = 'test/embedder';
const SESSION_CONFIG = {
  memoryDb: {
    retrieval: {
      seeds: 4,
      hops: 2,
      nodes: 20,
      edges: 60,
      assertions: 12,
      evidence: 24,
      tokens: 2000,
      deadlineMs: 1000,
    },
  },
  recall: { prefetch: { deadlineMs: 1000, maxTokens: 2000 }, db: { minMeaning: 0.35 } },
} as unknown as Config;

test("a session batch embeds its query once and finds a fact in another language by the fact's vector", async () => {
  // Bug: the session reads its batch by words alone, so a fact stored in one language never meets lines in another.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'an old line');
  const { versionId } = addEntity(world, 'project', 'Lumen', [source]);
  for (const pending of pendingSemanticEmbeddings(world.db, { model: EMBEDDER, limit: 10 }))
    applyMemoryWrite(world.handle, {
      kind: 'semantic-embedding',
      documentKey: pending.documentKey,
      model: EMBEDDER,
      vector: [1, 0, 0],
      now: START,
    });
  const asked: Array<string> = [];
  const read = (embedQuery: ((text: string) => Promise<ArrayLike<number> | null>) | null) =>
    readRetrieved({
      db: world.db,
      ctx: world.contexts.group,
      config: SESSION_CONFIG,
      // The batch is read as of its newest line, an hour after the fact was stored.
      batch: [{ text: 'Το νέο έργο κυκλοφόρησε σήμερα', at: START + 3_600_000, place_id: ROOM }],
      people: [],
      now: () => START,
      embedQuery,
      model: EMBEDDER,
    });
  const words = await read(null);
  assert.ok(!(words?.assertions ?? []).some((one) => one.versionId === versionId), 'the words alone find it');
  const meant = await read((text) => {
    asked.push(text);
    return Promise.resolve([1, 0, 0]);
  });
  assert.ok(
    (meant?.assertions ?? []).some((one) => one.versionId === versionId),
    'the vector finds the fact'
  );
  assert.equal(asked.length, 1);
  world.handle.close();
});
