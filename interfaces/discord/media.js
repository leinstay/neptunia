// The addresses of Discord's media, the one place that knows its hosts: the CDN and the media proxy a picture is
// resized through, the sticker address, a pasted link to a CDN video, and the preview address and expiry of an
// attachment or a link that the package puts on every message it hands the core (collect.js#normalizeMessage).
// The core reads `previewUrl` and `expiring` and never a host. Pure: no network, no discord.js.

import { DISCORD_CDN_HOSTS, classifyAttachment, fitBox } from '../../src/media/classify.js';

const DISCORD_EXTERNAL_PROXY_HOST_RE = /^images-ext-\d+\.discordapp\.net$/;

// Sticker format types (Discord's `sticker.format`): PNG=1, APNG=2, Lottie=3,
// GIF=4 -- Lottie is a vector animation, never a raster picture, so it is
// deliberately absent from this map (see stickerUrl below).
/** @type {Record<number, string>} */
const STICKER_FORMAT_EXT = { 1: 'png', 2: 'png', 4: 'gif' };
// Verified against the live CDN: media.discordapp.net/stickers/<id>.<ext>
// takes a `size` query param (a power of two), NOT width/height/format —
// cdn.discordapp.com 404s on a GIF sticker entirely, so that host is never
// used here.
const STICKER_SIZE = 160;

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
 * fields a slim message keeps for a sticker (see src/memory/update.js
 * #slimMessage), so no stored URL is needed to look up a description-cache
 * entry. `null` for a Lottie sticker (format 3) or any
 * other non-picture format: it is never a picture, name only.
 * @param {string} id
 * @param {number} format
 */
export function stickerUrl(id, format) {
  const ext = STICKER_FORMAT_EXT[format];
  return ext ? `https://media.discordapp.net/stickers/${id}.${ext}?size=${STICKER_SIZE}` : null;
}

/**
 * Whether `url` is an address that stops working after a while: a file on the Discord CDN or its media proxy carries
 * a signed query (`ex`, `is`, `hm`) that lapses, and the link behind it dies with it.
 * @param {unknown} url
 */
export function isExpiringUrl(url) {
  let parsed;
  try {
    parsed = new URL(typeof url === 'string' ? url : '');
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return DISCORD_CDN_HOSTS.has(host) || DISCORD_EXTERNAL_PROXY_HOST_RE.test(host);
}

/**
 * The address a describer downloads for an item: the picture sized to at most `imageSize` on the media proxy (the
 * aspect kept, `fitBox`), as webp; one still `png` frame for a GIF (an animated webp can exceed the vision download
 * limit); a webp poster frame, with no size, for a video. `imageSize` (`media.imageSize`) not given or not positive
 * sends no size at all. Hosts other than Discord's come back as they are.
 * @param {{ kind?: string, url?: string|null, width?: number|null, height?: number|null }} item
 * @param {number|undefined} imageSize
 * @returns {string|null}
 */
export function previewUrlOf(item, imageSize) {
  if (typeof item?.url !== 'string' || item.url === '') return null;
  if (item.kind === 'video') return mediaProxyUrl(item.url, { format: 'webp' });
  const sized = fitBox(item.width, item.height, imageSize) ?? {};
  if (item.kind === 'gif') return mediaProxyUrl(item.url, { ...sized, format: 'png', animated: false });
  return mediaProxyUrl(item.url, { ...sized, format: 'webp' });
}

const PREVIEW_KINDS = new Set(['image', 'gif', 'video']);

/**
 * Attachments with what the core reads of their address: `expiring` (a signed Discord address that lapses) and
 * `previewUrl`, the picture the describer downloads, sized to `imageSize` (null for a kind that is no picture).
 * @template {{ kind?: unknown, url?: unknown, width?: unknown, height?: unknown }} T
 * @param {ReadonlyArray<T>} attachments
 * @param {number|undefined} imageSize
 * @returns {Array<T & { expiring: boolean, previewUrl: string|null }>}
 */
export function previewAttachments(attachments, imageSize) {
  return attachments.map((attachment) => ({
    ...attachment,
    expiring: isExpiringUrl(attachment.url),
    previewUrl:
      typeof attachment.kind === 'string' && PREVIEW_KINDS.has(attachment.kind)
        ? previewUrlOf(
            {
              kind: attachment.kind,
              url: typeof attachment.url === 'string' ? attachment.url : null,
              width: typeof attachment.width === 'number' ? attachment.width : null,
              height: typeof attachment.height === 'number' ? attachment.height : null,
            },
            imageSize
          )
        : null,
  }));
}

/**
 * Links with `expiring` and, when they have a thumbnail, its `previewUrl`, like `previewAttachments`.
 * @template {{ kind?: unknown, url?: unknown, thumbnailUrl?: unknown, thumbnailWidth?: unknown, thumbnailHeight?: unknown }} T
 * @param {ReadonlyArray<T>} links
 * @param {number|undefined} imageSize
 * @returns {Array<T & { expiring: boolean, previewUrl?: string|null }>}
 */
export function previewLinks(links, imageSize) {
  return links.map((link) => ({
    ...link,
    expiring: isExpiringUrl(link.url),
    ...(typeof link.thumbnailUrl === 'string' && link.thumbnailUrl !== ''
      ? {
          previewUrl: previewUrlOf(
            {
              kind: typeof link.kind === 'string' ? link.kind : undefined,
              url: link.thumbnailUrl,
              width: typeof link.thumbnailWidth === 'number' ? link.thumbnailWidth : null,
              height: typeof link.thumbnailHeight === 'number' ? link.thumbnailHeight : null,
            },
            imageSize
          ),
        }
      : {}),
  }));
}
