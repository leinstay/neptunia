// src/tools/approvals.ts: a UI answer is data for the existing authority. The relay checks it belongs to the request it
// names and forwards it once; it grants nothing itself. src/board/approval-view.ts reads the board's own gates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { answerApproval, pendingApprovals } from '../src/board/approval-view.ts';
import { openBoard } from '../src/board/board.ts';
import type { Board, BoardSettings } from '../src/board/board.ts';
import type { BoardDb } from '../src/board/schema.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { createApprovalRelay } from '../src/tools/approvals.ts';
import type { ApprovalRequest } from '../src/tools/approvals.ts';
import { tempDir } from './fixtures/tmp.ts';

const REQUEST: ApprovalRequest = {
  id: 'q1',
  runId: 'run-1',
  revision: 3,
  expiresAt: 2000,
  scope: { kind: 'tool', name: 'shell', grant: 'once' },
  action: { digest: 'sha256:aaa', summary: 'Run a command', command: ['git', 'status'], diff: null },
};

function relayRig(now = 1000) {
  const forwarded: Array<unknown> = [];
  let clock = now;
  const relay = createApprovalRelay({
    now: () => clock,
    authorize: (answer) => {
      forwarded.push(answer);
      return Promise.resolve({ status: 'allowed' as const });
    },
  });
  return { relay, forwarded, advance: (ms: number) => (clock += ms) };
}

const ALLOW = { requestId: 'q1', decision: 'allow' as const, digest: 'sha256:aaa', runId: 'run-1', revision: 3 };

test('an answer reaches the authority once with the exact scope of its request, and no wider', async () => {
  // Bug: approving one command becomes a standing grant of the tool.
  const { relay, forwarded } = relayRig();
  relay.present(REQUEST);
  const answer = await relay.respond(ALLOW);
  assert.equal(answer.status, 'forwarded');
  assert.deepEqual(forwarded, [
    { requestId: 'q1', decision: 'allow', scope: REQUEST.scope, digest: 'sha256:aaa', runId: 'run-1', revision: 3 },
  ]);
});

test('the authority has the last word: a refusal there is no approval here', async () => {
  // Bug: the panel says allowed because the owner pressed allow, though the check refused.
  const relay = createApprovalRelay({
    now: () => 1000,
    authorize: () => Promise.resolve({ status: 'refused', code: 'not-granted' }),
  });
  relay.present(REQUEST);
  const answer = await relay.respond(ALLOW);
  assert.equal(answer.status === 'forwarded' && answer.result.status, 'refused');
});

test('a second answer to one request is refused and never forwarded', async () => {
  // Bug: a double Enter runs the action twice.
  const { relay, forwarded } = relayRig();
  relay.present(REQUEST);
  await relay.respond(ALLOW);
  const again = await relay.respond(ALLOW);
  assert.equal(again.status === 'refused' && again.code, 'already-answered');
  assert.equal(forwarded.length, 1);
});

test('an answer for changed action bytes is refused', async () => {
  // Bug: the command is swapped after the owner read it, and the old approval runs the new one.
  const { relay, forwarded } = relayRig();
  relay.present(REQUEST);
  const answer = await relay.respond({ ...ALLOW, digest: 'sha256:bbb' });
  assert.equal(answer.status === 'refused' && answer.code, 'changed-action');
  assert.deepEqual(forwarded, []);
});

test('an answer naming another run or an older revision is refused', async () => {
  // Bug: a panel left open approves the next run's action.
  const { relay, forwarded } = relayRig();
  relay.present(REQUEST);
  const otherRun = await relay.respond({ ...ALLOW, runId: 'run-2' });
  const oldRevision = await relay.respond({ ...ALLOW, revision: 2 });
  assert.equal(otherRun.status === 'refused' && otherRun.code, 'stale-run');
  assert.equal(oldRevision.status === 'refused' && oldRevision.code, 'stale-run');
  assert.deepEqual(forwarded, []);
});

