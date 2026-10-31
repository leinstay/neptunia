// The turn an errand's end opens: when an errand of the persona's finishes (src/errands/service.ts
// calls `onFinished`), she gets a turn of her own in the conversation it was asked in, the way
// the missed-answer recovery opens one (src/behavior/missed.js): through the turn runner's one
// attention (a turn running anywhere holds it back; mention.oneAtATime), a cooldown per
// conversation between two such turns (`errands.resultCooldownSeconds`), and she may answer with
// silence. The turn's trigger is the message the errand was asked in (her answer replies to it),
// else -- a slash command, or a message gone since -- an interjection; its kind is `errand`, its
// requester the person who asked, and its request carries the `<errand_result>` block
// (src/errands/blocks.ts). A turn held back is retried every `errands.resultRetrySeconds`, at
// most RESULT_ATTEMPTS times, then left for her `<errands>` block (marked `resultTurnFailed`, so
// the line says the turn never ran); a turn that failed on its own (`error`, `refused`, or any
// outcome but spoke and skip) is retried the same way. Only a turn that spoke or chose silence
// marks the errand seen and read (`readAt`: its `<errand_result>` was in front of her); an errand not
// read stays in her `<errands>` block until `errand.read` or `errand.resolve`. Settings are read at the moment of
// use; logs carry ids and outcomes, never a goal or a result. An errand's end reaches this module
// as an `errand.done` event through the core's event door (src/interface/door.js): the service
// calls `errandDoneEvent(errand, guildId)` and submits it, the door's handler is `onEvent`; the
// errand itself rides along in-process under `raw.errand` (the event holds its id and status), and
// when it does not, the errand store of the event's guild is asked for it. Before the result turn,
// the end reaches the persona's intentions waiting on that errand (`intentions.onErrandFinished`,
// src/intentions/service.ts), so the turn already shows them back to pending with the outcome. An `errand.done` for an
// errand whose result she has read already (`readAt` set, in the event's errand or in the store), as a second delivery
// of the same end after a restart brings it, opens no second result turn.

import { log as defaultLog } from '../log.js';
import { lineOf } from '../behavior/line-of.js';
import type { Untyped } from '../tools/types.ts';
import type { ConversationRef } from '../protocol/adapter.ts';
import type { Reads } from '../interface/reads.ts';
import type { ErrandRecord, ErrandService, ErrorLogger } from './types.ts';

/** What the turn runner answers a result turn with. */
type TurnResult = { outcome?: string; dryRun?: boolean } | null | undefined;

/** The turn runner as the result turn uses it. */
type TurnsPort = {
  runTurn: (input: Record<string, unknown>) => Promise<TurnResult>;
  isBusy?: (channelId: string) => boolean;
  isAnyBusy?: () => boolean;
};

/** The `errand.done` event of a finished errand, as the door takes it. */
export type ErrandDoneEvent = {
  kind: 'errand.done';
  at: number;
  communityId: string | null;
  errandId: string;
  status: string;
  raw: { errand: ErrandRecord };
};

/** What a timer function hands back. */
type TimerHandle = ReturnType<typeof setTimeout>;

/** `errands.resultRetrySeconds` and `errands.resultCooldownSeconds` when missing (config.json carries the same). */
export const DEFAULT_RETRY_SECONDS = 30;
export const DEFAULT_COOLDOWN_SECONDS = 60;
/** How many times a result turn is tried before the errand is left to the `<errands>` block. */
export const RESULT_ATTEMPTS = 20;

/**
 * The `errand.done` event of a finished errand (src/protocol/events.js): the whole errand
 * rides along as `raw.errand`, which validation never reads. Its id is left to the door (errand and
 * status), so a second delivery of the same end is the same event.
 */
export function errandDoneEvent(
  errand: ErrandRecord,
  guildId: string | null = null,
  now: () => number = Date.now
): ErrandDoneEvent {
  return {
    kind: 'errand.done',
    at: now(),
    communityId: guildId ?? null,
    errandId: errand.id,
    status: errand.state,
    raw: { errand },
  };
}

/** The outcomes that mean the turn never ran: try again later. */
const HELD = new Set(['busy', 'paused']);
/** The outcomes that mean her turn ran and she saw the result. */
const DONE = new Set(['spoke', 'skip']);

/**
 * `reads` are the core's reads of the interface: the conversation a result answers in and the message it was asked
 * in. `iface` names the interface the conversations belong to (from `hello`). `intentions` is the intention
 * service: an errand's end moves the intentions waiting on it first (idempotent, never throws).
 */
