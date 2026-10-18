// Tests for src/memory/describe.js: the media describer — caching, LRU
// trimming, persistence, per-batch caps, the feature switch, and the
// download-first flow: a picture is downloaded and sent to the model
// as a data: URL, never as a bare Discord URL a provider might refuse to
// fetch itself; a failed download is cached as a miss exactly like a failed
// LLM request, and every failure path logs one `describe: failed` line.
// The video half (describeVideo / describeVideos) runs on a fake video
// fetcher, a fake llm and a fake persistent state: watch paths, cache
// states, the daily video rail and the per-batch cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../src/memory/store.js';
import { createDescriber, isStaleDescription, parseGifDescription, recacheCutoffMs, videoStateFromCache } from '../src/memory/describe.js';
import { createHash } from 'node:crypto';
import { createLlm, helperRequestOptions, TokenLimitError, DailyCapError, VIDEO_TOKENS_PER_SECOND_FALLBACK } from '../src/llm/openrouter.js';
import { ROLE_DEFAULTS } from '../src/llm/roles.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { tempDir } from './fixtures/tmp.js';

// One directory under the system temp dir per run, removed when the process exits (tests/fixtures/tmp.js);
// every call gets its own empty subdirectory of it, so a run leaves nothing behind.
let tmpRoot = null;
let tmpDirCount = 0;

function tmpDataDir() {
  if (tmpRoot === null) tmpRoot = tempDir('nep-describe-');
  tmpDirCount += 1;
  const dir = path.join(tmpRoot, String(tmpDirCount));
  fs.mkdirSync(dir);
  return dir;
}

function fakeHot(overrides = {}) {
  return {
    config: {
      features: { mediaDescriptions: true },
      models: { base: { vision: 'x/haiku' } },
      media: { maxOutputTokens: 120, imageSize: 512, cacheEntries: 5000, maxPerTurn: 6 },
      context: { vision: { maxBytes: 1_500_000, fetchTimeoutMs: 10_000 } },
      ...overrides.config,
    },
    prompts: { describe: 'Describe this picture in one plain line.', ...overrides.prompts },
  };
}

function pictureItem(itemId, overrides = {}) {
  return { itemId, kind: 'image', url: 'https://cdn.discordapp.com/x/pic.png', ...overrides };
}

function fakeLlm(responses) {
  let call = 0;
  const calls = [];
  return {
    calls,
    complete: async (messages, options) => {
      calls.push({ messages, options });
      const response = Array.isArray(responses) ? responses[call] : responses;
      call += 1;
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

const SUCCESSFUL_DOWNLOAD = { dataUrl: 'data:image/webp;base64,ZmFrZQ==', bytes: 4, contentType: 'image/webp' };

/** A fake createImageFetcher()-shaped dependency. `result` may be `null` (every download fails), a fixed
 * success object, or a function `(url, options) => result|null` for per-call behaviour. */
function fakeImageFetcher(result = SUCCESSFUL_DOWNLOAD) {
  const calls = [];
  return {
    calls,
    fetchAsDataUrl: async (url, options) => {
      calls.push({ url, options });
      return typeof result === 'function' ? result(url, options) : result;
    },
  };
}

test('describe: feature off returns null without any request', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot({ config: { features: { mediaDescriptions: false } } });
  const llm = fakeLlm({ text: 'a cat' });
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  const result = await describer.describe('g1', pictureItem('a1'));
  assert.equal(result, null);
  assert.equal(llm.calls.length, 0);
  assert.equal(imageFetcher.calls.length, 0, 'the feature switch must short-circuit before any download');
});

test('describe: missing prompts.describe returns null without any request', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot({ prompts: { describe: undefined } });
  const llm = fakeLlm({ text: 'a cat' });
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  const result = await describer.describe('g1', pictureItem('a1'));
  assert.equal(result, null);
  assert.equal(llm.calls.length, 0);
  assert.equal(imageFetcher.calls.length, 0);
});

test('describe: a successful call downloads the picture, sends it as a data: URL, returns the trimmed text and caches it', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm({ text: '  A grey cat sleeping on a couch.\nsome extra line ignored  ', usage: { prompt_tokens: 200 }, estimated: 210 });
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  const result = await describer.describe('g1', pictureItem('a1'));
  assert.equal(result.text, 'A grey cat sleeping on a couch.');
  assert.equal(result.cached, undefined);
  assert.deepEqual(result.usage, { prompt_tokens: 200 });

  const sentUrl = llm.calls[0].messages[1].content[0].image_url.url;
  assert.equal(sentUrl, SUCCESSFUL_DOWNLOAD.dataUrl, 'the model must receive the downloaded data: URL, never the bare Discord URL');

  const cache = store.getMediaCache('g1');
  assert.equal(cache.a1.text, 'A grey cat sleeping on a couch.');
});

/** A prose line of `words` short words, sentence-free, so a cut can only land on a space. */
function proseLine(words) {
  return Array.from({ length: words }, (_, i) => `mot${i % 10}é`).join(' ');
}

async function describeWith(media, text, prompt) {
  const store = createStore({ dataDir: tmpDataDir() });
  const hot = fakeHot({
    config: { media: { maxOutputTokens: 120, imageSize: 512, cacheEntries: 5000, ...media } },
    ...(prompt === undefined ? {} : { prompts: { describe: prompt } }),
  });
  const llm = fakeLlm({ text });
  const describer = createDescriber({ hot, store, llm, imageFetcher: fakeImageFetcher() });
  const result = await describer.describe('g1', pictureItem('a1'));
  return { result, llm };
}

test('describe: code fallbacks equal config.json', async () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8')).media;
  const today = new Date().toISOString().slice(0, 10);

  // media.descriptionChars missing: the {{maxChars}} a picture prompt gets.
  const { llm } = await describeWith({}, 'Une chatte grise.', 'At most {{maxChars}}.');
  assert.equal(llm.calls[0].messages[0].content, `At most ${shipped.descriptionChars}.`);

  // media.gif.maxSeconds and media.gif.maxPerDay missing.
  const hot = gifHot();
  delete hot.config.media.gif.maxSeconds;
  delete hot.config.media.gif.maxPerDay;
  const below = gifDescriber({ hot, state: fakeState({ gifWatchDay: today, gifWatchCount: shipped.gif.maxPerDay - 1 }) });
  await below.describer.describe('g1', gifEmbedItem());
  assert.equal(below.videoFetcher.calls.length, 1);
  assert.equal(below.videoFetcher.calls[0].options.maxSeconds, shipped.gif.maxSeconds);
  const spent = gifDescriber({ hot, state: fakeState({ gifWatchDay: today, gifWatchCount: shipped.gif.maxPerDay }), llm: fakeLlm({ text: 'a still' }) });
  await spent.describer.describe('g1', gifEmbedItem());
  assert.equal(spent.videoFetcher.calls.length, 0);

  // media.video.summaryChars missing: the {{maxChars}} of the video prompt.
  const videoConfig = videoHot({ prompts: { 'describe-video': 'At most {{maxChars}} characters.' } });
  delete videoConfig.config.media.video.summaryChars;
  const video = videoDescriber({ hot: videoConfig, llm: fakeLlm({ text: 'scène' }) });
  await video.describer.describeVideo('g1', videoAttachment());
  assert.equal(video.llm.calls[0].messages[0].content, `At most ${shipped.video.summaryChars} characters.`);
});

test('describe: an over-long line is cut at or under media.descriptionChars on a boundary', async () => {
  const line = proseLine(70);
  const { result } = await describeWith({ descriptionChars: 100 }, line);
  assert.ok(result.text.length <= 100, `length ${result.text.length}`);
  assert.ok(line.startsWith(result.text));
  assert.equal(line[result.text.length], ' ');
});

test('describe: {{maxChars}} in the describe prompt is filled with media.descriptionChars', async () => {
  const { llm } = await describeWith({ descriptionChars: 350 }, 'Une chatte grise.', 'Say it in at most {{maxChars}} characters. Keep {{other}}.');
  assert.equal(llm.calls[0].messages[0].content, 'Say it in at most 350 characters. Keep {{other}}.');
});

test('describe: a cache hit is free -- no download, no LLM request, marked cached', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm({ text: 'a cat' });
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  await describer.describe('g1', pictureItem('a1'));
  const second = await describer.describe('g1', pictureItem('a1'));

  assert.equal(llm.calls.length, 1, 'only the first call reached the LLM');
  assert.equal(imageFetcher.calls.length, 1, 'only the first call downloaded anything');
  assert.equal(second.cached, true);
  assert.equal(second.text, 'a cat');
});

// --- download-first, download failure, LLM failure --------------------

test('describe: a failed download is cached as a miss, costs no LLM request, and logs reason "download"', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm({ text: 'should never be reached' });
  const imageFetcher = fakeImageFetcher(null); // every download fails
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  const { result, logs } = await withCapturedLogs(() => describer.describe('g1', pictureItem('a1', { kind: 'gif' })));

  assert.equal(result, null);
  assert.equal(llm.calls.length, 0, 'a failed download must cost nothing');
  assert.equal(store.getMediaCache('g1').a1.miss, true);

  const line = logs.find((l) => l.msg === 'describe: failed');
  assert.ok(line, 'expected a "describe: failed" log line');
  assert.equal(line.kind, 'gif');
  assert.equal(line.reason, 'download');
});

test('describe: a downloaded-but-failed-LLM-request is cached as a miss and logs reason "llm" with the status', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const err = new Error('OpenRouter HTTP 400: bad request');
  err.statusCode = 400;
  const llm = fakeLlm(err);
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  const { result, logs } = await withCapturedLogs(() => describer.describe('g1', pictureItem('a1', { kind: 'video' })));

  assert.equal(result, null);
  assert.equal(store.getMediaCache('g1').a1.miss, true);

  const line = logs.find((l) => l.msg === 'describe: failed');
  assert.ok(line);
  assert.equal(line.kind, 'video');
  assert.equal(line.reason, 'llm-error');
  assert.equal(line.status, 400);
  assert.ok(!JSON.stringify(line).includes('description'), 'never logs the description text');
});

test('describe: a failure log never leaks the description text or a signed URL', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const err = new Error('failed fetching https://media.discordapp.net/x.png?ex=deadbeef&is=cafef00d something secret text');
  const llm = fakeLlm(err);
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  const { logs } = await withCapturedLogs(() => describer.describe('g1', pictureItem('a1')));

  const line = logs.find((l) => l.msg === 'describe: failed');
  assert.ok(line);
  const serialized = JSON.stringify(line);
  assert.ok(!serialized.includes('ex=deadbeef'));
  assert.ok(!serialized.includes('cafef00d'));
  assert.ok(line.detail.length <= 200);
});

test('describe: a failure is cached as a miss and not retried within the hour (download succeeds, LLM fails)', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  let nowValue = 1_000_000;
  const llm = fakeLlm(new Error('provider down'));
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher, now: () => nowValue });

  const first = await describer.describe('g1', pictureItem('a1'));
  assert.equal(first, null);
  assert.equal(llm.calls.length, 1);

  const second = await describer.describe('g1', pictureItem('a1'));
  assert.equal(second, null);
  assert.equal(llm.calls.length, 1, 'still within the miss TTL: no retry');

  nowValue += 61 * 60_000; // past the 1-hour miss TTL
  const llm2 = fakeLlm({ text: 'a cat now visible' });
  const describer2 = createDescriber({ hot, store, llm: llm2, imageFetcher: fakeImageFetcher(), now: () => nowValue });
  const third = await describer2.describe('g1', pictureItem('a1'));
  assert.equal(third.text, 'a cat now visible', 'the miss expired: retried and succeeded');
});

test('describe: an empty caption is treated as a miss, not cached as a success, and logs reason "empty"', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm({ text: '   ' });
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  const { result, logs } = await withCapturedLogs(() => describer.describe('g1', pictureItem('a1')));
  assert.equal(result, null);
  assert.equal(store.getMediaCache('g1').a1.miss, true);
  const line = logs.find((l) => l.msg === 'describe: failed');
  assert.ok(line);
  assert.equal(line.reason, 'empty');
});

test('describe: LRU-trims the cache to media.cacheEntries, evicting the least recently used', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot({ config: { features: { mediaDescriptions: true }, media: { cacheEntries: 2 } } });
  const llm = fakeLlm([{ text: 'one' }, { text: 'two' }, { text: 'three' }]);
  const describer = createDescriber({ hot, store, llm, imageFetcher: fakeImageFetcher() });

  await describer.describe('g1', pictureItem('a1'));
  await describer.describe('g1', pictureItem('a2'));
  await describer.describe('g1', pictureItem('a3')); // evicts a1 (oldest)

  const cache = store.getMediaCache('g1');
  assert.deepEqual(Object.keys(cache).sort(), ['a2', 'a3']);
});

test('describe: LRU access order -- re-describing (cache hit) bumps recency, protecting it from eviction', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot({ config: { features: { mediaDescriptions: true }, media: { cacheEntries: 2 } } });
  const llm = fakeLlm([{ text: 'one' }, { text: 'two' }, { text: 'three' }]);
  const describer = createDescriber({ hot, store, llm, imageFetcher: fakeImageFetcher() });

  await describer.describe('g1', pictureItem('a1'));
  await describer.describe('g1', pictureItem('a2'));
  await describer.describe('g1', pictureItem('a1')); // cache hit: a1 becomes most-recent
  await describer.describe('g1', pictureItem('a3')); // must evict a2, not a1

  const cache = store.getMediaCache('g1');
  assert.deepEqual(Object.keys(cache).sort(), ['a1', 'a3']);
});

test('describe: the media cache is persisted across store instances', async () => {
  const dir = tmpDataDir();
  const storeA = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm({ text: 'a cat' });
  const describerA = createDescriber({ hot, store: storeA, llm, imageFetcher: fakeImageFetcher() });
  await describerA.describe('g1', pictureItem('a1'));
  storeA.flush();

  const storeB = createStore({ dataDir: dir });
  assert.equal(storeB.getMediaCache('g1').a1.text, 'a cat');
});

test('describe: video items request a webp poster frame via the media proxy, without width/height', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm({ text: 'a dog runs' });
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  await describer.describe('g1', pictureItem('v1', { kind: 'video', url: 'https://cdn.discordapp.com/x/clip.mp4' }));
  const fetchedUrl = imageFetcher.calls[0].url;
  const parsed = new URL(fetchedUrl);
  assert.equal(parsed.searchParams.get('format'), 'webp');
  assert.equal(parsed.searchParams.get('width'), null);
  // The model only ever sees the downloaded data: URL, never the CDN one.
  assert.equal(llm.calls[0].messages[1].content[0].image_url.url, SUCCESSFUL_DOWNLOAD.dataUrl);
});

test('describe: a gif item of known size requests a single still png frame fitted to media.imageSize, never an animated webp', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot({ config: { features: { mediaDescriptions: true }, media: { imageSize: 256 } } });
  const llm = fakeLlm({ text: 'a cat spins' });
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  await describer.describe(
    'g1',
    pictureItem('gif1', { kind: 'gif', url: 'https://cdn.discordapp.com/attachments/1/2/anim.gif?ex=1', width: 498, height: 280 }),
  );
  assert.equal(
    imageFetcher.calls[0].url,
    'https://media.discordapp.net/attachments/1/2/anim.gif?ex=1&width=256&height=144&format=png&animated=false',
  );
});

test('describe: a tenor gif embed on images-ext keeps its host and asks for a still png frame', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot({ config: { features: { mediaDescriptions: true }, media: { imageSize: 512 } } });
  const llm = fakeLlm({ text: 'a cat spins' });
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  const url = 'https://images-ext-1.discordapp.net/external/abc/https/media.tenor.com/x/anim.gif?ex=1';
  await describer.describe('g1', pictureItem('link:t1', { kind: 'gif', url, width: 220, height: 124 }));
  assert.equal(imageFetcher.calls[0].url, `${url}&width=220&height=124&format=png&animated=false`);
});

test('describe: an image item of known size gets the aspect-kept webp proxy URL with no animated param', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot({ config: { features: { mediaDescriptions: true }, media: { imageSize: 256 } } });
  const llm = fakeLlm({ text: 'a cat' });
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  await describer.describe('g1', pictureItem('a1', { width: 988, height: 1306 }));
  assert.equal(imageFetcher.calls[0].url, 'https://media.discordapp.net/x/pic.png?width=194&height=256&format=webp');
});

test('describe: a picture or gif of unknown size goes through the proxy with no width or height at all', async () => {
  const hot = fakeHot({ config: { features: { mediaDescriptions: true }, media: { imageSize: 256 } } });
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store: createStore({ dataDir: tmpDataDir() }), llm: fakeLlm({ text: 'a cat' }), imageFetcher });

  await describer.describe('g1', pictureItem('a1', { width: 988 }));
  await describer.describe('g1', pictureItem('gif1', { kind: 'gif', url: 'https://cdn.discordapp.com/x/anim.gif' }));
  assert.equal(imageFetcher.calls[0].url, 'https://media.discordapp.net/x/pic.png?format=webp');
  assert.equal(imageFetcher.calls[1].url, 'https://media.discordapp.net/x/anim.gif?format=png&animated=false');
});

// --- stickers, custom emoji, link thumbnails -------------------------

test('describe: an emoji item is downloaded as-is, never through the media proxy (cdn.discordapp.com host must survive)', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm({ text: 'a surprised cat face' });
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot, store, llm, imageFetcher });

  const emojiPicture = pictureItem('emoji:e1', { kind: 'emoji', url: 'https://cdn.discordapp.com/emojis/e1.webp?size=96' });
  await describer.describe('g1', emojiPicture);
  assert.equal(imageFetcher.calls[0].url, 'https://cdn.discordapp.com/emojis/e1.webp?size=96');
});

test('describe: a helper request -- llm.helperTimeoutMs, never llm.timeoutMs, counted, purpose describe', async () => {
  const run = async (llmCfg) => {
    const llm = fakeLlm({ text: 'a cat' });
    const describer = createDescriber({ hot: fakeHot({ config: { llm: llmCfg } }), store: createStore({ dataDir: tmpDataDir() }), llm, imageFetcher: fakeImageFetcher() });
    await describer.describe('g1', pictureItem('a1'));
    return llm.calls[0].options;
  };
  const tuned = await run({ timeoutMs: 90000, helperTimeoutMs: 12345 });
  assert.equal(tuned.timeoutMs, 12345);
  assert.equal(tuned.countAgainstDailyCap, true);
  assert.equal(tuned.purpose, 'describe');
  assert.equal(tuned.role, 'vision');
  assert.equal(tuned.maxOutputTokens, 120);
  const unset = await run({ timeoutMs: 90000 });
  assert.equal(unset.timeoutMs, helperRequestOptions({}).timeoutMs, 'the helper fallback, not the reply timeout');
});

test('describe: the picture model is models.base.vision; the deprecated media.model is ignored', async () => {
  const run = async (config) => {
    const hot = fakeHot({ config });
    const llm = fakeLlm({ text: 'a cat' });
    const describer = createDescriber({ hot, store: createStore({ dataDir: tmpDataDir() }), llm, imageFetcher: fakeImageFetcher() });
    await describer.describe('g1', pictureItem('a1'));
    return llm.calls[0].options.model;
  };
  assert.equal(await run({ models: { base: { vision: 'x/vision' } } }), 'x/vision');
  const stale = { models: { base: { vision: null } }, media: { model: 'x/old-media', maxOutputTokens: 120, imageSize: 512, cacheEntries: 5000, maxPerTurn: 6 } };
  assert.equal(await run(stale), ROLE_DEFAULTS.vision, 'the role default: an old config.local.json media.model never takes effect');
});

test('describe: a picture request of every kind (image, gif frame, video poster, link, sticker, emoji) skips the text calibration', async () => {
  const items = [
    pictureItem('a1'),
    pictureItem('a2', { kind: 'gif', url: 'https://cdn.discordapp.com/x/anim.gif' }),
    pictureItem('a3', { kind: 'video', url: 'https://cdn.discordapp.com/x/poster.png' }),
    pictureItem('link:abcd1234', { kind: 'link', url: 'https://cdn.discordapp.com/x/thumb.jpg' }),
    pictureItem('sticker:s1', { kind: 'sticker', url: 'https://media.discordapp.net/stickers/s1.png?size=160' }),
    pictureItem('emoji:e1', { kind: 'emoji', url: 'https://cdn.discordapp.com/emojis/e1.webp?size=96' }),
  ];
  for (const item of items) {
    const llm = fakeLlm({ text: 'a cat' });
    const describer = createDescriber({ hot: fakeHot(), store: createStore({ dataDir: tmpDataDir() }), llm, imageFetcher: fakeImageFetcher() });
    await describer.describe('g1', item);
    assert.equal(llm.calls.length, 1, item.kind);
    assert.equal(llm.calls[0].messages[1].content[0].type, 'image_url', item.kind);
    assert.equal(llm.calls[0].options.skipCalibration, true, `${item.kind}: a picture request must never feed the text calibration`);
  }
});

test('describe: a picture describe through the real client never reaches the calibrator, even with prompt_tokens counted', async () => {
  const hot = fakeHot({
    config: {
      llm: {
        baseUrl: 'https://openrouter.test/api/v1',
        temperature: 1,
        maxOutputTokens: 100,
        maxRequestTokens: 50_000,
        maxRequestsPerDay: 300,
        timeoutMs: 5_000,
        retries: 0,
      },
    },
  });
  const observed = [];
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => hot.config,
    calibrator: { ratio: 1, apply: (n) => n, observe: (raw, counted) => observed.push({ raw, counted }) },
    state: { data: {}, markDirty() {} },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'a cat' } }], usage: { prompt_tokens: 1500 } }),
    }),
  });
  const describer = createDescriber({ hot, store: createStore({ dataDir: tmpDataDir() }), llm, imageFetcher: fakeImageFetcher() });

  assert.equal((await describer.describe('g1', pictureItem('a1'))).text, 'a cat');
  assert.deepEqual(observed, [], 'a vision prompt count says nothing about the text ratio');
});

