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
} from '../../src/protocol/index.ts';
import { DISCORD_IFACE } from './port.ts';

import type {
  ConnectionChanged,
  PresenceChanged,
  PresenceSnapshot,
  PresenceState,
  VoiceChanged,
} from '../../src/protocol/index.ts';
/** The fields of a discord.js `VoiceState` the builders read. */
export type VoiceStateLike = {
  id?: string;
  guild?: { id?: string } | null;
  channelId?: string | null;
  selfMute?: boolean;
  serverMute?: boolean;
  selfDeaf?: boolean;
  serverDeaf?: boolean;
  streaming?: boolean | null;
  selfVideo?: boolean;
  member?: { id?: string; displayName?: string } | null;
};

/** The fields of a discord.js `Presence` the builders read. */
export type PresenceLike = {
  userId?: string;
  guild?: { id?: string } | null;
  user?: { id?: string } | null;
  member?: { id?: string; displayName?: string } | null;
  status?: string;
  activities?: Array<{ type?: number; name?: string; details?: string | null; state?: string | null }>;
};

/** The fields of a discord.js `Guild` the snapshot reads. */
export type GuildLike = {
  id?: string;
  voiceStates?: { cache?: Map<string, VoiceStateLike> };
  presences?: { cache?: Map<string, PresenceLike> };
};

// discord.js ActivityType, by number, as the protocol names a kind of activity.
const ACTIVITY_KINDS: Record<number, 'playing' | 'streaming' | 'listening' | 'watching' | 'competing'> = {
  0: 'playing',
  1: 'streaming',
  2: 'listening',
  3: 'watching',
  5: 'competing',
};
const CUSTOM_STATUS = 4;

/** An id an event needs: a state without one gives none, and validateEvent refuses the event at the door. */
const requiredId = (value: string | null): string => value as string;

/** A non-empty id string, else null. */
function idOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A member's display name from a discord.js object's `member`, else null. */
function nameFrom(member: { displayName?: string } | null | undefined): string | null {
  const name = member?.displayName;
  return typeof name === 'string' && name !== '' ? name : null;
}

/** The voice fields of a voice state, without the event envelope (the fields a snapshot entry shares). */
function voiceFields(state: VoiceStateLike, guild: GuildLike | null, previousId: string | null = null) {
  return {
    placeId: requiredId(idOf(state?.guild?.id) ?? idOf(guild?.id)),
    accountId: requiredId(idOf(state?.id) ?? idOf(state?.member?.id)),
    name: nameFrom(state?.member),
    chatId: idOf(state?.channelId),
    previousId,
    muted: state?.selfMute === true || state?.serverMute === true,
    deafened: state?.selfDeaf === true || state?.serverDeaf === true,
    streaming: state?.streaming === true,
    camera: state?.selfVideo === true,
  };
}

/** The presence fields of a presence, without the event envelope. */
function presenceFields(presence: PresenceLike) {
  const activities: PresenceState['activities'] = [];
  for (const activity of Array.isArray(presence?.activities) ? presence.activities : []) {
    if (activity?.type === CUSTOM_STATUS) continue;
    activities.push({
      kind: (activity?.type === undefined ? undefined : ACTIVITY_KINDS[activity.type]) ?? 'other',
      name: typeof activity?.name === 'string' ? activity.name : '',
      details: typeof activity?.details === 'string' ? activity.details : '',
      state: typeof activity?.state === 'string' ? activity.state : '',
    });
  }
  return {
    accountId: requiredId(idOf(presence?.userId) ?? idOf(presence?.user?.id) ?? idOf(presence?.member?.id)),
    name: nameFrom(presence?.member),
    // A status Discord does not define stays unknown, never offline.
    status: PRESENCE_STATUSES.find((known) => known === presence?.status) ?? 'unknown',
    activities,
  };
}

/**
 * The `voice.changed` event of a discord.js `VoiceState` (or any object with the same fields). A member in no
 * channel gives `chatId: null`. `previous`, when given, is the state before and gives `previousId`.
 * @param at When the change was seen (ms).
 */
export function voiceEvent(
  state: VoiceStateLike,
  at: number,
  previous: { channelId?: string | null } | null = null
): VoiceChanged {
  const fields = voiceFields(state, null, idOf(previous?.channelId));
  return {
    kind: VOICE_CHANGED,
    iface: DISCORD_IFACE,
    at,
    id: `${DISCORD_IFACE}:voice:${fields.accountId}:${at}`,
    ...fields,
  };
}

/**
 * The `presence.changed` event of a discord.js `Presence` (or any object with the same fields). A custom status is
 * dropped.
 */
export function presenceEvent(presence: PresenceLike, at: number): PresenceChanged {
  const fields = presenceFields(presence);
  return {
    kind: PRESENCE_CHANGED,
    iface: DISCORD_IFACE,
    at,
    id: `${DISCORD_IFACE}:presence:${fields.accountId}:${at}`,
    ...fields,
  };
}

/**
 * The `presence.snapshot` event of a guild: the voice states of the members in a channel and the presences its
 * cache holds, which replace what the core holds.
 */
export function presenceSnapshotEvent(guild: GuildLike, at: number): PresenceSnapshot {
  const voice: Array<ReturnType<typeof voiceFields>> = [];
  const voiceStates = guild?.voiceStates?.cache;
  for (const state of voiceStates?.values() ?? []) {
    const fields = voiceFields(state, guild);
    if (fields.chatId !== null) voice.push(fields);
  }
  const presences = guild?.presences?.cache;
  const presence = [...(presences?.values() ?? [])].map(presenceFields);
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
 */
export function connectionEvent(state: 'lost' | 'resumed', at: number): ConnectionChanged {
  return {
    kind: CONNECTION_CHANGED,
    iface: DISCORD_IFACE,
    at,
    id: `${DISCORD_IFACE}:connection:${state}:${at}`,
    state,
  };
}
