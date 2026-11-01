// The preparation pass of a voice message: her text goes through the analyzer once
// (prompts/speech-prepare.md) to get dropped letters back, stress marks on ambiguous words and
// her bracketed directions as short audio tags. The pass may add marks and rewrite what sits in
// brackets, never touch a word: `sameWords` compares the answer with the original and any
// difference is a failed pass (`prepared: false`, the original returned) and the caller fails the
// voice message instead of speaking the original (nothing rewrites her speech after the fact).
//
// Logs carry the reason a pass was dropped, never the text.

import { errorFields } from '../error-fields.ts';
import { log } from '../log.js';

/** The role the pass goes out on and the purpose its usage line carries. */
export const PREPARE_ROLE = 'analyzer';
export const PREPARE_PURPOSE = 'speech';

/**
 * A text reduced to its words: decomposed, every combining mark removed (stress marks, a
 * diaeresis, a breve), every `[...]` direction replaced by `[]`, whitespace collapsed.
 */
function wordsOf(text: string): string {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\[[^\]]*\]/g, '[]')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whether two texts differ only in marks and bracketed directions. Pure. */
export function sameWords(a: string, b: string): boolean {
  return wordsOf(a) === wordsOf(b);
}

const isAbort = (err: unknown): boolean => {
  const { name } = errorFields(err);
  return name === 'AbortError' || name === 'TimeoutError';
};

/**
 * Prepare `text` for synthesis. Never throws: any failure returns the original.
 * @param args.complete The llm client's `complete`.
 * @param args.prompt prompts/speech-prepare.md.
 * @param args.model The analyzer's model, from `roleModel`.
 */
export async function prepareSpeech({
  text,
  complete,
  prompt,
  model,
  maxOutputTokens,
  timeoutMs,
}: {
  text: string;
  complete: (messages: Array<{ role: string; content: string }>, options: object) => Promise<{ text?: string }>;
  prompt: unknown;
  model?: string;
  maxOutputTokens?: unknown;
  timeoutMs?: unknown;
}): Promise<{ text: string; prepared: boolean; reason?: 'no-prompt' | 'error' | 'timeout' | 'empty' | 'mismatch' }> {
  const original = String(text ?? '');
  if (typeof prompt !== 'string' || prompt.trim() === '' || typeof complete !== 'function')
    return { text: original, prepared: false, reason: 'no-prompt' };
  let answer: string;
  try {
    const result = await complete(
      [
        { role: 'system', content: prompt },
        { role: 'user', content: original },
      ],
      {
        ...(model ? { model } : {}),
        role: PREPARE_ROLE,
        purpose: PREPARE_PURPOSE,
        temperature: 0,
        maxOutputTokens,
        timeoutMs,
        skipCalibration: true,
      }
    );
    answer = typeof result?.text === 'string' ? result.text.trim() : '';
  } catch (err) {
    const reason = isAbort(err) ? 'timeout' : 'error';
    log.warn('speech: prepare failed', { reason, status: errorFields(err).statusCode ?? null });
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
