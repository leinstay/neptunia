// What the development run hands back to the persona over the task board, and what wakes the worker. A question, a
// proposal or a block goes to `persona:self` whoever filed the task, reaches her wake's facts, and she answers through
// her tools; a board write ends the worker's wait through the core's `task.wait` command, with no polling timer. A real
// board over a memory database, her tools as the operations run them. Each test names the bug it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildSelfimprovementFacts, proposalsOf } from '../src/behavior/selfimprovement-view.ts';
import { openBoard } from '../src/board/board.ts';
import type { BoardOp, BoardResults, BoardSettings, Row } from '../src/board/board.ts';
import type { BoardDb } from '../src/board/schema.ts';
import { CORE_BUILTINS, applyBoardWrite, createBoardPort } from '../src/board/writer.ts';
import type { BoardPort } from '../src/board/writer.ts';
import type { BoardCaller } from '../src/tools/operations/board.ts';
import { freshMemoryDb } from './fixtures/memory-db-copy.ts';
import { FIX_REQUEST, herCalls } from './fixtures/selfimprovement-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const T0 = Date.parse('2026-11-04T10:00:00Z');
const SELF = 'persona:self';
const WORKER = 'development';
const SETTINGS: BoardSettings = {
  leaseTtlMinutes: 30,
  autoTriage: { role: 'dev', budget: 4, steps: 80, estimate: 30 },
  projects: {},
};

function privateDirWithClients(): string {
  const dir = tempDir('nep-development-return-');
  fs.writeFileSync(
    path.join(dir, 'clients.json'),
    JSON.stringify({
      boss: { kind: 'agent', tokenFile: 'clients/boss.token', permissions: [], boardRoles: ['owner'] },
      watcher: { kind: 'agent', tokenFile: 'clients/watcher.token', permissions: [], boardRoles: ['watcher'] },
    })
  );
  return dir;
}

function rig(t: { after: (fn: () => void) => void }) {
  const handle = freshMemoryDb();
  t.after(() => handle.close());
  const board = openBoard({
    // open.ts types the connection as `object`; it is node:sqlite's DatabaseSync, which has every method BoardDb names.
    db: handle.db as BoardDb,
    privateDir: privateDirWithClients(),
    now: () => T0,
    settings: () => SETTINGS,
    builtins: CORE_BUILTINS,
  });
  const caller: BoardCaller = {
    call<TOp extends BoardOp>(
      principal: string,
      op: TOp,
      args?: Readonly<Record<string, unknown>>,
      idempotency?: string | null
    ): BoardResults[TOp] {
      return board.call(principal, op, args, idempotency);
    },
  };
  /** A task of `requester`'s, triaged, approved and claimed by the worker; its id and the lease's generation. */
  function held(requester: 'persona' | 'watcher'): { id: string; generation: number } {
    const added =
      requester === 'persona'
        ? board.call('persona', 'task.add', {
            lane: 'dev',
            title: FIX_REQUEST.title,
            description: FIX_REQUEST.evidence,
            requester: SELF,
            subscriber: SELF,
          })
        : board.call('watcher', 'task.add', { lane: 'dev', title: 'A finding', description: 'evidence' });
    board.call('boss', 'task.transition', {
      id: added.id,
      status: 'triaged',
      revision: added.revision,
      set: { role: 'dev', estimate: 30, budget: 4 },
    });
    board.call('boss', 'task.approve', { id: added.id, scope: 'plan' });
    const claimed = board.call(WORKER, 'task.claim', { id: added.id });
    return { id: added.id, generation: claimed.lease_generation };
  }
  const herOutbox = (): Array<Row> => board.call('persona', 'outbox.pull', { to_whom: SELF });
  return { board, caller, held, herOutbox, her: herCalls(caller) };
}

function facts(entries: Awaited<ReturnType<typeof proposalsOf>>) {
  return buildSelfimprovementFacts({
    now: T0,
    since: null,
    journal: null,
    granted: [],
    skills: [],
    proposals: entries.entries,
    outbox: entries.outbox,
    landed: [],
  });
}

test('the worker is a builtin principal of the core that reviews and works and owns nothing', () => {
  // Catches: the worker needs an owner token, so a bug in it could approve a deploy or take the owner's rights.
  assert.deepEqual([...(CORE_BUILTINS.development ?? [])].sort(), ['reviewer', 'worker']);
});

test('a blocked task writes a row to her outbox with the reason, when she filed it', (t) => {
  // Catches: blocked is outside the board's NOTIFY list, so the block waits unseen and nobody acts on it.
  const { board, held, herOutbox } = rig(t);
  const { id, generation } = held('persona');
  board.call(WORKER, 'task.block', { id, generation, reason: 'No push right.', unblocks: 'A fork.' });
  const row = herOutbox().find((one) => one.task_id === id && one.kind === 'blocked');
  assert.equal((row?.payload as { reason?: string } | undefined)?.reason, 'No push right.');
});

