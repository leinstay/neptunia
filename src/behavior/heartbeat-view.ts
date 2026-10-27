// The heartbeat's facts (docs/inner-life.md "The heartbeat"; the wake kind `heartbeat` of
// src/behavior/inner.ts): ONE function, no model, that reads the stores as they are today and
// answers what the `<wake>` of that kind shows (src/behavior/wake.ts words it). It is the only
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
//              (the missed check's dismissals and the address check's "not to her"
//              verdicts, both from the journal's `answer` records).
//
// Every line quoted from the record (a place's, a person's last one, a filtered one) is a `ref` into `refs`:
// the turn numbers them (`#N`) and registers them like a memory.search quote's, and the wake words them.
// Every list is capped, the rest counted. A source that is missing or throws leaves its list empty
// (never the whole view); the log carries codes, never text. Pure apart from the reads it is given.

import { DAY_MS, HOUR_MS, utcDay } from '../time.js';
import { clampWithEllipsis, oneLine } from '../memory/clamp.js';
import { isOpen } from '../memory/interests.js';
import { currentToolName } from '../tools/definitions.ts';
import { isFiniteNumber, isObj, listOf, objOf } from '../tools/types.ts';
import type { Obj } from '../tools/types.ts';
import type { PlacesPage, RecordSource } from './inner/types.ts';

/** The interests shown per person. */
export const INTERESTS_SHOWN = 3;
/** The places shown per person. */
export const PERSON_PLACES_SHOWN = 3;
/** The entries shown per list of her life and of what was not done; the rest is counted. */
export const LIST_SHOWN = 8;
/** The calls of an inner turn that post where people read (the diary is counted from its own store). */
const POSTED_SKILLS: ReadonlyArray<unknown> = Object.freeze(['message.create', 'draw.create', 'voice.say']);
/** The missed check's verdicts that mean "left alone without her". */
export const DISMISSED_VERDICTS: ReadonlyArray<unknown> = Object.freeze(['intentional-skip', 'stale', 'uncertain']);
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
/** The calls that are her own sends (an unknown outcome of these is worth telling; an engine or model role action never is). */
const SEND_SKILLS: ReadonlyArray<unknown> = Object.freeze(['message.create', 'draw.create', 'voice.say', 'diary.post']);
/** The journal operations of the persona's own output that are sends (src/behavior/turn.js#journalOp names). */
const SEND_OPS: ReadonlyArray<unknown> = Object.freeze(['post', 'draw', 'gif']);

/** A list of at most a shown number of entries, and how many more there were. */
export type Capped<TItem> = { items: Array<TItem>; more: number };
/** A line's media: the kinds it carried and the title of its first link preview. */
export type Media = { kinds: Array<string>; title: string };
/** A line as the wake shows it: its time, its preview, its media and its ref into `refs`. */
export type Preview = { at: number; text: string; media?: Media; ref: number | null };
/** One numbered line (`#N` once the turn numbers it), in the shape of a memory.search quote's handle. */
export type HeartbeatRef = {
  id: string;
  channelId: string;
  authorId: unknown;
  self: false;
  message: {
    id: string;
    channelId: string;
    authorId: unknown;
    content: string;
    ts: number;
    links: Array<{ kind: 'link'; url: unknown; title: unknown; text: unknown; site: unknown }>;
  };
};
/** One place where others wrote lately. */
export type ActivityPlace = {
  id: string;
  name: string;
  lines: number;
  people: Array<unknown>;
  previews: Array<Preview & { by: unknown }>;
};
/** The places where others wrote lately, the busiest first. */
export type Activity = { total: number; more: number; items: Array<ActivityPlace> };
/** One member she is close to. */
export type Person = {
  id: string;
  name: unknown;
  lastAt: number | null;
  lastPlace: string | null;
  lastWrote: (Preview & { place: string }) | null;
  interests: Array<string>;
  places: Array<string>;
};
/** One action of an inner turn that really ran. */
export type LifeAction = { at: number; skill: unknown; place: string | null };
/** One post of hers from the record. */
export type LifePost = { at: number; place: string; text: string; media?: Media };
/** One errand of hers. */
export type LifeErrand = { id: string; agent: string; state: string; at: number; goal: string };
/** One diary post of hers. */
export type LifeDiary = { at: number; kind: string | null; gist: string };
/** One open intention of hers. */
export type LifeOpen = { id: string; purpose: string; status: unknown; dueAt: number | null; origin?: 'heartbeat' };
/** One attention of hers. */
export type LifeAttending = { id: string; purpose: string; place: string };
/** One closed intention of hers. */
export type LifeClosed = { id: string; purpose: string; state: unknown; why: string; at: number | null };
/** Her life: the last day, her open intentions and the latest closed ones. */
export type Life = {
  actions: Capped<LifeAction>;
  posts: Capped<LifePost>;
  errands: Capped<LifeErrand>;
  diary: Capped<LifeDiary>;
  open: Capped<LifeOpen>;
  attending: Capped<LifeAttending>;
  closed: Capped<LifeClosed>;
};
/** A skill family and the names granted in it. */
export type SkillFamily = { family: string; names: Array<string> };
/** An intention that expired, was missed or waited past its errand's deadline. */
export type NotDoneIntention = { id: string; purpose: string; at: number };
/** One line the analyzer filtered without her. */
export type FilteredLine = {
  at: number;
  place: string | null;
  by: 'address' | 'missed';
  verdict?: unknown;
  who?: unknown;
} & Partial<Preview>;
/** What happened since her previous heartbeat. */
export type Since = {
  from: number;
  done: { posts: number; errands: number; intentions: number };
  notDone: {
    expired: Capped<NotDoneIntention>;
    missed: Capped<NotDoneIntention>;
    failedErrands: Capped<{ id: string; agent: string; at: number; code: string | null }>;
    lateErrands: Capped<NotDoneIntention>;
    unknownSends: Capped<{ at: number; skill: unknown; place: string | null }>;
    failedTurns: Capped<{ at: number; code: string | null }>;
    told: number;
  };
  filtered: { items: Array<FilteredLine>; more: number; total: number };
};
/** The heartbeat's facts for `<wake>`. */
export type HeartbeatFacts = {
  people: Array<Person>;
  places: PlacesPage | null;
  activity: Activity | null;
  refs: Array<HeartbeatRef>;
  maxTokens: number;
  intentionsOnly: boolean;
  life: Life;
  skills: Array<SkillFamily>;
  agents: Array<string>;
  since: Since;
};

