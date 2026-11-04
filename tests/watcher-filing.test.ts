// What the watcher files (src/watcher/filing.ts, through src/watcher/inspection.ts): drafts and receipts kept by run
// identity before any retry, a board outage that still leaves a report, a lost answer that reconciles without a second
// task, one task per finding however it is worded, and no credential anywhere. The board is a fake that keeps rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readReport } from '../src/watcher/read.ts';
import * as reads from '../src/watcher/read.ts';
import {
  DAY,
  MINUTE,
  SELF,
  allTextUnder,
  answerOf,
  inspectionDeps,
  inspectionRig,
  said,
  sectionOf,
  watcherBoard,
} from './fixtures/watcher-inspection-rig.ts';
import { PLANTED_KEY, taskRow } from './fixtures/watcher-rig.ts';

const lifecycle = () => import('../src/watcher/lifecycle.ts');
const inspection = () => import('../src/watcher/inspection.ts');
const filing = () => import('../src/watcher/filing.ts');

const DRAFT = {
  kind: 'fix',
  finding: 'retry-rail',
  title: 'The retry rail loops',
  evidence: 'src/turn/run.ts:212, 14 retries on one turn',
  done: 'One retry per turn; tests/turn-run.test.ts covers it',
};
const answering =
  (...drafts: Array<Record<string, unknown>>) =>
  () =>
    Promise.resolve(said(answerOf({}, drafts)));

test('validated drafts are on disk under the run identity before the board is asked', async () => {
  // Bug: a crash at the first filing loses the drafts, and the findings of that run are gone.
  const { runInspection } = await inspection();
  const { readFilings } = await filing();
  const rig = inspectionRig();
  const before: Array<string> = [];
  await runInspection(
    inspectionDeps(rig, {
      runAgent: answering(DRAFT),
      onPhase: (phase, runId) => {
        if (phase !== 'filing') return;
        assert.equal(rig.fake.adds.length, 0);
        before.push(...readFilings(rig.dir, runId).map((one) => one.finding));
      },
    })
  );
  assert.deepEqual(before, ['retry-rail']);
});

test('a filed draft has a receipt with the task id, and the report lists that id', async () => {
  // Bug: the id reaches the report but no receipt, so a retry cannot know the task exists.
  const { runInspection } = await inspection();
  const { readFilings } = await filing();
  const rig = inspectionRig();
  const result = await runInspection(inspectionDeps(rig, { runAgent: answering(DRAFT) }));
  const [receipt] = readFilings(rig.dir, result.runId);
  assert.equal(receipt?.state, 'filed');
  assert.equal(receipt?.taskId, rig.fake.rows[0]?.id);
  assert.equal(result.filing, 'filed');
  const read = readReport(rig.reportsDir, DAY);
  assert.ok(read.ok && sectionOf(read.report.text, 'Tasks filed').includes(String(receipt?.taskId)));
});

test('an unreachable board still gives a report, with the filing marked deferred', async () => {
  // Bug: the worker opens the board first (bin/neptunia.ts), so a stopped core leaves no diagnosis, the day it matters most.
  const { runInspection } = await inspection();
  const { readFilings } = await filing();
  const rig = inspectionRig();
  const result = await runInspection(
    inspectionDeps(rig, {
      runAgent: answering(DRAFT),
      openBoard: () => Promise.reject(new Error('the board is not reachable')),
    })
  );
  assert.equal(result.state, 'succeeded');
  assert.equal(result.filing, 'deferred');
  assert.equal(readFilings(rig.dir, result.runId)[0]?.state, 'deferred');
  const read = readReport(rig.reportsDir, DAY);
  assert.ok(read.ok && /deferred/i.test(sectionOf(read.report.text, 'Tasks filed')));
  assert.ok(read.ok && sectionOf(read.report.text, 'Tasks filed').includes(DRAFT.title));
});

test('an answer with no drafts never opens the board', async () => {
  // Bug: a board outage marks a run with nothing to file as deferred, and the owner chases nothing.
  const { runInspection } = await inspection();
  const rig = inspectionRig();
  let opened = 0;
  const result = await runInspection(
    inspectionDeps(rig, {
      openBoard: () => {
        opened += 1;
        return Promise.reject(new Error('down'));
      },
    })
  );
  assert.equal(opened, 0);
  assert.equal(result.filing, 'none');
});

test('a board refusal still gives a report, with the filing marked failed', async () => {
  // Bug: a refusal reads as an outage and is retried for ever, or it throws away the report.
  const { runInspection } = await inspection();
  const { readFilings } = await filing();
  const rig = inspectionRig(undefined, watcherBoard({ refuse: () => true }));
  const result = await runInspection(inspectionDeps(rig, { runAgent: answering(DRAFT) }));
  assert.equal(result.state, 'succeeded');
  assert.equal(result.filing, 'failed');
  assert.equal(readFilings(rig.dir, result.runId)[0]?.state, 'failed');
  const read = readReport(rig.reportsDir, DAY);
  assert.ok(read.ok && /failed/i.test(sectionOf(read.report.text, 'Tasks filed')));
});

