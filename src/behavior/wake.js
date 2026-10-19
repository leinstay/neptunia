// The `<wake>` block of an inner turn (src/behavior/inner.js, docs/inner-life.md): why she is
// awake with nobody's message in front of her -- each wake of the turn (an intention whose time
// came, a wait past its deadline, the day's review, people talking in a place she attends: the
// place, the lines and who wrote them) with the intention it concerns (and the note of a recurring
// intention's last occurrence before its expiry, `labels.intentions.notes`) -- then the present
// moment and her timezone, the channels she was recently active in (a review), the places page
// (`wake.places`, src/behavior/inner.js#places: where life is beyond this conversation, with the
// total and how many more) and what is left of her budgets with when each resets: facts she reads,
// never a rule. The same places page stands alone as the `<places>` block of an addressed turn
// (`context.places`, placesBlockText). Pure: every word comes from `labels.wake`
// (prompts/labels.json); without its header the block is left out (''). Ids, counts and times are
// data, not wording.

import { fill, formatClock, formatDate, formatNow } from '../format.js';
import { clampWithEllipsis, oneLine } from '../memory/clamp.js';

/** A purpose's length on a wake line (characters). */
export const WAKE_PURPOSE_CHARS = 200;

/** The budgets the block names, in order. */
export const WAKE_BUDGETS = Object.freeze(['day', 'hour', 'chain', 'usd', 'posts']);

/** A label of `l` filled, or '' when it is missing. */
function part(l, key, values) {
  return typeof l?.[key] === 'string' && l[key] ? fill(l[key], values) : '';
}

/**
 * The lines of a places page (src/behavior/inner.js#places: `{ total, more, items }`): the lead
 * `labels.wake.places` (`{total}`), one `labels.wake.place` per item (`{name}`, `{lines}`,
 * `{people}`, `{flags}`: `labels.wake.placeReadOnly` when she cannot write there and
 * `labels.wake.placeAttended` when she attends it, joined), then `labels.wake.placesMore`
 * (`{more}`) when more follow. [] without the lead label or a page.
 * @param {{ total: number, more: number, items: object[] }|null} page
 * @param {object} l  `labels.wake`.
 * @returns {string[]}
 */
export function placesLines(page, l) {
  if (!page || !Array.isArray(page.items) || typeof l?.places !== 'string' || !l.places) return [];
  const lines = [fill(l.places, { total: String(page.total ?? page.items.length) })];
  for (const item of page.items) {
    const flags = [item.writable === false ? part(l, 'placeReadOnly', {}) : '', item.attended ? part(l, 'placeAttended', {}) : ''].join('');
    const line = part(l, 'place', { name: String(item.name ?? item.id ?? ''), lines: String(item.lines ?? 0), people: String(item.people ?? 0), flags });
    if (line) lines.push(line);
  }
  if (page.more > 0) {
    const more = part(l, 'placesMore', { more: String(page.more) });
    if (more) lines.push(more);
  }
  return lines;
}

/**
 * The `<places>` body of an addressed turn (`context.places`): the places page alone, '' without
 * its lead label or a page.
 * @param {object|null} page
 * @param {object} labels
 */
export function placesBlockText(page, labels) {
  return placesLines(page, labels?.wake).join('\n');
}

/**
 * The `<wake>` body for `wake` (src/behavior/inner.js's turn record: `items`, `intentions`, `notes`
 * -- an intention id to a `labels.intentions.notes` code, `last-occurrence`, joined to its line by
 * ` · ` -- `now`, `timezone`, `channels`, `places`, `budgets`), '' when `labels.wake.header` is
 * missing. An `attend` item fills `{place}` (its name), `{lines}`, `{people}` (names, joined by
 * ", ") and `{since}` (when she last looked) beside `{id}` and `{purpose}`.
 * @param {{ items: { kind: string, intentionIds?: string[], taskId?: string|null, attend?: { placeName?: string, place: string, lines: number, peopleNames?: string[], people: string[], since?: number|null } }[],
 *   intentions?: object[], notes?: Record<string, string>, now: number, timezone: string, channels?: string[], places?: object|null, budgets?: object }} wake
 * @param {object} labels
 * @param {{ locale?: string }} [options]
 * @returns {string}
 */
export function wakeBlockText(wake, labels, { locale = 'en-US' } = {}) {
  const l = labels?.wake;
  if (!wake || typeof l?.header !== 'string' || !l.header) return '';
  const timezone = wake.timezone || 'UTC';
  const when = (ts) => (Number.isFinite(ts) ? `${formatDate(ts, timezone, locale)} ${formatClock(ts, timezone, locale)}` : '');
  const byId = new Map((Array.isArray(wake.intentions) ? wake.intentions : []).map((record) => [record.id, record]));
  const lines = [l.header];
  for (const item of Array.isArray(wake.items) ? wake.items : []) {
    const template = l.kinds?.[item.kind];
    if (typeof template !== 'string' || !template) continue;
    const ids = Array.isArray(item.intentionIds) && item.intentionIds.length > 0 ? item.intentionIds : [null];
    for (const id of ids) {
      const record = id ? byId.get(id) : null;
      if (id && !record) continue;
      const attend = item.attend ?? null;
      const line = fill(template, {
        id: id ?? '',
        purpose: record ? clampWithEllipsis(oneLine(record.purpose ?? ''), WAKE_PURPOSE_CHARS) : '',
        task: item.taskId ?? '',
        due: when(record?.dueAt),
        place: attend ? oneLine(String(attend.placeName ?? attend.place ?? '')) : '',
        lines: attend ? String(attend.lines ?? 0) : '',
        people: attend ? (Array.isArray(attend.peopleNames) && attend.peopleNames.length > 0 ? attend.peopleNames : attend.people ?? []).map((name) => oneLine(String(name))).join(', ') : '',
        since: attend ? when(attend.since) : '',
      });
      const code = id ? wake.notes?.[id] : null;
      const note = code && typeof labels?.intentions?.notes?.[code] === 'string' ? fill(labels.intentions.notes[code], { task: '' }) : '';
      lines.push(note ? `${line} · ${note}` : line);
    }
  }
  const nowLine = part(l, 'now', { now: formatNow(wake.now, timezone, locale), timezone });
  if (nowLine) lines.push(nowLine);
  const channels = (Array.isArray(wake.channels) ? wake.channels : []).filter(Boolean);
  if (channels.length > 0) {
    const line = part(l, 'channels', { channels: channels.map((name) => `#${name}`).join(', ') });
    if (line) lines.push(line);
  }
  lines.push(...placesLines(wake.places ?? null, l));
  const budgets = wake.budgets ?? {};
  const budgetLines = WAKE_BUDGETS.map((key) => {
    const entry = budgets[key];
    const template = l.budget?.[key];
    if (!entry || typeof template !== 'string' || !template) return '';
    return fill(template, { left: String(entry.left), cap: String(entry.cap), reset: when(entry.resetAt) });
  }).filter(Boolean);
  if (budgetLines.length > 0) {
    if (typeof l.budgets === 'string' && l.budgets) lines.push(l.budgets);
    lines.push(...budgetLines);
  }
  return lines.join('\n');
}
