// Boundary checks of the protocol: the shape of an inbound event (events.js) and of an outbound
// action (actions.js) -- known kinds, required keys, string ids, finite numbers, booleans where a
// flag is due. They answer `{ ok: true }` or `{ ok: false, reason }`, `reason` naming the field
// and the problem (`message.at:type`, `kind:unknown`), and never throw, whatever they are given:
// a bad event is dropped by the caller with one log line, a bad action refused as `failed`.
// Shapes only: whether a reference belongs to an interface, whether content fits its limits and
// who may do what stay with the adapter and the core. Keys starting with `raw` are an adapter's
// private handles to its platform's objects (removed once the adapters live in their own
// packages) and are never looked at.

import { ACTIONS, CAPABILITIES, COMMAND_RESULT, MESSAGES_FETCH } from './actions.js';
import { isReadAction, messageExtrasProblem, readActionProblem } from './reads.ts';
import {
  ACTIVITY_KINDS,
  CHAT_TYPES,
  CONNECTION_CHANGED,
  CONNECTION_STATES,
  CONVERSATION_CHANGED,
  CONVERSATION_CHANGES,
  COMMAND_REQUESTED,
  CONVERSATION_CHAT_TYPES,
  CONVERSATION_KINDS,
  CORE_KINDS,
  EVENT_KINDS,
  INNER_WAKE,
  MEMBERSHIP_CHANGES,
  MEMBERSHIP_CHANGED,
  MESSAGE_RECEIVED,
  PRESENCE_CHANGED,
  PRESENCE_SNAPSHOT,
  PRESENCE_STATUSES,
  REACTION_CHANGED,
  SCHEDULER_TICK,
  ERRAND_DONE,
  VOICE_CHANGED,
} from './events.js';

const VALID = Object.freeze({ ok: true });