test('the next inspection files a deferred draft once, and the old report stays as it was', async () => {
  // Bug: a deferred draft waits for an owner who never runs a retry, or each later run files it again.
  const { runInspection } = await inspection();
  const { readFilings } = await filing();
  let down = true;
  const rig = inspectionRig(undefined, watcherBoard({ down: () => down }));
  const first = await runInspection(inspectionDeps(rig, { runAgent: answering(DRAFT) }));
  const kept = reads.readReportRun(rig.reportsDir, first.runId);
  down = false;
  rig.clock.t += MINUTE;
  await runInspection(inspectionDeps(rig));
  rig.clock.t += MINUTE;
  await runInspection(inspectionDeps(rig));
  assert.equal(rig.fake.rows.length, 1);
  assert.equal(readFilings(rig.dir, first.runId)[0]?.state, 'filed');
  assert.deepEqual(reads.readReportRun(rig.reportsDir, first.runId), kept);
});

test('an answer lost after the board accepted reconciles to one task with its id in the receipt', async () => {
  // Bug: the retry cannot tell "accepted, answer lost" from "never reached", and files the task twice.
  const { runInspection } = await inspection();
  const { readFilings, retryFilings } = await filing();
  let lose = true;
  const rig = inspectionRig(
    undefined,
    watcherBoard({
      onAdd: () => {
        if (!lose) return;
        lose = false;
        throw new Error('socket closed');
      },
    })
  );
  const result = await runInspection(inspectionDeps(rig, { runAgent: answering(DRAFT) }));
  assert.notEqual(readFilings(rig.dir, result.runId)[0]?.state, 'filed');
  await retryFilings({ dir: rig.dir, board: rig.fake.board, now: rig.store.now });
  assert.equal(rig.fake.rows.length, 1);
  assert.equal(readFilings(rig.dir, result.runId)[0]?.taskId, rig.fake.rows[0]?.id);
});

test('reconciling works past the board idempotency window too', async () => {
  // Bug: the retry leans on the 24-hour key alone, so a machine down for a weekend files the task twice.
  const { runInspection } = await inspection();
  const { readFilings, retryFilings } = await filing();
  let lose = true;
  const rig = inspectionRig(
    undefined,
    watcherBoard({
      forgetKeys: true,
      onAdd: () => {
        if (!lose) return;
        lose = false;
        throw new Error('socket closed');
      },
    })
  );
  const result = await runInspection(inspectionDeps(rig, { runAgent: answering(DRAFT) }));
  rig.clock.t += 3 * 24 * 60 * MINUTE;
  await retryFilings({ dir: rig.dir, board: rig.fake.board, now: rig.store.now });
  assert.equal(rig.fake.rows.length, 1);
  assert.equal(readFilings(rig.dir, result.runId)[0]?.taskId, rig.fake.rows[0]?.id);
});

test('a crash between acceptance and receipt reconciles after the claim is recovered', async () => {
  // Bug: the receipt of a dead process stays pending and the next process files the accepted task again.
  const { runInspection } = await inspection();
  const { currentRun } = await lifecycle();
  const { readFilings, retryFilings } = await filing();
  let hold: (() => void) | undefined;
  let reached: (() => void) | undefined;
  const accepted = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const rig = inspectionRig(
    undefined,
    watcherBoard({
      onAdd: () =>
        new Promise<void>((_resolve, reject) => {
          hold = () => reject(new Error('the process is gone'));
          reached?.();
        }),
    })
  );
  const running = runInspection(inspectionDeps(rig, { runAgent: answering(DRAFT) }));
  await accepted;
  rig.alive.delete(SELF.pid);
  assert.equal(currentRun(rig.store), null, 'the claim of the dead process is recovered');
  await retryFilings({ dir: rig.dir, board: rig.fake.board, now: rig.store.now });
  assert.equal(rig.fake.rows.length, 1);
  assert.equal(readFilings(rig.dir, 'run-1')[0]?.taskId, rig.fake.rows[0]?.id);
  hold?.();
  await running;
  assert.equal(rig.fake.rows.length, 1);
});

test('a reworded repeat of a finding files nothing new, in the same run or a later one', async () => {
  // Bug: duplicates are found by comparing evidence text, so a model that rephrases files the same bug every day.
  const { runInspection } = await inspection();
  const { readFilings } = await filing();
  const rig = inspectionRig();
  const reworded = { ...DRAFT, title: 'Retries spin on one turn', evidence: 'run.ts line 212 retried 15 times' };
  await runInspection(inspectionDeps(rig, { runAgent: answering(DRAFT, reworded) }));
  assert.equal(rig.fake.rows.length, 1);
  rig.clock.t += MINUTE;
  const later = await runInspection(inspectionDeps(rig, { runAgent: answering(reworded) }));
  assert.equal(rig.fake.rows.length, 1);
  assert.equal(readFilings(rig.dir, later.runId)[0]?.state, 'duplicate');
  assert.equal(readFilings(rig.dir, later.runId)[0]?.taskId, rig.fake.rows[0]?.id);
});

