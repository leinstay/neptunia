// The types of the signatures in ./recall-run.ts: the inputs and results that are too long to read inline.

import type { MediaName } from '../memory/store-media-names.ts';
import type { RetrievalInput } from '../memory/retrieval-input.ts';
import type { ChatRef } from '../protocol/adapter.ts';
import type { ResolvedRecallAnchor } from '../memory/db/recall.ts';
import type { Untyped } from '../tools/types.ts';
import type { recallSettings } from './recall.ts';
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
  /** The store's read of a stable name (src/memory/store-media-names.ts), for the legend of a stretch. */
  mediaNameOf: (name: string) => MediaName | null;
  /** From createLlm(): only `capLeft` is used, for the daily request cap. */
  llm: Untyped;
  /** The name the member directory holds for a member, the last resort for a person no stored profile names. */
  memberName?: (placeId: string, accountId: string) => string | null;
  /** From createDescriber (src/memory/describe.js): only its `cachedDescriptions` is used, never a fresh caption. */
  describer?: Untyped;
  /** From createArchive (src/memory/archive.js): only `iterate` is used (read only); without it the archive is not searched. */
  archive?: { iterate: (...args: Array<Untyped>) => Untyped } | null;
  /** src/llm/embed.js's `embed`: one call per search or prefetch that searches by meaning. */
  embed?: ((texts: Array<string>, opts: Untyped) => Promise<Array<Float32Array>>) | null;
  /** src/memory/db/service.js: the open memory database (the persona's own search, their window reads and the prefetch). */
  memoryDb?: {
    database: () => Untyped;
    issueContext?: (spec: Untyped) => Untyped;
    /** Off the main thread (src/memory/db/service.ts); a fake without it searches synchronously. */
    searchRecord?: (input: Untyped, options: { signal: AbortSignal }) => Promise<Untyped>;
  } | null;
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
 * The stored memory the forms point at (recall.js matchMemory), at most
 * `recall.memoryItems`, or no item. Read-only store calls, no request. The gates are the reply
 * prompt's: nothing with `features.memory` off; members' moments with
 * `features.episodes` on, lore with `features.lore` on, learned items with
 * memory on (all three place-wide). A
 * private layer is never read. A store read that throws gives no item.
 * The archive (`deps.archive`): the entries recorded since the start of
 * the `when:` range, else over the last `recall.archiveMonths` months (0:
 * none without a range), streamed through recall.js scanArchive with
 * `allowEntry` applied before matching; archived episodes, recent lines and
 * participation episodes under the same switches as their hot stores. On a
 * private turn the partner's own private archive is read too. An archive
 * read that throws logs `recall: archive failed` and costs only its items.
 * `source` (default `deps.archive`) is the archive read: the prefetch hands in one whose reads
 * its lanes share.
 */
export type StoredMemoryInput = {
  config: Untyped;
  settings: RecallSettings;
  placeId: string;
  channel: Untyped;
  server: Untyped;
  allowEntry: Untyped;
  privateAccountId: Untyped;
  /** The direct chat places whose archive `context.memory.openPrivate` opens to this run; none when it is off. */
  privatePlaces?: ReadonlyArray<string>;
  signal: AbortSignal;
  source?: Untyped;
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
  db: unknown;
  ctx: unknown;
  config: Untyped;
  settings: RecallSettings;
  placeId: string | null;
  selfName: string;
  windows: Untyped;
  decorate: Untyped;
};

export type RunDbQuotesInput = {
  historyRef?: ChatRef;
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
  terms?: string;
  server: Untyped;
  decorate: Untyped;
  started: Untyped;
  memoryContext?: Untyped;
  retrieval?: Untyped;
  lines?: number;
};

export type WindowInput = {
  historyRef?: ChatRef;
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

/**
 * The persona's own search (memory.search and the `find` of conversation.read, src/tools/tools.ts) over the memory
 * database (runDbQuotes). Per call, with `hot.config` read at that moment: nothing (no log) with `features.recall`
 * off; `recall: skipped` with `reason` `private-chat` (a private chat without its partner and outside an issued
 * memory context), `no-query` (no form, name form, range, place or fact entity) or `daily-cap` (`llm.capLeft()`
 * spent), each before any request. The run resolves `quotes`, the stretches in rank order, with `text` and `stretch`
 * null, and logs `recall: quoted`. Never rejects: a failure logs `recall: failed` (`reason` `timeout` when
 * `recall.timeoutMs` ran out, or `error`).
 * The result's `outcome` (optional) says what a run that found nothing did not do: `{ kind }` `daily-cap`,
 * `timeout`, `error`, `not-configured` (the memory database is not open), `not-visible` (the `server.placeId` named
 * is hidden by the pull rail) or `searched` (`degraded`, `failed`, `total`).
 * `history` is the turn's own chat: its ids are left out of the stretches. With `features.recallTrace` true every run
 * with `features.recall` on appends its trace record (store.appendRecallTrace; see traceLine), one skipped by a gate
 * above included, with the reason in `skipped`. `op` (optional, a journal operation: src/memory/journal.js#op, as the
 * turn hands it) is started once the gates above passed and closed with the run: `succeeded` with `status` `ok`,
 * `hits`, `kept`, `summaryChars` and `stretch`; `failed` with `not-configured`, `timeout` or `error`.
 * `decorate` (optional; the turn's call marks, src/behavior/turn.ts#linkCalls) takes each
 * window's messages once they are read and gives the ones rendered, so the persona's lines
 * there show what they called like their chat lines do. `memoryContext` (optional) is the turn's
 * execution context (src/memory/db/service.js#issueContext): the database reads use it when it
 * fits the read (see dbReader), so the reads of one turn carry one context id.
 */
export type RunInput = {
  historyRef?: ChatRef;
  placeId?: string | null;
  snapshot?: Untyped;
  channel: Untyped;
  partnerId?: string | null;
  selfName: string;
  history?: Array<Untyped>;
  candidate?: Untyped;
  /** The persona's `terms`: embedded for the meaning search when they gave no question. */
  terms?: string;
  server?: Untyped;
  op?: Untyped;
  decorate?: Untyped;
  memoryContext?: Untyped;
  /** The persona's filters of the stored facts: `entity`, `predicate`, `asOf`, `historical`. */
  retrieval?: Untyped;
  /** How many of the best close hits come back as `lines`, one message each (`find`). */
  lines?: number;
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
 * - the stored memory and the archive, searched with the lane's forms (lanePlan; storedMemory).
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
  historyRef?: ChatRef;
  place?: Untyped;
  placeId?: string | null;
  snapshot?: Untyped;
  channel: Untyped;
  partner?: Untyped;
  partnerId?: string | null;
  asker?: string | null;
  /** What a wake reads memory for instead of the turn's own query (an attention's purpose, people and place). */
  retrieval?: RetrievalInput | null;
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
