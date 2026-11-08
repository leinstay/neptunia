// The owner's browser over semantic memory, from his line to the answer, over the real memory service and a database the
// one writer filled (tests/fixtures/memory-db/semantic-world.ts). Plan 2026-11-04-cli-and-memory task 10.2 and the S9
// gate. `/memory entities list`, `show`, `names` and `relations` answer the typed reader of src/memory/db/entities-read.ts.
// `/memory claims` opens a semantic version with its roles, premise versions and exact sources, and the users, places and
// graph views reach the same records. `/memory inspect` reads and exports every semantic table and FTS shadow. Every read
// runs in the owner's internal context. A chat line and argv words select the same typed ids, and no read calls a model,
// writes a row or rebuilds a projection. Each audience test opens the DM's record through the internal context first, so
// what a group context misses is refused and never unwritten. Synthetic content only.
//
// The contract this file is typed against, beside tests/memory-db-entities-read.test.ts:
//   /memory entities list [--kind] [--name] [--recorded-before] [--limit] [--cursor]   args: kind, name, recorded-before
//   /memory entities show <entity> [--recorded-before]                                 args: entity
//   /memory entities names <entity>                                                    answers { names }
//   /memory entities relations <entity> [--predicates] [--mode] [--recorded-before] [--limit] [--cursor]
//   An entity nobody may read answers `invalid` with the code ENTITY_NOT_FOUND.
//   domainDetail of a semantic claim version adds `semantic: { assertion, arguments, dependencies }`, catalog rows of
//   `semantic_assertion_versions`, `semantic_arguments` and `semantic_dependencies`, and links each premise version
//   (role `premise`) and each version resting on it (role `dependent`). A plain version has no `semantic`.
//   personDetail and placeDetail list a semantic version whose reference argument names the person or the place as
//   `{ table: 'semantic_assertion_versions', id }` among their records.
//   The chat's bare `/memory entities` is a panel over `memory.entities.list`, each row prefilling
//   `/memory entities show <id>`.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chatPanel } from '../bin/chat-panels.ts';
import { parseRequest } from '../bin/neptunia-request.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import type { Answer } from '../src/interface/commands/console.ts';
import { commandLineWords, parseCommandLine, parseCommandWords } from '../src/interface/commands/table.ts';
import { createCommandDesk } from '../src/interface/neptunia-cli.ts';
import type { CommandDeps } from '../src/interface/neptunia-cli.ts';
import { domainDetail, versionsOf } from '../src/memory/db/domain-read.ts';
import { entityDetail, entityRelations, listEntities } from '../src/memory/db/entities-read.ts';
import { graphNodeId } from '../src/memory/db/graph.ts';
import { graphKinds, graphNeighbors, graphNode, graphPath, graphWalk } from '../src/memory/db/graph-read.ts';
import type { GraphEdgeRecord, GraphEdgeRequest } from '../src/memory/db/graph-read.ts';
import type { InspectionCatalog, InspectionPage, InspectionRow } from '../src/memory/db/inspection.ts';
import { personDetail } from '../src/memory/db/people-read.ts';
import { placeDetail } from '../src/memory/db/places-read.ts';
import type { Context } from '../src/memory/db/scope.ts';
import { internalContext } from '../src/memory/db/scope.ts';
import type { Db } from '../src/memory/db/types.ts';
import { listOps } from '../src/tools/impl/index.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { actualTableNames, cell, countOf, databaseDigest } from './fixtures/memory-db/browser-world.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import type { TestMemory } from './fixtures/memory-db/service.ts';
import {
  ALEX,
  KAI,
  MIRA,
  ROOM,
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

const BOUNDS = { pageRows: 25, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300, maxSnapshots: 8 };
const INTERNAL = internalContext();
const ACTIVE: GraphEdgeRequest = { predicates: null, mode: 'active', validAt: null, recordedBefore: null };

type Version = { claimId: string; versionId: string };
const written = (result: object): Version => result as Version;

/** What the seed wrote, by name, and the contexts the core would issue for the group and the two DMs. */
type Seeded = {
  open: string;
  secret: string;
  edited: string;
  lumen: string;
  orbis: string;
  hidden: string;
  lumenName: Version;
  hiddenName: Version;
  moth: Version;
  works1: Version;
  works2: Version;
  kai: Version;
  mira: Version;
  event: Version;
  dmMeeting: Version;
  hiddenWork: Version;
  kite: string;
  kyte: string;
  contexts: World['contexts'];
};

type Rig = {
  memory: TestMemory;
  db: Db;
  ops: Array<string>;
  dir: string;
  seeded: Seeded;
  /** One command as argv words, as `neptunia memory ...` hands them over. */
  say(...words: Array<string>): Promise<Answer>;
  /** One command as the chat's line. */
  line(text: string): Promise<Answer>;
  run(command: { name: string; args: Record<string, unknown> }): Promise<Answer>;
};

const label = (entityId: string, role: 'alias', text: string, sources: Array<string>) =>
  candidate(
    'entity.label',
    'label',
    [
      { role: 'entity', position: 0, ref: { kind: 'entity', id: entityId } },
      { role, position: 0, literal: text },
      { role: 'language', position: 0, literal: 'en' },
    ],
    sources
  );

/**
 * A public project, a public event and a project only Alex's DM knows; a DM alias; a relation changed from positive to
 * negative; a public and a private inference resting on its first version; an event with four roles held in the room; a
 * DM meeting in the room; two public concepts declared the same; and an edited revision of the public line the facts cite.
 */
function seed(world: World): Seeded {
  const open = addSource(world, 'public', 'Alex works on Lumen; Orbis met in the room with Mira speaking');
  const secret = addSource(world, 'alex', 'Mira helps on Lumen; Hidden is mine');
  const lumen = addEntity(world, 'project', 'Lumen', [open]);
  const orbis = addEntity(world, 'event', 'Orbis', [open]);
  const hidden = addEntity(world, 'project', 'Hidden', [secret], world.contexts.alex);
  const moth = written(commit(world, label(lumen.entityId, 'alias', 'Moth', [secret]), world.contexts.alex));
  const works1 = written(commit(world, worksOn(ALEX, lumen.entityId, [open])));
  const inferred = { how: 'inferred', dependencies: [{ versionId: works1.versionId, role: 'supports' as const }] };
  const kai = written(commit(world, worksOn(KAI, lumen.entityId, [open], inferred)));
  const mira = written(commit(world, worksOn(MIRA, lumen.entityId, [secret], inferred), world.contexts.alex));
  const event = written(
    commit(
      world,
      candidate(
        'event.occurrence',
        'nary',
        [
          { role: 'event', position: 0, ref: { kind: 'entity', id: orbis.entityId } },
          { role: 'organizer', position: 0, ref: { kind: 'person', id: ALEX } },
          { role: 'speaker', position: 0, ref: { kind: 'person', id: MIRA } },
          { role: 'project', position: 0, ref: { kind: 'entity', id: lumen.entityId } },
          { role: 'location', position: 0, ref: { kind: 'place', id: ROOM } },
        ],
        [open]
      )
    )
  );
  const dmMeeting = written(
    commit(
      world,
      candidate(
        'event.occurrence',
        'nary',
        [
          { role: 'event', position: 0, ref: { kind: 'entity', id: hidden.entityId } },
          { role: 'attendee', position: 0, ref: { kind: 'person', id: ALEX } },
          { role: 'location', position: 0, ref: { kind: 'place', id: ROOM } },
        ],
        [secret]
      ),
      world.contexts.alex
    )
  );
  const hiddenWork = written(commit(world, worksOn(ALEX, hidden.entityId, [secret]), world.contexts.alex));
  const works2 = written(
    commit(world, worksOn(ALEX, lumen.entityId, [open], successor(works1, { polarity: 'negative' })))
  );
  const kite = addEntity(world, 'concept', 'Kite', [open]).entityId;
  const kyte = addEntity(world, 'concept', 'Kyte', [open]).entityId;
  commit(world, sameAs(kyte, kite, [open]));
  const edited = 'src:edited';
  world.db
    .prepare(
      `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, author_account, author_kind, occurred_at,
         recorded_at, text, scope_kind, scope_iface, scope_dm, audience_id)
       SELECT ?, kind, iface, native_id, 2, place_id, author_account, author_kind, occurred_at, recorded_at, 'edited later',
         scope_kind, scope_iface, scope_dm, audience_id FROM sources WHERE id = ?`
    )
    .run(edited, open);
  return {
    open,
    secret,
    edited,
    lumen: lumen.entityId,
    orbis: orbis.entityId,
    hidden: hidden.entityId,
    lumenName: lumen,
    hiddenName: hidden,
    moth,
    works1,
    works2,
    kai,
    mira,
    event,
    dmMeeting,
    hiddenWork,
    kite,
    kyte,
    contexts: world.contexts,
  };
}

const rigs: Array<TestMemory> = [];
after(async () => {
  for (const memory of rigs) await memory.close();
});

/** The seed through the writer on a file, then the real service over that file with the console on it. */
async function rig(): Promise<Rig> {
  const world = semanticWorld();
  const seeded = seed(world);
  world.handle.close();
  const dir = dirname(world.file);
  mkdirSync(join(dir, 'config'), { recursive: true });
  const memory = await openTestMemory({ dataDir: dir, config: { memoryDb: { inspection: BOUNDS } } });
  rigs.push(memory);
  const db = memory.memoryDb.database();
  assert.ok(db);
  const ops: Array<string> = [];
  const desk = createConsole({
    runOp: (op) => {
      ops.push(op);
      return Promise.resolve({ status: 'failed', code: 'NOT_FOR_A_BROWSER_READ', summary: '', data: null });
    },
    ownerReads: { lessons: () => '', aliases: () => '' },
    places: () => [],
    selfId: () => null,
    hot: memory.hot,
    privateDir: dir,
    dataDir: memory.dataDir,
    memoryDb: memory.memoryDb,
    usage: null,
    metrics: { samples: () => [] },
    chatLines: () => [],
    now: () => Date.UTC(2026, 10, 5, 12),
  });
  const run = async (command: { name: string; args: Record<string, unknown> }): Promise<Answer> => {
    const real = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error('a memory read reached the network'));
    try {
      return await desk.run(command.name, command.args, { id: 'owner' });
    } finally {
      globalThis.fetch = real;
    }
  };
  return {
    memory,
    db,
    ops,
    dir,
    seeded,
    run,
    say: (...words) => {
      const parsed = parseRequest(words).parsed;
      assert.ok(parsed.ok, parsed.ok ? '' : `${words.join(' ')}: ${parsed.reason}`);
      return run(parsed);
    },
    line: (text) => {
      const parsed = parseCommandLine(text);
      assert.ok(parsed.ok, parsed.ok ? '' : `${text}: ${parsed.reason}`);
      return run(parsed);
    },
  };
}

