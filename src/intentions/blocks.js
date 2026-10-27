// The persona's view of her intentions in a request, as text: the `<intentions>` block's body
// (src/behavior/prompt.js puts it in the per-turn tail right after `<errands>` and `<errand_result>`).
// Her active intentions first (`pending`, then `waiting` with the errand it awaits and the wait's
// deadline), each with its due time (the next occurrence of a recurring one, with its `every`
// period as she wrote it) -- or, for one with no due time and no wait (nothing will wake her for
// it), the fact and its expiry (`labels.intentions.noDue`) -- and, after a wait ended, the
// errand's outcome or the reason the wait ended; an attention (`attend`) with its place, the
// people whose lines count and the day's wakes against her own bound (`labels.intentions.attend`,
// `attendPeople`); a line whose expiry is within `intentions.expiryNoticeDays` ends with it
// (`labels.intentions.expiresSoon`, unless the no-date part already says it); then the candidates the analyzer proposed from her own lines, under their own
// header, each with the line it came from (and a marker on one whose words came from outside
// material, which only an ordinary turn of hers may accept). Cut to a token budget (`context.caps.intentions`):
// whole lines only, in order, the candidates' header only with a candidate under it. Pure: every
// word comes from `labels.intentions` (prompts/labels.json); without its header or line label
// the block is left out (''). Ids, codes and times are data, not wording.

import { fill, formatClock, formatDate } from '../format.js';
import { estimateTokens } from '../llm/tokens.js';
import { clampWithEllipsis, oneLine } from '../memory/clamp.js';
import { DAY_MS } from '../time.js';
import { DEFAULTS } from './model.js';

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

/**
 * One active intention's line: its own, then its due time and recurrence (or, with neither a
 * due time, a wait nor an attention, the no-date part with its expiry), its attention, its wait,
 * its outcome or note, its destination, and its expiry when that is within `noticeMs` of `now`.
 */
function activeLine(record, l, { timezone, locale, channelNameOf, nameOf, now, noticeMs }) {
  const state = typeof l.states?.[record.status] === 'string' ? l.states[record.status] : record.status;
  const pieces = [
    fill(l.line, { id: record.id, state, purpose: clampWithEllipsis(oneLine(record.purpose), PURPOSE_LINE_CHARS) }),
  ];
  const dateless = !Number.isFinite(record.dueAt) && record.status !== 'waiting' && !record.attend?.place;
  let noDue = '';
  if (Number.isFinite(record.dueAt)) pieces.push(part(l, 'due', { when: when(record.dueAt, timezone, locale) }));
  else if (dateless && Number.isFinite(record.expiresAt)) {
    noDue = part(l, 'noDue', { expires: when(record.expiresAt, timezone, locale) });
    pieces.push(noDue);
  }
  if (typeof record.every?.period === 'string' && record.every.period)
    pieces.push(part(l, 'every', { period: record.every.period }));
  if (record.attend?.place) {
    const attend = record.attend;
    pieces.push(
      part(l, 'attend', {
        place: channelNameOf(attend.place) || attend.place,
        wakes: String(attend.today?.wakes ?? 0),
        perDay: String(attend.perDay),
        settle: String(attend.settle),
      })
    );
    if (Array.isArray(attend.people) && attend.people.length > 0)
      pieces.push(part(l, 'attendPeople', { people: attend.people.map((id) => oneLine(nameOf(id) || id)).join(', ') }));
  }
  if (record.status === 'waiting')
    pieces.push(
      part(l, 'waiting', { errand: record.awaitingErrandId, deadline: when(record.waitDeadline, timezone, locale) })
    );
  else if (record.outcome?.errandId)
    pieces.push(part(l, 'outcome', { errand: record.outcome.errandId, state: record.outcome.state }));
  else if (record.note && typeof l.notes?.[record.note] === 'string')
    pieces.push(fill(l.notes[record.note], { errand: record.lastErrandId ?? '' }));
  if (record.destination)
    pieces.push(part(l, 'destination', { channel: channelNameOf(record.destination) || record.destination }));
  if (!noDue && Number.isFinite(record.expiresAt) && Number.isFinite(now) && record.expiresAt - now <= noticeMs)
    pieces.push(part(l, 'expiresSoon', { when: when(record.expiresAt, timezone, locale) }));
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
  return part(l, 'candidate', {
    id: record.id,
    purpose: clampWithEllipsis(oneLine(record.purpose), PURPOSE_LINE_CHARS),
    span: clampWithEllipsis(oneLine(record.provenance?.span ?? ''), SPAN_LINE_CHARS),
    marker,
  });
}

/**
 * The `<intentions>` block's body for `records` (src/intentions/service.js#view's order), within
 * `maxTokens` (`cost` the estimate; whole lines, in order): `labels.intentions.header`, a line per
 * active one, then `candidates` and a `candidate` line per proposed one. '' when nothing fits or
 * the labels are missing.
 * @param {object[]} records
 * @param {object} labels
 * `channelNameOf(id)` names a destination or attended channel (its id when it gives nothing);
 * `nameOf(id)` names an attended person (the id when it gives nothing). `now` (epoch ms) and
 * `expiryNoticeDays` (`intentions.expiryNoticeDays`, read by the caller now) decide which lines
 * end with their expiry; without `now` none does.
 * @param {{ timezone?: string, locale?: string, maxTokens?: number, cost?: (text: string) => number, channelNameOf?: (id: string) => string|null, nameOf?: (id: string) => string|null, now?: number|null, expiryNoticeDays?: number }} [options]
 * @returns {string}
 */
export function intentionsBlockText(
  records,
  labels,
  {
    timezone = 'UTC',
    locale = 'en-US',
    maxTokens = DEFAULT_INTENTIONS_CAP,
    cost = estimateTokens,
    channelNameOf = () => null,
    nameOf = () => null,
    now = null,
    expiryNoticeDays = DEFAULTS.expiryNoticeDays,
  } = {}
) {
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
  const noticeMs =
    (Number.isFinite(expiryNoticeDays) && expiryNoticeDays >= 0 ? expiryNoticeDays : DEFAULTS.expiryNoticeDays) *
    DAY_MS;
  for (const record of list.filter((r) => r.status !== 'proposed')) {
    const text = activeLine(record, l, { timezone, locale, channelNameOf, nameOf, now, noticeMs });
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
