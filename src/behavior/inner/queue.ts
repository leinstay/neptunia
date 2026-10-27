// The wake queue and its store: the state of one guild's inner life in `data/guilds/<id>/inner.json` (read on first
// use, set aside when it cannot be read, pruned and written whole after every change), the door's handler of
// `inner.wake`, the wakes an intention gives and how queued wakes coalesce into one turn. The other modules of
// src/behavior/inner/ read and change the state only through these functions, over the `life` context that
// src/behavior/inner.ts builds.

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../../memory/index.js';
import { DAY_MS } from '../../time.js';
import { listOf, objOf } from '../../tools/types.ts';
import { storedWakes } from '../wake.ts';
import { addFactTo } from './facts.ts';
import { INNER_DEFAULTS, WAKE_KINDS, innerOn, innerSettings } from './settings.ts';

/** The path of the guild's state file. */
export const fileOf = (life, guildId) => path.join(life.dataDir, 'guilds', String(guildId), 'inner.json');
/** The persona's timezone (`bot.timezone`, read now). */
export const timezoneOf = (life) => life.hot.config?.bot?.timezone ?? 'UTC';

/** The outcomes of a wake that never ran a turn for it: each is a `wakeDropped` fact at the moment it happens. */
const DROP_OUTCOMES = new Set(['stopped', 'overflow', 'stale', 'superseded', 'error', 'provider', 'no-channel']);

/** The state file's schema version. */
const VERSION = 1;
/** How long a turn or a spend is kept in the state (the longest window is a day). */
const KEEP_MS = 2 * DAY_MS;
/**
 * How long a handled wake id is kept: longer than an intention lives
 * (`intentions.expiresDays`), so a due item she left alone never wakes her a second time.
 */
const CHAIN_KEEP_MS = 30 * DAY_MS;
/** The inner turn ids kept, so an errand one of them handed off counts its cost when it ends. */
const TURN_IDS_MAX = 100;

/** A fresh state. */
export function emptyState() {
  return {
    v: VERSION,
    stopped: false,
    stoppedAt: null,
    stoppedBy: null,
    queue: [],
    handled: {},
    review: null,
    heartbeat: null,
    turns: [],
    spend: [],
    turnIds: [],
    facts: [],
    inflight: null,
  };
}

/** The in-flight mark of a turn read from disk (`state.inflight`), or null when it is not whole. */
function inflightOf(raw) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    typeof raw.turnId !== 'string' ||
    !raw.turnId ||
    !Number.isFinite(raw.startedAt)
  )
    return null;
  const wakeIds = listOf(raw.wakeIds).filter((id) => typeof id === 'string');
  if (wakeIds.length === 0) return null;
  return {
    turnId: raw.turnId,
    wakeIds,
    kind: typeof raw.kind === 'string' ? raw.kind : '',
    startedAt: raw.startedAt,
    channelId: raw.channelId == null ? null : String(raw.channelId),
    privateChat: raw.privateChat === true,
    privateUserId: raw.privateUserId == null ? null : String(raw.privateUserId),
  };
}

/** A state read from disk made whole (a missing part empty). */
export function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    stopped: raw.stopped === true,
    stoppedAt: Number.isFinite(raw.stoppedAt) ? raw.stoppedAt : null,
    stoppedBy: typeof raw.stoppedBy === 'string' ? raw.stoppedBy : null,
    queue: storedWakes(raw.queue, WAKE_KINDS),
    handled: objOf(raw.handled),
    review: raw.review && typeof raw.review.day === 'string' ? raw.review : null,
    heartbeat:
      raw.heartbeat &&
      typeof raw.heartbeat === 'object' &&
      (Number.isFinite(raw.heartbeat.nextAt) || Number.isFinite(raw.heartbeat.lastAt))
        ? {
            nextAt: Number.isFinite(raw.heartbeat.nextAt) ? raw.heartbeat.nextAt : null,
            lastAt: Number.isFinite(raw.heartbeat.lastAt) ? raw.heartbeat.lastAt : null,
          }
        : null,
    turns: listOf(raw.turns).filter((turn) => Number.isFinite(turn?.at)),
    spend: listOf(raw.spend).filter((item) => Number.isFinite(item?.at) && Number.isFinite(item?.usd)),
    turnIds: listOf(raw.turnIds).filter((id) => typeof id === 'string'),
    facts: listOf(raw.facts).filter((fact) => fact && typeof fact.id === 'string' && typeof fact.kind === 'string'),
    inflight: inflightOf(raw.inflight),
  };
}

