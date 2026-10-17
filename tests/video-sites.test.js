// Tests for src/media/video-sites.js: site matching, URL extraction, the
// stable cache key, the yt-dlp / ffmpeg argument arrays, probe parsing and
// the query-free log location.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  videoSiteFor,
  extractVideoUrls,
  videoUrlCacheKey,
  ytdlpClipArgs,
  ffmpegTrimArgs,
  ffmpegFitArgs,
  fitBitrate,
  ytdlpProbeArgs,
  proxyFor,
  ffmpegGifArgs,
  parseProbe,
  safeLocation,
  youtubeVideoId,
  publicVideoUrl,
  parseYoutubePageDuration,
  parseIsoDuration,
  parseYoutubeDataApi,
  bareContentType,
} from '../src/media/video-sites.js';

const SITES = ['youtube.com', 'youtu.be', 'tiktok.com', 'vk.com', 'vkvideo.ru', 'x.com', 'twitter.com', 'reddit.com', 'twitch.tv'];

test('videoSiteFor: matches the exact host and any subdomain, case-insensitive', () => {
  assert.equal(videoSiteFor('https://youtube.com/watch?v=abc', SITES), 'youtube.com');
  assert.equal(videoSiteFor('https://www.youtube.com/watch?v=abc', SITES), 'youtube.com');
  assert.equal(videoSiteFor('https://M.YouTube.COM/watch?v=abc', SITES), 'youtube.com');
  assert.equal(videoSiteFor('https://youtu.be/abc', SITES), 'youtu.be');
  assert.equal(videoSiteFor('https://vm.tiktok.com/xyz', SITES), 'tiktok.com');
});

test('videoSiteFor: a look-alike host, an unknown host or an unparsable URL gives null', () => {
  assert.equal(videoSiteFor('https://notyoutube.com/watch?v=abc', SITES), null);
  assert.equal(videoSiteFor('https://youtube.com.evil.example/watch', SITES), null);
  assert.equal(videoSiteFor('https://example.com/video.mp4', SITES), null);
  assert.equal(videoSiteFor('not a url', SITES), null);
  assert.equal(videoSiteFor(undefined, SITES), null);
  assert.equal(videoSiteFor('https://youtube.com/x', undefined), null);
});

test('extractVideoUrls: finds matching http(s) URLs in order, distinct, trailing punctuation stripped', () => {
  const text = 'régarde (https://youtu.be/abc). et https://www.tiktok.com/@a/video/1, puis <https://x.com/u/status/9> '
    + 'aussi https://example.com/v.mp4 et encore https://youtu.be/abc';
  assert.deepEqual(extractVideoUrls(text, SITES), [
    'https://youtu.be/abc',
    'https://www.tiktok.com/@a/video/1',
    'https://x.com/u/status/9',
  ]);
});

test('extractVideoUrls: empty or non-string text gives an empty array; non-http schemes are ignored', () => {
  assert.deepEqual(extractVideoUrls('', SITES), []);
  assert.deepEqual(extractVideoUrls(undefined, SITES), []);
  assert.deepEqual(extractVideoUrls('ftp://youtube.com/x και τίποτα άλλο', SITES), []);
});

test('videoUrlCacheKey: stable across www./m., host case and tracking params; keeps only v', () => {
  const a = videoUrlCacheKey('https://www.youtube.com/watch?v=abc123&t=42&list=PL1&si=zzz');
  const b = videoUrlCacheKey('https://m.YouTube.com/watch?si=other&v=abc123');
  const c = videoUrlCacheKey('https://youtube.com/watch?v=abc123');
  assert.equal(a, b);
  assert.equal(a, c);
  assert.match(a, /^video:url:[0-9a-f]{16}$/);
});

test('videoUrlCacheKey: a different video id or path gives a different key', () => {
  assert.notEqual(videoUrlCacheKey('https://youtube.com/watch?v=abc'), videoUrlCacheKey('https://youtube.com/watch?v=abd'));
  assert.notEqual(videoUrlCacheKey('https://youtu.be/abc'), videoUrlCacheKey('https://youtu.be/abd'));
  assert.equal(videoUrlCacheKey('https://youtu.be/abc?si=1'), videoUrlCacheKey('https://www.youtu.be/abc?utm_source=x'));
});