/** The view's numbers: VIEW_DEFAULTS with the given settings over them. */
type ViewSettings = { [key: string]: number } & typeof VIEW_DEFAULTS;
/** What tells the log that a source failed. */
type Warn = (what: string, error: unknown) => void;
/** One line of the record kept by the scan, with its time and place. */
type ScanEntry = { line: Obj; at: number; place: string };
/** What one scan of the record found. */
type Scan = {
  contact: Map<string, { at: number; place: string }>;
  own: Map<unknown, ScanEntry>;
  placeLines: Array<ScanEntry>;
  said: Array<ScanEntry>;
  byId: Map<string, ScanEntry>;
};
/** The journal as the view reads it. */
type JournalSource = { read?(guildId: string, query: { day: string; kind: string; n: number }): unknown } | null;
/** The refs the view hands out and the function that numbers a line. */
type RefBook = { refs: Array<HeartbeatRef>; refOf(entry: ScanEntry, authorId?: unknown): number | null };
/** A member chosen for the people block: the profile and when it was last seen. */
type Ranked = { profile: Obj; seen: number };
/** The focus sets the reader gives. */
type Focus = { close?: unknown; exploring?: unknown; exploringShare?: unknown };

const text = (value: unknown): string => (typeof value === 'string' ? oneLine(value) : '');
const num = (value: unknown): number | null => (isFiniteNumber(value) ? value : null);
/** `value` as text (String over a value of any type). */
const asText = (value: unknown): string => String(value);
/** A time of a record or journal line: Date.parse over its text. */
const parseAt = (value: unknown): number => Date.parse(asText(value));

/** `items` cut to `max`, the rest counted. */
function capped<TItem>(items: Array<TItem>, max: number = LIST_SHOWN): Capped<TItem> {
  const cut = Math.max(0, Math.floor(max));
  return { items: items.slice(0, cut), more: Math.max(0, items.length - cut) };
}

/** The UTC days from the one of `from` through the one of `to`. */
function daysBetween(from: number, to: number): Array<string> {
  const days: Array<string> = [];
  for (let at = from; utcDay(at) <= utcDay(to) && days.length < 40; at += DAY_MS) days.push(utcDay(at));
  if (!days.includes(utcDay(to))) days.push(utcDay(to));
  return days;
}

/** The last history entry of an intention record. */
const lastMove = (record: Obj): Obj | null => {
  const move = listOf(record.history).at(-1) ?? null;
  return move === null ? null : objOf(move);
};

