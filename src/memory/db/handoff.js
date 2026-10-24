// The handoff from the analyzer to her memory session at the writer switch (spec 2026-10-24-memory-authority, section 6
// item 7; stage W3). Under authority `db` her session writes the memory and reads each scope after its own cursor
// (session.js, `memory_session.cursor.apply.<scope>`). The analyzer read the same lines before: what it had consumed must
// not be read again, what it had not (its buffer) must not be skipped. So at the first start under `db` (the service,
// before any observation is written), one transaction sets every scope's apply cursor to the analyzer's boundary:
//
//   handoff(handle, { now }) -> { already, scopes, set, kept, buffered, behind }
//     - the buffer the store held at shutdown is the `buffer` operational rows (stage W2b: `buffer.json` of the guild and
//       of every private layer, verbatim); their lines' message ids are the lines the analyzer had NOT consumed;
//     - for every scope with chat lines (`group:<iface>`, `dm:<iface>:<partner>`, as session.js#scopesOf names them) the
//       cursor is the highest `rowid` of the scope's `seen` / `said` rows whose native id is not one of those: every line
//       the analyzer consumed is at or behind it. A scope whose every line is buffered gets no cursor (it starts at its
//       first line). A cursor already there is kept as it is (`kept`);
//     - `behind`: the buffered lines that sit behind their scope's cursor all the same (a line that arrived before a
//       consumed one, by rowid): the session would not read them. Counted and logged, never hidden;
//     - the marker `memory_session.handoff` in `meta` (the summary, as JSON) makes it run once: a second call changes
//       nothing and returns `already: true` with the first summary.
//   `buffer.json` itself is never touched (it stays on disk read-only for the fallback week).
//
// Runs on the writer connection (session-write.js, `{ kind: 'handoff' }`, authority `db` only). Imports nothing heavy:
// the worker loads it. Counts only, never a text or an id in what it returns.

import { wellFormed } from './scope.js';

/** The marker of a done handoff in `meta`. */
export const HANDOFF_KEY = 'memory_session.handoff';
/** The session's apply cursor of a scope (session.js#cursorKey with mode `apply`). */
export const applyCursorKey = (scopeKey) => `memory_session.cursor.apply.${scopeKey}`;

const SET_META = 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';

const parse = (text) => {
  try { return JSON.parse(text); } catch { return null; }
};

/** The message ids in the analyzer's buffers (every `buffer` operational row), as strings; her inner lines are no messages. */
export function bufferedIds(db) {
  const ids = new Set();
  let rows = [];
  try {
    rows = db.prepare("SELECT value FROM operational WHERE kind = 'buffer' AND retired_at IS NULL").all();
  } catch {
    return ids;
  }
  for (const row of rows) {
    const value = parse(row.value);
    const list = Array.isArray(value) ? value : Array.isArray(value?.messages) ? value.messages : [];
    for (const message of list) {
      if (!message || typeof message !== 'object' || message.inner) continue;
      if (message.id === null || message.id === undefined || message.id === '') continue;
      ids.add(String(message.id));
    }
  }
  return ids;
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
    const summary = { at: new Date(now).toISOString(), scopes: 0, set: 0, kept: 0, buffered: buffered.size, behind: 0 };
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
