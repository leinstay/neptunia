// The board's state machine (src/board/machine.ts) in the generic roles: for every transition of the table, who may
// make it, under which conditions, and what it requires. The ledger's machine suite named its principals (`lead`,
// `dispatcher`, `core`, `thinker`); the board knows only roles, so these tests restate it role by role (the brief of
// PR 6a, "The transition table in roles").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardError, OPEN, authorize } from '../src/board/machine.ts';
import type { Condition, Requirement, Role, Status, Via } from '../src/board/machine.ts';

type Move = { from: Status; to: Status; via: Via };

/** 'allowed', or the code of the BoardError the move is refused with. */
function verdict(move: Move, roles: ReadonlyArray<Role>, conditions: ReadonlyArray<Condition> = []): string {
  try {
    authorize({ ...move, roles: new Set(roles), conditions: new Set(conditions) });
    return 'allowed';
  } catch (error) {
    if (error instanceof BoardError) return error.code;
    throw error;
  }
}

const requires = (
  move: Move,
  roles: ReadonlyArray<Role>,
  conditions: ReadonlyArray<Condition> = []
): ReadonlyArray<Requirement> =>
  authorize({ ...move, roles: new Set(roles), conditions: new Set(conditions) }).requires;

test("triage is the reviewer's and the scheduler's with the triage fields, and the errand runner's on an errand without them", () => {
  const move: Move = { from: 'proposed', to: 'triaged', via: 'transition' };
  assert.deepEqual(requires(move, ['reviewer']), ['triage-fields']);
  assert.deepEqual(requires(move, ['scheduler']), ['triage-fields']);
  assert.deepEqual(requires(move, ['errand-runner'], ['errand']), []);
  assert.equal(verdict(move, ['errand-runner']), 'forbidden');
  assert.equal(verdict(move, ['worker']), 'forbidden');
  assert.equal(verdict(move, ['watcher']), 'forbidden');
});

test("a plan approval is the owner's at any risk and the reviewer's only at low risk", () => {
  const move: Move = { from: 'triaged', to: 'approved', via: 'approve' };
  assert.equal(verdict(move, ['owner']), 'allowed');
  assert.equal(verdict(move, ['reviewer']), 'forbidden');
  assert.equal(verdict(move, ['reviewer'], ['risk-low']), 'allowed');
  assert.equal(verdict(move, ['scheduler'], ['risk-low']), 'forbidden');
  assert.equal(verdict(move, ['errand-runner'], ['errand']), 'allowed');
  assert.equal(verdict(move, ['errand-runner']), 'forbidden');
});

test('a dev task never goes from proposed to approved, and an errand does by the errand runner alone', () => {
  for (const via of ['transition', 'approve'] as const) {
    const move: Move = { from: 'proposed', to: 'approved', via };
    assert.equal(verdict(move, ['owner']), 'invalid-transition', via);
    assert.equal(verdict(move, ['errand-runner'], ['errand']), 'allowed', via);
    assert.equal(verdict(move, ['owner'], ['errand']), 'forbidden', via);
  }
});

test('an errand is approved from triage by a transition only for the errand runner, and a dev task not at all', () => {
  const move: Move = { from: 'triaged', to: 'approved', via: 'transition' };
  assert.equal(verdict(move, ['errand-runner'], ['errand']), 'allowed');
  assert.equal(verdict(move, ['reviewer'], ['errand', 'risk-low']), 'forbidden');
  assert.equal(verdict(move, ['owner']), 'invalid-transition');
});

test("a rejection is the owner's or the reviewer's, from proposed or triaged, with a close reason", () => {
  for (const from of ['proposed', 'triaged'] as const) {
    for (const via of ['transition', 'approve'] as const) {
      const move: Move = { from, to: 'rejected', via };
      assert.deepEqual(requires(move, ['owner']), ['close-reason'], `${from} ${via}`);
      assert.deepEqual(requires(move, ['reviewer']), ['close-reason'], `${from} ${via}`);
      assert.equal(verdict(move, ['scheduler']), 'forbidden', `${from} ${via}`);
      assert.equal(verdict(move, ['errand-runner'], ['errand']), 'forbidden', `${from} ${via}`);
    }
  }
});

test("a claim is the owner's, the scheduler's or a worker's, never the reviewer's, and the errand runner's on an errand", () => {
  const move: Move = { from: 'approved', to: 'in_progress', via: 'claim' };
  assert.equal(verdict(move, ['owner']), 'allowed');
  assert.equal(verdict(move, ['scheduler']), 'allowed');
  assert.equal(verdict(move, ['worker']), 'allowed');
  assert.equal(verdict(move, ['reviewer'], ['risk-low']), 'forbidden');
  assert.equal(verdict(move, ['errand-runner'], ['errand']), 'allowed');
  assert.equal(verdict(move, ['errand-runner']), 'forbidden');
});

test('a question is asked by the holder alone', () => {
  const move: Move = { from: 'in_progress', to: 'needs_answer', via: 'ask' };
  assert.equal(verdict(move, ['holder']), 'allowed');
  assert.equal(verdict(move, ['worker']), 'forbidden');
  assert.equal(verdict(move, ['owner']), 'forbidden');
});

test("an answer is the answerer's or the owner's, and a reviewer the question does not name is refused", () => {
  const move: Move = { from: 'needs_answer', to: 'in_progress', via: 'answer' };
  assert.equal(verdict(move, ['answerer']), 'allowed');
  assert.equal(verdict(move, ['owner']), 'allowed');
  assert.equal(verdict(move, ['reviewer']), 'forbidden');
  assert.equal(verdict(move, ['holder']), 'forbidden');
});