// --- describeMany --------------------------------------------------------

test('describeMany: caps NEW descriptions at maxNew, cache hits are free', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm([{ text: 'one' }, { text: 'two' }, { text: 'three' }]);
  const describer = createDescriber({ hot, store, llm, imageFetcher: fakeImageFetcher() });

  // Pre-cache "a1" so its lookup is free and does not count toward maxNew.
  await describer.describe('g1', pictureItem('a1'));

  const items = [pictureItem('a1'), pictureItem('a2'), pictureItem('a3'), pictureItem('a4')];
  const { descriptions, newCount } = await describer.describeMany('g1', items, { maxNew: 2 });

  assert.equal(newCount, 2);
  assert.equal(descriptions.size, 3, 'a1 (cached) + 2 new ones');
  assert.ok(descriptions.has('a1'));
  assert.ok(descriptions.has('a2'));
  assert.ok(descriptions.has('a3'));
  assert.ok(!descriptions.has('a4'), 'maxNew reached before a4');
});

test('describeMany: calls onCharge once per NEW request, never for a cache hit', async () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir });
  const hot = fakeHot();
  const llm = fakeLlm([{ text: 'one', usage: { prompt_tokens: 10 } }, { text: 'two', usage: { prompt_tokens: 20 } }]);
  const describer = createDescriber({ hot, store, llm, imageFetcher: fakeImageFetcher() });
  await describer.describe('g1', pictureItem('a1'));

  const charges = [];
  await describer.describeMany('g1', [pictureItem('a1'), pictureItem('a2')], { onCharge: (r) => charges.push(r) });

  assert.equal(charges.length, 1);
  assert.equal(charges[0].usage.prompt_tokens, 20);
});

/** A fake llm whose answers wait until `release()`: shows which requests were in flight together. */
function gatedLlm(text = 'ένας γάτος') {
  const calls = [];
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  return {
    calls,
    release: () => open(),
    complete: async (messages, options) => {
      calls.push({ messages, options });
      await gate;
      return { text };
    },
  };
}

test('describeMany: two concurrent calls on one new picture share one download and one request', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const llm = gatedLlm();
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot: fakeHot(), store, llm, imageFetcher });
  const charges = [];

  const first = describer.describeMany('g1', [pictureItem('s1', { kind: 'sticker' })], { onCharge: (r) => charges.push(r) });
  const second = describer.describeMany('g1', [pictureItem('s1', { kind: 'sticker' })], { onCharge: (r) => charges.push(r) });
  await new Promise((resolve) => setImmediate(resolve));
  llm.release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(imageFetcher.calls.length, 1);
  assert.equal(llm.calls.length, 1);
  assert.equal(a.descriptions.get('s1'), 'ένας γάτος');
  assert.equal(b.descriptions.get('s1'), 'ένας γάτος');
  assert.equal(charges.length, 1, 'the request is charged to the caller that sent it, once');
});

test('describeMany: every picked item counts toward maxNew, a failure included', async () => {
  const items = Array.from({ length: 15 }, (_, i) => pictureItem(`f${i}`));
  const failing = fakeLlm(new Error('provider down'));
  const failingRun = createDescriber({ hot: fakeHot(), store: createStore({ dataDir: tmpDataDir() }), llm: failing, imageFetcher: fakeImageFetcher() });
  const failed = await failingRun.describeMany('g1', items, { maxNew: 6 });
  assert.equal(failing.calls.length, 6);
  assert.equal(failed.newCount, 6);
  assert.equal(failed.descriptions.size, 0);

  const empty = fakeLlm({ text: '   ' });
  const emptyRun = createDescriber({ hot: fakeHot(), store: createStore({ dataDir: tmpDataDir() }), llm: empty, imageFetcher: fakeImageFetcher() });
  await emptyRun.describeMany('g1', items.slice(0, 10), { maxNew: 1 });
  assert.equal(empty.calls.length, 1);

  const imageFetcher = fakeImageFetcher(null);
  const noDownload = createDescriber({ hot: fakeHot(), store: createStore({ dataDir: tmpDataDir() }), llm: fakeLlm({ text: 'x' }), imageFetcher });
  assert.equal((await noDownload.describeMany('g1', items, { maxNew: 3 })).newCount, 3);
  assert.equal(imageFetcher.calls.length, 3, 'a failed download is an attempt too');
});

test('describeMany: the picked items are described in parallel; cached captions anywhere are filled in free', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  store.getMediaCache('g1').old = { text: 'une vieille photo', ts: 1 };
  const llm = gatedLlm();
  const describer = createDescriber({ hot: fakeHot(), store, llm, imageFetcher: fakeImageFetcher() });
  const items = [pictureItem('a1'), pictureItem('a2'), pictureItem('a3'), pictureItem('old')];

  const running = describer.describeMany('g1', items, { maxNew: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(llm.calls.length, 2, 'both picked requests are out before either answers');
  llm.release();
  const { descriptions, newCount } = await running;

  assert.equal(newCount, 2);
  assert.deepEqual([...descriptions.keys()], ['a1', 'a2', 'old'], 'in the order of the items; a3 is past maxNew');
  assert.equal(descriptions.get('old'), 'une vieille photo');
});

/** fakeLlm plus a read-only capLeft that reports `left` (and counts its reads). */
function cappedLlm(left, responses = { text: 'a cat' }) {
  const llm = fakeLlm(responses);
  llm.capReads = 0;
  llm.capLeft = () => {
    llm.capReads += 1;
    return typeof left === 'function' ? left() : left;
  };
  return llm;
}

test('describe: with the daily request cap spent nothing is downloaded, requested or cached', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const llm = cappedLlm(0);
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot: fakeHot(), store, llm, imageFetcher });

  assert.equal(await describer.describe('g1', pictureItem('a1')), null);
  const many = await describer.describeMany('g1', [pictureItem('a2'), pictureItem('a3')], { maxNew: 6 });
  assert.equal(many.newCount, 0);
  assert.equal(imageFetcher.calls.length, 0);
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(Object.keys(store.getMediaCache('g1')), []);
});

test('describe: a refusal by the daily request cap caches no miss; the token rail still does', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const describer = createDescriber({ hot: fakeHot(), store, llm: fakeLlm([new DailyCapError('day'), { text: 'a cat' }]), imageFetcher: fakeImageFetcher() });
  const { result, logs } = await withCapturedLogs(() => describer.describe('g1', pictureItem('a1')));
  assert.equal(result, null);
  assert.equal(store.getMediaCache('g1').a1, undefined);
  assert.equal(logs.find((l) => l.msg === 'describe: failed').reason, 'daily-cap');
  assert.equal((await describer.describe('g1', pictureItem('a1'))).text, 'a cat', 'described once the cap allows it');

  const tokenStore = createStore({ dataDir: tmpDataDir() });
  const tokenRun = createDescriber({ hot: fakeHot(), store: tokenStore, llm: fakeLlm(new TokenLimitError('too big')), imageFetcher: fakeImageFetcher() });
  const token = await withCapturedLogs(() => tokenRun.describe('g1', pictureItem('a1')));
  assert.equal(tokenStore.getMediaCache('g1').a1.miss, true);
  assert.equal(token.logs.find((l) => l.msg === 'describe: failed').reason, 'token-limit');
});

// --- describeVideo -------------------------------------------------------

const VIDEO_PROMPT = 'Watch this clip and say what happens.';
const VIDEO_CFG = {
  provider: { order: ['pinned'], allow_fallbacks: false },
  maxOutputTokens: 400,
  maxRequestTokens: 60_000,
  maxSeconds: 60,
  directUrlMaxSeconds: 180,
  maxBytes: 8_000_000,
  maxPerTurn: 1,
  maxPerDay: 40,
  timeoutMs: 90_000,
  toolTimeoutMs: 60_000,
  sites: ['youtube.com', 'youtu.be', 'tiktok.com'],
  directUrlSites: ['youtube.com', 'youtu.be'],
  ytdlpPath: 'yt-dlp-test',
  ffmpegPath: 'ffmpeg-test',
  urlProcessing: 'agentic',
  errorRetryMinutes: 60,
};

function videoHot({ features = {}, video = {}, prompts = {} } = {}) {
  return {
    config: {
      features: { mediaDescriptions: true, videoDescriptions: true, ...features },
      models: { base: { vision: 'x/haiku', video: 'x/video-model' } },
      media: { maxOutputTokens: 120, cacheEntries: 5000, video: { ...VIDEO_CFG, ...video } },
      context: { vision: { maxBytes: 1_500_000, fetchTimeoutMs: 10_000 } },
    },
    prompts: { describe: 'Describe this picture.', 'describe-video': VIDEO_PROMPT, ...prompts },
  };
}

function fakeState(data = {}) {
  let dirty = 0;
  return {
    data,
    markDirty() {
      dirty += 1;
    },
    get dirtyCount() {
      return dirty;
    },
  };
}

const CLIP_DATA_URL = 'data:video/mp4;base64,Y2xpcA==';
// What media.video.audioMap resolves to when the config has no such key.
const AUDIO_MAP_ON = { noiseDb: -50, minSilenceSeconds: 0.5, mapBelowShare: 0.8, maxSpans: 20 };

/** A fake createVideoFetcher()-shaped dependency; every method records its call and returns the given result. */
function fakeVideoFetcher({
  attachment = { ok: true, dataUrl: CLIP_DATA_URL, mimeType: 'video/mp4', seconds: 12, bytes: 4 },
  probe = { ok: true, durationSec: 30, title: 'Ελληνικό' },
  clip = { ok: true, dataUrl: CLIP_DATA_URL, mimeType: 'video/mp4', seconds: 60, bytes: 4 },
  youtube = { ok: false, reason: 'download' },
} = {}) {
  const calls = [];
  return {
    calls,
    fetchAttachment: async (url, options) => {
      calls.push({ fn: 'fetchAttachment', url, options });
      return attachment;
    },
    probeSite: async (url, options) => {
      calls.push({ fn: 'probeSite', url, options });
      return probe;
    },
    fetchSiteClip: async (url, options) => {
      calls.push({ fn: 'fetchSiteClip', url, options });
      return clip;
    },
    probeYoutube: async (url, options) => {
      calls.push({ fn: 'probeYoutube', url, options });
      return youtube;
    },
  };
}

function videoAttachment(itemId = 'v1', overrides = {}) {
  return {
    source: 'attachment',
    messageId: 'm1',
    itemId,
    kind: 'video',
    url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4?ex=secret',
    name: 'clip.mp4',
    durationSec: 12,
    bytes: 1000,
    ...overrides,
  };
}

function videoLink(itemId = 'video:url:0123456789abcdef', overrides = {}) {
  return {
    source: 'link',
    messageId: 'm1',
    itemId,
    kind: 'link',
    url: 'https://www.youtube.com/watch?v=abc',
    site: 'youtube.com',
    name: 'A title',
    durationSec: null,
    ...overrides,
  };
}

function videoDescriber({
  hot = videoHot(),
  llm = fakeLlm({ text: 'someone dances' }),
  videoFetcher = fakeVideoFetcher(),
  state = fakeState(),
  now,
  youtubeApiKey,
} = {}) {
  const store = createStore({ dataDir: tmpDataDir() });
  const describer = createDescriber({
    hot,
    store,
    llm,
    imageFetcher: fakeImageFetcher(),
    videoFetcher,
    state,
    ...(now ? { now } : {}),
    ...(youtubeApiKey !== undefined ? { youtubeApiKey } : {}),
  });
  return { describer, store, llm, videoFetcher, state, hot };
}

test('describeVideo: attachment is watched through a data URL with the video settings', async () => {
  const { describer, llm, videoFetcher, state } = videoDescriber();
  const result = await describer.describeVideo('g1', videoAttachment());

  assert.equal(result.state, 'watched');
  assert.equal(result.text, 'someone dances');
  assert.equal(videoFetcher.calls.length, 1);
  assert.equal(videoFetcher.calls[0].fn, 'fetchAttachment');
  assert.deepEqual(videoFetcher.calls[0].options, {
    durationSec: 12,
    maxSeconds: 60,
    maxBytes: 8_000_000,
    toolTimeoutMs: 60_000,
    ffmpegPath: 'ffmpeg-test',
    fetchTimeoutMs: 10_000,
    audioMap: AUDIO_MAP_ON,
  });
  assert.equal(llm.calls.length, 1);
  const [system, user] = llm.calls[0].messages;
  assert.deepEqual(system, { role: 'system', content: VIDEO_PROMPT });
  assert.deepEqual(user.content, [{ type: 'video_url', video_url: { url: CLIP_DATA_URL } }]);
  const options = llm.calls[0].options;
  assert.equal(options.model, 'x/video-model');
  assert.equal(options.maxOutputTokens, 400);
  assert.equal(options.timeoutMs, 90_000);
  assert.equal(options.videoSeconds, 12);
  assert.equal(options.provider, undefined, 'a downloaded clip does not pin the provider');
  assert.equal(options.skipCalibration, true, 'a video request must never feed the text calibration');
  assert.equal(options.countAgainstDailyCap, true);
  assert.equal(state.data.videoCount, 1);
});

test('describeVideo: the video model is models.base.video; the deprecated media.video.model is ignored', async () => {
  const withNew = videoHot();
  withNew.config.models = { base: { video: 'x/new-video', vision: 'x/vision' } };
  const fresh = videoDescriber({ hot: withNew });
  await fresh.describer.describeVideo('g1', videoAttachment());
  assert.equal(fresh.llm.calls[0].options.model, 'x/new-video');

  const withOld = videoHot({ video: { model: 'x/old-video' } });
  withOld.config.models = { base: { video: null, vision: 'x/vision' } };
  const old = videoDescriber({ hot: withOld });
  await old.describer.describeVideo('g1', videoAttachment());
  assert.equal(old.llm.calls[0].options.model, ROLE_DEFAULTS.video, 'the role default: an old config.local.json media.video.model never takes effect');
});

test('describeVideo: a direct-URL site within maxSeconds sends the public URL with the pinned provider', async () => {
  const { describer, llm, videoFetcher } = videoDescriber();
  const result = await describer.describeVideo('g1', videoLink());

  assert.equal(result.state, 'watched');
  assert.deepEqual(
    videoFetcher.calls.map((c) => c.fn),
    ['probeSite'],
  );
  assert.deepEqual(videoFetcher.calls[0].options, { ytdlpPath: 'yt-dlp-test', toolTimeoutMs: 60_000, proxy: null, proxyRetryMinutes: undefined });
  assert.deepEqual(llm.calls[0].messages[1].content, [
    { type: 'video_url', video_url: { url: 'https://www.youtube.com/watch?v=abc', processing: 'agentic' } },
  ]);
  assert.deepEqual(llm.calls[0].options.provider, VIDEO_CFG.provider);
  assert.equal(llm.calls[0].options.videoSeconds, 30);
});

test('describeVideo: a non-direct site downloads a clip; the raw URL never reaches the request', async () => {
  const { describer, llm, videoFetcher } = videoDescriber();
  const item = videoLink('video:url:aaaaaaaaaaaaaaaa', { url: 'https://www.tiktok.com/@someone/video/123', site: 'tiktok.com' });
  const result = await describer.describeVideo('g1', item);

  assert.equal(result.state, 'watched');
  assert.deepEqual(
    videoFetcher.calls.map((c) => c.fn),
    ['probeSite', 'fetchSiteClip'],
  );
  assert.deepEqual(videoFetcher.calls[1].options, {
    ytdlpPath: 'yt-dlp-test',
    ffmpegPath: 'ffmpeg-test',
    maxSeconds: 60,
    maxBytes: 8_000_000,
    toolTimeoutMs: 60_000,
    durationSec: 30,
    proxy: null,
    proxyRetryMinutes: undefined,
    audioMap: AUDIO_MAP_ON,
  });
  const body = JSON.stringify(llm.calls[0].messages);
  assert.ok(!body.includes('tiktok.com'), 'only the data URL is sent');
  assert.ok(body.includes(CLIP_DATA_URL));
  assert.equal(llm.calls[0].options.provider, undefined);
  assert.equal(llm.calls[0].options.videoSeconds, 60);
});

test('describeVideo: a direct-URL site longer than maxSeconds (or of unknown length) is clipped instead', async () => {
  for (const durationSec of [600, null]) {
    const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec, title: null } });
    const { describer, llm } = videoDescriber({ videoFetcher });
    const result = await describer.describeVideo('g1', videoLink());
    assert.equal(result.state, 'watched');
    assert.deepEqual(
      videoFetcher.calls.map((c) => c.fn),
      ['probeSite', 'fetchSiteClip'],
    );
    assert.ok(!JSON.stringify(llm.calls[0].messages).includes('youtube.com'));
    assert.equal(llm.calls[0].options.provider, undefined);
  }
});

test('describeVideo: a cache hit is free and marked cached', async () => {
  const { describer, llm, videoFetcher, state } = videoDescriber();
  await describer.describeVideo('g1', videoAttachment());
  const again = await describer.describeVideo('g1', videoAttachment());

  assert.deepEqual(again, { state: 'watched', text: 'someone dances', watchedSeconds: 12, usage: null, estimated: 0, cached: true });
  assert.equal(llm.calls.length, 1);
  assert.equal(videoFetcher.calls.length, 1);
  assert.equal(state.data.videoCount, 1);
});

test('describeVideo: an attachment size failure is a permanent limit, never retried', async () => {
  let t = 1_000_000;
  const videoFetcher = fakeVideoFetcher({ attachment: { ok: false, reason: 'size' } });
  const { describer, llm, store, state } = videoDescriber({ videoFetcher, now: () => t });

  assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'limit', reason: 'size' });
  t += 30 * 24 * 60 * 60_000;
  assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'limit', reason: 'size' });

  assert.equal(videoFetcher.calls.length, 1, 'the permanent miss is served from the cache');
  assert.equal(llm.calls.length, 0);
  assert.equal(store.getMediaCache('g1')['video:v1'].reason, 'size');
  assert.equal(state.data.videoCount, 1, 'the attempt reserved its daily slot, which it keeps');
});

test('describeVideo: a download/tool/timeout failure is an error miss, retried after an hour', async () => {
  for (const reason of ['download', 'tool', 'timeout']) {
    let t = 1_000_000;
    const videoFetcher = fakeVideoFetcher({ attachment: { ok: false, reason } });
    const { describer } = videoDescriber({ videoFetcher, now: () => t });

    assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'error' });
    t += 30 * 60_000;
    assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'error' });
    assert.equal(videoFetcher.calls.length, 1, 'inside the hour the miss is served from the cache');
    t += 31 * 60_000;
    assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'error' });
    assert.equal(videoFetcher.calls.length, 2, 'after the hour it is retried');
  }
});

test('describeVideo: media.video.errorRetryMinutes sets the error-miss TTL, read at the moment of use', async () => {
  let t = 1_000_000;
  const hot = videoHot();
  hot.config.media.video.errorRetryMinutes = 30;
  const videoFetcher = fakeVideoFetcher({ attachment: { ok: false, reason: 'download' } });
  const { describer } = videoDescriber({ hot, videoFetcher, now: () => t });

  assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'error' });
  t += 29 * 60_000;
  assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'error' });
  assert.equal(videoFetcher.calls.length, 1, 'inside 30 minutes the miss is served from the cache');
  t += 2 * 60_000;
  assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'error' });
  assert.equal(videoFetcher.calls.length, 2, 'after 31 minutes it is retried');

  hot.config.media.video.errorRetryMinutes = 120;
  t += 61 * 60_000;
  await describer.describeVideo('g1', videoAttachment());
  assert.equal(videoFetcher.calls.length, 2, 'a live change applies to the next lookup');
});

test('describeVideo: without errorRetryMinutes an error miss waits exactly what config.json ships (code fallback = shipped value)', async () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const minutes = shipped.media.video.errorRetryMinutes;
  assert.ok(typeof minutes === 'number' && minutes > 0, 'config.json ships a usable retry delay');
  let t = 1_000_000;
  const hot = videoHot({ video: { errorRetryMinutes: undefined } });
  const videoFetcher = fakeVideoFetcher({ attachment: { ok: false, reason: 'download' } });
  const { describer } = videoDescriber({ hot, videoFetcher, now: () => t });

  assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'error' });
  t += minutes * 60_000 - 1;
  await describer.describeVideo('g1', videoAttachment());
  assert.equal(videoFetcher.calls.length, 1, 'just before the shipped delay the miss is served from the cache');
  t += 1;
  await describer.describeVideo('g1', videoAttachment());
  assert.equal(videoFetcher.calls.length, 2, 'once the shipped delay has passed it is retried');
});

