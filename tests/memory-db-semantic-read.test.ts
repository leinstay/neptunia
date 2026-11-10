// Reading names, equivalence and descriptions of semantic entities, stage S4. A context sees a label or a merge only
// through a version it may read, at the recording cutoff it asks for, and the two projection tables are never a fact of
// their own. Each adversarial test first proves through the internal context that the private row exists, so an empty
// answer means refused and never means unwritten. Synthetic content only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { entityDescriptions, entityLabels, resolveLabel } from '../src/memory/db/semantic-read.ts';
import { groupScope, dmScope } from '../src/memory/db/scope.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { ALEX, addEntity, addSource, candidate, commit, semanticWorld } from './fixtures/memory-db/semantic-world.ts';
import type { World } from './fixtures/memory-db/semantic-world.ts';

const alias = (entityId: string, text: string, sources: Array<string>, language = 'en') =>
  candidate(
    'entity.label',
    'label',
    [
      { role: 'entity', position: 0, ref: { kind: 'entity', id: entityId } },
      { role: 'alias', position: 0, literal: text },
      { role: 'language', position: 0, literal: language },
    ],
    sources
  );
const recordedAt = (world: World, versionId: string): string =>
  String(world.db.prepare('SELECT recorded_at FROM claim_versions WHERE id = ?').get(versionId)?.recorded_at);
const ids = (result: ReturnType<typeof resolveLabel>): Array<string> =>
  result.candidates.map((one) => one.ref.id).sort();
const ask = (text: string, recordedBefore: string | null = null) => ({ text, language: null, recordedBefore });

// ---- labels ----------------------------------------------------------------------------------------------------------

test('a name nobody stored resolves to nothing', () => {
  // Bug: the reader creates a provisional entity for a name it merely read.
  const world = semanticWorld();
  assert.deepEqual(resolveLabel(world.db, world.contexts.group, ask('Lumen')), { status: 'none', candidates: [] });
  assert.equal(world.db.prepare('SELECT COUNT(*) AS n FROM semantic_entities').get()?.n, 0);
  world.handle.close();
});

test('one visible entity of a name resolves as unique with the version that names it', () => {
  // Bug: a resolved name cannot be traced back to the assertion and audience that justify it.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'we call it Lumen');
  const lumen = addEntity(world, 'project', 'Lumen', [source]);
  const result = resolveLabel(world.db, world.contexts.group, ask('lumen'));
  assert.equal(result.status, 'unique');
  assert.deepEqual(result.candidates, [
    { ref: { kind: 'entity', id: lumen.entityId }, label: 'Lumen', versionId: lumen.versionId },
  ]);
  world.handle.close();
});

test('two projects of one name come back ambiguous and stay two entities', () => {
  // Bug: the popular or the older project is picked, and a fact goes to the wrong one.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'two projects');
  const first = addEntity(world, 'project', 'Lumen', [source]);
  const second = addEntity(world, 'project', 'Lumen', [source]);
  const result = resolveLabel(world.db, world.contexts.group, ask('Lumen'));
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(ids(result), [first.entityId, second.entityId].sort());
  assert.equal(world.db.prepare('SELECT COUNT(*) AS n FROM semantic_entity_merges').get()?.n, 0);
  world.handle.close();
});

test('a many-times-mentioned entity gains no preference over a rarely mentioned one', () => {
  // Bug: alias popularity selects the winner and a private mention count leaks through the choice.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'two projects');
  const busy = addEntity(world, 'project', 'Lumen', [source]);
  addEntity(world, 'project', 'Lumen', [source]);
  for (let index = 0; index < 5; index += 1) commit(world, alias(busy.entityId, 'Lumen', [source]));
  assert.equal(resolveLabel(world.db, world.contexts.group, ask('Lumen')).status, 'ambiguous');
  world.handle.close();
});

test('a private alias is absent from group suggestions and from their count', () => {
  // Bug: a nickname from a DM appears as a group suggestion, or its count reveals that one exists.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'we call it Lumen');
  const secret = addSource(world, 'alex', 'I call it Moth');
  const lumen = addEntity(world, 'project', 'Lumen', [open]);
  commit(world, alias(lumen.entityId, 'Moth', [secret]), world.contexts.alex);
  assert.equal(resolveLabel(world.db, world.contexts.internal, ask('Moth')).status, 'unique');
  assert.deepEqual(resolveLabel(world.db, world.contexts.group, ask('Moth')), { status: 'none', candidates: [] });
  assert.deepEqual(
    entityLabels(world.db, world.contexts.group, lumen.entityId, { recordedBefore: null }).map((one) => one.text),
    ['Lumen']
  );
  world.handle.close();
});

