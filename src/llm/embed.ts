// OpenRouter embeddings client on the built-in fetch: a list of texts in, one unit-length
// Float32Array per text out, for search by meaning. It goes out on the `embedding` model role
// `embedding` and keeps every rail of the chat client (src/llm/openrouter.ts): the token
// cap per request, the shared daily request count (`llm.maxRequestsPerDay`, the same counter the
// chat requests spend), the analyzer timeout, the same retries and the same transport bits (the
// key of the model role, base URL, provider routing by model and role). A request logs one `llm: usage` line with counts
// and cost, never the texts.

import { estimateTokens } from './tokens.ts';
import {
  RETRY_STATUS,
  TokenLimitError,
  apiUrl,
  assertByok,
  backoffMs,
  countLlmRequest,
  openRouterHeaders,
  providerBodyOf,
  resolveProvider,
  sleep,
} from './openrouter.ts';
import { roleModel } from './roles.ts';
import type { KeyOf } from '../keys/ring.ts';
import { errorFields } from '../error-fields.ts';
import { log } from '../log.ts';
import { objOf } from '../tools/types.ts';

/** The model role an embedding request goes out on: `/nep model`, `llm.providerByModel` keys `"<prefix>@embedding"`. */
export const EMBED_ROLE = 'embedding';

/** The options of one `embed` call. */
export type EmbedOptions = {
  config: unknown;
  purpose?: string;
  origin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  countAgainstDailyCap?: boolean;
};

/** `embed.dimensions` when it is missing or invalid: config.json's value. */
const DIMENSIONS_FALLBACK = 1024;
/** `llm.analyzerTimeoutMs` when it is missing: config.json's value. */
const ANALYZER_TIMEOUT_MS_FALLBACK = 30000;

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const stringOrNull = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/**
 * `vector` scaled to unit length as a Float32Array (a zero vector stays zero), or null when it is
 * not a non-empty array of finite numbers. Unit length makes a dot product the cosine similarity.
 */
