// src/subharness/run.ts: the one seam every agent run goes through (errands, dev, the watcher). It reads keys.json at
// the moment of the run, as Hermes' approval guard reads its mode on each check (hermes_cli/approval_mode.py), refuses
// with `subharness-off` while the subharness is off, maps the agent's mode to the backend's sandbox, takes `sudo` off
// the child's PATH unless the mode is `sudo`, gives OpenCode its one key, and logs one line for a run without a sandbox.
// The backend is a fake that records what it was given; nothing is spawned except the tiny `sudo` stand-in the run
// writes, which one test executes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent, sandboxOfMode } from '../src/subharness/run.ts';
import type { AgentRun, RunDeps } from '../src/subharness/run.ts';
import { setAgentMode } from '../src/subharness/control.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import type { Backend, BackendResult, BackendRunOptions } from '../src/agent-runner/backend.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const OC_SECRET = 'sk-or-v1-oc-secret-0123456789';
const CORE_SECRET = 'sk-or-v1-core-secret-9876543210';
const BRIEF = 'check the disk and report back, secret brief text';
const HOST_PATH = '/usr/local/bin:/usr/bin:/bin';

type Seen = { name: string; brief: string; options: BackendRunOptions };

function rig(subharness: { backend: 'codex' | 'claude' | 'opencode' | null; key?: string | null }) {
  const privateDir = tempDir('nep-run-priv-');
  const denyDir = path.join(tempDir('nep-run-deny-'), 'nosudo');
  writeKeysFile(privateDir, {
    core: [{ name: 'core-1', value: CORE_SECRET }],
    extra: { opencode: OC_SECRET },
    subharness: { backend: subharness.backend, key: subharness.key ?? null, modes: {} },
  });
  const seen: Array<Seen> = [];
  const result: BackendResult = { ok: true, text: 'done', exitCode: 0 };
  const deps: RunDeps = {
    privateDir,
    denyDir,
    hostEnv: { PATH: HOST_PATH, HOME: '/home/x' },
    backendFactory: (name) => ({
      name,
      run: (brief: string, options: BackendRunOptions) => {
        seen.push({ name, brief, options });
        return Promise.resolve(result);
      },
    }),
  };
  return { deps, privateDir, denyDir, seen };
}

const request = (agent: string, extra: Partial<AgentRun> = {}): AgentRun => ({
  agent,
  brief: BRIEF,
  cwd: '/tmp/x',
  timeoutMs: 1000,
  ...extra,
});

test('the modes map to the sandbox: read, workspace-write, and none for full and sudo', () => {
  // Bug: full or sudo mapped to "danger-full-access" (still a sandbox flag) or read mapped to workspace-write.
  assert.equal(sandboxOfMode('read'), 'read-only');
  assert.equal(sandboxOfMode('write'), 'workspace-write');
  assert.equal(sandboxOfMode('full'), 'none');
  assert.equal(sandboxOfMode('sudo'), 'none');
});

test('while the subharness is off every agent task is refused subharness-off and no backend is made', async () => {
  // Bug: an agent runs on the tracked default backend although the owner never turned the subharness on.
  const { deps, seen } = rig({ backend: null });
  let made = 0;
  const counting: RunDeps = { ...deps, backendFactory: (name) => (made++, deps.backendFactory?.(name) as Backend) };
  for (const agent of ['scout', 'server', 'dev', 'watcher']) {
    const result = await runAgent(request(agent), counting);
    assert.equal(result.ok, false, agent);
    assert.equal(result.error, 'subharness-off', agent);
    assert.equal(result.exitCode, null, agent);
  }
  assert.equal(made, 0);
  assert.equal(seen.length, 0);
});

test('keys.json is read at each run: turning the subharness off between two runs refuses the second', async () => {
  // Bug: the backend is cached when the runner starts, so "subharness disable" changes nothing until a restart.
  const { deps, privateDir } = rig({ backend: 'codex' });
  assert.equal((await runAgent(request('scout'), deps)).ok, true);
  const stored = readKeysFile(privateDir);
  writeKeysFile(privateDir, { ...stored, subharness: { ...stored.subharness, backend: null } });
  assert.equal((await runAgent(request('scout'), deps)).error, 'subharness-off');
});

test('a run goes to the stored backend with the sandbox of the default mode of its agent', async () => {
  // Bug: the server agent gets workspace-write because the profile or the backend default says so.
  const { deps, seen } = rig({ backend: 'codex' });
  for (const agent of ['server', 'watcher', 'scout', 'dev']) await runAgent(request(agent), deps);
  assert.deepEqual(
    seen.map((one) => [one.name, one.options.sandbox]),
    [
      ['codex', 'read-only'],
      ['codex', 'read-only'],
      ['codex', 'workspace-write'],
      ['codex', 'workspace-write'],
    ]
  );
});

