// src/net/global-proxy.ts: the one place a process hands its proxy to Node. Node 26's
// `http.setGlobalProxyFromEnv(env)` routes `fetch`, `http`, `https` and the global `WebSocket` of the whole process
// through the proxy and returns the function that restores the state before it. Measured: a later call
// with `{}` or with empty strings leaves the proxy in force, and `socks5h://` is refused (UND_ERR_INVALID_ARG), so
// the applier sets the http form and goes direct through the restore function alone. The Node call is a fake here.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGlobalProxy } from '../../../src/net/global-proxy.ts';

const PROXY = 'socks5h://login:pass-word@proxy.example:1080';
const HTTP_FORM = 'http://login:pass-word@proxy.example:1080';
const SECOND = 'http://second:secret2@other.example:3128';

function fakeNode() {
  const sets: Array<Record<string, string>> = [];
  let restores = 0;
  let depth = 0;
  const setGlobal = (env: Record<string, string>): (() => void) => {
    sets.push(env);
    depth += 1;
    return () => {
      restores += 1;
      depth -= 1;
    };
  };
  return {
    setGlobal,
    sets,
    restores: () => restores,
    depth: () => depth,
  };
}

test('a proxy in force is handed to Node in the http form for both schemes, with loopback left direct', () => {
  // Catches: the socks5h URL goes to Node, which refuses it, or https traffic stays direct because only HTTP_PROXY is set.
  const node = fakeNode();
  const applier = createGlobalProxy(node.setGlobal);
  assert.equal(applier.apply(PROXY), true);
  assert.equal(node.sets.length, 1);
  const [firstSet] = node.sets;
  assert.equal(firstSet?.HTTP_PROXY, HTTP_FORM);
  assert.equal(firstSet?.HTTPS_PROXY, HTTP_FORM);
  assert.match(firstSet?.NO_PROXY ?? '', /(^|,)localhost(,|$)/);
  assert.equal(applier.current(), PROXY);
});

test('going direct calls the restore function and never sets an empty proxy', () => {
  // Catches: the measured trap, where `setGlobalProxyFromEnv({})` leaves the dead proxy in force for every request.
  const node = fakeNode();
  const applier = createGlobalProxy(node.setGlobal);
  applier.apply(PROXY);
  assert.equal(applier.apply(null), false);
  assert.equal(node.restores(), 1);
  assert.equal(node.depth(), 0);
  assert.equal(node.sets.length, 1);
  assert.equal(applier.current(), null);
});

test('the same proxy applied twice sets Node once', () => {
  // Catches: each health check stacks another global setting, so one restore later leaves the proxy in force.
  const node = fakeNode();
  const applier = createGlobalProxy(node.setGlobal);
  applier.apply(PROXY);
  applier.apply(PROXY);
  assert.equal(node.sets.length, 1);
  assert.equal(node.depth(), 1);
});

test('a new proxy restores the old one before it is set, so one direct switch is enough', () => {
  // Catches: switching URLs stacks two settings, and the later switch to direct lands on the old proxy.
  const node = fakeNode();
  const applier = createGlobalProxy(node.setGlobal);
  applier.apply(PROXY);
  applier.apply(SECOND);
  assert.equal(node.depth(), 1);
  assert.equal(node.sets.at(-1)?.HTTPS_PROXY, SECOND);
  applier.apply(null);
  assert.equal(node.depth(), 0);
});

test('direct while nothing is in force calls nothing', () => {
  // Catches: a restore with nothing to restore, which would undo a setting the process had before the engine started.
  const node = fakeNode();
  const applier = createGlobalProxy(node.setGlobal);
  applier.apply(null);
  assert.equal(node.sets.length, 0);
  assert.equal(node.restores(), 0);
});

test('a URL with no http form goes direct instead of reaching Node', () => {
  // Catches: an `ftp://` or garbled value throws inside Node at a turn, or keeps the previous proxy in force.
  const node = fakeNode();
  const applier = createGlobalProxy(node.setGlobal);
  applier.apply(PROXY);
  assert.equal(applier.apply('ftp://login:pw@proxy.example:21'), false);
  assert.equal(node.depth(), 0);
  assert.equal(applier.current(), null);
});

// OpenRouter is reached around the proxy, since a residential proxy can answer `Malformed_HTTP_Response` on
// `openrouter.ai/api/v1/chat/completions`. While the proxy is on, the core's global proxy carries `NO_PROXY` with
// `openrouter.ai` beside the local hosts, so searches and downloads keep the proxy. The routing test runs Node's own
// `setGlobalProxyFromEnv` against a fake proxy and a fake origin on loopback; nothing leaves the machine.

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
        lookup: (_name, opts, done) =>
          opts.all === true
            ? (done as (err: null, all: Array<{ address: string; family: number }>) => void)(null, [
                { address: '127.0.0.1', family: 4 },
              ])
            : done(null, '127.0.0.1', 4),
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
