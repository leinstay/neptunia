// The inner life's wake queue in the memory database (src/memory/db/wake-queue.ts). The state's `queue`, `handled`
// and `inflight` are a view: read back from `wakes` the first time a guild's state is used, then kept in step by
// `syncQueue`, which every save of the state calls (a new queued wake is written, a changed one rewritten, one taken
// off the queue written handled or removed). The turn's own steps are explicit and awaited: `claimTurn` claims the
// group's wakes with fenced leases before the turn asks the model, and `finishTurn` completes the handled ones, with
// the deliveries of the turn's held sends, and releases the rest after it. Every write goes through one chain, in
// order, through the memory database's writer (`memoryWrite`); with no memory database the queue lives in one
// in-memory database per data directory for the life of the process, opened with the same migrations, so the v18
// import reads the guild files there too.

import path from 'node:path';
import { openMemoryDb } from '../../memory/db/open.js';
import { applyWakeQueueWrite, listWakes } from '../../memory/db/wake-queue.ts';
import type { DeliveryInput, Handle, StoredWake, TurnMark, WakeQueueUpdate } from '../../memory/db/wake-queue.ts';
import { errorCode, objOf } from '../../tools/types.ts';
import { storedWakes } from '../wake.ts';
import { WAKE_KINDS } from './settings.ts';
import type { Handled, InnerContext, InnerState, Wake } from './types.ts';

/** How long the lease of a claimed wake lasts when `context.turnLeaseMs` is not set (config.json's default). */
const TURN_LEASE_MS = 300_000;

/** The database a guild's queue is kept in: its read connection (null while it is not open) and its writer. */
export type WakeBackend = { read(): Handle | null; write(update: WakeQueueUpdate): Promise<unknown> };

// The in-memory databases of the inner lives built without a memory database, by data directory, for the process.
const FALLBACK = new Map<string, Handle>();

/** The lease of a claimed wake (`context.turnLeaseMs`, read now). */
export function turnLeaseMs(life: InnerContext): number {
  const value = objOf(objOf(life.hot.config).context).turnLeaseMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : TURN_LEASE_MS;
}

/** The read connection a service hands out, when it is one. */
function handleOf(value: unknown): Handle | null {
  const db: unknown = value !== null && typeof value === 'object' ? Reflect.get(value, 'db') : null;
  return db !== null && typeof db === 'object' ? { db } : null;
}

/** The backend of `life`: the memory database's writer and read connection, or the data directory's in-memory one. */
export function backendOf(life: InnerContext): WakeBackend {
  if (life.wakeDb) return life.wakeDb;
  const service = life.memoryDb;
  if (typeof service?.memoryWrite === 'function' && typeof service.readHandle === 'function') {
    const write = service.memoryWrite.bind(service);
    const read = service.readHandle.bind(service);
    life.wakeDb = { read: () => handleOf(read()), write: async (update) => write(update) };
    return life.wakeDb;
  }
  const key = path.resolve(life.dataDir);
  let handle = FALLBACK.get(key);
  if (!handle) {
    handle = openMemoryDb(':memory:', { context: { dataDir: life.dataDir } });
    FALLBACK.set(key, handle);
  }
  const fallback = handle;
  life.wakeDb = { read: () => fallback, write: (update) => Promise.resolve(applyWakeQueueWrite(fallback, update)) };
  return life.wakeDb;
}

/** One write after every write before it; the answer, or a rejection with the writer's code. */
export function dbWrite(life: InnerContext, update: WakeQueueUpdate): Promise<unknown> {
  const link = life.writes.then(() => backendOf(life).write(update));
  life.writes = link.then(
    () => undefined,
    (err: unknown) => life.log.warn('inner: wake queue write failed', { op: update.op, code: errorCode(err) })
  );
  return link;
}

/** One write nobody waits for: a failure is logged by the chain. */
export function dbSend(life: InnerContext, update: WakeQueueUpdate): void {
  dbWrite(life, update).catch(() => {
    // Logged by the chain (dbWrite).
  });
}

/**
 * The wakes of stored rows, as the queue holds them: each payload with its row's id and kind, read the way a state
 * file's queue is (wake.ts#storedWakes renames the old fields); a row of an unknown kind is left out. The rows are
 * what syncQueue wrote from the queue, so a wake that passes the check has the rest of its shape.
 */
const wakesOfRows = (rows: ReadonlyArray<StoredWake>): Array<Wake> =>
  storedWakes(
    rows.map((row) => ({ ...row.payload, id: row.id, kind: row.kind })),
    WAKE_KINDS
  ) as Array<Wake>;

/** The handled entry of a stored row: when, the outcome, and an attend wake's place. */
function handledOfRow(row: StoredWake): Handled {
  const place = Object.hasOwn(row.payload, 'place') ? row.payload.place : row.payload.channelId;
  return {
    at: row.handledAt ?? row.queuedAt,
    outcome: row.outcome ?? row.state,
    ...(row.kind === 'attend' ? { place: typeof place === 'string' ? place : null } : {}),
  };
}

/**
 * The guild's view read back from `wakes` once: the queued and running wakes, and the handled and slept ones since
 * `keepSince`. A wake the state already held that the table lacks stays, and the next save writes it.
 */
export function loadView(life: InnerContext, guildId: string, state: InnerState, keepSince: number): void {
  if (life.viewLoaded.has(guildId)) return;
  const read = backendOf(life).read();
  if (!read) return;
  life.viewLoaded.add(guildId);
  const rows = listWakes(read, { community: guildId, states: ['queued', 'running'] });
  const synced = new Map<string, string>();
  const ids = new Set(rows.map((row) => row.id));
  const queue = wakesOfRows(rows);
  for (const wake of queue) synced.set(wake.id, JSON.stringify(wake));
  state.queue = [...queue, ...state.queue.filter((wake) => !ids.has(wake.id))];
  const handled = listWakes(read, { community: guildId, states: ['handled', 'slept'], handledSince: keepSince });
  state.handled = { ...state.handled, ...Object.fromEntries(handled.map((row) => [row.id, handledOfRow(row)])) };
  life.synced.set(guildId, synced);
}

