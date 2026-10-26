// Pure logic for which names people actually use for a member: a profile's `addressedAs`, a map
// name -> `{ score, last }` the analyzer's batch fills by counting, with no model involved. A
// stored display name or open alias of a member that occurs as a word in someone else's line
// (src/memory/mentions.js#occursAsWordStem, so an inflected form counts) is one use of that name
// for that member; the persona's own lines count like anyone's, the member's own never. The
// score decays with a half-life (`memory.addressHalfLifeDays`), so the order says how he is
// called now, and the map keeps the best `MAX_ADDRESSED` names. A name two members share, or one
// under 3 letters, is never counted; nor is a name inside a URL, a code span or a ping.

import { foldText } from './recent.js';
import { isOpen } from './interests.js';
import { isWordChar, occursAsWholeWord, occursAsWordStem } from './mentions.js';
import { DAY_MS } from '../time.js';

/** `memory.addressHalfLifeDays` when it is missing (config.json carries the same). */
export const DEFAULT_ADDRESS_HALF_LIFE_DAYS = 30;
/** How many names a profile's `addressedAs` keeps at most. */
export const MAX_ADDRESSED = 12;
/** A name with fewer word characters than this is never counted. */
const MIN_NAME_LETTERS = 3;

const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const URL_RE = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S+/giu;
const DISCORD_TOKEN_RE = /<[^<>\s]+>/g;
const PING_RE = /@[\p{L}\p{N}_]+/gu;

/** `halfLifeDays` when it is a positive number, else the default. */
function halfLifeOf(halfLifeDays) {
  return Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays : DEFAULT_ADDRESS_HALF_LIFE_DAYS;
}

/** A stored entry as `{ score, last }` with `last` in ms, or null when it is not one. */
function readEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const lastMs = typeof entry.last === 'string' ? Date.parse(entry.last) : NaN;
  if (!Number.isFinite(entry.score) || entry.score < 0 || !Number.isFinite(lastMs)) return null;
  return { score: entry.score, lastMs };
}

/**
 * A stored `addressedAs` entry's score decayed to `nowMs`: `score * 0.5^(days since last /
 * halfLifeDays)`; a `now` before `last` is no decay. 0 for an entry that is not one.
 * @param {{ score: number, last: string }} entry
 * @param {number} nowMs
 * @param {number} [halfLifeDays]  Missing or not positive -> 30.
 * @returns {number}
 */
export function decayedScore(entry, nowMs, halfLifeDays) {
  const read = readEntry(entry);
  if (!read) return 0;
  const days = Math.max(0, (nowMs - read.lastMs) / DAY_MS);
  return read.score * 0.5 ** (days / halfLifeOf(halfLifeDays));
}

/**
 * A profile's stored `addressedAs` (untrusted JSON, possibly hand-edited) as a clean map: only
 * entries with a non-empty name, a finite non-negative `score` and a `last` that reads as a time;
 * anything but an object is `{}`.
 * @param {unknown} value
 * @returns {Object<string, { score: number, last: string }>}
 */
export function normalizeAddressedAs(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [name, entry] of Object.entries(value)) {
    if (!name.trim() || !readEntry(entry)) continue;
    out[name] = { score: entry.score, last: entry.last };
  }
  return out;
}

/**
 * The names of `addressedAs`, the highest score decayed to `nowMs` first (equal scores: the
 * latest use first, then the stored order). `[]` for nothing stored.
 * @param {unknown} addressedAs
 * @param {number} nowMs
 * @param {number} [halfLifeDays]
 * @returns {string[]}
 */
export function rankAddressed(addressedAs, nowMs, halfLifeDays) {
  const map = normalizeAddressedAs(addressedAs);
  return Object.entries(map)
    .map(([name, entry], index) => ({
      name,
      index,
      score: decayedScore(entry, nowMs, halfLifeDays),
      lastMs: Date.parse(entry.last),
    }))
    .sort((a, b) => b.score - a.score || b.lastMs - a.lastMs || a.index - b.index)
    .map((item) => item.name);
}

/**
 * Fold a batch's uses into a stored `addressedAs`. Pure: `existing` is never mutated. Each use
 * `{ name, at }` (`at` epoch ms) lands on the stored key equal to `name` once folded (case and
 * accents ignored; the stored spelling stays), else a new key spelled as `name`: `score = score *
 * 0.5^(days since last / halfLifeDays) + 1`, `last` = the use. A use older than `last` adds its
 * own decayed weight (`0.5^(days before last / halfLifeDays)`) and leaves `last` alone, so the
 * order of the uses does not matter. Then only the `max` best scores decayed to `now` (default:
 * the newest `last`) stay.
 * @param {unknown} existing  The stored map.
 * @param {Array<{ name: string, at: number }>} uses
 * @param {{ halfLifeDays?: number, max?: number, now?: number }} [opts]
 *   `halfLifeDays` missing or not positive -> 30; `max` missing -> 12.
 * @returns {Object<string, { score: number, last: string }>}
 */