/**
 * `state` without what is older than its windows (handled ids, turns, spend).
 */
export function pruneState(state, now, { factsKeepMs = INNER_DEFAULTS.factsKeepDays * DAY_MS } = {}) {
  const since = now - KEEP_MS;
  const handled = Object.fromEntries(
    Object.entries(state.handled).filter(([, entry]) => Number.isFinite(entry?.at) && entry.at >= now - CHAIN_KEEP_MS)
  );
  return {
    ...state,
    handled,
    turns: state.turns.filter((turn) => turn.at >= since),
    spend: state.spend.filter((item) => item.at >= since),
    turnIds: state.turnIds.slice(-TURN_IDS_MAX),
    // A fact is dropped a day after it was told, or when it has waited the whole keep time.
    facts: listOf(state.facts).filter((fact) => (fact.told ? fact.told >= now - DAY_MS : fact.at >= now - factsKeepMs)),
  };
}

/** Where an intention lands: its destination, else the conversation it came from; and whether that is a private chat. */
function targetOf(intention) {
  const privateChat = intention?.provenance?.scope === 'dm';
  const channelId = privateChat
    ? (intention.provenance?.channelId ?? null)
    : (intention?.destination ?? intention?.provenance?.channelId ?? null);
  return { channelId: channelId ? String(channelId) : null, privateChat };
}

/**
 * The wake of one entry of src/intentions/model.ts#dueList (`{ intention, reason, at }`): an `errand_deadline` for a
 * wait past its deadline (its id names the errand), else an `intention_due` (its id names the due time), so the same
 * due item is always the same wake and a new due time is a new one. Its chain is the intention's `chainId`, else the
 * intention -- or, for a recurring intention (`every`), this occurrence of it: each occurrence is its own chain.
 */
export function wakeOfDue({ intention, reason, at }) {
  const deadline = reason === 'wait-deadline';
  const kind = deadline ? 'errand_deadline' : 'intention_due';
  const errandId = deadline ? (intention.awaitingErrandId ?? intention.lastErrandId ?? null) : null;
  const { channelId, privateChat } = targetOf(intention);
  return {
    id: deadline
      ? `inner.wake:errand_deadline:${intention.id}:${errandId}`
      : `inner.wake:intention_due:${intention.id}:${at}`,
    kind,
    reason: deadline ? 'wait-deadline' : 'due',
    intentionIds: [intention.id],
    chainId: intention.chainId
      ? `chain:${intention.chainId}`
      : intention.every && !deadline
        ? `intention:${intention.id}:${at}`
        : `intention:${intention.id}`,
    dueAt: at,
    channelId,
    privateChat,
    ...(errandId ? { errandId: String(errandId) } : {}),
  };
}

/**
 * The `errand_deadline` wakes of intentions a reconciliation already moved back to `pending`
 * with the note `wait-deadline` (at start, before the scheduler's first tick): the same id as the
 * wake the wait itself would have given, so the two never wake her twice.
 */
export function deadlineWakes(records) {
  return listOf(records)
    .filter((record) => record?.status === 'pending' && record.note === 'wait-deadline' && record.lastErrandId)
    .map((record) =>
      wakeOfDue({
        intention: { ...record, awaitingErrandId: record.lastErrandId },
        reason: 'wait-deadline',
        at: record.updatedAt ?? record.createdAt ?? 0,
      })
    );
}

/** The wakes that belong to no place: the day's review and the heartbeat (their turn runs in a channel she was lately active in, posts name their channel). */
export const channelless = (wake) => wake?.kind === 'review' || wake?.kind === 'heartbeat';

