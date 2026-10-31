// The rows her memory session wrote (session-write.js) beside the rows of the store's files (the unit sync,
// upsert.js), in the two places the two writers meet: the read of a member's unit and the unit write of it.
//
// addSessionRows (called by export.js#unitRows): a member's profile (`users/<id>.json`) and private layer
// (`private/<id>.json`) also hold what her session wrote about that person in the unit's scope (the group of the
// person's interface, or the DM with the person): the live claims she shows (`shown`, truth current or disputed), the
// episodes and the attitude moves that have no `owner_file`, and the version a description's `current_version` names.
// They follow the unit's own rows: the claims and the episodes in the order they were made, the moves merged into the
// file's history by time.
//
// sessionHold (called by upsert.js#writeMapping): what a unit write leaves as her session wrote it in a row the file
// still owns. Her last move of a person's attitude is her newest `affinity_events` row about the person, and a profile
// read from the database names it (`affinity.moveId`, in the remainder of the person row, `extra`). A file that
// names an older move was read before her later ones: its write keeps her reason, and its score is the file's score (a
// decay tick in the cache counts) plus her later moves, clamped to -100..100. A file that names none was read before
// any of her moves, or before the profile named them: its write leaves her score, reason and decay stamp as they are.
// A description keeps its current version when that version is not the file's own (origin `legacy`) and the file
// brings either the text of that version or the text the file already had: the file was not edited since. A row her
// session took over (no `owner_file`) is never written by a unit at all (upsert.js#writeRow).
//
// takeOverClaim (called by session-write.js#applyClaim): a confirm, revise or retire of a claim makes the claim her
// session's (`owner_file` null, its `co_owners` rows gone), in the transaction of the op.

type Row = Record<string, unknown>;
type Statement = { all(...params: Array<unknown>): Array<Row>; get(...params: Array<unknown>): Row | undefined };
type Db = { prepare(sql: string): Statement & { run(...params: Array<unknown>): unknown } };
/** The rows of one unit or one mapping: table -> rows. */
type Rows = Record<string, Array<Row> | undefined>;

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const isObject = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A row's remainder (`extra`, JSON text) as an object; {} when it holds none or no object. */
function remainderOf(extra: unknown): Row {
  if (typeof extra !== 'string' || extra === '') return {};
  try {
    const value: unknown = JSON.parse(extra);
    return isObject(value) ? value : {};
  } catch {
    // a remainder that is not JSON holds no move
    return {};
  }
}

/** The person and the scope (an SQL condition and its values) of a member's unit, or null for any other unit. */
function personScopeOf(kind: unknown, rows: Rows): { person: string; sql: string; args: Array<string> } | null {
  const person =
    kind === 'user'
      ? text(rows.people?.[0]?.id)
      : kind === 'private'
        ? text(rows.operational?.find((row) => row.kind === 'private')?.owner)
        : null;
  const iface = /^person:([^:]+):./.exec(person ?? '')?.[1];
  if (!person || !iface) return null;
  return kind === 'user'
    ? { person, sql: "scope_kind = 'group' AND scope_iface = ? AND scope_dm IS NULL", args: [iface] }
    : { person, sql: "scope_kind = 'dm' AND scope_iface = ? AND scope_dm = ?", args: [iface, person] };
}

const SESSION_SQL = {
  claims:
    "SELECT * FROM claims WHERE subject_kind = 'person' AND subject_id = ? AND shown = 1 AND truth IN ('current', 'disputed') AND",
  episodes: 'SELECT * FROM episodes WHERE subject_id = ? AND',
  affinity_events: 'SELECT * FROM affinity_events WHERE person_id = ? AND',
} as const;
/** Her newest move of the person's attitude (the event id), or null. */
const LAST_MOVE_SQL =
  'SELECT id FROM affinity_events WHERE person_id = ? AND owner_file IS NULL AND retired_at IS NULL ORDER BY rowid DESC LIMIT 1';

const SESSION_ORDER = {
  claims: "COALESCE(created_at, first_seen_at, ''), rowid",
  episodes: "COALESCE(created_at, ''), rowid",
  affinity_events: "COALESCE(at, ''), rowid",
} as const;

/** `file` (in position order) with `session` (in time order) put in by time; a file row without a time keeps its place. */
function mergedByTime(file: ReadonlyArray<Row>, session: ReadonlyArray<Row>): Array<Row> {
  const out: Array<Row> = [];
  let next = 0;
  for (const row of file) {
    const at = text(row.at);
    while (at !== null && next < session.length && (text(session[next]?.at) ?? '') < at) {
      const move = session[next];
      if (move) out.push(move);
      next += 1;
    }
    out.push(row);
  }
  return [...out, ...session.slice(next)];
}

/**
 * Adds to `rows` (a unit's rows, export.js#unitRows) what her session wrote about the person of a member's unit of
 * mapper kind `kind` (see the head of this file). Any other unit is left as it is.
 */
