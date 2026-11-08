// The persona's inner life state and the wakes it is given. One persona state holds the shared clocks and the scoped
// chat evidence; the wake queue (wake-queue.ts) keeps its view in it (`queue`, `handled`, `inflight`), read from the
// memory database's `wakes`. Persona state writes and wake transitions share the memory writer chain. Standalone
// file-backed fixtures keep the explicit legacy file adapter. Here too: the wakes an intention gives, how queued wakes
// coalesce, the facts and the journal notes of the inner life.

import fs from 'node:fs';
import path from 'node:path';
import { personaKey } from '../../memory/db/storage-keys.ts';

import { createReadSeam, unitValue } from '../../memory/db/readers/common.ts';
import { writeJsonAtomic } from '../../memory/index.ts';
import { DAY_MS } from '../../time.ts';
import { errorCode, isFiniteNumber, isObj, listOf, objOf } from '../../tools/types.ts';
import type { Obj } from '../../tools/types.ts';
import { storedWakes } from '../wake.ts';
import { addFactTo, asText, idOrNull } from './facts.ts';
import { INNER_DEFAULTS, WAKE_KINDS, innerSettings } from './settings.ts';
import { backendOf, loadQueue } from './wake-queue.ts';
import { ifaceOfChat } from '../../interface/cli-chat.ts';
import type {
  Fact,
  FactInput,
  Handled,
  Inflight,
  InnerContext,
  InnerState,
  TurnRecord,
  Wake,
  WakeUpdate,
} from './types.ts';

/** The path of the persona's state file. */
export const fileOf = (life: InnerContext): string => path.join(life.dataDir, 'persona', 'inner.json');
/** The persona's timezone (`bot.timezone`, read now), UTC when it is not set. */
export const timezoneOf = (life: InnerContext): string => {
  const zone = objOf(objOf(life.hot.config).bot).timezone;
  return typeof zone === 'string' ? zone : 'UTC';
};

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
export function emptyState(): InnerState {
  return {
    v: VERSION,
    stopped: false,
    stoppedAt: null,
    stoppedBy: null,
    queue: [],
    handled: {},
    heartbeat: null,
    selfimprovement: null,
    turns: [],
    spend: [],
    turnIds: [],
    facts: [],
    inflight: null,
  };
}

/** The in-flight mark of a turn read from disk (`state.inflight`), or null when it is not whole. */
function inflightOf(value: unknown): Inflight | null {
  const raw = objOf(value);
  if (!isObj(value) || typeof raw.turnId !== 'string' || !raw.turnId || !isFiniteNumber(raw.startedAt)) return null;
  const wakeIds = listOf(raw.wakeIds).filter((id): id is string => typeof id === 'string');
  if (wakeIds.length === 0) return null;
  return {
    turnId: raw.turnId,
    wakeIds,
    kind: typeof raw.kind === 'string' ? raw.kind : '',
    startedAt: raw.startedAt,
    placeId: idOrNull(raw.placeId),
    dmChat: raw.dmChat === true,
    privateAccountId: idOrNull(raw.privateAccountId),
    ...(typeof raw.iface === 'string' && raw.iface ? { iface: raw.iface } : {}),
  };
}

/** The heartbeat's timer read from disk, or null when it holds no moment. */
function heartbeatOf(value: unknown): InnerState['heartbeat'] {
  const raw = objOf(value);
  if (!value || typeof value !== 'object' || !(isFiniteNumber(raw.nextAt) || isFiniteNumber(raw.lastAt))) return null;
  return {
    nextAt: isFiniteNumber(raw.nextAt) ? raw.nextAt : null,
    lastAt: isFiniteNumber(raw.lastAt) ? raw.lastAt : null,
  };
}

/** The selfimprovement clock read from disk, or null when it holds neither moment. */
function selfimprovementOf(value: unknown): InnerState['selfimprovement'] {
  const raw = objOf(value);
  if (!value || typeof value !== 'object' || !(isFiniteNumber(raw.lastAt) || isFiniteNumber(raw.raisedAt))) return null;
  return {
    lastAt: isFiniteNumber(raw.lastAt) ? raw.lastAt : null,
    raisedAt: isFiniteNumber(raw.raisedAt) ? raw.raisedAt : null,
    ...(typeof raw.schedule === 'string' ? { schedule: raw.schedule } : {}),
  };
}

