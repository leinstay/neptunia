// The summarizer: where a text is longer than its limit, the analyzer model shortens it once in place of a cut. A media
// description (a picture, a GIF or a video) takes prompts/summarize/media.md, any other text prompts/summarize/text.md.
// The answer is kept as the model gives it, even over the limit, and every failure keeps the original text whole.

import { roleRequestOptions } from '../llm/openrouter.ts';
import { roleModel } from '../llm/roles.ts';
import { log } from '../log.ts';
import { fillPromptTemplate } from './prompt.ts';

export type SummaryKind = 'picture' | 'GIF' | 'video' | 'text';

/** The summarizer as a caller of plain text holds it: what it returns is shown whole, a summary or the text itself. */
export type Summarize = (text: string, options: { maxChars: number; kind: 'text' }) => Promise<string>;

// Bounds the longest summary the engine asks for, a video's 6,000 characters.
const MAX_OUTPUT_TOKENS = 3000;

type Message = { role: string; content: string };

export function createSummarizer(deps: {
  hot: { readonly config: Record<string, unknown>; readonly prompts: Record<string, unknown> };
  llm: { complete: (messages: Array<Message>, options: Record<string, unknown>) => Promise<{ text?: unknown }> };
}): { summarize: (text: string, options: { maxChars: number; kind: SummaryKind }) => Promise<string> } {
  const { hot, llm } = deps;

  /** `text` when it fits `maxChars` code points, else the model's one summary of it, or `text` on any failure. */
  async function summarize(text: string, options: { maxChars: number; kind: SummaryKind }): Promise<string> {
    const { maxChars, kind } = options;
    const chars = Array.from(text).length;
    if (chars <= maxChars) return text;
    const name = kind === 'text' ? 'summarize/text' : 'summarize/media';
    const template = hot.prompts[name];
    if (typeof template !== 'string' || template.trim() === '') {
      log.warn('summarize: failed', { chars, reason: 'no-prompt' });
      return text;
    }
    const config = hot.config;
    try {
      const completion = await llm.complete(
        [
          { role: 'system', content: fillPromptTemplate(template, { maxChars, kind }) },
          { role: 'user', content: text },
        ],
        {
          model: roleModel(config, 'analyzer', 'summarize'),
          ...roleRequestOptions(config, { role: 'analyzer', maxOutputTokens: MAX_OUTPUT_TOKENS, purpose: 'summarize' }),
        }
      );
      const answer = typeof completion?.text === 'string' ? completion.text.trim() : '';
      if (answer === '') {
        log.warn('summarize: failed', { chars, reason: 'empty-answer' });
        return text;
      }
      return answer;
    } catch {
      log.warn('summarize: failed', { chars, reason: 'request-failed' });
      return text;
    }
  }

  return { summarize };
}
