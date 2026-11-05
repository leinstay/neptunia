// The one approval contract in the core is the board's: `task.approve` with its scope, decision and revision. Agent runs
// have none: their mode is set beforehand (src/subharness/control.ts), maps to a sandbox (src/subharness/run.ts) and a
// headless backend cannot ask. So src/board/approval-view.ts reads the board's gates, and createApprovalRelay
// (src/tools/approvals.ts) holds them for a panel and hands each answer to the board. All of it runs on a real board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { answerApproval, pendingApprovals } from '../src/board/approval-view.ts';
import type { ApprovalGate } from '../src/board/approval-view.ts';
import { openBoard } from '../src/board/board.ts';
import type { Board, BoardSettings, TaskRecord } from '../src/board/board.ts';
import { createTaskCommands } from '../src/board/commands.ts';
import type { BoardDb } from '../src/board/schema.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { createApprovalRelay } from '../src/tools/approvals.ts';
import { tempDir } from './fixtures/tmp.ts';

const SETTINGS: BoardSettings = {
  leaseTtlMinutes: 30,
  autoTriage: { role: 'dev', budget: 4, steps: 80, estimate: 30 },
  projects: {},
};

const HANDOFF = {
  result: 'The parser reads the new tag.',
  evidence: ['the parser tests pass 12 of 12'],
  artifacts: ['src/parser.ts'],
  tests: [{ command: 'node --test tests/parser.test.ts', passed: 12, failed: 0 }],
  open_issues: [],
};

type Context = { after: (fn: () => void) => void };

function boardRig(t: Context): { board: Board; triaged: TaskRecord } {
  const dir = tempDir('nep-approval-view-');
  const client = (boardRoles: ReadonlyArray<string>) => ({
    kind: 'agent',
    tokenFile: 'clients/x.token',
    permissions: [],
    boardRoles,
  });
  fs.writeFileSync(
    path.join(dir, 'clients.json'),
    JSON.stringify({ boss: client(['owner']), hand: client(['worker']) })
  );
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  const board = openBoard({
    db: handle.db as BoardDb,
    privateDir: dir,
    now: () => Date.parse('2026-11-05T00:00:00Z'),
    settings: () => SETTINGS,
  });
  const added = board.call('boss', 'task.add', { title: 'a task', lane: 'dev', project: 'core' });
  const triaged = board.call('boss', 'task.transition', {
    id: added.id,
    status: 'triaged',
    revision: added.revision,
    set: { role: 'dev', estimate: 20, budget: 2 },
  });
  return { board, triaged };
}

function relayOver(board: Board) {
  const relay = createApprovalRelay({ authorize: (answer) => answerApproval(board, 'boss', answer) });
  return relay;
}

const gateOf = (board: Board): ApprovalGate => {
  const [gate] = pendingApprovals(board, 'boss');
  assert.ok(gate, 'a gate waits');
  return gate;
};

test('a triaged task reads as a plan gate with its title and revision, and reading changes nothing', (t) => {
  // Bug: the panel keeps a second list of what waits for the owner, or a read writes an event.
  const { board, triaged } = boardRig(t);
  const events = board.eventsSince(0).length;
  const gate = gateOf(board);
  assert.equal(gate.taskId, triaged.id);
  assert.equal(gate.scope, 'plan');
  assert.equal(gate.revision, triaged.revision);
  assert.equal(gate.title, 'a task');
  assert.equal(board.eventsSince(0).length, events);
});

test('a task in validation reads as a merge gate that carries its handoff', async (t) => {
  // Bug: the owner approves a merge without the result and the tests the worker handed in.
  const { board, triaged } = boardRig(t);
  const commands = createTaskCommands({ board: () => board, briefWaitMs: () => 1000 });
  const approved = board.call('boss', 'task.approve', { id: triaged.id, scope: 'plan' }).task;
  const held = board.call('hand', 'task.claim', { id: approved.id });
  await commands.run('hand', 'task.submit', { id: held.id, generation: held.lease_generation, handoff: HANDOFF });
  const gate = gateOf(board);
  assert.equal(gate.scope, 'merge');
  assert.deepEqual(gate.handoff, HANDOFF);
});

test('a board with nothing waiting has no gates, and a task past its gate is not one', (t) => {
  // Bug: an approved task still offers a plan approval.
  const { board, triaged } = boardRig(t);
  board.call('boss', 'task.approve', { id: triaged.id, scope: 'plan' });
  assert.deepEqual(pendingApprovals(board, 'boss'), []);
});

test('an approval moves the task through the board with a review row, and starts no executor', (t) => {
  // Bug: the panel claims the task or merges by itself, past the board's own policy.
  const { board, triaged } = boardRig(t);
  const answer = answerApproval(board, 'boss', {
    taskId: triaged.id,
    scope: 'plan',
    revision: triaged.revision,
    decision: 'approve',
  });
  assert.equal(answer.status, 'ok');
  const view = board.call('boss', 'task.show', { id: triaged.id });
  assert.equal(view.task.status, 'approved');
  assert.equal(view.task.lease_owner, null);
  assert.deepEqual(
    view.approvals.map((one) => [one.scope, one.decision, one.principal]),
    [['plan', 'approve', 'boss']]
  );
});

