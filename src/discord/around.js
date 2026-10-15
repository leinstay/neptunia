// What the persona sees at the corner of her eye, the way a member sees it in Discord's
// sidebar right now: who sits in which voice channel (muted, deafened, streaming, camera on)
// and what the people of the current scene are doing (status, activity, custom status).
//
// A LIVE SNAPSHOT, never a record: the store below lives in process memory, is fed by the
// gateway's voice and presence events, is never written to data/, the journal, the record,
// a log (counts only) or a backup, and is gone at a restart. Availability is explicit: a
// member nobody observed is `unknown`, never `offline` (a missing entry is not evidence);
// `offline` is rendered as "shown offline (may be invisible)" through the labels; after a
// gateway disconnect everything is labelled stale until the connection is back.
//
// Member-supplied text (activity names, details, custom status) is untrusted data: one line,
// clamped, angle brackets removed so it cannot close or open a prompt block.
//
// Pure: no discord.js import, no clock; src/index.js feeds the store, src/behavior/prompt.js
// renders the block. Every word the model reads comes from `labels.around`.

import { fill } from './format.js';
import { clampChars, oneLine } from '../memory/clamp.js';
import { estimateTokens } from '../llm/tokens.js';

/** Longest member-supplied text shown, in code points. */
export const AROUND_TEXT_CHARS = 80;
/** Most activities kept per member (a custom status is kept besides them). */
const MAX_ACTIVITIES = 3;

const STATUSES = new Set(['online', 'idle', 'dnd', 'offline']);
// discord.js ActivityType, by number: the keys of `labels.around.activity`.
const ACTIVITY_KEYS = { 0: 'playing', 1: 'streaming', 2: 'listening', 3: 'watching', 5: 'competing' };
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
 * record; null without a member id. An unrecognised status stays `unknown`.
 * @param {object} presence  `userId`, `status`, `activities` (`type`, `name`, `details`, `state`), `member?`.
 * @returns {{ memberId: string, name: string|null, status: 'online'|'idle'|'dnd'|'offline'|'unknown', activities: { type: number, name: string, details: string, state: string }[], custom: string }|null}
 */
export function presenceRecord(presence) {
  const memberId = idOf(presence?.userId) ?? idOf(presence?.user?.id) ?? idOf(presence?.member?.id);
  if (!memberId) return null;
  const activities = [];
  let custom = '';
  for (const activity of Array.isArray(presence.activities) ? presence.activities : []) {
    if (activity?.type === CUSTOM_STATUS) {
      custom = custom || cleanText(activity.state);
      continue;
    }
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
    custom,
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

/** One activity as a phrase: `labels.around.activity[type]` (else `other`) with its details. */
function activityPhrase(activity, l) {
  const forms = l.activity ?? {};
  const template = forms[ACTIVITY_KEYS[activity.type]] ?? forms.other;
  if (!template) return '';
  const phrase = fill(template, { name: activity.name });
  const details = [activity.details, activity.state].filter(Boolean).join(' / ');
  return details && l.activityDetails ? fill(l.activityDetails, { activity: phrase, details }) : phrase;
}

/**
 * What one scene member's status line says: the status word (`unknown` for a member nobody
 * observed, never `offline`), then the activities and the custom status. '' when the labels
 * lack what it needs.
 */
function presenceDetails(record, l) {
  const status = record ? record.status : 'unknown';
  const statusWord = l.status?.[status];
  if (!statusWord) return '';
  const parts = [statusWord];
  if (record && status !== 'offline') {
    for (const activity of record.activities) parts.push(activityPhrase(activity, l));
    if (record.custom && l.customStatus) parts.push(fill(l.customStatus, { text: record.custom }));
  }
  return parts.filter(Boolean).join('; ');
}

/**
 * The `<around>` block body: the live voice channels with their occupants (flags as label
 * words), then, for the scene members only, their status, activity and custom status. '' when
 * there is nothing to say (no voice occupant and no scene member with an observed status -- a
 * member nobody observed shows as `unknown` beside other content but never makes a block of its
 * own --, labels missing, `maxTokens` 0). Over `maxTokens` the lowest-value lines go first:
 * the other people's lines (last of the scene first), then the voice flags, then voice
 * channels (last first); the first scene member's line stays longest, and when even that does
 * not fit the body is ''.
 * @param {object} input
 * @param {{ presences: boolean, stale: boolean, voice: Map<string, object>, presence: Map<string, object> }} input.snapshot  createAroundStore().snapshot().
 * @param {string[]} input.sceneMemberIds  Ids in order of value: the interlocutor first, then whoever spoke last.
 * @param {(memberId: string) => string|null} input.nameOf
 * @param {(channelId: string) => string|null} input.channelNameOf  null: a channel not to be named, left out.
 * @param {object} input.labels  The whole labels object; `labels.around` is read.
 * @param {number} [input.maxTokens]  Hard cap of the body (non-finite: no cap).
 * @param {(text: string) => number} [input.estimate]  Token estimate of a text (default: src/llm/tokens.js).
 * @returns {string}
 */
export function renderAround({ snapshot, sceneMemberIds = [], nameOf, channelNameOf, labels, maxTokens = Infinity, estimate = estimateTokens }) {
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

  // The scene: a member once, the interlocutor (first) kept longest.
  const people = [];
  const seen = new Set();
  for (const id of sceneMemberIds) {
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    seen.add(id);
    // With the presences intent off nobody's status is known: no line says so, and none says offline.
    if (!snapshot.presences) continue;
    const record = snapshot.presence.get(id);
    const memberName = name(id, record);
    const details = memberName ? presenceDetails(record, l) : '';
    if (details && l.presenceLine) people.push({ text: fill(l.presenceLine, { name: memberName, details }), known: Boolean(record) });
  }

  // A block of unobserved members alone says nothing: it needs a voice line or a known status.
  const compose = (voiceLines, personLines) => {
    if (voiceLines.length === 0 && !personLines.some((person) => person.known)) return '';
    return [l.lead, snapshot.stale ? l.stale : '', ...voiceLines, ...personLines.map((person) => person.text)].filter(Boolean).join('\n');
  };
  const fits = (text) => text !== '' && (!Number.isFinite(maxTokens) || estimate(text) <= maxTokens);

  // Candidates from the fullest down, the first that fits wins: fewer other people, then no
  // flags, then fewer channels, the first scene member's line kept to the end.
  const full = groups.map((group) => voiceLine(group, true)).filter(Boolean);
  const bare = groups.map((group) => voiceLine(group, false)).filter(Boolean);
  for (let count = people.length; count >= Math.min(1, people.length); count -= 1) {
    const text = compose(full, people.slice(0, count));
    if (fits(text)) return text;
  }
  const first = people.slice(0, 1);
  for (let channels = bare.length; channels >= 0; channels -= 1) {
    const text = compose(bare.slice(0, channels), first);
    if (fits(text)) return text;
  }
  return '';
}
