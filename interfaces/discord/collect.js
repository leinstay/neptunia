// Everything that reads from Discord: turning discord.js messages into plain
// normalized objects and fetching the context of a turn — the last N messages
// of the current channel plus a few fresh messages from neighbouring channels —
// and what the bot may do in a channel (read, send, attach, react) and who else
// can view it (the audience the pulled-channel rail compares). Also the inbound
// protocol events built from discord.js messages and reactions (toEvent,
// reactionEvent), until the Discord adapter becomes its own package.

import { ChannelType, PermissionFlagsBits, SnowflakeUtil, MessageReferenceType, OverwriteType } from 'discord.js';
import { log } from '../../src/log.js';
import { ID_DIGITS, URL_PATTERN } from '../../src/memory/mentions.ts';
import {
  classifyAttachment,
  classifyEmbed,
  emojiUrl,
  linkThumbnailCacheKey,
  siteOf,
  positiveDimension,
  clipWithEllipsis,
} from '../../src/media/classify.js';
import { DISCORD_CDN_SITES, discordCdnVideo, previewAttachments, previewLinks, stickerUrl } from './media.js';
import { extractVideoUrls, videoSiteFor, videoUrlCacheKey } from '../../src/media/video-sites.js';
import { CUSTOM_EMOJI_MARKUP } from '../../src/behavior/emoji.js';
import { reactionKey } from '../../src/protocol/reaction-key.ts';
import { MESSAGE_RECEIVED, REACTION_CHANGED } from '../../src/protocol/index.js';
import { memberView } from './members.ts';
import { DISCORD_IFACE } from './port.js';

