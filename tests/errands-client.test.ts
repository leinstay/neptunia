// Tests for src/errands/client.ts: the core's client of the agent runners' sockets, against a
// FAKE runner -- a plain Unix-socket server in the test that reads the client's lines and answers
// what the test tells it to. A run resolves on its `end`, progress reaches the listeners, cancel
// and ping go out as lines, a dropped connection fails its tasks with `disconnected` and is
// reopened, a profile that is not set up answers `not-configured` without connecting, and each
// outcome of the connect loop reaches the `onLink` listeners. The deployment's preamble goes out
// on a run's line only when non-empty, read at each run: the files of prompts.local/preambles/ are
// picked by agent and by the agent's role model; prompts.local/agents.md
// (`hot.prompts.agents`) is never read as one. A run carries the live role model and the live
// `agents.<profile>.cost` (when usable), since the runners cannot read the private config.
import { consumers, consumerRig } from './fixtures/agent-consumers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createErrandClient } from '../src/errands/client.ts';
import { encodeLine } from '../src/agent-runner/protocol.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { ROLE_DEFAULTS } from '../src/llm/roles.ts';
import type { Untyped } from '../src/tools/types.ts';
import type { TaskRoute } from '../src/agent-runner/protocol.ts';
import { tempDir } from './fixtures/tmp.ts';

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

