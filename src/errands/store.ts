// The persona's errands, one store per place, on the task board of the memory database (src/board/errands.ts): each
// errand is a task of the board's errand lane with the errand's id, written as the principal `core`, and the store
// loads every errand of its place from the board at its creation. An errand moves `queued` -> `running` -> `done` |
// `failed` | `cancelled` (a queued one may also be cancelled or failed directly); a finished errand is never reopened,
// and an end that arrives after a cancel is ignored. The list in memory keeps the open errands, then the finished ones
// she has not read and the latest others, at most KEEP_FINISHED of them; the board keeps them all. The caps are
// enforced here, on `add`, read from the live config at the moment of use: `errands.maxOpen` open errands at once
// (`cap-open`), `agents.<profile>.daily.tasks` (the profile's `daily`, overridable there) errands per UTC day
// (`cap-tasks`; an errand counts on the day it was queued). That daily number and the owner card's `costs.errands`
// come from one place: src/errands/costs.ts#agentCosts over the store's spend records, one per errand of the last
// KEEP_DAYS days (read from the board at load, then kept with every transition).
// Every change of an errand is one write of the whole errand through the memory database's writer (write kind `errand`
// of src/memory/db/errand-write.ts), sent at once (src/memory/db/writes-under-way.ts): the writer takes the writes in the
// order they were sent, a failed write sends the errand as it is then again at the next change or `flush`, and
// `flush({ final: true })` (the shutdown) logs what still fails as lost. The end of an errand (`finish`,
// `cancel`, `failOpen`) is one transaction of the writer: the board's move to its end, the board's outbox row to
// `persona`, and the closing journal action line; a failure of any of them writes none. `pendingEnds` lists the ends
// the board committed whose `errand.done` the core has not marked delivered (`markDelivered`), so a core started after
// a crash finds an end it never delivered.
// Every transition is also an `action` line of the journal (src/memory/journal.ts), shaped like a skill call's
// operation: one `opId` per errand, `proposed` when queued, `started` when running, then one closing `succeeded` or
// `failed` (with the code), counts only -- never the goal or the result; the line's `errandId` references the board
// task (`day.work_id`). An errand's files are named to the persona by a handle `file:<errand id>/<name>` (fileOf
// resolves it, only for a name the errand's result lists, inside the profile's `out`). The runner deletes an errand's
// directory after `errands.keepFilesHours` (src/agent-runner/sweep.ts); a finished errand whose result lists files is
// marked `filesExpired` once its directory is gone from an out dir that is still there (checked when the errands are
// read), and its handles name nothing from then on.
// A finished errand's result stays until she has read it: the record carries `readAt` (null until a turn that showed
// its `<errand_result>` completed, or `errand.read` returned it, src/tools/operations/errand.ts) and `resolvedAt` (she closed
// it: `errand.resolve`, or an intention that waited on it moved to done). `unread` lists the finished ones with
// neither, oldest first; `seen` only says the result turn ran, and hides nothing. A record from before `readAt`
// existed counts as read when it was `seen`.
// Logs carry ids and codes, never text.

import { PERSONA_ID } from '../memory/db/storage-keys.ts';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { log as defaultLog } from '../log.ts';
import { DAY_MS } from '../time.ts';
import { agentCosts, costRecord, KEEP_DAYS } from './costs.ts';
import { normalizeResult, normalizeUsage } from '../agent-runner/protocol.ts';
import { createReadSeam } from '../memory/db/readers/common.ts';
import { createWritesUnderWay } from '../memory/db/writes-under-way.ts';
import { errandsOf, pendingEnds as boardEnds } from '../board/errands.ts';
import { agentSettings, profileOf } from '../agent-runner/profiles.ts';
import type { AgentPaths } from '../agent-runner/profiles.ts';
import { CODE } from '../tools/codes.ts';
import { errorCode, idText, isFiniteNumber, objOf } from '../tools/types.ts';
import type { Untyped } from '../tools/types.ts';
import type {
  AddInput,
  ErrandOrigin,
  AddResult,
  AgentCosts,
  Budget,
  CostRecord,
  ErrandEnd,
  ErrandFile,
  ErrandFileRef,
  ErrandRecord,
  ErrandState,
  ErrandStore,
  ErrandStores,
  FinishOutcome,
  FlushCounts,
  Logger,
  NormalizedResult,
  RequesterKind,
} from './types.ts';

