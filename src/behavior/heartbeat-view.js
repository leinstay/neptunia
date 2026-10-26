// The heartbeat's facts (docs/inner-life.md "The heartbeat"; the wake kind `heartbeat` of
// src/behavior/inner.js): ONE function, no model, that reads the stores as they are today and
// answers what the `<wake>` of that kind shows (src/behavior/wake.js words it). It is the only
// place that knows where each fact lives, so the day the memory work brings its own store only
// this file changes, never the prompt or the wake mechanism.
//
//   people     up to `heartbeat.people` members she is closest to (the profiles' affinity): when she last
//              talked with them and where (the record: their own line, or a line of hers naming them,
//              else the profile's `lastSeen` with no place), the top 3 interests of the profile, the
//              places where they wrote lately (no presence or do-not-disturb state: the owner, 2026-10-20);
//              with `innerLife.heartbeat.focusSource` `db` the members come from her focus set instead (the injected
//              `focusPeople()`, src/memory/db/focus.js): the close members first, then the exploring ones with a share of
//              `focus.exploringShare` of `heartbeat.people` (rounded, at least one when there are any; more when the
//              close set leaves room). The reader returns null while the switch is off or the database is closed, and
//              the ranking by affinity applies as before;
//   places     (`activity`) where others wrote in the last `heartbeat.placesHours` (the record, her own lines
//              left out), the busiest first, each with its line count, who wrote and its last lines as previews;
//              the places page of the review stays passed through as `places`;
//   life       what she did in the last day (the actions of her inner turns from the journal that
//              really ran, her posts from the record, her errands with their goal, her diary posts, each once), her open intentions and attentions, and
//              the latest `heartbeat.closedShown` closed ones of hers of any state (done, cancelled, expired,
//              dropped), newest first, each with its outcome or reason, the rest counted;
//   skills     the names granted to her by family, and the errand agents;
//   since      what happened since her previous heartbeat (or the last day): what was done (counts),
//              what was not done or counted on (intentions expired, a recurring one missed, errands
//              failed or past their deadline, sends whose outcome is unknown, turns that ended in an
//              error, the facts already told to her as one count) and what was filtered without her
//              (the missed helper's dismissals and the address helper's "not to her"
//              verdicts, both from the journal's `answer` records).
//
// Every line quoted from the record (a place's, a person's last one, a filtered one) is a `ref` into `refs`:
// the turn numbers them (`#N`) and registers them like a memory.search quote's, and the wake words them.
// Every list is capped, the rest counted. A source that is missing or throws leaves its list empty
// (never the whole view); the log carries codes, never text. Pure apart from the reads it is given.

import { DAY_MS, HOUR_MS, utcDay } from '../time.js';
import { clampWithEllipsis, oneLine } from '../memory/clamp.js';
import { isOpen } from '../memory/interests.js';

/** The interests shown per person. */
export const INTERESTS_SHOWN = 3;
/** The places shown per person. */
export const PERSON_PLACES_SHOWN = 3;
/** The entries shown per list of her life and of what was not done; the rest is counted. */
export const LIST_SHOWN = 8;
/** The calls of an inner turn that post where people read (the diary is counted from its own store). */
const POSTED_SKILLS = Object.freeze(['message.create', 'draw.create', 'voice.say']);
/** The missed helper's verdicts that mean "left alone without her". */
export const DISMISSED_VERDICTS = Object.freeze(['intentional-skip', 'stale', 'uncertain']);
/** The defaults of the settings (`innerLife.heartbeat`; config.json carries the same). */
export const VIEW_DEFAULTS = Object.freeze({
  people: 8,
  filteredShown: 10,
  closedShown: 10,
  historyDays: 14,
  placesHours: 6,
  placesShown: 6,
  placeLines: 2,
  maxTokens: 2500,
});
/** The characters of a line's preview: in a place, as a person's last line, filtered, one of hers, an errand's goal, a diary gist. */
export const PREVIEW_CHARS = Object.freeze({ place: 140, person: 120, filtered: 100, post: 80, goal: 80, gist: 80 });
/** The names listed per place. */
const PLACE_PEOPLE_SHOWN = 6;
/** The calls that are her own sends (an unknown outcome of these is worth telling; an engine or helper action never is). */
const SEND_SKILLS = Object.freeze(['message.create', 'draw.create', 'voice.say', 'diary.post']);
/** The journal operations of the persona's own output that are sends (src/behavior/turn.js#journalOp names). */
const SEND_OPS = Object.freeze(['post', 'draw', 'gif']);

