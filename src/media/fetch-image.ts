// Downloads a picture so it can be inlined into an LLM request as a
// `data:` URL, because a platform's media host may refuse the provider's own
// image fetcher while our server fetches the very same URL fine (the hosts
// that do are named in the interface package). Used by src/behavior/turn.js
// (a live vision request) and
// src/memory/describe.ts (the media describer), so none of them ever hands
// the provider a platform URL to fetch itself.
//
// A tiny in-memory LRU (~50 entries, ~10 min) avoids re-downloading the same
// picture attached on consecutive turns, keyed by the URL WITHOUT its query
// string: a platform's signed query is a signature that
// rotates between fetches of the very same file, so keying on the full URL
// would never hit. Only successful downloads are cached: a failure is worth
// retrying on the next turn, in case it was a transient network blip.
//
// Every log line carries the host and path only (a signed media address's
// query string is a signature, never logged, not even truncated)
// and a thrown error's code or class name, never its message (which may
// quote the whole URL).

import { errorFields } from '../error-fields.ts';
import { log } from '../log.ts';
import { bareContentType, safeLocation } from './video-sites.ts';

/** A downloaded picture inlined as a `data:` URL. */
export type FetchedImage = { dataUrl: string; bytes: number; contentType: string };

/**
 * Why a download failed, by the codes a GIF's and a video's misses use: `download` for a fault, a refused status or
 * type and a failed body read, `timeout`, `size` for a declared or read body over `maxBytes`.
 */
export type ImageMissReason = 'download' | 'timeout' | 'size';

/** A download's limits, and `onMiss`, told the reason when the download fails. */
type FetchOptions = { maxBytes: number; timeoutMs: number; onMiss?: (reason: ImageMissReason) => void };

/** The code or class name of a thrown error, null when it has neither: never its message. */
function codeOf(err: unknown): unknown {
  const fields = errorFields(err);
  return fields.code ?? fields.name ?? null;
}

const ALLOWED_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const DEFAULT_CACHE_MAX_ENTRIES = 50;
const DEFAULT_CACHE_TTL_MS = 10 * 60_000;
// Production values, config cut of 2026-10-31.
/** The largest picture downloaded for a caption, in bytes. */
export const VISION_MAX_BYTES = 1500000;
/** The largest reference picture a drawing downloads, in bytes. */
export const REFERENCE_MAX_BYTES = 4000000;

/** The URL without its query string : a stable cache key across a signed address's rotating query. */
function cacheKeyFor(url: string): string {
  try {
    const parsed = new URL(String(url));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url);
  }
}

/** Move `key` to the end of `cache` (most-recently-used), inserting it if new. */
function touchKey<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, value);
}

/** Drop the oldest entries once `cache` holds more than `maxEntries`. */
function trimCache(cache: Map<string, unknown>, maxEntries: number): void {
  const overflow = cache.size - maxEntries;
  if (overflow <= 0) return;
  const it = cache.keys();
  for (let i = 0; i < overflow; i += 1) {
    const oldest = it.next();
    if (!oldest.done) cache.delete(oldest.value);
  }
}

/**
 * @param deps.cacheMaxEntries Test hook; production keeps the default (~50).
 * @param deps.cacheTtlMs Test hook; production keeps the default (~10 min).
 */
export function createImageFetcher({
  fetchImpl = fetch,
  now = Date.now,
  cacheMaxEntries = DEFAULT_CACHE_MAX_ENTRIES,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
}: { fetchImpl?: typeof fetch; now?: () => number; cacheMaxEntries?: number; cacheTtlMs?: number } = {}): {
  fetchAsDataUrl: (url: string, options: FetchOptions) => Promise<FetchedImage | null>;
} {
  const cache = new Map<string, { value: FetchedImage; ts: number }>(); // cacheKeyFor(url) -> { value, ts }

  async function download(url: string, { maxBytes, timeoutMs, onMiss }: FetchOptions): Promise<FetchedImage | null> {
    const location = safeLocation(url);
    const miss = (reason: ImageMissReason): null => {
      onMiss?.(reason);
      return null;
    };
    let response;
    try {
      response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      log.warn('fetch-image: download failed', { location, code: codeOf(err) });
      return miss(err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'download');
    }

    if (!response.ok) {
      log.warn('fetch-image: non-OK response', { location, status: response.status });
      return miss('download');
    }

    const contentType = bareContentType(response.headers?.get?.('content-type'));
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      log.warn('fetch-image: unsupported content type', { location, contentType });
      return miss('download');
    }

    const declaredSize = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
      log.warn('fetch-image: declared size exceeds the limit', { location, declaredSize, maxBytes });
      return miss('size');
    }

    let buffer;
    try {
      buffer = Buffer.from(await response.arrayBuffer());
    } catch (err) {
      log.warn('fetch-image: reading the body failed', { location, code: codeOf(err) });
      return miss('download');
    }

    if (buffer.byteLength > maxBytes) {
      log.warn('fetch-image: body exceeds the limit', { location, bytes: buffer.byteLength, maxBytes });
      return miss('size');
    }

    return {
      dataUrl: `data:${contentType};base64,${buffer.toString('base64')}`,
      bytes: buffer.byteLength,
      contentType,
    };
  }

  /**
   * Download `url` and return it inlined as a `data:` URL, or `null` on any
   * failure (bad content type, oversized, timeout, network/HTTP error), its
   * reason told to `options.onMiss` -- never throws. A repeat call for the same picture (same URL ignoring its
   * query string) within `cacheTtlMs` of a SUCCESSFUL download is served from
   * cache, no second request.
   */
  async function fetchAsDataUrl(url: string, options: FetchOptions): Promise<FetchedImage | null> {
    const key = cacheKeyFor(url);
    const cached = cache.get(key);
    if (cached && now() - cached.ts < cacheTtlMs) {
      touchKey(cache, key, cached);
      return cached.value;
    }

    const result = await download(url, options);
    if (result) {
      touchKey(cache, key, { value: result, ts: now() });
      trimCache(cache, cacheMaxEntries);
    }
    return result;
  }

  return { fetchAsDataUrl };
}
