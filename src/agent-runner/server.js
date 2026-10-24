// The runner's Unix-socket server: the bot (the core) connects and sends
// JSON-line requests (`run`, `cancel`, `ping`, src/agent-runner/protocol.js);
// the runner answers `progress` events while a task works and one `end` per
// task. One connection may carry many tasks, and several connections may be
// open, but a runner works one task at a time -- the rest wait in a queue, so
// a slow scout errand never overlaps another. `cancel` aborts the running task
// or drops a queued one; `ping` lets the core learn that a task the runner no
// longer knows (it restarted between the run and now) has failed, so the core
// stops waiting. On startup the socket is chmod 660 (the core's group reaches
// it); on SIGTERM every open task ends `failed`/`restarted` and the process
// exits. The task engine (`run`) is injected (src/agent-runner/opencode.js in
// production, a fake in tests); this module is the transport and the queue.
// A task's `secrets` pass to the engine and nowhere else: no log line here
// carries a request; nor does one carry a task's `preamble`. `liveIds` names the tasks still in hand, so the output
// sweep (src/agent-runner/sweep.js) never removes their directories.

import net from 'node:net';
import fs from 'node:fs';
import { log } from '../log.js';
import {
  encodeLine, endEvent, errorEvent, parseRequestLine, pongEvent, progressEvent, restartedEvent,
} from './protocol.js';

/** The most ids the runner remembers as finished (to answer a late `ping` without a duplicate `end`). */
const FINISHED_MEMORY = 500;

/**
 * @param {object} options
 * @param {string} options.profile  The profile name (for `pong` and logs).
 * @param {{ run: Function }} options.runner  The task engine; `run({ id, goal, context, limits, model, cost, searchProvider, secrets, preamble, signal, onProgress })`.
 * @param {string} options.socketPath
 * @param {number} [options.socketMode]  The socket file mode (default 0o660).
 * @param {() => number} [options.now]
 */
export function createRunnerServer({ profile, runner, socketPath, socketMode = 0o660, now = Date.now }) {
  const queue = [];
  const seen = new Set();
  const finished = [];
  let current = null;
  let draining = false;
  const connections = new Set();

  /** Write one event to a connection, ignoring a closed socket. */
  function send(conn, event) {
    if (!conn || conn.destroyed) return;
    try {
      conn.write(encodeLine(event));
    } catch {
      // the core will reconcile through ping
    }
  }

  function rememberFinished(id) {
    finished.push(id);
    if (finished.length > FINISHED_MEMORY) {
      const dropped = finished.shift();
      // keep `seen` bounded too, but only drop ids no longer in flight
      if (dropped !== current?.id && !queue.some((item) => item.task.id === dropped)) seen.delete(dropped);
    }
  }

  async function runNext() {
    if (current || draining) return;
    const next = queue.shift();
    if (!next) return;
    const { task, conn } = next;
    const abort = new AbortController();
    current = { id: task.id, conn, abort };
    let outcome;
    try {
      outcome = await runner.run({
        id: task.id,
        goal: task.goal,
        context: task.context,
        limits: task.limits,
        model: task.model,
        cost: task.cost,
        searchProvider: task.searchProvider,
        secrets: task.secrets,
        preamble: task.preamble,
        signal: abort.signal,
        onProgress: (p) => send(conn, progressEvent({ id: task.id, step: p.step, tool: p.tool, note: p.note })),
      });
    } catch (err) {
      log.error('agent-runner: task crashed', { id: task.id, profile, error: err });
      outcome = { status: 'failed', result: {}, usage: {}, error: 'runner-error' };
    }
    current = null;
    rememberFinished(task.id);
    send(conn, endEvent({ id: task.id, status: outcome.status, result: outcome.result, usage: outcome.usage, error: outcome.error }));
    log.info('agent-runner: task end', { id: task.id, profile, status: outcome.status, steps: outcome.usage?.steps ?? 0 });
    setImmediate(runNext);
  }

  function handleRun(conn, task) {
    if (seen.has(task.id)) {
      // A re-sent id the runner already has or had: ignore the duplicate.
      return;
    }
    seen.add(task.id);
    queue.push({ task, conn });
    log.info('agent-runner: task queued', { id: task.id, profile, queued: queue.length });
    runNext();
  }

  function handleCancel(id) {
    if (current && current.id === id) {
      current.abort.abort();
      return;
    }
    const at = queue.findIndex((item) => item.task.id === id);
    if (at !== -1) {
      const [dropped] = queue.splice(at, 1);
      rememberFinished(id);
      send(dropped.conn, endEvent({ id, status: 'cancelled', error: 'cancelled' }));
    }
  }

  function handlePing(conn, ids) {
    send(conn, pongEvent({ profile, busy: Boolean(current), queued: queue.length }));
    for (const id of ids) {
      const inFlight = current?.id === id || queue.some((item) => item.task.id === id);
      if (!inFlight && !seen.has(id)) send(conn, restartedEvent(id));
    }
  }

  function onConnection(conn) {
    connections.add(conn);
    conn.on('close', () => connections.delete(conn));
    conn.setEncoding('utf8');
    let buffer = '';
    conn.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const parsed = parseRequestLine(line);
        if (!parsed.ok) {
          send(conn, errorEvent(parsed.error, parsed.id));
          continue;
        }
        const msg = parsed.message;
        if (msg.op === 'run') handleRun(conn, msg);
        else if (msg.op === 'cancel') handleCancel(msg.id);
        else if (msg.op === 'ping') handlePing(conn, msg.ids);
      }
    });
    conn.on('error', () => {});
  }

  const server = net.createServer(onConnection);

  /** Start listening on the socket (removing a stale one first), then chmod it. */
  function start() {
    return new Promise((resolve, reject) => {
      try {
        if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
      } catch {
        // a live socket here is caught by listen's EADDRINUSE below
      }
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        try {
          fs.chmodSync(socketPath, socketMode);
        } catch (err) {
          log.warn('agent-runner: chmod failed', { profile, reason: err?.code ?? 'chmod' });
        }
        log.info('agent-runner: listening', { profile, socket: socketPath });
        resolve();
      });
    });
  }

  /**
   * Stop: end every running and queued task `failed`/`restarted` (the core
   * marks them failed), close the server, and drop the socket file.
   */
  async function stop() {
    draining = true;
    if (current) {
      current.abort.abort();
      send(current.conn, restartedEvent(current.id));
      current = null;
    }
    for (const { task, conn } of queue.splice(0)) send(conn, restartedEvent(task.id));
    // Flush the pending ends, then half-close; a client that keeps its side
    // open is force-closed after a short grace so `close` cannot hang.
    for (const conn of connections) {
      try {
        conn.end();
      } catch {
        // already gone
      }
    }
    const grace = setTimeout(() => {
      for (const conn of connections) {
        try {
          conn.destroy();
        } catch {
          // already gone
        }
      }
    }, 100);
    grace.unref?.();
    await new Promise((resolve) => server.close(() => {
      clearTimeout(grace);
      resolve();
    }));
    connections.clear();
    try {
      if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    } catch {
      // nothing to clean
    }
  }

  /** The ids of the tasks the runner still has: the running one and the queued ones (the output sweep keeps their directories). */
  function liveIds() {
    return [...(current ? [current.id] : []), ...queue.map((item) => item.task.id)];
  }

  return { start, stop, server, liveIds, get queueLength() { return queue.length; }, get busy() { return Boolean(current); } };
}
