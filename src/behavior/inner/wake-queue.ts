// The inner life's wake queue: the one writer of the queue's view in the state (`queue`, `handled`, `inflight`) and of
// its rows in the memory database's `wakes` (src/memory/db/wake-queue.ts). Every transition writes its row when it
// happens: a wake admitted is queued, one disposed of is handled, one taken back without an outcome is removed, a hold
// changes its payload, one that fell due while she slept is slept. A turn claims its group with fenced leases before
// it asks the model; its finish completes the wakes the turn disposed of and releases the rest with their fields, in
// one write. The writes share the writer chain of the persona state (`life.writes`). Without a memory database the
// queue is an in-memory database per data directory, which imports a state file's queue fields on its first open.
//
// The start's recovery runs once, before the first tick or drain lists anything: a turn a restart cut off (its wakes
// `running` under another holder) is resolved from the journal and its wakes handled `interrupted`, never run again;
// every wake queued before this life started is handled `interrupted`; handled rows past 30 days are pruned; the held
// sends are settled (deliveries.ts). A wake that fell due while the core was down (`core:alive` not renewed) or
// paused sleeps: handled `slept`, never run. Logs carry ids, codes and counts.

import path from 'node:path';
import { openMemoryDb } from '../../memory/db/open.ts';
import { ALIVE_LEASE, applyWakeQueueWrite, leaseOf, listWakes } from '../../memory/db/wake-queue.ts';
import type { Handle, DeliveryInput, StoredWake, TurnMark, WakeQueueUpdate } from '../../memory/db/wake-queue.ts';
import { DAY_MS, utcDay } from '../../time.ts';
import { errorCode, listOf, objOf } from '../../tools/types.ts';
import type { Obj } from '../../tools/types.ts';
import { storedWakes } from '../wake.ts';
import { resumeDeliveries } from './deliveries.ts';
import { asText } from './facts.ts';
import {
  addFact,
  contextOf,
  inScope,
  note,
  paused,
  save,
  stateOf,
  storeStateOf,
  wakeFact,
  wakeFields,
} from './queue.ts';
import { WAKE_KINDS, innerSettings } from './settings.ts';
import type {
  Handled,
  Inflight,
  InnerContext,
  InnerState,
  InnerWakeEvent,
  Wake,
  WakeBackend,
  WakeQueueState,
} from './types.ts';

/** How long the lease of a claimed wake lasts when `context.turnLeaseMs` is not set (config.json's default). */
const TURN_LEASE_MS = 300_000;
/** How long a handled wake stays in the table: longer than an intention lives, as the state file kept it. */
const HANDLED_KEEP_MS = 30 * DAY_MS;

/** The outcomes of a wake that never ran a turn for it: each is a `wakeDropped` fact at the moment it happens. */
const DROP_OUTCOMES: ReadonlySet<string> = new Set([
  'stopped',
  'overflow',
  'stale',
  'superseded',
  'error',
  'provider',
  'no-channel',
]);

/** A queue state before its first use, its leases held as `holder`. */
export function createWakeQueueState(holder: string): WakeQueueState {
  return {
    backend: null,
    loaded: false,
    oldIds: new Set(),
    claims: new Map(),
    running: new Set(),
    started: null,
    holder,
    released: false,
    sleep: { windows: [], pausedFrom: null, slept: 0 },
  };
}

// The in-memory databases of the inner lives built without a memory database, by data directory, for the process.
const FALLBACK = new Map<string, Handle>();

/** The lease of a claimed wake (`context.turnLeaseMs`, read now). */
function turnLeaseMs(life: InnerContext): number {
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
  const queue = life.wakes;
  if (queue.backend) return queue.backend;
  const service = life.memoryDb;
  if (typeof service?.memoryWrite === 'function' && typeof service.readHandle === 'function') {
    const write = service.memoryWrite.bind(service);
    const read = service.readHandle.bind(service);
    queue.backend = { read: () => handleOf(read()), write: async (update) => write(update) };
    return queue.backend;
  }
  const key = path.resolve(life.dataDir);
  let handle = FALLBACK.get(key);
  if (!handle) {
    handle = openMemoryDb(':memory:');
    FALLBACK.set(key, handle);
  }
  const fallback = handle;
  queue.backend = { read: () => fallback, write: (update) => Promise.resolve(applyWakeQueueWrite(fallback, update)) };
  return queue.backend;
}

