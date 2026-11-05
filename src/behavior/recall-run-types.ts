// The types of the signatures in ./recall-run.ts: the inputs and results that are too long to read inline.

import type { ConversationRef } from '../protocol/adapter.ts';
import type { ResolvedRecallAnchor } from '../memory/db/recall.ts';
import type { Untyped } from '../tools/types.ts';
import type { recallSettings } from './recall.ts';
import type { Reads } from '../interface/reads.ts';
import type { Track } from '../loop-watch.ts';

/**
 * One stretch of a channel the recall found. `startTs` is the time of its first kept line. `lines` is the window
 * rendered without `#n` indices (captions included, matched lines marked), cut to `recall.stretchChars` by whole
 * lines from its far ends, never a matched one.
 */
export type RecallStretch = { placeId: string; channelName: string | null; startTs: number; lines: string };

export type EmptyStatsResult = {
  memory: number;
  archived: number;
  record: number;
  meaning: number;
  meaningMs: number;
  planned: number;
  queries: number;
  failed: number;
  hits: number;
  inChatDropped: number;
  kept: number;
  clusters: number;
  selfClusters: number;
  windows: number;
  summary: string | null;
  ms: number;
};

export type NewTraceInput = {
  started: Untyped;
  placeId: string;
  candidate: Untyped;
  server: Untyped;
};

export type CreateRecallInput = {
  /** Live config + prompts; read at the moment of use. */
  hot: { config: Untyped; prompts: Untyped };
  /** `state` (`data`, `markDirty`) and `listUserProfiles` (src/memory/store.js); read only, when present: `getLore`, `getPlace` (its `learned`), `getRecent`. Never `getPrivate`. */
  store: Untyped;
  /** From createLlm(): `complete`, `capLeft`. */
  llm: Untyped;
  /** The core's reads of the interface: the message and member searches and the history windows around a hit. */
  reads: Reads;
  /** The name the member directory holds for a member, the last resort for a person no stored profile names. */
  memberName?: (placeId: string, accountId: string) => string | null;
  /** From createDescriber (src/memory/describe.js): only its `cachedDescriptions` is used, never a fresh caption. */
  describer?: Untyped;
  /** From createArchive (src/memory/archive.js): only `iterate` is used (read only); without it the archive is not searched. */
  archive?: { iterate: (...args: Array<Untyped>) => Untyped } | null;
  /** From createRecord (src/memory/record.js): only `iterate` is used (read only); without it the record is not read. */
  record?: { iterate: (...args: Array<Untyped>) => Untyped } | null;
  /** From createVectors (src/memory/vectors.js): only `search` is used. Without it (or `deps.embed`) no run searches by meaning. */
  vectors?: { search: (...args: Array<Untyped>) => Untyped } | null;
  /** src/llm/embed.js's `embed`: one call per run that searches by meaning. */
  embed?: ((texts: Array<string>, opts: Untyped) => Promise<Array<Float32Array>>) | null;
  /** src/memory/db/service.js: the open memory database (the persona's own search, her window reads and the prefetch). */
  memoryDb?: { database: () => Untyped; issueContext?: (spec: Untyped) => Untyped } | null;
  /** The interface the persona's ids belong to (`hello.iface`); the legacy namespace without one. */
  iface?: string;
  now?: () => number;
  /** The event loop watch's `track` (src/loop-watch.ts); runs and prefetches are named operations. */
  track?: Track;
  /** setTimeout / clearTimeout (tests inject fakes). `prefetch`: the automatic memory prefetch of a turn of the tool loop (see there); `window`: a window read over the memory database. */
  timers?: { set: (...args: Array<Untyped>) => Untyped; clear: (...args: Array<Untyped>) => Untyped };
};

export type CreateRecallResult = {
  run: (args: RunInput) => Promise<{
    text: string | null;
    stretch: RecallStretch | null;
    people: Array<{ id: string; name: string; username: string; count: number; newestTs: number | null }>;
    stats: EmptyStatsResult;
  }>;
  available: () => boolean;
  prefetch: (args: Untyped) => Promise<PrefetchOutcome | null>;
  window: (args: WindowInput) => Promise<Record<string, unknown>>;
};

/**
 * The people the `who` forms point at, at most `maxPeople`: per form, the
 * stored profiles one of whose names or alias names equals the whole form
 * (both folded, src/memory/recent.js#foldText), the persona's own profile
 * never; then -- for a Latin form no profile matched -- the interface's member
 * search (prefix match), other bots left out. A member search is not sent
 * once `searchUntil` is past.
 * `via` (an optional Map) gets, per member found, `{ form, how }`: `how`
 * `stored` or `member-search`.
 */
