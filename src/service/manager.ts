// The service manager as the engine's commands reach it: which scope this installation uses and the argv of each call.
// Every command goes through the injected `run`, so no test touches systemd.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UNIT_SCOPE_ENV } from '../agent-runner/profiles.ts';
import { systemctlOf } from '../setup/install.ts';
import type { RunResult } from '../setup/install.ts';

export const CORE_UNIT = 'neptunia-core.service';

export type Environment = Readonly<Record<string, string | undefined>>;
export type RunManager = (command: string, args: ReadonlyArray<string>) => Promise<RunResult>;

/** Where the user manager's units live. */
const userUnitDir = (env: Environment): string =>
  path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');

/** The folder of the units of the scope in force. */
export const unitFolder = (env: Environment): string =>
  unitScope(env) === 'user' ? userUnitDir(env) : '/etc/systemd/system';

/** `NEPTUNIA_UNIT_SCOPE` when it says, else the user manager when the core's unit is installed under it. */
export function unitScope(env: Environment): 'user' | 'system' {
  const said = env[UNIT_SCOPE_ENV];
  if (said === 'user' || said === 'system') return said;
  return fs.existsSync(path.join(userUnitDir(env), CORE_UNIT)) ? 'user' : 'system';
}

/** The `systemctl` of the scope for a call that changes something: through `sudo` in the system scope. */
export const managerCall = (env: Environment, ...args: Array<string>): [string, Array<string>] =>
  systemctlOf({ system: unitScope(env) === 'system' }, ...args);

/** The `systemctl` of the scope for a read, which never goes through `sudo`. */
export const managerRead = (env: Environment, ...args: Array<string>): [string, Array<string>] =>
  unitScope(env) === 'user' ? ['systemctl', ['--user', ...args]] : ['systemctl', args];
