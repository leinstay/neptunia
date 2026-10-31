// A member's line right after the persona spoke in a server channel: it joins the channel's newest participation
// episode (src/memory/participation.js#recordFollowing). createMessageHandler (src/behavior/pipeline.js) builds it once
// with createFollowing; handleMessage calls it for every member's line of the served guild.

import { diaryConversationIds } from '../behavior/mirror.ts';
import { log } from '../log.js';
import { participationSettings, recordFollowing } from '../memory/index.js';
import { MINUTE_MS } from '../time.js';
import type { Line, PipelineConfig, PipelineTurns, Thrown } from './types.ts';

/** The participation store of src/memory/store.js, as the following line writes it. */
type ParticipationStore = {
  getParticipation?: (guildId: string) => unknown;
  setParticipation?: (guildId: string, next: unknown, options: object) => void;
};

/** What createFollowing reads: the dependencies of createMessageHandler. */
export type FollowingContext = {
  store: ParticipationStore | null | undefined;
  turns: PipelineTurns;
  /** The memory database (src/memory/db/service.js), read for the places of her diary. */
  memoryDb: Parameters<typeof diaryConversationIds>[0];
  now: () => number;
};

export type NoteFollowingLine = (guildId: string, normalized: Line, config: PipelineConfig) => void;

export function createFollowing({ store, turns, memoryDb, now }: FollowingContext): {
  noteFollowingLine: NoteFollowingLine;
} {
  /**
   * A member's line in a server channel right after the persona spoke there: it joins the channel's newest
   * participation episode (src/memory/participation.js#recordFollowing, settings read now) and the store is written
   * only when it changed (`participation: recorded`, `following: true`). Cheap: nothing is fetched and no profile
   * read, and the store is not even read unless the persona's last post here (turns.lastPostAt) is within
   * `participation.followMinutes`. Off with features.memory or features.participation false (a
   * missing key counts as on), in a place of her diary (src/behavior/mirror.ts#diaryConversationIds), or for a store
   * without the participation store. Never throws: `participation: failed` (`reason: 'following-error'`).
   */
  function noteFollowingLine(guildId: string, normalized: Line, config: PipelineConfig): void {
    try {
      const features = config.features ?? {};
      if (features.memory === false || features.participation === false) return;
      if (diaryConversationIds(memoryDb).has(String(normalized.channelId))) return;
      const settings = participationSettings(config);
      const lastOwn = typeof turns.lastPostAt === 'function' ? turns.lastPostAt(normalized.channelId) : 0;
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
      const state = store.getParticipation(guildId);
      const next = recordFollowing(state, { channelId: normalized.channelId, message }, settings, at);
      if (next === state) return;
      store.setParticipation(guildId, next, { settings, now: at });
      log.info('participation: recorded', {
        channel: normalized.channelId,
        episodes: next.episodes.length,
        following: true,
      });
    } catch (err) {
      log.warn('participation: failed', {
        channel: normalized?.channelId ?? null,
        reason: 'following-error',
        name: (err as Thrown)?.name ?? null,
      });
    }
  }

  return { noteFollowingLine };
}