test('an approval against an older revision is refused with the board code, and the task stays', (t) => {
  // Bug: the owner approves the plan as it stood before someone changed it.
  const { board, triaged } = boardRig(t);
  const answer = answerApproval(board, 'boss', {
    taskId: triaged.id,
    scope: 'plan',
    revision: triaged.revision - 1,
    decision: 'approve',
  });
  assert.equal(answer.status === 'refused' && answer.code, 'stale');
  assert.equal(board.call('boss', 'task.show', { id: triaged.id }).task.status, 'triaged');
});

test('a principal the board does not allow is refused by the board, whatever the panel showed', (t) => {
  // Bug: pressing allow in a panel stands in for the board's own permission check.
  const { board, triaged } = boardRig(t);
  const answer = answerApproval(board, 'hand', {
    taskId: triaged.id,
    scope: 'plan',
    revision: triaged.revision,
    decision: 'approve',
  });
  assert.equal(answer.status === 'refused' && answer.code, 'forbidden');
  assert.equal(board.call('boss', 'task.show', { id: triaged.id }).task.status, 'triaged');
});

test('an unknown task is a refusal, not a throw out of the panel', (t) => {
  // Bug: a task removed while the panel was open ends the chat.
  const { board } = boardRig(t);
  const answer = answerApproval(board, 'boss', { taskId: 'nope', scope: 'plan', revision: 1, decision: 'approve' });
  assert.equal(answer.status, 'refused');
});

test('the relay forwards one answer to the board, and a double Enter changes nothing more', async (t) => {
  // Bug: the second Enter reaches the board against the new revision and records a second approval.
  const { board } = boardRig(t);
  const relay = relayOver(board);
  const gate = gateOf(board);
  relay.present(gate);
  const answer = { taskId: gate.taskId, scope: gate.scope, revision: gate.revision, decision: 'approve' as const };
  assert.equal((await relay.respond(answer)).status, 'forwarded');
  const events = board.eventsSince(0).length;
  const again = await relay.respond(answer);
  assert.equal(again.status === 'refused' && again.code, 'already-answered');
  assert.equal(board.eventsSince(0).length, events);
});

test('an answer naming another revision than the one presented never reaches the board', async (t) => {
  // Bug: a panel builds its answer from fresher data than the owner read.
  const { board } = boardRig(t);
  const relay = relayOver(board);
  const gate = gateOf(board);
  relay.present(gate);
  const events = board.eventsSince(0).length;
  const answer = await relay.respond({
    taskId: gate.taskId,
    scope: gate.scope,
    revision: gate.revision + 1,
    decision: 'approve',
  });
  assert.equal(answer.status === 'refused' && answer.code, 'stale');
  assert.equal(board.eventsSince(0).length, events);
});

test('an answer to a gate never presented is refused', async (t) => {
  // Bug: the relay becomes a second way to approve anything by id.
  const { board, triaged } = boardRig(t);
  const answer = await relayOver(board).respond({
    taskId: triaged.id,
    scope: 'plan',
    revision: triaged.revision,
    decision: 'approve',
  });
  assert.equal(answer.status === 'refused' && answer.code, 'unknown');
  assert.equal(board.call('boss', 'task.show', { id: triaged.id }).task.status, 'triaged');
});

test('the board has the last word, and a refused answer leaves the gate open for a corrected one', async (t) => {
  // Bug: a reject without its required reason closes the gate in the panel while the task has not moved.
  const { board } = boardRig(t);
  const relay = relayOver(board);
  const gate = gateOf(board);
  relay.present(gate);
  const bare = { taskId: gate.taskId, scope: gate.scope, revision: gate.revision, decision: 'reject' as const };
  const refused = await relay.respond(bare);
  assert.equal(refused.status === 'forwarded' && refused.result.status, 'refused');
  assert.deepEqual(relay.pending(), [gate]);
  const corrected = await relay.respond({ ...bare, note: 'not this one' });
  assert.equal(corrected.status === 'forwarded' && corrected.result.status, 'ok');
  assert.equal(board.call('boss', 'task.show', { id: gate.taskId }).task.status, 'rejected');
  assert.deepEqual(relay.pending(), []);
});

test('a reconnect presents the same gate again without a duplicate or an answer', (t) => {
  // Bug: a reconnect doubles the row, or reads as answered and drops the question.
  const { board } = boardRig(t);
  const relay = relayOver(board);
  const gate = gateOf(board);
  relay.present(gate);
  relay.present(gate);
  assert.deepEqual(relay.pending(), [gate]);
  assert.equal(board.call('boss', 'task.show', { id: gate.taskId }).task.status, 'triaged');
});
