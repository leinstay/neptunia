// Boundary checks of the protocol: the shape of an inbound event (events.ts) and of an outbound
// action (actions.ts) -- known kinds, required keys, string ids, finite numbers, booleans where a
// flag is due. They answer `{ ok: true }` or `{ ok: false, reason }`, `reason` naming the field
// and the problem (`message.at:type`, `kind:unknown`), and never throw, whatever they are given:
// a bad event is dropped by the caller with one log line, a bad action refused as `failed`.
// Shapes only: whether a reference belongs to an interface, whether content fits its limits and
// who may do what stay with the adapter and the core. Keys starting with `raw` are an adapter's
// private handles to its platform's objects (removed once the adapters live in their own
// packages) and are never looked at.

import { ACTIONS, CAPABILITIES, COMMAND_RESULT, MESSAGES_FETCH } from './actions.ts';
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
} from './events.ts';

const VALID = Object.freeze({ ok: true as const });

/** A refusal naming `field` and its `problem`. */
class Refusal extends Error {
  reason: string;

  constructor(field: string, problem: string) {
    super(`${field}:${problem}`);
    this.reason = `${field}:${problem}`;
  }
}

type Rec = Record<string, unknown>;
const isObject = (value: unknown): value is Rec => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Reads `value` as a record, after `need(value, field, isObject)` has accepted it. */
const asRecord = (value: unknown): Rec => value as Rec;
const isBoolean: (value: unknown) => boolean = (value) => typeof value === 'boolean';
const isString: (value: unknown) => boolean = (value) => typeof value === 'string';
const isIdOrNull: (value: unknown) => boolean = (value) => value === null || isId(value);
/** A check for a string from `list`. */
const isOneOf =
  (list: ReadonlyArray<string>): ((value: unknown) => boolean) =>
  (value) =>
    typeof value === 'string' && list.includes(value);
const isId = (value: unknown): boolean => typeof value === 'string' && value !== '';
const isFiniteNumber = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);
const isNullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const isNullableId = (value: unknown): boolean => value === null || isId(value);

/** Throws a Refusal unless `check(value)`; `required: false` lets undefined through. */
function need(
  value: unknown,
  field: string,
  check: (value: unknown) => boolean,
  { required = true, problem = 'type' }: { required?: boolean; problem?: string } = {}
): void {
  if (value === undefined) {
    if (required) throw new Refusal(field, 'required');
    return;
  }
  if (!check(value)) throw new Refusal(field, problem);
}

/** Throws a Refusal unless `value` is an array of non-empty strings. */
function needIds(value: unknown, field: string): void {
  need(value, field, Array.isArray);
  (value as Array<unknown>).forEach((id, index) => need(id, `${field}.${index}`, isId));
}

/** Throws a Refusal unless `value` is an array; runs `check(entry, path)` on each entry, `path` being `field.index`. */
function eachEntry(value: unknown, field: string, check: (entry: unknown, path: string) => void) {
  need(value, field, Array.isArray);
  (value as Array<unknown>).forEach((entry, index) => check(entry, `${field}.${index}`));
}

/**
 * Throws a Refusal unless the `avatar` of `owner` (when present) is `{ hash, url }`, each a string or null.
 * @param owner an object already checked
 */
function checkAvatar(owner: unknown, field: string) {
  const avatar = asRecord(owner).avatar;
  need(avatar, field, isObject, { required: false });
  if (avatar === undefined) return;
  const { hash, url } = asRecord(avatar);
  need(hash, `${field}.hash`, isNullableString);
  need(url, `${field}.url`, isNullableString);
}

/** Runs `check` and turns its refusal into a result; any other error is a refusal too, never a throw. */
function verdict(check: () => void): { ok: true } | { ok: false; reason: string } {
  try {
    check();
    return VALID;
  } catch (err) {
    return { ok: false, reason: err instanceof Refusal ? err.reason : 'malformed' };
  }
}

// ---------------------------------------------------------------------------
// Inbound events

