// The GIF library of the persona (src/memory/gifs.ts) as rows: each entry is the row `media:gif:<key>` of kind `gif`,
// written with `writer` `gifs` and the persona as `holder_id`, and the rest of the library (`nextId`, the backfill
// stamps) is the `operational` row of kind `gifs` owned by the persona. A row is the GIF's item too, so its text form,
// its describer's cache entries and its state stay its own and an entry never holds them.
//
// An entry's `file` is the row's `path` when it is a file under `media/`, its `itemId` the `native_ref`; every other
// field sits in `extra`. An entry that is not an object is kept whole as `{ $raw: value }`. The scope is the group scope
// of the interface the write came from, as for the entry's caption vector (gif-vectors.ts).
//
// The writer (session-write.ts, write kind `gif-library`) takes the entries a change put and the keys it dropped, never
// the whole library: a put row is revived and projected, and takes over a row an observation made for the same item
// (media-store.ts#adoptSameItem); a dropped row is retired unless a line links it. `gifLibraryValue` reads the library
// back in the order its rows were made. `ownGifRows` is version step 53, which moved the library off its unit.

import { projectRow } from './graph.ts';
import { adoptSameItem, keepItemFields } from './media-store.ts';
import { PERSONA_ID } from './storage-keys.ts';
import { audienceOf, groupScope } from './scope.ts';
import { ensureAudience } from './rows.ts';
import { namedIface } from './live-iface.ts';
import { dbOf, isFiniteNumber } from './types.ts';
import type { Db, MemoryHandle, Row } from './types.ts';

/** The prefix of a library row's id; the entry's key follows it. */
const PREFIX = 'media:gif:';
/** Who holds the library's rows: the persona. */
export const GIF_LIBRARY_HOLDER = PERSONA_ID;

/** One write of the library: the entries a change put by key, the keys it dropped, and the rest when it changed. */
export type GifLibraryWrite = {
  put?: Record<string, unknown>;
  drop?: ReadonlyArray<string>;
  rest?: Record<string, unknown>;
};

/** The fields of a row's `extra` that are the item's and never an entry's. */
const ITEM_FIELDS = ['textOrigin', 'frame', 'watched', 'cache'];

const isPlainObject = (value: unknown): value is Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';

function parsed(text: unknown): Row {
  if (typeof text !== 'string' || text === '') return {};
  const value: unknown = JSON.parse(text);
  return isPlainObject(value) ? value : {};
}

/** The columns and the remainder of an entry. */
function columnsOf(entry: unknown): { path: string | null; native_ref: string | null; extra: Row } {
  if (!isPlainObject(entry)) return { path: null, native_ref: null, extra: { $raw: entry } };
  const extra = { ...entry };
  const file = entry.file;
  const path = typeof file === 'string' && file.startsWith('media/') ? file : null;
  if (path !== null) delete extra.file;
  const native = typeof entry.itemId === 'string' ? entry.itemId : null;
  if (native !== null) delete extra.itemId;
  return { path, native_ref: native, extra };
}

/** The entry a row holds. */
function entryOf(row: Row): unknown {
  const extra = parsed(row.extra);
  for (const field of ITEM_FIELDS) delete extra[field];
  if (Object.hasOwn(extra, '$raw')) return extra.$raw;
  // A row an older write made names its null fields apart.
  const nulls = Array.isArray(extra.$null) ? (extra.$null as Array<unknown>) : [];
  delete extra.$null;
  for (const key of nulls) if (typeof key === 'string' && !Object.hasOwn(extra, key)) extra[key] = null;
  return {
    ...(typeof row.path === 'string' ? { file: row.path } : {}),
    ...(typeof row.native_ref === 'string' ? { itemId: row.native_ref } : {}),
    ...extra,
  };
}

/**
 * The library rebuilt from its rows (entries in the order their rows were made) and its operational row, or not found
 * when the database holds neither.
 */
export function gifLibraryValue(db: Db): { found: true; value: Row } | { found: false } {
  const rows = db
    .prepare(
      "SELECT id, path, native_ref, extra FROM media WHERE writer = 'gifs' AND holder_id = ? AND retired_at IS NULL ORDER BY rowid"
    )
    .all(GIF_LIBRARY_HOLDER);
  const rest = db
    .prepare("SELECT value FROM operational WHERE kind = 'gifs' AND owner = ? AND retired_at IS NULL")
    .get(GIF_LIBRARY_HOLDER);
  if (rows.length === 0 && !rest) return { found: false };
  const value = parsed(rest?.value);
  delete value.$has;
  const entries: Row = {};
  for (const row of rows) entries[String(row.id).slice(PREFIX.length)] = entryOf(row);
  return { found: true, value: { ...value, entries } };
}

