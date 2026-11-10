// A memory unit as the tests and the seed fixtures spell it (`{ op, key | owner, value | lines }`, the shape the store
// keeps by key), written through the writer's own kind for it: an operational value or trace line, the intentions, a
// profile, a private layer, a history of prose, a place's notes, a channel's entry, a lorebook, a participation, recent
// lines, her selfreflection, a day of the record or the journal, a month of the archive, a month of line vectors, an
// owner's name or an errand. The engine has no unit write; this only turns a fixture's unit into the write it is.
// Synthetic data only.
import { accountProfileOfUnit } from '../../../src/memory/db/account-profile.ts';
import { channelEntryOfUnit } from '../../../src/memory/db/channel-entry.ts';
import { intentionsOfUnit } from '../../../src/memory/db/intentions-write.ts';
import { monthLines } from '../../../src/memory/db/line-vectors.ts';
import { operationalOfUnit } from '../../../src/memory/db/operational.ts';
import { participationOfUnit } from '../../../src/memory/db/participation-episodes.ts';
import { placeLoreOfUnit } from '../../../src/memory/db/place-lore.ts';
import { placeNotesOfUnit } from '../../../src/memory/db/place-notes.ts';
import { privateLayerOfUnit } from '../../../src/memory/db/private-layer.ts';
import { proseVersionsOfUnit } from '../../../src/memory/db/prose-versions.ts';
import { recentLinesOfUnit } from '../../../src/memory/db/recent-lines.ts';
import { selfreflectionOfUnit } from '../../../src/memory/db/selfreflection-entries.ts';
import { applyMemoryWrite } from '../../../src/memory/db/session-write.ts';
import type { StorageKey } from '../../../src/memory/db/storage-keys.ts';
import { dbOf } from '../../../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row } from '../../../src/memory/db/types.ts';
import { writeRecordDay } from '../../../src/memory/db/record-lines.ts';
import { writeJournalDay } from '../../../src/memory/db/journal-lines.ts';
import { writeArchiveMonth } from '../../../src/memory/db/archive-lines.ts';

/** The writers of a day or a month of lines by the kind of its unit. */
const DAY_WRITERS: Partial<
  Record<string, (db: Db, key: StorageKey, lines: Array<Row>, opts: { iface: string; at: string }) => unknown>
> = {
  record: writeRecordDay,
  journal: writeJournalDay,
  archive: writeArchiveMonth,
};
import { legacyStorageKey } from './legacy-paths.ts';

/** The value writes by kind: each converter answers the write of its kind, or null for a unit of another kind. */
const VALUE_KINDS: ReadonlyArray<[string, (update: Row) => object | null]> = [
  ['operational', operationalOfUnit],
  ['intentions', intentionsOfUnit],
  ['account-profile', accountProfileOfUnit],
  ['prose-versions', proseVersionsOfUnit],
  ['private-layer', privateLayerOfUnit],
  ['place-notes', placeNotesOfUnit],
  ['channel-entry', channelEntryOfUnit],
  ['place-lore', placeLoreOfUnit],
  ['participation-episodes', participationOfUnit],
  ['recent-lines', recentLinesOfUnit],
  ['selfreflection-entries', selfreflectionOfUnit],
];

const placeOf = (key: StorageKey): string | null => (key.subject.type === 'persona' ? null : key.subject.id);

/** The write of a month of line vectors a fixture spells as its month files. */
function vectorsWrite(update: Row, key: StorageKey): Row {
  const files = (update.value ?? update.delta ?? {}) as Row;
  const manifest = (files.manifest ?? {}) as Row;
  return {
    op: update.value ? 'month' : 'append',
    placeId: key.subject.id,
    month: String(key.partition).slice(0, 7),
    model: typeof manifest.model === 'string' ? manifest.model : null,
    lines: monthLines(files) ?? [],
    kind: 'line-vectors',
  };
}

/** The write of a day of the record or the journal, or a month of the archive; null for a unit of another kind. */
function linesWrite(update: Row, key: StorageKey): Row | null {
  if (update.op !== 'lines') return null;
  if (key.kind === 'record' || key.kind === 'journal')
    return { placeId: placeOf(key), lines: update.lines, kind: `${key.kind}-lines` };
  if (key.kind === 'archive')
    return { placeId: placeOf(key), month: String(key.partition).slice(0, 7), lines: update.lines, kind: 'archive-lines' };
  return null;
}

/** The write of a value or lines of a kind with a converter of its own; null for none. */
function ownWrite(update: Row): Row | null {
  for (const [kind, of] of VALUE_KINDS) {
    const write = of(update);
    if (write) return { ...write, kind };
  }
  return null;
}

/** The writer's update for a fixture's unit, with its `kind`; throws `UNIT_UNMAPPED` for a unit no kind takes. */
export function unitAsWrite(update: Row): Row {
  // The synthetic units speak Discord's ids, so a unit that names no interface is Discord's.
  const stamp = { ...(update.now !== undefined ? { now: update.now } : {}), iface: update.iface ?? 'discord' };
  if (update.op === 'owner-name') return { ...update, kind: 'owner-name' };
  if (update.op === 'errand') return { ...(update.value as Row), ...stamp, kind: 'errand' };
  if (update.op === 'selfreflection')
    return { append: update.post, max: update.max, updatedAt: update.updatedAt, ...stamp, kind: 'selfreflection-entries' };
  const iface = typeof update.iface === 'string' ? update.iface : undefined;
  const key = (update.key as StorageKey | undefined) ?? legacyStorageKey(String(update.owner), iface);
  const write = update.op === 'vectors' ? vectorsWrite(update, key) : (linesWrite(update, key) ?? ownWrite({ ...update, key }));
  if (write) return { ...write, ...stamp };
  throw Object.assign(new Error('UNIT_UNMAPPED'), { code: 'UNIT_UNMAPPED' });
}

/**
 * A fixture's unit written on the writer connection `handle`. A day of the record or the journal and a month of the
 * archive go to that day's or month's writer by their key, so a private layer's day keeps the layer's place.
 */
export function applyUnitUpdate(handle: MemoryHandle, update: Row): unknown {
  const key =
    (update.key as StorageKey | undefined) ??
    (typeof update.owner === 'string'
      ? legacyStorageKey(update.owner, typeof update.iface === 'string' ? update.iface : undefined)
      : null);
  const writeDay = key && update.op === 'lines' ? DAY_WRITERS[key.kind] : undefined;
  if (key && writeDay) {
    const iface = typeof update.iface === 'string' ? update.iface : 'discord';
    const at = new Date(typeof update.now === 'number' ? update.now : Date.now()).toISOString();
    const lines = Array.isArray(update.lines) ? (update.lines as Array<Row>) : [];
    return handle.transaction(() => writeDay(dbOf(handle), key, lines, { iface, at }));
  }
  return applyMemoryWrite(handle, unitAsWrite(update));
}

/** A fixture's unit written through a memory service's generic write, with the service's live interface. */
export function writeUnitUpdate(
  memoryDb: { memoryWrite: (update: unknown) => Promise<unknown>; namespace?: () => string | null },
  update: Row
): Promise<unknown> {
  const iface = update.iface ?? memoryDb.namespace?.() ?? undefined;
  return memoryDb.memoryWrite({ ...unitAsWrite({ ...update, ...(iface ? { iface } : {}) }), now: update.now ?? Date.now() });
}
