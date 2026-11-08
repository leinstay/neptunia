// The rails a read of another chat must pass: `checkPull` decides whether the persona may read a chat
// of the turn's snapshot from the chat she speaks in (a readable channel, not a thread, visible to everyone who
// can view the chat she speaks in -- in a private chat, to the partner -- and not older than
// `context.pull.maxAgeDays`). Her reads of another place (src/turn/in-turn-tools.ts, src/tools/operations/search.ts), the
// places a read may name (src/behavior/readable-places.ts) and the search of the message history ask it. No read is
// made here.

import type { ChatInfo } from '../protocol/adapter.ts';
import { isTooOld, pullSettings } from './pull.ts';
import { audienceAllows, isReadable } from './snapshot.ts';
import type { Snapshot } from './snapshot.ts';

type Config = Record<string, unknown>;

/** A refusal: nothing of the chat. */
const refused = (skip: string): { channel: null; skip: string } => ({ channel: null, skip });

/**
 * Why `entry` is not one the persona may read, or null when it is. The decision is `isReadable`'s (the one rule every
 * reader obeys, neighbours included); the checks after it only name the refusal, and a refusal none of them names is
 * `not-readable`.
 */
function readableRefusal(entry: ChatInfo): string | null {
  if (isReadable(entry)) return null;
  if (entry.kind === 'thread') return 'thread';
  return 'not-readable';
}

/**
 * The rails a pull must pass before anything is read, in this order, each with its kebab-case skip code: a
 * `destination` that is given is a chat of a root, or a private chat with its `partnerId`
 * (`private-chat` without one, whatever the audience rail says); the id is a chat of the snapshot
 * (`not-found`); the chat is one the persona may read (`isReadable`, the rule neighbours obey too), the refusal
 * named `thread` or else `not-readable`; the audience rail toward
 * `destination` (see `audienceAllows`: in a private chat, the partner's view of it); and its newest message not older
 * than a positive `context.pull.maxAgeDays` (`too-old`; 0, the default, never refuses). No read is made.
 */
export function checkPull({
  snapshot,
  placeId,
  destination = null,
  partnerId = null,
  config,
  now = Date.now(),
}: {
  snapshot: Snapshot | null;
  placeId: string;
  destination?: ChatInfo | null;
  partnerId?: string | null;
  config: Config;
  now?: number;
}): { channel: ChatInfo | null; skip: string | null } {
  if (destination && destination.rootId === null && partnerId === null) return refused('private-chat');
  const entry = typeof placeId === 'string' && placeId ? (snapshot?.get(placeId) ?? null) : null;
  if (entry === null) return refused('not-found');
  const unreadable = readableRefusal(entry);
  if (unreadable) return refused(unreadable);
  if (!audienceAllows(destination, entry, config, { partnerId })) return refused('audience');
  const last = entry.lastMessageAt ?? 0;
  if (last > 0 && isTooOld(last, { maxAgeDays: pullSettings(config).maxAgeDays, now })) return refused('too-old');
  return { channel: entry, skip: null };
}
