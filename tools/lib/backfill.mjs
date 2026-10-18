// The pure part of tools/backfill.mjs: the windows of connected lines a stream of record lines
// falls into (and which of them are too thin to send), the extract request and its answer (quotes
// checked against their message, the persona's name turned into her token, participants told
// apart from the mentioned), the dedupe of candidates against hot episodes and the archive (by
// shared sources and by meaning), the stable item ids of what survives, the per-channel cursor of
// the fetch, the deletion ledger's rule on candidates, the cost estimate, and for `links` the record
// lines whose link previews are missing and the revision that adds them. No I/O, no clock, no
// randomness.

import { createHash } from 'node:crypto';
import { isGifHostUrl } from '../../src/media/classify.js';
import { block, fillPromptTemplate } from '../../src/behavior/prompt.js';
import { parseJsonObject } from '../../src/llm/parse.js';
import { clampText } from '../../src/memory/clamp.js';
import { EPISODE_CHARS, isSameEpisode } from '../../src/memory/episodes.js';
import { normalizeTopic } from '../../src/memory/index.js';
import { ID_DIGITS, TEACHER_TOKEN_RE, URL_PATTERN, redactUser, tokenIds } from '../../src/memory/mentions.js';
import { MEMORY_LIMIT_DEFAULTS } from '../../src/memory/text-limits.js';

/** The longest window, in lines (`--window-max`). */
export const WINDOW_MAX_LINES = 120;
/** The kind of archive item each candidate kind becomes, and its item id prefix. */
const KINDS = Object.freeze({ episode: { itemKind: 'episode', prefix: 'ep-bf-' }, lesson: { itemKind: 'lesson', prefix: 'ln-bf-' } });
/** How long a candidate's brief for the voice pass may be. */
const BRIEF_CHARS = 300;
const ID_RE = new RegExp(`^${ID_DIGITS}$`);
const DISCORD_EPOCH = 1420070400000n;
/** A window with fewer content lines than this, none by the persona and none addressing anyone, is thin. */
export const THIN_CONTENT_LINES = 4;
/** The words (URLs, emoji and mentions left out) that make a line content. */
const CONTENT_WORDS = 3;
/** The token Jaccard similarity at or over which two texts say the same thing. */
export const SAME_MEANING = 0.8;
const URL_RE = /\bhttps?:\/\/\S+/giu;
const DISCORD_TOKEN_RE = /<(?:a?:[\w~]+:\d+|@[!&]?\d+|#\d+)>/gu;
const SHORTCODE_RE = /:[\w+-]+:/gu;
const PICTOGRAPH_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu;
const MENTION_RE = /<@[!&]?\d+>/u;
const SENTENCE_END_RE = /[.!?…]["'’”)\]»]*$/u;

/** A line's time in epoch ms (`occurredAt`, else `ts`), NaN when it has none. */
function timeOf(line) {
  if (typeof line?.occurredAt === 'string') return Date.parse(line.occurredAt);
  return Number.isFinite(line?.ts) ? line.ts : NaN;
}

const channelOf = (line) => line?.scope?.channel ?? line?.channelId ?? null;
const replyOf = (line) => line?.replyTo ?? line?.replyToId ?? null;

/**
 * The Discord snowflake of epoch ms `ms` (the smallest id of that millisecond), as a string:
 * `after` it pages from a moment.
 * @param {number} ms
 * @returns {string}
 */
export function snowflakeAt(ms) {
  return ((BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH) << 22n).toString();
}

/**
 * Whether a record line carries content: it has media, or its text has at least three words
 * once URLs, emoji (Unicode, custom and `:shortcode:`) and mentions are taken out.
 * @param {object} line
 * @returns {boolean}
 */
export function isContentLine(line) {
  if (Array.isArray(line?.media) && line.media.length > 0) return true;
  const text = typeof line?.text === 'string' ? line.text : '';
  const bare = text.replace(URL_RE, ' ').replace(DISCORD_TOKEN_RE, ' ').replace(SHORTCODE_RE, ' ').replace(PICTOGRAPH_RE, ' ');
  return bare.split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)).length >= CONTENT_WORDS;
}

/**
 * Whether a window's lines are too thin to send: fewer than `THIN_CONTENT_LINES` content lines
 * (`isContentLine`), no line by the persona, and no line that addresses someone (a `?` or a
 * mention).
 * @param {object[]} lines
 * @returns {boolean}
 */
