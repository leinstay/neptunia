// Tests for interfaces/discord/embed.ts: what a Discord embed is as a media item (a GIF or a link with its thumbnail),
// and that a classified GIF-picker post is never a page the core reads (src/media/classify.js#collectReadableLinks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectReadableLinks } from '../src/media/classify.js';
import { classifyEmbed } from '../interfaces/discord/embed.ts';

// --- classifyEmbed -----------------------------------------------------------

test('classifyEmbed: a tenor embed classifies as gif via its provider name', () => {
  const embed = {
    url: 'https://tenor.com/view/x',
    provider: { name: 'Tenor' },
    title: 'cat',
    thumbnail: { url: 'https://t.tenor.com/x.png' },
  };
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
    thumbnail: {
      url: 'https://media.tenor.com/x/AAAAe/x.png',
      proxyURL: 'https://images-ext-1.discordapp.net/external/t/x.png',
    },
    video: {
      url: 'https://media.tenor.com/x/AAAPo/x.mp4',
      proxyURL: 'https://images-ext-1.discordapp.net/external/v/x.mp4',
    },
  };
  assert.equal(classifyEmbed(embed).animationUrl, 'https://images-ext-1.discordapp.net/external/v/x.mp4');
  const bare = classifyEmbed({ ...embed, video: { url: 'https://media.tenor.com/x/AAAPo/x.mp4' } });
  assert.equal(bare.animationUrl, 'https://media.tenor.com/x/AAAPo/x.mp4');
  assert.equal(
    bare.thumbnailUrl,
    'https://images-ext-1.discordapp.net/external/t/x.png',
    'the still thumbnail is unchanged'
  );
});

test('classifyEmbed: a direct .gif link on a GIF host is its own animation; a gif embed without either has none', () => {
  const direct = classifyEmbed({
    url: 'https://media.giphy.com/media/abc/giphy.GIF?cid=1',
    thumbnail: { url: 'https://media.giphy.com/media/abc/giphy.gif' },
  });
  assert.equal(direct.kind, 'gif');
  assert.equal(direct.animationUrl, 'https://media.giphy.com/media/abc/giphy.GIF?cid=1');
  const page = classifyEmbed({
    url: 'https://tenor.com/view/x',
    provider: { name: 'Tenor' },
    thumbnail: { url: 'https://t.tenor.com/x.png' },
  });
  assert.equal('animationUrl' in page, false);
});

test('classifyEmbed: a link embed never carries animationUrl, even with a video or a .gif URL', () => {
  const youtube = classifyEmbed({
    url: 'https://www.youtube.com/watch?v=xyz',
    video: { url: 'https://www.youtube.com/embed/xyz' },
  });
  assert.equal('animationUrl' in youtube, false);
  const other = classifyEmbed({ url: 'https://example.com/a.gif', thumbnail: { url: 'https://example.com/a.gif' } });
  assert.equal(other.kind, 'link');
  assert.equal('animationUrl' in other, false);
});

/**
 * A pasted link to a file on the Discord CDN as Discord embeds it: an `image` embed whose thumbnail is the file itself.
 * @param {string} url
 * @param {{ contentType?: string, proxyURL?: string }} [options]
 */
function discordFileEmbed(url, { contentType = 'image/gif', proxyURL = url } = {}) {
  return {
    type: 'image',
    url,
    thumbnail: { url, proxyURL, width: 498, height: 280 },
    data: { type: 'image', thumbnail: { content_type: contentType } },
  };
}

test('classifyEmbed: a Discord-hosted .gif link is a gif: the proxy URL as the still, the file as the animation', () => {
  const url = 'https://media.discordapp.net/attachments/1/2/dance.gif?ex=1&is=2&hm=3';
  const proxyURL = 'https://media.discordapp.net/attachments/1/2/dance.gif?ex=1&is=2&hm=3&width=498&height=280';
  const item = classifyEmbed(discordFileEmbed(url, { proxyURL }));
  assert.equal(item.kind, 'gif');
  assert.equal(item.thumbnailUrl, proxyURL);
  assert.equal(item.animationUrl, url);
  assert.equal(item.url, url);
  const cdn = classifyEmbed({
    url: 'https://cdn.discordapp.com/attachments/1/2/Dance.GIF',
    thumbnail: { url: 'https://cdn.discordapp.com/attachments/1/2/Dance.GIF' },
  });
  assert.equal(cdn.kind, 'gif', 'cdn.discordapp.com, an upper-case extension, no content type');
  assert.equal(cdn.animationUrl, 'https://cdn.discordapp.com/attachments/1/2/Dance.GIF');
});

