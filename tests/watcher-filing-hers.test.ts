// A draft on the issue of her open task, through the filing an inspection runs (src/watcher/filing.ts): one issue runs once
// and each task keeps its origin. The board is a fake that keeps rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFilings, retryFilings, saveDrafts } from '../src/watcher/filing.ts';
import { inspectionRig, watcherBoard } from './fixtures/watcher-inspection-rig.ts';
import { taskRow } from './fixtures/watcher-rig.ts';

const EVIDENCE = 'web.read timed out in t1, t2 and t3.';
const DRAFT = { kind: 'fix', title: 'Timeouts', evidence: EVIDENCE, done: 'none' } as const;
const hers = (status: 'proposed' | 'cancelled') =>
  taskRow({ id: 'T-hers', requester: 'persona:self', status, description: EVIDENCE, metadata: null });

test('her open task on the same evidence files no draft, and the receipt names her task', async () => {
  // Bug: the inspection dedupes against the watcher's rows only, so both tasks reach an executor.
  const rig = inspectionRig(undefined, watcherBoard({ rows: [hers('proposed')] }));
  saveDrafts(rig.dir, 'run-1', rig.store.now(), [{ ...DRAFT, evidence: `  ${EVIDENCE.toUpperCase()} ` }]);
  await retryFilings({ dir: rig.dir, board: rig.fake.board, now: rig.store.now });
  assert.equal(rig.fake.adds.length, 0);
  const [receipt] = readFilings(rig.dir, 'run-1');
  assert.equal(receipt?.state, 'duplicate');
  assert.equal(receipt?.taskId, 'T-hers');
});

test('her closed task on the same evidence covers nothing', async () => {
  // Bug: a problem she gave up on can never be reported again.
  const rig = inspectionRig(undefined, watcherBoard({ rows: [hers('cancelled')] }));
  saveDrafts(rig.dir, 'run-1', rig.store.now(), [DRAFT]);
  await retryFilings({ dir: rig.dir, board: rig.fake.board, now: rig.store.now });
  assert.equal(rig.fake.adds.length, 1);
  assert.equal(readFilings(rig.dir, 'run-1')[0]?.state, 'filed');
});

test('her open task on other evidence covers nothing', async () => {
  // Bug: any open task of hers silences the watcher.
  const rig = inspectionRig(undefined, watcherBoard({ rows: [hers('proposed')] }));
  saveDrafts(rig.dir, 'run-1', rig.store.now(), [{ ...DRAFT, evidence: 'A separate issue in t9.' }]);
  await retryFilings({ dir: rig.dir, board: rig.fake.board, now: rig.store.now });
  assert.equal(rig.fake.adds.length, 1);
});
