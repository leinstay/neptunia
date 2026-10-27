// The persona's errands in the background: a task the `errand.run` operation accepted (queued in
// the guild's task store, src/errands/store.ts) is handed to its agent runner through the client
// (src/errands/client.ts) right after the operation answered -- nobody waits for it. The task is
// `running` from the moment it is sent, with the limits of the profile (`limits`, overridable under `agents.<profile>`; the
// profile's defaults under them) and a context the runner applies its scope policy to
// (`scope`: `dm` for a task asked in a private chat, else `group`; the origin channel; who
// asked). Its `end` writes the result into the store and calls `onFinished(task)` -- the turn
// that brings it back to the persona (src/errands/turns.ts); a task cancelled meanwhile ends
// without one. At start the tasks a restart left open are failed (`restarted`): the runner sends
// a task's end on the connection that brought it, which is gone. Every run carries the task's
// secrets (`secrets` of src/agent-runner/protocol.js), since every key lives in the core's .env
// and the runner cannot read it: the key of the agent's model role (`scout`, `server`)
// as the bot resolves a role's key (src/llm/openrouter.js#roleApiKey over `llm.keyByRole`; never
// the persona's main key), and for `scout` the residential proxy of the video fetches
// (MEDIA_VIDEO_PROXY, the same proxy serving http too, so a `socks5h://` URL is sent in its http
// form) and the search key (OPENCODE_WEBSEARCH_KEY) when set. Without the role's key no secrets
// are sent (the runner falls back to its own environment). Settings are read at the moment of
// use; logs carry ids and codes, never a goal, a result or a secret. The context also carries
// `recent`: the last `errands.recentLines` lines of the origin channel as `[{ author, text }]`
// (display names and text on one line, cut to RECENT_CHARS), read from the memory's buffer
// (the memory database's newest lines of the channel) at the moment the task is queued and kept in memory only until it is sent;
// a `dm`-scoped task sends `recent: []` (nothing of a private chat reaches a runner this way).
// Every errand is also mirrored into the ledger (src/errands/ledger.ts, `agents.ledger.socket`,
// disabled while null): at its queuing (with its limits, for the ledger's triage), its start (with its limits and the model of its agent's
// role), the runner's progress, its end and its cancel (`by` who cancelled it), and at start the
// open tasks a restart found without a ledger id; the ledger's id is kept on the task
// (`ledgerId`). The mirror never throws into an errand and never changes how one runs.
// Each agent has a health flag: the latest outcome of the client's connect loop (`onLink`) or of
// a ping (a pong is up; a failed ping down), unknown until the first. While an agent's runner is
// down a new task is refused at once (`runner-down`), before anything is queued, so the caller
// (the lookup's errand lane) falls back while it still can, instead of an `ok` the runner then
// fails a few ms later. At start each enabled agent is pinged in the background (the flag is
// known before the first ask), and a refusal pings the runner again, at most once per
// RUNNER_RECHECK_MS, so the flag flips back even when the client's reconnect loop has stopped.
// The flag is logged once per change (`errands: runner up` / `errands: runner down`).

import { log as defaultLog } from '../log.js';
import { PROFILES, agentSettings, profileOf } from '../agent-runner/profiles.js';
import { roleApiKey } from '../llm/openrouter.js';
import { roleModel } from '../llm/roles.js';
import { MAX_RECENT_ENTRIES, RECENT_CHARS, httpProxyForm } from '../agent-runner/protocol.js';
import { clampChars, oneLine } from '../memory/clamp.js';
import { isOpenState } from './store.ts';
import { createLedgerMirror } from './ledger.ts';
import { DEFAULT_RESULT_MAX_CHARS } from './blocks.ts';
import { CODE } from '../tools/codes.ts';
import { errorCode, idText, isPositive, objOf, textOf } from '../tools/types.ts';
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
  RunContext,
  RunSecrets,
  SubmitInput,
} from './types.ts';

