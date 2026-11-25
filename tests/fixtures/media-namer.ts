// The store's read of a stable name (src/memory/store-media-names.ts#mediaNameOf) as a fake over fixed rows, for a test
// that renders lines without a store. Every reader of lines takes one: the core always holds the store's.
import type { MediaName } from '../../src/memory/store-media-names.ts';

/** `mediaNameOf` over `rows`: the row of a stable name, or null for a name no row holds. */
export function mediaNamesOf(rows: ReadonlyArray<MediaName>): (name: string) => MediaName | null {
  const byName = new Map(rows.map((row) => [row.name, row]));
  return (name: string): MediaName | null => byName.get(name) ?? null;
}

/** The read of a store that has issued no stable name yet. */
export const noMediaNames: (name: string) => MediaName | null = mediaNamesOf([]);