/**
 * The wakes of `queue` that run together, the earliest due first: the first wake that is not a
 * review is the anchor; every wake of the same conversation (and the same private-or-server kind)
 * joins it, and the day's review joins any server anchor. With only reviews queued, they go alone.
 * A retried wake (`retry`) joins only the wakes of its own failed group. A wake `isHeld` says is held (its own chain
 * is over its cap) is left out of every group, so it never joins one and never makes a review or a feedback wake wait.
 * A feedback wake is never coalesced with another kind: the feedback wakes of one conversation run together, first.
 * @param {object[]} queue
 * @returns {object[]}
 */
export function coalesceGroup(queue, isHeld = () => false) {
  const sorted = listOf(queue)
    .filter((wake) => !isHeld(wake))
    .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
  if (sorted.length === 0) return [];
  const feedback = sorted.filter((wake) => wake.kind === 'feedback');
  if (feedback.length > 0) {
    const first = feedback[0];
    return feedback.filter(
      (wake) =>
        wake.channelId === first.channelId &&
        Boolean(wake.privateChat) === Boolean(first.privateChat) &&
        retryKey(wake) === retryKey(first)
    );
  }
  // The heartbeat is never coalesced and never waits behind another wake (a running turn holds the whole drain, so it comes at the next tick): it goes alone, after the feedback wakes.
  const beat = sorted.find((wake) => wake.kind === 'heartbeat');
  if (beat) return [beat];
  const anchor = sorted.find((wake) => wake.kind !== 'review') ?? null;
  // A retried wake runs only with the wakes of its own failed group (the same attempt and first failure); a fresh one never joins them.
  const key = retryKey(anchor ?? sorted[0]);
  const same = sorted.filter((wake) => retryKey(wake) === key);
  if (!anchor) return same;
  return same.filter((wake) =>
    wake.kind === 'review'
      ? !anchor.privateChat
      : wake.channelId === anchor.channelId && Boolean(wake.privateChat) === Boolean(anchor.privateChat)
  );
}

/** What tells retried wakes of one failed group from fresh ones: '' for a fresh wake. */
const retryKey = (wake) => (wake?.retry ? `${wake.retry}:${wake.firstFailedAt ?? ''}` : '');

export function stateOf(life, guildId) {
  const { states } = life;
  const key = String(guildId);
  if (!states.has(key)) {
    let raw = null;
    let lost = null;
    try {
      raw = JSON.parse(fs.readFileSync(fileOf(life, key), 'utf8'));
    } catch (err) {
      if (err?.code !== 'ENOENT') lost = err?.code ?? 'parse';
    }
    const state = normalizeState(raw);
    states.set(key, state);
    if (lost !== null) loseState(life, key, state, lost);
  }
  return states.get(key);
}

/**
 * The state file could not be read: it is moved aside (`inner.json.bad-<ts>`, never overwritten),
 * the loss is logged and journalled, and a `stateLost` fact tells her at her next turn that she
 * started empty. Never a silent empty start. Never throws.
 */
export function loseState(life, key, state, code) {
  const { now, log } = life;
  const at = now();
  const backup = `${fileOf(life, key)}.bad-${at}`;
  let kept = true;
  try {
    fs.renameSync(fileOf(life, key), backup);
  } catch (err) {
    kept = false;
    log.warn('inner: unreadable state could not be moved aside', { guildId: key, code: err?.code ?? null });
  }
  log.warn('inner: state unreadable, starting empty', { guildId: key, code, kept });
  note(life, key, { event: 'stateLost', code, kept });
  addFact(life, state, { at, kind: 'stateLost', code, channelId: null, privateChat: false });
  // Written only when the old file is safe aside; if it could not be moved it stays where it is.
  if (!kept) return;
  try {
    writeJsonAtomic(fileOf(life, key), state);
  } catch (err) {
    log.warn('inner: state write failed', { guildId: key, code: err?.code ?? null });
  }
}

