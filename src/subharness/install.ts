// The install of one subharness backend into the persona's private layer (src/subharness/place.ts):
// `npm install --prefix <folder>` for `claude` and `codex`, a copy of one executable for `opencode`. `neptunia setup
// subharness` (bin/neptunia.ts) calls it with a runner that starts npm; the runner is injected, so the tests reach no
// npm and no network. npm runs with PATH, HOME, TMPDIR and the locale of the host and nothing else, so no install
// script sees a model key or the bot's token. The outcome is one line; npm's log never leaves this file.

import fs from 'node:fs';
import path from 'node:path';
import type { BackendName } from '../agent-runner/profiles.ts';
import { errorFields } from '../error-fields.ts';
import { scalarText } from '../tools/types.ts';
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

/** Installs `input.backend` into its place; `already` when it is there. Never rejects. */
export async function installSubharness(input: InstallInput, run: InstallRun): Promise<InstallOutcome> {
  const { privateDir, backend } = input;
  const place = subharnessPlace(privateDir, backend);
  if (isInstalled(privateDir, backend)) return { state: 'already', detail: `${backend} is in ${place.dir}` };
  const pkg = PACKAGES[backend];
  if (pkg === undefined) return copyOpencode(input);
  let result: InstallRunResult;
  try {
    fs.mkdirSync(place.dir, { recursive: true, mode: 0o700 });
    result = await run('npm', ['install', '--prefix', place.dir, pkg], { env: npmEnvOf(input.hostEnv) });
  } catch (err) {
    return failed(`npm could not run: ${scalarText(errorFields(err).code ?? 'error')}`);
  }
  if (result.code !== 0) return failed(firstLineOf(result));
  if (!isInstalled(privateDir, backend)) return failed(`npm finished but ${place.binary} is not there`);
  return { state: 'done', detail: `${pkg} installed in ${place.dir}` };
}