test('describeVideo: force retries an error miss at once and logs forced: true', async () => {
  let t = 1_000_000;
  let attachment = { ok: false, reason: 'download' };
  const videoFetcher = fakeVideoFetcher();
  const fetchAttachment = videoFetcher.fetchAttachment;
  videoFetcher.fetchAttachment = async (url, options) => {
    await fetchAttachment(url, options);
    return attachment;
  };
  const { describer, llm, state } = videoDescriber({ videoFetcher, now: () => t });

  assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'error' });
  t += 60_000;
  attachment = { ok: true, dataUrl: CLIP_DATA_URL, mimeType: 'video/mp4', seconds: 12, bytes: 4 };
  const { result, logs } = await withCapturedLogs(() => describer.describeVideo('g1', videoAttachment(), { force: true }));

  assert.equal(result.state, 'watched');
  assert.equal(result.text, 'someone dances');
  assert.equal(videoFetcher.calls.length, 2);
  assert.equal(llm.calls.length, 1);
  assert.equal(state.data.videoCount, 2, 'the forced attempt takes a daily slot like any other');
  const line = logs.find((l) => l.msg === 'describe: video');
  assert.equal(line.forced, true);
  assert.equal(line.cached, false);
  assert.ok(!JSON.stringify(logs).includes('someone dances'));
  assert.ok(!JSON.stringify(logs).includes('ex=secret'));
});

test('describeVideo: force still honours a limit miss and a watched entry', async () => {
  const limited = videoDescriber({ videoFetcher: fakeVideoFetcher({ attachment: { ok: false, reason: 'size' } }) });
  await limited.describer.describeVideo('g1', videoAttachment());
  assert.deepEqual(await limited.describer.describeVideo('g1', videoAttachment(), { force: true }), { state: 'limit', reason: 'size' });
  assert.equal(limited.videoFetcher.calls.length, 1, 'a limit stays a limit');

  const watched = videoDescriber();
  await watched.describer.describeVideo('g1', videoAttachment());
  const again = await watched.describer.describeVideo('g1', videoAttachment(), { force: true });
  assert.equal(again.cached, true);
  assert.equal(watched.videoFetcher.calls.length, 1, 'a watched video is never re-fetched');
  assert.equal(watched.llm.calls.length, 1);
});

test('describeVideo: force keeps the daily cap', async () => {
  const hot = videoHot();
  hot.config.media.video.maxPerDay = 1;
  const videoFetcher = fakeVideoFetcher({ attachment: { ok: false, reason: 'download' } });
  const { describer } = videoDescriber({ hot, videoFetcher });
  assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'error' });
  assert.deepEqual(await describer.describeVideo('g1', videoAttachment(), { force: true }), { state: 'limit', reason: 'daily' });
  assert.equal(videoFetcher.calls.length, 1);
});

test('describeVideo: a public-URL part carries media.video.urlProcessing; a data: URL part never does', async () => {
  const pinned = videoDescriber();
  await pinned.describer.describeVideo('g1', videoLink());
  assert.deepEqual(pinned.llm.calls[0].messages[1].content, [
    { type: 'video_url', video_url: { url: 'https://www.youtube.com/watch?v=abc', processing: 'agentic' } },
  ]);

  const clipped = videoDescriber();
  await clipped.describer.describeVideo('g1', videoLink('video:url:aaaaaaaaaaaaaaaa', { url: 'https://www.tiktok.com/@someone/video/123', site: 'tiktok.com' }));
  assert.deepEqual(clipped.llm.calls[0].messages[1].content, [{ type: 'video_url', video_url: { url: CLIP_DATA_URL } }]);

  const custom = videoDescriber({ hot: videoHot({ video: { urlProcessing: 'frames' } }) });
  await custom.describer.describeVideo('g1', videoLink());
  assert.equal(custom.llm.calls[0].messages[1].content[0].video_url.processing, 'frames');

  const hot = videoHot({ video: { urlProcessing: null } });
  const off = videoDescriber({ hot });
  await off.describer.describeVideo('g1', videoLink());
  assert.equal('processing' in off.llm.calls[0].messages[1].content[0].video_url, false, 'null omits the field');
});

test('describeVideo: without urlProcessing a public URL goes out in the mode config.json ships (code fallback = shipped value)', async () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const { describer, llm } = videoDescriber({ hot: videoHot({ video: { urlProcessing: undefined } }) });
  assert.equal((await describer.describeVideo('g1', videoLink())).state, 'watched');
  const part = llm.calls[0].messages[1].content[0].video_url;
  assert.equal(part.url, 'https://www.youtube.com/watch?v=abc', 'the pinned public URL');
  assert.equal(part.processing, shipped.media.video.urlProcessing);
});

test('describeVideo: the request body carries media.video.reasoning (shipped default) through the real client; a non-object omits it', async () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const run = async (reasoning) => {
    const hot = videoHot({ video: { reasoning } });
    hot.config.llm = {
      baseUrl: 'https://openrouter.test/api/v1',
      temperature: 1,
      maxOutputTokens: 100,
      maxRequestTokens: 50_000,
      maxRequestsPerDay: 300,
      timeoutMs: 5_000,
      retries: 0,
    };
    const bodies = [];
    const llm = createLlm({
      apiKey: 'k',
      getConfig: () => hot.config,
      calibrator: { ratio: 1, apply: (n) => n, observe: () => {} },
      state: { data: {}, markDirty() {} },
      fetchImpl: async (url, init) => {
        bodies.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'someone dances' } }], usage: {} }) };
      },
    });
    const { describer } = videoDescriber({ hot, llm });
    assert.equal((await describer.describeVideo('g1', videoAttachment())).state, 'watched');
    return bodies[0];
  };
  assert.deepEqual((await run(shipped.media.video.reasoning)).reasoning, { effort: 'low' });
  assert.equal('reasoning' in (await run(null)), false);
  assert.equal('reasoning' in (await run('off')), false);
});

test('describeVideo: a forced retry and a re-watch pass media.video.reasoning too', async () => {
  let t = 1_000_000;
  let attachment = { ok: false, reason: 'download' };
  const videoFetcher = fakeVideoFetcher();
  videoFetcher.fetchAttachment = async () => attachment;
  const hot = videoHot({ video: { reasoning: { effort: 'low' } } });
  hot.prompts['rewatch-answer'] = 'Answer {{question}} in {{maxChars}}.';
  const { describer, llm } = videoDescriber({ hot, videoFetcher, now: () => t });
  await describer.describeVideo('g1', videoAttachment());
  attachment = { ok: true, dataUrl: CLIP_DATA_URL, mimeType: 'video/mp4', seconds: 12, bytes: 4 };
  t += 60_000;
  await describer.describeVideo('g1', videoAttachment(), { force: true });
  await describer.rewatchVideo('g1', videoAttachment(), 'τι χρώμα;');
  assert.equal(llm.calls.length, 2);
  for (const call of llm.calls) assert.deepEqual(call.options.reasoning, { effort: 'low' });
});

test('describeVideo: a failed probe maps its reason like a fetch failure', async () => {
  const videoFetcher = fakeVideoFetcher({ probe: { ok: false, reason: 'tool' } });
  const { describer, llm } = videoDescriber({ videoFetcher });
  assert.deepEqual(await describer.describeVideo('g1', videoLink()), { state: 'error' });
  assert.equal(llm.calls.length, 0);
});

test('describeVideo: an LLM error (the token rail included) is an error miss', async () => {
  for (const error of [new Error('boom'), new TokenLimitError('cap')]) {
    const { describer, store } = videoDescriber({ llm: fakeLlm(error) });
    assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'error' });
    assert.equal(store.getMediaCache('g1')['video:v1'].reason, 'error');
  }
});

test('describeVideo: a refusal by the daily request cap caches no miss, so the video is watched after the reset', async () => {
  const { describer, store, videoFetcher, state } = videoDescriber({ llm: fakeLlm([new DailyCapError('day'), { text: 'someone dances' }]) });
  const { result, logs } = await withCapturedLogs(() => describer.describeVideo('g1', videoAttachment()));
  assert.equal(result, null);
  assert.equal(store.getMediaCache('g1')['video:v1'], undefined);
  const line = logs.find((l) => l.msg === 'describe: video');
  assert.equal(line.state, 'skipped');
  assert.equal(line.reason, 'daily-cap');
  assert.equal(videoFetcher.calls.length, 1);
  assert.equal(state.data.videoCount, 1, 'the slot reserved before the fetch is kept');
  assert.equal((await describer.describeVideo('g1', videoAttachment())).state, 'watched');
});

test('describeVideo: with the daily request cap spent nothing is fetched, no video slot is taken, nothing is cached', async () => {
  const llm = cappedLlm(0);
  const { describer, store, videoFetcher, state } = videoDescriber({ llm });
  const { result, logs } = await withCapturedLogs(() => describer.describeVideos('g1', [videoAttachment('v1'), videoLink()], { maxNew: 1 }));
  assert.equal(result.videos.size, 0);
  assert.equal(result.newCount, 0, 'the spent cap is no attempt');
  assert.equal(videoFetcher.calls.length, 0);
  assert.equal(llm.calls.length, 0);
  assert.equal(state.data.videoCount, undefined);
  assert.deepEqual(Object.keys(store.getMediaCache('g1')), []);
  assert.ok(logs.filter((l) => l.msg === 'describe: video').every((l) => l.state === 'skipped' && l.reason === 'daily-cap'));
});

test('rewatchVideo: with the daily request cap spent nothing is fetched and neither slot is taken', async () => {
  const llm = cappedLlm(0);
  const { describer, videoFetcher, state } = videoDescriber({ hot: rewatchHot(), llm });
  assert.equal(await describer.rewatchVideo('g1', videoAttachment(), 'τι χρώμα;'), null);
  assert.equal(videoFetcher.calls.length, 0);
  assert.equal(state.data.rewatchCount, undefined);
  assert.equal(state.data.videoCount, undefined);
});

test('videoCapsLeft: the video, re-watch and GIF watch slots left today, read only, the whole caps back after 00:00 UTC', async () => {
  const now = clock(Date.parse('2026-09-23T23:59:00Z'));
  const state = fakeState({ videoDay: '2026-09-23', videoCount: 3, rewatchDay: '2026-09-23', rewatchCount: 2, gifWatchDay: '2026-09-23', gifWatchCount: 1 });
  const hot = rewatchHot({ video: { maxPerDay: 5 }, rewatch: { maxPerDay: 4 } });
  hot.config.media.gif = { maxPerDay: 7 };
  const { describer } = videoDescriber({ hot, state, now });
  const before = structuredClone(state.data);
  assert.deepEqual(describer.videoCapsLeft(), { video: 2, rewatch: 2, gif: 6 });
  now.advance(2 * 60_000);
  assert.deepEqual(describer.videoCapsLeft(), { video: 5, rewatch: 4, gif: 7 });
  assert.deepEqual(state.data, before, 'never rolled over or written');
  assert.equal(state.dirtyCount, 0);

  const unlimitedHot = rewatchHot({ video: { maxPerDay: null }, rewatch: { maxPerDay: null } });
  unlimitedHot.config.media.gif = { maxPerDay: 3 };
  const unlimited = videoDescriber({ hot: unlimitedHot });
  assert.deepEqual(unlimited.describer.videoCapsLeft(), { video: Infinity, rewatch: Infinity, gif: 3 });
});

test('videoStateFromCache: watched, a permanent limit, or null -- a length miss that fits the cap now is no limit', () => {
  const config = { media: { video: { maxSeconds: 60 } } };
  assert.deepEqual(videoStateFromCache({ text: 'ένας χορός', ts: 1, watched: true }, config), { state: 'watched', text: 'ένας χορός' });
  assert.deepEqual(
    videoStateFromCache({ text: 'ένας χορός', ts: 1, watched: true, watchedSeconds: 300 }, config),
    { state: 'watched', text: 'ένας χορός', watchedSeconds: 300 },
  );
  assert.deepEqual(videoStateFromCache({ miss: true, ts: 1, reason: 'size' }, config), { state: 'limit', reason: 'size' });
  assert.deepEqual(videoStateFromCache({ miss: true, ts: 1, reason: 'length', durationSec: 600 }, config), { state: 'limit', reason: 'length' });
  assert.equal(videoStateFromCache({ miss: true, ts: 1, reason: 'length', durationSec: 30 }, config), null, 'fits the cap now');
  assert.equal(videoStateFromCache({ miss: true, ts: 1, reason: 'length' }, config), null, 'unknown length: one probe to learn it');
  assert.equal(videoStateFromCache({ miss: true, ts: 1, reason: 'error' }, config), null, 'an error miss is not a lasting state');
  assert.equal(videoStateFromCache(undefined, config), null);
  // A pinnable direct-URL link has its own, larger cap.
  const direct = { media: { video: { maxSeconds: 60, directUrlMaxSeconds: 900, provider: { order: ['p'] }, directUrlSites: ['youtube.com'] } } };
  const link = { source: 'link', url: 'https://www.youtube.com/watch?v=abc' };
  assert.equal(videoStateFromCache({ miss: true, ts: 1, reason: 'length', durationSec: 600 }, direct, link), null);
  assert.deepEqual(videoStateFromCache({ miss: true, ts: 1, reason: 'length', durationSec: 600 }, direct), { state: 'limit', reason: 'length' });
});

test('describeVideo: the daily cap returns daily without a request and without caching', async () => {
  const now = () => Date.parse('2026-09-23T12:00:00Z');
  const state = fakeState({ videoDay: '2026-09-23', videoCount: 40 });
  const { describer, llm, videoFetcher, store } = videoDescriber({ state, now });

  assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'limit', reason: 'daily' });
  assert.equal(llm.calls.length, 0);
  assert.equal(videoFetcher.calls.length, 0);
  assert.equal(store.getMediaCache('g1')['video:v1'], undefined);
  assert.equal(state.data.videoCount, 40);
});

test('describeVideo: the daily counter resets on a new day and counts only sent requests', async () => {
  const now = () => Date.parse('2026-09-24T00:30:00Z');
  const state = fakeState({ videoDay: '2026-09-23', videoCount: 40 });
  const { describer } = videoDescriber({ state, now });

  assert.equal((await describer.describeVideo('g1', videoAttachment())).state, 'watched');
  assert.equal(state.data.videoDay, '2026-09-24');
  assert.equal(state.data.videoCount, 1);
  assert.ok(state.dirtyCount > 0);
});

test('describeVideo: feature off, missing prompt or a non-video item -> null without any request', async () => {
  const cases = [
    { hot: videoHot({ features: { videoDescriptions: false } }), item: videoAttachment() },
    { hot: videoHot({ prompts: { 'describe-video': undefined } }), item: videoAttachment() },
    { hot: videoHot(), item: pictureItem('a1') },
  ];
  for (const { hot, item } of cases) {
    const { describer, llm, videoFetcher } = videoDescriber({ hot });
    assert.equal(await describer.describeVideo('g1', item), null);
    assert.equal(llm.calls.length, 0);
    assert.equal(videoFetcher.calls.length, 0);
  }
});

test('describeVideo: the text is collapsed to one line and capped at 600 chars on a word boundary', async () => {
  const long = `  Première   scène\n\nκάποιος χορεύει\t${'mot '.repeat(300)}`;
  const { describer } = videoDescriber({ hot: videoHot({ video: { summaryChars: 600 } }), llm: fakeLlm({ text: long }) });
  const { text } = await describer.describeVideo('g1', videoAttachment());

  assert.ok(text.startsWith('Première scène κάποιος χορεύει mot'));
  assert.ok(!/\s{2,}|[\n\t]/.test(text));
  assert.ok([...text].length <= 600);
  assert.ok(text.endsWith('mot'), 'cut at a word boundary');
});

test('describeVideo: an empty answer is an error miss', async () => {
  const { describer, store } = videoDescriber({ llm: fakeLlm({ text: '  \n ' }) });
  assert.deepEqual(await describer.describeVideo('g1', videoAttachment()), { state: 'error' });
  assert.equal(store.getMediaCache('g1')['video:v1'].reason, 'error');
});

test('describeVideo: logs codes only -- never the text or a full URL', async () => {
  const { describer } = videoDescriber({ llm: fakeLlm({ text: 'a secret caption' }) });
  const { logs } = await withCapturedLogs(() => describer.describeVideo('g1', videoAttachment()));
  assert.ok(logs.some((line) => JSON.stringify(line).includes('describe: video')), 'one describe: video line');
  const all = JSON.stringify(logs);
  assert.ok(!all.includes('a secret caption'));
  assert.ok(!all.includes('ex=secret'));
});

test('describeVideo: two concurrent calls for one video send one request', async () => {
  const { describer, llm, videoFetcher } = videoDescriber();
  const [a, b] = await Promise.all([
    describer.describeVideo('g1', videoAttachment()),
    describer.describeVideo('g1', videoAttachment()),
  ]);
  assert.equal(a.state, 'watched');
  assert.equal(b.state, 'watched');
  assert.equal(llm.calls.length, 1);
  assert.equal(videoFetcher.calls.length, 1);
});

// --- describeVideos ------------------------------------------------------

test('describeVideos: caps NEW requests at maxNew; cache hits and limit states are free', async () => {
  const { describer, llm, store } = videoDescriber({ llm: fakeLlm([{ text: 'one' }, { text: 'two' }, { text: 'three' }]) });
  await describer.describeVideo('g1', videoAttachment('v1'));
  store.getMediaCache('g1')['video:v0'] = { miss: true, ts: Date.now(), reason: 'length', durationSec: 600 };

  const items = [videoAttachment('v0'), videoAttachment('v1'), videoAttachment('v2'), videoAttachment('v3')];
  const { videos, newCount } = await describer.describeVideos('g1', items, { maxNew: 1 });

  assert.equal(newCount, 1);
  assert.equal(llm.calls.length, 2);
  assert.deepEqual(videos.get('v0'), { state: 'limit', reason: 'length' });
  assert.equal(videos.get('v1').text, 'one');
  assert.equal(videos.get('v2').text, 'two');
  assert.ok(!videos.has('v3'), 'maxNew reached: v3 is neither watched nor cached');
});

test('describeVideos: past maxNew an already-watched video still comes from the cache', async () => {
  const { describer, llm } = videoDescriber({ llm: fakeLlm([{ text: 'old' }, { text: 'new' }]) });
  await describer.describeVideo('g1', videoAttachment('old'));

  const { videos, newCount } = await describer.describeVideos('g1', [videoAttachment('new'), videoAttachment('old')], {
    maxNew: 1,
  });
  assert.equal(newCount, 1);
  assert.equal(llm.calls.length, 2);
  assert.equal(videos.get('new').text, 'new');
  assert.equal(videos.get('old').text, 'old');
});

test('describeVideos: onCharge fires once per sent request, never for a cache hit or a failed fetch (which still counts as an attempt)', async () => {
  let n = 0;
  const videoFetcher = fakeVideoFetcher();
  videoFetcher.fetchAttachment = async (url) => {
    n += 1;
    return url.includes('broken')
      ? { ok: false, reason: 'download' }
      : { ok: true, dataUrl: CLIP_DATA_URL, mimeType: 'video/mp4', seconds: 5, bytes: 4 };
  };
  const { describer } = videoDescriber({
    llm: fakeLlm([
      { text: 'one', usage: { prompt_tokens: 9 } },
      { text: 'two', usage: { prompt_tokens: 11 } },
    ]),
    videoFetcher,
  });
  await describer.describeVideo('g1', videoAttachment('v1'));

  const charges = [];
  const items = [
    videoAttachment('v1'),
    videoAttachment('vb', { url: 'https://cdn.discordapp.com/broken.mp4' }),
    videoAttachment('v2'),
  ];
  const { videos, newCount } = await describer.describeVideos('g1', items, { onCharge: (r) => charges.push(r) });

  assert.equal(newCount, 2, 'the failed fetch and the sent request are both attempts; the cache hit is not');
  assert.equal(charges.length, 1);
  assert.equal(charges[0].usage.prompt_tokens, 11);
  assert.deepEqual(videos.get('vb'), { state: 'error' });
  assert.equal(n, 3);
});

test('describeVideos: a failed fetch counts toward maxNew -- with maxNew 1 the next uncached item is never attempted', async () => {
  const videoFetcher = fakeVideoFetcher({ attachment: { ok: false, reason: 'timeout' } });
  const { describer, llm } = videoDescriber({ videoFetcher });

  const { videos, newCount } = await describer.describeVideos('g1', [videoAttachment('v1'), videoAttachment('v2')], {
    maxNew: 1,
  });

  assert.equal(newCount, 1);
  assert.equal(videoFetcher.calls.length, 1, 'v2 is never fetched');
  assert.equal(videoFetcher.calls[0].url, videoAttachment('v1').url);
  assert.equal(llm.calls.length, 0);
  assert.deepEqual(videos.get('v1'), { state: 'error' });
  assert.ok(!videos.has('v2'));
});

test('describeVideo: mediaDescriptions off with videoDescriptions on -> null and no fetcher call', async () => {
  const hot = videoHot({ features: { mediaDescriptions: false, videoDescriptions: true } });
  const { describer, llm, videoFetcher } = videoDescriber({ hot });

  assert.equal(await describer.describeVideo('g1', videoAttachment()), null);
  assert.equal(videoFetcher.calls.length, 0);
  assert.equal(llm.calls.length, 0);
});

test('describeVideo: the daily slot is reserved before the fetch -- two concurrent new videos at cap-1 fetch once', async () => {
  const now = () => Date.parse('2026-09-23T12:00:00Z');
  const state = fakeState({ videoDay: '2026-09-23', videoCount: 39 });
  const { describer, llm, videoFetcher } = videoDescriber({ state, now });

  const [a, b] = await Promise.all([
    describer.describeVideo('g1', videoAttachment('v1')),
    describer.describeVideo('g1', videoAttachment('v2')),
  ]);

  assert.equal(a.state, 'watched');
  assert.deepEqual(b, { state: 'limit', reason: 'daily' });
  assert.equal(videoFetcher.calls.length, 1);
  assert.equal(llm.calls.length, 1);
  assert.equal(state.data.videoCount, 40);
});

