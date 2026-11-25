// Tests for src/interface/commands/memory.ts: the /memory commands of the owner console over a real memory database,
// from the parse on argv and in the chat to the readers they reach and the pages they answer.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync } from 'node:fs';
import path, { join, dirname } from 'node:path';
import { createConsole } from '../../../../src/interface/commands/console.ts';
import type { Answer, ConsoleDeps } from '../../../../src/interface/commands/console.ts';
import { parseCommandLine, parseCommandWords } from '../../../../src/interface/commands/table.ts';
import {
  graphEdges,
  graphKinds,
  graphNeighbors,
  graphNode,
  graphNodes,
  graphPath,
  graphWalk,
} from '../../../../src/memory/db/graph-read.ts';
import type { GraphEdgeRequest } from '../../../../src/memory/db/graph-read.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { internalContext } from '../../../../src/memory/db/scope.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row } from '../../../../src/memory/db/types.ts';
import {
  addAuthority,
  addEdge,
  addNode,
  clearGraph,
  databaseDigest,
  addPlace,
  addSource,
  cell,
  addDescription,
} from '../../../fixtures/memory-db/browser-world.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { domainDetail, domainList } from '../../../../src/memory/db/domain-read.ts';
import type { DomainFamily } from '../../../../src/memory/db/domain-read.ts';
import type { InspectionPage, InspectionRow, RowLocator } from '../../../../src/memory/db/inspection.ts';
import { openTestMemory } from '../../../fixtures/memory-db/service.ts';
import type { TestMemory } from '../../../fixtures/memory-db/service.ts';
import { parseRequest } from '../../../../bin/neptunia-request.ts';
import { entityDetail, entityRelations, listEntities } from '../../../../src/memory/db/entities-read.ts';
import { graphNodeId } from '../../../../src/memory/db/graph.ts';
import {
  ALEX,
  KAI,
  MIRA,
  ROOM,
  addEntity,
  addSource as semanticAddSource,
  candidate,
  commit,
  sameAs,
  semanticWorld,
  successor,
  worksOn,
} from '../../../fixtures/memory-db/semantic-world.ts';
import type { World } from '../../../fixtures/memory-db/semantic-world.ts';
import { listPeople, personDetail } from '../../../../src/memory/db/people-read.ts';
import { listPlaces, placeDetail } from '../../../../src/memory/db/places-read.ts';
import { privateByPerson } from '../../../../src/memory/db/private-read.ts';
import {
  ANNA,
  addAccount,
  seedOpaqueWorld,
  BORIS,
  BORIS_ACCOUNT,
  BORIS_PLACE,
  addClaim,
  addDmPlace,
  addEpisode,
} from '../../../fixtures/memory-db/opaque-people.ts';
import { writeInspectionExport } from '../../../../src/memory/db/inspection-snapshots.ts';

const PAGE_ROWS = 50;
const INTERNAL = internalContext();
const ACTIVE: GraphEdgeRequest = { predicates: null, mode: 'active', validAt: null, recordedBefore: null };
const node = (name: string): string => `claim:${name}`;

type Rig = { db: Db; ops: Array<string>; say(line: string): Promise<Answer>; close(): void };

function rig(memoryClosed = false): Rig {
  const dir = tempDir('nep-commands-graph-');
  mkdirSync(join(dir, 'config'), { recursive: true });
  const file = join(dir, 'memory.db');
  const writer = openMemoryDb(file);
  const seed = dbOf(writer);
  clearGraph(seed);
  addAuthority(seed, 'zeta', 'zeta/one');
  addEdge(seed, { id: 'edge:ab', src: node('a'), dst: node('b'), predicate: 'mentions' });
  addEdge(seed, { id: 'edge:bc', src: node('b'), dst: node('c'), predicate: 'quotes' });
  addEdge(seed, {
    id: 'edge:gone',
    src: node('a'),
    dst: node('z'),
    retiredAt: '2026-01-01T00:00:00.000Z',
    recordedAt: '2020-01-01T00:00:00.000Z',
  });
  addNode(seed, node('isolated'));
  writer.close();
  const reader = openMemoryDb(file, { readOnly: true });
  const ops: Array<string> = [];
  const desk = createConsole({
    runOp: (op) => {
      ops.push(op);
      return Promise.resolve({ status: 'failed', code: 'NOT_FOR_A_BROWSER_READ', summary: '', data: null });
    },
    ownerReads: { lessons: () => '' },
    places: () => [],
    selfId: () => null,
    hot: {
      config: {
        memoryDb: {
          file: 'memory.db',
          inspection: { pageRows: PAGE_ROWS, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300, maxSnapshots: 8 },
        },
      },
    },
    privateDir: dir,
    dataDir: dir,
    memoryDb: { database: () => (memoryClosed ? null : dbOf(reader)) },
    usage: null,
    metrics: { samples: () => [] },
    chatLines: () => [],
    now: () => 0,
  });
  return {
    db: dbOf(reader),
    ops,
    say: async (line) => {
      const parsed = parseCommandLine(line);
      assert.ok(parsed.ok, parsed.ok ? '' : `${line}: ${parsed.reason}`);
      return desk.run(parsed.name, parsed.args, { id: 'owner' });
    },
    close: () => reader.close(),
  };
}

async function withRig(body: (one: Rig) => Promise<void>): Promise<void> {
  const one = rig();
  try {
    await body(one);
  } finally {
    one.close();
  }
}

function data(answer: Answer): unknown {
  assert.equal(answer.status, 'ok', answer.text);
  return JSON.parse(answer.text);
}
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

test('/memory graph kinds answers the reader, deferred entries included', async () => {
  await withRig(async (one) => {
    assert.deepEqual(data(await one.say('/memory graph kinds')), json(graphKinds(one.db, INTERNAL)));
  });
});

test('/memory graph nodes reaches an isolated node, and pages by its flags', async () => {
  await withRig(async (one) => {
    const expected = graphNodes(one.db, INTERNAL, { kinds: null, limit: PAGE_ROWS, cursor: null });
    assert.deepEqual(data(await one.say('/memory graph nodes')), json(expected));
    assert.ok(expected.items.some((item) => item.id === node('isolated')));
    const first = data(await one.say('/memory graph nodes --limit 1')) as {
      items: Array<{ id: string }>;
      next: string;
    };
    assert.equal(first.items.length, 1);
    const second = data(await one.say(`/memory graph nodes --limit 1 --cursor ${first.next}`)) as {
      items: Array<{ id: string }>;
    };
    assert.notDeepEqual(second.items, first.items);
  });
});

