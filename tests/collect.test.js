// Tests for interfaces/discord/collect.js: normalizeMessage's media handling (voice
// flag, embed classification, raw-URL de-duplication, forwarded snapshots),
// its mention ids, the lazy text-attachment preview fetch, the bot's channel
// permissions, readable channels and neighbours, and the audience reader.
// Discord objects are plain fixtures shaped just enough for the code to read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMessage,
  normalizeOptions,
  normalizedOf,
  toEvent,
  reactionEvent,
  fetchTextPreview,
  withTextPreviews,
  fetchHistory,
  fetchMessage,
  fetchReplyParents,
  canAttach,
  canSend,
  canRead,
  canReact,
  fetchNeighbors,
  readableChannels,
  isReadableChannel,
  isWritableChannel,
  audienceOf,
} from '../src/interface/discord.js';
import { ChannelType, Embed, MessageReferenceType, OverwriteType, PermissionFlagsBits, PermissionsBitField, SnowflakeUtil } from 'discord.js';
import { videoUrlCacheKey } from '../src/media/video-sites.js';
import { collectPictures, collectVideos } from '../src/media/classify.js';
import { audienceCovers } from '../src/behavior/elsewhere.js';
import { emptyGifs, mergeGifs } from '../src/memory/gifs.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { formatTranscript } from '../src/format.js';
import { labels } from './fixtures/labels.js';
import { validateEvent } from '../src/protocol/index.js';

function flagsWith(names) {
  const set = new Set(names);
  return { has: (name) => set.has(name) };
}

function rawMessage(overrides = {}) {
  return {
    id: 'm1',
    channelId: 'c1',
    channel: { name: 'general' },
    author: { id: 'u1', bot: false, globalName: 'Alice', username: 'alice' },
    member: { displayName: 'Alice' },
    cleanContent: 'hello',
    createdTimestamp: 1000,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
    embeds: [],
    messageSnapshots: new Map(),
    flags: flagsWith([]),
    ...overrides,
  };
}

test('normalizeMessage: classifies attachments through media.js, keeping url/size/duration', () => {
  const raw = rawMessage({
    attachments: new Map([
      ['a1', { id: 'a1', contentType: 'image/png', name: 'pic.png', url: 'https://cdn/pic.png', size: 123 }],
      ['a2', { id: 'a2', contentType: 'video/mp4', name: 'clip.mp4', url: 'https://cdn/clip.mp4', size: 456, duration: null }],
    ]),
  });
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.attachments[0], {
    id: 'a1',
    kind: 'image',
    name: 'pic.png',
    url: 'https://cdn/pic.png',
    size: 123,
    durationSec: null,
    width: null,
    height: null,
  });
  assert.equal(m.attachments[1].kind, 'video');
});

test('normalizeMessage: an attachment carries its pixel size from discord.js, null when Discord gives none', () => {
  const raw = rawMessage({
    attachments: new Map([
      ['a1', { id: 'a1', contentType: 'image/png', name: 'pic.png', url: 'https://cdn/pic.png', size: 1, width: 988, height: 1306 }],
      ['a2', { id: 'a2', contentType: 'text/plain', name: 'a.txt', url: 'https://cdn/a.txt', size: 1, width: null, height: null }],
    ]),
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.attachments[0].width, 988);
  assert.equal(m.attachments[0].height, 1306);
  assert.equal(m.attachments[1].width, null);
  assert.equal(m.attachments[1].height, null);
  const [picture] = collectPictures(m);
  assert.equal(picture.width, 988);
  assert.equal(picture.height, 1306);
});

test('normalizeMessage: the voice-message flag reclassifies an audio attachment as voice, without it the attachment stays audio', () => {
  const rows = [
    {
      label: 'a voice-message flag reclassifies the attachment as voice',
      flags: ['IsVoiceMessage'],
      attachment: { id: 'a1', contentType: 'audio/ogg', name: 'voice-message.ogg', url: 'https://cdn/v.ogg', duration: 12 },
      expected: { kind: 'voice', durationSec: 12 },
    },
    {
      label: 'no voice flag leaves the same attachment as audio',
      flags: [],
      attachment: { id: 'a1', contentType: 'audio/ogg', name: 'song.ogg', url: 'https://cdn/v.ogg' },
      expected: { kind: 'audio' },
    },
  ];
  for (const { label, flags, attachment, expected } of rows) {
    const m = normalizeMessage(rawMessage({ flags: flagsWith(flags), attachments: new Map([['a1', attachment]]) }), 'self');
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(m.attachments[0][key], value, `${label}: ${key}`);
    }
  }
});

test('normalizeMessage: an embed becomes a link item and its URL stays in the content where it was posted', () => {
  const raw = rawMessage({
    cleanContent: 'check this out https://example.com/page cool right',
    embeds: [{ url: 'https://example.com/page', title: 'A page', description: 'desc', provider: null }],
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.links.length, 1);
  assert.equal(m.links[0].kind, 'link');
  assert.equal(m.links[0].site, 'example.com');
  assert.equal(m.content, 'check this out https://example.com/page cool right');
});

test('normalizeMessage: a tenor gifv embed keeps its mp4 as animationUrl, in the message and in a forward', () => {
  const gifv = {
    url: 'https://tenor.com/view/x',
    provider: { name: 'Tenor' },
    thumbnail: { url: 'https://media.tenor.com/x.png' },
    video: { url: 'https://media.tenor.com/x.mp4', proxyURL: 'https://images-ext-1.discordapp.net/external/v/x.mp4' },
  };
  const raw = rawMessage({
    cleanContent: 'https://tenor.com/view/x',
    embeds: [gifv],
    messageSnapshots: new Map([
      ['snap1', { id: 'snap1', cleanContent: '', attachments: new Map(), embeds: [gifv], stickers: new Map(), flags: flagsWith([]) }],
    ]),
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.links[0].kind, 'gif');
  assert.equal(m.links[0].animationUrl, 'https://images-ext-1.discordapp.net/external/v/x.mp4');
  assert.equal(m.forwarded[0].links[0].id, 'snap1#e0');
  assert.equal(m.forwarded[0].links[0].animationUrl, 'https://images-ext-1.discordapp.net/external/v/x.mp4');
});

test('normalizeMessage: a GIF-picker post (a gifv embed of an unknown provider) reaches the library with the page to post and the video to watch', () => {
  const page = 'https://gifs.example.net/gifs/dancing-cat';
  const embed = new Embed({
    type: 'gifv',
    url: page,
    provider: { name: 'Gifland' },
    thumbnail: { url: 'https://static.gifs.example.net/x/still.webp' },
    video: { url: 'https://static.gifs.example.net/x/loop.mp4' },
  });
  const m = normalizeMessage(rawMessage({ cleanContent: page, content: page, embeds: [embed] }), 'self');
  assert.equal(m.content, '', 'the page URL is not left in the text');
  assert.equal(m.links[0].kind, 'gif');

  const { gifs, counted } = mergeGifs(emptyGifs(), [m]);
  assert.equal(counted, 1);
  const [entry] = Object.values(gifs.entries);
  assert.equal(entry.kind, 'link');
  assert.equal(entry.url, page, 'what the persona posts back');

  const [picture] = collectPictures(m);
  assert.equal(picture.kind, 'gif');
  assert.equal(picture.itemId, entry.itemId, 'its caption lands where the library looks');
  assert.equal(picture.animationUrl, 'https://static.gifs.example.net/x/loop.mp4', 'what the GIF watch downloads');
  assert.equal(picture.url, 'https://static.gifs.example.net/x/still.webp', 'the still frame');
});

test('normalizeMessage: a pasted Discord-hosted .gif link is a gif item to watch, a .png link stays a link', () => {
  const url = 'https://media.discordapp.net/attachments/1/2/dance.gif?ex=1&is=2&hm=3';
  const proxy = 'https://media.discordapp.net/attachments/1/2/dance.gif?ex=1&is=2&hm=3&width=498&height=280';
  const embed = new Embed({ type: 'image', url, thumbnail: { url, proxy_url: proxy, width: 498, height: 280, content_type: 'image/gif' } });
  const m = normalizeMessage(rawMessage({ cleanContent: url, content: url, embeds: [embed] }), 'self');
  assert.deepEqual(m.attachments, []);
  assert.equal(m.links.length, 1);
  assert.equal(m.links[0].kind, 'gif');
  assert.equal(m.links[0].id, 'm1#e0');
  assert.equal(m.links[0].thumbnailUrl, proxy);
  assert.equal(m.content, '', 'the URL is not left in the text');
  const [picture] = collectPictures(m);
  assert.equal(picture.kind, 'gif');
  assert.equal(picture.url, proxy, 'the still frame, the fallback');
  assert.equal(picture.animationUrl, url, 'what the GIF watch downloads');

  const png = 'https://media.discordapp.net/attachments/1/3/photo.png?ex=1&is=2&hm=3';
  const pngEmbed = new Embed({ type: 'image', url: png, thumbnail: { url: png, proxy_url: png, width: 10, height: 10, content_type: 'image/png' } });
  const p = normalizeMessage(rawMessage({ cleanContent: png, content: png, embeds: [pngEmbed] }), 'self');
  assert.equal(p.links[0].kind, 'link');
  assert.equal('animationUrl' in p.links[0], false);
  assert.equal(collectPictures(p)[0].kind, 'link');
});

test('normalizeMessage: a gifv embed on a configured video site stays a video link', () => {
  const url = 'https://x.com/someone/status/1';
  const embed = new Embed({ type: 'gifv', url, thumbnail: { url: 'https://pbs.example.net/t.jpg' }, video: { url: 'https://video.example.net/v.mp4' } });
  const m = normalizeMessage(rawMessage({ cleanContent: url, embeds: [embed] }), 'self', { videoSites: ['x.com'] });
  assert.equal(m.links[0].kind, 'link');
  assert.equal(m.links[0].id, videoUrlCacheKey(url));
});

test('normalizeMessage: an embed with no URL is skipped entirely (nothing to de-dupe or render)', () => {
  const raw = rawMessage({ embeds: [{ url: null, title: 'no url' }] });
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.links, []);
});

test('normalizeMessage: link ids are stable and unique per embed index on the message', () => {
  const raw = rawMessage({
    embeds: [
      { url: 'https://a.example', title: 'a' },
      { url: 'https://b.example', title: 'b' },
    ],
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.links[0].id, 'm1#e0');
  assert.equal(m.links[1].id, 'm1#e1');
});

test('normalizeMessage: a forwarded message (snapshot) is captured with its own content and media', () => {
  const raw = rawMessage({
    cleanContent: '',
    messageSnapshots: new Map([
      [
        'snap1',
        {
          id: 'snap1',
          cleanContent: 'forwarded text',
          attachments: new Map([['f1', { id: 'f1', contentType: 'image/png', name: 'f.png', url: 'https://cdn/f.png' }]]),
          embeds: [],
          stickers: new Map(),
          flags: flagsWith([]),
        },
      ],
    ]),
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.forwarded.length, 1);
  assert.equal(m.forwarded[0].content, 'forwarded text');
  assert.equal(m.forwarded[0].attachments[0].kind, 'image');
});

// --- normalizeMessage: stickers ----------------------------------------

function sticker(id, name, format) {
  return { id, name, format };
}

test('normalizeMessage: stickers become { id, name, format, url }, PNG/APNG/GIF sized via media.discordapp.net', () => {
  const raw = rawMessage({
    stickers: new Map([
      ['s1', sticker('s1', 'pepe', 1)],
      ['s2', sticker('s2', 'wave', 2)],
      ['s3', sticker('s3', 'dance', 4)],
    ]),
  });
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.stickers[0], { id: 's1', name: 'pepe', format: 1, url: 'https://media.discordapp.net/stickers/s1.png?size=160' });
  assert.deepEqual(m.stickers[1], { id: 's2', name: 'wave', format: 2, url: 'https://media.discordapp.net/stickers/s2.png?size=160' });
  assert.deepEqual(m.stickers[2], { id: 's3', name: 'dance', format: 4, url: 'https://media.discordapp.net/stickers/s3.gif?size=160' });
});

// --- normalizeMessage: custom emoji extraction -------------------------
// discord.js's Message#cleanContent already rewrites <:name:id> into :name:,
// so the fixtures carry the raw markup in `content` and the cleaned text in
// `cleanContent`, as discord.js really yields them.

const PEPE_ID = '123456789012345678';

test('normalizeMessage: custom emoji are read from the raw content, text from cleanContent', () => {
  const raw = rawMessage({ content: `hi <:pepe:${PEPE_ID}>`, cleanContent: 'hi :pepe:' });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.content, 'hi :pepe:');
  assert.deepEqual(m.emojis, [{ id: PEPE_ID, name: 'pepe', animated: false, url: `https://cdn.discordapp.com/emojis/${PEPE_ID}.webp?size=96` }]);
});

test('normalizeMessage: an animated custom emoji in the raw content is marked animated', () => {
  const raw = rawMessage({ content: `hi <a:pepe:${PEPE_ID}>`, cleanContent: 'hi :pepe:' });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.content, 'hi :pepe:');
  assert.deepEqual(m.emojis, [{ id: PEPE_ID, name: 'pepe', animated: true, url: `https://cdn.discordapp.com/emojis/${PEPE_ID}.webp?size=96` }]);
});

