// Tests for src/media/classify.js: pure media classification, label choice,
// media-proxy URL rewriting and vision picture selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAttachment,
  classifyEmbed,
  formatDurationShort,
  mediaProxyUrl,
  mediaLabelFor,
  stickerLabelFor,
  stickerUrl,
  linkThumbnailCacheKey,
  collectPictures,
  collectEmojiItems,
  collectVideos,
  lateVideoStates,
  collectReadableLinks,
  isDescribable,
  selectPictures,
  discordCdnVideo,
  mediaParts,
  siteOf,
  clipWithEllipsis,
  isGifHostUrl,
  fitBox,
  watchedLengths,
} from '../src/media/classify.js';

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

// --- classifyEmbed -----------------------------------------------------------

test('classifyEmbed: a tenor embed classifies as gif via its provider name', () => {
  const embed = { url: 'https://tenor.com/view/x', provider: { name: 'Tenor' }, title: 'cat', thumbnail: { url: 'https://t.tenor.com/x.png' } };
  const item = classifyEmbed(embed);
  assert.equal(item.kind, 'gif');
  assert.equal(item.site, 'Tenor');
  assert.equal(item.thumbnailUrl, 'https://t.tenor.com/x.png');
});

test('classifyEmbed: a giphy host without a provider name still classifies as gif', () => {
  const embed = { url: 'https://giphy.com/gifs/x', thumbnail: { url: 'https://media.giphy.com/x.gif' } };
  const item = classifyEmbed(embed);
  assert.equal(item.kind, 'gif');
  assert.equal(item.site, 'giphy.com');
});

test('classifyEmbed: a video-site embed keeps kind "link" but carries the thumbnail', () => {
  const embed = {
    url: 'https://www.youtube.com/watch?v=xyz',
    provider: { name: 'YouTube' },
    title: 'Cool video',
    description: 'a description',
    thumbnail: { url: 'https://i.ytimg.com/vi/xyz/hq.jpg' },
  };
  const item = classifyEmbed(embed);
  assert.equal(item.kind, 'link');
  assert.equal(item.site, 'YouTube');
  assert.equal(item.thumbnailUrl, 'https://i.ytimg.com/vi/xyz/hq.jpg');
});

test('classifyEmbed: a tenor gifv embed carries its video as animationUrl, the proxy URL preferred', () => {
  const embed = {
    url: 'https://tenor.com/view/x',
    provider: { name: 'Tenor' },
    thumbnail: { url: 'https://media.tenor.com/x/AAAAe/x.png', proxyURL: 'https://images-ext-1.discordapp.net/external/t/x.png' },
    video: { url: 'https://media.tenor.com/x/AAAPo/x.mp4', proxyURL: 'https://images-ext-1.discordapp.net/external/v/x.mp4' },
  };
  assert.equal(classifyEmbed(embed).animationUrl, 'https://images-ext-1.discordapp.net/external/v/x.mp4');
  const bare = classifyEmbed({ ...embed, video: { url: 'https://media.tenor.com/x/AAAPo/x.mp4' } });
  assert.equal(bare.animationUrl, 'https://media.tenor.com/x/AAAPo/x.mp4');
  assert.equal(bare.thumbnailUrl, 'https://images-ext-1.discordapp.net/external/t/x.png', 'the still thumbnail is unchanged');
});

test('classifyEmbed: a direct .gif link on a GIF host is its own animation; a gif embed without either has none', () => {
  const direct = classifyEmbed({ url: 'https://media.giphy.com/media/abc/giphy.GIF?cid=1', thumbnail: { url: 'https://media.giphy.com/media/abc/giphy.gif' } });
  assert.equal(direct.kind, 'gif');
  assert.equal(direct.animationUrl, 'https://media.giphy.com/media/abc/giphy.GIF?cid=1');
  const page = classifyEmbed({ url: 'https://tenor.com/view/x', provider: { name: 'Tenor' }, thumbnail: { url: 'https://t.tenor.com/x.png' } });
  assert.equal('animationUrl' in page, false);
});

test('classifyEmbed: a link embed never carries animationUrl, even with a video or a .gif URL', () => {
  const youtube = classifyEmbed({ url: 'https://www.youtube.com/watch?v=xyz', video: { url: 'https://www.youtube.com/embed/xyz' } });
  assert.equal('animationUrl' in youtube, false);
  const other = classifyEmbed({ url: 'https://example.com/a.gif', thumbnail: { url: 'https://example.com/a.gif' } });
  assert.equal(other.kind, 'link');
  assert.equal('animationUrl' in other, false);
});

/** A GIF-picker post as Discord delivers it: a `gifv` embed of a provider the code has no name for. */
function pickerEmbed(overrides = {}) {
  return {
    type: 'gifv',
    url: 'https://gifs.example.net/gifs/dancing-cat',
    provider: { name: 'Gifland' },
    thumbnail: { url: 'https://static.gifs.example.net/x/still.webp', proxyURL: 'https://images-ext-1.discordapp.net/external/t/still.webp' },
    video: { url: 'https://static.gifs.example.net/x/loop.mp4', proxyURL: 'https://images-ext-1.discordapp.net/external/v/loop.mp4' },
    ...overrides,
  };
}

