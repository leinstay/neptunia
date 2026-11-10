// The service and writer worker commit normalized messages through chat-qualified families.

import { randomUUID } from 'node:crypto';

import { checkEnvelope, observe, observationAudience, resolveObservationPlace, OBSERVE_CODES } from './observe.ts';
import type { Envelope, MessageChat, ObserveResult } from './observe.ts';
import { locatorText, messageLocator } from './message-locator.ts';
import { familyError, historicalFamily, insertFamily } from './message-family-catalog.ts';
import type { MessageFamily } from './message-family-catalog.ts';
import type { NativeMessageLocator } from './recall.ts';
import { dbOf } from './types.ts';
import { addKey, deriveRow, ensureAuthority } from './rows.ts';
import { nodeId, canonicalKey } from './ids.ts';
import { lineColumns, lineOwnerOfText, nextLinePosition } from './line-owner.ts';
import { projectRow } from './graph.ts';
import { markStemsPending } from './stems.ts';
import type { Db, Log, MemoryHandle, Row } from './types.ts';
import { associateReceipt, receiptSource } from './ingest.ts';
import type { IngestRow } from './ingest.ts';
import type { MessageLocator } from './message-locator.ts';

function descriptorCode(e: Envelope): string | null {
  const locator = messageLocator(e.messageLocator, e.iface);
  if (
    !locator ||
    locator.origin !== 'protocol-message' ||
    e.native.kind !== 'message' ||
    locator.messageId !== e.native.key ||
    (e.native.subtype !== undefined && e.native.subtype !== 'seen' && e.native.subtype !== 'said')
  )
    return 'BAD_NATIVE';
  const c = e.messageChat;
  if (
    !c ||
    !locatorText(c.id) ||
    c.id !== locator.chatId ||
    !['channel', 'thread', 'group_dm', 'dm'].includes(c.chatType)
  )
    return 'BAD_PLACE';
  if (
    (c.partnerId !== undefined && !locatorText(c.partnerId)) ||
    (c.parentId !== undefined && !locatorText(c.parentId))
  )
    return 'BAD_PLACE';
  return placeCode(e, c);
}

function placeCode(e: Envelope, c: MessageChat): string | null {
  const p = e.place;
  const key = c.chatType === 'dm' ? c.partnerId : c.id;
  if (
    !locatorText(key) ||
    p.authority !== e.authority ||
    p.key !== `${c.chatType}:${key}` ||
    p.kind !== c.chatType ||
    p.chat !== (c.chatType === 'dm' ? 'dm' : 'group')
  )
    return 'BAD_PLACE';
  const partner = p.partner;
  if (
    c.chatType === 'dm' &&
    (!partner || partner.key !== c.partnerId || (partner.authority !== undefined && partner.authority !== e.authority))
  )
    return 'BAD_PLACE';
  // A thread names the channel it sits in; what contains any other place is the tree's own business.
  const parent = c.chatType === 'thread' && c.parentId ? `channel:${c.parentId}` : null;
  return parent === null || p.parent === parent ? null : 'BAD_PLACE';
}

function replyEnvelope(db: Db, e: Envelope, options: { newKey?: () => string }): Envelope {
  if (e.messageReply === undefined) return e;
  const locator = messageLocator({ ...e.messageReply, v: 1, origin: 'protocol-message' }, e.iface);
  if (!locator) throw familyError('BAD_RELATION');
  const parent = resolveMessageFamily(db, {
    locator,
    authority: e.authority,
    newKey: options.newKey,
  });
  return {
    ...e,
    messageReply: { iface: locator.iface, chatId: locator.chatId, messageId: locator.messageId },
    relations: [
      ...(e.relations ?? []).filter((relation) => relation.predicate !== 'replies_to'),
      {
        predicate: 'replies_to',
        target: {
          authority: parent.authority_id,
          kind: parent.native_kind,
          key: parent.native_key,
          generation: parent.generation,
        },
      },
    ],
  };
}

