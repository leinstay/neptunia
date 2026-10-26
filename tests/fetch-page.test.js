// Tests for src/web/fetch-page.js: the SSRF guard (scheme, localhost, IP
// literals, hostnames resolving to private space, redirects re-checked on
// every hop, the request pinned to the checked address), the header set, the
// content-type and size rules (declared and mid-stream), timeouts, HTTP and
// network failures, text/plain passthrough, HTML to text, charsets, and
// logging that carries host/path only. The request function and DNS lookup
// are fakes; nothing touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageFetcher, isForbiddenAddress } from '../src/web/fetch-page.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

const OPTS = { maxBytes: 10_000, timeoutMs: 5_000 };
const PUBLIC_V4 = '93.184.216.34';

/** A body that yields `chunks` one by one and counts how many were pulled. */
function countingBody(chunks) {
  const state = { pulled: 0, cancelled: false };
  return {
    state,
    body: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          state.pulled += 1;
          yield typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
        }
      },
      cancel: async () => {
        state.cancelled = true;
      },
    },
  };
}

function fakeResponse({ status = 200, headers = {}, chunks = [], body } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const counted = countingBody(chunks);
  return {
    status,
    headers: lower,
    body: body === undefined ? counted.body : body,
    state: counted.state,
  };
}

function html(text, extraHeaders = {}) {
  return fakeResponse({ headers: { 'content-type': 'text/html; charset=utf-8', ...extraHeaders }, chunks: [text] });
}

/** requestImpl answering from `routes` (url -> response | Error | function), recording calls. */
function fakeRequest(routes) {
  const calls = [];
  const requestImpl = async (url, options) => {
    calls.push({ url, options });
    const route = routes[url];
    if (route === undefined) throw new TypeError('no route');
    if (route instanceof Error) throw route;
    return typeof route === 'function' ? route(url, options) : route;
  };
  return { calls, requestImpl };
}