/** Every state an errand may be in. */
export const ERRAND_STATES: ReadonlyArray<ErrandState> = Object.freeze([
  'queued',
  'running',
  'done',
  'failed',
  'cancelled',
] as const);
/** The states of an errand still under way. */
export const OPEN_STATES: ReadonlyArray<string> = Object.freeze(['queued', 'running'] as const);
/** Who asked for an errand. */
export const REQUESTER_KINDS: ReadonlyArray<RequesterKind> = Object.freeze(['owner', 'member', 'persona'] as const);
/** `errands.maxOpen` when it is missing (config.json carries the same). */
export const DEFAULT_MAX_OPEN = 3;
/** The finished errands the list in memory keeps besides the open ones (the board keeps every errand). */
export const KEEP_FINISHED = 50;
/** The prefix of an errand file handle. */
export const FILE_HANDLE_PREFIX = 'file:';

const FILE_HANDLE_RE = /^file:([A-Za-z0-9_-]{1,64})\/([^/\\]{1,200})$/;

/** The state names as text, to test a value read from the database. */
const STATE_NAMES: ReadonlyArray<string> = ERRAND_STATES;

/** A file handle for `name` of errand `id`. */
export function fileHandle(id: string, name: string): string {
  return `${FILE_HANDLE_PREFIX}${id}/${name}`;
}

/** `{ id, name }` of a file handle, or null when it is not one. */
export function parseFileHandle(handle: unknown): { id: string; name: string } | null {
  const match = FILE_HANDLE_RE.exec(idText(handle).trim());
  if (!match || match[2] === '.' || match[2] === '..') return null;
  return { id: match[1], name: match[2] };
}

/** True for a state of an errand still under way. */
export function isOpenState(state: unknown): boolean {
  return typeof state === 'string' && OPEN_STATES.includes(state);
}

/** Whether a value read from the database is a stored errand (an id and a known state). */
function isStoredErrand(value: unknown): value is ErrandRecord {
  const record = objOf(value);
  return typeof record.id === 'string' && typeof record.state === 'string' && STATE_NAMES.includes(record.state);
}

/** The requester kind a caller names, `member` for anything else. */
function requesterKindOf(kind: unknown): RequesterKind {
  return kind === 'owner' || kind === 'persona' ? kind : 'member';
}

/** The state a runner's `status` closes an errand in: `done` and `cancelled` as they are, anything else `failed`. */
function endStateOf(status: unknown): 'done' | 'failed' | 'cancelled' {
  return status === 'done' || status === 'cancelled' ? status : 'failed';
}

/** Normalize the older board records before the store exposes them. */
function loadedErrands(records: Array<unknown>): Array<ErrandRecord> {
  const errands = records.filter(isStoredErrand);
  for (const errand of errands) {
    // Records from before readAt: a seen one was read, an unseen one is still unread.
    if (errand.readAt === undefined)
      errand.readAt = errand.seen === true ? (errand.endedAt ?? errand.createdAt ?? 0) : null;
    if (errand.resolvedAt === undefined) errand.resolvedAt = null;
  }
  return errands;
}

/** The values a store is built over; `memoryDb` is the memory database service (src/memory/db/). */
type StoreOptions = {
  agentPaths?: AgentPaths;

  now?: () => number;
  /** The live config (`errands.*`, `agents.<profile>` overrides, `features.journal`). */
  config?: () => Untyped;
  /** src/memory/journal.ts#createJournal's. */
  journal?: Untyped;
  uuid?: () => string;
  log?: Logger;
  memoryDb?: Untyped;
};

/** The memory database service's write the store makes (src/memory/db/service.ts). */
type MemoryWrites = {
  writeErrand: (write: Record<string, unknown>) => Promise<unknown>;
};
/** The journal's two writers of an `action` line the store uses (src/memory/journal.ts). */
type JournalWrites = {
  action: ((placeId: string, record: Record<string, unknown>) => unknown) | null;
  actionLine: ((placeId: string, record: Record<string, unknown>) => { placeId: string | null; line: unknown }) | null;
};

/** A function property `name` of `value`, bound to it, or null. */
function methodOf(value: unknown, name: string): ((...args: Array<unknown>) => unknown) | null {
  const found: unknown = value !== null && typeof value === 'object' ? Reflect.get(value, name) : null;
  // A function read off the object is called with its own object as `this`, whatever its arguments.
  return typeof found === 'function' ? (found as (...args: Array<unknown>) => unknown).bind(value) : null;
}

/** The write of the memory database service, or null without a `writeErrand`. */
function memoryWritesOf(memoryDb: unknown): MemoryWrites | null {
  const writeErrand = methodOf(memoryDb, 'writeErrand');
  if (writeErrand === null) return null;
  return {
    writeErrand: (write) => Promise.resolve(writeErrand(write)),
  };
}

