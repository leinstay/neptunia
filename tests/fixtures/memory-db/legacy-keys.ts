// The neutral key of what the older tests still name as a community collection: its place, spelled as a shipped database
// spells it, with no community scope.
import { placeCollection } from '../../../src/memory/db/storage-keys.ts';
import type { StorageKey, StorageKind, StorageSelector } from '../../../src/memory/db/storage-keys.ts';
import { legacyServerPlaceId } from '../../../src/memory/migration/paths.ts';

export const communityKey = (
  kind: StorageKind,
  id: string,
  { iface = 'discord', partition, selector }: { iface?: string; partition?: string; selector?: StorageSelector } = {}
): StorageKey =>
  placeCollection(kind, legacyServerPlaceId(iface, id), {
    ...(partition ? { partition } : {}),
    ...(selector ? { selector } : {}),
  });
