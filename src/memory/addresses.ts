// What a core module holds of a chat or a person (its native id and interface) as the canonical place and account
// the memory store addresses. The store answers from the database; a stand-in store without these methods holds the
// native ids as given.

import type { PlaceRef } from './db/frame-reads.ts';

type Chatish = {
  id?: string | null;
  iface?: string | null;
  rootId?: string | null;
  kind?: string | null;
  chatType?: string | null;
  partnerId?: string | null;
  authorityId?: string | null;
};

type Addressing = {
  placeOfChat?: (chat: Chatish, iface?: string) => string;
  sharedPlaceOf?: (chat: Chatish, iface?: string) => string;
  placeOfRoot?: (nativeId: string, iface?: string) => string;
  accountOf?: (nativeId: string, iface?: string) => string;
  personOfAccount?: (accountId: string) => string | null;
  storedPersonOfAccount?: (accountId: string) => string | null;
  dmHomeOf?: (accountId: string) => string | null;
  rootPlaceOf?: (placeId: string) => string | null;
  chatOfPlace?: (placeId: string) => string | null;
  placeRefOf?: (placeId: string) => PlaceRef | null;
  notePlaceAddress?: (placeId: string, address: string) => Promise<unknown>;
};

const given = (chat: Chatish): string => String(chat.rootId ?? chat.id ?? '');

/** The place of a chat itself: its channel, thread, group or DM. */
export function placeOfChat(store: unknown, chat: Chatish, iface?: string): string {
  const addressing = store as Addressing | null | undefined;
  return addressing?.placeOfChat ? addressing.placeOfChat(chat, iface) : String(chat.id ?? '');
}

/** The place that holds what a chat shares with its tree: the top of it, a DM's own place. */
export function sharedPlaceOf(store: unknown, chat: Chatish, iface?: string): string {
  const addressing = store as Addressing | null | undefined;
  return addressing?.sharedPlaceOf ? addressing.sharedPlaceOf(chat, iface) : given(chat);
}

/** The place of a root an interface names by its native id. */
export function placeOfRoot(store: unknown, nativeId: string, iface?: string): string {
  const addressing = store as Addressing | null | undefined;
  return addressing?.placeOfRoot ? addressing.placeOfRoot(nativeId, iface) : nativeId;
}

/** The account of a member an interface names by a native id. */
export function accountOf(store: unknown, nativeId: string, iface?: string): string {
  const addressing = store as Addressing | null | undefined;
  return addressing?.accountOf ? addressing.accountOf(nativeId, iface) : nativeId;
}

/** The person of a member an interface names by a native id, null when the store links none or holds no persons. */
export function personOfMember(store: unknown, nativeId: string, iface?: string): string | null {
  const addressing = store as Addressing | null | undefined;
  return addressing?.personOfAccount?.(accountOf(store, nativeId, iface)) ?? null;
}

/** The stored person of a member an interface names by a native id, null when no stored row links one. */
export function storedPersonOfMember(store: unknown, nativeId: string, iface?: string): string | null {
  const addressing = store as Addressing | null | undefined;
  return addressing?.storedPersonOfAccount?.(accountOf(store, nativeId, iface)) ?? null;
}

/** The stored DM place whose partner is a member's account (`places.partner_account`), null when none is stored. */
export function dmPlaceOfMember(store: unknown, nativeId: string, iface?: string): string | null {
  const addressing = store as Addressing | null | undefined;
  return addressing?.dmHomeOf?.(accountOf(store, nativeId, iface)) ?? null;
}

/** The top of a place's stored tree (the store's `rootPlaceOf`), the place itself when the store holds no tree for it. */
export function topPlaceOf(store: unknown, placeId: string): string {
  const addressing = store as Addressing | null | undefined;
  return addressing?.rootPlaceOf?.(placeId) ?? placeId;
}

/**
 * The native chat of a place, for a call that speaks to its interface: the address the store holds for it; the place
 * as given when the store cannot say (a stand-in store holds native ids).
 */
export function chatOfPlace(store: unknown, placeId: string): string | null {
  const addressing = store as Addressing | null | undefined;
  return addressing?.chatOfPlace ? addressing.chatOfPlace(placeId) : placeId;
}

/** Stores the chat an interface opened for a place as its address, through the store's writer; nothing without one. */
export function notePlaceAddress(store: unknown, placeId: string, address: string): Promise<unknown> {
  const addressing = store as Addressing | null | undefined;
  return addressing?.notePlaceAddress ? addressing.notePlaceAddress(placeId, address) : Promise.resolve(null);
}

/** A stored place as its interface knows it (the store's `placeRefOf`), null when no row holds it or the store holds none. */
export function placeRefOf(store: unknown, placeId: string): PlaceRef | null {
  const addressing = store as Addressing | null | undefined;
  return addressing?.placeRefOf?.(placeId) ?? null;
}

/** The platform id of a stored DM place's partner, from its row and its partner's account; null for any other place. */
export function dmPartnerOf(store: unknown, placeId: string): string | null {
  const ref = placeRefOf(store, placeId);
  return ref?.kind === 'dm' ? ref.partnerNativeId : null;
}