test('describeVideo: a fetch that fails after the reservation keeps its daily slot', async () => {
  const now = () => Date.parse('2026-09-23T12:00:00Z');
  const state = fakeState({ videoDay: '2026-09-23', videoCount: 39 });
  const videoFetcher = fakeVideoFetcher({ attachment: { ok: false, reason: 'download' } });
  const { describer, llm } = videoDescriber({ state, now, videoFetcher });

  assert.deepEqual(await describer.describeVideo('g1', videoAttachment('v1')), { state: 'error' });
  assert.equal(state.data.videoCount, 40);
  assert.deepEqual(await describer.describeVideo('g1', videoAttachment('v2')), { state: 'limit', reason: 'daily' });
  assert.equal(videoFetcher.calls.length, 1);
  assert.equal(llm.calls.length, 0);
});

test('describeVideo: without a usable provider object a direct-URL site is downloaded, never sent by public URL', async () => {
  for (const provider of [null, undefined, 'google-ai-studio', ['pinned']]) {
    const { describer, llm, videoFetcher } = videoDescriber({ hot: videoHot({ video: { provider } }) });
    const result = await describer.describeVideo('g1', videoLink());

    assert.equal(result.state, 'watched');
    assert.deepEqual(
      videoFetcher.calls.map((c) => c.fn),
      ['probeSite', 'fetchSiteClip'],
      `provider ${JSON.stringify(provider)}`,
    );
    const body = JSON.stringify(llm.calls[0].messages);
    assert.ok(!body.includes('youtube.com'), 'only the data URL is sent');
    assert.ok(body.includes(CLIP_DATA_URL));
    assert.equal(llm.calls[0].options.provider, undefined);
  }
});

// --- the link chain: yt-dlp, then the YouTube probe, then the unknown-duration switch ---

const TIKTOK = { url: 'https://www.tiktok.com/@someone/video/123', site: 'tiktok.com' };
const PROBE_FAILED = { ok: false, reason: 'download' };
const LINK_KEY = 'video:video:url:0123456789abcdef';

test('describeVideo: yt-dlp fails on YouTube -> the page probe gives the duration -> the URL goes out pinned', async () => {
  const videoFetcher = fakeVideoFetcher({ probe: PROBE_FAILED, youtube: { ok: true, durationSec: 42 } });
  const { describer, llm } = videoDescriber({ videoFetcher, youtubeApiKey: 'test-key' });

  const result = await describer.describeVideo('g1', videoLink());

  assert.equal(result.state, 'watched');
  assert.deepEqual(videoFetcher.calls.map((c) => c.fn), ['probeSite', 'probeYoutube']);
  assert.equal(videoFetcher.calls[1].url, 'https://www.youtube.com/watch?v=abc');
  assert.deepEqual(videoFetcher.calls[1].options, { fetchTimeoutMs: 10_000, apiKey: 'test-key' });
  assert.deepEqual(llm.calls[0].messages[1].content, [
    { type: 'video_url', video_url: { url: 'https://www.youtube.com/watch?v=abc', processing: 'agentic' } },
  ]);
  assert.deepEqual(llm.calls[0].options.provider, VIDEO_CFG.provider);
  assert.equal(llm.calls[0].options.videoSeconds, 42);
});

test('describeVideo: the YouTube probe runs only when yt-dlp failed and only for a YouTube URL', async () => {
  const ok = fakeVideoFetcher({ youtube: { ok: true, durationSec: 42 } });
  await videoDescriber({ videoFetcher: ok }).describer.describeVideo('g1', videoLink());
  assert.deepEqual(ok.calls.map((c) => c.fn), ['probeSite']);

  const tiktok = fakeVideoFetcher({ probe: PROBE_FAILED, youtube: { ok: true, durationSec: 42 } });
  const { describer, llm } = videoDescriber({ videoFetcher: tiktok });
  assert.deepEqual(await describer.describeVideo('g1', videoLink('video:url:bbbbbbbbbbbbbbbb', TIKTOK)), { state: 'error' });
  assert.deepEqual(tiktok.calls.map((c) => c.fn), ['probeSite']);
  assert.equal(llm.calls.length, 0);
});

test('describeVideo: every probe failed and directUrlUnknownDuration off (or not exactly true) -> error miss, no request', async () => {
  for (const directUrlUnknownDuration of [false, undefined, 'true', 1]) {
    const videoFetcher = fakeVideoFetcher({ probe: PROBE_FAILED });
    const { describer, llm, store } = videoDescriber({ videoFetcher, hot: videoHot({ video: { directUrlUnknownDuration } }) });

    assert.deepEqual(await describer.describeVideo('g1', videoLink()), { state: 'error' }, String(directUrlUnknownDuration));
    assert.deepEqual(videoFetcher.calls.map((c) => c.fn), ['probeSite', 'probeYoutube']);
    assert.equal(llm.calls.length, 0);
    assert.equal(store.getMediaCache('g1')[LINK_KEY].reason, 'error');
  }
});

test('describeVideo: every probe failed and directUrlUnknownDuration on -> the URL goes out pinned with videoSeconds = maxSeconds', async () => {
  const videoFetcher = fakeVideoFetcher({ probe: PROBE_FAILED });
  const { describer, llm } = videoDescriber({ videoFetcher, hot: videoHot({ video: { directUrlUnknownDuration: true } }) });

  const result = await describer.describeVideo('g1', videoLink());

  assert.equal(result.state, 'watched');
  assert.deepEqual(videoFetcher.calls.map((c) => c.fn), ['probeSite', 'probeYoutube']);
  assert.deepEqual(llm.calls[0].messages[1].content, [
    { type: 'video_url', video_url: { url: 'https://www.youtube.com/watch?v=abc', processing: 'agentic' } },
  ]);
  assert.deepEqual(llm.calls[0].options.provider, VIDEO_CFG.provider);
  assert.equal(llm.calls[0].options.videoSeconds, 60);
});

test('describeVideo: directUrlUnknownDuration never sends a non-direct site or an unpinned URL', async () => {
  const on = videoHot({ video: { directUrlUnknownDuration: true } });
  const first = videoDescriber({ videoFetcher: fakeVideoFetcher({ probe: PROBE_FAILED }), hot: on });
  assert.deepEqual(await first.describer.describeVideo('g1', videoLink('video:url:bbbbbbbbbbbbbbbb', TIKTOK)), { state: 'error' });
  assert.equal(first.llm.calls.length, 0);

  const second = videoDescriber({
    videoFetcher: fakeVideoFetcher({ probe: PROBE_FAILED }),
    hot: videoHot({ video: { directUrlUnknownDuration: true, provider: null } }),
  });
  assert.deepEqual(await second.describer.describeVideo('g1', videoLink()), { state: 'error' });
  assert.equal(second.llm.calls.length, 0);
});

test('describeVideo: longer than maxSeconds and the clip fails -> a permanent length limit, never retried', async () => {
  const setups = [
    { probe: { ok: true, durationSec: 600, title: null } },
    { probe: PROBE_FAILED, youtube: { ok: true, durationSec: 600 } },
  ];
  for (const setup of setups) {
    for (const reason of ['download', 'tool', 'timeout', 'size']) {
      let t = 1_000_000;
      const videoFetcher = fakeVideoFetcher({ ...setup, clip: { ok: false, reason } });
      const { describer, llm, store } = videoDescriber({ videoFetcher, now: () => t });

      assert.deepEqual(await describer.describeVideo('g1', videoLink()), { state: 'limit', reason: 'length' });
      assert.equal(store.getMediaCache('g1')[LINK_KEY].reason, 'length');
      const fetches = videoFetcher.calls.length;
      t += 30 * 24 * 60 * 60_000;
      assert.deepEqual(await describer.describeVideo('g1', videoLink()), { state: 'limit', reason: 'length' });
      assert.equal(videoFetcher.calls.length, fetches, 'the permanent miss is served from the cache');
      assert.equal(llm.calls.length, 0);
    }
  }
});

test('describeVideo: a clip failure of a video within maxSeconds (or of unknown length) stays an error miss', async () => {
  for (const durationSec of [30, null]) {
    const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec, title: null }, clip: { ok: false, reason: 'download' } });
    const { describer } = videoDescriber({ videoFetcher });
    assert.deepEqual(await describer.describeVideo('g1', videoLink('video:url:bbbbbbbbbbbbbbbb', TIKTOK)), { state: 'error' });
  }
});

// --- directUrlMaxSeconds and re-evaluated length misses ------------------

test('describeVideo: a direct-URL link of 120 s (within directUrlMaxSeconds) goes out pinned with videoSeconds 120', async () => {
  const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec: 120, title: null } });
  const { describer, llm } = videoDescriber({ videoFetcher });
  assert.equal((await describer.describeVideo('g1', videoLink())).state, 'watched');
  assert.deepEqual(videoFetcher.calls.map((c) => c.fn), ['probeSite']);
  assert.deepEqual(llm.calls[0].messages[1].content, [
    { type: 'video_url', video_url: { url: 'https://www.youtube.com/watch?v=abc', processing: 'agentic' } },
  ]);
  assert.deepEqual(llm.calls[0].options.provider, VIDEO_CFG.provider);
  assert.equal(llm.calls[0].options.videoSeconds, 120);
});

test('describeVideo: a pinned YouTube link with a playlist goes out by its canonical watch URL', async () => {
  const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec: 120, title: null } });
  const { describer, llm } = videoDescriber({ videoFetcher });
  const link = videoLink(undefined, { url: 'https://www.youtube.com/watch?v=abc&list=OLAK5uy_xyz&si=track' });
  assert.equal((await describer.describeVideo('g1', link)).state, 'watched');
  assert.equal(videoFetcher.calls[0].url, link.url, 'the probe still gets the link as posted');
  assert.deepEqual(llm.calls[0].messages[1].content, [
    { type: 'video_url', video_url: { url: 'https://www.youtube.com/watch?v=abc', processing: 'agentic' } },
  ]);
});

test('describeVideo: with an unknown duration a pinned YouTube link also goes out canonical', async () => {
  const videoFetcher = fakeVideoFetcher({ probe: PROBE_FAILED });
  const { describer, llm } = videoDescriber({ videoFetcher, hot: videoHot({ video: { directUrlUnknownDuration: true } }) });
  const link = videoLink(undefined, { url: 'https://youtu.be/abc?list=PL1&t=9' });
  assert.equal((await describer.describeVideo('g1', link)).state, 'watched');
  assert.equal(llm.calls[0].messages[1].content[0].video_url.url, 'https://www.youtube.com/watch?v=abc');
});

test('describeVideo: a 120 s non-direct link whose clip fails stores a length miss with durationSec 120', async () => {
  const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec: 120, title: null }, clip: { ok: false, reason: 'download' } });
  const { describer, store } = videoDescriber({ videoFetcher, now: () => 7_000 });
  const item = videoLink('video:url:bbbbbbbbbbbbbbbb', TIKTOK);
  assert.deepEqual(await describer.describeVideo('g1', item), { state: 'limit', reason: 'length' });
  assert.deepEqual(store.getMediaCache('g1')['video:video:url:bbbbbbbbbbbbbbbb'], {
    miss: true,
    ts: 7_000,
    reason: 'length',
    durationSec: 120,
  });
  // Still over maxSeconds for a non-direct site: served from the cache, no new fetch.
  assert.deepEqual(await describer.describeVideo('g1', item), { state: 'limit', reason: 'length' });
  assert.equal(videoFetcher.calls.length, 2);
});

test('describeVideo: a cached length miss is re-read against the live caps (maxSeconds raised for a non-direct site)', async () => {
  const hot = videoHot();
  const { describer, store, videoFetcher } = videoDescriber({ hot });
  const item = videoLink('video:url:bbbbbbbbbbbbbbbb', TIKTOK);
  store.getMediaCache('g1')['video:video:url:bbbbbbbbbbbbbbbb'] = { miss: true, ts: 1, reason: 'length', durationSec: 120 };
  assert.deepEqual(await describer.describeVideo('g1', item), { state: 'limit', reason: 'length' });
  assert.equal(videoFetcher.calls.length, 0);
  hot.config.media.video.maxSeconds = 120;
  assert.equal((await describer.describeVideo('g1', item)).state, 'watched');
  assert.equal(videoFetcher.calls.length, 2);
});

test('describeVideo: every video request carries media.video.maxRequestTokens as its own pre-flight cap', async () => {
  const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec: 180, title: null } });
  const { describer, llm } = videoDescriber({ videoFetcher });
  assert.equal((await describer.describeVideo('g1', videoLink())).state, 'watched');
  assert.equal(llm.calls[0].options.videoSeconds, 180, '180 s is within directUrlMaxSeconds: sent pinned');
  assert.deepEqual(llm.calls[0].options.provider, VIDEO_CFG.provider);
  assert.equal(llm.calls[0].options.maxRequestTokens, 60_000);

  const clip = videoDescriber();
  await clip.describer.describeVideo('g1', videoAttachment());
  assert.equal(clip.llm.calls[0].options.maxRequestTokens, 60_000, 'a downloaded clip too');
});

test('describeVideo: a 180 s direct-URL video passes the video cap through the real client, while the 50 000 global cap alone would refuse it', async () => {
  const hot = videoHot();
  hot.config.media.video.tokensPerSecond = 300;
  hot.config.llm = {
    baseUrl: 'https://openrouter.test/api/v1',
    temperature: 1,
    maxOutputTokens: 100,
    maxRequestTokens: 50_000,
    maxRequestsPerDay: 300,
    timeoutMs: 5_000,
    retries: 0,
  };
  const bodies = [];
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => hot.config,
    calibrator: { ratio: 1, apply: (n) => n, observe: () => {} },
    state: { data: {}, markDirty() {} },
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'someone dances' } }], usage: {} }) };
    },
  });
  const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec: 180, title: null } });
  const { describer } = videoDescriber({ hot, llm, videoFetcher });

  assert.equal((await describer.describeVideo('g1', videoLink())).state, 'watched');
  assert.equal(bodies.length, 1);

  const messages = [
    { role: 'system', content: VIDEO_PROMPT },
    { role: 'user', content: [{ type: 'video_url', video_url: { url: 'https://www.youtube.com/watch?v=abc' } }] },
  ];
  await assert.rejects(
    llm.complete(messages, { videoSeconds: 180, skipCalibration: true }),
    (err) => err instanceof TokenLimitError,
  );
  assert.equal(bodies.length, 1, 'the refused request never left the process');
});

test('describeVideo: a cached length miss with durationSec null or absent (an older entry) is retried', async () => {
  for (const extra of [{ durationSec: null }, {}]) {
    const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec: 120, title: null } });
    const { describer, store, llm } = videoDescriber({ videoFetcher });
    store.getMediaCache('g1')[LINK_KEY] = { miss: true, ts: 1, reason: 'length', ...extra };
    assert.equal((await describer.describeVideo('g1', videoLink())).state, 'watched', JSON.stringify(extra));
    assert.deepEqual(videoFetcher.calls.map((c) => c.fn), ['probeSite']);
    assert.equal(llm.calls.length, 1);
    assert.equal(store.getMediaCache('g1')[LINK_KEY].watched, true);
  }
});

// --- directUrlTokensPerSecond: the estimate of an agentic public-URL request ---

// The shipped long-video settings on top of the test defaults.
const LONG_URL_VIDEO = { directUrlMaxSeconds: 3600, directUrlTokensPerSecond: 10, tokensPerSecond: 300, urlProcessing: 'agentic' };

/** A real client (fake fetch) over `hot`, recording every request body that left the process. */
function realVideoLlm(hot) {
  hot.config.llm = {
    baseUrl: 'https://openrouter.test/api/v1',
    temperature: 1,
    maxOutputTokens: 100,
    maxRequestTokens: 50_000,
    maxRequestsPerDay: 300,
    timeoutMs: 5_000,
    retries: 0,
  };
  const bodies = [];
  const llm = createLlm({
    apiKey: 'k',
    getConfig: () => hot.config,
    calibrator: { ratio: 1, apply: (n) => n, observe: () => {} },
    state: { data: {}, markDirty() {} },
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'someone talks' } }], usage: {} }) };
    },
  });
  return { llm, bodies };
}

test('describeVideo: a pinned agentic link of 3289 s goes out by URL, estimated at directUrlTokensPerSecond under maxRequestTokens', async () => {
  const hot = videoHot({ video: LONG_URL_VIDEO });
  const { llm, bodies } = realVideoLlm(hot);
  const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec: 3289, title: null } });
  const { describer } = videoDescriber({ hot, llm, videoFetcher });

  const result = await describer.describeVideo('g1', videoLink());

  assert.equal(result.state, 'watched');
  assert.ok(result.estimated >= 32_890 && result.estimated < 60_000, String(result.estimated));
  assert.deepEqual(videoFetcher.calls.map((c) => c.fn), ['probeSite']);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].messages[1].content, [
    { type: 'video_url', video_url: { url: 'https://www.youtube.com/watch?v=abc', processing: 'agentic' } },
  ]);
  assert.deepEqual(bodies[0].provider, VIDEO_CFG.provider);
});

test('describeVideo: a pinnable 3289 s link with another or no processing mode takes the clip route at tokensPerSecond', async () => {
  for (const urlProcessing of ['static', 'frames', null, '']) {
    const hot = videoHot({ video: { ...LONG_URL_VIDEO, urlProcessing } });
    const { llm, bodies } = realVideoLlm(hot);
    const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec: 3289, title: null } });
    const { describer } = videoDescriber({ hot, llm, videoFetcher });

    const result = await describer.describeVideo('g1', videoLink());
    assert.equal(result.state, 'watched', String(urlProcessing));
    assert.ok(result.estimated >= 60 * 300, `${String(urlProcessing)}: ${result.estimated}`);
    assert.deepEqual(videoFetcher.calls.map((c) => c.fn), ['probeSite', 'fetchSiteClip']);
    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies[0].messages[1].content, [{ type: 'video_url', video_url: { url: CLIP_DATA_URL } }]);
    assert.equal(bodies[0].provider, undefined);

    const fake = videoDescriber({
      hot: videoHot({ video: { ...LONG_URL_VIDEO, urlProcessing } }),
      videoFetcher: fakeVideoFetcher({ probe: { ok: true, durationSec: 3289, title: null } }),
    });
    await fake.describer.describeVideo('g1', videoLink());
    assert.equal(fake.llm.calls[0].options.videoTokensPerSecond, undefined, String(urlProcessing));
  }
});

/** Which route a pinnable link of `durationSec` takes under `video`: 'url' (sent pinned) or 'clip'. */
async function linkRoute(video, durationSec, hotPatch = (hot) => hot) {
  const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec, title: null } });
  const { describer, llm } = videoDescriber({ hot: hotPatch(videoHot({ video })), videoFetcher });
  await describer.describeVideo('g1', videoLink());
  const pinned = llm.calls[0].messages[1].content[0].video_url.url === 'https://www.youtube.com/watch?v=abc';
  return pinned ? 'url' : 'clip';
}

test('describeVideo: a non-agentic pinnable link is capped at min(directUrlMaxSeconds, floor(maxRequestTokens / tokensPerSecond))', async () => {
  for (const urlProcessing of ['static', null]) {
    const video = { ...LONG_URL_VIDEO, urlProcessing };
    assert.equal(await linkRoute(video, 200), 'url', `${urlProcessing}: 60000 / 300 = 200 s`);
    assert.equal(await linkRoute(video, 201), 'clip', String(urlProcessing));
    assert.equal(await linkRoute({ ...video, tokensPerSecond: 400 }, 150), 'url');
    assert.equal(await linkRoute({ ...video, tokensPerSecond: 400 }, 151), 'clip');
    assert.equal(await linkRoute({ ...video, directUrlMaxSeconds: 120 }, 120), 'url', 'directUrlMaxSeconds is the smaller one');
    assert.equal(await linkRoute({ ...video, directUrlMaxSeconds: 120 }, 121), 'clip');
  }
});

test('describeVideo: an agentic pinnable link is capped at directUrlMaxSeconds alone', async () => {
  assert.equal(await linkRoute(LONG_URL_VIDEO, 3600), 'url');
  assert.equal(await linkRoute(LONG_URL_VIDEO, 3601), 'clip');
  assert.equal(await linkRoute({ ...LONG_URL_VIDEO, urlProcessing: undefined }, 3600), 'url', 'a missing mode resolves to agentic');
});

test('describeVideo: the non-agentic cap falls back like the client for missing token settings', async () => {
  const video = { ...LONG_URL_VIDEO, urlProcessing: 'static' };
  // tokensPerSecond missing -> the fallback src/llm/openrouter.js exports: 60000 tokens / that rate.
  const fallbackSeconds = Math.floor(VIDEO_CFG.maxRequestTokens / VIDEO_TOKENS_PER_SECOND_FALLBACK);
  assert.equal(await linkRoute({ ...video, tokensPerSecond: undefined }, fallbackSeconds), 'url');
  assert.equal(await linkRoute({ ...video, tokensPerSecond: undefined }, fallbackSeconds + 1), 'clip');
  // media.video.maxRequestTokens missing -> the global llm.maxRequestTokens the client then applies.
  const withGlobal = (hot) => {
    hot.config.llm = { maxRequestTokens: 30_000 };
    return hot;
  };
  assert.equal(await linkRoute({ ...video, maxRequestTokens: undefined }, 100, withGlobal), 'url');
  assert.equal(await linkRoute({ ...video, maxRequestTokens: undefined }, 101, withGlobal), 'clip');
  // No token cap known at all -> directUrlMaxSeconds alone; no directUrlMaxSeconds -> maxSeconds.
  assert.equal(await linkRoute({ ...video, maxRequestTokens: undefined }, 3600), 'url');
  assert.equal(await linkRoute({ ...video, maxRequestTokens: undefined, directUrlMaxSeconds: undefined }, 60), 'url');
  assert.equal(await linkRoute({ ...video, maxRequestTokens: undefined, directUrlMaxSeconds: undefined }, 61), 'clip');
});

