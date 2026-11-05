// The owner's typed reader of semantic entities (src/memory/db/entities-read.ts), the reader behind `/memory entities list`,
// `show`, `names` and `relations`. It reads the S2 to S5 records the writer stored and never a second store: an entity is
// listed, opened and related only through a sealed version the context may read at its recording cutoff, a shared name
// lists every entity it fits, and a read writes nothing. Each adversarial test first proves through the internal context
// that the private record exists, so an empty answer means refused and never means unwritten. Plan
// 2026-11-04-cli-and-memory task 10 and S9.1. Synthetic content only.
//
// The signatures this file is typed against:
//   listEntities(db, { context, filters: { kind, name }, recordedBefore, limit, cursor }): Page<EntitySummary>
//   entityDetail(db, entityId, { context, recordedBefore }): EntityDetail
//   entityRelations(db, { context, entityId, predicates, mode, recordedBefore, limit, cursor }): Page<EntityRelation>
// A relation is one assertion version that names the entity in a reference argument, label versions left to `names`.
// `active` is the newest version of each claim the context selects at the cutoff, unless its state is `retired`.
// `historical` is every version that names the entity, in order of recording. An entity the context has no witness of is
// refused with the code `ENTITY_NOT_FOUND`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entityDetail, entityRelations, listEntities } from '../src/memory/db/entities-read.ts';
import type { EntityRelation, EntitySummary } from '../src/memory/db/entities-read.ts';
import type { Page } from '../src/memory/db/read-page.ts';
import type { Context } from '../src/memory/db/scope.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dmScope, groupScope } from '../src/memory/db/scope.ts';
import { databaseDigest } from './fixtures/memory-db/browser-world.ts';
import {
  ALEX,
  MIRA,
  addEntity,
  addSource,
  candidate,
  commit,
  occurrence,
  sameAs,
  semanticWorld,
  successor,
  worksOn,
} from './fixtures/memory-db/semantic-world.ts';
import type { World } from './fixtures/memory-db/semantic-world.ts';

const written = (result: object): { claimId: string; versionId: string } =>
  result as { claimId: string; versionId: string };
const alias = (entityId: string, text: string, sources: Array<string>) =>
  candidate(
    'entity.label',
    'label',
    [
      { role: 'entity', position: 0, ref: { kind: 'entity', id: entityId } },
      { role: 'alias', position: 0, literal: text },
      { role: 'language', position: 0, literal: 'en' },
    ],
    sources
  );
const recordedAt = (world: World, versionId: string): string =>
  String(world.db.prepare('SELECT recorded_at FROM claim_versions WHERE id = ?').get(versionId)?.recorded_at);
const NO_FILTERS = { kind: null, name: null };

function list(
  world: World,
  context: Context,
  change: Partial<Parameters<typeof listEntities>[1]> = {}
): Page<EntitySummary> {
  return listEntities(world.db, {
    context,
    filters: NO_FILTERS,
    recordedBefore: null,
    limit: 50,
    cursor: null,
    ...change,
  });
}

function relations(
  world: World,
  context: Context,
  entityId: string,
  change: Partial<Parameters<typeof entityRelations>[1]> = {}
): Page<EntityRelation> {
  return entityRelations(world.db, {
    context,
    entityId,
    predicates: null,
    mode: 'active',
    recordedBefore: null,
    limit: 50,
    cursor: null,
    ...change,
  });
}

const listed = (page: Page<EntitySummary>): Array<string> => page.items.map((item) => item.id);
const versionsOf = (page: Page<EntityRelation>): Array<string> => page.items.map((item) => item.versionId);

/** A public project, a project only Alex's DM knows, and a public event. */
function world3(): { world: World; open: string; secret: string; lumen: string; hidden: string; orbis: string } {
  const world = semanticWorld();
  const open = addSource(world, 'public', 'Alex works on Lumen, Orbis is next week');
  const secret = addSource(world, 'alex', 'a project of mine nobody knows about');
  const lumen = addEntity(world, 'project', 'Lumen', [open]).entityId;
  const hidden = addEntity(world, 'project', 'Hidden', [secret], world.contexts.alex).entityId;
  const orbis = addEntity(world, 'event', 'Orbis', [open]).entityId;
  return { world, open, secret, lumen, hidden, orbis };
}

