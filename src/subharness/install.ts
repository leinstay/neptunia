// The install of one subharness backend into the persona's private layer (src/subharness/place.ts):
// `npm install --prefix <folder>` for `claude` and `codex`, a copy of one executable for `opencode`. The account commands
// (src/subharness/account.ts) and `neptunia setup` call it with a runner that starts npm; the runner is injected, so the tests reach no
// npm and no network. npm runs with PATH, HOME, TMPDIR and the locale of the host and nothing else, so no install
// script sees a model key or the bot's token. The outcome is one line; npm's log never leaves this file.
//
// Versions are pinned. A first install takes `PINNED_VERSIONS`, and `version.json` beside the binary records what is
// installed with its integrity; a persona restored to another machine reinstalls the version it recorded, whatever
// this engine ships. Only `updateSubharness` and `rollbackSubharness` change it, on the owner's explicit command, and
// both leave the backend's `home/` (login and native sessions) alone. An install or an update holds the backend's lock
// (src/subharness/activity.ts), so npm never moves the binary while a login writes the home.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BackendName } from '../agent-runner/profiles.ts';
import { errorFields } from '../error-fields.ts';
import { scalarText } from '../tools/types.ts';
import { BackendLocked, backendLocked, withBackendLock } from './activity.ts';
import { isInstalled, subharnessPlace } from './place.ts';

/** What a command gave back. */
export type InstallRunResult = { code: number; stdout: string; stderr: string };

/** Runs one command with exactly `options.env` as its environment. May reject (npm is not on PATH). */
export type InstallRun = (
  command: string,
  args: ReadonlyArray<string>,
  options: { env: Record<string, string> }
) => Promise<InstallRunResult>;

export type InstallInput = {
  privateDir: string;
  backend: BackendName;
  /** opencode only: the executable copied into her folder */
  opencodeSource?: string;
  /** the environment the install runs in is built from this */
  hostEnv: Readonly<Record<string, string | undefined>>;
};

export type InstallOutcome = { state: 'done' | 'already' | 'failed'; detail: string };

/** The npm package of each backend npm installs. */
const PACKAGES: Readonly<Partial<Record<BackendName, string>>> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
};

/** The versions a first install takes: the newest on the npm registry and in use on the development server, 2026-11-03. */
const PINNED_VERSIONS: Readonly<Partial<Record<BackendName, string>>> = {
  claude: '2.1.317',
  codex: '0.164.0',
};

/** The file beside the binary that records the installed version. */
const SELECTION_FILE = 'version.json';
/** The previous install, kept for a rollback. */
const PREVIOUS_DIR = 'previous';
/** The install in force while an update runs; it becomes `previous/` only once the update succeeded. */
const OUTGOING_DIR = '.outgoing';
/** What npm or the copy of opencode put in a backend's folder; `home/` is never one of these. */
const INSTALLED_ENTRIES = ['node_modules', 'bin', 'package.json', 'package-lock.json'] as const;

type Selection = { version: string; integrity: string | null; previous?: string };

/** The host variables npm inherits. */
const PASSED_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'] as const;

const failed = (detail: string): InstallOutcome => ({ state: 'failed', detail });

