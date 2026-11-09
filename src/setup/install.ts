// Writing the rendered units: the part of `neptunia setup` that touches the unit folder and systemd, used by the `units`
// step (src/setup/run.ts); `applyModeToUnit` re-renders the one unit whose mode changed. Inside the core a mode change
// renders nothing (`deferModeToUnit`): the core runs under `NoNewPrivileges` and cannot `sudo`. A user
// unit is written straight into `~/.config/systemd/user`. A system unit is rendered into a folder of its own and put in
// place with `sudo install`, so nothing writes to `/etc/systemd/system` without sudo. Every command goes through the
// injected `run`, so no test touches systemd.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKEND_NAMES } from '../agent-runner/profiles.ts';
import { readRouting } from '../subharness/routing.ts';
import { modeOf } from '../subharness/control.ts';
import { isInstalled } from '../subharness/place.ts';
import { ClientsError, readClients } from './clients.ts';
import { UNIT_AGENTS, renderUnit } from './units.ts';
import type { UnitVars } from './units.ts';

/** What a command gave back. */
export type RunResult = { code: number; stdout: string; stderr?: string };

/** Where and for whom the units are rendered. */
export type UnitTarget = {
  system: boolean;
  user: string;
  group: string;
  home: string;
  rootDir: string;
  privateDir: string;
  dataDir: string;
  node: string;
  /** `XDG_CONFIG_HOME` of the installing user; the user units go under `<it>/systemd/user` */
  xdgConfigHome?: string;
  /** the unit folder, instead of the default of the scope */
  unitDir?: string;
  /** the dev checkout the development unit may write (`selfimprovement.checkout`); every unit runs in `rootDir` */
  developmentCheckout?: string | null;
};

/** The unit folder of the scope: `/etc/systemd/system`, or the user manager's folder under the config home. */
export function unitDirOf(target: UnitTarget): string {
  if (target.unitDir !== undefined) return target.unitDir;
  if (target.system) return '/etc/systemd/system';
  const config = target.xdgConfigHome ?? path.join(target.home, '.config');
  return path.join(config, 'systemd', 'user');
}

/** The `systemctl` command line of the scope, behind `sudo` for the system. */
export function systemctlOf(target: Pick<UnitTarget, 'system'>, ...args: Array<string>): [string, Array<string>] {
  return target.system ? ['sudo', ['systemctl', ...args]] : ['systemctl', ['--user', ...args]];
}

/** The names of the clients and of the interfaces of the install: the folders under `interfaces/` and the interface of each client. */
function secretsOf(privateDir: string): { clients: Array<string>; interfaces: Array<string> } {
  const clients = readClients(privateDir);
  const folders = fs.existsSync(path.join(privateDir, 'interfaces'))
    ? fs.readdirSync(path.join(privateDir, 'interfaces'), { withFileTypes: true }).filter((one) => one.isDirectory())
    : [];
  const named = Object.entries(clients)
    .filter(([, client]) => client.kind === 'interface')
    .map(([name, client]) => client.iface ?? name);
  return { clients: Object.keys(clients), interfaces: [...new Set([...folders.map((one) => one.name), ...named])] };
}

/**
 * The text of one unit as the scope, the owner's modes and the backends a role names in config.json or installed in the
 * private layer want it.
 */
export function unitText(target: UnitTarget, template: string, file: string): string {
  const agent = UNIT_AGENTS[file];
  const { subharness } = readRouting(target.dataDir);
  // Named or installed: a restored persona's role finds its folder bound before the install, and a role moved to an
  // installed backend finds it bound before config.json says so.
  const named = new Set<string>([...Object.values(subharness.uses), subharness.memory?.backend ?? '']);
  const backends = BACKEND_NAMES.filter((name) => named.has(name) || isInstalled(target.dataDir, name));
  const vars: UnitVars = {
    ...target,
    backends,
    ...secretsOf(target.privateDir),
  };
  if (agent !== undefined) vars.mode = modeOf(subharness.modes, agent);
  return renderUnit(template, target.system ? 'system' : 'user', vars);
}

const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';

/** Why a command failed, in one line and without anything it printed beyond its first line. */
export const whyFailed = (result: RunResult): string =>
  firstLine(result.stderr ?? '') || firstLine(result.stdout) || `exit code ${result.code}`;

