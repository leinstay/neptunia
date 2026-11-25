// The types of the signatures in ./recall.ts: the inputs and results that are too long to read inline.

import type { Untyped } from '../tools/types.ts';

export type MeaningQueryInput = {
  candidate?: { content?: string; replyToId?: string | null } | null;
  lines?: Array<Untyped>;
  withReply?: boolean;
  nameOf?: ((id: string) => string | null | undefined) | null;
};

export type MergeWindowsResult = {
  placeId: string;
  channelName: string | null;
  messages: Array<Untyped>;
  hitIds: Set<string>;
  overlapsChat: boolean;
  descriptions?: Map<string, string>;
};

export type RenderRecallWindowsInput = {
  placeId: string;
  channelName?: string | null;
  messages: Array<Untyped>;
  hitIds?: Iterable<string>;
  descriptions?: Map<string, string>;
};

export type RenderRecallWindowsArg2 = {
  labels?: Untyped;
  timezone?: string;
  selfName?: string;
  gapMinutes?: number;
  maxChars?: number;
  seeReactions?: boolean;
  reactionsPerMessage?: number;
  indexed?: boolean;
  /** Author id -> the handle of the person behind the account: each author reads `authors.line` (src/format.ts). */
  handles?: Map<string, string>;
};

export type RenderRecallWindowsResult = {
  placeId: string;
  channelName: string | null;
  startTs: number;
  lines: Array<{ id: string; ts: number; text: string; hit: boolean }>;
};

export type MemoryContextInput = {
  forms: Untyped;
  who: Untyped;
  profiles: Untyped;
  from: Untyped;
  to: Untyped;
  timezone: Untyped;
};

/**
 * The persona's stored memory that speaks to a recall question, matched with
 * no request. Searched: the members' moments (`profiles[].episodes`: `what`
 * and `quote`, never `feeling`), the lorebook (`title`, `keys`, `text`), the
 * learned items (`text`) and the archive
 * (`archived`: entries scanArchive kept; see archivedItem) -- each list as the
 * caller passes it, already gated (the caller never passes a private layer
 * the turn may not read).
 * - A form of `forms` or `who` matches a text when it occurs in it as a word
 *   or phrase, word endings allowed, both folded (src/memory/recent.js#foldText:
 *   case, accents; src/memory/mentions.ts#occursAsWordStem: a form word of 5+
 *   letters matches by its stem, a shorter one or one with digits only whole).
 * - A `who` form equal (folded) to one of a profile's `names` or alias names
 *   picks that member: each of their moments, every item whose text holds
 *   their `<@id>` token and every archive entry
 *   scoped to them or naming them among its `participants` counts the person
 *   once.
 * - `score` = distinct forms matched + 1 when the item counts the person; an
 *   item of score 0 is left out.
 * - With `from` / `to` (epoch ms, either may be null) only dated items inside
 *   are kept: a moment by its `date` and an archive entry by the local day of
 *   its `observedAt`, both against the local days of the bounds in
 *   `timezone`; lore and learned items are undated
 *   and go.
 * - Hot and archived copies of one item are one hit: an archive entry whose
 *   `itemId` a matched hot item carries is left out, and of several archived
 *   revisions of one `itemId` only the newest recorded stays.
 * Ranked by score, then weight (a moment's or an entry's own; any other item
 * weighs 3, a moment's default), then the newer (a moment's date then
 * `addedAt`, lore's `updatedAt` or `createdAt`, a learned item's `lastSeen`, an
 * entry's `observedAt` then `recordedAt`), then input order. At
 * most `max` (RECALL_DEFAULTS.memoryItems when unusable, 0 for none). An item:
 * `kind` (`episode`, `lore`, `learned`, or `archived <itemKind>`),
 * `text` (a moment's `what`, with its `quote` in double quotes after it when
 * it has one; lore as `title: text`; an archive entry as archivedItem renders
 * it; the stored text otherwise; `<@id>` tokens kept), `date` (`YYYY-MM-DD`: a
 * moment's own or an entry's local day in `timezone`; null for lore
 * and learned), `accountId` (the moment's member, a learned item's teacher, an
 * entry's scoped member, else null), `itemId` (or null), `self`, `score`. Pure.
 */
