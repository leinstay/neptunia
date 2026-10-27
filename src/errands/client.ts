// The core's side of the errand agents' sockets (src/agent-runner/server.js): one Unix-socket
// connection per agent profile (`scout`, `server`), opened on first use, speaking the JSON-lines
// protocol of src/agent-runner/protocol.js. `run` sends one errand and resolves on its `end` event;
// `progress` events go to the `onProgress` listeners; `cancel` and `ping` are fire-and-answer.
// Each outcome of the connect loop goes to the `onLink` listeners: `{ agent, up: true }` once a
// connection opens, `{ agent, up: false, code }` when one fails (`code` the socket's error code)
// or an open one closes (`disconnected`) -- the errand service's health flag of each runner.
// A connection that closes is reopened with a growing backoff while its profile stays enabled;
// the errands it carried resolve `failed` with `error: CODE.DISCONNECTED` at once (the runner sends a
// errand's end on the connection that brought it, so nothing more can arrive for them). A profile
// that is not set up (its `enabled` not true, or no socket) answers `failed`, `not-configured`, without
// connecting. The settings are the profile's with the deployment's `agents.<profile>` override over it
// (agentSettings), read at the moment of use. Logs carry the profile, ids and codes, never a goal, a result or an errand's `secrets`
// (sent on the `run` line and nowhere else). A `run` also carries the deployment's preamble when
// one matches: the files of prompts.local/preambles/ picked by agent and by the agent's model
// (src/errands/preambles.ts; `hot.prompts.preambles`, read live; no tracked default). The model
// is the agent's role model (`models.errands.scout`, `models.errands.server`), resolved here at send
// time and sent on the `run` line as `model`, with the deployment's own price (`agents.<profile>.cost` of the live
// config, when it has finite input and output) as `cost`: the runners cannot read the private config, so without it a
// run falls back to the profile's price. A composed text over MAX_PREAMBLE_CHARS sends the files that fit, whole and
// in order, with a warning naming the rest. The core reads the private layer, the runners never do. Logs carry the model id, the file names and the length,
// never a text or the cost.

import net from 'node:net';
import { log as defaultLog } from '../log.js';
import { encodeLine, normalizeResult, normalizeUsage, MAX_PREAMBLE_CHARS } from '../agent-runner/protocol.js';
import { agentSettings, profileOf } from '../agent-runner/profiles.js';
import { roleModel } from '../llm/roles.js';
import { composePreamble } from './preambles.ts';
import { CODE } from '../tools/codes.ts';
import { errorCode, objOf, textOf } from '../tools/types.ts';
import type { Untyped } from '../tools/types.ts';
import type { ErrandClient, ErrandClientOptions, PingAnswer, RunOutcome, RunRequest, TimerHandle } from './types.ts';

/** One agent's connection to its runner. */
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

/** The role model of `agent`, read now from the live config, or null. */
function runModelFor(agent: string, config: Untyped): string | null {
  const model = roleModel(config, textOf(objOf(profileOf(agent)).modelRole));
  return typeof model === 'string' && model ? model : null;
}

/** The price the deployment sets for `agent` (`agents.<agent>.cost`) when both fields are usable, else null: the runner has the profile's. */
function costFor(agent: string, config: Untyped): { input: number; output: number } | null {
  const cost = config?.agents?.[agent]?.cost;
  const usable = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (!cost || typeof cost !== 'object' || !usable(cost.input) || !usable(cost.output)) return null;
  return { input: cost.input, output: cost.output };
}

/**
 * `hot` holds the live config (`agents.<profile>.enabled`, `.socket`, the agent roles' models) and prompts
 * (`preambles`: read at each run). `connect` opens a socket (tests inject one).
 */
