// Shared semantic readers and the ready database seam. Core modules read complete values and ordered lines by
// StorageKey. A key of an operational kind reads its row by kind and subject (operational.ts), a key of the intentions
// reads their rows (readers/intentions.ts), a day of the record or of the journal and a month of the archive their
// lines (record-lines.ts, journal-lines.ts, archive-lines.ts), and an account's profile, a private layer, a history of
// prose (a picture's descriptions too), a place's notes, a channel's entry, a lorebook, a participation and recent
// lines their value (account-profile.ts, private-layer.ts, prose-versions.ts, place-notes.ts, channel-entry.ts,
// place-lore.ts, participation-episodes.ts, recent-lines.ts). The explicit legacy export adapter
// understands historical owner strings. A closed service refuses reads with DB_CLOSED; failures are logged once with
// their reader and code, without stored contents.

import { isOperationalKind, operationalLines, operationalValue } from '../operational.ts';
import { intentionsArchiveLines, intentionsValue } from './intentions.ts';
import { recordLines } from '../record-lines.ts';
import { journalLines } from '../journal-lines.ts';
import { archiveUnitLines } from '../archive-lines.ts';
import { accountProfileValue } from '../account-profile.ts';
import { proseVersionsValue } from '../prose-versions.ts';
import { privateLayerValue } from '../private-layer.ts';
import { placeNotesValue } from '../place-notes.ts';
import { channelEntryValue } from '../channel-entry.ts';
import { placeLoreValue } from '../place-lore.ts';
import { participationValue } from '../participation-episodes.ts';
import { recentLinesValue } from '../recent-lines.ts';
import { hasStorageUnits } from '../storage-units.ts';
import { storageId } from '../storage-keys.ts';
import type { StorageKey } from '../storage-keys.ts';
import { legacyStorageKey, rootStateKind } from '../../migration/paths.ts';

import { filesOfUnit, unitRows, storageValue, storageLines } from '../export.ts';
import { classify } from '../../migration/classify.ts';
import type { MappedPath } from '../../migration/classify.ts';
import type { Db } from '../types.ts';

/** An Error with a code. */
export function codedError(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Sorts strings the way SQLite's BINARY collation and a sorted ASCII `readdir` do. */
export function byBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function infoOf(owner: string, format: string): MappedPath {
  const info = classify(owner);
  if (!info || 'skipped' in info || info.format !== format)
    throw codedError('READER_UNMAPPED', 'not a memory unit of this format');
  return info;
}

const unitRelOf = (owner: string) => /^[^/]+\/[^/]+\/(.+)$/.exec(owner)?.[1] ?? owner;

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
];

/**
 * The key of a unit whose kind its own reader answers (an operational kind, the intentions, a day of the record or of
 * the journal, a month of the archive, an account's profile, a private layer, a history of prose, a place's notes, a
 * channel's entry, a lorebook, a participation, recent lines), else
 * null; a path spells it.
 */
function directKey(db: Db, given: StorageKey | string): StorageKey | null {
  let key: StorageKey | null = typeof given === 'string' ? null : given;
  if (typeof given === 'string' && hasStorageUnits(db)) {
    try {
      key = legacyStorageKey(given);
    } catch {
      // An owner no path maps is the unit reader's to refuse.
      key = null;
    }
  }
  return key && (isOperationalKind(key.kind) || DIRECT_KINDS.includes(key.kind)) ? key : null;
}

/**
 * The lines of a JSONL memory unit (`owner` its full path) rebuilt from the database, in file order, without their
 * newlines: what reading the file line by line gives. A unit the database holds no row of has no lines.
 */
export function unitLines(dbGiven: unknown, key: StorageKey | string): Array<string> {
  const db = dbGiven as Db;
  const direct = directKey(db, key);
  if (direct && isOperationalKind(direct.kind)) return operationalLines(db, direct.kind, direct.subject.id);
  if (direct?.kind === 'intentions') return intentionsArchiveLines(db);
  if (direct?.kind === 'record') return recordLines(db, direct);
  if (direct?.kind === 'journal') return journalLines(db, direct);
  if (direct?.kind === 'archive') return archiveUnitLines(db, direct);
  if (hasStorageUnits(db)) return storageLines(db, typeof key === 'string' ? legacyStorageKey(key) : key);
  const owner = typeof key === 'string' ? key : storageId(key);
  const info = infoOf(owner, 'jsonl');
  const [out] = filesOfUnit(db, unitRelOf(owner), info, owner);
  const text = out ? out.data.toString('utf8') : '';
  return text === '' ? [] : text.replace(/\n$/, '').split('\n');
}

/**
 * The value of a JSON memory unit rebuilt from the database (what `JSON.parse` of the file gives), or not found when
 * the database holds no row of it (a missing file).
 */
export function unitValue(
  dbGiven: unknown,
  ownerGiven: StorageKey | string
): { found: true; value: unknown } | { found: false } {
  const db = dbGiven as Db;
  const direct = directKey(db, ownerGiven);
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
  if (hasStorageUnits(db)) {
    const key = typeof ownerGiven === 'string' ? legacyStorageKey(ownerGiven) : ownerGiven;
    const unit = db.prepare('SELECT 1 FROM storage_units WHERE id=? AND retired_at IS NULL').get(storageId(key));
    return unit ? { found: true, value: storageValue(db, key) } : { found: false };
  }
  const owner = ownerGiven as string;
  const kind = rootStateKind(owner);
  if (kind) {
    const row = db
      .prepare('SELECT value FROM operational WHERE kind = ? AND owner = ? AND owner_file IS NULL')
      .get(kind, owner);
    return row ? { found: true, value: JSON.parse(String(row.value)) } : { found: false };
  }
  const info = infoOf(owner, 'json');
  const rows = unitRows(db, owner);
  if (!Object.values(rows).some((list) => list.length > 0)) return { found: false };
  return { found: true, value: JSON.parse(JSON.stringify(info.mapper.fromRows(rows))) };
}

export { createReadSeam } from './seam.ts';
