// The other channels a turn shows in `<channel_view>`: which ones it pulls (the source, the mentions, the route hook's
// picks, the ones an exchange keeps), their fresh captions and last views, and what a turn that spoke leaves behind
// (the seen marks, the lines it had in view, the calls of the ring it stamps). createTurnRunner (src/behavior/turn.js)
// builds it once per runner with createPulls over the runner's pull state; the attempt calls its functions.

import { markSeen, stampPings } from '../behavior/elsewhere.ts';
import { captionPulled, checkPull, fetchPull } from '../behavior/pull-fetch.ts';
import type { PulledChannel, createPullViews } from '../behavior/pull-fetch.ts';
import { channelPullOn, pullSettings, pullTargets } from '../behavior/pull.js';
import type { Snapshot } from '../behavior/snapshot.ts';
import type { Reads } from '../interface/reads.ts';
import { log } from '../log.js';
import type { ConversationInfo } from '../protocol/adapter.ts';
import type { TriggerKind } from './triggers.ts';

type FetchArgs = Parameters<typeof fetchPull>[0];

/** The live config, as far as the pulls read it; the settings functions read their own sections. */
export type PullsConfig = FetchArgs['config'] & { features?: { mediaDescriptions?: unknown } | null };

/** A pull's settings (src/behavior/pull.js#pullSettings). */
type PullSettings = ReturnType<typeof pullSettings>;

/** One channel pullTargets lists. */
type PullTarget = ReturnType<typeof pullTargets>[number];

/** What an exchange keeps pulled in a destination: `{ channelIds, at, turns, authorId }`. */
export type KeptPull = { channelIds: Array<string>; at: number; turns: number; authorId: string | null };

/** A route hook's pick: a channel, and whether the page before its last view is wanted. */
type RoutePick = { id: string; direction: 'earlier' | null };

/** The trigger of a turn, as the pulls read it. */
type PullTrigger = (NonNullable<FetchArgs['trigger']> & { authorId?: string | null }) | null | undefined;

/** The memory store's state, as the pulls read and write it. */
type PullsStore = {
  state: {
    data: { elsewherePings?: unknown; elsewhereSeen?: unknown; paused?: unknown };
    markDirty: () => void;
  };
};

/** What createPulls reads: the dependencies and the pull state the runner keeps. */
export type PullsContext = {
  hot: { readonly config: PullsConfig };
  store: PullsStore;
  describer: FetchArgs['describer'] | undefined;
  routeChannels: ((args: Record<string, unknown>) => unknown) | undefined;
  clock: () => number;
  ifaceReads: Reads;
  pullViews: ReturnType<typeof createPullViews>;
  keptPulls: Map<string, KeptPull>;
  spokeSaw: Map<string, Set<string>>;
};

/** A request's `pulledKept`: the lines shown of each pulled channel. */
type Shown = ReadonlyArray<{ channelId: string; ids: Array<string> }>;

export type PullArgs = {
  channel: ConversationInfo;
  guildId: string | null;
  snapshot?: Snapshot | null;
  partner?: { id?: string | null } | null;
  history: NonNullable<NonNullable<Parameters<typeof pullTargets>[0]>['history']>;
  trigger: PullTrigger;
  candidate?: unknown;
  triggerKind?: TriggerKind | null;
  source: { channelId: string; reason: 'routed' | 'noticed' } | null | undefined;
  selfName: string;
  config: PullsConfig;
  now: number;
  certain: boolean;
  labelled: boolean;
  routePlan?: ((args: { lines: unknown; routed: PulledChannel | null }) => Promise<ReadonlyArray<RoutePick>>) | null;
};

