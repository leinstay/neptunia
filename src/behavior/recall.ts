// The pure core of recall: the server's own history searched beside the web.
// The lookup classifier (prompts/lookup.md) answers `none` or up to five
// labelled lines -- `web:` a web query, `server:` word forms to look for in
// the server's messages, `who:` forms of a person's name, `when:` a date
// range in the bot's time zone, `recent:` whether the question is a vague
// "recently" -- and the old single unlabelled line still
// reads as a web query. The interface's message search does not stem and matches
// one form per query, so the server part becomes an ordered list of queries
// (content forms round-robin, then authors, or a date range sampled when
// nothing else is given); the hits are grouped into clusters by channel and
// time, a window of messages around each is fetched and carried forward
// along its conversation until it settles (followConversation: at most
// `recall.followMessages` more lines, up to the first silence longer than
// `recall.followGapMinutes`), and one analyzer request
// (prompts/recall-summary.md) reads the windows and says what the history
// answers, optionally singling out one stretch the persona then gets
// verbatim. The same word and name forms are also matched against the
// persona's own stored memory (matchMemory: members' moments, lore, learned
// items, recent lines), with no request, so a moment she already remembers
// reaches the summary even when it sits under another member or a lore key
// the question does not name; the archive (items that left hot memory) is a
// fifth source of those items (scanArchive streams it, matchMemory ranks
// it), and for every question the record is read for matching lines with
// their reply chains and neighbours (matchRecord: a dated question its range,
// any other the last `recall.recordDays` days, a dateless one keeping the
// window of the earliest match so an origin question sees where a thing
// started; each window followed forward the same way), as windows marked
// `source: record` beside the search's.
// Hits the turn already shows in its chat are
// dropped before clustering (dropChatHits); once the windows are fetched, a
// window holding the persona's own line ranks higher (rankClusters), and the
// summary reads the chat lines before the question as `<context>`, with each
// stretch flagged when it holds the persona's lines or overlaps the current
// chat. This module holds those decisions with no I/O;
// the search itself is the interface's (`reads.searchMessages`) and the runner
// src/behavior/recall-run.ts. No wording of ours goes into the request: tags
// and structural marks only.
// A `when:` range beside word or name forms is a locator unless the lookup
// says `when-role: scope` (people misremember dates): the local sources then
// search past it, a window near the range gets a bounded proximity bonus
// (proximityBonus) and a share of the kept slots stays reserved for the best
// by content regardless of date (locatorKeep), so a misread date cannot
// exclude the answer. A `when:` alone, or one marked scope, stays a hard bound.

import { isPlainObject } from '../config.ts';
import { estimateTokens } from '../llm/tokens.ts';
import { block, fillPromptTemplate } from './prompt.ts';
import { fill, formatTranscript, GAP_MARKER_MINUTES, MAX_MESSAGE_CHARS, renderTranscript } from '../format.ts';
import { clampText, oneLine } from '../memory/clamp.ts';
import { episodeDate } from '../memory/index.ts';
import {
  TEACHER_TOKEN_RE,
  fromTokens,
  isWordChar,
  occursAsWholeWord,
  occursAsWordStem,
  tokenIds,
} from '../memory/mentions.ts';
import { foldText, accountIdOf } from '../memory/recent.ts';
import { DAY_MS, MINUTE_MS, utcDay, zonedDay, zonedEpoch } from '../time.ts';
import { parseSkillsLines, takeSkillsLines } from '../tools/discovery.ts';
import type { SkillsLines } from '../tools/discovery.ts';
import { isFiniteNumber, objOf } from '../tools/types.ts';
import type { Untyped } from '../tools/types.ts';
import type {
  LocatorKeepArg2,
  MeaningQueryInput,
  SearchPlanInput,
  SearchPlanResult,
  ClusterHitsArg2,
  ClusterHitsResult,
  RankClustersInput,
  MergeWindowsResult,
  RenderRecallWindowsInput,
  RenderRecallWindowsArg2,
  RenderRecallWindowsResult,
  MemoryContextInput,
  MatchMemoryInput,
  MatchMemoryResult,
  ScanArchiveArg2,
  BuildRecallRequestInput,
  MatchRecordArg2,
  FallbackLookupPlanInput,
  MemorySearchPlanInput,
  RecallSettingsResult,
  MergeWindowsInput,
  FallbackLookupPlanResult,
  MemorySearchPlanResult,
  PrefetchSettings,
  RecordWindow,
} from './recall-types.ts';

/**
 * The prefetch's measures (production values of the config cut of 2026-10-31, and the fallbacks of `deadlineMs`,
 * `maxTokens`, `contextTokens`, `trivial` and `deictic`): the automatic retrieval
 * before a turn of the persona's tool loop (src/behavior/prefetch.ts, recall-run.js `prefetch`).
 * `trivial` and `deictic` are matching data (folded phrases and words), never wording she reads.
 */
export const PREFETCH_DEFAULTS = Object.freeze({
  deadlineMs: 1000,
  candidates: 20,
  maxExcerpts: 5,
  maxTokens: 1500,
  excerptChars: 1200,
  contextLines: 3,
  contextTokens: 500,
  shortWords: 4,
  minFormsMatched: 2,
  minMeaningScore: 0.35,
  strongMeaningScore: 0.55,
  singleTermScore: 0.45,
  maxTermShare: 0.002,
  maxPhraseDf: 20,
  minPhraseShare: 0.2,
  rareTermDf: 30,
  trivial: Object.freeze([
    'hi',
    'hello',
    'hey',
    'yo',
    'ok',
    'okay',
    'k',
    'thanks',
    'thank you',
    'thx',
    'ty',
    'yes',
    'no',
    'yep',
    'nope',
    'lol',
    'haha',
    'good night',
    'good morning',
    'bye',
  ]),
  deictic: Object.freeze(['that', 'this', 'it', 'he', 'she', 'they', 'him', 'her', 'them', 'there', 'those', 'these']),
});

/**
 * The recall's measures: production values of the config cut of 2026-10-31, and the fallbacks of the keys the live
 * config holds (`timeoutMs`, `maxOutputTokens`, `memoryTokens`, `recordDays` and the index policy of `db`).
 */
export const RECALL_DEFAULTS = Object.freeze({
  maxForms: 8,
  maxPeople: 2,
  dateSamples: 4,
  clusterGapMinutes: 30,
  maxClusters: 5,
  keepOldest: 0,
  rareHits: 5,
  windowMessages: 16,
  followMessages: 24,
  followGapMinutes: 5,
  answerChars: 1200,
  stretchChars: 1500,
  quoteWindowChars: 1500,
  quoteMaxChars: 9000,
  timeoutMs: 15000,
  minSummaryMs: 2500,
  maxOutputTokens: 500,
  memoryItems: 6,
  selfBonus: 1,
  selfExtra: 2,
  contextMessages: 6,
  traceMaxLines: 500,
  memoryTokens: 600,
  recordDays: 3,
  recordContext: 3,
  archiveMonths: 6,
  meaningCandidates: 80,
  locatorBonus: 2,
  locatorDecayDays: 7,
  locatorBroadShare: 0.5,
  db: Object.freeze({
    gateShare: 0.5,
    candidates: 40,
    wordPool: 400,
    minMeaning: 0.35,
    vectorDays: 90,
    touchDays: 30,
    vectorEviction: false,
    reembed: false,
  }),
  prefetch: PREFETCH_DEFAULTS,
});

/** The `k` of reciprocal rank fusion (fuseRanks): an item at rank r of a list adds 1 / (k + r). */
export const RRF_K = 60;

/** How many of the newest windows the fallback stretch is chosen among (fallbackWindow). */
export const FALLBACK_AMONG = 3;

/** Hits per search request (the API's maximum). */
export const SEARCH_PAGE = 25;
/** The largest `offset` the message search accepts. */
export const MAX_SEARCH_OFFSET = 9975;
/** The structural mark that opens a line the search matched, in `<found>` and in the stretch. */
export const HIT_MARK = '>> ';

/** The least topic score a cluster needs to take a keepOldest slot: two common forms or one rare (clusterHits). */
const OLDEST_MIN_TOPIC = 2;
/** The weight of a rare `form:` key in a cluster's topic score; a common one weighs 1 (clusterHits). */
const RARE_WEIGHT = 2;
/** The prefix of a query key that names the topic (a `server:` form), see queryKey. */
const FORM_KEY = 'form:';
/** The most messages one window may ask for (one page of a channel's history). */
const MAX_WINDOW_MESSAGES = 100;
/** A web query is cut to this many characters (as the old single-line answer was). */
const WEB_QUERY_CHARS = 200;
/** A search form: 2..40 characters and at most 3 words. */
const FORM_MIN_CHARS = 2;
const FORM_MAX_CHARS = 40;
const FORM_MAX_WORDS = 3;

// Protocol tokens of the lookup classifier (prompts/lookup.md), not wording.
const NONE_RE = /^none\b/i;
const LABEL_RE = /^(?:[-*•>]\s*)*\**\s*(web|agent|server|who|when[-_ ]?role|when|recent)\s*\**\s*:\s*\**\s*(.*)$/i;
const YES_RE = /^yes\b/i;
const SCOPE_RE = /^scope\b/i;
const LOCATOR_RE = /^locator\b/i;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/;
const RANGE_SPLIT_RE = /\s*\.{2,}\s*/;
const FORM_SPLIT_RE = /[,;，、]/;
// Protocol tokens of the summary request (prompts/recall-summary.md).
const STRETCH_RE = /^\**\s*stretch\s*\**\s*:\s*\**\s*(.*)$/i;
const NOTHING_RE = /^nothing$/i;
// Quotes and backticks a model may wrap a line in (straight, curly, guillemets).
const QUOTES = new Set(['"', "'", '`', '“', '”', '‘', '’', '«', '»']);
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', '…']);
// The `#n ` index that opens a chat transcript line.
const LINE_INDEX_RE = /^#\d+ (?=\[)/;

/** An integer from a finite `value` of at least `min` (floored), else `fallback`. */
function intAtLeast(value: unknown, fallback: number, min: number): number {
  return isFiniteNumber(value) && value >= min ? Math.floor(value) : fallback;
}

/** A finite `value` of at least `min`, else `fallback`. */
function numberAtLeast(value: unknown, fallback: number, min: number): number {
  return isFiniteNumber(value) && value >= min ? value : fallback;
}

/**
 * The `recall` settings: RECALL_DEFAULTS (production values of the config cut of 2026-10-31) with the keys the live
 * config holds read from it: `timeoutMs` and `maxOutputTokens` (whole numbers of at least 1), `memoryTokens` and
 * `recordDays` (at least 0), and the index policy of `db` (src/memory/db/index-policy.js, schema v11: `vectorDays`
 * and `touchDays` at least 1, `vectorEviction` and `reembed` on only when exactly `true`). `prefetch`:
 * `recall.prefetch` read by prefetchSettingsOf (the automatic memory prefetch, src/behavior/prefetch.ts).
 * @param config  The live config.
 */
export function recallSettings(config: Record<string, Untyped>): RecallSettingsResult | null {
  const r: Record<string, Untyped> = config?.recall ?? {};
  const d = RECALL_DEFAULTS;
  return {
    maxForms: d.maxForms,
    maxPeople: d.maxPeople,
    dateSamples: d.dateSamples,
    clusterGapMinutes: d.clusterGapMinutes,
    maxClusters: d.maxClusters,
    keepOldest: d.keepOldest,
    rareHits: d.rareHits,
    windowMessages: d.windowMessages,
    followMessages: d.followMessages,
    followGapMinutes: d.followGapMinutes,
    answerChars: d.answerChars,
    stretchChars: d.stretchChars,
    quoteWindowChars: d.quoteWindowChars,
    quoteMaxChars: d.quoteMaxChars,
    timeoutMs: intAtLeast(r.timeoutMs, d.timeoutMs, 1),
    minSummaryMs: d.minSummaryMs,
    maxOutputTokens: intAtLeast(r.maxOutputTokens, d.maxOutputTokens, 1),
    memoryItems: d.memoryItems,
    selfBonus: d.selfBonus,
    selfExtra: d.selfExtra,
    contextMessages: d.contextMessages,
    traceMaxLines: d.traceMaxLines,
    memoryTokens: intAtLeast(r.memoryTokens, d.memoryTokens, 0),
    recordDays: intAtLeast(r.recordDays, d.recordDays, 0),
    recordContext: d.recordContext,
    archiveMonths: d.archiveMonths,
    meaningCandidates: d.meaningCandidates,
    locatorBonus: d.locatorBonus,
    locatorDecayDays: d.locatorDecayDays,
    locatorBroadShare: d.locatorBroadShare,
    db: {
      gateShare: d.db.gateShare,
      candidates: d.db.candidates,
      wordPool: d.db.wordPool,
      minMeaning: d.db.minMeaning,
      // The index policy (src/memory/db/index-policy.js, schema v11): read there from the live config, normalised here alike.
      vectorDays: intAtLeast(r.db?.vectorDays, d.db.vectorDays, 1),
      touchDays: intAtLeast(r.db?.touchDays, d.db.touchDays, 1),
      vectorEviction: r.db?.vectorEviction === true,
      reembed: r.db?.reembed === true,
    },
    prefetch: prefetchSettingsOf(r.prefetch),
  };
}