function npmEnvOf(hostEnv: InstallInput['hostEnv']): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED_ENV) {
    const value = hostEnv[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** The first line of npm's stderr that says something, or its exit code. */
function firstLineOf(result: InstallRunResult): string {
  const line = result.stderr
    .split('\n')
    .map((one) => one.trim())
    .find((one) => one !== '');
  return line ?? `npm exited with ${result.code}`;
}

function copyOpencode(input: InstallInput): InstallOutcome {
  const source = input.opencodeSource;
  if (source === undefined || source === '') return failed('opencode needs the path of its executable to copy');
  if (!fs.existsSync(source)) return failed(`${source} does not exist`);
  const { binary } = subharnessPlace(input.privateDir, 'opencode');
  try {
    fs.mkdirSync(path.dirname(binary), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, binary);
    fs.chmodSync(binary, 0o755);
  } catch (err) {
    return failed(`copying ${source}: ${scalarText(errorFields(err).code ?? 'error')}`);
  }
  return { state: 'done', detail: `opencode copied from ${source} to ${binary}` };
}

function readSelection(privateDir: string, backend: BackendName): Selection | null {
  try {
    const value: unknown = JSON.parse(
      fs.readFileSync(path.join(subharnessPlace(privateDir, backend).dir, SELECTION_FILE), 'utf8')
    );
    if (typeof value !== 'object' || value === null || !('version' in value) || typeof value.version !== 'string')
      return null;
    return value as Selection;
  } catch {
    return null;
  }
}

function writeSelection(privateDir: string, backend: BackendName, selection: Selection): void {
  const file = path.join(subharnessPlace(privateDir, backend).dir, SELECTION_FILE);
  fs.writeFileSync(file, `${JSON.stringify(selection, null, 2)}\n`);
}

/** The integrity npm wrote into the lock for `pkg`, or null when the lock does not say. */
function lockedIntegrity(dir: string, pkg: string): string | null {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, { integrity?: string }>;
    };
    const entry = lock.packages?.[`node_modules/${pkg}`];
    return entry?.integrity ?? null;
  } catch {
    return null;
  }
}

