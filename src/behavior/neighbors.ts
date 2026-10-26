// Up to `neighborMessages` recent messages from each neighbouring conversation that saw activity within
// `neighborMaxAgeMinutes`, read from the turn's snapshot: conversations are filtered by the time of their newest
// message, so quiet ones cost no read. Only conversations the persona may read are neighbours (never the dry-run
// mirror), and only those `accept` takes (the caller's rail, the audience rule), judged among the active ones BEFORE the
// `neighborMaxChannels` cut, so a refused conversation takes no slot and costs no read; no `accept` takes every one.
// `readOnly` marks a neighbour the persona cannot send in. A turn in a private chat has no neighbours.

import type { ConversationInfo } from '../protocol/adapter.ts';
import type { Reads } from '../interface/reads.ts';
import { log } from '../log.js';
import { MINUTE_MS } from '../time.js';
import { historyLines } from './lines.ts';
import type { Line } from './lines.ts';
import type { Snapshot } from './snapshot.ts';
import { isReadable } from './snapshot.ts';

type Config = {
  bot?: { dryRunChannelId?: unknown };
  context: { neighborMessages: number; neighborMaxAgeMinutes: number; neighborMaxChannels: number };
};

export type Neighbor = { channelId: string; channelName: string | null; readOnly: boolean; messages: Array<Line> };

export async function fetchNeighbors(
  reads: Reads,
  snapshot: Snapshot,
  here: ConversationInfo,
  config: Config,
  now: number = Date.now(),
  { accept }: { accept?: (other: ConversationInfo) => boolean } = {}
): Promise<Array<Neighbor>> {
  if (here.communityId === null) return [];
  const { neighborMessages, neighborMaxAgeMinutes, neighborMaxChannels } = config.context;
  const minTs = now - neighborMaxAgeMinutes * MINUTE_MS;
  const lastAt = (entry: ConversationInfo): number => entry.lastMessageAt ?? 0;

  const candidates = snapshot.conversations
    .filter((other) => other.id !== here.id && isReadable(other, config.bot))
    .filter((other) => lastAt(other) >= minTs)
    .filter((other) => typeof accept !== 'function' || accept(other))
    .sort((a, b) => lastAt(b) - lastAt(a))
    .slice(0, neighborMaxChannels);

  const results = await Promise.all(
    candidates.map(async (other): Promise<Neighbor> => {
      const readOnly = !other.permissions.send;
      try {
        const lines = await historyLines(
          reads,
          { iface: other.iface, conversationId: other.id },
          { limit: neighborMessages }
        );
        return {
          channelId: other.id,
          channelName: other.name ?? null,
          readOnly,
          messages: lines.filter((line) => line.ts >= minTs),
        };
      } catch (err) {
        log.warn('collect: neighbour channel fetch failed', { channel: other.id, error: err });
        return { channelId: other.id, channelName: other.name ?? null, readOnly, messages: [] };
      }
    })
  );
  return results.filter((result) => result.messages.length > 0);
}
