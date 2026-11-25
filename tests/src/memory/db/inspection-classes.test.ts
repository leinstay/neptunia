// Tests for src/memory/db/inspection-classes.ts: the class of a table is told by its kind first, and by the engine's
// own list after. The last test holds the list against the whole schema.
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { storageClassOf } from '../../../../src/memory/db/inspection-classes.ts';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createConsole } from '../../../../src/interface/commands/console.ts';
import type { Answer } from '../../../../src/interface/commands/console.ts';
import { parseCommandWords } from '../../../../src/interface/commands/table.ts';
import type { InspectionCatalog } from '../../../../src/memory/db/inspection.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db } from '../../../../src/memory/db/types.ts';
import { addAuthority, addEdge, addPlace, addSource } from '../../../fixtures/memory-db/browser-world.ts';
import { openTestMemory } from '../../../fixtures/memory-db/service.ts';
import type { TestMemory } from '../../../fixtures/memory-db/service.ts';
import { tempDir } from '../../../fixtures/tmp.ts';

test('an FTS table and its shadows are derived whatever they are called', () => {
  // Bug: a shadow named like a business table is presented as an independent record.
  assert.equal(storageClassOf('claims', 'virtual'), 'derived');
  assert.equal(storageClassOf('claims_data', 'shadow'), 'derived');
});

test("SQLite's own tables are metadata", () => {
  assert.equal(storageClassOf('sqlite_sequence', 'sqlite'), 'metadata');
});

test('a table the engine lists has its class, and one it does not is unclassified and never guessed', () => {
  // Bug: a default class calls a new table's rows something they may not be.
  assert.equal(storageClassOf('claims', 'table'), 'domain');
  assert.equal(storageClassOf('leases', 'table'), 'operational');
  assert.equal(storageClassOf('future_family', 'table'), 'unclassified');
});

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

type TablesAnswer = { snapshot: string; catalog: InspectionCatalog };

describe('commands memory inspect', () => {
  after(async () => {
    for (const memory of rigs) await memory.close();
  });

  test('no table the engine ships is left unclassified', async () => {
    // Fails on purpose when a migration adds a table: the new table reads fine, and its author classifies it here too.
    const one = await rig();
    writable(one.memory).exec('DROP TABLE zz_big');
    const { catalog } = data<TablesAnswer>(await one.say('memory', 'inspect', 'tables'));
    assert.deepEqual(
      catalog.tables.filter((table) => table.storageClass === 'unclassified').map((table) => table.name),
      []
    );
  });
});