test('classifyEmbed: a Discord-hosted link whose thumbnail is image/gif is a gif whatever its path', () => {
  const url = 'https://media.discordapp.net/attachments/1/2/dance';
  const viaData = classifyEmbed(discordFileEmbed(url));
  assert.equal(viaData.kind, 'gif', "a discord.js Embed's data.thumbnail.content_type");
  assert.equal(viaData.animationUrl, url);
  const viaField = classifyEmbed({ url, thumbnail: { url, contentType: 'IMAGE/GIF' } });
  assert.equal(viaField.kind, 'gif', 'a plain thumbnail.contentType');
});

test('classifyEmbed: any other Discord-hosted file, or a .gif elsewhere, stays a link', () => {
  const rows = [
    {
      label: 'a .png on media.discordapp.net',
      embed: discordFileEmbed('https://media.discordapp.net/attachments/1/2/a.png', { contentType: 'image/png' }),
    },
    {
      label: 'a .png on cdn.discordapp.com',
      embed: {
        url: 'https://cdn.discordapp.com/attachments/1/2/a.png',
        thumbnail: { url: 'https://cdn.discordapp.com/attachments/1/2/a.png' },
      },
    },
    {
      label: 'a gif content type off Discord',
      embed: { url: 'https://example.com/a', thumbnail: { url: 'https://example.com/a', contentType: 'image/gif' } },
    },
    { label: 'a lookalike host', embed: { url: 'https://media.discordapp.net.example.com/a.gif' } },
  ];
  for (const { label, embed } of rows) {
    const item = classifyEmbed(embed);
    assert.equal(item.kind, 'link', label);
    assert.equal('animationUrl' in item, false, label);
  }
});

/** A GIF-picker post as Discord delivers it: a `gifv` embed of a provider the code has no name for. */
function pickerEmbed(overrides = {}) {
  return {
    type: 'gifv',
    url: 'https://gifs.example.net/gifs/dancing-cat',
    provider: { name: 'Gifland' },
    thumbnail: {
      url: 'https://static.gifs.example.net/x/still.webp',
      proxyURL: 'https://images-ext-1.discordapp.net/external/t/still.webp',
    },
    video: {
      url: 'https://static.gifs.example.net/x/loop.mp4',
      proxyURL: 'https://images-ext-1.discordapp.net/external/v/loop.mp4',
    },
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
  const bare = classifyEmbed({
    url: 'https://klipy.com/gifs/dancing-cat',
    thumbnail: { url: 'https://static.klipy.com/x/still.webp' },
  });
  assert.equal(bare.kind, 'gif');
  assert.equal(bare.url, 'https://klipy.com/gifs/dancing-cat');
  const picker = classifyEmbed(pickerEmbed({ url: 'https://klipy.com/gifs/dancing-cat', provider: { name: 'Klipy' } }));
  assert.equal(picker.kind, 'gif');
  assert.equal(picker.animationUrl, 'https://images-ext-1.discordapp.net/external/v/loop.mp4');
});

test('classifyEmbed: tenor and giphy stay gifs exactly as before; an embed of another type stays a link', () => {
  const rows = [
    {
      label: 'tenor by provider',
      embed: { url: 'https://tenor.com/view/x', provider: { name: 'Tenor' } },
      kind: 'gif',
    },
    { label: 'giphy by host', embed: { url: 'https://giphy.com/gifs/x' }, kind: 'gif' },
    {
      label: 'tenor gifv',
      embed: { type: 'gifv', url: 'https://tenor.com/view/x', provider: { name: 'Tenor' } },
      kind: 'gif',
    },
    {
      label: 'a rich page',
      embed: { type: 'rich', url: 'https://example.com/a', provider: { name: 'Example' } },
      kind: 'link',
    },
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

test('collectReadableLinks: a gifv embed from any provider is never a page to read', () => {
  const message = {
    id: 'm1',
    links: [
      { id: 'm1#e0', ...classifyEmbed(pickerEmbed()) },
      { id: 'm1#e1', ...classifyEmbed({ url: 'https://example.com/a' }) },
    ],
  };
  assert.deepEqual(
    collectReadableLinks(message).map((link) => link.id),
    ['m1#e1']
  );
});

test('classifyEmbed: title/description are truncated to embedTextChars', () => {
  const embed = { url: 'https://example.com', title: 'x'.repeat(50), description: 'y'.repeat(50) };
  const item = classifyEmbed(embed, { embedTextChars: 10 });
  assert.equal(item.title, `${'x'.repeat(10)}…`);
  assert.equal(item.text, `${'y'.repeat(10)}…`);
});