function data<TData>(answer: Answer): TData {
  assert.equal(answer.status, 'ok', answer.text.slice(0, 300));
  return JSON.parse(answer.text) as TData;
}
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const recordedAt = (db: Db, versionId: string): string =>
  String(db.prepare('SELECT recorded_at FROM claim_versions WHERE id = ?').get(versionId)?.recorded_at);
const entityNode = (id: string): string => graphNodeId('semantic_entity', id);
const personNode = (id: string): string => graphNodeId('person', id);
const versionNode = (id: string): string => graphNodeId('claim_version', id);
const text = (value: string) => ({ kind: 'text', value });

type SemanticDetail = {
  id: string;
  links: Array<{ family: string; id: string; role: string }>;
  rows: Array<InspectionRow>;
  semantic?: { assertion: InspectionRow; arguments: Array<InspectionRow>; dependencies: Array<InspectionRow> };
};

// ---- the command table -----------------------------------------------------------------------------------------------

const AT = '2026-11-05T10:00:30.000Z';
const LINES: ReadonlyArray<readonly [Array<string>, string, Record<string, string>]> = [
  [['memory', 'entities', 'list'], 'memory.entities.list', {}],
  [
    [
      'memory',
      'entities',
      'list',
      '--kind',
      'project',
      '--name',
      'Lumen',
      '--recorded-before',
      AT,
      '--limit',
      '5',
      '--cursor',
      'c1',
    ],
    'memory.entities.list',
    { kind: 'project', name: 'Lumen', 'recorded-before': AT, limit: '5', cursor: 'c1' },
  ],
  [['memory', 'entities', 'show', 'ent:1', '--recorded-before', AT], 'memory.entities.show', { entity: 'ent:1' }],
  [['memory', 'entities', 'names', 'ent:1'], 'memory.entities.names', { entity: 'ent:1' }],
  [
    [
      'memory',
      'entities',
      'relations',
      'ent:1',
      '--predicates',
      'project.works_on',
      '--mode',
      'historical',
      '--recorded-before',
      AT,
      '--limit',
      '5',
      '--cursor',
      'c1',
    ],
    'memory.entities.relations',
    { entity: 'ent:1', predicates: 'project.works_on', mode: 'historical', 'recorded-before': AT },
  ],
];

