// The settings of an interface the core runs, and its roots setting. `createInterfaceSettings` lays the interface's own
// files over the core's settings (src/config/files.ts#readInterfaceConfig) and reads them again when the core's
// settings reload or one of those files changes, as bin/neptunia.ts does for an interface run as a unit; a change of a
// file is told to the listeners of `onChange` at the next read. `listedRoots` reads and writes the list setting a
// package's `setup.json` marks as its roots (src/setup/modules.ts). Built by src/core.ts.

import fs from 'node:fs';
import path from 'node:path';
import { interfacePackageDir, localInterfacePath, readInterfaceConfig } from '../config/files.ts';
import { addModuleItem, moduleItems, readModuleSettings, removeModuleItem } from '../setup/modules.ts';
import type { ModuleRef, ModuleSetting } from '../setup/modules.ts';

type Settings = Record<string, unknown>;

/** When a file last changed, and its size, or `-` when it is absent. */
function stampOf(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return '-';
  }
}

export function createInterfaceSettings({
  rootDir,
  privateDir,
  name,
  hot,
}: {
  rootDir: string;
  privateDir: string;
  name: string;
  /** The core's settings now, and its reloads (src/hot.ts). */
  hot: { readonly config: Settings; onReload(listener: (what: string) => void): () => void };
}): { read(): Settings; onChange(listener: (what: string) => void): () => void } {
  const listeners = new Set<(what: string) => void>();
  const files = (): Array<string> => [
    path.join(interfacePackageDir(rootDir, privateDir, name), 'config.json'),
    localInterfacePath(privateDir, name),
  ];
  let seen: unknown = null;
  let stamp = '';
  let settings: Settings = {};
  function read(): Settings {
    const core = hot.config;
    const now = files().map(stampOf).join('|');
    if (core === seen && now === stamp) return settings;
    const fileChanged = seen !== null && core === seen;
    seen = core;
    stamp = now;
    settings = readInterfaceConfig({ rootDir, privateDir, name, base: core });
    if (fileChanged) for (const listener of [...listeners]) listener('config');
    return settings;
  }
  return {
    read,
    onChange(listener) {
      listeners.add(listener);
      const off = hot.onReload(listener);
      return () => {
        listeners.delete(listener);
        off();
      };
    },
  };
}

/** The roots setting of interfaces, read and written by name. */
export type ListedRoots = {
  /** The roots the setting lists, null when the package declares no roots setting. */
  read(name: string): ReadonlyArray<string> | null;
  add(name: string, rootId: string): void;
  remove(name: string, rootId: string): void;
};

/** The roots setting of each interface, by the package's own declaration. `written` runs after each write. */
export function listedRoots({
  rootDir,
  dataDir,
  written = () => {},
}: {
  rootDir: string;
  dataDir: string;
  written?: () => void;
}): ListedRoots {
  const refOf = (name: string): ModuleRef => ({ rootDir, dataDir, kind: 'interface', name });
  /** The declared settings and the key of the roots, or null when there is none or the declaration is broken. */
  function rootsOf(name: string): { ref: ModuleRef; settings: Array<ModuleSetting>; key: string } | null {
    try {
      const ref = refOf(name);
      const settings = readModuleSettings(ref);
      const key = settings?.find((one) => one.roots)?.key;
      return settings === null || key === undefined ? null : { ref, settings, key };
    } catch {
      return null;
    }
  }
  return {
    read(name) {
      const found = rootsOf(name);
      return found === null ? null : moduleItems(found.ref, found.settings, found.key);
    },
    add(name, rootId) {
      const found = rootsOf(name);
      if (found !== null) addModuleItem(found.ref, found.settings, found.key, rootId);
      written();
    },
    remove(name, rootId) {
      const found = rootsOf(name);
      if (found !== null) removeModuleItem(found.ref, found.settings, found.key, rootId);
      written();
    },
  };
}
