// The observation of a message event (stage 8a of spec 2026-10-24-memory-schema-v7): the core maps an interface's
// normalised `message.received` event (src/protocol/events.js) to the envelope observe.js writes. Nothing here knows a
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

import { OBSERVATION_VERSION } from './observe.js';

const filled = (value) => typeof value === 'string' && value !== '';
const isoOf = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** The media kinds of a message: attachments, links, then one `sticker` per sticker (src/memory/record.js's order). */
function mediaKindsOf(message) {
  const kinds = [];
  for (const item of [...(Array.isArray(message.attachments) ? message.attachments : []), ...(Array.isArray(message.links) ? message.links : [])]) {
    if (item && filled(item.kind)) kinds.push(item.kind);
  }
  for (const sticker of Array.isArray(message.stickers) ? message.stickers : []) if (sticker) kinds.push('sticker');
  return kinds;
}

/** The place part of an envelope from the event's conversation, or null when it cannot be keyed. */
function placeOf(conversation, authority) {
  const id = conversation?.id;
  if (!filled(id)) return null;
  const chatType = conversation.chatType ?? (conversation.kind === 'thread' ? 'thread' : conversation.kind === 'dm' ? 'dm' : 'channel');
  const title = typeof conversation.name === 'string' && conversation.name ? conversation.name : null;
  if (chatType === 'dm') {
    if (!filled(conversation.partnerId)) return null;
    return { authority, key: `dm:${conversation.partnerId}`, kind: 'dm', conversation: 'dm', partner: { key: conversation.partnerId } };
  }
  if (chatType === 'group_dm') return { authority, key: `group_dm:${id}`, kind: 'group_dm', conversation: 'group', ...(title ? { title } : {}) };
  if (chatType === 'thread') {
    return {
      authority, key: `thread:${id}`, kind: 'thread', conversation: 'group', ...(title ? { title } : {}),
      ...(filled(conversation.parentId) ? { parent: `channel:${conversation.parentId}` } : {}),
    };
  }
  if (chatType === 'channel') return { authority, key: `channel:${id}`, kind: 'channel', conversation: 'group', ...(title ? { title } : {}) };
  return null;
}

/**
 * The observation envelope of a `message.received` event, or null (see the head of this file).
 * @param {object} event  a validated `message.received` event (interfaces/<iface>'s `toEvent`)
 * @param {{ selfId?: string|null, direct?: boolean, connection?: string|null }} [options]
 *   `selfId`: her own user id on the interface (a line whose author is she is `self` even when the event's flag is
 *   missing); `direct`: whether the line was addressed to her (the pipeline's trigger, the record's `direct`).
 * @returns {object|null}
 */
export function observationOf(event, { selfId = null, direct = false, connection = null } = {}) {
  if (!event || typeof event !== 'object' || event.deleted === true || event.partial === true) return null;
  const iface = event.iface;
  const message = event.message;
  if (!filled(iface) || iface.includes('/') || !message || !filled(message.id) || !message.author || !filled(message.author.id)) return null;
  const authority = `${iface}/global`;
  const place = placeOf(event.conversation, authority);
  const occurredAt = isoOf(message.at);
  const observedAt = isoOf(event.at) ?? occurredAt;
  if (!place || !occurredAt || typeof message.content !== 'string') return null;
  const edited = event.edit === true;
  const self = message.author.self === true || (filled(selfId) && message.author.id === selfId);
  const author = self
    ? { kind: 'self', key: message.author.id, account_kind: 'self', ...(filled(message.author.name) ? { display: message.author.name } : {}) }
    : { kind: 'account', key: message.author.id, account_kind: message.author.bot === true ? 'bot' : 'user', ...(filled(message.author.name) ? { display: message.author.name } : {}) };
  const mentioned = [...new Set((Array.isArray(event.addressing?.mentionedUserIds) ? event.addressing.mentionedUserIds : []).filter(filled))];
  const relations = [
    ...(filled(message.replyToId) ? [{ predicate: 'replies_to', target: { kind: 'message', key: message.replyToId } }] : []),
    ...mentioned.map((id) => ({ predicate: 'mentions', target: { kind: 'user', key: id } })),
  ];
  const media = mediaKindsOf(message);
  return {
    v: OBSERVATION_VERSION,
    iface,
    authority,
    ...(filled(connection) ? { connection } : {}),
    native: { kind: 'message', key: message.id, subtype: self && !edited ? 'said' : 'seen', ...(edited ? {} : { revision: 1 }) },
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
