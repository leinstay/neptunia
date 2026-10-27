// The persona's errands mirrored into the ledger (the task service of the development side, its
// `core` principal's Unix socket, `agents.ledger.socket`): every errand of the core's store
// (src/errands/store.ts) becomes a task of the `errand` lane there, with the same transitions,
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
// later one may pass), and only the first refused or dropped call of an errand is logged. A call
// whose ledger id never came (its `task.add` refused) is dropped too. A queued errand goes
// `proposed -> triaged -> approved` (the ledger's machine has no shorter way). A refused or unreachable socket is logged at most once per
// UNAVAILABLE_LOG_MS. With `agents.ledger.socket` null (config.json's default) the mirror is
// disabled: nothing is queued, nothing connects. The socket path is read at the moment of use.
// Logs carry the core id, the op and codes, never a goal, a result or a member's id.
//
// One read besides the mirror: `costs()`, the development agents' spend (the ledger's read op
// `costs.agents`: thinker and dev over today, the last 7 and the last 30 UTC days, and the
// thinker's last wave with its context), asked on a connection of its own (one request, no
// idempotency key, never queued nor replayed) and answered within COSTS_TIMEOUT_MS. With no
// socket, a refusal, a bad answer or no answer in time it resolves null (logged once per
// UNAVAILABLE_LOG_MS) and never throws: the owner's status card shows those agents with no runs.

import net from 'node:net';
import { log as defaultLog } from '../log.js';
import { clampChars } from '../memory/clamp.js';
import { DEFAULT_RESULT_MAX_CHARS } from './blocks.ts';
import { fileHandle } from './store.ts';
import { CODE } from '../tools/codes.ts';
import { errorCode, idText, isObj, isPositive, objOf } from '../tools/types.ts';
import type { Obj } from '../tools/types.ts';
import type {
  CostRow,
  CostWindows,
  ErrandRecord,
  LastWave,
  LedgerCosts,
  LedgerMirror,
  LedgerAddOptions,
  LedgerOptions,
  Limits,
  MirrorOpenOptions,
  TimerHandle,
} from './types.ts';

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
/** Added to an errand's `limits.seconds` for its claim's lease (s). */
export const LEASE_GRACE_SECONDS = 60;
/** The first reconnect delay and its ceiling (ms); the delay doubles after each failure. */
export const RECONNECT_MIN_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;
/** How long one call waits for its answer before the connection is dropped and the call replayed (ms). */
export const REPLY_TIMEOUT_MS = 10_000;
/** How long `costs()` waits for the ledger's answer (ms). */
export const COSTS_TIMEOUT_MS = 3000;
/** The agents whose spend the ledger's `costs.agents` counts, in order. */
export const LEDGER_AGENTS = Object.freeze(['thinker', 'dev']);
/** The time cap of an errand without `limits.seconds` (s), as the errand client waits for it. */
const DEFAULT_ERRAND_SECONDS = 600;
/** The ledger's principal the core is. */
const PRINCIPAL = 'core';

/** What the mirror knows of one errand: the ledger's ids and its own bookkeeping. */
type LedgerRecord = {
  ledgerId: string | null;
  attemptId: string | null;
  attempted: boolean;
  lease: number | null;
  lastBeat: number;
  warned: boolean;
};

/** The args of a call from the ledger id of its errand, or null when they cannot be built. */
type Build = (ledgerId: string) => Obj | null;
type OnResult = (result: unknown, record: LedgerRecord | null) => void;

/** One call waiting for the ledger. */
type Entry = {
  coreId: string;
  op: string;
  method: string;
  /** The call's args from the record, or null when it cannot be built (then it is skipped). */
  build: (record: LedgerRecord) => Obj | null;
  onResult?: OnResult | null;
  /** The record is forgotten once the call is answered or skipped. */
  final?: boolean;
};

/** The one connection to the ledger. */
type LedgerLink = { socket: net.Socket | null; path: string; open: boolean; buffer: string };

/** What one request on a connection of its own settles to. */
type Outcome = { ok: true; result: unknown } | { ok: false; code: string };

/** The idempotency key of `op` for the errand `coreId`. */
export function idempotencyKey(coreId: unknown, op: unknown): string {
  return `errand:${idText(coreId)}:${idText(op)}`;
}

/** The lease of a claim (s): the errand's `limits.seconds` (else the client's default) plus LEASE_GRACE_SECONDS. */
export function leaseSeconds(limits: Limits | null | undefined): number {
  const seconds = isPositive(limits?.seconds) ? limits.seconds : DEFAULT_ERRAND_SECONDS;
  return Math.ceil(seconds) + LEASE_GRACE_SECONDS;
}

