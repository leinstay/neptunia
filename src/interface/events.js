// The neutral inbound event model: what any interface (or the core itself) tells the mind, and the
// envelope that carries it. Pure functions over plain objects: no platform import, no clock, no
// I/O. Nothing in the engine imports this module yet (north star 12, section 7 B, step 1).
//
// Three layers:
//  - an event: `{ id, type, at, origin, ...payload }` with a type from EVENT_TYPES. `id` is
//    idempotent: the same happening always gets the same id (see eventId), so a redelivery is
//    recognised and dropped (createDedupe);
//  - an origin: where it happened and whether a reply is expected (normalizeOrigin);
//  - an envelope: `{ v, id, type, replyTo, body }` with a type from ENVELOPE_TYPES; an `event`
//    envelope carries one event in `body.event`. Delivery is at-least-once: an `ack` names the
//    envelope it answers in `replyTo`, and the sender repeats until it sees one.
// Every id is an opaque string. The adapter's identity comes from its authenticated connection,
// never from the body: the body's `origin.iface` is a label the transport must check, not trust.
// Validation never throws; it returns `{ ok: true, ... }` or `{ ok: false, reason }` with a
// reason naming the field and the problem (`origin.place:required`).

/** The envelope version this module speaks. */
export const ENVELOPE_VERSION = 1;

export const MESSAGE_CREATED = 'message.created';
export const MESSAGE_EDITED = 'message.edited';
export const MESSAGE_DELETED = 'message.deleted';
export const REACTION_ADDED = 'reaction.added';
export const REACTION_REMOVED = 'reaction.removed';
export const MEMBER_JOINED = 'member.joined';
export const MEMBER_LEFT = 'member.left';
export const VOICE_STATE = 'voice.state';

/** Every event type. */
export const EVENT_TYPES = Object.freeze([
  MESSAGE_CREATED, MESSAGE_EDITED, MESSAGE_DELETED,
  REACTION_ADDED, REACTION_REMOVED,
  MEMBER_JOINED, MEMBER_LEFT,
  VOICE_STATE,
]);

/** Every envelope type. */
export const ENVELOPE_TYPES = Object.freeze(['hello', 'event', 'ack', 'action', 'action_result', 'ping']);

/** Envelope types that answer another envelope and so must name it in `replyTo`. */
const ANSWERS = Object.freeze(['ack', 'action_result']);

/**
 * Chat types. `dm`: one person; `group`: a small private group; `channel`: a shared room;
 * `thread`: a branch of a channel; `none`: an event with no chat place (a member joining a
 * community, a tick of the core's clock).
 */
export const CHAT_TYPES = Object.freeze(['dm', 'group', 'channel', 'thread', 'none']);

const OWN_KEYS = (object, keys) => Object.fromEntries(keys.filter((key) => key in object).map((key) => [key, object[key]]));

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isString = (value) => typeof value === 'string';
const isId = (value) => isString(value) && value.trim() !== '';
const isTime = (value) => typeof value === 'number' && Number.isFinite(value);
const optionalId = (value) => value === undefined || value === null || isId(value);
const idOrNull = (value) => (isId(value) ? value.trim() : null);
const textOrNull = (value) => (isString(value) && value !== '' ? value : null);

const fail = (reason) => ({ ok: false, reason });

/** True when `value` survives JSON unchanged in kind: plain data only, no functions or cycles. */
function isPlainData(value, depth = 0) {
  if (depth > 8) return false;
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isPlainData(item, depth + 1));
  if (isObject(value)) return Object.values(value).every((item) => isPlainData(item, depth + 1));
  return false;
}

// ---------------------------------------------------------------------------
// Ids

/**
 * The idempotent id of an event: built from the adapter's namespace, the event type and the
 * platform's own key for the happening (a message id for a creation; message id plus the edit's
 * timestamp for an edit; message, emoji and member for a reaction). The same input always gives
 * the same id, so a redelivered event is the same event. Returns null when a part is unusable.
 * @param {string} iface
 * @param {string} type
 * @param {...(string|number)} parts
 * @returns {string|null}
 */
