// The measurement script of S12.1 (scripts/graph-retrieval-bench.ts), run as a process at its smallest size: it builds a
// synthetic graph in a temporary database, reads it in both modes with and without a concurrent ingest, and prints the
// numbers and the query plans. The numbers themselves are not asserted, only that each mode and each column is there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { percentile } from '../scripts/graph-retrieval-bench.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../scripts/graph-retrieval-bench.ts', import.meta.url));

const bench = (args: Array<string>) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 120_000,
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
  });

test('a run at the smallest size prints both modes with and without ingest, the percentiles and the query plans', () => {
  // Bug: a mode is skipped or fails inside its child process and the report still looks whole.
  const run = bench(['--sizes', '60', '--shapes', 'uniform', '--queries', '4']);
  assert.equal(run.status, 0, run.stderr);
  const rows = run.stdout.split('\n').filter((line) => /^ {2}(source-only|graph-enabled) /.test(line));
  assert.deepEqual(
    rows.map((line) => line.trim().split(/\s+/).slice(0, 2).join(' ')),
    ['source-only off', 'graph-enabled off', 'source-only on', 'graph-enabled on']
  );
  assert.match(run.stdout, /p50ms +p95ms +rssMB\(base\) +walMB +partial +overDeadline +found\/q +write p50\/p95 ms/);
  assert.match(run.stdout, /plans of source-only: \d+ statements/);
  assert.match(run.stdout, /plans of graph-enabled: \d+ statements/);
  assert.match(run.stdout, /size=60 shape=uniform build=[\d.]+s db=[\d.]+MB sources=60 /);
});

test('an unknown shape is a usage error that names the argument and builds nothing', () => {
  // Bug: a typo in --shapes falls back to a default and the owner reads numbers of another graph.
  const run = bench(['--shapes', 'ring']);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--shapes/);
  assert.equal(run.stdout, '');
});

test('the 95th percentile is the nearest rank, so twenty values give the nineteenth', () => {
  // Bug: an off-by-one reports the maximum as p95 of a small sample.
  const values = Array.from({ length: 20 }, (_, index) => index + 1);
  assert.equal(percentile(values, 0.95), 19);
  assert.equal(percentile(values, 0.5), 10);
  assert.equal(percentile([], 0.5), 0);
});
