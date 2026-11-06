// The persona's participation in a server turn: whether the turn has her participation store, which channels its
// episodes may come from, the live `<people_now>` input, a channel's live name for an episode, the record of each line
// she sends, and the input of the `<recent>` block. createTurnRunner (src/behavior/turn.ts) builds it once per runner
// with createParticipation; the attempt, the act and the journal notes call its functions.

import type { AroundSnapshot } from '../behavior/around-store.ts';
import { audienceCovers } from '../behavior/elsewhere.ts';
import { selfreflectionConversationIds } from '../behavior/mirror.ts';
import { audienceAllows, everyMemberAudience, railAudience } from '../behavior/snapshot.ts';
import type { Snapshot } from '../behavior/snapshot.ts';
import { log } from '../log.ts';
import { collectPictures } from '../media/classify.ts';
import { participationSettings, recordOwnLine } from '../memory/index.ts';
import { liveRecent, recentSettings } from '../memory/recent.ts';
import type { ConversationInfo } from '../protocol/adapter.ts';
import { NO_RECENT } from './history.ts';
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

/** The input of `<recent>`: the lines and which source channels the turn may show them from. */
type RecentInput = {
  lines: Array<object> | undefined;
  audience: ((placeId: string | null) => boolean) | undefined;
};

/** The live part of `<people_now>`. */
type AroundInput = { snapshot: AroundSnapshot; channelNameOf: (placeId: string) => string | null };

export type Participation = {
  participationOn: (channel: ConversationInfo) => boolean;
  participationAudience: (
    channel: ConversationInfo,
    config: unknown,
    snapshot?: Snapshot | null
  ) => (placeId: string) => boolean;
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
  recentInput: (args: {
    channel: ConversationInfo;
    snapshot?: Snapshot | null;
    placeId: string;
    isPrivate: boolean;
    config: object;
    now: number;
  }) => RecentInput;
  recentOfPlaces: (
    holders: ReadonlyArray<string>,
    args: {
      channel: ConversationInfo;
      snapshot?: Snapshot | null;
      isPrivate: boolean;
      config: object;
      now: number;
    }
  ) => RecentInput;
};

export function createParticipation({ store, around, clock }: ParticipationContext): Participation {
  /**
   * Whether a server turn in `channel` has the persona's participation store: features.memory
   * and features.participation on (`config`, the turn's live config; a missing key counts as on),
   * a server channel that is not a place of her selfreflection (src/behavior/mirror.ts#selfreflectionConversationIds), and a store that
   * keeps one. Recording, the pick classifier and the `<participation>` block all ask this.
   */
  function participationOn(channel: ConversationInfo): boolean {
    if (!inCommunity(channel) || typeof store.getParticipation !== 'function') return false;
    return !selfreflectionConversationIds(store).has(String(channel.id));
  }

  /**
   * Which channels a turn in `channel` may show participation episodes from: a conversation of its
   * community (the turn's snapshot) whose audience passes the rail the neighbours and the pulls pass
   * (src/behavior/snapshot.ts#audienceAllows, `context.pull.sameAudience`: everyone who can
   * read this channel can read that one). A conversation the snapshot does not hold, or a check that
   * throws, is refused.
   */
  function participationAudience(
    channel: ConversationInfo,
    config: unknown,
    snapshot: Snapshot | null = null
  ): (placeId: string) => boolean {
    return (placeId) => {
      try {
        const other = snapshot?.get(String(placeId)) ?? null;
        return Boolean(other) && audienceAllows(channel, other, config);
      } catch {
        return false;
      }
    };
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

  /**
   * The input of a turn's `<recent>` block (src/behavior/prompt.ts#buildRequest
   * `recentLines` / `recentAudience`): the place's recent lines inside the last
   * `memory.recentHours` (src/memory/store.ts#getRecent, read now) and which
   * source channels this turn may show them from. On a server turn: the
   * channel the turn posts in, and every channel whose audience covers it
   * (the snapshot's audiences, src/behavior/elsewhere.ts#audienceCovers:
   * everyone who can read this channel can read that one). In a private chat:
   * the channels every member of the served place can read. A channel the
   * place does not hold is never covered. No live line: an empty list (the
   * block may still show the members' moments of those hours). Nothing
   * (`lines` undefined: no block at all) with features.recent off (a missing
   * key counts as on) or for a store without the recent store (tests' fakes);
   * a read that throws is logged (`recent: failed`) and is nothing either: the
   * block is never worth a turn.
   */
  /**
   * `<recent>` of a turn that belongs to no server (her selfreflection with no place to be posted in): the recent lines of every
   * place in `holders`, each under the audience rule of `recentInput`.
   */
  function recentOfPlaces(
    holders: ReadonlyArray<string>,
    args: Omit<Parameters<Participation['recentInput']>[0], 'placeId'>
  ): RecentInput {
    const parts = holders.map((placeId) => recentInput({ ...args, placeId }));
    const [only] = parts;
    if (parts.length === 1 && only) return only;
    return {
      lines: parts.flatMap((part) => part.lines ?? []),
      audience: (conversationId) => parts.some((part) => part.audience?.(conversationId) === true),
    };
  }

  function recentInput({
    channel,
    snapshot = null,
    placeId,
    isPrivate,
    config,
    now,
  }: {
    channel: ConversationInfo;
    snapshot?: Snapshot | null;
    placeId: string;
    isPrivate: boolean;
    config: object;
    now: number;
  }): RecentInput {
    const settings = recentSettings(config);
    if (!settings || typeof store.getRecent !== 'function') return NO_RECENT;
    try {
      const lines = liveRecent(store.getRecent(placeId)?.lines, { now, hours: settings.hours });
      if (lines.length === 0) return { lines, audience: undefined };
      const here = isPrivate ? everyMemberAudience() : railAudience(channel.audience);
      const allowed = new Set<unknown>();
      // liveRecent keeps the recent store's lines, each a record with its source `placeId`.
      for (const id of new Set(lines.map((line) => (line as { placeId?: unknown }).placeId))) {
        if (typeof id !== 'string' || !id) continue;
        if (!isPrivate && id === channel.id) allowed.add(id);
        else if (audienceCovers(here, railAudience(snapshot?.get(String(id))?.audience))) allowed.add(id);
      }
      return { lines, audience: (conversationId) => allowed.has(conversationId) };
    } catch (err) {
      log.warn('recent: failed', { channel: channel.id, error: err });
      return NO_RECENT;
    }
  }

  return {
    participationOn,
    participationAudience,
    aroundInputFor,
    liveChannelName,
    recordOwnParticipation,
    recentInput,
    recentOfPlaces,
  };
}
