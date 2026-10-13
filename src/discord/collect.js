// Everything that reads from Discord: turning discord.js messages into plain
// normalized objects and fetching the context of a turn — the last N messages
// of the current channel plus a few fresh messages from neighbouring channels —
// and what the bot may do in a channel (read, send, attach, react) and who else
// can view it (the audience the pulled-channel rail compares).

import { PermissionFlagsBits, SnowflakeUtil, MessageReferenceType, OverwriteType } from 'discord.js';
import { log } from '../log.js';
import { ID_DIGITS } from '../memory/mentions.js';
import { MINUTE_MS } from '../time.js';
import {
  classifyAttachment,
  classifyEmbed,
  stickerUrl,
  emojiUrl,
  linkThumbnailCacheKey,
  discordCdnVideo,
  DISCORD_CDN_SITES,
  siteOf,
  positiveDimension,
} from './media.js';
import { extractVideoUrls, videoSiteFor, videoUrlCacheKey } from './video-sites.js';
import { CUSTOM_EMOJI_MARKUP } from './emoji.js';

const TEXT_PREVIEW_SIZE_GUARD = 256 * 1024; // 256 KB — never fetch a bigger "text" attachment
/** Discord's REST page size for a message list. */
export const PAGE = 100;
const MAX_EMOJIS_PER_MESSAGE = 5;
// Groups: the animated flag (`a` or empty), the name, the id.
const CUSTOM_EMOJI_RE = new RegExp(CUSTOM_EMOJI_MARKUP, 'g');
const MAX_CHANNEL_MENTIONS = 5;
// A raw channel mention `<#id>`; the group is the id.
const CHANNEL_MENTION_RE = new RegExp(`<#(${ID_DIGITS})>`, 'g');

/**
 * Custom emoji markup `<:name:id>` / `<a:name:id>` reads better as `:name:`.
 * discord.js's cleanContent already does this for well-formed ids; this is a
 * safety net for any markup it leaves behind.
 */
function cleanEmoji(text) {
  return text.replace(CUSTOM_EMOJI_RE, ':$2:');
}

/**
 * Custom emoji `<:name:id>` / `<a:name:id>` written in a message's text (the
 * text itself keeps reading as `:name:`, see cleanEmoji above): de-duplicated
 * by id, in first-appearance order, capped at MAX_EMOJIS_PER_MESSAGE.
 * @param {string} text  The RAW `content` (discord.js's cleanContent has already
 *   rewritten the markup to `:name:`, dropping the id); cleanContent only as a
 *   fallback when the raw content is missing.
 * @returns {{ id: string, name: string, animated: boolean, url: string }[]}
 */
function extractEmojis(text) {
  const seen = new Map();
  CUSTOM_EMOJI_RE.lastIndex = 0;
  let match;
  while ((match = CUSTOM_EMOJI_RE.exec(String(text ?? '')))) {
    const [, animatedFlag, name, id] = match;
    if (seen.has(id)) continue;
    seen.set(id, { id, name, animated: Boolean(animatedFlag), url: emojiUrl(id) });
    if (seen.size >= MAX_EMOJIS_PER_MESSAGE) break;
  }
  return [...seen.values()];
}

/**
 * The channel ids written as raw channel mentions `<#id>` in a message's
 * text, in first-appearance order, each once, capped at MAX_CHANNEL_MENTIONS.
 * @param {string} text  The RAW `content`: discord.js's cleanContent has
 *   already rewritten every `<#id>` to `#name`, dropping the id.
 * @returns {string[]}
 */
function extractChannelIds(text) {
  const seen = new Set();
  CHANNEL_MENTION_RE.lastIndex = 0;
  let match;
  while ((match = CHANNEL_MENTION_RE.exec(String(text ?? '')))) {
    seen.add(match[1]);
    if (seen.size >= MAX_CHANNEL_MENTIONS) break;
  }
  return [...seen];
}

/** Classified stickers of a message/snapshot: `{ id, name, format, url }` (see stickerUrl). */
function normalizeStickers(stickers) {
  return [...(stickers?.values?.() ?? [])].map((sticker) => ({
    id: sticker.id,
    name: sticker.name,
    format: sticker.format,
    url: stickerUrl(sticker.id, sticker.format),
  }));
}

/**
 * The reactions on a message: a custom emoji reads as `:name:`, a unicode one
 * as itself; `mine` is the bot's own. Sorted by count descending, ties keep
 * the collection's order; a count that is not a positive integer is skipped.
 * @returns {{ emoji: string, count: number, mine: boolean }[]}
 */