/** A list of non-empty strings folded (foldText) and deduplicated, else `fallback`'s folded. */
function phraseList(value: Untyped, fallback: Untyped): Array<string> {
  const list = Array.isArray(value) ? value : fallback;
  return [
    ...new Set<string>(
      list
        .filter((item: Untyped) => typeof item === 'string')
        .map(foldText)
        .filter(Boolean)
    ),
  ];
}

/**
 * The prefetch settings: PREFETCH_DEFAULTS, with the keys `recall.prefetch` holds read from its config value (the
 * default for a missing or unusable one): `deadlineMs` and `maxTokens` whole numbers of at least 1, `contextTokens`
 * of at least 0, `trivial` and `deictic` lists of strings, folded. Pure.
 */
export function prefetchSettingsOf(value: unknown): PrefetchSettings {
  const p = objOf(value);
  const d = PREFETCH_DEFAULTS;
  return {
    deadlineMs: intAtLeast(p.deadlineMs, d.deadlineMs, 1),
    candidates: d.candidates,
    maxExcerpts: d.maxExcerpts,
    maxTokens: intAtLeast(p.maxTokens, d.maxTokens, 1),
    excerptChars: d.excerptChars,
    contextLines: d.contextLines,
    contextTokens: intAtLeast(p.contextTokens, d.contextTokens, 0),
    shortWords: d.shortWords,
    minFormsMatched: d.minFormsMatched,
    minMeaningScore: d.minMeaningScore,
    strongMeaningScore: d.strongMeaningScore,
    singleTermScore: d.singleTermScore,
    maxTermShare: d.maxTermShare,
    maxPhraseDf: d.maxPhraseDf,
    minPhraseShare: d.minPhraseShare,
    rareTermDf: d.rareTermDf,
    trivial: phraseList(p.trivial, d.trivial),
    deictic: phraseList(p.deictic, d.deictic),
  };
}

/** A finite `value` from 0 to 1, else `fallback`. */
function shareOf(value: Untyped, fallback: Untyped) {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

/**
 * The bounded bonus of a window or item near a `when:` locator: the time
 * `[start, end]` (`end` defaults to `start`) against the range `[from, to]`
 * (either side may be null, open): the full `bonus` when they overlap,
 * falling linearly with the distance to 0 at `decayDays` days away (only
 * inside with `decayDays` 0); 0 for a `start` that is not finite. Always
 * within [0, bonus]. Unusable numbers: RECALL_DEFAULTS. Pure.
 */
export function proximityBonus(
  start: number,
  end: number | null | undefined,
  {
    from = null,
    to = null,
    bonus,
    decayDays,
  }: { from?: number | null; to?: number | null; bonus?: number; decayDays?: number } = {}
): number {
  const most = numberAtLeast(bonus, RECALL_DEFAULTS.locatorBonus, 0);
  if (most === 0 || !Number.isFinite(start)) return 0;
  const last = isFiniteNumber(end) && end >= start ? end : start;
  let gap = 0;
  if (isFiniteNumber(from) && last < from) gap = from - last;
  else if (isFiniteNumber(to) && start > to) gap = start - to;
  if (gap === 0) return most;
  const decay = numberAtLeast(decayDays, RECALL_DEFAULTS.locatorDecayDays, 0) * DAY_MS;
  return decay > 0 ? most * Math.max(0, 1 - gap / decay) : 0;
}

/**
 * The slots of a locator recall: the first ceil(`keep` x `broadShare`) go to
 * the best of `items` by `broadOrder` (content, regardless of date), the
 * rest to the best of the others by `datedOrder` (with the proximity bonus),
 * so a date read wrong cannot crowd the right event out. At most `keep`
 * (every item for a `keep` that is not an integer of at least 0); an
 * unusable `broadShare`: RECALL_DEFAULTS.locatorBroadShare. Returned in pick
 * order, each `{ item, share: 'broad' | 'dated' }`. Pure.
 */
export function locatorKeep<TItem>(
  items: Array<TItem>,
  { keep, broadShare, broadOrder, datedOrder }: LocatorKeepArg2<TItem>
): Array<{ item: TItem; share: 'broad' | 'dated' }> {
  const list = Array.isArray(items) ? [...items] : [];
  const limit = typeof keep === 'number' && Number.isInteger(keep) && keep >= 0 ? keep : list.length;
  const share = shareOf(broadShare, RECALL_DEFAULTS.locatorBroadShare);
  const broad = [...list].sort(broadOrder).slice(0, Math.min(limit, Math.ceil(limit * share)));
  const taken = new Set(broad);
  const dated = list
    .filter((item) => !taken.has(item))
    .sort(datedOrder)
    .slice(0, limit - broad.length);
  return [
    ...broad.map((item) => ({ item, share: 'broad' as const })),
    ...dated.map((item) => ({ item, share: 'dated' as const })),
  ];
}

/** A usable locator option (a range with a finite side), else null. */
function usableLocator(locator: Untyped) {
  return isPlainObject(locator) && (Number.isFinite(locator.from) || Number.isFinite(locator.to)) ? locator : null;
}

/**
 * Reciprocal rank fusion of ranked lists: each item scores the sum over the
 * lists holding it of the list's weight (`weights[i]`, 1 when missing) over
 * (`k` + its 1-based rank there; a repeat keeps its first rank). Returned best
 * first; on an equal score the item found by more lists first, then by its
 * rank in the earlier list (an item it lacks after one it holds), and so on.
 * Items are compared as Map keys (ids or objects). Pure.
 */
export function fuseRanks(
  lists: Array<Array<unknown>>,
  { k = RRF_K, weights = null }: { k?: number; weights?: Array<number> | null } = {}
): Array<{ id: unknown; score: number; ranks: Array<number | null> }> {
  const all = Array.isArray(lists) ? lists : [];
  const fused = new Map();
  all.forEach((list, at) => {
    const weight = Array.isArray(weights) && Number.isFinite(weights[at]) ? weights[at] : 1;
    (Array.isArray(list) ? list : []).forEach((id, i) => {
      if (!fused.has(id)) fused.set(id, { id, score: 0, ranks: all.map(() => null) });
      const entry = fused.get(id);
      if (entry.ranks[at] !== null) return;
      entry.ranks[at] = i + 1;
      entry.score += weight / (k + i + 1);
    });
  });
  const found = (entry: Untyped) => entry.ranks.filter((rank: Untyped) => rank !== null).length;
  return [...fused.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (found(b) !== found(a)) return found(b) - found(a);
    for (let at = 0; at < all.length; at += 1) {
      const x = a.ranks[at] ?? Infinity;
      const y = b.ranks[at] ?? Infinity;
      if (x !== y) return x - y;
    }
    return 0;
  });
}

/**
 * The text a recall run embeds for its meaning search: the asker's message
 * (`candidate.content`) on one line with its `<@id>` tokens resolved through
 * `nameOf` (as the index's chunks are, src/memory/chunks.js), `form`
 * `question`; with `withReply`, the line it replies to (`candidate.replyToId`
 * among `lines`), the same way, on the line before it, `form`
 * `question+reply` (`question` when that line is not at hand). Null when the
 * message has no text. Pure.
 */
export function meaningQuery({
  candidate = null,
  lines = [],
  withReply = false,
  nameOf = null,
}: MeaningQueryInput = {}): { text: string; form: 'question' | 'question+reply' } | null {
  const flat = (message: Untyped) =>
    oneLine(fromTokens(typeof message?.content === 'string' ? message.content : '', nameOf, 'chat'));
  const question = flat(candidate);
  if (!question) return null;
  const replyId = typeof candidate?.replyToId === 'string' && candidate.replyToId ? candidate.replyToId : null;
  const parent = withReply && replyId ? (Array.isArray(lines) ? lines : []).find((line) => line?.id === replyId) : null;
  const replied = parent ? flat(parent) : '';
  return replied ? { text: `${replied}\n${question}`, form: 'question+reply' } : { text: question, form: 'question' };
}

/** `line` without surrounding quotes/backticks/whitespace and trailing punctuation (one pass each way). */
function stripLine(line: Untyped) {
  const points = [...String(line ?? '')];
  let start = 0;
  let end = points.length;
  const isSpace = (c: Untyped) => c.trim() === '';
  while (start < end && (QUOTES.has(points[start]) || isSpace(points[start]))) start += 1;
  while (
    end > start &&
    (QUOTES.has(points[end - 1]) || TRAILING_PUNCTUATION.has(points[end - 1]) || isSpace(points[end - 1]))
  )
    end -= 1;
  return points.slice(start, end).join('');
}

/** One answer value as a line of at most `chars` characters: stripped, `none` -> null, cut. */
function boundedLine(value: Untyped, chars: Untyped) {
  const stripped = stripLine(value);
  if (!stripped || NONE_RE.test(stripped)) return null;
  const line = [...stripped].slice(0, chars).join('').trim();
  return line || null;
}

/** A web query from one answer value: stripped, `none` -> null, cut to WEB_QUERY_CHARS. */
function webQuery(value: Untyped) {
  return boundedLine(value, WEB_QUERY_CHARS);
}

/** The forms of one `server:` / `who:` value, cleaned (see parseLookupAnswer), appended to `into` up to `cap`. */
function addForms(into: Untyped, value: Untyped, cap: Untyped) {
  for (const part of String(value ?? '').split(FORM_SPLIT_RE)) {
    if (into.length >= cap) return;
    const form = oneLine(stripLine(part)).toLowerCase();
    const chars = [...form].length;
    if (chars < FORM_MIN_CHARS || chars > FORM_MAX_CHARS) continue;
    if (form.split(' ').length > FORM_MAX_WORDS || NONE_RE.test(form) || into.includes(form)) continue;
    into.push(form);
  }
}

/** One side of a `when:` value: `{ day, hour, minute, timed }` or null when it is not a date. */
function dateSide(text: string) {
  const match = DATE_RE.exec(text.trim());
  if (!match) return null;
  if (match[2] === undefined) return { day: match[1], hour: 0, minute: 0, timed: false };
  return { day: match[1], hour: Number(match[2]), minute: Number(match[3]), timed: true };
}

/** The start of a side (its minute, or the start of its local day). */
function sideStart(side: Untyped, timezone: Untyped) {
  return zonedEpoch(side.day, side.hour, side.minute, timezone);
}

/** The inclusive end of a side (its minute, or the last ms of its local day). */
function sideEnd(side: Untyped, timezone: Untyped) {
  if (side.timed) return zonedEpoch(side.day, side.hour, side.minute, timezone);
  const next = utcDay(Date.parse(`${side.day}T00:00:00Z`) + DAY_MS);
  return zonedEpoch(next, 0, 0, timezone) - 1;
}

/**
 * A `when:` value as `{ from, to }` in epoch ms (both inclusive, either may
 * be null for an open side), or null when it is not a usable range.
 */
function parseRange(value: Untyped, timezone: Untyped, now: number | undefined) {
  // Quotes go, but not the `..` of an open end: only a lone trailing period does.
  let text = [...String(value ?? '')]
    .filter((c, i, all) => !(QUOTES.has(c) && (i === 0 || i === all.length - 1)))
    .join('')
    .trim();
  if (/[^.]\.$/.test(text)) text = text.slice(0, -1).trim();
  if (!text || NONE_RE.test(text)) return null;
  const sides = text.split(RANGE_SPLIT_RE);
  let from = null;
  let to = null;
  if (sides.length === 1) {
    const side = dateSide(sides[0]);
    if (!side) return null;
    from = sideStart({ ...side, hour: 0, minute: 0 }, timezone);
    to = sideEnd({ ...side, timed: false }, timezone);
  } else if (sides.length === 2) {
    const [left, right] = sides.map((s) => s.trim());
    if (!left && !right) return null;
    const a = left ? dateSide(left) : null;
    const b = right ? dateSide(right) : null;
    if ((left && !a) || (right && !b)) return null;
    from = a ? sideStart(a, timezone) : null;
    to = b ? sideEnd(b, timezone) : null;
  } else {
    return null;
  }
  if ((from !== null && !Number.isFinite(from)) || (to !== null && !Number.isFinite(to))) return null;
  if (from !== null && to !== null && from > to) {
    // Reversed bounds are swapped: the start of the later side's day, the end of the earlier's.
    const [x, y] = sides.map((s) => dateSide(s.trim()));
    from = sideStart(y, timezone);
    to = sideEnd(x, timezone);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return null;
  }
  if (isFiniteNumber(now)) {
    if (from !== null && from > now) return null;
    if (to !== null && to > now) to = now;
  }
  return { from, to };
}

