// What a core module holds of a chat or a person (its native id and interface) as the canonical place and account
// the memory store addresses. The store answers from the database; a stand-in store without these methods holds the
// native ids as given.

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
  chatOfPlace?: (placeId: string, dmChatOf?: DmChatOf | null) => string | null;
};

/** The direct chat an interface saw with a member, by the member's native id. */
type DmChatOf = (partnerId: string) => string | null;

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
 * The native chat of a place, for a call that speaks to its interface: the store's answer, a DM's chat from
 * `dmChatOf`; the place as given when the store cannot say (a stand-in store holds native ids).
 */
export function chatOfPlace(store: unknown, placeId: string, dmChatOf: DmChatOf | null = null): string | null {
  const addressing = store as Addressing | null | undefined;
  return addressing?.chatOfPlace ? addressing.chatOfPlace(placeId, dmChatOf) : placeId;
}