function checkConversation(given: unknown): void {
  need(given, 'conversation', isObject);
  const conversation = asRecord(given);
  need(conversation.id, 'conversation.id', isId);
  need(conversation.kind, 'conversation.kind', isOneOf(CONVERSATION_KINDS), { problem: 'unknown' });
  for (const key of ['rootId', 'name', 'topic', 'category', 'parentId'])
    need(conversation[key], `conversation.${key}`, isNullableString, { required: false });
  need(conversation.chatType, 'conversation.chatType', isOneOf(CONVERSATION_CHAT_TYPES), {
    required: false,
    problem: 'unknown',
  });
  need(conversation.partnerId, 'conversation.partnerId', isNullableId, { required: false });
  need(conversation.parentKind, 'conversation.parentKind', isId, { required: false });
  need(conversation.authorityId, 'conversation.authorityId', isId, { required: false });
}

/** The values of `reaction.changed`'s `cleared`. */
const CLEARED = ['emoji', 'all'];
const MESSAGE_LISTS = ['attachments', 'links', 'forwarded', 'stickers', 'emojis', 'reactions'];

function checkMessage(message: Rec): void {
  need(message.author, 'message.author', isObject);
  const author = asRecord(message.author);
  need(author.id, 'message.author.id', isId);
  need(author.name, 'message.author.name', isNullableString);
  need(author.self, 'message.author.self', isBoolean);
  need(author.bot, 'message.author.bot', isBoolean);
  checkAvatar(message.author, 'message.author.avatar');
  need(message.content, 'message.content', isString);
  need(message.at, 'message.at', isFiniteNumber);
  for (const key of ['replyToId', 'replyPingAccountId']) need(message[key], `message.${key}`, isNullableId);
  need(message.forwardedFrom, 'message.forwardedFrom', isNullableString);
  for (const key of MESSAGE_LISTS) need(message[key], `message.${key}`, Array.isArray);
}

function checkAddressing(given: unknown): void {
  need(given, 'addressing', isObject);
  const addressing = asRecord(given);
  need(addressing.mentioned, 'addressing.mentioned', isBoolean);
  need(addressing.replyToSelf, 'addressing.replyToSelf', isBoolean);
  needIds(addressing.mentionedAccountIds, 'addressing.mentionedAccountIds');
  needIds(addressing.mentionedConversationIds, 'addressing.mentionedConversationIds');
}

function checkOrigin(given: unknown): void {
  need(given, 'origin', isObject);
  const origin = asRecord(given);
  need(origin.chatType, 'origin.chatType', isOneOf(CHAT_TYPES), { problem: 'unknown' });
  need(origin.place, 'origin.place', isId);
  for (const key of ['parent', 'thread', 'replyToAuthorId']) need(origin[key], `origin.${key}`, isNullableId);
  need(origin.replyExpected, 'origin.replyExpected', (value) => value === null || typeof value === 'boolean');
}

/**
 * Throws the Refusal of a problem a typed check found; nothing for null.
 * @param problem `[field, problem]`.
 */
function throwProblem(problem: readonly [string, string] | null) {
  if (problem !== null) throw new Refusal(problem[0], problem[1]);
}

/** Whether `message` passes the whole-message check (`previous` of an edit). */
function wholeMessage(message: unknown): boolean {
  try {
    checkMessage(asRecord(message));
    return true;
  } catch {
    return false;
  }
}

function checkMessageReceived(event: Rec): void {
  checkConversation(event.conversation);
  if (event.origin !== undefined) checkOrigin(event.origin);
  for (const flag of ['edit', 'deleted', 'partial']) need(event[flag], flag, isBoolean, { required: false });
  need(event.message, 'message', isObject);
  const message = asRecord(event.message);
  need(message.id, 'message.id', isId);
  throwProblem(messageExtrasProblem(event, wholeMessage));
  if (event.deleted === true) return;
  if (event.partial === true) {
    if (event.edit !== true) throw new Refusal('partial', 'edit-only');
    return;
  }
  checkMessage(message);
  checkAddressing(event.addressing);
}

