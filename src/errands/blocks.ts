// The persona's view of her errands in a request, as text: the `<errands>` block (her open errands
// and the finished ones she has not seen, one line each) and the `<errand_result>` block of the
// turn an errand's end opens (src/errands/turns.ts). Pure: every word comes from
// `labels.errands` (prompts/labels.json); a block whose labels are missing is left out (''). Ids,
// agent names, states' codes, URLs, file handles, content types and sizes are data, not wording.

import { fill } from '../format.ts';
import { oneLine } from '../memory/clamp.ts';
import { MINUTE_MS } from '../time.ts';
import { fileHandle, isOpenState } from './store.ts';
import { listOf, objOf, textOf } from '../tools/types.ts';
import type { Untyped } from '../tools/types.ts';
import type { ErrandRecord } from './types.ts';
import type { Summarize } from '../behavior/summarize.ts';

/** The unread errands `<errands>` shows. Production value, config cut of 2026-10-31. */
export const DEFAULT_UNREAD_SHOWN = 5;
/** `errands.resultMaxChars` when it is missing (config.json carries the same). */
export const DEFAULT_RESULT_MAX_CHARS = 3000;

/** The state of `errand` in words (`labels.errands.states`), else its code. */
function stateWord(state: string | null | undefined, labels: Untyped): string {
  const words = labels?.errands?.states;
  const key = String(state ?? '');
  return typeof words?.[key] === 'string' && words[key] ? words[key] : key;
}

/**
 * The state of `errand` in words: `labels.errands.states.expired` for a finished errand whose files the
 * runner has deleted (`filesExpired`) when that label is there, else its state's word.
 */
function errandStateWord(errand: ErrandRecord | null | undefined, labels: Untyped): string {
  const expired = objOf(objOf(labels?.errands).states).expired;
  if (errand?.filesExpired === true && typeof expired === 'string' && expired) return expired;
  return stateWord(errand?.state, labels);
}

/**
 * The `<errands>` block's body: `labels.errands.header`, then one `labels.errands.line` per errand
 * (`{id}`, `{agent}` or `labels.errands.noAgent` before the dispatcher assigned one, `{goal}` on one line,
 * whole, `{state}` through
 * `labels.errands.states`, `states.expired` for an errand whose files have expired, `{error}` the
 * code of an errand that did not end `done` ('' otherwise), `{age}` whole minutes since it was
 * asked). The open ones come first; a finished one is an unread result and its line ends with
 * `labels.errands.unread` (and `labels.errands.resultTurnFailed` when its result turn never
 * completed). At most `unreadShown` finished ones are listed, oldest first; `labels.errands.unreadMore`
 * (`{count}`) counts the rest. '' with no errand or without the header or line label.
 */
export function errandsBlockText(
  errands: unknown,
  labels: Untyped,
  { now, unreadShown = DEFAULT_UNREAD_SHOWN }: { now: number; unreadShown?: number }
): string {
  const l = labels?.errands;
  const list = listOf(errands).filter((errand): errand is ErrandRecord => typeof objOf(errand).id === 'string');
  if (list.length === 0 || typeof l?.header !== 'string' || typeof l?.line !== 'string') return '';
  const open = list.filter((errand) => isOpenState(errand.state));
  const finished = list.filter((errand) => !isOpenState(errand.state));
  const cap = Number.isInteger(unreadShown) && unreadShown >= 0 ? unreadShown : DEFAULT_UNREAD_SHOWN;
  const shown = [...open, ...finished.slice(0, cap)];
  const noAgent = textOf(objOf(objOf(labels).errands).noAgent);
  const lineOf = (errand: ErrandRecord): string => {
    const line = fill(l.line, {
      id: errand.id,
      agent: errand.agent ?? noAgent,
      goal: oneLine(errand.goal),
      state: errandStateWord(errand, labels),
      error: errand.state !== 'done' && errand.error ? errand.error : '',
      age: Math.max(0, Math.floor((now - (Number(errand.createdAt) || now)) / MINUTE_MS)),
    });
    if (isOpenState(errand.state)) return line;
    const notes = [
      typeof l.unread === 'string' ? l.unread : '',
      errand.resultTurnFailed === true && typeof l.resultTurnFailed === 'string' ? l.resultTurnFailed : '',
    ].filter(Boolean);
    return notes.length > 0 ? `${line} ${notes.join(' ')}` : line;
  };
  const lines = shown.map(lineOf);
  const more = finished.length - (shown.length - open.length);
  if (more > 0 && typeof l.unreadMore === 'string') lines.push(fill(l.unreadMore, { count: more }));
  return [l.header, ...lines].join('\n');
}

/** The line that counts the run's failed web searches (`result.searchFailed`), none when there were none. */
function searchNoticeOf(result: ErrandRecord['result'], labels: Record<string, unknown>): Array<string> {
  const count = Number(result?.searchFailures);
  const notice = labels.searchFailed;
  return Number.isSafeInteger(count) && count > 0 && typeof notice === 'string' ? [fill(notice, { count })] : [];
}

/**
 * The `<errand_result>` block's body (errandResultBody) with the result's text whole when it fits `maxChars`, else
 * `summarize`'s one retelling of it, which the body then names as one. With no `summarize` the text stays whole.
 */