test('normalizeMessage: without a raw content, custom emoji fall back to cleanContent', () => {
  const raw = rawMessage({ content: undefined, cleanContent: `hi <:pepe:${PEPE_ID}>` });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.content, 'hi :pepe:');
  assert.deepEqual(m.emojis.map((e) => e.name), ['pepe']);
});

test('normalizeMessage: the same custom emoji repeated in one message is de-duplicated', () => {
  const raw = rawMessage({ content: '<:pog:111> <:pog:111> <:pog:111>', cleanContent: ':pog: :pog: :pog:' });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.emojis.length, 1);
});

test('normalizeMessage: distinct custom emoji are capped at 5 per message, first-appearance order', () => {
  const ids = Array.from({ length: 8 }, (_, i) => i + 1);
  const content = ids.map((id) => `<:e${id}:${id}>`).join(' ');
  const raw = rawMessage({ content, cleanContent: ids.map((id) => `:e${id}:`).join(' ') });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.emojis.length, 5);
  assert.deepEqual(m.emojis.map((e) => e.id), ['1', '2', '3', '4', '5']);
});

test('normalizeMessage: reactions are read with count and the bot\'s own mark', () => {
  const raw = rawMessage({
    reactions: {
      cache: new Map([
        ['a', { emoji: { id: null, name: '🍣' }, count: 2, me: false }],
        ['b', { emoji: { id: null, name: '👍' }, count: 5, me: true }],
        ['c', { emoji: { id: null, name: '🔥' }, count: 2, me: false }],
        ['d', { emoji: { id: null, name: '❓' }, count: 0, me: false }],
      ]),
    },
  });
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.reactions, [
    { emoji: '👍', count: 5, mine: true },
    { emoji: '🍣', count: 2, mine: false },
    { emoji: '🔥', count: 2, mine: false },
  ]);
});

test('normalizeMessage: a custom emoji reaction is named :name:', () => {
  const raw = rawMessage({
    reactions: { cache: new Map([['123', { emoji: { id: '123', name: 'κάτι' }, count: 1, me: false }]]) },
  });
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.reactions, [{ emoji: ':κάτι:', count: 1, mine: false }]);
});

