// The board's workflow (src/board/board.ts, board v2): lease generations that shut out a late worker, a block with
// its reason and what unblocks it, the structured handoff of a submit, the review with accept or changes, child
// tasks a parent waits for, `task.orient` for the caller, and idempotent retries. Every call of a holder here carries
// the generation its claim returned. A memory database in memory, a fake clock, synthetic principals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.js';
import { openBoard } from '../src/board/board.ts';
import type { Board, BoardSettings, Handoff, TaskRecord } from '../src/board/board.ts';
import { BoardError } from '../src/board/machine.ts';
import type { BoardDb } from '../src/board/schema.ts';
import { tempDir } from './fixtures/tmp.js';

const NOW = Date.parse('2026-10-31T10:00:00.000Z');
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
  self: ['persona', 'owner'],
  runner: ['errand-runner'],
  eyes: ['watcher'],
};

const HANDOFF: Handoff = {
  result: 'The parser reads the new tag.',
  evidence: ['the parser tests pass 12 of 12'],
  artifacts: ['src/parser.ts', 'tests/parser.test.ts'],
  tests: [{ command: 'node --test tests/parser.test.ts', passed: 12, failed: 0 }],
  open_issues: ['The old tag is still accepted.'],
};

// open.js types its connection as `object`; it is node:sqlite's DatabaseSync, which has every method BoardDb names.
const dbOf = (handle: { db: object }): BoardDb => handle.db as BoardDb;

function setUp(t: { after: (fn: () => void) => void }): { board: Board; advance: (minutes: number) => void } {
  const dir = tempDir('nep-board-workflow-');
  const entries = Object.fromEntries(
    Object.entries(CLIENTS).map(([name, boardRoles]) => [
      name,
      { kind: 'cli', tokenFile: `clients/${name}.token`, permissions: [], boardRoles },
    ])
  );
  fs.writeFileSync(path.join(dir, 'clients.json'), JSON.stringify(entries));
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  let now = NOW;
  const board = openBoard({ db: dbOf(handle), privateDir: dir, now: () => now, settings: () => SETTINGS });
  return {
    board,
    advance: (minutes) => {
      now += minutes * 60000;
    },
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'ok';
  } catch (error) {
    if (error instanceof BoardError) return error.code;
    throw error;
  }
}

/** A dev task filed by `filer` with `extra`, triaged and approved by the owner. */
function approvedTask(board: Board, extra: Record<string, unknown> = {}, filer = 'boss'): TaskRecord {
  const added = board.call(filer, 'task.add', { title: 'a task', lane: 'dev', project: 'core', ...extra });
  const triaged = board.call('boss', 'task.transition', {
    id: added.id,
    status: 'triaged',
    revision: added.revision,
    set: { role: 'dev', estimate: 20, budget: 2 },
  });
  return board.call('boss', 'task.approve', { id: triaged.id, scope: 'plan' }).task;
}

/** An approved task claimed by `worker`: the claim's answer, with its generation. */
function heldBy(board: Board, worker = 'hand', extra: Record<string, unknown> = {}, filer = 'boss'): TaskRecord {
  return board.call(worker, 'task.claim', { id: approvedTask(board, extra, filer).id });
}

/** A held task submitted with the full handoff, waiting in needs_validation. */
function submitted(board: Board, worker = 'hand', extra: Record<string, unknown> = {}, filer = 'boss'): TaskRecord {
  const held = heldBy(board, worker, extra, filer);
  return board.call(worker, 'task.submit', { id: held.id, generation: held.lease_generation, handoff: HANDOFF }).task;
}

/** The task reclaimed by the reaper and claimed again by the same worker: the old and the new generation. */
function reclaimed(board: Board, advance: (minutes: number) => void, held: TaskRecord): { old: number; now: number } {
  advance(31);
  board.reap();
  const again = board.call('hand', 'task.claim', { id: held.id });
  return { old: held.lease_generation, now: again.lease_generation };
}

// ---------- lease generations ----------

test('a claim raises the generation of the task and returns it', (t) => {
  const { board } = setUp(t);
  const task = approvedTask(board);
  const before = board.call('boss', 'task.show', { id: task.id }).task.lease_generation;
  const claimed = board.call('hand', 'task.claim', { id: task.id });
  assert.ok(claimed.lease_generation > before);
  assert.equal(board.call('boss', 'task.show', { id: task.id }).task.lease_generation, claimed.lease_generation);
});

