// A member's ping state in a place, as src/memory/store.ts keeps it in the place's `pings` map: `on` or `off` for a
// member who chose one with `pings.set`, nothing for a member who never chose. The store reads and writes the map
// through these functions; the turn and the tools read a state through `store.getPings`.

/** A member's ping state: `on`, `off`, or null when they never chose and the interface's switch decides. */
export type PingState = 'on' | 'off' | null;

const STATES: ReadonlyArray<string> = ['on', 'off'];

/** The stored map of states, keyed by account id. */
type Pings = Record<string, 'on' | 'off'>;

/**
 * The place's `pings` map, well formed: string ids with `on` or `off` only. `legacyOff`, the `pingsOff` list the
 * earlier switch stored, adds each of its ids as `off` unless the map already holds a state for it.
 */
export function normalizePings(stored: unknown, legacyOff: unknown): Pings {
  const pings: Pings = {};
  if (Array.isArray(legacyOff)) {
    for (const id of legacyOff) if (typeof id === 'string' && id) pings[id] = 'off';
  }
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [id, state] of Object.entries(stored)) {
      if (id && typeof state === 'string' && STATES.includes(state)) pings[id] = state as 'on' | 'off';
    }
  }
  return pings;
}

/** The state of `accountId` in a stored map; null when it holds none. */
export function pingStateOf(stored: unknown, accountId: string): PingState {
  if (!stored || typeof stored !== 'object') return null;
  const state = (stored as Record<string, unknown>)[String(accountId)];
  return state === 'on' || state === 'off' ? state : null;
}

/** A copy of `pings` with the state of `accountId` set to `state` (null removes it), and whether anything changed. */
export function withPingState(pings: Pings, accountId: string, state: PingState): { pings: Pings; changed: boolean } {
  const id = String(accountId);
  if (pingStateOf(pings, id) === state) return { pings, changed: false };
  const next = { ...pings };
  if (state === null) delete next[id];
  else next[id] = state;
  return { pings: next, changed: true };
}
