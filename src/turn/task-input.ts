// The `tasks` input of a turn's request: the part of a split message it answers, the calls still waiting in its
// channel, the messages folded into it, a recovery turn's missed messages and the addressed turns that failed earlier.
// src/behavior/turn.js builds it before every reply request.

import { log } from '../log.js';
import { isObj } from '../tools/types.ts';

/** A call still waiting in the channel: the trigger author's own, or another member's with their name. */
type QueuedCall = { id?: string | null; text: string; author?: unknown };

/** An addressed turn of this channel that failed with nothing posted. */
type FailedTurn = { messageId?: unknown } & Record<string, unknown>;

export type TaskInput = {
  part: object | null;
  queued: Array<string>;
  queuedOthers: Array<{ author: string; text: string }>;
  added: Array<string>;
  missed: Array<{ author: string; text: string }>;
  failedEarlier: Array<FailedTurn>;
};

/** Whether a list argument is a list (a JavaScript caller may pass anything). */
function isList<TItem>(value: ReadonlyArray<TItem> | null | undefined): value is ReadonlyArray<TItem> {
  return Array.isArray(value);
}

/**
 * The `tasks` input of a turn's request (src/behavior/prompt.js#buildRequest)
 * and the calls it names as left to their own turns. `part`: the part of a
 * split message this turn answers; `queued()`: the calls still waiting in
 * this channel (read now; a throw counts as none, logged `turn: queued
 * failed`) -- the trigger author's own as `{ id, text }`, another member's as
 * `{ id, text, author }` (their display name); `added`: messages folded into
 * this call. The author's own calls count as named (`deferred`, their ids)
 * when the request can render them: in `labels.task.part`'s others on a part,
 * else under `labels.task.queued`; another member's under
 * `labels.task.queuedOthers`. A call the labels cannot name is not deferred:
 * the seen-in-history rule holds for it, as before. `missed`: a recovery
 * turn's earlier messages left unanswered (src/behavior/missed.js), `{ author,
 * text }` each, named under `labels.task.missed`. `failedEarlier`: the
 * addressed turns of this channel that failed with nothing posted
 * (`{ author, messageId, link, at, code }`), one `labels.task.failedEarlier`
 * line each.
 * `input` is null when there is nothing to say.
 */
export function taskInput({
  part,
  queued,
  added,
  missed = null,
  failedEarlier = null,
  labels,
  channelId,
}: {
  part?: object | null;
  queued?: (() => unknown) | null;
  added?: ReadonlyArray<{ text?: unknown } | null> | null;
  missed?: ReadonlyArray<{ author?: unknown; text?: unknown } | null> | null;
  failedEarlier?: ReadonlyArray<FailedTurn | null> | null;
  labels?: { task?: { part?: unknown; queued?: unknown; queuedOthers?: unknown; failedEarlier?: unknown } } | null;
  channelId?: string | null;
}): { input: TaskInput | null; deferred: Set<string> } {
  let waiting: Array<QueuedCall> = [];
  if (typeof queued === 'function') {
    try {
      const list: unknown = queued();
      waiting = Array.isArray(list)
        ? list.filter((call): call is QueuedCall => isObj(call) && typeof call.text === 'string' && Boolean(call.text))
        : [];
    } catch (err) {
      log.warn('turn: queued failed', { channel: channelId, error: err });
    }
  }
  const own = waiting.filter((call) => typeof call.author !== 'string');
  const others = waiting.filter((call): call is QueuedCall & { author: string } => typeof call.author === 'string');
  const addedTexts = isList(added)
    ? added.map((message) => message?.text).filter((text): text is string => typeof text === 'string' && Boolean(text))
    : [];
  const ownNamed = own.length > 0 && Boolean(part ? labels?.task?.part : labels?.task?.queued);
  const othersNamed = others.length > 0 && Boolean(labels?.task?.queuedOthers);
  const deferred = new Set(
    [...(ownNamed ? own : []), ...(othersNamed ? others : [])]
      .map((call) => call.id)
      .filter((id): id is string => Boolean(id))
  );
  const missedItems = isList(missed)
    ? missed
        .filter(
          (item): item is { author?: unknown; text: string } =>
            Boolean(item) && typeof item?.text === 'string' && Boolean(item.text)
        )
        .map((item) => ({ author: typeof item.author === 'string' ? item.author : '', text: item.text }))
    : [];
  const failedItems =
    isList(failedEarlier) && labels?.task?.failedEarlier
      ? failedEarlier.filter((entry): entry is FailedTurn => Boolean(entry?.messageId))
      : [];
  if (!part && waiting.length === 0 && addedTexts.length === 0 && missedItems.length === 0 && failedItems.length === 0)
    return { input: null, deferred };
  return {
    input: {
      part: part ?? null,
      queued: own.map((call) => call.text),
      queuedOthers: others.map((call) => ({ author: call.author, text: call.text })),
      added: addedTexts,
      missed: missedItems,
      failedEarlier: failedItems,
    },
    deferred,
  };
}
