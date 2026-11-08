// The owner's configuration of the selfreflection's mirrors over the memory database (schema v27), apart from their delivery
// history: `applyMirrorWrite` is the writer's kind `mirror` (add, configure, remove, and the historical slot of a mirror),
// and the reads below resolve what the owner typed and scan the entries a mirror still lacks. A removed mirror keeps its
// row, marked `removed_at` and disabled: its `publications` rows are the delivery history, so adding the destination
// again reuses the row and deduplication holds.
//
// `registered_at` is when the mirror began to take new entries. An entry stored later that has no publication there was
// lost between its storing and its publish, so the next drain queues it. Older entries reach the mirror only through
// backfill: one oldest eligible entry per interval, up to the high-water mark captured when backfill started, by
// persisted order (`at_ms`, `position`, `id`). A receipt, a claim in flight or an uncertain send takes an entry out of
// the scan. Logs: none; a caller logs codes.

import { storedSelfreflectionPublicationRefusal } from './publish.ts';
import { dbOf, transactionOf } from './types.ts';
import type { Connection, Db, Row } from './types.ts';

/** One mirror with its place and its backfill, as the publisher reads it. */
export type MirrorRow = {
  id: string;
  placeId: string;
  enabled: boolean;
  iface: string;
  chatId: string;
  name: string | null;
  registeredAt: number;
  backfill: {
    enabled: boolean;
    intervalMs: number | null;
    highWater: string | null;
    nextDueAt: number | null;
    completedAt: number | null;
  };
};

/** What a backfill command changes; a key left out stays as it is. */
export type BackfillChange = { enabled?: boolean; intervalMs?: number };

/** One entry of the selfreflection as a scan reads it. */
export type ScannedEntry = { id: string; atMs: number; position: number; text: string | null; extra: unknown };

/** What a mirror's history comes to: the entries it still lacks, the first of them, and what holds that one back. */
export type MirrorHistory = {
  remaining: number;
  next: { entry: ScannedEntry; publication: Row | null } | null;
  blocked: { entryId: string; code: string } | null;
};

const numberOrNull = (value: unknown): number | null => (typeof value === 'number' ? value : null);

const MIRROR_SELECT = `SELECT m.*, p.iface, p.native_id, p.name FROM mirrors m JOIN places p ON p.id = m.place_id
  WHERE m.row_kind = 'selfreflection' AND m.removed_at IS NULL`;

function mirrorOf(row: Row): MirrorRow {
  const registered = numberOrNull(row.registered_at);
  return {
    id: String(row.id),
    placeId: String(row.place_id),
    enabled: row.enabled === 1,
    iface: String(row.iface),
    chatId: String(row.native_id),
    name: typeof row.name === 'string' ? row.name : null,
    // A row seeded before the column has its creation time.
    registeredAt: registered ?? Date.parse(String(row.created_at)),
    backfill: {
      enabled: row.backfill_enabled === 1,
      intervalMs: numberOrNull(row.backfill_interval_ms),
      highWater: typeof row.backfill_high_water === 'string' ? row.backfill_high_water : null,
      nextDueAt: numberOrNull(row.backfill_next_due_at),
      completedAt: numberOrNull(row.backfill_completed_at),
    },
  };
}

/** Every mirror not removed, oldest first. */
export function mirrorRows(handle: Connection): Array<MirrorRow> {
  return dbOf(handle).prepare(`${MIRROR_SELECT} ORDER BY m.created_at, m.id`).all().map(mirrorOf);
}

/** The mirror a word names, its id or its place id; null when it names none or the mirror was removed. */
export function mirrorNamed(handle: Connection, word: string): MirrorRow | null {
  const row = dbOf(handle).prepare(`${MIRROR_SELECT} AND (m.id = ? OR m.place_id = ?)`).get(word, word);
  return row ? mirrorOf(row) : null;
}

/**
 * The place a destination names: its interface-qualified id, or a bare native id one place alone holds. A native id two
 * interfaces share is ambiguous. A root or a private chat is no place an entry can be mirrored to.
 */
export function placeNamed(
  handle: Connection,
  destination: string
): { ok: true; placeId: string } | { ok: false; code: 'unknown-place' | 'ambiguous-place' } {
  const rows = dbOf(handle)
    .prepare(
      "SELECT id FROM places WHERE (id = ? OR native_id = ?) AND kind NOT IN ('server', 'dm') AND scope_kind = 'group'"
    )
    .all(destination, destination);
  const exact = rows.find((row) => row.id === destination);
  if (exact) return { ok: true, placeId: destination };
  const [only, second] = rows;
  if (!only) return { ok: false, code: 'unknown-place' };
  return second ? { ok: false, code: 'ambiguous-place' } : { ok: true, placeId: String(only.id) };
}

/** Whether an entry may go to a place at all: group material, with no stored restriction that refuses the place. */
function eligible(db: Db, row: Row, placeId: string): boolean {
  return row.scope_kind === 'group' && storedSelfreflectionPublicationRefusal(db, row.id, placeId) === null;
}

