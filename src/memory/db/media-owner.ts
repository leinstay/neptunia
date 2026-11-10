// Whose a row of `media` is (version step 52, src/memory/db/schema.ts): the describer's cache of a place keeps its rows
// as `writer` `media` with the place as `holder_id`, and the GIF library as `writer` `gifs` with the persona as holder
// (src/memory/db/media-store.ts). `used_at` is the moment a cache row was last written, which its trim orders by. A row
// of a line no unit owned keeps no owner.
//
// The step also folds the describer's saved descriptions into the rows they describe: a description lives on its item's
// row and nowhere else, so the `descriptions` and `description_versions` of subject kind `media`, the `operational` rows of
// their histories, their units and their graph nodes go. A saved description whose key no row holds becomes that key's
// entry. Every live row of `media` that has no graph node gets one.

import { projectRow } from './graph.ts';
import { cacheIface, isMediaDescriptionEntry, writeMediaEntry } from './media-store.ts';
import { asText, isFiniteNumber } from './types.ts';
import type { Db, Row } from './types.ts';

/** The rows of `media` that a media cache or the GIF library owns take that unit's owner columns and last use. */
function stampOwners(db: Db): void {
  db.exec(`UPDATE media SET writer = CASE u.kind WHEN 'gifs' THEN 'gifs' ELSE 'media' END, holder_id = u.subject_id
    FROM storage_units u WHERE u.id = media.owner_key AND u.kind IN ('media', 'gifs')`);
  db.exec(`UPDATE media SET used_at = (
      SELECT MAX(COALESCE(json_extract(j.value, '$.usedAt'), json_extract(j.value, '$.ts')))
      FROM json_each(media.extra, '$.cache') j)
    WHERE writer IS NOT NULL AND json_valid(extra) AND json_type(extra, '$.cache') = 'object'`);
}

/** Every key a row of `media` holds in its cache, live or retired, as `<interface> <key>`. One pass over the rows. */
function heldKeys(db: Db): Set<string> {
  const held = new Set<string>();
  for (const row of db
    .prepare(
      "SELECT m.scope_iface AS iface, j.key AS key FROM media m, json_each(m.extra, '$.cache') j WHERE json_valid(m.extra)"
    )
    .all())
    held.add(`${asText(row.iface ?? '')} ${asText(row.key)}`);
  return held;
}

/** The interface of the rows a place's cache holds: what a place with no row of its own wrote them under. */
function cacheRowsIface(db: Db, placeId: string): string | null {
  const iface = db
    .prepare("SELECT scope_iface FROM media WHERE writer = 'media' AND holder_id = ? LIMIT 1")
    .get(placeId)?.scope_iface;
  return typeof iface === 'string' && iface !== '' ? iface : null;
}

/** A saved description of media: its key, the place whose cache saved it, its current entry and its interface. */
type Saved = { id: string; holder: string; place: string; key: string; entry: Row | null; iface: string | null };

/** The saved descriptions of media. */
function savedDescriptions(db: Db): Array<Saved> {
  return db
    .prepare(
      `SELECT d.id, d.holder_id, d.subject_id, d.scope_iface, v.extra FROM descriptions d
       LEFT JOIN description_versions v ON v.id = d.current_version WHERE d.subject_kind = 'media'`
    )
    .all()
    .map((row) => {
      const holder = asText(row.holder_id);
      const cut = holder.indexOf('/media/');
      let entry: Row | null = null;
      try {
        const extra = JSON.parse(asText(row.extra ?? '{}')) as Row;
        const failed = isFiniteNumber(extra.refreshFailedAt) ? { refreshFailedAt: extra.refreshFailedAt } : {};
        entry = isMediaDescriptionEntry(extra.entry) ? { ...extra.entry, ...failed } : null;
      } catch {
        // A version whose extra does not parse holds no entry to keep.
        entry = null;
      }
      return {
        id: asText(row.id),
        holder,
        place: cut > 0 ? holder.slice(0, cut) : '',
        key: asText(row.subject_id),
        entry,
        iface: typeof row.scope_iface === 'string' && row.scope_iface !== '' ? row.scope_iface : null,
      };
    });
}

/** Removes the graph nodes of `ids` (`<kind>:<row id>`), their witnesses and their edges. */
function dropNodes(db: Db, ids: ReadonlyArray<string>): void {
  const list = JSON.stringify(ids);
  db.prepare('DELETE FROM node_access WHERE node_id IN (SELECT value FROM json_each(?))').run(list);
  db.prepare(
    'DELETE FROM graph_edges WHERE src IN (SELECT value FROM json_each(?)) OR dst IN (SELECT value FROM json_each(?))'
  ).run(list, list);
  db.prepare('DELETE FROM graph_nodes WHERE id IN (SELECT value FROM json_each(?))').run(list);
}

/** The saved descriptions of media become entries of their rows where no row holds their key, then go. */
function foldDescriptions(db: Db): void {
  const saved = savedDescriptions(db);
  const held = heldKeys(db);
  for (const one of saved) {
    if (!one.entry || one.place === '' || one.key === '') continue;
    const iface = cacheIface(db, one.place, cacheRowsIface(db, one.place) ?? one.iface);
    if (held.has(`${iface ?? ''} ${one.key}`)) continue;
    const at = isFiniteNumber(one.entry.ts) ? one.entry.ts : Date.now();
    writeMediaEntry(db, { placeId: one.place, iface, key: one.key, entry: one.entry, at });
  }
  const versions = db
    .prepare(
      "SELECT v.id FROM description_versions v JOIN descriptions d ON d.id = v.description_id WHERE d.subject_kind = 'media'"
    )
    .all()
    .map((row) => asText(row.id));
  const units = db
    .prepare(
      "SELECT id FROM storage_units WHERE kind = 'versions' AND json_extract(selector, '$.versionKind') = 'media'"
    )
    .all()
    .map((row) => asText(row.id));
  const holders = JSON.stringify(saved.map((one) => one.holder));
  const unitList = JSON.stringify(units);
  db.prepare(
    `DELETE FROM operational WHERE kind = 'versions' AND (holder_id IN (SELECT value FROM json_each(?))
       OR owner_key IN (SELECT value FROM json_each(?)))`
  ).run(holders, unitList);
  db.prepare(
    "DELETE FROM description_versions WHERE description_id IN (SELECT id FROM descriptions WHERE subject_kind = 'media')"
  ).run();
  db.prepare("DELETE FROM descriptions WHERE subject_kind = 'media'").run();
  db.prepare('DELETE FROM legacy_unit_aliases WHERE unit_id IN (SELECT value FROM json_each(?))').run(unitList);
  db.prepare('DELETE FROM storage_units WHERE id IN (SELECT value FROM json_each(?))').run(unitList);
  dropNodes(db, [...saved.map((one) => `description:${one.id}`), ...versions.map((id) => `description_version:${id}`)]);
}

/** Every live row of `media` without a graph node gets its node. */
function projectMissing(db: Db): void {
  const missing = db
    .prepare(
      "SELECT id FROM media WHERE retired_at IS NULL AND NOT EXISTS (SELECT 1 FROM graph_nodes g WHERE g.id = 'media:' || media.id)"
    )
    .all();
  for (const row of missing) projectRow(db, 'media', { id: row.id });
}

/** Version step 52, after its columns are added (schema.ts). */
export function ownMediaRows(db: Db): void {
  stampOwners(db);
  foldDescriptions(db);
  projectMissing(db);
}
