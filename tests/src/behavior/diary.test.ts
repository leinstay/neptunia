// Tests for src/behavior/diary.ts (the diary scheduler's pure core: the day plan, due slots, kind choice and the
// weights of the draw, the <diary> rendering, the seed lines its entries took, URL stripping, gists) and the
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
  renderDiaryBlock,
  usedSeedLines,
  sceneOf,
  gistOf,
  createDiary,
  DEFAULT_HISTORY_POSTS,
  DIARY_KINDS,
  drawWeights,
  kindWeights,
} from '../../../src/behavior/diary.ts';
import { postsOf, seeded } from '../../fixtures/diary-prepare.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { fill } from '../../../src/format.ts';
import { handleOf } from '../../../src/behavior/handles.ts';
import { MINUTE_MS, HOUR_MS, DAY_MS } from '../../../src/time.ts';
import { labels } from '../../fixtures/labels.ts';
import { useIface, world, onWorld, useSelf } from '../../fixtures/turn-world.ts';
import type { Channel } from '../../fixtures/turn-world.ts';
import { openTestMemorySync } from '../../fixtures/memory-db/service.ts';
import { seedMirror } from '../../fixtures/diary-mirror.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { createTurnRunner as createRealTurnRunner } from '../../../src/behavior/turn.ts';
import { userText } from '../../../src/behavior/prompt.ts';
import { completionOf } from '../../fixtures/tool-answers.ts';
import { directorAnswer } from '../../fixtures/scene-answer.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import { defaultSkills } from '../../../src/turn/calls.ts';
import '../../../src/tools/operations/index.ts';

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

// The diary channel is held by a fake interface named `fake`.
useIface('fake');

const seq = (values: Untyped) => {
  let i = 0;
  return () => values[i++ % values.length];
};

// The gap between slots (90 minutes), the quiet carry (0.25) and the hunger boost (0.5) are constants of
// src/behavior/diary.ts.
const base = { quietDayChance: 0 };

test('localDayKey: the local date of the zone, not the UTC one', () => {
  const t = Date.parse('2026-03-10T23:30:00Z');
  assert.equal(localDayKey(t, 'UTC'), '2026-03-10');
  assert.equal(localDayKey(t, 'Europe/Athens'), '2026-03-11');
});

test('planDay: a window crossing midnight stays inside it in Europe/Athens', () => {
  const nowMs = Date.parse('2026-03-10T05:00:00Z');
  const cfg = { ...base, windows: [{ from: 18, to: 1, posts: [2, 2] }] };
  // Two slots stay 90 minutes apart, so no case puts both into the hour after midnight.
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
  const plan = planDay(cfg, nowMs, 'UTC', seq([0.1, 0.5]));
  assert.equal(plan.quiet, true);
  assert.deepEqual(plan.slots, []);
  assert.equal(plan.day, '2026-03-10');
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
  assert.equal(isPictureKind('thought', ['meme']), false);
  assert.equal(isPictureKind('selfPicture', undefined), true);
  assert.equal(isPictureKind('selfPicture', []), false);
  assert.equal(isPictureKind(null, undefined), false);
});

// ---- the weights the kind of a post is drawn by ----------------------------------------------------------------
// Each kind's weight is scaled by how far its use among the newest posts lies from its share of the weights, clamped to
// a quarter and four times, and the newest post's kind is drawn at a quarter of that, so the same kind twice in a row
// stays possible and rare.

/** Whether every key of `expected` has its value in `actual`, to the rounding of a float, and no other key a positive one. */
function assertWeights(actual: Record<string, number>, expected: Record<string, number>): void {
  for (const [key, value] of Object.entries(expected))
    assert.ok(Math.abs((actual[key] ?? Number.NaN) - value) < 1e-9, `${key}: ${actual[key]} against ${value}`);
  const extra = Object.entries(actual).filter(([key, value]) => !(key in expected) && value > 0);
  assert.deepEqual(extra, []);
}

/** `count` copies of `kind`. */
const times = (kind: string, count: number): Array<string> => Array.from({ length: count }, () => kind);

