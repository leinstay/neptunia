// The catalog supplies storage ownership, collection lifecycle and append positions to live readers and writers.

import { keyText, storageId } from './storage-keys.ts';
import type { StorageKey, StorageKind, StorageSelector, StorageSubject } from './storage-keys.ts';
import { isWholeNumber } from './types.ts';
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

/** The unit id an owner names: a unit id as it is, a key's JSON registered as its unit. */
export function storageOwner(db: Db, owner: string | null): string | null {
  if (!owner || !owner.startsWith('{')) return owner;
  return ensureUnit(db, JSON.parse(owner) as StorageKey);
}

/** Tables of an owned unit whose rows carry a `position`. */
const POSITIONED = [
  'sources',
  'day',
  'decisions',
  'claims',
  'claim_versions',
  'description_versions',
  'episodes',
  'affinity_events',
  'selfreflection',
  'intentions',
  'work',
  'work_events',
];
const hasTable = (db: Db, name: string): boolean =>
  db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

/**
 * The next position of a unit: its `storage_units` line count when it has one, else one past the highest position its
 * rows hold (0 for a new unit).
 */
export function nextPosition(db: Db, owner: string): number {
  const unit = db.prepare('SELECT lines FROM storage_units WHERE id = ? AND retired_at IS NULL').get(owner);
  if (typeof unit?.lines === 'number' && Number.isInteger(unit.lines) && unit.lines >= 0) return unit.lines;
  let top = -1;
  for (const table of POSITIONED) {
    if (!hasTable(db, table)) continue;
    const found = db.prepare(`SELECT MAX(position) AS p FROM "${table}" WHERE owner_key = ?`).get(owner)?.p;
    if (isWholeNumber(found) && found > top) top = found;
  }
  return top + 1;
}

/** Moves a unit the writers hold: its line count (`lines`) or a month's generation (`offset`), and when it was written. */
export function noteUnit(
  db: Db,
  owner: string,
  _kind: string,
  { lines = null, offset = null, at }: { lines?: number | null; offset?: number | null; at: string }
): void {
  db.prepare(
    'UPDATE storage_units SET lines=COALESCE(?,lines), offset=COALESCE(?,offset), synced_at=?, retired_at=NULL WHERE id=?'
  ).run(lines, offset, at, owner);
}