const list = (value) => (Array.isArray(value) ? value : []);
const text = (value) => (typeof value === 'string' ? oneLine(value) : '');
const num = (value) => (Number.isFinite(value) ? value : null);

/** `items` cut to `max`, the rest counted. */
function capped(items, max = LIST_SHOWN) {
  const cut = Math.max(0, Math.floor(max));
  return { items: items.slice(0, cut), more: Math.max(0, items.length - cut) };
}

/** The UTC days from the one of `from` through the one of `to`. */
function daysBetween(from, to) {
  const days = [];
  for (let at = from; utcDay(at) <= utcDay(to) && days.length < 40; at += DAY_MS) days.push(utcDay(at));
  if (!days.includes(utcDay(to))) days.push(utcDay(to));
  return days;
}

/** The last history entry of an intention record. */
const lastMove = (record) => list(record?.history).at(-1) ?? null;

/** When an intention record last changed: its last history entry's time, else `updatedAt`. */
function movedAt(record) {
  const at = lastMove(record)?.at;
  return Number.isFinite(at) ? at : num(record?.updatedAt);
}

/** Why a closed intention ended: its own `reason`, else the last history entry's, its note, its errand's outcome, else ''. */
function reasonOf(record) {
  const move = lastMove(record);
  for (const value of [record?.reason, record?.droppedReason, move?.reason, record?.note])
    if (typeof value === 'string' && value.trim()) return oneLine(value);
  const outcome = record?.outcome;
  if (outcome && typeof outcome === 'object')
    return oneLine([outcome.state, outcome.error].filter((part) => typeof part === 'string' && part).join(' '));
  return '';
}

/** A journal read that never throws: `[]` for a missing source or a failed read. */
async function readJournal(journal, guildId, from, to, kind, warn) {
  if (typeof journal?.read !== 'function') return [];
  const out = [];
  for (const day of daysBetween(from, to)) {
    try {
      out.push(...list(await journal.read(guildId, { day, kind, n: Number.MAX_SAFE_INTEGER })));
    } catch (error) {
      warn('journal', error);
    }
  }
  return out.filter((record) => {
    const at = Date.parse(record?.occurredAt);
    return Number.isFinite(at) && at >= from && at <= to;
  });
}

/** The media of a record line as `{ kinds, title }` (kinds from its `media` field, the title of its first link preview), or null when it has none. */
function mediaOf(line) {
  const kinds = [...new Set(list(line?.media).filter((kind) => typeof kind === 'string' && kind))];
  const title = text(list(line?.links)[0]?.title);
  if (kinds.length === 0 && !title) return null;
  return { kinds, title: clampWithEllipsis(title, 60) };
}

/**
 * One scan of the record: the last contact of each chosen member (their own line or one of hers that
 * names them), their own newest lines, the lines of others in the last `placesHours`, her own lines of
 * the last day and the lines named in `wantIds`. An edit replaces its earlier revision, a deleted message
 * is left out. Reads once; a failing source leaves everything empty.
 * @returns {Promise<{ contact: Map<string, { at: number, place: string }>, own: Map<string, object>, placeLines: object[], said: object[], byId: Map<string, object> }>}
 */
