// Tests for src/media/classify.js (pure media classification, label choice and vision picture selection) and for the
// Discord package's media addresses (interfaces/discord/media.js: media-proxy rewriting, stickers, CDN video links).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAttachment,
  formatDurationShort,
  mediaLabelFor,
  stickerLabelFor,
  linkThumbnailCacheKey,
  collectPictures,
  collectEmojiItems,
  collectVideos,
  lateVideoStates,
  collectReadableLinks,
  isDescribable,
  mediaParts,
  siteOf,
  clipWithEllipsis,
  isGifHostUrl,
  fitBox,
  watchedLengths,
} from '../src/media/classify.js';
// The Discord CDN hosts, the media proxy, the sticker address and the CDN video link are the package's.
import { discordCdnVideo, mediaProxyUrl, stickerUrl } from '../interfaces/discord/media.js';

// --- siteOf --------------------------------------------------------------------

test('siteOf: the hostname without a leading www., empty for an unparsable URL', () => {
  assert.equal(siteOf('https://www.example.com/page?x=1'), 'example.com');
  assert.equal(siteOf('https://WWW.Example.com/'), 'example.com');
  assert.equal(siteOf('https://m.youtube.com/watch?v=abc'), 'm.youtube.com');
  assert.equal(siteOf('not a url'), '');
  assert.equal(siteOf(undefined), '');
});

// --- clipWithEllipsis ----------------------------------------------------------

test('clipWithEllipsis: at most maxChars code points, then an ellipsis; short text unchanged', () => {
  assert.equal(clipWithEllipsis('abcdef', 3), 'abc…');
  assert.equal(clipWithEllipsis('abc', 3), 'abc');
  assert.equal(clipWithEllipsis('', 3), '');
  assert.equal(clipWithEllipsis(undefined, 3), '');
  assert.equal(clipWithEllipsis('  padded  ', 20), '  padded  ', 'no trimming: the caller decides');
});

test('clipWithEllipsis: never splits a surrogate pair', () => {
  assert.equal(clipWithEllipsis('αβ😀😀γ', 3), 'αβ😀…');
  assert.equal(clipWithEllipsis('😀😀', 2), '😀😀');
});

test('clipWithEllipsis: a missing, non-finite or non-positive maxChars means no limit', () => {
  for (const maxChars of [undefined, null, 0, -1, Number.NaN, Infinity]) {
    assert.equal(clipWithEllipsis('ἀρχή καὶ τέλος', maxChars), 'ἀρχή καὶ τέλος', String(maxChars));
  }
});

// --- mediaParts ----------------------------------------------------------------

test('mediaParts: the message first, then its forwarded snapshots; none when there are none', () => {
  const a = { attachments: [] };
  const b = { attachments: [] };
  const message = { id: 'm1', forwarded: [a, b] };
  assert.deepEqual(mediaParts(message), [message, a, b]);
  const plain = { id: 'm2' };
  assert.deepEqual(mediaParts(plain), [plain]);
  assert.equal(mediaParts({ id: 'm3', forwarded: 'not a list' }).length, 1);
});

// --- classifyAttachment ------------------------------------------------------

test('classifyAttachment: content types map to their kind', () => {
  assert.equal(classifyAttachment({ contentType: 'image/png', name: 'a.png' }), 'image');
  assert.equal(classifyAttachment({ contentType: 'image/jpeg', name: 'a.jpg' }), 'image');
  assert.equal(classifyAttachment({ contentType: 'image/gif', name: 'a.gif' }), 'gif');
  assert.equal(classifyAttachment({ contentType: 'video/mp4', name: 'a.mp4' }), 'video');
  assert.equal(classifyAttachment({ contentType: 'audio/mpeg', name: 'a.mp3' }), 'audio');
  assert.equal(classifyAttachment({ contentType: 'text/plain', name: 'a.txt' }), 'text');
  assert.equal(classifyAttachment({ contentType: 'application/pdf', name: 'a.pdf' }), 'file');
});

test('classifyAttachment: falls back to the file extension when contentType is missing', () => {
  assert.equal(classifyAttachment({ name: 'clip.gif' }), 'gif');
  assert.equal(classifyAttachment({ name: 'photo.PNG' }), 'image');
  assert.equal(classifyAttachment({ name: 'movie.webm' }), 'video');
  assert.equal(classifyAttachment({ name: 'notes.md' }), 'text');
  assert.equal(classifyAttachment({ contentType: 'application/javascript', name: 'logic.js' }), 'text');
  assert.equal(classifyAttachment({ name: 'archive.zip' }), 'file');
  assert.equal(classifyAttachment({ name: null }), 'file');
});

test('classifyAttachment: a voice-message flag wins over content type; without it audio stays audio', () => {
  const rows = [
    { label: 'a voice-message flag wins over content type', isVoice: true, expected: 'voice' },
    { label: 'no voice flag keeps audio as audio', isVoice: false, expected: 'audio' },
  ];
  for (const { label, isVoice, expected } of rows) {
    assert.equal(classifyAttachment({ contentType: 'audio/ogg', name: 'voice.ogg', isVoice }), expected, label);
  }
});

test('isGifHostUrl: tenor, giphy and klipy pages and their media hosts; nothing else', () => {
  for (const url of [
    'https://tenor.com/view/x',
    'https://www.tenor.com/view/x',
    'https://giphy.com/gifs/x',
    'https://media.giphy.com/media/abc/giphy.gif',
    'https://klipy.com/gifs/dancing-cat',
    'https://static.klipy.com/x/loop.mp4',
  ]) {
    assert.equal(isGifHostUrl(url), true, url);
  }
  for (const url of [
    'https://example.com/klipy.com',
    'https://notklipy.com/gifs/x',
    'https://youtube.com/watch?v=1',
    'not a url',
    undefined,
  ]) {
    assert.equal(isGifHostUrl(url), false, String(url));
  }
});

// --- formatDurationShort ------------------------------------------------------

test('formatDurationShort: renders m:ss, zero-padded seconds', () => {
  assert.equal(formatDurationShort(5), '0:05');
  assert.equal(formatDurationShort(65), '1:05');
  assert.equal(formatDurationShort(600), '10:00');
});

test('formatDurationShort: negative/garbage input never goes negative', () => {
  assert.equal(formatDurationShort(-5), '0:00');
  assert.equal(formatDurationShort(NaN), '0:00');
  assert.equal(formatDurationShort(undefined), '0:00');
});

// --- mediaProxyUrl -------------------------------------------------------------

