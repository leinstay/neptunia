// The persona's errands in the background: an errand the `errand.run` operation accepted (queued in
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
// runner cannot read it: the key of the agent's model role (`scout`, `server`) as the bot resolves
// a role's key (src/llm/openrouter.ts#roleApiKey over `llm.keyByRole`; never the persona's main
// key), or the extra key of an opencode route; the engine proxy of the moment (`proxy`, the core's
// monitor, src/net/proxy.ts) in its http form for every agent, so no harness child goes out from
// the server's own address while the proxy is on; the stored Exa key (keys.json `services.exa`) for an
// agent that searches with exa on an opencode route (`searchKey`). A run with none of them carries no secrets. Settings are read at the moment of
// use; logs carry ids and codes, never a goal, a result or a secret. The context also carries
// `recent`: the last `DEFAULT_RECENT_LINES` lines of the origin channel as `[{ author, text }]`
// (display names and text on one line, cut to RECENT_CHARS), read from the memory's buffer
// (the memory database's newest lines of the channel) at the moment the errand is queued and kept in memory only until it is sent;
// a `dm`-scoped errand sends `recent: []` (nothing of a private chat reaches a runner this way).
// Each agent has a health flag: the latest outcome of the client's connect loop (`onLink`) or of
// a ping (a pong is up; a failed ping down), unknown until the first. While an agent's runner is
// down a new errand is refused at once (`runner-down`), before anything is queued, so the caller
// (the lookup's errand lane) falls back while it still can, instead of an `ok` the runner then
// fails a few ms later. At start each enabled agent is pinged in the background (the flag is
// known before the first ask), and a refusal pings the runner again, at most once per
// RUNNER_RECHECK_MS, so the flag flips back even when the client's reconnect loop has stopped.
// The flag is logged once per change (`errands: runner up` / `errands: runner down`).

import { log as defaultLog } from '../log.ts';
import { loadProfiles, agentSettings, profileOf } from '../agent-runner/profiles.ts';
import type { AgentPaths } from '../agent-runner/profiles.ts';
import { roleApiKey } from '../llm/openrouter.ts';
import { hasExtraKey, readKeys, serviceCredential } from '../keys/file.ts';
import { routeOfAgent } from '../subharness/control.ts';
import { MAX_RECENT_ENTRIES, RECENT_CHARS } from '../agent-runner/protocol.ts';
import { httpProxyForm } from '../net/proxy.ts';
import type { TaskRoute } from '../agent-runner/protocol.ts';
import { clampChars, oneLine } from '../memory/clamp.ts';
import { isOpenState } from './store.ts';
import { CODE } from '../tools/codes.ts';
import { errorCode, idText, isPositive, objOf } from '../tools/types.ts';
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
 * The secrets an errand of `agent` carries to its runner: `{ openrouterKey?, proxy?, searchKey? }`, or null when it has
 * none. The key is the agent's role key (never the main key: none is passed); `keyOverride` replaces it, since a route
 * spends the extra key keys.json names, and a run with a route but no such key carries none (a claude or codex agent
 * brings its own login). `proxy` is the engine proxy in force now, null on the direct path. `searchKey` is the
 * stored Exa key in `privateDir`, for a run on `route` that searches with exa (`exaKeyOf`).
 */
function secretsFor(
  agent: string,
  config: Untyped,
  env: Record<string, string | undefined>,
  { agentPaths, keyOverride = null, routed = false, proxy = null, privateDir, route = null }: SecretsOptions
): RunSecrets | null {
  const profile = objOf(profileOf(agent, agentPaths));
  // The main key is never passed (an empty one: a role without a key of its own gets none).
  const openrouterKey =
    keyOverride ?? (!routed && profile.modelRole ? roleApiKey(config, env, profile.modelRole, '') : null);
  const secrets: RunSecrets = {};
  if (typeof openrouterKey === 'string' && openrouterKey) secrets.openrouterKey = openrouterKey;
  const form = httpProxyForm(proxy);
  if (form !== null) secrets.proxy = form;
  const searchKey = exaKeyOf(agent, config, { privateDir, route, agentPaths });
  if (searchKey !== null) secrets.searchKey = searchKey;
  return Object.keys(secrets).length > 0 ? secrets : null;
}

type SecretsOptions = {
  agentPaths?: AgentPaths;
  keyOverride?: string | null;
  routed?: boolean;
  proxy?: string | null;
  privateDir?: string;
  route?: TaskRoute | null;
};

