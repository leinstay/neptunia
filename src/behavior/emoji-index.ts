// The core's index of the custom emoji of a place, kept from the interface's `emoji.list` read for 60 seconds. The
// turn refreshes it before it builds a request; `byName`, `list` and `urlOf` then answer from what the last refresh
// held, without waiting. An interface sends no event when an emoji changes, so the age of the list is the only thing
// that brings a change in. A failed or unsupported read keeps the last list of the same place. A turn with no place in
// a tree, a private chat or the persona's own, refreshes with null: the interface answers what it offers outside any.

import type { EmojiInfo } from '../protocol/adapter.ts';
import type { Reads } from '../interface/reads.ts';
import { matchEmojiName } from './emoji.ts';

/** How long a read of the list stands (a decision of 2026-10-26: the interface sends no change event). */
const EMOJI_TTL_MS = 60_000;

/** An emoji as the turn lists it: no address. */
export type IndexedEmoji = { id: string; name: string; animated: boolean };

export type EmojiIndex = {
  /** Reads the list again when it is older than 60 seconds or belongs to another place. Never throws. */
  refresh(placeId: string | null): Promise<void>;
  /** The emoji called `name`: an exact match, else the only one that matches ignoring case. */
  byName(name: string): IndexedEmoji | null;
  list(): Array<IndexedEmoji>;
  /** The address of the picture of the emoji with this id. */
  urlOf(id: string): string | null;
};

/** Reads the place's custom emoji again when `features.customEmoji` is not off (the `<emoji>` block and her `:name:`). */
export function refreshEmojiIfOn(emoji: EmojiIndex | null | undefined, placeId: string | null): Promise<void> {
  return emoji ? emoji.refresh(placeId) : Promise.resolve();
}

export function createEmojiIndex({ reads, now }: { reads: Reads; now: () => number }): EmojiIndex {
  let held: ReadonlyArray<EmojiInfo> = [];
  // Undefined until the first read: null is a place of its own, the one with no tree.
  let heldFor: string | null | undefined;
  let readAt: number | null = null;
  let reading: Promise<void> | null = null;
  let readingFor: string | null | undefined;

  async function read(placeId: string | null): Promise<void> {
    const answer = await reads.emoji({ placeId });
    if (heldFor !== placeId) {
      held = [];
      heldFor = placeId;
      readAt = null;
    }
    if (answer === null) return;
    held = answer.emoji;
    readAt = now();
  }

  function refresh(placeId: string | null): Promise<void> {
    if (reading !== null) return readingFor === placeId ? reading : reading.then(() => refresh(placeId));
    if (heldFor === placeId && readAt !== null && now() - readAt < EMOJI_TTL_MS) return Promise.resolve();
    readingFor = placeId;
    reading = read(placeId).finally(() => {
      reading = null;
    });
    return reading;
  }

  return {
    refresh,
    byName: (name) => matchEmojiName(held, name),
    list: () => held.map(({ id, name, animated }) => ({ id, name, animated })),
    urlOf: (id) => held.find((emoji) => emoji.id === id)?.url ?? null,
  };
}