test('a block of a watcher task goes to persona:self too, whoever subscribed', (t) => {
  // Catches: the row goes to the watcher's own name, which no wake ever reads.
  const { board, held, herOutbox } = rig(t);
  const { id, generation } = held('watcher');
  board.call(WORKER, 'task.block', { id, generation, reason: 'No push right.', unblocks: 'A fork.' });
  assert.deepEqual(
    herOutbox()
      .filter((one) => one.task_id === id)
      .map((one) => one.kind),
    ['blocked']
  );
});

test('a question addressed to persona:self reaches her outbox on a task the watcher filed', (t) => {
  // Catches: `needs_answer` notifies the subscriber alone, so the addressee never hears of the question.
  const { board, held, herOutbox } = rig(t);
  const { id, generation } = held('watcher');
  board.call(WORKER, 'task.ask', { id, generation, text: 'Is this worth doing?', to_whom: SELF });
  assert.deepEqual(
    herOutbox()
      .filter((one) => one.task_id === id)
      .map((one) => one.kind),
    ['needs_answer']
  );
});

test('her wake shows the question addressed to her on a task she did not file, with its id to answer', async (t) => {
  // Catches: her view lists only her own requests, so she can never answer a question about a watcher's task.
  const { board, caller, held } = rig(t);
  const { id, generation } = held('watcher');
  const { question } = board.call(WORKER, 'task.ask', { id, generation, text: 'Is this worth doing?', to_whom: SELF });
  const view = await facts(await proposalsOf(caller));
  assert.deepEqual(view.news.questions, [
    { taskId: id, questionId: question.id, text: 'Is this worth doing?', answered: false },
  ]);
});

test('her wake shows why a task is blocked', async (t) => {
  // Catches: she sees `blocked` with nothing to act on.
  const { board, caller, held } = rig(t);
  const { id, generation } = held('persona');
  board.call(WORKER, 'task.block', { id, generation, reason: 'No push right.', unblocks: 'A fork.' });
  const view = await facts(await proposalsOf(caller));
  assert.equal(view.news.outbox.find((row) => row.taskId === id)?.blockedReason, 'No push right.');
});

test('task.answer answers her question and resumes the task under its asker', async (t) => {
  // Catches: she has the wake but no tool to answer in it.
  const { board, held, her } = rig(t);
  const { id, generation } = held('persona');
  const { question } = board.call(WORKER, 'task.ask', { id, generation, text: 'Which timeout?', to_whom: SELF });
  const answer = await her('task.answer', { question_id: question.id, text: 'Fifteen seconds.' });
  assert.equal(answer.status, 'ok', answer.summary ?? '');
  const { task, questions } = board.call('boss', 'task.show', { id });
  assert.equal(task.status, 'in_progress');
  assert.equal(task.lease_owner, WORKER);
  assert.equal(questions[0]?.answered_by, 'persona');
});

test('task.answer refuses a question addressed to someone else', async (t) => {
  // Catches: a tool that lets her answer for the owner.
  const { board, held, her } = rig(t);
  const { id, generation } = held('persona');
  const { question } = board.call(WORKER, 'task.ask', { id, generation, text: 'A deploy?', to_whom: 'owner' });
  const answer = await her('task.answer', { question_id: question.id, text: 'Yes.' });
  assert.equal(answer.status, 'denied');
  assert.equal(board.call('boss', 'task.show', { id }).task.status, 'needs_answer');
});

test('task.unblock returns a blocked task she filed to approved, and refuses one she did not', async (t) => {
  // Catches: a block only the owner can lift, against the owner's scheme; or her lifting the watcher's.
  const { board, held, her } = rig(t);
  const mine = held('persona');
  const other = held('watcher');
  for (const { id, generation } of [mine, other]) {
    board.call(WORKER, 'task.block', { id, generation, reason: 'Stuck.', unblocks: 'A decision.' });
  }
  assert.equal((await her('task.unblock', { id: mine.id, note: 'Use the first way.' })).status, 'ok');
  assert.equal(board.call('boss', 'task.show', { id: mine.id }).task.status, 'approved');
  assert.equal((await her('task.unblock', { id: other.id, note: 'Use the first way.' })).status, 'denied');
  assert.equal(board.call('boss', 'task.show', { id: other.id }).task.status, 'blocked');
});

test('task.cancel cancels her own task with the reason and refuses one she did not file', async (t) => {
  // Catches: a proposal she declines keeps running; or her stopping the owner's work.
  const { board, held, her } = rig(t);
  const mine = held('persona');
  const other = held('watcher');
  assert.equal((await her('task.cancel', { id: mine.id, reason: 'Not this way.' })).status, 'ok');
  const { task } = board.call('boss', 'task.show', { id: mine.id });
  assert.deepEqual([task.status, task.close_reason], ['cancelled', 'Not this way.']);
  assert.equal((await her('task.cancel', { id: other.id, reason: 'Not this way.' })).status, 'denied');
});