export function addSessionRows(connection: unknown, kind: unknown, rows: Rows): void {
  const db = connection as Db; // a node:sqlite connection of the memory database; the queries below read it
  const scope = personScopeOf(kind, rows);
  if (!scope) return;
  const person = rows.people?.[0];
  const last = person ? text(db.prepare(LAST_MOVE_SQL).get(scope.person)?.id) : null;
  if (person && last !== null) {
    const rest = remainderOf(person.extra);
    const affinity = isObject(rest.affinity) ? rest.affinity : {};
    const extra = JSON.stringify({ ...rest, affinity: { ...affinity, moveId: last } });
    rows.people = [{ ...person, extra }, ...(rows.people ?? []).slice(1)];
  }
  for (const table of ['claims', 'episodes', 'affinity_events'] as const) {
    const own = rows[table] ?? [];
    const held = new Set(own.map((row) => row.id));
    const found = db
      .prepare(
        `${SESSION_SQL[table]} owner_file IS NULL AND retired_at IS NULL AND ${scope.sql} ORDER BY ${SESSION_ORDER[table]}`
      )
      .all(scope.person, ...scope.args)
      .filter((row) => !held.has(row.id))
      .map((row) => ({ ...row }));
    if (found.length === 0) continue;
    const merged = table === 'affinity_events' ? mergedByTime(own, found) : [...own, ...found];
    rows[table] = merged.map((row, position) => ({ ...row, position }));
  }
  const versions = rows.description_versions ?? [];
  const known = new Set(versions.map((row) => row.id));
  for (const description of rows.descriptions ?? []) {
    const current = text(description.current_version);
    if (current === null || known.has(current)) continue;
    const version = db.prepare('SELECT * FROM description_versions WHERE id = ? AND retired_at IS NULL').get(current);
    if (version) versions.push({ ...version });
  }
  rows.description_versions = versions;
}

const without = (row: Row, columns: ReadonlyArray<string>): Row =>
  Object.fromEntries(Object.entries(row).filter(([column]) => !columns.includes(column)));

/** The table and id of a row, as one key. */
const keyOf = (table: string, id: unknown): string => `${table}\u0000${String(id)}`;

/** The descriptions of `mapping` whose current version is her session's and that the file did not edit since. */
function heldDescriptions(db: Db, mapping: Rows): Set<string> {
  const held = new Set<string>();
  const incoming = new Map((mapping.description_versions ?? []).map((row) => [row.id, row]));
  for (const description of mapping.descriptions ?? []) {
    const stored = text(
      db.prepare('SELECT current_version FROM descriptions WHERE id = ?').get(description.id)?.current_version
    );
    const own = text(description.current_version);
    if (stored === null || own === null || stored === own) continue;
    const current = db.prepare('SELECT text, origin FROM description_versions WHERE id = ?').get(stored);
    if (!current || current.origin === 'legacy') continue;
    const brought = incoming.get(own)?.text;
    const had = db.prepare('SELECT text FROM description_versions WHERE id = ?').get(own)?.text;
    if (brought === current.text || brought === had) {
      held.add(keyOf('descriptions', description.id));
      held.add(keyOf('description_versions', own));
    }
  }
  return held;
}

/**
 * What a unit write of `mapping` may write of each of its rows (see the head of this file): `hold(table, row)` gives
 * the row to write, the row without the columns her session wrote last, or null when the row is left whole.
 */
export function sessionHold(connection: unknown, mapping: unknown): (table: string, row: unknown) => Row | null {
  const db = connection as Db; // a node:sqlite connection of the memory database; the queries below read it
  // A mapping is table -> rows (map/index.js#toRows), each row a column -> value object.
  const descriptions = heldDescriptions(db, mapping as Rows);
  return (table, value) => {
    const row = value as Row; // one row of the mapping above
    if (table === 'descriptions' && descriptions.has(keyOf(table, row.id))) return without(row, ['current_version']);
    if (table === 'description_versions' && descriptions.has(keyOf(table, row.id))) return null;
    if (table !== 'people') return row;
    const last = text(db.prepare(LAST_MOVE_SQL).get(row.id)?.id);
    const affinity = remainderOf(row.extra).affinity;
    const seen = isObject(affinity) ? text(affinity.moveId) : null;
    if (last === null || seen === last) return row;
    const kept = without(row, ['affinity_reason']);
    if (seen === null || typeof row.affinity !== 'number') return without(kept, ['affinity', 'affinity_decayed_at']);
    const unseen = db
      .prepare(
        `SELECT COALESCE(SUM(applied), 0) AS moved FROM affinity_events WHERE person_id = ? AND owner_file IS NULL AND retired_at IS NULL
          AND rowid > COALESCE((SELECT rowid FROM affinity_events WHERE id = ?), 0)`
      )
      .get(row.id, seen);
    const score = Math.min(100, Math.max(-100, row.affinity + Number(unseen?.moved ?? 0)));
    return { ...kept, affinity: Math.round(score * 100) / 100 };
  };
}

/** Makes claim `id` her session's: no unit owns it or shares it any more (see the head of this file). */
export function takeOverClaim(connection: unknown, id: unknown): void {
  const db = connection as Db; // the writer's node:sqlite connection, inside the op's transaction
  db.prepare('UPDATE claims SET owner_file = NULL WHERE id = ?').run(id);
  db.prepare("DELETE FROM co_owners WHERE tbl = 'claims' AND key = ?").run(id);
}
