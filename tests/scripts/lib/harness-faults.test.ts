// The fault edge of the harness (scripts/lib/harness-faults.ts): one record per scenario of a fault run with its effect
// keys, the order of an ordered scenario, what repeated and what never came, and the gaps file, with no time the run measured.

import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFaultRecords } from '../../../scripts/lib/harness-faults.ts';
import type { Report } from '../../../scripts/lib/fault-run.ts';
import { tempDir } from '../../fixtures/tmp.ts';

const REPORT: Report = {
  ok: false,
  ms: 41_234,
  rows: [
    {
      scenario: 'live core, round 1',
      effects: 1,
      keys: [['send:c1:said r1-one', 1]],
      repeats: [],
      missing: [],
      order: null,
    },
    {
      scenario: 'week hour-errand',
      effects: 1,
      keys: [['wake:hour-errand:w1', 2]],
      repeats: [['wake:hour-errand:w1', 2]],
      missing: ['errand:hour-errand:t1'],
      order: ['wake:hour-errand:w1', 'wake:hour-errand:w1'],
    },
  ],
};

test('writes one record per scenario in run order, named by its place and scenario, with its order and no measured time', () => {
  const out = tempDir('harness-faults');
  try {
    writeFaultRecords(out, REPORT, ['a split send: the fake replaces a whole send']);
    const dir = path.join(out, 'faults');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['01-live-core-round-1.json', '02-week-hour-errand.json', 'gaps.txt']);
    const second = JSON.parse(fs.readFileSync(path.join(dir, '02-week-hour-errand.json'), 'utf8')) as unknown;
    assert.deepEqual(second, {
      scenario: 'week hour-errand',
      keys: [['wake:hour-errand:w1', 2]],
      repeats: [['wake:hour-errand:w1', 2]],
      missing: ['errand:hour-errand:t1'],
      order: ['wake:hour-errand:w1', 'wake:hour-errand:w1'],
    });
    const first = JSON.parse(fs.readFileSync(path.join(dir, '01-live-core-round-1.json'), 'utf8')) as object;
    assert.equal('order' in first, false, 'a scenario with no order writes none');
    assert.equal(fs.readFileSync(path.join(dir, 'gaps.txt'), 'utf8'), 'a split send: the fake replaces a whole send\n');
    assert.doesNotMatch(fs.readFileSync(path.join(dir, '01-live-core-round-1.json'), 'utf8'), /41234|41\.2/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
