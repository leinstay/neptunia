// What the persona sees at the corner of her eye, the way a member sees it in Discord's
// sidebar right now: for each person a request is about, their status, the voice channel they
// sit in (muted, deafened, streaming, camera on) and what they are doing; and who else sits in
// a voice channel. src/behavior/prompt.js puts it in the `<people_now>` rows, one per person.
//
// A LIVE SNAPSHOT, never a record: the store below lives in process memory, is fed by the
// gateway's voice and presence events, is never written to data/, the journal, the record,
// a log (counts only) or a backup, and is gone at a restart. Discord sends presences only for
// members who are not offline, so with the presences intent on and a fresh snapshot a member
// without a presence record IS offline; with the intent off or a stale snapshot nothing is
// claimed about presence: the fields say "unavailable" or "stale", never "no".
//
// Member-supplied text (names, activity names, details, channel names) is untrusted data: one
// line, clamped, angle brackets removed so it cannot close or open a prompt block. Custom
// statuses are never kept.
//
// Pure: no discord.js import, no clock; src/index.js feeds the store, src/behavior/prompt.js
// builds the rows: a heading line per person, then one labelled field per line, negatives
// written out ("no", "none") only where the live data can tell, "unavailable" / "stale" where it
// cannot. Every word the model reads comes from `labels.peopleNow`.

import { fill, formatDuration } from './format.js';
import { clampChars, oneLine } from '../memory/clamp.js';

/** Longest member-supplied text kept, in code points. */
export const AROUND_TEXT_CHARS = 80;
/** Longest activity details (a game's rich presence) shown in a row, in code points. */
export const NOW_DETAIL_CHARS = 40;
/** Most activities kept per member. */
const MAX_ACTIVITIES = 3;

const STATUSES = new Set(['online', 'idle', 'dnd', 'offline']);
// discord.js ActivityType, by number: the keys of `labels.peopleNow.activity`.
const ACTIVITY_KEYS = { 0: 'playing', 1: 'streaming', 2: 'listening', 3: 'watching', 5: 'competing' };
const LISTENING = 2;
// A custom status is not kept: dropped at the door.
const CUSTOM_STATUS = 4;

/**
 * One line of member-supplied text, at most AROUND_TEXT_CHARS code points, without angle brackets.
 * @param {unknown} text
 * @returns {string}  '' for anything that is not text.
 */
export function cleanText(text) {
  if (typeof text !== 'string') return '';
  return clampChars(oneLine(text.replace(/[<>]/g, '')), AROUND_TEXT_CHARS).trim();
}