test('videoUrlCacheKey: every YouTube form of one video maps to the canonical watch?v= key', () => {
  const canonical = videoUrlCacheKey('https://youtube.com/watch?v=abc123');
  for (const url of [
    'https://youtu.be/abc123',
    'https://youtu.be/abc123?si=tracking&t=10',
    'https://www.youtube.com/watch?v=abc123&feature=share',
    'https://m.youtube.com/watch?v=abc123',
    'https://youtube.com/shorts/abc123',
    'https://www.youtube.com/shorts/abc123?si=x',
    'https://m.youtube.com/shorts/abc123',
    'https://www.youtube.com/embed/abc123',
    'https://youtube.com/embed/abc123?start=5',
    'https://www.youtube.com/live/abc123',
    'https://m.youtube.com/live/abc123?si=y',
  ]) {
    assert.equal(videoUrlCacheKey(url), canonical, url);
  }
  assert.notEqual(videoUrlCacheKey('https://youtube.com/shorts/abc124'), canonical);
});

test('videoUrlCacheKey: TikTok short links keep their own key (no id to extract)', () => {
  const vm = videoUrlCacheKey('https://vm.tiktok.com/ZMabc/');
  const vt = videoUrlCacheKey('https://vt.tiktok.com/ZMabc/');
  assert.match(vm, /^video:url:[0-9a-f]{16}$/);
  assert.notEqual(vm, vt);
  assert.notEqual(vm, videoUrlCacheKey('https://www.tiktok.com/@a/video/1'));
  assert.equal(vm, videoUrlCacheKey('https://vm.tiktok.com/ZMabc/?utm=x'));
});

test('videoUrlCacheKey: an unparsable URL still yields a well-formed key', () => {
  assert.match(videoUrlCacheKey('not a url'), /^video:url:[0-9a-f]{16}$/);
});

const CLIP = { ytdlpPath: '/opt/yt-dlp', maxSeconds: 60, maxFileSize: 8_000_000, outPath: '/tmp/d/clip.mp4' };
const FORMAT =
  'bv*[height<=360]+ba/b[height<=360]/b[height<=720][vcodec^=h264]/b[width<=720][vcodec^=h264]/b[height<=720][vcodec^=avc]/b[width<=720][vcodec^=avc]/w';

test('ytdlpClipArgs: a long or unknown video is cut to its first maxSeconds, one element per token', () => {
  const out = ytdlpClipArgs('https://youtu.be/abc', { ...CLIP, ffmpegPath: '/usr/bin/ffmpeg', durationSec: 125 });
  assert.deepEqual(out, {
    command: '/opt/yt-dlp',
    args: [
      '--no-playlist', '--no-warnings', '--quiet',
      '--ffmpeg-location', '/usr/bin/ffmpeg',
      '-f', FORMAT,
      '--merge-output-format', 'mp4',
      '--download-sections', '*0-60',
      '--force-keyframes-at-cuts',
      '--max-filesize', '8000000',
      '-o', '/tmp/d/clip.mp4',
      '--',
      'https://youtu.be/abc',
    ],
  });
});

test('ytdlpClipArgs: a null or missing duration keeps the cut', () => {
  for (const durationSec of [null, undefined, Number.NaN]) {
    const { args } = ytdlpClipArgs('https://youtu.be/abc', { ...CLIP, ffmpegPath: '/usr/bin/ffmpeg', durationSec });
    assert.equal(args[args.indexOf('--download-sections') + 1], '*0-60');
    assert.ok(args.includes('--force-keyframes-at-cuts'));
  }
});

test('ytdlpClipArgs: a video no longer than maxSeconds is downloaded whole, without a cut', () => {
  for (const durationSec of [14, 60]) {
    const out = ytdlpClipArgs('https://youtu.be/abc', { ...CLIP, ffmpegPath: '/usr/bin/ffmpeg', durationSec });
    assert.deepEqual(out, {
      command: '/opt/yt-dlp',
      args: [
        '--no-playlist', '--no-warnings', '--quiet',
        '--ffmpeg-location', '/usr/bin/ffmpeg',
        '-f', FORMAT,
        '--merge-output-format', 'mp4',
        '--max-filesize', '8000000',
        '-o', '/tmp/d/clip.mp4',
        '--',
        'https://youtu.be/abc',
      ],
    });
  }
});

