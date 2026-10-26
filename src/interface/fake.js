// An in-memory adapter of the interface port (src/interface/port.js): the second interface that
// proves the engine does not lean on Discord, and the stand-in tests drive the persona's effects
// through. It keeps its conversations' messages in memory, records every call in order (`calls`),
// offers the capabilities it is given, and answers the results a test queues (`failNext`) in
// place of doing the operation. Same rules as every adapter: edit and delete only the self
// member's messages, mentions default to none, nothing ever throws. Every call is checked as a
// protocol action first (validateAction over the call's action object): a malformed one is
// refused as `failed` with the code `invalid-action`, so a test that drives the persona through
// the fake also proves she only ever asks for well-formed actions. A `send` splits a text longer
// than `maxChars` into parts, stores each as a message of the self member and answers a Delivery
// (src/protocol/adapter.ts), the way every adapter does.

import { deliveryOf, portAction, splitText, validateAction } from '../protocol/index.js';
import { CAPABILITIES, contentRefusal, declaredHooks, mentionsOf, notOk, ok, refRefusal } from './port.js';
import { CODE } from '../skills/codes.js';

/**
 * Replays a recorded fixture of inbound events through an event door (src/interface/door.js), in
 * order, the way an interface would deliver them. A fixture is `{ iface?, events: [event, ...] }`:
 * each event is a protocol event (src/protocol/events.js); `iface` is filled from the
 * fixture's when an event has none, and a `message.received` of a new message is put into
 * `port` (the fake adapter) first, so history reads find what the persona was shown. An event
 * with `redeliver: n` is delivered n more times after the first (at-least-once delivery: the door
 * answers `duplicate` to each). Returns one answer per delivery: `{ id, status }` in order.
 * @param {{ iface?: string, events: object[] }} fixture
 * @param {{ submit(event: object): Promise<{ status: string, id: string|null }> }} door
 * @param {{ port?: ReturnType<typeof createFakeAdapter>|null }} [options]
 */
export async function replayFixture(fixture, door, { port = null } = {}) {
  const answers = [];
  for (const recorded of fixture.events) {
    const { redeliver = 0, ...fields } = recorded;
    const event = { ...(fixture.iface && fields.iface === undefined ? { iface: fixture.iface } : {}), ...fields };
    const message = event.message;
    if (port && event.kind === 'message.received' && !event.edit && !event.deleted && message?.author) {
      port.seed(event.conversation.id, { authorId: message.author.id, text: message.content, messageId: message.id });
    }
    for (let delivery = 0; delivery <= redeliver; delivery += 1) {
      const { status, id } = await door.submit(structuredClone(event));
      answers.push({ id, status });
    }
  }
  return answers;
}

/** The fake's default capabilities beyond its operations: the limits of a message. */
export const FAKE_CAPABILITIES = Object.freeze({
  maxChars: 2000,
  maxFiles: 10,
  maxFileBytes: 8 * 1024 * 1024,
});

/**
 * A message the fake keeps: who wrote it, when, what it says and carries, and what people did to it.
 * @typedef {{ ref: import('../protocol/adapter.ts').MessageRef, authorId: string, at: number, text: string,
 *   attachments: Array<{ name: string, data?: Uint8Array, url?: string, contentType?: string }>,
 *   replyTo: object|null, mentions: import('./port.js').Mentions, reactions: Set<string>, deleted: boolean }} StoredMessage
 */

/**
 * An in-memory port.
 * @param {{ iface?: string, selfId?: string, operations?: Iterable<string>|null,
 *   capabilities?: Partial<Pick<import('./port.js').Capabilities, 'maxChars'|'maxFiles'|'maxFileBytes'>>, now?: () => number }} [options]
 *   `operations`: the capability names offered (all of CAPABILITIES when absent); `capabilities`:
 *   the limits (`maxChars`, `maxFiles`, `maxFileBytes`) over FAKE_CAPABILITIES; `selfId`: the
 *   member id of the persona (the author of what she sends); `now`: the stamp of each new message.
 * @returns {import('./port.js').Port & {
 *   calls: { op: string, args: unknown[] }[],
 *   messages: Map<string, StoredMessage>,
 *   typings: string[],
 *   seed(conversationId: string, message: { authorId: string, text?: string, messageId?: string }): import('../protocol/adapter.ts').MessageRef,
 *   failNext(op: string, result: import('./port.js').PortResult): void,
 *   messagesIn(conversationId: string): StoredMessage[],
 * }}
 *   `seed` puts someone's message (its `messageId`, else a new one) into a conversation;
 *   `failNext(op, result)` queues `result` as the answer of the next call of `op` (`send`,
 *   `edit`, ...), in place of doing it; queued results are answered in order.
 */
