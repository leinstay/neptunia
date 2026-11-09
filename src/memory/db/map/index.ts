// The mappers by kind. Each mapper module exports `toRows(rel, value, ctx)` and `fromRows(rows, ctx)`; the pair is an exact
// round trip of the stored value (key order aside).

import * as archive from './archive.ts';
import * as channel from './channel.ts';
import * as selfreflection from './selfreflection.ts';
import * as errands from './errands.ts';
import * as gifs from './gifs.ts';
import type { MapContext } from './common.ts';
import type { Db, Row, Rows } from '../types.ts';
import { dmPartnerOfPlace, nativeOfAny, personId } from '../ids.ts';
import {
  dmOfAccount,
  dmOfPlatformId,
  partnerOfDmAudience,
  partnerPersonOfPlace,
  personOfPlatformId,
  storedDmPlace,
} from '../meta-person.ts';
import { ensureAccountPerson, linkedProfileUnit } from '../person-links.ts';
import { accountCollection, storageId } from '../storage-keys.ts';
import type { StorageKey } from '../storage-keys.ts';
import * as journal from './journal.ts';
import * as lore from './lore.ts';
import * as media from './media.ts';
import * as participation from './participation.ts';
import * as place from './place.ts';
import * as privateLayer from './private.ts';
import * as recent from './recent.ts';
import * as requests from './requests.ts';
import * as user from './user.ts';
import * as verbatim from './verbatim.ts';
import * as versions from './versions.ts';

/**
 * What every mapper module offers the unit sync: the rows of a file and the file back from its rows. The methods are
 * written as methods so a module may take the narrower value its own file holds.
 */
export type Mapper = {
  toRows(rel: string, value: unknown, ctx: MapContext): Rows;
  fromRows(rows: Rows, ctx?: MapContext): unknown;
};

export const MAPPERS = {
  journal,
  user,
  private: privateLayer,
  channel,
  place,
  lore,
  participation,
  recent,
  selfreflection,
  errands,
  archive,
  versions,
  media,
  gifs,
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
    (key.kind === 'intentions' && key.selector?.collection === 'archive') ||
    (key.kind === 'errands' && key.selector?.collection === 'history')
  )
    return 'jsonl';
  return key.kind === 'journal_running' ? 'text' : 'json';
}

/** The exact stored identity of an account, a person or a place; an id with no row answers from its own spelling. */
function identityOf(
  db: Db,
  id: string,
  table: 'accounts' | 'places' | 'people'
): { iface: string; native: string; person?: string; row?: Row } {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  const native = row?.native_id ?? row?.native_key ?? nativeOfAny(id) ?? id;
  const iface = row?.iface ?? id.split(':')[0];
  if (typeof native !== 'string' || typeof iface !== 'string')
    throw Object.assign(new Error('UNIT_IDENTITY'), { code: 'UNIT_IDENTITY' });
  return {
    iface,
    native,
    ...(row ? { row } : {}),
    ...(typeof row?.person_id === 'string' ? { person: row.person_id } : {}),
  };
}

/**
 * A DM place subject as the mappers scope by it: the partner person of its row (meta-person.ts#partnerPersonOfPlace).
 * A place no row holds is a legacy file imported before its place exists, and names the partner its id spells
 * (legacy-namespace.ts), which the writer stores with the place.
 */
function dmPlaceOfSubject(db: Db, id: string, place: Row | undefined): NonNullable<MapContext['dmPlace']> {
  return { id, partnerPerson: place ? partnerPersonOfPlace(db, place) : (dmPartnerOfPlace(id)?.person ?? null) };
}

/** The native id of the partner of a stored DM place, or null for any other place. */
function partnerNativeOf(db: Db, id: string, place: Row | undefined): string | null {
  // A DM place no row holds yet (a kept write of an older release): its spelled id names the partner.
  if (!place) return /^[^:]+:dm:(.+)$/.exec(id)?.[1] ?? null;
  if (place.kind !== 'dm' && place.chat !== 'dm') return null;
  const account = place.partner_account;
  if (typeof account === 'string') {
    const stored = db.prepare('SELECT native_id FROM accounts WHERE id = ?').get(account)?.native_id;
    if (typeof stored === 'string') return stored;
  }
  const key = typeof place.native_key === 'string' ? /^dm:(.+)$/.exec(place.native_key)?.[1] : undefined;
  return key ?? null;
}

const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';

const TABLE_OF_SUBJECT = { account: 'accounts', place: 'places', person: 'people', authority: 'places' } as const;

