import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GIF_MAX_PER_DAY_FALLBACK,
  GIF_POSTS_PER_DAY_FALLBACK,
  gifPostsToday,
  gifWatchBlocker,
  gifWatchCap,
  gifWatchPrompt,
  gifWatchesToday,
} from '../src/memory/gif-watch.js';

const ON = { features: { mediaDescriptions: true }, media: { gif: { watch: true } } };
const VIDEO = { 'describe-video': 'video {{maxChars}}' };
const GIF = { 'describe-gif': 'gif {{maxChars}} {{seconds}}' };

test('gifWatchBlocker: null when the describer, video vision and a watch prompt are all there', () => {
  assert.equal(gifWatchBlocker(ON, VIDEO), null);
  assert.equal(gifWatchBlocker(ON, GIF), null, 'describe-gif alone is enough');
  assert.equal(
    gifWatchBlocker({ features: { mediaDescriptions: true } }, VIDEO),
    null,
    'a missing media.gif.watch counts as on'
  );
});

test('gifWatchBlocker: off, video-off and prompt in that order', () => {
  assert.equal(gifWatchBlocker({ features: {} }, VIDEO), 'off');
  assert.equal(gifWatchBlocker({ ...ON, media: { gif: { watch: false } } }, VIDEO), 'off');
  assert.equal(
    gifWatchBlocker({ ...ON, features: { mediaDescriptions: true, videoDescriptions: false } }, VIDEO),
    'video-off'
  );
  assert.equal(gifWatchBlocker(ON, {}), 'no-prompt');
  assert.equal(gifWatchBlocker(ON, { 'describe-video': '', 'describe-gif': '' }), 'no-prompt');
  assert.equal(gifWatchBlocker(ON, undefined), 'no-prompt');
  assert.equal(gifWatchBlocker(undefined, VIDEO), 'off');
});

test('gifWatchPrompt: describe-gif when present, else describe-video', () => {
  assert.deepEqual(gifWatchPrompt({ ...VIDEO, ...GIF }), { name: 'describe-gif', text: GIF['describe-gif'] });
  assert.deepEqual(gifWatchPrompt(VIDEO), { name: 'describe-video', text: VIDEO['describe-video'] });
  assert.deepEqual(gifWatchPrompt({ ...VIDEO, 'describe-gif': '' }), {
    name: 'describe-video',
    text: VIDEO['describe-video'],
  });
  assert.equal(gifWatchPrompt({}), null);
});

test('gifWatchCap: media.gif.maxPerDay, a missing or invalid value means the fallback', () => {
  assert.equal(gifWatchCap({ media: { gif: { maxPerDay: 12 } } }), 12);
  assert.equal(gifWatchCap({ media: { gif: { maxPerDay: 0 } } }), 0, 'zero is a valid cap: no watches');
  assert.equal(gifWatchCap({ media: { gif: {} } }), GIF_MAX_PER_DAY_FALLBACK);
  assert.equal(gifWatchCap({ media: { gif: { maxPerDay: -1 } } }), GIF_MAX_PER_DAY_FALLBACK);
  assert.equal(gifWatchCap({ media: { gif: { maxPerDay: 'many' } } }), GIF_MAX_PER_DAY_FALLBACK);
  assert.equal(gifWatchCap(undefined), GIF_MAX_PER_DAY_FALLBACK);
});

test("gifWatchesToday: today's count against the cap; another day counts as zero", () => {
  const config = { media: { gif: { maxPerDay: 50 } } };
  assert.deepEqual(gifWatchesToday({ gifWatchDay: '2026-10-01', gifWatchCount: 7 }, config, '2026-10-01'), {
    used: 7,
    cap: 50,
  });
  assert.deepEqual(gifWatchesToday({ gifWatchDay: '2026-09-30', gifWatchCount: 7 }, config, '2026-10-01'), {
    used: 0,
    cap: 50,
  });
  assert.deepEqual(gifWatchesToday({}, config, '2026-10-01'), { used: 0, cap: 50 });
  assert.deepEqual(gifWatchesToday(undefined, undefined, '2026-10-01'), { used: 0, cap: GIF_MAX_PER_DAY_FALLBACK });
  // The video counter is a different one.
  assert.deepEqual(gifWatchesToday({ videoDay: '2026-10-01', videoCount: 40 }, config, '2026-10-01'), {
    used: 0,
    cap: 50,
  });
});

test('gifPostsToday: the posts of today against gifs.maxPerDay; another day counts 0; a missing cap is the fallback', () => {
  const today = '2026-10-03';
  assert.deepEqual(gifPostsToday({ gifDay: today, gifCount: 3 }, { gifs: { maxPerDay: 5 } }, today), {
    used: 3,
    cap: 5,
  });
  assert.deepEqual(gifPostsToday({ gifDay: '2026-10-02', gifCount: 3 }, { gifs: { maxPerDay: 0 } }, today), {
    used: 0,
    cap: 0,
  });
  assert.deepEqual(gifPostsToday({ gifDay: today, gifCount: 'x' }, {}, today), {
    used: 0,
    cap: GIF_POSTS_PER_DAY_FALLBACK,
  });
  assert.deepEqual(gifPostsToday(undefined, undefined, today), { used: 0, cap: GIF_POSTS_PER_DAY_FALLBACK });
});

test('gifWatchesToday, gifPostsToday: a stored count that is not a finite number >= 0 reads as 0, and nothing is written', () => {
  const today = '2026-10-03';
  for (const bad of [-2, NaN, Infinity, '7', null, {}]) {
    const data = { gifWatchDay: today, gifWatchCount: bad, gifDay: today, gifCount: bad };
    assert.equal(gifWatchesToday(data, {}, today).used, 0, `watches ${String(bad)}`);
    assert.equal(gifPostsToday(data, {}, today).used, 0, `posts ${String(bad)}`);
  }
  // A read never rolls a stale day over: the describer and the turn do that when they count.
  const stale = { gifWatchDay: '2026-10-02', gifWatchCount: 9, gifDay: '2026-10-02', gifCount: 4 };
  gifWatchesToday(stale, {}, today);
  gifPostsToday(stale, {}, today);
  assert.deepEqual(stale, { gifWatchDay: '2026-10-02', gifWatchCount: 9, gifDay: '2026-10-02', gifCount: 4 });
});

test('gif caps: the code fallbacks equal the values shipped in config.json', () => {
  const shipped = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.equal(GIF_MAX_PER_DAY_FALLBACK, shipped.media.gif.maxPerDay);
  assert.equal(GIF_POSTS_PER_DAY_FALLBACK, shipped.gifs.maxPerDay);
});
