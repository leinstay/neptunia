// The code draws the kind of a diary post, and the planner writes the post for that kind: the plan request
// offers the drawn kind alone, the plan keeps it whatever kind the planner names, a forced kind still wins, and the
// picture gate keeps the picture kinds out of the draw. The step runs on its own over the fakes of
// tests/fixtures/diary-prepare.ts; a constant `rng` draws the first or the last kind the post may take, in the
// order of DIARY_KINDS. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { postsOf, prepare } from './fixtures/diary-prepare.ts';
import type { PrepareRun } from './fixtures/diary-prepare.ts';

const FIRST = () => 0;
const LAST = () => 0.999999;

for (const [label, rng, drawn] of [
  ['first', FIRST, 'thought'],
  ['last', LAST, 'status'],
] as const) {
  test(`the plan request offers the drawn ${label} text kind alone and the plan keeps it over the planner's kind`, async () => {
    // Bug: the planner is still offered every kind and picks its favourite, so three picture posts come in a row.
    const run = await prepare({
      rng,
      answer: { kind: 'news', brief: 'a planned scene', search: '', picture: false, seed: 1 },
    });
    const { plan } = run;
    assert.deepEqual(run.offered, [drawn]);
    assert.equal(plan.kind, drawn);
    // Bug: an answer naming another kind is treated as broken and the planner's brief is thrown away.
    assert.equal(plan.brief, 'a planned scene');
  });
}

test('a forced kind is offered alone and wins over the draw', async () => {
  // Bug: the draw replaces the kind the owner asked for with `/diary post <kind>`.
  const run = await prepare({ rng: FIRST, pictures: true, forcedKind: 'facts' });
  assert.deepEqual(run.offered, ['facts']);
  assert.equal(run.plan.kind, 'facts');
  assert.notEqual(run.planned?.drawn, true);
});

test('the planned journal line marks a drawn kind', async () => {
  // Bug: the journal cannot tell a drawn kind from one the planner or the owner chose.
  const run = await prepare({ rng: FIRST });
  assert.equal(run.planned?.drawn, true);
});

// The judge reads each brief against her last entries of the kind; a brief it finds repeated goes back to the planner.
const STATUS_POSTS = postsOf(['status', 'thought', 'status']);
const briefOf = (brief: string) => ({ kind: 'status', brief, search: '', picture: false, seed: 0 });
const REPEATS = { repeats: true, what: 'REASON-ONE' };
const PASSES = { repeats: false, what: '' };
const purposes = (run: PrepareRun): Array<string> => run.requests.map((request) => request.purpose);

test('a brief the judge passes sends one judge request with the brief and the entries and no second plan', async () => {
  // Bug: the judge is skipped, reads something else than the brief and her entries of the kind, or the planner is asked again.
  const run = await prepare({ rng: FIRST, forcedKind: 'status', posts: STATUS_POSTS, answers: [briefOf('BRIEF-A')] });
  assert.deepEqual(purposes(run), ['diary-planner', 'diary-judge']);
  const [, judge] = run.requests;
  const judged = judge?.text ?? '';
  assert.ok(judged.includes('BRIEF-A'), judged);
  assert.ok(judged.includes('an earlier status post'), judged);
  assert.ok(!judged.includes('an earlier thought post'), 'no entry of another kind');
  assert.equal(run.plan.brief, 'BRIEF-A');
});

test('a repeated brief sends the planner the rejected brief and the reason, and the new brief is judged', async () => {
  // Bug: the planner is asked again without knowing what repeated, or its new brief goes out unjudged.
  const run = await prepare({
    rng: FIRST,
    forcedKind: 'status',
    posts: STATUS_POSTS,
    answers: [briefOf('BRIEF-A'), briefOf('BRIEF-B')],
    verdicts: [REPEATS, PASSES],
  });
  assert.deepEqual(purposes(run), ['diary-planner', 'diary-judge', 'diary-planner', 'diary-judge']);
  const [, , replan, rejudge] = run.requests;
  const again = replan?.text ?? '';
  const rejected = again.slice(again.indexOf('<rejected>'), again.indexOf('</rejected>'));
  assert.ok(rejected.includes('BRIEF-A') && rejected.includes('REASON-ONE'), again);
  assert.ok((rejudge?.text ?? '').includes('BRIEF-B'));
  assert.equal(run.plan.brief, 'BRIEF-B');
  assert.deepEqual(run.plan.judge, { briefs: 2, passed: true });
});

test('the third brief ends the step though the judge finds it repeated', async () => {
  // Bug: the step asks the planner without end, or drops the entry when every brief repeats.
  const run = await prepare({
    rng: FIRST,
    forcedKind: 'status',
    posts: STATUS_POSTS,
    answers: [briefOf('BRIEF-A'), briefOf('BRIEF-B'), briefOf('BRIEF-C')],
    verdicts: [REPEATS],
  });
  const plans = purposes(run).filter((purpose) => purpose === 'diary-planner');
  assert.equal(plans.length, 3);
  assert.equal(run.plan.brief, 'BRIEF-C');
  assert.deepEqual(run.plan.judge, { briefs: 3, passed: false });
  const line = run.logs.find((entry) => entry.msg === 'diary: judged');
  assert.equal(line?.briefs, 3);
  assert.equal(line?.passed, false);
});

test('a judge request that fails keeps the brief it was given', async () => {
  // Bug: a provider error of the judge loses the plan or asks the planner again.
  const run = await prepare({
    rng: FIRST,
    forcedKind: 'status',
    posts: STATUS_POSTS,
    answers: [briefOf('BRIEF-A')],
    verdicts: ['fail'],
  });
  assert.deepEqual(purposes(run), ['diary-planner', 'diary-judge']);
  assert.equal(run.plan.brief, 'BRIEF-A');
  assert.equal(run.plan.fallback, false);
  assert.ok(run.logs.some((entry) => entry.msg === 'diary: judge failed'));
  assert.equal(run.plan.judge, undefined, 'a judge that gave no verdict leaves none on the plan');
});

test('no stored entry of the kind sends no judge request', async () => {
  // Bug: the judge is asked with nothing to compare, and an empty list passes or rejects at random.
  const run = await prepare({ rng: FIRST, forcedKind: 'status', posts: postsOf(['thought']) });
  assert.deepEqual(purposes(run), ['diary-planner']);
  assert.equal(run.plan.judge, undefined);
});
