// What the message pipeline asks the interface about a conversation: its reference, how the interface describes it
// now, whether a turn may open there, and whether a line replies to the persona. createMessageHandler (src/behavior/pipeline.ts) builds it once with createConversations and hands its
// functions to the other topic modules.

import { isMirrorPlace } from '../behavior/mirror.ts';
import type { Reads } from '../interface/reads.ts';
import type { Conv } from './types.ts';

/** A conversation as a read names it. */
export type ConversationRef = { iface: string; conversationId: string };

/** What createConversations reads: the dependencies of createMessageHandler. */
export type ConversationsContext = {
  reads: Reads;
  /** The memory database (src/memory/db/service.ts), read for the places of her selfreflection. */
  memoryDb: Parameters<typeof isMirrorPlace>[0];
};

export type Conversations = {
  refOf: (channel: Conv) => ConversationRef;
  currentOf: (channel: Conv) => Promise<Conv>;
  turnPlaceOf: (event: { iface: string; conversation: { id: string } }) => Promise<Conv | null> | null;
  infoNow: (iface: string, conversationId: string) => Promise<Conv | null>;
  resolveReference: (ref: ConversationRef, replyToId: string | null | undefined) => Promise<boolean>;
};

export function createConversations({ reads, memoryDb }: ConversationsContext): Conversations {
  const refOf = (channel: Conv): ConversationRef => ({ iface: channel.iface, conversationId: channel.id });

  /** The conversation as the interface describes it now, else the one given. */
  const currentOf = async (channel: Conv): Promise<Conv> => (await infoNow(channel.iface, channel.id)) ?? channel;

  /** The conversation of `event` a turn may open in, or null: unknown to the interface, or a selfreflection mirror's place. */
  const turnPlaceOf = ({ iface, conversation: { id } }: { iface: string; conversation: { id: string } }) =>
    isMirrorPlace(memoryDb, iface, id) ? null : infoNow(iface, id);

  /** The conversation as the interface describes it now, with its audience, or null. */
  async function infoNow(iface: string, conversationId: string): Promise<Conv | null> {
    const found = await reads.conversationInfo(
      { iface, conversationId: String(conversationId) },
      { audience: true, viewers: [] }
    );
    return found?.conversation ?? null;
  }

  /** Whether the message `replyToId` is one of her own, as the interface says; a failed read is no reply. */
  async function resolveReference(ref: ConversationRef, replyToId: string | null | undefined): Promise<boolean> {
    if (!replyToId) return false;
    const found = await reads.fetchMessages(ref, [replyToId]);
    return found?.messages[0]?.event?.message.author?.self === true;
  }

  return { refOf, currentOf, turnPlaceOf, infoNow, resolveReference };
}