/** The journal's `action` and `actionLine`, each null when the journal has none. */
const journalWritesOf = (journal: unknown): JournalWrites => ({
  action: methodOf(journal, 'action'),
  // The journal's `actionLine` answers the line and the place whose journal takes it.
  actionLine: methodOf(journal, 'actionLine') as JournalWrites['actionLine'],
});

/** The errands' writes to the board, each sent at once (src/memory/db/writes-under-way.ts). */
type ErrandWrites = {
  send: (id: string, value: { errand: ErrandRecord | null } & Record<string, unknown>) => void;
  holds: (id: string) => boolean;
  flush: (
    options: { final?: boolean; timeoutMs?: number | undefined },
    resend: (id: string, errand: ErrandRecord | null) => void
  ) => Promise<number>;
};

/**
 * The writes of errands as the memory writer's kind `errand`: `holds(id)` while a write of the errand is under way or
 * its latest write failed, and `flush` sends each failed errand again through `resend`.
 */
function errandWrites({ writeErrand }: MemoryWrites, log: Logger): ErrandWrites {
  const underWay = createWritesUnderWay({ log, name: 'tasks' });
  // id -> how many writes of the errand are under way; id -> the record of the errand whose latest write failed.
  const sending = new Map<string, number>();
  const unwritten = new Map<string, ErrandRecord | null>();
  // id -> the number of the errand's latest write, so only its failure marks the errand unwritten.
  const latest = new Map<string, number>();
  let count = 0;
  const settled = (id: string): void => {
    const left = (sending.get(id) ?? 1) - 1;
    if (left > 0) sending.set(id, left);
    else sending.delete(id);
  };
  return {
    send(id, value) {
      count += 1;
      const number = count;
      latest.set(id, number);
      unwritten.delete(id);
      sending.set(id, (sending.get(id) ?? 0) + 1);
      underWay.track(
        () => writeErrand(value).finally(() => settled(id)),
        () => {
          if (latest.get(id) === number) unwritten.set(id, value.errand);
        }
      );
    },
    holds: (id) => sending.has(id) || unwritten.has(id),
    flush: (options, resend) =>
      underWay.drain({
        ...options,
        unwritten: () => unwritten.size,
        resend: () => {
          for (const [id, errand] of [...unwritten]) resend(id, errand);
        },
      }),
  };
}

/** Whether a spend record is older than the last KEEP_DAYS days (by its later time). */
function stale(record: CostRecord, at: number): boolean {
  const last = Math.max(record.createdAt ?? -Infinity, record.endedAt ?? -Infinity);
  return last < at - KEEP_DAYS * DAY_MS;
}

/** The spend records of `errands` at `at`, the stale ones left out. */
function spendOf(errands: ReadonlyArray<ErrandRecord>, at: number): Map<string, CostRecord> {
  const records = new Map<string, CostRecord>();
  for (const errand of errands) {
    const record = costRecord(errand);
    if (record && !stale(record, at)) records.set(record.id, record);
  }
  return records;
}

/** Whether `errand` is a finished errand whose result she has not read nor closed. */
function isUnread(errand: ErrandRecord): boolean {
  return !isOpenState(errand.state) && !errand.readAt && !errand.resolvedAt;
}

/** The list kept: every open errand, then the finished ones, the unread first, at most KEEP_FINISHED. */
function pruned(errands: Array<ErrandRecord>): Array<ErrandRecord> {
  const finished = errands.filter((errand) => !isOpenState(errand.state));
  if (finished.length <= KEEP_FINISHED) return errands;
  // The unread first, then the latest to end.
  const keep = new Set(
    [...finished]
      .sort(
        (a, b) => Number(isUnread(a) === false) - Number(isUnread(b) === false) || (b.endedAt ?? 0) - (a.endedAt ?? 0)
      )
      .slice(0, KEEP_FINISHED)
  );
  return errands.filter((errand) => isOpenState(errand.state) || keep.has(errand));
}

/** The fields of the errand's journal `action` line of `phase`. */
function journalFields(errand: ErrandRecord, phase: string, extra: Record<string, unknown>): Record<string, unknown> {
  const privateAccountId = errand.scope === 'dm' ? (errand.requester?.accountId ?? null) : null;
  return {
    opId: errand.opId,
    name: 'errand',
    // Her errand, whoever asked for it: the requester is in `participants`.
    by: 'persona',
    ...(privateAccountId ? { privateAccountId } : { placeId: errand.origin?.placeId ?? null }),
    participants: errand.requester?.accountId ? [errand.requester.accountId] : [],
    sourceMessageIds: errand.origin?.messageId ? [errand.origin.messageId] : [],
    phase,
    ...extra,
  };
}

