// The board's operations (src/board/board.ts) where they meet the rest of the core: the rights a principal holds come
// from its `boardRoles` in the private layer's clients.json, read at every call; a board that is not at its version
// answers `board-unavailable`; and a board write reaches neither her memory graph nor the files an export reads.
// Temporary directories only, a fixed clock, synthetic principals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.js';
import { reproject } from '../src/memory/db/graph.js';
import { UNIT_OF } from '../src/memory/db/graph-manifest.js';
import { tableHashes } from '../tools/memory-db.mjs';
import { openBoard } from '../src/board/board.ts';
import type { Board, BoardOp, BoardSettings, TaskRecord } from '../src/board/board.ts';
import { BoardError } from '../src/board/machine.ts';
import type { BoardDb } from '../src/board/schema.ts';
import { tempDir } from './fixtures/tmp.js';

const NOW = Date.parse('2026-10-31T10:00:00.000Z');
const SETTINGS: BoardSettings = {
  leaseTtlMinutes: 30,
  autoTriage: { role: 'dev', budget: 4, steps: 80, estimate: 30 },
  projects: {},
};

// open.js types its connection as `object`; it is node:sqlite's DatabaseSync, which has every method BoardDb names.
const dbOf = (handle: { db: object }): BoardDb => handle.db as BoardDb;

/** Writes clients.json: each name with its `boardRoles`, or with no such field when the value is null. */
function writeClients(dir: string, roles: Record<string, ReadonlyArray<string> | null>): void {
  const entries = Object.fromEntries(
    Object.entries(roles).map(([name, list]) => [
      name,
      {
        kind: 'cli',
        tokenFile: `clients/${name}.token`,
        permissions: [],
        ...(list === null ? {} : { boardRoles: list }),
      },
    ])
  );
  fs.writeFileSync(path.join(dir, 'clients.json'), JSON.stringify(entries));
}

const CLIENTS = {
  boss: ['owner'],
  rev: ['reviewer'],
  hand: ['worker'],
  eyes: ['watcher'],
  her: ['persona'],
  bare: null,
  typo: ['admin', 'Owner'],
  derived: ['holder', 'requester', 'answerer', 'reaper'],
};

