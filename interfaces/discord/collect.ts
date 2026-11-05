// Everything that reads from Discord: turning discord.js messages into plain
// normalized objects and fetching the context of a turn — the last N messages
// of the current channel plus a few fresh messages from neighbouring channels —
// and what the bot may do in a channel (read, send, attach, react) and who else
// can view it (the audience the pulled-channel rail compares). Also the inbound
// protocol events built from discord.js messages and reactions (toEvent,
// reactionEvent), until the Discord adapter becomes its own package.

import { ChannelType, PermissionFlagsBits, SnowflakeUtil, MessageReferenceType, OverwriteType } from 'discord.js';
import { log } from '../../src/log.ts';
import { ID_DIGITS, URL_PATTERN } from '../../src/memory/mentions.ts';
import {
  classifyAttachment,
  linkThumbnailCacheKey,
  siteOf,
  positiveDimension,
  clipWithEllipsis,
} from '../../src/media/classify.ts';
import { classifyEmbed } from './embed.ts';
import { DISCORD_CDN_SITES, discordCdnVideo, previewAttachments, previewLinks, stickerUrl } from './media.ts';
import { extractVideoUrls, videoSiteFor, videoUrlCacheKey } from '../../src/media/video-sites.ts';
import { CUSTOM_EMOJI_MARKUP } from '../../src/behavior/emoji.ts';
import { reactionKey } from '../../src/protocol/reaction-key.ts';
import { MESSAGE_RECEIVED, REACTION_CHANGED } from '../../src/protocol/index.ts';
import { memberView } from './members.ts';
import { DISCORD_IFACE } from './port.ts';

import type { Conversation, MessageReceived, ReactionChanged } from '../../src/protocol/index.ts';
import type { Message, TextBasedChannel } from 'discord.js';
import type {
  AttachmentLike,
  ChannelLike,
  Collection,
  GuildLike,
  MessageLike,
  ReactionLike,
  SnapshotLike,
  StickerLike,
} from './platform-types.ts';
import type { EmbedInput } from './embed.ts';
import { scalarText } from './values.ts';
/** A discord.js reaction, a message, a channel or a guild as the functions below read them: the types name the fields used. */
/** A reaction whose reactors can be fetched, one REST page. */
type ReactorReaction = ReactionLike & {
  users: { fetch: (options: { limit: number }) => Promise<{ keys: () => Iterable<string> }> };
};

const asReaction = (value: object | null | undefined): ReactionLike | null | undefined => value;
const asMessage = (value: object): MessageLike => value as MessageLike;
export const asChannel = (value: object): ChannelLike => value;
const channelOrNull = (value: object | null): ChannelLike | null => (value ? asChannel(value) : null);
export const asGuild = (value: object): GuildLike => value;

/** The longer side of a picture's preview, in pixels. Production value, config cut of 2026-10-31. */
const IMAGE_SIZE = 512;

/** Discord's REST page size for a message list. */
export const PAGE = 100;

// Verified against the live CDN: this exact host+path+size serves both a static and an animated custom emoji as image/webp.
const EMOJI_SIZE = 96;

/**
 * A custom emoji's picture address from just its id. The same address serves a static and an animated emoji alike
 * (image/webp either way).
 */
export function emojiUrl(id: string): string {
  return `https://cdn.discordapp.com/emojis/${id}.webp?size=${EMOJI_SIZE}`;
}
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
 */
