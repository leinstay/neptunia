// Semantic addresses of storage collections. A collection belongs to the persona, an account, a person or a place, and its
// key holds that id as given: nothing is read from the air, and nothing here takes an id apart.

import { createHash } from 'node:crypto';

export type StorageSubject = Readonly<{ type: 'persona' | 'account' | 'person' | 'place' | 'authority'; id: string }>;
export type StorageKind =
  | 'record'
  | 'journal'
  | 'user'
  | 'private'
  | 'channel'
  | 'place'
  | 'lore'
  | 'participation'
  | 'recent'
  | 'selfreflection'
  | 'intentions'
  | 'errands'
  | 'archive'
  | 'versions'
  | 'vectors'
  | 'media'
  | 'gifs'
  | 'emoji_rails'
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
  versionKind?: 'users' | 'channels' | 'place' | 'lore' | 'media';
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

/** The persona's own id as a place id: a turn or a write of hers that happens nowhere. */
export const PERSONA_ID = 'persona:local';

/** A root core-state collection belongs to this database's persona storage subject. */
export const personaKey = (kind: StorageKind): StorageKey => ({
  kind,
  subject: { type: 'persona', id: PERSONA_ID },
});

export type CollectionOptions = { partition?: string; selector?: StorageSelector };

function collectionOf(
  kind: StorageKind,
  type: 'account' | 'person' | 'place',
  id: string,
  { partition, selector }: CollectionOptions = {}
): StorageKey {
  if (typeof id !== 'string' || id === '')
    throw Object.assign(new Error('BAD_COLLECTION_ID'), { code: 'BAD_COLLECTION_ID' });
  return {
    kind,
    subject: id === PERSONA_ID ? { type: 'persona', id } : { type, id },
    ...(partition ? { partition } : {}),
    ...(selector ? { selector } : {}),
  };
}

/** A collection of one concrete account. */
export const accountCollection = (kind: StorageKind, accountId: string, options?: CollectionOptions): StorageKey =>
  collectionOf(kind, 'account', accountId, options);

/** A collection of one person. */
export const personCollection = (kind: StorageKind, personId: string, options?: CollectionOptions): StorageKey =>
  collectionOf(kind, 'person', personId, options);

/** A collection of one place: a server, a channel, a thread, a group or a DM. */
export const placeCollection = (kind: StorageKind, placeId: string, options?: CollectionOptions): StorageKey =>
  collectionOf(kind, 'place', placeId, options);

/** A collection of one place, or of the persona when no place holds it. */
export const placeOrPersona = (
  kind: StorageKind,
  placeId: string | null,
  options: CollectionOptions = {}
): StorageKey =>
  placeId === null || placeId === PERSONA_ID
    ? { ...personaKey(kind), ...options }
    : placeCollection(kind, placeId, options);

/** A journal day of one place. */
export const journalKey = (placeId: string, day: string): StorageKey =>
  placeCollection('journal', placeId, { partition: day });

/** One board-backed errand: a collection of the persona, with its item identity. */
export const errandKey = (itemId: string): StorageKey => ({
  ...personaKey('errands'),
  selector: { collection: 'value', itemId },
});
