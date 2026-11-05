// src/memory/db/inspection-snapshots.ts: the owner's snapshots over dedicated read-only connections. One snapshot reads one
// moment: its pages, its full values and its export hold still while the writer goes on. A snapshot ends explicitly, and an
// expired one refuses rather than answering part of a page. Nothing here opens a write path, takes the writer's lock or
// moves a row, `node_access` included. Plan 2026-11-04-cli-and-memory task 7 and "Shared memory reader contracts"; S9 reruns
// discovery and export over the semantic tables. Contract:
//   createInspectionPort(deps: { dbPath: string; now: () => number; engineRevision: string; open?: typeof openMemoryDb;
//     log?: Log }): InspectionPort
//   InspectionPort = { openInspection(options: { ownerId: string; bounds: InspectionBounds }): SnapshotHandle;
//     catalog(handle): InspectionCatalog; readInspectionPage(handle, request: InspectionRead): InspectionPage;
//     readInspectionValue(handle, request: { table; locator; column; offset }): InspectionValueChunk;
//     closeInspection(handle): void; closeOwner(ownerId: string): void; sweepExpired(): void; closeAll(): void;
//     withSnapshotDb<TResult>(handle, read: (db: Db) => TResult): TResult; exportRecords(handle): Iterable<InspectionExportRecord> }
//   writeInspectionExport(port: InspectionPort, handle: SnapshotHandle, options: { file: string }):
//     { file: string; manifest: Extract<InspectionExportRecord, { kind: 'manifest' }> }
// A page cell shortened to fit carries `excerpt: { totalBytes, remainingBytes, nextOffset }`. A refusal throws an Error with
// `code`: INSPECTION_DENIED, INSPECTION_EXPIRED, INSPECTION_CLOSED, INSPECTION_BAD_CURSOR, INSPECTION_BAD_OFFSET,
// INSPECTION_NOT_A_VALUE or INSPECTION_EXPORT_EXISTS. `SnapshotHandle.revision` is not pinned: see the report on the plan.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkConfig } from '../src/config/check.ts';
import { CONFIG_SCHEMA } from '../src/config/schema.ts';
import { catalog as catalogOf } from '../src/memory/db/inspection.ts';
import type { InspectionPage, InspectionRead, InspectionRow, RowLocator } from '../src/memory/db/inspection.ts';
import type { InspectionValue } from '../src/memory/db/inspection-values.ts';
import { createInspectionPort, writeInspectionExport } from '../src/memory/db/inspection-snapshots.ts';
import type {
  InspectionBounds,
  InspectionExportRecord,
  InspectionPort,
  SnapshotHandle,
} from '../src/memory/db/inspection-snapshots.ts';
import { lockPathOf, openMemoryDb } from '../src/memory/db/open.ts';
import type { OpenOptions } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle } from '../src/memory/db/types.ts';
import { MAX_FRAME_BYTES } from '../src/protocol/wire.ts';
import {
  addAuthority,
  addEdge,
  addPlace,
  addSource,
  cell,
  countOf,
  databaseDigest,
} from './fixtures/memory-db/browser-world.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';

const T0 = Date.parse('2026-11-05T12:00:00.000Z');
const BOUNDS: InspectionBounds = { pageRows: 100, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300, maxSnapshots: 8 };
const OWNER = 'owner-1';
const SIX_MIB = 6 * 1024 * 1024;

type Rig = {
  dir: string;
  file: string;
  writer: MemoryHandle;
  db: Db;
  port: InspectionPort;
  clock: { at: number };
  opens: Array<OpenOptions>;
  closes: { n: number };
};

const open: Array<Rig> = [];
after(() => {
  for (const rig of open) {
    rig.port.closeAll();
    rig.writer.close();
  }
});

/** A live writer on a file-backed database, holding the lock, and a port over the same file with a recording opener. */
function rig(seed: (db: Db) => void = () => {}): Rig {
  const dir = tempDir('nep-snapshot-');
  const file = join(dir, 'memory.db');
  const writer = openMemoryDb(file);
  const db = dbOf(writer);
  seed(db);
  const clock = { at: T0 };
  const opens: Array<OpenOptions> = [];
  const closes = { n: 0 };
  const port = createInspectionPort({
    dbPath: file,
    now: () => clock.at,
    engineRevision: 'rev-synthetic',
    open: (path, options = {}) => {
      opens.push(options);
      const handle = openMemoryDb(path, options);
      return {
        ...handle,
        close: () => {
          closes.n += 1;
          handle.close();
        },
      };
    },
  });
  const made = { dir, file, writer, db, port, clock, opens, closes };
  open.push(made);
  return made;
}

