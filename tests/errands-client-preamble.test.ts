// The preamble the errand client (src/errands/client.ts) sends on a `run` line: every matching file of
// prompts.local/preambles/, whole, however long the composed text is. No cap, no dropped file, no cap warning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createErrandClient } from '../src/errands/client.ts';
import { encodeLine } from '../src/agent-runner/protocol.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';

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
