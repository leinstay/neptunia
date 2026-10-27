// The `<wake>` block of an inner turn (src/behavior/inner.js, docs/inner-life.md): why she is
// awake with nobody's message in front of her -- each wake of the turn (an intention whose time
// came, a wait past its deadline, the day's review, people talking in a place she attends: the
// place, the lines and who wrote them) with the intention it concerns (and the note of a recurring
// intention's last occurrence before its expiry, `labels.intentions.notes`) -- a review's list of
// her intentions that expired untouched since she was last told (`wake.expired`: the newest
// first, capped, the rest counted) -- then the present moment and her timezone, the channels she was recently active in (a review), the places page
// (`wake.places`, src/behavior/inner.js#places: where life is beyond this conversation, with the
// total and how many more; a heartbeat's facts, `wake.heartbeat`, carry that page themselves) and what is left of her budgets with when each resets: facts she reads,
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
import { estimateTokens } from '../llm/tokens.js';

/** A purpose's length on a wake line (characters). */
export const WAKE_PURPOSE_CHARS = 200;

/**
 * One diagnostic of the parser (src/llm/parse.js: what it dropped, cut or joined in her output) as a
 * line: `labels.tools.diagnostics.<kind>` filled -- `{tag}` (`retiredTag`), `{chars}` (`messageCut`),
 * `{count}` (`messagesMerged`). `kind` is the diagnostic's own (`retiredTag`, ...), or `diagnostic` of a
 * kept fact, whose own is `fact.diagnostic`. '' without the kind's label.
 * @param {object} diagnostic
 * @param {object} labels  The whole labels object.
 * @returns {string}
 */
