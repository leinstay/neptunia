// The persona's errand tasks, one store per guild, in the memory database: the unit `guilds/<id>/errands.json` holds
// the current list (the open tasks, then the finished ones she has not seen yet and the latest
// others, at most KEEP_FINISHED of them), written whole on every change; the unit `guilds/<id>/errands.jsonl` gets one
// line per transition (the task as it stands after it), appended, never rewritten. A task moves `queued` ->
// `running` -> `done` | `failed` | `cancelled` (a queued one may also be cancelled or failed
// directly); a finished task is never reopened, and an end that arrives after a cancel is
// ignored. The caps are enforced here, on `add`, read from the live config at the moment of use:
// `errands.maxOpen` open tasks at once (`cap-open`), `agents.<profile>.daily.tasks` (the profile's `daily`, overridable there) tasks per UTC day (`cap-tasks`; a task counts on
// the day it was queued). That daily number
// and the owner card's `costs.errands` come from one place: src/errands/costs.ts#agentCosts over
// the store's spend records, one per task of the last KEEP_DAYS days (read from errands.jsonl at
// load, then kept with every transition).
// Every transition is also an `action` line of the
// journal (src/memory/journal.js), shaped like a skill call's operation: one `opId` per task,
// `proposed` when queued, `started` when running, then one closing `succeeded` or `failed`
// (with the code), counts only -- never the goal or the result. A task's files are named to the
// persona by a handle `file:<task id>/<name>` (fileOf resolves it, only for a name the task's
// result lists, inside the profile's `out`). The runner deletes a task's directory after
// `errands.keepFilesHours` (src/agent-runner/sweep.js); a finished task whose result lists files
// is marked `filesExpired` once its directory is gone from an out dir that is still there (checked
// when the tasks are read), and its handles name nothing from then on.
// A task mirrored into the ledger (src/errands/ledger.ts) carries the ledger's id as `ledgerId`
// (optional; set once the ledger answers, so the transition lines after it carry it too).
// A finished errand's result stays until she has read it: the record carries `readAt` (null until a
// turn that showed its `<errand_result>` completed, or `errand.read` returned it, src/tools/impl/errand.ts) and
// `resolvedAt` (she closed it: `errand.resolve`, or an intention that waited on it moved to done).
// `unread` lists the finished ones with neither, oldest first; `seen` only says the result turn
// ran, and hides nothing. A record from before `readAt` existed counts as read when it was `seen`.
// Logs carry ids and codes, never text.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { log as defaultLog } from '../log.js';
import { DAY_MS } from '../time.js';
import { agentCosts, costRecord, KEEP_DAYS } from './costs.ts';
import { normalizeResult, normalizeUsage } from '../agent-runner/protocol.js';
import { createReadSeam } from '../memory/db/readers/common.js';
import { errandEventLines, errandsValue } from '../memory/db/readers/errands.js';
import { createUnitOutbox } from '../memory/db/unit-outbox.js';
import { agentSettings, profileOf } from '../agent-runner/profiles.js';
import { CODE } from '../tools/codes.ts';
import { errorCode, idText, objOf } from '../tools/types.ts';
import type { Untyped } from '../tools/types.ts';
import type {
  AddInput,
  AddResult,
  AgentCosts,
  Budget,
  CostRecord,
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

/** Every state a task may be in. */
export const TASK_STATES: ReadonlyArray<ErrandState> = Object.freeze([
  'queued',
  'running',
  'done',
  'failed',
  'cancelled',
] as const);
/** The states of a task still under way. */
export const OPEN_STATES: ReadonlyArray<string> = Object.freeze(['queued', 'running'] as const);
/** Who asked for a task. */
export const REQUESTER_KINDS: ReadonlyArray<RequesterKind> = Object.freeze(['owner', 'member', 'persona'] as const);
/** `errands.maxOpen` when it is missing (config.json carries the same). */
export const DEFAULT_MAX_OPEN = 3;
/** The finished tasks errands.json keeps besides the open ones (errands.jsonl keeps every transition). */
export const KEEP_FINISHED = 50;
/** The prefix of a task file handle. */
export const FILE_HANDLE_PREFIX = 'file:';

const FILE_HANDLE_RE = /^file:([A-Za-z0-9_-]{1,64})\/([^/\\]{1,200})$/;

/** The state names as text, to test a value read from the database. */
const STATE_NAMES: ReadonlyArray<string> = TASK_STATES;

/** A file handle for `name` of task `id`. */
export function fileHandle(id: string, name: string): string {
  return `${FILE_HANDLE_PREFIX}${id}/${name}`;
}

/** `{ id, name }` of a file handle, or null when it is not one. */
export function parseFileHandle(handle: unknown): { id: string; name: string } | null {
  const match = FILE_HANDLE_RE.exec(idText(handle).trim());
  if (!match || match[2] === '.' || match[2] === '..') return null;
  return { id: match[1], name: match[2] };
}

/** True for a state of a task still under way. */
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

/** The values a store is built over; `memoryDb` is the memory database service (src/memory/db/). */
type StoreOptions = {
  guildId: string;
  now?: () => number;
  /** The live config (`errands.*`, `agents.<profile>` overrides, `features.journal`). */
  config?: () => Untyped;
  /** src/memory/journal.js#createJournal's. */
  journal?: Untyped;
  uuid?: () => string;
  log?: Logger;
  memoryDb?: Untyped;
};

/**
 * `memoryDb` is the memory database service: the list and the spend records are loaded
 *   from it (src/memory/db/readers/errands.js; a failed read throws, with a code); each change hands the whole list
 *   (`errands.json`, op `value`) and the transition line (`errands.jsonl`, op `lines`) to an outbox
 *   (src/memory/db/unit-outbox.js) that sends them through the database's writer; the list in memory stays the truth,
 *   a failed write goes again at the next change or `flush`, and `flush({ final: true })` (the shutdown) keeps what
 *   still fails in `memory-pending/`. Without a `memoryDb` (tests) nothing is read or written: the list lives in
 *   memory only.
 */
export function createTaskStore({
  guildId,
  now = Date.now,
  config = () => ({}),
  journal = null,
  uuid = randomUUID,
  log = defaultLog,
  memoryDb = null,
}: StoreOptions): ErrandStore {
  const seam = createReadSeam({ memoryDb, log, reader: 'tasks' });
  const db = memoryDb ? seam.db() : null;
  const state: { tasks: Array<ErrandRecord> } = load();
  const outbox =
    db && typeof memoryDb?.writeUnit === 'function' ? createUnitOutbox({ memoryDb, log, name: 'tasks' }) : null;
  const listOwner = `guilds/${String(guildId)}/errands.json`;
  const logOwner = `guilds/${String(guildId)}/errands.jsonl`;
  // id -> the spend record of each task of the last KEEP_DAYS days (src/errands/costs.ts#costRecord).
  const spend = loadSpend();

  /** The list read once from the database (none without a `memoryDb`). */
  function load(): { tasks: Array<ErrandRecord> } {
    let raw: Untyped = null;
    if (db) {
      const found = seam.run(() => errandsValue(db, guildId));
      raw = found.found ? found.value : null;
    }
    const tasks: Array<ErrandRecord> = Array.isArray(raw?.errands) ? raw.errands.filter(isStoredErrand) : [];
    for (const task of tasks) {
      // Records from before readAt: a seen one was read, an unseen one is still unread.
      if (task.readAt === undefined) task.readAt = task.seen === true ? (task.endedAt ?? task.createdAt ?? 0) : null;
      if (task.resolvedAt === undefined) task.resolvedAt = null;
    }
    return { tasks };
  }

  /** Whether a spend record is older than the last KEEP_DAYS days (by its later time). */
  function stale(record: CostRecord, at: number = now()): boolean {
    const last = Math.max(record.createdAt ?? -Infinity, record.endedAt ?? -Infinity);
    return last < at - KEEP_DAYS * DAY_MS;
  }

  /** The spend records read once: the last line of each task in errands.jsonl (a line that does not
   * parse is skipped), then the list's own copies over them; the stale ones left out. */
  function loadSpend(): Map<string, CostRecord> {
    const records = new Map<string, CostRecord>();
    const text = db ? seam.run(() => errandEventLines(db, guildId)).join('\n') : '';
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let value: unknown = null;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      const record = costRecord(value);
      if (record) records.set(record.id, record);
    }
    for (const task of state.tasks) {
      const record = costRecord(task);
      if (record) records.set(record.id, record);
    }
    const at = now();
    for (const [id, record] of records) if (stale(record, at)) records.delete(id);
    return records;
  }

  /** `task`'s spend record updated, the stale ones dropped. */
  function noteSpend(task: ErrandRecord): void {
    const record = costRecord(task);
    if (record) spend.set(record.id, record);
    const at = now();
    for (const [id, kept] of spend) if (stale(kept, at)) spend.delete(id);
  }

  /** Whether `task` is a finished errand whose result she has not read nor closed. */
  function isUnread(task: ErrandRecord): boolean {
    return !isOpenState(task.state) && !task.readAt && !task.resolvedAt;
  }

  /** The list kept: every open task, then the finished ones, the unread first, at most KEEP_FINISHED. */
  function pruned(tasks: Array<ErrandRecord>): Array<ErrandRecord> {
    const finished = tasks.filter((task) => !isOpenState(task.state));
    if (finished.length <= KEEP_FINISHED) return tasks;
    // The unread first, then the latest to end.
    const keep = new Set(
      [...finished]
        .sort(
          (a, b) => Number(isUnread(a) === false) - Number(isUnread(b) === false) || (b.endedAt ?? 0) - (a.endedAt ?? 0)
        )
        .slice(0, KEEP_FINISHED)
    );
    return tasks.filter((task) => isOpenState(task.state) || keep.has(task));
  }

  /** The list handed to the outbox whole, and the transition of `task` as a line of errands.jsonl. */
  function persist(task: ErrandRecord | null): void {
    state.tasks = pruned(state.tasks);
    if (task) noteSpend(task);
    if (!memoryDb) return;
    if (!outbox) {
      log.warn('errands: tasks write failed', { guildId: String(guildId), code: 'DB_CLOSED' });
      return;
    }
    outbox.value(listOwner, JSON.parse(JSON.stringify({ errands: state.tasks })));
    if (task) outbox.lines(logOwner, [JSON.parse(JSON.stringify({ at: now(), ...task }))]);
    outbox.push();
  }

  /** One journal `action` line of the task's operation (features.journal exactly true, read now); never throws. */
  function journalLine(task: ErrandRecord, phase: string, extra: Record<string, unknown> = {}): void {
    if (!journal || typeof journal.action !== 'function' || config()?.features?.journal !== true) return;
    const privateUserId = task.scope === 'dm' ? (task.requester?.userId ?? null) : null;
    Promise.resolve(
      journal.action(String(guildId), {
        opId: task.opId,
        name: 'errand',
        // Her errand, whoever asked for it: the requester is in `participants`.
        by: 'persona',
        ...(privateUserId ? { privateUserId } : { channelId: task.origin?.channelId ?? null }),
        participants: task.requester?.userId ? [task.requester.userId] : [],
        sourceMessageIds: task.origin?.messageId ? [task.origin.messageId] : [],
        phase,
        ...extra,
      })
    ).catch((err: unknown) => log.warn('errands: journal failed', { id: task.id, code: errorCode(err) }));
  }

  /** The counts of a finished task for its closing journal line: never its text. */
  function journalResult(task: ErrandRecord): Record<string, unknown> {
    const result = task.result;
    const out: Record<string, unknown> = { errandId: task.id, state: task.state };
    const chars = typeof result?.text === 'string' ? result.text.length : 0;
    if (chars > 0) out.chars = chars;
    if (Array.isArray(result?.sources) && result.sources.length > 0) out.sources = result.sources.length;
    if (Array.isArray(result?.files) && result.files.length > 0) out.files = result.files.length;
    if (task.usage)
      out.usage = { usd: task.usage.usd ?? 0, steps: task.usage.steps ?? 0, seconds: task.usage.seconds ?? 0 };
    return out;
  }

  /** The out directory of `agent` (its profile's `out` under the deployment's override); null for an unknown agent. */
  function outDirOf(agent: string): string | null {
    return agentSettings(agent, config())?.out || null;
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
   * The finished tasks whose files the runner has deleted, marked `filesExpired` (and the list
   * written once when any is): a task with files whose `<out>/<id>/` is gone while `<out>` itself
   * is there (an out dir missing altogether, as on a host without the runner, expires nothing).
   */
  function expireFiles(): number {
    let changed = 0;
    for (const task of state.tasks) {
      if (isOpenState(task.state) || task.filesExpired === true) continue;
      if (!Array.isArray(task.result?.files) || task.result.files.length === 0) continue;
      const outDir = outDirOf(task.agent);
      if (!outDir || missing(outDir) || !missing(path.join(outDir, task.id))) continue;
      task.filesExpired = true;
      changed += 1;
    }
    if (changed > 0) {
      persist(null);
      log.info('errands: task files expired', { guildId: String(guildId), count: changed });
    }
    return changed;
  }

  /** The daily caps of `agent`: its profile's `daily` under the deployment's override. */
  function dailyCaps(agent: string): { tasks: number | undefined } {
    // profiles.js types a profile as `object`, so its default caps are read through objOf.
    const defaults = objOf(objOf(profileOf(agent)).defaultDaily);
    const set: Record<string, number> = agentSettings(agent, config())?.daily ?? {};
    const fallback = defaults.tasks;
    return { tasks: Number.isFinite(set.tasks) ? set.tasks : typeof fallback === 'number' ? fallback : undefined };
  }

  /**
   * The spend of every agent with a record, and of each of `agents` (src/errands/costs.ts#agentCosts):
   * per window (`today`, `last7`, `last30`) its runs, input and output tokens and dollars.
   */
  function costs(agents: Array<string> = []): AgentCosts {
    return agentCosts(spend.values(), { now: now(), agents });
  }

  /** Today's tasks and dollars of `agent`: the `today` window of `costs`. */
  function usedToday(agent: string): { tasks: number; usd: number } {
    const { today: row } = costs([agent])[agent];
    return { tasks: row.runs, usd: row.usd };
  }

  /** The cap `agent` hits now, as its refusal code, or null. */
  function capHit(agent: string): string | null {
    const set = config()?.errands?.maxOpen;
    const maxOpen = Number.isFinite(set) ? set : DEFAULT_MAX_OPEN;
    if (open().length >= maxOpen) return 'cap-open';
    const caps = dailyCaps(agent);
    const used = usedToday(agent);
    if (Number.isFinite(caps.tasks) && used.tasks >= caps.tasks) return 'cap-tasks';
    return null;
  }

  /** A fresh task id, unique in the list. */
  function freshId(): string {
    for (;;) {
      const id = `t${uuid().replace(/-/g, '').slice(0, 8)}`;
      if (!state.tasks.some((task) => task.id === id)) return id;
    }
  }

  /** The task `id` (the stored object), or null. */
  function find(id: unknown): ErrandRecord | null {
    return state.tasks.find((task) => task.id === idText(id)) ?? null;
  }

  /** A copy of a stored task, as the store hands it out (a stored record is plain JSON). */
  function copy(task: ErrandRecord): ErrandRecord {
    return JSON.parse(JSON.stringify(task)) as ErrandRecord;
  }

  /**
   * A new task, `queued`, or the cap it hits: `{ ok: true, task }` | `{ ok: false, code }`
   * (`unknown-agent`, `bad-goal`, `cap-open`, `cap-tasks`). The persona's own call
   * brings its `idempotencyKey` (her turn and the call's index in it, src/behavior/turn.js) and
   * its turn (`origin.turnId`): a task the store still holds under the same key is answered as it
   * is, `{ ok: true, task, duplicate: true }`, before any cap -- a retried call never queues a
   * second errand. The goal is kept as she wrote it (trimmed).
   */
  function add({ agent, goal, requester, origin, scope, idempotencyKey = null }: Partial<AddInput> = {}): AddResult {
    if (typeof agent !== 'string' || !profileOf(agent)) return { ok: false, code: CODE.UNKNOWN_AGENT };
    const text = String(goal ?? '').trim();
    if (!text) return { ok: false, code: CODE.BAD_GOAL };
    const key = typeof idempotencyKey === 'string' && idempotencyKey ? idempotencyKey : null;
    const same = key ? state.tasks.find((task) => task.idempotencyKey === key) : null;
    if (same) {
      log.info('errands: duplicate', { guildId: String(guildId), id: same.id, agent: same.agent });
      return { ok: true, task: copy(same), duplicate: true };
    }
    const cap = capHit(agent);
    if (cap) return { ok: false, code: cap };
    const at = now();
    const task: ErrandRecord = {
      id: freshId(),
      agent,
      goal: text,
      requester: {
        userId: requester?.userId ? String(requester.userId) : null,
        kind: requesterKindOf(requester?.kind),
      },
      origin: {
        channelId: origin?.channelId ? String(origin.channelId) : null,
        messageId: origin?.messageId ? String(origin.messageId) : null,
        // The persona's turn whose accepted call this is (none for a command).
        ...(origin?.turnId ? { turnId: String(origin.turnId) } : {}),
      },
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
    state.tasks.push(task);
    persist(task);
    journalLine(task, 'proposed', {
      input: { errandId: task.id, agent, goalChars: text.length, requester: task.requester.kind },
    });
    log.info('errands: task queued', { guildId: String(guildId), id: task.id, agent });
    return { ok: true, task: copy(task) };
  }

  /** Task `id` moved from `queued` to `running`; null when it is not queued. */
  function start(id: unknown): ErrandRecord | null {
    const task = find(id);
    if (!task || task.state !== 'queued') return null;
    task.state = 'running';
    task.startedAt = now();
    persist(task);
    journalLine(task, 'started', { target: { errandId: task.id } });
    return copy(task);
  }

  /**
   * Task `id` ended with the runner's outcome (`status` done | failed | cancelled, its result,
   * usage and error code): its dollars counted for today. Null when the task is not open (a
   * cancel came first: the late end is ignored).
   */
  function finish(id: unknown, { status, result, usage, error }: FinishOutcome = {}): ErrandRecord | null {
    const task = find(id);
    if (!task || !isOpenState(task.state)) return null;
    const at = now();
    task.state = endStateOf(status);
    task.endedAt = at;
    task.usage = normalizeUsage(usage);
    // The record keeps only the names of the files the runner held back (the persona is told).
    if (task.state === 'done' || result) {
      const { filesDropped, ...kept }: NormalizedResult = normalizeResult(result);
      const held = filesDropped ? filesDropped.map((entry) => entry.name).filter(Boolean) : [];
      task.result = held.length > 0 ? { ...kept, filesDropped: held } : kept;
    } else {
      task.result = null;
    }
    task.error =
      task.state === 'done'
        ? null
        : typeof error === 'string' && error
          ? error
          : task.state === 'cancelled'
            ? 'cancelled'
            : 'failed';
    task.seen = false;
    persist(task);
    if (task.state === 'done') journalLine(task, 'succeeded', { result: journalResult(task) });
    else journalLine(task, 'failed', { result: { ...journalResult(task), code: task.error } });
    log.info('errands: task ended', {
      guildId: String(guildId),
      id: task.id,
      agent: task.agent,
      state: task.state,
      ...(task.error ? { code: task.error } : {}),
    });
    return copy(task);
  }

  /** Task `id` cancelled when it is open (the caller tells the runner); null otherwise. */
  function cancel(id: unknown): ErrandRecord | null {
    const task = find(id);
    if (!task || !isOpenState(task.state)) return null;
    return finish(id, { status: 'cancelled', error: 'cancelled' });
  }

  /** Task `id` marked as seen by the persona; null when there is none. */
  function markSeen(id: unknown): ErrandRecord | null {
    const task = find(id);
    if (!task) return null;
    if (task.seen !== true) {
      task.seen = true;
      persist(null);
    }
    return copy(task);
  }

  /** Task `id` marked as read by the persona (its result was shown to her or returned to her); null when there is none. */
  function markRead(id: unknown): ErrandRecord | null {
    const task = find(id);
    if (!task) return null;
    if (!task.readAt) {
      task.readAt = now();
      persist(null);
    }
    return copy(task);
  }

  /** Task `id` noted as one whose result turn never completed (it stays unread); null when there is none. */
  function markResultFailed(id: unknown): ErrandRecord | null {
    const task = find(id);
    if (!task) return null;
    if (task.resultTurnFailed !== true) {
      task.resultTurnFailed = true;
      persist(null);
    }
    return copy(task);
  }

  /** Task `id` closed by the persona (read too); null when there is none or it is still open. */
  function resolve(id: unknown): ErrandRecord | null {
    const task = find(id);
    if (!task || isOpenState(task.state)) return null;
    if (!task.resolvedAt) {
      task.resolvedAt = now();
      persist(null);
    }
    return copy(task);
  }

  /**
   * Task `id` given the ledger's id of its mirror (src/errands/ledger.ts), errands.json written when
   * it changes; null when there is no such task (forgotten or wiped meanwhile) or no id.
   */
  function setLedgerId(id: unknown, ledgerId: unknown): ErrandRecord | null {
    const task = find(id);
    const value =
      typeof ledgerId === 'string' || (typeof ledgerId === 'number' && Number.isFinite(ledgerId))
        ? String(ledgerId)
        : '';
    if (!task || !value) return null;
    if (task.ledgerId !== value) {
      task.ledgerId = value;
      persist(null);
    }
    return copy(task);
  }

  /** The open errands (queued and running), oldest first. */
  function open(): Array<ErrandRecord> {
    return state.tasks.filter((task) => isOpenState(task.state)).map(copy);
  }

  /** The latest `n` errands, newest first. */
  function recent(n = 10): Array<ErrandRecord> {
    expireFiles();
    const count = Number.isInteger(n) && n > 0 ? n : 10;
    // Reversed first, so tasks of the same millisecond keep the later one first.
    return state.tasks
      .slice()
      .reverse()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, count)
      .map(copy);
  }

  /** The finished tasks the persona has not seen yet, oldest first. */
  function unseen(): Array<ErrandRecord> {
    expireFiles();
    return state.tasks.filter((task) => !isOpenState(task.state) && task.seen !== true).map(copy);
  }

  /** The finished errands whose result she has not read nor closed, oldest first (to end). */
  function unread(): Array<ErrandRecord> {
    expireFiles();
    return state.tasks
      .filter(isUnread)
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
      .map(copy);
  }

  /** Task `id`, or null. */
  function get(id: unknown): ErrandRecord | null {
    expireFiles();
    const found = find(id);
    return found ? copy(found) : null;
  }

  /**
   * The budget of `agent` for the skills gateway (src/tools/gateway.ts): `{ spent, key }`, spent
   * when a cap would refuse a new task now (`key` the setting).
   */
  function budget(agent: string): Budget {
    const code = profileOf(agent) ? capHit(agent) : CODE.UNKNOWN_AGENT;
    const key =
      code === CODE.CAP_OPEN ? 'errands.maxOpen' : code === CODE.CAP_TASKS ? `agents.${agent}.daily.tasks` : null;
    return { spent: code !== null, key, code };
  }

  /** Today's use of `agent` against its caps: `{ tasks, usd, caps }`. */
  function today(agent: string): { tasks: number; usd: number; caps: { tasks: number | undefined } } {
    return { ...usedToday(agent), caps: dailyCaps(agent) };
  }

  /**
   * The file a handle `file:<task id>/<name>` names: `{ path, name, contentType, bytes, task }`
   * when the task exists, its files have not expired and its result lists that name, the path
   * inside the agent's out directory (the agent's `out`, the profile's under the deployment's override); null otherwise.
   */
  function fileOf(handle: unknown): ErrandFileRef | null {
    const parsed = parseFileHandle(handle);
    if (!parsed) return null;
    expireFiles();
    const task = find(parsed.id);
    if (!task || task.filesExpired === true) return null;
    const file = task.result?.files?.find((entry) => entry?.name === parsed.name) ?? null;
    if (!file) return null;
    const outDir = outDirOf(task.agent);
    if (!outDir) return null;
    const base = path.resolve(outDir, task.id);
    const full = path.resolve(base, parsed.name);
    if (path.dirname(full) !== base) return null;
    return {
      path: full,
      name: parsed.name,
      contentType: file.contentType ?? '',
      bytes: file.bytes ?? 0,
      task: copy(task),
    };
  }

  /** Whether the handle names a file of a task whose files have expired (`file-expired`); false otherwise. */
  function fileExpired(handle: unknown): boolean {
    const parsed = parseFileHandle(handle);
    if (!parsed) return false;
    expireFiles();
    const task = find(parsed.id);
    return task?.filesExpired === true && Boolean(task.result?.files?.some((entry) => entry?.name === parsed.name));
  }

  /**
   * Every open task failed with `code` (a restart of the core: no runner's end can reach this
   * process for them any more). Their failures stay unseen, for the `<errands>` block. Returns how many.
   */
  function failOpen(code: string): number {
    const ids = state.tasks.filter((task) => isOpenState(task.state)).map((task) => task.id);
    for (const id of ids) finish(id, { status: 'failed', error: code });
    return ids.length;
  }

  /**
   * The writes still waiting sent again and awaited; with `final` (the shutdown) what still fails is kept in
   * `memory-pending/`. Nothing without a `memoryDb`.
   */
  async function flush({ final = false }: { final?: boolean } = {}): Promise<FlushCounts> {
    if (!outbox) return { waiting: 0, pending: 0 };
    const waiting = await outbox.flush();
    return { waiting, pending: final ? outbox.keep() : 0 };
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
    setLedgerId,
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
    flush,
    guildId: String(guildId),
  };
}

/**
 * One task store per guild, created on first use over the same live config and journal (createTaskStore).
 * `memoryDb` goes to every store; a store whose load failed is not kept, so the next `get` tries again.
 */
export function createTaskStores({
  config = () => ({}),
  journal = null,
  now = Date.now,
  log = defaultLog,
  memoryDb = null,
}: Omit<StoreOptions, 'guildId' | 'uuid'>): ErrandStores {
  const stores = new Map<string, ErrandStore>();
  const tasks: ErrandStores = {
    get(guildId: unknown): ErrandStore | null {
      const key = typeof guildId === 'string' || typeof guildId === 'number' ? String(guildId) : '';
      if (!key) return null;
      let store = stores.get(key);
      if (!store) {
        store = createTaskStore({ guildId: key, config, journal, now, log, memoryDb });
        stores.set(key, store);
      }
      return store;
    },
    /** Every store's `flush` (the writes waiting for the database; `final` at the shutdown). */
    async flush(options: { final?: boolean } = {}): Promise<FlushCounts> {
      let waiting = 0;
      let pending = 0;
      for (const store of stores.values()) {
        const done = await store.flush(options);
        waiting += done.waiting;
        pending += done.pending;
      }
      return { waiting, pending };
    },
  };
  return tasks;
}
