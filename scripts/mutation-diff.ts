// Mutation testing on the lines a branch changed, never on the whole suite. It reads `git diff --unified=0
// <base-ref>...HEAD`, keeps the added and changed lines of the `.js`, `.mjs` and `.ts` files under `src/` and
// `interfaces/`, and hands them to Stryker as `mutate` ranges. The test files it runs are the ones named after the
// changed files (the rule of scripts/code-health.ts), the ones that import a changed file directly (`findImports` of
// the same tool, no fixture followed), and every changed test file. A changed file that no test is named after or
// imports is named and skipped. A change whose commit subjects all start with
// "Format " is skipped whole, because formatting rewrites old lines. The score is read from Stryker's
// json report and compared with `thresholds.break` of stryker.config.json, a starting value of 60 to raise once real
// runs are measured.
//
//   node scripts/mutation-diff.ts <base-ref>   exit 0: nothing to mutate, or the score meets the threshold
//                                             exit 1: the score is under the threshold
//                                             exit 2: a usage or run error
//
// `npm run mutation -- <base-ref>` calls it. Stryker cannot sample mutants, so the run is bounded on the changed
// lines: at most MAX_LINES lines, largest files first, and the output names what it left out. The sandbox, the json
// report and the generated config live in a folder under TMPDIR that the run removes. The pure parts are exported
// for tests/mutation-diff.test.js.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findImports } from './code-health.ts';
import type { Untyped } from '../src/tools/types.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The changed lines a run mutates. Measured at 1.5 mutants per changed line, 270 lines stay near 400 mutants. */
const MAX_LINES = 270;

const SOURCE = /^(?:src|interfaces)\/.+\.(?:js|mjs|ts)$/;
const NOT_SOURCE = /(?:^|\/)(?:tests?|fixtures|node_modules)\/|\.d\.ts$|\.test\.[^/]+$/;
const TEST_FILE = /^tests\/.+\.test\.(?:js|mjs|ts)$/;
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** File path to inclusive [start, end] line ranges. */
type Ranges = Record<string, Array<[number, number]>>;

/**
 * Reads the new-side line ranges of every file in a `--unified=0` diff. A file with only deleted lines is listed
 * with no range. A deleted file is not listed.
 */
export function parseChangedRanges(diff: string): Ranges {
  const ranges: Ranges = {};
  let file: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4);
      file = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (file) ranges[file] ??= [];
      continue;
    }
    if (!file) continue;
    const hunk = HUNK.exec(line);
    if (!hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) ranges[file].push([start, start + count - 1]);
  }
  return ranges;
}

/** Keeps the files Stryker should mutate: source under `src/` and `interfaces/`, never tests, fixtures or typings. */
export function sourceRanges(ranges: Ranges): Ranges {
  const kept: Ranges = {};
  for (const [file, list] of Object.entries(ranges)) {
    if (list.length > 0 && SOURCE.test(file) && !NOT_SOURCE.test(file)) kept[file] = list;
  }
  return kept;
}

/** Stryker `mutate` entries: `path:start-end`. */
export function toMutateEntries(ranges: Ranges): Array<string> {
  return Object.entries(ranges).flatMap(([file, list]) => list.map(([start, end]) => `${file}:${start}-${end}`));
}

/**
 * The test names that count for a module, the rule of scripts/code-health.ts: the file name with any tail of its
 * folder path, joined by hyphens.
 */
function testNamesFor(filePath: string): Array<string> {
  const parts = filePath.replace(/\.[^.]+$/, '').split('/');
  return parts.map((_, i) => `tests/${parts.slice(i).join('-')}.test.`);
}

/**
 * The test files to run: the match of each changed source file by name, the tests that import it when `read` is
 * given, plus the changed test files. A test whose `read` returns undefined contributes nothing by import.
 * @param sourceFiles Changed source files.
 * @param changedFiles Every changed path, tests included.
 * @param testFiles Every test file of the tree.
 * @param read The text of a repository path.
 * @returns Sorted, each once.
 */
export function selectTestFiles(
  sourceFiles: Array<string>,
  changedFiles: Array<string>,
  testFiles: Array<string>,
  read?: (file: string) => string | undefined
): Array<string> {
  const picked = new Set(changedFiles.filter((f) => TEST_FILE.test(f)));
  for (const source of sourceFiles) {
    const names = testNamesFor(source);
    for (const test of testFiles) if (names.some((n) => test.startsWith(n))) picked.add(test);
  }
  if (read) {
    for (const test of testFiles) {
      const text = read(test);
      if (text !== undefined && sourceFiles.some((source) => findImports(text, test).includes(source))) {
        picked.add(test);
      }
    }
  }
  return [...picked].sort();
}

/**
 * The changed source files no test is named after or, with `read`, imports. A changed test file does not rescue
 * them: it is run for the files that have a test, and against a file of no test it would only leave uncovered mutants.
 * @param sourceFiles Changed source files.
 * @param testFiles Every test file of the tree.
 * @param read The text of a repository path.
 */
export function filesWithoutTest(
  sourceFiles: Array<string>,
  testFiles: Array<string>,
  read?: (file: string) => string | undefined
): Array<string> {
  return sourceFiles.filter((source) => selectTestFiles([source], [], testFiles, read).length === 0);
}

/**
 * Whether a change only formats code: it has commits and every subject starts with "Format ". Formatting rewrites
 * old lines, and mutating them would test old code.
 * @param subjects The commit subjects of the change, merge commits left out.
 */
export function isFormatOnly(subjects: Array<string>): boolean {
  return subjects.length > 0 && subjects.every((subject) => subject.startsWith('Format '));
}

function lineCount(list: Array<[number, number]>): number {
  return list.reduce((n, [start, end]) => n + end - start + 1, 0);
}