/** lookup answering from `hosts` (hostname -> address list | Error), public by default. */
function fakeLookup(hosts = {}) {
  const calls = [];
  const lookup = async (host, options) => {
    calls.push({ host, options });
    const entry = hosts[host];
    if (entry instanceof Error) throw entry;
    const list = entry ?? [PUBLIC_V4];
    return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return { calls, lookup };
}

async function run(fetcher, url, options = OPTS) {
  return withCapturedLogs(() => fetcher.fetchText(url, options));
}

test('isForbiddenAddress: loopback, private, link-local, unspecified and mapped IPv4 are forbidden', () => {
  for (const ip of [
    '127.0.0.1',
    '127.255.0.9',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%eth0',
    'febf::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::ffff:192.168.0.1',
    '0:0:0:0:0:ffff:a9fe:a9fe',
  ]) {
    assert.equal(isForbiddenAddress(ip), true, ip);
  }
});

test('isForbiddenAddress: public addresses pass, garbage fails closed', () => {
  for (const ip of [
    '8.8.8.8',
    PUBLIC_V4,
    '172.15.0.1',
    '172.32.0.1',
    '192.169.0.1',
    '2606:4700::1111',
    '::ffff:8.8.8.8',
    'fe00::1',
    'fbff::1',
  ]) {
    assert.equal(isForbiddenAddress(ip), false, ip);
  }
  for (const bad of ['nope', '', '1.2.3', '999.1.1.1', null, undefined])
    assert.equal(isForbiddenAddress(bad), true, String(bad));
});

test('isForbiddenAddress: benchmarking 198.18/15 is forbidden, its neighbours are not', () => {
  for (const ip of ['198.18.0.1', '198.19.255.255', '::ffff:198.18.0.1'])
    assert.equal(isForbiddenAddress(ip), true, ip);
  for (const ip of ['198.17.255.255', '198.20.0.1']) assert.equal(isForbiddenAddress(ip), false, ip);
});

test('isForbiddenAddress: site-local fec0::/10 is forbidden', () => {
  for (const ip of ['fec0::1', 'feff:1::1', 'FEC0:0:0:0:0:0:0:1']) assert.equal(isForbiddenAddress(ip), true, ip);
});

test('isForbiddenAddress: NAT64 64:ff9b::/96 is judged by its embedded IPv4', () => {
  for (const ip of [
    '64:ff9b::7f00:1',
    '64:ff9b::127.0.0.1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b::10.1.2.3',
    '64:ff9b::c612:1',
  ]) {
    assert.equal(isForbiddenAddress(ip), true, ip);
  }
  for (const ip of ['64:ff9b::808:808', '64:ff9b::8.8.8.8']) assert.equal(isForbiddenAddress(ip), false, ip);
});

test('isForbiddenAddress: 6to4 2002::/16 is judged by its embedded IPv4', () => {
  for (const ip of ['2002:7f00:1::1', '2002:a00:1::', '2002:c0a8:101::5', '2002:a9fe:a9fe::1', '2002::1']) {
    assert.equal(isForbiddenAddress(ip), true, ip);
  }
  for (const ip of ['2002:808:808::1', '2002:5db8:d822::1']) assert.equal(isForbiddenAddress(ip), false, ip);
});

test('fetchText: the request connects to the address that was checked, never resolving the host again', async () => {
  let answers = 0;
  const lookup = async () => {
    answers += 1;
    // A rebinding resolver: public for the check, loopback for anyone asking later.
    return answers === 1
      ? [
          { address: PUBLIC_V4, family: 4 },
          { address: '2606:4700::1111', family: 6 },
        ]
      : [{ address: '127.0.0.1', family: 4 }];
  };
  const { calls, requestImpl } = fakeRequest({ 'https://rebind.example/': html('<p>fine</p>') });
  const fetcher = createPageFetcher({ requestImpl, lookup });
  const { result } = await run(fetcher, 'https://rebind.example/');
  assert.equal(result.ok, true);
  assert.equal(answers, 1, 'one lookup per hop');
  assert.equal(calls[0].options.lookupAddress, PUBLIC_V4);
  assert.equal(calls[0].options.family, 4);
});

test('fetchText: each redirect hop is pinned to its own checked address, the family taken from the address when missing', async () => {
  const { calls, requestImpl } = fakeRequest({
    'https://one.example/': fakeResponse({ status: 302, headers: { location: 'https://two.example/' } }),
    'https://two.example/': html('<p>two</p>'),
  });
  const lookup = async (host) => (host === 'one.example' ? ['93.184.216.34'] : ['2606:4700::1111']);
  const fetcher = createPageFetcher({ requestImpl, lookup });
  const { result } = await run(fetcher, 'https://one.example/');
  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.map((c) => [c.options.lookupAddress, c.options.family]),
    [
      ['93.184.216.34', 4],
      ['2606:4700::1111', 6],
    ]
  );
});

test('fetchText: response headers given as lists use their first value', async () => {
  const { requestImpl } = fakeRequest({
    'https://list.example/': fakeResponse({
      headers: { 'content-type': ['text/plain', 'text/html'] },
      chunks: ['plain'],
    }),
  });
  const fetcher = createPageFetcher({ requestImpl, lookup: fakeLookup().lookup });
  const { result } = await run(fetcher, 'https://list.example/');
  assert.equal(result.contentType, 'text/plain');
  assert.equal(result.text, 'plain');
});

