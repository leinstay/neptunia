// `/memory inspect` and the domain routes from the owner's line to the answer, over the real memory service. The whole
// database is reachable through a snapshot the console holds for the owner: every table, every row, full values and a complete
// export. Only the `cli` principal reaches them, no tool of the persona does, and nothing they read is written anywhere. Plan
// 2026-11-04-cli-and-memory task 10; S9 reruns the discovery and the export over every new table and FTS shadow. A locator and
// a filter list are one JSON word. An answer is JSON; a refusal has a status other than `ok` and a `code`.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRequest } from '../bin/neptunia-request.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import type { Answer } from '../src/interface/commands/console.ts';
import { commandLineWords, parseCommandWords } from '../src/interface/commands/table.ts';
import { domainDetail, domainList } from '../src/memory/db/domain-read.ts';
import type { DomainFamily } from '../src/memory/db/domain-read.ts';
import type {
  InspectionCatalog,
  InspectionPage,
  InspectionRow,
  InspectionTable,
  RowLocator,
} from '../src/memory/db/inspection.ts';
import type { InspectionValueChunk } from '../src/memory/db/inspection-snapshots.ts';
import { internalContext } from '../src/memory/db/scope.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { listOps } from '../src/tools/operations/index.ts';
import { createCommandDesk } from '../src/interface/neptunia-cli.ts';
import type { CommandDeps } from '../src/interface/neptunia-cli.ts';
import { wrongly } from './fixtures/loose-types.ts';
import {
  actualTableNames,
  addAuthority,
  addEdge,
  addPlace,
  addSource,
  cell,
  countOf,
  databaseDigest,
} from './fixtures/memory-db/browser-world.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import type { TestMemory } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';

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
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

type TablesAnswer = { snapshot: string; catalog: InspectionCatalog };
type SchemaAnswer = { snapshot: string; table: InspectionTable };
type RowAnswer = { snapshot: string; row: InspectionRow };
type ValueAnswer = InspectionValueChunk & { snapshot: string };

async function everyRow(
  one: Rig,
  table: string,
  limit = '7'
): Promise<{ rows: Array<InspectionRow>; snapshot: string }> {
  const rows: Array<InspectionRow> = [];
  let page = data<InspectionPage>(await one.say('memory', 'inspect', 'rows', table, '--limit', limit));
  rows.push(...page.items);
  const snapshot = page.snapshot;
  while (page.next !== null) {
    page = data<InspectionPage>(
      await one.say('memory', 'inspect', 'rows', table, '--snapshot', snapshot, '--limit', limit, '--cursor', page.next)
    );
    rows.push(...page.items);
  }
  await one.say('memory', 'inspect', 'close', snapshot);
  return { rows, snapshot };
}

// ---------- the table ----------

const LOCATOR = '{"kind":"rowid","alias":"rowid","value":"1"}';
const LINES: ReadonlyArray<readonly [Array<string>, string]> = [
  [['memory', 'inspect', 'tables'], 'memory.inspect.tables'],
  [['memory', 'inspect', 'tables', '--snapshot', 's1'], 'memory.inspect.tables'],
  [['memory', 'inspect', 'schema', 'claims', '--snapshot', 's1'], 'memory.inspect.schema'],
  [
    ['memory', 'inspect', 'rows', 'claims', '--snapshot', 's1', '--limit', '5', '--cursor', 'c1', '--filters', '[]'],
    'memory.inspect.rows',
  ],
  [['memory', 'inspect', 'row', 'claims', LOCATOR, '--snapshot', 's1'], 'memory.inspect.row'],
  [
    ['memory', 'inspect', 'value', 'claims', LOCATOR, 'text', '--snapshot', 's1', '--offset', '10'],
    'memory.inspect.value',
  ],
  [['memory', 'inspect', 'export', '/tmp/x.jsonl'], 'memory.inspect.export'],
  [['memory', 'inspect', 'close', 's1'], 'memory.inspect.close'],
  [['memory', 'sources', 'show', 'source:1'], 'memory.sources.show'],
  [['memory', 'sources', 'list', '--limit', '5', '--cursor', 'c1'], 'memory.sources.list'],
  [['memory', 'claims', 'show', 'claim:1'], 'memory.claims.show'],
  [['memory', 'claims', 'versions', 'claim:1'], 'memory.claims.versions'],
  [['memory', 'descriptions', 'show', 'desc:1'], 'memory.descriptions.show'],
  [['memory', 'episodes', 'show', 'episode:1'], 'memory.episodes.show'],
  [['memory', 'selfreflection', 'show', 'selfreflection:1'], 'memory.selfreflection.show'],
  [['memory', 'media', 'show', 'media:1'], 'memory.media.show'],
  [['memory', 'publications', 'show', 'publication:1'], 'memory.publications.show'],
  [['memory', 'grants', 'show', 'grant:1'], 'memory.grants.show'],
  [['memory', 'sessions', 'show', 'session:1'], 'memory.sessions.show'],
  [['memory', 'requests', 'show', 'request:1'], 'memory.requests.show'],
  [['memory', 'turns', 'show', 'turn:1'], 'memory.turns.show'],
];

