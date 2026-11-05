// The file that carries a run's system instructions (src/agent-runner/backend.ts, `BackendRunOptions.system`): the
// deployment's private preamble lands on disk for the length of one run, so it is mode 600 in a folder of mode 700,
// and it is gone when the run ends, whether the child succeeded, failed or never started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import type { spawn } from 'node:child_process';
import { createBackend } from '../src/agent-runner/backend.ts';
import type { BackendName } from '../src/agent-runner/backend.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { tempDir } from './fixtures/tmp.ts';

const SYSTEM = 'PRIVATE-PREAMBLE: the deployment speaks first.';
const BACKENDS: ReadonlyArray<BackendName> = ['claude', 'codex', 'opencode'];

/** The path of the file that holds the system instructions, as the child of `name` is told it. */
function systemPathOf(name: BackendName, args: ReadonlyArray<string>, env: Record<string, string>): string {
  if (name === 'claude') return args[args.indexOf('--system-prompt-file') + 1];
  if (name === 'codex') {
    const setting = args.find((value) => value.startsWith('model_instructions_file=')) ?? '';
    return JSON.parse(setting.slice('model_instructions_file='.length)) as string;
  }
  return env.OPENCODE_CONFIG;
}

type Seen = { file: string; fileMode: number; dirMode: number; holds: boolean };

/** A spawn that records the system file while the child runs, then exits with `exitCode`, or throws when `refuse`. */
function fakeSpawn(name: BackendName, seen: Array<Seen>, { exitCode, refuse }: { exitCode: number; refuse: boolean }) {
  const impl = (_binary: string, args: Array<string>, options: { env: Record<string, string> }) => {
    const file = systemPathOf(name, args, options.env);
    seen.push({
      file,
      fileMode: fs.statSync(file).mode & 0o777,
      dirMode: fs.statSync(path.dirname(file)).mode & 0o777,
      holds: fs.readFileSync(file, 'utf8').includes(SYSTEM),
    });
    if (refuse) throw Object.assign(new Error('spawn E2BIG'), { code: 'E2BIG' });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      pid: undefined,
      kill: () => true,
    });
    child.stdin.resume();
    child.stdin.on('end', () => setImmediate(() => child.emit('close', exitCode)));
    return child;
  };
  return wrongly<typeof spawn>(impl);
}

/** One run of `name` with the system instructions, on a fake child that exits or refuses as told. */
async function runOnce(name: BackendName, how: { exitCode: number; refuse: boolean }) {
  const base = tempDir('nep-system-file-');
  const binary = path.join(base, 'fake-binary');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const seen: Array<Seen> = [];
  const backend = createBackend(name, { binary, spawnImpl: fakeSpawn(name, seen, how) });
  const result = await backend.run('the task', { cwd: base, timeoutMs: 20_000, system: SYSTEM });
  assert.equal(seen.length, 1, 'the run reached the spawn once');
  return { result, file: seen[0] };
}

for (const name of BACKENDS) {
  test(`${name}: the system file is mode 600 in a folder of mode 700, and gone after a run that succeeded`, async () => {
    // Catches: the preamble written with the default umask (readable by other users of the host), or into a shared
    // folder, or left on disk once the run is over.
    const { file } = await runOnce(name, { exitCode: 0, refuse: false });
    assert.equal(file.holds, true, 'the file holds the system instructions');
    assert.equal(file.fileMode, 0o600);
    assert.equal(file.dirMode, 0o700);
    assert.equal(fs.existsSync(file.file), false, 'the file is removed');
    assert.equal(fs.existsSync(path.dirname(file.file)), false, 'its folder is removed');
  });

  test(`${name}: the system file is gone after a run whose child failed`, async () => {
    // Catches: the cleanup runs only on the success path, so every failed run leaves the preamble behind.
    const { result, file } = await runOnce(name, { exitCode: 1, refuse: false });
    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(path.dirname(file.file)), false);
  });

  test(`${name}: the system file is gone after a run whose spawn was refused`, async () => {
    // Catches: a spawn that throws skips the cleanup, so the preamble stays when the child never started.
    const { result, file } = await runOnce(name, { exitCode: 0, refuse: true });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'spawn');
    assert.equal(fs.existsSync(path.dirname(file.file)), false);
  });
}
