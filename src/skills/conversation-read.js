// `conversation.read`: the persona's in-turn tool for reading a channel she may read, in order
// (features.coreTools; docs/inner-life.md). Her arguments pick a span of one channel -- the
// newest `last` messages, the ones `around` a message, `before` or `after` a message, or every
// one `since` a moment --, the span is read from the record first (src/memory/record.js, the
// newest revision of each message, a deleted one as a placeholder) and from the interface's
// history when the record lacks it, and comes back as the chat transcript renders it
// (src/format.js#formatTranscript: author, time, text, media, edits, deletions), each line with
// a `#N` handle registered in the turn's handle map (src/behavior/turn.js#searchHandles), so a
// message call, media.look or memory.journal.read resolves it in a later step. Every word the
// persona reads comes from `labels.skills.tools.conversation.*`; nothing here is wording. A
// channel the audience rule or her rights hide is refused `channel-not-visible`.

import { fill, formatTranscript } from '../format.js';
import { parseWhen } from '../intentions/model.js';
import { DAY_MS } from '../time.js';
import { oneLine } from '../memory/clamp.js';
import { CODE } from './codes.js';
import { lineOf } from '../behavior/line-of.js';

/** The newest messages a read without `last` returns, and the most one read may return. */
export const READ_LAST_DEFAULT = 20;
export const READ_LAST_MAX = 60;
/** The lines before and after the anchor of an `around` read when not given, and the most of each. */
export const READ_AROUND_DEFAULT = 10;
export const READ_AROUND_MAX = 30;
/** How many days back the record is read, rung by rung, before the interface's history is asked. */
export const READ_LADDER_DAYS = Object.freeze([2, 14, 90]);
/** The characters a read may use when the config gives none (recall.quoteMaxChars' default). */
const MAX_CHARS_FALLBACK = 9000;

/** A string argument trimmed, '' when absent. */
function text(value) {
  return typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value).trim();
}

/** A count argument (one to three digits: never a message id), else null. */
function countOf(value) {
  const given = text(value);
  return /^\d{1,3}$/.test(given) ? Number(given) : null;
}

const RELATIVE_RE = /^\d{1,4}[mhd]$/i;
const WEEKDAY_CLOCK_RE = /^[a-z]{3}\s+\d{1,2}:\d{2}$/i;

/**
 * A moment in the past, as epoch ms: a delay back from `now` (`30m`, `2h`, `3d`), a wall-clock
 * time `HH:MM` (the latest such time not after `now`, in `timezone`), `<weekday> HH:MM` (the
 * latest such weekday), or an ISO date or date-time. Null for anything else.
 * @param {unknown} value
 * @param {number} now
 * @param {string} [timezone]
 * @returns {number|null}
 */
export function sinceMoment(value, now, timezone = 'UTC') {
  const given = text(value);
  if (!given) return null;
  const ahead = parseWhen(given, now, { timezone });
  if (!Number.isFinite(ahead)) return null;
  if (RELATIVE_RE.test(given)) return now - (ahead - now);
  if (/^\d{1,2}:\d{2}$/.test(given)) return ahead - DAY_MS;
  if (WEEKDAY_CLOCK_RE.test(given)) return ahead - 7 * DAY_MS;
  return ahead;
}

/**
 * What her arguments ask: `{ mode, ... }` or `{ error }` (`reason` for the refusal's detail).
 * `around` (a message id) with `before`/`after` counts; `before` or `after` as a message id with
 * `last` lines; `since` with `last` lines from that moment on; else the newest `last` lines.
 * Only one of around / since / a message-valued before or after may be given. A count that is
 * not a number, or a `before`/`after` count without `around`, is refused.
 * @param {{ around?: unknown, before?: unknown, after?: unknown, since?: unknown, last?: unknown }} args
 * @param {{ now: number, timezone?: string }} context
 * @returns {{ mode: string, n?: number, before?: number, after?: number, anchor?: string, since?: number } | { error: string }}
 */
