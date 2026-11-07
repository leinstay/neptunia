// Entries of a `Mind` (src/memory/db/mind-read.ts) written by hand, for the tests of the blocks that render one
// (src/turn/request/memory-block.ts and the request builder). Each builder fills what a case does not set with the
// plainest value: evidence `edge`, detail `whole`, no candidate, no anchor, no stored row. The ids are made up and
// follow the shapes of src/memory/db/ids.ts on the fake interface `fake`.
import type {
  ClaimEntry,
  Detail,
  EntrySource,
  EpisodeEntry,
  Evidence,
  ExcerptEntry,
  Mind,
  PersonEntry,
  PlaceEntry,
} from '../../src/memory/db/mind-read.ts';

type Base = {
  evidence: Evidence;
  detail: Detail;
  candidate: boolean;
  anchorMessageId: string | null;
  sources: Array<EntrySource>;
};

const base = (): Base => ({ evidence: 'edge', detail: 'whole', candidate: false, anchorMessageId: null, sources: [] });

/** A person known through one account on `fake`, `native` being the platform's id of that account. */
export function personEntry(native: string, name: string, over: Partial<PersonEntry> = {}): PersonEntry {
  const personId = `person:fake:${native}`;
  return {
    ...base(),
    nodeId: personId,
    personId,
    name,
    realName: null,
    affinity: null,
    accounts: [`fake:${native}`],
    relation: null,
    character: null,
    style: null,
    claims: [],
    ...over,
  };
}

/** A room under the root `Αγορά` on `fake`. */
export function placeEntry(placeId: string, name: string, over: Partial<PlaceEntry> = {}): PlaceEntry {
  return {
    ...base(),
    nodeId: placeId,
    placeId,
    iface: 'fake',
    kind: 'channel',
    name,
    path: ['fake', 'Αγορά', name],
    purpose: null,
    tone: null,
    topics: null,
    ownLines: 0,
    ownLastAt: null,
    ...over,
  };
}

export function claimEntry(claimId: string, subjectId: string, text: string): ClaimEntry {
  return { ...base(), nodeId: claimId, claimId, subjectId, kind: 'lore', text };
}

export function episodeEntry(episodeId: string, placeId: string, what: string): EpisodeEntry {
  return { ...base(), nodeId: episodeId, episodeId, placeId, date: '2026-11-06', what };
}

export function excerptEntry(sourceId: string, placeId: string, text: string): ExcerptEntry {
  return { ...base(), nodeId: sourceId, sourceId, placeId, at: '2026-11-01T10:00:00.000Z', text, from: 'prefetch' };
}

/** A mind with the given entries and nothing left out. */
export function mindOfEntries(over: Partial<Mind> = {}): Mind {
  return { people: [], places: [], interfaces: [], lore: [], recent: [], found: [], leftOut: {}, reads: [], ...over };
}
