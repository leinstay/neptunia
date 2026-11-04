// src/errands/client.ts: the route of an errand goes out on its `run` line, against a plain Unix-socket server in the
// test that reads the line and ends the task.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { createErrandClient } from '../src/errands/client.ts';
import type { TaskRoute } from '../src/agent-runner/protocol.ts';
import { encodeLine } from '../src/agent-runner/protocol.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { tempDir } from './fixtures/tmp.ts';

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
