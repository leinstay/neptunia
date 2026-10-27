// The persona's inner life, step 2 (docs/inner-life.md): a deterministic scheduler that lists
// what is due for her -- an intention whose time came, an errand she waits for that ran past its
// deadline, and one review a day at a random moment inside the hours she usually speaks in (drawn
// from her own `said` lines in the record, re-drawn every local day) -- and hands each as an
// `inner.wake` event through the core's event door (src/interface/door.js). Listing is not
// choosing: no model runs here, nothing ranks or invents a reason. A queued wake keeps its due
// time while people's turns hold the lease; compatible wakes (the same conversation, and
// the day's review with any server one) coalesce into one inner turn; a queue past
// `innerLife.queueMax` records the overflow. The inner turn itself is the turn runner's
// (src/behavior/turn.js, mode `inner`): no human message, a `<wake>` block, her tools.
//
// The heartbeat (docs/inner-life.md "The heartbeat"): a wake kind of its own on its own timer,
// `innerLife.heartbeat.everyMinutes` moved by a jitter either way, kept in the state
// (`heartbeat: { nextAt, lastAt }`, drawn again once its wake is handled). It has no place and its own chain
// (`heartbeat:<at>`), is never coalesced with another wake and goes before them in the queue; its `<wake>` facts
// are built by src/behavior/heartbeat-view.ts.
//
// Bounds are code, not prose (`innerLife.caps`, a ceiling the owner accepted): inner turns per
// local day and per rolling hour, per causal chain (an intention's `chainId`, else the intention
// itself; a review is its day's chain), public posts per local day. No bound is in dollars: what
// a turn and the errands it hands off cost is recorded (`state.spend`, the `errand-cost` journal
// event) and reported, never limited.
// Every drop and every hold of a wake is a fact at the moment it happens, and so is every call
// outcome that did not go well: facts are kept in the state (`state.facts`) until a model answer
// that carried them completed (`told`), and are shown by the first turn that can carry them -- an
// inner turn's `<wake>`, or an addressed turn (src/behavior/turn.js). A fact of a private chat is
// shown only in that chat; a fact of the server never in a private chat.
// A review's `<wake>` also tells her once which intentions of hers expired untouched since she was
// last told (`innerLife.review.expiredMax` newest, the rest counted; a candidate never): each is marked
// shown on its record once the review turn ran, so a held or erred review lists them again.
// Over a cap no turn runs and the refusal is journalled once per wake and held as a fact (with the
// local midnight it waits for). What is left and when it resets reach her as facts in `<wake>`,
// never as a rule.
//
// Feedback on her own turn (docs/inner-life.md "Feedback on her own turn"): when an inner turn
// ends, `feedbackFacts` lists from its result what did not go through -- output she wrote outside
// a call and lost, every call whose status was not `ok`, an intention she closed as done while no
// delivery call went through, and the loop cut with calls dropped; a failed turn is a fact too
// (`turnFailed`). A non-empty list is kept as facts and queues ONE `feedback` wake
// (`inner.wake:feedback:<turnId>`) in the turn's chain and conversation, due at the next tick,
// carrying them -- unless the turn's own wakes come back for a retry, which carries them. The
// feedback wake is never held by a cap, never coalesced with another wake and does not count
// against the chain; a feedback turn's own misses are facts but queue no second wake (no loops).
//
// A recurring intention (`every`, src/intentions/model.ts) is advanced to its next occurrence
// whenever a wake naming it is marked handled -- her turn ended (whatever its outcome), or the
// engine dropped the wake (`no-channel`, `overflow`, `stale`, the stop) --
// through the intention service's `advance`: `recurred` when a call of the turn named it (the
// turn result's `inner.intentIds`), `missed` otherwise. Without a chain of its own each occurrence
// is its own chain (`intention:<id>:<dueAt>`), so the per-chain cap bounds one occurrence. The
// last occurrence before its expiry carries the note `last-occurrence` on its `<wake>` line.
//
// Her attention (docs/inner-life.md "Her attention"): an open intention of kind `attend`
// (src/intentions/model.ts) names a place; the tick counts the place's lines in the record since
// her last look there -- her last own line in that place, or the last attend wake handled for
// that place, whichever is later, and never before the attention was set -- and, once the newest
// line is `settle` seconds old, lists one `attend` wake (`inner.wake:attend:<intentionId>:<newestLineId>`,
// each wake its own chain). One queued wake per attention: a newer burst replaces the queued wake's
// id and newest line, nothing observed lost (the turn's history is the place's lines). With
// `people` on the attention only their lines count and the wake names them. Past the attention's
// own `perDay` the wake waits in the queue (`capped: 'attend-per-day'`), as a chain past
// `innerLife.caps.perChain` waits (`capped: 'per-chain'`). The record is read incrementally (a per-guild place index over the last
// `innerLife.attention.lookbackHours`), the same store the review's hours come from; the same
// index feeds `places` (her `places.list` skill and the page in `<wake>`): per place the
// interface publishes (`places`, an injected directory of opaque addresses; nothing of the
// interface's own objects is read here), its lines and people since her last look there.
//
// `innerLife.mode`: `shadow` (the default) runs the turn with nothing leaving it -- her reads run,
// every other call is recorded as proposed -- and `live` lets her calls run through the gateway on
// her own grants. The kill switch (`/nep task inner action:stop`) is persisted with the state,
// drops the queue, and is asked again right before any external action of a running inner turn
// (`mayAct`). Off (`features.innerLife` not exactly true, read at every tick) nothing is listed and
// nothing is written. State per guild in `data/guilds/<id>/inner.json` (queue, handled ids, the
// day's review, the counters, the stop), written whole after every change, so a restart resumes;
// ticks missed while down coalesce into the first tick after it. Logs carry ids, codes and
// counts, never text.
//
// With `memoryDb.wakeRuns` exactly true (read at the turn) each inner turn is also a wake run in the memory database
// (src/memory/db/wakes.js, through the service's writer): started before the turn runs (its id the in-flight turn id,
// its inputs the ids and versions its view showed, the envelope's policy version), each action recorded once by its
// number, ended `succeeded` or `failed` with the outcome. The journal and the state file are unchanged by it.
//
// The parts live in src/behavior/inner/: the settings (settings.ts), the queue and its state file (queue.ts), her
// attention and the places view (places.ts), the day's review (review.ts), the heartbeat's schedule (heartbeat.ts),
// the drain and the turn it opens (drain.ts), the facts (facts.ts) and the owner's status and switch (status.ts).
// Each of them works over the `life` context createInnerLife builds; this module keeps the tick and the exports.

