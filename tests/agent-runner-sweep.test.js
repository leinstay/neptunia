// Tests for src/agent-runner/sweep.js: the runner deletes task directories under its out dir
// whose newest entry is older than errands.keepFilesHours, never a live task's, never a name that
// is not a task id; a nested fresh file keeps its directory; a missing out dir is an empty
// sweep; the sweeper logs one line of counts per sweep, never a name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sweepOutputs, startSweeper, keepHoursOf, DEFAULT_KEEP_FILES_HOURS } from '../src/agent-runner/sweep.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { tempDir } from './fixtures/tmp.js';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-10-17T12:00:00Z');

function tempOut() {
  return tempDir('agent-sweep-');
}

/** A task directory `id` under `out` with one file, everything dated `hoursAgo` before NOW. */
function taskDir(out, id, hoursAgo, { nested = null } = {}) {
  const dir = path.join(out, id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'meme.png');
  fs.writeFileSync(file, 'x');
  const at = new Date(NOW - hoursAgo * HOUR);
  fs.utimesSync(file, at, at);
  if (nested !== null) {
    fs.mkdirSync(path.join(dir, 'sub'));
    const inner = path.join(dir, 'sub', 'late.txt');
    fs.writeFileSync(inner, 'y');
    const innerAt = new Date(NOW - nested * HOUR);
    fs.utimesSync(inner, innerAt, innerAt);
    fs.utimesSync(path.join(dir, 'sub'), at, at);
  }
  fs.utimesSync(dir, at, at);
  return dir;
}

test('sweep: old task directories go, fresh, live and foreign ones stay', async () => {
  const out = tempOut();
  taskDir(out, 'told', 30);
  taskDir(out, 'tfresh', 2);
  taskDir(out, 'tlive', 30);
  taskDir(out, 'tnested', 30, { nested: 1 });
  taskDir(out, 'not.a.task', 30);
  fs.writeFileSync(path.join(out, 'stray-file'), 'z');
  const counts = await sweepOutputs({ outDir: out, keepHours: 24, liveIds: () => ['tlive'], now: () => NOW });
  assert.deepEqual(counts, { removed: 1, kept: 2, live: 1, failed: 0 });
  assert.deepEqual(fs.readdirSync(out).sort(), ['not.a.task', 'stray-file', 'tfresh', 'tlive', 'tnested']);
});

test('sweep: the hours are errands.keepFilesHours; a bad value falls back to 24', async () => {
  assert.equal(DEFAULT_KEEP_FILES_HOURS, 24);
  for (const bad of [undefined, null, 0, -3, 'x', Number.NaN]) assert.equal(keepHoursOf(bad), 24);
  assert.equal(keepHoursOf(1.5), 1.5);
  const out = tempOut();
  taskDir(out, 'tthree', 3);
  assert.equal((await sweepOutputs({ outDir: out, keepHours: 4, now: () => NOW })).removed, 0);
  assert.equal((await sweepOutputs({ outDir: out, keepHours: 'x', now: () => NOW })).removed, 0);
  assert.equal((await sweepOutputs({ outDir: out, keepHours: 2, now: () => NOW })).removed, 1);
  assert.deepEqual(fs.readdirSync(out), []);
});

test('sweep: a missing out dir is an empty sweep', async () => {
  const counts = await sweepOutputs({ outDir: path.join(tempOut(), 'nope'), keepHours: 24, now: () => NOW });
  assert.deepEqual(counts, { removed: 0, kept: 0, live: 0, failed: 0 });
});

test('sweeper: sweeps at start with the live hours, one log line of counts, no names', async () => {
  const out = tempOut();
  taskDir(out, 'tsecretname', 30);
  taskDir(out, 'tbusy', 30);
  let hours = 24;
  const { logs } = await withCapturedLogs(async () => {
    const sweeper = startSweeper({
      profile: 'web',
      outDir: out,
      keepHours: () => hours,
      liveIds: () => ['tbusy'],
      now: () => NOW,
    });
    const first = await sweeper.sweep();
    assert.deepEqual(first, { removed: 1, kept: 0, live: 1, failed: 0 });
    hours = 48;
    await sweeper.sweep();
    sweeper.stop();
    assert.equal(await sweeper.sweep(), null, 'nothing after stop');
  });
  const swept = logs.filter((entry) => entry.msg === 'agent-runner: swept');
  assert.equal(swept.length, 2, 'one line per sweep (the start one joined by the first explicit call)');
  assert.equal(swept[0].removed, 1);
  assert.equal(swept[0].hours, 24);
  assert.equal(swept[1].hours, 48);
  for (const entry of swept)
    assert.ok(
      !JSON.stringify(entry).includes('tsecretname') && !JSON.stringify(entry).includes('tbusy'),
      'no task name in a log line'
    );
  assert.deepEqual(fs.readdirSync(out), ['tbusy']);
});
