// The persona's errand tasks on disk, one store per guild: `data/guilds/<id>/tasks.json` holds
// the current list (the open tasks, then the finished ones she has not seen yet and the latest
// others, at most KEEP_FINISHED of them) with the day's counters, written whole through
// writeJsonAtomic on every change; `data/guilds/<id>/tasks.jsonl` gets one line per transition
// (the task as it stands after it), appended, never rewritten. A task moves `queued` ->
// `running` -> `done` | `failed` | `cancelled` (a queued one may also be cancelled or failed
// directly); a finished task is never reopened, and an end that arrives after a cancel is
// ignored. The caps are enforced here, on `add`, read from the live config at the moment of use:
// `agents.maxOpen` open tasks at once (`cap-open`), `agents.<profile>.daily.tasks` tasks and
// `agents.<profile>.daily.usd` dollars per UTC day (`cap-tasks`, `cap-usd`; the dollars are
// counted when a task ends, from its usage). Every transition is also an `action` line of the
// journal (src/memory/journal.js), shaped like a skill call's operation: one `opId` per task,
// `proposed` when queued, `started` when running, then one closing `succeeded` or `failed`
// (with the code), counts only -- never the goal or the result. A task's files are named to the
// persona by a handle `file:<task id>/<name>` (fileOf resolves it, only for a name the task's
// result lists, inside `agents.<profile>.out`). Logs carry ids and codes, never text.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { log as defaultLog } from '../log.js';
import { writeJsonAtomic } from '../memory/store.js';
import { countToday, bumpDaily } from '../time.js';
import { normalizeResult, normalizeUsage } from '../agent-runner/protocol.js';
import { profileOf } from '../agent-runner/profiles.js';

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
 * @param {string} options.dataDir  The `data/` directory.
 * @param {string} options.guildId
 * @param {() => number} [options.now]
 * @param {() => object} [options.config]  The live config (`agents.*`, `features.journal`).
 * @param {{ action: Function }|null} [options.journal]  src/memory/journal.js#createJournal's.
 * @param {() => string} [options.uuid]
 * @param {{ info: Function, warn: Function }} [options.log]
 */
