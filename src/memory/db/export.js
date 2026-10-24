// Export: writes today's JSON memory layout from the database alone (spec section 6), so the round trip can be
// proved file by file (`tools/memory-db.mjs verify`) and the old files can one day be rebuilt or dropped.
//
// Which files exist comes from the `files` table (a sync records every unit it read, a month of vectors being one
// unit); what is in them comes from the rows whose `owner_file` is that unit and that are not retired. A retired row
// left its file, so it is not written. JSON is written the way the store writes it (2 spaces, no trailing newline),
// a JSONL file one line per row in the old line order, vector bytes exactly, operational rows verbatim.
//
// exportAll(database, toDir) -> { files, byKind, failed }

import fs from 'node:fs';
import path from 'node:path';
import { classify } from './map/index.js';
import { filesOf } from './map/vectors.js';
import { OWNED } from './sync.js';

const CHILDREN = {
  episode_sources: ['episodes', 'episode_id'],
  claim_sources: ['claims', 'claim_id'],
  diary_mirrors: ['diary', 'diary_id'],
};

const HAS_POSITION = new Set([
  'sources', 'claims', 'claim_versions', 'description_versions', 'episodes', 'affinity_events', 'day', 'diary',
  'intentions', 'work', 'work_events', 'decisions',
]);

/** The active rows of one unit: table -> rows (every table present), children included. */
export function unitRows(db, rel) {
  const rows = {};
  for (const table of Object.keys(OWNED)) {
    const order = HAS_POSITION.has(table) ? 'position, rowid' : 'rowid';
    rows[table] = db.prepare(`SELECT * FROM "${table}" WHERE owner_file = ? AND retired_at IS NULL ORDER BY ${order}`).all(rel).map((row) => ({ ...row }));
  }
  for (const [child, [parent, link]] of Object.entries(CHILDREN)) {
    rows[child] = db.prepare(`SELECT c.* FROM "${child}" c JOIN "${parent}" p ON p.id = c."${link}" WHERE p.owner_file = ? AND p.retired_at IS NULL ORDER BY c.rowid`)
      .all(rel).map((row) => ({ ...row }));
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
    case 'tasks':
      return rows.work_events.map((row) => one('work_events', row));
    case 'verbatim':
      return [...rows.operational].sort((a, b) => positionOfOwner(a) - positionOfOwner(b)).map((row) => one('operational', row));
    case 'journal': {
      const answers = new Map(rows.sources.map((row) => [row.id, row]));
      const items = [
        ...rows.day.map((row) => ({ position: row.position, build: () => mapper.fromRows({ day: [row], sources: answers.has(row.source_id) ? [answers.get(row.source_id)] : [] }) })),
        ...rows.decisions.map((row) => ({
          position: row.position,
          build: () => mapper.fromRows({ decisions: [row], affinity_events: rows.affinity_events.filter((event) => event.id.startsWith(`aff:${row.id}:`)) }),
        })),
      ];
      return items.map((item, index) => [item, index]).sort((a, b) => (a[0].position ?? 0) - (b[0].position ?? 0) || a[1] - b[1]).map(([item]) => item.build());
    }
    default:
      throw new Error(`no line export for kind ${kind}`);
  }
}

/** The files of one unit: [{ rel, data }] relative to the unit's guild directory. */
export function filesOfUnit(db, unitRel, info) {
  const rows = unitRows(db, unitRel);
  const { kind, mapper, format } = info;
  if (format === 'vectors') {
    if (!rows.operational.length) return [];
    return filesOf(`${unitRel}/manifest.json`, mapper.fromRows(rows)).map((file) => ({ rel: file.rel, data: file.data }));
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
 * Writes the whole layout under `toDir` (`<toDir>/guilds/<guildId>/...`). A unit that cannot be rebuilt is counted in
 * `failed` (kind and error code) and skipped.
 */
export function exportAll(database, toDir) {
  const db = database.db ?? database;
  const result = { files: 0, byKind: {}, failed: [] };
  for (const file of db.prepare('SELECT path, kind FROM files ORDER BY path').all()) {
    const match = /^guilds\/([^/]+)\/(.+)$/.exec(file.path);
    const guildPrefix = match ? `guilds/${match[1]}/` : '';
    const unitRel = match ? match[2] : file.path;
    const info = classify(file.kind === 'vectors' ? `${file.path}/manifest.json` : file.path);
    const counts = (result.byKind[file.kind] ??= { files: 0 });
    if (!info || info.skipped) continue;
    try {
      for (const out of filesOfUnit(db, unitRel, info)) {
        const target = path.join(toDir, guildPrefix, out.rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, out.data);
        counts.files += 1;
        result.files += 1;
      }
    } catch (error) {
      result.failed.push({ kind: file.kind, code: error?.code ?? error?.name ?? 'ERROR' });
    }
  }
  return result;
}
