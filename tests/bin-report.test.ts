// The console's `/report [<date>]` (bin/report.ts#reportAnswer): the latest report, or the one of a date, rendered for
// the terminal; one line when there is none. It reads the files itself, so it runs without a core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportAnswer } from '../bin/report.ts';
import { putReport, reportText, watcherDirs } from './fixtures/watcher-rig.ts';

test('/report prints the latest report rendered: headings without hash marks, the body kept', () => {
  const dirs = watcherDirs();
  putReport(dirs, '2026-11-01', reportText({ Memory: 'MARK-OLD' }));
  putReport(dirs, '2026-11-02', reportText({ Memory: '- MARK-NEW **bold**' }));
  const answer = reportAnswer({ reportsDir: dirs.reportsDir, day: undefined, color: false });
  assert.equal(answer.status, 'ok');
  assert.ok(answer.text.includes('MARK-NEW bold'));
  assert.equal(answer.text.includes('MARK-OLD'), false);
  assert.equal(answer.text.includes('## '), false);
  assert.equal(answer.text.includes('**'), false);
});

test('/report <date> prints that day', () => {
  const dirs = watcherDirs();
  putReport(dirs, '2026-11-01', reportText({ Memory: 'MARK-OLD' }));
  putReport(dirs, '2026-11-02', reportText({ Memory: 'MARK-NEW' }));
  const answer = reportAnswer({ reportsDir: dirs.reportsDir, day: '2026-11-01', color: false });
  assert.ok(answer.text.includes('MARK-OLD'));
});

test('/report with no report says so in one line', () => {
  const dirs = watcherDirs();
  const answer = reportAnswer({ reportsDir: dirs.reportsDir, day: undefined, color: false });
  assert.equal(answer.status, 'failed');
  assert.equal(answer.text.trim().includes('\n'), false);
  assert.ok(answer.text.trim().length > 0);
});

test('/report for a date without a report says so in one line and names the date', () => {
  const dirs = watcherDirs();
  putReport(dirs, '2026-11-02', reportText());
  const answer = reportAnswer({ reportsDir: dirs.reportsDir, day: '2026-10-01', color: false });
  assert.equal(answer.status, 'failed');
  assert.equal(answer.text.trim().includes('\n'), false);
  assert.ok(answer.text.includes('2026-10-01'));
});

test('/report with a malformed date is invalid and prints no file', () => {
  const dirs = watcherDirs();
  putReport(dirs, '2026-11-02', reportText({ Memory: 'MARK' }));
  const answer = reportAnswer({ reportsDir: dirs.reportsDir, day: '../prompt', color: false });
  assert.equal(answer.status, 'invalid');
  assert.equal(answer.text.includes('MARK'), false);
});