/** The read connection of the queue's database, null while it is not open (deliveries.ts reads its rows there). */
export const readHandle = (life: InnerContext): Handle | null => backendOf(life).read();

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
function dbSend(life: InnerContext, update: WakeQueueUpdate): void {
  dbWrite(life, update).catch(() => {
    // Logged by the chain (dbWrite).
  });
}

/**
 * The wakes of stored rows, as the queue holds them: each payload with its row's id and kind, read the way a state
 * file's queue is (wake.ts#storedWakes renames the old fields); a row of an unknown kind is left out. The rows are
 * what the queue wrote, so a wake that passes the check has the rest of its shape.
 */
const wakesOfRows = (rows: ReadonlyArray<StoredWake>): Array<Wake> =>
  storedWakes(
    rows.map((row) => ({ ...row.payload, id: row.id, kind: row.kind })),
    WAKE_KINDS
  ) as Array<Wake>;

/** The handled entry of a stored row: when, the outcome, and an attend wake's place. */
function handledOfRow(row: StoredWake): Handled {
  const place = Object.hasOwn(row.payload, 'place') ? row.payload.place : row.payload.placeId;
  return {
    at: row.handledAt ?? row.queuedAt,
    outcome: row.outcome ?? row.state,
    ...(row.kind === 'attend' ? { place: typeof place === 'string' ? place : null } : {}),
  };
}

/**
 * The view read back from `wakes` once (queue.ts#stateOf calls it): the queued and running wakes, and the handled and
 * slept ones since `keepSince`. A wake the state already held that the table lacks stays, and the start handles it.
 */
export function loadQueue(life: InnerContext, state: InnerState, keepSince: number): void {
  const queue = life.wakes;
  if (queue.loaded) return;
  const read = backendOf(life).read();
  if (!read) return;
  queue.loaded = true;
  const rows = listWakes(read, { states: ['queued', 'running'] });
  const ids = new Set(rows.map((row) => row.id));
  state.queue = [...wakesOfRows(rows), ...state.queue.filter((wake) => !ids.has(wake.id))];
  queue.oldIds = new Set(state.queue.map((wake) => wake.id));
  const handled = listWakes(read, { states: ['handled', 'slept'], handledSince: keepSince });
  state.handled = { ...state.handled, ...Object.fromEntries(handled.map((row) => [row.id, handledOfRow(row)])) };
}

/** The handled entry of `wake` at `at` with `outcome`, an attend wake's place kept. */
const handledEntry = (wake: Wake, outcome: string, at: number): Handled => ({
  at,
  outcome,
  ...(wake.kind === 'attend' ? { place: wake.placeId ?? null } : {}),
});

/** Whether the wake `id` is handled or queued already. */
export function knownWake(life: InnerContext, id: string): boolean {
  const state = stateOf(life);
  return Boolean(state.handled[id]) || state.queue.some((queued) => queued.id === id);
}

/** The queued wakes of the place that no turn of this life runs. */
export function idleWakes(life: InnerContext): Array<Wake> {
  const { running } = life.wakes;
  return stateOf(life).queue.filter((wake) => inScope(life, wake) && !running.has(wake.id));
}

/** What the door's handler answers about a wake. */
export type WakeAnswer = { status: 'invalid' | 'stopped' | 'duplicate' | 'overflow' | 'queued' };

/** Whether `value` names a wake kind. */
const isWakeKind = (value: unknown): boolean => WAKE_KINDS.some((kind) => kind === value);

/**
 * The door's handler of `inner.wake`: the wake queued, unless it was handled already, is queued, the inner life is
 * stopped, or the queue is full (`overflow`, journalled and handled so it is never dropped unseen). Answers what
 * happened.
 */