function normalizeReactions(reactions) {
  return [...(reactions?.cache?.values?.() ?? [])]
    .filter((reaction) => Number.isInteger(reaction?.count) && reaction.count > 0 && reaction.emoji?.name)
    .map((reaction) => ({
      emoji: reaction.emoji.id ? `:${reaction.emoji.name}:` : reaction.emoji.name,
      count: reaction.count,
      mine: Boolean(reaction.me),
    }))
    .sort((a, b) => b.count - a.count);
}

/** Whether the message carries Discord's voice-message flag (the whole message is flagged, not the attachment). */
function isVoiceMessageFlag(message) {
  try {
    return Boolean(message.flags?.has?.('IsVoiceMessage'));
  } catch {
    return false;
  }
}

/** Classified attachments of a message/snapshot, in Discord's own order. */
function normalizeAttachments(attachments, isVoice) {
  return [...(attachments?.values?.() ?? [])].map((attachment) => ({
    id: attachment.id,
    kind: classifyAttachment({ contentType: attachment.contentType, name: attachment.name, isVoice }),
    name: attachment.name,
    url: attachment.url,
    size: attachment.size ?? null,
    durationSec: attachment.duration ?? null,
    width: positiveDimension(attachment.width),
    height: positiveDimension(attachment.height),
  }));
}

/**
 * Classified embeds (only the ones with a URL: nothing to de-dupe or describe
 * otherwise). A `kind: 'link'` embed carrying a thumbnail (the newly
 * describable video-site preview, e.g. YouTube) gets a STABLE id
 * (`linkThumbnailCacheKey`, derived from the thumbnail URL, not the message)
 * instead of the usual per-message-index one, so a repost of the same video
 * shares one description-cache entry and the slim memory buffer never has to
 * store the URL to look it up again later (see src/memory/update.js
 * `observe()`/`analyze()`). A `kind: 'gif'` embed (a `gifv` embed or a GIF
 * site, see classifyEmbed; `videoSites` keeps a video site's `gifv` a link)
 * keeps the existing per-message-index id, unchanged. A `kind: 'link'` embed whose URL
 * is on one of `videoSites` takes `videoUrlCacheKey(url)` instead -- the same
 * id a typed link of that video gets (see normalizeLinks), so one video has
 * one id (and one video/still-frame cache entry) whether Discord embedded it
 * or not.
 */
function normalizeEmbedLinks(idPrefix, embeds, embedTextChars, videoSites) {
  const watchSites = Array.isArray(videoSites) && videoSites.length > 0;
  return [...(embeds ?? [])]
    .filter((embed) => embed?.url)
    .map((embed, index) => {
      const classified = classifyEmbed(embed, { embedTextChars, videoSites });
      let id;
      if (classified.kind === 'link' && watchSites && videoSiteFor(classified.url, videoSites) !== null) {
        id = videoUrlCacheKey(classified.url);
      } else if (classified.kind === 'link' && classified.thumbnailUrl) {
        id = linkThumbnailCacheKey(classified.thumbnailUrl);
      } else {
        id = `${idPrefix}#e${index}`;
      }
      return { id, ...classified };
    });
}

/**
 * The embed links (see normalizeEmbedLinks) followed by one synthetic link per
 * video-site URL typed in the text (`videoSites`, see
 * src/discord/video-sites.js) that no embed already carries -- compared by the
 * exact URL and by its canonical `videoUrlCacheKey`, so a video Discord did
 * embed is never listed twice. A synthetic link's id IS that cache key.
 * `embedLinks` is returned apart because only those URLs are stripped from
 * the message text: a typed video link stays readable where the person put it.
 */
function normalizeLinks(idPrefix, embeds, embedTextChars, cleanText, videoSites) {
  const embedLinks = normalizeEmbedLinks(idPrefix, embeds, embedTextChars, videoSites);
  const links = [...embedLinks];
  if (Array.isArray(videoSites) && videoSites.length > 0) {
    const seenUrls = new Set(embedLinks.map((link) => link.url));
    const seenKeys = new Set(embedLinks.map((link) => videoUrlCacheKey(link.url)));
    for (const url of extractVideoUrls(cleanText, videoSites)) {
      const key = videoUrlCacheKey(url);
      if (seenUrls.has(url) || seenKeys.has(key)) continue;
      seenUrls.add(url);
      seenKeys.add(key);
      links.push({ id: key, kind: 'link', site: siteOf(url), title: '', text: '', thumbnailUrl: null, url });
    }
  }
  return { embedLinks, links };
}