const text = (value: string): InspectionValue => ({ kind: 'text', value });
const opened = (one: Rig, bounds = BOUNDS): SnapshotHandle => one.port.openInspection({ ownerId: OWNER, bounds });
const request = (
  table: string,
  limit = 2,
  cursor: string | null = null,
  filters: InspectionRead['filters'] = []
): InspectionRead => ({
  table,
  filters,
  limit,
  cursor,
});
const textOf = (value: InspectionValue): string => (value.kind === 'text' ? value.value : `not text: ${value.kind}`);

function pages(port: InspectionPort, handle: SnapshotHandle, table: string, limit = 2): Array<InspectionRow> {
  const rows: Array<InspectionRow> = [];
  let cursor: string | null = null;
  for (let turn = 0; turn < 100_000; turn += 1) {
    const page: InspectionPage = port.readInspectionPage(handle, request(table, limit, cursor));
    rows.push(...page.items);
    if (page.next === null) return rows;
    cursor = page.next;
  }
  throw new Error('the pages never end');
}

function seedProbe(db: Db): void {
  db.exec(`CREATE TABLE probe (id TEXT PRIMARY KEY, v TEXT);
    INSERT INTO probe VALUES ('b', 'b0'), ('c', 'c0'), ('d', 'd0'), ('e', 'e0'), ('f', 'f0');`);
}

/** The world an export must carry: an FTS-indexed line, a witness, a retired row, a big value and a blob. */
function seedWorld(db: Db): void {
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
    text: 'retired line',
    retiredAt: '2026-11-02T00:00:00.000Z',
  });
  addEdge(db, { src: 'source:1', dst: 'place:room', predicate: 'located_in', audience: 'aud:group:zeta' });
  db.exec('CREATE TABLE bigcell (id INTEGER PRIMARY KEY, body, n)');
  db.prepare('INSERT INTO bigcell VALUES (1, ?, 9223372036854775807)').run('ζ'.repeat(SIX_MIB / 2));
  db.prepare('INSERT INTO bigcell VALUES (2, ?, NULL)').run(Uint8Array.from({ length: 256 }, (_, n) => n));
}

const fileBytes = (path: string): string =>
  existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'absent';

// ---------- one moment ----------

test('a snapshot shows each row of its moment exactly once, with its old values, across a concurrent insert, update and delete', () => {
  // Bug: a fresh read per page shifts the offset, so a row repeats, a row is skipped and a page mixes two moments.
  const one = rig(seedProbe);
  const handle = opened(one);
  const firstPage = one.port.readInspectionPage(handle, request('probe', 2));
  assert.equal(firstPage.items.length, 2);
  one.db.exec(`INSERT INTO probe VALUES ('a', 'new-before-all');
    UPDATE probe SET v = 'changed' WHERE id = 'e';
    DELETE FROM probe WHERE id = 'f';`);
  const rest: Array<InspectionRow> = [];
  let cursor = firstPage.next;
  while (cursor !== null) {
    const page = one.port.readInspectionPage(handle, request('probe', 2, cursor));
    rest.push(...page.items);
    cursor = page.next;
  }
  const seen = [...firstPage.items, ...rest].map((row) => textOf(cell(row, 'v')));
  assert.deepEqual(seen, ['b0', 'c0', 'd0', 'e0', 'f0']);
  assert.equal(firstPage.total, 5);
});

test('a write between the open and the first read stays out of the snapshot', () => {
  // Bug: a deferred BEGIN pins nothing until the first read, so the snapshot's moment is the first page, not the open.
  const one = rig(seedProbe);
  const handle = opened(one);
  one.db.exec("INSERT INTO probe VALUES ('late', 'late')");
  assert.equal(pages(one.port, handle, 'probe').length, 5);
  assert.equal(one.port.readInspectionPage(handle, request('probe')).total, 5);
});

test('the catalog of a snapshot is of its moment, and a table made later is unknown to it', () => {
  const one = rig(seedProbe);
  const handle = opened(one);
  one.db.exec('CREATE TABLE later_family (id TEXT PRIMARY KEY)');
  assert.equal(
    one.port.catalog(handle).tables.some((table) => table.name === 'later_family'),
    false
  );
  assert.throws(() => one.port.readInspectionPage(handle, request('later_family')), {
    code: 'INSPECTION_UNKNOWN_TABLE',
  });
  const fresh = opened(one);
  assert.equal(
    one.port.catalog(fresh).tables.some((table) => table.name === 'later_family'),
    true
  );
});