export function messageRefsOf(
  text: unknown
): Array<{ iface: string; conversationId: string; messageId: string; url: string; text: string }> {
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
function cleanEmoji(text: string): string {
  return text.replace(CUSTOM_EMOJI_RE, ':$2:');
}

/**
 * Custom emoji `<:name:id>` / `<a:name:id>` written in a message's text (the
 * text itself keeps reading as `:name:`, see cleanEmoji above): de-duplicated
 * by id, in first-appearance order, capped at MAX_EMOJIS_PER_MESSAGE.
 * @param text The RAW `content` (discord.js's cleanContent has already
 *   rewritten the markup to `:name:`, dropping the id); cleanContent only as a
 *   fallback when the raw content is missing.
 */
function extractEmojis(text: unknown): Array<{ id: string; name: string; animated: boolean; url: string }> {
  const seen = new Map<string, { id: string; name: string; animated: boolean; url: string }>();
  CUSTOM_EMOJI_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CUSTOM_EMOJI_RE.exec(scalarText(text ?? '')))) {
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
 * @param text The RAW `content`: discord.js's cleanContent has
 *   already rewritten every `<#id>` to `#name`, dropping the id.
 */
function extractChannelIds(text: unknown): Array<string> {
  const seen = new Set<string>();
  CHANNEL_MENTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CHANNEL_MENTION_RE.exec(scalarText(text ?? '')))) {
    seen.add(match[1]);
    if (seen.size >= MAX_CHANNEL_MENTIONS) break;
  }
  return [...seen];
}

