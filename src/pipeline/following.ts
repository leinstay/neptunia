// A member's line right after the persona spoke in a server channel: it joins the channel's newest participation
// episode (src/memory/participation.ts#recordFollowing). createMessageHandler (src/behavior/pipeline.js) builds it once
// with createFollowing; handleMessage calls it for every member's line of the served place.

import { diaryConversationIds } from '../behavior/mirror.ts';
import { log } from '../log.ts';
import { participationSettings, recordFollowing } from '../memory/index.ts';
import { MINUTE_MS } from '../time.ts';
import type { Line, PipelineTurns, Thrown } from './types.ts';

/** The participation store of src/memory/store.ts, as the following line writes it. */
type ParticipationStore = {
  getParticipation?: (placeId: string) => unknown;
  setParticipation?: (placeId: string, next: unknown, options: object) => void;
};

/** What createFollowing reads: the dependencies of createMessageHandler. */
export type FollowingContext = {
  store: ParticipationStore | null | undefined;
  turns: PipelineTurns;
  /** The memory database (src/memory/db/service.ts), read for the places of her diary. */
  memoryDb: Parameters<typeof diaryConversationIds>[0];
  now: () => number;
};

export type NoteFollowingLine = (placeId: string, normalized: Line) => void;

export function createFollowing({ store, turns, memoryDb, now }: FollowingContext): {
  noteFollowingLine: NoteFollowingLine;
} {
  /**
   * A member's line in a server channel right after the persona spoke there: it joins the channel's newest
   * participation episode (src/memory/participation.ts#recordFollowing, settings read now) and the store is written
   * only when it changed (`participation: recorded`, `following: true`). Cheap: nothing is fetched and no profile
   * read, and the store is not even read unless the persona's last post here (turns.lastPostAt) is within
   * `participation.followMinutes`. Off with features.memory or features.participation false (a
   * missing key counts as on), in a place of her diary (src/behavior/mirror.ts#diaryConversationIds), or for a store
   * without the participation store. Never throws: `participation: failed` (`reason: 'following-error'`).
   */
  function noteFollowingLine(placeId: string, normalized: Line): void {
    try {
      if (diaryConversationIds(memoryDb).has(String(normalized.placeId))) return;
      const settings = participationSettings();
      const lastOwn = typeof turns.lastPostAt === 'function' ? turns.lastPostAt(normalized.placeId) : 0;
      if (!(lastOwn > 0) || normalized.ts - lastOwn > settings.followMinutes * MINUTE_MS) return;
      if (typeof store?.getParticipation !== 'function' || typeof store.setParticipation !== 'function') return;
      const message = {
        id: normalized.id,
        ts: normalized.ts,
        authorId: normalized.authorId,
        name: normalized.authorName ?? '',
        self: false,
        text: normalized.content ?? '',
        replyTo: normalized.replyToId ?? null,
        caption: null,
      };
      const at = now();
      const state = store.getParticipation(placeId);
      const next = recordFollowing(state, { placeId: normalized.placeId, message }, settings, at);
      if (next === state) return;
      store.setParticipation(placeId, next, { settings, now: at });
      log.info('participation: recorded', {
        channel: normalized.placeId,
        episodes: next.episodes.length,
        following: true,
      });
    } catch (err) {
      log.warn('participation: failed', {
        channel: normalized?.placeId ?? null,
        reason: 'following-error',
        name: (err as Thrown)?.name ?? null,
      });
    }
  }

  return { noteFollowingLine };
}
