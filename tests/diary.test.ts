// Tests for src/behavior/diary.ts (the diary scheduler's pure core: the day
// plan, due slots, kind choice, plan validation, the <diary> / <kinds> /
// <seeds> renderings, URL stripping, gists), the store's diary file and the
// scheduler's factory (createDiary) over fakes.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  localDayKey,
  planDay,
  nextHunger,
  dueSlot,
  pickKind,
  withoutPictureKinds,
  isPictureKind,
  isSetKind,
  setSettings,
  validatePlan,
  renderDiaryBlock,
  recentOpenings,
  renderOpenings,
  renderKindsBlock,
  usedSeedLines,
  sceneOf,
  renderSeedsBlock,
  gistOf,
  createDiary,
} from '../src/behavior/diary.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { fill } from '../src/format.ts';
import { MINUTE_MS, HOUR_MS, DAY_MS } from '../src/time.ts';
import { labels } from './fixtures/labels.ts';
import { createStore } from '../src/memory/store.ts';
import { useIface, world } from './fixtures/turn-world.ts';
import { tempDir } from './fixtures/tmp.ts';
import { openTestMemory, openTestMemorySync, unitFile } from './fixtures/memory-db/service.ts';
import { seedMirror } from './fixtures/diary-mirror.ts';
import type { Untyped } from '../src/tools/types.ts';
import { memoryAt } from './fixtures/store-kit.ts';
import { writeUnitUpdate } from './fixtures/memory-db/unit-writes.ts';

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

// The diary channel is held by a fake interface named `fake`.
useIface('fake');

const seq = (values: Untyped) => {
  let i = 0;
  return () => values[i++ % values.length];
};

// PR 7d: the gap between slots (90 minutes), the quiet carry (0.25) and the hunger boost (0.5) are constants of
// src/behavior/diary.ts, and the daily post cap is gone.
const base = { quietDayChance: 0 };

test('localDayKey: the local date of the zone, not the UTC one', () => {
  const t = Date.parse('2026-03-10T23:30:00Z');
  assert.equal(localDayKey(t, 'UTC'), '2026-03-10');
  assert.equal(localDayKey(t, 'Europe/Athens'), '2026-03-11');
});

test('planDay: a window crossing midnight stays inside it in Europe/Athens', () => {
  const nowMs = Date.parse('2026-03-10T05:00:00Z');
  const cfg = { ...base, windows: [{ from: 18, to: 1, posts: [2, 2] }] };
  // PR 7d: two slots stay 90 minutes apart, so no case puts both into the hour after midnight.
  for (const values of [
    [0.5, 0.5, 0, 0.999],
    [0.5, 0.5, 0.95, 0.05],
    [0.5, 0.5, 0.1, 0.6],
  ]) {
    const plan = planDay(cfg, nowMs, 'Europe/Athens', seq(values));
    assert.equal(plan.day, '2026-03-10');
    assert.equal(plan.quiet, false);
    assert.deepEqual(plan.done, []);
    assert.equal(plan.slots.length, 2);
    for (const slot of plan.slots) {
      const hour =
        Number(
          new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Athens', hour: 'numeric', hourCycle: 'h23' }).format(
            slot
          )
        ) % 24;
      assert.ok(hour >= 18 || hour < 1, `local hour ${hour}`);
      if (hour >= 18) assert.equal(localDayKey(slot, 'Europe/Athens'), '2026-03-10');
      else assert.equal(localDayKey(slot, 'Europe/Athens'), '2026-03-11');
    }
    assert.ok(plan.slots[0] <= plan.slots[1]);
  }
});

test('planDay: the count is drawn inside the window range', () => {
  const cfg = { ...base, windows: [{ from: 12, to: 16, posts: [0, 2] }] };
  const nowMs = Date.parse('2026-03-10T05:00:00Z');
  assert.equal(planDay(cfg, nowMs, 'UTC', seq([0.5, 0, 0.5])).slots.length, 0);
  assert.equal(planDay(cfg, nowMs, 'UTC', seq([0.5, 0.99, 0.2, 0.8])).slots.length, 2);
});

test('planDay: minGapMinutes drops a slot too close to another', () => {
  const cfg = { ...base, windows: [{ from: 12, to: 16, posts: [2, 2] }] };
  const nowMs = Date.parse('2026-03-10T05:00:00Z');
  // quiet roll, count roll, then two placements 10 minutes apart in a 240-minute window
  const plan = planDay(cfg, nowMs, 'UTC', seq([0.5, 0.5, 0.5, 0.5 + 10 / 240]));
  assert.equal(plan.slots.length, 1);
  const spread = planDay(cfg, nowMs, 'UTC', seq([0.5, 0.5, 0.1, 0.9]));
  assert.equal(spread.slots.length, 2);
});

test('planDay: a quiet day has no slots', () => {
  const cfg = { ...base, quietDayChance: 0.3, windows: [{ from: 12, to: 16, posts: [1, 1] }] };
  const nowMs = Date.parse('2026-03-10T05:00:00Z');
  const quiet = planDay(cfg, nowMs, 'UTC', seq([0.1, 0.5]));
  assert.equal(quiet.quiet, true);
  assert.deepEqual(quiet.slots, []);
  assert.equal(quiet.day, '2026-03-10');
  const busy = planDay(cfg, nowMs, 'UTC', seq([0.9, 0.5]));
  assert.equal(busy.quiet, false);
  assert.equal(busy.slots.length, 1);
});

test('planDay: [0, 0] windows produce nothing', () => {
  const cfg = {
    ...base,
    windows: [
      { from: 7, to: 11, posts: [0, 0] },
      { from: 12, to: 16, posts: [0, 0] },
    ],
  };
  const plan = planDay(cfg, Date.parse('2026-03-10T05:00:00Z'), 'UTC', seq([0.5, 0.99]));
  assert.deepEqual(plan.slots, []);
  assert.equal(plan.quiet, false);
});

test('planDay: no windows produce nothing', () => {
  const nowMs = Date.parse('2026-03-10T05:00:00Z');
  assert.deepEqual(planDay({ ...base, windows: [] }, nowMs, 'UTC', seq([0.5])).slots, []);
  assert.deepEqual(planDay({ ...base }, nowMs, 'UTC', seq([0.5])).slots, []);
});

test('planDay: a slot already past at planning time is kept', () => {
  const cfg = { ...base, windows: [{ from: 7, to: 9, posts: [1, 1] }] };
  const nowMs = Date.parse('2026-03-10T15:00:00Z');
  const plan = planDay(cfg, nowMs, 'UTC', seq([0.5, 0.5, 0.5]));
  assert.deepEqual(plan.slots, [Date.parse('2026-03-10T08:00:00Z')]);
});

// Hunger: skipped windows and quiet days raise the chance of later posts.

const counted = (values: Untyped) => {
  const rng = seq(values);
  const wrapped = () => {
    wrapped.calls += 1;
    return rng();
  };
  wrapped.calls = 0;
  return wrapped;
};