/**
 * The lookup classifier's answer (prompts/lookup.md). Labelled lines `web:`,
 * `server:`, `who:`, `when:` in any order and any letter case (a leading
 * list bullet or bold marks around the label are tolerated); a line without
 * a label is ignored once any line has one. Without any labelled line the
 * first non-empty line is the old answer: `none` (its first word, any case,
 * quotes stripped) or a web query.
 * - `web`: the first one; quotes and trailing punctuation stripped, a value
 *   starting with `none` is no query, cut to 200 characters.
 * - `agent`: ignored. An old prompt's errand line is read as a label only so
 *   it is never taken for the unlabelled web query; the classifier never
 *   asks for an errand (only the persona's own `errand.run` call does).
 * - `server` / `who`: comma-separated forms, each trimmed, wrapping quotes
 *   and trailing punctuation stripped, whitespace collapsed, lower-cased,
 *   kept when 2..40 characters and at most 3 words, de-duplicated in order,
 *   at most `maxForms` per label (a missing or unusable value: RECALL_DEFAULTS.maxForms).
 * - `when`: `YYYY-MM-DD` or `YYYY-MM-DD HH:MM` on each side of `..`, in
 *   `timezone`; one date alone means that whole local day; a side may be
 *   left open; reversed bounds are swapped; an end after `now` is clamped
 *   to `now`, a start after it drops the range; anything unparsable gives
 *   no range. The first usable one counts.
 * - `recent`: `yes` (its first word, any case) marks a vague "recently";
 *   anything else does not. It only qualifies the other lines: `server` gets
 *   `recent: true` (the key is absent otherwise); the line alone asks nothing.
 * - `when-role` (also `when_role`, `when role`): `scope` (its first word, any
 *   case) or `locator`; the first usable one counts, anything else is no
 *   role. It only qualifies `when:`: a usable range beside a form or a name
 *   form is a locator (`server` gets `locator: true`, absent otherwise)
 *   unless the role is `scope` -- a missing role locates, so a misread date
 *   cannot exclude the answer; a range with neither is always a scope (the
 *   time is the question). The line alone asks nothing.
 * `server` is an object when there is a form, a name form or a range, else
 * null. `reason`: `empty` (no text), `none` (an
 * explicit none, or labelled lines that all say none or nothing), `unparsed`
 * (labelled lines with content none of which is usable), `ok` (a web query
 * or a server part). An `agent:` line is ignored (counted as nothing).
 * A `skills:` line (skills discovery, src/tools/discovery.ts) is taken out
 * before the rest is read, so the other lines read exactly as without it;
 * with one, the result has `skills` (parseSkillsLines over `skillNames`:
 * `inventory`, up to four known names, `none` or `invalid`) and an answer of
 * nothing else is `none`. Without one there is no `skills` key (none).
 */
export function parseLookupAnswer(
  raw: unknown,
  {
    timezone = 'UTC',
    now,
    maxForms,
    skillNames,
  }: { timezone?: string; now?: number; maxForms?: number; skillNames?: Array<string> } = {}
): SearchLines & { skills?: SkillsLines } {
  const { rest, values } = takeSkillsLines(raw);
  const parsed = parseSearchLines(rest, { timezone, now, maxForms });
  if (values.length === 0) return parsed;
  const skills = parseSkillsLines(values, skillNames);
  return parsed.reason === 'empty' ? { ...parsed, reason: 'none', skills } : { ...parsed, skills };
}

/** parseLookupAnswer's reading of every line but the `skills:` ones. */
/** A parsed classifier answer: the web query, the server part (forms, names and the range), and why there is none. */
type SearchLines = {
  web: string | null;
  server: {
    forms: Array<string>;
    who: Array<string>;
    from: number | null;
    to: number | null;
    recent?: true;
    locator?: true;
  } | null;
  reason: 'empty' | 'none' | 'unparsed' | 'ok';
};

