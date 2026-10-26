// OpenRouter's speech endpoint (`POST /api/v1/audio/speech`) for the persona's voice messages: one
// request per message, no retry (a synthesis that was answered may have been billed). The model is
// the `speech` role's (`models.base.speech`), the voice `speech.voice`, the key the one
// `llm.keyByRole.speech` names (the main key without one), and the provider object is derived
// exactly as a chat request derives it from `llm.providerByModel`.
//
// Logs carry the model, the character count, the estimated cost and failure reasons -- never the
// text (it is her words and may quote members).

import { log } from '../log.js';
import { apiUrl, openRouterHeaders, providerBodyOf, resolveProvider, roleApiKey } from '../llm/openrouter.js';
import { roleModel } from '../llm/roles.js';

/** The role a synthesis routes and is keyed as: `"<prefix>@speech"` keys of `llm.providerByModel` apply to it. */
export const SPEECH_ROLE = 'speech';

/** A synthesis that was refused or failed; `reason` is 'not-configured' | 'timeout' | 'http' | 'empty' | 'error'. */
export class SpeechSynthError extends Error {
  /**
   * @param {'not-configured'|'timeout'|'http'|'empty'|'error'} reason
   * @param {string} [message]
   * @param {{ statusCode?: number|null, cause?: unknown }} [extra]
   */
  constructor(reason, message, { statusCode = null, cause } = {}) {
    super(message ?? `speech synthesis failed (${reason})`, cause === undefined ? undefined : { cause });
    this.name = 'SpeechSynthError';
    this.reason = reason;
    this.statusCode = statusCode;
  }
}

const isAbort = (err) => err?.name === 'AbortError' || err?.name === 'TimeoutError';

/**
 * The estimated cost of `chars` characters of speech, in USD: `chars * speech.usdPerMillionChars / 1e6`.
 * @param {number} chars
 * @param {object} config  The live config.
 * @returns {number}
 */
export function speechCostOf(chars, config) {
  const rate = Number(config?.speech?.usdPerMillionChars);
  return Number.isFinite(rate) && rate >= 0 && Number.isFinite(chars) ? (chars * rate) / 1e6 : 0;
}

/**
 * Synthesize `text` to mp3. Settings are read from the live config at the moment of use.
 * @param {object} args
 * @param {string} args.text
 * @param {() => object} args.getConfig
 * @param {object} [args.env]          The parsed `.env`, for `llm.keyByRole`.
 * @param {string} args.mainKey        The main OpenRouter key.
 * @param {typeof fetch} [args.fetchImpl]
 * @param {() => number} [args.now]
 * @returns {Promise<{ mp3: Buffer, ms: number, model: string, cost: number }>}
 */
export async function synthesizeSpeech({
  text,
  getConfig,
  env = {},
  mainKey,
  fetchImpl = fetch,
  now = () => Date.now(),
}) {
  const config = getConfig();
  const model = roleModel(config, SPEECH_ROLE);
  const voice = config.speech?.voice;
  if (!model || typeof voice !== 'string' || !voice)
    throw new SpeechSynthError('not-configured', 'no voice model or voice configured');
  const provider = resolveProvider(model, {
    byModel: config.llm?.providerByModel,
    fallback: config.llm?.provider,
    role: SPEECH_ROLE,
  });
  const body = {
    model,
    input: text,
    voice,
    response_format: 'mp3',
    ...(provider ? { provider: providerBodyOf(provider) } : {}),
  };
  const timeoutMs =
    Number.isFinite(config.speech?.timeoutMs) && config.speech.timeoutMs > 0 ? config.speech.timeoutMs : 60000;
  const chars = Array.from(text).length;
  const startedAt = now();
  log.info('speech: request', {
    model,
    voice,
    chars,
    provider: provider ? Object.keys(providerBodyOf(provider)) : null,
  });

  const fail = (error) => {
    log.warn('speech: failed', { model, reason: error.reason, status: error.statusCode, chars });
    return error;
  };
  let response;
  try {
    response = await fetchImpl(apiUrl(config.llm.baseUrl, 'audio/speech'), {
      method: 'POST',
      headers: openRouterHeaders(roleApiKey(config, env, SPEECH_ROLE, mainKey)),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw fail(
        new SpeechSynthError('http', `OpenRouter speech HTTP ${response.status}`, { statusCode: response.status })
      );
    }
    const type = String(response.headers?.get?.('content-type') ?? '');
    const mp3 = Buffer.from(await response.arrayBuffer());
    if (type.includes('json') || mp3.length === 0) {
      throw fail(
        new SpeechSynthError(
          mp3.length === 0 ? 'empty' : 'error',
          mp3.length === 0 ? 'speech response carried no audio' : 'speech response was not audio'
        )
      );
    }
    const ms = now() - startedAt;
    const cost = speechCostOf(chars, config);
    log.info('speech: synthesized', { role: SPEECH_ROLE, model, chars, cost, bytes: mp3.length, ms });
    return { mp3, ms, model, cost };
  } catch (err) {
    if (err instanceof SpeechSynthError) throw err;
    if (isAbort(err))
      throw fail(new SpeechSynthError('timeout', `speech synthesis timed out after ${timeoutMs} ms`, { cause: err }));
    throw fail(new SpeechSynthError('error', 'speech request failed', { cause: err }));
  }
}