const H_NOW = Date.parse('2026-03-10T05:00:00Z');

test('planDay: the quiet chance shrinks by quietCarry per quiet day in a row', () => {
  const cfg = { ...base, quietDayChance: 0.4, windows: [{ from: 12, to: 16, posts: [1, 1] }] };
  const first = planDay(cfg, H_NOW, 'UTC', seq([0.3, 0.5, 0.5]), { hunger: [2], quietStreak: 0 });
  assert.equal(first.quiet, true, '0.3 < 0.4');
  assert.deepEqual(first.hunger, [2]);
  assert.equal(first.quietStreak, 0);
  assert.deepEqual(first.posted, []);
  const second = planDay(cfg, H_NOW, 'UTC', seq([0.3, 0.5, 0.5]), { hunger: [2], quietStreak: 1 });
  assert.equal(second.quiet, false, '0.3 >= 0.4 * 0.25');
  assert.equal(second.quietStreak, 1);
  assert.deepEqual(second.posted, []);
  assert.equal(planDay(cfg, H_NOW, 'UTC', seq([0.05, 0.5, 0.5]), { quietStreak: 1 }).quiet, true, '0.05 < 0.1');
  assert.equal(planDay(cfg, H_NOW, 'UTC', seq([0.05, 0.5, 0.5]), { quietStreak: 2 }).quiet, false, '0.05 >= 0.025');
});

test('planDay: a hungry window redraws an empty count, at most once per hunger point', () => {
  const cfg = { ...base, windows: [{ from: 12, to: 16, posts: [0, 1] }] };
  // quiet roll, count 0, then (boost roll, redraw) pairs: 0.7 >= 0.5 redraws to 0, then to 1; placement mid-window
  const values = [0.9, 0.1, 0.7, 0.2, 0.7, 0.8, 0.5];
  assert.deepEqual(planDay(cfg, H_NOW, 'UTC', seq(values), { hunger: [2] }).slots, [
    Date.parse('2026-03-10T14:00:00Z'),
  ]);
  assert.deepEqual(planDay(cfg, H_NOW, 'UTC', seq(values), { hunger: [1] }).slots, [], 'one hunger point, one redraw');
  assert.deepEqual(planDay(cfg, H_NOW, 'UTC', seq(values), { hunger: [0] }).slots, [], 'no hunger, no redraw');
  // a boost roll under hungerBoost keeps the zero
  assert.deepEqual(planDay(cfg, H_NOW, 'UTC', seq([0.9, 0.1, 0.3, 0.3, 0.3]), { hunger: [3] }).slots, []);
});

test('planDay: a [0, 0] window never redraws and adds no deficit', () => {
  const cfg = {
    ...base,
    windows: [
      { from: 7, to: 11, posts: [0, 0] },
      { from: 12, to: 16, posts: [0, 1] },
    ],
  };
  // quiet roll, the off window's count, the day window's count 0; a deficit would redraw it with 0.7, 0.8
  const rng = counted([0.9, 0.5, 0.1, 0.7, 0.8, 0.5]);
  const plan = planDay(cfg, H_NOW, 'UTC', rng, { hunger: [3, 0] });
  assert.deepEqual(plan.slots, []);
  assert.equal(rng.calls, 3);
  assert.deepEqual(plan.hunger, [3, 0]);
});

test('planDay: an empty window of the day raises the hunger of the later windows', () => {
  const cfg = {
    ...base,
    windows: [
      { from: 7, to: 11, posts: [0, 1] },
      { from: 12, to: 16, posts: [0, 1] },
    ],
  };
  // quiet roll, morning count 0 (deficit 1), day count 0, boost roll 0.7 redraws to 1, placement mid-window
  const plan = planDay(cfg, H_NOW, 'UTC', seq([0.9, 0.1, 0.1, 0.7, 0.8, 0.5]), { hunger: [0, 0] });
  assert.deepEqual(plan.slots, [Date.parse('2026-03-10T14:00:00Z')]);
  const alone = { ...cfg, windows: [cfg.windows[1]] };
  assert.deepEqual(
    planDay(alone, H_NOW, 'UTC', seq([0.9, 0.1, 0.7, 0.8, 0.5]), { hunger: [0] }).slots,
    [],
    'without the empty morning, no redraw'
  );
});

const H_WINDOWS = [
  { from: 7, to: 11, posts: [0, 1] },
  { from: 12, to: 16, posts: [0, 1] },
  { from: 18, to: 1, posts: [0, 2] },
];

test('nextHunger: no previous plan starts at zero', () => {
  assert.deepEqual(nextHunger(null, H_WINDOWS, 'UTC', H_NOW, 30), { hunger: [0, 0, 0], quietStreak: 0 });
  assert.deepEqual(nextHunger(undefined, H_WINDOWS, 'UTC', H_NOW, 30), { hunger: [0, 0, 0], quietStreak: 0 });
});

test('nextHunger: a quiet day feeds no window and lengthens the streak', () => {
  const previous = {
    day: '2026-03-10',
    slots: [],
    quiet: true,
    done: [],
    posted: [],
    hunger: [1, 0, 2],
    quietStreak: 1,
  };
  const nowMs = Date.parse('2026-03-11T00:05:00Z');
  assert.deepEqual(nextHunger(previous, H_WINDOWS, 'UTC', nowMs, 30), { hunger: [2, 1, 3], quietStreak: 2 });
});

test('nextHunger: a window with a posted slot resets, an empty one grows, a pending wrap slot counts as fed', () => {
  const posted = Date.parse('2026-03-10T08:00:00Z');
  const droppedSlot = Date.parse('2026-03-10T13:00:00Z');
  const wrap = Date.parse('2026-03-11T00:30:00Z');
  const previous = {
    day: '2026-03-10',
    slots: [posted, droppedSlot, wrap],
    done: [posted, droppedSlot],
    posted: [posted],
    quiet: false,
    hunger: [3, 1, 4],
    quietStreak: 2,
  };
  const nowMs = Date.parse('2026-03-11T00:05:00Z');
  assert.deepEqual(nextHunger(previous, H_WINDOWS, 'UTC', nowMs, 30), { hunger: [0, 2, 0], quietStreak: 0 });
  const missed = { ...previous, done: [posted, droppedSlot, wrap] };
  assert.deepEqual(
    nextHunger(missed, H_WINDOWS, 'UTC', nowMs, 30).hunger,
    [0, 2, 5],
    'a wrap slot dropped unfired does not feed'
  );
  const late = Date.parse('2026-03-11T01:30:00Z');
  assert.deepEqual(
    nextHunger(previous, H_WINDOWS, 'UTC', late, 30).hunger,
    [0, 2, 5],
    'a wrap slot past the grace does not feed'
  );
});

