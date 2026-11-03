// Archive collections are selected by semantic scope, subject and UTC month.

import { communityKey } from '../storage-keys.ts';
import { listUnits } from '../storage-units.ts';
import { storageContext } from '../map/index.ts';
import { guildPlaceId } from '../ids.ts';
import { LEGACY_IFACE } from '../legacy-namespace.ts';
import { layerDir, unitLines } from './common.ts';
import type { Db } from '../types.ts';

/** The directory of the explicit legacy export adapter. */
export const archiveDirOf = (guildId: unknown, privateUserId: string | null = null): string =>
  layerDir(String(guildId), privateUserId, 'archive');

export function archiveMonths(
  db: Db,
  guildId: unknown,
  privateUserId: string | null = null,
  iface = LEGACY_IFACE
): Array<string> {
  const key = communityKey('archive', String(guildId), { iface, privateUserId });
  return listUnits(db, { kind: key.kind, subject: key.subject, scopePlaceId: key.scopePlaceId })
    .map((unit) => unit.key.partition!)
    .filter(Boolean)
    .sort();
}

export function archiveLines(
  dbGiven: unknown,
  guildIdGiven: unknown,
  privateUserIdGiven: unknown,
  monthGiven: unknown,
  iface = LEGACY_IFACE
): Array<string> {
  return unitLines(
    dbGiven,
    communityKey('archive', String(guildIdGiven), {
      iface,
      privateUserId: privateUserIdGiven as string | null,
      partition: String(monthGiven),
    })
  );
}

export function archiveLayers(db: Db, guildId: unknown, iface = LEGACY_IFACE): Array<string> {
  return [
    ...new Set(
      listUnits(db, { kind: 'archive', scopePlaceId: guildPlaceId(iface, guildId) })
        .filter((unit) => unit.key.subject.type === 'account')
        .map((unit) => storageContext(db, unit.key).subjectNativeId!)
    ),
  ].sort();
}