export function readSelection(args, { now, timezone = 'UTC' }) {
  const around = text(args?.around);
  const since = text(args?.since);
  const before = text(args?.before);
  const after = text(args?.after);
  const lastGiven = args?.last === undefined || args?.last === null || args?.last === '' ? null : Number(args.last);
  if (lastGiven !== null && !(Number.isInteger(lastGiven) && lastGiven >= 1)) return { error: 'args.last:range' };
  const last = Math.min(READ_LAST_MAX, lastGiven ?? READ_LAST_DEFAULT);
  const beforeCount = countOf(before);
  const afterCount = countOf(after);
  // Anything that is not a count is a message (resolveCall turned a `#N` or a link into its id).
  const beforeId = before && beforeCount === null ? before : null;
  const afterId = after && afterCount === null ? after : null;
  const modes = [around, since, beforeId, afterId].filter(Boolean).length;
  if (modes > 1) return { error: 'args:exclusive' };
  if (around) {
    if (beforeId || afterId) return { error: 'args:exclusive' };
    const b = Math.min(READ_AROUND_MAX, beforeCount ?? READ_AROUND_DEFAULT);
    const a = Math.min(READ_AROUND_MAX, afterCount ?? READ_AROUND_DEFAULT);
    return { mode: 'around', anchor: around, before: b, after: a };
  }
  if ((beforeCount !== null || afterCount !== null) && !beforeId && !afterId) return { error: 'args.around:required' };
  if (since) {
    const at = sinceMoment(since, now, timezone);
    if (at === null) return { error: 'args.since:value' };
    return { mode: 'since', since: at, n: last };
  }
  if (beforeId) return { mode: 'before', anchor: beforeId, n: last };
  if (afterId) return { mode: 'after', anchor: afterId, n: last };
  return { mode: 'last', n: last };
}

/**
 * The part of `all` (messages of one channel, oldest first) a selection asks, and whether `all`
 * holds all of it: `{ slice, enough }`. `enough` is false when the anchor is missing, or when
 * the lines asked on a side of it (or the newest `n`) are not all there -- the caller then
 * reads further back, or asks the interface. `since` is enough when it holds any line from that
 * moment on. Pure.
 * @param {object[]} all
 * @param {ReturnType<typeof readSelection>} selection
 * @returns {{ slice: object[], enough: boolean }}
 */
export function pickSpan(all, selection) {
  const list = Array.isArray(all) ? all : [];
  const at = (id) => list.findIndex((message) => String(message.id) === String(id));
  switch (selection.mode) {
    case 'around': {
      const i = at(selection.anchor);
      if (i < 0) return { slice: [], enough: false };
      return {
        slice: list.slice(Math.max(0, i - selection.before), i + selection.after + 1),
        enough: i - selection.before >= 0 && i + selection.after < list.length,
      };
    }
    case 'before': {
      const i = at(selection.anchor);
      if (i < 0) return { slice: [], enough: false };
      return { slice: list.slice(Math.max(0, i - selection.n), i), enough: i - selection.n >= 0 };
    }
    case 'after': {
      const i = at(selection.anchor);
      if (i < 0) return { slice: [], enough: false };
      return { slice: list.slice(i + 1, i + 1 + selection.n), enough: i + selection.n < list.length };
    }
    case 'since': {
      const from = list.findIndex((message) => message.ts >= selection.since);
      if (from < 0) return { slice: [], enough: false };
      return { slice: list.slice(from, from + selection.n), enough: true };
    }
    default:
      return { slice: list.slice(-selection.n), enough: list.length >= selection.n };
  }
}

/** Messages by id, the later list's copy winning, oldest first. */
function mergeById(...lists) {
  const byId = new Map();
  for (const list of lists)
    for (const message of Array.isArray(list) ? list : [])
      if (message?.id !== undefined && message?.id !== null)
        byId.set(String(message.id), { ...(byId.get(String(message.id)) ?? {}), ...message });
  return [...byId.values()].sort((a, b) => a.ts - b.ts || (String(a.id) < String(b.id) ? -1 : 1));
}

/** A string, else ''. */
const str = (value) => (typeof value === 'string' ? value : '');

/**
 * The messages of one channel the record holds from `from` (epoch ms) on, oldest first: the
 * newest revision of each (`editedAt` set from the second one on), a `deleted` one as a
 * placeholder (`deleted: true`, no text) at the time of the message it replaced. `said` lines are
 * the persona's own. Media rides as kinds only (the record keeps no more): one attachment of that
 * kind per entry. A line `allowLine` refuses is skipped. Never throws: a failed read gives [].
 * @param {{ iterate: Function }} record
 * @param {string} guildId
 * @param {{ channelId: string, from: number, nameOf?: ((id: string) => string|null)|null, selfName?: string, allowLine?: ((line: object) => boolean)|null }} options
 * @returns {Promise<object[]>}
 */
