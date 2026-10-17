// The persona's errands mirrored into the ledger (the task service of the development side, its
// `core` principal's Unix socket, `agents.ledger.socket`): every errand of the core's store
// (src/errands/store.js) becomes a task of the `errand` lane there, with the same transitions,
// one attempt per run and its results, so the errands show beside the development tasks. The
// mirror is only a copy in this stage: the core's store stays the system of record, the turn
// logic reads it alone, and a ledger that refuses or does not answer never touches an errand.
//
// The wire: newline-delimited JSON over one Unix-socket connection, a request
// `{ id, op, args, idempotency }` answered `{ id, ok, result | error }`. Calls go out one at a
// time, in the order they were made (a later call needs the ledger id an earlier one returned:
// the task's for every call after `task.add`, the attempt's for `attempt.end`); each carries the
// idempotency key `errand:<core id>:<op>` (the op suffixed where one task makes it more than
// once: `task.transition:<to>`, `task.result:summary`, `task.result:file:<name>`,
// `task.heartbeat:<minute>`), so a replay after a lost answer or a restart never doubles a row.
// Undelivered calls wait in memory (at most MAX_QUEUE; one more is dropped and logged) while the
// connection is reopened with a growing backoff, and are replayed in order once it answers; a call
// the ledger refuses is logged with its code and dropped; the calls after it are still sent (a
// later one may pass), and only the first refused or dropped call of a task is logged. A call
// whose ledger id never came (its `task.add` refused) is dropped too. A queued errand goes
// `proposed -> triaged -> approved` (the ledger's machine has no shorter way). A refused or unreachable socket is logged at most once per
// UNAVAILABLE_LOG_MS. With `agents.ledger.socket` null (config.json's default) the mirror is
// disabled: nothing is queued, nothing connects. The socket path is read at the moment of use.
// Logs carry the core id, the op and codes, never a goal, a result or a member's id.

import net from 'node:net';
import { log as defaultLog } from '../log.js';
import { clampChars } from '../memory/clamp.js';
import { DEFAULT_RESULT_MAX_CHARS } from './blocks.js';
import { fileHandle } from './store.js';

/** The ledger lane of the persona's errands. */
export const LEDGER_LANE = 'errand';
/** The most calls kept while the ledger does not answer. */
export const MAX_QUEUE = 200;
/** A ledger task's title: the goal cut to this many characters. */
export const TITLE_CHARS = 120;
/** At most one `task.heartbeat` per task in this window (ms). */
export const HEARTBEAT_MS = 60_000;
/** At most one `errands: ledger unavailable` line in this window (ms). */
export const UNAVAILABLE_LOG_MS = 60_000;
/** Added to a task's `limits.seconds` for its claim's lease (s). */
export const LEASE_GRACE_SECONDS = 60;
/** The first reconnect delay and its ceiling (ms); the delay doubles after each failure. */
export const RECONNECT_MIN_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;
/** How long one call waits for its answer before the connection is dropped and the call replayed (ms). */
export const REPLY_TIMEOUT_MS = 10_000;
/** The time cap of a task without `limits.seconds` (s), as the errand client waits for it. */
const DEFAULT_TASK_SECONDS = 600;
/** The ledger's principal the core is. */
const PRINCIPAL = 'core';

/** The idempotency key of `op` for the errand `coreId`. */
export function idempotencyKey(coreId, op) {
  return `errand:${coreId}:${op}`;
}

/** The lease of a claim (s): the task's `limits.seconds` (else the client's default) plus LEASE_GRACE_SECONDS. */
export function leaseSeconds(limits) {
  const seconds = Number.isFinite(limits?.seconds) && limits.seconds > 0 ? limits.seconds : DEFAULT_TASK_SECONDS;
  return Math.ceil(seconds) + LEASE_GRACE_SECONDS;
}

/**
 * The args of `task.add` for a queued errand: the `errand` lane, no project, the goal as the
 * description and (cut to TITLE_CHARS) the title, the asker as `persona:<userId>` (`persona:self`
 * for her own errand), the agent as the role, the conversation as the subscriber
 * (`core:<guildId>:<channelId>`), and `{ coreId, scope, agent }` as metadata (with `adult: true`
 * for an adult errand).
 */
export function addArgs(task, guildId) {
  const channel = task.origin?.channelId ?? null;
  return {
    lane: LEDGER_LANE,
    project: null,
    title: clampChars(String(task.goal ?? '').replace(/\s+/g, ' ').trim(), TITLE_CHARS),
    description: String(task.goal ?? ''),
    requester: `persona:${task.requester?.userId ?? 'self'}`,
    role: task.agent,
    subscriber: channel ? `core:${guildId}:${channel}` : `core:${guildId}`,
    metadata: { coreId: task.id, scope: task.scope, agent: task.agent, ...(task.adult === true ? { adult: true } : {}) },
  };
}