/** The limit keys a task may carry to its runner (src/agent-runner/protocol.js#LIMIT_KEYS). */
const TASK_LIMIT_KEYS = Object.freeze(['steps', 'seconds'] as const);
/** `errands.recentLines` when it is missing (config.json carries the same). */
export const DEFAULT_RECENT_LINES = 6;
/** The least time between two pings a `runner-down` refusal sends to recheck its runner (ms). */
export const RUNNER_RECHECK_MS = 10_000;

/** The limits a task of `agent` runs under: its profile's `limits` under the deployment's override. */
function limitsFor(agent: string, config: Untyped): Limits {
  const set: Record<string, number> = agentSettings(agent, config)?.limits ?? {};
  // profiles.js types a profile as `object`, so its default limits are read through objOf.
  const defaults = objOf(objOf(profileOf(agent)).defaultLimits);
  const out: Limits = {};
  for (const key of TASK_LIMIT_KEYS) {
    const value = isPositive(set[key]) ? set[key] : defaults[key];
    if (isPositive(value)) out[key] = value;
  }
  return out;
}

/**
 * The secrets a task of `agent` carries to its runner: `{ openrouterKey, proxy?, searchKey? }`,
 * or null when the agent's role has no key of its own (never the main key: none is passed).
 */
function secretsFor(agent: string, config: Untyped, env: Record<string, string | undefined>): RunSecrets | null {
  const profile = objOf(profileOf(agent));
  // The main key is never passed (an empty one: a role without a key of its own gets none).
  const openrouterKey = profile.modelRole ? roleApiKey(config, env, profile.modelRole, '') : null;
  if (typeof openrouterKey !== 'string' || !openrouterKey) return null;
  const secrets: RunSecrets = { openrouterKey };
  if (profile.name === 'scout') {
    const proxy = httpProxyForm(env?.MEDIA_VIDEO_PROXY);
    if (proxy) secrets.proxy = proxy;
    const searchKey = typeof env?.OPENCODE_WEBSEARCH_KEY === 'string' ? env.OPENCODE_WEBSEARCH_KEY.trim() : '';
    if (searchKey) secrets.searchKey = searchKey;
  }
  return secrets;
}

/**
 * The last `errands.recentLines` lines (read now; at most MAX_RECENT_ENTRIES) of channel
 * `channelId` in the memory's buffer of `guildId`, oldest first, as `{ author, text }` (the
 * display name and the text on one line, each cut to RECENT_CHARS; a line without text left
 * out). [] for a `dm` scope, without a channel or a buffer.
 */
