// The first step of a turn's request: the settings read for the attempt, the bar and its cancellation point, the typing
// indicator while it prepares, the community's listing, the history with its reply parents, the memory prefetch and a
// diary post's plan. The request phase (src/turn/phases/request.ts) runs it first; the later steps read what it made.

import { forcedPictureRefusal } from '../../../behavior/diary-turn.ts';
import { refreshEmojiIfOn } from '../../../behavior/emoji-index.ts';
import { takeSnapshot } from '../../../behavior/snapshot.ts';
import type { Snapshot } from '../../../behavior/snapshot.ts';
import { createDeadline } from '../../../behavior/turn-parts.ts';
import type { Deadline } from '../../../behavior/turn-parts.ts';
import type { MemberInfo } from '../../../protocol/adapter.ts';
import { transportOf } from '../../../tools/tool-calls.ts';
import { replyOptionsOf } from '../../calls.ts';
import type { Diary } from '../../diary.ts';
import type { Draft } from '../../draft.ts';
import { withReplyParents } from '../../history.ts';
import type { Inputs } from '../../inputs.ts';
import type { Lookup } from '../../lookup.ts';
import { coreToolsOn, paceSettings } from '../../settings.ts';
import type { PaceSettings } from '../../settings.ts';
import { TOO_SLOW } from '../../timers.ts';
import { askedFor, unhurried } from '../../triggers.ts';
import type { BeforeBar, Ended, HistoryLine, PhaseConfig, PhaseContext, PhaseParams, TurnTrigger } from '../context.ts';
import type { Opened } from '../preflight.ts';

/** The cancellation point at `bar`: the work, or TOO_SLOW thrown once the bar is reached (none without a bar). */
export function beforeBarOf(bar: Deadline): BeforeBar {
  return (promise) =>
    bar.leftMs() === null
      ? promise
      : Promise.race([
          promise,
          bar.reached.then(() => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- TOO_SLOW is the turn's own signal, caught by its end
            throw TOO_SLOW;
          }),
        ]);
}

/** The skills line of the search classifier or the planner, once one answered (skills discovery). */
export type SkillsAnswer = { value: Parameters<Inputs['discoverSkills']>[0]['answer'] | null };

/** What the setup made: the attempt's settings, its bar, the history and the work started beside it. */
export type Setup = {
  ended: null;
  config: PhaseConfig;
  features: Record<string, unknown>;
  transport: 'native' | 'text';
  memoryOn: boolean;
  selfId: string;
  selfName: string;
  now: number;
  startedAt: number;
  pace: PaceSettings;
  waitsForAll: boolean;
  bar: Deadline;
  barAbort: AbortController;
  beforeBar: BeforeBar;
  replyOptions: () => ReturnType<typeof replyOptionsOf>;
  asked: boolean;
  answersTask: boolean;
  coreTools: boolean;
  skillsAnswer: SkillsAnswer;
  snapshot: Snapshot | null;
  rawHistory: Array<HistoryLine>;
  historyMs: number;
  partner: MemberInfo | null;
  likeServer: boolean;
  servedGuild: { id: string } | null;
  servedSnapshot: Snapshot | null;
  candidate: TurnTrigger | null;
  prefetching: ReturnType<Lookup['startPrefetch']>;
  diaryPending: Promise<{ value: Awaited<ReturnType<Diary['prepareDiary']>> } | { error: unknown }> | null;
};

