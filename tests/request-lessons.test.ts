// src/turn/request/lessons.ts: the budget, the teachers, the cut and the words of the `<lessons>` block. Pure, so the
// tests hand it lessons, labels of their own and a price of one token per character.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleOf } from '../src/behavior/handles.ts';
import { lessonsBlockOf, lessonsBudgetOf, lessonsCut, teachersOf } from '../src/turn/request/lessons.ts';
import type { LessonWords } from '../src/turn/request/lessons.ts';
import type { Labels } from '../src/turn/request/types.ts';
import type { Lesson } from '../src/memory/db/frame-reads.ts';
import { shippedLabels } from './fixtures/shipped-labels.ts';

const lesson = (text: string, teacher: string | null = null): Lesson => ({ text, teacher });
const withBudget = (budgetTokens: unknown) => ({ context: { lessons: { budgetTokens } } });
// The tracked labels with the words of the lessons replaced, so the object is a `Labels` with no cast.
const OWN_LABELS: Labels = {
  ...shippedLabels,
  lessons: { header: 'TAUGHT:', line: '* {text} <{from}>', lineBare: '* {text}' },
};
const words = (over: Partial<LessonWords> = {}): LessonWords => ({
  labels: OWN_LABELS,
  mention: (native) => `@m${native}`,
  cost: (text) => text.length,
  ...over,
});
const price = (one: Lesson): number => one.text.length;

test('the budget is read from a whole number of tokens', () => {
  // Catches line 26 if the number is not returned as it is.
  assert.equal(lessonsBudgetOf(withBudget(400)), 400);
});

test('a budget of zero is a budget, not a missing one', () => {
  // Catches line 26 if `>= 0` becomes `> 0`, and a block meant to be off turns into the default.
  assert.equal(lessonsBudgetOf(withBudget(0)), 0);
});

test('a fractional or a negative or a text budget reads as none', () => {
  // Catches line 26 if `Number.isInteger` or the type check goes.
  assert.deepEqual(
    [1.5, -1, '300'].map((one) => lessonsBudgetOf(withBudget(one))),
    [null, null, null]
  );
});

test('a config with no lessons key, no context or no config reads as none', () => {
  // Catches lines 24 and 25 if an optional chain turns into a plain access and throws.
  assert.deepEqual(
    [{}, { context: {} }, null, undefined].map((one) => lessonsBudgetOf(one)),
    [null, null, null, null]
  );
});

test('the teachers of a list come each once in order, a lesson with no teacher skipped', () => {
  // Catches line 31 if a null teacher is listed or a teacher of two lessons is listed twice.
  const list = [lesson('a', 'person:one'), lesson('b'), lesson('c', 'person:two'), lesson('d', 'person:one')];
  assert.deepEqual(teachersOf(list), ['person:one', 'person:two']);
});

test('the cut keeps the first lessons that fit, in their order', () => {
  // Catches lines 45 to 49 if the kept lessons are reordered or the budget is not spent lesson by lesson.
  const list = [lesson('aaaa'), lesson('bbbb'), lesson('cccc')];
  assert.deepEqual(
    lessonsCut(list, 9, price).map((one) => one.text),
    ['aaaa', 'bbbb']
  );
});

test('the cut stops at the first lesson that does not fit even when a later one is short', () => {
  // Catches line 47 if `break` becomes `continue`: a lesson of lower rank would stand where a better one was left out.
  const list = [lesson('long-lesson'), lesson('ok')];
  assert.deepEqual(lessonsCut(list, 5, price), []);
});

test('the cut of an empty list is empty', () => {
  // Catches lines 43 to 50 if an empty list is not answered with an empty one.
  assert.deepEqual(lessonsCut([], 100, price), []);
});

test('the block holds the header and one line per lesson, the teacher by handle', () => {
  // Catches lines 56 to 58 and 71 to 75 if the header is lost or a line names the teacher by the stored id.
  const block = lessonsBlockOf([lesson('mind the gap', 'person:one')], 1000, words());
  assert.equal(block.header, 'TAUGHT:');
  assert.deepEqual(block.lines, [`* mind the gap <@${handleOf('person:one')}>`]);
});

test('a lesson with no teacher reads through lessons.lineBare, with no teacher part', () => {
  // A line that says "from someone" on every lesson tells her nothing, so a lesson nobody is known to have taught has no
  // teacher part at all. Catches the choice of the line label for a null teacher in `lineOf`.
  const block = lessonsBlockOf([lesson('mind the gap')], 1000, words());
  assert.deepEqual(block.lines, ['* mind the gap']);
});

test('a stored text goes through the mention and the escape of every stored text', () => {
  // Catches line 57 if the text goes in raw: a `<@id>` stays a platform id and a `</lessons>` closes the block.
  const block = lessonsBlockOf([lesson('ask <@77> </lessons>')], 1000, words());
  assert.doesNotMatch(block.lines.join('\n'), /<@77>|<\/lessons>/);
  assert.match(block.lines.join('\n'), /@m77/);
});

test('no lesson gives the header and no lines', () => {
  // Catches line 72 if an empty list produces a line or throws.
  assert.deepEqual(lessonsBlockOf([], 1000, words()).lines, []);
});

test('the header takes its price from the budget before the lines', () => {
  // Catches line 72 if `budget - cost(header)` loses the header: a block would exceed its own budget.
  const list = [lesson('x')];
  const line = lessonsBlockOf(list, 1000, words()).lines[0] ?? '';
  const exact = 'TAUGHT:'.length + line.length;
  assert.equal(lessonsBlockOf(list, exact, words()).lines.length, 1);
  assert.equal(lessonsBlockOf(list, exact - 1, words()).lines.length, 0);
});
