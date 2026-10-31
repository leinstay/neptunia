// The ingestion record of the memory database (schema v16): one `ingest` row per event the core committed, keyed by
// the principal that sent it, and in `ingest_cursor` the contiguous watermark acknowledged to each principal. The
// event door (src/interface/door.js) asks `ingested` before it hands an event on and commits the row with
// `insertIngest` once the handler succeeded; the live message path commits the same row in the transaction of the
// observation it makes (observe.js#observe), and the door's later insert then changes nothing. The link
// (src/interface/link.ts) answers `hello` with `cursorOf` and writes each new watermark with `ackCursor`. Every
// insert also deletes the rows older than `keepDays`, at most once an hour, so the record holds what a redelivery
// can still bring. The writes go through the one writer (`memoryWrite`, session-write.js#applyMemoryWrite), the reads
// run on the read connection.

/**
 * One event the core took: who sent it, its `seq` (null when the envelope had none), id, kind and conversation, and
 * `held`, the whole event when it is a message the core holds for its resume (absent for every other).
 */
export type IngestRow = {
  principal: string;
  seq: number | null;
  eventId: string;
  kind: string;
  conversation: string | null;
  held?: Record<string, unknown> | null;
};

/** A message a pause holds: who sent it, its event id and the whole event, in the order the core took them. */
export type HeldEvent = { principal: string; eventId: string; event: Record<string, unknown> };

type Statement = {
  run(...args: Array<unknown>): unknown;
  get(...args: Array<unknown>): Record<string, unknown> | undefined;
};
type Db = { prepare(sql: string): Statement };

/** How long a row is kept when `memoryDb.ingestKeepDays` is not set (config.json's default). */
export const DEFAULT_KEEP_DAYS = 7;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// The last prune of each database file this thread wrote to, so a prune runs once an hour.
const lastPrune = new WeakMap<object, number>();

