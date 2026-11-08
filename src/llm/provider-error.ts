// The provider's words of a refused model request, read from the body of OpenRouter's non-ok answer: its
// `error.message`, then the upstream provider's own text (`error.metadata.raw`) when there is one, cut to
// PROVIDER_ERROR_CHARS, and the upstream provider's name (`error.metadata.provider_name`). A body that is not an
// OpenRouter error object gives its own text, cut the same way. The client (src/llm/openrouter.ts) puts both on the
// error it throws and logs them on `llm: http error` for any status but 429, and the request archive
// (src/llm/archive.ts) keeps the words in `model_requests.error_text`. The words are what the provider said about the
// request, never the request: the client never adds the body it sent. They are cut because a provider may quote a part
// of the request back.

import { log } from '../log.ts';
import { objOf } from '../tools/types.ts';
import type { CompleteOptions, Llm } from './openrouter.ts';

/** How many characters of the provider's words a log line and a request record keep. */
export const PROVIDER_ERROR_CHARS = 300;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The provider's words and name in the body of a non-ok answer; `providerName` is null when the body names none. */
export function providerWordsOf(rawBody: string): { providerError: string; providerName: string | null } {
  const body = parsed(rawBody);
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  if (error === null) return { providerError: rawBody.slice(0, PROVIDER_ERROR_CHARS), providerName: null };
  const metadata = isRecord(error.metadata) ? error.metadata : {};
  const words = [textOrNull(error.message), textOrNull(metadata.raw)].filter((part) => part !== null);
  return {
    providerError: (words.length > 0 ? words.join(' | ') : JSON.stringify(error)).slice(0, PROVIDER_ERROR_CHARS),
    providerName: textOrNull(metadata.provider_name),
  };
}

/**
 * The fields of the `llm: http error` line for a thrown `err`, or null when it carries no provider words or is a 429: a
 * limit is logged by its codes alone (`llm: provider limit`, `llm: retry`), and its wording stays out of the journal.
 */
export function refusalOf(
  err: unknown,
  request: { role: unknown; purpose: unknown; model: unknown }
): Record<string, unknown> | null {
  if (!isRecord(err) || typeof err.providerError !== 'string' || err.statusCode === 429) return null;
  const providerName = typeof err.providerName === 'string' ? err.providerName : null;
  return { ...request, status: err.statusCode ?? null, providerName, providerError: err.providerError };
}

/**
 * `complete` that logs a non-ok answer ending the call once, after whatever retries and hedges were tried, as
 * `llm: http error` (role, purpose, the model the caller named, status, providerName and the provider's words, bounded;
 * never for a 429, see src/llm/provider-error.ts#refusalOf), and throws it on as it was.
 */
export function logRefusals(complete: Llm['complete']): Llm['complete'] {
  return async (given, asked = {}) => {
    try {
      return await complete(given, asked);
    } catch (err) {
      const { role, purpose, model } = objOf(asked) as CompleteOptions;
      const refusal = refusalOf(err, { role: role ?? null, purpose: purpose ?? null, model: model ?? null });
      if (refusal) log.warn('llm: http error', refusal);
      throw err;
    }
  };
}
