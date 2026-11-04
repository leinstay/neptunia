// The Discord adapter of the interface port (src/interface/port.ts): the persona's effects in
// Discord's terms. A conversation is a channel id, a message a message id, a member a user id,
// all namespaced `discord`. Channels and messages are looked up by id through the client (a
// channel the caller already holds first, when it passes `lookupChannel`); mentions become
// `allowedMentions` (nobody is notified unless named); edit and delete touch only messages the
// bot wrote (else `forbidden`). Discord's answers are normalised: a 429 is `failed` and
// retryable, a 403 `forbidden`, any other 4xx `failed` with its `http-<status>` code; a 5xx, a
// timeout or a network error once the request may have left is `unknown` -- it may have taken
// effect, so the caller never sends it again blindly. A failure while looking the target up is
// always `failed`: nothing was sent. A text longer than `maxChars` is posted as several messages
// (src/protocol/split-text.ts): `send` answers a Delivery whose `parts` are all of them, and a part
// that fails after the first leaves the earlier ones posted and the outcome `unknown`.
//
// A send with an `idempotencyKey` gives each part a message nonce made from the key and the part's index
// (`nonceOf`, 25 characters, Discord's limit) and asks Discord to enforce it (`enforce_nonce`): a repeat of
// the same part within Discord's window returns the message already posted instead of a second one. People
// never see a nonce. Discord gives it back on the bot's own message in the gateway's message create event and
// in the answer to the send, never on a message read later, so the adapter keeps the nonces of the messages it
// posted in this process (the newest KEPT_NONCES), from both. `fetchMessages(conversation, ids, { idempotencyKey })`
// reads those messages too, which lets the core reconcile a send whose answer was lost
// (`capabilities().reconcile`, src/interface/reconcile.ts). A key this process never gave a nonce for is a send
// from before the interface started: the read fails, so the send stays `unknown`. An empty answer means the
// adapter issued the key and saw nothing posted under it.

import { createHash } from 'node:crypto';
import { AttachmentBuilder, MessageFlags } from 'discord.js';
import {
  CAPABILITIES,
  contentRefusal,
  declaredHooks,
  mentionsOf,
  notOk,
  ok,
  refRefusal,
} from '../../src/interface/port.ts';
import { READ_ACTIONS, deliveryOf, splitText } from '../../src/protocol/index.ts';
import { createDiscordReads } from './reads.ts';
import { CODE, httpCode } from '../../src/tools/codes.ts';
import { errorFields, objOf } from './values.ts';
import type { Content, MessageRef } from '../../src/protocol/index.ts';
import type { PortError } from '../../src/protocol/adapter.ts';
import type { Collection } from './platform-types.ts';

import type { Port, PortResult } from '../../src/interface/port.ts';
/** A discord.js reaction, as far as taking one's own back reads it. */
type DiscordReaction = { users: { remove: (id: string | null) => Promise<unknown> } };

/** A discord.js message the adapter acts on or has just posted. */
type DiscordMessage = {
  id?: string;
  author?: { id?: string };
  createdTimestamp?: number;
  editedTimestamp?: number | null;
  edit: (payload: object) => Promise<DiscordMessage | undefined>;
  delete: () => Promise<unknown>;
  react: (emoji: string) => Promise<unknown>;
  reactions?: { resolve?: (key: string) => DiscordReaction | null | undefined; cache?: Collection<DiscordReaction> };
};

/** A discord.js channel the adapter sends in. */
type DiscordChannel = {
  send?: (payload: object) => Promise<DiscordMessage | undefined>;
  sendTyping?: () => Promise<unknown>;
  messages?: { fetch?: (id: string) => Promise<DiscordMessage | null | undefined> };
};

/** The discord.js client, as far as the adapter reads it. */
type DiscordClient = {
  user?: { id?: string } | null;
  channels?: {
    cache?: Collection<DiscordChannel>;
    fetch?: (id: string) => Promise<unknown>;
  };
};

