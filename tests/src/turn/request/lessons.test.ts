// src/turn/request/lessons.ts: the budget, the teachers, the cut and the words of the `<lessons>` block. Pure, so the
// tests hand it lessons, labels of their own and a price of one token per character.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { handleOf } from '../../../../src/behavior/handles.ts';
import { lessonsBlockOf, lessonsBudgetOf, lessonsCut, teachersOf } from '../../../../src/turn/request/lessons.ts';
import type { LessonWords } from '../../../../src/turn/request/lessons.ts';
import type { Labels } from '../../../../src/turn/request/types.ts';
import type { Lesson } from '../../../../src/memory/db/frame-reads.ts';
import { shippedLabels } from '../../../fixtures/shipped-labels.ts';
import { addDm, addPerson, type World } from '../../../fixtures/memory-db/mind-world.ts';
import { addPlaceClaim, type PlaceClaim } from '../../../fixtures/memory-db/place-claims.ts';
import { OWNER_PERSON } from '../../../fixtures/owner-accounts.ts';
import { blockOf, ELENI, replyRun, type ReplyStep, serviceWorld, TURN_NOW } from '../../../fixtures/service-turn.ts';
import { useIface } from '../../../fixtures/turn-world.ts';

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
  // A line that says "from someone" on every lesson tells the persona nothing, so a lesson nobody is known to have
  // taught has no teacher part at all. Catches the choice of the line label for a null teacher in `lineOf`.
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

const MIN = 60_000;

const SAY = '<think>STEP 4. So: answer.</think><msg>εντάξει</msg>';

const AGORA = 'fake:server:g1';

const NIKOS = 'person:fake:4242';

const GROUP = { group: 'fake' } as const;

const HANDLE = /@u[0-9a-z]+/;

/** The service world, with Νίκος, who wrote nothing anywhere, and the owner with their command line chat. */
function lessonWorld(): World {
  const world = serviceWorld();
  addPerson(world.db, { id: NIKOS, accounts: [{ id: 'fake:4242', iface: 'fake', native: '4242', names: ['Νίκος'] }] });
  addPerson(world.db, {
    id: OWNER_PERSON,
    accounts: [{ id: 'cli:owner', iface: 'cli', native: 'owner', names: ['Πέτρος'] }],
  });
  addDm(world.db, { iface: 'cli', native: 'owner', person: OWNER_PERSON, account: 'cli:owner' });
  return world;
}

const replyTurnLessonsLesson = (id: string, text: string, over: Partial<PlaceClaim> = {}): PlaceClaim => ({
  id,
  place: AGORA,
  kind: 'lesson',
  text,
  audience: GROUP,
  ...over,
});

const trigger = (id: string, at: number) => ({ id, text: 'καλημέρα', at });

const turn = (id: string, ago: number, before?: () => void): ReplyStep => ({
  ...(before === undefined ? {} : { before }),
  trigger: trigger(id, TURN_NOW - ago * MIN),
  answers: [SAY],
});

const retire = (world: World, id: string): void => {
  world.db.prepare('UPDATE claims SET retired_at = ? WHERE id = ?').run('2026-11-02T11:00:00.000Z', id);
};

/** The requests of reply turns in `c1` over a world holding `claims`, one text per turn. */
async function inRoom(
  claims: ReadonlyArray<PlaceClaim>,
  steps: ReadonlyArray<ReplyStep> = [turn('r2', 1)],
  context: Record<string, unknown> = { lessons: { budgetTokens: 100_000 } },
  setup: (world: World) => void = () => {}
): Promise<Array<string>> {
  const world = lessonWorld();
  try {
    for (const claim of claims) addPlaceClaim(world.db, claim);
    setup(world);
    const run = await replyRun({ world, steps, context });
    return run.requests.map((requests) => requests[0] ?? '');
  } finally {
    world.close();
  }
}

/** The body of `<lessons>` inside `<self>`, '' when absent. */
const lessonsOf = (request: string): string =>
  /<lessons>\n?([\s\S]*?)\n?<\/lessons>/.exec(blockOf(request, 'self'))?.[1] ?? '';

/** The entries of `<people>`, one text each. */
const peopleOf = (request: string): Array<string> =>
  (/<people>\n?([\s\S]*?)\n?<\/people>/.exec(blockOf(request, 'memory'))?.[1] ?? '')
    .split(/\n\s*\n/)
    .filter((entry) => entry.trim() !== '');

const lineWith = (text: string, marker: string): string => text.split('\n').find((line) => line.includes(marker)) ?? '';

