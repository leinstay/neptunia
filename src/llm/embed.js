// OpenRouter embeddings client on the built-in fetch: a list of texts in, one unit-length
// Float32Array per text out, for search by meaning. It goes out on the helper role
// `classifier.embed` and keeps every rail of the chat client (src/llm/openrouter.js): the token
// cap per request, the shared daily request count (`llm.maxRequestsPerDay`, the same counter the
// chat requests spend), the helper timeout, the same retries and the same transport bits (key,
// base URL, provider routing by model and role). A request logs one `llm: usage` line with counts
// and cost, never the texts.

import { estimateTokens } from './tokens.js';
import {
  RETRY_STATUS,
  TokenLimitError,
  apiUrl,
  backoffMs,
  countLlmRequest,
  openRouterHeaders,
  resolveProvider,
  sleep,
} from './openrouter.js';
import { helperModel } from '../behavior/mention.js';
import { isPlainObject } from '../config.js';
import { log } from '../log.js';

/** The role an embedding request goes out on: `/nep model`, `llm.providerByModel` keys `"<prefix>@classifier.embed"`. */
export const EMBED_ROLE = 'classifier.embed';

/** `embed.dimensions` when it is missing or invalid: config.json's value. */
const DIMENSIONS_FALLBACK = 1024;
/** `llm.helperTimeoutMs` when it is missing: config.json's value. */
const HELPER_TIMEOUT_MS_FALLBACK = 30000;

const numberOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const stringOrNull = (value) => (typeof value === 'string' && value ? value : null);

/**
 * `vector` scaled to unit length as a Float32Array (a zero vector stays zero), or null when it is
 * not a non-empty array of finite numbers. Unit length makes a dot product the cosine similarity.
 * @param {unknown} vector
 * @returns {Float32Array|null}
 */
