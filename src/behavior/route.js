// The pure core of the channel route classifier. A conversation often turns
// to another channel without anyone writing its explicit <#id> ("what was in
// the diary channel yesterday?"); the pull phase (src/behavior/pull.js) only
// sees the explicit tokens, so the persona would be asked about a channel it
// cannot see. One cheap classifier call reads the chat around the turn and a
// numbered list of the server's channels and answers one number or `none`;
// the pick goes to the pull phase as a route hook id. This module holds the
// decisions -- the `route` settings and the `features.channelRoute` switch,
// which turns may ask, the numbered list, the request, the answer parser --
// with no I/O; src/behavior/route-channel.js is the thin side that reads the
// store, judges the channels and sends the request. No wording of ours goes
// into the request: the prompt file says everything, the list lines carry
// structural fields only.

import { block, classifierTranscript, fillPromptTemplate } from './prompt.js';
import { clampText, oneLine } from '../memory/clamp.js';
import { topByRank } from '../memory/ranking.js';

/** Defaults of the `route` config group (config.json carries the same values). */
export const ROUTE_DEFAULTS = Object.freeze({
  contextMessages: 20,
  maxChannels: 40,
  purposeChars: 80,
  maxOutputTokens: 120,
});

/** How many aliases a channel's writer shows in its list line, best ranked first. */
const WRITER_ALIASES = 2;

/** Trigger kinds whose turn never asks the route classifier (see routeAllowed). */
const REFUSED_KINDS = new Set(['overheard', 'drawFailed', 'private']);

/** An integer from a finite `value` of at least `min` (floored), else `fallback`. */
function intAtLeast(value, fallback, min) {
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}

/**
 * The `route` settings read from the live config, or null when
 * `features.channelRoute` is false (a missing key counts as on). Each number
 * falls back to ROUTE_DEFAULTS when missing or unusable; counts are floored.
 * `contextMessages` 0 sends no transcript, `maxChannels` 0 lists nothing (no
 * call), `purposeChars` 0 leaves the purpose out of every line.
 * @param {object} config  The live config.
 * @returns {{ contextMessages: number, maxChannels: number, purposeChars: number, maxOutputTokens: number }|null}
 */
export function routeSettings(config) {
  if (config?.features?.channelRoute === false) return null;
  const r = config?.route ?? {};
  const d = ROUTE_DEFAULTS;
  return {
    contextMessages: intAtLeast(r.contextMessages, d.contextMessages, 0),
    maxChannels: intAtLeast(r.maxChannels, d.maxChannels, 0),
    purposeChars: intAtLeast(r.purposeChars, d.purposeChars, 0),
    maxOutputTokens: intAtLeast(r.maxOutputTokens, d.maxOutputTokens, 1),
  };
}

/**
 * Whether a turn may ask the route classifier: an ordinary reply turn of any
 * trigger kind (`mention`, `reply`, `name`, `followUp`) and a turn without a
 * trigger (`triggerKind` null: interject, initiate, a noticed comment) may;
 * an `overheard` line (talk about the persona asks it nothing), a `drawFailed`
 * turn (it only says the picture failed) and a private chat (no channels to
 * pull: `private`, or `privateChat` true) may not.
 * @param {{ triggerKind?: string|null, privateChat?: boolean }} [turn]
 * @returns {boolean}
 */
export function routeAllowed({ triggerKind = null, privateChat = false } = {}) {
  if (privateChat === true) return false;
  return !REFUSED_KINDS.has(triggerKind);
}

/**
 * The newest-first order of the stored channels by `lastMessageAt` (a number
 * of ms or an ISO string); one without a readable time goes last.
 */
function lastAt(channel) {
  const value = channel?.lastMessageAt;
  if (Number.isFinite(value)) return value;
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : -Infinity;
}

/**
 * The channel's main writer: its first `topWriters` entry when that writer
 * wrote at least half of `messageCount`, named by their stored profile
 * (`names[0]`) with their top WRITER_ALIASES aliases by rank
 * (src/memory/ranking.js#topByRank, decayed with `aliasHalfLifeDays`). Null
 * when there is none, or no stored name to show.
 * @param {object} channel  A stored channel entry.
 * @param {(userId: string) => object|null} profileOf
 * @param {number} [aliasHalfLifeDays]
 * @returns {{ name: string, aliases: string[] }|null}
 */
