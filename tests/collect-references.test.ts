// Tests for what the Discord package puts on a normalised message and its event for the core: message links as
// neutral references, and attachments and links that expire with the address of their preview
// (interfaces/discord/collect.js#messageRefsOf and normalizeMessage). Discord objects are plain fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  messageRefsOf,
  normalizeMessage as normalizeRaw,
  normalizeOptions,
  toEvent,
} from '../interfaces/discord/index.js';
import { collectPictures } from '../src/media/classify.js';
import { validateEvent } from '../src/protocol/index.js';

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
type Ref = { iface: string; conversationId: string; messageId: string; url: string; text: string };
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
function normalizeMessage(raw: object, selfId: string, options: { imageSize?: number } = {}): Normalized {
  const result: unknown = normalizeRaw(raw, selfId, options);
  if (!isNormalized(result)) throw new Error('normalizeMessage did not return a normalised message');
  return result;
}

function rawMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function guildMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return rawMessage({
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

test('messageRefsOf: a message link in a text is a reference to its conversation and message', () => {
  assert.deepEqual(messageRefsOf(`εδώ ${LINK} είπες`), [
    { iface: 'discord', conversationId: '2', messageId: '300', url: LINK, text: LINK },
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
    assert.equal(ref?.conversationId, '2', written);
    assert.equal(ref?.messageId, '300', written);
    assert.equal(ref?.text, written, written);
  }
});

test('messageRefsOf: a link in angle brackets keeps the brackets in its text and none in its url', () => {
  assert.deepEqual(messageRefsOf(`voilà <${LINK}>.`), [
    { iface: 'discord', conversationId: '2', messageId: '300', url: LINK, text: `<${LINK}>` },
  ]);
});

test('messageRefsOf: two links come in the order they are written, one reference each', () => {
  const other = 'https://discord.com/channels/1/9/301';
  assert.deepEqual(
    messageRefsOf(`${other} und ${LINK}, ${LINK}`).map((ref) => [ref.conversationId, ref.messageId]),
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
  const m = normalizeMessage(rawMessage({ cleanContent: `εδώ ${LINK} είπες` }), 'self');
  assert.deepEqual(m.messageRefs, [{ iface: 'discord', conversationId: '2', messageId: '300', url: LINK, text: LINK }]);
  assert.equal(m.content, `εδώ ${LINK} είπες`);
});

test('normalizeMessage: a message without a message link has no references', () => {
  assert.deepEqual(normalizeMessage(rawMessage({ cleanContent: 'see https://example.com/a' }), 'self').messageRefs, []);
});

test('toEvent: the message of the event carries its message links as references and the event is valid', () => {
  const event = toEvent(guildMessage({ cleanContent: `look ${LINK}` }), 'self');
  assert.deepEqual(validateEvent(event), { ok: true });
  const message = event.message;
  if (!('messageRefs' in message)) assert.fail('the event carries no normalized message');
  assert.deepEqual(message.messageRefs, [
    { iface: 'discord', conversationId: '2', messageId: '300', url: LINK, text: LINK },
  ]);
});

// --- attachments and links that expire --------------------------------------

const SIGNED = 'ex=65a1b2c3&is=65a0a1b2&hm=abc123';

test('normalizeMessage: an attachment of the Discord CDN is expiring and carries a preview url on the media proxy', () => {
  const url = `https://cdn.discordapp.com/attachments/111/222/pic.png?${SIGNED}`;
  const raw = rawMessage({
    attachments: new Map([['a1', { id: 'a1', contentType: 'image/png', name: 'pic.png', url, size: 5 }]]),
  });
  const [attachment] = normalizeMessage(raw, 'self').attachments;
  assert.equal(attachment.expiring, true);
  assert.equal(attachment.url, url, 'the url itself is unchanged');
  const preview = new URL(attachment.previewUrl ?? '');
  assert.equal(preview.hostname, 'media.discordapp.net');
  assert.equal(preview.pathname, '/attachments/111/222/pic.png');
  assert.equal(preview.searchParams.get('hm'), 'abc123', 'the signature survives');
});

test('normalizeMessage: the preview url of a GIF attachment asks for one still frame', () => {
  const url = `https://cdn.discordapp.com/attachments/111/222/loop.gif?${SIGNED}`;
  const raw = rawMessage({
    attachments: new Map([['a1', { id: 'a1', contentType: 'image/gif', name: 'loop.gif', url, size: 5 }]]),
  });
  const [attachment] = normalizeMessage(raw, 'self').attachments;
  assert.equal(attachment.kind, 'gif');
  assert.equal(new URL(attachment.previewUrl ?? '').searchParams.get('animated'), 'false');
});

test('normalizeMessage: a link on the Discord CDN is expiring and a link elsewhere is not', () => {
  const cdn = `https://media.discordapp.net/attachments/1/2/dance.gif?${SIGNED}`;
  const embed = {
    type: 'image',
    url: cdn,
    thumbnail: { url: cdn, proxyURL: cdn, width: 4, height: 4, contentType: 'image/gif' },
  };
  const onCdn = normalizeMessage(rawMessage({ cleanContent: cdn, content: cdn, embeds: [embed] }), 'self');
  assert.equal(onCdn.links[0].expiring, true);
  const page = normalizeMessage(
    rawMessage({
      cleanContent: 'https://example.com/page',
      embeds: [{ url: 'https://example.com/page', title: 'A page', description: 'd', provider: null }],
    }),
    'self'
  );
  assert.equal(page.links[0].expiring, false);
});

// What the describer downloads: the picture sized to `media.imageSize` on the media proxy (the cases that lived in
// tests/describe.test.js while the core built the address).
function attachmentPreview(
  attachment: Item & { contentType: string },
  options = { imageSize: 256 }
): string | undefined {
  const raw = rawMessage({ attachments: new Map([['a1', { id: 'a1', size: 5, ...attachment }]]) });
  return normalizeMessage(raw, 'self', options).attachments[0].previewUrl;
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

test('normalizeMessage: the preview of a GIF of known size is one still png frame inside media.imageSize', () => {
  const preview = attachmentPreview({
    contentType: 'image/gif',
    name: 'anim.gif',
    url: 'https://cdn.discordapp.com/attachments/1/2/anim.gif?ex=1',
    width: 498,
    height: 280,
  });
  assert.equal(
    preview,
    'https://media.discordapp.net/attachments/1/2/anim.gif?ex=1&width=256&height=144&format=png&animated=false'
  );
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

test('normalizeOptions: media.imageSize reaches the normaliser as imageSize', () => {
  assert.equal(normalizeOptions({ media: { imageSize: 384 } }).imageSize, 384);
});

test('collectPictures: a picture carries the preview url of its attachment', () => {
  const url = 'https://cdn.discordapp.com/attachments/1/2/pic.png?ex=1';
  const raw = rawMessage({
    attachments: new Map([['a1', { id: 'a1', contentType: 'image/png', name: 'pic.png', url, size: 5 }]]),
  });
  const m = normalizeMessage(raw, 'self', { imageSize: 256 });
  const [picture] = collectPictures(m);
  if (picture === undefined || !('previewUrl' in picture)) assert.fail('the picture carries no preview url');
  assert.equal(picture.previewUrl, m.attachments[0].previewUrl);
});

// Moved from tests/collect.test.js: these two pin the shapes the adapter hands the core, which now include the
// expiring flag, the preview address and the preview size setting.
test('normalizeMessage: classifies attachments through media.js, keeping url/size/duration', () => {
  const raw = rawMessage({
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
  const m = normalizeMessage(raw, 'self');
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
  assert.equal(m.attachments[1].kind, 'video');
});

test('normalizeOptions: the normaliser settings from the config, absent ones left to its defaults', () => {
  const config = { media: { embedTextChars: 50, video: { sites: ['a'] } }, context: { maxUrlChars: 30 } };
  // `imageSize` (media.imageSize, the size of a preview) is covered in tests/collect-references.test.js.
  assert.deepEqual(normalizeOptions(config), {
    embedTextChars: 50,
    videoSites: ['a'],
    maxUrlChars: 30,
    imageSize: undefined,
  });
  assert.deepEqual(normalizeOptions({}), {
    embedTextChars: undefined,
    videoSites: undefined,
    maxUrlChars: undefined,
    imageSize: undefined,
  });
});
