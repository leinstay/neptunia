// The code draws the kind of a selfreflection post, and the planner writes the post for that kind: the plan request
// offers the drawn kind alone, the plan keeps it whatever kind the planner names, a forced kind still wins, and the
// picture gate keeps the picture kinds out of the draw. The step runs on its own over the fakes of
// tests/fixtures/selfreflection-prepare.ts; a constant `rng` draws the first or the last kind the post may take, in the
// order of SELFREFLECTION_KINDS. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PICTURE_KINDS } from '../src/behavior/selfreflection.ts';
import { prepare, seeded } from './fixtures/selfreflection-prepare.ts';

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

test('with pictures off no picture kind is drawn in two hundred posts', async () => {
  // Bug: the draw runs over every weighted kind, and a picture kind reaches a post that cannot carry one.
  const rng = seeded(11);
  const kinds = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const run = await prepare({
      rng,
      answer: { kind: 'selfPicture', brief: 'a mirror shot', search: '', picture: true, seed: 1 },
    });
    assert.equal(run.offered.length, 1, run.offered.join(', '));
    kinds.add(run.plan.kind ?? 'none');
  }
  assert.deepEqual(
    [...kinds].filter((kind) => DEFAULT_PICTURE_KINDS.includes(kind)),
    []
  );
});

test('with pictures on the draw reaches the picture kinds', async () => {
  // Bug: the draw always runs over the text kinds, so a diary that may carry pictures never posts one.
  const rng = seeded(12);
  const kinds = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const run = await prepare({ rng, pictures: true });
    kinds.add(run.plan.kind ?? 'none');
  }
  assert.ok(
    [...kinds].some((kind) => DEFAULT_PICTURE_KINDS.includes(kind)),
    [...kinds].join(', ')
  );
});

test('a forced kind is offered alone and wins over the draw', async () => {
  // Bug: the draw replaces the kind the owner asked for with `/selfreflection post <kind>`.
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