test('describeVideo: a cached length miss is re-read against the mode-dependent cap', async () => {
  const hot = videoHot({ video: { ...LONG_URL_VIDEO, urlProcessing: 'static' } });
  const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec: 570, title: null } });
  const { describer, store, llm } = videoDescriber({ hot, videoFetcher });
  store.getMediaCache('g1')[LINK_KEY] = { miss: true, ts: 1, reason: 'length', durationSec: 570 };

  assert.deepEqual(await describer.describeVideo('g1', videoLink()), { state: 'limit', reason: 'length' });
  assert.equal(videoFetcher.calls.length, 0, 'over the 200 s static cap: served from the cache');

  hot.config.media.video.urlProcessing = 'agentic';
  assert.equal((await describer.describeVideo('g1', videoLink())).state, 'watched');
  assert.deepEqual(videoFetcher.calls.map((c) => c.fn), ['probeSite']);
  assert.equal(llm.calls[0].messages[1].content[0].video_url.url, 'https://www.youtube.com/watch?v=abc');
});

test('describeVideo: a data-URL clip is still estimated at tokensPerSecond', async () => {
  const hot = videoHot({ video: LONG_URL_VIDEO });
  const { llm, bodies } = realVideoLlm(hot);
  const { describer } = videoDescriber({ hot, llm });
  const watched = await describer.describeVideo('g1', videoAttachment());
  assert.equal(watched.state, 'watched');
  assert.ok(watched.estimated >= 12 * 300, String(watched.estimated));
  assert.equal(bodies.length, 1);

  const attachment = videoDescriber({ hot: videoHot({ video: LONG_URL_VIDEO }) });
  await attachment.describer.describeVideo('g1', videoAttachment());
  assert.equal(attachment.llm.calls[0].options.videoTokensPerSecond, undefined);

  const siteClip = videoDescriber({ hot: videoHot({ video: LONG_URL_VIDEO }) });
  await siteClip.describer.describeVideo('g1', videoLink('video:url:bbbbbbbbbbbbbbbb', TIKTOK));
  assert.equal(siteClip.llm.calls[0].messages[1].content[0].video_url.url, CLIP_DATA_URL);
  assert.equal(siteClip.llm.calls[0].options.videoTokensPerSecond, undefined);
});

test('describeVideo: a missing or invalid directUrlTokensPerSecond falls back to tokensPerSecond', async () => {
  for (const directUrlTokensPerSecond of [undefined, null, 0, -5, NaN, Infinity, '10', {}]) {
    const label = String(directUrlTokensPerSecond);
    const fake = videoDescriber({
      hot: videoHot({ video: { ...LONG_URL_VIDEO, directUrlTokensPerSecond } }),
      videoFetcher: fakeVideoFetcher({ probe: { ok: true, durationSec: 120, title: null } }),
    });
    await fake.describer.describeVideo('g1', videoLink());
    assert.equal(fake.llm.calls[0].options.videoTokensPerSecond, undefined, label);

    const hot = videoHot({ video: { ...LONG_URL_VIDEO, directUrlTokensPerSecond } });
    const { llm, bodies } = realVideoLlm(hot);
    const { describer } = videoDescriber({
      hot,
      llm,
      videoFetcher: fakeVideoFetcher({ probe: { ok: true, durationSec: 120, title: null } }),
    });
    const result = await describer.describeVideo('g1', videoLink());
    assert.ok(result.estimated >= 120 * 300, `${label}: ${result.estimated}`);
    assert.equal(bodies.length, 1, label);
  }
});

test('describeVideo: cached length misses of 2719 s and 570 s pinned links are retried under the 3600 s cap, not served', async () => {
  for (const durationSec of [2719, 570]) {
    const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec, title: null } });
    const { describer, store, llm } = videoDescriber({ hot: videoHot({ video: LONG_URL_VIDEO }), videoFetcher });
    store.getMediaCache('g1')[LINK_KEY] = { miss: true, ts: 1, reason: 'length', durationSec };

    const result = await describer.describeVideo('g1', videoLink());

    assert.equal(result.state, 'watched', String(durationSec));
    assert.deepEqual(videoFetcher.calls.map((c) => c.fn), ['probeSite']);
    assert.equal(llm.calls[0].messages[1].content[0].video_url.url, 'https://www.youtube.com/watch?v=abc');
    assert.equal(llm.calls[0].options.videoSeconds, durationSec);
    assert.equal(llm.calls[0].options.videoTokensPerSecond, 10);
    assert.equal(store.getMediaCache('g1')[LINK_KEY].watched, true);
  }
});

test('describeVideo: config.json ships a direct-URL cap that, at the shipped agentic rate, stays within maxRequestTokens', async () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const prompt = fs.readFileSync(new URL('../prompts/describe-video.md', import.meta.url), 'utf8');
  const video = shipped.media.video;
  // Only the values under test come from config.json. What makes a link go out by its URL at the direct-URL
  // rate is pinned, whatever config.json ships for it: agentic processing (the only mode that rate applies
  // in) here, the pinned provider, the direct-URL sites and the daily rail by the test defaults (VIDEO_CFG).
  const hot = videoHot({
    video: {
      urlProcessing: 'agentic',
      directUrlMaxSeconds: video.directUrlMaxSeconds,
      directUrlTokensPerSecond: video.directUrlTokensPerSecond,
      tokensPerSecond: video.tokensPerSecond,
      maxRequestTokens: video.maxRequestTokens,
    },
    prompts: { 'describe-video': prompt },
  });
  const { llm: client, bodies } = realVideoLlm(hot);
  const options = [];
  const llm = {
    ...client,
    complete: (messages, opts) => {
      options.push(opts);
      return client.complete(messages, opts);
    },
  };
  const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec: video.directUrlMaxSeconds, title: null } });
  const { describer } = videoDescriber({ hot, llm, videoFetcher });

  const watched = await describer.describeVideo('g1', videoLink());

  assert.equal(watched.state, 'watched');
  assert.deepEqual(videoFetcher.calls.map((c) => c.fn), ['probeSite'], 'the longest direct-URL video is not clipped');
  assert.equal(bodies.length, 1, 'the token rail let the request through');
  assert.equal(bodies[0].messages[1].content[0].video_url.url, videoLink().url, 'sent by its public URL');
  assert.equal(options[0].videoSeconds, video.directUrlMaxSeconds);
  assert.equal(options[0].videoTokensPerSecond, video.directUrlTokensPerSecond, 'src applies the shipped rate, not a fallback');
  assert.ok(watched.estimated >= video.directUrlMaxSeconds * video.directUrlTokensPerSecond, String(watched.estimated));
  assert.ok(watched.estimated < video.maxRequestTokens, String(watched.estimated));
});

test('describeVideo: config.json ships clips whose base64 fits the inline request limit, estimated at the code-fallback rate', () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const video = shipped.media.video;
  // Base64 of the largest clip stays under the provider's ~20 MB inline request limit.
  assert.ok(Math.ceil(video.maxBytes / 3) * 4 < 20_000_000);
  // Data-URL clips keep the static estimate; a missing tokensPerSecond must mean the same rate.
  assert.equal(video.tokensPerSecond, VIDEO_TOKENS_PER_SECOND_FALLBACK);
});

test('describeVideo: a shipped-length clip at the shipped rate plus the shipped prompt stays under media.video.maxRequestTokens', async () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const prompt = fs.readFileSync(new URL('../prompts/describe-video.md', import.meta.url), 'utf8');
  const video = shipped.media.video;
  const hot = videoHot({ video, prompts: { 'describe-video': prompt } });
  const { llm, bodies } = realVideoLlm(hot);
  const videoFetcher = fakeVideoFetcher({
    attachment: { ok: true, dataUrl: CLIP_DATA_URL, mimeType: 'video/mp4', seconds: video.maxSeconds, bytes: 4 },
  });
  const { describer } = videoDescriber({ hot, llm, videoFetcher });

  const watched = await describer.describeVideo('g1', videoAttachment('v1', { durationSec: video.maxSeconds }));

  assert.equal(watched.state, 'watched');
  assert.equal(bodies.length, 1, 'the token rail let the request through');
  assert.ok(watched.estimated >= video.maxSeconds * video.tokensPerSecond, String(watched.estimated));
  assert.ok(watched.estimated < video.maxRequestTokens, String(watched.estimated));
});

test('rewatchVideo: a pinned agentic link passes directUrlTokensPerSecond like a watch; a clip does not', async () => {
  const pinned = videoDescriber({
    hot: rewatchHot({ video: LONG_URL_VIDEO }),
    videoFetcher: fakeVideoFetcher({ probe: { ok: true, durationSec: 3289, title: null } }),
    llm: fakeLlm({ text: 'rouge' }),
  });
  assert.equal((await pinned.describer.rewatchVideo('g1', videoLink(), 'τι λέει;')).text, 'rouge');
  assert.equal(pinned.llm.calls[0].options.videoSeconds, 3289);
  assert.equal(pinned.llm.calls[0].options.videoTokensPerSecond, 10);

  const clip = videoDescriber({ hot: rewatchHot({ video: LONG_URL_VIDEO }), llm: fakeLlm({ text: 'rouge' }) });
  await clip.describer.rewatchVideo('g1', videoAttachment(), 'τι λέει;');
  assert.equal(clip.llm.calls[0].options.videoTokensPerSecond, undefined);

  const hot = rewatchHot({ video: LONG_URL_VIDEO });
  const { llm, bodies } = realVideoLlm(hot);
  const real = videoDescriber({ hot, llm, videoFetcher: fakeVideoFetcher({ probe: { ok: true, durationSec: 3289, title: null } }) });
  assert.equal((await real.describer.rewatchVideo('g1', videoLink(), 'τι λέει;')).text, 'someone talks');
  assert.equal(bodies.length, 1);
});

// --- account length: media.video.summaryChars ------------------------------

test('describeVideo: the account is capped at media.video.summaryChars and {{maxChars}} is filled with it', async () => {
  const hot = videoHot({ video: { summaryChars: 40 }, prompts: { 'describe-video': 'Summarise in at most {{maxChars}} characters.' } });
  const { describer, llm } = videoDescriber({ hot, llm: fakeLlm({ text: `Première scène ${'mot '.repeat(50)}` }) });
  const { text } = await describer.describeVideo('g1', videoAttachment());

  assert.ok([...text].length <= 40, text);
  assert.ok(text.startsWith('Première scène mot'));
  assert.equal(llm.calls[0].messages[0].content, 'Summarise in at most 40 characters.');
});

// --- rewatchVideo: the second look on a question ---------------------------------

const REWATCH_PROMPT = 'Question: {{question}}. At most {{maxChars}} characters.';
const REWATCH_CFG = { model: null, maxPerDay: 20, maxOutputTokens: 600, answerChars: 1200, recentMessages: 15 };

function rewatchHot({ features = {}, video = {}, rewatch = {}, prompts = {} } = {}) {
  return videoHot({
    features,
    video: { rewatch: { ...REWATCH_CFG, ...rewatch }, ...video },
    prompts: { 'rewatch-answer': REWATCH_PROMPT, ...prompts },
  });
}

function clock(start = Date.parse('2026-09-23T12:00:00Z')) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

test('rewatchVideo: one fetch and one video request with the question and answerChars filled', async () => {
  const now = clock();
  const state = fakeState();
  const { describer, llm, videoFetcher, store } = videoDescriber({
    hot: rewatchHot(),
    llm: fakeLlm({ text: '  la voiture   est rouge ' }),
    state,
    now,
  });

  const result = await describer.rewatchVideo('g1', videoAttachment(), 'De quelle couleur est la voiture ?');

  assert.deepEqual(result, { question: 'De quelle couleur est la voiture ?', text: 'la voiture est rouge' });
  assert.equal(videoFetcher.calls.length, 1);
  assert.equal(videoFetcher.calls[0].fn, 'fetchAttachment');
  assert.equal(llm.calls.length, 1);
  const [system, user] = llm.calls[0].messages;
  assert.equal(system.content, 'Question: De quelle couleur est la voiture ?. At most 1200 characters.');
  assert.deepEqual(user.content, [
    { type: 'text', text: 'De quelle couleur est la voiture ?' },
    { type: 'video_url', video_url: { url: CLIP_DATA_URL } },
  ]);
  const options = llm.calls[0].options;
  assert.equal(options.model, 'x/video-model', 'the second look uses the video model (models.base.video)');
  assert.equal(options.maxOutputTokens, 600);
  assert.equal(options.maxRequestTokens, 60_000);
  assert.equal(options.videoSeconds, 12);
  assert.equal(options.skipCalibration, true);
  assert.equal(options.countAgainstDailyCap, true);
  assert.equal(state.data.rewatchCount, 1);
  assert.equal(state.data.videoCount, 1);
  const keys = Object.keys(store.getMediaCache('g1')).filter((k) => k.startsWith('video:v1:q:'));
  assert.equal(keys.length, 1);
  assert.equal(store.getMediaCache('g1')[keys[0]].answer, 'la voiture est rouge');
});

test('rewatchVideo: the persisted answer key keeps its shape (lower-cased, collapsed, sha1 prefix)', async () => {
  const { describer, store } = videoDescriber({ hot: rewatchHot(), llm: fakeLlm({ text: 'rouge' }) });
  await describer.rewatchVideo('g1', videoAttachment(), '  De quelle   COULEUR ? ');
  const digest = createHash('sha1').update('de quelle couleur ?').digest('hex').slice(0, 16);
  assert.equal(store.getMediaCache('g1')[`video:v1:q:${digest}`].answer, 'rouge');
});

test('rewatchVideo: the same question within an hour is free; after an hour it is asked again', async () => {
  const now = clock();
  const { describer, llm, videoFetcher, state } = videoDescriber({ hot: rewatchHot(), llm: fakeLlm({ text: 'rouge' }), now });

  await describer.rewatchVideo('g1', videoAttachment(), 'Quelle couleur ?');
  now.advance(59 * 60_000);
  const again = await describer.rewatchVideo('g1', videoAttachment(), '  quelle   COULEUR ? ');
  assert.equal(again.text, 'rouge');
  assert.equal(videoFetcher.calls.length, 1, 'a cached answer costs no fetch');
  assert.equal(llm.calls.length, 1);
  assert.equal(state.data.rewatchCount, 1);

  now.advance(2 * 60_000);
  await describer.rewatchVideo('g1', videoAttachment(), 'Quelle couleur ?');
  assert.equal(videoFetcher.calls.length, 2, 'past an hour the answer is stale');
  assert.equal(llm.calls.length, 2);
});

test('rewatchVideo: a failure is not cached -- the next call fetches again', async () => {
  const llm = fakeLlm([new Error('boom'), { text: 'rouge' }]);
  const { describer, videoFetcher, store } = videoDescriber({ hot: rewatchHot(), llm });

  assert.equal(await describer.rewatchVideo('g1', videoAttachment(), 'Quelle couleur ?'), null);
  assert.equal(Object.keys(store.getMediaCache('g1')).filter((k) => k.includes(':q:')).length, 0);
  assert.deepEqual(await describer.rewatchVideo('g1', videoAttachment(), 'Quelle couleur ?'), { question: 'Quelle couleur ?', text: 'rouge' });
  assert.equal(videoFetcher.calls.length, 2);
});

test('rewatchVideo: a full re-watch counter or a full video counter refuses without a fetch', async () => {
  const now = () => Date.parse('2026-09-23T12:00:00Z');
  const cases = [
    fakeState({ rewatchDay: '2026-09-23', rewatchCount: 20, videoDay: '2026-09-23', videoCount: 0 }),
    fakeState({ rewatchDay: '2026-09-23', rewatchCount: 0, videoDay: '2026-09-23', videoCount: 40 }),
  ];
  for (const state of cases) {
    const before = { ...state.data };
    const { describer, llm, videoFetcher } = videoDescriber({ hot: rewatchHot(), state, now });
    assert.equal(await describer.rewatchVideo('g1', videoAttachment(), 'q?'), null);
    assert.equal(videoFetcher.calls.length, 0);
    assert.equal(llm.calls.length, 0);
    assert.equal(state.data.rewatchCount, before.rewatchCount);
    assert.equal(state.data.videoCount, before.videoCount);
  }
});

test('rewatchVideo: the re-watch counter resets on a new day; a failed fetch keeps both slots', async () => {
  const now = () => Date.parse('2026-09-24T00:10:00Z');
  const state = fakeState({ rewatchDay: '2026-09-23', rewatchCount: 20 });
  const { describer } = videoDescriber({
    hot: rewatchHot(),
    state,
    now,
    videoFetcher: fakeVideoFetcher({ attachment: { ok: false, reason: 'download' } }),
  });
  assert.equal(await describer.rewatchVideo('g1', videoAttachment(), 'q?'), null);
  assert.equal(state.data.rewatchDay, '2026-09-24');
  assert.equal(state.data.rewatchCount, 1);
  assert.equal(state.data.videoCount, 1);
});

test('rewatchVideo: feature off, video vision off, missing prompt, a non-video item or an empty question -> null, no fetch', async () => {
  const cases = [
    { hot: rewatchHot({ features: { videoRewatch: false } }), item: videoAttachment(), question: 'q?' },
    { hot: rewatchHot({ features: { videoDescriptions: false } }), item: videoAttachment(), question: 'q?' },
    { hot: rewatchHot({ prompts: { 'rewatch-answer': undefined } }), item: videoAttachment(), question: 'q?' },
    { hot: rewatchHot(), item: pictureItem('a1'), question: 'q?' },
    { hot: rewatchHot(), item: videoAttachment(), question: '   ' },
  ];
  for (const { hot, item, question } of cases) {
    const { describer, llm, videoFetcher } = videoDescriber({ hot });
    assert.equal(await describer.rewatchVideo('g1', item, question), null);
    assert.equal(videoFetcher.calls.length, 0);
    assert.equal(llm.calls.length, 0);
  }
});

test('rewatchVideo: logs one describe: rewatch line -- never the question, the answer or a full URL', async () => {
  const { describer } = videoDescriber({ hot: rewatchHot(), llm: fakeLlm({ text: 'a secret answer' }) });
  const { logs } = await withCapturedLogs(() => describer.rewatchVideo('g1', videoAttachment(), 'a secret question'));
  const line = logs.find((entry) => JSON.stringify(entry).includes('describe: rewatch'));
  assert.ok(line);
  const all = JSON.stringify(logs);
  assert.ok(!all.includes('a secret answer'));
  assert.ok(!all.includes('a secret question'));
  assert.ok(!all.includes('ex=secret'));
});

// --- relookImage: the second look at a picture on a question ----------------------

/** rewatchHot with the picture switches on and the image settings the download reads. */
function relookHot({ features = {}, rewatch = {}, prompts = {} } = {}) {
  const hot = rewatchHot({ features: { vision: true, imageRelook: true, ...features }, rewatch, prompts });
  hot.config.media.imageSize = 512;
  return hot;
}

function relookDescriber({ hot = relookHot(), llm = fakeLlm({ text: '  pas de chargeur,   juste un reflet ' }), imageFetcher = fakeImageFetcher(), state = fakeState(), now } = {}) {
  const store = createStore({ dataDir: tmpDataDir() });
  const describer = createDescriber({ hot, store, llm, imageFetcher, videoFetcher: fakeVideoFetcher(), state, ...(now ? { now } : {}) });
  return { describer, store, llm, imageFetcher, state };
}

test('relookImage: one download and one vision request with the question; the answer is not the picture caption', async () => {
  const { describer, store, llm, imageFetcher, state } = relookDescriber({ now: clock() });
  const result = await describer.relookImage('g1', pictureItem('a1'), 'Y a-t-il un chargeur dans la pupille ?');

  assert.deepEqual(result, { question: 'Y a-t-il un chargeur dans la pupille ?', text: 'pas de chargeur, juste un reflet' });
  assert.equal(imageFetcher.calls.length, 1);
  assert.ok(imageFetcher.calls[0].url.startsWith('https://media.discordapp.net/x/pic.png'), 'through the media proxy, sized');
  assert.equal(llm.calls.length, 1);
  const [system, user] = llm.calls[0].messages;
  assert.equal(system.content, 'Question: Y a-t-il un chargeur dans la pupille ?. At most 1200 characters.');
  assert.deepEqual(user.content, [
    { type: 'text', text: 'Y a-t-il un chargeur dans la pupille ?' },
    { type: 'image_url', image_url: { url: SUCCESSFUL_DOWNLOAD.dataUrl } },
  ]);
  const options = llm.calls[0].options;
  assert.equal(options.model, 'x/haiku', 'the picture is looked at by the vision model (models.base.vision)');
  assert.equal(options.role, 'vision');
  assert.equal(options.purpose, 'relook');
  assert.equal(options.maxOutputTokens, 600, 'media.video.rewatch.maxOutputTokens');
  assert.equal(options.countAgainstDailyCap, true);
  assert.equal(state.data.rewatchCount, 1, 'the one second-look counter');
  assert.equal(state.data.videoCount, undefined, 'a picture never takes a video slot');
  const cache = store.getMediaCache('g1');
  assert.equal(cache.a1, undefined, 'never stored as the picture caption');
  const keys = Object.keys(cache).filter((k) => k.startsWith('image:a1:q:'));
  assert.equal(keys.length, 1);
  assert.equal(cache[keys[0]].answer, 'pas de chargeur, juste un reflet');
});

