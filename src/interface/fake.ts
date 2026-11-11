// An in-memory adapter of the interface port (src/interface/port.ts): the second interface that
// proves the engine does not lean on one platform, and the stand-in tests drive the persona's effects
// through. It keeps its chats' messages in memory, records every call in order (`calls`),
// offers the capabilities it is given, and answers the results a test queues (`failNext`) in
// place of doing the operation. Same rules as every adapter: edit and delete only the self
// member's messages, mentions default to none, nothing ever throws. Every call is checked as a
// protocol action first (validateAction over the call's action object): a malformed one is
// refused as `failed` with the code `invalid-action`, so a test that drives the persona through
// the fake also proves she only ever asks for well-formed actions. A `send` splits a text longer
// than `maxChars` into parts, stores each as a message of the self member and answers a Delivery
// (src/protocol/adapter.ts), the way every adapter does. A send's `idempotencyKey` is kept on each part it posted,
// and `fetchMessages(chat, ids, { idempotencyKey })` answers those parts too: the fake can reconcile a send
// whose answer was lost when its capabilities say `reconcile: true` (src/interface/reconcile.ts).
//
// The chat reads (src/protocol/adapter.ts) answer from what a test seeds: `seedChat(info)`,
// `seedGroups(placeId, groups)`, `seedMember(placeId, member)`, `seedDmChat(accountId, chatId)`, `seedEmoji(placeId, emoji)`,
// `seedReactors(ref, emoji, accountIds)` and `seedEvent(event)`, a whole `message.received` event kept as the
// message it carries. Every message the fake holds, seeded or sent, is history: `history` reads them oldest
// first, ordered by time and then by arrival, and answers each as the event an interface would deliver.
// `reads` names the wire actions the fake offers (all of READ_ACTIONS when absent); a read it does not offer
// answers `unsupported`. Reads are recorded in `calls` under the method's name, like every other call.

import { MESSAGES_FETCH, READ_ACTIONS, deliveryOf, portAction, splitText, validateAction } from '../protocol/index.ts';
import { CAPABILITIES, contentRefusal, declaredHooks, mentionsOf, notOk, ok, refRefusal } from './port.ts';
import { createFakeReads } from './fake-reads.ts';
import { CODE } from '../tools/codes.ts';

import type { StoredMessage } from './fake-reads.ts';
import type {
  Capabilities,
  ChatInfo,
  EmojiInfo,
  FetchedMessages,
  GroupInfo,
  MemberInfo,
  MessageEvent,
  MessageRef,
} from '../protocol/adapter.ts';
import type { Content } from '../protocol/actions.ts';
import type { Port, PortResult } from './port.ts';
/**
 * Replays a recorded fixture of inbound events through an event door (src/interface/door.ts), in
 * order, the way an interface would deliver them. A fixture is `{ iface?, events: [event, ...] }`:
 * each event is a protocol event (src/protocol/events.ts); `iface` is filled from the
 * fixture's when an event has none, and a `message.received` of a new message is put into
 * `port` (the fake adapter) first, so history reads find what the persona was shown. An event
 * with `redeliver: n` is delivered n more times after the first (at-least-once delivery: the door
 * answers `duplicate` to each). Returns one answer per delivery: `{ id, status }` in order.
 */
/** One recorded event of a fixture: a protocol event, with `redeliver` for the extra deliveries. */
type FixtureEvent = {
  redeliver?: number;
  iface?: string;
  kind?: string;
  edit?: boolean;
  deleted?: boolean;
  chat?: { id: string };
  message?: { id: string; content: string; author?: { id: string } };
};

export async function replayFixture(
  fixture: { iface?: string; events: Array<FixtureEvent> },
  door: { submit(event: object): Promise<{ status: string; id: string | null }> },
  { port = null }: { port?: ReturnType<typeof createFakeAdapter> | null } = {}
): Promise<Array<{ id: string | null; status: string }>> {
  const answers: Array<{ id: string | null; status: string }> = [];
  for (const recorded of fixture.events) {
    const { redeliver = 0, ...fields } = recorded;
    const event = { ...(fixture.iface && fields.iface === undefined ? { iface: fixture.iface } : {}), ...fields };
    const message = event.message;
    if (port && event.kind === 'message.received' && !event.edit && !event.deleted && message?.author && event.chat) {
      port.seed(event.chat.id, { authorId: message.author.id, text: message.content, messageId: message.id });
    }
    for (let delivery = 0; delivery <= redeliver; delivery += 1) {
      const { status, id } = await door.submit(structuredClone(event));
      answers.push({ id, status });
    }
  }
  return answers;
}