// cdn.discordapp.com measurably ignores width/height/format and serves the
// original file (a full-size image, or for a video the whole file) --
// media.discordapp.net is the host that actually resizes/reformats. A
// realistic signed URL (ex/is/hm) is used throughout so the fix is proven
// against the real shape, not a simplified fixture.
const SIGNED_QUERY = 'ex=671f1a00&is=671dc880&hm=abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890&';

test('mediaProxyUrl: a cdn.discordapp.com attachment URL is rewritten to media.discordapp.net, signed params survive', () => {
  const url = mediaProxyUrl(`https://cdn.discordapp.com/attachments/111/222/pic.png?${SIGNED_QUERY}`, {
    width: 512,
    height: 512,
    format: 'webp',
  });
  const parsed = new URL(url);
  assert.equal(parsed.hostname, 'media.discordapp.net');
  assert.equal(parsed.pathname, '/attachments/111/222/pic.png');
  assert.equal(parsed.searchParams.get('width'), '512');
  assert.equal(parsed.searchParams.get('height'), '512');
  assert.equal(parsed.searchParams.get('format'), 'webp');
  assert.equal(parsed.searchParams.get('ex'), '671f1a00');
  assert.equal(parsed.searchParams.get('is'), '671dc880');
  assert.equal(parsed.searchParams.get('hm'), 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
});

test('mediaProxyUrl: an already-media.discordapp.net URL keeps that host, params still set', () => {
  const url = mediaProxyUrl(`https://media.discordapp.net/attachments/1/2/pic.png?${SIGNED_QUERY}`, { width: 256 });
  const parsed = new URL(url);
  assert.equal(parsed.hostname, 'media.discordapp.net');
  assert.equal(parsed.searchParams.get('width'), '256');
  assert.equal(parsed.searchParams.get('ex'), '671f1a00');
});

test('mediaProxyUrl: replaces existing width/height/format instead of duplicating them, on either host', () => {
  const url = mediaProxyUrl(`https://cdn.discordapp.com/x/pic.png?width=100&height=100&format=jpeg&${SIGNED_QUERY}`, {
    width: 512,
    height: 512,
    format: 'webp',
  });
  const parsed = new URL(url);
  assert.equal(parsed.hostname, 'media.discordapp.net');
  assert.equal(parsed.searchParams.get('width'), '512');
  assert.equal(parsed.searchParams.get('height'), '512');
  assert.equal(parsed.searchParams.get('format'), 'webp');
  assert.equal(parsed.searchParams.get('ex'), '671f1a00', 'unrelated existing query params survive');
  assert.equal([...parsed.searchParams.keys()].filter((k) => k === 'width').length, 1, 'no duplicate keys');
});

test('mediaProxyUrl: animated: false asks the proxy for a single still frame, replacing an existing value', () => {
  const url = mediaProxyUrl(`https://cdn.discordapp.com/attachments/1/2/anim.gif?animated=true&${SIGNED_QUERY}`, {
    width: 512,
    height: 512,
    format: 'png',
    animated: false,
  });
  const parsed = new URL(url);
  assert.equal(parsed.hostname, 'media.discordapp.net');
  assert.equal(parsed.searchParams.get('format'), 'png');
  assert.equal(parsed.searchParams.get('animated'), 'false');
  assert.equal(parsed.searchParams.getAll('animated').length, 1, 'no duplicate keys');
  assert.equal(parsed.searchParams.get('ex'), '671f1a00');
});

test('mediaProxyUrl: without the animated option no animated param is added', () => {
  const url = mediaProxyUrl(`https://cdn.discordapp.com/x/pic.png?${SIGNED_QUERY}`, { width: 512, format: 'webp' });
  assert.equal(new URL(url).searchParams.has('animated'), false);
});

test('mediaProxyUrl: an images-ext-<n>.discordapp.net URL keeps its host and path, parameters appended to the existing query', () => {
  const original = 'https://images-ext-1.discordapp.net/external/abc123/https/media.tenor.com/x/anim.gif?ex=1&is=2';
  const url = mediaProxyUrl(original, { width: 512, height: 512, format: 'png', animated: false });
  const parsed = new URL(url);
  assert.equal(parsed.hostname, 'images-ext-1.discordapp.net');
  assert.equal(parsed.pathname, '/external/abc123/https/media.tenor.com/x/anim.gif');
  assert.equal(url, `${original}&width=512&height=512&format=png&animated=false`);
});

test('mediaProxyUrl: any images-ext-<n> number is rewritten, a lookalike host is not', () => {
  const url = mediaProxyUrl('https://images-ext-12.discordapp.net/external/x/pic.png', { format: 'webp' });
  assert.equal(new URL(url).searchParams.get('format'), 'webp');
  const lookalike = 'https://images-ext-1.discordapp.net.example.com/external/x/pic.png';
  assert.equal(mediaProxyUrl(lookalike, { format: 'webp' }), lookalike);
  const noNumber = 'https://images-ext-.discordapp.net/external/x/pic.png';
  assert.equal(mediaProxyUrl(noNumber, { format: 'webp' }), noNumber);
});

test('mediaProxyUrl: a non-Discord host is returned untouched', () => {
  const url = 'https://example.com/pic.png?foo=bar';
  assert.equal(mediaProxyUrl(url, { width: 512, height: 512, format: 'webp' }), url);
});

test('mediaProxyUrl: an unparsable URL is returned as-is instead of throwing', () => {
  assert.equal(mediaProxyUrl('not a url', { width: 10 }), 'not a url');
});

// --- mediaLabelFor -------------------------------------------------------------

test('mediaLabelFor: a link thumbnail description appends thumbnailDescribed, the link tag itself never swaps', () => {
  const item = { kind: 'link', site: 's', title: 't', thumbnailUrl: 'https://x/y.jpg' };
  assert.deepEqual(mediaLabelFor(item, { description: 'a video preview' }), {
    key: 'link',
    values: { site: 's', title: 't' },
    extra: { key: 'thumbnailDescribed', values: { text: 'a video preview' } },
  });
});

test('mediaLabelFor: image blind vs described', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'image' }), { key: 'image', values: {} });
  assert.deepEqual(mediaLabelFor({ kind: 'image' }, { description: 'a cat' }), {
    key: 'imageDescribed',
    values: { text: 'a cat' },
  });
});

test('mediaLabelFor: gif blind uses the name, described uses only the text', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'gif', name: 'cat.gif' }), { key: 'gif', values: { name: 'cat.gif' } });
  assert.deepEqual(mediaLabelFor({ kind: 'gif' }, { description: 'a cat dancing' }), {
    key: 'gifDescribed',
    values: { text: 'a cat dancing' },
  });
});

