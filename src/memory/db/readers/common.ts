// The shared half of the database readers: how a module's read of a memory unit is answered from the database, and
// the seam every memory module reads through.
//
// The memory files are units: one file (a record day, a journal day, an archive month, `intentions.json`) or one
// directory (a month of vectors), and every row a unit's mapper wrote carries the unit's path as `owner_file`
// (`guilds/<g>/record/2026-10/2026-10-20.jsonl`). A reader answers a file read with the unit rebuilt by the export
// (export.ts#unitRows, #filesOfUnit, the mapper's `fromRows`), so a module reading through it parses the same lines,
// in the same order, as from the disk, and keeps one copy of its own logic (filters, joins, ordering) for both
// backends. A directory listing is the distinct `owner_file` values under the directory's path, sorted as bytes
// (the same order as a sorted `readdir` of ASCII names). These are the core's own reads of the whole memory: no
// audience, no execution context.
//
// The seam (`createReadSeam`): `db()` is the read connection of the service (`memoryDb.readHandle()`), or an error
// with code `DB_CLOSED` when the database is not open (or no service is given). A failed database read is an error to
// the caller, logged once with its code (`memory db: read failed`, fields `reader` and `code`). Logs carry codes only.

import { rootStateKind } from '../paths.ts';
import { filesOfUnit, unitRows } from '../export.ts';
import { classify } from '../map/index.ts';
import type { MappedPath } from '../map/index.ts';
import { asText } from '../types.ts';
import type { Db, Log } from '../types.ts';

const END = '￿';

/** An Error with a code. */
export function codedError(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** `guilds/<g>/<sub>`, or `guilds/<g>/private/<u>/<sub>` for a member's private layer (no trailing slash). */
export function layerDir(guildId: string, privateUserId: unknown, sub: unknown): string {
  const layer =
    typeof privateUserId === 'string' && privateUserId
      ? `guilds/${guildId}/private/${privateUserId}`
      : `guilds/${guildId}`;
  return sub ? `${layer}/${asText(sub)}` : layer;
}

/** The distinct `owner_file` values of the active rows of `table` under the directory `relDir`, sorted as bytes. */
export function ownersUnder(
  db: Db,
  table: string,
  relDir: unknown,
  { kind = null }: { kind?: string | null } = {}
): Array<string> {
  const prefix = `${String(relDir).replace(/\/+$/, '')}/`;
  const sql = `SELECT DISTINCT owner_file AS owner FROM "${table}" WHERE owner_file >= ? AND owner_file < ? AND retired_at IS NULL${kind ? ' AND kind = ?' : ''} ORDER BY owner_file`;
  const args = kind ? [prefix, prefix + END, kind] : [prefix, prefix + END];
  return db
    .prepare(sql)
    .all(...args)
    .map((row) => String(row.owner));
}

/** The names directly under `relDir` among `owners` (the first path segment after it), distinct, sorted as bytes. */
export function childNames(owners: ReadonlyArray<string>, relDir: unknown): Array<string> {
  const prefix = `${String(relDir).replace(/\/+$/, '')}/`;
  const names = new Set<string>();
  for (const owner of owners) {
    if (!owner.startsWith(prefix)) continue;
    const rest = owner.slice(prefix.length);
    const name = rest.split('/')[0];
    if (name) names.add(name);
  }
  return [...names].sort(byBytes);
}

/** Sorts strings the way SQLite's BINARY collation and a sorted ASCII `readdir` do. */
export function byBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function infoOf(owner: string, format: string): MappedPath {
  const info = classify(owner);
  if (!info || 'skipped' in info || info.format !== format)
    throw codedError('READER_UNMAPPED', 'not a memory unit of this format');
  return info;
}

const unitRelOf = (owner: string) => /^guilds\/[^/]+\/(.+)$/.exec(owner)?.[1] ?? owner;

/**
 * The lines of a JSONL memory unit (`owner` its full path) rebuilt from the database, in file order, without their
 * newlines: what reading the file line by line gives. A unit the database holds no row of has no lines.
 */
export function unitLines(dbGiven: unknown, owner: string): Array<string> {
  const db = dbGiven as Db;
  const info = infoOf(owner, 'jsonl');
  const [out] = filesOfUnit(db, unitRelOf(owner), info, owner);
  const text = out ? out.data.toString('utf8') : '';
  return text === '' ? [] : text.replace(/\n$/, '').split('\n');
}

/**
 * The value of a JSON memory unit rebuilt from the database (what `JSON.parse` of the file gives), or not found when
 * the database holds no row of it (a missing file).
 */
export function unitValue(dbGiven: unknown, ownerGiven: unknown): { found: true; value: unknown } | { found: false } {
  const db = dbGiven as Db;
  const owner = ownerGiven as string;
  const kind = rootStateKind(owner);
  if (kind) {
    const row = db
      .prepare('SELECT value FROM operational WHERE kind = ? AND owner = ? AND owner_file IS NULL')
      .get(kind, owner);
    return row ? { found: true, value: JSON.parse(String(row.value)) } : { found: false };
  }
  const info = infoOf(owner, 'json');
  const rows = unitRows(db, owner);
  if (!Object.values(rows).some((list) => list.length > 0)) return { found: false };
  return { found: true, value: JSON.parse(JSON.stringify(info.mapper.fromRows(rows))) };
}

/**
 * The seam of one module (see the head of this file): `db()` is the read connection, `run(fn)` is `fn()` with its
 * failure logged once with a code.
 */
export function createReadSeam({
  memoryDb = null,
  log,
  reader,
}: {
  memoryDb?: { readHandle?: () => { db: object } | null } | null;
  log: Pick<Log, 'warn'>;
  reader: string;
}): { db(): Db; run<TResult>(fn: () => TResult): TResult } {
  type Failure = Error & { code?: string; memoryDbLogged?: boolean };
  function failed(error: unknown): Failure {
    const out: Failure = error instanceof Error ? error : codedError('DB_READ_FAILED');
    if (!out.code) out.code = 'DB_READ_FAILED';
    if (!out.memoryDbLogged) {
      out.memoryDbLogged = true;
      log.warn('memory db: read failed', { reader, code: out.code });
    }
    return out;
  }

  /** The read connection, else throws `DB_CLOSED`. */
  function db(): Db {
    const handle = memoryDb?.readHandle?.() ?? null;
    if (!handle?.db) throw failed(codedError('DB_CLOSED', 'memory db is not open'));
    return handle.db as Db;
  }

  /** `fn()`, its failure logged with a code and thrown again. */
  function run<TResult>(fn: () => TResult): TResult {
    try {
      return fn();
    } catch (error) {
      throw failed(error);
    }
  }

  return { db, run };
}
