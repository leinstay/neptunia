// The history of the owner's command-line chat, answered from the lines memory stores. The chat client holds only the
// lines said since it started, so a turn that read the client alone saw a chat of one line after a restart of the
// client or of the core. `withStoredHistory` answers the chat's `history` read from `shown(placeId)`, the lines the
// current session shows (src/chat/sessions.ts), and merges in the lines the client holds: the line that starts a turn
// can reach the turn before memory has written it, and the client's copy carries the files sent with it. A stored line
// brings its media as a platform's message does: each item with its text form (media-store.ts#mediaMessageParts) and a
// file the core kept under `media/cli/` by its reference (src/media/kept-files.ts), so a picture, a voice note or any
// file of the chat comes back with its line after a restart. The client keeps only her words, so its copy of her line
// takes the stored files it lacks. The owner's lines and the chat's description carry the name of his person when one is
// known (`ownerName`), never the command line's own `owner`. Every other call goes to the client's adapter unchanged.

import { mediaMessageParts } from '../memory/db/media-store.ts';
import { contentTypeOfName, keptReference } from '../media/kept-files.ts';
import type { SourceLine } from './sessions.ts';
import type { Adapter, ChatRef, HistoryQuery, MessageEvent } from '../protocol/adapter.ts';

/** The wire name of the history read, which the wrapper declares while no client is connected. */
const HISTORY_READ = 'messages.history';

/** The partner of a direct chat id `<iface>:dm:<partner>`, which is also the chat's place id in memory. */
const partnerOf = (placeId: string): string | null => /^[^:]+:dm:(.+)$/.exec(placeId)?.[1] ?? null;

/** The media of a stored line in the fields of a message, each kept file named by its reference. */
function partsOf(line: SourceLine, id: string): ReturnType<typeof mediaMessageParts> {
  const rows = line.media ?? [];
  const parts = mediaMessageParts(rows, id);
  const attachments = parts.attachments.map((attachment) => {
    const file = rows.find((row) => row.nativeRef === attachment.id)?.path ?? null;
    return file === null
      ? attachment
      : { ...attachment, url: keptReference(file), contentType: contentTypeOfName(file) };
  });
  return { ...parts, attachments };
}

/** A stored line as the `message.received` event the chat client sends for it: the owner's, or hers. */
function eventOf(line: SourceLine, iface: string, partner: string): MessageEvent {
  const id = line.nativeId ?? line.id;
  const media = partsOf(line, id);
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
      replyToId: line.replyToId ?? null,
      replyPingAccountId: null,
      forwardedFrom: null,
      attachments: media.attachments,
      links: media.links,
      forwarded: [],
      stickers: media.stickers,
      emojis: media.emojis,
      reactions: [],
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
  };
}

/**
 * The stored lines of the chat and the client's, once each by message id, oldest first. A line the client holds keeps
 * the client's event, with the stored files when it carries none. The page is the newest `query.limit` lines before `query.before`, or none when that line is unknown.
 */
function pageOf(
  stored: ReadonlyArray<MessageEvent>,
  live: ReadonlyArray<MessageEvent>,
  query: HistoryQuery
): Array<MessageEvent> {
  const held = new Set(live.map((event) => event.message.id));
  const storedById = new Map(stored.map((event) => [event.message.id, event]));
  const completed = live.map((event) => {
    const { message } = event;
    const files = storedById.get(message.id)?.message.attachments ?? [];
    return (message.attachments?.length ?? 0) > 0 || files.length === 0
      ? event
      : { ...event, message: { ...message, attachments: files } };
  });
  const all = [...stored.filter((event) => !held.has(event.message.id)), ...completed].sort(
    (a, b) => (a.message.at ?? a.at) - (b.message.at ?? b.at)
  );
  const end = query.before === undefined ? all.length : all.findIndex((event) => event.message.id === query.before);
  return end < 0 ? [] : all.slice(Math.max(0, end - Math.max(0, query.limit)), end);
}

/** `event` with the owner's name on its author and its chat when it is his line and `name` is one. */
function namedOwner(event: MessageEvent, name: string | null): MessageEvent {
  const { message } = event;
  const { author } = message;
  if (name === null || author === undefined || author.self === true || author.id === undefined) return event;
  return {
    ...event,
    chat: { ...event.chat, name },
    message: { ...message, author: { ...author, id: author.id, name } },
  };
}

/**
 * `live`, the chat client's adapter, with the history of a direct chat answered from `shown(chatId)` as well, and the
 * owner named `ownerName()` in it and in the chat's description when that answers a name.
 */
export function withStoredHistory(
  live: Adapter,
  shown: (placeId: string) => ReadonlyArray<SourceLine>,
  ownerName: () => string | null = () => null
): Adapter {
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
      const name = ownerName();
      return {
        status: 'ok',
        events: pageOf(stored, held, query).map((event) => namedOwner(event, name)),
        complete: true,
      };
    },
    async chatInfo(chat: ChatRef) {
      const answer = await live.chatInfo(chat);
      const name = ownerName();
      return answer.status === 'ok' && name !== null && partnerOf(chat.chatId) !== null
        ? { ...answer, chat: { ...answer.chat, name } }
        : answer;
    },
  };
}