export async function recordMessages(
  record,
  guildId,
  { channelId, from, nameOf = null, selfName = '', allowLine = null }
) {
  if (!record || typeof record.iterate !== 'function') return [];
  const latest = new Map();
  const gone = new Map();
  try {
    for await (const line of record.iterate(guildId, {
      from: new Date(from).toISOString(),
      channelIds: [String(channelId)],
    })) {
      const id = str(line?.messageId);
      if (!id || (typeof allowLine === 'function' && !allowLine(line))) continue;
      if (line.kind === 'deleted') {
        gone.set(id, line);
        continue;
      }
      if ((line.kind !== 'seen' && line.kind !== 'said') || !Number.isFinite(Date.parse(line.occurredAt))) continue;
      const revision = Number.isInteger(line.revision) && line.revision > 0 ? line.revision : 1;
      const known = latest.get(id);
      if (known && known.revision >= revision) continue;
      latest.set(id, { line, revision, first: known?.first ?? line });
    }
  } catch {
    return [];
  }
  const out = [];
  const messageOf = (line, revision) => {
    const self = line.kind === 'said';
    const by = str(line.by) || null;
    const name = self ? oneLine(selfName) : by && typeof nameOf === 'function' ? oneLine(nameOf(by) ?? '') : '';
    const ts = Date.parse(line.occurredAt);
    const recordedAt = Date.parse(line.recordedAt);
    return {
      id: line.messageId,
      channelId: String(channelId),
      authorId: by,
      authorName: name || '-',
      self,
      bot: false,
      content: str(line.text),
      ts,
      replyToId: str(line.replyTo) || null,
      mentionedUserIds: Array.isArray(line.mentions) ? line.mentions : [],
      mentionedChannelIds: [],
      attachments: (Array.isArray(line.media) ? line.media : [])
        .filter((kind) => typeof kind === 'string' && kind)
        .map((kind, i) => ({ id: `${line.messageId}#m${i}`, kind, name: kind })),
      links: (Array.isArray(line.links) ? line.links : [])
        .filter((link) => link && typeof link === 'object' && (str(link.title) || str(link.description)))
        .map((link, i) => ({
          id: str(link.id) || `${line.messageId}#l${i}`,
          kind: 'link',
          site: str(link.site),
          title: str(link.title),
          text: str(link.description),
          url: str(link.url) || null,
          thumbnailUrl: null,
        })),
      stickers: [],
      emojis: [],
      forwarded: [],
      reactions: [],
      editedAt: revision > 1 ? (Number.isFinite(recordedAt) ? recordedAt : ts) : null,
    };
  };
  for (const [id, { line, revision }] of latest) {
    const message = messageOf(line, revision);
    if (gone.has(id))
      out.push({ ...message, content: '', attachments: [], links: [], replyToId: null, editedAt: null, deleted: true });
    else out.push(message);
  }
  // A deletion whose message the span does not hold: a placeholder from the deletion's own line.
  for (const [id, line] of gone) {
    if (latest.has(id) || !Number.isFinite(Date.parse(line.occurredAt))) continue;
    const by = str(line.participants?.[0]) || null;
    const name = by && typeof nameOf === 'function' ? oneLine(nameOf(by) ?? '') : '';
    out.push({
      id,
      channelId: String(channelId),
      authorId: by,
      authorName: name || '-',
      self: false,
      bot: false,
      content: '',
      ts: Date.parse(line.occurredAt),
      deleted: true,
      mentionedUserIds: [],
      mentionedChannelIds: [],
      replyToId: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    });
  }
  return mergeById(out);
}

