// The conversation reads of the fake adapter (src/interface/fake.js): what a test seeds, answered the way an interface
// answers it. The conversations, groups, members, custom emoji and reactors are held here; the messages are the fake's
// own store, which this module reads. A read is recorded in `calls` under its method's name, checked as a protocol
// action first (a malformed one is `failed` with `invalid-action`), refused `unsupported` when the fake does not offer
// it, and answers a queued `failNext` result in place of doing it.

import { portAction, validateAction } from '../protocol/index.js';
import type { PortResult } from '../protocol/index.js';
import type {
  Adapter,
  ConversationInfo,
  EmojiInfo,
  GroupInfo,
  MemberInfo,
  MessageEvent,
  MessageRef,
  PortError,
} from '../protocol/adapter.ts';
import { notOk, refRefusal } from './port.js';
import { CODE as CODES } from '../skills/codes.js';

const CODE: Record<string, string> = CODES as Record<string, string>;

/** A message the fake keeps. `seq` is its arrival order, `event` the whole event it was seeded with, if any. */
export type StoredMessage = {
  ref: MessageRef;
  authorId: string;
  at: number;
  seq: number;
  text: string;
  attachments: Array<{ name: string; data?: Uint8Array; url?: string; contentType?: string; size?: number }>;
  replyTo: { messageId?: string } | null;
  mentions: { users: Array<string>; repliedUser: boolean };
  reactions: Set<string>;
  deleted: boolean;
  event?: MessageEvent;
};

type ReadMethods = Pick<
  Adapter,
  | 'conversationInfo'
  | 'conversations'
  | 'history'
  | 'memberInfo'
  | 'searchMessages'
  | 'searchMembers'
  | 'emoji'
  | 'parseLinks'
  | 'reactors'
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
    conversationId: string,
    authorId: string,
    content: { text?: string; attachments?: StoredMessage['attachments'] },
    messageId: string | null,
    extra: { at: number; event: MessageEvent }
  ) => StoredMessage;
  messageUrl: () => { community: string; direct: string } | null | undefined;
  /** Whether what the persona sent is part of a conversation's history (it is, as on a platform; a test may say it is not). */
  sendsInHistory: () => boolean;
};

/** The fields of an event's `conversation` record, taken from a conversation's info. */
const RECORD_KEYS = [
  'id',
  'kind',
  'communityId',
  'name',
  'topic',
  'category',
  'chatType',
  'parentId',
  'partnerId',
] as const;

/** How many hits one page of a message search holds. */
const SEARCH_PAGE = 25;

const clone = <T>(value: T): T => structuredClone(value);