/**
 * The Exa key an errand of `agent` carries: keys.json `services.exa`, read now, for an agent whose search provider is
 * `exa` on an opencode route. Null otherwise: claude and codex search with their own tools, and with no stored key
 * OpenCode searches Exa's free endpoint.
 */
function exaKeyOf(
  agent: string,
  config: Untyped,
  { privateDir, route, agentPaths }: { privateDir?: string; route: TaskRoute | null; agentPaths?: AgentPaths }
): string | null {
  if (privateDir === undefined || route?.backend !== 'opencode') return null;
  if (agentSettings(agent, config, agentPaths)?.searchProvider !== 'exa') return null;
  return serviceCredential(privateDir, 'exa');
}

/** What the core decides for one errand at dispatch: its route, the key an opencode route spends, or why it cannot go. */
type Dispatch = { route: TaskRoute | null; key: string | null; error?: string };

/**
 * The route and the key of `agent`'s errand, read from keys.json now, since the runner's unit may hide that file.
 * The key is `subharness.key`'s extra key on an opencode route only: claude and codex agents search with their
 * harness's own tools and carry none. `route: null` while the agent has no
 * source (the runner then refuses with `subharness-off`), and an `error` code when keys.json cannot be read or an
 * opencode route has no key to spend.
 */
function dispatchOf(privateDir: string | undefined, agent: string, log: Logger): Dispatch {
  if (privateDir === undefined) return { route: null, key: null };
  let route: TaskRoute | null;
  let key: string | null = null;
  try {
    route = routeOfAgent(privateDir, agent);
    if (route?.backend === 'opencode') {
      const store = readKeys(privateDir);
      const name = store.subharness.key;
      key = name !== null && hasExtraKey(store, name) ? (store.extra[name] ?? null) : null;
    }
  } catch (err) {
    log.warn('errands: keys.json unreadable, the errand is not sent', { agent, error: err });
    return { route: null, key: null, error: 'keys-unreadable' };
  }
  if (route?.backend === 'opencode' && !key) return { route, key: null, error: 'route-no-key' };
  return { route, key };
}

/**
 * The last `errands.recentLines` lines (read now; at most MAX_RECENT_ENTRIES) of channel
 * `placeId` in the memory's buffer of `placeId`, oldest first, as `{ author, text }` (the
 * display name and the text on one line, each cut to RECENT_CHARS; a line without text left
 * out). [] for a `dm` scope, without a channel or a buffer.
 */
function recentLinesOf(
  { memory, log }: { memory: ErrandServiceOptions['memory']; log: Logger },
  conversationId: string | null,
  scope: ErrandScope
): RunContext['recent'] {
  if (scope === 'dm' || !conversationId || typeof memory?.recentLines !== 'function') return [];
  const count = Math.min(MAX_RECENT_ENTRIES, DEFAULT_RECENT_LINES);
  let lines: Array<{ author?: unknown; text?: unknown }>;
  try {
    lines = memory.recentLines(conversationId, count);
  } catch (err) {
    log.warn('errands: recent lines unreadable', { code: errorCode(err) });
    return [];
  }
  return (Array.isArray(lines) ? lines : [])
    .map((line) => ({
      author: clampChars(oneLine(line.author ?? ''), RECENT_CHARS),
      text: clampChars(oneLine(line.text ?? ''), RECENT_CHARS),
    }))
    .filter((line) => line.text)
    .slice(-count);
}

/** The share of an errand's context its stored facts may take: a context over the runner's cap refuses the whole run. */
const MEMORY_CONTEXT_CHARS = 8000;

/**
 * The stored facts of one errand's goal, through the one retrieval service. A private errand reads none, as it sends no
 * recent line, and a failed read leaves the errand its goal.
 */
