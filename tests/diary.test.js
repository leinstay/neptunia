// Tests for src/behavior/diary.js (the diary scheduler's pure core: the day
// plan, due slots, kind choice, plan validation, the <diary> / <kinds> /
// <seeds> renderings, URL stripping, gists), the store's diary file and the
// scheduler's factory (createDiary) over fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  DEFAULT_PICTURE_KINDS,
  validatePlan,
  renderDiaryBlock,
  renderKindsBlock,
  parseSeedFamilies,
  pickSeeds,
  renderSeedsBlock,
  stripUrls,
  gistOf,
  createDiary,
} from '../src/behavior/diary.js';
import { PermissionFlagsBits } from 'discord.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { fill, localHour } from '../src/discord/format.js';
import { MINUTE_MS, HOUR_MS } from '../src/time.js';
import { labels } from './fixtures/labels.js';
import { createStore } from '../src/memory/store.js';

const seq = (values) => {
  let i = 0;
  return () => values[i++ % values.length];
};

const base = { quietDayChance: 0, minGapMinutes: 0, maxPerDay: 10 };

test('localDayKey: the local date of the zone, not the UTC one', () => {
  const t = Date.parse('2026-03-10T23:30:00Z');
  assert.equal(localDayKey(t, 'UTC'), '2026-03-10');
  assert.equal(localDayKey(t, 'Europe/Athens'), '2026-03-11');
});

test('planDay: a window crossing midnight stays inside it in Europe/Athens', () => {
  const nowMs = Date.parse('2026-03-10T05:00:00Z');
  const cfg = { ...base, windows: [{ from: 18, to: 1, posts: [2, 2] }] };
  for (const values of [[0.5, 0.5, 0, 0.999], [0.5, 0.5, 0.95, 0.99], [0.5, 0.5, 0.1, 0.6]]) {
    const plan = planDay(cfg, nowMs, 'Europe/Athens', seq(values));
    assert.equal(plan.day, '2026-03-10');
    assert.equal(plan.quiet, false);
    assert.deepEqual(plan.done, []);
    assert.equal(plan.slots.length, 2);
    for (const slot of plan.slots) {
      const hour = localHour(slot, 'Europe/Athens');
      assert.ok(hour >= 18 || hour < 1, `local hour ${hour}`);
      if (hour >= 18) assert.equal(localDayKey(slot, 'Europe/Athens'), '2026-03-10');
      else assert.equal(localDayKey(slot, 'Europe/Athens'), '2026-03-11');
    }
    assert.ok(plan.slots[0] <= plan.slots[1]);
  }
});

test('planDay: posts count is drawn per window and capped by maxPerDay', () => {
  const cfg = {
    ...base,
    maxPerDay: 2,
    windows: [
      { from: 7, to: 9, posts: [1, 1] },
      { from: 12, to: 14, posts: [1, 1] },
      { from: 18, to: 20, posts: [1, 1] },
    ],
  };
  const plan = planDay(cfg, Date.parse('2026-03-10T05:00:00Z'), 'UTC', seq([0.5]));
  assert.equal(plan.slots.length, 2);
});

test('planDay: slots over maxPerDay are dropped at random, not the latest', () => {
  const cfg = {
    ...base,
    maxPerDay: 2,
    windows: [
      { from: 7, to: 9, posts: [1, 1] },
      { from: 12, to: 14, posts: [1, 1] },
      { from: 18, to: 20, posts: [1, 1] },
    ],
  };
  // quiet roll, then count + placement per window (all mid-window), then the drop roll picks index 0
  const plan = planDay(cfg, Date.parse('2026-03-10T05:00:00Z'), 'UTC', seq([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.1]));
  assert.deepEqual(plan.slots, [Date.parse('2026-03-10T13:00:00Z'), Date.parse('2026-03-10T19:00:00Z')]);
});

test('planDay: the count is drawn inside the window range', () => {
  const cfg = { ...base, windows: [{ from: 12, to: 16, posts: [0, 2] }] };
  const nowMs = Date.parse('2026-03-10T05:00:00Z');
  assert.equal(planDay(cfg, nowMs, 'UTC', seq([0.5, 0, 0.5])).slots.length, 0);
  assert.equal(planDay(cfg, nowMs, 'UTC', seq([0.5, 0.99, 0.2, 0.8])).slots.length, 2);
});