test('a private alias is absent for another DM partner and for the groups context', () => {
  // Bug: every DM context reads every private audience, or the diary's entry reads a DM.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'one');
  const secret = addSource(world, 'alex', 'I call it Moth');
  const lumen = addEntity(world, 'project', 'Lumen', [open]);
  commit(world, alias(lumen.entityId, 'Moth', [secret]), world.contexts.alex);
  assert.equal(resolveLabel(world.db, world.contexts.alex, ask('Moth')).status, 'unique');
  assert.equal(resolveLabel(world.db, world.contexts.mira, ask('Moth')).status, 'none');
  assert.equal(resolveLabel(world.db, world.contexts.groups, ask('Moth')).status, 'none');
  world.handle.close();
});

test('an entity named only in a DM is undiscoverable from a group by any reader', () => {
  // Bug: a public count or a label list confirms that the hidden entity exists.
  const world = semanticWorld();
  const secret = addSource(world, 'alex', 'a private project');
  const hidden = addEntity(world, 'project', 'Hidden', [secret], world.contexts.alex);
  assert.equal(entityLabels(world.db, world.contexts.internal, hidden.entityId, { recordedBefore: null }).length, 1);
  assert.deepEqual(entityLabels(world.db, world.contexts.group, hidden.entityId, { recordedBefore: null }), []);
  world.handle.close();
});

test('a read needs a context', () => {
  // Bug: a reader with no context falls open.
  const world = semanticWorld();
  assert.throws(() => resolveLabel(world.db, wrongly(null), ask('Lumen')), /context/);
  world.handle.close();
});

test('a label added after the cutoff is not read at that cutoff', () => {
  // Bug: a historical read resolves a name nobody had used yet.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const lumen = addEntity(world, 'project', 'Lumen', [source]);
  const cutoff = new Date(Date.parse(recordedAt(world, lumen.versionId)) + 500).toISOString();
  commit(world, alias(lumen.entityId, 'Moth', [source]));
  assert.equal(resolveLabel(world.db, world.contexts.group, ask('Moth')).status, 'unique');
  assert.equal(resolveLabel(world.db, world.contexts.group, ask('Moth', cutoff)).status, 'none');
  world.handle.close();
});

// ---- the projections -------------------------------------------------------------------------------------------------

// ---- equivalence -----------------------------------------------------------------------------------------------------

// ---- descriptions ----------------------------------------------------------------------------------------------------

function describe(
  world: World,
  entityId: string,
  id: string,
  text: string,
  scope: ReturnType<typeof groupScope>
): void {
  applyMemoryWrite(world.handle, {
    kind: 'description',
    mode: 'apply',
    row: { id: `dv:${id}`, descriptionId: `desc:${id}`, text, writtenAt: new Date(world.now()).toISOString() },
    subject: { kind: 'entity', id: entityId, field: 'purpose' },
    scope,
    expectCurrent: null,
    now: world.now(),
  });
}

test('an entity has one description per audience and a context reads only its own', () => {
  // Bug: an all-audience summary flattens a private fact into what a group is told.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const lumen = addEntity(world, 'project', 'Lumen', [source]);
  describe(world, lumen.entityId, 'public', 'an open project', groupScope('discord'));
  describe(world, lumen.entityId, 'private', 'Alex fears it will fail', dmScope(ALEX, 'discord'));
  const texts = (ctx: Parameters<typeof entityDescriptions>[1]) =>
    entityDescriptions(world.db, ctx, lumen.entityId).map((one) => one.text);
  assert.deepEqual(texts(world.contexts.internal).sort(), ['Alex fears it will fail', 'an open project']);
  assert.deepEqual(texts(world.contexts.group), ['an open project']);
  assert.deepEqual(texts(world.contexts.mira), ['an open project']);
  assert.deepEqual(texts(world.contexts.alex).sort(), ['Alex fears it will fail', 'an open project']);
  world.handle.close();
});

test('a description of an entity gets its versions from the existing machinery', () => {
  // Bug: entity descriptions grow a second store beside `descriptions` and `description_versions`.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const lumen = addEntity(world, 'project', 'Lumen', [source]);
  describe(world, lumen.entityId, 'public', 'an open project', groupScope('discord'));
  const [only] = entityDescriptions(world.db, world.contexts.group, lumen.entityId);
  assert.equal(only?.versionId, 'dv:public');
  assert.equal(
    world.db.prepare('SELECT current_version FROM descriptions WHERE subject_id = ?').get(lumen.entityId)
      ?.current_version,
    'dv:public'
  );
  world.handle.close();
});

// ---- review after a changed premise ----------------------------------------------------------------------------------