// ---- list ------------------------------------------------------------------------------------------------------------

test('every entity is listed once across pages, in id order, with the total', () => {
  // Bug: a page boundary repeats or skips an entity, so the owner's inventory is not the stored set.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'five projects');
  const ids = ['Lumen', 'Orbis', 'Echo', 'Moth', 'Kite'].map(
    (name) => addEntity(world, 'project', name, [source]).entityId
  );
  const seen: Array<string> = [];
  let page = list(world, world.contexts.internal, { limit: 2 });
  seen.push(...listed(page));
  while (page.next !== null) {
    page = list(world, world.contexts.internal, { limit: 2, cursor: page.next });
    seen.push(...listed(page));
  }
  assert.deepEqual(seen, [...ids].sort());
  assert.equal(page.total, 5);
  world.handle.close();
});

test('a summary carries the entity kind and the names in force', () => {
  const world = semanticWorld();
  const source = addSource(world, 'public', 'Lumen');
  const lumen = addEntity(world, 'project', 'Lumen', [source]);
  const [item] = list(world, world.contexts.internal).items;
  assert.equal(item?.id, lumen.entityId);
  assert.equal(item?.kind, 'project');
  assert.equal(item?.kindVersion, 1);
  assert.deepEqual(
    item?.names.map((one) => [one.text, one.role, one.versionId]),
    [['Lumen', 'name', lumen.versionId]]
  );
  world.handle.close();
});

test('an entity known only in a DM is absent from a group list and from its total', () => {
  // Bug: the list counts every row of semantic_entities, so a group learns a private project exists.
  const { world, lumen, hidden, orbis } = world3();
  assert.deepEqual(listed(list(world, world.contexts.internal)).sort(), [lumen, hidden, orbis].sort());
  const group = list(world, world.contexts.group);
  assert.deepEqual(listed(group).sort(), [lumen, orbis].sort());
  assert.equal(group.total, 2);
  assert.deepEqual(listed(list(world, world.contexts.mira)).sort(), [lumen, orbis].sort());
  assert.ok(listed(list(world, world.contexts.alex)).includes(hidden));
  world.handle.close();
});

test('the kind filter lists only that kind', () => {
  const { world, lumen, hidden, orbis } = world3();
  assert.deepEqual(
    listed(list(world, world.contexts.internal, { filters: { kind: 'project', name: null } })).sort(),
    [lumen, hidden].sort()
  );
  assert.deepEqual(listed(list(world, world.contexts.internal, { filters: { kind: 'event', name: null } })), [orbis]);
  world.handle.close();
});

test('a shared name lists both entities and creates or merges nothing', () => {
  // Bug: the name filter resolves to one winner, or a read of a name leaves an entity or a label behind.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'two different things called Lumen');
  const one = addEntity(world, 'project', 'Lumen', [source]).entityId;
  const two = addEntity(world, 'project', 'Lumen', [source]).entityId;
  addEntity(world, 'project', 'Orbis', [source]);
  const before = databaseDigest(world.db);
  const page = list(world, world.contexts.internal, { filters: { kind: null, name: 'lumen' } });
  assert.deepEqual(listed(page).sort(), [one, two].sort());
  assert.deepEqual(list(world, world.contexts.internal, { filters: { kind: null, name: 'Nobody' } }).items, []);
  assert.deepEqual(databaseDigest(world.db), before);
  world.handle.close();
});

