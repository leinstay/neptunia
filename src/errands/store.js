// The persona's errand tasks, one store per guild, in the memory database: the unit `guilds/<id>/tasks.json` holds
// the current list (the open tasks, then the finished ones she has not seen yet and the latest
// others, at most KEEP_FINISHED of them), written whole on every change; the unit `guilds/<id>/tasks.jsonl` gets one
// line per transition (the task as it stands after it), appended, never rewritten. A task moves `queued` ->
// `running` -> `done` | `failed` | `cancelled` (a queued one may also be cancelled or failed
// directly); a finished task is never reopened, and an end that arrives after a cancel is
// ignored. The caps are enforced here, on `add`, read from the live config at the moment of use:
// `agents.maxOpen` open tasks at once (`cap-open`), `agents.<profile>.daily.tasks` tasks per UTC day (`cap-tasks`; a task counts on
// the day it was queued). That daily number
// and the owner card's `costs.errands` come from one place: src/errands/costs.js#agentCosts over
// the store's spend records, one per task of the last KEEP_DAYS days (read from tasks.jsonl at
// load, then kept with every transition).
// Every transition is also an `action` line of the
// journal (src/memory/journal.js), shaped like a skill call's operation: one `opId` per task,
// `proposed` when queued, `started` when running, then one closing `succeeded` or `failed`
// (with the code), counts only -- never the goal or the result. A task's files are named to the
// persona by a handle `file:<task id>/<name>` (fileOf resolves it, only for a name the task's
// result lists, inside `agents.<profile>.out`). The runner deletes a task's directory after
// `agents.keepFilesHours` (src/agent-runner/sweep.js); a finished task whose result lists files
// is marked `filesExpired` once its directory is gone from an out dir that is still there (checked
// when the tasks are read), and its handles name nothing from then on.
// A task mirrored into the ledger (src/errands/ledger.js) carries the ledger's id as `ledgerId`
// (optional; set once the ledger answers, so the transition lines after it carry it too).
// A finished errand's result stays until she has read it: the record carries `readAt` (null until a
// turn that showed its `<task_result>` completed, or `task.read` returned it, src/tools/impl/task.ts) and
// `resolvedAt` (she closed it: `task.resolve`, or an intention that waited on it moved to done).
// `unread` lists the finished ones with neither, oldest first; `seen` only says the result turn
// ran, and hides nothing. A record from before `readAt` existed counts as read when it was `seen`.
// Logs carry ids and codes, never text.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { log as defaultLog } from '../log.js';
import { DAY_MS } from '../time.js';
import { agentCosts, costRecord, KEEP_DAYS } from './costs.js';
import { normalizeResult, normalizeUsage } from '../agent-runner/protocol.js';
import { createReadSeam } from '../memory/db/readers/common.js';
import { taskEventLines, tasksValue } from '../memory/db/readers/tasks.js';
import { createUnitOutbox } from '../memory/db/unit-outbox.js';
import { profileOf } from '../agent-runner/profiles.js';
import { CODE } from '../tools/codes.ts';

/** Every state a task may be in. */
export const TASK_STATES = Object.freeze(['queued', 'running', 'done', 'failed', 'cancelled']);
/** The states of a task still under way. */
export const OPEN_STATES = Object.freeze(['queued', 'running']);
/** Who asked for a task. */
export const REQUESTER_KINDS = Object.freeze(['owner', 'member', 'persona']);
/** `agents.maxOpen` when it is missing (config.json carries the same). */
export const DEFAULT_MAX_OPEN = 3;
/** The finished tasks tasks.json keeps besides the open ones (tasks.jsonl keeps every transition). */
export const KEEP_FINISHED = 50;
/** The prefix of a task file handle. */
export const FILE_HANDLE_PREFIX = 'file:';

const FILE_HANDLE_RE = /^file:([A-Za-z0-9_-]{1,64})\/([^/\\]{1,200})$/;

/** A file handle for `name` of task `id`. */
export function fileHandle(id, name) {
  return `${FILE_HANDLE_PREFIX}${id}/${name}`;
}

