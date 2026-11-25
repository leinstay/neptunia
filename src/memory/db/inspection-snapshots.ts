// The owner's snapshots of the memory database, over dedicated read-only connections. One snapshot reads one moment: its
// pages, its full values and its export hold still while the writer goes on. Each is a deferred read transaction pinned by a
// read at the open, so it takes no lock from the writer, opens no write path and moves no row, `node_access` included. A
// snapshot ends by its close, by `closeOwner`, or by its bounds (`memoryDb.inspection`, given at the open): idle seconds since
// its last read, and seconds since its open. At most `maxSnapshots` are open at once; the next open is refused with
// `INSPECTION_TOO_MANY` before a connection is made. An expired one refuses and is never read in part; `sweepExpired`, at the memory
// service's tick, closes the connection of one nobody asks about again. Logs carry names and counts, never a value.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { schemaVersion, openMemoryDb } from './open.ts';
import { catalog as catalogOf, readRowAt, readRowPage, readValueChunk } from './inspection.ts';
import type {
  InspectionCatalog,
  InspectionPage,
  InspectionRead,
  InspectionRow,
  InspectionValueChunk,
  InspectionValueRead,
  RowLocator,
} from './inspection.ts';
import { checkLimit, coded } from './read-page.ts';
import { dbOf } from './types.ts';
import type { Db, Log, MemoryHandle } from './types.ts';
import { boardVersion } from '../../board/schema.ts';

export type { InspectionValueChunk } from './inspection.ts';

export type InspectionBounds = {
  pageRows: number;
  snapshotIdleSeconds: number;
  snapshotMaxSeconds: number;
  /** How many snapshots may be open at once: each pins a read transaction, so each holds the write-ahead log back. */
  maxSnapshots: number;
};

/**
 * A snapshot as the port hands it out. `revision` is the engine revision, and the port's handles also name the schema
 * versions of their moment. `expiresAt` is the idle bound at the open; a read moves the real one on.
 */
export type SnapshotHandle = {
  id: string;
  revision: string;
  expiresAt: string;
  memoryVersion?: number;
  boardVersion?: number;
};

export type InspectionExportRecord =
  | { kind: 'header'; engineRevision: string; snapshot: string; memoryVersion: number; boardVersion: number }
  | { kind: 'catalog'; catalog: InspectionCatalog }
  | { kind: 'row'; table: string; row: InspectionRow }
  | { kind: 'manifest'; tables: number; rows: Record<string, number> };

export type InspectionPort = {
  openInspection(options: { ownerId: string; bounds: InspectionBounds }): SnapshotHandle;
  /** The handle of an open snapshot of this owner, by the id a page named. */
  snapshotOf(id: string, ownerId: string): SnapshotHandle;
  catalog(handle: SnapshotHandle): InspectionCatalog;
  readInspectionPage(handle: SnapshotHandle, request: InspectionRead): InspectionPage;
  readInspectionRow(handle: SnapshotHandle, request: { table: string; locator: RowLocator }): InspectionRow;
  readInspectionValue(handle: SnapshotHandle, request: InspectionValueRead): InspectionValueChunk;
  closeInspection(handle: SnapshotHandle): void;
  closeOwner(ownerId: string): void;
  sweepExpired(): void;
  closeAll(): void;
  withSnapshotDb<TResult>(handle: SnapshotHandle, read: (db: Db) => TResult): TResult;
  exportRecords(handle: SnapshotHandle): Iterable<InspectionExportRecord>;
};

export type InspectionPortDeps = {
  dbPath: string;
  now: () => number;
  engineRevision: string;
  open?: typeof openMemoryDb;
  log?: Log;
};

/** How long a page lets one cell be: the page stays well inside a protocol frame, whatever a row holds. */
const EXCERPT_BYTES = 4096;
/** How many rows an export reads at a time. */
const EXPORT_BATCH_ROWS = 200;
/** How many ended snapshots keep their reason for the read that comes late. */
const REMEMBERED_ENDS = 64;

type Snapshot = {
  handle: SnapshotHandle;
  ownerId: string;
  memory: MemoryHandle;
  db: Db;
  bounds: InspectionBounds;
  openedAt: number;
  lastReadAt: number;
};