function setUp(boardMigrations?: ReadonlyArray<string>): { board: Board; dir: string; db: BoardDb; close: () => void } {
  const dir = tempDir('nep-board-');
  writeClients(dir, CLIENTS);
  const handle = boardMigrations ? openMemoryDb(':memory:', { boardMigrations }) : openMemoryDb(':memory:');
  const db = dbOf(handle);
  const board = openBoard({ db, privateDir: dir, now: () => NOW, settings: () => SETTINGS });
  return { board, dir, db, close: () => handle.close() };
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

/** A dev task the owner filed, triaged and approved, claimed by the worker `hand`. */
function heldTask(board: Board): TaskRecord {
  const added = board.call('boss', 'task.add', { title: 'held task', lane: 'dev', project: 'core' });
  const triaged = board.call('boss', 'task.transition', {
    id: added.id,
    status: 'triaged',
    revision: added.revision,
    set: { role: 'dev', estimate: 20, budget: 2 },
  });
  board.call('boss', 'task.approve', { id: triaged.id, scope: 'plan' });
  return board.call('hand', 'task.claim', { id: added.id });
}

test('a principal whose entry grants no board role is refused every operation with forbidden and changes nothing', () => {
  const { board, close } = setUp();
  try {
    const task = heldTask(board);
    const before = board.call('boss', 'task.show', { id: task.id });
    const calls: Array<[BoardOp, Record<string, unknown>]> = [
      ['task.add', {}],
      ['task.list', {}],
      ['task.show', { id: task.id }],
      ['task.update', { id: task.id, revision: task.revision, title: 'renamed' }],
      ['task.transition', { id: task.id, status: 'cancelled', revision: task.revision, close_reason: 'x' }],
      ['task.claim', { id: task.id }],
      ['task.heartbeat', { id: task.id }],
      ['task.release', { id: task.id }],
      ['task.retry', { id: task.id }],
      ['task.depend', { id: task.id, on: task.id }],
      ['task.undepend', { id: task.id, on: task.id }],
      ['task.ask', { id: task.id, text: 'which?', to_whom: 'owner' }],
      ['task.answer', { question_id: 'Q-aaaaaa', text: 'this' }],
      ['task.escalate', { question_id: 'Q-aaaaaa' }],
      ['task.approve', { id: task.id, scope: 'deploy' }],
      ['task.result', { id: task.id, kind: 'summary', body: 'done' }],
      ['task.comment', { id: task.id, text: 'a note' }],
      ['attempt.start', { task_id: task.id }],
      ['attempt.end', { attempt_id: 'A-aaaaaa', outcome: 'done' }],
      ['run.start', { wave: 1 }],
      ['run.end', { id: 'U-aaaaaa' }],
      ['costs.agents', {}],
      ['outbox.pull', { ack: 1000 }],
    ];
    for (const [op, args] of calls)
      assert.equal(
        codeOf(() => board.call('bare', op, args)),
        'forbidden',
        op
      );
    const after = board.call('boss', 'task.show', { id: task.id });
    assert.equal(after.task.revision, before.task.revision);
    assert.equal(after.task.lease_owner, 'hand');
    assert.equal(after.events.length, before.events.length);
    assert.equal(board.call('boss', 'task.list', {}).length, 1);
  } finally {
    close();
  }
});

test('a principal absent from clients.json is refused, and nothing is filed', () => {
  const { board, close } = setUp();
  try {
    assert.equal(
      codeOf(() => board.call('stranger', 'task.add', { title: 'sneaked in' })),
      'forbidden'
    );
    assert.deepEqual(board.call('boss', 'task.list', {}), []);
  } finally {
    close();
  }
});

test('a role name outside the board roles grants nothing, whatever its spelling', () => {
  const { board, close } = setUp();
  try {
    assert.equal(
      codeOf(() => board.call('typo', 'task.add', { title: 'x' })),
      'forbidden'
    );
    assert.equal(
      codeOf(() => board.call('typo', 'task.list', {})),
      'forbidden'
    );
  } finally {
    close();
  }
});

test("a derived role listed in clients.json does not make a principal the holder of another's task", () => {
  const { board, close } = setUp();
  try {
    const task = heldTask(board);
    assert.equal(
      codeOf(() => board.call('derived', 'task.heartbeat', { id: task.id })),
      'forbidden'
    );
    assert.equal(
      codeOf(() => board.call('derived', 'task.release', { id: task.id })),
      'forbidden'
    );
    assert.equal(board.call('boss', 'task.show', { id: task.id }).task.lease_owner, 'hand');
  } finally {
    close();
  }
});

test('a watcher reads the board and is refused a comment', () => {
  const { board, close } = setUp();
  try {
    const task = board.call('boss', 'task.add', { title: 'watched' });
    assert.deepEqual(
      board.call('eyes', 'task.list', {}).map((row) => row.id),
      [task.id]
    );
    assert.equal(board.call('eyes', 'task.show', { id: task.id }).task.title, 'watched');
    assert.equal(
      codeOf(() => board.call('eyes', 'task.comment', { id: task.id, text: 'seen' })),
      'forbidden'
    );
    assert.equal(
      codeOf(() => board.call('eyes', 'task.add', { title: 'mine' })),
      'forbidden'
    );
  } finally {
    close();
  }
});

test('a role taken out of clients.json is gone at the next call', () => {
  const { board, dir, close } = setUp();
  try {
    const task = board.call('boss', 'task.add', { title: 'review me' });
    assert.equal(board.call('rev', 'task.comment', { id: task.id, text: 'first' }).comment.author, 'rev');
    writeClients(dir, { ...CLIENTS, rev: [] });
    assert.equal(
      codeOf(() => board.call('rev', 'task.comment', { id: task.id, text: 'second' })),
      'forbidden'
    );
    assert.deepEqual(
      board.call('boss', 'task.show', { id: task.id }).comments.map((row) => row.text),
      ['first']
    );
  } finally {
    close();
  }
});

test('a clients.json that is not JSON lets no principal act, the owner included', () => {
  const { board, dir, close } = setUp();
  try {
    fs.writeFileSync(path.join(dir, 'clients.json'), '{ "boss": ');
    assert.equal(
      codeOf(() => board.call('boss', 'task.add', { title: 'x' })),
      'forbidden'
    );
    assert.equal(
      codeOf(() => board.call('boss', 'task.list', {})),
      'forbidden'
    );
  } finally {
    close();
  }
});

test('the owner role from clients.json approves a normal-risk plan, which the reviewer may not', () => {
  const { board, close } = setUp();
  try {
    const added = board.call('rev', 'task.add', { title: 'a plan', risk: 'normal' });
    const triaged = board.call('rev', 'task.transition', {
      id: added.id,
      status: 'triaged',
      revision: added.revision,
      set: { role: 'dev', estimate: 20, budget: 2 },
    });
    assert.equal(
      codeOf(() => board.call('rev', 'task.approve', { id: triaged.id, scope: 'plan' })),
      'forbidden'
    );
    assert.equal(board.call('boss', 'task.approve', { id: triaged.id, scope: 'plan' }).task.status, 'approved');
  } finally {
    close();
  }
});

test('a persona principal files for a persona id and cancels that task as its requester; a worker may not file for her', () => {
  const { board, close } = setUp();
  try {
    const filed = board.call('her', 'task.add', { title: 'a wish', lane: 'dev', requester: 'persona:7' });
    assert.equal(filed.requester, 'persona:7');
    const cancelled = board.call('her', 'task.transition', {
      id: filed.id,
      status: 'cancelled',
      revision: filed.revision,
      close_reason: 'she changed her mind',
    });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(
      codeOf(() => board.call('hand', 'task.add', { title: 'forged', requester: 'persona:7' })),
      'forbidden'
    );
  } finally {
    close();
  }
});

test('a deploy approval is recorded by the owner and refused to the reviewer', () => {
  const { board, close } = setUp();
  try {
    const task = heldTask(board);
    assert.equal(
      codeOf(() => board.call('rev', 'task.approve', { id: task.id, scope: 'deploy' })),
      'forbidden'
    );
    assert.equal(board.call('boss', 'task.approve', { id: task.id, scope: 'deploy' }).approval.scope, 'deploy');
    assert.deepEqual(
      board.call('boss', 'task.show', { id: task.id }).approvals.map((row) => row.principal),
      ['boss', 'boss']
    );
  } finally {
    close();
  }
});

test("a memory without its board answers board-unavailable to every operation, the owner's included", () => {
  const { board, close } = setUp([]);
  try {
    const ops: Array<[BoardOp, Record<string, unknown>]> = [
      ['task.list', {}],
      ['task.show', { id: 'T-aaaaaa' }],
      ['task.add', { title: 'x' }],
      ['task.comment', { id: 'T-aaaaaa', text: 'x' }],
      ['outbox.pull', {}],
    ];
    for (const [op, args] of ops)
      assert.equal(
        codeOf(() => board.call('boss', op, args)),
        'board-unavailable',
        op
      );
    assert.equal(
      codeOf(() => board.reap()),
      'board-unavailable'
    );
  } finally {
    close();
  }
});

test('a board write projects nothing into her memory graph and records no unit file', () => {
  const dir = tempDir('nep-board-');
  writeClients(dir, CLIENTS);
  const handle = openMemoryDb(':memory:');
  try {
    const board = openBoard({ db: dbOf(handle), privateDir: dir, now: () => NOW, settings: () => SETTINGS });
    const watched = ['graph_nodes', 'graph_edges', 'node_access', 'files'];
    const before = tableHashes(handle.db, watched);
    const task = heldTask(board);
    board.call('boss', 'task.comment', { id: task.id, text: 'a comment on the board' });
    board.call('hand', 'task.result', { id: task.id, kind: 'summary', body: 'the summary' });
    reproject(handle, { at: new Date(NOW).toISOString() });
    assert.deepEqual(tableHashes(handle.db, watched), before);
    assert.deepEqual(
      Object.keys(UNIT_OF).filter((table) => table.startsWith('board_')),
      []
    );
  } finally {
    handle.close();
  }
});

// The ledger's suite, moved
//
// .agents/ledger/tests/ledger.test.js and claim.test.js of the private ledger service, on the board. The ledger's
// principals are clients of a test clients.json with the board roles of the brief of PR 6a: `owner` and `lead` hold
// `owner` (the lead's principal holds the owner's role, as it does on the ledger today), `dispatcher` holds
// `scheduler`, `core` holds `errand-runner` and `persona`, and `thinker`, in the tests whose ledger had it as a
// delegate, holds `reviewer`. The ledger's config moves to BoardSettings. Not moved, each for a reason the lead has:
// the two tests of the ledger's migrations 2 and 3 (board v1 is ledger v3's shape in one step), the test of the shipped
// auto-triage defaults (they live in config.json, AGENTS.md "Tests"), and the three tests that need a `lead` narrower
// than the owner (attempt.end by the lead, `auto` by the lead at normal risk, an answer by the lead to the thinker's
// question), which no generic role gives.

import { BOARD_MIGRATIONS, boardVersion } from '../src/board/schema.ts';
import { boardSettings } from '../src/board/board.ts';
import type { Row } from '../src/board/board.ts';

type Clock = (() => number) & { advance(minutes: number): void; set(iso: string): void };

function fakeClock(start = '2026-10-17T10:00:00.000Z'): Clock {
  let now = Date.parse(start);
  const clock = (): number => now;
  clock.advance = (minutes: number): void => {
    now += minutes * 60000;
  };
  clock.set = (iso: string): void => {
    now = Date.parse(iso);
  };
  return clock;
}

const LEDGER_ROLES: Record<string, ReadonlyArray<string>> = {
  owner: ['owner'],
  lead: ['owner'],
  dispatcher: ['scheduler'],
  core: ['errand-runner', 'persona'],
};
const WITH_THINKER: Record<string, ReadonlyArray<string>> = { ...LEDGER_ROLES, thinker: ['reviewer'] };

type Ledger = { ledger: Board; clock: Clock; file: string; dir: string; reopen: (clock?: Clock) => Board };

function makeLedger(
  t: { after: (fn: () => void) => void },
  {
    clock = fakeClock(),
    clients = LEDGER_ROLES,
    settings = SETTINGS,
  }: { clock?: Clock; clients?: Record<string, ReadonlyArray<string>>; settings?: BoardSettings } = {}
): Ledger {
  const dir = tempDir('nep-board-ledger-');
  writeClients(dir, clients);
  const file = path.join(dir, 'memory.db');
  const handles: Array<{ close: () => void }> = [];
  // A second connection to the same file stands for a second process: the writer lock of the first is taken over.
  const open = (useClock: Clock): Board => {
    const handle = openMemoryDb(file, handles.length ? { alive: () => false } : {});
    handles.push(handle);
    return openBoard({ db: dbOf(handle), privateDir: dir, now: useClock, settings: () => settings });
  };
  t.after(() => {
    for (const handle of handles) handle.close();
  });
  return { ledger: open(clock), clock, file, dir, reopen: (useClock = clock) => open(useClock) };
}

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof BoardError ? error.code : String(error);
  }
  return 'no error';
}

