// Stems of the memory database's text (spec 2026-10-24-memory-store, section 8): `sources.stems` holds the keys of a
// text's words, space-joined, so the word search (sources_fts, `stems` column) matches the inflected forms of a word.
// The keys come from the record index's learned stemmer (src/memory/record-index.ts: `learnEndings`, `stemmerOf`);
// the endings are learned from the database's own text, never listed in code.
//
// The learned stemmer is kept in `meta` (key `stemmer`: the endings and the productivity of the stems that are seen
// with two or more endings), so the writer that fills the stems and the reader that stems a query use the same one.
// `fillStems` runs from the writers' projection job (unit-write.ts, op `project`): it learns the stemmer when there is
// none or the text grew by a quarter since it was learned (a new stemmer re-stamps every row), then fills the rows whose
// stems are still empty. A row whose text changes gets its stems emptied by the upsert (upsert.ts), so it is filled
// again. A media item's words are stemmed on its own row (media-stems.ts), never on a line that shows it, so `sources.text` and
// `sources.stems` stay what was written.
//
// Pure of the bot; works on an opened database (the writer connection for `fillStems`, any for `loadStemmer`).

import { indexWords, learnEndings, stemmerOf } from '../record-index.ts';
import { clearMediaStems, fillMediaStems } from './media-stems.ts';
import type { Db, Row } from './types.ts';

const META_KEY = 'stemmer';
const PENDING_KEY = 'stems_pending';
/** Relearn the endings when the text of the record kinds grew by this share since they were learned. */
const GROWTH = 0.25;
/** At least this many new text rows before a relearn is considered at all. */
const MIN_GROWTH_ROWS = 200;
/** Rows stamped in one transaction. */
const BATCH = 1000;
/** The row kinds the endings are learned from (the chat the record index sees). */
const LEARN_KINDS = "('seen', 'said')";

const inTransaction = <TResult>(db: Db, fn: () => TResult): TResult => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw error;
  }
};

const metaGet = (db: Db, key: string): string | null =>
  (db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value as string | undefined) ?? null;
const metaSet = (db: Db, key: string, value: unknown): unknown =>
  db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);

/** The stems of `text` under a key function (`stem`): the keys of its words, space-joined. */
export function stemsOf(stem: (word: string) => string, text: unknown): string {
  return indexWords(text).map(stem).join(' ');
}

/** The columns a source row's stems are computed from. */
const STAMP_COLUMNS = 'rowid, text';

/** The stems of a source row: its text. */
const stampOf = (stem: (word: string) => string, row: Row): string => stemsOf(stem, row.text);

type Stemmer = { stem: (word: string) => string; endings: Array<string> };
const parsed = new WeakMap<Db, { raw: string | null; value: Stemmer }>();

/**
 * The stemmer the database was stamped with: `{ stem, endings }`, or the identity stemmer (every word its own key)
 * while none was learned yet. Cached per connection until the stored value changes.
 */
export function loadStemmer(db: Db): Stemmer {
  const raw = metaGet(db, META_KEY);
  const cached = parsed.get(db);
  if (cached && cached.raw === raw) return cached.value;
  let value: Stemmer = { stem: (word) => word, endings: [] };
  if (raw) {
    try {
      const saved = JSON.parse(raw) as { endings?: Array<string>; productivity?: Array<[string, number]> };
      const learned = { endings: saved.endings ?? [], productivity: new Map<string, number>(saved.productivity ?? []) };
      value = { stem: stemmerOf(learned), endings: learned.endings };
    } catch {
      /* an unreadable value: the identity stemmer, the next pass learns again */
    }
  }
  parsed.set(db, { raw, value });
  return value;
}

function textRows(db: Db): number {
  return Number(
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM sources WHERE kind IN ${LEARN_KINDS} AND retired_at IS NULL AND text IS NOT NULL`
      )
      .get()?.n
  );
}

/** Learns the endings from the database's text and stores them; returns whether the stored value changed. */
function learn(db: Db): boolean {
  const words = new Set<string>();
  const select = db.prepare(
    `SELECT text FROM sources WHERE kind IN ${LEARN_KINDS} AND retired_at IS NULL AND text IS NOT NULL`
  );
  for (const row of select.iterate()) for (const word of indexWords(row.text)) words.add(word);
  const { endings, productivity } = learnEndings(words);
  const next = JSON.stringify({ count: textRows(db), endings, productivity: [...productivity] });
  const same = metaGet(db, META_KEY) === next;
  if (!same) metaSet(db, META_KEY, next);
  return !same;
}

/** Whether the stored stemmer is missing or the text outgrew it. */
function stale(db: Db): boolean {
  const raw = metaGet(db, META_KEY);
  if (!raw) return true;
  let count = 0;
  try {
    count = (JSON.parse(raw) as { count?: number }).count ?? 0;
  } catch {
    return true;
  }
  const now = textRows(db);
  return now - count >= MIN_GROWTH_ROWS && now >= count * (1 + GROWTH);
}

/** Whether a fill is due: rows were written since the last one, or none was ever run (a database from before the stems). */
export function stemsPending(db: Db): boolean {
  return metaGet(db, PENDING_KEY) !== '0';
}

/** Marks that rows need stems (sync calls it after it wrote rows). */
export function markStemsPending(db: Db): void {
  if (metaGet(db, PENDING_KEY) !== '1') metaSet(db, PENDING_KEY, '1');
}

/**
 * Fills the empty stems. Learns the stemmer first when there is none or the text grew by a quarter; a stemmer that
 * changed re-stamps every row. Works in transactions of a thousand rows. Returns how many rows got stems.
 * `db` is the writer connection.
 */
export function fillStems(db: Db): { stamped: number; relearned: boolean } {
  let relearned = false;
  if (stale(db)) {
    inTransaction(db, () => {
      relearned = learn(db);
      if (relearned) {
        db.exec('UPDATE sources SET stems = NULL WHERE stems IS NOT NULL');
        clearMediaStems(db);
      }
    });
  }
  const { stem } = loadStemmer(db);
  const select = db.prepare(`SELECT ${STAMP_COLUMNS} FROM sources WHERE stems IS NULL AND text IS NOT NULL LIMIT ?`);
  const update = db.prepare('UPDATE sources SET stems = ? WHERE rowid = ?');
  let stamped = 0;
  for (;;) {
    const rows = select.all(BATCH);
    if (rows.length === 0) break;
    inTransaction(db, () => {
      for (const row of rows) update.run(stampOf(stem, row), row.rowid);
    });
    stamped += rows.length;
  }
  inTransaction(db, () => fillMediaStems(db, stem));
  if (metaGet(db, PENDING_KEY) !== '0') metaSet(db, PENDING_KEY, '0');
  return { stamped, relearned };
}