export function createInspectionPort(deps: InspectionPortDeps): InspectionPort {
  const open = deps.open ?? openMemoryDb;
  const live = new Map<string, Snapshot>();
  const expired = new Set<string>();

  const expiresAtOf = (snapshot: Snapshot): number =>
    Math.min(
      snapshot.lastReadAt + snapshot.bounds.snapshotIdleSeconds * 1000,
      snapshot.openedAt + snapshot.bounds.snapshotMaxSeconds * 1000
    );

  function release(snapshot: Snapshot): void {
    live.delete(snapshot.handle.id);
    try {
      snapshot.db.exec('ROLLBACK');
    } finally {
      snapshot.memory.close();
    }
    deps.log?.info('memory inspection: snapshot closed', { open: live.size });
  }

  function expire(snapshot: Snapshot): void {
    expired.add(snapshot.handle.id);
    for (const oldest of expired) {
      if (expired.size <= REMEMBERED_ENDS) break;
      expired.delete(oldest);
    }
    release(snapshot);
  }

  const refusedExpired = (): Error => coded('INSPECTION_EXPIRED', 'this snapshot expired; open a new one');

  /** The open snapshot of a handle, its idle clock moved on; the refusal of one that ended. */
  function reading(handle: SnapshotHandle): Snapshot {
    const snapshot = live.get(handle.id);
    if (snapshot === undefined) {
      if (expired.has(handle.id)) throw refusedExpired();
      throw coded('INSPECTION_CLOSED', 'this snapshot is closed');
    }
    const at = deps.now();
    if (at >= expiresAtOf(snapshot)) {
      expire(snapshot);
      throw refusedExpired();
    }
    snapshot.lastReadAt = at;
    return snapshot;
  }

  function sweepExpired(): void {
    const at = deps.now();
    for (const snapshot of [...live.values()]) if (at >= expiresAtOf(snapshot)) expire(snapshot);
  }

  function openInspection({ ownerId, bounds }: { ownerId: string; bounds: InspectionBounds }): SnapshotHandle {
    if (typeof ownerId !== 'string' || ownerId === '') throw coded('INSPECTION_DENIED', 'inspection is the owner’s');
    sweepExpired();
    if (live.size >= bounds.maxSnapshots)
      throw coded(
        'INSPECTION_TOO_MANY',
        `${bounds.maxSnapshots} snapshots are open, the most memoryDb.inspection.maxSnapshots allows; close one with /memory inspect close`
      );
    const memory = open(deps.dbPath, { readOnly: true });
    const db = dbOf(memory);
    const at = deps.now();
    try {
      db.exec('BEGIN');
      // A deferred transaction pins nothing until its first read, so this read is what makes the moment the open's.
      const memoryVersion = schemaVersion(db);
      const version = boardVersion(db);
      const handle: SnapshotHandle = {
        id: randomUUID(),
        revision: deps.engineRevision,
        expiresAt: new Date(at + Math.min(bounds.snapshotIdleSeconds, bounds.snapshotMaxSeconds) * 1000).toISOString(),
        memoryVersion,
        boardVersion: version,
      };
      live.set(handle.id, { handle, ownerId, memory, db, bounds, openedAt: at, lastReadAt: at });
      deps.log?.info('memory inspection: snapshot opened', { open: live.size });
      return handle;
    } catch (error) {
      memory.close();
      throw error;
    }
  }

  function readInspectionPage(handle: SnapshotHandle, request: InspectionRead): InspectionPage {
    const snapshot = reading(handle);
    const limit = Math.min(checkLimit(request.limit), snapshot.bounds.pageRows);
    return readRowPage(snapshot.db, { ...request, limit }, { snapshot: handle.id, excerptBytes: EXCERPT_BYTES });
  }

  /** A position names a row only inside the snapshot that gave it. */
  function checkLocator(handle: SnapshotHandle, locator: RowLocator): void {
    if (locator.kind === 'snapshot-position' && locator.snapshot !== handle.id)
      throw coded('INSPECTION_AMBIGUOUS_LOCATOR', 'that position belongs to another snapshot');
  }

  function* exportRecords(handle: SnapshotHandle): Generator<InspectionExportRecord> {
    const first = reading(handle);
    const whole = catalogOf(first.db);
    yield {
      kind: 'header',
      engineRevision: deps.engineRevision,
      snapshot: handle.id,
      memoryVersion: whole.memoryVersion,
      boardVersion: whole.boardVersion,
    };
    reading(handle);
    yield { kind: 'catalog', catalog: whole };
    const rows: Record<string, number> = {};
    for (const table of whole.tables) {
      rows[table.name] = 0;
      let cursor: string | null = null;
      do {
        const page: InspectionPage = readRowPage(
          reading(handle).db,
          { table: table.name, filters: [], limit: EXPORT_BATCH_ROWS, cursor },
          { snapshot: handle.id }
        );
        for (const row of page.items) {
          reading(handle);
          rows[table.name] += 1;
          yield { kind: 'row', table: table.name, row };
        }
        cursor = page.next;
      } while (cursor !== null);
      const counted = reading(handle)
        .db.prepare(`SELECT COUNT(*) AS n FROM "${table.name.replaceAll('"', '""')}"`)
        .get();
      if (Number(counted?.n) !== rows[table.name])
        throw coded('INSPECTION_EXPORT_MISMATCH', `the rows read from ${table.name} do not match its count`);
    }
    reading(handle);
    deps.log?.info('memory inspection: export read', { tables: whole.tables.length });
    yield { kind: 'manifest', tables: whole.tables.length, rows };
  }

  return {
    openInspection,
    snapshotOf(id, ownerId) {
      const snapshot = live.get(id);
      if (snapshot === undefined && expired.has(id)) throw refusedExpired();
      if (snapshot === undefined || snapshot.ownerId !== ownerId)
        throw coded('INSPECTION_CLOSED', 'this snapshot is closed');
      return snapshot.handle;
    },
    catalog: (handle) => catalogOf(reading(handle).db),
    readInspectionPage,
    readInspectionRow(handle, request) {
      const snapshot = reading(handle);
      checkLocator(handle, request.locator);
      return readRowAt(snapshot.db, request, { snapshot: handle.id, excerptBytes: EXCERPT_BYTES });
    },
    readInspectionValue(handle, request) {
      const snapshot = reading(handle);
      checkLocator(handle, request.locator);
      return readValueChunk(snapshot.db, request);
    },
    closeInspection(handle) {
      const snapshot = live.get(handle.id);
      if (snapshot !== undefined) release(snapshot);
    },
    closeOwner(ownerId) {
      for (const snapshot of [...live.values()]) if (snapshot.ownerId === ownerId) release(snapshot);
    },
    sweepExpired,
    closeAll() {
      for (const snapshot of [...live.values()]) release(snapshot);
    },
    withSnapshotDb: (handle, read) => read(reading(handle).db),
    exportRecords,
  };
}

