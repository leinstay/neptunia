// Which record lines (src/memory/record.ts) may hold a cached picture, found by the keys of the media cache, and the
// creation time of the snowflake id that dates such a key. scripts/vision-compare.ts finds its pictures again with them.
// Pure.

import { MINUTE_MS } from '../time.ts';
import { isFiniteNumber } from './types.ts';

// A gif embed's per-message item id (`<message>#e<n>`, set by the interface package).
const EMBED_ID_RE = /#e\d+$/;
// An attachment's item id: its snowflake, the platform's own id.
const ATTACHMENT_ID_RE = /^\d+$/;
// The start of the snowflake clock that dates an attachment id of the media cache keys (the keys keep the platform's own ids).
const SNOWFLAKE_EPOCH_MS = 1_420_070_400_000;
// How long before its message an attachment may be uploaded (its snowflake is the upload's).
const UPLOAD_LEAD_MS = 30 * MINUTE_MS;

/** The fields of a record line the finder reads, each checked before it is used. */
type RecordLine = {
  kind?: unknown;
  messageId?: unknown;
  scope?: { channel?: unknown } | null;
  media?: unknown;
  occurredAt?: unknown;
};

/**
 * The creation time (ms) of a snowflake id, or null for anything else. Pure.
 */
export function snowflakeMs(id: unknown): number | null {
  if (typeof id !== 'string' || !/^\d{15,20}$/.test(id)) return null;
  return Number(BigInt(id) >> 22n) + SNOWFLAKE_EPOCH_MS;
}

/**
 * Which record lines may hold the pictures under `keys` (no emoji: those need no message): a `seen` or `said` line
 * with a message, a channel and some media that is the message of a gif embed key, whose time is at most
 * UPLOAD_LEAD_MS after an attachment key's snowflake time (and not over a minute before it), or -- while a key carries
 * no time (a link thumbnail, a sticker) -- that falls at or after `sinceMs`. `fromMs` is the earliest moment worth
 * reading. Pure.
 * @param sinceMs  The search's window start.
 */
export function recordFinder(
  keys: Iterable<string>,
  sinceMs: number
): { fromMs: number; matches: (line: object) => boolean } {
  const messageIds = new Set<string>();
  const uploads: Array<number> = [];
  let untimed = false;
  let fromMs = sinceMs;
  for (const key of keys) {
    if (EMBED_ID_RE.test(key)) {
      const messageId = key.replace(EMBED_ID_RE, '');
      messageIds.add(messageId);
      const at = snowflakeMs(messageId);
      if (at !== null) fromMs = Math.min(fromMs, at - MINUTE_MS);
      else untimed = true;
      continue;
    }
    const at = ATTACHMENT_ID_RE.test(key) ? snowflakeMs(key) : null;
    if (at === null) {
      untimed = true;
      continue;
    }
    uploads.push(at);
    fromMs = Math.min(fromMs, at - MINUTE_MS);
  }
  const matches = (given: object): boolean => {
    // A record line is a plain object, and every field read below is checked first.
    const line = given as RecordLine;
    if (line.kind !== 'seen' && line.kind !== 'said') return false;
    const { messageId } = line;
    if (typeof messageId !== 'string' || !messageId || typeof line.scope?.channel !== 'string') return false;
    if (!Array.isArray(line.media) || line.media.length === 0) return false;
    if (messageIds.has(messageId)) return true;
    const occurredMs = typeof line.occurredAt === 'string' ? Date.parse(line.occurredAt) : Number.NaN;
    if (
      isFiniteNumber(occurredMs) &&
      uploads.some((upload) => upload <= occurredMs + MINUTE_MS && upload >= occurredMs - UPLOAD_LEAD_MS)
    )
      return true;
    return untimed && isFiniteNumber(occurredMs) && occurredMs >= sinceMs;
  };
  return { fromMs, matches };
}