test('a kind used past its share is scaled down by its share over its use', () => {
  // Bug: the weights ignore the history, and a kind the diary already overuses keeps its full chance.
  const weights = drawWeights({ thought: 1, people: 1 }, postsOf([...times('thought', 3), 'people']), { window: 10 });
  // thought: share 0.5 over use 0.75. people: share 0.5 over use 0.25, then a quarter as the newest post's kind.
  assertWeights(weights, { thought: 1 * (0.5 / 0.75), people: 1 * 2 * 0.25 });
});

test('a kind not used in the window gets four times its weight', () => {
  // Bug: a use of zero divides by zero, and the unused kind gets an infinite or a NaN weight.
  const weights = drawWeights({ thought: 2, news: 1 }, postsOf(times('thought', 4)), { window: 10 });
  assertWeights(weights, { thought: 2 * (2 / 3) * 0.25, news: 4 });
});

test('the correction is clamped to a quarter and to four times the weight', () => {
  // Bug: an unclamped correction starves a kind used in nine posts of ten, or floods a rare one past every other kind.
  const weights = drawWeights({ thought: 1, news: 9 }, postsOf([...times('thought', 9), 'news']), { window: 10 });
  // thought: 0.1 over 0.9 clamps to 0.25. news: 0.9 over 0.1 clamps to 4, then a quarter as the newest post's kind.
  assertWeights(weights, { thought: 0.25, news: 9 * 4 * 0.25 });
});

test("the newest post's kind is drawn at a quarter of its corrected weight", () => {
  // Bug: the kind just posted keeps its full chance, and the diary repeats a kind twice in a row as often as any pair.
  const kinds = { thought: 1, people: 1 };
  assertWeights(drawWeights(kinds, postsOf(['thought', 'people']), { window: 10 }), { thought: 1, people: 0.25 });
  assertWeights(drawWeights(kinds, postsOf(['people', 'thought']), { window: 10 }), { thought: 0.25, people: 1 });
});

test('only the newest posts of the window count', () => {
  // Bug: the whole history counts, and a kind overused a year ago is still held down.
  const posts = postsOf([...times('thought', 4), 'people', 'thought']);
  assertWeights(drawWeights({ thought: 1, people: 1 }, posts, { window: 2 }), { thought: 0.25, people: 1 });
});

test('a use is a fraction of the posts in the window when fewer posts than the window exist', () => {
  // Bug: a young diary divides by the whole window, every kind looks unused, and the correction does nothing.
  const weights = drawWeights({ thought: 1, people: 1 }, postsOf(['thought', 'people']), { window: 150 });
  assertWeights(weights, { thought: 1, people: 0.25 });
});

test('with no posts the weights keep their proportions', () => {
  // Bug: zero posts give NaN weights, and the draw always lands on the last kind.
  const weights = drawWeights({ thought: 2, people: 1 }, [], { window: 10 });
  const thought = weights.thought ?? Number.NaN;
  const people = weights.people ?? Number.NaN;
  assert.ok(Number.isFinite(thought) && Number.isFinite(people), JSON.stringify(weights));
  assert.ok(Math.abs(thought / people - 2) < 1e-9, JSON.stringify(weights));
});

test('a kind with no weight and a kind only the history knows get no weight', () => {
  // Bug: a retired kind still in the history, or a kind the owner set to 0, comes back through the correction.
  const weights = drawWeights({ thought: 1, people: 0 }, postsOf(['retired', 'thought']), { window: 10 });
  assert.equal((weights.people ?? 0) > 0, false, JSON.stringify(weights));
  assert.equal((weights.retired ?? 0) > 0, false, JSON.stringify(weights));
});

test('diary.kinds replaces the weight of a known kind and keeps the others', () => {
  const weights = kindWeights({ kinds: { people: 1, thought: 0.5, status: 9, story: 'x' } });
  assert.equal(weights.people, 1);
  assert.equal(weights.thought, 0.5);
  assert.equal(weights.story, DIARY_KINDS.story);
  assert.equal(Object.hasOwn(weights, 'status'), false);
});