/** Classified stickers of a message/snapshot: `{ id, name, format, url }` (see stickerUrl). */
function normalizeStickers(stickers: Collection<StickerLike> | undefined) {
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
 */
export function emojiOf(reaction: object | null | undefined): { id?: string | null; name?: string | null } | null {
  try {
    return asReaction(reaction)?.emoji ?? null;
  } catch {
    return null;
  }
}

/**
 * The reactions on a message: a custom emoji reads as `:name:`, a unicode one
 * as itself; `mine` is the bot's own. Sorted by count descending, ties keep
 * the collection's order; a count that is not a positive integer is skipped.
 */
function normalizeReactions(
  reactions: { cache?: Collection<ReactionLike> } | undefined
): Array<{ emoji: string; count: number; mine: boolean }> {
  // A reaction whose emoji cannot be read (emojiOf: a REST-only client) is skipped, never fatal.
  return [...(reactions?.cache?.values?.() ?? [])]
    .map((reaction) => ({ reaction, emoji: reactionKey(emojiOf(reaction)) }))
    .flatMap(({ reaction, emoji }) =>
      typeof reaction.count === 'number' && Number.isInteger(reaction.count) && reaction.count > 0 && emoji
        ? [{ emoji, count: reaction.count, mine: Boolean(reaction.me) }]
        : []
    )
    .sort((a, b) => b.count - a.count);
}

/**
 * The name the transcript gives a member: their server display name, else their global name,
 * else their username; null when neither is known. Authors (normalizeMessage) and reactors
 * (fetchHistory's `reactors`) are named by it alike.
 */
export function displayNameOf(
  member: { displayName?: string | null } | null | undefined,
  user: { globalName?: string | null; username?: string | null } | null | undefined
): string | null {
  return member?.displayName ?? user?.globalName ?? user?.username ?? null;
}

/** Whether the message carries Discord's voice-message flag (the whole message is flagged, not the attachment). */
function isVoiceMessageFlag(message: SnapshotLike): boolean {
  try {
    return Boolean(message.flags?.has?.('IsVoiceMessage'));
  } catch {
    return false;
  }
}

/** Classified attachments of a message/snapshot, in Discord's own order. */
function normalizeAttachments(attachments: Collection<AttachmentLike> | undefined, isVoice: boolean) {
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
 * store the URL to look it up again later (see src/memory/update.ts
 * `observe()`/`analyze()`). A `kind: 'gif'` embed (a `gifv` embed or a GIF
 * site, see classifyEmbed; `videoSites` keeps a video site's `gifv` a link)
 * keeps the existing per-message-index id, unchanged. A `kind: 'link'` embed whose URL
 * is on one of `videoSites` takes `videoUrlCacheKey(url)` instead -- the same
 * id a typed link of that video gets (see normalizeLinks), so one video has
 * one id (and one video/still-frame cache entry) whether Discord embedded it
 * or not.
 */
/** One link item of a message: an embed's, or a video-site URL typed in the text. */
type EmbedLink =
  ReturnType<typeof classifyEmbed> extends infer Item
    ? Omit<Item & { id: string }, 'thumbnailWidth' | 'thumbnailHeight' | 'kind'> & {
        kind: 'gif' | 'link';
        thumbnailWidth?: number | null;
        thumbnailHeight?: number | null;
      }
    : never;

function normalizeEmbedLinks(
  idPrefix: string,
  embeds: ReadonlyArray<EmbedInput> | undefined,
  embedTextChars: number,
  videoSites: ReadonlyArray<string>
) {
  const watchSites = Array.isArray(videoSites) && videoSites.length > 0;
  return [...(embeds ?? [])]
    .filter((embed) => embed?.url)
    .map((embed, index) => {
      const classified = classifyEmbed(embed, { embedTextChars, videoSites });
      let id: string;
      const url = classified.url;
      if (classified.kind === 'link' && watchSites && url !== null && videoSiteFor(url, videoSites) !== null) {
        id = videoUrlCacheKey(url);
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
 * src/media/video-sites.ts) that no embed already carries -- compared by the
 * exact URL and by its canonical `videoUrlCacheKey`, so a video Discord did
 * embed is never listed twice. A synthetic link's id IS that cache key.
 * `embedLinks` is returned apart for normalizeMedia, which decides which of
 * those URLs leave the message text.
 */
function normalizeLinks(
  idPrefix: string,
  embeds: ReadonlyArray<EmbedInput> | undefined,
  embedTextChars: number,
  cleanText: string,
  videoSites: ReadonlyArray<string>
) {
  const embedLinks = normalizeEmbedLinks(idPrefix, embeds, embedTextChars, videoSites);
  const links: Array<EmbedLink> = [...embedLinks];
  if (Array.isArray(videoSites) && videoSites.length > 0) {
    const seenUrls = new Set<string | null>(embedLinks.map((link) => link.url));
    const seenKeys = new Set(embedLinks.map((link) => videoUrlCacheKey(link.url ?? '')));
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
 */
function cdnVideoAttachments(
  embeds: ReadonlyArray<EmbedInput> | undefined,
  cleanText: string,
  attachments: ReadonlyArray<{ id: string }>
): { videos: Array<object>; embedUrls: Set<string>; urls: Array<string> } {
  const known = new Set(attachments.map((attachment) => attachment.id));
  const byId = new Map<string, object>();
  const embedUrls = new Set<string>();
  const urls: Array<string> = [];
  const take = (url: string): boolean => {
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
function hidesUrl(link: { kind: string; url: string | null }): boolean {
  return link.kind === 'gif' || videoSiteFor(link.url ?? '', DISCORD_CDN_SITES) !== null;
}

/**
 * Every URL in `text` cut to `maxUrlChars` code points with an ellipsis
 * (clipWithEllipsis); query and tracking parameters stay as posted up to the
 * cut. `0` (or anything not a positive number) keeps every URL whole.
 */
function capUrls(text: string, maxUrlChars: unknown): string {
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
function normalizeMedia(
  idPrefix: string,
  source: SnapshotLike,
  isVoice: boolean,
  cleanText: string,
  embedTextChars: number,
  videoSites: ReadonlyArray<string>,
  maxUrlChars: unknown,
  imageSize: unknown
) {
  const real = normalizeAttachments(source.attachments, isVoice);
  const size = typeof imageSize === 'number' ? imageSize : undefined;
  const { embedLinks, links } = normalizeLinks(idPrefix, source.embeds, embedTextChars, cleanText, videoSites);
  const cdn = cdnVideoAttachments(source.embeds, cleanText, real);
  const stripped = cdn.urls.flatMap((url) => [{ url: `<${url}>` }, { url }]);
  return {
    attachments: [...previewAttachments(real, size), ...cdn.videos],
    // The embed links carry their expiry and preview; the typed video-site ones after them are the core's own reading.
    links: [...previewLinks(embedLinks, size), ...links.slice(embedLinks.length)].filter(
      (link) => !(typeof link.url === 'string' && cdn.embedUrls.has(link.url))
    ),
    content: capUrls(stripEmbedUrls(cleanText, [...stripped, ...embedLinks.filter(hidesUrl)]), maxUrlChars),
  };
}

/** Remove the raw URL of every given embed from the message text, so it never appears twice. */
function stripEmbedUrls(content: string, links: ReadonlyArray<{ url?: string | null }>): string {
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
function normalizeSnapshot(
  snapshot: SnapshotLike,
  embedTextChars: number,
  videoSites: ReadonlyArray<string>,
  maxUrlChars: unknown,
  imageSize: unknown
) {
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
function replyPingUserId(message: MessageLike, mentionedUserIds: ReadonlyArray<string>): string | null {
  const repliedId = message.mentions?.repliedUser?.id;
  if (!repliedId || !message.reference?.messageId) return null;
  if (!mentionedUserIds.includes(repliedId)) return null;
  const typed = new RegExp(`<@!?${repliedId}>`).test(message.content ?? '');
  return typed ? null : repliedId;
}

/** A message as the rest of the code works with it (see normalizeMessage). */
export type NormalizedMessage = {
  id: string;
  channelId: string | undefined;
  channelName: string | null;
  channelCategory: string | null;
  channelTopic: string | null;
  authorId: string;
  authorName: string | null;
  self: boolean;
  bot: boolean;
  content: string;
  ts: number;
  editedAt: number | null;
  mentionedUserIds: Array<string>;
  mentionedUsers: Array<{ id: string; name: string }>;
  mentionedChannelIds: Array<string>;
  replyToId: string | null;
  replyPingUserId: string | null;
  forwardedFrom: string | null;
  attachments: ReturnType<typeof normalizeMedia>['attachments'];
  links: ReturnType<typeof normalizeMedia>['links'];
  forwarded: Array<ReturnType<typeof normalizeSnapshot>>;
  stickers: ReturnType<typeof normalizeStickers>;
  emojis: ReturnType<typeof extractEmojis>;
  reactions: ReturnType<typeof normalizeReactions>;
  messageRefs: ReturnType<typeof messageRefsOf>;
};

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
 * @param message A discord.js Message.
 * @param options `imageSize`: `media.imageSize`, the longest side of a preview address (see media.ts#previewUrlOf).
 */
export function normalizeMessage(
  given: object,
  selfId: string,
  options: { embedTextChars?: number; videoSites?: Array<string>; maxUrlChars?: number; imageSize?: number } = {}
): NormalizedMessage {
  const message = asMessage(given);
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
  const sourceChannel = sourceChannelId ? message.guild?.channels?.cache?.get?.(sourceChannelId) : null;
  const mentionedUserIds = [...(message.mentions?.users?.keys?.() ?? [])];
  // The name `content` reads for each (`@DisplayName`, cleanContent), so the transcript can show their handle instead.
  const mentionedUsers = mentionedUserIds.flatMap((id) => {
    const name = displayNameOf(
      message.mentions?.members?.get?.(id) ?? message.guild?.members?.cache?.get?.(id),
      message.mentions?.users?.get?.(id)
    );
    return typeof name === 'string' && name ? [{ id, name }] : [];
  });

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
    editedAt: editedAtOf(message),
    // Real mentions -- the strongest signal for who this message names, see
    // src/behavior/prompt.ts's <people> "asked about" window. `content`
    // above is `cleanContent`-derived and already reads "@DisplayName", so
    // this is the only place a stable member id survives normalization.
    mentionedUserIds,
    mentionedUsers,
    // Channels written as `<#id>` -- the only place their ids survive, since
    // `content` reads `#name`; an explicit mention pulls that channel into a
    // turn (src/behavior/pull.ts).
    mentionedChannelIds: extractChannelIds(message.content),
    replyToId: isForward ? null : (message.reference?.messageId ?? null),
    // The replied-to author when Discord's reply ping alone put them into
    // `mentionedUserIds` (no `<@id>` typed in the text), else null -- so the
    // address classifier's pre-filter (src/behavior/mention.ts) can tell a
    // reply ping from a real mention of another member.
    replyPingUserId: isForward ? null : replyPingUserId(message, mentionedUserIds),
    // The forwarded snapshot's source channel name, when it resolves in the
    // same guild -- see src/format.ts's `forwardedFrom` rendering.
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
// Inbound protocol events (src/protocol/events.ts). Building them is the Discord adapter's
// job; it lives here, beside the normaliser it reads. Every event carries `raw`: the discord.js
// object(s) it came from, private to the Discord side -- the message pipeline
// (src/behavior/pipeline.ts) still needs them for history fetches and sends, no other behavior
// reads them, and they go in stage 4.

/** An id as the protocol carries it: a string, or null when there is none. */
const idString = (value: unknown): string | null => (value === undefined || value === null ? null : scalarText(value));

/** When the message was last edited (epoch ms), null for one never edited. */
function editedAtOf(message: MessageLike): number | null {
  const edited = message.editedTimestamp;
  return typeof edited === 'number' && Number.isFinite(edited) && edited > 0 ? edited : null;
}

/** An id the event needs: a message or a reaction without one gives none, and validateEvent refuses the event at the door. */
const requiredId = (value: unknown): string => idString(value) as string;

/**
 * The normalizeMessage options from the live config (`media.embedTextChars`,
 * `media.video.sites`, `context.maxUrlChars`) and IMAGE_SIZE: the one copy every caller reads.
 */
export function normalizeOptions(
  config:
    | { media?: { embedTextChars?: number; video?: { sites?: Array<string> } }; context?: { maxUrlChars?: number } }
    | null
    | undefined
): { embedTextChars?: number; videoSites?: Array<string>; maxUrlChars?: number; imageSize?: number } {
  return {
    embedTextChars: config?.media?.embedTextChars,
    videoSites: config?.media?.video?.sites,
    maxUrlChars: config?.context?.maxUrlChars,
    imageSize: IMAGE_SIZE,
  };
}

/**
 * The protocol conversation of a discord.js message: its channel id as Discord gives it, `dm`
 * outside a guild, `thread` for a thread, else `channel`; the channel's name, topic and category
 * read exactly as normalizeMessage reads them. `chatType` tells a one-to-one chat (`dm`) from a
 * group chat (`group_dm`, Discord's `GroupDM` channel type), a `thread` and a `channel`; a
 * one-to-one chat names its partner (`partnerId`: the channel's recipient, null when Discord did
 * not say), a thread the channel it sits in (`parentId`), a channel in a category that category
 * (`parentId`, `parentKind`).
 */
function conversationOf(
  message:
    | { channel?: ChannelLike | null; channelId?: string; guild?: GuildLike | null; guildId?: string | null }
    | null
    | undefined
): Conversation {
  const channel = message?.channel ?? null;
  const guildId = message?.guild?.id ?? message?.guildId ?? null;
  const kind = guildId === null ? 'dm' : channel?.isThread?.() ? 'thread' : 'channel';
  const chatType = kind === 'dm' ? (channel?.type === ChannelType.GroupDM ? 'group_dm' : 'dm') : kind;
  return {
    // A message without a channel id gives none: validateEvent refuses the event at the door.
    id: message?.channelId as string,
    kind,
    communityId: idString(guildId),
    name: channel?.name ?? null,
    topic: channel?.topic ?? null,
    category: channel?.parent?.name ?? null,
    chatType,
    ...(chatType === 'dm' ? { partnerId: idString(channel?.recipientId ?? channel?.recipient?.id) } : {}),
    ...(chatType === 'thread' ? { parentId: idString(channel?.parentId) } : {}),
    ...(chatType === 'channel' && channel?.parentId ? { parentId: channel.parentId, parentKind: 'category' } : {}),
  };
}

/**
 * The protocol conversation of a discord.js channel: the record `conversationOf` builds for a message in it.
 * @param channel A discord.js channel.
 * @param guildId The community when the caller knows it apart from the channel object.
 */
export function conversationOfChannel(given: object, guildId?: string): Conversation {
  const channel = asChannel(given);
  return conversationOf({
    channel,
    channelId: channel?.id,
    guild: channel?.guild ?? null,
    guildId: guildId ?? channel?.guildId,
  });
}

/**
 * Whether the message `replyToId` names is one of the persona's own, as far as the channel's
 * cache knows (the first step of fetchMessage, without its fetch): a missing or partial cached
 * message is no answer here, and the message pipeline still asks fetchMessage then.
 */
function cachedReplyToSelf(message: MessageLike, replyToId: string | null, selfId: string): boolean {
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
function deletionEvent(
  message: MessageLike,
  selfId: string,
  conversation: Conversation,
  at: number
): MessageReceived & { raw: object } {
  const created = message?.createdTimestamp;
  const written = typeof created === 'number' && Number.isFinite(created) ? created : undefined;
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
    // A deletion without a message id has none: validateEvent refuses the event at the door.
    message: {
      id: message?.id,
      ...(written === undefined ? {} : { at: written }),
      ...(author ? { author } : {}),
    },
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
 * @param message A discord.js Message (or PartialMessage for an edit or a deletion).
 */
export function toEvent(
  given: object,
  selfId: string,
  options: {
    embedTextChars?: number;
    videoSites?: Array<string>;
    maxUrlChars?: number;
    edit?: boolean;
    deleted?: boolean;
    previous?: object | null;
    now?: () => number;
  } = {}
): MessageReceived & { raw: object; rawPrevious?: object | null } {
  const message = asMessage(given);
  const now = options.now ?? Date.now;
  const conversation = conversationOf(message);
  const base = { kind: MESSAGE_RECEIVED, iface: DISCORD_IFACE } as const;
  if (options.deleted === true) return deletionEvent(message, selfId, conversation, now());
  const edit = options.edit === true;
  const receivedAt = now();
  const edited = message?.editedTimestamp;
  const editAt = typeof edited === 'number' && Number.isFinite(edited) ? edited : receivedAt;
  // An edit's id carries when it arrived as well: Discord sends a second update with the same edit
  // stamp when it attaches an embed to an edited message, and the event door must not drop it.
  const editId = (id: string): string => `${DISCORD_IFACE}:edit:${id}:${editAt}:${receivedAt}`;
  const editPart = edit ? { edit: true } : {};
  const editRaw = edit ? { rawPrevious: options.previous ?? null } : {};
  // The message as it was before an edit, whole, or null when the platform did not hold it (or only in part).
  const previousOf = () => {
    const old = options.previous;
    if (!edit || !old || asMessage(old).partial) return null;
    const built = toEvent(old, selfId, { ...options, edit: false, previous: null }).message;
    return 'content' in built ? built : null;
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
 * @param reaction A discord.js MessageReaction (possibly partial).
 * @param user A discord.js User (possibly partial).
 */
export function reactionEvent(
  reaction: object,
  user: { id?: string },
  added: boolean,
  { now = Date.now }: { now?: () => number } = {}
): ReactionChanged & { raw: { reaction: object; user: object } } {
  const message = asReaction(reaction)?.message ?? null;
  const emoji = emojiOf(reaction);
  const emojiId = idString(emoji?.id);
  const name = typeof emoji?.name === 'string' ? emoji.name : null;
  const at = now();
  const messageId = requiredId(message?.id);
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
function authorIdOf(message: MessageLike | null | undefined): string | null {
  return message && !message.partial ? idString(message.author?.id) : null;
}

/**
 * The `reaction.changed` event of `MessageReactionRemoveAll`: every reaction of `message` taken
 * off (`cleared: 'all'`, no emoji, no user). The id carries the arrival time, so a second clear
 * of the same message is never dropped as a duplicate. Never throws.
 * @param message A discord.js Message (possibly partial).
 */
export function reactionClearAllEvent(given: object, { now = Date.now }: { now?: () => number } = {}): ReactionChanged {
  const message = asMessage(given);
  const at = now();
  const messageId = requiredId(message?.id);
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
 * @param reaction A discord.js MessageReaction (possibly partial).
 */
export function reactionClearEmojiEvent(
  reaction: object,
  { now = Date.now }: { now?: () => number } = {}
): ReactionChanged {
  const message = asReaction(reaction)?.message ?? null;
  const emoji = emojiOf(reaction);
  const emojiId = idString(emoji?.id);
  const name = typeof emoji?.name === 'string' ? emoji.name : null;
  const at = now();
  const messageId = requiredId(message?.id);
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
function hasPermission(given: object, flag: bigint): boolean {
  const channel = asChannel(given);
  if (!channel.guild) return true;
  const me = channel.guild.members?.me;
  if (!me || !channel.viewable) return false;
  return channel.permissionsFor?.(me)?.has?.(flag) ?? false;
}

/**
 * Whether the bot may read `channel`'s history (see hasPermission: a channel
 * without a guild is always yes).
 */
export function canRead(channel: object): boolean {
  return hasPermission(channel, PermissionFlagsBits.ReadMessageHistory);
}

/**
 * Whether the bot may put a reaction on a message in `channel`: Add Reactions
 * plus Read Message History, which Discord also requires for a reaction (see
 * hasPermission: a channel without a guild is always yes). A channel the bot
 * cannot send in may still allow it.
 */
export function canReact(channel: object): boolean {
  return canRead(channel) && hasPermission(channel, PermissionFlagsBits.AddReactions);
}

/**
 * Whether the bot may send messages in `channel` (see hasPermission: a
 * channel without a guild is always yes).
 */
export function canSend(channel: object): boolean {
  return hasPermission(channel, PermissionFlagsBits.SendMessages);
}

/**
 * Whether the bot may attach files in `channel` (a drawing is posted as one),
 * resolved like canSend (see hasPermission).
 */
export function canAttach(channel: object): boolean {
  return hasPermission(channel, PermissionFlagsBits.AttachFiles);
}

/**
 * Last `limit` messages of a channel (at most one page), oldest first, normalized. `embedTextChars` caps link/gif embed
 * title+description (config.media.embedTextChars); `videoSites` lists the video-site hosts whose typed URLs become link
 * items (config.media.video.sites); `maxUrlChars` cuts the URLs left in the text (config.context.maxUrlChars).
 */
export async function fetchHistory(
  channel: TextBasedChannel,
  {
    limit,
    selfId,
    embedTextChars,
    videoSites,
    maxUrlChars,
  }: { limit: number; selfId: string; embedTextChars?: number; videoSites?: Array<string>; maxUrlChars?: number }
): Promise<Array<object>> {
  const fetched = await channel.messages.fetch({ limit: Math.min(PAGE, limit) });
  const raw = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return raw.map((message) => normalizeMessage(message, selfId, { embedTextChars, videoSites, maxUrlChars }));
}

/**
 * The ids of the members who put `emoji` (a reactionKey) on discord.js message `message`: one
 * REST page of at most `fetchUsers` (1..100). Throws when the message or the reaction is gone.
 */
export async function fetchReactorIds(
  message: object | null | undefined,
  emoji: string,
  fetchUsers: unknown
): Promise<Array<string>> {
  const reactions = (message as { reactions?: { cache?: Collection<ReactorReaction> } } | null | undefined)?.reactions;
  const reaction = [...(reactions?.cache?.values?.() ?? [])].find((item) => reactionKey(emojiOf(item)) === emoji);
  if (!reaction) throw new Error('reaction not found');
  const cap = Math.min(PAGE, Math.max(1, Math.floor(Number(fetchUsers) || 10)));
  const users = await reaction.users.fetch({ limit: cap });
  return [...users.keys()];
}

/** A Discord snowflake string one greater than `id`, so `before: bump(id)` includes `id` itself. */
function bumpSnowflake(id: string): string {
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
 */
export async function fetchHistoryWindow(
  channel: TextBasedChannel,
  {
    anchorId,
    limit,
    minTs = 0,
    selfId,
    embedTextChars,
    videoSites,
    maxUrlChars,
  }: {
    anchorId?: string | null;
    limit: number;
    minTs?: number;
    selfId: string;
    embedTextChars?: number;
    videoSites?: Array<string>;
    maxUrlChars?: number;
  }
): Promise<Array<object>> {
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
 */
export async function fetchMessage(channel: TextBasedChannel, id: string | null | undefined): Promise<Message | null> {
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
 * thread, and the bot can read its history (canRead). Discord's permissions are the only limit on which channels.
 * @param channel A discord.js guild channel.
 */
export function isReadableChannel(given: object): boolean {
  const channel = asChannel(given);
  return channel.isTextBased?.() === true && channel.isThread?.() !== true && canRead(channel);
}

/**
 * Whether the persona may speak in `channel`: one it may read
 * (isReadableChannel: a text channel, not a thread, its history readable) where the bot can send
 * (canSend). The one rule for a channel words go to unasked or on someone's
 * behalf: a routed call's or a noticed comment's destination
 * (src/behavior/turn.ts#usableDestination), a spontaneous turn's channel.
 * @param channel A discord.js guild channel.
 */
export function isWritableChannel(channel: object): boolean {
  return isReadableChannel(channel) && canSend(channel);
}

/** The channels of a guild the persona may read (isReadableChannel), excluding `exceptId`. */
export function readableChannels(
  guild: object,
  botConfig?: unknown,
  exceptId: string | null = null
): Array<ChannelLike> {
  return [...(asGuild(guild).channels?.cache?.values?.() ?? [])].filter(
    (channel) => channel.id !== exceptId && isReadableChannel(channel)
  );
}

/**
 * The channel directory's input (src/behavior/prompt.ts#buildRequest `channelDirectory`): every
 * channel of `guild` the persona may read (isReadableChannel), never a thread, as `{ id, name, category }`, the
 * category its parent's name or null. [] without a guild (a private chat).
 * @param guild A discord.js Guild.
 */
export function channelDirectoryOf(
  given: object | null | undefined
): Array<{ id: string; name: string; category: string | null }> {
  const guild = given ? asGuild(given) : null;
  const cache = guild?.channels?.cache;
  if (!cache || typeof cache.values !== 'function' || !guild?.members) return [];
  // A channel object without the discord.js checks (a partial one) is never listed.
  const usable = (channel: ChannelLike): boolean =>
    typeof channel?.isTextBased === 'function' &&
    typeof channel.isThread === 'function' &&
    typeof channel.permissionsFor === 'function';
  // Never a thread: discord.js caches threads as they turn active or archived, and each one listed
  // would rewrite the cached stable part (a thread still resolves and renders by its `#name`).
  return [...cache.values()]
    .filter((channel) => usable(channel) && channel.isThread?.() !== true && isReadableChannel(channel))
    .map((channel) => ({
      id: String(channel.id),
      name: String(channel.name),
      category: typeof channel.parent?.name === 'string' ? channel.parent.name : null,
    }));
}

/** When the message (or any object) with snowflake `id` was created, in ms since the epoch: no API call. */
export function snowflakeTime(id: string): number {
  return SnowflakeUtil.timestampFrom(id);
}

/** Timestamp of the newest message in a channel, from its snowflake — no API call. */
export function lastActivity(given: object): number {
  const channel = asChannel(given);
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
 * @param channel A discord.js channel.
 */
export function audienceOf(given: object | null): {
  everyone: boolean;
  roles: Set<string>;
  roleAllow: Set<string>;
  roleDeny: Set<string>;
  memberAllow: Set<string>;
  memberDeny: Set<string>;
  memberRoles: Map<string, Set<string>>;
} | null {
  const channel = channelOrNull(given);
  const guild = channel?.guild;
  if (!guild || channel.isThread?.()) return null;
  const view = PermissionFlagsBits.ViewChannel;
  const canView = (role: unknown): boolean => channel.permissionsFor?.(role)?.has?.(view) ?? false;
  const everyoneRole = guild.roles?.everyone ?? null;
  const everyoneId = everyoneRole?.id ?? guild.id; // the @everyone role's id is the guild's
  const botId = guild.members?.me?.id ?? channel.client?.user?.id ?? null;
  const isBotMember = (id: string): boolean =>
    (botId !== null && id === botId) || guild.members?.cache?.get?.(id)?.user?.bot === true;
  const roles = new Set<string>();
  for (const role of guild.roles?.cache?.values?.() ?? []) {
    if (canView(role)) roles.add(role.id);
  }
  const sets: Record<number, { allow: Set<string>; deny: Set<string> }> = {
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
  const memberRoles = new Map<string, Set<string>>();
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