export type FindPeopleInput = {
  placeId: string;
  who: Array<string>;
  maxPeople: Untyped;
  selfId: string | null;
  signal: AbortSignal;
  searchUntil: Untyped;
  via?: Untyped;
};

/**
 * The stored memory the forms point at (recall.js matchMemory), at most
 * `recall.memoryItems`, with the display names of the stored members, or
 * no item. Read-only store calls, no request. The gates are the reply
 * prompt's: nothing with `features.memory` off; members' moments with
 * `features.episodes` on, lore with `features.lore` on, learned items with
 * memory on (all three place-wide), recent lines by shownRecentLines. A
 * private layer is never read. A store read that throws gives no item.
 * The archive (`deps.archive`): the entries recorded since the start of
 * the `when:` range, else over the last `recall.archiveMonths` months (0:
 * none without a range), streamed through recall.js scanArchive with
 * `allowEntry` applied before matching; archived episodes, recent lines and
 * participation episodes under the same switches as their hot stores. On a
 * private turn the partner's own private archive is read too. An archive
 * read that throws logs `recall: archive failed` and costs only its items.
 * `recent` ranks as a vague "recently" (isRecentCue).
 * `meaning`: the archive rows the meaning search kept, best first
 * (`{ id, occurredAt }`): their entries are read from the archive (the
 * months from the earliest row's on, the private archive too on a private
 * turn; the newest recorded revision per itemId, through the same switches
 * and `allowEntry`) and join matchMemory's items as its `meaning`.
 * `locator` (locatorOf): no item is bounded by the range; the archive is
 * read over the last `recall.archiveMonths` months, or from the range's
 * start when that is earlier, and matchMemory ranks with the locator.
 * `source` (default `deps.archive`) is the archive read: the prefetch hands in one whose reads
 * its lanes share.
 */
export type StoredMemoryInput = {
  config: Untyped;
  settings: RecallSettings;
  snapshot: Untyped;
  placeId: string;
  channel: Untyped;
  partnerId: Untyped;
  server: Untyped;
  recent: Untyped;
  allowEntry: Untyped;
  privateAccountId: Untyped;
  signal: AbortSignal;
  meaning?: Array<Untyped>;
  locator?: Untyped;
  source?: Untyped;
};

/**
 * The record windows of every question (recall.js matchRecord): a dated
 * one reads its `when:` range, any other the last `recall.recordDays`
 * days (a dateless, not-recent one keeps the window of its earliest
 * match); none without `deps.record` or with `recall.recordDays` 0. The
 * topic forms are the server forms; the name forms (the `who:` forms and
 * the stored names and aliases of the people found) and the people's ids
 * only locate the person, ranking below a topic match. Read
 * through `allowLine` (the audience and private-owner rule) before
 * matching; on a private turn the partner's private record is read after
 * the place's. At most `recall.maxClusters` windows. A read that throws
 * logs `recall: record failed` and gives none. `meaning`: the record rows
 * the meaning search kept, best first, for matchRecord's `meaning` (read
 * and fused there; with `recall.recordDays` 0 they alone are read).
 * `locator` (locatorOf): read as a dateless question plus the locator's own
 * days, the windows kept by matchRecord's locator rule.
 */
export type RecordWindowsForInput = {
  settings: RecallSettings;
  snapshot: Untyped;
  placeId: string;
  server: Untyped;
  people: Untyped;
  recent: Untyped;
  allowLine: Untyped;
  privateAccountId: Untyped;
  ownIds: Untyped;
  selfName: string;
  signal: AbortSignal;
  conversationId: string;
  meaning?: Array<Untyped>;
  locator?: Untyped;
};

/**
 * The meaning search of a run, or null when it does not search by meaning
 * (`features.meaningSearch` not exactly true, no `deps.vectors` /
 * `deps.embed`, `recall.meaningCandidates` 0, or a message without text).
 * One embedding of meaningQuery (the asker's message `candidate`, with
 * `recall.meaningWithReply` the line it replies to among `lines` before it),
 * then `vectors.search` within `server.from/to` (every month without a
 * range or with a `locator`), `recall.meaningCandidates` rows: the place index, rows of a
 * channel `sourceOf` refuses or of the visible chat (`ownIds`) left out (an
 * archive row is judged by its entry later); on a private turn the
 * partner's private layer too. The rows deduplicated (dedupeRows), split
 * into `record` (`{ id, placeId, occurredAt, sourceIds }`) and `archive`
 * (`{ id, occurredAt }`), best first. `trace` is the run's trace entry
 * (see traceLine). A failed embedding or search logs `recall: meaning
 * failed` (`stage` `embed` | `search`, counts and codes only) and gives no
 * row.
 */