test('fetchText: a scheme other than http/https fails with scheme, no lookup and no request', async () => {
  const { calls, requestImpl } = fakeRequest({});
  const dns = fakeLookup();
  const fetcher = createPageFetcher({ requestImpl, lookup: dns.lookup });
  for (const url of ['ftp://example.com/a', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url']) {
    const { result } = await run(fetcher, url);
    assert.deepEqual(result, { ok: false, reason: 'scheme' }, url);
  }
  assert.equal(calls.length, 0);
  assert.equal(dns.calls.length, 0);
});

test('fetchText: localhost and IP literals fail with private, no request', async () => {
  const { calls, requestImpl } = fakeRequest({});
  const fetcher = createPageFetcher({ requestImpl, lookup: fakeLookup().lookup });
  for (const url of [
    'http://localhost/',
    'http://LOCALHOST.:8080/x',
    'http://api.localhost/',
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://0x7f.1/',
    'https://8.8.8.8/',
  ]) {
    const { result } = await run(fetcher, url);
    assert.deepEqual(result, { ok: false, reason: 'private' }, url);
  }
  assert.equal(calls.length, 0);
});

test('fetchText: a hostname resolving to 127.0.0.1 fails with private, no request', async () => {
  const { calls, requestImpl } = fakeRequest({});
  const dns = fakeLookup({ 'evil.example': ['127.0.0.1'] });
  const fetcher = createPageFetcher({ requestImpl, lookup: dns.lookup });
  const { result } = await run(fetcher, 'https://evil.example/page');
  assert.deepEqual(result, { ok: false, reason: 'private' });
  assert.equal(calls.length, 0);
  assert.deepEqual(dns.calls, [{ host: 'evil.example', options: { all: true } }]);
});

test('fetchText: one private address among public ones is enough to refuse', async () => {
  const { calls, requestImpl } = fakeRequest({});
  const fetcher = createPageFetcher({
    requestImpl,
    lookup: fakeLookup({ 'mixed.example': [PUBLIC_V4, '::ffff:10.1.2.3'] }).lookup,
  });
  const { result } = await run(fetcher, 'https://mixed.example/');
  assert.deepEqual(result, { ok: false, reason: 'private' });
  assert.equal(calls.length, 0);
});

test('fetchText: a redirect to a private IP fails with private and is never requested', async () => {
  const { calls, requestImpl } = fakeRequest({
    'https://site.example/go': fakeResponse({
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data' },
    }),
  });
  const fetcher = createPageFetcher({ requestImpl, lookup: fakeLookup().lookup });
  const { result } = await run(fetcher, 'https://site.example/go');
  assert.deepEqual(result, { ok: false, reason: 'private' });
  assert.deepEqual(
    calls.map((c) => c.url),
    ['https://site.example/go']
  );
});

test('fetchText: a redirect to a hostname resolving privately fails with private', async () => {
  const { calls, requestImpl } = fakeRequest({
    'https://site.example/go': fakeResponse({ status: 301, headers: { location: 'https://internal.example/' } }),
  });
  const dns = fakeLookup({ 'internal.example': ['192.168.0.10'] });
  const fetcher = createPageFetcher({ requestImpl, lookup: dns.lookup });
  const { result } = await run(fetcher, 'https://site.example/go');
  assert.deepEqual(result, { ok: false, reason: 'private' });
  assert.equal(calls.length, 1);
  assert.deepEqual(
    dns.calls.map((c) => c.host),
    ['site.example', 'internal.example']
  );
});

test('fetchText: redirects are followed manually, relative locations resolved, every hop re-checked', async () => {
  const first = fakeResponse({ status: 302, headers: { location: '/moved?x=1' } });
  const { calls, requestImpl } = fakeRequest({
    'https://a.example/start': first,
    'https://a.example/moved?x=1': fakeResponse({ status: 308, headers: { location: 'https://b.example/final' } }),
    'https://b.example/final': html('<p>Arrived.</p>'),
  });
  const dns = fakeLookup();
  const fetcher = createPageFetcher({ requestImpl, lookup: dns.lookup });
  const { result } = await run(fetcher, 'https://a.example/start');
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Arrived.');
  assert.equal(result.finalUrl, 'https://b.example/final');
  assert.deepEqual(
    calls.map((c) => c.url),
    ['https://a.example/start', 'https://a.example/moved?x=1', 'https://b.example/final']
  );
  assert.ok(calls.every((c) => c.options.lookupAddress === PUBLIC_V4 && c.options.family === 4));
  assert.deepEqual(
    dns.calls.map((c) => c.host),
    ['a.example', 'a.example', 'b.example']
  );
  assert.equal(first.state.cancelled, true);
});

test('fetchText: three redirects are followed, a fourth fails with redirects (no option changes that)', async () => {
  const hop = (n) => fakeResponse({ status: 302, headers: { location: `https://r.example/${n}` } });
  const { calls, requestImpl } = fakeRequest({
    'https://r.example/0': hop(1),
    'https://r.example/1': hop(2),
    'https://r.example/2': hop(3),
    'https://r.example/3': hop(4),
  });
  const fetcher = createPageFetcher({ requestImpl, lookup: fakeLookup().lookup });
  const { result } = await run(fetcher, 'https://r.example/0', { ...OPTS, maxRedirects: 10 });
  assert.deepEqual(result, { ok: false, reason: 'redirects' });
  assert.equal(calls.length, 4);

  const three = fakeRequest({
    'https://s.example/0': fakeResponse({ status: 302, headers: { location: 'https://s.example/1' } }),
    'https://s.example/1': fakeResponse({ status: 302, headers: { location: 'https://s.example/2' } }),
    'https://s.example/2': fakeResponse({ status: 302, headers: { location: 'https://s.example/3' } }),
    'https://s.example/3': html('<p>arrived</p>'),
  });
  const { result: followed } = await run(
    createPageFetcher({ requestImpl: three.requestImpl, lookup: fakeLookup().lookup }),
    'https://s.example/0'
  );
  assert.equal(followed.ok, true);
  assert.equal(followed.finalUrl, 'https://s.example/3');
});

test('fetchText: sends the fixed header set with a GET; Accept-Language only when one is given', async () => {
  const { calls, requestImpl } = fakeRequest({ 'https://h.example/': html('<p>x</p>') });
  const fetcher = createPageFetcher({ requestImpl, lookup: fakeLookup().lookup });
  await run(fetcher, 'https://h.example/');
  assert.deepEqual(calls[0].options.headers, {
    'User-Agent': 'Mozilla/5.0 (compatible; neptunia-bot/1.0)',
    Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1',
  });
  assert.ok(calls[0].options.signal);

  await run(fetcher, 'https://h.example/', { ...OPTS, acceptLanguage: 'el,en;q=0.5' });
  assert.equal(calls[1].options.headers['Accept-Language'], 'el,en;q=0.5');

  // Not a usable header value: left out rather than sent broken.
  for (const acceptLanguage of ['', '   ', 'el\r\nX-Injected: 1', 42, null]) {
    await run(fetcher, 'https://h.example/', { ...OPTS, acceptLanguage });
    assert.equal('Accept-Language' in calls.at(-1).options.headers, false, JSON.stringify(acceptLanguage));
  }
});

test('fetchText: a content type other than html/plain/xhtml fails with type, a missing one too', async () => {
  const { requestImpl } = fakeRequest({
    'https://t.example/img': fakeResponse({ headers: { 'content-type': 'image/png' }, chunks: ['x'] }),
    'https://t.example/none': fakeResponse({ chunks: ['x'] }),
    'https://t.example/json': fakeResponse({ headers: { 'content-type': 'application/json' }, chunks: ['{}'] }),
    'https://t.example/xhtml': fakeResponse({
      headers: { 'content-type': 'application/xhtml+xml' },
      chunks: ['<p>ok</p>'],
    }),
  });
  const fetcher = createPageFetcher({ requestImpl, lookup: fakeLookup().lookup });
  assert.deepEqual((await run(fetcher, 'https://t.example/img')).result, { ok: false, reason: 'type' });
  assert.deepEqual((await run(fetcher, 'https://t.example/none')).result, { ok: false, reason: 'type' });
  assert.deepEqual((await run(fetcher, 'https://t.example/json')).result, { ok: false, reason: 'type' });
  const xhtml = (await run(fetcher, 'https://t.example/xhtml')).result;
  assert.equal(xhtml.ok, true);
  assert.equal(xhtml.text, 'ok');
});

test('fetchText: a declared content-length over maxBytes fails with size before reading the body', async () => {
  const response = fakeResponse({
    headers: { 'content-type': 'text/html', 'content-length': '20000' },
    chunks: ['<p>x</p>'],
  });
  const { requestImpl } = fakeRequest({ 'https://s.example/': response });
  const fetcher = createPageFetcher({ requestImpl, lookup: fakeLookup().lookup });
  const { result } = await run(fetcher, 'https://s.example/');
  assert.deepEqual(result, { ok: false, reason: 'size' });
  assert.equal(response.state.pulled, 0);
});

test('fetchText: a body growing past maxBytes mid-stream fails with size and stops pulling', async () => {
  const chunk = 'a'.repeat(400);
  const response = fakeResponse({
    headers: { 'content-type': 'text/plain' },
    chunks: [chunk, chunk, chunk, chunk, chunk],
  });
  const { calls, requestImpl } = fakeRequest({ 'https://s.example/big': response });
  const fetcher = createPageFetcher({ requestImpl, lookup: fakeLookup().lookup });
  const { result } = await run(fetcher, 'https://s.example/big', { maxBytes: 1000, timeoutMs: 5000 });
  assert.deepEqual(result, { ok: false, reason: 'size' });
  assert.equal(response.state.pulled, 3);
  assert.equal(calls[0].options.signal.aborted, true);
});

test('fetchText: a request hanging past timeoutMs fails with timeout', async () => {
  const requestImpl = (url, { signal }) =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  const fetcher = createPageFetcher({ requestImpl, lookup: fakeLookup().lookup });
  const { result } = await run(fetcher, 'https://slow.example/', { maxBytes: 1000, timeoutMs: 20 });
  assert.deepEqual(result, { ok: false, reason: 'timeout' });
});

test('fetchText: a DNS lookup hanging past timeoutMs fails with timeout', async () => {
  const { calls, requestImpl } = fakeRequest({});
  const fetcher = createPageFetcher({ requestImpl, lookup: () => new Promise(() => {}) });
  const { result } = await run(fetcher, 'https://slow-dns.example/', { maxBytes: 1000, timeoutMs: 20 });
  assert.deepEqual(result, { ok: false, reason: 'timeout' });
  assert.equal(calls.length, 0);
});

test('fetchText: a body stalling past timeoutMs fails with timeout', async () => {
  const requestImpl = async (url, { signal }) =>
    fakeResponse({
      headers: { 'content-type': 'text/html' },
      body: {
        async *[Symbol.asyncIterator]() {
          yield new TextEncoder().encode('<p>start');
          await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
        },
      },
    });
  const fetcher = createPageFetcher({ requestImpl, lookup: fakeLookup().lookup });
  const { result } = await run(fetcher, 'https://stall.example/', { maxBytes: 1000, timeoutMs: 20 });
  assert.deepEqual(result, { ok: false, reason: 'timeout' });
});

test('fetchText: a non-2xx status fails with http and the status, a 3xx without location too', async () => {
  const { requestImpl } = fakeRequest({
    'https://e.example/missing': fakeResponse({ status: 404, headers: { 'content-type': 'text/html' } }),
    'https://e.example/nowhere': fakeResponse({ status: 302 }),
  });
  const fetcher = createPageFetcher({ requestImpl, lookup: fakeLookup().lookup });
  assert.deepEqual((await run(fetcher, 'https://e.example/missing')).result, {
    ok: false,
    reason: 'http',
    status: 404,
  });
  assert.deepEqual((await run(fetcher, 'https://e.example/nowhere')).result, {
    ok: false,
    reason: 'http',
    status: 302,
  });
});

test('fetchText: a thrown fetch, a failed or empty lookup and a missing response fail with network', async () => {
  const { requestImpl } = fakeRequest({
    'https://n.example/': new TypeError('fetch failed'),
    'https://null.example/': null,
  });
  const notFound = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
  const fetcher = createPageFetcher({
    requestImpl,
    lookup: fakeLookup({ 'gone.example': notFound, 'empty.example': [] }).lookup,
  });
  for (const url of [
    'https://n.example/',
    'https://gone.example/',
    'https://empty.example/',
    'https://null.example/',
  ]) {
    assert.deepEqual((await run(fetcher, url)).result, { ok: false, reason: 'network' }, url);
  }
});

test('fetchText: text/plain comes back as is, without a title', async () => {
  const body = 'Line one <not a tag>\n\n\nLine two, \u03b1\u03b2\u03b3.';
  const { requestImpl } = fakeRequest({
    'https://p.example/notes.txt': fakeResponse({
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      chunks: [body],
    }),
  });
  const fetcher = createPageFetcher({ requestImpl, lookup: fakeLookup().lookup });
  const { result } = await run(fetcher, 'https://p.example/notes.txt');
  assert.deepEqual(result, {
    ok: true,
    text: body,
    title: null,
    contentType: 'text/plain',
    bytes: Buffer.byteLength(body),
    finalUrl: 'https://p.example/notes.txt',
  });
});

test('fetchText: HTML becomes readable text with its title, cut at maxChars', async () => {
  const page =
    '<html><head><title>Caf&eacute; news</title></head><body><nav>Menu</nav>' +
    '<article><h1>Headline</h1><p>First paragraph of the story.</p></article></body></html>';
  const { requestImpl } = fakeRequest({ 'https://w.example/story': html(page) });
  const fetcher = createPageFetcher({ requestImpl, lookup: fakeLookup().lookup });
  const { result } = await run(fetcher, 'https://w.example/story');
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Headline\n\nFirst paragraph of the story.');
  assert.equal(result.title, 'Caf\u00e9 news');
  assert.equal(result.contentType, 'text/html');
  assert.equal(result.bytes, Buffer.byteLength(page));

  const cut = (await run(fetcher, 'https://w.example/story', { ...OPTS, maxChars: 20 })).result;
  assert.equal(cut.text, 'Headline\n\nFirst\u2026');
});

test('fetchText: multi-chunk bodies decode across chunk boundaries and honour the declared charset', async () => {
  const utf8 = Buffer.from('<p>\u03b1\u03b2\u03b3 caf\u00e9</p>');
  const greek = Uint8Array.from([0x3c, 0x70, 0x3e, 0xe1, 0xe2, 0xe3, 0x3c, 0x2f, 0x70, 0x3e]); // <p>alpha beta gamma</p> in ISO-8859-7
  const latin = Buffer.from('<meta charset="windows-1252"><p>caf\u00e9</p>', 'latin1');
  const { requestImpl } = fakeRequest({
    'https://c.example/utf8': fakeResponse({
      headers: { 'content-type': 'text/html' },
      chunks: [utf8.subarray(0, 5), utf8.subarray(5)],
    }),
    'https://c.example/greek': fakeResponse({
      headers: { 'content-type': 'text/html; charset=ISO-8859-7' },
      chunks: [greek],
    }),
    'https://c.example/meta': fakeResponse({ headers: { 'content-type': 'text/html' }, chunks: [latin] }),
  });
  const fetcher = createPageFetcher({ requestImpl, lookup: fakeLookup().lookup });
  assert.equal((await run(fetcher, 'https://c.example/utf8')).result.text, '\u03b1\u03b2\u03b3 caf\u00e9');
  assert.equal((await run(fetcher, 'https://c.example/greek')).result.text, '\u03b1\u03b2\u03b3');
  assert.equal((await run(fetcher, 'https://c.example/meta')).result.text, 'caf\u00e9');
});

test('fetchText: one warn per failure with host/path only, never the query string or page text', async () => {
  const { requestImpl } = fakeRequest({
    'https://q.example/page?token=secret123': fakeResponse({
      status: 500,
      headers: { 'content-type': 'text/html' },
      chunks: ['<p>body secret</p>'],
    }),
  });
  const fetcher = createPageFetcher({ requestImpl, lookup: fakeLookup().lookup });
  const { result, logs } = await run(fetcher, 'https://q.example/page?token=secret123');
  assert.deepEqual(result, { ok: false, reason: 'http', status: 500 });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'warn');
  assert.equal(logs[0].msg, 'fetch-page: failed');
  assert.deepEqual(
    { reason: logs[0].reason, status: logs[0].status, location: logs[0].location },
    { reason: 'http', status: 500, location: 'q.example/page' }
  );
  assert.ok(!JSON.stringify(logs).includes('secret'));
});