export type { StoredMessage };

/** The idempotency key a send's or a fetch's options name, or null. */
function idempotencyKeyOf(options: unknown): string | null {
  const key = (options as { idempotencyKey?: unknown } | null | undefined)?.idempotencyKey;
  return typeof key === 'string' && key !== '' ? key : null;
}

/** The fake's default capabilities beyond its operations: the limits of a message and how it addresses one. */
export const FAKE_CAPABILITIES = Object.freeze({
  maxChars: 2000,
  maxFiles: 10,
  maxFileBytes: 8 * 1024 * 1024,
  // A message address shaped like a chat platform's jump link, so a test sees the links the core writes.
  messageUrl: Object.freeze({
    root: 'https://discord.com/channels/{root}/{chat}/{message}',
    direct: 'https://discord.com/channels/@me/{chat}/{message}',
  }),
});

/**
 * An in-memory port.
 * @param options `messageId`: the id of each message the persona sends, from the chat and how many she sent there so
 *   far (else `<iface>-<n>`, n counting every message stored);
 *   `operations`: the capability names offered (all of CAPABILITIES when absent); `reads`: the wire names of the
 *   reads offered (all of READ_ACTIONS when absent); `capabilities`:
 *   the limits (`maxChars`, `maxFiles`, `maxFileBytes`) and `reconcile` over FAKE_CAPABILITIES; `selfId`: the
 *   member id of the persona (the author of what she sends); `now`: the stamp of each new message; `invite`: the link
 *   the invite read answers (`unsupported` with the code `no-invite` when absent).
 * @returns `seed` puts someone's message (its `messageId`, else a new one) into a chat;
 *   `failNext(op, result)` queues `result` as the answer of the next call of `op` (`send`,
 *   `edit`, ...), in place of doing it; queued results are answered in order.
 */