function checkReactionChanged(event: Rec): void {
  checkConversation(event.conversation);
  need(event.messageId, 'messageId', isId);
  need(event.authorId, 'authorId', isNullableId, { required: false });
  need(event.cleared, 'cleared', isOneOf(CLEARED), { required: false, problem: 'unknown' });
  need(event.added, 'added', isBoolean);
  if (event.cleared !== undefined) {
    // A clear is never a put-on; who cleared is not part of it, and clearing all names no emoji.
    if (event.added !== false) throw new Refusal('added', 'cleared');
    need(event.accountId, 'accountId', isNullableId, { required: false });
    if (event.cleared === 'all' && (event.emoji === undefined || event.emoji === null)) return;
  } else {
    need(event.accountId, 'accountId', isId);
  }
  need(event.emoji, 'emoji', isObject);
  const emoji = asRecord(event.emoji);
  need(emoji.id, 'emoji.id', isId, { required: false });
  need(emoji.name, 'emoji.name', isNullableString);
  // A unicode emoji is its name; a custom one is known by its id even when its name is not.
  if (!isId(emoji.name) && !isId(emoji.id)) throw new Refusal('emoji', 'required');
}

function checkCommandRequested(event: Rec): void {
  checkConversation(event.conversation);
  need(event.name, 'name', isId);
  need(event.args, 'args', isObject);
  need(event.requester, 'requester', isObject);
  const requester = asRecord(event.requester);
  need(requester.id, 'requester.id', isId);
  need(requester.name, 'requester.name', isNullableString);
  needIds(requester.roles, 'requester.roles');
  need(requester.owner, 'requester.owner', isBoolean);
  need(event.replyRef, 'replyRef', isId);
  need(event.dialogId, 'dialogId', isId, { required: false });
  need(event.answer, 'answer', isString, { required: false });
  if ((event.dialogId === undefined) !== (event.answer === undefined)) throw new Refusal('answer', 'required');
}

function checkErrandDone(event: Rec): void {
  need(event.errandId, 'errandId', isId);
  need(event.status, 'status', isId);
}

function checkInnerWake(event: Rec): void {
  need(event.id, 'id', isId);
  need(event.wake, 'wake', isObject);
  need(asRecord(event.wake).kind, 'wake.kind', isId);
}

function checkMembershipChanged(event: Rec): void {
  need(event.placeId, 'placeId', isId);
  need(event.accountId, 'accountId', isId);
  need(event.change, 'change', isOneOf(MEMBERSHIP_CHANGES), { problem: 'unknown' });
  need(event.member, 'member', isObject, { required: false });
  if (event.member !== undefined) {
    const member = asRecord(event.member);
    need(member.id, 'member.id', isId);
    need(member.name, 'member.name', isNullableString);
    need(member.bot, 'member.bot', isBoolean);
    checkAvatar(event.member, 'member.avatar');
  }
}

/**
 * The fields of a voice state, on `voice.changed` itself (`prefix` empty) or on an entry of a snapshot.
 * @param event an object already checked
 */
function checkVoiceState(event: unknown, prefix: string) {
  const state = asRecord(event);
  need(state.placeId, `${prefix}placeId`, isId);
  need(state.accountId, `${prefix}accountId`, isId);
  need(state.name, `${prefix}name`, isNullableString, { required: false });
  for (const key of ['conversationId', 'previousId']) need(state[key], `${prefix}${key}`, isIdOrNull);
  for (const flag of ['muted', 'deafened', 'streaming', 'camera'])
    need(state[flag], `${prefix}${flag}`, isBoolean, { required: false });
}

function checkActivity(activity: unknown, path: string) {
  need(activity, path, isObject);
  const fields = asRecord(activity);
  need(fields.kind, `${path}.kind`, isOneOf(ACTIVITY_KINDS), { problem: 'unknown' });
  for (const key of ['name', 'details', 'state']) need(fields[key], `${path}.${key}`, isString);
}

/**
 * The fields of a presence, on `presence.changed` itself (`prefix` empty) or on an entry of a snapshot.
 * @param event an object already checked
 */
function checkPresenceState(event: unknown, prefix: string) {
  const state = asRecord(event);
  need(state.accountId, `${prefix}accountId`, isId);
  need(state.name, `${prefix}name`, isNullableString);
  need(state.status, `${prefix}status`, isOneOf(PRESENCE_STATUSES), { problem: 'unknown' });
  eachEntry(state.activities, `${prefix}activities`, checkActivity);
}

function checkEntries(event: unknown, field: string, check: (entry: unknown, prefix: string) => void) {
  eachEntry(asRecord(event)[field], field, (entry, path) => {
    need(entry, path, isObject);
    check(entry, `${path}.`);
  });
}

function checkPresenceSnapshot(event: unknown) {
  checkEntries(event, 'voice', checkVoiceState);
  checkEntries(event, 'presence', checkPresenceState);
}