test('nextHunger: a slot outside every window feeds none', () => {
  const stray = Date.parse('2026-03-10T17:00:00Z');
  const previous = {
    day: '2026-03-10',
    slots: [stray],
    done: [stray],
    posted: [stray],
    quiet: false,
    hunger: [0, 0, 0],
    quietStreak: 0,
  };
  assert.deepEqual(nextHunger(previous, H_WINDOWS, 'UTC', Date.parse('2026-03-11T02:00:00Z'), 30).hunger, [1, 1, 1]);
});

test('nextHunger: a [0, 0] window or a malformed one stays at zero', () => {
  const windows = [
    { from: 7, to: 11, posts: [0, 0] },
    { from: 30, to: 2, posts: [0, 1] },
    { from: 12, to: 16, posts: [0, 1] },
  ];
  const previous = {
    day: '2026-03-10',
    slots: [],
    done: [],
    posted: [],
    quiet: false,
    hunger: [4, 4, 4],
    quietStreak: 0,
  };
  const nowMs = Date.parse('2026-03-11T02:00:00Z');
  assert.deepEqual(nextHunger(previous, windows, 'UTC', nowMs, 30).hunger, [0, 0, 5]);
  assert.deepEqual(nextHunger({ ...previous, quiet: true }, windows, 'UTC', nowMs, 30).hunger, [0, 0, 5]);
});

test('nextHunger: a changed windows list pads with zero or trims', () => {
  const previous = {
    day: '2026-03-10',
    slots: [],
    quiet: true,
    done: [],
    posted: [],
    hunger: [3, 1, 4],
    quietStreak: 0,
  };
  const nowMs = Date.parse('2026-03-11T02:00:00Z');
  assert.deepEqual(nextHunger(previous, H_WINDOWS.slice(0, 2), 'UTC', nowMs, 30).hunger, [4, 2]);
  const more = [...H_WINDOWS, { from: 1, to: 5, posts: [0, 1] }];
  assert.deepEqual(nextHunger(previous, more, 'UTC', nowMs, 30).hunger, [4, 2, 5, 1]);
});

test('dueSlot: returns the first not-done slot within the grace', () => {
  const t = Date.parse('2026-03-10T15:00:00Z');
  const plan = { slots: [t - 20 * MINUTE_MS, t - 5 * MINUTE_MS, t + 10 * MINUTE_MS], done: [t - 20 * MINUTE_MS] };
  assert.deepEqual(dueSlot(plan, t, 30), { slot: t - 5 * MINUTE_MS, dropped: [] });
  assert.equal(dueSlot({ slots: [t + MINUTE_MS], done: [] }, t, 30), null);
  assert.equal(dueSlot({ slots: [t - MINUTE_MS], done: [t - MINUTE_MS] }, t, 30), null);
});

test('dueSlot: a slot older than the grace is dropped, not fired', () => {
  const t = Date.parse('2026-03-10T15:00:00Z');
  const plan = { slots: [t - 60 * MINUTE_MS, t - 5 * MINUTE_MS, t + 10 * MINUTE_MS], done: [] };
  assert.deepEqual(dueSlot(plan, t, 30), { slot: t - 5 * MINUTE_MS, dropped: [t - 60 * MINUTE_MS] });
  const missed = { slots: [t - 3 * HOUR_MS, t - 2 * HOUR_MS], done: [] };
  assert.deepEqual(dueSlot(missed, t, 30), { slot: null, dropped: [t - 3 * HOUR_MS, t - 2 * HOUR_MS] });
});

test('pickKind: weights zero are never chosen', () => {
  const kinds = { a: 0, b: 1, c: 0, d: 3 };
  for (const r of [0, 0.1, 0.24, 0.25, 0.5, 0.999]) {
    const kind = pickKind(kinds, () => r);
    assert.ok(kind === 'b' || kind === 'd', `${r} -> ${kind}`);
  }
  assert.equal(
    pickKind(kinds, () => 0.1),
    'b'
  );
  assert.equal(
    pickKind(kinds, () => 0.9),
    'd'
  );
});

test('pickKind: null when all weights are zero', () => {
  assert.equal(
    pickKind({ a: 0, b: 0 }, () => 0.5),
    null
  );
  assert.equal(
    pickKind({}, () => 0.5),
    null
  );
  assert.equal(
    pickKind(null, () => 0.5),
    null
  );
});

test('withoutPictureKinds: drops the picture kinds, keeps the others with their weights', () => {
  const kinds = { selfPicture: 2, status: 1, meme: 3, news: 0 };
  assert.deepEqual(withoutPictureKinds(kinds, ['selfPicture', 'meme']), { status: 1, news: 0 });
  assert.deepEqual(kinds, { selfPicture: 2, status: 1, meme: 3, news: 0 }, 'the input is not changed');
});

test('withoutPictureKinds: nothing weighted left makes pickKind return null', () => {
  assert.equal(
    pickKind(withoutPictureKinds({ selfPicture: 2 }, ['selfPicture']), () => 0.5),
    null
  );
});

test('isPictureKind: listed kinds, the default list when none is given', () => {
  assert.equal(isPictureKind('meme', ['meme']), true);
  assert.equal(isPictureKind('status', ['meme']), false);
  assert.equal(isPictureKind('selfPicture', undefined), true);
  assert.equal(isPictureKind('selfPicture', []), false);
  assert.equal(isPictureKind(null, undefined), false);
});

const kinds = { selfPicture: 3, thought: 2, news: 2, meme: 0 };
const opts = { pictureAllowed: true, searchKinds: ['news', 'facts'] };

test('validatePlan: accepts a well-formed answer', () => {
  const plan = validatePlan(
    { kind: 'news', brief: 'a find about trains', search: 'night trains', picture: false },
    kinds,
    opts,
    () => 0.5
  );
  assert.deepEqual(plan, {
    kind: 'news',
    brief: 'a find about trains',
    search: 'night trains',
    picture: false,
    fallback: false,
  });
  const drawn = validatePlan({ kind: 'selfPicture', brief: 'Ελένη on a pier', picture: true }, kinds, opts, () => 0.5);
  assert.deepEqual(drawn, {
    kind: 'selfPicture',
    brief: 'Ελένη on a pier',
    search: '',
    picture: true,
    fallback: false,
  });
});

test('validatePlan: falls back to a weighted kind', () => {
  for (const parsed of [null, 'garbage', { kind: 'nope', brief: 'x' }, { kind: 'meme', brief: 'x', search: 'y' }]) {
    const plan = validatePlan(parsed, kinds, opts, () => 0);
    assert.equal(plan.fallback, true);
    assert.equal(plan.kind, 'selfPicture');
    assert.equal(plan.brief, '');
    assert.equal(plan.search, '');
  }
  assert.equal(validatePlan(null, { a: 0 }, opts, () => 0).kind, null);
});

test('validatePlan: a fallback picture kind draws when allowed', () => {
  const plan = validatePlan(null, kinds, { ...opts, pictureKinds: ['selfPicture'] }, () => 0);
  assert.equal(plan.kind, 'selfPicture');
  assert.equal(plan.fallback, true);
  assert.equal(plan.picture, true);
  const capped = validatePlan(null, kinds, { ...opts, pictureAllowed: false, pictureKinds: ['selfPicture'] }, () => 0);
  assert.equal(capped.picture, false);
});