/** The counts of a finished errand for its closing journal line: never its text. */
function journalResult(errand: ErrandRecord): Record<string, unknown> {
  const result = errand.result;
  const out: Record<string, unknown> = { errandId: errand.id, state: errand.state };
  const chars = typeof result?.text === 'string' ? result.text.length : 0;
  if (chars > 0) out.chars = chars;
  if (Array.isArray(result?.sources) && result.sources.length > 0) out.sources = result.sources.length;
  if (Array.isArray(result?.files) && result.files.length > 0) out.files = result.files.length;
  if (typeof result?.searchFailures === 'number') out.searchFailures = result.searchFailures;
  if (errand.usage)
    out.usage = { usd: errand.usage.usd ?? 0, steps: errand.usage.steps ?? 0, seconds: errand.usage.seconds ?? 0 };
  return out;
}

/** The files of an errand's result: none without a result or with a list the store cannot read. */
function resultFilesOf(errand: ErrandRecord | null | undefined): Array<ErrandFile> {
  const files = errand?.result?.files;
  return Array.isArray(files) ? files : [];
}

/** A copy of a stored errand, as the store hands it out (a stored record is plain JSON). */
function copy(errand: ErrandRecord): ErrandRecord {
  return JSON.parse(JSON.stringify(errand)) as ErrandRecord;
}

/** The daily caps of `agent`: its profile's `daily` under the deployment's override. */
function dailyCaps(agent: string, config: Untyped, agentPaths?: AgentPaths): { tasks: number | undefined } {
  const defaults = profileOf(agent, agentPaths)?.defaultDaily ?? {};
  const set: Record<string, number> = agentSettings(agent, config, agentPaths)?.daily ?? {};
  const fallback = defaults.tasks;
  return { tasks: Number.isFinite(set.tasks) ? set.tasks : typeof fallback === 'number' ? fallback : undefined };
}

/**
 * `memoryDb` is the memory database service: the errands and the spend records are loaded from the board on its read
 *   connection (src/board/errands.ts#errandsOf; a failed read throws, with a code), and each change goes to the board
 *   through the outbox (see the head of this file). Without a `memoryDb` (tests) nothing is read or written: the list
 *   lives in memory only, and no end is ever pending.
 */
/** The stored origin of an errand. What an internal turn asked for stays restricted to where it was asked. */
function originOf(origin: AddInput['origin'] | undefined): ErrandOrigin {
  return {
    placeId: origin?.placeId ? String(origin.placeId) : null,
    messageId: origin?.messageId ? String(origin.messageId) : null,
    // The persona's turn whose accepted call this is (none for a command).
    ...(origin?.turnId ? { turnId: String(origin.turnId) } : {}),
    ...(origin?.publicationBoundary ? { publicationBoundary: origin.publicationBoundary } : {}),
  };
}

