// Tests for the link items of the owner's command line lines (src/interface/cli-line-links.ts): the URLs of his text
// become the link items and message references a Discord line carries, so the core's media collectors watch a video,
// read a page and number a linked message. The interface's `parseLinks` read is a fake; nothing touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoSitesOf, withLineLinks } from '../src/interface/cli-line-links.ts';
import type { LineLinkDeps, LineMessage } from '../src/interface/cli-line-links.ts';
import { collectReadableLinks, collectVideos } from '../src/media/classify.ts';
import type { MessageRef } from '../src/protocol/adapter.ts';

const SITES: ReadonlyArray<string> = ['youtube.com', 'youtu.be'];
const DISCORD_LINK = 'https://discord.com/channels/111/222/333';

function line(content: string): LineMessage {
  return {
    id: 'm1',
    author: { id: 'owner', name: 'owner', self: false, bot: false },
    content,
    sourceText: content,
    system: false,
    at: 1,
    replyToId: null,
    replyPingAccountId: null,
    forwardedFrom: null,
    attachments: [],
    links: [],
    forwarded: [],
    stickers: [],
    emojis: [],
    reactions: [],
  };
}

/** A fake interface read: a Discord message link names its message, every other text names none. */
function deps(asked: Array<ReadonlyArray<string>> = []): LineLinkDeps {
  return {
    videoSites: SITES,
    parseLinks(texts) {
      asked.push(texts);
      const refs = texts.map((text): MessageRef | null => {
        const match = /^https:\/\/discord\.com\/channels\/\d+\/(\d+)\/(\d+)$/.exec(text);
        return match?.[1] !== undefined && match[2] !== undefined
          ? { iface: 'discord', chatId: match[1], messageId: match[2] }
          : null;
      });
      return Promise.resolve({ refs });
    },
  };
}

test('a video URL in a line becomes a link item the video collector watches', async () => {
  const message = await withLineLinks(line('look https://youtu.be/abc123 now'), deps());
  const videos = collectVideos(message, { videoSites: SITES });
  assert.equal(videos.length, 1);
  assert.equal(videos[0]?.url, 'https://youtu.be/abc123');
  assert.equal(videos[0]?.kind, 'link');
  assert.deepEqual(collectReadableLinks(message, { videoSites: SITES }), []);
});

test('a page URL in a line becomes a readable link for the page preview', async () => {
  const message = await withLineLinks(line('read https://example.org/article, then tell me'), deps());
  const readable = collectReadableLinks(message, { videoSites: SITES });
  assert.equal(readable.length, 1);
  assert.equal(readable[0]?.url, 'https://example.org/article');
  assert.equal(readable[0]?.site, 'example.org');
  assert.deepEqual(collectVideos(message, { videoSites: SITES }), []);
});

test('a Discord message link resolves through the interface to a message reference and no link item', async () => {
  const message = await withLineLinks(line(`what about <${DISCORD_LINK}>`), deps());
  assert.deepEqual(message.messageRefs, [
    { iface: 'discord', chatId: '222', messageId: '333', url: DISCORD_LINK, text: `<${DISCORD_LINK}>` },
  ]);
  assert.deepEqual(message.links, []);
});

test('a line without a URL is unchanged and asks the interface nothing', async () => {
  const asked: Array<ReadonlyArray<string>> = [];
  const original = line('just words, no address');
  const message = await withLineLinks(original, deps(asked));
  assert.deepEqual(message, original);
  assert.deepEqual(asked, []);
});

test('a line keeps its page link when the interface cannot read links', async () => {
  const silent: LineLinkDeps = { videoSites: SITES, parseLinks: () => Promise.resolve(null) };
  const message = await withLineLinks(line(`see ${DISCORD_LINK} and https://example.org/a`), silent);
  assert.equal(message.messageRefs, undefined);
  assert.deepEqual(
    collectReadableLinks(message, { videoSites: SITES }).map((link) => link.url),
    [DISCORD_LINK, 'https://example.org/a']
  );
});

test('the same URL written twice gives one link item', async () => {
  const message = await withLineLinks(line('https://example.org/a and again https://example.org/a'), deps());
  assert.equal(message.links.length, 1);
});

test('the video sites are read from media.video.sites, and a missing list reads as none', () => {
  assert.deepEqual(videoSitesOf({ media: { video: { sites: ['youtube.com', 7] } } }), ['youtube.com']);
  assert.deepEqual(videoSitesOf({ media: {} }), []);
});
