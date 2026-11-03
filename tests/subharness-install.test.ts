// src/subharness/install.ts: the install of one subharness backend into her private layer (spec 2026-11-02, PR 5,
// "Where a subharness lives"). claude and codex come from `npm install --prefix <folder>`, opencode is one executable
// copied in. The runner is a fake that records each command and, standing in for npm, may leave the binary behind; no
// npm and no network are reached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { installSubharness, rollbackSubharness, updateSubharness } from '../src/subharness/install.ts';
import type { InstallRun, InstallRunResult } from '../src/subharness/install.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import type { BackendName } from '../src/agent-runner/profiles.ts';
import { tempDir } from './fixtures/tmp.ts';

const HOST_PATH = '/opt/node/bin:/usr/bin:/bin';
const MODEL_SECRET = 'sk-or-v1-host-secret-0123456789';
const TOKEN_SECRET = 'discord-token-secret-abcdef';
const HOST_ENV = {
  PATH: HOST_PATH,
  HOME: '/home/alice',
  OPENROUTER_API_KEY: MODEL_SECRET,
  DISCORD_TOKEN: TOKEN_SECRET,
};

type Call = { command: string; args: Array<string>; env: Record<string, string> };

/** Writes an executable at `file`, as npm does for a package's bin. */
function leaveBinary(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

/** A fake runner: records the call, leaves the backend's binary when `leaves` is set, answers `result`. */
function fakeRun(
  privateDir: string,
  backend: BackendName,
  options: { leaves: boolean; result?: InstallRunResult; rejects?: boolean }
): { run: InstallRun; calls: Array<Call> } {
  const calls: Array<Call> = [];
  const run: InstallRun = (command, args, given) => {
    calls.push({ command, args: [...args], env: given.env });
    if (options.rejects === true)
      return Promise.reject(Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }));
    if (options.leaves) leaveBinary(subharnessPlace(privateDir, backend).binary);
    return Promise.resolve(options.result ?? { code: 0, stdout: 'added 3 packages', stderr: '' });
  };
  return { run, calls };
}

test('claude is installed with npm install --prefix into her folder and answers done', async () => {
  // Catches: the install runs a global npm install, so the binary lands on the user's PATH and not in her place.
  const privateDir = tempDir('nep-install-sh-');
  const { run, calls } = fakeRun(privateDir, 'claude', { leaves: true });
  const outcome = await installSubharness({ privateDir, backend: 'claude', hostEnv: HOST_ENV }, run);
  assert.equal(outcome.state, 'done');
  assert.deepEqual(
    calls.map((call) => [call.command, call.args]),
    [
      [
        'npm',
        [
          'install',
          '--prefix',
          path.join(privateDir, 'subharness', 'claude'),
          '--save-exact',
          '@anthropic-ai/claude-code@2.1.317',
        ] /* Changed: the install takes the pinned version. */,
      ],
    ]
  );
});

test('codex is installed with npm install --prefix of @openai/codex into its own folder', async () => {
  // Catches: codex is installed under the claude folder or from the wrong package.
  const privateDir = tempDir('nep-install-sh-');
  const { run, calls } = fakeRun(privateDir, 'codex', { leaves: true });
  const outcome = await installSubharness({ privateDir, backend: 'codex', hostEnv: HOST_ENV }, run);
  assert.equal(outcome.state, 'done');
  assert.deepEqual(calls[0]?.args, [
    'install',
    '--prefix',
    path.join(privateDir, 'subharness', 'codex'),
    '--save-exact',
    // Changed: the install takes the pinned version.
    '@openai/codex@0.164.0',
  ]);
});

test('an installed backend answers already and runs nothing', async () => {
  // Catches: a rerun of setup reinstalls codex every time, over the network, and may upgrade it under a running agent.
  const privateDir = tempDir('nep-install-sh-');
  leaveBinary(subharnessPlace(privateDir, 'codex').binary);
  const { run, calls } = fakeRun(privateDir, 'codex', { leaves: true });
  const outcome = await installSubharness({ privateDir, backend: 'codex', hostEnv: HOST_ENV }, run);
  assert.equal(outcome.state, 'already');
  assert.deepEqual(calls, []);
});

