// Discord's own search, for recall (src/behavior/recall-run.js): the guild's
// message search, the guild's member search, the messages around one
// message of a channel and the ones right after it. Thin I/O over discord.js: the message and member
// searches go through `guild.client.rest.get` (discord.js has no manager for
// them), the window and what follows it through the channel's message
// manager and normalizeMessage. discord.js runs every request of one guild's route one
// after another (@discordjs/rest: REST#queueRequest keys a SequentialHandler
// by the route's bucket and the guild id, whose queueRequest lets the next
// request start only when the previous one has finished), so a caller sends
// its searches sequentially -- sending them together would only queue them
// inside discord.js -- and gives each an abort signal for its deadline. The
// windows are channel routes (one queue per channel), so windows of different
// channels may be fetched together. Each function returns a result or null
// and never throws; a failure is logged with its status and error name,
// never a query or a message text.

import { log } from '../log.js';
import { normalizeMessage } from './collect.js';

/** Hits per search request (the API's maximum). */
const SEARCH_LIMIT = 25;

/** The kept fields of one raw API message hit. */
function hitOf(message) {
  const author = message?.author ?? {};
  return {
    id: message.id,
    channel_id: message.channel_id,
    timestamp: message.timestamp,
    author: { id: author.id ?? null, username: author.username ?? null, global_name: author.global_name ?? null, bot: author.bot === true },
    content: typeof message.content === 'string' ? message.content : '',
  };
}

/**
 * One page of the guild's message search (`GET /guilds/{id}/messages/search`),
 * newest first: `content`, `author_id`, `min_id`, `max_id` and `offset` are
 * sent when given, with `limit` 25, `sort_by=timestamp`, `sort_order=desc`.
 * The response's nested `messages` arrays are flattened (an inner array that
 * flags its hits with `hit: true` gives only those), de-duplicated by id;
 * each hit keeps `id`, `channel_id`, `timestamp`, `author` (`id`, `username`,
 * `global_name`, `bot`) and `content`. `total` is the API's
 * `total_results`. A failure -- an HTTP error, a network error, an abort by
 * `signal`, or an answer without a `messages` list (an index not ready yet) --
 * logs `search: failed` (`guildId`, `route: 'messages'`, `status`, `name`)
 * and resolves null.
 * @param {object} guild  A discord.js guild (its `client.rest` sends the request).
 * @param {{ content?: string, authorId?: string, minId?: string|null, maxId?: string|null, offset?: number }} params
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ total: number, hits: object[] }|null>}
 */
export async function searchMessages(guild, params = {}, { signal } = {}) {
  const query = new URLSearchParams();
  if (params.content) query.set('content', params.content);
  if (params.authorId) query.set('author_id', params.authorId);
  if (params.minId) query.set('min_id', params.minId);
  if (params.maxId) query.set('max_id', params.maxId);
  if (Number.isInteger(params.offset) && params.offset > 0) query.set('offset', String(params.offset));
  query.set('limit', String(SEARCH_LIMIT));
  query.set('sort_by', 'timestamp');
  query.set('sort_order', 'desc');
  try {
    const body = await guild.client.rest.get(`/guilds/${guild.id}/messages/search`, { query, signal });
    if (!Array.isArray(body?.messages)) {
      log.warn('search: failed', { guildId: guild.id, route: 'messages', status: null, name: 'not-indexed' });
      return null;
    }
    const seen = new Set();
    const hits = [];
    for (const group of body.messages) {
      const list = Array.isArray(group) ? group : [group];
      const flagged = list.filter((m) => m?.hit === true);
      for (const message of flagged.length > 0 ? flagged : list) {
        if (!message?.id || seen.has(message.id)) continue;
        seen.add(message.id);
        hits.push(hitOf(message));
      }
    }
    const total = Number.isFinite(body.total_results) ? body.total_results : hits.length;
    return { total, hits };
  } catch (err) {
    log.warn('search: failed', { guildId: guild?.id ?? null, route: 'messages', status: err?.status ?? err?.statusCode ?? null, name: err?.name ?? null });
    return null;
  }
}

/**
 * Members of the guild whose username, global name or nickname starts with
 * `query` (`GET /guilds/{id}/members/search`, Discord's prefix match), at
 * most `limit` (1..1000): `{ id, username, globalName, nick, bot }` each. A
 * failure logs `search: failed` (`route: 'members'`) and resolves null.
 * @param {object} guild  A discord.js guild.
 * @param {string} query
 * @param {number} limit
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ id: string, username: string|null, globalName: string|null, nick: string|null, bot: boolean }[]|null>}
 */
export async function searchMembers(guild, query, limit, { signal } = {}) {
  const params = new URLSearchParams();
  params.set('query', String(query ?? ''));
  params.set('limit', String(Math.min(1000, Math.max(1, Math.floor(Number(limit) || 1)))));
  try {
    const body = await guild.client.rest.get(`/guilds/${guild.id}/members/search`, { query: params, signal });
    return (Array.isArray(body) ? body : [])
      .filter((member) => member?.user?.id)
      .map((member) => ({
        id: member.user.id,
        username: member.user.username ?? null,
        globalName: member.user.global_name ?? null,
        nick: member.nick ?? null,
        bot: member.user.bot === true,
      }));
  } catch (err) {
    log.warn('search: failed', { guildId: guild?.id ?? null, route: 'members', status: err?.status ?? err?.statusCode ?? null, name: err?.name ?? null });
    return null;
  }
}

/** One page of `channel`'s messages for `query` (`around` or `after`), normalized, oldest first; null and `failed` logged on a failure. */
async function fetchPage(channel, query, limit, { selfId, embedTextChars, videoSites, maxUrlChars }, failed) {
  try {
    const size = Math.min(100, Math.max(1, Math.floor(Number(limit) || 1)));
    const page = await channel.messages.fetch({ ...query, limit: size });
    return [...page.values()]
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map((message) => normalizeMessage(message, selfId, { embedTextChars, videoSites, maxUrlChars }));
  } catch (err) {
    log.warn(failed, { channel: channel?.id ?? null, status: err?.status ?? err?.statusCode ?? null, name: err?.name ?? null });
    return null;
  }
}

/**
 * Up to `limit` (1..100) messages of `channel` around `messageId` (Discord's
 * `around`), normalized with normalizeMessage, oldest first. A failure (the
 * fetch or a message that cannot be normalized) logs `search: around failed`
 * (`channel`, `status`, `name`) and resolves null.
 * @param {import('discord.js').TextBasedChannel} channel
 * @param {string} messageId
 * @param {number} limit
 * @param {{ selfId: string, embedTextChars?: number, videoSites?: string[], maxUrlChars?: number }} options
 * @returns {Promise<object[]|null>}
 */
export function fetchAround(channel, messageId, limit, options = {}) {
  return fetchPage(channel, { around: messageId }, limit, options, 'search: around failed');
}

/**
 * Up to `limit` (1..100) messages of `channel` right after `messageId`
 * (Discord's `after`: the oldest ones following it), normalized with
 * normalizeMessage, oldest first: what follows a recall window. A failure
 * logs `search: after failed` (`channel`, `status`, `name`) and resolves
 * null.
 * @param {import('discord.js').TextBasedChannel} channel
 * @param {string} messageId
 * @param {number} limit
 * @param {{ selfId: string, embedTextChars?: number, videoSites?: string[], maxUrlChars?: number }} options
 * @returns {Promise<object[]|null>}
 */
export function fetchAfter(channel, messageId, limit, options = {}) {
  return fetchPage(channel, { after: messageId }, limit, options, 'search: after failed');
}