test('ytdlpClipArgs: a bare ffmpeg name omits --ffmpeg-location so yt-dlp searches PATH', () => {
  const { args } = ytdlpClipArgs('https://youtu.be/abc', { ...CLIP, ffmpegPath: 'ffmpeg', durationSec: null });
  assert.equal(args.includes('--ffmpeg-location'), false);
  assert.equal(args.includes('ffmpeg'), false);
  assert.equal(args[args.indexOf('--download-sections') + 1], '*0-60');
  const short = ytdlpClipArgs('https://youtu.be/abc', { ...CLIP, ffmpegPath: 'ffmpeg', durationSec: 14 }).args;
  assert.deepEqual(short, [
    '--no-playlist', '--no-warnings', '--quiet',
    '-f', FORMAT,
    '--merge-output-format', 'mp4',
    '--max-filesize', '8000000',
    '-o', '/tmp/d/clip.mp4',
    '--',
    'https://youtu.be/abc',
  ]);
});

test('ffmpegGifArgs: a GIF becomes a short, even-sided, never upscaled yuv420p H.264 clip without audio', () => {
  assert.deepEqual(ffmpegGifArgs('/tmp/in', '/tmp/out.mp4', { ffmpegPath: '/usr/bin/ffmpeg', maxSeconds: 8 }), {
    command: '/usr/bin/ffmpeg',
    args: [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', '/tmp/in',
      '-t', '8',
      '-vf', "scale=-2:'min(360,trunc(ih/2)*2)'",
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
      '-maxrate', '400k', '-bufsize', '800k',
      '-an',
      '-movflags', '+faststart',
      '/tmp/out.mp4',
    ],
  });
});

test('fitBitrate + ffmpegFitArgs: a shipped-length fit re-encode stays within the shipped maxBytes, and that under the 20 MB body limit once base64', () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const { maxSeconds, maxBytes } = shipped.media.video;
  const { videoKbps, audioKbps } = fitBitrate({ maxBytes, seconds: maxSeconds });
  const { args } = ffmpegFitArgs('/tmp/in.webm', '/tmp/out.mp4', { ffmpegPath: 'ffmpeg', maxSeconds, videoKbps, audioKbps });
  const kbps = (flag) => Number(String(args[args.indexOf(flag) + 1]).replace(/k$/, ''));
  const bytes = ((kbps('-maxrate') + kbps('-b:a')) * 1000 / 8) * maxSeconds;
  assert.ok(bytes < maxBytes, `${bytes} bytes for ${maxSeconds} s`);
  assert.ok(Math.ceil(maxBytes / 3) * 4 < 20_000_000, 'the inlined clip fits the provider body limit');
});

test('ffmpegTrimArgs: the first maxSeconds at 360p, CRF 28 under a 400k ceiling, 96k audio', () => {
  assert.deepEqual(ffmpegTrimArgs('/tmp/in', '/tmp/small.mp4', { ffmpegPath: 'ffmpeg', maxSeconds: 300 }).args, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', '/tmp/in',
    '-t', '300',
    '-vf', 'scale=-2:360',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
    '-maxrate', '400k', '-bufsize', '800k',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart',
    '/tmp/small.mp4',
  ]);
});

test('fitBitrate: video gets what maxBytes leaves after 10 % headroom and 48k audio, between 100k and 400k', () => {
  // 14.5 MB over 300 s: 14.5e6 * 8 * 0.9 / 300 / 1000 = 348 kbps, minus 48 for audio.
  assert.deepEqual(fitBitrate({ maxBytes: 14_500_000, seconds: 300 }), { videoKbps: 300, audioKbps: 48 });
  assert.deepEqual(fitBitrate({ maxBytes: 14_500_000, seconds: 60 }), { videoKbps: 400, audioKbps: 48 });
  assert.deepEqual(fitBitrate({ maxBytes: 1000, seconds: 60 }), { videoKbps: 100, audioKbps: 48 });
  assert.deepEqual(fitBitrate({ maxBytes: 14_500_000, seconds: 0 }), { videoKbps: 100, audioKbps: 48 });
});