test('diary.kinds missing leaves every kind at the weight DIARY_KINDS holds', () => {
  assert.deepEqual(kindWeights({}), { ...DIARY_KINDS });
});

test('the draw never gives a status, and each of the ten kinds is drawn at the weight DIARY_KINDS holds', () => {
  // Bug: the kind `status`, which gave lines with no mood of the persona behind them, comes back into the draw.
  const kinds = [
    'story',
    'selfPicture',
    'picture',
    'meme',
    'thought',
    'people',
    'news',
    'facts',
    'photoset',
    'randomSet',
  ];
  assert.deepEqual(Object.keys(DIARY_KINDS).sort(), [...kinds].sort());
  const weights = drawWeights(DIARY_KINDS, [], { window: DEFAULT_HISTORY_POSTS });
  for (const kind of kinds)
    assert.ok(Math.abs((weights[kind] ?? 0) / weights.story - DIARY_KINDS[kind] / DIARY_KINDS.story) < 1e-9, kind);
  for (let roll = 0; roll < 1; roll += 0.001)
    assert.notEqual(
      pickKind(weights, () => roll),
      'status',
      String(roll)
    );
});

test('a thousand draws give an overused kind less than its share and an unused kind more', () => {
  // Bug: selfPicture at 14 of the last 59 posts against a weight of 3 of 18, drawn again.
  const history = [
    ...times('selfPicture', 14),
    ...times('picture', 6),
    ...times('meme', 3),
    ...times('thought', 7),
    ...times('people', 6),
    ...times('news', 6),
    ...times('photoset', 3),
    ...times('randomSet', 4),
    // Ten story posts hold the place of a kind the window overuses, since the old `status` is no kind of the draw.
    ...times('story', 10),
  ];
  const weights = drawWeights(DIARY_KINDS, postsOf(history), { window: DEFAULT_HISTORY_POSTS });
  const rng = seeded(42);
  const counts = new Map<string, number>();
  for (let i = 0; i < 1000; i += 1) {
    const kind = pickKind(weights, rng) ?? 'none';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const total = Object.values(DIARY_KINDS).reduce((sum, weight) => sum + weight, 0);
  const shareOf = (kind: string): number => (DIARY_KINDS[kind] ?? 0) / total;
  assert.ok((counts.get('selfPicture') ?? 0) / 1000 < shareOf('selfPicture'), JSON.stringify([...counts]));
  assert.ok((counts.get('facts') ?? 0) / 1000 > shareOf('facts'), JSON.stringify([...counts]));
});

test('renderDiaryBlock: newest first, at most max lines, picture suffix when present', () => {
  // Newest first.
  const posts = [
    { at: Date.parse('2026-03-01T10:00:00Z'), kind: 'thought', gist: 'oldest', picture: null },
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

test('renderDiaryBlock: a picture the persona drew carries the made mark and the people it shows after its scene', () => {
  // Bug: the persona's diary lists their own drawing with its scene alone, and they cannot tell who is in it.
  const marked = {
    ...labels,
    transcript: {
      ...labels.transcript,
      mediaMade: '[MADE]',
      mediaDepicts: '[SHOWS {names}]',
      mediaDepictsSelf: 'HERSELF',
    },
  };
  const posts = [
    {
      at: Date.parse('2026-03-03T10:00:00Z'),
      kind: 'selfPicture',
      gist: 'on the pier',
      picture: 'a pier at dusk',
      made: 'self',
      depicted: [{ self: true }, { self: false, handle: `@${handleOf('person-alice')}` }],
    },
  ];
  const [, line] = renderDiaryBlock(posts, marked, { timezone: 'UTC', max: 3 }).split('\n');
  assert.ok(line?.includes('[picture: a pier at dusk]'), line);
  assert.ok(line?.includes('[MADE]'), line);
  // A person is written by the handle the persona can pass to a tool, never by a name.
  assert.ok(line?.includes(`[SHOWS HERSELF, @${handleOf('person-alice')}]`), line);
});

test('renderDiaryBlock: a cut to max keeps the newest posts, not the first ones given', () => {
  // Bug: the list is reversed and then cut with the old `slice(-max)`, so the oldest posts stay.
  const posts = ['one', 'two', 'three', 'four'].map((gist, index) => ({
    at: Date.UTC(2026, 2, 1 + index, 10),
    kind: 'thought',
    gist,
    picture: null,
  }));
  const lines = renderDiaryBlock(posts, labels, { timezone: 'UTC', max: 2 }).split('\n');
  assert.deepEqual(lines.slice(1), ['- 2026-03-04 thought: four', '- 2026-03-03 thought: three']);
});

test('renderDiaryBlock: a set renders its first scene with the picture count', () => {
  // Newest first.
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

test('isSetKind: listed kinds, the default list when none is given', () => {
  assert.equal(isSetKind('tour', ['tour']), true);
  assert.equal(isSetKind('photoset', ['tour']), false);
  assert.equal(isSetKind('photoset', undefined), true);
  assert.equal(isSetKind('randomSet', null), true);
  assert.equal(isSetKind('selfPicture', undefined), false);
  assert.equal(isSetKind(null, ['tour']), false);
});

test('setSettings: the configured values, whole and ordered; the defaults for missing or broken ones', () => {
  // The expectation changed on purpose: the writer takes no seed sets of a set kind, so `seedSets` is no setting.
  assert.deepEqual(setSettings({ set: { pictures: [2, 3], minPosted: 1, maxMessageBytes: 1000 } }), {
    pictures: [2, 3],
    minPosted: 1,
    maxMessageBytes: 1000,
  });
  const fallback = setSettings({});
  assert.deepEqual(setSettings({ set: { pictures: 'x', minPosted: -1, maxMessageBytes: 0 } }), fallback);
  assert.deepEqual(setSettings({ set: { pictures: [5, 2] } }).pictures, [5, 5], 'max never below min');
});

/** A past entry the planner planned: `seeds` the combinations offered, `seed` the 1-based one taken (0 for none). */
const planned = (at: number, seeds: Array<Array<string>>, seed: number) => ({
  at,
  kind: 'thought',
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
    { at: 3, kind: 'thought', gist: 'an old row', picture: null },
  ];
  assert.equal(usedSeedLines(posts, 10).size, 0);
});

test('usedSeedLines: the lines every scene of an entry kept, beside an entry stored with a plan', () => {
  // Bug: an entry of the director's scenes leaves its kept lines in the next draw, or only its first scene counts.
  const posts = [
    planned(1, [['a pier', 'fog']], 1),
    { at: 2, kind: 'randomSet', gist: 'g', picture: 'x', scenes: [{ used: ['a roof'] }, { used: ['rain', 'a bell'] }] },
  ];
  assert.deepEqual([...usedSeedLines(posts, 10)].sort(), ['a bell', 'a pier', 'a roof', 'fog', 'rain']);
});

test('sceneOf: the drawing prompt of a planned picture post comes first, over its brief', () => {
  // The expectation changed on purpose: the brief is the planner's wording, and the list of past entries remembers
  // what the persona drew. Bug: the brief shown in place of the drawing prompt.
  const brief = 'she learns to skate on a frozen lake at dusk';
  const post = {
    picture: 'a cafe interior, warm light',
    plan: { brief, seeds: [['a lake', 'skating']], seed: 1 },
  };
  assert.equal(sceneOf(post), 'a cafe interior, warm light');
});

// A text over its bound is summarized or kept whole, never cut.
test('sceneOf: the stored brief, whole, when a planned picture post holds no drawing prompt', () => {
  // Bug: a picture with no stored prompt loses its scene; or a long brief is cut.
  const brief = `she learns to skate on a frozen lake, ${'falling and getting up again, '.repeat(16)}at dusk`;
  assert.equal(sceneOf({ picture: true, plan: { brief, seeds: [], seed: 0 } }), brief);
  assert.equal(sceneOf({ picture: '', plan: { brief, seeds: [], seed: 0 } }), brief);
});

// A text over its bound is summarized or kept whole, never cut.
test('sceneOf: without a plan the stored drawing prompt, even when the picture was described', () => {
  // Bug: the scene taken from the picture description, which the scene's bound then cut.
  const post = {
    picture: 'a cafe interior, warm light',
    pictureDescription: 'a girl rides a red bicycle\ndown a wet hill road at dawn',
  };
  assert.equal(sceneOf(post), 'a cafe interior, warm light');
});

// A text over its bound is summarized or kept whole, never cut.
test('sceneOf: with neither a plan nor a description, the stored drawing prompt', () => {
  // Bug: an old row loses its scene and shows nothing.
  assert.equal(sceneOf({ picture: 'a cafe interior, warm light' }), 'a cafe interior, warm light');
});

// A diary gist is kept whole.
test('gistOf: one line, kept whole', () => {
  assert.equal(gistOf('short\n\npost'), 'short post');
  const long = 'alpha beta gamma delta '.repeat(40).trim();
  assert.equal(gistOf(long), long);
});

// createDiary: the scheduler's edge, with a fake store, client and turn runner.

type Rec = Record<string, Untyped>;
// The plan the scheduler stored for root g1 in the harness's state.
const planOf = (h: { store: { state: { data: unknown } } }): Rec => {
  const { state } = h.store;
  return (loose(state.data).diary as Rec).persona as Rec;
};

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
 * The diary's place is its mirror in memory. The
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
}: {
  mirror?: boolean;
  diary?: Rec;
  data?: Rec;
  posts?: Array<Rec>;
  channel?: ReturnType<typeof diaryChannelFake> | null;
  outcomes?: Array<Rec>;
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
          diary: { kind: 'thought', picture: false, search: false, messages: 1 },
        }
      );
    },
  };
  const diaryFactory = createDiary({
    hot,
    // @ts-expect-error: the stand-in store holds only the part of DiaryStore that the tick reads
    store,
    iface: () => 'fake',
    turns,
    isServedRoot: (id: unknown) => id === 'g1',
    rng: () => 0.5,
    now: () => clock,
  });
  return { hot, store, turnCalls, diary: diaryFactory, setNow: (t: Untyped) => (clock = t) };
}

