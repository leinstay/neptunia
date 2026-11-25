// The media prefill of an observed line (src/pipeline/media-prefill.ts): when a message with a library GIF appears, the
// file of the GIF is downloaded once from its direct media address and kept on the library entry. A real store over a temp folder, a fake download, no describer.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMediaPrefill } from '../../../src/pipeline/media-prefill.ts';
import { createStore } from '../../../src/memory/store.ts';
import { memDataDir } from '../../fixtures/store-kit.ts';
import type { GifBytes } from '../../../src/media/gif-files.ts';
import { deepMerge } from '../../../src/config.ts';
import { labels } from '../../fixtures/labels.ts';
import {
  baseConfig,
  fakeAddressPrompts,
  fakeChannelWithHistory,
  fakeDescriber,
  fakeFollowUpLlm,
  fakeGuild,
  fakeMessage,
  fakeStore,
  makeHandler,
  openFollowUpWindow,
  pictureAttachments,
} from '../../fixtures/events-rig.ts';
import { useIface, useSelf } from '../../fixtures/turn-world.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import type { MediaName } from '../../../src/memory/store-media-names.ts';
import { wrongly, present } from '../../fixtures/loose-types.ts';
import { ownedBy } from '../../fixtures/owner-accounts.ts';
import type { Row } from '../../../src/memory/db/types.ts';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const PLACE = 'place:room-1';
const PAGE = 'https://gifs.example/view/cat-123';
const MEDIA = 'https://media.gifs.example/cat-123.mp4';
const ATTACHED = 'https://cdn.chat.example/attachments/1/a1/wave.gif';
const BYTES = new Uint8Array([71, 73, 70, 56, 57, 97, 4, 5]);

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function rig() {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  const asked: Array<string> = [];
  const fetchBytes = (url: string): Promise<GifBytes> => {
    asked.push(url);
    return Promise.resolve({ bytes: BYTES, contentType: 'image/gif' });
  };
  const prefill = createMediaPrefill({
    hot: { config: {}, prompts: {} },
    describer: null,
    lookup: null,
    now: () => NOW,
    store,
    dataDir: dir,
    fetchBytes,
  } as unknown as Parameters<typeof createMediaPrefill>[0]);
  return { dir, store, asked, prefill };
}

const line = (fields: object) => ({
  id: 'm1',
  placeId: PLACE,
  ts: NOW,
  authorId: 'u1',
  attachments: [],
  links: [],
  ...fields,
});

/** The message as the handler sees it: the prefill starts first, and the memory updater counts the GIF in the same tick. */
function sighted(r: ReturnType<typeof rig>, message: ReturnType<typeof line>) {
  void r.prefill.warmMediaCache(PLACE, message);
  r.store.recordGifs(PLACE, [message]);
}

test('a message with a GIF embed downloads its file once from the animation address, never the page link', async () => {
  const r = rig();
  const embed = {
    id: 'm1#e0',
    kind: 'gif',
    site: 'Gifs',
    title: '',
    text: '',
    url: PAGE,
    thumbnailUrl: 'https://media.gifs.example/cat-123.png',
    animationUrl: MEDIA,
  };
  sighted(r, line({ links: [embed] }));
  await until(() => Object.values(r.store.getGifs().entries).some((entry) => entry.file));
  assert.deepEqual(r.asked, [MEDIA]);
  const [entry] = Object.values(r.store.getGifs().entries);
  assert.ok(entry.hash);
  assert.ok(entry.file && fs.existsSync(path.join(r.dir, entry.file)));
});

test("a message with an attached GIF downloads its file from the attachment's own address", async () => {
  const r = rig();
  const attachment = { id: 'a1', kind: 'gif', name: 'wave.gif', url: ATTACHED, contentType: 'image/gif' };
  sighted(r, line({ attachments: [attachment] }));
  await until(() => Object.values(r.store.getGifs().entries).some((entry) => entry.file));
  assert.deepEqual(r.asked, [ATTACHED]);
  const [entry] = Object.values(r.store.getGifs().entries);
  assert.ok(entry.file);
  // An attachment's signed address is not stored.
  assert.equal(entry.fileUrl, undefined);
});

// ---------------------------------------------------------------------------
// features.mediaDescriptions: fire-and-forget describer pre-fetch from the
// message path (src/memory/describe.ts's cache), so the live memory analyzer
// (src/memory/update.ts#analyze) finds a caption already cached.

// features.videoDescriptions + media.video.prefill: a posted video is watched
// fire-and-forget, at most one per message.

function fakeVideoDescriber() {
  const base = fakeDescriber();
  const videoCalls: Array<Untyped> = [];
  return {
    ...base,
    videoCalls,
    describeVideos: async (placeId: string, items: Array<Record<string, Untyped>>) => {
      videoCalls.push({ placeId, items });
      return { videos: new Map(), newCount: 0 };
    },
  };
}

