// The types of the signatures in ./recall.ts: the inputs and results that are too long to read inline.

import type { Untyped } from '../tools/types.ts';

export type LocatorKeepArg2<TItem> = {
  keep?: number;
  broadShare?: number;
  broadOrder: (a: TItem, b: TItem) => number;
  datedOrder: (a: TItem, b: TItem) => number;
};

export type MeaningQueryInput = {
  candidate?: { content?: string; replyToId?: string | null } | null;
  lines?: Array<Untyped>;
  withReply?: boolean;
  nameOf?: ((id: string) => string | null | undefined) | null;
};

/**
 * The ordered search queries of one server search, newest first each:
 * - content queries: the `forms` and the `who` forms taken round-robin
 *   (form 1, name 1, form 2, name 2, ...), de-duplicated, at most `maxForms`;
 *   each `kind: 'form'` when it is one of `forms` (the topic), else
 *   `kind: 'who'` (a name form: it locates the person, not the topic);
 * - one author query per id of `accountIds`;
 * - with none of those and a range: one query over the range alone
 *   (`kind: 'range'`), which the runner samples (sampleOffsets).
 * The range: `after` from `from`, `before` the instant past `to` (so `to` is inclusive), both in ms. The
 * queries span the whole server, so the turn's own chat bounds nothing here:
 * its lines are dropped from the hits by id (dropChatHits). An empty list
 * when nothing is asked, or when the range ends before it starts.
 */
export type SearchPlanInput = {
  forms?: Array<string>;
  who?: Array<string>;
  accountIds?: Array<string>;
  from?: number | null;
  to?: number | null;
  maxForms?: number;
};

export type SearchPlanResult = {
  kind: 'form' | 'who' | 'author' | 'range';
  content?: string;
  authorId?: string;
  after: number | null;
  before: number | null;
};

export type ClusterHitsArg2 = {
  gapMinutes?: number;
  maxClusters?: number;
  keepOldest?: number;
  rareForms?: Iterable<string>;
  locator?: Untyped;
};

export type ClusterHitsResult = {
  placeId: string;
  ids: Array<string>;
  startTs: number;
  endTs: number;
  middleId: string;
  queries: number;
  forms: number;
  topic: number;
  share?: 'broad' | 'dated';
};

export type RankClustersInput = {
  placeId: string;
  startTs?: number;
  endTs: number;
  topic: number;
  queries: number;
  self?: boolean;
};

export type MergeWindowsResult = {
  placeId: string;
  channelName: string | null;
  messages: Array<Untyped>;
  hitIds: Set<string>;
  overlapsChat: boolean;
  source?: 'record';
  descriptions?: Map<string, string>;
};

/** A window of the record as `matchRecord` returns it; a locator run adds the `share` its slot was kept under. */
export type RecordWindow = MergeWindowsResult & { share?: string };

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
  anyway?: boolean;
};