export function normalizeVector(vector) {
  if (!Array.isArray(vector) || vector.length === 0) return null;
  if (!vector.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  const out = new Float32Array(vector.length);
  if (norm === 0) return out;
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / norm;
  return out;
}

/** `embed.dimensions` of the live config: a positive integer, else config.json's 1024. */
function dimensionsOf(config) {
  const value = config?.embed?.dimensions;
  return Number.isInteger(value) && value > 0 ? value : DIMENSIONS_FALLBACK;
}

/** The error of a non-ok answer, as the chat client builds it: `.statusCode`, the full body on `.body`. */
async function httpErrorOf(response) {
  const rawBody = await response.text();
  return Object.assign(new Error(`OpenRouter HTTP ${response.status}: ${rawBody.slice(0, 500)}`), { statusCode: response.status, body: rawBody });
}

/** The vectors of a 200's body in input order, each normalised; throws when they do not match the inputs. */
function vectorsOf(json, count) {
  const data = Array.isArray(json?.data) ? [...json.data] : [];
  data.sort((a, b) => (numberOrNull(a?.index) ?? 0) - (numberOrNull(b?.index) ?? 0));
  const vectors = data.map((item) => normalizeVector(item?.embedding));
  if (vectors.length !== count || vectors.some((vector) => vector === null)) {
    throw new Error(`OpenRouter embeddings: expected ${count} vectors, got ${vectors.filter(Boolean).length} valid of ${vectors.length}`);
  }
  return vectors;
}

/**
 * @param {object} deps
 * @param {string} deps.apiKey
 * @param {{ data: object, markDirty: () => void }} deps.state  Persistent state with the daily request counter.
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number} [deps.now]                        Clock in ms: the day of the counter, the logged duration.
 * @param {(ms: number) => Promise<void>} [deps.sleepImpl] The backoff wait between retries.
 * @returns {{ embed: Function }}
 */
export function createEmbedder({ apiKey, state, fetchImpl = fetch, now = Date.now, sleepImpl = sleep }) {
  /**
   * Embed `texts` (non-empty strings; an empty list returns [] and sends nothing) in one request.
   * The model is `helperModel(config, { role: 'classifier.embed', purpose })` (a
   * `classifier.byPurpose` entry, else `classifier.embed`); none set throws before any request.
   * Body: `{ model, input, dimensions }` (`embed.dimensions`, default 1024) plus the provider
   * routing `resolveProvider` picks for the model and the role. Rails, in order, before anything
   * is sent: the token cap (`llm.maxRequestTokens`, the inputs' raw estimate, a `TokenLimitError`)
   * and the daily request cap (counted once per call, retries included, a `DailyCapError`;
   * `countAgainstDailyCap: false` for the status probe only, never refused by it). Each attempt is
   * cut at `timeoutMs` (default `llm.helperTimeoutMs`); a network failure, a timeout or a status in
   * `RETRY_STATUS` is retried up to `llm.retries` times after `backoffMs` (`llm: retry`), an
   * external `signal` abort never is. A 200 with an error body or the wrong number of vectors is
   * thrown, never retried.
   * @param {string[]} texts
   * @param {object} options
   * @param {object} options.config              The whole live config, read at the moment of use.
   * @param {string} [options.purpose]           What the vectors are for, a kebab-case code; logged only.
   * @param {string} [options.origin]            Where the call comes from when not live traffic (`status`); logged only.
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.timeoutMs]
   * @param {boolean} [options.countAgainstDailyCap]
   * @returns {Promise<Float32Array[]>}
   */
  async function embed(texts, { config, purpose, origin, signal, timeoutMs, countAgainstDailyCap = true } = {}) {
    if (!Array.isArray(texts) || !texts.every((text) => typeof text === 'string' && text)) {
      throw new TypeError('embed: texts must be non-empty strings');
    }
    if (texts.length === 0) return [];
    const cfg = config?.llm ?? {};
    const model = helperModel(config, { role: EMBED_ROLE, purpose });
    if (!model) throw new Error('embed: no embedding model configured (classifier.embed)');

    const estimated = texts.reduce((sum, text) => sum + estimateTokens(text), 0);
    if (estimated > cfg.maxRequestTokens || !Number.isFinite(cfg.maxRequestTokens)) {
      const err = new TokenLimitError(`embedding request estimated at ${estimated} tokens, cap is ${cfg.maxRequestTokens}`);
      throw Object.assign(err, { key: 'llm.maxRequestTokens', used: estimated, cap: cfg.maxRequestTokens });
    }
    if (signal?.aborted) throw signal.reason ?? new Error('request aborted');
    if (countAgainstDailyCap !== false) countLlmRequest(state, cfg.maxRequestsPerDay, now());

    const dimensions = dimensionsOf(config);
    const body = { model, input: texts, dimensions };
    const provider = resolveProvider(model, { byModel: cfg.providerByModel, fallback: cfg.provider, role: EMBED_ROLE });
    if (provider) body.provider = provider;
    const attemptMs = timeoutMs ?? cfg.helperTimeoutMs ?? HELPER_TIMEOUT_MS_FALLBACK;
    const retries = Number.isInteger(cfg.retries) && cfg.retries > 0 ? cfg.retries : 0;
    const startedAt = now();

    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) {
        log.warn('llm: retry', { role: EMBED_ROLE, attempt, status: lastError?.statusCode ?? null, name: lastError?.name ?? null });
        await sleepImpl(backoffMs(attempt));
      }
      if (signal?.aborted) throw lastError ?? signal.reason ?? new Error('request aborted');
      let response;
      try {
        const timeout = AbortSignal.timeout(attemptMs);
        response = await fetchImpl(apiUrl(cfg.baseUrl, 'embeddings'), {
          method: 'POST',
          headers: openRouterHeaders(apiKey),
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        lastError = err; // a network failure or a timed-out attempt: retried
        continue;
      }
      if (!response.ok) {
        const error = await httpErrorOf(response);
        if (!RETRY_STATUS.has(response.status)) throw error;
        lastError = error;
        continue;
      }
      // A 200 may be billed: whatever goes wrong from here is thrown, never retried.
      const json = await response.json();
      if (json?.error) throw new Error(`OpenRouter error: ${JSON.stringify(json.error).slice(0, 500)}`);
      const vectors = vectorsOf(json, texts.length);
      const usage = isPlainObject(json.usage) ? json.usage : {};
      const elapsed = now() - startedAt;
      log.info('llm: usage', {
        role: EMBED_ROLE,
        purpose: stringOrNull(purpose),
        origin: stringOrNull(origin),
        model: stringOrNull(model),
        provider: stringOrNull(json.provider),
        promptTokens: numberOrNull(usage.prompt_tokens),
        cost: numberOrNull(usage.cost),
        byok: typeof usage.is_byok === 'boolean' ? usage.is_byok : null,
        id: stringOrNull(json.id),
        inputs: texts.length,
        dimensions,
        ms: Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : null,
      });
      return vectors;
    }
    throw lastError;
  }

  return { embed };
}
