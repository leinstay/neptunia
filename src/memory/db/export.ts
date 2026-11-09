// Semantic collections rebuilt from catalog-owned rows, shared ownership and protected session-written rows.
// Unit values retain their existing mapper shapes and append order. Legacy file exports resolve historical
// provenance explicitly; live readers use semantic keys and do not enumerate legacy paths.

import { hasStorageUnits, unitById } from './storage-units.ts';
import { storageId } from './storage-keys.ts';
import type { StorageKey } from './storage-keys.ts';
import { legacyStorageKey } from '../migration/paths.ts';
import { classify } from '../migration/classify.ts';
import { storageMapper } from './map/index.ts';

import type { Mapper } from './map/index.ts';
import type { MappedPath } from '../migration/classify.ts';
import { OWNED } from './upsert.ts';
import { addSessionRows } from './session-rows.ts';
import { addSourceMedia } from './record-lines.ts';
import { dbOf, isFiniteNumber } from './types.ts';
import type { Connection, Db, Row, Rows } from './types.ts';

export type MediaDescriptionEntry =
  | { text: string; ts: number; [field: string]: unknown }
  | { answer: string; question: string; ts: number; [field: string]: unknown };
export type MediaDescriptionVersion = { version: number; entry: MediaDescriptionEntry };

/** Successful describer payloads retain their complete structured data. */
export function isMediaDescriptionEntry(value: unknown): value is MediaDescriptionEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Row;
  return (
    !entry.miss &&
    isFiniteNumber(entry.ts) &&
    ((typeof entry.text === 'string' && entry.text.length > 0) ||
      (typeof entry.answer === 'string' && entry.answer.length > 0 && typeof entry.question === 'string'))
  );
}

/** A descriptor belongs to one exact root, interface and cache key. */
export const mediaDescriptionId = (key: StorageKey): string => `desc:media:${storageId(key)}`;

function mediaEntryOf(row: Row | undefined): MediaDescriptionEntry | null {
  if (!row || typeof row.extra !== 'string') return null;
  const extra: unknown = JSON.parse(row.extra);
  if (!extra || typeof extra !== 'object' || !('entry' in extra) || !isMediaDescriptionEntry(extra.entry)) return null;
  const failed = 'refreshFailedAt' in extra && isFiniteNumber(extra.refreshFailedAt) ? extra.refreshFailedAt : null;
  return { ...extra.entry, ...(failed !== null ? { refreshFailedAt: failed } : {}) };
}

/** Point lookup of the current successful payload, without reading its history. */
export function mediaDescriptionOf(handle: Connection, key: StorageKey): MediaDescriptionEntry | null {
  return mediaEntryOf(
    dbOf(handle)
      .prepare(
        `SELECT v.extra FROM descriptions d JOIN description_versions v ON v.id=d.current_version
     WHERE d.id=? AND d.owner_key=? AND d.retired_at IS NULL AND v.retired_at IS NULL`
      )
      .get(mediaDescriptionId(key), storageId(key))
  );
}

/** Successful versions of one media description, in generation order. */
export function mediaDescriptionVersions(
  handle: Connection,
  { key }: { key: StorageKey }
): Array<MediaDescriptionVersion> {
  return dbOf(handle)
    .prepare(
      'SELECT position,extra FROM description_versions WHERE owner_key=? AND retired_at IS NULL ORDER BY position'
    )
    .all(storageId(key))
    .flatMap((row) => {
      const entry = mediaEntryOf(row);
      return entry ? [{ version: Number(row.position), entry }] : [];
    });
}

const CHILDREN: Record<string, [string, string]> = {
  episode_sources: ['episodes', 'episode_id'],
  claim_sources: ['claims', 'claim_id'],
  selfreflection_mirrors: ['selfreflection', 'selfreflection_id'],
};

const HAS_POSITION = new Set([
  'sources',
  'claims',
  'claim_versions',
  'description_versions',
  'episodes',
  'affinity_events',
  'day',
  'selfreflection',
  'intentions',
  'work',
  'work_events',
  'decisions',
]);

const KEY_SQL = (table: string) =>
  OWNED[table].length === 1 ? `"${OWNED[table][0]}"` : OWNED[table].map((col) => `"${col}"`).join(' || char(0) || ');

/**
 * The active rows of one unit (`owner` is its full path): table -> rows (every table present), children included; a
 * member's unit with her session's rows about the person.
 */
