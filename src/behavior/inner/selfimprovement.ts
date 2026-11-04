// The `selfimprovement` wake: on `selfimprovement.schedule` (by default once a day, after the watcher's run),
// and with a cause when one chain shape fails
// `selfimprovement.failuresPerShape` times in a UTC day, at most one such cause a day. Its turn carries
// the facts of src/behavior/selfimprovement-view.ts, and her answer is `board.propose`. The clock is
// `state.selfimprovement = { lastAt, raisedAt, schedule }`: `schedule` is what the clock counts for, `lastAt` moves when a wake's completion committed (and the outbox rows
// it showed are marked delivered), `raisedAt` when a failure cause raised a wake. The tick (src/behavior/inner.ts) asks
// `selfimprovementDue`; the drain (src/behavior/inner/drain.ts) asks `selfimprovementFacts` for its turn and
// `committedSelfimprovement` once the turn committed. `scheduledWake` and `failureCause` are the rules, pure. The facts
// carry the newest watcher report the source gives for the wake's time (src/watcher/news.ts).

import { evaluateSchedule, formatSchedule } from '../../service/schedule.ts';
import type { ServiceSchedule } from '../../service/schedule.ts';
import { DAY_MS, utcDay } from '../../time.ts';
import { errorCode, isFiniteNumber } from '../../tools/types.ts';
import { buildSelfimprovementFacts, chainsOfJournal, readJournalLines, shapesOf } from '../selfimprovement-view.ts';
import type { Chain, SelfimprovementFacts } from '../selfimprovement-view.ts';
import { save, stateOf } from './queue.ts';
import type { InnerContext, InnerSettings, Wake } from './types.ts';

/** The selfimprovement wake due at `at` (its own chain, no place). */
export function selfimprovementWake(at: number, reason: string): Wake {
  return {
    id: `inner.wake:selfimprovement:${at}`,
    kind: 'selfimprovement',
    reason,
    intentionIds: [],
    chainId: `selfimprovement:${at}`,
    dueAt: at,
    channelId: null,
    privateChat: false,
  };
}

/**
 * The wake `schedule` owes at `now`, whose `dueAt` (and so its id) is the newest slot since `lastAt`, reason `daily`.
 * Downtime is sleep: a calendar slot of an earlier UTC day is no longer owed. Null while `lastAt` is unknown or nothing
 * is due.
 */
export function scheduledWake(input: { now: number; schedule: ServiceSchedule; lastAt: number | null }): Wake | null {
  const { now, schedule, lastAt } = input;
  const { due } = evaluateSchedule({ schedule, enabled: true, now, last: lastAt });
  if (due === null || (schedule.kind === 'at' && utcDay(due) !== utcDay(now))) return null;
  return selfimprovementWake(due, 'daily');
}

/**
 * The chain shape with the most failed chains on the UTC day of `now`, when it has at least `threshold`; null when none
 * has, or when a cause was already raised that day (`raisedAt`).
 */