export function routeWriter(channel, profileOf, aliasHalfLifeDays) {
  const top = Array.isArray(channel?.topWriters) ? channel.topWriters[0] : null;
  const count = Number(top?.count);
  const total = Number(channel?.messageCount);
  if (!top?.id || !Number.isFinite(count) || count < 1 || !Number.isFinite(total) || count < total / 2) return null;
  const profile = typeof profileOf === 'function' ? profileOf(String(top.id)) : null;
  const name = oneLine(Array.isArray(profile?.names) ? profile.names[0] : '');
  if (!name) return null;
  const aliases = topByRank(Array.isArray(profile.aliases) ? profile.aliases : [], WRITER_ALIASES, aliasHalfLifeDays)
    .map((alias) => oneLine(alias?.name))
    .filter(Boolean);
  return { name, aliases };
}

/** Snowflake ids ascending: shorter first, then by digits; any other string by plain comparison. */
function compareIds(a, b) {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * The channels the classifier may pick from: the stored `channels` except
 * the `exclude` ids, newest `lastMessageAt` first, each judged by `check`
 * (null = the pull would refuse it, so a pick is never wasted on it; else the
 * live channel, whose name stands in for an empty stored one) until `max`
 * are kept. `check` is asked in that order and not after the list is full.
 * The kept ones are returned in channel id order (ascending).
 * @param {{ channels: object[], exclude?: Iterable<string>, check: (id: string) => ({ name?: string }|null),
 *   profileOf?: (userId: string) => object|null, max: number, aliasHalfLifeDays?: number }} params
 * @returns {{ id: string, name: string, writer: { name: string, aliases: string[] }|null, purpose: string }[]}
 */
export function routeEntries({ channels, exclude = [], check, profileOf, max, aliasHalfLifeDays }) {
  const skip = new Set(exclude);
  const limit = intAtLeast(max, 0, 0);
  const out = [];
  if (limit === 0 || typeof check !== 'function') return out;
  const ordered = (Array.isArray(channels) ? channels : [])
    .filter((channel) => typeof channel?.id === 'string' && channel.id && !skip.has(channel.id))
    .map((channel, index) => ({ channel, index }))
    .sort((a, b) => lastAt(b.channel) - lastAt(a.channel) || a.index - b.index)
    .map(({ channel }) => channel);
  for (const channel of ordered) {
    if (out.length >= limit) break;
    const live = check(channel.id);
    if (!live) continue;
    const name = oneLine(channel.name) || oneLine(live.name);
    if (!name) continue;
    out.push({
      id: channel.id,
      name,
      writer: routeWriter(channel, profileOf, aliasHalfLifeDays),
      purpose: typeof channel.purpose === 'string' ? channel.purpose : '',
    });
  }
  // Chosen by recency, listed by id: the text stays the same between turns (the provider's prompt cache).
  return out.sort((a, b) => compareIds(a.id, b.id));
}

/**
 * The `<channels>` lines: one per entry (already ordered by the caller), at
 * most `max`, numbered from 1 -- `n | #name | writer (alias, alias) | purpose`.
 * The writer part is empty when there is none (and the name alone when it has
 * no alias); the purpose is put on one line and cut at a clean boundary to
 * `purposeChars` (src/memory/clamp.js#clampText, tolerance 1), 0 leaving it
 * out. Structural fields only: no words of ours. `ids[n - 1]` is the channel
 * of line `n`.
 * @param {{ id: string, name: string, writer?: { name: string, aliases?: string[] }|null, purpose?: string }[]} entries
 * @param {{ max?: number, purposeChars?: number }} [options]
 * @returns {{ lines: string[], ids: string[] }}
 */
export function routeChannelList(entries, { max, purposeChars } = {}) {
  const limit = intAtLeast(max, ROUTE_DEFAULTS.maxChannels, 0);
  const chars = intAtLeast(purposeChars, ROUTE_DEFAULTS.purposeChars, 0);
  const lines = [];
  const ids = [];
  for (const entry of (Array.isArray(entries) ? entries : []).slice(0, limit)) {
    const writer = entry.writer?.name ? oneLine(entry.writer.name) : '';
    const aliases = (entry.writer?.aliases ?? []).map(oneLine).filter(Boolean);
    const writerPart = writer && aliases.length > 0 ? `${writer} (${aliases.join(', ')})` : writer;
    const purpose = chars > 0 ? clampText(oneLine(entry.purpose), chars, { tolerance: 1 }) : '';
    lines.push(`${ids.length + 1} | #${oneLine(entry.name)} | ${writerPart} | ${purpose}`.trimEnd());
    ids.push(entry.id);
  }
  return { lines, ids };
}

/**
 * The turn's message the classifier judges: the trigger, or on a turn
 * without one the newest message of `history` that is neither the persona's
 * own nor another bot's. Null when there is none.
 * @param {object[]} history  Normalized messages, oldest first.
 * @param {object|null} trigger
 * @returns {object|null}
 */
export function routeCandidate(history, trigger) {
  if (trigger) return trigger;
  const list = Array.isArray(history) ? history : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i];
    if (message && !message.self && !message.bot) return message;
  }
  return null;
}

