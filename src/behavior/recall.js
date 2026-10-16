// The pure core of recall: the server's own history searched beside the web.
// The lookup classifier (prompts/lookup.md) answers `none` or up to five
// labelled lines -- `web:` a web query, `server:` word forms to look for in
// the server's messages, `who:` forms of a person's name, `when:` a date
// range in the bot's time zone, `recent:` whether the question is a vague
// "recently" -- and the old single unlabelled line still
// reads as a web query. Discord's message search does not stem and matches
// one form per query, so the server part becomes an ordered list of queries
// (content forms round-robin, then authors, or a date range sampled when
// nothing else is given); the hits are grouped into clusters by channel and
// time, a window of messages around each is fetched and carried forward
// along its conversation until it settles (followConversation: at most
// `recall.followMessages` more lines, up to the first silence longer than
// `recall.followGapMinutes`), and one helper request
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
// the Discord side is src/discord/search.js and the runner
// src/behavior/recall-run.js. No wording of ours goes into the request: tags
// and structural marks only.
// A `when:` range beside word or name forms is a locator unless the lookup
// says `when-role: scope` (people misremember dates): the local sources then
// search past it, a window near the range gets a bounded proximity bonus
// (proximityBonus) and a share of the kept slots stays reserved for the best
// by content regardless of date (locatorKeep), so a misread date cannot
// exclude the answer. A `when:` alone, or one marked scope, stays a hard bound.

import { isPlainObject } from '../config.js';
import { estimateTokens } from '../llm/tokens.js';
import { block, fillPromptTemplate } from './prompt.js';
import { fill, formatTranscript, renderTranscript } from '../discord/format.js';
import { clampText, oneLine } from '../memory/clamp.js';
import { episodeDate } from '../memory/episodes.js';
import { TEACHER_TOKEN_RE, fromTokens, occursAsWordStem, tokenIds } from '../memory/mentions.js';
import { foldText, memberIdOf } from '../memory/recent.js';
import { DAY_MS, MINUTE_MS, utcDay, zonedDay, zonedEpoch } from '../time.js';
import { parseSkillsLines, takeSkillsLines } from '../skills/discovery.js';

/** Defaults of the `recall` config group (config.json carries the same values). */
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
  maxPerDay: 100,
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
  fallbackOnClassifierFailure: true,
  meaningCandidates: 80,
  meaningWithReply: false,
  locatorBonus: 2,
  locatorDecayDays: 7,
  locatorBroadShare: 0.5,
});

/** The `k` of reciprocal rank fusion (fuseRanks): an item at rank r of a list adds 1 / (k + r). */
export const RRF_K = 60;

/** How many of the newest windows the fallback stretch is chosen among (fallbackWindow). */
export const FALLBACK_AMONG = 3;

/** Discord's epoch (2015-01-01T00:00:00Z) in ms: a snowflake counts from it. */
export const DISCORD_EPOCH_MS = 1420070400000;
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
const LABEL_RE = /^(?:[-*•>]\s*)*\**\s*(web|server|who|when[-_ ]?role|when|recent)\s*\**\s*:\s*\**\s*(.*)$/i;
const YES_RE = /^yes\b/i;
const SCOPE_RE = /^scope\b/i;
const LOCATOR_RE = /^locator\b/i;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/;
const RANGE_SPLIT_RE = /\s*\.{2,}\s*/;
const FORM_SPLIT_RE = /[,;，、]/;
// Protocol tokens of the summary helper (prompts/recall-summary.md).
const STRETCH_RE = /^\**\s*stretch\s*\**\s*:\s*\**\s*(.*)$/i;
const NOTHING_RE = /^nothing$/i;
// Quotes and backticks a model may wrap a line in (straight, curly, guillemets).
const QUOTES = new Set(['"', "'", '`', '“', '”', '‘', '’', '«', '»']);
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', '…']);
// The `#n ` index that opens a chat transcript line.
const LINE_INDEX_RE = /^#\d+ (?=\[)/;

/** An integer from a finite `value` of at least `min` (floored), else `fallback`. */
function intAtLeast(value, fallback, min) {
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}

/** A finite `value` of at least `min`, else `fallback`. */
function numberAtLeast(value, fallback, min) {
  return Number.isFinite(value) && value >= min ? value : fallback;
}

/**
 * The `recall` settings read from the live config, or null when
 * `features.recall` is false (a missing key counts as on). Each number falls
 * back to RECALL_DEFAULTS when missing or unusable; counts are floored.
 * `maxForms`, `maxPeople`, `maxPerDay`, `stretchChars`, `minSummaryMs`,
 * `memoryItems`, `keepOldest` and `rareHits` may be 0 (no content query, no
 * member lookup, no recall today, no stretch, the summary asked whatever time
 * is left, no stored memory searched, no slot reserved for old clusters, no
 * form counted rare); so may `selfBonus` (a number, not floored: no bonus
 * for the persona's own stretches), `selfExtra` (no window beyond
 * `maxClusters`) and `contextMessages` (no `<context>` block);
 * `traceMaxLines` is at least 1; `windowMessages` is at most 100;
 * `followMessages` is at most 100 (one Discord page) and may be 0 (a window
 * is not followed past its end); `followGapMinutes` is a number of at least 0;
 * `memoryTokens` (no `<memory>` line fits), `recordDays` (the record is not
 * read), `recordContext` (no neighbours) and `archiveMonths` (the archive is
 * not searched without a `when:` range) may be 0 too. `fallbackOnClassifierFailure`
 * is on unless it is `false` (src/behavior/turn.js#fallbackLookupPlan).
 * `meaningCandidates` (the rows one meaning search returns, see
 * src/behavior/recall-run.js) may be 0 (none); `meaningWithReply` (the
 * replied-to line joins the meaning query, meaningQuery) is on only when it
 * is exactly `true`. The locator numbers (a `when:` that only locates, see
 * proximityBonus and locatorKeep): `locatorBonus` and `locatorDecayDays`
 * numbers of at least 0, `locatorBroadShare` a number from 0 to 1.
 * @param {object} config  The live config.
 * @returns {{ maxForms: number, maxPeople: number, dateSamples: number, clusterGapMinutes: number,
 *   maxClusters: number, keepOldest: number, rareHits: number, windowMessages: number, followMessages: number,
 *   followGapMinutes: number, answerChars: number, stretchChars: number, maxPerDay: number,
 *   timeoutMs: number, minSummaryMs: number, maxOutputTokens: number, memoryItems: number, selfBonus: number, selfExtra: number,
 *   contextMessages: number, traceMaxLines: number, memoryTokens: number, recordDays: number, recordContext: number,
 *   archiveMonths: number, fallbackOnClassifierFailure: boolean, meaningCandidates: number, meaningWithReply: boolean,
 *   locatorBonus: number, locatorDecayDays: number, locatorBroadShare: number }|null}
 */
