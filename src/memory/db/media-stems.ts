// The stems of a `media` row: its text form and the words a person gave it, a file's or a sticker's name, a link's title. Takes
// the stem function, so src/memory/db/stems.ts reads this and the store (media-store.ts) reads both without a cycle.

import { indexWords } from '../record-index.ts';
import { asText } from './types.ts';
import type { Db, Row } from './types.ts';

/** Rows stamped in one transaction. */
const BATCH = 1000;

const hasStems = new WeakMap<Db, boolean>();
/** Whether the database holds the store yet: a migration older than it may stamp source rows. Once true it stays true. */
function storeHeld(db: Db): boolean {
  if (hasStems.get(db)) return true;
  const held = db
    .prepare('PRAGMA table_info(media)')
    .all()
    .some((column) => column.name === 'stems');
  hasStems.set(db, held);
  return held;
}

/** The stems of a row's words under a key function. */
export function mediaStamp(
  stem: (word: string) => string,
  row: { kind: unknown; description: unknown; extra: Row }
): string {
  const named = row.kind === 'file' || row.kind === 'text' || row.kind === 'audio' || row.kind === 'sticker';
  return [
    row.description,
    named ? (row.extra.fileName ?? row.extra.name) : null,
    row.kind === 'link' ? row.extra.title : null,
  ]
    .filter(Boolean)
    .flatMap((text) => indexWords(asText(text)).map(stem))
    .join(' ');
}

function extraOf(text: unknown): Row {
  try {
    const value: unknown = JSON.parse(asText(text ?? '{}'));
    return value !== null && typeof value === 'object' ? (value as Row) : {};
  } catch {
    return {};
  }
}

/** Stamps the rows still without stems. `db` is the writer connection, inside the caller's transaction loop. */
export function fillMediaStems(db: Db, stem: (word: string) => string): number {
  if (!storeHeld(db)) return 0;
  const select = db.prepare(
    `SELECT rowid AS row_id, kind, description, extra FROM media WHERE stems IS NULL LIMIT ${BATCH}`
  );
  const update = db.prepare('UPDATE media SET stems = ? WHERE rowid = ?');
  let stamped = 0;
  for (;;) {
    const rows = select.all();
    if (rows.length === 0) return stamped;
    for (const row of rows)
      update.run(
        mediaStamp(stem, { ...row, kind: row.kind, description: row.description, extra: extraOf(row.extra) }),
        row.row_id
      );
    stamped += rows.length;
  }
}

/** A new stemmer stamps every row again. */
export function clearMediaStems(db: Db): void {
  if (storeHeld(db)) db.exec('UPDATE media SET stems = NULL WHERE stems IS NOT NULL');
}