// health: allow complexity until 2027-04-01 -- moved from runTurnAttempt in src/behavior/turn.js in stage 5c, a pure split
export async function setupRequest(
  ctx: PhaseContext,
  params: PhaseParams,
  draft: Draft,
  opened: Opened
): Promise<Ended | Setup> {
  const {
    hot,
    store,
    clock,
    schedule,
    emoji,
    ifaceReads,
    selfIdOf,
    getSelfName,
    diaryPictureGate,
    typingWhilePreparing,
    privatePartner,
    readHistory,
    linkTriggers,
    linkCalls,
    startPrefetch,
    prepareDiary,
  } = ctx;
  const { mode, trigger = null, triggerKind = null, part = null, reuseHistory = null } = params;
  const diaryParams = params.diary ?? null;
  const { channel, guildId, isPrivate, prepStep, life } = opened;
  const config = hot.config;
  const features = config.features ?? {};
  // How her tools travel this turn (tools.transport, read once): native tool calls, or text blocks.
  const transport = transportOf(config);
  draft.transport = transport;
  const memoryOn = features.memory !== false;
  const selfId = selfIdOf();
  const selfName = getSelfName(guildId);
  const now = life.turnStartedAt;
  const startedAt = now;
  // A forced diary picture kind (/nep diary post <kind>) the post may not carry is refused before any request.
  const kind = mode === 'diary' ? diaryParams?.kind : null;
  const pictureRefusal = forcedPictureRefusal({ config, kind, gate: () => diaryPictureGate(config, channel, now) });
  if (pictureRefusal) return { ended: pictureRefusal };
  // The turn's pace: an unhurried turn (spontaneous or overheard, pace.unpromptedWaits on) has no bar or deadline.
  const pace = paceSettings(config);
  const waitsForAll = unhurried(triggerKind, pace);
  // The bar (pace.dropAfterMs, from the turn's start): the answer must be in hand by then, or the turn is dropped
  // unposted. At the bar every wait below gives up (beforeBar throws TOO_SLOW), the typing stops and the reply request
  // is aborted.
  const bar = createDeadline({ clock, startedAt, schedule, limitMs: waitsForAll ? null : pace.dropAfterMs });
  life.bar = bar;
  const barAbort = new AbortController();
  void bar.reached.then(() => {
    life.stopTyping();
    barAbort.abort();
  });
  const beforeBar = beforeBarOf(bar);
  const replyOptions = () => replyOptionsOf(hot.config, { draft, bar, barAbort });
  // Someone asked for this turn (askedFor): not a spontaneous or an overheard one.
  const asked = askedFor(trigger, triggerKind);
  // A turn a returned errand opened answers with its result: the engine's own search
  // (the classifier, the planner's lookup block) is not run on the original request, so no
  // <lookup> block stands beside the result. Her own recall call still runs.
  const answersTask = triggerKind === 'errand';
  // features.coreTools (read now): she calls her own tools in the turn, so no search classifier
  // (nor the planner's lookup or skills block) runs before her reply.
  const coreTools = coreToolsOn(config);
  // Skills discovery: the `skills:` line of the search classifier or the planner (parseSkillsLines).
  const skillsAnswer: SkillsAnswer = { value: null };
  // A direct call sees the persona typing while the turn prepares.
  life.stopTyping = typingWhilePreparing(channel, triggerKind, config);

  // A private chat's partner as a guild member (features.privateLikeServer), fetched beside
  // the history; null on a server turn, with the switch off or when the fetch fails.
  const partnerPending = isPrivate
    ? privatePartner({ guildId, userId: trigger?.authorId ?? channel.partnerId ?? null, config })
    : Promise.resolve(null);
  // The groups the requester holds in the community, read once: the rights of her calls are checked against them.
  const requesterPending =
    !isPrivate && trigger?.authorId
      ? ifaceReads.memberInfo({ communityId: guildId, memberId: String(trigger.authorId) })
      : Promise.resolve(null);
  // The community's listing, once for the attempt (neighbours, pulls, routing, places, audience rails); a private
  // chat is listed for its partner's sake.
  const partnerHint = isPrivate ? (trigger?.authorId ?? channel.partnerId ?? null) : null;
  const snapshotPending = takeSnapshot(ifaceReads, guildId, partnerHint ? [String(partnerHint)] : []);
  const emojiPending = refreshEmojiIfOn(emoji, config);
  const historyStartedAt = clock();
  const snapshot = await beforeBar(snapshotPending);
  draft.snapshot = snapshot;
  // The first part of a split message reuses the history its message's turn fetched.
  // Part of the history: the messages replies of the window answer from outside it
  // (context.fetchReplyParents), prepended as its oldest lines (withReplyParents). The
  // persona's own lines carry the message that started their turn (linkTriggers) and the
  // skill calls she made (linkCalls), so the request and every analyzer transcript built from
  // this history name them.
  const rawHistory = linkCalls(
    linkTriggers(
      reuseHistory ??
        (await beforeBar(
          readHistory(channel, config, { inner: Boolean(draft.inner), draft, guildId }).then((lines) =>
            withReplyParents(ifaceReads, channel, lines, { trigger, config })
          )
        ))
    ),
    { channel, snapshot, guildId }
    // The marks keep every line as it was, with the message's own fields.
  ) as Array<HistoryLine>;
  const historyMs = clock() - historyStartedAt;
  const partner = await beforeBar(partnerPending);
  await beforeBar(emojiPending);
  draft.requesterGroups = (await beforeBar(requesterPending))?.member?.groupIds ?? [];
  // A private chat on its partner's behalf: pulls and the server search from the served community (none otherwise).
  const likeServer = isPrivate && partner !== null;
  const servedGuild = isPrivate && !likeServer ? null : { id: guildId };
  const servedSnapshot = servedGuild ? snapshot : null;
  // What the analyzer requests judge: the trigger, or on a part of a split message the trigger with
  // that part's text (same id, author and time).
  const candidate = part && trigger ? { ...trigger, content: part.parts[part.index - 1] ?? trigger.content } : trigger;
  // The automatic memory prefetch (features.coreTools with features.memoryPrefetch): started now,
  // alongside the preparation, bounded by its own deadline (startPrefetch).
  const prefetching = startPrefetch({
    config,
    channel,
    snapshot: servedSnapshot,
    guildId,
    guild: servedGuild,
    partner: isPrivate ? partner : null,
    trigger,
    candidate,
    triggerKind,
    mode,
    history: rawHistory,
    selfId,
    selfName,
    nameOf: memoryOn ? (id) => store.getUser(guildId, id)?.names?.[0] ?? null : null,
    journalStep: prepStep,
    wake: draft.inner?.wake ?? null,
  });
  // A diary post plans itself first (prepareDiary), alongside the preparation below; settled
  // into a value or an error so a refusal waits for its turn to be thrown.
  const diaryPending =
    mode === 'diary'
      ? prepareDiary({
          config,
          guildId,
          channel,
          selfName,
          history: rawHistory,
          now,
          params: diaryParams,
          memoryOn,
          draft,
        }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error })
        )
      : null;
  return {
    ended: null,
    config,
    features,
    transport,
    memoryOn,
    selfId,
    selfName,
    now,
    startedAt,
    pace,
    waitsForAll,
    bar,
    barAbort,
    beforeBar,
    replyOptions,
    asked,
    answersTask,
    coreTools,
    skillsAnswer,
    snapshot,
    rawHistory,
    historyMs,
    partner,
    likeServer,
    servedGuild,
    servedSnapshot,
    candidate,
    prefetching,
    diaryPending,
  };
}