test('/memory graph nodes passes its kinds filter down', async () => {
  await withRig(async (one) => {
    const page = data(await one.say('/memory graph nodes --kinds person')) as { items: Array<unknown>; total: number };
    assert.deepEqual([page.items, page.total], [[], 0]);
  });
});

test('/memory graph edges is active by default and historical by request', async () => {
  await withRig(async (one) => {
    assert.deepEqual(
      data(await one.say('/memory graph edges')),
      json(graphEdges(one.db, INTERNAL, { ...ACTIVE, limit: PAGE_ROWS, cursor: null }))
    );
    assert.deepEqual(
      data(await one.say('/memory graph edges --mode historical')),
      json(graphEdges(one.db, INTERNAL, { ...ACTIVE, mode: 'historical', limit: PAGE_ROWS, cursor: null }))
    );
  });
});

test('/memory graph edges passes its predicate, valid-time and recording filters down', async () => {
  await withRig(async (one) => {
    const ids = async (flags: string): Promise<Array<string>> =>
      (
        data(await one.say(`/memory graph edges --mode historical ${flags}`)) as { items: Array<{ id: string }> }
      ).items.map((item) => item.id);
    assert.deepEqual(await ids('--predicates quotes'), ['edge:bc']);
    assert.deepEqual(await ids('--recorded-before 2021-01-01T00:00:00.000Z'), ['edge:gone']);
  });
});

test('/memory graph node answers the reader, and an unknown node its code', async () => {
  await withRig(async (one) => {
    assert.deepEqual(
      data(await one.say(`/memory graph node ${node('a')}`)),
      json(graphNode(one.db, INTERNAL, node('a')))
    );
    const missing = await one.say('/memory graph node claim:unknown');
    assert.deepEqual([missing.status, missing.code], ['invalid', 'NODE_NOT_FOUND']);
  });
});

test('/memory graph neighbors passes its direction down', async () => {
  await withRig(async (one) => {
    const expected = graphNeighbors(one.db, INTERNAL, {
      ...ACTIVE,
      node: node('b'),
      direction: 'in',
      limit: PAGE_ROWS,
      cursor: null,
    });
    assert.deepEqual(data(await one.say(`/memory graph neighbors ${node('b')} --direction in`)), json(expected));
    assert.deepEqual(
      expected.items.map((item) => item.id),
      ['edge:ab']
    );
  });
});

test('/memory graph walk answers its visited nodes, edges and frontier', async () => {
  await withRig(async (one) => {
    const expected = graphWalk(one.db, INTERNAL, {
      ...ACTIVE,
      from: [node('a')],
      direction: 'out',
      maxDepth: 1,
      maxNodes: PAGE_ROWS,
      cursor: null,
    });
    assert.deepEqual(data(await one.say(`/memory graph walk ${node('a')} --depth 1`)), json(expected));
    assert.deepEqual(expected.frontier, [node('b')]);
  });
});

test('/memory graph path answers the reader, its reason when there is no path', async () => {
  await withRig(async (one) => {
    const expected = graphPath(one.db, INTERNAL, {
      ...ACTIVE,
      from: node('a'),
      to: node('c'),
      direction: 'out',
      maxDepth: 5,
    });
    assert.deepEqual(data(await one.say(`/memory graph path ${node('a')} ${node('c')} --depth 5`)), json(expected));
    const none = data(await one.say(`/memory graph path ${node('a')} ${node('isolated')} --depth 5`)) as {
      found: boolean;
      reason: string;
    };
    assert.deepEqual([none.found, none.reason], [false, 'none']);
  });
});

for (const [flag, value] of [
  ['--mode', 'sometimes'],
  ['--direction', 'sideways'],
  ['--depth', 'deep'],
  ['--nodes', '-1'],
  ['--limit', '0'],
] as const) {
  test(`/memory graph walk refuses ${flag} ${value} and reads nothing`, async () => {
    // Bug: a bad word falls back to a default, so the owner reads an unbounded walk as the one they asked for.
    await withRig(async (one) => {
      const line = `/memory graph walk ${node('a')} ${flag} ${value}`;
      const parsed = parseCommandLine(line);
      if (!parsed.ok) return;
      assert.equal((await one.say(line)).status, 'invalid');
    });
  });
}

test('a bad cursor answers invalid with its code', async () => {
  await withRig(async (one) => {
    const answer = await one.say('/memory graph edges --cursor garbage');
    assert.deepEqual([answer.status, answer.code], ['invalid', 'INSPECTION_BAD_CURSOR']);
  });
});

const READS = [
  '/memory graph kinds',
  '/memory graph nodes',
  '/memory graph edges --mode historical',
  `/memory graph node ${node('a')}`,
  `/memory graph neighbors ${node('a')}`,
  `/memory graph walk ${node('a')}`,
  `/memory graph path ${node('a')} ${node('c')}`,
];

test('a graph read runs no operation and changes no row, node_access included', async () => {
  // Bug: the walk goes through the tool that records a turn read, or a read witnesses what it opened.
  await withRig(async (one) => {
    const before = databaseDigest(one.db);
    assert.notEqual(before.node_access.split(':')[0], '0');
    for (const line of READS) assert.equal((await one.say(line)).status, 'ok', line);
    assert.deepEqual(one.ops, []);
    assert.deepEqual(databaseDigest(one.db), before);
  });
});

test('a closed database answers failed', async () => {
  const one = rig(true);
  try {
    for (const line of READS) assert.equal((await one.say(line)).status, 'failed', line);
  } finally {
    one.close();
  }
});

const T0 = Date.parse('2026-11-05T12:00:00.000Z');
const BOUNDS = { pageRows: 25, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300, maxSnapshots: 8 };
const BIG = 'ζ'.repeat(3 * 1024 * 1024);

type InspectRig = {
  memory: TestMemory;
  db: Db;
  ops: Array<string>;
  clock: { at: number };
  dir: string;
  /** One command as argv words, so a JSON word keeps its quotes and spaces. */
  say(...words: Array<string>): Promise<Answer>;
};

const rigs: Array<TestMemory> = [];
after(async () => {
  for (const memory of rigs) await memory.close();
});