test('planDay: minGapMinutes drops a slot too close to another', () => {
  const cfg = { ...base, minGapMinutes: 90, windows: [{ from: 12, to: 16, posts: [2, 2] }] };
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
  const cfg = { ...base, windows: [{ from: 7, to: 11, posts: [0, 0] }, { from: 12, to: 16, posts: [0, 0] }] };
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

const counted = (values) => {
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
  const cfg = { ...base, quietDayChance: 0.4, quietCarry: 0.5, hungerBoost: 0.5, windows: [{ from: 12, to: 16, posts: [1, 1] }] };
  const first = planDay(cfg, H_NOW, 'UTC', seq([0.3, 0.5, 0.5]), { hunger: [2], quietStreak: 0 });
  assert.equal(first.quiet, true, '0.3 < 0.4');
  assert.deepEqual(first.hunger, [2]);
  assert.equal(first.quietStreak, 0);
  assert.deepEqual(first.posted, []);
  const second = planDay(cfg, H_NOW, 'UTC', seq([0.3, 0.5, 0.5]), { hunger: [2], quietStreak: 1 });
  assert.equal(second.quiet, false, '0.3 >= 0.4 * 0.5');
  assert.equal(second.quietStreak, 1);
  assert.deepEqual(second.posted, []);
  assert.equal(planDay(cfg, H_NOW, 'UTC', seq([0.15, 0.5, 0.5]), { quietStreak: 1 }).quiet, true, '0.15 < 0.2');
  assert.equal(planDay(cfg, H_NOW, 'UTC', seq([0.15, 0.5, 0.5]), { quietStreak: 2 }).quiet, false, '0.15 >= 0.1');
  const flat = { ...cfg, quietCarry: 1 };
  assert.equal(planDay(flat, H_NOW, 'UTC', seq([0.3, 0.5, 0.5]), { quietStreak: 3 }).quiet, true, 'quietCarry 1 keeps the chance');
});

test('planDay: a hungry window redraws an empty count, at most once per hunger point', () => {
  const cfg = { ...base, hungerBoost: 0.5, quietCarry: 0.5, windows: [{ from: 12, to: 16, posts: [0, 1] }] };
  // quiet roll, count 0, then (boost roll, redraw) pairs: 0.7 >= 0.5 redraws to 0, then to 1; placement mid-window
  const values = [0.9, 0.1, 0.7, 0.2, 0.7, 0.8, 0.5];
  assert.deepEqual(planDay(cfg, H_NOW, 'UTC', seq(values), { hunger: [2] }).slots, [Date.parse('2026-03-10T14:00:00Z')]);
  assert.deepEqual(planDay(cfg, H_NOW, 'UTC', seq(values), { hunger: [1] }).slots, [], 'one hunger point, one redraw');
  assert.deepEqual(planDay(cfg, H_NOW, 'UTC', seq(values), { hunger: [0] }).slots, [], 'no hunger, no redraw');
  // a boost roll under hungerBoost keeps the zero
  assert.deepEqual(planDay(cfg, H_NOW, 'UTC', seq([0.9, 0.1, 0.3, 0.3, 0.3]), { hunger: [3] }).slots, []);
});

test('planDay: hungerBoost 1 makes hunger change nothing', () => {
  const cfg = { ...base, hungerBoost: 1, quietCarry: 0.5, windows: [{ from: 12, to: 16, posts: [0, 1] }] };
  const values = [0.9, 0.1, 0.7, 0.8, 0.5];
  assert.deepEqual(planDay(cfg, H_NOW, 'UTC', seq(values), { hunger: [5] }).slots, []);
  assert.deepEqual(planDay(cfg, H_NOW, 'UTC', seq(values), { hunger: [0] }).slots, []);
});

test('planDay: a [0, 0] window never redraws and adds no deficit', () => {
  const cfg = {
    ...base,
    hungerBoost: 0.5,
    quietCarry: 0.5,
    windows: [{ from: 7, to: 11, posts: [0, 0] }, { from: 12, to: 16, posts: [0, 1] }],
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
    hungerBoost: 0.5,
    quietCarry: 0.5,
    windows: [{ from: 7, to: 11, posts: [0, 1] }, { from: 12, to: 16, posts: [0, 1] }],
  };
  // quiet roll, morning count 0 (deficit 1), day count 0, boost roll 0.7 redraws to 1, placement mid-window
  const plan = planDay(cfg, H_NOW, 'UTC', seq([0.9, 0.1, 0.1, 0.7, 0.8, 0.5]), { hunger: [0, 0] });
  assert.deepEqual(plan.slots, [Date.parse('2026-03-10T14:00:00Z')]);
  const alone = { ...cfg, windows: [cfg.windows[1]] };
  assert.deepEqual(planDay(alone, H_NOW, 'UTC', seq([0.9, 0.1, 0.7, 0.8, 0.5]), { hunger: [0] }).slots, [], 'without the empty morning, no redraw');
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
  const previous = { day: '2026-03-10', slots: [], quiet: true, done: [], posted: [], hunger: [1, 0, 2], quietStreak: 1 };
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
  assert.deepEqual(nextHunger(missed, H_WINDOWS, 'UTC', nowMs, 30).hunger, [0, 2, 5], 'a wrap slot dropped unfired does not feed');
  const late = Date.parse('2026-03-11T01:30:00Z');
  assert.deepEqual(nextHunger(previous, H_WINDOWS, 'UTC', late, 30).hunger, [0, 2, 5], 'a wrap slot past the grace does not feed');
});

test('nextHunger: a slot outside every window feeds none', () => {
  const stray = Date.parse('2026-03-10T17:00:00Z');
  const previous = { day: '2026-03-10', slots: [stray], done: [stray], posted: [stray], quiet: false, hunger: [0, 0, 0], quietStreak: 0 };
  assert.deepEqual(nextHunger(previous, H_WINDOWS, 'UTC', Date.parse('2026-03-11T02:00:00Z'), 30).hunger, [1, 1, 1]);
});

test('nextHunger: a [0, 0] window or a malformed one stays at zero', () => {
  const windows = [{ from: 7, to: 11, posts: [0, 0] }, { from: 30, to: 2, posts: [0, 1] }, { from: 12, to: 16, posts: [0, 1] }];
  const previous = { day: '2026-03-10', slots: [], done: [], posted: [], quiet: false, hunger: [4, 4, 4], quietStreak: 0 };
  const nowMs = Date.parse('2026-03-11T02:00:00Z');
  assert.deepEqual(nextHunger(previous, windows, 'UTC', nowMs, 30).hunger, [0, 0, 5]);
  assert.deepEqual(nextHunger({ ...previous, quiet: true }, windows, 'UTC', nowMs, 30).hunger, [0, 0, 5]);
});

test('nextHunger: a changed windows list pads with zero or trims', () => {
  const previous = { day: '2026-03-10', slots: [], quiet: true, done: [], posted: [], hunger: [3, 1, 4], quietStreak: 0 };
  const nowMs = Date.parse('2026-03-11T02:00:00Z');
  assert.deepEqual(nextHunger(previous, H_WINDOWS.slice(0, 2), 'UTC', nowMs, 30).hunger, [4, 2]);
  const more = [...H_WINDOWS, { from: 1, to: 5, posts: [0, 1] }];
  assert.deepEqual(nextHunger(previous, more, 'UTC', nowMs, 30).hunger, [4, 2, 5, 1]);
});

test('nextHunger: a stored plan from before hunger starts at zero', () => {
  const slot = Date.parse('2026-03-10T13:00:00Z');
  const previous = { day: '2026-03-10', slots: [slot], done: [slot], quiet: false };
  assert.deepEqual(nextHunger(previous, H_WINDOWS, 'UTC', Date.parse('2026-03-11T02:00:00Z'), 30), { hunger: [0, 0, 0], quietStreak: 0 });
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
  assert.equal(pickKind(kinds, () => 0.1), 'b');
  assert.equal(pickKind(kinds, () => 0.9), 'd');
});

test('pickKind: null when all weights are zero', () => {
  assert.equal(pickKind({ a: 0, b: 0 }, () => 0.5), null);
  assert.equal(pickKind({}, () => 0.5), null);
  assert.equal(pickKind(null, () => 0.5), null);
});

test('withoutPictureKinds: drops the picture kinds, keeps the others with their weights', () => {
  const kinds = { selfPicture: 2, status: 1, meme: 3, news: 0 };
  assert.deepEqual(withoutPictureKinds(kinds, ['selfPicture', 'meme']), { status: 1, news: 0 });
  assert.deepEqual(kinds, { selfPicture: 2, status: 1, meme: 3, news: 0 }, 'the input is not changed');
});

test('withoutPictureKinds: the default picture kinds when diary.pictureKinds is not a list', () => {
  const kinds = { selfPicture: 1, picture: 1, meme: 1, status: 2 };
  assert.deepEqual(withoutPictureKinds(kinds, undefined), { status: 2 });
  assert.deepEqual(DEFAULT_PICTURE_KINDS, ['selfPicture', 'picture', 'meme', 'photoset', 'randomSet']);
  assert.deepEqual(withoutPictureKinds(null, ['meme']), {});
});

test('withoutPictureKinds: nothing weighted left makes pickKind return null', () => {
  assert.equal(pickKind(withoutPictureKinds({ selfPicture: 2 }, ['selfPicture']), () => 0.5), null);
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
  const plan = validatePlan({ kind: 'news', brief: 'a find about trains', search: 'night trains', picture: false }, kinds, opts, () => 0.5);
  assert.deepEqual(plan, { kind: 'news', brief: 'a find about trains', search: 'night trains', picture: false, fallback: false });
  const drawn = validatePlan({ kind: 'selfPicture', brief: 'Ελένη on a pier', picture: true }, kinds, opts, () => 0.5);
  assert.deepEqual(drawn, { kind: 'selfPicture', brief: 'Ελένη on a pier', search: '', picture: true, fallback: false });
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
  const plan = validatePlan({ kind: 'nope', picture: true }, kinds, { ...opts, pictureKinds: ['selfPicture'] }, () => 0.99);
  assert.equal(plan.kind, 'news');
  assert.equal(plan.fallback, true);
  assert.equal(plan.picture, false);
});

test('validatePlan: a picture kind always draws when allowed', () => {
  for (const picture of [false, undefined, 'no']) {
    const plan = validatePlan({ kind: 'selfPicture', brief: 'b', picture }, kinds, { ...opts, pictureKinds: ['selfPicture'] }, () => 0.5);
    assert.equal(plan.picture, true);
    assert.equal(plan.fallback, false);
  }
  const capped = validatePlan({ kind: 'selfPicture', brief: 'b', picture: false }, kinds, { ...opts, pictureAllowed: false, pictureKinds: ['selfPicture'] }, () => 0.5);
  assert.equal(capped.picture, false);
  const text = validatePlan({ kind: 'thought', brief: 'b', picture: true }, kinds, { ...opts, pictureKinds: ['selfPicture'] }, () => 0.5);
  assert.equal(text.picture, true);
  const quiet = validatePlan({ kind: 'thought', brief: 'b', picture: false }, kinds, { ...opts, pictureKinds: ['selfPicture'] }, () => 0.5);
  assert.equal(quiet.picture, false);
});

test('validatePlan: search is cleared for a kind outside searchKinds', () => {
  const plan = validatePlan({ kind: 'thought', brief: 'b', search: 'q', picture: false }, kinds, opts, () => 0.5);
  assert.equal(plan.search, '');
  assert.equal(plan.fallback, false);
});

test('validatePlan: picture forced false when not allowed', () => {
  const plan = validatePlan({ kind: 'selfPicture', brief: 'b', picture: true }, kinds, { ...opts, pictureAllowed: false }, () => 0.5);
  assert.equal(plan.picture, false);
  assert.equal(validatePlan({ kind: 'thought', picture: 'yes' }, kinds, opts, () => 0.5).picture, false);
});

test('validatePlan: a long brief is cut to one line', () => {
  const plan = validatePlan({ kind: 'thought', brief: `line one\nline two ${'word '.repeat(100)}` }, kinds, opts, () => 0.5);
  assert.ok(!plan.brief.includes('\n'));
  assert.ok([...plan.brief].length <= 300);
});

test('renderDiaryBlock: oldest first, at most max lines, picture suffix when present', () => {
  const posts = [
    { at: Date.parse('2026-03-01T10:00:00Z'), kind: 'status', gist: 'oldest', picture: null },
    { at: Date.parse('2026-03-02T10:00:00Z'), kind: null, gist: 'from the backfill', picture: true },
    { at: Date.parse('2026-03-03T22:30:00Z'), kind: 'selfPicture', gist: 'on the pier', picture: 'a pier at dusk' },
    { at: Date.parse('2026-03-04T10:00:00Z'), kind: 'thought', gist: 'café thoughts', picture: null },
  ];
  const text = renderDiaryBlock(posts, labels, { timezone: 'Europe/Athens', max: 3 });
  assert.equal(text, [
    'Your latest diary posts, oldest first:',
    '- 2026-03-02 post: from the backfill [picture: not recorded]',
    '- 2026-03-04 selfPicture: on the pier [picture: a pier at dusk]',
    '- 2026-03-04 thought: café thoughts',
  ].join('\n'));
  assert.equal(renderDiaryBlock([], labels, { timezone: 'UTC', max: 3 }), '');
});

test('renderDiaryBlock: a set renders its first scene with the picture count', () => {
  const posts = [
    { at: Date.parse('2026-03-01T10:00:00Z'), kind: 'tour', gist: 'a walk', picture: 'a harbour at noon', pictures: 5 },
    { at: Date.parse('2026-03-02T10:00:00Z'), kind: 'selfPicture', gist: 'alone', picture: 'a pier', pictures: 1 },
  ];
  const text = renderDiaryBlock(posts, labels, { timezone: 'UTC', max: 5 });
  const lines = text.split('\n');
  assert.ok(labels.diary.pictureSet, 'the fixture carries the label');
  assert.equal(lines[1], `- 2026-03-01 tour: a walk${fill(labels.diary.pictureSet, { count: 5, scene: 'a harbour at noon' })}`);
  assert.equal(lines[2], '- 2026-03-02 selfPicture: alone [picture: a pier]', 'one picture keeps the plain suffix');
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
  assert.deepEqual(setSettings({ set: { pictures: 'x', minPosted: -1, seedSets: null, maxMessageBytes: 0 } }), fallback);
  assert.deepEqual(setSettings({ set: { pictures: [5, 2] } }).pictures, [5, 5], 'max never below min');
});

test('renderKindsBlock: counts uses among the last window posts', () => {
  const posts = [{ kind: 'thought' }, { kind: 'thought' }, { kind: 'news' }, { kind: 'thought' }, { kind: null }];
  const text = renderKindsBlock({ thought: 2, news: 1, meme: 0 }, posts, labels, { window: 3 });
  assert.equal(text, [
    'Post kinds and their recent use:',
    'thought weight 2, used 1 of the last 3',
    'news weight 1, used 1 of the last 3',
  ].join('\n'));
  assert.equal(
    renderKindsBlock({ thought: 2 }, [], labels, { window: 150 }),
    'Post kinds and their recent use:\nthought weight 2, used 0 of the last 0',
  );
  assert.equal(renderKindsBlock({ meme: 0 }, posts, labels, { window: 3 }), '');
});

test('parseSeedFamilies: splits by # headers and ignores blanks', () => {
  const text = 'loose line\n\n# place\na pier\n\n  an alley  \n# mood\n\n# twist\nrain\n';
  assert.deepEqual(parseSeedFamilies(text), { seed: ['loose line'], place: ['a pier', 'an alley'], mood: [], twist: ['rain'] });
  assert.deepEqual(parseSeedFamilies(''), {});
  assert.deepEqual(parseSeedFamilies(null), {});
});

test('pickSeeds: one line per family per set, in header order', () => {
  const families = { place: ['a pier', 'an alley'], twist: ['rain', 'fog', 'snow'] };
  assert.deepEqual(pickSeeds(families, 2, seq([0, 0.99, 0.6, 0.1])), [['a pier', 'snow'], ['an alley', 'rain']]);
});

test('pickSeeds: empty families are skipped', () => {
  assert.deepEqual(pickSeeds({ place: [], twist: ['rain'] }, 1, () => 0.5), [['rain']]);
  assert.deepEqual(pickSeeds({ place: [] }, 2, () => 0.5), []);
  assert.deepEqual(pickSeeds({ place: ['a pier'] }, 0, () => 0.5), []);
});

test('renderSeedsBlock: one line per set', () => {
  assert.equal(
    renderSeedsBlock([['a pier', 'rain'], ['an alley', 'fog']], labels),
    'Random seeds (place; setting; detail; activity; subject; twist):\n- a pier; rain\n- an alley; fog',
  );
  assert.equal(renderSeedsBlock([], labels), '');
});

test('stripUrls: removes links and keeps the words around them', () => {
  assert.equal(stripUrls('see https://a.b/c now'), 'see now');
  assert.equal(stripUrls('http://x.y at the start'), 'at the start');
  assert.equal(stripUrls('line one <https://a.b>\nline two'), 'line one\nline two');
  assert.equal(stripUrls('no links, señor'), 'no links, señor');
});

test('gistOf: one line cut at a word boundary', () => {
  assert.equal(gistOf('short\n\npost', 200), 'short post');
  const gist = gistOf('alpha beta gamma delta', 13);
  assert.equal(gist, 'alpha beta');
});

// ---- store: the diary file (data/guilds/<id>/diary.json) ----

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nep-diary-'));
}