test("the owner's mode wins over the profile: server set to write runs workspace-write", async () => {
  // Bug: the profile's sandbox key overrides the mode, so "subharness mode server write" has no effect.
  const { deps, privateDir, seen } = rig({ backend: 'codex' });
  await setAgentMode(privateDir, 'server', 'write');
  await runAgent(request('server'), deps);
  assert.equal(seen[0]?.options.sandbox, 'workspace-write');
});

test('a mode change takes effect on the next run without a restart', async () => {
  // Bug: the mode is read once at start, so dev stays in write after the owner moved it to sudo.
  const { deps, privateDir, seen } = rig({ backend: 'codex' });
  await runAgent(request('dev'), deps);
  await setAgentMode(privateDir, 'dev', 'sudo');
  await runAgent(request('dev'), deps);
  assert.deepEqual(
    seen.map((one) => one.options.sandbox),
    ['workspace-write', 'none']
  );
});

test('an agent the table does not list runs in read', async () => {
  // Bug: an unlisted agent falls through to an unsandboxed or writable mode.
  const { deps, seen } = rig({ backend: 'codex' });
  await runAgent(request('stranger'), deps);
  assert.equal(seen[0]?.options.sandbox, 'read-only');
});

test('the brief, the cwd, the timeout, search, images and the signal reach the backend unchanged', async () => {
  // Bug: the seam drops an option, so the scout loses live search or a cancel no longer kills the child.
  const { deps, seen } = rig({ backend: 'codex' });
  const signal = new AbortController().signal;
  await runAgent(request('scout', { search: true, images: ['/a.png'], signal }), deps);
  const options = seen[0]?.options;
  assert.equal(seen[0]?.brief, BRIEF);
  assert.equal(options?.cwd, '/tmp/x');
  assert.equal(options?.timeoutMs, 1000);
  assert.equal(options?.search, true);
  assert.deepEqual(options?.images, ['/a.png']);
  assert.equal(options?.signal, signal);
});

test('in read, write and full the PATH starts with a directory whose sudo refuses, and the rest of the PATH follows', async () => {
  // Bug: an agent in write mode runs sudo through the host PATH, which the owner never allowed.
  for (const mode of ['read', 'write', 'full'] as const) {
    const { deps, privateDir, denyDir, seen } = rig({ backend: 'codex' });
    await setAgentMode(privateDir, 'dev', mode);
    await runAgent(request('dev'), deps);
    assert.equal(seen[0]?.options.env?.PATH, `${denyDir}:${HOST_PATH}`, mode);
  }
});