/** A failed read, as `reads.ts` takes it. */
type ReadFailure = { status: 'failed' | 'unsupported' | 'forbidden'; error: PortError };

/** The namespace of every Discord reference. */
export const DISCORD_IFACE = 'discord';

/**
 * Discord's limits for a bot: 2000 characters a message, 10 files, 10 MiB a file on a server
 * without boosts.
 */
export const DISCORD_LIMITS = Object.freeze({
  maxChars: 2000,
  maxFiles: 10,
  maxFileBytes: 10 * 1024 * 1024,
});

/**
 * How a message is addressed on Discord (`capabilities().messageUrl`): a message of a guild and one of a private chat
 * (`@me`), the links the persona sends and the chat shows as a jump to a message.
 */
export const DISCORD_MESSAGE_URL = Object.freeze({
  community: 'https://discord.com/channels/{community}/{conversation}/{message}',
  direct: 'https://discord.com/channels/@me/{conversation}/{message}',
});

/** Discord refuses a message nonce longer than 25 characters. */
const NONCE_CHARS = 25;

/** How many nonces of its own messages the adapter keeps for a reconcile. */
const KEPT_NONCES = 2000;

/** The message nonce of part `part` of the send named `idempotencyKey`: the first 25 hex characters of its SHA-256. */
export function nonceOf(idempotencyKey: string, part: number): string {
  return createHash('sha256').update(`${idempotencyKey}\u0000${part}`).digest('hex').slice(0, NONCE_CHARS);
}

/** Error names and codes of a request that timed out or lost its connection. */
const TIMEOUT_NAMES = new Set(['AbortError', 'TimeoutError']);
const NETWORK_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * A thrown discord.js error as a port result. `sent`: the failing call may have reached Discord
 * with its effect (a send, an edit, a delete, a reaction); false for a lookup before it.
 */
export function discordFailure(err: unknown, { sent }: { sent: boolean }): PortResult {
  const fields = errorFields(err);
  const status =
    typeof fields.status === 'number' && Number.isInteger(fields.status)
      ? fields.status
      : typeof fields.statusCode === 'number' && Number.isInteger(fields.statusCode)
        ? fields.statusCode
        : null;
  if (status === 429 || fields.name === 'RateLimitError')
    return notOk('failed', httpCode(429), { retryable: true, cause: err });
  if (status === 403) return notOk('forbidden', httpCode(403), { cause: err });
  if (status !== null && status >= 400 && status < 500) return notOk('failed', httpCode(status), { cause: err });
  const timedOut =
    (typeof fields.name === 'string' && TIMEOUT_NAMES.has(fields.name)) ||
    (typeof fields.code === 'string' && NETWORK_CODES.has(fields.code));
  const code = status !== null ? httpCode(status) : timedOut ? CODE.TIMEOUT : CODE.ERROR;
  // Once the request may have left, its effect is unknown and never retried blindly.
  if (sent) return notOk('unknown', code, { cause: err });
  return notOk('failed', code, { retryable: status !== null || timedOut, cause: err });
}

/** A Discord custom emoji markup's id (`<:name:id>`, `<a:name:id>`), else the emoji as given. */
function reactionKey(emoji: string): string {
  const custom = /^<a?:[^:>]+:(\d+)>$/.exec(emoji);
  return custom ? custom[1] : emoji;
}

/**
 * The files a posted message carries, each named by its attachment id with the message's id.
 * @param posted the discord.js message the send answered
 */
function postedFiles(posted: unknown): Array<{ messageId: string; attachmentId: string }> {
  const message = posted as { id?: unknown; attachments?: { values?: () => Iterable<{ id?: unknown }> } } | null;
  const values = message?.attachments?.values;
  if (typeof values !== 'function' || typeof message?.id !== 'string') return [];
  const messageId = message.id;
  return [...values.call(message.attachments)]
    .map((file) => file?.id)
    .flatMap((attachmentId) => (typeof attachmentId === 'string' ? [{ messageId, attachmentId }] : []));
}

