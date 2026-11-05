// Record readers enumerate semantic day collections and preserve native message-family identity.

import { communityKey, storageId } from '../storage-keys.ts';
import { listUnits } from '../storage-units.ts';

import type { StorageKey } from '../storage-keys.ts';
import { storageContext } from '../map/index.ts';
import { LEGACY_IFACE } from '../legacy-namespace.ts';
import { guildPlaceId } from '../ids.ts';
import { hasMessageFamilies } from '../message-family-catalog.ts';
import { unitLines, layerDir } from './common.ts';
import type { NativeMessageLocator } from '../recall.ts';
import type { Db } from '../types.ts';

/** An explicit legacy export directory, independent of live storage ownership. */
export const recordDirOf = (guildId: unknown, privateUserId: string | null = null): string =>
  layerDir(String(guildId), privateUserId, 'record');

function daysOf(db: Db, guildId: unknown, privateUserId: string | null, iface: string) {
  const key = communityKey('record', String(guildId), { iface, privateUserId });
  return listUnits(db, { kind: 'record', subject: key.subject, scopePlaceId: key.scopePlaceId });
}

export function recordMonths(
  db: Db,
  guildId: unknown,
  privateUserId: string | null = null,
  iface = LEGACY_IFACE
): Array<string> {
  return [
    ...new Set(
      daysOf(db, guildId, privateUserId, iface)
        .map((unit) => unit.key.partition?.slice(0, 7))
        .filter((month): month is string => Boolean(month))
    ),
  ].sort();
}

export function recordDays(
  db: Db,
  guildId: unknown,
  privateUserId: string | null,
  month: string,
  iface = LEGACY_IFACE
): Array<{ day: string; owner: StorageKey }> {
  return daysOf(db, guildId, privateUserId, iface)
    .filter((unit) => unit.key.partition?.startsWith(`${month}-`))
    .map((unit) => ({ day: unit.key.partition!, owner: unit.key }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

export const recordLines = (db: Db, key: StorageKey): Array<string> => unitLines(db, key);

export function recordNewestRevision(
  db: Db,
  guildId: unknown,
  privateUserId: string | null,
  month: string,
  messageId: unknown,
  locator?: NativeMessageLocator,
  iface = locator?.iface ?? LEGACY_IFACE
): number | null {
  const units = daysOf(db, guildId, privateUserId, iface).filter((unit) => unit.key.partition?.startsWith(`${month}-`));
  if (!units.length) return null;
  const family = locator
    ? db
        .prepare('SELECT * FROM message_families WHERE iface=? AND conversation_id=? AND message_id=? AND generation=1')
        .get(locator.iface, locator.conversationId, locator.messageId)
    : null;
  if (locator && (!family || locator.messageId !== messageId)) return null;
  // With no locator the message id still names its family: an observed line holds the family's key.
  const clause = family
    ? 'authority_id=? AND native_kind=? AND native_id=? AND generation=?'
    : hasMessageFamilies(db)
      ? 'native_id IN (?, (SELECT native_key FROM message_families WHERE iface=? AND message_id=? AND generation=1))'
      : 'native_id=?';
  const values = family
    ? [family.authority_id, family.native_kind, family.native_key, family.generation]
    : hasMessageFamilies(db)
      ? [String(messageId), iface, String(messageId)]
      : [String(messageId)];
  const ids = units.map((unit) => storageId(unit.key));
  const rows = db
    .prepare(
      `SELECT kind,revision FROM sources WHERE ${clause} AND owner_key IN (${ids.map(() => '?').join(',')}) AND retired_at IS NULL`
    )
    .all(...values, ...ids);
  let newest: number | null = null;
  for (const row of rows)
    if (row.kind !== 'deleted') {
      const revision = Number.isInteger(row.revision) && Number(row.revision) > 0 ? Number(row.revision) : 1;
      newest = Math.max(newest ?? 0, revision);
    }
  return newest;
}

export function recordLayers(db: Db, guildId: unknown, iface = LEGACY_IFACE): Array<string> {
  return [
    ...new Set(
      listUnits(db, { kind: 'record', scopePlaceId: guildPlaceId(iface, guildId) })
        .filter((unit) => unit.key.subject.type === 'account')
        .map((unit) => storageContext(db, unit.key).subjectNativeId!)
    ),
  ].sort();
}

export function recordStats(
  db: Db,
  guildId: unknown,
  iface = LEGACY_IFACE
): { messages: number; days: number; first: string | null } {
  const days = daysOf(db, guildId, null, iface);
  const ids = days.map((unit) => unit.id);
  const messages = ids.length
    ? Number(
        db
          .prepare(
            `SELECT COUNT(DISTINCT json_array(iface,authority_id,native_kind,native_id,generation)) AS n FROM sources
    WHERE native_id IS NOT NULL AND owner_key IN (${ids.map(() => '?').join(',')}) AND retired_at IS NULL`
          )
          .get(...ids)?.n
      )
    : 0;
  return { messages, days: days.length, first: days.map((unit) => unit.key.partition!).sort()[0] ?? null };
}