/**
 * Video attachments that arrive as a LINK to a Discord CDN attachment (see
 * discordCdnVideo) instead of an upload: taken from the embeds whose `url` is
 * one, then from such URLs typed in the text (found by extractVideoUrls over
 * the CDN hosts, the same extraction as a video-site link). Each becomes a
 * normal attachment entry `{ id, kind: 'video', name, url, size: null,
 * durationSec: null }`, the embed's URL preferred over a typed one of the same
 * id, de-duplicated by id against `attachments` (the real ones) and each
 * other. `embedUrls` are the embeds to drop from the links; `urls` every
 * matched URL, to strip from the text like a rendered embed's.
 * @returns {{ videos: object[], embedUrls: Set<string>, urls: string[] }}
 */
function cdnVideoAttachments(embeds, cleanText, attachments) {
  const known = new Set(attachments.map((attachment) => attachment.id));
  const byId = new Map();
  const embedUrls = new Set();
  const urls = [];
  const take = (url) => {
    const video = discordCdnVideo(url);
    if (!video) return false;
    urls.push(url);
    if (!known.has(video.id) && !byId.has(video.id)) {
      byId.set(video.id, { id: video.id, kind: 'video', name: video.name, url, size: null, durationSec: null });
    }
    return true;
  };
  for (const embed of embeds ?? []) {
    if (embed?.url && take(embed.url)) embedUrls.add(embed.url);
  }
  for (const url of extractVideoUrls(cleanText, DISCORD_CDN_SITES)) take(url);
  return { videos: [...byId.values()], embedUrls, urls };
}

/**
 * The media of a message or a snapshot: its real attachments followed by the
 * Discord CDN video links (see cdnVideoAttachments), the links without the
 * embeds of those videos, and the text with every rendered embed URL and
 * every CDN video URL stripped (an `<url>` form included).
 */
function normalizeMedia(idPrefix, source, isVoice, cleanText, embedTextChars, videoSites) {
  const real = normalizeAttachments(source.attachments, isVoice);
  const { embedLinks, links } = normalizeLinks(idPrefix, source.embeds, embedTextChars, cleanText, videoSites);
  const cdn = cdnVideoAttachments(source.embeds, cleanText, real);
  const stripped = cdn.urls.flatMap((url) => [{ url: `<${url}>` }, { url }]);
  return {
    attachments: [...real, ...cdn.videos],
    links: links.filter((link) => !cdn.embedUrls.has(link.url)),
    content: stripEmbedUrls(cleanText, [...stripped, ...embedLinks]),
  };
}