export function isThinWindow(lines) {
  const list = Array.isArray(lines) ? lines : [];
  if (list.some((line) => line?.kind === 'said')) return false;
  const addresses = (line) => (Array.isArray(line?.mentions) && line.mentions.length > 0) || (typeof line?.text === 'string' && (line.text.includes('?') || MENTION_RE.test(line.text)));
  if (list.some(addresses)) return false;
  return list.filter(isContentLine).length < THIN_CONTENT_LINES;
}

/**
 * The windows of connected lines in `lines` (record lines, any order): per channel, a line joins
 * the window of the message it replies to when that window is still open, else the channel's
 * current window when it came at most `gapMinutes` after that window's last line, else it opens a
 * new one. A window holds at most `maxLines` lines, then closes (a reply into it opens a new one).
 * Ordered by their first line. Each: `{ id: 'w-<first messageId>', channelId, day (UTC day of the
 * first line), startAt, endAt, lines, thin (isThinWindow) }`. Lines without a time or a message
 * id are left out.
 * @param {object[]} lines
 * @param {{ gapMinutes?: number, maxLines?: number }} [options]
 * @returns {object[]}
 */
export function windowsOf(lines, { gapMinutes = 30, maxLines = WINDOW_MAX_LINES } = {}) {
  const gapMs = Math.max(0, Number(gapMinutes) || 0) * 60_000;
  const cap = Number.isInteger(maxLines) && maxLines > 0 ? maxLines : WINDOW_MAX_LINES;
  const sorted = (Array.isArray(lines) ? lines : [])
    .map((line, index) => ({ line, index, at: timeOf(line) }))
    .filter(({ line, at }) => Number.isFinite(at) && typeof line?.messageId === 'string' && line.messageId)
    .sort((a, b) => a.at - b.at || a.index - b.index);
  const windows = [];
  const current = new Map(); // channelId -> window
  const byMessage = new Map(); // messageId -> window
  for (const { line, at } of sorted) {
    const channelId = channelOf(line);
    const open = (w) => w && !w.closed && w.lines.length < cap;
    let target = null;
    const replied = byMessage.get(replyOf(line));
    if (replied && replied.channelId === channelId && open(replied)) target = replied;
    const cur = current.get(channelId);
    if (!target && open(cur) && at - cur.lastAt <= gapMs) target = cur;
    if (!target) {
      target = { id: `w-${line.messageId}`, channelId, day: new Date(at).toISOString().slice(0, 10), startAt: at, lastAt: at, lines: [], closed: false };
      windows.push(target);
    }
    target.lines.push(line);
    target.lastAt = Math.max(target.lastAt, at);
    byMessage.set(line.messageId, target);
    if (!cur || cur === target || at - cur.lastAt > gapMs || !open(cur)) current.set(channelId, target);
    if (target.lines.length >= cap) target.closed = true;
  }
  return windows.map(({ id, channelId, day, startAt, lastAt, lines: taken }) => ({
    id,
    channelId,
    day,
    startAt: new Date(startAt).toISOString(),
    endAt: new Date(lastAt).toISOString(),
    lines: taken,
    thin: isThinWindow(taken),
  }));
}

/**
 * The members a window names, the persona left out: authors, mentions, then reply targets'
 * authors when the target is in the window. In order of first appearance.
 * @param {object} window
 * @param {string|null} selfId
 * @returns {string[]}
 */
export function windowMembers(window, selfId) {
  const out = [];
  const add = (id) => {
    if (typeof id === 'string' && ID_RE.test(id) && id !== selfId && !out.includes(id)) out.push(id);
  };
  const authorOf = new Map((window?.lines ?? []).map((line) => [line.messageId, line.kind === 'said' ? selfId : line.by]));
  for (const line of window?.lines ?? []) {
    if (line.kind !== 'said') add(line.by);
    for (const id of Array.isArray(line.mentions) ? line.mentions : []) add(id);
    add(authorOf.get(replyOf(line)));
  }
  return out;
}

/**
 * The roster of a window: the persona first (`self: true`), then each member it names with their
 * stored names and known aliases (`namesOf(id)`, at most `maxNames`, distinct). Pure.
 * @param {object} window
 * @param {{ selfId: string|null, selfName: string, namesOf?: (id: string) => string[], maxNames?: number }} options
 * @returns {{ id: string|null, names: string[], self?: true }[]}
 */
