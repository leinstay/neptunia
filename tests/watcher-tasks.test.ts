// The watcher's task drafts (src/watcher/tasks.ts): the agent ends its answer with one ```tasks block, a JSON array of
// { kind, title, evidence, done }. `splitAnswer` separates it from the report. Filing them is in
// tests/watcher-filing.test.ts and tests/watcher-filing-board.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitAnswer } from '../src/watcher/tasks.ts';
import type { TaskDraft } from '../src/watcher/tasks.ts';
import { reportText, tasksBlock } from './fixtures/watcher-rig.ts';

const DRAFT: TaskDraft = {
  kind: 'fix',
  title: 'Silent turns skip the journal line',
  evidence: 'src/turn/run.ts:212, 14 silent turns on 2026-11-01 left no journal id',
  done: 'A silent turn writes its journal line; tests/turn-run.test.ts covers it',
};

test('splitAnswer takes the tasks block out of the report and returns the drafts', () => {
  const answer = reportText() + '\n' + tasksBlock([DRAFT]);
  const split = splitAnswer(answer);
  assert.equal(split.ok, true);
  if (!split.ok) return;
  assert.deepEqual(split.tasks, [DRAFT]);
  assert.equal(split.report.includes('```tasks'), false);
  assert.equal(split.report.trim(), reportText().trim());
});

test('an answer with no tasks block has no drafts and its report is the answer', () => {
  const split = splitAnswer(reportText());
  assert.equal(split.ok, true);
  if (split.ok) assert.deepEqual(split.tasks, []);
});

test('a kind other than fix or chore is refused, so the agent cannot file a feature or a decision', () => {
  const split = splitAnswer(reportText() + tasksBlock([{ ...DRAFT, kind: 'feature' }]));
  assert.equal(split.ok, false);
  if (!split.ok) assert.equal(split.code, 'bad-tasks');
});

test('a draft with no evidence or no done-criterion is refused: a task nobody can verify is noise', () => {
  for (const missing of ['evidence', 'done', 'title']) {
    const draft: Record<string, unknown> = { ...DRAFT };
    draft[missing] = '  ';
    const split = splitAnswer(reportText() + tasksBlock([draft]));
    assert.equal(split.ok, false, `${missing} blank`);
  }
});

test('a tasks block that is not JSON, or two tasks blocks, are refused', () => {
  assert.equal(splitAnswer(reportText() + '```tasks\n[not json\n```\n').ok, false);
  assert.equal(splitAnswer(reportText() + tasksBlock([DRAFT]) + tasksBlock([DRAFT])).ok, false);
});
