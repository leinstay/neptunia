// The outbound half of the protocol: what the core asks an interface to do, and what the
// interface answers. Every effect of the persona is one named action (`message.send`,
// `message.edit`, `message.delete`, `message.react.add`, `message.react.remove`,
// `conversation.typing`, and `command.result` for the answer to an owner command), and every
// action is answered by a result -- never by a throw -- whose `status` says honestly what
// happened: `ok`, `failed` (known not to have taken effect), `unknown` (may have taken effect:
// never retried blindly), `unsupported` (this interface cannot do it), `forbidden` (it may not,
// e.g. someone else's message). References are opaque strings namespaced by the adapter's
// `iface`; content is typed with a safe mention default (nobody is notified unless named).
// Moved here from src/interface/port.js, which re-exports all of it, so the contract lives in
// one place no platform touches: no discord.js type, no service, no logging.

import { readAction } from './reads.ts';

/**
 * A conversation of one interface (a channel, a direct chat).
 * @typedef {{ iface: string, conversationId: string }} ConversationRef
 */

/**
 * A message of one interface. `memberId` is its author when the caller knows it.
 * @typedef {{ iface: string, conversationId: string, messageId?: string, memberId?: string }} MessageRef
 */

/**
 * One attachment: its bytes (`data`) or where to take them (`url`). `voice` marks a voice message (its length and waveform).
 * @typedef {{ name: string, data?: Uint8Array, url?: string, contentType?: string, voice?: { durationSecs: number, waveform: string } }} Attachment
 */

/**
 * Who a message may notify: the members named, and whether the author of the message replied to
 * is. Absent means none.
 * @typedef {{ users: string[], repliedUser: boolean }} Mentions
 */

/**
 * What a message carries: text and/or attachments, the message it replies to, the mentions that
 * may notify (default: none).
 * @typedef {{ text?: string, attachments?: Attachment[], replyTo?: MessageRef, mentions?: Mentions }} Content
 */

/**
 * A normalised error: a kebab-case or `http-<status>` code and whether trying again later could
 * succeed. Adapters may add `cause` (the platform's own error) for the logs; it never reaches the
 * model.
 * @typedef {{ code: string, retryable: boolean, retryAfterMs?: number | null, cause?: unknown }} PortError
 */

/**
 * The answer of one operation. `ref`: the message as it now exists (a send's new message);
 * `at`: when the interface stamped it (ms since the epoch), when it says.
 * @typedef {{ status: 'ok'|'failed'|'unknown'|'unsupported'|'forbidden', ref?: MessageRef, at?: number, error?: PortError }} PortResult
 */

/**
 * The answer of a `send`, which may post several messages: `ref` is the first part, `parts` every
 * message posted, `idempotencyKey` names the send.
 * @typedef {import('./adapter.ts').Delivery} Delivery
 */

/**
 * What an adapter can do: the capability names it supports (CAPABILITIES' values) and its limits,
 * named as in src/protocol/adapter.ts: `maxChars` code points of text a message holds, `maxFiles`
 * attachments a message holds, `maxFileBytes` bytes a file holds.
 * @typedef {{ operations: string[], maxChars: number, maxFiles: number, maxFileBytes: number }} Capabilities
 */

/**
 * An interface adapter, as src/protocol/adapter.ts types it. Every operation resolves a result and never rejects. The
 * incoming hooks register a handler and return its unsubscribe; they are declared, not wired: no adapter
 * delivers events through them, the core receives them over the link (src/protocol/serve.ts).
 * @typedef {import('./adapter.ts').Adapter & {
 *   onMessage(handler: (event: object) => void): () => void,
 *   onEdit(handler: (event: object) => void): () => void,
 *   onDelete(handler: (event: object) => void): () => void,
 * }} Port
 */

