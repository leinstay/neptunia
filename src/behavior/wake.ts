// The `<wake>` block of an inner turn (src/behavior/inner.ts, docs/inner-life.md): why she is
// awake with nobody's message in front of her -- each wake of the turn (an intention whose time
// came, a wait past its deadline, the day's review, people talking in a place she attends: the
// place, the lines and who wrote them) with the intention it concerns (and the note of a recurring
// intention's last occurrence before its expiry, `labels.intentions.notes`) -- a review's list of
// her intentions that expired untouched since she was last told (`wake.expired`: the newest
// first, capped, the rest counted) -- then the present moment and her timezone, the channels she was recently active in (a review), the places page
// (`wake.places`, src/behavior/inner.ts#places: where life is beyond this conversation, with the
// total and how many more; a heartbeat's facts, `wake.heartbeat`, carry that page themselves) and what is left of her budgets with when each resets: facts she reads,
// never a rule. A `feedback` wake (src/behavior/inner.ts#feedbackFacts: what did not go through in
// her previous turn) is its kind line followed by one `wake.feedbackItem` per fact, each fact
// worded by `wake.feedback.<kind>` (feedbackFactText); nothing tells her what to do about it. The facts kept
// for her and not told yet (`wake.facts`) follow under `wake.feedbackInTurn`, and stand alone under it as the
// `<wake>` block of an addressed turn (feedbackInTurnText). The same places page stands alone as the `<places>` block of an addressed turn
// (`context.places`, placesBlockText). Pure: every word comes from `labels.wake`
// (prompts/labels.json); without its header the block is left out (''). Ids, counts and times are
// data, not wording.