/** A state read from disk made whole (a missing part empty). */
export function normalizeState(value: unknown): InnerState {
  const base = emptyState();
  if (!value || typeof value !== 'object') return base;
  const raw = objOf(value);
  // inner.json is what save wrote: an entry that passes the check the reader makes has the rest of its shape.
  return {
    ...base,
    stopped: raw.stopped === true,
    stoppedAt: isFiniteNumber(raw.stoppedAt) ? raw.stoppedAt : null,
    stoppedBy: typeof raw.stoppedBy === 'string' ? raw.stoppedBy : null,
    queue: storedWakes(raw.queue, WAKE_KINDS) as Array<Wake>,
    handled: objOf(raw.handled) as Record<string, Handled>,
    heartbeat: heartbeatOf(raw.heartbeat),
    selfimprovement: selfimprovementOf(raw.selfimprovement),
    turns: listOf(raw.turns).filter((turn) => isFiniteNumber(objOf(turn).at)) as Array<TurnRecord>,
    spend: listOf(raw.spend)
      .map(objOf)
      .flatMap((item) =>
        isFiniteNumber(item.at) && isFiniteNumber(item.usd) ? [{ ...item, at: item.at, usd: item.usd }] : []
      ),
    turnIds: listOf(raw.turnIds).filter((id): id is string => typeof id === 'string'),
    facts: listOf(raw.facts).filter((fact) => {
      const { id, kind } = objOf(fact);
      return Boolean(fact) && typeof id === 'string' && typeof kind === 'string';
    }) as Array<Fact>,
    inflight: inflightOf(raw.inflight),
  };
}

/**
 * `state` without what is older than its windows (handled ids, turns, spend).
 */
export function pruneState(
  state: InnerState,
  now: number,
  { factsKeepMs = INNER_DEFAULTS.factsKeepDays * DAY_MS }: { factsKeepMs?: number } = {}
): InnerState {
  const since = now - KEEP_MS;
  const handled = Object.fromEntries(
    Object.entries(state.handled).filter(([, entry]) => isFiniteNumber(entry?.at) && entry.at >= now - CHAIN_KEEP_MS)
  );
  return {
    ...state,
    handled,
    turns: state.turns.filter((turn) => turn.at >= since),
    spend: state.spend.filter((item) => item.at >= since),
    turnIds: state.turnIds.slice(-TURN_IDS_MAX),
    // A fact is dropped a day after it was told, or when it has waited the whole keep time.
    facts: (Array.isArray(state.facts) ? state.facts : []).filter((fact) =>
      fact.told ? fact.told >= now - DAY_MS : fact.at >= now - factsKeepMs
    ),
  };
}

/** The part of an intention its wake reads: its id, the errand it waits for, where it lands and its chain. */
export type DueIntention = {
  id: string;
  awaitingErrandId?: string | null;
  lastErrandId?: string | null;
  provenance?: { scope?: unknown; placeId?: unknown } | null;
  destination?: string | null;
  chainId?: string | null;
  every?: unknown;
};

/** Where an intention lands: its destination, else the chat it came from; and whether that is a private chat. */
function targetOf(intention: DueIntention): { placeId: string | null; dmChat: boolean } {
  const provenance = objOf(intention.provenance);
  const dmChat = provenance.scope === 'dm';
  const placeId = dmChat ? (provenance.placeId ?? null) : (intention.destination ?? provenance.placeId ?? null);
  return { placeId: placeId ? asText(placeId) : null, dmChat };
}

/**
 * The wake of one entry of src/intentions/model.ts#dueList (`{ intention, reason, at }`): an `errand_deadline` for a
 * wait past its deadline (its id names the errand), else an `intention_due` (its id names the due time), so the same
 * due item is always the same wake and a new due time is a new one. Its chain is the intention's `chainId`, else the
 * intention -- or, for a recurring intention (`every`), this occurrence of it: each occurrence is its own chain.
 */