/** Puts one entry on its row, in the caller's transaction. */
function putEntry(db: Db, key: string, entry: unknown, { iface, at }: { iface: string | null; at: string }): void {
  const id = `${PREFIX}${key}`;
  const { path, native_ref, extra } = columnsOf(entry);
  const row: { id: string; extra: string | null } = {
    id,
    extra: Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
  };
  keepItemFields(db, [row]);
  const scope = audienceOf(groupScope(iface));
  ensureAudience(db, scope);
  db.prepare(
    `INSERT INTO media (id, kind, path, native_ref, extra, scope_kind, scope_iface, scope_dm, audience_id, writer, holder_id)
     VALUES (?, 'gif', ?, ?, ?, ?, ?, ?, ?, 'gifs', ?)
     ON CONFLICT(id) DO UPDATE SET kind = 'gif', path = excluded.path, native_ref = excluded.native_ref,
       extra = excluded.extra, scope_kind = excluded.scope_kind, scope_iface = excluded.scope_iface,
       scope_dm = excluded.scope_dm, audience_id = excluded.audience_id, writer = 'gifs',
       holder_id = excluded.holder_id, retired_at = NULL`
  ).run(
    id,
    path,
    native_ref,
    row.extra,
    scope.scope_kind,
    scope.scope_iface,
    scope.scope_dm,
    scope.audience_id,
    GIF_LIBRARY_HOLDER
  );
  adoptSameItem(db, id, at);
  projectRow(db, 'media', { id }, { at });
}

/** Retires one entry's row unless a line links it (a row a line shows outlives the entry); whether it retired. */
function dropEntry(db: Db, key: string, at: string): boolean {
  const id = `${PREFIX}${key}`;
  const retired = db
    .prepare(
      `UPDATE media SET retired_at = ? WHERE id = ? AND writer = 'gifs' AND retired_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM media_links l WHERE l.media_id = media.id)`
    )
    .run(at, id).changes;
  if (Number(retired) === 0) return false;
  projectRow(db, 'media', { id }, { at });
  return true;
}

/** Stores one write of the library in the caller's transaction: drops first, then puts, then the rest. */
export function writeGifLibrary(
  db: Db,
  write: GifLibraryWrite,
  { iface, at }: { iface: string | null; at: number }
): { written: number; retired: number } {
  const stamp = new Date(at).toISOString();
  let retired = 0;
  for (const key of write.drop ?? []) if (dropEntry(db, key, stamp)) retired += 1;
  const puts = Object.entries(write.put ?? {});
  for (const [key, entry] of puts) putEntry(db, key, entry, { iface, at: stamp });
  if (write.rest)
    db.prepare(
      `INSERT INTO operational (kind, owner, value, writer, holder_id) VALUES ('gifs', ?, ?, 'gifs', ?)
       ON CONFLICT(kind, owner) DO UPDATE SET value = excluded.value, retired_at = NULL`
    ).run(GIF_LIBRARY_HOLDER, JSON.stringify(write.rest), GIF_LIBRARY_HOLDER);
  return { written: puts.length + (write.rest ? 1 : 0), retired };
}

/** A write as the writer receives it, checked. */
function gifLibraryWriteOf(update: Row): GifLibraryWrite {
  const coded = (code: string): Error => Object.assign(new Error(code), { code });
  const { put, drop, rest } = update;
  if (put !== undefined && !isPlainObject(put)) throw coded('GIF_LIBRARY_PUT');
  if (drop !== undefined && !(Array.isArray(drop) && drop.every(filled))) throw coded('GIF_LIBRARY_DROP');
  if (rest !== undefined && rest !== null && !isPlainObject(rest)) throw coded('GIF_LIBRARY_REST');
  return {
    ...(put ? { put } : {}),
    ...(drop ? { drop } : {}),
    ...(isPlainObject(rest) ? { rest } : {}),
  };
}

/** The write kind `gif-library` on the writer connection (session-write.ts). */
export function applyGifLibraryWrite(handle: MemoryHandle, update: Row): { written: number; retired: number } {
  const write = gifLibraryWriteOf(update);
  const at = isFiniteNumber(update.now) ? update.now : Date.now();
  const iface = namedIface(update);
  return handle.transaction(() => writeGifLibrary(dbOf(handle), write, { iface, at }));
}

/**
 * Version step 53: every row of a library entry (its id starts `media:gif:`) is the library's, held by the persona,
 * the rows a media cache's unit took included; the library's operational row is the persona's; and the GIF units go.
 */
export function ownGifRows(db: Db): void {
  db.prepare(
    `UPDATE media SET writer = 'gifs', holder_id = ?, owner_key = NULL WHERE substr(id, 1, ${PREFIX.length}) = ?`
  ).run(GIF_LIBRARY_HOLDER, PREFIX);
  const units = "SELECT id FROM storage_units WHERE kind = 'gifs'";
  db.prepare(
    `UPDATE operational SET owner = ?, owner_key = NULL, writer = 'gifs', holder_id = ?
     WHERE kind = 'gifs' AND owner_key IN (${units})
       AND NOT EXISTS (SELECT 1 FROM operational o WHERE o.kind = 'gifs' AND o.owner = ?)`
  ).run(GIF_LIBRARY_HOLDER, GIF_LIBRARY_HOLDER, GIF_LIBRARY_HOLDER);
  db.exec(`DELETE FROM operational WHERE kind = 'gifs' AND owner_key IN (${units})`);
  db.exec(`DELETE FROM legacy_unit_aliases WHERE unit_id IN (${units})`);
  db.exec(`DELETE FROM storage_units WHERE kind = 'gifs'`);
}
