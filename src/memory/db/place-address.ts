// The address of a place the core learned outside a message: the chat id an interface answered when the core asked it to
// open a direct chat (`dm.chat`), stored as the place's `native_id` through the one writer (session-write.ts, kind
// `place-address`). Every read and send of the place takes that address as it is. A place that holds an address keeps
// it, since a message's own address (observe.ts) is the interface's word on it.

import { dbOf } from './types.ts';
import type { Connection, Row } from './types.ts';

/** Stores `update.address` on the place `update.placeId` when it holds none. Answers how many places took it. */
export function applyPlaceAddress(connection: Connection, update: Row): { stored: number } {
  const { placeId, address } = update;
  if (typeof placeId !== 'string' || placeId === '' || typeof address !== 'string' || address === '')
    return { stored: 0 };
  const result = dbOf(connection)
    .prepare('UPDATE places SET native_id = ? WHERE id = ? AND native_id IS NULL')
    .run(address, placeId);
  return { stored: Number(result.changes) };
}
