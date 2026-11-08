// The persona's participation in a server turn: whether the turn has her participation store, which channels its
// episodes may come from, the live `<people_now>` input, a channel's live name for an episode, the record of each line
// she sends, and the input of the `<recent>` block. createTurnRunner (src/behavior/turn.ts) builds it once per runner
// with createParticipation; the attempt, the act and the journal notes call its functions.

import type { AroundSnapshot } from '../behavior/around-store.ts';
import { selfreflectionConversationIds } from '../behavior/mirror.ts';
import type { Snapshot } from '../behavior/snapshot.ts';
import { log } from '../log.ts';
import { collectPictures } from '../media/classify.ts';
import { participationSettings, recordOwnLine } from '../memory/index.ts';
import type { ConversationInfo } from '../protocol/adapter.ts';
import { inCommunity } from './routing.ts';

/** The config keys participation reads itself; the settings functions read their own sections. */
export type ParticipationConfig = Record<string, unknown>;

/** A participation store's state as src/memory/participation.ts keeps it. */
type ParticipationState = ReturnType<typeof recordOwnLine>;

/** The parts of the memory store participation reads and writes; a test's fake may lack the optional ones. */
export type ParticipationStore = {
  getParticipation?: (placeId: string) => ParticipationState;
  setParticipation: (placeId: string, state: ParticipationState, options: { settings: object; now: number }) => void;
  getRecent?: (placeId: string) => { lines?: unknown } | null | undefined;
};

/** What createParticipation reads: the live config, the store, the around store and the clock. */
export type ParticipationContext = {
  hot: { readonly config: ParticipationConfig };
  store: ParticipationStore;
  around: { view(): AroundSnapshot } | null;
  clock: () => number;
};

/** A message of a turn's history as participation reads it. */
type HistoryMessage = {
  id: string | null;
  ts: number;
  self?: boolean;
  authorId?: string | null;
  authorName?: string | null;
  content?: unknown;
  replyToId?: string | null;
};

/** One message in the participation store's shape. */
type ParticipationMessage = {
  id: string | null;
  ts: number;
  authorId: string;
  name: string;
  self: boolean;
  text: string;
  replyTo: string | null;
  caption: string | null;
};

/** The live part of `<people_now>`. */
type AroundInput = { snapshot: AroundSnapshot; channelNameOf: (placeId: string) => string | null };

export type Participation = {
  participationOn: (channel: ConversationInfo) => boolean;
  aroundInputFor: (args: {
    config: ParticipationConfig;
    mode: string | null | undefined;
    isPrivate: boolean;
    snapshot?: Snapshot | null;
  }) => AroundInput | null;
  liveChannelName: (
    channel: { rootId?: string | null } | null | undefined,
    snapshot?: Snapshot | null
  ) => (placeId: string) => string | null;
  recordOwnParticipation: (args: {
    channel: ConversationInfo;
    placeId: string;
    history: ReadonlyArray<HistoryMessage>;
    earlier: ReadonlyArray<HistoryMessage>;
    own: HistoryMessage;
    replyId: string | null | undefined;
    selfName: string;
    descriptions: unknown;
  }) => void;
};

