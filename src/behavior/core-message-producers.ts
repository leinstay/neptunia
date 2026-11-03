// Carries the door receipt beside the protocol event into every live message producer.

import { holdIfPaused } from './core-pause.ts';
import type { MessageHandler } from './pipeline.ts';
import type { EventHandlerContext } from '../interface/door.ts';
import type { Context } from '../memory/db/scope.ts';
import type { MessageReceived } from '../protocol/events.ts';
import type { MessageReadOptions } from '../pipeline/types.ts';

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
    holdIfPaused(event, context, deps.store);
    const sender = context.authenticated;
    const options: MessageReadOptions = {
      memoryContext:
        sender?.kind === 'cli' && (!context.ingest || context.ingest.principal === sender.name)
          ? deps.issueInternalContext()
          : undefined,
      acceptedEvent: context.receipt
        ? Object.freeze({
            eventId: context.receipt.eventId,
            locator: Object.freeze({
              iface: event.iface,
              conversationId: event.conversation.id,
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
    return deps.onMessage(event, options);
  };
}