test('two snapshots hold two moments, and closing one leaves the other readable', () => {
  const one = rig(seedProbe);
  const older = opened(one);
  one.db.exec("INSERT INTO probe VALUES ('z', 'z0')");
  const newer = opened(one);
  assert.equal(pages(one.port, older, 'probe').length, 5);
  assert.equal(pages(one.port, newer, 'probe').length, 6);
  one.port.closeInspection(older);
  assert.equal(pages(one.port, newer, 'probe').length, 6);
  assert.throws(() => one.port.readInspectionPage(older, request('probe')), { code: 'INSPECTION_CLOSED' });
});

test('the writer keeps committing while a snapshot is open', () => {
  // Bug: a snapshot holding a write lock or an immediate transaction stops her memory while the owner reads.
  const one = rig(seedProbe);
  const handle = opened(one);
  one.port.readInspectionPage(handle, request('probe', 1));
  one.db.exec("INSERT INTO probe VALUES ('w', 'w0')");
  assert.equal(countOf(one.db, 'probe'), 6);
});

test('readers built on the snapshot connection read its moment too', () => {
  // Bug: a domain reader runs on the service's live connection while its page cursor claims the snapshot.
  const one = rig(seedProbe);
  const handle = opened(one);
  one.db.exec('DELETE FROM probe');
  assert.equal(
    one.port.withSnapshotDb(handle, (db) => countOf(db, 'probe')),
    5
  );
});

// ---------- cursors ----------

test('a cursor is bound to its snapshot, table and filters', () => {
  // Bug: a cursor replayed over another table or filter pages through rows the listing never described.
  const one = rig((db) => {
    seedProbe(db);
    db.exec("CREATE TABLE other (id TEXT PRIMARY KEY); INSERT INTO other VALUES ('1'), ('2'), ('3');");
  });
  const handle = opened(one);
  const filters = [{ column: 'v', value: text('b0') }];
  const all = one.port.readInspectionPage(handle, request('probe', 2));
  assert.equal(all.truncated, true);
  const anotherSnapshot = opened(one);
  const code = { code: 'INSPECTION_BAD_CURSOR' };
  assert.throws(() => one.port.readInspectionPage(handle, request('other', 2, all.next)), code);
  assert.throws(() => one.port.readInspectionPage(handle, request('probe', 2, all.next, filters)), code);
  assert.throws(() => one.port.readInspectionPage(anotherSnapshot, request('probe', 2, all.next)), code);
  assert.throws(() => one.port.readInspectionPage(handle, request('probe', 2, 'garbage')), code);
});

test('every page names the snapshot it came from', () => {
  const one = rig(seedProbe);
  const handle = opened(one);
  assert.equal(one.port.readInspectionPage(handle, request('probe')).snapshot, handle.id);
});

test('a page never holds more rows than the bound, whatever limit was asked', () => {
  // Bug: `--limit 1000000` holds the whole table in one frame.
  const one = rig(seedProbe);
  const handle = opened(one, { ...BOUNDS, pageRows: 2 });
  const page = one.port.readInspectionPage(handle, request('probe', 1000));
  assert.equal(page.items.length, 2);
  assert.equal(page.truncated, true);
  assert.equal(page.total, 5);
  assert.equal(pages(one.port, handle, 'probe', 1000).length, 5);
});

// ---------- lifetime ----------

test('an idle snapshot expires and refuses its cursor with the expired code', () => {
  // Bug: an empty page after expiry looks like the end of the table.
  const one = rig(seedProbe);
  const handle = opened(one);
  const page = one.port.readInspectionPage(handle, request('probe', 2));
  one.clock.at += 61_000;
  assert.throws(() => one.port.readInspectionPage(handle, request('probe', 2, page.next)), {
    code: 'INSPECTION_EXPIRED',
  });
  assert.throws(() => one.port.catalog(handle), { code: 'INSPECTION_EXPIRED' });
});

test('reading keeps a snapshot alive past its idle bound, up to its whole-life bound', () => {
  // Bug: no maximum, so a polling client pins one WAL frame forever and the checkpoint never finishes.
  const one = rig(seedProbe);
  const handle = opened(one);
  for (let step = 1; step <= 5; step += 1) {
    one.clock.at = T0 + step * 50_000;
    assert.equal(one.port.readInspectionPage(handle, request('probe')).items.length, 2);
  }
  one.clock.at = T0 + 301_000;
  assert.throws(() => one.port.readInspectionPage(handle, request('probe')), { code: 'INSPECTION_EXPIRED' });
});

