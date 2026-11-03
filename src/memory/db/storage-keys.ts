// Semantic addresses of storage collections. Identity and scope are independent of migration paths.

import { createHash } from 'node:crypto';
import { accountId, guildPlaceId } from './ids.ts';
import { LEGACY_IFACE } from './legacy-namespace.ts';

export type StorageSubject = Readonly<{ type: 'persona' | 'account' | 'place' | 'authority'; id: string }>;
export type StorageKind =
  | 'record'
  | 'journal'
  | 'user'
  | 'private'
  | 'channel'
  | 'guild'
  | 'lore'
  | 'participation'
  | 'recent'
  | 'diary'
  | 'intentions'
  | 'errands'
  | 'archive'
  | 'versions'
  | 'vectors'
  | 'media'
  | 'gifs'
  | 'requests'
  | 'state'
  | 'usage'
  | 'metrics'
  | 'inner'
  | 'missed'
  | 'voice'
  | 'buffer'
  | 'forgotten'
  | 'forgetting'
  | 'record_ids'
  | 'record_backfill'
  | 'archive_ids'
  | 'archive_pending'
  | 'recall_trace'
  | 'journal_running'
  | 'backfill'
  | 'request_tools';
export type StorageSelector = Readonly<{
  collection?: 'active' | 'archive' | 'value' | 'history';
  requestId?: string;
  versionKind?: 'users' | 'channels' | 'guild' | 'lore';
  itemId?: string;
}>;
export type StorageKey = Readonly<{
  kind: StorageKind;
  subject: StorageSubject;
  scopePlaceId?: string;
  partition?: string;
  selector?: StorageSelector;
}>;

/** A canonical semantic key, including only fields that identify a collection. */
export function keyText(key: StorageKey): string {
  const selector = key.selector;
  return JSON.stringify({
    kind: key.kind,
    subject: { type: key.subject.type, id: key.subject.id },
    ...(key.scopePlaceId ? { scopePlaceId: key.scopePlaceId } : {}),
    ...(key.partition ? { partition: key.partition } : {}),
    ...(selector
      ? { selector: Object.fromEntries(Object.entries(selector).sort(([a], [b]) => a.localeCompare(b))) }
      : {}),
  });
}

/** The catalog's opaque identity of one semantic collection. */
export const storageId = (key: StorageKey): string =>
  `unit:${createHash('sha256').update(keyText(key)).digest('hex').slice(0, 32)}`;

/** A root core-state collection belongs to this database's persona storage subject. */
export const personaKey = (kind: StorageKind): StorageKey => ({
  kind,
  subject: { type: 'persona', id: 'persona:local' },
});

export type NamespaceSource = { namespace?: () => string | null } | null | undefined;
export function namespaceOf(service: unknown): string {
  const read: unknown = service && typeof service === 'object' ? Reflect.get(service, 'namespace') : null;
  const value: unknown = typeof read === 'function' ? read.call(service) : null;
  return typeof value === 'string' && value ? value : LEGACY_IFACE;
}

/** A community collection, or a member's distinct private collection within that scope. */
export function communityKey(
  kind: StorageKind,
  guildId: string,
  {
    iface = LEGACY_IFACE,
    privateUserId = null,
    partition,
    selector,
  }: { iface?: string; privateUserId?: string | null; partition?: string; selector?: StorageSelector } = {}
): StorageKey {
  const scopePlaceId = guildPlaceId(iface, guildId);
  return {
    kind,
    subject: privateUserId
      ? { type: 'account', id: accountId(iface, privateUserId) }
      : { type: 'place', id: scopePlaceId },
    scopePlaceId,
    ...(partition ? { partition } : {}),
    ...(selector ? { selector } : {}),
  };
}

/** Per-vector-store handles capture semantic identity when a collection is selected. */
export function vectorAddresses(service: NamespaceSource): {
  baseDir: (guildId: string, privateUserId?: string | null) => string;
  monthDir: (base: string, month: string) => string;
  vectorKey: (address: string) => StorageKey;
} {
  const addresses = new Map<string, StorageKey>();
  function baseDir(guildId: string, privateUserId: string | null = null): string {
    const key = communityKey('vectors', guildId, { iface: namespaceOf(service), privateUserId });
    const address = encodeURIComponent(keyText(key));
    addresses.set(address, key);
    return address;
  }
  function monthDir(base: string, month: string): string {
    const key = { ...addresses.get(base)!, partition: month };
    const address = encodeURIComponent(keyText(key));
    addresses.set(address, key);
    return address;
  }
  function vectorKey(address: string): StorageKey {
    const key = addresses.get(address);
    if (!key) throw Object.assign(new Error('UNIT_UNMAPPED'), { code: 'UNIT_UNMAPPED' });
    return key;
  }

  return { baseDir, monthDir, vectorKey };
}

/** A journal day is selected directly from its semantic scope and UTC partition. */
export function journalKey(
  service: NamespaceSource,
  guildId: string,
  day: string,
  privateUserId: string | null = null
): StorageKey {
  return communityKey('journal', guildId, { iface: namespaceOf(service), privateUserId, partition: day });
}

/** One board-backed errand retains its existing per-community collection and item identity. */
export function errandKey(service: unknown, guildId: string, itemId: string): StorageKey {
  return communityKey('errands', guildId, { iface: namespaceOf(service), selector: { collection: 'value', itemId } });
}