export function failureCause(input: {
  chains: ReadonlyArray<Chain>;
  now: number;
  threshold: number;
  raisedAt: number | null;
}): { key: string; failures: number } | null {
  const { chains, now, threshold, raisedAt } = input;
  if (raisedAt !== null && utcDay(raisedAt) === utcDay(now)) return null;
  const today = chains.filter((chain) => utcDay(chain.at) === utcDay(now));
  const [worst] = shapesOf(today, { shown: Number.MAX_SAFE_INTEGER })
    .shapes.filter((shape) => shape.failures >= threshold)
    .sort((a, b) => b.failures - a.failures || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return worst === undefined ? null : { key: worst.key, failures: worst.failures };
}

/** The journal as the view reads it: its `read`, or none when this life has no journal that reads. */
function journalOf(
  life: InnerContext
): { read(guildId: string, query: { day: string; kind: string; n: number }): unknown } | null {
  const { journal } = life;
  return typeof journal?.read === 'function' ? { read: (guildId, query) => journal.read?.(guildId, query) } : null;
}

/**
 * The wakes this tick owes: nothing while `selfimprovement.enabled` is false, nothing on the first tick (it only starts
 * the clock, so a fresh install's first wake is the next slot), the scheduled wake once its slot has come, else the wake
 * of a failure cause found in the day's chains. A schedule the owner changed starts the clock again, so a slot of the
 * new schedule that already passed owes nothing. Never throws.
 */
export async function selfimprovementDue(
  life: InnerContext,
  guildId: string,
  settings: InnerSettings,
  at: number
): Promise<Array<Wake>> {
  if (!settings.selfimprovement.enabled) return [];
  const { schedule, failuresPerShape } = settings.wakes.selfimprovement;
  const counted = formatSchedule(schedule);
  const state = stateOf(life, guildId);
  if (state.selfimprovement === null) {
    state.selfimprovement = { lastAt: at, raisedAt: null, schedule: counted };
    save(life, guildId);
    return [];
  }
  if (state.selfimprovement.schedule !== counted) {
    const isChanged = state.selfimprovement.schedule !== undefined;
    const lastAt = isChanged ? at : state.selfimprovement.lastAt;
    state.selfimprovement = { ...state.selfimprovement, lastAt, schedule: counted };
    save(life, guildId);
  }
  const scheduled = scheduledWake({ now: at, schedule, lastAt: state.selfimprovement.lastAt });
  if (scheduled !== null) return [scheduled];
  try {
    const lines = await readJournalLines(
      journalOf(life),
      guildId,
      { from: Date.parse(`${utcDay(at)}T00:00:00Z`), to: at },
      ['action', 'inner']
    );
    const cause = failureCause({
      chains: chainsOfJournal(lines),
      now: at,
      threshold: failuresPerShape,
      raisedAt: state.selfimprovement.raisedAt,
    });
    if (cause === null) return [];
    state.selfimprovement = { ...state.selfimprovement, raisedAt: at };
    save(life, guildId);
    life.log.info('inner: selfimprovement cause', { guildId, failures: cause.failures });
    return [selfimprovementWake(at, `failures:${cause.key}`)];
  } catch (error) {
    life.log.warn('inner: selfimprovement check failed', { guildId, code: errorCode(error) });
    return [];
  }
}

/** The facts of the wake's turn and the outbox rows they show, from the sources this life was given. Never throws. */
export async function selfimprovementFacts(
  life: InnerContext,
  guildId: string,
  at: number
): Promise<SelfimprovementFacts | null> {
  const { selfimprovementSources: sources, log } = life;
  const state = stateOf(life, guildId);
  const guarded = <TValue>(fn: () => TValue | undefined, fallback: TValue): TValue => {
    try {
      return fn() ?? fallback;
    } catch (error) {
      log.warn('inner: selfimprovement source failed', { guildId, code: errorCode(error) });
      return fallback;
    }
  };
  try {
    const board = sources.proposals
      ? await sources.proposals().catch((error: unknown) => {
          log.warn('inner: selfimprovement board failed', { guildId, code: errorCode(error) });
          return { entries: [], outbox: [] };
        })
      : { entries: [], outbox: [] };
    const days = 14;
    const landed = await Promise.resolve(sources.landed?.()).catch((error: unknown) => {
      log.warn('inner: selfimprovement landed failed', { guildId, code: errorCode(error) });
      return [];
    });
    return await buildSelfimprovementFacts({
      guildId,
      now: at,
      since: state.selfimprovement?.lastAt ?? null,
      days,
      journal: journalOf(life),
      granted: guarded(() => sources.granted?.(), []),
      skills: guarded(() => sources.skills?.(at - days * DAY_MS), []),
      proposals: board.entries,
      outbox: board.outbox,
      landed: landed ?? [],
      watcher: guarded(() => sources.watcher?.(at), null),
    });
  } catch (error) {
    log.warn('inner: selfimprovement view failed', { guildId, code: errorCode(error) });
    return null;
  }
}

/**
 * Once a selfimprovement turn's completion committed (its outcome is not an error): the wake's time is the last one,
 * and the outbox rows its view showed are marked delivered. A failing mark is logged and leaves the rows for the next
 * wake. Does nothing for a turn of another kind. Never throws.
 */
export async function committedSelfimprovement(
  life: InnerContext,
  guildId: string,
  turn: { wake: Wake | null; facts: SelfimprovementFacts | null; outcome: unknown }
): Promise<void> {
  const { wake, facts, outcome } = turn;
  if (wake === null || outcome === 'error') return;
  const state = stateOf(life, guildId);
  const at = isFiniteNumber(wake.dueAt) ? wake.dueAt : life.now();
  state.selfimprovement = { ...state.selfimprovement, lastAt: at, raisedAt: state.selfimprovement?.raisedAt ?? null };
  save(life, guildId);
  const seqs = facts?.outboxSeqs ?? [];
  if (seqs.length === 0 || !life.selfimprovementSources.ackOutbox) return;
  try {
    await life.selfimprovementSources.ackOutbox(seqs);
  } catch (error) {
    life.log.warn('inner: selfimprovement outbox not marked', { guildId, count: seqs.length, code: errorCode(error) });
  }
}
