// The Discord adapter of the interface port (src/interface/port.js): the persona's effects in
// Discord's terms. A conversation is a channel id, a message a message id, a member a user id,
// all namespaced `discord`. Channels and messages are looked up by id through the client (a
// channel the caller already holds first, when it passes `lookupChannel`); mentions become
// `allowedMentions` (nobody is notified unless named); edit and delete touch only messages the
// bot wrote (else `forbidden`). Discord's answers are normalised: a 429 is `failed` and
// retryable, a 403 `forbidden`, any other 4xx `failed` with its `http-<status>` code; a 5xx, a
// timeout or a network error once the request may have left is `unknown` -- it may have taken
// effect, so the caller never sends it again blindly. A failure while looking the target up is
// always `failed`: nothing was sent.

import { CAPABILITIES, contentRefusal, declaredHooks, mentionsOf, notOk, ok, refRefusal } from '../../src/interface/port.js';
import { CODE, httpCode } from '../../src/skills/codes.js';

/** The namespace of every Discord reference. */
export const DISCORD_IFACE = 'discord';

/**
 * Discord's limits for a bot: 2000 characters a message, 10 files, 10 MiB a file on a server
 * without boosts.
 */
export const DISCORD_LIMITS = Object.freeze({ maxTextLength: 2000, maxAttachments: 10, maxAttachmentBytes: 10 * 1024 * 1024 });

/** Error names and codes of a request that timed out or lost its connection. */
const TIMEOUT_NAMES = new Set(['AbortError', 'TimeoutError']);
const NETWORK_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);

/**
 * A thrown discord.js error as a port result. `sent`: the failing call may have reached Discord
 * with its effect (a send, an edit, a delete, a reaction); false for a lookup before it.
 * @param {unknown} err
 * @param {{ sent: boolean }} phase
 * @returns {import('../../src/interface/port.js').PortResult}
 */
export function discordFailure(err, { sent }) {
  const status = Number.isInteger(err?.status) ? err.status : Number.isInteger(err?.statusCode) ? err.statusCode : null;
  if (status === 429 || err?.name === 'RateLimitError') return notOk('failed', httpCode(429), { retryable: true, cause: err });
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
 * The Discord adapter over a discord.js client.
 * @param {{ client: object, lookupChannel?: ((id: string) => object|null)|null, operations?: Iterable<string>|null,
 *   limits?: Partial<typeof DISCORD_LIMITS> }} options
 *   `lookupChannel`: a channel the caller already holds, tried before the client's cache and
 *   fetch; `operations`: the capability names to offer (all of CAPABILITIES when absent), any
 *   other answers `unsupported` without a call; `limits`: over DISCORD_LIMITS.
 * @returns {import('../../src/interface/port.js').Port}
 */
export function createDiscordAdapter({ client, lookupChannel = null, operations = null, limits = {} } = {}) {
  const offered = new Set(operations ? [...operations] : Object.values(CAPABILITIES));
  const caps = { ...DISCORD_LIMITS, ...limits };
  const supports = (operation) => offered.has(CAPABILITIES[operation]);
  const unsupported = () => notOk('unsupported', CODE.UNSUPPORTED);
  const selfId = () => client?.user?.id ?? null;

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

  /** The discord.js payload of `content`: text, files, reply and the allowed mentions. */
  function payloadOf(content) {
    const payload = {};
    if (typeof content.text === 'string' && content.text !== '') payload.content = content.text;
    if (Array.isArray(content.attachments) && content.attachments.length > 0) {
      payload.files = content.attachments.map((attachment) => ({ attachment: attachment.data ?? attachment.url, name: attachment.name }));
    }
    // The key is always there, undefined without a target: the payload the engine always sent.
    payload.reply = content.replyTo ? { messageReference: content.replyTo.messageId, failIfNotExists: false } : undefined;
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
    return { iface: DISCORD_IFACE, conversationId, ...(messageId ? { messageId } : {}), ...(memberId ? { memberId } : {}) };
  }

  /** A forbidden result unless `message` is the bot's own. */
  function authorRefusal(message) {
    const self = selfId();
    return self && message?.author?.id === self ? null : notOk('forbidden', CODE.NOT_OWN_MESSAGE);
  }

  return {
    iface: DISCORD_IFACE,

    async send(conversation, content) {
      if (!supports('send')) return unsupported();
      const refused = refRefusal(conversation, DISCORD_IFACE) ?? contentRefusal(content, caps, DISCORD_IFACE);
      if (refused) return refused;
      const { channel, result } = await resolveChannel(conversation);
      if (result) return result;
      if (typeof channel.send !== 'function') return unsupported();
      try {
        const posted = await channel.send(payloadOf(content));
        return ok(refOf(posted, conversation.conversationId), posted?.createdTimestamp);
      } catch (err) {
        return discordFailure(err, { sent: true });
      }
    },

    async edit(message, content) {
      if (!supports('edit')) return unsupported();
      const refused = refRefusal(message, DISCORD_IFACE, { needMessage: true }) ?? contentRefusal(content, caps, DISCORD_IFACE);
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

    /**
     * Reads messages by id from one conversation: their text and attachments (url, name, content type, size), or
     * `missing` for an id Discord no longer has. A read, not an effect: it is not one of CAPABILITIES. A failure that
     * is not "the message is gone" fails the whole call, so the caller can try again later.
     */
    async fetchMessages(conversation, messageIds) {
      const refused = refRefusal(conversation, DISCORD_IFACE);
      if (refused) return refused;
      const { channel, result } = await resolveChannel(conversation);
      if (result) return result;
      if (typeof channel.messages?.fetch !== 'function') return unsupported();
      const messages = [];
      for (const id of Array.isArray(messageIds) ? messageIds : []) {
        try {
          const found = await channel.messages.fetch(String(id));
          if (!found) {
            messages.push({ messageId: String(id), missing: true });
            continue;
          }
          const files = found.attachments?.values ? [...found.attachments.values()] : [];
          messages.push({
            messageId: String(id),
            text: typeof found.content === 'string' ? found.content : '',
            attachments: files.map((file) => ({
              url: file.url,
              name: file.name,
              contentType: file.contentType ?? undefined,
              size: Number.isFinite(file.size) ? file.size : undefined,
              ...(Number.isFinite(file.duration) ? { durationSec: file.duration } : {}),
              ...(typeof file.waveform === 'string' ? { waveform: file.waveform } : {}),
            })),
          });
        } catch (err) {
          if (err?.status === 404 || err?.code === 10008) {
            messages.push({ messageId: String(id), missing: true });
            continue;
          }
          return discordFailure(err, { sent: false });
        }
      }
      return { ...ok(), messages };
    },

    capabilities() {
      return { operations: new Set(offered), limits: { ...caps } };
    },

    ...declaredHooks(),
  };
}