export function rosterOf(window, { selfId, selfName, namesOf = () => [], maxNames = 5 }) {
  const roster = [{ id: selfId ?? null, names: [selfName], self: true }];
  for (const id of windowMembers(window, selfId)) {
    const names = [];
    for (const name of namesOf(id) ?? []) if (typeof name === 'string' && name.trim() && !names.includes(name.trim())) names.push(name.trim());
    roster.push({ id, names: names.slice(0, maxNames) });
  }
  return roster;
}

/**
 * One extract request: system = `prompts.backfill` with `{{name}}`; user = `<roster>` (JSON, from
 * `rosterOf`) and `<window>` (JSON: `channel`, `date`, `lines` of `{ id, at, by, replyTo, text,
 * media }`, `by` the persona's id on her own lines). See docs/prompt-contract.md, "Backfill".
 * @param {{ prompts: object, selfName: string, selfId: string|null, window: object, roster: object[], channelName?: string|null }} input
 * @returns {{ role: string, content: string }[]}
 * @throws {Error} `prompts.backfill` is missing or blank.
 */
export function buildExtractRequest({ prompts, selfName, selfId, window, roster, channelName = null }) {
  const template = prompts?.backfill;
  if (typeof template !== 'string' || !template.trim()) throw new Error('prompts.backfill is missing or empty');
  const lines = (window?.lines ?? []).map((line) => ({
    id: line.messageId,
    at: line.occurredAt,
    by: line.kind === 'said' ? selfId : (line.by ?? null),
    replyTo: replyOf(line),
    text: typeof line.text === 'string' ? line.text : '',
    ...(Array.isArray(line.media) && line.media.length > 0 ? { media: line.media } : {}),
  }));
  const user = [
    block('roster', JSON.stringify(roster)),
    block('window', JSON.stringify({ channel: channelName, date: window?.day ?? null, lines })),
  ].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: fillPromptTemplate(template, { name: selfName }) },
    { role: 'user', content: user },
  ];
}

/** An integer weight 1..5, 3 when missing or unreadable. */
function weightOf(raw) {
  const n = Number.isInteger(raw) ? raw : 3;
  return Math.min(5, Math.max(1, n));
}

/** The cited ids, as strings, distinct. */
function citedIds(sources) {
  return [...new Set((Array.isArray(sources) ? sources : []).map((id) => String(id)))];
}

/** The cited ids that are lines of the window, in the window's order, as sourceRefs. */
function refsOf(cited, window) {
  const ids = new Set(cited);
  return (window?.lines ?? [])
    .filter((line) => ids.has(line.messageId))
    .map((line) => ({ channelId: channelOf(line), messageId: line.messageId }));
}

/** The authors of the cited lines, the persona left out. */
function citedAuthors(refs, window, selfId) {
  const ids = new Set(refs.map((ref) => ref.messageId));
  return (window?.lines ?? []).filter((line) => ids.has(line.messageId) && line.kind !== 'said' && line.by && line.by !== selfId).map((line) => line.by);
}

const distinct = (ids) => [...new Set(ids.filter((id) => typeof id === 'string' && id))];

/** Whitespace collapsed to single spaces, trimmed. */
const squash = (text) => (typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : '');

/**
 * `text` with every whole-word form of the persona's name (`selfNames`) and every `<@!selfId>`
 * turned into `<@selfId>` (src/memory/mentions.js#redactUser); unchanged without a `selfId`.
 */
function selfTokens(text, selfId, selfNames) {
  if (typeof text !== 'string' || typeof selfId !== 'string' || !selfId) return text;
  return redactUser(text, { userId: selfId, names: selfNames, token: `<@${selfId}>` });
}

/**
 * A free text of the answer: the persona's name forms turned into her token, then clamped.
 * `cut`: the clamp shortened it and it does not end at a sentence end.
 */
function textOf(raw, limit, tolerance, selfId, selfNames) {
  const full = typeof raw === 'string' ? selfTokens(raw, selfId, selfNames).trim() : '';
  const text = clampText(full, limit, { tolerance });
  return { text, cut: text !== full && Boolean(text) && !SENTENCE_END_RE.test(text) };
}

/**
 * Who a candidate involves: `participants` = the main member, the authors of the cited lines and
 * every `<@id>` of its texts (the persona left out); `mentioned` = the ids of the texts that are
 * neither the main member nor an author of a cited line.
 */
function peopleOf(main, refs, texts, window, selfId) {
  const authors = citedAuthors(refs, window, selfId);
  const named = distinct(texts.flatMap((text) => tokenIds(text))).filter((id) => id !== selfId);
  const actors = new Set([main, ...authors]);
  return {
    participants: distinct([main, ...authors, ...named]),
    mentioned: named.filter((id) => !actors.has(id)),
  };
}

