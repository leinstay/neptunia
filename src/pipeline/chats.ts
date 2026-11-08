// What the message pipeline asks the interface about a chat: its reference, how the interface describes it
// now, whether a turn may open there, and whether a line replies to the persona. createMessageHandler (src/behavior/pipeline.ts) builds it once with createChats and hands its
// functions to the other topic modules.

import { isMirrorPlace } from '../behavior/mirror.ts';
import type { Reads } from '../interface/reads.ts';
import type { Conv } from './types.ts';

/** A chat as a read names it. */
export type ChatRef = { iface: string; chatId: string };

/** What createChats reads: the dependencies of createMessageHandler. */
export type ChatsContext = {
  reads: Reads;
  /** The memory database (src/memory/db/service.ts), read for the places of her selfreflection. */
  memoryDb: Parameters<typeof isMirrorPlace>[0];
};

export type Chats = {
  refOf: (channel: Conv) => ChatRef;
  currentOf: (channel: Conv) => Promise<Conv>;
  turnPlaceOf: (event: { iface: string; chat: { id: string } }) => Promise<Conv | null> | null;
  infoNow: (iface: string, chatId: string) => Promise<Conv | null>;
  resolveReference: (ref: ChatRef, replyToId: string | null | undefined) => Promise<boolean>;
};

export function createChats({ reads, memoryDb }: ChatsContext): Chats {
  const refOf = (channel: Conv): ChatRef => ({ iface: channel.iface, chatId: channel.id });

  /** The chat as the interface describes it now, else the one given. */
  const currentOf = async (channel: Conv): Promise<Conv> => (await infoNow(channel.iface, channel.id)) ?? channel;

  /** The chat of `event` a turn may open in, or null: unknown to the interface, or a selfreflection mirror's place. */
  const turnPlaceOf = ({ iface, chat: { id } }: { iface: string; chat: { id: string } }) =>
    isMirrorPlace(memoryDb, iface, id) ? null : infoNow(iface, id);

  /** The chat as the interface describes it now, with its audience, or null. */
  async function infoNow(iface: string, chatId: string): Promise<Conv | null> {
    const found = await reads.chatInfo({ iface, chatId: String(chatId) }, { audience: true, viewers: [] });
    return found?.chat ?? null;
  }

  /** Whether the message `replyToId` is one of her own, as the interface says; a failed read is no reply. */
  async function resolveReference(ref: ChatRef, replyToId: string | null | undefined): Promise<boolean> {
    if (!replyToId) return false;
    const found = await reads.fetchMessages(ref, [replyToId]);
    const [fetched] = found?.messages ?? [];
    const message = fetched?.event?.message;
    return message?.author?.self === true;
  }

  return { refOf, currentOf, turnPlaceOf, infoNow, resolveReference };
}