test('validatePlan: a fallback text kind does not draw', () => {
  const plan = validatePlan(
    { kind: 'nope', picture: true },
    kinds,
    { ...opts, pictureKinds: ['selfPicture'] },
    () => 0.99
  );
  assert.equal(plan.kind, 'news');
  assert.equal(plan.fallback, true);
  assert.equal(plan.picture, false);
});

test('validatePlan: a picture kind always draws when allowed', () => {
  for (const picture of [false, undefined, 'no']) {
    const plan = validatePlan(
      { kind: 'selfPicture', brief: 'b', picture },
      kinds,
      { ...opts, pictureKinds: ['selfPicture'] },
      () => 0.5
    );
    assert.equal(plan.picture, true);
    assert.equal(plan.fallback, false);
  }
  const capped = validatePlan(
    { kind: 'selfPicture', brief: 'b', picture: false },
    kinds,
    { ...opts, pictureAllowed: false, pictureKinds: ['selfPicture'] },
    () => 0.5
  );
  assert.equal(capped.picture, false);
  const text = validatePlan(
    { kind: 'thought', brief: 'b', picture: true },
    kinds,
    { ...opts, pictureKinds: ['selfPicture'] },
    () => 0.5
  );
  assert.equal(text.picture, true);
  const quiet = validatePlan(
    { kind: 'thought', brief: 'b', picture: false },
    kinds,
    { ...opts, pictureKinds: ['selfPicture'] },
    () => 0.5
  );
  assert.equal(quiet.picture, false);
});

test('validatePlan: search is cleared for a kind outside searchKinds', () => {
  const plan = validatePlan({ kind: 'thought', brief: 'b', search: 'q', picture: false }, kinds, opts, () => 0.5);
  assert.equal(plan.search, '');
  assert.equal(plan.fallback, false);
});

test('validatePlan: picture forced false when not allowed', () => {
  const plan = validatePlan(
    { kind: 'selfPicture', brief: 'b', picture: true },
    kinds,
    { ...opts, pictureAllowed: false },
    () => 0.5
  );
  assert.equal(plan.picture, false);
  assert.equal(validatePlan({ kind: 'thought', picture: 'yes' }, kinds, opts, () => 0.5).picture, false);
});

// The owner on 2026-11-16: a planner's brief is kept whole; the limit of 300 is gone.
test('validatePlan: a long brief is kept whole on one line', () => {
  const plan = validatePlan(
    { kind: 'thought', brief: `line one\nline two ${'word '.repeat(100)}` },
    kinds,
    opts,
    () => 0.5
  );
  assert.equal(plan.brief, `line one line two ${'word '.repeat(99)}word`);
});

test('renderDiaryBlock: newest first, at most max lines, picture suffix when present', () => {
  // newest first since 2026-11-14 (specs/2026-11-14-diary-in-her-own-words.md)
  const posts = [
    { at: Date.parse('2026-03-01T10:00:00Z'), kind: 'status', gist: 'oldest', picture: null },
    { at: Date.parse('2026-03-02T10:00:00Z'), kind: null, gist: 'from the backfill', picture: true },
    { at: Date.parse('2026-03-03T22:30:00Z'), kind: 'selfPicture', gist: 'on the pier', picture: 'a pier at dusk' },
    { at: Date.parse('2026-03-04T10:00:00Z'), kind: 'thought', gist: 'café thoughts', picture: null },
  ];
  const text = renderDiaryBlock(posts, labels, { timezone: 'Europe/Athens', max: 3 });
  assert.equal(
    text,
    [
      'Your latest diary posts, newest first:',
      '- 2026-03-04 thought: café thoughts',
      '- 2026-03-04 selfPicture: on the pier [picture: a pier at dusk]',
      '- 2026-03-02 post: from the backfill [picture: not recorded]',
    ].join('\n')
  );
  assert.equal(renderDiaryBlock([], labels, { timezone: 'UTC', max: 3 }), '');
});

test('renderDiaryBlock: a cut to max keeps the newest posts, not the first ones given', () => {
  // Bug: the list is reversed and then cut with the old `slice(-max)`, so the oldest posts stay.
  const posts = ['one', 'two', 'three', 'four'].map((gist, index) => ({
    at: Date.UTC(2026, 2, 1 + index, 10),
    kind: 'status',
    gist,
    picture: null,
  }));
  const lines = renderDiaryBlock(posts, labels, { timezone: 'UTC', max: 2 }).split('\n');
  assert.deepEqual(lines.slice(1), ['- 2026-03-04 status: four', '- 2026-03-03 status: three']);
});

test('renderDiaryBlock: a set renders its first scene with the picture count', () => {
  // newest first since 2026-11-14 (specs/2026-11-14-diary-in-her-own-words.md)
  const posts = [
    { at: Date.parse('2026-03-01T10:00:00Z'), kind: 'tour', gist: 'a walk', picture: 'a harbour at noon', pictures: 5 },
    { at: Date.parse('2026-03-02T10:00:00Z'), kind: 'selfPicture', gist: 'alone', picture: 'a pier', pictures: 1 },
  ];
  const text = renderDiaryBlock(posts, labels, { timezone: 'UTC', max: 5 });
  const lines = text.split('\n');
  assert.ok(labels.diary.pictureSet, 'the fixture carries the label');
  assert.equal(
    lines[2],
    `- 2026-03-01 tour: a walk${fill(labels.diary.pictureSet, { count: 5, scene: 'a harbour at noon' })}`
  );
  assert.equal(lines[1], '- 2026-03-02 selfPicture: alone [picture: a pier]', 'one picture keeps the plain suffix');
});

/** Past entries as the store keeps them, oldest first, one day apart: a `[kind, gist]` pair each. */
const entriesOf = (...rows: Array<[string, string]>) =>
  rows.map(([kind, gist], index) => ({ at: Date.UTC(2026, 2, 1 + index, 10), kind, gist, picture: null }));

test('recentOpenings: the first words of the newest entries of the kind, newest first, up to count', () => {
  // Bug: the openings come oldest first, whole gists, or more than count of them.
  const posts = entriesOf(
    ['status', 'first walk by the harbour today'],
    ['status', 'second walk in the morning rain'],
    ['status', 'third walk before the market opens']
  );
  assert.deepEqual(recentOpenings(posts, 'status', { count: 2, words: 3 }), ['third walk before', 'second walk in']);
});

test('recentOpenings: an entry of another kind is skipped', () => {
  // Bug: the openings of a thought are shown to a status entry, so the kinds blur their own habits.
  const posts = entriesOf(
    ['status', 'harbour walk at dawn'],
    ['thought', 'tides and the moon'],
    ['thought', 'a note on sleep']
  );
  assert.deepEqual(recentOpenings(posts, 'status', { count: 5, words: 2 }), ['harbour walk']);
});