export function wakeOfDue({ intention, reason, at }: { intention: DueIntention; reason: string; at: number }): Wake {
  const deadline = reason === 'wait-deadline';
  const kind = deadline ? 'errand_deadline' : 'intention_due';
  const errandId = deadline ? (intention.awaitingErrandId ?? intention.lastErrandId ?? null) : null;
  const { placeId, dmChat } = targetOf(intention);
  return {
    id: deadline
      ? `inner.wake:errand_deadline:${intention.id}:${String(errandId)}`
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
    placeId,
    dmChat,
    ...(errandId ? { errandId: String(errandId) } : {}),
  };
}

/**
 * The `errand_deadline` wakes of intentions a reconciliation already moved back to `pending`
 * with the note `wait-deadline` (at start, before the scheduler's first tick): the same id as the
 * wake the wait itself would have given, so the two never wake her twice.
 */
export function deadlineWakes(records: unknown): Array<Wake> {
  return listOf(records)
    .map(objOf)
    .filter((record) => record.status === 'pending' && record.note === 'wait-deadline' && record.lastErrandId)
    .map((record) =>
      wakeOfDue({
        // A record of the intention store: its id and the errand it waited for are strings.
        intention: { ...record, id: String(record.id), awaitingErrandId: String(record.lastErrandId) },
        reason: 'wait-deadline',
        at: Number(record.updatedAt ?? record.createdAt ?? 0),
      })
    );
}

/** The wakes that belong to no place: the heartbeat and the selfimprovement wake, whose turns run nowhere. */
export const channelless = (wake: Wake | null | undefined): boolean =>
  wake?.kind === 'heartbeat' || wake?.kind === 'selfimprovement';

/**
 * The wakes of `queue` that run together, the earliest due first: the first wake is the anchor and every wake of the
 * same chat (and the same private-or-server kind) joins it.
 * A retried wake (`retry`) joins only the wakes of its own failed group. A wake `isHeld` says is held (its own chain
 * is over its cap) is left out of every group, so it never joins one and never makes a feedback wake wait.
 * A feedback wake is never coalesced with another kind: the feedback wakes of one chat run together, first.
 */
export function coalesceGroup(queue: ReadonlyArray<Wake>, isHeld: (wake: Wake) => boolean = () => false): Array<Wake> {
  const sorted = [...queue].filter((wake) => !isHeld(wake)).sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
  if (sorted.length === 0) return [];
  const feedback = sorted.filter((wake) => wake.kind === 'feedback');
  if (feedback.length > 0) {
    const first = feedback[0];
    return feedback.filter(
      (wake) =>
        wake.scopePlaceId === first.scopePlaceId &&
        wake.placeId === first.placeId &&
        Boolean(wake.dmChat) === Boolean(first.dmChat) &&
        retryKey(wake) === retryKey(first)
    );
  }
  // The selfimprovement wake and the heartbeat are never coalesced and go alone, after the feedback wakes (a running turn holds the whole drain, so the next one comes at the next tick).
  // The day's selfimprovement wake goes first: a heartbeat that shares its moment waits one tick.
  const improvement = sorted.find((wake) => wake.kind === 'selfimprovement');
  if (improvement) return [improvement];
  const beat = sorted.find((wake) => wake.kind === 'heartbeat');
  if (beat) return [beat];
  const [anchor] = sorted;
  // A retried wake runs only with the wakes of its own failed group (the same attempt and first failure); a fresh one never joins them.
  const key = retryKey(anchor);
  return sorted.filter(
    (wake) =>
      retryKey(wake) === key &&
      wake.scopePlaceId === anchor.scopePlaceId &&
      wake.placeId === anchor.placeId &&
      Boolean(wake.dmChat) === Boolean(anchor.dmChat)
  );
}

/** What tells retried wakes of one failed group from fresh ones: '' for a fresh wake. */
const retryKey = (wake: Wake | undefined): string => (wake?.retry ? `${wake.retry}:${wake.firstFailedAt ?? ''}` : '');

/** Capture the native chat alongside inner evidence. */
export function contextOf(life: InnerContext, chatId?: unknown): Pick<Fact, 'scopePlaceId' | 'chat'> {
  return {
    scopePlaceId: null,
    chat: typeof chatId === 'string' && chatId ? { iface: ifaceOfChat(chatId, life.iface()), chatId } : null,
  };
}

