// The `<wake>` block of an inner turn (src/behavior/inner.js, docs/inner-life.md): why she is
// awake with nobody's message in front of her -- each wake of the turn (an intention whose time
// came, a wait past its deadline, the day's review, people talking in a place she attends: the
// place, the lines and who wrote them) with the intention it concerns (and the note of a recurring
// intention's last occurrence before its expiry, `labels.intentions.notes`) -- a review's list of
// her intentions that expired untouched since she was last told (`wake.expired`: the newest
// first, capped, the rest counted) -- then the present moment and her timezone, the channels she was recently active in (a review), the places page
// (`wake.places`, src/behavior/inner.js#places: where life is beyond this conversation, with the
// total and how many more) and what is left of her budgets with when each resets: facts she reads,
// never a rule. A `feedback` wake (src/behavior/inner.js#feedbackFacts: what did not go through in
// her previous turn) is its kind line followed by one `wake.feedbackItem` per fact, each fact
// worded by `wake.feedback.<kind>` (feedbackFactText); nothing tells her what to do about it. The facts kept
// for her and not told yet (`wake.facts`) follow under `wake.feedbackInTurn`, and stand alone under it as the
// `<wake>` block of an addressed turn (feedbackInTurnText). The same places page stands alone as the `<places>` block of an addressed turn
// (`context.places`, placesBlockText). Pure: every word comes from `labels.wake`
// (prompts/labels.json); without its header the block is left out (''). Ids, counts and times are
// data, not wording.

import { fill, formatClock, formatDate, formatNow } from '../format.js';
import { clampWithEllipsis, oneLine } from '../memory/clamp.js';

/** A purpose's length on a wake line (characters). */
export const WAKE_PURPOSE_CHARS = 200;

/**
 * One diagnostic of the parser (src/llm/parse.js: what it dropped, cut or joined in her output) as a
 * line: `labels.skills.diagnostics.<kind>` filled -- `{reason}` (`badCall`, worded by
 * `labels.skills.diagnostics.reasons.<reason>` when there is one), `{skill}`, `{chars}` (`messageCut`),
 * `{count}` (`messagesMerged`). `kind` is the diagnostic's own (`badCall`, ...), or `diagnostic` of a
 * kept fact, whose own is `fact.diagnostic`. '' without the kind's label.
 * @param {object} diagnostic
 * @param {object} labels  The whole labels object.
 * @returns {string}
 */
export function diagnosticText(diagnostic, labels) {
  const words = labels?.skills?.diagnostics;
  const kind = diagnostic?.kind === 'diagnostic' ? diagnostic.diagnostic : diagnostic?.kind;
  const template = words && typeof words === 'object' && typeof kind === 'string' && Object.hasOwn(words, kind) ? words[kind] : null;
  if (typeof template !== 'string' || !template) return '';
  const reason = typeof diagnostic.reason === 'string' && diagnostic.reason ? (typeof words.reasons?.[diagnostic.reason] === 'string' ? words.reasons[diagnostic.reason] : diagnostic.reason) : '';
  const count = (value) => String(Number.isFinite(value) ? value : 0);
  return fill(template, { reason, skill: String(diagnostic.skill ?? ''), chars: count(diagnostic.chars), count: count(diagnostic.count) }).replace(/\s+/g, ' ').trim();
}

/**
 * The lines of a step's diagnostics for its task: `labels.task.diagnostics` as the lead, then one
 * diagnosticText line each (those without a label left out). [] without the lead or a line.
 * @param {object[]} diagnostics
 * @param {object} labels  The whole labels object.
 * @returns {string[]}
 */
export function diagnosticLines(diagnostics, labels) {
  const lead = labels?.task?.diagnostics;
  if (typeof lead !== 'string' || !lead.trim()) return [];
  const lines = (Array.isArray(diagnostics) ? diagnostics : []).map((diagnostic) => diagnosticText(diagnostic, labels)).filter(Boolean);
  return lines.length > 0 ? [lead, ...lines.map((line) => `- ${line}`)] : [];
}

