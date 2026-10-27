// The persona's view of her errands in a request, as text: the `<errands>` block (her open errands
// and the finished ones she has not seen, one line each) and the `<errand_result>` block of the
// turn an errand's end opens (src/errands/turns.ts). Pure: every word comes from
// `labels.errands` (prompts/labels.json); a block whose labels are missing is left out (''). Ids,
// agent names, states' codes, URLs, file handles, content types and sizes are data, not wording.

import { fill } from '../format.js';
import { clampWithEllipsis, oneLine } from '../memory/clamp.js';
import { MINUTE_MS } from '../time.js';
import { fileHandle, isOpenState } from './store.ts';
import type { Untyped } from '../tools/types.ts';
import type { ErrandRecord } from './types.ts';

/** The goal's length on a `<errands>` line (characters). */
export const ERRAND_GOAL_CHARS = 120;
/** `errands.unreadShown` when it is missing (config.json carries the same). */
export const DEFAULT_UNREAD_SHOWN = 5;
/** `errands.resultMaxChars` when it is missing (config.json carries the same). */
export const DEFAULT_RESULT_MAX_CHARS = 3000;

/** The state of `errand` in words (`labels.errands.states`), else its code. */
function stateWord(state: string | null | undefined, labels: Untyped): string {
  const words = labels?.errands?.states;
  return typeof words?.[state] === 'string' && words[state] ? words[state] : String(state ?? '');
}

/**
 * The state of `errand` in words: `labels.errands.states.expired` for a finished errand whose files the
 * runner has deleted (`filesExpired`) when that label is there, else its state's word.
 */
function errandStateWord(errand: ErrandRecord | null | undefined, labels: Untyped): string {
  const expired = labels?.errands?.states?.expired;
  if (errand?.filesExpired === true && typeof expired === 'string' && expired) return expired;
  return stateWord(errand?.state, labels);
}

/**
 * The `<errands>` block's body: `labels.errands.header`, then one `labels.errands.line` per errand
 * (`{id}`, `{agent}`, `{goal}` on one line cut to ERRAND_GOAL_CHARS, `{state}` through
 * `labels.errands.states`, `states.expired` for an errand whose files have expired, `{error}` the
 * code of an errand that did not end `done` ('' otherwise), `{age}` whole minutes since it was
 * asked). The open ones come first; a finished one is an unread result and its line ends with
 * `labels.errands.unread` (and `labels.errands.resultTurnFailed` when its result turn never
 * completed). At most `unreadShown` finished ones are listed, oldest first; `labels.errands.unreadMore`
 * (`{count}`) counts the rest. '' with no errand or without the header or line label.
 */
export function errandsBlockText(
  errands: Array<ErrandRecord> | null | undefined,
  labels: Untyped,
  {
    now,
    goalChars = ERRAND_GOAL_CHARS,
    unreadShown = DEFAULT_UNREAD_SHOWN,
  }: { now: number; goalChars?: number; unreadShown?: number }
): string {
  const l = labels?.errands;
  const list = Array.isArray(errands) ? errands.filter((errand) => errand && typeof errand.id === 'string') : [];
  if (list.length === 0 || typeof l?.header !== 'string' || typeof l?.line !== 'string') return '';
  const open = list.filter((errand) => isOpenState(errand.state));
  const finished = list.filter((errand) => !isOpenState(errand.state));
  const cap = Number.isInteger(unreadShown) && unreadShown >= 0 ? unreadShown : DEFAULT_UNREAD_SHOWN;
  const shown = [...open, ...finished.slice(0, cap)];
  const lineOf = (errand: ErrandRecord): string => {
    const line = fill(l.line, {
      id: errand.id,
      agent: errand.agent,
      goal: clampWithEllipsis(oneLine(errand.goal), goalChars),
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

/**
 * The `<errand_result>` block's body for a finished `errand`: `labels.errands.result.header` (`{id}`,
 * `{agent}`, `{goal}` on one line, `{state}` in words), then the result's text under
 * `result.text` cut to `maxChars` (`result.empty` when there is none), `result.error` (`{error}`:
 * the code) when it did not end `done`, the sources as a numbered list under `result.sources`,
 * and each file as `result.file` (`{handle}`: `file:<errand id>/<name>`, `{contentType}`,
 * `{bytes}`) under `result.files` unless the files have expired (`filesExpired`: the state's word
 * is then `states.expired`, when present), then one `result.withheld` line (`{paths}`: the paths
 * the runner withheld in a filtered scope, joined by `, `) when there are any, then one
 * `result.held` line (`{names}`: the names of the files the runner held back and did not deliver,
 * `result.filesDropped`, joined by `, `; no handle for them) when there are any. A part without its
 * label is left out; '' without the header.
 */
export function errandResultText(
  errand: ErrandRecord | null | undefined,
  labels: Untyped,
  { maxChars = DEFAULT_RESULT_MAX_CHARS }: { maxChars?: number } = {}
): string {
  const r = labels?.errands?.result;
  if (!errand || typeof r?.header !== 'string') return '';
  const parts = [
    fill(r.header, {
      id: errand.id,
      agent: errand.agent,
      goal: oneLine(errand.goal),
      state: errandStateWord(errand, labels),
    }),
  ];
  const text = typeof errand.result?.text === 'string' ? errand.result.text.trim() : '';
  if (text && typeof r.text === 'string') parts.push(r.text, clampWithEllipsis(text, maxChars));
  else if (!text && typeof r.empty === 'string') parts.push(r.empty);
  if (errand.state !== 'done' && errand.error && typeof r.error === 'string')
    parts.push(fill(r.error, { error: errand.error }));
  const result = errand.result;
  const sources = Array.isArray(result?.sources) ? result.sources.filter((url) => typeof url === 'string' && url) : [];
  if (sources.length > 0 && typeof r.sources === 'string')
    parts.push(r.sources, ...sources.map((url, i) => `${i + 1}. ${url}`));
  // Expired files name nothing any more: no handle for them.
  const files =
    errand.filesExpired !== true && Array.isArray(result?.files)
      ? result.files.filter((file) => file && typeof file.name === 'string' && file.name)
      : [];
  if (files.length > 0 && typeof r.files === 'string' && typeof r.file === 'string') {
    parts.push(
      r.files,
      ...files.map((file) =>
        fill(r.file, {
          handle: fileHandle(errand.id, file.name),
          contentType: file.contentType || '-',
          bytes: Number(file.bytes) || 0,
        })
      )
    );
  }
  const withheld = Array.isArray(result?.withheld)
    ? result.withheld.filter((entry) => typeof entry === 'string' && entry)
    : [];
  if (withheld.length > 0 && typeof r.withheld === 'string')
    parts.push(fill(r.withheld, { paths: withheld.join(', ') }));
  const held = Array.isArray(result?.filesDropped)
    ? result.filesDropped
        .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
        .filter((name) => typeof name === 'string' && name)
    : [];
  if (held.length > 0 && typeof r.held === 'string') parts.push(fill(r.held, { names: held.join(', ') }));
  return parts.join('\n');
}
