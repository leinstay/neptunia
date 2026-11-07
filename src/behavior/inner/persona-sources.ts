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
type PlaceStore = {
  rootPlaceOf?(placeId: string): string | null;
  placeOfConversation?(conversation: { kind: string; partnerId: string }, iface?: string): string;
  holdsSharedConversation?(conversationId: string): boolean;
};

/** The journal a wake holds: every call of InnerJournal, and a read of the whole day when no kind is named. */
type PersonaJournal = Required<Omit<InnerJournal, 'read'>> & {
  read(query: { day: string; kind?: string; n: number }): unknown;
};

/** Whether a journal line is an action of a skill call. */
const isSkillLine = (line: unknown): boolean =>
  typeof line === 'object' && line !== null && Reflect.get(line, 'name') === 'skill';

/**
 * Where a line of a wake belongs: a DM's place when the partner is known; `sealed` under its own spelled place when no
 * stored place holds the conversation as a group's, so it reaches neither the groups nor the journal every wake reads.
 */
function homeOf(
  store: PlaceStore,
  conversationId: unknown,
  partner: unknown
): { place: string | null; sealed: boolean } {
  if (typeof partner === 'string' && partner)
    return { place: placeOfConversation(store, { kind: 'dm', partnerId: partner }), sealed: false };
  const id = typeof conversationId === 'string' ? conversationId : '';
  if (!id || store.holdsSharedConversation?.(id) !== false) return { place: null, sealed: false };
  return { place: placeOfConversation(store, { id }), sealed: true };
}

/** The record over every place `places` names; a line goes to its conversation's tree, a private one to its DM. */
export function personaRecord(
  record: PlaceRecord,
  store: PlaceStore,
  places: () => Array<string>
): Required<RecordSource> {
  return {
    async *iterate(query) {
      for (const placeId of places()) yield* record.iterate(placeId, query);
    },
    append(lines, options) {
      const first = lines[0] as { scope?: { channel?: unknown } } | undefined;
      const channel = first?.scope?.channel;
      const home = homeOf(store, channel, options?.privateAccountId);
      if (home.place !== null && home.sealed) {
        const closed = (lines as ReadonlyArray<{ scope?: object }>).map((line) => ({
          ...line,
          scope: { ...line.scope, unresolved: true },
        }));
        return record.append(home.place, closed);
      }
      const own = home.place ?? placeOfConversation(store, { id: typeof channel === 'string' ? channel : '' });
      return record.append(store.rootPlaceOf?.(own) ?? own, lines);
    },
  };
}

/**
 * The journal of her own writes under the persona; a cut-off turn's operations from every place and its own DM. An
 * operation in a DM goes to the DM's journal, one in a conversation no stored place holds to its own sealed journal.
 */
export function personaJournal(journal: Journal, places: () => Array<string>, store: PlaceStore = {}): PersonaJournal {
  return {
    inner: (fields) => journal.inner(PERSONA_ID, fields),
    read: async (query) => {
      const own: unknown = await journal.read(PERSONA_ID, query);
      if (query.kind !== 'action') return own;
      // Every skill action of a turn is journaled in the journal of the turn's place, so a read of her actions takes the
      // skill lines of every place she serves as well as her own.
      const found: Array<unknown> = Array.isArray(own) ? [...(own as Array<unknown>)] : [];
      for (const placeId of new Set(places())) {
        if (placeId === PERSONA_ID) continue;
        const read: unknown = await journal.read(placeId, query);
        if (Array.isArray(read)) found.push(...(read as Array<unknown>).filter((line) => isSkillLine(line)));
      }
      return found;
    },
    op(base) {
      const home = homeOf(store, base.placeId, base.privateAccountId);
      if (home.place === null) return journal.op(PERSONA_ID, base);
      return journal.op(
        home.place,
        home.sealed ? { ...base, scope: { channel: base.placeId, unresolved: true } } : base
      );
    },
    async turnOperations(query) {
      const partner = query.privateAccountId;
      const dm = partner ? placeOfConversation(store, { kind: 'dm', partnerId: partner }, query.iface) : null;
      const holders = new Set([...places(), PERSONA_ID, ...(dm ? [dm] : [])]);
      const found: Array<unknown> = [];
      for (const placeId of holders) {
        const read = await journal.turnOperations(placeId, { turnId: query.turnId, days: query.days });
        if (Array.isArray(read)) found.push(...read);
      }
      return found;
    },
  };
}