import { randomUUID } from 'node:crypto';
import { log as defaultLog } from '../log.js';
import { intentionsOn } from '../intentions/model.ts';
import { createCostMeter, drain, onTaskFinished } from './inner/drain.ts';
import { markFactsTold, pendingFactsOf } from './inner/facts.ts';
import { heartbeatDue } from './inner/heartbeat.ts';
import { attendWakes, places, refreshPlaces } from './inner/places.ts';
import {
  addFact,
  deadlineWakes,
  enqueue,
  mayAct,
  note,
  onWake,
  paused,
  save,
  stateOf,
  wakeFields,
  wakeOfDue,
} from './inner/queue.ts';
import { reviewDue } from './inner/review.ts';
import { innerOn, innerSettings } from './inner/settings.ts';
import { start, status, stop } from './inner/status.ts';

export {
  DELIVERY_SKILLS,
  FACTS_SHOWN_MAX,
  POSTING_SKILLS,
  WAKE_KINDS,
  innerOn,
  innerSettings,
} from './inner/settings.ts';
export { createLocalFacts, factPayload, feedbackFacts } from './inner/facts.ts';
export { coalesceGroup, deadlineWakes, emptyState, normalizeState, wakeOfDue } from './inner/queue.ts';
export { PLACE_SORTS, attendWake, placesPage } from './inner/places.ts';
export { drawHeartbeatAt, heartbeatWake } from './inner/heartbeat.ts';
export { drawReviewAt, hourWeights, reviewWake } from './inner/review.ts';
export { chainBudget, createCostMeter, currentChannelOf, turnsToday } from './inner/drain.ts';

