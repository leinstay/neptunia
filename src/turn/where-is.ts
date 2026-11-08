// Where a turn happens, read from what the turn already holds: the interface of its event and the chat the
// event names. The owner's command line is a place of its own, a direct chat answers its partner, a channel or a thread
// answers its server and the channel it sits in. A wake has no chat and answers null, never the last place it
// heard of. Pure, and no request reads it: it is the one answer to where she is that a turn may grow on.

import type { Chat } from '../protocol/events.ts';

/** The place of a turn: a channel or thread, a direct chat, or the owner's command line. */
export type WhereIs =
  | {
      kind: 'channel';
      interfaceId: string;
      serverId: string | null;
      chatId: string;
      threadId: string | null;
      channelName: string | null;
    }
  | { kind: 'dm'; interfaceId: string; partnerId: string | null }
  | { kind: 'cli' };

/** The interface the owner's command line speaks as (src/interface/link.ts#CLI_IFACE). */
const CLI_IFACE = 'cli';

const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** Where a turn on `iface` in `chat` happens; null for a turn with no chat, a wake. */
export function whereIs({ iface, chat }: { iface: string | null; chat: Chat | null }): WhereIs | null {
  if (iface === null || iface === '' || chat === null) return null;
  if (iface === CLI_IFACE) return { kind: 'cli' };
  const chatType = chat.chatType ?? chat.kind;
  if (chatType === 'dm') return { kind: 'dm', interfaceId: iface, partnerId: textOrNull(chat.partnerId) };
  const isThread = chatType === 'thread';
  return {
    kind: 'channel',
    interfaceId: iface,
    serverId: chatType === 'group_dm' ? null : textOrNull(chat.rootId),
    chatId: isThread ? (textOrNull(chat.parentId) ?? chat.id) : chat.id,
    threadId: isThread ? chat.id : null,
    channelName: textOrNull(chat.name),
  };
}