// Drives a fresh task to `status` along the happy path; returns the task row.
function taskAt(ledger: Board, status: string, extra: Record<string, unknown> = {}): TaskRecord {
  let t = ledger.call('lead', 'task.add', { title: `task to ${status}`, lane: 'dev', project: 'core', ...extra });
  if (status === 'proposed') return t;
  t = ledger.call('lead', 'task.transition', {
    id: t.id,
    status: 'triaged',
    revision: t.revision,
    set: { role: 'implementer', estimate: 40, budget: 3 },
  });
  if (status === 'triaged') return t;
  t = ledger.call('owner', 'task.approve', { id: t.id, scope: 'plan' }).task;
  if (status === 'approved') return t;
  t = ledger.call('dispatcher', 'task.claim', { id: t.id });
  if (status === 'in_progress') return t;
  if (status === 'needs_answer') {
    return ledger.call('dispatcher', 'task.ask', { id: t.id, text: 'which branch?', to_whom: 'owner' }).task;
  }
  t = ledger.call('dispatcher', 'task.result', {
    id: t.id,
    kind: 'pr',
    uri: 'https://example.invalid/pr/1',
    submit: true,
  }).task;
  if (status === 'needs_validation') return t;
  if (status === 'done') return ledger.call('owner', 'task.approve', { id: t.id, scope: 'merge' }).task;
  throw new Error(`taskAt cannot reach ${status}`);
}

// ---------- claim.test.js ----------

test('two claimers on two connections: exactly one wins', (t) => {
  const { ledger: a, reopen } = makeLedger(t);
  const b = reopen();
  const task = taskAt(a, 'approved');
  // B reads the task while it is still approved, then A claims; B's pre-checks pass on its stale read,
  // so only the guarded UPDATE stands between B and a double claim.
  const staleRead = b.getTask(task.id);
  const won = a.call('dispatcher', 'task.claim', { id: task.id });
  assert.equal(won.lease_owner, 'dispatcher');
  const realGet = b.getTask.bind(b);
  b.getTask = (id) => (id === task.id ? staleRead : realGet(id));
  assert.equal(
    errorCode(() => b.call('lead', 'task.claim', { id: task.id })),
    'claimed'
  );
  b.getTask = realGet;
  // Without the stub the second claim is refused the same way.
  assert.equal(
    errorCode(() => b.call('lead', 'task.claim', { id: task.id })),
    'claimed'
  );
  const row = a.call('lead', 'task.show', { id: task.id });
  assert.equal(row.task.lease_owner, 'dispatcher');
  assert.equal(row.events.filter((e) => e.type === 'lease.claimed').length, 1);
});

test('a claim refuses a blocked or deferred task', (t) => {
  const { ledger, clock } = makeLedger(t);
  const blocker = taskAt(ledger, 'proposed');
  const task = taskAt(ledger, 'approved');
  ledger.call('lead', 'task.depend', { id: task.id, on: blocker.id });
  assert.equal(ledger.call('lead', 'task.list', { ready: true }).length, 0);
  assert.equal(
    errorCode(() => ledger.call('dispatcher', 'task.claim', { id: task.id })),
    'blocked'
  );
  const b = ledger.call('lead', 'task.show', { id: blocker.id }).task;
  ledger.call('lead', 'task.transition', {
    id: blocker.id,
    status: 'cancelled',
    revision: b.revision,
    close_reason: 'gone',
  });
  assert.equal(ledger.call('lead', 'task.show', { id: task.id }).task.is_blocked, 0);
  const cur = ledger.call('lead', 'task.show', { id: task.id }).task;
  ledger.call('lead', 'task.update', { id: task.id, revision: cur.revision, defer_until: '2026-10-17T11:00:00Z' });
  assert.equal(
    errorCode(() => ledger.call('dispatcher', 'task.claim', { id: task.id })),
    'blocked'
  );
  clock.advance(61);
  assert.deepEqual(
    ledger.call('lead', 'task.list', { ready: true }).map((x) => x.id),
    [task.id]
  );
  assert.equal(ledger.call('dispatcher', 'task.claim', { id: task.id }).status, 'in_progress');
});

test('ready tasks with the same priority and created_at come back in filing order, not id order', (t) => {
  const { ledger } = makeLedger(t);
  // The fake clock stands still, so every row shares created_at; tasks and comments get ids in reverse order.
  const ids: Record<string, Array<string>> = { T: ['ZZZZZZ', 'MMMMMM', 'AAAAAA'], C: ['ZZZZZZ', 'MMMMMM', 'AAAAAA'] };
  const newId = ledger.newId.bind(ledger);
  ledger.newId = (prefix, table) => {
    const next = ids[prefix]?.shift();
    return next ? `${prefix}-${next}` : newId(prefix, table);
  };
  const filed = [taskAt(ledger, 'approved'), taskAt(ledger, 'approved'), taskAt(ledger, 'approved')].map((x) => x.id);
  assert.deepEqual(filed, ['T-ZZZZZZ', 'T-MMMMMM', 'T-AAAAAA']);
  assert.deepEqual(
    ledger.call('lead', 'task.list', { ready: true }).map((x) => x.id),
    filed
  );
  assert.deepEqual(
    ledger.call('lead', 'task.list', {}).map((x) => x.id),
    filed
  );
  for (const text of ['first', 'second', 'third']) ledger.call('lead', 'task.comment', { id: filed[0], text });
  assert.deepEqual(
    ledger.call('lead', 'task.show', { id: filed[0] }).comments.map((c) => c.text),
    ['first', 'second', 'third']
  );
});

test('the reaper returns an expired lease to approved; a heartbeat keeps it', (t) => {
  const { ledger, clock } = makeLedger(t);
  const kept = taskAt(ledger, 'in_progress');
  const lost = taskAt(ledger, 'in_progress');
  clock.advance(20);
  assert.equal(
    errorCode(() => ledger.call('lead', 'task.heartbeat', { id: kept.id })),
    'forbidden'
  );
  ledger.call('dispatcher', 'task.heartbeat', { id: kept.id });
  clock.advance(15);
  assert.deepEqual(ledger.reap(), [lost.id]);
  const back = ledger.call('lead', 'task.show', { id: lost.id });
  assert.equal(back.task.status, 'approved');
  assert.equal(back.task.lease_owner, null);
  assert.ok(back.events.some((e) => e.type === 'lease.expired' && e.actor === 'reaper'));
  assert.equal(ledger.call('lead', 'task.show', { id: kept.id }).task.status, 'in_progress');
  // The returned task can be claimed again.
  assert.equal(ledger.call('lead', 'task.claim', { id: lost.id }).lease_owner, 'lead');
});