/** Whether a wake may enter the drain. */
export function inScope(life: InnerContext, wake: Wake): boolean {
  return !wake.scopePlaceId || wake.scopePlaceId === contextOf(life).scopePlaceId;
}

/** The persona state, read once from the ready database with a global wake view. */
export function stateOf(life: InnerContext): InnerState {
  const { states } = life;
  const key = 'persona';
  const known = states.get('persona');
  const keepSince = life.now() - CHAIN_KEEP_MS;
  if (known) {
    loadQueue(life, known, keepSince);
    return known;
  }
  // Opened before the file is read: an in-memory queue's first open imports the file's queue fields (wake-queue.ts).
  backendOf(life);
  let raw: unknown = null;
  let lost: string | null = null;
  try {
    if (life.memoryDb) {
      const seam = stateSeam(life);
      const stored = seam.run(() => unitValue(seam.db(), personaKey('inner')));
      raw = stored.found ? stored.value : null;
    } else raw = JSON.parse(fs.readFileSync(fileOf(life), 'utf8'));
  } catch (err) {
    if (life.memoryDb) throw err;
    if (errorCode(err) !== 'ENOENT') lost = errorCode(err) ?? 'parse';
  }
  const state = normalizeState(raw);
  states.set('persona', state);
  if (lost !== null) loseState(life, key, state, lost);
  loadQueue(life, state, keepSince);
  return state;
}

/**
 * The state file could not be read: it is moved aside (`inner.json.bad-<ts>`, never overwritten),
 * the loss is logged and journalled, and a `stateLost` fact tells her at her next turn that she
 * started empty. Never a silent empty start. Never throws.
 */
export function loseState(life: InnerContext, key: string, state: InnerState, code: string): void {
  const { now, log } = life;
  const at = now();
  const backup = `${fileOf(life)}.bad-${at}`;
  let kept = true;
  try {
    fs.renameSync(fileOf(life), backup);
  } catch (err) {
    kept = false;
    log.warn('inner: unreadable state could not be moved aside', { code: errorCode(err) });
  }
  log.warn('inner: state unreadable, starting empty', { code, kept });
  note(life, { event: 'stateLost', code, kept });
  addFact(life, state, { at, kind: 'stateLost', code, placeId: null, dmChat: false });
  // Written only when the old file is safe aside; if it could not be moved it stays where it is.
  if (!kept) return;
  try {
    writeJsonAtomic(fileOf(life), fileStateOf(state));
  } catch (err) {
    log.warn('inner: state write failed', { code: errorCode(err) });
  }
}

/** Prune the persona state in place and persist it. */
export function save(life: InnerContext): InnerState {
  const { hot, now } = life;
  const key = 'persona';
  // Pruned in place: whoever holds the state object keeps seeing the one that is written.
  const next = Object.assign(
    stateOf(life),
    pruneState(stateOf(life), now(), { factsKeepMs: innerSettings(hot.config).factsKeepDays * DAY_MS })
  );
  persistState(life, key, next);
  return next;
}

/** A supplied service must expose its ready read connection. */
function stateSeam(life: InnerContext) {
  return createReadSeam({
    memoryDb: life.memoryDb,
    log: life.log,
    reader: 'inner',
  });
}

/** State writes share the queue's chain, which release waits for. */
function persistState(life: InnerContext, key: string, state: InnerState): void {
  const failed = (err: unknown) => life.log.warn('inner: state write failed', { code: errorCode(err) });
  const value = fileStateOf(state);
  const { memoryDb } = life;
  if (memoryDb) {
    if (!memoryDb.writeUnit) throw Object.assign(new Error('DB_WRITE_UNAVAILABLE'), { code: 'DB_WRITE_UNAVAILABLE' });
    const write = memoryDb.writeUnit.bind(memoryDb);
    const snapshot: unknown = JSON.parse(JSON.stringify(value));
    const keyOfState = personaKey('inner');
    life.writes = life.writes.then(() => write({ op: 'value', key: keyOfState, value: snapshot })).catch(failed);
    return;
  }
  try {
    writeJsonAtomic(fileOf(life), value);
  } catch (err) {
    failed(err);
  }
}