test("a submit for validation is the holder's and requires a result", () => {
  const move: Move = { from: 'in_progress', to: 'needs_validation', via: 'transition' };
  assert.deepEqual(requires(move, ['holder']), ['result']);
  assert.equal(verdict(move, ['owner']), 'forbidden');
  assert.equal(verdict(move, ['reviewer']), 'forbidden');
});

test("a merge is the owner's at any risk and the reviewer's at any risk only with CI green", () => {
  const move: Move = { from: 'needs_validation', to: 'done', via: 'approve' };
  assert.equal(verdict(move, ['owner']), 'allowed');
  assert.equal(verdict(move, ['reviewer']), 'forbidden');
  assert.equal(verdict(move, ['reviewer'], ['risk-low']), 'forbidden');
  assert.equal(verdict(move, ['reviewer'], ['ci-green']), 'allowed');
  assert.equal(verdict(move, ['scheduler'], ['ci-green', 'risk-low']), 'forbidden');
});

test('on a project without CI the reviewer merges on recorded passing tests, and passing tests alone do not do it elsewhere', () => {
  const move: Move = { from: 'needs_validation', to: 'done', via: 'approve' };
  assert.equal(verdict(move, ['reviewer'], ['no-ci', 'tests-pass']), 'allowed');
  assert.equal(verdict(move, ['reviewer'], ['no-ci']), 'forbidden');
  assert.equal(verdict(move, ['reviewer'], ['tests-pass']), 'forbidden');
});

test("a rework order is the owner's or the reviewer's and requires a comment", () => {
  for (const via of ['transition', 'approve'] as const) {
    const move: Move = { from: 'needs_validation', to: 'in_progress', via };
    assert.deepEqual(requires(move, ['owner']), ['comment'], via);
    assert.deepEqual(requires(move, ['reviewer']), ['comment'], via);
    assert.equal(verdict(move, ['holder']), 'forbidden', via);
  }
});

test('in progress to done directly exists only for an errand, by the errand runner', () => {
  const move: Move = { from: 'in_progress', to: 'done', via: 'transition' };
  assert.equal(verdict(move, ['errand-runner'], ['errand']), 'allowed');
  assert.equal(verdict(move, ['holder'], ['errand']), 'forbidden');
  assert.equal(verdict(move, ['owner']), 'invalid-transition');
});

test("a failure is the holder's, the scheduler's or the errand runner's on an errand, and requires why", () => {
  const move: Move = { from: 'in_progress', to: 'failed', via: 'transition' };
  assert.deepEqual(requires(move, ['holder']), ['why']);
  assert.deepEqual(requires(move, ['scheduler']), ['why']);
  assert.equal(verdict(move, ['errand-runner'], ['errand']), 'allowed');
  assert.equal(verdict(move, ['errand-runner']), 'forbidden');
  assert.equal(verdict(move, ['reviewer']), 'forbidden');
});

test('every open status is cancelled by the owner, the reviewer or the requester with a close reason, and by no worker', () => {
  for (const from of OPEN) {
    const move: Move = { from, to: 'cancelled', via: 'transition' };
    assert.deepEqual(requires(move, ['owner']), ['close-reason'], from);
    assert.deepEqual(requires(move, ['reviewer']), ['close-reason'], from);
    assert.deepEqual(requires(move, ['requester']), ['close-reason'], from);
    assert.equal(verdict(move, ['errand-runner'], ['errand']), 'allowed', from);
    assert.equal(verdict(move, ['worker']), 'forbidden', from);
    assert.equal(verdict(move, ['errand-runner']), 'forbidden', from);
  }
});

test('the reaper alone returns an expired lease to approved', () => {
  for (const from of ['approved', 'in_progress'] as const) {
    const move: Move = { from, to: 'approved', via: 'reaper' };
    assert.equal(verdict(move, ['reaper']), 'allowed', from);
    assert.equal(verdict(move, ['owner']), 'forbidden', from);
  }
});

test("a release is the holder's or the owner's", () => {
  const move: Move = { from: 'in_progress', to: 'approved', via: 'release' };
  assert.equal(verdict(move, ['holder']), 'allowed');
  assert.equal(verdict(move, ['owner']), 'allowed');
  assert.equal(verdict(move, ['reviewer']), 'forbidden');
  assert.equal(verdict(move, ['scheduler']), 'forbidden');
});

test("a retry of a failed task is the owner's or the reviewer's, and of any other closed task no one's", () => {
  const move: Move = { from: 'failed', to: 'approved', via: 'retry' };
  assert.equal(verdict(move, ['owner']), 'allowed');
  assert.equal(verdict(move, ['reviewer']), 'allowed');
  assert.equal(verdict(move, ['scheduler']), 'forbidden');
  for (const from of ['done', 'cancelled', 'rejected'] as const) {
    assert.equal(verdict({ from, to: 'approved', via: 'retry' }, ['owner']), 'invalid-transition', from);
  }
});

test('a closed task does not reopen and a skipped step does not exist, whoever asks', () => {
  assert.equal(verdict({ from: 'done', to: 'in_progress', via: 'transition' }, ['owner']), 'invalid-transition');
  assert.equal(verdict({ from: 'proposed', to: 'done', via: 'approve' }, ['owner']), 'invalid-transition');
  assert.equal(verdict({ from: 'proposed', to: 'in_progress', via: 'claim' }, ['owner']), 'invalid-transition');
});

test("a derived role in a principal's grant is still checked per move: a requester cannot approve its own plan", () => {
  assert.equal(verdict({ from: 'triaged', to: 'approved', via: 'approve' }, ['requester'], ['risk-low']), 'forbidden');
  assert.equal(
    verdict({ from: 'needs_validation', to: 'done', via: 'approve' }, ['requester'], ['ci-green']),
    'forbidden'
  );
});
