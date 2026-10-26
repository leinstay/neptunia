// A feed for tests that render the `<people_now>` rows: a core around store (src/behavior/around-store.ts) fed
// the way production feeds it, discord.js-shaped states and presences turned into protocol events by the
// builders of interfaces/discord/around.js, each stamped with the injected clock. Its methods take the same
// objects the Discord gateway delivers, and `snapshot()` is the store's `view()`.
import { createAroundStore } from '../../src/behavior/around-store.ts';
import { presenceEvent, presenceSnapshotEvent, voiceEvent } from '../../interfaces/discord/around.js';

const GUILD = { id: 'g1' };

type Raw = Record<string, unknown>;
type FedAround = {
  voiceUpdate(state: Raw): void;
  presenceUpdate(presence: Raw): void;
  seedVoice(states: Array<Raw>): void;
  markStale(): void;
  markFresh(): void;
  snapshot(): ReturnType<ReturnType<typeof createAroundStore>['view']>;
};

export function createFedAround({ presences = false, now = Date.now }: { presences?: boolean; now?: () => number } = {}): FedAround {
  const store = createAroundStore({ presences });
  const voiceStates = new Map<string, Raw>();
  const presenceList = new Map<string, Raw>();
  const stamp = (state: Raw): Raw => ({ ...state, guild: GUILD });
  const keyOf = (state: Raw): string => String(state.id ?? state.userId ?? (state.member as Raw | undefined)?.id);
  return {
    voiceUpdate(state: Raw): void {
      voiceStates.set(keyOf(state), state);
      store.voiceChanged(voiceEvent(stamp(state), now()));
    },
    presenceUpdate(presence: Raw): void {
      presenceList.set(keyOf(presence), presence);
      store.presenceChanged(presenceEvent(stamp(presence), now()));
    },
    // The ready seed: these voice states and the presences fed so far, as one snapshot.
    seedVoice(states: Array<Raw>): void {
      voiceStates.clear();
      for (const state of states) voiceStates.set(keyOf(state), state);
      const guild = {
        ...GUILD,
        voiceStates: { cache: new Map([...voiceStates].map(([key, state]) => [key, stamp(state)])) },
        presences: { cache: new Map(presenceList) },
      };
      store.snapshot(presenceSnapshotEvent(guild, now()));
    },
    markStale(): void {
      store.connection({ kind: 'connection.changed', iface: 'discord', at: now(), id: `connection:lost:${now()}`, state: 'lost' });
    },
    markFresh(): void {
      store.connection({ kind: 'connection.changed', iface: 'discord', at: now(), id: `connection:resumed:${now()}`, state: 'resumed' });
    },
    snapshot: () => store.view(),
  };
}
