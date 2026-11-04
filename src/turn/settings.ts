// The settings a turn reads from the live config at the moment of use: the pace of its preparation (`pace`), the
// bounds of its tool loop (`tools.loop`, `wakes.loop`, `selfreflection.loop`), whether her own tools replace the
// classifiers, and how much of a skill result a follow-up request carries. src/behavior/turn.ts reads them per turn;
// the tests and scripts/replay.ts read them through its re-exports.

import { setSettings } from '../behavior/diary.ts';
import { innerSettings } from '../behavior/inner/settings.ts';
import { RECALL_DEFAULTS, recallSettings } from '../behavior/recall.ts';
import { isPositive, objOf } from '../tools/types.ts';
import { HEARTBEAT_INTENT_SKILLS } from '../tools/wake-tools.ts';

/** `pace` when a key is missing: config.json's values. */
const PACE_FALLBACK = Object.freeze({
  prepareMs: 6000,
  prepareSearchMs: 18000,
  prepareMediaMs: 20000,
  dropAfterMs: 120000,
  replyHedgeMs: 30000,
  settleMs: 3000,
  settleMaxMs: 8000,
});

/** The longest single pause of a settle wait: the author's activity is read again after it. */
export const SETTLE_STEP_MS = 250;

export type PaceSettings = {
  prepareMs: number | null;
  prepareSearchMs: number | null;
  prepareMediaMs: number | null;
  dropAfterMs: number | null;
  replyHedgeMs: number | null;
  settleMs: number;
  settleMaxMs: number | null;
};

/**
 * The pace of a turn's preparation, read from `config` (the live config):
 * `prepareMs`, how long everything before the reply request may take, counted
 * from the turn's start; `prepareSearchMs`, the longer limit once the search
 * classifier asked for a web or server search (never shorter than
 * `prepareMs`), and the longest the turn waits past `prepareMs` for that
 * classifier's verdict (null: no wait; it stops at once on a verdict asking
 * for no search); `prepareMediaMs`, the longer limit of a direct call whose own
 * message (or the message it replies to) brought a picture, a GIF or a video
 * the turn describes or watches (never shorter than `prepareMs`; with both,
 * the larger of the two; null = no such extension); `dropAfterMs`, the bar a
 * turn's answer must be in hand by,
 * counted from the turn's start, past which the turn is dropped unposted;
 * `replyHedgeMs`, how long the reply request of a turn with a bar is given
 * before a second, identical one is sent (the first answer wins);
 * each a positive number of milliseconds, or null -- no deadline, wait for
 * everything; no bar; no second request -- for 0, a negative value or a
 * non-number. A missing key takes config.json's value. A turn nobody waits for (src/turn/triggers.ts#unhurried)
 * gets neither the deadline nor the bar: it waits for every stage and posts once ready. `settleMs`: how long the author of a turn answering a person must have
 * been quiet before the turn reads the channel (0 = no wait, also for a negative value or a
 * non-number); `settleMaxMs`: the longest that wait runs, counted from the author's trigger
 * message (null for 0, a negative value or a non-number: one settle from it). A missing key
 * takes config.json's value.
 */
export function paceSettings(config: unknown): PaceSettings {
  const pace = objOf(objOf(config).pace);
  const limit = (value: unknown, fallback: number): number | null => {
    if (value === undefined) return fallback;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  };
  return {
    prepareMs: limit(pace.prepareMs, PACE_FALLBACK.prepareMs),
    prepareSearchMs: limit(pace.prepareSearchMs, PACE_FALLBACK.prepareSearchMs),
    prepareMediaMs: limit(pace.prepareMediaMs, PACE_FALLBACK.prepareMediaMs),
    dropAfterMs: limit(pace.dropAfterMs, PACE_FALLBACK.dropAfterMs),
    replyHedgeMs: limit(pace.replyHedgeMs, PACE_FALLBACK.replyHedgeMs),
    settleMs: limit(pace.settleMs, PACE_FALLBACK.settleMs) ?? 0,
    settleMaxMs: limit(pace.settleMaxMs, PACE_FALLBACK.settleMaxMs),
  };
}

/** tools.loop's values when a key is missing (config.json's). */
const LOOP_FALLBACK = Object.freeze({ maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4, stepReserveTokens: 6000 });
/** `selfreflection.loop`'s values when a key is missing (config.json's). */
const DIARY_LOOP_FALLBACK = Object.freeze({ maxSteps: 2, timeBudgetMs: 600000 });
/** The least time one call of the tool loop gets, whatever is left of its budget. */
export const LOOP_MIN_CALL_MS = 2000;
/**
 * The terminal actions of an inner turn (docs/inner-life.md): the one call its last loop step
 * still runs -- a post, or a change of an intention of hers. A read or any other skill on the
 * last step is dropped as on every turn.
 */