/**
 * The args of `task.add` for a queued errand: the `errand` lane, no project, the goal as the
 * description and (cut to TITLE_CHARS) the title, the asker as `persona:<userId>` (`persona:self`
 * for her own errand), the agent as the role, the conversation as the subscriber
 * (`core:<guildId>:<channelId>`), and `{ coreId, scope, agent }` as metadata.
 */
export function addArgs(errand: ErrandRecord, guildId: string): Obj {
  const channel = errand.origin?.channelId ?? null;
  return {
    lane: LEDGER_LANE,
    project: null,
    title: clampChars(
      String(errand.goal ?? '')
        .replace(/\s+/g, ' ')
        .trim(),
      TITLE_CHARS
    ),
    description: String(errand.goal ?? ''),
    requester: `persona:${errand.requester?.userId ?? 'self'}`,
    role: errand.agent,
    subscriber: channel ? `core:${guildId}:${channel}` : `core:${guildId}`,
    metadata: { coreId: errand.id, scope: errand.scope, agent: errand.agent },
  };
}

/** The args of `task.transition` of ledger task `ledgerId` to `to` (with `close_reason` when given). */
export function transitionArgs(ledgerId: string, to: string, closeReason: string | null = null): Obj {
  return closeReason ? { id: ledgerId, to, close_reason: closeReason } : { id: ledgerId, to };
}

/**
 * The args of the triage of ledger task `ledgerId` (`task.transition` to `triaged`, the triage
 * fields set in the same call): the agent as the role, `limits.steps` as `step_cap`, `limits.seconds` (else the
 * client's default) in whole minutes as `estimate_minutes`. No dollar budget: the engine has no dollar limits.
 * A limit that is not a positive number is left out.
 */
export function triageArgs(ledgerId: string, errand: ErrandRecord, limits: Limits | null | undefined): Obj {
  const set: Obj = { role: errand.agent };
  if (isPositive(limits?.steps)) set.step_cap = Math.floor(limits.steps);
  const seconds = isPositive(limits?.seconds) ? limits.seconds : DEFAULT_ERRAND_SECONDS;
  set.estimate_minutes = Math.ceil(seconds / 60);
  return { id: ledgerId, to: 'triaged', set };
}

/** The args of `task.claim` of ledger task `ledgerId` with the lease of `limits`. */
export function claimArgs(ledgerId: string, limits: Limits | null | undefined): Obj {
  return { id: ledgerId, lease_seconds: leaseSeconds(limits) };
}

/** The args of `task.heartbeat` of ledger task `ledgerId` (the lease renewed). */
export function heartbeatArgs(ledgerId: string, lease: number | null): Obj {
  return { id: ledgerId, lease_seconds: lease };
}

/** The args of `attempt.start` on ledger task `ledgerId`: principal `core`, the agent as the role, its model, no worktree. */
export function attemptStartArgs(ledgerId: string, errand: ErrandRecord, model: unknown): Obj {
  return {
    task_id: ledgerId,
    principal: PRINCIPAL,
    role: errand.agent,
    model: typeof model === 'string' && model ? model : null,
    worktree: null,
  };
}

/** The args of `attempt.end` of attempt `attemptId`: the steps and dollars of the runner's usage, the outcome. */
export function attemptEndArgs(attemptId: string, errand: ErrandRecord, outcome: string = errand.state): Obj {
  return { id: attemptId, outcome, steps: Number(errand.usage?.steps) || 0, cost_usd: Number(errand.usage?.usd) || 0 };
}

/**
 * The `task.result` calls of a finished errand, as `[{ op, args }]` (`op` the idempotency
 * suffix): one `summary` with the result's text cut to `maxChars` (the `withheld` paths as its
 * metadata; left out when there is neither), then one `file` per output file, its handle as the
 * `uri`. [] without a result.
 */
