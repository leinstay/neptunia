// The mirrors of the diary in a test: a place and a `mirrors` row (schema v15) seeded into a memory database, the
// publications and diary rows read back, and `publishTo`, which publishes the entry a diary turn recorded to one mirror
// on a fake interface, the way src/behavior/mirror.ts does it after the turn. The rows are seeded on the service's
// connection, which is the writer when the service runs on the calling thread (tests/fixtures/memory-db/service.js).
// Synthetic data only.
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { channelPlaceId } from '../../src/memory/db/ids.ts';
import { insertRows } from '../../src/memory/db/rows.js';
import type { createFakeAdapter } from '../../src/interface/fake.js';
import { openTestMemory } from './memory-db/service.js';

/**
 * The entry a diary turn recorded (`result.diary.entry`), as src/behavior/mirror.ts#publishEntry takes it: its `diary`
 * row's id and her messages in order, and whatever else the publisher needs to send it (the pictures, the voice).
 */
export type RecordedEntry = { id: string; messages: ReadonlyArray<string> };
/** What `publishEntry` answers for each enabled mirror: its place, the publication's state and the port's code. */
export type PublishOutcome = { placeId: string; status: 'queued' | 'sent' | 'failed' | 'unknown'; code: string | null };
/** The part of src/behavior/mirror.ts `publishTo` uses. */
type MirrorModule = {
  createMirrors(deps: { memoryDb: MemoryService; port: () => Fake | null; now: () => number }): {
    publishEntry(entry: RecordedEntry): Promise<Array<PublishOutcome>>;
  };
};

type Row = Record<string, unknown>;
type Statement = { run(...params: Array<unknown>): unknown; all(...params: Array<unknown>): Array<Row> };
type Db = { prepare(sql: string): Statement };
type Fake = ReturnType<typeof createFakeAdapter>;
/** The memory service of a test (what openTestMemory opened). */
export type MemoryService = Awaited<ReturnType<typeof openTestMemory>>['memoryDb'];

/** The connection of the service: the writer, since a test's service runs on the calling thread. */
export function dbOf(memoryDb: MemoryService): Db {
  const handle = memoryDb.readHandle() as { db: Db } | null; // the service's handle is untyped JS; `db` is node:sqlite's
  assert.ok(handle, 'the memory database is open');
  return handle.db;
}

/**
 * A group conversation of `iface` as a place, and a `diary` mirror on it set up by the owner. Returns the mirror's id
 * and the place's id.
 */
export function seedMirror(
  memoryDb: MemoryService,
  {
    iface,
    conversationId,
    name = conversationId,
    enabled = true,
    at,
  }: { iface: string; conversationId: string; name?: string; enabled?: boolean; at: number }
): { id: string; placeId: string } {
  const db = dbOf(memoryDb);
  const placeId = channelPlaceId(iface, conversationId);
  const stamp = new Date(at).toISOString();
  insertRows(
    db,
    {
      places: [
        { id: placeId, iface, kind: 'channel', native_id: conversationId, parent_id: null, scope_kind: 'group', name },
      ],
    },
    { at: stamp }
  );
  const id = `mirror:test:${placeId}`;
  db.prepare(
    "INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by, extra) VALUES (?, 'diary', ?, ?, ?, 'owner', NULL)"
  ).run(id, placeId, enabled ? 1 : 0, stamp);
  return { id, placeId };
}

/** One publication as a test reads it: its state, key, destination and the message keys of its receipts. */
export type PublicationRow = { status: string; key: string; placeId: string | null; receiptKeys: Array<string> };

/** The publications of `diary` rows, oldest first. */
export function diaryPublications(memoryDb: MemoryService): Array<PublicationRow> {
  return dbOf(memoryDb)
    .prepare(
      "SELECT status, idempotency_key, destination_place_id, receipts FROM publications WHERE row_kind = 'diary' ORDER BY created_at, id"
    )
    .all()
    .map((row) => ({
      status: String(row.status),
      key: String(row.idempotency_key),
      placeId: typeof row.destination_place_id === 'string' ? row.destination_place_id : null,
      receiptKeys: (JSON.parse(typeof row.receipts === 'string' ? row.receipts : '[]') as Array<{ key: string }>).map(
        (receipt) => receipt.key
      ),
    }));
}

/** The diary rows of memory: id, kind and full text, in their order. */
export function diaryRows(memoryDb: MemoryService): Array<{ id: string; kind: string | null; text: string | null }> {
  return dbOf(memoryDb)
    .prepare('SELECT id, kind, text FROM diary WHERE retired_at IS NULL ORDER BY position, id')
    .all()
    .map((row) => ({
      id: String(row.id),
      kind: typeof row.kind === 'string' ? row.kind : null,
      text: typeof row.text === 'string' ? row.text : null,
    }));
}

/** The entry a diary turn recorded, from its result (`result.diary.entry`). */
export function entryOf(result: unknown): RecordedEntry {
  // The turn runner is JS and answers an untyped result; the entry's shape is the contract of mirror.ts.
  const entry = (result as { diary?: { entry?: RecordedEntry } } | null)?.diary?.entry;
  assert.ok(entry, 'the diary turn names the entry it recorded');
  return entry;
}

/** The counts of a diary turn's outcome (`result.diary`) without the entry it names. */
export function diaryCounts(result: unknown): Record<string, unknown> {
  // The turn runner is JS and answers an untyped result; `diary` is a plain object of counts and the entry.
  const { entry, ...counts } = (result as { diary: Record<string, unknown> }).diary;
  void entry;
  return counts;
}

/** The `index`th post a fake store's `appendDiaryPost` was given: `{ guildId, post, opts }`. */
export function appendedPost(
  store: { appended: Array<unknown> },
  index = 0
): { guildId: unknown; post: Record<string, unknown>; opts: unknown } {
  // The fake stores of the turn tests keep each call's arguments as `{ guildId, post, opts }`.
  const call = store.appended[index] as { guildId: unknown; post: Record<string, unknown>; opts: unknown } | undefined;
  assert.ok(call, `the store was given post ${index}`);
  return call;
}

/** The memory databases `publishTo` opened, closed when the test file is done. */
const OPENED: Array<{ close(): unknown }> = [];
after(async () => {
  for (const memory of OPENED.splice(0)) await memory.close();
});

/**
 * Publishes the entry of a diary turn's `result` to the mirror on `conversationId` of `port`: a memory database with
 * that one enabled mirror, and the publisher of src/behavior/mirror.ts over it. Returns what `publishEntry` answered.
 * The module is imported when the first publication runs, so tests/diary-turn.test.js, whose other cases test the turn
 * alone, loads without it.
 */
export async function publishTo(
  result: unknown,
  port: Fake,
  { conversationId = 'd1', now }: { conversationId?: string; now: number }
): Promise<Array<PublishOutcome>> {
  const memory = await openTestMemory({ now: () => now });
  OPENED.push(memory);
  seedMirror(memory.memoryDb, { iface: port.iface, conversationId, at: now });
  const specifier = '../../src/behavior/mirror.ts';
  const loaded: unknown = await import(specifier);
  const mirror = loaded as MirrorModule; // the module's own types are checked by tests/mirror.test.ts
  const mirrors = mirror.createMirrors({ memoryDb: memory.memoryDb, port: () => port, now: () => now });
  return mirrors.publishEntry(entryOf(result));
}