test('a private alias neither matches a group name filter nor shows among its names', () => {
  // Bug: the name filter reads semantic_labels whole, so a DM nickname finds the entity for a group.
  const { world, secret, lumen } = world3();
  commit(world, alias(lumen, 'Moth', [secret]), world.contexts.alex);
  const byAlias = (context: Context) => listed(list(world, context, { filters: { kind: null, name: 'Moth' } }));
  assert.deepEqual(byAlias(world.contexts.internal), [lumen]);
  assert.deepEqual(byAlias(world.contexts.alex), [lumen]);
  assert.deepEqual(byAlias(world.contexts.group), []);
  assert.deepEqual(byAlias(world.contexts.mira), []);
  const names = list(world, world.contexts.group).items.find((item) => item.id === lumen)?.names ?? [];
  assert.deepEqual(
    names.map((one) => one.text),
    ['Lumen']
  );
  world.handle.close();
});

test('an entity first named after the recording cutoff is not listed at it', () => {
  // Bug: the as-of list reads the current table, so an earlier moment shows an entity that did not exist yet.
  const world = semanticWorld();
  const source = addSource(world, 'public', 'Lumen, then Orbis');
  const lumen = addEntity(world, 'project', 'Lumen', [source]);
  const orbis = addEntity(world, 'project', 'Orbis', [source]);
  const page = list(world, world.contexts.internal, { recordedBefore: recordedAt(world, orbis.versionId) });
  assert.deepEqual(listed(page), [lumen.entityId]);
  world.handle.close();
});

test('a cursor of one filter is refused under another', () => {
  // Bug: a cursor replayed under a wider filter starts over silently, and the owner reads a page twice.
  const { world } = world3();
  const first = list(world, world.contexts.internal, { limit: 1, filters: { kind: 'project', name: null } });
  assert.equal(first.total, 2);
  assert.throws(
    () =>
      list(world, world.contexts.internal, { limit: 1, cursor: first.next, filters: { kind: 'event', name: null } }),
    { code: 'INSPECTION_BAD_CURSOR' }
  );
  assert.throws(() => list(world, world.contexts.group, { limit: 1, cursor: first.next }), {
    code: 'INSPECTION_BAD_CURSOR',
  });
  world.handle.close();
});

// ---- show ------------------------------------------------------------------------------------------------------------

test('an entity opens with its stored record and its names by exact version', () => {
  const world = semanticWorld();
  const open = addSource(world, 'public', 'Lumen, also called Lume');
  const lumen = addEntity(world, 'project', 'Lumen', [open]);
  const nick = written(commit(world, alias(lumen.entityId, 'Lume', [open])));
  const detail = entityDetail(world.db, lumen.entityId, { context: world.contexts.internal, recordedBefore: null });
  assert.ok(detail.found);
  const stored = world.db.prepare('SELECT * FROM semantic_entities WHERE id = ?').get(lumen.entityId);
  assert.deepEqual(detail.entity, {
    id: lumen.entityId,
    kind: 'project',
    kindVersion: 1,
    createdAt: stored?.created_at,
    retiredAt: null,
  });
  assert.equal(detail.canonicalId, lumen.entityId);
  assert.deepEqual(
    detail.names.map((one) => [one.text, one.role, one.versionId]),
    [
      ['Lumen', 'name', lumen.versionId],
      ['Lume', 'alias', nick.versionId],
    ]
  );
  world.handle.close();
});

test('a merged entity keeps its own id and names the entity it is taken to be', () => {
  // Bug: show follows the equivalence and answers the other record, so the merged one cannot be opened at all.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'Lume is Lumen');
  const lume = addEntity(world, 'project', 'Lume', [open]).entityId;
  const lumen = addEntity(world, 'project', 'Lumen', [open]).entityId;
  commit(world, sameAs(lume, lumen, [open]));
  const detail = entityDetail(world.db, lume, { context: world.contexts.internal, recordedBefore: null });
  assert.ok(detail.found);
  assert.equal(detail.entity.id, lume);
  assert.equal(detail.canonicalId, lumen);
  world.handle.close();
});