export function createErrandClient({
  hot,
  log = defaultLog,
  connect = (socketPath) => net.createConnection(socketPath),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(timer ?? undefined),
}: ErrandClientOptions = {}): ErrandClient {
  // agent -> its connection
  const links = new Map<string, Link>();
  // errand id -> the run waiting for its end
  const pending = new Map<string, { agent: string; resolve: (outcome: RunOutcome) => void; timer: TimerHandle }>();
  // agent -> the pings waiting for a pong
  const pings = new Map<string, Array<{ resolve: (answer: PingAnswer) => void; timer: TimerHandle | null }>>();
  const progressListeners = new Set<Parameters<ErrandClient['onProgress']>[0]>();
  const linkListeners = new Set<Parameters<ErrandClient['onLink']>[0]>();
  let closed = false;

  /** The socket path of `agent` when its profile is set up and enabled now, else null. */
  function socketOf(agent: string): string | null {
    const profile = profileOf(agent);
    if (!profile) return null;
    const settings = agentSettings(agent, hot?.config);
    if (settings?.enabled !== true) return null;
    return settings.socket || null;
  }

  /** One outcome of `agent`'s connect loop to the `onLink` listeners. */
  function emitLink(agent: string, up: boolean, code: string | null = null): void {
    if (closed) return;
    const event = up ? { agent, up: true } : { agent, up: false, code: code ?? CODE.DISCONNECTED };
    for (const fn of linkListeners) {
      try {
        fn(event);
      } catch (err) {
        log.warn('errands: link listener failed', { agent, error: err });
      }
    }
  }

  /** Every errand and ping of `agent` answered `disconnected`. */
  function dropPending(agent: string): void {
    for (const [id, entry] of pending) {
      if (entry.agent !== agent) continue;
      pending.delete(id);
      clearTimer(entry.timer);
      entry.resolve(failed(CODE.DISCONNECTED));
    }
    for (const waiter of pings.get(agent) ?? []) {
      clearTimer(waiter.timer);
      waiter.resolve({ ok: false, error: CODE.DISCONNECTED });
    }
    pings.delete(agent);
  }

  /** One decoded line from `agent`'s runner. */
  function onEvent(agent: string, event: Untyped): void {
    if (!event || typeof event !== 'object') return;
    if (event.event === 'pong') {
      const waiters = pings.get(agent) ?? [];
      pings.delete(agent);
      for (const waiter of waiters) {
        clearTimer(waiter.timer);
        waiter.resolve({
          ok: true,
          profile: String(event.profile ?? agent),
          busy: event.busy === true,
          queued: Number(event.queued) || 0,
        });
      }
      return;
    }
    const id = textOf(event.id) || null;
    if (event.event === 'progress' && id) {
      for (const fn of progressListeners) {
        try {
          fn({
            agent,
            id,
            step: Number(event.step) || 0,
            tool: typeof event.tool === 'string' ? event.tool : null,
            note: String(event.note ?? ''),
          });
        } catch (err) {
          log.warn('errands: progress listener failed', { agent, id, error: err });
        }
      }
      return;
    }
    if ((event.event === 'end' || event.event === 'error') && id && pending.has(id)) {
      // `has` was just checked, so the entry is there.
      const entry = pending.get(id)!;
      pending.delete(id);
      clearTimer(entry.timer);
      if (event.event === 'error') {
        entry.resolve(failed(typeof event.error === 'string' && event.error ? event.error : 'runner-error'));
        return;
      }
      const outcome = {
        status: ['done', 'failed', 'cancelled'].includes(event.status) ? event.status : 'failed',
        result: normalizeResult(event.result),
        usage: normalizeUsage(event.usage),
      };
      if (typeof event.error === 'string' && event.error) outcome.error = event.error;
      entry.resolve(outcome);
    }
  }

  /** Reopen `agent`'s link after its backoff, while it is still wanted and enabled. */
  function scheduleReconnect(agent: string, link: Link): void {
    if (closed || link.timer) return;
    const wait = link.backoffMs;
    link.backoffMs = Math.min(RECONNECT_MAX_MS, link.backoffMs * 2);
    link.timer = setTimer(() => {
      link.timer = null;
      if (closed || !socketOf(agent)) {
        links.delete(agent);
        return;
      }
      open(agent).catch(() => {});
    }, wait);
    link.timer?.unref?.();
  }

  /**
   * The open link of `agent`: an existing one, else a new connection. Resolves the link once
   * connected; rejects (and arms a reconnect) when the connection fails.
   */
  function open(agent: string): Promise<Link> {
    const socketPath = socketOf(agent);
    if (!socketPath) return Promise.reject(Object.assign(new Error('not configured'), { code: CODE.NOT_CONFIGURED }));
    let link = links.get(agent);
    if (link?.open && link.path === socketPath) return Promise.resolve(link);
    if (link?.opening && link.path === socketPath) return link.opening;
    if (link?.timer) clearTimer(link.timer);
    // A link to another path (the socket setting changed): its errands can no longer end.
    if (link?.open) dropPending(agent);
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
    links.set(agent, link);
    const current = link;
    current.opening = new Promise<Link>((resolve, reject) => {
      let socket: net.Socket;
      try {
        socket = connect(socketPath);
      } catch (err) {
        current.opening = null;
        emitLink(agent, false, errorCode(err));
        scheduleReconnect(agent, current);
        reject(err);
        return;
      }
      current.socket = socket;
      socket.setEncoding?.('utf8');
      socket.once('connect', () => {
        current.open = true;
        current.opening = null;
        current.backoffMs = RECONNECT_MIN_MS;
        log.info('errands: connected', { agent });
        emitLink(agent, true);
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
            log.warn('errands: bad line', { agent });
            continue;
          }
          onEvent(agent, event);
        }
      });
      socket.on('error', (err) => {
        if (current.open) return;
        log.warn('errands: connect failed', { agent, code: errorCode(err) });
        if (links.get(agent) === current) emitLink(agent, false, errorCode(err));
      });
      socket.on('close', () => {
        const wasOpen = current.open;
        current.open = false;
        if (current.opening) {
          current.opening = null;
          reject(Object.assign(new Error('disconnected'), { code: CODE.DISCONNECTED }));
        }
        if (links.get(agent) !== current) return;
        if (wasOpen) {
          log.warn('errands: disconnected', {
            agent,
            pending: [...pending.values()].filter((entry) => entry.agent === agent).length,
          });
          emitLink(agent, false, 'disconnected');
        }
        dropPending(agent);
        scheduleReconnect(agent, current);
      });
    });
    return current.opening;
  }

  /** Write one request to `agent`'s open link; false when it is not open. */
  function send(agent: string, request: object): boolean {
    const link = links.get(agent);
    if (!link?.open || !link.socket || link.socket.destroyed) return false;
    try {
      link.socket.write(encodeLine(request));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The preamble of a run of `agent` on `runModel`: `{ text, files, chars }`.
   * Over MAX_PREAMBLE_CHARS, a warning names the files sent and left out.
   */
  function preambleOf(agent: string, runModel: string | null): ReturnType<typeof composePreamble> {
    const composed = composePreamble({ prompts: hot?.prompts, agent, model: runModel, maxChars: MAX_PREAMBLE_CHARS });
    if (composed.dropped.length > 0) {
      log.warn('errands: preamble over the cap', {
        agent,
        model: runModel,
        files: composed.files,
        dropped: composed.dropped,
        chars: composed.chars,
        maxChars: MAX_PREAMBLE_CHARS,
      });
    }
    return composed;
  }

  async function run({ agent, id, goal, context = {}, limits = {}, secrets = null }: RunRequest): Promise<RunOutcome> {
    if (closed || !socketOf(agent)) return failed(CODE.NOT_CONFIGURED);
    if (pending.has(id)) return failed(CODE.DUPLICATE_ID);
    try {
      await open(agent);
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
          send(agent, { op: 'cancel', id });
          log.warn('errands: no end in time', { agent, id });
          resolve(failed('timeout'));
        },
        seconds * 1000 + END_GRACE_MS
      );
      timer?.unref?.();
      pending.set(id, { agent, resolve, timer });
      const request: Record<string, unknown> = { op: 'run', id, goal, context };
      if (limits && Object.keys(limits).length > 0) request.limits = limits;
      if (secrets) request.secrets = secrets;
      const model = runModelFor(agent, hot?.config);
      if (model) request.model = model;
      const cost = costFor(agent, hot?.config);
      if (cost) request.cost = cost;
      const preamble = preambleOf(agent, model);
      if (preamble.text) request.preamble = preamble.text;
      if (!send(agent, request)) {
        pending.delete(id);
        clearTimer(timer);
        resolve(failed(CODE.DISCONNECTED));
        return;
      }
      log.info('errands: sent', { agent, id, model, preambleFiles: preamble.files, preambleChars: preamble.chars });
    });
  }

  function cancel({ agent, id }: { agent: string; id: string }): boolean {
    if (!socketOf(agent)) return false;
    return send(agent, { op: 'cancel', id });
  }

  async function ping(agent: string): Promise<PingAnswer> {
    if (closed || !socketOf(agent)) return { ok: false, error: CODE.NOT_CONFIGURED };
    try {
      await open(agent);
    } catch (err) {
      return { ok: false, error: errorCode(err) === CODE.NOT_CONFIGURED ? CODE.NOT_CONFIGURED : CODE.DISCONNECTED };
    }
    return new Promise<PingAnswer>((resolve) => {
      const waiter: { resolve: (answer: PingAnswer) => void; timer: TimerHandle | null } = { resolve, timer: null };
      waiter.timer = setTimer(() => {
        const list = pings.get(agent) ?? [];
        pings.set(
          agent,
          list.filter((entry) => entry !== waiter)
        );
        resolve({ ok: false, error: CODE.TIMEOUT });
      }, PING_TIMEOUT_MS);
      waiter.timer?.unref?.();
      pings.set(agent, [...(pings.get(agent) ?? []), waiter]);
      const ids = [...pending.entries()].filter(([, entry]) => entry.agent === agent).map(([errandId]) => errandId);
      if (!send(agent, { op: 'ping', ids })) {
        clearTimer(waiter.timer);
        pings.set(
          agent,
          (pings.get(agent) ?? []).filter((entry) => entry !== waiter)
        );
        resolve({ ok: false, error: CODE.DISCONNECTED });
      }
    });
  }

  function onProgress(fn: Parameters<ErrandClient['onProgress']>[0]): () => void {
    if (typeof fn !== 'function') return () => {};
    progressListeners.add(fn);
    return () => {
      progressListeners.delete(fn);
    };
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
    for (const [agent, link] of links) {
      if (link.timer) clearTimer(link.timer);
      link.timer = null;
      links.delete(agent);
      dropPending(agent);
      try {
        link.socket?.destroy();
      } catch {
        // already gone
      }
    }
  }

  return { run, cancel, ping, onProgress, onLink, configured: (agent) => socketOf(agent) !== null, close };
}