test('npm runs with PATH and without any key or token of the host environment', async () => {
  // Catches: npm inherits the core's environment and a package's install script reads a model key or the bot token.
  const privateDir = tempDir('nep-install-sh-');
  const { run, calls } = fakeRun(privateDir, 'claude', { leaves: true });
  await installSubharness({ privateDir, backend: 'claude', hostEnv: HOST_ENV }, run);
  const env = calls[0]?.env ?? {};
  assert.equal(env.PATH, HOST_PATH);
  const seen = JSON.stringify(env);
  assert.equal(seen.includes(MODEL_SECRET), false);
  assert.equal(seen.includes(TOKEN_SECRET), false);
});

test('a failed npm answers failed with the first line of its error', async () => {
  // Catches: a failed install reads as done, or the whole npm log, which may hold a registry token, is shown.
  const privateDir = tempDir('nep-install-sh-');
  const { run } = fakeRun(privateDir, 'codex', {
    leaves: false,
    result: { code: 1, stdout: '', stderr: 'npm error code E404\nnpm error 404 Not Found\nnpm error a full log' },
  });
  const outcome = await installSubharness({ privateDir, backend: 'codex', hostEnv: HOST_ENV }, run);
  assert.equal(outcome.state, 'failed');
  assert.ok(outcome.detail.includes('E404'), outcome.detail);
  assert.equal(outcome.detail.includes('\n'), false);
  assert.equal(outcome.detail.includes('a full log'), false);
});

test('npm that exits 0 without leaving the binary answers failed', async () => {
  // Catches: the install trusts the exit code, reports done, and every later run is refused not-installed.
  const privateDir = tempDir('nep-install-sh-');
  const { run } = fakeRun(privateDir, 'claude', { leaves: false });
  const outcome = await installSubharness({ privateDir, backend: 'claude', hostEnv: HOST_ENV }, run);
  assert.equal(outcome.state, 'failed');
  assert.notEqual(outcome.detail, '');
});

test('a runner that cannot start npm answers failed instead of throwing', async () => {
  // Catches: npm missing from PATH throws out of setup and the steps after it never run or report.
  const privateDir = tempDir('nep-install-sh-');
  const { run } = fakeRun(privateDir, 'codex', { leaves: false, rejects: true });
  const outcome = await installSubharness({ privateDir, backend: 'codex', hostEnv: HOST_ENV }, run);
  assert.equal(outcome.state, 'failed');
  assert.notEqual(outcome.detail, '');
});

test('opencode is the given executable copied into her folder as an executable file of its own', async () => {
  // Catches: the binary is linked to the user's own opencode, which he upgrades or removes, or it is copied without its mode.
  const privateDir = tempDir('nep-install-sh-');
  const source = path.join(tempDir('nep-install-src-'), 'opencode');
  fs.writeFileSync(source, '#!/bin/sh\necho opencode\n', { mode: 0o755 });
  fs.chmodSync(source, 0o755);
  const { run, calls } = fakeRun(privateDir, 'opencode', { leaves: false });
  const outcome = await installSubharness(
    { privateDir, backend: 'opencode', opencodeSource: source, hostEnv: HOST_ENV },
    run
  );
  const { binary } = subharnessPlace(privateDir, 'opencode');
  assert.equal(outcome.state, 'done');
  assert.ok(fs.lstatSync(binary).isFile());
  assert.equal(fs.readFileSync(binary, 'utf8'), '#!/bin/sh\necho opencode\n');
  assert.ok(fs.statSync(binary).mode & 0o100);
  assert.deepEqual(calls, []);
});