/** Writes all of `records` to an open descriptor, one JSON document a line; the manifest it ended with. */
function writeRecords(
  descriptor: number,
  records: Iterable<InspectionExportRecord>
): Extract<InspectionExportRecord, { kind: 'manifest' }> {
  let manifest: Extract<InspectionExportRecord, { kind: 'manifest' }> | null = null;
  for (const record of records) {
    if (record.kind === 'manifest') manifest = record;
    fs.writeSync(descriptor, `${JSON.stringify(record)}\n`);
  }
  if (manifest === null) throw coded('INSPECTION_EXPORT_MISMATCH', 'the export ended without its manifest');
  return manifest;
}

/**
 * The whole snapshot as a JSONL file at mode 0600, whatever the umask. It is written beside its name and linked there only
 * when complete, so a failure leaves nothing that could pass for a whole export, and an existing file is refused and left.
 */
export function writeInspectionExport(
  port: InspectionPort,
  handle: SnapshotHandle,
  options: { file: string }
): { file: string; manifest: Extract<InspectionExportRecord, { kind: 'manifest' }> } {
  const { file } = options;
  const taken = (): Error => coded('INSPECTION_EXPORT_EXISTS', 'that file exists; an export never overwrites');
  if (fs.existsSync(file)) throw taken();
  const partial = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.partial`);
  const descriptor = fs.openSync(partial, 'wx', 0o600);
  try {
    fs.fchmodSync(descriptor, 0o600);
    const manifest = writeRecords(descriptor, port.exportRecords(handle));
    fs.fsyncSync(descriptor);
    try {
      fs.linkSync(partial, file);
    } catch (error) {
      throw (error as NodeJS.ErrnoException).code === 'EEXIST' ? taken() : error;
    }
    return { file, manifest };
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(partial, { force: true });
  }
}
