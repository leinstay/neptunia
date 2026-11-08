// The core's side of the owner's command line chat, `cli:dm:owner`. The chat exists whether a chat client is open or
// not, as a Discord direct chat exists while its partner is away. `createCliChat` sends every call to the client that
// `live()` names at that moment (src/interface/neptunia-cli.ts: the client that sent the last line while it is
// connected, else the newest open chat). With none open it answers for the chat itself: `chatInfo` describes it, so a
// wake, an errand result and a post find it, and a text post answers `ok` with a message id of its own and
// `deferred: true`. The turn then stores the post as her line, as it stores every sent post, and the chat shows it
// when one opens (docs/cli.md, "Delivery while no chat is open"). A post with files cannot be kept, because a stored
// line holds text alone, and is refused with `chat-closed`. `ifaceOfChat` names the interface a chat id belongs to:
// the command line for its chat, the served interface for every other.

import type { Adapter, Capabilities, ChatInfo, ChatRef, Delivery } from '../protocol/adapter.ts';
import type { Content } from '../protocol/actions.ts';
import { CODE } from '../tools/codes.ts';
import { closedAdapter } from './link.ts';

/** The command line's interface and its one chat. */
const CLI_IFACE = 'cli';
const CLI_CHAT_ID = 'cli:dm:owner';
/** The prefix of the command line's chat ids. */
const CLI_CHAT_PREFIX = `${CLI_IFACE}:`;

/** What the chat declares while no client is open: text posts and the reads the core answers for it. */
const KEPT_CAPABILITIES: Capabilities = {
  operations: ['message.send', 'chat.typing'],
  maxChars: 100_000,
  maxFiles: 0,
  maxFileBytes: 0,
  history: false,
  threads: false,
  reactions: false,
  customEmoji: false,
  presence: false,
  voiceFormats: [],
  publish: [],
  search: false,
  reads: ['chat.info'],
};

/** The chat as the command line client describes it (bin/cli-link.ts). */
const CHAT_INFO: ChatInfo = {
  id: CLI_CHAT_ID,
  kind: 'dm',
  rootId: null,
  name: 'owner',
  partnerId: 'owner',
  iface: CLI_IFACE,
  permissions: { read: true, send: true, attach: true, react: false },
  owner: null,
  lastMessageAt: null,
  voice: false,
  public: false,
  audience: null,
};

/** The interface `chatId` belongs to: the command line for its chat, else `served`. */
export const ifaceOfChat = (chatId: string, served: string): string =>
  chatId.startsWith(CLI_CHAT_PREFIX) ? CLI_IFACE : served;

/** The chat reference of a command line place id, null for any other id. */
export const cliChatRef = (placeId: string): ChatRef | null =>
  placeId === CLI_CHAT_ID ? { iface: CLI_IFACE, chatId: CLI_CHAT_ID } : null;

/**
 * The command line chat over the client `live()` names now. With none, `now` stamps a kept post and `newId` names it.
 */
export function createCliChat({
  live,
  now,
  newId,
}: {
  live: () => Adapter | null;
  now: () => number;
  newId: () => string;
}): Adapter {
  const closed = closedAdapter();
  const current = (): Adapter | null => live();
  const inChat = (chat: ChatRef): boolean => chat.chatId === CLI_CHAT_ID;

  /** A post while no chat is open: kept as sent when it is text alone, else refused. */
  function keep(chat: ChatRef, content: Content, idempotencyKey: string): Delivery {
    const files = content.attachments ?? [];
    if (!inChat(chat) || files.length > 0) {
      const error = { code: CODE.CHAT_CLOSED, retryable: false, retryAfterMs: null };
      return { status: 'failed', ref: null, parts: [], at: null, idempotencyKey, error };
    }
    const ref = { iface: CLI_IFACE, chatId: CLI_CHAT_ID, messageId: newId() };
    return { status: 'ok', ref, parts: [ref], at: now(), idempotencyKey, error: null, deferred: true };
  }

  return {
    ...closed,
    iface: CLI_IFACE,
    capabilities: () => current()?.capabilities() ?? KEPT_CAPABILITIES,
    send(chat, content, options = {}) {
      const open = current();
      if (open !== null) return open.send(chat, content, options);
      return Promise.resolve(keep(chat, content, options.idempotencyKey ?? newId()));
    },
    edit: (...args) => (current() ?? closed).edit(...args),
    delete: (...args) => (current() ?? closed).delete(...args),
    react: (...args) => (current() ?? closed).react(...args),
    unreact: (...args) => (current() ?? closed).unreact(...args),
    typing: (...args) => current()?.typing(...args) ?? Promise.resolve({ status: 'ok' }),
    fetchMessages: (...args) => (current() ?? closed).fetchMessages(...args),
    chatInfo(chat) {
      const open = current();
      if (open !== null) return open.chatInfo(chat);
      return inChat(chat) ? Promise.resolve({ status: 'ok', chat: CHAT_INFO }) : closed.chatInfo(chat);
    },
    history: (...args) => (current() ?? closed).history(...args),
  };
}