async function scanRecord({ record, guildId, now, settings, selfId, chosen, wantIds, warn }) {
  const out = { contact: new Map(), own: new Map(), placeLines: [], said: [], byId: new Map() };
  if (typeof record?.iterate !== 'function') return out;
  const historyFrom = now - settings.historyDays * DAY_MS;
  const placesFrom = now - settings.placesHours * HOUR_MS;
  const dayAgo = now - DAY_MS;
  const from = Math.min(historyFrom, placesFrom, dayAgo, ...(wantIds.size > 0 ? [now - 7 * DAY_MS] : []));
  const self = String(selfId ?? '');
  const latest = new Map();
  const deleted = new Set();
  try {
    for await (const line of record.iterate(guildId, { from: new Date(from).toISOString() })) {
      if (line?.kind === 'deleted' && typeof line.messageId === 'string') {
        deleted.add(line.messageId);
        continue;
      }
      if (line?.kind !== 'seen' && line?.kind !== 'said') continue;
      const at = Date.parse(line.occurredAt);
      const place = typeof line.scope?.channel === 'string' ? line.scope.channel : null;
      if (!Number.isFinite(at) || at > now || !place) continue;
      if (at >= historyFrom) {
        const who = line.kind === 'seen' ? [line.by] : list(line.participants);
        for (const id of who) {
          if (typeof id !== 'string' || !chosen.has(id)) continue;
          if (!out.contact.has(id) || out.contact.get(id).at < at) out.contact.set(id, { at, place });
        }
      }
      const id = typeof line.messageId === 'string' ? line.messageId : null;
      const keep =
        line.kind === 'said'
          ? at >= dayAgo
          : (typeof line.by === 'string' &&
              line.by !== self &&
              (at >= placesFrom || (chosen.has(line.by) && at >= historyFrom))) ||
            (id !== null && wantIds.has(id));
      if (!keep) continue;
      const entry = { line, at, place };
      if (id === null) {
        latest.set(`${line.kind}:${line.id ?? latest.size}`, entry);
        continue;
      }
      const held = latest.get(`${line.kind}:${id}`);
      if (!held || (line.revision ?? 1) >= (held.line.revision ?? 1)) latest.set(`${line.kind}:${id}`, entry);
    }
  } catch (error) {
    warn('record', error);
  }
  const entries = [...latest.values()]
    .filter(({ line }) => !(typeof line.messageId === 'string' && deleted.has(line.messageId)))
    .sort((a, b) => a.at - b.at);
  for (const entry of entries) {
    const { line, at } = entry;
    if (line.kind === 'said') {
      out.said.push(entry);
      continue;
    }
    if (typeof line.messageId === 'string') out.byId.set(line.messageId, entry);
    if (line.by !== self && at >= placesFrom) out.placeLines.push(entry);
    if (chosen.has(line.by) && at >= historyFrom) out.own.set(line.by, entry);
  }
  return out;
}

/**
 * The numbered lines the view hands out: one ref per record line (`{ id, channelId, authorId, self, message }`,
 * the shape of the handles a memory.search quotes, src/behavior/turn.js#searchHandles), in the order first asked;
 * the wake words each as `#N` once the turn numbers them.
 */
function refBook() {
  const refs = [];
  const byId = new Map();
  return {
    refs,
    refOf({ line, place }, authorId = null) {
      const id = typeof line.messageId === 'string' ? line.messageId : null;
      if (!id) return null;
      if (byId.has(id)) return byId.get(id);
      const links = list(line.links).map((item) => ({
        kind: 'link',
        url: item.url,
        title: item.title,
        text: item.description,
        site: item.site,
      }));
      refs.push({
        id,
        channelId: place,
        authorId: authorId ?? line.by ?? null,
        self: false,
        message: {
          id,
          channelId: place,
          authorId: authorId ?? line.by ?? null,
          content: typeof line.text === 'string' ? line.text : '',
          ts: Date.parse(line.occurredAt),
          links,
        },
      });
      byId.set(id, refs.length - 1);
      return refs.length - 1;
    },
  };
}

/** A line as the wake shows it: its time, a preview cut to `chars`, its media marker and its ref. */
function previewOf(entry, chars, book) {
  const media = mediaOf(entry.line);
  return {
    at: entry.at,
    text: clampWithEllipsis(text(entry.line.text), chars),
    ...(media ? { media } : {}),
    ref: book.refOf(entry),
  };
}

/**
 * The places block: the places where others wrote in the last `placesHours`, the busiest first, each with
 * its line count, who wrote and the last `placeLines` lines (each with a handle).
 */
