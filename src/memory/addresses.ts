// What a core module holds of a conversation or a person (its native id and interface) as the canonical place and account
// the memory store addresses. The store answers from the database; a stand-in store without these methods holds the
// native ids as given.

type Conversationish = {
  id?: string | null;
  iface?: string | null;
  rootId?: string | null;
  kind?: string | null;
  chatType?: string | null;
  partnerId?: string | null;
  authorityId?: string | null;
};

type Addressing = {
  placeOfConversation?: (conversation: Conversationish, iface?: string) => string;
  sharedPlaceOf?: (conversation: Conversationish, iface?: string) => string;
  placeOfCommunity?: (nativeId: string, iface?: string) => string;
  accountOf?: (nativeId: string, iface?: string) => string;
  personOfAccount?: (accountId: string) => string;
};

const given = (conversation: Conversationish): string => String(conversation.rootId ?? conversation.id ?? '');

/** The place of a conversation itself: its channel, thread, group or DM. */
export function placeOfConversation(store: unknown, conversation: Conversationish, iface?: string): string {
  const addressing = store as Addressing | null | undefined;
  return addressing?.placeOfConversation
    ? addressing.placeOfConversation(conversation, iface)
    : String(conversation.id ?? '');
}

/** The place that holds what a conversation shares with its tree: the top of it, a DM's own place. */
export function sharedPlaceOf(store: unknown, conversation: Conversationish, iface?: string): string {
  const addressing = store as Addressing | null | undefined;
  return addressing?.sharedPlaceOf ? addressing.sharedPlaceOf(conversation, iface) : given(conversation);
}

/** The place of a community an interface names by its native id. */
export function placeOfCommunity(store: unknown, nativeId: string, iface?: string): string {
  const addressing = store as Addressing | null | undefined;
  return addressing?.placeOfCommunity ? addressing.placeOfCommunity(nativeId, iface) : nativeId;
}

/** The account of a member an interface names by a native id. */
export function accountOf(store: unknown, nativeId: string, iface?: string): string {
  const addressing = store as Addressing | null | undefined;
  return addressing?.accountOf ? addressing.accountOf(nativeId, iface) : nativeId;
}

/** The person of a member an interface names by a native id. */
export function personOfMember(store: unknown, nativeId: string, iface?: string): string {
  const addressing = store as Addressing | null | undefined;
  const account = accountOf(store, nativeId, iface);
  return addressing?.personOfAccount ? addressing.personOfAccount(account) : `person:${iface ?? ''}:${nativeId}`;
}
