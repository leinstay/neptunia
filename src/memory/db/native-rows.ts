// The stored row of a member or a channel an interface names by its own id, and that id read back from the row. The
// line and list writers name the authors and chats a value holds this way (map/scope-parts.ts, record-lines.ts,
// participation-episodes.ts, recent-lines.ts, archive-lines.ts). A member or a channel no row holds yet takes the id the
// observation would give it (`mintedAccount`, `mintedChannel`) and reads back nothing: no id is taken apart.

import { interfaceAccountId, interfacePlaceOf, nativeAuthorityOf } from './ids.ts';
import type { Spec } from './map/common.ts';
import type { Db } from './types.ts';

/** The statements of a connection, prepared once: a line write and a day read run them once per line. */
const statements = new WeakMap<Db, Map<string, ReturnType<Db['prepare']>>>();
function prepared(db: Db, sql: string): ReturnType<Db['prepare']> {
  let cache = statements.get(db);
  if (!cache) statements.set(db, (cache = new Map<string, ReturnType<Db['prepare']>>()));
  let statement = cache.get(sql);
  if (!statement) cache.set(sql, (statement = db.prepare(sql)));
  return statement;
}

const textOf = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** The id the observation gives a member of `iface` no row holds yet (ids.ts#interfaceAccountId). */
export const mintedAccount = (iface: string, native: string): string =>
  interfaceAccountId(nativeAuthorityOf(iface), native);

/** The id the observation gives a channel of `iface` no row holds yet (ids.ts#interfacePlaceOf). */
export const mintedChannel = (iface: string, native: string): string =>
  interfacePlaceOf(nativeAuthorityOf(iface), `channel:${native}`).id;

/** The account of member `native` on `iface`: its newest generation under the interface's authority, null for none. */
export function accountOfMember(db: Db, iface: string, native: string): string | null {
  const row = prepared(
    db,
    'SELECT id FROM accounts WHERE authority_id = ? AND native_key = ? ORDER BY generation DESC LIMIT 1'
  ).get(nativeAuthorityOf(iface), native);
  return textOf(row?.id);
}

/** The interface's own id of a stored account, null for an account no row holds. */
export function memberOfAccount(db: Db, accountId: string): string | null {
  return textOf(prepared(db, 'SELECT native_id FROM accounts WHERE id = ?').get(accountId)?.native_id);
}

/** The place of channel `native` on `iface`: its newest generation under the interface's authority, null for none. */
export function placeOfChannel(db: Db, iface: string, native: string): string | null {
  const row = prepared(
    db,
    'SELECT id FROM places WHERE authority_id = ? AND native_key = ? ORDER BY generation DESC LIMIT 1'
  ).get(nativeAuthorityOf(iface), `channel:${native}`);
  return textOf(row?.id);
}

/** The interface's own id of a stored channel, null for a place that is no stored channel. */
export function channelOfPlace(db: Db, placeId: string): string | null {
  return textOf(prepared(db, "SELECT native_id FROM places WHERE id = ? AND kind = 'channel'").get(placeId)?.native_id);
}

/** The four readers over one connection, in the shape the mappers' context carries them. */
export function nativeRows(db: Db): {
  accountOfMember: (iface: string, native: string) => string | null;
  memberOfAccount: (accountId: string) => string | null;
  placeOfChannel: (iface: string, native: string) => string | null;
  channelOfPlace: (placeId: string) => string | null;
} {
  return {
    accountOfMember: (iface, native) => accountOfMember(db, iface, native),
    memberOfAccount: (accountId) => memberOfAccount(db, accountId),
    placeOfChannel: (iface, native) => placeOfChannel(db, iface, native),
    channelOfPlace: (placeId) => channelOfPlace(db, placeId),
  };
}

/**
 * The column of a value's channel (`placeId`, a channel's own id): the channel's place, read back from that place's row.
 * A channel no row holds keeps the id the value gave beside the column (`exact`).
 */
export function channelColumn(db: Db, col: string): Spec {
  return {
    col,
    key: 'placeId',
    type: 'text',
    ok: (v: unknown) => textOf(v) !== null,
    enc: (v: unknown, iface: string) => placeOfChannel(db, iface, String(v)) ?? mintedChannel(iface, String(v)),
    dec: (v: unknown) => (typeof v === 'string' ? channelOfPlace(db, v) : null),
    exact: true,
  };
}
