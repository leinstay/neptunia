// The ring of what her earlier turns in a place raised, handed to the graph reader as `Seeds.previous`
// (src/memory/db/mind-read.ts), so a person or a place named a moment ago stays in mind after its line leaves the
// reader's window. The request phase notes each reply turn's mind and reads the earlier turns back
// (src/turn/phases/request/build.ts#framedInputsOf). In process, per place, bounded; the turn records of the journal
// keep each turn's seeds, and src/behavior/turn.ts#seedThinks refills the ring from them at start.

import type { EntryRef, Evidence, Mind } from '../memory/db/mind-read.ts';

// Chosen with the graph assembly's slice of 2026-11-11: three turns hold a short exchange, so a name stays while the
// talk is about it and leaves once three answers in the place went by without a line raising it.
export const SEED_RING_TURNS = 3;
// Chosen on the same day: more places than one deployment answers in within a few hours, each holding a few refs.
export const SEED_RING_PLACES = 100;

/** The evidence of an entry a line of its own turn raised; `edge` and `prose` came through another entry. */
const OWN_EVIDENCE: ReadonlySet<Evidence> = new Set(['native', 'reply', 'counterpart', 'author', 'place', 'word']);

/** The ring of her earlier turns' seeds per place. */
export type SeedRing = {
  /** Keeps what turn `turnId` raised in `placeId`, replacing an earlier note of the same turn. */
  note(placeId: string, turnId: string, refs: ReadonlyArray<EntryRef>): void;
  /** What the last turns of `placeId` other than `turnId` raised, each node once, the newest turn's first. */
  previous(placeId: string, turnId: string): Array<EntryRef>;
};

/**
 * The people and places of `mind` a line of its turn raised: no candidate, and nothing that came only along an edge or
 * from a claim, so what the ring hands on does not hand itself on again forever.
 */
export function seedRefsOf(mind: Mind): Array<EntryRef> {
  const own = (entry: { evidence: Evidence; candidate: boolean }): boolean =>
    !entry.candidate && OWN_EVIDENCE.has(entry.evidence);
  return [
    ...mind.people.filter(own).map((one) => ({ kind: 'person', rowId: one.personId })),
    ...mind.places.filter(own).map((one) => ({ kind: 'place', rowId: one.placeId })),
  ];
}

/** An empty ring of at most `SEED_RING_PLACES` places, each with its last `SEED_RING_TURNS` turns. */
export function createSeedRing(): SeedRing {
  const byPlace = new Map<string, Array<{ turnId: string; refs: Array<EntryRef> }>>();
  return {
    note(placeId, turnId, refs) {
      const turns = (byPlace.get(placeId) ?? []).filter((one) => one.turnId !== turnId);
      turns.push({ turnId, refs: [...refs] });
      byPlace.delete(placeId);
      byPlace.set(placeId, turns.slice(-SEED_RING_TURNS));
      for (const oldest of byPlace.keys()) {
        if (byPlace.size <= SEED_RING_PLACES) break;
        byPlace.delete(oldest);
      }
    },
    previous(placeId, turnId) {
      const seen = new Set<string>();
      const out: Array<EntryRef> = [];
      for (const turn of [...(byPlace.get(placeId) ?? [])].reverse()) {
        if (turn.turnId === turnId) continue;
        for (const ref of turn.refs) {
          const key = `${ref.kind}\u0000${ref.rowId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(ref);
        }
      }
      return out;
    },
  };
}
