// A fake of the reads `<meanwhile>` takes (src/turn/request/meanwhile.ts), over lines held in memory. The shape the
// specifier of slice 4 chose:
//   reads.ownMessages(limit) -> her newest lines the turn may read, newest first, at most `limit`, each with
//     the path of its place by names from the interface down and whether that place is a one-to-one chat (`dm`)
//   reads.around(placeId, at, count) -> the lines of that place from `count` before the line at `at` to `count` after
//     it, the line itself included, oldest first
// The fake applies no access rule and no exclusion, so a test sees what meanwhileOf itself keeps out.

import type { PlaceChainLink } from '../../src/memory/db/place-tree.ts';

/** What an interface declares in its hello (src/protocol/serve.ts#InterfaceNames). */
export type FakeNames = { interface: string; nouns: Readonly<Record<string, string>>; dm: string };

export type MeanwhileLine = {
  id: string;
  placeId: string;
  at: number;
  authorId: string | null;
  self: boolean;
  text: string;
  /** The line's stored media, in order: its kind and the text form the memory holds (null while it has none). */
  media?: ReadonlyArray<{ kind: string; text: string | null }>;
};

export type OwnMessage = MeanwhileLine & {
  path: ReadonlyArray<string>;
  dm: boolean;
  /** The place in words: the interface's id, the chain innermost first and the interface's own names. */
  iface: string;
  chain: ReadonlyArray<PlaceChainLink>;
  names?: FakeNames;
  partner?: string | null;
  partnerKey?: string | null;
};

export type FakeMeanwhileReads = {
  ownMessages(limit: number): ReadonlyArray<OwnMessage>;
  around(placeId: string, at: number, count: number): ReadonlyArray<MeanwhileLine>;
};

/** A place of the fake: its id, its path, whether it is a one-to-one chat, and its lines oldest first. */
export type FakePlace = {
  id: string;
  path: ReadonlyArray<string>;
  dm: boolean;
  lines: ReadonlyArray<MeanwhileLine>;
  /** Given, the place in words; else worked out from `path` (the interface first, a chat last). */
  iface?: string;
  chain?: ReadonlyArray<PlaceChainLink>;
  names?: FakeNames;
  partner?: string | null;
  partnerKey?: string | null;
};

/** The chain a path of names stands for, innermost first: a one-to-one chat is one unnamed link. */
function chainOf(place: FakePlace): ReadonlyArray<PlaceChainLink> {
  if (place.chain) return place.chain;
  if (place.dm) return [{ id: place.id, kind: 'dm', name: null }];
  const names = place.path.slice(1);
  return names
    .map((name, at) => ({ id: `${place.id}:${at}`, kind: at === names.length - 1 ? 'channel' : 'server', name }))
    .reverse();
}

export function meanwhileReads(places: ReadonlyArray<FakePlace>): FakeMeanwhileReads {
  return {
    ownMessages(limit) {
      const own = places.flatMap((place) =>
        place.lines.filter((line) => line.self).map((line) => ({
          ...line,
          path: place.path,
          dm: place.dm,
          iface: place.iface ?? place.path[0] ?? '',
          chain: chainOf(place),
          names: place.names,
          partner: place.partner ?? null,
          partnerKey: place.partnerKey ?? null,
        }))
      );
      return own.sort((a, b) => b.at - a.at).slice(0, limit);
    },
    around(placeId, at, count) {
      const lines = places.find((place) => place.id === placeId)?.lines ?? [];
      const index = lines.findIndex((line) => line.at === at);
      if (index < 0) return [];
      return lines.slice(Math.max(0, index - count), index + count + 1);
    },
  };
}

/** A line of the fake at `at`, by `authorId`, or hers when `authorId` is null. */
export function line(
  placeId: string,
  id: string,
  at: number,
  authorId: string | null,
  text: string,
  media: ReadonlyArray<{ kind: string; text: string | null }> = []
): MeanwhileLine {
  return { id, placeId, at, authorId, self: authorId === null, text, media };
}
