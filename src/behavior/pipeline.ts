// The message pipeline: turns the `message.received` event of a platform's
// new message (src/protocol/, built by the interface's adapter)
// into one of a handful of outcomes (ignore, observe into memory, or run a turn) without ever throwing into the
// interface. A direct message goes through the private-chat gate instead
// (dm.enabled, src/behavior/private.ts). A turn someone asked
// for that a rail refused gets one plain limit notice (src/behavior/limits.ts);
// a direct call while paused gets the pause notice the same way.
// A call in a channel the persona can read but not write in is answered in
// another chat once that channel settles.
// Owner commands are a separate pipeline entirely (the interface's command handler,
// driven by a command, not a message). It reads the events an interface delivers
// and nothing else: what it needs to know about a chat (its permissions, its newest
// messages, a message by id, a member) it asks the interface through the core's `reads`
// (src/interface/reads.ts), and a chat is the info the interface gave of it.
// Each topic is a module of src/pipeline/, built here once over a typed context; this file wires them.

import { createAddressClassifier } from '../pipeline/address-classifier.ts';
import { createAnswer } from '../pipeline/answer.ts';
import { createCallOutcome } from '../pipeline/call-outcome.ts';
import { createClassifierRequest } from '../pipeline/classifier-request.ts';
import { createChats } from '../pipeline/chats.ts';
import { createDrain } from '../pipeline/drain.ts';
import { createEdits } from '../pipeline/edits.ts';
import { createAddressAttention } from '../pipeline/address-attention.ts';
import { createFollowUp } from '../pipeline/follow-up.ts';
import { createFollowing } from '../pipeline/following.ts';
import { createHandleMessage } from '../pipeline/handle-message.ts';
import { createMediaPrefill } from '../pipeline/media-prefill.ts';
import { createMerge } from '../pipeline/merge.ts';
import { createObserve } from '../pipeline/observe.ts';
import type { OwnerPerson } from '../pipeline/observe.ts';
import { createPauseNotice } from '../pipeline/pause-notice.ts';
import { createPendingQueue, turnBlocked as isTurnBlocked } from '../pipeline/pending-queue.ts';
import { createPrivateGate } from '../pipeline/private-gate.ts';
import type { Untyped } from '../tools/types.ts';
import type { Adapter } from '../protocol/adapter.ts';
import type { MessageReadOptions, PendingQueue, PipelineLlm, PipelineMissed } from '../pipeline/types.ts';
import type { MessageReceived } from '../protocol/events.ts';
import type { createTurnRunner } from './turn.ts';
import type { createStore } from '../memory/store.ts';
import type { Reads } from '../interface/reads.ts';
import type { createMemoryUpdater } from '../memory/update.ts';
import type { createTagHistory } from './mention.ts';

type MediaPrefillDeps = Parameters<typeof createMediaPrefill>[0];
type HandledEvent = Parameters<ReturnType<typeof createHandleMessage>['onMessage']>[0];
type PrivateGateDeps = Parameters<typeof createPrivateGate>[0];
type EditsDeps = Parameters<typeof createEdits>[0];

/** What the handler answers: the message function, with the methods the core and the turn runner call on it. */
export type MessageHandler = ((event: MessageReceived, options?: MessageReadOptions) => Promise<void>) & {
  drainPending: () => unknown;
  catchUp: ReturnType<typeof createHandleMessage>['catchUpMessage'];
  onPrivate: (event: MessageReceived) => Untyped;
  onMessageUpdate: ReturnType<typeof createEdits>['onMessageUpdate'];
  onMessageDelete: ReturnType<typeof createEdits>['onMessageDelete'];
  clearPending: () => void;
  pendingCount: () => number;
};