function sha256Of(file: string): string {
  return `sha256-${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

/** codex reads this from its home; the other two take a variable (src/subharness/place.ts). */
function disableCodexUpdates(privateDir: string): void {
  const home = subharnessPlace(privateDir, 'codex').env.CODEX_HOME;
  if (home === undefined) return;
  const file = path.join(home, 'config.toml');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (text.includes('check_for_update_on_startup')) return;
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // A top-level key has to come before the first table of the file.
  fs.writeFileSync(file, `check_for_update_on_startup = false\n${text}`);
}

/** Runs npm for `pkg@version` into the backend's folder, exact in its lock. */
async function npmInstall(input: InstallInput, pkg: string, version: string, run: InstallRun): Promise<string | null> {
  const place = subharnessPlace(input.privateDir, input.backend);
  let result: InstallRunResult;
  try {
    fs.mkdirSync(place.dir, { recursive: true, mode: 0o700 });
    result = await run('npm', ['install', '--prefix', place.dir, '--save-exact', `${pkg}@${version}`], {
      env: npmEnvOf(input.hostEnv),
    });
  } catch (err) {
    return `npm could not run: ${scalarText(errorFields(err).code ?? 'error')}`;
  }
  if (result.code !== 0) return firstLineOf(result);
  if (!isInstalled(input.privateDir, input.backend)) return `npm finished but ${place.binary} is not there`;
  return null;
}

/** Moves every installed entry of `from` to `to`; `home/` and the selection stay where they are. */
function moveInstalled(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const entry of INSTALLED_ENTRIES) {
    if (fs.existsSync(path.join(from, entry))) fs.renameSync(path.join(from, entry), path.join(to, entry));
  }
}

/** A crash in the middle of an update left the old install in `outgoing`: it goes back when nothing replaced it. */
function recoverOutgoing(privateDir: string, backend: BackendName, outgoing: string): void {
  if (!fs.existsSync(outgoing)) return;
  if (!isInstalled(privateDir, backend)) moveInstalled(outgoing, subharnessPlace(privateDir, backend).dir);
  fs.rmSync(outgoing, { recursive: true, force: true });
}

/** The update itself, under the backend's lock. */
async function updateLocked(input: InstallInput & { version: string }, run: InstallRun): Promise<InstallOutcome> {
  const { privateDir, backend, version } = input;
  const place = subharnessPlace(privateDir, backend);
  const before = readSelection(privateDir, backend);
  const previousDir = path.join(place.dir, PREVIOUS_DIR);
  const outgoing = path.join(place.dir, OUTGOING_DIR);
  recoverOutgoing(privateDir, backend, outgoing);
  moveInstalled(place.dir, outgoing);
  const pkg = PACKAGES[backend];
  const problem =
    pkg === undefined
      ? copyOpencode(input).state === 'failed'
        ? 'the opencode executable could not be copied'
        : null
      : await npmInstall(input, pkg, version, run);
  if (problem !== null) {
    for (const entry of INSTALLED_ENTRIES) fs.rmSync(path.join(place.dir, entry), { recursive: true, force: true });
    moveInstalled(outgoing, place.dir);
    fs.rmSync(outgoing, { recursive: true, force: true });
    return failed(problem);
  }
  fs.rmSync(previousDir, { recursive: true, force: true });
  fs.renameSync(outgoing, previousDir);
  const integrity = pkg === undefined ? sha256Of(place.binary) : lockedIntegrity(place.dir, pkg);
  writeSelection(privateDir, backend, {
    version,
    integrity,
    ...(before === null ? {} : { previous: before.version }),
  });
  return { state: 'done', detail: `${backend} is now ${version}, the previous install is kept for a rollback` };
}

/** What `work` came to under the backend's lock; a lock that stays taken is a failed change. */
async function locked(
  privateDir: string,
  backend: BackendName,
  work: () => Promise<InstallOutcome>
): Promise<InstallOutcome> {
  try {
    return await withBackendLock(privateDir, backend, work);
  } catch (error) {
    if (error instanceof BackendLocked) return failed(error.message);
    throw error;
  }
}

/**
 * The owner's explicit update: the install in force moves aside, `input.version` is installed, and a failure moves the
 * old one back and leaves the rollback of the last update as it was. A success makes the old one the rollback. opencode
 * takes a new executable through `input.opencodeSource`.
 */
export function updateSubharness(input: InstallInput & { version: string }, run: InstallRun): Promise<InstallOutcome> {
  return locked(input.privateDir, input.backend, () => updateLocked(input, run));
}

/** Puts the install kept by the last update back. Fails when no update left one. */
export function rollbackSubharness(privateDir: string, backend: BackendName): InstallOutcome {
  if (backendLocked(privateDir, backend)) return failed(`another change of ${backend} is running`);
  const place = subharnessPlace(privateDir, backend);
  const previousDir = path.join(place.dir, PREVIOUS_DIR);
  const selection = readSelection(privateDir, backend);
  if (!fs.existsSync(previousDir) || selection?.previous === undefined)
    return failed(`${backend} has no previous install to go back to`);
  for (const entry of INSTALLED_ENTRIES) fs.rmSync(path.join(place.dir, entry), { recursive: true, force: true });
  moveInstalled(previousDir, place.dir);
  fs.rmSync(previousDir, { recursive: true, force: true });
  const pkg = PACKAGES[backend];
  writeSelection(privateDir, backend, {
    version: selection.previous,
    integrity: pkg === undefined ? sha256Of(place.binary) : lockedIntegrity(place.dir, pkg),
  });
  return { state: 'done', detail: `${backend} is back on ${selection.previous}` };
}

/** The install itself, under the backend's lock. */
async function installLocked(input: InstallInput, run: InstallRun): Promise<InstallOutcome> {
  const { privateDir, backend } = input;
  const place = subharnessPlace(privateDir, backend);
  if (isInstalled(privateDir, backend)) {
    if (backend === 'codex') disableCodexUpdates(privateDir);
    return { state: 'already', detail: `${backend} is in ${place.dir}` };
  }
  const pkg = PACKAGES[backend];
  if (pkg === undefined) {
    const copied = copyOpencode(input);
    if (copied.state === 'done')
      writeSelection(privateDir, backend, { version: sha256Of(place.binary), integrity: sha256Of(place.binary) });
    return copied;
  }
  // The version this persona recorded wins over the one this engine ships, so a restore never upgrades her backend.
  const version = readSelection(privateDir, backend)?.version ?? PINNED_VERSIONS[backend];
  if (version === undefined) return failed(`${backend} has no pinned version`);
  const problem = await npmInstall(input, pkg, version, run);
  if (problem !== null) return failed(problem);
  writeSelection(privateDir, backend, { version, integrity: lockedIntegrity(place.dir, pkg) });
  if (backend === 'codex') disableCodexUpdates(privateDir);
  return { state: 'done', detail: `${pkg} installed in ${place.dir}` };
}

/** Installs `input.backend` into its place; `already` when it is there. Never rejects. */
export function installSubharness(input: InstallInput, run: InstallRun): Promise<InstallOutcome> {
  return locked(input.privateDir, input.backend, () => installLocked(input, run));
}