test('a private equivalence moves the canonical entity for its DM and for no group', () => {
  // Bug: the merge row is read whole, so a group sees two projects as one on Alex's private word.
  const world = semanticWorld();
  const open = addSource(world, 'public', 'Lume and Lumen');
  const secret = addSource(world, 'alex', 'Lume is really Lumen');
  const lume = addEntity(world, 'project', 'Lume', [open]).entityId;
  const lumen = addEntity(world, 'project', 'Lumen', [open]).entityId;
  commit(world, sameAs(lume, lumen, [secret]), world.contexts.alex);
  const canonical = (context: Context) => {
    const detail = entityDetail(world.db, lume, { context, recordedBefore: null });
    return detail.found ? detail.canonicalId : null;
  };
  assert.equal(canonical(world.contexts.internal), lumen);
  assert.equal(canonical(world.contexts.alex), lumen);
  assert.equal(canonical(world.contexts.group), lume);
  assert.equal(canonical(world.contexts.mira), lume);
  world.handle.close();
});

test('an entity known only in a DM opens there and for the owner, and for nobody else', () => {
  // Bug: show checks only that the row exists, so any context opens a private project by its id.
  const { world, hidden } = world3();
  const open = (context: Context) => entityDetail(world.db, hidden, { context, recordedBefore: null });
  assert.equal(open(world.contexts.internal).found, true);
  assert.equal(open(world.contexts.alex).found, true);
  assert.deepEqual(open(world.contexts.group), { found: false, code: 'ENTITY_NOT_FOUND' });
  assert.deepEqual(open(world.contexts.mira), { found: false, code: 'ENTITY_NOT_FOUND' });
  assert.deepEqual(open(world.contexts.groups), { found: false, code: 'ENTITY_NOT_FOUND' });
  world.handle.close();
});

test('an id nobody stored is not found and leaves the database as it was', () => {
  const { world } = world3();
  const before = databaseDigest(world.db);
  assert.deepEqual(
    entityDetail(world.db, 'entity:nobody', { context: world.contexts.internal, recordedBefore: null }),
    { found: false, code: 'ENTITY_NOT_FOUND' }
  );
  assert.deepEqual(databaseDigest(world.db), before);
  world.handle.close();
});

test('the descriptions of an entity are the ones its context may read', () => {
  // Bug: show joins every description of the entity, and a DM's worry reaches the owner's group preview.
  const { world, lumen } = world3();
  const describe = (id: string, text: string, scope: ReturnType<typeof groupScope>) =>
    applyMemoryWrite(world.handle, {
      kind: 'description',
      mode: 'apply',
      row: { id: `dv:${id}`, descriptionId: `desc:${id}`, text, writtenAt: new Date(world.now()).toISOString() },
      subject: { kind: 'entity', id: lumen, field: 'purpose' },
      scope,
      expectCurrent: null,
      now: world.now(),
    });
  describe('open', 'an open project', groupScope('discord'));
  describe('dm', 'Alex fears it will fail', dmScope(ALEX, 'discord'));
  const texts = (context: Context) => {
    const detail = entityDetail(world.db, lumen, { context, recordedBefore: null });
    return detail.found ? detail.descriptions.map((one) => one.text).sort() : null;
  };
  assert.deepEqual(texts(world.contexts.internal), ['Alex fears it will fail', 'an open project']);
  assert.deepEqual(texts(world.contexts.group), ['an open project']);
  world.handle.close();
});

// ---- relations -------------------------------------------------------------------------------------------------------