/**
 * @param deps.reads  The core's reads of the interface
 *   (src/interface/reads.ts): the chat a message is in, its newest messages, a message by id,
 *   a member, and the listing of the root the route of a call reads.
 * @param [deps.selfId]  The persona's id on the interface (`hello`).
 * @param [deps.llm]  From createLlm() (src/llm/openrouter.js), used for the address classifier: every line of a group
 *   place that carries a flag, and an unflagged one within attention, is checked here before ever running a turn.
 *   Absent -- a test with no classifier -- a flagged line opens and an unflagged one is a `no`.
 * @param [deps.getSelfName]  The persona's display name in a place
 *   (src/core.ts). Default: `bot`.
 * @param [deps.describer]  From createDescriber() (src/memory/describe.js), optional: when
 *   absent, no description request is ever made from this pipeline. When present, every observed human
 *   message's first pictures (src/pipeline/media-prefill.ts) are handed to it fire-and-forget -- errors
 *   swallowed -- so the cache is already warm by the time a turn wants a caption for one of them. Only the
 *   address classifier awaits a message's own prefill, then read captions from the cache alone
 *   (`describer.cachedDescriptions` / `cachedVideos`), never a new request. The message's first videos are
 *   handed to `describer.describeVideos` the same way.
 * @param [deps.lookup]  From createLookup() (src/web/lookup.js), optional: the message's first readable
 *   link (MAX_WARM_LINKS_PER_MESSAGE) is handed to `lookup.readLinks` the same way. Absent -> no
 *   link is ever read from this pipeline.
 * @param [deps.sleep]  Used only for the "human switch pause"
 *   before answering a deferred pending ping -- see src/pipeline/drain.ts.
 *   The settle waits of calls from channels the persona cannot write in (src/pipeline/settle.ts), and the
 *   deadline of a line's observation (src/pipeline/observe.ts).
 *   Default: setTimeout / clearTimeout, each timer unref'd.
 *   From src/behavior/activity.ts#createActivity, shared with the turn runner: every message of
 *   anyone but the persona in a served channel or a private chat is noted (no contents), so a
 *   turn answering a person can wait until they stop writing (pace.settleMs). Absent: nothing noted.
 * @param [deps.record]  From src/memory/record.js#createRecord,
 *   optional: with features.record exactly true (read at each event), a deleted message of the
 *   served place writes a `deleted` line (onMessageDelete) and an edited one a `seen` line with
 *   the next revision (src/pipeline/edits.ts). Absent: nothing is recorded here.
 * @param [deps.memoryDb]  From
 *   src/memory/db/service.js#createMemoryDb, optional: every message memory observes and every edit
 *   the record writes is sent to the memory database as an observation
 *   (src/memory/db/observe-event.js#observationOf), through its writer; never a message's failure (a
 *   refusal is logged with its code at debug). The observation is the line's record: it names the
 *   line's record (`{ placeId }`) and the handler awaits its commit, at most
 *   `memoryDb.observeTimeoutMs` (5000), before it goes on (a failed write waits in the service's queue
 *   for the next tick); an edit's record line then takes the revision the database counted. Absent:
 *   nothing is sent.
 * @param [deps.missed]  From
 *   src/behavior/missed.ts#createMissed, optional: a failed address classifier
 *   (`gate-failed`, or `gate-failopen` when it let the line through anyway) and a deferred
 *   follow-up replaced by a newer one (`replaced-deferred`, both ids) are noted as facts, and
 *   every message of a served channel as activity there. Absent: nothing is noted.
 * @param [deps.port]  The adapter the limit and pause notices go out through.
 *   Takes the `message.received` event of a new message (the interface builds it, the door validates it): the
 *   pipeline reads the line, the mention and the reply from the event, and asks the interface for the
 *   chat's permissions and history when it needs them. Also carries a
 *   `.drainPending()` method: called once a turn finishes anywhere (src/index.ts wires it to
 *   src/behavior/turn.ts's `setOnIdle`, in the same `finally` that frees the channel) to answer
 *   the oldest non-expired pending direct ping, one at a time, after a human switch pause. And a `.clearPending()`
 *   method that drops every queued ping and settle wait unanswered. And `.onPrivate(event)`, the private-chat path
 *   a direct chat the pause held is replayed through (src/behavior/core-pause.ts). And a `.stop()`
 *   method (shutdown, src/index.ts) that clears every settle wait, so none starts a turn while the
 *   client goes down. And an `.onMessageUpdate(event)` method (src/index.ts wires it to
 *   `messageUpdate` through an edit event) that records an edit and counts an embed the platform attached
 *   after the message arrived (src/pipeline/edits.ts). And an
 *   `.onMessageDelete(event)` method (src/index.ts wires it to `messageDelete` through a
 *   deletion event) that writes a `deleted` line to the record. And a `.catchUp(event, { trigger })`
 *   method (src/behavior/catch-up.ts, at start) for a message posted while the bot was offline:
 *   see src/pipeline/handle-message.ts#catchUpMessage.
 */
