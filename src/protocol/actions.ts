// The outbound half of the protocol: what the core asks an interface to do, and what the
// interface answers. Every effect of the persona is one named action (`message.send`,
// `message.edit`, `message.delete`, `message.react.add`, `message.react.remove`,
// `chat.typing`, and `command.result` for the answer to an owner command), and every
// action is answered by a result -- never by a throw -- whose `status` says honestly what
// happened: `ok`, `failed` (known not to have taken effect), `unknown` (may have taken effect:
// never retried blindly), `unsupported` (this interface cannot do it), `forbidden` (it may not,
// e.g. someone else's message). References are opaque strings namespaced by the adapter's
// `iface`; content is typed with a safe mention default (nobody is notified unless named).
// Moved here from src/interface/port.ts, which re-exports all of it, so the contract lives in
// one place no platform touches: no platform SDK type, no service, no logging.

import { readAction } from './reads.ts';

import type { Adapter, Delivery } from './adapter.ts';
/** A chat of one interface (a channel, a direct chat). */
export type ChatRef = { iface: string; chatId: string };

export type { Delivery };

/** A message of one interface. `accountId` is its author when the caller knows it. */
export type MessageRef = { iface: string; chatId: string; messageId?: string; accountId?: string };

/** One attachment: its bytes (`data`) or where to take them (`url`). `voice` marks a voice message (its length and waveform). */
export type Attachment = {
  name: string;
  data?: Uint8Array;
  url?: string;
  contentType?: string;
  voice?: { durationSecs: number; waveform: string };
};

/**
 * Who a message may notify: the members named, and whether the author of the message replied to
 * is. Absent means none. `notify` true says that everyone the message concerns asked to be pinged.
 * `asked` is present when the message concerns someone: the named members who asked to be pinged and
 * whether the replied author did. An interface that sends silently pings exactly `asked`, and the
 * `users` and `repliedUser` of a message with `notify` and no `asked`.
 */
export type Mentions = {
  users: Array<string>;
  repliedUser: boolean;
  notify?: boolean;
  asked?: { users: Array<string>; repliedUser: boolean };
};

/**
 * What a message carries: text and/or attachments, the message it replies to, the mentions that
 * may notify (default: none).
 */
export type Content = { text?: string; attachments?: Array<Attachment>; replyTo?: MessageRef; mentions?: Mentions };

/**
 * A normalised error: a kebab-case or `http-<status>` code and whether trying again later could
 * succeed. Adapters may add `cause` (the platform's own error) for the logs; it never reaches the
 * model.
 */
export type PortError = { code: string; retryable: boolean; retryAfterMs?: number | null; cause?: unknown };

/**
 * The answer of one operation. `ref`: the message as it now exists (a send's new message);
 * `at`: when the interface stamped it (ms since the epoch), when it says.
 */
export type PortResult = {
  status: 'ok' | 'failed' | 'unknown' | 'unsupported' | 'forbidden';
  ref?: MessageRef;
  at?: number;
  error?: PortError;
};

/**
 * What an adapter can do: the capability names it supports (CAPABILITIES' values) and its limits,
 * named as in src/protocol/adapter.ts: `maxChars` code points of text a message holds, `maxFiles`
 * attachments a message holds, `maxFileBytes` bytes a file holds.
 */
export type Capabilities = { operations: Array<string>; maxChars: number; maxFiles: number; maxFileBytes: number };

/**
 * An interface adapter, as src/protocol/adapter.ts types it. Every operation resolves a result and never rejects. The
 * incoming hooks register a handler and return its unsubscribe; they are declared, not wired: no adapter
 * delivers events through them, the core receives them over the link (src/protocol/serve.ts).
 */
export type Port = Adapter & {
  onMessage(handler: (event: object) => void): () => void;
  onEdit(handler: (event: object) => void): () => void;
  onDelete(handler: (event: object) => void): () => void;
};

/**
 * One action as a plain object, the port operation it names spelled out: the target
 * (`chat` or `message`), the `content` of a send or an edit, the `emoji` of a reaction.
 * A command result answers the command whose `replyRef` it carries (the adapter alone knows what
 * the token stands for) with `text`, optional `files`, whether only the requester sees it and the command's `status`
 * (`ok` when it ran, another word when it did not), and a refused one may name why in `code`. The status `ask` is a question: it carries the `dialogId` to answer
 * by, the `prompt`, whether the answer is `secret` (typed unseen) and, for a closed question, the `choices`; the `text`
 * is the prompt too, for a client that knows no dialog. The owner's command line also gets one per line it sent, its
 * `replyRef` the line's message id, when the turn over that line ended (src/interface/neptunia-cli.ts).
 */
export type Action =
  | { action: 'message.send'; chat: ChatRef; content: Content }
  | { action: 'message.edit'; message: MessageRef; content: Content }
  | { action: 'message.delete'; message: MessageRef }
  | { action: 'message.react.add' | 'message.react.remove'; message: MessageRef; emoji: string }
  | { action: 'chat.typing'; chat: ChatRef }
  | { action: 'messages.fetch'; chat: ChatRef; messageIds: Array<string> }
  | {
      action: 'command.result';
      replyRef: string;
      text: string;
      files?: Array<Attachment>;
      ephemeral?: boolean;
      status?: string;
      code?: string;
      dialogId?: string;
      prompt?: string;
      secret?: boolean;
      choices?: Array<string>;
    };

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
  typing: 'chat.typing',
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
 */
