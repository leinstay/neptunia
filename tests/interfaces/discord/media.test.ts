// Tests for src/media/classify.ts (pure media classification, label choice and vision picture selection) and for the
// Discord package's media addresses (interfaces/discord/media.ts: media-proxy rewriting, stickers, CDN video links).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discordCdnVideo, mediaProxyUrl, stickerUrl } from '../../../interfaces/discord/media.ts';
import { present, wrongly } from '../../fixtures/loose-types.ts';

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

// A GIF is never described from one frame.
test('mediaProxyUrl: an images-ext-<n>.discordapp.net URL keeps its host and path, parameters appended to the existing query', () => {
  const original = 'https://images-ext-1.discordapp.net/external/abc123/https/media.tenor.com/x/anim.gif?ex=1&is=2';
  const url = mediaProxyUrl(original, { width: 512, height: 512, format: 'png' });
  const parsed = new URL(url);
  assert.equal(parsed.hostname, 'images-ext-1.discordapp.net');
  assert.equal(parsed.pathname, '/external/abc123/https/media.tenor.com/x/anim.gif');
  assert.equal(url, `${original}&width=512&height=512&format=png`);
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
    const url = stickerUrl('123', wrongly(format));
    assert.equal(url, expected, label);
    if (url !== null) assert.ok(!url.includes('cdn.discordapp.com'), label);
  }
});

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
  assert.equal(
    present(discordCdnVideo('https://cdn.discordapp.com/attachments/1/2/%CE%B1%CE%B2%20c.mp4')).name,
    'αβ c.mp4'
  );
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
  assert.equal(discordCdnVideo(wrongly(null)), null);
});
