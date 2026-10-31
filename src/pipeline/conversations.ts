// What the message pipeline asks the interface about a conversation: its reference, how the interface describes it
// now, whether a turn may open there, where a call written in it is answered, and whether a line replies to the
// persona. createMessageHandler (src/behavior/pipeline.js) builds it once with createConversations and hands its
// functions to the other topic modules.

import { isMirrorPlace } from '../behavior/mirror.ts';
import { takeSnapshot } from '../behavior/snapshot.ts';
import { routeFor } from '../behavior/turn.js';
import type { Reads } from '../interface/reads.ts';
import type { Conv, PipelineConfig } from './types.ts';

/** A conversation as a read names it. */
export type ConversationRef = { iface: string; conversationId: string };

/** Where a call written in a channel she cannot write in is answered (src/turn/routing.ts#routeFor). */
export type Route = { destination: Conv | null; reason?: string | null };

/** What createConversations reads: the dependencies of createMessageHandler. */
export type ConversationsContext = {
  reads: Reads;
  /** The memory database (src/memory/db/service.js), read for the places of her diary. */
  memoryDb: Parameters<typeof isMirrorPlace>[0];
  getGuildId: () => string | null;
};

export type Conversations = {
  refOf: (channel: Conv) => ConversationRef;
  currentOf: (channel: Conv) => Promise<Conv>;
  turnPlaceOf: (event: { iface: string; conversation: { id: string } }) => Promise<Conv | null> | null;
  infoNow: (iface: string, conversationId: string) => Promise<Conv | null>;
  routeOf: (source: Conv, config: PipelineConfig) => Promise<Route>;
  resolveReference: (ref: ConversationRef, replyToId: string | null | undefined) => Promise<boolean>;
};

export function createConversations({ reads, memoryDb, getGuildId }: ConversationsContext): Conversations {
  const refOf = (channel: Conv): ConversationRef => ({ iface: channel.iface, conversationId: channel.id });

  /** The conversation as the interface describes it now, else the one given. */
  const currentOf = async (channel: Conv): Promise<Conv> => (await infoNow(channel.iface, channel.id)) ?? channel;

  /** The conversation of `event` a turn may open in, or null: unknown to the interface, or a diary mirror's place. */
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

  /** Where a call written in `source` (one she cannot write in) is answered (src/behavior/turn.js#routeFor). */
  async function routeOf(source: Conv, config: PipelineConfig): Promise<Route> {
    // A routed call is written in a channel of the served guild, so the guild has resolved by then.
    const snapshot = await takeSnapshot(reads, (source.communityId ?? getGuildId()) as string);
    return routeFor(snapshot?.get(source.id) ?? source, snapshot, config);
  }

  /** Whether the message `replyToId` is one of her own, as the interface says; a failed read is no reply. */
  async function resolveReference(ref: ConversationRef, replyToId: string | null | undefined): Promise<boolean> {
    if (!replyToId) return false;
    const found = await reads.fetchMessages(ref, [replyToId]);
    return found?.messages[0]?.event?.message.author?.self === true;
  }

  return { refOf, currentOf, turnPlaceOf, infoNow, routeOf, resolveReference };
}
