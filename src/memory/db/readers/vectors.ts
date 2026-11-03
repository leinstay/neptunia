// The meaning index's reads from the database (src/memory/vectors.ts reads through them). A month of the index is the unit `<layer>/vectors/<YYYY-MM>` of `vectors` rows and one `operational` row
// (kind vectors, the manifest; map/vectors.ts); the export rebuilds its three files (manifest, int8 data, jsonl),
// and vectors.js reads them as it reads the disk (its manifest, checksum and row-count checks included). Pure
// functions over a read connection.
//
// An evicted vector (index-policy.ts: its row kept, its `bytes` dropped) cannot be scored: its row is left out of
// the rebuilt month, and the manifest then counts the rows that are left, with their checksum (the caller's
// `checksum(i8, meta)`), so the month is still read whole. With no eviction the stored manifest is used as it is,
// so a month whose files failed their checksum on the disk fails it here too.

import { storageId } from '../storage-keys.ts';
import type { StorageKey } from '../storage-keys.ts';
import { unitRows } from '../export.ts';
import { MAPPERS } from '../map/index.ts';
import type { Db, Row } from '../types.ts';

/** The stored state of a month (`owner`: `guilds/<g>/vectors/<YYYY-MM>`): `{ value, evicted }` or null. */
export function vectorMonthState(dbGiven: unknown, owner: StorageKey): { value: string; evicted: number } | null {
  const db = dbGiven as Db;
  const row = db
    .prepare("SELECT value FROM operational WHERE owner_key = ? AND kind = 'vectors' AND retired_at IS NULL")
    .get(storageId(owner));
  if (!row) return null;
  const evicted = db
    .prepare('SELECT COUNT(*) AS n FROM vectors WHERE owner_key = ? AND bytes IS NULL AND retired_at IS NULL')
    .get(storageId(owner))?.n as number;
  return { value: row.value as string, evicted };
}

/** The manifest a month's stored state holds (`vectorMonthState(...).value`, the manifest as its file held it), or null. */
export function storedManifest(value: unknown): Row | null {
  try {
    return (JSON.parse(String(value)) as { manifest?: Row } | null)?.manifest ?? null;
  } catch {
    return null;
  }
}

/**
 * The three files of a month rebuilt from the database: `{ manifest, meta: Buffer, i8: Buffer }`, or null when the
 * database holds no such month.
 */
export function vectorMonthFiles(
  dbGiven: unknown,
  owner: StorageKey,
  { checksum }: { checksum: (i8: Uint8Array, meta: Buffer) => unknown }
): { manifest: Row | undefined; meta: Buffer; i8: Buffer } | null {
  const db = dbGiven as Db;
  const rows = unitRows(db, owner);
  if (rows.operational.length === 0) return null;
  const evicted = rows.vectors.filter((row) => row.bytes === null || row.bytes === undefined).length;
  if (evicted > 0) rows.vectors = rows.vectors.filter((row) => row.bytes !== null && row.bytes !== undefined);
  // The vectors mapper reads a month back as its manifest, its jsonl text and its int8 bytes.
  const value = MAPPERS.vectors.fromRows(rows) as { manifest?: Row; meta: string; i8: Buffer };
  const meta = Buffer.from(value.meta, 'utf8');
  const i8 = Buffer.from(value.i8);
  let manifest = value.manifest;
  if (evicted > 0 && manifest && typeof manifest === 'object') {
    const kept = rows.vectors.length;
    const dims = Number.isInteger(manifest.dims) ? (manifest.dims as number) : 0;
    manifest = {
      ...manifest,
      rows: kept,
      bytes: kept * dims,
      metaBytes: meta.length,
      checksum: checksum(i8.subarray(0, kept * dims), meta),
    };
  }
  return { manifest, meta, i8 };
}
