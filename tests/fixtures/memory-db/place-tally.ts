// A place's tally as the store keeps it for a channel entry (src/memory/db/channel-entry.ts): the topic of the place's
// row, the messages per UTC day, the moment of the last message and the writers with their counts. It goes in through
// the write kind `channel-entry`, the public writer `touchChannel` ends in, so the rows are the ones production leaves.
// Names, ids and texts are made up by the test that calls it.
import { applyMemoryWrite } from '../../../src/memory/db/session-write.ts';
import type { World } from './mind-world.ts';

/** What a test stores for one place: `writers` maps a writer's native id to the messages counted for them. */
export type Tally = {
  iface: string;
  /** The topic the interface gives the place; a direct chat keeps none. */
  topic?: string | null;
  /** The stored purpose of the place, a description beside its tally. */
  purpose?: string;
  days?: Record<string, number>;
  lastMessageAt?: number | null;
  writers?: Record<string, number>;
};

/** Stores `tally` as the entry of `placeId`, written at `now`. */
export function storeTally(world: World, placeId: string, tally: Tally, now: number): void {
  const last = tally.lastMessageAt ?? null;
  const counts = Object.entries(tally.writers ?? {});
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const value: Record<string, unknown> = {
    id: placeId.split(':').pop(),
    // The name the place already has, as `touchChannel` keeps what the interface reported.
    name: world.db.prepare('SELECT name FROM places WHERE id = ?').get(placeId)?.name ?? null,
    topic: tally.topic ?? null,
    days: tally.days ?? {},
    messageCount: Object.values(tally.days ?? {}).reduce((sum, n) => sum + n, 0),
    firstMessageAt: last,
    lastMessageAt: last,
    writers: Object.fromEntries(counts.map(([id, count]) => [id, { count, last: last ?? 0 }])),
    topWriters: ranked.slice(0, 5).map(([id, count]) => ({ id, count })),
    updatedAt: new Date(now).toISOString(),
    ...(tally.purpose === undefined ? {} : { purpose: tally.purpose }),
  };
  applyMemoryWrite(world.handle, { kind: 'channel-entry', placeId, value, iface: tally.iface, now });
}