/** Reserves a chat's family and writes its observation in one transaction. */
export function observeMessage(
  handle: MemoryHandle,
  envelope: unknown,
  options: { now?: () => number; log?: Partial<Log> | null; owner?: string | null; newKey?: () => string } = {}
): ObserveResult {
  const invalid = checkEnvelope(envelope);
  if (invalid) return { ok: false, code: invalid };
  // checkEnvelope validates the envelope before the dedicated descriptor checks.
  const e = envelope as Envelope;
  const descriptor = descriptorCode(e);
  if (descriptor) return { ok: false, code: descriptor };
  try {
    return handle.transaction(() => {
      const db = dbOf(handle);
      const prior = receiptSource(db, envelope);
      if (prior) return { ok: true, replayed: true, sourceId: prior.sourceId, revision: prior.revision, written: 0 };
      // descriptorCode verifies the locator before the catalog uses it.
      const family = resolveMessageFamily(db, {
        locator: e.messageLocator!,
        authority: e.authority,
        generation: e.native.generation,
        newKey: options.newKey ?? randomUUID,
      });
      // The outer writer transaction owns rollback for both the catalog and observation.
      const inside: MemoryHandle = { ...handle, transaction: (fn) => fn() };
      const normalized = replyEnvelope(
        db,
        {
          ...e,
          authority: family.authority_id,
          native: { ...e.native, kind: family.native_kind, key: family.native_key },
        },
        options
      );
      const result = observe(inside, normalized, options);
      if (!result.ok) throw familyError(result.code ?? 'BAD_ENVELOPE');
      if (typeof result.sourceId !== 'string') throw familyError('UNKNOWN_SOURCE');
      associateReceipt(db, envelope, result.sourceId, (options.now ?? Date.now)());
      const stored = db.prepare('SELECT revision FROM sources WHERE id = ?').get(result.sourceId);
      return { ...result, revision: stored?.revision };
    });
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      new Set<string>(Object.values(OBSERVE_CODES)).has(error.code)
    )
      return { ok: false, code: error.code };
    throw error;
  }
}

export type MessageDeletion = Readonly<{
  v: 1;
  iface: string;
  authority: string;
  messageLocator: MessageLocator;
  messageChat: MessageChat;
  generation?: number;
  occurredAt: string;
  observedAt: string;
  ingest?: { row: IngestRow; keepDays: number };
}>;

const isObject = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);

function deletionChatCode(c: unknown, locator: MessageLocator): string | null {
  if (
    !isObject(c) ||
    c.id !== locator.chatId ||
    typeof c.chatType !== 'string' ||
    !['channel', 'thread', 'group_dm', 'dm'].includes(c.chatType)
  )
    return 'BAD_PLACE';
  if (c.partnerId !== undefined && !locatorText(c.partnerId)) return 'BAD_PLACE';
  if (c.chatType === 'dm' && !locatorText(c.partnerId)) return 'BAD_PLACE';
  if (c.parentId !== undefined && !locatorText(c.parentId)) return 'BAD_PLACE';
  return null;
}

function deletionCode(value: unknown): string | null {
  if (!isObject(value)) return 'BAD_ENVELOPE';
  if (value.v !== 1) return 'BAD_VERSION';
  if (!locatorText(value.iface) || value.iface.includes('/')) return 'BAD_IFACE';
  if (
    !locatorText(value.authority) ||
    !value.authority.startsWith(`${value.iface}/`) ||
    value.authority === `${value.iface}/`
  )
    return 'BAD_AUTHORITY';
  const locator = messageLocator(value.messageLocator, value.iface);
  if (!locator || locator.origin !== 'protocol-message') return 'BAD_NATIVE';
  const place = deletionChatCode(value.messageChat, locator);
  if (place) return place;
  if (value.generation !== undefined && (!Number.isInteger(value.generation) || Number(value.generation) < 1))
    return 'BAD_NATIVE';
  for (const stamp of [value.occurredAt, value.observedAt])
    if (typeof stamp !== 'string' || !Number.isFinite(Date.parse(stamp))) return 'BAD_TIME';
  return null;
}

function deletionPlace(input: MessageDeletion): Envelope['place'] {
  const c = input.messageChat;
  return {
    authority: input.authority,
    kind: c.chatType,
    key: `${c.chatType}:${c.chatType === 'dm' ? c.partnerId : c.id}`,
    chat: c.chatType === 'dm' ? 'dm' : 'group',
    ...(c.chatType === 'dm' && typeof c.partnerId === 'string' ? { partner: { key: c.partnerId } } : {}),
    ...(c.chatType === 'thread' && c.parentId ? { parent: `channel:${c.parentId}` } : {}),
  };
}

