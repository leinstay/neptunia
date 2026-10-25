// Which of the server's custom emoji the members actually use, counted
// deterministically (no LLM) from every analyzer batch and kept in guild.json
// as `emojiUsage: { [id]: { name, count, last } }`. The `<emoji>` block
// (src/behavior/prompt.js) shows the top-ranked ones, so the persona picks up
// the server's habits instead of a random slice of a long emoji list. Rank is
// the shared one of src/memory/ranking.js: `count` is the weight, `last` (the
// ts of the latest use) drives the decay.

import { isPlainObject } from '../config.js';
import { sortByRank } from './ranking.js';

/**
 * The `mergeEmojiUsage` options from `context.customEmoji`, read by the caller at the
 * moment of use: `storeMax` (200) and `halfLifeDays` (30), config.json's values when a key
 * is missing. Shared by the live observer (src/memory/update.js) and the history backfill.
 * @param {object} config  Live config.
 * @returns {{ storeMax: number, halfLifeDays: number }}
 */
export function emojiUsageOpts(config) {
  const emojiCfg = config?.context?.customEmoji ?? {};
  return { storeMax: emojiCfg.storeMax ?? 200, halfLifeDays: emojiCfg.halfLifeDays ?? 30 };
}

/**
 * A stored `emojiUsage` map made safe to read: anything but a plain object
 * becomes `{}`; an entry without a positive count is dropped, a missing name
 * becomes `''`, a missing `last` becomes 0. Never mutates `value`.
 * @param {unknown} value
 * @returns {Record<string, { name: string, count: number, last: number }>}
 */
export function normalizeEmojiUsage(value) {
  if (!isPlainObject(value)) return {};
  const out = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!id || !isPlainObject(entry)) continue;
    const count = Number.isFinite(entry.count) ? Math.floor(entry.count) : 0;
    if (count < 1) continue;
    out[id] = {
      name: typeof entry.name === 'string' ? entry.name : '',
      count,
      last: Number.isFinite(entry.last) ? entry.last : 0,
    };
  }
  return out;
}

/**
 * The custom emoji uses in `messages`: one use per emoji per message (the
 * message's own `emojis`, not its forwarded snapshots -- a forward shares
 * someone else's words). The persona's own messages and other bots' are
 * skipped, like everywhere the analyzer counts members.
 * @param {object[]} messages  Slim buffered messages; `self`/`bot`/`ts`/`emojis` read.
 * @returns {Map<string, { name: string, count: number, last: number }>}
 */
export function countEmojiUses(messages) {
  const uses = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.self || message.bot) continue;
    const ts = Number.isFinite(message.ts) ? message.ts : 0;
    const seen = new Set();
    for (const emoji of Array.isArray(message.emojis) ? message.emojis : []) {
      const id = emoji?.id == null ? '' : String(emoji.id);
      if (!id || typeof emoji.name !== 'string' || !emoji.name || seen.has(id)) continue;
      seen.add(id);
      const use = uses.get(id) ?? { name: emoji.name, count: 0, last: 0 };
      use.count += 1;
      if (ts >= use.last) {
        use.last = ts;
        use.name = emoji.name;
      }
      uses.set(id, use);
    }
  }
  return uses;
}

/**
 * `usage` as `[{ id, name, count, last }]`, best first:
 * `rank = log2(count + 0.5) + last / (halfLifeDays * 86_400_000)` (see
 * src/memory/ranking.js#rank; `halfLifeDays` not a positive number -> count
 * alone). Ties go to the more recent use.
 * @param {unknown} usage  A stored `emojiUsage` map (normalised here).
 * @param {number} [halfLifeDays]
 * @returns {{ id: string, name: string, count: number, last: number }[]}
 */
export function rankEmojiUsage(usage, halfLifeDays) {
  const items = Object.entries(normalizeEmojiUsage(usage)).map(([id, entry]) => ({
    id,
    ...entry,
    weight: entry.count,
    lastSeen: entry.last > 0 ? new Date(entry.last).toISOString() : null,
  }));
  return sortByRank(items, halfLifeDays).map(({ id, name, count, last }) => ({ id, name, count, last }));
}

/**
 * `usage` with the uses of `messages` added (see `countEmojiUses`): counts
 * accumulate, `last` and `name` follow the latest use. Past `storeMax`
 * entries the lowest-ranked are evicted (`storeMax` not a non-negative
 * integer -> no cap). Never mutates `usage`.
 * @param {unknown} usage
 * @param {object[]} messages
 * @param {{ storeMax?: number, halfLifeDays?: number }} [opts]
 * @returns {{ usage: Record<string, { name: string, count: number, last: number }>, counted: number }}
 */
export function mergeEmojiUsage(usage, messages, { storeMax, halfLifeDays } = {}) {
  const next = normalizeEmojiUsage(usage);
  let counted = 0;
  for (const [id, use] of countEmojiUses(messages)) {
    const before = next[id];
    const newer = !before || use.last >= before.last;
    // Re-inserted so a just-used emoji sits last: an exact rank tie keeps it (see sortByRank).
    delete next[id];
    next[id] = {
      name: newer ? use.name : before.name,
      count: (before?.count ?? 0) + use.count,
      last: newer ? use.last : before.last,
    };
    counted += use.count;
  }
  const ids = Object.keys(next);
  if (Number.isInteger(storeMax) && storeMax >= 0 && ids.length > storeMax) {
    const kept = new Set(rankEmojiUsage(next, halfLifeDays).slice(0, storeMax).map((entry) => entry.id));
    for (const id of ids) if (!kept.has(id)) delete next[id];
  }
  return { usage: next, counted };
}
