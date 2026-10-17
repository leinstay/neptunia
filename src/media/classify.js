// Pure media semantics shared by interfaces/discord/collect.js (normalization),
// src/format.js (transcript rendering) and src/behavior/prompt.js
// (vision selection): classifying an attachment/embed into a kind, choosing
// which label form a media item takes in a transcript line, rewriting a
// Discord CDN URL through the media proxy for resizing, recognising a pasted
// link to a Discord CDN video attachment (discordCdnVideo), and picking which
// pictures of a channel a live turn may see, and listing the video
// candidates of a message (attached videos, video-site links) for the video
// describer. No network I/O, no discord.js
// import — callers hand in plain data already read off a discord.js
// Message/Embed (node:crypto is used only for a deterministic, synchronous
// hash, not for any I/O).

import { createHash } from 'node:crypto';
import { videoSiteFor } from './video-sites.js';

const DISCORD_CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const DISCORD_EXTERNAL_PROXY_HOST_RE = /^images-ext-\d+\.discordapp\.net$/;
const GIF_PROVIDERS = new Set(['tenor', 'giphy']);
// The GIF sites whose pages Discord's GIF picker posts (and their media hosts).
const GIF_HOST_RE = /(^|\.)((tenor|giphy|klipy)\.com)$/i;
// Discord's embed type for a looping GIF video: what every GIF-picker post
// carries, whatever site serves it.
const GIF_EMBED_TYPE = 'gifv';

// Extensions Discord may leave without a contentType (or none at all, for
// bots that strip it): a conservative, deliberately small map — anything
// unmatched falls back to the generic 'file' kind.
const EXT_KIND = {
  gif: 'gif',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  mkv: 'video',
  avi: 'video',
  mp3: 'audio',
  ogg: 'audio',
  wav: 'audio',
  m4a: 'audio',
  flac: 'audio',
  txt: 'text',
  md: 'text',
  log: 'text',
  csv: 'text',
  json: 'text',
  js: 'text',
};

// Media "picture" kinds: the ones that can be attached to a request as an
// image_url part (see selectPictures/collectPictures below).
const PICTURE_ATTACHMENT_KINDS = new Set(['image', 'gif', 'video']);
// Media kinds the describer (src/memory/describe.js) can produce a caption
// for. 'sticker'/'emoji' are added here for the same reason a picture-format
// sticker or a custom emoji is describable, even though neither is a Discord
// attachment/embed kind. 'link' (a video-site embed such as YouTube) is
// describable through its thumbnail alone -- collectPictures only ever
// offers a 'link' item that actually carries one (see below), so the kind
// alone is a safe signal here.
const DESCRIBABLE_KINDS = new Set(['image', 'gif', 'video', 'sticker', 'emoji', 'link']);

// Sticker format types (Discord's `sticker.format`): PNG=1, APNG=2, Lottie=3,
// GIF=4 -- Lottie is a vector animation, never a raster picture, so it is
// deliberately absent from this map (see stickerUrl below).
const STICKER_FORMAT_EXT = { 1: 'png', 2: 'png', 4: 'gif' };
// Verified against the live CDN: media.discordapp.net/stickers/<id>.<ext>
// takes a `size` query param (a power of two), NOT width/height/format —
// cdn.discordapp.com 404s on a GIF sticker entirely, so that host is never
// used here.
const STICKER_SIZE = 160;
// Verified against the live CDN: this exact host+path+size serves both a
// static and an animated custom emoji as image/webp.
const EMOJI_SIZE = 96;

function extOf(name) {
  const match = /\.([a-z0-9]+)$/i.exec(String(name ?? ''));
  return match ? match[1].toLowerCase() : null;
}

/**
 * `text` cut to its first `maxChars` code points with `…` appended (the
 * ellipsis is outside the budget), or unchanged when it fits. Never splits a
 * surrogate pair, never trims. A missing, non-finite or non-positive
 * `maxChars` means no limit.
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string}
 */
export function clipWithEllipsis(text, maxChars) {
  const value = String(text ?? '');
  const limit = Math.floor(Number(maxChars));
  if (!Number.isFinite(limit) || limit <= 0 || value.length <= limit) return value;
  const points = Array.from(value);
  if (points.length <= limit) return value;
  return `${points.slice(0, limit).join('')}…`;
}

/**
 * The hostname of `url` without a leading `www.`, or '' for an unparsable URL.
 * @param {string} url
 * @returns {string}
 */
export function siteOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/**
 * Classify one Discord attachment into `image | gif | video | audio | voice |
 * text | file`. `isVoice` reflects the MESSAGE's voice-message flag (Discord
 * flags the whole message, not the attachment); a voice message's attachment
 * always classifies as `voice`, ahead of its content type.
 * @param {{ contentType?: string|null, name?: string|null, isVoice?: boolean }} input
 */
export function classifyAttachment({ contentType, name, isVoice = false } = {}) {
  if (isVoice) return 'voice';
  const type = String(contentType ?? '').toLowerCase();
  if (type === 'image/gif') return 'gif';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('text/')) return 'text';
  const ext = extOf(name);
  if (ext && EXT_KIND[ext]) return EXT_KIND[ext];
  return 'file';
}

// `/attachments/<channel id>/<attachment id>/<file name>` (or the
// `ephemeral-attachments` prefix): the path of a file uploaded to Discord.
const CDN_ATTACHMENT_PATH_RE = /^\/(?:ephemeral-)?attachments\/(\d+)\/(\d+)\/([^/]+)$/;

