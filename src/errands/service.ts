// The persona's errands in the background: an errand one of the operations `errand.server`, `errand.scout` and
// `errand.code` accepted (queued in
// the place's errand store, src/errands/store.ts) is handed to its agent runner through the client
// (src/errands/client.ts) right after the operation answered -- nobody waits for it. The errand is
// `running` from the moment it is sent, with the limits of the profile (`limits`, overridable under `agents.<profile>`; the
// profile's defaults under them) and a context the runner applies its scope policy to
// (`scope`: `dm` for an errand asked in a private chat, else `group`; the origin channel; who
// asked). Its `end` writes the result into the store and calls `onFinished(errand)` -- the turn
// that brings it back to the persona (src/errands/turns.ts); an errand cancelled meanwhile ends
// without one. At start the errands a restart left open are failed (`restarted`): the runner sends
// an errand's end on the connection that brought it, which is gone. Every run carries the errand's
// secrets (`secrets` of src/agent-runner/protocol.ts), since every key lives in the core and the
// runner cannot read it: the named key of an opencode route (never a key of her model roles); the engine proxy of the moment (`proxy`, the core's
// monitor, src/net/proxy.ts) in its http form for every agent, so no harness child goes out from
// the server's own address while the proxy is on; the stored Exa key (keys.json `services.exa`) for an
// agent that searches with exa on an opencode route (`searchKey`). A run with none of them carries no secrets. Settings are read at the moment of
// use; logs carry ids and codes, never a goal, a result or a secret. The context also carries
// `recent`: the last `DEFAULT_RECENT_LINES` lines of the origin channel as `[{ author, text }]`
// (display names and text on one line), read from the memory's buffer
// (the memory database's newest lines of the channel) at the moment the errand is queued and kept in memory only until it is sent;
// a `dm`-scoped errand sends `recent: []` (nothing of a private chat reaches a runner this way).
// Each unit has a health flag, which every agent of the unit reads: the latest outcome of the client's connect loop
// (`onLink`) or of a ping (a pong is up; a failed ping down), unknown until the first. While an agent's runner is
// down a new errand is refused at once (`runner-down`), before anything is queued, so the caller
// (the lookup's errand lane) falls back while it still can, instead of an `ok` the runner then
// fails a few ms later. At start each enabled agent is pinged in the background (the flag is
// known before the first ask), and a refusal pings the runner again, at most once per
// RUNNER_RECHECK_MS, so the flag flips back even when the client's reconnect loop has stopped.
// The flag is logged once per change (`errands: runner up` / `errands: runner down`, with the unit).
// A heartbeat or a diary turn waits for the errand it starts (`wait`): the wait resolves at the errand's end, which is
// marked seen and read before `onFinished` runs, so her waiting call carries the result and no result turn opens for
// it. A cancel resolves the wait with the cancelled errand. A wait whose time runs out first resolves with the errand
// still open and unread, and its end reaches her as any other end does.

import { opensPrivate } from '../memory/open-private.ts';
import { log as defaultLog } from '../log.ts';
import { agentSettings, engineRoot, loadProfiles, profileOf } from '../agent-runner/profiles.ts';
import type { AgentPaths } from '../agent-runner/profiles.ts';
import { serviceCredential } from '../keys/file.ts';
import { opencodeKey } from '../subharness/routing.ts';
import { routeOfAgent } from '../subharness/control.ts';
import { MAX_RECENT_ENTRIES } from '../agent-runner/protocol.ts';
import { httpProxyForm } from '../net/proxy.ts';
import type { TaskRoute } from '../agent-runner/protocol.ts';
import { oneLine } from '../memory/clamp.ts';
import { isOpenState } from './store.ts';
import { CODE } from '../tools/codes.ts';
import { errorCode, idText, isPositive } from '../tools/types.ts';
import type { Untyped } from '../tools/types.ts';
import type {
  AddResult,
  Budget,
  CancelResult,
  ErrandFileRef,
  ErrandRecord,
  ErrandScope,
  ErrandService,
  ErrandServiceOptions,
  ErrandStore,
  ExpiredFileRef,
  TimerHandle,
  FinishOutcome,
  IdsInput,
  Limits,
  Logger,
  PingAnswer,
  RetrieveForErrand,
  RunContext,
  RunRequest,
  RunSecrets,
  SubmitInput,
  WaitResult,
} from './types.ts';

