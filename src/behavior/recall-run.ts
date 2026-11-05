// health: allow file-length until 2027-02-01 -- the place rename widened lines the formatter wraps; split in the slice after the cutover
// The recall runner: the server part of a lookup. When the lookup classifier
// names word forms, name forms or a date range (src/behavior/recall.ts
// parseLookupAnswer), this module searches the server's own history through
// the interface's message search (reads.searchMessages) and has one analyzer request
// (prompts/recall-summary.md) say what that history answers, optionally
// singling out one stretch the persona gets verbatim. Steps: the people the
// name forms point at (stored profiles, the interface's member search for a Latin
// form), the queries one after another (the interface may serialise its search
// route, so sending them together would only queue them there), the hits filtered
// (other bots, conversations the pull rail refuses for this destination, the
// turn's own chat), clustered, the windows around the clusters read
// together (one history read each), each followed past its last
// line while its conversation goes on (one more history read, cut by
// recall.js followConversation: `recall.followMessages` lines at most, up to
// the first silence longer than `recall.followGapMinutes`), captioned from
// the media cache only, then the summary. Rails: `features.recall`, server turns and
// private chats run on behalf of their partner (the pull rail then keeps what
// the partner can view), the daily request cap (`llm.capLeft`) and `recall.timeoutMs` for the
// whole run, after which it is abandoned. Inside that budget: no search is
// sent once half of it is gone, a search still out at 60 % is cut (what the
// earlier ones found is kept), and the summary is asked only when at least
// `recall.minSummaryMs` is left. A summary that fails, times out or is
// skipped never costs the result: the verbatim stretch of the first-ranked
// window (recall.js fallbackWindow) is returned without a text.
// Before any search request the same forms are matched against the
// persona's stored memory (recall.js matchMemory; read-only store calls, no
// request), under the gates the reply prompt applies to each store, and the
// items go to the summary as `<memory>`: they alone are enough to ask it,
// but they are notes, not chat, so they are never returned verbatim. The
// archive (src/memory/archive.js) is a fifth source of those items, streamed
// over the months asked (recall.js scanArchive); the record
// (src/memory/record.js) of the last days is read for a dated or "recently"
// question (recall.js matchRecord) and its windows join the search's. Before any
// archive entry or record line is matched, the audience rule of the turn's
// channel refuses what the pull rail would (by the entry's `scope.channel`,
// the line's channel), and a private entry or line passes only on a private
// turn with its own member.
// With `features.meaningSearch` exactly true (and `deps.vectors` / `deps.embed`
// given) a run also searches by meaning: one embedding request of the asker's
// message (recall.js meaningQuery; purpose `recall-query`), then the vector
// index (src/memory/vectors.js search: the place's, on a private turn the
// partner's private layer and the place's) within the asked range, else every
// month, `recall.meaningCandidates` rows, the same audience rule applied to
// each row and the visible chat's ids left out. Record rows join the record
// windows and archive rows the stored-memory items, each fused with the word
// hits by reciprocal rank (recall.js fuseRanks). A failed embedding or search
// logs `recall: meaning failed` and the run goes on with words only.
// A `when:` range the lookup marked a locator (recall.js parseLookupAnswer:
// `locator: true`, a date that only helps find the event) bounds none of the
// local sources: the record is read over its last `recall.recordDays` days
// (and the locator's own days), the archive over its usual months, the
// vector index over every month; their windows and items, and the search
// clusters, are kept by recall.js locatorKeep (`recall.locatorBroadShare` of
// the slots by content alone, the rest with `recall.locatorBonus` falling
// over `recall.locatorDecayDays`). The search covers the range as before,
// plus one broad page of the first query over the past the record does not
// hold, unless the record covers the range and its decay margin. The summary
// reads the cue as an estimate (`<time_cue>`).
// The persona's own search (`quotes`), its window reads (`window`) and the memory prefetch read the memory database
// (src/memory/db/recall.js): the stretches scope-checked by the read context. While the database is not open they find
// nothing (`not-configured`, or a prefetch of the stored memory alone). The server part of a turn's lookup (a run
// without `quotes`) searches the server's history and asks the summary, as above.
// Logs carry counts, ids and codes only: never a form, a name or a message.
// What a run found and chose is diagnosed from the trace file instead
// (`features.recallTrace`, data/places/<id>/recall-trace.jsonl, see traceLine):
// it is memory about real people, kept under data/ only.

// health: allow file-length until 2027-04-01 -- one runner over the recall sources, grown by the one dependency that names the loop watch
import { personOfMember } from '../memory/addresses.ts';
import { log } from '../log.ts';
import { roleRequestOptions, railReason } from '../llm/openrouter.ts';
import { clampChars, oneLine } from '../memory/clamp.ts';
import { foldText, liveRecent, recentSettings } from '../memory/recent.ts';
import { DAY_MS } from '../time.ts';
import { audienceCovers } from './elsewhere.ts';
import { audienceAllows, railAudience } from './snapshot.ts';
import { checkPull } from './pull-fetch.ts';
import { roleModel } from '../llm/roles.ts';
import { pullPictures } from './pull.ts';
import {
  buildRecallRequest,
  clusterHits,
  clusterScore,
  countFormsIn,
  cutStretch,
  dropChatHits,
  fallbackWindow,
  followConversation,
  isRecentCue,
  matchMemory,
  matchRecord,
  meaningQuery,
  mergeWindows,
  parseRecallAnswer,
  queryKey,
  rankClusters,
  rareFormKeys,
  recallContext,
  recallSettings,
  renderRecallWindows,
  sampleOffsets,
  scanArchive,
  searchPlan,
} from './recall.ts';
import { fitExcerpts, focusHits, lanePlan, lexicalKeep, rankPrefetch } from './prefetch.ts';
import { indexWords } from '../memory/record-index.ts';
import { CODE } from '../tools/codes.ts';
import { dbSettings, quotesOf, search as searchRows, window as windowRows } from '../memory/db/recall.ts';
import { personId } from '../memory/db/ids.ts';
import { currentIface } from '../memory/db/current-iface.ts';
import { isIssuedInternalContext, issueContext, readContextSpec } from '../memory/db/scope.ts';
import { LEGACY_IFACE } from '../memory/db/legacy-namespace.ts';
import {
  hasRecallContext,
  historyExclusions,
  recallDatabase,
  hitFrom,
  inCommunity,
  linesOf,
  searchQueryOf,
  summaryFailure,
  summaryPrompt,
  untilAborted,
} from './recall-reads.ts';
import { isFiniteNumber, objOf } from '../tools/types.ts';
import { untracked } from '../loop-watch.ts';
import type { Untyped } from '../tools/types.ts';
import type {
  EmptyStatsResult,
  NewTraceInput,
  CreateRecallInput,
  CreateRecallResult,
  FindPeopleInput,
  StoredMemoryInput,
  RecordWindowsForInput,
  MeaningSearchInput,
  WriteTraceInput,
  ScopeOfInput,
  DbReaderInput,
  ReadContextInput,
  DbQuotesInput,
  RunDbQuotesInput,
  WindowInput,
  RecallWithInput,
  RunInput,
  PrefetchInput,
  PrefetchOutcome,
  RecallTrace,
  ArchiveEntry,
} from './recall-run-types.ts';

// src/memory/db/recall.js declares no parameter types, so TypeScript infers `null` for every defaulted one.
const dbSearch = searchRows as (db: Untyped, args: Untyped) => Untyped;
const dbWindow = windowRows as (db: Untyped, args: Untyped) => Untyped;

/** The share of `recall.timeoutMs` after which no further search is sent. */
const SEARCH_SHARE = 0.5;
/** The share of `recall.timeoutMs` at which a search still out is cut: the windows and the summary need the rest. */
const PREPARE_SHARE = 0.6;
const TIMEOUT = Symbol('timeout');
/** A meaning hit of the prefetch on a line of fewer words (an acknowledgement, an emoji) is no hit: its cosine comes from its neighbours. */
const MEANING_MIN_WORDS = 3;
/** How many lines apart the hits marked in one prefetch excerpt may lie (focusHits). */
const FOCUS_LINES = 6;
const DEFAULT_TIMERS = Object.freeze({
  set: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clear: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
});
// A name form a prefix search of members can match: Latin letters (at least one), digits, `.`, `_`, `'`, `-`, spaces.
const LATIN_FORM_RE = /^[\p{Script=Latin}\p{N} ._'-]+$/u;
const LATIN_LETTER_RE = /\p{Script=Latin}/u;
/** The characters of a stored-memory item's text the trace keeps when the item has no itemId. */
const TRACE_TEXT_CHARS = 120;

/** Whether the parsed server part asks anything. */
function asksServer(server: Untyped) {
  if (!server || typeof server !== 'object') return false;
  const some = (list: Untyped) => Array.isArray(list) && list.length > 0;
  return some(server.forms) || some(server.who) || Number.isFinite(server.from) || Number.isFinite(server.to);
}

/**
 * The locator of a run (the options recall.js matchRecord, matchMemory and
 * clusterHits read), or null: only for a server part marked `locator: true`
 * with a finite side of its range.
 */
function locatorOf(server: Untyped, settings: Untyped) {
  if (server?.locator !== true || (!Number.isFinite(server.from) && !Number.isFinite(server.to))) return null;
  return {
    from: Number.isFinite(server.from) ? server.from : null,
    to: Number.isFinite(server.to) ? server.to : null,
    bonus: settings.locatorBonus,
    decayDays: settings.locatorDecayDays,
    broadShare: settings.locatorBroadShare,
  };
}

/** A fresh stats record of one run. */
function emptyStats(): EmptyStatsResult {
  return {
    memory: 0,
    archived: 0,
    record: 0,
    meaning: 0,
    meaningMs: 0,
    planned: 0,
    queries: 0,
    failed: 0,
    hits: 0,
    inChatDropped: 0,
    kept: 0,
    clusters: 0,
    selfClusters: 0,
    windows: 0,
    summary: null,
    ms: 0,
  };
}

/** A row's revision as a number, or null (an archive row's revision is an id). */
function numericRevision(meta: Untyped) {
  return Number.isInteger(meta?.revision) ? meta.revision : null;
}

/**
 * The rows of the meaning searches deduplicated by kind and `meta.id` -- the
 * newest numeric revision wins, else the better score -- best score first, at
 * most `k`.
 */
function dedupeRows(rows: Untyped, k: number) {
  const best = new Map();
  for (const row of rows) {
    const key = `${row.meta?.kind}:${row.meta?.id}`;
    const known = best.get(key);
    if (!known) {
      best.set(key, row);
      continue;
    }
    const mine = numericRevision(row.meta);
    const theirs = numericRevision(known.meta);
    const newer = mine !== null && theirs !== null && mine !== theirs ? mine > theirs : row.score > known.score;
    if (newer) best.set(key, row);
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, k);
}

/** The start (epoch ms, UTC) of the month `months - 1` months before the month of `ms`: the last `months` archive segments. */
function monthsBack(ms: number, months: Untyped) {
  const day = new Date(ms);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth() - (months - 1), 1);
}

