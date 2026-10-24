// The handoff from the analyzer to her memory session at the writer switch (spec 2026-10-24-memory-authority, section 6
// item 7; stage W3). Under authority `db` her session writes the memory and reads each scope after its own cursor
// (session.js, `memory_session.cursor.apply.<scope>`). The analyzer read the same lines before: what it had consumed must
// not be read again, what it had not (its buffer) must not be skipped. So at the first start under `db` (the service,
// before any observation is written), one transaction sets every scope's apply cursor to the analyzer's boundary:
//
//   handoff(handle, { now }) -> { already, scopes, set, kept, buffered, behind, adopted }
//     - the buffers the store held at shutdown are the guild's `buffer` operational row (stage W2b: `buffer.json`,
//       verbatim) and the `buffer` of every private layer (its `private` operational row, `private/<u>.json`); their
//       lines' message ids are the lines the analyzer had NOT consumed;
//     - for every scope with chat lines (`group:<iface>`, `dm:<iface>:<partner>`, as session.js#scopesOf names them) the
//       cursor is the highest `rowid` of the scope's `seen` / `said` rows whose native id is not one of those: every line
//       the analyzer consumed is at or behind it. A scope whose every line is buffered gets no cursor (it starts at its
//       first line). A cursor already there is kept as it is (`kept`);
//     - `behind`: the buffered lines that sit behind their scope's cursor all the same (a line that arrived before a
//       consumed one, by rowid): the session would not read them. Counted and logged, never hidden;
//     - `adopted`: a buffered line the live observation wrote while the files were the writer has no record unit yet
//       (the analyzer would have appended it to the record when its batch took it). Each such `seen` / `said` row is
//       written into the record unit of its buffer's layer (`guilds/<g>/record/<YYYY-MM>/<day>.jsonl`, a private
//       layer's alike, the UTC day of the line), at the unit's next position, so the record readers, the meaning index
//       and the export find it as they find every other line of the day;
//     - the marker `memory_session.handoff` in `meta` (the summary, as JSON) makes it run once: a second call changes
//       nothing and returns `already: true` with the first summary.
//   `buffer.json` itself is never touched.
//
// Runs on the writer connection (session-write.js, `{ kind: 'handoff' }`, authority `db` only). Imports nothing heavy:
// the worker loads it. Counts only, never a text or an id in what it returns.

import { wellFormed } from './scope.js';
import { nextPosition, noteUnit } from './unit-write.js';

/** The marker of a done handoff in `meta`. */
export const HANDOFF_KEY = 'memory_session.handoff';
/** The session's apply cursor of a scope (session.js#cursorKey with mode `apply`). */
export const applyCursorKey = (scopeKey) => `memory_session.cursor.apply.${scopeKey}`;

const SET_META = 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';

/** The record layer of a buffer's owner (`guilds/<g>` or `guilds/<g>/private/<u>`), or null for another path. */
const layerOfBuffer = (owner) => /^(guilds\/[^/]+(?:\/private\/[^/]+)?)\/buffer\.json$/.exec(String(owner ?? ''))?.[1] ?? null;
/** The record layer of a private layer's unit (`guilds/<g>/private/<u>.json` -> `guilds/<g>/private/<u>`), or null. */
const layerOfPrivate = (file) => /^(guilds\/[^/]+\/private\/[^/]+)\.json$/.exec(String(file ?? ''))?.[1] ?? null;

const parse = (text) => {
  try { return JSON.parse(text); } catch { return null; }
};

/**
 * The message ids the analyzer's buffers hold, by the record layer they belong to: the guild's buffer (`buffer`
 * operational rows, `guilds/<g>/buffer.json`) and each member's private buffer (the `buffer` of a private layer, kept
 * in its `private` operational row, `guilds/<g>/private/<u>.json`). Layer `guilds/<g>` or `guilds/<g>/private/<u>`.
 */
function buffersOf(db) {
  const out = new Map();
  let rows = [];
  try {
    rows = db.prepare("SELECT kind, owner, owner_file, value FROM operational WHERE kind IN ('buffer', 'private') AND retired_at IS NULL ORDER BY rowid").all();
  } catch {
    return out;
  }
  for (const row of rows) {
    const value = parse(row.value);
    const layer = row.kind === 'buffer' ? layerOfBuffer(row.owner) : layerOfPrivate(row.owner_file);
    const list = row.kind === 'private' ? (Array.isArray(value?.buffer) ? value.buffer : [])
      : Array.isArray(value) ? value : Array.isArray(value?.messages) ? value.messages : [];
    const ids = out.get(layer) ?? new Set();
    for (const message of list) {
      if (!message || typeof message !== 'object' || message.inner) continue;
      if (message.id === null || message.id === undefined || message.id === '') continue;
      ids.add(String(message.id));
    }
    if (ids.size > 0) out.set(layer, ids);
  }
  return out;
}

