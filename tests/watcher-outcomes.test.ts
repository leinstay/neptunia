// What a request led to, on its row: a memory session links to its `session_runs` row in the writer's transaction, a turn's
// result to its last request, an agent's session to its board task. The migration adds the columns to a live database with
// its rows intact. Rows go through the single writer into a temp database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { archivedLlm, currentRequestMeta, turnOutcome, turnService, withRequestMeta } from '../src/llm/archive.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { sessionRequestId } from '../src/memory/db/request-archive.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { noteArchiveGap, readArchiveGaps, readRecordedRuns, taskOutcomes } from '../src/watcher/requests.ts';
import { tempDir } from './fixtures/tmp.ts';

const MIDNIGHT = Date.parse('2026-11-04T00:00:00Z');
const MINUTE = 60_000;
const WINDOW = { from: MIDNIGHT, to: MIDNIGHT + 60 * MINUTE, maxChars: 1_000_000 };
const SILENT = { warn() {} };

const fresh = () => openMemoryDb(path.join(tempDir('nep-outcomes-'), 'memory.db'));
type Handle = ReturnType<typeof fresh>;

function requestRow(handle: Handle, id: string): void {
  applyMemoryWrite(handle, {
    kind: 'request-archive',
    op: 'start',
    record: { id, at: MIDNIGHT + MINUTE, system_text: 's', messages: '[]' },
  });
  applyMemoryWrite(handle, { kind: 'request-archive', op: 'finish', id, at: MIDNIGHT + 2 * MINUTE, status: 'ok' });
}

function sessionWrite(handle: Handle, runId: string, outcome: string, mode = 'apply'): void {
  applyMemoryWrite(handle, {
    kind: 'session',
    mode,
    run: {
      id: runId,
      scopeKey: 'scope',
      startedAt: new Date(MIDNIGHT).toISOString(),
      finishedAt: new Date(MIDNIGHT + MINUTE).toISOString(),
      outcome,
    },
    plan: outcome === 'ok' ? {} : null,
    now: MIDNIGHT + 3 * MINUTE,
  });
}

const outcomeOf = (handle: Handle) =>
  readRecordedRuns(dbOf(handle), WINDOW).runs.flatMap((run) => run.requests)[0]?.outcome;

for (const [name, outcome, mode, state] of [
  ['an applied session', 'ok', 'apply', 'confirmed'],
  ['a session that gave a bad answer', 'bad_answer', 'apply', 'failed'],
  ['a shadow session', 'ok', 'shadow', 'shadow'],
] as const) {
  test(`${name} marks its request ${state}, naming the run`, () => {
    // Bug: `status: ok` passes for the work being done, while the session's write says otherwise.
    const handle = fresh();
    requestRow(handle, sessionRequestId('run:1'));
    sessionWrite(handle, 'run:1', outcome, mode);
    assert.deepEqual(outcomeOf(handle), { kind: 'memory-write', state, ref: 'run:1' });
    handle.close();
  });
}

test('the session names its row through the option, and the client below never sees it', async () => {
  // Bug: the row gets a fresh id and the link misses it, or the option reaches the provider's request.
  const handle = fresh();
  const seen: Array<Record<string, unknown>> = [];
  const llm = archivedLlm(
    {
      complete: (_messages: unknown, options: Record<string, unknown>) => {
        seen.push(options);
        return Promise.resolve({ text: 'ok' });
      },
    },
    {
      write: (update) => Promise.resolve(applyMemoryWrite(handle, update)),
      now: () => MIDNIGHT + MINUTE,
      log: SILENT,
    }
  );
  await llm.complete([], { archiveId: sessionRequestId('run:2'), role: 'memory' });
  assert.equal(Object.hasOwn(seen[0] ?? {}, 'archiveId'), false);
  sessionWrite(handle, 'run:2', 'ok');
  const [request] = readRecordedRuns(dbOf(handle), WINDOW).runs.flatMap((run) => run.requests);
  assert.equal(request?.outcome.state, 'confirmed');
  assert.equal(request?.service, 'memory');
  handle.close();
});

