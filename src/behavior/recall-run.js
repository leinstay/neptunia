// The recall runner: the server part of a lookup. When the lookup classifier
// names word forms, name forms or a date range (src/behavior/recall.js
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
// the partner can view), the daily request cap (`llm.capLeft`), `recall.maxPerDay` runs a day
// (state.json `recallDay`/`recallCount`), and `recall.timeoutMs` for the
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
// index (src/memory/vectors.js search: the guild's, on a private turn the
// partner's private layer and the guild's) within the asked range, else every
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
// (`features.recallTrace`, data/guilds/<id>/recall-trace.jsonl, see traceLine):
// it is memory about real people, kept under data/ only.

import { log } from '../log.js';
import { roleRequestOptions, railReason } from '../llm/openrouter.js';
import { clampChars, oneLine } from '../memory/clamp.js';
import { foldText, liveRecent, recentSettings } from '../memory/recent.js';
import { DAY_MS, bumpDaily, countToday } from '../time.js';
import { audienceCovers } from './elsewhere.ts';
import { audienceAllows, railAudience } from './snapshot.ts';
import { checkPull } from './pull-fetch.ts';
import { roleModel } from '../llm/roles.js';
import { pullPictures } from './pull.js';
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
} from './recall.js';
import { fitExcerpts, focusHits, lanePlan, lexicalKeep, rankPrefetch } from './prefetch.js';
import { indexWords } from '../memory/record-index.js';
import { CODE } from '../tools/codes.ts';
import { dbSettings, quotesOf, search as dbSearch, window as dbWindow } from '../memory/db/recall.js';
import { channelPlaceId, nativeAuthorityOf, personId } from '../memory/db/ids.ts';
import { issueContext } from '../memory/db/scope.ts';
import { LEGACY_IFACE } from '../memory/db/legacy-namespace.ts';
import { hitFrom, inCommunity, linesOf, searchQueryOf, untilAborted } from './recall-reads.ts';