/** A discord.js attachments Map with `count` video entries. */
function videoAttachments(count = 1) {
  const entries = [];
  for (let i = 1; i <= count; i += 1) {
    entries.push([
      `v${i}`,
      {
        id: `v${i}`,
        contentType: 'video/mp4',
        name: `${i}.mp4`,
        url: `https://cdn.discordapp.com/x/${i}.mp4`,
        duration: 10,
      },
    ]);
  }
  return new Map(wrongly<Array<[string, Untyped]>>(entries));
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// features.webLookup + web.links.prefill: a posted link is read
// fire-and-forget, at most one per message, never a video-site or gif link.

function fakeLookup() {
  const readCalls: Array<Untyped> = [];
  return {
    readCalls,
    readLinks: async (placeId: string, links: Array<Record<string, Untyped>>, options: Record<string, Untyped>) => {
      readCalls.push({ placeId, links, options });
      return { reads: new Map(), newCount: 0 };
    },
  };
}

const LINK_EMBEDS = [
  { url: 'https://www.youtube.com/watch?v=abc', title: 'v', provider: { name: 'YouTube' } },
  { url: 'https://tenor.com/view/x', provider: { name: 'Tenor' } },
  { url: 'https://example.org/a', title: 'Crêpes' },
  { url: 'https://example.org/b', title: 'Galettes' },
];

function webConfig(overrides: Record<string, Untyped> = {}) {
  return baseConfig(
    deepMerge({ features: { webLookup: true }, web: { links: { enabled: true, prefill: true } } }, overrides)
  );
}

// ---------------------------------------------------------------------------
// The address classifier sees media captions the describer already cached:
// a sticker- or picture-only answer is not a bare `[sticker: name]`.

/** A describer fake with the cache-only accessor; `describeMany` (the prefill) waits on `gate` when given. */
function fakeCachingDescriber(cached = new Map(), { gate }: { gate?: Untyped } = {}) {
  const calls: Array<Untyped> = [];
  const cachedCalls: Array<Untyped> = [];
  return {
    calls,
    cachedCalls,
    describeMany: async (placeId: string, items: Array<Record<string, Untyped>>) => {
      calls.push({ placeId, items });
      if (gate) await gate;
      return { descriptions: new Map(), newCount: 0 };
    },
    cachedDescriptions: (placeId: string, items: Array<Record<string, Untyped>>) => {
      cachedCalls.push({ placeId, items });
      return new Map(
        items.filter((item) => cached.has(item.itemId)).map((item) => [item.itemId, cached.get(item.itemId)])
      );
    },
  };
}

function stickerOnlyMessage({ guild, channel, id = 'm-sticker' }: Record<string, Untyped>) {
  return fakeMessage({
    id,
    guild,
    channel,
    placeId: channel.id,
    cleanContent: '',
    stickers: new Map([['s1', { id: 's1', name: 's7', format: 1 }]]),
  });
}

// An emoji's and a sticker's description stands in the legend, the line holds the stable name.
// The candidate's sticker `s7` (platform name `pingo`) is named by the store, and its caption stands in the legend.
const PINGO: MediaName = {
  name: 's7',
  kind: 'sticker',
  iface: 'discord',
  nativeId: 's1',
  platformName: 'pingo',
  animated: false,
};
const namingStore = () => ({
  ...fakeStore(),
  mediaNameOf: (name: string): MediaName | null => (name === 's7' ? PINGO : null),
});
const legendPrompts = (): Record<string, Untyped> => ({
  ...fakeAddressPrompts(),
  labels: {
    ...labels,
    legend: {
      line: '{name} [{platformName}] {text}',
      lineNoText: '{name} [{platformName}] undescribed',
      unreadable: '{name} unseen',
    },
  },
});
describe('events of the pipeline', () => {
  let stopOwners: Array<() => void> = [];
  before(() => {
    useIface('fake');
    useSelf('self1');
    stopOwners = [ownedBy(['owner1'])];
  });
  after(() => {
    useIface('discord');
    useSelf('self-id');
    for (const stop of stopOwners) stop();
  });

  test('events: a posted video is watched ahead, fire-and-forget', async () => {
    const describer = fakeVideoDescriber();
    const handler = makeHandler({ describer });

    await handler(fakeMessage({ cleanContent: 'look', attachments: videoAttachments(1) }));

    assert.equal(describer.videoCalls.length, 1);
    const firstVideoCall = describer.videoCalls[0];
    assert.equal(firstVideoCall.placeId, 'g1');
    assert.deepEqual(
      firstVideoCall.items.map((item: Record<string, Untyped>) => item.itemId),
      ['v1']
    );
  });

  test('events: a typed video-site link is prefilled too (normalizeMessage got media.video.sites)', async () => {
    const describer = fakeVideoDescriber();
    const config = baseConfig({
      features: { videoDescriptions: true },
      media: { video: { prefill: true, sites: ['youtube.com'] } },
    });
    const handler = makeHandler({ config, describer });

    await handler(fakeMessage({ cleanContent: 'regarde https://www.youtube.com/watch?v=abc' }));

    assert.equal(describer.videoCalls.length, 1);
    const firstVideoCall = describer.videoCalls[0];
    const firstItem = firstVideoCall.items[0];
    assert.equal(firstItem.source, 'link');
  });

  test("events: features.mediaDescriptions on fires a fire-and-forget describer call for an observed human message's pictures", async () => {
    const describer = fakeDescriber();
    const config = baseConfig({ features: { mediaDescriptions: true } });
    const handler = makeHandler({ config, describer });

    const message = fakeMessage({ cleanContent: 'look at this', attachments: pictureAttachments(1) });
    await handler(message);

    assert.equal(describer.calls.length, 1);
    const firstCall = describer.calls[0];
    const firstItem = firstCall.items[0];
    assert.equal(firstItem.itemId, 'a1');
  });

  test('events: at most five pictures per message are handed to the describer', async () => {
    // PR 7d: media.prefillPerMessage is the constant 5.
    const describer = fakeDescriber();
    const handler = makeHandler({ describer });
    await handler(fakeMessage({ cleanContent: 'lots of pics', attachments: pictureAttachments(6) }));
    const firstCall = describer.calls[0];
    assert.deepEqual(
      firstCall.items.map((item: Record<string, Untyped>) => item.itemId),
      ['a1', 'a2', 'a3', 'a4', 'a5']
    );
  });

  test('events: at most five videos per message are watched ahead', async () => {
    // PR 7d: media.video.prefillPerMessage is the constant 5.
    const describer = fakeVideoDescriber();
    const handler = makeHandler({ describer });
    await handler(fakeMessage({ cleanContent: 'look', attachments: videoAttachments(6) }));
    const firstVideoCall = describer.videoCalls[0];
    assert.deepEqual(
      firstVideoCall.items.map((item: Record<string, Untyped>) => item.itemId),
      ['v1', 'v2', 'v3', 'v4', 'v5']
    );
  });

  test('events: a picture-format sticker warms the describer cache too', async () => {
    const describer = fakeDescriber();
    const config = baseConfig({ features: { mediaDescriptions: true } });
    const handler = makeHandler({ config, describer });

    const message = fakeMessage({ stickers: new Map([['s1', { id: 's1', name: 'pepe', format: 1 }]]) });
    await handler(message);

    assert.equal(describer.calls.length, 1);
    const firstCall = describer.calls[0];
    const firstItem = firstCall.items[0];
    assert.equal(firstItem.itemId, 'sticker:s1');
  });

  test('events: a custom emoji in the text warms the describer cache too', async () => {
    const describer = fakeDescriber();
    const config = baseConfig({ features: { mediaDescriptions: true } });
    const handler = makeHandler({ config, describer });

    const message = fakeMessage({ cleanContent: 'nice <:pog:111>' });
    await handler(message);

    assert.equal(describer.calls.length, 1);
    const firstCall = describer.calls[0];
    const firstItem = firstCall.items[0];
    assert.equal(firstItem.itemId, 'emoji:111');
  });

  test("events: pictures come before a message's emoji within the shared 5-per-message cap", async () => {
    // PR 7d: media.prefillPerMessage is the constant 5.
    const describer = fakeDescriber();
    const handler = makeHandler({ describer });

    const message = fakeMessage({
      cleanContent: 'look <:pog:111>',
      attachments: pictureAttachments(4),
      stickers: new Map([['s1', { id: 's1', name: 'pepe', format: 1 }]]),
    });
    await handler(message);

    assert.equal(describer.calls.length, 1);
    const firstCall = describer.calls[0];
    assert.deepEqual(
      firstCall.items.map((i: Record<string, Untyped>) => i.itemId),
      ['a1', 'a2', 'a3', 'a4', 'sticker:s1'],
      'the attachments and the sticker (all pictures) fill the cap before the emoji is ever considered'
    );
  });

  test("events: the persona's own message never triggers a describer call", async () => {
    const describer = fakeDescriber();
    const config = baseConfig({ features: { mediaDescriptions: true } });
    const handler = makeHandler({ config, describer });

    const message = fakeMessage({
      author: { id: 'self1', bot: true, globalName: 'Neptunia', username: 'neptunia' },
      attachments: pictureAttachments(1),
    });
    await handler(message);

    assert.equal(describer.calls.length, 0);
  });

  test('events: web.links.prefill on reads the first readable link of a message, fire-and-forget', async () => {
    const lookup = fakeLookup();
    const handler = makeHandler({ config: webConfig(), lookup });

    await handler(fakeMessage({ id: 'm1', cleanContent: 'κοίτα', embeds: LINK_EMBEDS }));

    assert.equal(lookup.readCalls.length, 1);
    const firstReadCall = lookup.readCalls[0];
    assert.equal(firstReadCall.placeId, 'g1');
    assert.deepEqual(
      firstReadCall.links.map((link: Record<string, Untyped>) => link.url),
      ['https://example.org/a'],
      'the video-site and gif embeds are skipped, one link only'
    );
  });

  test('events: a message with no readable link never calls readLinks; a lookup failure is swallowed', async () => {
    const lookup = fakeLookup();
    await makeHandler({ config: webConfig(), lookup })(fakeMessage({ id: 'm1', cleanContent: 'just words' }));
    assert.equal(lookup.readCalls.length, 0);

    const failing = {
      readLinks: async () => {
        throw new Error('boom');
      },
    };
    await makeHandler({ config: webConfig(), lookup: failing })(
      fakeMessage({ id: 'm2', cleanContent: 'κοίτα', embeds: LINK_EMBEDS })
    );
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe('events of the pipeline', () => {
  let stopOwners: Array<() => void> = [];
  before(() => {
    useIface('fake');
    useSelf('self1');
    stopOwners = [ownedBy(['owner1'])];
  });
  after(() => {
    useIface('discord');
    useSelf('self-id');
    for (const stop of stopOwners) stop();
  });

  test("follow-up: the classifier waits for the candidate's own picture prefill, with no second describe request", async () => {
    const llm = fakeFollowUpLlm();
    let release: ((value?: unknown) => void) | undefined;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const cached = new Map();
    const describer = fakeCachingDescriber(cached, { gate });
    const config = baseConfig({ features: { mediaDescriptions: true } });
    const handler = makeHandler({ config, llm, describer, prompts: legendPrompts(), store: namingStore() });
    const guild = fakeGuild();
    const channel = fakeChannelWithHistory('c1', guild, []);
    await openFollowUpWindow(handler, { guild, channel, ts: Date.now() });

    const p = handler(stickerOnlyMessage({ guild, channel }));
    await tick();
    assert.equal(describer.calls.length, 1, 'the prefill started');
    assert.equal(llm.calls.length, 0, 'the classifier is not asked while the prefill is in flight');

    cached.set('sticker:s1', 'a penguin waving hello');
    present(release)();
    await tick();

    assert.equal(describer.calls.length, 1, 'the prefill is awaited, never repeated');
    assert.equal(llm.calls.length, 1);
    const firstCall = llm.calls[0];
    const secondMessage = firstCall.messages[1];
    assert.ok(String(secondMessage.content).includes('s7 [pingo] a penguin waving hello'));

    llm.respond('no');
    await p;
  });
});

// Stage P and the standard of stage U: a voice message and an audio file reach the describer (src/memory/describe.ts) on the
// existing `video` role through `describe/audio`, from the prefill (src/pipeline/media-prefill.ts); a failure leaves the item
// undescribed with its cause, and a refused file is not retried forever. A text file keeps its preview with no model. A stored
// text form is English with speech and on-screen text quoted in their language: one that is mostly another script is described
// again once, then kept and marked. A fake model and fake fetchers; no provider is added.

const MEDIA_MEMORY_AUDIO_NOW = Date.parse('2026-11-05T12:00:00.000Z');

test('the prefill hands an observed voice message and audio file to the describer, as it does a picture', async () => {
  const asked: Array<Row> = [];
  const prefill = createMediaPrefill({
    hot: { config: {}, prompts: {} },
    describer: {
      describeMany: (_place: string, items: Array<unknown>) => {
        asked.push(...(items as Array<Row>));
        return Promise.resolve();
      },
    },
    lookup: null,
    now: () => MEDIA_MEMORY_AUDIO_NOW,
  } as unknown as Parameters<typeof createMediaPrefill>[0]);
  await prefill.warmMediaCache('g1', {
    id: 'm1',
    authorId: 'u1',
    attachments: [
      { id: 'v1', kind: 'voice', url: 'https://x.invalid/v.ogg', name: 'v.ogg' },
      { id: 'a1', kind: 'audio', url: 'https://x.invalid/a.mp3', name: 'a.mp3' },
      { id: 'p1', kind: 'image', url: 'https://x.invalid/p.png', name: 'p.png' },
    ],
  } as Parameters<ReturnType<typeof createMediaPrefill>['warmMediaCache']>[1]);
  assert.deepEqual(asked.map((item) => item.itemId).sort(), ['a1', 'p1', 'v1']);
});
