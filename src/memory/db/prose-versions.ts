// The previous texts of one prose owner: a member's profile (`users`), a channel's map entry (`channels`), a place's
// notes (`place`) or a lorebook entry (`lore`), each field a list `[ { at, by, chars, before, after, kept, removed,
// added, text, itemId? }, ... ]` (src/memory/store.ts#recordVersion). The store writes a history through the write kind
// `prose-versions` (session-write.ts) and reads it back through `proseVersionsValue` below. A history is owned by the
// unit `{ kind: 'versions', subject, selector: { versionKind, itemId } }`, its subject the account of a member's
// profile and the place of the others. The describer's versions of a picture (`versionKind` `media`) have their own
// path (unit-write.ts#writeMediaDescriptions).
//
// Each entry is a `description_versions` row with id `<description id>:v<position>`: `at` is written_at, `by` the
// author, origin legacy; `before`, `after`, `itemId` and unnamed keys are in `extra`. The description a field belongs
// to is named like the profile writers name it: a member's `desc:<person>:<field>` under the person whose `people` row
// the member's profile unit owns, `desc:person:<iface>:<id>:<field>` when no unit owns one, a channel's
// `desc:<place id>:<field>`, a place's `desc:<place id>:<field>`, a lorebook entry's `desc:lore:<key>:<field>`. One
// `operational` row (kind versions) keeps `{ $has: { <field>: <description id> } }`, so a field with no versions stays
// an empty list, and every field that is not a list of objects.

import { channelPlaceId, personId } from './ids.ts';
import { extraText, ifaceOf, isPlainObject, join, ordered, parseExtra, put, rowsOf, split } from './map/common.ts';
import type { Spec } from './map/common.ts';
import { storageContext } from './map/index.ts';
import { accountCollection, keyText, placeCollection } from './storage-keys.ts';
import type { StorageKey } from './storage-keys.ts';
import { ensureUnit } from './storage-units.ts';
import { writeMapping } from './upsert.ts';
import { heldRows, holdsAny, profileOwnerOf, retireProfileAbsent, stampProfileRows } from './profile-owner.ts';
import { noteUnit } from './unit-write.ts';
import { dbOf, isFiniteNumber } from './types.ts';
import type { Db, MemoryHandle, Row, Rows } from './types.ts';

/** The prose owners whose previous texts are kept. */
const PROSE_KINDS = ['users', 'channels', 'place', 'lore'] as const;
export type ProseKind = (typeof PROSE_KINDS)[number];

/** One write of the kind: the whole history of one prose owner. `subjectId` is the account of `users`, else a place. */
export type ProseVersionsWrite = { versionKind: ProseKind; subjectId: string; itemId: string; value: Row };

/** What a write answers: the rows it wrote and the rows it retired. */
export type ProseVersionsResult = { upserted: number; retired: number };

const SPEC: Array<Spec> = [
  { col: 'written_at', key: 'at', type: 'text' },
  { col: 'author', key: 'by', type: 'text' },
  { col: 'chars', key: 'chars', type: 'num' },
  { col: 'kept', key: 'kept', type: 'num' },
  { col: 'removed', key: 'removed', type: 'num' },
  { col: 'added', key: 'added', type: 'num' },
  { col: 'text', key: 'text', type: 'text' },
  { col: 'reason', key: 'reason', type: 'text' },
];

const coded = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isProseKind = (value: unknown): value is ProseKind => PROSE_KINDS.includes(value as ProseKind);

/** The unit of one prose owner's history. */
export function proseVersionsKey({ versionKind, subjectId, itemId }: Omit<ProseVersionsWrite, 'value'>): StorageKey {
  const selector = { versionKind, itemId };
  return versionKind === 'users'
    ? accountCollection('versions', subjectId, { selector })
    : placeCollection('versions', subjectId, { selector });
}

/** The person whose `people` row the account's profile unit owns, which its description versions belong to. */
function profilePersonOf(db: Db, accountId: string): string | null {
  const holder = profileOwnerOf(accountCollection('user', accountId))!; // a `user` unit always has its owner columns
  const [owned] = heldRows(db, holder, ['people']).people ?? [];
  return typeof owned?.id === 'string' ? owned.id : null;
}

/**
 * The prefix of the description ids of the history unit `key` (`id` its id): `desc:<subject id>`. A unit of an older
 * layout without an item or a kind falls back to what its subject or its id name.
 */
function descriptionPrefix(db: Db, key: StorageKey, id: string): string {
  const ctx = storageContext(db, key);
  const kind = key.selector?.versionKind;
  if (!kind) return `desc:unknown:${id}`;
  const item = ctx.itemId ?? ctx.subjectNativeId ?? ctx.subjectId ?? id;
  const iface = ifaceOf(ctx);
  if (kind === 'users') {
    const owned = key.subject.type === 'account' ? profilePersonOf(db, key.subject.id) : null;
    return `desc:${owned ?? personId(iface, item)}`;
  }
  if (kind === 'channels') return `desc:${channelPlaceId(iface, item)}`;
  // The persona's own notes have no subject row: their item names them.
  if (kind === 'place') return `desc:${ctx.subjectId ?? item}`;
  return `desc:${kind}:${item}`;
}

