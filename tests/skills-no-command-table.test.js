// Her skills without the owner's slash-command tree. A child process runs with module hooks
// (tests/fixtures/no-command-table-hooks.mjs) that export COMMAND_TABLE empty and make
// `resolveCommand` throw; it proves the registry still holds all 73 skills, the gateway passes her
// 53 live grants, and calls resolve and run by operation name (tests/fixtures/no-command-table-child.mjs).
// Plus a static guard: nothing under src/skills/ or src/behavior/ reads the tree or the old derivation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(ROOT, 'tests', 'fixtures', 'no-command-table-hooks.mjs');
const CHILD = path.join(ROOT, 'tests', 'fixtures', 'no-command-table-child.mjs');

test('skills without the command tree: the registry, the gateway and her calls work with COMMAND_TABLE empty and resolveCommand throwing', () => {
  const ran = spawnSync(process.execPath, ['--import', pathToFileURL(HOOKS).href, CHILD], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  assert.equal(ran.status, 0, `${ran.stdout}\n${ran.stderr}`);
  assert.match(ran.stdout, /^ok$/m);
});

/** The .js files under `dir`, recursively. */
function sourcesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourcesUnder(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

test('skills static guard: nothing under src/skills/ or src/behavior/ imports the command catalog or the derivation, or resolves a command', () => {
  const files = [...sourcesUnder(path.join(ROOT, 'src', 'skills')), ...sourcesUnder(path.join(ROOT, 'src', 'behavior'))];
  assert.ok(files.length > 10);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    const imports = [...text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm)].map((m) => m[1] ?? m[2]);
    for (const spec of imports) {
      assert.ok(!/ops\/catalog(\.js)?$/.test(spec), `${rel} imports ${spec}`);
      assert.ok(!/(^|\/)derive(\.js)?$|skills-derive/.test(spec), `${rel} imports ${spec}`);
    }
    assert.ok(!/\bresolveCommand\b/.test(text), `${rel} mentions resolveCommand`);
  }
});