/**
 * The candidates of one extract answer (`{ "episodes": [...], "lessons": [...] }`, see
 * docs/prompt-contract.md, "Backfill") and what was taken out of it. Untrusted input: never
 * throws. An item citing an id that is not a line of `window` is dropped whole
 * (`counts.outsideWindow`), one citing nothing is dropped. An episode needs `member`, a member the
 * window names other than the persona, and `what`; a lesson needs `text`, its `from` is kept only
 * when it is such a member. In `what`, `brief` and `text` the persona's name forms (`selfNames`)
 * become `<@selfId>` (never in `quote`); then texts are clamped as the store clamps them, and a
 * `what` the clamp cut that does not end at a sentence end is counted (`counts.clamped`). A
 * `quote` is kept only when `quoteSourceId` is a line of the window whose text holds the quote
 * verbatim (whitespace collapsed); otherwise it is emptied (`counts.quotesDropped`). The date and
 * `observedAt` are the window's day. Each candidate carries `participants` (its member or
 * teacher, the authors of its sources, every `<@id>` of its texts) and `mentioned` (the ids of
 * its texts that are not its member or teacher nor an author of a source).
 * @param {unknown} text  The model's reply.
 * @param {{ window: object, selfId: string|null, selfNames?: string[], clampTolerance?: number, learnedChars?: number }} options
 * @returns {{ candidates: object[], counts: { clamped: number, quotesDropped: number, outsideWindow: number } }}
 */
export function readExtractAnswer(text, { window, selfId, selfNames = [], clampTolerance = MEMORY_LIMIT_DEFAULTS.clampTolerance, learnedChars = MEMORY_LIMIT_DEFAULTS.learnedChars }) {
  const counts = { clamped: 0, quotesDropped: 0, outsideWindow: 0 };
  let answer;
  try {
    answer = parseJsonObject(text);
  } catch {
    return { candidates: [], counts };
  }
  if (!answer || typeof answer !== 'object') return { candidates: [], counts };
  const members = new Set(windowMembers(window, selfId));
  const lineById = new Map((window?.lines ?? []).map((line) => [line.messageId, line]));
  const names = Array.isArray(selfNames) ? selfNames : [];
  const base = { windowId: window?.id ?? null, channelId: window?.channelId ?? null, date: window?.day ?? null, observedAt: window?.day ?? null };
  /** The sourceRefs of an item, null when it cites an id outside the window (counted). */
  const sourcesOf = (raw) => {
    const cited = citedIds(raw.sources);
    if (cited.some((id) => !lineById.has(id))) {
      counts.outsideWindow += 1;
      return null;
    }
    return refsOf(cited, window);
  };
  const candidates = [];
  for (const raw of Array.isArray(answer.episodes) ? answer.episodes : []) {
    if (!raw || typeof raw !== 'object') continue;
    const sourceRefs = sourcesOf(raw);
    if (!sourceRefs) continue;
    const member = typeof raw.member === 'string' ? raw.member.trim() : '';
    const what = textOf(raw.what, EPISODE_CHARS.what, clampTolerance, selfId, names);
    if (!members.has(member) || !what.text || sourceRefs.length === 0) continue;
    if (what.cut) counts.clamped += 1;
    let quote = clampText(raw.quote, EPISODE_CHARS.quote, { tolerance: 1 });
    const quoteSourceId = raw.quoteSourceId === undefined || raw.quoteSourceId === null ? '' : String(raw.quoteSourceId);
    const quoted = lineById.get(quoteSourceId);
    if (quote && !(quoted && squash(quoted.text).includes(squash(quote)))) {
      quote = '';
      counts.quotesDropped += 1;
    }
    const brief = textOf(raw.brief, BRIEF_CHARS, 1, selfId, names).text;
    candidates.push({
      kind: 'episode',
      ...base,
      userId: member,
      what: what.text,
      quote,
      ...(quote ? { quoteSourceId } : {}),
      weight: weightOf(raw.weight),
      brief,
      sourceRefs,
      ...peopleOf(member, sourceRefs, [what.text, brief], window, selfId),
    });
  }
  for (const raw of Array.isArray(answer.lessons) ? answer.lessons : []) {
    if (!raw || typeof raw !== 'object') continue;
    const sourceRefs = sourcesOf(raw);
    if (!sourceRefs) continue;
    const lesson = textOf(raw.text, learnedChars, clampTolerance, selfId, names).text;
    if (!lesson || sourceRefs.length === 0) continue;
    const from = typeof raw.from === 'string' && members.has(raw.from.trim()) ? raw.from.trim() : null;
    candidates.push({
      kind: 'lesson',
      ...base,
      text: lesson,
      from,
      weight: weightOf(raw.weight),
      sourceRefs,
      ...peopleOf(from, sourceRefs, [lesson], window, selfId),
    });
  }
  return { candidates, counts };
}