export function resultCalls(
  ledgerId: string,
  errand: ErrandRecord,
  maxChars: number = DEFAULT_RESULT_MAX_CHARS
): Array<{ op: string; args: Obj }> {
  const result = errand.result;
  if (!result) return [];
  const calls: Array<{ op: string; args: Obj }> = [];
  const text = clampChars(typeof result.text === 'string' ? result.text : '', maxChars);
  const withheld = Array.isArray(result.withheld) ? result.withheld : [];
  if (text || withheld.length > 0) {
    calls.push({
      op: 'task.result:summary',
      args: { task_id: ledgerId, kind: 'summary', text, ...(withheld.length > 0 ? { metadata: { withheld } } : {}) },
    });
  }
  for (const file of Array.isArray(result.files) ? result.files : []) {
    if (!file?.name) continue;
    calls.push({
      op: `task.result:file:${file.name}`,
      args: {
        task_id: ledgerId,
        kind: 'file',
        uri: fileHandle(errand.id, file.name),
        metadata: { name: file.name, contentType: file.contentType ?? '', bytes: file.bytes ?? 0 },
      },
    });
  }
  return calls;
}

/** A count or an amount of the ledger's answer: a finite number, else 0. */
function numberOr0(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** A number of the ledger's answer, or null. */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The answer of `costs.agents` reduced to what the status card reads: `{ thinker, dev }`,
 * each `{ today, last7, last30 }` of `{ runs, input, output, usd }` (a missing or odd number 0),
 * the thinker with `last_wave` (`{ wave, turns, usd, context_mean, context_peak }`, the context
 * figures null when absent) or null. An agent the answer lacks counts zero; null for an answer
 * that is not an object.
 */
export function agentCostsOf(result: unknown): LedgerCosts | null {
  if (!isObj(result)) return null;
  const windowsOf = (agent: string): CostWindows => {
    const row = objOf(result[agent]);
    const sums = (window: string): CostRow => {
      const given = objOf(row[window]);
      return {
        runs: numberOr0(given.runs),
        input: numberOr0(given.input),
        output: numberOr0(given.output),
        usd: numberOr0(given.usd),
      };
    };
    return { today: sums('today'), last7: sums('last7'), last30: sums('last30') };
  };
  const given = objOf(result.thinker).last_wave;
  const lastWave: LastWave | null = isObj(given)
    ? {
        wave: given.wave ?? null,
        turns: numberOr0(given.turns),
        usd: numberOr0(given.usd),
        context_mean: numberOrNull(given.context_mean),
        context_peak: numberOrNull(given.context_peak),
      }
    : null;
  return { thinker: { ...windowsOf('thinker'), last_wave: lastWave }, dev: windowsOf('dev') };
}

/**
 * One request on a connection of its own to `where`: resolves `{ ok: true, result }` or
 * `{ ok: false, code }` (the ledger's refusal, `timeout`, `closed`, `bad-line` or the socket's
 * error code); never rejects. The connection is closed once it settles.
 */
function requestOnce({
  where,
  op,
  args,
  connect,
  timeoutMs,
}: {
  where: string;
  op: string;
  args: Obj;
  connect: (path: string) => net.Socket;
  timeoutMs: number;
}): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    let socket: net.Socket | null = null;
    let buffer = '';
    let done = false;
    let timer: TimerHandle | null = null;
    const settle = (outcome: Outcome): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (socket && !socket.destroyed) socket.destroy();
      resolve(outcome);
    };
    timer = setTimeout(() => settle({ ok: false, code: CODE.TIMEOUT }), timeoutMs);
    timer.unref?.();
    let conn: net.Socket;
    try {
      conn = connect(where);
    } catch (err) {
      settle({ ok: false, code: errorCode(err) ?? 'connect' });
      return;
    }
    socket = conn;
    conn.setEncoding?.('utf8');
    conn.once('connect', () => {
      try {
        conn.write(`${JSON.stringify({ id: 1, op, args })}\n`);
      } catch (err) {
        settle({ ok: false, code: errorCode(err) ?? 'write' });
      }
    });
    conn.on('data', (chunk: string | Buffer) => {
      buffer += String(chunk);
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let reply: Obj;
        try {
          reply = objOf(JSON.parse(line));
        } catch {
          settle({ ok: false, code: CODE.BAD_LINE });
          return;
        }
        if (reply.id !== 1) continue;
        settle(reply.ok === true ? { ok: true, result: reply.result } : { ok: false, code: codeOf(reply.error) });
        return;
      }
    });
    conn.on('error', (err) => settle({ ok: false, code: errorCode(err) ?? CODE.ERROR }));
    conn.on('close', () => settle({ ok: false, code: CODE.CLOSED }));
  });
}

/** The ledger id a result names (`id`, or the nested `task` / `attempt` one), as a string; null otherwise. */
function idOf(result: unknown, nested: string): string | null {
  const answer = objOf(result);
  const value = answer.id ?? objOf(answer[nested]).id ?? null;
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? String(value) : null;
}