test('recentOpenings: an entry with no text is skipped and takes no place from count', () => {
  // Bug: a picture entry with an empty gist gives an empty line or uses up the count.
  const posts = [
    ...entriesOf(['status', 'older walk by the pier']),
    { at: Date.UTC(2026, 2, 2, 10), kind: 'status', gist: '', picture: 'a pier' },
    { at: Date.UTC(2026, 2, 3, 10), kind: 'status', gist: '   ', picture: null },
  ];
  assert.deepEqual(recentOpenings(posts, 'status', { count: 1, words: 2 }), ['older walk']);
});

test('recentOpenings: count 0 gives none', () => {
  // Bug: 0 reads as unset and the default count shows.
  const posts = entriesOf(['status', 'a walk by the pier']);
  assert.deepEqual(recentOpenings(posts, 'status', { count: 0, words: 3 }), []);
});

test('recentOpenings: words 0 gives none', () => {
  // Bug: 0 words reads as the whole gist.
  const posts = entriesOf(['status', 'a walk by the pier']);
  assert.deepEqual(recentOpenings(posts, 'status', { count: 3, words: 0 }), []);
});

test('recentOpenings: a gist shorter than words gives its whole text', () => {
  // Bug: the short gist is padded, dropped or ends on a stray separator.
  const posts = entriesOf(['status', 'quiet day']);
  assert.deepEqual(recentOpenings(posts, 'status', { count: 3, words: 4 }), ['quiet day']);
});

test('recentOpenings: no posts, or a value that is no list, give none', () => {
  // Bug: an empty store or an old malformed value throws before the compose request is built.
  assert.deepEqual(recentOpenings([], 'status', { count: 3, words: 3 }), []);
  assert.deepEqual(recentOpenings(undefined, 'status', { count: 3, words: 3 }), []);
});

test('renderOpenings: the lead line with the count, then one line per opening in the given order', () => {
  // Bug: the count in the lead is missing or wrong, or the lines come back reordered.
  const words = { diary: { planOpenings: 'RECENT {count}', planOpening: 'OPENED {words}' } };
  assert.deepEqual(renderOpenings(['third walk', 'second walk'], words), [
    'RECENT 2',
    'OPENED third walk',
    'OPENED second walk',
  ]);
});

test('renderOpenings: an empty list gives no lines, not a lead with nothing under it', () => {
  // Bug: a lead line that promises openings stands alone in the plan.
  const words = { diary: { planOpenings: 'RECENT {count}', planOpening: 'OPENED {words}' } };
  assert.deepEqual(renderOpenings([], words), []);
});

test('renderOpenings: a missing lead label gives no lines', () => {
  // Bug: a deployment that holds no label gets "undefined" lines in her request.
  assert.deepEqual(renderOpenings(['third walk'], { diary: { planOpening: 'OPENED {words}' } }), []);
});

test('renderOpenings: a missing line label gives no lines', () => {
  // Bug: the lead stands alone, or the openings are listed with no label around them.
  assert.deepEqual(renderOpenings(['third walk'], { diary: { planOpenings: 'RECENT {count}' } }), []);
});

test('isSetKind: listed kinds, the default list when none is given', () => {
  assert.equal(isSetKind('tour', ['tour']), true);
  assert.equal(isSetKind('photoset', ['tour']), false);
  assert.equal(isSetKind('photoset', undefined), true);
  assert.equal(isSetKind('randomSet', null), true);
  assert.equal(isSetKind('selfPicture', undefined), false);
  assert.equal(isSetKind(null, ['tour']), false);
});

test('setSettings: the configured values, whole and ordered; the defaults for missing or broken ones', () => {
  assert.deepEqual(setSettings({ set: { pictures: [2, 3], minPosted: 1, seedSets: 4, maxMessageBytes: 1000 } }), {
    pictures: [2, 3],
    minPosted: 1,
    seedSets: 4,
    maxMessageBytes: 1000,
  });
  const fallback = setSettings({});
  assert.deepEqual(
    setSettings({ set: { pictures: 'x', minPosted: -1, seedSets: null, maxMessageBytes: 0 } }),
    fallback
  );
  assert.deepEqual(setSettings({ set: { pictures: [5, 2] } }).pictures, [5, 5], 'max never below min');
});

test('renderKindsBlock: counts uses among the last window posts', () => {
  const posts = [{ kind: 'thought' }, { kind: 'thought' }, { kind: 'news' }, { kind: 'thought' }, { kind: null }];
  const text = renderKindsBlock({ thought: 2, news: 1, meme: 0 }, posts, labels, { window: 3 });
  assert.equal(
    text,
    [
      'Post kinds and their recent use:',
      'thought weight 2, used 1 of the last 3',
      'news weight 1, used 1 of the last 3',
    ].join('\n')
  );
  assert.equal(
    renderKindsBlock({ thought: 2 }, [], labels, { window: 150 }),
    'Post kinds and their recent use:\nthought weight 2, used 0 of the last 0'
  );
  assert.equal(renderKindsBlock({ meme: 0 }, posts, labels, { window: 3 }), '');
});

/** A past entry the planner planned: `seeds` the combinations offered, `seed` the 1-based one taken (0 for none). */
const planned = (at: number, seeds: Array<Array<string>>, seed: number) => ({
  at,
  kind: 'status',
  gist: `entry ${at}`,
  picture: null,
  plan: { brief: `brief ${at}`, seeds, seed },
});

test('usedSeedLines: the lines of the taken combination, not of the others offered', () => {
  // Bug: every offered combination is left out, so two entries exhaust a small family that was never used.
  const posts = [
    planned(
      1,
      [
        ['a pier', 'fog'],
        ['a roof', 'rain'],
      ],
      2
    ),
  ];
  assert.deepEqual([...usedSeedLines(posts, 10)].sort(), ['a roof', 'rain']);
});

test('usedSeedLines: only the newest max posts count', () => {
  // Bug: the oldest entries (posts are oldest first) are read instead of the newest, or the window is ignored.
  const posts = [planned(1, [['a pier', 'fog']], 1), planned(2, [['a roof', 'rain']], 1)];
  assert.deepEqual([...usedSeedLines(posts, 1)].sort(), ['a roof', 'rain']);
});

test('usedSeedLines: seed 0, a seed past the list and a post with no plan leave nothing out', () => {
  // Bug: `seeds[seed - 1]` read with seed 0 or a seed too large takes the wrong combination, or an old row throws.
  const posts = [
    planned(1, [['a pier', 'fog']], 0),
    planned(2, [['a roof', 'rain']], 3),
    { at: 3, kind: 'status', gist: 'an old row', picture: null },
  ];
  assert.equal(usedSeedLines(posts, 10).size, 0);
});