function seed(db: Db): void {
  addAuthority(db, 'zeta', 'zeta/one');
  addPlace(db, { id: 'place:room', iface: 'zeta', authority: 'zeta/one' });
  addSource(db, {
    id: 'source:1',
    place: 'place:room',
    iface: 'zeta',
    audience: 'aud:group:zeta',
    text: 'κουνέλι κήπο',
  });
  addSource(db, {
    id: 'source:gone',
    place: 'place:room',
    iface: 'zeta',
    audience: 'aud:group:zeta',
    text: 'retired',
    retiredAt: '2026-11-02T00:00:00.000Z',
  });
  addEdge(db, { src: 'source:source:1', dst: 'place:place:room', predicate: 'located_in', audience: 'aud:group:zeta' });
  db.prepare(
    `INSERT INTO source_relations (id, source_id, predicate, target_key, recorded_at)
     VALUES (1, 'source:1', 'references', 'unresolved-native-key', '2026-11-01T00:00:00.000Z')`
  ).run();
  db.prepare(
    `INSERT INTO claims (id, subject_kind, subject_id, kind, text, truth, shown, audience_id, scope_kind, retired_at, created_at)
     VALUES ('claim:retired', 'place', 'place:room', 'detail', 'retired claim', 'current', 1, 'aud:internal', 'internal', '2026-11-03T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`
  ).run();
  db.exec('CREATE TABLE zz_big (id INTEGER PRIMARY KEY, body TEXT)');
  db.prepare('INSERT INTO zz_big VALUES (1, ?)').run(BIG);
}

/** The real service, on the calling thread, with its bounds in the live config; its own connection seeds the rows. */
async function inspectRig(): Promise<InspectRig> {
  const clock = { at: T0 };
  const dir = tempDir('nep-commands-inspect-');
  mkdirSync(join(dir, 'config'), { recursive: true });
  const memory = await openTestMemory({
    config: { memoryDb: { inspection: BOUNDS } },
    now: () => clock.at,
  });
  rigs.push(memory);
  const handle = memory.memoryDb.database();
  assert.ok(handle);
  seed(writable(memory));
  const ops: Array<string> = [];
  const desk = createConsole({
    runOp: (op) => {
      ops.push(op);
      return Promise.resolve({ status: 'failed', code: 'NOT_FOR_AN_INSPECTION', summary: '', data: null });
    },
    ownerReads: { lessons: () => '' },
    places: () => [],
    selfId: () => null,
    hot: memory.hot,
    privateDir: dir,
    dataDir: memory.dataDir,
    memoryDb: memory.memoryDb,
    usage: null,
    metrics: { samples: () => [] },
    chatLines: () => [],
    now: () => clock.at,
  });
  return {
    memory,
    db: handle,
    ops,
    clock,
    dir,
    say: async (...words) => {
      const parsed = parseCommandWords(words);
      assert.ok(parsed.ok, parsed.ok ? '' : `${words.join(' ')}: ${parsed.reason}`);
      const real = globalThis.fetch;
      globalThis.fetch = () => Promise.reject(new Error('an inspection reached the network'));
      try {
        return await desk.run(parsed.name, parsed.args, { id: 'owner' });
      } finally {
        globalThis.fetch = real;
      }
    },
  };
}

/** The service opens its database with the writer on this thread (`worker: false`), so its handle takes the seed's writes. */
function writable(memory: TestMemory): Db {
  const handle = memory.memoryDb.readHandle();
  assert.ok(handle);
  return dbOf(handle);
}

function inspectData<TData>(answer: Answer): TData {
  assert.equal(answer.status, 'ok', answer.text.slice(0, 300));
  return JSON.parse(answer.text) as TData;
}
type RowAnswer = { snapshot: string; row: InspectionRow };

async function everyRow(
  one: InspectRig,
  table: string,
  limit = '7'
): Promise<{ rows: Array<InspectionRow>; snapshot: string }> {
  const rows: Array<InspectionRow> = [];
  let page = inspectData<InspectionPage>(await one.say('memory', 'inspect', 'rows', table, '--limit', limit));
  rows.push(...page.items);
  const snapshot = page.snapshot;
  while (page.next !== null) {
    page = inspectData<InspectionPage>(
      await one.say('memory', 'inspect', 'rows', table, '--snapshot', snapshot, '--limit', limit, '--cursor', page.next)
    );
    rows.push(...page.items);
  }
  await one.say('memory', 'inspect', 'close', snapshot);
  return { rows, snapshot };
}

test('the page bound is read from the live config at each new snapshot', async () => {
  // Bug: the bound is cached at startup, against the rule that settings are read at the moment of use.
  const one = await inspectRig();
  const hot = one.memory.hot;
  const live = hot.config.memoryDb as { inspection: { pageRows: number } };
  live.inspection = { ...BOUNDS, pageRows: 1 };
  const page = inspectData<InspectionPage>(await one.say('memory', 'inspect', 'rows', 'sources', '--limit', '25'));
  assert.equal(page.items.length, 1);
  assert.equal(page.total, 2);
});

// ---------- domain routes ----------

const FAMILIES: ReadonlyArray<readonly [Array<string>, DomainFamily, string]> = [
  [['memory', 'sources', 'show', 'source:1'], 'sources', 'source:1'],
  [['memory', 'claims', 'show', 'claim:retired'], 'claims', 'claim:retired'],
];

for (const [words, family, id] of FAMILIES) {
  test(`${words.join(' ')} answers the domain reader, a retired or internal record included`, async () => {
    const one = await inspectRig();
    assert.deepEqual(
      inspectData(await one.say(...words)),
      json(domainDetail(one.db, { family, id, context: internalContext() }))
    );
  });
}

test('/memory sources list answers the domain page', async () => {
  const one = await inspectRig();
  const expected = domainList(one.db, {
    family: 'sources',
    context: internalContext(),
    limit: BOUNDS.pageRows,
    cursor: null,
  });
  assert.deepEqual(inspectData(await one.say('memory', 'sources', 'list')), json(expected));
});

test('/memory claims versions opens each version of the claim in order of recording', async () => {
  const one = await inspectRig();
  const write = writable(one.memory);
  const add = write.prepare(
    `INSERT INTO claim_versions (id, claim_id, text, recorded_at, event, by, origin, retired_at) VALUES (?, 'claim:retired', ?, ?, 'edit', 's', 's', ?)`
  );
  add.run('version:new', 'new', '2026-11-02T00:00:00.000Z', null);
  add.run('version:old', 'old', '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z');
  const { versions } = inspectData<{ versions: Array<{ id: string; rows: Array<InspectionRow> }> }>(
    await one.say('memory', 'claims', 'versions', 'claim:retired')
  );
  assert.deepEqual(
    versions.map((one2) => one2.id),
    ['version:old', 'version:new']
  );
  const rows = versions[0].rows;
  assert.deepEqual(cell(rows[0], 'text'), { kind: 'text', value: 'old' });
});

