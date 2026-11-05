// The neutral addresses of a place and an account: the interface, the authority inside it that issued the native id, and
// the native id, with the generation for an account (a reused native id is a new generation). Equal native ids stay
// apart until the owner links them. A key is a structured tuple, so no character inside a native id can forge another
// address. Plain data with no platform in it: the memory database and the core read these, and an interface may declare
// its authority on a conversation (events.ts).

import type { Conversation } from './events.ts';

export type ConversationAddress = { interfaceId: string; authorityId: string; placeId: string };
export type AccountAddress = { interfaceId: string; authorityId: string; nativeId: string; generation: number };

/** The core's own namespace (`person:self`, rows with no interface). */
export const CORE_AUTHORITY = 'core/local';

/** The native authority of an interface: `<iface>/local` for the command line and the core, `<iface>/global` for any other interface until it declares its own. */
export function nativeAuthorityOf(iface: unknown): string {
  if (typeof iface !== 'string' || !iface) return CORE_AUTHORITY;
  if (iface === 'cli' || iface === 'core') return `${iface}/local`;
  return `${iface}/global`;
}

export const conversationKey = ({ interfaceId, authorityId, placeId }: ConversationAddress): string =>
  JSON.stringify([interfaceId, authorityId, placeId]);

export const accountKey = ({ interfaceId, authorityId, nativeId, generation }: AccountAddress): string =>
  JSON.stringify([interfaceId, authorityId, nativeId, generation]);

/** The address of an event's conversation, under the authority it declares or the interface's native one. */
export function conversationAddressOf({
  iface,
  conversation,
}: {
  iface: string;
  conversation: Conversation;
}): ConversationAddress {
  return {
    interfaceId: iface,
    authorityId: conversation.authorityId ?? nativeAuthorityOf(iface),
    placeId: conversation.id,
  };
}