function parseSearchLines(
  raw: Untyped,
  { timezone, now, maxForms }: { timezone: Untyped; now?: number; maxForms: Untyped }
): SearchLines {
  const lines = String(raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { web: null, server: null, reason: 'empty' };
  const labelled = lines.map((line) => LABEL_RE.exec(line)).filter((match): match is RegExpExecArray => match !== null);
  if (labelled.length === 0) {
    const stripped = stripLine(lines[0]);
    if (NONE_RE.test(stripped)) return { web: null, server: null, reason: 'none' };
    const web = webQuery(lines[0]);
    return web ? { web, server: null, reason: 'ok' } : { web: null, server: null, reason: 'empty' };
  }

  const cap = intAtLeast(maxForms, RECALL_DEFAULTS.maxForms, 1);
  let web = null;
  const forms: Array<Untyped> = [];
  const who: Array<Untyped> = [];
  let range = null;
  let recent = false;
  let role = null;
  let content = false;
  for (const [, label, value] of labelled) {
    const stripped = stripLine(value);
    // `recent:` only qualifies the other lines: alone it asks nothing.
    if (label.toLowerCase() === 'recent') {
      recent ||= YES_RE.test(stripped);
      continue;
    }
    // `when-role:` only qualifies `when:`; the first usable one counts.
    if (/^when.?role$/i.test(label)) {
      const bare = stripLine(stripped.replace(/^\**\s*/, ''));
      role ??= SCOPE_RE.test(bare) ? 'scope' : LOCATOR_RE.test(bare) ? 'locator' : null;
      continue;
    }
    // `agent:` (an old prompt's errand line) is read as a label and ignored: the classifier never asks for an errand.
    if (label.toLowerCase() === 'agent') continue;
    if (stripped && !NONE_RE.test(stripped)) content = true;
    switch (label.toLowerCase()) {
      case 'web':
        web ??= webQuery(value);
        break;
      case 'server':
        addForms(forms, value, cap);
        break;
      case 'who':
        addForms(who, value, cap);
        break;
      default:
        range ??= parseRange(value, timezone ?? 'UTC', now);
    }
  }
  const asked = forms.length > 0 || who.length > 0 || range;
  // A range beside forms or names only locates the event unless marked scope; a range alone is the question.
  const locator = Boolean(range) && (forms.length > 0 || who.length > 0) && role !== 'scope';
  const server = asked
    ? {
        forms,
        who,
        from: range?.from ?? null,
        to: range?.to ?? null,
        ...(recent ? { recent: true as const } : {}),
        ...(locator ? { locator: true as const } : {}),
      }
    : null;
  if (web || server) return { web, server, reason: 'ok' };
  return { web: null, server: null, reason: content ? 'unparsed' : 'none' };
}

/**
 * Whether a parsed server part is a vague "recently": its `when:` range starts
 * within the last `recordDays` days (at least one) before `now` and ends open
 * or within the last day; without a range, the classifier's `recent: yes`
 * (parseLookupAnswer's `recent: true`). A dated range that is not recent wins
 * over the flag. Such a recall ranks by recency, the persona's own exchanges
 * first (matchMemory, matchRecord).
 */
export function isRecentCue(
  server: { from?: number | null; to?: number | null; recent?: boolean } | null | undefined,
  { now, recordDays }: { now?: number; recordDays?: number } = {}
): boolean {
  if (!server || typeof server !== 'object') return false;
  const from = isFiniteNumber(server.from) ? server.from : null;
  const to = isFiniteNumber(server.to) ? server.to : null;
  if (from === null && to === null) return server.recent === true;
  if (from === null || !isFiniteNumber(now)) return false;
  const days = Math.max(1, intAtLeast(recordDays, RECALL_DEFAULTS.recordDays, 0));
  return now - from <= days * DAY_MS && (to === null || now - to < DAY_MS);
}

export function searchPlan({
  forms = [],
  who = [],
  accountIds = [],
  from = null,
  to = null,
  maxForms,
}: SearchPlanInput = {}): Array<SearchPlanResult> {
  const limit = intAtLeast(maxForms, RECALL_DEFAULTS.maxForms, 0);
  const upper = isFiniteNumber(to) ? to + 1 : Infinity;
  const lower = isFiniteNumber(from) ? from : null;
  if (lower !== null && upper <= lower) return [];
  const range = { after: lower, before: Number.isFinite(upper) ? upper : null };

  const contents: Array<Untyped> = [];
  const a = Array.isArray(forms) ? forms : [];
  const b = Array.isArray(who) ? who : [];
  for (let i = 0; contents.length < limit && (i < a.length || i < b.length); i += 1) {
    for (const form of [a[i], b[i]]) {
      if (typeof form === 'string' && form && !contents.includes(form) && contents.length < limit) contents.push(form);
    }
  }
  const authors = [
    ...new Set((Array.isArray(accountIds) ? accountIds : []).filter((id) => typeof id === 'string' && id)),
  ];
  const plan: ReturnType<typeof searchPlan> = [
    ...contents.map((content) => ({
      kind: a.includes(content) ? ('form' as const) : ('who' as const),
      content,
      ...range,
    })),
    ...authors.map((authorId) => ({ kind: 'author' as const, authorId, ...range })),
  ];
  if (plan.length === 0 && (isFiniteNumber(from) || isFiniteNumber(to)))
    plan.push({ kind: 'range' as const, ...range });
  return plan;
}

/**
 * The key a search query's hits are tagged with (clusterHits counts the
 * distinct keys of a cluster, the `form:` ones first): `form:<form>` for a
 * server form (the topic), `who:<form>` for a name form, `author:<id>` for
 * an author search, or `range` for a date range alone -- every sampled page
 * of it is one query.
 * @param query  A searchPlan entry.
 */
export function queryKey(query: { kind: string; content?: string; authorId?: string }): string {
  if (query?.kind === 'form') return `${FORM_KEY}${query.content}`;
  if (query?.kind === 'who') return `who:${query.content}`;
  if (query?.kind === 'author') return `author:${query.authorId}`;
  return 'range';
}

/**
 * The offsets at which a date-only range of `total` messages is read:
 * `samples` evenly spaced offsets from 0 (the newest page), floored,
 * de-duplicated, at most MAX_SEARCH_OFFSET; just [0] when one page holds
 * everything.
 */
export function sampleOffsets(total: number, samples: number): Array<number> {
  const count = intAtLeast(samples, RECALL_DEFAULTS.dateSamples, 1);
  if (!Number.isFinite(total) || total <= SEARCH_PAGE) return [0];
  const out: Array<Untyped> = [];
  for (let i = 0; i < count; i += 1) {
    const offset = Math.min(MAX_SEARCH_OFFSET, Math.floor((i * total) / count));
    if (!out.includes(offset)) out.push(offset);
  }
  return out;
}

/**
 * The `form:` keys (queryKey) whose search found at most `rareHits` messages
 * on the whole server (the API's `total_results`): a form that rare is the
 * most distinctive evidence there is. `totals` maps a query key to its
 * search's total (a Map or `[key, total]` pairs); keys of other kinds and
 * totals that are not finite numbers of at least 0 are ignored. `rareHits`
 * 0 marks none (an unusable value: RECALL_DEFAULTS.rareHits).
 */
export function rareFormKeys(
  totals: Map<string, number> | Iterable<[string, number]> | null | undefined,
  rareHits: number
): Set<string> {
  const limit = intAtLeast(rareHits, RECALL_DEFAULTS.rareHits, 0);
  const out = new Set<string>();
  if (limit === 0 || !totals || typeof totals[Symbol.iterator] !== 'function') return out;
  for (const [key, total] of totals) {
    if (typeof key === 'string' && key.startsWith(FORM_KEY) && Number.isFinite(total) && total >= 0 && total <= limit)
      out.add(key);
  }
  return out;
}

/**
 * Hits grouped into clusters: per channel, hits sorted by time; a hit less
 * than `gapMinutes` after the previous one joins its cluster. Each cluster:
 * `{ placeId, ids (oldest first), startTs, endTs, middleId, queries, forms, topic }`,
 * `middleId` the hit at the middle of its list, `queries` how many distinct
 * query keys (queryKey) its hits carry -- a hit found by two queries counts
 * both, a hit without `queries` counts none -- `forms` how many of them are
 * `form:` keys (the topic), and `topic` the sum of their weights: RARE_WEIGHT
 * (2) for a key in `rareForms` (rareFormKeys: its search found at most
 * `recall.rareHits` messages), else 1. With more than `maxClusters`
 * clusters, they rank by `topic` (more first), then `queries` (more first),
 * then the newer `endTs` (channel id on a tie): the dense stretch where
 * several topic forms meet, or the one place a rare form occurs, outranks a
 * retelling or a stray hit of a common form; name and author hits only
 * locate the person -- a cluster of them alone ranks below any with one
 * topic hit -- and a one-hit cluster still counts, below the denser ones.
 * The top `maxClusters - keepOldest` are kept; each of the `keepOldest`
 * slots (at most `maxClusters`) then goes to the oldest cluster of the rest
 * with a `topic` of at least OLDEST_MIN_TOPIC (2) -- two common forms or one
 * rare: where a running thing started, never a single generic hit -- and a
 * slot no such cluster takes goes on by rank. `keepOldest` 0 reserves nothing. The kept
 * ones are returned newest first by `endTs` (channel id on a tie). Hits
 * without an id, a channel or a finite `ts` are ignored; a repeated id is one
 * hit with the queries of every copy. With a `locator` (a `when:` that only
 * locates: `{ from, to, bonus, decayDays, broadShare }`) the selection is
 * locatorKeep's instead of the `keepOldest` one: the reserved share by the
 * rank above, the rest by `topic` + proximityBonus of the cluster's span,
 * each kept cluster marked `share` (`broad` | `dated`).
 */
export function clusterHits(
  hits: Array<{ id: string; placeId: string; ts: number; queries?: Iterable<string> }>,
  { gapMinutes, maxClusters, keepOldest, rareForms, locator = null }: ClusterHitsArg2 = {}
): Array<ClusterHitsResult> {
  const gapMs = numberAtLeast(gapMinutes, RECALL_DEFAULTS.clusterGapMinutes, 0) * MINUTE_MS;
  const keep = intAtLeast(maxClusters, RECALL_DEFAULTS.maxClusters, 1);
  const oldest = Math.min(keep, intAtLeast(keepOldest, RECALL_DEFAULTS.keepOldest, 0));
  const rare = new Set(
    rareForms && typeof rareForms !== 'string' && typeof rareForms[Symbol.iterator] === 'function' ? rareForms : []
  );
  const byChannel = new Map();
  const seen = new Map();
  for (const hit of Array.isArray(hits) ? hits : []) {
    if (!hit?.id || !hit.placeId || !Number.isFinite(hit.ts)) continue;
    const keys: Array<string> =
      typeof hit.queries === 'string' ? [] : [...(hit.queries ?? [])].filter((key) => typeof key === 'string' && key);
    if (seen.has(hit.id)) {
      for (const key of keys) seen.get(hit.id).queries.add(key);
      continue;
    }
    const entry = { id: hit.id, ts: hit.ts, queries: new Set(keys) };
    seen.set(hit.id, entry);
    if (!byChannel.has(hit.placeId)) byChannel.set(hit.placeId, []);
    byChannel.get(hit.placeId).push(entry);
  }
  const clusters: Array<{ placeId: Untyped; ids: Array<string>; startTs: number; endTs: number; keys: Set<string> }> =
    [];
  for (const [placeId, list] of byChannel) {
    list.sort((x: Untyped, y: Untyped) => x.ts - y.ts || (x.id < y.id ? -1 : 1));
    let current: (typeof clusters)[number] | null = null;
    for (const hit of list) {
      if (current && hit.ts - current.endTs < gapMs) {
        current.ids.push(hit.id);
        current.endTs = hit.ts;
        for (const key of hit.queries) current.keys.add(key);
        continue;
      }
      current = { placeId, ids: [hit.id], startTs: hit.ts, endTs: hit.ts, keys: new Set(hit.queries) };
      clusters.push(current);
    }
  }
  const shaped = clusters.map(({ keys, ...cluster }) => {
    const topical: Array<string> = [...keys].filter((key: string) => key.startsWith(FORM_KEY));
    return {
      ...cluster,
      middleId: cluster.ids[Math.floor(cluster.ids.length / 2)],
      queries: keys.size,
      forms: topical.length,
      topic: topical.reduce((sum, key) => sum + (rare.has(key) ? RARE_WEIGHT : 1), 0),
    };
  });
  return selectClusters(shaped, keep, oldest, (cluster: Untyped) => cluster.topic, locator);
}

/** Newest first by `endTs`, channel id on a tie: the order kept clusters are returned in. */
function newestFirst(x: Untyped, y: Untyped) {
  return y.endTs - x.endTs || (x.placeId < y.placeId ? -1 : 1);
}

/**
 * The selection of clusterHits and rankClusters: ranked by `scoreOf` (more
 * first), then `queries` (more first), then newestFirst; with more than
 * `keep`, the top `keep - oldest` plus the `oldest` reserved slots (the
 * oldest of the rest whose `topic` is at least OLDEST_MIN_TOPIC, a slot no
 * such cluster takes going on by rank). Returned newest first. With a usable
 * `locator`: locatorKeep over that rank (reserved) and `scoreOf` +
 * proximityBonus of the span (dated), no `oldest` slot, each kept cluster
 * marked `share`.
 */
function selectClusters(clusters: Untyped, keep: Untyped, oldest: Untyped, scoreOf: Untyped, locator = null) {
  const byRank = (x: Untyped, y: Untyped) => scoreOf(y) - scoreOf(x) || y.queries - x.queries || newestFirst(x, y);
  const near = usableLocator(locator);
  if (near) {
    const boosted = (cluster: Untyped) => scoreOf(cluster) + proximityBonus(cluster.startTs, cluster.endTs, near);
    const picked = locatorKeep(clusters, {
      keep,
      broadShare: near.broadShare,
      broadOrder: byRank,
      datedOrder: (x, y) => boosted(y) - boosted(x) || byRank(x, y),
    });
    for (const { item, share } of picked) item.share = share;
    return picked.map(({ item }) => item).sort(newestFirst);
  }
  const ranked = [...clusters].sort(byRank);
  let kept = ranked;
  if (ranked.length > keep) {
    kept = ranked.slice(0, keep - oldest);
    const rest = ranked.slice(keep - oldest);
    const reserved = rest
      .filter((cluster) => cluster.topic >= OLDEST_MIN_TOPIC)
      .sort((x, y) => -newestFirst(x, y))
      .slice(0, oldest);
    const taken = new Set(reserved);
    kept.push(...reserved, ...rest.filter((cluster) => !taken.has(cluster)).slice(0, oldest - reserved.length));
  }
  return [...kept].sort(newestFirst);
}

/**
 * The hits not already shown in the turn's chat: those whose id is in
 * `chatIds` (a Set or an array: the chat window and the reply parents the
 * turn fetched) are left out before clustering, and counted.
 */
export function dropChatHits(
  hits: Array<Record<string, Untyped>>,
  chatIds: Set<string> | Array<string> | null | undefined
): { hits: Array<Untyped>; dropped: number } {
  const list = Array.isArray(hits) ? hits : [];
  const ids = chatIds instanceof Set ? chatIds : new Set(Array.isArray(chatIds) ? chatIds : []);
  if (ids.size === 0) return { hits: list, dropped: 0 };
  const kept = list.filter((hit) => !ids.has(hit?.id));
  return { hits: kept, dropped: list.length - kept.length };
}

/**
 * The score a fetched cluster ranks by in rankClusters: its `topic`
 * (clusterHits) plus `selfBonus` when its window holds a line of the
 * persona (`self` true).
 */
export function clusterScore(cluster: { topic: number; self?: boolean }, selfBonus: number): number {
  const bonus = Number.isFinite(selfBonus) && selfBonus > 0 ? selfBonus : 0;
  return (Number.isFinite(cluster?.topic) ? cluster.topic : 0) + (cluster?.self === true ? bonus : 0);
}

/**
 * The final choice among the clusters whose windows were fetched
 * (clusterHits kept `maxClusters + selfExtra` of them, each then marked
 * `self` when its window holds a line of the persona): the clusterHits
 * selection again, ranked by clusterScore (topic + `selfBonus` for a window
 * with the persona's line) instead of `topic`, then `queries`, then the
 * newer `endTs`; `keepOldest` reserves as in clusterHits (by `topic`, the
 * bonus aside). At most `maxClusters`, returned newest first (the same
 * objects). With a `locator` the selection is clusterHits' locator one over
 * clusterScore, each kept cluster marked `share` in place.
 */
export function rankClusters(
  clusters: Array<RankClustersInput>,
  {
    maxClusters,
    keepOldest,
    selfBonus,
    locator = null,
  }: { maxClusters?: number; keepOldest?: number; selfBonus?: number; locator?: Untyped } = {}
): Array<Untyped> {
  const keep = intAtLeast(maxClusters, RECALL_DEFAULTS.maxClusters, 1);
  const oldest = Math.min(keep, intAtLeast(keepOldest, RECALL_DEFAULTS.keepOldest, 0));
  const bonus = numberAtLeast(selfBonus, RECALL_DEFAULTS.selfBonus, 0);
  const list = (Array.isArray(clusters) ? clusters : []).filter((cluster) => cluster && Number.isFinite(cluster.endTs));
  return selectClusters(list, keep, oldest, (cluster: Untyped) => clusterScore(cluster, bonus), locator);
}

/**
 * The chat lines the recall summary reads before the question (`<context>`):
 * the last `count` messages of `history` other than `question` itself, in
 * order (as the search classifier's transcript takes them). None for a
 * `count` of 0 or no history.
 */
export function recallContext(
  history: Array<Record<string, Untyped>> | null | undefined,
  question: { id?: string } | null | undefined,
  count: number
): Array<Record<string, Untyped>> {
  const n = intAtLeast(count, RECALL_DEFAULTS.contextMessages, 0);
  if (n === 0 || !Array.isArray(history)) return [];
  return history.filter((m) => m && (!question?.id || m.id !== question.id)).slice(-n);
}

/**
 * The lines that carry a window's conversation on past its last line (at
 * `lastTs`): of `after` (the same channel's lines following it, any order),
 * oldest first, each taken while no more than `followGapMinutes` passed
 * since the line before it (the window's last line for the first) and fewer
 * than `followMessages` are taken; the first longer silence ends the
 * conversation there. The caller filters what it shows (other bots, the
 * turn's own chat) afterwards, so such a line still keeps the conversation
 * going. `followMessages` 0 or a non-finite `lastTs` gives none.
 * @param [options]  RECALL_DEFAULTS when unusable.
 */
export function followConversation(
  lastTs: number,
  after: Array<Record<string, Untyped>>,
  { followMessages, followGapMinutes }: { followMessages?: number; followGapMinutes?: number } = {}
): Array<Record<string, Untyped>> {
  const cap = intAtLeast(followMessages, RECALL_DEFAULTS.followMessages, 0);
  const gap = numberAtLeast(followGapMinutes, RECALL_DEFAULTS.followGapMinutes, 0) * MINUTE_MS;
  const out: Array<Untyped> = [];
  if (cap === 0 || !Number.isFinite(lastTs)) return out;
  let previous = lastTs;
  const list = (Array.isArray(after) ? after : [])
    .filter((m) => m && Number.isFinite(m.ts))
    .sort((x, y) => x.ts - y.ts);
  for (const message of list) {
    if (out.length >= cap || message.ts - previous > gap) break;
    out.push(message);
    previous = message.ts;
  }
  return out;
}

/**
 * Windows of one channel that share a message merged into the first of
 * them (messages united by id, oldest first; hit ids united; `overlapsChat`
 * true when any of them overlaps the turn's chat); the order of first
 * appearance is kept and a window without messages is dropped. A window
 * marked `source: 'record'` keeps the mark when it opens a merged one.
 */
export function mergeWindows(windows: Array<MergeWindowsInput | null | undefined>): Array<MergeWindowsResult> {
  const out: Array<Untyped> = [];
  for (const window of Array.isArray(windows) ? windows : []) {
    if (!window) continue;
    const messages = (window?.messages ?? []).filter((m: Untyped) => m?.id);
    if (messages.length === 0) continue;
    const ids = new Set(messages.map((m: Untyped) => m.id));
    const into = out.find((w) => w.placeId === window.placeId && w.messages.some((m: Untyped) => ids.has(m.id)));
    if (!into) {
      out.push({
        placeId: window.placeId,
        channelName: window.channelName ?? null,
        messages: [...messages],
        hitIds: new Set(window.hitIds ?? []),
        overlapsChat: window.overlapsChat === true,
        // A record window keeps its mark (matchRecord merges record windows among themselves only).
        ...(window.source === 'record' ? { source: 'record' } : {}),
      });
      continue;
    }
    if (window.overlapsChat === true) into.overlapsChat = true;
    const known = new Set(into.messages.map((m: Untyped) => m.id));
    for (const message of messages) if (!known.has(message.id)) into.messages.push(message);
    into.messages.sort((x: Untyped, y: Untyped) => x.ts - y.ts);
    for (const id of window.hitIds ?? []) into.hitIds.add(id);
  }
  for (const window of out) window.messages.sort((x: Untyped, y: Untyped) => x.ts - y.ts);
  return out;
}

/**
 * The window the verbatim fallback shows when the summary gives no answer
 * (failed, timed out or skipped): among the first `among` windows -- the
 * newest, as the runner keeps them in clusterHits' order -- the one with the
 * most matched lines (its messages whose id is in its `hitIds`), the newer
 * one on a tie. Null when there is no window.
 * @param windows  Newest first.
 * @param [among]  FALLBACK_AMONG when missing or below 1.
 */
export function fallbackWindow(
  windows: Array<{ messages?: Array<Record<string, Untyped>>; hitIds?: Iterable<string> }>,
  among: number = FALLBACK_AMONG
): Untyped {
  const list = (Array.isArray(windows) ? windows : []).filter(Boolean).slice(0, intAtLeast(among, FALLBACK_AMONG, 1));
  let best = null;
  let bestCount = -1;
  for (const window of list) {
    const hits = new Set(window.hitIds ?? []);
    const count = (window.messages ?? []).filter((m) => m?.id && hits.has(m.id)).length;
    if (count > bestCount) {
      best = window;
      bestCount = count;
    }
  }
  return best;
}

/**
 * A message of a stretch without indices: no reply marker, and its call marks
 * (src/format.ts#withCalls) name their target by link or channel, never by a number.
 */
function unnumbered(message: Untyped) {
  const out = { ...message, replyToId: null };
  for (const key of ['calls', 'callsAfter']) {
    if (Array.isArray(message[key])) out[key] = message[key].map((mark) => ({ ...mark, targetId: null }));
  }
  return out;
}

/**
 * The windows rendered as transcript lines with the transcript functions of
 * src/format.ts (the chat form: gap and date markers, media tags
 * with the `descriptions` captions, reactions; wording from `labels`). A
 * message whose id is in the window's `hitIds` gets HIT_MARK at the start
 * of its own first line (`#n [time] Name: ...`, after any gap or date
 * marker, before the rest of a message with line breaks).
 * `indexed` true keeps the `#n` index of each line, numbered across all
 * windows so a reply marker points inside its own window; false (the
 * stretch handed to the persona, which must not mistake them for chat
 * indices) drops the index from that first line and the reply markers with
 * it; the message's own text is left as it is.
 */
export function renderRecallWindows(
  windows: Array<RenderRecallWindowsInput>,
  {
    labels,
    timezone = 'UTC',
    selfName = '',
    gapMinutes = GAP_MARKER_MINUTES,
    maxChars = MAX_MESSAGE_CHARS,
    seeReactions = true,
    reactionsPerMessage,
    indexed = true,
  }: RenderRecallWindowsArg2 = {}
): Array<RenderRecallWindowsResult> {
  const out = [];
  let offset = 0;
  for (const window of Array.isArray(windows) ? windows : []) {
    const messages = (window?.messages ?? []).filter(Boolean);
    if (messages.length === 0) continue;
    const hits = new Set(window.hitIds ?? []);
    const items = formatTranscript(indexed ? messages : messages.map(unnumbered), {
      timezone,
      gapMinutes,
      maxChars,
      selfName,
      labels,
      descriptions: window.descriptions,
      seeReactions,
      reactionsPerMessage,
      indexOffset: offset,
    });
    if (indexed) offset += messages.length;
    const lines = items.map((item) => {
      const parts = item.text.split('\n');
      // The message's own first line: the first opening with its `#n [` index (markers come before it).
      const found = parts.findIndex((part) => part.startsWith(`#${item.index} [`));
      const at = found === -1 ? 0 : found;
      if (!indexed) parts[at] = parts[at].replace(LINE_INDEX_RE, '');
      const hit = hits.has(item.id);
      if (hit) parts[at] = `${HIT_MARK}${parts[at]}`;
      return { id: item.id, ts: item.ts, text: parts.join('\n'), hit };
    });
    out.push({ placeId: window.placeId, channelName: window.channelName ?? null, startTs: messages[0].ts, lines });
  }
  return out;
}

/** The weight a stored item other than an episode ranks with: an episode's default weight. */
const NEUTRAL_WEIGHT = 3;
/** The mark of an absent field in a `<memory>` line. */
const NO_FIELD = '-';

/** The folded, non-empty, distinct forms of `list` (src/memory/recent.js#foldText). */
function foldedForms(list: Untyped) {
  return [
    ...new Set(
      (Array.isArray(list) ? list : [])
        .filter((form) => typeof form === 'string')
        .map(foldText)
        .filter(Boolean)
    ),
  ];
}

/** How many of `forms` (folded) occur, word endings allowed (src/memory/mentions.ts#occursAsWordStem), in at least one of `texts` (folded here). */
function formsMatched(texts: Untyped, forms: Untyped) {
  const folded = texts.filter((text: string) => typeof text === 'string' && text).map(foldText);
  return forms.filter((form: Untyped) => folded.some((text: string) => occursAsWordStem(text, form))).length;
}

/**
 * How many of `forms` occur in `texts` by recall's own matching (folded, word endings allowed:
 * formsMatched over foldedForms). The prefetch's relevance check (src/behavior/prefetch.ts). Pure.
 */
export function countFormsIn(texts: Array<unknown>, forms: Array<string>): number {
  return formsMatched(Array.isArray(texts) ? texts : [], foldedForms(forms));
}

/** A time from an ISO string, or -Infinity. */
function isoMs(value: Untyped) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : -Infinity;
}

