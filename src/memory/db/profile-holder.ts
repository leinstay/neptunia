// Whose a profile row is: the tables an account's profile, a private layer and a history of prose write keep each row's
// holder in the row itself, in `writer` and `holder_id`. An account's profile is `profile` and a private layer
// `private`, both held by the account. A history of prose is `versions`, held by `<subject>/<versionKind>/<itemId>`,
// which names one history among the subject's. A row the persona's memory session writes, or takes over from a
// profile, is `session` with no holder. The profile writers (account-profile.ts, private-layer.ts, prose-versions.ts)
// stamp these columns beside the row's unit, and their readers, the retirement of what a value no longer holds and the
// rows of the persona's session (session-rows.ts) run on them.

import { projectRow } from './graph.ts';
import type { UnitKey } from './unit-keys.ts';
import type { Db, Row, Rows } from './types.ts';

/** The writers whose rows own themselves through these columns. */
export type ProfileWriter = 'profile' | 'private' | 'versions';

/** The holder columns of a profile row. */
export type ProfileHolder = { writer: ProfileWriter; holder_id: string };

/** The tables a profile writer writes. */
export const PROFILE_TABLES = [
  'people',
  'accounts',
  'memberships',
  'claims',
  'descriptions',
  'description_versions',
  'episodes',
  'affinity_events',
  'operational',
] as const;

/** The primary key of each profile table. */
const KEYS: Record<string, ReadonlyArray<string>> = { operational: ['kind', 'owner'] };
const keyOf = (table: string): ReadonlyArray<string> => KEYS[table] ?? ['id'];

/** The tables whose rows a profile read gives in their `position` order. */
const POSITIONED = new Set(['claims', 'description_versions', 'episodes', 'affinity_events']);

/** The holder columns of the unit `key` of an account's profile, a private layer or a history, else null. */
export function profileHolderOf(key: UnitKey): ProfileHolder | null {
  if (key.kind === 'user') return { writer: 'profile', holder_id: key.subject.id };
  if (key.kind === 'private') return { writer: 'private', holder_id: key.subject.id };
  if (key.kind !== 'versions') return null;
  const selector = key.selector ?? {};
  return { writer: 'versions', holder_id: `${key.subject.id}/${selector.versionKind ?? ''}/${selector.itemId ?? ''}` };
}

/** The key of the `user` unit a profile holder names: its account. */
export const profileKeyOf = (holder: string): UnitKey => ({ kind: 'user', subject: { type: 'account', id: holder } });

/** The place a history of prose holds (`<place>/<kind>/<item>` of a place's kind), null for an account's. */
export function placeOfVersions(holder: string): string | null {
  const found = /^(.+?)\/(channels|place|lore|media)\//.exec(holder);
  return found ? found[1] : null;
}

/** `rows` with the given holder columns on every row. */
export function stampProfileRows(rows: Rows, holder: ProfileHolder): Rows {
  for (const list of Object.values(rows))
    for (const row of list) Object.assign(row, { writer: holder.writer, holder_id: holder.holder_id });
  return rows;
}

/** The live rows of the given holder in each of `tables`, in the order a profile read gives them. */
export function heldRows(db: Db, holder: ProfileHolder, tables: ReadonlyArray<string>): Rows {
  const rows: Rows = {};
  for (const table of tables)
    rows[table] = db
      .prepare(
        `SELECT * FROM "${table}" WHERE writer = ? AND holder_id = ? AND retired_at IS NULL
         ORDER BY ${POSITIONED.has(table) ? 'position, rowid' : 'rowid'}`
      )
      .all(holder.writer, holder.holder_id)
      .map((row) => ({ ...row }));
  return rows;
}

/** Whether the given holder holds any live row in `table`: whether its value is stored at all. */
export function holdsAny(db: Db, holder: ProfileHolder, table: string): boolean {
  return (
    db
      .prepare(`SELECT 1 AS ok FROM "${table}" WHERE writer = ? AND holder_id = ? AND retired_at IS NULL LIMIT 1`)
      .get(holder.writer, holder.holder_id) !== undefined
  );
}

/**
 * Retires the live rows of the given holder that `mapping` (a whole value's rows) no longer holds. Returns how many.
 */
export function retireProfileAbsent(db: Db, holder: ProfileHolder, mapping: Rows, at: string): number {
  let count = 0;
  for (const table of PROFILE_TABLES) {
    const key = keyOf(table);
    const keep = new Set((mapping[table] ?? []).map((row) => key.map((col) => row[col]).join('\u0000')));
    const update = db.prepare(
      `UPDATE "${table}" SET retired_at = ? WHERE ${key.map((col) => `"${col}" = ?`).join(' AND ')}`
    );
    for (const row of db
      .prepare(
        `SELECT ${key.map((col) => `"${col}"`).join(', ')} FROM "${table}" WHERE writer = ? AND holder_id = ? AND retired_at IS NULL`
      )
      .all(holder.writer, holder.holder_id)) {
      if (keep.has(key.map((col) => row[col]).join('\u0000'))) continue;
      update.run(at, ...key.map((col) => row[col]));
      projectRow(db, table, row, { at });
      count += 1;
    }
  }
  return count;
}

/** The columns a row the persona's memory session writes or takes over carries. */
export const SESSION_COLUMNS: Row = { writer: 'session', holder_id: null };
