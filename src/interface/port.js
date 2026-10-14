// The persona's interface port: the one contract every interface adapter (src/interface/discord.js,
// src/interface/fake.js) implements, so the engine speaks of conversations, messages and members
// and never of a chat platform (the skills design: "Discord is her interface, not her self").
// References are opaque strings namespaced by the adapter's `iface`; content is typed with a safe
// mention default (nobody is notified unless named); every operation answers a result -- it never
// throws -- whose `status` says honestly what happened: `ok`, `failed` (known not to have taken
// effect), `unknown` (may have taken effect: never retried blindly), `unsupported` (this interface
// cannot do it), `forbidden` (it may not, e.g. someone else's message). Nothing here touches a
// platform: the typedefs, the capability names and the pure helpers both adapters share.

/**
 * A conversation of one interface (a channel, a direct chat).
 * @typedef {{ iface: string, conversationId: string }} ConversationRef
 */

/**
 * A message of one interface. `memberId` is its author when the caller knows it.
 * @typedef {{ iface: string, conversationId: string, messageId?: string, memberId?: string }} MessageRef
 */

/**
 * One attachment: its bytes (`data`) or where to take them (`url`).
 * @typedef {{ name: string, data?: Uint8Array, url?: string, contentType?: string }} Attachment
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
 * @typedef {{ code: string, retryable: boolean, cause?: unknown }} PortError
 */

/**
 * The answer of one operation. `ref`: the message as it now exists (a send's new message);
 * `at`: when the interface stamped it (ms since the epoch), when it says.
 * @typedef {{ status: 'ok'|'failed'|'unknown'|'unsupported'|'forbidden', ref?: MessageRef, at?: number, error?: PortError }} PortResult
 */

/**
 * What an adapter can do: the capability names it supports (CAPABILITIES' values) and its limits.
 * @typedef {{ operations: Set<string>, limits: { maxTextLength: number, maxAttachments: number, maxAttachmentBytes: number } }} Capabilities
 */

/**
 * An interface adapter. Every operation resolves a PortResult and never rejects. The incoming
 * hooks register a handler and return its unsubscribe; they are declared, not wired yet (no
 * adapter delivers events in this phase).
 * @typedef {{
 *   iface: string,
 *   send(conversation: ConversationRef, content: Content): Promise<PortResult>,
 *   edit(message: MessageRef, content: Content): Promise<PortResult>,
 *   delete(message: MessageRef): Promise<PortResult>,
 *   react(message: MessageRef, emoji: string): Promise<PortResult>,
 *   unreact(message: MessageRef, emoji: string): Promise<PortResult>,
 *   typing(conversation: ConversationRef): Promise<PortResult>,
 *   capabilities(): Capabilities,
 *   onMessage(handler: (event: object) => void): () => void,
 *   onEdit(handler: (event: object) => void): () => void,
 *   onDelete(handler: (event: object) => void): () => void,
 * }} Port
 */

/** Every result status. */
export const STATUSES = Object.freeze(['ok', 'failed', 'unknown', 'unsupported', 'forbidden']);

/**
 * The capability name of each port operation; the skills registry's `interfaceCapability` uses
 * the same names (src/skills/registry.js).
 */
export const CAPABILITIES = Object.freeze({
  send: 'message.send',
  edit: 'message.edit',
  delete: 'message.delete',
  react: 'message.react.add',
  unreact: 'message.react.remove',
  typing: 'conversation.typing',
});

/** The incoming-event hooks every adapter declares. */
export const INCOMING_HOOKS = Object.freeze(['onMessage', 'onEdit', 'onDelete']);

/** The mentions of content that names none: nobody is notified. */
export const NO_MENTIONS = Object.freeze({ users: Object.freeze([]), repliedUser: false });

/** An `ok` result, with the message reference and stamp when given. */
export function ok(ref = undefined, at = undefined) {
  return { status: 'ok', ...(ref ? { ref } : {}), ...(Number.isFinite(at) ? { at } : {}) };
}

/** A result that is not `ok`, with its normalised error. */
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
  return notOk('failed', ref && typeof ref === 'object' && ref.iface !== iface ? 'foreign-reference' : 'invalid-reference');
}

/** The byte length of one attachment's data, 0 for a URL. */
function attachmentBytes(attachment) {
  const data = attachment?.data;
  if (data && typeof data.byteLength === 'number') return data.byteLength;
  if (data && typeof data.length === 'number') return data.length;
  return 0;
}

/**
 * Why `content` cannot be sent within `limits`, as a failed result, or null when it can: no
 * text and no attachment (`empty-content`), text past `maxTextLength` code points
 * (`text-too-long`), more than `maxAttachments` attachments or one without a name or source
 * (`invalid-attachment`), or one past `maxAttachmentBytes` (`attachment-too-large`); a reply
 * target of another interface is `foreign-reference`.
 * @param {Content} content
 * @param {Capabilities['limits']} limits
 * @param {string} iface
 * @returns {PortResult|null}
 */
export function contentRefusal(content, limits, iface) {
  if (!content || typeof content !== 'object') return notOk('failed', 'empty-content');
  const hasText = typeof content.text === 'string' && content.text !== '';
  const attachments = Array.isArray(content.attachments) ? content.attachments : [];
  if (!hasText && attachments.length === 0) return notOk('failed', 'empty-content');
  if (hasText && Array.from(content.text).length > limits.maxTextLength) return notOk('failed', 'text-too-long');
  if (attachments.length > limits.maxAttachments) return notOk('failed', 'invalid-attachment');
  for (const attachment of attachments) {
    if (!attachment || typeof attachment.name !== 'string' || !attachment.name) return notOk('failed', 'invalid-attachment');
    if (attachment.data === undefined && (typeof attachment.url !== 'string' || !attachment.url)) return notOk('failed', 'invalid-attachment');
    if (attachmentBytes(attachment) > limits.maxAttachmentBytes) return notOk('failed', 'attachment-too-large');
  }
  if (content.replyTo !== undefined && content.replyTo !== null) return refRefusal(content.replyTo, iface, { needMessage: true });
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