/** When an intention record last changed: its last history entry's time, else `updatedAt`. */
function movedAt(record: Obj): number | null {
  const at = lastMove(record)?.at;
  return isFiniteNumber(at) ? at : num(record.updatedAt);
}

/** Why a closed intention ended: its own `reason`, else the last history entry's, its note, its errand's outcome, else ''. */
function reasonOf(record: Obj): string {
  const move = lastMove(record);
  for (const value of [record.reason, record.droppedReason, move?.reason, record.note])
    if (typeof value === 'string' && value.trim()) return oneLine(value);
  const outcome = record.outcome;
  if (isObj(outcome) || Array.isArray(outcome)) {
    const { state, error } = objOf(outcome);
    return oneLine([state, error].filter((part) => typeof part === 'string' && part).join(' '));
  }
  return '';
}

/** A journal read that never throws: `[]` for a missing source or a failed read. */
async function readJournal(
  journal: JournalSource,
  guildId: string,
  from: number,
  to: number,
  kind: string,
  warn: Warn
): Promise<Array<Obj>> {
  if (typeof journal?.read !== 'function') return [];
  const out: Array<unknown> = [];
  for (const day of daysBetween(from, to)) {
    try {
      out.push(...listOf(await journal.read(guildId, { day, kind, n: Number.MAX_SAFE_INTEGER })));
    } catch (error) {
      warn('journal', error);
    }
  }
  return out.filter((record): record is Obj => {
    const at = parseAt(objOf(record).occurredAt);
    return isObj(record) && Number.isFinite(at) && at >= from && at <= to;
  });
}

/** The media of a record line as `{ kinds, title }` (kinds from its `media` field, the title of its first link preview), or null when it has none. */
function mediaOf(line: Obj): Media | null {
  const kinds = [
    ...new Set(listOf(line.media).filter((kind): kind is string => typeof kind === 'string' && kind !== '')),
  ];
  const title = text(objOf(listOf(line.links)[0]).title);
  if (kinds.length === 0 && !title) return null;
  return { kinds, title: clampWithEllipsis(title, 60) };
}

/**
 * One scan of the record: the last contact of each chosen member (their own line or one of hers that
 * names them), their own newest lines, the lines of others in the last `placesHours`, her own lines of
 * the last day and the lines named in `wantIds`. An edit replaces its earlier revision, a deleted message
 * is left out. Reads once; a failing source leaves everything empty.
 */
