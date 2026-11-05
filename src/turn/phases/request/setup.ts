// The first step of a turn's request: the settings read for the attempt, the bar and its cancellation point, the typing
// indicator while it prepares, the community's listing, the history with its reply parents, the memory prefetch and a
// diary post's plan. The request phase (src/turn/phases/request.ts) runs it first; the later steps read what it made.

import { accountOf } from '../../../memory/addresses.ts';
import { isCliOwner } from '../../../behavior/core-pause.ts';
import { forcedPictureRefusal } from '../../../behavior/diary-turn.ts';
import { refreshEmojiIfOn } from '../../../behavior/emoji-index.ts';
import { PERSONA_ID } from '../../../memory/db/storage-keys.ts';
import { takeSnapshotOf } from '../../../behavior/snapshot.ts';
import type { Snapshot } from '../../../behavior/snapshot.ts';
import { createDeadline } from '../../../behavior/turn-parts.ts';
import type { Deadline } from '../../../behavior/turn-parts.ts';
import type { Context } from '../../../memory/db/scope.ts';
import type { MemberInfo } from '../../../protocol/adapter.ts';
import { ownerNativesOf } from '../../../tools/impl/grants.ts';
import { transportOf } from '../../../tools/tool-calls.ts';
import { replyOptionsOf } from '../../calls.ts';
import type { Diary } from '../../diary.ts';
import type { Draft } from '../../draft.ts';
import { withReplyParents } from '../../history.ts';
import type { Lookup } from '../../lookup.ts';
import { paceSettings } from '../../settings.ts';
import type { PaceSettings } from '../../settings.ts';
import { TOO_SLOW, TURN_CANCELLED } from '../../timers.ts';
import { askedFor, unhurried } from '../../triggers.ts';
import type { BeforeBar, Ended, HistoryLine, PhaseConfig, PhaseContext, PhaseParams, TurnTrigger } from '../context.ts';
import type { Opened } from '../preflight.ts';

/**
 * The cancellation point at `bar`: the work, or TOO_SLOW thrown once the bar is reached (none without a bar). A turn the owner
 * can cancel also gives `cancel`, whose abort throws TURN_CANCELLED at the same points.
 */
export function beforeBarOf(bar: Deadline, cancel: AbortSignal | null = null): BeforeBar {
  const cancelled =
    cancel === null
      ? null
      : new Promise<never>((_resolve, reject) => {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- TURN_CANCELLED is the turn's own signal, caught by its end
          if (cancel.aborted) reject(TURN_CANCELLED);
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the same signal
          else cancel.addEventListener('abort', () => reject(TURN_CANCELLED), { once: true });
        });
  // A wait may end before the cancel comes, and then nothing else reads this rejection.
  cancelled?.catch(() => {});
  const beforeCancel = <TValue>(promise: Promise<TValue>): Promise<TValue> =>
    cancelled === null ? promise : Promise.race([promise, cancelled]);
  return (promise) =>
    bar.leftMs() === null
      ? beforeCancel(promise)
      : beforeCancel(
          Promise.race([
            promise,
            bar.reached.then(() => {
              // eslint-disable-next-line @typescript-eslint/only-throw-error -- TOO_SLOW is the turn's own signal, caught by its end
              throw TOO_SLOW;
            }),
          ])
        );
}

/** What the setup made: the attempt's settings, its bar, the history and the work started beside it. */
export type Setup = {
  ended: null;
  config: PhaseConfig;
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
  /** The owner's cancel of this turn (src/turn/control.ts), null for a turn nobody can cancel. */
  cancel: AbortSignal | null;
  beforeBar: BeforeBar;
  replyOptions: () => ReturnType<typeof replyOptionsOf>;
  asked: boolean;
  answersTask: boolean;
  snapshot: Snapshot | null;
  rawHistory: Array<HistoryLine>;
  historyMs: number;
  partner: MemberInfo | null;
  likeServer: boolean;
  servedPlace: { id: string } | null;
  servedSnapshot: Snapshot | null;
  candidate: TurnTrigger | null;
  prefetching: ReturnType<Lookup['startPrefetch']>;
  diaryPending: Promise<{ value: Awaited<ReturnType<Diary['prepareDiary']>> } | { error: unknown }> | null;
};

