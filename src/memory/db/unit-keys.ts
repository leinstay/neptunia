// The addresses of the values the store reads and writes. A value belongs to the persona, an account, a person or a
// place, and its key holds that id as given: nothing is read from the air, and nothing here takes an id apart. A key
// registers nothing: the readers find a value by its kind and subject (readers/common.ts), and its rows name their
// owner in their own columns.

import { createHash } from 'node:crypto';
import { PERSONA_ID } from './ids.ts';

export type UnitSubject = Readonly<{ type: 'persona' | 'account' | 'person' | 'place'; id: string }>;
export type UnitKind =
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
export type UnitSelector = Readonly<{
  collection?: 'active' | 'archive' | 'value' | 'history';
  requestId?: string;
  versionKind?: 'users' | 'channels' | 'place' | 'lore' | 'media';
  itemId?: string;
}>;
export type UnitKey = Readonly<{
  kind: UnitKind;
  subject: UnitSubject;
  partition?: string;
  selector?: UnitSelector;
}>;

/** A key as canonical JSON, the fields that identify a value only: the store's name of it. */
export function keyText(key: UnitKey): string {
  const selector = key.selector;
  return JSON.stringify({
    kind: key.kind,
    subject: { type: key.subject.type, id: key.subject.id },
    ...(key.partition ? { partition: key.partition } : {}),
    ...(selector
      ? { selector: Object.fromEntries(Object.entries(selector).sort(([a], [b]) => a.localeCompare(b))) }
      : {}),
  });
}

/**
 * A fixed opaque id of a value, from its key: the `owner` of the `operational` row a new history, participation, recent
 * lines or selfreflection writes.
 */
export const collectionId = (key: UnitKey): string =>
  `unit:${createHash('sha256').update(keyText(key)).digest('hex').slice(0, 32)}`;

/** A root core-state collection belongs to this database's persona storage subject. */
export const personaKey = (kind: UnitKind): UnitKey => ({
  kind,
  subject: { type: 'persona', id: PERSONA_ID },
});

export type CollectionOptions = { partition?: string; selector?: UnitSelector };

function collectionOf(
  kind: UnitKind,
  type: 'account' | 'person' | 'place',
  id: string,
  { partition, selector }: CollectionOptions = {}
): UnitKey {
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
export const accountCollection = (kind: UnitKind, accountId: string, options?: CollectionOptions): UnitKey =>
  collectionOf(kind, 'account', accountId, options);

/** A collection of one place: a server, a channel, a thread, a group or a DM. */
export const placeCollection = (kind: UnitKind, placeId: string, options?: CollectionOptions): UnitKey =>
  collectionOf(kind, 'place', placeId, options);

/** A collection of one place, or of the persona when no place holds it. */
export const placeOrPersona = (kind: UnitKind, placeId: string | null, options: CollectionOptions = {}): UnitKey =>
  placeId === null || placeId === PERSONA_ID
    ? { ...personaKey(kind), ...options }
    : placeCollection(kind, placeId, options);

/** A journal day of one place. */
export const journalKey = (placeId: string, day: string): UnitKey =>
  placeCollection('journal', placeId, { partition: day });
