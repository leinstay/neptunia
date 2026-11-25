// The chat reads of the fake adapter (scripts/lib/fake.ts): what a test seeds, answered the way an interface
// answers it. The chats, groups, members, custom emoji and reactors are held here; the messages are the fake's
// own store, which this module reads. A read is recorded in `calls` under its method's name, checked as a protocol
// action first (a malformed one is `failed` with `invalid-action`), refused `unsupported` when the fake does not offer
// it, and answers a queued `failNext` result in place of doing it.

import { portAction, validateAction } from '../../src/protocol/index.ts';
import type { PortResult } from '../../src/protocol/index.ts';
import type {
  Adapter,
  ChatInfo,
  EmojiInfo,
  GroupInfo,
  MemberInfo,
  MessageEvent,
  MessageRef,
  PortError,
} from '../../src/protocol/adapter.ts';
import { notOk, refRefusal } from '../../src/interface/port.ts';
import { CODE as CODES } from '../../src/tools/codes.ts';

const CODE: Record<string, string> = CODES;

/** A message the fake keeps. `seq` is its arrival order, `event` the whole event it was seeded with, if any. */
export type StoredMessage = {
  ref: MessageRef;
  authorId: string;
  at: number;
  seq: number;
  text: string;
  attachments: Array<{ name: string; data?: Uint8Array; url?: string; contentType?: string; size?: number }>;
  replyTo: { messageId?: string } | null;
  reactions: Set<string>;
  deleted: boolean;
  event?: MessageEvent;
  /** The key of the send that posted it, and which part of that send it is. */
  sentUnder?: { idempotencyKey: string; part: number };
};

type ReadMethods = Pick<
  Adapter,
  'chatInfo' | 'chats' | 'history' | 'memberInfo' | 'dmChatOf' | 'emoji' | 'parseLinks' | 'reactors'
>;

// The reads as plain functions; the adapter's own methods answer them as promises.
type SyncReads = {
  [K in keyof ReadMethods]: (...args: Parameters<ReadMethods[K]>) => Awaited<ReturnType<ReadMethods[K]>>;
};

type Deps = {
  iface: string;
  selfId: string;
  messages: Map<string, StoredMessage>;
  offered: Set<string>;
  calls: Array<{ op: string; args: Array<unknown> }>;
  takeQueued: (op: string) => PortResult | undefined;
  store: (
    chatId: string,
    authorId: string,
    content: { text?: string; attachments?: StoredMessage['attachments'] },
    messageId: string | null,
    extra: { at: number; event: MessageEvent }
  ) => StoredMessage;
  messageUrl: () => { root: string; direct: string } | null | undefined;
  /** Whether what the persona sent is part of a chat's history (it is, as on a platform; a test may say it is not). */
  sendsInHistory: () => boolean;
};

/** The fields of an event's `chat` record, taken from a chat's info. */
const RECORD_KEYS = ['id', 'kind', 'rootId', 'name', 'topic', 'chatType', 'parentId', 'partnerId'] as const;

const clone = <T>(value: T): T => structuredClone(value);

/** The regular expression that matches exactly the text a message-address template writes, its parts as groups. */
function templatePattern(template: string): { regex: RegExp; order: Array<string> } {
  const order: Array<string> = [];
  const source = template
    .split(/(\{root\}|\{chat\}|\{message\})/)
    .map((piece) => {
      const name = /^\{(root|chat|message)\}$/.exec(piece)?.[1];
      if (name === undefined) return piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      order.push(name);
      return '([^/?#\\s]+)';
    })
    .join('');
  return { regex: new RegExp(`^${source}/?$`), order };
}

type HistoryQuery = Parameters<Adapter['history']>[1];

/** The slice of `all` a history query names, and whether it reaches the end the query reads toward. */
function sliceOf(
  all: Array<StoredMessage>,
  { limit, before, after, around, since }: HistoryQuery
): { slice: Array<StoredMessage>; complete: boolean } | null {
  const at = (id: string): number => all.findIndex((message) => message.ref.messageId === id);
  if (after !== undefined) {
    const index = at(after);
    if (index < 0) return null;
    const slice = all.slice(index + 1, index + 1 + limit);
    return { slice, complete: index + 1 + slice.length >= all.length };
  }
  if (around !== undefined) {
    const index = at(around);
    if (index < 0) return null;
    const from = Math.max(0, index - Math.floor(limit / 2));
    return { slice: all.slice(from, from + limit), complete: from === 0 };
  }
  let pool = all;
  if (before !== undefined) {
    const index = at(before);
    if (index < 0) return null;
    pool = all.slice(0, index);
  }
  if (since !== undefined) pool = pool.filter((message) => message.at >= since);
  const slice = pool.slice(-limit);
  return { slice, complete: slice.length === pool.length };
}

