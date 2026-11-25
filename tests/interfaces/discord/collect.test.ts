// Tests for interfaces/discord/collect.ts: normalizeMessage's media handling (voice
// flag, embed classification, raw-URL de-duplication, forwarded snapshots),
// its mention ids, the lazy text-attachment preview fetch, the bot's channel
// permissions, readable channels and neighbours, and the audience reader.
// Discord objects are plain fixtures shaped just enough for the code to read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMessage,
  toEvent,
  reactionEvent,
  fetchHistory,
  fetchMessage,
  canAttach,
  canSend,
  canRead,
  canReact,
  readableChannels,
  isReadableChannel,
  isWritableChannel,
  audienceOf,
  messageRefsOf,
  normalizeMessage as normalizeRaw,
  normalizeOptions,
  channelDirectoryOf as guildChannelDirectory,
} from '../../../interfaces/discord/index.ts';
import {
  ChannelType,
  Embed,
  MessageReferenceType,
  OverwriteType,
  PermissionFlagsBits,
  PermissionsBitField,
  SnowflakeUtil,
} from 'discord.js';
import { videoUrlCacheKey } from '../../../src/media/video-sites.ts';
import { collectPictures, collectVideos } from '../../../src/media/classify.ts';
import { audienceCovers } from '../../../src/behavior/elsewhere.ts';
import { emptyGifs, mergeGifs } from '../../../src/memory/gifs.ts';
import { formatTranscript } from '../../../src/format.ts';
import { labels } from '../../fixtures/labels.ts';
import { validateEvent } from '../../../src/protocol/index.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { noMediaNames } from '../../fixtures/media-namer.ts';
import '../../../src/tools/operations/index.ts';
import { chatOfChannel } from '../../fixtures/sdk-shaped.ts';

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

// The stand-ins hold only the part of a discord.js channel that the code under test reads, so each is cast once, here.
const fakeOf = <T>(value: object): T => value as T;
type Chan = Parameters<typeof fetchHistory>[0];

function flagsWith(names: Untyped) {
  const set = new Set(names);
  return { has: (name: string) => set.has(name) };
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

test('normalizeMessage: an attachment carries its pixel size from discord.js, null when Discord gives none', () => {
  const raw = rawMessage({
    attachments: new Map([
      [
        'a1',
        {
          id: 'a1',
          contentType: 'image/png',
          name: 'pic.png',
          url: 'https://cdn/pic.png',
          size: 1,
          width: 988,
          height: 1306,
        },
      ],
      [
        'a2',
        {
          id: 'a2',
          contentType: 'text/plain',
          name: 'a.txt',
          url: 'https://cdn/a.txt',
          size: 1,
          width: null,
          height: null,
        },
      ],
    ]),
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(loose(m.attachments[0]).width, 988);
  assert.equal(loose(m.attachments[0]).height, 1306);
  assert.equal(loose(m.attachments[1]).width, null);
  assert.equal(loose(m.attachments[1]).height, null);
  const [picture] = collectPictures(m);
  assert.equal(picture.width, 988);
  assert.equal(picture.height, 1306);
});

test('normalizeMessage: the voice-message flag reclassifies an audio attachment as voice, without it the attachment stays audio', () => {
  const rows = [
    {
      label: 'a voice-message flag reclassifies the attachment as voice',
      flags: ['IsVoiceMessage'],
      attachment: {
        id: 'a1',
        contentType: 'audio/ogg',
        name: 'voice-message.ogg',
        url: 'https://cdn/v.ogg',
        duration: 12,
      },
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
    const m = normalizeMessage(
      rawMessage({ flags: flagsWith(flags), attachments: new Map([['a1', attachment]]) }),
      'self'
    );
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(loose(m.attachments[0])[key], value, `${label}: ${key}`);
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
  const link = m.links[0];
  assert.equal(link.kind, 'link');
  assert.equal(link.site, 'example.com');
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
      [
        'snap1',
        {
          id: 'snap1',
          cleanContent: '',
          attachments: new Map(),
          embeds: [gifv],
          stickers: new Map(),
          flags: flagsWith([]),
        },
      ],
    ]),
  });
  const m = normalizeMessage(raw, 'self');
  const link = m.links[0];
  assert.equal(link.kind, 'gif');
  // The provider's own address comes first.
  assert.equal(link.animationUrl, 'https://media.tenor.com/x.mp4');
  const forward = m.forwarded[0];
  const link2 = forward.links[0];
  assert.equal(link2.id, 'snap1#e0');
  assert.equal(link2.animationUrl, 'https://media.tenor.com/x.mp4');
});

test('normalizeMessage: a GIF-picker post (a gifv embed of an unknown provider) reaches the library with the page to post and the video to watch', () => {
  const page = 'https://gifs.example.net/gifs/dancing-cat';
  // @ts-expect-error: discord.js marks the Embed constructor private; the test builds the embed a message carries
  const embed = new Embed({
    type: 'gifv',
    url: page,
    provider: { name: 'Gifland' },
    thumbnail: { url: 'https://static.gifs.example.net/x/still.webp' },
    video: { url: 'https://static.gifs.example.net/x/loop.mp4' },
  });
  const m = normalizeMessage(rawMessage({ cleanContent: page, content: page, embeds: [embed] }), 'self');
  assert.equal(m.content, '', 'the page URL is not left in the text');
  const link = m.links[0];
  assert.equal(link.kind, 'gif');

  const { gifs, counted } = mergeGifs(emptyGifs(), [m]);
  assert.equal(counted, 1);
  const [entry] = Object.values(loose(gifs).entries);
  assert.equal(loose(entry).kind, 'link');
  assert.equal(loose(entry).url, page, 'what the persona posts back');

  const [picture] = collectPictures(m);
  assert.equal(picture.kind, 'gif');
  assert.equal(picture.itemId, loose(entry).itemId, 'its caption lands where the library looks');
  assert.equal(picture.animationUrl, 'https://static.gifs.example.net/x/loop.mp4', 'what the GIF watch downloads');
  assert.equal(picture.url, 'https://static.gifs.example.net/x/still.webp', 'the still frame');
});

test('normalizeMessage: a pasted Discord-hosted .gif link is a gif item to watch, a .png link stays a link', () => {
  const url = 'https://media.discordapp.net/attachments/1/2/dance.gif?ex=1&is=2&hm=3';
  const proxy = 'https://media.discordapp.net/attachments/1/2/dance.gif?ex=1&is=2&hm=3&width=498&height=280';
  // @ts-expect-error: discord.js marks the Embed constructor private; the test builds the embed a message carries
  const embed = new Embed({
    type: 'image',
    url,
    thumbnail: { url, proxy_url: proxy, width: 498, height: 280, content_type: 'image/gif' },
  });
  const m = normalizeMessage(rawMessage({ cleanContent: url, content: url, embeds: [embed] }), 'self');
  assert.deepEqual(m.attachments, []);
  assert.equal(m.links.length, 1);
  const link = m.links[0];
  assert.equal(link.kind, 'gif');
  assert.equal(link.id, 'm1#e0');
  assert.equal(link.thumbnailUrl, proxy);
  assert.equal(m.content, '', 'the URL is not left in the text');
  const [picture] = collectPictures(m);
  assert.equal(picture.kind, 'gif');
  assert.equal(picture.url, proxy, 'the still frame, the fallback');
  assert.equal(picture.animationUrl, url, 'what the GIF watch downloads');

  const png = 'https://media.discordapp.net/attachments/1/3/photo.png?ex=1&is=2&hm=3';
  // @ts-expect-error: discord.js marks the Embed constructor private; the test builds the embed a message carries
  const pngEmbed = new Embed({
    type: 'image',
    url: png,
    thumbnail: { url: png, proxy_url: png, width: 10, height: 10, content_type: 'image/png' },
  });
  const p = normalizeMessage(rawMessage({ cleanContent: png, content: png, embeds: [pngEmbed] }), 'self');
  const link2 = p.links[0];
  assert.equal(link2.kind, 'link');
  assert.equal('animationUrl' in p.links[0], false);
  assert.equal(collectPictures(p)[0].kind, 'link');
});

test('normalizeMessage: a gifv embed on a configured video site stays a video link', () => {
  const url = 'https://x.com/someone/status/1';
  // @ts-expect-error: discord.js marks the Embed constructor private; the test builds the embed a message carries
  const embed = new Embed({
    type: 'gifv',
    url,
    thumbnail: { url: 'https://pbs.example.net/t.jpg' },
    video: { url: 'https://video.example.net/v.mp4' },
  });
  const m = normalizeMessage(rawMessage({ cleanContent: url, embeds: [embed] }), 'self', { videoSites: ['x.com'] });
  const link = m.links[0];
  assert.equal(link.kind, 'link');
  assert.equal(link.id, videoUrlCacheKey(url));
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
  const link = m.links[0];
  assert.equal(link.id, 'm1#e0');
  const secondLink = m.links[1];
  assert.equal(secondLink.id, 'm1#e1');
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
          attachments: new Map([
            ['f1', { id: 'f1', contentType: 'image/png', name: 'f.png', url: 'https://cdn/f.png' }],
          ]),
          embeds: [],
          stickers: new Map(),
          flags: flagsWith([]),
        },
      ],
    ]),
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.forwarded.length, 1);
  const forward = m.forwarded[0];
  assert.equal(forward.content, 'forwarded text');
  assert.equal(loose(forward.attachments[0]).kind, 'image');
});

