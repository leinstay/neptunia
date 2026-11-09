// Tests for media.find (src/tools/tools.ts#findGifs, #runMediaFind): the persona's search of her GIF
// library by the stored descriptions, ranked by words, returning the library's own handles.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findGif, normalizeGifs } from '../src/memory/gifs.ts';
import { gifLine } from '../src/behavior/prompt.ts';
import { createFindMeaning } from '../src/memory/db/graph-find.ts';
import { findGifs, mediaFind, mediaFindText, runMediaFind } from '../src/tools/tools.ts';
import type { Untyped } from '../src/tools/types.ts';
import { present } from './fixtures/loose-types.ts';

type GifEntryLine = Parameters<typeof gifLine>[0];

const labels = {
  gifs: { entry: '{id}: {text}', entryNoText: '{id}', entryFields: '{id}: {reaction} / {action} / {text}' },
  tools: { tools: { find: { source: 'Source: media.find "{query}", {count} found.', none: 'Nothing matched.' } } },
};

/** A library of entries g1.. with these descriptions (cache fields), the first used most. */
function fixture(descriptions: Record<string, Untyped>) {
  const entries: Record<string, Untyped> = {};
  const cache: Record<string, Untyped> = {};
  descriptions.forEach((fields: Record<string, Untyped>, index: Untyped) => {
    const key = `k${index + 1}`;
    entries[key] = {
      id: `g${index + 1}`,
      kind: 'link',
      url: `https://tenor.example/${key}`,
      itemId: key,
      messageId: 'm',
      placeId: 'c',
      count: 10 - index,
      last: 1000,
    };
    cache[key] = typeof fields === 'string' ? { text: fields } : { text: fields.action ?? '', ...fields };
  });
  return { gifs: normalizeGifs({ nextId: descriptions.length + 1, entries }), cache };
}

const LIBRARY = [
  { reaction: 'γάτα που χορεύει', action: 'a cat dances on a table', screen: '' },
  { reaction: 'Élodie rit', action: 'a woman laughs out loud', screen: 'haha' },
  { reaction: 'κλάμα', action: 'crying rain window', screen: '' },
  'a dog runs in the park',
];

function storeOf({ gifs, cache }: Record<string, Untyped>) {
  return {
    getGifs: () => gifs,
    getMediaCache: () => cache,
    findGif: (handle: string) => findGif(gifs, handle),
  };
}

test('findGifs ranks by words in either language, accents and case ignored, ties by the library order', () => {
  const lib = fixture(LIBRARY);
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, 'CAT dances').map((e) => e.id),
    ['g1']
  );
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, 'γατα').map((e) => e.id),
    ['g1'],
    'a Greek word without its accent'
  );
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, 'elodie').map((e) => e.id),
    ['g2'],
    'accented Latin folded'
  );
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, 'laughs haha').map((e) => e.id),
    ['g2']
  );
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, 'dog dances').map((e) => e.id),
    ['g1', 'g4'],
    'equal scores keep the library order'
  );
  // a reaction word counts double, a near form (shared stem) less than an exact one
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, 'cry').map((e) => e.id),
    [],
    'under the stem length nothing partial'
  );
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, 'crying').map((e) => e.id),
    ['g3']
  );
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, 'dance').map((e) => e.id),
    ['g1'],
    'a shared stem of a form counts, less than the exact word'
  );
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, 'dance laughs').map((e) => e.id),
    ['g2', 'g1'],
    'an exact word outranks a stem match'
  );
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, 'dancing laughs').map((e) => e.id),
    ['g2'],
    'dancing and dances share no stem here'
  );
});

test('findGifs: an entry without a stored description is never returned, nothing matching gives none', () => {
  const lib = fixture(LIBRARY);
  delete lib.cache.k4;
  lib.cache.k3 = { miss: true };
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, 'dog park crying').map((e) => e.id),
    []
  );
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, 'zzz').map((e) => e.id),
    []
  );
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, '   ').map((e) => e.id),
    []
  );
});

test('findGifs: n defaults to 5, is capped at 10 and floored at 1', () => {
  const lib = fixture(Array.from({ length: 14 }, (_, i) => `a cat number ${i}`));
  assert.equal(findGifs(lib.gifs, lib.cache, 'cat').length, 5);
  assert.equal(findGifs(lib.gifs, lib.cache, 'cat', { n: 3 }).length, 3);
  assert.equal(findGifs(lib.gifs, lib.cache, 'cat', { n: 99 }).length, 10);
  assert.equal(findGifs(lib.gifs, lib.cache, 'cat', { n: 0 }).length, 5);
});

