// OpenRouter's speech endpoint (`POST /api/v1/audio/speech`) for the persona's voice messages: one
// request per message, no retry (a synthesis that was answered may have been billed). The model is
// the `speech` role's (`models.base.speech`), the voice `speech.voice`, the key the one
// `llm.keyByRole.speech` names (the main key without one), and the provider object is derived
// exactly as a chat request derives it from `llm.providerByModel`.
//
// Logs carry the model, the character count, the estimated cost and failure reasons -- never the
// text (it is her words and may quote members).

import { errorFields } from '../error-fields.ts';
import { log } from '../log.ts';
import { objOf } from '../tools/types.ts';
import { apiUrl, openRouterHeaders, providerBodyOf, resolveProvider, roleApiKey } from '../llm/openrouter.ts';
import { roleModel } from '../llm/roles.ts';
import type { KeyOf } from '../keys/ring.ts';

/** The role a synthesis routes and is keyed as: `"<prefix>@speech"` keys of `llm.providerByModel` apply to it. */
export const SPEECH_ROLE = 'speech';

/** A synthesis that was refused or failed; `reason` is 'not-configured' | 'timeout' | 'http' | 'empty' | 'error'. */
export class SpeechSynthError extends Error {
  reason: 'not-configured' | 'timeout' | 'http' | 'empty' | 'error';
  statusCode: number | null;

  constructor(
    reason: 'not-configured' | 'timeout' | 'http' | 'empty' | 'error',
    message?: string,
    { statusCode = null, cause }: { statusCode?: number | null; cause?: unknown } = {}
  ) {
    super(message ?? `speech synthesis failed (${reason})`, cause === undefined ? undefined : { cause });
    this.name = 'SpeechSynthError';
    this.reason = reason;
    this.statusCode = statusCode;
  }
}

const isAbort = (err: unknown): boolean => {
  const { name } = errorFields(err);
  return name === 'AbortError' || name === 'TimeoutError';
};

/**
 * The estimated cost of `chars` characters of speech, in USD: `chars * speech.usdPerMillionChars / 1e6`.
 * @param config The live config.
 */
export function speechCostOf(chars: number, config: unknown): number {
  const rate = Number(objOf(objOf(config).speech).usdPerMillionChars);
  return Number.isFinite(rate) && rate >= 0 && Number.isFinite(chars) ? (chars * rate) / 1e6 : 0;
}

/**
 * Synthesize `text` to mp3. Settings are read from the live config at the moment of use.
 * @param args.env The parsed `.env`, for `llm.keyByRole`.
 * @param args.mainKey The main OpenRouter key.
 * @param args.model The core model's id when the call is routed to it; null for the speech role's own.
 */
export async function synthesizeSpeech({
  text,
  getConfig,
  env = {},
  mainKey,
  keyOf = () => null,
  fetchImpl = fetch,
  now = () => Date.now(),
  model: given = null,
}: {
  text: string;
  getConfig: () => unknown;
  env?: Record<string, string | undefined>;
  mainKey: string;
  /** The key of the key store; null while there is no `keys.json`, then `.env` serves. */
  keyOf?: KeyOf;
  fetchImpl?: typeof fetch;
  now?: () => number;
  model?: string | null;
}): Promise<{ mp3: Buffer; ms: number; model: string; cost: number }> {
  const config = getConfig();
  const model = given ?? roleModel(config, SPEECH_ROLE);
  const speech = objOf(objOf(config).speech);
  const llm = objOf(objOf(config).llm);
  const voice = speech.voice;
  if (!model || typeof voice !== 'string' || !voice)
    throw new SpeechSynthError('not-configured', 'no voice model or voice configured');
  const provider = resolveProvider(model, {
    byModel: llm.providerByModel,
    fallback: llm.provider,
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
    typeof speech.timeoutMs === 'number' && Number.isFinite(speech.timeoutMs) && speech.timeoutMs > 0
      ? speech.timeoutMs
      : 60000;
  const chars = Array.from(text).length;
  const startedAt = now();
  log.info('speech: request', {
    model,
    voice,
    chars,
    provider: provider ? Object.keys(objOf(providerBodyOf(provider))) : null,
  });

  const fail = (error: SpeechSynthError): SpeechSynthError => {
    log.warn('speech: failed', { model, reason: error.reason, status: error.statusCode, chars });
    return error;
  };
  let response: Response;
  try {
    response = await fetchImpl(apiUrl(llm.baseUrl, 'audio/speech'), {
      method: 'POST',
      headers: openRouterHeaders(keyOf(SPEECH_ROLE) ?? roleApiKey(config, env, SPEECH_ROLE, mainKey)),
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
