// Tests for media.find (src/skills/tools.js#findGifs, #runMediaFind): the persona's search of her GIF
// library by the stored descriptions, ranked by words, returning the library's own handles.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findGif, normalizeGifs } from '../src/memory/gifs.js';
import { renderGifLibrary } from '../src/behavior/gif-pick.js';
import { findGifs, mediaFindText, runMediaFind } from '../src/skills/tools.js';

const labels = {
  gifs: { entry: '{id}: {text}', entryNoText: '{id}', entryFields: '{id}: {reaction} / {action} / {text}' },
  skills: { tools: { find: { source: 'Source: media.find "{query}", {count} found.', none: 'Nothing matched.' } } },
};

/** A library of entries g1.. with these descriptions (cache fields), the first used most. */
function fixture(descriptions) {
  const entries = {};
  const cache = {};
  descriptions.forEach((fields, index) => {
    const key = `k${index + 1}`;
    entries[key] = { id: `g${index + 1}`, kind: 'link', url: `https://tenor.example/${key}`, itemId: key, messageId: 'm', channelId: 'c', count: 10 - index, last: 1000 };
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

function storeOf({ gifs, cache }) {
  return { getGifs: () => gifs, getMediaCache: () => cache, findGif: (_guild, handle) => findGif(gifs, handle) };
}

test('findGifs ranks by words in either language, accents and case ignored, ties by the library order', () => {
  const lib = fixture(LIBRARY);
  assert.deepEqual(findGifs(lib.gifs, lib.cache, 'CAT dances').map((e) => e.id), ['g1']);
  assert.deepEqual(findGifs(lib.gifs, lib.cache, 'γατα').map((e) => e.id), ['g1'], 'a Greek word without its accent');
  assert.deepEqual(findGifs(lib.gifs, lib.cache, 'elodie').map((e) => e.id), ['g2'], 'accented Latin folded');
  assert.deepEqual(findGifs(lib.gifs, lib.cache, 'laughs haha').map((e) => e.id), ['g2']);
  assert.deepEqual(findGifs(lib.gifs, lib.cache, 'dog dances').map((e) => e.id), ['g1', 'g4'], 'equal scores keep the library order');
  // a reaction word counts double, a near form (shared stem) less than an exact one
  assert.deepEqual(findGifs(lib.gifs, lib.cache, 'cry').map((e) => e.id), [], 'under the stem length nothing partial');
  assert.deepEqual(findGifs(lib.gifs, lib.cache, 'crying').map((e) => e.id), ['g3']);
  assert.deepEqual(findGifs(lib.gifs, lib.cache, 'dance').map((e) => e.id), ['g1'], 'a shared stem of a form counts, less than the exact word');
  assert.deepEqual(findGifs(lib.gifs, lib.cache, 'dance laughs').map((e) => e.id), ['g2', 'g1'], 'an exact word outranks a stem match');
  assert.deepEqual(findGifs(lib.gifs, lib.cache, 'dancing laughs').map((e) => e.id), ['g2'], 'dancing and dances share no stem here');
});

test('findGifs: an entry without a stored description is never returned, nothing matching gives none', () => {
  const lib = fixture(LIBRARY);
  delete lib.cache.k4;
  lib.cache.k3 = { miss: true };
  assert.deepEqual(findGifs(lib.gifs, lib.cache, 'dog park crying').map((e) => e.id), []);
  assert.deepEqual(findGifs(lib.gifs, lib.cache, 'zzz').map((e) => e.id), []);
  assert.deepEqual(findGifs(lib.gifs, lib.cache, '   ').map((e) => e.id), []);
});

test('findGifs: n defaults to 5, is capped at 10 and floored at 1', () => {
  const lib = fixture(Array.from({ length: 14 }, (_, i) => `a cat number ${i}`));
  assert.equal(findGifs(lib.gifs, lib.cache, 'cat').length, 5);
  assert.equal(findGifs(lib.gifs, lib.cache, 'cat', { n: 3 }).length, 3);
  assert.equal(findGifs(lib.gifs, lib.cache, 'cat', { n: 99 }).length, 10);
  assert.equal(findGifs(lib.gifs, lib.cache, 'cat', { n: 0 }).length, 5);
});

test('runMediaFind: handles in the result are the library handles message.create gif= and <gif> resolve, written as the <gifs> block writes them', () => {
  const lib = fixture(LIBRARY);
  const store = storeOf(lib);
  const result = runMediaFind({ store, config: {}, labels, guildId: 'G', args: { query: 'cat laughs' } });
  assert.equal(result.status, 'ok');
  const lines = result.data.text.split('\n');
  assert.equal(lines[0], 'Source: media.find "cat laughs", 2 found.');
  const handles = lines.slice(1).map((line) => line.split(':')[0]);
  assert.equal(handles.length, 2);
  for (const handle of handles) assert.ok(store.findGif('G', handle), `${handle} resolves in the library`);
  const block = renderGifLibrary(lib.gifs && Object.values(lib.gifs.entries), lib.cache, labels, { now: 0, ownMarkHours: 0, reactionChars: 40, actionChars: 70 });
  for (const line of lines.slice(1)) assert.ok(block.includes(line), 'the same line the <gifs> block shows');
});

test('runMediaFind: nothing found is an ok with the none label; bad arguments and a switched-off library are refused', () => {
  const store = storeOf(fixture(LIBRARY));
  const none = runMediaFind({ store, config: {}, labels, guildId: 'G', args: { query: 'submarine' } });
  assert.deepEqual([none.status, none.data.text], ['ok', 'Source: media.find "submarine", 0 found.\nNothing matched.']);
  const bare = runMediaFind({ store, config: {}, labels: {}, guildId: 'G', args: { query: 'submarine' } });
  assert.deepEqual([bare.status, bare.data.text], ['ok', '']);
  assert.equal(runMediaFind({ store, config: {}, labels, guildId: 'G', args: {} }).code, 'invalid-args');
  assert.equal(runMediaFind({ store, config: {}, labels, guildId: 'G', args: { query: '!!' } }).status, 'invalid');
  assert.equal(runMediaFind({ store, config: {}, labels, guildId: 'G', args: { query: 'cat', n: 11 } }).reason, 'args.n:range');
  assert.equal(runMediaFind({ store, config: {}, labels, guildId: 'G', args: { query: 'cat', n: 0 } }).reason, 'args.n:range');
  assert.equal(runMediaFind({ store, config: { features: { gifs: false } }, labels, guildId: 'G', args: { query: 'cat' } }).status, 'not_configured');
  assert.equal(runMediaFind({ store: null, config: {}, labels, guildId: 'G', args: { query: 'cat' } }).status, 'not_configured');
  assert.equal(runMediaFind({ store, config: {}, labels, guildId: 'G', args: { query: 'cat', n: 1 } }).data.text.split('\n').length, 2, 'n=1 gives one GIF');
  assert.equal(mediaFindText([], { query: 'x', labels }), 'Source: media.find "x", 0 found.\nNothing matched.');
});