test('a record nobody stored answers invalid with its code', async () => {
  const one = await inspectRig();
  const answer = await one.say('memory', 'claims', 'show', 'claim:unknown');
  assert.deepEqual([answer.status, answer.code], ['invalid', 'RECORD_NOT_FOUND']);
});

// ---------- owner only, no write ----------

const INSPECT_READS: ReadonlyArray<Array<string>> = [
  ['memory', 'inspect', 'tables'],
  ['memory', 'inspect', 'schema', 'claims'],
  ['memory', 'inspect', 'rows', 'node_access'],
  ['memory', 'inspect', 'rows', 'turn_reads'],
  ['memory', 'sources', 'show', 'source:1'],
  ['memory', 'sources', 'list'],
  ['memory', 'claims', 'show', 'claim:retired'],
  ['memory', 'claims', 'versions', 'claim:retired'],
];

test('inspection runs no operation, reaches no network, and changes no row or setting', async () => {
  // Bug: a read goes through a tool, records a turn read, witnesses a node, or lands as a line in the persona's memory.
  const one = await inspectRig();
  const before = databaseDigest(one.db);
  assert.notEqual(before.node_access.split(':')[0], '0');
  const hot = one.memory.hot;
  const settings = JSON.stringify(hot.config);
  for (const words of INSPECT_READS) assert.equal((await one.say(...words)).status, 'ok', words.join(' '));
  await one.say('memory', 'inspect', 'export', join(one.dir, 'read.jsonl'));
  assert.deepEqual(one.ops, []);
  assert.deepEqual(databaseDigest(one.db), before);
  const oneHot = one.memory.hot;
  assert.equal(JSON.stringify(oneHot.config), settings);
});

test('a closed database answers failed, with no snapshot left behind', async () => {
  const one = await inspectRig();
  await one.memory.close();
  for (const words of INSPECT_READS) assert.equal((await one.say(...words)).status, 'failed', words.join(' '));
});

test('a row locator round-trips as one JSON word with spaces and quotes in its key', async () => {
  // Bug: the locator word goes through a line split, and a key with a space opens another row or none.
  const one = await inspectRig();
  writable(one.memory).exec(
    `CREATE TABLE spaced (k TEXT PRIMARY KEY, v TEXT); INSERT INTO spaced VALUES ('a "b" c', 'found');`
  );
  const { rows } = await everyRow(one, 'spaced');
  const locator: RowLocator = rows[0].locator;
  const opened = inspectData<RowAnswer>(await one.say('memory', 'inspect', 'row', 'spaced', JSON.stringify(locator)));
  assert.deepEqual(cell(opened.row, 'v'), { kind: 'text', value: 'found' });
});

const SEMANTIC_BOUNDS = { pageRows: 25, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300, maxSnapshots: 8 };
const SEMANTIC_INTERNAL = internalContext();

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

