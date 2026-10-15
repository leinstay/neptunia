// What the persona sees at the corner of her eye, the way a member sees it in Discord's
// sidebar right now: who sits in which voice channel (muted, deafened, streaming, camera on),
// and, for each person whose profile a request renders, one short "now" line (status, the
// voice channel, what they are doing).
//
// A LIVE SNAPSHOT, never a record: the store below lives in process memory, is fed by the
// gateway's voice and presence events, is never written to data/, the journal, the record,
// a log (counts only) or a backup, and is gone at a restart. Discord sends presences only for
// members who are not offline, so with the presences intent on and a fresh snapshot a member
// without a presence record IS offline; with the intent off or a stale snapshot nothing is
// known and no now line is made (never "unknown").
//
// Member-supplied text (activity names, details) is untrusted data: one line, clamped, angle
// brackets removed so it cannot close or open a prompt block. Custom statuses are never kept.
//
// Pure: no discord.js import, no clock; src/index.js feeds the store, src/behavior/prompt.js
// renders the block and the now lines. Every word the model reads comes from `labels.around`.

import { fill } from './format.js';
import { clampChars, oneLine } from '../memory/clamp.js';
import { estimateTokens } from '../llm/tokens.js';

/** Longest member-supplied text kept, in code points. */
export const AROUND_TEXT_CHARS = 80;
/** Longest activity details (a game's rich presence) shown in a now line, in code points. */
export const NOW_DETAIL_CHARS = 40;
/** Most activities kept per member. */
const MAX_ACTIVITIES = 3;

const STATUSES = new Set(['online', 'idle', 'dnd', 'offline']);
// discord.js ActivityType, by number: the keys of `labels.around.activity`.
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
 * record; null without a member id. An unrecognised status stays `unknown` (no now line is
 * made for it). A custom status is not kept.
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

/** The flag words of one voice record, through `labels.around.flags`. */
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
 * One activity as a phrase: `labels.around.activity[type]` (else `other`), then a listening
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
 * What one member is doing now, as the details of a now line: the status word, then (unless
 * offline) the voice channel with the member's voice flags -- only a channel `channelNameOf`
 * names -- then the activities. An offline member is the status word alone.
 * '' when nothing is known: the presences intent off, a stale snapshot, a status Discord does
 * not define, or labels missing. With the intent on and a fresh snapshot a member without a
 * presence record is offline.
 * @param {{ presences: boolean, stale: boolean, voice: Map<string, object>, presence: Map<string, object> }} snapshot  createAroundStore().snapshot().
 * @param {string} memberId
 * @param {{ labels: object, channelNameOf?: (channelId: string) => string|null }} options
 * @returns {string}
 */
export function nowDetails(snapshot, memberId, { labels, channelNameOf } = {}) {
  const l = labels?.around;
  if (!l || !snapshot || !snapshot.presences || snapshot.stale || typeof memberId !== 'string' || memberId === '') return '';
  const record = snapshot.presence.get(memberId);
  const status = record ? record.status : 'offline';
  const statusWord = l.status?.[status];
  if (!statusWord) return '';
  const parts = [statusWord];
  if (status !== 'offline') {
    const here = snapshot.voice.get(memberId);
    const channelName = here && typeof channelNameOf === 'function' ? cleanText(channelNameOf(here.channelId) ?? '') : '';
    if (channelName && l.inVoice) parts.push(fill(l.inVoice, { channel: channelName }), ...flagWords(here, l.flags));
    for (const activity of record?.activities ?? []) parts.push(activityPhrase(activity, l));
  }
  return parts.filter(Boolean).join(', ');
}

/**
 * One member's now line: `labels.around.nowNamed` (`{name}` `{details}`) when a name is given,
 * else `labels.around.now` (`{details}`, for a profile that already carries the name). '' when
 * `nowDetails` is empty or the label is missing.
 * @param {object} input
 * @param {object} input.snapshot
 * @param {string} input.memberId
 * @param {string} [input.name]
 * @param {object} input.labels  The whole labels object.
 * @param {(channelId: string) => string|null} [input.channelNameOf]
 * @returns {string}
 */
export function nowLine({ snapshot, memberId, name = '', labels, channelNameOf }) {
  const l = labels?.around;
  const details = nowDetails(snapshot, memberId, { labels, channelNameOf });
  if (!details || !l) return '';
  const who = cleanText(name);
  if (who) return l.nowNamed ? fill(l.nowNamed, { name: who, details }) : '';
  return l.now ? fill(l.now, { details }) : '';
}

