// What a Discord embed is, as a media item of the message the package hands the core: a GIF (a GIF-picker post, a
// tenor or giphy link, a pasted link to a GIF file on the Discord CDN) or a link with its thumbnail. Called by
// collect.js#normalizeMessage for every embed of a message. Pure: no network, no discord.js import; it reads the plain
// fields of an embed or a discord.js Embed's `data`.

import { clipWithEllipsis, isGifHostUrl, positiveDimension, siteOf } from '../../src/media/classify.js';
import { videoSiteFor } from '../../src/media/video-sites.js';
import { DISCORD_CDN_HOSTS } from './media.js';

/** The fields of an embed this module reads: a plain object, or a discord.js Embed with its raw `data`. */
export type EmbedInput = {
  url?: string | null;
  title?: string | null;
  description?: string | null;
  type?: string | null;
  thumbnail?: {
    url?: string | null;
    proxyURL?: string | null;
    width?: number | null;
    height?: number | null;
    contentType?: string | null;
  } | null;
  video?: { url?: string | null; proxyURL?: string | null } | null;
  provider?: { name?: string | null } | null;
  data?: { type?: string | null; thumbnail?: { content_type?: string | null } | null } | null;
};

/** An embed as a media item: a GIF, or a link with its thumbnail. `animationUrl` only on a GIF that carries one. */
export type EmbedItem = {
  site: string;
  title: string;
  text: string;
  thumbnailUrl: string | null;
  thumbnailWidth: number | null;
  thumbnailHeight: number | null;
  kind: 'gif' | 'link';
  url: string | null;
  animationUrl?: string;
};

const GIF_PROVIDERS = new Set(['tenor', 'giphy']);
// Discord's embed type for a looping GIF video: what every GIF-picker post
// carries, whatever site serves it.
const GIF_EMBED_TYPE = 'gifv';