/**
 * One feedback fact (src/behavior/inner.js#feedbackFacts and the facts kept in the state) as a line:
 * `l.feedback.<kind>` filled -- `callFailed`: `{skill}`, `{status}` (`failed`, `partial`, `invalid`,
 * `denied`, `not_configured`, `refused`, `unknown`, `timeout`), `{code}`, `{text}` (the operation's own);
 * `doneWithoutDelivery`: `{id}`, `{purpose}`; `loopCut`: `{cut}` (`steps`, `time`, `no-continuation`,
 * `extra-call`), `{dropped}`, `{steps}`; `wakeDropped`: `{kind}` (the wake's), `{code}` (the outcome), `{why}`
 * (its sub-code, worded by `l.feedback.codes.<why>` when there is one), `{id}`, `{purpose}`, with
 * `l.feedback.wakeDroppedKind` (`{kind}`, `{code}`, `{why}`) for a wake with no intention (a review, a feedback wake);
 * `wakeHeld`: the same and `{until}` (when it is expected to run, `when`); `turnFailed`: `{code}`, `{kind}`;
 * `diagnostic`: a kept diagnostic of the parser, worded by diagnosticText when `options.labels` (the whole labels) is given; `sendFailed`: `{code}`, `{n}`, `{total}` (`l.feedback.sendUnknown` when the send's answer never came and it was not found in the channel); `stateLost`: `{code}` (the inner state file could not be read and she started empty). '' without the fact's label.
 * @param {object} fact
 * @param {object} l  `labels.wake`.
 * @param {{ when?: (ts: number) => string }} [options]
 * @returns {string}
 */
export function feedbackFactText(fact, l, { when = () => '', labels = null } = {}) {
  if (fact?.kind === 'diagnostic') return labels ? diagnosticText(fact, labels) : '';
  const unclear = fact?.kind === 'sendFailed' && fact.unknown === true && typeof l?.feedback?.sendUnknown === 'string' && l.feedback.sendUnknown !== '';
  const key = unclear ? 'sendUnknown' : (fact?.kind === 'wakeDropped' || fact?.kind === 'wakeHeld') && !fact.intentionId && typeof l?.feedback?.[`${fact.kind}Kind`] === 'string' ? `${fact.kind}Kind` : fact?.kind;
  const template = l?.feedback?.[key];
  if (typeof template !== 'string' || !template) return '';
  const n = (value) => String(Number.isFinite(value) ? value : 0);
  const purpose = clampWithEllipsis(oneLine(String(fact.purpose ?? '')), WAKE_PURPOSE_CHARS);
  const why = typeof fact.why === 'string' && fact.why ? (typeof l.feedback.codes?.[fact.why] === 'string' ? l.feedback.codes[fact.why] : fact.why) : '';
  const text = (line) => line.replace(/\s+/g, ' ').trim();
  switch (fact.kind) {
    case 'callFailed':
      return text(fill(template, { skill: String(fact.skill ?? ''), status: String(fact.status ?? ''), code: String(fact.code ?? ''), text: oneLine(String(fact.text ?? '')) }));
    case 'doneWithoutDelivery':
      return fill(template, { id: String(fact.intentionId ?? ''), purpose });
    case 'loopCut':
      return fill(template, { cut: String(fact.cut ?? ''), dropped: n(fact.droppedCalls), steps: n(fact.steps) });
    case 'wakeDropped':
    case 'wakeHeld':
      return text(fill(template, { kind: String(fact.wake ?? ''), code: String(fact.code ?? ''), why, id: String(fact.intentionId ?? ''), purpose, until: when(fact.until) }));
    case 'turnFailed':
      return fill(template, { code: String(fact.code ?? ''), kind: String(fact.wake ?? '') });
    case 'sendFailed':
      return fill(template, { code: String(fact.code ?? ''), n: n(fact.n), total: n(fact.total) });
    case 'stateLost':
      return fill(template, { code: String(fact.code ?? '') });
    default:
      return '';
  }
}

/**
 * The facts kept for her and not told yet as a block: `l.feedbackInTurn`, then one `l.feedbackItem` per fact
 * (`facts` without a label are left out). '' without the header, the item label or a fact with text.
 * @param {object[]} facts  Fact payloads (src/behavior/inner.js#factPayload).
 * @param {object} labels
 * @param {{ timezone?: string, locale?: string }} [options]
 * @returns {string}
 */