// --- normalizeMessage: stickers ----------------------------------------

function sticker(id: string, name: string, format: Untyped) {
  return { id, name, format };
}

// A sticker says whether it moves, and Discord's format number stays inside the interface.
// The expectations of `format` on the normalized sticker were the old shape.
test('normalizeMessage: a PNG sticker is still and carries no animationUrl', () => {
  const m = normalizeMessage(rawMessage({ stickers: new Map([['s1', sticker('s1', 'pepe', 1)]]) }), 'self');
  assert.deepEqual(m.stickers, [
    { id: 's1', name: 'pepe', animated: false, url: 'https://media.discordapp.net/stickers/s1.png?size=160' },
  ]);
});

test('normalizeMessage: an APNG sticker is animated and its animationUrl is its own png address', () => {
  const m = normalizeMessage(rawMessage({ stickers: new Map([['s2', sticker('s2', 'wave', 2)]]) }), 'self');
  assert.deepEqual(m.stickers, [
    {
      id: 's2',
      name: 'wave',
      animated: true,
      url: 'https://media.discordapp.net/stickers/s2.png?size=160',
      animationUrl: 'https://media.discordapp.net/stickers/s2.png?size=160',
    },
  ]);
});

test('normalizeMessage: a GIF sticker is animated and its animationUrl is its own gif address', () => {
  const m = normalizeMessage(rawMessage({ stickers: new Map([['s3', sticker('s3', 'dance', 4)]]) }), 'self');
  assert.deepEqual(m.stickers, [
    {
      id: 's3',
      name: 'dance',
      animated: true,
      url: 'https://media.discordapp.net/stickers/s3.gif?size=160',
      animationUrl: 'https://media.discordapp.net/stickers/s3.gif?size=160',
    },
  ]);
});

test('normalizeMessage: a Lottie sticker keeps a null url and carries no animationUrl', () => {
  const m = normalizeMessage(rawMessage({ stickers: new Map([['s4', sticker('s4', 'spin', 3)]]) }), 'self');
  const [lottie] = m.stickers;
  assert.equal(lottie.url, null);
  assert.equal(loose(lottie).animationUrl, undefined);
});

// --- normalizeMessage: custom emoji extraction -------------------------
// discord.js's Message#cleanContent already rewrites <:name:id> into :name:,
// so the fixtures carry the raw markup in `content` and the cleaned text in
// `cleanContent`, as discord.js really yields them.

const PEPE_ID = '123456789012345678';

// An emoji and a sticker go by a stable name of the engine.
test('normalizeMessage: two custom emoji that share a name stay two tokens of two ids', () => {
  const raw = rawMessage({ content: '<:kekw:111> <:kekw:222>', cleanContent: ':kekw: :kekw:' });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.content, '<emoji:111> <emoji:222>');
});

// An emoji and a sticker go by a stable name of the engine.
test('normalizeMessage: a custom emoji stands in the content as the protocol token of its id', () => {
  const raw = rawMessage({ content: `hi <:pepe:${PEPE_ID}>`, cleanContent: 'hi :pepe:' });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.content, `hi <emoji:${PEPE_ID}>`);
  assert.deepEqual(m.emojis, [
    { id: PEPE_ID, name: 'pepe', animated: false, url: `https://cdn.discordapp.com/emojis/${PEPE_ID}.webp?size=96` },
  ]);
});

// An animated emoji is watched from its gif address, so it carries animationUrl.
// An emoji and a sticker go by a stable name of the engine.
test('normalizeMessage: an animated custom emoji is marked animated and carries its gif animationUrl', () => {
  const raw = rawMessage({ content: `hi <a:pepe:${PEPE_ID}>`, cleanContent: 'hi :pepe:' });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.content, `hi <emoji:${PEPE_ID}>`);
  assert.deepEqual(m.emojis, [
    {
      id: PEPE_ID,
      name: 'pepe',
      animated: true,
      url: `https://cdn.discordapp.com/emojis/${PEPE_ID}.webp?size=96`,
      animationUrl: `https://cdn.discordapp.com/emojis/${PEPE_ID}.gif`,
    },
  ]);
});

// An emoji and a sticker go by a stable name of the engine.
test('normalizeMessage: without a raw content, custom emoji fall back to cleanContent', () => {
  const raw = rawMessage({ content: undefined, cleanContent: `hi <:pepe:${PEPE_ID}>` });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.content, `hi <emoji:${PEPE_ID}>`);
  assert.deepEqual(
    m.emojis.map((e) => e.name),
    ['pepe']
  );
});

test('normalizeMessage: the same custom emoji repeated in one message is de-duplicated', () => {
  const raw = rawMessage({ content: '<:pog:111> <:pog:111> <:pog:111>', cleanContent: ':pog: :pog: :pog:' });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.emojis.length, 1);
});

// Every custom emoji of a message is named, there is no cap.
test('normalizeMessage: seven distinct custom emoji give seven tokens and seven emojis entries, first-appearance order', () => {
  const ids = ['701', '702', '703', '704', '705', '706', '707'];
  const content = ids.map((id) => `<:smile${id}:${id}>`).join(' ');
  const raw = rawMessage({ content, cleanContent: ids.map((id) => `:smile${id}:`).join(' ') });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.content, ids.map((id) => `<emoji:${id}>`).join(' '));
  assert.deepEqual(
    m.emojis.map((e) => e.id),
    ids
  );
});

// A token whose id the message's emojis do not hold must not stop a read of history.
test('normalizeMessage: emoji markup in a mentioned member display name stays text and gives no token', () => {
  const raw = rawMessage({ content: 'hi <@u2> <:pog:111>', cleanContent: 'hi @Bob<:fake:999> :pog:' });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.content, 'hi @Bob<:fake:999> <emoji:111>');
  assert.deepEqual(
    m.emojis.map((e) => e.id),
    ['111']
  );
});

// A token whose id the message's emojis do not hold must not stop a read of history.
test('normalizeMessage: emoji markup in a channel name of a forwarded part stays text and gives no token', () => {
  const snapshot = {
    id: 'snap1',
    content: 'see <#c9>',
    cleanContent: 'see #room<a:spin:888>',
    attachments: new Map(),
    embeds: [],
    stickers: new Map(),
    flags: flagsWith([]),
  };
  const raw = rawMessage({ cleanContent: '', messageSnapshots: new Map([['snap1', snapshot]]) });
  const [part] = normalizeMessage(raw, 'self').forwarded;
  assert.equal(part.content, 'see #room<a:spin:888>');
  assert.deepEqual(part.emojis, []);
});

test("normalizeMessage: reactions are read with count and the bot's own mark", () => {
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

// An emoji and a sticker go by a stable name of the engine.
test('normalizeMessage: a custom emoji reaction is the protocol token with its platform name and animation', () => {
  const raw = rawMessage({
    reactions: {
      cache: new Map([['123', { emoji: { id: '123', name: 'kati', animated: true }, count: 1, me: false }]]),
    },
  });
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.reactions, [{ emoji: '<emoji:123>', name: 'kati', animated: true, count: 1, mine: false }]);
});

// An emoji and a sticker go by a stable name of the engine.
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
  const forward = m.forwarded[0];
  assert.equal(forward.content, 'look <emoji:111>');
  assert.deepEqual(forward.emojis, [
    { id: '111', name: 'pog', animated: false, url: 'https://cdn.discordapp.com/emojis/111.webp?size=96' },
  ]);
  assert.deepEqual(forward.stickers, [
    { id: 's1', name: 'pepe', animated: false, url: 'https://media.discordapp.net/stickers/s1.png?size=160' },
  ]);
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
  const link = m.links[0];
  assert.equal(link.kind, 'link');
  assert.ok(link.id.startsWith('link:'));
  assert.notEqual(link.id, 'm1#e0');
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
    rawMessage({
      id: 'm2',
      embeds: [{ ...embed(), thumbnail: { url: 'https://i.ytimg.com/vi/xyz/hq.jpg?ex=9&hm=zzz' } }],
    }),
    'self'
  );
  const link2 = m2.links[0];
  const link = m1.links[0];
  assert.equal(link.id, link2.id);
});