export function portAction(operation: string, args: Array<unknown>): Action {
  const [target, second] = Array.isArray(args) ? args : [];
  const read = readAction(String(operation), Array.isArray(args) ? args : []);
  // The arguments are the caller's and are not checked here: validateAction checks the shape of the
  // action at the boundary, so the casts below only name the position each argument takes.
  if (read !== null) return read as Action;
  switch (operation) {
    case 'send':
      return { action: CAPABILITIES.send, chat: target as ChatRef, content: second as Content };
    case 'edit':
      return { action: CAPABILITIES.edit, message: target as MessageRef, content: second as Content };
    case 'delete':
      return { action: CAPABILITIES.delete, message: target as MessageRef };
    case 'react':
    case 'unreact':
      return { action: CAPABILITIES[operation], message: target as MessageRef, emoji: second as string };
    case 'typing':
      return { action: CAPABILITIES.typing, chat: target as ChatRef };
    default:
      // An unknown operation gives an action without a known name, which validateAction refuses.
      return { action: String(operation) } as unknown as Action;
  }
}

/** An `ok` result, with the message reference and stamp when given. */
export function ok(ref: MessageRef | undefined = undefined, at: number | undefined = undefined): PortResult {
  return { status: 'ok', ...(ref ? { ref } : {}), ...(Number.isFinite(at) ? { at } : {}) };
}

/** A result that is not `ok`, with its normalised error. */
export function notOk(
  status: PortResult['status'],
  code: string,
  { retryable = false, cause }: { retryable?: boolean; cause?: unknown } = {}
): PortResult {
  return { status, error: { code, retryable, ...(cause !== undefined ? { cause } : {}) } };
}

/** `content`'s mentions as a fresh, well-formed Mentions: none when absent or malformed. */
export function mentionsOf(content: { mentions?: Partial<Mentions> | null } | null | undefined): Mentions {
  const given = content?.mentions;
  if (!given || typeof given !== 'object') return { users: [], repliedUser: false };
  const users = Array.isArray(given.users)
    ? given.users.filter((id): id is string => typeof id === 'string' && id !== '')
    : [];
  const asked = given.asked;
  const askedUsers = asked && typeof asked === 'object' && Array.isArray(asked.users) ? asked.users : null;
  return {
    users,
    repliedUser: given.repliedUser === true,
    ...(given.notify === true ? { notify: true } : {}),
    ...(asked && typeof asked === 'object'
      ? {
          asked: {
            users: (askedUsers ?? []).filter((id): id is string => typeof id === 'string' && id !== ''),
            repliedUser: asked.repliedUser === true,
          },
        }
      : {}),
  };
}

/** True when `ref` is a reference of `iface` with a non-empty `chatId` (and `messageId` when `needMessage`). */
export function isRefOf(
  ref: Partial<MessageRef> | null | undefined,
  iface: string,
  { needMessage = false }: { needMessage?: boolean } = {}
): boolean {
  if (!ref || typeof ref !== 'object' || ref.iface !== iface) return false;
  if (typeof ref.chatId !== 'string' || !ref.chatId) return false;
  return !needMessage || (typeof ref.messageId === 'string' && ref.messageId !== '');
}

/** The refusal of a reference that is not `iface`'s (or lacks its ids), else null. */
export function refRefusal(
  ref: Partial<MessageRef> | null | undefined,
  iface: string,
  { needMessage = false }: { needMessage?: boolean } = {}
): PortResult | null {
  if (isRefOf(ref, iface, { needMessage })) return null;
  return notOk(
    'failed',
    ref && typeof ref === 'object' && ref.iface !== iface ? 'foreign-reference' : 'invalid-reference'
  );
}

/** The byte length of one attachment's data, 0 for a URL. */
function attachmentBytes(attachment: Attachment | null | undefined): number {
  const data: { byteLength?: unknown; length?: unknown } | undefined = attachment?.data;
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
 */
export function contentRefusal(
  content: Content,
  capabilities: Pick<Capabilities, 'maxChars' | 'maxFiles' | 'maxFileBytes'>,
  iface: string,
  { splits = false }: { splits?: boolean } = {}
): PortResult | null {
  if (!content || typeof content !== 'object') return notOk('failed', 'empty-content');
  const hasText = typeof content.text === 'string' && content.text !== '';
  const attachments = Array.isArray(content.attachments) ? content.attachments : [];
  if (!hasText && attachments.length === 0) return notOk('failed', 'empty-content');
  if (!splits && hasText && Array.from(content.text ?? '').length > capabilities.maxChars)
    return notOk('failed', 'text-too-long');
  const refused = attachmentsRefusal(attachments, capabilities);
  if (refused) return refused;
  if (content.replyTo !== undefined && content.replyTo !== null)
    return refRefusal(content.replyTo, iface, { needMessage: true });
  return null;
}

/** The refusal of an attachment list past `maxFiles`, or one with a nameless, sourceless or oversize file. */
function attachmentsRefusal(
  attachments: Array<Attachment>,
  capabilities: Pick<Capabilities, 'maxFiles' | 'maxFileBytes'>
): PortResult | null {
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
 */
export function declaredHooks(): {
  onMessage: Port['onMessage'];
  onEdit: Port['onEdit'];
  onDelete: Port['onDelete'];
} {
  type Handler = (event: object) => void;
  const handlers = { message: new Set<Handler>(), edit: new Set<Handler>(), delete: new Set<Handler>() };
  const hook = (set: Set<Handler>) => (handler: Handler) => {
    if (typeof handler !== 'function') return () => {};
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  };
  return { onMessage: hook(handlers.message), onEdit: hook(handlers.edit), onDelete: hook(handlers.delete) };
}
