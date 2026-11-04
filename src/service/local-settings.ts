// The one writer of `<private>/config.local/config.json` for a command that runs beside others: `updateLocalSettings`
// takes the file's lock, reads it with its old keys moved (src/config-moves.ts), applies one change and renames the
// result into place. A change that alters nothing touches neither the file nor the lock, so a repeated command wakes no
// reader of the hot settings. The service commands (src/service/commands.ts) and the setup steps that ask for a schedule
// (src/setup/mechanics.ts, src/setup/watcher.ts) write through it.

import fs from 'node:fs';
import path from 'node:path';
import { moveConfigKeys } from '../config-moves.ts';
import { localConfigPath } from '../config/files.ts';
import { readLocalConfig } from '../tools/impl/shared.ts';

type Settings = Record<string, unknown>;

/** A lock older than this was left by a process that died: a write takes well under a second. Decided 2026-11-04. */
const STALE_LOCK_MS = 10_000;
const LOCK_WAIT_MS = 20;

/** Sleeps the thread: a command holds the lock for one synchronous read and write, and has nothing else to run. */
const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function takeLock(lock: string): void {
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) fs.rmSync(lock, { force: true });
    } catch {
      // The holder released it between the two calls; the next try takes it.
    }
    pause(LOCK_WAIT_MS);
  }
}

const same = (one: unknown, other: unknown): boolean => JSON.stringify(one) === JSON.stringify(other);

/**
 * `change` over the local settings, its old keys moved first when the change touches the file. True when the file was
 * written. `change` returns the new settings and leaves its argument alone.
 */
export function updateLocalSettings(privateDir: string, change: (local: Settings) => Settings): boolean {
  const file = localConfigPath(privateDir);
  const before = readLocalConfig(file);
  if (same(change(before), before)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  takeLock(lock);
  try {
    const held = readLocalConfig(file);
    const next = change(moveConfigKeys(held).config);
    if (same(next, held)) return false;
    const staged = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(staged, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(staged, file);
    return true;
  } finally {
    fs.rmSync(lock, { force: true });
  }
}