const post = (n) => ({ at: n * 1000, kind: 'status', gist: `post ${n}`, picture: null, messageIds: [`m${n}`], search: '' });

test('store: getDiary returns the empty default', () => {
  const store = createStore({ dataDir: tmpDataDir() });
  assert.deepEqual(store.getDiary('g1'), { posts: [], updatedAt: 0 });
});

test('store: appendDiaryPost keeps the newest max posts and stamps updatedAt', () => {
  const store = createStore({ dataDir: tmpDataDir() });
  for (let n = 1; n <= 4; n += 1) store.appendDiaryPost('g1', post(n), { max: 3, now: 5000 + n });
  const diary = store.getDiary('g1');
  assert.deepEqual(diary.posts.map((p) => p.gist), ['post 2', 'post 3', 'post 4']);
  assert.equal(diary.updatedAt, 5004);
  diary.posts.length = 0; // a copy: changing it changes nothing stored
  assert.equal(store.getDiary('g1').posts.length, 3);
});

test('store: setDiaryPosts replaces the list and keeps the newest max', () => {
  const store = createStore({ dataDir: tmpDataDir() });
  store.appendDiaryPost('g1', post(1), { max: 10, now: 1 });
  store.setDiaryPosts('g1', [post(5), post(6), post(7)], { max: 2, now: 9 });
  const diary = store.getDiary('g1');
  assert.deepEqual(diary.posts.map((p) => p.gist), ['post 6', 'post 7']);
  assert.equal(diary.updatedAt, 9);
});