/**
 * Bounds a run on its changed lines. Files are taken largest first, the last range that still fits is cut to the
 * budget, and the lines of everything left out are counted per file.
 */
export function capRanges(ranges: Ranges, maxLines: number): { ranges: Ranges; skipped: Record<string, number> } {
  const kept: Ranges = {};
  const skipped: Record<string, number> = {};
  let left = maxLines;
  const files = Object.keys(ranges).sort((a, b) => lineCount(ranges[b]) - lineCount(ranges[a]) || a.localeCompare(b));
  for (const file of files) {
    const taken: Array<[number, number]> = [];
    let lost = 0;
    for (const [start, end] of ranges[file]) {
      const size = end - start + 1;
      if (left <= 0) lost += size;
      else if (size <= left) {
        taken.push([start, end]);
        left -= size;
      } else {
        taken.push([start, start + left - 1]);
        lost += size - left;
        left = 0;
      }
    }
    if (taken.length > 0) kept[file] = taken;
    if (lost > 0) skipped[file] = lost;
  }
  return { ranges: kept, skipped };
}

/**
 * The mutation score of a Stryker json report: killed and timed-out mutants over those and the survived and
 * uncovered ones. Compile errors and ignored mutants do not count.
 */
export function scoreFromReport(report: { files: Record<string, { mutants: Array<{ status: string }> }> }): {
  score: number | null;
  detected: number;
  undetected: number;
} {
  let detected = 0;
  let undetected = 0;
  for (const { mutants } of Object.values(report.files)) {
    for (const { status } of mutants) {
      if (status === 'Killed' || status === 'Timeout') detected += 1;
      else if (status === 'Survived' || status === 'NoCoverage') undetected += 1;
    }
  }
  const total = detected + undetected;
  return { score: total === 0 ? null : (detected / total) * 100, detected, undetected };
}

function git(cwd: string, args: Array<string>): string {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (run.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${(run.stderr || run.error?.message) ?? ''}`.trim());
  return run.stdout;
}

/**
 * @param file A path relative to the repository root.
 * @returns Its text, or undefined when it cannot be read.
 */
function readFromTree(file: string): string | undefined {
  try {
    return fs.readFileSync(path.join(root, file), 'utf8');
  } catch {
    return undefined;
  }
}

function main(base: string) {
  const subjects = git(root, ['log', '--format=%s', '--no-merges', `${base}..HEAD`])
    .split('\n')
    .filter(Boolean);
  if (isFormatOnly(subjects)) {
    console.log('mutation: skipping a format-only change');
    return 0;
  }
  const diff = git(root, ['diff', '--unified=0', '--no-color', '--no-renames', '--diff-filter=ACMR', `${base}...HEAD`]);
  const changed = parseChangedRanges(diff);
  const sources = sourceRanges(changed);
  if (Object.keys(sources).length === 0) {
    console.log('mutation: no source line changed, nothing to mutate');
    return 0;
  }

  const allTests = git(root, ['ls-files', 'tests'])
    .split('\n')
    .filter((f) => TEST_FILE.test(f));
  for (const file of filesWithoutTest(Object.keys(sources), allTests, readFromTree)) {
    console.log(`mutation: no test covers ${file}, skipped`);
    delete sources[file];
  }
  if (Object.keys(sources).length === 0) {
    console.log('mutation: no changed file has a test, nothing to mutate');
    return 0;
  }

  const { ranges, skipped } = capRanges(sources, MAX_LINES);
  const left = Object.entries(skipped);
  if (left.length > 0) {
    console.log(`mutation: bounded to ${MAX_LINES} changed lines, left out:`);
    for (const [file, lines] of left) console.log(`  ${file}: ${lines} lines`);
  }

  const tests = selectTestFiles(Object.keys(ranges), Object.keys(changed), allTests, readFromTree);
  const parsedConfig: unknown = JSON.parse(fs.readFileSync(path.join(root, 'stryker.config.json'), 'utf8'));
  const baseConfig = parsedConfig as { thresholds?: { break?: number }; tap?: Record<string, Untyped> };
  const threshold = baseConfig.thresholds?.break ?? 0;

  const work = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'mutation-'));
  try {
    const reportPath = path.join(work, 'mutation.json');
    const config = {
      ...baseConfig,
      mutate: toMutateEntries(ranges),
      tempDirName: path.join(work, 'sandbox'),
      tap: { ...baseConfig.tap, testFiles: tests },
      jsonReporter: { fileName: reportPath },
    };
    const configPath = path.join(work, 'stryker.json');
    fs.writeFileSync(configPath, JSON.stringify(config));
    console.log(
      `mutation: ${config.mutate.length} ranges in ${Object.keys(ranges).length} files, ${tests.length} test files`
    );

    spawnSync(path.join(root, 'node_modules', '.bin', 'stryker'), ['run', configPath], { cwd: root, stdio: 'inherit' });
    if (!fs.existsSync(reportPath)) {
      console.error('mutation: Stryker wrote no report');
      return 2;
    }
    const report: unknown = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const { score, detected, undetected } = scoreFromReport(report as Parameters<typeof scoreFromReport>[0]);
    if (score === null) {
      console.log('mutation: no mutant could be judged, nothing to score');
      return 0;
    }
    const verdict = score >= threshold ? 'meets' : 'is under';
    console.log(
      `mutation: score ${score.toFixed(1)} (${detected} detected, ${undetected} undetected) ${verdict} the threshold ${threshold}`
    );
    return score >= threshold ? 0 : 1;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.argv[2];
  if (!base) {
    console.error('usage: node scripts/mutation-diff.ts <base-ref>');
    process.exitCode = 2;
  } else {
    try {
      process.exitCode = main(base);
    } catch (err) {
      console.error(`mutation: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 2;
    }
  }
}