export function unitRows(db: Db, key: StorageKey | string): Rows {
  const current = hasStorageUnits(db);
  const semantic = typeof key === 'string' ? (current ? (unitById(db, key)?.key ?? legacyStorageKey(key)) : null) : key;
  const owner = semantic ? storageId(semantic) : typeof key === 'string' ? key : storageId(key);
  const column = current ? 'owner_key' : 'owner_file';
  const rows: Rows = {};
  for (const table of Object.keys(OWNED)) {
    const order = HAS_POSITION.has(table) ? 'position, rowid' : 'rowid';
    rows[table] = db
      .prepare(
        `SELECT * FROM "${table}" WHERE (${column} = ? OR ${KEY_SQL(table)} IN (SELECT key FROM co_owners WHERE tbl = ? AND ${column} = ?)) AND retired_at IS NULL ORDER BY ${order}`
      )
      .all(owner, table, owner)
      .map((row) => ({ ...row }));
  }
  addSourceMedia(db, rows.sources);
  for (const [child, [parent, link]] of Object.entries(CHILDREN)) {
    rows[child] = db
      .prepare(
        `SELECT c.* FROM "${child}" c JOIN "${parent}" p ON p.id = c."${link}"
      WHERE (p.${column} = ? OR p.id IN (SELECT key FROM co_owners WHERE tbl = ? AND ${column} = ?)) AND p.retired_at IS NULL AND c.retired_at IS NULL ORDER BY ${child === 'selfreflection_mirrors' ? 'c.rowid' : 'c.position, c.rowid'}`
      )
      .all(owner, parent, owner)
      .map((row) => ({ ...row }));
  }
  const classified = semantic ? { kind: semantic.kind } : classify(owner);
  const account = semantic?.subject.type === 'account' ? semantic.subject.id : null;
  addSessionRows(db, classified && 'kind' in classified ? classified.kind : undefined, rows, account);
  return rows;
}

const positionOfOwner = (row: Row): number => Number(String(row.owner).split('#').pop());

/** The lines of a JSONL unit, in file order. */
function linesOf(kind: string, mapper: Mapper, rows: Rows): Array<unknown> {
  const one = (table: string, row: Row): unknown => mapper.fromRows({ [table]: [row] });
  switch (kind) {
    case 'archive':
      return rows.claim_versions.map((row) => one('claim_versions', row));
    case 'intentions':
      return rows.intentions.map((row) => one('intentions', row));
    case 'errands':
      return rows.work_events.map((row) => one('work_events', row));
    case 'verbatim':
      return [...rows.operational]
        .sort((a, b) => positionOfOwner(a) - positionOfOwner(b))
        .map((row) => one('operational', row));
    default:
      throw new Error(`no line export for kind ${kind}`);
  }
}

/** A semantic collection rebuilt without consulting a legacy alias or filename. */
export function storageValue(db: Db, key: StorageKey): unknown {
  const mapped = storageMapper(db, key, storageId(key));
  return mapped.mapper.fromRows(unitRows(db, key));
}

/** Semantic append collections keep their mapper order and native source identity. */
export function storageLines(db: Db, key: StorageKey): Array<string> {
  const mapped = storageMapper(db, key, storageId(key));
  return linesOf(mapped.kind, mapped.mapper, unitRows(db, key)).map((line) => JSON.stringify(line));
}

/** The files of one unit: [{ rel, data }] relative to the unit's directory. `unitFull` is the unit's full path. */
export function filesOfUnit(
  db: Db,
  unitRelGiven: unknown,
  info: MappedPath,
  unitFullGiven: unknown = unitRelGiven
): Array<{ rel: string; data: Buffer }> {
  const unitRel = unitRelGiven as string;
  const unitFull = unitFullGiven as string;
  const rows = unitRows(db, unitFull);
  const { kind, mapper, format } = info;
  // The line vectors are rows of a place, not month units (line-vectors.ts): no unit holds a month's files.
  if (format === 'vectors') return [];
  if (format === 'jsonl') {
    const lines = linesOf(kind, mapper, rows).map((line) => `${JSON.stringify(line)}\n`);
    return [{ rel: unitRel, data: Buffer.from(lines.join(''), 'utf8') }];
  }
  const value = mapper.fromRows(rows);
  const text = format === 'text' ? String(value) : JSON.stringify(value, null, 2);
  return [{ rel: unitRel, data: Buffer.from(text, 'utf8') }];
}

/** The ids (unit names without `.json`) of the JSON memory units directly under `relDir`, or null when the database holds none. */
export function idsUnderDir(database: unknown, relDir: string): Array<string> | null {
  const db = ((database as { db?: Db }).db ?? database) as Db; // an `openMemoryDb` handle or its connection
  const prefix = `${String(relDir).replace(/\\/g, '/').replace(/\/+$/, '')}/`;
  const ids: Array<string> = [];
  for (const row of db
    .prepare('SELECT path FROM files WHERE gone_at IS NULL AND substr(path, 1, ?) = ?')
    .all(prefix.length, prefix)) {
    const rest = String(row.path).slice(prefix.length);
    if (!rest.includes('/') && rest.endsWith('.json')) ids.push(rest.slice(0, -5));
  }
  return ids.length > 0 ? ids : null;
}