test('normalizeMessage: a forwarded snapshot also carries its own stickers and emoji', () => {
  const raw = rawMessage({
    cleanContent: '',
    messageSnapshots: new Map([
      [
        'snap1',
        {
          id: 'snap1',
          content: 'look <:pog:111>',
          cleanContent: 'look :pog:',
          attachments: new Map(),
          embeds: [],
          stickers: new Map([['s1', sticker('s1', 'pepe', 1)]]),
          flags: flagsWith([]),
        },
      ],
    ]),
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.forwarded[0].content, 'look :pog:');
  assert.deepEqual(m.forwarded[0].emojis, [{ id: '111', name: 'pog', animated: false, url: 'https://cdn.discordapp.com/emojis/111.webp?size=96' }]);
  assert.deepEqual(m.forwarded[0].stickers, [{ id: 's1', name: 'pepe', format: 1, url: 'https://media.discordapp.net/stickers/s1.png?size=160' }]);
});

// --- normalizeMessage: describable link thumbnails get a stable id ----

test('normalizeMessage: a link embed with a thumbnail (e.g. YouTube) gets a stable hash id, not the per-message index', () => {
  const raw = rawMessage({
    embeds: [
      {
        url: 'https://www.youtube.com/watch?v=xyz',
        provider: { name: 'YouTube' },
        title: 'Cool video',
        thumbnail: { url: 'https://i.ytimg.com/vi/xyz/hq.jpg' },
      },
    ],
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.links[0].kind, 'link');
  assert.ok(m.links[0].id.startsWith('link:'));
  assert.notEqual(m.links[0].id, 'm1#e0');
});

test('normalizeMessage: the same link thumbnail on two different messages gets the same stable id', () => {
  const embed = () => ({
    url: 'https://www.youtube.com/watch?v=xyz',
    provider: { name: 'YouTube' },
    title: 'Cool video',
    thumbnail: { url: 'https://i.ytimg.com/vi/xyz/hq.jpg?ex=1&hm=aaa' },
  });
  const m1 = normalizeMessage(rawMessage({ id: 'm1', embeds: [embed()] }), 'self');
  const m2 = normalizeMessage(
    rawMessage({ id: 'm2', embeds: [{ ...embed(), thumbnail: { url: 'https://i.ytimg.com/vi/xyz/hq.jpg?ex=9&hm=zzz' } }] }),
    'self',
  );
  assert.equal(m1.links[0].id, m2.links[0].id);
});

test('normalizeMessage: an embed thumbnail prefers proxyURL over url when discord.js exposes one', () => {
  const raw = rawMessage({
    embeds: [
      {
        url: 'https://www.youtube.com/watch?v=xyz',
        provider: { name: 'YouTube' },
        title: 'Cool video',
        thumbnail: { url: 'https://i.ytimg.com/vi/xyz/hq.jpg', proxyURL: 'https://media.discordapp.net/external/abc/hq.jpg' },
      },
    ],
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.links[0].thumbnailUrl, 'https://media.discordapp.net/external/abc/hq.jpg');
});

test('normalizeMessage: a link thumbnail carries its pixel size from the embed thumbnail, through to its picture item', () => {
  const raw = rawMessage({
    embeds: [
      {
        url: 'https://www.youtube.com/watch?v=xyz',
        provider: { name: 'YouTube' },
        title: 'Cool video',
        thumbnail: { url: 'https://i.ytimg.com/vi/xyz/hq.jpg', width: 1280, height: 720 },
      },
      { url: 'https://example.org/page', title: 'No size', thumbnail: { url: 'https://example.org/t.jpg' } },
    ],
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.links[0].thumbnailWidth, 1280);
  assert.equal(m.links[0].thumbnailHeight, 720);
  assert.equal(m.links[1].thumbnailWidth, null);
  assert.equal(m.links[1].thumbnailHeight, null);
  const pictures = collectPictures(m);
  assert.deepEqual(
    pictures.map((p) => [p.width, p.height]),
    [
      [1280, 720],
      [null, null],
    ],
  );
});

// --- normalizeMessage: video-site URLs typed in the text ----------------------

const VIDEO_SITES = ['youtube.com', 'youtu.be'];

test('normalizeMessage: a typed video-site URL becomes a synthetic link, its URL stays in the text', () => {
  const raw = rawMessage({ cleanContent: 'mira esto https://www.youtube.com/watch?v=abc&t=5 qué risa' });
  const m = normalizeMessage(raw, 'self', { videoSites: VIDEO_SITES });
  assert.equal(m.links.length, 1);
  assert.deepEqual(m.links[0], {
    id: videoUrlCacheKey('https://www.youtube.com/watch?v=abc&t=5'),
    kind: 'link',
    site: 'youtube.com',
    title: '',
    text: '',
    thumbnailUrl: null,
    url: 'https://www.youtube.com/watch?v=abc&t=5',
  });
  assert.ok(m.links[0].id.startsWith('video:url:'));
  assert.equal(m.content, 'mira esto https://www.youtube.com/watch?v=abc&t=5 qué risa');
});

test('normalizeMessage: a URL on a site outside videoSites adds no link', () => {
  const raw = rawMessage({ cleanContent: 'https://example.com/clip' });
  assert.deepEqual(normalizeMessage(raw, 'self', { videoSites: VIDEO_SITES }).links, []);
});

test('normalizeMessage: a typed URL that an embed already carries is added once (the embed), id = the video cache key', () => {
  const url = 'https://www.youtube.com/watch?v=xyz';
  const raw = rawMessage({
    cleanContent: `look ${url}`,
    embeds: [{ url, provider: { name: 'YouTube' }, title: 'Cool video', thumbnail: { url: 'https://i.ytimg.com/vi/xyz/hq.jpg' } }],
  });
  const m = normalizeMessage(raw, 'self', { videoSites: VIDEO_SITES });
  assert.equal(m.links.length, 1);
  assert.equal(m.links[0].id, videoUrlCacheKey(url));
  assert.equal(m.links[0].title, 'Cool video');
  assert.equal(m.content, `look ${url}`);
});

test('normalizeMessage: a typed youtu.be link and a watch?v= embed of one video are one link with the canonical key', () => {
  const raw = rawMessage({
    cleanContent: 'δες https://youtu.be/ID42',
    embeds: [
      {
        url: 'https://www.youtube.com/watch?v=ID42',
        provider: { name: 'YouTube' },
        title: 'Cool video',
        thumbnail: { url: 'https://i.ytimg.com/vi/ID42/hq.jpg' },
      },
    ],
  });
  const m = normalizeMessage(raw, 'self', { videoSites: VIDEO_SITES });
  assert.equal(m.links.length, 1);
  assert.equal(m.links[0].id, videoUrlCacheKey('https://youtube.com/watch?v=ID42'));
  assert.equal(m.links[0].id, videoUrlCacheKey('https://youtu.be/ID42'));
  assert.equal(m.links[0].title, 'Cool video');
  assert.equal(m.links[0].thumbnailUrl, 'https://i.ytimg.com/vi/ID42/hq.jpg');
});

test('normalizeMessage: with videoSites set, a non-video embed keeps its existing id', () => {
  const raw = rawMessage({
    embeds: [
      { url: 'https://example.com/page', title: 'A page', thumbnail: { url: 'https://example.com/t.jpg' } },
      { url: 'https://example.com/other', title: 'Other' },
    ],
  });
  const m = normalizeMessage(raw, 'self', { videoSites: VIDEO_SITES });
  assert.ok(m.links[0].id.startsWith('link:'));
  assert.equal(m.links[1].id, 'm1#e1');
});

test('normalizeMessage: the same typed video URL twice becomes one synthetic link', () => {
  const raw = rawMessage({ cleanContent: 'https://youtu.be/xyz and again https://youtu.be/xyz' });
  const m = normalizeMessage(raw, 'self', { videoSites: VIDEO_SITES });
  assert.equal(m.links.length, 1);
  assert.equal(m.links[0].site, 'youtu.be');
});

test('normalizeMessage: a forwarded snapshot also turns a typed video URL into a synthetic link', () => {
  const raw = rawMessage({
    cleanContent: '',
    messageSnapshots: new Map([
      [
        'snap1',
        {
          id: 'snap1',
          cleanContent: 'δες αυτό https://youtu.be/xyz',
          attachments: new Map(),
          embeds: [],
          stickers: new Map(),
          flags: flagsWith([]),
        },
      ],
    ]),
  });
  const m = normalizeMessage(raw, 'self', { videoSites: VIDEO_SITES });
  assert.equal(m.forwarded[0].links.length, 1);
  assert.equal(m.forwarded[0].links[0].id, videoUrlCacheKey('https://youtu.be/xyz'));
  assert.equal(m.forwarded[0].content, 'δες αυτό https://youtu.be/xyz');
});

// --- normalizeMessage: forward vs. plain reply -------------------------------
// A real forwarded message's own content is empty; `message.reference` is
// `{ type: MessageReferenceType.Forward, channel_id: <source>, guild_id,
// message_id: <the ORIGINAL message> }`; `message.messageSnapshots` carries
// the forwarded content/media/embeds and has no `author`.

function guildWithChannel(id, name) {
  return { channels: { cache: new Map(id ? [[id, { id, name }]] : []) } };
}

test('normalizeMessage: a plain reply keeps replyToId, forwardedFrom stays null', () => {
  const raw = rawMessage({
    guild: guildWithChannel('c1', 'general'),
    reference: { messageId: 'm0', channelId: 'c1' }, // no `type`: an older/plain reply payload
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.replyToId, 'm0');
  assert.equal(m.forwardedFrom, null);
});

test('normalizeMessage: a forward\'s replyToId is null even though message_reference carries the original message id', () => {
  const raw = rawMessage({
    guild: guildWithChannel('c2', 'announcements'),
    reference: { messageId: 'original-msg-id', channelId: 'c2', type: MessageReferenceType.Forward },
    messageSnapshots: new Map([
      ['snap1', { id: 'snap1', cleanContent: 'forwarded text', attachments: new Map(), embeds: [], stickers: new Map(), flags: flagsWith([]) }],
    ]),
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.replyToId, null);
});

test('normalizeMessage: a forward whose source channel resolves in the same guild sets forwardedFrom to its name', () => {
  const raw = rawMessage({
    guild: guildWithChannel('c2', 'announcements'),
    reference: { messageId: 'original-msg-id', channelId: 'c2', type: MessageReferenceType.Forward },
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.forwardedFrom, 'announcements');
});

test('normalizeMessage: a forward whose source channel does not resolve leaves forwardedFrom null', () => {
  const raw = rawMessage({
    guild: guildWithChannel(null, null),
    reference: { messageId: 'original-msg-id', channelId: 'gone-channel', type: MessageReferenceType.Forward },
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.forwardedFrom, null);
});

test('normalizeMessage: a forward with no guild on the message never throws, forwardedFrom stays null', () => {
  const raw = rawMessage({
    guild: undefined,
    reference: { messageId: 'original-msg-id', channelId: 'c2', type: MessageReferenceType.Forward },
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.forwardedFrom, null);
  assert.equal(m.replyToId, null);
});

// --- normalizeMessage: mentionedUserIds ---------------------------------

test('normalizeMessage: mentionedUserIds carries the real mention ids, in order', () => {
  const raw = rawMessage({ mentions: { users: new Map([['u2', {}], ['u3', {}]]) } });
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.mentionedUserIds, ['u2', 'u3']);
});

test('normalizeMessage: mentionedUsers names each mention as the text reads it (the member\'s display name, else the user\'s)', () => {
  const raw = rawMessage({
    mentions: {
      users: new Map([['u2', { globalName: 'Zo\u00eb' }], ['u3', { username: 'bo' }], ['u4', {}]]),
      members: new Map([['u3', { displayName: 'Bo Nick' }]]),
    },
  });
  assert.deepEqual(normalizeMessage(raw, 'self').mentionedUsers, [{ id: 'u2', name: 'Zo\u00eb' }, { id: 'u3', name: 'Bo Nick' }]);
});

// --- normalizeMessage: mentionedChannelIds -------------------------------
// discord.js's cleanContent rewrites <#id> into #name, so the ids are read
// from the RAW content; the text keeps reading as #name.

const CHANNEL_IDS = Array.from({ length: 7 }, (_, i) => `40000000000000000${i}`);

test('normalizeMessage: channel mentions in the raw text become mentionedChannelIds', () => {
  const [a, b] = CHANNEL_IDS;
  const raw = rawMessage({
    content: `είδες το <#${a}>; και <#${b}> πάλι <#${a}> <@${b}> <@&${b}> <#12345>`,
    cleanContent: 'είδες το #ημερολόγιο; και #τέχνη πάλι #ημερολόγιο @Ελένη @ρόλος #12345',
  });
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.mentionedChannelIds, [a, b]);
  assert.equal(m.content, 'είδες το #ημερολόγιο; και #τέχνη πάλι #ημερολόγιο @Ελένη @ρόλος #12345');
  assert.deepEqual(m.mentionedUserIds, []);
});

test('normalizeMessage: no channel mention gives an empty list', () => {
  assert.deepEqual(normalizeMessage(rawMessage(), 'self').mentionedChannelIds, []);
  assert.deepEqual(normalizeMessage(rawMessage({ content: 'απλό κείμενο #γενικό' }), 'self').mentionedChannelIds, []);
  // A forwarded snapshot is not scanned: the forward's own content is empty.
  const forward = rawMessage({
    content: '',
    cleanContent: '',
    reference: { messageId: 'orig', channelId: 'c2', type: MessageReferenceType.Forward },
    messageSnapshots: new Map([
      ['snap1', { id: 'snap1', content: `<#${CHANNEL_IDS[0]}>`, cleanContent: '#ημερολόγιο', attachments: new Map(), embeds: [], stickers: new Map(), flags: flagsWith([]) }],
    ]),
  });
  assert.deepEqual(normalizeMessage(forward, 'self').mentionedChannelIds, []);
});

test('normalizeMessage: at most 5 channel ids in first appearance order', () => {
  const [a, b, c, d, e, f, g] = CHANNEL_IDS;
  const content = [c, a, c, g, b, a, e, d, f].map((id) => `<#${id}>`).join(' ');
  const m = normalizeMessage(rawMessage({ content, cleanContent: 'κανάλια' }), 'self');
  assert.deepEqual(m.mentionedChannelIds, [c, a, g, b, e]);
});

// --- normalizeMessage: replyPingUserId -----------------------------------

test('normalizeMessage: replyPingUserId is the replied-to author put into mentions by the reply ping alone', () => {
  const raw = rawMessage({
    content: 'só isso',
    reference: { messageId: 'm0', channelId: 'c1' },
    mentions: { users: new Map([['u2', {}]]), repliedUser: { id: 'u2' } },
  });
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.mentionedUserIds, ['u2'], 'mentionedUserIds itself is unchanged');
  assert.equal(m.replyPingUserId, 'u2');
});

test('normalizeMessage: replyPingUserId is null when the replied-to author is also typed as <@id>', () => {
  for (const content of ['<@u2> look', '<@!u2> look']) {
    const raw = rawMessage({
      content,
      reference: { messageId: 'm0', channelId: 'c1' },
      mentions: { users: new Map([['u2', {}]]), repliedUser: { id: 'u2' } },
    });
    assert.equal(normalizeMessage(raw, 'self').replyPingUserId, null, content);
  }
});

test('normalizeMessage: replyPingUserId is null for a reply with the ping off (author not in mentions)', () => {
  const raw = rawMessage({
    content: 'quiet reply',
    reference: { messageId: 'm0', channelId: 'c1' },
    mentions: { users: new Map(), repliedUser: { id: 'u2' } },
  });
  assert.equal(normalizeMessage(raw, 'self').replyPingUserId, null);
});

test('normalizeMessage: replyPingUserId is null without a reply, and for a forward', () => {
  assert.equal(normalizeMessage(rawMessage(), 'self').replyPingUserId, null);
  const forward = rawMessage({
    reference: { messageId: 'orig', channelId: 'c2', type: MessageReferenceType.Forward },
    mentions: { users: new Map([['u2', {}]]), repliedUser: { id: 'u2' } },
  });
  assert.equal(normalizeMessage(forward, 'self').replyPingUserId, null);
});

// --- fetchHistory: embedTextChars reaches normalizeMessage -------------------

test('fetchHistory: threads embedTextChars through to the embed classification', async () => {
  const raw = rawMessage({
    embeds: [{ url: 'https://example.com', title: 'x'.repeat(50), description: 'y'.repeat(50) }],
  });
  const channel = { messages: { fetch: async () => new Map([[raw.id, raw]]) } };
  const [message] = await fetchHistory(channel, { limit: 10, selfId: 'self', embedTextChars: 10 });
  assert.equal(message.links[0].title, `${'x'.repeat(10)}…`);
});

test('fetchHistory: threads videoSites through, a typed video-site URL becomes a link item', async () => {
  const raw = rawMessage({ cleanContent: 'regarde https://www.youtube.com/watch?v=abc' });
  const channel = { messages: { fetch: async () => new Map([[raw.id, raw]]) } };

  const [withSites] = await fetchHistory(channel, { limit: 10, selfId: 'self', embedTextChars: 200, videoSites: ['youtube.com'] });
  assert.equal(withSites.links.length, 1);
  assert.equal(withSites.links[0].url, 'https://www.youtube.com/watch?v=abc');

  const [withoutSites] = await fetchHistory(channel, { limit: 10, selfId: 'self', embedTextChars: 200 });
  assert.equal(withoutSites.links.length, 0);
});

test('fetchHistory: asks for at most one page of messages, oldest first in the result', async () => {
  const older = rawMessage({ id: 'm1', createdTimestamp: 1000 });
  const newer = rawMessage({ id: 'm2', createdTimestamp: 2000 });
  const queries = [];
  const channel = {
    messages: {
      fetch: async (query) => {
        queries.push(query);
        return new Map([[newer.id, newer], [older.id, older]]);
      },
    },
  };
  const messages = await fetchHistory(channel, { limit: 500, selfId: 'self' });
  assert.deepEqual(queries, [{ limit: 100 }]);
  assert.deepEqual(messages.map((m) => m.id), ['m1', 'm2']);
});

// --- fetchMessage: cache first, then one fetch, null on failure ----------------

test('fetchMessage: a cached message is returned without a fetch', async () => {
  const cached = rawMessage({ id: 'm7' });
  const fetches = [];
  const channel = {
    messages: {
      cache: new Map([['m7', cached]]),
      fetch: async (id) => {
        fetches.push(id);
        return null;
      },
    },
  };
  assert.equal(await fetchMessage(channel, 'm7'), cached);
  assert.deepEqual(fetches, []);
});

test('fetchMessage: an uncached message is fetched by id', async () => {
  const fetched = rawMessage({ id: 'm8' });
  const fetches = [];
  const channel = {
    messages: {
      cache: new Map(),
      fetch: async (id) => {
        fetches.push(id);
        return fetched;
      },
    },
  };
  assert.equal(await fetchMessage(channel, 'm8'), fetched);
  assert.deepEqual(fetches, ['m8']);
});

test('fetchMessage: a failed or empty fetch, or a channel without a message cache, is null', async () => {
  const failing = { messages: { cache: new Map(), fetch: async () => { throw new Error('Unknown Message'); } } };
  assert.equal(await fetchMessage(failing, 'gone'), null);
  const empty = { messages: { cache: new Map(), fetch: async () => undefined } };
  assert.equal(await fetchMessage(empty, 'gone'), null);
  const uncached = rawMessage({ id: 'm9' });
  const noCache = { messages: { fetch: async () => uncached } };
  assert.equal(await fetchMessage(noCache, 'm9'), uncached);
});

// --- fetchReplyParents: replies whose parent is outside the window -------------

/** A raw reply to `parentId`. */
function rawReply(id, ts, parentId, overrides = {}) {
  return rawMessage({ id, createdTimestamp: ts, reference: parentId ? { messageId: parentId } : null, ...overrides });
}

/** A channel whose by-id fetch serves `stored` (raw messages) and records every id asked for. */
function parentChannel(stored) {
  const byId = new Map(stored.map((m) => [m.id, m]));
  const fetched = [];
  return {
    id: 'c1',
    fetched,
    messages: {
      cache: new Map(),
      fetch: async (id) => {
        fetched.push(id);
        if (!byId.has(id)) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        return byId.get(id);
      },
    },
  };
}

const PARENT_OPTIONS = { recent: 3, max: 4, selfId: 'self', embedTextChars: 200, videoSites: ['youtube.com'] };

test('fetchReplyParents: the trigger replies outside the window -- its parent is fetched and normalized like a history line', async () => {
  const parent = rawMessage({ id: 'p1', createdTimestamp: 100, cleanContent: 'regarde https://www.youtube.com/watch?v=abc' });
  const channel = parentChannel([parent]);
  const history = [normalizeMessage(rawReply('m1', 5000, 'p1'), 'self')];
  const parents = await fetchReplyParents(channel, history, { ...PARENT_OPTIONS, trigger: history[0] });
  assert.deepEqual(channel.fetched, ['p1']);
  assert.deepEqual(parents, [normalizeMessage(parent, 'self', { embedTextChars: 200, videoSites: ['youtube.com'] })]);
  assert.equal(parents[0].links[0].url, 'https://www.youtube.com/watch?v=abc');
});

test('fetchReplyParents: a parent inside the window is never fetched', async () => {
  const channel = parentChannel([]);
  const history = [normalizeMessage(rawMessage({ id: 'p1' }), 'self'), normalizeMessage(rawReply('m1', 5000, 'p1'), 'self')];
  const parents = await fetchReplyParents(channel, history, { ...PARENT_OPTIONS, trigger: history[1] });
  assert.deepEqual(parents, []);
  assert.deepEqual(channel.fetched, []);
});

test('fetchReplyParents: a chain of two -- the parent of the fetched parent comes too, one level only, oldest first', async () => {
  const root = rawMessage({ id: 'p0', createdTimestamp: 50 });
  const grand = rawReply('p1', 80, 'p0');
  const parent = rawReply('p2', 100, 'p1');
  const channel = parentChannel([root, grand, parent]);
  const history = [normalizeMessage(rawReply('m1', 5000, 'p2'), 'self')];
  const parents = await fetchReplyParents(channel, history, { ...PARENT_OPTIONS, trigger: history[0] });
  assert.deepEqual(parents.map((m) => m.id), ['p1', 'p2']);
  assert.deepEqual(channel.fetched, ['p2', 'p1']);
});

test('fetchReplyParents: the last `recent` lines of the window get their parents too, older lines do not', async () => {
  const stored = ['pa', 'pb', 'pc', 'pd'].map((id, i) => rawMessage({ id, createdTimestamp: 10 + i }));
  const channel = parentChannel(stored);
  const history = [
    normalizeMessage(rawReply('m1', 1000, 'pa'), 'self'),
    normalizeMessage(rawReply('m2', 2000, 'pb'), 'self'),
    normalizeMessage(rawReply('m3', 3000, 'pc'), 'self'),
    normalizeMessage(rawReply('m4', 4000, 'pd'), 'self'),
  ];
  const parents = await fetchReplyParents(channel, history, { ...PARENT_OPTIONS, recent: 3, trigger: null });
  assert.deepEqual(channel.fetched, ['pd', 'pc', 'pb']);
  assert.deepEqual(parents.map((m) => m.id), ['pb', 'pc', 'pd']);
});

test('fetchReplyParents: at most `max` lines are fetched, the trigger chain first', async () => {
  const stored = [
    rawMessage({ id: 'p0', createdTimestamp: 1 }),
    rawReply('p1', 2, 'p0'),
    rawMessage({ id: 'pb', createdTimestamp: 3 }),
    rawMessage({ id: 'pc', createdTimestamp: 4 }),
  ];
  const channel = parentChannel(stored);
  const history = [
    normalizeMessage(rawReply('m2', 2000, 'pb'), 'self'),
    normalizeMessage(rawReply('m3', 3000, 'pc'), 'self'),
    normalizeMessage(rawReply('m4', 4000, 'p1'), 'self'),
  ];
  const parents = await fetchReplyParents(channel, history, { ...PARENT_OPTIONS, max: 3, trigger: history[2] });
  assert.deepEqual(channel.fetched, ['p1', 'p0', 'pc']);
  assert.deepEqual(parents.map((m) => m.id), ['p0', 'p1', 'pc']);
});

test('fetchReplyParents: a deleted parent is skipped and logged once with ids only', async () => {
  const channel = parentChannel([]);
  const history = [normalizeMessage(rawReply('m1', 1000, 'gone'), 'self'), normalizeMessage(rawReply('m2', 2000, 'gone'), 'self')];
  const { result, logs } = await withCapturedLogs(() => fetchReplyParents(channel, history, { ...PARENT_OPTIONS, trigger: history[1] }));
  assert.deepEqual(result, []);
  assert.deepEqual(channel.fetched, ['gone']);
  const missing = logs.filter((entry) => entry.msg === 'collect: parent missing');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].channel, 'c1');
  assert.equal(missing[0].messageId, 'gone');
});

test('fetchReplyParents: max 0 fetches nothing', async () => {
  const channel = parentChannel([rawMessage({ id: 'p1' })]);
  const history = [normalizeMessage(rawReply('m1', 1000, 'p1'), 'self')];
  assert.deepEqual(await fetchReplyParents(channel, history, { ...PARENT_OPTIONS, max: 0, trigger: history[0] }), []);
  assert.deepEqual(channel.fetched, []);
});

// --- fetchTextPreview / withTextPreviews ------------------------------------

function fakeFetch(body, { ok = true, headers = {} } = {}) {
  return async () => ({
    ok,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  });
}

test('fetchTextPreview: returns the first maxChars characters', async () => {
  const text = await fetchTextPreview('https://x/notes.txt', 5, fakeFetch('hello world'));
  assert.equal(text, 'hello');
});

test('fetchTextPreview: a declared content-length over the 256 KB guard is never fetched fully', async () => {
  const text = await fetchTextPreview('https://x/big.txt', 100, fakeFetch('x'.repeat(10), { headers: { 'content-length': String(300 * 1024) } }));
  assert.equal(text, null);
});

test('fetchTextPreview: a non-ok response returns null', async () => {
  const text = await fetchTextPreview('https://x/missing.txt', 100, fakeFetch('', { ok: false }));
  assert.equal(text, null);
});

test('fetchTextPreview: a thrown fetch error falls back to null instead of throwing', async () => {
  const text = await fetchTextPreview('https://x', 100, async () => {
    throw new Error('network down');
  });
  assert.equal(text, null);
});

test('withTextPreviews: fills previewText on text attachments only, leaves other messages untouched', async () => {
  const messages = [
    { id: 'm1', attachments: [{ id: 't1', kind: 'text', name: 'a.txt', url: 'https://x/a.txt' }] },
    { id: 'm2', attachments: [{ id: 'i1', kind: 'image', name: 'b.png', url: 'https://x/b.png' }] },
  ];
  const result = await withTextPreviews(messages, 20, fakeFetch('line one\nline two'));
  assert.equal(result[0].attachments[0].previewText, 'line one\nline two'.slice(0, 20));
  assert.equal(result[1].attachments[0].previewText, undefined);
  // the input array/objects are never mutated
  assert.equal(messages[0].attachments[0].previewText, undefined);
});

test('withTextPreviews: a fetch failure leaves the attachment without previewText (plain file form fallback)', async () => {
  const messages = [{ id: 'm1', attachments: [{ id: 't1', kind: 'text', name: 'a.txt', url: 'https://x/a.txt' }] }];
  const result = await withTextPreviews(messages, 20, async () => {
    throw new Error('boom');
  });
  assert.equal(result[0].attachments[0].previewText, undefined);
});

/** A channel whose bot member holds exactly `granted` permission flags. */
function permChannel({ granted = [], me = { id: 'self-id' }, viewable = true, permissionsFor } = {}) {
  return {
    viewable,
    guild: { members: { me } },
    permissionsFor: permissionsFor ?? ((member) => (member === me ? { has: (flag) => granted.includes(flag) } : null)),
  };
}

test('canAttach: true when the bot member has Attach Files in the channel', () => {
  assert.equal(canAttach(permChannel({ granted: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] })), true);
});

test('canAttach: false when the bot member can send but not attach files', () => {
  assert.equal(canAttach(permChannel({ granted: [PermissionFlagsBits.SendMessages] })), false);
});

test('canAttach: false without the bot member, in a channel it cannot view, or with no resolved permissions', () => {
  const all = [PermissionFlagsBits.AttachFiles];
  assert.equal(canAttach(permChannel({ granted: all, me: null })), false);
  assert.equal(canAttach(permChannel({ granted: all, viewable: false })), false);
  assert.equal(canAttach(permChannel({ granted: all, permissionsFor: () => null })), false);
});

// A private (DM) channel has no guild: no member permissions to resolve, no neighbours.
function dmChannel() {
  return {
    id: 'dm1',
    guild: null,
    permissionsFor: () => {
      throw new Error('a DM channel has no member permissions');
    },
  };
}

test('canSend: true for a channel without a guild (a DM)', () => {
  assert.equal(canSend(dmChannel()), true);
});

test('canAttach: true for a channel without a guild (a DM)', () => {
  assert.equal(canAttach(dmChannel()), true);
});

test('canSend: still resolved through the bot member in a guild channel', () => {
  assert.equal(canSend(permChannel({ granted: [PermissionFlagsBits.SendMessages] })), true);
  assert.equal(canSend(permChannel({ granted: [] })), false);
  assert.equal(canSend(permChannel({ granted: [PermissionFlagsBits.SendMessages], me: null })), false);
});

test('fetchNeighbors: a channel without a guild (a DM) has no neighbours', async () => {
  const config = { context: { neighborMessages: 5, neighborMaxAgeMinutes: 60, neighborMaxChannels: 8 }, bot: {} };
  assert.deepEqual(await fetchNeighbors(dmChannel(), config, 'self-id', 1000), []);
});

test('canRead: needs Read Message History on a viewable channel, a DM is always yes', () => {
  assert.equal(canRead(permChannel({ granted: [PermissionFlagsBits.ReadMessageHistory] })), true);
  assert.equal(canRead(permChannel({ granted: [PermissionFlagsBits.SendMessages] })), false);
  assert.equal(canRead(permChannel({ granted: [PermissionFlagsBits.ReadMessageHistory], viewable: false })), false);
  assert.equal(canRead(permChannel({ granted: [PermissionFlagsBits.ReadMessageHistory], me: null })), false);
  assert.equal(canRead(dmChannel()), true);
});

test('canReact: needs AddReactions on a viewable channel, a DM is always yes', () => {
  const read = PermissionFlagsBits.ReadMessageHistory;
  const react = PermissionFlagsBits.AddReactions;
  assert.equal(canReact(permChannel({ granted: [read, react] })), true, 'a read-only channel the bot may react in');
  assert.equal(canReact(permChannel({ granted: [read, PermissionFlagsBits.SendMessages] })), false, 'sending is not reacting');
  assert.equal(canReact(permChannel({ granted: [react] })), false, 'Discord also needs Read Message History to react');
  assert.equal(canReact(permChannel({ granted: [read, react], viewable: false })), false);
  assert.equal(canReact(permChannel({ granted: [read, react], me: null })), false);
  assert.equal(canReact(permChannel({ granted: [read, react], permissionsFor: () => null })), false);
  assert.equal(canReact(dmChannel()), true);
});

// --- readable channels, neighbours: a fake guild whose bot member holds per-channel flags ---

const READ = PermissionFlagsBits.ReadMessageHistory;
const SEND = PermissionFlagsBits.SendMessages;
const REACT = PermissionFlagsBits.AddReactions;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const MIRROR_ID = '500000000000000009';

/**
 * A guild with one text channel per spec: `granted` flags for the bot member,
 * `lastTs` the time of its newest message (a real snowflake, as lastActivity
 * reads it) and `messages` the raw messages its one page returns.
 */
function fakeGuild(specs) {
  const me = { id: 'self-id' };
  const guild = { id: 'g1', members: { me }, channels: { cache: new Map() } };
  for (const spec of specs) {
    guild.channels.cache.set(spec.id, {
      id: spec.id,
      name: spec.name ?? spec.id,
      guild,
      viewable: spec.viewable ?? true,
      lastMessageId: spec.lastTs ? SnowflakeUtil.generate({ timestamp: spec.lastTs }).toString() : null,
      isTextBased: () => spec.text !== false,
      isThread: () => spec.thread === true,
      permissionsFor: (member) => (member === me ? { has: (flag) => (spec.granted ?? []).includes(flag) } : null),
      messages: { fetch: async () => new Map((spec.messages ?? []).map((message) => [message.id, message])) },
    });
  }
  return guild;
}

/** One raw message `minutesAgo` before NOW in channel `channelId`. */
function recentMessage(id, channelId, minutesAgo) {
  return rawMessage({ id, channelId, cleanContent: 'καλημέρα', createdTimestamp: NOW - minutesAgo * 60_000 });
}

/** A neighbour spec with one message `minutesAgo` before NOW. */
function neighbourSpec(id, granted, minutesAgo) {
  return { id, granted, lastTs: NOW - minutesAgo * 60_000, messages: [recentMessage(`${id}-m`, id, minutesAgo)] };
}

const NEIGHBOUR_CONFIG = (bot = {}) => ({
  context: { neighborMessages: 5, neighborMaxAgeMinutes: 60, neighborMaxChannels: 8 },
  bot,
  media: {},
});

test('fetchNeighbors: a neighbour the bot cannot write in is marked readOnly', async () => {
  const guild = fakeGuild([
    neighbourSpec('here', [READ, SEND], 1),
    neighbourSpec('talk', [READ, SEND, REACT], 5),
    neighbourSpec('diary', [READ, REACT], 3),
  ]);
  const neighbours = await fetchNeighbors(guild.channels.cache.get('here'), NEIGHBOUR_CONFIG(), 'self-id', NOW);
  assert.deepEqual(
    neighbours.map(({ channelId, readOnly }) => ({ channelId, readOnly })),
    [
      { channelId: 'diary', readOnly: true },
      { channelId: 'talk', readOnly: false },
    ],
  );
  assert.deepEqual(neighbours[0].messages.map((m) => m.id), ['diary-m']);
});

test('fetchNeighbors: the dry-run mirror channel is never a neighbour', async () => {
  const guild = fakeGuild([
    neighbourSpec('here', [READ, SEND], 1),
    neighbourSpec(MIRROR_ID, [READ, SEND, REACT], 2),
    neighbourSpec('talk', [READ, SEND], 4),
  ]);
  const here = guild.channels.cache.get('here');
  const withMirror = await fetchNeighbors(here, NEIGHBOUR_CONFIG({ dryRunChannelId: MIRROR_ID }), 'self-id', NOW);
  assert.deepEqual(withMirror.map((n) => n.channelId), ['talk']);
  const noMirror = await fetchNeighbors(here, NEIGHBOUR_CONFIG({ dryRunChannelId: '' }), 'self-id', NOW);
  assert.deepEqual(noMirror.map((n) => n.channelId), [MIRROR_ID, 'talk']);
});

test('readableChannels: threads, non-text, unreadable channels and the dry-run mirror are left out', () => {
  const guild = fakeGuild([
    { id: 'open', granted: [READ, SEND] },
    { id: 'diary', granted: [READ] },
    { id: 'thread', granted: [READ, SEND], thread: true },
    { id: 'voice', granted: [READ, SEND], text: false },
    { id: 'hidden', granted: [SEND] },
    { id: 'unviewable', granted: [READ, SEND], viewable: false },
    { id: MIRROR_ID, granted: [READ, SEND] },
  ]);
  const bot = { dryRunChannelId: MIRROR_ID };
  assert.deepEqual(readableChannels(guild, bot).map((c) => c.id), ['open', 'diary']);
  assert.deepEqual(readableChannels(guild, bot, 'open').map((c) => c.id), ['diary']);
  assert.equal(isReadableChannel(guild.channels.cache.get('diary'), bot), true);
  assert.equal(isReadableChannel(guild.channels.cache.get(MIRROR_ID), bot), false);
  assert.equal(isReadableChannel(guild.channels.cache.get(MIRROR_ID), { dryRunChannelId: '' }), true);
});

test('readableChannels: a leftover bot.channels allow/deny key is ignored; Discord permissions alone decide', () => {
  const guild = fakeGuild([
    { id: 'open', granted: [READ, SEND] },
    { id: 'listed', granted: [READ, SEND] },
    { id: 'hidden', granted: [SEND] },
  ]);
  const bot = { channels: { allow: ['hidden'], deny: ['listed'] }, dryRunChannelId: '' };
  assert.deepEqual(readableChannels(guild, bot).map((c) => c.id), ['open', 'listed']);
  assert.equal(isWritableChannel(guild.channels.cache.get('listed'), bot), true);
  assert.equal(isReadableChannel(guild.channels.cache.get('hidden'), bot), false, 'an allow entry opens no channel Discord closes');
});

// --- audienceOf: who can view a channel, in the shape audienceCovers takes ---

const GUILD_ID = '600000000000000000';
const VIEW = PermissionFlagsBits.ViewChannel;
const ROLE = { regular: '610000000000000001', muted: '610000000000000002', moderator: '610000000000000003' };
const MEMBER = { zoe: '620000000000000001', iason: '620000000000000002', nefeli: '620000000000000003' };
const BOT_ID = '630000000000000001';

/**
 * A guild channel whose permissionsFor(role) resolves like Discord does for
 * one role: the role's and @everyone's base permissions, then the @everyone
 * overwrite, then the role's own overwrite (deny, then allow). @everyone
 * views at the guild level; every other role adds nothing at that level.
 * `overwrites`: `{ id, type, allow?, deny? }` with bigint flags. `meId` is
 * the bot member's id (guild.members.me), `clientUserId` the logged-in
 * user's (channel.client.user); both absent by default. `members`: the
 * guild's member cache as `{ id, bot }`; absent by default (no cache).
 */
function audienceChannel({ roles = Object.values(ROLE), overwrites = [], thread = false, meId = null, clientUserId = null, members = null } = {}) {
  const everyone = { id: GUILD_ID, permissions: new PermissionsBitField(VIEW) };
  const all = [everyone, ...roles.map((id) => ({ id, permissions: new PermissionsBitField(0n) }))];
  const cache = new Map(
    overwrites.map((o) => [
      o.id,
      { id: o.id, type: o.type, allow: new PermissionsBitField(o.allow ?? 0n), deny: new PermissionsBitField(o.deny ?? 0n) },
    ]),
  );
  const resolve = (role) => {
    let bits = everyone.permissions.bitfield | role.permissions.bitfield;
    for (const id of role === everyone ? [everyone.id] : [everyone.id, role.id]) {
      const overwrite = cache.get(id);
      if (overwrite?.type === OverwriteType.Role) bits = (bits & ~overwrite.deny.bitfield) | overwrite.allow.bitfield;
    }
    return new PermissionsBitField(bits);
  };
  return {
    id: 'c-audience',
    guild: {
      id: GUILD_ID,
      members: {
        me: meId ? { id: meId } : null,
        ...(members ? { cache: new Map(members.map(({ id, bot, roleIds }) => [id, { id, user: { id, bot }, ...(roleIds ? { roles: { cache: new Map(roleIds.map((r) => [r, { id: r }])) } } : {}) }])) } : {}),
      },
      roles: { everyone, cache: new Map(all.map((role) => [role.id, role])) },
    },
    client: { user: clientUserId ? { id: clientUserId } : null },
    isThread: () => thread,
    permissionOverwrites: { cache },
    permissionsFor: (target) => (all.includes(target) ? resolve(target) : null),
  };
}

test('audienceOf: reads everyone, roles and member overwrites for ViewChannel', () => {
  const channel = audienceChannel({
    overwrites: [
      { id: GUILD_ID, type: OverwriteType.Role, deny: VIEW },
      { id: ROLE.moderator, type: OverwriteType.Role, allow: VIEW },
      { id: ROLE.muted, type: OverwriteType.Role, deny: VIEW | PermissionFlagsBits.SendMessages },
      { id: ROLE.regular, type: OverwriteType.Role, allow: PermissionFlagsBits.SendMessages },
      { id: MEMBER.zoe, type: OverwriteType.Member, allow: VIEW | PermissionFlagsBits.SendMessages },
      { id: MEMBER.iason, type: OverwriteType.Member, deny: VIEW },
      { id: MEMBER.nefeli, type: OverwriteType.Member, allow: PermissionFlagsBits.SendMessages },
    ],
  });
  assert.deepEqual(audienceOf(channel), {
    everyone: false,
    roles: new Set([ROLE.moderator]),
    roleAllow: new Set([ROLE.moderator]),
    roleDeny: new Set([ROLE.muted]),
    memberAllow: new Set([MEMBER.zoe]),
    memberDeny: new Set([MEMBER.iason]),
    memberRoles: new Map(),
  });
});

test('audienceOf: memberRoles holds the cached roles of the members named by an overwrite', () => {
  const channel = audienceChannel({
    overwrites: [
      { id: MEMBER.zoe, type: OverwriteType.Member, allow: VIEW },
      { id: MEMBER.iason, type: OverwriteType.Member, deny: VIEW },
      { id: MEMBER.nefeli, type: OverwriteType.Member, allow: VIEW },
    ],
    members: [
      { id: MEMBER.zoe, bot: false, roleIds: [ROLE.regular, ROLE.moderator] },
      { id: MEMBER.iason, bot: false, roleIds: [] },
      { id: 'unnamed', bot: false, roleIds: [ROLE.muted] },
    ],
  });
  const { memberRoles } = audienceOf(channel);
  assert.deepEqual(memberRoles.get(MEMBER.zoe), new Set([ROLE.regular, ROLE.moderator]));
  assert.deepEqual(memberRoles.get(MEMBER.iason), new Set());
  assert.equal(memberRoles.has(MEMBER.nefeli), false, 'a member missing from the cache has no entry');
  assert.equal(memberRoles.has('unnamed'), false, 'a member no overwrite names has no entry');
});

// The audience rail blocks a role that views the destination but not the
// source (audienceCovers, tests/elsewhere.test.js); these are the sets that
// make it do so for a role denied on an everyone-visible source (M2).
test('audienceOf: a role denied on an everyone-visible channel is missing from its roles though @everyone views it', () => {
  const source = audienceOf(audienceChannel({ overwrites: [{ id: ROLE.muted, type: OverwriteType.Role, deny: VIEW }] }));
  const dest = audienceOf(audienceChannel());
  assert.equal(source.everyone, true, '@everyone still views the source');
  assert.deepEqual(source.roles, new Set([GUILD_ID, ROLE.regular, ROLE.moderator]));
  assert.deepEqual(source.roleDeny, new Set([ROLE.muted]));
  assert.equal(dest.everyone, true);
  assert.deepEqual(dest.roles, new Set([GUILD_ID, ...Object.values(ROLE)]));
  assert.deepEqual(dest.roleDeny, new Set());
});

test("audienceOf: the bot's own member overwrite is not part of the audience", () => {
  const botAllow = { id: BOT_ID, type: OverwriteType.Member, allow: VIEW | PermissionFlagsBits.SendMessages };
  const botDeny = { id: BOT_ID, type: OverwriteType.Member, deny: VIEW };
  const publicChannel = audienceOf(audienceChannel());
  assert.deepEqual(audienceOf(audienceChannel({ overwrites: [botAllow], meId: BOT_ID })), publicChannel, 'the bot member from guild.members.me');
  assert.deepEqual(audienceOf(audienceChannel({ overwrites: [botAllow], clientUserId: BOT_ID })), publicChannel, 'the bot user from channel.client');
  assert.deepEqual(audienceOf(audienceChannel({ overwrites: [botDeny], meId: BOT_ID })).memberDeny, new Set());

  const mixed = audienceOf(
    audienceChannel({
      meId: BOT_ID,
      overwrites: [botAllow, { id: MEMBER.zoe, type: OverwriteType.Member, allow: VIEW }, { id: MEMBER.iason, type: OverwriteType.Member, deny: VIEW }],
    }),
  );
  assert.deepEqual(mixed.memberAllow, new Set([MEMBER.zoe]), "another member's allow stays");
  assert.deepEqual(mixed.memberDeny, new Set([MEMBER.iason]), "another member's deny stays");
  assert.deepEqual(
    audienceOf(audienceChannel({ overwrites: [botAllow] })).memberAllow,
    new Set([BOT_ID]),
    'with no bot id known, nothing is left out',
  );
});

const OTHER_BOT = { first: '640000000000000001', second: '640000000000000002', third: '640000000000000003' };

test('audienceOf: a bot member overwrite is not part of the audience, a human or uncached member stays', () => {
  const channel = audienceChannel({
    members: [
      { id: OTHER_BOT.first, bot: true },
      { id: OTHER_BOT.second, bot: true },
      { id: MEMBER.zoe, bot: false },
      { id: MEMBER.iason, bot: false },
    ],
    overwrites: [
      { id: OTHER_BOT.first, type: OverwriteType.Member, allow: VIEW },
      { id: OTHER_BOT.second, type: OverwriteType.Member, deny: VIEW },
      { id: MEMBER.zoe, type: OverwriteType.Member, allow: VIEW },
      { id: MEMBER.iason, type: OverwriteType.Member, deny: VIEW },
      { id: MEMBER.nefeli, type: OverwriteType.Member, allow: VIEW },
    ],
  });
  const audience = audienceOf(channel);
  assert.deepEqual(audience.memberAllow, new Set([MEMBER.zoe, MEMBER.nefeli]), "a bot's allow is ignored; a human's and an uncached member's stay");
  assert.deepEqual(audience.memberDeny, new Set([MEMBER.iason]), "a bot's deny is ignored; a human's stays");
});

test('audienceOf: two channels differing only by bot member allows cover each other', () => {
  const BOT_ROLE = '610000000000000009';
  const bots = Object.values(OTHER_BOT);
  const shared = { roles: [...Object.values(ROLE), BOT_ROLE], members: bots.map((id) => ({ id, bot: true })) };
  const botRoleDeny = { id: BOT_ROLE, type: OverwriteType.Role, deny: VIEW };
  const main = audienceOf(
    audienceChannel({ ...shared, overwrites: [botRoleDeny, ...bots.map((id) => ({ id, type: OverwriteType.Member, allow: VIEW }))] }),
  );
  const memes = audienceOf(audienceChannel({ ...shared, overwrites: [botRoleDeny] }));
  assert.equal(audienceCovers(main, memes), true, 'the memes channel is a source for the main chat');
  assert.equal(audienceCovers(memes, main), true, 'and the other way round');

  const humanAllow = audienceOf(
    audienceChannel({
      ...shared,
      members: [{ id: MEMBER.zoe, bot: false }],
      overwrites: [botRoleDeny, { id: MEMBER.zoe, type: OverwriteType.Member, allow: VIEW }],
    }),
  );
  assert.equal(audienceCovers(humanAllow, memes), false, "a human's allow by name still has to be proven on the source");
});

test('audienceOf: a channel without a guild or a thread has no audience', () => {
  assert.equal(audienceOf(dmChannel()), null);
  assert.equal(audienceOf(audienceChannel({ thread: true })), null);
});

// --- normalizeMessage: links to Discord CDN video attachments ------------------

const CDN_VIDEO_URL = 'https://cdn.discordapp.com/attachments/111/222/clip.mp4?ex=aa&is=bb&hm=cc';
const CDN_VIDEO_ENTRY = { id: '222', kind: 'video', name: 'clip.mp4', url: CDN_VIDEO_URL, size: null, durationSec: null };

test('normalizeMessage: an embedded Discord CDN video link becomes a video attachment, not a link', () => {
  const raw = rawMessage({
    cleanContent: `mirad ${CDN_VIDEO_URL} jajá`,
    embeds: [{ url: CDN_VIDEO_URL, provider: null }],
  });
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.attachments, [CDN_VIDEO_ENTRY]);
  assert.deepEqual(m.links, []);
  assert.equal(m.content, 'mirad jajá');
  // collectVideos sees it as one attachment video and keeps the unknown duration unknown.
  assert.deepEqual(
    collectVideos(m, { videoSites: ['youtube.com'] }).map((v) => [v.source, v.itemId, v.url, v.durationSec]),
    [['attachment', '222', CDN_VIDEO_URL, null]],
  );
});

test('normalizeMessage: a typed Discord CDN video link without an embed becomes a video attachment', () => {
  const raw = rawMessage({ cleanContent: `mirad <${CDN_VIDEO_URL}>.` });
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.attachments, [CDN_VIDEO_ENTRY]);
  assert.deepEqual(m.links, []);
  assert.equal(m.content, 'mirad .');
});

test('normalizeMessage: the embed URL of a CDN video is preferred over a typed one of the same id', () => {
  const typed = 'https://media.discordapp.net/attachments/111/222/clip.mp4';
  const raw = rawMessage({ cleanContent: `${typed} ${CDN_VIDEO_URL}`, embeds: [{ url: CDN_VIDEO_URL }] });
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.attachments, [CDN_VIDEO_ENTRY]);
  assert.equal(m.content, '');
});

