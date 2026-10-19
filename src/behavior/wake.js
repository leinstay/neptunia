// The `<wake>` block of an inner turn (src/behavior/inner.js, docs/inner-life.md): why she is
// awake with nobody's message in front of her -- each wake of the turn (an intention whose time
// came, a wait past its deadline, the day's review) with the intention it concerns (and the note
// of a recurring intention's last occurrence before its expiry, `labels.intentions.notes`) -- then
// the present moment and her timezone, the channels she was recently active in (a review), and what
// is left of her budgets with when each resets: facts she reads, never a rule. Pure: every word
// comes from `labels.wake` (prompts/labels.json); without its header the block is left out ('').
// Ids, counts and times are data, not wording.

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
 * The `<wake>` body for `wake` (src/behavior/inner.js's turn record: `items`, `intentions`, `notes`
 * -- an intention id to a `labels.intentions.notes` code, `last-occurrence`, joined to its line by
 * ` · ` -- `now`, `timezone`, `channels`, `budgets`), '' when `labels.wake.header` is missing.
 * @param {{ items: { kind: string, intentionIds?: string[], taskId?: string|null }[], intentions?: object[], notes?: Record<string, string>, now: number,
 *   timezone: string, channels?: string[], budgets?: object }} wake
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
      const line = fill(template, {
        id: id ?? '',
        purpose: record ? clampWithEllipsis(oneLine(record.purpose ?? ''), WAKE_PURPOSE_CHARS) : '',
        task: item.taskId ?? '',
        due: when(record?.dueAt),
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