/** The regular expression that matches exactly the text a message-address template writes, its parts as groups. */
function templatePattern(template: string): { regex: RegExp; order: Array<string> } {
  const order: Array<string> = [];
  const source = template
    .split(/(\{community\}|\{conversation\}|\{message\})/)
    .map((piece) => {
      const name = /^\{(community|conversation|message)\}$/.exec(piece)?.[1];
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
    seedConversation(info: ConversationInfo): void;
    removeConversation(conversationId: string): void;
    seedGroups(communityId: string, list: Array<GroupInfo>): void;
    seedMember(communityId: string, member: MemberInfo): void;
    seedEmoji(communityId: string, list: Array<EmojiInfo>): void;
    seedReactors(ref: MessageRef, emoji: string, memberIds: Array<string>): void;
    seedEvent(event: MessageEvent, extra?: { attachments?: StoredMessage['attachments'] }): void;
  };
} {
  const { iface, selfId, messages, offered, calls, takeQueued, store, messageUrl, sendsInHistory } = deps;
  const conversations = new Map<string, ConversationInfo>();
  const groups = new Map<string, Array<GroupInfo>>();
  const members = new Map<string, Map<string, MemberInfo>>();
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

  const ordered = (conversationId: string): Array<StoredMessage> =>
    [...messages.values()]
      .filter((message) => message.ref.conversationId === conversationId && !message.deleted)
      .filter((message) => message.event !== undefined || sendsInHistory())
      .sort((a, b) => a.at - b.at || a.seq - b.seq);

  /** The record an event carries for conversation `id`: what the interface would say of it. */
  function recordOf(id: string): MessageEvent['conversation'] {
    const info = conversations.get(id);
    if (info === undefined) return { id, kind: 'channel', communityId: null, name: null };
    const record: Record<string, unknown> = {};
    for (const key of RECORD_KEYS) if (info[key] !== undefined) record[key] = info[key];
    return record as MessageEvent['conversation'];
  }

  /** The `message.received` event of a stored message: the one it was seeded with, else one built from what is kept. */
  function eventOf(stored: StoredMessage): MessageEvent {
    const { conversationId, messageId } = stored.ref;
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
      conversation: recordOf(conversationId),
      message: {
        id: String(messageId),
        author: { id: stored.authorId, name: null, self: stored.authorId === selfId, bot: false },
        content: stored.text,
        sourceText: stored.text,
        system: false,
        at: stored.at,
        replyToId: stored.replyTo?.messageId ?? null,
        replyPingUserId: null,
        forwardedFrom: null,
        attachments: [],
        links: [],
        forwarded: [],
        stickers: [],
        emojis: [],
        reactions,
      },
      addressing: { mentioned: false, replyToSelf: false, mentionedUserIds: [], mentionedConversationIds: [] },
    };
  }

  /** `info` as a read answers it: the audience and the viewers only when asked for. */
  function infoOf(
    info: ConversationInfo,
    { audience = false, viewers = [] }: { audience?: boolean; viewers?: ReadonlyArray<string> } = {}
  ): ConversationInfo {
    const { audience: held, viewers: seen, ...rest } = clone(info);
    const out: ConversationInfo = { ...rest };
    if (audience) out.audience = held ?? null;
    if (viewers.length > 0) out.viewers = Object.fromEntries(viewers.map((id) => [id, seen?.[id] ?? true]));
    return out;
  }

  const known = (conversationId: string): PortResult | null =>
    conversations.has(conversationId) ? null : notOk('failed', CODE.UNKNOWN_CONVERSATION);

  const ask: SyncReads = {
    conversationInfo(conversation, options = {}) {
      const early = front('conversationInfo', 'conversation.info', [conversation, options]);
      if (early) return refusalOf(early);
      const refused = refRefusal(conversation, iface) ?? known(conversation.conversationId);
      const info = conversations.get(conversation.conversationId);
      if (refused || info === undefined) return refusalOf(refused ?? notOk('failed', CODE.ERROR));
      return { status: 'ok', conversation: infoOf(info, options) };
    },

    conversations(scope) {
      const early = front('conversations', 'conversations.list', [scope]);
      if (early) return refusalOf(early);
      const listed = [...conversations.values()]
        .filter((info) => info.communityId === scope.communityId)
        .map((info) => infoOf(info, scope));
      return { status: 'ok', conversations: listed, groups: clone(groups.get(scope.communityId) ?? []) };
    },

    history(conversation, query) {
      const early = front('history', 'messages.history', [conversation, query]);
      if (early) return refusalOf(early);
      const refused = refRefusal(conversation, iface) ?? known(conversation.conversationId);
      if (refused) return refusalOf(refused);
      const window = sliceOf(ordered(conversation.conversationId), query);
      if (window === null) return refusalOf(notOk('failed', CODE.UNKNOWN_MESSAGE));
      return { status: 'ok', events: window.slice.map(eventOf), complete: window.complete };
    },

    memberInfo(member) {
      const early = front('memberInfo', 'member.info', [member]);
      if (early) return refusalOf(early);
      const held = members.get(String(member.communityId))?.get(member.memberId);
      return { status: 'ok', member: held ? clone(held) : null };
    },

    searchMessages(scope, query) {
      const early = front('searchMessages', 'messages.search', [scope, query]);
      if (early) return refusalOf(early);
      const needle = query.text?.toLowerCase();
      const inCommunity = new Set(
        [...conversations.values()].filter((info) => info.communityId === scope.communityId).map((info) => info.id)
      );
      const matches = [...messages.values()]
        .filter((message) => inCommunity.has(message.ref.conversationId) && !message.deleted)
        .filter((message) => needle === undefined || message.text.toLowerCase().includes(needle))
        .filter((message) => query.authorId === undefined || message.authorId === query.authorId)
        .filter((message) => query.after === undefined || message.at > query.after)
        .filter((message) => query.before === undefined || message.at < query.before)
        .sort((a, b) => b.at - a.at || b.seq - a.seq);
      const offset = query.offset ?? 0;
      const hits = matches.slice(offset, offset + SEARCH_PAGE).map((message) => {
        const name = members.get(scope.communityId)?.get(message.authorId)?.name ?? null;
        return {
          ref: { iface, conversationId: message.ref.conversationId, messageId: message.ref.messageId },
          at: message.at,
          text: message.text,
          author: { id: message.authorId, handle: name, displayName: name, bot: false },
        };
      });
      return { status: 'ok', total: matches.length, hits };
    },

    searchMembers(scope, query) {
      const early = front('searchMembers', 'members.search', [scope, query]);
      if (early) return refusalOf(early);
      const prefix = query.prefix.toLowerCase();
      const found = [...(members.get(scope.communityId)?.values() ?? [])]
        .filter((member) => (member.name ?? '').toLowerCase().startsWith(prefix))
        .slice(0, query.limit)
        .map((member) => ({
          id: member.id,
          handle: member.name,
          displayName: member.name,
          nickname: null,
          bot: member.bot,
        }));
      return { status: 'ok', members: found };
    },

    emoji(scope) {
      const early = front('emoji', 'emoji.list', [scope]);
      if (early) return refusalOf(early);
      return { status: 'ok', emoji: clone(emojis.get(scope.communityId) ?? []) };
    },

    parseLinks(texts) {
      const early = front('parseLinks', 'links.parse', [texts]);
      if (early) return refusalOf(early);
      const template = messageUrl();
      const patterns = template ? [template.community, template.direct].map(templatePattern) : [];
      const refs = texts.map((text): MessageRef | null => {
        for (const { regex, order } of patterns) {
          const match = regex.exec(text);
          if (!match) continue;
          const part = (name: string): string => match[order.indexOf(name) + 1] ?? '';
          return { iface, conversationId: part('conversation'), messageId: part('message') };
        }
        return null;
      });
      return { status: 'ok', refs };
    },

    reactors(message, emoji, limit) {
      const early = front('reactors', 'message.reactors', [message, emoji, limit]);
      if (early) return refusalOf(early);
      const list = reactorLists.get(`${message.conversationId}/${String(message.messageId)}/${emoji}`);
      if (list === undefined) return refusalOf(notOk('failed', CODE.NOT_FOUND));
      return { status: 'ok', memberIds: list.slice(0, limit) };
    },
  };

  const methods: ReadMethods = {
    conversationInfo: (...args) => Promise.resolve(ask.conversationInfo(...args)),
    conversations: (...args) => Promise.resolve(ask.conversations(...args)),
    history: (...args) => Promise.resolve(ask.history(...args)),
    memberInfo: (...args) => Promise.resolve(ask.memberInfo(...args)),
    searchMessages: (...args) => Promise.resolve(ask.searchMessages(...args)),
    searchMembers: (...args) => Promise.resolve(ask.searchMembers(...args)),
    emoji: (...args) => Promise.resolve(ask.emoji(...args)),
    parseLinks: (...args) => Promise.resolve(ask.parseLinks(...args)),
    reactors: (...args) => Promise.resolve(ask.reactors(...args)),
  };

  return {
    methods,
    eventOf,
    seeders: {
      seedConversation(info) {
        conversations.set(info.id, clone(info));
      },
      removeConversation(conversationId) {
        conversations.delete(conversationId);
      },
      seedGroups(communityId, list) {
        groups.set(communityId, clone(list));
      },
      seedMember(communityId, member) {
        const held = members.get(communityId) ?? new Map<string, MemberInfo>();
        held.set(member.id, clone(member));
        members.set(communityId, held);
      },
      seedEmoji(communityId, list) {
        emojis.set(communityId, clone(list));
      },
      seedReactors(ref, emoji, memberIds) {
        reactorLists.set(`${ref.conversationId}/${String(ref.messageId)}/${emoji}`, [...memberIds]);
      },
      /** Keeps a whole `message.received` event as the message it carries, in the conversation it names. */
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
          event.conversation.id,
          String(message.author?.id ?? ''),
          { text: message.content ?? '', attachments },
          String(message.id),
          { at: message.at ?? event.at, event: clone(event) }
        );
      },
    },
  };
}