for (const [words, name, args] of LINES) {
  test(`${words.join(' ')} parses to ${name}, the same from argv and from the chat`, () => {
    const fromArgv = parseCommandWords(words);
    assert.ok(fromArgv.ok, fromArgv.ok ? '' : fromArgv.reason);
    assert.equal(fromArgv.name, name);
    for (const [key, value] of Object.entries(args)) assert.equal(fromArgv.args[key], value, key);
    assert.deepEqual(parseRequest(words).parsed, fromArgv);
    assert.deepEqual(parseCommandLine(`/${words.join(' ')}`), fromArgv);
  });
}

// ---- /memory entities ------------------------------------------------------------------------------------------------

test('/memory entities list answers the reader for the owner, a DM-only entity included', async () => {
  const one = await rig();
  const { lumen, orbis, hidden, kite, kyte } = one.seeded;
  const answer = data<{ items: Array<{ id: string }> }>(await one.say('memory', 'entities', 'list'));
  assert.deepEqual(
    answer,
    json(
      listEntities(one.db, {
        context: INTERNAL,
        filters: { kind: null, name: null },
        recordedBefore: null,
        limit: BOUNDS.pageRows,
        cursor: null,
      })
    )
  );
  assert.deepEqual(answer.items.map((item) => item.id).sort(), [lumen, orbis, hidden, kite, kyte].sort());
});

test('/memory entities list passes its kind, name and cutoff down', async () => {
  const one = await rig();
  const { lumen, orbis, hidden, lumenName, hiddenName } = one.seeded;
  const ids = async (...flags: Array<string>): Promise<Array<string>> =>
    data<{ items: Array<{ id: string }> }>(await one.say('memory', 'entities', 'list', ...flags))
      .items.map((item) => item.id)
      .sort();
  assert.deepEqual(await ids('--kind', 'event'), [orbis]);
  assert.deepEqual(await ids('--name', 'Moth'), [lumen]);
  assert.deepEqual(await ids('--recorded-before', recordedAt(one.db, hiddenName.versionId)), [lumen, orbis].sort());
  assert.deepEqual(await ids('--recorded-before', recordedAt(one.db, lumenName.versionId)), []);
  assert.ok(!(await ids('--kind', 'project')).includes(orbis));
  assert.deepEqual(await ids('--kind', 'project'), [lumen, hidden].sort());
});

test('/memory entities show answers the reader, and an unknown id its code', async () => {
  const one = await rig();
  const { hidden } = one.seeded;
  assert.deepEqual(
    data(await one.say('memory', 'entities', 'show', hidden)),
    json(entityDetail(one.db, hidden, { context: INTERNAL, recordedBefore: null }))
  );
  const missing = await one.say('memory', 'entities', 'show', 'ent:nobody');
  assert.deepEqual([missing.status, missing.code], ['invalid', 'ENTITY_NOT_FOUND']);
});

test('/memory entities names lists a DM alias for the owner with the version that says it', async () => {
  const one = await rig();
  const { lumen, lumenName, moth } = one.seeded;
  const { names } = data<{ names: Array<{ text: string; role: string; versionId: string }> }>(
    await one.say('memory', 'entities', 'names', lumen)
  );
  assert.deepEqual(
    names.map((one2) => [one2.text, one2.role, one2.versionId]),
    [
      ['Lumen', 'name', lumenName.versionId],
      ['Moth', 'alias', moth.versionId],
    ]
  );
  const missing = await one.say('memory', 'entities', 'names', 'ent:nobody');
  assert.deepEqual([missing.status, missing.code], ['invalid', 'ENTITY_NOT_FOUND']);
});

