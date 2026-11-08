// The history of the owner's command-line chat, answered from the lines memory stores. The chat client holds only the
// lines said since it started, so a turn that read the client alone saw a chat of one line after a restart of the
// client or of the core. `withStoredHistory` answers the chat's `history` read from `shown(placeId)`, the lines the
// current session shows (src/chat/sessions.ts), and merges in the lines the client holds: the line that starts a turn
// can reach the turn before memory has written it, and the client's copy carries the files sent with it. Every other
// call goes to the client's adapter unchanged.

import type { SourceLine } from './sessions.ts';
import type { Adapter, ChatRef, HistoryQuery, MessageEvent } from '../protocol/adapter.ts';

/** The wire name of the history read, which the wrapper declares while no client is connected. */
const HISTORY_READ = 'messages.history';

/** The partner of a direct chat id `<iface>:dm:<partner>`, which is also the chat's place id in memory. */
const partnerOf = (placeId: string): string | null => /^[^:]+:dm:(.+)$/.exec(placeId)?.[1] ?? null;

/** A stored line as the `message.received` event the chat client sends for it: the owner's, or hers. */
function eventOf(line: SourceLine, iface: string, partner: string): MessageEvent {
  const id = line.nativeId ?? line.id;
  const self = line.who === 'her';
  return {
    kind: 'message.received',
    iface,
    at: line.at,
    id: `${iface}:message:${id}`,
    chat: { id: line.placeId, kind: 'dm', rootId: null, name: partner, partnerId: partner },
    message: {
      id,
      author: self
        ? { id: 'self', name: null, self: true, bot: false }
        : { id: partner, name: partner, self: false, bot: false },
      content: line.text,
      sourceText: line.text,
      system: false,
      at: line.at,
      replyToId: null,
      replyPingAccountId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
  };
}

/**
 * The stored lines of the chat and the client's, once each by message id, oldest first. A line the client holds keeps
 * the client's event. The page is the newest `query.limit` lines before `query.before`, or none when that line is unknown.
 */
function pageOf(
  stored: ReadonlyArray<MessageEvent>,
  live: ReadonlyArray<MessageEvent>,
  query: HistoryQuery
): Array<MessageEvent> {
  const held = new Set(live.map((event) => event.message.id));
  const all = [...stored.filter((event) => !held.has(event.message.id)), ...live].sort(
    (a, b) => (a.message.at ?? a.at) - (b.message.at ?? b.at)
  );
  const end = query.before === undefined ? all.length : all.findIndex((event) => event.message.id === query.before);
  return end < 0 ? [] : all.slice(Math.max(0, end - Math.max(0, query.limit)), end);
}

/** `live`, the chat client's adapter, with the history of a direct chat answered from `shown(chatId)` as well. */
export function withStoredHistory(live: Adapter, shown: (placeId: string) => ReadonlyArray<SourceLine>): Adapter {
  return {
    ...live,
    iface: live.iface,
    capabilities() {
      const own = live.capabilities();
      const reads = own.reads ?? [];
      return reads.includes(HISTORY_READ) ? own : { ...own, reads: [...reads, HISTORY_READ] };
    },
    async history(chat: ChatRef, query: HistoryQuery) {
      const partner = partnerOf(chat.chatId);
      const answer = await live.history(chat, query);
      if (partner === null) return answer;
      const held = answer.status === 'ok' ? answer.events : [];
      const stored = shown(chat.chatId).map((line) => eventOf(line, chat.iface, partner));
      return { status: 'ok', events: pageOf(stored, held, query), complete: true };
    },
  };
}