test('mediaLabelFor: video blind/described carry name + duration, described adds text', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'video', name: 'clip.mp4', durationSec: 65 }), {
    key: 'video',
    values: { name: 'clip.mp4', duration: '1:05' },
  });
  assert.deepEqual(mediaLabelFor({ kind: 'video', name: 'clip.mp4', durationSec: 65 }, { description: 'a dog runs' }), {
    key: 'videoDescribed',
    values: { name: 'clip.mp4', duration: '1:05', text: 'a dog runs' },
  });
});

test('mediaLabelFor: voice/audio render their duration', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'voice', durationSec: 5 }), { key: 'voice', values: { duration: '0:05' } });
  assert.deepEqual(mediaLabelFor({ kind: 'audio', name: 'song.mp3', durationSec: 130 }), {
    key: 'audio',
    values: { name: 'song.mp3', duration: '2:10' },
  });
});

test('mediaLabelFor: a missing duration never renders "0:00" -- falls back to unknownDuration (default "?")', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'video', name: 'clip.mp4' }), {
    key: 'video',
    values: { name: 'clip.mp4', duration: '?' },
  });
  assert.deepEqual(mediaLabelFor({ kind: 'voice' }), { key: 'voice', values: { duration: '?' } });
  assert.deepEqual(mediaLabelFor({ kind: 'audio', name: 'song.mp3' }), {
    key: 'audio',
    values: { name: 'song.mp3', duration: '?' },
  });
});

test('mediaLabelFor: a missing duration uses the caller-supplied unknownDuration text', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'video', name: 'clip.mp4' }, { unknownDuration: 'unknown length' }), {
    key: 'video',
    values: { name: 'clip.mp4', duration: 'unknown length' },
  });
});

test('mediaLabelFor: a durationSec of 0 is a KNOWN zero-length duration, not "unknown"', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'voice', durationSec: 0 }), { key: 'voice', values: { duration: '0:00' } });
});

test('mediaLabelFor: a text attachment uses filePreview once fetched, else the plain file form', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'text', name: 'notes.txt' }), { key: 'file', values: { name: 'notes.txt' } });
  assert.deepEqual(mediaLabelFor({ kind: 'text', name: 'notes.txt', previewText: 'hello world' }), {
    key: 'filePreview',
    values: { name: 'notes.txt', text: 'hello world' },
  });
});

test('mediaLabelFor: a link with description text uses linkText, else link', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'link', site: 's', title: 't' }), {
    key: 'link',
    values: { site: 's', title: 't' },
  });
  assert.deepEqual(mediaLabelFor({ kind: 'link', site: 's', title: 't', text: 'd' }), {
    key: 'linkText',
    values: { site: 's', title: 't', text: 'd' },
  });
});

// --- mediaLabelFor: video states -----------------------------------------------

const clip = { kind: 'video', name: 'clip.mp4', durationSec: 65 };

test('mediaLabelFor: a watched video renders videoWatched with name, duration and the watch text', () => {
  assert.deepEqual(mediaLabelFor(clip, { video: { state: 'watched', text: 'a dog runs' } }), {
    key: 'videoWatched',
    values: { name: 'clip.mp4', duration: '1:05', text: 'a dog runs' },
  });
});

test('mediaLabelFor: a video watched only in part renders videoWatchedPart with the watched length and the reason code', () => {
  const long = { kind: 'video', name: 'long.mp4', durationSec: 400 };
  assert.deepEqual(mediaLabelFor(long, { video: { state: 'watched', text: 'a talk', watchedSeconds: 300 } }), {
    key: 'videoWatchedPart',
    values: { name: 'long.mp4', duration: '6:40', watched: '5:00', reason: 'clip', text: 'a talk' },
  });
  // Watched whole, an unknown total, or an old cache entry without watchedSeconds: the plain form.
  for (const [item, video] of [
    [long, { state: 'watched', text: 'a talk', watchedSeconds: 400 }],
    [
      { ...long, durationSec: 300.4 },
      { state: 'watched', text: 'a talk', watchedSeconds: 300 },
    ],
    [
      { ...long, durationSec: null },
      { state: 'watched', text: 'a talk', watchedSeconds: 300 },
    ],
    [long, { state: 'watched', text: 'a talk' }],
  ]) {
    assert.equal(mediaLabelFor(item, { video }).key, 'videoWatched');
  }
});

test('mediaLabelFor: a watched video wins over a still-frame description', () => {
  const result = mediaLabelFor(clip, { description: 'one frame', video: { state: 'watched', text: 'the whole clip' } });
  assert.equal(result.key, 'videoWatched');
  assert.equal(result.values.text, 'the whole clip');
});

test('mediaLabelFor: a video not watched but with a still-frame caption renders videoNotWatchedFrame', () => {
  assert.deepEqual(mediaLabelFor(clip, { description: 'a café terrace', video: { state: 'limit', reason: 'size' } }), {
    key: 'videoNotWatchedFrame',
    values: { name: 'clip.mp4', duration: '1:05', reason: 'size', text: 'a café terrace' },
  });
});

test('mediaLabelFor: a pending video (its watch missed the deadline) renders not watched with the pending reason', () => {
  assert.deepEqual(mediaLabelFor(clip, { description: 'a café terrace', video: { state: 'pending' } }), {
    key: 'videoNotWatchedFrame',
    values: { name: 'clip.mp4', duration: '1:05', reason: 'pending', text: 'a café terrace' },
  });
  assert.deepEqual(mediaLabelFor(clip, { video: { state: 'pending' } }), {
    key: 'videoNotWatched',
    values: { name: 'clip.mp4', duration: '1:05', reason: 'pending' },
  });
  const item = { kind: 'link', site: 's', title: 't' };
  assert.deepEqual(mediaLabelFor(item, { video: { state: 'pending' } }), {
    key: 'link',
    values: { site: 's', title: 't' },
    extra: { key: 'linkNotWatched', values: { reason: 'pending' } },
  });
});

test('mediaLabelFor: a watched link keeps its link tag, the one extra becomes linkWatched', () => {
  const item = { kind: 'link', site: 's', title: 't', thumbnailUrl: 'https://x/y.jpg' };
  assert.deepEqual(mediaLabelFor(item, { description: 'thumb', video: { state: 'watched', text: 'a talk' } }), {
    key: 'link',
    values: { site: 's', title: 't' },
    extra: { key: 'linkWatched', values: { text: 'a talk' } },
  });
});

