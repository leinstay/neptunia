// The turn an errand's end opens: when an errand of the persona's finishes (src/errands/service.ts
// calls `onFinished`), she gets a turn of her own in the chat it was asked in, the way
// the missed-answer recovery opens one (src/behavior/missed.ts): through the turn runner's one
// attention (a turn running anywhere holds it back; mention.oneAtATime), a cooldown per
// chat between two such turns (`DEFAULT_COOLDOWN_SECONDS`), and she may answer with
// silence. The turn's trigger is the message the errand was asked in (her answer replies to it),
// else -- a slash command, or a message gone since -- an interjection; its kind is `errand`, its
// requester the person who asked, and its request carries the `<errand_result>` block
// (src/errands/blocks.ts). A turn held back is retried every `errands.resultRetrySeconds`, at
// most RESULT_ATTEMPTS times, then left for her `<errands>` block (marked `resultTurnFailed`, so
// the line says the turn never ran); a chat the interface cannot describe now, and a turn that failed on its own
// (`error`, `refused`, or any outcome but spoke and skip), are retried the same way. The chat of the owner's command
// line (`cli:dm:owner`) is asked of the command line (src/interface/cli-chat.ts), which answers it while no chat is open. Only a turn that spoke or chose silence
// marks the errand seen and read (`readAt`: its `<errand_result>` was in front of her); an errand not
// read stays in her `<errands>` block until `errand.read` or `errand.resolve`. Settings are read at the moment of
// use; logs carry ids and outcomes, never a goal or a result. An errand's end reaches this module
// as an `errand.done` event through the core's event door (src/interface/door.ts): the service
// calls `errandDoneEvent(errand, placeId)` and submits it, the door's handler is `onEvent`; the
// errand itself rides along in-process under `raw.errand` (the event holds its id and status), and
// when it does not, the errand store of the event's place is asked for it. Before the result turn,
// the end reaches the persona's intentions waiting on that errand (`intentions.onErrandFinished`,
// src/intentions/service.ts), so the turn already shows them back to pending with the outcome. An `errand.done` for an
// errand whose result she has read already (`readAt` set, in the event's errand or in the store), as a second delivery
// of the same end after a restart brings it, opens no second result turn. One end has one attempt at a time and one
// retry armed at a time: the service reopening an unseen end, the door replaying it and a retry timer all pass through
// `deliver`, which asks the store again, so a timer that fires after she read the result opens nothing.

import { log as defaultLog } from '../log.ts';
import { lineOf } from '../behavior/line-of.ts';
import { ifaceOfChat } from '../interface/cli-chat.ts';
import type { Untyped } from '../tools/types.ts';
import type { ChatRef } from '../protocol/adapter.ts';
import type { Reads } from '../interface/reads.ts';
import type { ErrandRecord, ErrandService, ErrorLogger } from './types.ts';

/** What the turn runner answers a result turn with. */
type TurnResult = { outcome?: string } | null | undefined;

/** The turn runner as the result turn uses it. */
type TurnsPort = {
  runTurn: (input: Record<string, unknown>) => Promise<TurnResult>;
  isBusy?: (placeId: string) => boolean;
  isAnyBusy?: () => boolean;
};

/** The `errand.done` event of a finished errand, as the door takes it. */
export type ErrandDoneEvent = {
  kind: 'errand.done';
  at: number;
  errandId: string;
  status: string;
  raw: { errand: ErrandRecord };
};

/** What a timer function hands back. */
type TimerHandle = ReturnType<typeof setTimeout>;

/** `errands.resultRetrySeconds` when missing (config.json carries the same). */
export const DEFAULT_RETRY_SECONDS = 30;
/** The least time between two result turns in one chat. Production value, config cut of 2026-10-31. */
export const DEFAULT_COOLDOWN_SECONDS = 60;
/** How many times a result turn is tried before the errand is left to the `<errands>` block. */
export const RESULT_ATTEMPTS = 20;

/**
 * The `errand.done` event of a finished errand (src/protocol/events.ts): the whole errand
 * rides along as `raw.errand`, which validation never reads. Its id is left to the door (errand and
 * status), so a second delivery of the same end is the same event.
 */
