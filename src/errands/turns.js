// The turn an errand's end opens: when a task of the persona's finishes (src/errands/service.js
// calls `onFinished`), she gets a turn of her own in the conversation it was asked in, the way
// the missed-answer recovery opens one (src/behavior/missed.js): through the turn runner's one
// attention (a turn running anywhere holds it back; mention.oneAtATime), a cooldown per
// conversation between two such turns (`agents.resultCooldownSeconds`), and she may answer with
// silence. The turn's trigger is the message the errand was asked in (her answer replies to it),
// else -- a slash command, or a message gone since -- an interjection; its kind is `task`, its
// requester the person who asked, and its request carries the `<task_result>` block
// (src/errands/blocks.js). A turn held back is retried every `agents.resultRetrySeconds`, at
// most RESULT_ATTEMPTS times, then left for her `<tasks>` block; once a turn ran (spoke, chose
// silence, or failed on its own) the task is marked seen. Settings are read at the moment of
// use; logs carry ids and outcomes, never a goal or a result.

import { log as defaultLog } from '../log.js';

/** `agents.resultRetrySeconds` and `agents.resultCooldownSeconds` when missing (config.json carries the same). */
export const DEFAULT_RETRY_SECONDS = 30;
export const DEFAULT_COOLDOWN_SECONDS = 60;
/** How many times a result turn is tried before the task is left to the `<tasks>` block. */
export const RESULT_ATTEMPTS = 20;

/** The outcomes that mean the turn never ran: try again later. */
const HELD = new Set(['busy', 'paused']);

/**
 * @param {object} options
 * @param {{ config: object }} options.hot
 * @param {object} options.client  discord.js-shaped: `channels.fetch(id)`, `user.id`.
 * @param {object} options.discord  The Discord interface's capabilities object (src/index.js injects it): `normalizeMessage` of the message a result answers.
 * @param {{ runTurn: Function, isBusy?: Function, isAnyBusy?: Function }} options.turns
 * @param {{ markSeen: Function }} options.errands
 * @param {() => string|null} [options.getGuildId]
 * @param {() => number} [options.now]
 * @param {(fn: Function, ms: number) => unknown} [options.setTimer]
 * @param {{ info: Function, warn: Function }} [options.log]
 */
export function createTaskTurns({ hot, client, discord, turns, errands, getGuildId = () => null, now = Date.now, setTimer = (fn, ms) => setTimeout(fn, ms), log = defaultLog }) {
  const { normalizeMessage } = discord;
  // conversation id -> when its last result turn started
  const lastAt = new Map();
  // task id -> pending timer, while a result waits for its turn
  const waiting = new Map();

  function seconds(key, fallback) {
    const value = hot.config?.agents?.[key];
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
      return;
    }
    const timer = setTimer(() => {
      waiting.delete(task.id);
      deliver(task, guildId, attempt + 1).catch((err) => log.warn('errands: result turn failed', { id: task.id, error: err }));
    }, Math.max(0, ms));
    timer?.unref?.();
    waiting.set(task.id, timer);
  }

  /** The message the errand was asked in, normalized as a turn's trigger, or null. */
  async function originMessage(channel, task) {
    const messageId = task.origin?.messageId;
    if (!messageId || typeof channel?.messages?.fetch !== 'function') return null;
    const message = await Promise.resolve(channel.messages.fetch(messageId)).catch(() => null);
    if (!message) return null;
    const media = hot.config?.media ?? {};
    return normalizeMessage(message, client?.user?.id, { embedTextChars: media.embedTextChars, videoSites: media.video?.sites, maxUrlChars: hot.config?.context?.maxUrlChars });
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
    const channel = await Promise.resolve(client?.channels?.fetch?.(channelId)).catch(() => null);
    if (!channel) {
      log.warn('errands: result conversation unavailable', { id: task.id, channelId });
      return null;
    }
    const trigger = await originMessage(channel, task);
    const requester = task.requester?.userId ? { id: task.requester.userId } : null;
    lastAt.set(channelId, now());
    let result;
    try {
      result = await turns.runTurn({
        channel,
        guildId: guildId ?? getGuildId?.() ?? null,
        mode: trigger ? 'reply' : 'interject',
        trigger,
        triggerKind: 'task',
        taskResult: task,
        ...(requester ? { requester } : {}),
      });
    } catch (err) {
      log.error('errands: result turn failed', { id: task.id, channelId, error: err });
      result = { outcome: 'error' };
    }
    const outcome = result?.outcome ?? 'error';
    if (HELD.has(outcome)) {
      lastAt.delete(channelId);
      later(task, guildId, attempt, retryMs);
      return result;
    }
    if (result?.dryRun !== true) errands?.markSeen?.({ guildId, ids: [task.id] });
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

  /** Every result still waiting dropped (shutdown). */
  function stop() {
    for (const timer of waiting.values()) clearTimeout(timer);
    waiting.clear();
  }

  return { onFinished, stop };
}