export function createParticipation({ store, around, clock }: ParticipationContext): Participation {
  /**
   * Whether a server turn in `channel` has the persona's participation store: features.memory
   * and features.participation on (`config`, the turn's live config; a missing key counts as on),
   * a server channel that is not a place of her selfreflection (src/behavior/mirror.ts#selfreflectionConversationIds), and a store that
   * keeps one. Recording asks this.
   */
  function participationOn(channel: ConversationInfo): boolean {
    if (!inCommunity(channel) || typeof store.getParticipation !== 'function') return false;
    return !selfreflectionConversationIds(store).has(String(channel.id));
  }

  /**
   * The live part of `<people_now>` (src/behavior/around-store.ts): the snapshot of the voice channels and
   * of the statuses (the prompt builder computes each person's row from it) and the voice channels' names -- only those a member without any role may see, so
   * she never names who sits in a room this chat cannot see. Null without the store, with
   * `features.around` off (a missing key counts as on), in a private chat and in a selfreflection post.
   * Read at the moment of the request; nothing of it is kept.
   */
  function aroundInputFor({
    mode,
    isPrivate,
    snapshot = null,
  }: {
    config: ParticipationConfig;
    mode: string | null | undefined;
    isPrivate: boolean;
    snapshot?: Snapshot | null;
  }): AroundInput | null {
    if (!around || isPrivate || mode === 'selfreflection') return null;
    return {
      snapshot: around.view(),
      channelNameOf: (placeId) => {
        const entry = snapshot?.get(String(placeId));
        const visible = entry?.voice === true && entry.public === true;
        return visible && typeof entry.name === 'string' && entry.name ? entry.name : null;
      },
    };
  }

  /**
   * A channel's live name in `channel`'s place, for a participation episode whose channel has no stored note.
   */
  function liveChannelName(
    channel: { rootId?: string | null } | null | undefined,
    snapshot: Snapshot | null = null
  ): (placeId: string) => string | null {
    return (placeId) => {
      const name = inCommunity(channel) ? snapshot?.get(String(placeId))?.name : undefined;
      return typeof name === 'string' && name ? name : null;
    };
  }

  /**
   * One message of a turn's history in the participation store's shape
   * (src/memory/participation.ts): the persona's own lines named `selfName`, a picture's
   * caption the turn already had (`descriptions`, the first captioned picture of the line).
   */
  function participationMessage(
    message: HistoryMessage,
    { selfName, descriptions }: { selfName: string; descriptions: unknown }
  ): ParticipationMessage {
    let caption: string | null = null;
    if (descriptions instanceof Map && descriptions.size > 0) {
      for (const item of collectPictures(message)) {
        const text: unknown = descriptions.get(item.itemId);
        if (typeof text === 'string' && text) {
          caption = text;
          break;
        }
      }
    }
    return {
      id: message.id,
      ts: message.ts,
      authorId: message.authorId ?? '',
      name: message.self ? selfName : (message.authorName ?? ''),
      self: message.self === true,
      text: typeof message.content === 'string' ? message.content : '',
      replyTo: message.replyToId ?? null,
      caption,
    };
  }

  /**
   * Record one message the persona just sent in `channel` in the place's participation store
   * (src/memory/participation.ts#recordOwnLine, settings read now): `own` her message, `before`
   * the last `participation.linesBefore` lines of the turn's `history` followed by what she
   * already sent this turn (`earlier`), `parent` the line it replies to when the history holds
   * it (the reply parents the turn fetched included; nothing is fetched here). Written only when
   * something changed, then logged `participation: recorded` (`channel`, `episodes`: how many
   * the store holds). Never throws: a failure logs `participation: failed` (`reason:
   * 'record-error'`).
   */
  function recordOwnParticipation({
    channel,
    placeId,
    history,
    earlier,
    own,
    replyId,
    selfName,
    descriptions,
  }: {
    channel: ConversationInfo;
    placeId: string;
    history: ReadonlyArray<HistoryMessage>;
    earlier: ReadonlyArray<HistoryMessage>;
    own: HistoryMessage;
    replyId: string | null | undefined;
    selfName: string;
    descriptions: unknown;
  }): void {
    try {
      if (!participationOn(channel)) return;
      const settings = participationSettings();
      const at = clock();
      const shape = (message: HistoryMessage): ParticipationMessage =>
        participationMessage(message, { selfName, descriptions });
      const take = Math.max(0, Math.floor(settings.linesBefore));
      const before = take > 0 ? [...history, ...earlier].slice(-take).map(shape) : [];
      const parentLine = replyId ? (history.find((message) => message.id === replyId) ?? null) : null;
      // participationOn above checked that the store has getParticipation.
      const state = store.getParticipation!(placeId);
      const next = recordOwnLine(
        state,
        { placeId: channel.id, own: shape(own), before, parent: parentLine ? shape(parentLine) : null },
        settings,
        at
      );
      if (next === state) return;
      store.setParticipation(placeId, next, { settings, now: at });
      log.info('participation: recorded', { channel: channel.id, episodes: next.episodes.length });
    } catch (err) {
      // A thrown value is anything; its name is read when it has one, as an Error does.
      log.warn('participation: failed', {
        channel: channel?.id ?? null,
        reason: 'record-error',
        name: (err as { name?: unknown } | null)?.name ?? null,
      });
    }
  }

  return {
    participationOn,
    aroundInputFor,
    liveChannelName,
    recordOwnParticipation,
  };
}