export function createTaskStore({ dataDir, guildId, now = Date.now, config = () => ({}), journal = null, uuid = randomUUID, log = defaultLog }) {
  const dir = path.join(dataDir, 'guilds', String(guildId));
  const listFile = path.join(dir, 'tasks.json');
  const logFile = path.join(dir, 'tasks.jsonl');
  const state = load();

  /** tasks.json read once: its list and counters; a missing or broken file starts empty (a broken one logged). */
  function load() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(listFile, 'utf8'));
    } catch (err) {
      if (err?.code !== 'ENOENT') log.warn('errands: tasks file unreadable, starting empty', { guildId: String(guildId), code: err?.code ?? 'parse' });
    }
    const tasks = Array.isArray(raw?.tasks) ? raw.tasks.filter((task) => task && typeof task.id === 'string' && TASK_STATES.includes(task.state)) : [];
    const daily = raw?.daily && typeof raw.daily === 'object' && !Array.isArray(raw.daily) ? raw.daily : {};
    return { tasks, daily };
  }

  /** The list kept: every open task, then the finished ones, the unseen first, at most KEEP_FINISHED. */
  function pruned(tasks) {
    const finished = tasks.filter((task) => !isOpenState(task.state));
    if (finished.length <= KEEP_FINISHED) return tasks;
    // The unseen first, then the latest to end.
    const keep = new Set([...finished]
      .sort((a, b) => Number(a.seen === true) - Number(b.seen === true) || (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .slice(0, KEEP_FINISHED));
    return tasks.filter((task) => isOpenState(task.state) || keep.has(task));
  }

  /** tasks.json written whole, and the transition of `task` appended to tasks.jsonl. */
  function persist(task) {
    state.tasks = pruned(state.tasks);
    try {
      writeJsonAtomic(listFile, { tasks: state.tasks, daily: state.daily });
    } catch (err) {
      log.warn('errands: tasks write failed', { guildId: String(guildId), code: err?.code ?? null });
    }
    if (!task) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(logFile, `${JSON.stringify({ at: now(), ...task })}\n`);
    } catch (err) {
      log.warn('errands: tasks append failed', { guildId: String(guildId), code: err?.code ?? null });
    }
  }

  /** One journal `action` line of the task's operation (features.journal exactly true, read now); never throws. */
  function journalLine(task, phase, extra = {}) {
    if (!journal || typeof journal.action !== 'function' || config()?.features?.journal !== true) return;
    const privateUserId = task.scope === 'dm' ? (task.requester?.userId ?? null) : null;
    Promise.resolve(journal.action(String(guildId), {
      opId: task.opId,
      name: 'task',
      // Her errand, whoever asked for it: the requester is in `participants`.
      by: 'persona',
      ...(privateUserId ? { privateUserId } : { channelId: task.origin?.channelId ?? null }),
      participants: task.requester?.userId ? [task.requester.userId] : [],
      sourceMessageIds: task.origin?.messageId ? [task.origin.messageId] : [],
      phase,
      ...extra,
    })).catch((err) => log.warn('errands: journal failed', { id: task.id, code: err?.code ?? null }));
  }

  /** The counts of a finished task for its closing journal line: never its text. */
  function journalResult(task) {
    const result = task.result ?? {};
    const out = { taskId: task.id, state: task.state };
    const chars = typeof result.text === 'string' ? result.text.length : 0;
    if (chars > 0) out.chars = chars;
    if (Array.isArray(result.sources) && result.sources.length > 0) out.sources = result.sources.length;
    if (Array.isArray(result.files) && result.files.length > 0) out.files = result.files.length;
    if (task.usage) out.usage = { usd: task.usage.usd ?? 0, steps: task.usage.steps ?? 0, seconds: task.usage.seconds ?? 0 };
    return out;
  }

  /** The live `agents` section. */
  function agentsConfig() {
    return config()?.agents ?? {};
  }

  /** `agents.<agent>.daily` with the profile's defaults under it. */
  function dailyCaps(agent) {
    const defaults = profileOf(agent)?.defaultDaily ?? {};
    const set = agentsConfig()?.[agent]?.daily ?? {};
    return { tasks: Number.isFinite(set.tasks) ? set.tasks : defaults.tasks, usd: Number.isFinite(set.usd) ? set.usd : defaults.usd };
  }

  const tasksKeys = (agent) => ({ dayKey: `${agent}Day`, countKey: `${agent}Tasks` });
  const usdKeys = (agent) => ({ dayKey: `${agent}UsdDay`, countKey: `${agent}Usd` });

  /** Today's tasks and dollars of `agent`. */
  function usedToday(agent) {
    const at = now();
    return { tasks: countToday(state.daily, tasksKeys(agent), at), usd: countToday(state.daily, usdKeys(agent), at) };
  }

  /** The cap `agent` hits now, as its refusal code, or null. */
  function capHit(agent) {
    const maxOpen = Number.isFinite(agentsConfig().maxOpen) ? agentsConfig().maxOpen : DEFAULT_MAX_OPEN;
    if (open().length >= maxOpen) return 'cap-open';
    const caps = dailyCaps(agent);
    const used = usedToday(agent);
    if (Number.isFinite(caps.tasks) && used.tasks >= caps.tasks) return 'cap-tasks';
    if (Number.isFinite(caps.usd) && used.usd >= caps.usd) return 'cap-usd';
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
   * (`unknown-agent`, `bad-goal`, `cap-open`, `cap-tasks`, `cap-usd`).
   * @param {{ agent: string, goal: string, requester: { userId: string|null, kind: string },
   *   origin: { channelId: string|null, messageId: string|null }, scope: 'dm'|'group' }} input
   */
  function add({ agent, goal, requester, origin, scope } = {}) {
    if (!profileOf(agent)) return { ok: false, code: 'unknown-agent' };
    const text = String(goal ?? '').trim();
    if (!text) return { ok: false, code: 'bad-goal' };
    const cap = capHit(agent);
    if (cap) return { ok: false, code: cap };
    const at = now();
    const task = {
      id: freshId(),
      agent,
      goal: text,
      requester: { userId: requester?.userId ? String(requester.userId) : null, kind: REQUESTER_KINDS.includes(requester?.kind) ? requester.kind : 'member' },
      origin: { channelId: origin?.channelId ? String(origin.channelId) : null, messageId: origin?.messageId ? String(origin.messageId) : null },
      scope: scope === 'dm' ? 'dm' : 'group',
      state: 'queued',
      createdAt: at,
      startedAt: null,
      endedAt: null,
      usage: null,
      result: null,
      error: null,
      seen: false,
      opId: `op-${uuid()}`,
    };
    bumpDaily(state.daily, tasksKeys(agent), at);
    state.tasks.push(task);
    persist(task);
    journalLine(task, 'proposed', { input: { taskId: task.id, agent, goalChars: text.length, requester: task.requester.kind } });
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
    task.error = task.state === 'done' ? null : (typeof error === 'string' && error ? error : task.state === 'cancelled' ? 'cancelled' : 'failed');
    task.seen = false;
    if (task.usage.usd > 0) bumpDaily(state.daily, usdKeys(task.agent), at, task.usage.usd);
    persist(task);
    if (task.state === 'done') journalLine(task, 'succeeded', { result: journalResult(task) });
    else journalLine(task, 'failed', { result: { ...journalResult(task), code: task.error } });
    log.info('errands: task ended', { guildId: String(guildId), id: task.id, agent: task.agent, state: task.state, ...(task.error ? { code: task.error } : {}) });
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

  /** The open tasks (queued and running), oldest first. */
  function open() {
    return state.tasks.filter((task) => isOpenState(task.state)).map(copy);
  }

  /** The latest `n` tasks, newest first. */
  function recent(n = 10) {
    const count = Number.isInteger(n) && n > 0 ? n : 10;
    return [...state.tasks].sort((a, b) => b.createdAt - a.createdAt).slice(0, count).map(copy);
  }

  /** The finished tasks the persona has not seen yet, oldest first. */
  function unseen() {
    return state.tasks.filter((task) => !isOpenState(task.state) && task.seen !== true).map(copy);
  }

  /** Task `id`, or null. */
  function get(id) {
    return copy(find(id));
  }

  /**
   * The budget of `agent` for the skills gateway (src/skills/gateway.js): `{ spent, key }`, spent
   * when a cap would refuse a new task now (`key` the setting).
   */
  function budget(agent) {
    const code = profileOf(agent) ? capHit(agent) : 'unknown-agent';
    const key = { 'cap-open': 'agents.maxOpen', 'cap-tasks': `agents.${agent}.daily.tasks`, 'cap-usd': `agents.${agent}.daily.usd` }[code] ?? null;
    return { spent: code !== null, key, code };
  }

  /** Today's use of `agent` against its caps: `{ tasks, usd, caps }`. */
  function today(agent) {
    return { ...usedToday(agent), caps: dailyCaps(agent) };
  }

  /**
   * The file a handle `file:<task id>/<name>` names: `{ path, name, contentType, bytes, task }`
   * when the task exists and its result lists that name, the path inside the agent's out
   * directory (`agents.<agent>.out`, else the profile's); null otherwise.
   */
  function fileOf(handle) {
    const parsed = parseFileHandle(handle);
    if (!parsed) return null;
    const task = find(parsed.id);
    const file = task?.result?.files?.find((entry) => entry?.name === parsed.name) ?? null;
    if (!file) return null;
    const outDir = agentsConfig()?.[task.agent]?.out || profileOf(task.agent)?.defaultOut;
    if (!outDir) return null;
    const base = path.resolve(outDir, task.id);
    const full = path.resolve(base, parsed.name);
    if (path.dirname(full) !== base) return null;
    return { path: full, name: parsed.name, contentType: file.contentType ?? '', bytes: file.bytes ?? 0, task: copy(task) };
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

  return { add, start, finish, cancel, markSeen, open, recent, unseen, get, budget, today, fileOf, failOpen, guildId: String(guildId) };
}
