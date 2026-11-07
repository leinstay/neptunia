// The shape production had on 2026-11-05, in synthetic rows, for `scripts/memory-repair-audit.ts` and the sweep of one DM.
// The owner's command line holds one DM place, `cli:dm:owner`, whose account is linked to the owner's person since then,
// so the place names that person as its partner. Its rows carry three values of `scope_dm`: none (a line seen before the
// link), the person the legacy importer spelled for the command line, and (for new lines) the owner's person. The memory
// session keeps a cursor under the key of the old spelling. History rows are left behind by the store's expiry.
import type { DatabaseSync } from 'node:sqlite';
import { auditWorld } from './memory-audit-world.ts';

export const OWNER = 'person:discord:9001';
export const OLD_PERSON = 'person:cli:owner';
export const CLI_PLACE = 'cli:dm:owner';
export const CLI_AUDIENCE = 'aud:dm:cli:dm:owner';
export const CURSOR_KEY = 'memory_session.cursor.apply.dm:cli:person:cli:owner';
const WORDS = 'a-synthetic-word-of-the-rows';
const AT = Date.parse('2026-11-04T08:00:00.000Z');

/** The place, its account, its audience and the owner's person. `partner` is what the place names as its partner. */
export function addCliPlace(db: DatabaseSync, partner: string | null = OWNER): void {
  db.exec(`
    INSERT INTO interfaces (id, name, contract) VALUES ('cli', 'command line', 1)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name;
    INSERT OR IGNORE INTO authorities (id, iface, namespace) VALUES ('cli/local', 'cli', 'local');
    INSERT OR IGNORE INTO people (id, first_seen_at) VALUES ('${OWNER}', '2026-11-01T00:00:00.000Z');
    INSERT INTO accounts (id, iface, native_id, native_key, authority_id, generation, kind, person_id, link, linked_by, linked_at)
      VALUES ('cli:owner', 'cli', 'owner', 'owner', 'cli/local', 1, 'user', ${partner ? `'${partner}'` : 'NULL'},
        ${partner ? "'verified'" : 'NULL'}, 'owner', '2026-11-04T07:00:00.000Z');
    INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, conversation, scope_kind, partner_account, partner_person)
      VALUES ('${CLI_PLACE}', 'cli', 'dm', 'owner', 'dm:owner', 'cli/local', 1, 'dm', 'dm', 'cli:owner', ${partner ? `'${partner}'` : 'NULL'});
    INSERT INTO audiences (id, kind, iface, place_id) VALUES ('${CLI_AUDIENCE}', 'dm', 'cli', '${CLI_PLACE}');
  `);
}

/**
 * `count` lines of the DM, oldest first, line `n` carrying `scopeOf(n)` as its `scope_dm`. Returns their `sources.rowid`
 * in arrival order.
 */
export function addCliLines(
  db: DatabaseSync,
  count: number,
  scopeOf: (n: number) => string | null
): Array<number> {
  const insert = db.prepare(
    `INSERT INTO sources (id, kind, iface, native_id, native_kind, generation, revision, authority_id, place_id, author_account,
       author_kind, occurred_at, recorded_at, text, direct, scope_kind, scope_iface, scope_dm, audience_id)
     VALUES (?, 'seen', 'cli', ?, 'message', 1, 1, 'cli/local', ?, 'cli:owner', 'account', ?, ?, ?, 1, 'dm', 'cli', ?, ?)`
  );
  const rowids: Array<number> = [];
  for (let n = 1; n <= count; n += 1) {
    const at = new Date(AT + n * 60_000).toISOString();
    const done = insert.run(`src:cli:${n}`, `cli-line-${n}`, CLI_PLACE, at, at, WORDS, scopeOf(n), CLI_AUDIENCE);
    rowids.push(Number(done.lastInsertRowid));
  }
  return rowids;
}

/** Ten vectors and thirty-seven day rows of the DM, all under the old spelling, and the cursor of the memory session. */
export function addCliDerived(db: DatabaseSync, rowids: ReadonlyArray<number>, cursor: number): void {
  const vector = db.prepare(
    `INSERT INTO vectors (source_rowid, item_id, chunk_key, model, dims, context, occurred_at, scope_kind, scope_iface, scope_dm, audience_id)
     VALUES (?, ?, ?, 'test/embedder', 4, '{}', ?, 'dm', 'cli', ?, ?)`
  );
  for (const [i, rowid] of rowids.slice(0, 10).entries())
    vector.run(rowid, `src:cli:${i + 1}`, `chunk:cli:${i + 1}`, new Date(AT + i * 60_000).toISOString(), OLD_PERSON, CLI_AUDIENCE);
  const day = db.prepare(
    `INSERT INTO day (id, at, what, place_id, scope_kind, scope_iface, scope_dm, audience_id)
     VALUES (?, ?, 'turn', ?, 'dm', 'cli', ?, ?)`
  );
  for (let n = 1; n <= 37; n += 1)
    day.run(`day:cli:${n}`, new Date(AT + n * 1000).toISOString(), CLI_PLACE, OLD_PERSON, CLI_AUDIENCE);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(CURSOR_KEY, String(cursor));
}

/**
 * What the store's expiry left: three versions of claims it deleted (event `expired`, by `store`) and two legacy versions of
 * descriptions that no longer exist. Nothing is lost by retiring them, their owners are gone.
 */
export function addExpiredHistory(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO claim_versions (id, claim_id, text, recorded_at, event, by, origin)
      VALUES ('cv:expired:1', 'claim:expired-1', '${WORDS}', '2026-10-24T13:03:35.918Z', 'expired', 'store', 'live'),
             ('cv:expired:2', 'claim:expired-2', '${WORDS}', '2026-10-30T09:00:00.000Z', 'expired', 'store', 'live'),
             ('cv:expired:3', 'claim:expired-2', '${WORDS}', '2026-11-04T21:40:27.624Z', 'expired', 'store', 'live');
    INSERT INTO description_versions (id, description_id, text, author, written_at, origin)
      VALUES ('dv:legacy:1', 'desc:expired-1', '${WORDS}', 'analyzer', '2026-10-09T08:27:07.532Z', 'legacy'),
             ('dv:legacy:2', 'desc:expired-1', '${WORDS}', 'analyzer', '2026-10-15T01:53:20.766Z', 'legacy');
  `);
}

/** Version rows that are no history: the owner is gone and nothing says the store expired it. They stay findings. */
export function addGenuineDangling(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO claim_versions (id, claim_id, text, recorded_at, event, by, origin)
      VALUES ('cv:real', 'claim:never-existed', '${WORDS}', '2026-11-04T10:00:00.000Z', 'add', 'her', 'live');
    INSERT INTO description_versions (id, description_id, text, author, written_at, origin)
      VALUES ('dv:real', 'desc:never-existed', '${WORDS}', 'her', '2026-11-04T10:00:00.000Z', 'live');
  `);
}

export const CURSOR_AT = 8;
export const LINES = 15;
/** Lines 3, 6, 9, 12 and 15 carry no `scope_dm` (5 of them), the others the old spelling (10). */
export const lineScope = (n: number): string | null => (n % 3 === 0 ? null : OLD_PERSON);

/** A closed database shaped like production: the CLI DM above, its cursor after the eighth line, and the expiry history. */
export function productionWorld(extra?: (db: DatabaseSync) => void): Promise<string> {
  return auditWorld((db) => {
    addCliPlace(db);
    const rowids = addCliLines(db, LINES, lineScope);
    addCliDerived(db, rowids, Number(rowids[CURSOR_AT - 1]));
    addExpiredHistory(db);
    extra?.(db);
  });
}