/**
 * The text of a read: `labels.skills.tools.conversation.source` (`{channel}`), the lines as the
 * chat transcript renders them (formatTranscript, `render` its options), `.handles` when the
 * lines are numbered, `.cut` (`{dropped}`) when the room (`maxChars`) kept fewer than the span,
 * then `.earlier` / `.later` (`{n}`: the handle of the first / last line shown) as the ways to
 * read on; `.none` when the span is empty. With `refs` (`{ next(), take(shown) }`, the turn's
 * handle registry) each line starts with its `#N` handle numbered on from `refs.next()` and the
 * lines that stayed in the text are registered (`{ n, id, channelId, authorId, self, deleted,
 * message }`); a line cut away never is. Otherwise pure.
 * @param {object[]} slice
 * @param {{ labels: object, channelId: string, channelName?: string, render: object|((slice: object[]) => object), maxChars?: number,
 *   refs?: { next(): number, take(shown: object[]): void }|null, earlier?: boolean, later?: boolean, keep?: 'newest'|'oldest' }} options
 * @returns {string}
 */
export function conversationText(
  slice,
  {
    labels,
    channelId,
    channelName = '',
    render,
    maxChars = MAX_CHARS_FALLBACK,
    refs = null,
    earlier = true,
    later = false,
    keep = 'oldest',
  }
) {
  const l =
    labels?.skills?.tools?.conversation && typeof labels.skills.tools.conversation === 'object'
      ? labels.skills.tools.conversation
      : {};
  const lines = [];
  if (l.source) lines.push(fill(l.source, { channel: channelName }));
  if (!Array.isArray(slice) || slice.length === 0) {
    if (l.none) lines.push(l.none);
    return lines.join('\n');
  }
  const offset = refs ? refs.next() - 1 : 0;
  const items = formatTranscript(slice, {
    ...(typeof render === 'function' ? render(slice) : render),
    indexOffset: offset,
  });
  const byId = new Map(slice.map((message) => [String(message.id), message]));
  // The room: whole items, from the far end of the span (the newest are kept for a read of the newest lines).
  const bounded = Number.isFinite(maxChars) && maxChars > 0;
  const used = lines.join('\n').length + 400;
  let kept = items;
  if (bounded) {
    kept = [];
    let size = used;
    for (const item of keep === 'newest' ? [...items].reverse() : items) {
      const add = item.text.length + 1;
      if (kept.length > 0 && size + add > maxChars) break;
      kept.push(item);
      size += add;
    }
    if (keep === 'newest') kept.reverse();
  }
  const dropped = items.length - kept.length;
  if (refs && l.handles) lines.push(l.handles);
  lines.push(...kept.map((item) => item.text));
  if (dropped > 0 && l.cut) lines.push(fill(l.cut, { dropped: String(dropped) }));
  const first = kept[0]?.index;
  const lastIndex = kept.at(-1)?.index;
  // The ways to read on use the handles only when the lines carry them.
  if (refs) {
    if ((earlier || (dropped > 0 && keep === 'newest')) && l.earlier) lines.push(fill(l.earlier, { n: String(first) }));
    if ((later || (dropped > 0 && keep === 'oldest')) && l.later) lines.push(fill(l.later, { n: String(lastIndex) }));
    refs.take(
      kept.map((item) => {
        const message = byId.get(String(item.id));
        return {
          n: item.index,
          id: String(item.id),
          channelId: String(channelId),
          authorId: message?.authorId ?? null,
          self: message?.self === true,
          ...(message?.deleted === true ? { deleted: true } : {}),
          message,
        };
      })
    );
  }
  return lines.join('\n');
}

/**
 * The interface's history for one selection (`reads`: the core's reads of the interface, src/interface/reads.ts;
 * `ref`: the conversation's reference): the newest `limit` lines, the ones around / before / after `anchor`, or the
 * lines since `minTs`, as lines, oldest first; null when `ref` is missing or the read failed. Never throws.
 * @param {import('../interface/reads.ts').Reads} reads
 * @param {import('../protocol/adapter.ts').ConversationRef|null|undefined} ref
 * @param {{ mode?: string, anchor?: string, limit?: number, minTs?: number }} request
 */
export async function fetchSpan(reads, ref, { mode, anchor, limit, minTs }) {
  if (!ref) return null;
  try {
    const query =
      mode === 'around'
        ? { limit, around: anchor }
        : mode === 'before'
          ? { limit, before: anchor }
          : mode === 'after'
            ? { limit, after: anchor }
            : mode === 'since'
              ? { limit: 100, since: minTs }
              : { limit };
    const page = await reads.history(ref, query);
    return page === null ? null : page.events.map((event) => lineOf(event));
  } catch {
    return null;
  }
}