/** The table brought in step with the guild's queue view (see the head of this file). Never throws. */
export function syncQueue(life: InnerContext, guildId: string, state: InnerState): void {
  if (!life.viewLoaded.has(guildId)) return;
  const synced = life.synced.get(guildId) ?? new Map<string, string>();
  life.synced.set(guildId, synced);
  const now = life.now();
  const seen = new Set<string>();
  for (const wake of state.queue) {
    seen.add(wake.id);
    const json = JSON.stringify(wake);
    const was = synced.get(wake.id);
    if (was === json) continue;
    synced.set(wake.id, json);
    dbSend(
      life,
      was === undefined
        ? { kind: 'wake-queue', op: 'queue', wake, now, community: guildId }
        : { kind: 'wake-queue', op: 'payload', id: wake.id, wake }
    );
  }
  for (const id of [...synced.keys()]) {
    if (seen.has(id)) continue;
    synced.delete(id);
    const entry = state.handled[id];
    dbSend(
      life,
      entry
        ? { kind: 'wake-queue', op: 'handle', id, outcome: entry.outcome, now: entry.at }
        : { kind: 'wake-queue', op: 'remove', id }
    );
  }
}

/** The claim of a turn: the turn id its wakes run under and which attempt this is. */
export type TurnClaim = { turnId: string; attempt: number };

/**
 * The wakes of `group` claimed for one turn, all or none, before the turn asks the model: each moves to `running` under
 * a new grant of its lease for `context.turnLeaseMs`. A wake that ran before keeps the turn id of its first run.
 * Null when the claim was refused or the write failed (logged).
 */
export async function claimTurn(
  life: InnerContext,
  guildId: string,
  group: ReadonlyArray<Wake>,
  { at, turn }: { at: number; turn: TurnMark }
): Promise<TurnClaim | null> {
  let answer: unknown;
  try {
    answer = await dbWrite(life, {
      kind: 'wake-queue',
      op: 'claim-group',
      ids: group.map((wake) => wake.id),
      holder: life.holder,
      now: at,
      leaseMs: turnLeaseMs(life),
      turnId: `t-${life.uuid()}`,
      turn,
    });
  } catch {
    return null;
  }
  const claim = objOf(answer);
  if (claim.ok !== true || typeof claim.turnId !== 'string') {
    const code = typeof claim.code === 'string' ? claim.code : 'error';
    life.log.warn('inner: wake claim refused', { guildId, code, wakes: group.length });
    return null;
  }
  for (const [id, token] of Object.entries(objOf(claim.tokens))) life.claims.set(id, Number(token));
  return { turnId: claim.turnId, attempt: Number(claim.attempt) || 1 };
}

/**
 * The end of a turn's claim: the wakes of `group` the state no longer queues are completed with their handled outcome,
 * the ones it still queues (a retry, a held turn) are released with their fields, in one fenced write. The first
 * completed wake records the `deliveries` of the turn's held sends (deliveries.ts#deliveriesOf); with no wake
 * completed they are dropped, and the wake's next turn makes them again. Answers the keys of the deliveries the write
 * committed. A refusal (a newer holder took a lease over) is logged and commits none.
 */
export async function finishTurn(
  life: InnerContext,
  guildId: string,
  group: ReadonlyArray<Wake>,
  state: InnerState,
  deliveries: ReadonlyArray<DeliveryInput> = []
): Promise<Array<string>> {
  const done: Array<{ id: string; token: number; outcome: string; deliveries: ReadonlyArray<DeliveryInput> }> = [];
  const back: Array<{ id: string; token: number; wake: Wake }> = [];
  const synced = life.synced.get(guildId);
  for (const { id } of group) {
    const token = life.claims.get(id);
    if (token === undefined) continue;
    life.claims.delete(id);
    const queued = state.queue.find((wake) => wake.id === id);
    if (queued) {
      back.push({ id, token, wake: queued });
      synced?.set(id, JSON.stringify(queued));
    } else
      done.push({
        id,
        token,
        outcome: state.handled[id]?.outcome ?? 'handled',
        deliveries: done.length === 0 ? deliveries : [],
      });
  }
  if (done.length === 0 && deliveries.length > 0)
    life.log.info('inner: held sends dropped with a retried turn', { guildId, sends: deliveries.length });
  if (done.length + back.length === 0) return [];
  try {
    const answer = objOf(
      await dbWrite(life, {
        kind: 'wake-queue',
        op: 'finish-group',
        now: life.now(),
        done,
        back,
        dataDir: life.dataDir,
      })
    );
    const code = typeof answer.code === 'string' ? answer.code : 'error';
    if (answer.ok === true) return done.flatMap((item) => item.deliveries.map((delivery) => delivery.key));
    life.log.warn('inner: wake completion refused', { guildId, code });
  } catch {
    // Logged by the chain (dbWrite).
  }
  return [];
}

/** The leases of the wakes this life's turns hold, kept on while they run (called at every tick). */
export function renewClaims(life: InnerContext): void {
  if (life.claims.size === 0) return;
  const claims = [...life.claims].map(([id, token]) => ({ id, token }));
  dbSend(life, { kind: 'wake-queue', op: 'renew', claims, now: life.now(), leaseMs: turnLeaseMs(life) });
}
