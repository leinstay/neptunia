// OpenRouter Images API client for the persona's drawings. A picture is far
// more expensive than a chat request, so this module owns its own rails,
// separate from the chat client's: no more than `image.maxPerDay` generations
// per day for the instance and `image.maxPerUserPerDay` per member, both
// checked before the request and counted only when it is actually sent. An
// unsupported model family is refused before anything is counted or sent.
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
function buildBody({ cfg, byModel, family, prompt, reference }) {
  const body = { model: cfg.model, prompt };
  if (cfg.outputFormat != null) body.output_format = cfg.outputFormat;
  if (cfg.aspectRatio != null && !(family === 'google' && cfg.aspectRatio === 'auto')) {
    body.aspect_ratio = cfg.aspectRatio;
  }
  // Routing first (the `llm.providerByModel` entry for the model and the `image` role, see
  // `matchRoute`, else `image.provider`; copied, never mutated), then the family's own
  // provider options over it.
  const routing = resolveProvider(cfg.model, { byModel, fallback: cfg.provider, role: IMAGE_ROLE });
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
   * @param {{ prompt: string, reference?: string|null, userId?: string|null }} args
   * @returns {Promise<{ buffer: Buffer, mediaType: string, cost: number|null, usage: object|null, model: string, seconds: number }>}
   */
  async function generate({ prompt, reference = null, userId = null }) {
    const cfg = getConfig().image ?? {};
    const baseUrl = getConfig().llm.baseUrl;
    const model = cfg.model;
    const family = familyOf(model);
    if (!family) {
      log.warn('images: unsupported model', { model });
      throw new UnsupportedImageModelError(model);
    }
    try {
      countRequest(cfg, userId);
    } catch (err) {
      log.info('images: refused', { model, reason: err.reason });
      throw err;
    }

    const byModel = getConfig().llm?.providerByModel;
    const body = JSON.stringify(buildBody({ cfg, byModel, family, prompt, reference }));
    // Normalised so a negative, NaN or non-numeric value still sends one request.
    const retries = Math.max(0, Math.floor(Number(cfg.retries ?? 1)) || 0);
    const timeoutMs = cfg.timeoutMs ?? 120000;
    const started = now();

    // `attempt` is the loop index; the log counts attempts from 1.
    const fail = (error, attempt) => {
      log.warn('images: failed', { model, reason: error.reason, status: error.statusCode, attempt: attempt + 1 });
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
      log.info('images: generated', { model, family, seconds, cost, bytes: buffer.length, reference: Boolean(reference) });
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
