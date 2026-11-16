// The limits and the state file of one-time phrases, after Hermes's gateway/pairing.py. Her link tool
// (src/interface/person-link.ts) uses both, with the file `link-codes.json`. `createCodeFile` writes the state after
// every change, so a restart neither drops a waiting phrase nor reopens a used one or a lock.

import fs from 'node:fs';
import path from 'node:path';

import { log } from '../log.ts';

// Hermes's limits (gateway/pairing.py): a code lives an hour, an account asks once per ten minutes, five failures lock
// for an hour.
const HOUR_MS = 60 * 60_000;
export const CODE_TTL_MS = HOUR_MS;

export const REQUEST_EVERY_MS = 10 * 60_000;
export const MAX_FAILURES = 5;
export const LOCK_MS = HOUR_MS;

/** The state file `name` in the data directory, which is the private layer `hot.privateDir`; none without one. */
export function codesFileOf(hot: { readonly privateDir?: string }, name: string): string | null {
  return hot.privateDir === undefined ? null : path.join(hot.privateDir, name);
}

/** A state kept in a JSON file: read once at creation, written whole after each change. */
export type CodeFile<TState> = { load(): TState; save(state: TState): void };

/** The JSON file at `file`, private to its user; none kept when `file` is null. A file that will not parse reads as `empty`. */
export function createCodeFile<TState>(file: string | null, empty: () => TState): CodeFile<TState> {
  return {
    load() {
      if (file === null || !fs.existsSync(file)) return empty();
      try {
        return { ...empty(), ...(JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<TState>) };
      } catch {
        log.warn('codes: state file unreadable, starting empty', { file: path.basename(file) });
        return empty();
      }
    },
    save(state) {
      if (file === null) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(temporary, file);
    },
  };
}