export function createErrandTurns({
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
}: {
  hot: Untyped;
  reads: Reads;
  iface?: () => string;
  turns: TurnsPort;
  errands: Partial<Pick<ErrandService, 'markSeen' | 'markRead' | 'markResultFailed' | 'store'>> | null;
  intentions?: { onErrandFinished: (errand: ErrandRecord, guildId: string | null) => unknown } | null;
  getGuildId?: () => string | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  log?: ErrorLogger;
}): {
  onFinished: (errand: ErrandRecord, guildId: string | null) => Promise<TurnResult>;
  onEvent: (event: ErrandDoneEvent) => Promise<TurnResult>;
  stop: () => void;
} {
  // conversation id -> when its last result turn started
  const lastAt = new Map<string, number>();
  // errand id -> pending timer, while a result waits for its turn
  const waiting = new Map<string, TimerHandle>();

  function seconds(key: string, fallback: number): number {
    const value = hot.config?.errands?.[key];
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  /** Whether a turn would find the attention taken in `channelId` now (the rule runTurn applies). */
  function attentionTaken(channelId: string): boolean {
    if (typeof turns?.isBusy === 'function' && turns.isBusy(channelId)) return true;
    return hot.config?.mention?.oneAtATime !== false && typeof turns?.isAnyBusy === 'function' && turns.isAnyBusy();
  }

  /** Try `errand` again in `ms`, unless it ran out of attempts. */
  function later(errand: ErrandRecord, guildId: string | null, attempt: number, ms: number): void {
    if (attempt + 1 >= RESULT_ATTEMPTS) {
      log.info('errands: result left to the tasks block', { id: errand.id, attempts: attempt + 1 });
      try {
        errands?.markResultFailed?.({ guildId, ids: [errand.id] });
      } catch (err) {
        log.warn('errands: result failure not noted', { id: errand.id, error: err });
      }
      return;
    }
    const timer = setTimer(
      () => {
        waiting.delete(errand.id);
        deliver(errand, guildId, attempt + 1).catch((err) =>
          log.warn('errands: result turn failed', { id: errand.id, error: err })
        );
      },
      Math.max(0, ms)
    );
    timer?.unref?.();
    waiting.set(errand.id, timer);
  }

  /** The message the errand was asked in, as a line (a turn's trigger), or null. */
  async function originMessage(ref: ConversationRef, errand: ErrandRecord): Promise<Record<string, unknown> | null> {
    const messageId = errand.origin?.messageId;
    if (!messageId) return null;
    const found = await reads.fetchMessages(ref, [messageId]);
    const event = found?.messages[0]?.event;
    return event === undefined ? null : lineOf(event);
  }

  /** One attempt at the result turn of `errand`. */
  async function deliver(errand: ErrandRecord, guildId: string | null, attempt = 0): Promise<TurnResult> {
    const channelId = errand.origin?.channelId;
    if (!channelId) {
      log.info('errands: result without a conversation', { id: errand.id });
      return null;
    }
    const cooldownMs = seconds('resultCooldownSeconds', DEFAULT_COOLDOWN_SECONDS) * 1000;
    const last = lastAt.get(channelId);
    if (typeof last === 'number' && Number.isFinite(last) && now() - last < cooldownMs) {
      later(errand, guildId, attempt, last + cooldownMs - now());
      return null;
    }
    const retryMs = seconds('resultRetrySeconds', DEFAULT_RETRY_SECONDS) * 1000;
    if (attentionTaken(channelId)) {
      later(errand, guildId, attempt, retryMs);
      return null;
    }
    const conversation = { iface: iface(), conversationId: String(channelId) };
    const known = await reads.conversationInfo(conversation);
    if (known === null) {
      log.warn('errands: result conversation unavailable', { id: errand.id, channelId });
      return null;
    }
    const trigger = await originMessage(conversation, errand);
    const requester = errand.requester?.userId ? { id: errand.requester.userId } : null;
    lastAt.set(channelId, now());
    let result: TurnResult;
    try {
      result = await turns.runTurn({
        conversation,
        guildId: guildId ?? getGuildId?.() ?? null,
        mode: trigger ? 'reply' : 'interject',
        trigger,
        triggerKind: 'errand',
        taskResult: errand,
        ...(requester ? { requester } : {}),
      });
    } catch (err) {
      log.error('errands: result turn failed', { id: errand.id, channelId, error: err });
      result = { outcome: 'error' };
    }
    const outcome = result?.outcome ?? 'error';
    if (result?.dryRun === true) {
      log.info('errands: result turn', { id: errand.id, channelId, outcome, dryRun: true });
      return result;
    }
    if (!DONE.has(outcome)) {
      // Held back, or failed on its own: the result is still unread, so the turn is tried again.
      lastAt.delete(channelId);
      later(errand, guildId, attempt, retryMs);
      if (!HELD.has(outcome)) log.warn('errands: result turn not completed', { id: errand.id, channelId, outcome });
      return result;
    }
    errands?.markSeen?.({ guildId, ids: [errand.id] });
    errands?.markRead?.({ guildId, ids: [errand.id] });
    log.info('errands: result turn', { id: errand.id, channelId, outcome, ...(trigger ? {} : { interject: true }) });
    return result;
  }

  /** The service's `onFinished`: the result turn of `errand` (never throws). */
  function onFinished(errand: ErrandRecord, guildId: string | null): Promise<TurnResult> {
    return deliver(errand, guildId, 0).catch((err) => {
      log.warn('errands: result turn failed', { id: errand?.id, error: err });
      return null;
    });
  }

  /**
   * The door's handler of `errand.done`: the intentions waiting on the errand the event names
   * moved first, then its result turn (never throws); null when the errand cannot be found.
   */
  function onEvent(event: ErrandDoneEvent): Promise<TurnResult> {
    const guildId = event?.communityId ?? null;
    const stored = errands?.store?.(guildId)?.get?.(event?.errandId) ?? null;
    const errand = event?.raw?.errand ?? stored;
    if (!errand) {
      log.warn('errands: finished task not found', { id: event?.errandId ?? null });
      return Promise.resolve(null);
    }
    try {
      intentions?.onErrandFinished?.(errand, guildId);
    } catch (err) {
      log.warn('errands: intentions not reached', { id: errand.id, error: err });
    }
    if (errand.readAt || stored?.readAt) {
      log.info('errands: result already read', { id: errand.id });
      return Promise.resolve(null);
    }
    return onFinished(errand, guildId);
  }

  /** Every result still waiting dropped (shutdown). */
  function stop(): void {
    for (const timer of waiting.values()) clearTimeout(timer);
    waiting.clear();
  }

  return { onFinished, onEvent, stop };
}
