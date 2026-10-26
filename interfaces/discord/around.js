// The builders of the live glance on the Discord side: a discord.js voice state, presence or guild becomes the
// protocol event the core's around store (src/behavior/around-store.ts) takes through the event door. The
// events are plain data. A custom status is dropped here, so its text never leaves this package; the activity
// type number becomes the protocol's word. Ids come from what makes the event (the member and the time), so a
// repeat is a duplicate at the door.

import {
  CONNECTION_CHANGED,
  PRESENCE_CHANGED,
  PRESENCE_SNAPSHOT,
  PRESENCE_STATUSES,
  VOICE_CHANGED,
} from '../../src/protocol/index.js';
import { DISCORD_IFACE } from './port.js';

/**
 * The fields of a discord.js `VoiceState` the builders read.
 * @typedef {{ id?: string, guild?: { id?: string }|null, channelId?: string|null, selfMute?: boolean,
 *   serverMute?: boolean, selfDeaf?: boolean, serverDeaf?: boolean, streaming?: boolean|null, selfVideo?: boolean,
 *   member?: { id?: string, displayName?: string }|null }} VoiceStateLike
 */

/**
 * The fields of a discord.js `Presence` the builders read.
 * @typedef {{ userId?: string, guild?: { id?: string }|null, user?: { id?: string }|null, member?: { id?: string, displayName?: string }|null,
 *   status?: string, activities?: Array<{ type?: number, name?: string, details?: string|null, state?: string|null }> }} PresenceLike
 */

/**
 * The fields of a discord.js `Guild` the snapshot reads.
 * @typedef {{ id?: string, voiceStates?: { cache?: Map<string, VoiceStateLike> },
 *   presences?: { cache?: Map<string, PresenceLike> } }} GuildLike
 */

// discord.js ActivityType, by number, as the protocol names a kind of activity.
const ACTIVITY_KINDS = { 0: 'playing', 1: 'streaming', 2: 'listening', 3: 'watching', 5: 'competing' };
const CUSTOM_STATUS = 4;

/**
 * A non-empty id string, else null.
 * @param {unknown} value
 * @returns {string|null}
 */
function idOf(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * A member's display name from a discord.js object's `member`, else null.
 * @param {{ displayName?: string }|null|undefined} member
 * @returns {string|null}
 */
function nameFrom(member) {
  const name = member?.displayName;
  return typeof name === 'string' && name !== '' ? name : null;
}

/**
 * The voice fields of a voice state, without the event envelope (the fields a snapshot entry shares).
 * @param {VoiceStateLike} state
 * @param {GuildLike|null} guild
 * @param {string|null} [previousId]
 */
function voiceFields(state, guild, previousId = null) {
  return {
    communityId: idOf(state?.guild?.id) ?? idOf(guild?.id),
    userId: idOf(state?.id) ?? idOf(state?.member?.id),
    name: nameFrom(state?.member),
    conversationId: idOf(state?.channelId),
    previousId,
    muted: state?.selfMute === true || state?.serverMute === true,
    deafened: state?.selfDeaf === true || state?.serverDeaf === true,
    streaming: state?.streaming === true,
    camera: state?.selfVideo === true,
  };
}

/**
 * The presence fields of a presence, without the event envelope.
 * @param {PresenceLike} presence
 */
function presenceFields(presence) {
  /** @type {Array<{ kind: string, name: string, details: string, state: string }>} */
  const activities = [];
  for (const activity of Array.isArray(presence?.activities) ? presence.activities : []) {
    if (activity?.type === CUSTOM_STATUS) continue;
    activities.push({
      kind: ACTIVITY_KINDS[activity?.type] ?? 'other',
      name: typeof activity?.name === 'string' ? activity.name : '',
      details: typeof activity?.details === 'string' ? activity.details : '',
      state: typeof activity?.state === 'string' ? activity.state : '',
    });
  }
  return {
    userId: idOf(presence?.userId) ?? idOf(presence?.user?.id) ?? idOf(presence?.member?.id),
    name: nameFrom(presence?.member),
    // A status Discord does not define stays unknown, never offline.
    status: PRESENCE_STATUSES.includes(presence?.status) ? presence.status : 'unknown',
    activities,
  };
}

/**
 * The `voice.changed` event of a discord.js `VoiceState` (or any object with the same fields). A member in no
 * channel gives `conversationId: null`. `previous`, when given, is the state before and gives `previousId`.
 * @param {VoiceStateLike} state
 * @param {number} at  When the change was seen (ms).
 * @param {{ channelId?: string|null }|null} [previous]
 * @returns {import('../../src/protocol/index.js').VoiceChanged}
 */
export function voiceEvent(state, at, previous = null) {
  const fields = voiceFields(state, null, idOf(previous?.channelId));
  return {
    kind: VOICE_CHANGED,
    iface: DISCORD_IFACE,
    at,
    id: `${DISCORD_IFACE}:voice:${fields.userId}:${at}`,
    ...fields,
  };
}

/**
 * The `presence.changed` event of a discord.js `Presence` (or any object with the same fields). A custom status is
 * dropped.
 * @param {PresenceLike} presence
 * @param {number} at
 * @returns {import('../../src/protocol/index.js').PresenceChanged}
 */
export function presenceEvent(presence, at) {
  const fields = presenceFields(presence);
  return {
    kind: PRESENCE_CHANGED,
    iface: DISCORD_IFACE,
    at,
    id: `${DISCORD_IFACE}:presence:${fields.userId}:${at}`,
    ...fields,
  };
}

/**
 * The `presence.snapshot` event of a guild: the voice states of the members in a channel and the presences its
 * cache holds, which replace what the core holds.
 * @param {GuildLike} guild
 * @param {number} at
 * @returns {import('../../src/protocol/index.js').PresenceSnapshot}
 */
export function presenceSnapshotEvent(guild, at) {
  /** @type {Array<ReturnType<typeof voiceFields>>} */
  const voice = [];
  for (const state of guild?.voiceStates?.cache?.values() ?? []) {
    const fields = voiceFields(state, guild);
    if (fields.conversationId !== null) voice.push(fields);
  }
  const presence = [...(guild?.presences?.cache?.values() ?? [])].map(presenceFields);
  return {
    kind: PRESENCE_SNAPSHOT,
    iface: DISCORD_IFACE,
    at,
    id: `${DISCORD_IFACE}:presence.snapshot:${guild?.id}:${at}`,
    voice,
    presence,
  };
}

/**
 * The `connection.changed` event of the gateway: `lost` when a shard dropped or is reconnecting, `resumed` when
 * it is back.
 * @param {'lost'|'resumed'} state
 * @param {number} at
 * @returns {import('../../src/protocol/index.js').ConnectionChanged}
 */
export function connectionEvent(state, at) {
  return {
    kind: CONNECTION_CHANGED,
    iface: DISCORD_IFACE,
    at,
    id: `${DISCORD_IFACE}:connection:${state}:${at}`,
    state,
  };
}
