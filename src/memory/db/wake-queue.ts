// The wake queue of the inner life in the memory database (schema v18), its fenced leases and the deliveries a
// completed wake leaves to send. A wake is one row of `wakes`: `queued` until a turn claims it, `running` while that
// turn holds the lease `wake:<id>`, then `handled` (a turn or the engine disposed of it) or `slept` (it fell due while
// the core was down or paused, and never runs). The claim is one transaction that moves the row to `running` and
// grants the lease with a new token; the completion is another that checks the token and records the turn's
// deliveries `queued` under their effect keys, so a holder whose lease was taken over writes nothing. A lease token
// rises with every grant of its name and is never reused. Recovery at a start puts a running wake whose lease expired
// back to `queued` under its first turn id, or makes it `slept` when it fell due after the last `core:alive` renewal.
//
// Times are epoch milliseconds. The functions run synchronously over an open handle: the service's writer applies the
// writes (`applyWakeQueueWrite`, reached through session-write.js#applyMemoryWrite), and the reads take the read
// connection (`{ db }`). The inner life (src/behavior/inner/wake-store.ts) is the one caller of the writes;
// `importWakeQueues` is the v18 data step that moves each guild's `inner.json` queue into the table (open.js runs it
// again at every open that knows the data directory, for a file an earlier opener could not reach).

import fs from 'node:fs';
import path from 'node:path';

/** The states of a wake row. */
export const WAKE_STATES = ['queued', 'running', 'handled', 'slept', 'dropped'] as const;
export type WakeState = (typeof WAKE_STATES)[number];

/** The lease that says the core is up: renewed at every tick of the inner life, read by the next start. */
export const ALIVE_LEASE = 'core:alive';

/** What the turn that holds a running wake was about, for the journal check of a turn a restart cut off. */
export type TurnMark = {
  kind: string;
  channelId: string | null;
  privateChat: boolean;
  privateUserId: string | null;
};

/** One wake row as the store reads it back. */
export type StoredWake = {
  id: string;
  kind: string;
  community: string | null;
  state: WakeState;
  dueAt: number | null;
  queuedAt: number;
  payload: Record<string, unknown>;
  leaseHolder: string | null;
  leaseToken: number | null;
  leaseExpiresAt: number | null;
  handledAt: number | null;
  outcome: string | null;
  turnId: string | null;
  attempt: number;
  claimedAt: number | null;
  turn: TurnMark | null;
};

/** One lease row. */
export type Lease = { name: string; holder: string; token: number; expiresAt: number; renewedAt: number };

/** One delivery a completed wake left: its effect key, where it goes and what it carries. */
export type Delivery = {
  key: string;
  wakeId: string;
  target: string | null;
  payload: unknown;
  state: 'queued' | 'sent';
  queuedAt: number;
  sentAt: number | null;
};

/** A delivery as the completion records it. */
export type DeliveryInput = { key: string; target: string | null; payload: unknown };

/** A wake as the inner life queues it: its id and kind, its due time, and the rest of its fields as the payload. */
export type WakeInput = {
  readonly id: string;
  readonly kind: string;
  readonly dueAt?: number | null;
  readonly queuedAt?: number;
  readonly [field: string]: unknown;
};

/** A handle the functions read or write through: an open connection (node:sqlite) under `db`. */
export type Handle = { readonly db: object };

type Row = Record<string, unknown>;
type Statement = {
  get(...params: Array<unknown>): Row | undefined;
  all(...params: Array<unknown>): Array<Row>;
  run(...params: Array<unknown>): { changes: number | bigint };
};
type Db = { prepare(sql: string): Statement; exec(sql: string): void };

// The handle's connection is node:sqlite's DatabaseSync, which open.js leaves untyped; this is the part used here.
const dbOf = (handle: Handle): Db => handle.db as Db;

/**
 * BEGIN IMMEDIATE .. COMMIT over the handle's connection, as open.js#inTransaction does (open.js imports this module
 * for the v18 step, so it is not imported back); a throw rolls back and rethrows.
 */