export type MeaningSearchInput = {
  config: Untyped;
  settings: RecallSettings;
  placeId: string;
  channel: Untyped;
  candidate: Untyped;
  lines: Untyped;
  server: Untyped;
  privateAccountId: Untyped;
  sourceOf: Untyped;
  ownIds: Untyped;
  signal: AbortSignal;
  locator?: Untyped;
};

export type WriteTraceInput = {
  placeId: string | null;
  trace: RecallTrace;
  out: Untyped;
  maxLines: Untyped;
};

export type ScopeOfInput = {
  config: Untyped;
  snapshot: Untyped;
  channel: Untyped;
  partnerId: Untyped;
  placeId?: string | null;
};

/**
 * What a db read needs of a turn: the read context, the pull rail for places, the names. `asker` is the user id of
 * the person who asked (the trigger's author): the context carries their person id, and the hidden-DM marker is set
 * only for a private chat of that person. `model` is the embedding model the question's vector comes from.
 * The context is the turn's own (`memoryContext`: the one context the turn runner issued for the turn, taken when it
 * is the context this read would be issued, a DM of the same partner or a group read) or, without one, issued by the
 * core (memoryDb.issueContext records it; without the service it is the pure object): it has an id, names the DM
 * place of a private chat, and reads through `audience_id` when `memoryDb.audienceColumn`.
 * `allowPlace` requires a stored place row. The execution context filters source audiences independently
 * of the interface's live channel permissions.
 */
export type DbReaderInput = {
  db?: Untyped;
  config: Untyped;
  snapshot: Untyped;
  placeId: string | null;
  channel: Untyped;
  partnerId: Untyped;
  asker?: Untyped;
  memoryContext?: Untyped;
};

export type ReadContextInput = {
  config?: Untyped;
  channel: Untyped;
  privateAccountId: Untyped;
  asker: Untyped;
  memoryContext?: Untyped;
};

export type DbQuotesInput = {
  config: Untyped;
  settings: RecallSettings;
  placeId: string | null;
  selfName: string;
  windows: Untyped;
  decorate: Untyped;
};

export type RunDbQuotesInput = {
  historyRef?: ConversationRef;
  db: Untyped;
  config: Untyped;
  settings: RecallSettings;
  snapshot: Untyped;
  placeId: string | null;
  channel: Untyped;
  partnerId: Untyped;
  selfName: string;
  history: Untyped;
  candidate: Untyped;
  server: Untyped;
  decorate: Untyped;
  started: Untyped;
  memoryContext?: Untyped;
};

export type WindowInput = {
  historyRef?: ConversationRef;
  placeId?: string | null;
  snapshot?: Untyped;
  channel: Untyped;
  partnerId?: string | null;
  selfName?: string;
  history?: Array<Untyped>;
  anchor?: string;
  resolvedAnchor?: ResolvedRecallAnchor;
  move?: string;
  messages?: number | null;
  minutes?: number | null;
  decorate?: Untyped;
  asker?: string | null;
  memoryContext?: Untyped;
};

export type RecallWithInput = {
  config: Untyped;
  settings: RecallSettings;
  prompt: string;
  snapshot: Untyped;
  placeId: string;
  channel: Untyped;
  partnerId: Untyped;
  selfId: string | null;
  selfName: string;
  history: Untyped;
  context: Untyped;
  contextDescriptions: Untyped;
  candidate: Untyped;
  server: Untyped;
  signal: AbortSignal;
  searchSignal: AbortSignal;
  progress: Untyped;
  started: Untyped;
  stats: EmptyStatsResult;
  trace: RecallTrace;
  decorate?: Untyped;
  memoryContext?: Untyped;
};