/** The limit keys an errand may carry to its runner (src/agent-runner/protocol.ts#LIMIT_KEYS). */
const ERRAND_LIMIT_KEYS = Object.freeze(['steps', 'seconds'] as const);
/** The origin channel's lines an errand carries. Production value, config cut of 2026-10-31. */
export const DEFAULT_RECENT_LINES = 6;
/** The least time between two pings a `runner-down` refusal sends to recheck its runner (ms). */
export const RUNNER_RECHECK_MS = 10_000;

/** The limits an errand of `agent` runs under: its profile's `limits` under the deployment's override. */
function limitsFor(agent: string, config: Untyped, agentPaths?: AgentPaths): Limits {
  const set: Record<string, number> = agentSettings(agent, config, agentPaths)?.limits ?? {};
  const defaults = profileOf(agent, agentPaths)?.defaultLimits ?? {};
  const out: Limits = {};
  for (const key of ERRAND_LIMIT_KEYS) {
    const value = isPositive(set[key]) ? set[key] : defaults[key];
    if (isPositive(value)) out[key] = value;
  }
  return out;
}

/**
 * The secrets an errand carries to its runner: `{ openrouterKey?, proxy?, searchKey? }`, or null when it has
 * none. The key is `routeKey`, the named key keys.json holds for the agent's route, and a run with no such key carries
 * none (a claude or codex agent brings its own login, and a key of her model roles is never passed). `proxy` is the engine proxy in force now, null on the direct path. `searchKey` is the
 * stored Exa key in `privateDir`, for a run on an opencode `route` (`exaKeyOf`).
 */
function secretsFor({ routeKey = null, proxy = null, privateDir, route = null }: SecretsOptions): RunSecrets | null {
  const secrets: RunSecrets = {};
  if (typeof routeKey === 'string' && routeKey) secrets.openrouterKey = routeKey;
  const form = httpProxyForm(proxy);
  if (form !== null) secrets.proxy = form;
  const searchKey = exaKeyOf(privateDir, route);
  if (searchKey !== null) secrets.searchKey = searchKey;
  return Object.keys(secrets).length > 0 ? secrets : null;
}

type SecretsOptions = {
  routeKey?: string | null;
  proxy?: string | null;
  privateDir?: string;
  route?: TaskRoute | null;
};

/**
 * The Exa key an errand carries: keys.json `services.exa`, read now, on an opencode route, which searches with Exa.
 * Null otherwise: claude and codex search with their own tools, and with no stored key OpenCode searches Exa's free
 * endpoint.
 */
function exaKeyOf(privateDir: string | undefined, route: TaskRoute | null): string | null {
  if (privateDir === undefined || route?.backend !== 'opencode') return null;
  return serviceCredential(privateDir, 'exa');
}

/** What the core decides for one errand at dispatch: its route, the key an opencode route spends, or why it cannot go. */
type Dispatch = { route: TaskRoute | null; key: string | null; error?: string };

/**
 * The route and the key of `agent`'s errand, read from config.json and keys.json now, since the runner's unit may hide
 * those files. The key is the named key `models.agents.opencodeKey` names, on an opencode route only: claude and codex agents search with their
 * harness's own tools and carry none. `route: null` while the agent has no
 * source (the runner then refuses with `subharness-off`), and an `error` code when either file cannot be read or an
 * opencode route has no key to spend.
 */
function dispatchOf(privateDir: string | undefined, agent: string, log: Logger): Dispatch {
  if (privateDir === undefined) return { route: null, key: null };
  let route: TaskRoute | null;
  let key: string | null = null;
  try {
    route = routeOfAgent(privateDir, agent);
    if (route?.backend === 'opencode') {
      key = opencodeKey(privateDir)?.value ?? null;
    }
  } catch (err) {
    log.warn('errands: config.json or keys.json unreadable, the errand is not sent', { agent, error: err });
    return { route: null, key: null, error: 'keys-unreadable' };
  }
  if (route?.backend === 'opencode' && !key) return { route, key: null, error: 'route-no-key' };
  return { route, key };
}

/**
 * The last `errands.recentLines` lines (read now; at most MAX_RECENT_ENTRIES) of channel
 * `placeId` in the memory's buffer of `placeId`, oldest first, as `{ author, text }` (the
 * display name and the text on one line; a line without text left
 * out). [] for a `dm` scope unless `openPrivate` (`context.memory.openPrivate`), without a channel or a buffer.
 */
