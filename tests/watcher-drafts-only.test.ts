// The watcher's `watcher.draftsOnly` setting (src/watcher/settings.ts, src/watcher/inspection.ts, src/watcher/filing.ts):
// while the watcher is being calibrated it files no task and the report lists what it would have filed as drafts. The
// board is a fake that keeps rows; the setting reaches the inspection as `draftsOnly`, a function read when the run
// files, so a change of the config needs no restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readReport } from '../src/watcher/read.ts';
import { watcherSettings } from '../src/watcher/settings.ts';
import { DAY, answerOf, inspectionDeps, inspectionRig, said, sectionOf } from './fixtures/watcher-inspection-rig.ts';

const inspection = () => import('../src/watcher/inspection.ts');
const filing = () => import('../src/watcher/filing.ts');

const DAY_MS = 24 * 60 * 60 * 1000;
const DRAFT = {
  kind: 'fix',
  finding: 'retry-rail',
  title: 'The retry rail loops',
  evidence: 'src/turn/run.ts:212, 14 retries on one turn',
  done: 'One retry per turn; tests/turn-run.test.ts covers it',
};
const SAME_KEY = { ...DRAFT, title: 'The same finding, worded again' };
const answering =
  (...drafts: Array<Record<string, unknown>>) =>
  () =>
    Promise.resolve(said(answerOf({}, drafts)));

test('watcherSettings: draftsOnly is false unless the config says true', () => {
  // Bug: a missing key or the string "false" from a hand edit reads as on, and a calibrated watcher stops filing.
  assert.equal(watcherSettings({}).draftsOnly, false);
  assert.equal(watcherSettings({ watcher: { draftsOnly: 'false' } }).draftsOnly, false);
  assert.equal(watcherSettings({ watcher: { draftsOnly: true } }).draftsOnly, true);
});

test('with draftsOnly true the board gets no task and the receipt is a draft', async () => {
  // Bug: the setting is read but the draft still goes to the board, so the calibration spams real tasks.
  const { runInspection } = await inspection();
  const { readFilings } = await filing();
  const rig = inspectionRig();
  const result = await runInspection(inspectionDeps(rig, { runAgent: answering(DRAFT), draftsOnly: () => true }));
  assert.equal(result.state, 'succeeded', result.code ?? '');
  assert.equal(rig.fake.adds.length, 0);
  assert.equal(rig.fake.rows.length, 0);
  assert.deepEqual(
    readFilings(rig.dir, result.runId).map((one) => [one.state, one.taskId]),
    [['draft', null]]
  );
  assert.equal(result.filing, 'none', 'a draft is no filing, so the run is neither filed nor deferred');
});

test('with draftsOnly true "Tasks filed" lists the draft with its kind, key and title', async () => {
  // Bug: the owner calibrates blind, because the report says nothing of what the watcher would have filed.
  const { runInspection } = await inspection();
  const rig = inspectionRig();
  await runInspection(inspectionDeps(rig, { runAgent: answering(DRAFT), draftsOnly: () => true }));
  const read = readReport(rig.reportsDir, DAY);
  assert.ok(read.ok);
  assert.ok(sectionOf(read.report.text, 'Tasks filed').includes('- draft (fix, retry-rail): The retry rail loops'));
});

test('with draftsOnly true a repeat inside the answer is still a duplicate, one draft stands', async () => {
  // Bug: every draft becomes a draft line before the duplicate check, and the report lists one problem twice.
  const { runInspection } = await inspection();
  const { readFilings } = await filing();
  const rig = inspectionRig();
  const result = await runInspection(
    inspectionDeps(rig, { runAgent: answering(DRAFT, SAME_KEY), draftsOnly: () => true })
  );
  assert.deepEqual(
    readFilings(rig.dir, result.runId).map((one) => one.state),
    ['draft', 'duplicate']
  );
});

test('a draft is settled: a later retry with the board open files nothing', async () => {
  // Bug: the draft is kept as pending, and the first run after the setting is switched off files the old drafts.
  const { runInspection } = await inspection();
  const { retryFilings, hasUnsettledFilings } = await filing();
  const rig = inspectionRig();
  await runInspection(inspectionDeps(rig, { runAgent: answering(DRAFT), draftsOnly: () => true }));
  assert.equal(hasUnsettledFilings(rig.dir), false);
  await retryFilings({ dir: rig.dir, board: rig.fake.board, now: rig.store.now });
  assert.equal(rig.fake.adds.length, 0);
});

test('with draftsOnly false the draft is filed as before', async () => {
  // Bug: the new path changes the behaviour for the default, and the watcher stops filing where nobody asked it to.
  const { runInspection } = await inspection();
  const { readFilings } = await filing();
  const rig = inspectionRig();
  const result = await runInspection(inspectionDeps(rig, { runAgent: answering(DRAFT), draftsOnly: () => false }));
  assert.equal(rig.fake.adds.length, 1);
  assert.equal(readFilings(rig.dir, result.runId)[0]?.state, 'filed');
  assert.equal(result.filing, 'filed');
});

test('the setting is read when the run files: a run after a switch to false files its task', async () => {
  // Bug: the setting is read once at start, and the owner's change waits for a restart.
  const { runInspection } = await inspection();
  let draftsOnly = true;
  const rig = inspectionRig();
  const first = await runInspection(inspectionDeps(rig, { runAgent: answering(DRAFT), draftsOnly: () => draftsOnly }));
  assert.equal(first.filing, 'none');
  assert.equal(rig.fake.adds.length, 0);
  draftsOnly = false;
  rig.clock.t += DAY_MS;
  const other = { ...DRAFT, finding: 'other-rail', evidence: 'src/turn/other.ts:9, one line' };
  const second = await runInspection(inspectionDeps(rig, { runAgent: answering(other), draftsOnly: () => draftsOnly }));
  assert.equal(second.state, 'succeeded', second.code ?? '');
  assert.equal(rig.fake.adds.length, 1, 'only the new draft is filed, the old draft stays a draft');
});
