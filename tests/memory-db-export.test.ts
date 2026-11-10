// A paid description outlives the cache's cap and a reopen: it lives on its item's row of `media` (src/memory/store-media.ts),
// which the cap retires and the describer takes up again, and a failed refresh keeps the success and its cooldown.
import { placeOfRoot } from '../src/memory/addresses.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDescriber } from '../src/memory/describe.ts';
import { createStore } from '../src/memory/store.ts';
import { MEDIA_CACHE_ENTRIES } from '../src/memory/db/media-store.ts';
import { hashedKey } from '../src/web/cache.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { fakeImageFetcher, fakeLlm, fakeVideoFetcher } from './fixtures/describe-fakes.ts';
import { chainsOf } from './fixtures/chains.ts';

const HOUR = 3_600_000;
const T = Date.parse('2026-11-03T12:00:00Z');
const picture = (itemId: string) => ({ itemId, kind: 'image', url: 'https://media.test/picture.png' });
const video = { itemId: 'v1', kind: 'video', source: 'attachment', url: 'https://media.test/clip.mp4', bytes: 1000 };
const textOf = (value: unknown): unknown => Reflect.get(Object(value), 'text');

async function fixture(responses: Parameters<typeof fakeLlm>[0]) {
  const clock = { at: T };
  const hot = {
    config: {
      models: { routes: chainsOf({ vision: 'fake/vision', video: 'fake/video' }) },
      media: { maxOutputTokens: 120, recacheBefore: null as string | null, video: { errorRetryMinutes: 60 } },
    },
    prompts: { describe: 'Describe.', 'describe-video': 'Summarize.', 'rewatch-answer': 'Answer {{question}}.' },
  };
  let memory = await openTestMemory({ now: () => clock.at, iface: () => 'synthetic' });
  let store = createStore({ dataDir: memory.dataDir, memoryDb: memory.memoryDb });
  const llm = fakeLlm(responses);
  const imageFetcher = fakeImageFetcher();
  const videoFetcher = fakeVideoFetcher();
  const describer = () => createDescriber({ hot, store, llm, imageFetcher, videoFetcher, now: () => clock.at });
  return {
    clock,
    hot,
    llm,
    imageFetcher,
    videoFetcher,
    describer,
    get store() {
      return store;
    },
    async reopen() {
      await store.flushSettled();
      const dataDir = memory.dataDir;
      await memory.close();
      memory = await openTestMemory({ dataDir, now: () => clock.at, iface: () => 'synthetic' });
      store = createStore({ dataDir, memoryDb: memory.memoryDb });
    },
    close: () => memory.close(),
  };
}

// Losing an active cache entry must not lose a description that already cost a model request.
test('an evicted description survives database reopen without another download or model request', async () => {
  const run = await fixture([{ text: 'a grey cat' }, { text: 'a red boat' }]);
  try {
    assert.equal(textOf(await run.describer().describe(placeOfRoot(run.store, 'g1'), picture('a1'))), 'a grey cat');
    const place = placeOfRoot(run.store, 'g1');
    for (let n = 1; n < MEDIA_CACHE_ENTRIES; n += 1)
      run.store.putMediaEntry(place, `web:${n}`, { text: 'ordinary cached page', ts: 1 });
    run.clock.at += 1000;
    await run.describer().describe(place, picture('a2'));
    await run.store.flushSettled();
    const cache = run.store.mediaEntries(place);
    assert.deepEqual([Object.keys(cache).length, Object.hasOwn(cache, 'a1')], [MEDIA_CACHE_ENTRIES, false]);
    await run.reopen();
    assert.equal(run.store.mediaEntry(placeOfRoot(run.store, 'g1'), 'a1'), undefined);
    assert.equal(textOf(await run.describer().describe(placeOfRoot(run.store, 'g1'), picture('a1'))), 'a grey cat');
    assert.equal(run.llm.calls.length, 2);
    assert.equal(run.imageFetcher.calls.length, 2);
    await run.store.flushSettled();
    assert.equal(Object.keys(run.store.mediaEntries(placeOfRoot(run.store, 'g1'))).length, MEDIA_CACHE_ENTRIES);
  } finally {
    await run.close();
  }
});

