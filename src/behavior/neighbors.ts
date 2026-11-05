// Up to `NEIGHBOR_MESSAGES` recent messages from each neighbouring conversation that saw activity within
// `NEIGHBOR_MAX_AGE_MINUTES`, read from the turn's snapshot: conversations are filtered by the time of their newest
// message, so quiet ones cost no read. Only conversations the persona may read are neighbours, and only those `accept` takes (the caller's rail, the audience rule), judged among the active ones BEFORE the
// `NEIGHBOR_MAX_CHANNELS` cut, so a refused conversation takes no slot and costs no read; no `accept` takes every one.
// `readOnly` marks a neighbour the persona cannot send in. A turn in a private chat has no neighbours.

import type { ConversationInfo } from '../protocol/adapter.ts';
import type { Reads } from '../interface/reads.ts';
import { log } from '../log.ts';
import { MINUTE_MS } from '../time.ts';
import { historyLines } from './lines.ts';
import type { Line } from './lines.ts';
import type { Snapshot } from './snapshot.ts';
import { isReadable } from './snapshot.ts';

// Production values, config cut of 2026-10-31.
const NEIGHBOR_MESSAGES = 5;
const NEIGHBOR_MAX_AGE_MINUTES = 60;
const NEIGHBOR_MAX_CHANNELS = 8;

export type Neighbor = { placeId: string; channelName: string | null; readOnly: boolean; messages: Array<Line> };

export async function fetchNeighbors(
  reads: Reads,
  snapshot: Snapshot,
  here: ConversationInfo,
  now: number = Date.now(),
  { accept }: { accept?: (other: ConversationInfo) => boolean } = {}
): Promise<Array<Neighbor>> {
  if (here.rootId === null) return [];
  const minTs = now - NEIGHBOR_MAX_AGE_MINUTES * MINUTE_MS;
  const lastAt = (entry: ConversationInfo): number => entry.lastMessageAt ?? 0;

  const candidates = snapshot.conversations
    .filter((other) => other.id !== here.id && isReadable(other))
    .filter((other) => lastAt(other) >= minTs)
    .filter((other) => typeof accept !== 'function' || accept(other))
    .sort((a, b) => lastAt(b) - lastAt(a))
    .slice(0, NEIGHBOR_MAX_CHANNELS);

  const results = await Promise.all(
    candidates.map(async (other): Promise<Neighbor> => {
      const readOnly = !other.permissions.send;
      try {
        const lines = await historyLines(
          reads,
          { iface: other.iface, conversationId: other.id },
          { limit: NEIGHBOR_MESSAGES }
        );
        return {
          placeId: other.id,
          channelName: other.name ?? null,
          readOnly,
          messages: lines.filter((line) => line.ts >= minTs),
        };
      } catch (err) {
        log.warn('collect: neighbour channel fetch failed', { channel: other.id, error: err });
        return { placeId: other.id, channelName: other.name ?? null, readOnly, messages: [] };
      }
    })
  );
  return results.filter((result) => result.messages.length > 0);
}