/**
 * The `<transcript>` and `<candidate>` blocks: the last `contextMessages`
 * messages of `history` before the candidate (all of it but the candidate
 * when the candidate is not in it), rendered like the other classifiers'
 * context (src/behavior/prompt.js#classifierTranscript, labels from `labels`,
 * no caption: the request runs beside the turn's media preparation), and the candidate's
 * author and text cut to `context.maxMessageChars`. `transcriptBlock` is ''
 * for a window of 0 or no earlier message.
 * @param {{ history: object[], candidate: object, contextMessages: number, config: object,
 *   labels: object, selfName: string }} params
 * @returns {{ transcriptBlock: string, candidateBlock: string }}
 */
export function routeContext({ history, candidate, contextMessages, config, labels, selfName }) {
  const list = Array.isArray(history) ? history : [];
  const at = list.findIndex((m) => m?.id === candidate.id);
  const before = (at === -1 ? list.filter((m) => m && m.id !== candidate.id) : list.slice(0, at)).filter(Boolean);
  const context = contextMessages > 0 ? before.slice(-contextMessages) : [];
  const maxChars = config.context?.maxMessageChars ?? 800;
  const text = [...String(candidate.content ?? '')].slice(0, maxChars).join('');
  const candidateBlock = block('candidate', `${candidate.authorName}: ${text}`);
  if (context.length === 0) return { transcriptBlock: '', candidateBlock };
  return { transcriptBlock: block('transcript', classifierTranscript(context, { config, selfName, labels })), candidateBlock };
}

/**
 * The route classifier's request: the system message is `prompt` with
 * `{{name}}` filled with the persona's display name; the user message is the
 * `<channels>` block (the lines, one per line: the stable bulk first), the
 * `transcriptBlock` (may be ''), then the `candidateBlock`. Null when the prompt is blank or there is
 * no line.
 * @param {{ prompt: string|null|undefined, selfName: string, transcriptBlock?: string,
 *   candidateBlock?: string, lines: string[] }} params
 * @returns {{ role: string, content: string }[]|null}
 */
export function buildRouteRequest({ prompt, selfName, transcriptBlock = '', candidateBlock = '', lines }) {
  if (typeof prompt !== 'string' || !prompt.trim()) return null;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const user = [block('channels', lines.join('\n')), transcriptBlock, candidateBlock].filter(Boolean).join('\n');
  return [
    { role: 'system', content: fillPromptTemplate(prompt, { name: selfName ?? '' }) },
    { role: 'user', content: user },
  ];
}

/** Quotes that may wrap the whole answer. */
const WRAPPING = /^["'`«“‘]+|["'`»”’]+$/gu;
/** Punctuation that may trail the answer. */
const TRAILING = /[.,;:!?…]+$/u;

/**
 * The classifier's answer: its first non-empty line, wrapping quotes and
 * trailing punctuation stripped. `none` as the first word (any case) ->
 * `{ index: null, reason: 'none' }`; a number (`3`, `#3`, `3.`) within
 * `1..count` -> `{ index, reason: 'pick' }` (1-based), outside it ->
 * `unknown-id`; nothing -> `empty`; anything else -> `unparsed`.
 * @param {unknown} raw
 * @param {number} count  How many lines the list had.
 * @returns {{ index: number|null, reason: 'pick'|'none'|'unknown-id'|'empty'|'unparsed' }}
 */
export function parseRouteAnswer(raw, count) {
  const first = String(raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return { index: null, reason: 'empty' };
  const text = first.replace(WRAPPING, '').trim().replace(TRAILING, '').trim();
  if (!text) return { index: null, reason: 'empty' };
  const word = text.split(/\s+/u)[0].replace(/[^\p{L}]/gu, '').toLowerCase();
  if (word === 'none') return { index: null, reason: 'none' };
  const number = /^#?(\d+)$/u.exec(text);
  if (!number) return { index: null, reason: 'unparsed' };
  const index = Number(number[1]);
  if (!Number.isSafeInteger(index) || index < 1 || index > count) return { index: null, reason: 'unknown-id' };
  return { index, reason: 'pick' };
}
