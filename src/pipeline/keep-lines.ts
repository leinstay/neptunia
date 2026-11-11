// The lines in her context are stored: a history line that enters a turn's `<chat>` (src/turn/tool-round.ts#readHistory)
// or that the analyzers read to decide whether she speaks (src/pipeline/classifier-request.ts, the missed-answer sweep
// of src/behavior/missed.ts) is observed into the memory database like a live line, when memory lacks it. A line only
// `conversation.read` returned never comes here. createMessageHandler (src/behavior/pipeline.ts) builds the keeper once
// with createKeepLines; the core hands it to the turn runner and the missed-answer registry.
//
// A line goes through the live observation (src/pipeline/observe.ts#observeLine), so it takes the kind, the columns and
// the record day a live line takes, with the platform's send time as its time. The writer dedupes it by its native id:
// a stored line is a replay that writes nothing. A line is handed over once per process: the writer keeps a line it
// answers null for (queued while closed, retried after a failed write, still running past a timeout), and a refused
// line would be refused again, so a later read never hands it back. A line the platform marks edited (`editedAt`) is
// observed as an edit, so a text memory lacks becomes the next revision of the stored line (src/memory/db/observe.ts).
// The writes are never awaited by the reader, so no turn and no analyzer waits on them, and no line starts a turn here.
// The keeper leaves out what the live path leaves out: a system message and her limit notice. Logs carry counts only.

import { placeOfChat, sharedPlaceOf } from '../memory/addresses.ts';
import { isLimitNotice } from '../behavior/limits.ts';
import { log } from '../log.ts';
import type { MessageEvent as HistoryEvent } from '../protocol/adapter.ts';
import type { MessageEvent } from './edits.ts';
import type { ObserveLine } from './observe.ts';

/** How many lines the keeper remembers having handed to the writer, the oldest going first. */
const KEPT_IDS = 5000;

/** Hands the history events a reader just used to the writer; returns at once. */
export type KeepLines = (events: ReadonlyArray<HistoryEvent>) => void;

/** What createKeepLines reads: the dependencies of createMessageHandler. */
export type KeepLinesContext = {
  hot: { readonly prompts?: { readonly labels?: object } | null };
  store: unknown;
  observeLine: ObserveLine;
  selfIdOf: () => string;
  /** A root some connected interface serves. */
  isServedRoot: (placeId: string | null | undefined) => boolean;
};

/** Whether the event holds a whole message, as a history read gives it. */
function isWhole(event: HistoryEvent): event is MessageEvent {
  return 'content' in event.message && typeof event.message.content === 'string' && event.message.author != null;
}

export function createKeepLines({ hot, store, observeLine, selfIdOf, isServedRoot }: KeepLinesContext): KeepLines {
  const handed = new Set<string>();

  function remember(key: string): void {
    handed.add(key);
    // The set is past its cap, so it has a first value.
    if (handed.size > KEPT_IDS) handed.delete(handed.values().next().value as string);
  }

  /** Whether the live path would store this line (src/pipeline/handle-message.ts, src/pipeline/private-gate.ts). */
  function isKept(event: MessageEvent): boolean {
    const { message, chat } = event;
    if (message.system === true) return false;
    const self = message.author.id === selfIdOf();
    if (self && isLimitNotice((hot.prompts?.labels ?? {}) as Record<string, never>, message.content)) return false;
    if (chat.rootId !== null && !isServedRoot(chat.rootId)) return false;
    // A DM line names its partner, or the record cannot place it (as on the live path).
    return chat.rootId !== null || chat.chatType === 'group_dm' || chat.partnerId != null;
  }

  function whereOf(event: MessageEvent): { placeId: string } {
    const { chat } = event;
    if (chat.rootId === null && chat.chatType !== 'group_dm') return { placeId: placeOfChat(store, chat, event.iface) };
    return { placeId: sharedPlaceOf(store, chat, event.iface) };
  }

  async function keepOne(event: MessageEvent): Promise<boolean> {
    const { message } = event;
    const edited = typeof message.editedAt === 'number' && Number.isFinite(message.editedAt);
    // The send time is the line's time: nothing of the moment it was read enters the row.
    const line: MessageEvent = { ...event, at: message.at, ...(edited ? { edit: true } : {}) };
    const done = await observeLine(line, false, whereOf(event));
    return done?.ok === true;
  }

  return (events) => {
    const kept: Array<Promise<boolean>> = [];
    for (const event of events) {
      if (!isWhole(event) || !isKept(event)) continue;
      const { message } = event;
      const key = JSON.stringify([event.iface, event.chat.id, message.id, message.editedAt ?? null]);
      if (handed.has(key)) continue;
      remember(key);
      kept.push(keepOne(event));
    }
    if (kept.length === 0) return;
    void Promise.all(kept)
      .then((results) => {
        const failed = results.filter((ok) => !ok).length;
        if (failed > 0) log.warn('events: context lines not stored', { lines: results.length, failed });
      })
      .catch((error: unknown) => log.warn('events: context lines not stored', { error }));
  };
}
