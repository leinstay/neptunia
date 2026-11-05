// Reading names, equivalence and descriptions of semantic entities, stage S4. A context sees a label or a merge only
// through a version it may read, at the recording cutoff it asks for, and the two projection tables are never a fact of
// their own. Each adversarial test first proves through the internal context that the private row exists, so an empty
// answer means refused and never means unwritten. Synthetic content only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import {
  assertionsAwaitingReview,
  canonicalEntity,
  entityDescriptions,
  entityLabels,
  rebuildSemanticProjections,
  resolveLabel,
  semanticProjectionMismatches,
} from '../src/memory/db/semantic-read.ts';
import { groupScope, dmScope } from '../src/memory/db/scope.ts';
import { wrongly } from './fixtures/loose-types.ts';
import {
  ALEX,
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

const resolved = (result: object): { claimId: string; versionId: string } =>
  result as { claimId: string; versionId: string };
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
  // Bug: a public count, a label list or a canonical read confirms that the hidden entity exists.
  const world = semanticWorld();
  const secret = addSource(world, 'alex', 'a private project');
  const hidden = addEntity(world, 'project', 'Hidden', [secret], world.contexts.alex);
  assert.equal(entityLabels(world.db, world.contexts.internal, hidden.entityId, { recordedBefore: null }).length, 1);
  assert.deepEqual(entityLabels(world.db, world.contexts.group, hidden.entityId, { recordedBefore: null }), []);
  assert.equal(canonicalEntity(world.db, world.contexts.group, hidden.entityId, { recordedBefore: null }), null);
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

test('a rebuild derives the same label and merge rows from the versions', () => {
  // Bug: the projection holds something the authority does not, so a rebuild loses a name.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const a = addEntity(world, 'project', 'Lumen', [source]);
  const b = addEntity(world, 'project', 'Lumen Two', [source]);
  commit(world, sameAs(a.entityId, b.entityId, [source]));
  const read = () => [
    world.db.prepare('SELECT * FROM semantic_labels ORDER BY version_id, text').all(),
    world.db.prepare('SELECT * FROM semantic_entity_merges ORDER BY version_id').all(),
  ];
  const before = JSON.stringify(read());
  world.db.exec('DELETE FROM semantic_labels; DELETE FROM semantic_entity_merges;');
  rebuildSemanticProjections(world.handle);
  assert.equal(JSON.stringify(read()), before);
  world.handle.close();
});

test('a label row that disagrees with its version is reported and a rebuild corrects it', () => {
  // Bug: an edited cache becomes a fact and a name no assertion carries resolves.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const lumen = addEntity(world, 'project', 'Lumen', [source]);
  assert.deepEqual(semanticProjectionMismatches(world.db), []);
  world.db
    .prepare("UPDATE semantic_labels SET text = 'Forged', normalized = 'forged' WHERE version_id = ?")
    .run(lumen.versionId);
  assert.deepEqual(semanticProjectionMismatches(world.db), [{ table: 'semantic_labels', versionId: lumen.versionId }]);
  assert.equal(resolveLabel(world.db, world.contexts.group, ask('Forged')).status, 'none');
  rebuildSemanticProjections(world.handle);
  assert.deepEqual(semanticProjectionMismatches(world.db), []);
  assert.equal(resolveLabel(world.db, world.contexts.group, ask('Lumen')).status, 'unique');
  world.handle.close();
});

test('a merge row that names another entity than its version is reported', () => {
  // Bug: a shared version key alone passes for proof, and a forged merge joins two people's projects.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const a = addEntity(world, 'project', 'A', [source]);
  const b = addEntity(world, 'project', 'B', [source]);
  const c = addEntity(world, 'project', 'C', [source]);
  const merge = resolved(commit(world, sameAs(a.entityId, b.entityId, [source])));
  world.db
    .prepare('UPDATE semantic_entity_merges SET into_entity_id = ? WHERE version_id = ?')
    .run(c.entityId, merge.versionId);
  assert.deepEqual(semanticProjectionMismatches(world.db), [
    { table: 'semantic_entity_merges', versionId: merge.versionId },
  ]);
  world.handle.close();
});

// ---- equivalence -----------------------------------------------------------------------------------------------------

test('a visible equivalence resolves both ids to one and keeps the original ids and references', () => {
  // Bug: a merge rewrites stored references and an unmerge can no longer restore them.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const a = addEntity(world, 'project', 'Lumen', [source]);
  const b = addEntity(world, 'project', 'Lumen Two', [source]);
  const fact = resolved(commit(world, worksOn(ALEX, a.entityId, [source])));
  commit(world, sameAs(a.entityId, b.entityId, [source]));
  assert.equal(canonicalEntity(world.db, world.contexts.group, a.entityId, { recordedBefore: null }), b.entityId);
  const stored = world.db
    .prepare("SELECT ref_id FROM semantic_arguments WHERE version_id = ? AND role = 'project'")
    .get(fact.versionId);
  assert.equal(stored?.ref_id, a.entityId);
  assert.equal(world.db.prepare('SELECT COUNT(*) AS n FROM semantic_entities WHERE id = ?').get(a.entityId)?.n, 1);
  world.handle.close();
});

test('a private equivalence changes nothing a group reads', () => {
  // Bug: public deduplication, names and counts move because of what one partner said privately.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'one');
  const secret = addSource(world, 'alex', 'they are the same thing');
  const a = addEntity(world, 'project', 'Lumen', [open]);
  const b = addEntity(world, 'project', 'Moth', [open]);
  commit(world, sameAs(a.entityId, b.entityId, [secret]), world.contexts.alex);
  assert.equal(canonicalEntity(world.db, world.contexts.alex, a.entityId, { recordedBefore: null }), b.entityId);
  assert.equal(canonicalEntity(world.db, world.contexts.group, a.entityId, { recordedBefore: null }), a.entityId);
  assert.equal(canonicalEntity(world.db, world.contexts.mira, a.entityId, { recordedBefore: null }), a.entityId);
  assert.equal(resolveLabel(world.db, world.contexts.group, ask('Lumen')).candidates[0]?.ref.id, a.entityId);
  world.handle.close();
});

test('a reversal appends history, and each cutoff reads the state of its own moment', () => {
  // Bug: the reader consults a global parent status, so an old view shows today's identity.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const a = addEntity(world, 'project', 'A', [source]);
  const b = addEntity(world, 'project', 'B', [source]);
  const merge = resolved(commit(world, sameAs(a.entityId, b.entityId, [source])));
  const during = new Date(Date.parse(recordedAt(world, merge.versionId)) + 500).toISOString();
  const reversal = resolved(
    commit(world, sameAs(a.entityId, b.entityId, [source], successor(merge, { state: 'retired' })))
  );
  assert.notEqual(reversal.versionId, merge.versionId);
  assert.equal(canonicalEntity(world.db, world.contexts.group, a.entityId, { recordedBefore: null }), a.entityId);
  assert.equal(canonicalEntity(world.db, world.contexts.group, a.entityId, { recordedBefore: during }), b.entityId);
  assert.equal(
    world.db.prepare('SELECT truth_state FROM semantic_assertion_versions WHERE version_id = ?').get(merge.versionId)
      ?.truth_state,
    'current'
  );
  world.handle.close();
});

test('a private contradiction cannot retire a public equivalence', () => {
  // Bug: a DM retirement moves the public claim, so one partner's word changes everyone's view.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'one');
  const secret = addSource(world, 'alex', 'they are not the same');
  const a = addEntity(world, 'project', 'A', [open]);
  const b = addEntity(world, 'project', 'B', [open]);
  const merge = resolved(commit(world, sameAs(a.entityId, b.entityId, [open])));
  const fork = resolved(
    commit(world, sameAs(a.entityId, b.entityId, [secret], successor(merge, { state: 'retired' })), world.contexts.alex)
  );
  assert.notEqual(fork.claimId, merge.claimId);
  assert.equal(canonicalEntity(world.db, world.contexts.group, a.entityId, { recordedBefore: null }), b.entityId);
  assert.equal(canonicalEntity(world.db, world.contexts.mira, a.entityId, { recordedBefore: null }), b.entityId);
  world.handle.close();
});

test('a chain of visible equivalences resolves to its end', () => {
  // Bug: the reader follows one step, and a fact about the first id misses the survivor.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const a = addEntity(world, 'project', 'A', [source]);
  const b = addEntity(world, 'project', 'B', [source]);
  const c = addEntity(world, 'project', 'C', [source]);
  commit(world, sameAs(a.entityId, b.entityId, [source]));
  commit(world, sameAs(b.entityId, c.entityId, [source]));
  assert.equal(canonicalEntity(world.db, world.contexts.group, a.entityId, { recordedBefore: null }), c.entityId);
  world.handle.close();
});

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

function inferred(world: World) {
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const premise = resolved(commit(world, worksOn(ALEX, entityId, [source])));
  const conclusion = resolved(
    commit(
      world,
      worksOn(MIRA, entityId, [source], {
        how: 'inferred',
        dependencies: [{ versionId: premise.versionId, role: 'supports' }],
      })
    )
  );
  return { source, entityId, premise, conclusion };
}

test('nothing awaits review while every premise is current', () => {
  // Bug: every inferred fact is permanently flagged and the list is noise.
  const world = semanticWorld();
  inferred(world);
  assert.deepEqual(assertionsAwaitingReview(world.db, world.contexts.group, { limit: 10 }), []);
  world.handle.close();
});

test('a changed premise surfaces the dependent with its exact path and leaves its truth alone', () => {
  // Bug: code rewrites a conclusion's truth, a decision that belongs to the persona's memory writer.
  const world = semanticWorld();
  const { source, entityId, premise, conclusion } = inferred(world);
  const replaced = resolved(commit(world, worksOn(ALEX, entityId, [source], successor(premise, { state: 'retired' }))));
  const before = {
    ...world.db.prepare('SELECT * FROM semantic_assertion_versions WHERE version_id = ?').get(conclusion.versionId),
  };
  const review = assertionsAwaitingReview(world.db, world.contexts.group, { limit: 10 });
  assert.deepEqual(review, [
    {
      claimId: conclusion.claimId,
      versionId: conclusion.versionId,
      premiseVersionId: premise.versionId,
      changedByVersionId: replaced.versionId,
      path: [conclusion.versionId, premise.versionId],
    },
  ]);
  assert.deepEqual(
    { ...world.db.prepare('SELECT * FROM semantic_assertion_versions WHERE version_id = ?').get(conclusion.versionId) },
    before
  );
  world.handle.close();
});

test('a dependent whose premise changed two levels down still surfaces with the whole path', () => {
  // Bug: only direct dependents are flagged and a chain of inference keeps a dead premise.
  const world = semanticWorld();
  const { source, entityId, premise, conclusion } = inferred(world);
  const third = resolved(
    commit(
      world,
      worksOn(ALEX, entityId, [source], {
        how: 'inferred',
        dependencies: [{ versionId: conclusion.versionId, role: 'supports' }],
      })
    )
  );
  commit(world, worksOn(ALEX, entityId, [source], successor(premise, { state: 'retired' })));
  const found = assertionsAwaitingReview(world.db, world.contexts.group, { limit: 10 }).find(
    (one) => one.versionId === third.versionId
  );
  assert.deepEqual(found?.path, [third.versionId, conclusion.versionId, premise.versionId]);
  world.handle.close();
});

test('a group is not told that a private dependent awaits review', () => {
  // Bug: the review list shows that a hidden conclusion rests on a public fact.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'one');
  const secret = addSource(world, 'alex', 'between us');
  const { entityId } = addEntity(world, 'project', 'Lumen', [open]);
  const premise = resolved(commit(world, worksOn(ALEX, entityId, [open])));
  const hidden = resolved(
    commit(
      world,
      worksOn(MIRA, entityId, [secret], {
        how: 'inferred',
        dependencies: [{ versionId: premise.versionId, role: 'supports' }],
      }),
      world.contexts.alex
    )
  );
  commit(world, worksOn(ALEX, entityId, [open], successor(premise, { state: 'retired' })));
  assert.deepEqual(
    assertionsAwaitingReview(world.db, world.contexts.alex, { limit: 10 }).map((one) => one.versionId),
    [hidden.versionId]
  );
  assert.deepEqual(assertionsAwaitingReview(world.db, world.contexts.group, { limit: 10 }), []);
  assert.deepEqual(assertionsAwaitingReview(world.db, world.contexts.mira, { limit: 10 }), []);
  world.handle.close();
});

test('the review list is bounded by its limit', () => {
  // Bug: a popular premise makes the list as large as the whole dependency graph.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'one');
  const { entityId } = addEntity(world, 'project', 'Lumen', [source]);
  const premise = resolved(commit(world, worksOn(ALEX, entityId, [source])));
  for (let index = 0; index < 4; index += 1) {
    commit(
      world,
      worksOn(MIRA, entityId, [source], {
        how: 'inferred',
        dependencies: [{ versionId: premise.versionId, role: 'supports' }],
      })
    );
  }
  commit(world, worksOn(ALEX, entityId, [source], successor(premise, { state: 'retired' })));
  assert.equal(assertionsAwaitingReview(world.db, world.contexts.group, { limit: 2 }).length, 2);
  world.handle.close();
});