/** A string field on one line, or ''. */
function textOf(value: Untyped) {
  return typeof value === 'string' ? oneLine(value) : '';
}

/** How many archive candidates per `<memory>` item scanArchive keeps while it streams. */
const ARCHIVE_CANDIDATES_PER_ITEM = 4;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The default order of matched items: score, weight, the newer, the newer addition, input order. */
function byScore(a: Untyped, b: Untyped) {
  return b.score - a.score || b.weight - a.weight || b.ts - a.ts || b.ts2 - a.ts2 || a.order - b.order;
}

/** The order of a vague "recently": the persona's own exchanges first, then the newer, then score and weight. */
function byRecency(a: Untyped, b: Untyped) {
  return (
    Number(b.self === true) - Number(a.self === true) ||
    b.ts - a.ts ||
    b.ts2 - a.ts2 ||
    b.score - a.score ||
    b.weight - a.weight ||
    a.order - b.order
  );
}

/**
 * The matching context shared by matchMemory and scanArchive: the folded
 * forms, the members the name forms pick, the range tests and the scorer;
 * null when nothing is asked (no form, and no meaning row with `anyway`).
 */
function memoryContext({ forms, who, profiles, from, to, timezone, anyway = false }: MemoryContextInput) {
  const whoForms = foldedForms(who);
  const allForms = foldedForms([...(Array.isArray(forms) ? forms : []), ...(Array.isArray(who) ? who : [])]);
  if (allForms.length === 0 && !anyway) return null;
  const ranged = Number.isFinite(from) || Number.isFinite(to);
  const fromDay = Number.isFinite(from) ? zonedDay(from, timezone) : null;
  const toDay = Number.isFinite(to) ? zonedDay(to, timezone) : null;
  const people = new Set();
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    if (!profile || typeof profile !== 'object') continue;
    const id = accountIdOf(profile.id);
    if (id === null || whoForms.length === 0) continue;
    const names = [
      ...(Array.isArray(profile.aliases) ? profile.aliases : []).map((alias: Untyped) => alias?.name),
      ...(Array.isArray(profile.names) ? profile.names : []),
    ];
    if (names.some((name) => typeof name === 'string' && whoForms.includes(foldText(name)))) people.add(id);
  }
  return {
    timezone,
    ranged,
    people,
    dayInside: (day: Untyped) =>
      !ranged || (Boolean(day) && (fromDay === null || day >= fromDay) && (toDay === null || day <= toDay)),
    atInside: (at: number) =>
      !ranged || (Number.isFinite(at) && (!Number.isFinite(from) || at >= from) && (!Number.isFinite(to) || at <= to)),
    namesPerson: (texts: Untyped, extraIds = []) =>
      [...extraIds, ...texts.flatMap((text: string) => tokenIds(text))].some((id) => people.has(String(id))),
    score: (texts: Untyped, person: Untyped) => formsMatched(texts, allForms) + (person ? 1 : 0),
  };
}

/** The local day of an archive entry's `observedAt` (a stored day as it is, a time in `timezone`), or null. */
function observedDay(observedAt: Untyped, timezone: Untyped) {
  const date = isPlainObject(observedAt) ? observedAt.date : null;
  if (typeof date !== 'string' || !date) return null;
  if (DAY_KEY_RE.test(date)) return date;
  const ms = Date.parse(date);
  return Number.isFinite(ms) ? zonedDay(ms, timezone) : null;
}

/**
 * One archive entry (src/memory/archive.js#archiveEntry) as a matched item,
 * or null when it matches nothing (or lies outside the range). Searched: the
 * entry's `neutral` and its `text.*` fields -- an episode's `what` and
 * `quote`, never its `feeling`; a participation episode's message texts.
 * Rendered text: an episode as matchMemory renders one; a participation
 * episode as `name: text` per message joined by ` / `; another kind its
 * string fields joined by `: `; the `neutral` text when those are empty.
 * `self` when it holds a line of the persona (a participation episode).
 * With `matched` false (an entry the meaning search found) a score of 0 keeps it.
 */
function archivedItem(entry: Record<string, Untyped>, ctx: Untyped, { matched = true } = {}) {
  if (!isPlainObject(entry) || typeof entry.itemKind !== 'string' || !entry.itemKind) return null;
  const fields = isPlainObject(entry.text) ? entry.text : {};
  let texts;
  let text;
  let self = false;
  if (entry.itemKind === 'participation') {
    const messages = (Array.isArray(fields.messages) ? fields.messages : []).filter(isPlainObject);
    self = messages.some((m: Untyped) => m.self === true);
    const said = messages
      .map((m: Untyped) => ({ name: textOf(m.name), text: textOf(m.text) }))
      .filter((m: Untyped) => m.text);
    texts = said.map((m: Untyped) => m.text);
    text = said.map((m: Untyped) => (m.name ? `${m.name}: ${m.text}` : m.text)).join(' / ');
  } else if (entry.itemKind === 'episode') {
    const what = textOf(fields.what);
    const quote = textOf(fields.quote);
    texts = [what, quote];
    text = what && quote ? `${what} "${quote}"` : what || quote;
  } else {
    texts = Object.values(fields).map(textOf).filter(Boolean);
    text = texts.join(': ');
  }
  const neutral = textOf(entry.neutral);
  text ||= neutral;
  if (!text) return null;
  const date = observedDay(entry.observedAt, ctx.timezone);
  if (!ctx.dayInside(date)) return null;
  const accountId = typeof entry.scope?.user === 'string' && entry.scope.user ? entry.scope.user : null;
  const ids = [...(Array.isArray(entry.participants) ? entry.participants : []), ...(accountId ? [accountId] : [])];
  const searched = [...texts, neutral];
  const score = ctx.score(searched, ctx.namesPerson(searched, ids));
  if (score <= 0 && matched) return null;
  const observed =
    isPlainObject(entry.observedAt) && typeof entry.observedAt.date === 'string' ? entry.observedAt.date : '';
  return {
    kind: `archived ${entry.itemKind}`,
    text,
    date,
    accountId,
    itemId: typeof entry.itemId === 'string' && entry.itemId ? entry.itemId : null,
    self,
    weight: Number.isFinite(entry.weight) ? entry.weight : NEUTRAL_WEIGHT,
    ts: DAY_KEY_RE.test(observed) ? Date.parse(`${observed}T00:00:00Z`) : isoMs(observed),
    ts2: isoMs(entry.recordedAt),
    score,
  };
}

export function matchMemory({
  forms = [],
  who = [],
  profiles = [],
  lore = [],
  learned = [],
  recentLines = [],
  archived = [],
  meaning = [],
  from = null,
  to = null,
  max,
  timezone = 'UTC',
  recent = false,
  locator = null,
}: MatchMemoryInput = {}): Array<MatchMemoryResult> {
  const limit = intAtLeast(max, RECALL_DEFAULTS.memoryItems, 0);
  const list = (value: Untyped) =>
    Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
  const meant = list(meaning);
  const ctx = memoryContext({ forms, who, profiles, from, to, timezone, anyway: meant.length > 0 });
  if (limit === 0 || ctx === null) return [];
  const { people, namesPerson, dayInside, atInside, ranged } = ctx;
  const itemIdOf = (value: Untyped) => (typeof value?.itemId === 'string' && value.itemId ? value.itemId : null);

  const found: Array<Untyped> = [];
  const add = (item: Untyped, texts: Untyped, person: Untyped) => {
    const score = ctx.score(texts, person);
    if (score > 0) found.push({ itemId: null, self: false, ...item, score, order: found.length });
  };

  for (const profile of list(profiles)) {
    const accountId = accountIdOf(profile.id);
    if (accountId === null) continue;
    for (const ep of list(profile.episodes)) {
      const what = textOf(ep.what);
      if (!what) continue;
      const date = episodeDate(ep.date) || null;
      if (!dayInside(date)) continue;
      const quote = textOf(ep.quote);
      const texts = [what, quote];
      const item = {
        kind: 'episode',
        text: quote ? `${what} "${quote}"` : what,
        date,
        accountId,
        itemId: itemIdOf(ep),
        weight: Number.isFinite(ep.weight) ? ep.weight : NEUTRAL_WEIGHT,
        ts: date ? Date.parse(`${date}T00:00:00Z`) : -Infinity,
        ts2: isoMs(ep.addedAt),
      };
      add(item, texts, people.has(accountId) || namesPerson(texts));
    }
  }
  // Lore and learned items carry no date: a range leaves them out.
  if (!ranged) {
    for (const entry of list(lore)) {
      const title = textOf(entry.title);
      const text = textOf(entry.text);
      if (!text) continue;
      const keys = Array.isArray(entry.keys) ? entry.keys.filter((key: Untyped) => typeof key === 'string') : [];
      const item = {
        kind: 'lore',
        text: title ? `${title}: ${text}` : text,
        date: null,
        accountId: null,
        itemId: itemIdOf(entry),
        weight: NEUTRAL_WEIGHT,
        ts: isoMs(entry.updatedAt || entry.createdAt),
        ts2: 0,
      };
      add(item, [title, ...keys, text], namesPerson([title, text]));
    }
    for (const entry of list(learned)) {
      const text = textOf(entry.text);
      if (!text) continue;
      const teacher = typeof entry.from === 'string' ? (TEACHER_TOKEN_RE.exec(entry.from.trim())?.[1] ?? null) : null;
      const item = {
        kind: 'learned',
        text,
        date: null,
        accountId: teacher,
        itemId: itemIdOf(entry),
        weight: NEUTRAL_WEIGHT,
        ts: isoMs(entry.lastSeen),
        ts2: 0,
      };
      add(item, [text], namesPerson([text]));
    }
  }
  for (const line of list(recentLines)) {
    const text = textOf(line.text);
    if (!text || !Number.isFinite(line.at) || !atInside(line.at)) continue;
    const item = {
      kind: 'recent',
      text,
      date: zonedDay(line.at, timezone),
      accountId: null,
      itemId: itemIdOf(line),
      weight: NEUTRAL_WEIGHT,
      ts: line.at,
      ts2: 0,
    };
    add(item, [text], namesPerson([text], Array.isArray(line.who) ? line.who : []));
  }

  // The archive: an item still hot is its hot copy; of an item's archived revisions the newest recorded stands.
  const hotIds = new Set(found.map((item) => item.itemId).filter(Boolean));
  const newest = new Map();
  const loose = [];
  for (const entry of list(archived)) {
    const item = archivedItem(entry, ctx);
    if (!item || (item.itemId && hotIds.has(item.itemId))) continue;
    if (!item.itemId) {
      loose.push(item);
      continue;
    }
    const known = newest.get(item.itemId);
    if (!known || item.ts2 >= known.ts2) newest.set(item.itemId, item);
  }
  for (const item of [...newest.values(), ...loose]) found.push({ ...item, order: found.length });

  const ordered = found.sort(recent ? byRecency : byScore);
  let chosen = ordered;
  let fusedScore = null;
  if (meant.length > 0) {
    // The meaning search's entries: the matched item of the same itemId, else their own archived item.
    const byItemId = new Map();
    for (const item of ordered) if (item.itemId && !byItemId.has(item.itemId)) byItemId.set(item.itemId, item);
    const meaningItems: Array<Untyped> = [];
    for (const entry of meant) {
      const itemId = itemIdOf(entry);
      const item = (itemId && byItemId.get(itemId)) || archivedItem(entry, ctx, { matched: false });
      if (item && !meaningItems.includes(item)) meaningItems.push(item);
    }
    const fused = fuseRanks([meaningItems, ordered]);
    chosen = fused.map((entry) => entry.id);
    fusedScore = new Map(fused.map((entry) => [entry.id, entry.score]));
  }
  let picked: Array<{ item: Untyped; share: 'broad' | 'dated' | null }> = chosen
    .slice(0, limit)
    .map((item) => ({ item, share: null }));
  const near = usableLocator(locator);
  if (near) {
    // A dated item's local day against the locator; the bonus in the unit of the order: one form, or one top rank fused.
    const position = new Map<Untyped, number>(chosen.map((item, i): [Untyped, number] => [item, i]));
    const unit = fusedScore ? 1 / (RRF_K + 1) : 1;
    const boosted = new Map<Untyped, number>(
      chosen.map((item): [Untyped, number] => {
        const day = item.date ? dateSide(item.date) : null;
        const bonus = day ? proximityBonus(sideStart(day, timezone), sideEnd(day, timezone), near) : 0;
        return [item, (fusedScore ? fusedScore.get(item) : item.score) + unit * bonus];
      })
    );
    const byPosition = (a: Untyped, b: Untyped) => (position.get(a) ?? 0) - (position.get(b) ?? 0);
    picked = locatorKeep(chosen, {
      keep: limit,
      broadShare: near.broadShare,
      broadOrder: byPosition,
      datedOrder: (a, b) => (boosted.get(b) ?? 0) - (boosted.get(a) ?? 0) || byPosition(a, b),
    });
  }
  return picked.map(({ item: { kind, text, date, accountId, itemId, self, score }, share }) => ({
    kind,
    text,
    date,
    accountId,
    itemId,
    self,
    score,
    ...(share ? { share } : {}),
  }));
}