/** Remove the raw URL of every rendered link/gif embed from the message text, so it never appears twice. */
function stripEmbedUrls(content, links) {
  let result = content;
  for (const link of links) {
    if (!link.url) continue;
    result = result.split(link.url).join('');
  }
  return result.replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * A forwarded message (message snapshot): its own content, media and stickers,
 * no id/channel/author. A Discord CDN video link in it becomes a video
 * attachment, as in the message itself (see normalizeMedia).
 */
function normalizeSnapshot(snapshot, embedTextChars, videoSites) {
  const isVoice = isVoiceMessageFlag(snapshot);
  const cleanContent = snapshot.cleanContent ?? snapshot.content ?? '';
  const emojis = extractEmojis(snapshot.content ?? cleanContent);
  const cleanText = cleanEmoji(cleanContent).trim();
  const { attachments, links, content } = normalizeMedia(
    snapshot.id ?? 'fwd', snapshot, isVoice, cleanText, embedTextChars, videoSites,
  );
  return {
    content,
    attachments,
    links,
    stickers: normalizeStickers(snapshot.stickers),
    emojis,
  };
}

/**
 * The replied-to author's id when they are among the message's mentioned
 * users only because of the reply ping: `mentions.repliedUser` is set, that
 * user is in `mentionedUserIds`, and the raw content holds no `<@id>` /
 * `<@!id>` token for them. Null otherwise.
 */
function replyPingUserId(message, mentionedUserIds) {
  const repliedId = message.mentions?.repliedUser?.id;
  if (!repliedId || !message.reference?.messageId) return null;
  if (!mentionedUserIds.includes(repliedId)) return null;
  const typed = new RegExp(`<@!?${repliedId}>`).test(message.content ?? '');
  return typed ? null : repliedId;
}

/**
 * Reduce a discord.js Message to the plain shape the rest of the code works
 * with. `options.embedTextChars` caps link/gif title+description text
 * (default `config.media.embedTextChars`, see config.json).
 * `options.videoSites` (default `[]`) lists the video-site hosts whose URLs
 * typed in the text become synthetic `link` items (see normalizeLinks), in
 * the message and its forwarded snapshots alike. A link to a Discord CDN
 * video attachment (embedded or typed) becomes a `video` attachment after the
 * real ones, not a link, with its URL stripped from `content` (see
 * cdnVideoAttachments), so it is labelled, watched and cached like an upload.
 * `reactions` lists the message's reactions (see normalizeReactions), `[]`
 * when it has none. `mentionedChannelIds` lists the channel ids of the raw
 * channel mentions `<#id>` in the message's own text (see
 * extractChannelIds; `[]` when there are none; forwarded snapshots are not
 * scanned), while `content` keeps reading `#name`.
 * @param {object} message  A discord.js Message.
 * @param {string} selfId
 * @param {{ embedTextChars?: number, videoSites?: string[] }} [options]
 */
export function normalizeMessage(message, selfId, options = {}) {
  const embedTextChars = options.embedTextChars ?? 200;
  const videoSites = options.videoSites ?? [];
  const isVoice = isVoiceMessageFlag(message);
  const cleanContent = message.cleanContent ?? '';
  const emojis = extractEmojis(message.content ?? cleanContent);
  const cleanText = cleanEmoji(cleanContent).trim();
  const { attachments, links, content } = normalizeMedia(
    message.id, message, isVoice, cleanText, embedTextChars, videoSites,
  );
  const forwarded = [...(message.messageSnapshots?.values?.() ?? [])].map((snapshot) =>
    normalizeSnapshot(snapshot, embedTextChars, videoSites),
  );

  // A forward's `message.reference.messageId` is the ORIGINAL message, not
  // something this message replies to -- treating it as `replyToId` would
  // wrongly render a "replying to" marker. A reference with no `type` at all
  // (an older/plain payload) is a normal reply, never a forward.
  const isForward = message.reference?.type === MessageReferenceType.Forward;
  const sourceChannelId = isForward ? message.reference?.channelId : null;
  const sourceChannel = sourceChannelId ? message.guild?.channels?.cache?.get(sourceChannelId) : null;
  const mentionedUserIds = [...(message.mentions?.users?.keys?.() ?? [])];

  return {
    id: message.id,
    channelId: message.channelId,
    channelName: message.channel?.name ?? null,
    channelCategory: message.channel?.parent?.name ?? null,
    channelTopic: message.channel?.topic ?? null,
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
    self: message.author.id === selfId,
    bot: message.author.bot && message.author.id !== selfId,
    content,
    ts: message.createdTimestamp,
    // Real mentions -- the strongest signal for who this message names, see
    // src/behavior/prompt.js's <people> "asked about" window. `content`
    // above is `cleanContent`-derived and already reads "@DisplayName", so
    // this is the only place a stable member id survives normalization.
    mentionedUserIds,
    // Channels written as `<#id>` -- the only place their ids survive, since
    // `content` reads `#name`; an explicit mention pulls that channel into a
    // turn (src/behavior/pull.js).
    mentionedChannelIds: extractChannelIds(message.content),
    replyToId: isForward ? null : (message.reference?.messageId ?? null),
    // The replied-to author when Discord's reply ping alone put them into
    // `mentionedUserIds` (no `<@id>` typed in the text), else null -- so the
    // address classifier's pre-filter (src/behavior/mention.js) can tell a
    // reply ping from a real mention of another member.
    replyPingUserId: isForward ? null : replyPingUserId(message, mentionedUserIds),
    // The forwarded snapshot's source channel name, when it resolves in the
    // same guild -- see src/discord/format.js's `forwardedFrom` rendering.
    forwardedFrom: sourceChannel?.name ?? null,
    attachments,
    links,
    forwarded,
    stickers: normalizeStickers(message.stickers),
    emojis,
    // Fresh on every history fetch (a REST call); a message straight from
    // messageCreate has none yet. Forwarded snapshots carry none.
    reactions: normalizeReactions(message.reactions),
  };
}

/**
 * The first `maxChars` characters of a text attachment's content, fetched
 * lazily — only ever called for a message that ends up inside a real
 * request (see src/behavior/prompt.js, src/memory/update.js), never during
 * plain normalization. A response bigger than 256 KB, or any fetch failure,
 * returns `null` so the caller falls back to the plain `file` form.
 * @param {string} url
 * @param {number} maxChars
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string|null>}
 */
export async function fetchTextPreview(url, maxChars, fetchImpl = fetch) {
  return (await fetchPreview(url, maxChars, fetchImpl))?.text ?? null;
}

/** fetchTextPreview's body: `{ text, lost }` (`lost`: the characters past `maxChars` left out), or null. */
async function fetchPreview(url, maxChars, fetchImpl) {
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return null;
    const declaredSize = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > TEXT_PREVIEW_SIZE_GUARD) return null;
    const text = await response.text();
    if (!Number.isFinite(declaredSize) && Buffer.byteLength(text, 'utf8') > TEXT_PREVIEW_SIZE_GUARD) return null;
    const preview = text.slice(0, maxChars);
    return { text: preview, lost: text.length - preview.length };
  } catch (err) {
    log.warn('collect: text attachment preview fetch failed', { error: err });
    return null;
  }
}