test('normalizeMessage: a CDN video link of an attachment already on the message is not duplicated', () => {
  const raw = rawMessage({
    cleanContent: CDN_VIDEO_URL,
    attachments: new Map([['222', { id: '222', contentType: 'video/mp4', name: 'clip.mp4', url: 'https://cdn/real.mp4', size: 9, duration: 4 }]]),
    embeds: [{ url: CDN_VIDEO_URL }],
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].url, 'https://cdn/real.mp4');
  assert.deepEqual(m.links, []);
  assert.equal(m.content, '');
});

test('normalizeMessage: a forwarded snapshot carrying a CDN video link gets a video attachment', () => {
  const raw = rawMessage({
    cleanContent: '',
    messageSnapshots: new Map([
      ['snap1', { id: 'snap1', cleanContent: CDN_VIDEO_URL, attachments: new Map(), embeds: [{ url: CDN_VIDEO_URL }], stickers: new Map(), flags: flagsWith([]) }],
    ]),
  });
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.forwarded[0].attachments, [CDN_VIDEO_ENTRY]);
  assert.deepEqual(m.forwarded[0].links, []);
  assert.equal(m.forwarded[0].content, '');
  assert.deepEqual(m.attachments, []);
});

test('normalizeMessage: a Discord CDN picture link stays a link', () => {
  const url = 'https://cdn.discordapp.com/attachments/111/222/pic.png?ex=aa&is=bb&hm=cc';
  const raw = rawMessage({ cleanContent: url, embeds: [{ url }] });
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.attachments, []);
  assert.equal(m.links.length, 1);
  assert.equal(m.links[0].site, 'cdn.discordapp.com');
});

