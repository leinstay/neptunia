// The chats of the served root as one listing taken once per turn attempt: every rail that looks at
// other chats (the neighbours, the pulled channels, participation, routing, the places she is shown) reads this
// snapshot instead of asking the interface again. The functions here decide over its entries: which chats the
// persona may read or write, whether the audience of one covers another, and the audience in the shape the rail of
// src/behavior/elsewhere.ts compares. No I/O but the one listing, no platform object.

import type { Audience, ChatInfo, GroupInfo } from '../protocol/adapter.ts';
import type { Reads } from '../interface/reads.ts';
import { audienceCovers } from './elsewhere.ts';
import { pullSettings } from './pull.ts';

/** The listing: the chats with their audience and viewers, the groups of the root. */
export type Snapshot = {
  placeId: string;
  chats: ReadonlyArray<ChatInfo>;
  groups: ReadonlyArray<GroupInfo>;
  get(chatId: string): ChatInfo | null;
};

/** The snapshot of a listing as `chats` answered it. */
export function snapshotOf(
  placeId: string,
  listing: { chats: ReadonlyArray<ChatInfo>; groups: ReadonlyArray<GroupInfo> }
): Snapshot {
  const byId = new Map(listing.chats.map((entry) => [entry.id, entry]));
  return {
    placeId,
    chats: listing.chats,
    groups: listing.groups,
    get: (chatId) => byId.get(String(chatId)) ?? null,
  };
}

/**
 * One listing of `placeId` with the audience of every chat and which of `viewers` can see each, or null when
 * the interface does not answer it (a block that needs it is then left out).
 */
export async function takeSnapshot(
  reads: Reads,
  placeId: string,
  viewers: ReadonlyArray<string> = []
): Promise<Snapshot | null> {
  const listing = await reads.chats({ placeId, audience: true, viewers });
  return listing === null ? null : snapshotOf(placeId, listing);
}

/** One snapshot over every place of `placeIds`: the one's own, or the chats and groups of all; null when none answers. */
export async function takeSnapshotOf(
  reads: Reads,
  placeIds: ReadonlyArray<string>,
  viewers: ReadonlyArray<string> = []
): Promise<Snapshot | null> {
  const [only] = placeIds;
  if (placeIds.length === 1 && only !== undefined) return takeSnapshot(reads, only, viewers);
  const listings = await Promise.all(placeIds.map((placeId) => reads.chats({ placeId, audience: true, viewers })));
  const found = listings.filter((listing) => listing !== null);
  if (found.length === 0 || only === undefined) return null;
  return snapshotOf(only, {
    chats: found.flatMap((listing) => [...listing.chats]),
    groups: found.flatMap((listing) => [...listing.groups]),
  });
}

/** The audience in the shape `audienceCovers` compares: the arrays of the wire as sets, the groups as its roles. */
export type RailAudience = {
  everyone: boolean;
  roles: Set<string>;
  roleAllow: Set<string>;
  roleDeny: Set<string>;
  memberAllow: Set<string>;
  memberDeny: Set<string>;
  memberRoles: Map<string, Set<string>>;
};

/** The wire audience of a chat as the rail reads it; null for one with no audience (a private chat, a thread). */
export function railAudience(audience: Audience | null | undefined): RailAudience | null {
  if (audience === null || audience === undefined) return null;
  return {
    everyone: audience.everyone,
    roles: new Set(audience.groups),
    roleAllow: new Set(audience.groupAllow),
    roleDeny: new Set(audience.groupDeny),
    memberAllow: new Set(audience.memberAllow),
    memberDeny: new Set(audience.memberDeny),
    memberRoles: new Map(Object.entries(audience.memberGroups).map(([id, held]) => [id, new Set(held)])),
  };
}

/**
 * Whether the persona may read the chat: a channel of a root (not a thread, not a private chat), its
 * history readable.
 */
export function isReadable(entry: ChatInfo): boolean {
  return entry.kind === 'channel' && entry.permissions.read;
}

/**
 * Whether content of `source` may enter a turn in `destination`. A private chat (a destination with no root) has
 * one reader: the source must be a chat its `partnerId` can view, whatever `context.pull.sameAudience` says;
 * no partner never qualifies. Elsewhere, with `context.pull.sameAudience` (the live `config`; only `false` turns it
 * off) everyone who can view the destination must be able to view the source (`audienceCovers`, no shortcut for a
 * source everyone can view). A missing destination or a thread never qualifies while the rail is on.
 */
export function audienceAllows(
  destination: ChatInfo | null | undefined,
  source: ChatInfo | null | undefined,
  config: unknown,
  { partnerId = null }: { partnerId?: string | null } = {}
): boolean {
  if (destination && destination.rootId === null) {
    return partnerId !== null && source?.rootId !== null && source?.viewers?.[partnerId] === true;
  }
  if (!pullSettings(config as object).sameAudience) return true;
  return audienceCovers(railAudience(destination?.audience), railAudience(source?.audience));
}