export function admitWake(life: InnerContext, event: unknown): WakeAnswer {
  const { hot, now, log } = life;
  const given = objOf(event);
  const wake = objOf(given.wake);
  if (!given.wake || !isWakeKind(wake.kind)) return { status: 'invalid' };
  const state = stateOf(life);
  const id = String(given.id ?? wake.id);
  if (state.stopped) return { status: 'stopped' };
  if (knownWake(life, id)) return { status: 'duplicate' };
  const at = now();
  // The wake is the scheduler's own record (enqueueWake), handed back by the door.
  const queued = { ...contextOf(life, wake.placeId), ...wake, id, queuedAt: at } as Wake;
  if (state.queue.length >= innerSettings(hot.config).queueMax) {
    disposeWakes(life, [queued], 'overflow', at);
    save(life);
    log.warn('inner: queue overflow', { id, kind: queued.kind, queued: state.queue.length });
    note(life, { event: 'overflow', wake: wakeFields(queued), queued: state.queue.length });
    return { status: 'overflow' };
  }
  state.queue.push(queued);
  save(life);
  dbSend(life, { kind: 'wake-queue', op: 'queue', wake: queued, now: at });
  log.info('inner: wake', { id, kind: queued.kind, dueAt: wake.dueAt ?? null });
  note(life, { event: 'wake', wake: wakeFields(queued), placeId: wake.dmChat ? null : wake.placeId });
  return { status: 'queued' };
}

/** `wake` handed to the door (or straight to admitWake without one). */
export async function enqueueWake(life: InnerContext, wake: Wake): Promise<unknown> {
  const { submit, now } = life;
  const event: InnerWakeEvent = { kind: 'inner.wake', at: now(), id: wake.id, wake };
  if (typeof submit === 'function') return submit(event);
  return { status: 'ok', result: admitWake(life, event) };
}

/** A wake the tick listed: slept when it fell due inside an interval she slept through, else handed to the door. */
export async function admitListed(life: InnerContext, wake: Wake): Promise<number> {
  if (sleptThrough(life, wake.dueAt)) {
    sleepWakes(life, [wake], life.now());
    return 0;
  }
  await enqueueWake(life, wake);
  return 1;
}

/** `wakes` taken off the queue without an outcome (an attend wake a newer burst replaced). */
export function withdrawWakes(life: InnerContext, wakes: ReadonlyArray<Wake>): void {
  const state = stateOf(life);
  state.queue = state.queue.filter((queued) => !wakes.includes(queued));
  for (const wake of wakes) dbSend(life, { kind: 'wake-queue', op: 'remove', id: wake.id });
}

/** Why a dropped wake was dropped: a sub-code, or one worked out per wake. */
export type DropWhy = string | null | ((wake: Wake) => string);

/**
 * `wakes` marked handled with `outcome` and taken off the queue; a claimed wake's row is completed by the turn's finish.
 * Every recurring intention they name advances to its next occurrence (the service's `advance`: `recurred` for one in
 * `named`, the ids her turn's calls named, else `missed`). A one-off, a waiting one and an occurrence she already
 * closed or moved are left as they are by the service. An outcome other than a run turn (DROP_OUTCOMES) is a
 * `wakeDropped` fact at once; `why` (a string, or a function of the wake) is its sub-code.
 */