export function diagnosticText(diagnostic, labels) {
  const words = labels?.tools?.diagnostics;
  const kind = diagnostic?.kind === 'diagnostic' ? diagnostic.diagnostic : diagnostic?.kind;
  const template =
    words && typeof words === 'object' && typeof kind === 'string' && Object.hasOwn(words, kind) ? words[kind] : null;
  if (typeof template !== 'string' || !template) return '';
  const reason =
    typeof diagnostic.reason === 'string' && diagnostic.reason
      ? typeof words.reasons?.[diagnostic.reason] === 'string'
        ? words.reasons[diagnostic.reason]
        : diagnostic.reason
      : '';
  const count = (value) => String(Number.isFinite(value) ? value : 0);
  return fill(template, {
    reason,
    skill: String(diagnostic.skill ?? ''),
    tag: String(diagnostic.tag ?? ''),
    chars: count(diagnostic.chars),
    count: count(diagnostic.count),
  })
    .replace(/\s+/g, ' ')
    .trim();
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
  const lines = (Array.isArray(diagnostics) ? diagnostics : [])
    .map((diagnostic) => diagnosticText(diagnostic, labels))
    .filter(Boolean);
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
 * `diagnostic`: a kept diagnostic of the parser, worded by diagnosticText when `options.labels` (the whole labels) is given; `sendFailed`: `{code}`, `{n}`, `{total}` (`l.feedback.sendUnknown` when the send's answer never came and it was not found in the channel); `stateLost`: `{code}` (the inner state file could not be read and she started empty); `memoryFailed`: `{code}`, `{n}` (a memory batch could not be applied; `n` lines wait for a new try); `interrupted`: `{kind}`, `{done}` (a turn cut off by a restart after it did what `done` lists). '' without the fact's label.
 * @param {object} fact
 * @param {object} l  `labels.wake`.
 * @param {{ when?: (ts: number) => string }} [options]
 * @returns {string}
 */
export function feedbackFactText(fact, l, { when = () => '', labels = null } = {}) {
  if (fact?.kind === 'diagnostic') return labels ? diagnosticText(fact, labels) : '';
  const unclear =
    fact?.kind === 'sendFailed' &&
    fact.unknown === true &&
    typeof l?.feedback?.sendUnknown === 'string' &&
    l.feedback.sendUnknown !== '';
  const key = unclear
    ? 'sendUnknown'
    : (fact?.kind === 'wakeDropped' || fact?.kind === 'wakeHeld') &&
        !fact.intentionId &&
        typeof l?.feedback?.[`${fact.kind}Kind`] === 'string'
      ? `${fact.kind}Kind`
      : fact?.kind;
  const template = l?.feedback?.[key];
  if (typeof template !== 'string' || !template) return '';
  const n = (value) => String(Number.isFinite(value) ? value : 0);
  const purpose = clampWithEllipsis(oneLine(String(fact.purpose ?? '')), WAKE_PURPOSE_CHARS);
  const why =
    typeof fact.why === 'string' && fact.why
      ? typeof l.feedback.codes?.[fact.why] === 'string'
        ? l.feedback.codes[fact.why]
        : fact.why
      : '';
  const text = (line) => line.replace(/\s+/g, ' ').trim();
  switch (fact.kind) {
    case 'callFailed':
      return text(
        fill(template, {
          skill: String(fact.skill ?? ''),
          status: String(fact.status ?? ''),
          code: String(fact.code ?? ''),
          text: oneLine(String(fact.text ?? '')),
        })
      );
    case 'doneWithoutDelivery':
      return fill(template, { id: String(fact.intentionId ?? ''), purpose });
    case 'loopCut':
      return fill(template, { cut: String(fact.cut ?? ''), dropped: n(fact.droppedCalls), steps: n(fact.steps) });
    case 'wakeDropped':
    case 'wakeHeld':
      return text(
        fill(template, {
          kind: String(fact.wake ?? ''),
          code: String(fact.code ?? ''),
          why,
          id: String(fact.intentionId ?? ''),
          purpose,
          until: when(fact.until),
        })
      );
    case 'turnFailed':
      return fill(template, { code: String(fact.code ?? ''), kind: String(fact.wake ?? '') });
    case 'sendFailed':
      return fill(template, { code: String(fact.code ?? ''), n: n(fact.n), total: n(fact.total) });
    case 'stateLost':
      return fill(template, { code: String(fact.code ?? '') });
    case 'memoryFailed':
      return fill(template, { code: String(fact.code ?? ''), n: n(fact.waiting) });
    case 'interrupted':
      return text(fill(template, { kind: String(fact.wake ?? ''), done: oneLine(String(fact.done ?? '')) }));
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
  if (
    typeof l?.feedbackInTurn !== 'string' ||
    !l.feedbackInTurn ||
    typeof l.feedbackItem !== 'string' ||
    !l.feedbackItem
  )
    return '';
  const when = (ts) =>
    Number.isFinite(ts) ? `${formatDate(ts, timezone, locale)} ${formatClock(ts, timezone, locale)}` : '';
  const lines = (Array.isArray(facts) ? facts : [])
    .map((fact) => feedbackFactText(fact, l, { when, labels }))
    .filter(Boolean)
    .map((text) => fill(l.feedbackItem, { fact: text }));
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
    const flags = [
      item.writable === false ? part(l, 'placeReadOnly', {}) : '',
      item.attended ? part(l, 'placeAttended', {}) : '',
    ].join('');
    const line = part(l, 'place', {
      name: String(item.name ?? item.id ?? ''),
      lines: String(item.lines ?? 0),
      people: String(item.people ?? 0),
      flags,
    });
    if (line) lines.push(line);
  }
  if (page.more > 0) {
    const more = part(l, 'placesMore', { more: String(page.more) });
    if (more) lines.push(more);
  }
  return lines;
}

/** The places and people the budget never sheds below. */
const KEEP_PLACES = 3;
const KEEP_PEOPLE = 5;

/**
 * The lines of a heartbeat's facts (src/behavior/heartbeat-view.js), every word from `labels.wake.heartbeat`
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
 * @param {object|null} facts
 * @param {object} l  `labels.wake.heartbeat`.
 * @param {(ts: number) => string} when
 * @param {string[]} [placesBlock]  The places page's lines (placesLines), shown right after the people when the facts have no `activity`.
 * @param {{ handleBase?: number|null, onRefs?: (refs: number[]) => void }} [options]
 * @returns {string[]}
 */
export function heartbeatLines(facts, l, when, placesBlock = [], { handleBase = null, onRefs = null } = {}) {
  if (!facts || typeof facts !== 'object' || !l || typeof l !== 'object') return [];
  const people = Array.isArray(facts.people) ? facts.people : [];
  const places = Array.isArray(facts.activity?.items) ? facts.activity.items : [];
  const life = facts.life ?? {};
  const lifeRows = lifeItems(life);
  const filtered = Array.isArray(facts.since?.filtered?.items) ? facts.since.filtered.items : [];
  const caps = { filtered: filtered.length, life: lifeRows.length, places: places.length, people: people.length };
  const limit = Number.isFinite(facts.maxTokens) && facts.maxTokens > 0 ? facts.maxTokens : Infinity;
  const stages = [
    ['filtered', 0],
    ['life', 0],
    ['places', KEEP_PLACES],
    ['people', KEEP_PEOPLE],
  ];
  for (;;) {
    const used = new Set();
    const out = heartbeatBody(facts, l, when, placesBlock, { handleBase, used, caps, lifeRows });
    const stage = stages.find(([key, keep]) => caps[key] > keep);
    if (!stage || estimateTokens(out.join('\n')) <= limit) {
      if (typeof onRefs === 'function') onRefs([...used].sort((a, b) => a - b));
      return out;
    }
    caps[stage[0]] -= 1;
  }
}

/** The rows of her life in the order they are worded: actions, posts, errands, diary posts. */
function lifeItems(life) {
  const take = (cap, kind) => (Array.isArray(cap?.items) ? cap.items.map((row) => ({ kind, row })) : []);
  return [
    ...take(life.actions, 'action'),
    ...take(life.posts, 'post'),
    ...take(life.errands, 'errand'),
    ...take(life.diary, 'diary'),
  ];
}

function heartbeatBody(facts, l, when, placesBlock, { handleBase, used, caps, lifeRows }) {
  const one = (value) => oneLine(String(value ?? ''));
  const make = (key, values) => part(l, key, values);
  // A line made of optional pieces (a handle, a media marker) that may be empty: single spaces, no edges.
  const tidy = (key, values) => make(key, values).replace(/ {2,}/g, ' ').trim();
  const handle = (ref) => {
    if (!Number.isInteger(ref) || ref < 0 || !Number.isFinite(handleBase)) return '';
    used.add(ref);
    return `#${handleBase + ref}`;
  };
  const mediaText = (media) => {
    if (!media) return '';
    const kinds = Array.isArray(media.kinds) ? media.kinds.map(one).filter(Boolean).join('/') : '';
    return media.title ? part(l, 'mediaTitled', { kinds, title: one(media.title) }) : part(l, 'media', { kinds });
  };
  const lineValues = (item) => ({
    handle: handle(item.ref),
    when: when(item.at),
    text: one(item.text),
    media: mediaText(item.media),
  });
  const out = [];
  const block = (lead, rows, moreCount) => {
    const lines = rows.filter(Boolean);
    if (lines.length === 0 || typeof l[lead] !== 'string' || !l[lead]) return;
    out.push(l[lead], ...lines);
    if (moreCount > 0) out.push(make('more', { more: String(moreCount) }));
  };
  const allPeople = Array.isArray(facts.people) ? facts.people : [];
  const people = allPeople.slice(0, caps.people);
  // The places first (the handles are numbered in the order they are worded).
  const activity = facts.activity ?? null;
  const placeRows = [];
  if (activity && Array.isArray(activity.items)) {
    for (const place of activity.items.slice(0, caps.places)) {
      placeRows.push(
        tidy('activityPlace', {
          name: one(place.name ?? place.id),
          lines: String(place.lines ?? 0),
          people: (place.people ?? []).map(one).join(', '),
        })
      );
      for (const preview of Array.isArray(place.previews) ? place.previews : [])
        placeRows.push(tidy('activityLine', { ...lineValues(preview), who: one(preview.by ?? '') }));
    }
  }
  const placesShed =
    activity && Array.isArray(activity.items)
      ? activity.items.length - Math.min(caps.places, activity.items.length)
      : 0;
  if (activity) block('activity', placeRows, (activity.more ?? 0) + placesShed);
  else out.push(...placesBlock);
  block(
    'people',
    people.map((p) => {
      const wrote = p.lastWrote
        ? tidy('lastWrote', { ...lineValues(p.lastWrote), place: one(p.lastWrote.place ?? '') })
        : '';
      const parts = [
        Number.isFinite(p.lastAt)
          ? p.lastPlace
            ? make('contact', { when: when(p.lastAt), place: one(p.lastPlace) })
            : make('contactNoPlace', { when: when(p.lastAt) })
          : '',
        wrote,
        p.interests?.length > 0 ? make('interests', { interests: p.interests.map(one).join(', ') }) : '',
        p.places?.length > 0 ? make('activeIn', { places: p.places.map(one).join(', ') }) : '',
      ].filter(Boolean);
      return make('person', { name: one(p.name ?? p.id), parts: parts.join(l.partsJoin ?? '; ') });
    }),
    allPeople.length - people.length
  );
  const life = facts.life ?? {};
  const rows = (cap, fn) => (Array.isArray(cap?.items) ? cap.items.map(fn) : []);
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
    (life.actions?.more ?? 0) +
      (life.posts?.more ?? 0) +
      (life.errands?.more ?? 0) +
      (life.diary?.more ?? 0) +
      (lifeRows.length - shownLife.length)
  );
  block(
    'open',
    rows(life.open, (i) =>
      make('openItem', {
        id: one(i.id),
        purpose: clampWithEllipsis(one(i.purpose), WAKE_PURPOSE_CHARS),
        due: Number.isFinite(i.dueAt) ? make('due', { when: when(i.dueAt) }) : '',
        origin: i.origin === 'heartbeat' ? make('openOrigin', {}) : '',
      })
    ),
    life.open?.more ?? 0
  );
  block(
    'attending',
    rows(life.attending, (i) =>
      make('attendingItem', {
        id: one(i.id),
        purpose: clampWithEllipsis(one(i.purpose), WAKE_PURPOSE_CHARS),
        place: one(i.place),
      })
    ),
    life.attending?.more ?? 0
  );
  block(
    'closed',
    rows(life.closed, (i) =>
      make('closedItem', {
        id: one(i.id),
        state: one(i.state),
        purpose: clampWithEllipsis(one(i.purpose), WAKE_PURPOSE_CHARS),
        why: one(i.why),
        when: when(i.at),
      })
    ),
    life.closed?.more ?? 0
  );
  // What this wake accepts (innerLife.heartbeat.intentionsOnly), before the list of what she can do.
  if (facts.intentionsOnly === true) {
    const only = make('intentionsOnly', {});
    if (only) out.push(only);
  }
  const skills = Array.isArray(facts.skills) ? facts.skills : [];
  const agents = Array.isArray(facts.agents) ? facts.agents : [];
  block(
    'skills',
    [
      ...skills.map((s) => make('skill', { family: one(s.family), names: s.names.map(one).join(', ') })),
      agents.length > 0 ? make('agentsLine', { agents: agents.map(one).join(', ') }) : '',
    ],
    0
  );
  const since = facts.since;
  if (since) {
    const done = since.done ?? {};
    const doneLine =
      (done.posts ?? 0) + (done.errands ?? 0) + (done.intentions ?? 0) > 0 &&
      make('done', {
        posts: String(done.posts ?? 0),
        errands: String(done.errands ?? 0),
        intentions: String(done.intentions ?? 0),
      });
    const nd = since.notDone ?? {};
    const notDone = [
      ...rows(nd.expired, (i) =>
        make('expired', {
          id: one(i.id),
          purpose: clampWithEllipsis(one(i.purpose), WAKE_PURPOSE_CHARS),
          when: when(i.at),
        })
      ),
      ...rows(nd.missed, (i) =>
        make('missed', {
          id: one(i.id),
          purpose: clampWithEllipsis(one(i.purpose), WAKE_PURPOSE_CHARS),
          when: when(i.at),
        })
      ),
      ...rows(nd.failedErrands, (e) =>
        make('failedErrand', { id: one(e.id), agent: one(e.agent), code: one(e.code ?? ''), when: when(e.at) })
      ),
      ...rows(nd.lateErrands, (i) =>
        make('lateErrand', {
          id: one(i.id),
          purpose: clampWithEllipsis(one(i.purpose), WAKE_PURPOSE_CHARS),
          when: when(i.at),
        })
      ),
      ...rows(nd.unknownSends, (x) =>
        make('unknownSend', { skill: one(x.skill ?? ''), place: one(x.place ?? ''), when: when(x.at) })
      ),
      ...rows(nd.failedTurns, (x) => make('failedTurn', { code: one(x.code ?? ''), when: when(x.at) })),
    ];
    const notDoneMore = ['expired', 'missed', 'failedErrands', 'lateErrands', 'unknownSends', 'failedTurns'].reduce(
      (sum, key) => sum + (nd[key]?.more ?? 0),
      0
    );
    const told = nd.told > 0 ? make('told', { count: String(nd.told) }) : '';
    const filtered = since.filtered ?? {};
    const allFiltered = Array.isArray(filtered.items) ? filtered.items : [];
    const shownFiltered = allFiltered.slice(0, caps.filtered);
    const filteredRows = shownFiltered.map((x) => {
      const key = x.by === 'address' ? 'filteredAddress' : 'filteredMissed';
      const values = { when: when(x.at), place: one(x.place ?? ''), verdict: one(x.verdict ?? '') };
      // A line found in the record is worded with its author, its words and its handle; else the plain line.
      if (x.ref !== undefined && x.ref !== null && typeof l[`${key}Line`] === 'string' && l[`${key}Line`])
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
      block('filtered', filteredRows, (filtered.more ?? 0) + (allFiltered.length - shownFiltered.length));
    }
  }
  return out;
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
 * @param {{ locale?: string, handleBase?: number|null, onRefs?: (refs: number[]) => void }} [options]  `handleBase`: the number of a heartbeat's first line handle, `onRefs` gets the heartbeat lines' refs that stayed in (heartbeatLines).
 * @returns {string}
 */
export function wakeBlockText(wake, labels, { locale = 'en-US', handleBase = null, onRefs = null } = {}) {
  const l = labels?.wake;
  if (!wake || typeof l?.header !== 'string' || !l.header) return '';
  const timezone = wake.timezone || 'UTC';
  const when = (ts) =>
    Number.isFinite(ts) ? `${formatDate(ts, timezone, locale)} ${formatClock(ts, timezone, locale)}` : '';
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
        people: attend
          ? (Array.isArray(attend.peopleNames) && attend.peopleNames.length > 0
              ? attend.peopleNames
              : (attend.people ?? [])
            )
              .map((name) => oneLine(String(name)))
              .join(', ')
          : '',
        since: attend ? when(attend.since) : '',
      });
      const code = id ? wake.notes?.[id] : null;
      const note =
        code && typeof labels?.intentions?.notes?.[code] === 'string'
          ? fill(labels.intentions.notes[code], { task: '' })
          : '';
      lines.push(note ? `${line} · ${note}` : line);
    }
    // A wake that ran late because its first turn failed: how long since it was due, and the failure's code.
    if (item.delayed && typeof l.delayed === 'string' && l.delayed)
      lines.push(
        fill(l.delayed, { minutes: String(item.delayed.minutes ?? 0), code: String(item.delayed.code ?? '') })
      );
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
  const here = wake.here
    ? part(l, 'here', { channel: oneLine(String(wake.here.channel ?? '')), why: String(wake.here.why ?? '') })
    : wake.here === null
      ? part(l, 'hereNone', {})
      : '';
  if (here) lines.push(here);
  const expired = wake.expired;
  if (
    Array.isArray(expired?.items) &&
    expired.items.length > 0 &&
    typeof l.expired === 'string' &&
    l.expired &&
    typeof l.expiredItem === 'string' &&
    l.expiredItem
  ) {
    lines.push(l.expired);
    for (const item of expired.items)
      lines.push(
        fill(l.expiredItem, {
          id: String(item.id ?? ''),
          purpose: clampWithEllipsis(oneLine(String(item.purpose ?? '')), WAKE_PURPOSE_CHARS),
          when: when(item.at),
        })
      );
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
  const placesBlock = placesLines(wake.heartbeat?.places ?? wake.places ?? null, l);
  if (wake.heartbeat)
    lines.push(...heartbeatLines(wake.heartbeat, l.heartbeat, when, placesBlock, { handleBase, onRefs }));
  else lines.push(...placesBlock);
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