function writeDeletion(db: Db, input: MessageDeletion, options: MessageWriteOptions): ObserveResult {
  const prior = receiptSource(db, input);
  if (prior) return { ok: true, replayed: true, ...prior, written: 0 };
  const atMs = (options.now ?? Date.now)();
  const at = new Date(atMs).toISOString();
  const family = resolveMessageFamily(db, {
    locator: input.messageLocator,
    authority: input.authority,
    generation: input.generation,
    newKey: options.newKey,
  });
  const sourceId = nodeId('source', [
    family.authority_id,
    family.native_kind,
    family.native_key,
    family.generation,
    null,
    'deleted',
  ]);
  if (db.prepare('SELECT id FROM sources WHERE id = ?').get(sourceId)) {
    associateReceipt(db, input, sourceId, atMs);
    return { ok: true, replayed: true, sourceId, written: 0 };
  }
  const place = resolveObservationPlace(db, { ...input, place: deletionPlace(input) }, at);
  const { scope, audience } = observationAudience(input.iface, place);
  const line = lineOwnerOfText(options.owner);
  const position = line ? nextLinePosition(db, line) : null;
  const row = deriveRow(
    db,
    'sources',
    {
      id: sourceId,
      iface: input.iface,
      kind: 'deleted',
      authority_id: family.authority_id,
      native_id: family.native_key,
      native_kind: family.native_kind,
      generation: family.generation,
      revision: null,
      place_id: place.id,
      ...scope,
      audience_id: audience,
      occurred_at: input.occurredAt,
      observed_at: input.observedAt,
      recorded_at: input.observedAt,
      origin: 'observation',
      ...lineColumns(line),
      position,
      extra: JSON.stringify({ $messageLocator: input.messageLocator }),
    },
    { log: options.log }
  );
  const storedRow = row;
  const columns = Object.keys(storedRow);
  db.prepare(`INSERT INTO sources (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(
    ...columns.map((column) => storedRow[column])
  );
  addKey(db, family.authority_id, 'source', canonicalKey('message', [family.native_key, null, 'deleted']), sourceId, {
    generation: family.generation,
    at,
  });
  projectRow(db, 'sources', { id: sourceId }, { at });
  markStemsPending(db);
  associateReceipt(db, input, sourceId, atMs);
  return { ok: true, replayed: false, sourceId, placeId: place.id, audienceId: audience, written: 1 };
}

type MessageWriteOptions = {
  now?: () => number;
  log?: Partial<Log> | null;
  owner?: string | null;
  newKey?: () => string;
};

/** Writes an authorless tombstone and its accepted receipt in the message family's transaction. */
export function deleteMessage(handle: MemoryHandle, input: unknown, options: MessageWriteOptions = {}): ObserveResult {
  const code = deletionCode(input);
  if (code) return { ok: false, code };
  try {
    // deletionCode validates every required field before the writer reads the typed descriptor.
    return handle.transaction(() => writeDeletion(dbOf(handle), input as MessageDeletion, options));
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      new Set<string>(Object.values(OBSERVE_CODES)).has(error.code)
    )
      return { ok: false, code: error.code };
    throw error;
  }
}

/** Resolves or reserves one qualified family inside the caller's transaction. */
export function resolveMessageFamily(
  db: Db,
  {
    locator,
    authority,
    nativeKind = 'message',
    generation = 1,
    newKey = randomUUID,
  }: {
    locator: NativeMessageLocator;
    authority: string;
    nativeKind?: string;
    generation?: number;
    newKey?: () => string;
  }
): MessageFamily {
  const current = db
    .prepare(
      'SELECT * FROM message_families WHERE iface = ? AND conversation_id = ? AND message_id = ? AND generation = ?'
    )
    .get(locator.iface, locator.chatId, locator.messageId, generation);
  // Catalog columns have the MessageFamily shape.
  if (current) return current as MessageFamily;
  const historic = historicalFamily(db, locator, generation);
  const key = historic?.native_key ?? newKey();
  if (!locatorText(key)) throw familyError('KEY_COLLISION');
  if (
    !historic &&
    db
      .prepare('SELECT 1 FROM sources WHERE authority_id = ? AND native_kind = ? AND native_id = ? AND generation = ?')
      .get(authority, nativeKind, key, generation)
  )
    throw familyError('KEY_COLLISION');
  if (
    !historic &&
    db
      .prepare(
        'SELECT 1 FROM message_families WHERE authority_id = ? AND native_kind = ? AND native_key = ? AND generation = ?'
      )
      .get(authority, nativeKind, key, generation)
  )
    throw familyError('KEY_COLLISION');
  const family = historic ?? {
    iface: locator.iface,
    conversation_id: locator.chatId,
    message_id: locator.messageId,
    generation,
    authority_id: authority,
    native_kind: nativeKind,
    native_key: key,
  };
  ensureAuthority(db, family.authority_id, locator.iface, family.authority_id.slice(locator.iface.length + 1));
  insertFamily(db, family);
  return family;
}