/** Discord's REST page size for a message list. */
export const PAGE = 100;
const MAX_EMOJIS_PER_MESSAGE = 5;
// Groups: the animated flag (`a` or empty), the name, the id.
const CUSTOM_EMOJI_RE = new RegExp(CUSTOM_EMOJI_MARKUP, 'g');
const MAX_CHANNEL_MENTIONS = 5;
// A raw channel mention `<#id>`; the group is the id.
const CHANNEL_MENTION_RE = new RegExp(`<#(${ID_DIGITS})>`, 'g');
// config.json's context.maxUrlChars: the longest a URL in a message's text reads.
const DEFAULT_MAX_URL_CHARS = 200;
const URL_IN_TEXT_RE = new RegExp(URL_PATTERN, 'g');
// A Discord message link inside a text, optionally in angle brackets (`https://discord.com/channels/<guild>/<channel>/<message>`,
// the ptb, canary and discordapp hosts too, `@me` for a private chat). Groups: `<`, the link, the channel id, the
// message id, `>`. Not glued to a word or a path before it, and nothing that continues a URL (a word character,
// `/`, a query, a fragment) after it.
const MESSAGE_LINK_IN_TEXT_RE =
  /(?<![\w/])(<?)(https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(?:\d+|@me)\/(\d+)\/(\d+)\/?)(>?)(?![\w/?#&=%~+-])/gi;

/**
 * The messages a text links to, as neutral references in the order they are written: `{ iface, conversationId,
 * messageId, url, text }`. `text` is the span as written (a link in angle brackets with both brackets, a lone
 * bracket left out), `url` the link itself. The core turns a reference to a message of its window into that
 * message's `#n` and never reads a Discord address.
 * @param {unknown} text
 * @returns {Array<{ iface: string, conversationId: string, messageId: string, url: string, text: string }>}
 */
export function messageRefsOf(text) {
  if (typeof text !== 'string' || text === '') return [];
  return [...text.matchAll(MESSAGE_LINK_IN_TEXT_RE)].map((match) => {
    const [, open, link, conversationId, messageId, close] = match;
    return {
      iface: DISCORD_IFACE,
      conversationId,
      messageId,
      url: link,
      text: open && close ? `<${link}>` : link,
    };
  });
}

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
 * A discord.js reaction's emoji, or null: discord.js resolves it through the client's emoji cache, and on a REST-only
 * client (the tools) the getter throws.
 * @param {object|null|undefined} reaction
 * @returns {{ id?: string|null, name?: string|null }|null}
 */
export function emojiOf(reaction) {
  try {
    return reaction?.emoji ?? null;
  } catch {
    return null;
  }
}

/**
 * The reactions on a message: a custom emoji reads as `:name:`, a unicode one
 * as itself; `mine` is the bot's own. Sorted by count descending, ties keep
 * the collection's order; a count that is not a positive integer is skipped.
 * @returns {{ emoji: string, count: number, mine: boolean }[]}
 */
function normalizeReactions(reactions) {
  // A reaction whose emoji cannot be read (emojiOf: a REST-only client) is skipped, never fatal.
  return [...(reactions?.cache?.values?.() ?? [])]
    .map((reaction) => ({ reaction, emoji: reactionKey(emojiOf(reaction)) }))
    .filter(({ reaction, emoji }) => Number.isInteger(reaction?.count) && reaction.count > 0 && emoji)
    .map(({ reaction, emoji }) => ({
      emoji,
      count: reaction.count,
      mine: Boolean(reaction.me),
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * The name the transcript gives a member: their server display name, else their global name,
 * else their username; null when neither is known. Authors (normalizeMessage) and reactors
 * (fetchHistory's `reactors`) are named by it alike.
 * @param {{ displayName?: string|null }|null|undefined} member
 * @param {{ globalName?: string|null, username?: string|null }|null|undefined} user
 * @returns {string|null}
 */
export function displayNameOf(member, user) {
  return member?.displayName ?? user?.globalName ?? user?.username ?? null;
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
 * src/media/video-sites.js) that no embed already carries -- compared by the
 * exact URL and by its canonical `videoUrlCacheKey`, so a video Discord did
 * embed is never listed twice. A synthetic link's id IS that cache key.
 * `embedLinks` is returned apart for normalizeMedia, which decides which of
 * those URLs leave the message text.
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
 * Whether an embed's URL leaves the message text: a GIF's (the chat shows the
 * animation, not its address) or a file on the Discord CDN (an attachment
 * reads as its label, never as a URL). Any other link's URL stays where it
 * was posted -- the people in the chat see it, and the persona may post it again.
 */
function hidesUrl(link) {
  return link.kind === 'gif' || videoSiteFor(link.url, DISCORD_CDN_SITES) !== null;
}

/**
 * Every URL in `text` cut to `maxUrlChars` code points with an ellipsis
 * (clipWithEllipsis); query and tracking parameters stay as posted up to the
 * cut. `0` (or anything not a positive number) keeps every URL whole.
 */
function capUrls(text, maxUrlChars) {
  const limit = Math.floor(Number(maxUrlChars));
  if (!Number.isFinite(limit) || limit <= 0) return text;
  return text.replace(URL_IN_TEXT_RE, (url) => clipWithEllipsis(url, limit));
}

/**
 * The media of a message or a snapshot: its real attachments followed by the
 * Discord CDN video links (see cdnVideoAttachments), the links without the
 * embeds of those videos, and the text with the URL of every GIF embed and
 * Discord CDN file embed (hidesUrl) and every CDN video URL stripped (an
 * `<url>` form included). A posted link's URL stays in the text, every URL
 * left there cut to `maxUrlChars` (capUrls).
 */
function normalizeMedia(idPrefix, source, isVoice, cleanText, embedTextChars, videoSites, maxUrlChars, imageSize) {
  const real = normalizeAttachments(source.attachments, isVoice);
  const size = typeof imageSize === 'number' ? imageSize : undefined;
  const { embedLinks, links } = normalizeLinks(idPrefix, source.embeds, embedTextChars, cleanText, videoSites);
  const cdn = cdnVideoAttachments(source.embeds, cleanText, real);
  const stripped = cdn.urls.flatMap((url) => [{ url: `<${url}>` }, { url }]);
  return {
    attachments: [...previewAttachments(real, size), ...cdn.videos],
    // The embed links carry their expiry and preview; the typed video-site ones after them are the core's own reading.
    links: [...previewLinks(embedLinks, size), ...links.slice(embedLinks.length)].filter(
      (link) => !cdn.embedUrls.has(link.url)
    ),
    content: capUrls(stripEmbedUrls(cleanText, [...stripped, ...embedLinks.filter(hidesUrl)]), maxUrlChars),
  };
}

/** Remove the raw URL of every given embed from the message text, so it never appears twice. */
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
 * attachment and its URLs read as in the message itself (see normalizeMedia).
 */
function normalizeSnapshot(snapshot, embedTextChars, videoSites, maxUrlChars, imageSize) {
  const isVoice = isVoiceMessageFlag(snapshot);
  const cleanContent = snapshot.cleanContent ?? snapshot.content ?? '';
  const emojis = extractEmojis(snapshot.content ?? cleanContent);
  const cleanText = cleanEmoji(cleanContent).trim();
  const { attachments, links, content } = normalizeMedia(
    snapshot.id ?? 'fwd',
    snapshot,
    isVoice,
    cleanText,
    embedTextChars,
    videoSites,
    maxUrlChars,
    imageSize
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
 * `editedAt` is the edit stamp (epoch ms) or null. `reactions` lists the message's reactions (see normalizeReactions), `[]`
 * when it has none. `mentionedChannelIds` lists the channel ids of the raw
 * channel mentions `<#id>` in the message's own text (see
 * extractChannelIds; `[]` when there are none; forwarded snapshots are not
 * scanned), while `content` keeps reading `#name`. A posted link's URL stays
 * in `content` where it was written; a GIF's or a Discord CDN file's does not
 * (see normalizeMedia). `options.maxUrlChars` cuts every URL left in the text
 * (default `config.context.maxUrlChars`, see config.json; `0` keeps them whole);
 * the link items keep the whole URL.
 * @param {object} message  A discord.js Message.
 * @param {string} selfId
 * @param {{ embedTextChars?: number, videoSites?: string[], maxUrlChars?: number, imageSize?: number }} [options]
 *   `imageSize`: `media.imageSize`, the longest side of a preview address (see media.js#previewUrlOf).
 */
export function normalizeMessage(message, selfId, options = {}) {
  const embedTextChars = options.embedTextChars ?? 200;
  const videoSites = options.videoSites ?? [];
  const maxUrlChars = options.maxUrlChars ?? DEFAULT_MAX_URL_CHARS;
  const imageSize = options.imageSize;
  const isVoice = isVoiceMessageFlag(message);
  const cleanContent = message.cleanContent ?? '';
  const emojis = extractEmojis(message.content ?? cleanContent);
  const cleanText = cleanEmoji(cleanContent).trim();
  const { attachments, links, content } = normalizeMedia(
    message.id,
    message,
    isVoice,
    cleanText,
    embedTextChars,
    videoSites,
    maxUrlChars,
    imageSize
  );
  const forwarded = [...(message.messageSnapshots?.values?.() ?? [])].map((snapshot) =>
    normalizeSnapshot(snapshot, embedTextChars, videoSites, maxUrlChars, imageSize)
  );

  // A forward's `message.reference.messageId` is the ORIGINAL message, not
  // something this message replies to -- treating it as `replyToId` would
  // wrongly render a "replying to" marker. A reference with no `type` at all
  // (an older/plain payload) is a normal reply, never a forward.
  const isForward = message.reference?.type === MessageReferenceType.Forward;
  const sourceChannelId = isForward ? message.reference?.channelId : null;
  const sourceChannel = sourceChannelId ? message.guild?.channels?.cache?.get(sourceChannelId) : null;
  const mentionedUserIds = [...(message.mentions?.users?.keys?.() ?? [])];
  // The name `content` reads for each (`@DisplayName`, cleanContent), so the transcript can show their handle instead.
  const mentionedUsers = mentionedUserIds
    .map((id) => ({
      id,
      name: displayNameOf(
        message.mentions?.members?.get?.(id) ?? message.guild?.members?.cache?.get?.(id),
        message.mentions?.users?.get?.(id)
      ),
    }))
    .filter((user) => typeof user.name === 'string' && user.name);

  return {
    id: message.id,
    channelId: message.channelId,
    channelName: message.channel?.name ?? null,
    channelCategory: message.channel?.parent?.name ?? null,
    channelTopic: message.channel?.topic ?? null,
    authorId: message.author.id,
    authorName: displayNameOf(message.member, message.author),
    self: message.author.id === selfId,
    bot: message.author.bot && message.author.id !== selfId,
    content,
    ts: message.createdTimestamp,
    // When the message was last edited (Discord `editedTimestamp`), null for one never edited: the
    // transcript marks such a line (labels.transcript.edited).
    editedAt: Number.isFinite(message.editedTimestamp) && message.editedTimestamp > 0 ? message.editedTimestamp : null,
    // Real mentions -- the strongest signal for who this message names, see
    // src/behavior/prompt.js's <people> "asked about" window. `content`
    // above is `cleanContent`-derived and already reads "@DisplayName", so
    // this is the only place a stable member id survives normalization.
    mentionedUserIds,
    mentionedUsers,
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
    // same guild -- see src/format.js's `forwardedFrom` rendering.
    forwardedFrom: sourceChannel?.name ?? null,
    attachments,
    links,
    forwarded,
    stickers: normalizeStickers(message.stickers),
    emojis,
    // Fresh on every history fetch (a REST call); a message straight from
    // messageCreate has none yet. Forwarded snapshots carry none.
    reactions: normalizeReactions(message.reactions),
    // The messages the text links to (a Discord message link), for the core to number or leave as written.
    messageRefs: messageRefsOf(content),
  };
}

// ---------------------------------------------------------------------------
// Inbound protocol events (src/protocol/events.js). Building them is the Discord adapter's
// job; it lives here, beside the normaliser it reads. Every event carries `raw`: the discord.js
// object(s) it came from, private to the Discord side -- the message pipeline
// (src/behavior/pipeline.js) still needs them for history fetches and sends, no other behavior
// reads them, and they go in stage 4.

/** An id as the protocol carries it: a string, or null when there is none. */
const idString = (value) => (value === undefined || value === null ? null : String(value));

/**
 * The normalizeMessage options from the live config (`media.embedTextChars`,
 * `media.video.sites`, `context.maxUrlChars`, `media.imageSize`): the one copy every caller reads.
 * @param {{ media?: { embedTextChars?: number, imageSize?: number, video?: { sites?: string[] } },
 *   context?: { maxUrlChars?: number } }|null|undefined} config
 * @returns {{ embedTextChars?: number, videoSites?: string[], maxUrlChars?: number, imageSize?: number }}
 */
export function normalizeOptions(config) {
  return {
    embedTextChars: config?.media?.embedTextChars,
    videoSites: config?.media?.video?.sites,
    maxUrlChars: config?.context?.maxUrlChars,
    imageSize: config?.media?.imageSize,
  };
}

/**
 * The protocol conversation of a discord.js message: its channel id as Discord gives it, `dm`
 * outside a guild, `thread` for a thread, else `channel`; the channel's name, topic and category
 * read exactly as normalizeMessage reads them. `chatType` tells a one-to-one chat (`dm`) from a
 * group chat (`group_dm`, Discord's `GroupDM` channel type), a `thread` and a `channel`; a
 * one-to-one chat names its partner (`partnerId`: the channel's recipient, null when Discord did
 * not say), a thread the channel it sits in (`parentId`).
 */
function conversationOf(message) {
  const channel = message?.channel ?? null;
  const guildId = message?.guild?.id ?? message?.guildId ?? null;
  const kind = guildId === null ? 'dm' : channel?.isThread?.() ? 'thread' : 'channel';
  const chatType = kind === 'dm' ? (channel?.type === ChannelType.GroupDM ? 'group_dm' : 'dm') : kind;
  return {
    id: message?.channelId,
    kind,
    communityId: idString(guildId),
    name: channel?.name ?? null,
    topic: channel?.topic ?? null,
    category: channel?.parent?.name ?? null,
    chatType,
    ...(chatType === 'dm' ? { partnerId: idString(channel?.recipientId ?? channel?.recipient?.id) } : {}),
    ...(chatType === 'thread' ? { parentId: idString(channel?.parentId) } : {}),
  };
}

/**
 * The protocol conversation of a discord.js channel: the record `conversationOf` builds for a message in it.
 * @param {object} channel  A discord.js channel.
 */
export function conversationOfChannel(channel) {
  return conversationOf({ channel, channelId: channel?.id, guild: channel?.guild ?? null, guildId: channel?.guildId });
}

/**
 * Whether the message `replyToId` names is one of the persona's own, as far as the channel's
 * cache knows (the first step of fetchMessage, without its fetch): a missing or partial cached
 * message is no answer here, and the message pipeline still asks fetchMessage then.
 */
function cachedReplyToSelf(message, replyToId, selfId) {
  if (!replyToId) return false;
  try {
    const cached = message.channel?.messages?.cache?.get?.(replyToId);
    return Boolean(cached && !cached.partial && cached.author?.id === selfId);
  } catch {
    return false;
  }
}

/**
 * The deletion event of a message: what the platform still knows of it, when it was written (its id says) and who
 * wrote it.
 */
function deletionEvent(message, selfId, conversation, at) {
  const written = Number.isFinite(message?.createdTimestamp) ? message.createdTimestamp : undefined;
  const author = message?.author?.id
    ? {
        id: String(message.author.id),
        name: displayNameOf(message.member, message.author),
        self: message.author.id === selfId,
        bot: Boolean(message.author.bot) && message.author.id !== selfId,
      }
    : undefined;
  return {
    kind: MESSAGE_RECEIVED,
    iface: DISCORD_IFACE,
    at,
    id: `${DISCORD_IFACE}:delete:${message?.id}`,
    conversation,
    message: { id: message?.id, ...(written === undefined ? {} : { at: written }), ...(author ? { author } : {}) },
    deleted: true,
    raw: message,
  };
}

/**
 * The `message.received` event of a discord.js message, built from normalizeMessage's result
 * field for field: the channel becomes the event's `conversation`, the author `message.author`,
 * `ts` `message.at`, the mentions `addressing` (`mentioned`: the persona is among the mentioned
 * users, as Discord reports them; `replyToSelf`: see cachedReplyToSelf). `options` are
 * normalizeMessage's plus `edit: true` (a `messageUpdate`; `previous` is the old message, kept
 * as `rawPrevious`), `deleted: true` (a `messageDelete`: only the message id) and `now` (the
 * clock of an edit or a deletion). An edit of a partial message (no author or content yet)
 * carries only the id with `partial: true`. Throws only what normalizeMessage throws.
 * @param {object} message  A discord.js Message (or PartialMessage for an edit or a deletion).
 * @param {string} selfId
 * @param {{ embedTextChars?: number, videoSites?: string[], maxUrlChars?: number, edit?: boolean,
 *   deleted?: boolean, previous?: object|null, now?: () => number }} [options]
 * @returns {import('../../src/protocol/index.js').MessageReceived & { raw: object, rawPrevious?: object|null }}
 */
export function toEvent(message, selfId, options = {}) {
  const now = options.now ?? Date.now;
  const conversation = conversationOf(message);
  const base = { kind: MESSAGE_RECEIVED, iface: DISCORD_IFACE };
  if (options.deleted === true) return deletionEvent(message, selfId, conversation, now());
  const edit = options.edit === true;
  const receivedAt = now();
  const editAt = edit ? (Number.isFinite(message?.editedTimestamp) ? message.editedTimestamp : receivedAt) : null;
  // An edit's id carries when it arrived as well: Discord sends a second update with the same edit
  // stamp when it attaches an embed to an edited message, and the event door must not drop it.
  const editId = (id) => `${DISCORD_IFACE}:edit:${id}:${editAt}:${receivedAt}`;
  const editPart = edit ? { edit: true } : {};
  const editRaw = edit ? { rawPrevious: options.previous ?? null } : {};
  // The message as it was before an edit, whole, or null when the platform did not hold it (or only in part).
  const previousOf = () => {
    const old = options.previous;
    if (!edit || !old || old.partial) return null;
    return toEvent(old, selfId, { ...options, edit: false, previous: null }).message;
  };
  if (edit && message?.partial) {
    return {
      ...base,
      at: editAt,
      id: editId(message.id),
      conversation,
      message: { id: message.id },
      ...editPart,
      partial: true,
      previous: previousOf(),
      raw: message,
      ...editRaw,
    };
  }
  const normalized = normalizeMessage(message, selfId, options);
  const view = memberView(message.member);
  return {
    ...base,
    at: edit ? editAt : normalized.ts,
    id: edit ? editId(normalized.id) : `${DISCORD_IFACE}:message:${normalized.id}`,
    conversation,
    message: {
      id: normalized.id,
      author: {
        id: normalized.authorId,
        name: normalized.authorName,
        self: normalized.self,
        bot: normalized.bot,
        ...(view ? { avatar: { hash: view.hash, url: view.url } } : {}),
      },
      content: normalized.content,
      // The text as written, mentions as `<@id>`: what an edit and the journal's reconciliation compare.
      sourceText: typeof message.content === 'string' ? message.content : '',
      // The platform's own message (a member joined, a pin) or a webhook's: never a person's.
      system: Boolean(message.system || message.webhookId),
      at: normalized.ts,
      editedAt: normalized.editedAt,
      replyToId: normalized.replyToId,
      replyPingUserId: normalized.replyPingUserId,
      forwardedFrom: normalized.forwardedFrom,
      attachments: normalized.attachments,
      links: normalized.links,
      forwarded: normalized.forwarded,
      stickers: normalized.stickers,
      emojis: normalized.emojis,
      reactions: normalized.reactions,
      messageRefs: normalized.messageRefs,
    },
    addressing: {
      mentioned: message.mentions?.users?.has?.(selfId) === true,
      replyToSelf: cachedReplyToSelf(message, normalized.replyToId, selfId),
      mentionedUserIds: normalized.mentionedUserIds,
      mentionedUsers: normalized.mentionedUsers,
      mentionedConversationIds: normalized.mentionedChannelIds,
    },
    ...editPart,
    ...(edit ? { previous: previousOf() } : {}),
    raw: message,
    ...editRaw,
  };
}

/**
 * The `reaction.changed` event of a gateway reaction (`MessageReactionAdd` with `added` true,
 * `MessageReactionRemove` with false): the message's conversation and id, the emoji (`name`: a
 * unicode emoji itself or a custom emoji's name; `id`: a custom emoji's), who reacted, and `raw`
 * `{ reaction, user }`, and `authorId`, the message's author when the message is whole (a partial
 * one gives null). Never throws: an emoji that cannot be read
 * (emojiOf) leaves `name` null, which validateEvent refuses.
 * @param {object} reaction  A discord.js MessageReaction (possibly partial).
 * @param {object} user  A discord.js User (possibly partial).
 * @param {boolean} added
 * @param {{ now?: () => number }} [options]
 * @returns {import('../../src/protocol/index.js').ReactionChanged & { raw: { reaction: object, user: object } }}
 */
export function reactionEvent(reaction, user, added, { now = Date.now } = {}) {
  const message = reaction?.message ?? null;
  const emoji = emojiOf(reaction);
  const emojiId = idString(emoji?.id);
  const name = typeof emoji?.name === 'string' ? emoji.name : null;
  const at = now();
  const messageId = idString(message?.id);
  const userId = idString(user?.id);
  return {
    kind: REACTION_CHANGED,
    iface: DISCORD_IFACE,
    at,
    id: `${DISCORD_IFACE}:reaction:${messageId}:${userId}:${emojiId ?? name}:${added ? 'add' : 'remove'}:${at}`,
    conversation: conversationOf(message),
    messageId,
    authorId: authorIdOf(message),
    emoji: { name, ...(emojiId ? { id: emojiId } : {}) },
    userId,
    added: added === true,
    raw: { reaction, user },
  };
}

/** The author of a whole (not partial) message, or null: a partial one does not know it. */
function authorIdOf(message) {
  return message && !message.partial ? idString(message.author?.id) : null;
}

/**
 * The `reaction.changed` event of `MessageReactionRemoveAll`: every reaction of `message` taken
 * off (`cleared: 'all'`, no emoji, no user). The id carries the arrival time, so a second clear
 * of the same message is never dropped as a duplicate. Never throws.
 * @param {object} message  A discord.js Message (possibly partial).
 * @param {{ now?: () => number }} [options]
 * @returns {import('../../src/protocol/index.js').ReactionChanged}
 */
export function reactionClearAllEvent(message, { now = Date.now } = {}) {
  const at = now();
  const messageId = idString(message?.id);
  return {
    kind: REACTION_CHANGED,
    iface: DISCORD_IFACE,
    at,
    id: `${DISCORD_IFACE}:reaction:${messageId}:clear:all:${at}`,
    conversation: conversationOf(message),
    messageId,
    authorId: authorIdOf(message),
    emoji: null,
    userId: null,
    added: false,
    cleared: 'all',
  };
}

/**
 * The `reaction.changed` event of `MessageReactionRemoveEmoji`: every reaction of one emoji taken
 * off its message (`cleared: 'emoji'`, no user). The id carries the arrival time. Never throws: an
 * emoji that cannot be read leaves `name` null, which validateEvent refuses.
 * @param {object} reaction  A discord.js MessageReaction (possibly partial).
 * @param {{ now?: () => number }} [options]
 * @returns {import('../../src/protocol/index.js').ReactionChanged}
 */
export function reactionClearEmojiEvent(reaction, { now = Date.now } = {}) {
  const message = reaction?.message ?? null;
  const emoji = emojiOf(reaction);
  const emojiId = idString(emoji?.id);
  const name = typeof emoji?.name === 'string' ? emoji.name : null;
  const at = now();
  const messageId = idString(message?.id);
  return {
    kind: REACTION_CHANGED,
    iface: DISCORD_IFACE,
    at,
    id: `${DISCORD_IFACE}:reaction:${messageId}:clear:${emojiId ?? name}:${at}`,
    conversation: conversationOf(message),
    messageId,
    authorId: authorIdOf(message),
    emoji: { name, ...(emojiId ? { id: emojiId } : {}) },
    userId: null,
    added: false,
    cleared: 'emoji',
  };
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
 * Last `limit` messages of a channel (at most one page), oldest first, normalized. `embedTextChars` caps link/gif embed
 * title+description (config.media.embedTextChars); `videoSites` lists the video-site hosts whose typed URLs become link
 * items (config.media.video.sites); `maxUrlChars` cuts the URLs left in the text (config.context.maxUrlChars).
 * @param {import('discord.js').TextBasedChannel} channel
 * @param {{ limit: number, selfId: string, embedTextChars?: number, videoSites?: string[], maxUrlChars?: number }} options
 * @returns {Promise<object[]>}
 */
export async function fetchHistory(channel, { limit, selfId, embedTextChars, videoSites, maxUrlChars }) {
  const fetched = await channel.messages.fetch({ limit: Math.min(PAGE, limit) });
  const raw = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return raw.map((message) => normalizeMessage(message, selfId, { embedTextChars, videoSites, maxUrlChars }));
}

/**
 * The ids of the members who put `emoji` (a reactionKey) on discord.js message `message`: one
 * REST page of at most `fetchUsers` (1..100). Throws when the message or the reaction is gone.
 */
export async function fetchReactorIds(message, emoji, fetchUsers) {
  const reaction = [...(message?.reactions?.cache?.values?.() ?? [])].find(
    (item) => reactionKey(emojiOf(item)) === emoji
  );
  if (!reaction) throw new Error('reaction not found');
  const cap = Math.min(PAGE, Math.max(1, Math.floor(Number(fetchUsers) || 10)));
  const users = await reaction.users.fetch({ limit: cap });
  return [...users.keys()];
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
 *   videoSites?: string[], maxUrlChars?: number }} options
 * @returns {Promise<object[]>}
 */
export async function fetchHistoryWindow(
  channel,
  { anchorId, limit, minTs = 0, selfId, embedTextChars, videoSites, maxUrlChars }
) {
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
      collected.push(normalizeMessage(message, selfId, { embedTextChars, videoSites, maxUrlChars }));
      if (collected.length >= limit) break;
    }

    before = batch[batch.length - 1].id;
    if (hitFloor || batch.length < PAGE || collected.length >= limit) break;
  }

  return collected.reverse();
}

/**
 * One message of `channel` by id: discord.js's message cache first (a whole
 * message, never a partial one), else one fetch; null when it cannot be
 * fetched (deleted, no access, any error) and, without a request, for a
 * missing or empty id.
 * @param {import('discord.js').TextBasedChannel} channel
 * @param {string|null|undefined} id
 * @returns {Promise<import('discord.js').Message|null>}
 */
export async function fetchMessage(channel, id) {
  if (!id) return null;
  try {
    // A partial one (a reaction event on an uncached message caches it so: no author, no
    // content) is fetched whole like a missing one.
    const cached = channel.messages.cache?.get?.(id);
    if (cached && !cached.partial) return cached;
    return (await channel.messages.fetch(id)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether `channel` is one the persona may read: a text channel, not a
 * thread, not the dry-run mirror (`bot.dryRunChannelId`, the owner's
 * rehearsal room, never real conversation), and the bot can read its history
 * (canRead). Discord's permissions are the only limit on which channels.
 * @param {object} channel  A discord.js guild channel.
 * @param {object} botConfig  The live `config.bot`.
 * @returns {boolean}
 */
export function isReadableChannel(channel, botConfig) {
  const mirrorId = botConfig?.dryRunChannelId;
  return !(mirrorId && channel.id === mirrorId) && channel.isTextBased() && !channel.isThread() && canRead(channel);
}

/**
 * Whether the persona may speak in `channel`: one it may read
 * (isReadableChannel: a text channel, not a thread, not the dry-run mirror,
 * its history readable) where the bot can send
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
    (channel) => channel.id !== exceptId && isReadableChannel(channel, botConfig)
  );
}

/**
 * The channel directory's input (src/behavior/prompt.js#buildRequest `channelDirectory`): every
 * channel of `guild` the persona may read (isReadableChannel), never a thread, as `{ id, name, category }`, the
 * category its parent's name or null. [] without a guild (a private chat).
 * @param {object|null|undefined} guild  A discord.js Guild.
 * @param {object} botConfig  The live `config.bot`.
 * @returns {{ id: string, name: string, category: string|null }[]}
 */
export function channelDirectoryOf(guild, botConfig) {
  const cache = guild?.channels?.cache;
  if (!cache || typeof cache.values !== 'function' || !guild.members) return [];
  // A channel object without the discord.js checks (a partial one) is never listed.
  const usable = (channel) =>
    typeof channel?.isTextBased === 'function' &&
    typeof channel.isThread === 'function' &&
    typeof channel.permissionsFor === 'function';
  // Never a thread: discord.js caches threads as they turn active or archived, and each one listed
  // would rewrite the cached stable part (a thread still resolves and renders by its `#name`).
  return [...cache.values()]
    .filter((channel) => usable(channel) && !channel.isThread() && isReadableChannel(channel, botConfig))
    .map((channel) => ({
      id: String(channel.id),
      name: channel.name,
      category: typeof channel.parent?.name === 'string' ? channel.parent.name : null,
    }));
}

/** When the message (or any object) with snowflake `id` was created, in ms since the epoch: no API call. */
export function snowflakeTime(id) {
  return SnowflakeUtil.timestampFrom(id);
}

/** Timestamp of the newest message in a channel, from its snowflake — no API call. */
export function lastActivity(channel) {
  return channel.lastMessageId ? snowflakeTime(channel.lastMessageId) : 0;
}

/**
 * Who can view `channel`, read from Discord's permissions in the Audience
 * shape `audienceCovers` (src/behavior/elsewhere.ts) compares:
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
 * `memberRoles` maps each member named by an overwrite to the ids of the
 * roles he holds, read from `guild.members.cache` (a member missing from the
 * cache has no entry, and the rail then proves nothing through roles). Roles held only by
 * bots stay in the audience: `Role#members` filters the member cache, which
 * without the member intent misses members, so "every holder is a bot"
 * cannot be told. Null for a channel
 * without a guild (a private chat) and for a thread (overwrites do not
 * describe its audience: a private thread admits by membership); a null
 * audience never covers.
 * @param {object} channel  A discord.js channel.
 * @returns {{ everyone: boolean, roles: Set<string>, roleAllow: Set<string>, roleDeny: Set<string>,
 *   memberAllow: Set<string>, memberDeny: Set<string>, memberRoles: Map<string, Set<string>> }|null}
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
  const memberRoles = new Map();
  for (const id of [...sets[OverwriteType.Member].allow, ...sets[OverwriteType.Member].deny]) {
    const held = guild.members?.cache?.get?.(id)?.roles?.cache;
    if (!held?.keys) continue;
    memberRoles.set(id, new Set(held.keys()));
  }
  return {
    everyone: everyoneRole !== null && canView(everyoneRole),
    roles,
    roleAllow: sets[OverwriteType.Role].allow,
    roleDeny: sets[OverwriteType.Role].deny,
    memberAllow: sets[OverwriteType.Member].allow,
    memberDeny: sets[OverwriteType.Member].deny,
    memberRoles,
  };
}
