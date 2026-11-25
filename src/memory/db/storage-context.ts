// The context a writer of a stored value gives the row builders of its kind (src/memory/db/row-columns.ts#MapContext):
// the subject of the value's unit as the database holds it (its interface, native id, person and, for a place, its row
// and the partner of a direct chat), and how a builder reaches a member's stored person, direct chat and account from
// the platform id a value names.

import type { MapContext } from './row-columns.ts';
import type { Db, Row } from './types.ts';
import {
  dmOfPlatformId,
  partnerOfDmAudience,
  partnerPersonOfPlace,
  personOfPlatformId,
  storedDmPlace,
} from './meta-person.ts';
import { nativeRows } from './native-rows.ts';
import type { UnitKey } from './unit-keys.ts';

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
export function storageContext(db: Db, key: UnitKey, iface?: string): MapContext {
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
