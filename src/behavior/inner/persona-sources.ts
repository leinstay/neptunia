// The record and the journal as the inner life reads them: it belongs to the one persona, so it asks for lines with no
// place named, and the core's wiring (src/core.ts) answers from every place that holds some. A line it writes goes to the
// place of its own conversation.

import { placeOfConversation } from '../../memory/addresses.ts';
import { PERSONA_ID } from '../../memory/db/storage-keys.ts';
import type { Journal } from '../../memory/journal.ts';
import type { InnerJournal, RecordSource } from './types.ts';

type PlaceRecord = {
  iterate(placeId: string, query?: { from?: string }): AsyncIterable<object>;
  append(placeId: string, lines: ReadonlyArray<unknown>): unknown;
};
type PlaceStore = { rootPlaceOf?(placeId: string): string | null };

/** The record over every place `places` names; a line goes to its conversation's tree, a private one to its DM. */
export function personaRecord(record: PlaceRecord, store: PlaceStore, places: () => Array<string>): RecordSource {
  return {
    async *iterate(query) {
      for (const placeId of places()) yield* record.iterate(placeId, query);
    },
    append(lines, options) {
      const first = lines[0] as { scope?: { channel?: unknown } } | undefined;
      const privateUserId = options?.privateUserId;
      const conversation =
        typeof privateUserId === 'string' && privateUserId
          ? { kind: 'dm', partnerId: privateUserId }
          : { id: typeof first?.scope?.channel === 'string' ? first.scope.channel : '' };
      const own = placeOfConversation(store, conversation);
      return record.append(store.rootPlaceOf?.(own) ?? own, lines);
    },
  };
}

/** The journal of her own writes under the persona; a cut-off turn's operations from every place. */
export function personaJournal(journal: Journal, places: () => Array<string>): InnerJournal {
  return {
    inner: (fields) => journal.inner(PERSONA_ID, fields),
    read: (query) => journal.read(PERSONA_ID, query),
    op: (base) => journal.op(PERSONA_ID, base),
    async turnOperations(query) {
      const holders = [...places(), PERSONA_ID];
      const found: Array<unknown> = [];
      for (const placeId of holders) {
        const read = await journal.turnOperations(placeId, { turnId: query.turnId, days: query.days });
        if (Array.isArray(read)) found.push(...read);
      }
      return found;
    },
  };
}