test('store: diary survives flush and reload', () => {
  const dir = tmpDataDir();
  const store = createStore({ dataDir: dir, newId: () => 'one' });
  store.appendDiaryPost('g1', { ...post(1), gist: 'Ελένη at the café' }, { max: 150, now: 42 });
  store.flush();
  assert.ok(fs.existsSync(path.join(dir, 'guilds', 'g1', 'diary.json')));
  const again = createStore({ dataDir: dir });
  assert.deepEqual(again.getDiary('g1'), { posts: [{ ...post(1), gist: 'Ελένη at the café', itemId: 'dy-one' }], updatedAt: 42 });
});

test('store: a malformed diary file reads as the empty default', () => {
  const dir = tmpDataDir();
  fs.mkdirSync(path.join(dir, 'guilds', 'g1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'guilds', 'g1', 'diary.json'), '[1, 2]');
  assert.deepEqual(createStore({ dataDir: dir }).getDiary('g1'), { posts: [], updatedAt: 0 });
});

// ---------------------------------------------------------------------------
// createDiary: the scheduler's edge, with a fake store, client and turn runner.

const D_NOW = Date.UTC(2026, 9, 6, 19, 0, 0); // 19:00 UTC, before the evening slot
const SLOT = Date.UTC(2026, 9, 6, 21, 30, 0); // 18 + 0.5 * 7 h with rng 0.5

/** A diary channel of guild g1; `attach: false` lacks Attach Files, `send: false` Send Messages. */
function diaryChannelFake({ send = true, attach = true, guildId = 'g1' } = {}) {
  return {
    id: 'd1',
    name: 'journal',
    viewable: true,
    guild: { id: guildId, members: { me: { id: 'self' } } },
    permissionsFor: () => ({
      has: (flag) => (flag === PermissionFlagsBits.AttachFiles ? attach : flag === PermissionFlagsBits.SendMessages ? send : true),
    }),
  };
}

function diaryHarness({ diary = {}, features = {}, data = {}, posts = [], channel = diaryChannelFake(), outcomes = [], backfill = null, warming = false, turnsExtra = {}, delay } = {}) {
  let clock = D_NOW;
  const turnCalls = [];
  const hot = {
    config: {
      bot: { timezone: 'UTC' },
      features: { diary: true, ...features },
      diary: {
        channelId: 'd1',
        windows: [{ from: 18, to: 1, posts: [1, 1] }],
        quietDayChance: 0,
        minGapMinutes: 0,
        maxPerDay: 3,
        slotGraceMinutes: 30,
        ...diary,
      },
    },
    prompts: { labels },
  };
  const store = {
    state: { data: { ...data }, markDirty() {} },
    getDiary: () => ({ posts, updatedAt: 0 }),
  };
  const client = {
    user: { id: 'self' },
    channels: {
      cache: new Map(channel ? [[channel.id, channel]] : []),
      fetch: async () => {
        throw new Error('unknown channel');
      },
    },
  };
  const turns = {
    runTurn: async (params) => {
      turnCalls.push({ params, done: [...(store.state.data.diary?.g1?.done ?? [])] });
      return outcomes.shift() ?? { outcome: 'spoke', diary: { kind: 'status', picture: false, search: false, messages: 1 } };
    },
    ...turnsExtra,
  };
  const diaryFactory = createDiary({
    hot,
    store,
    client,
    turns,
    getGuildId: () => 'g1',
    isWarmingUp: () => warming,
    backfill,
    rng: () => 0.5,
    now: () => clock,
    ...(delay ? { delay } : {}),
  });
  return { hot, store, turnCalls, diary: diaryFactory, setNow: (t) => (clock = t) };
}

test('tick: no-op without a channel id, with features.diary false, when paused or warming up', async () => {
  const cases = [
    ['no-channel', { diary: { channelId: '' } }],
    ['off', { features: { diary: false } }],
    ['paused', { data: { paused: true } }],
    ['warmup', { warming: true }],
  ];
  for (const [reason, setup] of cases) {
    const h = diaryHarness(setup);
    h.setNow(SLOT + MINUTE_MS);
    const { logs } = await withCapturedLogs(async () => {
      await h.diary.tick();
      await h.diary.tick();
    });
    assert.equal(h.turnCalls.length, 0, reason);
    assert.equal(h.store.state.data.diary, undefined, `${reason}: no plan`);
    assert.equal(logs.filter((l) => l.msg === 'diary: skip' && l.reason === reason).length, 1, `${reason}: logged once a day`);
  }
});

test('tick: plans the day once and stores it in state.data.diary[guildId]', async () => {
  const h = diaryHarness();
  await h.diary.tick();
  const plan = h.store.state.data.diary.g1;
  assert.deepEqual(plan, { day: '2026-10-06', slots: [SLOT], quiet: false, done: [], posted: [], hunger: [0], quietStreak: 0 });
  await h.diary.tick();
  assert.equal(h.store.state.data.diary.g1, plan, 'the same plan, not planned again');
  h.setNow(D_NOW + 24 * HOUR_MS);
  await h.diary.tick();
  assert.equal(h.store.state.data.diary.g1.day, '2026-10-07', 'a new local day replans');
});

test('tick: the day key is the local date in bot.timezone', async () => {
  const h = diaryHarness();
  h.hot.config.bot.timezone = 'Europe/Athens';
  h.setNow(Date.UTC(2026, 9, 6, 22, 30, 0)); // 01:30 on the 7th in Athens
  await h.diary.tick();
  assert.equal(h.store.state.data.diary.g1.day, '2026-10-07');
});

test('tick: a new local day carries over the open slots of the last plan that spill past midnight', async () => {
  const late = Date.UTC(2026, 9, 7, 0, 30, 0);
  const missed = Date.UTC(2026, 9, 6, 21, 0, 0);
  const fired = Date.UTC(2026, 9, 6, 20, 0, 0);
  const h = diaryHarness({
    diary: { windows: [{ from: 12, to: 16, posts: [0, 0] }] },
    data: { diary: { g1: { day: '2026-10-06', slots: [fired, missed, late], done: [fired], quiet: false } } },
  });
  h.setNow(Date.UTC(2026, 9, 7, 0, 5, 0));
  await h.diary.tick();
  assert.deepEqual(h.store.state.data.diary.g1.slots, [late], 'the open slot ahead is kept; done and long-missed ones are not');
  assert.equal(h.store.state.data.diary.g1.day, '2026-10-07');
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
  assert.equal(params.channel.id, 'd1');
  assert.deepEqual(params.diary, { kind: null, forced: false });
  assert.deepEqual(done, [SLOT], 'marked before the turn ran');
  assert.ok(logs.some((l) => l.msg === 'diary: due'));
  const line = logs.find((l) => l.msg === 'diary: post');
  assert.equal(line.outcome, 'spoke');
  assert.equal(line.kind, 'status');
  await h.diary.tick();
  assert.equal(h.turnCalls.length, 1, 'a done slot never fires again');
});

test('tick: a set posted logs its picture count; a short set logs its refusal and is not posted', async () => {
  const posted = diaryHarness({ outcomes: [{ outcome: 'spoke', diary: { kind: 'tour', picture: true, search: false, messages: 1, pictures: 4 } }] });
  posted.setNow(SLOT + MINUTE_MS);
  const first = await withCapturedLogs(() => posted.diary.tick());
  const line = first.logs.find((l) => l.msg === 'diary: post');
  assert.equal(line.pictures, 4);
  assert.equal(line.outcome, 'spoke');

  const short = diaryHarness({ outcomes: [{ outcome: 'refused', reason: 'set-short' }] });
  short.setNow(SLOT + MINUTE_MS);
  const second = await withCapturedLogs(() => short.diary.tick());
  const refused = second.logs.find((l) => l.msg === 'diary: post');
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.reason, 'set-short');
  assert.equal(refused.pictures, 0);
  assert.deepEqual(short.store.state.data.diary.g1.posted, [], 'a short set feeds no window');
  assert.deepEqual(short.store.state.data.diary.g1.done, [SLOT], 'its slot is spent');
});

test('tick: a busy outcome un-marks the slot so the next tick retries it within the grace', async () => {
  const h = diaryHarness({ outcomes: [{ outcome: 'busy' }] });
  h.setNow(SLOT + MINUTE_MS);
  await h.diary.tick();
  assert.deepEqual(h.store.state.data.diary.g1.done, []);
  await h.diary.tick();
  assert.equal(h.turnCalls.length, 2);
  assert.deepEqual(h.store.state.data.diary.g1.done, [SLOT]);
});

test('tick: a scheduled post that spoke is recorded as posted, a busy one is not', async () => {
  const h = diaryHarness({ outcomes: [{ outcome: 'busy' }] });
  h.setNow(SLOT + MINUTE_MS);
  await h.diary.tick();
  assert.deepEqual(h.store.state.data.diary.g1.posted, []);
  await h.diary.tick();
  assert.deepEqual(h.store.state.data.diary.g1.posted, [SLOT]);
});

test('force: a manual post never feeds the hunger', async () => {
  const h = diaryHarness();
  await h.diary.tick();
  const result = await h.diary.force({ kind: 'meme' });
  assert.equal(result.outcome, 'spoke');
  assert.deepEqual(h.store.state.data.diary.g1.posted, []);
});

test('tick: a new day takes its hunger from the last plan and logs it', async () => {
  const fired = Date.UTC(2026, 9, 5, 20, 0, 0);
  const h = diaryHarness({
    diary: { quietCarry: 0.5, hungerBoost: 0.5 },
    data: { diary: { g1: { day: '2026-10-05', slots: [fired], done: [fired], posted: [], quiet: false, hunger: [1], quietStreak: 0 } } },
  });
  const { logs } = await withCapturedLogs(() => h.diary.tick());
  const plan = h.store.state.data.diary.g1;
  assert.deepEqual(plan.hunger, [2], 'the evening window went unfed');
  assert.equal(plan.quietStreak, 0);
  const line = logs.find((l) => l.msg === 'diary: plan');
  assert.deepEqual(line.hunger, [2]);
  assert.equal(line.quietStreak, 0);

  const quiet = diaryHarness({
    diary: { quietCarry: 0.5, hungerBoost: 0.5 },
    data: { diary: { g1: { day: '2026-10-05', slots: [], done: [], posted: [], quiet: true, hunger: [1], quietStreak: 1 } } },
  });
  await quiet.diary.tick();
  assert.deepEqual(quiet.store.state.data.diary.g1.hunger, [2]);
  assert.equal(quiet.store.state.data.diary.g1.quietStreak, 2);
});

test('tick: dropped slots are marked done without firing', async () => {
  const h = diaryHarness();
  await h.diary.tick();
  h.setNow(SLOT + 45 * MINUTE_MS);
  const { logs } = await withCapturedLogs(() => h.diary.tick());
  assert.equal(h.turnCalls.length, 0);
  assert.deepEqual(h.store.state.data.diary.g1.done, [SLOT]);
  assert.ok(logs.some((l) => l.msg === 'diary: skip' && l.reason === 'grace' && l.count === 1));
});

test('tick: backfills an empty history before the first post', async () => {
  const calls = [];
  let h = null;
  const backfill = async (args) => {
    calls.push({ args, turns: h.turnCalls.length });
    return 4;
  };
  h = diaryHarness({ backfill });
  h.setNow(SLOT + MINUTE_MS);
  const { logs } = await withCapturedLogs(() => h.diary.tick());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].turns, 0, 'before the post');
  assert.equal(calls[0].args.guildId, 'g1');
  assert.equal(calls[0].args.channel.id, 'd1');
  assert.equal(calls[0].args.selfId, 'self');
  assert.equal(calls[0].args.labels, labels);
  assert.ok(logs.some((l) => l.msg === 'diary: backfill' && l.count === 4));
  await h.diary.force({});
  assert.equal(calls.length, 1, 'once per channel and process');

  const kept = [];
  const full = diaryHarness({ posts: [{ at: 1, kind: 'status', gist: 'x' }], backfill: async (args) => kept.push(args) });
  full.setNow(SLOT + MINUTE_MS);
  await full.diary.tick();
  assert.equal(kept.length, 0, 'a history already there is not backfilled');
});

