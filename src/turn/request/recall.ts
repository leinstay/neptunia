// The automatic memory prefetch of a turn as its request reads it: its excerpts, of which the stored facts go to
// `<found>` (src/turn/request/framed.ts).

/** One excerpt the prefetch offered: a stretch of history or a stored item. */
export type Excerpt = {
  readonly lines?: unknown;
  readonly source?: string;
  readonly date?: string;
  readonly who?: string;
  readonly id?: string;
  readonly startTs?: number;
  readonly channelName?: string | null;
  readonly hitIds?: unknown;
  readonly versionId?: string;
  readonly state?: string;
  readonly polarity?: string;
};

/** The automatic memory prefetch of a turn (src/behavior/recall-run.ts `prefetch`). */
export type Prefetch = {
  readonly status: string;
  readonly basis?: Array<string>;
  readonly excerpts?: Array<Excerpt | null>;
};
