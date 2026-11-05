// A message that holds several requests is answered part by part, like a
// person would: "about this I think that", "this one I will do now", "and the
// meme is funny". This module is the pure side of it: the settings, the cheap
// pre-filter that keeps an ordinary message from costing any request, and the
// strict parse of the splitter's answer (prompts/split.md). The request itself
// and the chain of turns live in src/behavior/turn.ts.

import { isPlainObject } from '../config.ts';
import { oneLine } from '../memory/clamp.ts';
import type { Untyped } from '../tools/types.ts';

/** The `split` group when a key is missing or unusable: config.json's values. */
export const SPLIT_DEFAULTS = Object.freeze({
  minChars: 80,
  maxTasks: 4,
  contextMessages: 6,
  maxOutputTokens: 300,
  minPartChars: 20,
});

/**
 * The trigger kinds that may hold parts: a direct call (a mention, a reply,
 * a follow-up, a private message). Never an overheard
 * line or an unprompted turn.
 */
const SPLIT_KINDS = new Set<string | null>(['mention', 'reply', 'followUp', 'private']);

// What separates two requests in one message: sentence enders, question marks, line breaks,
// semicolons and commas (their full-width forms too). A run of them, with the spaces between,
// counts once.
const SEPARATOR_RUN = /[.!?…;,\n。！？；，、][.!?…;,。！？；，、\s]*/gu;
// Links and inline tokens (<@id>, <#id>, <:name:id>, <t:ts:R>) carry dots and commas that separate nothing.
const NOT_TEXT = /https?:\/\/\S+|<[^<>\s]+>/gu;

/**
 * The splitter's settings: SPLIT_DEFAULTS (`minChars`, `maxTasks`, `contextMessages`, `minPartChars`, production
 * values of the config cut of 2026-10-31) and `split.maxOutputTokens` of the live config (> 0, floored; a missing or
 * unusable value takes config.json's).
 */
export function splitSettings(config: Record<string, Untyped>): {
  minChars: number;
  maxTasks: number;
  contextMessages: number;
  maxOutputTokens: number;
  minPartChars: number;
} {
  const group: Record<string, unknown> = isPlainObject(config?.split) ? config.split : {};
  const read = (
    key: 'minChars' | 'maxTasks' | 'contextMessages' | 'maxOutputTokens' | 'minPartChars',
    min: number
  ): number => {
    const value = group[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= min
      ? Math.floor(value)
      : SPLIT_DEFAULTS[key];
  };
  return {
    minChars: SPLIT_DEFAULTS.minChars,
    maxTasks: SPLIT_DEFAULTS.maxTasks,
    contextMessages: SPLIT_DEFAULTS.contextMessages,
    maxOutputTokens: read('maxOutputTokens', 1),
    minPartChars: SPLIT_DEFAULTS.minPartChars,
  };
}

// The length of `text` as the split rails count it: code points, links and inline tokens left out.
function plainText(text: string | null | undefined) {
  return String(text ?? '')
    .replace(NOT_TEXT, ' ')
    .trim();
}

/**
 * Whether `text` is long enough and structured enough to hold several
 * requests: links and inline tokens left out, at least `minChars` code
 * points and at least two runs of separators (SEPARATOR_RUN). Pure.
 */
export function mayHaveParts(text: string | null | undefined, minChars: number): boolean {
  const plain = plainText(text);
  if ([...plain].length < minChars) return false;
  return (plain.match(SEPARATOR_RUN)?.length ?? 0) >= 2;
}

/**
 * Whether the splitter may be asked about `trigger` on a turn of
 * `triggerKind`: features.splitTasks on (a missing key counts as on), a
 * direct call (SPLIT_KINDS), `split.maxTasks` at least 2, and its text passes
 * mayHaveParts with `split.minChars`. Everything else is one request and no
 * request is made. `config` is the live config, read now. Pure.
 */
export function splitCandidate(
  trigger: { content?: string } | null,
  triggerKind: string | null,
  config: Record<string, Untyped>
): boolean {
  if (!trigger || !SPLIT_KINDS.has(triggerKind)) return false;
  const settings = splitSettings(config);
  if (settings.maxTasks < 2) return false;
  return mayHaveParts(trigger.content, settings.minChars);
}

/**
 * `parts` with every part shorter than `minPartChars` (counted like
 * mayHaveParts: code points, links and inline tokens left out) folded into a
 * neighbour: joined to the next part (`<short> <next>`), or, for the last
 * part, to the previous one (`<previous> <short>`). Repeats until every part
 * left meets the minimum or one part is left. `minPartChars` 0 (or not a
 * positive number) folds nothing. Returns a new array. Pure.
 */
export function foldShortParts(parts: Array<string>, minPartChars: number): Array<string> {
  const folded = [...parts];
  if (!(minPartChars > 0)) return folded;
  const short = (part: string) => [...plainText(part)].length < minPartChars;
  for (let i = folded.findIndex(short); i !== -1 && folded.length > 1; i = folded.findIndex(short)) {
    if (i < folded.length - 1) folded.splice(i, 2, `${folded[i]} ${folded[i + 1]}`);
    else folded.splice(i - 1, 2, `${folded[i - 1]} ${folded[i]}`);
  }
  return folded;
}

/**
 * The splitter's answer, parsed strictly: the single word `one` (any case,
 * a trailing period allowed) -> one request; two or more non-empty lines,
 * each starting with `- ` and holding a part -> the parts (whitespace
 * collapsed), cut to `maxTasks`; a blank answer -> `empty`; anything else
 * (one dash line, a line without the dash, a numbered list) -> `unparsed`,
 * one request as well. `settings` is either the bare `maxTasks` number (no
 * folding) or splitSettings' object: then the parts are first folded by
 * foldShortParts with its `minPartChars` (a missing one takes
 * SPLIT_DEFAULTS'), and fewer than two parts left -> `folded`, one request.
 * Pure.
 */
export function parseSplitAnswer(
  text: string | null | undefined,
  settings: number | { maxTasks: number; minPartChars?: number }
): { parts: Array<string> | null; reason: 'one' | 'parts' | 'empty' | 'unparsed' | 'folded' } {
  const maxTasks = typeof settings === 'number' ? settings : settings?.maxTasks;
  const minPartChars = typeof settings === 'number' ? 0 : (settings?.minPartChars ?? SPLIT_DEFAULTS.minPartChars);
  const answer = String(text ?? '').trim();
  if (!answer) return { parts: null, reason: 'empty' };
  if (/^one\.?$/i.test(answer)) return { parts: null, reason: 'one' };
  const lines = answer
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const parts = [];
  for (const line of lines) {
    if (!line.startsWith('- ')) return { parts: null, reason: 'unparsed' };
    const part = oneLine(line.slice(2));
    if (!part) return { parts: null, reason: 'unparsed' };
    parts.push(part);
  }
  if (parts.length < 2) return { parts: null, reason: 'unparsed' };
  const kept = foldShortParts(parts, minPartChars);
  if (kept.length < 2) return { parts: null, reason: 'folded' };
  return { parts: kept.slice(0, Math.max(2, maxTasks)), reason: 'parts' };
}