test('/memory entities relations answers the reader and passes its mode, predicates and cutoff down', async () => {
  const one = await rig();
  const { lumen, works1, works2, kai, mira, event } = one.seeded;
  const versions = async (...flags: Array<string>): Promise<Array<string>> =>
    data<{ items: Array<{ versionId: string }> }>(await one.say('memory', 'entities', 'relations', lumen, ...flags))
      .items.map((item) => item.versionId)
      .sort();
  assert.deepEqual(
    data(await one.say('memory', 'entities', 'relations', lumen)),
    json(
      entityRelations(one.db, {
        context: INTERNAL,
        entityId: lumen,
        predicates: null,
        mode: 'active',
        recordedBefore: null,
        limit: BOUNDS.pageRows,
        cursor: null,
      })
    )
  );
  assert.deepEqual(await versions(), [works2.versionId, kai.versionId, mira.versionId, event.versionId].sort());
  assert.deepEqual(await versions('--predicates', 'event.occurrence'), [event.versionId]);
  assert.deepEqual(
    await versions('--predicates', 'project.works_on', '--mode', 'historical'),
    [works1.versionId, works2.versionId, kai.versionId, mira.versionId].sort()
  );
  assert.ok(
    (
      await versions('--predicates', 'project.works_on', '--recorded-before', recordedAt(one.db, works2.versionId))
    ).includes(works1.versionId)
  );
});

test('/memory entities relations refuses a mode it does not know and an entity nobody stored', async () => {
  // Bug: a bad word falls back to the active mode, and the owner reads current facts as the history he asked for.
  const one = await rig();
  const bad = await one.say('memory', 'entities', 'relations', one.seeded.lumen, '--mode', 'sometimes');
  assert.deepEqual([bad.status, bad.code], ['invalid', 'INSPECTION_BAD_ARGUMENT']);
  const missing = await one.say('memory', 'entities', 'relations', 'ent:nobody');
  assert.deepEqual([missing.status, missing.code], ['invalid', 'ENTITY_NOT_FOUND']);
});

test('every entity route keeps a DM entity from a group context and gives it to the owner', async () => {
  // Bug: a route reads the entity tables whole, so the group preview of the browser names a private project.
  const one = await rig();
  const { hidden, lumen, mira, moth, contexts } = one.seeded;
  const listed = (context: Context) =>
    listEntities(one.db, {
      context,
      filters: { kind: null, name: null },
      recordedBefore: null,
      limit: 50,
      cursor: null,
    });
  assert.ok(listed(INTERNAL).items.some((item) => item.id === hidden));
  assert.ok(!listed(contexts.group).items.some((item) => item.id === hidden));
  assert.equal(listed(contexts.group).total, 4);
  assert.equal(entityDetail(one.db, hidden, { context: INTERNAL, recordedBefore: null }).found, true);
  assert.deepEqual(entityDetail(one.db, hidden, { context: contexts.group, recordedBefore: null }), {
    found: false,
    code: 'ENTITY_NOT_FOUND',
  });
  const names = entityDetail(one.db, lumen, { context: contexts.group, recordedBefore: null });
  assert.ok(names.found);
  assert.ok(!names.names.some((name) => name.versionId === moth.versionId));
  const relations = (context: Context) =>
    entityRelations(one.db, {
      context,
      entityId: lumen,
      predicates: null,
      mode: 'historical',
      recordedBefore: null,
      limit: 50,
      cursor: null,
    });
  assert.ok(relations(INTERNAL).items.some((item) => item.versionId === mira.versionId));
  assert.ok(!relations(contexts.group).items.some((item) => item.versionId === mira.versionId));
  assert.throws(
    () =>
      entityRelations(one.db, {
        context: contexts.mira,
        entityId: hidden,
        predicates: null,
        mode: 'active',
        recordedBefore: null,
        limit: 50,
        cursor: null,
      }),
    { code: 'ENTITY_NOT_FOUND' }
  );
});

// ---- /memory claims over semantic versions ---------------------------------------------------------------------------

test('/memory claims version opens a semantic version with its epistemic row, roles, premises and exact sources', async () => {
  // Bug: the claim route shows the version's text only, so the owner cannot see who plays which role or what it rests on.
  const one = await rig();
  const { kai, works1, open } = one.seeded;
  const detail = data<SemanticDetail>(await one.say('memory', 'claims', 'version', kai.versionId));
  assert.ok(detail.semantic);
  const { assertion, arguments: args, dependencies } = detail.semantic;
  assert.deepEqual(
    ['truth_state', 'polarity', 'how', 'predicate_id'].map((column) => cell(assertion, column)),
    [text('current'), text('positive'), text('inferred'), text('project.works_on')]
  );
  assert.deepEqual(
    args.map((row) => [cell(row, 'role'), cell(row, 'ref_kind'), cell(row, 'ref_id')]).sort(),
    [
      [text('person'), text('person'), text(KAI)],
      [text('project'), text('entity'), text(one.seeded.lumen)],
    ].sort()
  );
  assert.deepEqual(
    dependencies.map((row) => [cell(row, 'premise_version_id'), cell(row, 'role')]),
    [[text(works1.versionId), text('supports')]]
  );
  assert.ok(
    detail.links.some(
      (link) => link.family === 'claim_versions' && link.id === works1.versionId && link.role === 'premise'
    )
  );
  assert.ok(detail.links.some((link) => link.family === 'sources' && link.id === open && link.role === 'supports'));
});

test('/memory claims version names the exact revision a fact cites, and that source names its later revision', async () => {
  // Bug: the evidence link follows the line to its newest edit, so the fact appears to rest on words it never read.
  const one = await rig();
  const { works1, open, edited } = one.seeded;
  const detail = data<SemanticDetail>(await one.say('memory', 'claims', 'version', works1.versionId));
  const sources = detail.links.filter((link) => link.family === 'sources').map((link) => link.id);
  assert.deepEqual(sources, [open]);
  const source = data<SemanticDetail>(await one.say('memory', 'sources', 'show', open));
  assert.ok(source.links.some((link) => link.id === edited && link.role === 'revision'));
});