export function recallSettings(config) {
  if (config?.features?.recall === false) return null;
  const r = config?.recall ?? {};
  const d = RECALL_DEFAULTS;
  return {
    maxForms: intAtLeast(r.maxForms, d.maxForms, 0),
    maxPeople: intAtLeast(r.maxPeople, d.maxPeople, 0),
    dateSamples: intAtLeast(r.dateSamples, d.dateSamples, 1),
    clusterGapMinutes: numberAtLeast(r.clusterGapMinutes, d.clusterGapMinutes, 0),
    maxClusters: intAtLeast(r.maxClusters, d.maxClusters, 1),
    keepOldest: intAtLeast(r.keepOldest, d.keepOldest, 0),
    rareHits: intAtLeast(r.rareHits, d.rareHits, 0),
    windowMessages: Math.min(MAX_WINDOW_MESSAGES, intAtLeast(r.windowMessages, d.windowMessages, 1)),
    followMessages: Math.min(MAX_WINDOW_MESSAGES, intAtLeast(r.followMessages, d.followMessages, 0)),
    followGapMinutes: numberAtLeast(r.followGapMinutes, d.followGapMinutes, 0),
    answerChars: intAtLeast(r.answerChars, d.answerChars, 1),
    stretchChars: intAtLeast(r.stretchChars, d.stretchChars, 0),
    maxPerDay: intAtLeast(r.maxPerDay, d.maxPerDay, 0),
    timeoutMs: intAtLeast(r.timeoutMs, d.timeoutMs, 1),
    minSummaryMs: intAtLeast(r.minSummaryMs, d.minSummaryMs, 0),
    maxOutputTokens: intAtLeast(r.maxOutputTokens, d.maxOutputTokens, 1),
    memoryItems: intAtLeast(r.memoryItems, d.memoryItems, 0),
    selfBonus: numberAtLeast(r.selfBonus, d.selfBonus, 0),
    selfExtra: intAtLeast(r.selfExtra, d.selfExtra, 0),
    contextMessages: intAtLeast(r.contextMessages, d.contextMessages, 0),
    traceMaxLines: intAtLeast(r.traceMaxLines, d.traceMaxLines, 1),
    memoryTokens: intAtLeast(r.memoryTokens, d.memoryTokens, 0),
    recordDays: intAtLeast(r.recordDays, d.recordDays, 0),
    recordContext: intAtLeast(r.recordContext, d.recordContext, 0),
    archiveMonths: intAtLeast(r.archiveMonths, d.archiveMonths, 0),
    fallbackOnClassifierFailure: r.fallbackOnClassifierFailure !== false,
    meaningCandidates: intAtLeast(r.meaningCandidates, d.meaningCandidates, 0),
    meaningWithReply: r.meaningWithReply === true,
    locatorBonus: numberAtLeast(r.locatorBonus, d.locatorBonus, 0),
    locatorDecayDays: numberAtLeast(r.locatorDecayDays, d.locatorDecayDays, 0),
    locatorBroadShare: shareOf(r.locatorBroadShare, d.locatorBroadShare),
  };
}