/**
 * The archive entries a recall question may use, read from `entries` (an
 * async or sync iterable, as src/memory/archive.js#iterate streams a
 * segment's lines one by one) without holding the archive in memory: each
 * entry `allow` refuses is skipped before it is matched (the caller's
 * audience and private-owner rule); each one archivedItem matches is a
 * candidate, and at most `max` x ARCHIVE_CANDIDATES_PER_ITEM (4) of the best
 * (matchMemory's order, `recent` included) are kept while the stream runs.
 * Stops at an aborted `signal`. Returns the kept entries, best first, for
 * matchMemory's `archived`; none for a `max` of 0 or nothing asked.
 */
export async function scanArchive(
  entries: AsyncIterable<Record<string, Untyped>> | Iterable<Record<string, Untyped>> | null | undefined,
  {
    forms = [],
    who = [],
    profiles = [],
    from = null,
    to = null,
    timezone = 'UTC',
    recent = false,
    allow,
    max,
    signal,
  }: ScanArchiveArg2 = {}
): Promise<Array<Record<string, Untyped>>> {
  const limit = intAtLeast(max, RECALL_DEFAULTS.memoryItems, 0);
  const ctx = memoryContext({ forms, who, profiles, from, to, timezone });
  const iterable =
    entries &&
    (typeof Reflect.get(entries, Symbol.asyncIterator) === 'function' ||
      typeof Reflect.get(entries, Symbol.iterator) === 'function');
  if (limit === 0 || ctx === null || !iterable) return [];
  const bound = limit * ARCHIVE_CANDIDATES_PER_ITEM;
  const order = recent ? byRecency : byScore;
  let kept: Array<Untyped> = [];
  let seen = 0;
  for await (const entry of entries) {
    if (signal?.aborted) break;
    if (typeof allow === 'function' && !allow(entry)) continue;
    const item = archivedItem(entry, ctx);
    if (!item) continue;
    kept.push({ ...item, order: seen, entry });
    seen += 1;
    if (kept.length >= bound * 2) kept = kept.sort(order).slice(0, bound);
  }
  return kept
    .sort(order)
    .slice(0, bound)
    .map((item) => item.entry);
}

/**
 * The `<memory>` line of one matchMemory item: `kind | date | name | text`,
 * structural fields only -- `kind` the item's kind code (`archived <itemKind>`
 * for an archive entry), `date` its date or
 * `-`, `name` the display name `nameOf` gives its `accountId` or `-`, `text`
 * on one line with `<@id>` tokens resolved through `nameOf` (an unresolved
 * one stays as stored).
 */
function memoryLine(item: Untyped, nameOf: Untyped) {
  const resolve = typeof nameOf === 'function' ? nameOf : () => null;
  const name = item?.accountId ? oneLine(resolve(item.accountId) ?? '') : '';
  const text = oneLine(fromTokens(String(item?.text ?? ''), resolve, 'chat'));
  return `${item?.kind} | ${item?.date || NO_FIELD} | ${name || NO_FIELD} | ${text}`;
}

/** The `<people>` line of one found member: `name | username | count | newest date` (structural fields). */
function personLine(person: Untyped, timezone: Untyped) {
  const newest = Number.isFinite(person?.newestTs) ? zonedDay(person.newestTs, timezone) : '';
  const count = Number.isFinite(person?.count) ? person.count : 0;
  return `${oneLine(person?.name)} | ${oneLine(person?.username)} | ${count} | ${newest}`.trimEnd();
}

/**
 * The `<time_cue>` text: `labels.lookup.timeEstimate` (trimmed) with `{range}`
 * the local days of the cue in `timezone` -- `YYYY-MM-DD` for one day,
 * `YYYY-MM-DD .. YYYY-MM-DD` for several, an open side left empty -- or ''
 * without a cue with a finite side or without the label.
 */
function timeCueText(cue: Untyped, labels: Untyped, timezone: Untyped) {
  const template = labels?.lookup?.timeEstimate;
  if (!isPlainObject(cue) || typeof template !== 'string' || !template.trim()) return '';
  const from = Number.isFinite(cue.from) ? zonedDay(cue.from, timezone) : '';
  const to = Number.isFinite(cue.to) ? zonedDay(cue.to, timezone) : '';
  if (!from && !to) return '';
  const range = from === to ? from : `${from} .. ${to}`.trim();
  return fill(template.trim(), { range });
}

export function buildRecallRequest({
  prompt,
  selfName,
  question,
  people = [],
  windows,
  memory = [],
  context = [],
  contextDescriptions,
  replyQuoteChars,
  nameOf,
  labels,
  timezone = 'UTC',
  answerChars,
  now,
  maxChars = MAX_MESSAGE_CHARS,
  gapMinutes = GAP_MARKER_MINUTES,
  seeReactions = true,
  reactionsPerMessage,
  memoryTokens,
  timeCue = null,
}: BuildRecallRequestInput): Array<{ role: string; content: string }> | null {
  if (typeof prompt !== 'string' || !prompt.trim()) return null;
  const rendered = renderRecallWindows(windows, {
    labels,
    timezone,
    selfName,
    gapMinutes,
    maxChars,
    seeReactions,
    reactionsPerMessage,
    indexed: true,
  });
  const notes = (Array.isArray(memory) ? memory : []).filter(
    (item) => item && typeof item.text === 'string' && item.text.trim()
  );
  // The <memory> lines in order, until the next one would pass `memoryTokens`.
  const tokenCap = isFiniteNumber(memoryTokens) && memoryTokens >= 0 ? memoryTokens : Infinity;
  const memoryLines = [];
  let memoryUsed = 0;
  for (const item of notes) {
    const line = memoryLine(item, nameOf);
    const cost = estimateTokens(line);
    if (memoryUsed + cost > tokenCap) break;
    memoryUsed += cost;
    memoryLines.push(line);
  }
  if (rendered.length === 0 && memoryLines.length === 0) return null;
  // The windows renderRecallWindows rendered, in its order (it skips the ones without a message).
  const sources = (Array.isArray(windows) ? windows : []).filter(
    (window) => (window?.messages ?? []).filter(Boolean).length > 0
  );
  const flag = (key: Untyped) => {
    const label = labels?.lookup?.[key];
    // Trimmed: a label written with its own leading space never doubles the separator.
    return typeof label === 'string' && label.trim() ? ` ${label.trim()}` : '';
  };
  const sections = rendered.map((window, i) => {
    const source = sources[i];
    const self = (source?.messages ?? []).some((m: Untyped) => m?.self === true) ? flag('stretchSelf') : '';
    const current = source?.overlapsChat === true ? flag('stretchCurrent') : '';
    // A protocol mark, not wording: the window was read from the record, not found by the search.
    const origin = source?.source === 'record' ? ' | source: record' : '';
    return [
      `## ${i + 1} | ${zonedDay(window.startTs, timezone)} | #${oneLine(window.channelName)}${origin}${self}${current}`,
      ...window.lines.map((line) => line.text),
    ].join('\n');
  });
  const chat = (Array.isArray(context) ? context : []).filter(Boolean);
  let contextText = '';
  if (chat.length > 0) {
    const items = formatTranscript(chat, {
      timezone,
      gapMinutes,
      maxChars,
      selfName,
      labels,
      seeReactions,
      reactionsPerMessage,
      replyQuoteChars,
      descriptions: contextDescriptions,
      indexOffset: sources.reduce((sum, window) => sum + window.messages.filter(Boolean).length, 0),
    });
    contextText = renderTranscript(items, timezone, labels);
  }
  const text = [...String(question?.content ?? '')].slice(0, maxChars).join('');
  const user = [
    block('people', (Array.isArray(people) ? people : []).map((p) => personLine(p, timezone)).join('\n')),
    block('memory', memoryLines.join('\n')),
    block('found', sections.join('\n\n')),
    block('context', contextText),
    block('time_cue', timeCueText(timeCue, labels, timezone)),
    block('question', `${oneLine(question?.authorName)}: ${text}`),
  ]
    .filter(Boolean)
    .join('\n');
  const values: Record<string, string | number> = { name: selfName ?? '', answerChars };
  if (isFiniteNumber(now)) values.today = zonedDay(now, timezone);
  return [
    { role: 'system', content: fillPromptTemplate(prompt, values) },
    { role: 'user', content: user },
  ];
}

/**
 * The summary's answer. A first non-empty line `stretch: <n>` (any
 * case) names the `<found>` section that answers the question: `n` within
 * `1..count` (a `#` before it tolerated) -> `stretch` n, `none` or anything
 * else -> null; that line is not part of the text. The rest, trimmed and
 * clamped with clampText to `answerChars` (soft, the prompt names the
 * limit), is the text; empty or the single word `nothing` (quotes and
 * trailing punctuation aside) gives text null and no stretch.
 */
export function parseRecallAnswer(
  raw: unknown,
  { answerChars, count = 0 }: { answerChars?: number; count?: number } = {}
): { text: string | null; stretch: number | null } {
  const lines = String(raw ?? '').split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim());
  if (first === -1) return { text: null, stretch: null };
  let stretch = null;
  let rest = lines.slice(first);
  const named = STRETCH_RE.exec(rest[0].trim());
  if (named) {
    const number = /^#?(\d+)$/.exec(stripLine(named[1]));
    const n = number ? Number(number[1]) : NaN;
    if (Number.isSafeInteger(n) && n >= 1 && n <= count) stretch = n;
    rest = rest.slice(1);
  }
  const body = rest.join('\n').trim();
  if (!body || NOTHING_RE.test(stripLine(body))) return { text: null, stretch: null };
  const text = clampText(body, intAtLeast(answerChars, RECALL_DEFAULTS.answerChars, 1));
  return text ? { text, stretch } : { text: null, stretch: null };
}

/**
 * The lines of a stretch cut to `maxChars` (their texts joined by line
 * breaks, counted in code points) by dropping whole lines from its far ends:
 * each time from the end with more lines outside the matched ones, the
 * older end on a tie. A matched line (`hit`) is never dropped, so the result
 * may stay longer than `maxChars`. A `maxChars` that is not a finite number
 * of at least 0 keeps every line.
 */
export function cutStretch<TLine extends { text: string; hit: boolean }>(
  lines: Array<TLine>,
  maxChars: number
): Array<TLine> {
  const list = Array.isArray(lines) ? [...lines] : [];
  if (!Number.isFinite(maxChars) || maxChars < 0) return list;
  const size = (from: Untyped, to: Untyped) =>
    list.slice(from, to).reduce((sum, line, i) => sum + (i > 0 ? 1 : 0) + [...line.text].length, 0);
  let start = 0;
  let end = list.length;
  const firstHit = list.findIndex((line) => line.hit);
  const lastHit = list.findLastIndex((line) => line.hit);
  while (end > start && size(start, end) > maxChars) {
    const before = firstHit === -1 ? end - start : firstHit - start;
    const after = lastHit === -1 ? 0 : end - 1 - lastHit;
    if (before <= 0 && after <= 0) break;
    if (before >= after) start += 1;
    else end -= 1;
  }
  return list.slice(start, end);
}