/**
 * Return a shallow-cloned copy of `messages` with `previewText` filled in on
 * every `kind: 'text'` attachment that does not have one yet (best effort,
 * in parallel, never mutates the input). Meant to run once, right before the
 * messages are handed to buildRequest/buildMemoryRequest — see the header
 * comment of fetchTextPreview. A preview cut at `maxChars` also carries
 * `previewLost`: the characters left out (the turn's journal names the cut).
 * @param {object[]} messages
 * @param {number} maxChars
 * @param {typeof fetch} [fetchImpl]
 */
export async function withTextPreviews(messages, maxChars, fetchImpl = fetch) {
  return Promise.all(
    messages.map(async (message) => {
      const textAttachments = (message.attachments ?? []).filter((a) => a.kind === 'text' && !a.previewText);
      if (textAttachments.length === 0) return message;
      const previews = await Promise.all(textAttachments.map((a) => fetchPreview(a.url, maxChars, fetchImpl)));
      const byId = new Map(textAttachments.map((a, i) => [a.id, previews[i]]));
      return {
        ...message,
        attachments: message.attachments.map((a) => {
          const preview = byId.get(a.id);
          if (!preview) return a;
          return preview.lost > 0 ? { ...a, previewText: preview.text, previewLost: preview.lost } : { ...a, previewText: preview.text };
        }),
      };
    }),
  );
}

/** Whether the config lets the persona read/act in this channel at all. */
export function channelAllowed(channel, botConfig) {
  const { allow = [], deny = [] } = botConfig.channels ?? {};
  if (deny.includes(channel.id)) return false;
  return allow.length === 0 || allow.includes(channel.id);
}

/**
 * Whether the bot member holds permission `flag` in `channel`: no bot
 * member, an unviewable channel or no resolved permissions count as no. A
 * channel without a guild (a private chat) has no member permissions:
 * always yes.
 */
function hasPermission(channel, flag) {
  if (!channel.guild) return true;
  const me = channel.guild.members.me;
  if (!me || !channel.viewable) return false;
  return channel.permissionsFor(me)?.has(flag) ?? false;
}

/**
 * Whether the bot may read `channel`'s history (see hasPermission: a channel
 * without a guild is always yes).
 * @returns {boolean}
 */
export function canRead(channel) {
  return hasPermission(channel, PermissionFlagsBits.ReadMessageHistory);
}

/**
 * Whether the bot may put a reaction on a message in `channel`: Add Reactions
 * plus Read Message History, which Discord also requires for a reaction (see
 * hasPermission: a channel without a guild is always yes). A channel the bot
 * cannot send in may still allow it.
 * @returns {boolean}
 */
export function canReact(channel) {
  return canRead(channel) && hasPermission(channel, PermissionFlagsBits.AddReactions);
}

/**
 * Whether the bot may send messages in `channel` (see hasPermission: a
 * channel without a guild is always yes).
 * @returns {boolean}
 */
export function canSend(channel) {
  return hasPermission(channel, PermissionFlagsBits.SendMessages);
}

/**
 * Whether the bot may attach files in `channel` (a drawing is posted as one),
 * resolved like canSend (see hasPermission).
 * @returns {boolean}
 */
export function canAttach(channel) {
  return hasPermission(channel, PermissionFlagsBits.AttachFiles);
}

