// The conversations of the served community as one listing taken once per turn attempt: every rail that looks at
// other conversations (the neighbours, the pulled channels, participation, routing, the places she is shown) reads this
// snapshot instead of asking the interface again. The functions here decide over its entries: which conversations the
// persona may read or write, whether the audience of one covers another, and the audience in the shape the rail of
// src/behavior/elsewhere.ts compares. No I/O but the one listing, no platform object.

import type { Audience, ConversationInfo, GroupInfo } from '../protocol/adapter.ts';
import type { Reads } from '../interface/reads.ts';
import { audienceCovers } from './elsewhere.ts';
import { pullSettings } from './pull.js';

/** The listing: the conversations with their audience and viewers, the groups of the community. */
export type Snapshot = {
  communityId: string;
  conversations: ReadonlyArray<ConversationInfo>;
  groups: ReadonlyArray<GroupInfo>;
  get(conversationId: string): ConversationInfo | null;
};

/** The snapshot of a listing as `conversations` answered it. */
export function snapshotOf(
  communityId: string,
  listing: { conversations: ReadonlyArray<ConversationInfo>; groups: ReadonlyArray<GroupInfo> }
): Snapshot {
  const byId = new Map(listing.conversations.map((entry) => [entry.id, entry]));
  return {
    communityId,
    conversations: listing.conversations,
    groups: listing.groups,
    get: (conversationId) => byId.get(String(conversationId)) ?? null,
  };
}

/**
 * One listing of `communityId` with the audience of every conversation and which of `viewers` can see each, or null when
 * the interface does not answer it (a block that needs it is then left out).
 */
export async function takeSnapshot(
  reads: Reads,
  communityId: string,
  viewers: ReadonlyArray<string> = []
): Promise<Snapshot | null> {
  const listing = await reads.conversations({ communityId, audience: true, viewers });
  return listing === null ? null : snapshotOf(communityId, listing);
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

/** The wire audience of a conversation as the rail reads it; null for one with no audience (a private chat, a thread). */
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

type Bot = { dryRunChannelId?: unknown } | null | undefined;

/**
 * Whether the persona may read the conversation: a channel of a community (not a thread, not a private chat), not the
 * dry-run mirror (`bot.dryRunChannelId`), its history readable.
 */
export function isReadable(entry: ConversationInfo, bot: Bot): boolean {
  const mirror = bot?.dryRunChannelId;
  return !(mirror && entry.id === mirror) && entry.kind === 'channel' && entry.permissions.read;
}

/** Whether the persona may speak there unasked or on someone's behalf: readable, and she can send. */
export function isWritable(entry: ConversationInfo, bot: Bot): boolean {
  return isReadable(entry, bot) && entry.permissions.send;
}

/**
 * Whether content of `source` may enter a turn in `destination`. A private chat (a destination with no community) has
 * one reader: the source must be a conversation its `partnerId` can view, whatever `context.pull.sameAudience` says;
 * no partner never qualifies. Elsewhere, with `context.pull.sameAudience` (the live `config`; only `false` turns it
 * off) everyone who can view the destination must be able to view the source (`audienceCovers`, no shortcut for a
 * source everyone can view). A missing destination or a thread never qualifies while the rail is on.
 */
export function audienceAllows(
  destination: ConversationInfo | null | undefined,
  source: ConversationInfo | null | undefined,
  config: unknown,
  { partnerId = null }: { partnerId?: string | null } = {}
): boolean {
  if (destination && destination.communityId === null) {
    return partnerId !== null && source?.communityId !== null && source?.viewers?.[partnerId] === true;
  }
  if (!pullSettings(config as object).sameAudience) return true;
  return audienceCovers(railAudience(destination?.audience), railAudience(source?.audience));
}

/** The audience of "every member of the community": everyone views it and no group or member is held back. */
export function everyMemberAudience(): RailAudience {
  return {
    everyone: true,
    roles: new Set(),
    roleAllow: new Set(),
    roleDeny: new Set(),
    memberAllow: new Set(),
    memberDeny: new Set(),
    memberRoles: new Map(),
  };
}