/** How many reply parents a record hit's chain follows at most. */
const REPLY_CHAIN_MAX = 10;
/** How many record hits per kept window are turned into windows before the ranking. */
const RECORD_HITS_PER_WINDOW = 4;
/** What a record line naming a sought member (a name form, an alias or the member) adds: less than one topic form, so it only locates the person. */
const RECORD_NAME_WEIGHT = 0.5;
/** How far before a meaning row's line the record is read for its reply chain and neighbours. */
const MEANING_READ_BEFORE_MS = 6 * 60 * MINUTE_MS;
/** How far after it: room for the neighbours and a whole followed conversation. */
const MEANING_READ_AFTER_MS = 2 * 60 * MINUTE_MS;

/**
 * The record reads around the meaning rows not read yet: one time span per row
 * (MEANING_READ_BEFORE_MS before its line, MEANING_READ_AFTER_MS after), spans
 * that meet merged, each with the channels of its rows.
 */
function meaningSpans(rows: Untyped) {
  const spans = rows
    .map((row: Untyped) => ({
      from: row.ts - MEANING_READ_BEFORE_MS,
      to: row.ts + MEANING_READ_AFTER_MS,
      channels: new Set([row.placeId]),
    }))
    .sort((a: Untyped, b: Untyped) => a.from - b.from);
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.from <= last.to) {
      last.to = Math.max(last.to, span.to);
      for (const channel of span.channels) last.channels.add(channel);
    } else {
      merged.push(span);
    }
  }
  return merged;
}

/** The usable meaning rows of matchRecord's `meaning`, in their order: `{ id, placeId, ts, sourceIds }`. */
function meaningRows(meaning: Untyped) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(meaning) ? meaning : []) {
    const ts = Date.parse(row?.occurredAt);
    if (
      typeof row?.id !== 'string' ||
      !row.id ||
      seen.has(row.id) ||
      typeof row.placeId !== 'string' ||
      !row.placeId ||
      !Number.isFinite(ts)
    )
      continue;
    seen.add(row.id);
    out.push({
      id: row.id,
      placeId: row.placeId,
      ts,
      sourceIds: Array.isArray(row.sourceIds) ? row.sourceIds.filter((id: Untyped) => typeof id === 'string') : [],
    });
  }
  return out;
}

/**
 * The links of a record line (src/memory/record.js#recordLinks) as normalized chat links: a
 * `link` with its site, title and description (`text`), rendered like a live link preview; a line
 * without `links` has none.
 */
function recordLinkItems(line: Untyped) {
  const str = (value: Untyped) => (typeof value === 'string' ? value : '');
  return (Array.isArray(line.links) ? line.links : [])
    .filter((link: Untyped) => isPlainObject(link) && (str(link.title) || str(link.description)))
    .map((link: Untyped, i: Untyped) => ({
      id: str(link.id) || `${line.messageId}#l${i}`,
      kind: 'link',
      site: str(link.site),
      title: str(link.title),
      text: str(link.description),
      url: str(link.url) || null,
      thumbnailUrl: null,
    }));
}

/** The searchable texts of a record message: its text, then each link's title and description. */
function recordTexts(message: Untyped) {
  return [message.content, ...message.links.flatMap((link: Untyped) => [link.title, link.text])];
}

/**
 * A record line (src/memory/record.js) as a normalized chat message (the shape renderRecallWindows
 * reads): the persona's own `said` line marked `self` under `selfName`, any other author under
 * `nameOf(by)`, else `-`; its `links` as link previews. The one copy: scripts/recall-eval.ts reads
 * the record's chat through it too. `line.scope.channel` must be set.
 */
export function recordMessage(
  line: Record<string, Untyped>,
  { nameOf, selfName }: { nameOf?: ((id: string) => string | null | undefined) | null; selfName?: string }
): Record<string, Untyped> {
  const self = line.kind === 'said';
  const by = typeof line.by === 'string' && line.by ? line.by : null;
  const name = self ? oneLine(selfName ?? '') : by && typeof nameOf === 'function' ? oneLine(nameOf(by) ?? '') : '';
  return {
    id: line.messageId,
    placeId: line.scope.channel,
    authorId: by,
    authorName: name || NO_FIELD,
    self,
    bot: false,
    content: typeof line.text === 'string' ? line.text : '',
    ts: Date.parse(line.occurredAt),
    replyToId: typeof line.replyTo === 'string' && line.replyTo ? line.replyTo : null,
    mentionedAccountIds: Array.isArray(line.mentions) ? line.mentions : [],
    attachments: [],
    links: recordLinkItems(line),
    stickers: [],
    emojis: [],
    forwarded: [],
    reactions: [],
  };
}

/**
 * The bounded record reader: the lines of the persona's record
 * (src/memory/record.js, `record.iterate`) that answer a recall question,
 * as windows for the summary beside the search's (buildRecallRequest marks them
 * `source: record`). Read: the record days of `range` -- from the end of the
 * range (`now` when open or later) back at most `recordDays` days, never
 * before its start -- and only those (`recordDays` 0 reads nothing). Each
 * line `allowLine` refuses is skipped before it is matched (the caller's
 * audience and private-owner rule); the newest revision of a message
 * stands, a deleted message goes, `felt` lines are not chat. A line matches
 * when a form of `forms` (the topic) or `aliases` (the name forms: the
 * `who:` forms, the members' names and alias names) occurs in its text or in the
 * title or description of a link it carries (its `links`, shown in its window as a
 * link preview), word endings allowed (occursAsWordStem), both folded, or when its author or
 * `participants` name one of `participants`; `score` = topic forms matched
 * + RECORD_NAME_WEIGHT when a name form or a member matches (once): a name
 * or member match only locates the person, below any topic match. Lines whose id is in `exclude` (the turn's own chat) are never
 * hits nor shown; a window that lost one is `overlapsChat`. Each hit's
 * window, in its channel: its reply chain (`replyTo` within the scanned
 * days, at most REPLY_CHAIN_MAX parents), the `recordContext` lines before
 * and after it, and the hit, then followed past its last line along the
 * channel's lines read (followConversation with `followMessages` and
 * `followGapMinutes`, RECALL_DEFAULTS when missing); windows sharing a line are merged
 * (mergeWindows), every hit inside a window is in its `hitIds`. At most
 * `maxWindows` windows are kept: by their best score, then the newer last
 * line; with `recent` (isRecentCue) a window with a line of the persona
 * first, then the newer. A dateless question (no `range` bound) without
 * `recent` reads the last `recordDays` days and reserves one kept window for
 * its earliest hit among those with the best score (the origin of a phrase
 * repeated since), unless that window is kept anyway; a dated or recent
 * question has no such reservation. Returned newest first, each
 * `{ source: 'record', placeId, channelName, messages, hitIds, overlapsChat }`
 * (`channelName` from `channelNameOf`; authors' names from `nameOf`, the
 * persona's own lines under `selfName`). Stops reading at an aborted `signal`.
 * `meaning`: the record rows the meaning search found, best first
 * (`{ id, placeId, occurredAt, sourceIds }`, any age). The record around
 * each row not read yet is read too (MEANING_READ_BEFORE_MS before its line,
 * MEANING_READ_AFTER_MS after, its channel only, through `allowLine`); a row
 * whose line is not found, is deleted or excluded, or one of whose
 * `sourceIds` lines `allowLine` refused, is dropped; the rest are hits by
 * their meaning rank (with `recordDays` 0 the only ones). The hits are then
 * ordered by fuseRanks over (meaning rank, word-hit rank in the order above),
 * windows are built the same way around the fused best -- neighbours and the
 * follow never crossing from one read stretch into another -- and kept by
 * their best fused score (with `recent`: a persona's line first, then the
 * newer, then that score), with no window reserved for the earliest word
 * hit; instead the best word hit matching a topic form (by its word score,
 * then the newer) keeps one kept window, unless that window is kept anyway
 * (without a locator; none without a topic-matched hit). Without a usable
 * row nothing changes.
 * `locator` (a `when:` that only locates, `{ from, to, bonus, decayDays,
 * broadShare }`; the caller passes no `range` then): besides the last
 * `recordDays` days the locator's own days are read as a dated question's
 * would be (one span when they meet); the hits best with the proximity
 * bonus (proximityBonus of the line's time, in the unit of the score: one
 * form, or 1 / (RRF_K + 1) fused) get windows beside the best without it;
 * the `maxWindows` slots are locatorKeep's -- the reserved share in the
 * order above, the rest by the best score + the bonus of the window's span
 * -- each kept window marked `share` (`broad` | `dated`); no window is
 * reserved for the earliest hit. Without a locator there is no `share` key.
 */
