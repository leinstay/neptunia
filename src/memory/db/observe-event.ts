// The observation of a message event (stage 8a of spec 2026-10-24-memory-schema-v7): the core maps an interface's
// normalised `message.received` event (src/protocol/events.ts) to the envelope observe.ts writes. Nothing here knows a
// platform: the interface is the event's `iface`, its namespace `<iface>/global`, and every id is the opaque string the
// adapter gave. Pure, no I/O.
//
//   native    the message id, kind `message`, subtype the record's kind of the line (`said` for her own new line,
//             `seen` for anyone else's and for every edit, hers too, as the record writes them); revision 1 for a new
//             line, none for an edit (`edited: true`: observe takes it from the database);
//   place     `channel:<id>` (a channel), `thread:<id>` (a thread, its parent `channel:<parent id>`), `group_dm:<id>`
//             (a group chat) with conversation `group`; `dm:<partner id>` for a direct chat with its partner, with
//             conversation `dm` (a direct chat whose partner the event does not name is not observed);
//   author    the account of the author's id, of kind `bot` when the event says bot; her own line is author `self`
//             with her account (kind `self`);
//   relations `replies_to` the replied message, `mentions` each mentioned member (by user id);
//   media     the kinds of the attachments, links and stickers (the record's `media`);
//   times     `occurredAt` the message's time, `observedAt` the event's.
// Returns null for an event that is no observable line: a deletion, a partial edit, a malformed event.

import { messageLocator } from './message-locator.ts';
import { OBSERVATION_VERSION } from './observe.ts';
import type { Envelope } from './observe.ts';
import { isFiniteNumber } from './types.ts';
import type { Row } from './types.ts';

const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isoOf = (ms: unknown): string | null => (isFiniteNumber(ms) ? new Date(ms).toISOString() : null);

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
/** The conversation of the event. */
type EventConversation = {
  id?: unknown;
  chatType?: unknown;
  kind?: unknown;
  name?: unknown;
  partnerId?: unknown;
  parentId?: unknown;
};

/** The media kinds of a message: attachments, links, then one `sticker` per sticker (src/memory/record.ts's order). */
function mediaKindsOf(message: EventMessage): Array<string> {
  const kinds: Array<string> = [];
  for (const item of [
    ...(Array.isArray(message.attachments) ? (message.attachments as Array<Row | null>) : []),
    ...(Array.isArray(message.links) ? (message.links as Array<Row | null>) : []),
  ]) {
    if (item && filled(item.kind)) kinds.push(item.kind);
  }
  for (const sticker of Array.isArray(message.stickers) ? message.stickers : []) if (sticker) kinds.push('sticker');
  return kinds;
}

/** The place part of an envelope from the event's conversation, or null when it cannot be keyed. */
function placeOf(conversation: EventConversation | undefined, authority: string): Envelope['place'] | null {
  const id = conversation?.id;
  if (!conversation || !filled(id)) return null;
  const chatType =
    conversation.chatType ??
    (conversation.kind === 'thread' ? 'thread' : conversation.kind === 'dm' ? 'dm' : 'channel');
  const title = typeof conversation.name === 'string' && conversation.name ? conversation.name : null;
  if (chatType === 'dm') {
    if (!filled(conversation.partnerId)) return null;
    return {
      authority,
      key: `dm:${conversation.partnerId}`,
      kind: 'dm',
      conversation: 'dm',
      partner: { key: conversation.partnerId },
    };
  }
  if (chatType === 'group_dm')
    return { authority, key: `group_dm:${id}`, kind: 'group_dm', conversation: 'group', ...(title ? { title } : {}) };
  if (chatType === 'thread') {
    return {
      authority,
      key: `thread:${id}`,
      kind: 'thread',
      conversation: 'group',
      ...(title ? { title } : {}),
      ...(filled(conversation.parentId) ? { parent: `channel:${conversation.parentId}` } : {}),
    };
  }
  if (chatType === 'channel')
    return { authority, key: `channel:${id}`, kind: 'channel', conversation: 'group', ...(title ? { title } : {}) };
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
  const authority = `${iface}/global`;
  const place = placeOf(event.conversation as EventConversation | undefined, authority);
  const occurredAt = isoOf(message.at);
  if (!place || !occurredAt || typeof message.content !== 'string') return null;
  const locator = messageLocator(
    {
      v: 1,
      origin: 'protocol-message',
      iface,
      conversationId: (event.conversation as EventConversation).id,
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
      (Array.isArray((event.addressing as { mentionedUserIds?: unknown } | undefined)?.mentionedUserIds)
        ? (event.addressing as { mentionedUserIds: Array<unknown> }).mentionedUserIds
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
  const media = mediaKindsOf(message);
  return {
    v: OBSERVATION_VERSION,
    iface,
    authority,
    messageLocator: locator,
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