test('relookImage: with no {{question}} in the prompt the question goes only as the user text part, next to the image', async () => {
  const hot = relookHot({ prompts: { 'rewatch-answer': 'Answer in at most {{maxChars}} characters.' } });
  const { describer, llm, imageFetcher } = relookDescriber({ hot, now: clock() });
  await describer.relookImage('g1', pictureItem('a1', { width: 1306, height: 988 }), 'Quelle couleur ?');

  const [system, user] = llm.calls[0].messages;
  assert.equal(system.content, 'Answer in at most 1200 characters.');
  assert.ok(!system.content.includes('{{question}}'));
  assert.ok(!system.content.includes('Quelle couleur'));
  assert.deepEqual(user.content, [
    { type: 'text', text: 'Quelle couleur ?' },
    { type: 'image_url', image_url: { url: SUCCESSFUL_DOWNLOAD.dataUrl } },
  ]);
  assert.equal(imageFetcher.calls[0].url, 'https://media.discordapp.net/x/pic.png?width=512&height=387&format=webp');
});

test('relookImage: the same question within an hour is free; another question asks again', async () => {
  const now = clock();
  const { describer, llm, imageFetcher, state } = relookDescriber({ now });
  await describer.relookImage('g1', pictureItem('a1'), 'Quelle couleur ?');
  assert.deepEqual(await describer.relookImage('g1', pictureItem('a1'), '  quelle   COULEUR ? '), {
    question: 'Quelle couleur ?',
    text: 'pas de chargeur, juste un reflet',
  });
  assert.equal(llm.calls.length, 1);
  assert.equal(state.data.rewatchCount, 1);
  await describer.relookImage('g1', pictureItem('a1'), 'Combien de singes ?');
  assert.equal(llm.calls.length, 2);
  assert.equal(imageFetcher.calls.length, 2);
  now.advance(61 * 60_000);
  await describer.relookImage('g1', pictureItem('a1'), 'Quelle couleur ?');
  assert.equal(llm.calls.length, 3, 'an answer older than an hour is asked again');
});

test('relookImage: one daily counter with rewatchVideo -- a full counter refuses both without a download', async () => {
  const now = clock();
  const state = fakeState({ rewatchDay: '2026-09-23', rewatchCount: 19 });
  const { describer, llm, imageFetcher } = relookDescriber({ state, now });
  assert.ok(await describer.relookImage('g1', pictureItem('a1'), 'q?'));
  assert.equal(state.data.rewatchCount, 20);
  assert.equal(await describer.relookImage('g1', pictureItem('a2'), 'q?'), null);
  assert.equal(await describer.rewatchVideo('g1', videoAttachment(), 'q?'), null);
  assert.equal(imageFetcher.calls.length, 1);
  assert.equal(llm.calls.length, 1);
  assert.equal(describer.videoCapsLeft().rewatch, 0);
});

test('relookImage: a spent llm.maxRequestsPerDay takes no slot; a failed download or request caches nothing', async () => {
  const capped = relookDescriber({ llm: { ...fakeLlm({ text: 'x' }), capLeft: () => 0 } });
  assert.equal(await capped.describer.relookImage('g1', pictureItem('a1'), 'q?'), null);
  assert.equal(capped.imageFetcher.calls.length, 0);
  assert.equal(capped.state.data.rewatchCount, undefined, 'no slot taken');

  const noDownload = relookDescriber({ imageFetcher: fakeImageFetcher(null) });
  assert.equal(await noDownload.describer.relookImage('g1', pictureItem('a1'), 'q?'), null);
  assert.equal(noDownload.llm.calls.length, 0);
  assert.equal(noDownload.state.data.rewatchCount, 1, 'the slot is reserved before the download and kept');

  const failed = relookDescriber({ llm: fakeLlm(new Error('boom')) });
  assert.equal(await failed.describer.relookImage('g1', pictureItem('a1'), 'q?'), null);
  assert.deepEqual(Object.keys(failed.store.getMediaCache('g1')), []);
});

test('relookImage: imageRelook off, vision off, no rewatch-answer prompt, a non-picture or an empty question -> null, no download', async () => {
  const cases = [
    { hot: relookHot({ features: { imageRelook: false } }), item: pictureItem('a1'), question: 'q?' },
    { hot: relookHot({ features: { vision: false } }), item: pictureItem('a1'), question: 'q?' },
    { hot: relookHot({ prompts: { 'rewatch-answer': undefined } }), item: pictureItem('a1'), question: 'q?' },
    { hot: relookHot(), item: pictureItem('a1', { kind: 'gif' }), question: 'q?' },
    { hot: relookHot(), item: videoAttachment(), question: 'q?' },
    { hot: relookHot(), item: pictureItem('a1'), question: '   ' },
  ];
  for (const [i, { hot, item, question }] of cases.entries()) {
    const { describer, llm, imageFetcher } = relookDescriber({ hot });
    assert.equal(await describer.relookImage('g1', item, question), null, `case ${i}`);
    assert.equal(imageFetcher.calls.length, 0, `case ${i}`);
    assert.equal(llm.calls.length, 0, `case ${i}`);
  }
});

test('relookImage: logs one describe: relook line -- never the question or the answer', async () => {
  const { describer } = relookDescriber({ llm: fakeLlm({ text: 'a secret answer' }) });
  const { logs } = await withCapturedLogs(() => describer.relookImage('g1', pictureItem('a1'), 'a secret question'));
  assert.equal(logs.filter((entry) => JSON.stringify(entry).includes('describe: relook')).length, 1);
  const all = JSON.stringify(logs);
  assert.ok(!all.includes('a secret answer'));
  assert.ok(!all.includes('a secret question'));
});

// --- {{today}}: the current date in every describer prompt --------------------

const TODAY_NOW = Date.parse('2026-09-30T23:30:00Z');

test('describe: {{today}} in the describe prompt is filled with the date of the injected now', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const hot = fakeHot({
    config: { media: { maxOutputTokens: 120, imageSize: 512, cacheEntries: 5000, descriptionChars: 200 } },
    prompts: { describe: 'Today is {{today}}; at most {{maxChars}} characters.' },
  });
  const llm = fakeLlm({ text: 'Une affiche datée.' });
  const describer = createDescriber({ hot, store, llm, imageFetcher: fakeImageFetcher(), now: () => TODAY_NOW });
  await describer.describe('g1', pictureItem('a1'));
  assert.equal(llm.calls[0].messages[0].content, 'Today is 2026-09-30; at most 200 characters.');
});

// cachedDescriptions / cachedVideos: the cache-only accessors the address
// classifier (src/behavior/pipeline.js) reads -- never a download, never a request.

test('cachedDescriptions: returns only cached captions, skips misses and unknown items, makes no request', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const llm = fakeLlm({ text: 'never asked' });
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot: fakeHot(), store, llm, imageFetcher });
  const cache = store.getMediaCache('g1');
  cache['sticker:s1'] = { text: 'a cat waving', ts: 1 };
  cache.a2 = { miss: true, ts: Date.now() };

  const descriptions = describer.cachedDescriptions('g1', [
    pictureItem('sticker:s1', { kind: 'sticker' }),
    pictureItem('a2'),
    pictureItem('a3'),
  ]);

  assert.deepEqual([...descriptions], [['sticker:s1', 'a cat waving']]);
  assert.equal(llm.calls.length, 0);
  assert.equal(imageFetcher.calls.length, 0);
  assert.equal(Object.keys(cache).at(-1), 'sticker:s1', 'a hit is LRU-touched like describe() does');
});

test('cachedVideos: returns cached video states only, never fetches or spends a daily slot', async () => {
  const { describer, store, llm, videoFetcher, state } = videoDescriber();
  store.getMediaCache('g1')['video:v1'] = { text: 'someone dances', ts: 1, watched: true };

  const videos = await describer.cachedVideos('g1', [videoAttachment('v1'), videoAttachment('v2')]);

  assert.deepEqual([...videos.keys()], ['v1']);
  assert.equal(videos.get('v1').state, 'watched');
  assert.equal(videos.get('v1').text, 'someone dances');
  assert.equal(llm.calls.length, 0);
  assert.equal(videoFetcher.calls.length, 0);
  assert.equal(state.data.videoCount, undefined, 'no daily video slot is reserved');
});

// Provider routing: every request says which role makes it (llm.providerByModel
// keys of the form "<prefix>@<role>").

// --- GIFs: watched like a short video --------------------------------------

const GIF_CLIP_URL = 'data:video/mp4;base64,Z2lm';
const GIF_VIDEO_PROMPT = 'Account of this clip, up to {{maxChars}} characters.';

/** videoHot plus the GIF settings and a describe-video prompt that shows its cap. */
function gifHot({ features = {}, gif = {}, video = {}, media = {}, prompts = {} } = {}) {
  const hot = videoHot({ features, video, prompts: { 'describe-video': GIF_VIDEO_PROMPT, ...prompts } });
  hot.config.media = { ...hot.config.media, imageSize: 512, descriptionChars: 200, gif: { watch: true, maxSeconds: 8, ...gif }, ...media };
  return hot;
}

/** fakeVideoFetcher plus fetchGif; `gif` is its result, or a function `(url, options) => result`. */
function gifFetcher(gif = (url, options) => ({ ok: true, dataUrl: GIF_CLIP_URL, mimeType: 'video/mp4', seconds: options.maxSeconds, bytes: 9 })) {
  const fetcher = fakeVideoFetcher();
  fetcher.fetchGif = async (url, options) => {
    fetcher.calls.push({ fn: 'fetchGif', url, options });
    return typeof gif === 'function' ? gif(url, options) : gif;
  };
  return fetcher;
}

function gifDescriber({ hot = gifHot(), llm = fakeLlm({ text: 'a man pulls a child back as a train rushes past' }), videoFetcher = gifFetcher(), imageFetcher = fakeImageFetcher(), state = fakeState(), now } = {}) {
  const store = createStore({ dataDir: tmpDataDir() });
  const describer = createDescriber({ hot, store, llm, imageFetcher, videoFetcher, state, ...(now ? { now } : {}) });
  return { describer, store, llm, videoFetcher, imageFetcher, state, hot };
}

const TENOR_MP4 = 'https://images-ext-1.discordapp.net/external/v/https/media.tenor.com/x/AAAPo/loop.mp4';

/** A tenor gifv embed's picture item (src/media/classify.js#collectPictures). */
function gifEmbedItem(itemId = 'm1#e0', overrides = {}) {
  return {
    source: 'embed',
    messageId: 'm1',
    itemId,
    kind: 'gif',
    url: 'https://images-ext-1.discordapp.net/external/t/https/media.tenor.com/x/AAAAe/still.png',
    animationUrl: TENOR_MP4,
    name: 'Tenor',
    ...overrides,
  };
}

/** An attached .gif's picture item. */
function gifAttachmentItem(itemId = 'a9', overrides = {}) {
  return {
    source: 'attachment',
    messageId: 'm1',
    itemId,
    kind: 'gif',
    url: 'https://cdn.discordapp.com/attachments/1/2/anim.gif?ex=secret',
    name: 'anim.gif',
    ...overrides,
  };
}

test('describe: a gifv embed is watched from its mp4 by the video model, cached watched under its own id', async () => {
  const { describer, store, llm, videoFetcher, imageFetcher, state } = gifDescriber();

  const result = await describer.describe('g1', gifEmbedItem());

  assert.equal(result.text, 'a man pulls a child back as a train rushes past');
  assert.equal(result.cached, undefined);
  assert.equal(imageFetcher.calls.length, 0, 'no still frame is fetched');
  assert.deepEqual(videoFetcher.calls.map((c) => [c.fn, c.url]), [['fetchGif', TENOR_MP4]]);
  assert.deepEqual(videoFetcher.calls[0].options, {
    maxSeconds: 8,
    maxBytes: 8_000_000,
    toolTimeoutMs: 60_000,
    ffmpegPath: 'ffmpeg-test',
    fetchTimeoutMs: 10_000,
  });
  assert.equal(llm.calls.length, 1);
  const [system, user] = llm.calls[0].messages;
  assert.deepEqual(system, { role: 'system', content: 'Account of this clip, up to 200 characters.' });
  assert.deepEqual(user.content, [{ type: 'video_url', video_url: { url: GIF_CLIP_URL } }]);
  const options = llm.calls[0].options;
  assert.equal(options.role, 'video');
  assert.equal(options.model, 'x/video-model');
  assert.equal(options.maxOutputTokens, 400);
  assert.equal(options.maxRequestTokens, 60_000, 'the video token cap applies');
  assert.equal(options.videoSeconds, 8);
  assert.equal(options.provider, undefined);
  assert.equal(options.skipCalibration, true);
  assert.equal(state.data.gifWatchCount, 1, 'a GIF watch takes a daily GIF slot');
  assert.equal(state.data.gifWatchDay, new Date().toISOString().slice(0, 10));
  assert.equal(state.data.videoCount, undefined, 'never a daily video slot');

  const entry = store.getMediaCache('g1')['m1#e0'];
  assert.equal(entry.text, 'a man pulls a child back as a train rushes past');
  assert.equal(entry.watched, true);
  assert.equal(entry.gif, true);
  assert.equal(store.getMediaCache('g1')['video:m1#e0'], undefined, 'the key a GIF caption has always used, nothing else');

  const again = await describer.describe('g1', gifEmbedItem());
  assert.equal(again.cached, true);
  assert.equal(llm.calls.length, 1);
});

test('describe: an attached .gif is downloaded and converted by the fetcher, then watched', async () => {
  const { describer, videoFetcher, llm, store } = gifDescriber();

  const result = await describer.describe('g1', gifAttachmentItem());

  assert.equal(result.text, 'a man pulls a child back as a train rushes past');
  assert.equal(videoFetcher.calls[0].fn, 'fetchGif');
  assert.equal(videoFetcher.calls[0].url, 'https://cdn.discordapp.com/attachments/1/2/anim.gif?ex=secret', 'the file itself, never the proxy still');
  assert.equal(llm.calls[0].options.role, 'video');
  assert.equal(store.getMediaCache('g1').a9.watched, true);
});

test('describe: media.gif.maxSeconds caps the watched length', async () => {
  const capped = gifDescriber({ hot: gifHot({ gif: { maxSeconds: 5 } }) });
  await capped.describer.describe('g1', gifEmbedItem());
  assert.equal(capped.videoFetcher.calls[0].options.maxSeconds, 5);
  assert.equal(capped.llm.calls[0].options.videoSeconds, 5);

  // A fetcher reporting more than asked never raises the billed length.
  const liar = gifDescriber({ videoFetcher: gifFetcher({ ok: true, dataUrl: GIF_CLIP_URL, mimeType: 'video/mp4', seconds: 600, bytes: 9 }) });
  await liar.describer.describe('g1', gifEmbedItem());
  assert.equal(liar.llm.calls[0].options.videoSeconds, 8);
});

test('describe: the watched caption keeps media.descriptionChars, collapsed to one line', async () => {
  const words = Array.from({ length: 80 }, (_, i) => `mot${i % 10}é`).join(' ');
  const { describer } = gifDescriber({ llm: fakeLlm({ text: `Première ligne.\n${words}` }) });
  const result = await describer.describe('g1', gifEmbedItem());
  assert.ok(result.text.length <= 200, `${result.text.length} chars`);
  assert.ok(!result.text.includes('\n'));
  assert.ok(result.text.startsWith('Première ligne. mot0é'));
});

/** Asserts the one-frame path ran: the still frame through the proxy, the picture model, a `gif` entry. */
function assertOneFrame({ imageFetcher, llm, store }, itemId, { watchFailed = false } = {}) {
  assert.equal(imageFetcher.calls.length, 1, 'the still frame is fetched');
  assert.equal(new URL(imageFetcher.calls[0].url).searchParams.get('animated'), 'false');
  const last = llm.calls[llm.calls.length - 1];
  assert.equal(last.options.role, 'vision');
  assert.equal(last.messages[1].content[0].type, 'image_url');
  const entry = store.getMediaCache('g1')[itemId];
  assert.equal(typeof entry.text, 'string');
  assert.equal(entry.watched, undefined);
  assert.equal(entry.gif, true);
  assert.equal(typeof entry.watchFailed === 'number', watchFailed);
}

test('describe: video vision off, media.gif.watch false or no describe-video prompt -> the one-frame description, no watch', async () => {
  const setups = [
    gifHot({ features: { videoDescriptions: false } }),
    gifHot({ gif: { watch: false } }),
    gifHot({ prompts: { 'describe-video': undefined } }),
  ];
  for (const hot of setups) {
    const run = gifDescriber({ hot, llm: fakeLlm({ text: 'a sign by a railway crossing' }) });
    const result = await run.describer.describe('g1', gifEmbedItem());
    assert.equal(result.text, 'a sign by a railway crossing');
    assert.equal(run.videoFetcher.calls.length, 0);
    assert.equal(run.state.data.videoCount, undefined, 'no daily video slot');
    assert.equal(run.state.data.gifWatchCount, undefined, 'no daily GIF slot');
    assertOneFrame(run, 'm1#e0');
  }
});

test('describe: a GIF that cannot be fetched or converted falls back to one frame, marked watchFailed, logging codes only', async () => {
  for (const reason of ['download', 'tool', 'size', 'timeout']) {
    const run = gifDescriber({ videoFetcher: gifFetcher({ ok: false, reason }), llm: fakeLlm({ text: 'a still' }) });
    const { result, logs } = await withCapturedLogs(() => run.describer.describe('g1', gifAttachmentItem()));
    assert.equal(result.text, 'a still');
    assertOneFrame(run, 'a9', { watchFailed: true });
    const line = logs.find((l) => l.msg === 'describe: gif');
    assert.equal(line.state, 'failed');
    assert.equal(line.reason, reason);
    assert.equal(line.location, 'cdn.discordapp.com/attachments/1/2/anim.gif');
    assert.ok(!JSON.stringify(logs).includes('secret'));
    assert.equal(run.state.data.gifWatchCount, 1, 'the attempt keeps its daily GIF slot');
    assert.equal(run.state.data.videoCount, undefined, 'never a daily video slot');
  }
});

test('describe: a failed or empty watch request falls back to one frame, marked watchFailed', async () => {
  const failing = gifDescriber({ llm: fakeLlm([Object.assign(new Error('boom'), { statusCode: 502 }), { text: 'a still' }]) });
  assert.equal((await failing.describer.describe('g1', gifEmbedItem())).text, 'a still');
  assertOneFrame(failing, 'm1#e0', { watchFailed: true });

  const empty = gifDescriber({ llm: fakeLlm([{ text: '   ' }, { text: 'a still' }]) });
  assert.equal((await empty.describer.describe('g1', gifEmbedItem())).text, 'a still');
  assertOneFrame(empty, 'm1#e0', { watchFailed: true });
});

test('describe: a spent daily GIF cap or request cap falls back to one frame, not marked as a failed watch', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const daily = gifDescriber({ hot: gifHot({ gif: { maxPerDay: 1 } }), state: fakeState({ gifWatchDay: today, gifWatchCount: 1 }) });
  const { logs } = await withCapturedLogs(() => daily.describer.describe('g1', gifEmbedItem()));
  assert.equal(daily.videoFetcher.calls.length, 0);
  assertOneFrame(daily, 'm1#e0');
  assert.equal(daily.state.data.gifWatchCount, 1, 'a refused watch takes no slot');
  const line = logs.find((l) => l.msg === 'describe: gif');
  assert.equal(line.state, 'unavailable');
  assert.equal(line.reason, 'daily');

  const capped = gifDescriber({ llm: fakeLlm([new DailyCapError('cap'), { text: 'a still' }]) });
  await capped.describer.describe('g1', gifEmbedItem());
  assertOneFrame(capped, 'm1#e0');
});

test('describe: a cached one-frame GIF caption is served as it is, never re-watched automatically', async () => {
  const run = gifDescriber();
  run.store.getMediaCache('g1')['m1#e0'] = { text: 'a sign in a foreign script', ts: 1 };
  const result = await run.describer.describe('g1', gifEmbedItem());
  assert.equal(result.text, 'a sign in a foreign script');
  assert.equal(result.cached, true);
  assert.equal(run.videoFetcher.calls.length, 0);
  assert.equal(run.llm.calls.length, 0);
});

test('describe: two callers reaching the same new GIF at once share one watch', async () => {
  const run = gifDescriber();
  const [a, b] = await Promise.all([run.describer.describe('g1', gifEmbedItem()), run.describer.describe('g1', gifEmbedItem())]);
  assert.equal(a.text, b.text);
  assert.equal(run.videoFetcher.calls.length, 1);
  assert.equal(run.llm.calls.length, 1);
});

test('describe: pictures and videos are untouched by the GIF watch', async () => {
  const run = gifDescriber({ llm: fakeLlm({ text: 'a cat' }) });
  await run.describer.describe('g1', pictureItem('p1', { source: 'attachment' }));
  await run.describer.describe('g1', pictureItem('v1', { source: 'attachment', kind: 'video', url: 'https://cdn.discordapp.com/x/clip.mp4' }));
  assert.equal(run.videoFetcher.calls.length, 0);
  assert.equal(run.imageFetcher.calls.length, 2);
  assert.deepEqual(Object.keys(run.store.getMediaCache('g1').p1).sort(), ['describedAt', 'model', 'text', 'ts']);
  assert.deepEqual(Object.keys(run.store.getMediaCache('g1').v1).sort(), ['describedAt', 'model', 'text', 'ts']);
  assert.ok(run.llm.calls.every((c) => c.options.role === 'vision'));

  const video = await run.describer.describeVideo('g1', videoAttachment());
  assert.equal(video.state, 'watched');
  assert.equal(run.videoFetcher.calls[0].fn, 'fetchAttachment');
});