/**
 * The persona's stored memory that speaks to a recall question, matched with
 * no request. Searched: the members' moments (`profiles[].episodes`: `what`
 * and `quote`, never `feeling`), the lorebook (`title`, `keys`, `text`), the
 * learned items (`text`), the recent lines (`text`) and the archive
 * (`archived`: entries scanArchive kept; see archivedItem) -- each list as the
 * caller passes it, already gated (the caller never passes a private layer
 * the turn may not read).
 * - A form of `forms` or `who` matches a text when it occurs in it as a word
 *   or phrase, word endings allowed, both folded (src/memory/recent.js#foldText:
 *   case, accents; src/memory/mentions.ts#occursAsWordStem: a form word of 5+
 *   letters matches by its stem, a shorter one or one with digits only whole).
 * - A `who` form equal (folded) to one of a profile's `names` or alias names
 *   picks that member: each of their moments, every item whose text holds
 *   their `<@id>` token (a recent line's `who` too) and every archive entry
 *   scoped to them or naming them among its `participants` counts the person
 *   once.
 * - `score` = distinct forms matched + 1 when the item counts the person; an
 *   item of score 0 is left out.
 * - With `from` / `to` (epoch ms, either may be null) only dated items inside
 *   are kept: a moment by its `date` and an archive entry by the local day of
 *   its `observedAt`, both against the local days of the bounds in
 *   `timezone`, a recent line by its `at`; lore and learned items are undated
 *   and go.
 * - Hot and archived copies of one item are one hit: an archive entry whose
 *   `itemId` a matched hot item carries is left out, and of several archived
 *   revisions of one `itemId` only the newest recorded stays.
 * Ranked by score, then weight (a moment's or an entry's own; any other item
 * weighs 3, a moment's default), then the newer (a moment's date then
 * `addedAt`, lore's `updatedAt` or `createdAt`, a learned item's `lastSeen`, a
 * line's `at`, an entry's `observedAt` then `recordedAt`), then input order;
 * with `recent` (a vague "recently", isRecentCue) the items holding the
 * persona's own lines come first, then the newer, then score and weight. At
 * most `max` (RECALL_DEFAULTS.memoryItems when unusable, 0 for none). An item:
 * `kind` (`episode`, `lore`, `learned`, `recent`, or `archived <itemKind>`),
 * `text` (a moment's `what`, with its `quote` in double quotes after it when
 * it has one; lore as `title: text`; an archive entry as archivedItem renders
 * it; the stored text otherwise; `<@id>` tokens kept), `date` (`YYYY-MM-DD`: a
 * moment's own, a line's or an entry's local day in `timezone`; null for lore
 * and learned), `accountId` (the moment's member, a learned item's teacher, an
 * entry's scoped member, else null), `itemId` (or null), `self`, `score`. Pure.
 * `meaning`: archive entries the meaning search found, best first (already
 * allowed, one per itemId; no form needed): each joins as the item of its
 * `itemId` among those matched (hot or archived), else as its own archived
 * item (score 0 allowed, the range still applied), and the whole list is
 * then ordered by fuseRanks over (meaning rank, the order above) before the
 * `max` cut; without it the order above stands.
 * `locator` (a `when:` that only locates, `{ from, to, bonus, decayDays,
 * broadShare }`; the caller then passes no `from` / `to`): the `max` slots
 * are locatorKeep's -- the reserved share in the order above, the rest by
 * the score (or the fused one) + proximityBonus of the item's local day, in
 * the unit of that score (one form, or 1 / (RRF_K + 1) fused); an undated
 * item gets no bonus. Returned in pick order, each with `share` (`broad` |
 * `dated`); without a locator there is no `share` key.
 */
export type MatchMemoryInput = {
  forms?: Array<string>;
  who?: Array<string>;
  profiles?: Array<Untyped>;
  lore?: Array<Untyped>;
  learned?: Array<Untyped>;
  recentLines?: Array<Untyped>;
  archived?: Array<Untyped>;
  meaning?: Array<Untyped>;
  from?: number | null;
  to?: number | null;
  max?: number;
  timezone?: string;
  recent?: boolean;
  locator?: Untyped;
};

export type MatchMemoryResult = {
  kind: string;
  text: string;
  date: string | null;
  accountId: string | null;
  itemId: string | null;
  self: boolean;
  score: number;
  share?: 'broad' | 'dated';
};

export type ScanArchiveArg2 = {
  forms?: Array<string>;
  who?: Array<string>;
  profiles?: Array<Untyped>;
  from?: number | null;
  to?: number | null;
  timezone?: string;
  recent?: boolean;
  allow?: (entry: Untyped) => boolean;
  max?: number;
  signal?: AbortSignal;
};

