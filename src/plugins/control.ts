// The owner's switch of a plugin, behind `/plugins` (src/interface/commands/plugins.ts). The desired state is the
// setting `plugins.<name>.enabled` (src/plugins/settings.ts). `enable` writes the plugin's client, an entry of the
// private layer's `clients.json` of kind `plugin` and its token file `clients/<name>.token` (mode 0600, in a folder
// of mode 0700, the files tools/client-token.mjs writes), switches the plugin on and starts its unit; the plugin runs
// as `neptunia plugin run <name>` and its hello is let in only while it is on. `disable` stops the unit, takes the
// entry and the token back (the live link closes at its next envelope) and tells the core to forget the plugin's
// tools. `setup` reports which environment keys the manifest lists are set in the unit's environment file
// `clients/<name>.env`, never their values. The folders are read at each call.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CLIENTS_FILE } from '../interface/principals.ts';
import { loadPlugins } from './folders.ts';
import type { LoadedPlugin, PluginProblem } from './folders.ts';

export type PluginUnits = { start(unit: string): Promise<void>; stop(unit: string): Promise<void> };

/** The systemd unit of plugin `name` (deploy/neptunia-plugin@.service). */
export const unitOf = (name: string): string => `neptunia-plugin@${name}`;

/** The units through `systemctl`, as the core runs them when it is not given others. */
export function systemdUnits(): PluginUnits {
  const run = (verb: 'start' | 'stop', unit: string): Promise<void> =>
    new Promise((resolve, reject) => {
      execFile('systemctl', [verb, unit], (error) =>
        error === null ? resolve() : reject(new Error(`systemctl ${verb} ${unit} failed: ${error.message}`))
      );
    });
  return { start: (unit) => run('start', unit), stop: (unit) => run('stop', unit) };
}

export type PluginView = {
  name: string;
  layer: 'tracked' | 'local';
  description: string;
  enabled: boolean;
  connected: boolean;
  tools: Array<string>;
};
export type SetupView = { name: string; env: Array<{ key: string; state: 'set' | 'missing' }> };
export type Change = { ok: true; changed: boolean } | { ok: false; code: 'unknown-plugin' | 'unit-failed' };
export type PluginControl = {
  list(): Array<PluginView>;
  problems(): Array<PluginProblem>;
  enable(name: string): Promise<Change>;
  disable(name: string): Promise<Change>;
  setup(name: string): SetupView | null;
};

const tokenFileOf = (name: string): string => `clients/${name}.token`;

function writePrivate(file: string, text: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

/** The entries of `clients.json`, none when there is no file; a file that is no JSON object is refused, never overwritten. */
function readClients(privateDir: string): Record<string, unknown> {
  const file = path.join(privateDir, CLIENTS_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`${CLIENTS_FILE} is not a JSON object; fix it by hand first`);
  return parsed as Record<string, unknown>;
}

const writeClients = (privateDir: string, clients: Record<string, unknown>): void =>
  writePrivate(path.join(privateDir, CLIENTS_FILE), `${JSON.stringify(clients, null, 2)}\n`);

function writeToken(privateDir: string, name: string): void {
  const folder = path.join(privateDir, 'clients');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.chmodSync(folder, 0o700);
  writePrivate(path.join(privateDir, tokenFileOf(name)), `${randomBytes(32).toString('hex')}\n`);
}

/** Makes sure the plugin has its client entry and a token; an entry and a token already there stay as they are. */
function ensureClient(privateDir: string, name: string): void {
  const clients = readClients(privateDir);
  const known = clients[name];
  if (known !== undefined) {
    const kind = known !== null && typeof known === 'object' ? (known as Record<string, unknown>).kind : undefined;
    if (kind !== 'plugin') throw new Error(`a client named ${name} exists and is not a plugin`);
  } else {
    writeClients(privateDir, { ...clients, [name]: { kind: 'plugin', tokenFile: tokenFileOf(name), permissions: [] } });
  }
  if (!fs.existsSync(path.join(privateDir, tokenFileOf(name)))) writeToken(privateDir, name);
}

function removeClient(privateDir: string, name: string): void {
  const clients = readClients(privateDir);
  if (Object.hasOwn(clients, name))
    writeClients(privateDir, Object.fromEntries(Object.entries(clients).filter(([key]) => key !== name)));
  fs.rmSync(path.join(privateDir, tokenFileOf(name)), { force: true });
}

/** Whether the unit's environment file holds `key=` with a value. */
function isSet(envText: string, key: string): boolean {
  for (const line of envText.split('\n')) {
    const at = line.indexOf('=');
    if (at === -1 || line.slice(0, at).trim() !== key) continue;
    const value = line
      .slice(at + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, '$2');
    if (value !== '') return true;
  }
  return false;
}

export function createPluginControl(options: {
  folders: () => { trackedDir: string; localDir: string };
  privateDir: string;
  isEnabled: (name: string) => boolean;
  setEnabled: (name: string, enabled: boolean) => void;
  connected: (name: string) => boolean;
  toolsOf: (name: string) => Array<string>;
  units: PluginUnits;
  onDisabled?: (name: string) => void;
}): PluginControl {
  const { privateDir, units } = options;
  const find = (name: string): LoadedPlugin | undefined =>
    loadPlugins(options.folders()).plugins.find((plugin) => plugin.manifest.name === name);

  return {
    list: () =>
      loadPlugins(options.folders()).plugins.map((plugin) => ({
        name: plugin.manifest.name,
        layer: plugin.layer,
        description: plugin.manifest.description,
        enabled: options.isEnabled(plugin.manifest.name),
        connected: options.connected(plugin.manifest.name),
        tools: options.toolsOf(plugin.manifest.name),
      })),
    problems: () => loadPlugins(options.folders()).problems,
    async enable(name) {
      if (find(name) === undefined) return { ok: false, code: 'unknown-plugin' };
      const changed = !options.isEnabled(name);
      ensureClient(privateDir, name);
      options.setEnabled(name, true);
      try {
        await units.start(unitOf(name));
      } catch {
        // The entry, the token and the switch stay written: the owner starts the unit by hand or enables again.
        return { ok: false, code: 'unit-failed' };
      }
      return { ok: true, changed };
    },
    async disable(name) {
      if (find(name) === undefined) return { ok: false, code: 'unknown-plugin' };
      if (!options.isEnabled(name)) return { ok: true, changed: false };
      options.setEnabled(name, false);
      try {
        await units.stop(unitOf(name));
      } catch {
        // A unit that was not running cannot be stopped; the revoked token ends a link that is still up.
      }
      removeClient(privateDir, name);
      options.onDisabled?.(name);
      return { ok: true, changed: true };
    },
    setup(name) {
      const plugin = find(name);
      if (plugin === undefined) return null;
      let envText = '';
      try {
        envText = fs.readFileSync(path.join(privateDir, 'clients', `${name}.env`), 'utf8');
      } catch {
        // No environment file: every key is missing.
      }
      return {
        name,
        env: plugin.manifest.env.map((key) => ({
          key,
          state: isSet(envText, key) ? ('set' as const) : ('missing' as const),
        })),
      };
    },
  };
}
