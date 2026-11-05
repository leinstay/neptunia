// The watcher's report (src/watcher/report.ts): exactly the twelve headings in order, each with a line, no key or
// token anywhere, and a report committed only when the text passes. A refused text leaves no file.
// Changed: `writeReport` had no caller left, so its cases now hold `commitReport`, which every report goes through. The lines
// under "Tasks filed" are asserted through an inspection in tests/watcher-filing-board.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readReport, readReportRun } from '../src/watcher/read.ts';
import { REPORT_HEADINGS, checkReport, commitReport } from '../src/watcher/report.ts';
import { HEADINGS, PLANTED_KEY, putReport, reportText, watcherDirs } from './fixtures/watcher-rig.ts';

const codeOf = (text: string): string | null => {
  const checked = checkReport(text);
  return checked.ok ? null : checked.code;
};

test('the report headings are the twelve of the design, in order', () => {
  assert.deepEqual([...REPORT_HEADINGS], [...HEADINGS]);
});

test('a report with the twelve headings, each saying nothing found, is accepted: a quiet day is a good day', () => {
  assert.equal(checkReport(reportText()).ok, true);
});

test('a report with a heading missing is refused, because a silent section would look like a checked one', () => {
  const text = reportText().replace('## The server\n\nnothing found\n\n', '');
  assert.equal(codeOf(text), 'missing-heading');
});

test('a report with an extra heading is refused, whatever its level', () => {
  assert.equal(codeOf(reportText() + '\n## Summary\n\nall good\n'), 'extra-heading');
  assert.equal(codeOf(reportText() + '\n### Notes\n\nmore\n'), 'extra-heading');
});

test('a heading repeated is refused as an extra one', () => {
  assert.equal(codeOf(reportText() + '\n## Memory\n\nnothing found\n'), 'extra-heading');
});

test('headings out of order are refused', () => {
  const lines = HEADINGS.map((heading) => `## ${heading}\n\nnothing found\n`);
  [lines[1], lines[2]] = [lines[2] ?? '', lines[1] ?? ''];
  assert.equal(codeOf(lines.join('\n')), 'heading-order');
});

test('a heading with no line under it is refused: the agent says nothing found or something', () => {
  const text = reportText().replace('## Memory\n\nnothing found\n', '## Memory\n');
  assert.equal(codeOf(text), 'empty-section');
});

test('text before the first heading is refused, so a chatty opener never reaches the file', () => {
  assert.equal(codeOf('Here is the report.\n\n' + reportText()), 'preamble');
});

test('a heading-looking line inside a code fence is not a heading', () => {
  const text = reportText({ 'Project': 'The prose check printed:\n\n```\n## Summary\n```' });
  assert.equal(checkReport(text).ok, true);
});

test('a key shaped like an OpenRouter key anywhere in the report refuses it', () => {
  assert.equal(codeOf(reportText({ 'The server': `the log line held ${PLANTED_KEY}` })), 'secret');
});

test('a GitHub token, an AWS key id and a bearer header are refused too', () => {
  const github = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');
  const aws = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
  const bearer = 'Authorization: Bearer ' + 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (const leak of [github, aws, bearer]) {
    assert.equal(codeOf(reportText({ 'The server': leak })), 'secret', leak.slice(0, 6));
  }
});

test('ordinary hyphenated words and the bare prefix of a key are not taken for a secret', () => {
  const text = reportText({
    'Project': 'task-runner-sweep drifted; the key prefix sk-or-v1- is logged by name only.',
  });
  assert.equal(checkReport(text).ok, true);
});

const COMMIT = { day: '2026-11-02', runId: 'run-1', at: 1_000 };
const versionsIn = (reportsDir: string): Array<string> =>
  fs.existsSync(path.join(reportsDir, 'runs')) ? fs.readdirSync(path.join(reportsDir, 'runs')) : [];

test('commitReport makes the reports folder when it is missing, and the day reads the text', () => {
  // Bug: the first inspection of a fresh install has a checked answer and nowhere to put it.
  const reportsDir = path.join(watcherDirs().watcherDir, 'fresh', 'reports');
  const committed = commitReport({ ...COMMIT, reportsDir, text: reportText() });
  assert.equal(committed.ok, true);
  assert.equal(fs.readFileSync(path.join(reportsDir, '2026-11-02.md'), 'utf8'), reportText());
});

test('commitReport of a refused text writes no file and does not echo the key in its detail', () => {
  // Bug: the check runs after the write, or its refusal quotes the line it refused.
  const { reportsDir } = watcherDirs();
  const committed = commitReport({ ...COMMIT, reportsDir, text: reportText({ Memory: PLANTED_KEY }) });
  assert.equal(committed.ok, false);
  assert.equal(fs.existsSync(path.join(reportsDir, '2026-11-02.md')), false);
  assert.deepEqual(versionsIn(reportsDir), []);
  assert.equal(JSON.stringify(committed).includes(PLANTED_KEY), false);
});

test('commitReport refuses a day that is no date, so no file is named outside the folder', () => {
  // Bug: the day goes into the view's path unchecked.
  const dirs = watcherDirs();
  const committed = commitReport({ ...COMMIT, reportsDir: dirs.reportsDir, day: '../../escape', text: reportText() });
  assert.equal(committed.ok, false);
  assert.equal(fs.existsSync(path.join(dirs.watcherDir, '..', 'escape.md')), false);
});

test('commitReport over a plain day file from before versions keeps that report under a run of its own', () => {
  // Bug: the first inspection after the update replaces the day's older report, the one thing it may compare with.
  const dirs = watcherDirs();
  putReport(dirs, '2026-11-02', 'OLD-REPORT\n');
  commitReport({ ...COMMIT, reportsDir: dirs.reportsDir, text: reportText() });
  const kept = readReportRun(dirs.reportsDir, 'legacy-2026-11-02');
  assert.equal(kept.ok && kept.report.text, 'OLD-REPORT\n');
  const day = readReport(dirs.reportsDir, '2026-11-02');
  assert.equal(day.ok && day.report.runId, 'run-1');
});
