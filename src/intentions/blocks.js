// The persona's view of her intentions in a request, as text: the `<intentions>` block's body
// (src/behavior/prompt.js puts it in the per-turn tail right after `<tasks>` and `<task_result>`).
// Her active intentions first (`pending`, then `waiting` with the errand it awaits and the wait's
// deadline), each with its due time and, after a wait ended, the errand's outcome or the reason
// the wait ended; then the candidates the analyzer proposed from her own lines, under their own
// header, each with the line it came from (and a marker on one whose words came from outside
// material, which only an ordinary turn of hers may accept). Cut to a token budget (`context.caps.intentions`):
// whole lines only, in order, the candidates' header only with a candidate under it. Pure: every
// word comes from `labels.intentions` (prompts/labels.json); without its header or line label
// the block is left out (''). Ids, codes and times are data, not wording.

import { fill, formatClock, formatDate } from '../format.js';
import { estimateTokens } from '../llm/tokens.js';
import { clampWithEllipsis, oneLine } from '../memory/clamp.js';

/** `context.caps.intentions` when it is missing (config.json carries the same). */
export const DEFAULT_INTENTIONS_CAP = 600;
/** A purpose's length on a line (characters). */
export const PURPOSE_LINE_CHARS = 200;
/** A candidate's quoted span on a line (characters). */
export const SPAN_LINE_CHARS = 160;

/** A moment in words: the date and the clock in `timezone`. */
function when(ts, timezone, locale) {
  return `${formatDate(ts, timezone, locale)} ${formatClock(ts, timezone, locale)}`;
}

/** A label of `l` filled, or '' when it is missing. */
function part(l, key, values) {
  return typeof l?.[key] === 'string' && l[key] ? fill(l[key], values) : '';
}

/** One active intention's line: its own, then its due time, its wait, its outcome or note. */
function activeLine(record, l, { timezone, locale, channelNameOf }) {
  const state = typeof l.states?.[record.status] === 'string' ? l.states[record.status] : record.status;
  const pieces = [fill(l.line, { id: record.id, state, purpose: clampWithEllipsis(oneLine(record.purpose), PURPOSE_LINE_CHARS) })];
  if (Number.isFinite(record.dueAt)) pieces.push(part(l, 'due', { when: when(record.dueAt, timezone, locale) }));
  if (record.status === 'waiting') pieces.push(part(l, 'waiting', { task: record.awaitingTaskId, deadline: when(record.waitDeadline, timezone, locale) }));
  else if (record.outcome?.taskId) pieces.push(part(l, 'outcome', { task: record.outcome.taskId, state: record.outcome.state }));
  else if (record.note && typeof l.notes?.[record.note] === 'string') pieces.push(fill(l.notes[record.note], { task: record.lastTaskId ?? '' }));
  if (record.destination) pieces.push(part(l, 'destination', { channel: channelNameOf(record.destination) || record.destination }));
  return pieces.filter(Boolean).join(' · ');
}

/**
 * One candidate's line; `{marker}` is `labels.intentions.externalMarker` for a candidate whose
 * words came from outside material (`provenance.origin` `external`: only an ordinary turn of hers
 * may accept it), empty for her own.
 */
function candidateLine(record, l) {
  const external = record.provenance?.origin === 'external';
  const marker = external && typeof l.externalMarker === 'string' ? l.externalMarker : '';
  return part(l, 'candidate', { id: record.id, purpose: clampWithEllipsis(oneLine(record.purpose), PURPOSE_LINE_CHARS), span: clampWithEllipsis(oneLine(record.provenance?.span ?? ''), SPAN_LINE_CHARS), marker });
}

/**
 * The `<intentions>` block's body for `records` (src/intentions/service.js#view's order), within
 * `maxTokens` (`cost` the estimate; whole lines, in order): `labels.intentions.header`, a line per
 * active one, then `candidates` and a `candidate` line per proposed one. '' when nothing fits or
 * the labels are missing.
 * @param {object[]} records
 * @param {object} labels
 * `channelNameOf(id)` names a destination channel (its id when it gives nothing).
 * @param {{ timezone?: string, locale?: string, maxTokens?: number, cost?: (text: string) => number, channelNameOf?: (id: string) => string|null }} [options]
 * @returns {string}
 */
export function intentionsBlockText(records, labels, { timezone = 'UTC', locale = 'en-US', maxTokens = DEFAULT_INTENTIONS_CAP, cost = estimateTokens, channelNameOf = () => null } = {}) {
  const l = labels?.intentions;
  const list = Array.isArray(records) ? records.filter((record) => record && typeof record.id === 'string') : [];
  if (list.length === 0 || typeof l?.header !== 'string' || typeof l?.line !== 'string') return '';
  const out = [l.header];
  let used = cost(l.header);
  const fits = (text) => used + cost(text) + 1 <= maxTokens;
  const take = (text) => {
    out.push(text);
    used += cost(text) + 1;
  };
  for (const record of list.filter((r) => r.status !== 'proposed')) {
    const text = activeLine(record, l, { timezone, locale, channelNameOf });
    if (!fits(text)) break;
    take(text);
  }
  const proposed = list.filter((r) => r.status === 'proposed');
  if (proposed.length > 0 && typeof l.candidates === 'string' && typeof l.candidate === 'string') {
    const first = candidateLine(proposed[0], l);
    if (fits(`${l.candidates}\n${first}`)) {
      take(l.candidates);
      for (const record of proposed) {
        const text = candidateLine(record, l);
        if (!fits(text)) break;
        take(text);
      }
    }
  }
  return out.length > 1 ? out.join('\n') : '';
}
