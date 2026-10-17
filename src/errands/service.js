// The persona's errands in the background: a task the `task.run` operation accepted (queued in
// the guild's task store, src/errands/store.js) is handed to its agent runner through the client
// (src/errands/client.js) right after the operation answered -- nobody waits for it. The task is
// `running` from the moment it is sent, with the limits of `agents.<profile>.limits` (the
// profile's defaults under them) and a context the runner applies its scope policy to
// (`scope`: `dm` for a task asked in a private chat, else `group`; the origin channel; who
// asked). Its `end` writes the result into the store and calls `onFinished(task)` -- the turn
// that brings it back to the persona (src/errands/turns.js); a task cancelled meanwhile ends
// without one. At start the tasks a restart left open are failed (`restarted`): the runner sends
// a task's end on the connection that brought it, which is gone. Settings are read at the moment
// of use; logs carry ids and codes, never a goal or a result.

import { log as defaultLog } from '../log.js';
import { profileOf } from '../agent-runner/profiles.js';
import { isOpenState } from './store.js';

/** The limit keys a task may carry to its runner (src/agent-runner/protocol.js#LIMIT_KEYS). */
const TASK_LIMIT_KEYS = Object.freeze(['steps', 'usd', 'seconds']);

/**
 * @param {object} options
 * @param {ReturnType<import('./client.js').createErrandClient>} options.client
 * @param {{ get(guildId: string): object|null }} options.stores  src/errands/store.js#createTaskStores
 * @param {{ config: object }} options.hot
 * @param {() => string|null} [options.getGuildId]  The served guild, when a caller gives none.
 * @param {(task: object, guildId: string) => unknown} [options.onFinished]
 * @param {{ info: Function, warn: Function }} [options.log]
 * @param {(fn: Function) => void} [options.defer]  How the background run starts (default setImmediate).
 */
export function createErrandService({ client, stores, hot, getGuildId = () => null, onFinished = null, log = defaultLog, defer = (fn) => setImmediate(fn) }) {
  // task id -> the promise of its run, while it runs (tests and the shutdown wait on them).
  const running = new Map();

  /** The store of `guildId`, else of the served guild. */
  function storeOf(guildId) {
    return stores.get(guildId || getGuildId?.() || '');
  }

  /** The limits a task of `agent` runs under: `agents.<agent>.limits` over the profile's defaults. */
  function limitsOf(agent) {
    const set = hot.config?.agents?.[agent]?.limits ?? {};
    const out = {};
    for (const key of TASK_LIMIT_KEYS) {
      const value = Number.isFinite(set[key]) && set[key] > 0 ? set[key] : profileOf(agent)?.defaultLimits?.[key];
      if (Number.isFinite(value) && value > 0) out[key] = value;
    }
    return out;
  }

  /** One queued task sent to its runner and closed with its end. Never throws. */
  async function runTask(store, id) {
    const task = store.start(id);
    if (!task) return null;
    let outcome;
    try {
      outcome = await client.run({
        agent: task.agent,
        id: task.id,
        goal: task.goal,
        context: { scope: task.scope, channel: task.origin?.channelId ?? null, asker: task.requester?.userId ?? null },
        limits: limitsOf(task.agent),
      });
    } catch (err) {
      log.warn('errands: run failed', { id: task.id, agent: task.agent, error: err });
      outcome = { status: 'failed', error: 'client-error' };
    }
    const finished = store.finish(task.id, outcome ?? { status: 'failed', error: 'client-error' });
    if (!finished) return null;
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
   * `not-configured` when the agent's runner is not set up, `no-guild` without a guild).
   * @param {{ guildId?: string, agent: string, goal: string, requester: object, origin: object, scope: 'dm'|'group' }} input
   */
  function submit({ guildId = null, agent, goal, requester, origin, scope }) {
    const store = storeOf(guildId);
    if (!store) return { ok: false, code: 'no-guild' };
    if (!profileOf(agent)) return { ok: false, code: 'unknown-agent' };
    if (typeof client?.configured === 'function' && !client.configured(agent)) return { ok: false, code: 'not-configured' };
    const added = store.add({ agent, goal, requester, origin, scope });
    if (!added.ok) return added;
    const id = added.task.id;
    // After the operation's answer: the persona never waits for her errand.
    const run = new Promise((resolve) => defer(resolve))
      .then(() => runTask(store, id))
      .finally(() => running.delete(id));
    running.set(id, run);
    return added;
  }

  /** Task `id` cancelled: the store closes it, the runner is told. `{ ok, task }` or `{ ok: false, code }`. */
  function cancel({ guildId = null, id }) {
    const store = storeOf(guildId);
    if (!store) return { ok: false, code: 'no-guild' };
    const task = store.get(id);
    if (!task) return { ok: false, code: 'not-found' };
    if (!isOpenState(task.state)) return { ok: false, code: 'not-open', task };
    const wasRunning = task.state === 'running';
    const closed = store.cancel(id);
    if (wasRunning) client.cancel?.({ agent: task.agent, id: task.id });
    return { ok: true, task: closed };
  }

  /** The gateway's budget of a new `agent` task (src/skills/gateway.js): the store's caps. */
  function budget({ guildId = null, agent } = {}) {
    const store = storeOf(guildId);
    return store ? store.budget(agent) : null;
  }

  /**
   * The tasks the persona sees in a turn's `<tasks>` block: the open ones, then the finished ones
   * she has not seen, oldest first. In a server channel only the `group` ones; in a private
   * chat (`privateChannelId`) also the `dm` ones asked in that chat.
   */
  function view({ guildId = null, privateChannelId = null } = {}) {
    const store = storeOf(guildId);
    if (!store) return [];
    const visible = (task) => task.scope !== 'dm' || (privateChannelId !== null && task.origin?.channelId === String(privateChannelId));
    return [...store.open(), ...store.unseen()].filter(visible);
  }

  /**
   * The file a handle `file:<task id>/<name>` names (src/errands/store.js#fileOf), for a
   * conversation that may see its task (view's rule: a private chat's task only in that chat);
   * null otherwise.
   */
  function fileOf({ guildId = null, handle, privateChannelId = null } = {}) {
    const store = storeOf(guildId);
    const file = store ? store.fileOf(handle) : null;
    if (!file) return null;
    if (file.task.scope === 'dm' && (privateChannelId === null || file.task.origin?.channelId !== String(privateChannelId))) return null;
    return file;
  }

  /** The tasks `ids` marked as seen by the persona (a turn of hers showed them). */
  function markSeen({ guildId = null, ids = [] } = {}) {
    const store = storeOf(guildId);
    if (!store) return 0;
    let marked = 0;
    for (const id of ids) if (store.markSeen(id)) marked += 1;
    return marked;
  }

  /** The tasks of the served guild a restart left open, failed (`restarted`). */
  function start(guildId) {
    const store = storeOf(guildId);
    if (!store) return 0;
    const failed = store.failOpen('restarted');
    if (failed > 0) log.info('errands: open tasks failed at start', { guildId: store.guildId, count: failed });
    return failed;
  }

  /** Wait for the runs in flight (tests). */
  async function idle() {
    while (running.size > 0) await Promise.allSettled([...running.values()]);
  }

  return { submit, cancel, budget, view, fileOf, markSeen, start, idle, store: storeOf, limitsOf };
}