export function disposeWakes(
  life: InnerContext,
  wakes: ReadonlyArray<Wake>,
  outcome: string,
  at: number,
  { named = null, why = null }: { named?: Set<string> | ReadonlyArray<unknown> | null; why?: DropWhy } = {}
): void {
  const { intentions } = life;
  const { claims } = life.wakes;
  const state = stateOf(life);
  for (const wake of wakes) {
    state.handled[wake.id] = handledEntry(wake, outcome, at);
    if (!claims.has(wake.id)) dbSend(life, { kind: 'wake-queue', op: 'handle', id: wake.id, outcome, now: at });
    if (DROP_OUTCOMES.has(outcome)) {
      const reason = typeof why === 'function' ? why(wake) : why;
      addFact(life, state, {
        at,
        ...wakeFact(life, wake, 'wakeDropped', outcome, typeof reason === 'string' && reason ? { why: reason } : {}),
      });
    }
  }
  const ids = new Set(wakes.map((wake) => wake.id));
  state.queue = state.queue.filter((wake) => !ids.has(wake.id));
  if (typeof intentions?.advance !== 'function') return;
  const touched: ReadonlySet<string> =
    named instanceof Set ? named : new Set(Array.isArray(named) ? named.map(String) : []);
  for (const id of new Set(wakes.flatMap((wake) => (Array.isArray(wake.intentionIds) ? wake.intentionIds : [])))) {
    const result = objOf(intentions.advance(id, { named: touched.has(String(id)) }));
    if (result.changed) {
      const intention = objOf(result.intention);
      note(life, {
        event: 'recurred',
        intentionId: String(id),
        code: objOf(listOf(intention.history).at(-1)).code ?? null,
        dueAt: intention.dueAt ?? null,
        outcome,
      });
    }
  }
}

/** The cap that holds a queued wake (`capped`), or none; true when it changed, and then its row is written. */
export function holdWake(life: InnerContext, wake: Wake, cap: string | null): boolean {
  if ((wake.capped ?? null) === cap) return false;
  if (cap === null) delete wake.capped;
  else wake.capped = cap;
  const { claims } = life.wakes;
  if (!claims.has(wake.id)) dbSend(life, { kind: 'wake-queue', op: 'payload', id: wake.id, wake });
  return true;
}

/** The retry fields of a failed turn's wakes still queued; the turn's finish releases them with these fields. */
export function retryWakes(life: InnerContext, wakes: ReadonlyArray<Wake>, fields: Partial<Wake>): void {
  const ids = new Set(wakes.map((wake) => wake.id));
  for (const wake of stateOf(life).queue.filter((queued) => ids.has(queued.id))) Object.assign(wake, fields);
}

/** The claim of a turn: the turn id its wakes run under and which attempt this is. */
export type TurnClaim = { turnId: string; attempt: number };

/**
 * The wakes of `group` claimed for one turn, all or none, before the turn asks the model: marked running in process,
 * each moved to `running` under a new grant of its lease for `context.turnLeaseMs`, and the turn's in-flight mark set
 * (`state.inflight`) with `where` it runs. A wake that ran before keeps the turn id of its first run. Null when the
 * claim was refused or the write failed (logged).
 */
export async function claimWakes(
  life: InnerContext,
  group: ReadonlyArray<Wake>,
  { at, kind, where }: { at: number; kind: string; where: Omit<TurnMark, 'kind'> }
): Promise<TurnClaim | null> {
  const { running, claims } = life.wakes;
  for (const wake of group) running.add(wake.id);
  let claim: Obj | null = null;
  try {
    claim = objOf(
      await dbWrite(life, {
        kind: 'wake-queue',
        op: 'claim-group',
        ids: group.map((wake) => wake.id),
        holder: life.wakes.holder,
        now: at,
        leaseMs: turnLeaseMs(life),
        turnId: `t-${life.uuid()}`,
        turn: { kind, ...where },
      })
    );
  } catch {
    // Logged by the chain (dbWrite).
  }
  if (claim?.ok !== true || typeof claim.turnId !== 'string') {
    if (claim) {
      const code = typeof claim.code === 'string' ? claim.code : 'error';
      life.log.warn('inner: wake claim refused', { code, wakes: group.length });
    }
    for (const wake of group) running.delete(wake.id);
    return null;
  }
  for (const [id, token] of Object.entries(objOf(claim.tokens))) claims.set(id, Number(token));
  stateOf(life).inflight = {
    turnId: claim.turnId,
    wakeIds: group.map((wake) => wake.id),
    kind,
    startedAt: at,
    ...contextOf(life, where.placeId),
    ...where,
  };
  return { turnId: claim.turnId, attempt: Number(claim.attempt) || 1 };
}