test('opencode with a source path that does not exist answers failed naming the path', async () => {
  // Catches: a wrong path throws ENOENT out of setup, or reports done with nothing in her folder.
  const privateDir = tempDir('nep-install-sh-');
  const source = path.join(tempDir('nep-install-src-'), 'no-such-opencode');
  const { run } = fakeRun(privateDir, 'opencode', { leaves: false });
  const outcome = await installSubharness(
    { privateDir, backend: 'opencode', opencodeSource: source, hostEnv: HOST_ENV },
    run
  );
  assert.equal(outcome.state, 'failed');
  assert.ok(outcome.detail.includes(source), outcome.detail);
  assert.equal(fs.existsSync(subharnessPlace(privateDir, 'opencode').binary), false);
});

test('opencode with no source path answers failed', async () => {
  // Catches: opencode falls back to whatever opencode is on PATH, the user's own, which is never hers.
  const privateDir = tempDir('nep-install-sh-');
  const { run, calls } = fakeRun(privateDir, 'opencode', { leaves: false });
  const outcome = await installSubharness({ privateDir, backend: 'opencode', hostEnv: HOST_ENV }, run);
  assert.equal(outcome.state, 'failed');
  assert.deepEqual(calls, []);
});

/** A fake npm: leaves the binary with `version` in it and a lock naming the version and its integrity. */
function versionedRun(privateDir: string, backend: 'claude' | 'codex', result?: InstallRunResult): InstallRun {
  return (_command, args) => {
    if (result !== undefined) return Promise.resolve(result);
    const place = subharnessPlace(privateDir, backend);
    const spec = args.at(-1) ?? '';
    const at = spec.lastIndexOf('@');
    const [pkg, version] = [spec.slice(0, at), spec.slice(at + 1)];
    leaveBinary(place.binary);
    fs.writeFileSync(place.binary, `#!/bin/sh\necho ${version}\n`);
    fs.writeFileSync(
      path.join(place.dir, 'package-lock.json'),
      JSON.stringify({ packages: { [`node_modules/${pkg}`]: { version, integrity: `sha512-of-${version}` } } })
    );
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
}

function selectionOf(privateDir: string, backend: BackendName) {
  return JSON.parse(
    fs.readFileSync(path.join(subharnessPlace(privateDir, backend).dir, 'version.json'), 'utf8')
  ) as Record<string, unknown>;
}

test('a fresh install takes the pinned version, never the latest, and records it with its integrity', async () => {
  // Bug: `npm install <pkg>` takes whatever is newest, so two installs of one engine run different backends.
  const privateDir = tempDir('nep-pin-');
  const calls: Array<Array<string>> = [];
  const npm = versionedRun(privateDir, 'claude');
  await installSubharness({ privateDir, backend: 'claude', hostEnv: HOST_ENV }, (command, args, options) => {
    calls.push([...args]);
    return npm(command, args, options);
  });
  const spec = calls[0]?.at(-1) ?? '';
  assert.match(spec, /^@anthropic-ai\/claude-code@\d+\.\d+\.\d+$/);
  const selection = selectionOf(privateDir, 'claude');
  assert.equal(`@anthropic-ai/claude-code@${String(selection.version)}`, spec);
  assert.equal(selection.integrity, `sha512-of-${String(selection.version)}`);
});

test('a restored persona installs the version it recorded, not the version this engine ships', async () => {
  // Bug: a reinstall or a setup rerun silently upgrades her backend to the engine's newer pin.
  const privateDir = tempDir('nep-pin-');
  const place = subharnessPlace(privateDir, 'codex');
  fs.mkdirSync(place.dir, { recursive: true });
  fs.writeFileSync(path.join(place.dir, 'version.json'), JSON.stringify({ version: '0.1.0', integrity: 'x' }));
  const specs: Array<string> = [];
  const npm = versionedRun(privateDir, 'codex');
  await installSubharness({ privateDir, backend: 'codex', hostEnv: HOST_ENV }, (command, args, options) => {
    specs.push(args.at(-1) ?? '');
    return npm(command, args, options);
  });
  assert.deepEqual(specs, ['@openai/codex@0.1.0']);
});

test('an explicit update replaces the binary, keeps the previous one and leaves her sessions alone', async () => {
  // Bug: an update wipes the backend's folder, and with it the login and the native sessions under home/.
  const privateDir = tempDir('nep-pin-');
  const place = subharnessPlace(privateDir, 'claude');
  await installSubharness({ privateDir, backend: 'claude', hostEnv: HOST_ENV }, versionedRun(privateDir, 'claude'));
  const pinned = selectionOf(privateDir, 'claude').version;
  const session = path.join(place.dir, 'home', 'projects', 'one.jsonl');
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, 'kept');
  const outcome = await updateSubharness(
    { privateDir, backend: 'claude', hostEnv: HOST_ENV, version: '9.9.9' },
    versionedRun(privateDir, 'claude')
  );
  assert.equal(outcome.state, 'done');
  assert.equal(selectionOf(privateDir, 'claude').version, '9.9.9');
  assert.equal(selectionOf(privateDir, 'claude').previous, pinned);
  assert.match(fs.readFileSync(place.binary, 'utf8'), /9\.9\.9/);
  assert.equal(fs.readFileSync(session, 'utf8'), 'kept');
});