function checkConversationChanged(event: unknown) {
  const { conversation, change } = asRecord(event);
  checkConversation(conversation);
  need(change, 'change', isOneOf(CONVERSATION_CHANGES), { problem: 'unknown' });
}

function checkConnectionChanged(event: unknown) {
  need(asRecord(event).state, 'state', isOneOf(CONNECTION_STATES), { problem: 'unknown' });
}

const EVENT_CHECKS: Record<string, (event: Rec) => void> = {
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
 * Whether `event` is a well-formed inbound event (events.ts): its kind known, `at` a finite
 * number, and for an interface's kinds `iface` and `id` non-empty strings and a conversation;
 * then the kind's own fields. Never throws.
 */
export function validateEvent(given: unknown): { ok: true } | { ok: false; reason: string } {
  return verdict(() => {
    need(given, 'event', isObject);
    const event = asRecord(given);
    need(event.kind, 'kind', isOneOf(EVENT_KINDS), { problem: 'unknown' });
    need(event.at, 'at', isFiniteNumber);
    const own = isOneOf(CORE_KINDS)(event.kind);
    need(event.iface, 'iface', isId, { required: !own });
    need(event.id, 'id', isId, { required: !own });
    EVENT_CHECKS[String(event.kind)](event);
  });
}

// ---------------------------------------------------------------------------
// Outbound actions

function checkRef(given: unknown, field: string, { needMessage }: { needMessage: boolean }): void {
  need(given, field, isObject);
  const ref = asRecord(given);
  need(ref.iface, `${field}.iface`, isId);
  need(ref.conversationId, `${field}.conversationId`, isId);
  need(ref.messageId, `${field}.messageId`, isId, { required: needMessage });
}

/** The content of a send or an edit; null stands for an absent part, as the port reads it. */
function checkContent(given: unknown): void {
  need(given, 'content', isObject);
  const content = asRecord(given);
  need(content.text, 'content.text', isNullableString, { required: false });
  need(content.attachments, 'content.attachments', (value) => value === null || Array.isArray(value), {
    required: false,
  });
  need(content.mentions, 'content.mentions', (value) => value === null || isObject(value), { required: false });
  need(content.replyTo, 'content.replyTo', (value) => value === null || isObject(value), { required: false });
}

function checkCommandResult(action: Rec): void {
  need(action.replyRef, 'replyRef', isId);
  need(action.text, 'text', isString);
  need(action.files, 'files', Array.isArray, { required: false });
  need(action.ephemeral, 'ephemeral', isBoolean, { required: false });
  need(action.status, 'status', isId, { required: false });
  need(action.code, 'code', isId, { required: false });
  // The fields of a question (status `ask`): the dialog it opens, its prompt, whether the answer is typed unseen, the choices.
  need(action.dialogId, 'dialogId', isId, { required: false });
  need(action.prompt, 'prompt', isString, { required: false });
  need(action.secret, 'secret', isBoolean, { required: false });
  need(action.choices, 'choices', Array.isArray, { required: false });
}

/**
 * Whether `action` is a well-formed outbound action (actions.ts): a known `action` name, a
 * target reference with string ids (a message's with its `messageId`), an object `content` for a
 * send or an edit, a string `emoji` for a reaction, for a message fetch the `messageIds`, and for a command
 * result its `replyRef` and `text` (and, when present, its `status`, the command's outcome as a non-empty string, and, for
 * the status `ask`, the `dialogId`, `prompt`, `secret` and `choices` of the question). An `idempotencyKey`, when present, is a non-empty string, and a `deadlineAt` a finite number (ms since the epoch). What the content holds and whose the target is stay the adapter's checks. Never throws.
 */
export function validateAction(given: unknown): { ok: true } | { ok: false; reason: string } {
  return verdict(() => {
    need(given, 'action', isObject);
    const action = asRecord(given);
    need(action.action, 'action', (name) => isOneOf(ACTIONS)(name) || isReadAction(name), {
      problem: 'unknown',
    });
    need(action.idempotencyKey, 'idempotencyKey', isId, { required: false });
    need(action.deadlineAt, 'deadlineAt', (value) => typeof value === 'number' && Number.isFinite(value), {
      required: false,
    });
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
        need(action.emoji, 'emoji', isString);
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