test('mediaLabelFor: a link watched only in part renders linkWatchedPart from the stored total; whole or old entries keep linkWatched', () => {
  const item = { kind: 'link', site: 's', title: 't', durationSec: null };
  assert.deepEqual(
    mediaLabelFor(item, { video: { state: 'watched', text: 'a talk', watchedSeconds: 300, totalSeconds: 3289 } }).extra,
    {
      key: 'linkWatchedPart',
      values: { duration: '54:49', watched: '5:00', reason: 'clip', text: 'a talk' },
    }
  );
  // The item's own duration stands in when the state carries no total.
  assert.equal(
    mediaLabelFor({ ...item, durationSec: 400 }, { video: { state: 'watched', text: 'a talk', watchedSeconds: 300 } })
      .extra.key,
    'linkWatchedPart'
  );
  for (const video of [
    { state: 'watched', text: 'a talk', watchedSeconds: 42, totalSeconds: 42 },
    { state: 'watched', text: 'a talk', watchedSeconds: 300 },
    { state: 'watched', text: 'a talk' },
  ]) {
    assert.deepEqual(mediaLabelFor(item, { video }).extra, { key: 'linkWatched', values: { text: 'a talk' } });
  }
});

test('watchedLengths: the finite watchedSeconds / totalSeconds of a cache entry, nothing for an old entry', () => {
  assert.deepEqual(watchedLengths({ text: 'x', watched: true, watchedSeconds: 300, totalSeconds: 3289 }), {
    watchedSeconds: 300,
    totalSeconds: 3289,
  });
  assert.deepEqual(watchedLengths({ text: 'x', watched: true, watchedSeconds: 'long', totalSeconds: null }), {});
  assert.deepEqual(watchedLengths(undefined), {});
});

test('mediaLabelFor: a link not watched with a thumbnail caption renders linkNotWatchedFrame', () => {
  const item = { kind: 'link', site: 's', title: 't', text: 'd', thumbnailUrl: 'https://x/y.jpg' };
  assert.deepEqual(mediaLabelFor(item, { description: 'a stage', video: { state: 'limit', reason: 'length' } }), {
    key: 'linkText',
    values: { site: 's', title: 't', text: 'd' },
    extra: { key: 'linkNotWatchedFrame', values: { reason: 'length', text: 'a stage' } },
  });
});

test('mediaLabelFor: a link not watched without a caption renders linkNotWatched (a text-only link included)', () => {
  const item = { kind: 'link', site: 'youtube.com', title: '', thumbnailUrl: null };
  assert.deepEqual(mediaLabelFor(item, { video: { state: 'error' } }), {
    key: 'link',
    values: { site: 'youtube.com', title: '' },
    extra: { key: 'linkNotWatched', values: { reason: 'error' } },
  });
});

test('mediaLabelFor: other kinds ignore a video state', () => {
  const video = { state: 'watched', text: 'x' };
  assert.deepEqual(mediaLabelFor({ kind: 'image' }, { video }), { key: 'image', values: {} });
  assert.deepEqual(mediaLabelFor({ kind: 'gif', name: 'cat.gif' }, { video }), {
    key: 'gif',
    values: { name: 'cat.gif' },
  });
  assert.deepEqual(mediaLabelFor({ kind: 'audio', name: 'a.mp3', durationSec: 5 }, { video }), {
    key: 'audio',
    values: { name: 'a.mp3', duration: '0:05' },
  });
});

// --- collectVideos ---------------------------------------------------------------

function videoMessage() {
  return {
    id: 'm1',
    attachments: [
      { id: 'a1', kind: 'image', url: 'u1', name: 'a.png', size: 10 },
      { id: 'a2', kind: 'video', url: 'u2', name: 'ταξίδι.mp4', size: 2048, durationSec: 12 },
      { id: 'a3', kind: 'gif', url: 'u3', name: 'a.gif', size: 5 },
    ],
    links: [
      {
        id: 'link:aaaa',
        kind: 'link',
        url: 'https://www.youtube.com/watch?v=abc',
        site: 'YouTube',
        title: 'Cool video',
      },
      { id: 'm1#e1', kind: 'link', url: 'https://example.com/page', site: 'example.com', title: 'A page' },
      { id: 'video:url:bbbb', kind: 'link', url: 'https://youtu.be/xyz', site: 'youtu.be', title: '' },
      { id: 'm1#e3', kind: 'gif', url: 'https://tenor.com/view/x', site: 'Tenor', title: 'cat' },
    ],
  };
}

test('collectVideos: video attachments first, then links on a video site, in order', () => {
  const items = collectVideos(videoMessage(), { videoSites: ['youtube.com', 'youtu.be'] });
  assert.deepEqual(items, [
    {
      source: 'attachment',
      messageId: 'm1',
      itemId: 'a2',
      kind: 'video',
      url: 'u2',
      name: 'ταξίδι.mp4',
      durationSec: 12,
      bytes: 2048,
    },
    {
      source: 'link',
      messageId: 'm1',
      itemId: 'link:aaaa',
      kind: 'link',
      url: 'https://www.youtube.com/watch?v=abc',
      site: 'youtube.com',
      name: 'Cool video',
      durationSec: null,
    },
    {
      source: 'link',
      messageId: 'm1',
      itemId: 'video:url:bbbb',
      kind: 'link',
      url: 'https://youtu.be/xyz',
      site: 'youtu.be',
      name: 'youtu.be',
      durationSec: null,
    },
  ]);
});

test('collectVideos: no sites (missing or empty) -> attachments only', () => {
  assert.deepEqual(
    collectVideos(videoMessage()).map((item) => item.itemId),
    ['a2']
  );
  assert.deepEqual(
    collectVideos(videoMessage(), { videoSites: [] }).map((item) => item.itemId),
    ['a2']
  );
});

// --- fitBox ------------------------------------------------------------------

test('fitBox: the longer side is scaled to at most max, the aspect kept, integers', () => {
  assert.deepEqual(fitBox(988, 1306, 512), { width: 387, height: 512 });
  assert.deepEqual(fitBox(1306, 988, 512), { width: 512, height: 387 });
});

test('fitBox: a picture already within max is never upscaled', () => {
  assert.deepEqual(fitBox(167, 264, 512), { width: 167, height: 264 });
});

test('fitBox: a missing, zero or non-numeric dimension gives null', () => {
  assert.equal(fitBox(null, 1306, 512), null);
  assert.equal(fitBox(988, undefined, 512), null);
  assert.equal(fitBox(0, 1306, 512), null);
  assert.equal(fitBox(988, 0, 512), null);
  assert.equal(fitBox('988', 1306, 512), null);
});

// --- collectPictures / isDescribable -------------------------------------------

function message(id, overrides = {}) {
  return { id, ts: 0, attachments: [], links: [], ...overrides };
}

