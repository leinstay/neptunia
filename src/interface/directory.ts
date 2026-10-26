// The conversations an interface reported through `conversation.changed`, by id, kept as whole `Conversation` records:
// the core reads the name of a conversation here (the inner life names the places it shows her), the community of a
// task or an intention, and the direct chat of a member, never a platform object. A direct chat is learned from the
// messages seen in it (`observe`): the interface announces no change for one. `dmConversationOf(partnerId)` answers the
// one-to-one chat with that member, the newest when two were seen.

import type { Conversation, ConversationChanged, MessageReceived } from '../protocol/events.js';

export function createConversationDirectory(): {
  apply(event: ConversationChanged): void;
  observe(event: MessageReceived): void;
  nameOf(conversationId: string): string | null;
  get(conversationId: string): Conversation | null;
  conversations(): ReadonlyArray<Conversation>;
  dmConversationOf(partnerId: string): string | null;
  /** The member a direct chat is with, null for any other conversation. */
  partnerOf(conversationId: string): string | null;
  /** Whether the conversation is a direct chat (one-to-one or group) the interface showed. */
  isPrivate(conversationId: string): boolean;
  ids(): ReadonlyArray<string>;
} {
  const records = new Map<string, Conversation>();
  // partner member id -> the id of the one-to-one chat with that member.
  const direct = new Map<string, string>();
  // conversation id of a direct chat -> its partner.
  const partners = new Map<string, string>();
  // the ids of every direct chat shown, a group chat included.
  const privateChats = new Set<string>();

  // The partner of a one-to-one chat; a group chat and a conversation of a community have none.
  const partnerOf = (conversation: Conversation): string | null =>
    conversation.kind === 'dm' && conversation.chatType !== 'group_dm' && typeof conversation.partnerId === 'string'
      ? conversation.partnerId
      : null;

  function learnDirect(conversation: Conversation): void {
    if (conversation.kind === 'dm') privateChats.add(conversation.id);
    const partner = partnerOf(conversation);
    if (partner === null) return;
    direct.set(partner, conversation.id);
    partners.set(conversation.id, partner);
  }

  return {
    apply(event) {
      const { conversation } = event;
      if (event.change === 'deleted') {
        records.delete(conversation.id);
        const partner = partnerOf(conversation);
        if (partner !== null && direct.get(partner) === conversation.id) direct.delete(partner);
        partners.delete(conversation.id);
        privateChats.delete(conversation.id);
        return;
      }
      if (conversation.kind === 'dm') learnDirect(conversation);
      else records.set(conversation.id, conversation);
    },
    observe(event) {
      learnDirect(event.conversation);
    },
    nameOf: (conversationId) => records.get(conversationId)?.name ?? null,
    get: (conversationId) => records.get(conversationId) ?? null,
    conversations: () => [...records.values()],
    dmConversationOf: (partnerId) => direct.get(partnerId) ?? null,
    partnerOf: (conversationId) => partners.get(conversationId) ?? null,
    isPrivate: (conversationId) => privateChats.has(conversationId),
    ids: () => [...records.keys()],
  };
}
