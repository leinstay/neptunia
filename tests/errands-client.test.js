// Tests for src/errands/client.js: the core's client of the agent runners' sockets, against a
// FAKE runner -- a plain Unix-socket server in the test that reads the client's lines and answers
// what the test tells it to. A run resolves on its `end`, progress reaches the listeners, cancel
// and ping go out as lines, a dropped connection fails its tasks with `disconnected` and is
// reopened, a profile that is not set up answers `not-configured` without connecting, and each
// outcome of the connect loop reaches the `onLink` listeners.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createErrandClient } from '../src/errands/client.js';
import { encodeLine } from '../src/agent-runner/protocol.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

function socketPath() {
  return path.join(os.tmpdir(), `errand-sock-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
}

/** A fake runner: collects each connection's request lines; `reply(obj)` writes to the newest one. */
async function fakeRunner(sock) {
  const connections = [];
  const requests = [];
  const waiters = [];
  const server = net.createServer((conn) => {
    connections.push(conn);
    conn.setEncoding('utf8');
    let buffer = '';
    conn.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const request = JSON.parse(line);
        requests.push(request);
        for (let i = waiters.length - 1; i >= 0; i -= 1) {
          if (waiters[i].match(request)) {
            waiters[i].resolve(request);
            waiters.splice(i, 1);
          }
        }
      }
    });
    conn.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(sock, resolve));
  return {
    connections,
    requests,
    next: (match) => new Promise((resolve) => {
      const found = requests.find(match);
      if (found) return resolve(found);
      waiters.push({ match, resolve });
    }),
    reply: (obj) => connections[connections.length - 1].write(encodeLine(obj)),
    dropAll: () => { for (const conn of connections) conn.destroy(); },
    close: () => new Promise((resolve) => {
      for (const conn of connections) conn.destroy();
      server.close(() => resolve());
      if (fs.existsSync(sock)) fs.unlinkSync(sock);
    }),
  };
}

function hotFor(sock, { enabled = true } = {}) {
  return { config: { agents: { web: { enabled, socket: sock }, server: { enabled: false, socket: sock } } } };
}

/** Short timers, so a reconnect happens within the test. */
const fastTimer = (fn, ms) => setTimeout(fn, Math.min(ms, 20));

test('errands client: a profile that is not enabled answers not-configured without connecting', async () => {
  let connects = 0;
  const client = createErrandClient({ hot: hotFor('/nowhere', { enabled: false }), connect: () => { connects += 1; throw new Error('must not connect'); } });
  const outcome = await client.run({ agent: 'web', id: 't1', goal: 'look' });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error, 'not-configured');
  assert.deepEqual(await client.ping('server'), { ok: false, error: 'not-configured' });
  const unknown = await client.run({ agent: 'mail', id: 't2', goal: 'x' });
  assert.equal(unknown.error, 'not-configured');
  assert.equal(connects, 0);
  assert.equal(client.configured('web'), false);
  client.close();
});

test('errands client: a run sends its line, progress reaches the listeners, the end resolves it', async () => {
  const sock = socketPath();
  const runner = await fakeRunner(sock);
  const client = createErrandClient({ hot: hotFor(sock) });
  const progress = [];
  client.onProgress((event) => progress.push(event));
  try {
    await withCapturedLogs(async () => {
      const running = client.run({ agent: 'web', id: 'task-1', goal: 'find a meme', context: { scope: 'group' }, limits: { steps: 3, usd: 0.1, seconds: 30 } });
      const request = await runner.next((r) => r.op === 'run');
      assert.deepEqual(request, { op: 'run', id: 'task-1', goal: 'find a meme', context: { scope: 'group' }, limits: { steps: 3, usd: 0.1, seconds: 30 } });
      runner.reply({ id: 'task-1', event: 'progress', step: 1, tool: 'search', note: 'looking' });
      runner.reply({ id: 'task-1', event: 'end', status: 'done', result: { text: 'found', sources: ['https://example.org/a'], files: [{ path: '/out/task-1/a.png', name: 'a.png', contentType: 'image/png', bytes: 10 }] }, usage: { steps: 2, usd: 0.01 } });
      const outcome = await running;
      assert.equal(outcome.status, 'done');
      assert.equal(outcome.result.text, 'found');
      assert.deepEqual(outcome.result.sources, ['https://example.org/a']);
      assert.equal(outcome.result.files[0].name, 'a.png');
      assert.equal(outcome.usage.steps, 2);
      assert.equal(outcome.error, undefined);
      assert.deepEqual(progress, [{ agent: 'web', id: 'task-1', step: 1, tool: 'search', note: 'looking' }]);
    });
  } finally {
    client.close();
    await runner.close();
  }
});

test('errands client: a run\'s secrets go out on its line and into no log line', async () => {
  const sock = socketPath();
  const runner = await fakeRunner(sock);
  const client = createErrandClient({ hot: hotFor(sock) });
  const secrets = { openrouterKey: 'sk-SECRET', proxy: 'http://u:SECRET@proxy.example:8000' };
  try {
    const { logs } = await withCapturedLogs(async () => {
      const running = client.run({ agent: 'web', id: 'task-s', goal: 'look', secrets });
      const request = await runner.next((r) => r.op === 'run');
      assert.deepEqual(request.secrets, secrets);
      runner.reply({ id: 'task-s', event: 'end', status: 'done', result: { text: 'ok' }, usage: {} });
      await running;
    });
    assert.ok(logs.some((entry) => entry.msg === 'errands: sent'), 'the run was logged');
    assert.ok(!JSON.stringify(logs).includes('SECRET'));
  } finally {
    client.close();
    await runner.close();
  }
});

test('errands client: cancel and ping go out as lines; a pong answers the ping', async () => {
  const sock = socketPath();
  const runner = await fakeRunner(sock);
  const client = createErrandClient({ hot: hotFor(sock) });
  try {
    await withCapturedLogs(async () => {
      const running = client.run({ agent: 'web', id: 'task-c', goal: 'slow' });
      await runner.next((r) => r.op === 'run');
      assert.equal(client.cancel({ agent: 'web', id: 'task-c' }), true);
      await runner.next((r) => r.op === 'cancel' && r.id === 'task-c');
      const pinged = client.ping('web');
      const ping = await runner.next((r) => r.op === 'ping');
      assert.deepEqual(ping.ids, ['task-c'], 'the ping names the tasks still waited for');
      runner.reply({ event: 'pong', profile: 'web', busy: true, queued: 0 });
      assert.deepEqual(await pinged, { ok: true, profile: 'web', busy: true, queued: 0 });
      runner.reply({ id: 'task-c', event: 'end', status: 'cancelled', error: 'cancelled' });
      const outcome = await running;
      assert.equal(outcome.status, 'cancelled');
      assert.equal(outcome.error, 'cancelled');
    });
  } finally {
    client.close();
    await runner.close();
  }
});

test('errands client: a runner error about a task fails it with that code', async () => {
  const sock = socketPath();
  const runner = await fakeRunner(sock);
  const client = createErrandClient({ hot: hotFor(sock) });
  try {
    await withCapturedLogs(async () => {
      const running = client.run({ agent: 'web', id: 'task-e', goal: 'x' });
      await runner.next((r) => r.op === 'run');
      runner.reply({ id: 'task-e', event: 'error', error: 'bad-scope' });
      const outcome = await running;
      assert.equal(outcome.status, 'failed');
      assert.equal(outcome.error, 'bad-scope');
    });
  } finally {
    client.close();
    await runner.close();
  }
});

test('errands client: a dropped connection fails its tasks as disconnected and is reopened', async () => {
  const sock = socketPath();
  const runner = await fakeRunner(sock);
  const client = createErrandClient({ hot: hotFor(sock), setTimer: fastTimer });
  try {
    await withCapturedLogs(async () => {
      const running = client.run({ agent: 'web', id: 'task-d', goal: 'x', limits: { seconds: 60 } });
      await runner.next((r) => r.op === 'run');
      runner.dropAll();
      const outcome = await running;
      assert.equal(outcome.status, 'failed');
      assert.equal(outcome.error, 'disconnected');
      // The backoff reopens the link on its own.
      for (let i = 0; i < 100 && runner.connections.length < 2; i += 1) await new Promise((r) => setTimeout(r, 10));
      assert.equal(runner.connections.length, 2, 'reconnected');
      const again = client.run({ agent: 'web', id: 'task-d2', goal: 'y' });
      await runner.next((r) => r.op === 'run' && r.id === 'task-d2');
      runner.reply({ id: 'task-d2', event: 'end', status: 'done', result: { text: 'ok' }, usage: {} });
      assert.equal((await again).status, 'done');
    });
  } finally {
    client.close();
    await runner.close();
  }
});

test('errands client: a runner that is not listening fails the run as disconnected', async () => {
  const client = createErrandClient({ hot: hotFor(socketPath()), setTimer: fastTimer });
  try {
    await withCapturedLogs(async () => {
      const outcome = await client.run({ agent: 'web', id: 'task-n', goal: 'x' });
      assert.equal(outcome.status, 'failed');
      assert.equal(outcome.error, 'disconnected');
    });
  } finally {
    client.close();
  }
});

test('errands client: onLink gets each outcome of the connect loop: a failed connect, an open link, a dropped one', async () => {
  const sock = socketPath();
  const client = createErrandClient({ hot: hotFor(sock), setTimer: (fn, ms) => setTimeout(fn, Math.max(ms, 60_000)) });
  const events = [];
  client.onLink((event) => events.push(event));
  let runner = null;
  try {
    await withCapturedLogs(async () => {
      assert.deepEqual(await client.ping('web'), { ok: false, error: 'disconnected' });
      assert.deepEqual(events, [{ agent: 'web', up: false, code: 'ENOENT' }]);
      runner = await fakeRunner(sock);
      const pinging = client.ping('web');
      await runner.next((r) => r.op === 'ping');
      assert.deepEqual(events.at(-1), { agent: 'web', up: true });
      runner.reply({ event: 'pong', profile: 'web', busy: false, queued: 0 });
      assert.equal((await pinging).ok, true);
      runner.dropAll();
      for (let i = 0; i < 100 && events.length < 3; i += 1) await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(events.at(-1), { agent: 'web', up: false, code: 'disconnected' });
      assert.equal(events.length, 3);
    });
  } finally {
    client.close();
    if (runner) await runner.close();
  }
});
