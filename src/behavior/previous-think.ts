// The persona's previous thinks (docs/prompt-contract.md, `<previous_think>`): a request carries the think of the
// step before it in a tool loop, or up to `count` thinks of the latest finished turns tied to the same place within a
// window. This module holds the choice and the escaping; the wording lives in labels.json, the request layout in
// src/turn/request/wake.ts, the wiring in src/turn/journal-notes.ts.
//
// A place is interface + chat: a native chat id is unique on its interface, so the key needs no top of its tree. A
// turn is tied to the place it ran in and to each place where a message of hers was delivered; an inner turn
// (heartbeat, intention, review) is tied only to the places it posted into and never imports a think. The store keeps
// the newest `maxPerPlace` entries of each place, in process, and is seeded at start from the journal's `turn` records
// of yesterday and today (`seed`), so a restart keeps what the window still holds. `select` walks a place's entries
// from the newest back: an entry older than the window or a failed one ends the walk, so nothing older is carried
// through a failure; an entry without a think is passed over, and so is a think from a private chat when the place is
// no private chat. Pure apart from the store's own map; the clock is passed in.

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

/** One think a new turn carries: the text, the turn it came from and its age at the moment of the choice. */
export type CarriedThink = { think: string; turnId: unknown; ageMs: number };

/** The previous thinks of each place, as the store keeps and selects them. */
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
    options: { now: number; minutes: number; isDm?: boolean; count?: number }
  ) => { thinks: Array<CarriedThink>; why?: string; turnId?: unknown };
  seed: (records: ReadonlyArray<unknown>, options: { isDm: boolean }) => void;
  size: () => number;
};

/** One finished turn in a place's list of entries. */
type ThinkEntry = { turnId: Untyped; at: number; think: string | null; failed: boolean; private: boolean };

/** The outcomes of a turn that leave an entry, and those of them that leave a failed one. */
const ENTRY_OUTCOMES: ReadonlySet<unknown> = new Set(['spoke', 'skip', 'error', 'refused']);
const FAILED_OUTCOMES: ReadonlySet<unknown> = new Set(['error', 'refused']);

/** The most entries the store keeps per place, by default (the oldest go first). */
const PER_PLACE_MAX = 8;

/** Why a place carries no think, decided by its newest entry; `turnId` names that entry when there is one. */
function whyNone(newest: ThinkEntry | undefined, inWindow: boolean, isDm: boolean): { why: string; turnId?: unknown } {
  if (!newest || !inWindow) return { why: 'none-in-window' };
  const why = newest.failed ? 'failed' : newest.private && !isDm ? 'private' : 'no-think';
  return { why, turnId: newest.turnId };
}

/**
 * The thinks of a place's entries (oldest first) a new turn carries, oldest first: walked from the newest back, up to
 * `count`, ended by an entry older than the window or a failed one, passing over an entry without a think and a
 * private one when `isDm` is false.
 */
function carried(
  list: ReadonlyArray<ThinkEntry>,
  { now, window, isDm, count }: { now: number; window: number; isDm: boolean; count: number }
): Array<CarriedThink> {
  const thinks: Array<CarriedThink> = [];
  for (let i = list.length - 1; i >= 0 && thinks.length < count; i -= 1) {
    const entry = list[i];
    if (now - entry.at > window || entry.failed) break;
    if (!entry.think || (entry.private && !isDm)) continue;
    thinks.unshift({ think: entry.think, turnId: entry.turnId, ageMs: Math.max(0, now - entry.at) });
  }
  return thinks;
}

export function createThinkStore({
  maxPlaces = PLACES_MAX,
  maxPerPlace = PER_PLACE_MAX,
}: { maxPlaces?: number; maxPerPlace?: number } = {}): ThinkStore {
  const entries = new Map<string, Array<ThinkEntry>>();

  /** Adds an entry to the place's list, keeping the newest `maxPerPlace`, and marks the place as the latest written. */
  function keep(key: string, entry: ThinkEntry) {
    const list = [...(entries.get(key) ?? []), entry].slice(-Math.max(1, maxPerPlace));
    entries.delete(key);
    entries.set(key, list);
  }

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
    for (const key of places as Set<string>) keep(key, entry);
    while (entries.size > maxPlaces) entries.delete(entries.keys().next().value!);
  }

  /**
   * What a new turn in `place` carries: `{ thinks }`, up to `count` (default 1) thinks oldest first, or
   * `{ thinks: [], why }` with why `none-in-window`, `failed`, `private` or `no-think` for the newest entry.
   */
  function select(
    place: string,
    { now, minutes, isDm = false, count = 1 }: { now: number; minutes: number; isDm?: boolean; count?: number }
  ) {
    const list = entries.get(place) ?? [];
    const window = Number.isFinite(minutes) ? minutes * MINUTE_MS : 0;
    const want = Number.isInteger(count) && count > 0 ? count : 1;
    const thinks = window > 0 ? carried(list, { now, window, isDm, count: want }) : [];
    if (thinks.length > 0) return { thinks };
    const newest = list.at(-1);
    return { thinks, ...whyNone(newest, window > 0 && !!newest && now - newest.at <= window, isDm) };
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
      if ((entries.get(ran)?.at(-1)?.at ?? -Infinity) >= at) continue;
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
