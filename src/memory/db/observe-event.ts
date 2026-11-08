// The observation of a message event (stage 8a of spec 2026-10-24-memory-schema-v7): the core maps an interface's
// normalised `message.received` event (src/protocol/events.ts) to the envelope observe.ts writes. Nothing here knows a
// platform: the interface is the event's `iface`, its namespace the authority the chat declares or the
// interface's native one (src/protocol/identity.ts#nativeAuthorityOf), and every id is the opaque string the adapter
// gave. Pure, no I/O.
//
//   native    the message id, kind `message`, subtype the record's kind of the line (`said` for her own new line,
//             `seen` for anyone else's and for every edit, hers too, as the record writes them); revision 1 for a new
//             line, none for an edit (`edited: true`: observe takes it from the database);
//   place     `channel:<id>` (a channel), `thread:<id>` (a thread), `group_dm:<id>` (a group chat) with chat
//             `group`, each with the place that contains it as `<parentKind>:<parentId>` when it declares one (a thread
//             with no declared kind sits in `channel:<parentId>`); `dm:<partner id>` for a direct chat with its partner, with
//             chat `dm` (a direct chat whose partner the event does not name is not observed);
//   author    the account of the author's id, of kind `bot` when the event says bot; her own line is author `self`
//             with her account (kind `self`);
//   relations `replies_to` the replied message, `mentions` each mentioned member (by user id);
//   media     one neutral item per attachment, link, sticker and custom emoji (media-store.ts#mediaItemsOf);
//   times     `occurredAt` the message's time, `observedAt` the event's.
// Returns null for an event that is no observable line: a deletion, a partial edit, a malformed event.

import { nativeAuthorityOf } from '../../protocol/identity.ts';
import type { MessageDeletion } from './message-families.ts';
import { messageLocator } from './message-locator.ts';
import { mediaItemsOf } from './media-store.ts';
import { OBSERVATION_VERSION } from './observe.ts';
import type { Envelope, MessageChat } from './observe.ts';
import { isFiniteNumber } from './types.ts';
import type { Row } from './types.ts';

const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isoOf = (ms: unknown): string | null => (isFiniteNumber(ms) ? new Date(ms).toISOString() : null);

/** Retains protocol chat identity independently of the mapped partner place. */
function messageChatOf(id: string, place: Envelope['place'], chat?: EventChat): MessageChat {
  return {
    id,
    // placeOf accepts exactly the four normalized chat kinds.
    chatType: place.kind as MessageChat['chatType'],
    ...(filled(chat?.partnerId) ? { partnerId: chat.partnerId } : {}),
    ...(filled(chat?.parentId) ? { parentId: chat.parentId } : {}),
  };
}

/** The parts of a `message.received` event this module reads. */
type EventMessage = {
  id?: unknown;
  at?: unknown;
  content?: unknown;
  replyToId?: unknown;
  author?: { id?: unknown; self?: unknown; bot?: unknown; name?: unknown } | null;
  attachments?: unknown;
  links?: unknown;
  stickers?: unknown;
};
/** The chat of the event. */
type EventChat = {
  id?: unknown;
  chatType?: unknown;
  kind?: unknown;
  name?: unknown;
  partnerId?: unknown;
  parentId?: unknown;
  parentKind?: unknown;
  rootId?: unknown;
  authorityId?: unknown;
};

/** The authority an event's place is observed under: the one its chat declares, or the interface's native one. */
const authorityOf = (iface: string, chat: EventChat | undefined): string =>
  filled(chat?.authorityId) ? chat.authorityId : nativeAuthorityOf(iface);

/** The native place key of a chat, the one the observation stores it under. */
export function chatPlaceKey(chat: { id?: unknown; kind?: unknown; chatType?: unknown; partnerId?: unknown }): string {
  const chatType = chat.chatType ?? (chat.kind === 'thread' ? 'thread' : chat.kind === 'dm' ? 'dm' : 'channel');
  if (chatType === 'dm') return `dm:${String(chat.partnerId ?? chat.id)}`;
  if (chatType === 'group_dm') return `group_dm:${String(chat.id)}`;
  if (chatType === 'thread') return `thread:${String(chat.id)}`;
  return `channel:${String(chat.id)}`;
}

/** The place key of what contains a chat: `<parentKind>:<parentId>`; with no declared kind it sits in a channel. */
function parentField(chat: EventChat): { parent?: string; top?: string } {
  const top = filled(chat.rootId) ? `server:${chat.rootId}` : null;
  if (!filled(chat.parentId)) return top === null ? {} : { parent: top };
  const kind = filled(chat.parentKind) ? chat.parentKind : 'channel';
  return { parent: `${kind}:${chat.parentId}`, ...(top === null ? {} : { top }) };
}

/** The place part of an envelope from the event's chat, or null when it cannot be keyed. */
function placeOf(chat: EventChat | undefined, authority: string): Envelope['place'] | null {
  const id = chat?.id;
  if (!chat || !filled(id)) return null;
  const chatType = chat.chatType ?? (chat.kind === 'thread' ? 'thread' : chat.kind === 'dm' ? 'dm' : 'channel');
  const title = typeof chat.name === 'string' && chat.name ? chat.name : null;
  if (chatType === 'dm') {
    if (!filled(chat.partnerId)) return null;
    return {
      authority,
      key: `dm:${chat.partnerId}`,
      kind: 'dm',
      chat: 'dm',
      partner: { key: chat.partnerId },
    };
  }
  if (chatType === 'group_dm')
    return {
      authority,
      key: `group_dm:${id}`,
      kind: 'group_dm',
      chat: 'group',
      ...(title ? { title } : {}),
      ...parentField(chat),
    };
  if (chatType === 'thread') {
    return {
      authority,
      key: `thread:${id}`,
      kind: 'thread',
      chat: 'group',
      ...(title ? { title } : {}),
      ...parentField(chat),
    };
  }
  if (chatType === 'channel')
    return {
      authority,
      key: `channel:${id}`,
      kind: 'channel',
      chat: 'group',
      ...(title ? { title } : {}),
      ...parentField(chat),
    };
  return null;
}

