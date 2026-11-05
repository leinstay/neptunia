// The service manager as the watcher's commands reach it: which scope this installation uses, the argv of each call, the
// reads of `status`, and the render of the one timer. Enable and disable move the timer, status reads the worker with
// `is-active`, and only `trigger` starts the worker, without waiting for its run. Every command goes through the injected
// `run`, so no test touches systemd.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UNIT_SCOPE_ENV } from '../agent-runner/profiles.ts';
import { installUnits, systemctlOf, unitDirOf, whyFailed } from '../setup/install.ts';
import type { RunResult, UnitTarget } from '../setup/install.ts';
import { nodeOf } from '../setup/run.ts';
import { formatSchedule, parseSchedule } from './schedule.ts';

export const WATCHER_TIMER = 'neptunia-watcher.timer';
export const WATCHER_WORKER = 'neptunia-watcher.service';

export type Environment = Readonly<Record<string, string | undefined>>;
export type RunManager = (command: string, args: ReadonlyArray<string>) => Promise<RunResult>;

/** Where the user manager's units live. */
const userUnitDir = (env: Environment): string =>
  path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');

/** The folder of the units of the scope in force. */
export const unitFolder = (env: Environment): string =>
  unitScope(env) === 'user' ? userUnitDir(env) : '/etc/systemd/system';

/** `NEPTUNIA_UNIT_SCOPE` when it says, else the user manager when the watcher's timer is installed under it. */
export function unitScope(env: Environment): 'user' | 'system' {
  const said = env[UNIT_SCOPE_ENV];
  if (said === 'user' || said === 'system') return said;
  return fs.existsSync(path.join(userUnitDir(env), WATCHER_TIMER)) ? 'user' : 'system';
}

/** The `systemctl` of the scope for a call that changes something: through `sudo` in the system scope. */
export const managerCall = (env: Environment, ...args: Array<string>): [string, Array<string>] =>
  systemctlOf({ system: unitScope(env) === 'system' }, ...args);

/** The `systemctl` of the scope for a read, which never goes through `sudo`. */
export const managerRead = (env: Environment, ...args: Array<string>): [string, Array<string>] =>
  unitScope(env) === 'user' ? ['systemctl', ['--user', ...args]] : ['systemctl', args];

/** The one word `is-active` or `is-enabled` printed, empty when the manager did not answer. */
async function managerWord(run: RunManager, env: Environment, verb: string, unit: string): Promise<string> {
  const [command, args] = managerRead(env, verb, unit);
  return (await run(command, args)).stdout.trim();
}

/** The worker's running state: a oneshot is `activating` for the whole of its run. */
export async function workerRunning(run: RunManager, env: Environment): Promise<'true' | 'false' | 'unknown'> {
  const word = await managerWord(run, env, 'is-active', WATCHER_WORKER);
  if (word === 'active' || word === 'activating' || word === 'deactivating') return 'true';
  return word === 'inactive' || word === 'failed' ? 'false' : 'unknown';
}

/** The timer's install state as the manager says it, `unknown` with no manager to ask. */
export async function timerState(run: RunManager, env: Environment): Promise<string> {
  const word = await managerWord(run, env, 'is-enabled', WATCHER_TIMER);
  return word === '' ? 'unknown' : word;
}

/** Starts the worker without waiting for it, since a oneshot's start lasts its whole run; the reason when refused. */
export async function startWorker(run: RunManager, env: Environment): Promise<string | null> {
  const [command, args] = managerCall(env, 'start', '--no-block', WATCHER_WORKER);
  const done = await run(command, args);
  return done.code === 0 ? null : whyFailed(done);
}

/** Enables or disables the timer; the reason when the manager refused. */
export async function moveTimer(run: RunManager, env: Environment, verb: 'enable' | 'disable'): Promise<string | null> {
  const [command, args] = managerCall(env, verb, '--now', WATCHER_TIMER);
  const done = await run(command, args);
  return done.code === 0 ? null : whyFailed(done);
}

/** The schedule an installed timer's text holds, as a setting spells it; null when it holds neither form. */
function scheduleOfTimer(text: string): string | null {
  const calendar = [...text.matchAll(/^OnCalendar=\*-\*-\* (\d\d:\d\d):00 UTC$/gm)].map((found) => found[1]);
  if (calendar.length > 0) {
    const schedule = parseSchedule(`at ${calendar.join(',')}`);
    return schedule === null ? null : formatSchedule(schedule);
  }
  const minutes = /^OnUnitActiveSec=(\d+)min$/m.exec(text)?.[1];
  const schedule = minutes === undefined ? null : parseSchedule(`every ${minutes}m`);
  return schedule === null ? null : formatSchedule(schedule);
}

/** Who and where a unit is rendered for, from this process. */
function targetOf(where: { rootDir: string; privateDir: string; dataDir: string }, env: Environment): UnitTarget {
  return {
    system: unitScope(env) === 'system',
    user: os.userInfo().username,
    // `Group=` also takes the number, and a process that renders one timer has no need to spawn `id`.
    group: String(process.getgid?.() ?? ''),
    home: os.homedir(),
    rootDir: where.rootDir,
    privateDir: where.privateDir,
    dataDir: where.dataDir,
    node: nodeOf({ argv0: process.argv0, execPath: process.execPath, pathEnv: env.PATH }),
    ...(env.XDG_CONFIG_HOME ? { xdgConfigHome: env.XDG_CONFIG_HOME } : {}),
  };
}

/**
 * The installed timer rendered from the settings on disk and the manager reloaded. Null when the manager holds the
 * schedule, else why not and what it still holds. A timer whose text already matches is reloaded anyway, because a
 * reload that failed earlier left the file new and the manager old.
 */
export async function renderTimer(
  where: { rootDir: string; privateDir: string; dataDir: string },
  run: RunManager,
  env: Environment
): Promise<{ reason: string; applied: string } | null> {
  const target = targetOf(where, env);
  const place = path.join(unitDirOf(target), WATCHER_TIMER);
  let installed: string | null = null;
  try {
    installed = fs.readFileSync(place, 'utf8');
  } catch {
    // Not installed yet.
  }
  const applied = installed === null ? 'not installed' : (scheduleOfTimer(installed) ?? 'unknown');
  const done = await installUnits(target, run, [WATCHER_TIMER]);
  if (!done.ok) return { reason: done.reason, applied };
  if (done.written.length > 0) return null;
  const [command, args] = managerCall(env, 'daemon-reload');
  const reload = await run(command, args);
  return reload.code === 0 ? null : { reason: `daemon-reload: ${whyFailed(reload)}`, applied };
}