/**
 * One server search for a turn. Per call, with `hot.config` / `hot.prompts`
 * read at that moment: nothing (no log) with `features.recall` off; `recall:
 * skipped` with `reason` `private-chat` (no place, or a channel without a
 * place and no `partner`: a private chat searches only on behalf of its
 * partner, the member of `place` it talks to, keeping the
 * hits of channels that member can view and not bounded by its own chat),
 * `no-query` (no form, name form or range), `no-prompt` (no
 * `prompts['recall-summary']`) or `daily-cap` (`llm.capLeft()` spent), each before any request; later
 * `no-query` (nothing to search: no query planned) or `no-hits`
 * (nothing left to read), either only when no stored memory matched
 * either (storedMemory; `stats.memory` its items, `stats.archived` those
 * from the archive, also on `recall: searched`) and the record gave no
 * window (recordWindowsFor; `stats.record` the record windows that joined
 * the search's, also on `recall: searched`): matched memory or a record
 * window alone still asks the summary. `stats.meaning` the rows the meaning
 * search kept and `stats.meaningMs` its time (both 0 without it, also on
 * `recall: searched`, beside `memoryMs`, `recordMs` and `searchMs`, the time of
 * the stored-memory match, the record match and the message searches; `recall:
 * summary` carries `totalMs`, the run's time so far). Never rejects: a failure logs `recall:
 * failed` (`reason`: the rail code of a failed summary request, `timeout`
 * when `recall.timeoutMs` ran out -- the run is abandoned, its requests
 * aborted -- or `error`). Once the windows are read the result is never
 * lost: when the summary request fails, times out (its own limit or the
 * run's) or is skipped (less than `recall.minSummaryMs` left), the run
 * resolves `text` null with `stretch` the first-ranked window
 * (fallbackWindow), `stats.summary` `failed` | `timeout` | `skipped`, and
 * logs `recall: summary` with `answer: 'fallback'`; an answered summary
 * sets `stats.summary` `answered`. Resolves `text` null when nothing was
 * found or the analyzer answered `nothing` (and when the summary of a run
 * on stored memory alone gives no answer); `stretch` is the window the
 * analyzer named, else null; `people` the members the name forms found,
 * with how many of their messages were kept and the newest one's time.
 * `history` is the turn's own chat (the window and the reply parents it
 * fetched): its ids are left out of the hits (`stats.inChatDropped`) and
 * mark a window that reaches into it. `context` (default `history`) is
 * where the summary's `<context>` lines come from: the last
 * `recall.contextMessages` before `candidate`, with `contextDescriptions`
 * as their captions. With `features.recallTrace` true every run with
 * `features.recall` on appends its trace record (store.appendRecallTrace;
 * see traceLine), one skipped by a gate above included, with the reason in
 * `skipped`; a private chat without a place has nowhere to write it. `op` (optional, a journal operation: src/memory/journal.js#op,
 * as the turn hands it) is started once the gates above passed, before the
 * first request, and closed with the run: `succeeded` with `status` (`ok`,
 * or `timeout` when the run ran out yet left its fallback stretch), `hits`
 * (the search hits), `kept`, `summaryChars` and `stretch` (whether a
 * stretch is returned); `failed` with `timeout` (nothing left) or `error`.
 * `quotes` (the persona's own memory.search, src/tools/tools.ts): the memory database's search
 * (runDbQuotes): no summary is asked and the prompt is not needed; the run resolves `quotes`, the
 * stretches in rank order, with `text` and `stretch` null, and logs `recall: quoted`; while the
 * database is not open its `outcome` is `not-configured`.
 * The result's `outcome` (optional) says what a run that found nothing did not do: `{ kind }`
 * `daily-cap` (the daily request cap spent: `llm.capLeft()`), `timeout`
 * (`recall.timeoutMs` ran out, no fallback), `error` (a throw) or, with `quotes`, `not-configured`,
 * `not-visible` (the `server.placeId` named is hidden by the pull rail) and `searched` (`degraded`, `failed`, `total`).
 * `decorate` (optional; the turn's call marks, src/behavior/turn.ts#linkCalls) takes each
 * window's messages once they are read and gives the ones rendered, so the persona's lines
 * there show what she called like her chat lines do. `memoryContext` (optional) is the turn's
 * execution context (src/memory/db/service.js#issueContext): the database reads use it when it
 * fits the read (see dbReader), so the reads of one turn carry one context id.
 */
export type RunInput = {
  historyRef?: ConversationRef;
  placeId?: string | null;
  snapshot?: Untyped;
  channel: Untyped;
  partnerId?: string | null;
  selfId: string | null;
  selfName: string;
  history?: Array<Untyped>;
  context?: Untyped;
  contextDescriptions?: Untyped;
  candidate?: Untyped;
  server?: Untyped;
  op?: Untyped;
  decorate?: Untyped;
  quotes?: boolean;
  memoryContext?: Untyped;
};

