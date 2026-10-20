// The heartbeat's facts (docs/inner-life.md "The heartbeat"; the wake kind `heartbeat` of
// src/behavior/inner.js): ONE function, no model, that reads the stores as they are today and
// answers what the `<wake>` of that kind shows (src/behavior/wake.js words it). It is the only
// place that knows where each fact lives, so the day the memory work brings its own store only
// this file changes, never the prompt or the wake mechanism.
//
//   people     up to `heartbeat.people` members she is closest to (the profiles' affinity): when she last
//              talked with them and where (the record: their own line, or a line of hers naming them,
//              else the profile's `lastSeen` with no place), the top 3 interests of the profile, the
//              places where they wrote lately and whether they are around now (the live snapshot);
//   places     the places page the review gets (passed in, built by inner.js#places);
//   life       what she did in the last day (the actions of her inner turns from the journal that
//              really ran, her errands, her diary posts), her open intentions and attentions, and
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
// Every list is capped, the rest counted. A source that is missing or throws leaves its list empty
// (never the whole view); the log carries codes, never text. Pure apart from the reads it is given.

import { DAY_MS, utcDay } from '../time.js';
import { oneLine } from '../memory/clamp.js';
import { isOpen } from '../memory/interests.js';

/** The interests shown per person. */
export const INTERESTS_SHOWN = 3;
/** The places shown per person. */
export const PERSON_PLACES_SHOWN = 3;
/** The entries shown per list of her life and of what was not done; the rest is counted. */
export const LIST_SHOWN = 8;
/** The calls of an inner turn that post where people read (the diary is counted from its own store). */
const POSTED_SKILLS = Object.freeze(['message.create', 'draw.create']);
/** The missed helper's verdicts that mean "left alone without her". */
export const DISMISSED_VERDICTS = Object.freeze(['intentional-skip', 'stale', 'uncertain']);
/** The defaults of the settings (`innerLife.heartbeat`; config.json carries the same). */
export const VIEW_DEFAULTS = Object.freeze({ people: 8, filteredShown: 10, closedShown: 10, historyDays: 14 });

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
  for (const value of [record?.reason, record?.droppedReason, move?.reason, record?.note]) if (typeof value === 'string' && value.trim()) return oneLine(value);
  const outcome = record?.outcome;
  if (outcome && typeof outcome === 'object') return oneLine([outcome.state, outcome.error].filter((part) => typeof part === 'string' && part).join(' '));
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

/**
 * The people block: the members she is closest to with their facts.
 * @returns {Promise<object[]>}
 */
async function peopleOf({ profiles, selfId, settings, record, guildId, now, nameOf, placeName, activePlaces, around, warn }) {
  const ranked = list(profiles)
    .filter((profile) => profile && typeof profile.id === 'string' && profile.id !== String(selfId ?? ''))
    .map((profile) => ({ profile, score: Number.isFinite(profile.affinity?.score) ? profile.affinity.score : 0, seen: Date.parse(profile.lastSeen) }))
    .sort((a, b) => b.score - a.score || (Number.isFinite(b.seen) ? b.seen : -Infinity) - (Number.isFinite(a.seen) ? a.seen : -Infinity) || (a.profile.id < b.profile.id ? -1 : 1))
    .slice(0, Math.max(0, settings.people));
  if (ranked.length === 0) return [];
  const chosen = new Set(ranked.map(({ profile }) => profile.id));
  // The newest line of each chosen member's in the record: their own, or one of hers that names them.
  const last = new Map();
  if (typeof record?.iterate === 'function') {
    try {
      const from = new Date(now - settings.historyDays * DAY_MS).toISOString();
      for await (const line of record.iterate(guildId, { from })) {
        if (line?.kind !== 'seen' && line?.kind !== 'said') continue;
        const at = Date.parse(line.occurredAt);
        const place = typeof line.scope?.channel === 'string' ? line.scope.channel : null;
        if (!Number.isFinite(at) || at > now || !place) continue;
        const who = line.kind === 'seen' ? [line.by] : list(line.participants);
        for (const id of who) {
          if (typeof id !== 'string' || !chosen.has(id)) continue;
          if (!last.has(id) || last.get(id).at < at) last.set(id, { at, place });
        }
      }
    } catch (error) {
      warn('record', error);
    }
  }
  const safe = (fn, fallback) => {
    try {
      return fn() ?? fallback;
    } catch (error) {
      warn('person', error);
      return fallback;
    }
  };
  return ranked.map(({ profile, seen }) => {
    const contact = last.get(profile.id) ?? null;
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
      interests,
      places: list(safe(() => activePlaces?.(profile.id), [])).slice(0, PERSON_PLACES_SHOWN).map(text).filter(Boolean),
      around: safe(() => around?.(profile.id), null),
    };
  });
}