test('the bounds are the ones given at the open, read per snapshot', () => {
  const one = rig(seedProbe);
  const brief = opened(one, { ...BOUNDS, snapshotIdleSeconds: 5 });
  const long = opened(one, { ...BOUNDS, snapshotIdleSeconds: 500, snapshotMaxSeconds: 900 });
  one.clock.at += 6_000;
  assert.throws(() => one.port.readInspectionPage(brief, request('probe')), { code: 'INSPECTION_EXPIRED' });
  assert.equal(one.port.readInspectionPage(long, request('probe')).items.length, 2);
});

test('an expired snapshot closes its connection at the sweep, with no read asking', () => {
  // Bug: expiry checked only on the next read, so an abandoned snapshot pins the WAL until the core stops.
  const one = rig(seedProbe);
  opened(one);
  assert.equal(one.closes.n, 0);
  one.clock.at += 61_000;
  one.port.sweepExpired();
  assert.equal(one.closes.n, 1);
});

test('closing, an owner disconnecting and closeAll each release the connections they hold', () => {
  const one = rig(seedProbe);
  const handle = opened(one);
  one.port.closeInspection(handle);
  assert.equal(one.closes.n, 1);
  assert.throws(() => one.port.readInspectionPage(handle, request('probe')), { code: 'INSPECTION_CLOSED' });
  one.port.closeInspection(handle);
  assert.equal(one.closes.n, 1, 'a second close is a no-op');
  const mine = one.port.openInspection({ ownerId: 'owner-a', bounds: BOUNDS });
  const theirs = one.port.openInspection({ ownerId: 'owner-b', bounds: BOUNDS });
  one.port.closeOwner('owner-a');
  assert.equal(one.closes.n, 2);
  assert.throws(() => one.port.catalog(mine), { code: 'INSPECTION_CLOSED' });
  assert.ok(one.port.catalog(theirs).tables.length > 0);
  one.port.closeAll();
  assert.equal(one.closes.n, 3);
});

test('a handle the port never issued is refused', () => {
  const one = rig(seedProbe);
  const forged: SnapshotHandle = { id: 'forged', revision: 'x', expiresAt: new Date(T0 + 60_000).toISOString() };
  assert.throws(() => one.port.readInspectionPage(forged, request('probe')), { code: 'INSPECTION_CLOSED' });
});

test('a snapshot with no owner is refused before any connection opens', () => {
  // Bug: the port trusts its caller, and a path with an empty principal reaches the owner's whole memory.
  const one = rig(seedProbe);
  assert.throws(() => one.port.openInspection({ ownerId: '', bounds: BOUNDS }), { code: 'INSPECTION_DENIED' });
  assert.deepEqual(one.opens, []);
});

// ---------- no write path ----------

test('every connection the port opens is read-only and asks for no migration', () => {
  // Bug: the port opens the file the ordinary way, which migrates, takes the lock and holds a writer.
  const one = rig(seedProbe);
  opened(one);
  assert.equal(one.opens.length, 1);
  assert.equal(one.opens[0].readOnly, true);
});

test('opening, reading, exporting and closing move no byte of the database and leave the writer lock alone', () => {
  // Bug: a read records evidence, witnesses a node in `node_access`, or a checkpoint runs on the close.
  const one = rig(seedWorld);
  assert.ok(countOf(one.db, 'node_access') > 0);
  const digest = databaseDigest(one.db);
  const lock = fileBytes(lockPathOf(one.file));
  assert.notEqual(lock, 'absent');
  const main = fileBytes(one.file);
  const wal = fileBytes(`${one.file}-wal`);
  const handle = opened(one);
  for (const table of one.port.catalog(handle).tables) pages(one.port, handle, table.name, 50);
  const [row] = one.port.readInspectionPage(handle, request('bigcell', 1)).items;
  one.port.readInspectionValue(handle, { table: 'bigcell', locator: row.locator, column: 'body', offset: 0 });
  Array.from(one.port.exportRecords(handle));
  one.port.closeInspection(handle);
  assert.deepEqual(databaseDigest(one.db), digest);
  assert.equal(fileBytes(lockPathOf(one.file)), lock);
  assert.equal(fileBytes(one.file), main);
  assert.equal(fileBytes(`${one.file}-wal`), wal);
});