function recentLinesOf(
  { memory, log }: { memory: ErrandServiceOptions['memory']; log: Logger },
  chatId: string | null,
  scope: ErrandScope,
  openPrivate: boolean
): RunContext['recent'] {
  if ((scope === 'dm' && !openPrivate) || !chatId || typeof memory?.recentLines !== 'function') return [];
  const count = Math.min(MAX_RECENT_ENTRIES, DEFAULT_RECENT_LINES);
  let lines: Array<{ author?: unknown; text?: unknown }>;
  try {
    lines = memory.recentLines(chatId, count, scope);
  } catch (err) {
    log.warn('errands: recent lines unreadable', { code: errorCode(err) });
    return [];
  }
  return (Array.isArray(lines) ? lines : [])
    .map((line) => ({
      author: oneLine(line.author ?? ''),
      text: oneLine(line.text ?? ''),
    }))
    .filter((line) => line.text)
    .slice(-count);
}

/** The share of an errand's context its stored facts may take: a context over the runner's cap refuses the whole run. */
const MEMORY_CONTEXT_CHARS = 8000;

/**
 * The stored facts of one errand's goal, through the one retrieval service. A private errand reads none, as it sends no
 * recent line, unless `openPrivate` (`context.memory.openPrivate`); a failed read leaves the errand its goal.
 */
async function memoryOf(
  retrieve: RetrieveForErrand | null | undefined,
  errand: ErrandRecord,
  log: Logger,
  openPrivate: boolean
): Promise<NonNullable<RunContext['memory']>> {
  if (typeof retrieve !== 'function' || (errand.scope === 'dm' && !openPrivate)) return [];
  try {
    const page = await retrieve({ purpose: 'task', goal: errand.goal, refs: [] });
    const out: NonNullable<RunContext['memory']> = [];
    let used = 0;
    for (const fact of page?.assertions ?? []) {
      used += fact.text.length;
      if (used > MEMORY_CONTEXT_CHARS) break;
      out.push({ text: fact.text, state: fact.state, polarity: fact.polarity });
    }
    return out;
  } catch (err) {
    log.warn('errands: retrieval failed', { code: errorCode(err) });
    return [];
  }
}

/**
 * The origin and visible recent lines that accompany one dispatched errand, with the day it is sent (`today`, the UTC
 * date of `at`) and the folder of the engine's checkout (`engine`).
 */
function dispatchContext(errand: ErrandRecord, recent: RunContext['recent'], at: number, engine: string): RunContext {
  return {
    today: new Date(at).toISOString().slice(0, 10),
    engine,
    scope: errand.scope,
    channel: errand.origin?.placeId ?? null,
    asker: errand.requester?.accountId ?? null,
    recent,
  };
}

/** The `run` of one dispatched errand: who it is for, its context and limits, and the secrets and route when it has them. */
function runRequestOf(
  errand: ErrandRecord,
  recent: RunContext['recent'],
  sent: { at: number; engine: string },
  limits: Limits,
  secrets: RunSecrets | null,
  route: TaskRoute | null,
  memory: NonNullable<RunContext['memory']> = []
): RunRequest {
  const { agent, id, goal } = errand;
  const context = {
    ...dispatchContext(errand, recent, sent.at, sent.engine),
    ...(memory.length > 0 ? { memory } : {}),
  };
  return { agent, id, goal, context, limits, ...(secrets ? { secrets } : {}), ...(route ? { route } : {}) };
}

/** Whether a chat (`dmChatId`, null for a server channel) sees `errand`: a group one anywhere, a private one in its own chat. */
const inChat = (errand: ErrandRecord, dmChatId: string | null): boolean =>
  errand.scope !== 'dm' || (dmChatId !== null && errand.origin?.placeId === String(dmChatId));

/** `{ expired: true, errand }` for the expired file `handle` of an errand this chat may see, else null. */
function expiredFile(
  store: ErrandStore,
  handle: string,
  dmChatId: string | null,
  openPrivate: boolean
): ExpiredFileRef | null {
  const errand = store.get(
    idText(handle)
      .replace(/^file:/, '')
      .split('/')[0]
  );
  if (!errand || (!openPrivate && !inChat(errand, dmChatId))) return null;
  return { expired: true, errand };
}

/**
 * The waits of the turns for their errands, over the timer `setTimer`: `wait` resolves at the errand's end, which `end`
 * reports, or when its time runs out first.
 */
