// Mutation testing on the lines a branch changed, never on the whole suite. It reads `git diff --unified=0
// <base-ref>...HEAD`, keeps the added and changed lines of the `.js`, `.mjs` and `.ts` files under `src/` and
// `interfaces/`, and hands them to Stryker as `mutate` ranges. The test files it runs are the ones named after the
// changed files (the rule of tools/code-health.mjs) plus every changed test file. A changed file with no test of its
// own is named and skipped. A change whose commit subjects all start with
// "Format " is skipped whole, because formatting rewrites old lines. The score is read from Stryker's
// json report and compared with `thresholds.break` of stryker.config.json, a starting value of 60 to raise once real
// runs are measured.
//
//   node tools/mutation-diff.mjs <base-ref>   exit 0: nothing to mutate, or the score meets the threshold
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The changed lines a run mutates. Measured at 1.5 mutants per changed line, 270 lines stay near 400 mutants. */
const MAX_LINES = 270;

const SOURCE = /^(?:src|interfaces)\/.+\.(?:js|mjs|ts)$/;
const NOT_SOURCE = /(?:^|\/)(?:tests?|fixtures|node_modules)\/|\.d\.ts$|\.test\.[^/]+$/;
const TEST_FILE = /^tests\/.+\.test\.(?:js|mjs|ts)$/;
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * @typedef {Record<string, Array<[number, number]>>} Ranges  File path to inclusive [start, end] line ranges.
 */

/**
 * Reads the new-side line ranges of every file in a `--unified=0` diff. A file with only deleted lines is listed
 * with no range. A deleted file is not listed.
 * @param {string} diff
 * @returns {Ranges}
 */
export function parseChangedRanges(diff) {
  /** @type {Ranges} */
  const ranges = {};
  /** @type {string | null} */
  let file = null;
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

/**
 * Keeps the files Stryker should mutate: source under `src/` and `interfaces/`, never tests, fixtures or typings.
 * @param {Ranges} ranges
 * @returns {Ranges}
 */
export function sourceRanges(ranges) {
  /** @type {Ranges} */
  const kept = {};
  for (const [file, list] of Object.entries(ranges)) {
    if (list.length > 0 && SOURCE.test(file) && !NOT_SOURCE.test(file)) kept[file] = list;
  }
  return kept;
}

/**
 * Stryker `mutate` entries: `path:start-end`.
 * @param {Ranges} ranges
 * @returns {Array<string>}
 */
export function toMutateEntries(ranges) {
  return Object.entries(ranges).flatMap(([file, list]) => list.map(([start, end]) => `${file}:${start}-${end}`));
}

/**
 * The test names that count for a module, the rule of tools/code-health.mjs: the file name with any tail of its
 * folder path, joined by hyphens.
 * @param {string} filePath
 * @returns {Array<string>}
 */
function testNamesFor(filePath) {
  const parts = filePath.replace(/\.[^.]+$/, '').split('/');
  return parts.map((_, i) => `tests/${parts.slice(i).join('-')}.test.`);
}

/**
 * The test files to run: the match of each changed source file, plus the changed test files.
 * @param {Array<string>} sourceFiles  Changed source files.
 * @param {Array<string>} changedFiles  Every changed path, tests included.
 * @param {Array<string>} testFiles  Every test file of the tree.
 * @returns {Array<string>} Sorted, each once.
 */
export function selectTestFiles(sourceFiles, changedFiles, testFiles) {
  const picked = new Set(changedFiles.filter((f) => TEST_FILE.test(f)));
  for (const source of sourceFiles) {
    const names = testNamesFor(source);
    for (const test of testFiles) if (names.some((n) => test.startsWith(n))) picked.add(test);
  }
  return [...picked].sort();
}

/**
 * The changed source files no test is named after by the naming rule. A changed test file does not rescue them: it
 * is run for the files that have a test, and against a file of no test it would only leave uncovered mutants.
 * @param {Array<string>} sourceFiles  Changed source files.
 * @param {Array<string>} testFiles  Every test file of the tree.
 * @returns {Array<string>}
 */
export function filesWithoutTest(sourceFiles, testFiles) {
  return sourceFiles.filter((source) => selectTestFiles([source], [], testFiles).length === 0);
}

/**
 * Whether a change only formats code: it has commits and every subject starts with "Format ". Formatting rewrites
 * old lines, and mutating them would test old code.
 * @param {Array<string>} subjects  The commit subjects of the change, merge commits left out.
 * @returns {boolean}
 */
export function isFormatOnly(subjects) {
  return subjects.length > 0 && subjects.every((subject) => subject.startsWith('Format '));
}

/**
 * @param {Array<[number, number]>} list
 * @returns {number}
 */
function lineCount(list) {
  return list.reduce((n, [start, end]) => n + end - start + 1, 0);
}

/**
 * Bounds a run on its changed lines. Files are taken largest first, the last range that still fits is cut to the
 * budget, and the lines of everything left out are counted per file.
 * @param {Ranges} ranges
 * @param {number} maxLines
 * @returns {{ ranges: Ranges, skipped: Record<string, number> }}
 */
export function capRanges(ranges, maxLines) {
  /** @type {Ranges} */
  const kept = {};
  /** @type {Record<string, number>} */
  const skipped = {};
  let left = maxLines;
  const files = Object.keys(ranges).sort((a, b) => lineCount(ranges[b]) - lineCount(ranges[a]) || a.localeCompare(b));
  for (const file of files) {
    /** @type {Array<[number, number]>} */
    const taken = [];
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
 * @param {{ files: Record<string, { mutants: Array<{ status: string }> }> }} report
 * @returns {{ score: number | null, detected: number, undetected: number }}
 */
export function scoreFromReport(report) {
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

/**
 * @param {string} cwd
 * @param {Array<string>} args
 * @returns {string}
 */
function git(cwd, args) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (run.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${(run.stderr || run.error?.message) ?? ''}`.trim());
  return run.stdout;
}

/** @param {string} base */
function main(base) {
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
  for (const file of filesWithoutTest(Object.keys(sources), allTests)) {
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

  const tests = selectTestFiles(Object.keys(ranges), Object.keys(changed), allTests);
  /** @type {unknown} */
  const parsedConfig = JSON.parse(fs.readFileSync(path.join(root, 'stryker.config.json'), 'utf8'));
  const baseConfig = /** @type {{ thresholds?: { break?: number }, tap?: object }} */ (parsedConfig);
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
    /** @type {unknown} */
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const { score, detected, undetected } = scoreFromReport(
      /** @type {Parameters<typeof scoreFromReport>[0]} */ (report)
    );
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
    console.error('usage: node tools/mutation-diff.mjs <base-ref>');
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