// The tick with no channel and no mirror is "posts with zero mirrors" below.
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
    const { state } = h.store;
    assert.equal(loose(state.data).diary, undefined, `${reason}: no plan`);
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
  const { bot } = h.hot.config;
  bot.timezone = 'Europe/Athens';
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
  // The post is the diary wake, with no chat, for the served root.
  assert.equal(params.chat, undefined);
  // The post names no chat and no place: it is the persona's.
  assert.equal('placeId' in params, false);
  assert.deepEqual(params.diary, { kind: null, forced: false });
  assert.deepEqual(done, [SLOT], 'marked before the turn ran');
  assert.ok(logs.some((l) => l.msg === 'diary: due'));
  const line = logs.find((l) => l.msg === 'diary: post');
  assert.equal(loose(line).outcome, 'spoke');
  assert.equal(loose(line).kind, 'thought');
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

// The entry is recorded first and the mirror's capability is read only when it is published, so a mirror place the
// persona cannot send or attach in does not refuse the post.
test('tick: a mirror place the persona cannot send or attach in does not refuse the post', async () => {
  for (const channel of [diaryChannelFake({ attach: false }), diaryChannelFake({ send: false })]) {
    const h = diaryHarness({ channel });
    h.setNow(SLOT + MINUTE_MS);
    const { logs } = await withCapturedLogs(() => h.diary.tick());
    assert.equal(h.turnCalls.length, 1);
    assert.ok(!logs.some((l) => l.msg === 'diary: skip' && l.reason === 'not-writable'));
  }
});

