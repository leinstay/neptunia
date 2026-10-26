// The shared half of the database readers: how a module's read of a memory unit is answered from the database, and
// the seam every memory module reads through.
//
// The memory files are units: one file (a record day, a journal day, an archive month, `intentions.json`) or one
// directory (a month of vectors), and every row a unit's mapper wrote carries the unit's path as `owner_file`
// (`guilds/<g>/record/2026-10/2026-10-20.jsonl`). A reader answers a file read with the unit rebuilt by the export
// (export.js#unitRows, #filesOfUnit, the mapper's `fromRows`), so a module reading through it parses the same lines,
// in the same order, as from the disk, and keeps one copy of its own logic (filters, joins, ordering) for both
// backends. A directory listing is the distinct `owner_file` values under the directory's path, sorted as bytes
// (the same order as a sorted `readdir` of ASCII names). These are the core's own reads of the whole memory: no
// audience, no execution context.
//
// The seam (`createReadSeam`): `db()` is the read connection of the service (`memoryDb.readHandle()`), or an error
// with code `DB_CLOSED` when the database is not open (or no service is given). A failed database read is an error to
// the caller, logged once with its code (`memory db: read failed`, fields `reader` and `code`). Logs carry codes only.

import { filesOfUnit, unitRows } from '../export.js';
import { classify } from '../map/index.js';

const END = '￿';

/** An Error with a code. */
export function codedError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

/** `guilds/<g>/<sub>`, or `guilds/<g>/private/<u>/<sub>` for a member's private layer (no trailing slash). */
export function layerDir(guildId, privateUserId, sub) {
  const layer =
    typeof privateUserId === 'string' && privateUserId
      ? `guilds/${guildId}/private/${privateUserId}`
      : `guilds/${guildId}`;
  return sub ? `${layer}/${sub}` : layer;
}

/** The distinct `owner_file` values of the active rows of `table` under the directory `relDir`, sorted as bytes. */
export function ownersUnder(db, table, relDir, { kind = null } = {}) {
  const prefix = `${String(relDir).replace(/\/+$/, '')}/`;
  const sql = `SELECT DISTINCT owner_file AS owner FROM "${table}" WHERE owner_file >= ? AND owner_file < ? AND retired_at IS NULL${kind ? ' AND kind = ?' : ''} ORDER BY owner_file`;
  const args = kind ? [prefix, prefix + END, kind] : [prefix, prefix + END];
  return db
    .prepare(sql)
    .all(...args)
    .map((row) => row.owner);
}

/** The names directly under `relDir` among `owners` (the first path segment after it), distinct, sorted as bytes. */
export function childNames(owners, relDir) {
  const prefix = `${String(relDir).replace(/\/+$/, '')}/`;
  const names = new Set();
  for (const owner of owners) {
    if (!owner.startsWith(prefix)) continue;
    const rest = owner.slice(prefix.length);
    const name = rest.split('/')[0];
    if (name) names.add(name);
  }
  return [...names].sort(byBytes);
}

/** Sorts strings the way SQLite's BINARY collation and a sorted ASCII `readdir` do. */
export function byBytes(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function infoOf(owner, format) {
  const info = classify(owner);
  if (!info || info.skipped || info.format !== format)
    throw codedError('READER_UNMAPPED', 'not a memory unit of this format');
  return info;
}

const unitRelOf = (owner) => /^guilds\/[^/]+\/(.+)$/.exec(owner)?.[1] ?? owner;

/**
 * The lines of a JSONL memory unit (`owner` its full path) rebuilt from the database, in file order, without their
 * newlines: what reading the file line by line gives. A unit the database holds no row of has no lines.
 * @returns {string[]}
 */
export function unitLines(db, owner) {
  const info = infoOf(owner, 'jsonl');
  const [out] = filesOfUnit(db, unitRelOf(owner), info, owner);
  const text = out ? out.data.toString('utf8') : '';
  return text === '' ? [] : text.replace(/\n$/, '').split('\n');
}

/**
 * The value of a JSON memory unit rebuilt from the database (what `JSON.parse` of the file gives), or not found when
 * the database holds no row of it (a missing file).
 * @returns {{ found: true, value: any } | { found: false }}
 */
export function unitValue(db, owner) {
  const info = infoOf(owner, 'json');
  const rows = unitRows(db, owner);
  if (!Object.values(rows).some((list) => list.length > 0)) return { found: false };
  return { found: true, value: JSON.parse(JSON.stringify(info.mapper.fromRows(rows))) };
}

/**
 * The seam of one module (see the head of this file).
 * @param {{ memoryDb?: { readHandle?: () => ({ db: object }|null) }|null, log: { warn: Function }, reader: string }} options
 * @returns {{ db(): object, run<T>(fn: () => T): T }}
 */
export function createReadSeam({ memoryDb = null, log, reader }) {
  function failed(error) {
    const out = error instanceof Error ? error : codedError('DB_READ_FAILED');
    if (!out.code) out.code = 'DB_READ_FAILED';
    if (!out.memoryDbLogged) {
      out.memoryDbLogged = true;
      log.warn('memory db: read failed', { reader, code: out.code });
    }
    return out;
  }

  /** The read connection, else throws `DB_CLOSED`. */
  function db() {
    const handle = memoryDb?.readHandle?.() ?? null;
    if (!handle?.db) throw failed(codedError('DB_CLOSED', 'memory db is not open'));
    return handle.db;
  }

  /** `fn()`, its failure logged with a code and thrown again. */
  function run(fn) {
    try {
      return fn();
    } catch (error) {
      throw failed(error);
    }
  }

  return { db, run };
}