test('she still never approves, reviews or merges through the board', (t) => {
  // Catches: the new way back widens her rights past answering.
  const { board, held } = rig(t);
  const { id, generation } = held('persona');
  board.call(WORKER, 'task.submit', {
    id,
    generation,
    handoff: { result: 'done', evidence: [], artifacts: [], tests: [], open_issues: [] },
  });
  assert.throws(() => board.call('persona', 'task.review', { id, decision: 'accept' }), /forbidden|filed|may not/);
  assert.throws(() => board.call('persona', 'task.approve', { id, scope: 'merge' }), /may not/);
});

// ---------- task.wait: what wakes the worker ----------

function portRig(t: { after: (fn: () => void) => void }): BoardPort {
  const handle = freshMemoryDb();
  t.after(() => handle.close());
  const privateDir = privateDirWithClients();
  return createBoardPort({
    write: (write) => Promise.resolve(applyBoardWrite(handle, { kind: 'board', write })),
    context: () => ({ at: T0, settings: SETTINGS, privateDir }),
    briefWaitMs: () => 0,
  });
}

/** Whether a promise settled within a few ticks. */
async function settledSoon(promise: Promise<unknown>): Promise<boolean> {
  const late = Symbol('late');
  const first = await Promise.race([promise, new Promise((resolve) => setTimeout(resolve, 20, late))]);
  return first !== late;
}

test('task.wait answers at once with the events after `from`', async (t) => {
  // Catches: an event between the worker's pass and its next wait is lost, and the task sits until the next event.
  const port = portRig(t);
  await port.call('boss', 'task.add', { lane: 'dev', title: 'Filed before the wait' });
  const answer = await port.command(WORKER, 'task.wait', { from: 0, wait_ms: 2000 });
  assert.equal(answer.status, 'ok');
  assert.ok((answer.data as Array<{ seq: number }>).length > 0);
});

test('task.wait holds until a board write and answers with its events', async (t) => {
  // Catches: the worker needs a polling timer because nothing tells it of a filed task.
  const port = portRig(t);
  const first = await port.call('boss', 'task.add', { lane: 'dev', title: 'Before' });
  const seen = (await port.command(WORKER, 'task.events', { from: 0 })).data as Array<{ seq: number }>;
  const from = seen.at(-1)?.seq ?? 0;
  const waiting = port.command(WORKER, 'task.wait', { from, wait_ms: 2000 });
  assert.equal(await settledSoon(waiting), false);
  await port.call('boss', 'task.comment', { id: first.id, text: 'Something happened.' });
  const answer = await waiting;
  assert.equal(answer.status, 'ok');
  assert.ok((answer.data as Array<{ task_id: string }>).every((row) => row.task_id === first.id));
});

test('a read of the board does not end a wait, so the worker cannot wake itself in a loop', async (t) => {
  // Catches: each `task.list` of a wake ends the next wait, which is a busy loop with extra steps.
  const port = portRig(t);
  await port.call('boss', 'task.add', { lane: 'dev', title: 'Before' });
  const seen = (await port.command(WORKER, 'task.events', { from: 0 })).data as Array<{ seq: number }>;
  const from = seen.at(-1)?.seq ?? 0;
  const waiting = port.command(WORKER, 'task.wait', { from, wait_ms: 40 });
  await port.call(WORKER, 'task.list', { lane: 'dev', ready: true });
  await port.command(WORKER, 'task.events', { from });
  assert.equal(await settledSoon(waiting), false);
  assert.deepEqual((await waiting).data, []);
});

test('a reap that returned a task ends the wait: a lapsed lease wakes the worker', async (t) => {
  // Catches: a crashed worker's task sits approved until something unrelated writes to the board.
  const handle = freshMemoryDb();
  t.after(() => handle.close());
  const privateDir = privateDirWithClients();
  let at = T0;
  const port = createBoardPort({
    write: (write) => Promise.resolve(applyBoardWrite(handle, { kind: 'board', write })),
    context: () => ({ at, settings: SETTINGS, privateDir }),
    briefWaitMs: () => 0,
  });
  const added = await port.call('boss', 'task.add', { lane: 'dev', title: 'Held', role: 'dev', estimate_minutes: 30 });
  await port.call('boss', 'task.transition', { id: added.id, status: 'triaged', revision: added.revision });
  await port.call('boss', 'task.approve', { id: added.id, scope: 'plan' });
  await port.call(WORKER, 'task.claim', { id: added.id });
  const seen = (await port.command(WORKER, 'task.events', { from: 0 })).data as Array<{ seq: number }>;
  const waiting = port.command(WORKER, 'task.wait', { from: seen.at(-1)?.seq ?? 0, wait_ms: 2000 });
  at += 31 * 60_000;
  assert.deepEqual(await port.reap(), [added.id]);
  const answer = await waiting;
  assert.ok((answer.data as Array<{ type: string }>).some((row) => row.type === 'lease.expired'));
});

test('task.wait is refused to a principal with no board role', async (t) => {
  // Catches: any socket client can hold a wait open on the board.
  const port = portRig(t);
  assert.equal((await port.command('stranger', 'task.wait', { from: 0, wait_ms: 10 })).status, 'forbidden');
});