/** Her life: the last day, her open intentions and the latest closed ones. */
function lifeOf({ now, settings, innerTurns, tasks, diary, intentions, placeName }) {
  const dayAgo = now - DAY_MS;
  const actions = [];
  for (const turn of innerTurns) {
    const at = Date.parse(turn.occurredAt);
    for (const action of list(turn.actions)) {
      if (action?.status !== 'executed' || action.result !== 'ok' || typeof action.skill !== 'string') continue;
      actions.push({ at, skill: action.skill, place: typeof action.target?.channel === 'string' ? placeName(action.target.channel) : typeof action.target === 'string' ? text(action.target) : null });
    }
  }
  actions.sort((a, b) => b.at - a.at);
  const errands = tasks
    .filter((task) => task?.requester?.kind === 'persona' && Number.isFinite(task.createdAt) && task.createdAt >= dayAgo)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((task) => ({ id: String(task.id), agent: String(task.agent ?? ''), state: String(task.state ?? ''), at: task.createdAt }));
  const posts = diary
    .filter((post) => Number.isFinite(post?.at) && post.at >= dayAgo)
    .sort((a, b) => b.at - a.at)
    .map((post) => ({ at: post.at, kind: typeof post.kind === 'string' ? post.kind : null }));
  const open = intentions
    .filter((record) => (record?.status === 'pending' || record?.status === 'waiting') && !record.attend)
    .sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity))
    .map((record) => ({ id: String(record.id), purpose: text(record.purpose), status: record.status, dueAt: num(record.dueAt) }));
  const attending = intentions
    .filter((record) => record?.status === 'pending' && record.attend)
    .map((record) => ({ id: String(record.id), purpose: text(record.purpose), place: placeName(String(record.attend.place ?? '')) }));
  const closed = intentions
    .filter((record) => ['done', 'cancelled', 'expired', 'dropped'].includes(record?.status) && record.provenance?.kind !== 'candidate')
    .sort((a, b) => (movedAt(b) ?? 0) - (movedAt(a) ?? 0))
    .map((record) => ({ id: String(record.id), purpose: text(record.purpose), state: record.status, why: reasonOf(record), at: movedAt(record) }));
  return { actions: capped(actions), errands: capped(errands), diary: capped(posts), open: capped(open), attending: capped(attending), closed: capped(closed, settings.closedShown) };
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