export function createFakeAdapter({
  iface = 'fake',
  selfId = 'self',
  operations = null,
  capabilities: declared = {},
  now = Date.now,
  reads = null,
  messageId: messageIdOf = null,
  invite,
}: {
  iface?: string;
  selfId?: string;
  operations?: Iterable<string> | null;
  capabilities?: Partial<Pick<Capabilities, 'maxChars' | 'maxFiles' | 'maxFileBytes' | 'messageUrl' | 'reconcile'>>;
  now?: () => number;
  reads?: Iterable<string> | null;
  messageId?: ((chatId: string, count: number) => string) | null;
  invite?: string;
} = {}): Port & {
  calls: Array<{ op: string; args: Array<unknown> }>;
  messages: Map<string, StoredMessage>;
  typings: Array<string>;
  seed(chatId: string, message: { authorId: string; text?: string; messageId?: string }): MessageRef;
  failNext(op: string, result: PortResult): void;
  messagesIn(chatId: string): Array<StoredMessage>;
  seedChat(info: ChatInfo): void;
  removeChat(chatId: string): void;
  seedGroups(placeId: string, list: Array<GroupInfo>): void;
  seedMember(placeId: string, member: MemberInfo): void;
  seedDmChat(accountId: string, chatId: string): void;
  seedEmoji(placeId: string, list: Array<EmojiInfo>): void;
  seedReactors(ref: MessageRef, emoji: string, accountIds: Array<string>): void;
  seedEvent(event: MessageEvent, extra?: { attachments?: StoredMessage['attachments'] }): void;
  clearChat(chatId: string): void;
  showSendsInHistory(shown: boolean): void;
} {
  const offered = new Set(operations ? [...operations] : Object.values(CAPABILITIES));
  const offeredReads = new Set(reads ? [...reads] : READ_ACTIONS);
  const caps = { ...FAKE_CAPABILITIES, ...declared };
  const calls: Array<{ op: string; args: Array<unknown> }> = [];
  // `${chatId}/${messageId}` -> the stored message
  const messages: Map<string, StoredMessage> = new Map();
  const typings: Array<string> = [];
  const queued = new Map<string, Array<PortResult>>();
  let nextId = 0;
  let nextKey = 0;
  let nextSeq = 0;
  let sendsInHistory = true;
  const sentIn: Map<string, number> = new Map();

  // A queued or refused result stands in for the read as it is: a test queues a failure, and the refusals are failures.
  const asRefusal = (result: PortResult): FetchedMessages => result as FetchedMessages;
  const keyOf = (ref: { chatId: string; messageId?: string }): string => `${ref.chatId}/${ref.messageId}`;
  const capabilityNames: Readonly<Record<string, string>> = CAPABILITIES;
  const supports = (operation: string): boolean => offered.has(capabilityNames[operation]);

  /** The queued answer of `op`, if any (taken), else undefined. */
  function takeQueued(op: string): PortResult | undefined {
    const list = queued.get(op);
    if (!list || list.length === 0) return undefined;
    return list.shift();
  }

  /** The common front of every operation: the record, the action's shape, the capability, a queued answer. */
  function front(op: string, args: Array<unknown>): PortResult | undefined {
    calls.push({ op, args });
    if (!validateAction(portAction(op, args)).ok) return notOk('failed', CODE.INVALID_ACTION);
    if (!supports(op)) return notOk('unsupported', CODE.UNSUPPORTED);
    return takeQueued(op);
  }

  /** The live (not deleted) message `ref` points at, or a failed result. */
  function found(
    ref: MessageRef
  ): { message: StoredMessage; result?: undefined } | { message?: undefined; result: PortResult } {
    const message = messages.get(keyOf(ref));
    return message && !message.deleted ? { message } : { result: notOk('failed', CODE.UNKNOWN_MESSAGE) };
  }

  /** A stored message for `content`, authored by `authorId` (`messageId`: its id, else a new one; `extra`: `at` and `event` of a seeded one). */
  function store(
    chatId: string,
    authorId: string,
    content: Content,
    messageId: string | null = null,
    extra: Partial<Pick<StoredMessage, 'at' | 'event' | 'sentUnder'>> = {}
  ): StoredMessage {
    nextId += 1;
    nextSeq += 1;
    let given = messageId;
    if (given === null && messageIdOf !== null) {
      const count = (sentIn.get(chatId) ?? 0) + 1;
      sentIn.set(chatId, count);
      given = messageIdOf(chatId, count);
    }
    const ref = { iface, chatId, messageId: given ?? `${iface}-${nextId}`, accountId: authorId };
    const message: StoredMessage = {
      ref,
      authorId,
      seq: nextSeq,
      at: now(),
      text: typeof content.text === 'string' ? content.text : '',
      attachments: Array.isArray(content.attachments)
        ? content.attachments.map((attachment) => ({ ...attachment }))
        : [],
      replyTo: content.replyTo ?? null,
      mentions: mentionsOf(content),
      reactions: new Set(),
      deleted: false,
      ...extra,
    };
    messages.set(keyOf(ref), message);
    return message;
  }

  const world = createFakeReads({
    iface,
    selfId,
    messages,
    offered: offeredReads,
    calls,
    takeQueued,
    store,
    messageUrl: () => caps.messageUrl,
    sendsInHistory: () => sendsInHistory,
  });

  return {
    iface,
    calls,
    messages,
    typings,

    seed(chatId, { authorId, text = '', messageId = null }) {
      return {
        ...store(String(chatId), String(authorId), { text }, messageId === null ? null : String(messageId)).ref,
      };
    },

    failNext(op, result) {
      const list = queued.get(op) ?? [];
      list.push(result);
      queued.set(op, list);
    },

    // The messages of a chat that were sent or put in with `seed`: what a seeded event reported is history
    // (`history` reads it) and not a message the persona or a member posted through the port.
    messagesIn(chatId) {
      return [...messages.values()].filter(
        (message) => message.ref.chatId === chatId && !message.deleted && message.event === undefined
      );
    },

    async send(chat, content, options = {}) {
      nextKey += 1;
      const given = idempotencyKeyOf(options);
      const key = given ?? `${iface}-send-${nextKey}`;
      const early = front('send', [chat, content]);
      if (early) return deliveryOf([early], key);
      const refused = refRefusal(chat, iface) ?? contentRefusal(content, caps, iface, { splits: true });
      if (refused) return deliveryOf([refused], key);
      // The reply and the files go with the first part; the rest of the text follows as plain messages.
      const texts = splitText(typeof content.text === 'string' ? content.text : '', caps.maxChars);
      const stored = texts.map((text, index) => {
        const part = index === 0 ? { ...content, text } : { text, mentions: content.mentions };
        const message = store(
          chat.chatId,
          selfId,
          part,
          null,
          given ? { sentUnder: { idempotencyKey: given, part: index } } : {}
        );
        return ok({ ...message.ref }, message.at);
      });
      return deliveryOf(stored, key);
    },

    async edit(ref, content) {
      const early = front('edit', [ref, content]);
      if (early) return early;
      const refused = refRefusal(ref, iface, { needMessage: true }) ?? contentRefusal(content, caps, iface);
      if (refused) return refused;
      const { message, result } = found(ref);
      if (result) return result;
      if (message.authorId !== selfId) return notOk('forbidden', CODE.NOT_OWN_MESSAGE);
      if (typeof content.text === 'string') message.text = content.text;
      if (Array.isArray(content.attachments))
        message.attachments = content.attachments.map((attachment) => ({ ...attachment }));
      message.mentions = mentionsOf(content);
      return ok({ ...message.ref }, now());
    },

    async delete(ref) {
      const early = front('delete', [ref]);
      if (early) return early;
      const refused = refRefusal(ref, iface, { needMessage: true });
      if (refused) return refused;
      const { message, result } = found(ref);
      if (result) return result;
      if (message.authorId !== selfId) return notOk('forbidden', CODE.NOT_OWN_MESSAGE);
      message.deleted = true;
      return ok({ ...message.ref });
    },

    async react(ref, emoji) {
      const early = front('react', [ref, emoji]);
      if (early) return early;
      const refused = refRefusal(ref, iface, { needMessage: true });
      if (refused) return refused;
      if (typeof emoji !== 'string' || !emoji) return notOk('failed', CODE.INVALID_EMOJI);
      const { message, result } = found(ref);
      if (result) return result;
      message.reactions.add(emoji);
      return ok({ ...message.ref });
    },

    async unreact(ref, emoji) {
      const early = front('unreact', [ref, emoji]);
      if (early) return early;
      const refused = refRefusal(ref, iface, { needMessage: true });
      if (refused) return refused;
      if (typeof emoji !== 'string' || !emoji) return notOk('failed', CODE.INVALID_EMOJI);
      const { message, result } = found(ref);
      if (result) return result;
      message.reactions.delete(emoji);
      return ok({ ...message.ref });
    },

    async fetchMessages(chat, messageIds, options = {}) {
      calls.push({ op: 'fetchMessages', args: [chat, messageIds] });
      const early = takeQueued('fetchMessages');
      if (early) return asRefusal(early);
      if (!offeredReads.has(MESSAGES_FETCH)) return asRefusal(notOk('unsupported', CODE.UNSUPPORTED));
      const refused = refRefusal(chat, iface);
      if (refused) return asRefusal(refused);
      const key = idempotencyKeyOf(options);
      const sentIds = key
        ? [...messages.values()]
            .filter((message) => message.ref.chatId === chat.chatId)
            .filter((message) => message.sentUnder?.idempotencyKey === key)
            .sort((a, b) => (a.sentUnder?.part ?? 0) - (b.sentUnder?.part ?? 0))
            .map((message) => message.ref.messageId)
        : [];
      const out = (Array.isArray(messageIds) ? messageIds : []).concat(sentIds).map((id) => {
        const message = messages.get(`${chat.chatId}/${id}`);
        if (!message || message.deleted) return { messageId: String(id), missing: true };
        return {
          messageId: String(id),
          text: message.text,
          attachments: message.attachments.map((attachment) => ({ ...attachment })),
          event: world.eventOf(message),
        };
      });
      return { status: 'ok', messages: out };
    },

    ...world.methods,
    ...world.seeders,

    // Whether the messages the persona sent are read back in a chat's history (default: yes).
    showSendsInHistory(shown) {
      sendsInHistory = shown;
    },

    // A test's way to start a chat over: every message of it is forgotten and its ids start again.
    clearChat(chatId) {
      for (const [key, message] of messages) if (message.ref.chatId === chatId) messages.delete(key);
      sentIn.delete(chatId);
    },

    async typing(chat) {
      const early = front('typing', [chat]);
      if (early) return early;
      const refused = refRefusal(chat, iface);
      if (refused) return refused;
      typings.push(chat.chatId);
      return ok();
    },

    async inviteLink(scope) {
      calls.push({ op: 'inviteLink', args: [scope] });
      if (!offeredReads.has('invite.link') || invite === undefined) {
        return { status: 'unsupported', error: { code: 'no-invite', retryable: false, retryAfterMs: null } };
      }
      return { status: 'ok', url: invite };
    },

    capabilities() {
      return { operations: [...offered], ...caps, reads: [...offeredReads] };
    },

    ...declaredHooks(),
  };
}
