// The stable names of custom emoji and stickers (`media_names`): one row per thing an interface showed, its name `e23`
// for an emoji and `s12` for a sticker bound to the interface and the platform id at first sight. The store
// (src/memory/store-media-names.ts) issues a name and sends the row to the writer kind `media-names`
// (session-write.ts). A row seen again under another platform name keeps its name and records the new platform name
// and `renamed_at`. Rows are never deleted, so a number is never issued twice. `mediaNameRows` reads every row back.

import { dbOf, isFiniteNumber } from './types.ts';
import type { Db, MemoryHandle, Row } from './types.ts';

/** One named thing as the store and the writer pass it. */
export type MediaNameRow = {
  name: string;
  kind: 'emoji' | 'sticker';
  iface: string;
  nativeId: string;
  platformName: string;
  animated: boolean;
};

/** One write: the rows a store issued or saw renamed or changed. */
export type MediaNamesWrite = { rows: ReadonlyArray<MediaNameRow> };

const isKind = (value: unknown): value is 'emoji' | 'sticker' => value === 'emoji' || value === 'sticker';
const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** Every stored row, in the order they were issued. */
export function mediaNameRows(db: Db): Array<MediaNameRow> {
  const rows = db
    .prepare('SELECT name, kind, iface, native_id, platform_name, animated FROM media_names ORDER BY rowid')
    .all();
  return rows.flatMap((row): Array<MediaNameRow> => {
    const { name, kind, iface, native_id: nativeId, platform_name: platformName } = row;
    if (!filled(name) || !isKind(kind) || !filled(iface) || !filled(nativeId) || typeof platformName !== 'string')
      return [];
    return [{ name, kind, iface, nativeId, platformName, animated: Number(row.animated) === 1 }];
  });
}

/** Stores the rows of one write in the caller's transaction: a new row is inserted, a known one updated in place. */
export function writeMediaNames(db: Db, write: MediaNamesWrite, at: number): { written: number } {
  const stamp = new Date(at).toISOString();
  const upsert = db.prepare(
    `INSERT INTO media_names (name, kind, iface, native_id, platform_name, animated, first_seen_at, renamed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(iface, kind, native_id) DO UPDATE SET
       renamed_at = CASE WHEN platform_name = excluded.platform_name THEN renamed_at ELSE excluded.first_seen_at END,
       platform_name = excluded.platform_name,
       animated = excluded.animated`
  );
  for (const row of write.rows)
    upsert.run(row.name, row.kind, row.iface, row.nativeId, row.platformName, row.animated ? 1 : 0, stamp);
  return { written: write.rows.length };
}

/** A write as the writer receives it, checked. */
function mediaNamesWriteOf(update: Row): MediaNamesWrite {
  const refused = Object.assign(new Error('MEDIA_NAMES_ROWS'), { code: 'MEDIA_NAMES_ROWS' });
  const { rows } = update;
  if (!Array.isArray(rows)) throw refused;
  const checked = rows.map((row: unknown): MediaNameRow => {
    if (row === null || typeof row !== 'object') throw refused;
    const { name, kind, iface, nativeId, platformName, animated } = row as Record<string, unknown>;
    if (!filled(name) || !isKind(kind) || !filled(iface) || !filled(nativeId) || typeof platformName !== 'string')
      throw refused;
    return { name, kind, iface, nativeId, platformName, animated: animated === true };
  });
  return { rows: checked };
}

/** The write kind `media-names` on the writer connection (session-write.ts). */
export function applyMediaNamesWrite(handle: MemoryHandle, update: Row): { written: number } {
  const write = mediaNamesWriteOf(update);
  const at = isFiniteNumber(update.now) ? update.now : Date.now();
  return handle.transaction(() => writeMediaNames(dbOf(handle), write, at));
}