type SemanticRig = {
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
function semanticSeed(world: World): Seeded {
  const open = semanticAddSource(world, 'public', 'Alex works on Lumen; Orbis met in the room with Mira speaking');
  const secret = semanticAddSource(world, 'alex', 'Mira helps on Lumen; Hidden is mine');
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

const semanticRigs: Array<TestMemory> = [];
after(async () => {
  for (const memory of semanticRigs) await memory.close();
});

/** The seed through the writer on a file, then the real service over that file with the console on it. */
async function semanticRig(): Promise<SemanticRig> {
  const world = semanticWorld();
  const seeded = semanticSeed(world);
  world.handle.close();
  const dir = dirname(world.file);
  mkdirSync(join(dir, 'config'), { recursive: true });
  const memory = await openTestMemory({ dataDir: dir, config: { memoryDb: { inspection: SEMANTIC_BOUNDS } } });
  semanticRigs.push(memory);
  const db = memory.memoryDb.database();
  assert.ok(db);
  const ops: Array<string> = [];
  const desk = createConsole({
    runOp: (op) => {
      ops.push(op);
      return Promise.resolve({ status: 'failed', code: 'NOT_FOR_A_BROWSER_READ', summary: '', data: null });
    },
    ownerReads: { lessons: () => '' },
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

function semanticData<TData>(answer: Answer): TData {
  assert.equal(answer.status, 'ok', answer.text.slice(0, 300));
  return JSON.parse(answer.text) as TData;
}
const recordedAt = (db: Db, versionId: string): string =>
  String(db.prepare('SELECT recorded_at FROM claim_versions WHERE id = ?').get(versionId)?.recorded_at);
const entityNode = (id: string): string => graphNodeId('semantic_entity', id);
const personNode = (id: string): string => graphNodeId('person', id);

// ---- /memory entities ------------------------------------------------------------------------------------------------

test('/memory entities list answers the reader for the owner, a DM-only entity included', async () => {
  const one = await semanticRig();
  const { lumen, orbis, hidden, kite, kyte } = one.seeded;
  const answer = semanticData<{ items: Array<{ id: string }> }>(await one.say('memory', 'entities', 'list'));
  assert.deepEqual(
    answer,
    json(
      listEntities(one.db, {
        context: SEMANTIC_INTERNAL,
        filters: { kind: null, name: null },
        recordedBefore: null,
        limit: SEMANTIC_BOUNDS.pageRows,
        cursor: null,
      })
    )
  );
  assert.deepEqual(answer.items.map((item) => item.id).sort(), [lumen, orbis, hidden, kite, kyte].sort());
});

test('/memory entities list passes its kind, name and cutoff down', async () => {
  const one = await semanticRig();
  const { lumen, orbis, hidden, lumenName, hiddenName } = one.seeded;
  const ids = async (...flags: Array<string>): Promise<Array<string>> =>
    semanticData<{ items: Array<{ id: string }> }>(await one.say('memory', 'entities', 'list', ...flags))
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
  const one = await semanticRig();
  const { hidden } = one.seeded;
  assert.deepEqual(
    semanticData(await one.say('memory', 'entities', 'show', hidden)),
    json(entityDetail(one.db, hidden, { context: SEMANTIC_INTERNAL, recordedBefore: null }))
  );
  const missing = await one.say('memory', 'entities', 'show', 'ent:nobody');
  assert.deepEqual([missing.status, missing.code], ['invalid', 'ENTITY_NOT_FOUND']);
});

test('/memory entities names lists a DM alias for the owner with the version that says it', async () => {
  const one = await semanticRig();
  const { lumen, lumenName, moth } = one.seeded;
  const { names } = semanticData<{ names: Array<{ text: string; role: string; versionId: string }> }>(
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
  const one = await semanticRig();
  const { lumen, works1, works2, kai, mira, event } = one.seeded;
  const versions = async (...flags: Array<string>): Promise<Array<string>> =>
    semanticData<{ items: Array<{ versionId: string }> }>(
      await one.say('memory', 'entities', 'relations', lumen, ...flags)
    )
      .items.map((item) => item.versionId)
      .sort();
  assert.deepEqual(
    semanticData(await one.say('memory', 'entities', 'relations', lumen)),
    json(
      entityRelations(one.db, {
        context: SEMANTIC_INTERNAL,
        entityId: lumen,
        predicates: null,
        mode: 'active',
        recordedBefore: null,
        limit: SEMANTIC_BOUNDS.pageRows,
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
  // Bug: a bad word falls back to the active mode, and the owner reads current facts as the history they asked for.
  const one = await semanticRig();
  const bad = await one.say('memory', 'entities', 'relations', one.seeded.lumen, '--mode', 'sometimes');
  assert.deepEqual([bad.status, bad.code], ['invalid', 'INSPECTION_BAD_ARGUMENT']);
  const missing = await one.say('memory', 'entities', 'relations', 'ent:nobody');
  assert.deepEqual([missing.status, missing.code], ['invalid', 'ENTITY_NOT_FOUND']);
});

const SEMANTIC_READS: ReadonlyArray<(seeded: Seeded) => Array<string>> = [
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
  // Bug: a read records a turn read, witnesses a node, re-projects labels or flags a review, which changes the persona's memory.
  const one = await semanticRig();
  const before = databaseDigest(one.db);
  const hot = one.memory.hot;
  const settings = JSON.stringify(hot.config);
  for (const read of SEMANTIC_READS) {
    const words = read(one.seeded);
    assert.equal((await one.say(...words)).status, 'ok', words.join(' '));
  }
  assert.deepEqual(one.ops, []);
  assert.deepEqual(databaseDigest(one.db), before);
  const oneHot = one.memory.hot;
  assert.equal(JSON.stringify(oneHot.config), settings);
});

const NOW = Date.parse('2026-11-05T12:00:00Z');
const BROWSE_BOUNDS = { pageRows: 50, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300, maxSnapshots: 8 };

type BrowseRig = {
  db: Db;
  writes: Array<Row>;
  ops: Array<string>;
  say(line: string): Promise<Answer>;
  close(): void;
};

/** A console over a file-backed database opened read-only, so a direct write would fail, with a recording writer. */
function browseRig(seed: (db: Db) => void = seedBrowser, memory: { closed: boolean } = { closed: false }): BrowseRig {
  const dir = tempDir('nep-commands-memory-');
  mkdirSync(join(dir, 'config'), { recursive: true });
  const file = join(dir, 'memory.db');
  const writer = openMemoryDb(file);
  seed(dbOf(writer));
  writer.close();
  const reader: MemoryHandle = openMemoryDb(file, { readOnly: true });
  const writes: Array<Row> = [];
  const ops: Array<string> = [];
  const deps: ConsoleDeps = {
    runOp: (op) => {
      ops.push(op);
      return Promise.resolve({ status: 'failed', code: 'NOT_FOR_A_BROWSER_READ', summary: '', data: null });
    },
    ownerReads: { lessons: () => '' },
    places: () => [],
    selfId: () => null,
    hot: { config: { memoryDb: { file: 'memory.db', inspection: BROWSE_BOUNDS } } },
    privateDir: dir,
    dataDir: dir,
    memoryDb: {
      database: () => (memory.closed ? null : dbOf(reader)),
      personLink: (update: Row) => {
        writes.push(update);
        return Promise.resolve({ ok: true, person: null });
      },
    },
    usage: null,
    metrics: { samples: () => [] },
    chatLines: () => [],
    now: () => NOW,
  };
  const desk = createConsole(deps);
  return {
    db: dbOf(reader),
    writes,
    ops,
    say: async (line) => {
      const parsed = parseCommandLine(line);
      assert.ok(parsed.ok, parsed.ok ? '' : `${line}: ${parsed.reason}`);
      const real = globalThis.fetch;
      globalThis.fetch = () => Promise.reject(new Error('a memory read reached the network'));
      try {
        return await desk.run(parsed.name, parsed.args, { id: 'owner' });
      } finally {
        globalThis.fetch = real;
      }
    },
    close: () => reader.close(),
  };
}

function seedBrowser(db: Db): void {
  seedOpaqueWorld(db);
  addAccount(db, {
    id: 'account:u1',
    iface: 'discord',
    authority: 'discord/global',
    native: 'n9',
    person: null,
    link: 'proposed',
  });
  addPlace(db, { id: 'place:server', iface: 'zeta', authority: 'zeta/one', kind: 'server' });
  addPlace(db, { id: 'place:room', iface: 'zeta', authority: 'zeta/one', parent: 'place:server' });
  addPlace(db, { id: 'place:deep', iface: 'zeta', authority: 'zeta/one', parent: 'place:room' });
  addDescription(db, {
    id: 'desc:deep',
    subjectKind: 'place',
    subject: 'place:deep',
    field: 'topic',
    audience: 'aud:group:zeta',
    text: 'βαθιά',
  });
  db.prepare(
    `INSERT INTO claims (id, subject_kind, subject_id, kind, text, truth, shown, audience_id, scope_kind, created_at)
     VALUES ('claim:lore', 'place', 'place:server', 'lore', 'the lore', 'current', 1, 'aud:group:zeta', 'group', '2026-11-01T00:00:00.000Z')`
  ).run();
}

async function browseWithRig(body: (one: BrowseRig) => Promise<void>, seed?: (db: Db) => void): Promise<void> {
  const one = browseRig(seed);
  try {
    await body(one);
  } finally {
    one.close();
  }
}
const NO_FILTERS = { name: null, interfaceId: null, authorityId: null };
const PLACES = { interfaceId: null, authorityId: null, rootsOnly: false };

// ---------- families whose word has as many letters as `users` ----------

for (const family of ['media', 'turns'] as const) {
  test(`/memory ${family} list answers the ${family} page, not the people list`, async () => {
    // Bug: the people reader sliced `memory.users.` off any name without checking it, so a five-letter family read people.
    await browseWithRig(async (one) => {
      const expected = domainList(one.db, {
        family,
        context: internalContext(),
        limit: BROWSE_BOUNDS.pageRows,
        cursor: null,
      });
      assert.deepEqual(data(await one.say(`/memory ${family} list`)), json(expected));
    });
  });
}

// ---------- users ----------

test('/memory users list answers the reader page itself', async () => {
  // Bug: a panel-shaped text list that a script has to parse, with the typed ids lost in the wording.
  await browseWithRig(async (one) => {
    const expected = listPeople(one.db, {
      context: internalContext(),
      filters: NO_FILTERS,
      limit: BROWSE_BOUNDS.pageRows,
      cursor: null,
    });
    assert.deepEqual(data(await one.say('/memory users list')), json(expected));
  });
});

test('the limit and cursor flags walk the whole list, and a page reports what it left out', async () => {
  await browseWithRig(async (one) => {
    const whole = data(await one.say('/memory users list')) as { items: Array<{ id: string }>; total: number };
    const seen: Array<string> = [];
    let line = '/memory users list --limit 1';
    for (let turn = 0; turn < whole.total + 1; turn += 1) {
      const page = data(await one.say(line)) as {
        items: Array<{ id: string }>;
        next: string | null;
        total: number;
        truncated: boolean;
      };
      assert.equal(page.total, whole.total);
      seen.push(...page.items.map((item) => item.id));
      if (page.next === null) break;
      assert.equal(page.truncated, true);
      line = `/memory users list --limit 1 --cursor ${page.next}`;
    }
    assert.deepEqual(
      seen,
      whole.items.map((item) => item.id)
    );
  });
});

test('the page bound comes from memoryDb.inspection when no limit is given', async () => {
  await browseWithRig(
    async (one) => {
      const page = data(await one.say('/memory users list')) as { items: Array<unknown> };
      assert.ok(page.items.length <= BROWSE_BOUNDS.pageRows);
      const many = data(await one.say('/memory users list --limit 100000')) as { items: Array<unknown> };
      assert.ok(many.items.length <= BROWSE_BOUNDS.pageRows);
    },
    (db) => {
      seedBrowser(db);
      const add = db.prepare('INSERT INTO people (id, first_seen_at) VALUES (?, ?)');
      for (let n = 0; n < BROWSE_BOUNDS.pageRows + 5; n += 1) add.run(`person:bulk-${n}`, '2026-11-01T00:00:00.000Z');
    }
  );
});

test('/memory users show answers the reader detail itself', async () => {
  await browseWithRig(async (one) => {
    assert.deepEqual(
      data(await one.say(`/memory users show ${ANNA}`)),
      json(personDetail(one.db, ANNA, internalContext()))
    );
  });
});

test('/memory users private answers the person-wide private view', async () => {
  // Bug: the leaf keeps reading one interface's profile, so a second account's DM is missing.
  await browseWithRig(async (one) => {
    assert.deepEqual(
      data(await one.say(`/memory users private ${ANNA}`)),
      json(privateByPerson(one.db, ANNA, internalContext()))
    );
  });
});

test('/memory users accounts, names and relationship answer their part of the detail', async () => {
  await browseWithRig(async (one) => {
    const detail = personDetail(one.db, ANNA, internalContext());
    assert.ok(detail.found);
    assert.deepEqual(
      data(await one.say(`/memory users accounts ${ANNA}`)),
      json({ accounts: detail.accounts, links: detail.links })
    );
    assert.deepEqual(data(await one.say(`/memory users names ${ANNA}`)), json({ names: detail.names }));
    assert.deepEqual(data(await one.say(`/memory users relationship ${ANNA}`)), json({ affinity: detail.affinity }));
  });
});

test('a person nobody stored answers invalid with its code', async () => {
  await browseWithRig(async (one) => {
    const answer = await one.say('/memory users show person:unknown');
    assert.deepEqual([answer.status, answer.code], ['invalid', 'PERSON_NOT_FOUND']);
  });
});

test('a bad cursor answers invalid with its code and no partial page', async () => {
  await browseWithRig(async (one) => {
    const answer = await one.say('/memory users list --cursor garbage');
    assert.deepEqual([answer.status, answer.code], ['invalid', 'INSPECTION_BAD_CURSOR']);
  });
});

// The tests of `/memory users link` writing through the one writer and refusing an unknown account are gone with the
// command: `/memory bind` links an account (plan 2026-11-08-meta-person, slice 7), and
// tests/src/memory/db/person-bind.test.ts covers its writer and its refusals.

// ---------- places ----------

test('/memory places list answers the reader page, with its filters', async () => {
  await browseWithRig(async (one) => {
    const expected = listPlaces(one.db, {
      context: internalContext(),
      filters: { ...PLACES, interfaceId: 'zeta', rootsOnly: true },
      limit: BROWSE_BOUNDS.pageRows,
      cursor: null,
    });
    assert.deepEqual(data(await one.say('/memory places list --interface zeta --roots')), json(expected));
  });
});

test('/memory places show with include-children reaches descendant descriptions', async () => {
  // Bug: the retired `/memory server` read one level, and the flag is parsed but not passed down.
  await browseWithRig(async (one) => {
    const wide = placeDetail(one.db, 'place:server', { context: internalContext(), includeChildren: true });
    assert.deepEqual(data(await one.say('/memory places show place:server --include-children')), json(wide));
    const narrow = placeDetail(one.db, 'place:server', { context: internalContext(), includeChildren: false });
    assert.deepEqual(data(await one.say('/memory places show place:server')), json(narrow));
    assert.ok(wide.found && wide.descriptions.some((entry) => entry.id === 'desc:deep'));
  });
});

test('/memory places tree answers the descendants with their depth', async () => {
  await browseWithRig(async (one) => {
    const tree = data(await one.say('/memory places tree place:server')) as {
      descendants: Array<{ id: string; depth: number }>;
    };
    assert.deepEqual(
      tree.descendants.map((entry) => [entry.id, entry.depth]),
      [
        ['place:room', 1],
        ['place:deep', 2],
      ]
    );
  });
});

test('bare /memory places lore is no command, and places show lists the lore claim among the records', async () => {
  // Catches: two readers of one lore kept apart, or the merge losing the lore claim from the place's records (CLI
  // audit 2026-11-09).
  assert.equal(parseCommandLine('/memory places lore place:server').ok, false);
  await browseWithRig(async (one) => {
    const shown = data(await one.say('/memory places show place:server')) as {
      records: Array<{ table: string; id: string }>;
    };
    assert.ok(
      shown.records.some((record) => record.table === 'claims' && record.id === 'claim:lore'),
      JSON.stringify(shown.records)
    );
  });
});

test('a place nobody stored answers invalid with its code', async () => {
  await browseWithRig(async (one) => {
    const answer = await one.say('/memory places show place:unknown');
    assert.deepEqual([answer.status, answer.code], ['invalid', 'PLACE_NOT_FOUND']);
  });
});

// ---------- every read ----------

const BROWSE_READS = [
  '/memory users list',
  `/memory users show ${ANNA}`,
  `/memory users accounts ${ANNA}`,
  `/memory users names ${ANNA}`,
  `/memory users relationship ${ANNA}`,
  `/memory users private ${ANNA}`,
  '/memory places list',
  '/memory places tree place:server',
  '/memory places show place:server --include-children',
];

test('a browser read runs no operation, reaches no network and changes no row', async () => {
  // Bug: a read goes through `runOp` and a tool that records a turn read, or through the model's memory path.
  await browseWithRig(async (one) => {
    const before = databaseDigest(one.db);
    for (const line of BROWSE_READS) assert.equal((await one.say(line)).status, 'ok', line);
    assert.deepEqual(one.ops, []);
    assert.deepEqual(one.writes, []);
    assert.deepEqual(databaseDigest(one.db), before);
  });
});

test('a closed database answers failed and throws nothing', async () => {
  const memory = { closed: true };
  const one = browseRig(seedBrowser, memory);
  try {
    for (const line of BROWSE_READS) assert.equal((await one.say(line)).status, 'failed', line);
  } finally {
    one.close();
  }
});

const EXPORT_NOW = Date.parse('2026-11-06T12:00:00.000Z');
const EXPORT_BOUNDS = { pageRows: 25, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300, maxSnapshots: 8 };
const ROW_BYTES = 2 * 1024 * 1024;
const ROWS = 60;
/** The longest the main thread may go without running a timer while an export writes. */
const MAX_GAP_MS = 100;

const opened: Array<TestMemory> = [];
after(async () => {
  for (const memory of opened) await memory.close();
});

/** The real memory service with `ROWS` rows of `ROW_BYTES` each in one table (about 120 MB of export), and a console over it. */
async function exportRig() {
  const dir = tempDir('nep-inspect-export-off-main-');
  const memory = await openTestMemory({ config: { memoryDb: { inspection: EXPORT_BOUNDS } }, now: () => EXPORT_NOW });
  opened.push(memory);
  const handle = memory.memoryDb.readHandle();
  assert.ok(handle);
  const db = dbOf(handle);
  db.exec('CREATE TABLE zz_large (id INTEGER PRIMARY KEY, body TEXT)');
  const insert = db.prepare('INSERT INTO zz_large VALUES (?, ?)');
  for (let i = 1; i <= ROWS; i += 1) insert.run(i, String.fromCharCode(97 + (i % 26)).repeat(ROW_BYTES));
  const tracked: Array<string> = [];
  const desk = createConsole({
    runOp: () => Promise.reject(new Error('no operation runs in these tests')),
    ownerReads: { lessons: () => '' },
    places: () => [],
    selfId: () => null,
    hot: memory.hot,
    privateDir: dir,
    dataDir: memory.dataDir,
    memoryDb: memory.memoryDb,
    usage: null,
    metrics: { samples: () => [] },
    chatLines: () => [],
    now: () => EXPORT_NOW,
    track: (name, fn) => {
      tracked.push(name);
      return fn();
    },
  });
  return {
    memory,
    dir,
    tracked,
    exportTo: (file: string): Promise<Answer> => desk.run('memory.inspect.export', { file }, { id: 'owner' }),
  };
}

const lines = (file: string): Array<Record<string, unknown>> =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

test('the event loop keeps running while /memory inspect export writes a large database', async () => {
  // Bug: the export writes synchronously on the core's thread and the loop stalls for the whole write (25 s measured).
  const { exportTo, dir, tracked } = await exportRig();
  const file = path.join(dir, 'export.jsonl');
  let last = performance.now();
  let widest = 0;
  let ticks = 0;
  const ticker = setInterval(() => {
    const at = performance.now();
    widest = Math.max(widest, at - last);
    last = at;
    ticks += 1;
  }, 5);
  const answer = await exportTo(file).finally(() => clearInterval(ticker));
  assert.equal(answer.status, 'ok', answer.text.slice(0, 300));
  assert.ok(widest < MAX_GAP_MS, `the longest gap between timer ticks was ${Math.round(widest)} ms`);
  assert.ok(ticks >= 5, `ticks during the export: ${ticks}`);
  assert.ok(fs.statSync(file).size > ROWS * ROW_BYTES, 'the file holds the large rows whole');
  assert.ok(tracked.includes('memory.inspect.export'), 'the export names itself with track, so a stall attributes');
});

test('the export from the thread has mode 0600 whatever the umask, and no partial file is left beside it', async () => {
  // Bug: the file of the persona's whole memory readable by every user on the machine, or a half-written file left in the folder.
  const { exportTo, dir } = await exportRig();
  const file = path.join(dir, 'export.jsonl');
  const umask = process.umask(0);
  let answer: Answer;
  try {
    answer = await exportTo(file);
  } finally {
    process.umask(umask);
  }
  assert.equal(answer.status, 'ok', answer.text.slice(0, 300));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.endsWith('.partial')),
    []
  );
});

test('the export from the thread refuses a file that exists, leaves it, and answers with the same code', async () => {
  // Bug: the thread loses the refusal's code and the owner reads a bare failure, or it overwrites the file.
  const { exportTo, dir } = await exportRig();
  const file = path.join(dir, 'taken.jsonl');
  fs.writeFileSync(file, 'keep me');
  const answer = await exportTo(file);
  assert.equal(answer.code, 'INSPECTION_EXPORT_EXISTS');
  assert.notEqual(answer.status, 'ok');
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep me');
});

test('the export from the thread holds the header, the catalog and the manifest the in-thread export wrote', async () => {
  // Bug: the thread exports another moment, another revision or a different row count than the core's own writer.
  const { exportTo, dir, memory } = await exportRig();
  const port = memory.memoryDb.inspection();
  assert.ok(port);
  const inThread = path.join(dir, 'in-thread.jsonl');
  const handle = port.openInspection({ ownerId: 'owner', bounds: EXPORT_BOUNDS });
  try {
    writeInspectionExport(port, handle, { file: inThread });
  } finally {
    port.closeInspection(handle);
  }
  const fromThread = path.join(dir, 'from-thread.jsonl');
  assert.equal((await exportTo(fromThread)).status, 'ok');
  const [headA, catalogA, ...restA] = lines(inThread);
  const [headB, catalogB, ...restB] = lines(fromThread);
  assert.equal(headB.kind, 'header');
  assert.equal(headB.engineRevision, headA.engineRevision);
  assert.equal(headB.memoryVersion, headA.memoryVersion);
  assert.equal(headB.boardVersion, headA.boardVersion);
  assert.deepEqual(catalogB, catalogA);
  const manifestA = restA.at(-1);
  const manifestB = restB.at(-1);
  assert.equal(manifestB?.kind, 'manifest');
  assert.deepEqual(manifestB, manifestA);
  assert.equal(restB.length, restA.length);
  assert.equal((manifestB?.rows as Record<string, number>).zz_large, ROWS);
});

test('an export into a folder that does not exist fails with a reason and leaves no file', async () => {
  // Bug: the thread's failure is swallowed and the owner is told the export is done.
  const { exportTo, dir } = await exportRig();
  const file = path.join(dir, 'nowhere', 'export.jsonl');
  const answer = await exportTo(file);
  assert.equal(answer.status, 'failed');
  assert.ok(answer.text.length > 0);
  assert.equal(fs.existsSync(file), false);
});

const AT = '2026-11-01T00:00:00.000Z';
const CAROL = 'person:c4r01-synthetic';
const CAROL_PLACE = 'place:dm-c31';

/** The opaque world, with Boris's line and vector in Boris's DM, a group fact about Boris, and Carol's DM that mentions Boris. */
function seedWorld(db: Db): void {
  seedOpaqueWorld(db);
  addClaim(db, 'claim:b21-public', BORIS, 'aud:group:discord');
  addEpisode(db, 'episode:b21', BORIS, BORIS_PLACE);
  addAccount(db, { id: 'account:c31', iface: 'telegram', authority: 'telegram/global', native: 'n3', person: CAROL });
  addDmPlace(db, {
    id: CAROL_PLACE,
    iface: 'telegram',
    authority: 'telegram/global',
    account: 'account:c31',
    person: CAROL,
  });
  addClaim(db, 'claim:about-boris-in-carols-dm', BORIS, `aud:dm:${CAROL_PLACE}`);
  db.prepare("UPDATE claims SET from_person = ? WHERE id = 'claim:about-anna-in-his-dm'").run(BORIS);
  db.prepare(
    `INSERT INTO sources (id, kind, iface, place_id, author_account, author_kind, occurred_at, recorded_at, text,
       audience_id, scope_kind, scope_iface, scope_dm)
     VALUES ('source:b21', 'seen', 'telegram', ?, ?, 'account', ?, ?, 'a synthetic line', ?, 'dm', 'telegram', ?)`
  ).run(BORIS_PLACE, BORIS_ACCOUNT, AT, AT, `aud:dm:${BORIS_PLACE}`, BORIS);
  db.prepare(
    `INSERT INTO vectors (source_rowid, item_id, chunk_key, model, dims, context, occurred_at, scope_kind, scope_iface,
       scope_dm, audience_id)
     VALUES ((SELECT rowid FROM sources WHERE id = 'source:b21'), 'source:b21', 'chunk:b21', 'test/embedder', 4, '{}', ?,
       'dm', 'telegram', ?, ?)`
  ).run(AT, BORIS, `aud:dm:${BORIS_PLACE}`);
  db.prepare('UPDATE people SET affinity = 40 WHERE id = ?').run(ANNA);
  db.prepare('UPDATE people SET affinity = 5 WHERE id = ?').run(BORIS);
  for (const person of [ANNA, BORIS])
    db.prepare(
      `INSERT INTO relationship_daily (person_id, day, audience_id, addressed_by_them, addressed_by_her, meaningful)
       VALUES (?, '2026-11-01', 'aud:group:discord', 2, 1, 0)`
    ).run(person);
}

/** The owner's console over a read-only file of the world, with a writer that records what it is asked. */
function consoleRig(): {
  say(line: string): Promise<{ status: string; code?: string; text: string }>;
  writes: Array<Row>;
} {
  const dir = tempDir('nep-merge-console-');
  mkdirSync(join(dir, 'config'), { recursive: true });
  const file = join(dir, 'memory.db');
  const writer = openMemoryDb(file);
  seedWorld(dbOf(writer));
  writer.close();
  const reader = openMemoryDb(file, { readOnly: true });
  const writes: Array<Row> = [];
  const deps: ConsoleDeps = {
    runOp: () => Promise.resolve({ status: 'failed', code: 'NOT_FOR_A_MERGE', summary: '', data: null }),
    ownerReads: { lessons: () => '' },
    places: () => [],
    selfId: () => null,
    hot: {
      config: {
        memoryDb: {
          file: 'memory.db',
          inspection: { pageRows: 50, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300, maxSnapshots: 8 },
        },
      },
    },
    privateDir: dir,
    dataDir: dir,
    memoryDb: {
      database: () => dbOf(reader),
      personLink: () => Promise.resolve({ ok: true, person: null }),
      personMerge: (update: Row) => {
        writes.push(update);
        return Promise.resolve({ ok: true, id: 'merge:x', survivor: ANNA, moved: {} });
      },
    },
    usage: null,
    metrics: { samples: () => [] },
    chatLines: () => [],
    now: () => NOW,
  };
  const desk = createConsole(deps);
  return {
    writes,
    say: async (line) => {
      const parsed = parseCommandLine(line);
      assert.ok(parsed.ok, parsed.ok ? '' : `${line}: ${parsed.reason}`);
      return desk.run(parsed.name, parsed.args, { id: 'owner' });
    },
  };
}

test("/memory users merge goes through the one writer as the owner, with the owner's reason", async () => {
  // Bug: the console merges over its own connection, a second writer on the persona's memory, or records the merge as nobody's.
  const rig = consoleRig();
  const answer = await rig.say(`/memory users merge ${BORIS} ${ANNA} --reason same`);
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual(
    rig.writes.map(({ from, into, by, reason }) => ({ from, into, by, reason })),
    [{ from: BORIS, into: ANNA, by: 'owner', reason: 'same' }]
  );
});

test('/memory users merge of a person nobody stored answers invalid and writes nothing', async () => {
  const rig = consoleRig();
  const answer = await rig.say(`/memory users merge person:nobody ${ANNA}`);
  assert.deepEqual([answer.status, answer.code], ['invalid', 'PERSON_NOT_FOUND']);
  assert.deepEqual(rig.writes, []);
});