test('collectPictures: picks image/gif/video attachments, skips audio/voice/text/file', () => {
  const m = message('m1', {
    attachments: [
      { id: 'a1', kind: 'image', url: 'u1', name: 'a.png' },
      { id: 'a2', kind: 'gif', url: 'u2', name: 'a.gif' },
      { id: 'a3', kind: 'video', url: 'u3', name: 'a.mp4', durationSec: 5 },
      { id: 'a4', kind: 'audio', url: 'u4', name: 'a.mp3' },
      { id: 'a5', kind: 'file', url: 'u5', name: 'a.zip' },
    ],
  });
  const pictures = collectPictures(m);
  assert.deepEqual(
    pictures.map((p) => p.itemId),
    ['a1', 'a2', 'a3']
  );
  assert.equal(pictures[2].durationSec, 5);
});

test('collectPictures: includes any embed with a thumbnail, gif or link kind alike', () => {
  const m = message('m1', {
    links: [
      { id: 'm1#e0', kind: 'gif', thumbnailUrl: 'https://t/x.png', title: 'cat', site: 'Tenor' },
      { id: 'm1#e1', kind: 'link', thumbnailUrl: 'https://y/thumb.jpg', title: 'video', site: 'YouTube' },
      { id: 'm1#e2', kind: 'link', thumbnailUrl: null, title: 'no thumb', site: 'example.com' },
    ],
  });
  const pictures = collectPictures(m);
  assert.deepEqual(
    pictures.map((p) => p.itemId),
    ['m1#e0', 'm1#e1']
  );
});

test('collectPictures: a gif embed passes its animationUrl on, its url stays the thumbnail; other items never get one', () => {
  const m = message('m1', {
    attachments: [{ id: 'a1', kind: 'gif', url: 'https://cdn.discordapp.com/attachments/1/2/a.gif', name: 'a.gif' }],
    links: [
      {
        id: 'm1#e0',
        kind: 'gif',
        thumbnailUrl: 'https://t/x.png',
        animationUrl: 'https://t/x.mp4',
        title: 'cat',
        site: 'Tenor',
      },
      { id: 'm1#e1', kind: 'gif', thumbnailUrl: 'https://t/y.png', title: 'dog', site: 'Tenor' },
    ],
    forwarded: [
      {
        links: [
          { id: 'f1#e0', kind: 'gif', thumbnailUrl: 'https://t/z.png', animationUrl: 'https://t/z.mp4', site: 'Tenor' },
        ],
      },
    ],
  });
  const pictures = collectPictures(m);
  assert.deepEqual(
    pictures.map((p) => p.itemId),
    ['a1', 'm1#e0', 'm1#e1', 'f1#e0']
  );
  assert.equal('animationUrl' in pictures[0], false, 'an attachment is its own file');
  assert.equal(pictures[1].url, 'https://t/x.png');
  assert.equal(pictures[1].animationUrl, 'https://t/x.mp4');
  assert.equal('animationUrl' in pictures[2], false);
  assert.equal(pictures[3].animationUrl, 'https://t/z.mp4', 'a forwarded GIF keeps its animation');
  assert.equal(pictures[3].messageId, 'm1');
});

test('isDescribable: true for image/gif/video/sticker/emoji/link (a link thumbnail is describable)', () => {
  assert.equal(isDescribable({ kind: 'image' }), true);
  assert.equal(isDescribable({ kind: 'gif' }), true);
  assert.equal(isDescribable({ kind: 'video' }), true);
  assert.equal(isDescribable({ kind: 'sticker' }), true);
  assert.equal(isDescribable({ kind: 'emoji' }), true);
  assert.equal(isDescribable({ kind: 'link', thumbnailUrl: 'x' }), true);
  assert.equal(isDescribable({ kind: 'audio' }), false);
  assert.equal(isDescribable({ kind: 'voice' }), false);
  assert.equal(isDescribable({ kind: 'text' }), false);
  assert.equal(isDescribable({ kind: 'file' }), false);
});

const MIN = 60_000;

// --- stickerUrl / linkThumbnailCacheKey ------------------------

test('stickerUrl: a picture format sizes to media.discordapp.net/.../<id>.<ext>?size=160; Lottie and unknown formats are null', () => {
  const rows = [
    { label: 'PNG (format 1)', format: 1, expected: 'https://media.discordapp.net/stickers/123.png?size=160' },
    { label: 'APNG (format 2)', format: 2, expected: 'https://media.discordapp.net/stickers/123.png?size=160' },
    {
      label: 'GIF (format 4), never cdn.discordapp.com',
      format: 4,
      expected: 'https://media.discordapp.net/stickers/123.gif?size=160',
    },
    { label: 'Lottie (format 3) is never a picture', format: 3, expected: null },
    { label: 'a missing format is never a picture', format: undefined, expected: null },
    { label: 'an unknown format is never a picture', format: 99, expected: null },
  ];
  for (const { label, format, expected } of rows) {
    const url = stickerUrl('123', format);
    assert.equal(url, expected, label);
    if (url !== null) assert.ok(!url.includes('cdn.discordapp.com'), label);
  }
});

test('linkThumbnailCacheKey: stable across different signed query strings for the same picture', () => {
  const a = linkThumbnailCacheKey('https://i.ytimg.com/vi/xyz/hq.jpg?ex=1&is=2&hm=abc');
  const b = linkThumbnailCacheKey('https://i.ytimg.com/vi/xyz/hq.jpg?ex=9&is=8&hm=zzz');
  assert.equal(a, b);
  assert.ok(a.startsWith('link:'));
});

test('linkThumbnailCacheKey: a different path hashes to a different key', () => {
  const a = linkThumbnailCacheKey('https://i.ytimg.com/vi/xyz/hq.jpg');
  const b = linkThumbnailCacheKey('https://i.ytimg.com/vi/other/hq.jpg');
  assert.notEqual(a, b);
});

test('linkThumbnailCacheKey: an unparsable URL never throws, still deterministic', () => {
  assert.equal(linkThumbnailCacheKey('not a url'), linkThumbnailCacheKey('not a url'));
});

// --- stickerLabelFor -------------------------------------------------------------

function sticker(name, url) {
  return { name, url };
}

test('stickerLabelFor: a Lottie sticker (url null) is always the plain name form, ignoring a description', () => {
  assert.deepEqual(stickerLabelFor(sticker('dancing-cat', null)), { key: 'sticker', values: { name: 'dancing-cat' } });
  assert.deepEqual(stickerLabelFor(sticker('dancing-cat', null), { description: 'a cat dances' }), {
    key: 'sticker',
    values: { name: 'dancing-cat' },
  });
});

test('stickerLabelFor: a picture-format sticker blind vs described', () => {
  assert.deepEqual(stickerLabelFor(sticker('pepe', 'https://x')), { key: 'sticker', values: { name: 'pepe' } });
  assert.deepEqual(stickerLabelFor(sticker('pepe', 'https://x'), { description: 'a frog gives a thumbs up' }), {
    key: 'stickerDescribed',
    values: { name: 'pepe', text: 'a frog gives a thumbs up' },
  });
});