test('a failed update leaves the version in force working', async () => {
  // Bug: npm fails halfway and she has no backend at all until someone repairs it by hand.
  const privateDir = tempDir('nep-pin-');
  const place = subharnessPlace(privateDir, 'claude');
  await installSubharness({ privateDir, backend: 'claude', hostEnv: HOST_ENV }, versionedRun(privateDir, 'claude'));
  const before = fs.readFileSync(place.binary, 'utf8');
  const selection = selectionOf(privateDir, 'claude');
  const outcome = await updateSubharness(
    { privateDir, backend: 'claude', hostEnv: HOST_ENV, version: '9.9.9' },
    versionedRun(privateDir, 'claude', { code: 1, stdout: '', stderr: 'npm ERR! 404' })
  );
  assert.equal(outcome.state, 'failed');
  assert.equal(fs.readFileSync(place.binary, 'utf8'), before);
  assert.deepEqual(selectionOf(privateDir, 'claude'), selection);
});

test('a rollback restores the previous binary and version and leaves her sessions alone', async () => {
  // Bug: rolling a bad update back loses the sessions written since, or keeps recording the bad version.
  const privateDir = tempDir('nep-pin-');
  const place = subharnessPlace(privateDir, 'claude');
  await installSubharness({ privateDir, backend: 'claude', hostEnv: HOST_ENV }, versionedRun(privateDir, 'claude'));
  const pinned = selectionOf(privateDir, 'claude').version;
  await updateSubharness(
    { privateDir, backend: 'claude', hostEnv: HOST_ENV, version: '9.9.9' },
    versionedRun(privateDir, 'claude')
  );
  const session = path.join(place.dir, 'home', 'new.jsonl');
  fs.mkdirSync(path.dirname(session), { recursive: true });
  fs.writeFileSync(session, 'written after the update');
  assert.equal(rollbackSubharness(privateDir, 'claude').state, 'done');
  assert.equal(selectionOf(privateDir, 'claude').version, pinned);
  assert.match(fs.readFileSync(place.binary, 'utf8'), new RegExp(String(pinned).replaceAll('.', '\\.')));
  assert.equal(fs.readFileSync(session, 'utf8'), 'written after the update');
  assert.equal(rollbackSubharness(privateDir, 'claude').state, 'failed');
});

test('a run of each backend carries the control that keeps it from updating itself', async () => {
  // Bug: the pin holds at install, then the CLI replaces itself in the background at its next start.
  const privateDir = tempDir('nep-pin-');
  assert.equal(subharnessPlace(privateDir, 'claude').env.DISABLE_AUTOUPDATER, '1');
  assert.equal(subharnessPlace(privateDir, 'opencode').env.OPENCODE_DISABLE_AUTOUPDATE, '1');
  await installSubharness({ privateDir, backend: 'codex', hostEnv: HOST_ENV }, versionedRun(privateDir, 'codex'));
  const config = path.join(subharnessPlace(privateDir, 'codex').env.CODEX_HOME ?? '', 'config.toml');
  assert.match(fs.readFileSync(config, 'utf8'), /check_for_update_on_startup = false/);
});