/**
 * The nonces of the messages the adapter posted in this process: `issue(key, part)` gives a part of a keyed send its
 * nonce, `posted(message)` notes one of her messages that carries one (the answer to the send, and the gateway's
 * message create event, which comes even when the answer was lost), and `postedUnder(conversationId, key)` names the
 * messages a send posted, part by part. The newest KEPT_NONCES of each are kept.
 * @param client the discord.js client, whose `messageCreate` events are watched
 */
function createNonceBook(client: unknown) {
  // nonce -> the message posted under it
  const sent: Map<string, { conversationId: string; messageId: string }> = new Map();
  // nonce -> the send that gave it out
  const issued: Set<string> = new Set();
  const trim = (kept: Map<string, unknown> | Set<string>) => {
    while (kept.size > KEPT_NONCES) {
      const oldest = kept.keys().next();
      if (oldest.done) break;
      kept.delete(oldest.value);
    }
  };
  function posted(message: { nonce?: unknown; id?: unknown; channelId?: unknown } | null | undefined) {
    const nonce = message?.nonce;
    if (typeof nonce !== 'string' || !issued.has(nonce)) return;
    if (typeof message?.id !== 'string' || typeof message.channelId !== 'string') return;
    sent.set(nonce, { conversationId: message.channelId, messageId: message.id });
    trim(sent);
  }
  const gateway = client as { on?: (name: string, handler: (message: never) => void) => unknown } | null;
  if (typeof gateway?.on === 'function') gateway.on('messageCreate', posted);
  return {
    posted,
    /** @param key @param {number} part */
    issue(key: string, part: number) {
      const nonce = nonceOf(key, part);
      issued.add(nonce);
      trim(issued);
      return nonce;
    },
    /** Whether this process gave out a nonce for the send named `key`. */
    knows(key: string) {
      return issued.has(nonceOf(key, 0));
    },
    /** @param conversationId @param {string} key */
    postedUnder(conversationId: string, key: string) {
      const ids: Array<string> = [];
      for (let part = 0; issued.has(nonceOf(key, part)); part += 1) {
        const found = sent.get(nonceOf(key, part));
        if (found?.conversationId === conversationId) ids.push(found.messageId);
      }
      return ids;
    },
  };
}

/**
 * A result of a lookup that failed before anything was sent, as the reads take it: `failed`, `forbidden` or
 * `unsupported`, never `unknown` (that status is for a send that may have taken effect).
 */
function lookupFailed(result: PortResult): ReadFailure {
  const { code, retryable, retryAfterMs, cause } = result.error ?? { code: CODE.ERROR, retryable: false };
  return {
    // A lookup that failed before a send is never `unknown`.
    status: result.status as ReadFailure['status'],
    error: { code, retryable, retryAfterMs: retryAfterMs ?? null, ...(cause === undefined ? {} : { cause }) },
  };
}

/**
 * The Discord adapter over a discord.js client.
 * @param options `config`: the live config, read at each read (`normalizeOptions(config())`); `lookupChannel`: a channel the
 *   caller already holds, tried before the client's cache and
 *   fetch; `operations`: the capability names to offer (all of CAPABILITIES when absent), any
 *   other answers `unsupported` without a call; `limits`: over DISCORD_LIMITS; `now`: the clock
 *   that names a send's idempotency key.
 */