// With no mirror and no channel the due post still runs; the entry
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
  const { state } = h.store;
  assert.equal(loose(state.data).diary, undefined);
});

test('status: the channel, the day plan and the history size', async () => {
  const h = diaryHarness({ posts: [{}, {}] });
  await h.diary.tick();
  // `placeId` is the chat of the diary's first mirror.
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

// The diary channel is held by a fake interface named `fake`; the persona is `self-id`.
useIface('fake');

useSelf('self-id');

// onWorld takes a creator of any options; the real runner takes its own input type, so the options are cast once, here.
const createWorldRunner = onWorld((options) =>
  createRealTurnRunner(options as Parameters<typeof createRealTurnRunner>[0])
);

/**
 * A turn runner whose `runTurn` first opens the chat a test gave as a diary channel (see diaryChannel).
 */
function createTurnRunner(options: Parameters<typeof createWorldRunner>[0]) {
  const turns = createWorldRunner(options);
  return {
    ...turns,
    runTurn: (params: Record<string, unknown> & { channel?: { open?: () => unknown } }) => {
      params.channel?.open?.();
      return turns.runTurn(params);
    },
  };
}

const NOW = Date.UTC(2026, 9, 6, 19, 30, 0);

const TZ = 'Europe/Athens';

/**
 * A diary channel the persona owns: every permission, Attach Files only when `attachFiles`. The chat is made in
 * the test's world when a turn runs in it (`open`), and `sent` and `reactCalls` read what the persona did there.
 */
function diaryChannel({
  attachFiles = true,
  historyMessages = [],
}: { attachFiles?: boolean; historyMessages?: Array<Rec> } = {}) {
  let handle: Channel | null = null;
  return {
    id: 'd1',
    open() {
      handle ??= world().channel({
        id: 'd1',
        name: 'journal',
        placeId: 'g1',
        permissions: { attach: attachFiles },
        historyMessages,
      });
      return handle;
    },
    get sent() {
      return handle?.sent ?? [];
    },
    get reactCalls() {
      return handle?.reactCalls ?? [];
    },
  };
}

/**
 * An LLM that answers the director with `scene` (a scene's text, an Error it throws, or `{ raw }` sent as it is), then
 * the persona's requests with `post` (a list: one answer per request, the last repeated). `calls` holds every request,
 * the director's first.
 */
function fakeLlm(scene: string | Error | { raw: string } | null, post: Untyped) {
  const calls: Array<Untyped> = [];
  const options: Array<Untyped> = [];
  let composed = 0;
  return {
    calls,
    options,
    complete: async (messages: Untyped, opts: Untyped) => {
      calls.push(messages);
      options.push(opts);
      if (opts?.purpose === 'diary-scene') {
        if (scene instanceof Error) throw scene;
        if (scene !== null && typeof scene === 'object') return { text: scene.raw, usage: {}, estimated: 5 };
        return directorAnswer(messages, opts, typeof scene === 'string' ? scene : undefined);
      }
      const answer = Array.isArray(post) ? post[Math.min(composed, post.length - 1)] : post;
      composed += 1;
      return completionOf(answer);
    },
  };
}

function fakeStore({ posts = [], data = {} }: { posts?: Array<Rec>; data?: Rec } = {}) {
  const appended: Array<Untyped> = [];
  return {
    appended,
    getPlace: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    liveRules: () => [],
    ...objectMediaCache({}),
    getDiary: () => ({ posts, updatedAt: 0 }),
    appendDiaryPost: (post: Untyped, opts: Untyped) => appended.push({ post, opts }),
    state: { data: { ...data }, markDirty() {} },
  };
}

function fakeImages({ used = 0, cap = 10, fail = null }: { used?: number; cap?: number; fail?: Error | null } = {}) {
  const prompts: Array<Untyped> = [];
  return {
    prompts,
    quota: () => ({ used, cap, userUsed: 0, userCap: 5, spent: used >= cap, userSpent: false }),
    generate: async ({ prompt }: { prompt: Untyped }) => {
      prompts.push(prompt);
      if (fail) throw fail;
      return { buffer: Buffer.from('png'), mediaType: 'image/png', seconds: 1, cost: 0 };
    },
  };
}

// PR 7d: the switches are code, the dry run and the daily caps are gone, and the diary's kinds, sets, gist length and
// message count are constants of src/behavior/diary.ts, so the config holds only the keys that are still settings.
function fakeHot({ diary = {}, prompts = {} }: { diary?: Untyped; prompts?: Untyped } = {}) {
  return {
    config: {
      bot: { timezone: TZ },
      context: {
        channelMessages: 50,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { fetchTimeoutMs: 10_000 },
        pull: { sameAudience: true },
      },
      llm: { maxRequestTokens: 50000 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [0, 0], minMs: 0, maxMs: 0, betweenMessagesMs: [0, 0] },
      image: {},
      diary: {
        placeId: 'd1',
        world: false,
        ...diary,
      },
    },
    prompts: {
      main: 'SYSTEM for {{name}}',
      persona: 'CARD_TEXT',
      format: 'FORMAT_TEXT',
      'diary/task': 'DIARY_TASK for {{name}}',
      'diary/scene': 'SCENE_TASK',
      'diary/kinds/thought': 'THOUGHT_TASK',
      'diary/kinds/story': 'STORY_TASK',
      'diary/seeds/place': 'a pier',
      'diary/seeds/setting': 'fog',
      draw: 'DRAW for {{name}}\n{{when}}\n{{request}}',
      labels,
      ...prompts,
    },
  };
}

function runner({
  hot = fakeHot(),
  store = fakeStore(),
  llm,
  images = fakeImages(),
  lookup = null,
  // The code draws the diary's kind.
  rng = () => 0.5,
  extra = {},
}: {
  hot?: Untyped;
  store?: Untyped;
  llm?: Untyped;
  images?: Untyped;
  lookup?: Untyped;
  rng?: () => number;
  extra?: Record<string, unknown>;
} = {}) {
  return createTurnRunner({
    hot,
    store,
    llm,
    calibrator: { ratio: 1, apply: (n: Untyped) => n, observe: () => {} },
    images,
    lookup,
    rng,
    now: () => NOW,
    ...extra,
  });
}

// The whole user text, every cache part: the stable part always carries the static senses lines.
const userOf = (messages: Untyped) => userText(messages[1].content);

// ---- voiced entries ----------------------------------------------------------------

const VOICE_PART = 'VOICE_PART';

const TEXT_KINDS = ['story', 'thought', 'people', 'news', 'facts'];

const PICTURE_KINDS = ['selfPicture', 'picture', 'photoset', 'randomSet', 'meme'];

/** A diary setting where the role `speech` has a route (or none with `speech: false`) and `diary.voiceChance` is `chance`. */
function voiceHot({ chance, speech = true }: { chance?: number; speech?: boolean } = {}) {
  const hot = fakeHot({
    diary: chance === undefined ? {} : { voiceChance: chance },
    prompts: { 'diary/voice': VOICE_PART },
  });
  Object.assign(hot.config, { models: { routes: chainsOf({ speech: speech ? 'x/speech' : null }) } });
  return hot;
}

/** The `<task>` of the persona's first request in a diary turn of `kind` at a constant `roll`. */
async function voicedTask(
  kind: string,
  roll: number,
  hot: ReturnType<typeof voiceHot>,
  extra: Record<string, unknown> = {}
) {
  const llm = fakeLlm(null, '<skip/>');
  await runner({ hot, llm, rng: () => roll, extra }).runTurn({
    channel: diaryChannel(),
    mode: 'diary',
    diary: { kind, forced: true },
  });
  const at = (llm.options as Array<{ purpose?: unknown } | null>).findIndex((one) => one?.purpose !== 'diary-scene');
  return /<task>\n([\s\S]*?)\n<\/task>/.exec(userOf(llm.calls[at]))?.[1] ?? '';
}

test('diary voice: with diary.voiceChance at 1 every text kind is voiced and no picture kind', async () => {
  // Bug: a picture entry is told to speak, or a text kind is never voiced.
  for (const kind of TEXT_KINDS)
    assert.ok((await voicedTask(kind, 0.5, voiceHot({ chance: 1 }))).endsWith(VOICE_PART), kind);
  for (const kind of PICTURE_KINDS)
    assert.ok(!(await voicedTask(kind, 0.5, voiceHot({ chance: 1 }))).includes(VOICE_PART), kind);
});

test('diary voice: with diary.voiceChance at 0 no entry is voiced', async () => {
  for (const kind of TEXT_KINDS)
    assert.ok(!(await voicedTask(kind, 0, voiceHot({ chance: 0 }))).includes(VOICE_PART), kind);
});

test('diary voice: the default chance voices a text entry below 0.1 and not above it', async () => {
  assert.ok((await voicedTask('thought', 0.05, voiceHot())).endsWith(VOICE_PART));
  assert.ok(!(await voicedTask('thought', 0.15, voiceHot())).includes(VOICE_PART));
});

test('diary voice: with the role speech off no entry is voiced at any roll', async () => {
  // Bug: the persona is told to speak with a tool it is not offered.
  for (const roll of [0, 0.05, 0.5])
    assert.ok(!(await voicedTask('thought', roll, voiceHot({ chance: 1, speech: false }))).includes(VOICE_PART));
});

test("diary voice: with voice.say filtered out of the turn's tools no entry is voiced", async () => {
  const skills = new Map([...defaultSkills()].filter(([name]) => name !== 'voice.say'));
  assert.ok(!(await voicedTask('thought', 0, voiceHot({ chance: 1 }), { skills })).includes(VOICE_PART));
});

useIface('fake');

const at = (iso: string): number => Date.parse(iso);

// ---- the diary ---------------------------------------------------------------------------------------------------------

const WINDOWS = [{ from: 7, to: 11, posts: [2, 2] }];

test('a diary schedule of daily times replaces the windows with exactly those slots, in UTC', () => {
  // Catches: the setting is saved and the day plan goes on drawing from the windows.
  const now = at('2026-11-04T05:00:00Z');
  for (const zone of ['UTC', 'Europe/Athens']) {
    const plan = planDay({ schedule: 'at 09:00,21:00', windows: WINDOWS, quietDayChance: 0 }, now, zone, () => 0.5);
    assert.deepEqual(plan.slots, [at('2026-11-04T09:00:00Z'), at('2026-11-04T21:00:00Z')], zone);
  }
});

test('a diary schedule of an interval lays its slots from the start of the UTC day', () => {
  // Catches: the interval counts from whenever the plan was made, so a restart moves every post of the day.
  const plan = planDay(
    { schedule: 'every 6h', windows: WINDOWS, quietDayChance: 0 },
    at('2026-11-04T05:00:00Z'),
    'UTC',
    () => 0.5
  );
  assert.deepEqual(
    plan.slots,
    ['00', '06', '12', '18'].map((hour) => at(`2026-11-04T${hour}:00:00Z`))
  );
});

test('a diary interval shorter than the gap of the windows keeps all its slots', () => {
  // Catches: the 90-minute gap between drawn posts silently thins `every 1h` to one post in two.
  const plan = planDay(
    { schedule: 'every 1h', windows: WINDOWS, quietDayChance: 0 },
    at('2026-11-04T05:00:00Z'),
    'UTC',
    () => 0.5
  );
  assert.equal(plan.slots.length, 24);
});

test('a named diary schedule has no quiet day: status never promises a time the dice then drop', () => {
  // Catches: the quiet-day chance suppresses slots the owner named, which a named schedule forbids.
  const plan = planDay(
    { schedule: 'at 09:00', windows: WINDOWS, quietDayChance: 1 },
    at('2026-11-04T05:00:00Z'),
    'UTC',
    () => 0
  );
  assert.equal(plan.quiet, false);
  assert.deepEqual(plan.slots, [at('2026-11-04T09:00:00Z')]);
});

test('diary slots of a schedule missed past the grace are dropped together, not stacked', () => {
  // Catches: slots of the fixed schedule bypass the grace, so a morning down comes back as a row of posts.
  const plan = planDay(
    { schedule: 'at 09:00,10:00,11:00', quietDayChance: 0 },
    at('2026-11-04T05:00:00Z'),
    'UTC',
    () => 0.5
  );
  assert.deepEqual(dueSlot(plan, at('2026-11-04T15:00:00Z'), 30), {
    slot: null,
    dropped: [at('2026-11-04T09:00:00Z'), at('2026-11-04T10:00:00Z'), at('2026-11-04T11:00:00Z')],
  });
});