export function save(life, guildId) {
  const { hot, now, log } = life;
  const key = String(guildId);
  // Pruned in place: whoever holds the state object keeps seeing the one that is written.
  const next = Object.assign(
    stateOf(life, key),
    pruneState(stateOf(life, key), now(), { factsKeepMs: innerSettings(hot.config).factsKeepDays * DAY_MS })
  );
  try {
    writeJsonAtomic(fileOf(life, key), next);
  } catch (err) {
    log.warn('inner: state write failed', { guildId: key, code: err?.code ?? null });
  }
  return next;
}

/**
 * One write of the turn's wake run through the memory database's writer (`memoryDb.wakeRuns` exactly true, read
 * now; src/memory/db/wakes.js), in order with the others; a failure is logged with a code. Never throws.
 */
export function wakeWrite(life, update) {
  const { hot, memoryDb, log } = life;
  if (hot.config?.memoryDb?.wakeRuns !== true || typeof memoryDb?.recordWake !== 'function') return;
  Promise.resolve()
    .then(() => memoryDb.recordWake(update))
    .catch((err) => log.warn('inner: wake run not recorded', { op: update?.op ?? null, code: err?.code ?? null }));
}

/** One `inner` journal record (features.journal exactly true, read now); never throws. */
export function note(life, guildId, fields) {
  const { hot, journal, log } = life;
  if (hot.config?.features?.journal !== true || typeof journal?.inner !== 'function') return;
  Promise.resolve()
    .then(() => journal.inner(guildId, fields))
    .catch((err) => log.warn('inner: journal failed', { code: err?.code ?? null }));
}

export function paused(life) {
  const { store } = life;
  try {
    return store?.state?.data?.paused === true;
  } catch {
    return false;
  }
}

/** `fact` kept in `state.facts` (not told yet); the fact's `channelId` and `privateChat` say where it may be shown. */
export function addFact(life, state, fact) {
  const { now } = life;
  const at = Number.isFinite(fact.at) ? fact.at : now();
  return addFactTo(state, { ...fact, at }, `f${at.toString(36)}-${++life.factSeq}`);
}

/** The purpose of intention `id` in the guild's store ('' when unknown). Never throws. */
export function purposeOf(life, guildId, id) {
  const { intentions } = life;
  try {
    const purpose = guildId && id ? intentions?.store?.(guildId)?.get?.(id)?.purpose : null;
    return typeof purpose === 'string' ? purpose : '';
  } catch {
    return '';
  }
}

/** The fact about `wake` (`wakeDropped` or `wakeHeld`) with its `code`, where it belongs and what `extra` adds. */
export function wakeFact(life, guildId, wake, kind, code, extra = {}) {
  const intentionId = listOf(wake.intentionIds).map(String)[0] ?? null;
  return {
    kind,
    wakeId: wake.id,
    wake: wake.kind,
    code,
    intentionId,
    purpose: intentionId ? purposeOf(life, guildId, intentionId) : '',
    ...extra,
    channelId: wake.channelId ?? null,
    privateChat: wake.privateChat === true,
  };
}

/**
 * `wakes` marked handled with `outcome` and taken off the queue; every recurring intention they
 * name advances to its next occurrence (the service's `advance`: `recurred` for one in `named`,
 * the ids her turn's calls named, else `missed`). A one-off, a waiting one and an occurrence she
 * already closed or moved are left as they are by the service. An outcome other than a run turn
 * (DROP_OUTCOMES) is a `wakeDropped` fact at once; `why` (a string, or a function of the wake) is its sub-code.
 */
