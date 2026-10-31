// The board's operations as commands of the core (src/board/commands.ts): `createTaskCommands(...).run(principal,
// name, args)` answers one `task.*` command with a status, its text and its data. The board's own rights decide
// every call; the command layer adds the scheduling of the dispatcher (`task.next`: the first ready task of a role,
// skipping a blocked, a deferred and a brief-waiting one), the events after a sequence number (`task.events`), and
// one rule of the socket: a holder call without a `generation` is refused before the board writes anything. A memory
// database in memory, a fake clock, synthetic principals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.js';
import { openBoard } from '../src/board/board.ts';
import type { Board, BoardSettings, EventRow, Handoff, TaskRecord } from '../src/board/board.ts';
import { createTaskCommands } from '../src/board/commands.ts';
import type { TaskAnswer } from '../src/board/commands.ts';
import type { BoardDb } from '../src/board/schema.ts';
import { tempDir } from './fixtures/tmp.js';

const NOW = Date.parse('2026-10-31T10:00:00.000Z');
const MINUTE = 60000;
const BRIEF_WAIT_MS = 30 * MINUTE;
const SETTINGS: BoardSettings = {
  leaseTtlMinutes: 30,
  autoTriage: { role: 'dev', budget: 4, steps: 80, estimate: 30 },
  projects: {},
};
const CLIENTS: Record<string, ReadonlyArray<string>> = {
  boss: ['owner'],
  rev: ['reviewer'],
  hand: ['worker'],
  hand2: ['worker'],
};
const HANDOFF: Handoff = {
  result: 'The parser reads the new tag.',
  evidence: ['the parser tests pass 12 of 12'],
  artifacts: ['src/parser.ts'],
  tests: [{ command: 'node --test tests/parser.test.ts', passed: 12, failed: 0 }],
  open_issues: [],
};

// open.js types its connection as `object`; it is node:sqlite's DatabaseSync, which has every method BoardDb names.
const dbOf = (handle: { db: object }): BoardDb => handle.db as BoardDb;

type Rig = {
  board: Board;
  run: (principal: string, name: string, args?: Record<string, unknown>) => Promise<TaskAnswer>;
  advance: (minutes: number) => void;
};