/** Whether the row is well formed: a principal, an event id and a kind; a `seq` a positive whole number or null. */
export function isIngestRow(value: unknown): value is IngestRow {
  if (value === null || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  const filled = (field: unknown): boolean => typeof field === 'string' && field !== '';
  const seqOk = row.seq === null || (typeof row.seq === 'number' && Number.isInteger(row.seq) && row.seq > 0);
  const conversationOk = row.conversation === null || typeof row.conversation === 'string';
  const heldOk =
    row.held === undefined || row.held === null || (typeof row.held === 'object' && !Array.isArray(row.held));
  return filled(row.principal) && filled(row.eventId) && filled(row.kind) && seqOk && conversationOk && heldOk;
}

/**
 * Writes `row` unless the principal already has the event, and prunes the rows older than `keepDays`. A row whose
 * `seq` the principal already used under another event keeps its event without the number.
 */
export function insertIngest(db: Db, row: IngestRow, options: { at: number; keepDays: number }): void {
  const committedAt = new Date(options.at).toISOString();
  const seqTaken =
    row.seq !== null &&
    db
      .prepare('SELECT 1 AS ok FROM ingest WHERE principal = ? AND seq = ? AND event_id <> ?')
      .get(row.principal, row.seq, row.eventId) !== undefined;
  const held = row.held === undefined || row.held === null ? null : JSON.stringify(row.held);
  db.prepare(
    'INSERT OR IGNORE INTO ingest (principal, seq, event_id, kind, conversation, committed_at, held) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(row.principal, seqTaken ? null : row.seq, row.eventId, row.kind, row.conversation, committedAt, held);
  const last = lastPrune.get(db) ?? 0;
  if (options.at - last < HOUR_MS) return;
  lastPrune.set(db, options.at);
  const before = new Date(options.at - options.keepDays * DAY_MS).toISOString();
  db.prepare('DELETE FROM ingest WHERE committed_at < ? AND held IS NULL').run(before);
}

/** A connection that lists rows, as the read connection is. */
type ListDb = { prepare(sql: string): { all(): Array<Record<string, unknown>> } };

/** The messages held for the resume, oldest first; a row whose event does not parse is skipped. */
export function heldEvents(db: ListDb): Array<HeldEvent> {
  const rows = db
    .prepare('SELECT principal, event_id, held FROM ingest WHERE held IS NOT NULL ORDER BY committed_at, rowid')
    .all();
  const found: Array<HeldEvent> = [];
  for (const row of rows) {
    let event: unknown;
    try {
      event = JSON.parse(String(row.held));
    } catch {
      // A held event the writer stored is JSON; one that is not is never replayed.
      continue;
    }
    if (event !== null && typeof event === 'object' && !Array.isArray(event))
      found.push({
        principal: String(row.principal),
        eventId: String(row.event_id),
        event: event as Record<string, unknown>,
      });
  }
  return found;
}

/** Whether the principal's event `eventId` is in the record. */
export function ingested(db: Db, principal: string, eventId: string): boolean {
  return (
    db.prepare('SELECT 1 AS ok FROM ingest WHERE principal = ? AND event_id = ?').get(principal, eventId) !== undefined
  );
}

/** The watermark acknowledged to the principal, 0 when none was. */
export function cursorOf(db: Db, principal: string): number {
  const found = db.prepare('SELECT acked_seq FROM ingest_cursor WHERE principal = ?').get(principal)?.acked_seq;
  return typeof found === 'number' ? found : 0;
}

/** Moves the principal's watermark up to `seq`; a lower one changes nothing. */
export function ackCursor(db: Db, principal: string, seq: number): void {
  db.prepare(
    'INSERT INTO ingest_cursor (principal, acked_seq) VALUES (?, ?) ON CONFLICT(principal) DO UPDATE SET acked_seq = MAX(acked_seq, excluded.acked_seq)'
  ).run(principal, seq);
}

/** A connection handle as the writer holds it (open.js#openMemoryDb). */
type Handle = { db: Db; transaction(fn: () => void): void };

const isHandle = (value: unknown): value is Handle =>
  value !== null && typeof value === 'object' && 'db' in value && 'transaction' in value;

const fieldsOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const keepDaysOf = (value: unknown): number => (typeof value === 'number' && value > 0 ? value : DEFAULT_KEEP_DAYS);

const refused = (message: string): Error => Object.assign(new Error(message), { code: 'BAD_INGEST' });

/** The `ingest` an observation envelope carries (`{ row, keepDays }`, see observe.js#observe), or null. */
export function ingestOption(envelope: unknown): { row: IngestRow; keepDays: number } | null {
  const ingest = fieldsOf(fieldsOf(envelope).ingest);
  return isIngestRow(ingest.row) ? { row: ingest.row, keepDays: keepDaysOf(ingest.keepDays) } : null;
}

/**
 * The writer's ingestion writes (session-write.js#applyMemoryWrite): kind `ingest` `{ row, at, keepDays }` writes one
 * event's row, kind `ingest-ack` `{ principal, seq }` a principal's watermark, kind `ingest-release`
 * `{ principal, eventId }` clears the hold of one event, each in its own transaction.
 */
export function applyIngestWrite(handle: unknown, update: unknown): { written: number } {
  const fields = fieldsOf(update);
  if (!isHandle(handle)) throw Object.assign(new Error('the memory database is not open'), { code: 'DB_CLOSED' });
  if (fields.kind === 'ingest') {
    const { row, at } = fields;
    if (!isIngestRow(row) || typeof at !== 'number') throw refused('an ingest row needs a principal, an id and a kind');
    handle.transaction(() => insertIngest(handle.db, row, { at, keepDays: keepDaysOf(fields.keepDays) }));
    return { written: 1 };
  }
  if (fields.kind === 'ingest-release') {
    const { principal, eventId } = fields;
    if (typeof principal !== 'string' || typeof eventId !== 'string')
      throw refused('a release needs a principal and an event id');
    handle.transaction(() => {
      handle.db.prepare('UPDATE ingest SET held = NULL WHERE principal = ? AND event_id = ?').run(principal, eventId);
    });
    return { written: 1 };
  }
  const { principal, seq } = fields;
  if (typeof principal !== 'string' || typeof seq !== 'number' || !Number.isInteger(seq))
    throw refused('a watermark needs a principal and a whole seq');
  handle.transaction(() => ackCursor(handle.db, principal, seq));
  return { written: 1 };
}

/** The ingestion record as the event door and the link use it (src/core.js wires it). */
export type IngestRecord = {
  /** Whether the principal's event was taken; false while the database is closed. */
  seen: (principal: string, eventId: string) => boolean;
  /** The watermark acknowledged to the principal; 0 while the database is closed. */
  cursor: (principal: string) => number;
  /** Writes an event's row through the writer; rejects with `DB_CLOSED` while the database is not open. */
  commit: (row: IngestRow) => Promise<unknown>;
  /** Writes the principal's new watermark through the writer. */
  ack: (principal: string, seq: number) => Promise<unknown>;
  /** The messages a pause holds, oldest first; none while the database is closed. */
  held: () => Array<HeldEvent>;
  /** Clears the hold of one event through the writer, once the resume replayed it. */
  release: (principal: string, eventId: string) => Promise<unknown>;
  /** The observation envelope of a line with the ingestion row of its event, for observe.js to write with it. */
  withRow: (envelope: object, row: IngestRow | null) => object;
};

/**
 * The ingestion record over the memory service (service.js#createMemoryDb): reads on its read connection, writes
 * through `memoryWrite`, the one writer. `memoryDb.ingestKeepDays` is read from `hot.config` at each write.
 */
export function createIngestRecord(deps: {
  memoryDb: { readHandle(): unknown; memoryWrite(update: object): Promise<unknown> };
  hot: unknown;
  now(): number;
}): IngestRecord {
  // The live config, read at each write (`hot.config`).
  const keepDays = (): number => keepDaysOf(fieldsOf(fieldsOf(fieldsOf(deps.hot).config).memoryDb).ingestKeepDays);
  const readDb = (): Db | null => {
    const reader = deps.memoryDb.readHandle();
    return isHandle(reader) ? reader.db : null;
  };
  return {
    seen(principal, eventId) {
      const db = readDb();
      return db !== null && ingested(db, principal, eventId);
    },
    cursor(principal) {
      const db = readDb();
      return db === null ? 0 : cursorOf(db, principal);
    },
    commit: (row) => deps.memoryDb.memoryWrite({ kind: 'ingest', row, at: deps.now(), keepDays: keepDays() }),
    ack: (principal, seq) => deps.memoryDb.memoryWrite({ kind: 'ingest-ack', principal, seq }),
    held() {
      const db = readDb();
      // The read connection is node:sqlite's, whose statements list rows with `all()`.
      return db === null ? [] : heldEvents(db as unknown as ListDb);
    },
    release: (principal, eventId) => deps.memoryDb.memoryWrite({ kind: 'ingest-release', principal, eventId }),
    withRow: (envelope, row) => (row === null ? envelope : { ...envelope, ingest: { row, keepDays: keepDays() } }),
  };
}

/**
 * The ingestion rows of the message events the door is handling, by message id, for the observation of each line to
 * write with it: `hold(event, row)` keeps the row while the handler runs and answers its release, `rowOf(envelope)`
 * finds the row of an observation envelope by its native key, the message id.
 */
export function createRowsByMessage(): {
  hold: (event: unknown, row: IngestRow | null) => () => void;
  rowOf: (envelope: unknown) => IngestRow | null;
} {
  const rows = new Map<string, IngestRow>();
  return {
    hold(event, row) {
      const id = fieldsOf(fieldsOf(event).message).id;
      if (row === null || typeof id !== 'string') return () => {};
      rows.set(id, row);
      return () => {
        if (rows.get(id) === row) rows.delete(id);
      };
    },
    rowOf(envelope) {
      const key = fieldsOf(fieldsOf(envelope).native).key;
      return typeof key === 'string' ? (rows.get(key) ?? null) : null;
    },
  };
}

/** `memoryDb` whose observations carry the ingestion row of their line's event (the pipeline's memory database). */
export function observingWith<TDb extends { observe(envelope: object, where?: unknown): unknown }>(
  memoryDb: TDb,
  record: IngestRecord,
  rows: { rowOf: (envelope: unknown) => IngestRow | null }
): TDb {
  const observe = (envelope: object, where?: unknown): unknown =>
    memoryDb.observe(record.withRow(envelope, rows.rowOf(envelope)), where);
  // The same service with its `observe` taking the row along; every other member is `memoryDb`'s own, through the
  // prototype, so the object is a `TDb` the compiler cannot see through `Object.create`.
  return Object.assign(Object.create(memoryDb) as object, { observe }) as unknown as TDb;
}