/** The args of `task.transition` of ledger task `ledgerId` to `to` (with `close_reason` when given). */
export function transitionArgs(ledgerId, to, closeReason = null) {
  return closeReason ? { id: ledgerId, to, close_reason: closeReason } : { id: ledgerId, to };
}

/**
 * The args of the triage of ledger task `ledgerId` (`task.transition` to `triaged`, the triage
 * fields set in the same call): the agent as the role, `limits.usd` as `budget_usd`,
 * `limits.steps` as `step_cap`, `limits.seconds` (else the client's default) in whole minutes as
 * `estimate_minutes`. A limit that is not a positive number is left out.
 */
export function triageArgs(ledgerId, task, limits) {
  const set = { role: task.agent };
  if (Number.isFinite(limits?.usd) && limits.usd > 0) set.budget_usd = limits.usd;
  if (Number.isFinite(limits?.steps) && limits.steps > 0) set.step_cap = Math.floor(limits.steps);
  const seconds = Number.isFinite(limits?.seconds) && limits.seconds > 0 ? limits.seconds : DEFAULT_TASK_SECONDS;
  set.estimate_minutes = Math.ceil(seconds / 60);
  return { id: ledgerId, to: 'triaged', set };
}

/** The args of `task.claim` of ledger task `ledgerId` with the lease of `limits`. */
export function claimArgs(ledgerId, limits) {
  return { id: ledgerId, lease_seconds: leaseSeconds(limits) };
}

/** The args of `task.heartbeat` of ledger task `ledgerId` (the lease renewed). */
export function heartbeatArgs(ledgerId, lease) {
  return { id: ledgerId, lease_seconds: lease };
}

/** The args of `attempt.start` on ledger task `ledgerId`: principal `core`, the agent as the role, its model, no worktree. */
export function attemptStartArgs(ledgerId, task, model) {
  return { task_id: ledgerId, principal: PRINCIPAL, role: task.agent, model: typeof model === 'string' && model ? model : null, worktree: null };
}

/** The args of `attempt.end` of attempt `attemptId`: the steps and dollars of the runner's usage, the outcome. */
export function attemptEndArgs(attemptId, task, outcome = task.state) {
  return { id: attemptId, outcome, steps: Number(task.usage?.steps) || 0, cost_usd: Number(task.usage?.usd) || 0 };
}

/**
 * The `task.result` calls of a finished errand, as `[{ op, args }]` (`op` the idempotency
 * suffix): one `summary` with the result's text cut to `maxChars` (the `withheld` paths as its
 * metadata; left out when there is neither), then one `file` per output file, its handle as the
 * `uri`. [] without a result.
 */
export function resultCalls(ledgerId, task, maxChars = DEFAULT_RESULT_MAX_CHARS) {
  const result = task.result;
  if (!result) return [];
  const calls = [];
  const text = clampChars(typeof result.text === 'string' ? result.text : '', maxChars);
  const withheld = Array.isArray(result.withheld) ? result.withheld : [];
  if (text || withheld.length > 0) {
    calls.push({ op: 'task.result:summary', args: { task_id: ledgerId, kind: 'summary', text, ...(withheld.length > 0 ? { metadata: { withheld } } : {}) } });
  }
  for (const file of Array.isArray(result.files) ? result.files : []) {
    if (!file?.name) continue;
    calls.push({
      op: `task.result:file:${file.name}`,
      args: { task_id: ledgerId, kind: 'file', uri: fileHandle(task.id, file.name), metadata: { name: file.name, contentType: file.contentType ?? '', bytes: file.bytes ?? 0 } },
    });
  }
  return calls;
}

/** The ledger id a result names (`id`, or the nested `task` / `attempt` one), as a string; null otherwise. */
function idOf(result, nested) {
  const value = result?.id ?? result?.[nested]?.id ?? null;
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? String(value) : null;
}

/** The code of a ledger error (a string, or an object's `code`). */
function codeOf(error) {
  if (typeof error === 'string' && error) return error;
  if (typeof error?.code === 'string' && error.code) return error.code;
  return 'refused';
}

/**
 * @param {object} options
 * @param {string|null|(() => string|null)} options.socketPath  The ledger socket, or a function
 *   read at the moment of use (`agents.ledger.socket`); null disables the mirror.
 * @param {{ info: Function, warn: Function }} [options.log]
 * @param {() => number} [options.now]
 * @param {(path: string) => import('node:net').Socket} [options.connect]
 * @param {number} [options.reconnectMinMs]
 * @param {number} [options.reconnectMaxMs]
 * @param {number} [options.replyTimeoutMs]
 */