test('a relation names its version, the role the entity plays, every argument and its evidence', () => {
  // Bug: the owner sees an edge with no version, so the roles, the evidence and the audience cannot be opened.
  const { world, open, lumen } = world3();
  const fact = written(commit(world, worksOn(ALEX, lumen, [open])));
  const [item] = relations(world, world.contexts.internal, lumen).items;
  assert.equal(item?.claimId, fact.claimId);
  assert.equal(item?.versionId, fact.versionId);
  assert.deepEqual(item?.predicate, { id: 'project.works_on', version: 1 });
  assert.deepEqual(
    [item?.assertionKind, item?.polarity, item?.truthState, item?.how],
    ['relation', 'positive', 'current', 'said']
  );
  assert.deepEqual(item?.roles, [{ role: 'project', position: 0 }]);
  assert.deepEqual(
    [...(item?.arguments ?? [])].sort((a, b) => (a.role < b.role ? -1 : 1)),
    [
      { role: 'person', position: 0, ref: { kind: 'person', id: ALEX } },
      { role: 'project', position: 0, ref: { kind: 'entity', id: lumen } },
    ]
  );
  assert.deepEqual(item?.evidence, [{ sourceId: open, role: 'supports' }]);
  world.handle.close();
});

test('the label versions of an entity are its names and not its relations', () => {
  const { world, lumen } = world3();
  assert.deepEqual(relations(world, world.contexts.internal, lumen).items, []);
  assert.equal(relations(world, world.contexts.internal, lumen).total, 0);
  world.handle.close();
});

test('an entity in two roles of one event is one relation listing both roles', () => {
  // Bug: one row per argument makes the joint event read as two independent facts.
  const { world, open, lumen, orbis } = world3();
  const fact = written(
    commit(
      world,
      candidate(
        'event.occurrence',
        'nary',
        [
          { role: 'event', position: 0, ref: { kind: 'entity', id: orbis } },
          { role: 'organizer', position: 0, ref: { kind: 'person', id: ALEX } },
          { role: 'project', position: 0, ref: { kind: 'entity', id: lumen } },
          { role: 'location', position: 0, ref: { kind: 'entity', id: lumen } },
        ],
        [open]
      )
    )
  );
  const page = relations(world, world.contexts.internal, lumen);
  assert.deepEqual(versionsOf(page), [fact.versionId]);
  assert.deepEqual(
    [...(page.items[0]?.roles ?? [])].sort((a, b) => (a.role < b.role ? -1 : 1)),
    [
      { role: 'location', position: 0 },
      { role: 'project', position: 0 },
    ]
  );
  assert.equal(page.items[0]?.arguments.length, 4);
  world.handle.close();
});

test('active shows the newest version of a claim and historical every version in order', () => {
  // Bug: both modes read the newest version only, so a changed fact has no history to open.
  const { world, open, lumen } = world3();
  const first = written(commit(world, worksOn(ALEX, lumen, [open])));
  const second = written(commit(world, worksOn(ALEX, lumen, [open], successor(first, { polarity: 'negative' }))));
  const active = relations(world, world.contexts.internal, lumen);
  assert.deepEqual(versionsOf(active), [second.versionId]);
  assert.equal(active.items[0]?.polarity, 'negative');
  assert.deepEqual(versionsOf(relations(world, world.contexts.internal, lumen, { mode: 'historical' })), [
    first.versionId,
    second.versionId,
  ]);
  world.handle.close();
});

test('a retired claim leaves the active relations and stays in the historical ones', () => {
  const { world, open, lumen } = world3();
  const first = written(commit(world, worksOn(ALEX, lumen, [open])));
  const gone = written(commit(world, worksOn(ALEX, lumen, [open], successor(first, { state: 'retired' }))));
  assert.deepEqual(relations(world, world.contexts.internal, lumen).items, []);
  assert.deepEqual(versionsOf(relations(world, world.contexts.internal, lumen, { mode: 'historical' })), [
    first.versionId,
    gone.versionId,
  ]);
  world.handle.close();
});

test('at a recording cutoff the active relation is the version in force then', () => {
  // Bug: as-of reads filter the list after choosing the newest version, so the earlier fact never shows.
  const { world, open, lumen } = world3();
  const first = written(commit(world, worksOn(ALEX, lumen, [open])));
  const second = written(commit(world, worksOn(ALEX, lumen, [open], successor(first, { polarity: 'negative' }))));
  const asOf = relations(world, world.contexts.internal, lumen, {
    recordedBefore: recordedAt(world, second.versionId),
  });
  assert.deepEqual(versionsOf(asOf), [first.versionId]);
  assert.equal(asOf.items[0]?.polarity, 'positive');
  world.handle.close();
});