/** Context passed to the existing field mappers for a semantic collection. */
export function storageContext(db: Db, key: StorageKey): MapContext {
  // The persona has no row to read, and its selector still says which of its collections this is.
  if (key.subject.type === 'persona')
    return {
      collection: key.selector?.collection,
      versionKind: key.selector?.versionKind,
      itemId: key.selector?.itemId,
      ...memberReads(db),
    };
  const subject = identityOf(db, key.subject.id, TABLE_OF_SUBJECT[key.subject.type]);
  const partner = key.subject.type === 'place' ? partnerNativeOf(db, key.subject.id, subject.row) : null;
  return {
    iface: subject.iface,
    subjectId: key.subject.id,
    subjectNativeId: subject.native,
    subjectPersonId: subject.person ?? personId(subject.iface, subject.native),
    subjectPlace: key.subject.type === 'place' ? (subject.row ?? null) : null,
    collection: key.selector?.collection,
    versionKind: key.selector?.versionKind,
    itemId: key.selector?.itemId,
    privateAccountId: key.subject.type === 'account' && key.kind !== 'user' ? subject.native : partner,
    ...memberReads(db),
    ...(key.subject.type === 'place' && partner !== null
      ? { dmPlaceId: key.subject.id, dmPlace: dmPlaceOfSubject(db, key.subject.id, subject.row) }
      : {}),
    ...(key.kind === 'private' && key.subject.type === 'account' ? { dmPlace: dmOfAccount(db, key.subject.id) } : {}),
    ...(key.kind === 'user' && key.subject.type === 'account' ? { membership: membershipOf(db, key.subject.id) } : {}),
    ...(key.kind === 'versions' && key.subject.type === 'account' && key.selector?.versionKind === 'users'
      ? profilePersonOf(db, key.subject.id)
      : {}),
  };
}

/** How the mappers reach a member's stored person and direct chat from the platform id a file names. */
function memberReads(db: Db): Pick<MapContext, 'personOfMember' | 'dmOfMember' | 'dmPlaceOf' | 'partnerOfDm'> {
  return {
    personOfMember: (iface, platformId) => personOfPlatformId(db, iface, platformId),
    dmOfMember: (iface, platformId) => dmOfPlatformId(db, iface, platformId),
    dmPlaceOf: (placeId) => storedDmPlace(db, placeId),
    partnerOfDm: (audienceId) => partnerOfDmAudience(db, audienceId),
  };
}

/** The person whose `people` row the account's profile unit owns, which its description versions belong to. */
function profilePersonOf(db: Db, accountId: string): Pick<MapContext, 'profilePersonId'> {
  const unit = storageId(accountCollection('user', accountId));
  const owned = db.prepare('SELECT id FROM people WHERE owner_key = ? AND retired_at IS NULL LIMIT 1').get(unit);
  return typeof owned?.id === 'string' ? { profilePersonId: owned.id } : {};
}

/** The one membership row a user unit writes: its id and place, as stored. */
function membershipOf(db: Db, accountId: string): MapContext['membership'] {
  const row = db
    .prepare('SELECT id, place_id FROM memberships WHERE account_id = ? ORDER BY id LIMIT 1')
    .get(accountId);
  return typeof row?.id === 'string'
    ? { id: row.id, placeId: typeof row.place_id === 'string' ? row.place_id : null }
    : null;
}

/**
 * What a member's unit `id` writes under: the person whose `people` row it owns (a linked account's dormant row keeps its
 * own id), or only the account's own facts when another unit holds the person's profile. A stored account with no
 * person gets a meta-person first, never one spelled from its native id. The account row keeps the link the database
 * holds.
 */
function memberWriteContext(db: Db, id: string, subjectId: string): MapContext {
  const owned = db.prepare('SELECT id FROM people WHERE owner_key = ? AND retired_at IS NULL LIMIT 1').get(id);
  // A stored account with no person gets its meta-person before its profile is written (plan 2026-11-08-meta-person).
  const stored = db.prepare('SELECT person_id FROM accounts WHERE id = ?').get(subjectId);
  const person =
    typeof owned?.id !== 'string' && stored !== undefined && !filled(stored.person_id)
      ? ensureAccountPerson(db, subjectId, new Date().toISOString())
      : null;
  const account = db.prepare('SELECT person_id, link, linked_by, linked_at FROM accounts WHERE id = ?').get(subjectId);
  const accountLink =
    typeof account?.person_id === 'string' && account.person_id
      ? {
          person_id: account.person_id,
          link: account.link,
          linked_by: account.linked_by,
          linked_at: account.linked_at,
        }
      : undefined;
  if (typeof owned?.id === 'string') return { subjectPersonId: owned.id, accountLink };
  if (linkedProfileUnit(db, subjectId)) return { accountOnly: true, accountLink };
  return person === null ? { accountLink } : { subjectPersonId: person, accountLink };
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
      ...(key.kind === 'user' && key.subject.type === 'account' ? memberWriteContext(db, id, key.subject.id) : {}),
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