test('ffmpegFitArgs: the trim at fixed bitrates instead of CRF', () => {
  assert.deepEqual(ffmpegFitArgs('/tmp/in', '/tmp/fit.mp4', { ffmpegPath: '/usr/bin/ffmpeg', maxSeconds: 300, videoKbps: 250, audioKbps: 48 }), {
    command: '/usr/bin/ffmpeg',
    args: [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', '/tmp/in',
      '-t', '300',
      '-vf', 'scale=-2:360',
      '-c:v', 'libx264', '-preset', 'veryfast',
      '-b:v', '250k', '-maxrate', '250k', '-bufsize', '500k',
      '-c:a', 'aac', '-b:a', '48k',
      '-movflags', '+faststart',
      '/tmp/fit.mp4',
    ],
  });
});

test('parseProbe: reads duration and title; tolerates missing fields and bad JSON', () => {
  assert.deepEqual(parseProbe(JSON.stringify({ duration: 42.5, title: 'Ἀρχή καὶ τέλος' })), { durationSec: 42.5, title: 'Ἀρχή καὶ τέλος' });
  assert.deepEqual(parseProbe(JSON.stringify({ id: 'x' })), { durationSec: null, title: null });
  assert.deepEqual(parseProbe(JSON.stringify({ duration: 'long', title: 7 })), { durationSec: null, title: null });
  assert.deepEqual(parseProbe('{not json'), { durationSec: null, title: null });
  assert.deepEqual(parseProbe('null'), { durationSec: null, title: null });
  assert.deepEqual(parseProbe(undefined), { durationSec: null, title: null });
});

test('parseProbe: a zero or negative duration is a live stream, not a length', () => {
  assert.deepEqual(parseProbe(JSON.stringify({ duration: 0, title: 'ζωντανά' })), { durationSec: null, title: 'ζωντανά' });
  assert.deepEqual(parseProbe(JSON.stringify({ duration: -3 })), { durationSec: null, title: null });
});

test('bareContentType: type/subtype in lowercase, parameters dropped; missing -> empty', () => {
  assert.equal(bareContentType('Image/PNG; charset=binary'), 'image/png');
  assert.equal(bareContentType(' video/mp4 '), 'video/mp4');
  assert.equal(bareContentType(null), '');
  assert.equal(bareContentType(undefined), '');
});

test('safeLocation: host and path only, never the query string', () => {
  assert.equal(safeLocation('https://www.youtube.com/watch?v=abc&token=secret'), 'www.youtube.com/watch');
  assert.equal(safeLocation('nonsense'), '(unparsable url)');
});

// --- YouTube duration without yt-dlp ---------------------------------------

test('youtubeVideoId: every YouTube form canonicalised by the cache key gives the id', () => {
  for (const url of [
    'https://youtu.be/dQw4w9WgXcQ?si=track',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
  ]) {
    assert.equal(youtubeVideoId(url), 'dQw4w9WgXcQ', url);
  }
});

test('publicVideoUrl: a YouTube watch link loses its playlist, timestamp and tracking params', () => {
  assert.equal(
    publicVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=OLAK5uy_abc&index=2&t=42&si=track&pp=xyz'),
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  );
});