test('the service exposes the port while it is open, reads without a write and ends the snapshots on close', async () => {
  // Bug: the service hands out its own read handle, whose moment moves, or leaves a snapshot open past its close.
  const memory = await openTestMemory({ now: () => T0 });
  const port = memory.memoryDb.inspection();
  assert.ok(port);
  const db = memory.memoryDb.database();
  assert.ok(db);
  const digest = databaseDigest(db);
  const handle = port.openInspection({ ownerId: OWNER, bounds: BOUNDS });
  assert.ok(port.catalog(handle).tables.some((table) => table.name === 'node_access'));
  assert.deepEqual(port.readInspectionPage(handle, request('node_access')).items, []);
  assert.deepEqual(databaseDigest(db), digest);
  await memory.close();
  assert.throws(() => port.catalog(handle), { code: 'INSPECTION_CLOSED' });
  assert.equal(memory.memoryDb.inspection(), null);
});

// ---------- full values ----------

function reconstruct(
  port: InspectionPort,
  handle: SnapshotHandle,
  table: string,
  locator: RowLocator,
  column: string
): { bytes: Buffer; chunks: number; total: number } {
  const parts: Array<Buffer> = [];
  let offset = 0;
  let chunks = 0;
  let total = -1;
  for (;;) {
    const chunk = port.readInspectionValue(handle, { table, locator, column, offset });
    assert.ok(Buffer.byteLength(JSON.stringify(chunk)) < MAX_FRAME_BYTES);
    const part = Buffer.from(chunk.value, chunk.encoding);
    total = chunk.totalBytes;
    parts.push(part);
    chunks += 1;
    if (chunk.nextOffset === null) return { bytes: Buffer.concat(parts), chunks, total };
    assert.equal(chunk.nextOffset, offset + part.length, 'offsets count bytes of the original value');
    offset = chunk.nextOffset;
  }
}

test('a large text is read in bounded chunks and comes back byte for byte', () => {
  // Bug: chunks cut a character in two and `toString('utf8')` replaces both halves.
  const body = 'αβγ🌿é'.repeat(SIX_MIB / 12);
  const one = rig((db) => {
    db.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, body TEXT)');
    db.prepare('INSERT INTO big VALUES (1, ?)').run(body);
  });
  const handle = opened(one);
  const [row] = one.port.readInspectionPage(handle, request('big', 1)).items;
  const got = reconstruct(one.port, handle, 'big', row.locator, 'body');
  assert.ok(got.chunks > 1, 'a value of 6 MiB takes more than one chunk');
  assert.equal(got.total, Buffer.byteLength(body));
  assert.equal(got.bytes.toString('utf8'), body);
});

test('a large blob is read in bounded chunks and comes back byte for byte', () => {
  const body = Buffer.alloc(SIX_MIB, 0).map((_, index) => index % 251);
  const one = rig((db) => {
    db.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, body BLOB)');
    db.prepare('INSERT INTO big VALUES (1, ?)').run(body);
  });
  const handle = opened(one);
  const [row] = one.port.readInspectionPage(handle, request('big', 1)).items;
  const got = reconstruct(one.port, handle, 'big', row.locator, 'body');
  assert.ok(got.chunks > 1);
  assert.equal(got.total, body.length);
  assert.ok(got.bytes.equals(body));
  const chunk = one.port.readInspectionValue(handle, { table: 'big', locator: row.locator, column: 'body', offset: 0 });
  assert.equal(chunk.valueKind, 'blob');
  assert.equal(chunk.encoding, 'base64');
});

test('a stored text that is not valid UTF-8 is still returned as its exact bytes', () => {
  // Bug: the value is read as a JavaScript string first, and the bad bytes become replacement characters.
  const one = rig((db) => {
    db.exec(
      "CREATE TABLE raw (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO raw VALUES (1, CAST(x'61FF62' AS TEXT));"
    );
  });
  const handle = opened(one);
  const [row] = one.port.readInspectionPage(handle, request('raw', 1)).items;
  const got = reconstruct(one.port, handle, 'raw', row.locator, 'body');
  assert.deepEqual([...got.bytes], [0x61, 0xff, 0x62]);
  assert.equal(got.total, 3);
});