for (const [words, name] of LINES) {
  test(`${words.join(' ')} parses to ${name} from argv and as a whole line`, () => {
    const fromArgv = parseCommandWords(words);
    assert.ok(fromArgv.ok, fromArgv.ok ? '' : fromArgv.reason);
    assert.equal(fromArgv.name, name);
    assert.deepEqual(parseRequest(words).parsed, fromArgv);
    if (!words.includes(LOCATOR))
      assert.deepEqual(parseRequest(commandLineWords(`/${words.join(' ')}`)).parsed, fromArgv);
  });
}

// ---------- completeness ----------

test('/memory inspect tables lists exactly the tables of the database', async () => {
  // Bug: the owner's menu is the domain list, so a table no menu names cannot be found.
  const one = await rig();
  const { catalog } = data<TablesAnswer>(await one.say('memory', 'inspect', 'tables'));
  assert.deepEqual(new Set(catalog.tables.map((table) => table.name)), new Set(actualTableNames(one.db)));
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

test('a table added later appears, reads whole, and is reported as unclassified', async () => {
  // Bug: a future table needs a registry entry before the owner can see it, or it is silently classed as something.
  const one = await rig();
  writable(one.memory).exec(
    "CREATE TABLE future_family (id TEXT PRIMARY KEY, body TEXT); INSERT INTO future_family VALUES ('f1', 'ζωή');"
  );
  const { catalog } = data<TablesAnswer>(await one.say('memory', 'inspect', 'tables'));
  assert.equal(catalog.tables.find((table) => table.name === 'future_family')?.storageClass, 'unclassified');
  const { rows } = await everyRow(one, 'future_family');
  assert.deepEqual(cell(rows[0], 'body'), { kind: 'text', value: 'ζωή' });
});

test('every row of every table is read through the command, and the counts reconcile', async () => {
  // Bug: the command reads some tables through a domain view, so FTS shadows, the board and metadata fail or come up short.
  const one = await rig();
  const { catalog } = data<TablesAnswer>(await one.say('memory', 'inspect', 'tables'));
  assert.ok(countOf(one.db, 'node_access') > 0 && countOf(one.db, 'sources_fts_data') > 0);
  for (const table of catalog.tables) {
    if (table.name === 'zz_big') continue;
    const { rows } = await everyRow(one, table.name);
    assert.equal(rows.length, countOf(one.db, table.name), table.name);
  }
});

test('a relation the graph does not project stays readable through inspection', async () => {
  // Bug: an unresolved `references` row has no graph edge and no menu, so it is simply unreachable.
  const one = await rig();
  const page = data<InspectionPage>(
    await one.say(
      'memory',
      'inspect',
      'rows',
      'source_relations',
      '--filters',
      JSON.stringify([{ column: 'predicate', value: { kind: 'text', value: 'references' } }])
    )
  );
  assert.deepEqual(cell(page.items[0], 'target_key'), { kind: 'text', value: 'unresolved-native-key' });
  assert.equal(page.total, 1);
});

test('/memory inspect schema answers the catalog entry of one table', async () => {
  const one = await rig();
  const { table } = data<SchemaAnswer>(await one.say('memory', 'inspect', 'schema', 'node_access'));
  assert.deepEqual(
    table.columns.map((column) => column.name),
    ['node_id', 'audience_id', 'evidence_id']
  );
  assert.ok(table.storageClass === 'derived');
});

test('/memory inspect row opens a row by the locator its page gave', async () => {
  const one = await rig();
  const { rows } = await everyRow(one, 'claims');
  const opened = data<RowAnswer>(await one.say('memory', 'inspect', 'row', 'claims', JSON.stringify(rows[0].locator)));
  assert.deepEqual(opened.row, rows[0]);
});

// ---------- one moment ----------

test('pages under one --snapshot hold still while the writer goes on', async () => {
  // Bug: the snapshot is opened per command, so `--cursor` silently reads a later moment.
  const one = await rig();
  const write = writable(one.memory);
  write.exec(
    "CREATE TABLE probe (id TEXT PRIMARY KEY, v TEXT); INSERT INTO probe VALUES ('b', 'b0'), ('c', 'c0'), ('d', 'd0');"
  );
  const first = data<InspectionPage>(await one.say('memory', 'inspect', 'rows', 'probe', '--limit', '1'));
  write.exec("INSERT INTO probe VALUES ('a', 'new'); UPDATE probe SET v = 'changed' WHERE id = 'd';");
  const rest = data<InspectionPage>(
    await one.say(
      'memory',
      'inspect',
      'rows',
      'probe',
      '--snapshot',
      first.snapshot,
      '--limit',
      '25',
      '--cursor',
      first.next ?? ''
    )
  );
  assert.deepEqual(
    [...first.items, ...rest.items].map((row) => cell(row, 'v')),
    ['b0', 'c0', 'd0'].map((value) => ({ kind: 'text', value }))
  );
});

test('a closed snapshot refuses, and so does an expired one, each with its code', async () => {
  const one = await rig();
  const open = data<InspectionPage>(await one.say('memory', 'inspect', 'rows', 'meta'));
  assert.equal((await one.say('memory', 'inspect', 'close', open.snapshot)).status, 'ok');
  const closed = await one.say('memory', 'inspect', 'rows', 'meta', '--snapshot', open.snapshot);
  assert.notEqual(closed.status, 'ok');
  assert.equal(closed.code, 'INSPECTION_CLOSED');
  const stale = data<InspectionPage>(await one.say('memory', 'inspect', 'rows', 'meta'));
  one.clock.at += (BOUNDS.snapshotIdleSeconds + 1) * 1000;
  const expired = await one.say('memory', 'inspect', 'rows', 'meta', '--snapshot', stale.snapshot);
  assert.notEqual(expired.status, 'ok');
  assert.equal(expired.code, 'INSPECTION_EXPIRED');
});

test('the page bound is read from the live config at each new snapshot', async () => {
  // Bug: the bound is cached at startup, against the rule that settings are read at the moment of use.
  const one = await rig();
  const live = one.memory.hot.config.memoryDb as { inspection: { pageRows: number } };
  live.inspection = { ...BOUNDS, pageRows: 1 };
  const page = data<InspectionPage>(await one.say('memory', 'inspect', 'rows', 'sources', '--limit', '25'));
  assert.equal(page.items.length, 1);
  assert.equal(page.total, 2);
});

// ---------- full values and refusals ----------

test('a large value comes back whole through --offset', async () => {
  const one = await rig();
  const first = data<InspectionPage>(await one.say('memory', 'inspect', 'rows', 'zz_big'));
  const locator = JSON.stringify(first.items[0].locator);
  const parts: Array<Buffer> = [];
  let offset = 0;
  for (let turn = 0; turn < 10_000; turn += 1) {
    const chunk = data<ValueAnswer>(
      await one.say(
        'memory',
        'inspect',
        'value',
        'zz_big',
        locator,
        'body',
        '--snapshot',
        first.snapshot,
        '--offset',
        String(offset)
      )
    );
    parts.push(Buffer.from(chunk.value, chunk.encoding));
    if (chunk.nextOffset === null) break;
    offset = chunk.nextOffset;
  }
  assert.ok(parts.length > 1);
  assert.equal(Buffer.concat(parts).toString('utf8'), BIG);
});

for (const [label, words, code] of [
  ['an unknown table', ['memory', 'inspect', 'rows', 'nope'], 'INSPECTION_UNKNOWN_TABLE'],
  ['an injected table', ['memory', 'inspect', 'rows', 'claims; DROP TABLE claims'], 'INSPECTION_UNKNOWN_TABLE'],
  [
    'an unknown column in a filter',
    ['memory', 'inspect', 'rows', 'claims', '--filters', '[{"column":"nope","value":{"kind":"null"}}]'],
    'INSPECTION_UNKNOWN_COLUMN',
  ],
  [
    'a filter list that is no JSON',
    ['memory', 'inspect', 'rows', 'claims', '--filters', 'nope'],
    'INSPECTION_BAD_FILTER',
  ],
  [
    'a filter value of no known kind',
    ['memory', 'inspect', 'rows', 'claims', '--filters', '[{"column":"id","value":{"kind":"date"}}]'],
    'INSPECTION_BAD_FILTER',
  ],
  ['a locator that is no JSON', ['memory', 'inspect', 'row', 'claims', 'nope'], 'INSPECTION_BAD_LOCATOR'],
  ['a bad cursor', ['memory', 'inspect', 'rows', 'claims', '--cursor', 'garbage'], 'INSPECTION_BAD_CURSOR'],
  ['a limit that is no number', ['memory', 'inspect', 'rows', 'claims', '--limit', 'many'], 'INSPECTION_BAD_LIMIT'],
] as const) {
  test(`/memory inspect refuses ${label} with ${code}, with no partial answer`, async () => {
    // Bug: a bad word becomes an empty table, which reads as a fact about her memory.
    const one = await rig();
    const before = databaseDigest(one.db);
    const answer = await one.say(...words);
    assert.equal(answer.status, 'invalid');
    assert.equal(answer.code, code);
    assert.deepEqual(databaseDigest(one.db), before);
  });
}

// ---------- export ----------

test('/memory inspect export writes a complete file at mode 0600, counts reconciled', async () => {
  // Bug: the export is a domain dump, or the file of her whole memory is left readable by every user on the machine.
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

// ---------- domain routes ----------

const FAMILIES: ReadonlyArray<readonly [Array<string>, DomainFamily, string]> = [
  [['memory', 'sources', 'show', 'source:1'], 'sources', 'source:1'],
  [['memory', 'claims', 'show', 'claim:retired'], 'claims', 'claim:retired'],
];

for (const [words, family, id] of FAMILIES) {
  test(`${words.join(' ')} answers the domain reader, a retired or internal record included`, async () => {
    const one = await rig();
    assert.deepEqual(
      data(await one.say(...words)),
      json(domainDetail(one.db, { family, id, context: internalContext() }))
    );
  });
}

test('/memory sources list answers the domain page', async () => {
  const one = await rig();
  const expected = domainList(one.db, {
    family: 'sources',
    context: internalContext(),
    limit: BOUNDS.pageRows,
    cursor: null,
  });
  assert.deepEqual(data(await one.say('memory', 'sources', 'list')), json(expected));
});

test('/memory claims versions opens each version of the claim in order of recording', async () => {
  const one = await rig();
  const write = writable(one.memory);
  const add = write.prepare(
    `INSERT INTO claim_versions (id, claim_id, text, recorded_at, event, by, origin, retired_at) VALUES (?, 'claim:retired', ?, ?, 'edit', 's', 's', ?)`
  );
  add.run('version:new', 'new', '2026-11-02T00:00:00.000Z', null);
  add.run('version:old', 'old', '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z');
  const { versions } = data<{ versions: Array<{ id: string; rows: Array<InspectionRow> }> }>(
    await one.say('memory', 'claims', 'versions', 'claim:retired')
  );
  assert.deepEqual(
    versions.map((one2) => one2.id),
    ['version:old', 'version:new']
  );
  assert.deepEqual(cell(versions[0].rows[0], 'text'), { kind: 'text', value: 'old' });
});

test('a record nobody stored answers invalid with its code', async () => {
  const one = await rig();
  const answer = await one.say('memory', 'claims', 'show', 'claim:unknown');
  assert.deepEqual([answer.status, answer.code], ['invalid', 'RECORD_NOT_FOUND']);
});

// ---------- owner only, no write ----------

const READS: ReadonlyArray<Array<string>> = [
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
  // Bug: a read goes through a tool, records a turn read, witnesses a node, or lands as a line in her memory.
  const one = await rig();
  const before = databaseDigest(one.db);
  assert.notEqual(before.node_access.split(':')[0], '0');
  const settings = JSON.stringify(one.memory.hot.config);
  for (const words of READS) assert.equal((await one.say(...words)).status, 'ok', words.join(' '));
  await one.say('memory', 'inspect', 'export', join(one.dir, 'read.jsonl'));
  assert.deepEqual(one.ops, []);
  assert.deepEqual(databaseDigest(one.db), before);
  assert.equal(JSON.stringify(one.memory.hot.config), settings);
});

test('a closed database answers failed, with no snapshot left behind', async () => {
  const one = await rig();
  await one.memory.close();
  for (const words of READS) assert.equal((await one.say(...words)).status, 'failed', words.join(' '));
});

const INSPECTIONS = [
  'memory.inspect.tables',
  'memory.inspect.rows',
  'memory.inspect.export',
  'memory.graph.nodes',
  'memory.users.list',
];

function desk(consoleCalls: Array<string>, boardCalls: Array<string>): ReturnType<typeof createCommandDesk> {
  const deps: CommandDeps = {
    console: {
      run: (name) => {
        consoleCalls.push(name);
        return Promise.resolve({ text: '{}', status: 'ok' });
      },
    },
    interfaces: { list: () => [], enable: () => {}, disable: () => Promise.resolve({ drained: 0, unknown: 0 }) },
    facts: () => wrongly({}),
    tasks: {
      command: (_principal, name) => {
        boardCalls.push(name);
        return Promise.resolve(wrongly({ text: 'no such board command', status: 'invalid' }));
      },
    },
  };
  return createCommandDesk(deps);
}

for (const name of INSPECTIONS) {
  const event = { name, args: {}, chat: { id: 'cli:dm:owner' }, requester: { id: 'owner', roles: [] } };

  test(`${name} from the owner's chat reaches the console`, async () => {
    const consoleCalls: Array<string> = [];
    await desk(consoleCalls, []).run(event, { kind: 'cli', name: 'cli' });
    assert.deepEqual(consoleCalls, [name]);
  });

  test(`${name} from a development agent never reaches the console`, async () => {
    // Bug: a worker on the task board reads her whole memory, DMs included, by naming the command.
    const consoleCalls: Array<string> = [];
    const answer = await desk(consoleCalls, []).run(event, { kind: 'agent', name: 'dev' });
    assert.deepEqual(consoleCalls, []);
    assert.notEqual('status' in answer ? answer.status : '', 'ok');
  });

  test(`${name} from an interface is denied`, async () => {
    const consoleCalls: Array<string> = [];
    const answer = await desk(consoleCalls, []).run(event, { kind: wrongly('interface'), name: 'discord' });
    assert.deepEqual(consoleCalls, []);
    assert.equal('status' in answer ? answer.status : '', 'denied');
  });
}

test('no operation of the persona reaches the browser', () => {
  // Bug: an inspection registered as an operation becomes a tool she can be granted, and audience rules are bypassed.
  const names = JSON.stringify(listOps());
  for (const word of ['memory.inspect', 'memory.graph', 'memory.users', 'memory.places', 'inspection'])
    assert.equal(names.includes(word), false, word);
});

test('a catalog row count and a direct count agree through a quoted name', async () => {
  const one = await rig();
  writable(one.memory).exec(`CREATE TABLE "odd ""name""" (id TEXT); INSERT INTO "odd ""name""" VALUES ('x');`);
  const { rows } = await everyRow(one, 'odd "name"');
  assert.equal(rows.length, countOf(one.db, 'odd "name"'));
});

test('a row locator round-trips as one JSON word with spaces and quotes in its key', async () => {
  // Bug: the locator word goes through a line split, and a key with a space opens another row or none.
  const one = await rig();
  writable(one.memory).exec(
    `CREATE TABLE spaced (k TEXT PRIMARY KEY, v TEXT); INSERT INTO spaced VALUES ('a "b" c', 'found');`
  );
  const { rows } = await everyRow(one, 'spaced');
  const locator: RowLocator = rows[0].locator;
  const opened = data<RowAnswer>(await one.say('memory', 'inspect', 'row', 'spaced', JSON.stringify(locator)));
  assert.deepEqual(cell(opened.row, 'v'), { kind: 'text', value: 'found' });
});