function activityOf({ scan, settings, book, nameOf, placeName }) {
  const groups = new Map();
  for (const entry of scan.placeLines) {
    if (!groups.has(entry.place)) groups.set(entry.place, []);
    groups.get(entry.place).push(entry);
  }
  const safeName = (id) => {
    try {
      return text(nameOf?.(id)) || id;
    } catch {
      return id;
    }
  };
  const ranked = [...groups]
    .map(([id, lines]) => ({ id, lines }))
    .sort((a, b) => b.lines.length - a.lines.length || b.lines.at(-1).at - a.lines.at(-1).at || (a.id < b.id ? -1 : 1));
  const shown = ranked.slice(0, Math.max(0, settings.placesShown));
  return {
    total: ranked.length,
    more: Math.max(0, ranked.length - shown.length),
    items: shown.map(({ id, lines }) => ({
      id,
      name: placeName(id),
      lines: lines.length,
      people: [...new Set(lines.map((entry) => entry.line.by))].slice(0, PLACE_PEOPLE_SHOWN).map(safeName),
      previews: lines
        .slice(-Math.max(0, settings.placeLines))
        .map((entry) => ({ ...previewOf(entry, PREVIEW_CHARS.place, book), by: safeName(entry.line.by) })),
    })),
  };
}

/**
 * The people block: the members she is closest to with their facts.
 * @returns {object[]}
 */
function peopleOf({ ranked, scan, book, nameOf, placeName, activePlaces, warn }) {
  const safe = (fn, fallback) => {
    try {
      return fn() ?? fallback;
    } catch (error) {
      warn('person', error);
      return fallback;
    }
  };
  return ranked.map(({ profile, seen }) => {
    const contact = scan.contact.get(profile.id) ?? null;
    const own = scan.own.get(profile.id) ?? null;
    const interests = list(profile.interests)
      .filter((item) => item && typeof item.topic === 'string' && item.topic.trim() && isOpen(item))
      .sort((a, b) => (Number.isFinite(b.weight) ? b.weight : 0) - (Number.isFinite(a.weight) ? a.weight : 0))
      .slice(0, INTERESTS_SHOWN)
      .map((item) => oneLine(item.topic));
    return {
      id: profile.id,
      name: safe(() => nameOf?.(profile.id), null) ?? text(list(profile.names)[0]) ?? profile.id,
      lastAt: contact ? contact.at : Number.isFinite(seen) ? seen : null,
      lastPlace: contact ? safe(() => placeName?.(contact.place), contact.place) : null,
      lastWrote: own ? { ...previewOf(own, PREVIEW_CHARS.person, book), place: placeName(own.place) } : null,
      interests,
      places: list(safe(() => activePlaces?.(profile.id), []))
        .slice(0, PERSON_PLACES_SHOWN)
        .map(text)
        .filter(Boolean),
    };
  });
}

