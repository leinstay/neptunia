// Reading the reports (src/watcher/read.ts): the latest report, or the one of a day, from `<reportsDir>/<day>.md`.
// Shared by her tool `watcher.read` and the console's `/report`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createReportReader, readReport, reportsDirOf } from '../src/watcher/read.ts';
import { putReport, reportText, watcherDirs } from './fixtures/watcher-rig.ts';

test('with no day it reads the report with the latest date, whatever order the files were written in', () => {
  const dirs = watcherDirs();
  putReport(dirs, '2026-11-03', 'THREE');
  putReport(dirs, '2026-10-30', 'OLD');
  putReport(dirs, '2026-11-02', 'TWO');
  const read = readReport(dirs.reportsDir);
  assert.deepEqual(read.ok && { day: read.report.day, text: read.report.text }, { day: '2026-11-03', text: 'THREE' });
});

test("with a day it reads that day's report", () => {
  const dirs = watcherDirs();
  putReport(dirs, '2026-11-03', 'THREE');
  putReport(dirs, '2026-11-02', 'TWO');
  const read = readReport(dirs.reportsDir, '2026-11-02');
  assert.equal(read.ok && read.report.text, 'TWO');
});

test('no report at all, and a day without one, are not-found', () => {
  const dirs = watcherDirs();
  assert.deepEqual(readReport(dirs.reportsDir), { ok: false, code: 'not-found' });
  putReport(dirs, '2026-11-03', reportText());
  assert.deepEqual(readReport(dirs.reportsDir, '2026-11-01'), { ok: false, code: 'not-found' });
});

test('a reports folder that does not exist yet is not-found, not a crash', () => {
  const dirs = watcherDirs();
  assert.deepEqual(readReport(path.join(dirs.watcherDir, 'never-made'), undefined), { ok: false, code: 'not-found' });
});

test('a failed marker or a stray file is no report, so the latest is the last good one', () => {
  const dirs = watcherDirs();
  putReport(dirs, '2026-11-01', 'GOOD');
  fs.writeFileSync(path.join(dirs.reportsDir, '2026-11-02.failed'), 'secret');
  fs.writeFileSync(path.join(dirs.reportsDir, 'zzz.md'), 'STRAY');
  const read = readReport(dirs.reportsDir);
  assert.equal(read.ok && read.report.text, 'GOOD');
});

test('a day that is not YYYY-MM-DD is invalid-day, so a path cannot be read through it', () => {
  const dirs = watcherDirs();
  fs.writeFileSync(path.join(dirs.watcherDir, 'prompt.md'), 'PROMPT');
  for (const day of ['../prompt', '2026-11-2', 'latest', '2026-13-45', '']) {
    assert.deepEqual(readReport(dirs.reportsDir, day), { ok: false, code: 'invalid-day' }, day);
  }
});

test('createReportReader binds a folder: read() is the latest and read(day) is that day', () => {
  const dirs = watcherDirs();
  putReport(dirs, '2026-11-01', 'ONE');
  putReport(dirs, '2026-11-02', 'TWO');
  const reader = createReportReader(dirs.reportsDir);
  const latest = reader.read();
  const one = reader.read('2026-11-01');
  assert.equal(latest.ok && latest.report.text, 'TWO');
  assert.equal(one.ok && one.report.text, 'ONE');
});

test('the reports folder is agents/watcher/reports under the selected persona data directory', () => {
  assert.equal(reportsDirOf('/srv/x'), path.join('/srv/x', 'agents', 'watcher', 'reports'));
});