// health: allow complexity until 2027-04-01 -- moved from runTurnAttempt in src/behavior/turn.ts in stage 5c, a pure split
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
    privatePartner,
    readHistory,
    linkTriggers,
    linkCalls,
    startPrefetch,
    turnContextOf,
    prepareDiary,
    cancelOf,
  } = ctx;
  const { mode, trigger = null, triggerKind = null, part = null, reuseHistory = null } = params;
  const diaryParams = params.diary ?? null;
  const { channel, placeId, reading, libraryPlace, isPrivate, prepStep, life } = opened;
  const config = hot.config;
  // How her tools travel this turn (tools.transport, read once): native tool calls, or text blocks.
  const transport = transportOf(config);
  draft.transport = transport;
  const memoryOn = true;
  const selfId = selfIdOf();
  const selfName = getSelfName(placeId);
  const now = life.turnStartedAt;
  const startedAt = now;
  // A forced diary picture kind (/nep diary post <kind>) the post may not carry is refused before any request.
  const kind = mode === 'diary' ? diaryParams?.kind : null;
  const pictureRefusal = forcedPictureRefusal({ config, kind, gate: () => diaryPictureGate(config, channel, now) });
  if (pictureRefusal) return { ended: pictureRefusal };
  // The turn's pace: an unhurried turn (unprompted or overheard) has no bar or deadline.
  const pace = paceSettings(config);
  const waitsForAll = unhurried(triggerKind);
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
  const cancel = cancelOf(trigger?.id ?? null);
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- TURN_CANCELLED is the turn's own signal, caught by its end
  if (cancel?.aborted === true) throw TURN_CANCELLED;
  cancel?.addEventListener(
    'abort',
    () => {
      life.stopTyping();
      barAbort.abort();
    },
    { once: true }
  );
  const beforeBar = beforeBarOf(bar, cancel);
  const replyOptions = () => ({
    ...replyOptionsOf(hot.config, { draft, bar, barAbort }),
    // A turn without a bar has no signal of its own, and a cancel still has to reach its request.
    ...(cancel === null ? {} : { signal: barAbort.signal }),
  });
  // Someone asked for this turn (askedFor): not a spontaneous or an overheard one.
  const asked = askedFor(trigger, triggerKind);
  // A turn a returned errand opened answers with its result: the engine's own search
  // (the classifier) is not run on the original request, so no
  // <lookup> block stands beside the result. Her own recall call still runs.
  const answersTask = triggerKind === 'errand';
  // She calls her own tools in the turn, so no search classifier runs before her reply.

  // A private chat's partner as a place member (private.likeServer), fetched beside
  // the history; null on a server turn, with the switch off or when the fetch fails.
  const partnerPending = isPrivate
    ? privatePartner({
        iface: channel.iface,
        placeId: libraryPlace,
        accountId: trigger?.authorId ?? channel.partnerId ?? null,
        config,
      })
    : Promise.resolve(null);
  // The groups the requester holds in the community, read once: the rights of her calls are checked against them.
  const requesterPending =
    !isPrivate && trigger?.authorId
      ? ifaceReads.memberInfo({ placeId, accountId: String(trigger.authorId) })
      : Promise.resolve(null);
  // The community's listing, once for the attempt (neighbours, pulls, routing, places, audience rails); a private
  // chat is listed for its partner's sake.
  const partnerId = isPrivate ? (trigger?.authorId ?? channel.partnerId ?? null) : null;
  // On the command line the owner is nobody the community knows: the account the community's owners list gives for
  // them is the reader whose view of its channels decides which of them a read may name.
  const cliOwner = isCliOwner(channel.iface, partnerId);
  const partnerHint = cliOwner ? (ownerNativesOf(config)[0] ?? null) : partnerId;
  const snapshotPending = takeSnapshotOf(
    ifaceReads,
    reading.length > 0 ? reading : [placeId],
    partnerHint ? [String(partnerHint)] : []
  );
  const emojiPending = refreshEmojiIfOn(emoji, isPrivate || placeId === PERSONA_ID ? null : placeId);
  const historyStartedAt = clock();
  const snapshot = await beforeBar(snapshotPending);
  draft.snapshot = snapshot;
  // Whom the places a read may name are judged by in a private chat: its partner when the server shows through (below),
  // the owner's account on the command line.
  draft.readerId = cliOwner && partnerHint ? String(partnerHint) : null;
  // The first part of a split message reuses the history its message's turn fetched.
  // Part of the history: the messages replies of the window answer from outside it,
  // prepended as its oldest lines (withReplyParents). The
  // persona's own lines carry the message that started their turn (linkTriggers) and the
  // skill calls she made (linkCalls), so the request and every analyzer transcript built from
  // this history name them.
  const rawHistory = linkCalls(
    linkTriggers(
      reuseHistory ??
        (await beforeBar(
          readHistory(channel, config, { inner: Boolean(draft.inner), draft, placeId }).then((lines) =>
            withReplyParents(ifaceReads, channel, lines, { trigger })
          )
        ))
    ),
    { channel, snapshot, placeId }
    // The marks keep every line as it was, with the message's own fields.
  ) as Array<HistoryLine>;
  const historyMs = clock() - historyStartedAt;
  const partner = await beforeBar(partnerPending);
  await beforeBar(emojiPending);
  draft.requesterGroups = (await beforeBar(requesterPending))?.member?.groupIds ?? [];
  // A private chat on its partner's behalf: pulls and the server search from the served community (none otherwise).
  const likeServer = isPrivate && partner !== null;
  if (likeServer && partnerId) draft.readerId = String(partnerId);
  const servedPlace = isPrivate && !likeServer ? null : { id: placeId };
  const servedSnapshot = servedPlace ? snapshot : null;
  // What the analyzer requests judge: the trigger, or on a part of a split message the trigger with
  // that part's text (same id, author and time).
  const candidate = part && trigger ? { ...trigger, content: part.parts[part.index - 1] ?? trigger.content } : trigger;
  // The automatic memory prefetch started now,
  // alongside the preparation, bounded by its own deadline (startPrefetch).
  // The inputs retain the context issued by the core or the per-turn issuer.
  const memoryContext = turnContextOf(draft, channel) as Context | null;
  const prefetching = startPrefetch({
    historyRef: ctx.conversationOf(channel),
    memoryContext,
    config,
    channel,
    snapshot: servedSnapshot,
    placeId,
    place: servedPlace,
    partner: isPrivate ? partner : null,
    trigger,
    candidate,
    triggerKind,
    mode,
    history: rawHistory,
    selfId,
    selfName,
    nameOf: memoryOn ? (id) => store.getUser(accountOf(store, id))?.names?.[0] ?? null : null,
    journalStep: prepStep,
    wake: draft.inner?.wake ?? null,
  });
  // A diary post plans itself first (prepareDiary), alongside the preparation below; settled
  // into a value or an error so a refusal waits for its turn to be thrown.
  const diaryPending =
    mode === 'diary'
      ? prepareDiary({
          config,
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
    cancel,
    beforeBar,
    replyOptions,
    asked,
    answersTask,
    snapshot,
    rawHistory,
    historyMs,
    partner,
    likeServer,
    servedPlace,
    servedSnapshot,
    candidate,
    prefetching,
    diaryPending,
  };
}