test('normalizeMessage: an embed thumbnail prefers proxyURL over url when discord.js exposes one', () => {
  const raw = rawMessage({
    embeds: [
      {
        url: 'https://www.youtube.com/watch?v=xyz',
        provider: { name: 'YouTube' },
        title: 'Cool video',
        thumbnail: {
          url: 'https://i.ytimg.com/vi/xyz/hq.jpg',
          proxyURL: 'https://media.discordapp.net/external/abc/hq.jpg',
        },
      },
    ],
  });
  const m = normalizeMessage(raw, 'self');
  const link = m.links[0];
  assert.equal(link.thumbnailUrl, 'https://media.discordapp.net/external/abc/hq.jpg');
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
  const link = m.links[0];
  assert.equal(link.thumbnailWidth, 1280);
  assert.equal(link.thumbnailHeight, 720);
  const secondLink = m.links[1];
  assert.equal(secondLink.thumbnailWidth, null);
  assert.equal(secondLink.thumbnailHeight, null);
  const pictures = collectPictures(m);
  assert.deepEqual(
    pictures.map((p) => [p.width, p.height]),
    [
      [1280, 720],
      [null, null],
    ]
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
  const link = m.links[0];
  assert.ok(link.id.startsWith('video:url:'));
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
    embeds: [
      {
        url,
        provider: { name: 'YouTube' },
        title: 'Cool video',
        thumbnail: { url: 'https://i.ytimg.com/vi/xyz/hq.jpg' },
      },
    ],
  });
  const m = normalizeMessage(raw, 'self', { videoSites: VIDEO_SITES });
  assert.equal(m.links.length, 1);
  const link = m.links[0];
  assert.equal(link.id, videoUrlCacheKey(url));
  assert.equal(link.title, 'Cool video');
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
  const link = m.links[0];
  assert.equal(link.id, videoUrlCacheKey('https://youtube.com/watch?v=ID42'));
  assert.equal(link.id, videoUrlCacheKey('https://youtu.be/ID42'));
  assert.equal(link.title, 'Cool video');
  assert.equal(link.thumbnailUrl, 'https://i.ytimg.com/vi/ID42/hq.jpg');
});

test('normalizeMessage: with videoSites set, a non-video embed keeps its existing id', () => {
  const raw = rawMessage({
    embeds: [
      { url: 'https://example.com/page', title: 'A page', thumbnail: { url: 'https://example.com/t.jpg' } },
      { url: 'https://example.com/other', title: 'Other' },
    ],
  });
  const m = normalizeMessage(raw, 'self', { videoSites: VIDEO_SITES });
  const link = m.links[0];
  assert.ok(link.id.startsWith('link:'));
  const secondLink = m.links[1];
  assert.equal(secondLink.id, 'm1#e1');
});

test('normalizeMessage: the same typed video URL twice becomes one synthetic link', () => {
  const raw = rawMessage({ cleanContent: 'https://youtu.be/xyz and again https://youtu.be/xyz' });
  const m = normalizeMessage(raw, 'self', { videoSites: VIDEO_SITES });
  assert.equal(m.links.length, 1);
  const link = m.links[0];
  assert.equal(link.site, 'youtu.be');
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
  const forward = m.forwarded[0];
  assert.equal(forward.links.length, 1);
  const link = forward.links[0];
  assert.equal(link.id, videoUrlCacheKey('https://youtu.be/xyz'));
  assert.equal(forward.content, 'δες αυτό https://youtu.be/xyz');
});

// --- normalizeMessage: forward vs. plain reply -------------------------------
// A real forwarded message's own content is empty; `message.reference` is
// `{ type: MessageReferenceType.Forward, channel_id: <source>, guild_id,
// message_id: <the ORIGINAL message> }`; `message.messageSnapshots` carries
// the forwarded content/media/embeds and has no `author`.