/** `{ id, name }` of a file handle, or null when it is not one. */
export function parseFileHandle(handle) {
  const match = FILE_HANDLE_RE.exec(String(handle ?? '').trim());
  if (!match || match[2] === '.' || match[2] === '..') return null;
  return { id: match[1], name: match[2] };
}

/** True for a state of a task still under way. */
export function isOpenState(state) {
  return OPEN_STATES.includes(state);
}

/**
 * @param {object} options
 * @param {string} options.guildId
 * @param {() => number} [options.now]
 * @param {() => object} [options.config]  The live config (`agents.*`, `features.journal`).
 * @param {{ action: Function }|null} [options.journal]  src/memory/journal.js#createJournal's.
 * @param {() => string} [options.uuid]
 * @param {{ info: Function, warn: Function }} [options.log]
 * @param {object|null} [options.memoryDb]  the memory database service: the list and the spend records are loaded
 *   from it (src/memory/db/readers/tasks.js; a failed read throws, with a code); each change hands the whole list
 *   (`tasks.json`, op `value`) and the transition line (`tasks.jsonl`, op `lines`) to an outbox
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
}) {
  const seam = createReadSeam({ memoryDb, log, reader: 'tasks' });
  const db = memoryDb ? seam.db() : null;
  const state = load();
  const outbox =
    db && typeof memoryDb?.writeUnit === 'function' ? createUnitOutbox({ memoryDb, log, name: 'tasks' }) : null;
  const listOwner = `guilds/${String(guildId)}/tasks.json`;
  const logOwner = `guilds/${String(guildId)}/tasks.jsonl`;
  // id -> the spend record of each task of the last KEEP_DAYS days (src/errands/costs.js#costRecord).
  const spend = loadSpend();

  /** The list read once from the database (none without a `memoryDb`). */
  function load() {
    let raw = null;
    if (db) {
      const found = seam.run(() => tasksValue(db, guildId));
      raw = found.found ? found.value : null;
    }
    const tasks = Array.isArray(raw?.tasks)
      ? raw.tasks.filter((task) => task && typeof task.id === 'string' && TASK_STATES.includes(task.state))
      : [];
    for (const task of tasks) {
      // Records from before readAt: a seen one was read, an unseen one is still unread.
      if (task.readAt === undefined) task.readAt = task.seen === true ? (task.endedAt ?? task.createdAt ?? 0) : null;
      if (task.resolvedAt === undefined) task.resolvedAt = null;
    }
    return { tasks };
  }

  /** Whether a spend record is older than the last KEEP_DAYS days (by its later time). */
  function stale(record, at = now()) {
    const last = Math.max(record.createdAt ?? -Infinity, record.endedAt ?? -Infinity);
    return last < at - KEEP_DAYS * DAY_MS;
  }

  /** The spend records read once: the last line of each task in tasks.jsonl (a line that does not
   * parse is skipped), then the list's own copies over them; the stale ones left out. */
  function loadSpend() {
    const records = new Map();
    const text = db ? seam.run(() => taskEventLines(db, guildId)).join('\n') : '';
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let value = null;
      try {
        value = JSON.parse(line);
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
  function noteSpend(task) {
    const record = costRecord(task);
    if (record) spend.set(record.id, record);
    const at = now();
    for (const [id, kept] of spend) if (stale(kept, at)) spend.delete(id);
  }

  /** Whether `task` is a finished errand whose result she has not read nor closed. */
  function isUnread(task) {
    return !isOpenState(task.state) && !task.readAt && !task.resolvedAt;
  }

  /** The list kept: every open task, then the finished ones, the unread first, at most KEEP_FINISHED. */
  function pruned(tasks) {
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

  /** The list handed to the outbox whole, and the transition of `task` as a line of tasks.jsonl. */
  function persist(task) {
    state.tasks = pruned(state.tasks);
    if (task) noteSpend(task);
    if (!memoryDb) return;
    if (!outbox) {
      log.warn('errands: tasks write failed', { guildId: String(guildId), code: 'DB_CLOSED' });
      return;
    }
    outbox.value(listOwner, JSON.parse(JSON.stringify({ tasks: state.tasks })));
    if (task) outbox.lines(logOwner, [JSON.parse(JSON.stringify({ at: now(), ...task }))]);
    outbox.push();
  }

  /** One journal `action` line of the task's operation (features.journal exactly true, read now); never throws. */
  function journalLine(task, phase, extra = {}) {
    if (!journal || typeof journal.action !== 'function' || config()?.features?.journal !== true) return;
    const privateUserId = task.scope === 'dm' ? (task.requester?.userId ?? null) : null;
    Promise.resolve(
      journal.action(String(guildId), {
        opId: task.opId,
        name: 'task',
        // Her errand, whoever asked for it: the requester is in `participants`.
        by: 'persona',
        ...(privateUserId ? { privateUserId } : { channelId: task.origin?.channelId ?? null }),
        participants: task.requester?.userId ? [task.requester.userId] : [],
        sourceMessageIds: task.origin?.messageId ? [task.origin.messageId] : [],
        phase,
        ...extra,
      })
    ).catch((err) => log.warn('errands: journal failed', { id: task.id, code: err?.code ?? null }));
  }

  /** The counts of a finished task for its closing journal line: never its text. */
  function journalResult(task) {
    const result = task.result ?? {};
    const out = { taskId: task.id, state: task.state };
    const chars = typeof result.text === 'string' ? result.text.length : 0;
    if (chars > 0) out.chars = chars;
    if (Array.isArray(result.sources) && result.sources.length > 0) out.sources = result.sources.length;
    if (Array.isArray(result.files) && result.files.length > 0) out.files = result.files.length;
    if (task.usage)
      out.usage = { usd: task.usage.usd ?? 0, steps: task.usage.steps ?? 0, seconds: task.usage.seconds ?? 0 };
    return out;
  }

  /** The live `agents` section. */
  function agentsConfig() {
    return config()?.agents ?? {};
  }

  /** The out directory of `agent`: `agents.<agent>.out`, else the profile's; null when there is none. */
  function outDirOf(agent) {
    return agentsConfig()?.[agent]?.out || profileOf(agent)?.defaultOut || null;
  }

  /** Whether `file` is missing (ENOENT); false when it is there or cannot be told. */
  function missing(file) {
    try {
      fs.statSync(file);
      return false;
    } catch (err) {
      return err?.code === 'ENOENT';
    }
  }

  /**
   * The finished tasks whose files the runner has deleted, marked `filesExpired` (and the list
   * written once when any is): a task with files whose `<out>/<id>/` is gone while `<out>` itself
   * is there (an out dir missing altogether, as on a host without the runner, expires nothing).
   */
  function expireFiles() {
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

  /** `agents.<agent>.daily` with the profile's defaults under it. */
  function dailyCaps(agent) {
    const defaults = profileOf(agent)?.defaultDaily ?? {};
    const set = agentsConfig()?.[agent]?.daily ?? {};
    return { tasks: Number.isFinite(set.tasks) ? set.tasks : defaults.tasks };
  }

  /**
   * The spend of every agent with a record, and of each of `agents` (src/errands/costs.js#agentCosts):
   * per window (`today`, `last7`, `last30`) its runs, input and output tokens and dollars.
   * @param {string[]} [agents]
   */
  function costs(agents = []) {
    return agentCosts(spend.values(), { now: now(), agents });
  }

  /** Today's tasks and dollars of `agent`: the `today` window of `costs`. */
  function usedToday(agent) {
    const { today: row } = costs([agent])[agent];
    return { tasks: row.runs, usd: row.usd };
  }

  /** The cap `agent` hits now, as its refusal code, or null. */
  function capHit(agent) {
    const maxOpen = Number.isFinite(agentsConfig().maxOpen) ? agentsConfig().maxOpen : DEFAULT_MAX_OPEN;
    if (open().length >= maxOpen) return 'cap-open';
    const caps = dailyCaps(agent);
    const used = usedToday(agent);
    if (Number.isFinite(caps.tasks) && used.tasks >= caps.tasks) return 'cap-tasks';
    return null;
  }

  /** A fresh task id, unique in the list. */
  function freshId() {
    for (;;) {
      const id = `t${uuid().replace(/-/g, '').slice(0, 8)}`;
      if (!state.tasks.some((task) => task.id === id)) return id;
    }
  }

  /** The task `id` (the stored object), or null. */
  function find(id) {
    return state.tasks.find((task) => task.id === String(id ?? '')) ?? null;
  }

  /** A copy of a stored task, as the store hands it out. */
  function copy(task) {
    return task ? JSON.parse(JSON.stringify(task)) : null;
  }

  /**
   * A new task, `queued`, or the cap it hits: `{ ok: true, task }` | `{ ok: false, code }`
   * (`unknown-agent`, `bad-goal`, `cap-open`, `cap-tasks`). The persona's own call
   * brings its `idempotencyKey` (her turn and the call's index in it, src/behavior/turn.js) and
   * its turn (`origin.turnId`): a task the store still holds under the same key is answered as it
   * is, `{ ok: true, task, duplicate: true }`, before any cap -- a retried call never queues a
   * second errand. The goal is kept as she wrote it (trimmed).
   * @param {{ agent: string, goal: string, requester: { userId: string|null, kind: string },
   *   origin: { channelId: string|null, messageId: string|null, turnId?: string|null }, scope: 'dm'|'group',
   *   idempotencyKey?: string|null }} input
   */
  function add({ agent, goal, requester, origin, scope, idempotencyKey = null } = {}) {
    if (!profileOf(agent)) return { ok: false, code: CODE.UNKNOWN_AGENT };
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
    const task = {
      id: freshId(),
      agent,
      goal: text,
      requester: {
        userId: requester?.userId ? String(requester.userId) : null,
        kind: REQUESTER_KINDS.includes(requester?.kind) ? requester.kind : 'member',
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
      input: { taskId: task.id, agent, goalChars: text.length, requester: task.requester.kind },
    });
    log.info('errands: task queued', { guildId: String(guildId), id: task.id, agent });
    return { ok: true, task: copy(task) };
  }

  /** Task `id` moved from `queued` to `running`; null when it is not queued. */
  function start(id) {
    const task = find(id);
    if (!task || task.state !== 'queued') return null;
    task.state = 'running';
    task.startedAt = now();
    persist(task);
    journalLine(task, 'started', { target: { taskId: task.id } });
    return copy(task);
  }

  /**
   * Task `id` ended with the runner's outcome (`status` done | failed | cancelled, its result,
   * usage and error code): its dollars counted for today. Null when the task is not open (a
   * cancel came first: the late end is ignored).
   */
  function finish(id, { status, result, usage, error } = {}) {
    const task = find(id);
    if (!task || !isOpenState(task.state)) return null;
    const at = now();
    task.state = ['done', 'failed', 'cancelled'].includes(status) ? status : 'failed';
    task.endedAt = at;
    task.usage = normalizeUsage(usage);
    task.result = task.state === 'done' || result ? normalizeResult(result) : null;
    // The record keeps only the names of the files the runner held back (the persona is told).
    if (task.result?.filesDropped)
      task.result.filesDropped = task.result.filesDropped.map((entry) => entry.name).filter(Boolean);
    if (task.result?.filesDropped?.length === 0) delete task.result.filesDropped;
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
  function cancel(id) {
    const task = find(id);
    if (!task || !isOpenState(task.state)) return null;
    return finish(id, { status: 'cancelled', error: 'cancelled' });
  }

  /** Task `id` marked as seen by the persona; null when there is none. */
  function markSeen(id) {
    const task = find(id);
    if (!task) return null;
    if (task.seen !== true) {
      task.seen = true;
      persist(null);
    }
    return copy(task);
  }

  /** Task `id` marked as read by the persona (its result was shown to her or returned to her); null when there is none. */
  function markRead(id) {
    const task = find(id);
    if (!task) return null;
    if (!task.readAt) {
      task.readAt = now();
      persist(null);
    }
    return copy(task);
  }

  /** Task `id` noted as one whose result turn never completed (it stays unread); null when there is none. */
  function markResultFailed(id) {
    const task = find(id);
    if (!task) return null;
    if (task.resultTurnFailed !== true) {
      task.resultTurnFailed = true;
      persist(null);
    }
    return copy(task);
  }

  /** Task `id` closed by the persona (read too); null when there is none or it is still open. */
  function resolve(id) {
    const task = find(id);
    if (!task || isOpenState(task.state)) return null;
    if (!task.resolvedAt) {
      task.resolvedAt = now();
      persist(null);
    }
    return copy(task);
  }

  /**
   * Task `id` given the ledger's id of its mirror (src/errands/ledger.js), tasks.json written when
   * it changes; null when there is no such task (forgotten or wiped meanwhile) or no id.
   */
  function setLedgerId(id, ledgerId) {
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
  function open() {
    return state.tasks.filter((task) => isOpenState(task.state)).map(copy);
  }

  /** The latest `n` errands, newest first. */
  function recent(n = 10) {
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
  function unseen() {
    expireFiles();
    return state.tasks.filter((task) => !isOpenState(task.state) && task.seen !== true).map(copy);
  }

  /** The finished errands whose result she has not read nor closed, oldest first (to end). */
  function unread() {
    expireFiles();
    return state.tasks
      .filter(isUnread)
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
      .map(copy);
  }

  /** Task `id`, or null. */
  function get(id) {
    expireFiles();
    return copy(find(id));
  }

  /**
   * The budget of `agent` for the skills gateway (src/tools/gateway.ts): `{ spent, key }`, spent
   * when a cap would refuse a new task now (`key` the setting).
   */
  function budget(agent) {
    const code = profileOf(agent) ? capHit(agent) : CODE.UNKNOWN_AGENT;
    const key = { [CODE.CAP_OPEN]: 'agents.maxOpen', [CODE.CAP_TASKS]: `agents.${agent}.daily.tasks` }[code] ?? null;
    return { spent: code !== null, key, code };
  }

  /** Today's use of `agent` against its caps: `{ tasks, usd, caps }`. */
  function today(agent) {
    return { ...usedToday(agent), caps: dailyCaps(agent) };
  }

  /**
   * The file a handle `file:<task id>/<name>` names: `{ path, name, contentType, bytes, task }`
   * when the task exists, its files have not expired and its result lists that name, the path
   * inside the agent's out directory (`agents.<agent>.out`, else the profile's); null otherwise.
   */
  function fileOf(handle) {
    const parsed = parseFileHandle(handle);
    if (!parsed) return null;
    expireFiles();
    const task = find(parsed.id);
    if (task?.filesExpired === true) return null;
    const file = task?.result?.files?.find((entry) => entry?.name === parsed.name) ?? null;
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
  function fileExpired(handle) {
    const parsed = parseFileHandle(handle);
    if (!parsed) return false;
    expireFiles();
    const task = find(parsed.id);
    return task?.filesExpired === true && Boolean(task.result?.files?.some((entry) => entry?.name === parsed.name));
  }

  /**
   * Every open task failed with `code` (a restart of the core: no runner's end can reach this
   * process for them any more). Their failures stay unseen, for the `<tasks>` block. Returns how many.
   */
  function failOpen(code) {
    const ids = state.tasks.filter((task) => isOpenState(task.state)).map((task) => task.id);
    for (const id of ids) finish(id, { status: 'failed', error: code });
    return ids.length;
  }

  /**
   * The writes still waiting sent again and awaited; with `final` (the shutdown) what still fails is kept in
   * `memory-pending/`. Nothing without a `memoryDb`.
   * @returns {Promise<{ waiting: number, pending: number }>}
   */
  async function flush({ final = false } = {}) {
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
 * @param {{ config?: () => object, journal?: object|null, now?: () => number, log?: object, memoryDb?: object|null }} options
 * @returns {{ get(guildId: string): ReturnType<typeof createTaskStore>,
 *   flush(options?: { final?: boolean }): Promise<{ waiting: number, pending: number }> }}
 */
export function createTaskStores({
  config = () => ({}),
  journal = null,
  now = Date.now,
  log = defaultLog,
  memoryDb = null,
}) {
  const stores = new Map();
  const tasks = {
    get(guildId) {
      const key = String(guildId ?? '');
      if (!key) return null;
      if (!stores.has(key)) stores.set(key, createTaskStore({ guildId: key, config, journal, now, log, memoryDb }));
      return stores.get(key);
    },
    /** Every store's `flush` (the writes waiting for the database; `final` at the shutdown). */
    async flush(options = {}) {
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
