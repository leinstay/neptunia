// The summary builder: the step after a web search. Web results with a title, a URL and an age go in, a note comes out,
// read from prompts/summarize/search.md and sent on the analyzer under the purpose `search-summary`.
// The single word `none` is no note. Its caller is src/web/lookup.ts.

import { railReason, roleRequestOptions } from '../llm/openrouter.ts';
import { roleModel } from '../llm/roles.ts';
import { log } from '../log.ts';
import { oneLine } from '../memory/clamp.ts';
import { utcDay } from '../time.ts';
import { objOf } from '../tools/types.ts';
import type { Untyped } from '../tools/types.ts';
import { fillPromptTemplate } from './prompt.ts';

/** Quotes and punctuation that may surround a whole answer. */
const AROUND = /^["'`«“‘*\s]+|["'`»”’*.!…\s]+$/gu;
/** A first line that names a numbered section (`stretch: <n>`, any case): it is no part of a note. */
const STRETCH_LINE_RE = /^\**\s*stretch\s*\**\s*:/i;

/**
 * A summary's answer. A first non-empty line `stretch: <n>` (any case) is not part of the text. The rest, trimmed and
 * whole, is the text. Empty, or the single word `none` with quotes and trailing punctuation aside, gives no text. Pure.
 */
export function parseSummaryNote(raw: unknown): { text: string | null } {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the model's answer as it came, read as text
  const lines = String(raw ?? '').split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim());
  const rest = first === -1 ? [] : lines.slice(STRETCH_LINE_RE.test(lines[first].trim()) ? first + 1 : first);
  const body = rest.join('\n').trim();
  if (!body || body.replace(AROUND, '').toLowerCase() === 'none') return { text: null };
  return { text: body };
}

/** One web result as the note's evidence. */
export type WebResult = { title?: string; url?: string; snippet?: string; age?: string };

/** Numbered search results as plain lines (data, not wording): the search-summary prompt reads them as its list. */
export function renderResults(results: ReadonlyArray<WebResult>): string {
  return results
    .map((result, index) =>
      [`${index + 1}. ${result.title ?? ''}`, result.url ?? '', result.snippet ?? '', result.age ?? '']
        .filter(Boolean)
        .join('\n')
    )
    .join('\n\n');
}

/** What a note is written from: the query asked and the results the search found. */
export type SummaryEvidence = { query: string; results: Array<WebResult> };

/** The length a note's prompt asks for (`maxChars`, never enforced in code) and the bound of its request. */
export type SummaryLimits = { maxChars: number; maxOutputTokens: number };

/** A note, or why there is none. `reason` is the rail code of a failure, and `empty` for a blank answer. */
export type SummaryNote = {
  status: 'note' | 'none' | 'failed' | 'no-prompt';
  text: string | null;
  reason?: string;
  /** What a failed request threw, for a caller's own log and failure code. */
  error?: unknown;
};

const NONE = (status: SummaryNote['status'], extra: Partial<SummaryNote> = {}): SummaryNote => ({
  status,
  text: null,
  ...extra,
});

/** The builder the web lookup uses. Reads `hot` at the moment of use and never rejects. Its log lines carry no text. */
export function createSummaryBuilder({
  hot,
  llm,
  now = Date.now,
}: {
  hot: { config: Record<string, Untyped>; prompts?: Record<string, unknown> | null };
  llm: { complete(messages: Array<never>, options: Record<string, unknown>): unknown };
  now?: () => number;
}): (evidence: SummaryEvidence, limits: SummaryLimits) => Promise<SummaryNote> {
  return async function buildSummary(evidence, limits) {
    const config = hot.config;
    const prompt = hot.prompts?.['summarize/search'];
    if (typeof prompt !== 'string' || !prompt.trim()) return NONE('no-prompt');
    const messages = [
      {
        role: 'system',
        content: fillPromptTemplate(prompt, { query: evidence.query, maxChars: limits.maxChars, today: utcDay(now()) }),
      },
      { role: 'user', content: renderResults(evidence.results) },
    ];
    const request = {
      model: roleModel(config, 'analyzer', 'search-summary'),
      ...roleRequestOptions(config, {
        role: 'analyzer',
        maxOutputTokens: limits.maxOutputTokens,
        purpose: 'search-summary',
        long: true,
      }),
    };
    let raw: unknown;
    try {
      raw = objOf(await llm.complete(messages as Array<never>, request)).text;
    } catch (err) {
      const reason = railReason(err);
      log.info('summary: failed', { kind: 'web', reason });
      return NONE('failed', { reason, error: err });
    }
    const note = parseSummaryNote(raw);
    if (!note.text) return NONE('none', typeof raw === 'string' && raw.trim() ? {} : { reason: 'empty' });
    // A web note runs on one line.
    return { status: 'note', text: oneLine(note.text) };
  };
}