function guildWithChannel(id: string | null, name: string | null) {
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

test("normalizeMessage: a forward's replyToId is null even though message_reference carries the original message id", () => {
  const raw = rawMessage({
    guild: guildWithChannel('c2', 'announcements'),
    reference: { messageId: 'original-msg-id', channelId: 'c2', type: MessageReferenceType.Forward },
    messageSnapshots: new Map([
      [
        'snap1',
        {
          id: 'snap1',
          cleanContent: 'forwarded text',
          attachments: new Map(),
          embeds: [],
          stickers: new Map(),
          flags: flagsWith([]),
        },
      ],
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

// --- normalizeMessage: mentionedAccountIds ---------------------------------

test('normalizeMessage: mentionedAccountIds carries the real mention ids, in order', () => {
  const raw = rawMessage({
    mentions: {
      users: new Map([
        ['u2', {}],
        ['u3', {}],
      ]),
    },
  });
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.mentionedAccountIds, ['u2', 'u3']);
});

test("normalizeMessage: mentionedUsers names each mention as the text reads it (the member's display name, else the user's)", () => {
  const raw = rawMessage({
    mentions: {
      users: new Map([
        ['u2', { globalName: 'Zo\u00eb' }],
        ['u3', { username: 'bo' }],
        ['u4', {}],
      ]),
      members: new Map([['u3', { displayName: 'Bo Nick' }]]),
    },
  });
  assert.deepEqual(normalizeMessage(raw, 'self').mentionedUsers, [
    { id: 'u2', name: 'Zo\u00eb' },
    { id: 'u3', name: 'Bo Nick' },
  ]);
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
  assert.deepEqual(m.mentionedAccountIds, []);
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
      [
        'snap1',
        {
          id: 'snap1',
          content: `<#${CHANNEL_IDS[0]}>`,
          cleanContent: '#ημερολόγιο',
          attachments: new Map(),
          embeds: [],
          stickers: new Map(),
          flags: flagsWith([]),
        },
      ],
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

// --- normalizeMessage: replyPingAccountId -----------------------------------

test('normalizeMessage: replyPingAccountId is the replied-to author put into mentions by the reply ping alone', () => {
  const raw = rawMessage({
    content: 'só isso',
    reference: { messageId: 'm0', channelId: 'c1' },
    mentions: { users: new Map([['u2', {}]]), repliedUser: { id: 'u2' } },
  });
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.mentionedAccountIds, ['u2'], 'mentionedAccountIds itself is unchanged');
  assert.equal(m.replyPingAccountId, 'u2');
});

test('normalizeMessage: replyPingAccountId is null when the replied-to author is also typed as <@id>', () => {
  for (const content of ['<@u2> look', '<@!u2> look']) {
    const raw = rawMessage({
      content,
      reference: { messageId: 'm0', channelId: 'c1' },
      mentions: { users: new Map([['u2', {}]]), repliedUser: { id: 'u2' } },
    });
    assert.equal(normalizeMessage(raw, 'self').replyPingAccountId, null, content);
  }
});

test('normalizeMessage: replyPingAccountId is null for a reply with the ping off (author not in mentions)', () => {
  const raw = rawMessage({
    content: 'quiet reply',
    reference: { messageId: 'm0', channelId: 'c1' },
    mentions: { users: new Map(), repliedUser: { id: 'u2' } },
  });
  assert.equal(normalizeMessage(raw, 'self').replyPingAccountId, null);
});

test('normalizeMessage: replyPingAccountId is null without a reply, and for a forward', () => {
  assert.equal(normalizeMessage(rawMessage(), 'self').replyPingAccountId, null);
  const forward = rawMessage({
    reference: { messageId: 'orig', channelId: 'c2', type: MessageReferenceType.Forward },
    mentions: { users: new Map([['u2', {}]]), repliedUser: { id: 'u2' } },
  });
  assert.equal(normalizeMessage(forward, 'self').replyPingAccountId, null);
});

// --- fetchHistory: a link preview's texts reach normalizeMessage whole ------

// A text over its bound is summarized or kept whole, never cut.
test('fetchHistory: a preview title and a description of 600 characters reach the link item whole', async () => {
  // Catches: the history reader cutting a preview's texts.
  const raw = rawMessage({
    embeds: [{ url: 'https://example.com', title: 'x'.repeat(300), description: 'y'.repeat(600) }],
  });
  const channel = fakeOf<Chan>({ messages: { fetch: async () => new Map([[raw.id, raw]]) } });
  const [message] = await fetchHistory(channel, { limit: 10, selfId: 'self' });
  const preview = loose(message) as { links: Array<{ title: string; text: string }> };
  const [link] = preview.links;
  assert.deepEqual([link.title, link.text], ['x'.repeat(300), 'y'.repeat(600)]);
});

test('fetchHistory: threads videoSites through, a typed video-site URL becomes a link item', async () => {
  const raw = rawMessage({ cleanContent: 'regarde https://www.youtube.com/watch?v=abc' });
  const channel = fakeOf<Chan>({ messages: { fetch: async () => new Map([[raw.id, raw]]) } });

  const [withSites] = await fetchHistory(channel, {
    limit: 10,
    selfId: 'self',
    videoSites: ['youtube.com'],
  });
  assert.equal(loose(withSites).links.length, 1);
  assert.equal(loose(withSites).links[0].url, 'https://www.youtube.com/watch?v=abc');

  const [withoutSites] = await fetchHistory(channel, { limit: 10, selfId: 'self' });
  assert.equal(loose(withoutSites).links.length, 0);
});

test('fetchHistory: asks for at most one page of messages, oldest first in the result', async () => {
  const older = rawMessage({ id: 'm1', createdTimestamp: 1000 });
  const newer = rawMessage({ id: 'm2', createdTimestamp: 2000 });
  const queries: Array<Untyped> = [];
  const channel = fakeOf<Chan>({
    messages: {
      fetch: async (query: Untyped) => {
        queries.push(query);
        return new Map([
          [newer.id, newer],
          [older.id, older],
        ]);
      },
    },
  });
  const messages = await fetchHistory(channel, { limit: 500, selfId: 'self' });
  assert.deepEqual(queries, [{ limit: 100 }]);
  assert.deepEqual(
    messages.map((m) => loose(m).id),
    ['m1', 'm2']
  );
});

// --- fetchMessage: cache first, then one fetch, null on failure ----------------

test('fetchMessage: a cached message is returned without a fetch', async () => {
  const cached = rawMessage({ id: 'm7' });
  const fetches: Array<Untyped> = [];
  const channel = fakeOf<Chan>({
    messages: {
      cache: new Map([['m7', cached]]),
      fetch: async (id: string) => {
        fetches.push(id);
        return null;
      },
    },
  });
  assert.equal(await fetchMessage(channel, 'm7'), cached);
  assert.deepEqual(fetches, []);
});

test('fetchMessage: an uncached message is fetched by id', async () => {
  const fetched = rawMessage({ id: 'm8' });
  const fetches: Array<Untyped> = [];
  const channel = fakeOf<Chan>({
    messages: {
      cache: new Map(),
      fetch: async (id: string) => {
        fetches.push(id);
        return fetched;
      },
    },
  });
  assert.equal(await fetchMessage(channel, 'm8'), fetched);
  assert.deepEqual(fetches, ['m8']);
});

test('fetchMessage: a failed or empty fetch, or a channel without a message cache, is null', async () => {
  const failing = fakeOf<Chan>({
    messages: {
      cache: new Map(),
      fetch: async () => {
        throw new Error('Unknown Message');
      },
    },
  });
  assert.equal(await fetchMessage(failing, 'gone'), null);
  const empty = fakeOf<Chan>({ messages: { cache: new Map(), fetch: async () => undefined } });
  assert.equal(await fetchMessage(empty, 'gone'), null);
  const uncached = rawMessage({ id: 'm9' });
  const noCache = fakeOf<Chan>({ messages: { fetch: async () => uncached } });
  assert.equal(await fetchMessage(noCache, 'm9'), uncached);
});

/** A channel whose bot member holds exactly `granted` permission flags. */
function permChannel({
  granted = [],
  me = { id: 'self-id' },
  viewable = true,
  permissionsFor,
}: { granted?: Untyped; me?: Untyped; viewable?: Untyped; permissionsFor?: Untyped } = {}) {
  return {
    viewable,
    guild: { members: { me } },
    permissionsFor:
      permissionsFor ??
      ((member: Untyped) => (member === me ? { has: (flag: Untyped) => granted.includes(flag) } : null)),
  };
}

test('canAttach: true when the bot member has Attach Files in the channel', () => {
  assert.equal(
    canAttach(permChannel({ granted: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] })),
    true
  );
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

test('canRead: needs Read Message History on a viewable channel, a DM is always yes', () => {
  assert.equal(canRead(permChannel({ granted: [PermissionFlagsBits.ReadMessageHistory] })), true);
  assert.equal(canRead(permChannel({ granted: [PermissionFlagsBits.SendMessages] })), false);
  assert.equal(canRead(permChannel({ granted: [PermissionFlagsBits.ReadMessageHistory], viewable: false })), false);
  assert.equal(canRead(permChannel({ granted: [PermissionFlagsBits.ReadMessageHistory], me: null })), false);
  assert.equal(canRead(dmChannel()), true);
});

test('canReact: needs AddReactions on a viewable channel, a DM is always yes', () => {
  const read: Untyped = PermissionFlagsBits.ReadMessageHistory;
  const react: Untyped = PermissionFlagsBits.AddReactions;
  assert.equal(canReact(permChannel({ granted: [read, react] })), true, 'a read-only channel the bot may react in');
  assert.equal(
    canReact(permChannel({ granted: [read, PermissionFlagsBits.SendMessages] })),
    false,
    'sending is not reacting'
  );
  assert.equal(canReact(permChannel({ granted: [react] })), false, 'Discord also needs Read Message History to react');
  assert.equal(canReact(permChannel({ granted: [read, react], viewable: false })), false);
  assert.equal(canReact(permChannel({ granted: [read, react], me: null })), false);
  assert.equal(canReact(permChannel({ granted: [read, react], permissionsFor: () => null })), false);
  assert.equal(canReact(dmChannel()), true);
});

// --- readable channels, neighbours: a fake guild whose bot member holds per-channel flags ---

const READ = PermissionFlagsBits.ReadMessageHistory;
const SEND = PermissionFlagsBits.SendMessages;

/**
 * A guild with one text channel per case: `granted` flags for the bot member,
 * `lastTs` the time of its newest message (a real snowflake, as lastActivity
 * reads it) and `messages` the raw messages its one page returns.
 */
function fakeGuild(specs: Untyped) {
  const me = { id: 'self-id' };
  const guild = { id: 'g1', members: { me }, channels: { cache: new Map() } };
  for (const spec of specs) {
    const cache = guild.channels.cache;
    cache.set(spec.id, {
      id: spec.id,
      name: spec.name ?? spec.id,
      guild,
      viewable: spec.viewable ?? true,
      lastMessageId: spec.lastTs ? SnowflakeUtil.generate({ timestamp: spec.lastTs }).toString() : null,
      isTextBased: () => spec.text !== false,
      isThread: () => spec.thread === true,
      permissionsFor: (member: Untyped) =>
        member === me ? { has: (flag: Untyped) => (spec.granted ?? []).includes(flag) } : null,
      messages: { fetch: async () => new Map((spec.messages ?? []).map((message: Untyped) => [message.id, message])) },
    });
  }
  return guild;
}

test('readableChannels: threads, non-text and unreadable channels are left out', () => {
  const guild = fakeGuild([
    { id: 'open', granted: [READ, SEND] },
    { id: 'diary', granted: [READ] },
    { id: 'thread', granted: [READ, SEND], thread: true },
    { id: 'voice', granted: [READ, SEND], text: false },
    { id: 'hidden', granted: [SEND] },
    { id: 'unviewable', granted: [READ, SEND], viewable: false },
  ]);
  const bot = {};
  assert.deepEqual(
    readableChannels(guild, bot).map((c) => c.id),
    ['open', 'diary']
  );
  assert.deepEqual(
    readableChannels(guild, bot, 'open').map((c) => c.id),
    ['diary']
  );
  const cache = guild.channels.cache;
  assert.equal(isReadableChannel(cache.get('diary')), true);
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
function audienceChannel({
  roles = Object.values(ROLE),
  overwrites = [],
  thread = false,
  meId = null,
  clientUserId = null,
  members = null,
}: {
  roles?: Array<string>;
  overwrites?: Array<{ id: string; type: number; allow?: bigint; deny?: bigint }>;
  thread?: boolean;
  meId?: string | null;
  clientUserId?: string | null;
  members?: Array<{ id: string; bot: boolean; roleIds?: Array<string> }> | null;
} = {}) {
  const everyone = { id: GUILD_ID, permissions: new PermissionsBitField(VIEW) };
  const all = [everyone, ...roles.map((id: string) => ({ id, permissions: new PermissionsBitField(0n) }))];
  const cache = new Map(
    overwrites.map((o) => [
      o.id,
      {
        id: o.id,
        type: o.type,
        allow: new PermissionsBitField(o.allow ?? 0n),
        deny: new PermissionsBitField(o.deny ?? 0n),
      },
    ])
  );
  const resolve = (role: string) => {
    let bits: Untyped = everyone.permissions.bitfield | loose(role).permissions.bitfield;
    for (const id of loose(role) === everyone ? [loose(everyone).id] : [everyone.id, loose(role).id]) {
      const overwrite = cache.get(id);
      if (loose(overwrite)?.type === OverwriteType.Role)
        bits = (bits & ~loose(overwrite).deny.bitfield) | loose(overwrite).allow.bitfield;
    }
    return new PermissionsBitField(bits);
  };
  return {
    id: 'c-audience',
    guild: {
      id: GUILD_ID,
      members: {
        me: meId ? { id: meId } : null,
        ...(members
          ? {
              cache: new Map(
                members.map(({ id, bot, roleIds }) => [
                  id,
                  {
                    id,
                    user: { id, bot },
                    ...(roleIds ? { roles: { cache: new Map(roleIds.map((r) => [r, { id: r }])) } } : {}),
                  },
                ])
              ),
            }
          : {}),
      },
      roles: { everyone, cache: new Map(all.map((role) => [role.id, role])) },
    },
    client: { user: clientUserId ? { id: clientUserId } : null },
    isThread: () => thread,
    permissionOverwrites: { cache },
    permissionsFor: (target: Untyped) => (all.includes(target) ? resolve(target) : null),
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
  const { memberRoles } = loose(audienceOf(channel));
  assert.deepEqual(memberRoles.get(MEMBER.zoe), new Set([ROLE.regular, ROLE.moderator]));
  assert.deepEqual(memberRoles.get(MEMBER.iason), new Set());
  assert.equal(memberRoles.has(MEMBER.nefeli), false, 'a member missing from the cache has no entry');
  assert.equal(memberRoles.has('unnamed'), false, 'a member no overwrite names has no entry');
});

// The audience rail blocks a role that views the destination but not the
// source (audienceCovers, tests/src/behavior/elsewhere.test.ts); these are the sets that
// make it do so for a role denied on an everyone-visible source (M2).
test('audienceOf: a role denied on an everyone-visible channel is missing from its roles though @everyone views it', () => {
  const source = audienceOf(
    audienceChannel({ overwrites: [{ id: ROLE.muted, type: OverwriteType.Role, deny: VIEW }] })
  );
  const dest = audienceOf(audienceChannel());
  assert.equal(loose(source).everyone, true, '@everyone still views the source');
  assert.deepEqual(loose(source).roles, new Set([GUILD_ID, ROLE.regular, ROLE.moderator]));
  assert.deepEqual(loose(source).roleDeny, new Set([ROLE.muted]));
  assert.equal(loose(dest).everyone, true);
  assert.deepEqual(loose(dest).roles, new Set([GUILD_ID, ...Object.values(ROLE)]));
  assert.deepEqual(loose(dest).roleDeny, new Set());
});

test("audienceOf: the bot's own member overwrite is not part of the audience", () => {
  const botAllow: Untyped = { id: BOT_ID, type: OverwriteType.Member, allow: VIEW | PermissionFlagsBits.SendMessages };
  const botDeny: Untyped = { id: BOT_ID, type: OverwriteType.Member, deny: VIEW };
  const publicChannel = audienceOf(audienceChannel());
  assert.deepEqual(
    audienceOf(audienceChannel({ overwrites: [botAllow], meId: BOT_ID })),
    publicChannel,
    'the bot member from guild.members.me'
  );
  assert.deepEqual(
    audienceOf(audienceChannel({ overwrites: [botAllow], clientUserId: BOT_ID })),
    publicChannel,
    'the bot user from channel.client'
  );
  assert.deepEqual(loose(audienceOf(audienceChannel({ overwrites: [botDeny], meId: BOT_ID }))).memberDeny, new Set());

  const mixed = audienceOf(
    audienceChannel({
      meId: BOT_ID,
      overwrites: [
        botAllow,
        { id: MEMBER.zoe, type: OverwriteType.Member, allow: VIEW },
        { id: MEMBER.iason, type: OverwriteType.Member, deny: VIEW },
      ],
    })
  );
  assert.deepEqual(loose(mixed).memberAllow, new Set([MEMBER.zoe]), "another member's allow stays");
  assert.deepEqual(loose(mixed).memberDeny, new Set([MEMBER.iason]), "another member's deny stays");
  assert.deepEqual(
    loose(audienceOf(audienceChannel({ overwrites: [botAllow] }))).memberAllow,
    new Set([BOT_ID]),
    'with no bot id known, nothing is left out'
  );
});

const OTHER_BOT = { first: '640000000000000001', second: '640000000000000002', third: '640000000000000003' };

// A bot is the same as a person. Another bot's member
// overwrite counts in a channel's audience exactly as a human's does; only the persona's own is left out.
test("audienceOf: a bot's member overwrite counts in the channel's audience like a human's", () => {
  const channel = audienceChannel({
    meId: BOT_ID,
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
    ],
  });
  const audience = audienceOf(channel);
  assert.deepEqual(loose(audience).memberAllow, new Set([OTHER_BOT.first, MEMBER.zoe]));
  assert.deepEqual(loose(audience).memberDeny, new Set([OTHER_BOT.second, MEMBER.iason]));
});

// A bot is the same as a person. A bot allowed by name on
// the main chat and denied by role on the memes channel views one and not the other, so the memes channel is no
// source for the main chat, as it would not be for a human allowed the same way.
test("audienceOf: a bot's allow by name has to be proven on the source like a human's", () => {
  const BOT_ROLE = '610000000000000009';
  const bots = Object.values(OTHER_BOT);
  const shared = { roles: [...Object.values(ROLE), BOT_ROLE], members: bots.map((id) => ({ id, bot: true })) };
  const botRoleDeny: Untyped = { id: BOT_ROLE, type: OverwriteType.Role, deny: VIEW };
  const main = audienceOf(
    audienceChannel({
      ...shared,
      overwrites: [botRoleDeny, ...bots.map((id) => ({ id, type: OverwriteType.Member, allow: VIEW }))],
    })
  );
  const memes = audienceOf(audienceChannel({ ...shared, overwrites: [botRoleDeny] }));
  assert.equal(audienceCovers(main, memes), false, 'the memes channel is no source for the main chat');
  assert.equal(audienceCovers(memes, main), true, 'the main chat is a source for the memes channel');

  const humanAllow = audienceOf(
    audienceChannel({
      ...shared,
      members: [{ id: MEMBER.zoe, bot: false }],
      overwrites: [botRoleDeny, { id: MEMBER.zoe, type: OverwriteType.Member, allow: VIEW }],
    })
  );
  assert.equal(
    audienceCovers(humanAllow, memes),
    false,
    "a human's allow by name still has to be proven on the source"
  );
});

test('audienceOf: a channel without a guild or a thread has no audience', () => {
  assert.equal(audienceOf(dmChannel()), null);
  assert.equal(audienceOf(audienceChannel({ thread: true })), null);
});

// --- normalizeMessage: links to Discord CDN video attachments ------------------

const CDN_VIDEO_URL = 'https://cdn.discordapp.com/attachments/111/222/clip.mp4?ex=aa&is=bb&hm=cc';
const CDN_VIDEO_ENTRY = {
  id: '222',
  kind: 'video',
  name: 'clip.mp4',
  url: CDN_VIDEO_URL,
  size: null,
  durationSec: null,
};

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
    [['attachment', '222', CDN_VIDEO_URL, null]]
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
    attachments: new Map([
      [
        '222',
        { id: '222', contentType: 'video/mp4', name: 'clip.mp4', url: 'https://cdn/real.mp4', size: 9, duration: 4 },
      ],
    ]),
    embeds: [{ url: CDN_VIDEO_URL }],
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.attachments.length, 1);
  assert.equal(loose(m.attachments[0]).url, 'https://cdn/real.mp4');
  assert.deepEqual(m.links, []);
  assert.equal(m.content, '');
});

test('normalizeMessage: a forwarded snapshot carrying a CDN video link gets a video attachment', () => {
  const raw = rawMessage({
    cleanContent: '',
    messageSnapshots: new Map([
      [
        'snap1',
        {
          id: 'snap1',
          cleanContent: CDN_VIDEO_URL,
          attachments: new Map(),
          embeds: [{ url: CDN_VIDEO_URL }],
          stickers: new Map(),
          flags: flagsWith([]),
        },
      ],
    ]),
  });
  const m = normalizeMessage(raw, 'self');
  const forward = m.forwarded[0];
  assert.deepEqual(forward.attachments, [CDN_VIDEO_ENTRY]);
  assert.deepEqual(forward.links, []);
  assert.equal(forward.content, '');
  assert.deepEqual(m.attachments, []);
});

test('normalizeMessage: a Discord CDN picture link stays a link', () => {
  const url = 'https://cdn.discordapp.com/attachments/111/222/pic.png?ex=aa&is=bb&hm=cc';
  const raw = rawMessage({ cleanContent: url, embeds: [{ url }] });
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.attachments, []);
  assert.equal(m.links.length, 1);
  const link = m.links[0];
  assert.equal(link.site, 'cdn.discordapp.com');
});

// --- fetchMessage without an id, isWritableChannel, the neighbours' accept rail --------------

test('fetchMessage: a missing or empty id is null without a request', async () => {
  const fetches: Array<Untyped> = [];
  const channel = fakeOf<Chan>({
    messages: { cache: new Map(), fetch: async (id: string) => (fetches.push(id), rawMessage({ id: 'x' })) },
  });
  for (const id of [undefined, null, '']) assert.equal(await fetchMessage(channel, id), null, String(id));
  assert.deepEqual(fetches, []);
});

test('isWritableChannel: readable and sendable; never an unreadable channel', () => {
  const guild = fakeGuild([
    { id: 'open', granted: [READ, SEND] },
    { id: 'diary', granted: [READ] },
    { id: 'blind', granted: [SEND] },
    { id: 'thread', granted: [READ, SEND], thread: true },
  ]);
  const cache = guild.channels.cache;
  const writable = [...cache.values()].filter((channel) => isWritableChannel(channel)).map((channel) => channel.id);
  assert.deepEqual(writable, ['open']);
});

test('normalizeMessage: a reaction whose emoji getter throws (a REST-only client) is skipped, not fatal', () => {
  const throwing = { count: 3, me: false };
  Object.defineProperty(throwing, 'emoji', {
    get() {
      throw new TypeError("Cannot read properties of null (reading 'emojis')");
    },
  });
  const raw = rawMessage({
    reactions: {
      cache: new Map<string, Untyped>([
        ['a', throwing],
        ['b', { emoji: { id: null, name: '👍' }, count: 1, me: false }],
      ]),
    },
  });
  const m = normalizeMessage(raw, 'self');
  assert.deepEqual(m.reactions, [{ emoji: '👍', count: 1, mine: false }]);
});

// --- normalizeMessage: a posted link's URL stays readable ---------------------

/** The chat-mode transcript line of the last of `messages`, as the persona reads it. */
function lineOf(messages: Parameters<typeof formatTranscript>[0]): string {
  return String(
    loose(
      formatTranscript(messages, {
        mediaNameOf: noMediaNames,
        timezone: 'UTC',
        gapMinutes: 20,
        maxChars: 2000,
        selfName: 'Bot',
        labels,
      }).at(-1)
    ).text
  );
}

test('normalizeMessage: a posted link keeps its URL, tracking parameters included, before its link tag in the transcript', () => {
  const url = 'https://www.youtube.com/watch?v=ID42&si=Ab_Cd-9xYz&t=31';
  const raw = rawMessage({
    cleanContent: `δες ${url} τώρα`,
    embeds: [
      { url, provider: { name: 'YouTube' }, title: 'Clip', thumbnail: { url: 'https://i.ytimg.com/vi/ID42/hq.jpg' } },
    ],
  });
  const m = normalizeMessage(raw, 'self', { videoSites: VIDEO_SITES });
  assert.equal(m.content, `δες ${url} τώρα`);
  assert.equal(m.links.length, 1);
  assert.ok(lineOf([m]).endsWith(`Alice: δες ${url} τώρα [link: YouTube — Clip]`), lineOf([m]));
});

// An emoji and a sticker go by a stable name of the engine.
test('normalizeMessage: attachment, sticker, emoji and Discord CDN file URLs never reach the text or the transcript line', () => {
  const pasted = 'https://media.discordapp.net/attachments/111/333/photo.png?ex=aa&is=bb&hm=cc';
  const raw = rawMessage({
    content: `voilà <:pog:111> ${pasted}`,
    cleanContent: `voilà :pog: ${pasted}`,
    attachments: new Map([
      [
        'a1',
        {
          id: 'a1',
          contentType: 'image/png',
          name: 'pic.png',
          url: 'https://cdn.discordapp.com/attachments/1/9/pic.png',
          size: 1,
        },
      ],
    ]),
    embeds: [{ url: pasted, thumbnail: { url: pasted } }],
    stickers: new Map([['s1', { id: 's1', name: 'pepe', format: 1 }]]),
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.content, 'voilà <emoji:111>');
  const line = lineOf([m]);
  assert.ok(!line.includes('https://'), line);
});

// A text over its bound is summarized or kept whole, never cut.
test('normalizeMessage: a URL of 400 characters arrives whole, in a message and a forward', () => {
  // Catches: a long URL in a message's text cut with an ellipsis.
  const head = `https://example.com/search?q=${'κ'.repeat(10)}&utm_source=`;
  const url = head + 'x'.repeat(400 - [...head].length);
  assert.equal([...url].length, 400);
  const raw = rawMessage({
    cleanContent: `δες ${url} ok`,
    embeds: [{ url, title: 'Search' }],
    messageSnapshots: new Map([
      [
        'snap1',
        {
          id: 'snap1',
          cleanContent: `και ${url}`,
          attachments: new Map(),
          embeds: [],
          stickers: new Map(),
          flags: flagsWith([]),
        },
      ],
    ]),
  });
  const m = normalizeMessage(raw, 'self');
  assert.equal(m.content, `δες ${url} ok`);
  const forward = m.forwarded[0];
  assert.equal(forward.content, `και ${url}`);
  const link = m.links[0];
  assert.equal(link.url, url);
});

test("normalizeMessage: the persona's own posted link reads in their line like anyone's, URL as they wrote it", () => {
  const url = 'https://www.youtube.com/watch?v=xyz&list=PL1';
  const raw = rawMessage({
    author: { id: 'self', bot: true, globalName: 'Bot', username: 'bot' },
    member: { displayName: 'Bot' },
    cleanContent: `να το ${url}`,
    embeds: [{ url, provider: { name: 'YouTube' }, title: 'Cool video' }],
  });
  const m = normalizeMessage(raw, 'self', { videoSites: VIDEO_SITES });
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
    rootId: 'g1',
    channel,
    content: 'hello <@self> <#222222222222222222>',
    cleanContent: 'hello @Bot #news',
    mentions: {
      users: new Map([
        ['self', { id: 'self' }],
        ['u2', { id: 'u2' }],
      ]),
    },
    reference: { messageId: 'm0' },
    ...overrides,
  });
}

test('toEvent: the chat of a channel in a category carries the guild as parent and no category field', () => {
  // Bug: the sidebar grouping crosses the door again, as a parent place or as a text, and the persona is in a place nobody named.
  const channel = {
    id: 'c1',
    name: 'γενικά',
    parentId: 'cat1',
    parent: { id: 'cat1', name: 'κοινότητα' },
    isThread: () => false,
    messages: { cache: new Map() },
  };
  const { chat } = toEvent(guildMessage({ channel }), 'self');
  assert.equal(chat.parentId, 'g1');
  assert.equal(chat.parentKind, 'server');
  assert.equal('category' in chat, false);
});

test('toEvent: a message becomes a valid message.received event, field for field', () => {
  // A category is no place.
  const raw = guildMessage();
  const event = toEvent(raw, 'self');
  assert.deepEqual(validateEvent(event), { ok: true });
  assert.equal(event.kind, 'message.received');
  assert.equal(event.iface, 'discord');
  assert.equal(event.id, 'discord:message:m1');
  assert.equal(event.at, 1000);
  assert.deepEqual(event.chat, {
    id: 'c1',
    kind: 'channel',
    rootId: 'g1',
    name: 'γενικά',
    topic: 'κουβέντα',
    parentId: 'g1',
    parentKind: 'server',
    chatType: 'channel',
  });
  assert.deepEqual(event.message.author, { id: 'u1', name: 'Alice', self: false, bot: false });
  assert.equal(loose(event.message).content, 'hello @Bot #news');
  assert.equal(event.message.at, 1000);
  assert.equal(loose(event.message).replyToId, 'm0');
  assert.deepEqual(event.addressing, {
    mentioned: true,
    replyToSelf: false,
    mentionedAccountIds: ['self', 'u2'],
    mentionedUsers: [],
    mentionedChatIds: ['222222222222222222'],
  });
  assert.equal(event.raw, raw, 'the discord.js message rides along for the Discord side only');
  for (const key of ['channelId', 'authorId', 'authorName', 'ts', 'channelName', 'mentionedAccountIds'])
    assert.ok(!(key in event.message), key);
});

// A webhook's post is a line someone wrote; only the platform's own notices are system.
test("toEvent: a webhook's message is a line of its author, a join notice a system message", () => {
  const hook = toEvent(guildMessage({ webhookId: 'w1', author: { id: 'w1', bot: true, username: 'feed' } }), 'self');
  const { author } = hook.message;
  assert.equal(loose(hook.message).system, false);
  assert.equal(author?.bot, true);
  const joined = toEvent(guildMessage({ system: true }), 'self');
  assert.equal(loose(joined.message).system, true);
});

test('toEvent: a direct chat is a dm chat, a thread a thread', () => {
  // A category is no place.
  const dm = toEvent(rawMessage({ guild: null, channel: { id: 'd1' }, channelId: 'd1' }), 'self');
  assert.deepEqual(dm.chat, {
    id: 'd1',
    kind: 'dm',
    rootId: null,
    name: null,
    topic: null,
    chatType: 'dm',
    partnerId: null,
  });
  assert.deepEqual(validateEvent(dm), { ok: true });
  const thread = toEvent(
    guildMessage({ channel: { id: 't1', name: 'νήμα', isThread: () => true }, channelId: 't1' }),
    'self'
  );
  assert.equal(thread.chat.kind, 'thread');
});

test('toEvent: a one-to-one chat names its partner, a group chat is group_dm, a thread names its channel', () => {
  const dm = toEvent(
    rawMessage({ guild: null, channel: { id: 'd1', type: ChannelType.DM, recipientId: 'u1' }, channelId: 'd1' }),
    'self'
  );
  assert.deepEqual([dm.chat.chatType, dm.chat.partnerId], ['dm', 'u1']);
  assert.equal(
    toEvent(rawMessage({ guild: null, channel: { id: 'd2', recipient: { id: 'u2' } }, channelId: 'd2' }), 'self').chat
      .partnerId,
    'u2'
  );
  const group = toEvent(
    rawMessage({ guild: null, channel: { id: 'g9', name: 'φίλοι', type: ChannelType.GroupDM }, channelId: 'g9' }),
    'self'
  );
  assert.deepEqual([group.chat.kind, group.chat.chatType, 'partnerId' in group.chat], ['dm', 'group_dm', false]);
  const thread = toEvent(
    guildMessage({ channel: { id: 't1', name: 'νήμα', isThread: () => true, parentId: 'c1' }, channelId: 't1' }),
    'self'
  );
  assert.deepEqual([thread.chat.chatType, thread.chat.parentId], ['thread', 'c1']);
  for (const event of [dm, group, thread]) assert.deepEqual(validateEvent(event), { ok: true });
  assert.deepEqual(validateEvent({ ...dm, chat: { ...dm.chat, chatType: 'room' } }), {
    ok: false,
    reason: 'chat.chatType:unknown',
  });
  assert.deepEqual(validateEvent({ ...dm, chat: { ...dm.chat, partnerId: 7 } }), {
    ok: false,
    reason: 'chat.partnerId:type',
  });
});

test('toEvent: replyToSelf is the cached answer only; a forward replies to nothing', () => {
  const channel = {
    id: 'c1',
    isThread: () => false,
    messages: {
      cache: new Map([
        ['m0', { author: { id: 'self' } }],
        ['m9', { partial: true, author: { id: 'self' } }],
      ]),
    },
  };
  assert.equal(loose(toEvent(guildMessage({ channel }), 'self').addressing).replyToSelf, true);
  assert.equal(
    loose(toEvent(guildMessage({ channel, reference: { messageId: 'm9' } }), 'self').addressing).replyToSelf,
    false,
    'a partial cached message is no answer'
  );
  assert.equal(
    loose(toEvent(guildMessage({ channel, reference: { messageId: 'other' } }), 'self').addressing).replyToSelf,
    false
  );
  const forward = toEvent(
    guildMessage({ channel, reference: { messageId: 'm0', channelId: 'c2', type: MessageReferenceType.Forward } }),
    'self'
  );
  assert.equal(loose(forward.message).replyToId, null);
  assert.equal(loose(forward.addressing).replyToSelf, false);
});

test('toEvent: no mention of the persona is mentioned false, whatever else is mentioned', () => {
  const event = toEvent(guildMessage({ mentions: { users: new Map([['u2', { id: 'u2' }]]) } }), 'self');
  assert.equal(loose(event.addressing).mentioned, false);
  assert.deepEqual(loose(event.addressing).mentionedAccountIds, ['u2']);
  assert.equal(loose(toEvent(rawMessage(), 'self').addressing).mentioned, false, 'no mentions at all');
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
  // A category is no place.
  const partial = { id: 'm1', channelId: 'c1', guildId: 'g1', partial: true, author: null };
  const editEvent = toEvent(partial, 'self', { edit: true, now: () => 7000 });
  assert.deepEqual(validateEvent(editEvent), { ok: true });
  assert.deepEqual(
    [editEvent.message, editEvent.edit, editEvent.partial, editEvent.raw],
    [{ id: 'm1' }, true, true, partial]
  );
  const deletion = toEvent(partial, 'self', { deleted: true, now: () => 8000 });
  assert.deepEqual(validateEvent(deletion), { ok: true });
  assert.deepEqual(
    [deletion.message, deletion.deleted, deletion.at, deletion.id],
    [{ id: 'm1' }, true, 8000, 'discord:delete:m1']
  );
  assert.deepEqual(deletion.chat, {
    id: 'c1',
    kind: 'channel',
    rootId: 'g1',
    name: null,
    topic: null,
    parentId: 'g1',
    parentKind: 'server',
    chatType: 'channel',
  });
});

test('reactionEvent: a reaction becomes a valid reaction.changed event, its parts kept for the reactor store', () => {
  const message = {
    id: 'm1',
    channelId: 'c1',
    rootId: 'g1',
    channel: { id: 'c1', name: 'γενικά', isThread: () => false },
  };
  const reaction = { message, emoji: { name: '\u{1F389}', id: null } };
  const user = { id: 'u2' };
  const event = reactionEvent(reaction, user, true, { now: () => 3000 });
  assert.deepEqual(validateEvent(event), { ok: true });
  assert.deepEqual(
    {
      kind: event.kind,
      at: event.at,
      chat: event.chat.id,
      messageId: event.messageId,
      emoji: event.emoji,
      accountId: event.accountId,
      added: event.added,
    },
    {
      kind: 'reaction.changed',
      at: 3000,
      chat: 'c1',
      messageId: 'm1',
      emoji: { name: '\u{1F389}' },
      accountId: 'u2',
      added: true,
    }
  );
  assert.deepEqual(event.raw, { reaction, user });
  const custom = reactionEvent({ message, emoji: { name: 'party', id: '42' } }, user, false, { now: () => 3000 });
  assert.deepEqual([custom.emoji, custom.added], [{ name: 'party', id: '42' }, false]);
  assert.notEqual(custom.id, event.id);
});

test('reactionEvent: an unreadable emoji or a missing message never throws and fails validation', () => {
  const broken = {
    message: null,
    get emoji() {
      throw new Error('REST-only client');
    },
  };
  const event = reactionEvent(broken, { id: 'u2' }, true);
  assert.equal(validateEvent(event).ok, false);
  assert.equal(
    validateEvent(
      reactionEvent(
        { message: { id: 'm1', channelId: 'c1', guildId: 'g1' }, emoji: { name: null } },
        { id: 'u2' },
        true
      )
    ).ok,
    false
  );
});

test('normalizeMessage: editedAt is the edit stamp, null for a message never edited', () => {
  assert.equal(normalizeMessage(rawMessage({ editedTimestamp: 5000 }), 'self').editedAt, 5000);
  assert.equal(normalizeMessage(rawMessage({ editedTimestamp: null }), 'self').editedAt, null);
  assert.equal(normalizeMessage(rawMessage(), 'self').editedAt, null);
});

test('fetchMessage: a partial message in the cache is fetched whole', async () => {
  const whole = { id: 'm1', partial: false, author: { id: 'self' } };
  const channel = fakeOf<Chan>({
    messages: { cache: new Map([['m1', { id: 'm1', partial: true, author: null }]]), fetch: async () => whole },
  });
  assert.equal(await fetchMessage(channel, 'm1'), whole);
});

// Tests for what the Discord package puts on a normalised message and its event for the core: message links as
// neutral references, and attachments and links that expire with the address of their preview
// (interfaces/discord/collect.ts#messageRefsOf and normalizeMessage). Discord objects are plain fixtures.

type Item = {
  id?: string;
  kind?: string;
  name?: string;
  url?: string;
  size?: number;
  durationSec?: number | null;
  width?: number | null;
  height?: number | null;
  expiring?: boolean;
  previewUrl?: string;
};
type Ref = { iface: string; chatId: string; messageId: string; url: string; text: string };
type Normalized = { content: string; attachments: Array<Item>; links: Array<Item>; messageRefs: Array<Ref> };

function isNormalized(value: unknown): value is Normalized {
  return (
    typeof value === 'object' &&
    value !== null &&
    'attachments' in value &&
    Array.isArray(value.attachments) &&
    'links' in value &&
    Array.isArray(value.links) &&
    'messageRefs' in value &&
    Array.isArray(value.messageRefs)
  );
}

// The package's own result, read through the shape this file asserts on.
function normalizedOf(raw: object, selfId: string, options: { imageSize?: number } = {}): Normalized {
  const result: unknown = normalizeRaw(raw, selfId, options);
  if (!isNormalized(result)) throw new Error('normalizeMessage did not return a normalised message');
  return result;
}

function refsRawMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    flags: { has: () => false },
    ...overrides,
  };
}

function refsGuildMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return refsRawMessage({
    guild: { id: 'g1' },
    guildId: 'g1',
    channel: { id: 'c1', name: 'general', isThread: () => false, messages: { cache: new Map() } },
    content: 'hello',
    mentions: { users: new Map() },
    ...overrides,
  });
}

// --- message links as references -------------------------------------------

const LINK = 'https://discord.com/channels/1/2/300';

test('messageRefsOf: a message link in a text is a reference to its chat and message', () => {
  assert.deepEqual(messageRefsOf(`εδώ ${LINK} είπες`), [
    { iface: 'discord', chatId: '2', messageId: '300', url: LINK, text: LINK },
  ]);
});

test('messageRefsOf: the ptb, canary and discordapp hosts and a private chat link give the same reference, written text kept', () => {
  const forms = [
    'https://ptb.discord.com/channels/1/2/300/',
    'https://canary.discordapp.com/channels/1/2/300',
    'https://discordapp.com/channels/1/2/300',
    'https://discord.com/channels/@me/2/300',
  ];
  for (const written of forms) {
    const [ref] = messageRefsOf(`x ${written} y`);
    assert.equal(ref?.chatId, '2', written);
    assert.equal(ref?.messageId, '300', written);
    assert.equal(ref?.text, written, written);
  }
});

test('messageRefsOf: a link in angle brackets keeps the brackets in its text and none in its url', () => {
  assert.deepEqual(messageRefsOf(`voilà <${LINK}>.`), [
    { iface: 'discord', chatId: '2', messageId: '300', url: LINK, text: `<${LINK}>` },
  ]);
});

test('messageRefsOf: two links come in the order they are written, one reference each', () => {
  const other = 'https://discord.com/channels/1/9/301';
  assert.deepEqual(
    messageRefsOf(`${other} und ${LINK}, ${LINK}`).map((ref) => [ref.chatId, ref.messageId]),
    [
      ['9', '301'],
      ['2', '300'],
      ['2', '300'],
    ]
  );
});

test('messageRefsOf: a link followed by a bracket, a comma or a full stop is still a reference', () => {
  assert.equal(messageRefsOf(`(${LINK}), ok`).length, 1);
  assert.equal(messageRefsOf(`${LINK}.`).length, 1);
});

test('messageRefsOf: a link that is not a bare message link gives no reference', () => {
  for (const text of [
    'https://discord.com/channels/1/2/300?x=1',
    'https://discord.com/channels/1/300',
    'https://example.com/channels/1/2/300',
    'xhttps://discord.com/channels/1/2/300',
    'plain #12 text',
    '',
  ]) {
    assert.deepEqual(messageRefsOf(text), [], text);
  }
});

test('normalizeMessage: a message link in the text rides on the message as a reference and stays in the content', () => {
  const m = normalizedOf(refsRawMessage({ cleanContent: `εδώ ${LINK} είπες` }), 'self');
  assert.deepEqual(m.messageRefs, [{ iface: 'discord', chatId: '2', messageId: '300', url: LINK, text: LINK }]);
  assert.equal(m.content, `εδώ ${LINK} είπες`);
});

test('normalizeMessage: a message without a message link has no references', () => {
  assert.deepEqual(normalizedOf(refsRawMessage({ cleanContent: 'see https://example.com/a' }), 'self').messageRefs, []);
});

test('toEvent: the message of the event carries its message links as references and the event is valid', () => {
  const event = toEvent(refsGuildMessage({ cleanContent: `look ${LINK}` }), 'self');
  assert.deepEqual(validateEvent(event), { ok: true });
  const message = event.message;
  if (!('messageRefs' in message)) assert.fail('the event carries no normalized message');
  assert.deepEqual(message.messageRefs, [{ iface: 'discord', chatId: '2', messageId: '300', url: LINK, text: LINK }]);
});

// --- attachments and links that expire --------------------------------------

const SIGNED = 'ex=65a1b2c3&is=65a0a1b2&hm=abc123';

test('normalizeMessage: an attachment of the Discord CDN is expiring and carries a preview url on the media proxy', () => {
  const url = `https://cdn.discordapp.com/attachments/111/222/pic.png?${SIGNED}`;
  const raw = refsRawMessage({
    attachments: new Map([['a1', { id: 'a1', contentType: 'image/png', name: 'pic.png', url, size: 5 }]]),
  });
  const [attachment] = normalizedOf(raw, 'self').attachments;
  assert.equal(attachment.expiring, true);
  assert.equal(attachment.url, url, 'the url itself is unchanged');
  const preview = new URL(attachment.previewUrl ?? '');
  assert.equal(preview.hostname, 'media.discordapp.net');
  assert.equal(preview.pathname, '/attachments/111/222/pic.png');
  assert.equal(preview.searchParams.get('hm'), 'abc123', 'the signature survives');
});

test('normalizeMessage: a link on the Discord CDN is expiring and a link elsewhere is not', () => {
  const cdn = `https://media.discordapp.net/attachments/1/2/dance.gif?${SIGNED}`;
  const embed = {
    type: 'image',
    url: cdn,
    thumbnail: { url: cdn, proxyURL: cdn, width: 4, height: 4, contentType: 'image/gif' },
  };
  const onCdn = normalizedOf(refsRawMessage({ cleanContent: cdn, content: cdn, embeds: [embed] }), 'self');
  const link = onCdn.links[0];
  assert.equal(link.expiring, true);
  const page = normalizedOf(
    refsRawMessage({
      cleanContent: 'https://example.com/page',
      embeds: [{ url: 'https://example.com/page', title: 'A page', description: 'd', provider: null }],
    }),
    'self'
  );
  const link2 = page.links[0];
  assert.equal(link2.expiring, false);
});

// What the describer downloads: the picture sized to `media.imageSize` on the media proxy (the cases that lived in
// tests/src/memory/describe.test.ts while the core built the address).
function attachmentPreview(
  attachment: Item & { contentType: string },
  options = { imageSize: 256 }
): string | undefined {
  const raw = refsRawMessage({ attachments: new Map([['a1', { id: 'a1', size: 5, ...attachment }]]) });
  return normalizedOf(raw, 'self', options).attachments[0].previewUrl;
}

test('normalizeMessage: the preview of an image of known size keeps its aspect inside media.imageSize, as webp', () => {
  const preview = attachmentPreview({
    contentType: 'image/png',
    name: 'pic.png',
    url: 'https://cdn.discordapp.com/attachments/1/2/pic.png?ex=1',
    width: 988,
    height: 1306,
  });
  assert.equal(preview, 'https://media.discordapp.net/attachments/1/2/pic.png?ex=1&width=194&height=256&format=webp');
});

test('normalizeMessage: the preview of a picture of unknown size carries no width or height', () => {
  const preview = attachmentPreview({
    contentType: 'image/png',
    name: 'pic.png',
    url: 'https://cdn.discordapp.com/attachments/1/2/pic.png?ex=1',
  });
  assert.equal(preview, 'https://media.discordapp.net/attachments/1/2/pic.png?ex=1&format=webp');
});

test('normalizeMessage: the preview of a video is a webp poster frame with no width or height', () => {
  const preview = attachmentPreview({
    contentType: 'video/mp4',
    name: 'clip.mp4',
    url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4?ex=1',
  });
  assert.equal(preview, 'https://media.discordapp.net/attachments/1/2/clip.mp4?ex=1&format=webp');
});

test('collectPictures: a picture carries the preview url of its attachment', () => {
  const url = 'https://cdn.discordapp.com/attachments/1/2/pic.png?ex=1';
  const raw = refsRawMessage({
    attachments: new Map([['a1', { id: 'a1', contentType: 'image/png', name: 'pic.png', url, size: 5 }]]),
  });
  const m = normalizedOf(raw, 'self', { imageSize: 256 });
  const [picture] = collectPictures(m);
  if (picture === undefined || !('previewUrl' in picture)) assert.fail('the picture carries no preview url');
  const attachment = m.attachments[0];
  assert.equal(picture.previewUrl, attachment.previewUrl);
});

// These two pin the shapes the adapter hands the core, which include the expiring flag, the preview address and the preview size setting.
test('normalizeMessage: classifies attachments through media.js, keeping url/size/duration', () => {
  const raw = refsRawMessage({
    attachments: new Map([
      ['a1', { id: 'a1', contentType: 'image/png', name: 'pic.png', url: 'https://cdn/pic.png', size: 123 }],
      [
        'a2',
        {
          id: 'a2',
          contentType: 'video/mp4',
          name: 'clip.mp4',
          url: 'https://cdn/clip.mp4',
          size: 456,
          duration: null,
        },
      ],
    ]),
  });
  const m = normalizedOf(raw, 'self');
  const { id, kind, name, url, size, durationSec, width, height } = m.attachments[0];
  assert.deepEqual(
    { id, kind, name, url, size, durationSec, width, height },
    {
      id: 'a1',
      kind: 'image',
      name: 'pic.png',
      url: 'https://cdn/pic.png',
      size: 123,
      durationSec: null,
      width: null,
      height: null,
    }
  );
  const secondAttachment = m.attachments[1];
  assert.equal(secondAttachment.kind, 'video');
});

// A text over its bound is summarized or kept whole, never cut.
test('normalizeOptions: the normaliser settings from the config, absent ones left to its defaults', () => {
  const config = { media: { embedTextChars: 50, video: { sites: ['a'] } }, context: { maxUrlChars: 30 } };
  // `media.imageSize` is the package's constant, 512, whatever the config says.
  // A config that still names the removed bounds of a URL and a preview's texts passes neither on.
  assert.deepEqual(normalizeOptions(config), { videoSites: ['a'], imageSize: 512 });
  assert.deepEqual(normalizeOptions({}), { videoSites: undefined, imageSize: 512 });
});

const SELF_ID = '900000000000000001';

const GENERAL = '800000000000000101';

const NEWS = '800000000000000202';

test('channelDirectoryOf: the readable text channels, never a thread', () => {
  // A category is no place.
  const guild = { members: { me: { id: SELF_ID } } };
  const channel = (
    id: string,
    name: string,
    {
      thread = false,
      parent = null,
      readable = true,
    }: { thread?: boolean; parent?: { name: string } | null; readable?: boolean } = {}
  ) => ({
    id,
    name,
    guild,
    viewable: true,
    parent,
    isTextBased: () => true,
    isThread: () => thread,
    permissionsFor: () => ({ has: () => readable }),
  });
  loose(guild).channels = {
    cache: new Map([
      [GENERAL, channel(GENERAL, 'γενικά')],
      [NEWS, channel(NEWS, '💖νέα', { parent: { name: 'Κοινότητα' } })],
      ['800000000000000404', channel('800000000000000404', 'ένα νήμα', { thread: true, parent: { name: 'γενικά' } })],
      ['800000000000000505', channel('800000000000000505', 'κρυφό', { readable: false })],
    ]),
  };
  // @ts-expect-error: guildChannelDirectory takes one argument; the second is ignored
  assert.deepEqual(guildChannelDirectory(guild, {}), [
    { id: GENERAL, name: 'γενικά' },
    { id: NEWS, name: '💖νέα' },
  ]);
  // @ts-expect-error: guildChannelDirectory takes one argument; the second is ignored
  assert.deepEqual(guildChannelDirectory(null, {}), [], 'a private chat has none');
});

test('the Discord adapter declares the root as the parent of a channel in a category, and none for a DM', () => {
  // A category is no place.
  // Bug: a Discord object crosses the door, or a channel in a category reports the category as its parent.
  const inCategory = {
    id: 'c1',
    placeId: 'g1',
    guild: { id: 'g1' },
    type: ChannelType.GuildText,
    name: 'general',
    parentId: 'cat1',
    parent: { id: 'cat1', name: 'Rooms', type: ChannelType.GuildCategory },
    isThread: () => false,
  };
  const room = chatOfChannel(inCategory);
  assert.equal(room.kind, 'channel');
  assert.equal(room.parentId, 'g1');
  assert.deepEqual(room, JSON.parse(JSON.stringify(room)));
  assert.equal((room as { parentKind?: unknown }).parentKind, 'server');

  const direct = chatOfChannel({ id: 'd1', type: ChannelType.DM, recipientId: 'u1', isThread: () => false });
  assert.equal(direct.kind, 'dm');
  assert.equal(direct.rootId, null);
  assert.equal(direct.parentId, undefined);
});