function recentLinesOf(
  { memory, config, log }: { memory: ErrandServiceOptions['memory']; config: Untyped; log: Logger },
  guildId: string,
  channelId: string | null,
  scope: ErrandScope
): RunContext['recent'] {
  if (scope === 'dm' || !channelId || typeof memory?.recentLines !== 'function') return [];
  const set = config?.errands?.recentLines;
  const count = Math.min(MAX_RECENT_ENTRIES, Number.isFinite(set) && set >= 0 ? Math.floor(set) : DEFAULT_RECENT_LINES);
  if (count === 0) return [];
  let lines: Array<{ author?: unknown; text?: unknown }>;
  try {
    lines = memory.recentLines(guildId, channelId, count);
  } catch (err) {
    log.warn('errands: recent lines unreadable', { guildId: String(guildId), code: errorCode(err) });
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

/**
 * `hot` holds the live config. `env` is the parsed environment (src/config.js#env): the keys and the proxy a run
 * carries. `memory` gives the channel's newest lines, oldest first (src/index.js reads them from the memory
 * database): a task's `context.recent`. `getGuildId` names the served guild when a caller gives none. `defer` is how
 * the background run starts (setImmediate by default). `ledger` is the ledger mirror, by default one over
 * `agents.ledger.socket`, read at the moment of use. `now` is the clock of the runner rechecks.
 */
export function createErrandService({
  client,
  stores,
  hot,
  env = {},
  memory = null,
  getGuildId = () => null,
  onFinished = null,
  log = defaultLog,
  defer = (fn) => setImmediate(fn),
  ledger = null,
  now = Date.now,
}: ErrandServiceOptions): ErrandService {
  // task id -> the promise of its run, while it runs (tests and the shutdown wait on them).
  const running = new Map<string, Promise<ErrandRecord | null>>();
  // task id -> the task as it started, while its runner works on it (its progress goes to the ledger).
  const live = new Map<string, ErrandRecord>();
  const mirror = ledger ?? createLedgerMirror({ socketPath: () => hot.config?.agents?.ledger?.socket ?? null, log });

  /** One call of the ledger mirror; a failure is logged, never thrown into the errand. */
  function mirrored(id: string | null, fn: () => unknown): void {
    try {
      fn();
    } catch (err) {
      log.warn('errands: ledger mirror failed', { id, error: err });
    }
  }

  /** The handler that keeps the ledger's id of task `id` in `store`. */
  function keepLedgerId(store: ErrandStore, id: string): (ledgerId: string) => unknown {
    return (ledgerId) => store.setLedgerId?.(id, ledgerId);
  }

  /** `errands.resultMaxChars`, read now. */
  function resultMaxChars(): number {
    const set = hot.config?.errands?.resultMaxChars;
    return Number.isFinite(set) && set > 0 ? set : DEFAULT_RESULT_MAX_CHARS;
  }

  // The runner's progress of a task under way: the ledger's heartbeat.
  client?.onProgress?.((event) => {
    const task = live.get(event?.id);
    if (task) mirrored(task.id, () => mirror.progress(task));
  });
  // task id -> its `context.recent`, from its queuing until it is sent (never written to disk).
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

  /** The store of `guildId`, else of the served guild. */
  function storeOf(guildId?: unknown): ErrandStore | null {
    return stores.get(guildId || getGuildId?.() || '');
  }

  const limitsOf = (agent: string): Limits => limitsFor(agent, hot.config);
  const secretsOf = (agent: string): RunSecrets | null => secretsFor(agent, hot.config, env);
  const recentOf = (guildId: string, channelId: string | null, scope: ErrandScope): RunContext['recent'] =>
    recentLinesOf({ memory, config: hot.config, log }, guildId, channelId, scope);

  /** One queued task sent to its runner and closed with its end. Never throws. */
  async function runTask(store: ErrandStore, id: string): Promise<ErrandRecord | null> {
    const recent = recentById.get(id) ?? [];
    recentById.delete(id);
    const task = store.start(id);
    if (!task) return null;
    const secrets = secretsOf(task.agent);
    const limits = limitsOf(task.agent);
    mirrored(task.id, () =>
      mirror.start(task, {
        limits,
        model: roleModel(hot.config, textOf(objOf(profileOf(task.agent)).modelRole)) ?? null,
      })
    );
    live.set(task.id, task);
    let outcome: FinishOutcome;
    try {
      outcome = await client.run({
        agent: task.agent,
        id: task.id,
        goal: task.goal,
        context: {
          scope: task.scope,
          channel: task.origin?.channelId ?? null,
          asker: task.requester?.userId ?? null,
          recent: task.scope === 'dm' ? [] : recent,
        },
        limits,
        ...(secrets ? { secrets } : {}),
      });
    } catch (err) {
      log.warn('errands: run failed', { id: task.id, agent: task.agent, error: err });
      outcome = { status: 'failed', error: 'client-error' };
    } finally {
      live.delete(task.id);
    }
    const finished = store.finish(task.id, outcome ?? { status: 'failed', error: 'client-error' });
    if (!finished) return null;
    mirrored(finished.id, () => mirror.finish(finished, { maxChars: resultMaxChars() }));
    if (typeof onFinished === 'function') {
      try {
        await onFinished(finished, store.guildId);
      } catch (err) {
        log.warn('errands: onFinished failed', { id: finished.id, error: err });
      }
    }
    return finished;
  }

  /**
   * A new task queued and, once the caller has its answer, started in the background:
   * `{ ok: true, task }` (the task as queued) or `{ ok: false, code }` (the store's refusal, or
   * `not-configured` when the agent's runner is not set up, `runner-down` while its runner is
   * known unreachable, `no-guild` without a guild).
   * A task the store already holds under the call's `idempotencyKey` is answered as it is
   * (`duplicate: true`), never run again.
   */
  function submit({
    guildId = null,
    agent,
    goal,
    requester,
    origin,
    scope,
    idempotencyKey = null,
  }: SubmitInput): AddResult {
    const store = storeOf(guildId);
    if (!store) return { ok: false, code: CODE.NO_GUILD };
    if (!profileOf(agent)) return { ok: false, code: CODE.UNKNOWN_AGENT };
    if (typeof client?.configured === 'function' && !client.configured(agent))
      return { ok: false, code: CODE.NOT_CONFIGURED };
    if (runnerDown(agent)) return { ok: false, code: CODE.RUNNER_DOWN };
    const added = store.add({ agent, goal, requester, origin, scope, idempotencyKey });
    if (!added.ok || added.duplicate) return added;
    const id = added.task.id;
    mirrored(id, () =>
      mirror.add(added.task, { guildId: store.guildId, limits: limitsOf(agent), onLedgerId: keepLedgerId(store, id) })
    );
    // The channel as it was when the task was asked for, not when it is sent.
    recentById.set(id, recentOf(store.guildId, added.task.origin?.channelId ?? null, added.task.scope));
    // After the operation's answer: the persona never waits for her errand.
    const run = new Promise<void>((resolve) => defer(resolve))
      .then(() => runTask(store, id))
      .finally(() => running.delete(id));
    running.set(id, run);
    return added;
  }

  /**
   * Task `id` cancelled: the store closes it, the runner is told, the ledger gets
   * `cancelled-by-<by>`. `{ ok, task }` or `{ ok: false, code }`.
   */
  function cancel({
    guildId = null,
    id,
    by = 'unknown',
  }: {
    guildId?: string | null;
    id: string;
    by?: string;
  }): CancelResult {
    const store = storeOf(guildId);
    if (!store) return { ok: false, code: CODE.NO_GUILD };
    const task = store.get(id);
    if (!task) return { ok: false, code: CODE.NOT_FOUND };
    if (!isOpenState(task.state)) return { ok: false, code: CODE.NOT_OPEN, task };
    const wasRunning = task.state === 'running';
    const closed = store.cancel(id);
    if (wasRunning) client.cancel?.({ agent: task.agent, id: task.id });
    if (closed) mirrored(closed.id, () => mirror.cancel(closed, { by }));
    return { ok: true, task: closed };
  }

  /** The gateway's budget of a new `agent` task (src/tools/gateway.ts): the store's caps. */
  function budget({ guildId = null, agent }: { guildId?: string | null; agent?: string } = {}): Budget | null {
    const store = storeOf(guildId);
    return store ? store.budget(agent ?? '') : null;
  }

  /**
   * The tasks the persona sees in a turn's `<errands>` block: the open ones, then the finished ones
   * she has not read nor closed (`readAt`, `resolvedAt`; whether a result turn ran does not hide
   * one), oldest first. In a server channel only the `group` ones; in a private
   * chat (`privateChannelId`) also the `dm` ones asked in that chat.
   */
  function view({
    guildId = null,
    privateChannelId = null,
  }: { guildId?: string | null; privateChannelId?: string | null } = {}): Array<ErrandRecord> {
    const store = storeOf(guildId);
    if (!store) return [];
    const visible = (task: ErrandRecord): boolean =>
      task.scope !== 'dm' || (privateChannelId !== null && task.origin?.channelId === String(privateChannelId));
    return [...store.open(), ...store.unread()].filter(visible);
  }

  /** `{ expired: true, task }` for the expired file `handle` of a task this conversation may see, else null. */
  function expiredFile(store: ErrandStore, handle: string, privateChannelId: string | null): ExpiredFileRef | null {
    const task = store.get(
      idText(handle)
        .replace(/^file:/, '')
        .split('/')[0]
    );
    if (
      !task ||
      (task.scope === 'dm' && (privateChannelId === null || task.origin?.channelId !== String(privateChannelId)))
    )
      return null;
    return { expired: true, task };
  }

  /**
   * The file a handle `file:<task id>/<name>` names (src/errands/store.ts#fileOf), for a
   * conversation that may see its task (view's rule: a private chat's task only in that chat);
   * null otherwise.
   */
  function fileOf({
    guildId = null,
    handle,
    privateChannelId = null,
  }: { guildId?: string | null; handle?: unknown; privateChannelId?: string | null } = {}):
    ErrandFileRef | ExpiredFileRef | null {
    const store = storeOf(guildId);
    const file = store ? store.fileOf(handle) : null;
    // Files the runner has deleted: a marker the callers refuse as `file-expired`, never a path.
    if (!file)
      return store?.fileExpired?.(handle) === true ? expiredFile(store, idText(handle), privateChannelId) : null;
    if (
      file.task.scope === 'dm' &&
      (privateChannelId === null || file.task.origin?.channelId !== String(privateChannelId))
    )
      return null;
    return file;
  }

  /** The tasks `ids` marked as seen by the persona (a turn of hers showed them). */
  function markSeen({ guildId = null, ids = [] }: IdsInput = {}): number {
    const store = storeOf(guildId);
    if (!store) return 0;
    let marked = 0;
    for (const id of ids) if (store.markSeen(id)) marked += 1;
    return marked;
  }

  /** The tasks `ids` marked as read by the persona (their result turn completed, or `errand.read` returned them). */
  function markRead({ guildId = null, ids = [] }: IdsInput = {}): number {
    const store = storeOf(guildId);
    if (!store) return 0;
    let marked = 0;
    for (const id of ids) if (store.markRead(id)) marked += 1;
    return marked;
  }

  /** The tasks `ids` noted as ones whose result turn never completed (kept unread; the `<errands>` line says so). */
  function markResultFailed({ guildId = null, ids = [] }: IdsInput = {}): number {
    const store = storeOf(guildId);
    if (!store) return 0;
    let marked = 0;
    for (const id of ids) if (store.markResultFailed(id)) marked += 1;
    return marked;
  }

  /**
   * The tasks of the served guild a restart left open, failed (`restarted`): those without a
   * ledger id mirrored first, then each one's failure. Each enabled agent's runner is pinged
   * in the background (its health flag).
   */
  function start(guildId: unknown): number {
    // Each enabled agent's runner pinged in the background: its flag known before the first ask.
    for (const agent of Object.keys(PROFILES)) check(agent).catch(() => {});
    const store = storeOf(guildId);
    if (!store) return 0;
    const open = store.open();
    mirrored(null, () =>
      mirror.mirrorOpen(open, {
        guildId: store.guildId,
        limitsOf: (task) => limitsOf(task.agent),
        onLedgerId: (task, ledgerId) => {
          store.setLedgerId?.(task.id, ledgerId);
        },
      })
    );
    const failed = store.failOpen('restarted');
    for (const task of open) {
      const ended = store.get(task.id);
      if (ended && !isOpenState(ended.state))
        mirrored(ended.id, () => mirror.finish(ended, { maxChars: resultMaxChars() }));
    }
    if (failed > 0) log.info('errands: open tasks failed at start', { guildId: store.guildId, count: failed });
    // Finished errands whose result turn never ran (a restart cut it short, or it kept failing):
    // their turn is opened again, one after another through the turn runner's own cooldown.
    if (typeof onFinished === 'function') {
      const waiting = store.unseen().filter((task) => task.origin?.channelId);
      if (waiting.length > 0)
        log.info('errands: result turns reopened at start', { guildId: store.guildId, count: waiting.length });
      for (const task of waiting)
        defer(() =>
          Promise.resolve(onFinished(task, store.guildId)).catch((err) =>
            log.warn('errands: onFinished failed', { id: task.id, error: err })
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
    ledger: mirror,
  };
}