// --- fetchMessage without an id, isWritableChannel, the neighbours' accept rail --------------

test('fetchMessage: a missing or empty id is null without a request', async () => {
  const fetches = [];
  const channel = { messages: { cache: new Map(), fetch: async (id) => (fetches.push(id), rawMessage({ id: 'x' })) } };
  for (const id of [undefined, null, '']) assert.equal(await fetchMessage(channel, id), null, String(id));
  assert.deepEqual(fetches, []);
});

test('isWritableChannel: readable and sendable; never the dry-run mirror or an unreadable channel', () => {
  const guild = fakeGuild([
    { id: 'open', granted: [READ, SEND] },
    { id: 'diary', granted: [READ] },
    { id: 'blind', granted: [SEND] },
    { id: 'thread', granted: [READ, SEND], thread: true },
    { id: MIRROR_ID, granted: [READ, SEND] },
  ]);
  const bot = { dryRunChannelId: MIRROR_ID };
  const writable = [...guild.channels.cache.values()].filter((channel) => isWritableChannel(channel, bot)).map((channel) => channel.id);
  assert.deepEqual(writable, ['open']);
  assert.equal(isWritableChannel(guild.channels.cache.get(MIRROR_ID), { dryRunChannelId: '' }), true, 'only the configured mirror is refused');
});

