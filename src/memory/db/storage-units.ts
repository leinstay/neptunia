// The catalog supplies storage ownership, collection lifecycle and append positions to live readers and writers.

import { legacyStorageKey } from '../migration/paths.ts';
import { keyText, storageId } from './storage-keys.ts';
import type { StorageKey, StorageKind, StorageSelector, StorageSubject } from './storage-keys.ts';
import type { Db, Row } from './types.ts';

export type StorageUnit = Readonly<{
  id: string;
  key: StorageKey;
  lines: number | null;
  offset: number | null;
  retiredAt: string | null;
}>;
export type UnitQuery = {
  kind?: StorageKind | (string & {});
  subject?: StorageSubject;
  scopePlaceId?: string;
  partition?: string;
  selector?: StorageSelector;
};

/** The subject a unit belongs to: a place, an account or the persona. */
export const subjectOf = (unit: StorageUnit): StorageSubject => unit.key.subject;

/** The partition of a unit: the day (`YYYY-MM-DD`) of a record unit, the month of an archive; undefined when it has none. */
export const partitionOf = (unit: StorageUnit): string | undefined => unit.key.partition;

/** Whether the opened schema has semantic ownership. Historical importers use their original schema. */
export const hasStorageUnits = (db: { prepare(sql: string): { get(...args: Array<unknown>): unknown } }): boolean =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'storage_units'").get());

/** Register a collection within the caller's writer transaction. */
export function ensureUnit(db: Db, key: StorageKey): string {
  const id = storageId(key);
  db.prepare(
    `INSERT OR IGNORE INTO storage_units(id,kind,subject_type,subject_id,scope_place_id,partition,selector,key_json)
    VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    id,
    key.kind,
    key.subject.type,
    key.subject.id,
    key.scopePlaceId ?? null,
    key.partition ?? null,
    key.selector ? JSON.stringify(key.selector) : null,
    keyText(key)
  );
  return id;
}

/** Metadata of an exact unit identity, including tombstones. */
export function unitById(db: Db, id: string): StorageUnit | undefined {
  const row = db.prepare('SELECT * FROM storage_units WHERE id = ?').get(id);
  return row ? unitOfRow(row) : undefined;
}

function unitOfRow(row: Row): StorageUnit {
  return {
    id: String(row.id),
    key: JSON.parse(String(row.key_json)) as StorageKey,
    lines: row.lines === null ? null : Number(row.lines),
    offset: row.offset === null ? null : Number(row.offset),
    retiredAt: typeof row.retired_at === 'string' ? row.retired_at : null,
  };
}

/** Active units selected by semantic identity, ordered by canonical key. */
export function listUnits(db: Db, query: UnitQuery = {}): Array<StorageUnit> {
  const clauses = ['retired_at IS NULL'];
  const args: Array<unknown> = [];
  for (const [column, value] of [
    ['kind', query.kind],
    ['subject_type', query.subject?.type],
    ['subject_id', query.subject?.id],
    ['scope_place_id', query.scopePlaceId],
    ['partition', query.partition],
  ]) {
    if (value !== undefined) {
      clauses.push(`"${column}" = ?`);
      args.push(value);
    }
  }
  return db
    .prepare(`SELECT * FROM storage_units WHERE ${clauses.join(' AND ')} ORDER BY key_json`)
    .all(...args)
    .map(unitOfRow)
    .filter(
      (unit) =>
        !query.selector ||
        Object.entries(query.selector).every(([key, value]) => Reflect.get(unit.key.selector ?? {}, key) === value)
    );
}

/** Ownership SQL for the explicit historical-schema importer; current queries use owner_key. */
export function ownershipSql(
  db: { prepare(sql: string): { get(...args: Array<unknown>): unknown } },
  sql: string
): string {
  return hasStorageUnits(db) ? sql : sql.replaceAll('owner_key', 'owner_file');
}

export function storageOwner(db: Db, owner: string | null): string | null {
  if (!owner || !hasStorageUnits(db) || owner.startsWith('unit:')) return owner;
  const key = owner.startsWith('{') ? (JSON.parse(owner) as StorageKey) : legacyStorageKey(owner);
  return ensureUnit(db, key);
}

/** The column contract of a deliberately historical importer remains its original schema. */
export function ownershipRow(db: Db, row: Row): Row {
  if (hasStorageUnits(db) || !Object.hasOwn(row, 'owner_key')) return row;
  const { owner_key, ...rest } = row;
  return { ...rest, owner_file: owner_key };
}
