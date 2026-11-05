// The store of tests/admin.test.ts as a fake: the profiles, lore, channels and recent lines the owner operations read,
// kept in maps, with counters for the calls a test checks.
import { emptyAffinity, applyDelta } from '../../src/memory/affinity.ts';
import { upsertLore } from '../../src/memory/lore.ts';
import type { LoreEntry } from '../../src/memory/lore.ts';
import type { Untyped } from '../../src/tools/types.ts';

type Rec = Record<string, Untyped>;
type AffinityOpts = Parameters<typeof applyDelta>[3];

// The store's records are still JavaScript in the tests, so each one is Untyped.
function buildStore() {
  const profiles = new Map<string, Rec>();
  const forgotten: Array<Untyped> = [];
  const privates = new Map<string, Rec>(); // `${placeId}:${userId}` -> private layer
  const forgottenPrivate: Array<Untyped> = [];
  const lore = new Map<string, Array<Rec>>(); // placeId -> entries[]
  const channels = new Map<string, Rec>(); // `${placeId}:${placeId}` -> channel entry
  const guilds = new Map<string, Rec>(); // placeId -> guild notes
  const store = {
    profiles,
    forgotten,
    lore,
    channels,
    guilds,
    getChannel(placeId: string) {
      return [...channels.entries()].find(([key]) => key.endsWith(`:${placeId}`))?.[1] ?? null;
    },
    listChannels(placeId: string) {
      const prefix = `${placeId}:`;
      return [...channels.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value);
    },
    topPlaces() {
      return ['g1'];
    },
    getPlace(placeId: string) {
      return guilds.get(placeId) ?? { patterns: '', starters: '', injokes: [], self: [], updatedAt: null };
    },
    recent: new Map<string, Rec>(), // placeId -> { nextId, lines }
    getRecent(this: { recent: Map<string, Rec> }, placeId: string) {
      return structuredClone(this.recent.get(placeId) ?? { nextId: 1, lines: [] });
    },
    state: { data: { llmCount: 5, llmDay: '2026-09-20' } as Record<string, Untyped>, markDirty() {} },
    flushCalls: 0,
    flush(this: { flushCalls: number }) {
      this.flushCalls += 1;
    },
    dropCachesCalls: 0,
    dropCaches(this: { dropCachesCalls: number }) {
      this.dropCachesCalls += 1;
      return 0;
    },
    reloadStateCalls: 0,
    reloadState(this: { reloadStateCalls: number }) {
      this.reloadStateCalls += 1;
    },
    validateResult: [] as Array<string>,
    validate(this: { validateResult: Array<string> }) {
      return this.validateResult;
    },
    getUser(userId: string) {
      return profiles.get(`${userId}`) ?? null;
    },
    getLore(placeId: string) {
      return lore.get(placeId) ?? [];
    },
    setLore(placeId: string, incoming: unknown, opts: Parameters<typeof upsertLore>[2]) {
      const { entries, upserted } = upsertLore((lore.get(placeId) ?? []) as Array<LoreEntry>, incoming, opts);
      lore.set(placeId, entries);
      return upserted;
    },
    removeLore(placeId: string, id: string) {
      const current = lore.get(placeId) ?? [];
      const next = current.filter((entry) => entry.id !== id);
      lore.set(placeId, next);
      return next.length !== current.length;
    },
    adjustAffinity(userId: string, delta: number, reason: string, opts: AffinityOpts) {
      const key = `${userId}`;
      const profile = profiles.get(key) ?? { id: String(userId), affinity: emptyAffinity() };
      profile.affinity = applyDelta(profile.affinity ?? emptyAffinity(), delta, reason, opts);
      profiles.set(key, profile);
      return profile.affinity as Rec;
    },
    privates,
    forgottenPrivate,
    getPrivate(userId: string) {
      return privates.get(`${userId}`) ?? null;
    },
    listPrivate(placeId: string) {
      const prefix = `${placeId}:`;
      return [...privates.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
    },
    countUsers() {
      return profiles.size;
    },
    listUserProfiles() {
      return [...profiles.values()];
    },
    participation: new Map<string, Rec>(), // placeId -> { episodes, nextId }
    getParticipation(this: { participation: Map<string, Rec> }, placeId: string) {
      return structuredClone(this.participation.get(placeId) ?? { episodes: [], nextId: 1 });
    },
    getBuffer() {
      return [];
    },
  };
  return store;
}


// A test adds the store methods it needs after the fact, so the type is open.
export type StoreFake = ReturnType<typeof buildStore> & Record<string, Untyped>;

export function makeStore(): StoreFake {
  return buildStore();
}