export type MatchMemoryInput = {
  forms?: Array<string>;
  who?: Array<string>;
  profiles?: Array<Untyped>;
  lore?: Array<Untyped>;
  learned?: Array<Untyped>;
  archived?: Array<Untyped>;
  from?: number | null;
  to?: number | null;
  max?: number;
  timezone?: string;
};

export type MatchMemoryResult = {
  kind: string;
  text: string;
  date: string | null;
  accountId: string | null;
  itemId: string | null;
  self: boolean;
  score: number;
};

export type ScanArchiveArg2 = {
  forms?: Array<string>;
  who?: Array<string>;
  profiles?: Array<Untyped>;
  from?: number | null;
  to?: number | null;
  timezone?: string;
  allow?: (entry: Untyped) => boolean;
  max?: number;
  signal?: AbortSignal;
};

/**
 * The server search a direct question gets when the search classifier failed
 * (recall.fallbackOnClassifierFailure), and the words of a question the persona's
 * memory.search names (memorySearchPlan): built from the question's own words.
 * `who`: for each stored member (`profiles`, the persona's own `selfId` left
 * out) the first of their names or alias names that occurs in `text` as a
 * whole word (both folded, src/memory/recent.js#foldText), lowercased, each
 * once. `forms`: the words of `text` (runs of isWordChar) of 5 to 40
 * characters with at least one letter, lowercased, deduplicated (folded),
 * without the words of a name found or of the persona's `selfName`, longest
 * first (ties in text order). Each list holds at most `maxForms` (0 or not an
 * integer: none). No date range. Null when both lists are empty. Pure.
 */
export type FallbackLookupPlanInput = {
  text?: string;
  profiles?: Array<Record<string, Untyped>>;
  selfId?: string | null;
  selfName?: string;
  maxForms?: number;
};

export type MemorySearchPlanInput = {
  question?: string;
  people?: string;
  terms?: string;
  when?: string;
  placeId?: string | null;
  profiles?: Array<Untyped>;
  selfId?: string | null;
  selfName?: string;
  maxForms?: number;
  timezone?: string;
  now?: number;
};

export type RecallSettingsResult = {
  maxForms: number;
  maxClusters: number;
  windowMessages: number;
  followMessages: number;
  followGapMinutes: number;
  stretchChars: number;
  quoteWindowChars: number;
  quoteMaxChars: number;
  timeoutMs: number;
  memoryItems: number;
  traceMaxLines: number;
  recordContext: number;
  archiveMonths: number;
  meaningCandidates: number;
  db: Untyped;
  prefetch: PrefetchSettings;
};

export type MergeWindowsInput = {
  placeId: string;
  channelName?: string | null;
  messages: Array<Untyped>;
  hitIds: Iterable<string>;
  overlapsChat?: boolean;
};

export type FallbackLookupPlanResult = {
  forms: Array<string>;
  who: Array<string>;
  from: null;
  to: null;
};

export type MemorySearchPlanResult = {
  forms: Array<string>;
  who: Array<string>;
  from: number | null;
  to: number | null;
  placeId?: string;
};

/** The settings of the automatic memory prefetch (`recall.prefetch`), each checked against its default. */
export type PrefetchSettings = {
  deadlineMs: number;
  candidates: number;
  maxExcerpts: number;
  maxTokens: number;
  excerptChars: number;
  contextLines: number;
  contextTokens: number;
  shortWords: number;
  minFormsMatched: number;
  minMeaningScore: number;
  strongMeaningScore: number;
  singleTermScore: number;
  maxTermShare: number;
  maxPhraseDf: number;
  minPhraseShare: number;
  rareTermDf: number;
  trivial: Array<string>;
  deictic: Array<string>;
};