test('/memory claims versions opens every version of a changed fact with its own polarity and its dependents', async () => {
  const one = await rig();
  const { works1, works2, kai, mira } = one.seeded;
  const { versions } = data<{ versions: Array<SemanticDetail> }>(
    await one.say('memory', 'claims', 'versions', works1.claimId)
  );
  assert.deepEqual(
    versions.map((version) => version.id),
    [works1.versionId, works2.versionId]
  );
  assert.deepEqual(
    versions.map((version) => (version.semantic ? cell(version.semantic.assertion, 'polarity') : null)),
    [text('positive'), text('negative')]
  );
  const dependents = versions[0]?.links
    .filter((link) => link.role === 'dependent')
    .map((link) => link.id)
    .sort();
  assert.deepEqual(dependents, [kai.versionId, mira.versionId].sort());
  assert.deepEqual(
    data(await one.say('memory', 'claims', 'versions', works1.claimId)),
    json(versionsOf(one.db, { family: 'claims', id: works1.claimId, context: INTERNAL }))
  );
});

test('/memory claims show opens a semantic claim with every version it holds', async () => {
  const one = await rig();
  const { works1, works2 } = one.seeded;
  const detail = data<SemanticDetail>(await one.say('memory', 'claims', 'show', works1.claimId));
  assert.deepEqual(
    detail.links.filter((link) => link.role === 'version').map((link) => link.id),
    [works1.versionId, works2.versionId]
  );
});

test('a plain claim version opens with no semantic payload', async () => {
  // Bug: an empty semantic block on a plain version reads as a structured fact with no roles.
  const one = await rig();
  const db = one.db;
  db.prepare(
    `INSERT INTO claims (id, subject_kind, subject_id, kind, text, truth, shown, audience_id, scope_kind, created_at)
     VALUES ('claim:plain', 'place', ?, 'detail', 'a plain fact', 'current', 1, 'aud:internal', 'internal', '2026-11-01T00:00:00.000Z')`
  ).run(ROOM);
  db.prepare(
    `INSERT INTO claim_versions (id, claim_id, text, recorded_at, event, by, origin) VALUES ('version:plain', 'claim:plain', 'a plain fact', '2026-11-01T00:00:00.000Z', 'edit', 's', 's')`
  ).run();
  const detail = data<SemanticDetail>(await one.say('memory', 'claims', 'version', 'version:plain'));
  assert.equal(detail.id, 'version:plain');
  assert.equal(detail.semantic, undefined);
});

test('a public premise shows a group its public dependent and never the DM one', async () => {
  // Bug: the dependent link is not filtered, so a group learns that a hidden conclusion rests on a public fact.
  const one = await rig();
  const { works1, kai, mira, contexts } = one.seeded;
  const dependents = (context: Context) => {
    const detail = domainDetail(one.db, { family: 'claim_versions', id: works1.versionId, context });
    return detail.found
      ? detail.links
          .filter((link) => link.role === 'dependent')
          .map((link) => link.id)
          .sort()
      : null;
  };
  assert.deepEqual(dependents(INTERNAL), [kai.versionId, mira.versionId].sort());
  assert.deepEqual(dependents(contexts.group), [kai.versionId]);
  assert.deepEqual(dependents(contexts.mira), [kai.versionId]);
});

test('the name claim of a DM entity is not opened for a group by any claim route', async () => {
  const one = await rig();
  const { hiddenName, contexts } = one.seeded;
  assert.equal(domainDetail(one.db, { family: 'claims', id: hiddenName.claimId, context: INTERNAL }).found, true);
  for (const family of ['claims', 'claim_versions'] as const) {
    const id = family === 'claims' ? hiddenName.claimId : hiddenName.versionId;
    assert.deepEqual(domainDetail(one.db, { family, id, context: contexts.group }), {
      found: false,
      code: 'RECORD_NOT_FOUND',
    });
  }
  assert.deepEqual(versionsOf(one.db, { family: 'claims', id: hiddenName.claimId, context: contexts.group }), {
    found: false,
    code: 'RECORD_NOT_FOUND',
  });
});

// ---- the users and places views --------------------------------------------------------------------------------------

test('/memory users show lists the semantic versions that name the person, a DM one only for the owner', async () => {
  // Bug: a person's detail lists plain claims only, so the facts in which they play a role cannot be reached from them.
  const one = await rig();
  const { works2, event, dmMeeting, hiddenWork, contexts } = one.seeded;
  const semanticIds = (records: Array<{ table: string; id: string }>) =>
    records.filter((record) => record.table === 'semantic_assertion_versions').map((record) => record.id);
  const owner = data<{ records: Array<{ table: string; id: string }> }>(await one.say('memory', 'users', 'show', ALEX));
  for (const version of [works2, event, dmMeeting, hiddenWork])
    assert.ok(semanticIds(owner.records).includes(version.versionId), version.versionId);
  const group = personDetail(one.db, ALEX, contexts.group);
  assert.ok(group.found);
  assert.ok(semanticIds(group.records).includes(event.versionId));
  assert.ok(!semanticIds(group.records).includes(hiddenWork.versionId));
  assert.ok(!semanticIds(group.records).includes(dmMeeting.versionId));
});

test('/memory places show lists the semantic versions held in the place, a DM one only for the owner', async () => {
  const one = await rig();
  const { event, dmMeeting, contexts } = one.seeded;
  const semanticIds = (records: Array<{ table: string; id: string }>) =>
    records
      .filter((record) => record.table === 'semantic_assertion_versions')
      .map((record) => record.id)
      .sort();
  const owner = data<{ records: Array<{ table: string; id: string }> }>(
    await one.say('memory', 'places', 'show', ROOM)
  );
  assert.deepEqual(semanticIds(owner.records), [event.versionId, dmMeeting.versionId].sort());
  const group = placeDetail(one.db, ROOM, { context: contexts.group, includeChildren: false });
  assert.ok(group.found);
  assert.deepEqual(semanticIds(group.records), [event.versionId]);
});

