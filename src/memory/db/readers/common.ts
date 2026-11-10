// Shared semantic readers and the ready database seam. Core modules read complete values and ordered lines by
// StorageKey. A key of an operational kind reads its row by kind and subject (operational.ts), a key of the intentions
// reads their rows (readers/intentions.ts), a day of the record or of the journal and a month of the archive their
// lines (record-lines.ts, journal-lines.ts, archive-lines.ts), and an account's profile, a private layer, a history of
// prose, a place's notes, a channel's entry, a lorebook, a participation, recent lines and her selfreflection their
// value (account-profile.ts, private-layer.ts, prose-versions.ts, place-notes.ts, channel-entry.ts, place-lore.ts,
// participation-episodes.ts, recent-lines.ts, selfreflection-entries.ts). A key of any other kind reads as not found. A
// closed service refuses reads with DB_CLOSED; failures are logged once with their reader and code, without stored
// contents.

import { isOperationalKind, operationalLines, operationalValue } from '../operational.ts';
import { intentionsArchiveLines, intentionsValue } from './intentions.ts';
import { recordLines } from '../record-lines.ts';
import { journalLines } from '../journal-lines.ts';
import { archiveUnitLines } from '../archive-lines.ts';
import { accountProfileHeld, accountProfileValue } from '../account-profile.ts';
import { proseVersionsValue } from '../prose-versions.ts';
import { privateLayerHeld, privateLayerValue } from '../private-layer.ts';
import { placeNotesValue } from '../place-notes.ts';
import { channelEntryHeld, channelEntryValue } from '../channel-entry.ts';
import { placeLoreValue } from '../place-lore.ts';
import { participationValue } from '../participation-episodes.ts';
import { recentLinesValue } from '../recent-lines.ts';
import { selfreflectionValue } from '../selfreflection-entries.ts';
import type { StorageKey } from '../storage-keys.ts';
import type { Db } from '../types.ts';

/** The kinds besides the operational ones whose own reader answers a key. */
const DIRECT_KINDS: ReadonlyArray<string> = [
  'intentions',
  'record',
  'journal',
  'archive',
  'user',
  'versions',
  'private',
  'place',
  'channel',
  'lore',
  'participation',
  'recent',
  'selfreflection',
];

/** The key of a unit whose kind its own reader answers (an operational kind or one of `DIRECT_KINDS`), else null. */
const directKey = (key: StorageKey): StorageKey | null =>
  isOperationalKind(key.kind) || DIRECT_KINDS.includes(key.kind) ? key : null;

/** The lines of a unit by key, in the order they were written, without newlines; none for a kind with no reader. */
export function unitLines(dbGiven: unknown, key: StorageKey): Array<string> {
  const db = dbGiven as Db;
  const direct = directKey(key);
  if (direct && isOperationalKind(direct.kind)) return operationalLines(db, direct.kind, direct.subject.id);
  if (direct?.kind === 'intentions') return intentionsArchiveLines(db);
  if (direct?.kind === 'record') return recordLines(db, direct);
  if (direct?.kind === 'journal') return journalLines(db, direct);
  if (direct?.kind === 'archive') return archiveUnitLines(db, direct);
  return [];
}

/** The value of a unit by key, or not found when the database holds none of it or its kind has no reader. */
export function unitValue(dbGiven: unknown, key: StorageKey): { found: true; value: unknown } | { found: false } {
  const db = dbGiven as Db;
  const direct = directKey(key);
  if (direct && isOperationalKind(direct.kind)) return operationalValue(db, direct.kind, direct.subject.id);
  if (direct?.kind === 'intentions') return intentionsValue(db);
  if (direct?.kind === 'user') return accountProfileValue(db, direct);
  if (direct?.kind === 'versions') return proseVersionsValue(db, direct);
  if (direct?.kind === 'private') return privateLayerValue(db, direct);
  if (direct?.kind === 'place') return placeNotesValue(db, direct);
  if (direct?.kind === 'channel') return channelEntryValue(db, direct);
  if (direct?.kind === 'lore') return placeLoreValue(db, direct);
  if (direct?.kind === 'participation') return participationValue(db, direct);
  if (direct?.kind === 'recent') return recentLinesValue(db, direct);
  if (direct?.kind === 'selfreflection') return selfreflectionValue(db, direct);
  return { found: false };
}

/**
 * Whether the database holds a value of a unit: an account's profile, a private layer and a channel's entry by their
 * owner columns alone, any other kind by its reader.
 */
export function unitHeld(dbGiven: unknown, key: StorageKey): boolean {
  const db = dbGiven as Db;
  if (key.kind === 'user') return accountProfileHeld(db, key);
  if (key.kind === 'private') return privateLayerHeld(db, key);
  if (key.kind === 'channel') return channelEntryHeld(db, key);
  return unitValue(db, key).found;
}

/** The row each kind's own value always writes, by its writer: the subjects that hold a value of the kind. */
const SUBJECT_ROWS: Readonly<Record<string, { table: string; writer: string }>> = {
  user: { table: 'accounts', writer: 'profile' },
  private: { table: 'operational', writer: 'private' },
  channel: { table: 'operational', writer: 'channel' },
};

/** The subjects that hold a value of an account's profile, a private layer or a channel's entry, in id order. */
export function unitSubjects(dbGiven: unknown, kind: string): Array<string> {
  const db = dbGiven as Db;
  const rows = SUBJECT_ROWS[kind];
  if (!rows) return [];
  return db
    .prepare(
      `SELECT DISTINCT holder_id FROM "${rows.table}" WHERE writer = ? AND retired_at IS NULL AND holder_id IS NOT NULL
       ORDER BY holder_id`
    )
    .all(rows.writer)
    .map((row) => String(row.holder_id));
}

export { createReadSeam } from './seam.ts';
