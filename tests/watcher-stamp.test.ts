// The coverage block's `observation` and `backend` are the engine's, like the metadata rows they repeat, so the saved report
// cannot say two things about one run. The agent's other fields stay as it wrote them. Synthetic answers; the clock is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readReport } from '../src/watcher/read.ts';
import { checkCoverage, checkTemplate } from '../src/watcher/report.ts';
import {
  DAY,
  coverageBlock,
  inspectionDeps,
  inspectionRig,
  said,
  templateOf,
} from './fixtures/watcher-inspection-rig.ts';

test('the saved block carries the stamped interval and backend, whatever the agent wrote, and keeps its own lists', async () => {
  // Bug: the metadata says one window and backend and the block another, and calibration reads whichever it parsed first.
  const { runInspection } = await import('../src/watcher/inspection.ts');
  const rig = inspectionRig();
  const claimed = templateOf({
    end: coverageBlock({
      observation: { from: '2020-01-01T00:00:00.000Z', to: '2020-01-02T00:00:00.000Z' },
      backend: 'invented-backend',
      inspected: ['MARK-KEPT'],
    }),
  });
  const result = await runInspection(
    inspectionDeps(rig, {
      selected: { backend: 'claude', model: 'm', effort: 'e' },
      runAgent: () => Promise.resolve(said(claimed)),
    })
  );
  assert.equal(result.state, 'succeeded');
  const read = readReport(rig.reportsDir, DAY);
  assert.ok(read.ok);
  const template = checkTemplate(read.report.text);
  const coverage = checkCoverage(read.report.text);
  assert.ok(template.ok && coverage.ok);
  assert.equal(coverage.coverage.backend, 'claude');
  const { from, to } = coverage.coverage.observation;
  assert.equal(`${from} to ${to}`, template.metadata.observationInterval);
  assert.deepEqual(coverage.coverage.inspected, ['MARK-KEPT']);
});

test('an unknown backend is stamped in the block as in the metadata, and the report still passes', async () => {
  // Bug: the block's check refuses a blank backend, so a run with no selected backend fails after its own stamp.
  const { runInspection } = await import('../src/watcher/inspection.ts');
  const rig = inspectionRig();
  const result = await runInspection(inspectionDeps(rig, { selected: { backend: null, model: null, effort: null } }));
  assert.equal(result.state, 'succeeded', result.code ?? '');
  const read = readReport(rig.reportsDir, DAY);
  assert.ok(read.ok);
  const coverage = checkCoverage(read.report.text);
  assert.ok(coverage.ok);
  assert.equal(coverage.coverage.backend, 'unknown');
});