test('an empty value is one complete chunk, a small one too', () => {
  const one = rig((db) => {
    db.exec(
      "CREATE TABLE small (id INTEGER PRIMARY KEY, a TEXT, b BLOB); INSERT INTO small VALUES (1, '', x''), (2, 'ζ', x'00');"
    );
  });
  const handle = opened(one);
  const [empty, small] = one.port.readInspectionPage(handle, request('small', 2)).items;
  const emptyText = one.port.readInspectionValue(handle, {
    table: 'small',
    locator: empty.locator,
    column: 'a',
    offset: 0,
  });
  assert.deepEqual(
    [emptyText.valueKind, emptyText.value, emptyText.nextOffset, emptyText.totalBytes],
    ['text', '', null, 0]
  );
  const emptyBlob = one.port.readInspectionValue(handle, {
    table: 'small',
    locator: empty.locator,
    column: 'b',
    offset: 0,
  });
  assert.deepEqual([emptyBlob.valueKind, emptyBlob.nextOffset, emptyBlob.totalBytes], ['blob', null, 0]);
  const got = reconstruct(one.port, handle, 'small', small.locator, 'a');
  assert.equal(got.bytes.toString('utf8'), 'ζ');
  assert.equal(got.total, 2);
});

test('a value read follows the snapshot, whatever the writer did to the row since', () => {
  const one = rig((db) => {
    db.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, body TEXT)');
    db.prepare('INSERT INTO big VALUES (1, ?)').run('old');
  });
  const handle = opened(one);
  const [row] = one.port.readInspectionPage(handle, request('big', 1)).items;
  one.db.exec("UPDATE big SET body = 'new'");
  assert.equal(reconstruct(one.port, handle, 'big', row.locator, 'body').bytes.toString('utf8'), 'old');
});

test('a value read names what it refuses: a null, a number, a bad offset, an unknown column', () => {
  const one = rig((db) => {
    db.exec('CREATE TABLE mixed (id INTEGER PRIMARY KEY, a, b); INSERT INTO mixed VALUES (1, NULL, 42);');
  });
  const handle = opened(one);
  const [row] = one.port.readInspectionPage(handle, request('mixed', 1)).items;
  const read = (column: string, offset: number): unknown =>
    one.port.readInspectionValue(handle, { table: 'mixed', locator: row.locator, column, offset });
  assert.throws(() => read('a', 0), { code: 'INSPECTION_NOT_A_VALUE' });
  assert.throws(() => read('b', 0), { code: 'INSPECTION_NOT_A_VALUE' });
  assert.throws(() => read('nope', 0), { code: 'INSPECTION_UNKNOWN_COLUMN' });
  one.db.exec("UPDATE mixed SET a = 'x'");
  const fresh = opened(one);
  const [again] = one.port.readInspectionPage(fresh, request('mixed', 1)).items;
  const at = (offset: number): unknown =>
    one.port.readInspectionValue(fresh, { table: 'mixed', locator: again.locator, column: 'a', offset });
  assert.throws(() => at(-1), { code: 'INSPECTION_BAD_OFFSET' });
  assert.throws(() => at(1.5), { code: 'INSPECTION_BAD_OFFSET' });
  assert.throws(() => at(2), { code: 'INSPECTION_BAD_OFFSET' });
});

test('a page shortens a huge cell and says what is left and where to go on', () => {
  // Bug: the page serializes the whole value to compute a preview, or clips it with no sign that it did.
  const body = 'ζ'.repeat(SIX_MIB / 2);
  const one = rig((db) => {
    db.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, body TEXT, small TEXT)');
    db.prepare("INSERT INTO big VALUES (1, ?, 'kept whole')").run(body);
  });
  const handle = opened(one);
  const page = one.port.readInspectionPage(handle, request('big', 1));
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < SIX_MIB / 2);
  assert.equal(page.truncated, true);
  assert.equal(page.reason, 'value');
  const [row] = page.items;
  const entry = row.values.find((one2) => one2.column === 'body');
  assert.ok(entry?.excerpt);
  assert.equal(entry.excerpt.totalBytes, SIX_MIB);
  assert.equal(entry.excerpt.remainingBytes, SIX_MIB - entry.excerpt.nextOffset);
  assert.equal(row.values.find((one2) => one2.column === 'small')?.excerpt, undefined);
  assert.deepEqual(cell(row, 'small'), text('kept whole'));
  const rest = one.port.readInspectionValue(handle, {
    table: 'big',
    locator: row.locator,
    column: 'body',
    offset: entry.excerpt.nextOffset,
  });
  assert.equal(rest.totalBytes, SIX_MIB);
});

// ---------- export ----------

type Records = {
  header: Extract<InspectionExportRecord, { kind: 'header' }>;
  catalog: Extract<InspectionExportRecord, { kind: 'catalog' }>;
  rows: Array<Extract<InspectionExportRecord, { kind: 'row' }>>;
  manifest: Extract<InspectionExportRecord, { kind: 'manifest' }>;
};

