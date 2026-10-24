// Stems of the memory database's text (spec 2026-10-24-memory-store, section 8): `sources.stems` holds the keys of a
// text's words, space-joined, so the word search (sources_fts, `stems` column) matches the inflected forms of a word.
// The keys come from the record index's learned stemmer (src/memory/record-index.js: `learnEndings`, `stemmerOf`);
// the endings are learned from the database's own text, never listed in code.
//
// The learned stemmer is kept in `meta` (key `stemmer`: the endings and the productivity of the stems that are seen
// with two or more endings), so the writer that fills the stems and the reader that stems a query use the same one.
// `fillStems` runs at the end of a sync pass: it learns the stemmer when there is none or the text grew by a quarter
// since it was learned (a new stemmer re-stamps every row), then fills the rows whose stems are still empty. A row
// whose text changes gets its stems emptied by the sync's upsert (sync.js), so it is filled again.
//
// Pure of the bot; works on an opened database (the writer connection for `fillStems`, any for `loadStemmer`).

import { indexWords, learnEndings, stemmerOf } from '../record-index.js';

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

const inTransaction = (db, fn) => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw error;
  }
};

const metaGet = (db, key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
const metaSet = (db, key, value) => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

/** The stems of `text` under a key function (`stem`): the keys of its words, space-joined. */
export function stemsOf(stem, text) {
  return indexWords(text).map(stem).join(' ');
}

const parsed = new WeakMap();

/**
 * The stemmer the database was stamped with: `{ stem, endings }`, or the identity stemmer (every word its own key)
 * while none was learned yet. Cached per connection until the stored value changes.
 * @param {object} db  a node:sqlite database
 * @returns {{ stem: (word: string) => string, endings: string[] }}
 */
export function loadStemmer(db) {
  const raw = metaGet(db, META_KEY);
  const cached = parsed.get(db);
  if (cached && cached.raw === raw) return cached.value;
  let value = { stem: (word) => word, endings: [] };
  if (raw) {
    try {
      const saved = JSON.parse(raw);
      const learned = { endings: saved.endings ?? [], productivity: new Map(saved.productivity ?? []) };
      value = { stem: stemmerOf(learned), endings: learned.endings };
    } catch { /* an unreadable value: the identity stemmer, the next pass learns again */ }
  }
  parsed.set(db, { raw, value });
  return value;
}

function textRows(db) {
  return db.prepare(`SELECT COUNT(*) AS n FROM sources WHERE kind IN ${LEARN_KINDS} AND retired_at IS NULL AND text IS NOT NULL`).get().n;
}

/** Learns the endings from the database's text and stores them; returns whether the stored value changed. */
function learn(db) {
  const words = new Set();
  const select = db.prepare(`SELECT text FROM sources WHERE kind IN ${LEARN_KINDS} AND retired_at IS NULL AND text IS NOT NULL`);
  for (const row of select.iterate()) for (const word of indexWords(row.text)) words.add(word);
  const { endings, productivity } = learnEndings(words);
  const next = JSON.stringify({ count: textRows(db), endings, productivity: [...productivity] });
  const same = metaGet(db, META_KEY) === next;
  if (!same) metaSet(db, META_KEY, next);
  return !same;
}

/** Whether the stored stemmer is missing or the text outgrew it. */
function stale(db) {
  const raw = metaGet(db, META_KEY);
  if (!raw) return true;
  let count = 0;
  try { count = JSON.parse(raw).count ?? 0; } catch { return true; }
  const now = textRows(db);
  return now - count >= MIN_GROWTH_ROWS && now >= count * (1 + GROWTH);
}

/** Whether a fill is due: rows were written since the last one, or none was ever run (a database from before the stems). */
export function stemsPending(db) {
  return metaGet(db, PENDING_KEY) !== '0';
}

/** Marks that rows need stems (sync calls it after it wrote rows). */
export function markStemsPending(db) {
  if (metaGet(db, PENDING_KEY) !== '1') metaSet(db, PENDING_KEY, '1');
}

/**
 * Fills the empty stems. Learns the stemmer first when there is none or the text grew by a quarter; a stemmer that
 * changed re-stamps every row. Works in transactions of a thousand rows. Returns how many rows got stems.
 * @param {object} db  the writer connection
 * @returns {{ stamped: number, relearned: boolean }}
 */
export function fillStems(db) {
  let relearned = false;
  if (stale(db)) {
    inTransaction(db, () => {
      relearned = learn(db);
      if (relearned) db.exec('UPDATE sources SET stems = NULL WHERE stems IS NOT NULL');
    });
  }
  const { stem } = loadStemmer(db);
  const select = db.prepare('SELECT rowid, text FROM sources WHERE stems IS NULL AND text IS NOT NULL LIMIT ?');
  const update = db.prepare('UPDATE sources SET stems = ? WHERE rowid = ?');
  let stamped = 0;
  for (;;) {
    const rows = select.all(BATCH);
    if (rows.length === 0) break;
    inTransaction(db, () => {
      for (const row of rows) update.run(stemsOf(stem, row.text), row.rowid);
    });
    stamped += rows.length;
  }
  if (metaGet(db, PENDING_KEY) !== '0') metaSet(db, PENDING_KEY, '0');
  return { stamped, relearned };
}