/**
 * One action as a plain object, the port operation it names spelled out: the target
 * (`conversation` or `message`), the `content` of a send or an edit, the `emoji` of a reaction.
 * A command result answers the command whose `replyRef` it carries (the adapter alone knows what
 * the token stands for) with `text`, optional `files` and whether only the requester sees it.
 * @typedef {{ action: 'message.send', conversation: ConversationRef, content: Content }
 *   | { action: 'message.edit', message: MessageRef, content: Content }
 *   | { action: 'message.delete', message: MessageRef }
 *   | { action: 'message.react.add'|'message.react.remove', message: MessageRef, emoji: string }
 *   | { action: 'conversation.typing', conversation: ConversationRef }
 *   | { action: 'messages.fetch', conversation: ConversationRef, messageIds: string[] }
 *   | { action: 'command.result', replyRef: string, text: string, files?: Attachment[], ephemeral?: boolean }} Action
 */

/** Every result status. */
export const STATUSES = Object.freeze(['ok', 'failed', 'unknown', 'unsupported', 'forbidden']);

/**
 * The capability name of each port operation; the skills registry's `interfaceCapability` uses
 * the same names (src/tools/registry.ts), and each is the `action` of the operation's action
 * object.
 */
export const CAPABILITIES = Object.freeze({
  send: 'message.send',
  edit: 'message.edit',
  delete: 'message.delete',
  react: 'message.react.add',
  unreact: 'message.react.remove',
  typing: 'conversation.typing',
});

// The read actions of the port (src/protocol/reads.ts): they change nothing, so none is a capability.
export { MESSAGES_FETCH, READ_ACTIONS } from './reads.ts';

/** The action that answers an owner command (command.requested's `replyRef`). */
export const COMMAND_RESULT = 'command.result';

/** Every action name: the port's capabilities and the command result. */
export const ACTIONS = Object.freeze([...Object.values(CAPABILITIES), COMMAND_RESULT]);

/** The incoming-event hooks every adapter declares. */
export const INCOMING_HOOKS = Object.freeze(['onMessage', 'onEdit', 'onDelete']);

/** The mentions of content that names none: nobody is notified. */
export const NO_MENTIONS = Object.freeze({ users: Object.freeze([]), repliedUser: false });

/**
 * The action object of one port call: `operation` is a key of CAPABILITIES (`send`, `edit`,
 * ...) and `args` the call's arguments in the port's order. An unknown operation gives an
 * action without a known name, which validateAction refuses.
 * @param {string} operation
 * @param {unknown[]} args
 * @returns {Action}
 */
export function portAction(operation, args) {
  const [target, second] = Array.isArray(args) ? args : [];
  const read = readAction(String(operation), Array.isArray(args) ? args : []);
  if (read !== null) return read;
  switch (operation) {
    case 'send':
      return { action: CAPABILITIES.send, conversation: target, content: second };
    case 'edit':
      return { action: CAPABILITIES.edit, message: target, content: second };
    case 'delete':
      return { action: CAPABILITIES.delete, message: target };
    case 'react':
    case 'unreact':
      return { action: CAPABILITIES[operation], message: target, emoji: second };
    case 'typing':
      return { action: CAPABILITIES.typing, conversation: target };
    default:
      return { action: String(operation) };
  }
}

/**
 * An `ok` result, with the message reference and stamp when given.
 * @returns {PortResult}
 */
export function ok(ref = undefined, at = undefined) {
  return { status: 'ok', ...(ref ? { ref } : {}), ...(Number.isFinite(at) ? { at } : {}) };
}

/**
 * A result that is not `ok`, with its normalised error.
 * @returns {PortResult}
 */
export function notOk(status, code, { retryable = false, cause } = {}) {
  return { status, error: { code, retryable, ...(cause !== undefined ? { cause } : {}) } };
}

/** `content`'s mentions as a fresh, well-formed Mentions: none when absent or malformed. */
export function mentionsOf(content) {
  const given = content?.mentions;
  if (!given || typeof given !== 'object') return { users: [], repliedUser: false };
  const users = Array.isArray(given.users) ? given.users.filter((id) => typeof id === 'string' && id) : [];
  return { users, repliedUser: given.repliedUser === true };
}