function createWaits(setTimer: (fn: () => void, ms: number) => TimerHandle): {
  wait: (store: ErrandStore | null, id: string, ms: number) => Promise<WaitResult>;
  end: (store: ErrandStore, errand: ErrandRecord) => void;
} {
  // errand id -> what resolves the turn's wait for it, while one waits.
  const waiters = new Map<string, (errand: ErrandRecord | null) => void>();

  /** The wait for `errand` resolved, if one waits: the errand is marked seen and read first, since her call shows it. */
  function end(store: ErrandStore, errand: ErrandRecord): void {
    const resolve = waiters.get(errand.id);
    if (resolve === undefined) return;
    waiters.delete(errand.id);
    store.markSeen(errand.id);
    resolve(store.markRead(errand.id) ?? errand);
  }

  /**
   * Waits up to `ms` for errand `id`: `{ ended: true, errand }` at its end (an errand that ended already answers at
   * once), `{ ended: false, errand }` when the time runs out first, with the errand left open and unread.
   */
  function wait(store: ErrandStore | null, id: string, ms: number): Promise<WaitResult> {
    const errand = store?.get(id) ?? null;
    if (!store || !errand) return Promise.resolve({ ended: false, errand: null });
    if (!isOpenState(errand.state)) {
      store.markSeen(id);
      return Promise.resolve({ ended: true, errand: store.markRead(id) ?? errand });
    }
    return new Promise((resolve) => {
      const timer = setTimer(() => {
        waiters.delete(id);
        resolve({ ended: false, errand: store.get(id) });
      }, ms);
      waiters.set(id, (ended) => {
        clearTimeout(timer);
        resolve({ ended: true, errand: ended });
      });
    });
  }

  return { wait, end };
}

/**
 * `hot` holds the live config. `proxy`
 * is the engine proxy in force, read as each errand is sent. `memory` gives the channel's newest lines, oldest first (src/index.ts reads them from the memory
 * database): an errand's `context.recent`. `defer` is how
 * the background run starts (setImmediate by default). `now` is the clock of the runner rechecks and of the date a run
 * is told.
 */