/**
 * @param {object} options
 * @param {{ config: object }} options.hot
 * @param {string} options.dataDir
 * @param {{ runTurn: Function, isAnyBusy?: Function, isBusy?: Function }} options.turns
 * @param {object|null} [options.intentions]  src/intentions/service.ts
 * @param {{ iterate: Function }|null} [options.record]  The record: her own lines for the review's
 *   hours, every place's lines for her attention.
 * @param {((guildId: string) => { id: string, name?: string|null, writable?: boolean|null }[])|null} [options.places]
 *   The places the interface publishes for the guild (opaque addresses, names, whether she can
 *   write there), for `places`; without it the places are the ones the record shows.
 * @param {((guildId: string, memberId: string) => string|null)|null} [options.nameOf]  A member's
 *   name for the `<wake>` lines (null: the id is shown).
 * @param {{ inner?: Function }|null} [options.journal]
 * @param {import('../interface/reads.ts').Reads|null} [options.reads]  The core's reads of the interface: the conversation a turn runs in.
 * @param {() => string} [options.iface]  The interface the conversations belong to (from `hello`).
 * @param {(conversationId: string) => string|null} [options.conversationName]  The name an interface reported for a
 *   conversation (src/interface/directory.ts); null when it reported none, and the id is shown.
 * @param {(event: object) => Promise<object>} [options.submit]  The event door's submit (src/index.js).
 * @param {{ state: { data: object } }|null} [options.store]  The memory store (its pause).
 * @param {() => string|null} [options.getGuildId]
 * @param {() => boolean} [options.peopleWaiting]  Calls queued for the attention (people first).
 * @param {() => Promise<unknown>} [options.ready]  Resolves once the journal's start-up reconciliation is done (src/index.js);
 *   a turn that a restart cut off is resolved from the journal only after it.
 * @param {() => string} [options.uuid]  Ids for the turns this life starts (the in-flight mark names the turn before it runs).
 * @param {{ run: Function }} [options.meter]  createCostMeter's.
 * @param {{ tasks?: (guildId: string) => object[], skills?: () => string[], agents?: () => string[], selfId?: () => string|null, focusPeople?: (guildId: string) => object|null }} [options.heartbeat]
 *   The sources of the heartbeat's facts that are not the stores above (src/behavior/heartbeat-view.ts).
 * @param {{ recordWake?: (update: object) => Promise<unknown>|null }|null} [options.memoryDb]  The memory database
 *   (src/memory/db/service.js): with `memoryDb.wakeRuns` on, each inner turn is recorded as a wake run with its actions.
 * @param {() => number} [options.rng]
 * @param {() => number} [options.now]
 * @param {{ info: Function, warn: Function }} [options.log]
 */