/**
 * The candidates of one extract answer: `readExtractAnswer` without its counts.
 * @param {unknown} text
 * @param {{ window: object, selfId: string|null, selfNames?: string[], clampTolerance?: number, learnedChars?: number }} options
 * @returns {object[]}
 */
export function parseExtractAnswer(text, options) {
  return readExtractAnswer(text, options).candidates;
}

/** The message ids of a list of sourceRefs. */
const refIds = (refs) => new Set((Array.isArray(refs) ? refs : []).map((ref) => ref?.messageId).filter(Boolean));

/** Whether two sourceRefs lists share at least one message. */
function overlaps(a, b) {
  const ids = refIds(a);
  return [...refIds(b)].some((id) => ids.has(id));
}

/** Whether two items may be about different members: both name one and the names differ. */
const otherMember = (a, b) => Boolean(a && b && a !== b);

/**
 * The stable item id of a candidate: `ep-bf-` / `ln-bf-` and 16 hex digits of a sha256 of its
 * kind, member or teacher, cited message ids and normalised text, so a second run mints the same
 * id and the archive's index refuses it again.
 * @param {object} candidate
 * @returns {string}
 */
export function candidateItemId(candidate) {
  const kind = KINDS[candidate?.kind] ?? KINDS.episode;
  const ids = [...refIds(candidate?.sourceRefs)].sort();
  const who = candidate?.kind === 'lesson' ? (candidate?.from ?? '') : (candidate?.userId ?? '');
  const textOf = normalizeTopic(candidate?.kind === 'lesson' ? candidate?.text : candidate?.what);
  return `${kind.prefix}${createHash('sha256').update(JSON.stringify([candidate?.kind, who, ids, textOf]), 'utf8').digest('hex').slice(0, 16)}`;
}

/** The distinct lowercased words of at least three letters or digits of `text`, any script. */
function wordsOf(text) {
  const words = typeof text === 'string' ? text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [] : [];
  return new Set(words.filter((word) => Array.from(word).length >= 3));
}

/**
 * How much two texts say the same thing: the Jaccard index of their words (`wordsOf`), 0 when
 * either has none.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number}  0..1
 */
export function textSimilarity(a, b) {
  const x = wordsOf(a);
  const y = wordsOf(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const word of x) if (y.has(word)) shared += 1;
  return shared / (x.size + y.size - shared);
}

const sameMeaning = (a, b) => textSimilarity(a, b) >= SAME_MEANING;
/** The text a candidate (or an archived item's `text`) is compared by. */
const bodyOf = (item, kind) => (kind === 'lesson' ? item?.text : item?.what);
/** Whether two items name the same member: both name one and it is the same. */
const sameMember = (a, b) => typeof a === 'string' && a !== '' && a === b;
/** The teacher of an archived lesson (`stored.from`, a `<@id>` token), null when none. */
const archivedTeacher = (entry) => (typeof entry?.stored?.from === 'string' ? entry.stored.from.match(TEACHER_TOKEN_RE)?.[1] ?? null : null);

/** Why `candidate` is already in memory (a dedupe reason), or null. */
function heldInMemory(candidate, hotEpisodes, archived) {
  const episode = candidate.kind === 'episode';
  const itemKind = KINDS[candidate.kind].itemKind;
  const body = bodyOf(candidate, candidate.kind);
  if (episode) {
    const hot = hotEpisodes.filter((item) => !otherMember(item?.userId, candidate.userId));
    if (hot.some((item) => isSameEpisode(item, candidate))) return 'hot';
    if (hot.some((item) => sameMember(item?.userId, candidate.userId) && sameMeaning(item?.what, body))) return 'hot-similar';
  }
  const entries = archived.filter((entry) => entry?.itemKind === itemKind);
  if (entries.some((entry) => !(episode && otherMember(entry?.scope?.user, candidate.userId)) && overlaps(entry.sourceRefs, candidate.sourceRefs))) return 'archive';
  const similar = (entry) => {
    if (!sameMeaning(bodyOf(entry?.text, candidate.kind), body)) return false;
    return episode ? sameMember(entry?.scope?.user, candidate.userId) : archivedTeacher(entry) === (candidate.from ?? null);
  };
  if (entries.some(similar)) return 'archive-similar';
  return null;
}

