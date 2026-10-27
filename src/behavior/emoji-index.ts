// The core's index of the community's custom emoji, kept from the interface's `emoji.list` read for 60 seconds. The
// turn refreshes it before it builds a request; `byName`, `list` and `urlOf` then answer from what the last refresh
// held, without waiting. An interface sends no event when an emoji changes, so the age of the list is the only thing
// that brings a change in. A failed or unsupported read keeps the last list of the same community.

import type { EmojiInfo } from '../protocol/adapter.ts';
import type { Reads } from '../interface/reads.ts';
import { matchEmojiName } from './emoji.js';
import { objOf } from '../tools/types.ts';

/** How long a read of the list stands (a decision of 2026-10-26: the interface sends no change event). */
const EMOJI_TTL_MS = 60_000;

/** An emoji as the turn lists it: no address. */
export type IndexedEmoji = { id: string; name: string; animated: boolean };

export type EmojiIndex = {
  /** Reads the list again when it is older than 60 seconds or belongs to another community. Never throws. */
  refresh(): Promise<void>;
  /** The emoji called `name`: an exact match, else the only one that matches ignoring case. */
  byName(name: string): IndexedEmoji | null;
  list(): Array<IndexedEmoji>;
  /** The address of the picture of the emoji with this id. */
  urlOf(id: string): string | null;
};

/** Reads the community's custom emoji again when `features.customEmoji` is not off (the `<emoji>` block and her `:name:`). */
export function refreshEmojiIfOn(emoji: EmojiIndex | null | undefined, config: unknown): Promise<void> {
  const features = objOf(objOf(config).features);
  return emoji && features.customEmoji !== false ? emoji.refresh() : Promise.resolve();
}

export function createEmojiIndex({
  reads,
  communityId,
  now,
}: {
  reads: Reads;
  communityId: () => string | null;
  now: () => number;
}): EmojiIndex {
  let held: ReadonlyArray<EmojiInfo> = [];
  let heldFor: string | null = null;
  let readAt: number | null = null;
  let reading: Promise<void> | null = null;

  async function read(community: string): Promise<void> {
    const answer = await reads.emoji({ communityId: community });
    if (heldFor !== community) {
      held = [];
      heldFor = community;
    }
    if (answer === null) return;
    held = answer.emoji;
    readAt = now();
  }

  return {
    refresh() {
      if (reading !== null) return reading;
      const community = communityId();
      if (community === null) {
        held = [];
        heldFor = null;
        readAt = null;
        return Promise.resolve();
      }
      if (heldFor === community && readAt !== null && now() - readAt < EMOJI_TTL_MS) return Promise.resolve();
      reading = read(community).finally(() => {
        reading = null;
      });
      return reading;
    },
    byName: (name) => matchEmojiName(held, name),
    list: () => held.map(({ id, name, animated }) => ({ id, name, animated })),
    urlOf: (id) => held.find((emoji) => emoji.id === id)?.url ?? null,
  };
}