test('classifyEmbed: a gifv embed is a gif whatever its provider: the page to post, the video to watch, the still to describe', () => {
  const item = classifyEmbed(pickerEmbed());
  assert.equal(item.kind, 'gif');
  assert.equal(item.url, 'https://gifs.example.net/gifs/dancing-cat');
  assert.equal(item.animationUrl, 'https://images-ext-1.discordapp.net/external/v/loop.mp4');
  assert.equal(item.thumbnailUrl, 'https://images-ext-1.discordapp.net/external/t/still.webp');
  assert.equal(item.site, 'Gifland');
});

test('classifyEmbed: the embed type is read off a discord.js Embed too (its `data.type`)', () => {
  const { type, ...fields } = pickerEmbed();
  const item = classifyEmbed({ ...fields, data: { type } });
  assert.equal(item.kind, 'gif');
  assert.equal(item.animationUrl, 'https://images-ext-1.discordapp.net/external/v/loop.mp4');
});

test('classifyEmbed: a klipy page is a gif by its host, with or without a type or a provider name', () => {
  const bare = classifyEmbed({ url: 'https://klipy.com/gifs/dancing-cat', thumbnail: { url: 'https://static.klipy.com/x/still.webp' } });
  assert.equal(bare.kind, 'gif');
  assert.equal(bare.url, 'https://klipy.com/gifs/dancing-cat');
  const picker = classifyEmbed(pickerEmbed({ url: 'https://klipy.com/gifs/dancing-cat', provider: { name: 'Klipy' } }));
  assert.equal(picker.kind, 'gif');
  assert.equal(picker.animationUrl, 'https://images-ext-1.discordapp.net/external/v/loop.mp4');
});

test('classifyEmbed: tenor and giphy stay gifs exactly as before; an embed of another type stays a link', () => {
  const rows = [
    { label: 'tenor by provider', embed: { url: 'https://tenor.com/view/x', provider: { name: 'Tenor' } }, kind: 'gif' },
    { label: 'giphy by host', embed: { url: 'https://giphy.com/gifs/x' }, kind: 'gif' },
    { label: 'tenor gifv', embed: { type: 'gifv', url: 'https://tenor.com/view/x', provider: { name: 'Tenor' } }, kind: 'gif' },
    { label: 'a rich page', embed: { type: 'rich', url: 'https://example.com/a', provider: { name: 'Example' } }, kind: 'link' },
    { label: 'an article', embed: { type: 'article', url: 'https://example.com/b' }, kind: 'link' },
  ];
  for (const { label, embed, kind } of rows) assert.equal(classifyEmbed(embed).kind, kind, label);
});

test('classifyEmbed: a gifv embed on a video site of videoSites stays a link (the video describer owns it)', () => {
  const embed = pickerEmbed({ url: 'https://x.com/someone/status/1', provider: null });
  assert.equal(classifyEmbed(embed, { videoSites: ['x.com'] }).kind, 'link');
  assert.equal('animationUrl' in classifyEmbed(embed, { videoSites: ['x.com'] }), false);
  assert.equal(classifyEmbed(embed, { videoSites: ['youtube.com'] }).kind, 'gif');
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
  for (const url of ['https://example.com/klipy.com', 'https://notklipy.com/gifs/x', 'https://youtube.com/watch?v=1', 'not a url', undefined]) {
    assert.equal(isGifHostUrl(url), false, String(url));
  }
});

test('collectReadableLinks: a gifv embed from any provider is never a page to read', () => {
  const message = { id: 'm1', links: [{ id: 'm1#e0', ...classifyEmbed(pickerEmbed()) }, { id: 'm1#e1', ...classifyEmbed({ url: 'https://example.com/a' }) }] };
  assert.deepEqual(collectReadableLinks(message).map((link) => link.id), ['m1#e1']);
});

test('classifyEmbed: title/description are truncated to embedTextChars', () => {
  const embed = { url: 'https://example.com', title: 'x'.repeat(50), description: 'y'.repeat(50) };
  const item = classifyEmbed(embed, { embedTextChars: 10 });
  assert.equal(item.title, `${'x'.repeat(10)}…`);
  assert.equal(item.text, `${'y'.repeat(10)}…`);
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

test('mediaLabelFor: an attached plain image renders imageAttached with its 1-based index', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'image' }, { attachedIndex: 1 }), { key: 'imageAttached', values: { n: 1 } });
});

test('mediaLabelFor: an attached plain image with a caption renders imageAttachedDescribed with n and text', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'image' }, { attachedIndex: 2, description: 'a grey cat' }), {
    key: 'imageAttachedDescribed',
    values: { n: 2, text: 'a grey cat' },
  });
});

test('mediaLabelFor: an attached plain image with an empty caption keeps the bare imageAttached', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'image' }, { attachedIndex: 1, description: '' }), { key: 'imageAttached', values: { n: 1 } });
});

