// The discord.js objects behind an event, kept on the Discord side under the event's id. An event crosses the
// link as plain data; the message pipeline still needs the message (and the old one for an edit) for history
// fetches and sends, so it asks this registry for them by the id the event carries. The newest `capacity`
// entries are kept, the oldest go first.

// `previous` is the old message of an edit, null for any other event.
export type RawHandles = { message: unknown; previous: unknown };

export function createRawRegistry(options: { capacity: number }): {
  put(eventId: string, handles: RawHandles): void;
  rawOf(event: { id: string }): RawHandles | null;
} {
  const { capacity } = options;
  // Insertion order is the age: the oldest id is the first key.
  const held = new Map<string, RawHandles>();
  return {
    put(eventId, handles) {
      held.delete(eventId);
      held.set(eventId, handles);
      while (held.size > capacity) {
        const oldest = held.keys().next();
        if (oldest.done === true) break;
        held.delete(oldest.value);
      }
    },
    rawOf: (event) => held.get(event.id) ?? null,
  };
}
