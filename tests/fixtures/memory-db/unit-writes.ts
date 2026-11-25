// A memory unit as the tests and the seed fixtures spell it (`{ op, key | file, value | lines }`, the shape the store
// keeps by key), written through the writer's own kind for it: an operational value or trace line, the intentions, a
// profile, a private layer, a history of prose, a place's notes, a channel's entry, a lorebook, a participation, the
// persona's diary, a day of the record or the journal, a month of the archive, a month of line vectors, an
// owner's name or an errand. The engine has no unit write; this only turns a fixture's unit into the write it is.
// Synthetic data only.
import { accountProfileOfUnit } from '../../../src/memory/db/account-profile.ts';
import { channelEntryOfUnit } from '../../../src/memory/db/channel-entry.ts';
import { intentionsWriteOf } from '../../../src/memory/db/intentions-write.ts';
import type { StoredLine } from '../../../src/memory/db/line-vectors.ts';
import { operationalOfUnit } from '../../../src/memory/db/operational.ts';
import { participationOfUnit } from '../../../src/memory/db/participation-episodes.ts';
import { placeLoreOfUnit } from '../../../src/memory/db/place-lore.ts';
import { placeNotesOfUnit } from '../../../src/memory/db/place-notes.ts';
import { privateLayerOfUnit } from '../../../src/memory/db/private-layer.ts';
import { proseVersionsOfUnit } from '../../../src/memory/db/prose-versions.ts';
import { diaryOfUnit } from '../../../src/memory/db/diary-entries.ts';
import { applyMemoryWrite } from '../../../src/memory/db/session-write.ts';
import { keyText, placeCollection } from '../../../src/memory/db/unit-keys.ts';
import type { UnitKey } from '../../../src/memory/db/unit-keys.ts';
import { asText, dbOf } from '../../../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row } from '../../../src/memory/db/types.ts';
import { writeRecordDay } from '../../../src/memory/db/record-lines.ts';
import { writeJournalDay } from '../../../src/memory/db/journal-lines.ts';
import { writeArchiveMonth } from '../../../src/memory/db/archive-lines.ts';
import { seedRecentLines } from './recent-rows.ts';

/** The writers of a day or a month of lines by the kind of its unit. */
const DAY_WRITERS: Partial<
  Record<string, (db: Db, key: UnitKey, lines: Array<Row>, opts: { iface: string; at: string }) => unknown>
> = {
  record: writeRecordDay,
  journal: writeJournalDay,
  archive: writeArchiveMonth,
};
import { legacyStorageKey } from './legacy-paths.ts';

const isRecord = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The intentions write a unit write of the intention units carries, or null for any other unit. */
function intentionsOfUnit(update: Row): object | null {
  const key = update.key as { kind?: unknown; selector?: { collection?: unknown } } | undefined;
  if (key?.kind !== 'intentions') return null;
  if (key.selector?.collection === 'archive') return intentionsWriteOf({ op: 'archive', records: update.lines });
  const value = isRecord(update.value) ? update.value : {};
  return intentionsWriteOf({ op: 'value', intentions: value.intentions });
}

/**
 * The stored lines of a month's files (`{ manifest, meta, i8 }`, what an older index wrote): each complete jsonl line
 * the index would write the same way, with its `dims` bytes. Null when the text is not such lines, or the manifest names
 * no vector size or fewer bytes than the lines need.
 */
function monthLines(files: Row): Array<StoredLine> | null {
  const manifest = isRecord(files.manifest) ? files.manifest : {};
  const dims = manifest.dims;
  if (typeof dims !== 'number' || !Number.isInteger(dims) || dims <= 0) return null;
  const meta = Buffer.isBuffer(files.meta) ? files.meta.toString('utf8') : asText(files.meta ?? '');
  const i8 = Buffer.from((files.i8 as ArrayLike<number> | undefined) ?? []);
  if (meta === '') return [];
  if (!meta.endsWith('\n')) return null;
  const lines: Array<StoredLine> = [];
  for (const text of meta.slice(0, -1).split('\n')) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isRecord(value) || JSON.stringify(value) !== text) return null;
    const offset = lines.length * dims;
    if (i8.length < offset + dims) return null;
    lines.push({ line: value, bytes: new Uint8Array(i8.subarray(offset, offset + dims)) });
  }
  return lines;
}

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
  ['diary-entries', diaryOfUnit],
];