/** The message ids in the analyzer's buffers (the guild's and every private layer's), as strings; her inner lines are no messages. */
export function bufferedIds(db) {
  const ids = new Set();
  for (const list of buffersOf(db).values()) for (const id of list) ids.add(id);
  return ids;
}

/**
 * Writes every buffered line that has no record unit into the record unit of its buffer's layer (see the head of this
 * file), in row order. Returns how many lines were adopted.
 */
function adoptBuffered(db, at) {
  let adopted = 0;
  // A guild buffer holds the group's lines, a private one its DM's.
  const lines = db.prepare(`SELECT rowid, id, occurred_at FROM sources WHERE native_id IN (SELECT value FROM json_each(?))
    AND kind IN ('seen', 'said') AND scope_kind = ? AND owner_file IS NULL AND retired_at IS NULL ORDER BY rowid`);
  const stamp = db.prepare('UPDATE sources SET owner_file = ?, position = ? WHERE id = ? AND owner_file IS NULL');
  for (const [layer, ids] of buffersOf(db)) {
    if (!layer) continue;
    for (const row of lines.all(JSON.stringify([...ids]), layer.includes('/private/') ? 'dm' : 'group')) {
      const day = /^\d{4}-\d{2}-\d{2}/.exec(String(row.occurred_at ?? ''))?.[0];
      if (!day) continue;
      const unit = `${layer}/record/${day.slice(0, 7)}/${day}.jsonl`;
      const position = nextPosition(db, unit);
      if (stamp.run(unit, position, row.id).changes === 0) continue;
      noteUnit(db, unit, 'record', { lines: position + 1, at });
      adopted += 1;
    }
  }
  return adopted;
}

/** The scopes with chat lines, keyed as session.js#scopesOf keys them. */
function scopes(db) {
  return db.prepare(
    `SELECT DISTINCT scope_kind, scope_iface, scope_dm FROM sources
      WHERE kind IN ('seen', 'said') AND retired_at IS NULL AND scope_kind IN ('group', 'dm') AND scope_iface IS NOT NULL
      ORDER BY scope_kind, scope_iface, scope_dm`,
  ).all().filter((row) => wellFormed(row)).map((row) => ({
    key: row.scope_kind === 'group' ? `group:${row.scope_iface}` : `dm:${row.scope_iface}:${row.scope_dm}`,
    row,
  }));
}

/**
 * The handoff (see the head of this file), in one transaction on `handle`.
 * @param {{ db: object, transaction: (fn: () => any) => any }} handle
 * @param {{ now?: number }} [options]
 */
export function handoff(handle, { now = Date.now() } = {}) {
  return handle.transaction(() => {
    const { db } = handle;
    const done = db.prepare('SELECT value FROM meta WHERE key = ?').get(HANDOFF_KEY)?.value;
    if (done !== undefined && done !== null) return { ...(parse(done) ?? {}), already: true };
    const buffered = bufferedIds(db);
    const list = JSON.stringify([...buffered]);
    const at = new Date(now).toISOString();
    const summary = { at, scopes: 0, set: 0, kept: 0, buffered: buffered.size, behind: 0, adopted: adoptBuffered(db, at) };
    const where = (row) => (row.scope_kind === 'dm'
      ? { sql: 'scope_kind = ? AND scope_iface = ? AND scope_dm = ?', params: [row.scope_kind, row.scope_iface, row.scope_dm] }
      : { sql: 'scope_kind = ? AND scope_iface = ?', params: [row.scope_kind, row.scope_iface] });
    for (const scope of scopes(db)) {
      summary.scopes += 1;
      const key = applyCursorKey(scope.key);
      const { sql, params } = where(scope.row);
      const existing = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
      let cursor;
      if (existing !== undefined && existing !== null) {
        summary.kept += 1;
        cursor = Number(existing) || 0;
      } else {
        const found = db.prepare(
          `SELECT MAX(rowid) AS cursor FROM sources WHERE kind IN ('seen', 'said') AND ${sql}
             AND (native_id IS NULL OR native_id NOT IN (SELECT value FROM json_each(?)))`,
        ).get(...params, list)?.cursor;
        cursor = Number.isInteger(found) ? found : 0;
        if (cursor > 0) {
          db.prepare(SET_META).run(key, String(cursor));
          summary.set += 1;
        }
      }
      if (cursor > 0 && buffered.size > 0) {
        summary.behind += db.prepare(
          `SELECT COUNT(DISTINCT native_id) AS n FROM sources WHERE kind IN ('seen', 'said') AND retired_at IS NULL AND ${sql}
             AND rowid <= ? AND native_id IN (SELECT value FROM json_each(?))`,
        ).get(...params, cursor, list).n;
      }
    }
    db.prepare(SET_META).run(HANDOFF_KEY, JSON.stringify(summary));
    return { ...summary, already: false };
  });
}