/**
 * The Discord CDN hosts (`cdn.discordapp.com`, `media.discordapp.net`) as a
 * site list for extractVideoUrls (src/media/video-sites.js), so a typed CDN
 * link is found by the same URL extraction as a video-site link.
 */
export const DISCORD_CDN_SITES = Object.freeze([...DISCORD_CDN_HOSTS]);

/**
 * The attachment a Discord CDN link points at, when that attachment is a
 * video: `{ id, name }`, else null. A member may paste the link of a file
 * uploaded elsewhere instead of uploading it again; Discord then plays it,
 * but the message carries no attachment. Non-null only for an http(s) URL on
 * a DISCORD_CDN_HOSTS host whose path is `/attachments/<digits>/<digits>/<file>`
 * or `/ephemeral-attachments/<digits>/<digits>/<file>` and whose file name
 * classifies as `video` (see classifyAttachment). `id` is the second numeric
 * segment -- the attachment's own snowflake, so the link shares the
 * describer's cache entry with the original upload; `name` is the decoded
 * file name.
 * @param {string} url
 * @returns {{ id: string, name: string }|null}
 */
export function discordCdnVideo(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ''));
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!DISCORD_CDN_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  const match = CDN_ATTACHMENT_PATH_RE.exec(parsed.pathname);
  if (!match) return null;
  let name;
  try {
    name = decodeURIComponent(match[3]);
  } catch {
    return null;
  }
  if (classifyAttachment({ name }) !== 'video') return null;
  return { id: match[2], name };
}