test('tick: refuses when the daily post cap is reached', async () => {
  const h = diaryHarness({ diary: { maxPerDay: 2 }, data: { diaryDay: '2026-10-06', diaryPosts: 2 } });
  h.setNow(SLOT + MINUTE_MS);
  const { logs } = await withCapturedLogs(() => h.diary.tick());
  assert.equal(h.turnCalls.length, 0);
  assert.ok(logs.some((l) => l.msg === 'diary: skip' && l.reason === 'cap'));
  assert.deepEqual(h.store.state.data.diary.g1.done, [SLOT], 'the slot is spent');
});

test('tick: refuses a channel the bot cannot send or attach in', async () => {
  for (const channel of [diaryChannelFake({ attach: false }), diaryChannelFake({ send: false })]) {
    const h = diaryHarness({ channel });
    h.setNow(SLOT + MINUTE_MS);
    const { logs } = await withCapturedLogs(() => h.diary.tick());
    assert.equal(h.turnCalls.length, 0);
    assert.ok(logs.some((l) => l.msg === 'diary: skip' && l.reason === 'not-writable'));
  }
});

test('tick: a channel that cannot be found, or of another guild, is no channel', async () => {
  for (const channel of [null, diaryChannelFake({ guildId: 'g2' })]) {
    const h = diaryHarness({ channel });
    h.setNow(SLOT + MINUTE_MS);
    const { logs } = await withCapturedLogs(() => h.diary.tick());
    assert.equal(h.turnCalls.length, 0);
    assert.ok(logs.some((l) => l.msg === 'diary: skip' && l.reason === 'no-channel'));
  }
});