function setUp(t: { after: (fn: () => void) => void }): Rig {
  const dir = tempDir('nep-board-commands-');
  const entries = Object.fromEntries(
    Object.entries(CLIENTS).map(([name, boardRoles]) => [
      name,
      { kind: 'agent', tokenFile: `clients/${name}.token`, permissions: [], boardRoles },
    ])
  );
  fs.writeFileSync(path.join(dir, 'clients.json'), JSON.stringify(entries));
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  let now = NOW;
  const board = openBoard({ db: dbOf(handle), privateDir: dir, now: () => now, settings: () => SETTINGS });
  const commands = createTaskCommands({ board: () => board, briefWaitMs: () => BRIEF_WAIT_MS });
  return {
    board,
    run: (principal, name, args = {}) => commands.run(principal, name, args),
    advance: (minutes) => {
      now += minutes * MINUTE;
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The task record an answer's data carries; fails the test when it carries none. */
function taskOf(answer: TaskAnswer): TaskRecord {
  assert.equal(answer.status, 'ok', `the command answered ${answer.status}: ${answer.text}`);
  assert.ok(isRecord(answer.data) && typeof answer.data.id === 'string', 'the data is a task');
  // A task.next or task.claim answer's data is the TaskRecord the board returned.
  return answer.data as TaskRecord;
}

/** A dev task for `role` filed by the owner with `extra`, triaged and approved. */
function approvedTask(board: Board, extra: Record<string, unknown> = {}, role = 'dev'): TaskRecord {
  const added = board.call('boss', 'task.add', { title: 'a task', lane: 'dev', project: 'core', ...extra });
  const triaged = board.call('boss', 'task.transition', {
    id: added.id,
    status: 'triaged',
    revision: added.revision,
    set: { role, estimate: 20, budget: 2 },
  });
  return board.call('boss', 'task.approve', { id: triaged.id, scope: 'plan' }).task;
}

const eventCount = (board: Board): number => board.eventsSince(0).length;

// ---------- task.next ----------

test('task.next claims the ready task of the role with the lowest priority number first, then the older one', async (t) => {
  const { board, run, advance } = setUp(t);
  const older = approvedTask(board, { title: 'older', priority: 3 });
  advance(1);
  const urgent = approvedTask(board, { title: 'urgent', priority: 1 });
  advance(1);
  const newer = approvedTask(board, { title: 'newer', priority: 3 });
  const first = taskOf(await run('hand', 'task.next', { lane: 'dev', role: 'dev' }));
  assert.equal(first.id, urgent.id);
  assert.equal(first.status, 'in_progress');
  assert.equal(first.lease_owner, 'hand');
  assert.equal(first.lease_generation, board.call('boss', 'task.show', { id: urgent.id }).task.lease_generation);
  assert.equal(taskOf(await run('hand', 'task.next', { lane: 'dev', role: 'dev' })).id, older.id);
  assert.equal(taskOf(await run('hand', 'task.next', { lane: 'dev', role: 'dev' })).id, newer.id);
});

test('task.next never hands out a task triaged for another role', async (t) => {
  const { board, run } = setUp(t);
  const other = approvedTask(board, { priority: 1 }, 'docs');
  const mine = approvedTask(board, { priority: 2 }, 'dev');
  assert.equal(taskOf(await run('hand', 'task.next', { lane: 'dev', role: 'dev' })).id, mine.id);
  assert.equal(board.call('boss', 'task.show', { id: other.id }).task.status, 'approved');
});

test('task.next skips a task held up by an open blocker and a deferred task', async (t) => {
  const { board, run } = setUp(t);
  const blocker = board.call('boss', 'task.add', { title: 'blocker', lane: 'dev', project: 'core' });
  const held = approvedTask(board, { title: 'held', priority: 1 });
  board.call('boss', 'task.depend', { id: held.id, on: blocker.id, type: 'blocks' });
  approvedTask(board, { title: 'deferred', priority: 1, defer_until: '2026-11-02T00:00:00.000Z' });
  const plain = approvedTask(board, { title: 'plain', priority: 5 });
  assert.equal(taskOf(await run('hand', 'task.next', { lane: 'dev', role: 'dev' })).id, plain.id);
});

test('task.next answers ok with no task and writes nothing when no task is ready', async (t) => {
  const { board, run } = setUp(t);
  board.call('boss', 'task.add', { title: 'only proposed', lane: 'dev', project: 'core' });
  const before = eventCount(board);
  const answer = await run('hand', 'task.next', { lane: 'dev', role: 'dev' });
  assert.equal(answer.status, 'ok');
  assert.equal(answer.data, null);
  assert.equal(eventCount(board), before);
});

test('task.next without a role is invalid and claims nothing', async (t) => {
  const { board, run } = setUp(t);
  const task = approvedTask(board);
  assert.equal((await run('hand', 'task.next', { lane: 'dev' })).status, 'invalid');
  assert.equal(board.call('boss', 'task.show', { id: task.id }).task.status, 'approved');
});

/**
 * A task whose worker asked the owner a question, ended its attempt on it, got the owner's answer and handed the
 * lease back: approved again, with the answer not yet acted on by a reviewer.
 */
function answeredTask(board: Board, advance: (minutes: number) => void): TaskRecord {
  const held = board.call('hand', 'task.claim', { id: approvedTask(board).id });
  const generation = held.lease_generation;
  const attempt = board.call('hand', 'attempt.start', { task_id: held.id, generation });
  board.call('hand', 'task.ask', { id: held.id, generation, to_whom: 'owner', text: 'Which tag wins?' });
  board.call('hand', 'attempt.end', { attempt_id: attempt.id, generation, outcome: 'needs_answer' });
  advance(1);
  const question = board.call('boss', 'task.show', { id: held.id }).questions[0];
  board.call('boss', 'task.answer', { question_id: question?.id, text: 'The new one.' });
  return board.call('hand', 'task.release', { id: held.id, generation });
}

test('task.next skips a task whose answer no reviewer has acted on, and hands it out after the reviewer comments', async (t) => {
  const { board, run, advance } = setUp(t);
  const waiting = answeredTask(board, advance);
  assert.equal(waiting.status, 'approved');
  advance(5);
  assert.equal((await run('hand2', 'task.next', { lane: 'dev', role: 'dev' })).data, null);
  board.call('rev', 'task.comment', { id: waiting.id, text: 'Brief: keep the new tag only.' });
  assert.equal(taskOf(await run('hand2', 'task.next', { lane: 'dev', role: 'dev' })).id, waiting.id);
});

test('task.next hands out a brief-waiting task once the brief wait has passed since the answer', async (t) => {
  const { board, run, advance } = setUp(t);
  const waiting = answeredTask(board, advance);
  advance(29);
  assert.equal((await run('hand2', 'task.next', { lane: 'dev', role: 'dev' })).data, null);
  advance(1);
  assert.equal(taskOf(await run('hand2', 'task.next', { lane: 'dev', role: 'dev' })).id, waiting.id);
});

// ---------- the generation of a holder call ----------

test('a holder call without a generation is refused invalid and the board writes nothing', async (t) => {
  const { board, run } = setUp(t);
  const held = board.call('hand', 'task.claim', { id: approvedTask(board).id });
  const attempt = board.call('hand', 'attempt.start', { task_id: held.id, generation: held.lease_generation });
  const calls: Array<[string, Record<string, unknown>]> = [
    ['task.heartbeat', { id: held.id }],
    ['task.release', { id: held.id }],
    ['task.block', { id: held.id, reason: 'the spec is missing', unblocks: 'the spec' }],
    ['task.submit', { id: held.id, handoff: HANDOFF }],
    ['task.result', { id: held.id, kind: 'summary', body: 'done', submit: true }],
    ['task.ask', { id: held.id, to_whom: 'owner', text: 'Which tag?' }],
    ['task.attempt.end', { attempt_id: attempt.id, outcome: 'done' }],
  ];
  const before = eventCount(board);
  for (const [name, args] of calls) {
    assert.equal((await run('hand', name, args)).status, 'invalid', `${name} without a generation`);
  }
  assert.equal(eventCount(board), before);
  const after = board.call('boss', 'task.show', { id: held.id });
  assert.equal(after.task.status, 'in_progress');
  assert.equal(after.task.lease_owner, 'hand');
  assert.equal(after.attempts[0]?.ended_at, null);
});

test('the same holder call with its generation goes through', async (t) => {
  const { board, run } = setUp(t);
  const held = board.call('hand', 'task.claim', { id: approvedTask(board).id });
  const answer = await run('hand', 'task.submit', { id: held.id, generation: held.lease_generation, handoff: HANDOFF });
  assert.equal(answer.status, 'ok', answer.text);
  assert.equal(board.call('boss', 'task.show', { id: held.id }).task.status, 'needs_validation');
});

test('a result by an editor that does not hold the lease needs no generation', async (t) => {
  const { board, run } = setUp(t);
  const held = board.call('hand', 'task.claim', { id: approvedTask(board).id });
  const answer = await run('boss', 'task.result', { id: held.id, kind: 'file', uri: 'file:///notes.md' });
  assert.equal(answer.status, 'ok', answer.text);
  assert.equal(board.call('boss', 'task.show', { id: held.id }).results.length, 1);
});

test('a late submit with the generation of a reclaimed lease is refused stale-lease and writes nothing', async (t) => {
  const { board, run, advance } = setUp(t);
  const held = board.call('hand', 'task.claim', { id: approvedTask(board).id });
  advance(31);
  board.reap();
  const again = taskOf(await run('hand2', 'task.next', { lane: 'dev', role: 'dev' }));
  assert.ok(again.lease_generation > held.lease_generation);
  const before = eventCount(board);
  const late = await run('hand', 'task.submit', { id: held.id, generation: held.lease_generation, handoff: HANDOFF });
  assert.equal(late.status, 'stale-lease');
  assert.equal(eventCount(board), before);
  const view = board.call('boss', 'task.show', { id: held.id });
  assert.equal(view.task.status, 'in_progress');
  assert.equal(view.task.lease_owner, 'hand2');
  assert.equal(view.handoff, null);
});

// ---------- the other commands ----------

test('task.events answers the events after the sequence number it is given, in order', async (t) => {
  const { board, run } = setUp(t);
  approvedTask(board);
  const all = board.eventsSince(0);
  const from = all[1]?.seq ?? 0;
  const answer = await run('boss', 'task.events', { from });
  assert.equal(answer.status, 'ok');
  assert.ok(Array.isArray(answer.data));
  const seqs = (answer.data as Array<EventRow>).map((row) => row.seq);
  assert.deepEqual(
    seqs,
    all.filter((row) => row.seq > from).map((row) => row.seq)
  );
});

test('a command with json set answers its data as JSON text, and task.add without it answers the new id', async (t) => {
  const { run } = setUp(t);
  const plain = await run('boss', 'task.add', { title: 'plain', lane: 'dev', project: 'core' });
  assert.equal(plain.status, 'ok');
  assert.ok(isRecord(plain.data));
  assert.equal(plain.text.trim(), plain.data.id);
  const json = await run('boss', 'task.add', { title: 'json', lane: 'dev', project: 'core', json: true });
  assert.deepEqual(JSON.parse(json.text), json.data);
});

test('a command retried under the same idempotency key answers the first task and files one', async (t) => {
  const { board, run } = setUp(t);
  const args = { title: 'once', lane: 'dev', project: 'core', idempotency: 'k-1' };
  const first = await run('boss', 'task.add', args);
  const second = await run('boss', 'task.add', args);
  assert.ok(isRecord(first.data) && isRecord(second.data));
  assert.equal(second.data.id, first.data.id);
  assert.equal(board.call('boss', 'task.list', {}).length, 1);
});

test('a board op outside the task namespace is reached as a task command', async (t) => {
  const { board, run } = setUp(t);
  const held = board.call('hand', 'task.claim', { id: approvedTask(board).id });
  const answer = await run('hand', 'task.attempt.start', { task_id: held.id, generation: held.lease_generation });
  assert.equal(answer.status, 'ok', answer.text);
  assert.equal(board.call('boss', 'task.show', { id: held.id }).attempts.length, 1);
});

test("a refusal answers the board's code and the board's rights decide: a worker may not approve", async (t) => {
  const { board, run } = setUp(t);
  const added = board.call('boss', 'task.add', { title: 'a task', lane: 'dev', project: 'core' });
  const triaged = board.call('boss', 'task.transition', {
    id: added.id,
    status: 'triaged',
    revision: added.revision,
    set: { role: 'dev', estimate: 20, budget: 2 },
  });
  const answer = await run('hand', 'task.approve', { id: triaged.id, scope: 'plan' });
  assert.equal(answer.status, 'forbidden');
  assert.equal(answer.data, null);
  assert.equal(board.call('boss', 'task.show', { id: triaged.id }).task.status, 'triaged');
});

test('an unknown task command is invalid', async (t) => {
  const { run } = setUp(t);
  assert.equal((await run('boss', 'task.frobnicate', {})).status, 'invalid');
});

test('every command answers board-unavailable while the core has no board', async () => {
  const commands = createTaskCommands({ board: () => null, briefWaitMs: () => BRIEF_WAIT_MS });
  assert.equal((await commands.run('boss', 'task.list', {})).status, 'board-unavailable');
});
