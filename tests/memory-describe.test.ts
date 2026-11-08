// Tests for src/memory/describe.ts when a media role is off (`models.base.vision` or `models.base.video` is null).
// A picture, sticker, link thumbnail or custom emoji needs the vision role; a GIF or a video needs the video role. An
// item whose role is off is not described: no download, no model request, no cache entry. The turn then tells her
// (tests/turn-ability-route.test.ts). The rest of the describer is in tests/describe.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/memory/store.ts';
import { createDescriber } from '../src/memory/describe.ts';
import { tempDir } from './fixtures/tmp.ts';
import { fakeImageFetcher, fakeLlm, fakeState, fakeVideoFetcher } from './fixtures/describe-fakes.ts';
import { memoryAt } from './fixtures/store-kit.ts';

const loose = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

const VIDEO_CFG = {
  provider: { order: ['pinned'], allow_fallbacks: false },
  maxOutputTokens: 400,
  maxRequestTokens: 60_000,
  timeoutMs: 90_000,
  toolTimeoutMs: 60_000,
  sites: ['youtube.com'],
  ytdlpPath: 'yt-dlp-test',
  ffmpegPath: 'ffmpeg-test',
  errorRetryMinutes: 60,
};

/** A describer over fakes whose `models.base` holds `base`; the fakes record every request and download. */
function rig(base: Record<string, unknown>) {
  const hot = {
    config: {
      models: { base },
      media: { maxOutputTokens: 120, video: VIDEO_CFG },
      context: { vision: { fetchTimeoutMs: 10_000 } },
    },
    prompts: { describe: 'Describe this picture.', 'describe-video': 'Watch this clip and say what happens.' },
  };
  const llm = fakeLlm({ text: 'a described thing' });
  const imageFetcher = fakeImageFetcher();
  const videoFetcher = fakeVideoFetcher();
  const store = createStore(memoryAt(tempDir('nep-describe-off-')));
  const describer = createDescriber({ hot, store, llm, imageFetcher, videoFetcher, state: fakeState() });
  return { describer, llm, imageFetcher, videoFetcher, store };
}

const picture = (itemId: string, kind = 'image', url = 'https://cdn.discordapp.com/x/pic.png') => ({
  itemId,
  kind,
  url,
});

const clip = {
  source: 'attachment',
  messageId: 'm1',
  itemId: 'v1',
  kind: 'video',
  url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4',
  name: 'clip.mp4',
  durationSec: 12,
  bytes: 1000,
};

const ON = { vision: 'x/vision', video: 'x/video' };

// Bug caught: a null vision model read as its default, so a picture is sent to a model the owner never chose.
test('describeMany: a picture with vision off is not downloaded, not sent, and not described', async () => {
  const off = rig({ ...ON, vision: null });
  const { descriptions } = await off.describer.describeMany('g1', [picture('a1')], { maxNew: 5 });
  assert.equal(descriptions.size, 0);
  assert.equal(off.llm.calls.length, 0, 'no model request');
  assert.equal(off.imageFetcher.calls.length, 0, 'no download');
});

// Bug caught: the off check blocking the picture path with vision on (the guard on the other side of the test above).
test('describeMany: the same picture with vision on is described, one request', async () => {
  const on = rig(ON);
  const { descriptions } = await on.describer.describeMany('g1', [picture('a1')], { maxNew: 5 });
  assert.equal(descriptions.get('a1'), 'a described thing');
  assert.equal(on.llm.calls.length, 1);
});

// Bug caught: video off but a GIF still captioned through the vision model's one-frame path.
test('describeMany: a GIF with video off is not described even while vision is on', async () => {
  const off = rig({ ...ON, video: null });
  const gif = picture('g1', 'gif', 'https://cdn.discordapp.com/x/anim.gif');
  const { descriptions } = await off.describer.describeMany('g1', [gif], { maxNew: 5 });
  assert.equal(descriptions.size, 0);
  assert.equal(off.llm.calls.length, 0, 'no model request on either role');
  assert.equal(off.imageFetcher.calls.length + off.videoFetcher.calls.length, 0, 'no download');
});

// Bug caught: the video role's off state also silencing pictures (a GIF is video, a picture is vision).
test('describeMany: a picture is still described while only video is off', async () => {
  const off = rig({ ...ON, video: null });
  const { descriptions } = await off.describer.describeMany('g1', [picture('a1')], { maxNew: 5 });
  assert.equal(descriptions.get('a1'), 'a described thing');
});

// Bug caught: the GIF check keyed on the wrong role, so a GIF with video on is left undescribed.
test('describeMany: a GIF with video on is described', async () => {
  const on = rig(ON);
  const gif = picture('g1', 'gif', 'https://cdn.discordapp.com/x/anim.gif');
  await on.describer.describeMany('g1', [gif], { maxNew: 5 });
  assert.ok(on.llm.calls.length >= 1, 'a request went out');
});

// Bug caught: a clip sent to the video model that is switched off.
test('describeVideos: a video with video off is not fetched, not sent, and not watched', async () => {
  const off = rig({ ...ON, video: null });
  const { videos } = await off.describer.describeVideos('g1', [clip], { maxNew: 5 });
  assert.equal(videos.has('v1'), false);
  assert.equal(off.llm.calls.length, 0);
  assert.equal(off.videoFetcher.calls.length, 0);
});

// Bug caught: the guard of the test above blocking the video path with video on.
test('describeVideos: a video with video on is watched', async () => {
  const on = rig(ON);
  const { videos } = await on.describer.describeVideos('g1', [clip], { maxNew: 5 });
  assert.equal(loose(videos.get('v1')).state, 'watched');
});