/** Whether `url` parses and its path ends in `.gif` (case-insensitive). */
function isGifFileUrl(url) {
  try {
    return /\.gif$/i.test(new URL(String(url)).pathname);
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
function gifAnimationUrl(embed, url) {
  const video = embed?.video?.proxyURL || embed?.video?.url;
  if (typeof video === 'string' && video) return video;
  return url && isGifFileUrl(url) ? url : null;
}

/**
 * Whether `url` is on a GIF site (tenor, giphy, klipy -- a page or one of
 * their media hosts). False for an unparsable URL.
 * @param {string} url
 * @returns {boolean}
 */
export function isGifHostUrl(url) {
  return GIF_HOST_RE.test(siteOf(url ?? ''));
}

/**
 * The content type of an embed's thumbnail, lowercased: a plain object's
 * `thumbnail.contentType`, a discord.js Embed's `data.thumbnail.content_type`
 * (its `thumbnail` getter drops the field); '' when neither is there.
 */
function thumbnailContentTypeOf(embed) {
  return String(embed?.thumbnail?.contentType ?? embed?.data?.thumbnail?.content_type ?? '').toLowerCase();
}

/**
 * Whether an embed is a link to a GIF file on the Discord CDN
 * (DISCORD_CDN_HOSTS): its URL's path ends in `.gif`, or its thumbnail's
 * content type is `image/gif`. A member pasting such a link gets an image
 * embed, no attachment; it is still a GIF to watch, not a page preview.
 */
function isDiscordGifFile(embed, url) {
  if (!url || !DISCORD_CDN_HOSTS.has(siteOf(url).toLowerCase())) return false;
  return isGifFileUrl(url) || thumbnailContentTypeOf(embed) === 'image/gif';
}

/** An embed's Discord type (`gifv`, `rich`, ...), lowercased: a plain object's `type`, a discord.js Embed's `data.type`. */
function embedTypeOf(embed) {
  return String(embed?.type ?? embed?.data?.type ?? '').toLowerCase();
}

/**
 * Classify one Discord embed into a link-ish item: `{ site, title, text,
 * thumbnailUrl, kind, url }`. `kind` is `'gif'` for a GIF (its thumbnail is
 * the frame to describe), else `'link'` — a video-site embed (e.g. YouTube)
 * keeps `kind: 'link'` but still carries `thumbnailUrl`. An embed is a GIF
 * when its Discord type is `gifv` (a GIF-picker post, whatever the site),
 * its provider is tenor/giphy, its URL is on a GIF site (isGifHostUrl), or
 * it is a pasted link to a GIF file on the Discord CDN (isDiscordGifFile:
 * a `.gif` path or an `image/gif` thumbnail; its own URL is then the
 * animation). Any other Discord CDN link (a `.png`, ...) stays a link.
 * A `gifv` embed whose URL is on one of `videoSites` stays a link: the video
 * describer owns that site. `url` stays the page Discord embeds again when
 * it is posted.
 * `thumbnail.proxyURL` is preferred over `thumbnail.url` when discord.js
 * exposes one: Discord's own embed proxy (`media.discordapp.net` /
 * `images-ext-*.discordapp.net`) is reliably fetchable, unlike some
 * third-party thumbnail hosts. A gif embed that carries its animation (see
 * gifAnimationUrl: the `gifv` video, or a `.gif` link; or a Discord CDN GIF
 * file's own URL) adds `animationUrl`,
 * the file the GIF watch downloads; no other item ever has the key.
 * `thumbnailWidth` / `thumbnailHeight` are the thumbnail's pixel size when
 * Discord reports it (else null), for fitBox.
 * @param {{ url?: string|null, title?: string|null, description?: string|null,
 *   thumbnail?: { url?: string|null, proxyURL?: string|null, width?: number|null, height?: number|null, contentType?: string|null }|null,
 *   video?: { url?: string|null, proxyURL?: string|null }|null,
 *   provider?: { name?: string|null }|null }} embed
 * @param {{ embedTextChars?: number, videoSites?: string[] }} [options]
 */
export function classifyEmbed(embed, { embedTextChars = 200, videoSites = [] } = {}) {
  const url = embed?.url ?? null;
  const host = siteOf(url ?? '');
  const providerName = String(embed?.provider?.name ?? '');
  const onVideoSite = Boolean(url) && Array.isArray(videoSites) && videoSites.length > 0 && videoSiteFor(url, videoSites) !== null;
  const isGifv = embedTypeOf(embed) === GIF_EMBED_TYPE && !onVideoSite;
  const discordGif = isDiscordGifFile(embed, url);
  const isGif = isGifv || GIF_PROVIDERS.has(providerName.toLowerCase()) || isGifHostUrl(url) || discordGif;
  const site = providerName || host || '';
  const animationUrl = isGif ? (gifAnimationUrl(embed, url) ?? (discordGif ? url : null)) : null;
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

/**
 * A stable cache key for a link/embed thumbnail: `link:<sha1 prefix of the
 * URL without its query string>`. A signed Discord proxy URL (or any
 * re-fetched embed) carries a query string that changes between fetches of
 * the very same picture; the origin+path does not, so it is dropped before
 * hashing. Deterministic and pure (no I/O) -- see stickerUrl/emojiUrl for the
 * same "rebuild an id from stable inputs" idea.
 * @param {string} url
 */
export function linkThumbnailCacheKey(url) {
  let base = String(url ?? '');
  try {
    const parsed = new URL(base);
    base = `${parsed.origin}${parsed.pathname}`;
  } catch {
    // An unparsable URL still hashes to something stable -- best effort.
  }
  return `link:${createHash('sha1').update(base).digest('hex').slice(0, 16)}`;
}

/** `m:ss`, floored/rounded to the nearest second, never negative. */
export function formatDurationShort(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/** A pixel dimension as a positive finite number, else null. */
export function positiveDimension(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The media-proxy `width`/`height` pair for a picture of known size: the
 * proxy FILLS the box it is given and centre-crops to it, and ignores a lone
 * `width` or `height`, so the only way to resize without cropping is a box of
 * the picture's own aspect. Scales so that the longer side is at most `max`
 * (rounded to integers, each side at least 1), never upscales (a picture
 * already within `max` keeps its size). Null when either dimension is
 * unknown or not positive, or `max` is not positive: the caller then sends
 * no size at all and the original is served. Pure.
 * @param {number|null|undefined} width
 * @param {number|null|undefined} height
 * @param {number} max
 * @returns {{ width: number, height: number }|null}
 */
export function fitBox(width, height, max) {
  const w = positiveDimension(width);
  const h = positiveDimension(height);
  const limit = positiveDimension(max);
  if (w === null || h === null || limit === null) return null;
  const scale = Math.min(1, limit / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/**
 * Rewrite a Discord attachment URL through the media proxy so it is served at
 * a given size/format. Measured against real Discord payloads:
 * `cdn.discordapp.com` silently IGNORES `width`/`height`/`format` and serves
 * the original file (a full-size image, or for a video attachment the whole
 * file -- never something safe to hand a model as an `image_url` part);
 * `media.discordapp.net` is the host that actually resizes/reformats. So both
 * `cdn.discordapp.com` and `media.discordapp.net` attachment URLs are
 * rewritten to the `media.discordapp.net` host, with `width` / `height` /
 * `format` set (or replaced, when already present) — every other existing
 * query parameter survives untouched, crucially the signed `ex`/`is`/`hm`
 * ones. Discord's external-content proxy (`images-ext-<n>.discordapp.net`,
 * e.g. a tenor embed's thumbnail) accepts the same parameters and gets them
 * the same way, but keeps its own host: its path is proxy-specific. Every
 * other host is returned unchanged (its own thumbnail is already a plain
 * image, not a video needing frame extraction). `animated` (when
 * given) sets the proxy's `animated` param: `false` asks for one still frame
 * of an animated GIF instead of an animated webp that can exceed the vision
 * download limit. The proxy fills a `width` x `height` box and centre-crops
 * to it (a lone `width` or `height` is ignored), so callers pass either a
 * pair of the picture's own aspect (fitBox) or no size at all.
 * Best-effort: an unparsable URL is returned as-is.
 * @param {string} url
 * @param {{ width?: number, height?: number, format?: string, animated?: boolean }} [options]
 */
export function mediaProxyUrl(url, { width, height, format, animated } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return url;
  }
  if (DISCORD_CDN_HOSTS.has(parsed.hostname)) parsed.hostname = 'media.discordapp.net';
  else if (!DISCORD_EXTERNAL_PROXY_HOST_RE.test(parsed.hostname)) return url;
  if (width != null) parsed.searchParams.set('width', String(width));
  if (height != null) parsed.searchParams.set('height', String(height));
  if (format) parsed.searchParams.set('format', format);
  if (typeof animated === 'boolean') parsed.searchParams.set('animated', String(animated));
  return parsed.toString();
}

/**
 * Rebuild a sticker's picture URL from just its id/format -- the only two
 * fields the slim memory buffer keeps for a sticker (see src/memory/update.js
 * `observe()`), so the live analyzer never needs a stored URL to look up a
 * description-cache entry. `null` for a Lottie sticker (format 3) or any
 * other non-picture format: it is never a picture, name only.
 * @param {string} id
 * @param {number} format
 */
export function stickerUrl(id, format) {
  const ext = STICKER_FORMAT_EXT[format];
  return ext ? `https://media.discordapp.net/stickers/${id}.${ext}?size=${STICKER_SIZE}` : null;
}

/**
 * Rebuild a custom emoji's picture URL from just its id -- the only field the
 * slim memory buffer keeps for an emoji (see src/memory/update.js
 * `observe()`). The same URL serves a static and an animated emoji alike
 * (image/webp either way).
 * @param {string} id
 */
export function emojiUrl(id) {
  return `https://cdn.discordapp.com/emojis/${id}.webp?size=${EMOJI_SIZE}`;
}

/**
 * `m:ss` for a known duration, or `unknownDuration` when `durationSec` is
 * null/undefined -- Discord's own `duration_secs` is usually present on a
 * video/voice/audio attachment but can be missing; this must never silently
 * render as "0:00" for an unknown length.
 */
function durationOrUnknown(durationSec, unknownDuration) {
  return durationSec == null ? unknownDuration : formatDurationShort(durationSec);
}

/**
 * The reason CODE of a not-watched video state: `'length' | 'size' | 'daily'`
 * for a `limit` state, `'error'` for an `error` state, `'pending'` for a
 * `pending` one (its watch had not finished when the request was built).
 * Label-free on purpose: src/format.js swaps it for
 * `labels.transcript.videoReason[code]`.
 */
function videoReasonCode(video) {
  if (video.state === 'error' || video.state === 'pending') return video.state;
  return String(video.reason ?? '');
}

/**
 * The watched lengths a cached video summary (a media cache entry
 * `video:<item id>`) carries, for its video state: `watchedSeconds` (the
 * downloaded clip's length) and `totalSeconds` (a link's probed total
 * length), each only when it is a finite number -- an entry from before
 * either was stored gives `{}`. Pure.
 * @param {object|undefined} entry
 * @returns {{ watchedSeconds?: number, totalSeconds?: number }}
 */
export function watchedLengths(entry) {
  const out = {};
  for (const key of ['watchedSeconds', 'totalSeconds']) {
    const value = entry?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/**
 * Whether a watched video was seen only in part: its total length
 * `durationSec` and the watched clip's `watchedSeconds` are both known and
 * the total is longer by at least a whole second (both rounded as m:ss shows them).
 */
function watchedPart(durationSec, watchedSeconds) {
  const known = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  return known(durationSec) && known(watchedSeconds) && Math.round(durationSec) > Math.round(watchedSeconds);
}

/**
 * The ONE video extra tag of a `link` item with a video state: `linkWatched`
 * when the video was watched -- `linkWatchedPart` when the state's
 * `watchedSeconds` is shorter than its total (`video.totalSeconds`, else the
 * item's `durationSec`), with `{ duration, watched }` as m:ss and the reason
 * code `'clip'` --, else `linkNotWatchedFrame` when a thumbnail caption
 * exists, else `linkNotWatched`.
 */
function linkVideoExtra(video, description, item) {
  if (video.state === 'watched') {
    const total = video.totalSeconds ?? item?.durationSec;
    if (watchedPart(total, video.watchedSeconds)) {
      return {
        key: 'linkWatchedPart',
        values: {
          duration: formatDurationShort(total),
          watched: formatDurationShort(video.watchedSeconds),
          reason: 'clip',
          text: video.text ?? '',
        },
      };
    }
    return { key: 'linkWatched', values: { text: video.text ?? '' } };
  }
  const reason = videoReasonCode(video);
  return description
    ? { key: 'linkNotWatchedFrame', values: { reason, text: description } }
    : { key: 'linkNotWatched', values: { reason } };
}

/**
 * The `videoAnswered` extra of a watched video that got a second look on a
 * question (`video.answer = { question, text }`), else null.
 */
function answeredExtra(video) {
  if (video?.state !== 'watched' || !video.answer) return null;
  return { key: 'videoAnswered', values: { question: video.answer.question ?? '', text: video.answer.text ?? '' } };
}

/**
 * The `imageAnswered` extra of a picture that got a second look on a
 * question (`answer = { question, text }`, src/memory/describe.js#relookImage), else null.
 */
function imageAnsweredExtra(answer) {
  if (!answer) return null;
  return { key: 'imageAnswered', values: { question: answer.question ?? '', text: answer.text ?? '' } };
}

/**
 * The `videoAnswered` extra of a GIF that got a second look on a question
 * (`answer = { question, text }`, src/memory/describe.js#rewatchGif: its clip
 * watched again, as a video's), else null.
 */
function gifAnsweredExtra(answer) {
  if (!answer) return null;
  return { key: 'videoAnswered', values: { question: answer.question ?? '', text: answer.text ?? '' } };
}

/** `base` with `extra` (an extraOf result) added when there is one. */
function withExtra(base, extra) {
  return extra ? { ...base, extra } : base;
}

/** `extras` without the nulls: none -> undefined, one -> that tag, more -> the array. */
function extraOf(...extras) {
  const kept = extras.flatMap((extra) => (Array.isArray(extra) ? extra : extra ? [extra] : []));
  if (kept.length === 0) return undefined;
  return kept.length === 1 ? kept[0] : kept;
}

/**
 * Choose which `labels.transcript.*` key (and fill values) renders one media
 * item, in priority order: attached to this request (most informative) >
 * described > blind. `item` is a normalized attachment or link/embed item
 * (see interfaces/discord/collect.js): `{ kind, name?, site?, title?, text?,
 * durationSec?, previewText? }`.
 *
 * A plain image/thumbnail attached to the request renders as a bare
 * `imageAttached`, or as `imageAttachedDescribed` (`{ n, text }`: the marker
 * and the helper's caption together) when a caption exists -- with that key
 * blanked in prompts.local/labels.json, src/format.js falls back to
 * `imageAttached`. A video or gif whose still frame is attached keeps its
 * normal form (`video`/`videoDescribed`/`gif`/`gifDescribed` -- so the
 * persona still knows it WAS a video, its name, its duration) and carries a
 * second tag in `extra`: `frameAttached`, numbered the same way. A `link`
 * (a video-site embed, e.g. YouTube) never swaps its own tag: the plain
 * `link`/`linkText` form always stays, and ONE extra tag follows it —
 * `frameAttached` when its thumbnail is attached, else `thumbnailDescribed`
 * when a caption exists, else nothing.
 *
 * `context.video` is the item's video state (see collectVideos and the video
 * describer): `{ state: 'watched', text }`, `{ state: 'limit', reason:
 * 'length'|'size'|'daily' }`, `{ state: 'error' }` or `{ state: 'pending' }`
 * (the turn's watch missed its deadline, see lateVideoStates); null keeps the
 * still-frame behaviour above. A `video` item that was watched renders
 * `videoWatched`, or `videoWatchedPart` when the state's `watchedSeconds` (the
 * downloaded clip's length) is shorter than the item's known `durationSec`
 * (`values.watched` its m:ss, `values.reason` the code `'clip'`, swapped by
 * src/format.js for `transcript.videoPartReason.clip`); one not watched renders `videoNotWatchedFrame` (a still
 * frame caption exists) or `videoNotWatched`, `values.reason` carrying the
 * reason CODE (`'length'|'size'|'daily'|'error'|'pending'`, never a label -- see
 * src/format.js). A `link` with a video state swaps its one extra for
 * `linkWatched` / `linkNotWatchedFrame` / `linkNotWatched`; when its
 * thumbnail is also attached, `extra` is an array: `frameAttached` first,
 * the video extra second. A watched video (attachment or link) whose state
 * carries `answer: { question, text }` (a second look on a question, see
 * src/memory/describe.js#rewatchVideo) appends `videoAnswered` after every
 * other tag of the item. Every other kind ignores `context.video`.
 *
 * `context.read` is the excerpt of a `link` page read by the web lookup
 * (src/web/lookup.js#readLink): it appends `linkRead` after every other extra
 * of the link (frameAttached, the video extra, videoAnswered or
 * thumbnailDescribed). Every other kind ignores it.
 *
 * `context.gifHandle` is the library handle (`g12`, see
 * src/memory/gifs.js#gifHandleOf) of a `gif` item the persona can post
 * back: it renders `gifKnown` (`{ id, text }`) when a caption exists, else
 * `gifKnownNoText` (`{ id, name }`), in place of `gifDescribed`/`gif` (with
 * those keys blanked in prompts.local/labels.json, src/format.js
 * falls back to them). Every other kind ignores it.
 *
 * `context.gifFields` is that GIF's three caption fields (`{ reaction,
 * action, screen }`, already cut for display, see
 * src/behavior/prompt.js#gifFieldsMap): a `gif` item with a handle and a
 * caption whose `reaction` or `screen` is non-empty renders `gifKnownFields`
 * (`{ id, text, reaction, action, screen }`, `text` being the caption
 * gifKnown would show) in place of `gifKnown`; with that key blanked
 * src/format.js falls back to `gifKnown`. A GIF without a handle
 * ignores it (`gifDescribed` keeps the caption alone).
 *
 * `context.answer` is a picture's second look on a question (`{ question,
 * text }`, src/memory/describe.js#relookImage): an `image` item, attached or
 * not, appends `imageAnswered` after its own tag. A `gif` item takes a GIF's
 * second look the same way (src/memory/describe.js#rewatchGif) and appends
 * `videoAnswered` instead: its clip was watched again, as a video's. Every
 * other kind ignores it (a video's answer lives in its state, `context.video.answer`).
 * @param {object} item
 * @param {{ attachedIndex?: number|null, description?: string|null, unknownDuration?: string,
 *   video?: { state: 'watched'|'limit'|'error'|'pending', text?: string, reason?: string, watchedSeconds?: number,
 *     totalSeconds?: number, answer?: { question: string, text: string } }|null, read?: string|null, gifHandle?: string|null,
 *   gifFields?: { reaction?: string, action?: string, screen?: string }|null,
 *   answer?: { question: string, text: string }|null }} [context]
 * @returns {{ key: string, values: object,
 *   extra?: { key: string, values: object }|{ key: string, values: object }[] }}
 */
export function mediaLabelFor(
  item,
  {
    attachedIndex = null,
    description = null,
    unknownDuration = '?',
    video = null,
    read = null,
    gifHandle = null,
    gifFields = null,
    answer = null,
  } = {},
) {
  // A `link`'s attached thumbnail is handled in its own case below.
  if (attachedIndex != null && PICTURE_ATTACHMENT_KINDS.has(item.kind)) {
    if (item.kind === 'video' || item.kind === 'gif') {
      const gifOnly = item.kind === 'gif';
      const base = mediaLabelFor(item, {
        description,
        unknownDuration,
        video,
        gifHandle,
        gifFields: gifOnly ? gifFields : null,
        answer: gifOnly ? answer : null,
      });
      return { ...base, extra: extraOf({ key: 'frameAttached', values: { n: attachedIndex } }, base.extra) };
    }
    const attached = description
      ? { key: 'imageAttachedDescribed', values: { n: attachedIndex, text: description } }
      : { key: 'imageAttached', values: { n: attachedIndex } };
    return withExtra(attached, extraOf(imageAnsweredExtra(answer)));
  }

  switch (item.kind) {
    case 'image': {
      const base = description ? { key: 'imageDescribed', values: { text: description } } : { key: 'image', values: {} };
      return withExtra(base, extraOf(imageAnsweredExtra(answer)));
    }
    case 'gif': {
      const name = item.name || item.title || item.site || '';
      const answered = extraOf(gifAnsweredExtra(answer));
      if (gifHandle) {
        const field = (value) => (typeof value === 'string' ? value : '');
        const reaction = field(gifFields?.reaction);
        const screen = field(gifFields?.screen);
        const known =
          description && (reaction || screen)
            ? { key: 'gifKnownFields', values: { id: gifHandle, text: description, reaction, action: field(gifFields.action), screen } }
            : description
              ? { key: 'gifKnown', values: { id: gifHandle, text: description } }
              : { key: 'gifKnownNoText', values: { id: gifHandle, name } };
        return withExtra(known, answered);
      }
      return withExtra(description ? { key: 'gifDescribed', values: { text: description } } : { key: 'gif', values: { name } }, answered);
    }
    case 'video': {
      const name = item.name ?? '';
      const duration = durationOrUnknown(item.durationSec, unknownDuration);
      if (video?.state === 'watched') {
        const watched = watchedPart(item.durationSec, video.watchedSeconds)
          ? {
            key: 'videoWatchedPart',
            values: { name, duration, watched: formatDurationShort(video.watchedSeconds), reason: 'clip', text: video.text ?? '' },
          }
          : { key: 'videoWatched', values: { name, duration, text: video.text ?? '' } };
        const extra = extraOf(answeredExtra(video));
        return extra ? { ...watched, extra } : watched;
      }
      if (video) {
        const reason = videoReasonCode(video);
        return description
          ? { key: 'videoNotWatchedFrame', values: { name, duration, reason, text: description } }
          : { key: 'videoNotWatched', values: { name, duration, reason } };
      }
      return description
        ? { key: 'videoDescribed', values: { name, duration, text: description } }
        : { key: 'video', values: { name, duration } };
    }
    case 'voice':
      return { key: 'voice', values: { duration: durationOrUnknown(item.durationSec, unknownDuration) } };
    case 'audio':
      return { key: 'audio', values: { name: item.name ?? '', duration: durationOrUnknown(item.durationSec, unknownDuration) } };
    case 'text':
      return item.previewText
        ? { key: 'filePreview', values: { name: item.name ?? '', text: item.previewText } }
        : { key: 'file', values: { name: item.name ?? '' } };
    case 'link': {
      const base = item.text
        ? { key: 'linkText', values: { site: item.site ?? '', title: item.title ?? '', text: item.text } }
        : { key: 'link', values: { site: item.site ?? '', title: item.title ?? '' } };
      const frame = attachedIndex != null && item.thumbnailUrl ? { key: 'frameAttached', values: { n: attachedIndex } } : null;
      const readExtra = read ? { key: 'linkRead', values: { text: read } } : null;
      if (video) {
        const videoExtra = linkVideoExtra(video, description, item);
        return { ...base, extra: extraOf(frame, videoExtra, answeredExtra(video), readExtra) };
      }
      const thumbnail = !frame && description ? { key: 'thumbnailDescribed', values: { text: description } } : null;
      const extra = extraOf(frame, thumbnail, readExtra);
      return extra ? { ...base, extra } : base;
    }
    default:
      return { key: 'file', values: { name: item.name ?? '' } };
  }
}

/**
 * Choose which `labels.transcript.*` key (and fill values) renders one
 * sticker item, mirroring `mediaLabelFor`'s priority for the picture-format
 * ones (PNG/APNG/GIF -- `sticker.url` is set, see stickerUrl): attached >
 * described > blind (plain `sticker`, name only). A Lottie sticker
 * (`sticker.url` is null) is never a picture: always the plain `sticker`
 * form, regardless of `attachedIndex`/`description` -- see
 * `senses.lottie`.
 * @param {{ name: string, url: string|null }} sticker
 * @param {{ attachedIndex?: number|null, description?: string|null }} [context]
 * @returns {{ key: string, values: object, extra?: { key: string, values: object } }}
 */
export function stickerLabelFor(sticker, { attachedIndex = null, description = null } = {}) {
  if (!sticker.url) return { key: 'sticker', values: { name: sticker.name } };
  if (attachedIndex != null) {
    const base = stickerLabelFor(sticker, { description });
    return { ...base, extra: { key: 'frameAttached', values: { n: attachedIndex } } };
  }
  return description
    ? { key: 'stickerDescribed', values: { name: sticker.name, text: description } }
    : { key: 'sticker', values: { name: sticker.name } };
}

/**
 * The parts of one normalized message that carry media, in the order they
 * appear in it: the message itself, then every forwarded snapshot
 * (`message.forwarded`, see interfaces/discord/collect.js#normalizeSnapshot). A
 * snapshot has no id of its own, so each collector below stamps its items
 * with the OUTER message's id -- the one the history, the transcript and
 * selectPictures' ordering know. Item ids stay unique: attachment ids are
 * Discord snowflakes, link ids are cache keys or built from the original
 * message id. Shared with the analyzer and the GIF library, which walk the
 * same parts.
 * @param {object} message  A normalized (or slim buffered) message.
 * @returns {object[]}
 */
export function mediaParts(message) {
  return [message, ...(Array.isArray(message.forwarded) ? message.forwarded : [])];
}

/** The pictures of one message part (the message or one snapshot), see collectPictures. */
function partPictures(part, messageId) {
  const items = [];
  for (const attachment of part.attachments ?? []) {
    if (!PICTURE_ATTACHMENT_KINDS.has(attachment.kind)) continue;
    items.push({
      source: 'attachment',
      messageId,
      itemId: attachment.id,
      kind: attachment.kind,
      url: attachment.url,
      name: attachment.name,
      durationSec: attachment.durationSec,
      width: attachment.width ?? null,
      height: attachment.height ?? null,
    });
  }
  (part.links ?? []).forEach((link) => {
    if (!link.thumbnailUrl) return;
    items.push({
      source: 'embed',
      messageId,
      itemId: link.id,
      kind: link.kind,
      url: link.thumbnailUrl,
      name: link.title || link.site,
      width: link.thumbnailWidth ?? null,
      height: link.thumbnailHeight ?? null,
      // A gif embed's animation (see classifyEmbed), for the GIF watch.
      ...(link.kind === 'gif' && link.animationUrl ? { animationUrl: link.animationUrl } : {}),
    });
  });
  for (const sticker of part.stickers ?? []) {
    if (!sticker.url) continue; // Lottie: name only, never a picture
    items.push({
      source: 'sticker',
      messageId,
      itemId: `sticker:${sticker.id}`,
      kind: 'sticker',
      url: sticker.url,
      name: sticker.name,
    });
  }
  return items;
}

/**
 * Every "picture" of one normalized message, in the order they appear in it
 * (attachments first, then embeds/links, then a picture-format sticker; the
 * message's own first, then each forwarded snapshot's the same way): an
 * image/gif/video attachment, any embed carrying a thumbnail (gif or link
 * kind alike), or a PNG/APNG/GIF sticker (never a Lottie one -- `sticker.url`
 * is null for those, see stickerUrl). Each item is stamped with a stable
 * `itemId` (the attachment's Discord id; for an embed, the link's own id from
 * interfaces/discord/collect.js -- `video:url:<hash>` for a video-site link,
 * `link:<hash>` for another link with a thumbnail, the message+embed-index
 * for a gif embed; or `sticker:<id>`) so it can be looked up in a
 * vision-selection or description-cache map, and with the outer message's
 * `messageId` (a
 * forwarded snapshot's item included). A gif embed's item also carries its
 * `animationUrl` when the embed has one (see classifyEmbed): the file the
 * GIF watch downloads, while `url` stays the still thumbnail. Custom emoji are never included here
 * -- see collectEmojiItems: they are never eligible to be attached as a vision
 * picture, only describable.
 * @param {object} message  A normalized message (see interfaces/discord/collect.js).
 */
export function collectPictures(message) {
  return mediaParts(message).flatMap((part) => partPictures(part, message.id));
}

/**
 * Every custom emoji written in one normalized message's text (see
 * interfaces/discord/collect.js), the message's own first, then each forwarded
 * snapshot's, as a describable item -- never a vision picture
 * (too small a slot to spend an attached-image budget on, see
 * docs/prompt-contract.md), so this is kept apart from
 * collectPictures on purpose: nothing here is ever picked by selectPictures.
 * @param {object} message  A normalized message (see interfaces/discord/collect.js).
 */
export function collectEmojiItems(message) {
  return mediaParts(message).flatMap((part) =>
    (part.emojis ?? []).map((emoji) => ({
      source: 'emoji',
      messageId: message.id,
      itemId: `emoji:${emoji.id}`,
      kind: 'emoji',
      url: emoji.url,
      name: emoji.name,
    })),
  );
}

/** The video candidates of one message part (the message or one snapshot), see collectVideos. */
function partVideos(part, messageId, videoSites) {
  const items = [];
  for (const attachment of part.attachments ?? []) {
    if (attachment.kind !== 'video') continue;
    items.push({
      source: 'attachment',
      messageId,
      itemId: attachment.id,
      kind: 'video',
      url: attachment.url,
      name: attachment.name,
      durationSec: attachment.durationSec,
      bytes: attachment.size,
    });
  }
  if (!Array.isArray(videoSites) || videoSites.length === 0) return items;
  for (const link of part.links ?? []) {
    if (!link.url) continue;
    const site = videoSiteFor(link.url, videoSites);
    if (!site) continue;
    items.push({
      source: 'link',
      messageId,
      itemId: link.id,
      kind: 'link',
      url: link.url,
      site,
      name: link.title || link.site,
      durationSec: null,
    });
  }
  return items;
}

/**
 * The video candidates of one normalized message (see interfaces/discord/collect.js),
 * in the order they appear in it: every attachment of kind `video`, then every
 * link whose `url` belongs to one of `videoSites` (see videoSiteFor in
 * src/media/video-sites.js) -- the message's own first, then each forwarded
 * snapshot's the same way, all stamped with the outer message's `messageId`.
 * `itemId` is the id the transcript's `videos`
 * state map is keyed by (the attachment's Discord id, or the link's id).
 * `videoSites` missing or empty -> attachments only.
 * @param {object} message  A normalized message (see interfaces/discord/collect.js).
 * @param {{ videoSites?: string[] }} [options]
 */
export function collectVideos(message, { videoSites = [] } = {}) {
  return mediaParts(message).flatMap((part) => partVideos(part, message.id, videoSites));
}

/**
 * The video states of a turn whose video stage missed its deadline, in the
 * shape of describeVideos' `videos` (src/memory/describe.js): every state
 * `known` holds (the describer's cache) is kept, and the first `maxNew`
 * candidates it lacks -- the ones the stage was watching or had yet to
 * start, as describeVideos picks them -- become `{ state: 'pending' }`, so
 * the transcript says they were not watched rather than showing a bare
 * still frame. The candidates past `maxNew` are left out, as a finished
 * stage would leave them.
 * @param {{ itemId: string }[]} candidates  collectVideos candidates, in the stage's order.
 * @param {Map<string, object>|null|undefined} known  itemId -> cached video state.
 * @param {number} maxNew  The stage's media.video.maxPerTurn.
 * @returns {Map<string, object>}
 */
export function lateVideoStates(candidates, known, maxNew) {
  const states = new Map();
  let pending = 0;
  for (const item of candidates) {
    const state = known?.get(item.itemId);
    if (state) states.set(item.itemId, state);
    else if (pending < maxNew) {
      states.set(item.itemId, { state: 'pending' });
      pending += 1;
    }
  }
  return states;
}

/**
 * The links of one normalized message (see interfaces/discord/collect.js) the web
 * lookup may read (src/web/lookup.js#readLinks), in the order they appear in
 * it (the message's own first, then each forwarded snapshot's, all stamped
 * with the outer message's `messageId`): every `link` item with a url, minus
 * the ones on a video site of
 * `videoSites` (the video describer's, see collectVideos) and every gif embed.
 * `videoSites` missing or empty -> no link is excluded as a video.
 * @param {object} message  A normalized message (see interfaces/discord/collect.js).
 * @param {{ videoSites?: string[] }} [options]
 * @returns {{ id: string, messageId: string, url: string, site: string, title: string }[]}
 */
export function collectReadableLinks(message, { videoSites = [] } = {}) {
  const items = [];
  for (const part of mediaParts(message)) {
    for (const link of part.links ?? []) {
      if (link?.kind !== 'link' || !link.url || !link.id) continue;
      if (Array.isArray(videoSites) && videoSites.length > 0 && videoSiteFor(link.url, videoSites)) continue;
      items.push({ id: link.id, messageId: message.id, url: link.url, site: link.site ?? '', title: link.title ?? '' });
    }
  }
  return items;
}

/** Whether a picture item (see collectPictures/collectEmojiItems) is one the describer can caption. */
export function isDescribable(item) {
  return DESCRIBABLE_KINDS.has(item.kind);
}

/**
 * Select which pictures of a live turn are attached as `image_url` parts, in
 * priority order until `visionCfg.maxImages`: the trigger message's own
 * pictures, then the message it replies to, then the newest
 * `visionCfg.recentImages` pictures of the channel not older than
 * `visionCfg.recentImageMinutes` (measured from `now`). With no trigger
 * (a spontaneous turn) only the "recent" tier applies. The result is ordered
 * by where the picture actually sits in the transcript (oldest message
 * first, then item order within a message) — not by selection priority — so
 * the persona reads the numbering top-to-bottom as it reads the chat.
 *
 * A picture-format sticker (see collectPictures) is only ever eligible from
 * the TRIGGER's own message, at the same priority as its images -- never from
 * the message it replies to, nor from the "recent" tier, nor for a
 * spontaneous turn (no trigger at all).
 *
 * Only pictures of the channel the turn posts in are ever attached: a trigger
 * that sits in another channel (a call from a read-only channel answered in
 * the main one) gives neither its own pictures nor those of the message it
 * replies to -- another channel is shown as captions only. That is decided
 * when both `channelId` and the trigger's `channelId` are known and differ;
 * without either, the trigger counts as being in the turn's channel.
 * @param {object} params
 * @param {object|null} params.trigger   Normalized trigger message, or null.
 * @param {object[]} params.history      Normalized channel messages, oldest first.
 * @param {{ maxImages: number, recentImages: number, recentImageMinutes: number }} params.visionCfg
 * @param {number} params.now
 * @param {string|null} [params.channelId]  Id of the channel the turn posts in.
 */
export function selectPictures({ trigger, history, visionCfg, now, channelId = null }) {
  const maxImages = visionCfg?.maxImages ?? 0;
  if (maxImages <= 0) return [];

  const picked = [];
  const seen = new Set();
  const order = new Map(history.map((message, index) => [message.id, index]));

  function addFrom(message, { allowStickers = false } = {}) {
    if (!message || picked.length >= maxImages) return;
    for (const item of collectPictures(message)) {
      if (item.source === 'sticker' && !allowStickers) continue;
      if (picked.length >= maxImages) break;
      if (seen.has(item.itemId)) continue;
      seen.add(item.itemId);
      picked.push(item);
    }
  }

  const triggerElsewhere = Boolean(channelId) && Boolean(trigger?.channelId) && trigger.channelId !== channelId;
  if (trigger && !triggerElsewhere) {
    addFrom(trigger, { allowStickers: true });
    if (picked.length < maxImages && trigger.replyToId) {
      addFrom(history.find((message) => message.id === trigger.replyToId));
    }
  }

  if (picked.length < maxImages) {
    const minTs = now - (visionCfg?.recentImageMinutes ?? 0) * 60_000;
    const recentImages = visionCfg?.recentImages ?? 0;
    let recentTaken = 0;
    for (let i = history.length - 1; i >= 0 && recentTaken < recentImages && picked.length < maxImages; i -= 1) {
      const message = history[i];
      if (message.ts < minTs) break;
      for (const item of collectPictures(message)) {
        if (item.source === 'sticker') continue;
        if (recentTaken >= recentImages || picked.length >= maxImages) break;
        if (seen.has(item.itemId)) continue;
        seen.add(item.itemId);
        picked.push(item);
        recentTaken += 1;
      }
    }
  }

  return picked.sort((a, b) => {
    const orderA = order.get(a.messageId) ?? 0;
    const orderB = order.get(b.messageId) ?? 0;
    return orderA - orderB;
  });
}