/**
 * The summary request: the system message is `prompt` with
 * `{{name}}` (the persona's display name), `{{answerChars}}` and, given
 * `now`, `{{today}}` (the local date key in `timezone`) filled; the user
 * message holds `<people>` (one line per found member, see personLine; left
 * out when none), `<memory>` (one line per item of `memory`, matchMemory's
 * order, as memoryLine renders it: `kind | date | name | text`, in order
 * until the next line would pass `memoryTokens` (the src/llm/tokens.js
 * estimate of each line; no cap when it is not a number of at least 0);
 * left out when none fits), `<found>` (one section per window, numbered from
 * 1 in the order given: a header `## n | YYYY-MM-DD | #channel` with the
 * local date of its first line, ` | source: record` after the channel for a
 * window read from the record (`source: 'record'`, matchRecord), then its
 * lines, renderRecallWindows with indices; left
 * out when no window has a line), `<context>` (the chat lines before the
 * question, recallContext's choice made by the caller, rendered as the
 * classifier transcripts are -- src/format.ts formatTranscript and
 * renderTranscript, the persona's own lines under `labels.self`, the
 * `contextDescriptions` captions -- with their `#n` indices continuing after
 * the last `<found>` line; left out when there is no line), `<time_cue>`
 * (with a `timeCue` -- the asker's `when:` locator, `{ from, to }` -- the
 * label `labels.lookup.timeEstimate` with `{range}` its local days, see
 * timeCueText; left out without a cue or the label) and `<question>`
 * (the candidate's author and text cut to `maxChars`). Every block is
 * per-call content after the system message, in that order (stable first,
 * per-turn last; nothing is marked for the prompt cache). A section header
 * gets ` ` + `labels.lookup.stretchSelf` (trimmed) when its window holds a
 * line of the persona (`self`), then ` ` + `labels.lookup.stretchCurrent`
 * (trimmed) when the window overlaps the turn's chat (`overlapsChat`); a
 * missing or blank label adds nothing. Null when the prompt is blank, or when no window has a line and
 * no memory line fits.
 */
export type BuildRecallRequestInput = {
  prompt: string | null | undefined;
  selfName: string;
  question: { authorName?: string; content?: string };
  people?: Array<{ name: string; username?: string; count?: number; newestTs?: number | null }>;
  windows: Array<Untyped>;
  memory?: Array<{ kind: string; text: string; date: string | null; accountId: string | null }>;
  context?: Array<Untyped>;
  contextDescriptions?: Map<string, string>;
  replyQuoteChars?: number;
  nameOf?: (id: string) => string | null | undefined;
  labels: Untyped;
  timezone?: string;
  answerChars: number;
  now?: number;
  maxChars?: number;
  gapMinutes?: number;
  seeReactions?: boolean;
  reactionsPerMessage?: number;
  memoryTokens?: number;
  timeCue?: { from?: number | null; to?: number | null } | null;
};

export type MatchRecordArg2 = {
  record?: { iterate: (...args: Array<Untyped>) => Untyped };
  range?: { from?: number | null; to?: number | null };
  participants?: Array<string>;
  forms?: Array<string>;
  aliases?: Array<string>;
  recordDays?: number;
  recordContext?: number;
  followMessages?: number;
  followGapMinutes?: number;
  now?: number;
  maxWindows?: number;
  allowLine?: (line: Untyped) => boolean;
  exclude?: Set<string> | Array<string>;
  recent?: boolean;
  nameOf?: (id: string) => string | null | undefined;
  selfName?: string;
  channelNameOf?: (id: string) => string | null | undefined;
  meaning?: Array<{ id: string; placeId: string; occurredAt: string; sourceIds?: Array<string> }>;
  locator?: Untyped;
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
  maxPeople: number;
  dateSamples: number;
  clusterGapMinutes: number;
  maxClusters: number;
  keepOldest: number;
  rareHits: number;
  windowMessages: number;
  followMessages: number;
  followGapMinutes: number;
  answerChars: number;
  stretchChars: number;
  quoteWindowChars: number;
  quoteMaxChars: number;
  timeoutMs: number;
  minSummaryMs: number;
  maxOutputTokens: number;
  memoryItems: number;
  selfBonus: number;
  selfExtra: number;
  contextMessages: number;
  traceMaxLines: number;
  memoryTokens: number;
  recordDays: number;
  recordContext: number;
  archiveMonths: number;
  meaningCandidates: number;
  locatorBonus: number;
  locatorDecayDays: number;
  locatorBroadShare: number;
  db: Untyped;
  prefetch: PrefetchSettings;
};

export type MergeWindowsInput = {
  placeId: string;
  channelName?: string | null;
  messages: Array<Untyped>;
  hitIds: Iterable<string>;
  overlapsChat?: boolean;
  source?: 'record';
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