// ---- /memory graph over semantic witnesses ---------------------------------------------------------------------------

test('/memory graph kinds counts every semantic entity for the owner and only the visible ones for a group', async () => {
  const one = await rig();
  const answer = data<{ kinds: Array<{ kind: string; nodes: number }> }>(await one.say('memory', 'graph', 'kinds'));
  assert.deepEqual(answer, json(graphKinds(one.db, INTERNAL)));
  assert.equal(answer.kinds.find((kind) => kind.kind === 'semantic_entity')?.nodes, 5);
  const group = graphKinds(one.db, one.seeded.contexts.group);
  assert.equal(group.kinds.find((kind) => kind.kind === 'semantic_entity')?.nodes, 4);
});

test('/memory graph neighbors follows incoming shortcuts by predicate, each naming its exact version', async () => {
  const one = await rig();
  const { lumen, kai, mira, works2, contexts } = one.seeded;
  const edges = async (predicates: string): Promise<Array<GraphEdgeRecord>> =>
    data<{ items: Array<GraphEdgeRecord> }>(
      await one.say('memory', 'graph', 'neighbors', entityNode(lumen), '--direction', 'in', '--predicates', predicates)
    ).items;
  assert.deepEqual(
    (await edges('asserts')).map((edge) => [edge.src, edge.evidenceId]).sort(),
    [
      [personNode(KAI), kai.versionId],
      [personNode(MIRA), mira.versionId],
    ].sort()
  );
  assert.deepEqual(
    (await edges('denies')).map((edge) => [edge.src, edge.evidenceId]),
    [[personNode(ALEX), works2.versionId]]
  );
  const group = graphNeighbors(one.db, contexts.group, {
    ...ACTIVE,
    predicates: ['asserts'],
    node: entityNode(lumen),
    direction: 'in',
    limit: 50,
    cursor: null,
  });
  assert.deepEqual(
    group.items.map((edge) => edge.evidenceId),
    [kai.versionId]
  );
});

test('/memory graph neighbors follows outgoing role edges from a version to every argument', async () => {
  const one = await rig();
  const { event, orbis, lumen } = one.seeded;
  const { items } = data<{ items: Array<GraphEdgeRecord> }>(
    await one.say(
      'memory',
      'graph',
      'neighbors',
      versionNode(event.versionId),
      '--direction',
      'out',
      '--predicates',
      'has_role'
    )
  );
  assert.deepEqual(
    items.map((edge) => edge.dst).sort(),
    [entityNode(orbis), personNode(ALEX), personNode(MIRA), entityNode(lumen), graphNodeId('place', ROOM)].sort()
  );
});

test('/memory graph edges keeps a superseded witness for the historical mode and the cutoff', async () => {
  // Bug: a projection rebuild or an active filter drops the earlier fact, so as-of navigation finds nothing then.
  const one = await rig();
  const { works1, works2 } = one.seeded;
  const evidence = async (...flags: Array<string>): Promise<Array<string | null>> =>
    data<{ items: Array<GraphEdgeRecord> }>(
      await one.say('memory', 'graph', 'edges', '--predicates', 'asserts,denies', ...flags)
    ).items.map((edge) => edge.evidenceId);
  assert.ok(!(await evidence()).includes(works1.versionId));
  assert.ok((await evidence('--mode', 'historical')).includes(works1.versionId));
  const asOf = await evidence('--mode', 'historical', '--recorded-before', recordedAt(one.db, works2.versionId));
  assert.ok(asOf.includes(works1.versionId));
  assert.ok(!asOf.includes(works2.versionId));
});

test('/memory graph path finds the bounded association through the event and names its version', async () => {
  // Bug: the path is fabricated pairwise or remembered, so it reads as a fact nobody stated.
  const one = await rig();
  const { event, hidden, contexts } = one.seeded;
  const before = databaseDigest(one.db);
  const path = data<{ found: boolean; versionIds: Array<string>; nodes: Array<string> }>(
    await one.say(
      'memory',
      'graph',
      'path',
      personNode(ALEX),
      personNode(MIRA),
      '--direction',
      'both',
      '--predicates',
      'has_role',
      '--depth',
      '4'
    )
  );
  assert.deepEqual(path.nodes, [personNode(ALEX), versionNode(event.versionId), personNode(MIRA)]);
  assert.deepEqual(path.versionIds, [event.versionId]);
  assert.deepEqual(databaseDigest(one.db), before);
  const request = {
    ...ACTIVE,
    predicates: ['has_role'],
    from: personNode(ALEX),
    to: entityNode(hidden),
    direction: 'both' as const,
    maxDepth: 4,
  };
  assert.equal(graphPath(one.db, INTERNAL, request).found, true);
  assert.deepEqual(graphPath(one.db, contexts.group, request), { found: false, reason: 'none', explored: 0 });
});

test('/memory graph walk leaves a frontier at its depth and passes no DM version to a group', async () => {
  const one = await rig();
  const { lumen, mira, moth, contexts } = one.seeded;
  const owner = data<{ visited: Array<{ node: string }>; frontier: Array<string> }>(
    await one.say('memory', 'graph', 'walk', entityNode(lumen), '--direction', 'both', '--depth', '1')
  );
  assert.ok(owner.frontier.length > 0);
  const ownerNodes = owner.visited.map((visit) => visit.node);
  assert.ok(ownerNodes.includes(versionNode(mira.versionId)));
  assert.ok(ownerNodes.includes(versionNode(moth.versionId)));
  const group = graphWalk(one.db, contexts.group, {
    ...ACTIVE,
    from: [entityNode(lumen)],
    direction: 'both',
    maxDepth: 1,
    maxNodes: 100,
    cursor: null,
  });
  const groupNodes = group.visited.map((visit) => visit.node);
  assert.ok(!groupNodes.includes(versionNode(mira.versionId)));
  assert.ok(!groupNodes.includes(versionNode(moth.versionId)));
});

