// What memory learned of a place, as a request quotes it: the stored place notes (`PlaceMemory`, read by `<self>` and
// the diary's notes).

/** What the place's memory holds about the server (store.getPlace), as `<about_chat>` and `<self_facts>` read it. */
export type PlaceMemory = {
  readonly patterns?: string;
  readonly starters?: string;
  readonly injokes?: Array<string>;
  readonly learned?: unknown;
  readonly self?: Array<string>;
  readonly emojiUsage?: unknown;
};
