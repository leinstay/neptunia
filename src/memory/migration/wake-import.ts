// The v18 data step: each server's `inner.json` of an earlier release moves into the wake table. open.ts runs it again at
// every open that knows the data directory, for a file an earlier opener could not reach.

import fs from 'node:fs';
import path from 'node:path';
import type { TurnMark, WakeInput } from '../db/wake-queue.ts';

type Statement = { run(...args: Array<unknown>): { changes: number | bigint }; get(...args: Array<unknown>): unknown };
type Db = { prepare(sql: string): Statement; exec(sql: string): void };

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function objectOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function insertQueued(db: Db, wake: WakeInput, now: number, community: string): boolean {
  const changed = db
    .prepare(
      `INSERT OR IGNORE INTO wakes (id, kind, community, due_at, queued_at, payload, state, handled_at, outcome)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', NULL, NULL)`
    )
    .run(
      wake.id,
      wake.kind,
      community,
      numberOrNull(wake.dueAt),
      numberOrNull(wake.queuedAt) ?? now,
      JSON.stringify(wake)
    ).changes;
  return Number(changed) > 0;
}

/** The queue fields of a guild's `inner.json` that the database takes over. */
const QUEUE_FIELDS = ['queue', 'handled', 'inflight'] as const;

/** The kind a handled wake id names (`inner.wake:<kind>:...`). */
const kindOfId = (id: string): string => id.split(':')[1] || 'unknown';

/** The guild's state file read as an object, or null when it is missing or unreadable (the inner life sets it aside). */
function stateFileOf(file: string): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? objectOf(raw) : null;
  } catch {
    return null;
  }
}

/** One guild's queue, handled set and in-flight mark written as wake rows; how many. */
function importGuild(db: Db, community: string, state: Record<string, unknown>): number {
  const inflight = objectOf(state.inflight);
  const running = new Set(
    Array.isArray(inflight.wakeIds) ? inflight.wakeIds.filter((id) => typeof id === 'string') : []
  );
  const startedAt = numberOrNull(inflight.startedAt) ?? 0;
  const mark: TurnMark = {
    kind: textOrNull(inflight.kind) ?? '',
    placeId: textOrNull(inflight.channelId),
    privateChat: inflight.privateChat === true,
    privateUserId: textOrNull(inflight.privateUserId),
  };
  let count = 0;
  for (const entry of Array.isArray(state.queue) ? state.queue : []) {
    const wake = objectOf(entry);
    if (typeof wake.id !== 'string' || typeof wake.kind !== 'string') continue;
    const input: WakeInput = { ...wake, id: wake.id, kind: wake.kind };
    if (!insertQueued(db, input, numberOrNull(wake.dueAt) ?? 0, community)) continue;
    count += 1;
    if (!running.has(wake.id)) continue;
    // The turn a restart cut off: its lease expired when it started, so the recovery of the next start resolves it.
    db.prepare(
      `UPDATE wakes SET state = 'running', lease_holder = 'import', lease_token = 0, lease_expires_at = ?, turn_id = ?,
       attempt = 1, claimed_at = ?, turn = ? WHERE id = ?`
    ).run(startedAt, textOrNull(inflight.turnId), startedAt, JSON.stringify(mark), wake.id);
  }
  for (const [id, value] of Object.entries(objectOf(state.handled))) {
    const entry = objectOf(value);
    const at = numberOrNull(entry.at) ?? 0;
    const changed = db
      .prepare(
        `INSERT OR IGNORE INTO wakes (id, kind, community, due_at, queued_at, payload, state, handled_at, outcome)
         VALUES (?, ?, ?, NULL, ?, ?, 'handled', ?, ?)`
      )
      .run(
        id,
        kindOfId(id),
        community,
        at,
        JSON.stringify({ place: entry.place ?? null }),
        at,
        textOrNull(entry.outcome)
      ).changes;
    count += Number(changed);
  }
  return count;
}

/**
 * The state file written back without its queue fields. A file that cannot be written (a read-only directory) keeps
 * them, and the next open imports them again, which changes no row it already holds: the open never fails for it.
 */
function dropQueueFields(file: string, state: Record<string, unknown>): void {
  const kept = Object.fromEntries(
    Object.entries(state).filter(([key]) => !(QUEUE_FIELDS as ReadonlyArray<string>).includes(key))
  );
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(kept));
    fs.renameSync(temporary, file);
  } catch {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * The v18 data step, and every open after it that knows the data directory: each `guilds/<id>/inner.json` under
 * `context.dataDir` that still holds queue fields gives its queue, handled set and in-flight mark to `wakes` (ids kept),
 * and the file loses those fields. A file with nothing to move is left as it is, so an open after the import changes
 * nothing; an opener without a data directory (a tool's open) moves nothing, and the next open that has one does it.
 */
export function importWakeQueues(connection: unknown, context: unknown = {}): number {
  const given: unknown = context !== null && typeof context === 'object' ? Reflect.get(context, 'dataDir') : null;
  const dataDir = typeof given === 'string' && given ? given : null;
  if (!dataDir || connection === null || typeof connection !== 'object') return 0;
  // The migration's connection is node:sqlite's DatabaseSync, which `MemoryHandle.db` keeps opaque.
  const db = connection as Db;
  const guilds = path.join(dataDir, 'guilds');
  let count = 0;
  for (const community of fs.existsSync(guilds) ? fs.readdirSync(guilds) : []) {
    const file = path.join(guilds, community, 'inner.json');
    const state = stateFileOf(file);
    if (!state || !QUEUE_FIELDS.some((key) => Object.hasOwn(state, key))) continue;
    count += importGuild(db, community, state);
    dropQueueFields(file, state);
  }
  return count;
}
