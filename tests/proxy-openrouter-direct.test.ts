// OpenRouter is reached around the proxy (measured on 2026-11-05: the residential proxy twice answered
// `Malformed_HTTP_Response` on `openrouter.ai/api/v1/chat/completions`). While the proxy is on, the core's global proxy
// and every harness child carry `NO_PROXY` and `no_proxy` with `openrouter.ai` beside the local hosts, so searches and
// downloads keep the proxy. The routing test runs Node's own `setGlobalProxyFromEnv` against a fake proxy and a fake
// origin on loopback; nothing leaves the machine.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createGlobalProxy } from '../src/net/global-proxy.ts';
import { proxyEnvOf } from '../src/net/proxy.ts';
import { runAgent } from '../src/subharness/run.ts';
import type { RunDeps } from '../src/subharness/run.ts';
import type { BackendRunOptions } from '../src/agent-runner/backend.ts';
import type { TaskRoute } from '../src/agent-runner/protocol.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const PROXY = 'socks5h://login:pass-word@proxy.example:1080';
const CLAUDE: TaskRoute = { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium', mode: 'read' };

/** The entries of a comma list. */
const entriesOf = (list: string | undefined): Array<string> => (list ?? '').split(',').map((entry) => entry.trim());

test('the global proxy hands Node a NO_PROXY with openrouter.ai and the local hosts', () => {
  // Catches: chat completions go through the residential proxy and come back as a malformed response.
  const sets: Array<Record<string, string>> = [];
  const applier = createGlobalProxy((env) => {
    sets.push(env);
    return () => {};
  });
  applier.apply(PROXY);
  const entries = entriesOf(sets[0]?.NO_PROXY);
  assert.ok(entries.includes('openrouter.ai'), 'openrouter.ai goes direct');
  for (const local of ['localhost', '127.0.0.1', '::1']) assert.ok(entries.includes(local), `${local} stays direct`);
});

test('the proxy variables of a child list openrouter.ai and the local hosts under both spellings', () => {
  // Catches: curl and Node children read different spellings, and one of them still sends OpenRouter through the proxy.
  const env = proxyEnvOf(PROXY);
  for (const name of ['NO_PROXY', 'no_proxy']) {
    const entries = entriesOf(env[name]);
    assert.ok(entries.includes('openrouter.ai'), `${name} has openrouter.ai`);
    for (const local of ['localhost', '127.0.0.1', '::1']) assert.ok(entries.includes(local), `${name} has ${local}`);
  }
});

test('a harness child started with the proxy gets openrouter.ai in NO_PROXY and no_proxy', async () => {
  // Catches: the child's environment is built somewhere other than proxyEnvOf and misses the exception.
  const base = tempDir('nep-proxy-openrouter-');
  const privateDir = path.join(base, 'private');
  writeKeysFile(privateDir, { subharness: { backends: ['codex'], key: null, modes: {} } });
  const seen: Array<BackendRunOptions> = [];
  const deps: RunDeps = {
    privateDir,
    denyDir: path.join(base, 'nosudo'),
    hostEnv: { PATH: '/usr/bin' },
    backendFactory: (name) => ({
      name,
      run: (_brief: string, options: BackendRunOptions) => {
        seen.push(options);
        return Promise.resolve({ ok: true, text: 'done', exitCode: 0 });
      },
    }),
  };
  await runAgent({ agent: 'dev', brief: 'look', cwd: '/tmp/x', timeoutMs: 1000, route: CLAUDE, proxy: PROXY }, deps);
  for (const name of ['NO_PROXY', 'no_proxy'])
    assert.ok(entriesOf(seen[0]?.env?.[name]).includes('openrouter.ai'), name);
});

const closers: Array<() => void> = [];
after(() => {
  for (const close of closers) close();
});

/** A loopback HTTP server that records the Host header and the request target of each request. */
function listen(): Promise<{ port: number; seen: Array<string> }> {
  const seen: Array<string> = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.headers.host ?? ''} ${req.url ?? ''}`);
    res.end('ok');
  });
  closers.push(() => server.close());
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, seen }))
  );
}

/** One GET to `host:port` whose name resolves to loopback, so a direct request reaches the fake origin. */
function get(host: string, port: number): Promise<void> {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host,
        port,
        path: '/api/v1/chat/completions',
        // Node asks for every address when it tries several families, and for one otherwise.
        lookup: (_name: string, opts: { all?: boolean }, done: (...args: Array<unknown>) => void) =>
          opts.all === true ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4),
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      }
    );
    request.on('error', () => resolve());
  });
}

test('through the global proxy openrouter.ai goes direct and another host goes through the proxy', async () => {
  // Catches: the exception lists the host in a variable Node ignores, so OpenRouter still takes the proxy.
  const proxy = await listen();
  const origin = await listen();
  const applier = createGlobalProxy();
  applier.apply(`http://login:pass-word@127.0.0.1:${proxy.port}`);
  try {
    await get('openrouter.ai', origin.port);
    await get('search.example', origin.port);
  } finally {
    applier.apply(null);
  }
  assert.equal(origin.seen.length, 1, 'the origin saw one request');
  assert.match(origin.seen[0] ?? '', /^openrouter\.ai:\d+ \/api\/v1\/chat\/completions$/);
  assert.equal(proxy.seen.length, 1, 'the proxy saw one request');
  assert.match(proxy.seen[0] ?? '', /search\.example/);
});
