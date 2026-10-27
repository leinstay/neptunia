// The Discord adapter of the interface port (src/interface/port.js): the persona's effects in
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

import { AttachmentBuilder, MessageFlags } from 'discord.js';
import {
  CAPABILITIES,
  contentRefusal,
  declaredHooks,
  mentionsOf,
  notOk,
  ok,
  refRefusal,
} from '../../src/interface/port.js';
import { READ_ACTIONS, deliveryOf, splitText } from '../../src/protocol/index.js';
import { createDiscordReads } from './reads.ts';
import { CODE, httpCode } from '../../src/tools/codes.ts';

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
 * @param {unknown} err
 * @param {{ sent: boolean }} phase
 * @returns {import('../../src/interface/port.js').PortResult}
 */
export function discordFailure(err, { sent }) {
  const status = Number.isInteger(err?.status) ? err.status : Number.isInteger(err?.statusCode) ? err.statusCode : null;
  if (status === 429 || err?.name === 'RateLimitError')
    return notOk('failed', httpCode(429), { retryable: true, cause: err });
  if (status === 403) return notOk('forbidden', httpCode(403), { cause: err });
  if (status !== null && status >= 400 && status < 500) return notOk('failed', httpCode(status), { cause: err });
  const timedOut = TIMEOUT_NAMES.has(err?.name) || NETWORK_CODES.has(err?.code);
  const code = status !== null ? httpCode(status) : timedOut ? CODE.TIMEOUT : CODE.ERROR;
  // Once the request may have left, its effect is unknown and never retried blindly.
  if (sent) return notOk('unknown', code, { cause: err });
  return notOk('failed', code, { retryable: status !== null || timedOut, cause: err });
}

/** A Discord custom emoji markup's id (`<:name:id>`, `<a:name:id>`), else the emoji as given. */
function reactionKey(emoji) {
  const custom = /^<a?:[^:>]+:(\d+)>$/.exec(emoji);
  return custom ? custom[1] : emoji;
}

/**
 * The files a posted message carries, each named by its attachment id with the message's id.
 * @param {unknown} posted  the discord.js message the send answered
 * @returns {Array<{ messageId: string, attachmentId: string }>}
 */
function postedFiles(posted) {
  const message = /** @type {{ id?: unknown, attachments?: { values?: () => Iterable<{ id?: unknown }> } } | null} */ (
    posted
  );
  const values = message?.attachments?.values;
  if (typeof values !== 'function' || typeof message?.id !== 'string') return [];
  const messageId = message.id;
  return [...values.call(message.attachments)]
    .map((file) => file?.id)
    .filter((id) => typeof id === 'string')
    .map((attachmentId) => ({ messageId, attachmentId: /** @type {string} */ (attachmentId) }));
}

/**
 * The Discord adapter over a discord.js client.
 * @param {{ client: object, config?: () => object, lookupChannel?: ((id: string) => object|null)|null,
 *   operations?: Iterable<string>|null, limits?: Partial<typeof DISCORD_LIMITS>, now?: () => number }} options
 *   `config`: the live config, read at each read (`normalizeOptions(config())`); `lookupChannel`: a channel the
 *   caller already holds, tried before the client's cache and
 *   fetch; `operations`: the capability names to offer (all of CAPABILITIES when absent), any
 *   other answers `unsupported` without a call; `limits`: over DISCORD_LIMITS; `now`: the clock
 *   that names a send's idempotency key.
 * @returns {import('../../src/interface/port.js').Port}
 */
export function createDiscordAdapter({
  client,
  config = () => ({}),
  lookupChannel = null,
  operations = null,
  limits = {},
  now = Date.now,
} = {}) {
  const offered = new Set(operations ? [...operations] : Object.values(CAPABILITIES));
  const caps = { ...DISCORD_LIMITS, ...limits };
  const supports = (operation) => offered.has(CAPABILITIES[operation]);
  const unsupported = () => notOk('unsupported', CODE.UNSUPPORTED);
  const selfId = () => client?.user?.id ?? null;
  let sends = 0;

  /** The channel `conversationId`, or null; a lookup that throws is rethrown as a lookup failure. */
  async function channelOf(conversationId) {
    const held = typeof lookupChannel === 'function' ? lookupChannel(conversationId) : null;
    if (held) return held;
    const cached = client?.channels?.cache?.get?.(conversationId);
    if (cached) return cached;
    if (typeof client?.channels?.fetch === 'function') return (await client.channels.fetch(conversationId)) ?? null;
    return null;
  }

  /** `{ channel }` or `{ result }` (a failed lookup) for a conversation reference. */
  async function resolveChannel(ref) {
    try {
      const channel = await channelOf(ref.conversationId);
      if (!channel) return { result: notOk('failed', CODE.UNKNOWN_CONVERSATION) };
      return { channel };
    } catch (err) {
      return { result: discordFailure(err, { sent: false }) };
    }
  }

  /** `{ channel, message }` or `{ result }` for a message reference. */
  async function resolveMessage(ref) {
    const { channel, result } = await resolveChannel(ref);
    if (result) return { result };
    if (typeof channel.messages?.fetch !== 'function') return { result: unsupported() };
    try {
      const message = await channel.messages.fetch(ref.messageId);
      if (!message) return { result: notOk('failed', CODE.UNKNOWN_MESSAGE) };
      return { channel, message };
    } catch (err) {
      return { result: discordFailure(err, { sent: false }) };
    }
  }

  /**
   * The discord.js payload of `content`: text, files, reply and the allowed mentions. An attachment
   * carrying `voice` (`{ durationSecs, waveform }`) is a voice message: the file gets its duration
   * and waveform, the message the voice flag and no text (Discord refuses text on a voice message).
   */
  function payloadOf(content) {
    const payload = {};
    const attachments = Array.isArray(content.attachments) ? content.attachments : [];
    const isVoice = attachments.some((attachment) => attachment?.voice);
    if (typeof content.text === 'string' && content.text !== '' && !isVoice) payload.content = content.text;
    if (attachments.length > 0) {
      payload.files = attachments.map((attachment) => {
        const file = attachment.data ?? attachment.url;
        if (!attachment.voice) return { attachment: file, name: attachment.name };
        return new AttachmentBuilder(file, { name: attachment.name })
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
  function refOf(posted, conversationId) {
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
  function authorRefusal(message) {
    const self = selfId();
    return self && message?.author?.id === self ? null : notOk('forbidden', CODE.NOT_OWN_MESSAGE);
  }

  const reads = createDiscordReads({
    client,
    config,
    iface: DISCORD_IFACE,
    resolveChannel,
    resolveMessage,
    failure: (err) => discordFailure(err, { sent: false }),
    refusal: (ref, needMessage = false) => refRefusal(ref, DISCORD_IFACE, { needMessage }),
  });

  return {
    iface: DISCORD_IFACE,

    async send(conversation, content) {
      sends += 1;
      const key = `${DISCORD_IFACE}-send-${now()}-${sends}`;
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
        try {
          const posted = await channel.send(payloadOf(part));
          results.push(ok(refOf(posted, conversation.conversationId), posted?.createdTimestamp));
          files.push(...postedFiles(posted));
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

    capabilities() {
      return { operations: [...offered], ...caps, messageUrl: DISCORD_MESSAGE_URL, reads: [...READ_ACTIONS] };
    },

    ...declaredHooks(),
  };
}
