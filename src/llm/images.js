// OpenRouter Images API client for the persona's drawings. A picture is far
// more expensive than a chat request, so this module owns its own rails,
// separate from the chat client's: no more than `image.maxPerDay` generations
// per day for the instance and `image.maxPerUserPerDay` per member, both
// checked before the request and counted only when it is actually sent. An
// unsupported model family is refused before anything is counted or sent.
//
// The refine pass (`image.refine`, off by default) is a second generation on
// its own model with the first picture as its only reference; it is never
// counted against the caps, and any failure of it leaves the first picture to
// be posted (refinePicture).
//
// Logs carry the model, counts, cost and failure reasons -- never the prompt
// (it may quote members).

import { log } from '../log.js';
import { isPlainObject } from '../config.js';
import { bumpDaily, countToday, dailyCounter } from '../time.js';
import { RETRY_STATUS, apiUrl, backoffMs, dailyCapOf, openRouterHeaders, resolveProvider, sleep } from './openrouter.js';

const MODERATION_STATUS = new Set([400, 403]);
const MODERATION_MARKERS = /moderation|content_policy|safety/i;

/** The role a generation routes as: `"<prefix>@image"` keys of `llm.providerByModel` apply to it. */
export const IMAGE_ROLE = 'image';
/** The role the refine pass routes as: `"<prefix>@refine"` keys of `llm.providerByModel` apply to it. */
export const IMAGE_REFINE_ROLE = 'refine';
/** `image.refine.timeoutMs` / `image.refine.maxAspectError` when missing: config.json's values. */
const REFINE_TIMEOUT_MS = 120000;
const REFINE_MAX_ASPECT_ERROR = 0.01;
/** The state.json fields of the instance-wide daily picture counter. */
const IMAGE_DAILY = { dayKey: 'imageDay', countKey: 'imageCount' };
/** One member's slot of `state.data.imageUsers` (`{ day, counts }`) laid out as a counter pair, for a read. */
const MEMBER_DAILY = { dayKey: 'day', countKey: 'count' };

function isAbort(err) {
  return err?.name === 'AbortError' || err?.name === 'TimeoutError';
}

/** A generation that was sent and failed; `reason` is 'moderation' | 'timeout' | 'error' | 'empty'. */
export class ImageGenError extends Error {
  /**
   * @param {'moderation'|'timeout'|'error'|'empty'} reason
   * @param {string} [message]
   * @param {{ statusCode?: number|null, body?: string, cause?: unknown }} [extra]
   */
  constructor(reason, message, { statusCode = null, body, cause } = {}) {
    super(message ?? `image generation failed (${reason})`, cause === undefined ? undefined : { cause });
    this.name = 'ImageGenError';
    this.reason = reason;
    this.statusCode = statusCode;
    // Full provider error body for a caller that needs it; kept out of the
    // message so a logged error never echoes provider text.
    if (body !== undefined) this.body = body;
  }
}

/** A generation refused by a daily rail before any request; `reason` is 'daily' | 'userDaily'. */
export class ImageCapError extends Error {
  /**
   * @param {'daily'|'userDaily'} reason
   * @param {string} [message]
   */
  constructor(reason, message) {
    super(message ?? `daily image cap reached (${reason})`);
    this.name = 'ImageCapError';
    this.reason = reason;
  }
}

/** `image.model` belongs to no supported family; refused before any request or count. */
export class UnsupportedImageModelError extends Error {
  constructor(model) {
    super(`unsupported image model: ${model}`);
    this.name = 'UnsupportedImageModelError';
  }
}

/**
 * Which request mapping a model id uses, by its prefix.
 * @param {unknown} model
 * @returns {'openai'|'google'|null}
 */
export function familyOf(model) {
  if (typeof model !== 'string') return null;
  if (model.startsWith('openai/')) return 'openai';
  if (model.startsWith('google/')) return 'google';
  return null;
}