export function createErrandStore({
  now = Date.now,
  config = () => ({}),
  journal = null,
  uuid = randomUUID,
  log = defaultLog,
  memoryDb = null,
  agentPaths,
}: StoreOptions): ErrandStore {
  const seam = createReadSeam({ memoryDb, log, reader: 'tasks' });
  const db = memoryDb ? seam.db() : null;
  // Every errand of the place the board holds; the list keeps the pruned part of them.
  const loaded = load();
  const state: { errands: Array<ErrandRecord> } = { errands: loaded };
  const writes = memoryWritesOf(memoryDb);
  const journalWrites = journalWritesOf(journal);
  const writer = db && writes ? errandWrites(writes, log) : null;
  // id -> the closing journal line of an end not yet known written; it rides along every write of that errand, and
  // the writer writes it only with the move to the end.
  const closings = new Map<string, unknown>();
  // The errands whose end this process marked delivered.
  const delivered = new Set<string>();
  // id -> the spend record of each errand of the last KEEP_DAYS days (src/errands/costs.ts#costRecord).
  const spend = spendOf(loaded, now());
  state.errands = pruned(state.errands);

  /** Every errand of the place, read once from the board (none without a `memoryDb`). */
  function load(): Array<ErrandRecord> {
    // The board rebuilds each errand exactly as this store wrote it (src/board/archive.ts#errandOf).
    const errands = loadedErrands(db ? seam.run(() => errandsOf(db)) : []);
    return errands;
  }

  /** `errand`'s spend record updated, the stale ones dropped. */
  function noteSpend(errand: ErrandRecord): void {
    const record = costRecord(errand);
    if (record) spend.set(record.id, record);
    const at = now();
    for (const [id, kept] of spend) if (stale(kept, at)) spend.delete(id);
  }

  /** The errand's write to the board sent (its spend noted, the list pruned). */
  function persist(errand: ErrandRecord): void {
    state.errands = pruned(state.errands);
    noteSpend(errand);
    send(errand.id, errand);
  }

  /** One write of errand `id` (its record, or null for the delivery mark alone) sent to the writer. */
  function send(id: string, errand: ErrandRecord | null): void {
    if (!memoryDb) return;
    if (!writer) {
      log.warn('errands: tasks write failed', { code: 'DB_CLOSED' });
      return;
    }
    writer.send(id, {
      id,
      at: now(),
      errand: errand ? copy(errand) : null,
      delivered: delivered.has(id),
      closing: closings.get(id) ?? null,
    });
  }

  /** Whether the journal takes lines: one was given. */
  const journalOn = (): boolean => Boolean(journal);

  /**
   * The closing journal line of an end: kept to ride along the end's write to the board (one transaction with the move)
   * when the store writes the board and the journal builds lines (`actionLine`), else written by itself.
   */
  function closingLine(errand: ErrandRecord, phase: string, extra: Record<string, unknown>): void {
    if (!journalOn()) return;
    const { actionLine } = journalWrites;
    if (writer && actionLine) {
      closings.set(errand.id, actionLine(PERSONA_ID, journalFields(errand, phase, extra)));
      return;
    }
    journalLine(errand, phase, extra);
  }

  /** One journal `action` line of the errand's operation (features.journal exactly true, read now); never throws. */
  function journalLine(errand: ErrandRecord, phase: string, extra: Record<string, unknown> = {}): void {
    const { action } = journalWrites;
    if (!journalOn() || !action) return;
    Promise.resolve(action(PERSONA_ID, journalFields(errand, phase, extra))).catch((err: unknown) =>
      log.warn('errands: journal failed', { id: errand.id, code: errorCode(err) })
    );
  }

  /** The out directory of `agent` (its profile's `out` under the deployment's override); null for an unknown agent. */
  function outDirOf(agent: string): string | null {
    return agentSettings(agent, config(), agentPaths)?.out || null;
  }

  /** Whether `file` is missing (ENOENT); false when it is there or cannot be told. */
  function missing(file: string): boolean {
    try {
      fs.statSync(file);
      return false;
    } catch (err) {
      return errorCode(err) === 'ENOENT';
    }
  }

  /**
   * The finished errands whose files the runner has deleted, marked `filesExpired` (and the list
   * written once when any is): an errand with files whose `<out>/<id>/` is gone while `<out>` itself
   * is there (an out dir missing altogether, as on a host without the runner, expires nothing).
   */
  function expireFiles(): number {
    let changed = 0;
    for (const errand of state.errands) {
      if (isOpenState(errand.state) || errand.filesExpired === true) continue;
      if (resultFilesOf(errand).length === 0) continue;
      const outDir = outDirOf(errand.agent);
      if (!outDir || missing(outDir) || !missing(path.join(outDir, errand.id))) continue;
      errand.filesExpired = true;
      persist(errand);
      changed += 1;
    }
    if (changed > 0) {
      log.info('errands: task files expired', { count: changed });
    }
    return changed;
  }

  /**
   * The spend of every agent with a record, and of each of `agents` (src/errands/costs.ts#agentCosts):
   * per window (`today`, `last7`, `last30`) its runs, input and output tokens and dollars.
   */
  function costs(agents: Array<string> = []): AgentCosts {
    return agentCosts(spend.values(), { now: now(), agents });
  }

  /** Today's errands and dollars of `agent`: the `today` window of `costs`. */
  function usedToday(agent: string): { tasks: number; usd: number } {
    const { today: row } = costs([agent])[agent];
    return { tasks: row.runs, usd: row.usd };
  }

  /** The cap `agent` hits now, as its refusal code, or null. */
  function capHit(agent: string): string | null {
    const set = config()?.errands?.maxOpen;
    const maxOpen = Number.isFinite(set) ? set : DEFAULT_MAX_OPEN;
    if (open().length >= maxOpen) return 'cap-open';
    const caps = dailyCaps(agent, config(), agentPaths);
    const used = usedToday(agent);
    if (isFiniteNumber(caps.tasks) && used.tasks >= caps.tasks) return 'cap-tasks';
    return null;
  }

  /** A fresh errand id, unique in the list. */
  function freshId(): string {
    for (;;) {
      const id = `t${uuid().replace(/-/g, '').slice(0, 8)}`;
      if (!state.errands.some((errand) => errand.id === id)) return id;
    }
  }

  /** The errand `id` (the stored object), or null. */
  function find(id: unknown): ErrandRecord | null {
    return state.errands.find((errand) => errand.id === idText(id)) ?? null;
  }

  /**
   * A new errand, `queued`, or the cap it hits: `{ ok: true, errand }` | `{ ok: false, code }`
   * (`unknown-agent`, `bad-goal`, `cap-open`, `cap-tasks`). The persona's own call
   * brings its `idempotencyKey` (her turn and the call's index in it, src/behavior/turn.ts) and
   * its turn (`origin.turnId`): an errand the store still holds under the same key is answered as it
   * is, `{ ok: true, errand, duplicate: true }`, before any cap -- a retried call never queues a
   * second errand. The goal is kept as she wrote it (trimmed).
   */
  function add({ agent, goal, requester, origin, scope, idempotencyKey = null }: Partial<AddInput> = {}): AddResult {
    if (typeof agent !== 'string' || !profileOf(agent, agentPaths)) return { ok: false, code: CODE.UNKNOWN_AGENT };
    const text = String(goal ?? '').trim();
    if (!text) return { ok: false, code: CODE.BAD_GOAL };
    const key = typeof idempotencyKey === 'string' && idempotencyKey ? idempotencyKey : null;
    const same = key ? state.errands.find((errand) => errand.idempotencyKey === key) : null;
    if (same) {
      log.info('errands: duplicate', { id: same.id, agent: same.agent });
      return { ok: true, errand: copy(same), duplicate: true };
    }
    const cap = capHit(agent);
    if (cap) return { ok: false, code: cap };
    const at = now();
    const errand: ErrandRecord = {
      id: freshId(),
      agent,
      goal: text,
      requester: {
        accountId: requester?.accountId ? String(requester.accountId) : null,
        kind: requesterKindOf(requester?.kind),
      },
      origin: originOf(origin),
      ...(key ? { idempotencyKey: key } : {}),
      scope: scope === 'dm' ? 'dm' : 'group',
      state: 'queued',
      createdAt: at,
      startedAt: null,
      endedAt: null,
      usage: null,
      result: null,
      error: null,
      seen: false,
      readAt: null,
      resolvedAt: null,
      opId: `op-${uuid()}`,
    };
    state.errands.push(errand);
    persist(errand);
    journalLine(errand, 'proposed', {
      input: { errandId: errand.id, agent, goalChars: text.length, requester: errand.requester.kind },
    });
    log.info('errands: task queued', { id: errand.id, agent });
    return { ok: true, errand: copy(errand) };
  }

  /** Errand `id` moved from `queued` to `running`; null when it is not queued. */
  function start(id: unknown): ErrandRecord | null {
    const errand = find(id);
    if (!errand || errand.state !== 'queued') return null;
    errand.state = 'running';
    errand.startedAt = now();
    persist(errand);
    journalLine(errand, 'started', { target: { errandId: errand.id } });
    return copy(errand);
  }

  /**
   * Errand `id` ended with the runner's outcome (`status` done | failed | cancelled, its result,
   * usage and error code): its dollars counted for today. Null when the errand is not open (a
   * cancel came first: the late end is ignored).
   */
  function finish(id: unknown, { status, result, usage, error }: FinishOutcome = {}): ErrandRecord | null {
    const errand = find(id);
    if (!errand || !isOpenState(errand.state)) return null;
    const at = now();
    errand.state = endStateOf(status);
    errand.endedAt = at;
    errand.usage = normalizeUsage(usage);
    // The record keeps only the names of the files the runner held back (the persona is told).
    errand.result = null;
    if (errand.state === 'done' || result) {
      const { filesDropped, ...kept }: NormalizedResult = normalizeResult(result);
      const held = filesDropped ? filesDropped.map((entry) => entry.name).filter(Boolean) : [];
      errand.result = held.length > 0 ? { ...kept, filesDropped: held } : kept;
    }
    errand.error =
      errand.state === 'done'
        ? null
        : typeof error === 'string' && error
          ? error
          : errand.state === 'cancelled'
            ? 'cancelled'
            : 'failed';
    errand.seen = false;
    if (errand.state === 'done') closingLine(errand, 'succeeded', { result: journalResult(errand) });
    else closingLine(errand, 'failed', { result: { ...journalResult(errand), code: errand.error } });
    persist(errand);
    log.info('errands: task ended', {
      id: errand.id,
      agent: errand.agent,
      state: errand.state,
      ...(errand.error ? { code: errand.error } : {}),
    });
    return copy(errand);
  }

  /** Errand `id` cancelled when it is open (the caller tells the runner); null otherwise. */
  function cancel(id: unknown): ErrandRecord | null {
    const errand = find(id);
    if (!errand || !isOpenState(errand.state)) return null;
    return finish(id, { status: 'cancelled', error: 'cancelled' });
  }

  /** Errand `id` marked as seen by the persona; null when there is none. */
  function markSeen(id: unknown): ErrandRecord | null {
    const errand = find(id);
    if (!errand) return null;
    if (errand.seen !== true) {
      errand.seen = true;
      persist(errand);
    }
    return copy(errand);
  }

  /** Errand `id` marked as read by the persona (its result was shown to her or returned to her); null when there is none. */
  function markRead(id: unknown): ErrandRecord | null {
    const errand = find(id);
    if (!errand) return null;
    if (!errand.readAt) {
      errand.readAt = now();
      persist(errand);
    }
    return copy(errand);
  }

  /** Errand `id` noted as one whose result turn never completed (it stays unread); null when there is none. */
  function markResultFailed(id: unknown): ErrandRecord | null {
    const errand = find(id);
    if (!errand) return null;
    if (errand.resultTurnFailed !== true) {
      errand.resultTurnFailed = true;
      persist(errand);
    }
    return copy(errand);
  }

  /** Errand `id` closed by the persona (read too); null when there is none or it is still open. */
  function resolve(id: unknown): ErrandRecord | null {
    const errand = find(id);
    if (!errand || isOpenState(errand.state)) return null;
    if (!errand.resolvedAt) {
      errand.resolvedAt = now();
      persist(errand);
    }
    return copy(errand);
  }

  /** The open errands (queued and running), oldest first. */
  function open(): Array<ErrandRecord> {
    return state.errands.filter((errand) => isOpenState(errand.state)).map(copy);
  }

  /** The latest `n` errands, newest first. */
  function recent(n = 10): Array<ErrandRecord> {
    expireFiles();
    const count = Number.isInteger(n) && n > 0 ? n : 10;
    // Reversed first, so errands of the same millisecond keep the later one first.
    return state.errands
      .slice()
      .reverse()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, count)
      .map(copy);
  }

  /** The finished errands the persona has not seen yet, oldest first. */
  function unseen(): Array<ErrandRecord> {
    expireFiles();
    return state.errands.filter((errand) => !isOpenState(errand.state) && errand.seen !== true).map(copy);
  }

  /** The finished errands whose result she has not read nor closed, oldest first (to end). */
  function unread(): Array<ErrandRecord> {
    expireFiles();
    return state.errands
      .filter(isUnread)
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
      .map(copy);
  }

  /** Errand `id`, or null. */
  function get(id: unknown): ErrandRecord | null {
    expireFiles();
    const found = find(id);
    return found ? copy(found) : null;
  }

  /**
   * The budget of `agent` for the skills gateway (src/tools/gateway.ts): `{ spent, key }`, spent
   * when a cap would refuse a new errand now (`key` the setting).
   */
  function budget(agent: string): Budget {
    const code = profileOf(agent, agentPaths) ? capHit(agent) : CODE.UNKNOWN_AGENT;
    const key =
      code === CODE.CAP_OPEN ? 'errands.maxOpen' : code === CODE.CAP_TASKS ? `agents.${agent}.daily.tasks` : null;
    return { spent: code !== null, key, code };
  }

  /** Today's use of `agent` against its caps: `{ tasks, usd, caps }`. */
  function today(agent: string): { tasks: number; usd: number; caps: { tasks: number | undefined } } {
    return { ...usedToday(agent), caps: dailyCaps(agent, config(), agentPaths) };
  }

  /**
   * The file a handle `file:<errand id>/<name>` names: `{ path, name, contentType, bytes, errand }`
   * when the errand exists, its files have not expired and its result lists that name, the path
   * inside the agent's out directory (the agent's `out`, the profile's under the deployment's override); null otherwise.
   */
  function fileOf(handle: unknown): ErrandFileRef | null {
    const parsed = parseFileHandle(handle);
    if (!parsed) return null;
    expireFiles();
    const errand = find(parsed.id);
    if (!errand || errand.filesExpired === true) return null;
    const file = resultFilesOf(errand).find((entry) => entry?.name === parsed.name) ?? null;
    if (!file) return null;
    const outDir = outDirOf(errand.agent);
    if (!outDir) return null;
    const base = path.resolve(outDir, errand.id);
    const full = path.resolve(base, parsed.name);
    if (path.dirname(full) !== base) return null;
    return {
      path: full,
      name: parsed.name,
      contentType: file.contentType ?? '',
      bytes: file.bytes ?? 0,
      errand: copy(errand),
    };
  }

  /** Whether the handle names a file of an errand whose files have expired (`file-expired`); false otherwise. */
  function fileExpired(handle: unknown): boolean {
    const parsed = parseFileHandle(handle);
    if (!parsed) return false;
    expireFiles();
    const errand = find(parsed.id);
    return errand?.filesExpired === true && resultFilesOf(errand).some((entry) => entry?.name === parsed.name);
  }

  /**
   * Every open errand failed with `code` (a restart of the core: no runner's end can reach this
   * process for them any more). Their failures stay unseen, for the `<errands>` block. Returns how many.
   */
  function failOpen(code: string): number {
    const ids = state.errands.filter((errand) => isOpenState(errand.state)).map((errand) => errand.id);
    for (const id of ids) finish(id, { status: 'failed', error: code });
    return ids.length;
  }

  /**
   * The ends the board committed for this place whose `errand.done` is not marked delivered, oldest first, each with
   * its event id `errand-done:<errand id>`; none without a `memoryDb` or while the database cannot be read.
   */
  function pendingEnds(): Array<ErrandEnd> {
    if (!memoryDb) return [];
    let ends: Array<{ errandId: string; state: string }> = [];
    try {
      ends = seam.run(() => boardEnds(seam.db()));
    } catch {
      // The seam logged the failed read with its code; nothing is pending that cannot be read.
      return [];
    }
    return ends
      .filter((end) => !delivered.has(end.errandId))
      .map((end) => ({
        eventId: `errand-done:${end.errandId}`,
        errandId: end.errandId,
        state: endStateOf(end.state),
      }));
  }

  /**
   * The end of errand `id` marked delivered (the door took its `errand.done`), written to the board; false when no end
   * of that errand is pending. An end whose write has not landed is pending, and the mark rides along that write.
   */
  function markDelivered(id: unknown): boolean {
    const key = idText(id);
    const errand = key ? find(key) : null;
    const landing = Boolean(errand && !isOpenState(errand.state) && writer?.holds(key) === true);
    if (!key || (!landing && !pendingEnds().some((end) => end.errandId === key))) return false;
    delivered.add(key);
    send(key, find(key));
    log.info('errands: end delivered', { id: key });
    return true;
  }

  /**
   * The writes still waiting sent again and awaited; with `final` (the shutdown) what still fails is logged as lost,
   * and the wait ends after `timeoutMs` when given. Nothing without a `memoryDb`.
   */
  async function flush(options: { final?: boolean; timeoutMs?: number } = {}): Promise<FlushCounts> {
    if (!writer) return { waiting: 0 };
    return { waiting: await writer.flush(options, (id, errand) => send(id, find(id) ?? errand)) };
  }

  return {
    add,
    start,
    finish,
    cancel,
    markSeen,
    markRead,
    markResultFailed,
    resolve,
    open,
    recent,
    unseen,
    unread,
    get,
    budget,
    today,
    costs,
    fileOf,
    fileExpired,
    failOpen,
    expireFiles,
    pendingEnds,
    markDelivered,
    flush,
  };
}

/**
 * One errand store per place, created on first use over the same live config and journal (createErrandStore).
 * `memoryDb` goes to every store; a store whose load failed is not kept, so the next `get` tries again.
 */
export function createErrandStores({
  config = () => ({}),
  journal = null,
  now = Date.now,
  log = defaultLog,
  memoryDb = null,
  agentPaths,
}: Omit<StoreOptions, 'placeId' | 'uuid'>): ErrandStores {
  const stores = new Map<string, ErrandStore>();
  const errands: ErrandStores = {
    get(): ErrandStore {
      let store = stores.get('persona');
      if (!store) {
        store = createErrandStore({ config, journal, now, log, memoryDb, agentPaths });
        stores.set('persona', store);
      }
      return store;
    },
    /** Every store's `flush` (the writes waiting for the database; `final` at the shutdown). */
    async flush(options: { final?: boolean; timeoutMs?: number } = {}): Promise<FlushCounts> {
      let waiting = 0;
      for (const store of stores.values()) waiting += (await store.flush(options)).waiting;
      return { waiting };
    },
  };
  return errands;
}
