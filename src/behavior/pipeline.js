// The message pipeline: turns the `message.received` event of a platform's
// new message (src/protocol/, built by the interface's adapter)
// into one of a handful of outcomes (ignore, observe into memory, let the spontaneous
// scheduler eavesdrop, or run a turn) without ever throwing into the interface.
// A direct message goes through the private-chat gate instead
// (features.privateMessages, src/behavior/private.js). A turn someone asked
// for that a rail refused gets one plain limit notice (src/behavior/limits.js);
// a direct call while paused gets the pause notice the same way.
// A call in a channel the persona can read but not write in is answered in
// the main channel (features.elsewhere) once that channel settles; so is a
// remark the persona chose to make about it (a noticed comment). A line put
// to the whole room may get a higher chance of an unprompted answer
// (spontaneous.roomQuestionChance, the room classifier).
// Owner commands are a separate pipeline entirely (the interface's command handler,
// driven by a command, not a message). It reads the events an interface delivers
// and nothing else: what it needs to know about a conversation (its permissions, its newest
// messages, a message by id, a member) it asks the interface through the core's `reads`
// (src/interface/reads.ts), and a conversation is the info the interface gave of it.
// Each topic is a module of src/pipeline/, built here once over a typed context; this file wires them.

import { createAddressClassifier } from '../pipeline/address-classifier.ts';
import { createAnswer } from '../pipeline/answer.ts';
import { createCallOutcome } from '../pipeline/call-outcome.ts';
import { createClassifierRequest } from '../pipeline/classifier-request.ts';
import { createConversations } from '../pipeline/conversations.ts';
import { createDrain } from '../pipeline/drain.ts';
import { createEdits } from '../pipeline/edits.ts';
import { createFollowUpWindows } from '../pipeline/follow-up-window.ts';
import { createFollowUp } from '../pipeline/follow-up.ts';
import { createFollowing } from '../pipeline/following.ts';
import { createHandleMessage } from '../pipeline/handle-message.ts';
import { createMediaPrefill } from '../pipeline/media-prefill.ts';
import { createMerge } from '../pipeline/merge.ts';
import { createObserve } from '../pipeline/observe.ts';
import { createPauseNotice } from '../pipeline/pause-notice.ts';
import { createPendingQueue, turnBlocked as isTurnBlocked } from '../pipeline/pending-queue.ts';
import { createPrivateGate } from '../pipeline/private-gate.ts';
import { createRoom } from '../pipeline/room.ts';
import { createSettles } from '../pipeline/settle.ts';

/** @typedef {import('../protocol/events.js').Message} Msg */
/** @typedef {Omit<import('../protocol/events.js').MessageReceived, 'message'|'previous'> & { message: Msg, previous?: Msg|null }} Ev */