test('fetchNeighbors: accept is judged before the channel cap; a refused channel takes no slot and is never fetched', async () => {
  const guild = fakeGuild([
    neighbourSpec('here', [READ, SEND], 1),
    neighbourSpec('staff', [READ, SEND], 2),
    neighbourSpec('talk', [READ, SEND], 4),
    neighbourSpec('quiet', [READ, SEND], 90),
  ]);
  const fetched = [];
  for (const channel of guild.channels.cache.values()) {
    const fetch = channel.messages.fetch;
    channel.messages.fetch = async (query) => (fetched.push(channel.id), fetch(query));
  }
  const judged = [];
  const accept = (other) => (judged.push(other.id), other.id !== 'staff');
  const config = { ...NEIGHBOUR_CONFIG(), context: { neighborMessages: 5, neighborMaxAgeMinutes: 60, neighborMaxChannels: 1 } };
  const neighbours = await fetchNeighbors(guild.channels.cache.get('here'), config, 'self-id', NOW, { accept });
  assert.deepEqual(neighbours.map((n) => n.channelId), ['talk'], 'the slot goes to the next accepted channel');
  assert.deepEqual(fetched, ['talk']);
  assert.deepEqual(judged.sort(), ['staff', 'talk'], 'only active channels are judged');
  const all = await fetchNeighbors(guild.channels.cache.get('here'), config, 'self-id', NOW);
  assert.deepEqual(all.map((n) => n.channelId), ['staff'], 'no accept: every readable channel');
});


