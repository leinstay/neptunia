// The type-error ratchet. Runs `tsc --noEmit -p .` through the local TypeScript, counts the errors per file and
// error code, and compares the counts with `type-baseline.json` at the repository root. A count above the
// baseline, or a file and code pair the baseline lacks, fails the run. A count below the baseline fails it too,
// so the improvement is written down and cannot hide a later regression.
//
//   node scripts/type-baseline.ts            check against the baseline (exit 0 or 1)
//   node scripts/type-baseline.ts --update   rewrite the baseline from the current errors
//
// `npm run typecheck` and `npm run typecheck:update` call it. The parse and compare functions are exported for
// tests/type-baseline.test.js.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(root, 'type-baseline.json');

const ERROR_LINE = /^(?:(.+?)\(\d+,\d+\): )?error (TS\d+): /;

/**
 * Counts tsc errors per file and code.
 * @param output The text of `tsc --pretty false`.
 * @returns file -> code -> count. Continuation lines are ignored.
 */
export function parseTscOutput(output: string): Record<string, Record<string, number>> {
  const counts: Record<string, Record<string, number>> = {};
  for (const line of output.split('\n')) {
    const match = ERROR_LINE.exec(line);
    if (!match) continue;
    const file = match[1] ?? '(global)';
    const code = match[2];
    counts[file] ??= {};
    counts[file][code] = (counts[file][code] ?? 0) + 1;
  }
  return counts;
}

type Change = { file: string; code: string; was: number; now: number };

/**
 * Compares current counts with the baseline.
 * @returns Both sorted by file, then code.
 */
export function compareToBaseline(
  baseline: Record<string, Record<string, number>>,
  current: Record<string, Record<string, number>>
): { grew: Array<Change>; shrank: Array<Change> } {
  const grew: Array<Change> = [];
  const shrank: Array<Change> = [];
  const files = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort();
  for (const file of files) {
    const was = baseline[file] ?? {};
    const now = current[file] ?? {};
    const codes = [...new Set([...Object.keys(was), ...Object.keys(now)])].sort();
    for (const code of codes) {
      const before = was[code] ?? 0;
      const after = now[code] ?? 0;
      if (after > before) grew.push({ file, code, was: before, now: after });
      else if (after < before) shrank.push({ file, code, was: before, now: after });
    }
  }
  return { grew, shrank };
}

/** Serialises counts with sorted keys, so the file diffs cleanly. */
function stringify(counts: Record<string, Record<string, number>>): string {
  const sorted: Record<string, Record<string, number>> = {};
  for (const file of Object.keys(counts).sort()) {
    sorted[file] = {};
    for (const code of Object.keys(counts[file]).sort()) sorted[file][code] = counts[file][code];
  }
  return JSON.stringify(sorted, null, 2) + '\n';
}

function listChanges(changes: Array<Change>) {
  return changes.map((c) => `  ${c.file} ${c.code}: ${c.was} -> ${c.now}`).join('\n');
}

function runTsc() {
  const tsc = path.join(root, 'node_modules', '.bin', 'tsc');
  const run = spawnSync(tsc, ['--noEmit', '--pretty', 'false', '-p', root], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return { output: (run.stdout ?? '') + (run.stderr ?? ''), status: run.status, error: run.error };
}

function main() {
  const update = process.argv.includes('--update');
  const { output, status, error } = runTsc();
  if (error) {
    console.error(`could not run tsc: ${error.message}`);
    return 1;
  }
  const current = parseTscOutput(output);
  if (status !== 0 && Object.keys(current).length === 0) {
    console.error(`tsc failed without reporting a type error:\n${output.slice(0, 2000)}`);
    return 1;
  }
  const total = Object.values(current).reduce((n, codes) => n + Object.values(codes).reduce((a, b) => a + b, 0), 0);

  if (update) {
    fs.writeFileSync(baselinePath, stringify(current));
    console.log(`type-baseline.json written: ${total} errors in ${Object.keys(current).length} files`);
    return 0;
  }

  const stored = fs.existsSync(baselinePath) ? fs.readFileSync(baselinePath, 'utf8') : '{}';
  const parsed: unknown = JSON.parse(stored);
  const baseline = parsed as Record<string, Record<string, number>>;
  const { grew, shrank } = compareToBaseline(baseline, current);
  if (grew.length > 0) {
    console.error(`New type errors (${grew.length} file and code pairs grew):\n${listChanges(grew)}`);
    // The errors themselves, so a red run names the file, the line and the message.
    const grown = new Set(grew.map((c) => `${c.file} ${c.code}`));
    const lines = output.split('\n').filter((line) => {
      const match = ERROR_LINE.exec(line);
      return match !== null && grown.has(`${match[1] ?? '(global)'} ${match[2]}`);
    });
    console.error(lines.slice(0, 60).join('\n'));
    return 1;
  }
  if (shrank.length > 0) {
    console.error(
      `The baseline shrank (${shrank.length} file and code pairs), run with --update to record it:\n${listChanges(shrank)}`
    );
    return 1;
  }
  console.log(`type check matches the baseline: ${total} errors in ${Object.keys(current).length} files`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