export function eventId(iface, type, ...parts) {
  if (!isId(iface) || !EVENT_TYPES.includes(type) || parts.length === 0) return null;
  const clean = [];
  for (const part of parts) {
    const text = typeof part === 'number' ? (Number.isFinite(part) ? String(part) : '') : part;
    if (!isId(text)) return null;
    clean.push(text.trim());
  }
  return [iface.trim(), type, ...clean].join(':');
}

/**
 * A bounded memory of ids already handled, for at-least-once delivery: `seen(id)` answers
 * whether the id was handled before and records it either way. The oldest ids are forgotten
 * past `capacity`, so a very late redelivery may pass; the consumer's own writes stay idempotent.
 * @param {{ capacity?: number }} [options]
 * @returns {{ seen: (id: string) => boolean, size: () => number }}
 */
export function createDedupe({ capacity = 2000 } = {}) {
  const limit = Number.isInteger(capacity) && capacity > 0 ? capacity : 2000;
  const ids = new Set();
  return {
    seen(id) {
      if (ids.has(id)) return true;
      ids.add(id);
      if (ids.size > limit) ids.delete(ids.values().next().value);
      return false;
    },
    size: () => ids.size,
  };
}

// ---------------------------------------------------------------------------
// Origin

/**
 * Where an event happened, as the mind needs it.
 * `iface`: the adapter's namespace. `chatType`: one of CHAT_TYPES. `place`: the conversation's
 * id (null for `none`). `parent`: what the place hangs under (a thread's channel, a channel's
 * category), or null. `thread`: the thread's id when the event is inside one, else null.
 * `community`: the server or group the place belongs to, null for a direct chat. `replyToAuthor`:
 * who wrote the message this one replies to (`{ id, name, self }`), or null. `replyExpected`:
 * whether the sender is waiting for an answer (a direct chat, a mention, a reply to the persona);
 * the core may still choose silence. `meta`: platform differences as plain typed data the mind
 * never has to read (`{ placeName, topic, ... }`).
 * @typedef {{ iface: string, chatType: 'dm'|'group'|'channel'|'thread'|'none', place: string|null,
 *   parent: string|null, thread: string|null, community: string|null,
 *   replyToAuthor: { id: string, name: string|null, self: boolean }|null,
 *   replyExpected: boolean, meta: Record<string, unknown> }} Origin
 */

/**
 * Check and normalise an origin: ids trimmed, absent optional fields made null, `replyExpected`
 * defaulting to false, unknown keys dropped (platform extras belong in `meta`).
 * @param {unknown} raw
 * @returns {{ ok: true, origin: Origin } | { ok: false, reason: string }}
 */
export function normalizeOrigin(raw) {
  if (!isObject(raw)) return fail('origin:required');
  if (!isId(raw.iface)) return fail('origin.iface:required');
  if (!CHAT_TYPES.includes(raw.chatType)) return fail('origin.chatType:unknown');
  const needsPlace = raw.chatType !== 'none';
  if (needsPlace && !isId(raw.place)) return fail('origin.place:required');
  if (!needsPlace && raw.place != null && !isId(raw.place)) return fail('origin.place:type');
  for (const key of ['parent', 'thread', 'community']) {
    if (!optionalId(raw[key])) return fail(`origin.${key}:type`);
  }
  if (raw.chatType === 'thread' && !isId(raw.thread ?? raw.place)) return fail('origin.thread:required');
  let replyToAuthor = null;
  if (raw.replyToAuthor != null) {
    if (!isObject(raw.replyToAuthor) || !isId(raw.replyToAuthor.id)) return fail('origin.replyToAuthor.id:required');
    if (raw.replyToAuthor.name != null && !isString(raw.replyToAuthor.name)) return fail('origin.replyToAuthor.name:type');
    if (raw.replyToAuthor.self != null && typeof raw.replyToAuthor.self !== 'boolean') return fail('origin.replyToAuthor.self:type');
    replyToAuthor = {
      id: raw.replyToAuthor.id.trim(),
      name: textOrNull(raw.replyToAuthor.name),
      self: raw.replyToAuthor.self === true,
    };
  }
  if (raw.replyExpected != null && typeof raw.replyExpected !== 'boolean') return fail('origin.replyExpected:type');
  if (raw.meta != null && (!isObject(raw.meta) || !isPlainData(raw.meta))) return fail('origin.meta:type');
  const place = idOrNull(raw.place);
  const thread = idOrNull(raw.thread) ?? (raw.chatType === 'thread' ? place : null);
  return {
    ok: true,
    origin: {
      iface: raw.iface.trim(),
      chatType: raw.chatType,
      place,
      parent: idOrNull(raw.parent),
      thread,
      community: idOrNull(raw.community),
      replyToAuthor,
      replyExpected: raw.replyExpected === true,
      meta: raw.meta ? { ...raw.meta } : {},
    },
  };
}

