// Tests for src/media/fetch-image.js: content-type allowlist, size guards
// (header and body), timeout/failure handling, the LRU cache and its
// query-string-free logging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avatarReference, createImageFetcher } from '../src/media/fetch-image.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

const PNG_BYTES = Buffer.from('fake-png-bytes');

function fakeResponse({ ok = true, status = 200, contentType = 'image/png', contentLength, body = PNG_BYTES } = {}) {
  const headers = {
    'content-type': contentType,
    'content-length': contentLength !== undefined ? String(contentLength) : undefined,
  };
  return {
    ok,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

function fakeFetchImpl(response) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response(url, options) : response;
    },
  };
}

const OPTIONS = { maxBytes: 1_500_000, timeoutMs: 10_000 };

test('fetchAsDataUrl: a successful png download returns a data: URL with bytes and contentType', async () => {
  const { fetchImpl } = fakeFetchImpl(fakeResponse({ contentType: 'image/png' }));
  const fetcher = createImageFetcher({ fetchImpl });

  const result = await fetcher.fetchAsDataUrl('https://media.discordapp.net/a/pic.png?ex=1&is=2&hm=3', OPTIONS);

  assert.ok(result);
  assert.equal(result.contentType, 'image/png');
  assert.equal(result.bytes, PNG_BYTES.byteLength);
  assert.ok(result.dataUrl.startsWith('data:image/png;base64,'));
});

test('fetchAsDataUrl: content-type allowlist accepts png/jpeg/gif/webp', async () => {
  for (const contentType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    const { fetchImpl } = fakeFetchImpl(fakeResponse({ contentType }));
    const fetcher = createImageFetcher({ fetchImpl });
    const result = await fetcher.fetchAsDataUrl('https://x/pic', OPTIONS);
    assert.ok(result, `expected ${contentType} to be accepted`);
  }
});

test('fetchAsDataUrl: content-type allowlist rejects everything else, and strips parameters before matching', async () => {
  const { fetchImpl } = fakeFetchImpl(fakeResponse({ contentType: 'image/svg+xml' }));
  const fetcher = createImageFetcher({ fetchImpl });
  assert.equal(await fetcher.fetchAsDataUrl('https://x/pic.svg', OPTIONS), null);

  const { fetchImpl: fetchImpl2 } = fakeFetchImpl(fakeResponse({ contentType: 'image/png; charset=binary' }));
  const fetcher2 = createImageFetcher({ fetchImpl: fetchImpl2 });
  const result = await fetcher2.fetchAsDataUrl('https://x/pic.png', OPTIONS);
  assert.ok(result, 'a content-type with parameters must still match after stripping them');
});

test('fetchAsDataUrl: refuses via the declared content-length header before reading the body', async () => {
  const response = fakeResponse({ contentLength: 5_000_000 });
  let bodyRead = false;
  response.arrayBuffer = async () => {
    bodyRead = true;
    return PNG_BYTES.buffer;
  };
  const { fetchImpl } = fakeFetchImpl(response);
  const fetcher = createImageFetcher({ fetchImpl });

  const result = await fetcher.fetchAsDataUrl('https://x/pic.png', { maxBytes: 1_500_000, timeoutMs: 10_000 });

  assert.equal(result, null);
  assert.equal(bodyRead, false, 'the body must never be read once the declared size already exceeds the limit');
});

test('fetchAsDataUrl: refuses on the real body length when content-length is absent or understates it', async () => {
  const bigBody = Buffer.alloc(2_000_000, 1);
  const { fetchImpl } = fakeFetchImpl(fakeResponse({ body: bigBody, contentLength: undefined }));
  const fetcher = createImageFetcher({ fetchImpl });

  const result = await fetcher.fetchAsDataUrl('https://x/pic.png', { maxBytes: 1_500_000, timeoutMs: 10_000 });

  assert.equal(result, null);
});

test('fetchAsDataUrl: a non-OK HTTP response returns null', async () => {
  const { fetchImpl } = fakeFetchImpl(fakeResponse({ ok: false, status: 403 }));
  const fetcher = createImageFetcher({ fetchImpl });

  assert.equal(await fetcher.fetchAsDataUrl('https://x/pic.png', OPTIONS), null);
});