// ---------- ledger.test.js ----------

test('ids are a prefix and six base32 characters', (t) => {
  const { ledger } = makeLedger(t);
  for (let i = 0; i < 20; i += 1)
    assert.match(ledger.call('lead', 'task.add', { title: `t${i}` }).id, /^T-[a-z2-7]{6}$/);
  const task = taskAt(ledger, 'in_progress');
  assert.match(ledger.call('lead', 'task.comment', { id: task.id, text: 'hi' }).comment.id, /^C-[a-z2-7]{6}$/);
});

test('the revision token: required for update, a stale one is refused, each mutation bumps it', (t) => {
  const { ledger } = makeLedger(t);
  const task = ledger.call('lead', 'task.add', { title: 'rev' });
  assert.equal(task.revision, 1);
  assert.equal(
    errorCode(() => ledger.call('lead', 'task.update', { id: task.id, title: 'x' })),
    'invalid'
  );
  const updated = ledger.call('lead', 'task.update', { id: task.id, revision: 1, title: 'renamed', priority: 0 });
  assert.equal(updated.revision, 2);
  assert.equal(updated.title, 'renamed');
  assert.equal(
    errorCode(() => ledger.call('lead', 'task.update', { id: task.id, revision: 1, title: 'late' })),
    'stale'
  );
  assert.equal(
    errorCode(() =>
      ledger.call('lead', 'task.transition', { id: task.id, status: 'cancelled', revision: 1, close_reason: 'x' })
    ),
    'stale'
  );
  assert.equal(ledger.call('lead', 'task.comment', { id: task.id, text: 'note' }).task.revision, 3);
  assert.equal(
    errorCode(() => ledger.call('lead', 'task.comment', { id: task.id, text: 'n', revision: 2 })),
    'stale'
  );
  assert.equal(
    errorCode(() => ledger.call('core', 'task.update', { id: task.id, revision: 3, title: 'mine' })),
    'forbidden'
  );
  assert.equal(
    errorCode(() => ledger.call('lead', 'task.update', { id: task.id, revision: 3, priority: 9 })),
    'invalid'
  );
});

test('the idempotency key returns the stored response without re-applying, for 24 hours, per principal', (t) => {
  const { ledger, clock } = makeLedger(t);
  const first = ledger.call('lead', 'task.add', { title: 'once' }, 'key-1');
  const again = ledger.call('lead', 'task.add', { title: 'once' }, 'key-1');
  assert.deepEqual(again, first);
  assert.equal(ledger.call('lead', 'task.list', {}).length, 1);
  const otherPrincipal = ledger.call('core', 'task.add', { title: 'once' }, 'key-1');
  assert.notEqual(otherPrincipal.id, first.id);
  // A refused op stores nothing: the retry is evaluated again.
  assert.equal(
    errorCode(() => ledger.call('lead', 'task.add', { title: '' }, 'key-2')),
    'invalid'
  );
  assert.match(ledger.call('lead', 'task.add', { title: 'second try' }, 'key-2').id, /^T-/);
  clock.advance(24 * 60 + 1);
  ledger.reap();
  assert.notEqual(ledger.call('lead', 'task.add', { title: 'once' }, 'key-1').id, first.id);
  assert.equal(ledger.call('lead', 'task.list', {}).filter((x) => x.title === 'once').length, 3);
});

test('the event log: one gapless sequence, written with each mutation, in order', (t) => {
  const { ledger } = makeLedger(t);
  const task = taskAt(ledger, 'done');
  const events = ledger.eventsSince(0);
  events.forEach((e, i) => assert.equal(e.seq, i + 1));
  const statuses = events.filter((e) => e.type === 'status').map((e) => e.new);
  assert.deepEqual(statuses, ['proposed', 'triaged', 'approved', 'in_progress', 'needs_validation', 'done']);
  const types = events.map((e) => e.type);
  for (const type of ['task.created', 'task.updated', 'approval', 'lease.claimed', 'result']) {
    assert.ok(types.includes(type), type);
  }
  assert.ok(events.every((e) => e.task_id === task.id && e.created_at.endsWith('Z')));
  assert.deepEqual(
    ledger.eventsSince(events.length - 2).map((e) => e.seq),
    [events.length - 1, events.length]
  );
  assert.equal(
    errorCode(() => ledger.call('lead', 'task.comment', { id: task.id, text: '' })),
    'invalid'
  );
  assert.equal(ledger.eventsSince(0).length, events.length);
});

const payloadOf = (row: Row | undefined): Record<string, unknown> =>
  // An outbox row's payload is the JSON object the board wrote with it.
  (row?.payload ?? {}) as Record<string, unknown>;

test('the outbox: completions to the subscriber, answers to the asker; pull, ack, only your own', (t) => {
  const { ledger } = makeLedger(t);
  const done = taskAt(ledger, 'done');
  const asked = taskAt(ledger, 'needs_answer');
  const q = ledger.call('lead', 'task.show', { id: asked.id }).questions[0];
  ledger.call('owner', 'task.answer', { question_id: q?.id, text: 'main' });
  const errand = ledger.call('core', 'task.add', { title: 'look it up', lane: 'errand', subscriber: 'core:111:222' });
  ledger.call('core', 'task.transition', {
    id: errand.id,
    status: 'cancelled',
    revision: errand.revision,
    close_reason: 'not needed',
  });

  const lead = ledger.call('lead', 'outbox.pull', {});
  assert.deepEqual(
    lead.map((r) => [r.task_id, r.kind]),
    [
      [done.id, 'done'],
      [asked.id, 'needs_answer'],
    ]
  );
  assert.equal(payloadOf(lead[0]).status, 'done');
  const dispatcher = ledger.call('dispatcher', 'outbox.pull', {});
  assert.deepEqual(
    dispatcher.map((r) => r.kind),
    ['answer']
  );
  assert.equal(payloadOf(dispatcher[0]).text, 'main');
  const core = ledger.call('core', 'outbox.pull', {});
  assert.deepEqual(
    core.map((r) => [r.to_whom, r.kind]),
    [['core:111:222', 'cancelled']]
  );

  assert.deepEqual(
    ledger.call('lead', 'outbox.pull', { ack: lead[0]?.seq }).map((r) => r.seq),
    [lead[1]?.seq]
  );
  assert.deepEqual(ledger.call('lead', 'outbox.pull', { ack: lead[1]?.seq }), []);
  // The lead's ack never marks someone else's rows.
  assert.equal(ledger.call('lead', 'outbox.pull', { ack: 1000 }).length, 0);
  assert.equal(ledger.call('dispatcher', 'outbox.pull', {}).length, 1);
});