// --- collectPictures / collectEmojiItems: stickers and emoji --------------

function stickerMessage(id, ts, stickers) {
  return message(id, { ts, stickers });
}

test('collectPictures: a picture-format sticker is included, a Lottie one is not', () => {
  const m = stickerMessage('m1', 0, [
    { id: 's1', name: 'pepe', format: 1, url: 'https://media.discordapp.net/stickers/s1.png?size=160' },
    { id: 's2', name: 'dance', format: 3, url: null },
  ]);
  const pictures = collectPictures(m);
  assert.deepEqual(
    pictures.map((p) => p.itemId),
    ['sticker:s1']
  );
  assert.equal(pictures[0].kind, 'sticker');
  assert.equal(pictures[0].source, 'sticker');
});

test('collectEmojiItems: every distinct emoji of a message becomes a describable, never-a-picture item', () => {
  const m = message('m1', {
    emojis: [
      { id: 'e1', name: 'pog', animated: false, url: 'https://cdn.discordapp.com/emojis/e1.webp?size=96' },
      { id: 'e2', name: 'kekw', animated: true, url: 'https://cdn.discordapp.com/emojis/e2.webp?size=96' },
    ],
  });
  const items = collectEmojiItems(m);
  assert.deepEqual(
    items.map((i) => i.itemId),
    ['emoji:e1', 'emoji:e2']
  );
  assert.ok(items.every((i) => i.source === 'emoji' && isDescribable(i)));
  // Never a picture: collectPictures ignores message.emojis entirely.
  assert.deepEqual(
    collectPictures(m).map((p) => p.itemId),
    []
  );
});

// --- mediaLabelFor: a second look on a question (videoAnswered) -------------------

const answer = { question: 'quelle couleur a la voiture ?', text: 'rouge, garée à gauche' };

test('mediaLabelFor: a watched video with an answer appends videoAnswered after videoWatched', () => {
  assert.deepEqual(mediaLabelFor(clip, { video: { state: 'watched', text: 'a dog runs', answer } }), {
    key: 'videoWatched',
    values: { name: 'clip.mp4', duration: '1:05', text: 'a dog runs' },
    extra: { key: 'videoAnswered', values: { question: answer.question, text: answer.text } },
  });
});

test('mediaLabelFor: a watched link with an answer -> linkWatched, then videoAnswered', () => {
  const item = { kind: 'link', site: 's', title: 't', thumbnailUrl: 'https://x/y.jpg' };
  const video = { state: 'watched', text: 'a talk', answer };
  const answered = { key: 'videoAnswered', values: { question: answer.question, text: answer.text } };
  assert.deepEqual(mediaLabelFor(item, { video }).extra, [
    { key: 'linkWatched', values: { text: 'a talk' } },
    answered,
  ]);
});

test('mediaLabelFor: an answer on a state that is not watched is ignored', () => {
  assert.deepEqual(mediaLabelFor(clip, { video: { state: 'error', answer } }), {
    key: 'videoNotWatched',
    values: { name: 'clip.mp4', duration: '1:05', reason: 'error' },
  });
});

// --- mediaLabelFor: a second look at a picture on a question (imageAnswered) -----

const picture = { kind: 'image', name: 'singes.png' };
const pictureAnswered = { key: 'imageAnswered', values: { question: answer.question, text: answer.text } };

test('mediaLabelFor: a picture with an answer appends imageAnswered after image or imageDescribed', () => {
  assert.deepEqual(mediaLabelFor(picture, { answer }), { key: 'image', values: {}, extra: pictureAnswered });
  assert.deepEqual(mediaLabelFor(picture, { description: 'deux singes', answer }), {
    key: 'imageDescribed',
    values: { text: 'deux singes' },
    extra: pictureAnswered,
  });
});

test('mediaLabelFor: an answer on a video item is ignored (its answer lives in its state)', () => {
  assert.deepEqual(mediaLabelFor(clip, { answer }), { key: 'video', values: { name: 'clip.mp4', duration: '1:05' } });
});

test("mediaLabelFor: a GIF's second look appends videoAnswered after its tag, described or known alike", () => {
  const answered = { key: 'videoAnswered', values: { question: answer.question, text: answer.text } };
  assert.deepEqual(mediaLabelFor({ kind: 'gif', name: 'a.gif' }, { answer }), {
    key: 'gif',
    values: { name: 'a.gif' },
    extra: answered,
  });
  assert.deepEqual(mediaLabelFor({ kind: 'gif', name: 'a.gif' }, { answer, description: 'un miroir' }), {
    key: 'gifDescribed',
    values: { text: 'un miroir' },
    extra: answered,
  });
  assert.deepEqual(
    mediaLabelFor({ kind: 'gif', name: 'a.gif' }, { answer, description: 'un miroir', gifHandle: 'g3' }),
    {
      key: 'gifKnown',
      values: { id: 'g3', text: 'un miroir' },
      extra: answered,
    }
  );
});

// --- mediaLabelFor: a link read by the web lookup (linkRead) -----------------------

test('mediaLabelFor: a read link keeps its link tag and gets linkRead as its one extra', () => {
  const item = { kind: 'link', site: 'example.org', title: 'Café' };
  assert.deepEqual(mediaLabelFor(item, { read: 'une recette de crêpes' }), {
    key: 'link',
    values: { site: 'example.org', title: 'Café' },
    extra: { key: 'linkRead', values: { text: 'une recette de crêpes' } },
  });
});

test('mediaLabelFor: linkRead follows thumbnailDescribed', () => {
  const item = { kind: 'link', site: 's', title: 't', thumbnailUrl: 'https://x/y.jpg' };
  const read = { key: 'linkRead', values: { text: 'page gist' } };
  assert.deepEqual(mediaLabelFor(item, { description: 'thumb', read: 'page gist' }).extra, [
    { key: 'thumbnailDescribed', values: { text: 'thumb' } },
    read,
  ]);
});

test('mediaLabelFor: linkRead comes after the video extra and videoAnswered', () => {
  const item = { kind: 'link', site: 's', title: 't', thumbnailUrl: 'https://x/y.jpg' };
  const video = { state: 'watched', text: 'a talk', answer };
  assert.deepEqual(mediaLabelFor(item, { video, read: 'page gist' }).extra, [
    { key: 'linkWatched', values: { text: 'a talk' } },
    { key: 'videoAnswered', values: { question: answer.question, text: answer.text } },
    { key: 'linkRead', values: { text: 'page gist' } },
  ]);
});

