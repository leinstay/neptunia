// The YouTube canary check: which link of the duration chain works on this
// host (yt-dlp, the Data API, the watch page, or none), and the one startup
// log line that tells the operator. Everything through fakes -- no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createYoutubeCheck, startYoutubeCheck } from '../../../src/memory/youtube-check.ts';
import { fakeVideoFetcher } from '../../fixtures/describe-fakes.ts';
import { chainsOf } from '../../fixtures/chains.ts';

// The canary is a constant of youtube-check.js, no setting.
const CANARY = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const API_KEY = 'AIzaSecretTestKey';

function checkHot({ video = {} }: { video?: Record<string, unknown> } = {}) {
  return {
    prompts: {},
    config: {
      context: { vision: { fetchTimeoutMs: 1234 } },
      media: { video: { ytdlpPath: 'yt-dlp-test', toolTimeoutMs: 5678, ...video } },
    },
  };
}

/** probeSite answers `site`; probeYoutube answers `api` when pageFallback is false, else `page`. */
type ProbeResult = { ok: boolean; reason?: string; durationSec?: number | null; title?: string | null };

function fakeFetcher({
  site = { ok: false, reason: 'download' },
  api = { ok: false, reason: 'download' },
  page = { ok: false, reason: 'download' },
}: { site?: ProbeResult | Error; api?: ProbeResult; page?: ProbeResult } = {}) {
  const calls: Array<{ fn: string; url: string; options: { pageFallback?: boolean } }> = [];
  const fetcher = {
    calls,
    probeSite: async (url: string, options: { pageFallback?: boolean }) => {
      calls.push({ fn: 'probeSite', url, options });
      if (site instanceof Error) throw site;
      return site;
    },
    probeYoutube: async (url: string, options: { pageFallback?: boolean }) => {
      const fn = options?.pageFallback === false ? 'api' : 'page';
      calls.push({ fn, url, options });
      return fn === 'api' ? api : page;
    },
  };
  // The probes answer a few fields more than the check reads (a title, a null duration).
  return fetcher as typeof fetcher & Parameters<typeof createYoutubeCheck>[0]['videoFetcher'];
}

function makeLogger() {
  const lines: Array<{ level: string; msg: string; meta: unknown }> = [];
  return {
    lines,
    info: (msg: string, meta: unknown) => lines.push({ level: 'info', msg, meta }),
    warn: (msg: string, meta: unknown) => lines.push({ level: 'warn', msg, meta }),
    error: (msg: string, meta: unknown) => lines.push({ level: 'error', msg, meta }),
  };
}

test('checkYoutube: ytdlp when the yt-dlp probe returns a duration, probing the canary with the video settings', async () => {
  const videoFetcher = fakeFetcher({ site: { ok: true, durationSec: 19, title: 'x' } });
  const checkYoutube = createYoutubeCheck({ hot: checkHot(), videoFetcher, youtubeApiKey: API_KEY });
  const result = await checkYoutube();
  assert.equal(result.status, 'ytdlp');
  assert.equal(result.keySet, true);
  assert.equal(typeof result.detail, 'string');
  assert.deepEqual(
    videoFetcher.calls.map((c) => c.fn),
    ['probeSite']
  );
  const firstCall = videoFetcher.calls[0];
  assert.equal(firstCall.url, CANARY);
  assert.deepEqual(firstCall.options, {
    ytdlpPath: 'yt-dlp-test',
    toolTimeoutMs: 5678,
    proxy: null,
    proxyRetryMinutes: undefined,
  });
});

test('checkYoutube: a yt-dlp probe without a duration does not count as ytdlp', async () => {
  const videoFetcher = fakeFetcher({
    site: { ok: true, durationSec: null, title: null },
    page: { ok: true, durationSec: 19 },
  });
  const checkYoutube = createYoutubeCheck({ hot: checkHot(), videoFetcher });
  assert.equal((await checkYoutube()).status, 'page');
});

test('checkYoutube: api when yt-dlp fails and the Data API alone returns a duration', async () => {
  const videoFetcher = fakeFetcher({ api: { ok: true, durationSec: 19 } });
  const checkYoutube = createYoutubeCheck({ hot: checkHot(), videoFetcher, youtubeApiKey: API_KEY });
  const result = await checkYoutube();
  assert.equal(result.status, 'api');
  assert.deepEqual(
    videoFetcher.calls.map((c) => c.fn),
    ['probeSite', 'api']
  );
  const secondCall = videoFetcher.calls[1];
  assert.deepEqual(secondCall.options, { fetchTimeoutMs: 1234, apiKey: API_KEY, pageFallback: false });
  assert.ok(!result.detail.includes(API_KEY), 'the key is never in the detail');
});

