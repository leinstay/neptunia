// Tests for src/errands/client.ts: the core's client of the agent runners' sockets, against a
// FAKE runner -- a plain Unix-socket server in the test that reads the client's lines and answers
// what the test tells it to. A run resolves on its `end`, cancel
// and ping go out as lines, a dropped connection fails its tasks with `disconnected` and is
// reopened, a profile that is not set up answers `not-configured` without connecting, and each
// outcome of the connect loop reaches the `onLink` listeners. The deployment's preamble goes out
// on a run's line only when non-empty, read at each run: the files of data/prompts/preambles/ are
// picked by agent and by the model of the run's route; data/prompts/agents.md
// (`hot.prompts.agents`) is never read as one.
import { consumers, consumerRig } from './fixtures/agent-consumers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createErrandClient } from '../src/errands/client.ts';
import { encodeLine } from '../src/agent-runner/protocol.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import type { Untyped } from '../src/tools/types.ts';
import type { TaskRoute } from '../src/agent-runner/protocol.ts';
import { tempDir } from './fixtures/tmp.ts';

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

// The socket of a unit derives from its name: under a user unit's runtime folder, which this file points at a temporary
// folder of its own, the scout unit listens on `<runtime>/neptunia-agent-scout/sock`.
const RUNTIME = tempDir('errand-runtime-');
fs.mkdirSync(path.join(RUNTIME, 'neptunia-agent-scout'));
process.env.NEPTUNIA_UNIT_SCOPE = 'user';
process.env.XDG_RUNTIME_DIR = RUNTIME;

