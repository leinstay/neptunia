// The core's side of the runners' sockets (src/agent-runner/server.ts): one Unix-socket connection per
// unit (`server`, `scout`, `code`), opened on first use, speaking the JSON-lines protocol of src/agent-runner/protocol.ts.
// Every agent of a unit shares its connection, and each `run` names its agent. `run` sends one errand and
// resolves on its `end` event; `cancel` and `ping` are
// fire-and-answer. Each outcome of the connect loop goes to the `onLink` listeners: `{ unit, up: true }` once a
// connection opens, `{ unit, up: false, code }` when one fails (`code` the socket's error code) or an open one
// closes (`disconnected`) -- the errand service's health flag of each runner, which every agent of the unit reads.
// A connection that closes is reopened with a growing backoff while an agent of its unit stays enabled;
// the errands it carried resolve `failed` with `error: CODE.DISCONNECTED` at once (the runner sends a
// errand's end on the connection that brought it, so nothing more can arrive for them). An agent
// that is off (`agents.<name>.enabled` not true) answers `failed`, `not-configured`, without
// connecting. The socket is the unit's (unitPaths) and the settings the profile's with the deployment's
// `agents.<name>` over it (agentSettings), read at the moment of use. Logs carry the profile, ids and codes, never a goal, a result or an errand's `secrets`
// (sent on the `run` line and nowhere else). A `run` also carries the deployment's preamble when
// one matches: the files of data/prompts/preambles/ picked by agent and by the model of the run's
// route (src/errands/preambles.ts; `hot.prompts.preambles`, read live; no tracked default). The
// composed preamble goes out whole, however long. The core reads the private layer, the runners never do. Logs carry
// the model id, the file names and the length, never a text.

import net from 'node:net';
import { log as defaultLog } from '../log.ts';
import { encodeLine, normalizeResult, normalizeUsage } from '../agent-runner/protocol.ts';
import { agentSettings, loadProfiles, profileOf, unitPaths } from '../agent-runner/profiles.ts';
import type { AgentPaths } from '../agent-runner/profiles.ts';
import { composePreamble } from './preambles.ts';
import { CODE } from '../tools/codes.ts';
import { errorCode, textOf } from '../tools/types.ts';
import type { Untyped } from '../tools/types.ts';
import type { ErrandClient, ErrandClientOptions, PingAnswer, RunOutcome, RunRequest, TimerHandle } from './types.ts';

/** A run waiting for its end: its agent, the unit whose connection carries it, and how it ends. */
type Pending = { agent: string; unit: string; resolve: (outcome: RunOutcome) => void; timer: TimerHandle };

/** One unit's connection to its runner. */
type Link = {
  socket: net.Socket | null;
  path: string;
  open: boolean;
  opening: Promise<Link> | null;
  backoffMs: number;
  timer: TimerHandle | null;
  buffer: string;
};

/** The first reconnect delay and its ceiling (ms); the delay doubles after each failed attempt. */
export const RECONNECT_MIN_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;
/** How long a `ping` waits for its `pong` (ms). */
export const PING_TIMEOUT_MS = 5000;
/** Added to an errand's own time cap before the core stops waiting for its `end` (ms). */
const END_GRACE_MS = 60_000;
/** The time cap an errand without `limits.seconds` is waited for (s). */
const DEFAULT_ERRAND_SECONDS = 600;

/** A failed outcome with `error`, in the shape `run` resolves. */
function failed(error: string): RunOutcome {
  return { status: 'failed', result: normalizeResult(null), usage: normalizeUsage(null), error };
}

/** The unit of `agent` and its socket path when the agent is enabled now, else null. */
function linkOf(agent: string, config: Untyped, agentPaths?: AgentPaths): { unit: string; socket: string } | null {
  const profile = profileOf(agent, agentPaths);
  if (!profile || agentSettings(agent, config, agentPaths)?.enabled !== true) return null;
  return { unit: profile.unit, socket: unitPaths(profile.unit, agentPaths?.env).socket };
}