const scanned = (row: Row): ScannedEntry => ({
  id: String(row.id),
  atMs: Number(row.at_ms),
  position: Number(row.position ?? 0),
  text: typeof row.text === 'string' ? row.text : null,
  extra: row.extra,
});

const ENTRY_ORDER = 'ORDER BY at_ms, COALESCE(position, 0), id';
const ENTRY_COLUMNS = 'id, at_ms, position, text, extra, scope_kind';

/** The entries up to and including `through`, oldest first; null when no entry has that id. */
export function entriesThrough(handle: Connection, through: string): Array<string> | null {
  const db = dbOf(handle);
  const mark = db
    .prepare('SELECT at_ms, position FROM selfreflection WHERE id = ? AND retired_at IS NULL')
    .get(through);
  if (!mark) return null;
  return db
    .prepare(
      `SELECT id FROM selfreflection WHERE retired_at IS NULL AND (at_ms, COALESCE(position, 0), id) <= (?, ?, ?) ${ENTRY_ORDER}`
    )
    .all(mark.at_ms, Number(mark.position ?? 0), through)
    .map((row) => String(row.id));
}

/** The first id of `entries` that names no entry, or null. */
export function unknownEntry(handle: Connection, entries: ReadonlyArray<string>): string | null {
  const known = dbOf(handle).prepare('SELECT 1 AS ok FROM selfreflection WHERE id = ? AND retired_at IS NULL');
  return entries.find((id) => known.get(id) === undefined) ?? null;
}

/** The publications of a place by entry. */
function publicationsOfPlace(db: Db, placeId: string): Map<string, Row> {
  const rows = db
    .prepare(
      `SELECT * FROM publications WHERE row_kind = 'selfreflection' AND destination_place_id = ? AND retired_at IS NULL
        ORDER BY status = 'sent', created_at, id`
    )
    .all(placeId);
  // Ordered so the last one standing for an entry is a sent one, when a legacy key left two.
  return new Map(rows.map((row) => [String(row.row_id), row]));
}

/** Statuses that take an entry out of a scan: it is on the place, on its way there, or nobody knows. */
const SETTLED: ReadonlyArray<string> = ['sent', 'sending', 'unknown'];

/** What `mirror` still lacks of the selfreflection up to its high-water mark. */
export function historyOf(handle: Connection, mirror: MirrorRow): MirrorHistory {
  const db = dbOf(handle);
  const mark = mirror.backfill.highWater;
  const top =
    mark === null ? undefined : db.prepare('SELECT at_ms, position FROM selfreflection WHERE id = ?').get(mark);
  if (!top) return { remaining: 0, next: null, blocked: null };
  const published = publicationsOfPlace(db, mirror.placeId);
  const rows = db
    .prepare(
      `SELECT ${ENTRY_COLUMNS} FROM selfreflection WHERE retired_at IS NULL AND (at_ms, COALESCE(position, 0), id) <= (?, ?, ?) ${ENTRY_ORDER}`
    )
    .all(top.at_ms, Number(top.position ?? 0), mark)
    .filter((row) => {
      const status = published.get(String(row.id))?.status;
      return !SETTLED.includes(String(status)) && eligible(db, row, mirror.placeId);
    });
  const [first] = rows;
  if (!first) return { remaining: 0, next: null, blocked: null };
  const entry = scanned(first);
  const publication = published.get(entry.id) ?? null;
  const held = publication?.status === 'failed' || publication?.status === 'incomplete';
  return {
    remaining: rows.length,
    next: { entry, publication },
    blocked: held ? { entryId: entry.id, code: String(publication.code ?? publication.status) } : null,
  };
}

/** The entries stored after `mirror` was registered that have no publication there, oldest first. */
export function unpublishedSince(handle: Connection, mirror: MirrorRow): Array<ScannedEntry> {
  const db = dbOf(handle);
  const published = publicationsOfPlace(db, mirror.placeId);
  return db
    .prepare(`SELECT ${ENTRY_COLUMNS} FROM selfreflection WHERE retired_at IS NULL AND at_ms > ? ${ENTRY_ORDER}`)
    .all(mirror.registeredAt)
    .filter((row) => !published.has(String(row.id)) && eligible(db, row, mirror.placeId))
    .map(scanned);
}

/** The newest entry's id, or null: the high-water mark of a backfill starting now. */
function newestEntry(db: Db): string | null {
  const row = db
    .prepare(
      'SELECT id FROM selfreflection WHERE retired_at IS NULL ORDER BY at_ms DESC, COALESCE(position, 0) DESC, id DESC'
    )
    .get();
  return row ? String(row.id) : null;
}

function setColumns(db: Db, id: string, fields: Row): void {
  const cols = Object.keys(fields);
  if (cols.length === 0) return;
  db.prepare(`UPDATE mirrors SET ${cols.map((col) => `"${col}" = ?`).join(', ')} WHERE id = ?`).run(
    ...cols.map((col) => fields[col]),
    id
  );
}

/** A finished backfill: off, with its time, nothing due. */
const COMPLETED = (now: number): Row => ({
  backfill_enabled: 0,
  backfill_next_due_at: null,
  backfill_completed_at: now,
});

