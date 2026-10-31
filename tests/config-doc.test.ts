// tools/config-doc.mjs writes `docs/configuration.md` from the settings schema (src/config/schema.ts) to stdout. The
// document in the tree must be the generator's output, so a key added to the schema without a regenerated document
// fails here, in CI as on the desk. The tests check which keys the output names, never its prose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CONFIG_SCHEMA } from '../src/config/schema.ts';
import { ROOT } from './fixtures/private-layer.ts';

function generated(): string {
  const run = spawnSync(process.execPath, ['tools/config-doc.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

test('the generated document names every key of the schema in backticks', () => {
  const doc = generated();
  const missing = CONFIG_SCHEMA.map((entry) => entry.key).filter((key) => !doc.includes(`\`${key}\``));
  assert.deepEqual(missing, []);
});

test('docs/configuration.md is the output of the generator', () => {
  assert.equal(fs.readFileSync(path.join(ROOT, 'docs', 'configuration.md'), 'utf8'), generated());
});