/** Whether `url` parses and its path ends in `.gif` (case-insensitive). */
function isGifFileUrl(url: string): boolean {
  try {
    return /\.gif$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * The animation of a gif embed, for the GIF watch (src/memory/describe.js):
 * the mp4/webm Discord plays for a `gifv` embed
 * (`video.proxyURL` preferred, like the thumbnail, else `video.url`), else
 * the embed's own URL when it is a `.gif` file, else null.
 */
function gifAnimationUrl(embed: EmbedInput | null | undefined, url: string | null): string | null {
  const video = embed?.video?.proxyURL || embed?.video?.url;
  if (typeof video === 'string' && video) return video;
  return url && isGifFileUrl(url) ? url : null;
}

/**
 * The content type of an embed's thumbnail, lowercased: a plain object's
 * `thumbnail.contentType`, a discord.js Embed's `data.thumbnail.content_type`
 * (its `thumbnail` getter drops the field); '' when neither is there.
 */
function thumbnailContentTypeOf(embed: EmbedInput | null | undefined): string {
  return String(embed?.thumbnail?.contentType ?? embed?.data?.thumbnail?.content_type ?? '').toLowerCase();
}

/**
 * Whether an embed is a link to a GIF file on the Discord CDN
 * (DISCORD_CDN_HOSTS): its URL's path ends in `.gif`, or its thumbnail's
 * content type is `image/gif`. A member pasting such a link gets an image
 * embed, no attachment; it is still a GIF to watch, not a page preview.
 */
function isDiscordGifFile(embed: EmbedInput | null | undefined, url: string | null): boolean {
  if (!url || !DISCORD_CDN_HOSTS.has(siteOf(url).toLowerCase())) return false;
  return isGifFileUrl(url) || thumbnailContentTypeOf(embed) === 'image/gif';
}

/** An embed's Discord type (`gifv`, `rich`, ...), lowercased: a plain object's `type`, a discord.js Embed's `data.type`. */
function embedTypeOf(embed: EmbedInput | null | undefined): string {
  return String(embed?.type ?? embed?.data?.type ?? '').toLowerCase();
}

/**
 * Whether an embed is a GIF (see classifyEmbed for the rules) and, for a GIF, the animation the GIF watch downloads
 * (gifAnimationUrl, or a Discord CDN GIF file's own URL), else null.
 */
function gifOf(
  embed: EmbedInput | null | undefined,
  url: string | null,
  providerName: string,
  videoSites: ReadonlyArray<string>
): { isGif: boolean; animationUrl: string | null } {
  // A JS caller may hand anything as `videoSites`; only an array is a list of sites.
  const sites = Array.isArray(videoSites) ? (videoSites as Array<string>) : [];
  const onVideoSite = Boolean(url && sites.length > 0 && videoSiteFor(url, sites) !== null);
  const isGifv = embedTypeOf(embed) === GIF_EMBED_TYPE && !onVideoSite;
  const discordGif = isDiscordGifFile(embed, url);
  const isGif = isGifv || GIF_PROVIDERS.has(providerName.toLowerCase()) || isGifHostUrl(url ?? '') || discordGif;
  const animationUrl = isGif ? (gifAnimationUrl(embed, url) ?? (discordGif ? url : null)) : null;
  return { isGif, animationUrl };
}

/**
 * Classify one Discord embed into a link-ish item: `{ site, title, text,
 * thumbnailUrl, kind, url }`. `kind` is `'gif'` for a GIF (its thumbnail is
 * the frame to describe), else `'link'`: a video-site embed (YouTube, say)
 * keeps `kind: 'link'` but still carries `thumbnailUrl`. An embed is a GIF
 * when its Discord type is `gifv` (a GIF-picker post, whatever the site),
 * its provider is tenor or giphy, its URL is on a GIF site (isGifHostUrl), or
 * it is a pasted link to a GIF file on the Discord CDN (isDiscordGifFile:
 * a `.gif` path or an `image/gif` thumbnail; its own URL is then the
 * animation). Any other Discord CDN link (a `.png`, ...) stays a link.
 * A `gifv` embed whose URL is on one of `videoSites` stays a link: the video
 * describer owns that site. `url` stays the page Discord embeds again when
 * it is posted.
 * `thumbnail.proxyURL` is preferred over `thumbnail.url` when discord.js
 * exposes one: Discord's own embed proxy (`media.discordapp.net` and
 * `images-ext-*.discordapp.net`) is reliably fetchable, unlike some
 * third-party thumbnail hosts. A gif embed that carries its animation (see
 * gifAnimationUrl: the `gifv` video, or a `.gif` link; or a Discord CDN GIF
 * file's own URL) adds `animationUrl`,
 * the file the GIF watch downloads; no other item ever has the key.
 * `thumbnailWidth` and `thumbnailHeight` are the thumbnail's pixel size when
 * Discord reports it (else null), for fitBox.
 */
export function classifyEmbed(
  embed: EmbedInput | null | undefined,
  { embedTextChars = 200, videoSites = [] }: { embedTextChars?: number; videoSites?: ReadonlyArray<string> } = {}
): EmbedItem {
  const url = embed?.url ?? null;
  const host = siteOf(url ?? '');
  const providerName = String(embed?.provider?.name ?? '');
  const { isGif, animationUrl } = gifOf(embed, url, providerName, videoSites);
  const site = providerName || host || '';
  return {
    site,
    title: clipWithEllipsis(String(embed?.title ?? '').trim(), embedTextChars),
    text: clipWithEllipsis(String(embed?.description ?? '').trim(), embedTextChars),
    thumbnailUrl: embed?.thumbnail?.proxyURL ?? embed?.thumbnail?.url ?? null,
    thumbnailWidth: positiveDimension(embed?.thumbnail?.width),
    thumbnailHeight: positiveDimension(embed?.thumbnail?.height),
    kind: isGif ? 'gif' : 'link',
    url,
    ...(animationUrl ? { animationUrl } : {}),
  };
}