export type Pulls = {
  pullChannels: (args: PullArgs) => Promise<{ pulled: Array<PulledChannel>; sourceSkip: string | null }>;
  captionAll: (
    pulled: Array<PulledChannel>,
    at: { guildId: string | null; config: PullsConfig; destination: { id: string } }
  ) => Promise<Array<PulledChannel>>;
  withSeenBefore: (pulled: Array<PulledChannel>, destinationId: string, at: number) => Array<PulledChannel>;
  markPulledSeen: (shown: ReadonlyArray<{ channelId: string; newestTs: number }>) => void;
  noteSpokeSaw: (
    channel: { id: string },
    history: ReadonlyArray<{ id: string }>,
    shown: Shown,
    pulled: ReadonlyArray<PulledChannel>,
    deferred?: Set<string>
  ) => void;
  stampShownCalls: (args: {
    shown: Shown;
    pulled: ReadonlyArray<PulledChannel>;
    answered: Set<string>;
    exceptId: string | null;
  }) => void;
};

// health: allow function-length until 2027-04-01 -- the pulls share the runner state of src/behavior/turn.js, moved whole in stage 5b
export function createPulls(ctx: PullsContext): Pulls {
  const { hot, store, describer, routeChannels, clock, ifaceReads, pullViews, keptPulls, spokeSaw } = ctx;

  /**
   * fetchPull (src/behavior/pull-fetch.ts) that never throws: an unexpected
   * failure is logged (`pull: failed`) and counts as a skip with code `error`.
   */
  async function pullSafely(
    args: Omit<FetchArgs, 'reads'>
  ): Promise<{ pulled: PulledChannel | null; skip: string | null }> {
    try {
      return await fetchPull({ reads: ifaceReads, ...args });
    } catch (err) {
      log.warn('pull: failed', {
        channel: args.destination?.id ?? null,
        source: args.channelId,
        pullReason: args.reason,
        error: err,
      });
      return { pulled: null, skip: 'error' };
    }
  }

  /**
   * The route hook's picks as `{ id, direction }`: a non-empty string id (direction null) or
   * `{ id, direction: 'earlier' }` (the page before the last view of that channel); anything
   * else is dropped. A throw (`pull: route failed`) or a non-array answer is [].
   */
  async function routeIds(args: Record<string, unknown> & { channel: { id: string } }): Promise<Array<RoutePick>> {
    try {
      // pullChannels asks routeIds only when the hook is a function.
      const ids = await routeChannels!(args);
      if (!Array.isArray(ids)) return [];
      return (
        (ids as Array<unknown>)
          .map((pick) =>
            typeof pick === 'string'
              ? { id: pick, direction: null }
              : {
                  // A pick that is not a string is read as `{ id, direction }`; anything else drops below.
                  id: (pick as { id?: unknown } | null)?.id,
                  direction: (pick as { direction?: unknown } | null)?.direction === 'earlier' ? 'earlier' : null,
                }
          )
          // The filter keeps the picks whose id is a string.
          .filter((pick) => typeof pick.id === 'string' && pick.id !== '') as Array<RoutePick>
      );
    } catch (err) {
      log.warn('pull: route failed', { channel: args.channel.id, error: err });
      return [];
    }
  }

  /**
   * The other channels a server turn shows in `<channel_view>`, each fetched
   * by fetchPull, in the order of src/behavior/pull.js#pullTargets: the
   * turn's `source` first and alone -- a turn about it does not go on
   * without it, so nothing else is fetched when it fails -- then the explicit
   * `<#id>` mentions of the trigger and of the last `context.pull.scanMessages`
   * messages, then the route hook's ids (routeIds; asked only with
   * features.channelPull on and while a slot is
   * left; on a routed turn it reads the source's lines; a pick marked
   * `earlier` fetches the page before the oldest line of the last view of that
   * channel shown here, pullViews within `context.pull.seenTtlMinutes`, else
   * the newest page -- the source itself is never paged back), at most
   * `context.pull.maxChannels` in all. features.channelPull off: the source
   * alone. Without `labelled` (no `labels.pull.header`: buildRequest renders
   * no `<channel_view>`) the source alone too, with no fresh caption, and one
   * `pull: skipped` (`reason: 'no-label'`) when the turn had a source, a
   * mention or a route hook to ask. Every candidate is judged once, without a
   * request, by the rails fetchPull checks first (checkPull); a refused one
   * logs `pull: skipped` (`channel`, `source` = its id, `reason` = the skip
   * code, `pullReason` = `mention` or `route`), one whose check throws logs
   * `pull: failed` and is not pulled. Every pull reads the ring of calls
   * (`state.json` `elsewherePings`) for its ping marks. Fresh captions only
   * with `certain` (no chooser can still end the turn as not-now). Settings come from `config`, the turn's live config.
   * `candidate` (default: the trigger) is what the route hook judges: on a
   * turn answering one part of a split message, the trigger with that part's text.
   * A private chat with its `partner` (privatePartner) pulls the same way from
   * `snapshot`, the served community's listing, every rail judged against the partner instead of
   * an audience (checkPull: their view of the candidate); it has no
   * source. `routePlan` (the turn planner's route step, src/turn/phases/request/planner.ts; null
   * without features.turnPlanner): `({ lines, routed }) => Promise<{ id,
   * direction }[]>`, asked where the route hook would be, instead of it.
   * Resolves the PulledChannel records, source first; `sourceSkip` is the skip code of a source that could not be
   * pulled.
   */
  // health: allow complexity until 2027-04-01 -- moved whole from src/behavior/turn.js in stage 5b, a pure move
  async function pullChannels({
    channel,
    guildId,
    snapshot = null,
    partner = null,
    history,
    trigger,
    candidate = trigger,
    triggerKind = null,
    source,
    selfName,
    config,
    now,
    certain,
    labelled,
    routePlan = null,
  }: PullArgs): Promise<{ pulled: Array<PulledChannel>; sourceSkip: string | null }> {
    const settings = pullSettings(config);
    const channelPull = channelPullOn(config) && labelled;
    // Every candidate judged once: its skip code (null = pullable) and why it was a candidate.
    const judged = new Map<string, { skip: string | null; pullReason: string }>();
    let judging = 'mention';
    const judge = (id: string): string | null => {
      try {
        return checkPull({ snapshot, channelId: id, destination: channel, partnerId: partner?.id ?? null, config, now })
          .skip;
      } catch (err) {
        log.warn('pull: failed', { channel: channel.id, source: id, pullReason: judging, error: err });
        return 'error';
      }
    };
    const isPullable = (id: string): boolean => {
      if (!judged.has(id)) judged.set(id, { skip: judge(id), pullReason: judging });
      // The entry was set just above when it was missing.
      return judged.get(id)!.skip === null;
    };
    // The channels the exchange with this author keeps from an earlier turn (context.pull.keepMinutes / keepTurns).
    const keptIds = keptPullIds(channel.id, trigger, now, settings);
    const targetsWith = (
      extra: Array<string>,
      {
        pullable = isPullable,
        more = channelPull,
        kept = [],
      }: { pullable?: (id: string) => boolean; more?: boolean; kept?: Array<string> } = {}
    ): Array<PullTarget> =>
      pullTargets({
        source,
        history,
        trigger,
        extra,
        kept,
        currentChannelId: channel.id,
        scanMessages: settings.scanMessages,
        maxChannels: settings.maxChannels,
        isPullable: pullable,
        channelPull: more,
      });
    const logRefused = (): void => {
      for (const [id, { skip, pullReason }] of judged) {
        // A check that threw was logged as `pull: failed` already.
        if (skip && skip !== 'error')
          log.info('pull: skipped', { channel: channel.id, source: id, reason: skip, pullReason });
      }
    };
    if (!labelled) {
      // What the turn would have pulled with the label (unjudged: no check is wasted on it).
      const wanted = targetsWith([], { pullable: () => true, more: channelPullOn(config) });
      const hookWanted =
        typeof routeChannels === 'function' && channelPullOn(config) && wanted.length < settings.maxChannels;
      if (wanted.length > 0 || hookWanted) log.info('pull: skipped', { channel: channel.id, reason: 'no-label' });
    }
    // The ring of calls the store keeps (src/behavior/elsewhere.ts).
    const pings = (store.state.data.elsewherePings ?? []) as FetchArgs['pings'];
    // The route hook's channels asked for the page before their last view here.
    const earlierIds = new Set<string>();
    const pageOf = (channelId: string): { direction?: 'earlier'; beforeId?: string | null } => {
      if (!earlierIds.has(channelId)) return {};
      const previous = pullViews.previous(channel.id, channelId, { now, ttlMinutes: settings.seenTtlMinutes });
      return { direction: 'earlier', beforeId: previous?.oldestId ?? null };
    };
    const pullOne = (target: PullTarget): ReturnType<typeof pullSafely> =>
      pullSafely({
        snapshot,
        guildId,
        channelId: target.channelId,
        destination: channel,
        partnerId: partner?.id ?? null,
        reason: target.reason,
        trigger: target.reason === 'routed' ? trigger : null,
        ...pageOf(target.channelId),
        pings,
        config,
        now,
        describer: describer ?? null,
        turnCertain: certain && labelled,
      });

    let targets = targetsWith([]);
    let picked = false;
    const sourceTarget = source ? (targets.find((target) => target.channelId === source.channelId) ?? null) : null;
    let sourcePulled: PulledChannel | null = null;
    if (sourceTarget) {
      const result = await pullOne(sourceTarget);
      if (!result.pulled) {
        logRefused();
        return { pulled: [], sourceSkip: result.skip };
      }
      sourcePulled = result.pulled;
    }
    if ((routePlan || typeof routeChannels === 'function') && channelPull && targets.length < settings.maxChannels) {
      const routedLines = source?.reason === 'routed' ? sourcePulled?.messages : null;
      // With the turn planner its channel block stands in for the route hook (never both).
      const picks = routePlan
        ? await routePlan({ lines: routedLines ?? history, routed: routedLines ? sourcePulled : null })
        : await routeIds({
            guildId,
            channel,
            snapshot,
            partner,
            history: routedLines ?? history,
            trigger: candidate,
            triggerKind,
            selfName,
            config,
          });
      judging = 'route';
      for (const pick of picks)
        if (pick.direction === 'earlier' && pick.id !== sourceTarget?.channelId) earlierIds.add(pick.id);
      if (picks.length > 0) {
        targets = targetsWith(picks.map((pick) => pick.id));
        picked = true;
      }
    }
    // A pick of the router (or a mention) replaces the kept channel; otherwise it fills a free slot.
    if (!picked && keptIds.length > 0 && channelPull && targets.length < settings.maxChannels) {
      judging = 'kept';
      targets = targetsWith([], { kept: keptIds });
    }
    const rest = targets.filter((target) => target.channelId !== sourceTarget?.channelId);
    const fetched = await Promise.all(rest.map(pullOne));
    logRefused();
    const got = rest.filter((target, i) => fetched[i].pulled);
    noteKeptPull(channel.id, trigger, now, settings, {
      fresh: got.filter((target) => target.reason !== 'kept').map((target) => target.channelId),
      keptWanted: keptIds.length > 0,
      keptUsed: got.filter((target) => target.reason === 'kept').map((target) => target.channelId),
    });
    return {
      pulled: [sourcePulled, ...fetched.map((result) => result.pulled)].filter((entry): entry is PulledChannel =>
        Boolean(entry)
      ),
      sourceSkip: null,
    };
  }

  /**
   * The channels a turn in `destinationId` keeps pulled from an earlier turn of the exchange:
   * only for a turn with a trigger from the author who pulled them, within `context.pull.keepMinutes`
   * of the pull and at most `context.pull.keepTurns` kept turns. An entry that no longer qualifies
   * is dropped; a turn without a trigger (spontaneous, inner) leaves it alone. Logged `pull: kept`
   * (`pullReason` `kept`) by noteKeptPull when it is used.
   */
  function keptPullIds(
    destinationId: string,
    trigger: PullTrigger,
    now: number,
    settings: PullSettings
  ): Array<string> {
    const entry = keptPulls.get(destinationId);
    if (!entry || !trigger) return [];
    const live =
      settings.keepTurns > 0 &&
      entry.turns < settings.keepTurns &&
      now - entry.at < settings.keepMinutes * 60000 &&
      trigger.authorId &&
      trigger.authorId === entry.authorId;
    if (!live) {
      keptPulls.delete(destinationId);
      return [];
    }
    return entry.channelIds;
  }

  /**
   * What pullChannels pulled, for the exchange to keep: channels pulled by a mention or the router
   * (`fresh`) start a new keep for the trigger's author; kept ones that were pulled again
   * (`keptUsed`) count one turn; kept ones that could not be pulled end the keep.
   */
  function noteKeptPull(
    destinationId: string,
    trigger: PullTrigger,
    now: number,
    settings: PullSettings,
    { fresh, keptWanted, keptUsed }: { fresh: Array<string>; keptWanted: boolean; keptUsed: Array<string> }
  ): void {
    if (!trigger || settings.keepTurns <= 0) return;
    if (fresh.length > 0) {
      keptPulls.set(destinationId, { channelIds: fresh, at: now, turns: 0, authorId: trigger.authorId ?? null });
      return;
    }
    const entry = keptPulls.get(destinationId);
    if (!entry || !keptWanted) return;
    if (keptUsed.length === 0) {
      keptPulls.delete(destinationId);
      return;
    }
    entry.turns += 1;
    log.info('pull: kept', {
      channel: destinationId,
      source: keptUsed.join(','),
      pullReason: 'kept',
      turns: entry.turns,
    });
  }

  /**
   * Fresh captions (src/behavior/pull-fetch.ts#captionPulled) for channels
   * pulled before a chooser, once the turn is certain to run; only with
   * features.mediaDescriptions on and a describer. Never rejects: a channel
   * whose captions fail keeps the cached ones (`pull: captions failed`).
   */
  function captionAll(
    pulled: Array<PulledChannel>,
    { guildId, config, destination }: { guildId: string | null; config: PullsConfig; destination: { id: string } }
  ): Promise<Array<PulledChannel>> {
    if (pulled.length === 0 || config.features?.mediaDescriptions !== true || !describer)
      return Promise.resolve(pulled);
    return Promise.all(
      pulled.map((entry) =>
        captionPulled(entry, { describer, guildId, config, destination }).catch((err: unknown) => {
          log.warn('pull: captions failed', { channel: destination.id, source: entry.channelId, error: err });
          return entry;
        })
      )
    );
  }

  /**
   * The pulled records with the last view of each shown in `destinationId`
   * (pullViews, within `context.pull.seenTtlMinutes` read now) as `seenBefore`,
   * new objects; a record without one is passed as it is. buildRequest reads
   * features.pullSeenMarker itself. `at` is the turn's clock.
   */
  function withSeenBefore(pulled: Array<PulledChannel>, destinationId: string, at: number): Array<PulledChannel> {
    const { seenTtlMinutes } = pullSettings(hot.config);
    return pulled.map((entry) => {
      const seenBefore = pullViews.previous(destinationId, entry.channelId, { now: at, ttlMinutes: seenTtlMinutes });
      return seenBefore ? { ...entry, seenBefore } : entry;
    });
  }

  /**
   * Move the seen mark of each pulled channel whose block the request showed
   * (buildRequest's `pulledKept`) to the newest line shown, in `state.json`
   * `elsewhereSeen` (src/behavior/elsewhere.ts#markSeen: never backwards). The
   * caller marks the state dirty.
   */
  function markPulledSeen(shown: ReadonlyArray<{ channelId: string; newestTs: number }>): void {
    if (shown.length === 0) return;
    let seen = store.state.data.elsewhereSeen;
    for (const { channelId, newestTs } of shown) seen = markSeen(seen, channelId, newestTs);
    store.state.data.elsewhereSeen = seen;
  }

  /**
   * What a turn that spoke had in view (spokeAfterSeeing): this channel's
   * history under this channel, and the lines shown of each pulled channel
   * the bot cannot write in under that channel -- a call there is answered
   * here, so one queued meanwhile and already shown is not answered twice. A
   * pulled channel the bot can write in keeps its own record: a call written
   * there is answered there, not by being shown here. The calls the request
   * named as still waiting for their own turn (`deferred`: the author's queued
   * calls under `labels.task.queued` or a part's `{others}`) are left out: in
   * view, yet deliberately not answered by this turn. `shown` is buildRequest's `pulledKept`, `pulled` the
   * PulledChannel records (their `readOnly`).
   */
  function noteSpokeSaw(
    channel: { id: string },
    history: ReadonlyArray<{ id: string }>,
    shown: Shown,
    pulled: ReadonlyArray<PulledChannel>,
    deferred: Set<string> = new Set()
  ): void {
    spokeSaw.set(channel.id, new Set(history.map((m) => m.id).filter((id) => !deferred.has(id))));
    const readOnly = readOnlyIdsOf(pulled);
    for (const { channelId, ids } of shown) {
      if (readOnly.has(channelId)) spokeSaw.set(channelId, new Set(ids));
    }
  }

  /** The ids of the pulled channels (PulledChannel records) the bot cannot write in. */
  function readOnlyIdsOf(pulled: ReadonlyArray<PulledChannel>): Set<string> {
    return new Set(pulled.filter((entry) => entry.readOnly === true).map((entry) => entry.channelId));
  }

  /**
   * The ring of calls (`state.json` `elsewherePings`, read by every later
   * pull) after a turn that reached a decision -- it chose silence, or it
   * spoke for real (a dry run that spoke reached nobody and stamps nothing):
   * every call of the ring among the lines it showed of a channel the bot
   * cannot write in (buildRequest's `pulledKept`) is stamped answered when
   * what reached the chat answered it (`answered`, from act), else skipped --
   * it was in view, so no later pull presents it as waiting for an answer
   * (src/behavior/elsewhere.ts#stampPings: an answer wins over a skip, a stamp
   * never moves). A pulled channel the bot can write in is left alone (a call
   * there is answered there), and so is `exceptId`: a routed turn's own call,
   * which its caller (src/behavior/pipeline.js) stamps by the turn's outcome.
   * Nothing changes while paused (the owner may be editing data/). Each call
   * whose state changed logs `elsewhere: marked`; the state is marked dirty
   * once.
   */
  function stampShownCalls({
    shown,
    pulled,
    answered,
    exceptId,
  }: {
    shown: Shown;
    pulled: ReadonlyArray<PulledChannel>;
    answered: Set<string>;
    exceptId: string | null;
  }): void {
    const readOnly = readOnlyIdsOf(pulled);
    const stamps = shown
      .filter(({ channelId }) => readOnly.has(channelId))
      .flatMap(({ ids }) =>
        ids
          .filter((id) => id !== exceptId)
          .map((id) => ({ messageId: id, status: answered.has(id) ? 'answered' : 'skipped' }))
      );
    const data = store.state.data;
    if (stamps.length === 0 || data.paused || !Array.isArray(data.elsewherePings)) return;
    const { ring, marked } = stampPings(data.elsewherePings, stamps, clock());
    if (marked.length === 0) return;
    data.elsewherePings = ring;
    store.state.markDirty();
    for (const { messageId, channelId, status } of marked)
      log.info('elsewhere: marked', { source: channelId, message: messageId, status });
  }

  return { pullChannels, captionAll, withSeenBefore, markPulledSeen, noteSpokeSaw, stampShownCalls };
}