/** The turn of a claimed group is over: its wakes are no longer running in process and its in-flight mark goes. */
export function endRun(life: InnerContext, group: ReadonlyArray<Wake>): void {
  const { running } = life.wakes;
  for (const wake of group) running.delete(wake.id);
  stateOf(life).inflight = null;
}

/**
 * The end of a turn's claim: the wakes of `group` the turn disposed of are completed with their handled outcome, the
 * ones still queued (a retry, a held turn) are released with their fields, in one fenced write. The first completed
 * wake records the `deliveries` of the turn's held sends (deliveries.ts#deliveriesOf); with no wake completed they are
 * dropped, and the wake's next turn makes them again. Answers the keys of the deliveries the write committed. A
 * refusal (a newer holder took a lease over) is logged and commits none.
 */
export async function finishWakes(
  life: InnerContext,
  group: ReadonlyArray<Wake>,
  deliveries: ReadonlyArray<DeliveryInput> = []
): Promise<Array<string>> {
  const state = stateOf(life);
  const { handled } = state;
  const { claims } = life.wakes;
  const done: Array<{ id: string; token: number; outcome: string; deliveries: ReadonlyArray<DeliveryInput> }> = [];
  const back: Array<{ id: string; token: number; wake: Wake }> = [];
  for (const { id } of group) {
    const token = claims.get(id);
    if (token === undefined) continue;
    claims.delete(id);
    const queued = state.queue.find((wake) => wake.id === id);
    if (queued) back.push({ id, token, wake: queued });
    else
      done.push({
        id,
        token,
        outcome: handled[id]?.outcome ?? 'handled',
        deliveries: done.length === 0 ? deliveries : [],
      });
  }
  if (done.length === 0 && deliveries.length > 0)
    life.log.info('inner: held sends dropped with a retried turn', { sends: deliveries.length });
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
    if (answer.ok === true) return done.flatMap((item) => item.deliveries.map((delivery) => delivery.key));
    life.log.warn('inner: wake completion refused', { code: typeof answer.code === 'string' ? answer.code : 'error' });
  } catch {
    // Logged by the chain (dbWrite).
  }
  return [];
}

/** Whether `dueAt` fell inside an interval she slept through. */
function sleptThrough(life: InnerContext, dueAt: unknown): boolean {
  const { windows } = life.wakes.sleep;
  return typeof dueAt === 'number' && windows.some(([from, to]) => dueAt > from && dueAt <= to);
}

/**
 * `wakes` slept at `at`: handled in the view with the outcome `slept`, `slept` in the table, each intention they were
 * for told to the intention service, the count raised. No fact, no wake.
 */
export function sleepWakes(life: InnerContext, wakes: ReadonlyArray<Wake>, at: number): void {
  if (wakes.length === 0) return;
  const { intentions, log } = life;
  const state = stateOf(life);
  const ids = new Set(wakes.map((wake) => wake.id));
  for (const wake of wakes) {
    state.handled[wake.id] = handledEntry(wake, 'slept', at);
    dbSend(life, { kind: 'wake-queue', op: 'sleep', wake, now: at });
  }
  state.queue = state.queue.filter((wake) => !ids.has(wake.id));
  const owned = wakes.filter((wake) => wake.kind === 'intention_due' || wake.kind === 'errand_deadline');
  for (const id of new Set(owned.flatMap((wake) => wake.intentionIds))) {
    try {
      intentions?.sleep?.(id);
    } catch (err) {
      log.warn('inner: intention not marked slept', { intentionId: id, code: errorCode(err) });
    }
  }
  const { sleep } = life.wakes;
  sleep.slept += wakes.length;
  save(life);
  log.info('inner: slept', { wakes: wakes.length });
  note(life, { event: 'slept', wakes: wakes.map(wakeFields) });
}

/** How many wakes slept since this life started. */
export const sleptCount = ({ wakes }: InnerContext): number => wakes.sleep.slept;