/** Why `candidate` repeats `other`, a candidate kept before it (a dedupe reason), or null. */
function repeats(other, candidate) {
  if (other.kind !== candidate.kind) return null;
  if (candidate.kind === 'episode') {
    if (otherMember(other.userId, candidate.userId)) return null;
    if (overlaps(other.sourceRefs, candidate.sourceRefs) || isSameEpisode(other, candidate)) return 'repeat';
    return sameMember(other.userId, candidate.userId) && sameMeaning(other.what, candidate.what) ? 'similar' : null;
  }
  if (overlaps(other.sourceRefs, candidate.sourceRefs) || normalizeTopic(other.text) === normalizeTopic(candidate.text)) return 'repeat';
  return (other.from ?? null) === (candidate.from ?? null) && sameMeaning(other.text, candidate.text) ? 'similar' : null;
}

/** The earlier of two `YYYY-MM-DD` days, either when the other is missing. */
const earlierDay = (a, b) => (typeof a === 'string' && a && (typeof b !== 'string' || !b || a <= b) ? a : b);

/**
 * Two candidates that are one memory, merged: the longer text (whitespace collapsed; the kept
 * one on a tie) with its other fields, the earlier date and `observedAt`, the union of the
 * sourceRefs, participants and mentioned.
 */
function mergeCandidates(kept, candidate) {
  const length = (item) => Array.from(squash(bodyOf(item, item.kind))).length;
  const base = length(candidate) > length(kept) ? candidate : kept;
  const seen = refIds(kept.sourceRefs);
  const sourceRefs = [...(kept.sourceRefs ?? []), ...(candidate.sourceRefs ?? []).filter((ref) => !seen.has(ref?.messageId))];
  const main = base.kind === 'lesson' ? base.from : base.userId;
  const participants = distinct([...(kept.participants ?? []), ...(candidate.participants ?? [])]);
  const mentioned = distinct([...(kept.mentioned ?? []), ...(candidate.mentioned ?? [])]).filter((id) => id !== main);
  return { ...base, date: earlierDay(kept.date, candidate.date), observedAt: earlierDay(kept.observedAt, candidate.observedAt), sourceRefs, participants, mentioned };
}

/** Every reason a candidate can be dropped or merged for, in report order. */
export const DEDUPE_REASONS = Object.freeze(['hot', 'hot-similar', 'archive', 'archive-similar', 'repeat', 'similar']);

/**
 * Candidates against what memory already holds, in order. Dropped as already held: an episode
 * that is the same moment as a hot episode of the same member (src/memory/episodes.js#isSameEpisode,
 * `hot`) or says the same thing (`textSimilarity` at least `SAME_MEANING`, `hot-similar`); a
 * candidate whose sources share a message with an archived entry of the same kind (and, for an
 * episode, not of another member; `archive`), or that says the same thing as an archived entry
 * of the same kind and the same member or teacher (`archive-similar`). Merged into a candidate
 * kept before it (`mergeCandidates`: the longer text, the earlier date, the sources united): one
 * of the same kind and member sharing a source or being the same moment, or a lesson sharing a
 * source or with the same text (`repeat`); one of the same kind and member or teacher saying the
 * same thing (`similar`). The rest are kept with their `itemId` (`candidateItemId`, of the merged
 * candidate).
 * @param {object[]} candidates
 * @param {{ hotEpisodes?: object[], archived?: object[] }} [memory]  `hotEpisodes`: stored
 *   episodes with their member's `userId`; `archived`: archive entries (`itemKind`, `sourceRefs`,
 *   `scope`, `text`, `stored`).
 * @returns {{ kept: object[], dropped: { candidate: object, reason: string }[] }}  `reason` one of `DEDUPE_REASONS`.
 */
export function dedupeCandidates(candidates, { hotEpisodes = [], archived = [] } = {}) {
  const kept = [];
  const dropped = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate || !KINDS[candidate.kind]) continue;
    const held = heldInMemory(candidate, hotEpisodes, archived);
    if (held) {
      dropped.push({ candidate, reason: held });
      continue;
    }
    let reason = null;
    const index = kept.findIndex((other) => (reason = repeats(other, candidate)) !== null);
    if (index === -1) {
      kept.push({ ...candidate });
      continue;
    }
    kept[index] = mergeCandidates(kept[index], candidate);
    dropped.push({ candidate, reason });
  }
  return { kept: kept.map((candidate) => ({ ...candidate, itemId: candidateItemId(candidate) })), dropped };
}