async function scanRecord({
  record,
  guildId,
  now,
  settings,
  selfId,
  chosen,
  wantIds,
  warn,
}: {
  record: RecordSource | null;
  guildId: string;
  now: number;
  settings: ViewSettings;
  selfId: unknown;
  chosen: ReadonlySet<unknown>;
  wantIds: ReadonlySet<unknown>;
  warn: Warn;
}): Promise<Scan> {
  const out: Scan = { contact: new Map(), own: new Map(), placeLines: [], said: [], byId: new Map() };
  if (typeof record?.iterate !== 'function') return out;
  const historyFrom = now - settings.historyDays * DAY_MS;
  const placesFrom = now - settings.placesHours * HOUR_MS;
  const dayAgo = now - DAY_MS;
  const from = Math.min(historyFrom, placesFrom, dayAgo, ...(wantIds.size > 0 ? [now - 7 * DAY_MS] : []));
  const self = asText(selfId ?? '');
  const latest = new Map<string, ScanEntry>();
  const deleted = new Set<string>();
  try {
    for await (const raw of record.iterate(guildId, { from: new Date(from).toISOString() })) {
      const line = objOf(raw);
      if (line.kind === 'deleted' && typeof line.messageId === 'string') {
        deleted.add(line.messageId);
        continue;
      }
      if (line.kind !== 'seen' && line.kind !== 'said') continue;
      const at = parseAt(line.occurredAt);
      const channel = objOf(line.scope).channel;
      const place = typeof channel === 'string' ? channel : null;
      if (!Number.isFinite(at) || at > now || !place) continue;
      if (at >= historyFrom) {
        const who = line.kind === 'seen' ? [line.by] : listOf(line.participants);
        for (const id of who) {
          if (typeof id !== 'string' || !chosen.has(id)) continue;
          const known = out.contact.get(id);
          if (!known || known.at < at) out.contact.set(id, { at, place });
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
        latest.set(`${line.kind}:${asText(line.id ?? latest.size)}`, entry);
        continue;
      }
      const held = latest.get(`${line.kind}:${id}`);
      if (!held || Number(line.revision ?? 1) >= Number(held.line.revision ?? 1))
        latest.set(`${line.kind}:${id}`, entry);
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
function refBook(): RefBook {
  const refs: Array<HeartbeatRef> = [];
  const byId = new Map<string, number>();
  return {
    refs,
    refOf({ line, place }: ScanEntry, authorId: unknown = null): number | null {
      const id = typeof line.messageId === 'string' ? line.messageId : null;
      if (!id) return null;
      const known = byId.get(id);
      if (known !== undefined) return known;
      const links = listOf(line.links).map((entry) => {
        const item = objOf(entry);
        return {
          kind: 'link' as const,
          url: item.url,
          title: item.title,
          text: item.description,
          site: item.site,
        };
      });
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
          ts: parseAt(line.occurredAt),
          links,
        },
      });
      byId.set(id, refs.length - 1);
      return refs.length - 1;
    },
  };
}

/** A line as the wake shows it: its time, a preview cut to `chars`, its media marker and its ref. */
function previewOf(entry: ScanEntry, chars: number, book: RefBook): Preview {
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
function activityOf({
  scan,
  settings,
  book,
  nameOf,
  placeName,
}: {
  scan: Scan;
  settings: ViewSettings;
  book: RefBook;
  nameOf: ((id: unknown) => unknown) | null;
  placeName: (id: unknown) => string;
}): Activity {
  const groups = new Map<string, Array<ScanEntry>>();
  for (const entry of scan.placeLines) {
    const group = groups.get(entry.place) ?? [];
    if (!groups.has(entry.place)) groups.set(entry.place, group);
    group.push(entry);
  }
  const safeName = (id: unknown) => {
    try {
      return text(nameOf?.(id)) || id;
    } catch {
      return id;
    }
  };
  const newestOf = (lines: Array<ScanEntry>) => lines.at(-1)?.at ?? 0;
  const ranked = [...groups]
    .map(([id, lines]) => ({ id, lines }))
    .sort((a, b) => b.lines.length - a.lines.length || newestOf(b.lines) - newestOf(a.lines) || (a.id < b.id ? -1 : 1));
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

/** The people block: the members she is closest to with their facts. */
function peopleOf({
  ranked,
  scan,
  book,
  nameOf,
  placeName,
  activePlaces,
  warn,
}: {
  ranked: Array<Ranked>;
  scan: Scan;
  book: RefBook;
  nameOf: ((id: string) => unknown) | null;
  placeName: (id: unknown) => string;
  activePlaces: ((memberId: string) => unknown) | null;
  warn: Warn;
}): Array<Person> {
  const safe = <TValue>(fn: () => TValue | null | undefined, fallback: TValue): TValue => {
    try {
      return fn() ?? fallback;
    } catch (error) {
      warn('person', error);
      return fallback;
    }
  };
  return ranked.map(({ profile, seen }) => {
    const id = asText(profile.id);
    const contact = scan.contact.get(id) ?? null;
    const own = scan.own.get(profile.id) ?? null;
    const weightOf = (item: Obj) => (isFiniteNumber(item.weight) ? item.weight : 0);
    const interests = listOf(profile.interests)
      .filter((item): item is Obj => isObj(item) && typeof item.topic === 'string' && item.topic.trim() !== '')
      .filter((item) => isOpen(item))
      .sort((a, b) => weightOf(b) - weightOf(a))
      .slice(0, INTERESTS_SHOWN)
      .map((item) => oneLine(item.topic));
    return {
      id,
      name: safe<unknown>(() => nameOf?.(id), null) ?? text(listOf(profile.names)[0]) ?? id,
      lastAt: contact ? contact.at : Number.isFinite(seen) ? seen : null,
      lastPlace: contact ? safe<string>(() => placeName(contact.place), contact.place) : null,
      lastWrote: own ? { ...previewOf(own, PREVIEW_CHARS.person, book), place: placeName(own.place) } : null,
      interests,
      places: listOf(safe<unknown>(() => activePlaces?.(id), []))
        .slice(0, PERSON_PLACES_SHOWN)
        .map(text)
        .filter(Boolean),
    };
  });
}

/** The profiles that are records with a string id. */
const profilesOf = (profiles: unknown): Array<Obj & { id: string }> =>
  listOf(profiles).filter(
    (profile): profile is Obj & { id: string } => isObj(profile) && typeof profile.id === 'string'
  );

/** The members she is closest to, in order, capped at `settings.people`. */
function closestOf({
  profiles,
  selfId,
  settings,
}: {
  profiles: unknown;
  selfId: unknown;
  settings: ViewSettings;
}): Array<Ranked> {
  const finiteOr = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);
  return profilesOf(profiles)
    .filter((profile) => profile.id !== asText(selfId ?? ''))
    .map((profile) => {
      const score = objOf(profile.affinity).score;
      return { profile, score: isFiniteNumber(score) ? score : 0, seen: parseAt(profile.lastSeen) };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        finiteOr(b.seen, -Infinity) - finiteOr(a.seen, -Infinity) ||
        (a.profile.id < b.profile.id ? -1 : 1)
    )
    .slice(0, Math.max(0, settings.people));
}

/**
 * The members of her focus set, in the view's order: the close ones first, then the exploring ones with their share of
 * `settings.people` (see the head of this file). `focus`: `{ close: string[], exploring: string[], exploringShare }`.
 */
function focusedOf({
  focus,
  profiles,
  selfId,
  settings,
}: {
  focus: Focus;
  profiles: unknown;
  selfId: unknown;
  settings: ViewSettings;
}): Array<Ranked> {
  const self = asText(selfId ?? '');
  const byId = new Map(profilesOf(profiles).map((profile) => [profile.id, profile]));
  const ids = (value: unknown) => [
    ...new Set(listOf(value).filter((id): id is string => typeof id === 'string' && id !== '' && id !== self)),
  ];
  const close = ids(focus.close);
  const exploring = ids(focus.exploring).filter((id) => !close.includes(id));
  const n = Math.max(0, Math.floor(settings.people));
  const share = isFiniteNumber(focus.exploringShare) && focus.exploringShare >= 0 ? focus.exploringShare : 0.15;
  const slots = exploring.length > 0 && n > 0 ? Math.min(exploring.length, Math.max(1, Math.round(share * n))) : 0;
  const shownClose = close.slice(0, n - slots);
  const shownExploring = exploring.slice(0, n - shownClose.length);
  return [...shownClose, ...shownExploring].map((id) => {
    const profile: Obj = byId.get(id) ?? { id };
    return { profile, seen: parseAt(profile.lastSeen) };
  });
}

/** The focus sets the injected reader gives, or null (the switch off, the database closed, a failing read). */
function readFocus(focusPeople: (() => unknown) | null, warn: Warn): Focus | null {
  if (typeof focusPeople !== 'function') return null;
  try {
    const sets = focusPeople();
    return isObj(sets) && (Array.isArray(sets.close) || Array.isArray(sets.exploring)) ? sets : null;
  } catch (error) {
    warn('focus', error);
    return null;
  }
}

/** Where one action of an inner turn went: a channel's name, a target's text, or nowhere. */
function actionPlace(target: unknown, placeName: (id: unknown) => string): string | null {
  const channel = objOf(target).channel;
  if (typeof channel === 'string') return placeName(channel);
  return typeof target === 'string' ? text(target) : null;
}

/** The actions of her inner turns that really ran, newest first; a message or a diary post is listed elsewhere. */
function actionsOf(innerTurns: Array<Obj>, placeName: (id: unknown) => string): Array<LifeAction> {
  const actions: Array<LifeAction> = [];
  for (const turn of innerTurns) {
    const at = parseAt(turn.occurredAt);
    for (const entry of listOf(turn.actions)) {
      const action = objOf(entry);
      if (action.status !== 'executed' || action.result !== 'ok' || typeof action.skill !== 'string') continue;
      // A message she sent is listed from the record (with its words), a diary post from the diary: never twice.
      if (action.skill === 'message.create' || action.skill === 'diary.post') continue;
      actions.push({ at, skill: currentToolName(action.skill), place: actionPlace(action.target, placeName) });
    }
  }
  return actions.sort((a, b) => b.at - a.at);
}

/** Her life: the last day, her open intentions and the latest closed ones. */
function lifeOf({ now, settings, innerTurns, tasks, diary, intentions, placeName, scan }: Common): Life {
  const dayAgo = now - DAY_MS;
  const actions = actionsOf(innerTurns, placeName);
  const errands = tasks
    .filter(
      (task) => objOf(task.requester).kind === 'persona' && isFiniteNumber(task.createdAt) && task.createdAt >= dayAgo
    )
    .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
    .map((task) => ({
      id: asText(task.id),
      agent: asText(task.agent ?? ''),
      state: asText(task.state ?? ''),
      at: Number(task.createdAt),
      goal: clampWithEllipsis(text(task.goal), PREVIEW_CHARS.goal),
    }));
  const posts = diary
    .filter((post) => isFiniteNumber(post.at) && post.at >= dayAgo)
    .sort((a, b) => Number(b.at) - Number(a.at))
    .map((post) => ({
      at: Number(post.at),
      kind: typeof post.kind === 'string' ? post.kind : null,
      gist: clampWithEllipsis(text(post.gist), PREVIEW_CHARS.gist),
    }));
  // Her own posts of the last day from the record (a diary post is listed once, from the diary).
  const diaryIds = new Set(diary.flatMap((post) => listOf(post.messageIds)).map(String));
  const sent = scan.said
    .filter(({ line }) => !diaryIds.has(asText(line.messageId)))
    .sort((a, b) => b.at - a.at)
    .map((entry) => {
      const media = mediaOf(entry.line);
      return {
        at: entry.at,
        place: placeName(entry.place),
        text: clampWithEllipsis(text(entry.line.text), PREVIEW_CHARS.post),
        ...(media ? { media } : {}),
      };
    });
  const dueOf = (record: Obj) => Number(record.dueAt ?? Infinity);
  const open = intentions
    .filter((record) => (record.status === 'pending' || record.status === 'waiting') && !record.attend)
    .sort((a, b) => dueOf(a) - dueOf(b))
    .map((record) => ({
      id: asText(record.id),
      purpose: text(record.purpose),
      status: record.status,
      dueAt: num(record.dueAt),
      ...(record.origin === 'heartbeat' ? { origin: 'heartbeat' as const } : {}),
    }));
  const attending = intentions
    .filter((record) => record.status === 'pending' && record.attend)
    .map((record) => ({
      id: asText(record.id),
      purpose: text(record.purpose),
      place: placeName(asText(objOf(record.attend).place ?? '')),
    }));
  const closedStates: ReadonlyArray<unknown> = ['done', 'cancelled', 'expired', 'dropped'];
  const closed = intentions
    .filter((record) => closedStates.includes(record.status) && objOf(record.provenance).kind !== 'candidate')
    .sort((a, b) => (movedAt(b) ?? 0) - (movedAt(a) ?? 0))
    .map((record) => ({
      id: asText(record.id),
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
function skillFamilies(names: unknown): Array<SkillFamily> {
  const families = new Map<string, Array<string>>();
  for (const name of listOf(names)) {
    if (typeof name !== 'string' || !name) continue;
    const dot = name.indexOf('.');
    const family = dot === -1 ? name : name.slice(0, dot);
    const rest = dot === -1 ? name : name.slice(dot + 1);
    const known = families.get(family) ?? [];
    if (!families.has(family)) families.set(family, known);
    known.push(rest);
  }
  return [...families].map(([family, rest]) => ({ family, names: rest }));
}

/** Whether an `unknown` action record is one of her own sends (a post, a picture, a GIF, message.create, draw.create, diary.post), never an engine or model role action. */
function isOwnSend(record: Obj): boolean {
  if (record.by !== undefined && record.by !== 'persona') return false;
  const input = objOf(record.input);
  const skill = text(input.skill) || text(record.name);
  if (record.name === 'skill' || input.skill) return SEND_SKILLS.includes(skill);
  return SEND_SKILLS.includes(skill) || (record.by === 'persona' && SEND_OPS.includes(skill));
}

/** One filtered line before its record line is found: its ids beside the line. */
type FilteredRaw = Omit<FilteredLine, 'who' | keyof Preview> & { at: number; messageId?: string; authorId?: string };

/** What the analyzer filtered without her, newest first: the address check's "not to her" and the missed check's dismissals. */
function filteredOf({
  from,
  now,
  missedVerdicts,
  addressVerdicts,
  placeName,
}: {
  from: number;
  now: number;
  missedVerdicts: Array<Obj>;
  addressVerdicts: Array<unknown>;
  placeName: (id: unknown) => string;
}): Array<FilteredRaw> {
  const within = (at: unknown): at is number => isFiniteNumber(at) && at >= from && at <= now;
  const ids = (item: Obj) => ({
    ...(item.messageId ? { messageId: asText(item.messageId) } : {}),
    ...(item.authorId ? { authorId: asText(item.authorId) } : {}),
  });
  const address: Array<FilteredRaw> = addressVerdicts
    .map(objOf)
    .flatMap((item) =>
      within(item.at)
        ? [{ at: item.at, place: placeName(asText(item.channelId ?? '')), by: 'address' as const, ...ids(item) }]
        : []
    );
  const missed: Array<FilteredRaw> = missedVerdicts
    .filter((record) => DISMISSED_VERDICTS.includes(record.verdict) && within(parseAt(record.occurredAt)))
    .map((record) => {
      const channel = objOf(record.scope).channel;
      return {
        at: parseAt(record.occurredAt),
        place: typeof channel === 'string' ? placeName(channel) : null,
        by: 'missed' as const,
        verdict: record.verdict,
        ...ids(record),
      };
    });
  return [...address, ...missed].sort((a, b) => b.at - a.at);
}

/** What lifeOf and sinceOf read. */
type Common = {
  now: number;
  settings: ViewSettings;
  innerTurns: Array<Obj>;
  tasks: Array<Obj>;
  diary: Array<Obj>;
  intentions: Array<Obj>;
  placeName: (id: unknown) => string;
  scan: Scan;
};

/** The finished errands of hers in `state` within the window. */
function errandsEnded(tasks: Array<Obj>, state: string, within: (at: unknown) => boolean): Array<Obj> {
  return tasks.filter(
    (task) => task.state === state && within(task.endedAt) && objOf(task.requester).kind === 'persona'
  );
}

/** What happened since `from`: done, not done, filtered. */
function sinceOf({
  from,
  now,
  innerTurns,
  tasks,
  intentions,
  diary,
  unknownSends,
  arrived,
  innerState,
  filtered,
  placeName,
}: Common & {
  from: number;
  unknownSends: Array<Obj>;
  arrived: ReadonlySet<unknown>;
  innerState: unknown;
  filtered: Since['filtered'];
}): Since {
  const within = (at: unknown): at is number => isFiniteNumber(at) && at >= from && at <= now;
  let posts = 0;
  for (const turn of innerTurns) {
    if (!within(parseAt(turn.occurredAt))) continue;
    posts += listOf(turn.actions)
      .map(objOf)
      .filter(
        (action) => action.status === 'executed' && action.result === 'ok' && POSTED_SKILLS.includes(action.skill)
      ).length;
  }
  posts += diary.filter((post) => within(post.at)).length;
  const errandsDone = errandsEnded(tasks, 'done', within).length;
  const fulfilled = intentions.filter((record) => record.status === 'done' && within(movedAt(record))).length;

  const expired = intentions
    .filter(
      (record) =>
        record.status === 'expired' && objOf(record.provenance).kind !== 'candidate' && within(movedAt(record))
    )
    .sort((a, b) => Number(movedAt(b)) - Number(movedAt(a)))
    .map((record) => ({ id: asText(record.id), purpose: text(record.purpose), at: Number(movedAt(record)) }));
  const missed: Array<NotDoneIntention> = [];
  const late: Array<NotDoneIntention> = [];
  for (const record of intentions) {
    for (const entry of listOf(record.history)) {
      const move = objOf(entry);
      if (!within(move.at)) continue;
      if (move.code === 'missed') missed.push({ id: asText(record.id), purpose: text(record.purpose), at: move.at });
      if (move.code === 'wait-deadline')
        late.push({ id: asText(record.id), purpose: text(record.purpose), at: move.at });
    }
  }
  const failedErrands = errandsEnded(tasks, 'failed', within)
    .sort((a, b) => Number(b.endedAt) - Number(a.endedAt))
    .map((task) => {
      const code = objOf(task.error).code;
      return {
        id: asText(task.id),
        agent: asText(task.agent ?? ''),
        at: Number(task.endedAt),
        code: typeof code === 'string' ? code : null,
      };
    });
  const newest = <TItem extends { at: number }>(items: Array<TItem>) => items.sort((a, b) => b.at - a.at);
  const sends = unknownSends
    .filter(isOwnSend)
    .filter((record) => !(text(record.opId) && arrived.has(record.opId)))
    .map((record) => {
      const channel = objOf(record.scope).channel;
      return {
        at: parseAt(record.occurredAt),
        skill: currentToolName(text(objOf(record.input).skill)) || text(record.name) || null,
        place: typeof channel === 'string' ? placeName(channel) : null,
      };
    })
    .filter((send) => within(send.at));
  const state = objOf(innerState);
  const errored = listOf(state.turns)
    .map(objOf)
    .filter((turn) => turn.outcome === 'error' && within(turn.at))
    .map((turn) => ({ at: Number(turn.at), code: typeof turn.code === 'string' ? turn.code : null }));
  const told = listOf(state.facts).filter((fact) => within(objOf(fact).told)).length;

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

/** What buildHeartbeatFacts reads: the stores and sources it is given. */
export type HeartbeatInput = {
  guildId: string;
  now: number;
  /** Her previous heartbeat (epoch ms); null: the last day. */
  since?: number | null;
  /** `innerLife.heartbeat`: the numbers of the view and `intentionsOnly`. */
  settings?: Readonly<Record<string, unknown>> | null;
  /** The member profiles (store.listUserProfiles). */
  profiles?: unknown;
  /** Her own member id (left out of the people). */
  selfId?: unknown;
  /** The record, for the last contact. */
  record?: RecordSource | null;
  /** The journal: her inner turns, unknown sends, the missed check's verdicts. */
  journal?: JournalSource;
  /** Her intention records, every status. */
  intentions?: unknown;
  /** Her errands (the errand store's recent list). */
  tasks?: unknown;
  /** Her diary posts (`{ at, kind }`). */
  diary?: unknown;
  /** The places page of the review (inner.ts#places). */
  places?: PlacesPage | null;
  /** The skill names granted to her. */
  skills?: unknown;
  /** The errand agents she can hand work to. */
  agents?: unknown;
  /** The inner state (turns that ended in error, the facts told). */
  innerState?: unknown;
  /** `{ at, channelId }` of the address check's "not to her"; the journal's `address` records are added by the view. */
  addressVerdicts?: ReadonlyArray<unknown> | (() => unknown) | null;
  nameOf?: ((id: string) => unknown) | null;
  placeName?: (id: string) => unknown;
  /** Where a member wrote lately (names). */
  activePlaces?: ((memberId: string) => unknown) | null;
  /** Her focus set as member ids (`innerLife.heartbeat.focusSource` `db`); null or absent: the profiles' affinity ranks. */
  focusPeople?: (() => unknown) | null;
  log?: { warn?(message: string, fields: Obj): void } | null;
};

/** The heartbeat's facts for `<wake>` (src/behavior/wake.ts words them). */
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
}: HeartbeatInput): Promise<HeartbeatFacts> {
  const s: ViewSettings = {
    ...VIEW_DEFAULTS,
    ...Object.fromEntries(
      Object.entries(settings ?? {}).filter(
        (entry): entry is [string, number] => isFiniteNumber(entry[1]) && entry[1] >= 0
      )
    ),
  };
  const warn: Warn = (what, error) =>
    log?.warn?.('heartbeat: source failed', { source: what, code: objOf(error).code ?? null });
  const place = (id: unknown): string => {
    try {
      return text(placeName(asText(id))) || asText(id);
    } catch {
      return asText(id);
    }
  };
  const from = isFiniteNumber(since) && since < now ? Math.max(since, now - 7 * DAY_MS) : now - DAY_MS;
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
      at: parseAt(entry.at ?? entry.occurredAt),
      channelId: entry.channelId ?? objOf(entry.scope).channel ?? '',
      messageId: entry.messageId ?? null,
      authorId: entry.authorId ?? null,
    }));
  let address: Array<unknown> = [];
  try {
    address = listOf(typeof addressVerdicts === 'function' ? addressVerdicts() : addressVerdicts);
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
  const profileNames = new Map(profilesOf(profiles).map((profile) => [profile.id, text(listOf(profile.names)[0])]));
  const nameFor = (id: unknown) => {
    try {
      return text(nameOf?.(asText(id))) || profileNames.get(asText(id)) || null;
    } catch {
      return profileNames.get(asText(id)) || null;
    }
  };
  const activity =
    typeof record?.iterate === 'function'
      ? activityOf({ scan, settings: s, book, nameOf: (id) => nameFor(id) ?? id, placeName: place })
      : null;
  const people = peopleOf({ ranked, scan, book, nameOf, placeName: place, activePlaces, warn });
  const filtered = filteredShown.map(({ messageId, authorId, ...item }): FilteredLine => {
    const entry = messageId ? scan.byId.get(messageId) : null;
    const who = nameFor(authorId ?? entry?.line.by ?? '') ?? authorId ?? entry?.line.by ?? null;
    return { ...item, ...(who ? { who } : {}), ...(entry ? previewOf(entry, PREVIEW_CHARS.filtered, book) : {}) };
  });
  const common: Common = {
    now,
    settings: s,
    innerTurns,
    tasks: listOf(tasks).map(objOf),
    diary: listOf(diary).map(objOf),
    intentions: listOf(intentions).filter(Boolean).map(objOf),
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
    agents: listOf(agents).filter((name): name is string => typeof name === 'string' && name !== ''),
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
