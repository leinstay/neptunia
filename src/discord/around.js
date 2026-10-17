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
// Pure: no discord.js import, no clock; src/index.js feeds the store; the rows it renders into are
// src/behavior/around.js.

import { STATUSES, cleanText } from '../behavior/around.js';

/** Most activities kept per member. */
const MAX_ACTIVITIES = 3;

// A custom status is not kept: dropped at the door.
const CUSTOM_STATUS = 4;

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