function sorted(records: ReadonlyArray<InspectionExportRecord>): Records {
  assert.equal(records[0]?.kind, 'header');
  assert.equal(records[1]?.kind, 'catalog');
  const last = records.at(-1);
  assert.equal(last?.kind, 'manifest');
  const [header, catalog] = records;
  assert.ok(header.kind === 'header' && catalog.kind === 'catalog' && last?.kind === 'manifest');
  const rows = records.slice(2, -1).filter((one) => one.kind === 'row');
  assert.equal(rows.length, records.length - 3, 'nothing but rows between the catalog and the manifest');
  return { header, catalog, rows, manifest: last };
}

test('an export holds every table and every row, and its counts reconcile with the database', () => {
  // Bug: the domain export selects active owned rows, and shadow and board tables never reach it.
  const one = rig(seedWorld);
  const handle = opened(one);
  const { header, catalog, rows, manifest } = sorted(Array.from(one.port.exportRecords(handle)));
  assert.equal(header.engineRevision, 'rev-synthetic');
  assert.equal(header.snapshot, handle.id);
  const direct = catalogOf(one.db);
  assert.equal(header.memoryVersion, direct.memoryVersion);
  assert.equal(header.boardVersion, direct.boardVersion);
  assert.deepEqual(catalog.catalog, direct);
  const expected = Object.fromEntries(direct.tables.map((table) => [table.name, countOf(one.db, table.name)]));
  assert.deepEqual(manifest.rows, expected);
  assert.equal(manifest.tables, direct.tables.length);
  const counted: Record<string, number> = Object.fromEntries(direct.tables.map((table) => [table.name, 0]));
  for (const record of rows) counted[record.table] += 1;
  assert.deepEqual(counted, expected);
  assert.ok(expected.sources_fts_data > 0 && expected.node_access > 0 && expected.board_schema_version > 0);
});

test('an exported catalog marks the FTS shadows as derived storage', () => {
  // Bug: an index shadow is presented as an independent restorable record.
  const one = rig(seedWorld);
  const { catalog } = sorted(Array.from(one.port.exportRecords(opened(one))));
  const shadows = catalog.catalog.tables.filter((table) => table.kind === 'shadow');
  assert.ok(shadows.length >= 8);
  assert.ok(shadows.every((table) => table.storageClass === 'derived'));
});

test('an export carries full values, never an excerpt', () => {
  // Bug: the export reuses the page reader and writes the shortened cell as if it were the value.
  const one = rig(seedWorld);
  const { rows } = sorted(Array.from(one.port.exportRecords(opened(one))));
  const big = rows.filter((record) => record.table === 'bigcell');
  assert.equal(big.length, 2);
  assert.deepEqual(cell(big[0].row, 'body'), text('ζ'.repeat(SIX_MIB / 2)));
  assert.deepEqual(cell(big[0].row, 'n'), { kind: 'integer', value: '9223372036854775807' });
  assert.deepEqual(cell(big[1].row, 'body'), {
    kind: 'blob',
    encoding: 'base64',
    value: Buffer.from(Uint8Array.from({ length: 256 }, (_, n) => n)).toString('base64'),
  });
  assert.ok(rows.every((record) => record.row.values.every((entry) => entry.excerpt === undefined)));
});

test('an export reads one moment while the writer goes on', () => {
  const one = rig(seedProbe);
  const handle = opened(one);
  const records = one.port.exportRecords(handle)[Symbol.iterator]();
  records.next();
  one.db.exec("INSERT INTO probe VALUES ('late', 'late'); DELETE FROM probe WHERE id = 'b';");
  const rest: Array<InspectionExportRecord> = [];
  for (let step = records.next(); step.done !== true; step = records.next()) rest.push(step.value);
  const probeRows = rest.filter((record) => record.kind === 'row' && record.table === 'probe');
  assert.equal(probeRows.length, 5);
  const manifest = rest.at(-1);
  assert.ok(manifest?.kind === 'manifest');
  assert.equal(manifest.rows.probe, 5);
});

test('an export that expires midway throws and yields no manifest', () => {
  // Bug: a partial walk ends quietly with a manifest of what it reached, a complete-looking export.
  const one = rig(seedWorld);
  const handle = opened(one);
  const records = one.port.exportRecords(handle)[Symbol.iterator]();
  records.next();
  records.next();
  one.clock.at += 301_000;
  const seen: Array<string> = [];
  assert.throws(
    () => {
      for (let step = records.next(); step.done !== true; step = records.next()) seen.push(step.value.kind);
    },
    { code: 'INSPECTION_EXPIRED' }
  );
  assert.equal(seen.includes('manifest'), false);
});