/** True when `ref` is a reference of `iface` with a non-empty `conversationId` (and `messageId` when `needMessage`). */
export function isRefOf(ref, iface, { needMessage = false } = {}) {
  if (!ref || typeof ref !== 'object' || ref.iface !== iface) return false;
  if (typeof ref.conversationId !== 'string' || !ref.conversationId) return false;
  return !needMessage || (typeof ref.messageId === 'string' && ref.messageId !== '');
}

/** The refusal of a reference that is not `iface`'s (or lacks its ids), else null. */
export function refRefusal(ref, iface, { needMessage = false } = {}) {
  if (isRefOf(ref, iface, { needMessage })) return null;
  return notOk(
    'failed',
    ref && typeof ref === 'object' && ref.iface !== iface ? 'foreign-reference' : 'invalid-reference'
  );
}

/** The byte length of one attachment's data, 0 for a URL. */
function attachmentBytes(attachment) {
  const data = attachment?.data;
  if (data && typeof data.byteLength === 'number') return data.byteLength;
  if (data && typeof data.length === 'number') return data.length;
  return 0;
}

/**
 * Why `content` cannot be sent within `capabilities`, as a failed result, or null when it can: no
 * text and no attachment (`empty-content`), text past `maxChars` code points (`text-too-long`),
 * more than `maxFiles` attachments or one without a name or source (`invalid-attachment`), or one
 * past `maxFileBytes` (`attachment-too-large`); a reply target of another interface is
 * `foreign-reference`. With `splits` the adapter cuts a long text into parts itself, so a send is
 * never refused as `text-too-long`; an edit, which cannot grow into several messages, still is.
 * @param {Content} content
 * @param {Pick<Capabilities, 'maxChars'|'maxFiles'|'maxFileBytes'>} capabilities
 * @param {string} iface
 * @param {{ splits?: boolean }} [options]
 * @returns {PortResult|null}
 */
export function contentRefusal(content, capabilities, iface, { splits = false } = {}) {
  if (!content || typeof content !== 'object') return notOk('failed', 'empty-content');
  const hasText = typeof content.text === 'string' && content.text !== '';
  const attachments = Array.isArray(content.attachments) ? content.attachments : [];
  if (!hasText && attachments.length === 0) return notOk('failed', 'empty-content');
  if (!splits && hasText && Array.from(content.text).length > capabilities.maxChars)
    return notOk('failed', 'text-too-long');
  const refused = attachmentsRefusal(attachments, capabilities);
  if (refused) return refused;
  if (content.replyTo !== undefined && content.replyTo !== null)
    return refRefusal(content.replyTo, iface, { needMessage: true });
  return null;
}

/**
 * The refusal of an attachment list past `maxFiles`, or one with a nameless, sourceless or oversize file.
 * @param {Attachment[]} attachments
 * @param {Pick<Capabilities, 'maxFiles'|'maxFileBytes'>} capabilities
 * @returns {PortResult|null}
 */
function attachmentsRefusal(attachments, capabilities) {
  if (attachments.length > capabilities.maxFiles) return notOk('failed', 'invalid-attachment');
  for (const attachment of attachments) {
    if (!attachment || typeof attachment.name !== 'string' || !attachment.name)
      return notOk('failed', 'invalid-attachment');
    if (attachment.data === undefined && (typeof attachment.url !== 'string' || !attachment.url))
      return notOk('failed', 'invalid-attachment');
    if (attachmentBytes(attachment) > capabilities.maxFileBytes) return notOk('failed', 'attachment-too-large');
  }
  return null;
}

/**
 * The incoming-event hooks of one adapter: `onMessage`, `onEdit`, `onDelete`, each registering a
 * handler and returning its unsubscribe. Declared only: nothing delivers events yet.
 * @returns {{ onMessage: Function, onEdit: Function, onDelete: Function }}
 */
export function declaredHooks() {
  const handlers = { message: new Set(), edit: new Set(), delete: new Set() };
  const hook = (set) => (handler) => {
    if (typeof handler !== 'function') return () => {};
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  };
  return { onMessage: hook(handlers.message), onEdit: hook(handlers.edit), onDelete: hook(handlers.delete) };
}