test('force: runs now with the kind, ignores the plan and the quiet day, obeys the caps', async () => {
  const h = diaryHarness({ diary: { quietDayChance: 1 } });
  const result = await h.diary.force({ kind: 'meme' });
  assert.equal(result.outcome, 'spoke');
  assert.equal(h.turnCalls.length, 1);
  assert.deepEqual(h.turnCalls[0].params.diary, { kind: 'meme', forced: true });
  assert.equal(h.store.state.data.diary, undefined, 'no plan touched');

  const capped = diaryHarness({ diary: { maxPerDay: 1 }, data: { diaryDay: '2026-10-06', diaryPosts: 1 } });
  const refused = await capped.diary.force({ kind: 'meme' });
  assert.deepEqual(refused, { outcome: 'refused', reason: 'cap', limit: { key: 'diary.maxPerDay', used: 1, cap: 1 } });
  assert.equal(capped.turnCalls.length, 0);

  const paused = diaryHarness({ data: { paused: true } });
  assert.deepEqual(await paused.diary.force({}), { outcome: 'paused' });
  const unset = diaryHarness({ diary: { channelId: '' } });
  assert.deepEqual(await unset.diary.force({}), { outcome: 'not-now', reason: 'no-channel' });
});

test('force: passes kind and topic to the turn', async () => {
  const h = diaryHarness();
  await h.diary.force({ kind: 'meme', topic: '  une  promenade\n au port  ' });
  assert.deepEqual(h.turnCalls[0].params.diary, { kind: 'meme', topic: 'une promenade au port', forced: true });
  const long = diaryHarness();
  await long.diary.force({ topic: 'é'.repeat(400) });
  assert.ok([...long.turnCalls[0].params.diary.topic].length <= 300, 'the topic is clamped to 300 characters');
  const blank = diaryHarness();
  await blank.diary.force({ topic: '   ' });
  assert.deepEqual(blank.turnCalls[0].params.diary, { kind: null, forced: true }, 'a blank topic is none');
});

