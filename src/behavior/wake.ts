// What an inner turn's wake says in its request (src/behavior/inner.ts, docs/inner-life.md), as facts she reads and
// never a rule. `awakeLines` says why she is awake with nobody's message in front of her, one line per wake of the turn
// (an intention whose time came, a wait past its deadline, people talking in a place she attends, a heartbeat, a
// selfimprovement wake, a feedback wake), for `<spatial_awareness>`. `feedbackText` is the body of `<feedback>`: what
// did not go through in her previous turn (feedbackFactText, each fact worded by `wake.feedback.<kind>`), the place a
// due intention could not be reached in, and the facts kept for her and not told yet under `wake.feedbackInTurn`, which
// stand alone as the feedback of an addressed turn (feedbackInTurnText). The places page stands alone as the
// `<places>` block of an addressed turn (`context.places`, placesBlockText). Pure: every word comes from `labels.wake`
// (prompts/labels.json). Ids, counts and times are data, not wording.

import { fill, formatClock, formatDate } from '../format.ts';
import { clampWithEllipsis, oneLine } from '../memory/clamp.ts';
import { isFiniteNumber, listOf, objOf } from '../tools/types.ts';
import type { Obj } from '../tools/types.ts';
import type { SelfimprovementFacts } from './selfimprovement-view.ts';

/** `value` as text (String over a value of any type). */
const asText = (value: unknown): string => String(value);

/** A wake of `inner.json` as the queue keeps it: a record with its id and kind. */
export type StoredWake = Obj & { id: string; kind: string };

/**
 * The queued wakes of `inner.json` as they are kept now: the ones with an id and a kind of `kinds`. A wake stored before
 * the errand rename names its errand `taskId`, which is read as `errandId` and dropped, so the next save writes the new
 * shape. The wake's id and the handled ids keep their bytes, so a wake handled before the upgrade is not run again.
 */
export function storedWakes(queue: unknown, kinds: ReadonlyArray<string>): Array<StoredWake> {
  return listOf(queue)
    .filter(
      (wake): wake is StoredWake =>
        Boolean(wake) &&
        typeof objOf(wake).id === 'string' &&
        typeof objOf(wake).kind === 'string' &&
        kinds.includes(String(objOf(wake).kind))
    )
    .map((wake) => {
      if (!Object.hasOwn(wake, 'taskId')) return wake;
      const { taskId, ...rest } = wake;
      return typeof rest.errandId === 'string' || typeof taskId !== 'string' ? rest : { ...rest, errandId: taskId };
    });
}

/** A purpose's length on a wake line (characters). */
export const WAKE_PURPOSE_CHARS = 200;

/**
 * One diagnostic of the parser (src/llm/parse.ts: what it dropped, cut or joined in her output) as a
 * line: `labels.tools.diagnostics.<kind>` filled -- `{tag}` (`retiredTag`), `{chars}` (`messageCut`),
 * `{count}` (`messagesMerged`, the sum of its three counts for `msgMalformed`). `kind` is the diagnostic's own (`retiredTag`, ...), or `diagnostic` of a
 * kept fact, whose own is `fact.diagnostic`. '' without the kind's label. `labels` is the whole labels object.
 */