const placeOf = (key: UnitKey): string | null => (key.subject.type === 'persona' ? null : key.subject.id);

/** The write of a month of line vectors a fixture spells as its month files. */
function vectorsWrite(update: Row, key: UnitKey): Row {
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
function linesWrite(update: Row, key: UnitKey): Row | null {
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
  if (update.op === 'diary')
    return { append: update.post, max: update.max, updatedAt: update.updatedAt, ...stamp, kind: 'diary-entries' };
  const iface = typeof update.iface === 'string' ? update.iface : undefined;
  const key = (update.key as UnitKey | undefined) ?? legacyStorageKey(String(update.file), iface);
  const write = update.op === 'vectors' ? vectorsWrite(update, key) : (linesWrite(update, key) ?? ownWrite({ ...update, key }));
  if (write) return { ...write, ...stamp };
  throw Object.assign(new Error('UNIT_UNMAPPED'), { code: 'UNIT_UNMAPPED' });
}

/** The place whose recent lines a fixture's unit is (a value of the place's own `recent` unit), else null. */
function recentPlaceOf(update: Row): string | null {
  const key = update.key as UnitKey | undefined;
  if (update.op !== 'value' || key?.kind !== 'recent' || key.subject?.type !== 'place') return null;
  return keyText(placeCollection('recent', key.subject.id)) === keyText(key) ? key.subject.id : null;
}

/** A fixture's recent lines stored as the rows earlier versions wrote (recent-rows.ts), which no write kind takes. */
function seedRecentUnit(db: Db, placeId: string, update: Row): void {
  const at = new Date(typeof update.now === 'number' ? update.now : Date.now()).toISOString();
  const iface = typeof update.iface === 'string' ? update.iface : 'discord';
  seedRecentLines(db, placeId, (update.value ?? {}) as Row, { iface, at });
}

/**
 * A fixture's unit written on the writer connection `handle`. A day of the record or the journal and a month of the
 * archive go to that day's or month's writer by their key, so a private layer's day keeps the layer's place. Recent
 * lines are stored as rows.
 */
export function applyUnitUpdate(handle: MemoryHandle, update: Row): unknown {
  const key =
    (update.key as UnitKey | undefined) ??
    (typeof update.file === 'string'
      ? legacyStorageKey(update.file, typeof update.iface === 'string' ? update.iface : undefined)
      : null);
  const recentPlace = key ? recentPlaceOf({ ...update, key }) : null;
  if (recentPlace !== null) return handle.transaction(() => seedRecentUnit(dbOf(handle), recentPlace, update));
  const writeDay = key && update.op === 'lines' ? DAY_WRITERS[key.kind] : undefined;
  if (key && writeDay) {
    const iface = typeof update.iface === 'string' ? update.iface : 'discord';
    const at = new Date(typeof update.now === 'number' ? update.now : Date.now()).toISOString();
    const lines = Array.isArray(update.lines) ? (update.lines as Array<Row>) : [];
    return handle.transaction(() => writeDay(dbOf(handle), key, lines, { iface, at }));
  }
  return applyMemoryWrite(handle, unitAsWrite(update));
}

/**
 * A fixture's unit written through a memory service's generic write, with the service's live interface. Recent lines
 * are stored as rows on the service's connection, which a service opened on the calling thread can write.
 */
export function writeUnitUpdate(
  memoryDb: {
    memoryWrite: (update: unknown) => Promise<unknown>;
    namespace?: () => string | null;
    readHandle?: () => MemoryHandle | null;
  },
  update: Row
): Promise<unknown> {
  const iface = update.iface ?? memoryDb.namespace?.() ?? undefined;
  const recentPlace = recentPlaceOf(update);
  const handle = recentPlace === null ? null : memoryDb.readHandle?.();
  if (recentPlace !== null) {
    if (!handle) throw new Error('recent lines need a memory service opened on the calling thread');
    handle.transaction(() => seedRecentUnit(dbOf(handle), recentPlace, { ...update, ...(iface ? { iface } : {}) }));
    return Promise.resolve();
  }
  return memoryDb.memoryWrite({ ...unitAsWrite({ ...update, ...(iface ? { iface } : {}) }), now: update.now ?? Date.now() });
}