/**
 * Applies a backfill change to the mirror. Turning it on starts a new mark unless one is in progress, makes the first
 * entry due now, and completes at once when nothing is eligible. Turning it off keeps the mark and the due time, so
 * turning it on again continues.
 */
function applyBackfill(db: Db, id: string, change: BackfillChange | undefined, now: number): void {
  if (!change) return;
  if (change.intervalMs !== undefined) setColumns(db, id, { backfill_interval_ms: change.intervalMs });
  if (change.enabled === false) setColumns(db, id, { backfill_enabled: 0 });
  if (change.enabled !== true) return;
  const before = mirrorNamedOn(db, id);
  if (!before) return;
  const inProgress = before.backfill.highWater !== null && before.backfill.completedAt === null;
  setColumns(
    db,
    id,
    inProgress
      ? { backfill_enabled: 1 }
      : {
          backfill_enabled: 1,
          backfill_high_water: newestEntry(db),
          backfill_next_due_at: now,
          backfill_completed_at: null,
        }
  );
  const after = mirrorNamedOn(db, id);
  if (after && historyOf(db, after).remaining === 0) setColumns(db, id, COMPLETED(now));
}

const mirrorNamedOn = (db: Db, id: string): MirrorRow | null => mirrorNamed(db, id);

function add(db: Db, given: Row): { mirror: MirrorRow; reused: boolean } | null {
  const placeId = String(given.placeId);
  const now = Number(given.now);
  const by = String(given.by);
  const found = db.prepare("SELECT * FROM mirrors WHERE row_kind = 'selfreflection' AND place_id = ?").get(placeId);
  const id = found ? String(found.id) : `mirror:selfreflection:${placeId}`;
  if (!found)
    db.prepare(
      `INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by, extra, registered_at)
       VALUES (?, 'selfreflection', ?, 1, ?, ?, NULL, ?)`
    ).run(id, placeId, new Date(now).toISOString(), by, now);
  else if (found.removed_at !== null)
    // Back after a removal: a new registration with the old row, whose delivery history still stands.
    setColumns(db, id, {
      enabled: 1,
      removed_at: null,
      removed_by: null,
      created_by: by,
      registered_at: now,
      backfill_enabled: 0,
      backfill_high_water: null,
      backfill_next_due_at: null,
      backfill_completed_at: null,
    });
  applyBackfill(db, id, given.backfill as BackfillChange | undefined, now);
  const mirror = mirrorNamedOn(db, id);
  return mirror && { mirror, reused: Boolean(found) };
}

function configure(db: Db, given: Row): { mirror: MirrorRow; reused: boolean } | null {
  const id = String(given.id);
  const now = Number(given.now);
  const before = mirrorNamedOn(db, id);
  if (!before) return null;
  if (typeof given.enabled === 'boolean' && given.enabled !== before.enabled)
    // Enabled again: what she wrote while it was off stays out unless backfill takes it, so nothing arrives in a burst.
    setColumns(db, id, given.enabled ? { enabled: 1, registered_at: now } : { enabled: 0 });
  applyBackfill(db, id, given.backfill as BackfillChange | undefined, now);
  const mirror = mirrorNamedOn(db, id);
  return mirror && { mirror, reused: true };
}

function remove(db: Db, given: Row): { mirror: MirrorRow; reused: boolean } | null {
  const id = String(given.id);
  const mirror = mirrorNamedOn(db, id);
  if (!mirror) return null;
  setColumns(db, id, {
    enabled: 0,
    removed_at: new Date(Number(given.now)).toISOString(),
    removed_by: String(given.by),
  });
  return { mirror: { ...mirror, enabled: false }, reused: true };
}

/** One historical slot taken: the due time moves only from the value the caller read, so a second writer loses. */
function slot(db: Db, given: Row): { taken: boolean } {
  const changed = db
    .prepare('UPDATE mirrors SET backfill_next_due_at = ? WHERE id = ? AND backfill_next_due_at IS ?')
    .run(Number(given.next), String(given.id), numberOrNull(given.expected)).changes;
  return { taken: Number(changed) > 0 };
}

function complete(db: Db, given: Row): null {
  setColumns(db, String(given.id), COMPLETED(Number(given.now)));
  return null;
}

const OPERATIONS: Readonly<Record<string, (db: Db, given: Row) => unknown>> = {
  add,
  configure,
  remove,
  slot,
  complete,
};

/**
 * One write of the mirrors' configuration on the writer connection (session-write.ts, kind `mirror`). `add`, `configure`
 * and `remove` answer `{ mirror, reused }`, or null when the row is gone.
 */
export function applyMirrorWrite(handle: Connection, given: unknown): unknown {
  const update = (given ?? {}) as Row;
  const operation = OPERATIONS[String(update.op)];
  if (!operation) throw Object.assign(new Error('memory db: unknown mirror write'), { code: 'BAD_UPDATE' });
  const db = dbOf(handle);
  return transactionOf(handle)(() => operation(db, update));
}
