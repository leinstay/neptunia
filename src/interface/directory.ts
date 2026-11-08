// The chats an interface reported through `chat.changed`, by id, kept as whole `Chat` records:
// the core reads the name of a chat here (the inner life names the places it shows her), the root of a
// task or an intention, and the direct chat of a member, never a platform object. A direct chat is learned from the
// messages seen in it (`observe`): the interface announces no change for one. `dmChatOf(partnerId)` answers the
// one-to-one chat with that member, the newest when two were seen.

import type { Chat, ChatChanged, MessageReceived } from '../protocol/events.ts';

export function createChatDirectory(): {
  apply(event: ChatChanged): void;
  observe(event: MessageReceived): void;
  nameOf(chatId: string): string | null;
  get(chatId: string): Chat | null;
  chats(): ReadonlyArray<Chat>;
  dmChatOf(partnerId: string): string | null;
  /** The member a direct chat is with, null for any other chat. */
  partnerOf(chatId: string): string | null;
  /** Whether the chat is a direct chat (one-to-one or group) the interface showed. */
  isDm(chatId: string): boolean;
  ids(): ReadonlyArray<string>;
} {
  const records = new Map<string, Chat>();
  // partner member id -> the id of the one-to-one chat with that member.
  const direct = new Map<string, string>();
  // chat id of a direct chat -> its partner.
  const partners = new Map<string, string>();
  // the ids of every direct chat shown, a group chat included.
  const dmChats = new Set<string>();

  // The partner of a one-to-one chat; a group chat and a chat of a root have none.
  const partnerOf = (chat: Chat): string | null =>
    chat.kind === 'dm' && chat.chatType !== 'group_dm' && typeof chat.partnerId === 'string' ? chat.partnerId : null;

  function learnDirect(chat: Chat): void {
    if (chat.kind === 'dm') dmChats.add(chat.id);
    const partner = partnerOf(chat);
    if (partner === null) return;
    direct.set(partner, chat.id);
    partners.set(chat.id, partner);
  }

  return {
    apply(event) {
      const { chat } = event;
      if (event.change === 'deleted') {
        records.delete(chat.id);
        const partner = partnerOf(chat);
        if (partner !== null && direct.get(partner) === chat.id) direct.delete(partner);
        partners.delete(chat.id);
        dmChats.delete(chat.id);
        return;
      }
      if (chat.kind === 'dm') learnDirect(chat);
      else records.set(chat.id, chat);
    },
    observe(event) {
      learnDirect(event.chat);
    },
    nameOf: (chatId) => records.get(chatId)?.name ?? null,
    get: (chatId) => records.get(chatId) ?? null,
    chats: () => [...records.values()],
    dmChatOf: (partnerId) => direct.get(partnerId) ?? null,
    partnerOf: (chatId) => partners.get(chatId) ?? null,
    isDm: (chatId) => dmChats.has(chatId),
    ids: () => [...records.keys()],
  };
}