export function createInnerLife({
  hot,
  dataDir,
  turns,
  intentions = null,
  record = null,
  places: placesOf = null,
  nameOf = null,
  journal = null,
  reads = null,
  iface = () => '',
  conversationName = () => null,
  submit = null,
  store = null,
  getGuildId = () => null,
  peopleWaiting = () => false,
  ready = () => Promise.resolve(),
  uuid = randomUUID,
  meter = null,
  heartbeat: heartbeatSources = {},
  memoryDb = null,
  rng = Math.random,
  now = Date.now,
  log = defaultLog,
}) {
  const life = {
    hot,
    dataDir,
    turns,
    intentions,
    record,
    placesOf,
    nameOf,
    journal,
    reads,
    iface,
    conversationName,
    submit,
    store,
    getGuildId,
    peopleWaiting,
    ready,
    uuid,
    costs: meter ?? createCostMeter(),
    heartbeatSources,
    memoryDb,
    rng,
    now,
    log,
    states: new Map(),
    // Per guild: the place index (the record's lines per place over the lookback window).
    placeIndexes: new Map(),
    // The ids of the wakes an inner turn is running for now (a stop leaves them to that turn).
    running: new Set(),
    ticking: false,
    factSeq: 0,
  };

  /**
   * One tick: with the switch on and nothing paused or stopped, what is due is listed and handed
   * to the door (intentions due, waits past their deadline, the day's review), the waits are
   * reconciled, then the queue is drained by one inner turn when the attention is free. Never
   * throws; answers what it did.
   */
  async function tick() {
    const config = hot.config;
    if (!innerOn(config)) return { ran: false, reason: 'off' };
    const guildId = getGuildId();
    if (!guildId) return { ran: false, reason: 'no-guild' };
    if (life.ticking) return { ran: false, reason: 'ticking' };
    if (paused(life)) return { ran: false, reason: 'paused' };
    if (stateOf(life, guildId).stopped) return { ran: false, reason: 'stopped' };
    life.ticking = true;
    try {
      const settings = innerSettings(config);
      const at = now();
      const listed = [];
      if (intentions && intentionsOn(config)) {
        let due = [];
        try {
          due = intentions.due(guildId) ?? [];
        } catch (err) {
          log.warn('inner: due list failed', { guildId, code: err?.code ?? null });
        }
        listed.push(...due.map(wakeOfDue));
        try {
          intentions.reconcile(guildId);
          listed.push(...deadlineWakes(intentions.list(guildId, { all: true })));
        } catch (err) {
          log.warn('inner: reconcile failed', { guildId, code: err?.code ?? null });
        }
      }
      const review = await reviewDue(life, guildId, settings, at);
      if (review) listed.push(review);
      const beat = heartbeatDue(life, guildId, settings, at);
      if (beat) listed.push(beat);
      if (intentions && intentionsOn(config)) {
        await refreshPlaces(life, guildId, at, settings);
        listed.push(...attendWakes(life, guildId, at));
      }
      const state = stateOf(life, guildId);
      let submitted = 0;
      for (const wake of listed) {
        if (state.handled[wake.id] || state.queue.some((queued) => queued.id === wake.id)) continue;
        // One queued wake per attention: a newer burst replaces the queued one (its history covers the gap).
        if (wake.kind === 'attend') {
          const older = state.queue.filter(
            (queued) =>
              queued.kind === 'attend' &&
              queued.intentionIds?.[0] === wake.intentionIds[0] &&
              !life.running.has(queued.id)
          );
          if (older.length > 0) {
            state.queue = state.queue.filter((queued) => !older.includes(queued));
            save(life, guildId);
            for (const previous of older)
              note(life, guildId, { event: 'replaced', wake: wakeFields(previous), by: wake.id });
          }
        }
        await enqueue(life, guildId, wake);
        submitted += 1;
      }
      const drained = await drain(life, guildId);
      return { ran: true, listed: listed.length, submitted, drained };
    } catch (err) {
      log.warn('inner: tick failed', { error: err });
      return { ran: false, reason: 'error' };
    } finally {
      life.ticking = false;
    }
  }

  /**
   * The facts for the turns that are not inner turns (src/behavior/turn.js's addressed turns): `add` a
   * fact (`kind`, `channelId`, `privateChat`, its payload), `pending` ones a conversation may be shown
   * (`scope`: `{ channelId, privateChat }`; a private chat's only in it), `markTold` the ones a completed
   * answer carried. `enabled` follows the switch; without it the turn runner keeps its own in process.
   */
  const factsApi = {
    enabled: () => innerOn(hot.config),
    add(guildId, fact) {
      const key = guildId ?? getGuildId();
      if (!key) return null;
      const stored = addFact(life, stateOf(life, key), fact);
      save(life, key);
      return stored;
    },
    pending(guildId, scope) {
      const key = guildId ?? getGuildId();
      return key ? pendingFactsOf(stateOf(life, key), scope) : [];
    },
    markTold(guildId, ids) {
      const key = guildId ?? getGuildId();
      if (!key) return;
      markFactsTold(stateOf(life, key), ids, now());
      save(life, key);
    },
  };

  return {
    tick,
    drain: (guildId) => drain(life, guildId),
    onWake: (event) => onWake(life, event),
    onTaskFinished: (task, guildId) => onTaskFinished(life, task, guildId),
    mayAct: (guildId) => mayAct(life, guildId),
    stop: (guildId, options) => stop(life, guildId, options),
    start: (guildId, options) => start(life, guildId, options),
    status: (guildId) => status(life, guildId),
    places: (guildId, options) => places(life, guildId, options),
    state: (guildId) => stateOf(life, guildId),
    facts: factsApi,
  };
}