export function feedbackInTurnText(facts, labels, { timezone = 'UTC', locale = 'en-US' } = {}) {
  const l = labels?.wake;
  if (typeof l?.feedbackInTurn !== 'string' || !l.feedbackInTurn || typeof l.feedbackItem !== 'string' || !l.feedbackItem) return '';
  const when = (ts) => (Number.isFinite(ts) ? `${formatDate(ts, timezone, locale)} ${formatClock(ts, timezone, locale)}` : '');
  const lines = (Array.isArray(facts) ? facts : []).map((fact) => feedbackFactText(fact, l, { when, labels })).filter(Boolean).map((text) => fill(l.feedbackItem, { fact: text }));
  return lines.length > 0 ? [l.feedbackInTurn, ...lines].join('\n') : '';
}

/** The budgets the block names, in order. */
export const WAKE_BUDGETS = Object.freeze(['chain']);

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
 * ` · ` -- `expired` (a review: src/intentions/model.js#expiredToShow's `{ items, more }`, after
 * the wake lines as `labels.wake.expired`, one `labels.wake.expiredItem` per item with `{id}`,
 * `{purpose}`, `{when}`, then `labels.wake.expiredMore` with `{more}` when more follow; left out
 * without its two labels or an item), `now`, `timezone`, `channels`, `places`, `budgets`), ''
 * when `labels.wake.header` is missing. An `attend` item fills `{place}` (its name), `{lines}`,
 * `{people}` (names, joined by ", ") and `{since}` (when she last looked) beside `{id}` and `{purpose}`.
 * An item with `delayed` (`{ minutes, code }`: a wake retried after a failed turn) is followed by one
 * `labels.wake.delayed` (`{minutes}` since it was due, `{code}`); without the label no line.
 * A `feedback` item (`facts`) is followed by one `labels.wake.feedbackItem` (`{fact}`:
 * feedbackFactText's) per fact; facts without a label are left out. `facts` of the wake itself (the
 * kept, untold ones) follow the same way under `labels.wake.feedbackInTurn`.
 * The current channel (`wake.here`: `{ channel, why }`) follows the wake lines as `labels.wake.here`
 * (`{channel}`, `{why}`), or `labels.wake.hereNone` when the turn has none (`here` null; absent: no line).
 * @param {{ items: { kind: string, intentionIds?: string[], taskId?: string|null, attend?: { placeName?: string, place: string, lines: number, peopleNames?: string[], people: string[], since?: number|null } }[],
 *   intentions?: object[], notes?: Record<string, string>, expired?: { items: { id: string, purpose: string, at: number }[], more: number }|null,
 *   now: number, timezone: string, channels?: string[], places?: object|null, budgets?: object }} wake
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
    // A wake that ran late because its first turn failed: how long since it was due, and the failure's code.
    if (item.delayed && typeof l.delayed === 'string' && l.delayed) lines.push(fill(l.delayed, { minutes: String(item.delayed.minutes ?? 0), code: String(item.delayed.code ?? '') }));
    if (item.kind === 'feedback' && typeof l.feedbackItem === 'string' && l.feedbackItem) {
      for (const fact of Array.isArray(item.facts) ? item.facts : []) {
        const text = feedbackFactText(fact, l, { when, labels });
        if (text) lines.push(fill(l.feedbackItem, { fact: text }));
      }
    }
  }
  // The other facts kept for her and not told yet (a drop, a hold, a failure of an earlier turn).
  const kept = feedbackInTurnText(wake.facts, labels, { timezone, locale });
  if (kept) lines.push(kept);
  // The current channel her output tags act in and why it is that one, or that there is none.
  const here = wake.here ? part(l, 'here', { channel: oneLine(String(wake.here.channel ?? '')), why: String(wake.here.why ?? '') }) : wake.here === null ? part(l, 'hereNone', {}) : '';
  if (here) lines.push(here);
  const expired = wake.expired;
  if (Array.isArray(expired?.items) && expired.items.length > 0 && typeof l.expired === 'string' && l.expired && typeof l.expiredItem === 'string' && l.expiredItem) {
    lines.push(l.expired);
    for (const item of expired.items) lines.push(fill(l.expiredItem, { id: String(item.id ?? ''), purpose: clampWithEllipsis(oneLine(String(item.purpose ?? '')), WAKE_PURPOSE_CHARS), when: when(item.at) }));
    if (expired.more > 0) {
      const more = part(l, 'expiredMore', { more: String(expired.more) });
      if (more) lines.push(more);
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
