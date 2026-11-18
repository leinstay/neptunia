// The seeds files of the prompts (src/behavior/seeds.ts): one file per family, one seed per line, the diary's draw
// of combinations and a heartbeat's draw of fragments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawFragments, pickSeeds, seedLines } from '../src/behavior/seeds.ts';
import { promptsInFolder } from '../src/hot.ts';
import { seeded } from './fixtures/diary-prepare.ts';

const seq = (values: ReadonlyArray<number>) => {
  let i = 0;
  return () => values[i++ % values.length] ?? 0;
};

test('seedLines: every non-blank line, trimmed, is one seed, and nothing else is parsed', () => {
  // Bug: a heading line of the old files is read as a family, or a blank line becomes a seed.
  assert.deepEqual(seedLines('a pier\n\n  an alley  \n# not a heading\n'), ['a pier', 'an alley', '# not a heading']);
  assert.deepEqual(seedLines(''), []);
  assert.deepEqual(seedLines(undefined), []);
});

test('pickSeeds: one line per family per set, in header order', () => {
  const families = { place: ['a pier', 'an alley'], twist: ['rain', 'fog', 'snow'] };
  assert.deepEqual(pickSeeds(families, 2, seq([0, 0.99, 0.6, 0.1])), [
    ['a pier', 'snow'],
    ['an alley', 'rain'],
  ]);
});

test('pickSeeds: empty families are skipped', () => {
  assert.deepEqual(
    pickSeeds({ place: [], twist: ['rain'] }, 1, () => 0.5),
    [['rain']]
  );
  assert.deepEqual(
    pickSeeds({ place: [] }, 2, () => 0.5),
    []
  );
  assert.deepEqual(
    pickSeeds({ place: ['a pier'] }, 0, () => 0.5),
    []
  );
});

test('pickSeeds: a used line is never drawn while its family has another line', () => {
  // Bug: the planner is offered the place and the activity of the last entries again, and the diary repeats a scene.
  const families = { place: ['a pier', 'a roof', 'a field'], activity: ['cycling', 'swimming'] };
  const used = new Set(['a pier', 'a roof', 'cycling']);
  const sets = pickSeeds(families, 3, seq([0, 0.5, 0.99, 0.2, 0.7, 0.4]), used);
  assert.deepEqual(sets, [
    ['a field', 'swimming'],
    ['a field', 'swimming'],
    ['a field', 'swimming'],
  ]);
});

test('pickSeeds: a family whose every line is used is drawn from whole', () => {
  // Bug: a family the recent entries used up drops out of the combination, or the whole draw comes back empty.
  const families = { place: ['a pier', 'a roof'], activity: ['cycling', 'swimming'] };
  const used = new Set(['a pier', 'a roof', 'cycling']);
  const [set, ...rest] = pickSeeds(families, 1, () => 0.99, used);
  assert.equal(rest.length, 0);
  assert.equal(set?.length, 2);
  assert.ok(families.place.includes(String(set?.[0])), String(set?.[0]));
  assert.equal(set?.[1], 'swimming');
});

test('pickSeeds: two combinations of one draw share no line while the family has several', () => {
  // Bug: the combinations are drawn independently and one draw offers the same activity twice (2026-11-13).
  const families = { place: ['a pier', 'an alley', 'a roof'], light: ['fog', 'rain', 'snow', 'dusk'] };
  const rng = seeded(7);
  for (let draw = 0; draw < 500; draw += 1) {
    const [first, second] = pickSeeds(families, 2, rng);
    if (!first || !second) assert.fail(`draw ${draw} gave fewer than two combinations`);
    first.forEach((line, family) => assert.notEqual(line, second[family], `draw ${draw}, family ${family}`));
  }
});

test('pickSeeds: a family of one line repeats it while the other families still differ', () => {
  // Bug: the draw refuses the repeat of the single line and comes back short, or drops the family.
  const families = { place: ['a pier', 'an alley', 'a roof'], light: ['fog'] };
  const rng = seeded(11);
  for (let draw = 0; draw < 200; draw += 1) {
    const [first, second] = pickSeeds(families, 2, rng);
    if (!first || !second) assert.fail(`draw ${draw} gave fewer than two combinations`);
    assert.deepEqual([first[1], second[1]], ['fog', 'fog']);
    assert.notEqual(first[0], second[0], `draw ${draw}`);
  }
});

test('pickSeeds: more combinations than lines still gives every combination a line of each family', () => {
  // Bug: a draw without replacement runs out of lines and a combination comes back with a hole.
  const families = { place: ['a pier', 'a roof'], light: ['fog', 'rain', 'snow'] };
  const sets = pickSeeds(families, 3, seeded(3));
  assert.equal(sets.length, 3);
  for (const set of sets) {
    assert.ok(families.place.includes(String(set[0])), String(set[0]));
    assert.ok(families.light.includes(String(set[1])), String(set[1]));
  }
});

test('drawFragments: four different lines of two families, none when no family holds a line', () => {
  // Bug: a heartbeat gets a line of every family, the same line twice, or a block made of nothing.
  const files = { a: 'a1\na2\na3', b: 'b1\nb2', c: 'c1\nc2\nc3', empty: '' };
  const rng = seeded(5);
  for (let draw = 0; draw < 200; draw += 1) {
    const lines = drawFragments(files, rng);
    assert.equal(new Set(lines).size, 4, lines.join(' '));
    assert.equal(new Set(lines.map((line) => line[0])).size, 2, lines.join(' '));
  }
  assert.deepEqual(drawFragments({ a: '', b: '  ' }, rng), []);
  assert.deepEqual(drawFragments({}, rng), []);
});

test("a heartbeat draws from every file of heartbeat/seeds, a deployment's added one included", () => {
  // Bug: the heartbeat's families are a fixed list, so a family a deployment adds with a file is never drawn.
  const prompts = { 'heartbeat/seeds/find': 'f1\nf2', 'heartbeat/seeds/zzown': 'OWN1\nOWN2', 'heartbeat/task': 'T' };
  const rng = seeded(9);
  const seen = new Set<string>();
  for (let draw = 0; draw < 50; draw += 1)
    for (const line of drawFragments(promptsInFolder(prompts, 'heartbeat/seeds'), rng)) seen.add(line);
  assert.deepEqual([...seen].sort(), ['OWN1', 'OWN2', 'f1', 'f2']);
});