async function memoryOf(
  retrieve: RetrieveForErrand | null | undefined,
  errand: ErrandRecord,
  log: Logger
): Promise<NonNullable<RunContext['memory']>> {
  if (typeof retrieve !== 'function' || errand.scope === 'dm') return [];
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

/** The origin and visible recent lines that accompany one dispatched errand. */
function dispatchContext(errand: ErrandRecord, recent: RunContext['recent']): RunContext {
  return {
    scope: errand.scope,
    channel: errand.origin?.placeId ?? null,
    asker: errand.requester?.accountId ?? null,
    recent: errand.scope === 'dm' ? [] : recent,
  };
}

/** The `run` of one dispatched errand: who it is for, its context and limits, and the secrets and route when it has them. */
function runRequestOf(
  errand: ErrandRecord,
  recent: RunContext['recent'],
  limits: Limits,
  secrets: RunSecrets | null,
  route: TaskRoute | null,
  memory: NonNullable<RunContext['memory']> = []
): RunRequest {
  const { agent, id, goal } = errand;
  const context = { ...dispatchContext(errand, recent), ...(memory.length > 0 ? { memory } : {}) };
  return { agent, id, goal, context, limits, ...(secrets ? { secrets } : {}), ...(route ? { route } : {}) };
}

/**
 * `hot` holds the live config. `env` is the parsed environment (src/config.ts#env): the keys a run carries. `proxy`
 * is the engine proxy in force, read as each errand is sent. `memory` gives the channel's newest lines, oldest first (src/index.ts reads them from the memory
 * database): an errand's `context.recent`. `defer` is how
 * the background run starts (setImmediate by default). `now` is the clock of the runner rechecks.
 */
export function createErrandService({
  client,
  stores,
  hot,
  env = {},
  agentPaths,
  privateDir,
  memory = null,
  retrieve = null,
  onFinished = null,
  log = defaultLog,
  defer = (fn) => setImmediate(fn),
  now = Date.now,
  proxy = () => null,
}: ErrandServiceOptions): ErrandService {
  // errand id -> the promise of its run, while it runs (tests and the shutdown wait on them).
  const running = new Map<string, Promise<ErrandRecord | null>>();

  // errand id -> its `context.recent`, from its queuing until it is sent (never written to disk).
  const recentById = new Map<string, RunContext['recent']>();
  // agent -> { up: boolean, checkedAt: ms of the last recheck ping } once anything is known.
  const health = new Map<string, { up: boolean; checkedAt: number | null }>();

  /** The health flag of `agent` set to `up` (`code` why it is down); logged when it changes. */
  function setHealth(agent: string | undefined, up: boolean, code: string | null = null): void {
    if (!agent) return;
    const entry = health.get(agent);
    if (entry?.up === up) return;
    health.set(agent, { up, checkedAt: entry?.checkedAt ?? null });
    if (up) log.info('errands: runner up', { agent });
    else log.warn('errands: runner down', { agent, code: code ?? null });
  }

  // The connect loop's outcomes: the health flag of each runner.
  client?.onLink?.((event) => setHealth(event?.agent, event?.up === true, event?.code ?? null));

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
    if (error === CODE.NOT_CONFIGURED) return health.get(agent)?.up ?? null;
    setHealth(agent, answer.ok, error);
    return answer.ok;
  }

  /** Whether `agent`'s runner is known down now; a refusal rechecks it at most once per RUNNER_RECHECK_MS. */
  function runnerDown(agent: string): boolean {
    const entry = health.get(agent);
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
  const recentOf = (conversationId: string | null, scope: ErrandScope): RunContext['recent'] =>
    recentLinesOf({ memory, log }, conversationId, scope);

  /** One queued errand sent to its runner and closed with its end. Never throws. */
  async function runErrand(store: ErrandStore, id: string): Promise<ErrandRecord | null> {
    const recent = recentById.get(id) ?? [];
    recentById.delete(id);
    const errand = store.start(id);
    if (!errand) return null;
    let outcome: FinishOutcome;
    try {
      const { route, key, error } = dispatchOf(privateDir, errand.agent, log);
      const secrets = secretsFor(errand.agent, hot.config, env, {
        agentPaths,
        keyOverride: key,
        routed: route !== null,
        proxy: proxy(),
        privateDir,
        route,
      });
      outcome =
        error !== undefined
          ? { status: 'failed', error }
          : // `run` is always on the core's client; a fake without it throws into the catch
            await client.run!(
              runRequestOf(
                errand,
                recent,
                limitsOf(errand.agent),
                secrets,
                route,
                await memoryOf(retrieve, errand, log)
              )
            );
    } catch (err) {
      log.warn('errands: run failed', { id: errand.id, agent: errand.agent, error: err });
      outcome = { status: 'failed', error: 'client-error' };
    }
    const finished = store.finish(errand.id, outcome ?? { status: 'failed', error: 'client-error' });
    if (!finished) return null;
    if (typeof onFinished === 'function') {
      try {
        await onFinished(finished);
      } catch (err) {
        log.warn('errands: onFinished failed', { id: finished.id, error: err });
      }
    }
    return finished;
  }

  /**
   * A new errand queued and, once the caller has its answer, started in the background:
   * `{ ok: true, errand }` (the errand as queued) or `{ ok: false, code }` (the store's refusal, or
   * `not-configured` when the agent's runner is not set up, `runner-down` while its runner is
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
    if (wasRunning) client.cancel?.({ agent: errand.agent, id: errand.id });
    return { ok: true, errand: closed };
  }

  /** The gateway's budget of a new `agent` errand (src/tools/gateway.ts): the store's caps. */
  function budget({ agent }: { agent?: string } = {}): Budget | null {
    const store = storeOf();
    return store ? store.budget(agent ?? '') : null;
  }

  /**
   * The errands the persona sees in a turn's `<errands>` block: the open ones, then the finished ones
   * she has not read nor closed (`readAt`, `resolvedAt`; whether a result turn ran does not hide
   * one), oldest first. In a server channel only the `group` ones; in a private
   * chat (`privateChannelId`) also the `dm` ones asked in that chat.
   */
  function view({ privateChannelId = null }: { privateChannelId?: string | null } = {}): Array<ErrandRecord> {
    const store = storeOf();
    if (!store) return [];
    const visible = (errand: ErrandRecord): boolean =>
      errand.scope !== 'dm' || (privateChannelId !== null && errand.origin?.placeId === String(privateChannelId));
    return [...store.open(), ...store.unread()].filter(visible);
  }

  /** `{ expired: true, errand }` for the expired file `handle` of an errand this conversation may see, else null. */
  function expiredFile(store: ErrandStore, handle: string, privateChannelId: string | null): ExpiredFileRef | null {
    const errand = store.get(
      idText(handle)
        .replace(/^file:/, '')
        .split('/')[0]
    );
    if (
      !errand ||
      (errand.scope === 'dm' && (privateChannelId === null || errand.origin?.placeId !== String(privateChannelId)))
    )
      return null;
    return { expired: true, errand };
  }

  /**
   * The file a handle `file:<errand id>/<name>` names (src/errands/store.ts#fileOf), for a
   * conversation that may see its errand (view's rule: a private chat's errand only in that chat);
   * null otherwise.
   */
  function fileOf({ handle, privateChannelId = null }: { handle?: unknown; privateChannelId?: string | null } = {}):
    ErrandFileRef | ExpiredFileRef | null {
    const store = storeOf();
    const file = store ? store.fileOf(handle) : null;
    // Files the runner has deleted: a marker the callers refuse as `file-expired`, never a path.
    if (!file)
      return store?.fileExpired?.(handle) === true ? expiredFile(store, idText(handle), privateChannelId) : null;
    const { errand } = file;
    if (errand.scope === 'dm' && (privateChannelId === null || errand.origin?.placeId !== String(privateChannelId)))
      return null;
    return file;
  }

  /** The errands `ids` marked as seen by the persona (a turn of hers showed them). */
  function markSeen({ ids = [] }: IdsInput = {}): number {
    const store = storeOf();
    if (!store) return 0;
    let marked = 0;
    for (const id of ids) if (store.markSeen(id)) marked += 1;
    return marked;
  }

  /** The errands `ids` marked as read by the persona (their result turn completed, or `errand.read` returned them). */
  function markRead({ ids = [] }: IdsInput = {}): number {
    const store = storeOf();
    if (!store) return 0;
    let marked = 0;
    for (const id of ids) if (store.markRead(id)) marked += 1;
    return marked;
  }

  /** The errands `ids` noted as ones whose result turn never completed (kept unread; the `<errands>` line says so). */
  function markResultFailed({ ids = [] }: IdsInput = {}): number {
    const store = storeOf();
    if (!store) return 0;
    let marked = 0;
    for (const id of ids) if (store.markResultFailed(id)) marked += 1;
    return marked;
  }

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
    // Finished errands whose result turn never ran (a restart cut it short, or it kept failing):
    // their turn is opened again, one after another through the turn runner's own cooldown.
    if (typeof onFinished === 'function') {
      const waiting = store.unseen().filter((errand) => errand.origin?.placeId);
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
    runnerUp: (agent) => health.get(agent)?.up ?? null,
    store: storeOf,
    limitsOf,
  };
}
