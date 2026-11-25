// The pure core of recall: the settings of the persona's own search and of the memory prefetch, the plan of their
// memory.search (memorySearchPlan, fallbackLookupPlan), reciprocal rank
// fusion (fuseRanks), the meaning query (meaningQuery), windows merged, followed along their chat until it settles
// (followChat: at most `recall.followMessages` more lines, up to the first silence longer than
// `recall.followGapMinutes`) and rendered (renderRecallWindows, stretchText, cutStretch), and the persona's stored
// memory matched against word and name forms (matchMemory over members' moments, lore, learned items and the archive
// scanArchive streams). No I/O; the runner is src/behavior/recall-run.ts. No wording of ours goes into a
// stretch: tags and structural marks only.

import { isPlainObject } from '../config.ts';
import { formatTranscript, GAP_MARKER_MINUTES, MAX_MESSAGE_CHARS, noLegend } from '../format.ts';
import { oneLine } from '../memory/clamp.ts';
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
import { isFiniteNumber, objOf } from '../tools/types.ts';
import type { Untyped } from '../tools/types.ts';
import { legendBlock } from '../turn/request/legend.ts';
import type { MediaName } from '../memory/store-media-names.ts';
import type {
  MeaningQueryInput,
  MergeWindowsResult,
  RenderRecallWindowsInput,
  RenderRecallWindowsArg2,
  RenderRecallWindowsResult,
  MemoryContextInput,
  MatchMemoryInput,
  MatchMemoryResult,
  ScanArchiveArg2,
  FallbackLookupPlanInput,
  MemorySearchPlanInput,
  RecallSettingsResult,
  MergeWindowsInput,
  FallbackLookupPlanResult,
  MemorySearchPlanResult,
  PrefetchSettings,
} from './recall-types.ts';

/**
 * The prefetch's measures (production values of the config cut of 2026-10-31, and the fallbacks of `deadlineMs`,
 * `maxTokens`, `contextTokens`, `trivial` and `deictic`): the automatic retrieval
 * before a turn of the persona's tool loop (src/behavior/prefetch.ts, recall-run.js `prefetch`).
 * `trivial` and `deictic` are matching data (folded phrases and words), never wording the persona reads.
 */