test('stop: no tick after stop', async () => {
  const h = diaryHarness();
  h.setNow(SLOT + MINUTE_MS);
  h.diary.stop();
  await h.diary.tick();
  assert.equal(h.turnCalls.length, 0);
  assert.equal(h.store.state.data.diary, undefined);
});

test('status: the channel, the day plan, the counts of today and the history size', async () => {
  const h = diaryHarness({ posts: [{}, {}], data: { diaryDay: '2026-10-06', diaryPosts: 1, diaryPicturesDay: '2026-10-06', diaryPictures: 1 } });
  await h.diary.tick();
  assert.deepEqual(h.diary.status(), { channelId: 'd1', day: '2026-10-06', slots: [SLOT], done: [], quiet: false, hunger: [0], quietStreak: 0, posts: 1, pictures: 1, history: 2 });
});

/** A turn runner that is busy until `release()`: `waitIdle` resolves then, `isAnyBusy` follows it. */
function busyTurns() {
  let busy = true;
  let resolveIdle;
  const idle = new Promise((resolve) => {
    resolveIdle = resolve;
  });
  const waits = [];
  return {
    waits,
    turnsExtra: {
      isAnyBusy: () => busy,
      waitIdle: () => {
        waits.push(true);
        return idle;
      },
    },
    release() {
      busy = false;
      resolveIdle();
    },
  };
}