test('checkYoutube: page when yt-dlp and the Data API fail but the watch page has a duration', async () => {
  const videoFetcher = fakeFetcher({ page: { ok: true, durationSec: 19 } });
  const checkYoutube = createYoutubeCheck({ hot: checkHot(), videoFetcher, youtubeApiKey: API_KEY });
  const result = await checkYoutube();
  assert.equal(result.status, 'page');
  assert.equal(result.keySet, true);
  assert.deepEqual(
    videoFetcher.calls.map((c) => c.fn),
    ['probeSite', 'api', 'page']
  );
  const thirdCall = videoFetcher.calls[2];
  assert.deepEqual(thirdCall.options, { fetchTimeoutMs: 1234, apiKey: null });
});

test('checkYoutube: without a key the Data API is never tried', async () => {
  for (const youtubeApiKey of [undefined, null, '']) {
    const videoFetcher = fakeFetcher({ page: { ok: true, durationSec: 19 } });
    const checkYoutube = createYoutubeCheck({ hot: checkHot(), videoFetcher, youtubeApiKey });
    const result = await checkYoutube();
    assert.equal(result.status, 'page');
    assert.equal(result.keySet, false);
    assert.deepEqual(
      videoFetcher.calls.map((c) => c.fn),
      ['probeSite', 'page']
    );
  }
});

test('checkYoutube: blocked when every probe fails; the detail names the reasons, never the URL or key', async () => {
  const videoFetcher = fakeFetcher({ site: { ok: false, reason: 'timeout' } });
  const checkYoutube = createYoutubeCheck({ hot: checkHot(), videoFetcher, youtubeApiKey: API_KEY });
  const result = await checkYoutube();
  assert.equal(result.status, 'blocked');
  assert.ok(result.detail.includes('timeout'));
  assert.ok(!result.detail.includes(CANARY));
  assert.ok(!result.detail.includes(API_KEY));
});

test('checkYoutube: a throwing fetcher gives blocked, never a rejection', async () => {
  const videoFetcher = fakeFetcher({ site: new Error(`spawn failed ${CANARY}`) });
  const checkYoutube = createYoutubeCheck({ hot: checkHot(), videoFetcher });
  const result = await checkYoutube();
  assert.equal(result.status, 'blocked');
  assert.ok(!result.detail.includes(CANARY));
});

test('startYoutubeCheck: page and blocked log a warning with the hint to store the youtube service', async () => {
  // The hint named the env variable YOUTUBE_API_KEY, which nothing reads: the key is the `youtube` service of keys.json.
  for (const status of ['page', 'blocked'] as const) {
    const logger = makeLogger();
    const checkYoutube = async () => ({ status, detail: 'x', keySet: false });
    await startYoutubeCheck({ checkYoutube, log: logger });
    assert.deepEqual(logger.lines, [
      { level: 'warn', msg: 'youtube-check: status', meta: { status, hint: '/keys service set youtube' } },
    ]);
  }
});

test('startYoutubeCheck: a rejecting check is logged as an error, never left unhandled', async () => {
  const logger = makeLogger();
  const checkYoutube = async () => {
    throw new Error('boom');
  };
  await startYoutubeCheck({ checkYoutube, log: logger });
  assert.equal(logger.lines.length, 1);
  const firstLine = logger.lines[0];
  assert.equal(firstLine.level, 'error');
});

// ---- the engine proxy: the check takes the proxy of the moment, read at each check -----------------

const PROXY = 'socks5h://login:pass-word@proxy.example:1080';

const VIDEO = {
  provider: null,
  maxOutputTokens: 400,
  maxRequestTokens: 60_000,
  timeoutMs: 90_000,
  toolTimeoutMs: 60_000,
  sites: ['youtube.com', 'youtu.be', 'tiktok.com', 'vk.com'],
  ytdlpPath: 'yt-dlp-test',
  ffmpegPath: 'ffmpeg-test',
  errorRetryMinutes: 60,
  // Keys a private layer may hold that no code reads: neither may limit the engine proxy to a site list.
  proxy: '',
  proxySites: ['youtube.com'],
};

const hot = {
  config: {
    models: { routes: chainsOf({ vision: 'x/haiku', video: 'x/video-model' }) },
    media: { maxOutputTokens: 120, video: VIDEO },
    context: { vision: { fetchTimeoutMs: 10_000 } },
  },
  prompts: { 'describe/picture': 'Describe this picture.', 'describe/video': 'Watch this clip and say what happens.' },
};

test('the YouTube check reads the engine proxy at each check', async () => {
  // Catches: the startup canary keeps the proxy of the moment it was built, and reports a block that is the proxy's.
  let inForce: string | null = PROXY;
  const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec: 19, title: 'x' } });
  const check = createYoutubeCheck({ hot, videoFetcher, proxy: () => inForce });
  await check();
  inForce = null;
  await check();
  const proxies: Array<unknown> = videoFetcher.calls
    .filter((call) => call.fn === 'probeSite')
    .map((call): unknown => call.options.proxy);
  assert.deepEqual(proxies, [PROXY, null]);
});
