// The weights the kind of a selfreflection post is drawn by: each kind's weight scaled by how far its use among the
// newest posts lies from its share of the weights, clamped to a quarter and four times, and the newest post's kind at
// a quarter of that, so the same kind twice in a row stays possible and rare. Then the first step of a post draws over
// those weights, and falls back to the drawn kind when the plan request fails. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HISTORY_POSTS,
  DEFAULT_PICTURE_KINDS,
  SELFREFLECTION_KINDS,
  drawWeights,
  pickKind,
  withoutPictureKinds,
} from '../src/behavior/selfreflection.ts';
import { postsOf, prepare, seeded } from './fixtures/selfreflection-prepare.ts';

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
  const weights = drawWeights({ thought: 1, status: 1 }, postsOf([...times('thought', 3), 'status']), { window: 10 });
  // thought: share 0.5 over use 0.75. status: share 0.5 over use 0.25, then a quarter as the newest post's kind.
  assertWeights(weights, { thought: 1 * (0.5 / 0.75), status: 1 * 2 * 0.25 });
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
  const kinds = { thought: 1, status: 1 };
  assertWeights(drawWeights(kinds, postsOf(['thought', 'status']), { window: 10 }), { thought: 1, status: 0.25 });
  assertWeights(drawWeights(kinds, postsOf(['status', 'thought']), { window: 10 }), { thought: 0.25, status: 1 });
});

test('only the newest posts of the window count', () => {
  // Bug: the whole history counts, and a kind overused a year ago is still held down.
  const posts = postsOf([...times('thought', 4), 'status', 'thought']);
  assertWeights(drawWeights({ thought: 1, status: 1 }, posts, { window: 2 }), { thought: 0.25, status: 1 });
});

test('a use is a fraction of the posts in the window when fewer posts than the window exist', () => {
  // Bug: a young diary divides by the whole window, every kind looks unused, and the correction does nothing.
  const weights = drawWeights({ thought: 1, status: 1 }, postsOf(['thought', 'status']), { window: 150 });
  assertWeights(weights, { thought: 1, status: 0.25 });
});

test('with no posts the weights keep their proportions', () => {
  // Bug: zero posts give NaN weights, and the draw always lands on the last kind.
  const weights = drawWeights({ thought: 2, status: 1 }, [], { window: 10 });
  const thought = weights.thought ?? Number.NaN;
  const status = weights.status ?? Number.NaN;
  assert.ok(Number.isFinite(thought) && Number.isFinite(status), JSON.stringify(weights));
  assert.ok(Math.abs(thought / status - 2) < 1e-9, JSON.stringify(weights));
});

test('a kind with no weight and a kind only the history knows get no weight', () => {
  // Bug: a retired kind still in the history, or a kind the owner set to 0, comes back through the correction.
  const weights = drawWeights({ thought: 1, status: 0 }, postsOf(['retired', 'thought']), { window: 10 });
  assert.equal((weights.status ?? 0) > 0, false, JSON.stringify(weights));
  assert.equal((weights.retired ?? 0) > 0, false, JSON.stringify(weights));
});

test('a thousand draws give an overused kind less than its share and an unused kind more', () => {
  // Bug: the case of 2026-11-06, selfPicture at 14 of the last 59 posts against a weight of 3 of 18, drawn again.
  const history = [
    ...times('selfPicture', 14),
    ...times('picture', 6),
    ...times('meme', 3),
    ...times('thought', 7),
    ...times('people', 6),
    ...times('news', 6),
    ...times('photoset', 3),
    ...times('randomSet', 4),
    ...times('status', 10),
  ];
  const weights = drawWeights(SELFREFLECTION_KINDS, postsOf(history), { window: DEFAULT_HISTORY_POSTS });
  const rng = seeded(42);
  const counts = new Map<string, number>();
  for (let i = 0; i < 1000; i += 1) {
    const kind = pickKind(weights, rng) ?? 'none';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const total = Object.values(SELFREFLECTION_KINDS).reduce((sum, weight) => sum + weight, 0);
  const shareOf = (kind: string): number => (SELFREFLECTION_KINDS[kind] ?? 0) / total;
  assert.ok((counts.get('selfPicture') ?? 0) / 1000 < shareOf('selfPicture'), JSON.stringify([...counts]));
  assert.ok((counts.get('facts') ?? 0) / 1000 > shareOf('facts'), JSON.stringify([...counts]));
});

// ---- the first step of a post draws over the corrected weights ----------------------------------------------------

const TEXT_KINDS = withoutPictureKinds(SELFREFLECTION_KINDS, DEFAULT_PICTURE_KINDS);
const MIDDLE = () => 0.5;
// Ten status posts: status is held down and is the newest kind, so the middle of the draw moves off the raw weights.
const STATUS_POSTS = postsOf(times('status', 10));

/** The kind a draw at the middle lands on over the corrected weights, checked to differ from the raw weights' one. */
function middleDraw(): string {
  const drawn = pickKind(drawWeights(TEXT_KINDS, STATUS_POSTS, { window: DEFAULT_HISTORY_POSTS }), MIDDLE) ?? 'none';
  assert.notEqual(drawn, pickKind(TEXT_KINDS, MIDDLE), 'the scene must tell the corrected draw from the raw one');
  return drawn;
}

test('the first step of a post draws its kind over the corrected weights', async () => {
  // Bug: the step draws over the raw weights, and the correction for recent use never reaches a post.
  const drawn = middleDraw();
  const other = Object.keys(TEXT_KINDS).find((kind) => kind !== drawn && kind !== pickKind(TEXT_KINDS, MIDDLE));
  const run = await prepare({
    rng: MIDDLE,
    posts: STATUS_POSTS,
    answer: { kind: other, brief: 'a planned scene', search: '', picture: false, seed: 1 },
  });
  assert.deepEqual(run.offered, [drawn]);
  assert.equal(run.plan.kind, drawn);
});

test('a failed plan request posts the drawn kind', async () => {
  // Bug: the fallback draws a second time over the raw weights, and a failure undoes the correction.
  const drawn = middleDraw();
  const run = await prepare({ rng: MIDDLE, posts: STATUS_POSTS, failing: true });
  assert.equal(run.plan.kind, drawn);
});