test('normalizeMessage: a reaction whose emoji getter throws (a REST-only client) is skipped, not fatal', () => {
  const throwing = { count: 3, me: false };
  Object.defineProperty(throwing, 'emoji', { get() { throw new TypeError("Cannot read properties of null (reading 'emojis')"); } });
  const raw = rawMessage({
    reactions: { cache: new Map([['a', throwing], ['b', { emoji: { id: null, name: '👍' }, count: 1, me: false }]]) },
  });
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.reactions, [{ emoji: '👍', count: 1, mine: false }]);
});

// --- normalizeMessage: a posted link's URL stays readable ---------------------

/** The chat-mode transcript line of the last of `messages`, as the persona reads it. */
function lineOf(messages) {
  return formatTranscript(messages, { timezone: 'UTC', gapMinutes: 20, maxChars: 2000, selfName: 'Bot', labels }).at(-1).text;
}

test('normalizeMessage: a posted link keeps its URL, tracking parameters included, before its link tag in the transcript', () => {
  const url = 'https://www.youtube.com/watch?v=ID42&si=Ab_Cd-9xYz&t=31';
  const raw = rawMessage({
    cleanContent: `δες ${url} τώρα`,
    embeds: [{ url, provider: { name: 'YouTube' }, title: 'Clip', thumbnail: { url: 'https://i.ytimg.com/vi/ID42/hq.jpg' } }],
  });
  const m = normalizeMessage(raw, 'self', { videoSites: VIDEO_SITES, maxUrlChars: 200 });
  assert.equal(m.content, `δες ${url} τώρα`);
  assert.equal(m.links.length, 1);
  assert.ok(lineOf([m]).endsWith(`Alice: δες ${url} τώρα [link: YouTube — Clip]`), lineOf([m]));
});

test('normalizeMessage: attachment, sticker, emoji and Discord CDN file URLs never reach the text or the transcript line', () => {
  const pasted = 'https://media.discordapp.net/attachments/111/333/photo.png?ex=aa&is=bb&hm=cc';
  const raw = rawMessage({
    content: `voilà <:pog:111> ${pasted}`,
    cleanContent: `voilà :pog: ${pasted}`,
    attachments: new Map([['a1', { id: 'a1', contentType: 'image/png', name: 'pic.png', url: 'https://cdn.discordapp.com/attachments/1/9/pic.png', size: 1 }]]),
    embeds: [{ url: pasted, thumbnail: { url: pasted } }],
    stickers: new Map([['s1', { id: 's1', name: 'pepe', format: 1 }]]),
  });
  const m = normalizeMessage(raw, 'self', { maxUrlChars: 200 });
  assert.equal(m.content, 'voilà :pog:');
  const line = lineOf([m]);
  assert.ok(!line.includes('https://'), line);
});

test('normalizeMessage: a URL longer than maxUrlChars is cut there with an ellipsis, in a message and a forward; the link item keeps it whole', () => {
  const url = `https://example.com/search?q=${'κ'.repeat(10)}&utm_source=${'x'.repeat(80)}`;
  const cut = `${[...url].slice(0, 40).join('')}…`;
  const raw = rawMessage({
    cleanContent: `δες ${url} ok`,
    embeds: [{ url, title: 'Search' }],
    messageSnapshots: new Map([['snap1', { id: 'snap1', cleanContent: `και ${url}`, attachments: new Map(), embeds: [], stickers: new Map(), flags: flagsWith([]) }]]),
  });
  const m = normalizeMessage(raw, 'self', { maxUrlChars: 40 });
  assert.equal(m.content, `δες ${cut} ok`);
  assert.equal(m.forwarded[0].content, `και ${cut}`);
  assert.equal(m.links[0].url, url, 'the web lookup still reads the whole page address');
  assert.equal(normalizeMessage(raw, 'self', { maxUrlChars: 0 }).content, `δες ${url} ok`, '0 keeps every URL whole');
});

test("normalizeMessage: the persona's own posted link reads in her line like anyone's, URL as she wrote it", () => {
  const url = 'https://www.youtube.com/watch?v=xyz&list=PL1';
  const raw = rawMessage({
    author: { id: 'self', bot: true, globalName: 'Bot', username: 'bot' },
    member: { displayName: 'Bot' },
    cleanContent: `να το ${url}`,
    embeds: [{ url, provider: { name: 'YouTube' }, title: 'Cool video' }],
  });
  const m = normalizeMessage(raw, 'self', { videoSites: VIDEO_SITES, maxUrlChars: 200 });
  assert.equal(m.self, true);
  assert.equal(m.content, `να το ${url}`);
  assert.ok(lineOf([m]).endsWith(`Bot (you): να το ${url} [link: YouTube — Cool video]`), lineOf([m]));
});

// ---------------------------------------------------------------------------
// Inbound protocol events (toEvent, reactionEvent, normalizedOf).

/** A guild message with everything the event reads: a channel with a topic and a category, mentions, a reply. */
function guildMessage(overrides = {}) {
  const channel = {
    id: 'c1',
    name: 'γενικά',
    topic: 'κουβέντα',
    parent: { name: 'κοινότητα' },
    isThread: () => false,
    messages: { cache: new Map() },
  };
  return rawMessage({
    guild: { id: 'g1' },
    guildId: 'g1',
    channel,
    content: 'hello <@self> <#222222222222222222>',
    cleanContent: 'hello @Bot #news',
    mentions: { users: new Map([['self', { id: 'self' }], ['u2', { id: 'u2' }]]) },
    reference: { messageId: 'm0' },
    ...overrides,
  });
}

