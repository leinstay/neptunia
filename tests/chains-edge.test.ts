// The property-chain rule of STYLEGUIDE.md over the production code: no tracked source outside `tests/` holds a chain
// of four or more segments or a name repeated in a row. One test per area, so an implementer works one area at a
// time. A failure lists the first ten files with their `deep/repeated` counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { countChains } from '../scripts/code-health.ts';

const root = new URL('..', import.meta.url).pathname;
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0')
  .filter((f) => /\.(ts|mjs|js)$/.test(f) && !f.split('/').includes('node_modules'));

function assertNoChains(files: Array<string>) {
  assert.ok(files.length > 0, 'the area has no tracked source files');
  const total = { deep: 0, repeated: 0 };
  const rows: Array<string> = [];
  for (const file of files) {
    const c = countChains(readFileSync(root + file, 'utf8'), file);
    total.deep += c.deep;
    total.repeated += c.repeated;
    if (c.deep || c.repeated) rows.push(`${file}: ${c.deep}/${c.repeated}`);
  }
  assert.deepEqual(total, { deep: 0, repeated: 0 }, `file: deep/repeated\n${rows.slice(0, 10).join('\n')}`);
}

const under = (...prefixes: Array<string>) => tracked.filter((f) => prefixes.some((p) => f.startsWith(p)));

test('interfaces has no chain of four segments and no repeated name', () => {
  assertNoChains(under('interfaces/'));
});

test('cli and bin have no chain of four segments and no repeated name', () => {
  assertNoChains(under('cli/', 'bin/'));
});

test('scripts has no chain of four segments and no repeated name', () => {
  assertNoChains(under('scripts/'));
});