test('dependencies: blocks projects is_blocked, cycles and self-edges are refused, undepend unblocks', (t) => {
  const { ledger } = makeLedger(t);
  const a = taskAt(ledger, 'approved');
  const b = taskAt(ledger, 'proposed');
  assert.equal(ledger.call('lead', 'task.depend', { id: a.id, on: b.id }).is_blocked, 1);
  assert.equal(
    errorCode(() => ledger.call('lead', 'task.depend', { id: b.id, on: a.id })),
    'invalid'
  );
  assert.equal(
    errorCode(() => ledger.call('lead', 'task.depend', { id: a.id, on: a.id })),
    'invalid'
  );
  assert.equal(ledger.call('lead', 'task.depend', { id: b.id, on: a.id, type: 'related' }).is_blocked, 0);
  const shown = ledger.call('lead', 'task.show', { id: a.id });
  assert.deepEqual(
    shown.dependencies.map((d) => d.depends_on_id),
    [b.id]
  );
  assert.equal(ledger.call('lead', 'task.undepend', { id: a.id, on: b.id }).is_blocked, 0);
  assert.equal(
    errorCode(() => ledger.call('lead', 'task.undepend', { id: a.id, on: b.id })),
    'not-found'
  );
});

test('a restart keeps every task where it was, the lease included, and does not migrate twice', (t) => {
  const { ledger, file, dir, clock } = makeLedger(t);
  const held = taskAt(ledger, 'in_progress');
  const waiting = taskAt(ledger, 'needs_answer');
  // The restart: the file opened again by a new process, the first one gone.
  const handle = openMemoryDb(file, { alive: () => false });
  t.after(() => handle.close());
  const reopened = openBoard({ db: dbOf(handle), privateDir: dir, now: clock, settings: () => SETTINGS });
  assert.equal(boardVersion(dbOf(handle)), BOARD_MIGRATIONS.length);
  const h = reopened.call('lead', 'task.show', { id: held.id }).task;
  assert.equal(h.status, 'in_progress');
  assert.equal(h.lease_owner, 'dispatcher');
  assert.equal(h.lease_expires_at, held.lease_expires_at);
  assert.equal(reopened.call('lead', 'task.show', { id: waiting.id }).task.status, 'needs_answer');
  assert.equal(dbOf(handle).prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
  clock.advance(31);
  assert.deepEqual(reopened.reap(), [held.id]);
});

test('run.start and run.end: the thinker only, once, its accounting kept; idempotency keys as elsewhere', (t) => {
  const { ledger, clock } = makeLedger(t, { clients: WITH_THINKER });
  for (const p of ['lead', 'owner', 'dispatcher', 'core']) {
    assert.equal(
      errorCode(() => ledger.call(p, 'run.start', { wave: 1 })),
      'forbidden',
      p
    );
  }
  assert.equal(
    errorCode(() => ledger.call('thinker', 'run.start', {})),
    'invalid'
  );
  assert.equal(
    errorCode(() => ledger.call('thinker', 'run.start', { wave: 1, trigger_seqs: ['x'] })),
    'invalid'
  );
  const run = ledger.call('thinker', 'run.start', { wave: 2, trigger_seqs: [4, 7] }, 'w2:t1:run.start');
  assert.match(String(run.id), /^U-[a-z2-7]{6}$/);
  assert.deepEqual(
    [run.wave, run.trigger_seqs, run.session_id, run.started_at],
    [2, '[4,7]', null, '2026-10-17T10:00:00.000Z']
  );
  assert.equal(
    ledger.call('thinker', 'run.start', { wave: 2 }, 'w2:t1:run.start').id,
    run.id,
    'the key did not return the stored run'
  );
  assert.equal(
    errorCode(() => ledger.call('lead', 'run.end', { id: run.id })),
    'forbidden'
  );
  assert.equal(
    errorCode(() => ledger.call('thinker', 'run.end', { id: 'U-zzzzzz' })),
    'not-found'
  );
  assert.equal(
    errorCode(() => ledger.call('thinker', 'run.end', { id: run.id, steps: -1 })),
    'invalid'
  );
  clock.advance(10);
  const end = {
    id: run.id,
    session_id: 'ses_1',
    steps: 9,
    tokens_in: 120,
    tokens_out: 3400,
    cache_read: 90000,
    cache_write: 8000,
    cost_est_usd: 0.42,
    context_mean: 60000,
    context_peak: 98000,
    compactions: 1,
    outcome: 'done',
  };
  const ended = ledger.call('thinker', 'run.end', end, 'w2:t1:run.end');
  // The whole row is the point: every field run.end was given is stored as given.
  assert.deepEqual(
    { ...ended, id: undefined, trigger_seqs: undefined, started_at: undefined },
    {
      ...end,
      id: undefined,
      agent: 'thinker',
      wave: 2,
      trigger_seqs: undefined,
      started_at: undefined,
      ended_at: '2026-10-17T10:10:00.000Z',
    }
  );
  assert.deepEqual(ledger.call('thinker', 'run.end', end, 'w2:t1:run.end'), { ...ended });
  assert.equal(
    errorCode(() => ledger.call('thinker', 'run.end', { id: run.id })),
    'invalid'
  );
  const other = ledger.call('thinker', 'run.start', { wave: 2, session_id: 'ses_1' });
  assert.equal(
    errorCode(() => ledger.call('thinker', 'run.end', { id: other.id, session_id: 'ses_2' })),
    'invalid'
  );
});

type CostWindow = { runs: number; input: number; output: number; usd: number };
type AgentCost = { today: CostWindow; last7: CostWindow; last30: CostWindow; last_wave: unknown };
// costs.agents answers one AgentCost per principal (src/board/costs.ts).
const costsOf = (ledger: Board, principal: string, args: Record<string, unknown>): Record<string, AgentCost> =>
  ledger.call(principal, 'costs.agents', args) as Record<string, AgentCost>;

// The ledger's expectations here keyed the spend by the fixed agents `thinker` and `dev`, counting only the attempts of
// the roles dev, implementer and writer. On the board the keys are the principals (the lead's decision on the brief's
// known conflicts): the dispatcher's attempts count as the dispatcher's, whatever their role, so the attempt of role
// `other` counts too, and the expectations of the dispatcher's row below are the ledger's dev row plus that attempt.
test('costs.agents: today, 7 and 30 UTC days; runs by start day, spend by end day; keyed by principal', (t) => {
  // now: 2026-10-17 10:00 UTC. Today starts 2026-10-17, last7 2026-10-11, last30 2026-09-18.
  const clock = fakeClock('2026-09-10T12:00:00.000Z');
  const { ledger } = makeLedger(t, { clock, clients: WITH_THINKER });
  const at = (iso: string): void => clock.set(iso);
  const turn = (start: string, end: string, fields: Record<string, unknown>): void => {
    at(start);
    const r = ledger.call('thinker', 'run.start', { wave: fields.wave ?? 1 });
    at(end);
    ledger.call('thinker', 'run.end', { id: r.id, ...fields, wave: undefined });
  };
  const attempt = (role: string, start: string, end: string, fields: Record<string, unknown>): void => {
    at(start);
    const task = taskAt(ledger, 'in_progress');
    const a = ledger.call('dispatcher', 'attempt.start', { task_id: task.id, role });
    at(end);
    ledger.call('dispatcher', 'attempt.end', { attempt_id: a.id, outcome: 'done', ...fields });
  };
  turn('2026-09-10T12:00:00.000Z', '2026-09-10T12:30:00.000Z', {
    tokens_in: 1000,
    tokens_out: 1000,
    cost_est_usd: 100,
  });
  // Started the day before last30 began, ended inside it: the spend counts in last30, the run does not.
  turn('2026-09-17T23:50:00.000Z', '2026-09-18T00:10:00.000Z', { tokens_in: 1, tokens_out: 2, cost_est_usd: 0.5 });
  turn('2026-10-11T00:00:00.000Z', '2026-10-11T00:20:00.000Z', { tokens_in: 10, tokens_out: 20, cost_est_usd: 1 });
  // Started yesterday, ended at today's first minute.
  turn('2026-10-16T23:59:00.000Z', '2026-10-17T00:01:00.000Z', {
    tokens_in: 100,
    tokens_out: 200,
    cost_est_usd: 2,
    wave: 2,
  });
  attempt('implementer', '2026-10-17T08:00:00.000Z', '2026-10-17T08:30:00.000Z', {
    tokens_in: 5,
    tokens_out: 6,
    tokens_reasoning: 4,
    cost_est_usd: 0.25,
  });
  attempt('dev', '2026-10-12T08:00:00.000Z', '2026-10-12T09:00:00.000Z', {
    tokens_in: 7,
    tokens_out: 8,
    cost_est_usd: 0.5,
  });
  attempt('writer', '2026-10-01T08:00:00.000Z', '2026-10-01T09:00:00.000Z', {
    tokens_in: 3,
    tokens_out: 3,
    cost_est_usd: 0.125,
  });
  attempt('other', '2026-10-17T08:00:00.000Z', '2026-10-17T08:30:00.000Z', { tokens_in: 9, cost_est_usd: 9 });
  // An attempt still running: one run today, no spend yet.
  at('2026-10-17T09:00:00.000Z');
  const running = taskAt(ledger, 'in_progress');
  ledger.call('dispatcher', 'attempt.start', { task_id: running.id, role: 'dev' });
  // A turn after now counts nowhere.
  turn('2026-10-18T01:00:00.000Z', '2026-10-18T01:10:00.000Z', { tokens_in: 5000, cost_est_usd: 50, wave: 2 });

  const costs = costsOf(ledger, 'core', { now: '2026-10-17T10:00:00.000Z' });
  const row = (runs: number, input: number, output: number, usd: number): CostWindow => ({ runs, input, output, usd });
  assert.deepEqual(
    { today: costs.thinker?.today, last7: costs.thinker?.last7, last30: costs.thinker?.last30 },
    {
      today: row(0, 100, 200, 2),
      last7: row(2, 110, 220, 3),
      last30: row(2, 111, 222, 3.5),
    }
  );
  assert.deepEqual(
    { today: costs.dispatcher?.today, last7: costs.dispatcher?.last7, last30: costs.dispatcher?.last30 },
    { today: row(3, 14, 10, 9.25), last7: row(4, 21, 18, 9.75), last30: row(5, 24, 21, 9.875) }
  );
  assert.deepEqual(Object.keys(costs), ['thinker', 'dispatcher']);
  // The last wave is the latest run's: wave 2, its two turns, whatever their day.
  assert.deepEqual(costs.thinker?.last_wave, { wave: 2, turns: 2, usd: 52, context_mean: null, context_peak: null });
  // Without now, the board's clock.
  at('2026-10-17T10:00:00.000Z');
  assert.deepEqual(costsOf(ledger, 'lead', {}).dispatcher, costs.dispatcher);
  assert.equal(
    errorCode(() => ledger.call('lead', 'costs.agents', { now: 'soon' })),
    'invalid'
  );
});

test("costs.agents: the thinker's last wave weighs each turn's context mean by its steps; none before a run", (t) => {
  const { ledger, clock } = makeLedger(t, { clients: WITH_THINKER });
  assert.equal(costsOf(ledger, 'lead', {}).thinker?.last_wave, null);
  const turn = (wave: number, fields: Record<string, unknown>): void => {
    const r = ledger.call('thinker', 'run.start', { wave });
    clock.advance(1);
    ledger.call('thinker', 'run.end', { id: r.id, ...fields });
  };
  turn(1, { steps: 50, context_mean: 300000, context_peak: 390000, cost_est_usd: 5 });
  turn(2, { steps: 10, context_mean: 40000, context_peak: 60000, cost_est_usd: 0.5 });
  turn(2, { steps: 30, context_mean: 80000, context_peak: 150000, cost_est_usd: 1.25 });
  turn(2, { cost_est_usd: 0.25 });
  assert.deepEqual(costsOf(ledger, 'lead', {}).thinker?.last_wave, {
    wave: 2,
    turns: 3,
    usd: 2,
    context_mean: 70000,
    context_peak: 150000,
  });
});

const TRIAGE = { role: 'dev', budget: 4, steps: 80, estimate: 30 };

test("task.add with auto triages and approves in one step, with the project's defaults under explicit fields", (t) => {
  const settings = boardSettings({
    board: {
      autoTriage: TRIAGE,
      projects: { core: { autoTriage: { role: 'dev', budget: 2, steps: 50, estimate: 20 } } },
    },
  });
  const { ledger } = makeLedger(t, { clients: { owner: ['owner'] }, settings });
  const task = ledger.call('owner', 'task.add', { title: 'small', project: 'core', auto: true });
  assert.equal(task.status, 'approved');
  assert.deepEqual([task.role, task.budget_usd, task.step_cap, task.estimate_minutes], ['dev', 2, 50, 20]);
  const shown = ledger.call('owner', 'task.show', { id: task.id });
  assert.ok(shown.ready);
  assert.deepEqual(
    shown.approvals.map((a) => [a.principal, a.scope, a.decision]),
    [['owner', 'plan', 'approve']]
  );
  assert.deepEqual(
    shown.events.filter((e) => e.type === 'status').map((e) => e.new),
    ['proposed', 'triaged', 'approved']
  );
  // An explicit field wins over the project's default.
  const own = ledger.call('owner', 'task.add', {
    title: 'own budget',
    project: 'core',
    auto: true,
    budget: 1,
    role: 'implementer',
  });
  assert.deepEqual([own.role, own.budget_usd, own.step_cap], ['implementer', 1, 50]);
  // A project without an entry takes the board-wide defaults.
  const other = ledger.call('owner', 'task.add', { title: 'elsewhere', project: 'workspace', auto: true });
  assert.equal(other.status, 'approved');
  assert.deepEqual(
    [other.role, other.budget_usd, other.step_cap, other.estimate_minutes],
    [TRIAGE.role, TRIAGE.budget, TRIAGE.steps, TRIAGE.estimate]
  );
  // Without auto nothing changes: proposed, no fields filled.
  const plain = ledger.call('owner', 'task.add', { title: 'plain', project: 'core' });
  assert.deepEqual([plain.status, plain.role, plain.budget_usd], ['proposed', null, null]);
});

test('a project entry overrides the board-wide auto triage field by field', (t) => {
  const settings = boardSettings({
    board: {
      autoTriage: { role: 'implementer', budget: 5, steps: 90, estimate: 45 },
      projects: { core: { autoTriage: { budget: 1 } } },
    },
  });
  const { ledger } = makeLedger(t, { clients: { owner: ['owner'] }, settings });
  const core = ledger.call('owner', 'task.add', { title: 'core', project: 'core', auto: true });
  assert.deepEqual([core.role, core.budget_usd, core.step_cap, core.estimate_minutes], ['implementer', 1, 90, 45]);
  const other = ledger.call('owner', 'task.add', { title: 'other', project: 'workspace', auto: true });
  assert.deepEqual([other.role, other.budget_usd, other.step_cap, other.estimate_minutes], ['implementer', 5, 90, 45]);
});

test('a bad auto-triage entry in the settings is refused when the settings are read', () => {
  assert.throws(() => boardSettings({ board: { projects: { core: { autoTriage: { budget: -1 } } } } }), /core.*budget/);
  assert.throws(
    () => boardSettings({ board: { projects: { core: { autoTriage: { colour: 'red' } } } } }),
    /core.*colour/
  );
  assert.throws(() => boardSettings({ board: { autoTriage: { steps: 0 } } }), /step_cap/);
});

test('task.transition takes the target in to as well as in status; both given must agree', (t) => {
  const { ledger } = makeLedger(t);
  // The errand mirror names the target in to.
  const a = ledger.call('core', 'task.add', { title: 'look it up', lane: 'errand', requester: 'persona:42' });
  const set = { role: 'implementer', budget_usd: 0.5, step_cap: 20, estimate_minutes: 5 };
  const triaged = ledger.call('core', 'task.transition', { id: a.id, to: 'triaged', revision: a.revision, set });
  assert.equal(triaged.status, 'triaged');
  assert.deepEqual(
    [triaged.role, triaged.budget_usd, triaged.step_cap, triaged.estimate_minutes],
    ['implementer', 0.5, 20, 5]
  );
  const approved = ledger.call('core', 'task.transition', { id: a.id, to: 'approved', revision: triaged.revision });
  assert.equal(approved.status, 'approved');
  assert.equal(ledger.call('core', 'task.claim', { id: a.id }).lease_owner, 'core');
  const cur = ledger.call('lead', 'task.show', { id: a.id }).task;
  const done = ledger.call('core', 'task.transition', { id: a.id, to: 'done', revision: cur.revision });
  assert.deepEqual([done.status, done.lease_owner], ['done', null]);
  // status wins over to only when they agree; differing targets are refused, nothing moves.
  const b = ledger.call('core', 'task.add', { title: 'b', lane: 'errand' });
  assert.equal(
    errorCode(() =>
      ledger.call('core', 'task.transition', { id: b.id, status: 'triaged', to: 'approved', revision: b.revision })
    ),
    'invalid'
  );
  assert.equal(ledger.call('lead', 'task.show', { id: b.id }).task.status, 'proposed');
  assert.equal(
    ledger.call('core', 'task.transition', { id: b.id, status: 'triaged', to: 'triaged', revision: b.revision }).status,
    'triaged'
  );
});

test('the errand runner moves its errand-lane tasks without a revision; a given one must match; other tasks still need one', (t) => {
  const { ledger, clock } = makeLedger(t);
  // The full mirror path with exactly the args the core's errand mirror builds (src/errands/ledger.ts), in its order,
  // no revision anywhere.
  const walk = (state: string, closeReason: string | null, outcome: string): void => {
    const a = ledger.call('core', 'task.add', {
      lane: 'errand',
      project: null,
      title: 'look it up',
      description: 'look it up',
      requester: 'persona:42',
      role: 'web',
      subscriber: 'core:111:222',
      metadata: { coreId: 'E1', scope: 'chat', agent: 'web' },
    });
    const triaged = ledger.call('core', 'task.transition', {
      id: a.id,
      to: 'triaged',
      set: { role: 'web', budget_usd: 1, step_cap: 25, estimate_minutes: 5 },
    });
    assert.deepEqual(
      [triaged.status, triaged.role, triaged.budget_usd, triaged.step_cap, triaged.estimate_minutes],
      ['triaged', 'web', 1, 25, 5]
    );
    assert.equal(ledger.call('core', 'task.transition', { id: a.id, to: 'approved' }).status, 'approved');
    const claimed = ledger.call('core', 'task.claim', { id: a.id, lease_seconds: 360 });
    assert.equal(claimed.lease_owner, 'core');
    assert.equal(Date.parse(claimed.lease_expires_at ?? '') - Date.parse(claimed.heartbeat_at ?? ''), 6 * 60000);
    const attempt = ledger.call('core', 'attempt.start', {
      task_id: a.id,
      principal: 'core',
      role: 'web',
      model: 'm',
      worktree: null,
    });
    clock.advance(1);
    const beat = ledger.call('core', 'task.heartbeat', { id: a.id, lease_seconds: 361 });
    assert.equal(Date.parse(beat.lease_expires_at ?? '') - Date.parse(beat.heartbeat_at ?? ''), 7 * 60000);
    clock.advance(1);
    ledger.call('core', 'task.heartbeat', { id: a.id, lease_seconds: 361 });
    const ended = ledger.call('core', 'attempt.end', { id: attempt.id, outcome: state, steps: 4, cost_usd: 0.12 });
    assert.deepEqual([ended.outcome, ended.steps, ended.cost_est_usd], [outcome, 4, 0.12]);
    ledger.call('core', 'task.result', {
      task_id: a.id,
      kind: 'summary',
      text: 'found it',
      metadata: { withheld: ['secret.txt'] },
    });
    ledger.call('core', 'task.result', {
      task_id: a.id,
      kind: 'file',
      uri: 'errand-file:E1/notes.txt',
      metadata: { name: 'notes.txt', contentType: 'text/plain', bytes: 12 },
    });
    const closed = ledger.call(
      'core',
      'task.transition',
      closeReason ? { id: a.id, to: state, close_reason: closeReason } : { id: a.id, to: state }
    );
    assert.deepEqual([closed.status, closed.lease_owner, closed.close_reason], [state, null, closeReason]);
    const shown = ledger.call('lead', 'task.show', { id: a.id });
    assert.deepEqual(
      shown.results.map((r) => [r.kind, r.body, r.uri]),
      [
        ['summary', 'found it', null],
        ['file', null, 'errand-file:E1/notes.txt'],
      ]
    );
  };
  walk('done', null, 'done');
  walk('failed', 'timeout', 'failed');
  walk('cancelled', 'cancelled', 'stopped');
  // Two names for one value must agree.
  const r = ledger.call('core', 'task.add', { title: 'r', lane: 'errand' });
  assert.equal(
    errorCode(() => ledger.call('core', 'task.result', { id: r.id, task_id: 'T-other', kind: 'summary', body: 'x' })),
    'invalid'
  );
  assert.equal(
    errorCode(() => ledger.call('core', 'task.result', { id: r.id, kind: 'summary', body: 'x', text: 'y' })),
    'invalid'
  );
  assert.equal(
    ledger.call('core', 'task.result', { id: r.id, task_id: r.id, kind: 'summary', body: 'x', text: 'x' }).result.body,
    'x'
  );
  // A proposed errand cancelled straight away, no revision.
  const c = ledger.call('core', 'task.add', { title: 'c', lane: 'errand' });
  assert.equal(
    ledger.call('core', 'task.transition', { id: c.id, to: 'cancelled', close_reason: 'not needed' }).status,
    'cancelled'
  );
  // A wrong revision the errand runner gives is still refused, nothing moves.
  const d = ledger.call('core', 'task.add', { title: 'd', lane: 'errand' });
  assert.equal(
    errorCode(() =>
      ledger.call('core', 'task.transition', {
        id: d.id,
        to: 'triaged',
        revision: d.revision + 1,
        set: { role: 'web', budget_usd: 1, step_cap: 25, estimate_minutes: 5 },
      })
    ),
    'stale'
  );
  assert.equal(ledger.call('lead', 'task.show', { id: d.id }).task.status, 'proposed');
  // The lead on an errand and anyone on a dev task still need the revision.
  assert.equal(
    errorCode(() => ledger.call('lead', 'task.transition', { id: d.id, to: 'cancelled', close_reason: 'x' })),
    'invalid'
  );
  const dev = ledger.call('lead', 'task.add', { title: 'dev', lane: 'dev', project: 'core' });
  assert.equal(
    errorCode(() =>
      ledger.call('lead', 'task.transition', {
        id: dev.id,
        status: 'triaged',
        set: { role: 'implementer', estimate: 40, budget: 3 },
      })
    ),
    'invalid'
  );
  assert.equal(
    errorCode(() => ledger.call('core', 'task.transition', { id: dev.id, to: 'cancelled', close_reason: 'x' })),
    'invalid'
  );
  assert.equal(ledger.call('lead', 'task.show', { id: dev.id }).task.status, 'proposed');
});

test("with a thinker on the board, auto stops a dev task at triaged; now, the thinker's own filing and other lanes go on", (t) => {
  const { ledger } = makeLedger(t, { clients: WITH_THINKER });
  const held = ledger.call('owner', 'task.add', { title: 'brief me', project: 'core', auto: true });
  assert.equal(held.status, 'triaged');
  assert.deepEqual(
    [held.role, held.budget_usd, held.step_cap, held.estimate_minutes],
    [SETTINGS.autoTriage.role, SETTINGS.autoTriage.budget, SETTINGS.autoTriage.steps, SETTINGS.autoTriage.estimate]
  );
  const shown = ledger.call('owner', 'task.show', { id: held.id });
  assert.equal(shown.ready, false);
  assert.deepEqual(shown.approvals, []);
  assert.deepEqual(ledger.call('dispatcher', 'task.list', { ready: true, lane: 'dev' }), []);
  // The thinker approves it after the brief (the owner's right; the reviewer's only at risk low).
  assert.equal(
    errorCode(() => ledger.call('thinker', 'task.approve', { id: held.id, scope: 'plan' })),
    'forbidden',
    "a normal-risk plan is not the thinker's"
  );
  assert.equal(ledger.call('owner', 'task.approve', { id: held.id, scope: 'plan' }).task.status, 'approved');
  // The explicit override.
  const now = ledger.call('owner', 'task.add', { title: 'now', project: 'core', auto: true, no_brief: true });
  assert.equal(now.status, 'approved');
  assert.deepEqual(
    ledger.call('owner', 'task.show', { id: now.id }).approvals.map((a) => a.note),
    ['auto']
  );
  // The thinker's own filings are briefed already.
  const own = ledger.call('thinker', 'task.add', { title: 'mine', project: 'core', risk: 'low', auto: true });
  assert.equal(own.status, 'approved');
  // The errand lane is the errand runner's and never waits.
  const errand = ledger.call('core', 'task.add', { title: 'errand', lane: 'errand', auto: true });
  assert.notEqual(errand.status, 'proposed');
  assert.equal(
    errorCode(() => ledger.call('owner', 'task.add', { title: 'odd', no_brief: 'yes' })),
    'invalid'
  );
});

// The ledger re-addressed an escalated question to `lead`; on the board it goes to `owner` (the lead's decision on the
// brief's known conflicts), so `lead` below reads and answers it as the holder of `owner`.
test('task.escalate: the addressee hands a question up to the owner; the owner then answers as before', (t) => {
  const { ledger } = makeLedger(t, { clients: WITH_THINKER });
  const task = taskAt(ledger, 'in_progress');
  const q = ledger.call('dispatcher', 'task.ask', { id: task.id, to_whom: 'thinker', text: 'Which file?' }).question;
  assert.equal(q.to_whom, 'thinker');
  assert.equal(
    errorCode(() => ledger.call('dispatcher', 'task.escalate', { question_id: q.id })),
    'forbidden'
  );
  const r = ledger.call('thinker', 'task.escalate', { question_id: q.id, note: 'The owner decides the file.' });
  assert.equal(r.question.to_whom, 'owner');
  assert.equal(r.task.status, 'needs_answer');
  const shown = ledger.call('owner', 'task.show', { id: task.id });
  assert.deepEqual(
    shown.comments.map((c) => [c.author, c.text]),
    [['thinker', 'The owner decides the file.']]
  );
  const event = shown.events.find((e) => e.type === 'question.escalated');
  assert.equal(event?.actor, 'thinker');
  assert.deepEqual(
    ledger
      .call('lead', 'outbox.pull', {})
      .filter((row) => row.kind === 'question')
      .map((row) => payloadOf(row).question),
    [q.id]
  );
  assert.equal(
    errorCode(() => ledger.call('thinker', 'task.escalate', { question_id: q.id })),
    'invalid',
    'already with the owner'
  );
  assert.equal(ledger.call('lead', 'task.answer', { question_id: q.id, text: 'src/a.js' }).task.status, 'in_progress');
  assert.equal(
    errorCode(() => ledger.call('thinker', 'task.escalate', { question_id: q.id })),
    'invalid',
    'answered'
  );
  assert.equal(
    errorCode(() => ledger.call('thinker', 'task.escalate', { question_id: 'Q-nothing' })),
    'not-found'
  );
});

// PR 6d: an agent principal that runs errands (`clients.json` kind `agent`, the board role `errand-runner` alone) sees
// the errands of its own agent and nothing else of the board: not the other agent's errands, not the dev lane.
const RUNNERS: Record<string, ReadonlyArray<string>> = {
  ...LEDGER_ROLES,
  scout: ['errand-runner'],
  server: ['errand-runner'],
};

function runnerBoard(t: { after: (fn: () => void) => void }): {
  ledger: Board;
  mine: string;
  theirs: string;
  dev: string;
} {
  const { ledger } = makeLedger(t, { clients: RUNNERS });
  const mine = ledger.call('core', 'task.add', { title: 'look it up', lane: 'errand', role: 'scout' }).id;
  const theirs = ledger.call('core', 'task.add', { title: 'list the units', lane: 'errand', role: 'server' }).id;
  const dev = ledger.call('lead', 'task.add', { title: 'a dev task', lane: 'dev', project: 'core' }).id;
  return { ledger, mine, theirs, dev };
}

test("an errand runner's task.list holds only the errands of its own agent", (t) => {
  const { ledger, mine } = runnerBoard(t);
  assert.deepEqual(
    ledger.call('scout', 'task.list', {}).map((task) => task.id),
    [mine]
  );
});

test("an errand runner's task.show of another agent's errand or a dev task answers not-found", (t) => {
  const { ledger, mine, theirs, dev } = runnerBoard(t);
  assert.equal(ledger.call('scout', 'task.show', { id: mine }).task.id, mine);
  assert.equal(
    errorCode(() => ledger.call('scout', 'task.show', { id: theirs })),
    'not-found'
  );
  assert.equal(
    errorCode(() => ledger.call('scout', 'task.show', { id: dev })),
    'not-found'
  );
});
