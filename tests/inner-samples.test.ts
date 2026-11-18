// Tests for scripts/lib/inner-samples.ts: the samples of an `--inner` batch run one after another, a stop before a
// sample ends the batch, and an abort keeps the samples that finished.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSamples } from '../scripts/lib/inner-samples.ts';

test('runs every sample in order when nothing stops or aborts the batch', async () => {
  const run = await runSamples({
    count: 3,
    signal: new AbortController().signal,
    stop: () => null,
    runOne: (n) => Promise.resolve(`δείγμα-${n}`),
  });
  assert.deepEqual(run, { samples: ['δείγμα-0', 'δείγμα-1', 'δείγμα-2'], stopped: null, cut: null });
});

test('ends the batch before a sample its stop names, keeping the samples before it', async () => {
  const run = await runSamples({
    count: 3,
    signal: new AbortController().signal,
    stop: (n) => (n === 2 ? 'spend' : null),
    runOne: (n) => Promise.resolve(n),
  });
  assert.deepEqual(run, { samples: [0, 1], stopped: 'spend', cut: null });
});

test('keeps the finished samples and counts them when the batch is aborted inside a running sample', async () => {
  const controller = new AbortController();
  const run = await runSamples({
    count: 3,
    signal: controller.signal,
    stop: () => null,
    runOne: (n) => {
      if (n < 2) return Promise.resolve(n);
      // The third sample runs long: the abort comes while it is still out, and it never settles.
      controller.abort();
      return new Promise<number>(() => {});
    },
  });
  assert.deepEqual(run, { samples: [0, 1], stopped: null, cut: { asked: 3, finished: 2 } });
});

test('starts no sample when the batch is aborted before the first', async () => {
  const controller = new AbortController();
  controller.abort();
  let started = 0;
  const run = await runSamples({
    count: 2,
    signal: controller.signal,
    stop: () => null,
    runOne: (n) => {
      started += 1;
      return Promise.resolve(n);
    },
  });
  assert.equal(started, 0);
  assert.deepEqual(run.cut, { asked: 2, finished: 0 });
});