test('mediaLabelFor: an attached video/gif still frame keeps its normal (blind) form, plus an extra frameAttached tag', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'gif', name: 'cat.gif' }, { attachedIndex: 2 }), {
    key: 'gif',
    values: { name: 'cat.gif' },
    extra: { key: 'frameAttached', values: { n: 2 } },
  });
  assert.deepEqual(mediaLabelFor({ kind: 'video', name: 'clip.mp4', durationSec: 65 }, { attachedIndex: 3 }), {
    key: 'video',
    values: { name: 'clip.mp4', duration: '1:05' },
    extra: { key: 'frameAttached', values: { n: 3 } },
  });
});

test('mediaLabelFor: an attached video/gif still frame with a description uses the described form, plus frameAttached', () => {
  assert.deepEqual(mediaLabelFor({ kind: 'gif' }, { attachedIndex: 1, description: 'a cat dances' }), {
    key: 'gifDescribed',
    values: { text: 'a cat dances' },
    extra: { key: 'frameAttached', values: { n: 1 } },
  });
  assert.deepEqual(
    mediaLabelFor({ kind: 'video', name: 'clip.mp4', durationSec: 65 }, { attachedIndex: 1, description: 'a dog runs' }),
    {
      key: 'videoDescribed',
      values: { name: 'clip.mp4', duration: '1:05', text: 'a dog runs' },
      extra: { key: 'frameAttached', values: { n: 1 } },
    },
  );
});

test('mediaLabelFor: an attached link-embed thumbnail keeps the link tag and adds frameAttached (never bare imageAttached)', () => {
  const item = { kind: 'link', site: 's', title: 't', thumbnailUrl: 'https://x/y.jpg' };
  assert.deepEqual(mediaLabelFor(item, { attachedIndex: 1 }), {
    key: 'link',
    values: { site: 's', title: 't' },
    extra: { key: 'frameAttached', values: { n: 1 } },
  });
});

test('mediaLabelFor: an attached link-embed thumbnail with a description still prefers frameAttached over thumbnailDescribed', () => {
  const item = { kind: 'link', site: 's', title: 't', thumbnailUrl: 'https://x/y.jpg' };
  const result = mediaLabelFor(item, { attachedIndex: 1, description: 'a video preview' });
  assert.equal(result.extra.key, 'frameAttached');
});

test('mediaLabelFor: a link without a thumbnail is never attachable, even with an index passed by mistake', () => {
  const item = { kind: 'link', site: 's', title: 't' };
  const result = mediaLabelFor(item, { attachedIndex: 1 });
  assert.notEqual(result.key, 'imageAttached');
  assert.equal(result.extra, undefined);
});

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
  assert.deepEqual(mediaLabelFor({ kind: 'image' }, { description: 'a cat' }), { key: 'imageDescribed', values: { text: 'a cat' } });
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
  assert.deepEqual(mediaLabelFor({ kind: 'video', name: 'clip.mp4' }), { key: 'video', values: { name: 'clip.mp4', duration: '?' } });
  assert.deepEqual(mediaLabelFor({ kind: 'voice' }), { key: 'voice', values: { duration: '?' } });
  assert.deepEqual(mediaLabelFor({ kind: 'audio', name: 'song.mp3' }), { key: 'audio', values: { name: 'song.mp3', duration: '?' } });
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
  assert.deepEqual(mediaLabelFor({ kind: 'link', site: 's', title: 't' }), { key: 'link', values: { site: 's', title: 't' } });
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
    [{ ...long, durationSec: 300.4 }, { state: 'watched', text: 'a talk', watchedSeconds: 300 }],
    [{ ...long, durationSec: null }, { state: 'watched', text: 'a talk', watchedSeconds: 300 }],
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

test('mediaLabelFor: a video with an attached still frame keeps frameAttached as its extra, watched or not', () => {
  const rows = [
    {
      label: 'a watched video with an attached still frame',
      options: { attachedIndex: 2, video: { state: 'watched', text: 'a dog runs' } },
      expected: {
        key: 'videoWatched',
        values: { name: 'clip.mp4', duration: '1:05', text: 'a dog runs' },
        extra: { key: 'frameAttached', values: { n: 2 } },
      },
    },
    {
      label: 'a video not watched with an attached frame',
      options: { attachedIndex: 1, video: { state: 'error' } },
      expected: {
        key: 'videoNotWatched',
        values: { name: 'clip.mp4', duration: '1:05', reason: 'error' },
        extra: { key: 'frameAttached', values: { n: 1 } },
      },
    },
  ];
  for (const { label, options, expected } of rows) {
    assert.deepEqual(mediaLabelFor(clip, options), expected, label);
  }
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
  assert.deepEqual(mediaLabelFor(item, { video: { state: 'watched', text: 'a talk', watchedSeconds: 300, totalSeconds: 3289 } }).extra, {
    key: 'linkWatchedPart',
    values: { duration: '54:49', watched: '5:00', reason: 'clip', text: 'a talk' },
  });
  // The item's own duration stands in when the state carries no total.
  assert.equal(mediaLabelFor({ ...item, durationSec: 400 }, { video: { state: 'watched', text: 'a talk', watchedSeconds: 300 } }).extra.key, 'linkWatchedPart');
  for (const video of [
    { state: 'watched', text: 'a talk', watchedSeconds: 42, totalSeconds: 42 },
    { state: 'watched', text: 'a talk', watchedSeconds: 300 },
    { state: 'watched', text: 'a talk' },
  ]) {
    assert.deepEqual(mediaLabelFor(item, { video }).extra, { key: 'linkWatched', values: { text: 'a talk' } });
  }
});