/**
 * A kept candidate as the item src/memory/archive.js#archiveEntry archives, with its scope: an
 * episode `{ itemId, date, what, quote, quoteSourceId (with a quote), feeling: '', weight, userId,
 * windowId, sourceRefs, mentioned }` under `{ user }`; a lesson `{ itemId, text, from: '<@id>',
 * date, weight, windowId, sourceRefs, mentioned }` under `{ guild: true }`; `mentioned` only when
 * not empty. `feeling` given (a voice reconstruction) is stored with `reconstructedAt`.
 * @param {object} candidate
 * @param {{ feeling?: string, reconstructedAt?: string }} [extra]
 * @returns {{ item: object, itemKind: string, scope: object, participants: string[] }}
 */
export function archiveItemOf(candidate, { feeling = '', reconstructedAt = null } = {}) {
  const mentioned = Array.isArray(candidate.mentioned) && candidate.mentioned.length > 0 ? { mentioned: candidate.mentioned } : {};
  const common = { itemId: candidate.itemId ?? candidateItemId(candidate), date: candidate.date, weight: candidate.weight, windowId: candidate.windowId ?? null, sourceRefs: candidate.sourceRefs, ...mentioned };
  const participants = Array.isArray(candidate.participants) ? candidate.participants : [];
  if (candidate.kind === 'lesson') {
    return {
      item: { ...common, text: candidate.text, ...(candidate.from ? { from: `<@${candidate.from}>` } : {}) },
      itemKind: 'lesson',
      scope: { guild: true },
      participants,
    };
  }
  return {
    item: { ...common, what: candidate.what, quote: candidate.quote ?? '', ...(candidate.quote && candidate.quoteSourceId ? { quoteSourceId: candidate.quoteSourceId } : {}), feeling, userId: candidate.userId, ...(reconstructedAt ? { reconstructedAt } : {}) },
    itemKind: 'episode',
    scope: { user: candidate.userId },
    participants,
  };
}

/**
 * Whether the deletion ledger (`[{ userId, at }]`) takes a candidate out: it names a forgotten
 * member (as its member, teacher or a participant) and was observed before their forget.
 * @param {object} candidate
 * @param {{ userId: string, at: string }[]} ledger
 * @returns {boolean}
 */
export function ledgerDrops(candidate, ledger) {
  const names = new Set(distinct([candidate?.userId, candidate?.from, ...(Array.isArray(candidate?.participants) ? candidate.participants : [])]));
  const observed = Date.parse(candidate?.observedAt);
  return (Array.isArray(ledger) ? ledger : []).some((entry) => names.has(String(entry?.userId)) && !(observed >= Date.parse(entry?.at)));
}

/**
 * The cursor of one channel moved past a fetched page, only when its append was durable
 * (`outcome.durable`); otherwise `cursors` itself is returned. A page with messages sets `last`
 * (its newest id) and `resume` (the `after` it was fetched with, so a later run fetches that page
 * again: one page of overlap); `written` adds the lines written; `reachedEnd` marks the channel
 * done up to `until`. Never mutates `cursors`.
 * @param {object} cursors  `{ [channelId]: { resume, last, written, doneUntil } }`
 * @param {string} channelId
 * @param {{ after: string, lastId: string|null, reachedEnd: boolean, until: string }} page
 * @param {{ durable: boolean, written?: number }} outcome
 * @returns {object}
 */
export function advanceCursor(cursors, channelId, page, outcome) {
  if (outcome?.durable !== true) return cursors;
  const prev = cursors?.[channelId] ?? { resume: null, last: null, written: 0, doneUntil: null };
  const moved = typeof page?.lastId === 'string' && page.lastId !== '';
  return {
    ...cursors,
    [channelId]: {
      resume: moved ? page.after : prev.resume,
      last: moved ? page.lastId : prev.last,
      written: (prev.written ?? 0) + (Number.isFinite(outcome.written) ? outcome.written : 0),
      doneUntil: page?.reachedEnd === true ? page.until : (prev.doneUntil ?? null),
    },
  };
}

/**
 * The cost of extracting `windows`: `tokensPerWindow` (a number, or a function of the window)
 * summed, priced at `usdPerKTok` per thousand tokens (rounded to a millionth).
 * @param {object[]} windows
 * @param {number|((window: object) => number)} tokensPerWindow
 * @param {number} usdPerKTok
 * @returns {{ windows: number, tokens: number, usd: number }}
 */