// The owner on 2026-11-17: a text over its bound is summarized or kept whole, never cut.
test('sceneOf: the stored brief of a planned picture post comes first, whole', () => {
  // Bug: the drawing prompt names the room and the light, and the planner cannot see the activity repeat; or a long
  // brief is cut.
  const brief = `she learns to skate on a frozen lake, ${'falling and getting up again, '.repeat(16)}at dusk`;
  const post = {
    picture: 'a cafe interior, warm light',
    pictureDescription: 'a girl at a window table',
    plan: { brief, seeds: [['a lake', 'skating']], seed: 1 },
  };
  assert.equal(sceneOf(post), brief);
});

// The owner on 2026-11-17: a text over its bound is summarized or kept whole, never cut.
test('sceneOf: without a plan the stored drawing prompt, even when the picture was described', () => {
  // Bug: the scene taken from the picture description, which the scene's bound then cut.
  const post = {
    picture: 'a cafe interior, warm light',
    pictureDescription: 'a girl rides a red bicycle\ndown a wet hill road at dawn',
  };
  assert.equal(sceneOf(post), 'a cafe interior, warm light');
});

// The owner on 2026-11-17: a text over its bound is summarized or kept whole, never cut.
test('sceneOf: with neither a plan nor a description, the stored drawing prompt', () => {
  // Bug: an old row loses its scene and shows nothing.
  assert.equal(sceneOf({ picture: 'a cafe interior, warm light' }), 'a cafe interior, warm light');
});

test('renderSeedsBlock: one line per set', () => {
  assert.equal(
    renderSeedsBlock(
      [
        ['a pier', 'rain'],
        ['an alley', 'fog'],
      ],
      labels
    ),
    'Random seeds (place; setting; detail; activity; subject; twist):\n- a pier; rain\n- an alley; fog'
  );
  assert.equal(renderSeedsBlock([], labels), '');
});

// The owner on 2026-11-16: a diary gist is kept whole; the limit of 200 is gone.
test('gistOf: one line, kept whole', () => {
  assert.equal(gistOf('short\n\npost'), 'short post');
  const long = 'alpha beta gamma delta '.repeat(40).trim();
  assert.equal(gistOf(long), long);
});

// ---- store: the diary file (data/guilds/<id>/diary.json) ----

function tmpDataDir() {
  return tempDir('nep-diary-');
}

const post = (n: Untyped) => ({
  at: n * 1000,
  kind: 'status',
  gist: `post ${n}`,
  picture: null,
  messageIds: [`m${n}`],
  search: '',
});

test('store: getDiary returns the empty default', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  assert.deepEqual(store.getDiary(), { posts: [], updatedAt: 0 });
});

test('store: appendDiaryPost keeps the newest max posts and stamps updatedAt', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  for (let n = 1; n <= 4; n += 1) store.appendDiaryPost(post(n), { max: 3, now: 5000 + n });
  const diary = store.getDiary();
  assert.deepEqual(
    diary.posts.map((p) => p.gist),
    ['post 2', 'post 3', 'post 4']
  );
  assert.equal(diary.updatedAt, 5004);
  diary.posts.length = 0; // a copy: changing it changes nothing stored
  assert.equal(store.getDiary().posts.length, 3);
});

test('store: setDiaryPosts replaces the list and keeps the newest max', () => {
  const store = createStore(memoryAt(tmpDataDir()));
  store.appendDiaryPost(post(1), { max: 10, now: 1 });
  store.setDiaryPosts([post(5), post(6), post(7)], { max: 2, now: 9 });
  const diary = store.getDiary();
  assert.deepEqual(
    diary.posts.map((p) => p.gist),
    ['post 6', 'post 7']
  );
  assert.equal(diary.updatedAt, 9);
});

test('store: diary survives flush and reload', async () => {
  const mem = await openTestMemory({ dataDir: tmpDataDir() });
  const { dataDir: dir, memoryDb } = mem;
  const store = createStore({ dataDir: dir, memoryDb, newId: () => 'one' });
  store.appendDiaryPost({ ...post(1), gist: 'Ελένη at the café' }, { max: 150, now: 42 });
  store.flush();
  await store.flushSettled({});
  assert.ok(unitFile(memoryDb, 'guilds/g1/diary.json'), 'the diary is a unit of the database');
  const again = createStore({ dataDir: dir, memoryDb });
  assert.deepEqual(again.getDiary(), {
    posts: [{ ...post(1), gist: 'Ελένη at the café', itemId: 'dy-one' }],
    updatedAt: 42,
  });
  await mem.close();
});

test('store: a malformed diary value reads as the empty default', async () => {
  const mem = await openTestMemory({ dataDir: tmpDataDir() });
  await writeUnitUpdate(mem.memoryDb, { op: 'value', owner: 'guilds/g1/diary.json', value: [1, 2] });
  assert.deepEqual(createStore({ dataDir: mem.dataDir, memoryDb: mem.memoryDb }).getDiary(), {
    posts: [],
    updatedAt: 0,
  });
  await mem.close();
});

// ---------------------------------------------------------------------------
// createDiary: the scheduler's edge, with a fake store, client and turn runner.

type Rec = Record<string, Untyped>;
// The plan the scheduler stored for root g1 in the harness's state.
const planOf = (h: { store: { state: { data: unknown } } }): Rec =>
  (loose(h.store.state.data).diary as Rec).persona as Rec;

const D_NOW = Date.UTC(2026, 9, 6, 19, 0, 0); // 19:00 UTC, before the evening slot
const SLOT = Date.UTC(2026, 9, 6, 21, 30, 0); // 18 + 0.5 * 7 h with rng 0.5

/** A diary channel of root g1 as the harness holds it; `attach: false` may not attach files, `send: false` not send. */
function diaryChannelFake({
  send = true,
  attach = true,
  placeId = 'g1',
}: { send?: boolean; attach?: boolean; placeId?: string } = {}) {
  return { send, attach, placeId };
}

/** The memory databases the harnesses opened, closed when the file is done. */
const OPENED: Array<{ close(): unknown }> = [];
after(async () => {
  for (const memory of OPENED.splice(0)) await memory.close();
});

/**
 * Stage 3 design, sections 3 and 5: the diary's place is its mirror in memory, no longer `diary.placeId`. The
 * harness's store reads a memory database holding an enabled `diary` mirror on `d1` of the fake interface (`mirror`),
 * or none; the config sets no `diary.placeId`.
 */