export async function errandResultText(
  errand: ErrandRecord | null | undefined,
  labels: Untyped,
  { maxChars = DEFAULT_RESULT_MAX_CHARS, summarize }: { maxChars?: number; summarize?: Summarize | undefined } = {}
): Promise<string> {
  const text = resultTextOf(errand);
  const over = Array.from(text).length > maxChars;
  const shown = over && summarize ? await summarize(text, { maxChars, kind: 'text' }) : text;
  return errandResultBody(errand, labels, shown);
}

/** The trimmed text of `errand`'s result, '' when it has none. */
function resultTextOf(errand: ErrandRecord | null | undefined): string {
  const resultText = errand?.result?.text;
  return typeof resultText === 'string' ? resultText.trim() : '';
}

/** The header of a result: `result.headerNoAgent` for an errand no agent took, else `result.header`. */
function headerOf(errand: ErrandRecord, labels: Untyped): string {
  const result = objOf(objOf(objOf(labels).errands).result);
  const noAgent = textOf(result.headerNoAgent);
  return errand.agent === null && noAgent ? noAgent : textOf(result.header);
}

/**
 * The `<errand_result>` block's body for a finished `errand` whose result text is shown as `shown` (the result's own
 * text unless given): `labels.errands.result.header`, `result.headerNoAgent` for an errand no agent took (`{id}`,
 * `{agent}`, `{goal}` on one line, `{state}` in words), then `shown` under
 * `result.text`, followed by `result.retold` when it differs from the result's own text (`result.empty` when the result
 * has no text), `result.error` (`{error}`:
 * the code) when it did not end `done`, `result.searchFailed` (`{count}`: the web searches of the run that failed,
 * `result.searchFailures`) when there were any, the sources as a numbered list under `result.sources`,
 * and each file as `result.file` (`{handle}`: `file:<errand id>/<name>`, `{contentType}`,
 * `{bytes}`) under `result.files` unless the files have expired (`filesExpired`: the state's word
 * is then `states.expired`, when present), then one `result.withheld` line (`{paths}`: the paths
 * the runner withheld in a filtered scope, joined by `, `) when there are any, then one
 * `result.held` line (`{names}`: the names of the files the runner held back and did not deliver,
 * `result.filesDropped`, joined by `, `; no handle for them) when there are any. A part without its
 * label is left out; '' without the header.
 */
export function errandResultBody(
  errand: ErrandRecord | null | undefined,
  labels: Untyped,
  shown: string = resultTextOf(errand)
): string {
  const r = labels?.errands?.result;
  if (!errand || typeof r?.header !== 'string') return '';
  const parts = [
    fill(headerOf(errand, labels), {
      id: errand.id,
      agent: errand.agent,
      goal: oneLine(errand.goal),
      state: errandStateWord(errand, labels),
    }),
  ];
  const text = resultTextOf(errand);
  if (text && typeof r.text === 'string') {
    parts.push(r.text, shown);
    if (shown !== text && typeof r.retold === 'string') parts.push(r.retold);
  } else if (!text && typeof r.empty === 'string') parts.push(r.empty);
  if (errand.state !== 'done' && errand.error && typeof r.error === 'string')
    parts.push(fill(r.error, { error: errand.error }));
  const result = errand.result;
  parts.push(...searchNoticeOf(result, r as Record<string, unknown>));
  const sources = Array.isArray(result?.sources) ? result.sources.filter((url) => typeof url === 'string' && url) : [];
  if (sources.length > 0 && typeof r.sources === 'string')
    parts.push(r.sources, ...sources.map((url, i) => `${i + 1}. ${url}`));
  parts.push(
    ...fileLinesOf(errand, r as Record<string, unknown>),
    ...heldLinesOf(result, r as Record<string, unknown>)
  );
  return parts.join('\n');
}

/** The `result.files` lines of `errand`: its files by handle, none when they expired (no handle for them) or are none. */
function fileLinesOf(errand: ErrandRecord, labels: Record<string, unknown>): Array<string> {
  const { files: head, file: line } = labels;
  const result = errand.result;
  const files =
    errand.filesExpired !== true && Array.isArray(result?.files)
      ? result.files.filter((file) => file && typeof file.name === 'string' && file.name)
      : [];
  if (files.length === 0 || typeof head !== 'string' || typeof line !== 'string') return [];
  return [
    head,
    ...files.map((file) =>
      fill(line, {
        handle: fileHandle(errand.id, file.name),
        contentType: file.contentType || '-',
        bytes: Number(file.bytes) || 0,
      })
    ),
  ];
}

/** The `result.withheld` line of the withheld paths and the `result.held` line of the files held back, each when any. */
function heldLinesOf(result: ErrandRecord['result'], labels: Record<string, unknown>): Array<string> {
  const lines: Array<string> = [];
  const withheld = Array.isArray(result?.withheld)
    ? result.withheld.filter((entry) => typeof entry === 'string' && entry)
    : [];
  if (withheld.length > 0 && typeof labels.withheld === 'string')
    lines.push(fill(labels.withheld, { paths: withheld.join(', ') }));
  const held = Array.isArray(result?.filesDropped)
    ? result.filesDropped
        .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
        .filter((name) => typeof name === 'string' && name)
    : [];
  if (held.length > 0 && typeof labels.held === 'string') lines.push(fill(labels.held, { names: held.join(', ') }));
  return lines;
}