test('toEvent: a message becomes a valid message.received event, field for field', () => {
  const raw = guildMessage();
  const event = toEvent(raw, 'self', { maxUrlChars: 200 });
  assert.deepEqual(validateEvent(event), { ok: true });
  assert.equal(event.kind, 'message.received');
  assert.equal(event.iface, 'discord');
  assert.equal(event.id, 'discord:message:m1');
  assert.equal(event.at, 1000);
  assert.deepEqual(event.conversation, { id: 'c1', kind: 'channel', guildId: 'g1', name: 'γενικά', topic: 'κουβέντα', category: 'κοινότητα', chatType: 'channel' });
  assert.deepEqual(event.message.author, { id: 'u1', name: 'Alice', self: false, bot: false });
  assert.equal(event.message.content, 'hello @Bot #news');
  assert.equal(event.message.at, 1000);
  assert.equal(event.message.replyToId, 'm0');
  assert.deepEqual(event.addressing, { mentioned: true, replyToSelf: false, mentionedUserIds: ['self', 'u2'], mentionedUsers: [], mentionedConversationIds: ['222222222222222222'] });
  assert.equal(event.raw, raw, 'the discord.js message rides along for the Discord side only');
  for (const key of ['channelId', 'authorId', 'authorName', 'ts', 'channelName', 'mentionedUserIds']) assert.ok(!(key in event.message), key);
});

test('normalizedOf: the event gives back normalizeMessage\'s result, key for key and in order', () => {
  for (const raw of [guildMessage(), rawMessage(), guildMessage({ author: { id: 'self', bot: true, globalName: 'Bot', username: 'bot' } })]) {
    const options = normalizeOptions({ media: { embedTextChars: 50, video: { sites: ['youtube.com'] } }, context: { maxUrlChars: 30 } });
    assert.equal(JSON.stringify(normalizedOf(toEvent(raw, 'self', options))), JSON.stringify(normalizeMessage(raw, 'self', options)));
    assert.deepEqual(normalizedOf(toEvent(raw, 'self', options)), normalizeMessage(raw, 'self', options));
  }
});

test('normalizeOptions: the three normaliser settings from the config, absent ones left to its defaults', () => {
  assert.deepEqual(normalizeOptions({ media: { embedTextChars: 50, video: { sites: ['a'] } }, context: { maxUrlChars: 30 } }), { embedTextChars: 50, videoSites: ['a'], maxUrlChars: 30 });
  assert.deepEqual(normalizeOptions({}), { embedTextChars: undefined, videoSites: undefined, maxUrlChars: undefined });
});

test('toEvent: a direct chat is a dm conversation, a thread a thread', () => {
  const dm = toEvent(rawMessage({ guild: null, channel: { id: 'd1' }, channelId: 'd1' }), 'self');
  assert.deepEqual(dm.conversation, { id: 'd1', kind: 'dm', guildId: null, name: null, topic: null, category: null, chatType: 'dm', partnerId: null });
  assert.deepEqual(validateEvent(dm), { ok: true });
  const thread = toEvent(guildMessage({ channel: { id: 't1', name: 'νήμα', isThread: () => true } , channelId: 't1' }), 'self');
  assert.equal(thread.conversation.kind, 'thread');
});

test('toEvent: a one-to-one chat names its partner, a group chat is group_dm, a thread names its channel', () => {
  const dm = toEvent(rawMessage({ guild: null, channel: { id: 'd1', type: ChannelType.DM, recipientId: 'u1' }, channelId: 'd1' }), 'self');
  assert.deepEqual([dm.conversation.chatType, dm.conversation.partnerId], ['dm', 'u1']);
  assert.equal(toEvent(rawMessage({ guild: null, channel: { id: 'd2', recipient: { id: 'u2' } }, channelId: 'd2' }), 'self').conversation.partnerId, 'u2');
  const group = toEvent(rawMessage({ guild: null, channel: { id: 'g9', name: 'φίλοι', type: ChannelType.GroupDM }, channelId: 'g9' }), 'self');
  assert.deepEqual([group.conversation.kind, group.conversation.chatType, 'partnerId' in group.conversation], ['dm', 'group_dm', false]);
  const thread = toEvent(guildMessage({ channel: { id: 't1', name: 'νήμα', isThread: () => true, parentId: 'c1' }, channelId: 't1' }), 'self');
  assert.deepEqual([thread.conversation.chatType, thread.conversation.parentId], ['thread', 'c1']);
  for (const event of [dm, group, thread]) assert.deepEqual(validateEvent(event), { ok: true });
  assert.deepEqual(validateEvent({ ...dm, conversation: { ...dm.conversation, chatType: 'room' } }), { ok: false, reason: 'conversation.chatType:unknown' });
  assert.deepEqual(validateEvent({ ...dm, conversation: { ...dm.conversation, partnerId: 7 } }), { ok: false, reason: 'conversation.partnerId:type' });
});

test('toEvent: replyToSelf is the cached answer only; a forward replies to nothing', () => {
  const channel = { id: 'c1', isThread: () => false, messages: { cache: new Map([['m0', { author: { id: 'self' } }], ['m9', { partial: true, author: { id: 'self' } }]]) } };
  assert.equal(toEvent(guildMessage({ channel }), 'self').addressing.replyToSelf, true);
  assert.equal(toEvent(guildMessage({ channel, reference: { messageId: 'm9' } }), 'self').addressing.replyToSelf, false, 'a partial cached message is no answer');
  assert.equal(toEvent(guildMessage({ channel, reference: { messageId: 'other' } }), 'self').addressing.replyToSelf, false);
  const forward = toEvent(guildMessage({ channel, reference: { messageId: 'm0', channelId: 'c2', type: MessageReferenceType.Forward } }), 'self');
  assert.equal(forward.message.replyToId, null);
  assert.equal(forward.addressing.replyToSelf, false);
});

test('toEvent: no mention of the persona is mentioned false, whatever else is mentioned', () => {
  const event = toEvent(guildMessage({ mentions: { users: new Map([['u2', { id: 'u2' }]]) } }), 'self');
  assert.equal(event.addressing.mentioned, false);
  assert.deepEqual(event.addressing.mentionedUserIds, ['u2']);
  assert.equal(toEvent(rawMessage(), 'self').addressing.mentioned, false, 'no mentions at all');
});

test('toEvent: an edit carries the same message id, its edit time and the old message', () => {
  const previous = guildMessage({ cleanContent: 'helo' });
  const event = toEvent(guildMessage({ editedTimestamp: 5000 }), 'self', { edit: true, previous, now: () => 9000 });
  assert.deepEqual(validateEvent(event), { ok: true });
  assert.equal(event.edit, true);
  assert.equal(event.message.id, 'm1');
  assert.equal(event.at, 5000);
  assert.equal(event.id, 'discord:edit:m1:5000:9000');
  assert.equal(event.rawPrevious, previous);
  assert.equal(toEvent(guildMessage(), 'self', { edit: true, now: () => 7000 }).at, 7000, 'no edit stamp: now');
});

test('toEvent: two updates with the same edit stamp (an embed attached after an edit) are two events', () => {
  const edited = guildMessage({ editedTimestamp: 5000 });
  const first = toEvent(edited, 'self', { edit: true, now: () => 9000 });
  const second = toEvent(edited, 'self', { edit: true, now: () => 9400 });
  assert.equal(first.at, second.at);
  assert.notEqual(first.id, second.id);
});

test('toEvent: an edit of a partial message carries only its id, and a deletion only its id', () => {
  const partial = { id: 'm1', channelId: 'c1', guildId: 'g1', partial: true, author: null };
  const edit = toEvent(partial, 'self', { edit: true, now: () => 7000 });
  assert.deepEqual(validateEvent(edit), { ok: true });
  assert.deepEqual([edit.message, edit.edit, edit.partial, edit.raw], [{ id: 'm1' }, true, true, partial]);
  const deleted = toEvent(partial, 'self', { deleted: true, now: () => 8000 });
  assert.deepEqual(validateEvent(deleted), { ok: true });
  assert.deepEqual([deleted.message, deleted.deleted, deleted.at, deleted.id], [{ id: 'm1' }, true, 8000, 'discord:delete:m1']);
  assert.deepEqual(deleted.conversation, { id: 'c1', kind: 'channel', guildId: 'g1', name: null, topic: null, category: null, chatType: 'channel' });
});

test('reactionEvent: a reaction becomes a valid reaction.changed event, its parts kept for the reactor store', () => {
  const message = { id: 'm1', channelId: 'c1', guildId: 'g1', channel: { id: 'c1', name: 'γενικά', isThread: () => false } };
  const reaction = { message, emoji: { name: '\u{1F389}', id: null } };
  const user = { id: 'u2' };
  const event = reactionEvent(reaction, user, true, { now: () => 3000 });
  assert.deepEqual(validateEvent(event), { ok: true });
  assert.deepEqual(
    { kind: event.kind, at: event.at, conversation: event.conversation.id, messageId: event.messageId, emoji: event.emoji, userId: event.userId, added: event.added },
    { kind: 'reaction.changed', at: 3000, conversation: 'c1', messageId: 'm1', emoji: { name: '\u{1F389}' }, userId: 'u2', added: true },
  );
  assert.deepEqual(event.raw, { reaction, user });
  const custom = reactionEvent({ message, emoji: { name: 'party', id: '42' } }, user, false, { now: () => 3000 });
  assert.deepEqual([custom.emoji, custom.added], [{ name: 'party', id: '42' }, false]);
  assert.notEqual(custom.id, event.id);
});

test('reactionEvent: an unreadable emoji or a missing message never throws and fails validation', () => {
  const broken = { message: null, get emoji() { throw new Error('REST-only client'); } };
  const event = reactionEvent(broken, { id: 'u2' }, true);
  assert.equal(validateEvent(event).ok, false);
  assert.equal(validateEvent(reactionEvent({ message: { id: 'm1', channelId: 'c1', guildId: 'g1' }, emoji: { name: null } }, { id: 'u2' }, true)).ok, false);
});

test('normalizeMessage: editedAt is the edit stamp, null for a message never edited', () => {
  assert.equal(normalizeMessage(rawMessage({ editedTimestamp: 5000 }), 'self').editedAt, 5000);
  assert.equal(normalizeMessage(rawMessage({ editedTimestamp: null }), 'self').editedAt, null);
  assert.equal(normalizeMessage(rawMessage(), 'self').editedAt, null);
});
