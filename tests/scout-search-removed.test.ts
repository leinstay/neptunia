// The scout searches with its harness's own tools. Our own `web-search` shell command (a script that called OpenRouter
// from outside the route) is gone from the profile, the tree and the scout's prompt; the core's quick search stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as profiles from '../src/agent-runner/profiles.ts';
import { SCOUT_SHELL_ALLOW } from '../src/agent-runner/profiles.ts';
import * as lookup from '../src/web/lookup.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the scout shell allows no web-search command', () => {
  // Catches: the allow-list entry surviving after the script is deleted.
  assert.ok(!SCOUT_SHELL_ALLOW.some((rule) => /^web-search\b/.test(rule)));
});

test('profiles.ts exports no SCOUT_TOOLS_DIR', () => {
  // Catches: the folder constant surviving after the folder is deleted.
  assert.ok(!('SCOUT_TOOLS_DIR' in profiles));
});

for (const rel of [
  'agents/scout/bin',
  'agents/scout/bin/web-search',
  'agents/scout/web-search.ts',
  'src/web/web-search.ts',
]) {
  test(`${rel} does not exist`, () => {
    // Catches: the command or its script left behind, still callable by path.
    assert.equal(fs.existsSync(path.join(ROOT, rel)), false);
  });
}

test('the scout prompt names no shell search command', () => {
  // Catches: a prompt that tells the agent to run a command that no longer exists.
  assert.ok(!/web-search/.test(read('agents/scout/prompt.md')));
});

test('the core quick search keeps webSearchPlugins', () => {
  // Catches: the removal taking the core's own quick search with it.
  assert.ok(Array.isArray(lookup.webSearchPlugins(3, 8)));
});
