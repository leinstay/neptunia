// The service and writer worker commit normalized messages through conversation-qualified families.

import { randomUUID } from 'node:crypto';
import { checkEnvelope, observe, OBSERVE_CODES } from './observe.ts';
import type { Envelope, MessageConversation, ObserveResult } from './observe.ts';
import { locatorText, messageLocator } from './message-locator.ts';
import { familyError, historicalFamily, insertFamily } from './message-family-catalog.ts';
import type { MessageFamily } from './message-family-catalog.ts';
import { dbOf } from './types.ts';
import type { Db, Log, MemoryHandle } from './types.ts';

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
  const c = e.messageConversation;
  if (
    !c ||
    !locatorText(c.id) ||
    c.id !== locator.conversationId ||
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

function placeCode(e: Envelope, c: MessageConversation): string | null {
  const p = e.place;
  const key = c.chatType === 'dm' ? c.partnerId : c.id;
  if (
    !locatorText(key) ||
    p.authority !== e.authority ||
    p.key !== `${c.chatType}:${key}` ||
    p.kind !== c.chatType ||
    p.conversation !== (c.chatType === 'dm' ? 'dm' : 'group')
  )
    return 'BAD_PLACE';
  const partner = p.partner;
  if (
    c.chatType === 'dm' &&
    (!partner || partner.key !== c.partnerId || (partner.authority !== undefined && partner.authority !== e.authority))
  )
    return 'BAD_PLACE';
  const parent = c.chatType === 'thread' && c.parentId ? `channel:${c.parentId}` : null;
  return (p.parent ?? null) === parent ? null : 'BAD_PLACE';
}

function familyOf(db: Db, e: Envelope, newKey: () => string): { family: MessageFamily; reserved: boolean } {
  // descriptorCode requires a verified locator before family resolution.
  const locator = e.messageLocator!;
  const generation = e.native.generation ?? 1;
  const current = db
    .prepare(
      `SELECT * FROM message_families WHERE iface = ? AND conversation_id = ? AND message_id = ? AND generation = ?`
    )
    .get(e.iface, locator.conversationId, locator.messageId, generation);
  // The catalog's non-null columns have the MessageFamily shape.
  if (current) return { family: current as MessageFamily, reserved: true };
  const historic = historicalFamily(db, locator, generation);
  if (historic) return { family: historic, reserved: false };
  const key = newKey();
  if (!locatorText(key)) throw familyError('KEY_COLLISION');
  for (const [table, column] of [
    ['sources', 'native_id'],
    ['message_families', 'native_key'],
  ]) {
    if (
      db
        .prepare(
          `SELECT 1 FROM ${table} WHERE authority_id = ? AND native_kind = ? AND ${column} = ? AND generation = ?`
        )
        .get(e.authority, e.native.kind, key, generation)
    )
      throw familyError('KEY_COLLISION');
  }
  return {
    family: {
      iface: e.iface,
      conversation_id: locator.conversationId,
      message_id: locator.messageId,
      generation,
      authority_id: e.authority,
      native_kind: e.native.kind,
      native_key: key,
    },
    reserved: false,
  };
}

/** Reserves a conversation's family and writes its observation in one transaction. */
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
      const { family, reserved } = familyOf(db, e, options.newKey ?? randomUUID);
      // The outer writer transaction owns rollback for both the catalog and observation.
      const inside: MemoryHandle = { ...handle, transaction: (fn) => fn() };
      const result = observe(
        inside,
        {
          ...e,
          authority: family.authority_id,
          native: { ...e.native, kind: family.native_kind, key: family.native_key },
        },
        options
      );
      if (!result.ok) throw familyError(result.code ?? 'BAD_ENVELOPE');
      if (!reserved) insertFamily(db, family);
      return result;
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
