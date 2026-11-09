// The service manager as the engine's commands reach it: which scope this installation uses, the argv of each call,
// and the start of the watcher's oneshot unit for `/doctor watcher run`, without waiting for its run. Every command goes
// through the injected `run`, so no test touches systemd.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UNIT_SCOPE_ENV } from '../agent-runner/profiles.ts';
import { systemctlOf, whyFailed } from '../setup/install.ts';
import type { RunResult } from '../setup/install.ts';

export const WATCHER_WORKER = 'neptunia-watcher.service';
export const CORE_UNIT = 'neptunia-core.service';

export type Environment = Readonly<Record<string, string | undefined>>;
export type RunManager = (command: string, args: ReadonlyArray<string>) => Promise<RunResult>;

/** Where the user manager's units live. */
const userUnitDir = (env: Environment): string =>
  path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');

/** The folder of the units of the scope in force. */
export const unitFolder = (env: Environment): string =>
  unitScope(env) === 'user' ? userUnitDir(env) : '/etc/systemd/system';

/** `NEPTUNIA_UNIT_SCOPE` when it says, else the user manager when the core's or the watcher's unit is installed under it. */
export function unitScope(env: Environment): 'user' | 'system' {
  const said = env[UNIT_SCOPE_ENV];
  if (said === 'user' || said === 'system') return said;
  const installed = [CORE_UNIT, WATCHER_WORKER].some((unit) => fs.existsSync(path.join(userUnitDir(env), unit)));
  return installed ? 'user' : 'system';
}

/** The `systemctl` of the scope for a call that changes something: through `sudo` in the system scope. */
export const managerCall = (env: Environment, ...args: Array<string>): [string, Array<string>] =>
  systemctlOf({ system: unitScope(env) === 'system' }, ...args);

/** The `systemctl` of the scope for a read, which never goes through `sudo`. */
export const managerRead = (env: Environment, ...args: Array<string>): [string, Array<string>] =>
  unitScope(env) === 'user' ? ['systemctl', ['--user', ...args]] : ['systemctl', args];

/** Starts the watcher's unit without waiting for it, since a oneshot's start lasts its whole run; the reason when refused. */
export async function startWorker(run: RunManager, env: Environment): Promise<string | null> {
  const [command, args] = managerCall(env, 'start', '--no-block', WATCHER_WORKER);
  const done = await run(command, args);
  return done.code === 0 ? null : whyFailed(done);
}
