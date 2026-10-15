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
// said about presence (one notice for the block, never "unknown" per person).
//
// Member-supplied text (names, activity names, details, channel names) is untrusted data: one
// line, clamped, angle brackets removed so it cannot close or open a prompt block. Custom
// statuses are never kept.
//
// Pure: no discord.js import, no clock; src/index.js feeds the store, src/behavior/prompt.js
// builds the rows. Every word the model reads comes from `labels.peopleNow`.

import { fill } from './format.js';
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
 * and keep plain records; nothing is persisted.
 * @param {{ presences?: boolean }} [options]  `presences`: the presences intent is on (fixed at login).
 */
export function createAroundStore({ presences = false } = {}) {
  /** @type {Map<string, object>} */
  let voice = new Map();
  /** @type {Map<string, object>} */
  let presence = new Map();
  let stale = false;

  return {
    /** A voice state changed: a join, a move or a flag change replaces the record; a leave removes it. */
    voiceUpdate(state) {
      const memberId = idOf(state?.id) ?? idOf(state?.member?.id);
      if (!memberId) return;
      const record = voiceRecord(state);
      if (record) voice.set(memberId, record);
      else voice.delete(memberId);
    },
    /** A presence changed (a no-op while the presences intent is off). */
    presenceUpdate(next) {
      if (!presences) return;
      const record = presenceRecord(next);
      if (record) presence.set(record.memberId, record);
    },
    /** Replace the voice records with the voice states of the guild's cache. */
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

/** The flag words of one voice record, through `labels.peopleNow.flags`. */
function flagWords(record, flags) {
  if (!flags || typeof flags !== 'object') return [];
  const words = [];
  if (record.muted && flags.muted) words.push(flags.muted);
  if (record.deafened && flags.deafened) words.push(flags.deafened);
  if (record.streaming && flags.streaming) words.push(flags.streaming);
  if (record.camera && flags.camera) words.push(flags.camera);
  return words;
}

/**
 * One activity as a phrase: `labels.peopleNow.activity[type]` (else `other`), then a listening
 * activity of Spotify as `activityTrack` (details = the track, state = the artist), any other
 * activity's details and state as `activityDetails`, clamped to NOW_DETAIL_CHARS.
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
 * The live part of one member's `<people_now>` row, the parts joined by `, `: the status word,
 * then the voice channel the member sits in with their voice flags -- only a channel
 * `channelNameOf` names -- then (online, idle or do not disturb only) the activities.
 * The status and the activities need the presences intent on and a fresh snapshot: then a
 * member without a presence record is offline, and an offline member shows no activity. With
 * the intent off or a stale snapshot nothing about presence is said (the block carries one
 * notice instead, see `liveNotices`); the voice seat still shows, as the voice states do not
 * depend on the presences intent. A status Discord does not define says nothing either.
 * '' when nothing is known or the labels are missing.
 * @param {{ presences: boolean, stale: boolean, voice: Map<string, object>, presence: Map<string, object> }} snapshot  createAroundStore().snapshot().
 * @param {string} memberId
 * @param {{ labels: object, channelNameOf?: (channelId: string) => string|null }} options  The whole labels object.
 * @returns {string}
 */
export function liveDetails(snapshot, memberId, { labels, channelNameOf } = {}) {
  const l = labels?.peopleNow;
  if (!l || !snapshot || typeof memberId !== 'string' || memberId === '') return '';
  const presenceKnown = snapshot.presences === true && snapshot.stale !== true;
  const record = presenceKnown ? snapshot.presence.get(memberId) : undefined;
  const status = presenceKnown ? (record ? record.status : 'offline') : null;
  const statusWord = status ? (l.status?.[status] ?? '') : '';
  const parts = [statusWord];
  const here = snapshot.voice.get(memberId);
  const channelName = here && typeof channelNameOf === 'function' ? cleanText(channelNameOf(here.channelId) ?? '') : '';
  if (channelName && l.inVoice) parts.push(fill(l.inVoice, { channel: channelName }), ...flagWords(here, l.flags));
  if (statusWord && status !== 'offline') {
    for (const activity of record?.activities ?? []) parts.push(activityPhrase(activity, l));
  }
  return parts.filter(Boolean).join(', ');
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
 * One `<people_now>` row: `labels.peopleNow.row` (`{who}` `{mark}` `{details}`, the parts
 * joined by `; `), or `labels.peopleNow.rowBare` (`{who}` `{mark}`) when a mark is all there is
 * to say. `{who}` is `@handle` (the member's mention handle, src/behavior/handles.js, the join
 * key with `<people>` and `<directory>`) and the name (member text: cleaned like any). One line
 * always. '' with nothing to say (no part, no mark), no name and no handle, or the label missing.
 * @param {{ handle?: string|null, name?: string, mark?: string, parts?: string[] }} row
 * @param {object} labels  The whole labels object.
 * @returns {string}
 */
export function nowRow({ handle = null, name = '', mark = '', parts = [] }, labels) {
  const l = labels?.peopleNow;
  const who = [handle ? `@${handle}` : '', cleanText(name)].filter(Boolean).join(' ');
  if (!l || !who) return '';
  const details = parts.filter(Boolean).join('; ');
  if (details) return l.row ? oneLine(fill(l.row, { who, mark: mark ?? '', details })) : '';
  return mark && l.rowBare ? oneLine(fill(l.rowBare, { who, mark })) : '';
}
