// Stage Z: yt-dlp takes the engine proxy for every site, read at the moment of each fetch, and goes direct while the
// engine is direct. `media.video.proxy` and `media.video.proxySites` are gone, so a layer that still sets them changes
// nothing. The describer and the YouTube check take `proxy`, the engine's proxy of the moment (src/net/proxy.ts,
// `ProxyMonitor.current`), in place of the stored video proxy. Fake fetchers and a fake model; nothing goes out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDescriber } from '../src/memory/describe.ts';
import { createStore } from '../src/memory/store.ts';
import { createYoutubeCheck } from '../src/memory/youtube-check.ts';
import { fakeImageFetcher, fakeLlm, fakeState, fakeVideoFetcher } from './fixtures/describe-fakes.ts';
import { tempDir } from './fixtures/tmp.ts';
import { memoryAt } from './fixtures/store-kit.ts';
import { chainsOf } from './fixtures/chains.ts';

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
  // Retired keys a private layer may still hold: neither may limit the engine proxy to a site list.
  proxy: '',
  proxySites: ['youtube.com'],
};

const hot = {
  config: {
    models: { routes: chainsOf({ vision: 'x/haiku', video: 'x/video-model' }) },
    media: { maxOutputTokens: 120, video: VIDEO },
    context: { vision: { fetchTimeoutMs: 10_000 } },
  },
  prompts: { describe: 'Describe this picture.', 'describe-video': 'Watch this clip and say what happens.' },
};

let count = 0;
function dataDir(): string {
  count += 1;
  const dir = path.join(tempDir('nep-proxy-video-'), String(count));
  fs.mkdirSync(dir);
  return dir;
}

function link(url: string, site: string) {
  return {
    source: 'link',
    messageId: 'm1',
    itemId: `video:url:${String(count).padStart(16, '0')}`,
    kind: 'link',
    url,
    site,
    name: 'A title',
    durationSec: null,
  };
}

function describerWith(proxy: () => string | null) {
  const videoFetcher = fakeVideoFetcher({ probe: { ok: true, durationSec: 125, title: null } });
  const describer = createDescriber({
    hot,
    store: createStore(memoryAt(dataDir())),
    llm: fakeLlm({ text: 'someone dances' }),
    imageFetcher: fakeImageFetcher(),
    videoFetcher,
    state: fakeState(),
    proxy,
  });
  return { describer, videoFetcher };
}

const SITES: Array<[string, string]> = [
  ['https://www.youtube.com/watch?v=abc', 'youtube.com'],
  ['https://www.tiktok.com/@a/video/1', 'tiktok.com'],
  ['https://vk.com/video-1_2', 'vk.com'],
];

test('every video site goes through the engine proxy while it is in force, whatever the old site list says', async () => {
  // Catches: only YouTube goes through the proxy, as under `media.video.proxySites`, and TikTok shows the server's address.
  for (const [url, site] of SITES) {
    const { describer, videoFetcher } = describerWith(() => PROXY);
    await describer.describeVideo('g1', link(url, site));
    assert.deepEqual(
      videoFetcher.calls.map((call) => call.fn),
      ['probeSite', 'fetchSiteClip'],
      url
    );
    for (const call of videoFetcher.calls) assert.equal(call.options.proxy, PROXY, `${call.fn} ${url}`);
  }
});

test('with the engine direct, yt-dlp runs with no proxy', async () => {
  // Catches: the describer keeps a proxy it read at start, so downloads fail on the dead proxy after the switch.
  const { describer, videoFetcher } = describerWith(() => null);
  await describer.describeVideo('g1', link('https://www.youtube.com/watch?v=abc', 'youtube.com'));
  for (const call of videoFetcher.calls) assert.equal(call.options.proxy, null, call.fn);
});

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
