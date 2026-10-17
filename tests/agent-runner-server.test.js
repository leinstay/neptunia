// Tests for src/agent-runner/server.js: the Unix-socket server with a FAKE
// task engine. A client sends run/cancel/ping lines; the server answers
// progress then one end per task, runs one task at a time (a second waits in
// the queue), cancels a running task, answers a bad line with an error, and
// on a ping about an unknown id answers end/restarted. No real OpenCode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunnerServer } from '../src/agent-runner/server.js';
import { encodeLine } from '../src/agent-runner/protocol.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

function socketPath() {
  return path.join(os.tmpdir(), `agent-sock-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
}

/** A client that collects whole JSON lines from the socket and lets a test await the next match. */
function connect(sock) {
  const client = net.connect(sock);
  const events = [];
  const waiters = [];
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
  const next = (match) => new Promise((resolve) => {
    const found = events.find(match);
    if (found) return resolve(found);
    waiters.push({ match, resolve });
  });
  const send = (obj) => client.write(encodeLine(obj));
  return { client, events, next, send, ready, end: () => client.end() };
}

/** A fake engine that resolves each task after the test lets it, recording start order. */
function controllableRunner() {
  const started = [];
  const gates = new Map();
  const runner = {
    run(task) {
      started.push(task.id);
      return new Promise((resolve) => {
        gates.set(task.id, (outcome) => resolve(outcome));
        if (task.onProgress) task.onProgress({ step: 1, tool: 'search', note: 'looking' });
      });
    },
  };
  const finish = (id, outcome) => gates.get(id)?.(outcome ?? { status: 'done', result: { text: 'ok' }, usage: { steps: 1 } });
  return { runner, started, finish };
}

async function withServer(runner, fn) {
  const sock = socketPath();
  const server = createRunnerServer({ profile: 'web', runner, socketPath: sock });
  await server.start();
  try {
    return await fn(sock, server);
  } finally {
    await server.stop();
    if (fs.existsSync(sock)) fs.unlinkSync(sock);
  }
}

test('server: a run gets progress then one end, and the socket is group-accessible', async () => {
  const { runner, finish } = controllableRunner();
  await withCapturedLogs(() => withServer(runner, async (sock) => {
    const mode = fs.statSync(sock).mode & 0o777;
    assert.equal(mode & 0o060, 0o060, 'group rw on the socket');
    const c = connect(sock);
    await c.ready;
    c.send({ op: 'run', id: 'task-a', goal: 'find a meme' });
    const progress = await c.next((e) => e.event === 'progress');
    assert.equal(progress.tool, 'search');
    finish('task-a', { status: 'done', result: { text: 'found it' }, usage: { steps: 2 } });
    const end = await c.next((e) => e.event === 'end');
    assert.equal(end.status, 'done');
    assert.equal(end.result.text, 'found it');
    c.end();
  }));
});

test('server: one task at a time, the second waits in the queue', async () => {
  const { runner, started, finish } = controllableRunner();
  await withCapturedLogs(() => withServer(runner, async (sock) => {
    const c = connect(sock);
    await c.ready;
    c.send({ op: 'run', id: 'one', goal: 'first' });
    c.send({ op: 'run', id: 'two', goal: 'second' });
    await c.next((e) => e.event === 'progress' && e.id === 'one');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(started, ['one'], 'the second has not started yet');
    finish('one');
    await c.next((e) => e.event === 'end' && e.id === 'one');
    await c.next((e) => e.event === 'progress' && e.id === 'two');
    assert.deepEqual(started, ['one', 'two']);
    finish('two');
    await c.next((e) => e.event === 'end' && e.id === 'two');
    c.end();
  }));
});

test('server: cancel aborts the running task', async () => {
  const started = [];
  const runner = {
    run(task) {
      started.push(task.id);
      return new Promise((resolve) => {
        task.signal.addEventListener('abort', () => resolve({ status: 'cancelled', result: {}, usage: {}, error: 'cancelled' }));
      });
    },
  };
  await withCapturedLogs(() => withServer(runner, async (sock) => {
    const c = connect(sock);
    await c.ready;
    c.send({ op: 'run', id: 'task-c', goal: 'slow' });
    await new Promise((r) => setTimeout(r, 20));
    c.send({ op: 'cancel', id: 'task-c' });
    const end = await c.next((e) => e.event === 'end');
    assert.equal(end.status, 'cancelled');
    c.end();
  }));
});

test('server: a bad line gets an error event, a ping gets a pong', async () => {
  const { runner } = controllableRunner();
  await withCapturedLogs(() => withServer(runner, async (sock) => {
    const c = connect(sock);
    await c.ready;
    c.client.write('{not json\n');
    const err = await c.next((e) => e.event === 'error');
    assert.equal(err.error, 'bad-json');
    c.send({ op: 'ping', ids: [] });
    const pong = await c.next((e) => e.event === 'pong');
    assert.equal(pong.profile, 'web');
    c.end();
  }));
});

test('server: a ping about an unknown id answers end/restarted', async () => {
  const { runner } = controllableRunner();
  await withCapturedLogs(() => withServer(runner, async (sock) => {
    const c = connect(sock);
    await c.ready;
    c.send({ op: 'ping', ids: ['ghost'] });
    const end = await c.next((e) => e.event === 'end' && e.id === 'ghost');
    assert.equal(end.status, 'failed');
    assert.equal(end.error, 'restarted');
    c.end();
  }));
});

test('server: stop ends an open task with restarted', async () => {
  const { runner } = controllableRunner();
  const sock = socketPath();
  const server = createRunnerServer({ profile: 'web', runner, socketPath: sock });
  await withCapturedLogs(async () => {
    await server.start();
    const c = connect(sock);
    await c.ready;
    c.send({ op: 'run', id: 'open', goal: 'never finishes' });
    await c.next((e) => e.event === 'progress');
    const endPromise = c.next((e) => e.event === 'end');
    await server.stop();
    const end = await endPromise;
    assert.equal(end.error, 'restarted');
    c.end();
  });
  if (fs.existsSync(sock)) fs.unlinkSync(sock);
});