// --- watchGif: the recache's re-description ---------------------------------

test('watchGif: replaces a one-frame caption with a watched one under the same key', async () => {
  const run = gifDescriber();
  run.store.getMediaCache('g1')['m1#e0'] = { text: 'a still', ts: 1, gif: true };
  const result = await run.describer.watchGif('g1', gifEmbedItem());
  assert.deepEqual(result, { state: 'watched', text: 'a man pulls a child back as a train rushes past' });
  const entry = run.store.getMediaCache('g1')['m1#e0'];
  assert.equal(entry.watched, true);
  assert.equal(entry.text, 'a man pulls a child back as a train rushes past');
});

test('watchGif: an entry already watched is served from the cache, no fetch, no request', async () => {
  const run = gifDescriber();
  run.store.getMediaCache('g1')['m1#e0'] = { text: 'watched before', reaction: '', action: 'watched before', screen: '', ts: 1, watched: true, gif: true };
  assert.deepEqual(await run.describer.watchGif('g1', gifEmbedItem()), { state: 'watched', text: 'watched before', cached: true });
  assert.equal(run.videoFetcher.calls.length, 0);
});

test('watchGif: a failed watch keeps the old caption and marks it watchFailed; never one frame', async () => {
  const run = gifDescriber({ videoFetcher: gifFetcher({ ok: false, reason: 'tool' }) });
  run.store.getMediaCache('g1')['m1#e0'] = { text: 'a still', ts: 1, gif: true };
  assert.deepEqual(await run.describer.watchGif('g1', gifEmbedItem()), { state: 'failed', reason: 'tool' });
  const entry = run.store.getMediaCache('g1')['m1#e0'];
  assert.equal(entry.text, 'a still');
  assert.equal(typeof entry.watchFailed, 'number');
  assert.equal(run.imageFetcher.calls.length, 0);
  assert.equal(run.llm.calls.length, 0);
});

test('watchGif: an item without an animation fails as source; an uncaptioned GIF gets a marked miss', async () => {
  const run = gifDescriber();
  const item = gifEmbedItem('m2#e0');
  delete item.animationUrl;
  assert.deepEqual(await run.describer.watchGif('g1', item), { state: 'failed', reason: 'source' });
  const entry = run.store.getMediaCache('g1')['m2#e0'];
  assert.equal(entry.miss, true);
  assert.equal(typeof entry.watchFailed, 'number');
});

test('watchGif: a request failure is reported with a kebab-case code', async () => {
  for (const [error, expected] of [
    [new TokenLimitError('cap'), { state: 'failed', reason: 'token-limit' }],
    [new Error('boom'), { state: 'failed', reason: 'llm-error' }],
    [new DailyCapError('day'), { state: 'unavailable', reason: 'daily-cap' }],
  ]) {
    const run = gifDescriber({ llm: fakeLlm(error) });
    assert.deepEqual(await run.describer.watchGif('g1', gifEmbedItem()), expected);
  }
});

test('watchGif: with the daily request cap spent nothing is fetched, no GIF slot is taken, nothing is marked', async () => {
  const run = gifDescriber({ llm: cappedLlm(0) });
  assert.deepEqual(await run.describer.watchGif('g1', gifEmbedItem()), { state: 'unavailable', reason: 'daily-cap' });
  assert.equal(run.videoFetcher.calls.length, 0);
  assert.equal(run.state.data.gifWatchCount, undefined);
  assert.equal(run.store.getMediaCache('g1')['m1#e0'], undefined);
});

test('watchGif: unavailable while GIFs are not watched or a daily rail is spent, nothing marked', async () => {
  const off = gifDescriber({ hot: gifHot({ features: { videoDescriptions: false } }) });
  assert.deepEqual(await off.describer.watchGif('g1', gifEmbedItem()), { state: 'unavailable', reason: 'video-off' });
  assert.equal(off.describer.gifWatchBlocker(), 'video-off');
  const noWatch = gifDescriber({ hot: gifHot({ gif: { watch: false } }) });
  assert.equal(noWatch.describer.gifWatchBlocker(), 'off');
  assert.equal(gifDescriber().describer.gifWatchBlocker(), null);

  const daily = gifDescriber({ hot: gifHot({ gif: { maxPerDay: 0 } }) });
  assert.deepEqual(await daily.describer.watchGif('g1', gifEmbedItem()), { state: 'unavailable', reason: 'daily' });
  assert.equal(daily.store.getMediaCache('g1')['m1#e0'], undefined);
});

// --- The GIF watch's own daily cap and prompt --------------------------------

test('describe: a spent daily video cap never stops a GIF watch', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const run = gifDescriber({ hot: gifHot({ video: { maxPerDay: 1 } }), state: fakeState({ videoDay: today, videoCount: 1 }) });
  const result = await run.describer.describe('g1', gifEmbedItem());
  assert.equal(result.text, 'a man pulls a child back as a train rushes past');
  assert.equal(run.store.getMediaCache('g1')['m1#e0'].watched, true);
  assert.equal(run.state.data.videoCount, 1, 'the video count is untouched');
  assert.equal(run.state.data.gifWatchCount, 1);
});

test('describeVideo: a spent daily GIF cap never stops a video watch, and a video takes no GIF slot', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const run = gifDescriber({ hot: gifHot({ gif: { maxPerDay: 1 } }), state: fakeState({ gifWatchDay: today, gifWatchCount: 1 }) });
  const video = await run.describer.describeVideo('g1', videoAttachment());
  assert.equal(video.state, 'watched');
  assert.equal(run.state.data.videoCount, 1);
  assert.equal(run.state.data.gifWatchCount, 1, 'the GIF count is untouched');

  const fresh = gifDescriber();
  await fresh.describer.describeVideo('g1', videoAttachment());
  assert.equal(fresh.state.data.videoCount, 1);
  assert.equal(fresh.state.data.gifWatchCount, undefined);
});

test('describe: the GIF cap counts every watch attempt up to media.gif.maxPerDay, then falls back to one frame', async () => {
  const run = gifDescriber({ hot: gifHot({ gif: { maxPerDay: 2 } }), llm: fakeLlm({ text: 'a clip' }) });
  await run.describer.describe('g1', gifEmbedItem('m1#e0'));
  await run.describer.describe('g1', gifEmbedItem('m2#e0'));
  await run.describer.describe('g1', gifEmbedItem('m3#e0'));
  assert.equal(run.videoFetcher.calls.length, 2, 'the third GIF is not fetched');
  assert.equal(run.state.data.gifWatchCount, 2);
  assert.equal(run.store.getMediaCache('g1')['m2#e0'].watched, true);
  assertOneFrame(run, 'm3#e0');
});

test('describe: the GIF count rolls over with the UTC day', async () => {
  let clock = Date.parse('2026-10-01T23:59:00Z');
  const state = fakeState({ gifWatchDay: '2026-10-01', gifWatchCount: 3 });
  const run = gifDescriber({ hot: gifHot({ gif: { maxPerDay: 3 } }), state, now: () => clock, llm: fakeLlm({ text: 'a still' }) });
  await run.describer.describe('g1', gifEmbedItem('m1#e0'));
  assert.equal(run.videoFetcher.calls.length, 0, 'spent today');
  assert.equal(state.data.gifWatchCount, 3);

  clock = Date.parse('2026-10-02T00:01:00Z');
  await run.describer.describe('g1', gifEmbedItem('m2#e0'));
  assert.equal(run.videoFetcher.calls.length, 1, 'a new day, a new slot');
  assert.equal(state.data.gifWatchDay, '2026-10-02');
  assert.equal(state.data.gifWatchCount, 1);
});

test('describe: a GIF watch uses describe-gif when present, with {{maxChars}} and {{seconds}}', async () => {
  const hot = gifHot({ gif: { maxSeconds: 6 }, prompts: { 'describe-gif': 'Silent loop of {{seconds}} s, caption up to {{maxChars}}, {{today}}.' } });
  const run = gifDescriber({ hot, now: () => Date.parse('2026-10-01T12:00:00Z') });
  await run.describer.describe('g1', gifEmbedItem());
  assert.deepEqual(run.llm.calls[0].messages[0], { role: 'system', content: 'Silent loop of 6 s, caption up to 200, 2026-10-01.' });
  assert.equal(run.llm.calls[0].options.role, 'video');
});

test('describe: describe-gif alone (no describe-video) is enough to watch GIFs', async () => {
  const run = gifDescriber({ hot: gifHot({ prompts: { 'describe-video': undefined, 'describe-gif': 'Loop, {{maxChars}}.' } }) });
  assert.equal(run.describer.gifWatchBlocker(), null);
  await run.describer.describe('g1', gifEmbedItem());
  assert.equal(run.videoFetcher.calls[0].fn, 'fetchGif');
  assert.equal(run.llm.calls[0].messages[0].content, 'Loop, 200.');
});

// --- The GIF describer's three fields ------------------------------------------

const GIF_FIELD_CAPS = { descriptionChars: 200 };

test('parseGifDescription: three labelled lines, any order and case, "none" read as empty', () => {
  const parsed = parseGifDescription('Text: "ναι."\nREACTION: firm agreement\naction: a cat lifts its chin', GIF_FIELD_CAPS);
  assert.deepEqual(parsed, { text: 'a cat lifts its chin', reaction: 'firm agreement', action: 'a cat lifts its chin', screen: 'ναι.' });
  const none = parseGifDescription('reaction: none\naction: a train passes\ntext: None.', GIF_FIELD_CAPS);
  assert.deepEqual(none, { text: 'a train passes', reaction: '', action: 'a train passes', screen: '' });
});

test('parseGifDescription: missing lines are tolerated; an unlabelled answer is the action alone', () => {
  assert.deepEqual(parseGifDescription('action: a man waves', GIF_FIELD_CAPS), { text: 'a man waves', reaction: '', action: 'a man waves', screen: '' });
  assert.deepEqual(parseGifDescription('  a man waves\n  goodbye  ', GIF_FIELD_CAPS), { text: 'a man waves goodbye', reaction: '', action: 'a man waves goodbye', screen: '' });
  assert.deepEqual(
    parseGifDescription("reaction: waiting\ntext: j'attends", GIF_FIELD_CAPS),
    { text: 'waiting', reaction: 'waiting', action: '', screen: "j'attends" },
    'no action: the transcript line falls back to the reaction',
  );
  assert.equal(parseGifDescription('   ', GIF_FIELD_CAPS), null);
  assert.equal(parseGifDescription('reaction: none\naction: none\ntext: none', GIF_FIELD_CAPS), null);
});

test('parseGifDescription: a 60-character on-screen text is stored whole; text is unchanged', () => {
  const screen = 'Ἐν ἀρχῇ ἦν ὁ λόγος καὶ ὁ λόγος ἦν πρὸς τὸν θεόν, καὶ θεὸς ἦν';
  assert.equal([...screen].length, 60);
  const parsed = parseGifDescription(`reaction: firm agreement\naction: a cat lifts its chin\ntext: ${screen}`, GIF_FIELD_CAPS);
  assert.deepEqual(parsed, { text: 'a cat lifts its chin', reaction: 'firm agreement', action: 'a cat lifts its chin', screen });
});

test('parseGifDescription: every field is bounded only by descriptionChars, like text', () => {
  const long = Array.from({ length: 30 }, (_, i) => `mot${i}`).join(' ');
  const answer = `reaction: ${long}\naction: ${long}\ntext: ${long}`;
  const whole = parseGifDescription(answer, GIF_FIELD_CAPS);
  assert.deepEqual(whole, { text: long, reaction: long, action: long, screen: long }, 'nothing cut under descriptionChars');
  const bounded = parseGifDescription(answer, { descriptionChars: 50 });
  for (const field of ['text', 'reaction', 'action', 'screen']) {
    assert.ok([...bounded[field]].length <= 50, `${field}: ${bounded[field].length}`);
    assert.ok(long.startsWith(bounded[field]), `${field} is a prefix of the answer`);
  }
});

test('describe: a three-field GIF answer is cached as text, reaction, action and screen', async () => {
  const llm = fakeLlm({ text: 'reaction: firm agreement\naction: a cat lifts its chin\ntext: yes.' });
  const hot = gifHot();
  hot.config.gifs = { reactionChars: 40, actionChars: 70 };
  const { describer, store } = gifDescriber({ llm, hot });
  const result = await describer.describe('g1', gifEmbedItem());
  assert.equal(result.text, 'a cat lifts its chin');
  const entry = store.getMediaCache('g1')['m1#e0'];
  assert.deepEqual(
    { ...entry, ts: 0, describedAt: 0 },
    { text: 'a cat lifts its chin', reaction: 'firm agreement', action: 'a cat lifts its chin', screen: 'yes.', ts: 0, watched: true, gif: true, describedAt: 0, model: 'x/video-model' },
  );
});

test('describe: gifs.reactionChars and gifs.actionChars never cut the cached fields', async () => {
  const llm = fakeLlm({ text: 'reaction: quiet firm agreement\naction: a small cat lifts its chin slowly' });
  const hot = gifHot();
  hot.config.gifs = { reactionChars: 12, actionChars: 20 };
  const { describer, store } = gifDescriber({ llm, hot });
  await describer.describe('g1', gifEmbedItem());
  const entry = store.getMediaCache('g1')['m1#e0'];
  assert.deepEqual([entry.reaction, entry.action, entry.text], ['quiet firm agreement', 'a small cat lifts its chin slowly', 'a small cat lifts its chin slowly']);
});

test('watchGif: an old-format watched entry (no reaction field) is watched again and gains the fields', async () => {
  const run = gifDescriber({ llm: fakeLlm({ text: 'reaction: waiting\naction: a caracal stares ahead\ntext: none' }) });
  run.store.getMediaCache('g1')['m1#e0'] = { text: 'watched before', ts: 1, watched: true, gif: true };
  assert.deepEqual(await run.describer.watchGif('g1', gifEmbedItem()), { state: 'watched', text: 'a caracal stares ahead' });
  const entry = run.store.getMediaCache('g1')['m1#e0'];
  assert.deepEqual([entry.reaction, entry.action, entry.screen, entry.watched], ['waiting', 'a caracal stares ahead', '', true]);
});

// --- rewatchGif / watchedGifs: the second look at a watched GIF -----------------

/** gifHot with the re-watch prompt and settings. */
function gifRewatchHot({ features = {}, gif = {}, rewatch = {} } = {}) {
  return gifHot({ features, gif, video: { rewatch: { ...REWATCH_CFG, ...rewatch } }, prompts: { 'rewatch-answer': REWATCH_PROMPT } });
}

const WATCHED_GIF_ENTRY = { text: 'a woman looks into a mirror', reaction: '', action: 'a woman looks into a mirror', screen: '', ts: 1, watched: true, gif: true };

test('watchedGifs: only watched GIF entries with an animation, from the cache alone; none while GIFs are not watched', async () => {
  const run = gifDescriber({ hot: gifRewatchHot() });
  const cache = run.store.getMediaCache('g1');
  cache['m1#e0'] = { ...WATCHED_GIF_ENTRY };
  cache['m2#e0'] = { text: 'one frame', ts: 1, gif: true };
  cache['m3#e0'] = { ...WATCHED_GIF_ENTRY };
  const items = [gifEmbedItem('m1#e0'), gifEmbedItem('m2#e0', { messageId: 'm2' }), gifEmbedItem('m3#e0', { messageId: 'm3', animationUrl: undefined }), pictureItem('p1')];
  assert.deepEqual([...run.describer.watchedGifs('g1', items)], [['m1#e0', 'a woman looks into a mirror']]);
  assert.equal(run.videoFetcher.calls.length, 0);
  assert.equal(run.llm.calls.length, 0);

  const off = gifDescriber({ hot: gifRewatchHot({ gif: { watch: false } }) });
  off.store.getMediaCache('g1')['m1#e0'] = { ...WATCHED_GIF_ENTRY };
  assert.equal(off.describer.watchedGifs('g1', items).size, 0);
});

test('rewatchGif: one GIF clip fetch and one video request with the question; the answer cached under gif:<itemId>:q:', async () => {
  const state = fakeState();
  const run = gifDescriber({ hot: gifRewatchHot({ gif: { maxSeconds: 6 } }), llm: fakeLlm({ text: '  une autre personne   dans le miroir ' }), state });

  const result = await run.describer.rewatchGif('g1', gifEmbedItem(), 'Qui est dans le miroir ?');

  assert.deepEqual(result, { question: 'Qui est dans le miroir ?', text: 'une autre personne dans le miroir' });
  assert.deepEqual(run.videoFetcher.calls.map((c) => [c.fn, c.url, c.options.maxSeconds]), [['fetchGif', TENOR_MP4, 6]]);
  assert.equal(run.llm.calls.length, 1);
  const [system, user] = run.llm.calls[0].messages;
  assert.equal(system.content, 'Question: Qui est dans le miroir ?. At most 1200 characters.');
  assert.deepEqual(user.content, [{ type: 'video_url', video_url: { url: GIF_CLIP_URL } }]);
  const options = run.llm.calls[0].options;
  assert.equal(options.role, 'video');
  assert.equal(options.maxOutputTokens, 600);
  assert.equal(options.videoSeconds, 6);
  assert.equal(state.data.rewatchCount, 1);
  assert.equal(state.data.gifWatchCount, 1, 'a GIF watch slot, like the first watch');
  assert.equal(state.data.videoCount, undefined, 'never a video slot');
  const digest = createHash('sha1').update('qui est dans le miroir ?').digest('hex').slice(0, 16);
  assert.equal(run.store.getMediaCache('g1')[`gif:m1#e0:q:${digest}`].answer, 'une autre personne dans le miroir');

  const again = await run.describer.rewatchGif('g1', gifEmbedItem(), 'qui est dans le miroir ?');
  assert.equal(again.text, 'une autre personne dans le miroir');
  assert.equal(run.llm.calls.length, 1, 'the same question within an hour is free');
});

test('rewatchGif: a full re-watch or GIF counter refuses without a fetch; a failed fetch keeps both slots and caches nothing', async () => {
  const today = new Date().toISOString().slice(0, 10);
  for (const data of [{ rewatchDay: today, rewatchCount: 2 }, { gifWatchDay: today, gifWatchCount: 3 }]) {
    const run = gifDescriber({ hot: gifRewatchHot({ gif: { maxPerDay: 3 }, rewatch: { maxPerDay: 2 } }), state: fakeState({ ...data }) });
    assert.equal(await run.describer.rewatchGif('g1', gifEmbedItem(), 'q ?'), null);
    assert.equal(run.videoFetcher.calls.length, 0, JSON.stringify(data));
  }
  const state = fakeState();
  const failing = gifDescriber({ hot: gifRewatchHot(), videoFetcher: gifFetcher({ ok: false, reason: 'convert' }), state });
  assert.equal(await failing.describer.rewatchGif('g1', gifEmbedItem(), 'q ?'), null);
  assert.equal(failing.llm.calls.length, 0);
  assert.deepEqual([state.data.rewatchCount, state.data.gifWatchCount], [1, 1]);
  assert.ok(!Object.keys(failing.store.getMediaCache('g1')).some((key) => key.startsWith('gif:')));
});

test('rewatchGif: GIFs not watched, videoRewatch off, no prompt, no animation or an empty question -> null, no fetch', async () => {
  const noPrompt = gifRewatchHot();
  delete noPrompt.prompts['rewatch-answer'];
  const cases = [
    [gifRewatchHot({ gif: { watch: false } }), gifEmbedItem(), 'q ?'],
    [gifRewatchHot({ features: { videoRewatch: false } }), gifEmbedItem(), 'q ?'],
    [gifRewatchHot({ features: { videoDescriptions: false } }), gifEmbedItem(), 'q ?'],
    [noPrompt, gifEmbedItem(), 'q ?'],
    [gifRewatchHot(), gifEmbedItem('m1#e0', { animationUrl: undefined }), 'q ?'],
    [gifRewatchHot(), gifEmbedItem(), '   '],
  ];
  for (const [hot, item, question] of cases) {
    const run = gifDescriber({ hot });
    assert.equal(await run.describer.rewatchGif('g1', item, question), null);
    assert.equal(run.videoFetcher.calls.length, 0);
    assert.equal(run.llm.calls.length, 0);
  }
});

test('rewatchGif: logs one describe: rewatch line with kind gif -- never the question, the answer or a signed URL', async () => {
  const run = gifDescriber({ hot: gifRewatchHot(), llm: fakeLlm({ text: 'a secret answer' }) });
  const { logs } = await withCapturedLogs(() => run.describer.rewatchGif('g1', gifAttachmentItem(), 'a secret question'));
  const lines = logs.filter((entry) => entry.msg === 'describe: rewatch');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'gif');
  assert.equal(lines[0].state, 'answered');
  const all = JSON.stringify(logs);
  assert.ok(!all.includes('a secret answer'));
  assert.ok(!all.includes('a secret question'));
  assert.ok(!all.includes('ex=secret'));
});

