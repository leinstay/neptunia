// What the inner life does when it starts and while it sleeps. The start's recovery runs once per guild before the
// first tick lists anything: a turn a restart cut off (its wakes `running` under another holder) is resolved from the
// journal, then its wakes run again under their first turn id or are handled `interrupted`; the wakes that fell due
// while the core was down sleep; the handled wakes older than 30 days are deleted; the `core:alive` lease is renewed,
// as it is at every tick after, until a clean stop lets it go (`releaseAlive`); and the deliveries a completed wake left
// unsent are settled and sent (deliveries.ts#resumeDeliveries).
//
// Sleep (the owner's answer of 2026-10-27): a wake that fell due during a downtime or a pause is `slept` and never
// runs. The downtime runs from the last `core:alive` renewal to the start, a pause from its `pausedAt` (else the first
// paused tick) to the first tick after the resume. A wake listed late, after the interval it fell due in, sleeps too.
// For an intention the wake was for, the intention service's `sleep` cancels a one-off with a `sleptAt` mark and moves
// a recurring one past the occurrence that slept. Nothing about it becomes a fact or a wake; the status counts the
// wakes slept since the start. Called through src/behavior/inner.ts and src/behavior/inner/drain.ts.

import { DAY_MS, utcDay } from '../../time.js';
import { ALIVE_LEASE, leaseOf, listWakes } from '../../memory/db/wake-queue.ts';
import type { StoredWake } from '../../memory/db/wake-queue.ts';
import { errorCode as codeOf, listOf, objOf } from '../../tools/types.ts';
import type { Obj } from '../../tools/types.ts';
import { resumeDeliveries } from './deliveries.ts';
import { asText } from './facts.ts';
import { addFact, enqueue, markHandled, note, paused, save, stateOf, wakeFields } from './queue.ts';
import { backendOf, dbSend, dbWrite, renewClaims, turnLeaseMs } from './wake-store.ts';
import type { Inflight, InnerContext, Wake } from './types.ts';

/** How long a handled wake stays in the table: longer than an intention lives, as the state file kept it. */
const HANDLED_KEEP_MS = 30 * DAY_MS;

/** What an operation of a cut-off turn is called in the `interrupted` fact. */
const opLabel = (op: Obj): string =>
  (op.name === 'skill'
    ? `skill ${asText(op.skill ?? '')}`
    : op.name === 'post' && op.text
      ? `post "${asText(op.text)}"`
      : asText(op.name ?? 'operation')
  ).trim();

/**
 * An in-flight mark left behind by a process that died in a turn (`state.inflight`): resolved from the journal
 * once its start-up reconciliation is done. If any operation of that turn went out (a persona's post reconciled as
 * sent or a call that executed; one that may have run and cannot be told counts too), its wakes are handled, not run
 * again, and an `interrupted` fact tells her what was done; if nothing went out (or the journal cannot say), the mark
 * is cleared and the wakes run again as before. Never throws.
 */