/**
 * @param {object} deps
 * @param {import('../hot.js').createHot extends (...args: any) => infer R ? R : never} deps.hot
 * @param {ReturnType<import('../memory/store.js').createStore>} deps.store
 * @param {import('../interface/reads.ts').Reads} deps.reads  The core's reads of the interface
 *   (src/interface/reads.ts): the conversation a message is in, its newest messages, a message by id,
 *   a member, and the listing of the community the route of a call reads.
 * @param {() => string} [deps.selfId]  The persona's id on the interface (`hello`).
 * @param {ReturnType<import('./turn.js').createTurnRunner>} deps.turns
 * @param {ReturnType<import('./spontaneous.js').createSpontaneous>} deps.spontaneous
 * @param {ReturnType<import('../memory/update.js').createMemoryUpdater>} deps.memory
 * @param {ReturnType<import('./mention.js').createTagHistory>} deps.tagHistory
 * @param {object} [deps.llm]  From createLlm() (src/llm/openrouter.js), used for the address
 *   classifier (`features.followUp`): a message with no trigger, arriving while a
 *   conversation window this instance opened by answering is still open, is checked here before
 *   ever running a turn. Absent -- an older/direct caller, or a test that never opens a window --
 *   simply means `features.followUp` cannot ever fire (nothing reaches this dependency otherwise).
 *   The room classifier (spontaneous.roomQuestionChance, src/pipeline/room.ts) uses it too; absent, no
 *   room call is made.
 * @param {() => string | null} deps.getGuildId  the single guild this instance serves, or null before it resolves
 * @param {(guildId: string) => string} [deps.getSelfName]  The persona's display name in a guild
 *   (src/core.js). Default: `bot`.
 * @param {object} [deps.describer]  From createDescriber() (src/memory/describe.js), optional: when
 *   absent, or features.mediaDescriptions is off, no description request is ever made from this
 *   pipeline. When present, every observed human message's pictures (up to
 *   media.prefillPerMessage) are handed to it fire-and-forget -- errors swallowed -- so the
 *   cache is already warm by the time a turn wants a caption for one of them. Only the
 *   address and room classifiers await a message's own prefill, then read captions from the cache alone
 *   (`describer.cachedDescriptions` / `cachedVideos`), never a new request. With
 *   features.mediaDescriptions, features.videoDescriptions (a missing key counts as on) and
 *   media.video.prefill all on, the message's first videos (up to
 *   media.video.prefillPerMessage) are handed to `describer.describeVideos` the same way.
 * @param {object} [deps.lookup]  From createLookup() (src/web/lookup.js), optional: with
 *   features.webLookup, web.links.enabled and web.links.prefill on, the message's first readable
 *   link (MAX_WARM_LINKS_PER_MESSAGE) is handed to `lookup.readLinks` the same way. Absent -> no
 *   link is ever read from this pipeline.
 * @param {() => number} [deps.rng]
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]  Used only for the "human switch pause"
 *   before answering a deferred pending ping (mention.switchDelayMs) -- see src/pipeline/drain.ts.
 * @param {{ set: (fn: () => void, ms: number) => any, clear: (timer: any) => void }} [deps.timers]
 *   The settle waits of calls from channels the persona cannot write in (src/pipeline/settle.ts), and the
 *   deadline of a line's observation (src/pipeline/observe.ts).
 *   Default: setTimeout / clearTimeout, each timer unref'd.
 * @param {{ note: (channelId: string, authorId: string, at: number) => void }} [deps.activity]
 *   From src/behavior/activity.js#createActivity, shared with the turn runner: every message of
 *   anyone but the persona in a served channel or a private chat is noted (no contents), so a
 *   turn answering a person can wait until they stop writing (pace.settleMs). Absent: nothing noted.
 * @param {{ append: Function }|null} [deps.record]  From src/memory/record.js#createRecord,
 *   optional: with features.record exactly true (read at each event), a deleted message of the
 *   served guild writes a `deleted` line (onMessageDelete) and an edited one a `seen` line with
 *   the next revision (src/pipeline/edits.ts). Absent: nothing is recorded here.
 * @param {{ observe: (envelope: object) => (Promise<object>|null) }|null} [deps.memoryDb]  From
 *   src/memory/db/service.js#createMemoryDb, optional: every message memory observes and every edit
 *   the record writes is sent to the memory database as an observation
 *   (src/memory/db/observe-event.js#observationOf), through its writer; never a message's failure (a
 *   refusal is logged with its code at debug). The observation is the line's record: it names the
 *   line's record (`{ guildId, privateUserId }`) and the handler awaits its commit, at most
 *   `memoryDb.observeTimeoutMs` (5000), before it goes on (a failed write waits in the service's queue
 *   for the next tick); an edit's record line then takes the revision the database counted. Absent:
 *   nothing is sent.
 * @param {{ noteFact: Function, noteActivity: Function }|null} [deps.missed]  From
 *   src/behavior/missed.js#createMissed, optional: a failed address classifier
 *   (`gate-failed`, or `gate-failopen` when it let the line through anyway) and a deferred
 *   follow-up replaced by a newer one (`replaced-deferred`, both ids) are noted as facts, and
 *   every message of a served channel as activity there. Absent: nothing is noted.
 * @param {{ iface: string, send: Function }} [deps.port]  The adapter the limit and pause notices go out through.
 * @returns {(event: import('../protocol/index.js').MessageReceived) => Promise<void>}
 *   Takes the `message.received` event of a new message (the interface builds it, the door validates it): the
 *   pipeline reads the line, the mention and the reply from the event, and asks the interface for the
 *   conversation's permissions and history when it needs them. Also carries a
 *   `.drainPending()` method: called once a turn finishes anywhere (src/index.js wires it to
 *   src/behavior/turn.js's `setOnIdle`, in the same `finally` that frees the channel) to answer
 *   the oldest non-expired pending direct ping, one at a time, after a human switch pause. And a `.clearPending()`
 *   method that drops every queued ping and settle wait unanswered. And `.onPrivate(event)`, the private-chat path
 *   a direct chat the pause held is replayed through (src/behavior/core-pause.ts). And a `.stop()`
 *   method (shutdown, src/index.js) that clears every settle wait, so none starts a turn while the
 *   client goes down. And an `.onMessageUpdate(event)` method (src/index.js wires it to
 *   `messageUpdate` through an edit event) that records an edit and counts an embed the platform attached
 *   after the message arrived (src/pipeline/edits.ts). And an
 *   `.onMessageDelete(event)` method (src/index.js wires it to `messageDelete` through a
 *   deletion event) that writes a `deleted` line to the record. And a `.catchUp(event, { trigger })`
 *   method (src/behavior/catch-up.js, at start) for a message posted while the bot was offline:
 *   see src/pipeline/handle-message.ts#catchUpMessage.
 */
