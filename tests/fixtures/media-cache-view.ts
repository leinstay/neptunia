// The describer's cache of a store seen as an object of entries by key, for the tests that set and read entries: reading
// a key reads its row (store.mediaEntry), setting one writes it (store.putMediaEntry), deleting one drops it
// (store.dropMediaEntry), and the keys are those of the whole cache (store.mediaEntries). Nothing is kept here.
import type { MediaCachePort } from '../../src/memory/store-media.ts';
import type { Untyped } from '../../src/tools/types.ts';

export function cacheView(given: unknown, placeId: string): Record<string, Untyped> {
  // A store, or a fake of one, with the cache's four methods: the tests hand it in as they built it.
  const store = given as MediaCachePort;
  const entryOf = (key: string | symbol) => (typeof key === 'string' ? store.mediaEntry(placeId, key) : undefined);
  return new Proxy<Record<string, Untyped>>(
    {},
    {
      get: (_target, key) => entryOf(key),
      set: (_target, key, value) => {
        store.putMediaEntry(placeId, String(key), value);
        return true;
      },
      deleteProperty: (_target, key) => {
        store.dropMediaEntry(placeId, String(key));
        return true;
      },
      has: (_target, key) => entryOf(key) !== undefined,
      ownKeys: () => Object.keys(store.mediaEntries(placeId)),
      getOwnPropertyDescriptor: (_target, key) => {
        const value = entryOf(key);
        return value === undefined ? undefined : { value, enumerable: true, configurable: true, writable: true };
      },
    }
  );
}
