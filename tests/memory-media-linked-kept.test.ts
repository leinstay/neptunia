// Media rows that a message or a diary entry links are never trimmed (master plan V.2): the cap of `MEDIA_CACHE_ENTRIES`
// applies only to unlinked cache rows. The real store, describer and memory database over a temporary data directory, a
// fake model. Synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OBSERVATION_VERSION } from '../src/memory/db/observe.ts';
import { createDescriber } from '../src/memory/describe.ts';
import { createStore } from '../src/memory/store.ts';
import { MEDIA_CACHE_ENTRIES } from '../src/web/cache.ts';
import { fakeImageFetcher, fakeLlm, fakeState, fakeVideoFetcher } from './fixtures/describe-fakes.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';

const NOW = Date.parse('2026-11-05T10:00:00.000Z');
const PLACE = 'discord:channel:room';
const HOT = {
  config: {
    models: { base: { vision: 'x/vision' } },
    media: { maxOutputTokens: 120 },
    context: { vision: { fetchTimeoutMs: 10_000 } },
  },
  prompts: { describe: 'Describe this picture.' },
};

/** A line of #room that holds the attachments `ids`. */
const lineWith = (ids: ReadonlyArray<string>) => ({
  v: OBSERVATION_VERSION,
  iface: 'discord',
  authority: 'discord/global',
  native: { kind: 'message', key: 'line-with-pictures', revision: 1 },
  place: { authority: 'discord/global', key: 'channel:room', kind: 'channel', conversation: 'group' },
  author: { kind: 'account', key: 'owner' },
  occurredAt: '2026-11-03T09:00:00.000Z',
  observedAt: '2026-11-03T09:00:01.000Z',
  text: 'a picture',
  mentions: [],
  direct: false,
  relations: [],
  // The store's shape: a line's media are items and links, never ids in its `extra`.
  media: ids.map((nativeRef) => ({
    kind: 'image',
    nativeRef,
    availability: 'unknown',
    description: null,
    origin: null,
    extra: {},
  })),
});

/** The media cache of #room full to its cap, oldest first, one new picture described over it, the rows as stored. */
async function trimmed(linkAttachments: ReadonlyArray<string>, selfreflectionAttachment: string | null = null) {
  const memory = await openTestMemory({ now: () => NOW });
  const file = path.join(memory.dataDir, 'memory.db');
  await memory.memoryDb.observe(lineWith(linkAttachments), null);
  if (selfreflectionAttachment !== null) {
    const db = new DatabaseSync(file);
    // A diary entry's file is an item with a link to the entry.
    db.prepare(
      `INSERT INTO media (id, kind, owner, native_ref, mime, scope_kind, scope_iface, audience_id)
       VALUES ('media:diary:1:0', 'image', 'selfreflection:1', ?, 'image/png', 'group', 'discord', 'aud:group:discord')`
    ).run(selfreflectionAttachment);
    db.prepare(
      "INSERT INTO media_links (owner_kind, owner_id, position, media_id) VALUES ('selfreflection', 'selfreflection:1', 0, 'media:diary:1:0')"
    ).run();
    db.close();
  }
  const store = createStore({ dataDir: memory.dataDir, memoryDb: memory.memoryDb });
  const cache = store.getMediaCache(PLACE) as Record<string, unknown>;
  for (let i = 0; i < MEDIA_CACHE_ENTRIES; i += 1) cache[`a${i}`] = { text: 'a picture', ts: NOW - 1000 };
  store.markMediaCacheDirty(PLACE);
  await store.flushSettled({ final: true });

  const describer = createDescriber({
    hot: HOT,
    store,
    llm: fakeLlm({ text: 'A new picture', usage: {}, estimated: 1 }),
    imageFetcher: fakeImageFetcher(),
    videoFetcher: fakeVideoFetcher(),
    state: fakeState(),
    now: () => NOW,
  });
  await describer.describe(PLACE, { itemId: 'new', kind: 'image', url: 'https://cdn.discordapp.com/x/new.png' });
  await store.flushSettled({ final: true });
  await memory.close();

  const db = new DatabaseSync(file, { readOnly: true });
  const live = (key: string): boolean =>
    db.prepare('SELECT 1 AS yes FROM media WHERE native_ref = ? AND retired_at IS NULL').get(key) !== undefined;
  return {
    live,
    close: () => db.close(),
  };
}

// Bug: the LRU cap retires the description of a picture a stored line still shows, the 1462 rows past the cap on
// production.
test('a cache row a line links stays when it is the oldest at the cap', async () => {
  const rows = await trimmed(['a0']);
  assert.equal(rows.live('a0'), true);
  assert.equal(rows.live('new'), true);
  rows.close();
});

// Bug: the fix stops all trimming and the cache grows with no bound.
test('the oldest row nothing links is still trimmed', async () => {
  const rows = await trimmed(['a0']);
  assert.equal(rows.live('a1'), false);
  rows.close();
});

// Bug: only lines are looked at, and a picture of her diary loses its description.
test('a cache row a diary entry links stays at the cap', async () => {
  const rows = await trimmed([], 'a0');
  assert.equal(rows.live('a0'), true);
  assert.equal(rows.live('a1'), false);
  rows.close();
});