export function diagnosticText(diagnostic: unknown, labels: unknown): string {
  const given = objOf(diagnostic);
  const words = objOf(objOf(labels).tools).diagnostics;
  const known = objOf(words);
  const kind = given.kind === 'diagnostic' ? given.diagnostic : given.kind;
  const template =
    words && typeof words === 'object' && typeof kind === 'string' && Object.hasOwn(known, kind) ? known[kind] : null;
  if (typeof template !== 'string' || !template) return '';
  const reasons = objOf(known.reasons);
  const reason =
    typeof given.reason === 'string' && given.reason
      ? typeof reasons[given.reason] === 'string'
        ? reasons[given.reason]
        : given.reason
      : '';
  const number = (value: unknown) => (isFiniteNumber(value) ? value : 0);
  const count = (value: unknown) => String(number(value));
  return fill(template, {
    reason,
    skill: asText(given.skill ?? ''),
    tag: asText(given.tag ?? ''),
    chars: count(given.chars),
    count: count(given.count ?? number(given.nested) + number(given.unclosed) + number(given.stray)),
  })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The lines of a step's diagnostics for its task: `labels.task.diagnostics` as the lead, then one
 * diagnosticText line each (those without a label left out). [] without the lead or a line.
 * `labels` is the whole labels object.
 */
export function diagnosticLines(diagnostics: unknown, labels: unknown): Array<string> {
  const lead = objOf(objOf(labels).task).diagnostics;
  if (typeof lead !== 'string' || !lead.trim()) return [];
  const lines = listOf(diagnostics)
    .map((diagnostic) => diagnosticText(diagnostic, labels))
    .filter(Boolean);
  return lines.length > 0 ? [lead, ...lines.map((line) => `- ${line}`)] : [];
}

/** How the `<wake>` words a moment. */
type When = (ts: unknown) => string;

/** The label of `l.feedback` a fact is worded by: its kind, or the variant of an unclear send or a wake with no intention. */
function feedbackKeyOf(given: Obj, feedback: Obj): string {
  const unclear =
    given.kind === 'sendFailed' &&
    given.unknown === true &&
    typeof feedback.sendUnknown === 'string' &&
    feedback.sendUnknown !== '';
  if (unclear) return 'sendUnknown';
  const wakeWithoutIntention =
    (given.kind === 'wakeDropped' || given.kind === 'wakeHeld') &&
    !given.intentionId &&
    typeof feedback[`${given.kind}Kind`] === 'string';
  return wakeWithoutIntention ? `${String(given.kind)}Kind` : asText(given.kind);
}

/**
 * One feedback fact (src/behavior/inner/facts.ts#feedbackFacts and the facts kept in the state) as a line:
 * `l.feedback.<kind>` filled -- `callFailed`: `{skill}`, `{status}` (`failed`, `partial`, `invalid`,
 * `denied`, `not_configured`, `refused`, `unknown`, `timeout`), `{code}`, `{text}` (the operation's own);
 * `doneWithoutDelivery`: `{id}`, `{purpose}`; `loopCut`: `{cut}` (`steps`, `time`, `no-continuation`,
 * `extra-call`), `{dropped}`, `{steps}`; `wakeDropped`: `{kind}` (the wake's), `{code}` (the outcome), `{why}`
 * (its sub-code, worded by `l.feedback.codes.<why>` when there is one), `{id}`, `{purpose}`, with
 * `l.feedback.wakeDroppedKind` (`{kind}`, `{code}`, `{why}`) for a wake with no intention (a heartbeat, a feedback wake);
 * `wakeHeld`: the same and `{until}` (when it is expected to run, `when`); `turnFailed`: `{code}`, `{kind}`;
 * `diagnostic`: a kept diagnostic of the parser, worded by diagnosticText when `options.labels` (the whole labels) is given; `sendFailed`: `{code}`, `{n}`, `{total}` (`l.feedback.sendUnknown` when the send's answer never came and it was not found in the channel); `stateLost`: `{code}` (the inner state file could not be read and she started empty); `memoryFailed`: `{code}`, `{n}` (a memory batch could not be applied; `n` lines wait for a new try); `proxySwitched`: `{why}` (the engine proxy went down or came back, worded by `l.feedback.codes.<why>`); `interrupted`: `{kind}`, `{done}` (a turn cut off by a restart after it did what `done` lists). '' without the fact's label.
 * `l` is `labels.wake`.
 */
export function feedbackFactText(
  fact: unknown,
  l: unknown,
  { when = () => '', labels = null }: { when?: When; labels?: unknown } = {}
): string {
  const given = objOf(fact);
  const feedback = objOf(objOf(l).feedback);
  if (given.kind === 'diagnostic') return labels ? diagnosticText(given, labels) : '';
  const template = feedback[feedbackKeyOf(given, feedback)];
  if (typeof template !== 'string' || !template) return '';
  const n = (value: unknown) => String(isFiniteNumber(value) ? value : 0);
  const purpose = clampWithEllipsis(oneLine(asText(given.purpose ?? '')), WAKE_PURPOSE_CHARS);
  const codes = objOf(feedback.codes);
  const why =
    typeof given.why === 'string' && given.why
      ? typeof codes[given.why] === 'string'
        ? codes[given.why]
        : given.why
      : '';
  const text = (line: string) => line.replace(/\s+/g, ' ').trim();
  const code = asText(given.code ?? '');
  switch (given.kind) {
    case 'callFailed':
      return text(
        fill(template, {
          skill: asText(given.skill ?? ''),
          status: asText(given.status ?? ''),
          code,
          text: oneLine(asText(given.text ?? '')),
        })
      );
    case 'doneWithoutDelivery':
      return fill(template, { id: asText(given.intentionId ?? ''), purpose });
    case 'loopCut':
      return fill(template, { cut: asText(given.cut ?? ''), dropped: n(given.droppedCalls), steps: n(given.steps) });
    case 'wakeDropped':
    case 'wakeHeld':
      return text(
        fill(template, {
          kind: asText(given.wake ?? ''),
          code,
          why,
          id: asText(given.intentionId ?? ''),
          purpose,
          until: when(given.until),
        })
      );
    case 'turnFailed':
      return fill(template, { code, kind: asText(given.wake ?? '') });
    case 'sendFailed':
      return fill(template, { code, n: n(given.n), total: n(given.total) });
    case 'stateLost':
      return fill(template, { code });
    case 'memoryFailed':
      return fill(template, { code, n: n(given.waiting) });
    case 'proxySwitched':
      return fill(template, { why });
    case 'interrupted':
      return text(fill(template, { kind: asText(given.wake ?? ''), done: oneLine(asText(given.done ?? '')) }));
    default:
      return '';
  }
}

/** `when` of `<wake>`: a moment as a date and a clock in `timezone`, '' for none. */
function whenOf(timezone: string, locale: string): When {
  return (ts) => (isFiniteNumber(ts) ? `${formatDate(ts, timezone, locale)} ${formatClock(ts, timezone, locale)}` : '');
}

/**
 * The facts kept for her and not told yet as a block: `l.feedbackInTurn`, then one `l.feedbackItem` per fact
 * (`facts` without a label are left out). '' without the header, the item label or a fact with text.
 * `facts` are fact payloads (src/behavior/inner/facts.ts#factPayload).
 */
export function feedbackInTurnText(
  facts: unknown,
  labels: unknown,
  { timezone = 'UTC', locale = 'en-US' }: { timezone?: string; locale?: string } = {}
): string {
  const l = objOf(objOf(labels).wake);
  const header = l.feedbackInTurn;
  const item = l.feedbackItem;
  if (typeof header !== 'string' || !header || typeof item !== 'string' || !item) return '';
  const when = whenOf(timezone, locale);
  const lines = listOf(facts)
    .map((fact) => feedbackFactText(fact, l, { when, labels }))
    .filter(Boolean)
    .map((text) => fill(item, { fact: text }));
  return lines.length > 0 ? [header, ...lines].join('\n') : '';
}

/** A label of `l` filled, or '' when it is missing. */
function part(l: Obj, key: string, values: object): string {
  const template = l[key];
  return typeof template === 'string' && template ? fill(template, values) : '';
}

/**
 * The lines of a places page (src/behavior/inner/places.ts#places: `{ total, more, items }`): the lead
 * `labels.wake.places` (`{total}`), one `labels.wake.place` per item (`{name}`, `{lines}`,
 * `{people}`, `{flags}`: `labels.wake.placeReadOnly` when she cannot write there and
 * `labels.wake.placeAttended` when she attends it, joined), then `labels.wake.placesMore`
 * (`{more}`) when more follow. [] without the lead label or a page. `l` is `labels.wake`.
 */
export function placesLines(page: unknown, l: unknown): Array<string> {
  const given = objOf(page);
  const words = objOf(l);
  if (!page || !Array.isArray(given.items) || typeof words.places !== 'string' || !words.places) return [];
  const items = listOf(given.items);
  const lines = [fill(words.places, { total: asText(given.total ?? items.length) })];
  for (const entry of items) {
    const item = objOf(entry);
    const flags = [
      item.writable === false ? part(words, 'placeReadOnly', {}) : '',
      item.attended ? part(words, 'placeAttended', {}) : '',
    ].join('');
    const line = part(words, 'place', {
      name: asText(item.name ?? item.id ?? ''),
      lines: asText(item.lines ?? 0),
      people: asText(item.people ?? 0),
      flags,
    });
    if (line) lines.push(line);
  }
  if (Number(given.more) > 0) {
    const more = part(words, 'placesMore', { more: asText(given.more) });
    if (more) lines.push(more);
  }
  return lines;
}

/**
 * The `<places>` body of an addressed turn (`context.places`): the places page alone, '' without
 * its lead label or a page.
 */
export function placesBlockText(page: unknown, labels: unknown): string {
  return placesLines(page, objOf(labels).wake).join('\n');
}

/** What an inner turn's wake carries for its request (src/behavior/inner/types.ts#WakeInfo, or a test's record). */
export type WakeBlockInput = {
  items?: ReadonlyArray<unknown>;
  intentions?: ReadonlyArray<unknown>;
  notes?: Readonly<Record<string, string>>;
  timezone?: string;
  facts?: ReadonlyArray<unknown>;
  /** A selfimprovement wake's facts, for `<work>` and `<board>` (src/behavior/selfimprovement-text.ts). */
  selfimprovement?: SelfimprovementFacts | null;
  /** The code of the place a due intention named and could not be reached in (`unavailable`, `dm-off`, `not-writable`). */
  placeFailure?: string | null;
};

/**
 * Why she is awake with nobody's message in front of her, as lines for `<spatial_awareness>`: one `labels.wake.kinds`
 * line per wake of the turn (an intention whose time came with its purpose, a wait past its deadline, people talking in
 * a place she attends with the place, the lines and who wrote them, a heartbeat, a selfimprovement wake, a feedback
 * wake), with the note of a recurring intention's last occurrence (`labels.intentions.notes`) and, for a wake retried
 * after a failed turn, `labels.wake.delayed`. [] without `labels.wake.kinds` or a wake.
 */
export function awakeLines(
  wake: WakeBlockInput | null | undefined,
  labels: unknown,
  { locale = 'en-US' }: { locale?: string } = {}
): Array<string> {
  const all = objOf(labels);
  const l = objOf(all.wake);
  if (!wake) return [];
  const when = whenOf(wake.timezone || 'UTC', locale);
  const byId = new Map(listOf(wake.intentions).map((record) => [objOf(record).id, objOf(record)]));
  const kinds = objOf(l.kinds);
  const notes = objOf(objOf(all.intentions).notes);
  const words = { kinds, notes, l, when, byId };
  return listOf(wake.items)
    .filter(Boolean)
    .flatMap((entry) => itemLines(objOf(entry), wake, words));
}

/** What a wake's lines are worded with. */
type AwakeWords = { kinds: Obj; notes: Obj; l: Obj; when: When; byId: Map<unknown, Obj> };

/** The lines of one wake: one per intention it names (or one with none), then its delay. */
function itemLines(item: Obj, wake: WakeBlockInput, { kinds, notes, l, when, byId }: AwakeWords): Array<string> {
  const template = kinds[asText(item.kind)];
  if (typeof template !== 'string' || !template) return [];
  const lines: Array<string> = [];
  const ids: Array<unknown> =
    Array.isArray(item.intentionIds) && item.intentionIds.length > 0 ? item.intentionIds : [null];
  for (const id of ids) {
    const record = id ? byId.get(id) : null;
    if (id && !record) continue;
    const line = fill(template, {
      id: id ?? '',
      purpose: record ? clampWithEllipsis(oneLine(record.purpose ?? ''), WAKE_PURPOSE_CHARS) : '',
      errand: item.errandId ?? '',
      due: when(record?.dueAt),
      ...attendValues(item.attend, when),
    });
    const note = noteOf(wake, id, notes);
    lines.push(note ? `${line} · ${note}` : line);
  }
  // A wake that ran late because its first turn failed: how long since it was due, and the failure's code.
  const delayed = objOf(item.delayed);
  if (item.delayed) {
    const late = part(l, 'delayed', { minutes: asText(delayed.minutes ?? 0), code: asText(delayed.code ?? '') });
    if (late) lines.push(late);
  }
  return lines;
}

/** The note of an intention's last occurrence (`labels.intentions.notes`), '' with none. */
function noteOf(wake: WakeBlockInput, id: unknown, notes: Obj): string {
  const code = id ? wake.notes?.[asText(id)] : null;
  const label = code ? notes[code] : undefined;
  return typeof label === 'string' ? fill(label, { task: '' }) : '';
}

/** The values of an `attend` wake's line: the place, the new lines, who wrote them and when she last looked. */
function attendValues(attend: unknown, when: When): Record<string, string> {
  if (!attend) return { place: '', lines: '', people: '', since: '' };
  const given = objOf(attend);
  const names =
    Array.isArray(given.peopleNames) && given.peopleNames.length > 0 ? listOf(given.peopleNames) : listOf(given.people);
  return {
    place: oneLine(asText(given.placeName ?? given.place ?? '')),
    lines: asText(given.lines ?? 0),
    people: names.map((name) => oneLine(asText(name))).join(', '),
    since: when(given.since),
  };
}

/**
 * The `<feedback>` body of an inner turn: what did not go through and she has not been told. A `feedback` wake's facts
 * (one `labels.wake.feedbackItem` per fact, worded by feedbackFactText), the place a due intention named and could not
 * be reached in (`labels.wake.feedback.wakePlaceGone` with `{why}` worded by `labels.wake.feedback.codes`), then the
 * other facts kept for her under `labels.wake.feedbackInTurn` (feedbackInTurnText). '' with none.
 */
export function feedbackText(
  wake: WakeBlockInput | null | undefined,
  labels: unknown,
  { locale = 'en-US' }: { locale?: string } = {}
): string {
  if (!wake) return '';
  const l = objOf(objOf(labels).wake);
  const timezone = wake.timezone || 'UTC';
  const when = whenOf(timezone, locale);
  const item = typeof l.feedbackItem === 'string' ? l.feedbackItem : '';
  const lines: Array<string> = [];
  for (const entry of listOf(wake.items).filter(Boolean)) {
    const given = objOf(entry);
    if (given.kind !== 'feedback' || !item) continue;
    for (const fact of listOf(given.facts)) {
      const text = feedbackFactText(fact, l, { when, labels });
      if (text) lines.push(fill(item, { fact: text }));
    }
  }
  if (typeof wake.placeFailure === 'string' && wake.placeFailure !== '') {
    const feedback = objOf(l.feedback);
    const codes = objOf(feedback.codes);
    const why = typeof codes[wake.placeFailure] === 'string' ? codes[wake.placeFailure] : wake.placeFailure;
    const gone = part(feedback, 'wakePlaceGone', { why, code: wake.placeFailure });
    if (gone) lines.push(item ? fill(item, { fact: gone }) : gone);
  }
  const kept = feedbackInTurnText(wake.facts, labels, { timezone, locale });
  if (kept) lines.push(kept);
  return lines.join('\n');
}