/** The members she is closest to, in order, capped at `settings.people`. */
function closestOf({ profiles, selfId, settings }) {
  return list(profiles)
    .filter((profile) => profile && typeof profile.id === 'string' && profile.id !== String(selfId ?? ''))
    .map((profile) => ({
      profile,
      score: Number.isFinite(profile.affinity?.score) ? profile.affinity.score : 0,
      seen: Date.parse(profile.lastSeen),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        (Number.isFinite(b.seen) ? b.seen : -Infinity) - (Number.isFinite(a.seen) ? a.seen : -Infinity) ||
        (a.profile.id < b.profile.id ? -1 : 1)
    )
    .slice(0, Math.max(0, settings.people));
}

/**
 * The members of her focus set, in the view's order: the close ones first, then the exploring ones with their share of
 * `settings.people` (see the head of this file). `focus`: `{ close: string[], exploring: string[], exploringShare }`.
 */
function focusedOf({ focus, profiles, selfId, settings }) {
  const self = String(selfId ?? '');
  const byId = new Map(
    list(profiles)
      .filter((profile) => profile && typeof profile.id === 'string')
      .map((profile) => [profile.id, profile])
  );
  const ids = (value) => [...new Set(list(value).filter((id) => typeof id === 'string' && id && id !== self))];
  const close = ids(focus.close);
  const exploring = ids(focus.exploring).filter((id) => !close.includes(id));
  const n = Math.max(0, Math.floor(settings.people));
  const share = Number.isFinite(focus.exploringShare) && focus.exploringShare >= 0 ? focus.exploringShare : 0.15;
  const slots = exploring.length > 0 && n > 0 ? Math.min(exploring.length, Math.max(1, Math.round(share * n))) : 0;
  const shownClose = close.slice(0, n - slots);
  const shownExploring = exploring.slice(0, n - shownClose.length);
  return [...shownClose, ...shownExploring].map((id) => {
    const profile = byId.get(id) ?? { id };
    return { profile, seen: Date.parse(profile.lastSeen) };
  });
}

/** The focus sets the injected reader gives, or null (the switch off, the database closed, a failing read). */
function readFocus(focusPeople, warn) {
  if (typeof focusPeople !== 'function') return null;
  try {
    const sets = focusPeople();
    return sets && typeof sets === 'object' && (Array.isArray(sets.close) || Array.isArray(sets.exploring))
      ? sets
      : null;
  } catch (error) {
    warn('focus', error);
    return null;
  }
}

/** Her life: the last day, her open intentions and the latest closed ones. */
function lifeOf({ now, settings, innerTurns, tasks, diary, intentions, placeName, scan }) {
  const dayAgo = now - DAY_MS;
  const actions = [];
  for (const turn of innerTurns) {
    const at = Date.parse(turn.occurredAt);
    for (const action of list(turn.actions)) {
      if (action?.status !== 'executed' || action.result !== 'ok' || typeof action.skill !== 'string') continue;
      // A message she sent is listed from the record (with its words), a diary post from the diary: never twice.
      if (action.skill === 'message.create' || action.skill === 'diary.post') continue;
      actions.push({
        at,
        skill: action.skill,
        place:
          typeof action.target?.channel === 'string'
            ? placeName(action.target.channel)
            : typeof action.target === 'string'
              ? text(action.target)
              : null,
      });
    }
  }
  actions.sort((a, b) => b.at - a.at);
  const errands = tasks
    .filter(
      (task) => task?.requester?.kind === 'persona' && Number.isFinite(task.createdAt) && task.createdAt >= dayAgo
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((task) => ({
      id: String(task.id),
      agent: String(task.agent ?? ''),
      state: String(task.state ?? ''),
      at: task.createdAt,
      goal: clampWithEllipsis(text(task.goal), PREVIEW_CHARS.goal),
    }));
  const posts = diary
    .filter((post) => Number.isFinite(post?.at) && post.at >= dayAgo)
    .sort((a, b) => b.at - a.at)
    .map((post) => ({
      at: post.at,
      kind: typeof post.kind === 'string' ? post.kind : null,
      gist: clampWithEllipsis(text(post.gist), PREVIEW_CHARS.gist),
    }));
  // Her own posts of the last day from the record (a diary post is listed once, from the diary).
  const diaryIds = new Set(diary.flatMap((post) => list(post?.messageIds)).map(String));
  const sent = list(scan?.said)
    .filter(({ line }) => !diaryIds.has(String(line.messageId)))
    .sort((a, b) => b.at - a.at)
    .map((entry) => ({
      at: entry.at,
      place: placeName(entry.place),
      text: clampWithEllipsis(text(entry.line.text), PREVIEW_CHARS.post),
      ...(mediaOf(entry.line) ? { media: mediaOf(entry.line) } : {}),
    }));
  const open = intentions
    .filter((record) => (record?.status === 'pending' || record?.status === 'waiting') && !record.attend)
    .sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity))
    .map((record) => ({
      id: String(record.id),
      purpose: text(record.purpose),
      status: record.status,
      dueAt: num(record.dueAt),
      ...(record.origin === 'heartbeat' ? { origin: 'heartbeat' } : {}),
    }));
  const attending = intentions
    .filter((record) => record?.status === 'pending' && record.attend)
    .map((record) => ({
      id: String(record.id),
      purpose: text(record.purpose),
      place: placeName(String(record.attend.place ?? '')),
    }));
  const closed = intentions
    .filter(
      (record) =>
        ['done', 'cancelled', 'expired', 'dropped'].includes(record?.status) && record.provenance?.kind !== 'candidate'
    )
    .sort((a, b) => (movedAt(b) ?? 0) - (movedAt(a) ?? 0))
    .map((record) => ({
      id: String(record.id),
      purpose: text(record.purpose),
      state: record.status,
      why: reasonOf(record),
      at: movedAt(record),
    }));
  return {
    actions: capped(actions),
    posts: capped(sent),
    errands: capped(errands),
    diary: capped(posts),
    open: capped(open),
    attending: capped(attending),
    closed: capped(closed, settings.closedShown),
  };
}

/** Skills by family (the part of the name before its first dot), in the order given. */
function skillFamilies(names) {
  const families = new Map();
  for (const name of list(names)) {
    if (typeof name !== 'string' || !name) continue;
    const dot = name.indexOf('.');
    const family = dot === -1 ? name : name.slice(0, dot);
    const rest = dot === -1 ? name : name.slice(dot + 1);
    if (!families.has(family)) families.set(family, []);
    families.get(family).push(rest);
  }
  return [...families].map(([family, rest]) => ({ family, names: rest }));
}

/** Whether an `unknown` action record is one of her own sends (a post, a picture, a GIF, message.create, draw.create, diary.post), never an engine or helper action. */
function isOwnSend(record) {
  if (record?.by !== undefined && record.by !== 'persona') return false;
  const skill = text(record?.input?.skill) || text(record?.name);
  if (record?.name === 'skill' || record?.input?.skill) return SEND_SKILLS.includes(skill);
  return SEND_SKILLS.includes(skill) || (record?.by === 'persona' && SEND_OPS.includes(skill));
}

/** What the helpers filtered without her, newest first: the address helper's "not to her" and the missed helper's dismissals. */
function filteredOf({ from, now, missedVerdicts, addressVerdicts, placeName }) {
  const within = (at) => Number.isFinite(at) && at >= from && at <= now;
  return [
    ...list(addressVerdicts)
      .filter((item) => within(item?.at))
      .map((item) => ({
        at: item.at,
        place: placeName(String(item.channelId ?? '')),
        by: 'address',
        ...(item.messageId ? { messageId: String(item.messageId) } : {}),
        ...(item.authorId ? { authorId: String(item.authorId) } : {}),
      })),
    ...missedVerdicts
      .filter((record) => DISMISSED_VERDICTS.includes(record?.verdict) && within(Date.parse(record.occurredAt)))
      .map((record) => ({
        at: Date.parse(record.occurredAt),
        place: typeof record.scope?.channel === 'string' ? placeName(record.scope.channel) : null,
        by: 'missed',
        verdict: record.verdict,
        ...(record.messageId ? { messageId: String(record.messageId) } : {}),
        ...(record.authorId ? { authorId: String(record.authorId) } : {}),
      })),
  ].sort((a, b) => b.at - a.at);
}

/** What happened since `from`: done, not done, filtered. */
function sinceOf({
  from,
  now,
  settings,
  innerTurns,
  tasks,
  intentions,
  diary,
  unknownSends,
  arrived,
  innerState,
  filtered,
  placeName,
}) {
  const within = (at) => Number.isFinite(at) && at >= from && at <= now;
  let posts = 0;
  for (const turn of innerTurns) {
    if (!within(Date.parse(turn.occurredAt))) continue;
    posts += list(turn.actions).filter(
      (action) => action?.status === 'executed' && action.result === 'ok' && POSTED_SKILLS.includes(action.skill)
    ).length;
  }
  posts += diary.filter((post) => within(post?.at)).length;
  const errandsDone = tasks.filter(
    (task) => task?.state === 'done' && within(task.endedAt) && task.requester?.kind === 'persona'
  ).length;
  const fulfilled = intentions.filter((record) => record?.status === 'done' && within(movedAt(record))).length;

  const expired = intentions
    .filter(
      (record) => record?.status === 'expired' && record.provenance?.kind !== 'candidate' && within(movedAt(record))
    )
    .sort((a, b) => movedAt(b) - movedAt(a))
    .map((record) => ({ id: String(record.id), purpose: text(record.purpose), at: movedAt(record) }));
  const missed = [];
  const late = [];
  for (const record of intentions) {
    for (const move of list(record?.history)) {
      if (!within(move?.at)) continue;
      if (move.code === 'missed') missed.push({ id: String(record.id), purpose: text(record.purpose), at: move.at });
      if (move.code === 'wait-deadline')
        late.push({ id: String(record.id), purpose: text(record.purpose), at: move.at });
    }
  }
  const failedErrands = tasks
    .filter((task) => task?.state === 'failed' && within(task.endedAt) && task.requester?.kind === 'persona')
    .sort((a, b) => b.endedAt - a.endedAt)
    .map((task) => ({
      id: String(task.id),
      agent: String(task.agent ?? ''),
      at: task.endedAt,
      code: typeof task.error?.code === 'string' ? task.error.code : null,
    }));
  const newest = (items) => items.sort((a, b) => b.at - a.at);
  const sends = unknownSends
    .filter(isOwnSend)
    .filter((record) => !(text(record.opId) && arrived.has(record.opId)))
    .map((record) => ({
      at: Date.parse(record.occurredAt),
      skill: text(record.input?.skill) || text(record.name) || null,
      place: typeof record.scope?.channel === 'string' ? placeName(record.scope.channel) : null,
    }))
    .filter((send) => within(send.at));
  const errored = list(innerState?.turns)
    .filter((turn) => turn?.outcome === 'error' && within(turn.at))
    .map((turn) => ({ at: turn.at, code: typeof turn.code === 'string' ? turn.code : null }));
  const told = list(innerState?.facts).filter((fact) => Number.isFinite(fact?.told) && within(fact.told)).length;

  return {
    from,
    done: { posts, errands: errandsDone, intentions: fulfilled },
    notDone: {
      expired: capped(expired),
      missed: capped(newest(missed)),
      failedErrands: capped(failedErrands),
      lateErrands: capped(newest(late)),
      unknownSends: capped(newest(sends)),
      failedTurns: capped(newest(errored)),
      told,
    },
    filtered,
  };
}

/**
 * The heartbeat's facts for `<wake>` (src/behavior/wake.js words them).
 * @param {object} input
 * @param {string} input.guildId
 * @param {number} input.now
 * @param {number|null} [input.since]  Her previous heartbeat (epoch ms); null: the last day.
 * @param {{ people?: number, filteredShown?: number, closedShown?: number, historyDays?: number }} [input.settings]
 * @param {object[]} [input.profiles]  The member profiles (store.listUserProfiles).
 * @param {string|null} [input.selfId]  Her own member id (left out of the people).
 * @param {{ iterate?: Function }|null} [input.record]  The record, for the last contact.
 * @param {{ read?: Function }|null} [input.journal]  The journal: her inner turns, unknown sends, the missed helper's verdicts.
 * @param {object[]} [input.intentions]  Her intention records, every status.
 * @param {object[]} [input.tasks]  Her errands (the task store's recent list).
 * @param {object[]} [input.diary]  Her diary posts (`{ at, kind }`).
 * @param {object|null} [input.places]  The places page of the review (inner.js#places).
 * @param {string[]} [input.skills]  The skill names granted to her.
 * @param {string[]} [input.agents]  The errand agents she can hand work to.
 * @param {object|null} [input.innerState]  The inner state (turns that ended in error, the facts told).
 * @param {object[]|(() => object[])|null} [input.addressVerdicts]  `{ at, channelId }` of the address helper's "not to her"; the journal's `address` records are added by the view.
 * @param {(id: string) => string|null} [input.nameOf]
 * @param {(id: string) => string} [input.placeName]
 * @param {(memberId: string) => string[]} [input.activePlaces]  Where a member wrote lately (names).
 * @param {(() => ({ close: string[], exploring: string[], exploringShare?: number }|null))|null} [input.focusPeople]
 *   Her focus set as member ids (`innerLife.heartbeat.focusSource` `db`); null or absent: the profiles' affinity ranks.
 * @param {{ warn?: Function }} [input.log]
 * @returns {Promise<object>}
 */
export async function buildHeartbeatFacts({
  guildId,
  now,
  since = null,
  settings = {},
  profiles = [],
  selfId = null,
  record = null,
  journal = null,
  intentions = [],
  tasks = [],
  diary = [],
  places = null,
  skills = [],
  agents = [],
  innerState = null,
  addressVerdicts = null,
  nameOf = null,
  placeName = (id) => id,
  activePlaces = null,
  focusPeople = null,
  log = null,
}) {
  const s = {
    ...VIEW_DEFAULTS,
    ...Object.fromEntries(Object.entries(settings ?? {}).filter(([, value]) => Number.isFinite(value) && value >= 0)),
  };
  const warn = (what, error) => log?.warn?.('heartbeat: source failed', { source: what, code: error?.code ?? null });
  const place = (id) => {
    try {
      return text(placeName(String(id))) || String(id);
    } catch {
      return String(id);
    }
  };
  const from = Number.isFinite(since) && since < now ? Math.max(since, now - 7 * DAY_MS) : now - DAY_MS;
  const windowStart = Math.min(from, now - DAY_MS);
  const [innerTurns, actionRecords, answers] = await Promise.all([
    readJournal(journal, guildId, windowStart, now, 'inner', warn).then((records) =>
      records.filter((entry) => entry.event === 'turn')
    ),
    readJournal(journal, guildId, from, now, 'action', warn),
    readJournal(journal, guildId, from, now, 'answer', warn),
  ]);
  const unknownSends = actionRecords.filter((entry) => entry.phase === 'unknown');
  // A send whose message arrived later (a succeeded line of the same operation) is not unknown any more.
  const arrived = new Set(
    actionRecords.filter((entry) => entry.phase === 'succeeded' && text(entry.opId)).map((entry) => entry.opId)
  );
  const journalAddress = answers
    .filter((entry) => entry.event === 'address')
    .map((entry) => ({
      at: Date.parse(entry.at ?? entry.occurredAt),
      channelId: entry.channelId ?? entry.scope?.channel ?? '',
      messageId: entry.messageId ?? null,
      authorId: entry.authorId ?? null,
    }));
  let address = [];
  try {
    address = list(typeof addressVerdicts === 'function' ? addressVerdicts() : addressVerdicts);
  } catch (error) {
    warn('address', error);
  }
  const focus = readFocus(focusPeople, warn);
  const ranked = focus
    ? focusedOf({ focus, profiles, selfId, settings: s })
    : closestOf({ profiles, selfId, settings: s });
  const filteredAll = filteredOf({
    from,
    now,
    missedVerdicts: answers.filter((entry) => entry.event === 'verdict'),
    addressVerdicts: [...address, ...journalAddress],
    placeName: place,
  });
  const filteredShown = filteredAll.slice(0, s.filteredShown);
  const scan = await scanRecord({
    record,
    guildId,
    now,
    settings: s,
    selfId,
    chosen: new Set(ranked.map(({ profile }) => profile.id)),
    wantIds: new Set(filteredShown.map((item) => item.messageId).filter(Boolean)),
    warn,
  });
  const book = refBook();
  const profileNames = new Map(
    list(profiles)
      .filter((profile) => profile && typeof profile.id === 'string')
      .map((profile) => [profile.id, text(list(profile.names)[0])])
  );
  const nameFor = (id) => {
    try {
      return text(nameOf?.(String(id))) || profileNames.get(String(id)) || null;
    } catch {
      return profileNames.get(String(id)) || null;
    }
  };
  const activity =
    typeof record?.iterate === 'function'
      ? activityOf({ scan, settings: s, book, nameOf: (id) => nameFor(id) ?? id, placeName: place })
      : null;
  const people = peopleOf({ ranked, scan, book, nameOf, placeName: place, activePlaces, warn });
  const filtered = filteredShown.map(({ messageId, authorId, ...item }) => {
    const entry = messageId ? scan.byId.get(messageId) : null;
    const who = nameFor(authorId ?? entry?.line.by ?? '') ?? authorId ?? entry?.line.by ?? null;
    return { ...item, ...(who ? { who } : {}), ...(entry ? previewOf(entry, PREVIEW_CHARS.filtered, book) : {}) };
  });
  const common = {
    now,
    settings: s,
    innerTurns,
    tasks: list(tasks),
    diary: list(diary),
    intentions: list(intentions).filter(Boolean),
    placeName: place,
    scan,
  };
  return {
    people,
    places: places ?? null,
    activity,
    refs: book.refs,
    maxTokens: s.maxTokens,
    intentionsOnly: settings?.intentionsOnly === true,
    life: lifeOf(common),
    skills: skillFamilies(skills),
    agents: list(agents).filter((name) => typeof name === 'string' && name),
    since: sinceOf({
      ...common,
      from,
      unknownSends,
      arrived,
      innerState,
      filtered: { items: filtered, more: Math.max(0, filteredAll.length - filtered.length), total: filteredAll.length },
    }),
  };
}
