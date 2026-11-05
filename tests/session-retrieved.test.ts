// The `<retrieved>` block of a memory session: what it shows gets a handle and a read, and what it does not show gets
// neither. Real temporary database, synthetic content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrievedLines } from '../src/memory/db/session-retrieved.ts';
import type { MemoryPage } from '../src/memory/db/semantic-types.ts';
import { ALEX, addEntity, addSource, semanticWorld } from './fixtures/memory-db/semantic-world.ts';

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
