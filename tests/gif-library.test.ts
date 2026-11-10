// The one GIF library shared across places and interfaces (src/memory/gifs.ts): one entry per GIF, however many
// links, native ids and places it was seen under, its counters per place, the global rank over them, the per-place
// slice, and the search that hands the media pick its candidates. Plan 2026-11-04-cli-and-memory, stage B7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findGif,
  gifsOfPlace,
  markOwnGif,
  mergeGifs,
  normalizeGifs,
  rankGifs,
  resetGifCounts,
  searchGifs,
  withGifCaption,
  withGifFile,
} from '../src/memory/gifs.ts';

const A = 'place:room-1';
const B = 'place:room-2';
const T0 = Date.UTC(2026, 10, 1);
const HOUR = 3_600_000;
const TENOR = 'https://tenor.com/view/cat-dance-123';

/** A member's message in `placeId` carrying one GIF embed. */
function linkMessage(id: string, placeId: string, ts: number, url = TENOR, linkId = `${id}#e0`) {
  return {
    id,
    placeId,
    ts,
    attachments: [],
    links: [{ id: linkId, kind: 'gif', site: 'Tenor', title: '', text: '', url }],
  };
}

/** A member's message in `placeId` carrying one attached GIF. */
function attachedMessage(id: string, placeId: string, ts: number, attachmentId: string) {
  return {
    id,
    placeId,
    ts,
    links: [],
    attachments: [{ id: attachmentId, kind: 'gif', name: 'φάση.gif', url: `https://cdn.example/${attachmentId}.gif` }],
  };
}

const library = (messages: Array<ReturnType<typeof linkMessage> | ReturnType<typeof attachedMessage>>) =>
  mergeGifs(null, messages).gifs;

const only = (gifs: unknown) => {
  const entries = Object.values(normalizeGifs(gifs).entries);
  assert.equal(entries.length, 1, 'one entry');
  return entries[0];
};

test('a GIF seen in two places is one entry with a counter for each place', () => {
  const entry = only(
    library([linkMessage('m1', A, T0), linkMessage('m2', A, T0 + HOUR), linkMessage('m3', B, T0 + 2 * HOUR)])
  );
  assert.equal(entry.places[A].count, 2);
  assert.equal(entry.places[B].count, 1);
  assert.equal(entry.places[A].last, T0 + HOUR);
  assert.equal(entry.places[B].last, T0 + 2 * HOUR);
});

test('the entry keeps every native id it was seen under', () => {
  const entry = only(library([linkMessage('m1', A, T0), linkMessage('m2', B, T0 + HOUR, TENOR, 'second-embed')]));
  assert.deepEqual(entry.nativeIds, ['m1#e0', 'second-embed']);
  assert.deepEqual(entry.links, [TENOR]);
});

test('the file of a GIF keys its entry by content hash and joins an entry holding the same bytes', () => {
  const two = library([attachedMessage('m1', A, T0, 'att-1'), attachedMessage('m2', B, T0 + HOUR, 'att-2')]);
  const firstHandle = normalizeGifs(two).entries['att-1'].id;
  const joined = withGifFile(withGifFile(two, 'att-1', { hash: 'h1', file: 'media/gifs/h1.gif' }), 'att-2', {
    hash: 'h1',
    file: 'media/gifs/h1.gif',
  });
  const { entries } = normalizeGifs(joined);
  assert.deepEqual(Object.keys(entries), ['h1']);
  assert.equal(entries.h1.id, firstHandle, 'the older handle survives');
  assert.equal(entries.h1.file, 'media/gifs/h1.gif');
  assert.deepEqual(entries.h1.nativeIds, ['att-1', 'att-2']);
  assert.equal(entries.h1.places[A].count, 1);
  assert.equal(entries.h1.places[B].count, 1);
});

test('the same bytes under two links keep both links', () => {
  const other = 'https://giphy.com/gifs/cat-dance';
  const two = library([linkMessage('m1', A, T0), linkMessage('m2', B, T0, other)]);
  const joined = withGifFile(withGifFile(two, 'm1#e0', { hash: 'h1', file: 'f' }), 'm2#e0', { hash: 'h1', file: 'f' });
  assert.deepEqual(only(joined).links, [TENOR, other]);
});

test('a later sighting under a known native id counts on the hashed entry', () => {
  const hashed = withGifFile(library([attachedMessage('m1', A, T0, 'att-1')]), 'att-1', {
    hash: 'h1',
    file: 'media/gifs/h1.gif',
  });
  const entry = only(mergeGifs(hashed, [attachedMessage('m2', B, T0 + HOUR, 'att-1')]).gifs);
  assert.equal(entry.places[B].count, 1);
});