test('an expired request refuses its answer, at the boundary too', async () => {
  // Bug: an approval given after its time runs an action the backend gave up on.
  const { relay, forwarded, advance } = relayRig();
  relay.present(REQUEST);
  advance(1000);
  const answer = await relay.respond(ALLOW);
  assert.equal(answer.status === 'refused' && answer.code, 'expired');
  assert.deepEqual(forwarded, []);
  assert.deepEqual(relay.pending(), []);
});

test('a cancelled request refuses its answer, and an unknown one too', async () => {
  // Bug: a cancelled run's panel still approves.
  const { relay, forwarded } = relayRig();
  relay.present(REQUEST);
  relay.cancel('q1');
  const answer = await relay.respond(ALLOW);
  assert.equal(answer.status, 'refused');
  const unknown = await relay.respond({ ...ALLOW, requestId: 'nope' });
  assert.equal(unknown.status === 'refused' && unknown.code, 'unknown');
  assert.deepEqual(forwarded, []);
});

test('a reconnect lists the same waiting request, unanswered, and reading it forwards nothing', () => {
  // Bug: a reconnect drops the question, or treats it as answered.
  const { relay, forwarded } = relayRig();
  relay.present(REQUEST);
  relay.present(REQUEST);
  assert.deepEqual(relay.pending(), [REQUEST]);
  assert.deepEqual(relay.pending(), [REQUEST]);
  assert.deepEqual(forwarded, []);
});

const SETTINGS: BoardSettings = {
  leaseTtlMinutes: 30,
  autoTriage: { role: 'dev', budget: 4, steps: 80, estimate: 30 },
  projects: {},
};

function boardRig(t: { after: (fn: () => void) => void }): { board: Board; taskId: string; revision: number } {
  const dir = tempDir('nep-approval-view-');
  fs.writeFileSync(
    path.join(dir, 'clients.json'),
    JSON.stringify({ boss: { kind: 'agent', tokenFile: 'clients/boss.token', permissions: [], boardRoles: ['owner'] } })
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
  return { board, taskId: triaged.id, revision: triaged.revision };
}

test('a triaged task reads as a plan approval with its revision, and reading changes nothing', (t) => {
  // Bug: the panel keeps a second list of what waits for the owner.
  const { board, taskId, revision } = boardRig(t);
  const events = board.eventsSince(0).length;
  const [request] = pendingApprovals(board, 'boss');
  assert.equal(request?.taskId, taskId);
  assert.equal(request?.scope, 'plan');
  assert.equal(request?.revision, revision);
  assert.equal(board.eventsSince(0).length, events);
});

test('an approval from the panel moves the task through the board and starts no executor', (t) => {
  // Bug: the panel claims the task or merges by itself, past the board's own policy.
  const { board, taskId, revision } = boardRig(t);
  const answer = answerApproval(board, 'boss', { taskId, scope: 'plan', revision, decision: 'approve' });
  assert.equal(answer.status, 'ok');
  const task = board.call('boss', 'task.show', { id: taskId }).task;
  assert.equal(task.status, 'approved');
  assert.equal(task.lease_owner, null);
  assert.deepEqual(pendingApprovals(board, 'boss'), []);
});

test('an approval against a stale revision is refused, and the second of two changes nothing', (t) => {
  // Bug: the owner approves the plan as it stood before someone changed it.
  const { board, taskId, revision } = boardRig(t);
  const stale = answerApproval(board, 'boss', { taskId, scope: 'plan', revision: revision - 1, decision: 'approve' });
  assert.equal(stale.status === 'refused' && stale.code, 'stale-revision');
  assert.equal(board.call('boss', 'task.show', { id: taskId }).task.status, 'triaged');
  assert.equal(answerApproval(board, 'boss', { taskId, scope: 'plan', revision, decision: 'approve' }).status, 'ok');
  const events = board.eventsSince(0).length;
  const second = answerApproval(board, 'boss', { taskId, scope: 'plan', revision, decision: 'approve' });
  assert.equal(second.status, 'refused');
  assert.equal(board.eventsSince(0).length, events);
});
