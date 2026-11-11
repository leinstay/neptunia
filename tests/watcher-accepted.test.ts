// The watcher's list of accepted findings (src/watcher/accepted.ts): one file, `agents/watcher/accepted.md` under the data
// folder, one `- ` line per finding, written only by `acceptLine` and `unacceptLine`. The brief carries the list in an
// `<accepted>` block and `checkCoverage` reads the report's `accepted` field against its length. The texts are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { acceptLine, acceptedLines, unacceptLine } from '../src/watcher/accepted.ts';
import { buildBrief } from '../src/watcher/brief.ts';
import { checkCoverage } from '../src/watcher/report.ts';
import { coverageBlock } from './fixtures/watcher-inspection-rig.ts';
import { reportText, watcherDirs } from './fixtures/watcher-rig.ts';

const fileOf = (root: string): string => path.join(root, 'agents', 'watcher', 'accepted.md');

test('accept writes a line and accepted lists it with its place in the list', () => {
  // Bug: the command answers ok but the file keeps nothing, or the list loses the order the numbers refer to.
  const { root } = watcherDirs();
  assert.deepEqual(acceptLine(root, 'the lamp in hall two flickers'), { ok: true, line: 1 });
  assert.deepEqual(acceptLine(root, 'the clock in hall three runs slow'), { ok: true, line: 2 });
  assert.deepEqual(acceptedLines(root), ['the lamp in hall two flickers', 'the clock in hall three runs slow']);
  assert.equal(
    fs.readFileSync(fileOf(root), 'utf8'),
    '- the lamp in hall two flickers\n- the clock in hall three runs slow\n'
  );
});

test('accept refuses an empty text and a text already on the list, and names the line', () => {
  // Bug: a blank line lands in the list, or the same finding is added twice and the numbers drift.
  const { root } = watcherDirs();
  acceptLine(root, 'the lamp in hall two flickers');
  acceptLine(root, 'the clock in hall three runs slow');
  assert.deepEqual(acceptLine(root, ''), { ok: false, code: 'empty' });
  assert.deepEqual(acceptLine(root, '   '), { ok: false, code: 'empty' });
  assert.deepEqual(acceptLine(root, 'the clock in hall three runs slow'), { ok: false, code: 'duplicate', line: 2 });
  assert.equal(acceptedLines(root).length, 2);
});

test('unaccept removes the numbered line, renumbers the rest and answers with the removed text', () => {
  // Bug: the wrong line goes, or the lines after it keep their old numbers, so the next number removes the wrong one.
  const { root } = watcherDirs();
  for (const text of ['alpha lamp', 'beta clock', 'gamma door']) acceptLine(root, text);
  assert.deepEqual(unacceptLine(root, 2), { ok: true, text: 'beta clock' });
  assert.deepEqual(acceptedLines(root), ['alpha lamp', 'gamma door']);
  assert.deepEqual(unacceptLine(root, 2), { ok: true, text: 'gamma door' });
  assert.deepEqual(acceptedLines(root), ['alpha lamp']);
});

test('unaccept refuses a number outside the list and says how many lines the list has', () => {
  // Bug: number 0 or past the end removes nothing but reports success, or removes the last line.
  const { root } = watcherDirs();
  acceptLine(root, 'alpha lamp');
  acceptLine(root, 'beta clock');
  for (const line of [0, 3, -1]) {
    assert.deepEqual(unacceptLine(root, line), { ok: false, code: 'no-line', count: 2 }, String(line));
  }
  assert.deepEqual(acceptedLines(root), ['alpha lamp', 'beta clock']);
});

test('a missing file lists as empty and accept creates it', () => {
  // Bug: the first run on a fresh install throws on the missing file, or accept cannot start the list.
  const { root } = watcherDirs();
  assert.equal(fs.existsSync(fileOf(root)), false);
  assert.deepEqual(acceptedLines(root), []);
  assert.deepEqual(unacceptLine(root, 1), { ok: false, code: 'no-line', count: 0 });
  assert.deepEqual(acceptLine(root, 'alpha lamp'), { ok: true, line: 1 });
  assert.equal(fs.existsSync(fileOf(root)), true);
});

test('a text with a line break is kept as one line', () => {
  // Bug: the second half of the text becomes a second numbered line, or a line without its "- " the reader drops.
  const { root } = watcherDirs();
  assert.deepEqual(acceptLine(root, 'the lamp flickers\nin hall two\r\nevery night'), { ok: true, line: 1 });
  assert.deepEqual(acceptLine(root, 'beta clock'), { ok: true, line: 2 });
  const lines = acceptedLines(root);
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? '', /^the lamp flickers\s+in hall two\s+every night$/);
  const stored = fs
    .readFileSync(fileOf(root), 'utf8')
    .split('\n')
    .filter((line) => line !== '');
  assert.equal(stored.length, 2);
});

test('the brief holds the accepted block with the numbered lines, and none when the list is empty', () => {
  // Bug: the watcher never sees the list, or an empty list adds an empty block the prompt has to explain.
  const dirs = watcherDirs();
  const base = { prompt: 'PROMPT', day: '2026-11-10', reportsDir: dirs.reportsDir };
  const brief = buildBrief({ ...base, accepted: ['alpha lamp flickers', 'beta clock runs slow'] });
  const block = /<accepted>\n([\s\S]*?)\n<\/accepted>/.exec(brief)?.[1] ?? '';
  const lines = block.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? '', /^\D*1\D.*alpha lamp flickers/);
  assert.match(lines[1] ?? '', /^\D*2\D.*beta clock runs slow/);
  assert.equal(buildBrief({ ...base, accepted: [] }).includes('accepted'), false);
  assert.equal(buildBrief(base).includes('accepted'), false);
});

const withAccepted = (accepted?: unknown): string =>
  reportText() + '\n' + coverageBlock(accepted === undefined ? {} : { accepted });

test('checkCoverage takes the accepted field and takes a report without it', () => {
  // Bug: the new field fails a block that holds it, or an old-style block with no field is refused.
  const held = checkCoverage(
    withAccepted([
      { line: 1, count: 3 },
      { line: 2, count: 1 },
    ]),
    2
  );
  assert.ok(held.ok);
  assert.deepEqual(held.coverage.accepted, [
    { line: 1, count: 3 },
    { line: 2, count: 1 },
  ]);
  assert.ok(checkCoverage(withAccepted(), 2).ok, 'an absent field is nothing left out');
  assert.ok(checkCoverage(withAccepted([]), 0).ok);
});

test('checkCoverage refuses a report that names a line the list does not hold, and names the field', () => {
  // Bug: the watcher claims it left findings out under a line that is not there, and the owner trusts a number that means nothing.
  for (const accepted of [[{ line: 3, count: 1 }], [{ line: 0, count: 1 }], [{ line: 1, count: 1 }]]) {
    const size = accepted[0]?.line === 1 ? 0 : 2;
    const checked = checkCoverage(withAccepted(accepted), size);
    assert.ok(!checked.ok, JSON.stringify(accepted));
    assert.equal(checked.code, 'coverage-invalid');
    assert.ok(checked.detail.includes('accepted'));
  }
});