test('withGifFile on an unknown key leaves the library as it is', () => {
  const gifs = library([linkMessage('m1', A, T0)]);
  assert.deepEqual(normalizeGifs(withGifFile(gifs, 'nobody', { hash: 'h9', file: 'f' })), normalizeGifs(gifs));
});

test('the global rank is the sum over places', () => {
  const popularHere = 'https://tenor.com/view/here';
  const popularEverywhere = 'https://tenor.com/view/everywhere';
  const gifs = library([
    linkMessage('m1', A, T0, popularHere),
    linkMessage('m2', A, T0, popularHere),
    linkMessage('m3', A, T0, popularHere),
    linkMessage('m4', A, T0, popularEverywhere),
    linkMessage('m5', A, T0, popularEverywhere),
    linkMessage('m6', B, T0, popularEverywhere),
    linkMessage('m7', B, T0, popularEverywhere),
  ]);
  assert.deepEqual(
    rankGifs(gifs).map((entry) => entry.url),
    [popularEverywhere, popularHere]
  );
});

test('the slice of a place ranks by that place alone and leaves out what it never saw', () => {
  const here = 'https://tenor.com/view/here';
  const there = 'https://tenor.com/view/there';
  const elsewhere = 'https://tenor.com/view/elsewhere';
  const gifs = library([
    linkMessage('m1', A, T0, here),
    linkMessage('m2', A, T0, here),
    linkMessage('m3', A, T0, there),
    linkMessage('m4', B, T0, there),
    linkMessage('m5', B, T0, there),
    linkMessage('m6', B, T0, elsewhere),
  ]);
  assert.deepEqual(
    gifsOfPlace(gifs, A).map((entry) => [entry.url, entry.count]),
    [
      [here, 2],
      [there, 1],
    ]
  );
});

test('an own post is marked for the place it went to', () => {
  const gifs = library([linkMessage('m1', A, T0), linkMessage('m2', B, T0)]);
  const key = Object.keys(normalizeGifs(gifs).entries)[0];
  const { gifs: marked, marked: done } = markOwnGif(gifs, key, T0 + HOUR, B);
  assert.equal(done, true);
  const entry = only(marked);
  assert.equal(entry.places[B].ownLast, T0 + HOUR);
  assert.equal(entry.places[B].ownUses, 1);
  assert.equal(entry.places[A].ownLast, undefined);
});

test('a rescan of one place resets its counter and leaves the others', () => {
  // Bug: a place's rescan over a shared library would wipe the counts of every other place.
  const gifs = library([linkMessage('m1', A, T0), linkMessage('m2', B, T0), linkMessage('m3', B, T0)]);
  const handle = only(gifs).id;
  const entry = only(resetGifCounts(gifs, A));
  assert.equal(entry.places[A].count, 0);
  assert.equal(entry.places[B].count, 2);
  assert.equal(entry.count, 2, 'the global count follows');
  assert.equal(entry.id, handle);
});

test('a stored counter that is no number is dropped and the global count is taken from the rest', () => {
  const entry = only({
    nextId: 2,
    entries: {
      k1: {
        id: 'g1',
        kind: 'link',
        url: TENOR,
        count: 99,
        last: T0,
        places: { [A]: { count: 'πολλά', last: T0 }, [B]: { count: 2, last: T0 } },
      },
    },
  });
  assert.deepEqual(Object.keys(entry.places), [B]);
  assert.equal(entry.count, 2);
});

test('past storeMax the lowest global rank is evicted and its handle is never reused', () => {
  const kept = 'https://tenor.com/view/kept';
  const evicted = 'https://tenor.com/view/evicted';
  const gifs = library([
    linkMessage('m1', A, T0, kept),
    linkMessage('m2', B, T0, kept),
    linkMessage('m3', A, T0, evicted),
  ]);
  const evictedHandle = String(rankGifs(gifs).at(-1)?.id);
  const { gifs: cut } = mergeGifs(gifs, [linkMessage('m4', A, T0 + HOUR, 'https://tenor.com/view/new')], {
    storeMax: 2,
  });
  assert.equal(Object.keys(normalizeGifs(cut).entries).length, 2);
  assert.equal(findGif(cut, evictedHandle), null);
  const { gifs: again } = mergeGifs(cut, [linkMessage('m5', A, T0 + HOUR, 'https://tenor.com/view/newer')]);
  assert.equal(findGif(again, evictedHandle), null);
});

// The candidate search.