export function createFakeReads(deps: Deps): {
  methods: ReadMethods;
  eventOf(stored: StoredMessage): MessageEvent;
  seeders: {
    seedChat(info: ChatInfo): void;
    removeChat(chatId: string): void;
    seedDmChat(accountId: string, chatId: string): void;
    seedGroups(placeId: string, list: Array<GroupInfo>): void;
    seedMember(placeId: string, member: MemberInfo): void;
    seedEmoji(placeId: string, list: Array<EmojiInfo>): void;
    seedReactors(ref: MessageRef, emoji: string, accountIds: Array<string>): void;
    seedEvent(event: MessageEvent, extra?: { attachments?: StoredMessage['attachments'] }): void;
  };
} {
  const { iface, selfId, messages, offered, calls, takeQueued, store, messageUrl, sendsInHistory } = deps;
  const chats = new Map<string, ChatInfo>();
  const groups = new Map<string, Array<GroupInfo>>();
  const members = new Map<string, Map<string, MemberInfo>>();
  const dmChats = new Map<string, string>();
  const emojis = new Map<string, Array<EmojiInfo>>();
  const reactorLists = new Map<string, Array<string>>();

  /** The common front of a read: the record, the shape, the offer, a queued answer. */
  function front(op: string, wire: string, args: Array<unknown>): PortResult | undefined {
    calls.push({ op, args });
    if (!validateAction(portAction(op, args)).ok) return notOk('failed', CODE.INVALID_ACTION);
    if (!offered.has(wire)) return notOk('unsupported', CODE.UNSUPPORTED);
    return takeQueued(op);
  }

  const failure = (result: PortResult): { status: 'failed'; error: PortError } => ({
    status: 'failed',
    error: {
      code: result.error?.code ?? CODE.ERROR,
      retryable: result.error?.retryable ?? false,
      retryAfterMs: result.error?.retryAfterMs ?? null,
    },
  });

  /** A queued or refused result of `front`, as the error answer of a read. */
  const refusalOf = (result: PortResult) =>
    result.status === 'unsupported' || result.status === 'forbidden'
      ? { status: result.status, error: failure(result).error }
      : failure(result);

  const ordered = (chatId: string): Array<StoredMessage> =>
    [...messages.values()]
      .filter((message) => message.ref.chatId === chatId && !message.deleted)
      .filter((message) => message.event !== undefined || sendsInHistory())
      .sort((a, b) => a.at - b.at || a.seq - b.seq);

  /** The record an event carries for chat `id`: what the interface would say of it. */
  function recordOf(id: string): MessageEvent['chat'] {
    const info = chats.get(id);
    if (info === undefined) return { id, kind: 'channel', rootId: null, name: null };
    const record: Record<string, unknown> = {};
    for (const key of RECORD_KEYS) if (info[key] !== undefined) record[key] = info[key];
    return record as MessageEvent['chat'];
  }

  /** The `message.received` event of a stored message: the one it was seeded with, else one built from what is kept. */
  function eventOf(stored: StoredMessage): MessageEvent {
    const { chatId, messageId } = stored.ref;
    if (stored.event !== undefined) {
      const { edit, deleted, partial, previous, ...event } = clone(stored.event);
      void [edit, deleted, partial, previous];
      return { ...event, id: `${iface}:message:${String(messageId)}`, at: stored.at };
    }
    const reactions = [...stored.reactions].map((emoji) => ({ emoji, count: 1, mine: true }));
    return {
      kind: 'message.received',
      iface,
      at: stored.at,
      id: `${iface}:message:${String(messageId)}`,
      chat: recordOf(chatId),
      message: {
        id: String(messageId),
        author: { id: stored.authorId, name: null, self: stored.authorId === selfId, bot: false },
        content: stored.text,
        sourceText: stored.text,
        system: false,
        at: stored.at,
        replyToId: stored.replyTo?.messageId ?? null,
        replyPingAccountId: null,
        forwardedFrom: null,
        attachments: [],
        links: [],
        forwarded: [],
        stickers: [],
        emojis: [],
        reactions,
      },
      addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
    };
  }

  /** `info` as a read answers it: the audience and the viewers only when asked for. */
  function infoOf(
    info: ChatInfo,
    { audience = false, viewers = [] }: { audience?: boolean; viewers?: ReadonlyArray<string> } = {}
  ): ChatInfo {
    const { audience: held, viewers: seen, ...rest } = clone(info);
    const out: ChatInfo = { ...rest };
    if (audience) out.audience = held ?? null;
    if (viewers.length > 0) out.viewers = Object.fromEntries(viewers.map((id) => [id, seen?.[id] ?? true]));
    return out;
  }

  const known = (chatId: string): PortResult | null =>
    chats.has(chatId) ? null : notOk('failed', CODE.UNKNOWN_CONVERSATION);

  const ask: SyncReads = {
    chatInfo(chat, options = {}) {
      const early = front('chatInfo', 'chat.info', [chat, options]);
      if (early) return refusalOf(early);
      const refused = refRefusal(chat, iface) ?? known(chat.chatId);
      const info = chats.get(chat.chatId);
      if (refused || info === undefined) return refusalOf(refused ?? notOk('failed', CODE.ERROR));
      return { status: 'ok', chat: infoOf(info, options) };
    },

    chats(scope) {
      const early = front('chats', 'chats.list', [scope]);
      if (early) return refusalOf(early);
      const listed = [...chats.values()]
        .filter((info) => info.rootId === scope.placeId)
        .map((info) => infoOf(info, scope));
      return { status: 'ok', chats: listed, groups: clone(groups.get(scope.placeId) ?? []) };
    },

    history(chat, query) {
      const early = front('history', 'messages.history', [chat, query]);
      if (early) return refusalOf(early);
      const refused = refRefusal(chat, iface) ?? known(chat.chatId);
      if (refused) return refusalOf(refused);
      const window = sliceOf(ordered(chat.chatId), query);
      if (window === null) return refusalOf(notOk('failed', CODE.UNKNOWN_MESSAGE));
      return { status: 'ok', events: window.slice.map(eventOf), complete: window.complete };
    },

    memberInfo(member) {
      const early = front('memberInfo', 'member.info', [member]);
      if (early) return refusalOf(early);
      const held = members.get(String(member.placeId))?.get(member.accountId);
      return { status: 'ok', member: held ? clone(held) : null };
    },

    dmChatOf(partner) {
      const early = front('dmChatOf', 'dm.chat', [partner]);
      if (early) return refusalOf(early);
      const chatId = dmChats.get(partner.accountId);
      if (chatId === undefined) return refusalOf(notOk('failed', CODE.UNKNOWN_CONVERSATION));
      return { status: 'ok', chatId };
    },

    emoji(scope) {
      const early = front('emoji', 'emoji.list', [scope]);
      if (early) return refusalOf(early);
      const listed = scope.placeId === null ? [...emojis.values()].flat() : (emojis.get(scope.placeId) ?? []);
      return { status: 'ok', emoji: clone(listed) };
    },

    parseLinks(texts) {
      const early = front('parseLinks', 'links.parse', [texts]);
      if (early) return refusalOf(early);
      const template = messageUrl();
      const patterns = template ? [template.root, template.direct].map(templatePattern) : [];
      const refs = texts.map((text): MessageRef | null => {
        for (const { regex, order } of patterns) {
          const match = regex.exec(text);
          if (!match) continue;
          const part = (name: string): string => match[order.indexOf(name) + 1] ?? '';
          return { iface, chatId: part('chat'), messageId: part('message') };
        }
        return null;
      });
      return { status: 'ok', refs };
    },

    reactors(message, emoji, limit) {
      const early = front('reactors', 'message.reactors', [message, emoji, limit]);
      if (early) return refusalOf(early);
      const list = reactorLists.get(`${message.chatId}/${String(message.messageId)}/${emoji}`);
      if (list === undefined) return refusalOf(notOk('failed', CODE.NOT_FOUND));
      return { status: 'ok', accountIds: list.slice(0, limit) };
    },
  };

  const methods: ReadMethods = {
    chatInfo: (...args) => Promise.resolve(ask.chatInfo(...args)),
    chats: (...args) => Promise.resolve(ask.chats(...args)),
    history: (...args) => Promise.resolve(ask.history(...args)),
    memberInfo: (...args) => Promise.resolve(ask.memberInfo(...args)),
    dmChatOf: (...args) => Promise.resolve(ask.dmChatOf(...args)),
    emoji: (...args) => Promise.resolve(ask.emoji(...args)),
    parseLinks: (...args) => Promise.resolve(ask.parseLinks(...args)),
    reactors: (...args) => Promise.resolve(ask.reactors(...args)),
  };

  return {
    methods,
    eventOf,
    seeders: {
      seedChat(info) {
        chats.set(info.id, clone(info));
      },
      seedDmChat(accountId, chatId) {
        dmChats.set(accountId, chatId);
      },
      removeChat(chatId) {
        chats.delete(chatId);
      },
      seedGroups(placeId, list) {
        groups.set(placeId, clone(list));
      },
      seedMember(placeId, member) {
        const held = members.get(placeId) ?? new Map<string, MemberInfo>();
        held.set(member.id, clone(member));
        members.set(placeId, held);
      },
      seedEmoji(placeId, list) {
        emojis.set(placeId, clone(list));
      },
      seedReactors(ref, emoji, accountIds) {
        reactorLists.set(`${ref.chatId}/${String(ref.messageId)}/${emoji}`, [...accountIds]);
      },
      /** Keeps a whole `message.received` event as the message it carries, in the chat it names. */
      seedEvent(event, extra = {}) {
        const { message } = event;
        // The files as the platform lists them for a read by id, when the test says (an event's own list has no type).
        const attachments =
          extra.attachments ??
          ((message.attachments ?? []) as Array<{ name?: string; url?: string; size?: number | null }>).map((item) => ({
            name: item.name ?? 'file',
            url: item.url,
            ...(typeof item.size === 'number' ? { size: item.size } : {}),
          }));
        store(
          event.chat.id,
          String(message.author?.id ?? ''),
          { text: message.content ?? '', attachments },
          String(message.id),
          { at: message.at ?? event.at, event: clone(event) }
        );
      },
    },
  };
}