export function createMessageHandler({
  hot,
  store,
  reads,
  selfId: selfIdOf = () => '',
  turns,
  spontaneous,
  memory,
  tagHistory,
  getGuildId,
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
  port,
}) {
  const { refOf, currentOf, turnPlaceOf, infoNow, routeOf, resolveReference } = createConversations({
    reads,
    memoryDb,
    getGuildId,
  });
  const { observeLine } = createObserve({ hot, memoryDb, selfIdOf, timers });
  const turnBlocked = (channelId, config) => isTurnBlocked(turns, channelId, config);
  const { warmMediaCache, cachedFollowUpMedia } = createMediaPrefill({ hot, describer, lookup, now });

  // The follow-up windows load their saved entries back here, before anything else is built.
  const { windowOf, noteFollowUpSend, bumpFollowUpNoStreak, followUpOff, followUpMuted, followUpGate, followUpStale } =
    createFollowUpWindows({ hot, store, now, turns, turnBlocked });
  const { buildClassifierRequest } = createClassifierRequest({ reads, store, refOf, cachedFollowUpMedia });
  const { notifyLimit, announceRefusal, afterCallTurn, passRoutedCall, skipSeenCalls, heldCallState } =
    createCallOutcome({ hot, store, now, turns, reads, refOf, port });

  // The pending queue's list, shared by the queue, the merge and the drain. The drain is built last (it needs the
  // private gate), so the merge and the follow-up path reach it through `drain`.
  const pending = { list: [] };
  let drain = null;
  const drainPending = () => drain.drainPending();
  const { queuedCount, itemText, queuedFor, noteUnanswered, logPending, deferFollowUp, enqueuePending, requeueBusy } =
    createPendingQueue({ hot, now, turns, missed, pending, followUpMuted, followUpOff });
  const { holdCall } = createMerge({
    hot,
    llm,
    store,
    now,
    turns,
    tagHistory,
    getGuildId,
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
    rng,
    turns,
    tagHistory,
    selfIdOf,
    getSelfName,
    refOf,
    holdCall,
    queuedFor,
    afterCallTurn,
    passRoutedCall,
  });

  // The address classifier, the follow-up path and the room classifier.
  const { classifyFollowUp } = createAddressClassifier({
    hot,
    llm,
    now,
    getSelfName,
    missed,
    buildClassifierRequest,
    bumpFollowUpNoStreak,
  });
  const { maybeFollowUp } = createFollowUp({
    hot,
    turns,
    followUpGate,
    followUpMuted,
    followUpOff,
    currentOf,
    refOf,
    classifyFollowUp,
    turnBlocked,
    deferFollowUp,
    decideAndLog,
    drainPending,
    announceRefusal,
  });
  const { maybeRoom } = createRoom({ hot, llm, now, rng, spontaneous, getSelfName, windowOf, buildClassifierRequest });

  // The private chat (src/pipeline/private-gate.ts): its gate, its drop and its count, and a direct message's path.
  const { afterPrivateTurn, checkPrivateGate, dropPrivate, onPrivateMessage } = createPrivateGate({
    hot,
    store,
    reads,
    now,
    getGuildId,
    selfIdOf,
    activity,
    turns,
    memory,
    missed,
    refOf,
    infoNow,
    observeLine,
    turnBlocked,
    holdCall,
    queuedFor,
    notifyLimit,
    announceRefusal,
  });

  drain = createDrain({
    hot,
    store,
    now,
    rng,
    sleep,
    turns,
    getGuildId,
    pending,
    logPending,
    noteUnanswered,
    queuedCount,
    queuedFor,
    requeueBusy,
    currentOf,
    refOf,
    routeOf,
    heldCallState,
    skipSeenCalls,
    afterCallTurn,
    passRoutedCall,
    checkPrivateGate,
    dropPrivate,
    afterPrivateTurn,
    followUpOff,
    followUpStale,
    decideAndLog,
  });

  const { clearSettles, rememberCall, armSettle, maybeNotice, touchSettle } = createSettles({
    hot,
    store,
    now,
    timers,
    turns,
    spontaneous,
    routeOf,
    followUpMuted,
    heldCallState,
    skipSeenCalls,
    answerCall,
  });
  const { maybePauseNotice } = createPauseNotice({
    hot,
    now,
    port,
    getGuildId,
    selfIdOf,
    checkPrivateGate,
    infoNow,
    refOf,
    resolveReference,
  });
  const { noteFollowingLine } = createFollowing({ store, turns, memoryDb, now });

  // One new message (src/pipeline/handle-message.ts).
  const { onMessage, catchUpMessage } = createHandleMessage({
    hot,
    store,
    turns,
    memory,
    spontaneous,
    activity,
    missed,
    getGuildId,
    selfIdOf,
    observeLine,
    maybePauseNotice,
    onPrivateMessage,
    resolveReference,
    turnPlaceOf,
    routeOf,
    warmMediaCache,
    noteFollowUpSend,
    noteFollowingLine,
    touchSettle,
    maybeFollowUp,
    maybeNotice,
    maybeRoom,
    rememberCall,
    armSettle,
    answerCall,
  });

  // An edit and a deletion of a message (src/pipeline/edits.ts).
  const { onMessageUpdate, onMessageDelete } = createEdits({
    hot,
    store,
    reads,
    getGuildId,
    selfIdOf,
    record,
    now,
    warmMediaCache,
    observeLine,
  });

  onMessage.drainPending = drain.drainPending;
  onMessage.catchUp = catchUpMessage;
  onMessage.onPrivate = (/** @type {Ev} */ event) => onPrivateMessage(event, hot.config);
  onMessage.onMessageUpdate = onMessageUpdate;
  onMessage.onMessageDelete = onMessageDelete;
  // Every pending direct ping and every settle wait dropped unanswered: no timer fires afterwards. Each wait is logged
  // as `elsewhere: dropped` (`paused`); its call stays unanswered in the ring.
  onMessage.clearPending = () => {
    pending.list = [];
    clearSettles('paused');
  };
  /** How many direct pings wait for the attention (src/behavior/inner.ts lets people go first). */
  onMessage.pendingCount = () => pending.list.length;
  /** Clear every settle wait without answering its call (shutdown): none starts a turn on a client going down. */
  onMessage.stop = () => {
    clearSettles(null);
  };
  return onMessage;
}