/** The scout unit's socket, where the scout's runner listens. */
function socketPath() {
  return path.join(RUNTIME, 'neptunia-agent-scout', 'sock');
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

function hotFor({ enabled = true } = {}) {
  return { config: { agents: { scout: { enabled }, server: { enabled: false } } } };
}

/** Short timers, so a reconnect happens within the test. */
const fastTimer = (fn: Untyped, ms: number) => setTimeout(fn, Math.min(ms, 20));

test('errands client: a profile that is not enabled answers not-configured without connecting', async () => {
  let connects = 0;
  const client = createErrandClient({
    hot: hotFor({ enabled: false }),
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

// Changed: the client takes no progress listeners and the runner sends no progress event.
test('errands client: a run sends its line, the end resolves it', async () => {
  const sock = socketPath();
  const runner = await fakeRunner(sock);
  const client = createErrandClient({ hot: hotFor() });
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
      // Changed: the run line carries no `model`: the runner takes the model from the route (owner, 2026-11-17).
      // Changed: one runner serves every agent of its unit, so the run line names its agent.
      assert.deepEqual(request, {
        op: 'run',
        id: 'task-1',
        agent: 'scout',
        goal: 'find a meme',
        context: { scope: 'group' },
        limits: { steps: 3, seconds: 30 },
      });
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
    });
  } finally {
    client.close();
    await runner.close();
  }
});

test("errands client: a run's secrets go out on its line and into no log line", async () => {
  const sock = socketPath();
  const runner = await fakeRunner(sock);
  const client = createErrandClient({ hot: hotFor() });
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
  const hot = hotFor();
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

// Changed: the preamble's model is the model of the run's route, and the run line carries no `model` (owner,
// 2026-11-17): `models.errands` is gone.
test("errands client: the preamble is composed by agent and the route's model, logged by file names only", async () => {
  // Catches: the client picks the model files by another model than the one the run uses, so the agent gets the
  // instructions written for a different model.
  const sock = socketPath();
  const runner = await fakeRunner(sock);
  const hot = hotFor();
  loose(hot).prompts = {
    preambles: {
      all: 'ALL-TEXT',
      scout: 'SCOUT-TEXT',
      '@claude-sonnet-4.6': 'SONNET-TEXT',
      'scout@gpt-6-sol': 'SCOUT-SOL-TEXT',
    },
  };
  const client = createErrandClient({ hot });
  const routeOn = (model: string | null): TaskRoute => ({ backend: 'opencode', model, effort: null, mode: 'read' });
  const runOnce = async (id: string, route?: TaskRoute) => {
    const running = client.run({ agent: 'scout', id, goal: 'look', ...(route === undefined ? {} : { route }) });
    const request = await runner.next((r: Untyped) => r.op === 'run' && r.id === id);
    runner.reply({ id, event: 'end', status: 'done', result: { text: 'ok' }, usage: {} });
    await running;
    return request;
  };
  try {
    const { logs } = await withCapturedLogs(async () => {
      const onSonnet = await runOnce('task-sonnet', routeOn('openrouter/anthropic/claude-sonnet-4.6'));
      assert.equal(loose(onSonnet).preamble, 'ALL-TEXT\n\nSCOUT-TEXT\n\nSONNET-TEXT', "the route's model file");
      assert.equal(Object.hasOwn(onSonnet, 'model'), false, 'the route carries the model, the line no second one');

      loose(hot).prompts = { ...loose(hot).prompts, preambles: { ...loose(hot).prompts.preambles, all: '' } };
      const live = await runOnce('task-live', routeOn('openrouter/openai/gpt-6-sol'));
      assert.equal(
        loose(live).preamble,
        'SCOUT-TEXT\n\nSCOUT-SOL-TEXT',
        'model and files read at each run; an emptied all.md sends nothing'
      );

      const noModel = await runOnce('task-no-model', routeOn(null));
      assert.equal(loose(noModel).preamble, 'SCOUT-TEXT', 'a route with no model reads no model file');
      const noRoute = await runOnce('task-no-route');
      assert.equal(loose(noRoute).preamble, 'SCOUT-TEXT', 'no route reads no model file');
    });
    const sent = logs.filter((entry) => entry.msg === 'errands: sent');
    assert.deepEqual(
      sent.map((entry) => entry.preambleFiles),
      [
        ['preambles/all.md', 'preambles/scout.md', 'preambles/@claude-sonnet-4.6.md'],
        // The run that checked an unusable price went with the price; the other runs keep their files.
        ['preambles/scout.md', 'preambles/scout@gpt-6-sol.md'],
        ['preambles/scout.md'],
        ['preambles/scout.md'],
      ]
    );
    assert.deepEqual(
      sent.map((entry) => entry.model),
      [
        'openrouter/anthropic/claude-sonnet-4.6',
        // One run fewer: the run that checked an unusable price went with the price.
        'openrouter/openai/gpt-6-sol',
        null,
        null,
      ],
      "the route's model id is logged"
    );
    assert.ok(
      sent.every((entry) => !Object.hasOwn(entry, 'cost')),
      'the cost is not logged'
    );
    assert.equal(sent[0].preambleChars, 'ALL-TEXT\n\nSCOUT-TEXT\n\nSONNET-TEXT'.length);
    assert.ok(!/-TEXT/.test(JSON.stringify(logs)), 'no preamble text in a log line');
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
  const client = createErrandClient({ hot: hotFor() });
  try {
    await withCapturedLogs(async () => {
      const running = client.run({ agent: 'scout', id: 'task-c', goal: 'slow' });
      await runner.next((r: Untyped) => r.op === 'run');
      assert.equal(client.cancel({ agent: 'scout', id: 'task-c' }), true);
      await runner.next((r: Untyped) => r.op === 'cancel' && r.id === 'task-c');
      const pinged = client.ping('scout');
      const ping = await runner.next((r: Untyped) => r.op === 'ping');
      assert.deepEqual(loose(ping).ids, ['task-c'], 'the ping names the tasks still waited for');
      // Changed: a runner serves a unit, and its pong names the unit.
      runner.reply({ event: 'pong', unit: 'scout', busy: true, queued: 0 });
      assert.deepEqual(await pinged, { ok: true, unit: 'scout', busy: true, queued: 0 });
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
  const client = createErrandClient({ hot: hotFor() });
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
  const client = createErrandClient({ hot: hotFor(), setTimer: fastTimer });
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
  const client = createErrandClient({ hot: hotFor(), setTimer: fastTimer });
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
  const client = createErrandClient({ hot: hotFor(), setTimer: (fn, ms) => setTimeout(fn, Math.max(ms, 60_000)) });
  const events: Array<Untyped> = [];
  client.onLink((event) => events.push(event));
  let runner = null as Awaited<ReturnType<typeof fakeRunner>> | null; // assigned inside a callback, so no narrowing to null
  try {
    await withCapturedLogs(async () => {
      assert.deepEqual(await client.ping('scout'), { ok: false, error: 'disconnected' });
      // Changed: a link is the unit's, so its events name the unit.
      assert.deepEqual(events, [{ unit: 'scout', up: false, code: 'ENOENT' }]);
      runner = await fakeRunner(sock);
      const pinging = client.ping('scout');
      await runner.next((r: Untyped) => r.op === 'ping');
      assert.deepEqual(events.at(-1), { unit: 'scout', up: true });
      runner.reply({ event: 'pong', unit: 'scout', busy: false, queued: 0 });
      assert.equal((await pinging).ok, true);
      runner.dropAll();
      for (let i = 0; i < 100 && events.length < 3; i += 1) await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(events.at(-1), { unit: 'scout', up: false, code: 'disconnected' });
      assert.equal(events.length, 3);
    });
  } finally {
    client.close();
    if (runner) await runner.close();
  }
});

test('the running client reads whether an agent is on from the live config at each call', () => {
  // Changed: `enabled` left the profile, so the live config alone switches an agent on.
  const rig = consumerRig();
  const hot: { config: { agents: Record<string, unknown> } } = { config: { agents: {} } };
  const client = consumers.client({ hot, agentPaths: rig.options });
  try {
    assert.equal(client.configured('scout'), false);
    hot.config.agents = { scout: { enabled: true } };
    assert.equal(client.configured('scout'), true);
    hot.config.agents = { scout: { enabled: false } };
    assert.equal(client.configured('scout'), false);
  } finally {
    client.close();
    rig.close();
  }
});

test('a reconnect timer contains an invalid personal edit without reconnecting or replaying the failed errand', async () => {
  const rig = consumerRig();
  // Changed: the socket is the scout unit's, and the live config switches the scout on.
  const socket = socketPath();
  const connects: Array<string> = [];
  const timers: Array<{ fire: () => void; handle: ReturnType<typeof setTimeout> }> = [];
  const links: Array<{ unit: string; up: boolean; code?: string }> = [];
  const client = consumers.client({
    agentPaths: { ...rig.options, env: process.env },
    hot: { config: { agents: { scout: { enabled: true } } } },
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
    assert.deepEqual(links, [{ unit: 'scout', up: false, code: 'ECONNREFUSED' }]);
    assert.equal(timers.length, 1);
    rig.override({ limits: { seconds: 0 } });
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
// data/prompts/preambles/, whole, however long the composed text is. No cap, no dropped file, no cap warning.

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
  const sock = socketPath();
  const runner = await oneShotRunner(sock);
  const all = 'b'.repeat(70_000);
  const scout = 'w'.repeat(40_000);
  const hot = {
    config: {
      agents: { scout: { enabled: true } },
    },
    prompts: { preambles: { all, scout, '@model': 'MODEL' } },
  };
  const client = createErrandClient({ hot });
  try {
    const { logs } = await withCapturedLogs(async () => {
      // Changed: the model file is picked by the route's model, `models.errands` is gone (owner, 2026-11-17).
      const route: TaskRoute = { backend: 'opencode', model: 'openrouter/vendor/model', effort: null, mode: 'read' };
      const outcome = await client.run({ agent: 'scout', id: 'task-long', goal: 'look', route });
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
  const sock = socketPath();
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
  const hot = { config: { agents: { scout: { enabled: true } } } };
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
