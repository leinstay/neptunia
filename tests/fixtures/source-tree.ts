// The files of the active source tree, for the tests that gate a name (a lexical check over `src/`, `bin/` and
// `interfaces/`). Paths come back relative to the repository root with forward slashes.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root. */
export const ROOT: string = fileURLToPath(new URL('../..', import.meta.url));

function walk(dir: string, extensions: ReadonlyArray<string>, found: Array<string>): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, extensions, found);
    else if (extensions.some((extension) => name.endsWith(extension))) found.push(relative(ROOT, full).split('\\').join('/'));
  }
}

/** Every file under the given top folders whose name ends with one of `extensions`, sorted. */
export function sourceFiles(roots: ReadonlyArray<string>, extensions: ReadonlyArray<string> = ['.ts', '.tsx']): Array<string> {
  const found: Array<string> = [];
  for (const root of roots) walk(join(ROOT, root), extensions, found);
  return found.sort();
}

/** The text of a file given by its path relative to the root. */
export function readSource(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8');
}
