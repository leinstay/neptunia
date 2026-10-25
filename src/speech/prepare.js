// The preparation pass of a voice message: her text goes through the analyzer once
// (prompts/speech-prepare.md) to get dropped letters back, stress marks on ambiguous words and
// her bracketed directions as short audio tags. The pass may add marks and rewrite what sits in
// brackets, never touch a word: `sameWords` compares the answer with the original and any
// difference is a failed pass (`prepared: false`, the original returned) and the caller fails the
// voice message instead of speaking the original (nothing rewrites her speech after the fact).
//
// Logs carry the reason a pass was dropped, never the text.

import { log } from '../log.js';

/** The role the pass goes out on and the purpose its usage line carries. */
export const PREPARE_ROLE = 'analyzer';
export const PREPARE_PURPOSE = 'speech';

/**
 * A text reduced to its words: decomposed, every combining mark removed (stress marks, a
 * diaeresis, a breve), every `[...]` direction replaced by `[]`, whitespace collapsed.
 * @param {string} text
 * @returns {string}
 */
function wordsOf(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\[[^\]]*\]/g, '[]')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether two texts differ only in marks and bracketed directions. Pure.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameWords(a, b) {
  return wordsOf(a) === wordsOf(b);
}

const isAbort = (err) => err?.name === 'AbortError' || err?.name === 'TimeoutError';

/**
 * Prepare `text` for synthesis. Never throws: any failure returns the original.
 * @param {object} args
 * @param {string} args.text
 * @param {(messages: object[], options: object) => Promise<{ text?: string }>} args.complete  The llm client's `complete`.
 * @param {string} args.prompt         prompts/speech-prepare.md.
 * @param {string} [args.model]        The analyzer's model, from `roleModel`.
 * @param {number} [args.maxOutputTokens]
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{ text: string, prepared: boolean, reason?: 'no-prompt'|'error'|'timeout'|'empty'|'mismatch' }>}
 */
export async function prepareSpeech({ text, complete, prompt, model, maxOutputTokens, timeoutMs }) {
  const original = String(text ?? '');
  if (typeof prompt !== 'string' || prompt.trim() === '' || typeof complete !== 'function') return { text: original, prepared: false, reason: 'no-prompt' };
  let answer;
  try {
    const result = await complete(
      [
        { role: 'system', content: prompt },
        { role: 'user', content: original },
      ],
      { ...(model ? { model } : {}), role: PREPARE_ROLE, purpose: PREPARE_PURPOSE, temperature: 0, maxOutputTokens, timeoutMs, skipCalibration: true },
    );
    answer = typeof result?.text === 'string' ? result.text.trim() : '';
  } catch (err) {
    const reason = isAbort(err) ? 'timeout' : 'error';
    log.warn('speech: prepare failed', { reason, status: err?.statusCode ?? null });
    return { text: original, prepared: false, reason };
  }
  if (!answer) {
    log.warn('speech: prepare dropped', { reason: 'empty' });
    return { text: original, prepared: false, reason: 'empty' };
  }
  if (!sameWords(answer, original)) {
    log.warn('speech: prepare dropped', { reason: 'mismatch' });
    return { text: original, prepared: false, reason: 'mismatch' };
  }
  return { text: answer, prepared: true };
}