export function createDiscordAdapter({
  client,
  config = () => ({}),
  lookupChannel = null,
  operations = null,
  limits = {},
  now = Date.now,
}: {
  client?: DiscordClient;
  config?: () => object;
  lookupChannel?: ((id: string) => DiscordChannel | null) | null;
  operations?: Iterable<string> | null;
  limits?: Partial<typeof DISCORD_LIMITS>;
  now?: () => number;
}): Port {
  const offered = new Set(operations ? [...operations] : Object.values(CAPABILITIES));
  const caps = { ...DISCORD_LIMITS, ...limits };
  const capabilityNames: Readonly<Record<string, string>> = CAPABILITIES;
  const supports = (operation: string): boolean => offered.has(capabilityNames[operation]);
  const unsupported = () => notOk('unsupported', CODE.UNSUPPORTED);
  const selfId = () => client?.user?.id ?? null;
  let sends = 0;
  const nonces = createNonceBook(client);

  /** The channel `conversationId`, or null; a lookup that throws is rethrown as a lookup failure. */
  async function channelOf(conversationId: string): Promise<DiscordChannel | null> {
    const held = typeof lookupChannel === 'function' ? lookupChannel(conversationId) : null;
    if (held) return held;
    const cached = client?.channels?.cache?.get?.(conversationId);
    if (cached) return cached;
    // The fetch resolves a discord.js channel, or nothing when there is none.
    if (typeof client?.channels?.fetch === 'function')
      return ((await client.channels.fetch(conversationId)) as DiscordChannel | null | undefined) ?? null;
    return null;
  }

  /** `{ channel }` or `{ result }` (a failed lookup) for a conversation reference. */
  async function resolveChannel(
    ref: unknown
  ): Promise<{ channel: DiscordChannel; result?: undefined } | { channel?: undefined; result: ReadFailure }> {
    try {
      // The reference was checked by refRefusal before: it names a conversation.
      const channel = await channelOf(objOf(ref).conversationId as string);
      if (!channel) return { result: lookupFailed(notOk('failed', CODE.UNKNOWN_CONVERSATION)) };
      return { channel };
    } catch (err) {
      return { result: lookupFailed(discordFailure(err, { sent: false })) };
    }
  }

  /** `{ channel, message }` or `{ result }` for a message reference. */
  async function resolveMessage(
    ref: unknown
  ): Promise<
    | { channel: DiscordChannel; message: DiscordMessage; result?: undefined }
    | { channel?: undefined; message?: undefined; result: ReadFailure }
  > {
    const { channel, result } = await resolveChannel(ref);
    if (result) return { result };
    if (typeof channel.messages?.fetch !== 'function') return { result: lookupFailed(unsupported()) };
    try {
      const message = await channel.messages.fetch(objOf(ref).messageId as string);
      if (!message) return { result: lookupFailed(notOk('failed', CODE.UNKNOWN_MESSAGE)) };
      return { channel, message };
    } catch (err) {
      return { result: lookupFailed(discordFailure(err, { sent: false })) };
    }
  }

  /**
   * The discord.js payload of `content`: text, files, reply and the allowed mentions. An attachment
   * carrying `voice` (`{ durationSecs, waveform }`) is a voice message: the file gets its duration
   * and waveform, the message the voice flag and no text (Discord refuses text on a voice message).
   */
  function payloadOf(content: Content): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    const attachments = Array.isArray(content.attachments) ? content.attachments : [];
    const isVoice = attachments.some((attachment) => attachment?.voice);
    if (typeof content.text === 'string' && content.text !== '' && !isVoice) payload.content = content.text;
    if (attachments.length > 0) {
      payload.files = attachments.map((attachment) => {
        const file = attachment.data ?? attachment.url;
        if (!attachment.voice) return { attachment: file, name: attachment.name };
        return new AttachmentBuilder(typeof file === 'string' ? file : Buffer.from(file as Uint8Array), {
          name: attachment.name,
        })
          .setDuration(attachment.voice.durationSecs)
          .setWaveform(attachment.voice.waveform);
      });
      if (isVoice) payload.flags = MessageFlags.IsVoiceMessage;
    }
    // The key is always there, undefined without a target: the payload the engine always sent.
    payload.reply = content.replyTo
      ? { messageReference: content.replyTo.messageId, failIfNotExists: false }
      : undefined;
    // Absent mentions notify nobody: no parsing of the text, and Discord's own default leaves the
    // replied author unnotified. Given mentions notify exactly the members named.
    if (content.mentions && typeof content.mentions === 'object') {
      const { users, repliedUser } = mentionsOf(content);
      payload.allowedMentions = { parse: [], users, repliedUser };
    } else {
      payload.allowedMentions = { parse: [] };
    }
    return payload;
  }

  /** The reference of a message Discord answered with (`posted`), in `conversationId`. */
  function refOf(posted: DiscordMessage | undefined, conversationId: string): MessageRef {
    const messageId = typeof posted?.id === 'string' && posted.id ? posted.id : undefined;
    const memberId = typeof posted?.author?.id === 'string' ? posted.author.id : (selfId() ?? undefined);
    return {
      iface: DISCORD_IFACE,
      conversationId,
      ...(messageId ? { messageId } : {}),
      ...(memberId ? { memberId } : {}),
    };
  }

  /** A forbidden result unless `message` is the bot's own. */
  function authorRefusal(message: DiscordMessage): PortResult | null {
    const self = selfId();
    return self && message?.author?.id === self ? null : notOk('forbidden', CODE.NOT_OWN_MESSAGE);
  }

  const reads = createDiscordReads({
    client: client ?? {},
    config,
    iface: DISCORD_IFACE,
    resolveChannel,
    resolveMessage,
    failure: (err) => lookupFailed(discordFailure(err, { sent: false })),
    refusal: (ref, needMessage = false) => {
      const refused = refRefusal(objOf(ref), DISCORD_IFACE, { needMessage });
      return refused === null ? null : lookupFailed(refused);
    },
  });

  return {
    iface: DISCORD_IFACE,

    async send(conversation, content, options = {}) {
      sends += 1;
      const given =
        typeof options?.idempotencyKey === 'string' && options.idempotencyKey ? options.idempotencyKey : null;
      const key = given ?? `${DISCORD_IFACE}-send-${now()}-${sends}`;
      if (!supports('send')) return deliveryOf([unsupported()], key);
      const refused =
        refRefusal(conversation, DISCORD_IFACE) ?? contentRefusal(content, caps, DISCORD_IFACE, { splits: true });
      if (refused) return deliveryOf([refused], key);
      const { channel, result } = await resolveChannel(conversation);
      if (result) return deliveryOf([result], key);
      if (typeof channel.send !== 'function') return deliveryOf([unsupported()], key);
      // The reply and the files go with the first part; the rest of the text follows as plain messages.
      const texts = splitText(typeof content.text === 'string' ? content.text : '', caps.maxChars);
      const results = [];
      // The files the platform posted, each by its attachment id with the message that carries it.
      const files = [];
      for (const [index, text] of texts.entries()) {
        const part = index === 0 ? { ...content, text } : { text, mentions: content.mentions };
        const nonce = given === null ? null : nonces.issue(given, index);
        try {
          const sent = await channel.send(
            nonce === null ? payloadOf(part) : { ...payloadOf(part), nonce, enforceNonce: true }
          );
          const ref = refOf(sent, conversation.conversationId);
          if (nonce !== null) nonces.posted({ nonce, id: ref.messageId, channelId: conversation.conversationId });
          results.push(ok(ref, sent?.createdTimestamp));
          files.push(...postedFiles(sent));
        } catch (err) {
          results.push(discordFailure(err, { sent: true }));
          break;
        }
      }
      const delivery = deliveryOf(results, key);
      return files.length > 0 ? { ...delivery, attachments: files } : delivery;
    },

    async edit(message, content) {
      if (!supports('edit')) return unsupported();
      const refused =
        refRefusal(message, DISCORD_IFACE, { needMessage: true }) ?? contentRefusal(content, caps, DISCORD_IFACE);
      if (refused) return refused;
      const found = await resolveMessage(message);
      if (found.result) return found.result;
      const notOwn = authorRefusal(found.message);
      if (notOwn) return notOwn;
      try {
        const { reply: _reply, ...payload } = payloadOf(content);
        const edited = await found.message.edit(payload);
        return ok(refOf(edited ?? found.message, message.conversationId), edited?.editedTimestamp ?? undefined);
      } catch (err) {
        return discordFailure(err, { sent: true });
      }
    },

    async delete(message) {
      if (!supports('delete')) return unsupported();
      const refused = refRefusal(message, DISCORD_IFACE, { needMessage: true });
      if (refused) return refused;
      const found = await resolveMessage(message);
      if (found.result) return found.result;
      const notOwn = authorRefusal(found.message);
      if (notOwn) return notOwn;
      try {
        await found.message.delete();
        return ok(refOf(found.message, message.conversationId));
      } catch (err) {
        return discordFailure(err, { sent: true });
      }
    },

    async react(message, emoji) {
      if (!supports('react')) return unsupported();
      const refused = refRefusal(message, DISCORD_IFACE, { needMessage: true });
      if (refused) return refused;
      if (typeof emoji !== 'string' || !emoji) return notOk('failed', CODE.INVALID_EMOJI);
      const found = await resolveMessage(message);
      if (found.result) return found.result;
      try {
        await found.message.react(emoji);
        return ok({ iface: DISCORD_IFACE, conversationId: message.conversationId, messageId: message.messageId });
      } catch (err) {
        return discordFailure(err, { sent: true });
      }
    },

    async unreact(message, emoji) {
      if (!supports('unreact')) return unsupported();
      const refused = refRefusal(message, DISCORD_IFACE, { needMessage: true });
      if (refused) return refused;
      if (typeof emoji !== 'string' || !emoji) return notOk('failed', CODE.INVALID_EMOJI);
      const found = await resolveMessage(message);
      if (found.result) return found.result;
      const key = reactionKey(emoji);
      const reactions = found.message.reactions;
      const reaction = reactions?.resolve?.(key) ?? reactions?.cache?.get?.(key) ?? null;
      const done = ok({ iface: DISCORD_IFACE, conversationId: message.conversationId, messageId: message.messageId });
      // No such reaction: nothing of hers to take back.
      if (!reaction) return done;
      try {
        await reaction.users.remove(selfId());
        return done;
      } catch (err) {
        return discordFailure(err, { sent: true });
      }
    },

    async typing(conversation) {
      if (!supports('typing')) return unsupported();
      const refused = refRefusal(conversation, DISCORD_IFACE);
      if (refused) return refused;
      const { channel, result } = await resolveChannel(conversation);
      if (result) return result;
      if (typeof channel.sendTyping !== 'function') return unsupported();
      try {
        await channel.sendTyping();
        return ok();
      } catch (err) {
        return discordFailure(err, { sent: true });
      }
    },

    ...reads,

    /** A fetch by a send's key reads the messages this process saw posted under it, beside the ids asked for. */
    fetchMessages(
      conversation: { iface: string; conversationId: string },
      messageIds: ReadonlyArray<string>,
      options: { idempotencyKey?: string } = {}
    ) {
      const key = typeof options?.idempotencyKey === 'string' ? options.idempotencyKey : null;
      if (key !== null && !nonces.knows(key))
        return Promise.resolve(lookupFailed(notOk('failed', CODE.UNKNOWN_MESSAGE)));
      const extra = key === null ? [] : nonces.postedUnder(conversation.conversationId, key);
      return reads.fetchMessages(conversation, [...(messageIds ?? []), ...extra]);
    },

    capabilities() {
      return {
        operations: [...offered],
        ...caps,
        messageUrl: DISCORD_MESSAGE_URL,
        reads: [...READ_ACTIONS],
        reconcile: true,
      };
    },

    ...declaredHooks(),
  };
}