function authorOf({
  author,
  id,
  self,
}: {
  author: NonNullable<EventMessage['author']>;
  id: string;
  self: boolean;
}): Envelope['author'] {
  return self
    ? {
        kind: 'self',
        key: id,
        account_kind: 'self',
        ...(filled(author.name) ? { display: author.name } : {}),
      }
    : {
        kind: 'account',
        key: id,
        account_kind: author.bot === true ? 'bot' : 'user',
        ...(filled(author.name) ? { display: author.name } : {}),
      };
}

function replyDescriptor(
  message: EventMessage,
  locator: NonNullable<Envelope['messageLocator']>
): Pick<Envelope, 'messageReply'> {
  return filled(message.replyToId)
    ? {
        messageReply: {
          iface: locator.iface,
          chatId: locator.chatId,
          messageId: message.replyToId,
        },
      }
    : {};
}

/**
 * The observation envelope of a `message.received` event, or null (see the head of this file).
 * `event` is a validated `message.received` event (interfaces/<iface>'s `toEvent`). `selfId` is her own user id on the
 * interface (a line whose author is she is `self` even when the event's flag is missing), `direct` whether the line
 * was addressed to her (the pipeline's trigger, the record's `direct`).
 */
export function observationOf(
  event: Row,
  {
    selfId = null,
    direct = false,
    connection = null,
  }: { selfId?: unknown; direct?: boolean; connection?: unknown } = {}
): Envelope | null {
  if (!event || typeof event !== 'object' || event.deleted === true || event.partial === true) return null;
  const iface = event.iface;
  const message = event.message as EventMessage | undefined;
  if (
    !filled(iface) ||
    iface.includes('/') ||
    !message ||
    !filled(message.id) ||
    !message.author ||
    !filled(message.author.id)
  )
    return null;
  // The protocol chat is narrowed by placeOf before its descriptor is emitted.
  const chat = event.chat as EventChat | undefined;
  const authority = authorityOf(iface, chat);
  const place = placeOf(chat, authority);
  const occurredAt = isoOf(message.at);
  if (!place || !occurredAt || typeof message.content !== 'string') return null;
  const locator = messageLocator(
    {
      v: 1,
      origin: 'protocol-message',
      iface,
      chatId: (event.chat as EventChat).id,
      messageId: message.id,
    },
    iface
  );
  if (!locator) return null;
  const observedAt = isoOf(event.at) ?? occurredAt;
  const edited = event.edit === true;
  const self = message.author.self === true || (filled(selfId) && message.author.id === selfId);
  const author = authorOf({ author: message.author, id: message.author.id, self });
  const mentioned = [
    ...new Set(
      (Array.isArray((event.addressing as { mentionedAccountIds?: unknown } | undefined)?.mentionedAccountIds)
        ? (event.addressing as { mentionedAccountIds: Array<unknown> }).mentionedAccountIds
        : []
      ).filter(filled)
    ),
  ];
  const relations = [
    ...(filled(message.replyToId)
      ? [{ predicate: 'replies_to', target: { kind: 'message', key: message.replyToId } }]
      : []),
    ...mentioned.map((id) => ({ predicate: 'mentions', target: { kind: 'user', key: id } })),
  ];
  const media = mediaItemsOf(message);
  return {
    v: OBSERVATION_VERSION,
    iface,
    authority,
    messageLocator: locator,
    ...replyDescriptor(message, locator),
    messageChat: messageChatOf(locator.chatId, place, chat),
    ...(filled(connection) ? { connection } : {}),
    native: {
      kind: 'message',
      key: message.id,
      subtype: self && !edited ? 'said' : 'seen',
      ...(edited ? {} : { revision: 1 }),
    },
    ...(edited ? { edited: true } : {}),
    place,
    author,
    occurredAt,
    observedAt,
    text: message.content,
    ...(media.length > 0 ? { media } : {}),
    mentions: mentioned,
    direct: direct === true,
    relations,
  };
}

/** A deletion retains the route and time without requiring message content or an author. */
export function deletionOf(event: Row): MessageDeletion | null {
  const iface = event.iface;
  const message = event.message as EventMessage | undefined;
  if (!filled(iface) || iface.includes('/') || !message || event.deleted !== true) return null;
  const chat = event.chat as EventChat | undefined;
  const locator = messageLocator(
    { v: 1, origin: 'protocol-message', iface, chatId: chat?.id, messageId: message.id },
    iface
  );
  const authority = authorityOf(iface, chat);
  const place = placeOf(chat, authority);
  const observedAt = isoOf(event.at);
  if (!locator || !place || !observedAt) return null;
  return {
    v: 1,
    iface,
    authority,
    messageLocator: locator,
    messageChat: messageChatOf(locator.chatId, place, chat),
    occurredAt: isoOf(message.at) ?? observedAt,
    observedAt,
  };
}
