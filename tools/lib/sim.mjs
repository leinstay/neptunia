// The pure part of tools/memory-sim.mjs: what moved in a profile over a replayed window
// (mobility), what did not move while its member kept talking (stagnation), the prose signal
// (words per sentence), the manifest read off the journal's memory records, and analyzer
// batches built from chat dump files. No I/O, no clock, no randomness.

/** A field this short on average (words per sentence) is flagged: a signal, not a verdict. */
export const SHORT_SENTENCE_WORDS = 8;

/** Profile fields that are bookkeeping, not memory: never counted as moved or stuck. */
const BOOKKEEPING = new Set(['id', 'firstSeen', 'lastSeen', 'messageCount', 'updatedAt', 'detailsSeq']);

/** Whether a field's value holds anything (not null, '', [] or {}). */
function hasContent(value) {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * Which memory fields of one profile changed between `before` and `after` (compared as JSON)
 * and which did not; bookkeeping fields (ids, seen times, counters) are left out. A profile
 * absent before (`before` null) changed every field `after` gives content. Both lists sorted.
 * @param {object|null} before
 * @param {object|null} after
 * @returns {{ changed: string[], unchanged: string[] }}
 */
export function mobility(before, after) {
  const changed = [];
  const unchanged = [];
  if (!before) {
    for (const key of Object.keys(after ?? {}).sort()) if (!BOOKKEEPING.has(key) && hasContent(after[key])) changed.push(key);
    return { changed, unchanged };
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after ?? {})])].filter((key) => !BOOKKEEPING.has(key)).sort();
  for (const key of keys) {
    if (JSON.stringify(before[key] ?? null) === JSON.stringify(after?.[key] ?? null)) unchanged.push(key);
    else changed.push(key);
  }
  return { changed, unchanged };
}

/**
 * The fields that stood still while the member talked: `N/A` when the manifest holds no record
 * of their lines (`lines` null), none when they wrote fewer than `minMessages` lines, else the
 * unchanged fields of `moved` (from `mobility`).
 * @param {{ unchanged: string[] }} moved
 * @param {number|null|undefined} lines
 * @param {number} minMessages
 * @returns {string[]|'N/A'}
 */
export function stagnation(moved, lines, minMessages) {
  if (lines === null || lines === undefined) return 'N/A';
  if (lines < minMessages) return [];
  return [...moved.unchanged];
}

const SENTENCE_SPLIT = /[.!?…]+|\n+/u;
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

/**
 * The mean number of words per sentence of `text` (sentences end at `.`, `!`, `?`, an ellipsis
 * or a line break; empty ones are skipped); null when there is no word.
 * @param {unknown} text
 * @returns {number|null}
 */
export function wordsPerSentence(text) {
  if (typeof text !== 'string') return null;
  const counts = text
    .split(SENTENCE_SPLIT)
    .map((sentence) => (sentence.match(WORD) ?? []).length)
    .filter((n) => n > 0);
  if (counts.length === 0) return null;
  return counts.reduce((a, b) => a + b, 0) / counts.length;
}

/**
 * The prose a profile holds: every non-empty top-level text field but the bookkeeping ones,
 * sorted by field name.
 * @param {object|null} profile
 * @returns {{ field: string, text: string }[]}
 */
export function proseFields(profile) {
  if (!profile || typeof profile !== 'object') return [];
  return Object.keys(profile)
    .filter((key) => !BOOKKEEPING.has(key) && typeof profile[key] === 'string' && profile[key].trim())
    .sort()
    .map((field) => ({ field, text: profile[field] }));
}

/**
 * The manifest of a replay: the guild's analyzer batches recorded after the snapshot, oldest
 * first. Only `memory` records of the guild scope (a private batch and a voice run are not
 * guild batches) dated after `after` (epoch ms).
 * @param {object[]} records  Journal records (any kind).
 * @param {{ after: number }} options
 * @returns {{ occurredAt: string, batchId: string|null, stage: string|null, appliedRevision: string|null,
 *   promptsHash: string|null, configHash: string|null, messageIds: string[] }[]}
 */
