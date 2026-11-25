import { after, test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createConsole } from '../../../../src/interface/commands/console.ts';
import type { Answer } from '../../../../src/interface/commands/console.ts';
import { parseCommandWords, parseCommandLine } from '../../../../src/interface/commands/table.ts';
import type { InspectionRow } from '../../../../src/memory/db/inspection.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db } from '../../../../src/memory/db/types.ts';
import {
  actualTableNames,
  addAuthority,
  addEdge,
  addPlace,
  addSource,
  cell,
  countOf,
} from '../../../fixtures/memory-db/browser-world.ts';
import { openTestMemory } from '../../../fixtures/memory-db/service.ts';
import type { TestMemory } from '../../../fixtures/memory-db/service.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { parseRequest } from '../../../../bin/neptunia-request.ts';
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
import path from 'node:path';
import { exportInspectionInWorker } from '../../../../src/memory/db/inspection-export.ts';

const T0 = Date.parse('2026-11-05T12:00:00.000Z');
const BOUNDS = { pageRows: 25, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300, maxSnapshots: 8 };
const BIG = 'ζ'.repeat(3 * 1024 * 1024);

type Rig = {
  memory: TestMemory;
  db: Db;
  ops: Array<string>;
  clock: { at: number };
  dir: string;
  /** One command as argv words, so a JSON word keeps its quotes and spaces. */
  say(...words: Array<string>): Promise<Answer>;
};

const rigs: Array<TestMemory> = [];

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
async function rig(): Promise<Rig> {
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

function data<TData>(answer: Answer): TData {
  assert.equal(answer.status, 'ok', answer.text.slice(0, 300));
  return JSON.parse(answer.text) as TData;
}

describe('commands memory inspect', () => {
  after(async () => {
    for (const memory of rigs) await memory.close();
  });

  // ---------- export ----------

  test('/memory inspect export writes a complete file at mode 0600, counts reconciled', async () => {
    // Bug: the export is a domain dump, or the file of the persona's whole memory is left readable by every user on the machine.
    const one = await rig();
    const file = join(one.dir, 'export.jsonl');
    const umask = process.umask(0);
    let answer: Answer;
    try {
      answer = await one.say('memory', 'inspect', 'export', file);
    } finally {
      process.umask(umask);
    }
    const { manifest } = data<{ file: string; manifest: { tables: number; rows: Record<string, number> } }>(answer);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const tables = actualTableNames(one.db);
    assert.deepEqual(manifest.rows, Object.fromEntries(tables.map((table) => [table, countOf(one.db, table)])));
    const records = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { kind: string; table?: string; row?: InspectionRow });
    assert.equal(
      records.filter((record) => record.kind === 'row').length,
      Object.values(manifest.rows).reduce((sum, n) => sum + n, 0)
    );
    const big = records.find((record) => record.table === 'zz_big');
    assert.ok(big?.row);
    assert.deepEqual(cell(big.row, 'body'), { kind: 'text', value: BIG });
  });

  test('/memory inspect export refuses a file that exists and leaves it', async () => {
    const one = await rig();
    const file = join(one.dir, 'taken.jsonl');
    writeFileSync(file, 'keep me');
    const answer = await one.say('memory', 'inspect', 'export', file);
    assert.equal(answer.code, 'INSPECTION_EXPORT_EXISTS');
    assert.equal(readFileSync(file, 'utf8'), 'keep me');
  });

  test('an export to a folder that does not exist fails and claims nothing', async () => {
    const one = await rig();
    const file = join(one.dir, 'nowhere', 'export.jsonl');
    const answer = await one.say('memory', 'inspect', 'export', file);
    assert.equal(answer.status, 'failed');
    assert.equal(existsSync(file), false);
  });
});

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

/** The seed through the writer on a file, then the real service over that file with the console on it. */
async function semanticRig(): Promise<SemanticRig> {
  const world = semanticWorld();
  const seeded = semanticSeed(world);
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

describe('commands memory semantic', () => {
  after(async () => {
    for (const memory of rigs) await memory.close();
  });

  test('/memory inspect export carries every semantic table and FTS shadow, counts reconciled', async () => {
    const one = await semanticRig();
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
});

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const ROW_BYTES = 2 * 1024 * 1024;
const ROWS = 60;

const opened: Array<TestMemory> = [];

/** The real memory service with `ROWS` rows of `ROW_BYTES` each in one table (about 120 MB of export), and a console over it. */
async function mainRig() {
  const dir = tempDir('nep-inspect-export-off-main-');
  const memory = await openTestMemory({ config: { memoryDb: { inspection: BOUNDS } }, now: () => NOW });
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
    now: () => NOW,
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

/** The arguments of one export from a thread, over the rig's database. */
function exportArgs(memory: TestMemory, dir: string) {
  return {
    db: path.join(memory.dataDir, 'memory.db'),
    file: path.join(dir, 'never.jsonl'),
    ownerId: 'owner',
    bounds: BOUNDS,
    engineRevision: 'abc1234',
    at: NOW,
  };
}

describe('memory inspect export off main', () => {
  after(async () => {
    for (const memory of opened) await memory.close();
  });

  test('exportInspectionInWorker rejects when its thread dies with an error', async () => {
    // Bug: a thread that crashes leaves the owner's command waiting for ever, or answering ok.
    const { memory, dir } = await mainRig();
    await assert.rejects(
      exportInspectionInWorker(
        exportArgs(memory, dir),
        new URL('../../../fixtures/memory-db/export-worker-throws.ts', import.meta.url)
      ),
      /export thread blew up/
    );
  });

  test('exportInspectionInWorker rejects when its thread ends without an answer', async () => {
    // Bug: the promise never settles when the thread exits quietly, so the command hangs.
    const { memory, dir } = await mainRig();
    await assert.rejects(
      exportInspectionInWorker(
        exportArgs(memory, dir),
        new URL('../../../fixtures/memory-db/export-worker-silent.ts', import.meta.url)
      ),
      /without an answer/
    );
  });
});
