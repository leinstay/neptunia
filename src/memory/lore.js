// Pure server lorebook logic: which entries the analyzer's batch touches (so
// they can be updated), which entries a live turn's recent chat surfaces (so
// only the relevant few of possibly hundreds are shown). Storage itself
// (data/guilds/<id>/lore.json) lives behind src/memory/store.js, same
// cache/dirty/atomic pattern as everything else; this module never touches
// disk. See docs/prompt-contract.md ("<lore>" and "lore" in "The
// analyzer").

import { createHash } from 'node:crypto';
import { clampText, stripUrls } from './clamp.js';
import { occursAsWholeWord } from './mentions.ts';

const MAX_TITLE = 80;
const DEFAULT_MAX_TEXT = 600; // config.json's lore.textChars, used only when a caller passes none
const MIN_KEY = 2;
const MAX_KEY = 40;
const MAX_KEYS = 8;
const DEFAULT_WEIGHT = 3;

function normalizeTitle(title) {
  return String(title ?? '')
    .trim()
    .toLowerCase();
}

/**
 * The file name (without `.json`) of a lorebook entry's version history
 * (data/guilds/<id>/versions/lore/<key>.json, see src/memory/store.js). Keyed by
 * the entry's identity, the trimmed lowercase title, so a change of letter case
 * keeps one history. Scheme: the ASCII letters and digits of that title as a
 * dash-joined slug (at most 40 characters, for a human browsing the folder),
 * then `-` and the first 12 hex digits of the SHA-1 of the whole identity (what
 * makes it unique; a title with no ASCII letter or digit is the hash alone).
 * Always a safe file name on every platform.
 * @param {unknown} title
 * @returns {string}
 */
export function loreVersionKey(title) {
  const identity = normalizeTitle(title);
  const hash = createHash('sha1').update(identity).digest('hex').slice(0, 12);
  const slug = identity
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug ? `${slug}-${hash}` : hash;
}

/** Lowercase, trim, drop too-short/duplicate keys, clamp an over-long one to
 * MAX_KEY at a word boundary (never dropped for being too long), keep at
 * most MAX_KEYS. */
function normalizeKeys(rawKeys) {
  if (!Array.isArray(rawKeys)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of rawKeys) {
    if (typeof raw !== 'string') continue;
    const key = clampText(stripUrls(raw).trim().toLowerCase(), MAX_KEY, { tolerance: 1 });
    if (key.length < MIN_KEY) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= MAX_KEYS) break;
  }
  return out;
}

/** Whether a stored entry already holds exactly these (normalised, clamped) values. */
function isSameEntry(existing, { title, keys, text, source }) {
  return (
    existing.title === title &&
    existing.text === text &&
    existing.source === source &&
    Array.isArray(existing.keys) &&
    existing.keys.length === keys.length &&
    existing.keys.every((key, index) => key === keys[index])
  );
}