export const PREFETCH_DEFAULTS = Object.freeze({
  deadlineMs: 15000,
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
 * config holds (`timeoutMs`).
 */
export const RECALL_DEFAULTS = Object.freeze({
  maxForms: 8,
  maxClusters: 5,
  windowMessages: 16,
  followMessages: 24,
  followGapMinutes: 5,
  stretchChars: 1500,
  quoteWindowChars: 1500,
  quoteMaxChars: 9000,
  timeoutMs: 15000,
  memoryItems: 6,
  traceMaxLines: 500,
  recordContext: 3,
  archiveMonths: 6,
  meaningCandidates: 80,
  db: Object.freeze({
    gateShare: 0.5,
    candidates: 40,
    wordPool: 400,
    minMeaning: 0.35,
  }),
  prefetch: PREFETCH_DEFAULTS,
});

/** The `k` of reciprocal rank fusion (fuseRanks): an item at rank r of a list adds 1 / (k + r). */
export const RRF_K = 60;
/** The structural mark that opens a line the search matched in a stretch. */
export const HIT_MARK = '>> ';
/** A search form: 2..40 characters and at most 3 words. */
const FORM_MIN_CHARS = 2;
const FORM_MAX_CHARS = 40;
const FORM_MAX_WORDS = 3;

// Protocol tokens of the arguments memorySearchPlan reads, not wording.
const NONE_RE = /^none\b/i;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/;
const RANGE_SPLIT_RE = /\s*\.{2,}\s*/;
const FORM_SPLIT_RE = /[,;，、]/;
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
 * config holds read from it: `timeoutMs` (a whole number of at least 1). `prefetch`:
 * `recall.prefetch` read by prefetchSettingsOf (the automatic memory prefetch, src/behavior/prefetch.ts).
 * @param config  The live config.
 */
export function recallSettings(config: Record<string, Untyped>): RecallSettingsResult | null {
  const r: Record<string, Untyped> = config?.recall ?? {};
  const d = RECALL_DEFAULTS;
  return {
    maxForms: d.maxForms,
    maxClusters: d.maxClusters,
    windowMessages: d.windowMessages,
    followMessages: d.followMessages,
    followGapMinutes: d.followGapMinutes,
    stretchChars: d.stretchChars,
    quoteWindowChars: d.quoteWindowChars,
    quoteMaxChars: d.quoteMaxChars,
    timeoutMs: intAtLeast(r.timeoutMs, d.timeoutMs, 1),
    memoryItems: d.memoryItems,
    traceMaxLines: d.traceMaxLines,
    recordContext: d.recordContext,
    archiveMonths: d.archiveMonths,
    meaningCandidates: d.meaningCandidates,
    db: {
      gateShare: d.db.gateShare,
      candidates: d.db.candidates,
      wordPool: d.db.wordPool,
      minMeaning: d.db.minMeaning,
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

/**
 * The forms of one comma-separated value appended to `into` up to `cap`: each trimmed, wrapping quotes and trailing
 * punctuation stripped, whitespace collapsed, lower-cased, kept when 2..40 characters and at most 3 words and not `none`,
 * each once.
 */
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
 * The lines that carry a window's chat on past its last line (at
 * `lastTs`): of `after` (the same channel's lines following it, any order),
 * oldest first, each taken while no more than `followGapMinutes` passed
 * since the line before it (the window's last line for the first) and fewer
 * than `followMessages` are taken; the first longer silence ends the
 * chat there. The caller filters what it shows (the
 * turn's own chat) afterwards, so such a line still keeps the chat
 * going. `followMessages` 0 or a non-finite `lastTs` gives none.
 * @param [options]  RECALL_DEFAULTS when unusable.
 */
export function followChat(
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
 * appearance is kept and a window without messages is dropped.
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

/** A message of a stretch without indices: no reply marker. */
function unnumbered(message: Untyped) {
  return { ...message, replyToId: null };
}

/**
 * The windows rendered as transcript lines with the transcript functions of src/format.ts (the chat form: gap and date
 * markers, media tags with the `descriptions` captions, reactions; wording from `labels`; with `handles` each author
 * by handle). A message whose id is in the window's `hitIds` gets HIT_MARK at the start of its own first line
 * (`#n [time] Name: ...`, after any gap or date marker, before the rest of a message with line breaks). `indexed` true
 * keeps the `#n` index of each line, numbered across all windows so a reply marker points inside its own window; false
 * (the stretch handed to the persona, which must not mistake them for chat indices) drops the index from that first
 * line and the reply markers with it; the message's own text is left as it is.
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
    handles,
  }: RenderRecallWindowsArg2 = {}
): Array<RenderRecallWindowsResult> {
  const out = [];
  let offset = 0;
  for (const window of Array.isArray(windows) ? windows : []) {
    const messages = (window?.messages ?? []).filter(Boolean);
    if (messages.length === 0) continue;
    const hits = new Set(window.hitIds ?? []);
    const items = formatTranscript(indexed ? messages : messages.map(unnumbered), {
      // The windows' legend is the root `<media>` of the request (stretchText).
      mediaNameOf: noLegend,
      timezone,
      gapMinutes,
      maxChars,
      selfName,
      labels,
      descriptions: window.descriptions,
      seeReactions,
      reactionsPerMessage,
      indexOffset: offset,
      ...(handles ? { handles } : {}),
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

/**
 * The text of a stretch read outside the request's own window: the legend `<media>` of the custom emoji and stickers
 * of its kept `lines` (src/turn/request/legend.ts), then the lines. `messages` are the window's, found by the lines' ids.
 */
export function stretchText(
  lines: ReadonlyArray<{ id: unknown; text: string }>,
  messages: unknown,
  labels: unknown,
  nameOf: (name: string) => MediaName | null
): string {
  const kept = new Set(lines.map((line) => line.id));
  const shown = (Array.isArray(messages) ? messages : []).filter((message: unknown) => {
    const one: { id?: unknown; stored?: { sourceId?: unknown } } =
      typeof message === 'object' && message !== null ? message : {};
    return kept.has(one.id) || kept.has(one.stored?.sourceId);
  });
  const legend = legendBlock(shown, nameOf, labels);
  const text = lines.map((line) => line.text).join('\n');
  return legend ? `${legend}\n${text}` : text;
}

/** The weight a stored item other than an episode ranks with: an episode's default weight. */
const NEUTRAL_WEIGHT = 3;

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

/**
 * The matching context shared by matchMemory and scanArchive: the folded
 * forms, the members the name forms pick, the range tests and the scorer;
 * null when nothing is asked (no form).
 */
function memoryContext({ forms, who, profiles, from, to, timezone }: MemoryContextInput) {
  const whoForms = foldedForms(who);
  const allForms = foldedForms([...(Array.isArray(forms) ? forms : []), ...(Array.isArray(who) ? who : [])]);
  if (allForms.length === 0) return null;
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
 */
function archivedItem(entry: Record<string, Untyped>, ctx: Untyped) {
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
  if (score <= 0) return null;
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
  archived = [],
  from = null,
  to = null,
  max,
  timezone = 'UTC',
}: MatchMemoryInput = {}): Array<MatchMemoryResult> {
  const limit = intAtLeast(max, RECALL_DEFAULTS.memoryItems, 0);
  const list = (value: Untyped) =>
    Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
  const ctx = memoryContext({ forms, who, profiles, from, to, timezone });
  if (limit === 0 || ctx === null) return [];
  const { people, namesPerson, dayInside, ranged } = ctx;
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

  return found
    .sort(byScore)
    .slice(0, limit)
    .map(({ kind, text, date, accountId, itemId, self, score }) => ({
      kind,
      text,
      date,
      accountId,
      itemId,
      self,
      score,
    }));
}

/**
 * The archive entries a recall question may use, read from `entries` (an
 * async or sync iterable, as src/memory/archive.js#iterate streams a
 * segment's lines one by one) without holding the archive in memory: each
 * entry `allow` refuses is skipped before it is matched (the caller's
 * audience rule, and a private item is its partner's); each one archivedItem matches is a
 * candidate, and at most `max` x ARCHIVE_CANDIDATES_PER_ITEM (4) of the best
 * (matchMemory's order) are kept while the stream runs.
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
  let kept: Array<Untyped> = [];
  let seen = 0;
  for await (const entry of entries) {
    if (signal?.aborted) break;
    if (typeof allow === 'function' && !allow(entry)) continue;
    const item = archivedItem(entry, ctx);
    if (!item) continue;
    kept.push({ ...item, order: seen, entry });
    seen += 1;
    if (kept.length >= bound * 2) kept = kept.sort(byScore).slice(0, bound);
  }
  return kept
    .sort(byScore)
    .slice(0, bound)
    .map((item) => item.entry);
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

const TOOL_LIST_SPLIT_RE = /[,;\n]/;

const namedPlace = (placeId: unknown): { placeId?: string } =>
  typeof placeId === 'string' && placeId ? { placeId } : {};

/**
 * The server search the persona's own `memory.search` call asks for (src/tools/tools.ts): no model role, only the deterministic expansion -- their `terms` (exact
 * words or phrases, comma-separated) and `people` (names, comma-separated) cleaned by addForms (2 to 40 characters, at most three words each, lowercased, each once), then what fallbackLookupPlan finds in their `question` (its long words,
 * a stored member's name or alias), their own first, at most `maxForms` each. `when` is read as
 * a `when:` value (`YYYY-MM-DD`, `YYYY-MM-DD HH:MM`, `A..B` with either side open, in
 * `timezone`; a future side cut to `now`): it bounds the search (never a mere locator). Their
 * `channel` (an id, resolved by the caller) is kept as `placeId`: the stretches of other
 * channels are left out (src/behavior/recall-run.ts `quotes`). Null when nothing is left to search (no form, no name, no range, no channel). Pure.
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
  const place = namedPlace(placeId);
  if (forms.length === 0 && who.length === 0 && !range && !place.placeId) return null;
  return {
    forms,
    who,
    from: range?.from ?? null,
    to: range?.to ?? null,
    ...place,
  };
}