/**
 * Last `limit` messages of a channel (at most one page), oldest first,
 * normalized. `embedTextChars` caps link/gif embed title+description
 * (config.media.embedTextChars); `videoSites` lists the video-site hosts
 * whose typed URLs become link items (config.media.video.sites).
 * @param {import('discord.js').TextBasedChannel} channel
 * @param {{ limit: number, selfId: string, embedTextChars?: number, videoSites?: string[] }} options
 * @returns {Promise<object[]>}
 */
export async function fetchHistory(channel, { limit, selfId, embedTextChars, videoSites }) {
  const fetched = await channel.messages.fetch({ limit: Math.min(PAGE, limit) });
  return [...fetched.values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((message) => normalizeMessage(message, selfId, { embedTextChars, videoSites }));
}

/** A Discord snowflake string one greater than `id`, so `before: bump(id)` includes `id` itself. */
function bumpSnowflake(id) {
  return (BigInt(id) + 1n).toString();
}

/**
 * Fetch a window of a channel's history, OLDEST first, for a memory history
 * backfill. Pages backwards PAGE messages at a time, starting at `anchorId`
 * inclusive (or the channel's most recent message when `anchorId` is
 * absent), until `limit` messages are collected, the channel start is
 * reached (a page comes back short), or a message older than `minTs` is met
 * (only when `minTs > 0`). A page fetch error ends the window with whatever
 * was collected so far; it is logged, never thrown.
 * @param {import('discord.js').TextBasedChannel} channel
 * @param {{ anchorId?: string|null, limit: number, minTs?: number, selfId: string, embedTextChars?: number,
 *   videoSites?: string[] }} options
 * @returns {Promise<object[]>}
 */
export async function fetchHistoryWindow(channel, { anchorId, limit, minTs = 0, selfId, embedTextChars, videoSites }) {
  const collected = []; // newest first while accumulating; reversed at the end
  let before = anchorId ? bumpSnowflake(anchorId) : undefined;

  while (collected.length < limit) {
    let page;
    try {
      page = await channel.messages.fetch(before ? { limit: PAGE, before } : { limit: PAGE });
    } catch (err) {
      log.warn('collect: history window fetch failed', { channel: channel.id, error: err });
      break;
    }
    const batch = [...page.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    if (batch.length === 0) break;

    let hitFloor = false;
    for (const message of batch) {
      if (minTs > 0 && message.createdTimestamp < minTs) {
        hitFloor = true;
        break;
      }
      collected.push(normalizeMessage(message, selfId, { embedTextChars, videoSites }));
      if (collected.length >= limit) break;
    }

    before = batch[batch.length - 1].id;
    if (hitFloor || batch.length < PAGE || collected.length >= limit) break;
  }

  return collected.reverse();
}

/**
 * One message of `channel` by id: discord.js's message cache first, else one
 * fetch; null when it cannot be fetched (deleted, no access, any error) and,
 * without a request, for a missing or empty id.
 * @param {import('discord.js').TextBasedChannel} channel
 * @param {string|null|undefined} id
 * @returns {Promise<import('discord.js').Message|null>}
 */
export async function fetchMessage(channel, id) {
  if (!id) return null;
  try {
    const cached = channel.messages.cache?.get?.(id);
    if (cached) return cached;
    return (await channel.messages.fetch(id)) ?? null;
  } catch {
    return null;
  }
}

/**
 * The messages that lines of `history` reply to but that are outside it (a reply to something
 * older than the window), fetched by id and normalized like any history line, OLDEST first --
 * the caller prepends them so the transcript can show what a reply answers. Asked in this
 * order until `max` lines are fetched: the parent of `trigger` (when given; its own line may be
 * in `history` or not), then that parent's parent when the fetched parent is itself a reply to
 * a message outside the window (one level, so a short chain reads), then the parents of the
 * last `recent` lines of `history`, newest first. A parent already in `history` or already
 * fetched is not asked again. A parent that cannot be fetched (deleted, no access, any error)
 * is skipped and logged once (`collect: parent missing`, ids only).
 * @param {import('discord.js').TextBasedChannel} channel
 * @param {object[]} history  Normalized lines, oldest first.
 * @param {{ trigger?: { id: string, replyToId?: string|null }|null, recent: number, max: number, selfId: string,
 *   embedTextChars?: number, videoSites?: string[] }} options
 * @returns {Promise<object[]>}
 */
export async function fetchReplyParents(channel, history, { trigger = null, recent, max, selfId, embedTextChars, videoSites }) {
  const found = [];
  if (!(max > 0)) return found;
  const asked = new Set(history.map((m) => m.id));
  if (trigger?.id) asked.add(trigger.id);
  const fetchParent = async (id) => {
    if (!id || asked.has(id) || found.length >= max) return null;
    asked.add(id);
    const raw = await fetchMessage(channel, id);
    if (!raw) {
      log.info('collect: parent missing', { channel: channel.id, messageId: id });
      return null;
    }
    const parent = normalizeMessage(raw, selfId, { embedTextChars, videoSites });
    found.push(parent);
    return parent;
  };

  const parent = await fetchParent(trigger?.replyToId ?? null);
  if (parent) await fetchParent(parent.replyToId);
  const tail = recent > 0 ? history.slice(-recent).reverse() : [];
  for (const line of tail) await fetchParent(line.replyToId ?? null);

  return found.sort((a, b) => a.ts - b.ts);
}

/**
 * Whether `channel` is one the persona may read: a text channel, not a
 * thread, allowed by `bot.channels` (channelAllowed), not the dry-run mirror
 * (`bot.dryRunChannelId`, the owner's rehearsal room, never real
 * conversation), and the bot can read its history (canRead).
 * @param {object} channel  A discord.js guild channel.
 * @param {object} botConfig  The live `config.bot`.
 * @returns {boolean}
 */
export function isReadableChannel(channel, botConfig) {
  const mirrorId = botConfig?.dryRunChannelId;
  return (
    !(mirrorId && channel.id === mirrorId) &&
    channel.isTextBased() &&
    !channel.isThread() &&
    channelAllowed(channel, botConfig) &&
    canRead(channel)
  );
}

/**
 * Whether the persona may speak in `channel`: one it may read
 * (isReadableChannel: a text channel, not a thread, allowed by `bot.channels`,
 * not the dry-run mirror, its history readable) where the bot can send
 * (canSend). The one rule for a channel words go to unasked or on someone's
 * behalf: a routed call's or a noticed comment's destination
 * (src/behavior/turn.js#usableDestination), a spontaneous turn's channel.
 * @param {object} channel  A discord.js guild channel.
 * @param {object} botConfig  The live `config.bot`.
 * @returns {boolean}
 */
export function isWritableChannel(channel, botConfig) {
  return isReadableChannel(channel, botConfig) && canSend(channel);
}

/** The channels of a guild the persona may read (isReadableChannel), excluding `exceptId`. */
export function readableChannels(guild, botConfig, exceptId = null) {
  return [...guild.channels.cache.values()].filter(
    (channel) => channel.id !== exceptId && isReadableChannel(channel, botConfig),
  );
}

/** Timestamp of the newest message in a channel, from its snowflake — no API call. */
export function lastActivity(channel) {
  return channel.lastMessageId ? SnowflakeUtil.timestampFrom(channel.lastMessageId) : 0;
}

/**
 * Up to `neighborMessages` recent messages from each neighbouring channel that
 * saw activity within `neighborMaxAgeMinutes`. Channels are pre-filtered by the
 * snowflake of their last message, so quiet channels cost no API calls. Only
 * channels the persona may read are neighbours (readableChannels: never the
 * dry-run mirror), and only those `accept` takes (the caller's rail: a turn
 * passes the audience rail, src/discord/pull-fetch.js#audienceAllows), judged
 * among the active ones BEFORE the `neighborMaxChannels` cut, so a refused
 * channel takes no slot and costs no fetch; no `accept` takes every one.
 * `readOnly` marks a neighbour the bot cannot send in (canSend). A channel
 * without a guild (a private chat) has no neighbours.
 * @param {object} channel  The discord.js channel the turn speaks in.
 * @param {object} config   The live config.
 * @param {string} selfId
 * @param {number} [now]
 * @param {{ accept?: (other: object) => boolean }} [options]
 * @returns {Promise<{ channelId: string, channelName: string, readOnly: boolean, messages: object[] }[]>}
 */
export async function fetchNeighbors(channel, config, selfId, now = Date.now(), { accept } = {}) {
  if (!channel.guild) return [];
  const { neighborMessages, neighborMaxAgeMinutes, neighborMaxChannels } = config.context;
  const minTs = now - neighborMaxAgeMinutes * MINUTE_MS;

  const candidates = readableChannels(channel.guild, config.bot, channel.id)
    .filter((other) => lastActivity(other) >= minTs)
    .filter((other) => typeof accept !== 'function' || accept(other))
    .sort((a, b) => lastActivity(b) - lastActivity(a))
    .slice(0, neighborMaxChannels);

  const results = await Promise.all(
    candidates.map(async (other) => {
      const readOnly = !canSend(other);
      try {
        const messages = (
          await fetchHistory(other, { limit: neighborMessages, selfId, embedTextChars: config.media?.embedTextChars, videoSites: config.media?.video?.sites })
        ).filter((m) => m.ts >= minTs);
        return { channelId: other.id, channelName: other.name, readOnly, messages };
      } catch (err) {
        log.warn('collect: neighbour channel fetch failed', { channel: other.id, error: err });
        return { channelId: other.id, channelName: other.name, readOnly, messages: [] };
      }
    }),
  );
  return results.filter((result) => result.messages.length > 0);
}

/**
 * Who can view `channel`, read from Discord's permissions in the Audience
 * shape `audienceCovers` (src/behavior/elsewhere.js) compares:
 * - `everyone`: the @everyone role can view it (its overwrite applied);
 * - `roles`: the id of EVERY role of the guild (@everyone included) that can
 *   view it, each resolved on its own by `channel.permissionsFor(role)`, which
 *   applies the @everyone overwrite, then that role's own overwrite, and lets
 *   Administrator view everything -- so a role denied by an overwrite is
 *   missing even where @everyone can view, and the rail never needs a
 *   shortcut for @everyone;
 * - `roleAllow` / `roleDeny`: the roles whose own overwrite allows / denies
 *   View Channel (the @everyone overwrite belongs to `everyone` and `roles`,
 *   never here);
 * - `memberAllow` / `memberDeny`: the members whose own overwrite allows /
 *   denies View Channel, except the bot's own (`guild.members.me`, else
 *   `channel.client.user`): what the bot can view is not the audience the
 *   rail protects (canRead decides that), and a destination that admits the
 *   bot by name would otherwise cover no source. With no bot id known,
 *   nothing is left out. Any other bot's overwrite is left out too: a bot
 *   reads nothing the persona pulls, so it is no audience. A member is a bot
 *   when `guild.members.cache` holds it with `user.bot`; a member missing
 *   from the cache counts as a human (kept).
 * Member roles are not resolved (no member intent), and roles held only by
 * bots stay in the audience: `Role#members` filters the member cache, which
 * without the member intent misses members, so "every holder is a bot"
 * cannot be told. Null for a channel
 * without a guild (a private chat) and for a thread (overwrites do not
 * describe its audience: a private thread admits by membership); a null
 * audience never covers.
 * @param {object} channel  A discord.js channel.
 * @returns {{ everyone: boolean, roles: Set<string>, roleAllow: Set<string>, roleDeny: Set<string>,
 *   memberAllow: Set<string>, memberDeny: Set<string> }|null}
 */
export function audienceOf(channel) {
  const guild = channel?.guild;
  if (!guild || channel.isThread?.()) return null;
  const view = PermissionFlagsBits.ViewChannel;
  const canView = (role) => channel.permissionsFor(role)?.has(view) ?? false;
  const everyoneRole = guild.roles?.everyone ?? null;
  const everyoneId = everyoneRole?.id ?? guild.id; // the @everyone role's id is the guild's
  const botId = guild.members?.me?.id ?? channel.client?.user?.id ?? null;
  const isBotMember = (id) => (botId !== null && id === botId) || guild.members?.cache?.get?.(id)?.user?.bot === true;
  const roles = new Set();
  for (const role of guild.roles?.cache?.values?.() ?? []) {
    if (canView(role)) roles.add(role.id);
  }
  const sets = {
    [OverwriteType.Role]: { allow: new Set(), deny: new Set() },
    [OverwriteType.Member]: { allow: new Set(), deny: new Set() },
  };
  for (const overwrite of channel.permissionOverwrites?.cache?.values?.() ?? []) {
    const target = sets[overwrite.type];
    if (!target) continue;
    if (overwrite.type === OverwriteType.Role && overwrite.id === everyoneId) continue;
    if (overwrite.type === OverwriteType.Member && isBotMember(overwrite.id)) continue;
    if (overwrite.allow?.has?.(view)) target.allow.add(overwrite.id);
    if (overwrite.deny?.has?.(view)) target.deny.add(overwrite.id);
  }
  return {
    everyone: everyoneRole !== null && canView(everyoneRole),
    roles,
    roleAllow: sets[OverwriteType.Role].allow,
    roleDeny: sets[OverwriteType.Role].deny,
    memberAllow: sets[OverwriteType.Member].allow,
    memberDeny: sets[OverwriteType.Member].deny,
  };
}
