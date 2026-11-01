// OpenRouter Images API client for the persona's drawings. An unsupported model family is refused before anything is
// sent.
//
// Logs carry the model, counts, cost and failure reasons -- never the prompt
// (it may quote members).

import { log } from '../log.js';
import { isPlainObject } from '../config.js';
import {
  NotByokError,
  RETRY_STATUS,
  apiUrl,
  assertByok,
  backoffMs,
  openRouterHeaders,
  providerBodyOf,
  resolveProvider,
  sleep,
} from './openrouter.js';
import { roleModel } from './roles.js';

const MODERATION_STATUS = new Set([400, 403]);
const MODERATION_MARKERS = /moderation|content_policy|safety/i;

/** The model role a generation routes as: `"<prefix>@drawing"` keys of `llm.providerByModel` apply to it. */
export const IMAGE_ROLE = 'drawing';

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

/** `models.base.drawing` belongs to no supported family; refused before any request or count. */
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

// The picture's form. Production values, config cut of 2026-10-31.
const OUTPUT_FORMAT = 'png';
const ASPECT_RATIO = 'auto';
const OPENAI_BACKGROUND = 'auto';

/**
 * The request body for one generation; `null`/undefined config values omit their fields.
 * `routing` is the generation's resolved route (see `generate`), read at the moment of use.
 */
function buildBody({ cfg, model, routing, family, prompt, reference }) {
  const body = { model, prompt };
  body.output_format = OUTPUT_FORMAT;
  // Google takes no `auto` ratio, so the field is left out for it.
  if (family !== 'google') body.aspect_ratio = ASPECT_RATIO;
  // Routing first (the `llm.providerByModel` entry for the model and the `drawing` role, see
  // `matchRoute`, else `image.provider`; without its `byok` mark, see `providerBodyOf`; copied,
  // never mutated), then the family's own provider options over it.
  const provider = routing ? { ...providerBodyOf(routing) } : {};
  if (family === 'openai') {
    const openai = cfg.openai ?? {};
    if (openai.quality != null) body.quality = openai.quality;
    body.background = OPENAI_BACKGROUND;
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
 * @param {string|(() => string)} deps.apiKey  The key, or a function giving it, read at each request
 *   (the key `llm.keyByRole.drawing` names, src/llm/openrouter.js#roleApiKey).
 * @param {() => object} deps.getConfig   Returns the live config (hot-reloaded).
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number} [deps.now]       Clock in ms.
 * @returns {{ generate: Function, familyOf: typeof familyOf }}
 */
export function createImageGen({ apiKey, getConfig, fetchImpl = fetch, now = () => Date.now() }) {
  /**
   * Generate one picture. `reference` is an optional data: URL sent as an
   * input reference; `model` is the drawing role's own unless the call is routed to the core model. Throws `UnsupportedImageModelError` before any request, `ImageGenError` after one.
   * @param {{ prompt: string, reference?: string|null, model?: string }} args
   * @returns {Promise<{ buffer: Buffer, mediaType: string, cost: number|null, usage: object|null, model: string, seconds: number }>}
   */
  async function generate({ prompt, reference = null, model = roleModel(getConfig(), 'drawing') }) {
    const cfg = getConfig().image ?? {};
    const baseUrl = getConfig().llm.baseUrl;
    const family = familyOf(model);
    if (!family) {
      log.warn('images: unsupported model', { model });
      throw new UnsupportedImageModelError(model);
    }
    // The route of this generation: its body's `provider` and, on the answer, its `byok` mark.
    const routing = resolveProvider(model, {
      byModel: getConfig().llm?.providerByModel,
      fallback: cfg.provider,
      role: IMAGE_ROLE,
    });
    const body = JSON.stringify(buildBody({ cfg, model, routing, family, prompt, reference }));
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
          headers: openRouterHeaders(typeof apiKey === 'function' ? apiKey() : apiKey),
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          const rawBody = await response.text().catch(() => '');
          const statusCode = response.status;
          if (MODERATION_STATUS.has(statusCode) && MODERATION_MARKERS.test(rawBody)) {
            throw fail(
              new ImageGenError('moderation', `image refused by moderation (HTTP ${statusCode})`, {
                statusCode,
                body: rawBody,
              }),
              attempt
            );
          }
          const error = new ImageGenError('error', `OpenRouter images HTTP ${statusCode}`, {
            statusCode,
            body: rawBody,
          });
          if (RETRY_STATUS.has(statusCode)) {
            lastError = error;
            continue;
          }
          throw fail(error, attempt);
        }
      } catch (err) {
        if (err instanceof ImageGenError) throw err; // already classified and logged, not retried
        if (isAbort(err)) {
          throw fail(
            new ImageGenError('timeout', `image generation timed out after ${timeoutMs} ms`, { cause: err }),
            attempt
          );
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
          throw fail(
            new ImageGenError('timeout', `image generation timed out after ${timeoutMs} ms`, { cause: err }),
            attempt
          );
        }
        throw fail(new ImageGenError('error', 'image response was not JSON', { cause: err }), attempt);
      }
      const item = Array.isArray(json?.data) ? json.data[0] : undefined;
      if (typeof item?.b64_json !== 'string' || !item.b64_json) {
        const reason = json?.error ? 'error' : 'empty';
        throw fail(
          new ImageGenError(
            reason,
            reason === 'empty' ? 'image response carried no picture' : 'OpenRouter images error'
          ),
          attempt
        );
      }
      const buffer = Buffer.from(item.b64_json, 'base64');
      const mediaType = item.media_type ?? `image/${OUTPUT_FORMAT}`;
      const cost = json.usage?.cost ?? null;
      const usage = json.usage ?? null;
      const seconds = Math.round((now() - started) / 100) / 10;
      const usageFields = {
        role: IMAGE_ROLE,
        model,
        provider: typeof json.provider === 'string' && json.provider ? json.provider : null,
        family,
        seconds,
        cost,
        bytes: buffer.length,
        reference: Boolean(reference),
      };
      log.info('images: generated', usageFields);
      // A picture OpenRouter served from its own capacity on a route marked `byok: true` was
      // billed already: never retried, it takes the ordinary error path of an answered request.
      try {
        assertByok(routing, isPlainObject(usage) ? usage : {}, usageFields);
      } catch (err) {
        if (!(err instanceof NotByokError)) throw err;
        throw fail(new ImageGenError('error', err.message, { cause: err }), attempt);
      }
      return { buffer, mediaType, cost, usage, model, seconds };
    }
    throw fail(lastError, attempt - 1);
  }

  return { generate, familyOf };
}