/**
 * The `<around>` block body: `labels.around.lead`, the interlocutor's now line (named; it lives
 * here because their profile is in a cached part of the request), then one line per voice
 * channel with its occupants and their voice flags. Nothing else: no activities in the voice
 * lines, no other people. '' when there is nothing to say (no voice occupant and no now line
 * for the interlocutor), labels missing or `maxTokens` 0. Over `maxTokens` the voice goes
 * first (the flags, then channels, the last first); the interlocutor's line stays longest, and
 * when even that does not fit the body is ''.
 * @param {object} input
 * @param {{ presences: boolean, stale: boolean, voice: Map<string, object>, presence: Map<string, object> }} input.snapshot  createAroundStore().snapshot().
 * @param {string|null} [input.interlocutorId]  The member whose profile is in the cached part.
 * @param {string} [input.interlocutorName]  Their name as their profile shows it; else `nameOf`, else the name the snapshot holds.
 * @param {(memberId: string) => string|null} input.nameOf
 * @param {(channelId: string) => string|null} input.channelNameOf  null: a channel not to be named, left out.
 * @param {object} input.labels  The whole labels object; `labels.around` is read.
 * @param {number} [input.maxTokens]  Hard cap of the body (non-finite: no cap).
 * @param {(text: string) => number} [input.estimate]  Token estimate of a text (default: src/llm/tokens.js).
 * @returns {string}
 */
export function renderAround({ snapshot, interlocutorId = null, interlocutorName: givenName = '', nameOf, channelNameOf, labels, maxTokens = Infinity, estimate = estimateTokens }) {
  const l = labels?.around;
  if (!l?.lead || !snapshot || !(maxTokens > 0)) return '';
  const name = (id, record) => cleanText((typeof nameOf === 'function' ? nameOf(id) : null) ?? record?.name ?? '');

  // Voice: channels by name, occupants by name.
  const byChannel = new Map();
  for (const entry of snapshot.voice.values()) {
    const memberName = name(entry.memberId, entry);
    if (!memberName) continue;
    const channelName = typeof channelNameOf === 'function' ? cleanText(channelNameOf(entry.channelId) ?? '') : '';
    if (!channelName) continue;
    const group = byChannel.get(entry.channelId) ?? { channelName, members: [] };
    group.members.push({ name: memberName, entry });
    byChannel.set(entry.channelId, group);
  }
  const groups = [...byChannel.values()].sort((a, b) => byText(a.channelName, b.channelName));
  for (const group of groups) group.members.sort((a, b) => byText(a.name, b.name));
  const voiceLine = (group, withFlags) => {
    if (!l.voiceChannel) return '';
    const members = group.members.map(({ name: memberName, entry }) => {
      const words = withFlags ? flagWords(entry, l.flags) : [];
      return words.length > 0 && l.voiceMember ? fill(l.voiceMember, { name: memberName, flags: words.join(', ') }) : memberName;
    });
    return fill(l.voiceChannel, { channel: group.channelName, members: members.join(', ') });
  };

  // The interlocutor's line: named, so it reads alone under the lead.
  const hasInterlocutor = typeof interlocutorId === 'string' && interlocutorId !== '';
  const interlocutorName = hasInterlocutor ? cleanText(givenName) || name(interlocutorId, snapshot.presence.get(interlocutorId)) : '';
  const now = interlocutorName ? nowLine({ snapshot, memberId: interlocutorId, name: interlocutorName, labels, channelNameOf }) : '';

  const compose = (voiceLines) => {
    if (voiceLines.length === 0 && !now) return '';
    return [l.lead, voiceLines.length > 0 && snapshot.stale ? l.stale : '', now, ...voiceLines].filter(Boolean).join('\n');
  };
  const fits = (text) => text !== '' && (!Number.isFinite(maxTokens) || estimate(text) <= maxTokens);

  // Candidates from the fullest down, the first that fits wins: no flags, then fewer channels
  // (the last first), the interlocutor's line kept to the end.
  for (const withFlags of [true, false]) {
    const text = compose(groups.map((group) => voiceLine(group, withFlags)).filter(Boolean));
    if (fits(text)) return text;
  }
  const bare = groups.map((group) => voiceLine(group, false)).filter(Boolean);
  for (let channels = bare.length - 1; channels >= 0; channels -= 1) {
    const text = compose(bare.slice(0, channels));
    if (fits(text)) return text;
  }
  return '';
}
