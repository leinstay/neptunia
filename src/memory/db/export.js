// A memory unit rebuilt from the database alone (spec 2026-10-24-memory-store, section 6): what the memory modules read
// (src/memory/db/readers/), in the shape the unit had as a file under data/.
//
// Which units exist comes from the `files` table (the writers record every unit they wrote, a month of vectors being
// one unit; a unit that is gone is a tombstone, `gone_at`); what is in them comes from the rows whose `owner_file` is
// the unit's full path (`guilds/<g>/users/<u>.json`) or that the unit shares with another guild (`co_owners`), and that
// are not retired. A JSON unit is built the way the store writes it (2 spaces, no trailing newline), a JSONL unit one
// line per row in its line order, vector bytes exactly, operational rows verbatim.
//
// exportOne(database, relPath) -> { found, value } | { found: false, reason }   (one JSON unit's value)

import { classify } from './map/index.js';
import { filesOf } from './map/vectors.js';
import { OWNED } from './upsert.js';

const CHILDREN = {
  episode_sources: ['episodes', 'episode_id'],
  claim_sources: ['claims', 'claim_id'],
  diary_mirrors: ['diary', 'diary_id'],
};

const HAS_POSITION = new Set([
  'sources',
  'claims',
  'claim_versions',
  'description_versions',
  'episodes',
  'affinity_events',
  'day',
  'diary',
  'intentions',
  'work',
  'work_events',
  'decisions',
]);

const KEY_SQL = (table) =>
  OWNED[table].length === 1 ? `"${OWNED[table][0]}"` : OWNED[table].map((col) => `"${col}"`).join(' || char(0) || ');

/** The active rows of one unit (`owner` is its full path): table -> rows (every table present), children included. */
export function unitRows(db, owner) {
  const rows = {};
  for (const table of Object.keys(OWNED)) {
    const order = HAS_POSITION.has(table) ? 'position, rowid' : 'rowid';
    rows[table] = db
      .prepare(
        `SELECT * FROM "${table}" WHERE (owner_file = ? OR ${KEY_SQL(table)} IN (SELECT key FROM co_owners WHERE tbl = ? AND owner_file = ?)) AND retired_at IS NULL ORDER BY ${order}`
      )
      .all(owner, table, owner)
      .map((row) => ({ ...row }));
  }
  for (const [child, [parent, link]] of Object.entries(CHILDREN)) {
    rows[child] = db
      .prepare(
        `SELECT c.* FROM "${child}" c JOIN "${parent}" p ON p.id = c."${link}"
      WHERE (p.owner_file = ? OR p.id IN (SELECT key FROM co_owners WHERE tbl = ? AND owner_file = ?)) AND p.retired_at IS NULL AND c.retired_at IS NULL ORDER BY ${child === 'diary_mirrors' ? 'c.rowid' : 'c.position, c.rowid'}`
      )
      .all(owner, parent, owner)
      .map((row) => ({ ...row }));
  }
  return rows;
}

const positionOfOwner = (row) => Number(String(row.owner).split('#').pop());

/** The lines of a JSONL unit, in file order. */
function linesOf(kind, mapper, rows) {
  const one = (table, row) => mapper.fromRows({ [table]: [row] });
  switch (kind) {
    case 'record':
      return rows.sources.map((row) => one('sources', row));
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
    case 'journal': {
      const answers = new Map(rows.sources.map((row) => [row.id, row]));
      const items = [
        ...rows.day.map((row) => ({
          position: row.position,
          build: () =>
            mapper.fromRows({ day: [row], sources: answers.has(row.source_id) ? [answers.get(row.source_id)] : [] }),
        })),
        ...rows.decisions.map((row) => ({
          position: row.position,
          build: () =>
            mapper.fromRows({
              decisions: [row],
              affinity_events: rows.affinity_events.filter((event) => event.id.startsWith(`aff:${row.id}:`)),
            }),
        })),
      ];
      return items
        .map((item, index) => [item, index])
        .sort((a, b) => (a[0].position ?? 0) - (b[0].position ?? 0) || a[1] - b[1])
        .map(([item]) => item.build());
    }
    default:
      throw new Error(`no line export for kind ${kind}`);
  }
}

/** The files of one unit: [{ rel, data }] relative to the unit's guild directory. `unitFull` is the unit's full path. */
export function filesOfUnit(db, unitRel, info, unitFull = unitRel) {
  const rows = unitRows(db, unitFull);
  const { kind, mapper, format } = info;
  if (format === 'vectors') {
    if (!rows.operational.length) return [];
    return filesOf(`${unitRel}/manifest.json`, mapper.fromRows(rows)).map((file) => ({
      rel: file.rel,
      data: file.data,
    }));
  }
  if (format === 'jsonl') {
    const lines = linesOf(kind, mapper, rows).map((line) => `${JSON.stringify(line)}\n`);
    return [{ rel: unitRel, data: Buffer.from(lines.join(''), 'utf8') }];
  }
  const value = mapper.fromRows(rows);
  const text = format === 'text' ? String(value) : JSON.stringify(value, null, 2);
  return [{ rel: unitRel, data: Buffer.from(text, 'utf8') }];
}

/**
 * The value of one JSON memory unit, built from the database alone. `relPath` is relative to the data root
 * (`guilds/<id>/users/<id>.json`). Not found, with the reason: `unmapped` (not a memory unit, or not a JSON one),
 * `missing` (the database holds no unit for it), `empty` (the unit has no rows).
 * @returns {{ found: true, value: any } | { found: false, reason: string }}
 */
export function exportOne(database, relPath) {
  const db = database.db ?? database;
  const info = classify(relPath);
  if (!info || info.skipped || info.format !== 'json') return { found: false, reason: 'unmapped' };
  const full = info.guildId === undefined ? info.unit : `guilds/${info.guildId}/${info.unit}`;
  const file = db.prepare('SELECT 1 AS ok FROM files WHERE path = ? AND gone_at IS NULL').get(full);
  if (!file) return { found: false, reason: 'missing' };
  const [out] = filesOfUnit(db, info.unit, info, full);
  if (!out) return { found: false, reason: 'empty' };
  return { found: true, value: JSON.parse(out.data.toString('utf8')) };
}

/** The ids (unit names without `.json`) of the JSON memory units directly under `relDir`, or null when the database holds none. */
export function idsUnderDir(database, relDir) {
  const db = database.db ?? database;
  const prefix = `${String(relDir).replace(/\\/g, '/').replace(/\/+$/, '')}/`;
  const ids = [];
  for (const row of db
    .prepare('SELECT path FROM files WHERE gone_at IS NULL AND substr(path, 1, ?) = ?')
    .all(prefix.length, prefix)) {
    const rest = row.path.slice(prefix.length);
    if (!rest.includes('/') && rest.endsWith('.json')) ids.push(rest.slice(0, -5));
  }
  return ids.length > 0 ? ids : null;
}