/** A non-empty id string, else null. */
function idOf(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A member's display name from a discord.js object's `member`, else null. */
function nameFrom(member) {
  const name = member?.displayName;
  return typeof name === 'string' && name !== '' ? cleanText(name) || null : null;
}

/**
 * A voice state (discord.js `VoiceState`, or any object with the same fields) as the snapshot's
 * record; null for a member who is in no channel (the member left).
 * @param {object} state  `id`, `channelId`, `selfMute`, `selfDeaf`, `serverMute`, `serverDeaf`, `streaming`, `selfVideo`, `member?`.
 * @returns {{ memberId: string, channelId: string, name: string|null, muted: boolean, deafened: boolean, streaming: boolean, camera: boolean }|null}
 */
export function voiceRecord(state) {
  const memberId = idOf(state?.id) ?? idOf(state?.member?.id);
  const channelId = idOf(state?.channelId);
  if (!memberId || !channelId) return null;
  return {
    memberId,
    channelId,
    name: nameFrom(state.member),
    muted: state.selfMute === true || state.serverMute === true,
    deafened: state.selfDeaf === true || state.serverDeaf === true,
    streaming: state.streaming === true,
    camera: state.selfVideo === true,
  };
}

/**
 * A presence (discord.js `Presence`, or any object with the same fields) as the snapshot's
 * record; null without a member id. An unrecognised status stays `unknown` (nothing about
 * presence is said for it). A custom status is not kept.
 * @param {object} presence  `userId`, `status`, `activities` (`type`, `name`, `details`, `state`), `member?`.
 * @returns {{ memberId: string, name: string|null, status: 'online'|'idle'|'dnd'|'offline'|'unknown', activities: { type: number, name: string, details: string, state: string }[] }|null}
 */
export function presenceRecord(presence) {
  const memberId = idOf(presence?.userId) ?? idOf(presence?.user?.id) ?? idOf(presence?.member?.id);
  if (!memberId) return null;
  const activities = [];
  for (const activity of Array.isArray(presence.activities) ? presence.activities : []) {
    if (activity?.type === CUSTOM_STATUS) continue;
    if (activities.length >= MAX_ACTIVITIES) continue;
    const name = cleanText(activity?.name);
    if (!name) continue;
    activities.push({ type: Number.isInteger(activity.type) ? activity.type : -1, name, details: cleanText(activity.details), state: cleanText(activity.state) });
  }
  return {
    memberId,
    name: nameFrom(presence.member),
    status: STATUSES.has(presence.status) ? presence.status : 'unknown',
    activities,
  };
}

/**
 * The snapshot store of one served guild. Methods take discord.js objects (or the same shape)
 * and keep plain records; nothing is persisted. A voice record seen joining a channel (a join or
 * a move) carries `joinedAt` (ms, from `now`), kept while the member stays in that channel (a
 * flag change); a record from a seed has none: when that member joined is not known.
 * @param {{ presences?: boolean, now?: () => number }} [options]  `presences`: the presences
 *   intent is on (fixed at login); `now`: the clock (Date.now by default).
 */
export function createAroundStore({ presences = false, now = Date.now } = {}) {
  /** @type {Map<string, object>} */
  let voice = new Map();
  /** @type {Map<string, object>} */
  let presence = new Map();
  let stale = false;

  return {
    /**
     * A voice state changed: a join, a move or a flag change replaces the record; a leave removes
     * it. A join or a move stamps `joinedAt`; a flag change keeps the held one (none after a seed).
     */
    voiceUpdate(state) {
      const memberId = idOf(state?.id) ?? idOf(state?.member?.id);
      if (!memberId) return;
      const record = voiceRecord(state);
      if (!record) {
        voice.delete(memberId);
        return;
      }
      const held = voice.get(memberId);
      if (held && held.channelId === record.channelId) {
        if (held.joinedAt !== undefined) record.joinedAt = held.joinedAt;
      } else {
        const at = now();
        if (Number.isFinite(at)) record.joinedAt = at;
      }
      voice.set(memberId, record);
    },
    /** A presence changed (a no-op while the presences intent is off). */
    presenceUpdate(next) {
      if (!presences) return;
      const record = presenceRecord(next);
      if (record) presence.set(record.memberId, record);
    },
    /** Replace the voice records with the voice states of the guild's cache (no `joinedAt`: not seen joining). */
    seedVoice(states) {
      voice = new Map();
      for (const state of states ?? []) {
        const record = voiceRecord(state);
        if (record) voice.set(record.memberId, record);
      }
    },
    /** Replace the presence records with the presences of the guild's cache (a no-op while the intent is off). */
    seedPresence(list) {
      if (!presences) return;
      presence = new Map();
      for (const item of list ?? []) {
        const record = presenceRecord(item);
        if (record) presence.set(record.memberId, record);
      }
    },
    /** The gateway dropped: what is held may be out of date until `markFresh`. */
    markStale() {
      stale = true;
    },
    /** The gateway is back and the snapshot was reseeded or kept current by resumed events. */
    markFresh() {
      stale = false;
    },
    /** The snapshot to render: copies, so a renderer cannot change the store. */
    snapshot() {
      return { presences, stale, voice: new Map(voice), presence: new Map(presence) };
    },
    /** Counts only, for a log line. */
    counts() {
      return { voice: voice.size, presence: presence.size, stale };
    },
  };
}

/** Names compare by plain code unit order: stable whatever the locale. */
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * One field line of a `<people_now>` row: `labels.peopleNow.field` (`{field}` `{value}`) with
 * `{field}` = `labels.peopleNow.fields[key]`. '' when either label is missing or the value is
 * empty. The value is kept on one line.
 * @param {object} labels  The whole labels object.
 * @param {string} key     A key of `labels.peopleNow.fields`.
 * @param {string} value
 * @returns {string}
 */
export function fieldLine(labels, key, value) {
  const l = labels?.peopleNow;
  const field = l?.fields?.[key];
  const text = oneLine(value);
  return l?.field && field && text ? fill(l.field, { field, value: text }) : '';
}

/**
 * `labels.peopleNow.joinedAgo` (`{ago}`) for a voice record seen joining (`joinedAt`), the age
 * through formatDuration and `labels.units`; '' without `joinedAt`, a clock, the labels.
 */
function joinedText(record, now, labels) {
  const template = labels?.peopleNow?.joinedAgo;
  if (!template || !labels?.units || !Number.isFinite(record?.joinedAt) || !Number.isFinite(now)) return '';
  return fill(template, { ago: formatDuration(Math.max(0, now - record.joinedAt), labels.units) });
}

/** A yes/no word of `labels.peopleNow.values`. */
function yesNo(l, flag) {
  return flag ? (l.values?.yes ?? '') : (l.values?.no ?? '');
}

/**
 * One activity as a phrase: `labels.peopleNow.activity[type]` (else `other`; `{name}`), then a
 * listening activity of Spotify with a track (details) and an artist (state) as `activityTrack`
 * (`{activity}` `{track}` `{artist}`), any other with details or state as `activityDetails`
 * (`{activity}` `{details}`, the two joined by ` / `, clamped to NOW_DETAIL_CHARS).
 */
function activityPhrase(activity, l) {
  const forms = l.activity ?? {};
  const template = forms[ACTIVITY_KEYS[activity.type]] ?? forms.other;
  if (!template) return '';
  const phrase = fill(template, { name: activity.name });
  const spotify = activity.type === LISTENING && activity.name.toLowerCase() === 'spotify';
  if (spotify && activity.details && activity.state && l.activityTrack) {
    return fill(l.activityTrack, { activity: phrase, track: activity.details, artist: activity.state });
  }
  const details = clampChars([activity.details, activity.state].filter(Boolean).join(' / '), NOW_DETAIL_CHARS).trim();
  return details && l.activityDetails ? fill(l.activityDetails, { activity: phrase, details }) : phrase;
}

/**
 * The live field lines of one member's `<people_now>` row (fieldLine), in this order:
 * - `status`: the `labels.peopleNow.status` word. With the presences intent on and a fresh
 *   snapshot a member without a presence record is offline. With the intent off the value is
 *   `values.unavailable`, with a stale snapshot `values.stale`, and a status Discord does not
 *   define reads as unavailable: never a guess.
 * - `voice`: from the voice snapshot (the voice states do not depend on the presences intent):
 *   `labels.peopleNow.voiceYes` (`{channel}` `{joined}` `{muted}` `{deafened}` `{streaming}`
 *   `{camera}`, each flag a yes/no word; `{joined}` is `labels.peopleNow.joinedAgo` with `{ago}`
 *   through formatDuration and `labels.units` when the record has `joinedAt` and `now` is given,
 *   else empty: never a guess) when the member sits in a voice channel `channelNameOf` names
 *   (one the audience may see), else `values.no`; `values.stale` with a stale snapshot. An
 *   offline member in voice shows it (an invisible status).
 * - `activity`: every activity Discord shows (a game and Spotify at once, say), each through
 *   `activityPhrase`, joined by `; `, else `values.none` -- also for an offline member, whose
 *   activities are not kept. Unavailable or stale as the status is, never `none` then.
 * Custom statuses are never kept. [] with no snapshot, no member id or no labels.
 * @param {{ presences: boolean, stale: boolean, voice: Map<string, object>, presence: Map<string, object> }} snapshot  createAroundStore().snapshot().
 * @param {string} memberId
 * @param {{ labels: object, channelNameOf?: (channelId: string) => string|null, now?: number }} options
 *   The whole labels object; `now` the request's clock (ms).
 * @returns {string[]}
 */
export function liveFields(snapshot, memberId, { labels, channelNameOf, now } = {}) {
  const l = labels?.peopleNow;
  if (!l || !snapshot || typeof memberId !== 'string' || memberId === '') return [];
  const values = l.values ?? {};
  const stale = snapshot.stale === true;
  const record = snapshot.presence.get(memberId);
  const status = record ? record.status : 'offline';
  // What the presence side may say: a status word, or one word for why it says nothing.
  const unknown = stale ? 'stale' : snapshot.presences !== true || !STATUSES.has(status) ? 'unavailable' : null;
  const lines = [fieldLine(labels, 'status', unknown ? (values[unknown] ?? '') : (l.status?.[status] ?? ''))];

  const here = snapshot.voice.get(memberId);
  const channel = here && typeof channelNameOf === 'function' ? cleanText(channelNameOf(here.channelId) ?? '') : '';
  const voice = stale
    ? values.stale
    : channel && l.voiceYes
      ? fill(l.voiceYes, {
          channel,
          joined: joinedText(here, now, labels),
          muted: yesNo(l, here.muted),
          deafened: yesNo(l, here.deafened),
          streaming: yesNo(l, here.streaming),
          camera: yesNo(l, here.camera),
        })
      : values.no;
  lines.push(fieldLine(labels, 'voice', voice ?? ''));

  const doing = !unknown && status !== 'offline' ? (record?.activities ?? []).map((activity) => activityPhrase(activity, l)).filter(Boolean) : [];
  lines.push(fieldLine(labels, 'activity', unknown ? (values[unknown] ?? '') : doing.join('; ') || values.none || ''));
  return lines.filter(Boolean);
}

/**
 * The block-level notices of `<people_now>`, in this order: `labels.peopleNow.stale` when the
 * gateway dropped since the last update (what is held may be out of date), then
 * `labels.peopleNow.unavailable` when the presences intent is off (no status and no activity
 * can be known). [] for a fresh snapshot with the intent on, no snapshot or no labels. The
 * caller shows them only when the block has rows anyway.
 * @param {{ presences: boolean, stale: boolean }|null} snapshot
 * @param {object} labels  The whole labels object.
 * @returns {string[]}
 */
export function liveNotices(snapshot, labels) {
  const l = labels?.peopleNow;
  if (!l || !snapshot) return [];
  return [snapshot.stale === true ? l.stale : '', snapshot.presences !== true ? l.unavailable : ''].filter(Boolean);
}

/**
 * The members sitting in a voice channel the audience may see (`channelNameOf` names it), but
 * those in `excludeIds`, each with a name (`nameOf`, else the name the snapshot holds; one
 * without either is left out), by name then id.
 * @param {{ voice: Map<string, object> }} snapshot
 * @param {{ excludeIds?: Set<string>, nameOf?: (memberId: string) => string|null, channelNameOf?: (channelId: string) => string|null }} [options]
 * @returns {{ memberId: string, name: string }[]}
 */
export function voiceOccupants(snapshot, { excludeIds = new Set(), nameOf, channelNameOf } = {}) {
  if (!snapshot?.voice || typeof channelNameOf !== 'function') return [];
  const out = [];
  for (const entry of snapshot.voice.values()) {
    if (excludeIds.has(entry.memberId)) continue;
    if (!cleanText(channelNameOf(entry.channelId) ?? '')) continue;
    const name = cleanText((typeof nameOf === 'function' ? nameOf(entry.memberId) : null) ?? entry.name ?? '');
    if (name) out.push({ memberId: entry.memberId, name });
  }
  return out.sort((a, b) => byText(a.name, b.name) || byText(a.memberId, b.memberId));
}

/**
 * One person's `<people_now>` entry: a heading line, then one field line each (fieldLine). The
 * heading is `labels.peopleNow.heading` (`{who}`), or `labels.peopleNow.headingMarked` (`{who}`
 * `{mark}`) with a mark (a tag about the person in this request, from `labels.peopleNow.marks`).
 * `{who}` is `@handle` (the member's mention handle, src/behavior/handles.js, the join key with
 * `<people>` and `<directory>`) and the name (member text: cleaned like any). '' with nothing to
 * say (no field, no mark), no name and no handle, or the labels missing.
 * @param {{ handle?: string|null, name?: string, mark?: string, fields?: string[] }} row
 * @param {object} labels  The whole labels object.
 * @returns {string}
 */
export function personRow({ handle = null, name = '', mark = '', fields = [] }, labels) {
  const l = labels?.peopleNow;
  const who = [handle ? `@${handle}` : '', cleanText(name)].filter(Boolean).join(' ');
  const lines = fields.filter(Boolean);
  if (!l || !who || (lines.length === 0 && !mark)) return '';
  const heading = mark ? fill(l.headingMarked, { who, mark }) : fill(l.heading, { who });
  if (!heading) return '';
  return [oneLine(heading), ...lines].join('\n');
}