function exportFile(one: Rig): string {
  return join(one.dir, 'export.jsonl');
}

test('an export file holds the same records, one JSON document a line, at mode 0600 under an open umask', () => {
  // Bug: the file inherits 0644 and the owner's whole memory, DMs included, is readable by every user on the machine.
  const one = rig(seedWorld);
  const handle = opened(one);
  const expected = Array.from(one.port.exportRecords(handle));
  const file = exportFile(one);
  const umask = process.umask(0);
  let result: ReturnType<typeof writeInspectionExport>;
  try {
    result = writeInspectionExport(one.port, handle, { file });
  } finally {
    process.umask(umask);
  }
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(result.file, file);
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
  assert.deepEqual(
    lines.map((line): unknown => JSON.parse(line)),
    JSON.parse(JSON.stringify(expected))
  );
  assert.deepEqual(result.manifest, expected.at(-1));
});

test('an export refuses a file that exists and leaves it as it was', () => {
  // Bug: `open` keeps the old file's wide mode, so private memory lands in a world-readable file.
  const one = rig(seedProbe);
  const file = exportFile(one);
  writeFileSync(file, 'keep me', { mode: 0o644 });
  assert.throws(() => writeInspectionExport(one.port, opened(one), { file }), { code: 'INSPECTION_EXPORT_EXISTS' });
  assert.equal(readFileSync(file, 'utf8'), 'keep me');
  assert.equal(statSync(file).mode & 0o777, 0o644);
});

test('an export that fails midway leaves no file that could pass for a whole one', () => {
  // Bug: the partial file sits under the final name, and a later restore trusts it.
  const one = rig(seedProbe);
  const handle = opened(one);
  const failing: InspectionPort = {
    ...one.port,
    *exportRecords(given) {
      const records = one.port.exportRecords(given)[Symbol.iterator]();
      yield records.next().value as InspectionExportRecord;
      throw Object.assign(new Error('the snapshot expired'), { code: 'INSPECTION_EXPIRED' });
    },
  };
  const before = readdirSync(one.dir).sort();
  assert.throws(() => writeInspectionExport(failing, handle, { file: exportFile(one) }), {
    code: 'INSPECTION_EXPIRED',
  });
  assert.deepEqual(readdirSync(one.dir).sort(), before);
});

test('an expired snapshot writes no export at all', () => {
  const one = rig(seedProbe);
  const handle = opened(one);
  one.clock.at += 301_000;
  assert.throws(() => writeInspectionExport(one.port, handle, { file: exportFile(one) }), {
    code: 'INSPECTION_EXPIRED',
  });
  assert.equal(existsSync(exportFile(one)), false);
});

test('the bounds are documented settings of memoryDb.inspection, typed by the schema', () => {
  // Bug: the three bounds are constants in the code, or `/config check` calls the owner's setting unknown.
  const inspection = { pageRows: 3, snapshotIdleSeconds: 7, snapshotMaxSeconds: 11 };
  assert.deepEqual(checkConfig({ memoryDb: { inspection } }, CONFIG_SCHEMA), []);
  assert.notDeepEqual(
    checkConfig({ memoryDb: { inspection: { ...inspection, pageRows: 'many' } } }, CONFIG_SCHEMA),
    []
  );
});

test('the log carries names and counts, never a stored value', () => {
  // Bug: a debug line prints the row, and a chat line lands in the service journal.
  const lines: Array<string> = [];
  const record = (message: string, fields?: unknown): void => {
    lines.push(`${message} ${JSON.stringify(fields ?? null)}`);
  };
  const dir = tempDir('nep-snapshot-log-');
  const file = join(dir, 'memory.db');
  const writer = openMemoryDb(file);
  dbOf(writer).exec(
    "CREATE TABLE probe (id TEXT PRIMARY KEY, v TEXT); INSERT INTO probe VALUES ('zeta-secret-key', 'zeta-secret-value');"
  );
  const port = createInspectionPort({
    dbPath: file,
    now: () => T0,
    engineRevision: 'rev-synthetic',
    log: { info: record, warn: record, error: record, debug: record },
  });
  try {
    const handle = port.openInspection({ ownerId: OWNER, bounds: BOUNDS });
    const [row] = port.readInspectionPage(handle, request('probe', 1)).items;
    port.readInspectionValue(handle, { table: 'probe', locator: row.locator, column: 'v', offset: 0 });
    Array.from(port.exportRecords(handle));
    assert.equal(lines.join('\n').includes('zeta-secret'), false);
  } finally {
    port.closeAll();
    writer.close();
  }
});
