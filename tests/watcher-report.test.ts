// The watcher's report (src/watcher/report.ts): exactly the seven headings in order, each with a line, no key or
// token anywhere, and the file `<day>.md` written only when the text passes. A refused text leaves no file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPORT_HEADINGS, checkReport, insertFiled, writeReport } from '../src/watcher/report.ts';
import { HEADINGS, PLANTED_KEY, reportText, watcherDirs } from './fixtures/watcher-rig.ts';

const codeOf = (text: string): string | null => {
  const checked = checkReport(text);
  return checked.ok ? null : checked.code;
};

test('the report headings are the seven of the design, in order', () => {
  assert.deepEqual([...REPORT_HEADINGS], [...HEADINGS]);
});

test('a report with the seven headings, each saying nothing found, is accepted: a quiet day is a good day', () => {
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
  const text = reportText({ 'The project': 'The prose check printed:\n\n```\n## Summary\n```' });
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
    'The project': 'task-runner-sweep drifted; the key prefix sk-or-v1- is logged by name only.',
  });
  assert.equal(checkReport(text).ok, true);
});

test('writeReport writes <day>.md with the text and creates the reports folder when it is missing', () => {
  const dirs = watcherDirs();
  const reportsDir = path.join(dirs.watcherDir, 'fresh', 'reports');
  const written = writeReport(reportsDir, '2026-11-02', reportText());
  assert.equal(written.ok, true);
  assert.equal(fs.readFileSync(path.join(reportsDir, '2026-11-02.md'), 'utf8'), reportText());
});

test('writeReport of a refused text writes no file and does not echo the key in its detail', () => {
  const dirs = watcherDirs();
  const written = writeReport(dirs.reportsDir, '2026-11-02', reportText({ Memory: PLANTED_KEY }));
  assert.equal(written.ok, false);
  assert.equal(fs.existsSync(path.join(dirs.reportsDir, '2026-11-02.md')), false);
  assert.equal(JSON.stringify(written).includes(PLANTED_KEY), false);
});

test('writeReport refuses a day that is no date, so the agent cannot name a file outside the folder', () => {
  const dirs = watcherDirs();
  const written = writeReport(dirs.reportsDir, '../../escape', reportText());
  assert.equal(written.ok, false);
  assert.equal(fs.existsSync(path.join(dirs.watcherDir, '..', 'escape.md')), false);
});

test('insertFiled puts one line per filed task right under the Tasks filed heading and keeps the report valid', () => {
  const text = insertFiled(reportText({ 'Tasks filed': 'AGENT-LINE' }), [
    { id: 'T-aaa111', kind: 'fix', title: 'Silent turns skip the log' },
    { id: 'T-bbb222', kind: 'chore', title: 'Drop the unused setting' },
  ]);
  assert.equal(checkReport(text).ok, true);
  const section = text.split('## Tasks filed')[1]?.split('## For the owner')[0] ?? '';
  assert.ok(section.includes('T-aaa111') && section.includes('Silent turns skip the log'));
  assert.ok(section.includes('T-bbb222') && section.includes('chore'));
  assert.ok(section.indexOf('T-aaa111') < section.indexOf('AGENT-LINE'), 'the engine lines come before the agent text');
});

test('insertFiled with nothing filed leaves the text as it was', () => {
  assert.equal(insertFiled(reportText(), []), reportText());
});