// Refreshing one question must not overwrite the video's independent summary.
test('an explicit video rewatch keeps its latest answer and the base summary across reopen', async () => {
  const run = await fixture([{ text: 'someone dances' }, { text: 'rouge' }, { text: 'bleu' }]);
  const question = 'Quelle couleur ?';
  const key = hashedKey('video:v1:q', 'quelle couleur ?');
  try {
    assert.equal(textOf(await run.describer().describeVideo(placeOfRoot(run.store, 'g1'), video)), 'someone dances');
    assert.equal(textOf(await run.describer().rewatchVideo(placeOfRoot(run.store, 'g1'), video, question)), 'rouge');
    run.clock.at += 59 * 60_000;
    assert.equal(
      textOf(await run.describer().rewatchVideo(placeOfRoot(run.store, 'g1'), video, '  quelle   COULEUR ? ')),
      'rouge'
    );
    assert.equal(run.llm.calls.length, 2, 'the existing question TTL still makes this answer free');
    run.clock.at += 2 * 60_000;
    assert.equal(textOf(await run.describer().rewatchVideo(placeOfRoot(run.store, 'g1'), video, question)), 'bleu');
    assert.equal(run.llm.calls.length, 3, 'an explicit rewatch after the TTL asks again');
    assert.equal(run.videoFetcher.calls.length, 3);
    await run.reopen();
    const summary = run.store.getMediaDescription(placeOfRoot(run.store, 'g1'), 'video:v1');
    assert.deepEqual([summary?.text, summary?.describedAt, summary?.model], ['someone dances', T, 'fake/video']);
    assert.equal(run.store.getMediaDescription(placeOfRoot(run.store, 'g1'), key)?.answer, 'bleu');
    assert.equal(textOf(await run.describer().describeVideo(placeOfRoot(run.store, 'g1'), video)), 'someone dances');
    assert.equal(run.llm.calls.length, 3, 'a base-summary lookup is independent of question refreshes');
  } finally {
    await run.close();
  }
});

// A failed refresh must retain the paid caption and its retry deadline through a process restart.
test('failed stale refresh retains its success and cooldown across reopen before a later successful retry', async () => {
  const run = await fixture([
    { text: 'an old caption' },
    new Error('synthetic model failure'),
    { text: 'a fresh caption' },
  ]);
  try {
    assert.equal(textOf(await run.describer().describe(placeOfRoot(run.store, 'g1'), picture('a1'))), 'an old caption');
    run.hot.config.media.recacheBefore = new Date(T + 1).toISOString();
    run.clock.at += 2 * HOUR;
    const failedAt = run.clock.at;
    assert.equal(textOf(await run.describer().describe(placeOfRoot(run.store, 'g1'), picture('a1'))), 'an old caption');
    await run.reopen();
    const retained = run.store.getMediaDescription(placeOfRoot(run.store, 'g1'), 'a1');
    assert.deepEqual(
      [retained?.text, retained?.describedAt, retained?.model, retained?.refreshFailedAt],
      ['an old caption', T, 'fake/vision', failedAt]
    );
    run.clock.at += 30 * 60_000;
    assert.equal(textOf(await run.describer().describe(placeOfRoot(run.store, 'g1'), picture('a1'))), 'an old caption');
    assert.equal(run.llm.calls.length, 2, 'the persisted failure stamp still suppresses retry within the hour');
    run.clock.at += 31 * 60_000;
    assert.equal(
      textOf(await run.describer().describe(placeOfRoot(run.store, 'g1'), picture('a1'))),
      'a fresh caption'
    );
    assert.equal(run.llm.calls.length, 3);
    await run.reopen();
    const fresh = run.store.getMediaDescription(placeOfRoot(run.store, 'g1'), 'a1');
    assert.deepEqual(
      [fresh?.text, fresh?.describedAt, fresh?.model],
      ['a fresh caption', failedAt + 61 * 60_000, 'fake/vision']
    );
  } finally {
    await run.close();
  }
});
