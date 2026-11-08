// The quarantine of the pending unit writes (stage AM of the master plan): a write kept in `memory-pending/` whose
// replay fails at an open is moved to `memory-pending-quarantine/` (folder mode 700, files mode 600) with
// `<name>.error.json` beside it (`{ code, at }`), so one bad write never keeps the database closed. A name the folder
// already holds gets the time of the move as a suffix (`<sha1>-<time>.json`), so a second failure of the same owner
// never overwrites the first. The service (service.ts) moves the files, counts them for its status and replays them
// at the owner's `/memory pending replay`. Counts and codes only in the logs, never a path or a text.

import fs from 'node:fs';
import path from 'node:path';
import type { StorageKey } from './storage-keys.ts';
import type { Row } from './types.ts';

/** The folder of the pending writes that failed their replay, under the data directory. */
export const QUARANTINE_DIR = 'memory-pending-quarantine';

/** One quarantined write as the owner's list shows it: its file name, the code it failed with and when it moved. */
export type QuarantinedPending = { name: string; code: string | null; at: string | null };

/** What the status says of the quarantine: how many files wait and the code of the newest one. */
export type QuarantineStatus = { quarantined: number; lastCode: string | null };

const WRITE_FILE = /^[0-9a-f]{40}(?:-[0-9A-Za-z-]+)?\.json$/;

/** The error file kept beside a quarantined write. */
export const errorFileOf = (file: string): string => file.replace(/\.json$/, '.error.json');

/**
 * The unit write a pending or quarantined file holds, as the writer takes it (`{ op, key | owner, value | lines }`),
 * or null when the file does not parse or is not a unit write.
 */
export function readPendingWrite(file: string): Row | null {
  try {
    const kept = (JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}) as {
      owner?: unknown;
      key?: StorageKey;
      op?: unknown;
      value?: unknown;
      lines?: unknown;
    };
    const { owner, op, key } = kept;
    if ((!key && typeof owner !== 'string') || (op !== 'value' && op !== 'lines' && op !== 'errand')) return null;
    const target = key ? { key } : { owner };
    if (op === 'lines') return { op, ...target, lines: Array.isArray(kept.lines) ? kept.lines : [] };
    return { op, ...target, value: kept.value };
  } catch {
    return null;
  }
}

/** A free name for `name` in `dir`: itself, else with the time of the move, else with a counter after that. */
function freeName(dir: string, name: string, at: string): string {
  const taken = (one: string) => fs.existsSync(path.join(dir, one)) || fs.existsSync(path.join(dir, errorFileOf(one)));
  if (!taken(name)) return name;
  const stem = `${name.replace(/\.json$/, '')}-${at.replace(/[^0-9A-Za-z]/g, '')}`;
  let candidate = `${stem}.json`;
  for (let n = 2; taken(candidate); n += 1) candidate = `${stem}-${n}.json`;
  return candidate;
}

/**
 * Moves the pending `file` into `dir` with its error file (`{ code, at }`). Throws when the move cannot be made: the
 * file then stays where it was. Returns the name it has in the quarantine.
 */
export function quarantinePending(file: string, dir: string, code: string, at: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const name = freeName(dir, path.basename(file), at);
  const target = path.join(dir, name);
  fs.renameSync(file, target);
  fs.chmodSync(target, 0o600);
  writeError(target, code, at);
  return name;
}

/** Writes the error file of the quarantined `file` (mode 600). */
export function writeError(file: string, code: string, at: string): void {
  fs.writeFileSync(errorFileOf(file), JSON.stringify({ code, at }), { mode: 0o600 });
}

/** The quarantined writes in `dir`, by name, each with the code and the time of its error file. */
export function quarantinedIn(dir: string): Array<QuarantinedPending> {
  let names: Array<string>;
  try {
    names = fs.readdirSync(dir).filter((name) => WRITE_FILE.test(name));
  } catch {
    return [];
  }
  return names.sort().map((name) => {
    try {
      const error = JSON.parse(fs.readFileSync(path.join(dir, errorFileOf(name)), 'utf8')) as Row | null;
      const code = typeof error?.code === 'string' ? error.code : null;
      const at = typeof error?.at === 'string' ? error.at : null;
      return { name, code, at };
    } catch {
      return { name, code: null, at: null };
    }
  });
}

/** How many writes wait in `dir` and the code of the newest. */
export function quarantineStatus(dir: string): QuarantineStatus {
  const files = quarantinedIn(dir);
  let newest: QuarantinedPending | null = null;
  for (const file of files) if (newest === null || (file.at ?? '') >= (newest.at ?? '')) newest = file;
  return { quarantined: files.length, lastCode: newest?.code ?? null };
}

/** Deletes a quarantined write and its error file. */
export function releaseQuarantined(file: string): void {
  fs.rmSync(file, { force: true });
  fs.rmSync(errorFileOf(file), { force: true });
}

/**
 * A quarantine notice as her inner life keeps it: a `pendingQuarantined` fact with `waiting` the writes set aside and `code`
 * the code the last of them failed with, told in no chat.
 */
export type QuarantineNotice = {
  kind: 'pendingQuarantined';
  waiting: number;
  code: string;
  placeId: null;
  dmChat: false;
  at: number;
};

/**
 * The notices of the opens that quarantined writes, for the core: `hold` is the service's `onPendingQuarantined`, and
 * the notices made before `tellWith` names the teller (the open runs before her inner life exists) wait for it. A
 * teller that throws is logged with its code and the notice is dropped.
 */
export function quarantineNotices(
  now: () => number,
  log: { warn: (message: string, fields?: object) => void }
): {
  hold: (info: { count: number; code: string; cause?: string | null }) => void;
  tellWith: (tell: (notice: QuarantineNotice) => unknown) => void;
} {
  const held: Array<QuarantineNotice> = [];
  let teller: ((notice: QuarantineNotice) => unknown) | null = null;
  const tellOne = (tell: (notice: QuarantineNotice) => unknown, notice: QuarantineNotice) => {
    try {
      tell(notice);
    } catch (error) {
      log.warn('memory db: pending quarantine not told', { code: (error as { code?: unknown })?.code ?? null });
    }
  };
  return {
    hold: ({ count, code, cause }) => {
      const notice: QuarantineNotice = {
        kind: 'pendingQuarantined',
        waiting: count,
        code: cause ?? code,
        placeId: null,
        dmChat: false,
        at: now(),
      };
      if (teller) tellOne(teller, notice);
      else held.push(notice);
    },
    tellWith: (tell) => {
      teller = tell;
      for (const notice of held.splice(0)) tellOne(tell, notice);
    },
  };
}