test('publicVideoUrl: youtu.be, shorts, embed, live and m. links become the canonical watch URL', () => {
  for (const url of [
    'https://youtu.be/dQw4w9WgXcQ?si=track',
    'https://youtube.com/shorts/dQw4w9WgXcQ?feature=share',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ?si=x',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1',
  ]) {
    assert.equal(publicVideoUrl(url), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', url);
  }
});

test('publicVideoUrl: a non-YouTube link, a YouTube page without an id or garbage comes back unchanged', () => {
  for (const url of [
    'https://www.tiktok.com/@someone/video/123?is_from_webapp=1',
    'https://notyoutube.com/watch?v=abc&list=x',
    'https://www.youtube.com/@channel',
    'not a url',
  ]) {
    assert.equal(publicVideoUrl(url), url);
  }
});

test('youtubeVideoId: a non-YouTube URL, a YouTube page without an id or garbage gives null', () => {
  assert.equal(youtubeVideoId('https://www.tiktok.com/@someone/video/123'), null);
  assert.equal(youtubeVideoId('https://notyoutube.com/watch?v=abc'), null);
  assert.equal(youtubeVideoId('https://www.youtube.com/@channel'), null);
  assert.equal(youtubeVideoId('https://www.youtube.com/watch'), null);
  assert.equal(youtubeVideoId('not a url'), null);
  assert.equal(youtubeVideoId(undefined), null);
});

test('parseIsoDuration: hours, minutes and seconds in any combination', () => {
  assert.equal(parseIsoDuration('PT3M34S'), 214);
  assert.equal(parseIsoDuration('PT1H'), 3600);
  assert.equal(parseIsoDuration('PT45S'), 45);
  assert.equal(parseIsoDuration('PT1H2M3S'), 3723);
  assert.equal(parseIsoDuration('PT10M'), 600);
  assert.equal(parseIsoDuration('P1DT1S'), 86401);
  assert.equal(parseIsoDuration('PT1.5S'), 2, 'fractional seconds round up');
  assert.equal(parseIsoDuration('P0D'), 0);
});

test('parseIsoDuration: garbage gives null', () => {
  for (const text of ['', 'PT', 'P', '3M34S', 'PT3X', 'PTMS', 'pt3m', 'PT3M34S extra', null, undefined, 214]) {
    assert.equal(parseIsoDuration(text), null, JSON.stringify(text));
  }
});

test('parseYoutubePageDuration: lengthSeconds first', () => {
  const html = '<script>var x = {"videoDetails":{"videoId":"abc","lengthSeconds":"214","approxDurationMs":"999000"}};</script>';
  assert.equal(parseYoutubePageDuration(html), 214);
});

test('parseYoutubePageDuration: approxDurationMs when lengthSeconds is absent, rounded up to whole seconds', () => {
  assert.equal(parseYoutubePageDuration('{"approxDurationMs":"213401","mimeType":"video/mp4"}'), 214);
  assert.equal(parseYoutubePageDuration('{"approxDurationMs":"214000"}'), 214);
});

test('parseYoutubePageDuration: the itemprop duration meta tag as the last resort', () => {
  const html = '<meta itemprop="name" content="Ἡ θάλασσα"><meta itemprop="duration" content="PT3M34S">';
  assert.equal(parseYoutubePageDuration(html), 214);
});

test('parseYoutubePageDuration: nothing usable gives null; a zero length (a live stream) is not a duration', () => {
  assert.equal(parseYoutubePageDuration('<html><body>Before you continue</body></html>'), null);
  assert.equal(parseYoutubePageDuration(''), null);
  assert.equal(parseYoutubePageDuration(undefined), null);
  assert.equal(parseYoutubePageDuration('{"lengthSeconds":"0"}'), null);
  assert.equal(parseYoutubePageDuration('{"lengthSeconds":"0","approxDurationMs":"61000"}'), 61);
  assert.equal(parseYoutubePageDuration('<meta itemprop="duration" content="PT0S">'), null);
  assert.equal(parseYoutubePageDuration('<meta itemprop="duration" content="garbage">'), null);
});

test('parseYoutubeDataApi: the first item contentDetails.duration in seconds', () => {
  const json = JSON.stringify({ kind: 'youtube#videoListResponse', items: [{ id: 'abc', contentDetails: { duration: 'PT3M34S' } }] });
  assert.equal(parseYoutubeDataApi(json), 214);
});

test('parseYoutubeDataApi: no items, a bad duration, a live P0D or invalid JSON gives null', () => {
  assert.equal(parseYoutubeDataApi(JSON.stringify({ items: [] })), null);
  assert.equal(parseYoutubeDataApi(JSON.stringify({})), null);
  assert.equal(parseYoutubeDataApi(JSON.stringify({ items: [{ contentDetails: { duration: 'soon' } }] })), null);
  assert.equal(parseYoutubeDataApi(JSON.stringify({ items: [{ contentDetails: { duration: 'P0D' } }] })), null);
  assert.equal(parseYoutubeDataApi(JSON.stringify({ items: [{ contentDetails: {} }] })), null);
  assert.equal(parseYoutubeDataApi('null'), null);
  assert.equal(parseYoutubeDataApi('{not json'), null);
});

// A URL comes from a chat message: it must never be read as an option of the tool.
test('ytdlpProbeArgs: the URL comes after -- so it is never read as an option', () => {
  const { args } = ytdlpProbeArgs('--exec=evil');
  assert.equal(args.at(-2), '--');
  assert.equal(args.at(-1), '--exec=evil');
});

const PROXY = 'socks5h://usér:pä%40ss@proxy.example:1080';
const PROXY_CFG = { proxy: PROXY, proxySites: ['youtube.com', 'youtu.be'] };

test('proxyFor: a listed site (or its subdomain) gets the proxy, verbatim', () => {
  for (const url of ['https://youtu.be/abc', 'https://www.youtube.com/watch?v=abc', 'https://m.YouTube.com/shorts/x']) {
    assert.equal(proxyFor(url, PROXY_CFG), PROXY, url);
  }
});

test('proxyFor: a site outside proxySites runs direct', () => {
  for (const url of ['https://vk.com/video-1_2', 'https://www.tiktok.com/@a/video/1', 'https://notyoutube.com/x', 'not a url']) {
    assert.equal(proxyFor(url, PROXY_CFG), null, url);
  }
});

test('proxyFor: an empty, missing or non-string proxy, or an empty or missing proxySites, never proxies', () => {
  const url = 'https://youtu.be/abc';
  for (const proxy of ['', undefined, null, 42]) assert.equal(proxyFor(url, { ...PROXY_CFG, proxy }), null);
  for (const proxySites of [[], undefined, null, 'youtube.com']) assert.equal(proxyFor(url, { ...PROXY_CFG, proxySites }), null);
  assert.equal(proxyFor(url, undefined), null);
});

test('ytdlpProbeArgs: a proxy is passed verbatim as --proxy before the URL; none without one', () => {
  const withProxy = ytdlpProbeArgs('https://youtu.be/abc', { ytdlpPath: '/opt/yt-dlp', proxy: PROXY });
  assert.equal(withProxy.command, '/opt/yt-dlp');
  assert.equal(withProxy.args[withProxy.args.indexOf('--proxy') + 1], PROXY);
  assert.ok(withProxy.args.indexOf('--proxy') < withProxy.args.indexOf('--'));
  assert.deepEqual(withProxy.args.slice(-2), ['--', 'https://youtu.be/abc']);
  for (const proxy of [undefined, '', null, 42]) {
    const { args } = ytdlpProbeArgs('https://youtu.be/abc', { ytdlpPath: '/opt/yt-dlp', proxy });
    assert.equal(args.includes('--proxy'), false, `no proxy for ${proxy}`);
  }
});

test('ytdlpClipArgs: with a proxy the video is downloaded whole (no sections cut), ceiling and format kept', () => {
  for (const durationSec of [null, 125, 14]) {
    const out = ytdlpClipArgs('https://youtu.be/abc', { ...CLIP, ffmpegPath: '/usr/bin/ffmpeg', durationSec, proxy: PROXY });
    assert.deepEqual(out, {
      command: '/opt/yt-dlp',
      args: [
        '--no-playlist', '--no-warnings', '--quiet',
        '--proxy', PROXY,
        '--ffmpeg-location', '/usr/bin/ffmpeg',
        '-f', FORMAT,
        '--merge-output-format', 'mp4',
        '--max-filesize', '8000000',
        '-o', '/tmp/d/clip.mp4',
        '--',
        'https://youtu.be/abc',
      ],
    }, `duration ${durationSec}`);
  }
});

test('ytdlpClipArgs: an empty or missing proxy keeps the sections cut and adds no --proxy', () => {
  for (const proxy of [undefined, '']) {
    const { args } = ytdlpClipArgs('https://youtu.be/abc', { ...CLIP, ffmpegPath: 'ffmpeg', durationSec: 125, proxy });
    assert.equal(args.includes('--proxy'), false);
    assert.equal(args[args.indexOf('--download-sections') + 1], '*0-60');
    assert.ok(args.includes('--force-keyframes-at-cuts'));
  }
});