/** What happened since `from`: done, not done, filtered. */
function sinceOf({ from, now, settings, innerTurns, tasks, intentions, diary, unknownSends, innerState, missedVerdicts, addressVerdicts, placeName }) {
  const within = (at) => Number.isFinite(at) && at >= from && at <= now;
  let posts = 0;
  for (const turn of innerTurns) {
    if (!within(Date.parse(turn.occurredAt))) continue;
    posts += list(turn.actions).filter((action) => action?.status === 'executed' && action.result === 'ok' && POSTED_SKILLS.includes(action.skill)).length;
  }
  posts += diary.filter((post) => within(post?.at)).length;
  const errandsDone = tasks.filter((task) => task?.state === 'done' && within(task.endedAt) && task.requester?.kind === 'persona').length;
  const fulfilled = intentions.filter((record) => record?.status === 'done' && within(movedAt(record))).length;

  const expired = intentions
    .filter((record) => record?.status === 'expired' && record.provenance?.kind !== 'candidate' && within(movedAt(record)))
    .sort((a, b) => movedAt(b) - movedAt(a))
    .map((record) => ({ id: String(record.id), purpose: text(record.purpose), at: movedAt(record) }));
  const missed = [];
  const late = [];
  for (const record of intentions) {
    for (const move of list(record?.history)) {
      if (!within(move?.at)) continue;
      if (move.code === 'missed') missed.push({ id: String(record.id), purpose: text(record.purpose), at: move.at });
      if (move.code === 'wait-deadline') late.push({ id: String(record.id), purpose: text(record.purpose), at: move.at });
    }
  }
  const failedErrands = tasks
    .filter((task) => task?.state === 'failed' && within(task.endedAt) && task.requester?.kind === 'persona')
    .sort((a, b) => b.endedAt - a.endedAt)
    .map((task) => ({ id: String(task.id), agent: String(task.agent ?? ''), at: task.endedAt, code: typeof task.error?.code === 'string' ? task.error.code : null }));
  const newest = (items) => items.sort((a, b) => b.at - a.at);
  const sends = unknownSends
    .map((record) => ({ at: Date.parse(record.occurredAt), skill: text(record.name) || null, place: typeof record.scope?.channel === 'string' ? placeName(record.scope.channel) : null }))
    .filter((send) => within(send.at));
  const errored = list(innerState?.turns)
    .filter((turn) => turn?.outcome === 'error' && within(turn.at))
    .map((turn) => ({ at: turn.at, code: typeof turn.code === 'string' ? turn.code : null }));
  const told = list(innerState?.facts).filter((fact) => Number.isFinite(fact?.told) && within(fact.told)).length;

  const filtered = [
    ...list(addressVerdicts).filter((item) => within(item?.at)).map((item) => ({ at: item.at, place: placeName(String(item.channelId ?? '')), by: 'address' })),
    ...missedVerdicts
      .filter((record) => DISMISSED_VERDICTS.includes(record?.verdict) && within(Date.parse(record.occurredAt)))
      .map((record) => ({ at: Date.parse(record.occurredAt), place: typeof record.scope?.channel === 'string' ? placeName(record.scope.channel) : null, by: 'missed', verdict: record.verdict })),
  ].sort((a, b) => b.at - a.at);
  const shown = capped(filtered, settings.filteredShown);

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
    filtered: { items: shown.items, more: shown.more, total: filtered.length },
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
 * @param {(memberId: string) => boolean|null} [input.around]  Whether a member is around now (null: unknown).
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
  around = null,
  log = null,
}) {
  const s = { ...VIEW_DEFAULTS, ...Object.fromEntries(Object.entries(settings ?? {}).filter(([, value]) => Number.isFinite(value) && value >= 0)) };
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
  const [innerTurns, unknownSends, answers] = await Promise.all([
    readJournal(journal, guildId, windowStart, now, 'inner', warn).then((records) => records.filter((entry) => entry.event === 'turn')),
    readJournal(journal, guildId, from, now, 'action', warn).then((records) => records.filter((entry) => entry.phase === 'unknown')),
    readJournal(journal, guildId, from, now, 'answer', warn),
  ]);
  const journalAddress = answers
    .filter((entry) => entry.event === 'address')
    .map((entry) => ({ at: Date.parse(entry.at ?? entry.occurredAt), channelId: entry.channelId ?? entry.scope?.channel ?? '' }));
  let address = [];
  try {
    address = list(typeof addressVerdicts === 'function' ? addressVerdicts() : addressVerdicts);
  } catch (error) {
    warn('address', error);
  }
  const people = await peopleOf({ profiles, selfId, settings: s, record, guildId, now, nameOf, placeName: place, activePlaces, around, warn });
  const common = { now, settings: s, innerTurns, tasks: list(tasks), diary: list(diary), intentions: list(intentions).filter(Boolean), placeName: place };
  return {
    people,
    places: places ?? null,
    life: lifeOf(common),
    skills: skillFamilies(skills),
    agents: list(agents).filter((name) => typeof name === 'string' && name),
    since: sinceOf({ ...common, from, unknownSends, innerState, missedVerdicts: answers.filter((entry) => entry.event === 'verdict'), addressVerdicts: [...address, ...journalAddress] }),
  };
}
