// The server part of `/health`: the disk under the data folder, the load, the systemd units of the engine, the last
// memory backup and the firewall when `ufw` exists. `serverHealth` judges what a probe reports and is pure;
// `systemProbe` is the real probe over `statfs`, `node:os`, `systemctl` and `ufw`, a `ufw` that refuses to answer
// counting as none. The owner's console
// (src/interface/commands/console.ts) calls both for `/health server`, and the daily watcher reads it through
// `neptunia -p`.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { backupSettings, backupsIn } from '../memory/db/backup.js';

export type HealthStatus = 'ok' | 'warn' | 'fail';

export type ServerProbe = {
  disk(): Promise<{ path: string; freeBytes: number; totalBytes: number }>;
  load(): { one: number; five: number; fifteen: number; cpus: number };
  units(): Promise<ReadonlyArray<{ name: string; active: boolean }>>;
  lastBackup(): { name: string } | null;
  /** Null when `ufw` does not exist on the machine. */
  firewall(): Promise<{ active: boolean } | null>;
};

export type ServerHealth = {
  part: 'server';
  status: HealthStatus;
  text: string;
  disk: { path: string; freeBytes: number; totalBytes: number };
  load: { one: number; five: number; fifteen: number; cpus: number };
  units: ReadonlyArray<{ name: string; active: boolean }>;
  lastBackup: { name: string } | null;
  firewall: { active: boolean } | null;
};

/** Less free disk than this share of the whole is a warning. */
const DISK_WARN_SHARE = 0.1;

/** A load per CPU above this over fifteen minutes is a warning. */
const LOAD_WARN_PER_CPU = 2;

/** The engine's units the probe asks `systemctl` about: the core and the two errand runners (deploy/). */
const ENGINE_UNITS = ['neptunia-core.service', 'neptunia-agent-scout.service', 'neptunia-agent-server.service'];

/** The interface units, one per interface (deploy/neptunia-interface@.service). */
const INTERFACE_UNITS = 'neptunia-interface@*.service';

const RANK: Readonly<Record<HealthStatus, number>> = { ok: 0, warn: 1, fail: 2 };

/** The worse of two statuses. */
export function worse(a: HealthStatus, b: HealthStatus): HealthStatus {
  return RANK[b] > RANK[a] ? b : a;
}

const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

/** The server's health from what `probe` reports at `now`. */
export async function serverHealth(probe: ServerProbe, options: { now: number }): Promise<ServerHealth> {
  const [disk, units, firewall] = await Promise.all([probe.disk(), probe.units(), probe.firewall()]);
  const load = probe.load();
  const lastBackup = probe.lastBackup();
  let status: HealthStatus = 'ok';
  const lines: Array<string> = [];
  const share = disk.totalBytes > 0 ? disk.freeBytes / disk.totalBytes : 0;
  if (share < DISK_WARN_SHARE) status = worse(status, 'warn');
  lines.push(`disk ${disk.path}: ${gib(disk.freeBytes)} free of ${gib(disk.totalBytes)}`);
  if (load.fifteen > LOAD_WARN_PER_CPU * Math.max(1, load.cpus)) status = worse(status, 'warn');
  lines.push(`load ${load.one.toFixed(2)} ${load.five.toFixed(2)} ${load.fifteen.toFixed(2)} on ${load.cpus} cpus`);
  const down = units.filter((unit) => !unit.active);
  if (down.length > 0) status = worse(status, 'fail');
  lines.push(
    units.length === 0
      ? 'units: none found'
      : `units: ${units.map((unit) => `${unit.name} ${unit.active ? 'active' : 'not active'}`).join(', ')}`
  );
  lines.push(`last memory backup: ${lastBackup?.name ?? 'none'}`);
  if (firewall !== null && !firewall.active) status = worse(status, 'warn');
  lines.push(`firewall: ${firewall === null ? 'no ufw' : firewall.active ? 'active' : 'inactive'}`);
  lines.unshift(`server ${status} at ${new Date(options.now).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  return { part: 'server', status, text: lines.join('\n'), disk, load, units, lastBackup, firewall };
}

/** A program's stdout, or null when it does not exist or fails to start. Never rejects. */
function run(file: string, args: ReadonlyArray<string>): Promise<{ code: number; stdout: string } | null> {
  return new Promise((resolve) => {
    execFile(file, [...args], { timeout: 10_000 }, (err, stdout) => {
      if (err !== null && typeof err.code === 'string') {
        resolve(null);
        return;
      }
      resolve({ code: err === null ? 0 : typeof err.code === 'number' ? err.code : 1, stdout: String(stdout) });
    });
  });
}

/** The real probe of the machine the core runs on, over the data folder `dataDir` and the live `config`. */
export function systemProbe(config: unknown, dataDir: string): ServerProbe {
  return {
    async disk() {
      const stat = await fs.promises.statfs(dataDir);
      return { path: dataDir, freeBytes: stat.bavail * stat.bsize, totalBytes: stat.blocks * stat.bsize };
    },
    load() {
      const [one = 0, five = 0, fifteen = 0] = os.loadavg();
      return { one, five, fifteen, cpus: os.cpus().length };
    },
    async units() {
      const listed = await run('systemctl', ['list-units', '--all', '--plain', '--no-legend', INTERFACE_UNITS]);
      const interfaces = (listed?.stdout ?? '')
        .split('\n')
        .map((line) => line.trim().split(/\s+/)[0] ?? '')
        .filter((name) => name.endsWith('.service'));
      const names = [...ENGINE_UNITS, ...interfaces];
      const states = await Promise.all(names.map((name) => run('systemctl', ['is-active', name])));
      if (states.every((state) => state === null)) return [];
      return names.map((name, index) => ({ name, active: states[index]?.stdout.trim() === 'active' }));
    },
    lastBackup() {
      const kept = backupsIn(backupSettings(config, dataDir).dir);
      const newest = kept.at(-1);
      return newest === undefined ? null : { name: newest };
    },
    async firewall() {
      // `ufw status` needs root: a refusal tells nothing about the firewall, so it reads as no ufw.
      const answer = await run('ufw', ['status']);
      if (answer === null || answer.code !== 0) return null;
      return { active: /^Status:\s*active/m.test(answer.stdout) };
    },
  };
}