/** What an operation of a cut-off turn is called in the `interrupted` fact. */
const opLabel = (op: Obj): string =>
  (op.name === 'skill'
    ? `skill ${asText(op.skill ?? '')}`
    : op.name === 'post' && op.text
      ? `post "${asText(op.text)}"`
      : asText(op.name ?? 'operation')
  ).trim();

/** Resolve the known journal effects of the cut-off turn `mark` and mark its wakes interrupted without running them. */
async function resolveCutOff(life: InnerContext, mark: Inflight): Promise<void> {
  const { journal, ready, now, log } = life;
  const state = stateOf(life);
  try {
    await ready();
  } catch (err) {
    log.warn('inner: journal reconciliation failed before an interrupted turn was resolved', {
      code: errorCode(err),
    });
  }
  let ops: Array<Obj> = [];
  if (typeof journal?.turnOperations === 'function') {
    try {
      const at = now();
      const read = await journal.turnOperations({
        turnId: mark.turnId,
        days: [...new Set([utcDay(mark.startedAt), utcDay(at)])],
        privateAccountId: mark.privateAccountId,
        ...(mark.iface === undefined ? {} : { iface: mark.iface }),
      });
      ops = listOf(read).map(objOf);
    } catch (err) {
      log.warn('inner: journal could not say what an interrupted turn did', { code: errorCode(err) });
    }
  }
  const done: Array<string> = [];
  for (const op of ops) {
    if (op.by !== 'persona' || op.dryRun || op.shadow) continue;
    if (op.phase === 'succeeded') done.push(opLabel(op));
    else if (op.phase === 'open' || (op.phase === 'unknown' && op.name !== 'post'))
      done.push(`${opLabel(op)} (unclear)`);
  }
  const ids = new Set(mark.wakeIds);
  const wakes = state.queue.filter((wake) => ids.has(wake.id));
  const at = now();
  state.inflight = null;
  if (wakes.length > 0) {
    disposeWakes(life, wakes, 'interrupted', at);
    if (done.length > 0)
      addFact(life, state, {
        at,
        kind: 'interrupted',
        ...contextOf(life, mark.placeId),
        wake: mark.kind,
        done: done.join('; '),
        placeId: mark.placeId,
        dmChat: mark.dmChat,
      });
  }
  save(life);
  log.warn('inner: a turn was cut off by a restart', {
    turnId: mark.turnId,
    wakes: wakes.length,
    done: done.length,
    rerun: false,
  });
  note(life, {
    event: 'interrupted',
    turnId: mark.turnId,
    wakes: wakes.map(wakeFields),
    done: done.length,
    handled: wakes.length > 0,
  });
}

/** The in-flight marks of the turns a restart cut off: the running wakes another holder left, by turn. */
function cutOffMarks(rows: ReadonlyArray<StoredWake>): Array<Inflight> {
  const marks = new Map<string, Inflight>();
  for (const row of rows) {
    const turnId = row.turnId ?? `t-unknown-${row.id}`;
    const known = marks.get(turnId);
    if (known) {
      known.wakeIds.push(row.id);
      continue;
    }
    marks.set(turnId, {
      turnId,
      wakeIds: [row.id],
      kind: row.turn?.kind || row.kind,
      startedAt: row.claimedAt ?? row.leaseExpiresAt ?? 0,
      placeId: row.turn?.placeId ?? null,
      dmChat: row.turn?.dmChat === true,
      privateAccountId: row.turn?.privateAccountId ?? null,
      ...(row.turn?.iface === undefined ? {} : { iface: row.turn.iface }),
    });
  }
  return [...marks.values()];
}

/** The start's recovery, run once (see the head of this file); a database that is not open yet is tried again. */
export function startUp(life: InnerContext): Promise<void> {
  const queue = life.wakes;
  if (queue.started) return queue.started;
  queue.started = startUpNow(life);
  return queue.started;
}