describe('lessons in a reply turn', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('each lesson names its teacher by the handle the teacher has in <people>, and the teacher has an entry', async () => {
    // Bug: the lesson names a teacher by a platform id or a display name, or by a handle with no entry behind it, so the persona
    // cannot tell who taught them. Νίκος wrote nothing in the chat, Ελένη wrote in it.
    const [request = ''] = await inRoom([
      replyTurnLessonsLesson('l1', 'ΜΑΘΗΜΑ-ΝΙΚΟΥ', { teacher: NIKOS, weight: 3 }),
      replyTurnLessonsLesson('l2', 'ΜΑΘΗΜΑ-ΕΛΕΝΗΣ', { teacher: ELENI, weight: 2 }),
    ]);
    const body = lessonsOf(request);
    for (const [marker, name] of [
      ['ΜΑΘΗΜΑ-ΝΙΚΟΥ', 'Νίκος'],
      ['ΜΑΘΗΜΑ-ΕΛΕΝΗΣ', 'Ελένη'],
    ]) {
      const entry = peopleOf(request).find((one) => one.includes(name)) ?? '';
      const handle = HANDLE.exec(entry.split('\n')[0] ?? '')?.[0] ?? '';
      assert.match(handle, HANDLE, `${name} has an entry in <people>`);
      assert.ok(lineWith(body, marker).includes(handle), `${marker}: ${lineWith(body, marker)}`);
    }
    assert.doesNotMatch(body, /4242|111|person:/);
  });

  test('a small context.lessons.budgetTokens leaves out the lowest ranked lessons and keeps the others in order', async () => {
    // Bug: the block ignores its own budget (or the self facts' cap stands in for it), or the cut keeps the wrong ones.
    // Each lesson is about 200 ASCII characters, 60 tokens a line: two fit in 160 tokens, three do not.
    const pad =
      ' lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore'.repeat(
        2
      );
    const put = (id: string, weight: number) => replyTurnLessonsLesson(id, `LESSON-${id}${pad}`, { weight });
    const [request = ''] = await inRoom([put('D', 1), put('B', 5), put('A', 9), put('C', 3)], [turn('r2', 1)], {
      lessons: { budgetTokens: 160 },
    });
    const body = lessonsOf(request);
    assert.ok(body.indexOf('LESSON-A') >= 0 && body.indexOf('LESSON-B') > body.indexOf('LESSON-A'), body);
    assert.doesNotMatch(body, /LESSON-C|LESSON-D/);
  });

  test('a retired lesson leaves <lessons>, and the block leaves with the last one', async () => {
    // Bug: the block is kept with its header and no lines, or the retired lesson is held for ever.
    const world = lessonWorld();
    try {
      addPlaceClaim(world.db, replyTurnLessonsLesson('l1', 'ΜΑΘΗΜΑ-ΠΡΩΤΟ'));
      const steps = [turn('r2', 3), turn('r3', 1, () => retire(world, 'l1'))];
      const run = await replyRun({ world, steps, context: { lessons: { budgetTokens: 100_000 } } });
      const [first = '', second = ''] = run.requests.map((requests) => requests[0] ?? '');
      assert.match(lessonsOf(first), /ΜΑΘΗΜΑ-ΠΡΩΤΟ/);
      assert.ok(!blockOf(second, 'self').includes('<lessons>'), blockOf(second, 'self'));
      assert.doesNotMatch(second, /ΜΑΘΗΜΑ-ΠΡΩΤΟ/);
    } finally {
      world.close();
    }
  });

  test('two requests with nothing stored between them hold the same bytes in <lessons>', async () => {
    // Bug: the block carries something that moves between turns (an order of equal ranks, a time), so <self> changes bytes
    // and the cached prefix is rewritten at every turn.
    const claims = ['Α', 'Β', 'Γ', 'Δ'].map((mark, at) =>
      replyTurnLessonsLesson(`l${at}`, `ΜΑΘΗΜΑ-${mark}`, { teacher: at % 2 === 0 ? NIKOS : ELENI })
    );
    const [first = '', second = ''] = await inRoom(claims, [turn('r2', 3), turn('r3', 1)]);
    assert.match(lessonsOf(first), /ΜΑΘΗΜΑ-Α/);
    assert.equal(lessonsOf(second), lessonsOf(first));
  });

  test('a lesson nobody is known to have taught prints with no teacher part', async () => {
    // A line that says "from someone" on every lesson tells the persona nothing, so the line carries neither a handle nor the word
    // for an unknown author.
    const [request = ''] = await inRoom([
      replyTurnLessonsLesson('l1', 'ΜΑΘΗΜΑ-ΑΓΝΩΣΤΟ', { extra: '{"from":"<@null>"}' }),
    ]);
    const line = lineWith(lessonsOf(request), 'ΜΑΘΗΜΑ-ΑΓΝΩΣΤΟ');
    const unknown = shippedLabels.authors?.unknown ?? 'someone';
    assert.match(line, /ΜΑΘΗΜΑ-ΑΓΝΩΣΤΟ/);
    assert.doesNotMatch(line, HANDLE);
    assert.ok(!line.includes(unknown), line);
  });
});