export function normalizeVector(vector: unknown): Float32Array | null {
  if (!Array.isArray(vector) || vector.length === 0) return null;
  if (!vector.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  const out = new Float32Array(vector.length);
  if (norm === 0) return out;
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / norm;
  return out;
}

/** `embed.dimensions` of the live config: a positive integer, else config.json's 1024. */
function dimensionsOf(config: unknown): number {
  const value = objOf(objOf(config).embed).dimensions;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : DIMENSIONS_FALLBACK;
}

/** The error of a non-ok answer, as the chat client builds it: `.statusCode`, the full body on `.body`. */
async function httpErrorOf(response: Response): Promise<Error & { statusCode: number; body: string }> {
  const rawBody = await response.text();
  return Object.assign(new Error(`OpenRouter HTTP ${response.status}: ${rawBody.slice(0, 500)}`), {
    statusCode: response.status,
    body: rawBody,
  });
}

/** The vectors of a 200's body in input order, each normalised; throws when they do not match the inputs. */
function vectorsOf(json: unknown, count: number): Array<Float32Array> {
  const given = objOf(json).data;
  const data: Array<unknown> = Array.isArray(given) ? [...(given as Array<unknown>)] : [];
  data.sort((a, b) => (numberOrNull(objOf(a).index) ?? 0) - (numberOrNull(objOf(b).index) ?? 0));
  const vectors = data.map((item) => normalizeVector(objOf(item).embedding));
  const found = vectors.filter((vector) => vector !== null);
  if (vectors.length !== count || found.length !== vectors.length) {
    throw new Error(
      `OpenRouter embeddings: expected ${count} vectors, got ${vectors.filter(Boolean).length} valid of ${vectors.length}`
    );
  }
  return found;
}

/**
 * @param deps.apiKey The one key of an embedder with no key store (a script's).
 * @param deps.keyOf The key of the key store (src/keys/ring.ts#KeyOf); null leaves the request on `apiKey`.
 * @param deps.state Persistent state with the daily request counter.
 * @param deps.now Clock in ms: the day of the counter, the logged duration.
 * @param deps.sleepImpl The backoff wait between retries.
 */
export function createEmbedder({
  apiKey,
  keyOf = () => null,
  state,
  fetchImpl = fetch,
  now = Date.now,
  sleepImpl = sleep,
}: {
  apiKey: string;
  keyOf?: KeyOf;
  state: { data: object; markDirty: () => void };
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleepImpl?: (ms: number) => Promise<void>;
}): { embed: (texts: unknown, options: unknown) => Promise<Array<Float32Array>> } {
  /** The key of the embedding role: the key store's, else `apiKey`. */
  const requestKeyOf = (): string => keyOf(EMBED_ROLE) ?? apiKey;

  /**
   * Embed `texts` (non-empty strings; an empty list returns [] and sends nothing) in one request.
   * The model is `roleModel(config, 'embedding', purpose)` (a
   * `models.byPurpose` entry, else `models.base.embedding`, else its default); no model throws before any request.
   * Body: `{ model, input, dimensions }` (`embed.dimensions`, default 1024) plus the provider
   * routing `resolveProvider` picks for the model and the model role (without its `byok` mark, see
   * `providerBodyOf`). Rails, in order, before anything
   * is sent: the token cap (`llm.maxRequestTokens`, the inputs' raw estimate, a `TokenLimitError`)
   * and the daily request cap (counted once per call, retries included, a `DailyCapError`;
   * `countAgainstDailyCap: false` for the status probe only, never refused by it). Each attempt is
   * cut at `timeoutMs` (default `llm.analyzerTimeoutMs`); a network failure, a timeout or a status in
   * `RETRY_STATUS` is retried up to `llm.retries` times after `backoffMs` (`llm: retry`), an
   * external `signal` abort never is. A 200 with an error body or the wrong number of vectors is
   * thrown, never retried. So is a 200 OpenRouter served from its own capacity on a route marked
   * `byok: true` (a `NotByokError` after a `llm: not byok` line, see `assertByok`).
   * @param options.config The whole live config, read at the moment of use.
   * @param options.purpose What the vectors are for, a kebab-case code; logged only.
   * @param options.origin Where the call comes from when not live traffic (`status`); logged only.
   */
  async function embed(given: unknown, asked: unknown): Promise<Array<Float32Array>> {
    const { config, purpose, origin, signal, timeoutMs, countAgainstDailyCap = true } = asked as EmbedOptions;
    if (!Array.isArray(given) || !given.every((text) => typeof text === 'string' && text)) {
      throw new TypeError('embed: texts must be non-empty strings');
    }
    // Every text was checked to be a non-empty string above.
    const texts = given as Array<string>;
    if (texts.length === 0) return [];
    const cfg = objOf(objOf(config).llm);
    const model = roleModel(config, EMBED_ROLE, purpose);
    if (!model) throw new Error('embed: no embedding model configured (models.base.embedding)');

    const estimated = texts.reduce((sum, text) => sum + estimateTokens(text), 0);
    const cap = cfg.maxRequestTokens;
    if (typeof cap !== 'number' || !Number.isFinite(cap) || estimated > cap) {
      const err = new TokenLimitError(`embedding request estimated at ${estimated} tokens, cap is ${String(cap)}`);
      throw Object.assign(err, { key: 'llm.maxRequestTokens', used: estimated, cap });
    }
    if (signal?.aborted) throw signal.reason ?? new Error('request aborted');
    if (countAgainstDailyCap !== false) countLlmRequest(state, cfg.maxRequestsPerDay, now());

    const dimensions = dimensionsOf(config);
    const body: { model: string; input: Array<string>; dimensions: number; provider?: object } = {
      model,
      input: texts,
      dimensions,
    };
    const provider = resolveProvider(model, { byModel: cfg.providerByModel, fallback: cfg.provider, role: EMBED_ROLE });
    if (provider) body.provider = providerBodyOf(provider);
    const analyzerMs = typeof cfg.analyzerTimeoutMs === 'number' ? cfg.analyzerTimeoutMs : ANALYZER_TIMEOUT_MS_FALLBACK;
    const attemptMs = timeoutMs ?? analyzerMs;
    const retries =
      typeof cfg.retries === 'number' && Number.isInteger(cfg.retries) && cfg.retries > 0 ? cfg.retries : 0;
    const requestKey = requestKeyOf();
    const startedAt = now();

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) {
        log.warn('llm: retry', {
          role: EMBED_ROLE,
          attempt,
          status: errorFields(lastError).statusCode ?? null,
          name: errorFields(lastError).name ?? null,
        });
        await sleepImpl(backoffMs(attempt));
      }
      if (signal?.aborted) throw lastError ?? signal.reason ?? new Error('request aborted');
      let response: Response;
      try {
        const timeout = AbortSignal.timeout(attemptMs);
        response = await fetchImpl(apiUrl(cfg.baseUrl, 'embeddings'), {
          method: 'POST',
          headers: openRouterHeaders(requestKey),
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
      const json = objOf(await response.json());
      if (json.error) throw new Error(`OpenRouter error: ${JSON.stringify(json.error).slice(0, 500)}`);
      const vectors = vectorsOf(json, texts.length);
      const usage = objOf(json.usage);
      const elapsed = now() - startedAt;
      const usageFields = {
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
      };
      log.info('llm: usage', usageFields);
      // An answer OpenRouter served from its own capacity on a route marked `byok: true` is
      // thrown here, after the loop's last send: it is never retried.
      assertByok(provider, usage, usageFields);
      return vectors;
    }
    throw lastError;
  }

  return { embed };
}