function diaryHarness({
  mirror = true,
  diary = {},
  data = {},
  posts = [],
  channel = diaryChannelFake(),
  outcomes = [],
  backfill = null,
}: {
  mirror?: boolean;
  diary?: Rec;
  data?: Rec;
  posts?: Array<Rec>;
  channel?: ReturnType<typeof diaryChannelFake> | null;
  outcomes?: Array<Rec>;
  backfill?: ((args: Rec) => Promise<number>) | null;
} = {}) {
  let clock = D_NOW;
  /** The turns the scheduler asked for: the arguments, and the plan's done slots when it asked. */
  const turnCalls: Array<{
    params: { mode?: unknown; chat?: unknown; placeId?: unknown; diary?: unknown };
    done: Array<number>;
  }> = [];
  const hot = {
    config: {
      bot: { timezone: 'UTC' },
      diary: { windows: [{ from: 18, to: 1, posts: [1, 1] }], quietDayChance: 0, ...diary },
    },
    prompts: { labels },
  };
  const memory = openTestMemorySync({ now: () => D_NOW });
  OPENED.push(memory);
  if (mirror) seedMirror(memory.memoryDb, { iface: 'fake', chatId: 'd1', name: 'journal', at: D_NOW });
  const store = {
    state: { data: { ...data }, markDirty() {} },
    getDiary: () => ({ posts, updatedAt: 0 }),
    // The store's read of the memory database (src/memory/store.ts#readMemory), where the mirrors are.
    // The service's handle is untyped JS; its `db` is the node:sqlite connection the read takes.
    readMemory: (read: (db: unknown) => unknown) => read(memory.memoryDb.readHandle()?.db),
  };
  // The diary channel is a chat of the fake interface (none when the test gives none).
  if (channel)
    world().channel({
      id: 'd1',
      name: 'journal',
      placeId: channel.placeId,
      permissions: { send: channel.send, attach: channel.attach },
    });
  const turns = {
    runTurn: async (params: Untyped) => {
      turnCalls.push({ params, done: [...(loose(store.state.data).diary?.persona?.done ?? [])] });
      return (
        outcomes.shift() ?? {
          outcome: 'spoke',
          diary: { kind: 'status', picture: false, search: false, messages: 1 },
        }
      );
    },
  };
  const diaryFactory = createDiary({
    hot,
    // @ts-expect-error: the stand-in store holds only the part of DiaryStore that the tick reads
    store,
    reads: world().reads,
    iface: () => 'fake',
    turns,
    isServedRoot: (id: unknown) => id === 'g1',
    backfill,
    rng: () => 0.5,
    now: () => clock,
  });
  return { hot, store, turnCalls, diary: diaryFactory, setNow: (t: Untyped) => (clock = t) };
}

// Stage 3 design, section 3 item 1: `diary.placeId` no longer gates the tick, so the case without it is gone; the
// tick with no channel and no mirror is "posts with zero mirrors" below.
test('tick: no-op when paused', async () => {
  const cases: Array<[string, Parameters<typeof diaryHarness>[0]]> = [['paused', { data: { paused: true } }]];
  for (const [reason, setup] of cases) {
    const h = diaryHarness(setup);
    h.setNow(SLOT + MINUTE_MS);
    const { logs } = await withCapturedLogs(async () => {
      await h.diary.tick();
      await h.diary.tick();
    });
    assert.equal(h.turnCalls.length, 0, reason);
    assert.equal(loose(h.store.state.data).diary, undefined, `${reason}: no plan`);
    assert.equal(
      logs.filter((l) => l.msg === 'diary: skip' && l.reason === reason).length,
      1,
      `${reason}: logged once a day`
    );
  }
});

test('tick: plans the day once and stores it in state.data.diary.persona', async () => {
  const h = diaryHarness();
  await h.diary.tick();
  const plan = planOf(h);
  assert.deepEqual(plan, {
    day: '2026-10-06',
    slots: [SLOT],
    quiet: false,
    done: [],
    posted: [],
    hunger: [0],
    quietStreak: 0,
  });
  await h.diary.tick();
  assert.equal(planOf(h), plan, 'the same plan, not planned again');
  h.setNow(D_NOW + 24 * HOUR_MS);
  await h.diary.tick();
  assert.equal(planOf(h).day, '2026-10-07', 'a new local day replans');
});

test('tick: the day key is the local date in bot.timezone', async () => {
  const h = diaryHarness();
  h.hot.config.bot.timezone = 'Europe/Athens';
  h.setNow(Date.UTC(2026, 9, 6, 22, 30, 0)); // 01:30 on the 7th in Athens
  await h.diary.tick();
  assert.equal(planOf(h).day, '2026-10-07');
});

test('tick: a new local day carries over the open slots of the last plan that spill past midnight', async () => {
  const late = Date.UTC(2026, 9, 7, 0, 30, 0);
  const missed = Date.UTC(2026, 9, 6, 21, 0, 0);
  const fired = Date.UTC(2026, 9, 6, 20, 0, 0);
  const h = diaryHarness({
    diary: { windows: [{ from: 12, to: 16, posts: [0, 0] }] },
    data: {
      diary: { persona: { day: '2026-10-06', slots: [fired, missed, late], done: [fired], quiet: false } },
    },
  });
  h.setNow(Date.UTC(2026, 9, 7, 0, 5, 0));
  await h.diary.tick();
  assert.deepEqual(planOf(h).slots, [late], 'the open slot ahead is kept; done and long-missed ones are not');
  assert.equal(planOf(h).day, '2026-10-07');
  h.setNow(late + MINUTE_MS);
  await h.diary.tick();
  assert.equal(h.turnCalls.length, 1, 'the carried slot fires');
});

test('tick: fires the due slot through runTurn with mode diary and marks it done', async () => {
  const h = diaryHarness();
  await h.diary.tick();
  assert.equal(h.turnCalls.length, 0, 'not due yet');
  h.setNow(SLOT + 5 * MINUTE_MS);
  const { logs } = await withCapturedLogs(() => h.diary.tick());
  assert.equal(h.turnCalls.length, 1);
  const { params, done } = h.turnCalls[0];
  assert.equal(params.mode, 'diary');
  // Stage 3 design, section 3 item 2: the post is the diary wake, with no chat, for the served root.
  assert.equal(params.chat, undefined);
  // The post names no chat and no place: it is the persona's.
  assert.equal('placeId' in params, false);
  assert.deepEqual(params.diary, { kind: null, forced: false });
  assert.deepEqual(done, [SLOT], 'marked before the turn ran');
  assert.ok(logs.some((l) => l.msg === 'diary: due'));
  const line = logs.find((l) => l.msg === 'diary: post');
  assert.equal(loose(line).outcome, 'spoke');
  assert.equal(loose(line).kind, 'status');
  await h.diary.tick();
  assert.equal(h.turnCalls.length, 1, 'a done slot never fires again');
});

test('tick: a set posted logs its picture count; a short set logs its refusal and is not posted', async () => {
  const posted = diaryHarness({
    outcomes: [{ outcome: 'spoke', diary: { kind: 'tour', picture: true, search: false, messages: 1, pictures: 4 } }],
  });
  posted.setNow(SLOT + MINUTE_MS);
  const first = await withCapturedLogs(() => posted.diary.tick());
  const line = first.logs.find((l) => l.msg === 'diary: post');
  assert.equal(loose(line).pictures, 4);
  assert.equal(loose(line).outcome, 'spoke');

  const short = diaryHarness({ outcomes: [{ outcome: 'refused', reason: 'set-short' }] });
  short.setNow(SLOT + MINUTE_MS);
  const second = await withCapturedLogs(() => short.diary.tick());
  const refused = second.logs.find((l) => l.msg === 'diary: post');
  assert.equal(loose(refused).outcome, 'refused');
  assert.equal(loose(refused).reason, 'set-short');
  assert.equal(loose(refused).pictures, 0);
  assert.deepEqual(planOf(short).posted, [], 'a short set feeds no window');
  assert.deepEqual(planOf(short).done, [SLOT], 'its slot is spent');
});