function socketPath() {
  return path.join(os.tmpdir(), `errand-sock-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
}

/** A fake runner: collects each connection's request lines; `reply(obj)` writes to the newest one. */
async function fakeRunner(sock: Untyped) {
  const connections: Array<Untyped> = [];
  const requests: Array<Untyped> = [];
  const waiters: Array<Untyped> = [];
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
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  return {
    connections,
    requests,
    next: (match: Untyped) =>
      new Promise<Untyped>((resolve) => {
        const found = requests.find(match);
        if (found) return resolve(found);
        waiters.push({ match, resolve });
      }),
    reply: (obj: Untyped) => connections[connections.length - 1].write(encodeLine(obj)),
    dropAll: () => {
      for (const conn of connections) conn.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const conn of connections) conn.destroy();
        server.close(() => resolve());
        if (fs.existsSync(sock)) fs.unlinkSync(sock);
      }),
  };
}

function hotFor(sock: Untyped, { enabled = true } = {}) {
  return { config: { agents: { scout: { enabled, socket: sock }, server: { enabled: false, socket: sock } } } };
}

/** Short timers, so a reconnect happens within the test. */
const fastTimer = (fn: Untyped, ms: number) => setTimeout(fn, Math.min(ms, 20));

test('errands client: a profile that is not enabled answers not-configured without connecting', async () => {
  let connects = 0;
  const client = createErrandClient({
    hot: hotFor('/nowhere', { enabled: false }),
    connect: () => {
      connects += 1;
      throw new Error('must not connect');
    },
  });
  const outcome = await client.run({ agent: 'scout', id: 't1', goal: 'look' });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error, 'not-configured');
  assert.deepEqual(await client.ping('server'), { ok: false, error: 'not-configured' });
  const unknown = await client.run({ agent: 'mail', id: 't2', goal: 'x' });
  assert.equal(unknown.error, 'not-configured');
  assert.equal(connects, 0);
  assert.equal(client.configured('scout'), false);
  client.close();
});

test('errands client: a run sends its line, progress reaches the listeners, the end resolves it', async () => {
  const sock = socketPath();
  const runner = await fakeRunner(sock);
  const client = createErrandClient({ hot: hotFor(sock) });
  const progress: Array<Untyped> = [];
  client.onProgress((event) => progress.push(event));
  try {
    await withCapturedLogs(async () => {
      const running = client.run({
        agent: 'scout',
        id: 'task-1',
        goal: 'find a meme',
        context: { scope: 'group' },
        limits: { steps: 3, seconds: 30 },
      });
      const request = await runner.next((r: Untyped) => r.op === 'run');
      assert.deepEqual(request, {
        op: 'run',
        id: 'task-1',
        goal: 'find a meme',
        context: { scope: 'group' },
        limits: { steps: 3, seconds: 30 },
        model: ROLE_DEFAULTS.scout,
      });
      runner.reply({ id: 'task-1', event: 'progress', step: 1, tool: 'search', note: 'looking' });
      runner.reply({
        id: 'task-1',
        event: 'end',
        status: 'done',
        result: {
          text: 'found',
          sources: ['https://example.org/a'],
          files: [{ path: '/out/task-1/a.png', name: 'a.png', contentType: 'image/png', bytes: 10 }],
        },
        usage: { steps: 2, usd: 0.01 },
      });
      const outcome = await running;
      assert.equal(outcome.status, 'done');
      assert.equal(outcome.result.text, 'found');
      assert.deepEqual(outcome.result.sources, ['https://example.org/a']);
      assert.equal(outcome.result.files[0].name, 'a.png');
      assert.equal(outcome.usage.steps, 2);
      assert.equal(outcome.error, undefined);
      assert.deepEqual(progress, [{ agent: 'scout', id: 'task-1', step: 1, tool: 'search', note: 'looking' }]);
    });
  } finally {
    client.close();
    await runner.close();
  }
});

test("errands client: a run's secrets go out on its line and into no log line", async () => {
  const sock = socketPath();
  const runner = await fakeRunner(sock);
  const client = createErrandClient({ hot: hotFor(sock) });
  const secrets = { openrouterKey: 'sk-SECRET', proxy: 'http://u:SECRET@proxy.example:8000' };
  try {
    const { logs } = await withCapturedLogs(async () => {
      const running = client.run({ agent: 'scout', id: 'task-s', goal: 'look', secrets });
      const request = await runner.next((r: Untyped) => r.op === 'run');
      assert.deepEqual(loose(request).secrets, secrets);
      runner.reply({ id: 'task-s', event: 'end', status: 'done', result: { text: 'ok' }, usage: {} });
      await running;
    });
    assert.ok(
      logs.some((entry) => entry.msg === 'errands: sent'),
      'the run was logged'
    );
    assert.ok(!JSON.stringify(logs).includes('SECRET'));
  } finally {
    client.close();
    await runner.close();
  }
});

test("errands client: the preamble goes out on a run's line only when non-empty, read at each run, and into no log line", async () => {
  const sock = socketPath();
  const runner = await fakeRunner(sock);
  const hot = hotFor(sock);
  const client = createErrandClient({ hot });
  const runOnce = async (id: string) => {
    const running = client.run({ agent: 'scout', id, goal: 'look' });
    const request = await runner.next((r: Untyped) => r.op === 'run' && r.id === id);
    runner.reply({ id, event: 'end', status: 'done', result: { text: 'ok' }, usage: {} });
    await running;
    return request;
  };
  try {
    const { logs } = await withCapturedLogs(async () => {
      assert.equal(Object.hasOwn(await runOnce('task-none'), 'preamble'), false, 'no prompts at all: none sent');
      loose(hot).prompts = { preambles: { all: '' } };
      assert.equal(Object.hasOwn(await runOnce('task-empty'), 'preamble'), false, 'an empty file: none sent');
      loose(hot).prompts = { preambles: { all: '  SHARED-PREAMBLE for every agent.\n' } };
      assert.equal(loose(await runOnce('task-with')).preamble, 'SHARED-PREAMBLE for every agent.');
      loose(hot).prompts = { agents: 'SHARED-PREAMBLE in the old agents.md' };
      assert.equal(
        Object.hasOwn(await runOnce('task-agents-md'), 'preamble'),
        false,
        'prompts.local/agents.md is not a preamble'
      );
      loose(hot).prompts = {};
      assert.equal(
        Object.hasOwn(await runOnce('task-gone'), 'preamble'),
        false,
        'the file removed: none sent from the next run'
      );
    });
    const sent = logs.filter((entry) => entry.msg === 'errands: sent');
    assert.equal(sent.length, 5);
    assert.ok(!JSON.stringify(logs).includes('SHARED-PREAMBLE'), 'no preamble in a log line');
  } finally {
    client.close();
    await runner.close();
  }
});

test('errands client: the preamble is composed from prompts.local/preambles/ by agent and the role model, logged by file names only', async () => {
  const sock = socketPath();
  const runner = await fakeRunner(sock);
  const hot = hotFor(sock);
  loose(hot.config).models = { errands: { scout: 'openrouter/moonshotai/kimi-k3' } };
  loose(hot).prompts = {
    preambles: {
      all: 'ALL-TEXT',
      scout: 'SCOUT-TEXT',
      '@moonshotai-kimi-k3': 'KIMI-TEXT',
      'scout@openrouter-openai-gpt-6-sol': 'SCOUT-SOL-TEXT',
    },
  };
  const client = createErrandClient({ hot });
  const runOnce = async (id: string, extra = {}) => {
    const running = client.run({ agent: 'scout', id, goal: 'look', ...extra });
    const request = await runner.next((r: Untyped) => r.op === 'run' && r.id === id);
    runner.reply({ id, event: 'end', status: 'done', result: { text: 'ok' }, usage: {} });
    await running;
    return request;
  };
  try {
    const { logs } = await withCapturedLogs(async () => {
      const onRole = await runOnce('task-role');
      assert.equal(
        loose(onRole).preamble,
        'ALL-TEXT\n\nSCOUT-TEXT\n\nKIMI-TEXT',
        'the role model picks the model file'
      );
      assert.equal(
        loose(onRole).model,
        'openrouter/moonshotai/kimi-k3',
        'the live role model is sent: the runner cannot read the private config'
      );
      assert.equal(Object.hasOwn(onRole, 'cost'), false, 'no cost is sent when the live config has none');

      loose(hot.config).models = { errands: { scout: 'openrouter/openai/gpt-6-sol' } };
      loose(hot.config.agents.scout).cost = { input: 2, output: 6 };
      loose(hot).prompts = { ...loose(hot).prompts, preambles: { ...loose(hot).prompts.preambles, all: '' } };
      const live = await runOnce('task-live');
      assert.equal(
        loose(live).preamble,
        'SCOUT-TEXT\n\nSCOUT-SOL-TEXT',
        'role and files read at each run; an emptied all.md sends nothing'
      );
      assert.equal(loose(live).model, 'openrouter/openai/gpt-6-sol', 'the role model is read at each run');
      assert.deepEqual(loose(live).cost, { input: 2, output: 6 }, 'the live price is sent');

      loose(hot.config.agents.scout).cost = { input: 2, output: Number.NaN };
      const unusable = await runOnce('task-bad-cost');
      assert.equal(Object.hasOwn(unusable, 'cost'), false, 'a price without finite input and output is not sent');
      assert.equal(loose(unusable).model, 'openrouter/openai/gpt-6-sol');
    });
    const sent = logs.filter((entry) => entry.msg === 'errands: sent');
    assert.deepEqual(
      sent.map((entry) => entry.preambleFiles),
      [
        ['preambles/all.md', 'preambles/scout.md', 'preambles/@moonshotai-kimi-k3.md'],
        ['preambles/scout.md', 'preambles/scout@openrouter-openai-gpt-6-sol.md'],
        ['preambles/scout.md', 'preambles/scout@openrouter-openai-gpt-6-sol.md'],
      ]
    );
    assert.deepEqual(
      sent.map((entry) => entry.model),
      ['openrouter/moonshotai/kimi-k3', 'openrouter/openai/gpt-6-sol', 'openrouter/openai/gpt-6-sol'],
      'the model id is logged'
    );
    assert.ok(
      sent.every((entry) => !Object.hasOwn(entry, 'cost')),
      'the cost is not logged'
    );
    assert.equal(sent[0].preambleChars, 'ALL-TEXT\n\nSCOUT-TEXT\n\nKIMI-TEXT'.length);
    assert.ok(!/-TEXT/.test(JSON.stringify(logs)), 'no preamble text in a log line');
  } finally {
    client.close();
    await runner.close();
  }
});

test('errands client: without a role in the live config the run carries the engine default model and no cost', async () => {
  const sock = socketPath();
  const runner = await fakeRunner(sock);
  const client = createErrandClient({ hot: hotFor(sock) });
  try {
    await withCapturedLogs(async () => {
      const running = client.run({ agent: 'scout', id: 'task-bare', goal: 'look' });
      const request = await runner.next((r: Untyped) => r.op === 'run' && r.id === 'task-bare');
      assert.equal(loose(request).model, ROLE_DEFAULTS.scout, 'the role resolves to its engine default');
      assert.equal(Object.hasOwn(request, 'cost'), false, 'no cost without agents.scout.cost');
      runner.reply({ id: 'task-bare', event: 'end', status: 'done', result: { text: 'ok' }, usage: {} });
      await running;
    });
  } finally {
    client.close();
    await runner.close();
  }
});

// Stage X: the cap test that stood here is gone with the cap; tests/errands-client-preamble.test.ts checks a long
// preamble goes out whole.

test('errands client: cancel and ping go out as lines; a pong answers the ping', async () => {
  const sock = socketPath();
  const runner = await fakeRunner(sock);
  const client = createErrandClient({ hot: hotFor(sock) });
  try {
    await withCapturedLogs(async () => {
      const running = client.run({ agent: 'scout', id: 'task-c', goal: 'slow' });
      await runner.next((r: Untyped) => r.op === 'run');
      assert.equal(client.cancel({ agent: 'scout', id: 'task-c' }), true);
      await runner.next((r: Untyped) => r.op === 'cancel' && r.id === 'task-c');
      const pinged = client.ping('scout');
      const ping = await runner.next((r: Untyped) => r.op === 'ping');
      assert.deepEqual(loose(ping).ids, ['task-c'], 'the ping names the tasks still waited for');
      runner.reply({ event: 'pong', profile: 'scout', busy: true, queued: 0 });
      assert.deepEqual(await pinged, { ok: true, profile: 'scout', busy: true, queued: 0 });
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
      const running = client.run({ agent: 'scout', id: 'task-e', goal: 'x' });
      await runner.next((r: Untyped) => r.op === 'run');
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
      const running = client.run({ agent: 'scout', id: 'task-d', goal: 'x', limits: { seconds: 60 } });
      await runner.next((r: Untyped) => r.op === 'run');
      runner.dropAll();
      const outcome = await running;
      assert.equal(outcome.status, 'failed');
      assert.equal(outcome.error, 'disconnected');
      // The backoff reopens the link on its own.
      for (let i = 0; i < 100 && runner.connections.length < 2; i += 1) await new Promise((r) => setTimeout(r, 10));
      assert.equal(runner.connections.length, 2, 'reconnected');
      const again = client.run({ agent: 'scout', id: 'task-d2', goal: 'y' });
      await runner.next((r: Untyped) => r.op === 'run' && r.id === 'task-d2');
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
      const outcome = await client.run({ agent: 'scout', id: 'task-n', goal: 'x' });
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
  const events: Array<Untyped> = [];
  client.onLink((event) => events.push(event));
  let runner = null as Awaited<ReturnType<typeof fakeRunner>> | null; // assigned inside a callback, so no narrowing to null
  try {
    await withCapturedLogs(async () => {
      assert.deepEqual(await client.ping('scout'), { ok: false, error: 'disconnected' });
      assert.deepEqual(events, [{ agent: 'scout', up: false, code: 'ENOENT' }]);
      runner = await fakeRunner(sock);
      const pinging = client.ping('scout');
      await runner.next((r: Untyped) => r.op === 'ping');
      assert.deepEqual(events.at(-1), { agent: 'scout', up: true });
      runner.reply({ event: 'pong', profile: 'scout', busy: false, queued: 0 });
      assert.equal((await pinging).ok, true);
      runner.dropAll();
      for (let i = 0; i < 100 && events.length < 3; i += 1) await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(events.at(-1), { agent: 'scout', up: false, code: 'disconnected' });
      assert.equal(events.length, 3);
    });
  } finally {
    client.close();
    if (runner) await runner.close();
  }
});

test('the running client reads personal enabled settings beneath live config overrides', () => {
  const rig = consumerRig();
  const hot = { config: { agents: {} } };
  rig.override({ enabled: true });
  const client = consumers.client({ hot, agentPaths: rig.options });
  try {
    assert.equal(client.configured('scout'), true);
    rig.override({ enabled: false });
    assert.equal(client.configured('scout'), false);
    hot.config.agents = { scout: { enabled: true } };
    assert.equal(client.configured('scout'), true);
  } finally {
    client.close();
    rig.close();
  }
});

test('a reconnect timer contains an invalid personal edit without reconnecting or replaying the failed errand', async () => {
  const rig = consumerRig();
  const socket = path.join(rig.base, 'personal-runner.sock');
  rig.override({ enabled: true, socket });
  const connects: Array<string> = [];
  const timers: Array<{ fire: () => void; handle: ReturnType<typeof setTimeout> }> = [];
  const links: Array<{ agent: string; up: boolean; code?: string }> = [];
  const client = consumers.client({
    agentPaths: rig.options,
    hot: { config: { agents: {} } },
    connect: (selected) => {
      connects.push(selected);
      throw Object.assign(new Error('synthetic runner unavailable'), { code: 'ECONNREFUSED' });
    },
    setTimer: (fire) => {
      const handle = setTimeout(() => {}, 60000);
      handle.unref();
      timers.push({ fire, handle });
      return handle;
    },
    clearTimer: (timer) => clearTimeout(timer ?? undefined),
  });
  client.onLink((event) => links.push(event));
  try {
    const failed = await client.run({ agent: 'scout', id: 'synthetic-errand', goal: 'inspect synthetic files' });
    assert.deepEqual([failed.status, failed.error], ['failed', 'disconnected']);
    assert.deepEqual(connects, [socket]);
    assert.deepEqual(links, [{ agent: 'scout', up: false, code: 'ECONNREFUSED' }]);
    assert.equal(timers.length, 1);
    rig.override({ enabled: true, socket, limits: { seconds: 0 } });
    assert.doesNotThrow(() => timers[0]?.fire());
    await Promise.resolve();
    assert.deepEqual(connects, [socket], 'the failed errand cannot reopen a cached runner path');
    assert.equal(timers.length, 1, 'an invalid profile cannot schedule another retry');
    assert.equal(links.at(-1)?.up, false);
  } finally {
    client.close();
    for (const timer of timers) clearTimeout(timer.handle);
    rig.close();
  }
});

// The preamble the errand client (src/errands/client.ts) sends on a `run` line: every matching file of
// prompts.local/preambles/, whole, however long the composed text is. No cap, no dropped file, no cap warning.

/** A runner socket that hands over the first request line and answers it with a finished task. */
async function oneShotRunner(sock: string) {
  let resolveRequest: (request: Record<string, unknown>) => void = () => undefined;
  const firstRequest = new Promise<Record<string, unknown>>((resolve) => {
    resolveRequest = resolve;
  });
  const connections: Array<net.Socket> = [];
  const server = net.createServer((conn) => {
    connections.push(conn);
    conn.setEncoding('utf8');
    conn.on('error', () => undefined);
    let buffer = '';
    conn.on('data', (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const request = JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>;
      buffer = buffer.slice(nl + 1);
      if (request.op !== 'run') return;
      resolveRequest(request);
      conn.write(encodeLine({ id: request.id, event: 'end', status: 'done', result: { text: 'ok' }, usage: {} }));
    });
  });
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  return {
    firstRequest,
    close: () =>
      new Promise<void>((resolve) => {
        for (const conn of connections) conn.destroy();
        server.close(() => resolve());
      }),
  };
}

test('errands client: a composed preamble of 110000 characters goes out whole on the run line, with no cap warning', async () => {
  // Catches: the client still drops preamble files over a cap, so a deployment's long preamble loses a part unasked.
  const sock = path.join(os.tmpdir(), `errand-preamble-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
  const runner = await oneShotRunner(sock);
  const all = 'b'.repeat(70_000);
  const scout = 'w'.repeat(40_000);
  const hot = {
    config: {
      agents: { scout: { enabled: true, socket: sock } },
      models: { errands: { scout: 'openrouter/vendor/model' } },
    },
    prompts: { preambles: { all, scout, '@vendor-model': 'MODEL' } },
  };
  const client = createErrandClient({ hot });
  try {
    const { logs } = await withCapturedLogs(async () => {
      const outcome = await client.run({ agent: 'scout', id: 'task-long', goal: 'look' });
      assert.equal(outcome.status, 'done');
    });
    const sent = String((await runner.firstRequest).preamble);
    const expected = `${all}\n\n${scout}\n\nMODEL`;
    assert.deepEqual({ chars: sent.length, whole: sent === expected }, { chars: expected.length, whole: true });
    assert.equal(logs.filter((entry) => entry.msg === 'errands: preamble over the cap').length, 0);
  } finally {
    client.close();
    await runner.close();
  }
});

// src/errands/client.ts: the route of an errand goes out on its `run` line, against a plain Unix-socket server in the
// test that reads the line and ends the task.

test("a run's route goes out on its line", async () => {
  // Catches: the client drops the route like any unknown field, so the scout runner never learns it and fails subharness-off.
  const sock = path.join(tempDir('nep-client-route-'), 'runner.sock');
  const lines: Array<Record<string, unknown>> = [];
  const conns: Array<net.Socket> = [];
  const server = net.createServer((conn) => {
    conns.push(conn);
    conn.setEncoding('utf8');
    conn.on('error', () => {});
    conn.on('data', (chunk: string) => {
      const request = JSON.parse(chunk.trim()) as Record<string, unknown>;
      lines.push(request);
      conn.write(encodeLine({ id: request.id, event: 'end', status: 'done', result: { text: 'ok' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  const hot = { config: { agents: { scout: { enabled: true, socket: sock } } } };
  const client = createErrandClient({ hot });
  const route: TaskRoute = { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium', mode: 'write' };
  try {
    await withCapturedLogs(() => client.run({ agent: 'scout', id: 'task-r', goal: 'look', route }));
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0]?.route, route);
  } finally {
    client.close();
    for (const conn of conns) conn.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