export function markHandled(life, state, wakes, outcome, at, { guildId = null, named = null, why = null } = {}) {
  const { intentions } = life;
  for (const wake of wakes) {
    state.handled[wake.id] = { at, outcome, ...(wake.kind === 'attend' ? { place: wake.channelId ?? null } : {}) };
    if (DROP_OUTCOMES.has(outcome)) {
      const reason = typeof why === 'function' ? why(wake) : why;
      addFact(life, state, {
        at,
        ...wakeFact(
          life,
          guildId,
          wake,
          'wakeDropped',
          outcome,
          typeof reason === 'string' && reason ? { why: reason } : {}
        ),
      });
    }
  }
  const ids = new Set(wakes.map((wake) => wake.id));
  state.queue = state.queue.filter((wake) => !ids.has(wake.id));
  if (!guildId || typeof intentions?.advance !== 'function') return;
  const touched = named instanceof Set ? named : new Set(Array.isArray(named) ? named.map(String) : []);
  for (const id of new Set(wakes.flatMap((wake) => (Array.isArray(wake.intentionIds) ? wake.intentionIds : [])))) {
    const result = intentions.advance(guildId, id, { named: touched.has(String(id)) });
    if (result?.changed)
      note(life, guildId, {
        event: 'recurred',
        intentionId: String(id),
        code: result.intention?.history?.at?.(-1)?.code ?? null,
        dueAt: result.intention?.dueAt ?? null,
        outcome,
      });
  }
}

/**
 * The door's handler of `inner.wake`: the wake queued (persisted), unless it was handled
 * already, is queued, the inner life is stopped, or the queue is full (`overflow`, journalled
 * and handled so it is never dropped unseen). Answers what happened.
 */
export function onWake(life, event) {
  const { hot, getGuildId, now, log } = life;
  const guildId = event?.communityId ?? getGuildId();
  const wake = event?.wake;
  if (!guildId || !wake || !WAKE_KINDS.includes(wake.kind)) return { status: 'invalid' };
  const state = stateOf(life, guildId);
  const id = String(event.id ?? wake.id);
  if (state.stopped) return { status: 'stopped' };
  if (state.handled[id] || state.queue.some((queued) => queued.id === id)) return { status: 'duplicate' };
  const at = now();
  const queued = { ...wake, id, queuedAt: at };
  if (state.queue.length >= innerSettings(hot.config).queueMax) {
    markHandled(life, state, [queued], 'overflow', at, { guildId });
    save(life, guildId);
    log.warn('inner: queue overflow', { guildId, id, kind: wake.kind, queued: state.queue.length });
    note(life, guildId, { event: 'overflow', wake: wakeFields(queued), queued: state.queue.length });
    return { status: 'overflow' };
  }
  state.queue.push(queued);
  save(life, guildId);
  log.info('inner: wake', { guildId, id, kind: wake.kind, dueAt: wake.dueAt ?? null });
  note(life, guildId, { event: 'wake', wake: wakeFields(queued), channelId: wake.privateChat ? null : wake.channelId });
  return { status: 'queued' };
}

/** What the journal keeps of a wake: ids, codes and times. */
export function wakeFields(wake) {
  return {
    id: wake.id,
    kind: wake.kind,
    reason: wake.reason,
    dueAt: wake.dueAt ?? null,
    intentionIds: wake.intentionIds ?? [],
    chainId: wake.chainId ?? null,
    ...(wake.retry
      ? { retry: wake.retry, firstFailedAt: wake.firstFailedAt ?? null, notBefore: wake.notBefore ?? null }
      : {}),
    ...(wake.errandId ? { errandId: wake.errandId } : {}),
    ...(wake.attend ? { place: wake.attend.place, lines: wake.attend.lines, people: wake.attend.people.length } : {}),
    ...(wake.kind === 'feedback' ? { turnId: wake.turnId ?? null, facts: listOf(wake.facts) } : {}),
  };
}

export async function enqueue(life, guildId, wake) {
  const { submit, now } = life;
  const event = { kind: 'inner.wake', at: now(), id: wake.id, communityId: String(guildId), wake };
  if (typeof submit === 'function') return submit(event);
  return { status: 'ok', result: onWake(life, event) };
}

/** Whether her actions may leave an inner turn now: the switch on, not stopped, not paused. */
export function mayAct(life, guildId) {
  const { hot } = life;
  return innerOn(hot.config) && !stateOf(life, guildId).stopped && !paused(life);
}