/** The rows of a history `value` in the unit `owner`, its description ids under `prefix`. */
function proseVersionsRows(value: Row, prefix: string, owner: string): Rows {
  const rows: Rows = {};
  const rest = { ...value };
  const has: Row = {};
  for (const [field, list] of Object.entries(value)) {
    if (!Array.isArray(list) || !list.every(isPlainObject)) continue;
    const descriptionId = `${prefix}:${field}`;
    has[field] = descriptionId;
    delete rest[field];
    list.forEach((item, position) => {
      const part = split(item, SPEC);
      put(rows, 'description_versions', {
        id: `${descriptionId}:v${position}`,
        description_id: descriptionId,
        ...part.cols,
        origin: 'legacy',
        extra: extraText(part.rest),
        owner_key: owner,
        position,
      });
    });
  }
  rest.$has = has;
  put(rows, 'operational', { kind: 'versions', owner, value: JSON.stringify(rest), owner_key: owner });
  return rows;
}

/** The history its rows give back. */
function proseVersionsOf(rows: Rows): Row {
  const rest = parseExtra(rowsOf(rows, 'operational')[0]?.value);
  const has = isPlainObject(rest.$has) ? rest.$has : {};
  delete rest.$has;
  const obj: Row = {};
  const versions = ordered(rows, 'description_versions');
  for (const [field, descriptionId] of Object.entries(has)) {
    obj[field] = versions
      .filter((row) => row.description_id === descriptionId)
      .map((row) => join(row, row.extra, SPEC));
  }
  return { ...rest, ...obj };
}

/**
 * Stores the whole history the unit `key` holds inside the caller's transaction and retires what it no longer holds.
 * `legacyOwner` is an owner path of an older release.
 */
export function writeProseVersions(
  db: Db,
  key: StorageKey,
  value: Row,
  { at, legacyOwner }: { at: string; legacyOwner?: string }
): ProseVersionsResult {
  const id = ensureUnit(db, key);
  if (legacyOwner) {
    db.prepare('INSERT OR IGNORE INTO legacy_unit_aliases(path,unit_id) VALUES (?,?)').run(legacyOwner, id);
    db.prepare('INSERT OR IGNORE INTO files(path,kind) VALUES (?,?)').run(legacyOwner, 'versions');
  }
  const holder = profileOwnerOf(key)!; // a `versions` unit always has its owner columns (profile-owner.ts)
  const mapping = stampProfileRows(proseVersionsRows(value, descriptionPrefix(db, key, id), id), holder);
  // The history's operational row keeps the owner it was first stored under (an older release's path).
  const [operational] = mapping.operational;
  const stored = db
    .prepare(
      "SELECT owner FROM operational WHERE kind = 'versions' AND writer = ? AND holder_id = ? ORDER BY rowid LIMIT 1"
    )
    .get(holder.writer, holder.holder_id);
  if (stored) operational.owner = stored.owner;
  if (legacyOwner) for (const list of Object.values(mapping)) for (const row of list) row.owner_file = legacyOwner;
  const upserted = writeMapping(db, mapping, id, { at });
  const retired = retireProfileAbsent(db, holder, mapping, at);
  noteUnit(db, id, 'versions', { at });
  return { upserted, retired };
}

/** A history's value as the writer takes it: an object, else refused with a code. */
export function proseVersionsValueOf(value: unknown): Row {
  if (!isPlainObject(value)) throw coded('PROSE_VERSIONS_VALUE');
  return value;
}

/** A write as the writer receives it, checked. */
export function proseVersionsWriteOf(update: Row): ProseVersionsWrite {
  if (!isProseKind(update.versionKind)) throw coded('PROSE_VERSIONS_KIND');
  if (!filled(update.subjectId) || !filled(update.itemId)) throw coded('PROSE_VERSIONS_OWNER');
  const value = proseVersionsValueOf(update.value);
  return { versionKind: update.versionKind, subjectId: update.subjectId, itemId: update.itemId, value };
}

/**
 * The write of a unit update of a prose owner's history (a value write of the unit the store names it by), else null.
 * Any other key of the kind stays a unit write, which the writer stores through the same path.
 */
export function proseVersionsOfUnit(update: Row): ProseVersionsWrite | null {
  const key = update.key as StorageKey | undefined;
  if (update.op !== 'value' || key?.kind !== 'versions') return null;
  const { versionKind, itemId } = key.selector ?? {};
  if (!isProseKind(versionKind) || !filled(itemId)) return null;
  const write = { versionKind, subjectId: key.subject.id, itemId };
  if (keyText(proseVersionsKey(write)) !== keyText(key)) return null;
  return proseVersionsWriteOf({ ...write, value: update.value ?? {} });
}

/** The write kind `prose-versions` on the writer connection (session-write.ts). */
export function applyProseVersionsWrite(handle: MemoryHandle, update: Row): ProseVersionsResult {
  const write = proseVersionsWriteOf(update);
  const at = new Date(isFiniteNumber(update.now) ? update.now : Date.now()).toISOString();
  return handle.transaction(() => writeProseVersions(dbOf(handle), proseVersionsKey(write), write.value, { at }));
}

/**
 * The history the unit `key` holds, or not found when the database holds no such unit. A picture's versions read the
 * same way: their rows have the same shape.
 */
export function proseVersionsValue(db: Db, key: StorageKey): { found: true; value: unknown } | { found: false } {
  const holder = profileOwnerOf(key);
  if (!holder || !holdsAny(db, holder, 'operational')) return { found: false };
  return { found: true, value: proseVersionsOf(heldRows(db, holder, ['description_versions', 'operational'])) };
}
