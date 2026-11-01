// The journal's reads from the database (src/memory/journal.ts reads through them).
// A journal day is the unit `<layer>/journal/<YYYY-MM-DD>.jsonl` of `day`, `decisions`, `sources` (her answers) and
// `affinity_events` rows (map/journal.ts); the lines come back rebuilt by the export, in file order, so a turn line
// is joined with its answer and a memory line with its attitude rows exactly as the file holds them. Pure functions
// over a read connection.

import { unitLines } from './common.ts';
import type { Db } from '../types.ts';

/** The lines (JSON text) of one journal day unit (`owner`: its full path), in file order. */
export const journalLines = (dbGiven: unknown, owner: string): Array<string> => {
  const db = dbGiven as Db;
  return unitLines(db, owner);
};

/**
 * When the journal was last written, from the database: the latest `recordedAt` among the lines of the given day
 * units (epoch ms), or null when none has one.
 */
export function journalLastWrite(db: Db, owners: ReadonlyArray<string>): number | null {
  let last: number | null = null;
  for (const owner of owners) {
    for (const line of unitLines(db, owner)) {
      let at = NaN;
      try {
        at = Date.parse((JSON.parse(line) as { recordedAt?: string } | null)?.recordedAt as string);
      } catch {
        at = NaN;
      }
      if (Number.isFinite(at) && (last === null || at > last)) last = at;
    }
  }
  return last;
}
