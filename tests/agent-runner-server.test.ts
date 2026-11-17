// Tests for src/agent-runner/server.ts: the Unix-socket server with a FAKE
// task engine. A client sends run/cancel/ping lines; the server answers
// one end per task, runs one task at a time (a second waits in
// the queue), cancels a running task, answers a bad line with an error, and
// on a ping about an unknown id answers end/restarted; a run's secrets and
// shared preamble reach the engine and no event or log line. No real OpenCode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunnerServer } from '../src/agent-runner/server.ts';
import { encodeLine } from '../src/agent-runner/protocol.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import type { Untyped } from '../src/tools/types.ts';

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

function socketPath() {
  return path.join(os.tmpdir(), `agent-sock-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
}

/** A client that collects whole JSON lines from the socket and lets a test await the next match. */
function connect(sock: Untyped) {
  const client = net.connect(sock);
  const events: Array<Untyped> = [];
  const waiters: Array<Untyped> = [];
  let buffer = '';
  client.setEncoding('utf8');
  client.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      events.push(event);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i].match(event)) {
          waiters[i].resolve(event);
          waiters.splice(i, 1);
        }
      }
    }
  });
  const ready = new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('error', reject);
  });
  const next = (match: Untyped) =>
    new Promise((resolve) => {
      const found = events.find(match);
      if (found) return resolve(found);
      waiters.push({ match, resolve });
    });
  const send = (obj: Untyped) => client.write(encodeLine(obj));
  return { client, events, next, send, ready, end: () => client.end() };
}

/** A fake engine that resolves each task after the test lets it, recording start order; `whenStarted(id)` waits for a start. */
function controllableRunner() {
  const started: Array<Untyped> = [];
  const gates = new Map();
  const waiting = new Map<string, () => void>();
  const runner = {
    run(task: Untyped) {
      started.push(task.id);
      waiting.get(String(task.id))?.();
      return new Promise<Untyped>((resolve) => {
        gates.set(task.id, (outcome: Untyped) => resolve(outcome));
      });
    },
  };
  const finish = (id: string, outcome?: Untyped) =>
    gates.get(id)?.(outcome ?? { status: 'done', result: { text: 'ok' }, usage: { steps: 1 } });
  const whenStarted = (id: string) =>
    started.includes(id) ? Promise.resolve() : new Promise<void>((resolve) => waiting.set(id, resolve));
  return { runner, started, finish, whenStarted };
}

async function withServer(runner: Untyped, fn: Untyped) {
  const sock = socketPath();
  const server = createRunnerServer({ unit: 'scout', runner, socketPath: sock });
  await server.start();
  try {
    return await fn(sock, server);
  } finally {
    await server.stop();
    if (fs.existsSync(sock)) fs.unlinkSync(sock);
  }
}

// Changed: the runner sends no progress event, so the test waits for the engine to start the task instead.
test('server: a run gets one end, and the socket is group-accessible', async () => {
  const { runner, finish, whenStarted } = controllableRunner();
  await withCapturedLogs(() =>
    withServer(runner, async (sock: Untyped) => {
      const mode = fs.statSync(sock).mode & 0o777;
      assert.equal(mode & 0o060, 0o060, 'group rw on the socket');
      const c = connect(sock);
      await c.ready;
      c.send({ op: 'run', agent: 'scout', id: 'task-a', goal: 'find a meme' });
      await whenStarted('task-a');
      finish('task-a', { status: 'done', result: { text: 'found it' }, usage: { steps: 2 } });
      const end = await c.next((e: unknown) => loose(e).event === 'end');
      assert.equal(loose(end).status, 'done');
      assert.equal(loose(end).result.text, 'found it');
      c.end();
    })
  );
});

test("server: a run's secrets reach the engine and nothing else: no event, no log line; refused ones come back as a code", async () => {
  const seen: Array<Untyped> = [];
  const runner = {
    run(task: Untyped) {
      seen.push(task.secrets);
      return Promise.resolve({ status: 'done', result: { text: 'ok' }, usage: { steps: 1 } });
    },
  };
  const secrets = {
    openrouterKey: 'sk-SECRET',
    proxy: 'http://u:SECRET@proxy.example:8000',
    searchKey: 'search-SECRET',
  };
  const { result: events, logs } = await withCapturedLogs(() =>
    withServer(runner, async (sock: Untyped) => {
      const c = connect(sock);
      await c.ready;
      c.send({ op: 'run', agent: 'scout', id: 'task-s', goal: 'g', secrets });
      await c.next((e: unknown) => loose(e).event === 'end' && loose(e).id === 'task-s');
      c.send({ op: 'run', agent: 'scout', id: 'task-t', goal: 'g', secrets: { ...secrets, extra: 'SECRET' } });
      const refused = await c.next((e: unknown) => loose(e).event === 'error' && loose(e).id === 'task-t');
      assert.equal(loose(refused).error, 'bad-secrets');
      c.end();
      return c.events;
    })
  );
  assert.deepEqual(seen, [secrets], 'the refused run never reached the engine');
  assert.ok(!JSON.stringify(events).includes('SECRET'), 'no secret in an event');
  assert.ok(!JSON.stringify(logs).includes('SECRET'), 'no secret in a log line');
});

test("server: a run's preamble reaches the engine and no event or log line; a run without one passes none; a bad one is refused", async () => {
  const seen: Array<Untyped> = [];
  const runner = {
    run(task: Untyped) {
      seen.push([task.id, task.preamble]);
      return Promise.resolve({ status: 'done', result: { text: 'ok' }, usage: { steps: 1 } });
    },
  };
  const { result: events, logs } = await withCapturedLogs(() =>
    withServer(runner, async (sock: Untyped) => {
      const c = connect(sock);
      await c.ready;
      c.send({ op: 'run', agent: 'scout', id: 'task-p', goal: 'g', preamble: 'SHARED-PREAMBLE text' });
      await c.next((e: unknown) => loose(e).event === 'end' && loose(e).id === 'task-p');
      c.send({ op: 'run', agent: 'scout', id: 'task-q', goal: 'g' });
      await c.next((e: unknown) => loose(e).event === 'end' && loose(e).id === 'task-q');
      c.send({ op: 'run', agent: 'scout', id: 'task-r', goal: 'g', preamble: 7 });
      const refused = await c.next((e: unknown) => loose(e).event === 'error' && loose(e).id === 'task-r');
      assert.equal(loose(refused).error, 'bad-preamble');
      c.end();
      return c.events;
    })
  );
  assert.deepEqual(seen, [
    ['task-p', 'SHARED-PREAMBLE text'],
    ['task-q', undefined],
  ]);
  assert.ok(!JSON.stringify(events).includes('SHARED-PREAMBLE'), 'no preamble in an event');
  assert.ok(!JSON.stringify(logs).includes('SHARED-PREAMBLE'), 'no preamble in a log line');
});

// Changed: the runner sends no progress event, so the test waits for the engine to start the task instead.
test('server: one task per agent at a time, the second of the same agent waits in the queue', async () => {
  const { runner, started, finish, whenStarted } = controllableRunner();
  await withCapturedLogs(() =>
    withServer(runner, async (sock: Untyped) => {
      const c = connect(sock);
      await c.ready;
      c.send({ op: 'run', agent: 'scout', id: 'one', goal: 'first' });
      c.send({ op: 'run', agent: 'scout', id: 'two', goal: 'second' });
      await whenStarted('one');
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(started, ['one'], 'the second has not started yet');
      finish('one');
      await c.next((e: unknown) => loose(e).event === 'end' && loose(e).id === 'one');
      await whenStarted('two');
      assert.deepEqual(started, ['one', 'two']);
      finish('two');
      await c.next((e: unknown) => loose(e).event === 'end' && loose(e).id === 'two');
      c.end();
    })
  );
});

test('server: a task of another agent of the unit runs beside a running one', async () => {
  // Bug: one runner serves every agent of its unit, and a slow errand of one agent holds up every other agent.
  // Changed: the runner sends no progress event, so the test waits for the engine to start the task instead.
  const { runner, started, finish, whenStarted } = controllableRunner();
  await withCapturedLogs(() =>
    withServer(runner, async (sock: Untyped) => {
      const c = connect(sock);
      await c.ready;
      c.send({ op: 'run', agent: 'scout', id: 'one', goal: 'first' });
      c.send({ op: 'run', agent: 'fetch', id: 'two', goal: 'second' });
      await whenStarted('two');
      assert.deepEqual(started, ['one', 'two']);
      finish('one');
      finish('two');
      await c.next((e: unknown) => loose(e).event === 'end' && loose(e).id === 'two');
      c.end();
    })
  );
});

test('server: cancel aborts the running task', async () => {
  const started = [];
  const runner = {
    run(task: Untyped) {
      started.push(task.id);
      return new Promise((resolve) => {
        task.signal.addEventListener('abort', () =>
          resolve({ status: 'cancelled', result: {}, usage: {}, error: 'cancelled' })
        );
      });
    },
  };
  await withCapturedLogs(() =>
    withServer(runner, async (sock: Untyped) => {
      const c = connect(sock);
      await c.ready;
      c.send({ op: 'run', agent: 'scout', id: 'task-c', goal: 'slow' });
      await new Promise((r) => setTimeout(r, 20));
      c.send({ op: 'cancel', id: 'task-c' });
      const end = await c.next((e: unknown) => loose(e).event === 'end');
      assert.equal(loose(end).status, 'cancelled');
      c.end();
    })
  );
});

test('server: a bad line gets an error event, a ping gets a pong', async () => {
  const { runner } = controllableRunner();
  await withCapturedLogs(() =>
    withServer(runner, async (sock: Untyped) => {
      const c = connect(sock);
      await c.ready;
      c.client.write('{not json\n');
      const err = await c.next((e: unknown) => loose(e).event === 'error');
      assert.equal(loose(err).error, 'bad-json');
      c.send({ op: 'ping', ids: [] });
      const pong = await c.next((e: unknown) => loose(e).event === 'pong');
      assert.equal(loose(pong).unit, 'scout');
      c.end();
    })
  );
});

test('server: a ping about an unknown id answers end/restarted', async () => {
  const { runner } = controllableRunner();
  await withCapturedLogs(() =>
    withServer(runner, async (sock: Untyped) => {
      const c = connect(sock);
      await c.ready;
      c.send({ op: 'ping', ids: ['ghost'] });
      const end = await c.next((e: unknown) => loose(e).event === 'end' && loose(e).id === 'ghost');
      assert.equal(loose(end).status, 'failed');
      assert.equal(loose(end).error, 'restarted');
      c.end();
    })
  );
});

// Changed: the runner sends no progress event, so the test waits for the engine to start the task instead.
test('server: stop ends an open task with restarted', async () => {
  const { runner, whenStarted } = controllableRunner();
  const sock = socketPath();
  const server = createRunnerServer({ unit: 'scout', runner, socketPath: sock });
  await withCapturedLogs(async () => {
    await server.start();
    const c = connect(sock);
    await c.ready;
    c.send({ op: 'run', agent: 'scout', id: 'open', goal: 'never finishes' });
    await whenStarted('open');
    const endPromise = c.next((e: unknown) => loose(e).event === 'end');
    await server.stop();
    const end = await endPromise;
    assert.equal(loose(end).error, 'restarted');
    c.end();
  });
  if (fs.existsSync(sock)) fs.unlinkSync(sock);
});

// Changed: the runner sends no progress event, so the test waits for the engine to start the task instead.
test('server: liveIds names the running task and the queued ones, never a finished one', async () => {
  const { runner, finish, whenStarted } = controllableRunner();
  await withCapturedLogs(() =>
    withServer(runner, async (sock: Untyped, server: Untyped) => {
      assert.deepEqual(server.liveIds(), []);
      const c = connect(sock);
      await c.ready;
      c.send({ op: 'run', agent: 'scout', id: 'first', goal: 'one' });
      c.send({ op: 'run', agent: 'scout', id: 'second', goal: 'two' });
      await whenStarted('first');
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(server.liveIds(), ['first', 'second']);
      finish('first');
      await c.next((e: unknown) => loose(e).event === 'end' && loose(e).id === 'first');
      await whenStarted('second');
      assert.deepEqual(server.liveIds(), ['second']);
      finish('second');
      await c.next((e: unknown) => loose(e).event === 'end' && loose(e).id === 'second');
      assert.deepEqual(server.liveIds(), []);
      c.end();
    })
  );
});
