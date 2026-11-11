// The settings of an interface the core runs. `createInterfaceSettings` lays the interface's own files over the core's
// settings (src/config/files.ts#readInterfaceConfig) and reads them again when the core's settings reload or one of
// those files changes, as bin/neptunia.ts does for an interface run as a unit; a change of a file is told to the
// listeners of `onChange` at the next read. `rootNounOf` reads the interface's own word for a root, as its `hello`
// declared it in `names.nouns`. Built by src/core.ts.

import fs from 'node:fs';
import path from 'node:path';
import { interfacePackageDir, localInterfacePath, readInterfaceConfig } from '../config/files.ts';
import { interfaceNamesOf } from '../memory/db/frame-reads.ts';
import type { Db } from '../memory/db/types.ts';

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

/** The interface's own noun for its top place (`names.nouns.server` of its `hello`), null when it declared none. */
export function rootNounOf(database: () => Db | null): (iface: string) => string | null {
  return (iface) => {
    const db = database();
    return db === null ? null : (interfaceNamesOf(db, iface).nouns.server ?? null);
  };
}