// ---------------------------------------------------------------------------
// Payloads

/** A person as an event names them: `{ id, name, self, bot }`. */
function normalizeActor(raw, path) {
  if (!isObject(raw)) return fail(`${path}:required`);
  if (!isId(raw.id)) return fail(`${path}.id:required`);
  if (raw.name != null && !isString(raw.name)) return fail(`${path}.name:type`);
  for (const flag of ['self', 'bot']) {
    if (raw[flag] != null && typeof raw[flag] !== 'boolean') return fail(`${path}.${flag}:type`);
  }
  return { ok: true, value: { id: raw.id.trim(), name: textOrNull(raw.name), self: raw.self === true, bot: raw.bot === true } };
}

function normalizeList(raw, path) {
  if (raw == null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return fail(`${path}:type`);
  if (!raw.every((item) => isObject(item) && isPlainData(item))) return fail(`${path}:type`);
  return { ok: true, value: raw.map((item) => ({ ...item })) };
}

function normalizeIdList(raw, path) {
  if (raw == null) return { ok: true, value: [] };
  if (!Array.isArray(raw) || !raw.every(isId)) return fail(`${path}:type`);
  return { ok: true, value: raw.map((id) => id.trim()) };
}

/**
 * `message.created` / `message.edited`: `message` is `{ id, author, text, replyToId, mentions,
 * attachments }`. An edit the adapter could not read whole carries `partial: true` on the event
 * and may omit `text`; a creation always carries it (possibly empty, for an attachment alone).
 */
function normalizeMessage(raw, partial) {
  if (!isObject(raw)) return fail('message:required');
  if (!isId(raw.id)) return fail('message.id:required');
  const author = normalizeActor(raw.author, 'message.author');
  if (!author.ok) return author;
  if (raw.text != null && !isString(raw.text)) return fail('message.text:type');
  if (raw.text == null && !partial) return fail('message.text:required');
  if (!optionalId(raw.replyToId)) return fail('message.replyToId:type');
  if (raw.at != null && !isTime(raw.at)) return fail('message.at:type');
  const mentions = isObject(raw.mentions) ? raw.mentions : {};
  if (raw.mentions != null && !isObject(raw.mentions)) return fail('message.mentions:type');
  if (mentions.self != null && typeof mentions.self !== 'boolean') return fail('message.mentions.self:type');
  const userIds = normalizeIdList(mentions.userIds, 'message.mentions.userIds');
  if (!userIds.ok) return userIds;
  const placeIds = normalizeIdList(mentions.placeIds, 'message.mentions.placeIds');
  if (!placeIds.ok) return placeIds;
  const attachments = normalizeList(raw.attachments, 'message.attachments');
  if (!attachments.ok) return attachments;
  const message = {
    id: raw.id.trim(),
    author: author.value,
    text: raw.text ?? null,
    at: raw.at ?? null,
    replyToId: idOrNull(raw.replyToId),
    mentions: { self: mentions.self === true, userIds: userIds.value, placeIds: placeIds.value },
    attachments: attachments.value,
  };
  return { ok: true, payload: partial ? { message, partial: true } : { message } };
}

function normalizeDeleted(raw) {
  if (!isObject(raw)) return fail('message:required');
  if (!isId(raw.id)) return fail('message.id:required');
  return { ok: true, payload: { message: { id: raw.id.trim() } } };
}

function normalizeReaction(event) {
  if (!isId(event.messageId)) return fail('messageId:required');
  const emoji = event.emoji;
  if (!isObject(emoji)) return fail('emoji:required');
  if (emoji.name != null && !isString(emoji.name)) return fail('emoji.name:type');
  if (!optionalId(emoji.id)) return fail('emoji.id:type');
  if (!isId(emoji.name) && !isId(emoji.id)) return fail('emoji:required');
  const actor = normalizeActor(event.actor, 'actor');
  if (!actor.ok) return actor;
  return {
    ok: true,
    payload: { messageId: event.messageId.trim(), emoji: { name: textOrNull(emoji.name), id: idOrNull(emoji.id) }, actor: actor.value },
  };
}

function normalizeMembership(event) {
  const member = normalizeActor(event.member, 'member');
  if (!member.ok) return member;
  return { ok: true, payload: { member: member.value } };
}

/** `voice.state`: `from` and `to` are voice places (null: not in voice); they differ. */
function normalizeVoice(event) {
  const member = normalizeActor(event.member, 'member');
  if (!member.ok) return member;
  if (!optionalId(event.from)) return fail('from:type');
  if (!optionalId(event.to)) return fail('to:type');
  const from = idOrNull(event.from);
  const to = idOrNull(event.to);
  if (from === null && to === null) return fail('to:required');
  if (from === to) return fail('to:unchanged');
  const flags = {};
  for (const flag of ['muted', 'deafened', 'streaming']) {
    if (event[flag] != null && typeof event[flag] !== 'boolean') return fail(`${flag}:type`);
    flags[flag] = event[flag] === true;
  }
  return { ok: true, payload: { member: member.value, from, to, ...flags } };
}

// ---------------------------------------------------------------------------
// Events

/**
 * Check and normalise an inbound event. The result carries only the known keys of its type
 * (platform objects and extras do not survive), every optional field filled, ids trimmed.
 * Idempotent: normalising a normalised event returns an equal one.
 * @param {unknown} raw
 * @returns {{ ok: true, event: object } | { ok: false, reason: string }}
 */
export function normalizeEvent(raw) {
  if (!isObject(raw)) return fail('event:required');
  if (!EVENT_TYPES.includes(raw.type)) return fail('type:unknown');
  if (!isId(raw.id)) return fail('id:required');
  if (!isTime(raw.at)) return fail('at:type');
  const origin = normalizeOrigin(raw.origin);
  if (!origin.ok) return origin;
  let part;
  switch (raw.type) {
    case MESSAGE_CREATED:
    case MESSAGE_EDITED:
      if (raw.partial != null && typeof raw.partial !== 'boolean') return fail('partial:type');
      if (raw.partial === true && raw.type !== MESSAGE_EDITED) return fail('partial:unsupported');
      part = normalizeMessage(raw.message, raw.partial === true);
      break;
    case MESSAGE_DELETED:
      part = normalizeDeleted(raw.message);
      break;
    case REACTION_ADDED:
    case REACTION_REMOVED:
      part = normalizeReaction(raw);
      break;
    case MEMBER_JOINED:
    case MEMBER_LEFT:
      part = normalizeMembership(raw);
      break;
    default:
      part = normalizeVoice(raw);
  }
  if (!part.ok) return part;
  return { ok: true, event: { id: raw.id.trim(), type: raw.type, at: raw.at, origin: origin.origin, ...part.payload } };
}

/**
 * Whether `raw` is a valid inbound event.
 * @param {unknown} raw
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateEvent(raw) {
  const result = normalizeEvent(raw);
  return result.ok ? { ok: true } : fail(result.reason);
}

// ---------------------------------------------------------------------------
// Envelope

/**
 * Check and normalise an envelope `{ v, id, type, replyTo, body }`. `v` must equal
 * ENVELOPE_VERSION. `ack` and `action_result` must name the envelope they answer in `replyTo`;
 * every other type may carry null. An `event` envelope's `body.event` is normalised as an
 * event. `hello` needs `body.iface`; `action` needs `body.action` (a name; its shape is checked
 * by the protocol package); the rest need a plain-object body (`{}` allowed).
 * @param {unknown} raw
 * @returns {{ ok: true, envelope: { v: number, id: string, type: string, replyTo: string|null, body: object } } | { ok: false, reason: string }}
 */
export function normalizeEnvelope(raw) {
  if (!isObject(raw)) return fail('envelope:required');
  if (raw.v !== ENVELOPE_VERSION) return fail('v:unsupported');
  if (!ENVELOPE_TYPES.includes(raw.type)) return fail('type:unknown');
  if (!isId(raw.id)) return fail('id:required');
  if (!optionalId(raw.replyTo)) return fail('replyTo:type');
  if (ANSWERS.includes(raw.type) && !isId(raw.replyTo)) return fail('replyTo:required');
  const body = raw.body ?? {};
  if (!isObject(body)) return fail('body:type');
  let clean;
  switch (raw.type) {
    case 'event': {
      const event = normalizeEvent(body.event);
      if (!event.ok) return fail(`body.event.${event.reason}`);
      clean = { event: event.event };
      break;
    }
    case 'hello':
      if (!isId(body.iface)) return fail('body.iface:required');
      if (body.capabilities != null && !(Array.isArray(body.capabilities) && body.capabilities.every(isId))) return fail('body.capabilities:type');
      clean = { iface: body.iface.trim(), capabilities: [...(body.capabilities ?? [])] };
      break;
    case 'action':
      if (!isObject(body.action) || !isId(body.action.action)) return fail('body.action.action:required');
      if (!isPlainData(body.action)) return fail('body.action:type');
      clean = { action: { ...body.action } };
      break;
    case 'action_result':
      if (!isObject(body.result) || !isId(body.result.status)) return fail('body.result.status:required');
      if (!isPlainData(body.result)) return fail('body.result:type');
      clean = { result: { ...body.result } };
      break;
    default:
      if (!isPlainData(body)) return fail('body:type');
      clean = raw.type === 'ping' ? OWN_KEYS(body, ['at']) : {};
      if ('at' in clean && !isTime(clean.at)) return fail('body.at:type');
  }
  return { ok: true, envelope: { v: ENVELOPE_VERSION, id: raw.id.trim(), type: raw.type, replyTo: idOrNull(raw.replyTo), body: clean } };
}

/**
 * Whether `raw` is a valid envelope.
 * @param {unknown} raw
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateEnvelope(raw) {
  const result = normalizeEnvelope(raw);
  return result.ok ? { ok: true } : fail(result.reason);
}

/**
 * Wrap a normalised event in an `event` envelope whose id is the event's id, so a redelivered
 * envelope and its event share one idempotency key.
 * @param {object} event a normalised event
 * @returns {{ v: number, id: string, type: 'event', replyTo: null, body: { event: object } }}
 */
export function eventEnvelope(event) {
  return { v: ENVELOPE_VERSION, id: event.id, type: 'event', replyTo: null, body: { event } };
}

/**
 * The `ack` answering an envelope. Its id derives from the answered one, so repeated acks are
 * the same ack.
 * @param {{ id: string }} envelope
 * @returns {{ v: number, id: string, type: 'ack', replyTo: string, body: {} }}
 */
export function ackFor(envelope) {
  return { v: ENVELOPE_VERSION, id: `ack:${envelope.id}`, type: 'ack', replyTo: envelope.id, body: {} };
}