test('describeVideo: media.video.proxy reaches the probe and the clip only for a site in proxySites', async () => {
  const proxy = 'socks5h://user:pw@proxy.example:1080';
  const cases = [
    [{ proxy, proxySites: ['youtube.com', 'youtu.be'] }, 'https://www.youtube.com/watch?v=abc', proxy],
    [{ proxy, proxySites: ['youtube.com', 'youtu.be'] }, 'https://www.tiktok.com/@a/video/1', null],
    [{ proxy: '', proxySites: ['youtube.com', 'youtu.be'] }, 'https://www.youtube.com/watch?v=abc', null],
    [{ proxy, proxySites: [] }, 'https://www.youtube.com/watch?v=abc', null],
  ];
  for (const [video, url, expected] of cases) {
    const hot = videoHot({ video: { ...video, provider: null } });
    const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec: 125, title: null } });
    const { describer } = videoDescriber({ hot, videoFetcher });
    await describer.describeVideo('g1', videoLink(undefined, { url }));
    assert.deepEqual(videoFetcher.calls.map((c) => c.fn), ['probeSite', 'fetchSiteClip'], url);
    for (const call of videoFetcher.calls) assert.equal(call.options.proxy, expected, `${call.fn} ${url}`);
  }
});

// --- media.recacheBefore: provenance and staleness ------------------------------

const CUTOFF_ISO = '2026-10-15T00:00:00.000Z';
const CUTOFF = Date.parse(CUTOFF_ISO);
const HOUR = 60 * 60 * 1000;

/** A clock the test moves by hand. */
function handClock(start) {
  const clock = { at: start, now: () => clock.at };
  return clock;
}

test('recacheCutoffMs: an ISO date-time as ms; null, a missing key or an invalid value is off', () => {
  assert.equal(recacheCutoffMs({ media: { recacheBefore: CUTOFF_ISO } }), CUTOFF);
  assert.equal(recacheCutoffMs({ media: { recacheBefore: null } }), null);
  assert.equal(recacheCutoffMs({ media: {} }), null);
  assert.equal(recacheCutoffMs({}), null);
  assert.equal(recacheCutoffMs({ media: { recacheBefore: 'not a date' } }), null);
  assert.equal(recacheCutoffMs({ media: { recacheBefore: 12 } }), null);
});

test('isStaleDescription: missing or earlier describedAt is stale; at or after the cutoff is not; no cutoff never is', () => {
  assert.equal(isStaleDescription({ text: 'a', ts: 1 }, CUTOFF), true, 'missing');
  assert.equal(isStaleDescription({ text: 'a', ts: 1, describedAt: CUTOFF - 1 }, CUTOFF), true, 'earlier');
  assert.equal(isStaleDescription({ text: 'a', ts: 1, describedAt: CUTOFF }, CUTOFF), false, 'at');
  assert.equal(isStaleDescription({ text: 'a', ts: 1, describedAt: CUTOFF + 1 }, CUTOFF), false, 'later');
  assert.equal(isStaleDescription({ text: 'a', ts: 1 }, null), false, 'recacheBefore null');
});

test('describe: a new picture entry carries describedAt (ms) and the model used', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const llm = fakeLlm({ text: 'une tasse' });
  const describer = createDescriber({ hot: fakeHot(), store, llm, imageFetcher: fakeImageFetcher(), now: () => 5_000 });
  await describer.describe('g1', pictureItem('a1'));
  const entry = store.getMediaCache('g1').a1;
  assert.equal(entry.describedAt, 5_000);
  assert.equal(entry.model, 'x/haiku');
  assert.equal(entry.model, llm.calls[0].options.model);
});

test('describe: with media.recacheBefore null an old entry is served from the cache', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  store.getMediaCache('g1').a1 = { text: 'une vieille photo', ts: 1 };
  const llm = fakeLlm({ text: 'new' });
  const imageFetcher = fakeImageFetcher();
  const describer = createDescriber({ hot: fakeHot({ config: { media: { recacheBefore: null, cacheEntries: 5000 } } }), store, llm, imageFetcher, now: () => CUTOFF + HOUR });
  const result = await describer.describe('g1', pictureItem('a1'));
  assert.equal(result.text, 'une vieille photo');
  assert.equal(result.cached, true);
  assert.equal(llm.calls.length, 0);
  assert.equal(imageFetcher.calls.length, 0);
});

test('describe: with media.recacheBefore set, an entry described before it (or never stamped) is described again; a later one is served', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const cache = store.getMediaCache('g1');
  cache.old = { text: 'une vieille photo', ts: 1 };
  cache.earlier = { text: 'une photo', ts: 2, describedAt: CUTOFF - 1, model: 'x/old' };
  cache.fresh = { text: 'une photo récente', ts: 3, describedAt: CUTOFF + 1, model: 'x/haiku' };
  const llm = fakeLlm({ text: 'une nouvelle description' });
  const hot = fakeHot({ config: { media: { recacheBefore: CUTOFF_ISO, cacheEntries: 5000 } } });
  const describer = createDescriber({ hot, store, llm, imageFetcher: fakeImageFetcher(), now: () => CUTOFF + HOUR });

  assert.equal((await describer.describe('g1', pictureItem('old'))).text, 'une nouvelle description');
  assert.equal((await describer.describe('g1', pictureItem('earlier'))).text, 'une nouvelle description');
  const fresh = await describer.describe('g1', pictureItem('fresh'));
  assert.equal(fresh.text, 'une photo récente');
  assert.equal(fresh.cached, true);
  assert.equal(llm.calls.length, 2);
  assert.equal(cache.old.describedAt, CUTOFF + HOUR);
  assert.equal(cache.old.model, 'x/haiku');
  // Described again now: served from the cache from here on.
  assert.equal((await describer.describe('g1', pictureItem('old'))).cached, true);
  assert.equal(llm.calls.length, 2);
});

test('describe: a stale entry whose new description fails keeps its old text and is not retried until the miss TTL', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const cache = store.getMediaCache('g1');
  cache.a1 = { text: 'une vieille photo', ts: 1 };
  const clock = handClock(CUTOFF + HOUR);
  const llm = fakeLlm([new Error('boom'), { text: 'enfin' }]);
  const hot = fakeHot({ config: { media: { recacheBefore: CUTOFF_ISO, cacheEntries: 5000 } } });
  const describer = createDescriber({ hot, store, llm, imageFetcher: fakeImageFetcher(), now: clock.now });

  const failed = await describer.describe('g1', pictureItem('a1'));
  assert.equal(failed.text, 'une vieille photo', 'better a stale description than none');
  assert.equal(cache.a1.text, 'une vieille photo');
  assert.equal(cache.a1.miss, undefined);
  assert.equal(llm.calls.length, 1);

  clock.at += 30 * 60 * 1000;
  assert.equal((await describer.describe('g1', pictureItem('a1'))).text, 'une vieille photo');
  assert.equal(llm.calls.length, 1, 'not retried within the hour');

  clock.at += 31 * 60 * 1000;
  assert.equal((await describer.describe('g1', pictureItem('a1'))).text, 'enfin');
  assert.equal(llm.calls.length, 2);
  assert.equal(cache.a1.describedAt, clock.at);
});

test('describe: a stale entry whose download fails keeps its old text', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  store.getMediaCache('g1').a1 = { text: 'une vieille photo', ts: 1 };
  const hot = fakeHot({ config: { media: { recacheBefore: CUTOFF_ISO, cacheEntries: 5000 } } });
  const describer = createDescriber({ hot, store, llm: fakeLlm({ text: 'x' }), imageFetcher: fakeImageFetcher(null), now: () => CUTOFF + HOUR });
  assert.equal((await describer.describe('g1', pictureItem('a1'))).text, 'une vieille photo');
  assert.equal(store.getMediaCache('g1').a1.text, 'une vieille photo');
});

test('describe: a stale entry with the daily request cap spent is served as it is, nothing downloaded', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  store.getMediaCache('g1').a1 = { text: 'une vieille photo', ts: 1 };
  const llm = cappedLlm(0);
  const imageFetcher = fakeImageFetcher();
  const hot = fakeHot({ config: { media: { recacheBefore: CUTOFF_ISO, cacheEntries: 5000 } } });
  const describer = createDescriber({ hot, store, llm, imageFetcher, now: () => CUTOFF + HOUR });
  assert.equal((await describer.describe('g1', pictureItem('a1'))).text, 'une vieille photo');
  const many = await describer.describeMany('g1', [pictureItem('a1')], { maxNew: 6 });
  assert.equal(many.descriptions.get('a1'), 'une vieille photo');
  assert.equal(imageFetcher.calls.length, 0);
  assert.equal(llm.calls.length, 0);
});

test('describeMany: stale entries count toward maxNew; past it their old text is served', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const cache = store.getMediaCache('g1');
  cache.s1 = { text: 'vieux un', ts: 1 };
  cache.s2 = { text: 'vieux deux', ts: 1 };
  const llm = fakeLlm({ text: 'neuf' });
  const hot = fakeHot({ config: { media: { recacheBefore: CUTOFF_ISO, cacheEntries: 5000 } } });
  const describer = createDescriber({ hot, store, llm, imageFetcher: fakeImageFetcher(), now: () => CUTOFF + HOUR });
  const charged = [];
  const { descriptions, newCount } = await describer.describeMany('g1', [pictureItem('s1'), pictureItem('s2')], { maxNew: 1, onCharge: (r) => charged.push(r) });
  assert.equal(newCount, 1);
  assert.equal(descriptions.get('s1'), 'neuf');
  assert.equal(descriptions.get('s2'), 'vieux deux');
  assert.equal(llm.calls.length, 1);
  assert.equal(charged.length, 1);
});

test('describe: a watched GIF entry carries describedAt and the video model', async () => {
  const run = gifDescriber({ now: () => 9_000 });
  await run.describer.describe('g1', gifEmbedItem());
  const entry = run.store.getMediaCache('g1')['m1#e0'];
  assert.equal(entry.watched, true);
  assert.equal(entry.describedAt, 9_000);
  assert.equal(entry.model, 'x/video-model');
});

test('describe: a stale watched GIF is watched again; a failed watch keeps the watched text, never one frame', async () => {
  const hot = gifHot({ media: { recacheBefore: CUTOFF_ISO } });
  const ok = gifDescriber({ hot, now: () => CUTOFF + HOUR });
  ok.store.getMediaCache('g1')['m1#e0'] = { ...WATCHED_GIF_ENTRY };
  assert.equal((await ok.describer.describe('g1', gifEmbedItem())).text, 'a man pulls a child back as a train rushes past');
  assert.equal(ok.store.getMediaCache('g1')['m1#e0'].describedAt, CUTOFF + HOUR);

  const failing = gifDescriber({ hot, videoFetcher: gifFetcher({ ok: false, reason: 'tool' }), now: () => CUTOFF + HOUR });
  failing.store.getMediaCache('g1')['m1#e0'] = { ...WATCHED_GIF_ENTRY };
  const kept = await failing.describer.describe('g1', gifEmbedItem());
  assert.equal(kept.text, WATCHED_GIF_ENTRY.text);
  const entry = failing.store.getMediaCache('g1')['m1#e0'];
  assert.equal(entry.watched, true);
  assert.equal(entry.text, WATCHED_GIF_ENTRY.text);
  assert.equal(failing.imageFetcher.calls.length, 0, 'no one-frame fallback over a watched caption');
  assert.equal(failing.llm.calls.length, 0);
});

test('describeVideo: a watched entry carries describedAt and the video model', async () => {
  const { describer, store } = videoDescriber({ now: () => 4_000 });
  await describer.describeVideo('g1', videoAttachment());
  const entry = store.getMediaCache('g1')['video:v1'];
  assert.equal(entry.describedAt, 4_000);
  assert.equal(entry.model, 'x/video-model');
});

test('describeVideo: with media.recacheBefore set a stale summary is watched again; the cache-only read serves the old one', async () => {
  const hot = videoHot();
  hot.config.media.recacheBefore = CUTOFF_ISO;
  const { describer, store, llm } = videoDescriber({ hot, now: () => CUTOFF + HOUR });
  store.getMediaCache('g1')['video:v1'] = { text: 'une vieille vidéo', ts: 1, watched: true };
  const cachedOnly = await describer.cachedVideos('g1', [videoAttachment()]);
  assert.equal(cachedOnly.get('v1').text, 'une vieille vidéo');
  assert.equal(llm.calls.length, 0);
  const result = await describer.describeVideo('g1', videoAttachment());
  assert.equal(result.text, 'someone dances');
  assert.equal(store.getMediaCache('g1')['video:v1'].describedAt, CUTOFF + HOUR);
});

test('describeVideo: a stale summary whose watch fails keeps its text and waits errorRetryMinutes', async () => {
  const hot = videoHot();
  hot.config.media.recacheBefore = CUTOFF_ISO;
  const clock = handClock(CUTOFF + HOUR);
  const { describer, store, llm, state } = videoDescriber({ hot, llm: fakeLlm([new Error('boom'), { text: 'enfin' }]), now: clock.now });
  store.getMediaCache('g1')['video:v1'] = { text: 'une vieille vidéo', ts: 1, watched: true };
  const kept = await describer.describeVideo('g1', videoAttachment());
  assert.equal(kept.state, 'watched');
  assert.equal(kept.text, 'une vieille vidéo');
  assert.equal(store.getMediaCache('g1')['video:v1'].text, 'une vieille vidéo');
  assert.equal(store.getMediaCache('g1')['video:v1'].miss, undefined);

  clock.at += 30 * 60 * 1000;
  assert.equal((await describer.describeVideo('g1', videoAttachment())).text, 'une vieille vidéo');
  assert.equal(llm.calls.length, 1, 'not retried within errorRetryMinutes');

  clock.at += 31 * 60 * 1000;
  assert.equal((await describer.describeVideo('g1', videoAttachment())).text, 'enfin');
  assert.equal(state.data.videoCount, 2, 'each attempt takes a daily video slot');
});

test('describeVideo: a stale summary with the daily video rail spent is served as it is', async () => {
  const hot = videoHot({ video: { maxPerDay: 0 } });
  hot.config.media.recacheBefore = CUTOFF_ISO;
  const { describer, store, videoFetcher } = videoDescriber({ hot, now: () => CUTOFF + HOUR });
  store.getMediaCache('g1')['video:v1'] = { text: 'une vieille vidéo', ts: 1, watched: true };
  const result = await describer.describeVideo('g1', videoAttachment());
  assert.equal(result.text, 'une vieille vidéo');
  assert.equal(videoFetcher.calls.length, 0);
});

test('redescribe: describes a picture again whatever its cache holds; a failure keeps the old text; a spent cap is unavailable', async () => {
  const store = createStore({ dataDir: tmpDataDir() });
  const cache = store.getMediaCache('g1');
  cache.a1 = { text: 'par un vieux modèle', ts: 1, describedAt: 1, model: 'x/old' };
  cache.a2 = { text: 'garde-moi', ts: 1 };
  const llm = fakeLlm([{ text: 'par le nouveau' }, new Error('boom')]);
  const describer = createDescriber({ hot: fakeHot(), store, llm, imageFetcher: fakeImageFetcher(), now: () => 7_000 });

  assert.deepEqual(await describer.redescribe('g1', pictureItem('a1')), { state: 'done' });
  assert.equal(cache.a1.text, 'par le nouveau');
  assert.equal(cache.a1.model, 'x/haiku');
  assert.deepEqual(await describer.redescribe('g1', pictureItem('a2')), { state: 'failed' });
  assert.equal(cache.a2.text, 'garde-moi');

  const spent = createDescriber({ hot: fakeHot(), store, llm: cappedLlm(0), imageFetcher: fakeImageFetcher() });
  assert.deepEqual(await spent.redescribe('g1', pictureItem('a1')), { state: 'unavailable', reason: 'daily-cap' });
  const off = createDescriber({ hot: fakeHot({ config: { features: { mediaDescriptions: false } } }), store, llm, imageFetcher: fakeImageFetcher() });
  assert.deepEqual(await off.redescribe('g1', pictureItem('a1')), { state: 'unavailable', reason: 'off' });
  assert.equal(off.pictureBlocker(), 'off');
  assert.equal(describer.pictureBlocker(), null);
});

// --- the measured audio note and the watched length ---------------------------

const AUDIO_LABELS = { videoAudio: { none: 'NO-SOUND-NOTE', map: 'SOUND-ONLY {spans}' } };

test('describeVideo: a measured silent clip appends videoAudio.none to the system prompt after a blank line', async () => {
  const hot = videoHot({ prompts: { labels: AUDIO_LABELS } });
  const videoFetcher = fakeVideoFetcher({
    attachment: { ok: true, dataUrl: CLIP_DATA_URL, mimeType: 'video/mp4', seconds: 12, bytes: 4, audio: { kind: 'none' } },
  });
  const { describer, llm } = videoDescriber({ hot, videoFetcher });
  await describer.describeVideo('g1', videoAttachment());
  assert.equal(llm.calls[0].messages[0].content, `${VIDEO_PROMPT}\n\nNO-SOUND-NOTE`);
});

test('describeVideo: a mostly silent clip gets videoAudio.map with its stretches; full, unmeasured or a blank label add nothing', async () => {
  const cases = [
    [{ kind: 'map', spans: [[12.2, 13.4], [65, 80]] }, AUDIO_LABELS, `${VIDEO_PROMPT}\n\nSOUND-ONLY 0:12-0:14, 1:05-1:20`],
    [{ kind: 'full' }, AUDIO_LABELS, VIDEO_PROMPT],
    [null, AUDIO_LABELS, VIDEO_PROMPT],
    [{ kind: 'none' }, { videoAudio: { none: '' } }, VIDEO_PROMPT],
  ];
  for (const [audio, labels, expected] of cases) {
    const hot = videoHot({ prompts: { labels } });
    const clip = { ok: true, dataUrl: CLIP_DATA_URL, mimeType: 'video/mp4', seconds: 60, bytes: 4, audio };
    const item = videoLink('video:url:aaaaaaaaaaaaaaaa', { url: 'https://www.tiktok.com/@someone/video/123', site: 'tiktok.com' });
    const { describer, llm } = videoDescriber({ hot, videoFetcher: fakeVideoFetcher({ clip }) });
    await describer.describeVideo('g1', item);
    assert.equal(llm.calls[0].messages[0].content, expected);
  }
});

test('describeVideo: media.video.audioMap null or false passes no measuring to the fetcher', async () => {
  for (const audioMap of [null, false]) {
    const { describer, videoFetcher } = videoDescriber({ hot: videoHot({ video: { audioMap } }) });
    await describer.describeVideo('g1', videoAttachment());
    assert.equal(videoFetcher.calls[0].options.audioMap, null);
  }
  const custom = videoDescriber({ hot: videoHot({ video: { audioMap: { noiseDb: -30 } } }) });
  await custom.describer.describeVideo('g1', videoAttachment());
  assert.deepEqual(custom.videoFetcher.calls[0].options.audioMap, { ...AUDIO_MAP_ON, noiseDb: -30 });
});

test('rewatchVideo: the measured note is appended to the rewatch-answer prompt too', async () => {
  const hot = rewatchHot({ prompts: { labels: AUDIO_LABELS } });
  const videoFetcher = fakeVideoFetcher({
    attachment: { ok: true, dataUrl: CLIP_DATA_URL, mimeType: 'video/mp4', seconds: 12, bytes: 4, audio: { kind: 'none' } },
  });
  const { describer, llm } = videoDescriber({ hot, videoFetcher, llm: fakeLlm({ text: 'nothing heard' }) });
  await describer.rewatchVideo('g1', videoAttachment(), 'τι ακούγεται;');
  const system = llm.calls[0].messages[0].content;
  assert.ok(system.endsWith('\n\nNO-SOUND-NOTE'), system);
});

test('describeVideo: a downloaded clip stores its length as watchedSeconds; a pinned public URL stores none and gets no note', async () => {
  const hot = videoHot({ prompts: { labels: AUDIO_LABELS } });
  const item = videoAttachment('v9', { durationSec: 400 });
  const videoFetcher = fakeVideoFetcher({ attachment: { ok: true, dataUrl: CLIP_DATA_URL, mimeType: 'video/mp4', seconds: 60, bytes: 4 } });
  const clip = videoDescriber({ hot, videoFetcher });
  const watched = await clip.describer.describeVideo('g1', item);
  assert.equal(watched.watchedSeconds, 60);
  assert.equal(clip.store.getMediaCache('g1')['video:v9'].watchedSeconds, 60);
  assert.equal((await clip.describer.describeVideo('g1', item)).watchedSeconds, 60, 'a cache hit carries it');

  // A link clip also stores its probed total, and a cache hit carries both.
  const tiktok = videoLink('video:url:bbbbbbbbbbbbbbbb', { url: 'https://www.tiktok.com/@someone/video/9', site: 'tiktok.com' });
  const linkClip = videoDescriber({
    hot,
    videoFetcher: fakeVideoFetcher({ probe: { ok: true, durationSec: 400, title: null } }),
  });
  const linkWatched = await linkClip.describer.describeVideo('g1', tiktok);
  assert.equal(linkWatched.watchedSeconds, 60);
  assert.equal(linkWatched.totalSeconds, 400);
  assert.equal(linkClip.store.getMediaCache('g1')[`video:${tiktok.itemId}`].totalSeconds, 400);
  const linkHit = await linkClip.describer.describeVideo('g1', tiktok);
  assert.equal(linkHit.totalSeconds, 400);
  assert.equal(linkHit.watchedSeconds, 60);
  assert.equal('totalSeconds' in clip.store.getMediaCache('g1')['video:v9'], false, 'an attachment carries its own length');

  const pinned = videoDescriber({ hot });
  const link = videoLink();
  const result = await pinned.describer.describeVideo('g1', link);
  assert.equal(result.state, 'watched');
  assert.equal('watchedSeconds' in result, false);
  assert.equal('watchedSeconds' in pinned.store.getMediaCache('g1')[`video:${link.itemId}`], false);
  assert.equal('totalSeconds' in pinned.store.getMediaCache('g1')[`video:${link.itemId}`], false);
  assert.equal(pinned.llm.calls[0].messages[0].content, VIDEO_PROMPT);
});
