// A fake of the reads `<meanwhile>` takes (src/turn/request/meanwhile.ts), over lines held in memory. The shape the
// specifier of slice 4 chose:
//   reads.ownMessages(limit) -> her newest lines the turn may read, newest first, at most `limit`, each with
//     the path of its place by names from the interface down and whether that place is a one-to-one chat (`dm`)
//   reads.around(placeId, at, count) -> the lines of that place from `count` before the line at `at` to `count` after
//     it, the line itself included, oldest first
// The fake applies no access rule and no exclusion, so a test sees what meanwhileOf itself keeps out.

export type MeanwhileLine = {
  id: string;
  placeId: string;
  at: number;
  authorId: string | null;
  self: boolean;
  text: string;
};

export type OwnMessage = MeanwhileLine & { path: ReadonlyArray<string>; dm: boolean };

export type FakeMeanwhileReads = {
  ownMessages(limit: number): ReadonlyArray<OwnMessage>;
  around(placeId: string, at: number, count: number): ReadonlyArray<MeanwhileLine>;
};

/** A place of the fake: its id, its path, whether it is a one-to-one chat, and its lines oldest first. */
export type FakePlace = { id: string; path: ReadonlyArray<string>; dm: boolean; lines: ReadonlyArray<MeanwhileLine> };

export function meanwhileReads(places: ReadonlyArray<FakePlace>): FakeMeanwhileReads {
  return {
    ownMessages(limit) {
      const own = places.flatMap((place) =>
        place.lines.filter((line) => line.self).map((line) => ({ ...line, path: place.path, dm: place.dm }))
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
export function line(placeId: string, id: string, at: number, authorId: string | null, text: string): MeanwhileLine {
  return { id, placeId, at, authorId, self: authorId === null, text };
}