/**
 * One conversation.read. `args`: `channelId` (default the caller's `channelId`), `around`, `before`,
 * `after` (message ids or counts), `since`, `last`. The caller supplies what only it knows:
 * `allowed(id)` (the audience rule and her rights: false hides the channel), `readRecord({ channelId,
 * from })` (recordMessages over the turn's record), `fetchLive({ channelId, mode, anchor, limit,
 * minTs })` (the interface's history: `around`, `before`, `after`, `since` or the newest, normalized,
 * oldest first; null when it failed) `channelNameOf(id)` (the channel's name for the source line) and `render` (formatTranscript's options, or a function of the span giving them). The record is read
 * first, back through READ_LADDER_DAYS (a `since` from that moment); when it does not hold the span
 * the interface's lines join it. `invalid` (`invalid-args`) for arguments that do not fit;
 * `invalid` (`unknown-message`) when the anchor is not in the channel; `denied`
 * (`channel-not-visible`) for a hidden channel; `failed` when nothing could be read at all;
 * else `ok` with conversationText. Never throws.
 * @returns {Promise<{ status: string, code?: string, reason?: string, data?: { text: string } }>}
 */
export async function runConversationRead({
  args,
  labels,
  config,
  channelId,
  channelNameOf = null,
  allowed,
  readRecord,
  fetchLive,
  render,
  refs = null,
  now = Date.now(),
  timezone = 'UTC',
  maxChars = MAX_CHARS_FALLBACK,
}) {
  try {
    const target = text(args?.channelId) || String(channelId ?? '');
    if (!target) return { status: 'invalid', code: CODE.INVALID_ARGS, reason: 'args.channel:required' };
    const selection = readSelection(args, { now, timezone: config?.bot?.timezone ?? timezone });
    if (selection.error) return { status: 'invalid', code: CODE.INVALID_ARGS, reason: selection.error };
    if (typeof allowed === 'function' && !allowed(target)) return { status: 'denied', code: CODE.CHANNEL_NOT_VISIBLE };
    let all = [];
    let picked = { slice: [], enough: false };
    const rungs = selection.mode === 'since' ? [selection.since] : READ_LADDER_DAYS.map((days) => now - days * DAY_MS);
    for (const from of rungs) {
      all = typeof readRecord === 'function' ? await readRecord({ channelId: target, from }) : [];
      picked = pickSpan(all, selection);
      if (picked.enough) break;
    }
    let live = null;
    let asked = false;
    if (!picked.enough && typeof fetchLive === 'function') {
      asked = true;
      const limit = selection.mode === 'around' ? selection.before + selection.after + 1 : selection.n;
      live = await fetchLive({
        channelId: target,
        mode: selection.mode,
        anchor: selection.anchor ?? null,
        limit,
        minTs: selection.since ?? 0,
      });
      if (Array.isArray(live)) {
        all = mergeById(all, live);
        picked = pickSpan(all, selection);
      }
    }
    if (picked.slice.length === 0 && asked && live === null) return { status: 'failed', code: CODE.ERROR };
    if (selection.anchor && !all.some((message) => String(message.id) === String(selection.anchor)))
      return { status: 'invalid', code: CODE.UNKNOWN_MESSAGE, reason: `args.${selection.mode}` };
    const reachedStart =
      Array.isArray(live) &&
      live.length < (selection.mode === 'around' ? selection.before + selection.after + 1 : selection.n) &&
      (selection.mode === 'last' || selection.mode === 'before');
    const truncated = picked.slice.length >= (selection.n ?? 0);
    const earlier = !reachedStart;
    const later =
      selection.mode === 'around' ||
      selection.mode === 'before' ||
      ((selection.mode === 'since' || selection.mode === 'after') && truncated);
    const textOut = conversationText(picked.slice, {
      labels,
      channelId: target,
      channelName: typeof channelNameOf === 'function' ? (channelNameOf(target) ?? '') : '',
      render,
      maxChars,
      refs,
      earlier,
      later,
      keep: selection.mode === 'last' || selection.mode === 'before' ? 'newest' : 'oldest',
    });
    return { status: 'ok', data: { text: textOut } };
  } catch {
    return { status: 'failed', code: CODE.ERROR };
  }
}
