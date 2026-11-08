// Carries the door receipt beside the protocol event into every live message producer. A line of the `service` client,
// and any line that reaches the door inside an unrecorded turn, is unrecorded: it is neither held while paused nor
// observed into memory (src/turn/unrecorded.ts).

import { holdIfPaused } from './core-pause.ts';
import type { MessageHandler } from './pipeline.ts';
import type { EventHandlerContext } from '../interface/door.ts';
import type { Context } from '../memory/db/scope.ts';
import type { MessageReceived } from '../protocol/events.ts';
import type { MessageReadOptions } from '../pipeline/types.ts';
import { isServiceSender } from '../interface/principals.ts';
import { isUnrecorded } from '../turn/unrecorded.ts';

type ProducerDeps = {
  store: unknown;
  onMessage: MessageHandler;
  observeDirectory: (event: MessageReceived) => unknown;
  offerAvatar: (event: MessageReceived) => unknown;
  issueInternalContext: () => Context;
};

export function createMessageProducers(
  deps: ProducerDeps
): (event: MessageReceived, context: EventHandlerContext) => Promise<void> {
  return async (event: MessageReceived, context: EventHandlerContext): Promise<void> => {
    const sender = context.authenticated;
    const unrecorded = isServiceSender(sender) || isUnrecorded();
    if (!unrecorded) holdIfPaused(event, context, deps.store);
    const options: MessageReadOptions = {
      unrecorded,
      memoryContext:
        sender?.kind === 'cli' && (!context.ingest || context.ingest.principal === sender.name)
          ? deps.issueInternalContext()
          : undefined,
      acceptedEvent: context.receipt
        ? Object.freeze({
            eventId: context.receipt.eventId,
            locator: Object.freeze({
              iface: event.iface,
              chatId: event.chat.id,
              messageId: event.message.id,
            }),
            receipt: context.receipt,
          })
        : undefined,
    };
    deps.observeDirectory(event);
    if (event.deleted) return deps.onMessage.onMessageDelete(event, options);
    if (event.edit) return deps.onMessage.onMessageUpdate(event, options);
    deps.offerAvatar(event);
    // A message resent after a lost link is a backlog: kept as history, and no turn starts over it.
    if ((event as { replayed?: unknown }).replayed === true) {
      await deps.onMessage.catchUp(event as MessageReceived & { raw: object }, { trigger: false });
      return;
    }
    return deps.onMessage(event, options);
  };
}