/** A controllable delay: each call records its ms and resolves on `fire()`. */
function manualDelay() {
  const calls = [];
  const fires = [];
  return {
    calls,
    delay: (ms) =>
      new Promise((resolve) => {
        calls.push(ms);
        fires.push(resolve);
      }),
    fire() {
      for (const resolve of fires.splice(0)) resolve();
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('force: waits for the running turn and then posts', async () => {
  const running = busyTurns();
  const timer = manualDelay();
  const h = diaryHarness({ diary: { forceWaitMs: 5000 }, turnsExtra: running.turnsExtra, delay: timer.delay });
  const pending = h.diary.force({ kind: 'meme' });
  await flush();
  assert.equal(running.waits.length, 1, 'waits for the one attention');
  assert.deepEqual(timer.calls, [5000], 'the wait is capped by diary.forceWaitMs');
  assert.equal(h.turnCalls.length, 0, 'no post while the other turn runs');

  running.release();
  const result = await pending;
  assert.equal(result.outcome, 'spoke');
  assert.equal(h.turnCalls.length, 1);
  assert.deepEqual(h.turnCalls[0].params.diary, { kind: 'meme', forced: true });
});

test('force: gives up as busy after forceWaitMs', async () => {
  const running = busyTurns();
  const timer = manualDelay();
  const h = diaryHarness({ diary: { forceWaitMs: 5000 }, turnsExtra: running.turnsExtra, delay: timer.delay });
  const pending = h.diary.force({});
  await flush();
  timer.fire();
  const result = await pending;
  assert.deepEqual(result, { outcome: 'busy' });
  assert.equal(h.turnCalls.length, 0, 'never posted');
});

test('force: a busy outcome from the turn waits once and posts again', async () => {
  const timer = manualDelay();
  let idle = 0;
  const h = diaryHarness({
    outcomes: [{ outcome: 'busy' }],
    turnsExtra: { isAnyBusy: () => false, waitIdle: async () => void idle++ },
    delay: timer.delay,
  });
  const result = await h.diary.force({});
  assert.equal(result.outcome, 'spoke');
  assert.equal(idle, 1);
  assert.equal(h.turnCalls.length, 2);
});