test('the sudo stand-in is an executable that exits non-zero with one line', async () => {
  // Bug: the stand-in is not executable or exits 0, so the agent believes sudo worked.
  const { deps, denyDir } = rig({ backend: 'codex' });
  await runAgent(request('dev'), deps);
  const shim = path.join(denyDir, 'sudo');
  assert.ok(fs.statSync(shim).mode & 0o100, 'owner-executable');
  const run = spawnSync(shim, ['id'], { encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.equal(`${run.stdout}${run.stderr}`.trim().split('\n').length, 1);
});

test('in sudo the host PATH is passed as it is and no stand-in is written', async () => {
  // Bug: sudo mode still shadows sudo, so the agents the owner gave sudo cannot use it.
  const { deps, privateDir, denyDir, seen } = rig({ backend: 'codex' });
  await setAgentMode(privateDir, 'dev', 'sudo');
  await runAgent(request('dev'), deps);
  const path = seen[0]?.options.env?.PATH;
  assert.ok(path === undefined || path === HOST_PATH);
  assert.equal(fs.existsSync(denyDir), false);
});

test('a run in full or sudo writes one log line naming the agent and the mode, and none holds the brief', async () => {
  // Bug: nothing shows who worked without a sandbox, or the log line carries the brief.
  const { deps, privateDir } = rig({ backend: 'codex' });
  await setAgentMode(privateDir, 'dev', 'sudo');
  await setAgentMode(privateDir, 'scout', 'full');
  const { logs } = await withCapturedLogs(async () => {
    await runAgent(request('dev'), deps);
    await runAgent(request('scout'), deps);
    await runAgent(request('server'), deps);
    await runAgent(request('watcher'), deps);
  });
  const lines = logs.filter((line) => line.mode !== undefined);
  assert.deepEqual(
    lines.map((line): [unknown, unknown] => [line.agent, line.mode]),
    [
      ['dev', 'sudo'],
      ['scout', 'full'],
    ]
  );
  assert.equal(JSON.stringify(logs).includes(BRIEF), false);
});

test('the line is written even when the run fails', async () => {
  // Bug: the line is written after the run, so a crashing unsandboxed run leaves no trace.
  const { deps, privateDir } = rig({ backend: 'codex' });
  await setAgentMode(privateDir, 'dev', 'sudo');
  const failing: RunDeps = {
    ...deps,
    backendFactory: (name) => ({ name, run: () => Promise.reject(new Error('boom')) }),
  };
  const { logs } = await withCapturedLogs(async () => {
    await runAgent(request('dev'), failing).catch(() => undefined);
  });
  assert.equal(logs.filter((line) => line.mode === 'sudo').length, 1);
});

test('opencode gets the one named key as OPENROUTER_API_KEY and no core key anywhere', async () => {
  // Bug: OpenCode inherits a core key from the environment, or the extra key it was enabled with is not passed.
  const { deps, seen } = rig({ backend: 'opencode', key: 'opencode' });
  await runAgent(request('scout'), deps);
  const env = seen[0]?.options.env ?? {};
  assert.equal(env.OPENROUTER_API_KEY, OC_SECRET);
  assert.equal(JSON.stringify(seen).includes(CORE_SECRET), false);
});

test('codex and claude get no key in their environment', async () => {
  // Bug: the OpenCode key leaks into a CLI backend that brings its own login.
  for (const backend of ['codex', 'claude'] as const) {
    const { deps, seen } = rig({ backend });
    await runAgent(request('scout'), deps);
    assert.equal(JSON.stringify(seen[0]?.options.env ?? {}).includes('sk-or'), false, backend);
  }
});

test('opencode enabled on a key that has since left the store is refused instead of run keyless', async () => {
  // Bug: the key was removed with "keys extra remove" and OpenCode starts with an empty key, or on a leftover one.
  const { deps, privateDir, seen } = rig({ backend: 'opencode', key: 'opencode' });
  const stored = readKeysFile(privateDir);
  writeKeysFile(privateDir, { ...stored, extra: {} });
  const result = await runAgent(request('scout'), deps);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'subharness-off');
  assert.equal(seen.length, 0);
});

// A backend lives in her private layer (spec 2026-11-02, PR 5, "Where a subharness lives"): with no test factory the
// run starts the binary of `<private>/subharness/<backend>/` with that folder's home, and is refused while it is absent.

/** The rig with the real backend factory and the host PATH of this process, so a shell script can run. */
function realRig(backend: 'codex' | 'claude') {
  const { privateDir, denyDir } = rig({ backend });
  const deps: RunDeps = { privateDir, denyDir, hostEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin' } };
  return { deps, privateDir };
}

test('an agent run is refused not-installed while the stored backend is not in her folder', async () => {
  // Catches: runAgent creates the backend by name, so the codex on the user's PATH runs on his own login.
  const { deps } = realRig('codex');
  const result = await runAgent(request('scout'), deps);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not-installed');
});

test('an agent run starts the binary in her folder with her home in its environment', async () => {
  // Catches: the seam passes the mode's PATH but drops the place's environment, so claude writes the user's ~/.claude.
  const { deps, privateDir } = realRig('claude');
  const place = subharnessPlace(privateDir, 'claude');
  fs.mkdirSync(path.dirname(place.binary), { recursive: true });
  fs.writeFileSync(place.binary, '#!/bin/sh\ncat >/dev/null\necho "home=$CLAUDE_CONFIG_DIR"\n', { mode: 0o755 });
  fs.chmodSync(place.binary, 0o755);
  const result = await runAgent(request('scout', { cwd: tempDir('nep-run-cwd-') }), deps);
  assert.equal(result.ok, true);
  assert.equal(result.text, `home=${place.env.CLAUDE_CONFIG_DIR ?? ''}`);
});

// Several subharnesses (spec 2026-11-02, PR 5): an agent runs through the backend `subharness.uses` names for it, else
// through the first connected one; a named backend that is not connected refuses the run.

/** A rig whose keys.json holds the list `backends` and the agents' `uses`. */
function listRig(
  backends: Array<'codex' | 'claude' | 'opencode'>,
  uses: Record<string, 'codex' | 'claude' | 'opencode'>
) {
  const r = rig({ backend: null });
  writeKeysFile(r.privateDir, {
    core: [{ name: 'core-1', value: CORE_SECRET }],
    extra: { opencode: OC_SECRET },
    // The old single field stays beside the list, as in a store written before it: the list is what counts.
    subharness: { backend: backends[0] ?? null, backends, uses, key: null, modes: {} },
  });
  return r;
}

test('an agent runs through the backend named for it when that one is connected', async () => {
  // Catches: the run always takes the first backend, so the watcher set to claude still runs on codex.
  const { deps, seen } = listRig(['codex', 'claude'], { watcher: 'claude' });
  await runAgent(request('watcher'), deps);
  assert.equal(seen[0]?.name, 'claude');
});

test('an agent with no backend named runs through the first connected one', async () => {
  // Catches: an agent with no entry in uses is refused, so errands stop the moment a second backend is connected.
  const { deps, seen } = listRig(['claude', 'codex'], { watcher: 'codex' });
  await runAgent(request('scout'), deps);
  assert.equal(seen[0]?.name, 'claude');
});

test('an agent whose named backend is not connected is refused subharness-off and no backend is made', async () => {
  // Catches: the run falls back to another connected backend, so an agent runs on a login the owner did not choose.
  const { deps, seen } = listRig(['codex'], { watcher: 'claude' });
  const result = await runAgent(request('watcher'), deps);
  assert.equal(result.error, 'subharness-off');
  assert.equal(seen.length, 0);
});
