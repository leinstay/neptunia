// The live glance at the voice channels and the people's statuses, held by the core. The interface reports
// `voice.changed`, `presence.changed`, `presence.snapshot` and `connection.changed` events through the event
// door and the door's handlers feed this store; src/behavior/around.js renders its `view()` into the
// `<people_now>` rows.
//
// A LIVE SNAPSHOT, never a record: the store lives in process memory, is never written to data/, the journal,
// the record, a log (counts only) or a backup, and is gone at a restart. Platforms send presences only for
// members who are not offline, so with the presences switch on and a fresh view a member without a presence
// record is offline; with the switch off or a stale view nothing is claimed about presence.
//
// Member-supplied text (names, activity names, details) is untrusted data: one line, clamped, angle brackets
// removed (cleanText), at most three activities per member.

import { cleanText } from './around.js';
import type { ConnectionChanged, PresenceChanged, PresenceSnapshot, VoiceChanged } from '../protocol/events.js';

const MAX_ACTIVITIES = 3;

export type VoiceRecord = {
  memberId: string;
  channelId: string;
  name: string | null;
  muted: boolean;
  deafened: boolean;
  streaming: boolean;
  camera: boolean;
  // Present when the join or the move was seen; a record from a snapshot has none.
  joinedAt?: number;
};

export type PresenceRecord = {
  memberId: string;
  name: string | null;
  status: 'online' | 'idle' | 'dnd' | 'offline' | 'unknown';
  activities: Array<{ kind: string; name: string; details: string; state: string }>;
};

export type AroundSnapshot = {
  presences: boolean;
  stale: boolean;
  voice: Map<string, VoiceRecord>;
  presence: Map<string, PresenceRecord>;
};

type VoiceFields = Pick<VoiceChanged, 'userId' | 'name' | 'muted' | 'deafened' | 'streaming' | 'camera'>;
type PresenceFields = Pick<PresenceChanged, 'userId' | 'name' | 'status' | 'activities'>;

const nameOf = (name: string | null | undefined): string | null => cleanText(name) || null;

function voiceRecord(state: VoiceFields, channelId: string): VoiceRecord {
  return {
    memberId: state.userId,
    channelId,
    name: nameOf(state.name),
    muted: state.muted === true,
    deafened: state.deafened === true,
    streaming: state.streaming === true,
    camera: state.camera === true,
  };
}

function presenceRecord(state: PresenceFields): PresenceRecord {
  const activities: PresenceRecord['activities'] = [];
  for (const activity of state.activities) {
    if (activities.length >= MAX_ACTIVITIES) break;
    const name = cleanText(activity.name);
    if (name === '') continue;
    activities.push({
      kind: activity.kind,
      name,
      details: cleanText(activity.details),
      state: cleanText(activity.state),
    });
  }
  return { memberId: state.userId, name: nameOf(state.name), status: state.status, activities };
}

export function createAroundStore(options: { presences: boolean }): {
  voiceChanged(event: VoiceChanged): void;
  presenceChanged(event: PresenceChanged): void;
  snapshot(event: PresenceSnapshot): void;
  connection(event: ConnectionChanged): void;
  view(): AroundSnapshot;
  counts(): { voice: number; presence: number; stale: boolean };
} {
  const { presences } = options;
  let voice = new Map<string, VoiceRecord>();
  let presence = new Map<string, PresenceRecord>();
  let stale = false;

  return {
    // A join, a move or a flag change replaces the record, a leave removes it. A join or a move stamps
    // `joinedAt` with the event's time, a flag change keeps the one held (none after a snapshot).
    voiceChanged(event) {
      if (event.conversationId === null) {
        voice.delete(event.userId);
        return;
      }
      const record = voiceRecord(event, event.conversationId);
      const held = voice.get(event.userId);
      if (held?.channelId === record.channelId) {
        if (held.joinedAt !== undefined) record.joinedAt = held.joinedAt;
      } else if (Number.isFinite(event.at)) {
        record.joinedAt = event.at;
      }
      voice.set(event.userId, record);
    },
    // Nothing is kept while the presences switch is off.
    presenceChanged(event) {
      if (!presences) return;
      presence.set(event.userId, presenceRecord(event));
    },
    // Both maps are replaced by what the interface knows now.
    snapshot(event) {
      voice = new Map();
      for (const entry of event.voice) {
        if (entry.conversationId !== null) voice.set(entry.userId, voiceRecord(entry, entry.conversationId));
      }
      presence = new Map();
      if (!presences) return;
      for (const entry of event.presence) presence.set(entry.userId, presenceRecord(entry));
    },
    connection(event) {
      stale = event.state === 'lost';
    },
    // Copies, so a renderer cannot change the store.
    view() {
      return { presences, stale, voice: new Map(voice), presence: new Map(presence) };
    },
    // Counts only, for a log line.
    counts() {
      return { voice: voice.size, presence: presence.size, stale };
    },
  };
}
