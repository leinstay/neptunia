// The places a read call may name or be told about: the channels the persona can read that the reader of the turn may
// see too. The rule is the pull rail's (src/behavior/pull-fetch.ts#checkPull), asked of every conversation of the
// snapshot: in a community, a readable channel whose audience the destination's viewers all share; in a private chat
// or on the command line, one its partner (or the owner) can view. A conversation the reader may not see is never
// listed, so it can be neither matched nor named in a refusal. Pure over the snapshot.

import type { ConversationInfo } from '../protocol/adapter.ts';
import type { PlaceCandidate } from '../tools/place-names.ts';
import { checkPull } from './pull-fetch.ts';
import { snapshotOf } from './snapshot.ts';
import type { Snapshot } from './snapshot.ts';

type PullConfig = Parameters<typeof checkPull>[0]['config'];

/**
 * The places of `snapshot` a read in `destination` may name, in the snapshot's order, each with its handle in this
 * request (`handles`: handle -> conversation id) when it has one. `partnerId` is the reader of a private chat or of the
 * command line (the member the snapshot's viewers cover); a private chat without one lists nothing, and so does a
 * turn without a snapshot.
 */
export function readablePlaces({
  snapshot,
  destination,
  partnerId = null,
  config,
  handles = null,
  now = Date.now(),
}: {
  snapshot: Snapshot | null;
  destination: ConversationInfo | null;
  partnerId?: string | null;
  config: PullConfig;
  handles?: ReadonlyMap<string, string> | null;
  now?: number;
}): Array<PlaceCandidate> {
  if (snapshot === null) return [];
  // The lookup by id is rebuilt over the listing, so a caller that holds only the listing (a replay scenario) is read too.
  const listing = snapshotOf(snapshot.placeId, snapshot);
  const handleOf = new Map<string, string>();
  for (const [handle, id] of handles ?? []) if (!handleOf.has(id)) handleOf.set(id, handle);
  const places: Array<PlaceCandidate> = [];
  for (const entry of listing.conversations) {
    if (typeof entry.name !== 'string' || entry.name === '') continue;
    if (checkPull({ snapshot: listing, placeId: entry.id, destination, partnerId, config, now }).skip !== null)
      continue;
    places.push({ id: entry.id, name: entry.name, handle: handleOf.get(entry.id) ?? null });
  }
  return places;
}