test('mediaLabelFor: without a read the link renders exactly as before; other kinds ignore a read', () => {
  const item = { kind: 'link', site: 's', title: 't', thumbnailUrl: 'https://x/y.jpg' };
  assert.deepEqual(mediaLabelFor(item, { read: null }), mediaLabelFor(item));
  assert.deepEqual(mediaLabelFor(item, { description: 'thumb', read: '' }), {
    key: 'link',
    values: { site: 's', title: 't' },
    extra: { key: 'thumbnailDescribed', values: { text: 'thumb' } },
  });
  assert.deepEqual(mediaLabelFor({ kind: 'gif', name: 'cat.gif' }, { read: 'x' }), {
    key: 'gif',
    values: { name: 'cat.gif' },
  });
  assert.deepEqual(mediaLabelFor({ kind: 'image' }, { read: 'x' }), { key: 'image', values: {} });
});

// --- collectReadableLinks: the links the web lookup may read ------------------------

test('collectReadableLinks: plain links in order, without gif embeds, video-site links or links with no url', () => {
  const message = {
    id: 'm1',
    links: [
      { id: 'm1#e0', kind: 'link', site: 'example.org', title: 'Á', url: 'https://example.org/a' },
      { id: 'm1#e1', kind: 'gif', site: 'tenor', title: '', url: 'https://tenor.com/view/x' },
      { id: 'video:url:1', kind: 'link', site: 'youtube.com', title: 'v', url: 'https://www.youtube.com/watch?v=abc' },
      { id: 'm1#e3', kind: 'link', site: 'x', title: 'no url', url: null },
      { id: 'm1#e4', kind: 'link', site: 'news.example.com', title: 'B', url: 'https://news.example.com/b' },
    ],
  };
  const items = collectReadableLinks(message, { videoSites: ['youtube.com'] });
  assert.deepEqual(
    items.map((item) => item.id),
    ['m1#e0', 'm1#e4']
  );
  assert.deepEqual(items[0], {
    id: 'm1#e0',
    messageId: 'm1',
    url: 'https://example.org/a',
    site: 'example.org',
    title: 'Á',
  });
});

test('collectReadableLinks: no sites keeps video-site links; no links -> []', () => {
  const message = {
    id: 'm1',
    links: [{ id: 'v', kind: 'link', site: 'youtube.com', title: '', url: 'https://youtu.be/abc' }],
  };
  assert.equal(collectReadableLinks(message).length, 1);
  assert.deepEqual(collectReadableLinks({ id: 'm2' }), []);
});

// --- forwarded messages (message snapshots): the collectors walk them too ------------

/** A message with its own media plus two forwarded snapshots (no id of their own). */
function forwardMessage() {
  return {
    id: 'outer',
    ts: 0,
    attachments: [{ id: 'own-a', kind: 'image', url: 'u-own', name: 'own.png' }],
    links: [
      {
        id: 'outer#e0',
        kind: 'link',
        url: 'https://example.org/own',
        site: 'example.org',
        title: 'Own',
        thumbnailUrl: null,
      },
    ],
    stickers: [],
    emojis: [{ id: 'e-own', name: 'own', url: 'https://cdn.discordapp.com/emojis/e-own.webp?size=96' }],
    forwarded: [
      {
        content: 'first snapshot',
        attachments: [
          { id: 'fwd-a1', kind: 'video', url: 'u-fwd1', name: 'clip.mp4', size: 4096, durationSec: 30 },
          { id: 'fwd-a2', kind: 'file', url: 'u-fwd2', name: 'notes.zip' },
        ],
        links: [
          {
            id: 'video:url:yt1',
            kind: 'link',
            url: 'https://www.youtube.com/watch?v=abc',
            site: 'YouTube',
            title: 'Forwarded video',
            thumbnailUrl: 'https://i.ytimg.com/vi/abc/hq.jpg',
          },
          {
            id: 'fwd#e1',
            kind: 'link',
            url: 'https://news.example.com/story',
            site: 'news.example.com',
            title: 'Story',
            thumbnailUrl: null,
          },
        ],
        stickers: [
          { id: 's-fwd', name: 'wave', format: 1, url: 'https://media.discordapp.net/stickers/s-fwd.png?size=160' },
        ],
        emojis: [{ id: 'e-fwd1', name: 'fwd', url: 'https://cdn.discordapp.com/emojis/e-fwd1.webp?size=96' }],
      },
      {
        content: '',
        attachments: [{ id: 'fwd-a3', kind: 'gif', url: 'u-fwd3', name: 'loop.gif' }],
        links: [],
        stickers: [],
        emojis: [{ id: 'e-fwd2', name: 'fwd2', url: 'https://cdn.discordapp.com/emojis/e-fwd2.webp?size=96' }],
      },
    ],
  };
}

test("collectPictures: forwarded snapshots follow the message's own pictures, in order, with the outer messageId", () => {
  const pictures = collectPictures(forwardMessage());
  assert.deepEqual(
    pictures.map((p) => p.itemId),
    ['own-a', 'fwd-a1', 'video:url:yt1', 'sticker:s-fwd', 'fwd-a3']
  );
  assert.ok(pictures.every((p) => p.messageId === 'outer'));
  assert.deepEqual(pictures[2], {
    source: 'embed',
    messageId: 'outer',
    itemId: 'video:url:yt1',
    kind: 'link',
    url: 'https://i.ytimg.com/vi/abc/hq.jpg',
    name: 'Forwarded video',
    width: null,
    height: null,
  });
});

test("collectEmojiItems: a forwarded snapshot's custom emoji follow the message's own, with the outer messageId", () => {
  const items = collectEmojiItems(forwardMessage());
  assert.deepEqual(
    items.map((i) => i.itemId),
    ['emoji:e-own', 'emoji:e-fwd1', 'emoji:e-fwd2']
  );
  assert.ok(items.every((i) => i.messageId === 'outer' && i.source === 'emoji'));
});

test('collectVideos: a forwarded YouTube link is a candidate with its site set (the forwarded-video case)', () => {
  const items = collectVideos(forwardMessage(), { videoSites: ['youtube.com', 'youtu.be'] });
  assert.deepEqual(items, [
    {
      source: 'attachment',
      messageId: 'outer',
      itemId: 'fwd-a1',
      kind: 'video',
      url: 'u-fwd1',
      name: 'clip.mp4',
      durationSec: 30,
      bytes: 4096,
    },
    {
      source: 'link',
      messageId: 'outer',
      itemId: 'video:url:yt1',
      kind: 'link',
      url: 'https://www.youtube.com/watch?v=abc',
      site: 'youtube.com',
      name: 'Forwarded video',
      durationSec: null,
    },
  ]);
});