/** The socket path of `unit` while an agent of it is enabled now, else null. */
function unitSocketOf(unit: string, config: Untyped, agentPaths?: AgentPaths): string | null {
  for (const agent of Object.values(loadProfiles(agentPaths)).filter((profile) => profile.unit === unit)) {
    const link = linkOf(agent.name, config, agentPaths);
    if (link) return link.socket;
  }
  return null;
}

/** The preamble of a run of `agent` on `runModel`: `{ text, files, chars }`, every matching file whole. */
function preambleOf(
  agent: string,
  runModel: string | null,
  hot: ErrandClientOptions['hot']
): ReturnType<typeof composePreamble> {
  return composePreamble({ prompts: { preambles: hot?.prompts?.preambles }, agent, model: runModel });
}

/**
 * `hot` holds the live config (`agents.<name>.enabled`) and prompts
 * (`preambles`: read at each run). `connect` opens a socket (tests inject one).
 */
export function createErrandClient({
  hot,
  agentPaths,
  log = defaultLog,
  connect = (socketPath) => net.createConnection(socketPath),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(timer ?? undefined),
}: ErrandClientOptions = {}): ErrandClient {
  // unit -> its connection
  const links = new Map<string, Link>();
  // errand id -> the run waiting for its end
  const pending = new Map<string, Pending>();
  // unit -> the pings waiting for a pong
  const pings = new Map<string, Array<{ resolve: (answer: PingAnswer) => void; timer: TimerHandle | null }>>();
  const linkListeners = new Set<Parameters<ErrandClient['onLink']>[0]>();
  let closed = false;

  /** One outcome of `unit`'s connect loop to the `onLink` listeners. */
  function emitLink(unit: string, up: boolean, code: string | null = null): void {
    if (closed) return;
    const event = up ? { unit, up: true } : { unit, up: false, code: code ?? CODE.DISCONNECTED };
    for (const fn of linkListeners) {
      try {
        fn(event);
      } catch (err) {
        log.warn('errands: link listener failed', { unit, error: err });
      }
    }
  }

  /** Every errand and ping of `unit` answered `disconnected`. */
  function dropPending(unit: string): void {
    for (const [id, entry] of pending) {
      if (entry.unit !== unit) continue;
      pending.delete(id);
      clearTimer(entry.timer);
      entry.resolve(failed(CODE.DISCONNECTED));
    }
    for (const waiter of pings.get(unit) ?? []) {
      clearTimer(waiter.timer);
      waiter.resolve({ ok: false, error: CODE.DISCONNECTED });
    }
    pings.delete(unit);
  }

  /** One decoded line from `unit`'s runner. */
  function onEvent(unit: string, line: Untyped): void {
    if (!line || typeof line !== 'object') return;
    if (line.event === 'pong') {
      const waiters = pings.get(unit) ?? [];
      pings.delete(unit);
      for (const waiter of waiters) {
        clearTimer(waiter.timer);
        waiter.resolve({
          ok: true,
          unit: String(line.unit ?? unit),
          busy: line.busy === true,
          queued: Number(line.queued) || 0,
        });
      }
      return;
    }
    const id = textOf(line.id) || null;
    if ((line.event === 'end' || line.event === 'error') && id && pending.has(id)) {
      // `has` was just checked, so the entry is there.
      const entry = pending.get(id)!;
      pending.delete(id);
      clearTimer(entry.timer);
      if (line.event === 'error') {
        entry.resolve(failed(typeof line.error === 'string' && line.error ? line.error : 'runner-error'));
        return;
      }
      const outcome: RunOutcome = {
        status: ['done', 'failed', 'cancelled'].includes(line.status) ? line.status : 'failed',
        result: normalizeResult(line.result),
        usage: normalizeUsage(line.usage),
      };
      if (typeof line.error === 'string' && line.error) outcome.error = line.error;
      entry.resolve(outcome);
    }
  }

  /** Reopen `unit`'s link after its backoff, while an agent of it is still enabled. */
  function scheduleReconnect(unit: string, link: Link): void {
    if (closed || link.timer) return;
    const wait = link.backoffMs;
    link.backoffMs = Math.min(RECONNECT_MAX_MS, link.backoffMs * 2);
    link.timer = setTimer(() => {
      link.timer = null;
      try {
        if (closed || !unitSocketOf(unit, hot?.config, agentPaths)) {
          links.delete(unit);
          return;
        }
        open(unit).catch(() => {});
      } catch (error) {
        links.delete(unit);
        const code = errorCode(error) ?? CODE.NOT_CONFIGURED;
        log.warn('errands: reconnect refused', { unit, code });
        emitLink(unit, false, code);
      }
    }, wait);
    link.timer?.unref?.();
  }

  /**
   * The open link of `unit`: an existing one, else a new connection. Resolves the link once
   * connected; rejects (and arms a reconnect) when the connection fails.
   */
  function open(unit: string): Promise<Link> {
    const socketPath = unitSocketOf(unit, hot?.config, agentPaths);
    if (!socketPath) return Promise.reject(Object.assign(new Error('not configured'), { code: CODE.NOT_CONFIGURED }));
    let link = links.get(unit);
    if (link?.open && link.path === socketPath) return Promise.resolve(link);
    if (link?.opening && link.path === socketPath) return link.opening;
    if (link?.timer) clearTimer(link.timer);
    // A link to another path (the unit scope changed): its errands can no longer end.
    if (link?.open) dropPending(unit);
    if (link?.socket && !link.socket.destroyed) link.socket.destroy();
    link = {
      socket: null,
      path: socketPath,
      open: false,
      opening: null,
      backoffMs: link?.backoffMs ?? RECONNECT_MIN_MS,
      timer: null,
      buffer: '',
    };
    links.set(unit, link);
    const current = link;
    current.opening = new Promise<Link>((resolve, reject) => {
      let socket: net.Socket;
      try {
        socket = connect(socketPath);
      } catch (err) {
        current.opening = null;
        emitLink(unit, false, errorCode(err));
        scheduleReconnect(unit, current);
        reject(err);
        return;
      }
      current.socket = socket;
      socket.setEncoding?.('utf8');
      socket.once('connect', () => {
        current.open = true;
        current.opening = null;
        current.backoffMs = RECONNECT_MIN_MS;
        log.info('errands: connected', { unit });
        emitLink(unit, true);
        resolve(current);
      });
      socket.on('data', (chunk: string | Buffer) => {
        current.buffer += String(chunk);
        let nl;
        while ((nl = current.buffer.indexOf('\n')) !== -1) {
          const line = current.buffer.slice(0, nl);
          current.buffer = current.buffer.slice(nl + 1);
          if (!line.trim()) continue;
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            log.warn('errands: bad line', { unit });
            continue;
          }
          onEvent(unit, event);
        }
      });
      socket.on('error', (err) => {
        if (current.open) return;
        log.warn('errands: connect failed', { unit, code: errorCode(err) });
        if (links.get(unit) === current) emitLink(unit, false, errorCode(err));
      });
      socket.on('close', () => {
        const wasOpen = current.open;
        current.open = false;
        if (current.opening) {
          current.opening = null;
          reject(Object.assign(new Error('disconnected'), { code: CODE.DISCONNECTED }));
        }
        if (links.get(unit) !== current) return;
        if (wasOpen) {
          log.warn('errands: disconnected', {
            unit,
            pending: [...pending.values()].filter((entry) => entry.unit === unit).length,
          });
          emitLink(unit, false, 'disconnected');
        }
        dropPending(unit);
        scheduleReconnect(unit, current);
      });
    });
    return current.opening;
  }

  /** Write one request to `unit`'s open link; false when it is not open. */
  function send(unit: string, request: object): boolean {
    const link = links.get(unit);
    if (!link?.open || !link.socket || link.socket.destroyed) return false;
    try {
      link.socket.write(encodeLine(request));
      return true;
    } catch {
      return false;
    }
  }

  async function run({ agent, id, goal, context = {}, limits = {}, secrets, route }: RunRequest): Promise<RunOutcome> {
    const target = closed ? null : linkOf(agent, hot?.config, agentPaths);
    if (!target) return failed(CODE.NOT_CONFIGURED);
    const { unit } = target;
    if (pending.has(id)) return failed(CODE.DUPLICATE_ID);
    try {
      await open(unit);
    } catch (err) {
      return failed(errorCode(err) === CODE.NOT_CONFIGURED ? CODE.NOT_CONFIGURED : CODE.DISCONNECTED);
    }
    return new Promise<RunOutcome>((resolve) => {
      const seconds =
        typeof limits?.seconds === 'number' && Number.isFinite(limits.seconds) && limits.seconds > 0
          ? limits.seconds
          : DEFAULT_ERRAND_SECONDS;
      const timer = setTimer(
        () => {
          if (!pending.has(id)) return;
          pending.delete(id);
          send(unit, { op: 'cancel', id });
          log.warn('errands: no end in time', { agent, id });
          resolve(failed('timeout'));
        },
        seconds * 1000 + END_GRACE_MS
      );
      timer?.unref?.();
      pending.set(id, { agent, unit, resolve, timer });
      const request: Record<string, unknown> = { op: 'run', id, agent, goal, context, route };
      if (limits && Object.keys(limits).length > 0) request.limits = limits;
      if (secrets) request.secrets = secrets;
      const model = route?.model ?? null;
      const preamble = preambleOf(agent, model, hot);
      if (preamble.text) request.preamble = preamble.text;
      if (!send(unit, request)) {
        pending.delete(id);
        clearTimer(timer);
        resolve(failed(CODE.DISCONNECTED));
        return;
      }
      log.info('errands: sent', { agent, id, model, preambleFiles: preamble.files, preambleChars: preamble.chars });
    });
  }

  function cancel({ agent, id }: { agent: string; id: string }): boolean {
    const target = linkOf(agent, hot?.config, agentPaths);
    return target !== null && send(target.unit, { op: 'cancel', id });
  }

  async function ping(agent: string): Promise<PingAnswer> {
    const target = closed ? null : linkOf(agent, hot?.config, agentPaths);
    if (!target) return { ok: false, error: CODE.NOT_CONFIGURED };
    const { unit } = target;
    try {
      await open(unit);
    } catch (err) {
      return { ok: false, error: errorCode(err) === CODE.NOT_CONFIGURED ? CODE.NOT_CONFIGURED : CODE.DISCONNECTED };
    }
    return new Promise<PingAnswer>((resolve) => {
      const waiter: { resolve: (answer: PingAnswer) => void; timer: TimerHandle | null } = { resolve, timer: null };
      const drop = (): void => {
        pings.set(
          unit,
          (pings.get(unit) ?? []).filter((entry) => entry !== waiter)
        );
      };
      waiter.timer = setTimer(() => {
        drop();
        resolve({ ok: false, error: CODE.TIMEOUT });
      }, PING_TIMEOUT_MS);
      waiter.timer?.unref?.();
      pings.set(unit, [...(pings.get(unit) ?? []), waiter]);
      const ids = [...pending.entries()].filter(([, entry]) => entry.unit === unit).map(([errandId]) => errandId);
      if (!send(unit, { op: 'ping', ids })) {
        clearTimer(waiter.timer);
        drop();
        resolve({ ok: false, error: CODE.DISCONNECTED });
      }
    });
  }

  function onLink(fn: Parameters<ErrandClient['onLink']>[0]): () => void {
    if (typeof fn !== 'function') return () => {};
    linkListeners.add(fn);
    return () => {
      linkListeners.delete(fn);
    };
  }

  /** Close every link, stop reconnecting; open errands resolve `disconnected`. */
  function close(): void {
    closed = true;
    for (const [unit, link] of links) {
      if (link.timer) clearTimer(link.timer);
      link.timer = null;
      links.delete(unit);
      dropPending(unit);
      try {
        link.socket?.destroy();
      } catch {
        // already gone
      }
    }
  }

  return {
    run,
    cancel,
    ping,
    onLink,
    configured: (agent) => linkOf(agent, hot?.config, agentPaths) !== null,
    close,
  };
}
