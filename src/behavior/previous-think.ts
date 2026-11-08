// The persona's one previous think (docs/prompt-contract.md, `<previous_think>`): a request carries
// at most one think of hers from the request just before it -- the step before in a tool loop, or the
// latest finished turn tied to the same place within a window. This module holds the choice and the
// escaping; the wording lives in labels.json, the request layout in prompt.js, the wiring in turn.js.
//
// A place is interface + chat: a native chat id is unique on its interface, so the key needs no top of
// its tree. A turn is tied to the place it ran in
// and to each place where a message of hers was delivered; an inner turn (heartbeat, intention,
// review) is tied only to the places it posted into and never imports a think. The store keeps the
// latest entry per place, in process, and is seeded at start from the journal's `turn` records of yesterday and
// today (`seed`), so a restart keeps what the window still holds. A failed turn leaves a failed entry, so
// nothing older is carried through it. A think from a private chat is never carried into a group
// place. Pure apart from the store's own map; the clock is passed in.

import { MINUTE_MS } from '../time.ts';
import type { Untyped } from '../tools/types.ts';

/** The most places the store keeps an entry for (the least recently written go first). */
export const PLACES_MAX = 200;

/** The key of a place: the interface it is on (empty when one interface is served) and the chat. */
export function placeKey({ interfaceId = '', chatId }: { interfaceId?: string; chatId: string | number }): string {
  return `${interfaceId}:${String(chatId)}`;
}

/**
 * A think as inert text for a block: `<` and `>` become entities, so nothing in it can close the
 * block or read as a tag or a call. A non-string is ''.
 */
export function inertThink(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;').trim();
}

/**
 * The in-process store of the last turn think per place.
 */
/** The previous think of each place, as the store keeps and selects it. */
export type ThinkStore = {
  record: (turn: {
    turnId?: Untyped;
    at: number;
    think?: Untyped;
    failed?: boolean;
    isDm?: boolean;
    inner?: boolean;
    ran?: Untyped;
    delivered?: Array<Untyped>;
  }) => void;
  select: (
    place: string,
    options: { now: number; minutes: number; isDm?: boolean }
  ) =>
    | { think: null; why: string; turnId?: Untyped }
    | { think: Untyped; source: { turnId: Untyped; relation: string; ageMs: number } };
  seed: (records: ReadonlyArray<unknown>, options: { isDm: boolean }) => void;
  size: () => number;
};

/** The entry the store keeps per place key. */
type ThinkEntry = { turnId: Untyped; at: number; think: string | null; failed: boolean; private: boolean };

/** The outcomes of a turn that leave an entry, and those of them that leave a failed one. */
const ENTRY_OUTCOMES: ReadonlySet<unknown> = new Set(['spoke', 'skip', 'error', 'refused']);
const FAILED_OUTCOMES: ReadonlySet<unknown> = new Set(['error', 'refused']);

export function createThinkStore({ maxPlaces = PLACES_MAX }: { maxPlaces?: number } = {}): ThinkStore {
  const entries = new Map<string, ThinkEntry>();

  /**
   * One turn ended. `ran`: the place key it ran in (null for none); `delivered`: the place keys where
   * a message of hers went out; `think`: its final think (null: none); `failed`: it ended in error or
   * was refused; `isDm`: it ran in a private chat; `inner`: an inner turn (tied to the places it
   * posted into only).
   */
  function record({
    turnId = null,
    at,
    think = null,
    failed = false,
    isDm = false,
    inner = false,
    ran = null,
    delivered = [],
  }: {
    turnId?: Untyped;
    at: number;
    think?: Untyped;
    failed?: boolean;
    isDm?: boolean;
    inner?: boolean;
    ran?: Untyped;
    delivered?: Array<Untyped>;
  }) {
    const places = new Set(Array.isArray(delivered) ? delivered : []);
    if (!inner && ran) places.add(ran);
    const entry: ThinkEntry = {
      turnId,
      at,
      think: typeof think === 'string' && think.trim() ? think : null,
      failed: failed === true,
      private: isDm === true,
    };
    for (const key of places as Set<string>) {
      entries.delete(key);
      entries.set(key, entry);
    }
    while (entries.size > maxPlaces) entries.delete(entries.keys().next().value!);
  }

  /**
   * What a new turn in `place` carries: `{ think, source: { turnId, relation: 'earlier', ageMs } }`, or
   * `{ think: null, why }` with why `none-in-window`, `failed`, `private` or `no-think`.
   */
  function select(place: string, { now, minutes, isDm = false }: { now: number; minutes: number; isDm?: boolean }) {
    const entry = entries.get(place);
    const window = Number.isFinite(minutes) ? minutes * MINUTE_MS : 0;
    if (!entry || window <= 0 || now - entry.at > window) return { think: null, why: 'none-in-window' };
    if (entry.failed) return { think: null, why: 'failed', turnId: entry.turnId };
    if (entry.private && !isDm) return { think: null, why: 'private', turnId: entry.turnId };
    if (!entry.think) return { think: null, why: 'no-think', turnId: entry.turnId };
    return {
      think: entry.think,
      source: { turnId: entry.turnId, relation: 'earlier', ageMs: Math.max(0, now - entry.at) },
    };
  }

  /**
   * The journal's `turn` records (src/turn/journal.ts#journalTurnRecord, parsed, oldest first) as entries: each a
   * finished turn of the place in its `scope.channel` (else its `placeId`) at its `occurredAt`, with its think, failed
   * when it ended in error or was refused. An inner turn (`mode` `inner`) is left out, since a record does not say
   * where it posted; so is a record of another kind, without a place or a time, or with another outcome. An entry
   * already held for a place at the same time or later stays. `isDm`: the records come from a private journal.
   */
  function seed(records: ReadonlyArray<unknown>, { isDm }: { isDm: boolean }) {
    for (const item of Array.isArray(records) ? records : []) {
      const one = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      if (one.kind !== 'turn' || one.mode === 'inner' || !ENTRY_OUTCOMES.has(one.outcome)) continue;
      const scope = (one.scope && typeof one.scope === 'object' ? one.scope : {}) as { channel?: unknown };
      const channel = typeof scope.channel === 'string' && scope.channel ? scope.channel : one.placeId;
      const at = Date.parse(String(one.occurredAt));
      if (typeof channel !== 'string' || !channel || !Number.isFinite(at)) continue;
      const ran = placeKey({ chatId: channel });
      if ((entries.get(ran)?.at ?? -Infinity) >= at) continue;
      record({
        turnId: one.turnId ?? null,
        at,
        think: one.think ?? null,
        failed: FAILED_OUTCOMES.has(one.outcome),
        isDm,
        ran,
      });
    }
  }

  return { record, select, seed, size: () => entries.size };
}
