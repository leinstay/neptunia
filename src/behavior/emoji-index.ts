// The core's index of the custom emoji of a place, kept from the interface's `emoji.list` read for 60 seconds. Each
// read names every emoji of the list through the store's stable names (`media_names`), so the index answers by the
// stable name `e23` with the current platform name. The turn refreshes it before it builds a request; `byName`, `list`
// and `urlOf` then answer from what the last refresh held, without waiting. An interface sends no event when an emoji changes, so the age of the list is the only thing
// that brings a change in. A failed or unsupported read keeps the last list of the same place. A turn with no place in
// a tree, a private chat or the persona's own, refreshes with null: the interface answers what it offers outside any.

import type { EmojiInfo } from '../protocol/adapter.ts';
import type { Reads } from '../interface/reads.ts';
import type { NamedEmoji } from './emoji.ts';
import type { MediaName, MediaNameItem } from '../memory/store-media-names.ts';

/** How long a read of the list stands (a decision of 2026-10-26: the interface sends no change event). */
const EMOJI_TTL_MS = 60_000;

/** An emoji as the turn lists it: its stable name, its current platform name and no address. */
export type IndexedEmoji = NamedEmoji;

/** The store's stable names the index reads and issues. */
export type EmojiNames = {
  nameMedia(iface: string, kind: 'emoji', items: ReadonlyArray<MediaNameItem>): Array<MediaName>;
  mediaNameOf(name: string): MediaName | null;
};

export type EmojiIndex = {
  /** Reads the list again when it is older than 60 seconds or belongs to another place. Never throws. */
  refresh(placeId: string | null): Promise<void>;
  /** The emoji with the stable name `name`, when the current list holds its id and the platform offers it. */
  byName(name: string): IndexedEmoji | null;
  list(): Array<IndexedEmoji>;
  /** The address of the picture of the emoji with this id. */
  urlOf(id: string): string | null;
};

/** Reads the place's custom emoji again unless `features.customEmoji` is off (media pick, the persona's `:name:`). */
export function refreshEmojiIfOn(emoji: EmojiIndex | null | undefined, placeId: string | null): Promise<void> {
  return emoji ? emoji.refresh(placeId) : Promise.resolve();
}

/** `deps.iface` is read at each use: the core's served interface is named once its link says hello. */
export function createEmojiIndex(deps: {
  reads: Reads;
  now: () => number;
  iface: string;
  names: EmojiNames;
}): EmojiIndex {
  const { reads, now, names } = deps;
  let held: ReadonlyArray<EmojiInfo> = [];
  let named: Array<IndexedEmoji> = [];
  // Undefined until the first read: null is a place of its own, the one with no tree.
  let heldFor: string | null | undefined;
  let readAt: number | null = null;
  let reading: Promise<void> | null = null;
  let readingFor: string | null | undefined;

  async function read(placeId: string | null): Promise<void> {
    const answer = await reads.emoji({ placeId });
    if (heldFor !== placeId) {
      held = [];
      named = [];
      heldFor = placeId;
      readAt = null;
    }
    if (answer === null) return;
    held = answer.emoji;
    const issued = names.nameMedia(
      deps.iface,
      'emoji',
      held.map((emoji) => ({ nativeId: emoji.id, platformName: emoji.name, animated: emoji.animated }))
    );
    named = held.map((emoji, at) => ({
      id: emoji.id,
      name: issued[at].name,
      platformName: emoji.name,
      animated: emoji.animated,
    }));
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
    byName(name) {
      const row = names.mediaNameOf(name);
      if (row?.kind !== 'emoji' || row.iface !== deps.iface) return null;
      const at = held.findIndex((emoji) => emoji.id === row.nativeId && emoji.available !== false);
      return at === -1 ? null : { ...named[at] };
    },
    list: () => named.map((emoji) => ({ ...emoji })),
    urlOf: (id) => held.find((emoji) => emoji.id === id)?.url ?? null,
  };
}
