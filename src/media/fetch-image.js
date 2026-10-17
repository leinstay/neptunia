// Downloads a picture so it can be inlined into an LLM request as a
// `data:` URL, because the provider's own image fetcher gets a 403 from
// Discord on some CDN hosts (media.discordapp.net) even though our server
// fetches the very same URL fine. Used by src/behavior/turn.js (a live
// vision request, and the bot's avatar as a drawing's reference),
// src/admin.js (the avatar reference of `/nep draw`) and
// src/memory/describe.js (the media describer), so none of them ever hands
// the provider a Discord URL to fetch itself.
//
// A tiny in-memory LRU (~50 entries, ~10 min) avoids re-downloading the same
// picture attached on consecutive turns, keyed by the URL WITHOUT its query
// string -- Discord's CDN query params (`ex`/`is`/`hm`) are a signature that
// rotates between fetches of the very same file, so keying on the full URL
// would never hit. Only successful downloads are cached: a failure is worth
// retrying on the next turn, in case it was a transient network blip.
//
// Every log line carries the host and path only -- a Discord CDN (or embed
// proxy) query string is a signature, never logged, not even truncated --
// and a thrown error's code or class name, never its message (which may
// quote the whole URL).

import { log } from '../log.js';
import { bareContentType, safeLocation } from './video-sites.js';

const ALLOWED_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const DEFAULT_CACHE_MAX_ENTRIES = 50;
const DEFAULT_CACHE_TTL_MS = 10 * 60_000;

/** The URL without its query string -- a stable cache key across Discord's rotating signature. */
function cacheKeyFor(url) {
  try {
    const parsed = new URL(String(url));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url);
  }
}

/** Move `key` to the end of `cache` (most-recently-used), inserting it if new. */
function touchKey(cache, key, value) {
  cache.delete(key);
  cache.set(key, value);
}

/** Drop the oldest entries once `cache` holds more than `maxEntries`. */
function trimCache(cache, maxEntries) {
  const overflow = cache.size - maxEntries;
  if (overflow <= 0) return;
  const it = cache.keys();
  for (let i = 0; i < overflow; i += 1) cache.delete(it.next().value);
}

/**
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number} [deps.now]
 * @param {number} [deps.cacheMaxEntries]  Test hook; production keeps the default (~50).
 * @param {number} [deps.cacheTtlMs]       Test hook; production keeps the default (~10 min).
 */
export function createImageFetcher({
  fetchImpl = fetch,
  now = Date.now,
  cacheMaxEntries = DEFAULT_CACHE_MAX_ENTRIES,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
} = {}) {
  const cache = new Map(); // cacheKeyFor(url) -> { value, ts }

  async function download(url, { maxBytes, timeoutMs }) {
    const location = safeLocation(url);
    let response;
    try {
      response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      log.warn('fetch-image: download failed', { location, code: err?.code ?? err?.name ?? null });
      return null;
    }

    if (!response.ok) {
      log.warn('fetch-image: non-OK response', { location, status: response.status });
      return null;
    }

    const contentType = bareContentType(response.headers?.get?.('content-type'));
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      log.warn('fetch-image: unsupported content type', { location, contentType });
      return null;
    }

    const declaredSize = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
      log.warn('fetch-image: declared size exceeds the limit', { location, declaredSize, maxBytes });
      return null;
    }

    let buffer;
    try {
      buffer = Buffer.from(await response.arrayBuffer());
    } catch (err) {
      log.warn('fetch-image: reading the body failed', { location, code: err?.code ?? err?.name ?? null });
      return null;
    }

    if (buffer.byteLength > maxBytes) {
      log.warn('fetch-image: body exceeds the limit', { location, bytes: buffer.byteLength, maxBytes });
      return null;
    }

    return { dataUrl: `data:${contentType};base64,${buffer.toString('base64')}`, bytes: buffer.byteLength, contentType };
  }

  /**
   * Download `url` and return it inlined as a `data:` URL, or `null` on any
   * failure (bad content type, oversized, timeout, network/HTTP error) --
   * never throws. A repeat call for the same picture (same URL ignoring its
   * query string) within `cacheTtlMs` of a SUCCESSFUL download is served from
   * cache, no second request.
   * @param {string} url
   * @param {{ maxBytes: number, timeoutMs: number }} options
   * @returns {Promise<{ dataUrl: string, bytes: number, contentType: string }|null>}
   */
  async function fetchAsDataUrl(url, { maxBytes, timeoutMs } = {}) {
    const key = cacheKeyFor(url);
    const cached = cache.get(key);
    if (cached && now() - cached.ts < cacheTtlMs) {
      touchKey(cache, key, cached);
      return cached.value;
    }

    const result = await download(url, { maxBytes, timeoutMs });
    if (result) {
      touchKey(cache, key, { value: result, ts: now() });
      trimCache(cache, cacheMaxEntries);
    }
    return result;
  }

  return { fetchAsDataUrl };
}

/**
 * The bot's avatar as a `data:` URL, the reference for a picture the persona
 * is in: a static 1024 px PNG, downloaded through `imageFetcher` under
 * `image.referenceMaxBytes` and `context.vision.fetchTimeoutMs` (`config` is
 * the caller's `hot.config`, read at the moment of use). Null when there is
 * no fetcher, no avatar URL, or the download fails; never throws. The one
 * copy for a turn's drawing (src/behavior/turn.js) and `/nep draw`.
 * @param {{ client: object, imageFetcher: { fetchAsDataUrl: Function }|null|undefined, config: object }} args
 * @returns {Promise<string|null>}
 */
export async function avatarReference({ client, imageFetcher, config }) {
  if (!imageFetcher || typeof client?.user?.displayAvatarURL !== 'function') return null;
  try {
    const url = client.user.displayAvatarURL({ extension: 'png', size: 1024, forceStatic: true });
    if (!url) return null;
    const downloaded = await imageFetcher.fetchAsDataUrl(url, {
      maxBytes: config?.image?.referenceMaxBytes,
      timeoutMs: config?.context?.vision?.fetchTimeoutMs,
    });
    return downloaded?.dataUrl || null;
  } catch {
    return null;
  }
}
