// Picks the test files that cover a changed source file. Used by scripts/broken-module-run.ts.

import { findImports } from '../code-health.ts';

const TEST_FILE = /^tests\/.+\.test\.(?:js|mjs|ts)$/;
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
