// The summary builder: the step after a search. One contract, evidence in and a note out, over two prompt files,
// because chat stretches with people and notes read differently from web results with a title, a URL and an age. Chat
// evidence is its caller's request from prompts/recall-summary.md and web evidence reads prompts/search-summary.md, both
// sent on the analyzer under a purpose of their own.
// The single word `none` is no note. Every caller goes through it: src/behavior/recall-run.ts and src/web/lookup.ts.

import { railReason, roleRequestOptions } from '../llm/openrouter.ts';
import { roleModel } from '../llm/roles.ts';
import { log } from '../log.ts';
import { oneLine } from '../memory/clamp.ts';
import { utcDay } from '../time.ts';
import { objOf } from '../tools/types.ts';
import type { Untyped } from '../tools/types.ts';
import { fillPromptTemplate } from './prompt.ts';
import { stretchLineOf } from './recall.ts';

/** Quotes and punctuation that may surround a whole answer. */
const AROUND = /^["'`«“‘*\s]+|["'`»”’*.!…\s]+$/gu;

/**
 * A summary's answer. A first non-empty line `stretch: <n>` (any case) names the section that answers the question: `n`
 * within `1..count` (a `#` before it tolerated) is `stretch` n, anything else null, and that line is not part of the text.
 * The rest, trimmed and whole, is the text. Empty, or the single word `none` with quotes and trailing
 * punctuation aside, gives no text and no stretch. Pure.
 */
export function parseSummaryNote(
  raw: unknown,
  { count = 0 }: { count?: number } = {}
): { text: string | null; stretch: number | null } {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the model's answer as it came, read as text
  const { body, stretch } = stretchLineOf(String(raw ?? ''), count);
  if (!body || body.replace(AROUND, '').toLowerCase() === 'none') return { text: null, stretch: null };
  return { text: body, stretch };
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

/** What a note is written from. Chat evidence is its caller's built request and the stretches it numbers. */
export type SummaryEvidence =
  | { kind: 'history'; windows: Array<object>; messages: Array<{ role: string; content: unknown }> }
  | { kind: 'web'; query: string; results: Array<WebResult> };

/** The length a note's prompt asks for (`maxChars`, never enforced in code) and the bound of its request. */
export type SummaryLimits = { maxChars: number; maxOutputTokens: number; signal?: AbortSignal; timeoutMs?: number };

/** A note, or why there is none. `reason` is the rail code of a failure, and `empty` for a blank answer. */
export type SummaryNote = {
  status: 'note' | 'none' | 'failed' | 'no-prompt';
  text: string | null;
  stretch: number | null;
  reason?: string;
  /** What a failed request threw, for a caller's own log and failure code. */
  error?: unknown;
  /** The answer as it came, for a caller's trace; never logged here. */
  raw?: string | null;
};

const NONE = (status: SummaryNote['status'], extra: Partial<SummaryNote> = {}): SummaryNote => ({
  status,
  text: null,
  stretch: null,
  ...extra,
});

/** The builder every caller shares. Reads `hot` at the moment of use and never rejects. Its log lines carry no text. */
export function createSummaryBuilder({
  hot,
  llm,
  now = Date.now,
}: {
  hot: { config: Record<string, Untyped>; prompts?: Record<string, unknown> | null };
  llm: { complete(messages: Array<never>, options: Record<string, unknown>): unknown };
  now?: () => number;
}): (evidence: SummaryEvidence, limits: SummaryLimits) => Promise<SummaryNote> {
  /** The system and user messages of `evidence`, or null with its prompt missing or nothing to send. */
  function messagesOf(
    evidence: SummaryEvidence,
    limits: SummaryLimits
  ): Array<{ role: string; content: unknown }> | null {
    if (evidence.kind === 'history') return evidence.messages;
    const prompt = hot.prompts?.['search-summary'];
    if (typeof prompt !== 'string' || !prompt.trim()) return null;
    const filled = fillPromptTemplate(prompt, {
      query: evidence.query,
      maxChars: limits.maxChars,
      today: utcDay(now()),
    });
    return [
      { role: 'system', content: filled },
      { role: 'user', content: renderResults(evidence.results) },
    ];
  }

  return async function buildSummary(evidence, limits) {
    const config = hot.config;
    const messages = messagesOf(evidence, limits);
    if (!messages) return NONE('no-prompt');
    const history = evidence.kind === 'history';
    const request = history
      ? {
          model: roleModel(config, 'analyzer', 'recall-summary'),
          ...roleRequestOptions(config, {
            role: 'analyzer',
            maxOutputTokens: limits.maxOutputTokens,
            purpose: 'recall-summary',
            signal: limits.signal,
            timeoutMs: limits.timeoutMs,
            long: true,
          }),
        }
      : {
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
      log.info('summary: failed', { kind: evidence.kind, reason });
      return NONE('failed', { reason, error: err });
    }
    const note = parseSummaryNote(raw, { count: history ? evidence.windows.length : 0 });
    const answered = typeof raw === 'string' ? raw : null;
    if (!note.text) return NONE('none', { raw: answered, ...(answered?.trim() ? {} : { reason: 'empty' }) });
    // A web note runs on one line and names no stretch.
    if (history) return { status: 'note', text: note.text, stretch: note.stretch, raw: answered };
    const text = oneLine(note.text);
    return { status: 'note', text, stretch: null, raw: answered };
  };
}