export const INNER_TERMINAL_SKILLS = Object.freeze(['message.create', ...HEARTBEAT_INTENT_SKILLS]);
/** An inner turn's loop end state when no tool loop ran (`inner.loop`). */
export const NO_LOOP = Object.freeze({ steps: 0, cut: null, droppedCalls: 0 });
/** Why a call of a step did not run (`loop-cap`): too many in one answer, or the steps, the time or the room spent. For the journal and the log. */
export const LOOP_WHY = Object.freeze({ extraCall: 'extra-call', steps: 'steps', time: 'time', tokens: 'tokens' });
/** The intention calls of an inner turn that name an intention (`id`, or the id alone in the body). */
export const INTENT_ID_SKILLS = Object.freeze(['intention.update', 'intention.cancel']);

export type LoopSettings = {
  maxSteps: number;
  timeBudgetMs: number;
  maxCallsPerStep: number;
  callTimeoutMs?: number;
  stepReserveTokens?: number;
};

/** Whether `value` is a whole number of at least 1. */
const isWholeStep = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1;

/**
 * The tool loop's bounds under `config` (`tools.loop`, read by the caller now): `maxSteps`, the
 * most follow-up requests after her calls in one turn (a whole number of at least 1);
 * `timeBudgetMs`, how long the loop may run from its first call before the next request is
 * her last (a positive number); `maxCallsPerStep`, the most calls of one answer that run (a
 * whole number of at least 1; the rest are dropped and logged). A missing or unusable value
 * takes config.json's. An inner turn (`inner`: mode `inner`, docs/inner-life.md) has its own
 * bounds, `wakes.loop` (src/behavior/inner.ts#innerSettings; nobody waits for it, so its
 * budget is generous): the same three, plus `callTimeoutMs`, the most one call of hers may run. A diary
 * post (`diary`) has `selfreflection.loop`, and its calls per step are `selfreflection.set.pictures[1]`.
 * `tools.loop` never
 * reaches an inner turn, `wakes.loop` never an ordinary one. Pure.
 */
export function loopSettings(
  config: unknown,
  { inner = false, diary = false }: { inner?: boolean; diary?: boolean } = {}
): LoopSettings {
  if (inner) return { ...innerSettings(config).loop };
  // A diary post (`selfreflection.loop`): two requests at most, a long budget (a picture takes its time); a step takes
  // as many calls as a set has pictures at most (`selfreflection.set.pictures[1]`, a constant of the config cut).
  const root = objOf(config);
  if (diary) {
    const raw = objOf(objOf(root.selfreflection).loop);
    return {
      maxSteps: isWholeStep(raw.maxSteps) ? raw.maxSteps : DIARY_LOOP_FALLBACK.maxSteps,
      timeBudgetMs: isPositive(raw.timeBudgetMs) ? raw.timeBudgetMs : DIARY_LOOP_FALLBACK.timeBudgetMs,
      maxCallsPerStep: setSettings(root.selfreflection).pictures[1],
    };
  }
  const loop = objOf(objOf(root.tools).loop);
  const whole = (value: unknown, fallback: number): number => (isWholeStep(value) ? value : fallback);
  return {
    maxSteps: whole(loop.maxSteps, LOOP_FALLBACK.maxSteps),
    timeBudgetMs: isPositive(loop.timeBudgetMs) ? loop.timeBudgetMs : LOOP_FALLBACK.timeBudgetMs,
    maxCallsPerStep: whole(loop.maxCallsPerStep, LOOP_FALLBACK.maxCallsPerStep),
    stepReserveTokens: whole(loop.stepReserveTokens, LOOP_FALLBACK.stepReserveTokens),
  };
}

/** The parts of the live config resultCharsFor reads. */
type ResultCharsConfig = { tools?: { resultMaxChars?: number } } & Record<string, unknown>;

/**
 * The most characters of a skill result's data the follow-up request carries, read from `config`: a
 * memory.search result is cut by the tool itself, window by window, at `recall.quoteMaxChars`, and
 * is bounded there; every other result at `tools.resultMaxChars`.
 */
export function resultCharsFor(result: { skill?: unknown } | null | undefined, config: ResultCharsConfig): number {
  if (result?.skill === 'memory.search' || result?.skill === 'conversation.read')
    return recallSettings(config)?.quoteMaxChars ?? RECALL_DEFAULTS.quoteMaxChars;
  return config?.tools?.resultMaxChars ?? 4500;
}
