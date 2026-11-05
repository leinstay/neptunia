// The GIF rows of a database from before the shared library, carried over at the open that follows schema version 32 or
// the offline conversion (src/memory/db/open.ts#migrate). A link an old row holds in `path` moves to `extra.url`, retired
// rows included, because `path` is null or a file under `media/` on every media row. Each place's rows are read through its
// mapper and merged (src/memory/gifs.ts#mergePlaceLibraries, with the captions of that place's media cache); the old
// units are retired with their rows, and the one library is written under the persona. A database with no such unit
// stays as it is, so a second run does nothing.

import { mergePlaceLibraries } from '../gifs.ts';
import { storageValue } from './export.ts';
import { storageMapper } from './map/index.ts';
import { personaKey, placeCollection } from './storage-keys.ts';
import { ensureUnit, listUnits } from './storage-units.ts';
import { qualify, retireAbsent, writeMapping } from './upsert.ts';
import { adoptLibraryRows } from './media-store.ts';
import type { StorageKey } from './storage-keys.ts';
import type { Db } from './types.ts';

const MERGED_AT = new Date(Date.UTC(2026, 10, 5)).toISOString();

/** One unit's value written over its rows, on the connection the caller holds a transaction on. */
function writeOver(db: Db, key: StorageKey, value: unknown): void {
  const id = ensureUnit(db, key);
  const { mapper } = storageMapper(db, key, id);
  const mapping = qualify(mapper.toRows(id, value, {}), { rel: id, full: id });
  writeMapping(db, mapping, id, { at: MERGED_AT });
  retireAbsent(db, id, mapping, MERGED_AT);
  adoptLibraryRows(db, id, MERGED_AT);
}

/** The old rows' links in `extra.url`. A row that already names a url keeps it. */
function moveLinksToExtra(db: Db): void {
  db.exec(`UPDATE media
    SET extra = json_set(COALESCE(NULLIF(extra, ''), '{}'), '$.url', COALESCE(json_extract(NULLIF(extra, ''), '$.url'), path)),
        path = NULL
    WHERE kind = 'gif' AND path IS NOT NULL AND path NOT LIKE 'media/%'`);
}

/** Merges every per-place library of `db` into the persona's one. Answers how many places it merged. */
export function mergeGifLibraries(db: Db): number {
  moveLinksToExtra(db);
  const units = listUnits(db, { kind: 'gifs' }).filter((unit) => unit.key.subject.type === 'place');
  if (units.length === 0) return 0;
  const libraries: Record<string, unknown> = {};
  const caches: Record<string, Record<string, unknown>> = {};
  for (const unit of units) {
    const placeId = unit.key.subject.id;
    libraries[placeId] = storageValue(db, unit.key);
    caches[placeId] = storageValue(db, placeCollection('media', placeId)) as Record<string, unknown>;
  }
  const merged = mergePlaceLibraries(libraries, caches);
  for (const unit of units) {
    writeOver(db, unit.key, { nextId: 1, entries: {} });
    db.prepare("DELETE FROM operational WHERE kind = 'gifs' AND owner_key = ?").run(unit.id);
    db.prepare('UPDATE storage_units SET retired_at = ? WHERE id = ?').run(MERGED_AT, unit.id);
  }
  writeOver(db, personaKey('gifs'), merged);
  return units.length;
}
