// The tool flags of `claude -p` (src/agent-runner/backend.ts, the claude recipe), seen at the spawn boundary: a
// disposable shell script stands where claude is installed and records the arguments it was started with. A run
// reaches it through `runAgent` (src/subharness/run.ts) with a route, and through `createAgentEngine` for a profile.
// Contract: `AgentRun.tools` is the profile's OpenCode tool names (absent for the watcher and the development agents);
// the mode (read, write, full, sudo) and those tools become `--tools` and `--allowedTools`; full and sudo become
// `--dangerously-skip-permissions` instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAgentEngine, runChildProcess } from '../src/agent-runner/backend.ts';
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
  const deps: RunDeps = { privateDir, denyDir: path.join(base, 'nosudo'), hostEnv: { PATH: process.env.PATH } };
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

/** One run of `agent` in `mode` with the profile's `tools`; the arguments claude was started with. */
async function launch(agent: string, mode: TaskRoute['mode'], tools?: ReadonlyArray<string>) {
  const { deps, argv } = rig();
  const outcome = await runAgent(
    {
      agent,
      brief: 'look',
      cwd: tempDir('nep-claude-cwd-'),
      timeoutMs: 20_000,
      route: route(mode),
      ...(tools ? { tools } : {}),
    },
    deps
  );
  assert.equal(outcome.ok, true);
  return argv();
}

test('a read run without profile tools names Read, Grep, Glob and Bash in --tools and --allowedTools, and no edit tool', async () => {
  // Bug: the claude recipe passed no tool flags, so the watcher's `neptunia service watcher evidence` was denied.
  const argv = await launch('watcher', 'read');
  assert.deepEqual(namesOf(argv, '--tools'), ['Bash', 'Glob', 'Grep', 'Read']);
  assert.deepEqual(namesOf(argv, '--allowedTools'), ['Bash', 'Glob', 'Grep', 'Read']);
  assert.equal(argv.includes(SKIP), false);
});

test('a write run adds Edit and Write to both lists', async () => {
  // Bug: a dev or thinker run reached the model but its edits were denied.
  const argv = await launch('dev', 'write');
  const expected = ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'];
  assert.deepEqual(namesOf(argv, '--tools'), expected);
  assert.deepEqual(namesOf(argv, '--allowedTools'), expected);
  assert.equal(argv.includes(SKIP), false);
});

test('the profile tools websearch and webfetch become WebSearch and WebFetch, and list or todowrite name nothing', async () => {
  // Bug: the scout declares web tools in its profile and gets none on claude.
  const argv = await launch('scout', 'write', ['websearch', 'webfetch', 'read', 'glob', 'list', 'bash', 'todowrite']);
  const expected = ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch', 'Write'];
  assert.deepEqual(namesOf(argv, '--tools'), expected);
  assert.deepEqual(namesOf(argv, '--allowedTools'), expected);
});

test('a read profile without web tools gets no WebFetch and no WebSearch', async () => {
  // Bug: a flat tool list for every agent would hand the server a network tool.
  const argv = await launch('server', 'read', ['read', 'grep', 'glob', 'list', 'bash']);
  assert.deepEqual(namesOf(argv, '--tools'), ['Bash', 'Glob', 'Grep', 'Read']);
  assert.deepEqual(namesOf(argv, '--allowedTools'), ['Bash', 'Glob', 'Grep', 'Read']);
});

test('the engine passes the profile tools of the scout to the run', async () => {
  // Bug: createAgentEngine dropped profile.tools, so the scout's web tools never reached the recipe.
  const { base, deps, argv } = rig();
  const prompt = path.join(base, 'agent.md');
  fs.writeFileSync(prompt, 'You are an errand agent.');
  const profile = {
    name: 'scout',
    promptFiles: [prompt],
    defaultLimits: { steps: 5, seconds: 30 },
    tools: ['websearch', 'webfetch', 'read', 'glob', 'list', 'bash'],
    search: true,
  };
  const engine = createAgentEngine({
    profile: profile as unknown as Parameters<typeof createAgentEngine>[0]['profile'],
    outDir: path.join(base, 'out'),
    subharness: deps,
  });
  const task = { id: 't1', goal: 'find it', context: {}, route: route('read') } as unknown as Parameters<
    typeof engine.run
  >[0];
  assert.equal((await engine.run(task)).status, 'done');
  assert.deepEqual(namesOf(argv(), '--tools'), ['Bash', 'Glob', 'Read', 'WebFetch', 'WebSearch']);
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
    const argv = await launch('scout', mode, ['bash']);
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