/** A short, stable, deterministic id from the title, creation time and an in-call salt. */
function makeId(title, nowMs, salt) {
  const base = `${title}|${nowMs}|${salt}`;
  let hash = 0;
  for (let i = 0; i < base.length; i += 1) {
    hash = (Math.imul(hash, 31) + base.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/** When an entry was last written: its `updatedAt`, or its `createdAt` when it has none. */
function lastWrittenAt(entry) {
  return String(entry.updatedAt || entry.createdAt || '');
}

/**
 * Evict the stalest `source: 'analyzer'` entries that are not `always`, until
 * `entries` is back at `maxEntries` or no more evictable entries remain
 * (an `owner` entry, or one marked `always`, is never evicted implicitly).
 * Stalest = written longest ago (`lastWrittenAt`), so an entry the analyzer
 * keeps rewriting outlives one nothing has touched since it was created;
 * entries written at the same moment leave in the order they were created,
 * then in stored order.
 */
function evictOverflow(entries, maxEntries) {
  if (!Number.isFinite(maxEntries) || entries.length <= maxEntries) return entries;
  const overflow = entries.length - maxEntries;
  const candidates = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.source === 'analyzer' && !entry.always)
    .sort((a, b) => {
      const byWritten = lastWrittenAt(a.entry).localeCompare(lastWrittenAt(b.entry));
      const byCreated = String(a.entry.createdAt ?? '').localeCompare(String(b.entry.createdAt ?? ''));
      return byWritten || byCreated || a.index - b.index;
    });
  const drop = new Set(candidates.slice(0, overflow).map((c) => c.index));
  return entries.filter((_, index) => !drop.has(index));
}

/**
 * Insert or update lorebook entries from one analyzer batch or an owner
 * command. Pure: `entries` is never mutated. Identity is the case-insensitive,
 * trimmed `title`. An `analyzer` update may only replace the keys/text of an
 * entry whose OWN stored `source` is `'analyzer'`; an existing `owner` entry
 * is left completely untouched by an analyzer update (silently dropped). An
 * `owner` update always wins -- it overwrites any entry under that title
 * (analyzer or owner alike) and the entry becomes/stays an owner entry, the
 * one way a title becomes protected from the analyzer. An analyzer update
 * that would leave an entry exactly as stored (title, keys, text compared
 * after normalising and trimming) is skipped: not stamped, not counted. Past
 * `maxEntries` the stalest analyzer entries leave (see `evictOverflow`): the
 * ones written longest ago, not the ones created first.
 *
 * @param {object[]|undefined} entries  Stored entries.
 * @param {unknown} incoming            Untrusted `{ title, keys, text, always? }[]`.
 * @param {{ source: 'analyzer'|'owner', now?: number, maxEntries?: number, textChars?: number,
 *   clampTolerance?: number }} opts
 *   The title, every key and the text lose their links first (src/memory/clamp.js#stripUrls): an
 *   entry left with no title, no key or no text is skipped like one sent without them.
 *   `title` is a hard identity clamp at MAX_TITLE; `text` is free prose: a first write (a new
 *   entry, or one with no text) is clamped tolerantly (see src/memory/clamp.js) to `textChars`
 *   (config.lore.textChars; DEFAULT_MAX_TEXT when absent); a rewrite is stored as given, never
 *   cut (the caller refuses one over the limit, src/memory/prose.js#acceptProse).
 * @returns {{ entries: object[], upserted: number, changes: { title: string, previousText: string, nextText: string }[] }}
 *   `upserted`: entries inserted or actually changed. `changes`: one pair per existing entry whose
 *   text this call replaced with a different one (the stored text before, the text after), for the
 *   store's version history; an inserted entry or a change of keys alone adds none.
 */
export function upsertLore(
  entries,
  incoming,
  { source, now: nowMs = Date.now(), maxEntries = Infinity, textChars, clampTolerance } = {}
) {
  const stored = Array.isArray(entries) ? [...entries] : [];
  if (!Array.isArray(incoming) || incoming.length === 0) return { entries: stored, upserted: 0, changes: [] };

  const byTitle = new Map(stored.map((entry, index) => [normalizeTitle(entry.title), index]));
  const nowIso = new Date(nowMs).toISOString();
  const effectiveTextChars = Number.isFinite(textChars) && textChars > 0 ? textChars : DEFAULT_MAX_TEXT;
  let upserted = 0;
  let salt = 0;
  const changes = [];

  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const title = typeof raw.title === 'string' ? clampText(stripUrls(raw.title), MAX_TITLE, { tolerance: 1 }) : '';
    const keys = normalizeKeys(raw.keys);
    const rawText = typeof raw.text === 'string' ? stripUrls(raw.text) : '';
    if (!title || keys.length === 0 || !rawText.trim()) continue;

    const normalized = normalizeTitle(title);
    const existingIndex = byTitle.get(normalized);
    // Only a first write is clamped (no entry, or one with no text): a rewrite over the limit is the
    // caller's to refuse (src/memory/prose.js#acceptProse), never cut here.
    const previousText = existingIndex === undefined ? '' : stored[existingIndex].text;
    const firstWrite = typeof previousText !== 'string' || previousText.trim() === '';
    const text = firstWrite ? clampText(rawText, effectiveTextChars, { tolerance: clampTolerance }) : rawText.trim();
    if (!text) continue;

    if (existingIndex === undefined) {
      salt += 1;
      const entry = {
        id: makeId(title, nowMs, salt),
        title,
        keys,
        text,
        always: source === 'owner' && Boolean(raw.always),
        source,
        weight: DEFAULT_WEIGHT,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      stored.push(entry);
      byTitle.set(normalized, stored.length - 1);
      upserted += 1;
      continue;
    }

    const existing = stored[existingIndex];
    if (existing.source === 'owner' && source !== 'owner') continue; // never touched by the analyzer
    // An analyzer re-send that leaves the entry as it is stays unstamped and uncounted, so neither
    // `updatedAt` nor the update log overstates how much the lorebook moves. An owner write is an
    // explicit save and always counts (src/admin.js reads 0 as an invalid entry).
    if (source !== 'owner' && isSameEntry(existing, { title, keys, text, source })) continue;

    const updated = { ...existing, title, keys, text, source, updatedAt: nowIso };
    if (source === 'owner') updated.always = Boolean(raw.always);
    stored[existingIndex] = updated;
    upserted += 1;
    if (existing.text !== text)
      changes.push({ title, previousText: typeof existing.text === 'string' ? existing.text : '', nextText: text });
  }

  return { entries: evictOverflow(stored, maxEntries), upserted, changes };
}

/**
 * Entries (any `always` status) whose keys literally occur, whole word/phrase
 * and case-insensitive, in `recentTexts` -- used for the analyzer's
 * `<existing_lore>` input, which cares about textual mentions, not about
 * `always`. Sorted most-matched first (distinct keys matched, then most
 * recent match position, then weight), for determinism only.
 * @param {object[]} entries
 * @param {string[]} recentTexts
 */
export function keywordMatches(entries, recentTexts) {
  const list = Array.isArray(entries) ? entries : [];
  const texts = (Array.isArray(recentTexts) ? recentTexts : []).map((t) => String(t ?? '').toLowerCase());

  const scored = [];
  for (const entry of list) {
    const keys = Array.isArray(entry.keys) ? entry.keys : [];
    let matchedKeys = 0;
    let lastIndex = -1;
    for (const key of keys) {
      const lowered = String(key).toLowerCase();
      let found = false;
      for (let i = 0; i < texts.length; i += 1) {
        if (occursAsWholeWord(texts[i], lowered)) {
          found = true;
          if (i > lastIndex) lastIndex = i;
        }
      }
      if (found) matchedKeys += 1;
    }
    if (matchedKeys > 0) scored.push({ entry, matchedKeys, lastIndex, weight: entry.weight ?? 0 });
  }

  scored.sort((a, b) => b.matchedKeys - a.matchedKeys || b.lastIndex - a.lastIndex || b.weight - a.weight);
  return scored.map((s) => s.entry);
}

/**
 * Entries to show in one turn's `<lore>` block: every entry marked `always`
 * (first, never counted against `maxMatches`), plus up to `maxMatches` of the
 * remaining entries whose keys occur in `recentTexts`, most relevant first.
 * See docs/prompt-contract.md, "<lore>".
 * @param {object[]} entries
 * @param {string[]} recentTexts  Recent plain message texts, oldest first.
 * @param {{ maxMatches?: number }} [opts]
 */
export function matchLore(entries, recentTexts, { maxMatches = Infinity } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const always = list.filter((entry) => entry.always);
  const rest = list.filter((entry) => !entry.always);
  const matched = keywordMatches(rest, recentTexts).slice(0, maxMatches);
  return [...always, ...matched];
}
