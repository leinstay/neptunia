// How src/watcher/filing.ts and src/watcher/inspection.ts treat the board itself: a call that never answers ends in a
// deferred filing within a bound, and which earlier tasks of the watcher's stop a draft from being filed again. The board
// is a fake that keeps rows, and the clock is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardRefusal } from '../src/board/machine.ts';
import type { BoardCaller } from '../src/tools/impl/board.ts';
import { readReport } from '../src/watcher/read.ts';
import {
  DAY,
  MINUTE,
  answerOf,
  inspectionDeps,
  inspectionRig,
  said,
  sectionOf,
  watcherBoard,
} from './fixtures/watcher-inspection-rig.ts';
import { taskRow } from './fixtures/watcher-rig.ts';

const inspection = () => import('../src/watcher/inspection.ts');
const lifecycle = () => import('../src/watcher/lifecycle.ts');
const filing = () => import('../src/watcher/filing.ts');

const DRAFT = { kind: 'fix', finding: 'rail', title: 'Retry rail', evidence: 'src/a.ts:1', done: 'It holds' };
const OTHER = { kind: 'chore', finding: 'key', title: 'Unread key', evidence: 'config/b.json:2', done: 'It is gone' };
const PLAIN = { kind: DRAFT.kind, title: DRAFT.title, evidence: DRAFT.evidence, done: DRAFT.done };

const never = (): Promise<never> => new Promise(() => {});
const answering =
  (...drafts: Array<Record<string, unknown>>) =>
  () =>
    Promise.resolve(said(answerOf({}, drafts)));

// ---- a board that does not answer -------------------------------------------------------------------------------

test('a task.add that never answers defers the filing within the bound and the report is committed', async () => {
  // Bug: a hung socket holds the worker until the unit's timeout kills it, and the finished diagnosis is lost.
  const { runInspection } = await inspection();
  const { readFilings } = await filing();
  const rig = inspectionRig(undefined, watcherBoard({ onAdd: never }));
  const result = await runInspection(inspectionDeps(rig, { runAgent: answering(DRAFT), boardTimeoutMs: 20 }));
  assert.equal(result.state, 'succeeded');
  assert.equal(result.filing, 'deferred');
  assert.equal(readFilings(rig.dir, result.runId)[0]?.state, 'deferred');
  const read = readReport(rig.reportsDir, DAY);
  assert.ok(read.ok && /deferred/i.test(sectionOf(read.report.text, 'Tasks filed')));
});

test('a task.list that never answers defers the filing within the bound', async () => {
  // Bug: only the add is bounded, and the list that comes first hangs the same way.
  const { runInspection } = await inspection();
  const board: BoardCaller = { call: never };
  const rig = inspectionRig(undefined, { board, rows: [], adds: [] });
  const result = await runInspection(inspectionDeps(rig, { runAgent: answering(DRAFT), boardTimeoutMs: 20 }));
  assert.equal(result.state, 'succeeded');
  assert.equal(result.filing, 'deferred');
});

test('a connection that never opens defers the filing within the bound', async () => {
  // Bug: the bound wraps the calls, and the hang sits in opening the socket before any call.
  const { runInspection } = await inspection();
  const rig = inspectionRig();
  const result = await runInspection(
    inspectionDeps(rig, { runAgent: answering(DRAFT), openBoard: never, boardTimeoutMs: 20 })
  );
  assert.equal(result.state, 'succeeded');
  assert.equal(result.filing, 'deferred');
});

test('after a call that never answers, the other drafts wait for the next inspection without a call each', async () => {
  // Bug: every draft waits out its own timeout on a dead link, so the bound multiplies by the size of the batch.
  const { runInspection } = await inspection();
  const { readFilings } = await filing();
  const rig = inspectionRig(undefined, watcherBoard({ onAdd: never }));
  const result = await runInspection(inspectionDeps(rig, { runAgent: answering(DRAFT, OTHER), boardTimeoutMs: 20 }));
  assert.equal(rig.fake.adds.length, 1);
  assert.deepEqual(
    readFilings(rig.dir, result.runId).map((one) => one.state),
    ['deferred', 'deferred']
  );
});

