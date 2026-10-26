// The persona's one previous think (docs/prompt-contract.md, `<previous_think>`): a request carries
// at most one think of hers from the request just before it -- the step before in a tool loop, or the
// latest finished turn tied to the same place within a window. This module holds the choice and the
// escaping; the wording lives in labels.json, the request layout in prompt.js, the wiring in turn.js.
//
// A place is interface + server (or a private chat) + channel. A turn is tied to the place it ran in
// and to each place where a message of hers was delivered; an inner turn (heartbeat, intention,
// review) is tied only to the places it posted into and never imports a think. The store keeps the
// latest entry per place, in process (a restart forgets it). A failed turn leaves a failed entry, so
// nothing older is carried through it. A think from a private chat is never carried into a group
// place. Pure apart from the store's own map; the clock is passed in.

import { MINUTE_MS } from '../time.js';

/** The most places the store keeps an entry for (the least recently written go first). */
export const PLACES_MAX = 200;

/**
 * The key of a place: the interface it is on (empty when one interface is served), the community or `@me`, the conversation.
 * @param {{ interfaceId?: string, guildId?: string|null, channelId: string|number }} place
 * @returns {string}
 */
export function placeKey({ interfaceId = '', guildId = null, channelId }) {
  return `${interfaceId}:${guildId ? String(guildId) : '@me'}:${String(channelId)}`;
}

/**
 * A think as inert text for a block: `<` and `>` become entities, so nothing in it can close the
 * block or read as a tag or a call. A non-string is ''.
 * @param {unknown} text
 * @returns {string}
 */
export function inertThink(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;').trim();
}

/**
 * The in-process store of the last turn think per place.
 * @param {{ maxPlaces?: number }} [options]
 */
export function createThinkStore({ maxPlaces = PLACES_MAX } = {}) {
  const entries = new Map(); // place key -> { turnId, at, think, failed, private }

  /**
   * One turn ended. `ran`: the place key it ran in (null for none); `delivered`: the place keys where
   * a message of hers went out; `think`: its final think (null: none); `failed`: it ended in error or
   * was refused; `isPrivate`: it ran in a private chat; `inner`: an inner turn (tied to the places it
   * posted into only).
   */
  function record({
    turnId = null,
    at,
    think = null,
    failed = false,
    isPrivate = false,
    inner = false,
    ran = null,
    delivered = [],
  }) {
    const places = new Set(Array.isArray(delivered) ? delivered : []);
    if (!inner && ran) places.add(ran);
    const entry = {
      turnId,
      at,
      think: typeof think === 'string' && think.trim() ? think : null,
      failed: failed === true,
      private: isPrivate === true,
    };
    for (const key of places) {
      entries.delete(key);
      entries.set(key, entry);
    }
    while (entries.size > maxPlaces) entries.delete(entries.keys().next().value);
  }

  /**
   * What a new turn in `place` carries: `{ think, source: { turnId, relation: 'earlier', ageMs } }`, or
   * `{ think: null, why }` with why `none-in-window`, `failed`, `private` or `no-think`.
   * @param {string} place
   * @param {{ now: number, minutes: number, isPrivate?: boolean }} at
   */
  function select(place, { now, minutes, isPrivate = false }) {
    const entry = entries.get(place);
    const window = Number.isFinite(minutes) ? minutes * MINUTE_MS : 0;
    if (!entry || window <= 0 || now - entry.at > window) return { think: null, why: 'none-in-window' };
    if (entry.failed) return { think: null, why: 'failed', turnId: entry.turnId };
    if (entry.private && !isPrivate) return { think: null, why: 'private', turnId: entry.turnId };
    if (!entry.think) return { think: null, why: 'no-think', turnId: entry.turnId };
    return {
      think: entry.think,
      source: { turnId: entry.turnId, relation: 'earlier', ageMs: Math.max(0, now - entry.at) },
    };
  }

  return { record, select, size: () => entries.size };
}