test('tick: a busy outcome un-marks the slot so the next tick retries it within the grace', async () => {
  const h = diaryHarness({ outcomes: [{ outcome: 'busy' }] });
  h.setNow(SLOT + MINUTE_MS);
  await h.diary.tick();
  assert.deepEqual(planOf(h).done, []);
  await h.diary.tick();
  assert.equal(h.turnCalls.length, 2);
  assert.deepEqual(planOf(h).done, [SLOT]);
});

test('tick: a scheduled post that spoke is recorded as posted, a busy one is not', async () => {
  const h = diaryHarness({ outcomes: [{ outcome: 'busy' }] });
  h.setNow(SLOT + MINUTE_MS);
  await h.diary.tick();
  assert.deepEqual(planOf(h).posted, []);
  await h.diary.tick();
  assert.deepEqual(planOf(h).posted, [SLOT]);
});

test('tick: a new day takes its hunger from the last plan and logs it', async () => {
  const fired = Date.UTC(2026, 9, 5, 20, 0, 0);
  const h = diaryHarness({
    data: {
      diary: {
        persona: {
          day: '2026-10-05',
          slots: [fired],
          done: [fired],
          posted: [],
          quiet: false,
          hunger: [1],
          quietStreak: 0,
        },
      },
    },
  });
  const { logs } = await withCapturedLogs(() => h.diary.tick());
  const plan = planOf(h);
  assert.deepEqual(plan.hunger, [2], 'the evening window went unfed');
  assert.equal(plan.quietStreak, 0);
  const line = logs.find((l) => l.msg === 'diary: plan');
  assert.deepEqual(loose(line).hunger, [2]);
  assert.equal(loose(line).quietStreak, 0);

  const quiet = diaryHarness({
    data: {
      diary: {
        persona: { day: '2026-10-05', slots: [], done: [], posted: [], quiet: true, hunger: [1], quietStreak: 1 },
      },
    },
  });
  await quiet.diary.tick();
  assert.deepEqual(planOf(quiet).hunger, [2]);
  assert.equal(planOf(quiet).quietStreak, 2);
});

test('tick: dropped slots are marked done without firing', async () => {
  const h = diaryHarness();
  await h.diary.tick();
  h.setNow(SLOT + 45 * MINUTE_MS);
  const { logs } = await withCapturedLogs(() => h.diary.tick());
  assert.equal(h.turnCalls.length, 0);
  assert.deepEqual(planOf(h).done, [SLOT]);
  assert.ok(logs.some((l) => l.msg === 'diary: skip' && l.reason === 'grace' && l.count === 1));
});

test('tick: backfills an empty history before the first post', async () => {
  const calls: Array<Untyped> = [];
  let h: ReturnType<typeof diaryHarness> | null = null as ReturnType<typeof diaryHarness> | null; // assigned later, read inside a callback
  const backfill = async (args: Untyped) => {
    calls.push({ args, turns: h?.turnCalls.length });
    return 4;
  };
  h = diaryHarness({ backfill });
  h.setNow(SLOT + MINUTE_MS);
  const { logs } = await withCapturedLogs(() => h.diary.tick());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].turns, 0, 'before the post');
  assert.equal('placeId' in calls[0].args, false);
  // Changed with the contract: the backfill gets the chat and the reads, not a channel object and her id.
  // Stage 3 design, section 5: that chat is the place of the diary's mirror.
  assert.equal(calls[0].args.chat.chatId, 'd1');
  assert.equal(calls[0].args.labels, labels);
  assert.ok(logs.some((l) => l.msg === 'diary: backfill' && l.count === 4));
  // Changed: the next day's post stands for the forced post, which is gone with diary.force.
  h.setNow(SLOT + DAY_MS + MINUTE_MS);
  await h.diary.tick();
  assert.equal(h.turnCalls.length, 2, 'the next day posted');
  assert.equal(calls.length, 1, 'once per channel and process');

  const kept = [];
  const full = diaryHarness({
    posts: [{ at: 1, kind: 'status', gist: 'x' }],
    backfill: async (args: Untyped) => kept.push(args),
  });
  full.setNow(SLOT + MINUTE_MS);
  await full.diary.tick();
  assert.equal(kept.length, 0, 'a history already there is not backfilled');
});

// Stage 3 design, sections 3 and 5: the entry is recorded first and the mirror's capability is read only when it is
// published, so a mirror place she cannot send or attach in no longer refuses the post.
test('tick: a mirror place she cannot send or attach in does not refuse the post', async () => {
  for (const channel of [diaryChannelFake({ attach: false }), diaryChannelFake({ send: false })]) {
    const h = diaryHarness({ channel });
    h.setNow(SLOT + MINUTE_MS);
    const { logs } = await withCapturedLogs(() => h.diary.tick());
    assert.equal(h.turnCalls.length, 1);
    assert.ok(!logs.some((l) => l.msg === 'diary: skip' && l.reason === 'not-writable'));
  }
});

// Stage 3 design, section 3 item 6 ("zero mirrors"): with no mirror and no channel the due post still runs; the entry
// exists in memory and nothing is sent.
test('tick: posts with zero mirrors and no channel', async () => {
  const h = diaryHarness({ channel: null, mirror: false });
  h.setNow(SLOT + MINUTE_MS);
  const { logs } = await withCapturedLogs(() => h.diary.tick());
  assert.equal(h.turnCalls.length, 1);
  assert.ok(!logs.some((l) => l.msg === 'diary: skip' && l.reason === 'no-channel'));
});

test('stop: no tick after stop', async () => {
  const h = diaryHarness();
  h.setNow(SLOT + MINUTE_MS);
  h.diary.stop();
  await h.diary.tick();
  assert.equal(h.turnCalls.length, 0);
  assert.equal(loose(h.store.state.data).diary, undefined);
});

// PR 7d: the daily counts of posts and pictures went with the caps.
test('status: the channel, the day plan and the history size', async () => {
  const h = diaryHarness({ posts: [{}, {}] });
  await h.diary.tick();
  // Stage 3 design, section 5: `placeId` is the chat of the diary's first mirror.
  assert.deepEqual(h.diary.status(), {
    placeId: 'd1',
    day: '2026-10-06',
    slots: [SLOT],
    done: [],
    quiet: false,
    hunger: [0],
    quietStreak: 0,
    history: 2,
    // The status also names the newest slot that spoke, for `service diary status`.
    lastPosted: null,
  });
});