/**
 * Puts `files` (names of UNIT_FILES, templates under `<rootDir>/deploy`) in place: the ones whose text differs from what is installed. It then reloads the
 * manager once when anything was written. Resolves with the names written, or the reason it stopped.
 */
export async function installUnits(
  target: UnitTarget,
  run: (command: string, args: ReadonlyArray<string>) => Promise<RunResult>,
  files: ReadonlyArray<string>
): Promise<{ ok: true; written: Array<string> } | { ok: false; reason: string }> {
  const dir = unitDirOf(target);
  const written: Array<string> = [];
  const staging = target.system ? fs.mkdtempSync(path.join(os.tmpdir(), 'neptunia-units-')) : null;
  try {
    if (!target.system) fs.mkdirSync(dir, { recursive: true });
    for (const file of files) {
      const text = unitText(target, fs.readFileSync(path.join(target.rootDir, 'deploy', file), 'utf8'), file);
      const place = path.join(dir, file);
      let current: string | null = null;
      try {
        current = fs.readFileSync(place, 'utf8');
      } catch {
        // not installed yet
      }
      if (current === text) continue;
      if (staging === null) fs.writeFileSync(place, text);
      else {
        const staged = path.join(staging, file);
        fs.writeFileSync(staged, text);
        const done = await run('sudo', ['install', '-m', '0644', staged, place]);
        if (done.code !== 0) return { ok: false, reason: `sudo install ${file}: ${whyFailed(done)}` };
      }
      written.push(file);
    }
    if (written.length > 0) {
      const [command, args] = systemctlOf(target, 'daemon-reload');
      const reload = await run(command, args);
      if (reload.code !== 0) return { ok: false, reason: `daemon-reload: ${whyFailed(reload)}` };
    }
    return { ok: true, written };
  } catch (err) {
    if (err instanceof ClientsError) return { ok: false, reason: err.message };
    return { ok: false, reason: (err as NodeJS.ErrnoException).code ?? 'the unit folder cannot be written' };
  } finally {
    if (staging !== null) fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** The unit file of an agent, or null for an agent with no unit of its own. */
export function unitOfAgent(agent: string): string | null {
  return Object.entries(UNIT_AGENTS).find(([, name]) => name === agent)?.[0] ?? null;
}

/**
 * The line the core answers after a mode change, with no command run: the agent's unit takes the mode when the owner
 * runs `neptunia setup`. The core runs under `NoNewPrivileges`, so it never tries the `sudo` a system unit needs.
 * Null for an agent with no unit or no agent at all.
 */
export function deferModeToUnit(agent: string): string | null {
  const file = unitOfAgent(agent);
  return file === null ? null : `${file} takes the mode when you run "neptunia setup" in a shell`;
}

/**
 * Puts the mode of `agent` into its unit: renders the one unit again, reloads the manager and restarts the unit when it
 * runs. Resolves with a line for the owner, or null when the agent has no unit. The unit's file is left alone when the
 * scope has none installed.
 */
export async function applyModeToUnit(
  target: UnitTarget,
  run: (command: string, args: ReadonlyArray<string>) => Promise<RunResult>,
  agent: string
): Promise<string | null> {
  const file = unitOfAgent(agent);
  if (file === null) return null;
  if (!fs.existsSync(path.join(unitDirOf(target), file)))
    return `${file} is not installed here; the mode holds from the next run`;
  const done = await installUnits(target, run, [file]);
  if (!done.ok) return `${file} could not be updated: ${done.reason}`;
  const [command, args] = systemctlOf(target, 'try-restart', file);
  const restarted = await run(command, args);
  if (restarted.code !== 0) return `${file} was updated and could not be restarted: ${whyFailed(restarted)}`;
  return done.written.length === 0 ? `${file} had this mode already` : `${file} was updated and restarted`;
}

/** Runs a command to its end and resolves with its output; `sudo` never waits for a password without a terminal. */
export function spawnRun(
  command: string,
  args: ReadonlyArray<string>,
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<RunResult> {
  const given = command === 'sudo' && process.stdin.isTTY !== true ? ['-n', ...args] : [...args];
  return new Promise((resolve) => {
    const settings = {
      timeout: options.timeoutMs ?? 60_000,
      encoding: 'utf8' as const,
      maxBuffer: 16 * 1024 * 1024,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    };
    execFile(command, given, settings, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      resolve({ code, stdout, stderr: error !== null && stderr === '' ? error.message : stderr });
    });
  });
}