export function manifestFrom(records, { after }) {
  return (Array.isArray(records) ? records : [])
    .filter(
      (r) =>
        r?.kind === 'memory' &&
        r.scope?.private !== true &&
        r.stage !== 'voice' &&
        typeof r.occurredAt === 'string' &&
        Date.parse(r.occurredAt) > after,
    )
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
    .map((r) => ({
      occurredAt: r.occurredAt,
      batchId: r.batchId ?? null,
      stage: r.stage ?? null,
      appliedRevision: r.appliedRevision ?? null,
      promptsHash: r.promptsHash ?? null,
      configHash: r.configHash ?? null,
      messageIds: Array.isArray(r.batch?.messageIds) ? r.batch.messageIds.filter((id) => typeof id === 'string' && id) : [],
    }));
}

/** An epoch-ms time from a dump's `ts` (ms or an ISO string), else null. */
function timeOf(ts) {
  if (Number.isFinite(ts)) return ts;
  const parsed = typeof ts === 'string' ? Date.parse(ts) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Chat dump lines (one JSON object per line: `id`, `ts`, `author`, `name`, `content`, `replyTo`,
 * `mentions`) as the analyzer's slim messages (src/memory/update.js#slimMessage's shape, no
 * media), oldest first, cut into batches of `size`. A line that does not parse or lacks an id,
 * an author or a time is skipped and counted. `channelId` is used when a line names none;
 * `selfId` marks the persona's own lines.
 * @param {(string|object)[]} lines
 * @param {number} size
 * @param {{ channelId?: string|null, channelName?: string|null, selfId?: string|null }} [options]
 * @returns {{ batches: object[][], skipped: number }}
 */
export function batchesFromDump(lines, size, { channelId = null, channelName = null, selfId = null } = {}) {
  if (!Number.isInteger(size) || size < 1) throw new Error('batch size must be a whole number above 0');
  const messages = [];
  let skipped = 0;
  for (const line of Array.isArray(lines) ? lines : []) {
    if (typeof line === 'string' && !line.trim()) continue;
    let entry = line;
    if (typeof line === 'string') {
      try {
        entry = JSON.parse(line);
      } catch {
        skipped += 1;
        continue;
      }
    }
    const ts = timeOf(entry?.ts);
    const id = entry?.id === undefined || entry?.id === null ? '' : String(entry.id);
    const author = entry?.author === undefined || entry?.author === null ? '' : String(entry.author);
    if (!id || !author || ts === null) {
      skipped += 1;
      continue;
    }
    messages.push({
      id,
      channelId: typeof entry.channelId === 'string' && entry.channelId ? entry.channelId : channelId,
      channelName: typeof entry.channelName === 'string' ? entry.channelName : channelName,
      authorId: author,
      authorName: typeof entry.name === 'string' && entry.name ? entry.name : author,
      self: selfId !== null && author === String(selfId),
      bot: false,
      content: typeof entry.content === 'string' ? entry.content : '',
      ts,
      replyToId: entry.replyTo === undefined || entry.replyTo === null ? null : String(entry.replyTo),
      mentionedUserIds: Array.isArray(entry.mentions) ? entry.mentions.map(String) : [],
      attachments: [],
      links: [],
      stickers: [],
      emojis: [],
      direct: false,
    });
  }
  messages.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const batches = [];
  for (let i = 0; i < messages.length; i += size) batches.push(messages.slice(i, i + size));
  return { batches, skipped };
}

/**
 * Lines per member over `batches` (the persona's own left out): the record the stagnation
 * check reads.
 * @param {object[][]} batches
 * @returns {Map<string, number>}
 */
export function authorLines(batches) {
  const counts = new Map();
  for (const batch of Array.isArray(batches) ? batches : []) {
    for (const message of batch ?? []) {
      if (!message || message.self || typeof message.authorId !== 'string') continue;
      counts.set(message.authorId, (counts.get(message.authorId) ?? 0) + 1);
    }
  }
  return counts;
}
