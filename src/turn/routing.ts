// Where the persona's words go when she cannot write where they are about, and which channels a turn can name: the
// usable destination, the route of a routed call or a noticed comment, the `<channel_directory>` input, the snapshot an
// attempt took and whether a conversation belongs to a community. src/behavior/turn.js asks these per attempt; `<senses>` and the noticed
// comments ask usableDestination and routeFor through its re-exports.

import { resolveDestination } from '../behavior/elsewhere.ts';
import { audienceAllows, isReadable, isWritable } from '../behavior/snapshot.ts';
import type { Snapshot } from '../behavior/snapshot.ts';
import type { ConversationInfo } from '../protocol/adapter.ts';

/** The live config, as far as the routing reads it. */
type RouteConfig =
  | (NonNullable<Parameters<typeof resolveDestination>[0]> & { bot?: { dryRunChannelId?: unknown } | null })
  | null
  | undefined;

export type Destination =
  { channel: ConversationInfo; reason: null } | { channel: null; reason: 'off' | 'no-destination' };

/**
 * Where the persona's words about a channel it cannot write in go (a call
 * from there, a remark on it), read from `config` (the live config) at the
 * call: the first id of `memory.mainChannelIds`
 * (src/behavior/elsewhere.ts#resolveDestination) that is a conversation of
 * `snapshot` the persona may write in (src/behavior/snapshot.ts#isWritable:
 * a channel, not a thread, never the dry-run mirror, its history
 * readable, she can send) and not `exceptId` (the
 * channel the words are about). The one copy of the rule: `<senses>` names
 * this channel, and whatever routes a call there asks the same function.
 * `snapshot` is the turn's listing of the community; none (a private chat) has no destination. `reason` is
 * resolveDestination's code: `off` with features.elsewhere false, else `no-destination`.
 */
export function usableDestination(
  snapshot: Snapshot | null | undefined,
  config: RouteConfig,
  { exceptId = null }: { exceptId?: string | null } = {}
): Destination {
  const usable = (id: string) => {
    const target = snapshot?.get(String(id)) ?? null;
    return target !== null && id !== exceptId && isWritable(target, config?.bot ?? {});
  };
  const found = resolveDestination(config, usable);
  if (found.destinationId === null) return { channel: null, reason: found.reason };
  // `usable` found the destination in the snapshot, so both are there.
  return { channel: snapshot!.get(String(found.destinationId))!, reason: null };
}

/**
 * Where the persona's words about `source` (a channel the persona cannot send
 * in) go, read from `config` (the live config) now: `{ destination, reason:
 * null }` with the conversation, or `{ destination: null, reason }`
 * with the code logged as `route`: `off` (features.elsewhere false),
 * `no-destination` (no usable memory.mainChannelIds entry other than the
 * source, `usableDestination`) or `audience` (someone who
 * can view the destination cannot view the source,
 * src/behavior/snapshot.ts#audienceAllows). The one copy of the route of a
 * routed call and of a noticed comment. `source` is a conversation of `snapshot`, with its audience.
 */
export function routeFor(
  source: ConversationInfo,
  snapshot: Snapshot | null | undefined,
  config: RouteConfig
):
  | { destination: ConversationInfo; reason: null }
  | { destination: null; reason: 'off' | 'no-destination' | 'audience' } {
  const { channel: destination, reason } = usableDestination(snapshot, config, { exceptId: source.id });
  if (!destination) return { destination: null, reason };
  if (!audienceAllows(destination, source, config)) return { destination: null, reason: 'audience' };
  return { destination, reason: null };
}

/**
 * `<channel_directory>`'s input: every channel of the snapshot's community the persona may read (never a thread, never the
 * dry-run mirror), as `{ id, name, category }`. None without a listing (a private chat, an interface that offers none).
 * `bot` is the live `config.bot`.
 */
export function channelDirectoryOf(
  snapshot: Snapshot | null | undefined,
  bot: { dryRunChannelId?: unknown } | null | undefined
): Array<{ id: string; name: string | null | undefined; category: string | null }> {
  return (snapshot?.conversations ?? [])
    .filter((entry) => isReadable(entry, bot))
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      category: typeof entry.category === 'string' ? entry.category : null,
    }));
}

/** Whether a conversation belongs to a community (a channel or a thread), not a private chat. */
export const inCommunity = (channel: { communityId?: string | null } | null | undefined): boolean =>
  channel?.communityId !== null && channel?.communityId !== undefined;

/** The snapshot a turn attempt took, kept on its draft. */
export function snapshotOfDraft(draft: { snapshot?: Snapshot | null } | null | undefined): Snapshot | null {
  return draft?.snapshot ?? null;
}