/** The state.json fields of the daily recall counter. */
export const RECALL_DAILY = Object.freeze({ dayKey: 'recallDay', countKey: 'recallCount' });
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
  /**
   * @param {() => void} fn
   * @param {number} ms
   */
  set: (fn, ms) => setTimeout(fn, ms),
  /** @param {ReturnType<typeof setTimeout>} timer */
  clear: (timer) => clearTimeout(timer),
});
// A name form a prefix search of members can match: Latin letters (at least one), digits, `.`, `_`, `'`, `-`, spaces.
const LATIN_FORM_RE = /^[\p{Script=Latin}\p{N} ._'-]+$/u;
const LATIN_LETTER_RE = /\p{Script=Latin}/u;
/** The characters of a stored-memory item's text the trace keeps when the item has no itemId. */
const TRACE_TEXT_CHARS = 120;

/** Whether the parsed server part asks anything. */
function asksServer(server) {
  if (!server || typeof server !== 'object') return false;
  const some = (list) => Array.isArray(list) && list.length > 0;
  return some(server.forms) || some(server.who) || Number.isFinite(server.from) || Number.isFinite(server.to);
}

/**
 * The locator of a run (the options recall.js matchRecord, matchMemory and
 * clusterHits read), or null: only for a server part marked `locator: true`
 * with a finite side of its range.
 */
function locatorOf(server, settings) {
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
function emptyStats() {
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
function numericRevision(meta) {
  return Number.isInteger(meta?.revision) ? meta.revision : null;
}

/**
 * The rows of the meaning searches deduplicated by kind and `meta.id` -- the
 * newest numeric revision wins, else the better score -- best score first, at
 * most `k`.
 */
function dedupeRows(rows, k) {
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
function monthsBack(ms, months) {
  const day = new Date(ms);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth() - (months - 1), 1);
}

/** The last message's time of a window, or -Infinity. */
function windowEnd(window) {
  const messages = window?.messages ?? [];
  return messages.length > 0 && Number.isFinite(messages[messages.length - 1].ts)
    ? messages[messages.length - 1].ts
    : -Infinity;
}

/** An epoch-ms time as an ISO string, or null. */
function isoOf(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * A fresh trace record of one run (`features.recallTrace`), filled as the
 * run goes (clusters, summary) and completed by traceLine.
 */
function newTrace({ started, channelId, candidate, server }) {
  const from = Number.isFinite(server?.from) ? server.from : null;
  const to = Number.isFinite(server?.to) ? server.to : null;
  return {
    at: isoOf(started),
    channelId,
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
function traceItem(item) {
  const itemId = typeof item?.itemId === 'string' && item.itemId ? item.itemId : null;
  return {
    kind: item?.kind ?? null,
    date: item?.date ?? null,
    itemId,
    text: itemId ? null : clampChars(oneLine(item?.text), TRACE_TEXT_CHARS),
    memberId: item?.memberId ?? null,
    self: item?.self === true,
    score: Number.isFinite(item?.score) ? item.score : null,
    // A locator run's slot: the share reserved for content, or the dated one.
    ...(item?.share ? { share: item.share } : {}),
  };
}

/** A record window as the trace keeps it; `kept` false until it joins the windows the summary reads. */
function traceRecordWindow(window) {
  const messages = window?.messages ?? [];
  return {
    channelId: window?.channelId ?? null,
    from: isoOf(messages[0]?.ts),
    to: isoOf(messages[messages.length - 1]?.ts),
    hitIds: [...(window?.hitIds ?? [])],
    kept: false,
    ...(window?.share ? { share: window.share } : {}),
  };
}

/**
 * The trace line of a finished run: `{ at, channelId, triggerId, forms, who,
 * when, hits, inChatDropped, clusters, summary, lookupChars, skipped, people,
 * plan, memory, record }`. `summary` `{ answer, stretch, text, note }`:
 * `answer` `text` | `nothing` | `fallback` (null when no summary was asked
 * or reached), `stretch` null or `{ n, channelId, channelName, lines }` (the
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
 * (traceItem). `record`: `{ channelId, from, to, hitIds, kept }` per record
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
function traceLine(trace, out) {
  const text = typeof out?.text === 'string' ? out.text : null;
  const stretch = out?.stretch ?? null;
  return {
    at: trace.at,
    channelId: trace.channelId,
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
            channelId: stretch.channelId,
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

/** The kind of a failed summary request: `timeout` for a request cut at its limit, else `failed`. */
function summaryFailure(err) {
  return err?.name === 'TimeoutError' ? 'timeout' : 'failed';
}

/**
 * @typedef {object} RecallStretch
 * @property {string} channelId
 * @property {string|null} channelName
 * @property {number} startTs   The time of its first kept line.
 * @property {string} lines     The window rendered without `#n` indices (captions included, matched lines marked),
 *                              cut to `recall.stretchChars` by whole lines from its far ends, never a matched one.
 */

/**
 * The recall runner for the turn (task R2 wires it beside the web search).
 * @param {object} deps
 * @param {{ config: object, prompts: object }} deps.hot  Live config + prompts; read at the moment of use.
 * @param {object} deps.store      `state` (`data`, `markDirty`) and `listUserProfiles` (src/memory/store.js);
 *   read only, when present: `getLore`, `getGuild` (its `learned`), `getRecent`. Never `getPrivate`.
 * @param {object} deps.llm        From createLlm(): `complete`, `capLeft`.
 * @param {import('../interface/reads.ts').Reads} deps.reads  The core's reads of the interface: the message and member
 *   searches and the history windows around a hit.
 * @param {(communityId: unknown, memberId: unknown) => (string|null)} [deps.memberName]  The name the member directory
 *   holds for a member, the last resort for a person no stored profile names.
 * @param {object|null} [deps.describer]  From createDescriber (src/memory/describe.js): only its
 *   `cachedDescriptions` is used, never a fresh caption.
 * @param {{ iterate: Function }|null} [deps.archive]  From createArchive (src/memory/archive.js): only `iterate` is used (read only); without it the archive is not searched.
 * @param {{ iterate: Function }|null} [deps.record]  From createRecord (src/memory/record.js): only `iterate` is used (read only); without it the record is not read.
 * @param {{ search: Function }|null} [deps.vectors]  From createVectors (src/memory/vectors.js): only
 *   `search` is used. Without it (or `deps.embed`) no run searches by meaning.
 * @param {((texts: string[], opts: object) => Promise<Float32Array[]>)|null} [deps.embed]  src/llm/embed.js's `embed`: one call per run that searches by meaning.
 * @param {{ database: () => (object|null) }|null} [deps.memoryDb]  src/memory/db/service.js: the open memory database
 *   (the persona's own search, her window reads and the prefetch).
 * @param {string} [deps.iface]  The interface the persona's ids belong to (`hello.iface`); the legacy namespace without one.
 * @param {() => number} [deps.now]
 * @param {{ set: Function, clear: Function }} [deps.timers]  setTimeout / clearTimeout (tests inject fakes).
 * @returns {{ run: (args: { guildId?: string, channel: object, partnerId?: string|null, snapshot?: object|null, selfId: string, selfName: string,
 *   history?: object[], candidate: { authorName?: string, content?: string }, server: { forms: string[], who: string[],
 *   from: number|null, to: number|null, recent?: true, locator?: true }|null }) => Promise<{ text: string|null, stretch: RecallStretch|null,
 *   people: { id: string, name: string, username: string, count: number, newestTs: number|null }[], stats: object }>,
 *   available: () => boolean, prefetch: (args: object) => Promise<object|null>, window: (args: object) => Promise<object> }}
 *   `prefetch`: the automatic memory prefetch of a turn of the tool loop (see there); `window`: a window read over the memory database.
 */
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
}) {
  /** Whether `llm.maxRequestsPerDay` is spent today: the summary would be refused. */
  function capSpent() {
    return typeof llm?.capLeft === 'function' && llm.capLeft() <= 0;
  }
  /** The summary prompt, or null when it is missing or blank. */
  function summaryPrompt() {
    const prompt = hot.prompts?.['recall-summary'];
    return typeof prompt === 'string' && prompt.trim() ? prompt : null;
  }

  /** Whether `recall.maxPerDay` runs are spent today (read only). */
  function dailySpent(settings) {
    return countToday(store.state.data, RECALL_DAILY, now()) >= settings.maxPerDay;
  }

  /**
   * Whether a run could search now: the switch on, the summary prompt
   * present, the daily request cap and `recall.maxPerDay` not spent. Read
   * only; for a caller deciding whether to ask for the server part at all.
   * @returns {boolean}
   */
  function available() {
    try {
      const settings = recallSettings(hot.config);
      return Boolean(settings) && summaryPrompt() !== null && !capSpent() && !dailySpent(settings);
    } catch {
      return false;
    }
  }

  /**
   * The people the `who` forms point at, at most `maxPeople`: per form, the
   * stored profiles one of whose names or alias names equals the whole form
   * (both folded, src/memory/recent.js#foldText), the persona's own profile
   * never; then -- for a Latin form no profile matched -- the interface's member
   * search (prefix match), other bots left out. A member search is not sent
   * once `searchUntil` is past; `beforeRequest` runs before each one.
   * `via` (an optional Map) gets, per member found, `{ form, how }`: `how`
   * `stored` or `member-search`.
   */
  async function findPeople({ guildId, who, maxPeople, selfId, signal, searchUntil, beforeRequest, via = null }) {
    const found = new Map();
    if (maxPeople <= 0 || !Array.isArray(who) || who.length === 0) return [];
    let profiles = null;
    for (const form of who) {
      if (found.size >= maxPeople || signal.aborted) break;
      profiles ??= store.listUserProfiles?.(guildId) ?? [];
      let matched = false;
      const folded = foldText(form);
      for (const profile of profiles) {
        if (!profile?.id) continue;
        const names = [
          ...(Array.isArray(profile.names) ? profile.names : []),
          ...(Array.isArray(profile.aliases) ? profile.aliases : []).map((a) => a?.name),
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
      beforeRequest();
      const searched = await untilAborted(
        signal,
        reads.searchMembers({ communityId: guildId }, { prefix: form, limit: maxPeople })
      );
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
   * (src/behavior/turn.js recentInput, server side). In a private chat: from
   * a channel its `partnerId` can view (the pull rail's private-chat rule,
   * src/behavior/snapshot.ts#audienceAllows), as its hits are.
   */
  function shownRecentLines(config, snapshot, guildId, channel, partnerId) {
    const settings = recentSettings(config);
    if (!settings || typeof store.getRecent !== 'function') return [];
    const lines = liveRecent(store.getRecent(guildId)?.lines, { now: now(), hours: settings.hours });
    if (lines.length === 0) return [];
    const here = inCommunity(channel) ? railAudience(/** @type {object|null|undefined} */ (channel.audience)) : null;
    const covers = (source) =>
      inCommunity(channel)
        ? audienceCovers(here, railAudience(/** @type {object|null|undefined} */ (source?.audience)))
        : audienceAllows(/** @type {object} */ (channel), /** @type {object} */ (source), config, {
            partnerId,
          });
    const allowed = new Map();
    const shown = (id) => {
      if (typeof id !== 'string' || !id) return false;
      if (id === channel.id) return true;
      if (!allowed.has(id)) allowed.set(id, covers(snapshot?.get(id) ?? null));
      return allowed.get(id);
    };
    return lines.filter((line) => shown(line.channelId));
  }

  /**
   * The stored memory the forms point at (recall.js matchMemory), at most
   * `recall.memoryItems`, with the display names of the stored members, or
   * no item. Read-only store calls, no request. The gates are the reply
   * prompt's: nothing with `features.memory` off; members' moments with
   * `features.episodes` on, lore with `features.lore` on, learned items with
   * memory on (all three guild-wide), recent lines by shownRecentLines. A
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
  async function storedMemory({
    config,
    settings,
    snapshot,
    guildId,
    channel,
    partnerId,
    server,
    recent,
    allowEntry,
    privateUserId,
    signal,
    meaning = [],
    locator = null,
    source = archive,
  }) {
    const none = { items: [], nameOf: () => null };
    const forms = Array.isArray(server.forms) ? server.forms : [];
    const who = Array.isArray(server.who) ? server.who : [];
    if (
      settings.memoryItems <= 0 ||
      config.features?.memory === false ||
      (forms.length === 0 && who.length === 0 && meaning.length === 0)
    )
      return none;
    try {
      const features = config.features ?? {};
      const profiles = typeof store.listUserProfiles === 'function' ? (store.listUserProfiles(guildId) ?? []) : [];
      const names = new Map(
        profiles.filter((p) => p?.id).map((p) => [String(p.id), typeof p.names?.[0] === 'string' ? p.names[0] : null])
      );
      const ranged = Number.isFinite(server.from) || Number.isFinite(server.to);
      // A locator bounds no item: it only ranks (matchMemory's `locator`).
      const bounds = locator ? { from: null, to: null } : { from: server.from ?? null, to: server.to ?? null };
      const switchedOff = new Set([
        ...(features.episodes === false ? ['episode'] : []),
        ...(features.recent === false ? ['recent'] : []),
        ...(features.participation === false ? ['participation'] : []),
      ]);
      const allow = (entry) => !switchedOff.has(entry?.itemKind) && allowEntry(entry);
      // Entries are recorded after what they observed: the months from `from` on, the private archive after the guild's.
      const stream = (query) =>
        (async function* () {
          yield* source.iterate(guildId, query);
          if (privateUserId) yield* source.iterate(guildId, { ...query, privateUserId });
        })();
      let archived = [];
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
          log.warn('recall: archive failed', { channel: channel.id, name: err?.name ?? null });
        }
      }
      let meant = [];
      if (typeof source?.iterate === 'function' && meaning.length > 0) {
        const rank = new Map(meaning.map((row, i) => [row.id, i]));
        const times = meaning.map((row) => Date.parse(row.occurredAt)).filter(Number.isFinite);
        const newest = new Map();
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
          meant = [...newest.values()].sort((a, b) => rank.get(a.itemId) - rank.get(b.itemId));
        } catch (err) {
          log.warn('recall: archive failed', { channel: channel.id, name: err?.name ?? null });
        }
      }
      const items = matchMemory({
        forms,
        who,
        profiles: features.episodes !== false ? profiles : profiles.map((p) => ({ ...p, episodes: [] })),
        lore: features.lore !== false && typeof store.getLore === 'function' ? (store.getLore(guildId) ?? []) : [],
        learned: typeof store.getGuild === 'function' ? (store.getGuild(guildId)?.learned ?? []) : [],
        recentLines: shownRecentLines(config, snapshot, guildId, channel, partnerId),
        archived,
        meaning: meant,
        from: bounds.from,
        to: bounds.to,
        max: settings.memoryItems,
        timezone: config.bot?.timezone,
        recent,
        locator,
      });
      return { items, nameOf: (id) => names.get(String(id)) ?? null };
    } catch (err) {
      log.warn('recall: memory failed', { channel: channel.id, name: err?.name ?? null });
      return none;
    }
  }

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
   * the guild's. At most `recall.maxClusters` windows. A read that throws
   * logs `recall: record failed` and gives none. `meaning`: the record rows
   * the meaning search kept, best first, for matchRecord's `meaning` (read
   * and fused there; with `recall.recordDays` 0 they alone are read).
   * `locator` (locatorOf): read as a dateless question plus the locator's own
   * days, the windows kept by matchRecord's locator rule.
   */
  async function recordWindowsFor({
    settings,
    snapshot,
    guildId,
    server,
    people,
    recent,
    allowLine,
    privateUserId,
    ownIds,
    selfName,
    signal,
    channelId,
    meaning = [],
    locator = null,
  }) {
    if (typeof record?.iterate !== 'function' || (settings.recordDays <= 0 && meaning.length === 0)) return [];
    try {
      const profiles = typeof store.listUserProfiles === 'function' ? (store.listUserProfiles(guildId) ?? []) : [];
      const ids = new Set(people.map((p) => String(p.id)));
      const stored = new Map(profiles.filter((p) => p?.id).map((p) => [String(p.id), p]));
      const aliases = [...ids].flatMap((id) => {
        const profile = stored.get(id);
        if (!profile) return [];
        return [
          ...(Array.isArray(profile.names) ? profile.names : []),
          ...(Array.isArray(profile.aliases) ? profile.aliases : []).map((a) => a?.name),
        ].filter((name) => typeof name === 'string' && name);
      });
      const source = {
        async *iterate(id, query) {
          yield* record.iterate(id, query);
          if (privateUserId) yield* record.iterate(id, { ...query, privateUserId });
        },
      };
      const found = await matchRecord(guildId, {
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
            memberName(guildId, String(id)) ??
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
      log.warn('recall: record failed', { channel: channelId, name: err?.name ?? null });
      return [];
    }
  }

  /**
   * The meaning search of a run, or null when it does not search by meaning
   * (`features.meaningSearch` not exactly true, no `deps.vectors` /
   * `deps.embed`, `recall.meaningCandidates` 0, or a message without text).
   * One embedding of meaningQuery (the asker's message `candidate`, with
   * `recall.meaningWithReply` the line it replies to among `lines` before it),
   * then `vectors.search` within `server.from/to` (every month without a
   * range or with a `locator`), `recall.meaningCandidates` rows: the guild index, rows of a
   * channel `sourceOf` refuses or of the visible chat (`ownIds`) left out (an
   * archive row is judged by its entry later); on a private turn the
   * partner's private layer too. The rows deduplicated (dedupeRows), split
   * into `record` (`{ id, channelId, occurredAt, sourceIds }`) and `archive`
   * (`{ id, occurredAt }`), best first. `trace` is the run's trace entry
   * (see traceLine). A failed embedding or search logs `recall: meaning
   * failed` (`stage` `embed` | `search`, counts and codes only) and gives no
   * row.
   */
  async function meaningSearch({
    config,
    settings,
    guildId,
    channel,
    candidate,
    lines,
    server,
    privateUserId,
    sourceOf,
    ownIds,
    signal,
    locator = null,
  }) {
    if (
      config.features?.meaningSearch !== true ||
      typeof embed !== 'function' ||
      typeof vectors?.search !== 'function' ||
      settings.meaningCandidates <= 0
    )
      return null;
    const profiles = typeof store.listUserProfiles === 'function' ? (store.listUserProfiles(guildId) ?? []) : [];
    const stored = new Map(
      profiles.filter((p) => p?.id).map((p) => [String(p.id), typeof p.names?.[0] === 'string' ? p.names[0] : null])
    );
    const nameOf = (id) => stored.get(String(id)) ?? memberName(guildId, String(id)) ?? null;
    const query = meaningQuery({ candidate, lines, withReply: settings.meaningWithReply, nameOf });
    if (!query) return null;
    const started = now();
    const trace = { query: query.form, candidates: 0, kept: [], ms: 0 };
    const out = { record: [], archive: [], trace, degraded: false };
    const failed = (stage, err) => {
      out.degraded = true;
      log.warn('recall: meaning failed', {
        channel: channel.id,
        stage,
        reason: railReason(err, `${stage}-error`),
        status: err?.statusCode ?? null,
        name: err?.name ?? null,
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
    const unseen = (meta) => meta?.kind === 'archive' || !ownIds.has(meta?.id);
    const shared = (meta) =>
      unseen(meta) &&
      (meta?.kind === 'archive' || (typeof meta?.channelId === 'string' && sourceOf(meta.channelId) !== null));
    let rows;
    try {
      rows = await vectors.search(guildId, vector, { ...range, k, filter: shared });
      if (privateUserId)
        rows = [...rows, ...(await vectors.search(guildId, vector, { ...range, k, filter: unseen, privateUserId }))];
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
          channelId: meta.channelId,
          occurredAt: meta.occurredAt,
          sourceIds: Array.isArray(meta.sourceIds) ? meta.sourceIds : [],
        });
    }
    return out;
  }

  /**
   * The run's trace line appended to data/guilds/<guildId>/recall-trace.jsonl
   * (store.appendRecallTrace, capped at `maxLines`); nothing without that
   * store call. A write that throws logs `recall: trace failed` and costs the
   * run nothing.
   */
  function writeTrace({ guildId, channelId, trace, out, maxLines }) {
    if (typeof store.appendRecallTrace !== 'function' || !guildId) return;
    try {
      store.appendRecallTrace(guildId, traceLine(trace, out), { maxLines });
    } catch (err) {
      log.warn('recall: trace failed', { channel: channelId, name: err?.name ?? null });
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
  function broadQuery(plan, locator, settings) {
    const first = plan[0];
    if (!locator || !first || first.kind === 'range') return null;
    const recordStart =
      typeof record?.iterate === 'function' && settings.recordDays > 0 ? now() - settings.recordDays * DAY_MS : null;
    const margin = Number.isFinite(locator.from) ? locator.from - settings.locatorDecayDays * DAY_MS : -Infinity;
    if (recordStart !== null && recordStart <= margin) return null;
    return { ...first, after: null, before: recordStart, broad: true };
  }

  /** The cached captions of the windows' pictures and custom emoji, or undefined (cache only, never a request). */
  function cachedCaptions(config, guildId, windows) {
    if (config.features?.mediaDescriptions !== true || typeof describer?.cachedDescriptions !== 'function')
      return undefined;
    const { items, rest, emoji } = pullPictures(
      windows.flatMap((w) => w.messages),
      0
    );
    const wanted = [...items, ...rest, ...emoji];
    if (wanted.length === 0) return undefined;
    try {
      return describer.cachedDescriptions(guildId, wanted) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * What a run may read toward `channel` (the turn's; a private chat on behalf of `partnerId`):
   * `sourceOf(channelId)`, the pull rail's verdict judged once per channel (`judged`): the
   * channel when its lines may reach this turn, else null -- search hits, record lines, archived
   * items and meaning rows of a refused channel never reach the turn; `privateUserId`, the partner
   * of a private chat (else null): a private entry or line is its member's alone, read only on a
   * private turn with that member; `allowEntry` (an archive entry, by its `scope`) and
   * `allowLine` (a record line: a channel line by its channel, a private one by its member).
   */
  function scopeOf({ config, snapshot, channel, partnerId }) {
    const judged = new Map();
    const sourceOf = (id) => {
      if (!judged.has(id)) {
        let source = null;
        try {
          const verdict = checkPull({ snapshot, channelId: id, destination: channel, partnerId, config, now: now() });
          source = verdict.skip === null ? verdict.channel : null;
        } catch {
          source = null;
        }
        judged.set(id, source);
      }
      return judged.get(id);
    };
    const privateUserId = !inCommunity(channel) && typeof partnerId === 'string' && partnerId ? partnerId : null;
    const allowScope = (scope) => {
      if (scope?.private === true) return privateUserId !== null && scope.user === privateUserId;
      return typeof scope?.channel !== 'string' || sourceOf(scope.channel) !== null;
    };
    const allowEntry = (entry) => allowScope(entry?.scope);
    const allowLine = (line) =>
      line?.scope?.private === true
        ? allowScope(line.scope)
        : typeof line?.scope?.channel === 'string' && allowScope(line.scope);
    return { judged, sourceOf, privateUserId, allowEntry, allowLine };
  }

  /**
   * The memory database to read, or null while it is not open (memoryDb.database()). Read at the moment of use.
   */
  function dbOf() {
    try {
      return typeof memoryDb?.database === 'function' ? (memoryDb.database() ?? null) : null;
    } catch {
      return null;
    }
  }

  /**
   * What a db read needs of a turn: the read context, the pull rail for places, the names. `asker` is the user id of
   * the person who asked (the trigger's author): the context carries their person id, and the hidden-DM marker is set
   * only for a private chat of that person. `model` is the embedding model the question's vector comes from.
   * The context is the turn's own (`memoryContext`: the one context the turn runner issued for the turn, taken when it
   * is the context this read would be issued, a DM of the same partner or a group read) or, without one, issued by the
   * core (memoryDb.issueContext records it; without the service it is the pure object): it has an id, names the DM
   * place of a private chat, and reads through `audience_id` when `memoryDb.audienceColumn`.
   * `allowPlace` reads the place's row of the database `db`: a DM place of the context's interface is the private
   * chat's own (the context decides whose); a group place is shown only where the pull rail lets this turn read its
   * channel; a place the database does not hold, or of another authority, is refused.
   */
  function dbReader({ db = null, config, snapshot, guildId, channel, partnerId, asker = null, memoryContext = null }) {
    const { sourceOf, privateUserId } = scopeOf({ config, snapshot, channel, partnerId });
    const profiles = typeof store.listUserProfiles === 'function' ? (store.listUserProfiles(guildId) ?? []) : [];
    const stored = new Map(profiles.filter((profile) => profile?.id).map((profile) => [String(profile.id), profile]));
    const nameOf = (id) => {
      const name = stored.get(String(id))?.names?.[0];
      return (typeof name === 'string' && name ? name : null) ?? memberName(guildId, String(id)) ?? null;
    };
    const ctx = readContext({ config, channel, privateUserId, asker, memoryContext });
    return {
      sourceOf,
      nameOf,
      ctx,
      model: roleModel(config, 'embedding', 'recall-query') ?? null,
      channelNameOf: (id) => snapshot?.get(id)?.name ?? null,
      allowPlace: placeRule(db, ctx, sourceOf),
    };
  }

  /** The place rule of a db read (see dbReader): one lookup per place, kept for the read. */
  function placeRule(db, ctx, sourceOf) {
    const authority = nativeAuthorityOf(ctx?.iface ?? null);
    const judged = new Map();
    let statement = null;
    return (placeId) => {
      const id = String(placeId ?? '');
      if (judged.has(id)) return judged.get(id);
      let allowed = false;
      try {
        statement ??=
          db?.prepare('SELECT kind, native_id, native_key, conversation, authority_id FROM places WHERE id = ?') ??
          null;
        const row = id ? statement?.get(id) : null;
        if (row && row.authority_id === authority) {
          if (row.conversation === 'dm') allowed = true;
          else if (row.conversation === 'group') {
            // The channel of the place, as its native key names it (`<kind>:<channel id>`).
            const native =
              typeof row.native_key === 'string' && row.native_key.includes(':')
                ? row.native_key.slice(row.native_key.indexOf(':') + 1)
                : row.native_id;
            allowed = typeof native === 'string' && native !== '' && sourceOf(native) !== null;
          }
        }
      } catch {
        allowed = false;
      }
      judged.set(id, allowed);
      return allowed;
    };
  }

  /**
   * The read context of a db read (see dbReader): the turn's own when it fits, else one issued for this read.
   * The turn's context fits a private chat when it is a DM of the same partner, a server read when it is a group read.
   */
  function readContext({ config, channel, privateUserId, asker, memoryContext = null }) {
    const spec = privateUserId
      ? { kind: 'dm', person: personId(iface, privateUserId) }
      : { kind: 'group', destination: channel?.id ? channelPlaceId(iface, channel.id) : null };
    const fits =
      memoryContext &&
      typeof memoryContext === 'object' &&
      typeof memoryContext.id === 'string' &&
      (privateUserId
        ? memoryContext.kind === 'dm' && memoryContext.person === spec.person
        : memoryContext.kind === 'group');
    const issued = fits
      ? memoryContext
      : typeof memoryDb?.issueContext === 'function'
        ? memoryDb.issueContext(spec)
        : issueContext({ iface, ...spec, now, audienceColumn: config?.memoryDb?.audienceColumn === true });
    return privateUserId || !asker ? issued : { ...issued, asker: [personId(iface, String(asker))] };
  }

  /** The stretches of db windows as `recall.run` returns them (decorated, captioned from the cache only, cut to `recall.stretchChars`). */
  function dbQuotes({ config, settings, guildId, selfName, windows, decorate }) {
    const shown = windows.map((window) =>
      typeof decorate === 'function' ? { ...window, messages: decorate(window.messages) } : window
    );
    const descriptions = cachedCaptions(config, guildId, shown);
    for (const window of shown) window.descriptions = descriptions;
    const render = {
      labels: hot.prompts.labels,
      timezone: config.bot?.timezone,
      selfName,
      gapMinutes: config.context?.gapMarkerMinutes,
      maxChars: config.context?.maxMessageChars ?? 2000,
      seeReactions: config.features?.seeReactions !== false,
      reactionsPerMessage: config.context?.reactionsPerMessage,
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
    guildId,
    channel,
    partnerId,
    selfName,
    history,
    candidate,
    server,
    decorate,
    started,
    memoryContext = null,
  }) {
    const stats = emptyStats();
    const reader = dbReader({
      db,
      config,
      snapshot,
      guildId,
      channel,
      partnerId,
      asker: candidate?.authorId ?? null,
      memoryContext,
    });
    if (server?.channelId && reader.sourceOf(server.channelId) === null)
      return {
        text: null,
        stretch: null,
        people: [],
        stats: { ...stats, ms: now() - started },
        outcome: { kind: 'not-visible' },
      };
    let vector = null;
    let degraded = false;
    if (config.features?.meaningSearch === true && typeof embed === 'function' && settings.meaningCandidates > 0) {
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
          log.warn('recall: meaning failed', { channel: channel.id, stage: 'embed', name: err?.name ?? null });
        } finally {
          timers.clear(timer);
        }
      }
    }
    const own = inCommunity(channel) && Array.isArray(history) ? history.filter((m) => m?.id).map((m) => m.id) : [];
    const found = dbSearch(db, {
      ctx: reader.ctx,
      plan: server,
      limit: settings.maxClusters,
      now: now(),
      vector,
      settings: dbSettings(config),
      exclude: new Set(own),
      nameOf: reader.nameOf,
      selfName,
      channelNameOf: reader.channelNameOf,
      allowPlace: reader.allowPlace,
      model: reader.model,
    });
    stats.hits = found.hits.length;
    stats.meaning = found.stats.meaning;
    stats.windows = found.windows.length;
    const quotes = dbQuotes({ config, settings, guildId, selfName, windows: found.windows, decorate });
    stats.kept = quotes.length;
    stats.summary = 'quotes';
    log.info('recall: quoted', {
      channel: channel.id,
      windows: found.windows.length,
      quoted: quotes.length,
      hidden: found.hidden,
      totalMs: now() - started,
    });
    // `hitIds`: the messages the search matched (tools/recall-eval.mjs scores them); the persona's tool ignores it.
    return {
      text: null,
      stretch: null,
      quotes,
      hidden: found.hidden === true,
      hitIds: found.hits.map((hit) => hit.messageId),
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
    guildId = null,
    snapshot = null,
    channel,
    partnerId = null,
    selfName = '',
    history = [],
    anchor,
    move = 'up',
    messages = null,
    minutes = null,
    decorate = null,
    asker = null,
    memoryContext = null,
  } = {}) {
    const started = now();
    const stats = emptyStats();
    const out = (extra) => ({
      text: null,
      stretch: null,
      people: [],
      stats: { ...stats, ms: now() - started },
      ...extra,
    });
    try {
      const config = hot.config;
      const settings = recallSettings(config);
      const db = dbOf();
      if (!settings || !db) return out({ outcome: { kind: 'not-configured' } });
      if (!guildId || (!inCommunity(channel) && !partnerId)) return out({ outcome: { kind: 'not-configured' } });
      const reader = dbReader({ db, config, snapshot, guildId, channel, partnerId, asker, memoryContext });
      const own = inCommunity(channel) && Array.isArray(history) ? history.filter((m) => m?.id).map((m) => m.id) : [];
      const found = dbWindow(db, {
        ctx: reader.ctx,
        anchor,
        move,
        messages,
        minutes,
        settings: dbSettings(config),
        nameOf: reader.nameOf,
        selfName,
        channelNameOf: reader.channelNameOf,
        exclude: new Set(own),
        allowPlace: reader.allowPlace,
      });
      if (found.unknown) return out({ outcome: { kind: 'unknown-anchor' } });
      const quotes = dbQuotes({ config, settings, guildId, selfName, windows: found.windows, decorate });
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
        name: err?.name ?? null,
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
    guildId,
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
  }) {
    const channelId = channel.id;
    const searchUntil = started + settings.timeoutMs * SEARCH_SHARE;
    let counted = false;
    const beforeRequest = () => {
      if (counted) return;
      counted = true;
      bumpDaily(store.state.data, RECALL_DAILY, now());
      store.state.markDirty();
    };
    const result = (extra = {}) => ({
      text: null,
      stretch: null,
      people: [],
      stats: { ...stats, ms: now() - started },
      ...extra,
    });

    // The pull rail toward this turn's channel and the private-owner rule (scopeOf).
    const scope = scopeOf({ config, snapshot, channel, partnerId });
    const { judged, sourceOf, privateUserId, allowEntry, allowLine } = scope;
    const recent = isRecentCue(server, { now: now(), recordDays: settings.recordDays });
    // A `when:` that only locates the event: it ranks, it bounds no local source (locatorOf).
    const locator = locatorOf(server, settings);
    // The turn's own chat: its lines are dropped by id from every source (a private chat is not part of
    // the server: it drops nothing).
    const own = inCommunity(channel) && Array.isArray(history) ? history.filter((m) => m?.id) : [];
    const ownIds = new Set(own.map((m) => m.id));

    // 0a. Meaning (features.meaningSearch): one embedding, the vector index; a failure leaves words only.
    const chatLines = [...(Array.isArray(history) ? history : []), ...(Array.isArray(context) ? context : [])];
    const meaning = await meaningSearch({
      config,
      settings,
      guildId,
      channel,
      candidate,
      lines: chatLines,
      server,
      privateUserId,
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
      guildId,
      channel,
      partnerId,
      server,
      recent,
      allowEntry,
      privateUserId,
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
      guildId,
      who: server.who ?? [],
      maxPeople: settings.maxPeople,
      selfId,
      signal: searchSignal,
      searchUntil,
      beforeRequest,
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
      memberIds: people.map((p) => p.id),
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
      guildId,
      server,
      people,
      recent,
      allowLine,
      privateUserId,
      ownIds,
      selfName,
      signal,
      channelId,
      meaning: meaning?.record ?? [],
      locator,
    });
    if (signal.aborted) return null;
    took.recordMs = now() - stepAt;
    const recordTrace = new Map(recordWindows.map((window) => [window, traceRecordWindow(window)]));
    if (trace) trace.record = [...recordTrace.values()];
    if (plan.length === 0 && memory.items.length === 0 && recordWindows.length === 0) {
      log.info('recall: skipped', { channel: channelId, reason: 'no-query' });
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
    const tracePlanned = (query) => {
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
      beforeRequest();
      const page = await untilAborted(
        searchSignal,
        reads.searchMessages({ communityId: guildId }, searchQueryOf(query))
      );
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
      (hit) => Number.isFinite(hit.ts) && !(hit.bot && hit.authorId !== selfId) && sourceOf(hit.channelId) !== null
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
    const followOf = async (source, messages) => {
      const last = messages[messages.length - 1];
      if (settings.followMessages <= 0 || !last || ownIds.has(last.id)) return [];
      const after = await linesOf(reads, source, { after: last.id, limit: settings.followMessages });
      return after ? followConversation(last.ts, after, settings) : [];
    };
    const fetched = await Promise.all(
      candidates.map(async (cluster) => {
        const source = judged.get(cluster.channelId);
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
            channelId: cluster.channelId,
            channelName: source.name ?? null,
            messages: shown,
            hitIds: cluster.ids,
            overlapsChat: marked.overlapsChat,
          },
        };
      })
    );
    if (signal.aborted) return null;
    const ready = fetched.filter(Boolean);
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
          channelId: cluster.channelId,
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
      if (!window.messages.some((m) => !shownIds.has(m.id))) continue;
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
    const descriptions = cachedCaptions(config, guildId, windows);
    for (const window of windows) window.descriptions = descriptions;
    log.info('recall: searched', {
      channel: channelId,
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
      gapMinutes: config.context?.gapMarkerMinutes,
      maxChars: config.context?.maxMessageChars ?? 2000,
      seeReactions: config.features?.seeReactions !== false,
      reactionsPerMessage: config.context?.reactionsPerMessage,
    };
    /** One window as a stretch (no indices, cut to `recall.stretchChars`), or null. */
    const stretchOf = (window) => {
      if (!window || settings.stretchChars <= 0) return null;
      const [shown] = renderRecallWindows([window], { ...render, indexed: false });
      const lines = cutStretch(shown?.lines ?? [], settings.stretchChars);
      if (lines.length === 0) return null;
      // `entries`: each line's message (its id, author, whether it is hers, the message itself), for the handles of a memory.search result.
      const byId = new Map(window.messages.map((message) => [message.id, message]));
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
        channelId: window.channelId,
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
            selfName,
            question: candidate ?? {},
            people,
            windows,
            memory: memory.items,
            // The chat lines before the question: what the question refers to.
            context: recallContext(Array.isArray(context) ? context : history, candidate, settings.contextMessages),
            contextDescriptions,
            replyQuoteChars: config.context?.replyQuoteChars,
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
      log.info('recall: skipped', { channel: channelId, reason: 'no-hits' });
      if (trace) trace.skipped = 'no-hits';
      return result({ people: peopleOut() });
    }
    // Without a summary the search still answers: the first-ranked window verbatim, no text
    // (stored memory alone gives nothing then: its items are notes, not chat).
    let asked = null;
    const fallback = (kind) => {
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
        channel: channelId,
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
    // A run on stored memory alone sent no search request: its summary is what counts it.
    beforeRequest();
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
        channel: channelId,
        reason: railReason(err),
        status: err?.statusCode ?? null,
        name: err?.name ?? null,
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
      channel: channelId,
      ms: now() - asked,
      totalMs: now() - started,
      answer: answer.text ? 'text' : 'nothing',
      stretch: stretch !== null,
    });
    return result({ text: answer.text, stretch, people: peopleOut() });
  }

  /**
   * One server search for a turn. Per call, with `hot.config` / `hot.prompts`
   * read at that moment: nothing (no log) with `features.recall` off; `recall:
   * skipped` with `reason` `private-chat` (no guild, or a channel without a
   * guild and no `partner`: a private chat searches only on behalf of its
   * partner, the member of `guild` it talks to, keeping the
   * hits of channels that member can view and not bounded by its own chat),
   * `no-query` (no form, name form or range), `no-prompt` (no
   * `prompts['recall-summary']`), `daily-cap` (`llm.capLeft()` spent) or
   * `daily` (`recall.maxPerDay` runs today), each before any request; later
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
   * summary` carries `totalMs`, the run's time so far). The first
   * request of a run (a message search, or the summary of a run on memory
   * alone) bumps `recallDay`/`recallCount` once. Never rejects: a failure logs `recall:
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
   * `skipped`; a private chat without a guild has nowhere to write it. `op` (optional, a journal operation: src/memory/journal.js#op,
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
   * `daily-cap` (a daily limit spent: `llm.capLeft()` or `recall.maxPerDay`), `timeout`
   * (`recall.timeoutMs` ran out, no fallback), `error` (a throw) or, with `quotes`, `not-configured`,
   * `not-visible` (the `server.channelId` named is hidden by the pull rail) and `searched` (`degraded`, `failed`, `total`).
   * `decorate` (optional; the turn's call marks, src/behavior/turn.js#linkCalls) takes each
   * window's messages once they are read and gives the ones rendered, so the persona's lines
   * there show what she called like her chat lines do. `memoryContext` (optional) is the turn's
   * execution context (src/memory/db/service.js#issueContext): the database reads use it when it
   * fits the read (see dbReader), so the reads of one turn carry one context id.
   */
  async function run({
    guildId = null,
    snapshot = null,
    channel,
    partnerId = null,
    selfId,
    selfName,
    history = [],
    context = null,
    contextDescriptions,
    candidate = null,
    server = null,
    op = null,
    decorate = null,
    quotes = false,
    memoryContext = null,
  } = {}) {
    const started = now();
    const channelId = channel?.id ?? null;
    const stats = emptyStats();
    const empty = (extra = {}) => ({
      text: null,
      stretch: null,
      people: [],
      stats: { ...stats, ms: now() - started },
      ...extra,
    });
    let trace = null;
    let traceMaxLines = null;
    const skip = (reason) => {
      log.info('recall: skipped', { channel: channelId, reason });
      if (trace) trace.skipped = reason;
      // The daily limits are named to the persona's own search (`outcome`); other gates are no news to her.
      return finish(empty(reason === 'daily-cap' || reason === 'daily' ? { outcome: { kind: 'daily-cap' } } : {}));
    };
    let controller = null;
    let timer = null;
    let cut = null;
    const finish = (out) => {
      if (trace) writeTrace({ guildId, channelId, trace, out, maxLines: traceMaxLines });
      return out;
    };
    // The journal's closing line of a run that started (`op`): what it found, never the text.
    const opResult = (out, status) => ({
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
      if (config.features?.recallTrace === true) {
        trace = newTrace({ started, channelId, candidate, server });
        traceMaxLines = settings.traceMaxLines;
      }
      if (!guildId || (!inCommunity(channel) && !partnerId)) return skip('private-chat');
      if (!asksServer(server)) return skip('no-query');
      const prompt = summaryPrompt();
      if (!prompt && !quotes) return skip('no-prompt');
      if (capSpent()) return skip('daily-cap');
      if (dailySpent(settings)) return skip('daily');
      if (op) await op.started();

      // The persona's own search over the memory database: no message search, no summary.
      if (quotes) {
        const db = dbOf();
        if (!db) {
          if (op) await op.failed(CODE.NOT_CONFIGURED);
          return finish(empty({ outcome: { kind: 'not-configured' } }));
        }
        const found = await runDbQuotes({
          db,
          config,
          settings,
          snapshot,
          guildId,
          channel,
          partnerId,
          selfName,
          history,
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

      controller = new AbortController();
      const searching = new AbortController();
      controller.signal.addEventListener('abort', () => searching.abort(), { once: true });
      const deadline = new Promise((resolve) => {
        timer = timers.set(() => resolve(TIMEOUT), settings.timeoutMs);
        timer?.unref?.();
      });
      cut = timers.set(() => searching.abort(), Math.floor(settings.timeoutMs * PREPARE_SHARE));
      cut?.unref?.();
      const progress = { fallback: null };
      const work = recallWith({
        config,
        settings,
        prompt,
        snapshot,
        guildId,
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
        log.warn('recall: failed', { channel: channelId, reason: 'timeout', status: null, name: null });
        const fallen = progress.fallback ? progress.fallback('timeout') : null;
        if (op) await (fallen ? op.succeeded(opResult(fallen, 'timeout')) : op.failed(CODE.TIMEOUT));
        return finish(fallen ?? empty({ outcome: { kind: 'timeout' } }));
      }
      const out = outcome ?? empty();
      if (op) await op.succeeded(opResult(out, 'ok'));
      return finish(out);
    } catch (err) {
      controller?.abort();
      log.warn('recall: failed', { channel: channelId, reason: 'error', status: null, name: err?.name ?? null });
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
  function sharedSource(source) {
    if (typeof source?.iterate !== 'function') return null;
    const reads = new Map();
    return {
      async *iterate(id, query = {}) {
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

  /**
   * The automatic memory prefetch of a turn (src/behavior/prefetch.js; features.coreTools with
   * features.memoryPrefetch, decided by the caller): no model request but one embedding, no
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
   * deadline passed before anything relevant settled) or `unavailable` (no guild to read on behalf
   * of, or every search failed); `basis` the lane kinds; each excerpt `{ source: 'history',
   * channelId, channelName, startTs, endTs, id, ids, hitIds, lines }` or `{ source: 'memory', kind,
   * date, memberId, who, id, lines }`; `partial` true when the deadline cut some searches. Logs
   * `recall: prefetched` (counts and codes only). Never rejects.
   * @param {{ guild: object, guildId?: string, channel: object, partner?: object|null, selfId: string, selfName: string,
   *   history?: object[], lanes: { kind: string, text: string, words: string }[], at?: number|null,
   *   decorate?: ((messages: object[]) => object[])|null }} input
   * @returns {Promise<object|null>}
   */
  async function prefetch({
    guildId = null,
    snapshot = null,
    channel,
    partnerId = null,
    selfId,
    selfName,
    history = [],
    lanes = [],
    at = null,
    decorate = null,
    asker = null,
    memoryContext = null,
  } = {}) {
    const started = now();
    const list = Array.isArray(lanes) ? lanes.filter((lane) => lane && typeof lane.kind === 'string') : [];
    const basis = list.map((lane) => lane.kind);
    const channelId = channel?.id ?? null;
    let timer = null;
    const finish = (status, extra = {}) => {
      const out = { status, basis, excerpts: [], ms: now() - started, ...extra };
      log.info('recall: prefetched', {
        channel: channelId,
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
      if (!guildId || (!inCommunity(channel) && !partnerId)) return finish('unavailable', { reason: 'private-chat' });
      const p = settings.prefetch;
      const until = Number.isFinite(at) ? at : now();
      const bounded = Number.isFinite(at);
      const controller = new AbortController();
      const signal = controller.signal;
      const scope = scopeOf({ config, snapshot, channel, partnerId });
      const { sourceOf, privateUserId, allowEntry, allowLine } = scope;
      const own = inCommunity(channel) && Array.isArray(history) ? history.filter((m) => m?.id) : [];
      const ownIds = new Set(own.map((m) => m.id));
      const profiles = typeof store.listUserProfiles === 'function' ? (store.listUserProfiles(guildId) ?? []) : [];
      const stored = new Map(profiles.filter((profile) => profile?.id).map((profile) => [String(profile.id), profile]));
      const nameOf = (id) => {
        const name = stored.get(String(id))?.names?.[0];
        return (typeof name === 'string' && name ? name : null) ?? memberName(guildId, String(id)) ?? null;
      };
      const channelNameOf = (id) => snapshot?.get(id)?.name ?? null;
      // A replay's moment bounds the archive too: an entry recorded after it did not exist yet.
      const archiveShared = sharedSource(
        bounded && typeof archive?.iterate === 'function'
          ? {
              async *iterate(id, query) {
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
      const inTime = (window) => ({ ...window, messages: window.messages.filter((m) => !(m.ts > until)) });
      const settled = [];
      const stats = { searches: 0, failed: 0, meaning: 0 };
      const task = (name, work) => {
        stats.searches += 1;
        return work().then(
          (result) => {
            if (result && !signal.aborted) settled.push(result);
          },
          (err) => {
            stats.failed += 1;
            if (!signal.aborted)
              log.warn('recall: prefetch failed', { channel: channelId, stage: name, name: err?.name ?? null });
          }
        );
      };
      const memoryItems = (items, keep) => items.filter((item) => item.kind !== 'recent' && keep(item));
      const stages = {};
      const timed = (name, promise) => {
        const at = now();
        return promise.finally(() => {
          stages[name] = Math.max(stages[name] ?? 0, now() - at);
        });
      };
      // The database answers the words and the meaning of every lane (while it is not open, the stored memory alone).
      const db = dbOf();
      const dbMeaning = Boolean(db) && config.features?.meaningSearch === true && typeof embed === 'function';
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
      const tasks = [];
      plans.forEach((plan, i) => {
        tasks.push(
          task('memory', async () => {
            const used = plan;
            if (!used) return null;
            const forms = [...used.phrases, ...used.forms];
            if (forms.length === 0 && used.who.length === 0) return null;
            const memory = await timed(
              'memory',
              storedMemory({
                config,
                settings,
                snapshot,
                guildId,
                channel,
                partnerId,
                server: { forms, who: used.who, from: null, to: bounded ? until : null },
                recent: false,
                allowEntry,
                privateUserId,
                signal,
                source: archiveShared,
              })
            );
            const relevant = (item) =>
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
        const reader = dbReader({ db, config, snapshot, guildId, channel, partnerId, asker, memoryContext });
        list.forEach((lane, i) => {
          const plan = plans[i];
          const forms = plan ? [...plan.phrases, ...plan.forms] : [];
          if (forms.length === 0 && !(plan?.who?.length > 0)) return;
          tasks.push(
            task('db', async () => {
              const vector = dbMeaning ? ((await laneVectors.catch(() => null))?.[i] ?? null) : null;
              const found = await timed(
                'record',
                Promise.resolve().then(() =>
                  dbSearch(db, {
                    ctx: reader.ctx,
                    plan: { forms, who: plan.who, from: null, to: bounded ? until : null },
                    limit: Math.ceil(p.candidates / 4),
                    now: until,
                    vector,
                    settings: { ...dbSettings(config), candidates: p.candidates },
                    exclude: ownIds,
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
              const shown = new Map(windows.flatMap((window) => window.messages.map((m) => [m.id, m])));
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
        gapMinutes: config.context?.gapMarkerMinutes,
        maxChars: config.context?.maxMessageChars ?? 2000,
        seeReactions: config.features?.seeReactions !== false,
        reactionsPerMessage: config.context?.reactionsPerMessage,
        indexed: false,
      };
      const rendered = [];
      for (const unit of units) {
        if (unit.kind === 'memory') {
          const item = unit.item;
          rendered.push({
            source: 'memory',
            kind: item.kind,
            date: item.date ?? null,
            memberId: item.memberId ?? null,
            who: item.memberId ? nameOf(item.memberId) : null,
            id: item.itemId ?? null,
            lines: item.text,
            text: item.text,
          });
          continue;
        }
        // Only the best hit and the hits close to it are marked, so a long stretch with many hits is cut around them.
        const focus = focusHits(
          unit.window.messages.map((m) => m.id),
          unit.hitIds,
          FOCUS_LINES
        );
        const focused = { ...unit.window, hitIds: new Set(focus) };
        const window = typeof decorate === 'function' ? { ...focused, messages: decorate(focused.messages) } : focused;
        window.descriptions = cachedCaptions(config, guildId, [window]);
        const [shown] = renderRecallWindows([window], render);
        const lines = cutStretch(shown?.lines ?? [], p.excerptChars);
        if (lines.length === 0) continue;
        const text = lines.map((line) => line.text).join('\n');
        const ids = lines.map((line) => line.id);
        rendered.push({
          source: 'history',
          channelId: window.channelId,
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
      log.warn('recall: prefetch failed', { channel: channelId, stage: 'run', name: err?.name ?? null });
      return finish('unavailable', { reason: 'error' });
    } finally {
      if (timer !== null) timers.clear(timer);
    }
  }

  return { run, available, prefetch, window };
}