/** The last message's time of a window, or -Infinity. */
function windowEnd(window: Untyped) {
  const messages = window?.messages ?? [];
  return messages.length > 0 && Number.isFinite(messages[messages.length - 1].ts)
    ? messages[messages.length - 1].ts
    : -Infinity;
}

/** An epoch-ms time as an ISO string, or null. */
function isoOf(ms: unknown) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * A fresh trace record of one run, filled as the
 * run goes (clusters, summary) and completed by traceLine.
 */
function newTrace({ started, placeId, candidate, server }: NewTraceInput): RecallTrace {
  const from = Number.isFinite(server?.from) ? server.from : null;
  const to = Number.isFinite(server?.to) ? server.to : null;
  return {
    at: isoOf(started),
    placeId,
    triggerId: typeof candidate?.id === 'string' ? candidate.id : null,
    forms: Array.isArray(server?.forms) ? [...server.forms] : [],
    who: Array.isArray(server?.who) ? [...server.who] : [],
    when:
      from !== null || to !== null
        ? { from: isoOf(from), to: isoOf(to), role: server?.locator === true ? 'locator' : 'scope' }
        : null,
    clusters: [],
    summary: { answer: null, stretch: null, text: null, note: null },
    skipped: null,
    people: [],
    plan: [],
    memory: [],
    record: [],
    meaning: null,
  };
}

/** A stored-memory item as the trace keeps it: its itemId, or a short text when it has none. */
function traceItem(item: Untyped) {
  const itemId = typeof item?.itemId === 'string' && item.itemId ? item.itemId : null;
  return {
    kind: item?.kind ?? null,
    date: item?.date ?? null,
    itemId,
    text: itemId ? null : clampChars(oneLine(item?.text), TRACE_TEXT_CHARS),
    accountId: item?.accountId ?? null,
    self: item?.self === true,
    score: Number.isFinite(item?.score) ? item.score : null,
    // A locator run's slot: the share reserved for content, or the dated one.
    ...(item?.share ? { share: item.share } : {}),
  };
}

/** A record window as the trace keeps it; `kept` false until it joins the windows the summary reads. */
function traceRecordWindow(window: {
  placeId?: string | null;
  messages?: Array<Record<string, Untyped>>;
  hitIds?: Iterable<string>;
  share?: string | null;
}) {
  const messages = window?.messages ?? [];
  return {
    placeId: window?.placeId ?? null,
    from: isoOf(messages[0]?.ts),
    to: isoOf(messages[messages.length - 1]?.ts),
    hitIds: [...(window?.hitIds ?? [])],
    kept: false,
    ...(window?.share ? { share: window.share } : {}),
  };
}

/**
 * The trace line of a finished run: `{ at, placeId, triggerId, forms, who,
 * when, hits, inChatDropped, clusters, summary, lookupChars, skipped, people,
 * plan, memory, record }`. `summary` `{ answer, stretch, text, note }`:
 * `answer` `text` | `nothing` | `fallback` (null when no summary was asked
 * or reached), `stretch` null or `{ n, placeId, channelName, lines }` (the
 * `<found>` section number and the very lines the persona gets), `text` the
 * summary's text, `note` the analyzer's whole answer as written (null without
 * one). `lookupChars`: the characters the run hands to the turn (the text and
 * the stretch lines; the turn's own labels around them not counted).
 * `skipped`: the reason code of a run skipped before its summary (a gate of
 * `run`, or `no-query` / `no-hits`), else null. `people`: `{ id, form, how }`
 * per member the `who` forms found, `how` `stored` (a stored name or alias)
 * or `member-search`. `plan`: `{ kind, content, authorId, offset, sent,
 * total }` per message search planned (`total` null while unsent or when it
 * failed). `memory`: the stored-memory items matched, the archive's included
 * (traceItem). `record`: `{ placeId, from, to, hitIds, kept }` per record
 * window, `kept` whether it joined the windows the summary reads. `when`:
 * null without a range, else `{ from, to, role }`, `role` `scope` (a hard
 * bound) or `locator`. In a locator run each kept cluster, record window and
 * memory item also carries `share` (`broad`: a slot reserved for content
 * regardless of date, `dated`: one won with the proximity bonus; a cluster
 * not kept `null`), and the broad search page's plan entry `broad: true`;
 * otherwise those keys are absent. `meaning`:
 * null unless the run searched by meaning, else `{ query, candidates, kept,
 * ms }` -- `query` `question` | `question+reply` (what was embedded),
 * `candidates` the rows the searches returned, `kept` `{ id, kind, score,
 * rank }` per row left after deduplication (a message id or an archive
 * itemId, `record` | `archive`, the cosine, the 1-based meaning rank), `ms`
 * the time of the embedding and the searches.
 */
function traceLine(trace: RecallTrace, out: Untyped) {
  const text = typeof out?.text === 'string' ? out.text : null;
  const stretch = out?.stretch ?? null;
  return {
    at: trace.at,
    placeId: trace.placeId,
    triggerId: trace.triggerId,
    forms: trace.forms,
    who: trace.who,
    when: trace.when,
    hits: out?.stats?.hits ?? 0,
    inChatDropped: out?.stats?.inChatDropped ?? 0,
    clusters: trace.clusters,
    summary: {
      answer: trace.summary.answer,
      stretch: stretch
        ? {
            n: trace.summary.stretch,
            placeId: stretch.placeId,
            channelName: stretch.channelName ?? null,
            lines: stretch.lines,
          }
        : null,
      text,
      note: trace.summary.note ?? null,
    },
    lookupChars: [...(text ?? '')].length + [...(stretch?.lines ?? '')].length,
    skipped: trace.skipped,
    people: trace.people,
    plan: trace.plan,
    memory: trace.memory,
    record: trace.record,
    meaning: trace.meaning,
  };
}

export type { RecallStretch } from './recall-run-types.ts';

/**
 * The recall runner for the turn (task R2 wires it beside the web search).
 */
