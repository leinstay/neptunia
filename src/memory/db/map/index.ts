// The mappers by kind. Each mapper module exports `toRows(rel, value, ctx)` and `fromRows(rows, ctx)`; the pair is an exact
// round trip of the stored value (key order aside).

import type { MapContext } from './common.ts';
import type { Db, Row, Rows } from '../types.ts';
import {
  dmOfPlatformId,
  partnerOfDmAudience,
  partnerPersonOfPlace,
  personOfPlatformId,
  storedDmPlace,
} from '../meta-person.ts';
import { nativeRows } from '../native-rows.ts';
import type { StorageKey } from '../storage-keys.ts';
import * as requests from './requests.ts';
import * as verbatim from './verbatim.ts';

/**
 * What every mapper module offers the unit sync: the rows of a file and the file back from its rows. The methods are
 * written as methods so a module may take the narrower value its own file holds.
 */
export type Mapper = {
  toRows(rel: string, value: unknown, ctx: MapContext): Rows;
  fromRows(rows: Rows, ctx?: MapContext): unknown;
};

export const MAPPERS = {
  requests,
  verbatim,
} satisfies Record<string, Mapper>;

/** The kinds of file the mappers know. */
export type MapperKind = keyof typeof MAPPERS;

/** How a file is read: whole JSON, lines, text or a month of vectors. */
export type FileFormat = 'json' | 'jsonl' | 'text' | 'vectors';

/** The mapper of a storage kind; a kind with none is kept verbatim. */
export const mapperKindOf = (kind: string): MapperKind => (kind in MAPPERS ? (kind as MapperKind) : 'verbatim');

export function storageFormat(key: StorageKey): FileFormat {
  if (key.kind === 'vectors') return 'vectors';
  if (
    ['record', 'journal', 'archive', 'recall_trace', 'archive_pending'].includes(key.kind) ||
    (key.kind === 'intentions' && key.selector?.collection === 'archive')
  )
    return 'jsonl';
  return key.kind === 'journal_running' ? 'text' : 'json';
}

/** The stored identity of an account, a person or a place: its row's interface, native id and person; nothing without a row. */
function identityOf(
  db: Db,
  id: string,
  table: 'accounts' | 'places' | 'people'
): { iface?: string; native?: string; person?: string; row?: Row } {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) return {};
  const native = row.native_id ?? row.native_key;
  return {
    row,
    ...(typeof row.iface === 'string' ? { iface: row.iface } : {}),
    ...(typeof native === 'string' ? { native } : {}),
    ...(typeof row.person_id === 'string' ? { person: row.person_id } : {}),
  };
}

/** Whether a stored place is a direct chat. */
const isDmRow = (place: Row | undefined): place is Row =>
  place !== undefined && (place.kind === 'dm' || place.chat === 'dm');

/** The native id of the partner of a stored DM place, from its partner account's row; null for any other place. */
function partnerNativeOf(db: Db, place: Row | undefined): string | null {
  if (!isDmRow(place)) return null;
  const account = place.partner_account;
  if (typeof account !== 'string') return null;
  const stored = db.prepare('SELECT native_id FROM accounts WHERE id = ?').get(account)?.native_id;
  return typeof stored === 'string' ? stored : null;
}

const TABLE_OF_SUBJECT = { account: 'accounts', place: 'places', person: 'people', authority: 'places' } as const;

/**
 * Context passed to the existing field mappers for a semantic collection. `iface` is the interface of the write, which
 * names the subject's interface while no row holds the subject yet.
 */
export function storageContext(db: Db, key: StorageKey, iface?: string): MapContext {
  // The persona has no row to read, and its selector still says which of its collections this is.
  if (key.subject.type === 'persona')
    return {
      collection: key.selector?.collection,
      versionKind: key.selector?.versionKind,
      itemId: key.selector?.itemId,
      ...memberReads(db),
    };
  const subject = identityOf(db, key.subject.id, TABLE_OF_SUBJECT[key.subject.type]);
  const partner = key.subject.type === 'place' ? partnerNativeOf(db, subject.row) : null;
  const subjectIface = subject.iface ?? (subject.row ? undefined : iface);
  return {
    ...(subjectIface !== undefined ? { iface: subjectIface } : {}),
    subjectId: key.subject.id,
    ...(subject.native !== undefined ? { subjectNativeId: subject.native } : {}),
    ...(subject.person !== undefined ? { subjectPersonId: subject.person } : {}),
    subjectPlace: key.subject.type === 'place' ? (subject.row ?? null) : null,
    collection: key.selector?.collection,
    versionKind: key.selector?.versionKind,
    itemId: key.selector?.itemId,
    privateAccountId: key.subject.type === 'account' && key.kind !== 'user' ? (subject.native ?? null) : partner,
    ...memberReads(db),
    ...(key.subject.type === 'place' && isDmRow(subject.row)
      ? {
          dmPlaceId: key.subject.id,
          dmPlace: { id: key.subject.id, partnerPerson: partnerPersonOfPlace(db, subject.row) },
        }
      : {}),
  };
}

/** How the mappers reach a member's stored person and direct chat from the platform id a file names. */
function memberReads(
  db: Db
): Pick<
  MapContext,
  | 'personOfMember'
  | 'dmOfMember'
  | 'dmPlaceOf'
  | 'partnerOfDm'
  | 'accountOfMember'
  | 'memberOfAccount'
  | 'placeOfChannel'
  | 'channelOfPlace'
> {
  return {
    ...nativeRows(db),
    personOfMember: (iface, platformId) => personOfPlatformId(db, iface, platformId),
    dmOfMember: (iface, platformId) => dmOfPlatformId(db, iface, platformId),
    dmPlaceOf: (placeId) => storedDmPlace(db, placeId),
    partnerOfDm: (audienceId) => partnerOfDmAudience(db, audienceId),
  };
}

/** Owner conversion preserves legacy provenance only for the explicit importer. */
function ownedRows(db: Db, rows: Rows, id: string, position: number | undefined, legacyOwner?: string): Rows {
  for (const list of Object.values(rows))
    for (const row of list) {
      if (row.owner_file !== undefined) {
        delete row.owner_file;
        row.owner_key = id;
      }
      if (row.owner_key !== undefined) row.owner_key = id;
      if (legacyOwner && row.owner_key !== undefined) row.owner_file = legacyOwner;
      if (list === rows.operational) {
        const existing = db
          .prepare('SELECT owner FROM operational WHERE kind = ? AND owner_key = ? ORDER BY rowid LIMIT 1')
          .get(row.kind, id);
        if (existing && position === undefined) row.owner = existing.owner;
      }
    }
  return rows;
}

/** Existing field conversion with semantic owner and context. */
export function storageMapper(
  db: Db,
  key: StorageKey,
  id: string,
  legacyOwner?: string
): { mapper: Mapper; kind: MapperKind; format: FileFormat } {
  const kind: MapperKind = mapperKindOf(key.kind);
  const original = MAPPERS[kind] as Mapper;
  const base = storageContext(db, key);
  const toRows = (_rel: string, value: unknown, ctx: MapContext): Rows => {
    const context = {
      ...ctx,
      ...base,
      position: ctx.position,
      hotClaimIds: ctx.hotClaimIds,
    };
    const rows =
      kind === 'verbatim'
        ? { operational: [verbatim.operationalRow(key.kind, id, value as Row, context)] }
        : original.toRows(id, value, context);
    return ownedRows(db, rows, id, context.position, legacyOwner);
  };
  return {
    kind,
    format: storageFormat(key),
    mapper: {
      ...original,
      toRows,
      fromRows: (rows) => original.fromRows(rows, base),
    },
  };
}