/**
 * The request body for one generation; `null`/undefined config values omit their fields.
 * `byModel` is `llm.providerByModel`, read by the caller at the moment of use.
 */
function buildBody({ cfg, model, fallback, role, byModel, family, prompt, reference }) {
  const body = { model, prompt };
  if (cfg.outputFormat != null) body.output_format = cfg.outputFormat;
  if (cfg.aspectRatio != null && !(family === 'google' && cfg.aspectRatio === 'auto')) {
    body.aspect_ratio = cfg.aspectRatio;
  }
  // Routing first (the `llm.providerByModel` entry for the model and the role, see
  // `matchRoute`, else the fallback: `image.provider`, or the refine pass's own; copied,
  // never mutated), then the family's own provider options over it.
  const routing = resolveProvider(model, { byModel, fallback, role });
  const provider = routing ? { ...routing } : {};
  if (family === 'openai') {
    const openai = cfg.openai ?? {};
    if (openai.quality != null) body.quality = openai.quality;
    if (openai.background != null) body.background = openai.background;
    if (openai.moderation != null) {
      const options = isPlainObject(provider.options) ? { ...provider.options } : {};
      const openaiOptions = isPlainObject(options.openai) ? { ...options.openai } : {};
      openaiOptions.moderation = openai.moderation;
      options.openai = openaiOptions;
      provider.options = options;
    }
  } else if (family === 'google') {
    const google = cfg.google ?? {};
    if (google.resolution != null) body.resolution = google.resolution;
  }
  if (typeof reference === 'string' && reference) {
    body.input_references = [{ type: 'image_url', image_url: { url: reference } }];
  }
  if (Object.keys(provider).length > 0) body.provider = provider;
  return body;
}

/**
 * @param {object} deps
 * @param {string} deps.apiKey
 * @param {() => object} deps.getConfig   Returns the live config (hot-reloaded).
 * @param {object} deps.state             Persistent state; `imageDay` / `imageCount` / `imageUsers` live on `state.data`.
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number} [deps.now]       Clock in ms, for the day rollover.
 * @returns {{ generate: Function, quota: Function, familyOf: typeof familyOf }}
 */
