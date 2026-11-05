// The reads of the selfreflection's mirrors over the memory database (schema v15, `mirrors`): the places her selfreflection is posted
// to and whether a conversation is one of them. The memory side (the selfreflection media job, the writer's destination, the
// memory updater) and the behaviour side (src/behavior/mirror.ts, which passes them on to the turn, the pipeline, the
// scheduler and the sandbox) read them here. Pure reads over a node:sqlite connection; a failed read is logged with
// its code and answers nothing.

import { log } from '../../log.ts';

/** A place an entry is posted to: the place id, its interface, the conversation it is and its name. */
export type SelfreflectionPlace = { placeId: string; iface: string; conversationId: string; name: string | null };

type Row = Record<string, unknown>;
type Db = {
  prepare(sql: string): { all(...params: Array<unknown>): Array<Row>; get(...params: Array<unknown>): Row | undefined };
};

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** Whether the database has the `mirrors` table (schema v15). */
export function hasMirrors(db: Db): boolean {
  return db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'mirrors'").get() !== undefined;
}

/** A place row as a selfreflection place, or null when it names no interface or conversation. */
export function placeOf(row: Row | undefined): SelfreflectionPlace | null {
  const placeId = text(row?.id);
  const iface = text(row?.iface);
  const conversationId = text(row?.native_id);
  return placeId && iface && conversationId ? { placeId, iface, conversationId, name: text(row?.name) } : null;
}

/**
 * The places her selfreflection is posted to, read on `connection` (a node:sqlite connection of the memory database): the
 * places of the enabled `selfreflection` mirrors, oldest mirror first; with none, the place the last entry was published to;
 * with neither, none.
 */
export function selfreflectionPlaces(connection: unknown): Array<SelfreflectionPlace> {
  const db = connection as Db; // a node:sqlite connection; the queries below read it
  const mirrored = mirrorPlaces(db);
  if (mirrored.length > 0) return mirrored;
  const last = placeOf(
    db
      .prepare(
        `SELECT p.id, p.iface, p.native_id, p.name FROM publications x JOIN places p ON p.id = x.destination_place_id
          WHERE x.row_kind = 'selfreflection' AND x.retired_at IS NULL ORDER BY x.created_at DESC, x.id DESC LIMIT 1`
      )
      .get()
  );
  return last ? [last] : [];
}

/** The places of the enabled `selfreflection` mirrors, read on `connection`, oldest mirror first; none before schema v15. */
export function mirrorPlaces(connection: unknown): Array<SelfreflectionPlace> {
  const db = connection as Db; // a node:sqlite connection; the query below reads it
  if (!hasMirrors(db)) return [];
  return db
    .prepare(
      `SELECT p.id, p.iface, p.native_id, p.name FROM mirrors m JOIN places p ON p.id = m.place_id
        WHERE m.row_kind = 'selfreflection' AND m.enabled = 1 ORDER BY m.created_at, m.id`
    )
    .all()
    .map(placeOf)
    .filter((place): place is SelfreflectionPlace => place !== null);
}

/** What the mirrors are read from: the memory service (its read connection), or the store (`readMemory`). */
type MemorySource = {
  readHandle?: () => { db: unknown } | null;
  readMemory?: <TValue>(read: (db: unknown) => TValue) => TValue | null;
};

/**
 * `read(db)` on the memory database of `source` (the memory service's read connection, else the store's
 * `readMemory`), or `none` when there is none or the read fails.
 */
export function readMirrors<TValue>(source: unknown, read: (db: unknown) => TValue, none: TValue): TValue {
  try {
    const given = source as MemorySource | null | undefined;
    const handle = given?.readHandle?.() ?? null;
    if (handle) return read(handle.db);
    return given?.readMemory?.(read) ?? none;
  } catch (error) {
    log.warn('mirror: read failed', { code: (error as { code?: unknown } | null)?.code ?? 'ERROR' });
    return none;
  }
}

/** The conversation ids of her selfreflection's places in `memoryDb` (selfreflectionPlaces): where she keeps her selfreflection. */
export function selfreflectionConversationIds(memoryDb: unknown): Set<string> {
  return readMirrors(
    memoryDb,
    (db) => new Set(selfreflectionPlaces(db).map((place) => place.conversationId)),
    new Set<string>()
  );
}

/** Whether `conversationId` of `iface` is the place of an enabled selfreflection mirror in `memoryDb`. */
export function isMirrorPlace(memoryDb: unknown, iface: unknown, conversationId: unknown): boolean {
  const here = (place: SelfreflectionPlace): boolean =>
    place.iface === iface && place.conversationId === String(conversationId);
  return readMirrors(memoryDb, (db) => mirrorPlaces(db).some(here), false);
}