test('a finding with a new key files a new task, even with the same words as an old one', async () => {
  // Bug: dedupe by title swallows a second bug that happens to be described the same way.
  const { runInspection } = await inspection();
  const rig = inspectionRig();
  await runInspection(inspectionDeps(rig, { runAgent: answering(DRAFT, { ...DRAFT, finding: 'another-rail' }) }));
  assert.equal(rig.fake.rows.length, 2);
});

test('a draft with no finding key falls back to its evidence', async () => {
  // Bug: an older answer without the key files a duplicate on every run.
  const { runInspection } = await inspection();
  const rig = inspectionRig();
  const { finding: _dropped, ...plain } = DRAFT;
  await runInspection(inspectionDeps(rig, { runAgent: answering(plain) }));
  rig.clock.t += MINUTE;
  await runInspection(inspectionDeps(rig, { runAgent: answering({ ...plain, title: 'Another title' }) }));
  assert.equal(rig.fake.rows.length, 1);
});

test('prompt.md asks for the finding key the filing compares', () => {
  // Bug: the engine dedupes on a key the prompt never asks for, so every live draft falls back to its evidence wording.
  const prompt = fs.readFileSync(new URL('../agents/watcher/prompt.md', import.meta.url), 'utf8');
  assert.ok(prompt.includes('`finding`'));
});

test('a repeat of an open task from before finding keys files nothing, by its evidence', async () => {
  // Bug: the update forgets tasks the watcher filed earlier, and the first run after it files them all again.
  const { runInspection } = await inspection();
  const old = taskRow({
    id: 'T-old',
    status: 'proposed',
    metadata: { kind: 'fix', evidence: DRAFT.evidence },
  });
  const rig = inspectionRig(undefined, watcherBoard({ rows: [old] }));
  const { finding: _dropped, ...plain } = DRAFT;
  await runInspection(inspectionDeps(rig, { runAgent: answering(plain) }));
  assert.equal(rig.fake.rows.length, 1);
});

test('watcher tasks carry their origin and run, and a persona task never blocks one', async () => {
  // Bug: a watcher diagnostic reads as her own proposal, or her task with the same finding silences the watcher.
  const { runInspection } = await inspection();
  const persona = taskRow({
    id: 'T-persona',
    requester: 'persona',
    status: 'proposed',
    metadata: { origin: 'persona', finding: DRAFT.finding, evidence: DRAFT.evidence },
  });
  const rig = inspectionRig(undefined, watcherBoard({ rows: [persona] }));
  const result = await runInspection(inspectionDeps(rig, { runAgent: answering(DRAFT) }));
  const row = rig.fake.rows.at(-1);
  assert.equal(rig.fake.rows.length, 2);
  assert.equal(row?.requester, 'watcher');
  assert.equal(row?.metadata?.origin, 'watcher');
  assert.equal(row?.metadata?.runId, result.runId);
  assert.equal(row?.metadata?.finding, DRAFT.finding);
});

for (const [where, text] of [
  ['the report', answerOf({ 'The server': `journal line: ${PLANTED_KEY}` }, [DRAFT])],
  ['a task draft', answerOf({}, [{ ...DRAFT, evidence: `found ${PLANTED_KEY} in a file` }])],
] as const) {
  test(`a synthetic credential in ${where} fails the run and is copied nowhere`, async () => {
    // Bug: drafts are persisted before the check, so the key sits in a receipt even though the report was refused.
    const { runInspection } = await inspection();
    const { readRun } = await lifecycle();
    const rig = inspectionRig();
    const result = await runInspection(inspectionDeps(rig, { runAgent: () => Promise.resolve(said(text)) }));
    assert.equal(result.state, 'failed');
    assert.equal(result.code, 'secret');
    assert.equal(rig.fake.adds.length, 0);
    assert.equal(reads.reportDays(rig.reportsDir).length, 0);
    assert.equal(allTextUnder(rig.dir).includes(PLANTED_KEY), false);
    assert.equal(JSON.stringify([result, readRun(rig.store, result.runId)]).includes(PLANTED_KEY), false);
  });
}

test('the output of a failed agent is kept nowhere, so a key in it stays out', async () => {
  // Bug: a run that ended badly saves its text "for diagnosis", and that text holds what the check would have refused.
  const { runInspection } = await inspection();
  const rig = inspectionRig();
  await runInspection(
    inspectionDeps(rig, { runAgent: () => Promise.resolve({ ok: false, text: `boom ${PLANTED_KEY}`, exitCode: 2 }) })
  );
  assert.equal(allTextUnder(rig.dir).includes(PLANTED_KEY), false);
});