test('the outcome of a turn lands on its last request and not on the steps before it', async () => {
  // Bug: every step of a tool loop reads as delivered, or the note hits the wrong row once a second request starts.
  const handle = fresh();
  let n = 0;
  const llm = archivedLlm(
    { complete: (...call: [unknown, unknown?]) => Promise.resolve({ text: 'ok', asked: call.length }) },
    {
      write: (update) => Promise.resolve(applyMemoryWrite(handle, update)),
      now: () => MIDNIGHT + MINUTE,
      newId: () => `req-${(n += 1)}`,
      log: SILENT,
    }
  );
  await withRequestMeta(async () => {
    Object.assign(currentRequestMeta() ?? {}, { turnId: 't1', attemptId: 'a1', step: 0 });
    await llm.complete([], {});
    await llm.complete([], {});
    await currentRequestMeta()?.noteOutcome?.({ kind: 'delivery', state: 'confirmed', ref: 't1' });
  });
  const requests = readRecordedRuns(dbOf(handle), WINDOW).runs.flatMap((run) => run.requests);
  assert.deepEqual(
    requests.map((one) => one.outcome.state),
    ['unlinked', 'confirmed']
  );
  handle.close();
});

for (const [name, result, expected] of [
  ['a skip', { outcome: 'skip' }, { kind: 'skip', state: 'confirmed', ref: null }],
  ['a delivered turn', { outcome: 'spoke', delivered: true }, { kind: 'delivery', state: 'confirmed', ref: 't' }],
  ['a turn whose send failed', { outcome: 'spoke', delivered: false }, { kind: 'delivery', state: 'failed', ref: 't' }],
  ['an errored turn', { outcome: 'error' }, { kind: 'delivery', state: 'failed', ref: 't' }],
  ['a dry turn, with no receipt', { outcome: 'spoke' }, null],
  ['a dropped turn', { outcome: 'dropped' }, null],
  ['a turn that threw', undefined, null],
] as const) {
  test(`${name} gives the outcome the receipt proves`, () => {
    // Bug: a turn with no receipt reads as delivered, the claim standing in for the proof.
    assert.deepEqual(turnOutcome(result, 't'), expected);
  });
}

for (const [mode, kind, service] of [
  ['reply', undefined, 'core'],
  ['selfreflection', undefined, 'selfreflection'],
  ['inner', 'heartbeat', 'heartbeat'],
  ['inner', 'selfimprovement', 'selfimprovement'],
  ['inner', 'attend', 'core'],
] as const) {
  test(`a ${mode} turn with the wake ${String(kind)} belongs to ${service}`, () => {
    // Bug: every row says core, and a heartbeat cannot be told from a reply in the review.
    assert.equal(turnService(mode, kind), service);
  });
}

test('a board task gives the outcome of the session that worked it, and an id on no task gives none', () => {
  // Bug: the agent's "done" stands for the task's state, or a failed task reads as confirmed.
  const handle = fresh();
  const db = dbOf(handle);
  const insert = db.prepare(
    "INSERT INTO board_tasks (id, title, requester, status, created_at, updated_at) VALUES (?, 't', 'x', ?, '', '')"
  );
  insert.run('T-1', 'done');
  insert.run('T-2', 'failed');
  insert.run('T-3', 'in_progress');
  assert.deepEqual(taskOutcomes(db, 'T-1'), { kind: 'task', state: 'confirmed', ref: 'T-1' });
  assert.equal(taskOutcomes(db, 'T-2')?.state, 'failed');
  assert.equal(taskOutcomes(db, 'T-3')?.state, 'open');
  assert.equal(taskOutcomes(db, 'run-1'), null);
  handle.close();
});

test('a lost archive write is kept on file for the read, with ids and no content, and a dead disk never throws', () => {
  // Bug: the gap lives in the core's memory, or noting it throws into her turn.
  const privateDir = tempDir('nep-outcomes-');
  noteArchiveGap(privateDir, { kind: 'archive-write-failed', requestId: 'lost', op: 'start', at: 5 });
  assert.deepEqual(readArchiveGaps(privateDir), [
    { kind: 'archive-write-failed', requestId: 'lost', op: 'start', at: 5 },
  ]);
  assert.doesNotThrow(() => {
    noteArchiveGap('/proc/no-such-place', { kind: 'archive-write-failed', requestId: 'x', op: 'start', at: 5 });
  });
});