test('a task the board accepted behind a call that timed out becomes one task at the next inspection', async () => {
  // Bug: the deferred draft is added again, because the timeout reads as "never reached".
  const { runInspection } = await inspection();
  const { readFilings } = await filing();
  let hang = true;
  const rig = inspectionRig(undefined, watcherBoard({ onAdd: () => (hang ? never() : undefined), forgetKeys: true }));
  const first = await runInspection(inspectionDeps(rig, { runAgent: answering(DRAFT), boardTimeoutMs: 20 }));
  hang = false;
  rig.clock.t += MINUTE;
  await runInspection(inspectionDeps(rig, { boardTimeoutMs: 20 }));
  assert.equal(rig.fake.rows.length, 1);
  assert.equal(readFilings(rig.dir, first.runId)[0]?.taskId, rig.fake.rows[0]?.id);
});

test('a cancel reaches a run that waits on a board call, long before the bound', async () => {
  // Bug: the bound is the only way out of the call, so a cancel the owner saw accepted waits it out.
  const { runInspection } = await inspection();
  const { requestCancel } = await lifecycle();
  const rig = inspectionRig(
    undefined,
    watcherBoard({
      onAdd: () => {
        requestCancel(rig.store);
        return never();
      },
    })
  );
  const started = Date.now();
  const result = await runInspection(inspectionDeps(rig, { runAgent: answering(DRAFT), boardTimeoutMs: 60_000 }));
  assert.equal(result.state, 'cancelled');
  assert.ok(Date.now() - started < 5_000);
});

test('a refusal over the socket is a failed filing and a closed link a deferred one', async () => {
  // Bug: the socket's caller throws its refusals as plain errors, so live refusals read as an outage and retry for ever.
  const { runInspection } = await inspection();
  const { readFilings } = await filing();
  for (const [thrown, state] of [
    [new BoardRefusal('failed: the board refused'), 'failed'],
    [new Error('unavailable: the link to the core closed'), 'deferred'],
  ] as const) {
    const board: BoardCaller = {
      call: (_principal, op) => (op === 'task.list' ? ([] as never) : Promise.reject(thrown)),
    };
    const rig = inspectionRig(undefined, { board, rows: [], adds: [] });
    const result = await runInspection(inspectionDeps(rig, { runAgent: answering(DRAFT) }));
    assert.equal(readFilings(rig.dir, result.runId)[0]?.state, state);
  }
});

// ---- what stops a draft from being filed again -------------------------------------------------------------------

/** One inspection answering `drafts` over a board holding `rows`, at the rig's clock of 2026-11-04. */
async function filedOver(rows: Parameters<typeof watcherBoard>[0], ...drafts: Array<Record<string, unknown>>) {
  const { runInspection } = await inspection();
  const rig = inspectionRig(undefined, watcherBoard(rows));
  await runInspection(inspectionDeps(rig, { runAgent: answering(...drafts) }));
  return rig.fake;
}

test('a draft is filed as the watcher, in the dev lane, with its evidence, done-criterion and kind', async () => {
  // Bug: the board gets a title alone, and whoever picks the task up has nothing to verify it by.
  const fake = await filedOver({}, DRAFT);
  const row = fake.rows[0];
  assert.equal(row?.requester, 'watcher');
  assert.equal(fake.adds[0]?.lane, 'dev');
  assert.equal(row?.acceptance, DRAFT.done);
  assert.equal(row?.description, DRAFT.evidence);
  assert.equal(row?.metadata?.kind, DRAFT.kind);
});

test('a closed task from yesterday still stops the same evidence', async () => {
  // Bug: a task closed this morning is filed again tonight, before anyone can have seen whether the fix held.
  const closed = taskRow({
    id: 'T-closed',
    status: 'done',
    created_at: '2026-11-03T00:03:00.000Z',
    metadata: { kind: 'fix', evidence: PLAIN.evidence },
  });
  assert.equal((await filedOver({ rows: [closed] }, PLAIN)).adds.length, 0);
});