/** A refusal naming `field` and its `problem`. */
class Refusal extends Error {
  constructor(field, problem) {
    super(`${field}:${problem}`);
    this.reason = `${field}:${problem}`;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/**
 * Reads `value` as a record, after `need(value, field, isObject)` has accepted it.
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
const asRecord = (value) => /** @type {Record<string, unknown>} */ (value);
/** @type {(value: unknown) => boolean} */
const isBoolean = (value) => typeof value === 'boolean';
/** @type {(value: unknown) => boolean} */
const isString = (value) => typeof value === 'string';
/** @type {(value: unknown) => boolean} */
const isIdOrNull = (value) => value === null || isId(value);
/**
 * A check for a string from `list`.
 * @param {readonly string[]} list
 * @returns {(value: unknown) => boolean}
 */
const isOneOf = (list) => (value) => typeof value === 'string' && list.includes(value);
const isId = (value) => typeof value === 'string' && value !== '';
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isNullableString = (value) => value === null || typeof value === 'string';

/** Throws a Refusal unless `check(value)`; `required: false` lets undefined through. */
function need(value, field, check, { required = true, problem = 'type' } = {}) {
  if (value === undefined) {
    if (required) throw new Refusal(field, 'required');
    return;
  }
  if (!check(value)) throw new Refusal(field, problem);
}

/** Throws a Refusal unless `value` is an array of non-empty strings. */
function needIds(value, field) {
  need(value, field, Array.isArray);
  value.forEach((id, index) => need(id, `${field}.${index}`, isId));
}

/**
 * Throws a Refusal unless `value` is an array; runs `check(entry, path)` on each entry, `path` being `field.index`.
 * @param {unknown} value
 * @param {string} field
 * @param {(entry: unknown, path: string) => void} check
 */
function eachEntry(value, field, check) {
  need(value, field, Array.isArray);
  /** @type {unknown[]} */ (value).forEach((entry, index) => check(entry, `${field}.${index}`));
}

/**
 * Throws a Refusal unless the `avatar` of `owner` (when present) is `{ hash, url }`, each a string or null.
 * @param {unknown} owner an object already checked
 * @param {string} field
 */
function checkAvatar(owner, field) {
  const avatar = asRecord(owner).avatar;
  need(avatar, field, isObject, { required: false });
  if (avatar === undefined) return;
  const { hash, url } = asRecord(avatar);
  need(hash, `${field}.hash`, isNullableString);
  need(url, `${field}.url`, isNullableString);
}

/** Runs `check` and turns its refusal into a result; any other error is a refusal too, never a throw. */
function verdict(check) {
  try {
    check();
    return VALID;
  } catch (err) {
    return { ok: false, reason: err instanceof Refusal ? err.reason : 'malformed' };
  }
}

// ---------------------------------------------------------------------------
// Inbound events

function checkConversation(conversation) {
  need(conversation, 'conversation', isObject);
  need(conversation.id, 'conversation.id', isId);
  need(conversation.kind, 'conversation.kind', (kind) => CONVERSATION_KINDS.includes(kind), { problem: 'unknown' });
  for (const key of ['communityId', 'name', 'topic', 'category', 'parentId'])
    need(conversation[key], `conversation.${key}`, isNullableString, { required: false });
  need(conversation.chatType, 'conversation.chatType', (value) => CONVERSATION_CHAT_TYPES.includes(value), {
    required: false,
    problem: 'unknown',
  });
  need(conversation.partnerId, 'conversation.partnerId', (value) => value === null || isId(value), { required: false });
}

/** The values of `reaction.changed`'s `cleared`. */
const CLEARED = ['emoji', 'all'];
const MESSAGE_LISTS = ['attachments', 'links', 'forwarded', 'stickers', 'emojis', 'reactions'];

function checkMessage(message) {
  need(message.author, 'message.author', isObject);
  need(message.author.id, 'message.author.id', isId);
  need(message.author.name, 'message.author.name', isNullableString);
  need(message.author.self, 'message.author.self', (value) => typeof value === 'boolean');
  need(message.author.bot, 'message.author.bot', (value) => typeof value === 'boolean');
  checkAvatar(message.author, 'message.author.avatar');
  need(message.content, 'message.content', (value) => typeof value === 'string');
  need(message.at, 'message.at', isFiniteNumber);
  for (const key of ['replyToId', 'replyPingUserId'])
    need(message[key], `message.${key}`, (value) => value === null || isId(value));
  need(message.forwardedFrom, 'message.forwardedFrom', isNullableString);
  for (const key of MESSAGE_LISTS) need(message[key], `message.${key}`, Array.isArray);
}

function checkAddressing(addressing) {
  need(addressing, 'addressing', isObject);
  need(addressing.mentioned, 'addressing.mentioned', (value) => typeof value === 'boolean');
  need(addressing.replyToSelf, 'addressing.replyToSelf', (value) => typeof value === 'boolean');
  needIds(addressing.mentionedUserIds, 'addressing.mentionedUserIds');
  needIds(addressing.mentionedConversationIds, 'addressing.mentionedConversationIds');
}

function checkOrigin(origin) {
  need(origin, 'origin', isObject);
  need(origin.chatType, 'origin.chatType', (value) => CHAT_TYPES.includes(value), { problem: 'unknown' });
  need(origin.place, 'origin.place', isId);
  for (const key of ['parent', 'thread', 'replyToAuthorId'])
    need(origin[key], `origin.${key}`, (value) => value === null || isId(value));
  need(origin.replyExpected, 'origin.replyExpected', (value) => value === null || typeof value === 'boolean');
}

/**
 * Throws the Refusal of a problem a typed check found; nothing for null.
 * @param {readonly [string, string]|null} problem  `[field, problem]`.
 */
function throwProblem(problem) {
  if (problem !== null) throw new Refusal(problem[0], problem[1]);
}

/** Whether `message` passes the whole-message check (`previous` of an edit). */
function wholeMessage(message) {
  try {
    checkMessage(message);
    return true;
  } catch {
    return false;
  }
}

function checkMessageReceived(event) {
  checkConversation(event.conversation);
  if (event.origin !== undefined) checkOrigin(event.origin);
  for (const flag of ['edit', 'deleted', 'partial'])
    need(event[flag], flag, (value) => typeof value === 'boolean', { required: false });
  need(event.message, 'message', isObject);
  need(event.message.id, 'message.id', isId);
  throwProblem(messageExtrasProblem(event, wholeMessage));
  if (event.deleted === true) return;
  if (event.partial === true) {
    if (event.edit !== true) throw new Refusal('partial', 'edit-only');
    return;
  }
  checkMessage(event.message);
  checkAddressing(event.addressing);
}

function checkReactionChanged(event) {
  checkConversation(event.conversation);
  need(event.messageId, 'messageId', isId);
  need(event.authorId, 'authorId', (value) => value === null || isId(value), { required: false });
  need(event.cleared, 'cleared', (value) => CLEARED.includes(value), { required: false, problem: 'unknown' });
  need(event.added, 'added', (value) => typeof value === 'boolean');
  if (event.cleared !== undefined) {
    // A clear is never a put-on; who cleared is not part of it, and clearing all names no emoji.
    if (event.added !== false) throw new Refusal('added', 'cleared');
    need(event.userId, 'userId', (value) => value === null || isId(value), { required: false });
    if (event.cleared === 'all' && (event.emoji === undefined || event.emoji === null)) return;
  } else {
    need(event.userId, 'userId', isId);
  }
  need(event.emoji, 'emoji', isObject);
  need(event.emoji.id, 'emoji.id', isId, { required: false });
  need(event.emoji.name, 'emoji.name', isNullableString);
  // A unicode emoji is its name; a custom one is known by its id even when its name is not.
  if (!isId(event.emoji.name) && !isId(event.emoji.id)) throw new Refusal('emoji', 'required');
}

function checkCommandRequested(event) {
  checkConversation(event.conversation);
  need(event.name, 'name', isId);
  need(event.args, 'args', isObject);
  need(event.requester, 'requester', isObject);
  need(event.requester.id, 'requester.id', isId);
  need(event.requester.name, 'requester.name', isNullableString);
  needIds(event.requester.roles, 'requester.roles');
  need(event.requester.owner, 'requester.owner', (value) => typeof value === 'boolean');
  need(event.replyRef, 'replyRef', isId);
}

function checkErrandDone(event) {
  need(event.errandId, 'errandId', isId);
  need(event.status, 'status', isId);
  need(event.communityId, 'communityId', isNullableString, { required: false });
}

function checkInnerWake(event) {
  need(event.id, 'id', isId);
  need(event.communityId, 'communityId', isNullableString, { required: false });
  need(event.wake, 'wake', isObject);
  need(event.wake.kind, 'wake.kind', isId);
}

function checkMembershipChanged(event) {
  need(event.communityId, 'communityId', isId);
  need(event.userId, 'userId', isId);
  need(event.change, 'change', (value) => MEMBERSHIP_CHANGES.includes(value), { problem: 'unknown' });
  need(event.member, 'member', isObject, { required: false });
  if (event.member !== undefined) {
    need(event.member.id, 'member.id', isId);
    need(event.member.name, 'member.name', isNullableString);
    need(event.member.bot, 'member.bot', (value) => typeof value === 'boolean');
    checkAvatar(event.member, 'member.avatar');
  }
}

/**
 * The fields of a voice state, on `voice.changed` itself (`prefix` empty) or on an entry of a snapshot.
 * @param {unknown} event an object already checked
 * @param {string} prefix
 */
function checkVoiceState(event, prefix) {
  const state = asRecord(event);
  need(state.communityId, `${prefix}communityId`, isId);
  need(state.userId, `${prefix}userId`, isId);
  need(state.name, `${prefix}name`, isNullableString, { required: false });
  for (const key of ['conversationId', 'previousId']) need(state[key], `${prefix}${key}`, isIdOrNull);
  for (const flag of ['muted', 'deafened', 'streaming', 'camera'])
    need(state[flag], `${prefix}${flag}`, isBoolean, { required: false });
}

/**
 * @param {unknown} activity
 * @param {string} path
 */
function checkActivity(activity, path) {
  need(activity, path, isObject);
  const fields = asRecord(activity);
  need(fields.kind, `${path}.kind`, isOneOf(ACTIVITY_KINDS), { problem: 'unknown' });
  for (const key of ['name', 'details', 'state']) need(fields[key], `${path}.${key}`, isString);
}

/**
 * The fields of a presence, on `presence.changed` itself (`prefix` empty) or on an entry of a snapshot.
 * @param {unknown} event an object already checked
 * @param {string} prefix
 */
function checkPresenceState(event, prefix) {
  const state = asRecord(event);
  need(state.userId, `${prefix}userId`, isId);
  need(state.name, `${prefix}name`, isNullableString);
  need(state.status, `${prefix}status`, isOneOf(PRESENCE_STATUSES), { problem: 'unknown' });
  eachEntry(state.activities, `${prefix}activities`, checkActivity);
}

/**
 * @param {unknown} event
 * @param {string} field
 * @param {(entry: unknown, prefix: string) => void} check
 */
function checkEntries(event, field, check) {
  eachEntry(asRecord(event)[field], field, (entry, path) => {
    need(entry, path, isObject);
    check(entry, `${path}.`);
  });
}

/** @param {unknown} event */
function checkPresenceSnapshot(event) {
  checkEntries(event, 'voice', checkVoiceState);
  checkEntries(event, 'presence', checkPresenceState);
}

/** @param {unknown} event */
function checkConversationChanged(event) {
  const { conversation, change } = asRecord(event);
  checkConversation(conversation);
  need(change, 'change', isOneOf(CONVERSATION_CHANGES), { problem: 'unknown' });
}

/** @param {unknown} event */
function checkConnectionChanged(event) {
  need(asRecord(event).state, 'state', isOneOf(CONNECTION_STATES), { problem: 'unknown' });
}

const EVENT_CHECKS = {
  [MESSAGE_RECEIVED]: checkMessageReceived,
  [REACTION_CHANGED]: checkReactionChanged,
  [COMMAND_REQUESTED]: checkCommandRequested,
  [SCHEDULER_TICK]: () => {},
  [ERRAND_DONE]: checkErrandDone,
  [MEMBERSHIP_CHANGED]: checkMembershipChanged,
  [VOICE_CHANGED]: (event) => checkVoiceState(event, ''),
  [INNER_WAKE]: checkInnerWake,
  [PRESENCE_CHANGED]: (event) => checkPresenceState(event, ''),
  [PRESENCE_SNAPSHOT]: checkPresenceSnapshot,
  [CONVERSATION_CHANGED]: checkConversationChanged,
  [CONNECTION_CHANGED]: checkConnectionChanged,
};

/**
 * Whether `event` is a well-formed inbound event (events.js): its kind known, `at` a finite
 * number, and for an interface's kinds `iface` and `id` non-empty strings and a conversation;
 * then the kind's own fields. Never throws.
 * @param {unknown} event
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateEvent(event) {
  return verdict(() => {
    need(event, 'event', isObject);
    need(event.kind, 'kind', (kind) => EVENT_KINDS.includes(kind), { problem: 'unknown' });
    need(event.at, 'at', isFiniteNumber);
    const own = CORE_KINDS.includes(event.kind);
    need(event.iface, 'iface', isId, { required: !own });
    need(event.id, 'id', isId, { required: !own });
    EVENT_CHECKS[event.kind](event);
  });
}

// ---------------------------------------------------------------------------
// Outbound actions

function checkRef(ref, field, { needMessage }) {
  need(ref, field, isObject);
  need(ref.iface, `${field}.iface`, isId);
  need(ref.conversationId, `${field}.conversationId`, isId);
  need(ref.messageId, `${field}.messageId`, isId, { required: needMessage });
}

/** The content of a send or an edit; null stands for an absent part, as the port reads it. */
function checkContent(content) {
  need(content, 'content', isObject);
  need(content.text, 'content.text', isNullableString, { required: false });
  need(content.attachments, 'content.attachments', (value) => value === null || Array.isArray(value), {
    required: false,
  });
  need(content.mentions, 'content.mentions', (value) => value === null || isObject(value), { required: false });
  need(content.replyTo, 'content.replyTo', (value) => value === null || isObject(value), { required: false });
}

function checkCommandResult(action) {
  need(action.replyRef, 'replyRef', isId);
  need(action.text, 'text', (value) => typeof value === 'string');
  need(action.files, 'files', Array.isArray, { required: false });
  need(action.ephemeral, 'ephemeral', (value) => typeof value === 'boolean', { required: false });
}

/**
 * Whether `action` is a well-formed outbound action (actions.js): a known `action` name, a
 * target reference with string ids (a message's with its `messageId`), an object `content` for a
 * send or an edit, a string `emoji` for a reaction, for a message fetch the `messageIds`, and for a command
 * result its `replyRef` and `text`. An `idempotencyKey`, when present, is a non-empty string. What the content holds and whose the target is stay the adapter's checks. Never throws.
 * @param {unknown} action
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateAction(action) {
  return verdict(() => {
    need(action, 'action', isObject);
    need(action.action, 'action', (name) => ACTIONS.includes(name) || isReadAction(name), {
      problem: 'unknown',
    });
    need(action.idempotencyKey, 'idempotencyKey', isId, { required: false });
    throwProblem(readActionProblem(action));
    switch (action.action) {
      case 'conversation.info':
      case 'conversations.list':
      case 'messages.history':
      case 'member.info':
      case 'messages.search':
      case 'members.search':
      case 'emoji.list':
      case 'links.parse':
      case 'message.reactors':
        return;
      case MESSAGES_FETCH:
        checkRef(action.conversation, 'conversation', { needMessage: false });
        needIds(action.messageIds, 'messageIds');
        return;
      case CAPABILITIES.send:
        checkRef(action.conversation, 'conversation', { needMessage: false });
        checkContent(action.content);
        return;
      case CAPABILITIES.edit:
        checkRef(action.message, 'message', { needMessage: true });
        checkContent(action.content);
        return;
      case CAPABILITIES.delete:
        checkRef(action.message, 'message', { needMessage: true });
        return;
      case CAPABILITIES.react:
      case CAPABILITIES.unreact:
        checkRef(action.message, 'message', { needMessage: true });
        need(action.emoji, 'emoji', (value) => typeof value === 'string');
        return;
      case CAPABILITIES.typing:
        checkRef(action.conversation, 'conversation', { needMessage: false });
        return;
      case COMMAND_RESULT:
        checkCommandResult(action);
        return;
      default:
        throw new Refusal('action', 'unknown');
    }
  });
}