export function createLedgerMirror({
  socketPath = null,
  log = defaultLog,
  now = Date.now,
  connect = (where) => net.createConnection(where),
  reconnectMinMs = RECONNECT_MIN_MS,
  reconnectMaxMs = RECONNECT_MAX_MS,
  replyTimeoutMs = REPLY_TIMEOUT_MS,
} = {}) {
  // core id -> { ledgerId, attemptId, attempted, lease, lastBeat, warned }
  const records = new Map();
  // [{ coreId, op, method, build(record) -> args|null, onResult?(result, record), final? }]
  const queue = [];
  const waiters = [];
  let link = null; // { socket, path, open, buffer }
  let inFlight = null; // { id, timer }
  let backoffMs = reconnectMinMs;
  let reconnectTimer = null;
  let lastUnavailableAt = -Infinity;
  let lastFullAt = -Infinity;
  let nextId = 1;
  let closed = false;

  /** The socket path now, or null (disabled). */
  function pathNow() {
    const value = typeof socketPath === 'function' ? socketPath() : socketPath;
    return typeof value === 'string' && value ? value : null;
  }

  /** The record of `task`, created on first use (its stored `ledgerId` taken over). */
  function recordOf(task) {
    let record = records.get(task.id);
    if (!record) {
      record = { ledgerId: task.ledgerId ? String(task.ledgerId) : null, attemptId: null, attempted: false, lease: null, lastBeat: -Infinity, warned: false };
      records.set(task.id, record);
    } else if (!record.ledgerId && task.ledgerId) {
      record.ledgerId = String(task.ledgerId);
    }
    return record;
  }

  /** `errands: ledger unavailable`, at most once per UNAVAILABLE_LOG_MS. */
  function unavailable(code) {
    const at = now();
    if (at - lastUnavailableAt < UNAVAILABLE_LOG_MS) return;
    lastUnavailableAt = at;
    log.warn('errands: ledger unavailable', { code: code ?? null, queued: queue.length });
  }

  /**
   * A refused or skipped call of a task logged, once per task: the calls after a refused one
   * (a later transition, the claim, the attempt) are still sent, and their own refusals, which
   * follow from the first, are not logged again.
   */
  function warnOnce(entry, msg, code) {
    const record = records.get(entry.coreId);
    if (record) {
      if (record.warned) return;
      record.warned = true;
    }
    log.warn(msg, { id: entry.coreId, op: entry.op, code });
  }

  /** The waiters of idle() resolved once nothing is queued or in flight. */
  function settle() {
    if (queue.length > 0 || inFlight) return;
    for (const resolve of waiters.splice(0)) resolve();
  }

  /** One call queued (false when disabled or the queue is full). */
  function enqueue(entry) {
    if (closed || !pathNow()) return false;
    if (queue.length >= MAX_QUEUE) {
      const at = now();
      if (at - lastFullAt >= UNAVAILABLE_LOG_MS) {
        lastFullAt = at;
        log.warn('errands: ledger queue full', { id: entry.coreId, op: entry.op, queued: queue.length });
      }
      return false;
    }
    queue.push(entry);
    pump();
    return true;
  }

  /** The link torn down; the call in flight (if any) stays at the head of the queue. */
  function drop() {
    if (inFlight) {
      clearTimeout(inFlight.timer);
      inFlight = null;
    }
    const current = link;
    link = null;
    if (current?.socket && !current.socket.destroyed) current.socket.destroy();
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer || queue.length === 0) return;
    const wait = backoffMs;
    backoffMs = Math.min(reconnectMaxMs, backoffMs * 2);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      pump();
    }, wait);
    reconnectTimer.unref?.();
  }

  /** A connection to `where` opened; pump() goes on once it is up. */
  function open(where) {
    const current = { socket: null, path: where, open: false, buffer: '' };
    link = current;
    let socket;
    try {
      socket = connect(where);
    } catch (err) {
      link = null;
      unavailable(err?.code ?? 'connect');
      scheduleReconnect();
      return;
    }
    current.socket = socket;
    socket.setEncoding?.('utf8');
    socket.once('connect', () => {
      if (link !== current) return;
      current.open = true;
      backoffMs = reconnectMinMs;
      log.info('errands: ledger connected', { queued: queue.length });
      pump();
    });
    socket.on('data', (chunk) => {
      if (link !== current) return;
      current.buffer += chunk;
      let nl;
      while ((nl = current.buffer.indexOf('\n')) !== -1) {
        const line = current.buffer.slice(0, nl);
        current.buffer = current.buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let reply;
        try {
          reply = JSON.parse(line);
        } catch {
          log.warn('errands: ledger bad line', {});
          continue;
        }
        onReply(reply);
      }
    });
    socket.on('error', (err) => {
      if (link === current) unavailable(err?.code ?? 'error');
    });
    socket.on('close', () => {
      if (link !== current) return;
      if (current.open) unavailable('disconnected');
      drop();
      scheduleReconnect();
    });
  }

  /** One answer of the ledger: the head call done (its result taken, or its refusal logged and dropped). */
  function onReply(reply) {
    if (!inFlight || reply?.id !== inFlight.id) return;
    clearTimeout(inFlight.timer);
    inFlight = null;
    const entry = queue.shift();
    if (reply.ok === true) {
      try {
        entry.onResult?.(reply.result, records.get(entry.coreId) ?? null);
      } catch (err) {
        log.warn('errands: ledger result failed', { id: entry.coreId, op: entry.op, error: err });
      }
    } else {
      warnOnce(entry, 'errands: ledger refused', codeOf(reply.error));
    }
    if (entry.final) records.delete(entry.coreId);
    pump();
  }

  /** The head call sent when the link is up; the link opened when it is not. */
  function pump() {
    if (closed || inFlight) return;
    const where = pathNow();
    if (!where) {
      queue.length = 0;
      drop();
      settle();
      return;
    }
    if (queue.length === 0) {
      settle();
      return;
    }
    if (link && link.path !== where) drop();
    if (!link) {
      if (!reconnectTimer) open(where);
      return;
    }
    if (!link.open) return;
    const entry = queue[0];
    const record = records.get(entry.coreId) ?? null;
    let args = null;
    try {
      args = record ? entry.build(record) : null;
    } catch {
      args = null;
    }
    if (!args) {
      queue.shift();
      warnOnce(entry, 'errands: ledger call skipped', 'no-ledger-id');
      if (entry.final) records.delete(entry.coreId);
      pump();
      return;
    }
    const id = nextId;
    nextId += 1;
    const timer = setTimeout(() => {
      if (inFlight?.id !== id) return;
      unavailable('timeout');
      drop();
      scheduleReconnect();
    }, replyTimeoutMs);
    timer.unref?.();
    inFlight = { id, timer };
    try {
      link.socket.write(`${JSON.stringify({ id, op: entry.method, args, idempotency: idempotencyKey(entry.coreId, entry.op) })}\n`);
    } catch (err) {
      unavailable(err?.code ?? 'write');
      drop();
      scheduleReconnect();
    }
  }

  /** A call that needs the task's ledger id (`final`: the record forgotten once it is answered or skipped). */
  function call(task, op, method, build, onResult, final = false) {
    return enqueue({ coreId: task.id, op, method, build: (record) => (record.ledgerId ? build(record) : null), onResult, final });
  }

  /** The `task.transition` of `task` to its final state, the record forgotten once it is through or refused. */
  function closeTask(task, to, closeReason) {
    call(task, `task.transition:${to}`, 'task.transition', (record) => transitionArgs(record.ledgerId, to, closeReason), null, true);
  }

  /** The attempt of `task` ended with `outcome`, when this process started one. */
  function endAttempt(task, record, outcome) {
    if (!record.attempted) return;
    record.attempted = false;
    enqueue({ coreId: task.id, op: 'attempt.end', method: 'attempt.end', build: (r) => (r.attemptId ? attemptEndArgs(r.attemptId, task, outcome) : null) });
  }

  /** Whether the mirror is on now (`agents.ledger.socket` set). */
  function enabled() {
    return !closed && pathNow() !== null;
  }

  /**
   * A queued errand mirrored: `task.add` (its ledger id handed to `onLedgerId`), then
   * `task.transition` to `triaged` (the triage fields from `limits`, triageArgs), then to
   * `approved` (the ledger's machine has no `proposed -> approved`). Nothing for a task that
   * already has its ledger id.
   * @param {object} task  The store's task.
   * @param {{ guildId: string, limits?: object, onLedgerId?: (ledgerId: string) => void }} options
   */
  function add(task, { guildId, limits = {}, onLedgerId = null } = {}) {
    if (!enabled() || !task?.id) return false;
    const record = recordOf(task);
    if (record.ledgerId) return false;
    const args = addArgs(task, guildId);
    enqueue({
      coreId: task.id,
      op: 'task.add',
      method: 'task.add',
      build: () => args,
      onResult: (result, current) => {
        const ledgerId = idOf(result, 'task');
        if (!ledgerId || !current) return;
        current.ledgerId = ledgerId;
        if (typeof onLedgerId === 'function') onLedgerId(ledgerId);
      },
    });
    call(task, 'task.transition:triaged', 'task.transition', (r) => triageArgs(r.ledgerId, task, limits));
    call(task, 'task.transition:approved', 'task.transition', (r) => transitionArgs(r.ledgerId, 'approved'));
    return true;
  }

  /**
   * The runner took `task`: `task.claim` with its lease, then `attempt.start`.
   * @param {object} task
   * @param {{ limits?: object, model?: string|null }} options
   */
  function start(task, { limits = {}, model = null } = {}) {
    if (!enabled() || !task?.id) return false;
    const record = recordOf(task);
    record.attempted = true;
    record.lease = leaseSeconds(limits);
    record.lastBeat = now();
    call(task, 'task.claim', 'task.claim', (r) => claimArgs(r.ledgerId, limits));
    call(task, 'attempt.start', 'attempt.start', (r) => attemptStartArgs(r.ledgerId, task, model), (result, current) => {
      const attemptId = idOf(result, 'attempt');
      if (attemptId && current) current.attemptId = attemptId;
    });
    return true;
  }

  /** A `progress` of the runner for `task`: `task.heartbeat`, at most once per HEARTBEAT_MS. */
  function progress(task) {
    if (!enabled() || !task?.id) return false;
    const record = records.get(task.id);
    if (!record?.attempted) return false;
    const at = now();
    if (at - record.lastBeat < HEARTBEAT_MS) return false;
    record.lastBeat = at;
    const lease = record.lease;
    return call(task, `task.heartbeat:${Math.floor(at / HEARTBEAT_MS)}`, 'task.heartbeat', (r) => heartbeatArgs(r.ledgerId, lease));
  }

  /**
   * `task` ended (done, failed, or cancelled by its runner): `attempt.end` when this process
   * started one, its `task.result` calls (the summary cut to `maxChars`, the files), then
   * `task.transition` to its state (`close_reason` its error code unless done).
   * @param {object} task
   * @param {{ maxChars?: number }} [options]
   */
  function finish(task, { maxChars = DEFAULT_RESULT_MAX_CHARS } = {}) {
    if (!enabled() || !task?.id) return false;
    const record = recordOf(task);
    endAttempt(task, record, task.state);
    for (const { op, args } of resultCalls('', task, maxChars)) {
      call(task, op, 'task.result', (r) => ({ ...args, task_id: r.ledgerId }));
    }
    closeTask(task, task.state, task.state === 'done' ? null : (task.error ?? task.state));
    return true;
  }

  /**
   * `task` cancelled in the core (`by`: who cancelled it): its attempt ended `cancelled` when this
   * process started one, then `task.transition` to `cancelled` (`close_reason: cancelled-by-<by>`).
   */
  function cancel(task, { by = 'unknown' } = {}) {
    if (!enabled() || !task?.id) return false;
    const record = recordOf(task);
    endAttempt(task, record, 'cancelled');
    closeTask(task, 'cancelled', `cancelled-by-${by}`);
    return true;
  }

  /**
   * The open errands a restart found without a ledger id, mirrored (`task.add` with the same
   * idempotency key, so one half delivered before the restart is not doubled). Returns how many.
   * @param {object[]} tasks
   * @param {{ guildId: string, limitsOf?: (task: object) => object, onLedgerId?: (task: object, ledgerId: string) => void }} options
   */
  function mirrorOpen(tasks, { guildId, limitsOf = null, onLedgerId = null } = {}) {
    if (!enabled()) return 0;
    let count = 0;
    for (const task of Array.isArray(tasks) ? tasks : []) {
      if (!task?.id || task.ledgerId || !['queued', 'running'].includes(task.state)) continue;
      const limits = typeof limitsOf === 'function' ? limitsOf(task) ?? {} : {};
      if (add(task, { guildId, limits, onLedgerId: onLedgerId ? (ledgerId) => onLedgerId(task, ledgerId) : null })) count += 1;
    }
    return count;
  }

  /** Resolves once nothing is queued or in flight (tests, the shutdown). */
  function idle() {
    if (queue.length === 0 && !inFlight) return Promise.resolve();
    return new Promise((resolve) => waiters.push(resolve));
  }

  /** The connection closed and the reconnects stopped; what is queued is lost. */
  function shutdown() {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    drop();
    queue.length = 0;
    for (const resolve of waiters.splice(0)) resolve();
  }

  return { enabled, add, start, progress, finish, cancel, mirrorOpen, idle, close: shutdown, queued: () => queue.length };
}
