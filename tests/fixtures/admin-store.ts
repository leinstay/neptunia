// The store of tests/admin.test.ts as a fake: the profiles, lore, channels and recent lines the owner operations read,
// kept in maps, with counters for the calls a test checks.
import { emptyAffinity, applyDelta } from '../../src/memory/affinity.ts';
import { upsertLore } from '../../src/memory/lore.ts';
import type { Untyped } from '../../src/tools/types.ts';

type AffinityOpts = Parameters<typeof applyDelta>[3];

// The store's records are still JavaScript in the tests, so each one is Untyped.
function buildStore() {
  const profiles = new Map<string, Untyped>();
  const forgotten: Array<Untyped> = [];
  const privates = new Map<string, Untyped>(); // `${guildId}:${userId}` -> private layer
  const forgottenPrivate: Array<Untyped> = [];
  const lore = new Map<string, Array<Untyped>>(); // guildId -> entries[]
  const channels = new Map<string, Untyped>(); // `${guildId}:${channelId}` -> channel entry
  const guilds = new Map<string, Untyped>(); // guildId -> guild notes
  const store = {
    profiles,
    forgotten,
    lore,
    channels,
    guilds,
    getChannel(guildId: string, channelId: string) {
      return channels.get(`${guildId}:${channelId}`) ?? null;
    },
    listChannels(guildId: string) {
      const prefix = `${guildId}:`;
      return [...channels.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value);
    },
    getGuild(guildId: string) {
      return guilds.get(guildId) ?? { patterns: '', starters: '', injokes: [], self: [], updatedAt: null };
    },
    recent: new Map<string, Untyped>(), // guildId -> { nextId, lines }
    getRecent(this: { recent: Map<string, Untyped> }, guildId: string) {
      return structuredClone(this.recent.get(guildId) ?? { nextId: 1, lines: [] });
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
    getUser(guildId: string, userId: string) {
      return profiles.get(`${guildId}:${userId}`) ?? null;
    },
    getLore(guildId: string) {
      return lore.get(guildId) ?? [];
    },
    setLore(guildId: string, incoming: unknown, opts: Parameters<typeof upsertLore>[2]) {
      const { entries, upserted } = upsertLore(lore.get(guildId) ?? [], incoming, opts);
      lore.set(guildId, entries);
      return upserted;
    },
    removeLore(guildId: string, id: string) {
      const current = lore.get(guildId) ?? [];
      const next = current.filter((e: Untyped) => e.id !== id);
      lore.set(guildId, next);
      return next.length !== current.length;
    },
    adjustAffinity(guildId: string, userId: string, delta: number, reason: string, opts: AffinityOpts) {
      const key = `${guildId}:${userId}`;
      const profile = profiles.get(key) ?? { id: String(userId), affinity: emptyAffinity() };
      profile.affinity = applyDelta(profile.affinity ?? emptyAffinity(), delta, reason, opts);
      profiles.set(key, profile);
      return profile.affinity;
    },
    privates,
    forgottenPrivate,
    getPrivate(guildId: string, userId: string) {
      return privates.get(`${guildId}:${userId}`) ?? null;
    },
    listPrivate(guildId: string) {
      const prefix = `${guildId}:`;
      return [...privates.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
    },
    countUsers() {
      return profiles.size;
    },
    listUserProfiles(guildId: string) {
      const prefix = `${guildId}:`;
      return [...profiles.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value);
    },
    participation: new Map<string, Untyped>(), // guildId -> { episodes, nextId }
    getParticipation(this: { participation: Map<string, Untyped> }, guildId: string) {
      return structuredClone(this.participation.get(guildId) ?? { episodes: [], nextId: 1 });
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
