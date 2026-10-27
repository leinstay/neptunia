// The turn an errand's end opens: when a task of the persona's finishes (src/errands/service.js
// calls `onFinished`), she gets a turn of her own in the conversation it was asked in, the way
// the missed-answer recovery opens one (src/behavior/missed.js): through the turn runner's one
// attention (a turn running anywhere holds it back; mention.oneAtATime), a cooldown per
// conversation between two such turns (`errands.resultCooldownSeconds`), and she may answer with
// silence. The turn's trigger is the message the errand was asked in (her answer replies to it),
// else -- a slash command, or a message gone since -- an interjection; its kind is `errand`, its
// requester the person who asked, and its request carries the `<errand_result>` block
// (src/errands/blocks.js). A turn held back is retried every `errands.resultRetrySeconds`, at
// most RESULT_ATTEMPTS times, then left for her `<errands>` block (marked `resultTurnFailed`, so
// the line says the turn never ran); a turn that failed on its own (`error`, `refused`, or any
// outcome but spoke and skip) is retried the same way. Only a turn that spoke or chose silence
// marks the task seen and read (`readAt`: its `<errand_result>` was in front of her); a task not
// read stays in her `<errands>` block until `errand.read` or `errand.resolve`. Settings are read at the moment of
// use; logs carry ids and outcomes, never a goal or a result. An errand's end reaches this module
// as an `errand.done` event through the core's event door (src/interface/door.js): the service
// calls `errandDoneEvent(task, guildId)` and submits it, the door's handler is `onEvent`; the
// task itself rides along in-process under `raw.task` (the event holds its id and status), and
// when it does not, the task store of the event's guild is asked for it. Before the result turn,
// the end reaches the persona's intentions waiting on that errand (`intentions.onTaskFinished`,
// src/intentions/service.js), so the turn already shows them back to pending with the outcome.

import { log as defaultLog } from '../log.js';
import { lineOf } from '../behavior/line-of.js';

/** `errands.resultRetrySeconds` and `errands.resultCooldownSeconds` when missing (config.json carries the same). */
export const DEFAULT_RETRY_SECONDS = 30;
export const DEFAULT_COOLDOWN_SECONDS = 60;
/** How many times a result turn is tried before the task is left to the `<errands>` block. */
export const RESULT_ATTEMPTS = 20;

/**
 * The `errand.done` event of a finished task (src/protocol/events.js): the whole task
 * rides along as `raw.task`, which validation never reads. Its id is left to the door (task and
 * status), so a second delivery of the same end is the same event.
 * @param {{ id: string, state: string }} task
 * @param {string|null} [guildId]
 * @param {() => number} [now]
 */
export function errandDoneEvent(task, guildId = null, now = Date.now) {
  return {
    kind: 'errand.done',
    at: now(),
    communityId: guildId ?? null,
    errandId: task.id,
    status: task.state,
    raw: { task },
  };
}

/** The outcomes that mean the turn never ran: try again later. */
const HELD = new Set(['busy', 'paused']);
/** The outcomes that mean her turn ran and she saw the result. */
const DONE = new Set(['spoke', 'skip']);

/**
 * @param {object} options
 * @param {{ config: object }} options.hot
 * @param {import('../interface/reads.ts').Reads} options.reads  The core's reads of the interface: the conversation a
 *   result answers in and the message it was asked in.
 * @param {() => string} [options.iface]  The interface the conversations belong to (from `hello`).
 * @param {{ runTurn: Function, isBusy?: Function, isAnyBusy?: Function }} options.turns
 * @param {{ markSeen: Function, markRead?: Function, markResultFailed?: Function }} options.errands
 * @param {{ onTaskFinished: Function }|null} [options.intentions]  The intention service: an errand's
 *   end moves the intentions waiting on it first (idempotent; never throws).
 * @param {() => string|null} [options.getGuildId]
 * @param {() => number} [options.now]
 * @param {(fn: Function, ms: number) => unknown} [options.setTimer]
 * @param {{ info: Function, warn: Function }} [options.log]
 */
