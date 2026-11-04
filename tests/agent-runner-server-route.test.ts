// src/agent-runner/server.ts: the route of a `run` line reaches the task engine, with a fake engine and a real socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { createRunnerServer } from '../src/agent-runner/server.ts';
import { encodeLine } from '../src/agent-runner/protocol.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { tempDir } from './fixtures/tmp.ts';

type Event = Record<string, unknown>;

/** Sends one line over a fresh connection and resolves with the first event for `id` that is an end or an error. */
function exchange(sock: string, request: Event): Promise<Event> {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sock);
    let buffer = '';
    conn.setEncoding('utf8');
    conn.once('error', reject);
    conn.once('connect', () => conn.write(encodeLine(request)));
    conn.on('data', (chunk: string) => {
      buffer += chunk;
      const events = buffer.split('\n').slice(0, -1);
      for (const event of events.map((line) => JSON.parse(line) as Event)) {
        if (event.id === request.id && (event.event === 'end' || event.event === 'error')) {
          conn.end();
          resolve(event);
          return;
        }
      }
    });
  });
}

test("a run's route reaches the engine, and a bad one comes back as a code and never reaches it", async () => {
  // Catches: the server hands the engine a fixed list of fields and this one is missing, so the runner never sees the route.
  const seen: Array<unknown> = [];
  const runner = {
    run(task: { route?: unknown }) {
      seen.push(task.route);
      return Promise.resolve({ status: 'done', result: { text: 'ok' }, usage: { steps: 1 } });
    },
  };
  const sock = path.join(tempDir('nep-server-route-'), 'runner.sock');
  const server = createRunnerServer({ profile: 'scout', runner, socketPath: sock });
  const route = { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium', mode: 'write' };
  await withCapturedLogs(async () => {
    await server.start();
    try {
      const end = await exchange(sock, { op: 'run', id: 'task-r', goal: 'g', route });
      assert.equal(end.event, 'end');
      const refused = await exchange(sock, {
        op: 'run',
        id: 'task-b',
        goal: 'g',
        route: { ...route, backend: 'gemini' },
      });
      assert.equal(refused.event, 'error');
      assert.equal(refused.error, 'bad-route');
    } finally {
      await server.stop();
    }
  });
  assert.deepEqual(seen, [route]);
});