test("collectReadableLinks: forwarded plain links follow the message's own, video-site links still excluded", () => {
  const items = collectReadableLinks(forwardMessage(), { videoSites: ['youtube.com'] });
  assert.deepEqual(items, [
    { id: 'outer#e0', messageId: 'outer', url: 'https://example.org/own', site: 'example.org', title: 'Own' },
    {
      id: 'fwd#e1',
      messageId: 'outer',
      url: 'https://news.example.com/story',
      site: 'news.example.com',
      title: 'Story',
    },
  ]);
});

// --- discordCdnVideo ---------------------------------------------------------

const CDN_QUERY = '?ex=aa&is=bb&hm=cc';

test('discordCdnVideo: a cdn.discordapp.com attachment video gives the attachment id and file name', () => {
  assert.deepEqual(discordCdnVideo(`https://cdn.discordapp.com/attachments/111/222/clip.mp4${CDN_QUERY}`), {
    id: '222',
    name: 'clip.mp4',
  });
});

test('discordCdnVideo: the media.discordapp.net host and the ephemeral-attachments prefix are accepted', () => {
  assert.deepEqual(discordCdnVideo(`https://media.discordapp.net/attachments/111/333/a.webm${CDN_QUERY}`), {
    id: '333',
    name: 'a.webm',
  });
  assert.deepEqual(discordCdnVideo(`https://cdn.discordapp.com/ephemeral-attachments/111/444/b.MOV${CDN_QUERY}`), {
    id: '444',
    name: 'b.MOV',
  });
});

test('discordCdnVideo: the file name is decoded', () => {
  assert.equal(discordCdnVideo('https://cdn.discordapp.com/attachments/1/2/%CE%B1%CE%B2%20c.mp4').name, 'αβ c.mp4');
});

test('discordCdnVideo: another host is rejected', () => {
  assert.equal(discordCdnVideo('https://example.com/attachments/111/222/clip.mp4'), null);
  assert.equal(discordCdnVideo('https://images-ext-1.discordapp.net/attachments/111/222/clip.mp4'), null);
});

test('discordCdnVideo: a non-video extension is rejected', () => {
  assert.equal(discordCdnVideo(`https://cdn.discordapp.com/attachments/111/222/pic.png${CDN_QUERY}`), null);
  assert.equal(discordCdnVideo('https://cdn.discordapp.com/attachments/111/222/notes.txt'), null);
  assert.equal(discordCdnVideo('https://cdn.discordapp.com/attachments/111/222/noext'), null);
});

test('discordCdnVideo: a malformed path, protocol or URL is rejected', () => {
  assert.equal(discordCdnVideo('https://cdn.discordapp.com/attachments/111/clip.mp4'), null);
  assert.equal(discordCdnVideo('https://cdn.discordapp.com/attachments/abc/222/clip.mp4'), null);
  assert.equal(discordCdnVideo('https://cdn.discordapp.com/attachments/111/222/x/clip.mp4'), null);
  assert.equal(discordCdnVideo('https://cdn.discordapp.com/emojis/111/222/clip.mp4'), null);
  assert.equal(discordCdnVideo('ftp://cdn.discordapp.com/attachments/111/222/clip.mp4'), null);
  assert.equal(discordCdnVideo('not a url'), null);
  assert.equal(discordCdnVideo(null), null);
});

// --- lateVideoStates -------------------------------------------------------------

test('lateVideoStates: known states kept, the first maxNew unknown candidates pending, the rest left out', () => {
  const candidates = [{ itemId: 'v1' }, { itemId: 'v2' }, { itemId: 'v3' }, { itemId: 'v4' }];
  const known = new Map([
    ['v2', { state: 'watched', text: 'ένα ποτάμι' }],
    ['zz', { state: 'error' }],
  ]);
  const states = lateVideoStates(candidates, known, 2);
  assert.deepEqual(
    [...states],
    [
      ['v1', { state: 'pending' }],
      ['v2', { state: 'watched', text: 'ένα ποτάμι' }],
      ['v3', { state: 'pending' }],
    ]
  );
});

test('lateVideoStates: no known states and no candidates', () => {
  assert.deepEqual(
    [...lateVideoStates([{ itemId: 'v1' }, { itemId: 'v2' }], undefined, 1)],
    [['v1', { state: 'pending' }]]
  );
  assert.deepEqual([...lateVideoStates([], new Map(), 1)], []);
  assert.deepEqual([...lateVideoStates([{ itemId: 'v1' }], null, 0)], []);
});

test('mediaLabelFor: a library GIF with a reaction or on-screen text -> gifKnownFields beside the caption', () => {
  const gif = { kind: 'gif', name: 'a.gif' };
  const all = { reaction: 'accord ferme', action: 'un chat lève le menton', screen: 'ναι' };
  assert.deepEqual(mediaLabelFor(gif, { gifHandle: 'g3', description: 'un chat lève le menton', gifFields: all }), {
    key: 'gifKnownFields',
    values: {
      id: 'g3',
      text: 'un chat lève le menton',
      reaction: 'accord ferme',
      action: 'un chat lève le menton',
      screen: 'ναι',
    },
  });
  assert.deepEqual(mediaLabelFor(gif, { gifHandle: 'g3', description: 'ναι', gifFields: { screen: 'ναι' } }).values, {
    id: 'g3',
    text: 'ναι',
    reaction: '',
    action: '',
    screen: 'ναι',
  });
  const reactionOnly = mediaLabelFor(gif, {
    gifHandle: 'g3',
    description: 'x',
    gifFields: { reaction: 'accord', action: '', screen: '' },
  });
  assert.equal(reactionOnly.key, 'gifKnownFields');
});

test('mediaLabelFor: gifKnownFields needs a handle, a caption and a reaction or on-screen text', () => {
  const gif = { kind: 'gif', name: 'a.gif' };
  const all = { reaction: 'accord ferme', action: 'un chat lève le menton', screen: 'ναι' };
  assert.deepEqual(
    mediaLabelFor(gif, { description: 'un chat', gifFields: all }),
    { key: 'gifDescribed', values: { text: 'un chat' } },
    'no handle: the caption alone'
  );
  assert.deepEqual(
    mediaLabelFor(gif, {
      gifHandle: 'g3',
      description: 'un chat',
      gifFields: { reaction: '', action: 'un chat', screen: '' },
    }),
    {
      key: 'gifKnown',
      values: { id: 'g3', text: 'un chat' },
    }
  );
  assert.equal(mediaLabelFor(gif, { gifHandle: 'g3', gifFields: all }).key, 'gifKnownNoText', 'no caption');
  assert.deepEqual(mediaLabelFor({ kind: 'image' }, { gifHandle: 'g3', gifFields: all }), { key: 'image', values: {} });
});
