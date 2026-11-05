// Record readers enumerate semantic day collections and preserve native message-family identity.

import { placeOrPersona, storageId } from '../storage-keys.ts';
import { listUnits } from '../storage-units.ts';

import type { StorageKey } from '../storage-keys.ts';
import { LEGACY_IFACE } from '../legacy-namespace.ts';
import { hasMessageFamilies } from '../message-family-catalog.ts';
import { unitLines } from './common.ts';
import type { NativeMessageLocator } from '../recall.ts';
import type { Db } from '../types.ts';

function daysOf(db: Db, placeId: string | null) {
  return listUnits(db, { kind: 'record', subject: placeOrPersona('record', placeId).subject });
}

export function recordMonths(db: Db, placeId: string | null): Array<string> {
  return [
    ...new Set(
      daysOf(db, placeId)
        .map((unit) => unit.key.partition?.slice(0, 7))
        .filter((month): month is string => Boolean(month))
    ),
  ].sort();
}

export function recordDays(db: Db, placeId: string | null, month: string): Array<{ day: string; owner: StorageKey }> {
  return daysOf(db, placeId)
    .filter((unit) => unit.key.partition?.startsWith(`${month}-`))
    .map((unit) => ({ day: unit.key.partition!, owner: unit.key }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

export const recordLines = (db: Db, key: StorageKey): Array<string> => unitLines(db, key);

/** The interface of the place that holds a record: its stored one, else its spelled id's. */
function ifaceOfHolder(db: Db, placeId: string | null): string {
  if (placeId === null) return LEGACY_IFACE;
  const stored = db.prepare('SELECT iface FROM places WHERE id = ?').get(placeId)?.iface;
  return typeof stored === 'string' ? stored : (placeId.split(':')[0] ?? LEGACY_IFACE);
}

export function recordNewestRevision(
  db: Db,
  placeId: string | null,
  month: string,
  messageId: unknown,
  locator?: NativeMessageLocator,
  iface = locator?.iface ?? ifaceOfHolder(db, placeId)
): number | null {
  const units = daysOf(db, placeId).filter((unit) => unit.key.partition?.startsWith(`${month}-`));
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

export function recordStats(db: Db, placeId: string | null): { messages: number; days: number; first: string | null } {
  const days = daysOf(db, placeId);
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

/** Every place that holds a record. */
export function recordHolders(db: Db): Array<string> {
  const holders = new Set<string>();
  for (const unit of listUnits(db, { kind: 'record' }))
    if (unit.key.subject.type === 'place') holders.add(unit.key.subject.id);
  return [...holders].sort();
}
