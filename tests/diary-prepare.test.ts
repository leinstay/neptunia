// The first step of a diary entry (src/turn/diary.ts#prepareDiary): the code draws the kind, a forced kind wins, a
// kind of SCENE_KINDS asks the director for its scenes before any turn, `randomSet` asks three times over sets that
// share no line, and an entry with no scene is skipped. The step runs on its own over the fakes of
// tests/fixtures/diary-prepare.ts; a constant `rng` draws the first or the last kind the entry may take, in the order
// of DIARY_KINDS. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { prepare } from './fixtures/diary-prepare.ts';
import { setsOf } from './fixtures/scene-answer.ts';
import type { DiaryPrepared } from '../src/turn/diary.ts';

/** The texts of the scenes an entry was prepared with, null for a skipped one. */
const scenesOf = (result: DiaryPrepared): Array<string> | null =>
  result.skipped ? null : result.scenes.map((one) => one.scene);

const FIRST = () => 0;
const LAST = () => 0.999999;

test('a drawn kind with no scene asks the director nothing', async () => {
  // Bug: every kind waits on a director request, so a facts entry costs a scene it never reads.
  // The last roll lands on facts, a kind with no scene, since the draw holds no `status`.
  const run = await prepare({ rng: LAST });
  assert.equal(run.kind, 'facts');
  assert.deepEqual(run.requests, []);
  assert.equal(run.result.skipped, false);
  assert.deepEqual(scenesOf(run.result), []);
});

test('a drawn story asks the director once and carries its scene', async () => {
  // Bug: a scene kind reaches the turn with no scene, so the persona writes it from nothing.
  const run = await prepare({ rng: FIRST });
  assert.equal(run.kind, 'story');
  assert.equal(run.requests.length, 1);
  const [request = ''] = run.requests;
  assert.ok(request.includes('<kind>\nstory\n</kind>'));
  assert.deepEqual(scenesOf(run.result), ['A STILL HARBOUR AT DUSK.']);
});

test('a forced kind wins over the draw', async () => {
  // Bug: the draw replaces the kind the owner asked for with `/diary post <kind>`.
  const run = await prepare({ rng: FIRST, pictures: true, forcedKind: 'facts' });
  assert.equal(run.kind, 'facts');
  assert.notEqual(run.prepared?.drawn, true);
});

test('the prepared journal line marks a drawn kind', async () => {
  // Bug: the journal cannot tell a drawn kind from one the owner chose.
  const run = await prepare({ rng: LAST });
  assert.equal(run.prepared?.drawn, true);
});

test('a randomSet asks for three scenes whose sets share no line', async () => {
  // Bug: the three requests draw their sets apart, so two scenes of one entry are built on the same place.
  const run = await prepare({ rng: FIRST, pictures: true, forcedKind: 'randomSet', seeds: SEEDS_24 });
  assert.equal(run.requests.length, 3);
  const lines = run.requests.flatMap((user) => setsOf(user).flat());
  const places = run.requests.flatMap((user) => setsOf(user).map((set) => set[0]));
  assert.equal(places.length, 24);
  assert.equal(new Set(lines.filter((line) => line.startsWith('p'))).size, 24, 'no place line twice');
  assert.equal(scenesOf(run.result)?.length, 3);
});

test('a randomSet runs on one scene when the other two fail', async () => {
  // Bug: one failed request of three skips the whole entry, or a failed answer is passed on as a scene.
  let n = 0;
  const run = await prepare({
    rng: FIRST,
    pictures: true,
    forcedKind: 'randomSet',
    seeds: SEEDS_24,
    answer: (user) => {
      n += 1;
      return n === 2 ? JSON.stringify({ set: 1, used: [setsOf(user)[0]?.[0]], scene: 'ONE CORNER.' }) : 'not json';
    },
  });
  assert.equal(run.result.skipped, false);
  assert.deepEqual(scenesOf(run.result), ['ONE CORNER.']);
});

test('a scene kind the director gives no scene is skipped as no-scene with the failure named', async () => {
  // Bug: a failed director request lets the turn run on an empty scene, or the skip says nothing of why.
  const run = await prepare({ rng: FIRST, failing: true });
  assert.equal(run.result.skipped, true);
  assert.equal(run.skipped?.reason, 'no-scene');
  assert.deepEqual(run.skipped?.failures, ['request-failed']);
  assert.equal(run.prepared, undefined);
});

/** Two seeds files of 24 lines each, so 24 sets share no line. */
const SEEDS_24 = {
  'diary/seeds/place': Array.from({ length: 24 }, (_, i) => `p${i}`).join('\n'),
  'diary/seeds/setting': Array.from({ length: 24 }, (_, i) => `s${i}`).join('\n'),
};

test('the lines an entry kept, and those of an entry stored with a plan, stay out of the next sets', async () => {
  // Bug: the next entry is offered the place the last one was built on, so two entries in a row share their scene.
  const posts = [
    { at: 1, kind: 'story', gist: 'a', picture: null, scenes: [{ used: ['p0'] }] },
    { at: 2, kind: 'thought', gist: 'b', picture: null, plan: { brief: 'x', seeds: [['p1', 'q1']], seed: 1 } },
  ];
  const run = await prepare({ rng: FIRST, posts, seeds: SEEDS_24 });
  const lines = run.requests.flatMap((user) => setsOf(user).flat());
  assert.equal(lines.includes('p0'), false, 'the kept line of a scene');
  assert.equal(lines.includes('p1'), false, 'the line of a stored plan');
  assert.ok(lines.includes('p2'), lines.join(' '));
});