export function createImageGen({ apiKey, getConfig, state, fetchImpl = fetch, now = () => Date.now() }) {
  /**
   * Today's counters as read, without resetting anything (src/time.js#countToday): a count
   * stored for another day, or one that is not a finite number >= 0, reads as 0.
   */
  function readCounts(userId, nowMs) {
    const used = countToday(state.data, IMAGE_DAILY, nowMs);
    const users = state.data.imageUsers;
    const userUsed = userId == null ? 0 : countToday({ day: users?.day, count: users?.counts?.[userId] }, MEMBER_DAILY, nowMs);
    return { used, userUsed };
  }

  /** Both caps, read now; one that is not a finite number counts as 0 (src/llm/openrouter.js#dailyCapOf). */
  function caps(cfg) {
    return { cap: dailyCapOf(cfg.maxPerDay, 'image.maxPerDay'), userCap: dailyCapOf(cfg.maxPerUserPerDay, 'image.maxPerUserPerDay') };
  }

  /** Roll both counters over to today, refuse at a cap, then count this request. */
  function countRequest(cfg, userId) {
    const { cap, userCap } = caps(cfg);
    const nowMs = now();
    const { day, count: used } = dailyCounter(state.data, IMAGE_DAILY, nowMs);
    if (!isPlainObject(state.data.imageUsers) || state.data.imageUsers.day !== day || !isPlainObject(state.data.imageUsers.counts)) {
      state.data.imageUsers = { day, counts: {} };
    }
    const counts = state.data.imageUsers.counts;
    if (used >= cap) {
      const err = new ImageCapError('daily', `daily image cap reached (${cap})`);
      throw Object.assign(err, { key: 'image.maxPerDay', used, cap });
    }
    if (userId != null && (counts[userId] ?? 0) >= userCap) {
      const err = new ImageCapError('userDaily', `daily per-member image cap reached (${userCap})`);
      throw Object.assign(err, { key: 'image.maxPerUserPerDay', used: counts[userId] ?? 0, cap: userCap });
    }
    bumpDaily(state.data, IMAGE_DAILY, nowMs);
    if (userId != null) counts[userId] = (counts[userId] ?? 0) + 1;
    state.markDirty();
  }

  /**
   * Generate one picture. `reference` is an optional data: URL sent as an
   * input reference; `userId` (null for spontaneous turns and owner commands)
   * selects the per-member rail. Throws `UnsupportedImageModelError` or
   * `ImageCapError` before any request, `ImageGenError` after one.
   * `overrides` (the refine pass, see refinePicture) replaces `image.model`,
   * the fallback routing (`image.provider`; `null` sends none), `image.timeoutMs`
   * and the routing role (`image`); `counted: false` skips both daily rails.
   * The family options (`image.openai` / `image.google`) follow the model used.
   * @param {{ prompt: string, reference?: string|null, userId?: string|null }} args
   * @param {{ model?: string, provider?: object|null, timeoutMs?: number, role?: string, counted?: boolean }} [overrides]
   * @returns {Promise<{ buffer: Buffer, mediaType: string, cost: number|null, usage: object|null, model: string, seconds: number }>}
   */
  async function generate({ prompt, reference = null, userId = null }, overrides = {}) {
    const cfg = getConfig().image ?? {};
    const baseUrl = getConfig().llm.baseUrl;
    const model = overrides.model !== undefined ? overrides.model : cfg.model;
    const role = overrides.role ?? IMAGE_ROLE;
    const fallback = overrides.provider !== undefined ? overrides.provider : cfg.provider;
    const family = familyOf(model);
    if (!family) {
      log.warn('images: unsupported model', { model, role });
      throw new UnsupportedImageModelError(model);
    }
    if (overrides.counted !== false) {
      try {
        countRequest(cfg, userId);
      } catch (err) {
        log.info('images: refused', { model, reason: err.reason });
        throw err;
      }
    }

    const byModel = getConfig().llm?.providerByModel;
    const body = JSON.stringify(buildBody({ cfg, model, fallback, role, byModel, family, prompt, reference }));
    // Normalised so a negative, NaN or non-numeric value still sends one request.
    const retries = Math.max(0, Math.floor(Number(cfg.retries ?? 1)) || 0);
    const timeoutMs = overrides.timeoutMs ?? cfg.timeoutMs ?? 120000;
    const started = now();

    // `attempt` is the loop index; the log counts attempts from 1.
    const fail = (error, attempt) => {
      log.warn('images: failed', { model, role, reason: error.reason, status: error.statusCode, attempt: attempt + 1 });
      return error;
    };

    let lastError;
    let attempt = 0;
    for (; attempt <= retries; attempt += 1) {
      if (attempt > 0) await sleep(backoffMs(attempt));
      let response;
      let json;
      try {
        response = await fetchImpl(apiUrl(baseUrl, 'images'), {
          method: 'POST',
          headers: openRouterHeaders(apiKey),
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          const rawBody = await response.text().catch(() => '');
          const statusCode = response.status;
          if (MODERATION_STATUS.has(statusCode) && MODERATION_MARKERS.test(rawBody)) {
            throw fail(new ImageGenError('moderation', `image refused by moderation (HTTP ${statusCode})`, { statusCode, body: rawBody }), attempt);
          }
          const error = new ImageGenError('error', `OpenRouter images HTTP ${statusCode}`, { statusCode, body: rawBody });
          if (RETRY_STATUS.has(statusCode)) {
            lastError = error;
            continue;
          }
          throw fail(error, attempt);
        }
      } catch (err) {
        if (err instanceof ImageGenError) throw err; // already classified and logged, not retried
        if (isAbort(err)) {
          throw fail(new ImageGenError('timeout', `image generation timed out after ${timeoutMs} ms`, { cause: err }), attempt);
        }
        // A network failure is transient, like a 5xx: retried.
        lastError = new ImageGenError('error', 'image request failed', { cause: err });
        continue;
      }

      // A 200 was answered (and possibly billed): whatever goes wrong from here is not retried.
      try {
        json = await response.json();
      } catch (err) {
        if (isAbort(err)) {
          throw fail(new ImageGenError('timeout', `image generation timed out after ${timeoutMs} ms`, { cause: err }), attempt);
        }
        throw fail(new ImageGenError('error', 'image response was not JSON', { cause: err }), attempt);
      }
      const item = Array.isArray(json?.data) ? json.data[0] : undefined;
      if (typeof item?.b64_json !== 'string' || !item.b64_json) {
        const reason = json?.error ? 'error' : 'empty';
        throw fail(new ImageGenError(reason, reason === 'empty' ? 'image response carried no picture' : 'OpenRouter images error'), attempt);
      }
      const buffer = Buffer.from(item.b64_json, 'base64');
      const outputFormat = cfg.outputFormat ?? 'png';
      const mediaType = item.media_type ?? `image/${outputFormat === 'jpeg' ? 'jpeg' : outputFormat}`;
      const cost = json.usage?.cost ?? null;
      const usage = json.usage ?? null;
      const seconds = Math.round((now() - started) / 100) / 10;
      log.info('images: generated', { model, family, role, seconds, cost, bytes: buffer.length, reference: Boolean(reference) });
      return { buffer, mediaType, cost, usage, model, seconds };
    }
    throw fail(lastError, attempt - 1);
  }

  /**
   * Today's use of both rails, for the senses block and `/nep status`. Reads
   * only: yesterday's counters show as zero but are not reset here.
   * @param {{ userId?: string|null }} [args]
   * @returns {{ used: number, cap: number, userUsed: number, userCap: number, spent: boolean, userSpent: boolean }}
   */
  function quota({ userId = null } = {}) {
    const cfg = getConfig().image ?? {};
    const { used, userUsed } = readCounts(userId, now());
    const { cap, userCap } = caps(cfg);
    return {
      used,
      cap,
      userUsed,
      userCap,
      spent: used >= cap,
      userSpent: userId != null && userUsed >= userCap,
    };
  }

  return { generate, quota, familyOf };
}

// ---- the refine pass ---------------------------------------------------------

/** A JPEG start-of-frame marker (SOF0..SOF15 without DHT, JPG and DAC): it carries the size. */
function isJpegFrame(marker) {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** Width and height in a JPEG's first start-of-frame segment, or null. */
function jpegDimensions(buf) {
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    if (isJpegFrame(marker)) {
      if (i + 8 >= buf.length) return null;
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    const length = buf.readUInt16BE(i + 2);
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

/** Width and height of a WebP (`VP8 `, `VP8L` or `VP8X` first chunk), or null. */
function webpDimensions(buf) {
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8X' && buf.length >= 30) {
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  if (chunk === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ' && buf.length >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

/**
 * The pixel size a PNG, JPEG or WebP header declares, or null for anything
 * else (an unknown format, a cut header, a zero side). Pure; reads the header only.
 * @param {unknown} buffer
 * @returns {{ width: number, height: number }|null}
 */
export function imageDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  let dims = null;
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a && buffer.toString('latin1', 12, 16) === 'IHDR') {
    dims = { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  } else if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    dims = jpegDimensions(buffer);
  } else if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
    dims = webpDimensions(buffer);
  }
  return dims && dims.width > 0 && dims.height > 0 ? dims : null;
}

/**
 * Whether two pictures have the same aspect ratio within `maxError` (a relative
 * difference: 0.01 is one percent). True when either size is unknown (null):
 * a format the header reader does not know is not checked. A `maxError` that is
 * not a finite number >= 0 reads as 0.01, config.json's `image.refine.maxAspectError`. Pure.
 * @param {{ width: number, height: number }|null} a
 * @param {{ width: number, height: number }|null} b
 * @param {number} [maxError]
 * @returns {boolean}
 */
export function aspectWithin(a, b, maxError) {
  if (!a || !b) return true;
  const limit = typeof maxError === 'number' && Number.isFinite(maxError) && maxError >= 0 ? maxError : REFINE_MAX_ASPECT_ERROR;
  const ratioA = a.width / a.height;
  const ratioB = b.width / b.height;
  return Math.abs(ratioB / ratioA - 1) <= limit;
}

/**
 * Whether a picture gets the refine pass under `config` (the live config, read
 * by the caller now): `image.refine.enabled` is exactly true and the scope
 * allows it -- `all` (also any value other than `self`), or `self` only for a
 * picture the persona is in. Pure.
 * @param {object} config
 * @param {{ self: boolean }} picture
 * @returns {boolean}
 */
export function refineApplies(config, { self }) {
  const refine = config?.image?.refine;
  if (!isPlainObject(refine) || refine.enabled !== true) return false;
  return refine.scope === 'self' ? self === true : true;
}

/**
 * The refine pass over a finished first picture: one generation on
 * `image.refine.model` (`image.refine.provider` as the fallback routing,
 * `image.refine.timeoutMs`, role `refine`), with the first picture as its ONLY
 * reference and `prompt` (prompts/refine.md, filled by the caller) as the
 * prompt, never counted against the daily caps. The result is accepted when it
 * carries a picture whose aspect ratio matches the first one's within
 * `image.refine.maxAspectError`. Never throws: resolves `{ picture }` when
 * accepted, else `{ picture: null, reason }` -- `no-prompt` (an empty prompt,
 * nothing sent), `unsupported`, `moderation`, `timeout`, `error`, `empty`,
 * `aspect` -- and the caller posts the first picture. Logs `images: refined`
 * with counts and the outcome, never the prompt.
 * @param {{ images: { generate: Function }, config: object, prompt: string,
 *   picture: { buffer: Buffer, mediaType: string } }} args
 * @returns {Promise<{ picture: object|null, reason?: string }>}
 */
export async function refinePicture({ images, config, prompt, picture }) {
  const refine = isPlainObject(config?.image?.refine) ? config.image.refine : {};
  const model = refine.model;
  const family = familyOf(model);
  const declined = (reason, extra = {}) => {
    log.info('images: refined', { model: model ?? null, family, accepted: false, reason, ...extra });
    return { picture: null, reason };
  };
  if (typeof prompt !== 'string' || !prompt.trim()) return declined('no-prompt');

  const reference = `data:${picture.mediaType};base64,${picture.buffer.toString('base64')}`;
  let refined;
  try {
    refined = await images.generate(
      { prompt, reference, userId: null },
      { model, provider: refine.provider ?? null, timeoutMs: refine.timeoutMs ?? REFINE_TIMEOUT_MS, role: IMAGE_REFINE_ROLE, counted: false },
    );
  } catch (err) {
    if (err instanceof UnsupportedImageModelError) return declined('unsupported');
    if (err instanceof ImageGenError) return declined(err.reason);
    return declined('error');
  }
  const counts = { seconds: refined?.seconds ?? null, cost: refined?.cost ?? null, bytes: refined?.buffer?.length ?? 0 };
  if (!Buffer.isBuffer(refined?.buffer) || refined.buffer.length === 0) return declined('empty', counts);
  if (!aspectWithin(imageDimensions(picture.buffer), imageDimensions(refined.buffer), refine.maxAspectError)) {
    return declined('aspect', counts);
  }
  log.info('images: refined', { model: refined.model ?? model, family, ...counts, accepted: true });
  return { picture: refined };
}
