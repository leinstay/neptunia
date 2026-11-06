// The pure half of the plan fill for old diary entries (src/memory/db/selfreflection-plan-fill.ts): the JSON schema the
// analyzer answers by, built from the seed families of prompts/selfreflection-seeds.md, and the plan a parsed answer
// stores. A scene entry names one line of each family, so its answer can only pick real lines; an entry with no scene
// gets a brief alone. Invented families and lines only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFillSchema, planFromAnswer } from '../src/memory/db/selfreflection-plan-fill.ts';

const FAMILIES: Record<string, Array<string>> = {
  place: ['a harbour town', 'a mountain village'],
  setting: ['an attic room', 'a ferry deck'],
  detail: ['a cracked teacup', 'a paper lantern'],
  activity: ['sorting old letters', 'feeding pigeons'],
  subject: ['a stray cat', 'a broken clock'],
  twist: ['it starts to snow', 'the power goes out'],
};
const ORDER = ['place', 'setting', 'detail', 'activity', 'subject', 'twist'];
const BRIEF = 'an afternoon spent clearing out a cupboard';

/** A full answer for a scene entry: the second line of every family, keys in an order other than the families'. */
const fullAnswer = (): Record<string, unknown> => ({
  twist: 'the power goes out',
  brief: BRIEF,
  subject: 'a broken clock',
  place: 'a mountain village',
  activity: 'feeding pigeons',
  setting: 'a ferry deck',
  detail: 'a paper lantern',
});

type Field = { type?: unknown; enum?: unknown };
type Shape = { type?: unknown; properties?: Record<string, Field>; required?: unknown; additionalProperties?: unknown };

/** The schema as the tests read it: a JSON schema object. */
function shapeOf(schema: object): Shape {
  return schema;
}

/** The fields of a schema, by name. */
function fieldsOf(schema: object): Record<string, Field> {
  const { properties } = shapeOf(schema);
  assert.ok(properties, 'the schema names its fields');
  return properties;
}

// ---------- planFillSchema ----------

test('a scene schema makes each family field an enum of exactly that family lines', () => {
  // Bug: a field takes the lines of a neighbouring family or every line, so the model names a setting as a place.
  const fields = fieldsOf(planFillSchema(FAMILIES, true));
  for (const family of ORDER) {
    const field = fields[family];
    assert.ok(field, family);
    assert.deepEqual(field.enum, FAMILIES[family], family);
  }
});

test('a scene schema asks for the brief as a string beside the six families and nothing else', () => {
  // Bug: the brief is left out of the scene schema, or a stray field invites the model to answer more than is stored.
  const fields = fieldsOf(planFillSchema(FAMILIES, true));
  assert.deepEqual(Object.keys(fields).sort(), ['brief', ...ORDER].sort());
  const { brief } = fields;
  assert.equal(brief?.type, 'string');
});

test('a scene-less schema holds the brief alone', () => {
  // Bug: a thought entry is asked for seed lines it never built on, and the fill invents a scene for it.
  const schema = planFillSchema(FAMILIES, false);
  assert.deepEqual(Object.keys(fieldsOf(schema)), ['brief']);
  assert.deepEqual(shapeOf(schema).required, ['brief']);
});

test('the schema is a strict object: every field required and no other field allowed', () => {
  // Bug: a strict json_schema request with optional fields or open properties is refused by the provider, or lets the
  // model leave a family out.
  for (const scene of [true, false]) {
    const schema = planFillSchema(FAMILIES, scene);
    const shape = shapeOf(schema);
    assert.equal(shape.type, 'object');
    assert.equal(shape.additionalProperties, false);
    const required = Array.isArray(shape.required) ? [...(shape.required as Array<string>)].sort() : null;
    assert.deepEqual(required, Object.keys(fieldsOf(schema)).sort(), String(scene));
  }
});

test('the schema follows the families it is given, whatever their names', () => {
  // Bug: the six family names are written into the code, so a seeds file with other headers builds a schema of lines
  // that do not exist.
  const families = { weather: ['light rain', 'heavy fog'], hour: ['dawn'] };
  const fields = fieldsOf(planFillSchema(families, true));
  assert.deepEqual(Object.keys(fields).sort(), ['brief', 'hour', 'weather']);
  const { hour } = fields;
  assert.deepEqual(hour?.enum, ['dawn']);
});

// ---------- planFromAnswer ----------

test('a full answer gives one combination in the families order with seed 1, marked reconstructed', () => {
  // Bug: the lines are stored in the answer's key order, so usedSeedLines and the <diary> read a shuffled combination,
  // or the seed stays 0 and the lines never count as taken.
  assert.deepEqual(planFromAnswer(fullAnswer(), FAMILIES, true), {
    brief: BRIEF,
    seeds: [
      [
        'a mountain village',
        'a ferry deck',
        'a paper lantern',
        'feeding pigeons',
        'a broken clock',
        'the power goes out',
      ],
    ],
    seed: 1,
    reconstructed: true,
  });
});

test('a line of another family gives null', () => {
  // Bug: membership is checked against all lines, so an answer that names a setting as its place is stored.
  const answer = { ...fullAnswer(), place: 'an attic room' };
  assert.equal(planFromAnswer(answer, FAMILIES, true), null);
});

test('a line no family holds gives null', () => {
  // Bug: a provider that ignores the schema invents a line, and the diary stores a seed that was never offered.
  const answer = { ...fullAnswer(), detail: 'a silver locket' };
  assert.equal(planFromAnswer(answer, FAMILIES, true), null);
});

test('a scene answer with a family missing gives null', () => {
  // Bug: a half answer is stored as a combination of five lines, and the next draw reads a short seed.
  const answer = fullAnswer();
  delete answer.twist;
  assert.equal(planFromAnswer(answer, FAMILIES, true), null);
});

test('a brief-only answer for an entry with no scene gives no seeds and seed 0', () => {
  // Bug: a thought entry gets seed 1 over an empty list, or an empty combination that reads as a taken seed.
  assert.deepEqual(planFromAnswer({ brief: BRIEF }, FAMILIES, false), {
    brief: BRIEF,
    seeds: [],
    seed: 0,
    reconstructed: true,
  });
});

test('an empty or blank brief gives null', () => {
  // Bug: an entry is marked as filled with no brief, so the second run skips it and it stays empty for good.
  assert.equal(planFromAnswer({ ...fullAnswer(), brief: '' }, FAMILIES, true), null);
  assert.equal(planFromAnswer({ brief: '   ' }, FAMILIES, false), null);
});

test('an answer that is not an object or has no string brief gives null', () => {
  // Bug: a parse that returned an array, a string or a number brief throws inside the run and stops every later entry.
  assert.equal(planFromAnswer(null, FAMILIES, false), null);
  assert.equal(planFromAnswer('a brief', FAMILIES, false), null);
  assert.equal(planFromAnswer([BRIEF], FAMILIES, false), null);
  assert.equal(planFromAnswer({ brief: 7 }, FAMILIES, false), null);
});