test('the predicate filter keeps only the predicates asked for', () => {
  const { world, open, lumen, orbis } = world3();
  const works = written(commit(world, worksOn(ALEX, lumen, [open])));
  const event = written(commit(world, occurrence(orbis, { organizer: [ALEX], project: [lumen] }, [open])));
  assert.deepEqual(versionsOf(relations(world, world.contexts.internal, lumen, { predicates: ['project.works_on'] })), [
    works.versionId,
  ]);
  assert.deepEqual(versionsOf(relations(world, world.contexts.internal, lumen, { predicates: ['event.occurrence'] })), [
    event.versionId,
  ]);
  world.handle.close();
});

test('a public entity with a private incident relation shows a group only the public one, counted alike', () => {
  // Bug: a visible entity authorizes every assertion that names it, and the DM fact reaches the group through the hub.
  const { world, open, secret, lumen } = world3();
  const pub = written(commit(world, worksOn(ALEX, lumen, [open])));
  const dm = written(commit(world, worksOn(MIRA, lumen, [secret]), world.contexts.alex));
  assert.deepEqual(
    versionsOf(relations(world, world.contexts.internal, lumen)).sort(),
    [pub.versionId, dm.versionId].sort()
  );
  for (const context of [world.contexts.group, world.contexts.mira, world.contexts.groups]) {
    const page = relations(world, context, lumen, { mode: 'historical' });
    assert.deepEqual(versionsOf(page), [pub.versionId]);
    assert.equal(page.total, 1);
  }
  world.handle.close();
});

test('the relations of an entity known only in a DM are refused to a group', () => {
  const { world, secret, hidden } = world3();
  commit(world, worksOn(ALEX, hidden, [secret]), world.contexts.alex);
  assert.equal(relations(world, world.contexts.internal, hidden).items.length, 1);
  assert.throws(() => relations(world, world.contexts.group, hidden), { code: 'ENTITY_NOT_FOUND' });
  assert.throws(() => relations(world, world.contexts.mira, hidden), { code: 'ENTITY_NOT_FOUND' });
  world.handle.close();
});

test('an inferred relation names its premise version and the role of that premise', () => {
  // Bug: the premise is dropped from the owner's view, so an inference reads as a fact with nothing under it.
  const { world, open, lumen } = world3();
  const premise = written(commit(world, worksOn(ALEX, lumen, [open])));
  const conclusion = written(
    commit(
      world,
      worksOn(MIRA, lumen, [open], {
        how: 'inferred',
        dependencies: [{ versionId: premise.versionId, role: 'supports' }],
      })
    )
  );
  const item = relations(world, world.contexts.internal, lumen).items.find(
    (one) => one.versionId === conclusion.versionId
  );
  assert.equal(item?.how, 'inferred');
  assert.deepEqual(item?.dependencies, [{ versionId: premise.versionId, role: 'supports' }]);
  world.handle.close();
});

test('relations page once across pages and refuse a cursor of another entity', () => {
  const { world, open, lumen, orbis } = world3();
  const expected = [ALEX, MIRA, 'person:91bd'].map(
    (who) => written(commit(world, worksOn(who, lumen, [open]))).versionId
  );
  const seen: Array<string> = [];
  let page = relations(world, world.contexts.internal, lumen, { limit: 2 });
  seen.push(...versionsOf(page));
  while (page.next !== null) {
    page = relations(world, world.contexts.internal, lumen, { limit: 2, cursor: page.next });
    seen.push(...versionsOf(page));
  }
  assert.deepEqual(seen.sort(), [...expected].sort());
  const first = relations(world, world.contexts.internal, lumen, { limit: 1 });
  assert.throws(() => relations(world, world.contexts.internal, orbis, { limit: 1, cursor: first.next }), {
    code: 'INSPECTION_BAD_CURSOR',
  });
  world.handle.close();
});