export async function matchRecord(
  placeId: string,
  {
    record,
    range = {},
    participants = [],
    forms = [],
    aliases = [],
    recordDays,
    recordContext,
    followMessages,
    followGapMinutes,
    now,
    maxWindows,
    allowLine,
    exclude,
    recent = false,
    nameOf,
    selfName = '',
    channelNameOf,
    meaning = [],
    locator = null,
    signal,
  }: MatchRecordArg2 = {}
): Promise<{ windows: Array<RecordWindow>; scanned: number; hits: number; meaningHits: number }> {
  const none = { windows: [], scanned: 0, hits: 0, meaningHits: 0 };
  const days = intAtLeast(recordDays, RECALL_DEFAULTS.recordDays, 0);
  const around = intAtLeast(recordContext, RECALL_DEFAULTS.recordContext, 0);
  const keep = intAtLeast(maxWindows, RECALL_DEFAULTS.maxClusters, 1);
  if (typeof record?.iterate !== 'function' || !isFiniteNumber(now)) return none;
  const textForms = foldedForms(forms);
  const nameForms = foldedForms(aliases).filter((form) => !textForms.includes(form));
  const people = new Set(
    (Array.isArray(participants) ? participants : []).filter((id) => typeof id === 'string' && id)
  );
  const wanted = meaningRows(meaning);
  const near = usableLocator(locator);
  const to = Math.min(isFiniteNumber(range?.to) ? range.to : now, now);
  const from = Math.max(isFiniteNumber(range?.from) ? range.from : -Infinity, to - days * DAY_MS);
  // The word scan's spans, oldest first: the range read, and with a locator its own days read as a scope would.
  const mainSpans = from <= to ? [{ from, to }] : [];
  if (near) {
    const nearTo = Math.min(Number.isFinite(near.to) ? near.to : now, now);
    const nearFrom = Math.max(Number.isFinite(near.from) ? near.from : -Infinity, nearTo - days * DAY_MS);
    const span = mainSpans[0];
    const meets = span && nearFrom <= span.to && nearTo >= span.from;
    if (nearFrom <= nearTo && meets) {
      span.from = Math.min(span.from, nearFrom);
      span.to = Math.max(span.to, nearTo);
    } else if (nearFrom <= nearTo) {
      mainSpans.push({ from: nearFrom, to: nearTo });
      mainSpans.sort((a, b) => a.from - b.from);
    }
  }
  const words = days > 0 && (textForms.length > 0 || nameForms.length > 0 || people.size > 0) && mainSpans.length > 0;
  if (!words && wanted.length === 0) return none;
  const excluded = exclude instanceof Set ? exclude : new Set(Array.isArray(exclude) ? exclude : []);

  // The scanned days: the newest revision of each message; a deleted one is null.
  const latest = new Map();
  // The ids of the word scan (only they are word hits) and of every line allowLine refused.
  const scannedIds = new Set();
  const refused = new Set();
  // The stretches read, [from, to]: the word scan's, then those around the meaning rows.
  const stretches: Array<Untyped> = [];
  let scanned = 0;
  const take = (line: Record<string, Untyped>, main: Untyped) => {
    if (!isPlainObject(line) || typeof line.messageId !== 'string' || !line.messageId) return;
    if (typeof allowLine === 'function' && !allowLine(line)) {
      refused.add(line.messageId);
      return;
    }
    if (main) {
      scanned += 1;
      scannedIds.add(line.messageId);
    }
    if (line.kind === 'deleted') {
      latest.set(line.messageId, null);
      return;
    }
    if (
      (line.kind !== 'seen' && line.kind !== 'said') ||
      typeof line.scope?.channel !== 'string' ||
      !Number.isFinite(Date.parse(line.occurredAt))
    )
      return;
    const known = latest.get(line.messageId);
    const revision = Number.isInteger(line.revision) && line.revision > 0 ? line.revision : 1;
    if (known === null || (known && known.revision >= revision)) return;
    latest.set(line.messageId, { line, revision });
  };
  for (const span of words ? mainSpans : []) {
    if (signal?.aborted) break;
    stretches.push(span);
    const query = { from: new Date(span.from).toISOString(), to: new Date(span.to).toISOString() };
    for await (const line of record.iterate(placeId, query)) {
      if (signal?.aborted) break;
      take(line, true);
    }
  }
  for (const span of meaningSpans(wanted.filter((row) => !latest.has(row.id)))) {
    if (signal?.aborted) break;
    stretches.push(span);
    const query = {
      from: new Date(span.from).toISOString(),
      to: new Date(span.to).toISOString(),
      placeIds: [...span.channels],
    };
    for await (const line of record.iterate(placeId, query)) {
      if (signal?.aborted) break;
      take(line, false);
    }
  }

  const byId = new Map();
  const byChannel = new Map();
  const named = new Map();
  for (const entry of latest.values()) {
    if (!entry) continue;
    const message = recordMessage(entry.line, { nameOf, selfName });
    byId.set(message.id, message);
    named.set(message.id, [
      message.authorId,
      ...(Array.isArray(entry.line.participants) ? entry.line.participants : []),
    ]);
    if (!byChannel.has(message.placeId)) byChannel.set(message.placeId, []);
    byChannel.get(message.placeId).push(message);
  }
  const position = new Map();
  // Each line's run: the first and last index of the lines of its channel read in one stretch,
  // so neighbours and the follow never join two stretches read apart (one run without meaning rows).
  const runOf = new Map();
  const stretchOf = (ts: Untyped) =>
    stretches.length <= 1 ? 0 : stretches.findIndex((s) => ts >= s.from && ts <= s.to);
  for (const list of byChannel.values()) {
    list.sort((x: Untyped, y: Untyped) => x.ts - y.ts || (x.id < y.id ? -1 : 1));
    list.forEach((message: Untyped, i: Untyped) => position.set(message.id, i));
    let start = 0;
    for (let i = 1; i <= list.length; i += 1) {
      if (i < list.length && stretchOf(list[i].ts) === stretchOf(list[start].ts)) continue;
      const run = { first: start, last: i - 1 };
      for (let j = start; j < i; j += 1) runOf.set(list[j].id, run);
      start = i;
    }
  }

  const hits = [];
  for (const message of byId.values()) {
    if (excluded.has(message.id) || !scannedIds.has(message.id)) continue;
    const person = (named.get(message.id) ?? []).some((id: Untyped) => people.has(id));
    const texts = recordTexts(message);
    const locates = person || formsMatched(texts, nameForms) > 0;
    const topic = formsMatched(texts, textForms);
    const score = topic + (locates ? RECORD_NAME_WEIGHT : 0);
    if (score > 0) hits.push({ message, score, topic });
  }
  // The meaning rows that stand: found, not shown in the chat, every source line allowed.
  const meant = wanted
    .filter((row) => byId.has(row.id) && !excluded.has(row.id) && !row.sourceIds.some((id: Untyped) => refused.has(id)))
    .map((row) => byId.get(row.id));
  const hitOrder = recent
    ? (a: Untyped, b: Untyped) =>
        Number(b.message.self) - Number(a.message.self) || b.message.ts - a.message.ts || b.score - a.score
    : (a: Untyped, b: Untyped) => b.score - a.score || b.message.ts - a.message.ts;
  // A dateless, not-recent question: the earliest hit with the best score keeps a window of its own
  // (by words only: with meaning rows the fused order alone decides what is kept).
  // A locator has its own reservation instead (locatorKeep).
  const dateless =
    !near && !recent && !Number.isFinite(range?.from) && !Number.isFinite(range?.to) && meant.length === 0;
  const bestScore = Math.max(0, ...hits.map((hit) => hit.score));
  const earliest = dateless
    ? hits
        .filter((hit) => hit.score === bestScore)
        .reduce<Untyped>(
          (a, b) =>
            !a || b.message.ts < a.message.ts || (b.message.ts === a.message.ts && b.message.id < a.message.id) ? b : a,
          null
        )
    : null;
  // Fused with meaning rows (no locator): the best word hit matching a topic form keeps a window of its own,
  // so lines found by both searches cannot crowd out the strongest lexical match.
  const strongest =
    meant.length > 0 && !near
      ? hits
          .filter((hit) => hit.topic > 0)
          .reduce<Untyped>(
            (a, b) => (!a || b.score > a.score || (b.score === a.score && b.message.ts > a.message.ts) ? b : a),
            null
          )
      : null;
  const wordOrdered = hits.sort(hitOrder);
  // Without meaning rows the word order and scores; with them the fused ones (fuseRanks).
  const ranked =
    meant.length === 0
      ? wordOrdered
      : fuseRanks([meant.map((message) => message.id), wordOrdered.map((hit) => hit.message.id)]).map((entry) => ({
          message: byId.get(entry.id),
          score: entry.score,
        }));
  const hitScore = new Map(ranked.map((hit) => [hit.message.id, hit.score]));
  const chosenHits: Array<Untyped> = ranked.slice(0, keep * RECORD_HITS_PER_WINDOW);
  // At most one of them is set: `earliest` needs no meaning row, `strongest` at least one.
  const reserved = earliest ?? strongest;
  if (reserved && !chosenHits.some((hit) => hit.message.id === reserved.message.id)) chosenHits.push(reserved);
  // With a locator the bonus counts in the unit of the score: one form, or one top rank when fused.
  const unit = meant.length === 0 ? 1 : 1 / (RRF_K + 1);
  const boostedOf = (score: Untyped, start: Untyped, end?: Untyped) => score + unit * proximityBonus(start, end, near);
  if (near) {
    // The hits best with the bonus get windows too, beside the best without it.
    const taken = new Set(chosenHits.map((hit) => hit.message.id));
    const dated = [...ranked].sort(
      (a, b) => boostedOf(b.score, b.message.ts) - boostedOf(a.score, a.message.ts) || b.message.ts - a.message.ts
    );
    for (const hit of dated.slice(0, keep * RECORD_HITS_PER_WINDOW))
      if (!taken.has(hit.message.id)) chosenHits.push(hit);
  }
  const windows = chosenHits.map(({ message }) => {
    const list = byChannel.get(message.placeId);
    const at = position.get(message.id);
    const run = runOf.get(message.id);
    const chosen = new Map();
    let parentId = message.replyToId;
    for (let depth = 0; parentId && depth < REPLY_CHAIN_MAX; depth += 1) {
      const parent = byId.get(parentId);
      if (!parent || parent.placeId !== message.placeId || chosen.has(parent.id)) break;
      chosen.set(parent.id, parent);
      parentId = parent.replyToId;
    }
    for (const neighbour of [
      ...list.slice(Math.max(run.first, at - around), at),
      message,
      ...list.slice(at + 1, Math.min(run.last + 1, at + 1 + around)),
    ])
      chosen.set(neighbour.id, neighbour);
    // Carried forward from its last line while the conversation goes on (the chat's lines left out below).
    const last = Math.max(...[...chosen.keys()].filter((id) => runOf.get(id) === run).map((id) => position.get(id)));
    for (const next of followConversation(
      list[last].ts,
      list.slice(last + 1, Math.min(run.last + 1, last + 1 + MAX_WINDOW_MESSAGES)),
      { followMessages, followGapMinutes }
    ))
      chosen.set(next.id, next);
    const all = [...chosen.values()];
    const messages = all.filter((m) => !excluded.has(m.id)).sort((x, y) => x.ts - y.ts || (x.id < y.id ? -1 : 1));
    return {
      source: 'record' as const,
      placeId: message.placeId,
      channelName: typeof channelNameOf === 'function' ? (channelNameOf(message.placeId) ?? null) : null,
      messages,
      hitIds: messages.filter((m) => hitScore.has(m.id)).map((m) => m.id),
      overlapsChat: messages.length < all.length,
    };
  });
  const merged = mergeWindows(windows).map((window) => ({
    ...window,
    score: Math.max(0, ...[...window.hitIds].map((id) => hitScore.get(id) ?? 0)),
    self: window.messages.some((m) => m.self === true),
    endTs: window.messages[window.messages.length - 1].ts,
  }));
  const windowOrder = recent
    ? (a: Untyped, b: Untyped) => Number(b.self) - Number(a.self) || b.endTs - a.endTs || b.score - a.score
    : (a: Untyped, b: Untyped) => b.score - a.score || b.endTs - a.endTs;
  const ordered = merged.sort(windowOrder);
  if (near) {
    const boosted = new Map(
      ordered.map((window) => [window, boostedOf(window.score, window.messages[0].ts, window.endTs)])
    );
    const picked = locatorKeep(ordered, {
      keep,
      broadShare: near.broadShare,
      broadOrder: windowOrder,
      datedOrder: (a, b) => boosted.get(b) - boosted.get(a) || b.endTs - a.endTs,
    });
    const located = picked
      .sort((a, b) => b.item.endTs - a.item.endTs)
      .map(({ item: { score, self, endTs, ...window }, share }) => ({ ...window, share }));
    return { windows: located, scanned, hits: hits.length, meaningHits: meant.length };
  }
  const origin = reserved ? ordered.findIndex((window) => window.hitIds.has(reserved.message.id)) : -1;
  const kept = (origin >= keep ? [...ordered.slice(0, keep - 1), ordered[origin]] : ordered.slice(0, keep))
    .sort((a, b) => b.endTs - a.endTs)
    .map(({ score, self, endTs, ...window }) => window);
  return { windows: kept, scanned, hits: hits.length, meaningHits: meant.length };
}

/** A word of the question this long or longer (in characters) is a fallback search form. */
const FALLBACK_FORM_MIN_CHARS = 5;
/** A longer word is no search form (a pasted token, a link's tail): recall's own cap on a form. */
const FALLBACK_FORM_MAX_CHARS = 40;

/** The words of `text`: maximal runs of word characters (isWordChar). */
function wordsIn(text: string) {
  const words = [];
  let current = '';
  for (const ch of String(text ?? '')) {
    if (isWordChar(ch)) current += ch;
    else if (current) {
      words.push(current);
      current = '';
    }
  }
  if (current) words.push(current);
  return words;
}

export function fallbackLookupPlan({
  text,
  profiles = [],
  selfId = null,
  selfName = '',
  maxForms = 0,
}: FallbackLookupPlanInput = {}): FallbackLookupPlanResult | null {
  const cap = Number.isInteger(maxForms) && maxForms > 0 ? maxForms : 0;
  const folded = foldText(text);
  const skipWords = new Set(wordsIn(foldText(selfName)));
  const who: Array<Untyped> = [];
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    if (who.length >= cap) break;
    if (!profile || typeof profile !== 'object' || (selfId !== null && String(profile.id) === String(selfId))) continue;
    const names = [
      ...(Array.isArray(profile.names) ? profile.names : []),
      ...(Array.isArray(profile.aliases) ? profile.aliases : []).map((alias: Untyped) => alias?.name),
    ];
    const hit = names.find(
      (name) => typeof name === 'string' && [...foldText(name)].length >= 2 && occursAsWholeWord(folded, foldText(name))
    );
    if (!hit) continue;
    const form = oneLine(hit).toLowerCase();
    if (!who.includes(form)) who.push(form);
    for (const word of wordsIn(foldText(hit))) skipWords.add(word);
  }
  const seen = new Set();
  const candidates = [];
  for (const word of wordsIn(String(text ?? '').toLowerCase())) {
    const chars = [...word].length;
    if (chars < FALLBACK_FORM_MIN_CHARS || chars > FALLBACK_FORM_MAX_CHARS || !/\p{L}/u.test(word)) continue;
    const key = foldText(word);
    if (seen.has(key) || skipWords.has(key)) continue;
    seen.add(key);
    candidates.push({ word, chars, at: candidates.length });
  }
  const forms = candidates
    .sort((a, b) => b.chars - a.chars || a.at - b.at)
    .slice(0, cap)
    .map((item) => item.word);
  if (forms.length === 0 && who.length === 0) return null;
  return { forms, who, from: null, to: null };
}

/** The separator of the list arguments of memory.search (`people`, `terms`). */
const TOOL_LIST_SPLIT_RE = /[,;\n]/;

/**
 * The server search the persona's own `memory.search` call asks for (src/tools/tools.ts): no model role, only the deterministic expansion -- her `terms` (exact
 * words or phrases, comma-separated) and `people` (names, comma-separated) cleaned as the
 * classifier's `server:` and `who:` values are (2 to 40 characters, at most three words each,
 * lowercased, each once), then what fallbackLookupPlan finds in her `question` (its long words,
 * a stored member's name or alias), her own first, at most `maxForms` each. `when` is read as
 * a `when:` value (`YYYY-MM-DD`, `YYYY-MM-DD HH:MM`, `A..B` with either side open, in
 * `timezone`; a future side cut to `now`): it bounds the search (never a mere locator). Her
 * `channel` (an id, resolved by the caller) is kept as `placeId`: the stretches of other
 * channels are left out (src/behavior/recall-run.ts `quotes`). Null when nothing is left to
 * search (no form, no name, no range). Pure.
 */
export function memorySearchPlan({
  question = '',
  people = '',
  terms = '',
  when = '',
  placeId = null,
  profiles = [],
  selfId = null,
  selfName = '',
  maxForms = RECALL_DEFAULTS.maxForms,
  timezone = 'UTC',
  now,
}: MemorySearchPlanInput = {}): MemorySearchPlanResult | null {
  const cap = intAtLeast(maxForms, RECALL_DEFAULTS.maxForms, 1);
  const forms: Array<Untyped> = [];
  const who: Array<Untyped> = [];
  for (const part of String(terms ?? '').split(TOOL_LIST_SPLIT_RE)) addForms(forms, part, cap);
  for (const part of String(people ?? '').split(TOOL_LIST_SPLIT_RE)) addForms(who, part, cap);
  const fromQuestion = fallbackLookupPlan({ text: question, profiles, selfId, selfName, maxForms: cap });
  for (const form of fromQuestion?.forms ?? []) if (forms.length < cap && !forms.includes(form)) forms.push(form);
  for (const form of fromQuestion?.who ?? []) if (who.length < cap && !who.includes(form)) who.push(form);
  const range = typeof when === 'string' && when.trim() ? parseRange(when, timezone, now) : null;
  if (forms.length === 0 && who.length === 0 && !range) return null;
  return {
    forms,
    who,
    from: range?.from ?? null,
    to: range?.to ?? null,
    ...(typeof placeId === 'string' && placeId ? { placeId } : {}),
  };
}