/** A library of entries with these captions and vectors; `g1` is the most used. */
function captioned(items: Array<{ caption?: string; vector?: Array<number> | null }>) {
  const entries: Record<string, object> = {};
  items.forEach((item, index) => {
    entries[`k${index + 1}`] = {
      id: `g${index + 1}`,
      kind: 'link',
      url: `https://tenor.com/view/${index + 1}`,
      count: items.length - index,
      last: T0,
      firstSeen: T0,
      ...item,
    };
  });
  return { nextId: items.length + 1, entries };
}

const handles = (found: ReturnType<typeof searchGifs>) => found.map(({ entry }) => entry.id);

test('the search returns at most the cap, ordered by score', () => {
  const gifs = captioned(Array.from({ length: 10 }, (_, index) => ({ caption: `γάτα χορεύει ${index}` })));
  const found = searchGifs(gifs, { words: 'γάτα', vector: null, cap: 3 });
  assert.equal(found.length, 3);
  const scores = found.map(({ score }) => score);
  assert.deepEqual(
    scores,
    [...scores].sort((one, two) => two - one)
  );
});

test('a caption that matches by words and by vector comes before one that matches by either', () => {
  const gifs = captioned([
    { caption: 'σκύλος τρέχει', vector: [0.6, 0.8] },
    { caption: 'γάτα κοιμάται', vector: [0, 1] },
    { caption: 'γάτα χορεύει', vector: [1, 0] },
  ]);
  assert.equal(handles(searchGifs(gifs, { words: 'γάτα', vector: [1, 0], cap: 5 }))[0], 'g3');
});

test('a query word matches a caption in any case', () => {
  const gifs = captioned([{ caption: 'ΓΆΤΑ χορεύει' }]);
  assert.deepEqual(handles(searchGifs(gifs, { words: 'γάτα', vector: null, cap: 5 })), ['g1']);
});

test('a vector alone finds a caption that shares no word', () => {
  const gifs = captioned([
    { caption: 'σκύλος', vector: [0, 1] },
    { caption: 'γατάκι', vector: [1, 0] },
  ]);
  assert.deepEqual(handles(searchGifs(gifs, { words: 'χαρά', vector: [1, 0], cap: 5 })), ['g2']);
});

test('an entry with neither a word nor a similar vector is no candidate', () => {
  const gifs = captioned([{ caption: 'σκύλος', vector: [0, 1] }]);
  assert.deepEqual(searchGifs(gifs, { words: 'γάτα', vector: [1, 0], cap: 5 }), []);
});

test('a GIF without a caption is never a candidate', () => {
  const gifs = captioned([{ vector: [1, 0] }]);
  assert.deepEqual(searchGifs(gifs, { words: 'γάτα', vector: [1, 0], cap: 5 }), []);
});

test('equal scores go to the GIF used more', () => {
  const gifs = captioned([{ caption: 'γάτα' }, { caption: 'γάτα' }]);
  assert.deepEqual(handles(searchGifs(gifs, { words: 'γάτα', vector: null, cap: 5 })), ['g1', 'g2']);
});

test('a vector of another dimension counts as no vector', () => {
  // Bug: a change of embedding model leaves old vectors in the library, and a comparison across lengths answers NaN.
  const gifs = captioned([{ caption: 'γάτα', vector: [1, 0, 0] }]);
  const found = searchGifs(gifs, { words: 'γάτα', vector: [1, 0], cap: 5 });
  assert.deepEqual(handles(found), ['g1']);
  assert.ok(Number.isFinite(found[0].score));
});

test('an empty query or a cap of 0 finds nothing', () => {
  const gifs = captioned([{ caption: 'γάτα', vector: [1, 0] }]);
  assert.deepEqual(searchGifs(gifs, { words: ' ', vector: null, cap: 5 }), []);
  assert.deepEqual(searchGifs(gifs, { words: 'γάτα', vector: null, cap: 0 }), []);
});

test('a caption and its vector written on an entry make it findable, and an unknown key changes nothing', () => {
  const gifs = library([linkMessage('m1', A, T0)]);
  const key = Object.keys(normalizeGifs(gifs).entries)[0];
  const described = withGifCaption(gifs, key, { caption: 'γάτα χορεύει', vector: [1, 0] });
  assert.equal(searchGifs(described, { words: 'γάτα', vector: null, cap: 5 }).length, 1);
  assert.equal(searchGifs(described, { words: 'χαρά', vector: [1, 0], cap: 5 }).length, 1);
  assert.deepEqual(normalizeGifs(withGifCaption(gifs, 'nobody', { caption: 'x', vector: null })), normalizeGifs(gifs));
});