test('/memory graph node opens a DM entity for the owner and for no group', async () => {
  const one = await rig();
  const { hidden, contexts } = one.seeded;
  const owner = data<{ row: Record<string, unknown> | null; witnesses: Array<{ audienceId: string }> }>(
    await one.say('memory', 'graph', 'node', entityNode(hidden))
  );
  assert.equal(owner.row?.id, hidden);
  assert.ok(owner.witnesses.every((witness) => witness.audienceId.startsWith('aud:dm:')));
  assert.deepEqual(graphNode(one.db, contexts.group, entityNode(hidden)), { found: false, code: 'NODE_NOT_FOUND' });
});

test('a graph cursor is refused under other filters', async () => {
  // Bug: the next page reads under different predicates and the owner's list silently mixes two reads.
  const one = await rig();
  const node = entityNode(one.seeded.lumen);
  const first = data<{ next: string | null }>(
    await one.say('memory', 'graph', 'neighbors', node, '--direction', 'in', '--predicates', 'asserts', '--limit', '1')
  );
  assert.equal(first.next === null, false);
  const replay = await one.say(
    'memory',
    'graph',
    'neighbors',
    node,
    '--direction',
    'in',
    '--predicates',
    'has_role',
    '--limit',
    '1',
    '--cursor',
    String(first.next)
  );
  assert.deepEqual([replay.status, replay.code], ['invalid', 'INSPECTION_BAD_CURSOR']);
});

// ---- /memory inspect over semantic tables ----------------------------------------------------------------------------

const SEMANTIC_CLASSES: Readonly<Record<string, string>> = {
  semantic_arguments: 'domain',
  semantic_assertion_versions: 'domain',
  semantic_dependencies: 'domain',
  semantic_entities: 'domain',
  semantic_entity_kinds: 'domain',
  semantic_predicate_versions: 'domain',
  semantic_entity_merges: 'derived',
  semantic_labels: 'derived',
  semantic_search_documents: 'derived',
  semantic_search_fts: 'derived',
  semantic_search_fts_config: 'derived',
  semantic_search_fts_data: 'derived',
  semantic_search_fts_docsize: 'derived',
  semantic_search_fts_idx: 'derived',
};

async function everyRow(one: Rig, table: string, filters: unknown = []): Promise<Array<InspectionRow>> {
  const rows: Array<InspectionRow> = [];
  const filter = JSON.stringify(filters);
  let page = data<InspectionPage>(
    await one.say('memory', 'inspect', 'rows', table, '--limit', '7', '--filters', filter)
  );
  rows.push(...page.items);
  const snapshot = page.snapshot;
  while (page.next !== null) {
    page = data<InspectionPage>(
      await one.say(
        'memory',
        'inspect',
        'rows',
        table,
        '--snapshot',
        snapshot,
        '--limit',
        '7',
        '--filters',
        filter,
        '--cursor',
        page.next
      )
    );
    rows.push(...page.items);
  }
  await one.say('memory', 'inspect', 'close', snapshot);
  return rows;
}
const byVersion = (versionId: string) => [{ column: 'version_id', value: text(versionId) }];

test('the catalog lists every semantic table and FTS shadow, each in its class', async () => {
  // Bug: a semantic table or a shadow of its index is missing or unclassified, so the owner cannot tell fact from cache.
  const one = await rig();
  const { catalog } = data<{ catalog: InspectionCatalog }>(await one.say('memory', 'inspect', 'tables'));
  const classes = Object.fromEntries(
    catalog.tables
      .filter((table) => table.name.startsWith('semantic_'))
      .map((table) => [table.name, table.storageClass])
  );
  assert.deepEqual(classes, SEMANTIC_CLASSES);
});

test('every row of every semantic table is read through the command, and the counts reconcile', async () => {
  const one = await rig();
  for (const table of Object.keys(SEMANTIC_CLASSES)) {
    assert.ok(countOf(one.db, table) > 0, `the seed left ${table} empty`);
    assert.equal((await everyRow(one, table)).length, countOf(one.db, table), table);
  }
});

test('inspection shows the roles, premises, epistemic metadata and source refs of a version as stored', async () => {
  const one = await rig();
  const { event, kai, works1, works2, open } = one.seeded;
  const roles = (await everyRow(one, 'semantic_arguments', byVersion(event.versionId)))
    .map((row) => cell(row, 'role'))
    .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  assert.deepEqual(roles, ['event', 'location', 'organizer', 'project', 'speaker'].map(text));
  const premises = await everyRow(one, 'semantic_dependencies', byVersion(kai.versionId));
  assert.deepEqual(
    premises.map((row) => [cell(row, 'premise_version_id'), cell(row, 'role')]),
    [[text(works1.versionId), text('supports')]]
  );
  const [epistemic] = await everyRow(one, 'semantic_assertion_versions', byVersion(works2.versionId));
  assert.ok(epistemic);
  assert.deepEqual(
    ['polarity', 'truth_state', 'how'].map((column) => cell(epistemic, column)),
    [text('negative'), text('current'), text('said')]
  );
  assert.deepEqual(cell(epistemic, 'historical_metadata_complete'), { kind: 'integer', value: '1' });
  const evidence = await everyRow(one, 'claim_version_sources', byVersion(works1.versionId));
  assert.deepEqual(
    evidence.map((row) => [cell(row, 'source_id'), cell(row, 'role')]),
    [[text(open), text('supports')]]
  );
});