/**
 * What `inner.json` holds of the state: everything but the queue, the handled wakes and the in-flight mark (the entries
 * are the state's own, so the cast only drops the three keys the filter removed).
 */
function fileStateOf(state: InnerState): Omit<InnerState, 'queue' | 'handled' | 'inflight'> {
  return Object.fromEntries(
    Object.entries(state).filter(([key]) => key !== 'queue' && key !== 'handled' && key !== 'inflight')
  ) as Omit<InnerState, 'queue' | 'handled' | 'inflight'>;
}

/**
 * One write of the turn's wake run through the memory database's writer (src/memory/db/wakes.ts), in order with the
 * others; a failure is logged with a code. Never throws.
 */
export function wakeWrite(life: InnerContext, update: WakeUpdate): void {
  const { memoryDb, log } = life;
  if (typeof memoryDb?.recordWake !== 'function') return;
  const record = memoryDb.recordWake.bind(memoryDb);
  Promise.resolve()
    .then(() => record(update))
    .catch((err: unknown) => log.warn('inner: wake run not recorded', { op: update.op, code: errorCode(err) }));
}

/** One `inner` journal record (features.journal exactly true, read now); never throws. */
export function note(life: InnerContext, fields: Obj): void {
  const { journal, log } = life;
  if (typeof journal?.inner !== 'function') return;
  const write = journal.inner.bind(journal);
  Promise.resolve()
    .then(() => write(fields))
    .catch((err: unknown) => log.warn('inner: journal failed', { code: errorCode(err) }));
}

/** The store's `state.json` data: the pause flag and the time of the pause. */
export const storeStateOf = ({ store }: InnerContext): { paused?: unknown; pausedAt?: unknown } | undefined =>
  store?.state?.data;

/** Whether the memory store is paused (`/nep pause`). Never throws. */
export function paused(life: InnerContext): boolean {
  try {
    return storeStateOf(life)?.paused === true;
  } catch {
    return false;
  }
}

/** `fact` kept in `state.facts` (not told yet); the fact's `placeId` and `dmChat` say where it may be shown. */
export function addFact(life: InnerContext, state: InnerState, fact: FactInput): Fact {
  const { now } = life;
  const at = isFiniteNumber(fact.at) ? fact.at : now();
  return addFactTo(state, { ...contextOf(life, fact.placeId), ...fact, at }, `f${at.toString(36)}-${++life.factSeq}`);
}

/** The purpose of intention `id` in the place's store ('' when unknown). Never throws. */
export function purposeOf(life: InnerContext, id: string): string {
  const { intentions } = life;
  try {
    const purpose = id ? objOf(intentions?.store?.()?.get?.(id)).purpose : null;
    return typeof purpose === 'string' ? purpose : '';
  } catch {
    return '';
  }
}

/** The fact about `wake` (`wakeDropped` or `wakeHeld`) with its `code`, where it belongs and what `extra` adds. */
export function wakeFact(life: InnerContext, wake: Wake, kind: string, code: string, extra: Obj = {}): FactInput {
  const intentionId = listOf(wake.intentionIds).map(String)[0] ?? null;
  return {
    ...contextOf(life, wake.placeId),
    kind,
    wakeId: wake.id,
    wake: wake.kind,
    code,
    intentionId,
    purpose: intentionId ? purposeOf(life, intentionId) : '',
    ...extra,
    placeId: wake.placeId ?? null,
    dmChat: wake.dmChat === true,
  };
}

/** What the journal keeps of a wake: ids, codes and times. */
export function wakeFields(wake: Wake): Obj {
  const { attend } = wake;
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
    ...(attend ? { place: attend.place, lines: attend.lines, people: attend.people.length } : {}),
    ...(wake.kind === 'feedback' ? { turnId: wake.turnId ?? null, facts: listOf(wake.facts) } : {}),
  };
}

/** Whether her actions may leave an inner turn now: the switch on, not stopped, not paused. */
export function mayAct(life: InnerContext): boolean {
  return !stateOf(life).stopped && !paused(life);
}