export function createTaskTurns({
  hot,
  reads,
  iface = () => '',
  turns,
  errands,
  intentions = null,
  getGuildId = () => null,
  now = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  log = defaultLog,
}) {
  // conversation id -> when its last result turn started
  const lastAt = new Map();
  // task id -> pending timer, while a result waits for its turn
  const waiting = new Map();

  function seconds(key, fallback) {
    const value = hot.config?.errands?.[key];
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  /** Whether a turn would find the attention taken in `channelId` now (the rule runTurn applies). */
  function attentionTaken(channelId) {
    if (typeof turns?.isBusy === 'function' && turns.isBusy(channelId)) return true;
    return hot.config?.mention?.oneAtATime !== false && typeof turns?.isAnyBusy === 'function' && turns.isAnyBusy();
  }

  /** Try `task` again in `ms`, unless it ran out of attempts. */
  function later(task, guildId, attempt, ms) {
    if (attempt + 1 >= RESULT_ATTEMPTS) {
      log.info('errands: result left to the tasks block', { id: task.id, attempts: attempt + 1 });
      try {
        errands?.markResultFailed?.({ guildId, ids: [task.id] });
      } catch (err) {
        log.warn('errands: result failure not noted', { id: task.id, error: err });
      }
      return;
    }
    const timer = setTimer(
      () => {
        waiting.delete(task.id);
        deliver(task, guildId, attempt + 1).catch((err) =>
          log.warn('errands: result turn failed', { id: task.id, error: err })
        );
      },
      Math.max(0, ms)
    );
    timer?.unref?.();
    waiting.set(task.id, timer);
  }

  /** The message the errand was asked in, as a line (a turn's trigger), or null. */
  /** @param {import('../protocol/adapter.ts').ConversationRef} ref */
  async function originMessage(ref, task) {
    const messageId = task.origin?.messageId;
    if (!messageId) return null;
    const found = await reads.fetchMessages(ref, [messageId]);
    const event = found?.messages[0]?.event;
    return event === undefined ? null : lineOf(event);
  }

  /** One attempt at the result turn of `task`. */
  async function deliver(task, guildId, attempt = 0) {
    const channelId = task.origin?.channelId;
    if (!channelId) {
      log.info('errands: result without a conversation', { id: task.id });
      return null;
    }
    const cooldownMs = seconds('resultCooldownSeconds', DEFAULT_COOLDOWN_SECONDS) * 1000;
    const last = lastAt.get(channelId);
    if (Number.isFinite(last) && now() - last < cooldownMs) {
      later(task, guildId, attempt, last + cooldownMs - now());
      return null;
    }
    const retryMs = seconds('resultRetrySeconds', DEFAULT_RETRY_SECONDS) * 1000;
    if (attentionTaken(channelId)) {
      later(task, guildId, attempt, retryMs);
      return null;
    }
    const conversation = { iface: iface(), conversationId: String(channelId) };
    const known = await reads.conversationInfo(conversation);
    if (known === null) {
      log.warn('errands: result conversation unavailable', { id: task.id, channelId });
      return null;
    }
    const trigger = await originMessage(conversation, task);
    const requester = task.requester?.userId ? { id: task.requester.userId } : null;
    lastAt.set(channelId, now());
    let result;
    try {
      result = await turns.runTurn({
        conversation,
        guildId: guildId ?? getGuildId?.() ?? null,
        mode: trigger ? 'reply' : 'interject',
        trigger,
        triggerKind: 'errand',
        taskResult: task,
        ...(requester ? { requester } : {}),
      });
    } catch (err) {
      log.error('errands: result turn failed', { id: task.id, channelId, error: err });
      result = { outcome: 'error' };
    }
    const outcome = result?.outcome ?? 'error';
    if (result?.dryRun === true) {
      log.info('errands: result turn', { id: task.id, channelId, outcome, dryRun: true });
      return result;
    }
    if (!DONE.has(outcome)) {
      // Held back, or failed on its own: the result is still unread, so the turn is tried again.
      lastAt.delete(channelId);
      later(task, guildId, attempt, retryMs);
      if (!HELD.has(outcome)) log.warn('errands: result turn not completed', { id: task.id, channelId, outcome });
      return result;
    }
    errands?.markSeen?.({ guildId, ids: [task.id] });
    errands?.markRead?.({ guildId, ids: [task.id] });
    log.info('errands: result turn', { id: task.id, channelId, outcome, ...(trigger ? {} : { interject: true }) });
    return result;
  }

  /** The service's `onFinished`: the result turn of `task` (never throws). */
  function onFinished(task, guildId) {
    return deliver(task, guildId, 0).catch((err) => {
      log.warn('errands: result turn failed', { id: task?.id, error: err });
      return null;
    });
  }

  /**
   * The door's handler of `errand.done`: the intentions waiting on the task the event names
   * moved first, then its result turn (never throws); null when the task cannot be found.
   * @param {ReturnType<typeof errandDoneEvent>} event
   */
  function onEvent(event) {
    const guildId = event?.communityId ?? null;
    const task = event?.raw?.task ?? errands?.store?.(guildId)?.get?.(event?.errandId) ?? null;
    if (!task) {
      log.warn('errands: finished task not found', { id: event?.errandId ?? null });
      return Promise.resolve(null);
    }
    try {
      intentions?.onTaskFinished?.(task, guildId);
    } catch (err) {
      log.warn('errands: intentions not reached', { id: task.id, error: err });
    }
    return onFinished(task, guildId);
  }

  /** Every result still waiting dropped (shutdown). */
  function stop() {
    for (const timer of waiting.values()) clearTimeout(timer);
    waiting.clear();
  }

  return { onFinished, onEvent, stop };
}
