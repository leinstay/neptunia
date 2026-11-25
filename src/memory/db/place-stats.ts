// What a place's row and its tally say of it, for the current place of `<surroundings>` and the entries of `<places>`:
// the topic the interface gives the place (`places.topic`), who writes there most, how active it is and the moment of
// its last message. The tally is the place's `channel` entry (channel-entry.ts), read through the store's own reader.
// Read only, under the turn's context.

import { channelActivity } from '../channels.ts';
import { channelEntryValue } from './channel-entry.ts';
import { placeAudience } from './graph.ts';
import { allowedAudience } from './scope.ts';
import type { Context } from './scope.ts';
import { placeCollection } from './unit-keys.ts';
import type { Db } from './types.ts';

/** How many writers a place's stats name. */
const WRITERS = 5;

/** What a place's row and its tally say of it. `writers` are native account ids, the most writing first, at most five. */
export type PlaceStats = {
  topic: string | null;
  writers: Array<string>;
  activity: 'live' | 'slow' | 'dead' | null;
  lastMessageAt: number | null;
};

const textOf = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** The ids of a tally's `topWriters`, best first, a row without an id left out. */
function writersOf(top: unknown): Array<string> {
  if (!Array.isArray(top)) return [];
  return top
    .flatMap((one: unknown) => (typeof one === 'object' && one !== null ? (textOf(Reflect.get(one, 'id')) ?? []) : []))
    .slice(0, WRITERS);
}

/** The stats of a place the context may read, null for a place it may not read or that does not exist. */
export function placeStatsOf(db: Db, ctx: Context, placeId: string, now: number): PlaceStats | null {
  const place = db.prepare('SELECT id, iface, kind, chat, topic FROM places WHERE id = ?').get(placeId);
  if (place === undefined || !allowedAudience({ audience_id: placeAudience(place) }, ctx)) return null;
  const entry = channelEntryValue(db, placeCollection('channel', placeId));
  const tally = entry.found && typeof entry.value === 'object' && entry.value !== null ? entry.value : null;
  const last: unknown = tally === null ? null : Reflect.get(tally, 'lastMessageAt');
  const days: unknown = tally === null ? null : Reflect.get(tally, 'days');
  const lastMessageAt = typeof last === 'number' && Number.isFinite(last) ? last : null;
  return {
    topic: textOf(place.topic),
    writers: tally === null ? [] : writersOf(Reflect.get(tally, 'topWriters')),
    activity:
      tally === null
        ? null
        : channelActivity(
            { days: typeof days === 'object' && days !== null ? (days as Record<string, number>) : {}, lastMessageAt },
            now
          ),
    lastMessageAt,
  };
}
