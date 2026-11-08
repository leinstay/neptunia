// The frame of a replayed turn (scripts/replay.ts): the turn frame a live reply would carry, built from the replay's
// channel, its trigger and the place tree of the view's memory, and the whereabouts it states, so the request carries
// `<spatial_awareness>` as a live turn's does. Pure.

import { frameOf } from '../turn/request/frame.ts';
import type { Frame } from '../turn/request/frame.ts';
import { whereaboutsOfFrame } from '../turn/request/spatial.ts';
import type { Whereabouts } from '../turn/request/spatial.ts';
import type { PlaceChainLink } from '../memory/db/place-tree.ts';

/** What the replay knows of the turn: its memory's place tree, its channel, its trigger, its clock and zone. */
export type ReplayTurn = {
  memory: {
    placeOfChat?: (chat: { id: string }, iface?: string) => string | null;
    placeChainOf?: (placeId: string) => ReadonlyArray<PlaceChainLink>;
    accountOf?: (nativeId: string, iface?: string) => string;
    personOfAccount?: (accountId: string) => string;
  };
  channel: { id: string; name?: string | null; iface?: string | null };
  trigger: { id?: string; authorId?: string | null; authorName?: string | null } | null;
  mode: string;
  triggerKind: string | null;
  now: number;
  timezone: string;
};

/** The interface a replayed channel is on when it names none. */
const REPLAY_IFACE = 'replay';

/**
 * The frame and the whereabouts of a replayed reply. The place is the channel's place in the view's tree (the channel
 * alone, by its name, when the tree does not hold it), on the interface the channel names (`replay` when it names
 * none), and the author's account and person as the memory spells them.
 */
export function replayFrame(turn: ReplayTurn): { frame: Frame; whereabouts: Whereabouts } {
  const iface = turn.channel.iface || REPLAY_IFACE;
  const memory = turn.memory;
  const placeId = memory.placeOfChat?.({ id: turn.channel.id }, iface) || turn.channel.id;
  const stored = memory.placeChainOf?.(placeId) ?? [];
  const chain = stored.length > 0 ? stored : [{ id: placeId, kind: 'channel', name: turn.channel.name ?? null }];
  const trigger = turn.trigger;
  const authorId = typeof trigger?.authorId === 'string' ? trigger.authorId : null;
  const accountId = authorId ? (memory.accountOf?.(authorId, iface) ?? authorId) : null;
  const frame = frameOf({
    mode: turn.mode,
    triggerKind: turn.triggerKind,
    wakeKind: null,
    interface: iface,
    chain,
    dm: null,
    trigger: trigger?.id && authorId ? { messageId: trigger.id, authorId } : null,
    author: accountId
      ? { personId: memory.personOfAccount?.(accountId) ?? accountId, accountId, name: trigger?.authorName ?? null }
      : null,
    now: turn.now,
    timezone: turn.timezone,
  });
  return { frame, whereabouts: whereaboutsOfFrame(frame) };
}