export function errandDoneEvent(errand: ErrandRecord, now: () => number = Date.now): ErrandDoneEvent {
  return {
    kind: 'errand.done',
    at: now(),
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
 * `reads` are the core's reads of the interface: the chat a result answers in and the message it was asked
 * in. `iface` names the interface the chats belong to (from `hello`). `intentions` is the intention
 * service: an errand's end moves the intentions waiting on it first (idempotent, never throws).
 */
export function createErrandTurns({
  hot,
  reads,
  iface = () => '',
  turns,
  errands,
  intentions = null,
  now = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  log = defaultLog,
}: {
  hot: Untyped;
  reads: Reads;
  iface?: () => string;
  turns: TurnsPort;
  errands: Partial<Pick<ErrandService, 'markSeen' | 'markRead' | 'markResultFailed' | 'store'>> | null;
  intentions?: { onErrandFinished: (errand: ErrandRecord) => unknown } | null;

  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  log?: ErrorLogger;
}): {
  onFinished: (errand: ErrandRecord) => Promise<TurnResult>;
  onEvent: (event: ErrandDoneEvent) => Promise<TurnResult>;
  stop: () => void;
} {
  // chat id -> when its last result turn started
  const lastAt = new Map<string, number>();
  // errand id -> pending timer, while a result waits for its turn
  const waiting = new Map<string, TimerHandle>();
  // errand ids with an attempt running now
  const delivering = new Set<string>();

  function seconds(key: string, fallback: number): number {
    const value = hot.config?.errands?.[key];
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  /** Whether a turn would find the attention taken in `placeId` now (the rule runTurn applies). */
  function attentionTaken(placeId: string): boolean {
    if (typeof turns?.isBusy === 'function' && turns.isBusy(placeId)) return true;
    return typeof turns?.isAnyBusy === 'function' && turns.isAnyBusy();
  }

  /** Try `errand` again in `ms`, unless it ran out of attempts. */
  function later(errand: ErrandRecord, attempt: number, ms: number): void {
    if (attempt + 1 >= RESULT_ATTEMPTS) {
      log.info('errands: result left to the tasks block', { id: errand.id, attempts: attempt + 1 });
      try {
        errands?.markResultFailed?.({ ids: [errand.id] });
      } catch (err) {
        log.warn('errands: result failure not noted', { id: errand.id, error: err });
      }
      return;
    }
    if (waiting.has(errand.id)) return;
    const timer = setTimer(
      () => {
        waiting.delete(errand.id);
        deliver(errand, attempt + 1).catch((err) =>
          log.warn('errands: result turn failed', { id: errand.id, error: err })
        );
      },
      Math.max(0, ms)
    );
    timer?.unref?.();
    waiting.set(errand.id, timer);
  }

  /** The message the errand was asked in, as a line (a turn's trigger), or null. */
  async function originMessage(ref: ChatRef, errand: ErrandRecord): Promise<Record<string, unknown> | null> {
    const messageId = errand.origin?.messageId;
    if (!messageId) return null;
    const found = await reads.fetchMessages(ref, [messageId]);
    const message = found?.messages[0];
    const event = message?.event;
    return event === undefined ? null : lineOf(event);
  }

  /** Whether her turn has had this end's result in front of it, by the errand held or the store now. */
  function isRead(errand: ErrandRecord): boolean {
    return Boolean(errand.readAt || errands?.store?.()?.get?.(errand.id)?.readAt);
  }

  /** One attempt at the result turn of `errand`, unless another is running or she has read the result since. */
  async function deliver(errand: ErrandRecord, attempt = 0): Promise<TurnResult> {
    if (delivering.has(errand.id)) return null;
    if (isRead(errand)) {
      log.info('errands: result already read', { id: errand.id });
      return null;
    }
    delivering.add(errand.id);
    try {
      return await attemptTurn(errand, attempt);
    } finally {
      delivering.delete(errand.id);
    }
  }

  /** The result turn of `errand`, or the retry when the chat's cooldown or the attention holds it back. */
  async function attemptTurn(errand: ErrandRecord, attempt: number): Promise<TurnResult> {
    const chatId = errand.origin?.placeId;
    if (!chatId) {
      log.info('errands: result without a chat', { id: errand.id });
      return null;
    }
    const cooldownMs = DEFAULT_COOLDOWN_SECONDS * 1000;
    const last = lastAt.get(chatId);
    if (typeof last === 'number' && Number.isFinite(last) && now() - last < cooldownMs) {
      later(errand, attempt, last + cooldownMs - now());
      return null;
    }
    const retryMs = seconds('resultRetrySeconds', DEFAULT_RETRY_SECONDS) * 1000;
    if (attentionTaken(chatId)) {
      later(errand, attempt, retryMs);
      return null;
    }
    // A restricted errand names its exact origin, which may be on another interface than the home one.
    const boundary = errand.origin?.publicationBoundary;
    // The command line's chat belongs to the command line, never to the served interface.
    const chat = {
      iface: boundary?.origin.iface ?? ifaceOfChat(String(chatId), iface()),
      chatId: String(chatId),
    };
    const known = await reads.chatInfo(chat);
    if (known === null) {
      // The chat may come back (an interface that reconnects): the result is tried again, never dropped.
      log.warn('errands: result chat unavailable', { id: errand.id, placeId: chatId });
      later(errand, attempt, retryMs);
      return null;
    }
    const trigger = await originMessage(chat, errand);
    const requester = errand.requester?.accountId ? { id: errand.requester.accountId } : null;
    lastAt.set(chatId, now());
    let result: TurnResult;
    try {
      result = await turns.runTurn({
        chat,
        mode: trigger ? 'reply' : 'interject',
        trigger,
        triggerKind: 'errand',
        taskResult: errand,
        ...(errand.origin?.publicationBoundary ? { publicationBoundary: errand.origin.publicationBoundary } : {}),
        ...(requester ? { requester } : {}),
      });
    } catch (err) {
      log.error('errands: result turn failed', { id: errand.id, placeId: chatId, error: err });
      result = { outcome: 'error' };
    }
    const outcome = result?.outcome ?? 'error';
    if (!DONE.has(outcome)) {
      // Held back, or failed on its own: the result is still unread, so the turn is tried again.
      lastAt.delete(chatId);
      later(errand, attempt, retryMs);
      if (!HELD.has(outcome))
        log.warn('errands: result turn not completed', { id: errand.id, placeId: chatId, outcome });
      return result;
    }
    errands?.markSeen?.({ ids: [errand.id] });
    errands?.markRead?.({ ids: [errand.id] });
    log.info('errands: result turn', {
      id: errand.id,
      placeId: chatId,
      outcome,
      ...(trigger ? {} : { interject: true }),
    });
    return result;
  }

  /** The service's `onFinished`: the result turn of `errand`, unless its retry is already armed (never throws). */
  function onFinished(errand: ErrandRecord): Promise<TurnResult> {
    if (waiting.has(errand.id)) return Promise.resolve(null);
    return deliver(errand, 0).catch((err) => {
      log.warn('errands: result turn failed', { id: errand?.id, error: err });
      return null;
    });
  }

  /**
   * The door's handler of `errand.done`: the intentions waiting on the errand the event names
   * moved first, then its result turn (never throws); null when the errand cannot be found.
   */
  function onEvent(event: ErrandDoneEvent): Promise<TurnResult> {
    const stored = errands?.store?.()?.get?.(event?.errandId) ?? null;
    const errand = event?.raw?.errand ?? stored;
    if (!errand) {
      log.warn('errands: finished task not found', { id: event?.errandId ?? null });
      return Promise.resolve(null);
    }
    try {
      intentions?.onErrandFinished?.(errand);
    } catch (err) {
      log.warn('errands: intentions not reached', { id: errand.id, error: err });
    }
    return onFinished(errand);
  }

  /** Every result still waiting dropped (shutdown). */
  function stop(): void {
    for (const timer of waiting.values()) clearTimeout(timer);
    waiting.clear();
  }

  return { onFinished, onEvent, stop };
}