test('watchedLengths: the finite watchedSeconds / totalSeconds of a cache entry, nothing for an old entry', () => {
  assert.deepEqual(watchedLengths({ text: 'x', watched: true, watchedSeconds: 300, totalSeconds: 3289 }), { watchedSeconds: 300, totalSeconds: 3289 });
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

test('mediaLabelFor: an attached link thumbnail AND a video state -> extra array, frameAttached first', () => {
  const item = { kind: 'link', site: 's', title: 't', thumbnailUrl: 'https://x/y.jpg' };
  assert.deepEqual(mediaLabelFor(item, { attachedIndex: 3, video: { state: 'watched', text: 'a talk' } }), {
    key: 'link',
    values: { site: 's', title: 't' },
    extra: [
      { key: 'frameAttached', values: { n: 3 } },
      { key: 'linkWatched', values: { text: 'a talk' } },
    ],
  });
});

test('mediaLabelFor: other kinds ignore a video state', () => {
  const video = { state: 'watched', text: 'x' };
  assert.deepEqual(mediaLabelFor({ kind: 'image' }, { video }), { key: 'image', values: {} });
  assert.deepEqual(mediaLabelFor({ kind: 'gif', name: 'cat.gif' }, { video }), { key: 'gif', values: { name: 'cat.gif' } });
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
      { id: 'link:aaaa', kind: 'link', url: 'https://www.youtube.com/watch?v=abc', site: 'YouTube', title: 'Cool video' },
      { id: 'm1#e1', kind: 'link', url: 'https://example.com/page', site: 'example.com', title: 'A page' },
      { id: 'video:url:bbbb', kind: 'link', url: 'https://youtu.be/xyz', site: 'youtu.be', title: '' },
      { id: 'm1#e3', kind: 'gif', url: 'https://tenor.com/view/x', site: 'Tenor', title: 'cat' },
    ],
  };
}

test('collectVideos: video attachments first, then links on a video site, in order', () => {
  const items = collectVideos(videoMessage(), { videoSites: ['youtube.com', 'youtu.be'] });
  assert.deepEqual(items, [
    { source: 'attachment', messageId: 'm1', itemId: 'a2', kind: 'video', url: 'u2', name: 'ταξίδι.mp4', durationSec: 12, bytes: 2048 },
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
  assert.deepEqual(collectVideos(videoMessage()).map((item) => item.itemId), ['a2']);
  assert.deepEqual(collectVideos(videoMessage(), { videoSites: [] }).map((item) => item.itemId), ['a2']);
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
  assert.deepEqual(pictures.map((p) => p.itemId), ['a1', 'a2', 'a3']);
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
  assert.deepEqual(pictures.map((p) => p.itemId), ['m1#e0', 'm1#e1']);
});

test('collectPictures: a gif embed passes its animationUrl on, its url stays the thumbnail; other items never get one', () => {
  const m = message('m1', {
    attachments: [{ id: 'a1', kind: 'gif', url: 'https://cdn.discordapp.com/attachments/1/2/a.gif', name: 'a.gif' }],
    links: [
      { id: 'm1#e0', kind: 'gif', thumbnailUrl: 'https://t/x.png', animationUrl: 'https://t/x.mp4', title: 'cat', site: 'Tenor' },
      { id: 'm1#e1', kind: 'gif', thumbnailUrl: 'https://t/y.png', title: 'dog', site: 'Tenor' },
    ],
    forwarded: [{ links: [{ id: 'f1#e0', kind: 'gif', thumbnailUrl: 'https://t/z.png', animationUrl: 'https://t/z.mp4', site: 'Tenor' }] }],
  });
  const pictures = collectPictures(m);
  assert.deepEqual(pictures.map((p) => p.itemId), ['a1', 'm1#e0', 'm1#e1', 'f1#e0']);
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

// --- selectPictures -------------------------------------------------------------

const MIN = 60_000;

function pictureMessage(id, ts, itemId) {
  return message(id, { ts, attachments: [{ id: itemId, kind: 'image', url: `url-${itemId}`, name: `${itemId}.png` }] });
}

test('selectPictures: vision off (maxImages 0) selects nothing', () => {
  const now = 1_000_000;
  const trigger = pictureMessage('t', now, 'trig');
  const picked = selectPictures({ trigger, history: [trigger], visionCfg: { maxImages: 0, recentImages: 3, recentImageMinutes: 30 }, now });
  assert.deepEqual(picked, []);
});

test('selectPictures: trigger pictures come first', () => {
  const now = 1_000_000;
  // Every tier has a candidate and maxImages leaves room for fewer: priority decides.
  // The replied-to picture is older than recentImageMinutes (only its own tier can
  // take it); a newer picture follows the trigger (the recent tier would take it first).
  const replied = pictureMessage('r', now - 60 * MIN, 'replied');
  const trigger = { ...pictureMessage('t', now - 2 * MIN, 'trig'), replyToId: 'r' };
  const later = pictureMessage('m1', now - MIN, 'later');
  const pick = (maxImages) =>
    selectPictures({
      trigger,
      history: [replied, trigger, later],
      visionCfg: { maxImages, recentImages: 3, recentImageMinutes: 30 },
      now,
    }).map((p) => p.itemId);
  assert.deepEqual(pick(1), ['trig'], 'room for one: the trigger\'s own, ahead of the replied-to and the newer picture');
  assert.deepEqual(pick(2), ['replied', 'trig'], 'room for two: the replied-to picture next, ahead of the newer one');
});

test('selectPictures: recent channel pictures fill up to recentImages, newest first, then re-sorted to transcript order', () => {
  const now = 1_000_000;
  const m1 = pictureMessage('m1', now - 20 * MIN, 'p1');
  const m2 = pictureMessage('m2', now - 10 * MIN, 'p2');
  const m3 = pictureMessage('m3', now - 5 * MIN, 'p3');
  const picked = selectPictures({
    trigger: null,
    history: [m1, m2, m3],
    visionCfg: { maxImages: 4, recentImages: 2, recentImageMinutes: 30 },
    now,
  });
  // p1 is the oldest, dropped because recentImages caps at 2; p2/p3 kept, in transcript (chronological) order.
  assert.deepEqual(picked.map((p) => p.itemId), ['p2', 'p3']);
});

test('selectPictures: recent pictures older than recentImageMinutes are excluded', () => {
  const now = 1_000_000;
  const old = pictureMessage('old', now - 40 * MIN, 'old-pic');
  const recent = pictureMessage('recent', now - 5 * MIN, 'recent-pic');
  const picked = selectPictures({
    trigger: null,
    history: [old, recent],
    visionCfg: { maxImages: 4, recentImages: 3, recentImageMinutes: 30 },
    now,
  });
  assert.deepEqual(picked.map((p) => p.itemId), ['recent-pic']);
});

test('selectPictures: the overall maxImages cap wins even when more would qualify', () => {
  const now = 1_000_000;
  const trigger = message('t', {
    ts: now,
    attachments: [
      { id: 'a', kind: 'image', url: 'ua', name: 'a.png' },
      { id: 'b', kind: 'image', url: 'ub', name: 'b.png' },
      { id: 'c', kind: 'image', url: 'uc', name: 'c.png' },
    ],
  });
  const picked = selectPictures({
    trigger,
    history: [trigger],
    visionCfg: { maxImages: 2, recentImages: 3, recentImageMinutes: 30 },
    now,
  });
  assert.equal(picked.length, 2);
});

test('selectPictures: never picks the same item twice across tiers', () => {
  const now = 1_000_000;
  const trigger = pictureMessage('t', now, 'shared');
  trigger.replyToId = 't'; // pathological but must not double-count
  const picked = selectPictures({
    trigger,
    history: [trigger],
    visionCfg: { maxImages: 4, recentImages: 3, recentImageMinutes: 30 },
    now,
  });
  assert.deepEqual(picked.map((p) => p.itemId), ['shared']);
});

test('selectPictures: a trigger in another channel than the turn posts in gives no picture, nor does the message it replies to', () => {
  const now = 1_000_000;
  // Older than recentImageMinutes: only the replied-to tier could take it.
  const replied = pictureMessage('r', now - 60 * MIN, 'replied');
  const trigger = { ...pictureMessage('t', now, 'trig'), channelId: 'source', replyToId: 'r' };
  const sticker = { ...stickerMessage('s', now, [{ id: 's1', name: 'gâteau', format: 1, url: 'https://media.discordapp.net/stickers/s1.png?size=160' }]), channelId: 'source' };
  const local = { ...pictureMessage('m1', now - MIN, 'local'), channelId: 'dest' };
  const visionCfg = { maxImages: 4, recentImages: 3, recentImageMinutes: 30 };

  const picked = selectPictures({ trigger, history: [replied, local], visionCfg, now, channelId: 'dest' });
  assert.deepEqual(picked.map((p) => p.itemId), ['local'], 'only the turn channel\'s own recent picture');
  const here = { ...trigger, channelId: 'dest' };
  const sameChannel = selectPictures({ trigger: here, history: [replied, local, here], visionCfg, now, channelId: 'dest' });
  assert.deepEqual(sameChannel.map((p) => p.itemId), ['replied', 'local', 'trig'], 'the same trigger in the turn\'s channel gives both tiers');
  assert.deepEqual(selectPictures({ trigger: sticker, history: [], visionCfg, now, channelId: 'dest' }), []);
});

test('selectPictures: a trigger in the turn\'s channel, or with either channel id unknown, keeps its pictures first', () => {
  const now = 1_000_000;
  const visionCfg = { maxImages: 4, recentImages: 3, recentImageMinutes: 30 };
  const here = { ...pictureMessage('t', now, 'trig'), channelId: 'dest' };
  assert.deepEqual(selectPictures({ trigger: here, history: [here], visionCfg, now, channelId: 'dest' }).map((p) => p.itemId), ['trig']);
  const unknown = pictureMessage('u', now, 'trig-u');
  assert.deepEqual(selectPictures({ trigger: unknown, history: [], visionCfg, now, channelId: 'dest' }).map((p) => p.itemId), ['trig-u']);
  const elsewhere = { ...pictureMessage('e', now, 'trig-e'), channelId: 'source' };
  assert.deepEqual(selectPictures({ trigger: elsewhere, history: [], visionCfg, now }).map((p) => p.itemId), ['trig-e'], 'no channelId: as before');
});

// --- stickerUrl / linkThumbnailCacheKey ------------------------

test('stickerUrl: a picture format sizes to media.discordapp.net/.../<id>.<ext>?size=160; Lottie and unknown formats are null', () => {
  const rows = [
    { label: 'PNG (format 1)', format: 1, expected: 'https://media.discordapp.net/stickers/123.png?size=160' },
    { label: 'APNG (format 2)', format: 2, expected: 'https://media.discordapp.net/stickers/123.png?size=160' },
    { label: 'GIF (format 4), never cdn.discordapp.com', format: 4, expected: 'https://media.discordapp.net/stickers/123.gif?size=160' },
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

test('stickerLabelFor: a Lottie sticker (url null) is always the plain name form, ignoring attached/description', () => {
  assert.deepEqual(stickerLabelFor(sticker('dancing-cat', null)), { key: 'sticker', values: { name: 'dancing-cat' } });
  assert.deepEqual(stickerLabelFor(sticker('dancing-cat', null), { attachedIndex: 1, description: 'a cat dances' }), {
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

test('stickerLabelFor: attached wins over described, keeps the sticker tag and adds frameAttached', () => {
  const result = stickerLabelFor(sticker('pepe', 'https://x'), { attachedIndex: 2, description: 'a frog gives a thumbs up' });
  assert.deepEqual(result, {
    key: 'stickerDescribed',
    values: { name: 'pepe', text: 'a frog gives a thumbs up' },
    extra: { key: 'frameAttached', values: { n: 2 } },
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
  assert.deepEqual(pictures.map((p) => p.itemId), ['sticker:s1']);
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
  assert.deepEqual(items.map((i) => i.itemId), ['emoji:e1', 'emoji:e2']);
  assert.ok(items.every((i) => i.source === 'emoji' && isDescribable(i)));
  // Never eligible for vision: collectPictures ignores message.emojis entirely.
  assert.deepEqual(collectPictures(m).map((p) => p.itemId), []);
});

// --- selectPictures: sticker vision eligibility ---------------------------

test('selectPictures: the trigger\'s own picture-format sticker is eligible, same priority as its images', () => {
  const now = 1_000_000;
  const trigger = stickerMessage('t', now, [
    { id: 's1', name: 'pepe', format: 1, url: 'https://media.discordapp.net/stickers/s1.png?size=160' },
  ]);
  const picked = selectPictures({ trigger, history: [trigger], visionCfg: { maxImages: 4, recentImages: 3, recentImageMinutes: 30 }, now });
  assert.deepEqual(picked.map((p) => p.itemId), ['sticker:s1']);
});

test('selectPictures: a sticker on the REPLIED-TO message is never vision-eligible, only the trigger\'s own', () => {
  const now = 1_000_000;
  const replied = stickerMessage('r', now - 5 * MIN, [
    { id: 's1', name: 'pepe', format: 1, url: 'https://media.discordapp.net/stickers/s1.png?size=160' },
  ]);
  const trigger = { ...message('t', { ts: now }), replyToId: 'r' };
  const picked = selectPictures({
    trigger,
    history: [replied, trigger],
    visionCfg: { maxImages: 4, recentImages: 3, recentImageMinutes: 30 },
    now,
  });
  assert.deepEqual(picked, []);
});

test('selectPictures: a sticker in the "recent" tier is never vision-eligible, even with room to spare', () => {
  const now = 1_000_000;
  const recent = stickerMessage('m1', now - MIN, [
    { id: 's1', name: 'pepe', format: 1, url: 'https://media.discordapp.net/stickers/s1.png?size=160' },
  ]);
  const picked = selectPictures({
    trigger: null,
    history: [recent],
    visionCfg: { maxImages: 4, recentImages: 3, recentImageMinutes: 30 },
    now,
  });
  assert.deepEqual(picked, []);
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

test('mediaLabelFor: a watched link with an answer -> linkWatched, then videoAnswered (after frameAttached too)', () => {
  const item = { kind: 'link', site: 's', title: 't', thumbnailUrl: 'https://x/y.jpg' };
  const video = { state: 'watched', text: 'a talk', answer };
  const answered = { key: 'videoAnswered', values: { question: answer.question, text: answer.text } };
  assert.deepEqual(mediaLabelFor(item, { video }).extra, [{ key: 'linkWatched', values: { text: 'a talk' } }, answered]);
  assert.deepEqual(mediaLabelFor(item, { attachedIndex: 1, video }).extra, [
    { key: 'frameAttached', values: { n: 1 } },
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

test('mediaLabelFor: an attached picture with an answer appends imageAnswered after imageAttached(Described)', () => {
  assert.deepEqual(mediaLabelFor(picture, { attachedIndex: 2, answer }), { key: 'imageAttached', values: { n: 2 }, extra: pictureAnswered });
  assert.deepEqual(mediaLabelFor(picture, { attachedIndex: 2, description: 'deux singes', answer }), {
    key: 'imageAttachedDescribed',
    values: { n: 2, text: 'deux singes' },
    extra: pictureAnswered,
  });
});

test('mediaLabelFor: an answer on a video item is ignored (its answer lives in its state)', () => {
  assert.deepEqual(mediaLabelFor(clip, { answer }), { key: 'video', values: { name: 'clip.mp4', duration: '1:05' } });
});

test('mediaLabelFor: a GIF\'s second look appends videoAnswered after its tag, attached, described or known alike', () => {
  const answered = { key: 'videoAnswered', values: { question: answer.question, text: answer.text } };
  assert.deepEqual(mediaLabelFor({ kind: 'gif', name: 'a.gif' }, { answer }), { key: 'gif', values: { name: 'a.gif' }, extra: answered });
  assert.deepEqual(mediaLabelFor({ kind: 'gif', name: 'a.gif' }, { answer, description: 'un miroir' }), {
    key: 'gifDescribed',
    values: { text: 'un miroir' },
    extra: answered,
  });
  assert.deepEqual(mediaLabelFor({ kind: 'gif', name: 'a.gif' }, { answer, description: 'un miroir', gifHandle: 'g3' }), {
    key: 'gifKnown',
    values: { id: 'g3', text: 'un miroir' },
    extra: answered,
  });
  assert.deepEqual(mediaLabelFor({ kind: 'gif', name: 'a.gif' }, { answer, attachedIndex: 2 }), {
    key: 'gif',
    values: { name: 'a.gif' },
    extra: [{ key: 'frameAttached', values: { n: 2 } }, answered],
  });
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

test('mediaLabelFor: linkRead follows thumbnailDescribed, and frameAttached when the thumbnail is attached', () => {
  const item = { kind: 'link', site: 's', title: 't', thumbnailUrl: 'https://x/y.jpg' };
  const read = { key: 'linkRead', values: { text: 'page gist' } };
  assert.deepEqual(mediaLabelFor(item, { description: 'thumb', read: 'page gist' }).extra, [
    { key: 'thumbnailDescribed', values: { text: 'thumb' } },
    read,
  ]);
  assert.deepEqual(mediaLabelFor(item, { attachedIndex: 2, read: 'page gist' }).extra, [{ key: 'frameAttached', values: { n: 2 } }, read]);
});

test('mediaLabelFor: linkRead comes after frameAttached, the video extra and videoAnswered', () => {
  const item = { kind: 'link', site: 's', title: 't', thumbnailUrl: 'https://x/y.jpg' };
  const video = { state: 'watched', text: 'a talk', answer };
  assert.deepEqual(mediaLabelFor(item, { attachedIndex: 1, video, read: 'page gist' }).extra, [
    { key: 'frameAttached', values: { n: 1 } },
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
  assert.deepEqual(mediaLabelFor({ kind: 'gif', name: 'cat.gif' }, { read: 'x' }), { key: 'gif', values: { name: 'cat.gif' } });
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
    ['m1#e0', 'm1#e4'],
  );
  assert.deepEqual(items[0], { id: 'm1#e0', messageId: 'm1', url: 'https://example.org/a', site: 'example.org', title: 'Á' });
});

test('collectReadableLinks: no sites keeps video-site links; no links -> []', () => {
  const message = { id: 'm1', links: [{ id: 'v', kind: 'link', site: 'youtube.com', title: '', url: 'https://youtu.be/abc' }] };
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
    links: [{ id: 'outer#e0', kind: 'link', url: 'https://example.org/own', site: 'example.org', title: 'Own', thumbnailUrl: null }],
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
          { id: 'fwd#e1', kind: 'link', url: 'https://news.example.com/story', site: 'news.example.com', title: 'Story', thumbnailUrl: null },
        ],
        stickers: [{ id: 's-fwd', name: 'wave', format: 1, url: 'https://media.discordapp.net/stickers/s-fwd.png?size=160' }],
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

test('collectPictures: forwarded snapshots follow the message\'s own pictures, in order, with the outer messageId', () => {
  const pictures = collectPictures(forwardMessage());
  assert.deepEqual(
    pictures.map((p) => p.itemId),
    ['own-a', 'fwd-a1', 'video:url:yt1', 'sticker:s-fwd', 'fwd-a3'],
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

test('collectEmojiItems: a forwarded snapshot\'s custom emoji follow the message\'s own, with the outer messageId', () => {
  const items = collectEmojiItems(forwardMessage());
  assert.deepEqual(items.map((i) => i.itemId), ['emoji:e-own', 'emoji:e-fwd1', 'emoji:e-fwd2']);
  assert.ok(items.every((i) => i.messageId === 'outer' && i.source === 'emoji'));
});

test('collectVideos: a forwarded YouTube link is a candidate with its site set (the forwarded-video case)', () => {
  const items = collectVideos(forwardMessage(), { videoSites: ['youtube.com', 'youtu.be'] });
  assert.deepEqual(items, [
    { source: 'attachment', messageId: 'outer', itemId: 'fwd-a1', kind: 'video', url: 'u-fwd1', name: 'clip.mp4', durationSec: 30, bytes: 4096 },
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

test('collectReadableLinks: forwarded plain links follow the message\'s own, video-site links still excluded', () => {
  const items = collectReadableLinks(forwardMessage(), { videoSites: ['youtube.com'] });
  assert.deepEqual(items, [
    { id: 'outer#e0', messageId: 'outer', url: 'https://example.org/own', site: 'example.org', title: 'Own' },
    { id: 'fwd#e1', messageId: 'outer', url: 'https://news.example.com/story', site: 'news.example.com', title: 'Story' },
  ]);
});

test('selectPictures: a forwarded picture on the trigger is eligible and sorted by the outer message', () => {
  const now = 1_000_000;
  const trigger = {
    ...message('t', { ts: now }),
    forwarded: [{ content: '', attachments: [{ id: 'fa', kind: 'image', url: 'u-fa', name: 'fa.png' }], links: [], stickers: [] }],
  };
  const picked = selectPictures({ trigger, history: [trigger], visionCfg: { maxImages: 4, recentImages: 3, recentImageMinutes: 30 }, now });
  assert.deepEqual(picked.map((p) => [p.itemId, p.messageId]), [['fa', 't']]);
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
  const known = new Map([['v2', { state: 'watched', text: 'ένα ποτάμι' }], ['zz', { state: 'error' }]]);
  const states = lateVideoStates(candidates, known, 2);
  assert.deepEqual([...states], [
    ['v1', { state: 'pending' }],
    ['v2', { state: 'watched', text: 'ένα ποτάμι' }],
    ['v3', { state: 'pending' }],
  ]);
});

test('lateVideoStates: no known states and no candidates', () => {
  assert.deepEqual([...lateVideoStates([{ itemId: 'v1' }, { itemId: 'v2' }], undefined, 1)], [['v1', { state: 'pending' }]]);
  assert.deepEqual([...lateVideoStates([], new Map(), 1)], []);
  assert.deepEqual([...lateVideoStates([{ itemId: 'v1' }], null, 0)], []);
});

test('mediaLabelFor: a library GIF with a reaction or on-screen text -> gifKnownFields beside the caption', () => {
  const gif = { kind: 'gif', name: 'a.gif' };
  const all = { reaction: 'accord ferme', action: 'un chat lève le menton', screen: 'ναι' };
  assert.deepEqual(mediaLabelFor(gif, { gifHandle: 'g3', description: 'un chat lève le menton', gifFields: all }), {
    key: 'gifKnownFields',
    values: { id: 'g3', text: 'un chat lève le menton', reaction: 'accord ferme', action: 'un chat lève le menton', screen: 'ναι' },
  });
  assert.deepEqual(mediaLabelFor(gif, { gifHandle: 'g3', description: 'ναι', gifFields: { screen: 'ναι' } }).values, {
    id: 'g3',
    text: 'ναι',
    reaction: '',
    action: '',
    screen: 'ναι',
  });
  const reactionOnly = mediaLabelFor(gif, { gifHandle: 'g3', description: 'x', gifFields: { reaction: 'accord', action: '', screen: '' } });
  assert.equal(reactionOnly.key, 'gifKnownFields');
  const attached = mediaLabelFor(gif, { gifHandle: 'g3', description: 'x', gifFields: all, attachedIndex: 1 });
  assert.equal(attached.key, 'gifKnownFields', 'an attached GIF alike');
});

test('mediaLabelFor: gifKnownFields needs a handle, a caption and a reaction or on-screen text', () => {
  const gif = { kind: 'gif', name: 'a.gif' };
  const all = { reaction: 'accord ferme', action: 'un chat lève le menton', screen: 'ναι' };
  assert.deepEqual(mediaLabelFor(gif, { description: 'un chat', gifFields: all }), { key: 'gifDescribed', values: { text: 'un chat' } }, 'no handle: the caption alone');
  assert.deepEqual(mediaLabelFor(gif, { gifHandle: 'g3', description: 'un chat', gifFields: { reaction: '', action: 'un chat', screen: '' } }), {
    key: 'gifKnown',
    values: { id: 'g3', text: 'un chat' },
  });
  assert.equal(mediaLabelFor(gif, { gifHandle: 'g3', gifFields: all }).key, 'gifKnownNoText', 'no caption');
  assert.deepEqual(mediaLabelFor({ kind: 'image' }, { gifHandle: 'g3', gifFields: all }), { key: 'image', values: {} });
});
