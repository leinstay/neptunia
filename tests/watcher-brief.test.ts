// The watcher's brief (src/watcher/brief.ts): the prompt file, the day, and the last seven reports it already wrote,
// oldest first. The questions themselves live in the prompt file (model-facing text stays out of src/), so these tests
// read what the brief carries, never its wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildBrief } from '../src/watcher/brief.ts';
import { putReport, reportText, watcherDirs } from './fixtures/watcher-rig.ts';

const PROMPT = 'PROMPT-SENTINEL: the three questions.';

/** `n` days ending the day before `last` (YYYY-MM-DD), oldest first. */
function daysBefore(last: string, n: number): Array<string> {
  const end = Date.parse(`${last}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(end - (n - i) * 86_400_000).toISOString().slice(0, 10));
}

test('the brief carries the prompt file text and the day of the run', () => {
  const dirs = watcherDirs(PROMPT);
  const brief = buildBrief({ prompt: PROMPT, day: '2026-11-02', reportsDir: dirs.reportsDir });
  assert.ok(brief.includes(PROMPT));
  assert.ok(brief.includes('2026-11-02'));
});

test('the brief holds the last seven reports and drops the older ones, so the agent sees one week of its own words', () => {
  const dirs = watcherDirs();
  const days = daysBefore('2026-11-10', 8);
  for (const day of days) putReport(dirs, day, reportText({ 'Her day': `MARK-${day}` }));
  const brief = buildBrief({ prompt: PROMPT, day: '2026-11-10', reportsDir: dirs.reportsDir });
  assert.equal(brief.includes(`MARK-${days[0]}`), false, 'the eighth report back is left out');
  for (const day of days.slice(1)) assert.ok(brief.includes(`MARK-${day}`), `${day} is in the brief`);
});

test('the reports come oldest first, so the newest is the last thing read', () => {
  const dirs = watcherDirs();
  putReport(dirs, '2026-11-08', reportText({ Memory: 'MARK-OLD' }));
  putReport(dirs, '2026-11-09', reportText({ Memory: 'MARK-NEW' }));
  const brief = buildBrief({ prompt: PROMPT, day: '2026-11-10', reportsDir: dirs.reportsDir });
  assert.ok(brief.indexOf('MARK-OLD') < brief.indexOf('MARK-NEW'));
});

test('a report of the run day itself or a later day is not in the brief', () => {
  const dirs = watcherDirs();
  putReport(dirs, '2026-11-10', reportText({ Memory: 'MARK-TODAY' }));
  putReport(dirs, '2026-11-11', reportText({ Memory: 'MARK-LATER' }));
  const brief = buildBrief({ prompt: PROMPT, day: '2026-11-10', reportsDir: dirs.reportsDir });
  assert.equal(brief.includes('MARK-TODAY'), false);
  assert.equal(brief.includes('MARK-LATER'), false);
});

test('files in the reports folder that are no dated report are ignored, failed markers included', () => {
  const dirs = watcherDirs();
  putReport(dirs, '2026-11-09', reportText({ Memory: 'MARK-REAL' }));
  fs.writeFileSync(path.join(dirs.reportsDir, 'notes.md'), 'MARK-NOTES');
  fs.writeFileSync(path.join(dirs.reportsDir, '2026-11-08.failed'), 'MARK-FAILED');
  const brief = buildBrief({ prompt: PROMPT, day: '2026-11-10', reportsDir: dirs.reportsDir });
  assert.ok(brief.includes('MARK-REAL'));
  assert.equal(brief.includes('MARK-NOTES'), false);
  assert.equal(brief.includes('MARK-FAILED'), false);
});

test('the first run has no reports yet and still produces a brief with the prompt', () => {
  const dirs = watcherDirs();
  const brief = buildBrief({ prompt: PROMPT, day: '2026-11-02', reportsDir: dirs.reportsDir });
  assert.ok(brief.includes(PROMPT));
});
