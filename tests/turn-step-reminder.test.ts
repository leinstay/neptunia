// Tests for the reminder that a lookup ends (src/turn/tool-round.ts#runSteps, src/behavior/tool-step.ts#stepNote):
// from the Nth answer of a turn that made calls and was followed by another request, the note of every following
// request carries one more line, `task.step.long`, with the count; the request stays a normal one, the final
// request and an inner turn carry none, and `tools.loop.remindAfterSteps` 0 turns it off. Over a real admin and the
// fake interface adapter (tests/fixtures/turn-harness.ts); the model is scripted with native tool calls; the
// label is a marker of the test's own, so no tracked wording is asserted; no network, no data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { NOW, coreTurn, noteText } from './fixtures/turn-harness.ts';
import type { FakeLlm, HotStandIn } from './fixtures/turn-harness.ts';
import { labels } from './fixtures/labels.ts';

/** The admin's runSkillOp as the tests wrap it. */
type RunOp = (key: string, args: unknown, context: unknown) => Promise<Record<string, unknown>>;

/** The reminder as these tests' labels word it, and the pattern that finds it with its count. */
const MARKER = 'REMINDER-MARK {n} answers with calls';
const FOUND = /REMINDER-MARK (\d+) answers with calls/;

/** The native transport, and the fixture labels with `task.step.long` worded as `MARKER`. */
const withMarker = (hot: HotStandIn): void => {
  hot.config.tools.transport = 'native';
  hot.prompts.labels = { ...labels, task: { ...labels.task, step: { ...labels.task.step, long: MARKER } } };
};

/** The count the request `i` is reminded with, null when its note carries no reminder. */
const reminderOf = (llm: FakeLlm, i: number): number | null => {
  const found = FOUND.exec(noteText(llm, i));
  return found ? Number(found[1]) : null;
};

/** The reminder of every request, in order. */
const reminders = (llm: FakeLlm): Array<number | null> => llm.calls.map((_, i) => reminderOf(llm, i));

/** `n` answers with one read each (alternating two skills), then speech. */
const reads = (n: number): Array<unknown> => [
  ...Array.from({ length: n }, (_, i) =>
    toolAnswer(`<think>${i + 1}</think>`, [call(i % 2 === 0 ? 'lore.list' : 'memory.server.read', {}, { id: `r${i}` })])
  ),
  '<think>end</think><msg>τέλος</msg>',
];

/** The loop bounds of a test: every one set, `remindAfterSteps` as given. */
const loopOf = (remindAfterSteps: number, maxSteps = 10): Record<string, unknown> => ({
  maxSteps,
  timeBudgetMs: 20000,
  maxCallsPerStep: 4,
  stepReserveTokens: 0,
  remindAfterSteps,
});

const ROOMY = { llm: { maxRequestTokens: 50000 } };

test('sends no reminder before the Nth lookup step', async () => {
  const run = await coreTurn({ answers: reads(2), loop: loopOf(3), config: ROOMY, withHot: withMarker });
  assert.equal(run.llm.calls.length, 3, 'two reads and the request after the second');
  assert.deepEqual(reminders(run.llm), [null, null, null]);
});

test('sends the reminder on the request after the Nth lookup step and not on the one before', async () => {
  const run = await coreTurn({ answers: reads(3), loop: loopOf(2), config: ROOMY, withHot: withMarker });
  assert.equal(run.llm.calls.length, 4, 'three reads and the request after the third');
  assert.deepEqual(reminders(run.llm).slice(0, 3), [null, null, 2], 'the third request carries the count 2');
});

test('keeps sending the reminder on later steps with the count rising', async () => {
  const run = await coreTurn({ answers: reads(4), loop: loopOf(2), config: ROOMY, withHot: withMarker });
  assert.equal(run.llm.calls.length, 5, 'four reads and the request after the fourth');
  assert.deepEqual(reminders(run.llm), [null, null, 2, 3, 4]);
});

test('leaves the request with the reminder a normal one and runs the call in its answer', async () => {
  const ran: Array<string> = [];
  const run = await coreTurn({
    answers: reads(3),
    loop: loopOf(1),
    config: ROOMY,
    withHot: withMarker,
    wrapCommand: (runOp: RunOp) => (key: string, args: unknown, context: unknown) => {
      ran.push(key);
      return runOp(key, args, context);
    },
  });
  const { llm } = run;
  assert.equal(reminderOf(llm, 1), 1, 'the second request carries the reminder');
  assert.notEqual(llm.options[1].toolChoice, 'none', 'it may still call');
  assert.equal(ran.length, 3, `the call in the answer to it ran: ${ran.join(', ')}`);
  assert.equal(llm.calls.length, 4);
});

test('sends no reminder when remindAfterSteps is 0', async () => {
  const run = await coreTurn({ answers: reads(5), loop: loopOf(0), config: ROOMY, withHot: withMarker });
  assert.equal(run.llm.calls.length, 6, 'five reads and the request after the fifth');
  assert.ok(
    reminders(run.llm).every((count) => count === null),
    `no request is reminded: ${reminders(run.llm).join(', ')}`
  );
});

test('sends no reminder in an inner turn', async () => {
  const wake = {
    kind: 'intention_due',
    items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], errandId: null }],
    intentions: [{ id: 'i1', purpose: 'κοίτα τα νέα', dueAt: NOW - 60_000 }],
    now: NOW,
    timezone: 'UTC',
    channels: [],
  };
  const inner = loopOf(1, 8);
  const run = await coreTurn({
    answers: [...reads(3).slice(0, 3), '<skip/>'],
    allowed: ['lore.list', 'memory.server.read', 'message.create'],
    inner: wake,
    loop: inner,
    config: { wakes: { mode: 'live', chatMessages: 2, loop: inner }, ...ROOMY },
    prompts: { inner: 'Do what the wake says.' },
    withHot: withMarker,
  });
  assert.equal(run.llm.calls.length, 4, 'three reads and the request after the third');
  assert.deepEqual(reminders(run.llm), [null, null, null, null]);
});

test('sends no reminder on the final request when maxSteps is reached at the step the reminder is due', async () => {
  const run = await coreTurn({ answers: reads(2), loop: loopOf(2, 2), config: ROOMY, withHot: withMarker });
  const { llm } = run;
  assert.equal(llm.calls.length, 3, 'two reads and the final request');
  assert.equal(llm.options[2].toolChoice, 'none', 'the third request is the final one');
  assert.notEqual(noteText(llm, 2), '', 'it carries the last-step note');
  assert.equal(reminderOf(llm, 2), null, 'and no reminder');
});