test('of two claims of one task the second is refused claimed and the generation stays the first claim’s', (t) => {
  const { board } = setUp(t);
  const task = approvedTask(board);
  const before = board.call('boss', 'task.show', { id: task.id }).task.lease_generation;
  const won = board.call('hand', 'task.claim', { id: task.id });
  assert.ok(won.lease_generation > before);
  assert.equal(
    codeOf(() => board.call('hand2', 'task.claim', { id: task.id })),
    'claimed'
  );
  const shown = board.call('boss', 'task.show', { id: task.id }).task;
  assert.equal(shown.lease_owner, 'hand');
  assert.equal(shown.lease_generation, won.lease_generation);
});

test('the reaper raises the generation when it reclaims an expired lease', (t) => {
  const { board, advance } = setUp(t);
  const held = heldBy(board);
  advance(31);
  assert.deepEqual(board.reap(), [held.id]);
  assert.ok(board.call('boss', 'task.show', { id: held.id }).task.lease_generation > held.lease_generation);
});

test("a late worker's submit after a reclaim is refused stale-lease and leaves the task, its results and its events unchanged", (t) => {
  const { board, advance } = setUp(t);
  const held = heldBy(board);
  const generations = reclaimed(board, advance, held);
  const before = board.call('boss', 'task.show', { id: held.id });
  const events = board.eventsSince(0).length;
  assert.equal(
    codeOf(() => board.call('hand', 'task.submit', { id: held.id, generation: generations.old, handoff: HANDOFF })),
    'stale-lease'
  );
  const after = board.call('boss', 'task.show', { id: held.id });
  assert.deepEqual(after.task, before.task);
  assert.equal(after.task.status, 'in_progress');
  assert.equal(after.task.lease_generation, generations.now);
  assert.equal(after.results.length, 0);
  assert.equal(after.handoff, null);
  assert.equal(board.eventsSince(0).length, events);
});

test("a late heartbeat after a reclaim is refused stale-lease and the new holder's lease stands", (t) => {
  const { board, advance } = setUp(t);
  const held = heldBy(board);
  const generations = reclaimed(board, advance, held);
  const lease = board.call('boss', 'task.show', { id: held.id }).task;
  advance(5);
  assert.equal(
    codeOf(() => board.call('hand', 'task.heartbeat', { id: held.id, generation: generations.old })),
    'stale-lease'
  );
  const after = board.call('boss', 'task.show', { id: held.id }).task;
  assert.equal(after.lease_expires_at, lease.lease_expires_at);
  assert.equal(after.heartbeat_at, lease.heartbeat_at);
  const beat = board.call('hand', 'task.heartbeat', { id: held.id, generation: generations.now });
  assert.ok(Date.parse(beat.lease_expires_at ?? '') > Date.parse(lease.lease_expires_at ?? ''));
});

test('every call of the holder with an older generation is refused stale-lease before it writes anything', (t) => {
  const { board, advance } = setUp(t);
  const held = heldBy(board);
  const attempt = board.call('hand', 'attempt.start', { task_id: held.id });
  const { old } = reclaimed(board, advance, held);
  const before = board.call('boss', 'task.show', { id: held.id }).task;
  const events = board.eventsSince(0).length;
  const calls: Array<[string, () => unknown]> = [
    ['task.heartbeat', () => board.call('hand', 'task.heartbeat', { id: held.id, generation: old })],
    [
      'task.result',
      () => board.call('hand', 'task.result', { id: held.id, generation: old, kind: 'summary', body: 'late' }),
    ],
    [
      'task.ask',
      () => board.call('hand', 'task.ask', { id: held.id, generation: old, text: 'which?', to_whom: 'owner' }),
    ],
    [
      'task.block',
      () => board.call('hand', 'task.block', { id: held.id, generation: old, reason: 'stuck', unblocks: 'a key' }),
    ],
    ['task.submit', () => board.call('hand', 'task.submit', { id: held.id, generation: old, handoff: HANDOFF })],
    ['task.release', () => board.call('hand', 'task.release', { id: held.id, generation: old })],
    [
      'attempt.end',
      () => board.call('hand', 'attempt.end', { attempt_id: attempt.id, generation: old, outcome: 'stopped' }),
    ],
  ];
  for (const [op, call] of calls) assert.equal(codeOf(call), 'stale-lease', op);
  const after = board.call('boss', 'task.show', { id: held.id });
  assert.deepEqual(after.task, before);
  assert.equal(after.results.length, 0);
  assert.equal(after.questions.length, 0);
  assert.equal(after.attempts[0]?.ended_at, null);
  assert.equal(board.eventsSince(0).length, events);
});