test('fetchAsDataUrl: a thrown fetch error (timeout or network failure) returns null instead of throwing', async () => {
  const { fetchImpl } = fakeFetchImpl(new Error('The operation was aborted'));
  const fetcher = createImageFetcher({ fetchImpl });

  const result = await fetcher.fetchAsDataUrl('https://x/pic.png', OPTIONS);
  assert.equal(result, null);
});

// --- LRU cache -------------------------------------------------------------

test('fetchAsDataUrl: a cache hit on the same URL (ignoring its query string) avoids a second download', async () => {
  const { fetchImpl, calls } = fakeFetchImpl(fakeResponse());
  const fetcher = createImageFetcher({ fetchImpl });

  const first = await fetcher.fetchAsDataUrl('https://media.discordapp.net/a/pic.png?ex=111&is=222&hm=333', OPTIONS);
  const second = await fetcher.fetchAsDataUrl('https://media.discordapp.net/a/pic.png?ex=999&is=888&hm=777', OPTIONS);

  assert.equal(calls.length, 1, 'the second call must be served from cache, ignoring the rotated signed query string');
  assert.deepEqual(second, first);
});

test('fetchAsDataUrl: a different path is never a cache hit', async () => {
  const { fetchImpl, calls } = fakeFetchImpl(fakeResponse());
  const fetcher = createImageFetcher({ fetchImpl });

  await fetcher.fetchAsDataUrl('https://media.discordapp.net/a/pic1.png?ex=1', OPTIONS);
  await fetcher.fetchAsDataUrl('https://media.discordapp.net/a/pic2.png?ex=1', OPTIONS);

  assert.equal(calls.length, 2);
});

test('fetchAsDataUrl: a cache entry expires after cacheTtlMs and is re-downloaded', async () => {
  let nowValue = 1_000_000;
  const { fetchImpl, calls } = fakeFetchImpl(fakeResponse());
  const fetcher = createImageFetcher({ fetchImpl, now: () => nowValue, cacheTtlMs: 1000 });

  await fetcher.fetchAsDataUrl('https://x/pic.png', OPTIONS);
  nowValue += 1001;
  await fetcher.fetchAsDataUrl('https://x/pic.png', OPTIONS);

  assert.equal(calls.length, 2, 'the cache entry must have expired');
});

test('fetchAsDataUrl: evicts the least-recently-used entry once over cacheMaxEntries', async () => {
  const { fetchImpl, calls } = fakeFetchImpl(fakeResponse());
  const fetcher = createImageFetcher({ fetchImpl, cacheMaxEntries: 2 });

  await fetcher.fetchAsDataUrl('https://x/a.png', OPTIONS);
  await fetcher.fetchAsDataUrl('https://x/b.png', OPTIONS);
  await fetcher.fetchAsDataUrl('https://x/c.png', OPTIONS); // evicts a.png

  await fetcher.fetchAsDataUrl('https://x/a.png', OPTIONS); // must re-download: evicted
  assert.equal(calls.length, 4);

  calls.length = 0;
  await fetcher.fetchAsDataUrl('https://x/c.png', OPTIONS); // still cached
  assert.equal(calls.length, 0, 'c.png must still be cached');
});

test('fetchAsDataUrl: a failed download is never cached -- retried on the next call', async () => {
  const { fetchImpl, calls } = fakeFetchImpl(fakeResponse({ ok: false, status: 500 }));
  const fetcher = createImageFetcher({ fetchImpl });

  await fetcher.fetchAsDataUrl('https://x/pic.png', OPTIONS);
  await fetcher.fetchAsDataUrl('https://x/pic.png', OPTIONS);

  assert.equal(calls.length, 2, 'a failure must never be served from cache');
});

// --- logging -----------------------------------------------------------

test('fetchAsDataUrl: a failure logs the host and path only, never the signed query string', async () => {
  const { fetchImpl } = fakeFetchImpl(fakeResponse({ ok: false, status: 403 }));
  const fetcher = createImageFetcher({ fetchImpl });

  const { logs } = await withCapturedLogs(() =>
    fetcher.fetchAsDataUrl(
      'https://media.discordapp.net/attachments/1/2/pic.png?ex=deadbeef&is=cafef00d&hm=abc123',
      OPTIONS
    )
  );

  const line = logs.find((l) => l.msg.startsWith('fetch-image:'));
  assert.ok(line, 'expected a fetch-image log line');
  const serialized = JSON.stringify(line);
  assert.ok(!serialized.includes('ex=deadbeef'));
  assert.ok(!serialized.includes('cafef00d'));
  assert.ok(!serialized.includes('?'));
  assert.ok(serialized.includes('media.discordapp.net/attachments/1/2/pic.png'));
});