test('runMediaFind: handles in the result are the library handles message.create gif= and <gif> resolve, written as a library line', () => {
  const lib = fixture(LIBRARY);
  const store = storeOf(lib);
  const result = runMediaFind({ store, config: {}, labels, placeId: 'G', args: { query: 'cat laughs' } });
  assert.equal(result.status, 'ok');
  const lines = present(result.data).text.split('\n');
  assert.equal(lines[0], 'Source: media.find "cat laughs", 2 found.');
  const handles = lines.slice(1).map((line) => line.split(':')[0]);
  assert.equal(handles.length, 2);
  for (const handle of handles) assert.ok(store.findGif(handle), `${handle} resolves in the library`);
  // B7: the `<gifs>` block left the turn; the line of an entry is gifLine's, which media.find keeps writing.
  const block = Object.values<Untyped>(lib.gifs.entries).map((entry) =>
    gifLine(entry as GifEntryLine, lib.cache, labels, { now: 0, ownMarkHours: 0, reactionChars: 40, actionChars: 70 })
  );
  for (const line of lines.slice(1)) assert.ok(block.includes(line), 'the same line the entry always had');
});

test('runMediaFind: nothing found is an ok with the none label; bad arguments and no library are refused', () => {
  const store = storeOf(fixture(LIBRARY));
  const none = runMediaFind({ store, config: {}, labels, placeId: 'G', args: { query: 'submarine' } });
  assert.deepEqual(
    [none.status, present(none.data).text],
    ['ok', 'Source: media.find "submarine", 0 found.\nNothing matched.']
  );
  const bare = runMediaFind({ store, config: {}, labels: {}, placeId: 'G', args: { query: 'submarine' } });
  assert.deepEqual([bare.status, present(bare.data).text], ['ok', '']);
  assert.equal(runMediaFind({ store, config: {}, labels, placeId: 'G', args: {} }).code, 'invalid-args');
  assert.equal(runMediaFind({ store, config: {}, labels, placeId: 'G', args: { query: '!!' } }).status, 'invalid');
  assert.equal(
    runMediaFind({ store, config: {}, labels, placeId: 'G', args: { query: 'cat', n: 11 } }).reason,
    'args.n:range'
  );
  assert.equal(
    runMediaFind({ store, config: {}, labels, placeId: 'G', args: { query: 'cat', n: 0 } }).reason,
    'args.n:range'
  );
  assert.equal(
    runMediaFind({ store: null, config: {}, labels, placeId: 'G', args: { query: 'cat' } }).status,
    'not_configured'
  );
  assert.equal(
    present(runMediaFind({ store, config: {}, labels, placeId: 'G', args: { query: 'cat', n: 1 } }).data).text.split(
      '\n'
    ).length,
    2,
    'n=1 gives one GIF'
  );
  assert.equal(mediaFindText([], { query: 'x', labels }), 'Source: media.find "x", 0 found.\nNothing matched.');
});

test('media.find finds a GIF by the vector of its description when its words find no full match', async () => {
  // Bug: media.find reads words only, so a query in another language than the descriptions finds nothing.
  const lib = fixture(LIBRARY);
  const vectors = new Map([
    ['k3', [1, 0, 0]],
    ['k1', [0, 1, 0]],
  ]);
  let asked = 0;
  const store = { ...storeOf(lib), getGifVectors: () => vectors };
  const findMeaning = createFindMeaning({
    embed: () => {
      asked += 1;
      return Promise.resolve([1, 0, 0]);
    },
    model: 'test/embedder',
    deadlineMs: 1000,
    memo: new Map(),
  });
  const args = { query: 'λύπη' };
  assert.equal(runMediaFind({ store, config: {}, labels, placeId: 'G', args }).data?.text?.includes('0 found'), true);
  const result = await mediaFind({ store, config: {}, labels, placeId: 'G', args, findMeaning });
  const handles = present(result.data)
    .text.split('\n')
    .slice(1)
    .map((line) => line.split(':')[0]);
  assert.deepEqual(handles, ['g3']);
  const words = await mediaFind({ store, config: {}, labels, placeId: 'G', args: { query: 'cat' }, findMeaning });
  assert.equal(present(words.data).text.split('\n').length, 2, 'the cat is found by its words');
  assert.equal(asked, 1, 'a query whose words find a full match sends no embedding');
});
