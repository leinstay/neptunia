// The origin record of a message (events.ts#Origin) as the core reads it: the one the adapter
// sent with the event, else what the event itself says. Pure and total over a validated
// `message.received` event; never throws.

import type { MessageReceived, Origin } from './events.ts';

/** The `replyExpected` of an event that carries no origin: addressed to the persona or a direct chat. */
function expectedOf(event: MessageReceived): true | null {
  if (event.conversation?.kind === 'dm') return true;
  const addressing = event.addressing;
  if (addressing && (addressing.mentioned === true || addressing.replyToSelf === true)) return true;
  return null;
}

export function originOf(event: MessageReceived): Origin {
  const conversation = event?.conversation ?? {};
  const sent = event?.origin;
  const isThread = conversation.kind === 'thread';
  const chatType = conversation.kind === 'dm' || conversation.kind === 'thread' ? conversation.kind : 'channel';
  return {
    chatType: sent?.chatType ?? chatType,
    place: sent?.place ?? String(conversation.id ?? ''),
    parent: sent?.parent ?? conversation.parentId ?? null,
    thread: sent?.thread ?? (isThread ? String(conversation.id) : null),
    replyToAuthorId: sent?.replyToAuthorId ?? null,
    replyExpected: sent && sent.replyExpected !== undefined ? sent.replyExpected : expectedOf(event ?? {}),
  };
}
