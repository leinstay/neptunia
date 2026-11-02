// src/watcher/news.ts: what the selfimprovement wake carries of the watcher (spec 2026-11-02, "`selfimprovement` daily,
// after the watcher"): the newest report of the past day, its date and the bodies of its `## For the owner` and
// `## Tasks filed` sections. Absent with no such report or with the watcher off. The reports folder is a temp dir
// named by `watcher.dir`; the clock is injected. Each test names the bug it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { watcherNews } from '../src/watcher/news.ts';
import { tempDir } from './fixtures/tmp.ts';

const NOW = Date.parse('2026-11-02T03:00:00Z');

/** A report with the seven headings; `owner` and `filed` are the bodies of the two sections the wake carries. */
function report(owner: string, filed: string): string {
  return [
    '## Her day',
    'A quiet day.',
    '## Misunderstandings',
    'None.',
    '## Memory',
    'Nothing lost.',
    '## The project',
    'One pull request open.',
    '## The server',
    'Disk at 40 percent.',
    '## Tasks filed',
    filed,
    '## For the owner',
    owner,
    '',
  ].join('\n');
}

/** A watcher folder with `reports` (day to text), and the config that names it. */
function rig(reports: Record<string, string>, enabled = true): { config: unknown; rootDir: string } {
  const rootDir = tempDir('nep-watcher-news-');
  const dir = path.join(rootDir, 'watch');
  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  for (const [day, text] of Object.entries(reports)) fs.writeFileSync(path.join(dir, 'reports', `${day}.md`), text);
  return { config: { watcher: { enabled, dir } }, rootDir };
}

test("today's report gives its date and the two sections' bodies", () => {
  // Catches: the wake gets the whole report, or the headings with the bodies, and her facts grow by every section.
  const { config, rootDir } = rig({ '2026-11-02': report('Look at the retry rail.', '- T12 fix: the retry rail') });
  assert.deepEqual(watcherNews({ config, rootDir, now: NOW }), {
    day: '2026-11-02',
    forOwner: 'Look at the retry rail.',
    tasksFiled: '- T12 fix: the retry rail',
  });
});

test('a section ends at the next heading', () => {
  // Catches: "Tasks filed" is read to the end of the file and carries the owner's section a second time.
  const { config, rootDir } = rig({ '2026-11-02': report('For the owner only.', 'No task.') });
  assert.equal(watcherNews({ config, rootDir, now: NOW })?.tasksFiled, 'No task.');
});

test("of yesterday's and today's reports the newest is carried", () => {
  // Catches: the oldest report of the window is read, and she works from a day-old report when a fresh one exists.
  const { config, rootDir } = rig({ '2026-11-01': report('old', 'old'), '2026-11-02': report('new', 'new') });
  assert.equal(watcherNews({ config, rootDir, now: NOW })?.day, '2026-11-02');
});

test("yesterday's report is carried when today has none", () => {
  // Catches: a watcher set to run late in the evening never reaches the morning wake, whose UTC date is the next one.
  const { config, rootDir } = rig({ '2026-11-01': report('evening run', 'none') });
  assert.equal(watcherNews({ config, rootDir, now: NOW })?.day, '2026-11-01');
});

test('a report older than the past day is not carried', () => {
  // Catches: a stale report from a watcher that stopped days ago is shown to her every day as if it were new.
  const { config, rootDir } = rig({ '2026-10-30': report('stale', 'stale') });
  assert.equal(watcherNews({ config, rootDir, now: NOW }), null);
});

test('with the watcher off a report on disk is not carried', () => {
  // Catches: the block appears although the owner switched the watcher off in setup.
  const { config, rootDir } = rig({ '2026-11-02': report('x', 'y') }, false);
  assert.equal(watcherNews({ config, rootDir, now: NOW }), null);
});

test('a watcher folder that does not exist gives no report', () => {
  // Catches: a deployment that never ran the watcher throws while building the wake, and the wake loses all its facts.
  const rootDir = tempDir('nep-watcher-news-');
  const config = { watcher: { enabled: true, dir: path.join(rootDir, 'never-made') } };
  assert.equal(watcherNews({ config, rootDir, now: NOW }), null);
});

test('a report with neither section gives no report, and one with a single section an empty other', () => {
  // Catches: a hand-written note in the folder becomes an empty block, or a missing section reads as "undefined".
  const { config, rootDir } = rig({ '2026-11-02': '## Her day\nA note.\n' });
  assert.equal(watcherNews({ config, rootDir, now: NOW }), null);
  const half = rig({ '2026-11-02': '## For the owner\nOnly this.\n' });
  assert.deepEqual(watcherNews({ config: half.config, rootDir: half.rootDir, now: NOW }), {
    day: '2026-11-02',
    forOwner: 'Only this.',
    tasksFiled: '',
  });
});