export function createFakeAdapter({
  iface = 'fake',
  selfId = 'self',
  operations = null,
  capabilities: declared = {},
  now = Date.now,
} = {}) {
  const offered = new Set(operations ? [...operations] : Object.values(CAPABILITIES));
  const caps = { ...FAKE_CAPABILITIES, ...declared };
  const calls = [];
  // `${conversationId}/${messageId}` -> { ref, authorId, text, attachments, replyTo, mentions, reactions, deleted }
  const messages = new Map();
  const typings = [];
  const queued = new Map();
  let nextId = 0;
  let nextKey = 0;

  const keyOf = (ref) => `${ref.conversationId}/${ref.messageId}`;
  const supports = (operation) => offered.has(CAPABILITIES[operation]);

  /** The queued answer of `op`, if any (taken), else undefined. */
  function takeQueued(op) {
    const list = queued.get(op);
    if (!list || list.length === 0) return undefined;
    return list.shift();
  }

  /** The common front of every operation: the record, the action's shape, the capability, a queued answer. */
  function front(op, args) {
    calls.push({ op, args });
    if (!validateAction(portAction(op, args)).ok) return notOk('failed', CODE.INVALID_ACTION);
    if (!supports(op)) return notOk('unsupported', CODE.UNSUPPORTED);
    return takeQueued(op);
  }

  /** The live (not deleted) message `ref` points at, or a failed result. */
  function found(ref) {
    const message = messages.get(keyOf(ref));
    return message && !message.deleted ? { message } : { result: notOk('failed', CODE.UNKNOWN_MESSAGE) };
  }

  /** A stored message for `content`, authored by `authorId` (`messageId`: its id, else a new one). */
  function store(conversationId, authorId, content, messageId = null) {
    nextId += 1;
    const ref = { iface, conversationId, messageId: messageId ?? `${iface}-${nextId}`, memberId: authorId };
    const message = {
      ref,
      authorId,
      at: now(),
      text: typeof content.text === 'string' ? content.text : '',
      attachments: Array.isArray(content.attachments)
        ? content.attachments.map((attachment) => ({ ...attachment }))
        : [],
      replyTo: content.replyTo ?? null,
      mentions: mentionsOf(content),
      reactions: new Set(),
      deleted: false,
    };
    messages.set(keyOf(ref), message);
    return message;
  }

  return {
    iface,
    calls,
    messages,
    typings,

    seed(conversationId, { authorId, text = '', messageId = null }) {
      return {
        ...store(String(conversationId), String(authorId), { text }, messageId === null ? null : String(messageId)).ref,
      };
    },

    failNext(op, result) {
      if (!queued.has(op)) queued.set(op, []);
      queued.get(op).push(result);
    },

    messagesIn(conversationId) {
      return [...messages.values()].filter(
        (message) => message.ref.conversationId === conversationId && !message.deleted
      );
    },

    async send(conversation, content) {
      nextKey += 1;
      const key = `${iface}-send-${nextKey}`;
      const early = front('send', [conversation, content]);
      if (early) return deliveryOf([early], key);
      const refused = refRefusal(conversation, iface) ?? contentRefusal(content, caps, iface, { splits: true });
      if (refused) return deliveryOf([refused], key);
      // The reply and the files go with the first part; the rest of the text follows as plain messages.
      const texts = splitText(typeof content.text === 'string' ? content.text : '', caps.maxChars);
      const stored = texts.map((text, index) => {
        const part = index === 0 ? { ...content, text } : { text, mentions: content.mentions };
        const message = store(conversation.conversationId, selfId, part);
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

    async fetchMessages(conversation, messageIds) {
      calls.push({ op: 'fetchMessages', args: [conversation, messageIds] });
      const early = takeQueued('fetchMessages');
      if (early) return early;
      const refused = refRefusal(conversation, iface);
      if (refused) return refused;
      const out = (Array.isArray(messageIds) ? messageIds : []).map((id) => {
        const message = messages.get(`${conversation.conversationId}/${id}`);
        if (!message || message.deleted) return { messageId: String(id), missing: true };
        return {
          messageId: String(id),
          text: message.text,
          attachments: message.attachments.map((attachment) => ({ ...attachment })),
        };
      });
      return { ...ok(), messages: out };
    },

    async typing(conversation) {
      const early = front('typing', [conversation]);
      if (early) return early;
      const refused = refRefusal(conversation, iface);
      if (refused) return refused;
      typings.push(conversation.conversationId);
      return ok();
    },

    capabilities() {
      return { operations: [...offered], ...caps };
    },

    ...declaredHooks(),
  };
}