/** A finite `value` from 0 to 1, else `fallback`. */
function shareOf(value, fallback) {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

/**
 * The bounded bonus of a window or item near a `when:` locator: the time
 * `[start, end]` (`end` defaults to `start`) against the range `[from, to]`
 * (either side may be null, open): the full `bonus` when they overlap,
 * falling linearly with the distance to 0 at `decayDays` days away (only
 * inside with `decayDays` 0); 0 for a `start` that is not finite. Always
 * within [0, bonus]. Unusable numbers: RECALL_DEFAULTS. Pure.
 * @param {number} start
 * @param {number|null|undefined} end
 * @param {{ from?: number|null, to?: number|null, bonus?: number, decayDays?: number }} locator
 * @returns {number}
 */
export function proximityBonus(start, end, { from = null, to = null, bonus, decayDays } = {}) {
  const most = numberAtLeast(bonus, RECALL_DEFAULTS.locatorBonus, 0);
  if (most === 0 || !Number.isFinite(start)) return 0;
  const last = Number.isFinite(end) && end >= start ? end : start;
  let gap = 0;
  if (Number.isFinite(from) && last < from) gap = from - last;
  else if (Number.isFinite(to) && start > to) gap = start - to;
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
 * @template T
 * @param {T[]} items
 * @param {{ keep?: number, broadShare?: number, broadOrder: (a: T, b: T) => number, datedOrder: (a: T, b: T) => number }} options
 * @returns {{ item: T, share: 'broad'|'dated' }[]}
 */
export function locatorKeep(items, { keep, broadShare, broadOrder, datedOrder }) {
  const list = Array.isArray(items) ? [...items] : [];
  const limit = Number.isInteger(keep) && keep >= 0 ? keep : list.length;
  const share = shareOf(broadShare, RECALL_DEFAULTS.locatorBroadShare);
  const broad = [...list].sort(broadOrder).slice(0, Math.min(limit, Math.ceil(limit * share)));
  const taken = new Set(broad);
  const dated = list
    .filter((item) => !taken.has(item))
    .sort(datedOrder)
    .slice(0, limit - broad.length);
  return [...broad.map((item) => ({ item, share: 'broad' })), ...dated.map((item) => ({ item, share: 'dated' }))];
}

/** A usable locator option (a range with a finite side), else null. */
function usableLocator(locator) {
  return isPlainObject(locator) && (Number.isFinite(locator.from) || Number.isFinite(locator.to)) ? locator : null;
}

/**
 * Reciprocal rank fusion of ranked lists: each item scores the sum over the
 * lists holding it of 1 / (`k` + its 1-based rank there; a repeat keeps its
 * first rank). Returned best first; on an equal score the item found by more
 * lists first, then by its rank in the earlier list (an item it lacks after
 * one it holds), and so on. Items are compared as Map keys (ids or objects).
 * Pure.
 * @param {Array<Array<unknown>>} lists
 * @param {{ k?: number }} [options]
 * @returns {{ id: unknown, score: number, ranks: (number|null)[] }[]}
 */
export function fuseRanks(lists, { k = RRF_K } = {}) {
  const all = Array.isArray(lists) ? lists : [];
  const fused = new Map();
  all.forEach((list, at) => {
    (Array.isArray(list) ? list : []).forEach((id, i) => {
      if (!fused.has(id)) fused.set(id, { id, score: 0, ranks: all.map(() => null) });
      const entry = fused.get(id);
      if (entry.ranks[at] !== null) return;
      entry.ranks[at] = i + 1;
      entry.score += 1 / (k + i + 1);
    });
  });
  const found = (entry) => entry.ranks.filter((rank) => rank !== null).length;
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
 * @param {{ candidate?: { content?: string, replyToId?: string|null }|null, lines?: object[], withReply?: boolean,
 *   nameOf?: (id: string) => (string|null|undefined) }} params
 * @returns {{ text: string, form: 'question'|'question+reply' }|null}
 */
export function meaningQuery({ candidate = null, lines = [], withReply = false, nameOf = null } = {}) {
  const flat = (message) => oneLine(fromTokens(typeof message?.content === 'string' ? message.content : '', nameOf, 'chat'));
  const question = flat(candidate);
  if (!question) return null;
  const replyId = typeof candidate?.replyToId === 'string' && candidate.replyToId ? candidate.replyToId : null;
  const parent = withReply && replyId ? (Array.isArray(lines) ? lines : []).find((line) => line?.id === replyId) : null;
  const replied = parent ? flat(parent) : '';
  return replied ? { text: `${replied}\n${question}`, form: 'question+reply' } : { text: question, form: 'question' };
}

/** `line` without surrounding quotes/backticks/whitespace and trailing punctuation (one pass each way). */
function stripLine(line) {
  const points = [...String(line ?? '')];
  let start = 0;
  let end = points.length;
  const isSpace = (c) => c.trim() === '';
  while (start < end && (QUOTES.has(points[start]) || isSpace(points[start]))) start += 1;
  while (end > start && (QUOTES.has(points[end - 1]) || TRAILING_PUNCTUATION.has(points[end - 1]) || isSpace(points[end - 1]))) end -= 1;
  return points.slice(start, end).join('');
}

/** A web query from one answer value: stripped, `none` -> null, cut to WEB_QUERY_CHARS. */
function webQuery(value) {
  const stripped = stripLine(value);
  if (!stripped || NONE_RE.test(stripped)) return null;
  const query = [...stripped].slice(0, WEB_QUERY_CHARS).join('').trim();
  return query || null;
}

/** The forms of one `server:` / `who:` value, cleaned (see parseLookupAnswer), appended to `into` up to `cap`. */
function addForms(into, value, cap) {
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
function dateSide(text) {
  const match = DATE_RE.exec(text.trim());
  if (!match) return null;
  if (match[2] === undefined) return { day: match[1], hour: 0, minute: 0, timed: false };
  return { day: match[1], hour: Number(match[2]), minute: Number(match[3]), timed: true };
}

/** The start of a side (its minute, or the start of its local day). */
function sideStart(side, timezone) {
  return zonedEpoch(side.day, side.hour, side.minute, timezone);
}

/** The inclusive end of a side (its minute, or the last ms of its local day). */
function sideEnd(side, timezone) {
  if (side.timed) return zonedEpoch(side.day, side.hour, side.minute, timezone);
  const next = utcDay(Date.parse(`${side.day}T00:00:00Z`) + DAY_MS);
  return zonedEpoch(next, 0, 0, timezone) - 1;
}

/**
 * A `when:` value as `{ from, to }` in epoch ms (both inclusive, either may
 * be null for an open side), or null when it is not a usable range.
 */
function parseRange(value, timezone, now) {
  // Quotes go, but not the `..` of an open end: only a lone trailing period does.
  let text = [...String(value ?? '')].filter((c, i, all) => !(QUOTES.has(c) && (i === 0 || i === all.length - 1))).join('').trim();
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
  if (Number.isFinite(now)) {
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
 * null. `reason`: `empty` (no text), `none` (an explicit none, or labelled
 * lines that all say none or nothing), `unparsed` (labelled lines with
 * content none of which is usable), `ok`.
 * A `skills:` line (skills discovery, src/skills/discovery.js) is taken out
 * before the rest is read, so the other lines read exactly as without it;
 * with one, the result has `skills` (parseSkillsLines over `skillNames`:
 * `inventory`, up to four known names, `none` or `invalid`) and an answer of
 * nothing else is `none`. Without one there is no `skills` key (none).
 * @param {unknown} raw
 * @param {{ timezone?: string, now?: number, maxForms?: number, skillNames?: string[] }} [options]
 * @returns {{ web: string|null, server: { forms: string[], who: string[], from: number|null, to: number|null, recent?: true,
 *   locator?: true }|null,
 *   reason: 'empty'|'none'|'unparsed'|'ok', skills?: { state: string, inventory: boolean, names: string[] } }}
 */
export function parseLookupAnswer(raw, { timezone = 'UTC', now, maxForms, skillNames } = {}) {
  const { rest, values } = takeSkillsLines(raw);
  const parsed = parseSearchLines(rest, { timezone, now, maxForms });
  if (values.length === 0) return parsed;
  const skills = parseSkillsLines(values, skillNames);
  return parsed.reason === 'empty' ? { ...parsed, reason: 'none', skills } : { ...parsed, skills };
}

/** parseLookupAnswer's reading of every line but the `skills:` ones. */
function parseSearchLines(raw, { timezone, now, maxForms }) {
  const lines = String(raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { web: null, server: null, reason: 'empty' };
  const labelled = lines.map((line) => LABEL_RE.exec(line)).filter(Boolean);
  if (labelled.length === 0) {
    const stripped = stripLine(lines[0]);
    if (NONE_RE.test(stripped)) return { web: null, server: null, reason: 'none' };
    const web = webQuery(lines[0]);
    return web ? { web, server: null, reason: 'ok' } : { web: null, server: null, reason: 'empty' };
  }

  const cap = intAtLeast(maxForms, RECALL_DEFAULTS.maxForms, 1);
  let web = null;
  const forms = [];
  const who = [];
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
    ? { forms, who, from: range?.from ?? null, to: range?.to ?? null, ...(recent ? { recent: true } : {}), ...(locator ? { locator: true } : {}) }
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
 * @param {{ from?: number|null, to?: number|null, recent?: boolean }|null|undefined} server
 * @param {{ now: number, recordDays?: number }} options
 * @returns {boolean}
 */
export function isRecentCue(server, { now, recordDays } = {}) {
  if (!server || typeof server !== 'object') return false;
  const from = Number.isFinite(server.from) ? server.from : null;
  const to = Number.isFinite(server.to) ? server.to : null;
  if (from === null && to === null) return server.recent === true;
  if (from === null || !Number.isFinite(now)) return false;
  const days = Math.max(1, intAtLeast(recordDays, RECALL_DEFAULTS.recordDays, 0));
  return now - from <= days * DAY_MS && (to === null || now - to < DAY_MS);
}

/**
 * The snowflake of the first possible message at `ms` (worker and sequence
 * bits 0), as a decimal string for `min_id` / `max_id`; '0' before Discord's
 * epoch or for a time that is not finite.
 * @param {number} ms
 * @returns {string}
 */
export function snowflakeAt(ms) {
  if (!Number.isFinite(ms) || ms <= DISCORD_EPOCH_MS) return '0';
  return ((BigInt(Math.floor(ms)) - BigInt(DISCORD_EPOCH_MS)) << 22n).toString();
}

/**
 * The ordered search queries of one server search, newest first each:
 * - content queries: the `forms` and the `who` forms taken round-robin
 *   (form 1, name 1, form 2, name 2, ...), de-duplicated, at most `maxForms`;
 *   each `kind: 'form'` when it is one of `forms` (the topic), else
 *   `kind: 'who'` (a name form: it locates the person, not the topic);
 * - one author query per id of `memberIds`;
 * - with none of those and a range: one query over the range alone
 *   (`kind: 'range'`), which the runner samples (sampleOffsets).
 * The range: `minId` from `from`, `maxId` from `to` (inclusive). The
 * queries span the whole server, so the turn's own chat bounds nothing here:
 * its lines are dropped from the hits by id (dropChatHits). An empty list
 * when nothing is asked, or when the range ends before it starts.
 * @param {{ forms?: string[], who?: string[], memberIds?: string[], from?: number|null, to?: number|null,
 *   maxForms?: number }} params
 * @returns {{ kind: 'form'|'who'|'author'|'range', content?: string, authorId?: string, minId: string|null,
 *   maxId: string|null }[]}
 */
export function searchPlan({ forms = [], who = [], memberIds = [], from = null, to = null, maxForms } = {}) {
  const limit = intAtLeast(maxForms, RECALL_DEFAULTS.maxForms, 0);
  const upper = Number.isFinite(to) ? to + 1 : Infinity;
  const lower = Number.isFinite(from) ? from : null;
  if (lower !== null && upper <= lower) return [];
  const range = { minId: lower !== null ? snowflakeAt(lower) : null, maxId: Number.isFinite(upper) ? snowflakeAt(upper) : null };

  const contents = [];
  const a = Array.isArray(forms) ? forms : [];
  const b = Array.isArray(who) ? who : [];
  for (let i = 0; contents.length < limit && (i < a.length || i < b.length); i += 1) {
    for (const form of [a[i], b[i]]) {
      if (typeof form === 'string' && form && !contents.includes(form) && contents.length < limit) contents.push(form);
    }
  }
  const authors = [...new Set((Array.isArray(memberIds) ? memberIds : []).filter((id) => typeof id === 'string' && id))];
  const plan = [
    ...contents.map((content) => ({ kind: a.includes(content) ? 'form' : 'who', content, ...range })),
    ...authors.map((authorId) => ({ kind: 'author', authorId, ...range })),
  ];
  if (plan.length === 0 && (Number.isFinite(from) || Number.isFinite(to))) plan.push({ kind: 'range', ...range });
  return plan;
}

/**
 * The key a search query's hits are tagged with (clusterHits counts the
 * distinct keys of a cluster, the `form:` ones first): `form:<form>` for a
 * server form (the topic), `who:<form>` for a name form, `author:<id>` for
 * an author search, or `range` for a date range alone -- every sampled page
 * of it is one query.
 * @param {{ kind: string, content?: string, authorId?: string }} query  A searchPlan entry.
 * @returns {string}
 */
export function queryKey(query) {
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
 * @param {number} total
 * @param {number} samples
 * @returns {number[]}
 */
export function sampleOffsets(total, samples) {
  const count = intAtLeast(samples, RECALL_DEFAULTS.dateSamples, 1);
  if (!Number.isFinite(total) || total <= SEARCH_PAGE) return [0];
  const out = [];
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
 * @param {Map<string, number>|Iterable<[string, number]>|null|undefined} totals
 * @param {number} rareHits
 * @returns {Set<string>}
 */
export function rareFormKeys(totals, rareHits) {
  const limit = intAtLeast(rareHits, RECALL_DEFAULTS.rareHits, 0);
  const out = new Set();
  if (limit === 0 || !totals || typeof totals[Symbol.iterator] !== 'function') return out;
  for (const [key, total] of totals) {
    if (typeof key === 'string' && key.startsWith(FORM_KEY) && Number.isFinite(total) && total >= 0 && total <= limit) out.add(key);
  }
  return out;
}

/**
 * Hits grouped into clusters: per channel, hits sorted by time; a hit less
 * than `gapMinutes` after the previous one joins its cluster. Each cluster:
 * `{ channelId, ids (oldest first), startTs, endTs, middleId, queries, forms, topic }`,
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
 * @param {{ id: string, channelId: string, ts: number, queries?: Iterable<string> }[]} hits
 * @param {{ gapMinutes?: number, maxClusters?: number, keepOldest?: number, rareForms?: Iterable<string>,
 *   locator?: object|null }} [options]
 * @returns {{ channelId: string, ids: string[], startTs: number, endTs: number, middleId: string, queries: number,
 *   forms: number, topic: number, share?: 'broad'|'dated' }[]}
 */
export function clusterHits(hits, { gapMinutes, maxClusters, keepOldest, rareForms, locator = null } = {}) {
  const gapMs = numberAtLeast(gapMinutes, RECALL_DEFAULTS.clusterGapMinutes, 0) * MINUTE_MS;
  const keep = intAtLeast(maxClusters, RECALL_DEFAULTS.maxClusters, 1);
  const oldest = Math.min(keep, intAtLeast(keepOldest, RECALL_DEFAULTS.keepOldest, 0));
  const rare = new Set(rareForms && typeof rareForms !== 'string' && typeof rareForms[Symbol.iterator] === 'function' ? rareForms : []);
  const byChannel = new Map();
  const seen = new Map();
  for (const hit of Array.isArray(hits) ? hits : []) {
    if (!hit?.id || !hit.channelId || !Number.isFinite(hit.ts)) continue;
    const keys = typeof hit.queries === 'string' ? [] : [...(hit.queries ?? [])].filter((key) => typeof key === 'string' && key);
    if (seen.has(hit.id)) {
      for (const key of keys) seen.get(hit.id).queries.add(key);
      continue;
    }
    const entry = { id: hit.id, ts: hit.ts, queries: new Set(keys) };
    seen.set(hit.id, entry);
    if (!byChannel.has(hit.channelId)) byChannel.set(hit.channelId, []);
    byChannel.get(hit.channelId).push(entry);
  }
  const clusters = [];
  for (const [channelId, list] of byChannel) {
    list.sort((x, y) => x.ts - y.ts || (x.id < y.id ? -1 : 1));
    let current = null;
    for (const hit of list) {
      if (current && hit.ts - current.endTs < gapMs) {
        current.ids.push(hit.id);
        current.endTs = hit.ts;
        for (const key of hit.queries) current.keys.add(key);
        continue;
      }
      current = { channelId, ids: [hit.id], startTs: hit.ts, endTs: hit.ts, keys: new Set(hit.queries) };
      clusters.push(current);
    }
  }
  const shaped = clusters.map(({ keys, ...cluster }) => {
    const topical = [...keys].filter((key) => key.startsWith(FORM_KEY));
    return {
      ...cluster,
      middleId: cluster.ids[Math.floor(cluster.ids.length / 2)],
      queries: keys.size,
      forms: topical.length,
      topic: topical.reduce((sum, key) => sum + (rare.has(key) ? RARE_WEIGHT : 1), 0),
    };
  });
  return selectClusters(shaped, keep, oldest, (cluster) => cluster.topic, locator);
}

/** Newest first by `endTs`, channel id on a tie: the order kept clusters are returned in. */
function newestFirst(x, y) {
  return y.endTs - x.endTs || (x.channelId < y.channelId ? -1 : 1);
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
function selectClusters(clusters, keep, oldest, scoreOf, locator = null) {
  const byRank = (x, y) => scoreOf(y) - scoreOf(x) || y.queries - x.queries || newestFirst(x, y);
  const near = usableLocator(locator);
  if (near) {
    const boosted = (cluster) => scoreOf(cluster) + proximityBonus(cluster.startTs, cluster.endTs, near);
    const picked = locatorKeep(clusters, { keep, broadShare: near.broadShare, broadOrder: byRank, datedOrder: (x, y) => boosted(y) - boosted(x) || byRank(x, y) });
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
 * @param {object[]} hits
 * @param {Set<string>|string[]|null|undefined} chatIds
 * @returns {{ hits: object[], dropped: number }}
 */
export function dropChatHits(hits, chatIds) {
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
 * @param {{ topic: number, self?: boolean }} cluster
 * @param {number} selfBonus
 * @returns {number}
 */
export function clusterScore(cluster, selfBonus) {
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
 * @param {{ channelId: string, startTs?: number, endTs: number, topic: number, queries: number, self?: boolean }[]} clusters
 * @param {{ maxClusters?: number, keepOldest?: number, selfBonus?: number, locator?: object|null }} [options]
 * @returns {object[]}
 */
export function rankClusters(clusters, { maxClusters, keepOldest, selfBonus, locator = null } = {}) {
  const keep = intAtLeast(maxClusters, RECALL_DEFAULTS.maxClusters, 1);
  const oldest = Math.min(keep, intAtLeast(keepOldest, RECALL_DEFAULTS.keepOldest, 0));
  const bonus = numberAtLeast(selfBonus, RECALL_DEFAULTS.selfBonus, 0);
  const list = (Array.isArray(clusters) ? clusters : []).filter((cluster) => cluster && Number.isFinite(cluster.endTs));
  return selectClusters(list, keep, oldest, (cluster) => clusterScore(cluster, bonus), locator);
}

/**
 * The chat lines the recall summary reads before the question (`<context>`):
 * the last `count` messages of `history` other than `question` itself, in
 * order (as the search classifier's transcript takes them). None for a
 * `count` of 0 or no history.
 * @param {object[]|null|undefined} history
 * @param {{ id?: string }|null|undefined} question
 * @param {number} count
 * @returns {object[]}
 */
export function recallContext(history, question, count) {
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
 * @param {number} lastTs
 * @param {{ ts: number }[]} after
 * @param {{ followMessages?: number, followGapMinutes?: number }} [options]  RECALL_DEFAULTS when unusable.
 * @returns {object[]}
 */
export function followConversation(lastTs, after, { followMessages, followGapMinutes } = {}) {
  const cap = intAtLeast(followMessages, RECALL_DEFAULTS.followMessages, 0);
  const gap = numberAtLeast(followGapMinutes, RECALL_DEFAULTS.followGapMinutes, 0) * MINUTE_MS;
  const out = [];
  if (cap === 0 || !Number.isFinite(lastTs)) return out;
  let previous = lastTs;
  const list = (Array.isArray(after) ? after : []).filter((m) => m && Number.isFinite(m.ts)).sort((x, y) => x.ts - y.ts);
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
 * @param {{ channelId: string, channelName?: string|null, messages: object[], hitIds: Iterable<string>, overlapsChat?: boolean,
 *   source?: 'record' }[]} windows
 * @returns {{ channelId: string, channelName: string|null, messages: object[], hitIds: Set<string>, overlapsChat: boolean,
 *   source?: 'record' }[]}
 */
export function mergeWindows(windows) {
  const out = [];
  for (const window of Array.isArray(windows) ? windows : []) {
    const messages = (window?.messages ?? []).filter((m) => m?.id);
    if (messages.length === 0) continue;
    const ids = new Set(messages.map((m) => m.id));
    const into = out.find((w) => w.channelId === window.channelId && w.messages.some((m) => ids.has(m.id)));
    if (!into) {
      out.push({
        channelId: window.channelId,
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
    const known = new Set(into.messages.map((m) => m.id));
    for (const message of messages) if (!known.has(message.id)) into.messages.push(message);
    into.messages.sort((x, y) => x.ts - y.ts);
    for (const id of window.hitIds ?? []) into.hitIds.add(id);
  }
  for (const window of out) window.messages.sort((x, y) => x.ts - y.ts);
  return out;
}

/**
 * The window the verbatim fallback shows when the summary gives no answer
 * (failed, timed out or skipped): among the first `among` windows -- the
 * newest, as the runner keeps them in clusterHits' order -- the one with the
 * most matched lines (its messages whose id is in its `hitIds`), the newer
 * one on a tie. Null when there is no window.
 * @param {{ messages?: object[], hitIds?: Iterable<string> }[]} windows  Newest first.
 * @param {number} [among]  FALLBACK_AMONG when missing or below 1.
 * @returns {object|null}
 */
export function fallbackWindow(windows, among = FALLBACK_AMONG) {
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
 * (src/discord/format.js#withCalls) name their target by link or channel, never by a number.
 */
function unnumbered(message) {
  const out = { ...message, replyToId: null };
  for (const key of ['calls', 'callsAfter']) {
    if (Array.isArray(message[key])) out[key] = message[key].map((mark) => ({ ...mark, targetId: null }));
  }
  return out;
}

/**
 * The windows rendered as transcript lines with the transcript helpers of
 * src/discord/format.js (the chat form: gap and date markers, media tags
 * with the `descriptions` captions, reactions; wording from `labels`). A
 * message whose id is in the window's `hitIds` gets HIT_MARK at the start
 * of its own first line (`#n [time] Name: ...`, after any gap or date
 * marker, before the rest of a message with line breaks).
 * `indexed` true keeps the `#n` index of each line, numbered across all
 * windows so a reply marker points inside its own window; false (the
 * stretch handed to the persona, which must not mistake them for chat
 * indices) drops the index from that first line and the reply markers with
 * it; the message's own text is left as it is.
 * @param {{ channelId: string, channelName?: string|null, messages: object[], hitIds?: Iterable<string>,
 *   descriptions?: Map<string, string> }[]} windows
 * @param {{ labels: object, timezone?: string, selfName?: string, gapMinutes?: number, maxChars?: number,
 *   seeReactions?: boolean, reactionsPerMessage?: number, indexed?: boolean }} options
 * @returns {{ channelId: string, channelName: string|null, startTs: number,
 *   lines: { id: string, ts: number, text: string, hit: boolean }[] }[]}
 */
export function renderRecallWindows(windows, { labels, timezone = 'UTC', selfName = '', gapMinutes = 20, maxChars = 800, seeReactions = true, reactionsPerMessage, indexed = true } = {}) {
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
    out.push({ channelId: window.channelId, channelName: window.channelName ?? null, startTs: messages[0].ts, lines });
  }
  return out;
}

/** The weight a stored item other than an episode ranks with: an episode's default weight. */
const NEUTRAL_WEIGHT = 3;
/** The mark of an absent field in a `<memory>` line. */
const NO_FIELD = '-';

/** The folded, non-empty, distinct forms of `list` (src/memory/recent.js#foldText). */
function foldedForms(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((form) => typeof form === 'string').map(foldText).filter(Boolean))];
}

/** How many of `forms` (folded) occur, word endings allowed (src/memory/mentions.js#occursAsWordStem), in at least one of `texts` (folded here). */
function formsMatched(texts, forms) {
  const folded = texts.filter((text) => typeof text === 'string' && text).map(foldText);
  return forms.filter((form) => folded.some((text) => occursAsWordStem(text, form))).length;
}

/** A time from an ISO string, or -Infinity. */
function isoMs(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : -Infinity;
}

/** A string field on one line, or ''. */
function textOf(value) {
  return typeof value === 'string' ? oneLine(value) : '';
}

/** How many archive candidates per `<memory>` item scanArchive keeps while it streams. */
const ARCHIVE_CANDIDATES_PER_ITEM = 4;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The default order of matched items: score, weight, the newer, the newer addition, input order. */
function byScore(a, b) {
  return b.score - a.score || b.weight - a.weight || b.ts - a.ts || b.ts2 - a.ts2 || a.order - b.order;
}

/** The order of a vague "recently": the persona's own exchanges first, then the newer, then score and weight. */
function byRecency(a, b) {
  return Number(b.self === true) - Number(a.self === true) || b.ts - a.ts || b.ts2 - a.ts2 || b.score - a.score || b.weight - a.weight || a.order - b.order;
}

/**
 * The matching context shared by matchMemory and scanArchive: the folded
 * forms, the members the name forms pick, the range tests and the scorer;
 * null when nothing is asked (no form, and no meaning row with `anyway`).
 */
function memoryContext({ forms, who, profiles, from, to, timezone, anyway = false }) {
  const whoForms = foldedForms(who);
  const allForms = foldedForms([...(Array.isArray(forms) ? forms : []), ...(Array.isArray(who) ? who : [])]);
  if (allForms.length === 0 && !anyway) return null;
  const ranged = Number.isFinite(from) || Number.isFinite(to);
  const fromDay = Number.isFinite(from) ? zonedDay(from, timezone) : null;
  const toDay = Number.isFinite(to) ? zonedDay(to, timezone) : null;
  const people = new Set();
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    if (!profile || typeof profile !== 'object') continue;
    const id = memberIdOf(profile.id);
    if (id === null || whoForms.length === 0) continue;
    const names = [...(Array.isArray(profile.aliases) ? profile.aliases : []).map((alias) => alias?.name), ...(Array.isArray(profile.names) ? profile.names : [])];
    if (names.some((name) => typeof name === 'string' && whoForms.includes(foldText(name)))) people.add(id);
  }
  return {
    timezone,
    ranged,
    people,
    dayInside: (day) => !ranged || (Boolean(day) && (fromDay === null || day >= fromDay) && (toDay === null || day <= toDay)),
    atInside: (at) => !ranged || (Number.isFinite(at) && (!Number.isFinite(from) || at >= from) && (!Number.isFinite(to) || at <= to)),
    namesPerson: (texts, extraIds = []) => [...extraIds, ...texts.flatMap((text) => tokenIds(text))].some((id) => people.has(String(id))),
    score: (texts, person) => formsMatched(texts, allForms) + (person ? 1 : 0),
  };
}

/** The local day of an archive entry's `observedAt` (a stored day as it is, a time in `timezone`), or null. */
function observedDay(observedAt, timezone) {
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
function archivedItem(entry, ctx, { matched = true } = {}) {
  if (!isPlainObject(entry) || typeof entry.itemKind !== 'string' || !entry.itemKind) return null;
  const fields = isPlainObject(entry.text) ? entry.text : {};
  let texts;
  let text;
  let self = false;
  if (entry.itemKind === 'participation') {
    const messages = (Array.isArray(fields.messages) ? fields.messages : []).filter(isPlainObject);
    self = messages.some((m) => m.self === true);
    const said = messages.map((m) => ({ name: textOf(m.name), text: textOf(m.text) })).filter((m) => m.text);
    texts = said.map((m) => m.text);
    text = said.map((m) => (m.name ? `${m.name}: ${m.text}` : m.text)).join(' / ');
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
  const memberId = typeof entry.scope?.user === 'string' && entry.scope.user ? entry.scope.user : null;
  const ids = [...(Array.isArray(entry.participants) ? entry.participants : []), ...(memberId ? [memberId] : [])];
  const searched = [...texts, neutral];
  const score = ctx.score(searched, ctx.namesPerson(searched, ids));
  if (score <= 0 && matched) return null;
  const observed = isPlainObject(entry.observedAt) && typeof entry.observedAt.date === 'string' ? entry.observedAt.date : '';
  return {
    kind: `archived ${entry.itemKind}`,
    text,
    date,
    memberId,
    itemId: typeof entry.itemId === 'string' && entry.itemId ? entry.itemId : null,
    self,
    weight: Number.isFinite(entry.weight) ? entry.weight : NEUTRAL_WEIGHT,
    ts: DAY_KEY_RE.test(observed) ? Date.parse(`${observed}T00:00:00Z`) : isoMs(observed),
    ts2: isoMs(entry.recordedAt),
    score,
  };
}

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
 *   case, accents; src/memory/mentions.js#occursAsWordStem: a form word of 5+
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
 * and learned), `memberId` (the moment's member, a learned item's teacher, an
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
 * @param {{ forms?: string[], who?: string[], profiles?: object[], lore?: object[], learned?: object[],
 *   recentLines?: object[], archived?: object[], meaning?: object[], from?: number|null, to?: number|null, max?: number,
 *   timezone?: string, recent?: boolean, locator?: object|null }} params
 * @returns {{ kind: string, text: string, date: string|null, memberId: string|null, itemId: string|null, self: boolean,
 *   score: number, share?: 'broad'|'dated' }[]}
 */
export function matchMemory({ forms = [], who = [], profiles = [], lore = [], learned = [], recentLines = [], archived = [], meaning = [], from = null, to = null, max, timezone = 'UTC', recent = false, locator = null } = {}) {
  const limit = intAtLeast(max, RECALL_DEFAULTS.memoryItems, 0);
  const list = (value) => (Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : []);
  const meant = list(meaning);
  const ctx = memoryContext({ forms, who, profiles, from, to, timezone, anyway: meant.length > 0 });
  if (limit === 0 || ctx === null) return [];
  const { people, namesPerson, dayInside, atInside, ranged } = ctx;
  const itemIdOf = (value) => (typeof value?.itemId === 'string' && value.itemId ? value.itemId : null);

  const found = [];
  const add = (item, texts, person) => {
    const score = ctx.score(texts, person);
    if (score > 0) found.push({ itemId: null, self: false, ...item, score, order: found.length });
  };

  for (const profile of list(profiles)) {
    const memberId = memberIdOf(profile.id);
    if (memberId === null) continue;
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
        memberId,
        itemId: itemIdOf(ep),
        weight: Number.isFinite(ep.weight) ? ep.weight : NEUTRAL_WEIGHT,
        ts: date ? Date.parse(`${date}T00:00:00Z`) : -Infinity,
        ts2: isoMs(ep.addedAt),
      };
      add(item, texts, people.has(memberId) || namesPerson(texts));
    }
  }
  // Lore and learned items carry no date: a range leaves them out.
  if (!ranged) {
    for (const entry of list(lore)) {
      const title = textOf(entry.title);
      const text = textOf(entry.text);
      if (!text) continue;
      const keys = Array.isArray(entry.keys) ? entry.keys.filter((key) => typeof key === 'string') : [];
      const item = { kind: 'lore', text: title ? `${title}: ${text}` : text, date: null, memberId: null, itemId: itemIdOf(entry), weight: NEUTRAL_WEIGHT, ts: isoMs(entry.updatedAt || entry.createdAt), ts2: 0 };
      add(item, [title, ...keys, text], namesPerson([title, text]));
    }
    for (const entry of list(learned)) {
      const text = textOf(entry.text);
      if (!text) continue;
      const teacher = typeof entry.from === 'string' ? (TEACHER_TOKEN_RE.exec(entry.from.trim())?.[1] ?? null) : null;
      const item = { kind: 'learned', text, date: null, memberId: teacher, itemId: itemIdOf(entry), weight: NEUTRAL_WEIGHT, ts: isoMs(entry.lastSeen), ts2: 0 };
      add(item, [text], namesPerson([text]));
    }
  }
  for (const line of list(recentLines)) {
    const text = textOf(line.text);
    if (!text || !Number.isFinite(line.at) || !atInside(line.at)) continue;
    const item = { kind: 'recent', text, date: zonedDay(line.at, timezone), memberId: null, itemId: itemIdOf(line), weight: NEUTRAL_WEIGHT, ts: line.at, ts2: 0 };
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
    const meaningItems = [];
    for (const entry of meant) {
      const itemId = itemIdOf(entry);
      const item = (itemId && byItemId.get(itemId)) || archivedItem(entry, ctx, { matched: false });
      if (item && !meaningItems.includes(item)) meaningItems.push(item);
    }
    const fused = fuseRanks([meaningItems, ordered]);
    chosen = fused.map((entry) => entry.id);
    fusedScore = new Map(fused.map((entry) => [entry.id, entry.score]));
  }
  let picked = chosen.slice(0, limit).map((item) => ({ item, share: null }));
  const near = usableLocator(locator);
  if (near) {
    // A dated item's local day against the locator; the bonus in the unit of the order: one form, or one top rank fused.
    const position = new Map(chosen.map((item, i) => [item, i]));
    const unit = fusedScore ? 1 / (RRF_K + 1) : 1;
    const boosted = new Map(
      chosen.map((item) => {
        const day = item.date ? dateSide(item.date) : null;
        const bonus = day ? proximityBonus(sideStart(day, timezone), sideEnd(day, timezone), near) : 0;
        return [item, (fusedScore ? fusedScore.get(item) : item.score) + unit * bonus];
      }),
    );
    const byPosition = (a, b) => position.get(a) - position.get(b);
    picked = locatorKeep(chosen, { keep: limit, broadShare: near.broadShare, broadOrder: byPosition, datedOrder: (a, b) => boosted.get(b) - boosted.get(a) || byPosition(a, b) });
  }
  return picked.map(({ item: { kind, text, date, memberId, itemId, self, score }, share }) => ({ kind, text, date, memberId, itemId, self, score, ...(share ? { share } : {}) }));
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
 * @param {AsyncIterable<object>|Iterable<object>|null|undefined} entries
 * @param {{ forms?: string[], who?: string[], profiles?: object[], from?: number|null, to?: number|null,
 *   timezone?: string, recent?: boolean, allow?: (entry: object) => boolean, max?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<object[]>}
 */
export async function scanArchive(entries, { forms = [], who = [], profiles = [], from = null, to = null, timezone = 'UTC', recent = false, allow, max, signal } = {}) {
  const limit = intAtLeast(max, RECALL_DEFAULTS.memoryItems, 0);
  const ctx = memoryContext({ forms, who, profiles, from, to, timezone });
  const iterable = entries && (typeof entries[Symbol.asyncIterator] === 'function' || typeof entries[Symbol.iterator] === 'function');
  if (limit === 0 || ctx === null || !iterable) return [];
  const bound = limit * ARCHIVE_CANDIDATES_PER_ITEM;
  const order = recent ? byRecency : byScore;
  let kept = [];
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
 * `-`, `name` the display name `nameOf` gives its `memberId` or `-`, `text`
 * on one line with `<@id>` tokens resolved through `nameOf` (an unresolved
 * one stays as stored).
 */
function memoryLine(item, nameOf) {
  const resolve = typeof nameOf === 'function' ? nameOf : () => null;
  const name = item?.memberId ? oneLine(resolve(item.memberId) ?? '') : '';
  const text = oneLine(fromTokens(String(item?.text ?? ''), resolve, 'chat'));
  return `${item?.kind} | ${item?.date || NO_FIELD} | ${name || NO_FIELD} | ${text}`;
}

/** The `<people>` line of one found member: `name | username | count | newest date` (structural fields). */
function personLine(person, timezone) {
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
function timeCueText(cue, labels, timezone) {
  const template = labels?.lookup?.timeEstimate;
  if (!isPlainObject(cue) || typeof template !== 'string' || !template.trim()) return '';
  const from = Number.isFinite(cue.from) ? zonedDay(cue.from, timezone) : '';
  const to = Number.isFinite(cue.to) ? zonedDay(cue.to, timezone) : '';
  if (!from && !to) return '';
  const range = from === to ? from : `${from} .. ${to}`.trim();
  return fill(template.trim(), { range });
}

/**
 * The summary helper's request: the system message is `prompt` with
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
 * classifier transcripts are -- src/discord/format.js formatTranscript and
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
 * @param {{ prompt: string|null|undefined, selfName: string, question: { authorName?: string, content?: string },
 *   people?: { name: string, username?: string, count?: number, newestTs?: number|null }[], windows: object[],
 *   memory?: { kind: string, text: string, date: string|null, memberId: string|null }[], context?: object[],
 *   contextDescriptions?: Map<string, string>, replyQuoteChars?: number,
 *   nameOf?: (id: string) => (string|null|undefined), labels: object, timezone?: string, answerChars: number,
 *   now?: number, maxChars?: number, gapMinutes?: number, seeReactions?: boolean, reactionsPerMessage?: number,
 *   memoryTokens?: number, timeCue?: { from?: number|null, to?: number|null }|null }} params
 * @returns {{ role: string, content: string }[]|null}
 */
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
  maxChars = 800,
  gapMinutes = 20,
  seeReactions = true,
  reactionsPerMessage,
  memoryTokens,
  timeCue = null,
}) {
  if (typeof prompt !== 'string' || !prompt.trim()) return null;
  const rendered = renderRecallWindows(windows, { labels, timezone, selfName, gapMinutes, maxChars, seeReactions, reactionsPerMessage, indexed: true });
  const notes = (Array.isArray(memory) ? memory : []).filter((item) => item && typeof item.text === 'string' && item.text.trim());
  // The <memory> lines in order, until the next one would pass `memoryTokens`.
  const tokenCap = Number.isFinite(memoryTokens) && memoryTokens >= 0 ? memoryTokens : Infinity;
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
  const sources = (Array.isArray(windows) ? windows : []).filter((window) => (window?.messages ?? []).filter(Boolean).length > 0);
  const flag = (key) => {
    const label = labels?.lookup?.[key];
    // Trimmed: a label written with its own leading space never doubles the separator.
    return typeof label === 'string' && label.trim() ? ` ${label.trim()}` : '';
  };
  const sections = rendered.map((window, i) => {
    const source = sources[i];
    const self = (source?.messages ?? []).some((m) => m?.self === true) ? flag('stretchSelf') : '';
    const current = source?.overlapsChat === true ? flag('stretchCurrent') : '';
    // A protocol mark, not wording: the window was read from the record, not found by the search.
    const origin = source?.source === 'record' ? ' | source: record' : '';
    return [`## ${i + 1} | ${zonedDay(window.startTs, timezone)} | #${oneLine(window.channelName)}${origin}${self}${current}`, ...window.lines.map((line) => line.text)].join('\n');
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
  const values = { name: selfName ?? '', answerChars };
  if (Number.isFinite(now)) values.today = zonedDay(now, timezone);
  return [
    { role: 'system', content: fillPromptTemplate(prompt, values) },
    { role: 'user', content: user },
  ];
}

/**
 * The summary helper's answer. A first non-empty line `stretch: <n>` (any
 * case) names the `<found>` section that answers the question: `n` within
 * `1..count` (a `#` before it tolerated) -> `stretch` n, `none` or anything
 * else -> null; that line is not part of the text. The rest, trimmed and
 * clamped with clampText to `answerChars` (soft, the prompt names the
 * limit), is the text; empty or the single word `nothing` (quotes and
 * trailing punctuation aside) gives text null and no stretch.
 * @param {unknown} raw
 * @param {{ answerChars?: number, count?: number }} [options]
 * @returns {{ text: string|null, stretch: number|null }}
 */
export function parseRecallAnswer(raw, { answerChars, count = 0 } = {}) {
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
 * @param {{ text: string, hit: boolean }[]} lines
 * @param {number} maxChars
 * @returns {{ text: string, hit: boolean }[]}
 */
export function cutStretch(lines, maxChars) {
  const list = Array.isArray(lines) ? [...lines] : [];
  if (!Number.isFinite(maxChars) || maxChars < 0) return list;
  const size = (from, to) => list.slice(from, to).reduce((sum, line, i) => sum + (i > 0 ? 1 : 0) + [...line.text].length, 0);
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
function meaningSpans(rows) {
  const spans = rows
    .map((row) => ({ from: row.ts - MEANING_READ_BEFORE_MS, to: row.ts + MEANING_READ_AFTER_MS, channels: new Set([row.channelId]) }))
    .sort((a, b) => a.from - b.from);
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

/** The usable meaning rows of matchRecord's `meaning`, in their order: `{ id, channelId, ts, sourceIds }`. */
function meaningRows(meaning) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(meaning) ? meaning : []) {
    const ts = Date.parse(row?.occurredAt);
    if (typeof row?.id !== 'string' || !row.id || seen.has(row.id) || typeof row.channelId !== 'string' || !row.channelId || !Number.isFinite(ts)) continue;
    seen.add(row.id);
    out.push({ id: row.id, channelId: row.channelId, ts, sourceIds: Array.isArray(row.sourceIds) ? row.sourceIds.filter((id) => typeof id === 'string') : [] });
  }
  return out;
}

/**
 * The links of a record line (src/memory/record.js#recordLinks) as normalized chat links: a
 * `link` with its site, title and description (`text`), rendered like a live link preview; a line
 * without `links` has none.
 */
function recordLinkItems(line) {
  const str = (value) => (typeof value === 'string' ? value : '');
  return (Array.isArray(line.links) ? line.links : [])
    .filter((link) => isPlainObject(link) && (str(link.title) || str(link.description)))
    .map((link, i) => ({
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
function recordTexts(message) {
  return [message.content, ...message.links.flatMap((link) => [link.title, link.text])];
}

/** A record line (src/memory/record.js) as a normalized chat message (the shape renderRecallWindows reads). */
function recordMessage(line, { nameOf, selfName }) {
  const self = line.kind === 'said';
  const by = typeof line.by === 'string' && line.by ? line.by : null;
  const name = self ? oneLine(selfName ?? '') : by && typeof nameOf === 'function' ? oneLine(nameOf(by) ?? '') : '';
  return {
    id: line.messageId,
    channelId: line.scope.channel,
    authorId: by,
    authorName: name || NO_FIELD,
    self,
    bot: false,
    content: typeof line.text === 'string' ? line.text : '',
    ts: Date.parse(line.occurredAt),
    replyToId: typeof line.replyTo === 'string' && line.replyTo ? line.replyTo : null,
    mentionedUserIds: Array.isArray(line.mentions) ? line.mentions : [],
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
 * as windows for the summary beside Discord's (buildRecallRequest marks them
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
 * `{ source: 'record', channelId, channelName, messages, hitIds, overlapsChat }`
 * (`channelName` from `channelNameOf`; authors' names from `nameOf`, the
 * persona's own lines under `selfName`). Stops reading at an aborted `signal`.
 * `meaning`: the record rows the meaning search found, best first
 * (`{ id, channelId, occurredAt, sourceIds }`, any age). The record around
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
 * @param {string} guildId
 * @param {{ record: { iterate: Function }, range?: { from?: number|null, to?: number|null }, participants?: string[],
 *   forms?: string[], aliases?: string[], recordDays?: number, recordContext?: number, followMessages?: number,
 *   followGapMinutes?: number, now: number, maxWindows?: number,
 *   allowLine?: (line: object) => boolean, exclude?: Set<string>|string[], recent?: boolean,
 *   nameOf?: (id: string) => (string|null|undefined), selfName?: string, channelNameOf?: (id: string) => (string|null|undefined),
 *   meaning?: { id: string, channelId: string, occurredAt: string, sourceIds?: string[] }[], locator?: object|null,
 *   signal?: AbortSignal }} options
 * @returns {Promise<{ windows: object[], scanned: number, hits: number, meaningHits: number }>}
 */
export async function matchRecord(guildId, { record, range = {}, participants = [], forms = [], aliases = [], recordDays, recordContext, followMessages, followGapMinutes, now, maxWindows, allowLine, exclude, recent = false, nameOf, selfName = '', channelNameOf, meaning = [], locator = null, signal } = {}) {
  const none = { windows: [], scanned: 0, hits: 0, meaningHits: 0 };
  const days = intAtLeast(recordDays, RECALL_DEFAULTS.recordDays, 0);
  const around = intAtLeast(recordContext, RECALL_DEFAULTS.recordContext, 0);
  const keep = intAtLeast(maxWindows, RECALL_DEFAULTS.maxClusters, 1);
  if (typeof record?.iterate !== 'function' || !Number.isFinite(now)) return none;
  const textForms = foldedForms(forms);
  const nameForms = foldedForms(aliases).filter((form) => !textForms.includes(form));
  const people = new Set((Array.isArray(participants) ? participants : []).filter((id) => typeof id === 'string' && id));
  const wanted = meaningRows(meaning);
  const near = usableLocator(locator);
  const to = Math.min(Number.isFinite(range?.to) ? range.to : now, now);
  const from = Math.max(Number.isFinite(range?.from) ? range.from : -Infinity, to - days * DAY_MS);
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
  const stretches = [];
  let scanned = 0;
  const take = (line, main) => {
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
    if ((line.kind !== 'seen' && line.kind !== 'said') || typeof line.scope?.channel !== 'string' || !Number.isFinite(Date.parse(line.occurredAt))) return;
    const known = latest.get(line.messageId);
    const revision = Number.isInteger(line.revision) && line.revision > 0 ? line.revision : 1;
    if (known === null || (known && known.revision >= revision)) return;
    latest.set(line.messageId, { line, revision });
  };
  for (const span of words ? mainSpans : []) {
    if (signal?.aborted) break;
    stretches.push(span);
    const query = { from: new Date(span.from).toISOString(), to: new Date(span.to).toISOString() };
    for await (const line of record.iterate(guildId, query)) {
      if (signal?.aborted) break;
      take(line, true);
    }
  }
  for (const span of meaningSpans(wanted.filter((row) => !latest.has(row.id)))) {
    if (signal?.aborted) break;
    stretches.push(span);
    const query = { from: new Date(span.from).toISOString(), to: new Date(span.to).toISOString(), channelIds: [...span.channels] };
    for await (const line of record.iterate(guildId, query)) {
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
    named.set(message.id, [message.authorId, ...(Array.isArray(entry.line.participants) ? entry.line.participants : [])]);
    if (!byChannel.has(message.channelId)) byChannel.set(message.channelId, []);
    byChannel.get(message.channelId).push(message);
  }
  const position = new Map();
  // Each line's run: the first and last index of the lines of its channel read in one stretch,
  // so neighbours and the follow never join two stretches read apart (one run without meaning rows).
  const runOf = new Map();
  const stretchOf = (ts) => (stretches.length <= 1 ? 0 : stretches.findIndex((s) => ts >= s.from && ts <= s.to));
  for (const list of byChannel.values()) {
    list.sort((x, y) => x.ts - y.ts || (x.id < y.id ? -1 : 1));
    list.forEach((message, i) => position.set(message.id, i));
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
    const person = (named.get(message.id) ?? []).some((id) => people.has(id));
    const texts = recordTexts(message);
    const locates = person || formsMatched(texts, nameForms) > 0;
    const topic = formsMatched(texts, textForms);
    const score = topic + (locates ? RECORD_NAME_WEIGHT : 0);
    if (score > 0) hits.push({ message, score, topic });
  }
  // The meaning rows that stand: found, not shown in the chat, every source line allowed.
  const meant = wanted
    .filter((row) => byId.has(row.id) && !excluded.has(row.id) && !row.sourceIds.some((id) => refused.has(id)))
    .map((row) => byId.get(row.id));
  const hitOrder = recent
    ? (a, b) => Number(b.message.self) - Number(a.message.self) || b.message.ts - a.message.ts || b.score - a.score
    : (a, b) => b.score - a.score || b.message.ts - a.message.ts;
  // A dateless, not-recent question: the earliest hit with the best score keeps a window of its own
  // (by words only: with meaning rows the fused order alone decides what is kept).
  // A locator has its own reservation instead (locatorKeep).
  const dateless = !near && !recent && !Number.isFinite(range?.from) && !Number.isFinite(range?.to) && meant.length === 0;
  const bestScore = Math.max(0, ...hits.map((hit) => hit.score));
  const earliest = dateless
    ? hits.filter((hit) => hit.score === bestScore).reduce((a, b) => (!a || b.message.ts < a.message.ts || (b.message.ts === a.message.ts && b.message.id < a.message.id) ? b : a), null)
    : null;
  // Fused with meaning rows (no locator): the best word hit matching a topic form keeps a window of its own,
  // so lines found by both searches cannot crowd out the strongest lexical match.
  const strongest =
    meant.length > 0 && !near
      ? hits.filter((hit) => hit.topic > 0).reduce((a, b) => (!a || b.score > a.score || (b.score === a.score && b.message.ts > a.message.ts) ? b : a), null)
      : null;
  const wordOrdered = hits.sort(hitOrder);
  // Without meaning rows the word order and scores; with them the fused ones (fuseRanks).
  const ranked =
    meant.length === 0
      ? wordOrdered
      : fuseRanks([meant.map((message) => message.id), wordOrdered.map((hit) => hit.message.id)]).map((entry) => ({ message: byId.get(entry.id), score: entry.score }));
  const hitScore = new Map(ranked.map((hit) => [hit.message.id, hit.score]));
  const chosenHits = ranked.slice(0, keep * RECORD_HITS_PER_WINDOW);
  // At most one of them is set: `earliest` needs no meaning row, `strongest` at least one.
  const reserved = earliest ?? strongest;
  if (reserved && !chosenHits.some((hit) => hit.message.id === reserved.message.id)) chosenHits.push(reserved);
  // With a locator the bonus counts in the unit of the score: one form, or one top rank when fused.
  const unit = meant.length === 0 ? 1 : 1 / (RRF_K + 1);
  const boostedOf = (score, start, end) => score + unit * proximityBonus(start, end, near);
  if (near) {
    // The hits best with the bonus get windows too, beside the best without it.
    const taken = new Set(chosenHits.map((hit) => hit.message.id));
    const dated = [...ranked].sort((a, b) => boostedOf(b.score, b.message.ts) - boostedOf(a.score, a.message.ts) || b.message.ts - a.message.ts);
    for (const hit of dated.slice(0, keep * RECORD_HITS_PER_WINDOW)) if (!taken.has(hit.message.id)) chosenHits.push(hit);
  }
  const windows = chosenHits
    .map(({ message }) => {
      const list = byChannel.get(message.channelId);
      const at = position.get(message.id);
      const run = runOf.get(message.id);
      const chosen = new Map();
      let parentId = message.replyToId;
      for (let depth = 0; parentId && depth < REPLY_CHAIN_MAX; depth += 1) {
        const parent = byId.get(parentId);
        if (!parent || parent.channelId !== message.channelId || chosen.has(parent.id)) break;
        chosen.set(parent.id, parent);
        parentId = parent.replyToId;
      }
      for (const neighbour of [...list.slice(Math.max(run.first, at - around), at), message, ...list.slice(at + 1, Math.min(run.last + 1, at + 1 + around))]) chosen.set(neighbour.id, neighbour);
      // Carried forward from its last line while the conversation goes on (the chat's lines left out below).
      const last = Math.max(...[...chosen.keys()].filter((id) => runOf.get(id) === run).map((id) => position.get(id)));
      for (const next of followConversation(list[last].ts, list.slice(last + 1, Math.min(run.last + 1, last + 1 + MAX_WINDOW_MESSAGES)), { followMessages, followGapMinutes })) chosen.set(next.id, next);
      const all = [...chosen.values()];
      const messages = all.filter((m) => !excluded.has(m.id)).sort((x, y) => x.ts - y.ts || (x.id < y.id ? -1 : 1));
      return {
        source: 'record',
        channelId: message.channelId,
        channelName: typeof channelNameOf === 'function' ? (channelNameOf(message.channelId) ?? null) : null,
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
    ? (a, b) => Number(b.self) - Number(a.self) || b.endTs - a.endTs || b.score - a.score
    : (a, b) => b.score - a.score || b.endTs - a.endTs;
  const ordered = merged.sort(windowOrder);
  if (near) {
    const boosted = new Map(ordered.map((window) => [window, boostedOf(window.score, window.messages[0].ts, window.endTs)]));
    const picked = locatorKeep(ordered, { keep, broadShare: near.broadShare, broadOrder: windowOrder, datedOrder: (a, b) => boosted.get(b) - boosted.get(a) || b.endTs - a.endTs });
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
