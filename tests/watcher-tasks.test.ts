// The watcher's task filer (src/watcher/tasks.ts): the agent ends its answer with one ```tasks block, a JSON array of
// { kind, title, evidence, done }. `splitAnswer` separates it from the report; `fileTasks` files each draft on the
// board as the principal `watcher` unless the same evidence was already filed (open, or filed today or yesterday).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileTasks, splitAnswer } from '../src/watcher/tasks.ts';
import type { TaskDraft } from '../src/watcher/tasks.ts';
import { fakeBoard, reportText, taskRow, tasksBlock } from './fixtures/watcher-rig.ts';

const NOW = Date.parse('2026-11-02T00:05:00Z');
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

test('fileTasks files a draft as the principal watcher with the evidence, the done-criterion and the kind', async () => {
  const fake = fakeBoard();
  const result = await fileTasks({ board: fake.board, drafts: [DRAFT], now: () => NOW });
  assert.deepEqual(
    result.filed.map((one) => [one.kind, one.title]),
    [['fix', DRAFT.title]]
  );
  const [call] = fake.added();
  assert.ok(call);
  assert.equal(call.principal, 'watcher');
  assert.equal(call.args.title, DRAFT.title);
  assert.equal(call.args.lane, 'dev');
  assert.equal(call.args.acceptance, DRAFT.done);
  assert.ok(String(call.args.description).includes(DRAFT.evidence));
  assert.deepEqual(call.args.metadata, { kind: 'fix', evidence: DRAFT.evidence });
  assert.equal(result.filed[0]?.id, fake.tasks.at(-1)?.id, 'the filed id is the one the board gave');
});

test('fileTasks never claims, approves or runs a task: it calls task.list and task.add only', async () => {
  const fake = fakeBoard();
  await fileTasks({
    board: fake.board,
    drafts: [DRAFT, { ...DRAFT, kind: 'chore', title: 'Other', evidence: 'other evidence' }],
    now: () => NOW,
  });
  assert.deepEqual([...new Set(fake.calls.map((call) => call.op))].sort(), ['task.add', 'task.list']);
});

test('a task filed yesterday for the same evidence is not filed again, whatever its state', async () => {
  const yesterday = taskRow({
    id: 'T-old001',
    status: 'done',
    created_at: '2026-11-01T00:03:00.000Z',
    metadata: { kind: 'fix', evidence: DRAFT.evidence },
  });
  const fake = fakeBoard([yesterday]);
  const result = await fileTasks({ board: fake.board, drafts: [DRAFT], now: () => NOW });
  assert.deepEqual(result.filed, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(fake.added().length, 0);
});

test('the same evidence is matched through case and spacing, so a reworded line does not slip past', async () => {
  const yesterday = taskRow({
    id: 'T-old002',
    created_at: '2026-11-01T00:03:00.000Z',
    metadata: { kind: 'fix', evidence: `  ${DRAFT.evidence.toUpperCase().replaceAll(' ', '   ')} ` },
  });
  const fake = fakeBoard([yesterday]);
  const result = await fileTasks({ board: fake.board, drafts: [DRAFT], now: () => NOW });
  assert.equal(result.filed.length, 0);
});

test('an open task for the same evidence blocks a new one however old it is', async () => {
  const old = taskRow({
    id: 'T-old003',
    status: 'approved',
    created_at: '2026-10-20T00:03:00.000Z',
    metadata: { kind: 'fix', evidence: DRAFT.evidence },
  });
  const fake = fakeBoard([old]);
  assert.equal((await fileTasks({ board: fake.board, drafts: [DRAFT], now: () => NOW })).filed.length, 0);
});

test('a closed task from five days ago does not block: the problem came back, so it is filed again', async () => {
  const old = taskRow({
    id: 'T-old004',
    status: 'done',
    created_at: '2026-10-28T00:03:00.000Z',
    metadata: { kind: 'fix', evidence: DRAFT.evidence },
  });
  const fake = fakeBoard([old]);
  assert.equal((await fileTasks({ board: fake.board, drafts: [DRAFT], now: () => NOW })).filed.length, 1);
});

test('other evidence is filed even when a task of the watcher was filed yesterday', async () => {
  const yesterday = taskRow({
    id: 'T-old005',
    created_at: '2026-11-01T00:03:00.000Z',
    metadata: { kind: 'fix', evidence: 'something else' },
  });
  const fake = fakeBoard([yesterday]);
  assert.equal((await fileTasks({ board: fake.board, drafts: [DRAFT], now: () => NOW })).filed.length, 1);
});

test("only the watcher's own tasks count for the check: another requester's task with that evidence does not block", async () => {
  const theirs = taskRow({
    id: 'T-oth001',
    requester: 'persona:self',
    created_at: '2026-11-01T00:03:00.000Z',
    metadata: { kind: 'fix', evidence: DRAFT.evidence },
  });
  const fake = fakeBoard([theirs]);
  assert.equal((await fileTasks({ board: fake.board, drafts: [DRAFT], now: () => NOW })).filed.length, 1);
});

test('the same evidence twice in one answer is filed once', async () => {
  const fake = fakeBoard();
  const result = await fileTasks({
    board: fake.board,
    drafts: [DRAFT, { ...DRAFT, title: 'Same thing again' }],
    now: () => NOW,
  });
  assert.equal(result.filed.length, 1);
  assert.equal(result.skipped.length, 1);
});

test('a board refusal reaches the caller, so the run is marked failed instead of looking filed', async () => {
  const fake = fakeBoard([], { failAdd: new Error('watcher may only read the board') });
  await assert.rejects(fileTasks({ board: fake.board, drafts: [DRAFT], now: () => NOW }), /may only read/);
});