test('fetchAsDataUrl: a thrown fetch error logs its code, never its message (which may carry the full URL)', async () => {
  const url = 'https://media.discordapp.net/attachments/1/2/pic.png?ex=deadbeef&hm=abc123';
  const err = Object.assign(new TypeError(`Failed to parse URL from ${url}`), { code: 'ERR_INVALID_URL' });
  const { fetchImpl } = fakeFetchImpl(err);
  const fetcher = createImageFetcher({ fetchImpl });

  const { logs } = await withCapturedLogs(() => fetcher.fetchAsDataUrl(url, OPTIONS));

  const line = logs.find((l) => l.msg === 'fetch-image: download failed');
  assert.ok(line, 'expected a download-failed log line');
  assert.equal(line.code, 'ERR_INVALID_URL');
  assert.equal(line.error, undefined);
  assert.ok(!JSON.stringify(line).includes('deadbeef'));
  assert.ok(!JSON.stringify(line).includes('Failed to parse'));
});

test('fetchAsDataUrl: an error without a code logs its class name; a body-read failure too', async () => {
  const { fetchImpl } = fakeFetchImpl(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
  const { logs } = await withCapturedLogs(() =>
    createImageFetcher({ fetchImpl }).fetchAsDataUrl('https://x/pic.png', OPTIONS)
  );
  assert.equal(logs.find((l) => l.msg === 'fetch-image: download failed')?.code, 'AbortError');

  const response = fakeResponse();
  response.arrayBuffer = async () => {
    throw new Error('stream error');
  };
  const { fetchImpl: bodyFetch } = fakeFetchImpl(response);
  const { logs: bodyLogs } = await withCapturedLogs(() =>
    createImageFetcher({ fetchImpl: bodyFetch }).fetchAsDataUrl('https://x/pic.png', OPTIONS)
  );
  const line = bodyLogs.find((l) => l.msg === 'fetch-image: reading the body failed');
  assert.equal(line?.code, 'Error');
  assert.ok(!JSON.stringify(line).includes('stream error'));
});

// --- avatarReference: the bot's avatar as a drawing's reference -----------------

const AVATAR_CONFIG = { image: { referenceMaxBytes: 4_000_000 }, context: { vision: { fetchTimeoutMs: 10_000 } } };

// Changed with the contract: the caller hands over the address the interface gave (`memberInfo(self).avatar.largeUrl`)
// where it handed over the discord.js client; the size and the static form are the interface's, tested in
// tests/discord-reads.test.ts.
test('avatarReference: the large avatar address fetched under the reference limits, as a data: URL', async () => {
  const url = 'https://cdn.example.com/avatar.png';
  const calls = [];
  const imageFetcher = {
    fetchAsDataUrl: async (url, options) => {
      calls.push({ url, options });
      return { dataUrl: 'data:image/png;base64,YXZhdGFy', bytes: 6, contentType: 'image/png' };
    },
  };
  assert.equal(await avatarReference({ url, imageFetcher, config: AVATAR_CONFIG }), 'data:image/png;base64,YXZhdGFy');
  assert.deepEqual(calls, [
    { url: 'https://cdn.example.com/avatar.png', options: { maxBytes: 4_000_000, timeoutMs: 10_000 } },
  ]);
});

test('avatarReference: null without a fetcher, an avatar URL or a download; a throw is swallowed', async () => {
  const url = 'https://cdn.example.com/avatar.png';
  const ok = { fetchAsDataUrl: async () => ({ dataUrl: 'data:image/png;base64,eA==' }) };
  assert.equal(await avatarReference({ url, imageFetcher: null, config: AVATAR_CONFIG }), null);
  assert.equal(await avatarReference({ url: undefined, imageFetcher: ok, config: AVATAR_CONFIG }), null);
  assert.equal(await avatarReference({ url: '', imageFetcher: ok, config: AVATAR_CONFIG }), null);
  assert.equal(
    await avatarReference({ url, imageFetcher: { fetchAsDataUrl: async () => null }, config: AVATAR_CONFIG }),
    null
  );
  const throwing = {
    fetchAsDataUrl: async () => {
      throw new Error('boom');
    },
  };
  assert.equal(await avatarReference({ url, imageFetcher: throwing, config: AVATAR_CONFIG }), null);
});
