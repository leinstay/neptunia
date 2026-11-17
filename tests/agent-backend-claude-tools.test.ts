// The tool flags of `claude -p` (src/agent-runner/backend.ts, the claude recipe), seen at the spawn boundary: a
// disposable shell script stands where claude is installed and records the arguments it was started with. A run
// reaches it through `runAgent` (src/subharness/run.ts) with a route.
// Contract: every run gets Read, Grep, Glob, Bash, WebFetch and WebSearch, a write mode adds Edit and Write, and the
// list goes to `--tools` and `--allowedTools`; full and sudo pass `--dangerously-skip-permissions` instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runChildProcess } from '../src/agent-runner/backend.ts';
import type { TaskRoute } from '../src/agent-runner/protocol.ts';
import { runMemoryWriter } from '../src/subharness/memory-writer.ts';
import type { MemoryWriterDeps } from '../src/subharness/memory-writer.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import { runAgent } from '../src/subharness/run.ts';
import type { RunDeps } from '../src/subharness/run.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const SKIP = '--dangerously-skip-permissions';

/** A private folder whose claude is a script that records its arguments, one per line, and answers `ok`. */
function rig() {
  const base = tempDir('nep-claude-tools-');
  const privateDir = path.join(base, 'private');
  const record = path.join(base, 'argv');
  const { binary } = subharnessPlace(privateDir, 'claude');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(
    binary,
    [
      '#!/bin/sh',
      `for arg in "$@"; do printf '%s\\n' "$arg"; done > '${record}'`,
      'cat > /dev/null',
      'echo ok',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  writeKeysFile(privateDir, { subharness: { backends: ['claude'], key: null, modes: {} } });
  const deps: RunDeps = { privateDir, hostEnv: { PATH: process.env.PATH } };
  const argv = (): Array<string> => fs.readFileSync(record, 'utf8').split('\n').slice(0, -1);
  return { base, privateDir, deps, argv };
}

const route = (mode: TaskRoute['mode']): TaskRoute => ({ backend: 'claude', model: null, effort: null, mode });

/** The tool names after `flag`: its values up to the next flag, split on commas and spaces. */
function namesOf(argv: ReadonlyArray<string>, flag: string): Array<string> {
  const at = argv.indexOf(flag);
  assert.notEqual(at, -1, `${flag} is missing from: ${argv.join(' ')}`);
  const values: Array<string> = [];
  for (const arg of argv.slice(at + 1)) {
    if (arg.startsWith('-')) break;
    values.push(...arg.split(/[\s,]+/).filter(Boolean));
  }
  return values.sort();
}

/** One run of `agent` in `mode`; the arguments claude was started with. */
async function launch(agent: string, mode: TaskRoute['mode']) {
  const { deps, argv } = rig();
  const outcome = await runAgent(
    {
      agent,
      brief: 'look',
      cwd: tempDir('nep-claude-cwd-'),
      timeoutMs: 20_000,
      route: route(mode),
    },
    deps
  );
  assert.equal(outcome.ok, true);
  return argv();
}

test('a read run of any agent names the shell and web tools in --tools and --allowedTools, and no edit tool', async () => {
  // Bug: the claude recipe passed no tool flags, so a read agent's shell command was denied.
  // Changed: the prompt is an agent's only limit (owner, 2026-11-17), so every run gets the web tools too.
  const argv = await launch('server', 'read');
  const expected = ['Bash', 'Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch'];
  assert.deepEqual(namesOf(argv, '--tools'), expected);
  assert.deepEqual(namesOf(argv, '--allowedTools'), expected);
  assert.equal(argv.includes(SKIP), false);
});

test('a write run adds Edit and Write to both lists', async () => {
  // Bug: an agent run reached the model but its edits were denied.
  // Changed: every run gets the web tools (owner, 2026-11-17).
  const argv = await launch('dev', 'write');
  const expected = ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch', 'Write'];
  assert.deepEqual(namesOf(argv, '--tools'), expected);
  assert.deepEqual(namesOf(argv, '--allowedTools'), expected);
  assert.equal(argv.includes(SKIP), false);
});

for (const mode of ['full', 'sudo'] as const) {
  test(`a ${mode} run passes --dangerously-skip-permissions`, async () => {
    // Bug: a run without a sandbox still had its tools denied.
    assert.ok((await launch('dev', mode)).includes(SKIP));
  });
}

for (const mode of ['read', 'write'] as const) {
  test(`a ${mode} run never passes --dangerously-skip-permissions or a bypass mode`, async () => {
    // Bug: the bypass flag spreading to the held modes would leave the unit's sandbox the only guard.
    const argv = await launch('scout', mode);
    assert.equal(argv.includes(SKIP), false);
    assert.equal(argv.includes('--allow-dangerously-skip-permissions'), false);
    assert.equal(argv.includes('bypassPermissions'), false);
  });
}

test('the memory writer on claude stays without tools and without the bypass flag', async () => {
  // Guard: her session's writer is one completion with no tools; the new flags must not reach its recipe.
  const base = tempDir('nep-claude-writer-');
  const privateDir = path.join(base, 'private');
  const record = path.join(base, 'argv');
  const { binary } = subharnessPlace(privateDir, 'claude');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(
    binary,
    [
      '#!/bin/sh',
      `for arg in "$@"; do printf '%s\\n' "$arg"; done > '${record}'`,
      'cat > /dev/null',
      `echo '{"result":"done","usage":{}}'`,
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  writeKeysFile(privateDir, { subharness: { backends: ['claude'], key: null, modes: {} } });
  const deps: MemoryWriterDeps = { privateDir, runChild: runChildProcess, workDir: path.join(base, 'work') };
  await runMemoryWriter(
    { kind: 'subharness', backend: 'claude', model: 'claude-opus-4-6', effort: null },
    { system: 's', user: 'u', timeoutMs: 20_000 },
    deps
  );
  const argv = fs.readFileSync(record, 'utf8').split('\n').slice(0, -1);
  assert.equal(argv[argv.indexOf('--tools') + 1], '');
  assert.equal(argv.includes('--allowedTools'), false);
  assert.equal(argv.includes(SKIP), false);
});