export function applyAddressUses(existing, uses, { halfLifeDays, max = MAX_ADDRESSED, now } = {}) {
  const halfLife = halfLifeOf(halfLifeDays);
  const map = normalizeAddressedAs(existing);
  const keyOf = new Map(Object.keys(map).map((name) => [foldText(name), name]));
  for (const use of Array.isArray(uses) ? uses : []) {
    if (typeof use?.name !== 'string' || !use.name.trim() || !Number.isFinite(use.at)) continue;
    const folded = foldText(use.name);
    const key = keyOf.get(folded) ?? use.name.trim();
    keyOf.set(folded, key);
    const stored = readEntry(map[key]);
    if (!stored) {
      map[key] = { score: 1, last: new Date(use.at).toISOString() };
      continue;
    }
    const gapDays = Math.abs(use.at - stored.lastMs) / DAY_MS;
    const factor = 0.5 ** (gapDays / halfLife);
    map[key] =
      use.at >= stored.lastMs
        ? { score: stored.score * factor + 1, last: new Date(use.at).toISOString() }
        : { score: stored.score + factor, last: map[key].last };
  }
  const cap = Number.isInteger(max) && max >= 0 ? max : MAX_ADDRESSED;
  const names = Object.keys(map);
  if (names.length <= cap) return map;
  const nowMs = Number.isFinite(now) ? now : Math.max(...names.map((name) => Date.parse(map[name].last)));
  const kept = new Set(rankAddressed(map, nowMs, halfLife).slice(0, cap));
  return Object.fromEntries(names.filter((name) => kept.has(name)).map((name) => [name, map[name]]));
}

/** How many word characters `name` holds. */
function letterCount(name) {
  return [...name].filter((ch) => isWordChar(ch)).length;
}

/**
 * The names a batch may count, per member: every stored display name (`names`) and open alias
 * (`aliases[].name`) of each profile, each once (folded), without a name of fewer than 3 letters
 * and without a name (folded) stored for more than one member.
 * @param {object[]} profiles  Stored profiles (`id`, `names`, `aliases` read).
 * @returns {Array<{ userId: string, names: string[] }>}  Members with at least one name left.
 */
export function addressCandidates(profiles) {
  const members = [];
  const owners = new Map();
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    if (profile?.id === undefined || profile?.id === null) continue;
    const userId = String(profile.id);
    const raw = [
      ...(Array.isArray(profile.names) ? profile.names : []),
      ...(Array.isArray(profile.aliases)
        ? profile.aliases.filter((item) => isOpen(item)).map((item) => item?.name)
        : []),
    ];
    const seen = new Set();
    const names = [];
    for (const name of raw) {
      if (typeof name !== 'string' || letterCount(name) < MIN_NAME_LETTERS) continue;
      const folded = foldText(name);
      if (seen.has(folded)) continue;
      seen.add(folded);
      names.push(name.trim());
      if (!owners.has(folded)) owners.set(folded, new Set());
      owners.get(folded).add(userId);
    }
    members.push({ userId, names });
  }
  return members
    .map(({ userId, names }) => ({ userId, names: names.filter((name) => owners.get(foldText(name)).size === 1) }))
    .filter((member) => member.names.length > 0);
}

/**
 * A message's text as counting reads it: folded (src/memory/recent.js#foldText), without code
 * blocks, inline code, URLs, Discord tokens (`<@id>`, `<:emoji:id>`, ...) and pings -- `@` and a
 * known name (the longest first), then `@` and any word.
 */
function countableText(content, foldedNames) {
  let text = foldText(
    String(content ?? '')
      .replace(CODE_BLOCK_RE, ' ')
      .replace(INLINE_CODE_RE, ' ')
      .replace(URL_RE, ' ')
      .replace(DISCORD_TOKEN_RE, ' ')
  );
  if (text.includes('@')) {
    for (const name of foldedNames) text = text.split(`@${name}`).join(' ');
    text = text.replace(PING_RE, ' ');
  }
  return text;
}

/**
 * Count the uses of members' names in a batch: for every message with text, every candidate
 * member other than its author (`authorId`; the persona's own lines, `self`, count for every
 * member) whose name occurs in the text (src/memory/mentions.js#occursAsWordStem over folded
 * text, see `countableText`) gets one use of that name, each name once per message, dated the
 * message's `ts`. When several names of one member match and some of them occur as a whole word
 * (src/memory/mentions.js#occursAsWholeWord), only those count: `Niko` written out is not also
 * a use of `Nikos` by its stem.
 * @param {object[]} messages  Slim buffered messages (`authorId`, `self`, `content`, `ts` read).
 * @param {Array<{ userId: string, names: string[] }>} candidates  From `addressCandidates`.
 * @returns {Map<string, Array<{ name: string, at: number }>>}  Member id -> uses, in message order.
 */
export function countAddressUses(messages, candidates) {
  const uses = new Map();
  const members = (Array.isArray(candidates) ? candidates : []).map(({ userId, names }) => ({
    userId,
    names: names.map((name) => {
      const form = foldText(name);
      const firstWord = form.split(/[^\p{L}\p{N}_]+/u).find(Boolean) ?? '';
      return { name, form, probe: firstWord.slice(0, 4) };
    }),
  }));
  const foldedNames = members.flatMap((member) => member.names.map((n) => n.form)).sort((a, b) => b.length - a.length);
  for (const message of Array.isArray(messages) ? messages : []) {
    if (typeof message?.content !== 'string' || !message.content || !Number.isFinite(message.ts)) continue;
    const text = countableText(message.content, foldedNames);
    if (!text) continue;
    const authorId = message.self ? null : String(message.authorId);
    for (const member of members) {
      if (member.userId === authorId) continue;
      // A stem match always starts with the form word's first 4 letters: a cheap pre-check.
      const matched = member.names.filter(
        ({ form, probe }) => (!probe || text.includes(probe)) && occursAsWordStem(text, form)
      );
      if (matched.length === 0) continue;
      // `niko` is a whole word of its own and the stem of `nikos`: the exact name wins.
      const exact = matched.filter(({ form }) => occursAsWholeWord(text, form));
      if (!uses.has(member.userId)) uses.set(member.userId, []);
      for (const { name } of exact.length > 0 ? exact : matched) uses.get(member.userId).push({ name, at: message.ts });
    }
  }
  return uses;
}