export function estimate(windows, tokensPerWindow, usdPerKTok) {
  const list = Array.isArray(windows) ? windows : [];
  const each = typeof tokensPerWindow === 'function' ? tokensPerWindow : () => tokensPerWindow;
  const tokens = list.reduce((sum, window) => sum + Math.max(0, Number(each(window)) || 0), 0);
  const usd = Math.round(((tokens / 1000) * (Number(usdPerKTok) || 0)) * 1e6) / 1e6;
  return { windows: list.length, tokens, usd };
}

// ---- links: link previews for record lines written before the record kept them -----------------

/**
 * The URLs of `text` (src/memory/mentions.js#URL_PATTERN) a link preview could come from: every
 * one but a GIF site's (src/media/classify.js#isGifHostUrl), whose URL the record already drops.
 * @param {unknown} text
 * @returns {string[]}
 */
export function linkUrls(text) {
  if (typeof text !== 'string' || !text) return [];
  return (text.match(new RegExp(URL_PATTERN, 'g')) ?? []).filter((url) => !isGifHostUrl(url));
}

const revisionNumber = (line) => (Number.isInteger(line?.revision) && line.revision > 0 ? line.revision : 1);

/**
 * The record lines whose link previews `links` should fetch: per message the newest revision of
 * its `seen` or `said` line (a message with a `deleted` line is left out), kept when its text has
 * a URL (linkUrls: not only GIF sites') and it has no `links`. `counts`: the messages standing,
 * the deleted ones, those already with `links`, those whose only URLs are GIF sites', and the
 * candidates. Candidates in channel order, then by message id.
 * @param {Iterable<object>} lines  Record lines (src/memory/record.js).
 * @returns {{ candidates: object[], counts: { messages: number, deleted: number, withLinks: number, gifOnly: number, candidates: number } }}
 */
export function linkCandidates(lines) {
  const newest = new Map();
  const deleted = new Set();
  for (const line of lines ?? []) {
    if (!line || typeof line !== 'object' || typeof line.messageId !== 'string' || !line.messageId) continue;
    if (line.kind === 'deleted') {
      deleted.add(line.messageId);
      continue;
    }
    if (line.kind !== 'seen' && line.kind !== 'said') continue;
    const held = newest.get(line.messageId);
    if (!held || revisionNumber(line) > revisionNumber(held)) newest.set(line.messageId, line);
  }
  const counts = { messages: 0, deleted: 0, withLinks: 0, gifOnly: 0, candidates: 0 };
  const candidates = [];
  for (const [messageId, line] of newest) {
    if (deleted.has(messageId)) {
      counts.deleted += 1;
      continue;
    }
    counts.messages += 1;
    if (Array.isArray(line.links)) {
      counts.withLinks += 1;
      continue;
    }
    if (linkUrls(line.text).length > 0) candidates.push(line);
    else if (new RegExp(URL_PATTERN).test(String(line.text ?? ''))) counts.gifOnly += 1;
  }
  const channelOfLine = (line) => String(line.scope?.channel ?? '');
  const byId = (a, b) => (a.messageId.length - b.messageId.length) || (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0);
  candidates.sort((a, b) => (channelOfLine(a) < channelOfLine(b) ? -1 : channelOfLine(a) > channelOfLine(b) ? 1 : byId(a, b)));
  counts.candidates = candidates.length;
  return { candidates, counts };
}

/**
 * The next revision of a record line with its link previews: revision + 1, a new line `id` and
 * `recordedAt`, `links` after `media` (src/memory/record.js#toRecordLine's order), every other
 * field as `newest` has it. `newest` is not changed.
 * @param {object} newest  The newest revision of the message.
 * @param {object[]} links  src/memory/record.js#recordLinks items.
 * @param {{ id: string, recordedAt: string }} stamp
 * @returns {object}
 */
export function linkRevision(newest, links, { id, recordedAt }) {
  const out = {};
  let placed = false;
  for (const [key, value] of Object.entries(newest)) {
    if (key === 'links') continue;
    if (key === 'id') out.id = id;
    else if (key === 'revision') out.revision = revisionNumber(newest) + 1;
    else if (key === 'recordedAt') out.recordedAt = recordedAt;
    else out[key] = value;
    if (key === 'media') {
      out.links = links;
      placed = true;
    }
  }
  out.id = id;
  out.revision = revisionNumber(newest) + 1;
  out.recordedAt = recordedAt;
  if (!placed) out.links = links;
  return out;
}
