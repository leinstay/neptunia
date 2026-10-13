// The pure part of tools/backfill.mjs: the windows of connected lines a stream of record lines
// falls into, the extract request and its answer, the dedupe of candidates against hot episodes
// and the archive, the stable item ids of what survives, the per-channel cursor of the fetch, the
// deletion ledger's rule on candidates, and the cost estimate. No I/O, no clock, no randomness.

import { createHash } from 'node:crypto';
import { block, fillPromptTemplate } from '../../src/behavior/prompt.js';
import { parseJsonObject } from '../../src/llm/parse.js';
import { clampText } from '../../src/memory/clamp.js';
import { EPISODE_CHARS, isSameEpisode } from '../../src/memory/episodes.js';
import { normalizeTopic } from '../../src/memory/interests.js';
import { ID_DIGITS } from '../../src/memory/mentions.js';
import { MEMORY_LIMIT_DEFAULTS } from '../../src/memory/text-limits.js';

/** The longest window, in lines (`--window-max`). */
export const WINDOW_MAX_LINES = 120;
/** The kind of archive item each candidate kind becomes, and its item id prefix. */
const KINDS = Object.freeze({ episode: { itemKind: 'episode', prefix: 'ep-bf-' }, lesson: { itemKind: 'lesson', prefix: 'ln-bf-' } });
/** How long a candidate's brief for the voice pass may be. */
const BRIEF_CHARS = 300;
const ID_RE = new RegExp(`^${ID_DIGITS}$`);
const DISCORD_EPOCH = 1420070400000n;

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
 * The windows of connected lines in `lines` (record lines, any order): per channel, a line joins
 * the window of the message it replies to when that window is still open, else the channel's
 * current window when it came at most `gapMinutes` after that window's last line, else it opens a
 * new one. A window holds at most `maxLines` lines, then closes (a reply into it opens a new one).
 * Ordered by their first line. Each: `{ id: 'w-<first messageId>', channelId, day (UTC day of the
 * first line), startAt, endAt, lines }`. Lines without a time or a message id are left out.
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
 * media }`, `by` the persona's id on her own lines). See docs/en/prompt-contract.md, "Backfill".
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

/** The cited ids that are lines of the window, distinct, in the window's order, as sourceRefs. */
function refsOf(sources, window) {
  const cited = new Set((Array.isArray(sources) ? sources : []).map((id) => String(id)));
  return (window?.lines ?? [])
    .filter((line) => cited.has(line.messageId))
    .map((line) => ({ channelId: channelOf(line), messageId: line.messageId }));
}

/** The authors of the cited lines, the persona left out. */
function citedAuthors(refs, window, selfId) {
  const ids = new Set(refs.map((ref) => ref.messageId));
  return (window?.lines ?? []).filter((line) => ids.has(line.messageId) && line.kind !== 'said' && line.by && line.by !== selfId).map((line) => line.by);
}

const distinct = (ids) => [...new Set(ids.filter((id) => typeof id === 'string' && id))];

/**
 * The candidates of one extract answer (`{ "episodes": [...], "lessons": [...] }`, see
 * docs/en/prompt-contract.md, "Backfill"). Untrusted input: never throws. An item keeps only the
 * `sources` that are lines of `window` and is dropped without one. An episode needs `member`, a
 * member the window names other than the persona, and `what`; a lesson needs `text`, its `from`
 * is kept only when it is such a member. Texts are clamped as the store clamps them; the date and
 * `observedAt` are the window's day. Each candidate carries `participants`: its member or teacher
 * and the authors of its sources.
 * @param {unknown} text  The model's reply.
 * @param {{ window: object, selfId: string|null, clampTolerance?: number, learnedChars?: number }} options
 * @returns {object[]}
 */
export function parseExtractAnswer(text, { window, selfId, clampTolerance = MEMORY_LIMIT_DEFAULTS.clampTolerance, learnedChars = MEMORY_LIMIT_DEFAULTS.learnedChars }) {
  let answer;
  try {
    answer = parseJsonObject(text);
  } catch {
    return [];
  }
  if (!answer || typeof answer !== 'object') return [];
  const members = new Set(windowMembers(window, selfId));
  const base = { windowId: window?.id ?? null, channelId: window?.channelId ?? null, date: window?.day ?? null, observedAt: window?.day ?? null };
  const out = [];
  for (const raw of Array.isArray(answer.episodes) ? answer.episodes : []) {
    if (!raw || typeof raw !== 'object') continue;
    const member = typeof raw.member === 'string' ? raw.member.trim() : '';
    const what = clampText(raw.what, EPISODE_CHARS.what, { tolerance: clampTolerance });
    const sourceRefs = refsOf(raw.sources, window);
    if (!members.has(member) || !what || sourceRefs.length === 0) continue;
    out.push({
      kind: 'episode',
      ...base,
      userId: member,
      what,
      quote: clampText(raw.quote, EPISODE_CHARS.quote, { tolerance: 1 }),
      weight: weightOf(raw.weight),
      brief: clampText(raw.brief, BRIEF_CHARS, { tolerance: 1 }),
      sourceRefs,
      participants: distinct([member, ...citedAuthors(sourceRefs, window, selfId)]),
    });
  }
  for (const raw of Array.isArray(answer.lessons) ? answer.lessons : []) {
    if (!raw || typeof raw !== 'object') continue;
    const lesson = clampText(raw.text, learnedChars, { tolerance: clampTolerance });
    const sourceRefs = refsOf(raw.sources, window);
    if (!lesson || sourceRefs.length === 0) continue;
    const from = typeof raw.from === 'string' && members.has(raw.from.trim()) ? raw.from.trim() : null;
    out.push({
      kind: 'lesson',
      ...base,
      text: lesson,
      from,
      weight: weightOf(raw.weight),
      sourceRefs,
      participants: distinct([from, ...citedAuthors(sourceRefs, window, selfId)]),
    });
  }
  return out;
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

/**
 * Candidates against what memory already holds, in order: an episode that is the same moment as
 * a hot episode of the same member (src/memory/episodes.js#isSameEpisode) is dropped (`hot`); a
 * candidate whose sources share a message with an archived entry of the same kind (and, for an
 * episode, not of another member) is dropped (`archive`); one that repeats a candidate kept
 * before it (the same kind and member and a shared source, the same moment, or the same lesson
 * text) is dropped (`repeat`). The rest are kept with their `itemId` (`candidateItemId`).
 * @param {object[]} candidates
 * @param {{ hotEpisodes?: object[], archived?: object[] }} [memory]  `hotEpisodes`: stored
 *   episodes with their member's `userId`; `archived`: archive entries (`itemKind`, `sourceRefs`, `scope`).
 * @returns {{ kept: object[], dropped: { candidate: object, reason: 'hot'|'archive'|'repeat' }[] }}
 */
export function dedupeCandidates(candidates, { hotEpisodes = [], archived = [] } = {}) {
  const kept = [];
  const dropped = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate || !KINDS[candidate.kind]) continue;
    const episode = candidate.kind === 'episode';
    const itemKind = KINDS[candidate.kind].itemKind;
    let reason = null;
    if (episode && hotEpisodes.some((hot) => !otherMember(hot?.userId, candidate.userId) && isSameEpisode(hot, candidate))) reason = 'hot';
    else if (archived.some((entry) => entry?.itemKind === itemKind && !(episode && otherMember(entry?.scope?.user, candidate.userId)) && overlaps(entry.sourceRefs, candidate.sourceRefs))) reason = 'archive';
    else if (
      kept.some((other) => {
        if (other.kind !== candidate.kind) return false;
        if (episode) return !otherMember(other.userId, candidate.userId) && (overlaps(other.sourceRefs, candidate.sourceRefs) || isSameEpisode(other, candidate));
        return overlaps(other.sourceRefs, candidate.sourceRefs) || normalizeTopic(other.text) === normalizeTopic(candidate.text);
      })
    ) reason = 'repeat';
    if (reason) dropped.push({ candidate, reason });
    else kept.push({ ...candidate, itemId: candidateItemId(candidate) });
  }
  return { kept, dropped };
}

/**
 * A kept candidate as the item src/memory/archive.js#archiveEntry archives, with its scope: an
 * episode `{ itemId, date, what, quote, feeling: '', weight, userId, windowId, sourceRefs }` under
 * `{ user }`; a lesson `{ itemId, text, from: '<@id>', date, weight, windowId, sourceRefs }` under
 * `{ guild: true }`. `feeling` given (a voice reconstruction) is stored with `reconstructedAt`.
 * @param {object} candidate
 * @param {{ feeling?: string, reconstructedAt?: string }} [extra]
 * @returns {{ item: object, itemKind: string, scope: object, participants: string[] }}
 */
export function archiveItemOf(candidate, { feeling = '', reconstructedAt = null } = {}) {
  const common = { itemId: candidate.itemId ?? candidateItemId(candidate), date: candidate.date, weight: candidate.weight, windowId: candidate.windowId ?? null, sourceRefs: candidate.sourceRefs };
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
    item: { ...common, what: candidate.what, quote: candidate.quote ?? '', feeling, userId: candidate.userId, ...(reconstructedAt ? { reconstructedAt } : {}) },
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