// health: allow function-length until 2027-04-01 -- the closure holds its whole operation, grown by the one dependency that names the loop watch
export function createRecall({
  hot,
  store,
  llm,
  reads,
  memberName = () => null,
  describer = null,
  archive = null,
  record = null,
  vectors = null,
  embed = null,
  memoryDb = null,
  iface = LEGACY_IFACE,
  now = Date.now,
  timers = DEFAULT_TIMERS,
  track = untracked,
}: CreateRecallInput): CreateRecallResult {
  /** Whether `llm.maxRequestsPerDay` is spent today: the summary would be refused. */
  function capSpent() {
    return typeof llm?.capLeft === 'function' && llm.capLeft() <= 0;
  }

  /**
   * Whether a run could search now: the switch on, the summary prompt
   * present, the daily request cap not spent. Read
   * only; for a caller deciding whether to ask for the server part at all.
   */
  function available(): boolean {
    try {
      const settings = recallSettings(hot.config);
      return Boolean(settings) && summaryPrompt(hot.prompts) !== null && !capSpent();
    } catch {
      return false;
    }
  }

  async function findPeople({ placeId, who, maxPeople, selfId, signal, searchUntil, via = null }: FindPeopleInput) {
    const found = new Map();
    if (maxPeople <= 0 || !Array.isArray(who) || who.length === 0) return [];
    let profiles = null;
    for (const form of who) {
      if (found.size >= maxPeople || signal.aborted) break;
      profiles ??= store.listUserProfiles?.() ?? [];
      let matched = false;
      const folded = foldText(form);
      for (const profile of profiles) {
        if (!profile?.id) continue;
        const names = [
          ...(Array.isArray(profile.names) ? profile.names : []),
          ...(Array.isArray(profile.aliases) ? profile.aliases : []).map((a: Untyped) => a?.name),
        ];
        if (!folded || !names.some((name) => typeof name === 'string' && foldText(name) === folded)) continue;
        matched = true;
        // The persona's own name points at no member to read about: it neither joins nor sends a member search.
        if (String(profile.id) === String(selfId)) continue;
        if (found.has(profile.id) || found.size >= maxPeople) continue;
        found.set(profile.id, { id: profile.id, name: oneLine(profile.names?.[0]) || form, username: '' });
        via?.set(profile.id, { form, how: 'stored' });
      }
      if (
        matched ||
        found.size >= maxPeople ||
        !LATIN_FORM_RE.test(form) ||
        !LATIN_LETTER_RE.test(form) ||
        now() >= searchUntil
      )
        continue;
      const searched = await untilAborted(signal, reads.searchMembers({ placeId }, { prefix: form, limit: maxPeople }));
      for (const member of searched?.members ?? []) {
        if (member.bot && member.id !== selfId) continue;
        const known = found.get(member.id);
        if (known) {
          known.username ||= member.handle ?? '';
          continue;
        }
        if (found.size >= maxPeople) break;
        found.set(member.id, {
          id: member.id,
          name: member.nickname ?? member.displayName ?? member.handle ?? '',
          username: member.handle ?? '',
        });
        via?.set(member.id, { form, how: 'member-search' });
      }
    }
    return [...found.values()];
  }

  /**
   * The recent lines this turn may show: the live ones (`memory.recentHours`,
   * none with `features.recent` off), from the turn's own channel or a channel
   * whose audience covers it -- the rule of the turn's `<recent>` block
   * (src/behavior/turn.ts recentInput, server side). In a private chat: from
   * a channel its `partnerId` can view (the pull rail's private-chat rule,
   * src/behavior/snapshot.ts#audienceAllows), as its hits are.
   */
  function shownRecentLines(config: Untyped, snapshot: Untyped, placeId: string, channel: Untyped, partnerId: Untyped) {
    const settings = recentSettings(config);
    if (!settings || typeof store.getRecent !== 'function') return [];
    const lines: Array<Untyped> = liveRecent(store.getRecent(placeId)?.lines, { now: now(), hours: settings.hours });
    if (lines.length === 0) return [];
    const here = inCommunity(channel) ? railAudience(channel.audience) : null;
    const covers = (source: Untyped) =>
      inCommunity(channel)
        ? audienceCovers(here, railAudience(source?.audience))
        : audienceAllows(channel, source, config, {
            partnerId,
          });
    const allowed = new Map();
    const shown = (id: Untyped) => {
      if (typeof id !== 'string' || !id) return false;
      if (id === channel.id) return true;
      if (!allowed.has(id)) allowed.set(id, covers(snapshot?.get(id) ?? null));
      return allowed.get(id);
    };
    return lines.filter((line) => shown(line.placeId));
  }

  async function storedMemory({
    config,
    settings,
    snapshot,
    placeId,
    channel,
    partnerId,
    server,
    recent,
    allowEntry,
    privateAccountId,
    signal,
    meaning = [],
    locator = null,
    source = archive,
  }: StoredMemoryInput) {
    const none = { items: [], nameOf: () => null };
    const forms = Array.isArray(server.forms) ? server.forms : [];
    const who = Array.isArray(server.who) ? server.who : [];
    if (settings.memoryItems <= 0 || (forms.length === 0 && who.length === 0 && meaning.length === 0)) return none;
    try {
      const profiles = typeof store.listUserProfiles === 'function' ? (store.listUserProfiles() ?? []) : [];
      const names = new Map<string, string | null>(
        profiles
          .filter((p: Untyped) => p?.id)
          .map((p: Untyped): [string, string | null] => [
            String(p.id),
            typeof p.names?.[0] === 'string' ? p.names[0] : null,
          ])
      );
      const ranged = Number.isFinite(server.from) || Number.isFinite(server.to);
      // A locator bounds no item: it only ranks (matchMemory's `locator`).
      const bounds = locator ? { from: null, to: null } : { from: server.from ?? null, to: server.to ?? null };
      const switchedOff = new Set<string>();
      const allow = (entry: ArchiveEntry) => !switchedOff.has(entry?.itemKind) && allowEntry(entry);
      // Entries are recorded after what they observed: the months from `from` on, the private archive after the place's.
      const stream = (query: Untyped) =>
        (async function* (): AsyncGenerator<ArchiveEntry> {
          yield* source.iterate(placeId, query);
          if (privateAccountId) yield* source.iterate(placeId, { ...query, privateAccountId });
        })();
      let archived: Array<Untyped> = [];
      if (typeof source?.iterate === 'function' && (ranged || settings.archiveMonths > 0)) {
        const asked = Number.isFinite(server.from)
          ? server.from
          : monthsBack(now(), Math.max(1, settings.archiveMonths));
        // A locator reads the usual months too, never fewer than its own range would.
        const from =
          locator && settings.archiveMonths > 0 ? Math.min(asked, monthsBack(now(), settings.archiveMonths)) : asked;
        try {
          archived = await scanArchive(stream({ from: new Date(from).toISOString() }), {
            forms,
            who,
            profiles,
            from: bounds.from,
            to: bounds.to,
            timezone: config.bot?.timezone,
            recent,
            allow,
            max: settings.memoryItems,
            signal,
          });
        } catch (err) {
          log.warn('recall: archive failed', { channel: channel.id, name: objOf(err).name ?? null });
        }
      }
      let meant: Array<Untyped> = [];
      if (typeof source?.iterate === 'function' && meaning.length > 0) {
        const rank = new Map<string, number>(meaning.map((row: Untyped, i: number): [string, number] => [row.id, i]));
        const times = meaning.map((row) => Date.parse(row.occurredAt)).filter(Number.isFinite);
        const newest = new Map<string, ArchiveEntry>();
        try {
          for await (const entry of stream(
            times.length > 0 ? { from: new Date(Math.min(...times)).toISOString() } : {}
          )) {
            if (signal?.aborted) break;
            if (!rank.has(entry?.itemId) || !allow(entry)) continue;
            const known = newest.get(entry.itemId);
            if (!known || String(entry.recordedAt ?? '') >= String(known.recordedAt ?? ''))
              newest.set(entry.itemId, entry);
          }
          meant = [...newest.values()].sort((a, b) => (rank.get(a.itemId) ?? 0) - (rank.get(b.itemId) ?? 0));
        } catch (err) {
          log.warn('recall: archive failed', { channel: channel.id, name: objOf(err).name ?? null });
        }
      }
      const items = matchMemory({
        forms,
        who,
        profiles,
        lore: typeof store.getLore === 'function' ? (store.getLore(placeId) ?? []) : [],
        learned: typeof store.getPlace === 'function' ? (store.getPlace(placeId)?.learned ?? []) : [],
        recentLines: shownRecentLines(config, snapshot, placeId, channel, partnerId),
        archived,
        meaning: meant,
        from: bounds.from,
        to: bounds.to,
        max: settings.memoryItems,
        timezone: config.bot?.timezone,
        recent,
        locator,
      });
      return { items, nameOf: (id: Untyped) => names.get(String(id)) ?? null };
    } catch (err) {
      log.warn('recall: memory failed', { channel: channel.id, name: objOf(err).name ?? null });
      return none;
    }
  }

  async function recordWindowsFor({
    settings,
    snapshot,
    placeId,
    server,
    people,
    recent,
    allowLine,
    privateAccountId,
    ownIds,
    selfName,
    signal,
    placeId: conversationId,
    meaning = [],
    locator = null,
  }: RecordWindowsForInput) {
    if (typeof record?.iterate !== 'function' || (settings.recordDays <= 0 && meaning.length === 0)) return [];
    try {
      const profiles = typeof store.listUserProfiles === 'function' ? (store.listUserProfiles() ?? []) : [];
      const ids = new Set<string>(people.map((p: Untyped) => String(p.id)));
      const stored = new Map<string, Untyped>(
        profiles.filter((p: Untyped) => p?.id).map((p: Untyped): [string, Untyped] => [String(p.id), p])
      );
      const aliases = [...ids].flatMap((id) => {
        const profile = stored.get(id);
        if (!profile) return [];
        return [
          ...(Array.isArray(profile.names) ? profile.names : []),
          ...(Array.isArray(profile.aliases) ? profile.aliases : []).map((a: Untyped) => a?.name),
        ].filter((name) => typeof name === 'string' && name);
      });
      const source = {
        async *iterate(id: Untyped, query: Untyped) {
          yield* record.iterate(id, query);
          if (privateAccountId) yield* record.iterate(id, { ...query, privateAccountId });
        },
      };
      const found = await matchRecord(placeId, {
        record: source,
        range: locator ? { from: null, to: null } : { from: server.from ?? null, to: server.to ?? null },
        locator,
        participants: [...ids],
        forms: server.forms ?? [],
        aliases: [...(server.who ?? []), ...aliases],
        recordDays: settings.recordDays,
        recordContext: settings.recordContext,
        followMessages: settings.followMessages,
        followGapMinutes: settings.followGapMinutes,
        now: now(),
        maxWindows: settings.maxClusters,
        allowLine,
        exclude: ownIds,
        recent,
        nameOf: (id) => {
          const profile = stored.get(String(id));
          return (
            (typeof profile?.names?.[0] === 'string' ? profile.names[0] : null) ??
            memberName(placeId, String(id)) ??
            null
          );
        },
        selfName,
        channelNameOf: (id) => snapshot?.get(id)?.name ?? null,
        meaning,
        signal,
      });
      return found.windows;
    } catch (err) {
      log.warn('recall: record failed', { channel: conversationId, name: objOf(err).name ?? null });
      return [];
    }
  }

  async function meaningSearch({
    config,
    settings,
    placeId,
    channel,
    candidate,
    lines,
    server,
    privateAccountId,
    sourceOf,
    ownIds,
    signal,
    locator = null,
  }: MeaningSearchInput) {
    if (typeof embed !== 'function' || typeof vectors?.search !== 'function' || settings.meaningCandidates <= 0)
      return null;
    const profiles = typeof store.listUserProfiles === 'function' ? (store.listUserProfiles() ?? []) : [];
    const stored = new Map<string, string | null>(
      profiles
        .filter((p: Untyped) => p?.id)
        .map((p: Untyped): [string, string | null] => [
          String(p.id),
          typeof p.names?.[0] === 'string' ? p.names[0] : null,
        ])
    );
    const nameOf = (id: Untyped) => stored.get(String(id)) ?? memberName(placeId, String(id)) ?? null;
    const query = meaningQuery({ candidate, lines, nameOf });
    if (!query) return null;
    const started = now();
    const trace: { query: Untyped; candidates: number; kept: Array<Untyped>; ms: number } = {
      query: query.form,
      candidates: 0,
      kept: [],
      ms: 0,
    };
    const out: { record: Array<Untyped>; archive: Array<Untyped>; trace: typeof trace; degraded: boolean } = {
      record: [],
      archive: [],
      trace,
      degraded: false,
    };
    const failed = (stage: Untyped, err: Untyped) => {
      out.degraded = true;
      log.warn('recall: meaning failed', {
        channel: channel.id,
        stage,
        reason: railReason(err, `${stage}-error`),
        status: objOf(err).statusCode ?? null,
        name: objOf(err).name ?? null,
      });
      trace.ms = now() - started;
      return out;
    };
    let vector;
    try {
      [vector] = await embed([query.text], { config, purpose: 'recall-query', signal });
    } catch (err) {
      return failed('embed', err);
    }
    // A locator bounds no month: every one is searched, the date only ranks later.
    const range = locator
      ? { from: null, to: null }
      : { from: Number.isFinite(server.from) ? server.from : null, to: Number.isFinite(server.to) ? server.to : null };
    const k = settings.meaningCandidates;
    const unseen = (meta: Untyped) => meta?.kind === 'archive' || !ownIds.has(meta?.id);
    const shared = (meta: Untyped) =>
      unseen(meta) &&
      (meta?.kind === 'archive' || (typeof meta?.placeId === 'string' && sourceOf(meta.placeId) !== null));
    let rows;
    try {
      rows = await vectors.search(placeId, vector, { ...range, k, filter: shared });
      if (privateAccountId)
        rows = [...rows, ...(await vectors.search(placeId, vector, { ...range, k, filter: unseen, privateAccountId }))];
    } catch (err) {
      return failed('search', err);
    }
    const kept = dedupeRows(Array.isArray(rows) ? rows : [], k);
    trace.candidates = Array.isArray(rows) ? rows.length : 0;
    trace.kept = kept.map((row, i) => ({ id: row.meta.id, kind: row.meta.kind, score: row.score, rank: i + 1 }));
    trace.ms = now() - started;
    for (const { meta } of kept) {
      if (meta.kind === 'archive') out.archive.push({ id: meta.id, occurredAt: meta.occurredAt });
      else
        out.record.push({
          id: meta.id,
          placeId: meta.placeId,
          occurredAt: meta.occurredAt,
          sourceIds: Array.isArray(meta.sourceIds) ? meta.sourceIds : [],
        });
    }
    return out;
  }

  /**
   * The run's trace line appended to data/places/<placeId>/recall-trace.jsonl
   * (store.appendRecallTrace, capped at `maxLines`); nothing without that
   * store call. A write that throws logs `recall: trace failed` and costs the
   * run nothing.
   */
  function writeTrace({ placeId, trace, out, maxLines }: WriteTraceInput) {
    if (typeof store.appendRecallTrace !== 'function' || !placeId) return;
    try {
      store.appendRecallTrace(placeId, traceLine(trace, out), { maxLines });
    } catch (err) {
      log.warn('recall: trace failed', { placeId, name: objOf(err).name ?? null });
    }
  }

  /**
   * The one broad search page of a locator run, or null: the first planned
   * query (not a range sample) without the range's bounds, over the past the
   * record does not hold (`before` the start of the record's last
   * `recall.recordDays` days; no bound without a record), newest first,
   * marked `broad`. None without a locator, or when the record reaches back
   * to the locator's start minus `recall.locatorDecayDays` days: the record,
   * read whole, already covers everything the date could point near.
   */
  function broadQuery(plan: Untyped, locator: Untyped, settings: Untyped) {
    const first = plan[0];
    if (!locator || !first || first.kind === 'range') return null;
    const recordStart =
      typeof record?.iterate === 'function' && settings.recordDays > 0 ? now() - settings.recordDays * DAY_MS : null;
    const margin = Number.isFinite(locator.from) ? locator.from - settings.locatorDecayDays * DAY_MS : -Infinity;
    if (recordStart !== null && recordStart <= margin) return null;
    return { ...first, after: null, before: recordStart, broad: true };
  }

  /** The cached captions of the windows' pictures and custom emoji, or undefined (cache only, never a request). */
  function cachedCaptions(config: Untyped, placeId: string | null, windows: Untyped) {
    if (!placeId || typeof describer?.cachedDescriptions !== 'function') return undefined;
    const { items, rest, emoji } = pullPictures(
      windows.flatMap((w: Untyped) => w.messages),
      0
    );
    const wanted = [...items, ...rest, ...emoji];
    if (wanted.length === 0) return undefined;
    try {
      return describer.cachedDescriptions(placeId, wanted) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * What a run may read toward `channel` (the turn's; a private chat on behalf of `partnerId`):
   * `sourceOf(placeId)`, the pull rail's verdict judged once per channel (`judged`): the
   * channel when its lines may reach this turn, else null -- search hits, record lines, archived
   * items and meaning rows of a refused channel never reach the turn; `privateAccountId`, the partner
   * of a private chat (else null): a private entry or line is its member's alone, read only on a
   * private turn with that member, the partner of the DM place `placeId` the turn stands in; `allowEntry` (an archive entry, by its `scope`) and
   * `allowLine` (a record line: a channel line by its channel, a private one by its member).
   */
  function scopeOf({ config, snapshot, channel, partnerId, placeId }: ScopeOfInput) {
    const judged = new Map();
    const sourceOf = (id: Untyped) => {
      if (!judged.has(id)) {
        let source = null;
        try {
          const verdict = checkPull({ snapshot, placeId: id, destination: channel, partnerId, config, now: now() });
          source = verdict.skip === null ? verdict.channel : null;
        } catch {
          source = null;
        }
        judged.set(id, source);
      }
      return judged.get(id);
    };
    const privateAccountId = !inCommunity(channel) && typeof partnerId === 'string' && partnerId ? partnerId : null;
    const allowScope = (scope: Untyped) => {
      // A private item is its partner's: named by their id, or by the DM place this private turn stands in.
      if (scope?.private === true)
        return privateAccountId !== null && (scope.user === privateAccountId || scope.place === placeId);
      return typeof scope?.channel !== 'string' || sourceOf(scope.channel) !== null;
    };
    const allowEntry = (entry: Untyped) => allowScope(entry?.scope);
    const allowLine = (line: Untyped) =>
      line?.scope?.private === true
        ? allowScope(line.scope)
        : typeof line?.scope?.channel === 'string' && allowScope(line.scope);
    return { judged, sourceOf, privateAccountId, allowEntry, allowLine };
  }

  function profilesFor(placeId: string | null): Array<Untyped> {
    if (!placeId || typeof store.listUserProfiles !== 'function') return [];
    return store.listUserProfiles() ?? [];
  }

  function namesFor(placeId: string | null, profiles: Array<Untyped>) {
    const stored = new Map<string, Untyped>(
      profiles.filter((profile) => profile?.id).map((profile) => [String(profile.id), profile])
    );
    return (id: Untyped) => {
      const name = stored.get(String(id))?.names?.[0];
      return (typeof name === 'string' && name ? name : null) ?? (placeId ? memberName(placeId, String(id)) : null);
    };
  }

  function dbReader({
    db = null,
    config,
    snapshot,
    placeId,
    channel,
    partnerId,
    asker = null,
    memoryContext = null,
  }: DbReaderInput) {
    const { privateAccountId } = scopeOf({ config, snapshot, channel, partnerId, placeId });
    const nameOf = namesFor(placeId, profilesFor(placeId));
    const ctx = readContext({ config, channel, privateAccountId, asker, memoryContext });
    const placeExists = db?.prepare('SELECT id FROM places WHERE id = ?');
    const knownPlaces = new Map<string, boolean>();
    return {
      nameOf,
      ctx,
      model: roleModel(config, 'embedding', 'recall-query') ?? null,
      channelNameOf: (id: Untyped) => snapshot?.get(id)?.name ?? null,
      allowPlace: (placeId: string) => {
        if (!knownPlaces.has(placeId)) knownPlaces.set(placeId, Boolean(placeExists?.get(placeId)));
        return knownPlaces.get(placeId) === true;
      },
    };
  }

  /**
   * The read context of a db read (see dbReader): the turn's own when it fits, else one issued for this read; an issued internal context spans every audience.
   */
  function readContext({ channel, privateAccountId, asker, memoryContext = null }: ReadContextInput) {
    const named = readContextSpec(currentIface(), iface, channel?.id, privateAccountId);
    const spec =
      named.kind === 'dm' && privateAccountId
        ? { ...named, person: personOfMember(store, String(privateAccountId), named.iface) }
        : named;
    const fits =
      memoryContext &&
      typeof memoryContext === 'object' &&
      typeof memoryContext.id === 'string' &&
      memoryContext.id.length > 0 &&
      (isIssuedInternalContext(memoryContext) ||
        (!memoryContext.internal &&
          (privateAccountId
            ? memoryContext.kind === 'dm' && spec.kind === 'dm' && memoryContext.person === spec.person
            : memoryContext.kind === 'group')));
    const issued = fits
      ? memoryContext
      : typeof memoryDb?.issueContext === 'function'
        ? memoryDb.issueContext(spec)
        : issueContext({ ...spec, now });
    return privateAccountId || !asker ? issued : { ...issued, asker: [personId(spec.iface, String(asker))] };
  }

  /** The stretches of db windows as `recall.run` returns them (decorated, captioned from the cache only, cut to `recall.stretchChars`). */
  function dbQuotes({ config, settings, placeId, selfName, windows, decorate }: DbQuotesInput) {
    const shown = windows.map((window: Untyped) =>
      typeof decorate === 'function' ? { ...window, messages: decorate(window.messages) } : window
    );
    const descriptions = cachedCaptions(config, placeId, shown);
    for (const window of shown) window.descriptions = descriptions;
    const render = {
      labels: hot.prompts.labels,
      timezone: config.bot?.timezone,
      selfName,
      seeReactions: true,
    };
    return quotesOf(shown, { render, stretchChars: settings.stretchChars });
  }

  /**
   * The persona's own search over the memory database (`quotes`): the question embedded once when
   * the meaning search is on (a failure leaves words only, `degraded`), then src/memory/db/recall.js#search inside the
   * turn's read context, the turn's own chat left out. Resolves the same result a `quotes` run does, plus `hidden`.
   */
  async function runDbQuotes({
    db,
    config,
    settings,
    snapshot,
    placeId,
    channel,
    partnerId,
    selfName,
    history,
    historyRef,
    candidate,
    server,
    decorate,
    started,
    memoryContext = null,
  }: RunDbQuotesInput) {
    const stats = emptyStats();
    const reader = dbReader({
      db,
      config,
      snapshot,
      placeId,
      channel,
      partnerId,
      asker: candidate?.authorId ?? null,
      memoryContext,
    });
    let vector = null;
    let degraded = false;
    if (typeof embed === 'function' && settings.meaningCandidates > 0) {
      const query = meaningQuery({ candidate, lines: [], withReply: false, nameOf: reader.nameOf });
      if (query) {
        const embedStarted = now();
        const controller = new AbortController();
        const timer = timers.set(() => controller.abort(), settings.timeoutMs);
        timer?.unref?.();
        try {
          [vector] = await embed([query.text], { config, purpose: 'recall-query', signal: controller.signal });
          stats.meaningMs = now() - embedStarted;
        } catch (err) {
          degraded = true;
          vector = null;
          log.warn('recall: meaning failed', { channel: channel.id, stage: 'embed', name: objOf(err).name ?? null });
        } finally {
          timers.clear(timer);
        }
      }
    }
    const exclusions = historyExclusions({ history, historyRef, context: reader.ctx, channel });
    const found = dbSearch(db, {
      ctx: reader.ctx,
      plan: server,
      limit: settings.maxClusters,
      now: now(),
      vector,
      settings: dbSettings(config),
      exclusions,
      nameOf: reader.nameOf,
      selfName,
      channelNameOf: reader.channelNameOf,
      allowPlace: reader.allowPlace,
      model: reader.model,
    });
    stats.hits = found.hits.length;
    stats.meaning = found.stats.meaning;
    stats.windows = found.windows.length;
    const quotes = dbQuotes({ config, settings, placeId, selfName, windows: found.windows, decorate });
    stats.kept = quotes.length;
    stats.summary = 'quotes';
    log.info('recall: quoted', {
      channel: channel.id,
      windows: found.windows.length,
      quoted: quotes.length,
      hidden: found.hidden,
      totalMs: now() - started,
    });
    // `hitIds`: the messages the search matched (scripts/recall-eval.ts scores them); the persona's tool ignores it.
    return {
      text: null,
      stretch: null,
      quotes,
      hidden: found.hidden === true,
      hitIds: found.hits.map((hit: Untyped) => hit.messageId),
      people: [],
      stats: { ...stats, ms: now() - started },
      outcome: { kind: 'searched', degraded, failed: 0, total: 1 },
    };
  }

  /**
   * A window read of the persona's own `memory.search` (`anchor`, `move`, `messages`, `minutes`): the lines of the
   * anchor's place up or down in time order, inside the turn's read context (src/memory/db/recall.js#window). The
   * `anchor` is a message id (a `#N` the executor already resolved). Resolves `{ quotes, outcome, stopped }`; `outcome`
   * `not-configured` while the database is not open, `unknown-anchor` for an anchor the turn cannot open or that does
   * not exist, `error` for a throw. Counts no daily run: it reads the local database only. `asker` is the user id of
   * whoever asked and `memoryContext` the turn's execution context, as for `run`.
   */
  async function window({
    placeId = null,
    snapshot = null,
    channel,
    partnerId = null,
    selfName = '',
    history = [],
    historyRef,
    anchor,
    resolvedAnchor,
    move = 'up',
    messages = null,
    minutes = null,
    decorate = null,
    asker = null,
    memoryContext = null,
  }: WindowInput) {
    const started = now();
    const stats = emptyStats();
    const out = (extra: Untyped) => ({
      text: null,
      stretch: null,
      people: [],
      stats: { ...stats, ms: now() - started },
      ...extra,
    });
    try {
      const config = hot.config;
      const settings = recallSettings(config);
      const db = recallDatabase(memoryDb);
      if (!settings || !db) return out({ outcome: { kind: 'not-configured' } });
      if (!hasRecallContext({ channel, partnerId, memoryContext })) return out({ outcome: { kind: 'not-configured' } });
      const reader = dbReader({ db, config, snapshot, placeId, channel, partnerId, asker, memoryContext });
      const exclusions = historyExclusions({ history, historyRef, context: reader.ctx, channel });
      const found = dbWindow(db, {
        ctx: reader.ctx,
        anchor,
        resolvedAnchor,
        move,
        messages,
        minutes,
        settings: dbSettings(config),
        nameOf: reader.nameOf,
        selfName,
        channelNameOf: reader.channelNameOf,
        exclusions,
        allowPlace: reader.allowPlace,
      });
      if (found.unknown) return out({ outcome: { kind: 'unknown-anchor' } });
      const quotes = dbQuotes({ config, settings, placeId, selfName, windows: found.windows, decorate });
      log.info('recall: window', {
        channel: channel.id,
        move: move === 'down' ? 'down' : 'up',
        lines: found.windows[0]?.messages.length ?? 0,
        stopped: found.stopped,
      });
      return out({
        quotes,
        stopped: found.stopped,
        outcome: { kind: 'searched', degraded: false, failed: 0, total: 1 },
      });
    } catch (err) {
      log.warn('recall: failed', {
        channel: channel?.id ?? null,
        reason: 'error',
        status: null,
        name: objOf(err).name ?? null,
      });
      return out({ outcome: { kind: 'error' } });
    }
  }

  /**
   * The search, the windows and the summary; null once `signal` is aborted
   * (the run was abandoned). The message searches carry `searchSignal`
   * (aborted with `signal`, or at the PREPARE_SHARE mark: a search cut there
   * counts as failed and ends the searching). Once the windows are read,
   * `progress.fallback(kind)` gives the answer without a summary. `trace`
   * (the run's trace record, or null with `features.recallTrace` off) gets
   * the clusters and the summary's answer as they are known.
   */
  async function recallWith({
    config,
    settings,
    prompt,
    snapshot,
    placeId,
    channel,
    partnerId,
    selfId,
    selfName,
    history,
    context,
    contextDescriptions,
    candidate,
    server,
    signal,
    searchSignal,
    progress,
    started,
    stats,
    trace,
    decorate = null,
    memoryContext = null,
  }: RecallWithInput) {
    const conversationId = channel.id;
    const searchUntil = started + settings.timeoutMs * SEARCH_SHARE;
    const result = (extra = {}) => ({
      text: null,
      stretch: null,
      people: [],
      stats: { ...stats, ms: now() - started },
      ...extra,
    });

    // The pull rail toward this turn's channel and the private-owner rule (scopeOf).
    const scope = scopeOf({ config, snapshot, channel, partnerId, placeId });
    const { judged, sourceOf, privateAccountId, allowEntry, allowLine } = scope;
    const recent = isRecentCue(server, { now: now(), recordDays: settings.recordDays });
    // A `when:` that only locates the event: it ranks, it bounds no local source (locatorOf).
    const locator = locatorOf(server, settings);
    // The turn's own chat: its lines are dropped by id from every source (a private chat is not part of
    // the server: it drops nothing).
    const own = inCommunity(channel) && Array.isArray(history) ? history.filter((m) => m?.id) : [];
    const ownIds = new Set(own.map((m) => m.id));

    // 0a. Meaning: one embedding, the vector index; a failure leaves words only.
    const chatLines = [...(Array.isArray(history) ? history : []), ...(Array.isArray(context) ? context : [])];
    const meaning = await meaningSearch({
      config,
      settings,
      placeId,
      channel,
      candidate,
      lines: chatLines,
      server,
      privateAccountId,
      sourceOf,
      ownIds,
      signal: searchSignal,
      locator,
    });
    if (signal.aborted) return null;
    if (meaning) {
      stats.meaning = meaning.trace.kept.length;
      stats.meaningMs = meaning.trace.ms;
      if (trace) trace.meaning = meaning.trace;
    }

    // The time of each step, for `recall: searched` (src/tools/impl/metrics.ts reads them off the log).
    const took = { memoryMs: 0, recordMs: 0, searchMs: 0 };
    let stepAt = now();
    // 0. Stored memory (the archive included): no request, before the first search request so it always fits the budget.
    const memory = await storedMemory({
      config,
      settings,
      snapshot,
      placeId,
      channel,
      partnerId,
      server,
      recent,
      allowEntry,
      privateAccountId,
      signal,
      meaning: meaning?.archive ?? [],
      locator,
    });
    if (signal.aborted) return null;
    took.memoryMs = now() - stepAt;
    stats.memory = memory.items.length;
    stats.archived = memory.items.filter((item) => item.kind.startsWith('archived ')).length;
    if (trace) trace.memory = memory.items.map(traceItem);

    // 1. People.
    const via = new Map();
    stepAt = now();
    const people = await findPeople({
      placeId,
      who: server.who ?? [],
      maxPeople: settings.maxPeople,
      selfId,
      signal: searchSignal,
      searchUntil,
      via,
    });
    if (signal.aborted) return null;
    took.searchMs += now() - stepAt;
    if (trace)
      trace.people = people.map((p) => ({
        id: p.id,
        form: via.get(p.id)?.form ?? null,
        how: via.get(p.id)?.how ?? null,
      }));

    // 2. The queries, over the whole server and the range asked: the turn's own chat bounds no
    // query, its lines are dropped from the hits by id (step 4, `ownIds` above).
    const plan = searchPlan({
      forms: server.forms ?? [],
      who: server.who ?? [],
      accountIds: people.map((p) => p.id),
      from: server.from ?? null,
      to: server.to ?? null,
      maxForms: settings.maxForms,
    });
    const peopleOut = () => people.map((p) => ({ count: 0, newestTs: null, ...p }));

    // 2b. The record of the last days, for a dated or "recently" question: no request.
    stepAt = now();
    const recordWindows = await recordWindowsFor({
      settings,
      snapshot,
      placeId,
      server,
      people,
      recent,
      allowLine,
      privateAccountId,
      ownIds,
      selfName,
      signal,
      conversationId,
      meaning: meaning?.record ?? [],
      locator,
    });
    if (signal.aborted) return null;
    took.recordMs = now() - stepAt;
    const recordTrace = new Map(recordWindows.map((window) => [window, traceRecordWindow(window)]));
    if (trace) trace.record = [...recordTrace.values()];
    if (plan.length === 0 && memory.items.length === 0 && recordWindows.length === 0) {
      log.info('recall: skipped', { channel: conversationId, reason: 'no-query' });
      if (trace) trace.skipped = 'no-query';
      return result({ people: peopleOut() });
    }

    // 3. One query after another, newest first; a range alone is sampled across its total.
    // Each query's total on the whole server is kept: a form found that rarely weighs more (step 5).
    const hits = new Map();
    const totals = new Map();
    // With a locator, one broad page right after the first query (broadQuery): early enough to fit the budget.
    const broad = broadQuery(plan, locator, settings);
    const queue = broad ? [plan[0], broad, ...plan.slice(1)] : [...plan];
    stats.planned = queue.length;
    // The trace's entry of each planned query, filled once it is sent.
    const planned = new Map();
    const tracePlanned = (query: Untyped) => {
      if (!trace) return;
      const entry = {
        kind: query.kind,
        content: query.content ?? null,
        authorId: query.authorId ?? null,
        offset: query.offset ?? 0,
        sent: false,
        total: null,
        ...(query.broad ? { broad: true } : {}),
      };
      planned.set(query, entry);
      trace.plan.push(entry);
    };
    for (const query of queue) tracePlanned(query);
    stepAt = now();
    while (queue.length > 0) {
      if (signal.aborted) return null;
      if (searchSignal.aborted || (stats.queries > 0 && now() >= searchUntil)) break;
      const query = queue.shift();
      const page = await untilAborted(searchSignal, reads.searchMessages({ placeId }, searchQueryOf(query)));
      stats.queries += 1;
      const traced = planned.get(query);
      if (traced) {
        traced.sent = true;
        traced.total = page ? page.total : null;
      }
      if (signal.aborted) return null;
      if (!page) {
        stats.failed += 1;
        continue;
      }
      // A message several queries find is one hit carrying every key, each by the query's kind
      // (form / who / author / range): clusterHits ranks by the topic (form) keys first.
      const key = queryKey(query);
      // Rarity is judged on the asked range: the broad page's total counts for nothing.
      if (!query.offset && !query.broad) totals.set(key, page.total);
      for (const raw of page.hits) {
        const hit = hitFrom(raw);
        if (!hits.has(hit.id)) hits.set(hit.id, hit);
        hits.get(hit.id).queries.add(key);
      }
      if (query.kind === 'range' && !query.offset) {
        const more = sampleOffsets(page.total, settings.dateSamples)
          .filter((offset) => offset > 0)
          .map((offset) => ({ ...query, offset }));
        queue.push(...more);
        for (const sample of more) tracePlanned(sample);
        stats.planned += more.length;
      }
    }
    took.searchMs += now() - stepAt;
    stats.hits = hits.size;

    // 4. Dropped: other bots, the turn's own chat, channels the pull rail refuses here (sourceOf, judged once each).
    // The turn's own chat first, before clustering: those lines are in `<chat>` already.
    const unseen = dropChatHits([...hits.values()], ownIds);
    stats.inChatDropped = unseen.dropped;
    const kept = unseen.hits.filter(
      (hit) => Number.isFinite(hit.ts) && !(hit.bot && hit.authorId !== selfId) && sourceOf(hit.placeId) !== null
    );
    stats.kept = kept.length;
    for (const person of people) {
      const theirs = kept.filter((hit) => hit.authorId === person.id);
      person.count = theirs.length;
      person.newestTs = theirs.length > 0 ? Math.max(...theirs.map((hit) => hit.ts)) : null;
      person.username ||= theirs.find((hit) => hit.username)?.username ?? '';
    }

    // 5. Clusters (a form whose search totals at most `recall.rareHits` is rare): `recall.selfExtra`
    // more than will be kept, 6. a window around each, followed past its last line while the
    // conversation goes on (`recall.followMessages`, `recall.followGapMinutes`; a failed fetch keeps
    // the window as it was; other bots and the turn's own chat left out; a window that reached into
    // the chat is marked `overlapsChat`, one holding the persona's own line `self`), 7. the final
    // `recall.maxClusters` re-ranked with `recall.selfBonus` for `self`.
    const candidates = clusterHits(kept, {
      gapMinutes: settings.clusterGapMinutes,
      maxClusters: settings.maxClusters + settings.selfExtra,
      keepOldest: settings.keepOldest,
      rareForms: rareFormKeys(totals, settings.rareHits),
      locator,
    });
    // The lines after a window's last one that continue its conversation; none when the follow is off,
    // the window already ends in the turn's own chat (what follows is that chat) or the fetch fails.
    const followOf = async (source: Untyped, messages: Untyped) => {
      const last = messages[messages.length - 1];
      if (settings.followMessages <= 0 || !last || ownIds.has(last.id)) return [];
      const after = await linesOf(reads, source, { after: last.id, limit: settings.followMessages });
      return after ? followConversation(last.ts, after, settings) : [];
    };
    const fetched = await Promise.all(
      candidates.map(async (cluster) => {
        const source = judged.get(cluster.placeId);
        const around = await linesOf(reads, source, { around: cluster.middleId, limit: settings.windowMessages });
        if (!around) return null;
        const messages = [...around, ...(await followOf(source, around))];
        const shown = messages.filter((m) => !m.bot && !ownIds.has(m.id));
        const marked = {
          ...cluster,
          self: shown.some((m) => m.self === true),
          overlapsChat: messages.some((m) => ownIds.has(m.id)),
        };
        return {
          cluster: marked,
          window: {
            placeId: cluster.placeId,
            channelName: source.name ?? null,
            messages: shown,
            hitIds: cluster.ids,
            overlapsChat: marked.overlapsChat,
          },
        };
      })
    );
    if (signal.aborted) return null;
    const ready = fetched.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    const chosen = rankClusters(
      ready.map((entry) => entry.cluster),
      { maxClusters: settings.maxClusters, keepOldest: settings.keepOldest, selfBonus: settings.selfBonus, locator }
    );
    const windowOf = new Map(ready.map((entry) => [entry.cluster, entry.window]));
    stats.clusters = chosen.length;
    stats.selfClusters = chosen.filter((cluster) => cluster.self).length;
    if (trace) {
      const chosenSet = new Set(chosen);
      const markedOf = new Map(ready.map((entry) => [entry.cluster.middleId, entry.cluster]));
      trace.clusters = candidates.map((cluster) => {
        const marked = markedOf.get(cluster.middleId) ?? null;
        return {
          placeId: cluster.placeId,
          from: isoOf(cluster.startTs),
          to: isoOf(cluster.endTs),
          score: clusterScore(marked ?? cluster, settings.selfBonus),
          queries: cluster.queries,
          self: marked?.self === true,
          overlapsChat: marked?.overlapsChat === true,
          kept: marked !== null && chosenSet.has(marked),
          // A locator run: which share kept it (rankClusters marks the kept ones), none for one not kept.
          ...(locator ? { share: marked !== null && chosenSet.has(marked) ? (marked.share ?? null) : null } : {}),
        };
      });
    }
    const windows = mergeWindows(chosen.map((cluster) => windowOf.get(cluster)));
    // The record's windows join them by time (the search's order kept), unless the search already shows all their lines.
    const shownIds = new Set(windows.flatMap((window) => window.messages.map((m) => m.id)));
    for (const window of recordWindows) {
      if (!window.messages.some((m: Untyped) => !shownIds.has(m.id))) continue;
      const at = windows.findIndex((other) => windowEnd(other) < windowEnd(window));
      if (at === -1) windows.push(window);
      else windows.splice(at, 0, window);
      stats.record += 1;
      const traced = recordTrace.get(window);
      if (traced) traced.kept = true;
    }
    stats.windows = windows.length;
    if (typeof decorate === 'function') {
      windows.forEach((window, i) => {
        windows[i] = { ...window, messages: decorate(window.messages) };
      });
    }
    const descriptions = cachedCaptions(config, placeId, windows);
    for (const window of windows) window.descriptions = descriptions;
    log.info('recall: searched', {
      channel: conversationId,
      memory: stats.memory,
      archived: stats.archived,
      record: stats.record,
      meaning: stats.meaning,
      meaningMs: stats.meaningMs,
      memoryMs: took.memoryMs,
      recordMs: took.recordMs,
      searchMs: took.searchMs,
      planned: stats.planned,
      queries: stats.queries,
      failed: stats.failed,
      hits: stats.hits,
      inChatDropped: stats.inChatDropped,
      kept: stats.kept,
      clusters: stats.clusters,
      selfClusters: stats.selfClusters,
      windows: stats.windows,
      people: people.length,
      ms: now() - started,
    });

    // 7. The summary.
    const render = {
      labels: hot.prompts.labels,
      timezone: config.bot?.timezone,
      selfName,
      seeReactions: true,
    };
    /** One window as a stretch (no indices, cut to `recall.stretchChars`), or null. */
    const stretchOf = (window: Untyped) => {
      if (!window || settings.stretchChars <= 0) return null;
      const [shown] = renderRecallWindows([window], { ...render, indexed: false });
      const lines = cutStretch(shown?.lines ?? [], settings.stretchChars);
      if (lines.length === 0) return null;
      // `entries`: each line's message (its id, author, whether it is hers, the message itself), for the handles of a memory.search result.
      const byId = new Map<string, Untyped>(window.messages.map((m: Untyped): [string, Untyped] => [m.id, m]));
      const entries = lines.map((line) => {
        const message = byId.get(line.id) ?? null;
        return {
          id: line.id,
          text: line.text,
          authorId: message?.authorId ?? null,
          self: message?.self === true,
          message,
        };
      });
      return {
        placeId: window.placeId,
        channelName: window.channelName,
        startTs: lines[0].ts,
        lines: lines.map((line) => line.text).join('\n'),
        entries,
      };
    };
    // Stored memory alone is enough to ask the summary.
    const messages =
      windows.length > 0 || memory.items.length > 0
        ? buildRecallRequest({
            prompt,
            question: candidate ?? {},
            people,
            windows,
            memory: memory.items,
            // The chat lines before the question: what the question refers to.
            context: recallContext(Array.isArray(context) ? context : history, candidate, settings.contextMessages),
            contextDescriptions,
            nameOf: memory.nameOf,
            answerChars: settings.answerChars,
            memoryTokens: settings.memoryTokens,
            // The asker's date, when it only locates the event, reaches the summary as an estimate.
            timeCue: locator ? { from: locator.from, to: locator.to } : null,
            now: now(),
            ...render,
          })
        : null;
    if (!messages) {
      log.info('recall: skipped', { channel: conversationId, reason: 'no-hits' });
      if (trace) trace.skipped = 'no-hits';
      return result({ people: peopleOut() });
    }
    // Without a summary the search still answers: the first-ranked window verbatim, no text
    // (stored memory alone gives nothing then: its items are notes, not chat).
    let asked: Untyped = null;
    const fallback = (kind: Untyped) => {
      stats.summary = kind;
      const chosenWindow = fallbackWindow(windows);
      const stretch = stretchOf(chosenWindow);
      if (trace)
        trace.summary = {
          answer: 'fallback',
          stretch: stretch ? windows.indexOf(chosenWindow) + 1 : null,
          text: null,
          note: null,
        };
      log.info('recall: summary', {
        channel: conversationId,
        ms: asked === null ? 0 : now() - asked,
        totalMs: now() - started,
        answer: 'fallback',
        stretch: stretch !== null,
        summary: kind,
      });
      return result({ stretch, people: peopleOut() });
    };
    progress.fallback = fallback;
    if (started + settings.timeoutMs - now() < settings.minSummaryMs) return fallback('skipped');
    asked = now();
    let completion;
    try {
      completion = await llm.complete(messages, {
        model: roleModel(config, 'analyzer', 'recall-summary'),
        ...roleRequestOptions(config, {
          role: 'analyzer',
          maxOutputTokens: settings.maxOutputTokens,
          purpose: 'recall-summary',
          signal,
          timeoutMs: Math.max(1, started + settings.timeoutMs - asked),
          long: true,
        }),
      });
    } catch (err) {
      if (signal.aborted) return null;
      log.warn('recall: failed', {
        channel: conversationId,
        reason: railReason(err),
        status: objOf(err).statusCode ?? null,
        name: objOf(err).name ?? null,
      });
      return fallback(summaryFailure(err));
    }
    if (signal.aborted) return null;
    stats.summary = 'answered';
    const answer = parseRecallAnswer(completion?.text, { answerChars: settings.answerChars, count: windows.length });
    const stretch = answer.stretch !== null ? stretchOf(windows[answer.stretch - 1]) : null;
    if (trace)
      trace.summary = {
        answer: answer.text ? 'text' : 'nothing',
        stretch: stretch ? answer.stretch : null,
        text: answer.text,
        note: typeof completion?.text === 'string' ? completion.text : null,
      };
    log.info('recall: summary', {
      channel: conversationId,
      ms: now() - asked,
      totalMs: now() - started,
      answer: answer.text ? 'text' : 'nothing',
      stretch: stretch !== null,
    });
    return result({ text: answer.text, stretch, people: peopleOut() });
  }

  async function run({
    placeId = null,
    snapshot = null,
    channel,
    partnerId = null,
    selfId,
    selfName,
    history = [],
    historyRef,
    context = null,
    contextDescriptions,
    candidate = null,
    server = null,
    op = null,
    decorate = null,
    quotes = false,
    memoryContext = null,
  }: RunInput) {
    const started = now();
    const conversationId = channel?.id ?? null;
    const stats = emptyStats();
    const empty = (extra = {}) => ({
      text: null,
      stretch: null,
      people: [],
      stats: { ...stats, ms: now() - started },
      ...extra,
    });
    let trace: Untyped = null;
    let traceMaxLines: Untyped = null;
    const skip = (reason: string) => {
      log.info('recall: skipped', { channel: conversationId, reason });
      if (trace) trace.skipped = reason;
      // The daily limits are named to the persona's own search (`outcome`); other gates are no news to her.
      return finish(empty(reason === 'daily-cap' || reason === 'daily' ? { outcome: { kind: 'daily-cap' } } : {}));
    };
    let controller = null;
    let timer = null;
    let cut = null;
    const finish = (out: Untyped) => {
      if (trace) writeTrace({ placeId, trace, out, maxLines: traceMaxLines });
      return out;
    };
    // The journal's closing line of a run that started (`op`): what it found, never the text.
    const opResult = (out: Untyped, status: Untyped) => ({
      status,
      hits: out?.stats?.hits ?? stats.hits,
      kept: out?.stats?.kept ?? stats.kept,
      summaryChars: typeof out?.text === 'string' ? out.text.length : 0,
      stretch: Boolean(out?.stretch),
    });
    try {
      const config = hot.config;
      const settings = recallSettings(config);
      if (!settings) return empty();
      // Every run past the switch is traced, one skipped by a gate below included (its reason in `skipped`).
      trace = newTrace({ started, placeId: conversationId, candidate, server });
      traceMaxLines = settings.traceMaxLines;
      if (!hasRecallContext({ channel, partnerId, memoryContext })) return skip('private-chat');
      if (!asksServer(server)) return skip('no-query');
      const prompt = summaryPrompt(hot.prompts);
      if (!prompt && !quotes) return skip('no-prompt');
      if (capSpent()) return skip('daily-cap');
      await op?.started();

      // The persona's own search over the memory database: no message search, no summary.
      if (quotes) {
        const db = recallDatabase(memoryDb);
        if (!db) {
          if (op) await op.failed(CODE.NOT_CONFIGURED);
          return finish(empty({ outcome: { kind: 'not-configured' } }));
        }
        const found = await runDbQuotes({
          db,
          config,
          settings,
          snapshot,
          placeId,
          channel,
          partnerId,
          selfName,
          history,
          historyRef,
          candidate,
          server,
          decorate,
          started,
          memoryContext,
        });
        if (trace) trace.summary = { answer: 'quotes', stretch: null, text: null, note: null };
        if (op) await op.succeeded(opResult(found, 'ok'));
        return finish(found);
      }

      if (!placeId) return skip('private-chat');

      controller = new AbortController();
      const searching = new AbortController();
      controller.signal.addEventListener('abort', () => searching.abort(), { once: true });
      const deadline = new Promise((resolve) => {
        timer = timers.set(() => resolve(TIMEOUT), settings.timeoutMs);
        timer?.unref?.();
      });
      cut = timers.set(() => searching.abort(), Math.floor(settings.timeoutMs * PREPARE_SHARE));
      cut?.unref?.();
      const progress: { fallback: ((kind: string) => Untyped) | null } = { fallback: null };
      const work = recallWith({
        config,
        settings,
        // The guard above returns when there is neither a prompt nor a persona's own search (`quotes`).
        prompt: prompt as string,
        snapshot,
        placeId,
        channel,
        partnerId,
        selfId,
        selfName,
        history,
        context,
        contextDescriptions,
        candidate,
        server,
        signal: controller.signal,
        searchSignal: searching.signal,
        progress,
        started,
        stats,
        trace,
        decorate,
        memoryContext,
      });
      work.catch(() => {});
      const outcome = await Promise.race([work, deadline]);
      if (outcome === TIMEOUT) {
        controller.abort();
        log.warn('recall: failed', { channel: conversationId, reason: 'timeout', status: null, name: null });
        const fallen = progress.fallback ? progress.fallback('timeout') : null;
        if (op) await (fallen ? op.succeeded(opResult(fallen, 'timeout')) : op.failed(CODE.TIMEOUT));
        return finish(fallen ?? empty({ outcome: { kind: 'timeout' } }));
      }
      const out = outcome ?? empty();
      if (op) await op.succeeded(opResult(out, 'ok'));
      return finish(out);
    } catch (err) {
      controller?.abort();
      log.warn('recall: failed', {
        channel: conversationId,
        reason: 'error',
        status: null,
        name: objOf(err).name ?? null,
      });
      if (op) await op.failed(CODE.ERROR);
      return finish(empty({ outcome: { kind: 'error' } }));
    } finally {
      if (timer !== null) timers.clear(timer);
      if (cut !== null) timers.clear(cut);
    }
  }

  /**
   * A read-only source (`deps.record` / `deps.archive`) whose reads the lanes of one prefetch
   * share: each `iterate(id, query)` is read once (the first caller's), every other caller with
   * the same arguments gets the same lines. Null without the source.
   */
  function sharedSource(source: Untyped) {
    if (typeof source?.iterate !== 'function') return null;
    const reads = new Map();
    return {
      async *iterate(id: Untyped, query = {}) {
        const key = JSON.stringify([id, query]);
        if (!reads.has(key)) {
          reads.set(
            key,
            (async () => {
              const lines = [];
              for await (const line of source.iterate(id, query)) lines.push(line);
              return lines;
            })()
          );
        }
        yield* await reads.get(key);
      },
    };
  }

  async function prefetch({
    placeId = null,
    snapshot = null,
    channel,
    partnerId = null,
    selfId,
    selfName,
    history = [],
    historyRef,
    lanes = [],
    at = null,
    decorate = null,
    asker = null,
    memoryContext = null,
  }: PrefetchInput): Promise<PrefetchOutcome | null> {
    const started = now();
    const list = Array.isArray(lanes) ? lanes.filter((lane) => lane && typeof lane.kind === 'string') : [];
    const basis = list.map((lane) => lane.kind);
    const conversationId = channel?.id ?? null;
    let timer = null;
    const finish = (status: Untyped, extra: Record<string, unknown> = {}) => {
      const out: PrefetchOutcome = { status, basis, excerpts: [], ms: now() - started, ...extra };
      log.info('recall: prefetched', {
        channel: conversationId,
        status,
        lanes: basis.length,
        excerpts: out.excerpts.length,
        candidates: out.stats?.candidates ?? 0,
        searches: out.stats?.searches ?? 0,
        failed: out.stats?.failed ?? 0,
        meaning: out.stats?.meaning ?? 0,
        partial: out.partial === true,
        ms: out.ms,
      });
      return out;
    };
    try {
      const config = hot.config;
      const settings = recallSettings(config);
      if (!settings || list.length === 0) return null;
      if (!hasRecallContext({ channel, partnerId, memoryContext }))
        return finish('unavailable', { reason: 'private-chat' });
      const p = settings.prefetch;
      const until = isFiniteNumber(at) ? at : now();
      const bounded = isFiniteNumber(at);
      const controller = new AbortController();
      const signal = controller.signal;
      const scope = scopeOf({ config, snapshot, channel, partnerId, placeId });
      const { sourceOf, privateAccountId, allowEntry, allowLine } = scope;
      const profiles = profilesFor(placeId);
      const nameOf = namesFor(placeId, profiles);
      const channelNameOf = (id: Untyped) => snapshot?.get(id)?.name ?? null;
      // A replay's moment bounds the archive too: an entry recorded after it did not exist yet.
      const archiveShared = sharedSource(
        bounded && typeof archive?.iterate === 'function'
          ? {
              async *iterate(id: Untyped, query: Untyped) {
                for await (const entry of archive.iterate(id, query))
                  if (!(Date.parse(entry?.recordedAt) > until)) yield entry;
              },
            }
          : archive
      );
      const trigger = list.find((lane) => lane.kind === 'message')?.words ?? '';
      const plans = list.map((lane) =>
        lanePlan(lane, {
          profiles,
          selfId,
          selfName,
          maxForms: settings.maxForms,
          shortWords: p.shortWords,
          minFormsMatched: p.minFormsMatched,
          trigger,
        })
      );
      // A source of a live turn's moment only: nothing after `at` (a replay's past moment).
      const inTime = (window: Untyped) => ({
        ...window,
        messages: window.messages.filter((m: Untyped) => !(m.ts > until)),
      });
      const settled: Array<Untyped> = [];
      const stats = { searches: 0, failed: 0, meaning: 0 };
      const task = (name: string, work: Untyped) => {
        stats.searches += 1;
        return work().then(
          (result: Untyped) => {
            if (result && !signal.aborted) settled.push(result);
          },
          (err: Untyped) => {
            stats.failed += 1;
            if (!signal.aborted)
              log.warn('recall: prefetch failed', {
                channel: conversationId,
                stage: name,
                name: objOf(err).name ?? null,
              });
          }
        );
      };
      const memoryItems = (items: Untyped, keep: Untyped) =>
        items.filter((item: Untyped) => item.kind !== 'recent' && keep(item));
      const stages: Record<string, number> = {};
      const timed = (name: string, promise: Untyped) => {
        const at = now();
        return promise.finally(() => {
          stages[name] = Math.max(stages[name] ?? 0, now() - at);
        });
      };
      // The database answers the words and the meaning of every lane (while it is not open, the stored memory alone).
      const db = recallDatabase(memoryDb);
      const dbMeaning = Boolean(db) && typeof embed === 'function';
      // One embedding request for every lane's text.
      const laneVectors = dbMeaning
        ? timed(
            'embed',
            embed(
              list.map((lane) => oneLine(lane.text)),
              { config, purpose: 'recall-query', signal }
            )
          )
        : Promise.resolve(null);
      laneVectors.catch(() => {});
      const tasks: Array<Untyped> = [];
      plans.forEach((plan, i) => {
        tasks.push(
          task('memory', async () => {
            const used = plan;
            if (!used || !placeId) return null;
            const forms = [...used.phrases, ...used.forms];
            if (forms.length === 0 && used.who.length === 0) return null;
            const memory = await timed(
              'memory',
              storedMemory({
                config,
                settings,
                snapshot,
                placeId,
                channel,
                partnerId,
                server: { forms, who: used.who, from: null, to: bounded ? until : null },
                recent: false,
                allowEntry,
                privateAccountId,
                signal,
                source: archiveShared,
              })
            );
            const relevant = (item: Untyped) =>
              countFormsIn([item.text], used.phrases) > 0 ||
              countFormsIn([item.text], used.forms) >= Math.max(1, used.need);
            return { lane: list[i].kind, memory: memoryItems(memory.items, relevant) };
          })
        );
      });
      if (db) {
        // One search of the database per lane: words, letters, meaning and people fused, the stretches built around the
        // hits. A word hit is relevant by lexicalKeep (its terms and phrases, its cosine when the meaning search found
        // it); a meaning hit by the same floors the vector files use, with a term of the lane or a strong cosine.
        const reader = dbReader({ db, config, snapshot, placeId, channel, partnerId, asker, memoryContext });
        const exclusions = historyExclusions({ history, historyRef, context: reader.ctx, channel });
        list.forEach((lane, i) => {
          const plan = plans[i];
          const forms = plan ? [...plan.phrases, ...plan.forms] : [];
          if (forms.length === 0 && !((plan?.who?.length ?? 0) > 0)) return;
          tasks.push(
            task('db', async () => {
              const vector = dbMeaning ? ((await laneVectors.catch(() => null))?.[i] ?? null) : null;
              const found = await timed(
                'record',
                Promise.resolve().then(() =>
                  dbSearch(db, {
                    ctx: reader.ctx,
                    plan: { forms, who: plan?.who, from: null, to: bounded ? until : null },
                    limit: Math.ceil(p.candidates / 4),
                    now: until,
                    vector,
                    settings: { ...dbSettings(config), candidates: p.candidates },
                    exclusions,
                    nameOf,
                    selfName,
                    channelNameOf,
                    allowPlace: reader.allowPlace,
                    model: reader.model,
                  })
                )
              );
              if (signal.aborted) return null;
              const windows = found.windows.map(inTime);
              const shown = new Map<string, Untyped>(
                windows.flatMap((window: Untyped) => window.messages.map((m: Untyped): [string, Untyped] => [m.id, m]))
              );
              const byScore = [...found.hits]
                .filter((hit) => shown.has(hit.messageId))
                .sort((a, b) => b.score - a.score);
              const cosines = vector
                ? new Map(byScore.filter((hit) => hit.cosine !== null).map((hit) => [hit.messageId, hit.cosine]))
                : null;
              const lexical = byScore
                .filter(
                  (hit) =>
                    (hit.streams.includes('words') || hit.streams.includes('trigram')) &&
                    lexicalKeep({ messageId: hit.messageId, terms: hit.terms, phrases: hit.phrases }, cosines, p)
                )
                .map((hit) => hit.messageId);
              const meant = byScore
                .filter(
                  (hit) =>
                    hit.streams.includes('meaning') &&
                    hit.cosine >= p.minMeaningScore &&
                    indexWords(shown.get(hit.messageId).content).length >= MEANING_MIN_WORDS &&
                    (hit.cosine >= p.strongMeaningScore || hit.terms > 0)
                )
                .map((hit) => hit.messageId);
              stats.meaning += meant.length;
              return { lane: lane.kind, windows, lexical, meaning: meant };
            })
          );
        });
      }
      if (tasks.length === 0) return finish('none', { stats: { ...stats, candidates: 0 } });
      const deadline = new Promise((resolve) => {
        // Not unref'd: a turn waits for it, and it is short.
        timer = timers.set(() => resolve(TIMEOUT), p.deadlineMs);
      });
      const outcome = await Promise.race([Promise.all(tasks), deadline]);
      const timedOut = outcome === TIMEOUT;
      if (timedOut) controller.abort();
      const found = [...settled];
      const units = rankPrefetch(found);
      const render = {
        labels: hot.prompts?.labels ?? {},
        timezone: config.bot?.timezone,
        selfName,
        seeReactions: true,
        indexed: false,
      };
      const rendered: Array<Untyped> = [];
      for (const unit of units) {
        if (unit.kind === 'memory') {
          const item = unit.item;
          rendered.push({
            source: 'memory',
            kind: item.kind,
            date: item.date ?? null,
            accountId: item.accountId ?? null,
            who: item.accountId ? nameOf(item.accountId) : null,
            id: item.itemId ?? null,
            lines: item.text,
            text: item.text,
          });
          continue;
        }
        // Only the best hit and the hits close to it are marked, so a long stretch with many hits is cut around them.
        const focus = focusHits(
          unit.window.messages.map((m: Untyped) => m.id),
          unit.hitIds,
          FOCUS_LINES
        );
        const focused = { ...unit.window, hitIds: new Set(focus) };
        const window = typeof decorate === 'function' ? { ...focused, messages: decorate(focused.messages) } : focused;
        window.descriptions = cachedCaptions(config, placeId, [window]);
        const [shown] = renderRecallWindows([window], render);
        const lines = cutStretch(shown?.lines ?? [], p.excerptChars);
        if (lines.length === 0) continue;
        const text = lines.map((line) => line.text).join('\n');
        const ids = lines.map((line) => line.id);
        rendered.push({
          source: 'history',
          placeId: window.placeId,
          channelName: window.channelName ?? null,
          startTs: lines[0].ts,
          endTs: lines[lines.length - 1].ts,
          id: unit.hitIds[0] ?? ids[0],
          ids,
          hitIds: focus.filter((id) => ids.includes(id)),
          lines: text,
          text,
        });
      }
      const excerpts = fitExcerpts(rendered, p).map(({ text, ...excerpt }) => excerpt);
      const extra = {
        excerpts,
        stats: { ...stats, candidates: units.length, stages },
        ...(timedOut ? { partial: true } : {}),
      };
      if (excerpts.length > 0) return finish('ok', extra);
      if (timedOut) return finish('timeout', extra);
      if (stats.failed >= stats.searches) return finish('unavailable', { ...extra, reason: 'failed' });
      return finish('none', extra);
    } catch (err) {
      log.warn('recall: prefetch failed', { channel: conversationId, stage: 'run', name: objOf(err).name ?? null });
      return finish('unavailable', { reason: 'error' });
    } finally {
      if (timer !== null) timers.clear(timer);
    }
  }

  return {
    run: (args) => track('recall.run', () => run(args)),
    available,
    prefetch: (args) => track('recall.prefetch', () => prefetch(args)),
    window,
  };
}