test('a closed task from five days ago does not stop it: the problem came back, so it is filed again', async () => {
  // Bug: a problem that returns after its fix stays silent for ever, because its old task still matches.
  const closed = taskRow({
    id: 'T-closed',
    status: 'done',
    created_at: '2026-10-30T00:03:00.000Z',
    metadata: { kind: 'fix', evidence: PLAIN.evidence },
  });
  assert.equal((await filedOver({ rows: [closed] }, PLAIN)).adds.length, 1);
});

test('the same evidence is matched through case and spacing', async () => {
  // Bug: a draft with no key slips past by one capital letter or a doubled space, and files the bug again.
  const open = taskRow({
    id: 'T-open',
    status: 'proposed',
    metadata: { kind: 'fix', evidence: '  SRC/A.TS:1   FOURTEEN RETRIES ' },
  });
  const draft = { ...PLAIN, evidence: 'src/a.ts:1 fourteen retries' };
  assert.equal((await filedOver({ rows: [open] }, draft)).adds.length, 0);
});

test('other evidence is filed beside a recent task of the watcher', async () => {
  // Bug: any recent task of the watcher's stops the next draft, whatever it is about.
  const recent = taskRow({
    id: 'T-recent',
    status: 'proposed',
    metadata: { kind: 'fix', evidence: 'something else' },
  });
  assert.equal((await filedOver({ rows: [recent] }, PLAIN)).adds.length, 1);
});

test('the same evidence twice in one answer with no key is filed once', async () => {
  // Bug: the comparison looks only at the board, and two drafts of one answer both pass it.
  assert.equal((await filedOver({}, PLAIN, { ...PLAIN, title: 'Same thing again' })).adds.length, 1);
});

// ---- what the report says under "Tasks filed" ---------------------------------------------------------------------

/** The "Tasks filed" section of the report an inspection answering `body` and `drafts` committed, and the rows. */
async function tasksFiled(body: string, ...drafts: Array<Record<string, unknown>>) {
  const { runInspection } = await inspection();
  const rig = inspectionRig();
  const bodies = { 'Tasks filed': body };
  const result = await runInspection(
    inspectionDeps(rig, { runAgent: () => Promise.resolve(said(answerOf(bodies, drafts))) })
  );
  assert.equal(result.state, 'succeeded');
  const read = readReport(rig.reportsDir, DAY);
  return { section: read.ok ? sectionOf(read.report.text, 'Tasks filed') : '', rows: rig.fake.rows };
}

test('one line per filed task comes before the agent text, with the id, the kind and the key', async () => {
  // Bug: the agent's claim reads as the record, or a later report has no key to repeat for the same problem.
  const { section, rows } = await tasksFiled('AGENT-LINE', DRAFT, OTHER);
  for (const [row, draft] of [
    [rows[0], DRAFT],
    [rows[1], OTHER],
  ] as const) {
    const line = section.split('\n').find((one) => one.includes(draft.title)) ?? '';
    assert.ok(line.includes(String(row?.id)), line);
    assert.ok(line.includes(draft.kind), line);
    assert.ok(line.includes(draft.finding), line);
    assert.ok(section.indexOf(draft.title) < section.indexOf('AGENT-LINE'));
  }
});

test('a section that said only nothing found gives that up once a task is filed', async () => {
  // Bug: the report says "nothing found" right beside the task it filed.
  const { section } = await tasksFiled('nothing found', DRAFT);
  assert.ok(section.includes(DRAFT.title));
  assert.equal(/nothing found/i.test(section), false);
});

test('with nothing to file the section stays as the agent wrote it', async () => {
  // Bug: an empty batch still rewrites the section and drops its one line, and the report fails its own check.
  const { section } = await tasksFiled('AGENT-LINE');
  assert.equal(section.trim(), 'AGENT-LINE');
});