/**
 * The automatic memory prefetch of a turn (src/behavior/prefetch.ts, decided by the caller): no model request but one embedding, no
 * message search, no daily recall run counted. Each lane (`lanes`, prefetchLanes') goes through
 * the local searches, all at once:
 * - the memory database (src/memory/db/recall.js#search, while it is open): words, letters,
 *   meaning (features.meaningSearch exactly true and the embedding client given: one embedding
 *   request for every lane's text, purpose `recall-query`) and people fused, the stretches built
 *   around the hits, `ceil(recall.prefetch.candidates / 4)` of them; a word hit is relevant by
 *   lexicalKeep, a meaning hit when its line has MEANING_MIN_WORDS words or more and either a cosine
 *   of at least `recall.prefetch.strongMeaningScore` or a term of the lane's question;
 * - the stored memory and the archive, searched with the lane's forms (lanePlan; storedMemory,
 *   the recent lines left out: `<recent>` shows them).
 * The scope rules are a run's (scopeOf): a refused channel's lines, items and rows, a private
 * line of another member, and the turn's own chat (`history`'s ids, on a server turn) never
 * reach the result. The archive is read once for all lanes (sharedSource).
 * Bounded by `recall.prefetch.deadlineMs`: what has not settled then is abandoned, what has
 * stands. The relevant hits are fused and cut by rankPrefetch and fitExcerpts
 * (`recall.prefetch.maxExcerpts`, `recall.prefetch.maxTokens`); each window rendered as a
 * stretch (no indices, its best hit and the hits within FOCUS_LINES lines of it marked
 * (focusHits), cut to `recall.prefetch.excerptChars` by whole lines from its far ends, cached
 * captions only, `decorate` applied to its messages). `at` (a replay's moment, epoch ms) bounds
 * every source to what existed then (an archive entry recorded after it left out); live it is
 * now. `stats.stages`: the milliseconds of each stage that ran (embed, record, memory).
 * Resolves null for no lane or with features.recall off; else `{ status, basis, excerpts, ms,
 * stats }`: `status` `ok` (an excerpt), `none` (searched, nothing relevant), `timeout` (the
 * deadline passed before anything relevant settled) or `unavailable` (no place to read on behalf
 * of, or every search failed); `basis` the lane kinds; each excerpt `{ source: 'history',
 * placeId, channelName, startTs, endTs, id, ids, hitIds, lines }` or `{ source: 'memory', kind,
 * date, accountId, who, id, lines }`; `partial` true when the deadline cut some searches. Logs
 * `recall: prefetched` (counts and codes only). Never rejects.
 */
export type PrefetchInput = {
  historyRef?: ConversationRef;
  place?: Untyped;
  placeId?: string | null;
  snapshot?: Untyped;
  channel: Untyped;
  partner?: Untyped;
  partnerId?: string | null;
  asker?: string | null;
  memoryContext?: Untyped;
  selfId: string;
  selfName: string;
  history?: Array<Untyped>;
  lanes?: Array<{ kind: string; text: string; words: string }>;
  at?: number | null;
  decorate?: ((messages: Array<Untyped>) => Array<Untyped>) | null;
};

/** What a prefetch answers: its status and the lane kinds, the excerpts kept, the time it took and how it went. */
export type PrefetchOutcome = {
  status: Untyped;
  basis: Array<string>;
  excerpts: Array<Untyped>;
  ms: number;
  stats?: {
    candidates?: number;
    searches?: number;
    failed?: number;
    meaning?: number;
    stages?: Record<string, number>;
  };
  partial?: boolean;
  reason?: string;
};

/** The settings of a recall run (`recall.*` of the live config, read once per run). */
export type RecallSettings = NonNullable<ReturnType<typeof recallSettings>>;

/** The trace record of one run: newTrace makes it, the run fills it and traceLine completes it. */
/** How a dated question's range reads in the trace: the locator's own, or the scope of an ordinary search. */
type TraceWhenRole = 'locator' | 'scope';

export type RecallTrace = {
  at: string | null;
  placeId: string | null;
  triggerId: string | null;
  forms: Array<string>;
  who: Array<string>;
  when: { from: string | null; to: string | null; role: TraceWhenRole } | null;
  clusters: Array<Untyped>;
  summary: { answer: string | null; stretch: number | null; text: string | null; note: string | null };
  skipped: string | null;
  people: Array<Untyped>;
  plan: Array<Untyped>;
  memory: Array<Untyped>;
  record: Array<Untyped>;
  meaning: { query: Untyped; candidates: number; kept: Array<Untyped>; ms: number } | null;
};

/** One entry of the archive: the item it kept (`itemId`, its kind) and when it was recorded. */
export type ArchiveEntry = { itemId: string; itemKind: string; recordedAt?: string; [key: string]: Untyped };