test('/memory inspect export carries every semantic table and FTS shadow, counts reconciled', async () => {
  const one = await rig();
  const file = join(one.dir, 'semantic-export.jsonl');
  const { manifest } = data<{ manifest: { rows: Record<string, number> } }>(
    await one.say('memory', 'inspect', 'export', file)
  );
  const records = readFileSync(file, 'utf8')
    .split('\n')
    .filter((entry) => entry !== '')
    .map((entry) => JSON.parse(entry) as { kind: string; table?: string });
  for (const table of Object.keys(SEMANTIC_CLASSES)) {
    assert.equal(manifest.rows[table], countOf(one.db, table), table);
    assert.equal(
      records.filter((record) => record.kind === 'row' && record.table === table).length,
      countOf(one.db, table),
      table
    );
  }
  assert.deepEqual(Object.keys(manifest.rows).sort(), actualTableNames(one.db).sort());
});

// ---- the chat and a shell ---------------------------------------------------------------------------------------------

test('the chat panel of /memory entities prefills the show line of each listed id, and both forms answer alike', async () => {
  // Bug: the panel keys rows by name, so two projects named alike open one record, or the chat and a shell disagree.
  const one = await rig();
  const listed = data<{ items: Array<{ id: string }> }>(await one.say('memory', 'entities', 'list')).items.map(
    (item) => item.id
  );
  const panel = await chatPanel('/memory entities', (command) => one.run(command));
  const prefills = panel?.rows?.map((row) => row.prefill) ?? [];
  assert.deepEqual(
    prefills,
    listed.map((id) => `/memory entities show ${id}`)
  );
  for (const [index, prefill] of prefills.entries()) {
    const fromChat = await one.line(prefill ?? '');
    const fromShell = await one.say(...commandLineWords(prefill ?? '').slice(0));
    assert.equal(fromChat.text, fromShell.text);
    assert.equal(data<{ entity: { id: string } }>(fromChat).entity.id, listed[index]);
  }
});

test('a semantic graph id reads the same from a chat line and from argv', async () => {
  const one = await rig();
  const node = entityNode(one.seeded.lumen);
  const words = ['memory', 'graph', 'neighbors', node, '--direction', 'in', '--predicates', 'asserts'];
  const fromShell = await one.say(...words);
  const fromChat = await one.line(`/${words.join(' ')}`);
  assert.equal(fromShell.status, 'ok');
  assert.equal(fromChat.text, fromShell.text);
});

const READS: ReadonlyArray<(seeded: Seeded) => Array<string>> = [
  () => ['memory', 'entities', 'list'],
  (s) => ['memory', 'entities', 'show', s.lumen],
  (s) => ['memory', 'entities', 'names', s.lumen],
  (s) => ['memory', 'entities', 'relations', s.lumen, '--mode', 'historical'],
  (s) => ['memory', 'claims', 'show', s.works1.claimId],
  (s) => ['memory', 'claims', 'versions', s.works1.claimId],
  (s) => ['memory', 'claims', 'version', s.kai.versionId],
  () => ['memory', 'users', 'show', ALEX],
  (s) => ['memory', 'graph', 'walk', entityNode(s.lumen), '--direction', 'both'],
  () => ['memory', 'graph', 'path', personNode(ALEX), personNode(MIRA), '--direction', 'both'],
  () => ['memory', 'inspect', 'rows', 'semantic_labels'],
];

test('the semantic browser calls no model, runs no operation and writes nothing, projections included', async () => {
  // Bug: a read records a turn read, witnesses a node, re-projects labels or flags a review, which changes her memory.
  const one = await rig();
  const before = databaseDigest(one.db);
  const settings = JSON.stringify(one.memory.hot.config);
  for (const read of READS) {
    const words = read(one.seeded);
    assert.equal((await one.say(...words)).status, 'ok', words.join(' '));
  }
  assert.deepEqual(one.ops, []);
  assert.deepEqual(databaseDigest(one.db), before);
  assert.equal(JSON.stringify(one.memory.hot.config), settings);
});

// ---- who reaches the routes ------------------------------------------------------------------------------------------

test('no operation of the persona names the entity routes', () => {
  // Bug: an entity read registered as an operation becomes a tool she can be granted, past the audience rules.
  assert.equal(JSON.stringify(listOps()).includes('memory.entities'), false);
});

for (const name of [
  'memory.entities.list',
  'memory.entities.show',
  'memory.entities.names',
  'memory.entities.relations',
]) {
  const event = { name, args: {}, chat: { id: 'cli:dm:owner' }, requester: { id: 'owner', roles: [] } };
  test(`${name} reaches the console from the owner's chat and from no agent or interface`, async () => {
    // Bug: a worker on the board or a chat platform names the route and reads the DM's entities.
    const calls: Array<string> = [];
    const deps: CommandDeps = {
      console: {
        run: (called) => {
          calls.push(called);
          return Promise.resolve({ text: '{}', status: 'ok' });
        },
      },
      interfaces: { list: () => [], enable: () => {}, disable: () => Promise.resolve({ drained: 0, unknown: 0 }) },
      facts: () => wrongly({}),
      tasks: { command: () => Promise.resolve(wrongly({ text: 'no such board command', status: 'invalid' })) },
    };
    const desk = createCommandDesk(deps);
    const agent = await desk.run(event, { kind: 'agent', name: 'dev' });
    const platform = await desk.run(event, { kind: wrongly('interface'), name: 'discord' });
    assert.deepEqual(calls, []);
    assert.notEqual('status' in agent ? agent.status : '', 'ok');
    assert.equal('status' in platform ? platform.status : '', 'denied');
    await desk.run(event, { kind: 'cli', name: 'cli' });
    assert.deepEqual(calls, [name]);
  });
}