function inWrite<TResult>(handle: Handle, fn: (db: Db) => TResult): TResult {
  const db = dbOf(handle);
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(db);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** A JSON column read back; an unreadable one is null. */
function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function objectOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function turnMarkOf(value: unknown): TurnMark | null {
  const raw = parsed(value);
  if (raw === null || typeof raw !== 'object') return null;
  const mark = objectOf(raw);
  return {
    kind: textOrNull(mark.kind) ?? '',
    channelId: textOrNull(mark.channelId),
    privateChat: mark.privateChat === true,
    privateUserId: textOrNull(mark.privateUserId),
  };
}

function stateOf(value: unknown): WakeState {
  return WAKE_STATES.find((state) => state === value) ?? 'dropped';
}

function wakeOfRow(row: Row): StoredWake {
  return {
    id: String(row.id),
    kind: String(row.kind),
    community: textOrNull(row.community),
    state: stateOf(row.state),
    dueAt: numberOrNull(row.due_at),
    queuedAt: Number(row.queued_at),
    payload: objectOf(parsed(row.payload)),
    leaseHolder: textOrNull(row.lease_holder),
    leaseToken: numberOrNull(row.lease_token),
    leaseExpiresAt: numberOrNull(row.lease_expires_at),
    handledAt: numberOrNull(row.handled_at),
    outcome: textOrNull(row.outcome),
    turnId: textOrNull(row.turn_id),
    attempt: Number(row.attempt ?? 0),
    claimedAt: numberOrNull(row.claimed_at),
    turn: turnMarkOf(row.turn),
  };
}

/** The stored wake `id`, or null. */
export function wakeOf(handle: Handle, id: string): StoredWake | null {
  const row = dbOf(handle).prepare('SELECT * FROM wakes WHERE id = ?').get(id);
  return row ? wakeOfRow(row) : null;
}

/**
 * The stored wakes of `community` in `states`, the oldest queued first; `handledSince` keeps only the handled and slept
 * ones disposed of at or after it.
 */
export function listWakes(
  handle: Handle,
  {
    community,
    states,
    handledSince = null,
  }: { community: string; states: ReadonlyArray<WakeState>; handledSince?: number | null }
): Array<StoredWake> {
  const marks = states.map(() => '?').join(', ');
  return dbOf(handle)
    .prepare(
      `SELECT * FROM wakes WHERE community = ? AND state IN (${marks}) AND (? IS NULL OR handled_at IS NULL OR handled_at >= ?) ORDER BY queued_at, id`
    )
    .all(community, ...states, handledSince, handledSince)
    .map(wakeOfRow);
}

/** The lease `name`, or null. */
export function leaseOf(handle: Handle, name: string): Lease | null {
  const row = dbOf(handle).prepare('SELECT * FROM leases WHERE name = ?').get(name);
  if (!row) return null;
  return {
    name: String(row.name),
    holder: String(row.holder),
    token: Number(row.token),
    expiresAt: Number(row.expires_at),
    renewedAt: Number(row.renewed_at),
  };
}

/** What a grant answers: the new token, or why not. */
export type Grant = { ok: true; token: number } | { ok: false; code: 'held' };

/** The lease `name` granted to `holder` with a raised token (no transaction of its own). */
function grant(db: Db, name: string, holder: string, now: number, ttlMs: number): number {
  const before = db.prepare('SELECT token FROM leases WHERE name = ?').get(name);
  const token = Number(before?.token ?? 0) + 1;
  db.prepare(
    `INSERT INTO leases (name, holder, token, expires_at, renewed_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, token = excluded.token, expires_at = excluded.expires_at, renewed_at = excluded.renewed_at`
  ).run(name, holder, token, now + ttlMs, now);
  return token;
}

function leaseFree(db: Db, name: string, now: number): boolean {
  const row = db.prepare('SELECT expires_at FROM leases WHERE name = ?').get(name);
  return !row || Number(row.expires_at) <= now;
}

/** The lease `name` for `holder` until `now + ttlMs`, unless another grant of it has not expired. */
export function acquireLease(
  handle: Handle,
  { name, holder, now, ttlMs }: { name: string; holder: string; now: number; ttlMs: number }
): Grant {
  return inWrite(handle, (db): Grant => {
    if (!leaseFree(db, name, now)) return { ok: false, code: 'held' };
    return { ok: true, token: grant(db, name, holder, now, ttlMs) };
  });
}

/** What a fenced write answers. */
export type Fenced = { ok: true } | { ok: false; code: 'stale-lease' };

/** The lease `name` held on to `now + ttlMs` by the holder of `token`; refused once another grant raised the token. */
export function renewLease(
  handle: Handle,
  { name, token, now, ttlMs }: { name: string; token: number; now: number; ttlMs: number }
): Fenced {
  return inWrite(handle, (db): Fenced => {
    const changed = db
      .prepare('UPDATE leases SET expires_at = ?, renewed_at = ? WHERE name = ? AND token = ?')
      .run(now + ttlMs, now, name, token).changes;
    return Number(changed) > 0 ? { ok: true } : { ok: false, code: 'stale-lease' };
  });
}

/** The lease `name` let go by the holder of `token` (it expires now); an older token changes nothing. */
function releaseLease(db: Db, name: string, token: number, now: number): void {
  db.prepare('UPDATE leases SET expires_at = ? WHERE name = ? AND token = ? AND expires_at > ?').run(
    now,
    name,
    token,
    now
  );
}

/** The `core:alive` lease renewed by `holder` until `now + ttlMs`; a new holder takes it over (one core runs). */
function markAlive(db: Db, holder: string, now: number, ttlMs: number): void {
  const row = db.prepare('SELECT holder FROM leases WHERE name = ?').get(ALIVE_LEASE);
  if (row?.holder === holder) {
    db.prepare('UPDATE leases SET expires_at = ?, renewed_at = ? WHERE name = ?').run(now + ttlMs, now, ALIVE_LEASE);
    return;
  }
  grant(db, ALIVE_LEASE, holder, now, ttlMs);
}

/** What queueing answers. */
export type Queued = { status: 'queued' | 'duplicate' };

function insertWake(db: Db, wake: WakeInput, state: WakeState, now: number, community: string | null): boolean {
  const changed = db
    .prepare(
      `INSERT OR IGNORE INTO wakes (id, kind, community, due_at, queued_at, payload, state, handled_at, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      wake.id,
      wake.kind,
      community,
      numberOrNull(wake.dueAt),
      numberOrNull(wake.queuedAt) ?? now,
      JSON.stringify(wake),
      state,
      state === 'slept' ? now : null,
      state === 'slept' ? 'slept' : null
    ).changes;
  return Number(changed) > 0;
}

/** `wake` queued at `now` (its own `queuedAt` when it has one); a wake id the table holds already is a duplicate. */
export function queueWake(
  handle: Handle,
  { wake, now, community = null }: { wake: WakeInput; now: number; community?: string | null }
): Queued {
  return inWrite(handle, (db): Queued => ({
    status: insertWake(db, wake, 'queued', now, community) ? 'queued' : 'duplicate',
  }));
}

/** What a claim answers: the lease's token, the turn id the wake runs under and which attempt this is; or why not. */
export type Claim =
  | { ok: true; token: number; turnId: string | null; attempt: number }
  | { ok: false; code: 'not-found' | 'not-queued' | 'held' };

type ClaimInput = {
  id: string;
  holder: string;
  now: number;
  leaseMs: number;
  turnId?: string | null;
  turn?: TurnMark | null;
};

/** The claim without a transaction of its own; a wake that ran before keeps its first turn id. */
function claimIn(db: Db, { id, holder, now, leaseMs, turnId = null, turn = null }: ClaimInput): Claim {
  const row = db.prepare('SELECT state, turn_id, attempt FROM wakes WHERE id = ?').get(id);
  if (!row) return { ok: false, code: 'not-found' };
  if (row.state !== 'queued') return { ok: false, code: 'not-queued' };
  const name = `wake:${id}`;
  if (!leaseFree(db, name, now)) return { ok: false, code: 'held' };
  const token = grant(db, name, holder, now, leaseMs);
  const keptTurn = textOrNull(row.turn_id) ?? turnId;
  const attempt = Number(row.attempt ?? 0) + 1;
  db.prepare(
    `UPDATE wakes SET state = 'running', lease_holder = ?, lease_token = ?, lease_expires_at = ?, turn_id = ?,
     attempt = ?, claimed_at = ?, turn = ? WHERE id = ?`
  ).run(holder, token, now + leaseMs, keptTurn, attempt, now, turn ? JSON.stringify(turn) : null, id);
  return { ok: true, token, turnId: keptTurn, attempt };
}

/** Wake `id` moved from `queued` to `running` under a new grant of its lease `wake:<id>`, in one transaction. */
export function claimWake(handle: Handle, input: ClaimInput): Claim {
  return inWrite(handle, (db) => claimIn(db, input));
}

/** Whether `token` is the one the running wake `id` and its lease hold. */
function holds(db: Db, id: string, token: number): boolean {
  const row = db.prepare("SELECT lease_token FROM wakes WHERE id = ? AND state = 'running'").get(id);
  const lease = db.prepare('SELECT token FROM leases WHERE name = ?').get(`wake:${id}`);
  return row !== undefined && Number(row.lease_token) === token && Number(lease?.token) === token;
}

type CompleteInput = {
  id: string;
  token: number;
  outcome: string;
  now: number;
  deliveries?: ReadonlyArray<DeliveryInput>;
};

/** The completion without a transaction of its own (the token checked by the caller). */
function completeIn(db: Db, { id, token, outcome, now, deliveries = [] }: CompleteInput): void {
  db.prepare(
    `UPDATE wakes SET state = 'handled', handled_at = ?, outcome = ?, lease_holder = NULL, lease_expires_at = NULL
     WHERE id = ?`
  ).run(now, outcome, id);
  releaseLease(db, `wake:${id}`, token, now);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO deliveries (key, wake_id, target, payload, state, queued_at) VALUES (?, ?, ?, ?, 'queued', ?)"
  );
  for (const delivery of deliveries)
    insert.run(delivery.key, id, delivery.target, JSON.stringify(delivery.payload ?? null), now);
}

/**
 * Running wake `id` handled with `outcome`, its deliveries recorded `queued` by their keys, in one transaction that
 * first checks `token`: a stale token is refused and writes nothing.
 */
export function completeWake(handle: Handle, input: CompleteInput): Fenced {
  return inWrite(handle, (db): Fenced => {
    if (!holds(db, input.id, input.token)) return { ok: false, code: 'stale-lease' };
    completeIn(db, input);
    return { ok: true };
  });
}

/** Running wake `id` back to `queued` by the holder of `token`, with its fields as the turn left them: its next turn is a new one. */
function releaseIn(
  db: Db,
  { id, token, now, payload }: { id: string; token: number; now: number; payload: WakeInput }
): void {
  db.prepare(
    `UPDATE wakes SET state = 'queued', lease_holder = NULL, lease_expires_at = NULL, turn_id = NULL, turn = NULL,
     attempt = 0, payload = ?, due_at = ? WHERE id = ?`
  ).run(JSON.stringify(payload), numberOrNull(payload.dueAt), id);
  releaseLease(db, `wake:${id}`, token, now);
}

/** The deliveries still to send, in the order they were recorded. */
export function queuedDeliveries(handle: Handle): Array<Delivery> {
  return dbOf(handle)
    .prepare("SELECT * FROM deliveries WHERE state = 'queued' ORDER BY queued_at, rowid")
    .all()
    .map(deliveryOfRow);
}

function deliveryOfRow(row: Row): Delivery {
  return {
    key: String(row.key),
    wakeId: String(row.wake_id),
    target: textOrNull(row.target),
    payload: parsed(row.payload),
    state: row.state === 'sent' ? 'sent' : 'queued',
    queuedAt: Number(row.queued_at),
    sentAt: numberOrNull(row.sent_at),
  };
}

/** The delivery `key`, or null. */
export function deliveryOf(handle: Handle, key: string): Delivery | null {
  const row = dbOf(handle).prepare('SELECT * FROM deliveries WHERE key = ?').get(key);
  return row ? deliveryOfRow(row) : null;
}

/** Delivery `key` marked `sent` at `now`; whether it was still queued. */
export function markDelivered(handle: Handle, { key, now }: { key: string; now: number }): boolean {
  return inWrite(handle, (db) => {
    const changed = db
      .prepare("UPDATE deliveries SET state = 'sent', sent_at = ? WHERE key = ? AND state = 'queued'")
      .run(now, key).changes;
    return Number(changed) > 0;
  });
}

/** The moment the core was last known up (the `core:alive` renewal), or null when no start renewed it yet. */
function lastAlive(db: Db): number | null {
  return numberOrNull(db.prepare('SELECT renewed_at FROM leases WHERE name = ?').get(ALIVE_LEASE)?.renewed_at);
}

/** Wake `id` (queued, or running under a lease that expired) made `slept` at `now`. */
function sleepIn(db: Db, id: string, now: number): boolean {
  const changed = db
    .prepare(
      `UPDATE wakes SET state = 'slept', handled_at = ?, outcome = 'slept', lease_holder = NULL, lease_expires_at = NULL
       WHERE id = ? AND (state = 'queued' OR state = 'running')`
    )
    .run(now, id).changes;
  return Number(changed) > 0;
}

/**
 * The recovery of a start: every running wake whose lease expired by `now` goes back to `queued` under its first turn
 * id, or becomes `slept` when it fell due after the last `core:alive` renewal (the core was down then). Recovery never
 * marks a wake handled: only a completion does, so a running wake never completed.
 */
export function recoverWakes(handle: Handle, { now }: { now: number }): { requeued: number; slept: number } {
  return inWrite(handle, (db) => {
    const alive = lastAlive(db);
    const expired = db
      .prepare(
        "SELECT id, due_at FROM wakes WHERE state = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)"
      )
      .all(now);
    let requeued = 0;
    let slept = 0;
    for (const row of expired) {
      const due = numberOrNull(row.due_at);
      if (alive !== null && due !== null && due > alive && due <= now && sleepIn(db, String(row.id), now)) {
        slept += 1;
        continue;
      }
      requeueIn(db, String(row.id));
      requeued += 1;
    }
    return { requeued, slept };
  });
}

/**
 * The handled and slept wakes disposed of before `before` deleted, with their sent deliveries; a wake with a delivery
 * still queued stays. How many wakes went.
 */
function pruneIn(db: Db, before: number): number {
  db.prepare(
    `DELETE FROM deliveries WHERE state = 'sent' AND wake_id IN
     (SELECT id FROM wakes WHERE state IN ('handled', 'slept') AND handled_at < ?)`
  ).run(before);
  const changed = db
    .prepare(
      `DELETE FROM wakes WHERE state IN ('handled', 'slept') AND handled_at < ?
       AND id NOT IN (SELECT wake_id FROM deliveries)`
    )
    .run(before).changes;
  return Number(changed);
}

/** Running wake `id` back to `queued`, its turn id and attempt kept (a rerun keeps its effect keys). */
function requeueIn(db: Db, id: string): void {
  db.prepare(
    "UPDATE wakes SET state = 'queued', lease_holder = NULL, lease_expires_at = NULL WHERE id = ? AND state = 'running'"
  ).run(id);
}

/** One write of the inner life (src/behavior/inner/wake-store.ts) through the service's writer. */
export type WakeQueueUpdate =
  | { kind: 'wake-queue'; op: 'queue'; wake: WakeInput; now: number; community: string }
  | { kind: 'wake-queue'; op: 'payload'; id: string; wake: WakeInput }
  | { kind: 'wake-queue'; op: 'handle'; id: string; outcome: string; now: number }
  | { kind: 'wake-queue'; op: 'remove'; id: string }
  | { kind: 'wake-queue'; op: 'sleep'; wake: WakeInput; now: number; community: string }
  | { kind: 'wake-queue'; op: 'requeue'; ids: ReadonlyArray<string>; now: number }
  | {
      kind: 'wake-queue';
      op: 'claim-group';
      ids: ReadonlyArray<string>;
      holder: string;
      now: number;
      leaseMs: number;
      turnId: string;
      turn: TurnMark;
    }
  | {
      kind: 'wake-queue';
      op: 'finish-group';
      now: number;
      done: ReadonlyArray<{ id: string; token: number; outcome: string; deliveries: ReadonlyArray<DeliveryInput> }>;
      back: ReadonlyArray<{ id: string; token: number; wake: WakeInput }>;
    }
  | {
      kind: 'wake-queue';
      op: 'renew';
      claims: ReadonlyArray<{ id: string; token: number }>;
      now: number;
      leaseMs: number;
    }
  | { kind: 'wake-queue'; op: 'recover'; now: number }
  | { kind: 'wake-queue'; op: 'prune'; before: number }
  | { kind: 'wake-queue'; op: 'alive'; holder: string; now: number; ttlMs: number }
  | { kind: 'wake-queue'; op: 'lease-acquire'; name: string; holder: string; now: number; ttlMs: number }
  | { kind: 'wake-queue'; op: 'lease-renew'; name: string; token: number; now: number; ttlMs: number }
  | { kind: 'wake-queue'; op: 'lease-release'; name: string; token: number; now: number }
  | { kind: 'wake-queue'; op: 'delivered'; key: string; now: number };

/** What a group claim answers: every wake's token and the turn they run under, or the first refusal. */
export type GroupClaim =
  | { ok: true; tokens: Record<string, number>; turnId: string; attempt: number }
  | { ok: false; code: string; id: string };

/** The wakes of one turn claimed together: all of them, or none (the transaction rolls back on a refusal). */
function claimGroup(handle: Handle, update: Extract<WakeQueueUpdate, { op: 'claim-group' }>): GroupClaim {
  const refused = new Error('claim refused');
  let refusal: GroupClaim = { ok: false, code: 'not-found', id: '' };
  try {
    return inWrite(handle, (db): GroupClaim => {
      const kept = update.ids
        .map((id) => textOrNull(db.prepare('SELECT turn_id FROM wakes WHERE id = ?').get(id)?.turn_id))
        .find((turnId) => turnId !== null);
      const turnId = kept ?? update.turnId;
      const tokens: Record<string, number> = {};
      let attempt = 1;
      for (const id of update.ids) {
        const claim = claimIn(db, { ...update, id, turnId, turn: update.turn });
        if (!claim.ok) {
          refusal = { ok: false, code: claim.code, id };
          throw refused;
        }
        db.prepare('UPDATE wakes SET turn_id = ? WHERE id = ?').run(turnId, id);
        tokens[id] = claim.token;
        attempt = Math.max(attempt, claim.attempt);
      }
      return { ok: true, tokens, turnId, attempt };
    });
  } catch (error) {
    if (error === refused) return refusal;
    throw error;
  }
}

/** The end of one turn's claim: its handled wakes completed and the rest released, all or nothing by their tokens. */
function finishGroup(handle: Handle, update: Extract<WakeQueueUpdate, { op: 'finish-group' }>): Fenced {
  return inWrite(handle, (db): Fenced => {
    if (![...update.done, ...update.back].every((item) => holds(db, item.id, item.token)))
      return { ok: false, code: 'stale-lease' };
    for (const item of update.done) completeIn(db, { ...item, now: update.now });
    for (const item of update.back)
      releaseIn(db, { id: item.id, token: item.token, now: update.now, payload: item.wake });
    return { ok: true };
  });
}

/** The running wakes of one holder kept on to `now + leaseMs`; a claim whose token was raised is left alone. */
function renewClaims(handle: Handle, update: Extract<WakeQueueUpdate, { op: 'renew' }>): number {
  return inWrite(handle, (db) => {
    let renewed = 0;
    for (const { id, token } of update.claims) {
      if (!holds(db, id, token)) continue;
      db.prepare('UPDATE wakes SET lease_expires_at = ? WHERE id = ?').run(update.now + update.leaseMs, id);
      db.prepare('UPDATE leases SET expires_at = ?, renewed_at = ? WHERE name = ?').run(
        update.now + update.leaseMs,
        update.now,
        `wake:${id}`
      );
      renewed += 1;
    }
    return renewed;
  });
}

/** The ops of the inner life's writes. */
const WAKE_QUEUE_OPS: ReadonlySet<unknown> = new Set([
  'queue',
  'payload',
  'handle',
  'remove',
  'sleep',
  'requeue',
  'claim-group',
  'finish-group',
  'renew',
  'recover',
  'prune',
  'alive',
  'lease-acquire',
  'lease-renew',
  'lease-release',
  'delivered',
]);

const isWakeQueueUpdate = (value: unknown): value is WakeQueueUpdate =>
  value !== null &&
  typeof value === 'object' &&
  Reflect.get(value, 'kind') === 'wake-queue' &&
  WAKE_QUEUE_OPS.has(Reflect.get(value, 'op'));

/**
 * One write of the inner life, applied on the writer connection (session-write.js#applyMemoryWrite routes it here, and
 * the in-memory queue of wake-store.ts calls it directly). Refuses a closed handle and an op outside the union; the
 * fields of a known op are the ones src/behavior/inner/wake-store.ts wrote.
 */
export function applyWakeQueueWrite(handle: unknown, update: unknown): unknown {
  const db: unknown = handle !== null && typeof handle === 'object' ? Reflect.get(handle, 'db') : null;
  if (db === null || typeof db !== 'object')
    throw Object.assign(new Error('the memory database is not open'), { code: 'DB_CLOSED' });
  if (!isWakeQueueUpdate(update))
    throw Object.assign(new Error('a wake queue write needs a known op; see WakeQueueUpdate'), { code: 'BAD_UPDATE' });
  return applyTyped({ db }, update);
}

function applyTyped(handle: Handle, update: WakeQueueUpdate): unknown {
  switch (update.op) {
    case 'queue':
      return queueWake(handle, update);
    case 'payload':
      return inWrite(handle, (db) =>
        db
          .prepare("UPDATE wakes SET payload = ?, due_at = ? WHERE id = ? AND state = 'queued'")
          .run(JSON.stringify(update.wake), numberOrNull(update.wake.dueAt), update.id)
      ).changes;
    case 'handle':
      return inWrite(handle, (db) =>
        db
          .prepare("UPDATE wakes SET state = 'handled', handled_at = ?, outcome = ? WHERE id = ? AND state = 'queued'")
          .run(update.now, update.outcome, update.id)
      ).changes;
    case 'remove':
      return inWrite(handle, (db) => db.prepare("DELETE FROM wakes WHERE id = ? AND state = 'queued'").run(update.id))
        .changes;
    case 'sleep':
      return inWrite(
        handle,
        (db) =>
          insertWake(db, update.wake, 'slept', update.now, update.community) || sleepIn(db, update.wake.id, update.now)
      );
    case 'requeue':
      // The start takes over the wakes a dead process left running: their leases end now.
      return inWrite(handle, (db) =>
        update.ids.forEach((id) => {
          requeueIn(db, id);
          db.prepare('UPDATE leases SET expires_at = MIN(expires_at, ?) WHERE name = ?').run(update.now, `wake:${id}`);
        })
      );
    case 'claim-group':
      return claimGroup(handle, update);
    case 'finish-group':
      return finishGroup(handle, update);
    case 'renew':
      return renewClaims(handle, update);
    case 'recover':
      return recoverWakes(handle, update);
    case 'prune':
      return inWrite(handle, (db) => pruneIn(db, update.before));
    case 'alive':
      return inWrite(handle, (db) => markAlive(db, update.holder, update.now, update.ttlMs));
    case 'lease-acquire':
      return acquireLease(handle, update);
    case 'lease-renew':
      return renewLease(handle, update);
    case 'lease-release':
      return inWrite(handle, (db) => releaseLease(db, update.name, update.token, update.now));
    case 'delivered':
      return markDelivered(handle, update);
  }
}

// ---- the v18 data step ----------------------------------------------------------------------------------------

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
    channelId: textOrNull(inflight.channelId),
    privateChat: inflight.privateChat === true,
    privateUserId: textOrNull(inflight.privateUserId),
  };
  let count = 0;
  for (const entry of Array.isArray(state.queue) ? state.queue : []) {
    const wake = objectOf(entry);
    if (typeof wake.id !== 'string' || typeof wake.kind !== 'string') continue;
    const input: WakeInput = { ...wake, id: wake.id, kind: wake.kind };
    if (!insertWake(db, input, 'queued', numberOrNull(wake.dueAt) ?? 0, community)) continue;
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
  // The migration's connection is node:sqlite's DatabaseSync, which open.js leaves untyped.
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
