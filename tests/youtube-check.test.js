// The YouTube canary check: which link of the duration chain works on this
// host (yt-dlp, the Data API, the watch page, or none), and the one startup
// log line that tells the operator. Everything through fakes -- no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createYoutubeCheck, isVideoVisionOn, startYoutubeCheck } from '../src/memory/youtube-check.js';

const CANARY = 'https://www.youtube.com/watch?v=canary00001';
const API_KEY = 'AIzaSecretTestKey';

function checkHot({ features = { mediaDescriptions: true }, video = {} } = {}) {
  return {
    config: {
      features,
      context: { vision: { fetchTimeoutMs: 1234 } },
      media: { video: { canaryUrl: CANARY, ytdlpPath: 'yt-dlp-test', toolTimeoutMs: 5678, ...video } },
    },
  };
}

/** probeSite answers `site`; probeYoutube answers `api` when pageFallback is false, else `page`. */
function fakeFetcher({
  site = { ok: false, reason: 'download' },
  api = { ok: false, reason: 'download' },
  page = { ok: false, reason: 'download' },
} = {}) {
  const calls = [];
  return {
    calls,
    probeSite: async (url, options) => {
      calls.push({ fn: 'probeSite', url, options });
      if (site instanceof Error) throw site;
      return site;
    },
    probeYoutube: async (url, options) => {
      const fn = options?.pageFallback === false ? 'api' : 'page';
      calls.push({ fn, url, options });
      return fn === 'api' ? api : page;
    },
  };
}

function makeLogger() {
  const lines = [];
  return {
    lines,
    info: (msg, meta) => lines.push({ level: 'info', msg, meta }),
    warn: (msg, meta) => lines.push({ level: 'warn', msg, meta }),
    error: (msg, meta) => lines.push({ level: 'error', msg, meta }),
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
  assert.equal(videoFetcher.calls[0].url, CANARY);
  assert.deepEqual(videoFetcher.calls[0].options, {
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
  assert.deepEqual(videoFetcher.calls[1].options, { fetchTimeoutMs: 1234, apiKey: API_KEY, pageFallback: false });
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
  assert.deepEqual(videoFetcher.calls[2].options, { fetchTimeoutMs: 1234, apiKey: null });
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

test('checkYoutube: no canaryUrl configured gives blocked without any probe', async () => {
  const videoFetcher = fakeFetcher({ site: { ok: true, durationSec: 19 } });
  const checkYoutube = createYoutubeCheck({ hot: checkHot({ video: { canaryUrl: '' } }), videoFetcher });
  const result = await checkYoutube();
  assert.equal(result.status, 'blocked');
  assert.equal(videoFetcher.calls.length, 0);
});

test('checkYoutube: reads the canary URL at the moment of use', async () => {
  const hot = checkHot();
  const videoFetcher = fakeFetcher({ site: { ok: true, durationSec: 19 } });
  const checkYoutube = createYoutubeCheck({ hot, videoFetcher });
  hot.config = { ...hot.config, media: { video: { canaryUrl: 'https://youtu.be/othercanary' } } };
  await checkYoutube();
  assert.equal(videoFetcher.calls[0].url, 'https://youtu.be/othercanary');
});

test('isVideoVisionOn: needs mediaDescriptions true and videoDescriptions not false', () => {
  assert.equal(isVideoVisionOn({ features: { mediaDescriptions: true } }), true);
  assert.equal(isVideoVisionOn({ features: { mediaDescriptions: true, videoDescriptions: true } }), true);
  assert.equal(isVideoVisionOn({ features: { mediaDescriptions: true, videoDescriptions: false } }), false);
  assert.equal(isVideoVisionOn({ features: { mediaDescriptions: false } }), false);
  assert.equal(isVideoVisionOn({ features: {} }), false);
  assert.equal(isVideoVisionOn({}), false);
});

test('startYoutubeCheck: not run at all when video vision is off', () => {
  for (const features of [{ mediaDescriptions: false }, { mediaDescriptions: true, videoDescriptions: false }, {}]) {
    let calls = 0;
    const logger = makeLogger();
    const checkYoutube = async () => {
      calls += 1;
      return { status: 'ytdlp', detail: '' };
    };
    const running = startYoutubeCheck({ hot: checkHot({ features }), checkYoutube, log: logger });
    assert.equal(running, null);
    assert.equal(calls, 0);
    assert.equal(logger.lines.length, 0);
  }
});

test('startYoutubeCheck: page and blocked log a warning with the YOUTUBE_API_KEY hint', async () => {
  for (const status of ['page', 'blocked']) {
    const logger = makeLogger();
    const checkYoutube = async () => ({ status, detail: 'x', keySet: false });
    await startYoutubeCheck({ hot: checkHot(), checkYoutube, log: logger });
    assert.deepEqual(logger.lines, [
      { level: 'warn', msg: 'youtube-check: status', meta: { status, hint: 'set YOUTUBE_API_KEY' } },
    ]);
  }
});

test('startYoutubeCheck: a rejecting check is logged as an error, never left unhandled', async () => {
  const logger = makeLogger();
  const checkYoutube = async () => {
    throw new Error('boom');
  };
  await startYoutubeCheck({ hot: checkHot(), checkYoutube, log: logger });
  assert.equal(logger.lines.length, 1);
  assert.equal(logger.lines[0].level, 'error');
});