export function createErrandService({
  client,
  stores,
  hot,
  agentPaths,
  privateDir,
  memory = null,
  retrieve = null,
  onFinished = null,
  log = defaultLog,
  defer = (fn) => setImmediate(fn),
  now = Date.now,
  proxy = () => null,
  setTimer = (fn, ms) => setTimeout(fn, ms),
}: ErrandServiceOptions): ErrandService {
  // errand id -> the promise of its run, while it runs (tests and the shutdown wait on them).
  const running = new Map<string, Promise<ErrandRecord | null>>();

  // errand id -> its `context.recent`, from its queuing until it is sent (never written to disk).
  const recentById = new Map<string, RunContext['recent']>();
  // unit -> { up: boolean, checkedAt: ms of the last recheck ping } once anything is known.
  const health = new Map<string, { up: boolean; checkedAt: number | null }>();
  const waits = createWaits(setTimer);

  /** The unit of `agent`, or null for a name that is no agent. */
  const unitOf = (agent: string): string | null => profileOf(agent, agentPaths)?.unit ?? null;

  /** The health flag of `unit` set to `up` (`code` why it is down); logged when it changes. */
  function setHealth(unit: string | null | undefined, up: boolean, code: string | null = null): void {
    if (!unit) return;
    const entry = health.get(unit);
    if (entry?.up === up) return;
    health.set(unit, { up, checkedAt: entry?.checkedAt ?? null });
    if (up) log.info('errands: runner up', { unit });
    else log.warn('errands: runner down', { unit, code: code ?? null });
  }

  // The connect loop's outcomes: the health flag of each runner.
  client?.onLink?.((event) => setHealth(event?.unit, event?.up === true, event?.code ?? null));

  /**
   * One ping of `agent`'s runner (a pong sets its flag up, a failed ping down), in the
   * background. Resolves the flag; never throws.
   */
  async function check(agent: string): Promise<boolean | null> {
    if (typeof client?.ping !== 'function') return null;
    if (typeof client.configured === 'function' && !client.configured(agent)) return null;
    let answer: PingAnswer;
    try {
      answer = await client.ping(agent);
    } catch (err) {
      answer = { ok: false, error: errorCode(err) ?? 'client-error' };
    }
    const error = answer.ok ? null : answer.error;
    // Not set up (meanwhile) tells nothing about the runner.
    if (error === CODE.NOT_CONFIGURED) return health.get(unitOf(agent) ?? '')?.up ?? null;
    setHealth(unitOf(agent), answer.ok, error);
    return answer.ok;
  }

  /** Whether `agent`'s runner is known down now; a refusal rechecks it at most once per RUNNER_RECHECK_MS. */
  function runnerDown(agent: string): boolean {
    const entry = health.get(unitOf(agent) ?? '');
    if (entry?.up !== false) return false;
    const at = now();
    if (entry.checkedAt === null || at - entry.checkedAt >= RUNNER_RECHECK_MS) {
      entry.checkedAt = at;
      check(agent).catch(() => {});
    }
    return true;
  }

  /** The store of `placeId`, else of the served place. */
  function storeOf(): ErrandStore | null {
    return stores.get();
  }

  const limitsOf = (agent: string): Limits => limitsFor(agent, hot.config, agentPaths);
  const recentOf = (chatId: string | null, scope: ErrandScope): RunContext['recent'] =>
    recentLinesOf({ memory, log }, chatId, scope, opensPrivate(hot.config));

  /** A finished errand handed on: the wait for it resolved, then its result turn. Never throws. */
  async function ended(store: ErrandStore, finished: ErrandRecord): Promise<void> {
    waits.end(store, finished);
    if (typeof onFinished !== 'function') return;
    try {
      await onFinished(finished);
    } catch (err) {
      log.warn('errands: onFinished failed', { id: finished.id, error: err });
    }
  }

  /** One queued errand given its agent, sent to its runner and closed with its end. Never throws. */
  async function runErrand(store: ErrandStore, id: string): Promise<ErrandRecord | null> {
    const recent = recentById.get(id) ?? [];
    recentById.delete(id);
    const errand = store.start(id);
    if (!errand) return null;
    const { agent } = errand;
    let outcome: FinishOutcome;
    try {
      const { route, key, error } = dispatchOf(privateDir, agent, log);
      const secrets = secretsFor({ routeKey: key, proxy: proxy(), privateDir, route });
      outcome =
        error !== undefined
          ? { status: 'failed', error }
          : // `run` is always on the core's client; a fake without it throws into the catch
            await client.run!(
              runRequestOf(
                errand,
                recent,
                { at: now(), engine: engineRoot(agentPaths) },
                limitsOf(agent),
                secrets,
                route,
                await memoryOf(retrieve, errand, log, opensPrivate(hot.config))
              )
            );
    } catch (err) {
      log.warn('errands: run failed', { id: errand.id, agent, error: err });
      outcome = { status: 'failed', error: 'client-error' };
    }
    const finished = store.finish(errand.id, outcome ?? { status: 'failed', error: 'client-error' });
    if (!finished) return null;
    await ended(store, finished);
    return finished;
  }

  /**
   * A new errand queued and, once the caller has its answer, started in the background:
   * `{ ok: true, errand }` (the errand as queued) or `{ ok: false, code }` (the store's refusal,
   * `not-configured` when the agent is off, `runner-down` while its runner is
   * known unreachable, `no-place` without a place).
   * An errand the store already holds under the call's `idempotencyKey` is answered as it is
   * (`duplicate: true`), never run again.
   */
  function submit({ agent, goal, requester, origin, scope, idempotencyKey = null }: SubmitInput): AddResult {
    const store = storeOf();
    if (!store) return { ok: false, code: CODE.PLACE_REQUIRED };
    if (!profileOf(agent, agentPaths)) return { ok: false, code: CODE.UNKNOWN_AGENT };
    if (typeof client?.configured === 'function' && !client.configured(agent))
      return { ok: false, code: CODE.NOT_CONFIGURED };
    if (runnerDown(agent)) return { ok: false, code: CODE.RUNNER_DOWN };
    const added = store.add({ agent, goal, requester, origin, scope, idempotencyKey });
    if (!added.ok || added.duplicate) return added;
    const { errand } = added;
    const id = errand.id;
    // The channel as it was when the errand was asked for, not when it is sent.
    recentById.set(id, recentOf(errand.origin?.placeId ?? null, errand.scope));
    // After the operation's answer: the persona never waits for her errand.
    const run = new Promise<void>((resolve) => defer(resolve))
      .then(() => runErrand(store, id))
      .finally(() => running.delete(id));
    running.set(id, run);
    return added;
  }

  /**
   * Errand `id` cancelled: the store closes it and the runner is told. `by`, who cancelled it, is the caller's
   * account of the cancel; the service keeps nothing of it. `{ ok, errand }` or `{ ok: false, code }`.
   */
  function cancel({ id }: { id: string; by?: string }): CancelResult {
    const store = storeOf();
    if (!store) return { ok: false, code: CODE.PLACE_REQUIRED };
    const errand = store.get(id);
    if (!errand) return { ok: false, code: CODE.NOT_FOUND };
    if (!isOpenState(errand.state)) return { ok: false, code: CODE.NOT_OPEN, errand };
    const wasRunning = errand.state === 'running';
    const closed = store.cancel(id);
    if (closed) waits.end(store, closed);
    if (wasRunning) client.cancel?.({ agent: errand.agent, id: errand.id });
    return { ok: true, errand: closed };
  }

  /** The gateway's budget of a new `agent` errand (src/tools/gateway.ts): the store's caps. */
  function budget({ agent }: { agent: string }): Budget | null {
    const store = storeOf();
    return store ? store.budget(agent) : null;
  }

  /**
   * The errands the persona sees in a turn's `<errands>` block: the open ones, then the finished ones
   * she has not read nor closed (`readAt`, `resolvedAt`; whether a result turn ran does not hide
   * one), oldest first. In a server channel only the `group` ones; in a private
   * chat (`dmChatId`) also the `dm` ones asked in that chat; every one with `context.memory.openPrivate`.
   */
  function view({ dmChatId = null }: { dmChatId?: string | null } = {}): Array<ErrandRecord> {
    const store = storeOf();
    if (!store) return [];
    const open = opensPrivate(hot.config);
    return [...store.open(), ...store.unread()].filter((errand) => open || inChat(errand, dmChatId));
  }

  /**
   * The file a handle `file:<errand id>/<name>` names (src/errands/store.ts#fileOf), for a
   * chat that may see its errand (view's rule: a private chat's errand only in that chat);
   * null otherwise.
   */
  function fileOf({ handle, dmChatId = null }: { handle?: unknown; dmChatId?: string | null } = {}):
    ErrandFileRef | ExpiredFileRef | null {
    const store = storeOf();
    const file = store ? store.fileOf(handle) : null;
    // Files the runner has deleted: a marker the callers refuse as `file-expired`, never a path.
    const open = opensPrivate(hot.config);
    if (!file) return store?.fileExpired?.(handle) === true ? expiredFile(store, idText(handle), dmChatId, open) : null;
    if (!open && !inChat(file.errand, dmChatId)) return null;
    return file;
  }

  /**
   * The errands `ids` marked through the store's `mark`: `markSeen` (a turn of hers showed them), `markRead` (their
   * result turn completed, or `errand.read` returned them) or `markResultFailed` (their result turn never completed,
   * kept unread). Answers how many were marked.
   */
  const marking =
    (mark: 'markSeen' | 'markRead' | 'markResultFailed') =>
    ({ ids = [] }: IdsInput = {}): number => {
      const store = storeOf();
      return store ? ids.filter((id) => store[mark](id) !== null).length : 0;
    };
  const markSeen = marking('markSeen');
  const markRead = marking('markRead');
  const markResultFailed = marking('markResultFailed');

  /**
   * The errands of the served place a restart left open, failed (`restarted`). Each enabled
   * agent's runner is pinged in the background (its health flag).
   */
  function start(): number {
    // Each enabled agent's runner pinged in the background: its flag known before the first ask.
    for (const agent of Object.keys(loadProfiles(agentPaths))) check(agent).catch(() => {});
    const store = storeOf();
    if (!store) return 0;
    const failed = store.failOpen('restarted');
    if (failed > 0) log.info('errands: open tasks failed at start', { count: failed });
    // Finished errands whose result turn never ran (a restart cut it short, or it kept failing), an errand asked with no
    // place included: their turn is opened again, one after another through the turn runner's own cooldown.
    if (typeof onFinished === 'function') {
      const waiting = store.unseen();
      if (waiting.length > 0) log.info('errands: result turns reopened at start', { count: waiting.length });
      for (const errand of waiting)
        defer(() =>
          Promise.resolve(onFinished(errand)).catch((err) =>
            log.warn('errands: onFinished failed', { id: errand.id, error: err })
          )
        );
    }
    return failed;
  }

  /** Wait for the runs in flight (tests). */
  async function idle(): Promise<void> {
    while (running.size > 0) await Promise.allSettled([...running.values()]);
  }

  return {
    submit,
    wait: ({ id, ms }) => waits.wait(storeOf(), id, ms),
    cancel,
    budget,
    view,
    fileOf,
    markSeen,
    markRead,
    markResultFailed,
    start,
    idle,
    check,
    runnerUp: (agent) => health.get(unitOf(agent) ?? '')?.up ?? null,
    store: storeOf,
    limitsOf,
  };
}