test('a heartbeat with an older generation after a reap with no new claim is refused stale-lease', (t) => {
  const { board, advance } = setUp(t);
  const held = heldBy(board);
  advance(31);
  board.reap();
  assert.equal(
    codeOf(() => board.call('hand', 'task.heartbeat', { id: held.id, generation: held.lease_generation })),
    'stale-lease'
  );
  const after = board.call('boss', 'task.show', { id: held.id }).task;
  assert.equal(after.status, 'approved');
  assert.equal(after.lease_owner, null);
});

test('a generation that is not an integer is refused invalid and the lease stays', (t) => {
  const { board, advance } = setUp(t);
  const held = heldBy(board);
  advance(5);
  assert.equal(
    codeOf(() => board.call('hand', 'task.heartbeat', { id: held.id, generation: 'first' })),
    'invalid'
  );
  assert.equal(board.call('boss', 'task.show', { id: held.id }).task.lease_expires_at, held.lease_expires_at);
});

// ---------- block with a reason ----------

test('a block records its reason and what unblocks it, frees the lease, and a later claim gets a higher generation', (t) => {
  const { board } = setUp(t);
  const held = heldBy(board);
  const blocked = board.call('hand', 'task.block', {
    id: held.id,
    generation: held.lease_generation,
    reason: 'The test database is missing.',
    unblocks: 'A fixture with the v20 schema.',
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blocked_reason, 'The test database is missing.');
  assert.equal(blocked.unblocks, 'A fixture with the v20 schema.');
  assert.equal(blocked.lease_owner, null);
  assert.equal(blocked.lease_expires_at, null);
  const unblocked = board.call('rev', 'task.unblock', { id: held.id, note: 'The fixture is in tests/fixtures.' });
  assert.equal(unblocked.status, 'approved');
  assert.ok(
    board
      .call('boss', 'task.show', { id: held.id })
      .comments.some((comment) => comment.text === 'The fixture is in tests/fixtures.')
  );
  const again = board.call('hand', 'task.claim', { id: held.id });
  assert.ok(again.lease_generation > held.lease_generation);
});

test('a block without its reason or without what unblocks it is refused invalid and the task stays held', (t) => {
  const { board } = setUp(t);
  const held = heldBy(board);
  const generation = held.lease_generation;
  assert.equal(
    codeOf(() => board.call('hand', 'task.block', { id: held.id, generation, unblocks: 'a key' })),
    'invalid'
  );
  assert.equal(
    codeOf(() => board.call('hand', 'task.block', { id: held.id, generation, reason: 'no key' })),
    'invalid'
  );
  const after = board.call('boss', 'task.show', { id: held.id }).task;
  assert.equal(after.status, 'in_progress');
  assert.equal(after.lease_owner, 'hand');
  // The same block with both fields goes through, so the refusals above were for the missing field.
  assert.equal(
    board.call('hand', 'task.block', { id: held.id, generation, reason: 'no key', unblocks: 'a key' }).status,
    'blocked'
  );
});

test('a block by a principal that does not hold the task is refused forbidden, the owner included', (t) => {
  const { board } = setUp(t);
  const held = heldBy(board);
  for (const principal of ['hand2', 'boss', 'rev']) {
    assert.equal(
      codeOf(() =>
        board.call(principal, 'task.block', {
          id: held.id,
          generation: held.lease_generation,
          reason: 'stuck',
          unblocks: 'a key',
        })
      ),
      'forbidden',
      principal
    );
  }
  assert.equal(board.call('boss', 'task.show', { id: held.id }).task.status, 'in_progress');
});

test('an unblock is refused to the worker who blocked, and refused invalid without a note', (t) => {
  const { board } = setUp(t);
  const held = heldBy(board);
  board.call('hand', 'task.block', {
    id: held.id,
    generation: held.lease_generation,
    reason: 'stuck',
    unblocks: 'a key',
  });
  assert.equal(
    codeOf(() => board.call('hand', 'task.unblock', { id: held.id, note: 'found it myself' })),
    'forbidden'
  );
  assert.equal(
    codeOf(() => board.call('rev', 'task.unblock', { id: held.id })),
    'invalid'
  );
  assert.equal(board.call('boss', 'task.show', { id: held.id }).task.status, 'blocked');
});

test('a blocked task is not ready and its claim is refused invalid-transition', (t) => {
  const { board } = setUp(t);
  const held = heldBy(board);
  board.call('hand', 'task.block', {
    id: held.id,
    generation: held.lease_generation,
    reason: 'stuck',
    unblocks: 'a key',
  });
  assert.deepEqual(board.call('boss', 'task.list', { ready: true }), []);
  assert.equal(
    codeOf(() => board.call('hand2', 'task.claim', { id: held.id })),
    'invalid-transition'
  );
});

test('a blocked task is open: the owner cancels it with a close reason', (t) => {
  const { board } = setUp(t);
  const held = heldBy(board);
  const blocked = board.call('hand', 'task.block', {
    id: held.id,
    generation: held.lease_generation,
    reason: 'stuck',
    unblocks: 'a key',
  });
  const cancelled = board.call('boss', 'task.transition', {
    id: held.id,
    status: 'cancelled',
    revision: blocked.revision,
    close_reason: 'not needed',
  });
  assert.equal(cancelled.status, 'cancelled');
});

// ---------- the structured handoff ----------

test('a submit whose handoff has no result is refused invalid and writes nothing', (t) => {
  const { board } = setUp(t);
  const held = heldBy(board);
  const generation = held.lease_generation;
  const withoutResult = Object.fromEntries(Object.entries(HANDOFF).filter(([key]) => key !== 'result'));
  for (const handoff of [undefined, {}, withoutResult, { ...HANDOFF, result: '' }]) {
    assert.equal(
      codeOf(() => board.call('hand', 'task.submit', { id: held.id, generation, handoff })),
      'invalid',
      JSON.stringify(handoff)
    );
  }
  const after = board.call('boss', 'task.show', { id: held.id });
  assert.equal(after.task.status, 'in_progress');
  assert.equal(after.results.length, 0);
  // The full handoff goes through, so the refusals above were for the missing result.
  assert.equal(
    board.call('hand', 'task.submit', { id: held.id, generation, handoff: HANDOFF }).task.status,
    'needs_validation'
  );
});

test('a submit with the handoff moves the task to needs_validation and task.show returns the handoff whole', (t) => {
  const { board } = setUp(t);
  const held = heldBy(board);
  const answer = board.call('hand', 'task.submit', {
    id: held.id,
    generation: held.lease_generation,
    handoff: HANDOFF,
  });
  assert.equal(answer.task.status, 'needs_validation');
  assert.equal(answer.task.lease_owner, null);
  const shown = board.call('boss', 'task.show', { id: held.id });
  assert.deepEqual(shown.handoff, HANDOFF);
  assert.deepEqual(
    shown.results.map((row) => row.kind),
    ['handoff']
  );
});

test('a handoff with only its result is shown with every list empty', (t) => {
  const { board } = setUp(t);
  const held = heldBy(board);
  board.call('hand', 'task.submit', {
    id: held.id,
    generation: held.lease_generation,
    handoff: { result: 'Nothing to change.' },
  });
  assert.deepEqual(board.call('boss', 'task.show', { id: held.id }).handoff, {
    result: 'Nothing to change.',
    evidence: [],
    artifacts: [],
    tests: [],
    open_issues: [],
  });
});

test('a malformed handoff is refused invalid and the task stays held', (t) => {
  const { board } = setUp(t);
  const held = heldBy(board);
  const generation = held.lease_generation;
  const malformed: ReadonlyArray<Record<string, unknown>> = [
    { ...HANDOFF, evidence: 'it works' },
    { ...HANDOFF, artifacts: [42] },
    { ...HANDOFF, tests: [{ command: 'node --test tests/parser.test.ts' }] },
    { ...HANDOFF, tests: [{ command: '', passed: 1, failed: 0 }] },
    { ...HANDOFF, tests: [{ command: 'node --test', passed: -1, failed: 0 }] },
    { ...HANDOFF, tests: [{ command: 'node --test', passed: 1.5, failed: 0 }] },
    { ...HANDOFF, open_issues: 'none' },
    { ...HANDOFF, openIssues: [] },
  ];
  for (const handoff of malformed) {
    assert.equal(
      codeOf(() => board.call('hand', 'task.submit', { id: held.id, generation, handoff })),
      'invalid',
      JSON.stringify(handoff)
    );
  }
  const after = board.call('boss', 'task.show', { id: held.id });
  assert.equal(after.task.status, 'in_progress');
  assert.equal(after.results.length, 0);
  // The well-formed handoff goes through, so the refusals above were for the malformed field.
  assert.equal(
    board.call('hand', 'task.submit', { id: held.id, generation, handoff: HANDOFF }).task.status,
    'needs_validation'
  );
});

test('a submit by a principal that does not hold the task is refused forbidden', (t) => {
  const { board } = setUp(t);
  const held = heldBy(board);
  for (const principal of ['hand2', 'boss']) {
    assert.equal(
      codeOf(() =>
        board.call(principal, 'task.submit', { id: held.id, generation: held.lease_generation, handoff: HANDOFF })
      ),
      'forbidden',
      principal
    );
  }
  assert.equal(board.call('boss', 'task.show', { id: held.id }).task.status, 'in_progress');
});

test('a submitting task.result of kind pr becomes a handoff with its uri as the result and the artifact', (t) => {
  const { board } = setUp(t);
  const held = heldBy(board);
  const uri = 'https://example.invalid/pr/7';
  const answer = board.call('hand', 'task.result', {
    id: held.id,
    generation: held.lease_generation,
    kind: 'pr',
    uri,
    submit: true,
  });
  assert.equal(answer.task.status, 'needs_validation');
  const shown = board.call('boss', 'task.show', { id: held.id });
  assert.deepEqual(shown.handoff, { result: uri, evidence: [], artifacts: [uri], tests: [], open_issues: [] });
  assert.deepEqual(
    shown.results.map((row) => row.kind),
    ['handoff']
  );
});

// ---------- review ----------

test("changes puts the task back to its last holder's principal with the comment", (t) => {
  const { board } = setUp(t);
  const task = submitted(board);
  const answer = board.call('rev', 'task.review', {
    id: task.id,
    decision: 'changes',
    comment: 'Handle the old tag too.',
  });
  assert.equal(answer.review.decision, 'changes');
  assert.equal(answer.task.status, 'in_progress');
  assert.equal(answer.task.lease_owner, 'hand');
  assert.ok(
    board
      .call('boss', 'task.show', { id: task.id })
      .comments.some((comment) => comment.text === 'Handle the old tag too.')
  );
  const held = board.call('hand', 'task.orient', {}).held.find((row) => row.id === task.id);
  assert.equal(held?.lease_generation, answer.task.lease_generation);
  assert.equal(
    board.call('hand', 'task.heartbeat', { id: task.id, generation: held?.lease_generation }).status,
    'in_progress'
  );
});

test('changes without a comment is refused invalid and the task keeps waiting for review', (t) => {
  const { board } = setUp(t);
  const task = submitted(board);
  assert.equal(
    codeOf(() => board.call('rev', 'task.review', { id: task.id, decision: 'changes' })),
    'invalid'
  );
  assert.equal(board.call('boss', 'task.show', { id: task.id }).task.status, 'needs_validation');
});

test('accept by a reviewer without green CI is refused forbidden, and the owner accepts the same task to done', (t) => {
  const { board } = setUp(t);
  const task = submitted(board);
  assert.equal(
    codeOf(() => board.call('rev', 'task.review', { id: task.id, decision: 'accept' })),
    'forbidden'
  );
  assert.equal(board.call('boss', 'task.show', { id: task.id }).task.status, 'needs_validation');
  const answer = board.call('boss', 'task.review', { id: task.id, decision: 'accept' });
  assert.equal(answer.task.status, 'done');
  assert.equal(answer.review.decision, 'accept');
});

test('accept by a reviewer on a task with green CI makes it done', (t) => {
  const { board } = setUp(t);
  const task = submitted(board, 'hand', { metadata: { ci: 'green' } });
  assert.equal(board.call('rev', 'task.review', { id: task.id, decision: 'accept' }).task.status, 'done');
});

test('a task filed by the persona is never accepted or sent back by the persona, even one holding the owner role', (t) => {
  const { board } = setUp(t);
  const task = submitted(board, 'hand', { requester: 'persona:42', metadata: { ci: 'green' } }, 'self');
  assert.equal(
    codeOf(() => board.call('self', 'task.review', { id: task.id, decision: 'accept' })),
    'forbidden'
  );
  assert.equal(
    codeOf(() => board.call('self', 'task.review', { id: task.id, decision: 'changes', comment: 'mine, redo it' })),
    'forbidden'
  );
  assert.equal(board.call('boss', 'task.show', { id: task.id }).task.status, 'needs_validation');
  assert.equal(board.call('boss', 'task.review', { id: task.id, decision: 'accept' }).task.status, 'done');
});

test('a reviewer never accepts a task it filed itself', (t) => {
  const { board } = setUp(t);
  const task = submitted(board, 'hand', { metadata: { ci: 'green' } }, 'rev');
  assert.equal(
    codeOf(() => board.call('rev', 'task.review', { id: task.id, decision: 'accept' })),
    'forbidden'
  );
  assert.equal(board.call('boss', 'task.show', { id: task.id }).task.status, 'needs_validation');
});

test('a review of a task that is not waiting for validation is refused invalid-transition', (t) => {
  const { board } = setUp(t);
  const held = heldBy(board);
  assert.equal(
    codeOf(() => board.call('boss', 'task.review', { id: held.id, decision: 'accept' })),
    'invalid-transition'
  );
  assert.equal(board.call('boss', 'task.show', { id: held.id }).task.status, 'in_progress');
});

test('a review decision other than accept or changes is refused invalid', (t) => {
  const { board } = setUp(t);
  const task = submitted(board);
  assert.equal(
    codeOf(() => board.call('boss', 'task.review', { id: task.id, decision: 'approve' })),
    'invalid'
  );
  assert.equal(board.call('boss', 'task.show', { id: task.id }).task.status, 'needs_validation');
});

// ---------- child tasks ----------

test('task.add with a parent writes a parent-child dependency from the child to the parent', (t) => {
  const { board } = setUp(t);
  const parent = board.call('boss', 'task.add', { title: 'parent' });
  const child = board.call('boss', 'task.add', { title: 'child', parent: parent.id });
  assert.deepEqual(
    board.call('boss', 'task.show', { id: child.id }).dependencies.map((row) => [row.depends_on_id, row.type]),
    [[parent.id, 'parent-child']]
  );
  assert.deepEqual(
    board.call('boss', 'task.show', { id: parent.id }).dependents.map((row) => row.task_id),
    [child.id]
  );
});

test('a parent with an open child is refused done with blocked, and moves once the child is closed', (t) => {
  const { board } = setUp(t);
  const parent = heldBy(board);
  const child = board.call('boss', 'task.add', { title: 'child', parent: parent.id });
  board.call('hand', 'task.submit', { id: parent.id, generation: parent.lease_generation, handoff: HANDOFF });
  assert.equal(
    codeOf(() => board.call('boss', 'task.review', { id: parent.id, decision: 'accept' })),
    'blocked'
  );
  assert.equal(board.call('boss', 'task.show', { id: parent.id }).task.status, 'needs_validation');
  board.call('boss', 'task.transition', {
    id: child.id,
    status: 'cancelled',
    revision: board.call('boss', 'task.show', { id: child.id }).task.revision,
    close_reason: 'folded into the parent',
  });
  assert.equal(board.call('boss', 'task.review', { id: parent.id, decision: 'accept' }).task.status, 'done');
});

test('an errand parent with an open child is refused its direct move to done with blocked', (t) => {
  const { board } = setUp(t);
  const parent = board.call('runner', 'task.add', { title: 'errand parent', lane: 'errand' });
  board.call('runner', 'task.transition', { id: parent.id, to: 'approved' });
  board.call('runner', 'task.claim', { id: parent.id });
  board.call('runner', 'task.add', { title: 'errand child', lane: 'errand', parent: parent.id });
  assert.equal(
    codeOf(() => board.call('runner', 'task.transition', { id: parent.id, to: 'done' })),
    'blocked'
  );
  assert.equal(board.call('boss', 'task.show', { id: parent.id }).task.status, 'in_progress');
});

test('task.add with an unknown parent is refused not-found and files nothing', (t) => {
  const { board } = setUp(t);
  assert.equal(
    codeOf(() => board.call('boss', 'task.add', { title: 'orphan', parent: 'T-zzzzzz' })),
    'not-found'
  );
  assert.deepEqual(board.call('boss', 'task.list', {}), []);
});

// ---------- orient ----------

test("orient lists exactly the caller's held, blocked, review-waiting and question-waiting tasks", (t) => {
  const { board } = setUp(t);
  const held = heldBy(board, 'hand');
  const blocked = heldBy(board, 'hand');
  board.call('hand', 'task.block', {
    id: blocked.id,
    generation: blocked.lease_generation,
    reason: 'stuck',
    unblocks: 'a key',
  });
  const othersHeld = heldBy(board, 'hand2');
  const othersBlocked = heldBy(board, 'hand2');
  board.call('hand2', 'task.block', {
    id: othersBlocked.id,
    generation: othersBlocked.lease_generation,
    reason: 'stuck',
    unblocks: 'a key',
  });
  const forReview = submitted(board, 'hand');
  const ownFiling = submitted(board, 'hand2', {}, 'rev');
  const asking = heldBy(board, 'hand2');
  const toRev = board.call('hand2', 'task.ask', {
    id: asking.id,
    generation: asking.lease_generation,
    text: 'Which branch?',
    to_whom: 'rev',
  });
  const toOwner = heldBy(board, 'hand');
  board.call('hand', 'task.ask', {
    id: toOwner.id,
    generation: toOwner.lease_generation,
    text: 'Which key?',
    to_whom: 'owner',
  });

  const hand = board.call('hand', 'task.orient', {});
  assert.deepEqual(
    hand.held.map((row) => [row.id, row.lease_generation]),
    [[held.id, held.lease_generation]]
  );
  assert.deepEqual(
    hand.blocked.map((row) => row.id),
    [blocked.id]
  );
  assert.deepEqual(hand.reviews, []);
  assert.deepEqual(hand.questions, []);

  const rev = board.call('rev', 'task.orient', {});
  assert.deepEqual(rev.held, []);
  assert.deepEqual(rev.blocked, []);
  assert.deepEqual(
    rev.reviews.map((row) => row.id),
    [forReview.id]
  );
  assert.notEqual(ownFiling.id, forReview.id);
  assert.deepEqual(
    rev.questions.map((row) => row.id),
    [toRev.question.id]
  );
  assert.ok(![othersHeld.id, othersBlocked.id].some((id) => hand.held.some((row) => row.id === id)));
});

test('orient of a principal with nothing to do answers four empty lists', (t) => {
  const { board } = setUp(t);
  heldBy(board, 'hand');
  assert.deepEqual(board.call('eyes', 'task.orient', {}), { held: [], blocked: [], reviews: [], questions: [] });
});

// ---------- idempotent retries ----------

test('a retried submit under the same idempotency key returns the first answer and writes one handoff', (t) => {
  const { board } = setUp(t);
  const held = heldBy(board);
  const args = { id: held.id, generation: held.lease_generation, handoff: HANDOFF };
  const first = board.call('hand', 'task.submit', args, 'submit-1');
  const again = board.call('hand', 'task.submit', args, 'submit-1');
  assert.deepEqual(again, first);
  const shown = board.call('boss', 'task.show', { id: held.id });
  assert.equal(shown.results.filter((row) => row.kind === 'handoff').length, 1);
  assert.equal(
    board.eventsSince(0).filter((event) => event.type === 'status' && event.new === 'needs_validation').length,
    1
  );
});

test('a retried claim under the same idempotency key returns the same generation and claims once', (t) => {
  const { board } = setUp(t);
  const task = approvedTask(board);
  const before = board.call('boss', 'task.show', { id: task.id }).task.lease_generation;
  const first = board.call('hand', 'task.claim', { id: task.id }, 'claim-1');
  assert.ok(first.lease_generation > before);
  const again = board.call('hand', 'task.claim', { id: task.id }, 'claim-1');
  assert.equal(again.lease_generation, first.lease_generation);
  assert.equal(board.call('boss', 'task.show', { id: task.id }).task.lease_generation, first.lease_generation);
  assert.equal(board.eventsSince(0).filter((event) => event.type === 'lease.claimed').length, 1);
});

test('a retried review under the same idempotency key writes one review and one comment', (t) => {
  const { board } = setUp(t);
  const task = submitted(board);
  const args = { id: task.id, decision: 'changes', comment: 'Handle the old tag too.' };
  const first = board.call('rev', 'task.review', args, 'review-1');
  const again = board.call('rev', 'task.review', args, 'review-1');
  assert.deepEqual(again, first);
  const shown = board.call('boss', 'task.show', { id: task.id });
  assert.equal(shown.approvals.filter((row) => row.decision === 'changes').length, 1);
  assert.equal(shown.comments.filter((comment) => comment.text === 'Handle the old tag too.').length, 1);
});