export async function resolveInflight(life: InnerContext, guildId: string): Promise<void> {
  const { hot, journal, ready, now, log } = life;
  const state = stateOf(life, guildId);
  const mark = state.inflight;
  if (!mark) return;
  try {
    await ready();
  } catch (err) {
    log.warn('inner: journal reconciliation failed before an interrupted turn was resolved', {
      guildId,
      code: codeOf(err),
    });
  }
  let ops: Array<Obj> = [];
  if (objOf(objOf(hot.config).features).journal === true && typeof journal?.turnOperations === 'function') {
    try {
      const at = now();
      const read = await journal.turnOperations(guildId, {
        turnId: mark.turnId,
        days: [...new Set([utcDay(mark.startedAt), utcDay(at)])],
        privateUserId: mark.privateUserId,
      });
      ops = listOf(read).map(objOf);
    } catch (err) {
      log.warn('inner: journal could not say what an interrupted turn did', { guildId, code: codeOf(err) });
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
  if (done.length > 0 && wakes.length > 0) {
    markHandled(life, state, wakes, 'interrupted', at, {
      guildId,
      named: wakes.flatMap((wake) => listOf(wake.intentionIds)),
    });
    addFact(life, state, {
      at,
      kind: 'interrupted',
      wake: mark.kind,
      done: done.join('; '),
      channelId: mark.channelId,
      privateChat: mark.privateChat,
    });
  }
  save(life, guildId);
  log.warn('inner: a turn was cut off by a restart', {
    guildId,
    turnId: mark.turnId,
    wakes: wakes.length,
    done: done.length,
    rerun: !(done.length > 0 && wakes.length > 0),
  });
  note(life, guildId, {
    event: 'interrupted',
    turnId: mark.turnId,
    wakes: wakes.map(wakeFields),
    done: done.length,
    handled: done.length > 0 && wakes.length > 0,
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
      channelId: row.turn?.channelId ?? null,
      privateChat: row.turn?.privateChat === true,
      privateUserId: row.turn?.privateUserId ?? null,
    });
  }
  return [...marks.values()];
}

/** Whether `dueAt` fell inside an interval she slept through. */
export function sleptThrough(life: InnerContext, dueAt: unknown): boolean {
  return typeof dueAt === 'number' && life.sleep.windows.some(([from, to]) => dueAt > from && dueAt <= to);
}

/**
 * `wakes` slept at `at`: handled in the view with the outcome `slept`, `slept` in the table, each intention they were
 * for told to the intention service, the guild's count raised. No fact, no wake.
 */
export function markSlept(life: InnerContext, guildId: string, wakes: ReadonlyArray<Wake>, at: number): void {
  if (wakes.length === 0) return;
  const { intentions, log } = life;
  const state = stateOf(life, guildId);
  const ids = new Set(wakes.map((wake) => wake.id));
  for (const wake of wakes) {
    state.handled[wake.id] = {
      at,
      outcome: 'slept',
      ...(wake.kind === 'attend' ? { place: wake.channelId ?? null } : {}),
    };
    life.synced.get(guildId)?.delete(wake.id);
    dbSend(life, { kind: 'wake-queue', op: 'sleep', wake, now: at, community: guildId });
  }
  state.queue = state.queue.filter((wake) => !ids.has(wake.id));
  const owned = wakes.filter((wake) => wake.kind === 'intention_due' || wake.kind === 'errand_deadline');
  for (const id of new Set(owned.flatMap((wake) => wake.intentionIds))) {
    try {
      intentions?.sleep?.(guildId, id);
    } catch (err) {
      log.warn('inner: intention not marked slept', { guildId, intentionId: id, code: codeOf(err) });
    }
  }
  life.sleep.slept.set(guildId, (life.sleep.slept.get(guildId) ?? 0) + wakes.length);
  save(life, guildId);
  log.info('inner: slept', { guildId, wakes: wakes.length });
  note(life, guildId, { event: 'slept', wakes: wakes.map(wakeFields) });
}

/** The queued wakes of the guild (none a turn of this life runs) that fell due inside an interval she slept through. */
function sleepQueued(life: InnerContext, guildId: string, at: number): void {
  const state = stateOf(life, guildId);
  markSlept(
    life,
    guildId,
    state.queue.filter((wake) => !life.running.has(wake.id) && sleptThrough(life, wake.dueAt)),
    at
  );
}

/** The start's recovery (see the head of this file), run once per guild; a database not open yet is tried again. */
export function startUp(life: InnerContext, guildId: string): Promise<void> {
  const known = life.started.get(guildId);
  if (known) return known;
  const run = startUpNow(life, guildId);
  life.started.set(guildId, run);
  return run;
}

async function startUpNow(life: InnerContext, guildId: string): Promise<void> {
  const state = stateOf(life, guildId);
  const read = backendOf(life).read();
  if (!read || !life.viewLoaded.has(guildId)) {
    life.started.delete(guildId);
    return;
  }
  const at = life.now();
  const alive = leaseOf(read, ALIVE_LEASE);
  if (alive && alive.holder !== life.holder && alive.renewedAt < at) life.sleep.windows.push([alive.renewedAt, at]);
  const cutOff = listWakes(read, { community: guildId, states: ['running'] }).filter(
    (row) => row.leaseHolder !== life.holder && !life.running.has(row.id)
  );
  if (cutOff.length > 0) {
    await dbWrite(life, { kind: 'wake-queue', op: 'requeue', ids: cutOff.map((row) => row.id), now: at }).catch(
      () => null
    );
    for (const mark of cutOffMarks(cutOff)) {
      state.inflight = mark;
      await resolveInflight(life, guildId);
    }
  }
  sleepQueued(life, guildId, at);
  await dbWrite(life, { kind: 'wake-queue', op: 'recover', now: at }).catch(() => null);
  // A handled id is kept as long as the state file kept it (queue.ts, CHAIN_KEEP_MS), so a due item never wakes her twice.
  dbSend(life, { kind: 'wake-queue', op: 'prune', before: at - HANDLED_KEEP_MS, dataDir: life.dataDir });
  renewAlive(life, at);
  // What a completed wake left to send when the process stopped: settled and sent before the first tick lists anything.
  await life.writes;
  await resumeDeliveries(life);
}

/** `core:alive` renewed by this life, until the core stops. */
function renewAlive(life: InnerContext, at: number): void {
  if (life.released) return;
  dbSend(life, { kind: 'wake-queue', op: 'alive', holder: life.holder, now: at, ttlMs: turnLeaseMs(life) });
}

/**
 * The clean stop's end of `core:alive`: the lease this life holds expires now, so the next start goes ahead at once.
 * Nothing renews it after. Waits for the queue's writes; a lease another holder took over is left alone.
 */
export async function releaseAlive(life: InnerContext): Promise<void> {
  life.released = true;
  await life.writes;
  const read = backendOf(life).read();
  const lease = read ? leaseOf(read, ALIVE_LEASE) : null;
  if (lease === null || lease.holder !== life.holder) return;
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
export async function beforeTick(life: InnerContext, guildId: string): Promise<boolean> {
  await startUp(life, guildId);
  const at = life.now();
  renewClaims(life);
  renewAlive(life, at);
  if (paused(life)) {
    if (life.sleep.pausedFrom === null) {
      const mark = life.store?.state?.data?.pausedAt;
      const since = typeof mark === 'string' ? Date.parse(mark) : Number.NaN;
      life.sleep.pausedFrom = Number.isFinite(since) && since <= at ? since : at;
    }
    return true;
  }
  if (life.sleep.pausedFrom !== null) {
    life.sleep.windows.push([life.sleep.pausedFrom, at]);
    life.sleep.pausedFrom = null;
    sleepQueued(life, guildId, at);
  }
  return false;
}

/** A wake the tick listed: slept when it fell due inside an interval she slept through, else handed to the door. */
export async function admitListed(life: InnerContext, guildId: string, wake: Wake): Promise<number> {
  if (sleptThrough(life, wake.dueAt)) {
    markSlept(life, guildId, [wake], life.now());
    return 0;
  }
  await enqueue(life, guildId, wake);
  return 1;
}

/** How many wakes of the guild slept since this life started. */
export const sleptCount = (life: InnerContext, guildId: string): number => life.sleep.slept.get(guildId) ?? 0;