/** The code of a ledger error (a string, or an object's `code`). */
function codeOf(error: unknown): string {
  if (typeof error === 'string' && error) return error;
  const code = objOf(error).code;
  if (typeof code === 'string' && code) return code;
  return CODE.REFUSED;
}

/**
 * `socketPath` is the ledger socket, or a function read at the moment of use (`agents.ledger.socket`);
 * null disables the mirror.
 */
export function createLedgerMirror({
  socketPath = null,
  log = defaultLog,
  now = Date.now,
  connect = (where) => net.createConnection(where),
  reconnectMinMs = RECONNECT_MIN_MS,
  reconnectMaxMs = RECONNECT_MAX_MS,
  replyTimeoutMs = REPLY_TIMEOUT_MS,
  costsTimeoutMs = COSTS_TIMEOUT_MS,
}: LedgerOptions = {}): LedgerMirror {
  // core id -> what the mirror knows of that errand
  const records = new Map<string, LedgerRecord>();
  const queue: Array<Entry> = [];
  const waiters: Array<() => void> = [];
  let link: LedgerLink | null = null;
  let inFlight: { id: number; timer: TimerHandle } | null = null;
  let backoffMs = reconnectMinMs;
  let reconnectTimer: TimerHandle | null = null;
  let lastUnavailableAt = -Infinity;
  let lastFullAt = -Infinity;
  let nextId = 1;
  let closed = false;

  /** The socket path now, or null (disabled). */
  function pathNow(): string | null {
    const value = typeof socketPath === 'function' ? socketPath() : socketPath;
    return typeof value === 'string' && value ? value : null;
  }

  /** The record of `errand`, created on first use (its stored `ledgerId` taken over). */
  function recordOf(errand: ErrandRecord): LedgerRecord {
    let record = records.get(errand.id);
    if (!record) {
      record = {
        ledgerId: errand.ledgerId ? String(errand.ledgerId) : null,
        attemptId: null,
        attempted: false,
        lease: null,
        lastBeat: -Infinity,
        warned: false,
      };
      records.set(errand.id, record);
    } else if (!record.ledgerId && errand.ledgerId) {
      record.ledgerId = String(errand.ledgerId);
    }
    return record;
  }

  /** `errands: ledger unavailable`, at most once per UNAVAILABLE_LOG_MS. */
  function unavailable(code: string | null): void {
    const at = now();
    if (at - lastUnavailableAt < UNAVAILABLE_LOG_MS) return;
    lastUnavailableAt = at;
    log.warn('errands: ledger unavailable', { code: code ?? null, queued: queue.length });
  }

  /**
   * A refused or skipped call of an errand logged, once per errand: the calls after a refused one
   * (a later transition, the claim, the attempt) are still sent, and their own refusals, which
   * follow from the first, are not logged again.
   */
  function warnOnce(entry: Entry, msg: string, code: string): void {
    const record = records.get(entry.coreId);
    if (record) {
      if (record.warned) return;
      record.warned = true;
    }
    log.warn(msg, { id: entry.coreId, op: entry.op, code });
  }

  /** The waiters of idle() resolved once nothing is queued or in flight. */
  function settle(): void {
    if (queue.length > 0 || inFlight) return;
    for (const resolve of waiters.splice(0)) resolve();
  }

  /** One call queued (false when disabled or the queue is full). */
  function enqueue(entry: Entry): boolean {
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
  function drop(): void {
    if (inFlight) {
      clearTimeout(inFlight.timer);
      inFlight = null;
    }
    const current = link;
    link = null;
    if (current?.socket && !current.socket.destroyed) current.socket.destroy();
  }

  function scheduleReconnect(): void {
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
  function open(where: string): void {
    const current: LedgerLink = { socket: null, path: where, open: false, buffer: '' };
    link = current;
    let socket: net.Socket;
    try {
      socket = connect(where);
    } catch (err) {
      link = null;
      unavailable(errorCode(err) ?? 'connect');
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
    socket.on('data', (chunk: string | Buffer) => {
      if (link !== current) return;
      current.buffer += String(chunk);
      let nl;
      while ((nl = current.buffer.indexOf('\n')) !== -1) {
        const line = current.buffer.slice(0, nl);
        current.buffer = current.buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let reply: unknown;
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
      if (link === current) unavailable(errorCode(err) ?? CODE.ERROR);
    });
    socket.on('close', () => {
      if (link !== current) return;
      if (current.open) unavailable('disconnected');
      drop();
      scheduleReconnect();
    });
  }

  /** One answer of the ledger: the head call done (its result taken, or its refusal logged and dropped). */
  function onReply(reply: unknown): void {
    const answer = objOf(reply);
    if (!inFlight || answer.id !== inFlight.id) return;
    clearTimeout(inFlight.timer);
    inFlight = null;
    const entry = queue.shift();
    if (!entry) return;
    if (answer.ok === true) {
      try {
        entry.onResult?.(answer.result, records.get(entry.coreId) ?? null);
      } catch (err) {
        log.warn('errands: ledger result failed', { id: entry.coreId, op: entry.op, error: err });
      }
    } else {
      warnOnce(entry, 'errands: ledger refused', codeOf(answer.error));
    }
    if (entry.final) records.delete(entry.coreId);
    pump();
  }

  /** The head call sent when the link is up; the link opened when it is not. */
  function pump(): void {
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
    let args: Obj | null = null;
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
      link.socket?.write(
        `${JSON.stringify({ id, op: entry.method, args, idempotency: idempotencyKey(entry.coreId, entry.op) })}\n`
      );
    } catch (err) {
      unavailable(errorCode(err) ?? 'write');
      drop();
      scheduleReconnect();
    }
  }

  /** A call that needs the errand's ledger id (`final`: the record forgotten once it is answered or skipped). */
  function call(errand: ErrandRecord, op: string, method: string, build: Build, onResult?: OnResult, final = false) {
    return enqueue({
      coreId: errand.id,
      op,
      method,
      build: (record) => (record.ledgerId ? build(record.ledgerId) : null),
      onResult,
      final,
    });
  }

  /** The `task.transition` of `errand` to its final state, the record forgotten once it is through or refused. */
  function closeTask(errand: ErrandRecord, to: string, closeReason: string | null): void {
    call(
      errand,
      `task.transition:${to}`,
      'task.transition',
      (ledgerId) => transitionArgs(ledgerId, to, closeReason),
      null,
      true
    );
  }

  /** The attempt of `errand` ended with `outcome`, when this process started one. */
  function endAttempt(errand: ErrandRecord, record: LedgerRecord, outcome: string): void {
    if (!record.attempted) return;
    record.attempted = false;
    enqueue({
      coreId: errand.id,
      op: 'attempt.end',
      method: 'attempt.end',
      build: (r) => (r.attemptId ? attemptEndArgs(r.attemptId, errand, outcome) : null),
    });
  }

  /** Whether the mirror is on now (`agents.ledger.socket` set). */
  function enabled(): boolean {
    return !closed && pathNow() !== null;
  }

  /**
   * A queued errand mirrored: `task.add` (its ledger id handed to `onLedgerId`), then
   * `task.transition` to `triaged` (the triage fields from `limits`, triageArgs), then to
   * `approved` (the ledger's machine has no `proposed -> approved`). Nothing for an errand that
   * already has its ledger id.
   */
  function add(errand: ErrandRecord, { guildId, limits = {}, onLedgerId = null }: LedgerAddOptions = {}): boolean {
    if (!enabled() || !errand?.id) return false;
    const record = recordOf(errand);
    if (record.ledgerId) return false;
    const args = addArgs(errand, String(guildId));
    enqueue({
      coreId: errand.id,
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
    call(errand, 'task.transition:triaged', 'task.transition', (ledgerId) => triageArgs(ledgerId, errand, limits));
    call(errand, 'task.transition:approved', 'task.transition', (ledgerId) => transitionArgs(ledgerId, 'approved'));
    return true;
  }

  /**
   * The runner took `errand`: `task.claim` with its lease, then `attempt.start`.
   */
  function start(
    errand: ErrandRecord,
    { limits = {}, model = null }: { limits?: Limits; model?: string | null } = {}
  ): boolean {
    if (!enabled() || !errand?.id) return false;
    const record = recordOf(errand);
    record.attempted = true;
    record.lease = leaseSeconds(limits);
    record.lastBeat = now();
    call(errand, 'task.claim', 'task.claim', (ledgerId) => claimArgs(ledgerId, limits));
    call(
      errand,
      'attempt.start',
      'attempt.start',
      (ledgerId) => attemptStartArgs(ledgerId, errand, model),
      (result, current) => {
        const attemptId = idOf(result, 'attempt');
        if (attemptId && current) current.attemptId = attemptId;
      }
    );
    return true;
  }

  /** A `progress` of the runner for `errand`: `task.heartbeat`, at most once per HEARTBEAT_MS. */
  function progress(errand: ErrandRecord): boolean {
    if (!enabled() || !errand?.id) return false;
    const record = records.get(errand.id);
    if (!record?.attempted) return false;
    const at = now();
    if (at - record.lastBeat < HEARTBEAT_MS) return false;
    record.lastBeat = at;
    const lease = record.lease;
    return call(errand, `task.heartbeat:${Math.floor(at / HEARTBEAT_MS)}`, 'task.heartbeat', (ledgerId) =>
      heartbeatArgs(ledgerId, lease)
    );
  }

  /**
   * `errand` ended (done, failed, or cancelled by its runner): `attempt.end` when this process
   * started one, its `task.result` calls (the summary cut to `maxChars`, the files), then
   * `task.transition` to its state (`close_reason` its error code unless done).
   */
  function finish(errand: ErrandRecord, { maxChars = DEFAULT_RESULT_MAX_CHARS }: { maxChars?: number } = {}): boolean {
    if (!enabled() || !errand?.id) return false;
    const record = recordOf(errand);
    endAttempt(errand, record, errand.state);
    for (const { op, args } of resultCalls('', errand, maxChars)) {
      call(errand, op, 'task.result', (ledgerId) => ({ ...args, task_id: ledgerId }));
    }
    closeTask(errand, errand.state, errand.state === 'done' ? null : (errand.error ?? errand.state));
    return true;
  }

  /**
   * `errand` cancelled in the core (`by`: who cancelled it): its attempt ended `cancelled` when this
   * process started one, then `task.transition` to `cancelled` (`close_reason: cancelled-by-<by>`).
   */
  function cancel(errand: ErrandRecord, { by = 'unknown' }: { by?: string } = {}): boolean {
    if (!enabled() || !errand?.id) return false;
    const record = recordOf(errand);
    endAttempt(errand, record, 'cancelled');
    closeTask(errand, 'cancelled', `cancelled-by-${by}`);
    return true;
  }

  /**
   * The open errands a restart found without a ledger id, mirrored (`task.add` with the same
   * idempotency key, so one half delivered before the restart is not doubled). Returns how many.
   */
  function mirrorOpen(
    errands: Array<ErrandRecord>,
    { guildId, limitsOf = null, onLedgerId = null }: MirrorOpenOptions = {}
  ): number {
    if (!enabled()) return 0;
    let count = 0;
    for (const errand of Array.isArray(errands) ? errands : []) {
      if (!errand?.id || errand.ledgerId || !['queued', 'running'].includes(errand.state)) continue;
      const limits = typeof limitsOf === 'function' ? (limitsOf(errand) ?? {}) : {};
      if (add(errand, { guildId, limits, onLedgerId: onLedgerId ? (ledgerId) => onLedgerId(errand, ledgerId) : null }))
        count += 1;
    }
    return count;
  }

  /**
   * The development agents' spend from the ledger's `costs.agents` at `now` (agentCostsOf's
   * shape), asked on a connection of its own; null with no socket, after the shutdown, or when the
   * ledger refuses, answers oddly or not within `costsTimeoutMs` (logged at most once per
   * UNAVAILABLE_LOG_MS). Never rejects.
   */
  async function costs({ now: at = now() }: { now?: number } = {}): Promise<LedgerCosts | null> {
    const where = closed ? null : pathNow();
    if (!where) return null;
    const reply = await requestOnce({
      where,
      op: 'costs.agents',
      args: { now: at },
      connect,
      timeoutMs: costsTimeoutMs,
    });
    const totals = reply.ok ? agentCostsOf(reply.result) : null;
    if (!totals) unavailable(reply.ok ? 'bad-answer' : reply.code);
    return totals;
  }

  /** Resolves once nothing is queued or in flight (tests, the shutdown). */
  function idle(): Promise<void> {
    if (queue.length === 0 && !inFlight) return Promise.resolve();
    return new Promise<void>((resolve) => waiters.push(resolve));
  }

  /** The connection closed and the reconnects stopped; what is queued is lost. */
  function shutdown(): void {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    drop();
    queue.length = 0;
    for (const resolve of waiters.splice(0)) resolve();
  }

  return {
    enabled,
    add,
    start,
    progress,
    finish,
    cancel,
    mirrorOpen,
    costs,
    idle,
    close: shutdown,
    queued: () => queue.length,
  };
}
