// The conversations an interface reported through `conversation.changed`, by id: the core reads the name of a
// conversation here (the inner life names the places it shows her), never from a platform object.

import type { ConversationChanged } from '../protocol/events.js';

export function createConversationDirectory(): {
  apply(event: ConversationChanged): void;
  nameOf(conversationId: string): string | null;
  ids(): ReadonlyArray<string>;
} {
  const names = new Map<string, string | null>();
  return {
    apply(event) {
      const { id, name } = event.conversation;
      if (event.change === 'deleted') names.delete(id);
      else names.set(id, name ?? null);
    },
    nameOf: (conversationId) => names.get(conversationId) ?? null,
    ids: () => [...names.keys()],
  };
}
