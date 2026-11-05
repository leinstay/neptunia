// src/net/global-proxy.ts: the one place a process hands its proxy to Node (stage Z). Node 26's
// `http.setGlobalProxyFromEnv(env)` routes `fetch`, `http`, `https` and the global `WebSocket` of the whole process
// through the proxy and returns the function that restores the state before it. Measured on 2026-11-05: a later call
// with `{}` or with empty strings leaves the proxy in force, and `socks5h://` is refused (UND_ERR_INVALID_ARG), so
// the applier sets the http form and goes direct through the restore function alone. The Node call is a fake here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGlobalProxy } from '../src/net/global-proxy.ts';

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
  assert.equal(node.sets[0]?.HTTP_PROXY, HTTP_FORM);
  assert.equal(node.sets[0]?.HTTPS_PROXY, HTTP_FORM);
  assert.match(node.sets[0]?.NO_PROXY ?? '', /(^|,)localhost(,|$)/);
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