import { fill, formatClock, formatDate, formatNow } from '../format.js';
import { clampWithEllipsis, oneLine } from '../memory/clamp.js';
import { estimateTokens } from '../llm/tokens.js';
import { isFiniteNumber, listOf, objOf } from '../tools/types.ts';
import type { Obj } from '../tools/types.ts';
import type { HeartbeatFacts } from './heartbeat-view.ts';
import type { ChainBudget, PlacesPage } from './inner/types.ts';

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
 * One diagnostic of the parser (src/llm/parse.js: what it dropped, cut or joined in her output) as a
 * line: `labels.tools.diagnostics.<kind>` filled -- `{tag}` (`retiredTag`), `{chars}` (`messageCut`),
 * `{count}` (`messagesMerged`). `kind` is the diagnostic's own (`retiredTag`, ...), or `diagnostic` of a
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
  const count = (value: unknown) => String(isFiniteNumber(value) ? value : 0);
  return fill(template, {
    reason,
    skill: asText(given.skill ?? ''),
    tag: asText(given.tag ?? ''),
    chars: count(given.chars),
    count: count(given.count),
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

/**
 * One feedback fact (src/behavior/inner/facts.ts#feedbackFacts and the facts kept in the state) as a line:
 * `l.feedback.<kind>` filled -- `callFailed`: `{skill}`, `{status}` (`failed`, `partial`, `invalid`,
 * `denied`, `not_configured`, `refused`, `unknown`, `timeout`), `{code}`, `{text}` (the operation's own);
 * `doneWithoutDelivery`: `{id}`, `{purpose}`; `loopCut`: `{cut}` (`steps`, `time`, `no-continuation`,
 * `extra-call`), `{dropped}`, `{steps}`; `wakeDropped`: `{kind}` (the wake's), `{code}` (the outcome), `{why}`
 * (its sub-code, worded by `l.feedback.codes.<why>` when there is one), `{id}`, `{purpose}`, with
 * `l.feedback.wakeDroppedKind` (`{kind}`, `{code}`, `{why}`) for a wake with no intention (a review, a feedback wake);
 * `wakeHeld`: the same and `{until}` (when it is expected to run, `when`); `turnFailed`: `{code}`, `{kind}`;
 * `diagnostic`: a kept diagnostic of the parser, worded by diagnosticText when `options.labels` (the whole labels) is given; `sendFailed`: `{code}`, `{n}`, `{total}` (`l.feedback.sendUnknown` when the send's answer never came and it was not found in the channel); `stateLost`: `{code}` (the inner state file could not be read and she started empty); `memoryFailed`: `{code}`, `{n}` (a memory batch could not be applied; `n` lines wait for a new try); `interrupted`: `{kind}`, `{done}` (a turn cut off by a restart after it did what `done` lists). '' without the fact's label.
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
  const unclear =
    given.kind === 'sendFailed' &&
    given.unknown === true &&
    typeof feedback.sendUnknown === 'string' &&
    feedback.sendUnknown !== '';
  const key = unclear
    ? 'sendUnknown'
    : (given.kind === 'wakeDropped' || given.kind === 'wakeHeld') &&
        !given.intentionId &&
        typeof feedback[`${given.kind}Kind`] === 'string'
      ? `${given.kind}Kind`
      : asText(given.kind);
  const template = feedback[key];
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
  switch (given.kind) {
    case 'callFailed':
      return text(
        fill(template, {
          skill: asText(given.skill ?? ''),
          status: asText(given.status ?? ''),
          code: asText(given.code ?? ''),
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
          code: asText(given.code ?? ''),
          why,
          id: asText(given.intentionId ?? ''),
          purpose,
          until: when(given.until),
        })
      );
    case 'turnFailed':
      return fill(template, { code: asText(given.code ?? ''), kind: asText(given.wake ?? '') });
    case 'sendFailed':
      return fill(template, { code: asText(given.code ?? ''), n: n(given.n), total: n(given.total) });
    case 'stateLost':
      return fill(template, { code: asText(given.code ?? '') });
    case 'memoryFailed':
      return fill(template, { code: asText(given.code ?? ''), n: n(given.waiting) });
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

/** The budgets the block names, in order. */
export const WAKE_BUDGETS: ReadonlyArray<'chain'> = Object.freeze(['chain'] as const);

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

/** The places and people the budget never sheds below. */
const KEEP_PLACES = 3;
const KEEP_PEOPLE = 5;

/** The lists a heartbeat's block sheds from, in the order it sheds them. */
type ShedKey = 'filtered' | 'life' | 'places' | 'people';
/** One row of her life with the kind it is worded as. */
type LifeRow = { kind: 'action' | 'post' | 'errand' | 'diary'; row: Obj };
/** What the body of a heartbeat's block is built with. */
type BodyOptions = {
  handleBase: number | null;
  used: Set<number>;
  caps: Record<ShedKey, number>;
  lifeRows: Array<LifeRow>;
};

/**
 * The lines of a heartbeat's facts (src/behavior/heartbeat-view.ts), every word from `labels.wake.heartbeat`
 * (`l`): people (`people`, one `person` each with its parts: `contact` or `contactNoPlace`, `lastWrote` (their
 * own newest line with its `#N` handle), `interests`, `activeIn`, joined by `partsJoin`), where people wrote lately
 * (`activity`: `activityPlace` with its `activityLine`s, each with a handle; it replaces the places page when the
 * facts carry it), her life (`life`: `action`, `post`, `errand`, `diary`; `open`, `attending`; `closed` with its
 * items, `more` counting the rest), what she can do (`skills`, `skill`, `agents`), and what happened since
 * (`since`, `done`, `notDone` with its items, `told`, `filtered` with its items, a line with its author, text and
 * handle as `filteredAddressLine` / `filteredMissedLine`). A list over its cap ends with `more` ({more}). A list
 * or line without its label is left out; an empty list (or one with no label) says nothing, and so does a `done`
 * line of zeros. [] for no facts.
 *
 * A line the facts refer to (`ref`, an index into `facts.refs`) is worded with `{handle}`: `#N`, N numbered on
 * from `options.handleBase` (the first ref is `handleBase`); without a base the handle is ''. `options.onRefs`
 * gets the indexes of the refs the final block shows. When the block is over `facts.maxTokens` (the
 * estimate of src/llm/tokens.js) its lists shed their last items, in this order: the filtered lines, the lines of
 * her life, the places beyond 3, the people beyond 5; what is shed is counted in the list's `more`.
 * `placesBlock` is the places page's lines (placesLines), shown right after the people when the facts have no
 * `activity`.
 */
export function heartbeatLines(
  facts: HeartbeatFacts | null | undefined,
  l: unknown,
  when: When,
  placesBlock: ReadonlyArray<string> = [],
  {
    handleBase = null,
    onRefs = null,
  }: { handleBase?: number | null; onRefs?: ((refs: Array<number>) => void) | null } = {}
): Array<string> {
  if (!facts || typeof facts !== 'object' || !l || typeof l !== 'object') return [];
  const words = objOf(l);
  const people = listOf(facts.people);
  const places = listOf(facts.activity?.items);
  const lifeRows = lifeItems(objOf(facts.life));
  const filtered = listOf(facts.since?.filtered?.items);
  const caps: Record<ShedKey, number> = {
    filtered: filtered.length,
    life: lifeRows.length,
    places: places.length,
    people: people.length,
  };
  const limit = isFiniteNumber(facts.maxTokens) && facts.maxTokens > 0 ? facts.maxTokens : Infinity;
  const stages: Array<[ShedKey, number]> = [
    ['filtered', 0],
    ['life', 0],
    ['places', KEEP_PLACES],
    ['people', KEEP_PEOPLE],
  ];
  for (;;) {
    const used = new Set<number>();
    const out = heartbeatBody(objOf(facts), words, when, placesBlock, { handleBase, used, caps, lifeRows });
    const stage = stages.find(([key, keep]) => caps[key] > keep);
    if (!stage || estimateTokens(out.join('\n')) <= limit) {
      if (typeof onRefs === 'function') onRefs([...used].sort((a, b) => a - b));
      return out;
    }
    caps[stage[0]] -= 1;
  }
}

/** The rows of her life in the order they are worded: actions, posts, errands, diary posts. */
function lifeItems(life: Obj): Array<LifeRow> {
  const take = (cap: unknown, kind: LifeRow['kind']): Array<LifeRow> =>
    listOf(objOf(cap).items).map((row) => ({ kind, row: objOf(row) }));
  return [
    ...take(life.actions, 'action'),
    ...take(life.posts, 'post'),
    ...take(life.errands, 'errand'),
    ...take(life.diary, 'diary'),
  ];
}

/** `more` of a capped list of the facts, 0 when it has none. */
const moreOf = (cap: unknown): number => Number(objOf(cap).more ?? 0);
/** The rows of a capped list of the facts mapped by `fn`. */
const rowsOf = (cap: unknown, fn: (row: Obj) => string): Array<string> => listOf(objOf(cap).items).map(objOf).map(fn);

function heartbeatBody(
  facts: Obj,
  l: Obj,
  when: When,
  placesBlock: ReadonlyArray<string>,
  { handleBase, used, caps, lifeRows }: BodyOptions
): Array<string> {
  const one = (value: unknown) => oneLine(asText(value ?? ''));
  const make = (key: string, values: object) => part(l, key, values);
  // A line made of optional pieces (a handle, a media marker) that may be empty: single spaces, no edges.
  const tidy = (key: string, values: object) => make(key, values).replace(/ {2,}/g, ' ').trim();
  const handle = (ref: unknown) => {
    if (typeof ref !== 'number' || !Number.isInteger(ref) || ref < 0 || !isFiniteNumber(handleBase)) return '';
    used.add(ref);
    return `#${handleBase + ref}`;
  };
  const mediaText = (media: unknown) => {
    if (!media) return '';
    const given = objOf(media);
    const kinds = Array.isArray(given.kinds) ? listOf(given.kinds).map(one).filter(Boolean).join('/') : '';
    return given.title ? part(l, 'mediaTitled', { kinds, title: one(given.title) }) : part(l, 'media', { kinds });
  };
  const lineValues = (item: Obj) => ({
    handle: handle(item.ref),
    when: when(item.at),
    text: one(item.text),
    media: mediaText(item.media),
  });
  const out: Array<string> = [];
  const block = (lead: string, rows: Array<string | false>, moreCount: number) => {
    const lines = rows.filter((row): row is string => Boolean(row));
    const leadText = l[lead];
    if (lines.length === 0 || typeof leadText !== 'string' || !leadText) return;
    out.push(leadText, ...lines);
    if (moreCount > 0) out.push(make('more', { more: String(moreCount) }));
  };
  const allPeople = listOf(facts.people).map(objOf);
  const people = allPeople.slice(0, caps.people);
  // The places first (the handles are numbered in the order they are worded).
  const activity = facts.activity ?? null;
  const activityItems = listOf(objOf(activity).items).map(objOf);
  const placeRows: Array<string> = [];
  if (activity && Array.isArray(objOf(activity).items)) {
    for (const place of activityItems.slice(0, caps.places)) {
      placeRows.push(
        tidy('activityPlace', {
          name: one(place.name ?? place.id),
          lines: asText(place.lines ?? 0),
          people: listOf(place.people ?? [])
            .map(one)
            .join(', '),
        })
      );
      for (const preview of listOf(place.previews).map(objOf))
        placeRows.push(tidy('activityLine', { ...lineValues(preview), who: one(preview.by ?? '') }));
    }
  }
  const placesShed =
    activity && Array.isArray(objOf(activity).items)
      ? activityItems.length - Math.min(caps.places, activityItems.length)
      : 0;
  if (activity) block('activity', placeRows, moreOf(activity) + placesShed);
  else out.push(...placesBlock);
  block(
    'people',
    people.map((p) => {
      const lastWrote = objOf(p.lastWrote);
      const wrote = p.lastWrote
        ? tidy('lastWrote', { ...lineValues(lastWrote), place: one(lastWrote.place ?? '') })
        : '';
      const interests = listOf(p.interests);
      const places = listOf(p.places);
      const parts = [
        isFiniteNumber(p.lastAt)
          ? p.lastPlace
            ? make('contact', { when: when(p.lastAt), place: one(p.lastPlace) })
            : make('contactNoPlace', { when: when(p.lastAt) })
          : '',
        wrote,
        interests.length > 0 ? make('interests', { interests: interests.map(one).join(', ') }) : '',
        places.length > 0 ? make('activeIn', { places: places.map(one).join(', ') }) : '',
      ].filter(Boolean);
      return make('person', { name: one(p.name ?? p.id), parts: parts.join(asText(l.partsJoin ?? '; ')) });
    }),
    allPeople.length - people.length
  );
  const life = objOf(facts.life);
  const shownLife = lifeRows.slice(0, caps.life);
  const lifeText = shownLife.map(({ kind, row }) => {
    if (kind === 'action')
      return make('action', {
        when: when(row.at),
        skill: one(row.skill),
        where: row.place ? make('where', { place: one(row.place) }) : '',
      });
    if (kind === 'post')
      return tidy('post', {
        when: when(row.at),
        place: one(row.place ?? ''),
        text: one(row.text),
        media: mediaText(row.media),
      });
    if (kind === 'errand')
      return tidy('errand', {
        when: when(row.at),
        agent: one(row.agent),
        state: one(row.state),
        goal: one(row.goal ?? ''),
      });
    return tidy('diary', { when: when(row.at), gist: one(row.gist ?? '') });
  });
  block(
    'life',
    lifeText,
    moreOf(life.actions) +
      moreOf(life.posts) +
      moreOf(life.errands) +
      moreOf(life.diary) +
      (lifeRows.length - shownLife.length)
  );
  block(
    'open',
    rowsOf(life.open, (i) =>
      make('openItem', {
        id: one(i.id),
        purpose: clampWithEllipsis(one(i.purpose), WAKE_PURPOSE_CHARS),
        due: isFiniteNumber(i.dueAt) ? make('due', { when: when(i.dueAt) }) : '',
        origin: i.origin === 'heartbeat' ? make('openOrigin', {}) : '',
      })
    ),
    moreOf(life.open)
  );
  block(
    'attending',
    rowsOf(life.attending, (i) =>
      make('attendingItem', {
        id: one(i.id),
        purpose: clampWithEllipsis(one(i.purpose), WAKE_PURPOSE_CHARS),
        place: one(i.place),
      })
    ),
    moreOf(life.attending)
  );
  block(
    'closed',
    rowsOf(life.closed, (i) =>
      make('closedItem', {
        id: one(i.id),
        state: one(i.state),
        purpose: clampWithEllipsis(one(i.purpose), WAKE_PURPOSE_CHARS),
        why: one(i.why),
        when: when(i.at),
      })
    ),
    moreOf(life.closed)
  );
  // What this wake accepts (innerLife.heartbeat.intentionsOnly), before the list of what she can do.
  if (facts.intentionsOnly === true) {
    const only = make('intentionsOnly', {});
    if (only) out.push(only);
  }
  const skills = listOf(facts.skills).map(objOf);
  const agents = listOf(facts.agents);
  block(
    'skills',
    [
      ...skills.map((s) => make('skill', { family: one(s.family), names: listOf(s.names).map(one).join(', ') })),
      agents.length > 0 ? make('agentsLine', { agents: agents.map(one).join(', ') }) : '',
    ],
    0
  );
  if (facts.since) sinceLines(objOf(facts.since), { l, when, caps, make, tidy, one, lineValues, block, out });
  return out;
}

/** What the since part of a heartbeat's block is worded with: the functions heartbeatBody lends it. */
type SinceTools = {
  l: Obj;
  when: When;
  caps: Record<ShedKey, number>;
  make: (key: string, values: object) => string;
  tidy: (key: string, values: object) => string;
  one: (value: unknown) => string;
  lineValues: (item: Obj) => { handle: string; when: string; text: string; media: string };
  block: (lead: string, rows: Array<string | false>, moreCount: number) => void;
  out: Array<string>;
};

/** What happened since her previous heartbeat, as lines of the heartbeat's block. */
function sinceLines(since: Obj, { l, when, caps, make, tidy, one, lineValues, block, out }: SinceTools): void {
  const done = objOf(since.done);
  const count = (value: unknown) => Number(value ?? 0);
  const doneLine =
    count(done.posts) + count(done.errands) + count(done.intentions) > 0 &&
    make('done', {
      posts: asText(done.posts ?? 0),
      errands: asText(done.errands ?? 0),
      intentions: asText(done.intentions ?? 0),
    });
  const nd = objOf(since.notDone);
  const notDone = [
    ...rowsOf(nd.expired, (i) =>
      make('expired', {
        id: one(i.id),
        purpose: clampWithEllipsis(one(i.purpose), WAKE_PURPOSE_CHARS),
        when: when(i.at),
      })
    ),
    ...rowsOf(nd.missed, (i) =>
      make('missed', {
        id: one(i.id),
        purpose: clampWithEllipsis(one(i.purpose), WAKE_PURPOSE_CHARS),
        when: when(i.at),
      })
    ),
    ...rowsOf(nd.failedErrands, (e) =>
      make('failedErrand', { id: one(e.id), agent: one(e.agent), code: one(e.code ?? ''), when: when(e.at) })
    ),
    ...rowsOf(nd.lateErrands, (i) =>
      make('lateErrand', {
        id: one(i.id),
        purpose: clampWithEllipsis(one(i.purpose), WAKE_PURPOSE_CHARS),
        when: when(i.at),
      })
    ),
    ...rowsOf(nd.unknownSends, (x) =>
      make('unknownSend', { skill: one(x.skill ?? ''), place: one(x.place ?? ''), when: when(x.at) })
    ),
    ...rowsOf(nd.failedTurns, (x) => make('failedTurn', { code: one(x.code ?? ''), when: when(x.at) })),
  ];
  const notDoneMore = ['expired', 'missed', 'failedErrands', 'lateErrands', 'unknownSends', 'failedTurns'].reduce(
    (sum, key) => sum + moreOf(nd[key]),
    0
  );
  const told = Number(nd.told) > 0 ? make('told', { count: asText(nd.told) }) : '';
  const filtered = objOf(since.filtered);
  const allFiltered = listOf(filtered.items).map(objOf);
  const shownFiltered = allFiltered.slice(0, caps.filtered);
  const filteredRows = shownFiltered.map((x) => {
    const key = x.by === 'address' ? 'filteredAddress' : 'filteredMissed';
    const values = { when: when(x.at), place: one(x.place ?? ''), verdict: one(x.verdict ?? '') };
    // A line found in the record is worded with its author, its words and its handle; else the plain line.
    const lineLabel = l[`${key}Line`];
    if (x.ref !== undefined && x.ref !== null && typeof lineLabel === 'string' && lineLabel)
      return tidy(`${key}Line`, { ...values, ...lineValues(x), who: one(x.who ?? '') });
    return make(key, values);
  });
  if (
    typeof l.since === 'string' &&
    l.since &&
    (doneLine || notDone.some(Boolean) || told || filteredRows.some(Boolean))
  ) {
    out.push(make('since', { from: when(since.from) }));
    if (doneLine) out.push(doneLine);
    block('notDone', notDone, notDoneMore);
    if (told) out.push(told);
    block('filtered', filteredRows, moreOf(filtered) + (allFiltered.length - shownFiltered.length));
  }
}

/**
 * The `<places>` body of an addressed turn (`context.places`): the places page alone, '' without
 * its lead label or a page.
 */
export function placesBlockText(page: unknown, labels: unknown): string {
  return placesLines(page, objOf(labels).wake).join('\n');
}

/** What wakeBlockText reads of an inner turn's wake (src/behavior/inner/types.ts#WakeInfo, or a test's record). */
export type WakeBlockInput = {
  items?: ReadonlyArray<unknown>;
  intentions?: ReadonlyArray<unknown>;
  notes?: Readonly<Record<string, string>>;
  expired?: { items: ReadonlyArray<{ id: string; purpose: string; at: number }>; more: number } | null;
  now?: number;
  timezone?: string;
  channels?: ReadonlyArray<string>;
  places?: PlacesPage | null;
  budgets?: { chain?: ChainBudget & { resetAt?: number } };
  heartbeat?: HeartbeatFacts | null;
  facts?: ReadonlyArray<unknown>;
  here?: { channel: string; why: string | null } | null;
};

/**
 * The `<wake>` body for `wake` (src/behavior/inner/drain.ts's turn record: `items`, `intentions`, `notes`
 * -- an intention id to a `labels.intentions.notes` code, `last-occurrence`, joined to its line by
 * ` · ` -- `expired` (a review: src/intentions/model.ts#expiredToShow's `{ items, more }`, after
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
 * `now` absent: the present moment; `timezone` absent: UTC. `options.handleBase` is the number of a heartbeat's first
 * line handle, `options.onRefs` gets the heartbeat lines' refs that stayed in (heartbeatLines).
 */
export function wakeBlockText(
  wake: WakeBlockInput | null | undefined,
  labels: unknown,
  {
    locale = 'en-US',
    handleBase = null,
    onRefs = null,
  }: { locale?: string; handleBase?: number | null; onRefs?: ((refs: Array<number>) => void) | null } = {}
): string {
  const all = objOf(labels);
  const l = objOf(all.wake);
  if (!wake || typeof l.header !== 'string' || !l.header) return '';
  const timezone = wake.timezone || 'UTC';
  const when = whenOf(timezone, locale);
  const byId = new Map(listOf(wake.intentions).map((record) => [objOf(record).id, objOf(record)]));
  const lines = [l.header];
  const kinds = objOf(l.kinds);
  const notes = objOf(objOf(all.intentions).notes);
  for (const entry of listOf(wake.items).filter(Boolean)) {
    const item = objOf(entry);
    const template = kinds[asText(item.kind)];
    if (typeof template !== 'string' || !template) continue;
    const ids: Array<unknown> =
      Array.isArray(item.intentionIds) && item.intentionIds.length > 0 ? item.intentionIds : [null];
    for (const id of ids) {
      const record = id ? byId.get(id) : null;
      if (id && !record) continue;
      const attend = item.attend ? objOf(item.attend) : null;
      const line = fill(template, {
        id: id ?? '',
        purpose: record ? clampWithEllipsis(oneLine(record.purpose ?? ''), WAKE_PURPOSE_CHARS) : '',
        errand: item.errandId ?? '',
        due: when(record?.dueAt),
        place: attend ? oneLine(asText(attend.placeName ?? attend.place ?? '')) : '',
        lines: attend ? asText(attend.lines ?? 0) : '',
        people: attend
          ? (Array.isArray(attend.peopleNames) && attend.peopleNames.length > 0
              ? listOf(attend.peopleNames)
              : listOf(attend.people ?? [])
            )
              .map((name) => oneLine(asText(name)))
              .join(', ')
          : '',
        since: attend ? when(attend.since) : '',
      });
      const code = id ? wake.notes?.[asText(id)] : null;
      const noteLabel = code ? notes[code] : undefined;
      const note = typeof noteLabel === 'string' ? fill(noteLabel, { task: '' }) : '';
      lines.push(note ? `${line} · ${note}` : line);
    }
    // A wake that ran late because its first turn failed: how long since it was due, and the failure's code.
    const delayed = objOf(item.delayed);
    if (item.delayed && typeof l.delayed === 'string' && l.delayed)
      lines.push(fill(l.delayed, { minutes: asText(delayed.minutes ?? 0), code: asText(delayed.code ?? '') }));
    if (item.kind === 'feedback' && typeof l.feedbackItem === 'string' && l.feedbackItem) {
      for (const fact of listOf(item.facts)) {
        const text = feedbackFactText(fact, l, { when, labels });
        if (text) lines.push(fill(l.feedbackItem, { fact: text }));
      }
    }
  }
  // The other facts kept for her and not told yet (a drop, a hold, a failure of an earlier turn).
  const kept = feedbackInTurnText(wake.facts, labels, { timezone, locale });
  if (kept) lines.push(kept);
  // The current channel her output tags act in and why it is that one, or that there is none.
  const here = wake.here
    ? part(l, 'here', { channel: oneLine(asText(wake.here.channel ?? '')), why: asText(wake.here.why ?? '') })
    : wake.here === null
      ? part(l, 'hereNone', {})
      : '';
  if (here) lines.push(here);
  const expired = wake.expired;
  const expiredItems = listOf(expired?.items).map(objOf);
  if (
    expiredItems.length > 0 &&
    typeof l.expired === 'string' &&
    l.expired &&
    typeof l.expiredItem === 'string' &&
    l.expiredItem
  ) {
    lines.push(l.expired);
    for (const item of expiredItems)
      lines.push(
        fill(l.expiredItem, {
          id: asText(item.id ?? ''),
          purpose: clampWithEllipsis(oneLine(asText(item.purpose ?? '')), WAKE_PURPOSE_CHARS),
          when: when(item.at),
        })
      );
    if (Number(expired?.more) > 0) {
      const more = part(l, 'expiredMore', { more: asText(expired?.more) });
      if (more) lines.push(more);
    }
  }
  const nowLine = part(l, 'now', { now: formatNow(wake.now ?? Date.now(), timezone, locale), timezone });
  if (nowLine) lines.push(nowLine);
  const channels = listOf(wake.channels).filter(Boolean);
  if (channels.length > 0) {
    const line = part(l, 'channels', { channels: channels.map((name) => `#${asText(name)}`).join(', ') });
    if (line) lines.push(line);
  }
  const placesBlock = placesLines(wake.heartbeat?.places ?? wake.places ?? null, l);
  if (wake.heartbeat)
    lines.push(...heartbeatLines(wake.heartbeat, l.heartbeat, when, placesBlock, { handleBase, onRefs }));
  else lines.push(...placesBlock);
  const budgets = wake.budgets ?? {};
  const budget = objOf(l.budget);
  const budgetLines = WAKE_BUDGETS.map((key) => {
    const entry = budgets[key];
    const template = budget[key];
    if (!entry || typeof template !== 'string' || !template) return '';
    return fill(template, { left: String(entry.left), cap: String(entry.cap), reset: when(entry.resetAt) });
  }).filter(Boolean);
  if (budgetLines.length > 0) {
    if (typeof l.budgets === 'string' && l.budgets) lines.push(l.budgets);
    lines.push(...budgetLines);
  }
  return lines.join('\n');
}