export function createMessageHandler({
  hot,
  store,
  reads,
  selfId: selfIdOf = () => '',
  turns: turnRunner,
  memory,
  gifKeeper = null,
  tagHistory,
  isServedRoot,
  rootsOf,
  getSelfName = () => 'bot',
  describer,
  llm,
  lookup,
  rng = Math.random,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timers = { set: setTimeout, clear: clearTimeout },
  activity = null,
  record = null,
  missed = null,
  memoryDb = null,
  stemmer = null,
  selfNames = null,
  ownerPerson = null,
  port,
}: {
  // The live config and prompts. A test hands in a stand-in whose config holds only what it reads, so the modules
  // below each check their own part of it.
  hot: { config: Untyped; prompts?: Untyped };
  store: ReturnType<typeof createStore>;
  reads: Reads;
  selfId?: () => string;
  turns: ReturnType<typeof createTurnRunner>;
  memory: ReturnType<typeof createMemoryUpdater>;
  gifKeeper?: EditsDeps['gifKeeper'];
  tagHistory: ReturnType<typeof createTagHistory>;
  llm?: PipelineLlm;
  /** A root some connected interface serves. */
  isServedRoot: (placeId: string | null | undefined) => boolean;
  /** Every root the interface `name` serves. */
  rootsOf?: (name: string) => ReadonlyArray<string>;
  getSelfName?: (placeId: string) => string;
  describer?: Untyped;
  lookup?: Untyped;
  rng?: () => number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timers?: { set: (fn: () => void, ms: number) => Untyped; clear: (timer: Untyped) => void };
  activity?: { note: (placeId: string, authorId: string, at: number) => void } | null;
  record?: { append: (...args: Array<Untyped>) => Untyped } | null;
  memoryDb?: Parameters<typeof createObserve>[0]['memoryDb'];
  /** The owner's person for the lines of his command line (src/pipeline/observe.ts#OwnerPerson). */
  ownerPerson?: OwnerPerson | null;
  missed?: (PipelineMissed & { setPrivateRecovery?: (recovery: object) => void }) | null;
  /** The memory's learned stemmer for the alias gate, read at each line; null or absent leaves whole-word matching. */
  stemmer?: (() => { stem: (word: string) => string } | null) | null;
  /** Her aliases, the names the owner gave her own person record (`person:self`); absent: none. */
  selfNames?: (() => ReadonlyArray<string>) | null;
  port: Adapter;
}): MessageHandler {
  const turns = turnRunner;
  const { refOf, currentOf, turnPlaceOf, infoNow, resolveReference } = createChats({
    reads,
    memoryDb,
  });
  const { observeLine, deleteLine } = createObserve({ hot, memoryDb, selfIdOf, timers, ownerPerson });
  const turnBlocked = () => isTurnBlocked(turns);
  const { warmMediaCache, cachedFollowUpMedia } = createMediaPrefill({
    hot,
    // The core's describer and lookup, which that module types by the calls it makes.
    describer: describer as MediaPrefillDeps['describer'],
    lookup: lookup as MediaPrefillDeps['lookup'],
    now,
  });

  // Attention loads its saved times back here, before anything else is built.
  const { noteAttention, followUpMuted, addressGate, followUpStale } = createAddressAttention({
    hot,
    store,
    now,
    stemmer: () => stemmer?.() ?? null,
    selfNames: () => selfNames?.() ?? [],
  });
  const { buildClassifierRequest } = createClassifierRequest({
    reads,
    store,
    refOf,
    cachedFollowUpMedia,
    selfNames: () => selfNames?.() ?? [],
  });
  const { announceRefusal, afterCallTurn, heldCallState } = createCallOutcome({
    hot,
    reads,
    refOf,
    port,
  });

  // The pending queue's list, shared by the queue, the merge and the drain. The drain is built last (it needs the
  // private gate), so the merge and the follow-up path reach it through `drain`.
  const pending: PendingQueue = { list: [] };
  let drain: ReturnType<typeof createDrain> | null = null;
  // The drain is built below, before any call reaches this.
  const drainPending = () => (drain as ReturnType<typeof createDrain>).drainPending();
  const { queuedCount, itemText, queuedFor, noteUnanswered, logPending, deferFollowUp, enqueuePending, requeueBusy } =
    createPendingQueue({ hot, now, turns, missed, pending, followUpMuted });
  const { holdCall } = createMerge({
    hot,
    llm,
    store,
    now,
    turns,
    getSelfName,
    pending,
    itemText,
    enqueuePending,
    turnBlocked,
    drainPending,
  });
  const { decideAndLog, answerCall } = createAnswer({
    store,
    now,
    turns,
    tagHistory,
    selfIdOf,
    getSelfName,
    refOf,
    holdCall,
    queuedFor,
    afterCallTurn,
  });

  // The address classifier and the door's two paths through it.
  const { classifyAddress } = createAddressClassifier({
    hot,
    llm,
    now,
    getSelfName,
    missed,
    buildClassifierRequest,
  });
  const { maybeFollowUp, answerFlagged } = createFollowUp({
    hot,
    turns,
    addressGate,
    followUpMuted,
    currentOf,
    refOf,
    classifyAddress,
    turnBlocked,
    deferFollowUp,
    decideAndLog,
    answerCall,
    drainPending,
    announceRefusal,
  });

  // The private chat (src/pipeline/private-gate.ts): its gate, its drop and its count, and a direct message's path.
  // Each stage declares `memory.observe` for the lines it hands over; the updater types it as the protocol message
  // (src/memory/update.ts#NormalizedMessage), which is what those lines are.
  const { afterPrivateTurn, checkPrivateGate, dropPrivate, onPrivateMessage } = createPrivateGate({
    ...(rootsOf === undefined ? {} : { rootsOf }),
    hot,
    store,
    reads,
    now,
    selfIdOf,
    activity,
    turns,
    memory: memory as unknown as Parameters<typeof createPrivateGate>[0]['memory'],
    missed,
    refOf,
    infoNow,
    observeLine,
    turnBlocked,
    // The private gate names the line it hands on `PrivateLine`, a part of the `Line` these functions take.
    holdCall: holdCall as PrivateGateDeps['holdCall'],
    queuedFor: queuedFor as PrivateGateDeps['queuedFor'],
    announceRefusal: announceRefusal as PrivateGateDeps['announceRefusal'],
  });

  drain = createDrain({
    hot,
    store,
    now,
    rng,
    sleep,
    turns,
    pending,
    logPending,
    noteUnanswered,
    queuedCount,
    queuedFor,
    requeueBusy,
    currentOf,
    refOf,
    heldCallState,
    afterCallTurn,
    checkPrivateGate,
    dropPrivate,
    afterPrivateTurn,
    followUpStale,
    decideAndLog,
  });

  const { maybePauseNotice } = createPauseNotice({
    isServedRoot,
    hot,
    now,
    port,
    selfIdOf,
    checkPrivateGate,
    infoNow,
    refOf,
    resolveReference,
  });
  const { noteFollowingLine } = createFollowing({ store, turns, memoryDb, now });

  // One new message (src/pipeline/handle-message.ts).
  const { onMessage, catchUpMessage } = createHandleMessage({
    isServedRoot,
    hot,
    store,
    turns,
    memory: memory as unknown as Parameters<typeof createHandleMessage>[0]['memory'],
    activity,
    missed,
    selfIdOf,
    observeLine,
    maybePauseNotice,
    onPrivateMessage,
    resolveReference,
    turnPlaceOf,
    warmMediaCache,
    noteAttention,
    noteFollowingLine,
    maybeFollowUp,
    answerFlagged,
  });

  // An edit and a deletion of a message (src/pipeline/edits.ts).
  const { onMessageUpdate, onMessageDelete } = createEdits({
    isServedRoot,
    hot,
    // The edit handlers declare `recordGifs` with an `opts` of `unknown`; the store takes its own options object.
    store: store as EditsDeps['store'],
    reads,
    selfIdOf,
    record,
    now,
    warmMediaCache,
    gifKeeper,
    observeLine,
    deleteLine,
  });

  // The door and the tests hand in the protocol's `MessageReceived`, whose message may be the partial one of an edit or
  // a deletion; the handler routes those itself (src/pipeline/handle-message.ts).
  return Object.assign(onMessage as (event: MessageReceived, options?: MessageReadOptions) => Promise<void>, {
    drainPending: drain.drainPending,
    catchUp: catchUpMessage,
    onPrivate: (event: MessageReceived) => onPrivateMessage(event as HandledEvent, hot.config),
    onMessageUpdate,
    onMessageDelete,
    // Every pending direct ping dropped unanswered.
    clearPending: () => {
      pending.list = [];
    },
    // How many direct pings wait for the attention (src/behavior/inner.ts lets people go first).
    pendingCount: () => pending.list.length,
  });
}