async function startUpNow(life: InnerContext): Promise<void> {
  const queue = life.wakes;
  const state = stateOf(life);
  const read = backendOf(life).read();
  if (!read || !queue.loaded) {
    queue.started = null;
    return;
  }
  const at = life.now();
  const alive = leaseOf(read, ALIVE_LEASE);
  const { windows } = queue.sleep;
  if (alive && alive.holder !== queue.holder && alive.renewedAt < at) windows.push([alive.renewedAt, at]);
  const cutOff = listWakes(read, { states: ['running'] }).filter(
    (row) => queue.oldIds.has(row.id) && row.leaseHolder !== queue.holder && !queue.running.has(row.id)
  );
  for (const mark of cutOffMarks(cutOff)) {
    state.inflight = mark;
    await resolveCutOff(life, mark);
  }
  await dbWrite(life, { kind: 'wake-queue', op: 'recover', now: at, ids: [...queue.oldIds] }).catch(() => null);
  for (const wake of state.queue) {
    if (queue.oldIds.has(wake.id)) state.handled[wake.id] = { at, outcome: 'interrupted' };
  }
  state.queue = state.queue.filter((wake) => !queue.oldIds.has(wake.id));
  save(life);
  // A handled id is kept as long as the state file kept it, so a due item never wakes her twice.
  dbSend(life, { kind: 'wake-queue', op: 'prune', before: at - HANDLED_KEEP_MS, dataDir: life.dataDir });
  renewAlive(life, at);
  // Held sends are settled before the first tick lists anything.
  await life.writes;
  await resumeDeliveries(life);
}

/** `core:alive` renewed by this life, until the core stops. */
function renewAlive(life: InnerContext, at: number): void {
  if (life.wakes.released) return;
  dbSend(life, { kind: 'wake-queue', op: 'alive', holder: life.wakes.holder, now: at, ttlMs: turnLeaseMs(life) });
}

/** The leases of the wakes this life's turns hold, kept on while they run (called at every tick). */
function renewClaims(life: InnerContext): void {
  const { claims } = life.wakes;
  if (claims.size === 0) return;
  const held = [...claims].map(([id, token]) => ({ id, token }));
  dbSend(life, { kind: 'wake-queue', op: 'renew', claims: held, now: life.now(), leaseMs: turnLeaseMs(life) });
}

/**
 * The clean stop's end of `core:alive`: the lease this life holds expires now, so the next start goes ahead at once.
 * Nothing renews it after. Waits for the queue's writes; a lease another holder took over is left alone.
 */
export async function releaseAlive(life: InnerContext): Promise<void> {
  life.wakes.released = true;
  await life.writes;
  const read = backendOf(life).read();
  const lease = read ? leaseOf(read, ALIVE_LEASE) : null;
  if (lease === null || lease.holder !== life.wakes.holder) return;
  await dbWrite(life, {
    kind: 'wake-queue',
    op: 'lease-release',
    name: ALIVE_LEASE,
    token: lease.token,
    now: life.now(),
  }).catch(() => null);
}

/**
 * What every tick does before it lists anything: the start's recovery (once), the leases of the running turns and
 * `core:alive` renewed, and the pause followed. True while the store is paused; the first tick after a resume sleeps
 * the queued wakes that fell due during the pause.
 */
export async function beforeTick(life: InnerContext): Promise<boolean> {
  await startUp(life);
  const at = life.now();
  renewClaims(life);
  renewAlive(life, at);
  const { sleep } = life.wakes;
  if (paused(life)) {
    if (sleep.pausedFrom === null) {
      const mark = storeStateOf(life)?.pausedAt;
      const since = typeof mark === 'string' ? Date.parse(mark) : Number.NaN;
      sleep.pausedFrom = Number.isFinite(since) && since <= at ? since : at;
    }
    return true;
  }
  if (sleep.pausedFrom !== null) {
    sleep.windows.push([sleep.pausedFrom, at]);
    sleep.pausedFrom = null;
    sleepWakes(
      life,
      idleWakes(life).filter((wake) => sleptThrough(life, wake.dueAt)),
      at
    );
  }
  return false;
}
