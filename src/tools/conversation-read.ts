// `conversation.read`: the persona's in-turn tool for reading a channel she may read, in order
// (features.coreTools; docs/inner-life.md). Her arguments pick a span of one channel -- the
// newest `last` messages, the ones `around` a message, `before` or `after` a message, or every
// one `since` a moment --, the span is read from the record first (src/memory/record.js, the
// newest revision of each message, a deleted one as a placeholder) and from the interface's
// history when the record lacks it, and comes back as the chat transcript renders it
// (src/format.js#formatTranscript: author, time, text, media, edits, deletions), each line with
// a `#N` handle registered in the turn's handle map (src/behavior/turn.js#searchHandles), so a
// message call, media.look or memory.journal.read resolves it in a later step. Every word the
// persona reads comes from `labels.tools.tools.conversation.*`; nothing here is wording. A
// channel the audience rule or her rights hide is refused `channel-not-visible`.

import { fill, formatTranscript } from '../format.js';
import { parseWhen } from '../intentions/model.ts';
import { DAY_MS } from '../time.js';
import { oneLine } from '../memory/clamp.js';
import { CODE } from './codes.ts';
import { lineOf } from '../behavior/line-of.js';
import { idText, isObj, listOf, objOf } from './types.ts';
import type { Obj } from './types.ts';
import type { Reads } from '../interface/reads.ts';
import type { ConversationRef, HistoryQuery } from '../protocol/adapter.ts';

/** One message of a channel as the transcript renders it: the record's or the interface's line. */
export type ReadMessage = { id: unknown; ts: number; [key: string]: unknown };

/** What her arguments ask of a channel: how the span is picked and its size. */
export type ReadSelection = {
  mode: 'around' | 'before' | 'after' | 'since' | 'last';
  n?: number;
  before?: number;
  after?: number;
  anchor?: string;
  since?: number;
};

/** A span of the channel and whether the lines held cover all of it. */
export type Span = { slice: Array<ReadMessage>; enough: boolean };

/** One rendered line of a transcript (src/format.js#formatTranscript). */
type TranscriptItem = { id: unknown; index: number; ts: number; text: string };

/** The handle registry of the turn: the next number, and where the lines shown are registered. */
export type HandleRefs = { next(): number; take(shown: Array<Obj>): void };
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
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

/** A count argument (one to three digits: never a message id), else null. */
function countOf(value: unknown): number | null {
  const given = text(value);
  return /^\d{1,3}$/.test(given) ? Number(given) : null;
}

const RELATIVE_RE = /^\d{1,4}[mhd]$/i;
const WEEKDAY_CLOCK_RE = /^[a-z]{3}\s+\d{1,2}:\d{2}$/i;

/**
 * A moment in the past, as epoch ms: a delay back from `now` (`30m`, `2h`, `3d`), a wall-clock
 * time `HH:MM` (the latest such time not after `now`, in `timezone`), `<weekday> HH:MM` (the
 * latest such weekday), or an ISO date or date-time. Null for anything else.
 */
export function sinceMoment(value: unknown, now: number, timezone = 'UTC'): number | null {
  const given = text(value);
  if (!given) return null;
  const ahead = parseWhen(given, now, { timezone });
  if (ahead === null || !Number.isFinite(ahead)) return null;
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
 */
export function readSelection(
  args: unknown,
  { now, timezone = 'UTC' }: { now: number; timezone?: string }
): ReadSelection | { error: string } {
  const given = objOf(args);
  const around = text(given.around);
  const since = text(given.since);
  const before = text(given.before);
  const after = text(given.after);
  const lastGiven = given.last === undefined || given.last === null || given.last === '' ? null : Number(given.last);
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
 */
export function pickSpan(all: ReadonlyArray<ReadMessage>, selection: ReadSelection): Span {
  const list = Array.isArray(all) ? all : [];
  const at = (id: unknown): number => list.findIndex((message) => idText(message.id) === idText(id));
  const n = selection.n ?? 0;
  const before = selection.before ?? 0;
  const after = selection.after ?? 0;
  switch (selection.mode) {
    case 'around': {
      const i = at(selection.anchor);
      if (i < 0) return { slice: [], enough: false };
      return {
        slice: list.slice(Math.max(0, i - before), i + after + 1),
        enough: i - before >= 0 && i + after < list.length,
      };
    }
    case 'before': {
      const i = at(selection.anchor);
      if (i < 0) return { slice: [], enough: false };
      return { slice: list.slice(Math.max(0, i - n), i), enough: i - n >= 0 };
    }
    case 'after': {
      const i = at(selection.anchor);
      if (i < 0) return { slice: [], enough: false };
      return { slice: list.slice(i + 1, i + 1 + n), enough: i + n < list.length };
    }
    case 'since': {
      const from = list.findIndex((message) => message.ts >= (selection.since ?? 0));
      if (from < 0) return { slice: [], enough: false };
      return { slice: list.slice(from, from + n), enough: true };
    }
    case 'last':
      return { slice: list.slice(-n), enough: list.length >= n };
  }
}

/** Messages by id, the later list's copy winning, oldest first. */
function mergeById(...lists: Array<ReadonlyArray<ReadMessage> | null>): Array<ReadMessage> {
  const byId = new Map<string, ReadMessage>();
  for (const list of lists)
    for (const message of Array.isArray(list) ? (list as ReadonlyArray<ReadMessage>) : [])
      if (message.id !== undefined && message.id !== null) {
        const key = idText(message.id);
        byId.set(key, { ...byId.get(key), ...message });
      }
  return [...byId.values()].sort((a, b) => a.ts - b.ts || (idText(a.id) < idText(b.id) ? -1 : 1));
}

/** A string, else ''. */
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The messages of one channel the record holds from `from` (epoch ms) on, oldest first: the
 * newest revision of each (`editedAt` set from the second one on), a `deleted` one as a
 * placeholder (`deleted: true`, no text) at the time of the message it replaced. `said` lines are
 * the persona's own. Media rides as kinds only (the record keeps no more): one attachment of that
 * kind per entry. A line `allowLine` refuses is skipped. Never throws: a failed read gives [].
 */
export async function recordMessages(
  record: { iterate?: (guildId: string, query: Obj) => AsyncIterable<unknown> } | null | undefined,
  guildId: string,
  {
    channelId,
    from,
    nameOf = null,
    selfName = '',
    allowLine = null,
  }: {
    channelId: string;
    from: number;
    nameOf?: ((id: string) => string | null) | null;
    selfName?: string;
    allowLine?: ((line: Obj) => boolean) | null;
  }
): Promise<Array<ReadMessage>> {
  if (!record || typeof record.iterate !== 'function') return [];
  const latest = new Map<string, { line: Obj; revision: number }>();
  const gone = new Map<string, Obj>();
  try {
    for await (const entry of record.iterate(guildId, {
      from: new Date(from).toISOString(),
      channelIds: [idText(channelId)],
    })) {
      const line = objOf(entry);
      const id = str(line.messageId);
      if (!id || (typeof allowLine === 'function' && !allowLine(line))) continue;
      if (line.kind === 'deleted') {
        gone.set(id, line);
        continue;
      }
      if ((line.kind !== 'seen' && line.kind !== 'said') || !Number.isFinite(Date.parse(str(line.occurredAt))))
        continue;
      const revision = Number.isInteger(line.revision) && (line.revision as number) > 0 ? (line.revision as number) : 1;
      const known = latest.get(id);
      if (known && known.revision >= revision) continue;
      latest.set(id, { line, revision });
    }
  } catch {
    return [];
  }
  const out: Array<ReadMessage> = [];
  const messageOf = (line: Obj, revision: number): ReadMessage => {
    const self = line.kind === 'said';
    const by = str(line.by) || null;
    const name = self ? oneLine(selfName) : by && typeof nameOf === 'function' ? oneLine(nameOf(by) ?? '') : '';
    const ts = Date.parse(str(line.occurredAt));
    const recordedAt = Date.parse(str(line.recordedAt));
    return {
      id: line.messageId,
      channelId: idText(channelId),
      authorId: by,
      authorName: name || '-',
      self,
      bot: false,
      content: str(line.text),
      ts,
      replyToId: str(line.replyTo) || null,
      mentionedUserIds: listOf(line.mentions),
      mentionedChannelIds: [],
      attachments: listOf(line.media)
        .filter((kind): kind is string => typeof kind === 'string' && kind !== '')
        .map((kind, i) => ({ id: `${idText(line.messageId)}#m${i}`, kind, name: kind })),
      links: listOf(line.links)
        .filter(isObj)
        .filter((link) => str(link.title) || str(link.description))
        .map((link, i) => ({
          id: str(link.id) || `${idText(line.messageId)}#l${i}`,
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
    if (latest.has(id) || !Number.isFinite(Date.parse(str(line.occurredAt)))) continue;
    const by = str(listOf(line.participants)[0]) || null;
    const name = by && typeof nameOf === 'function' ? oneLine(nameOf(by) ?? '') : '';
    out.push({
      id,
      channelId: idText(channelId),
      authorId: by,
      authorName: name || '-',
      self: false,
      bot: false,
      content: '',
      ts: Date.parse(str(line.occurredAt)),
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
 * The text of a read: `labels.tools.tools.conversation.source` (`{channel}`), the lines as the
 * chat transcript renders them (formatTranscript, `render` its options), `.handles` when the
 * lines are numbered, `.cut` (`{dropped}`) when the room (`maxChars`) kept fewer than the span,
 * then `.earlier` / `.later` (`{n}`: the handle of the first / last line shown) as the ways to
 * read on; `.none` when the span is empty. With `refs` (`{ next(), take(shown) }`, the turn's
 * handle registry) each line starts with its `#N` handle numbered on from `refs.next()` and the
 * lines that stayed in the text are registered (`{ n, id, channelId, authorId, self, deleted,
 * message }`); a line cut away never is. Otherwise pure.
 */
export function conversationText(
  slice: ReadonlyArray<ReadMessage>,
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
  }: {
    labels: unknown;
    channelId: string;
    channelName?: string;
    render: Obj | ((slice: ReadonlyArray<ReadMessage>) => Obj);
    maxChars?: number;
    refs?: HandleRefs | null;
    earlier?: boolean;
    later?: boolean;
    keep?: 'newest' | 'oldest';
  }
): string {
  const l = objOf(objOf(objOf(objOf(labels).tools).tools).conversation) as Record<string, string | undefined>;
  const lines: Array<string> = [];
  if (l.source) lines.push(fill(l.source, { channel: channelName }));
  if (!Array.isArray(slice) || slice.length === 0) {
    if (l.none) lines.push(l.none);
    return lines.join('\n');
  }
  const offset = refs ? refs.next() - 1 : 0;
  const items = formatTranscript(
    slice as Array<ReadMessage>,
    {
      ...(typeof render === 'function' ? render(slice) : render),
      indexOffset: offset,
    } as Parameters<typeof formatTranscript>[1]
  );
  const byId = new Map(slice.map((message) => [idText(message.id), message]));
  // The room: whole items, from the far end of the span (the newest are kept for a read of the newest lines).
  const bounded = Number.isFinite(maxChars) && maxChars > 0;
  const used = lines.join('\n').length + 400;
  let kept: Array<TranscriptItem> = items;
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
        const message = byId.get(idText(item.id));
        return {
          n: item.index,
          id: idText(item.id),
          channelId: idText(channelId),
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
 */
export async function fetchSpan(
  reads: Reads,
  ref: ConversationRef | null | undefined,
  { mode, anchor, limit, minTs }: { mode?: string; anchor?: string; limit?: number; minTs?: number }
): Promise<Array<ReadMessage> | null> {
  if (!ref) return null;
  try {
    const size = limit ?? 0;
    const query: HistoryQuery =
      mode === 'around' && anchor !== undefined
        ? { limit: size, around: anchor }
        : mode === 'before' && anchor !== undefined
          ? { limit: size, before: anchor }
          : mode === 'after' && anchor !== undefined
            ? { limit: size, after: anchor }
            : mode === 'since' && minTs !== undefined
              ? { limit: 100, since: minTs }
              : { limit: size };
    const page = await reads.history(ref, query);
    return page === null ? null : page.events.map((event) => lineOf(event) as ReadMessage);
  } catch {
    return null;
  }
}

/** How many lines a selection asks the interface for: both sides of the anchor and the anchor, or the newest `n`. */
function askedLines(selection: ReadSelection): number {
  return selection.mode === 'around' ? (selection.before ?? 0) + (selection.after ?? 0) + 1 : (selection.n ?? 0);
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
}: {
  args: unknown;
  labels: unknown;
  config?: unknown;
  channelId?: unknown;
  channelNameOf?: ((id: string) => string | null | undefined) | null;
  allowed?: ((id: string) => boolean) | null;
  readRecord?: ((request: { channelId: string; from: number }) => Promise<Array<ReadMessage>>) | null;
  fetchLive?:
    | ((request: {
        channelId: string;
        mode: string;
        anchor: string | null;
        limit: number;
        minTs: number;
      }) => Promise<Array<ReadMessage> | null>)
    | null;
  render: Obj | ((slice: ReadonlyArray<ReadMessage>) => Obj);
  refs?: HandleRefs | null;
  now?: number;
  timezone?: string;
  maxChars?: number;
}): Promise<{ status: string; code?: string; reason?: string; data?: { text: string } }> {
  try {
    const target = text(objOf(args).channelId) || idText(channelId);
    if (!target) return { status: 'invalid', code: CODE.INVALID_ARGS, reason: 'args.channel:required' };
    const zone = objOf(objOf(config).bot).timezone;
    const selection = readSelection(args, { now, timezone: typeof zone === 'string' ? zone : timezone });
    if ('error' in selection) return { status: 'invalid', code: CODE.INVALID_ARGS, reason: selection.error };
    if (typeof allowed === 'function' && !allowed(target)) return { status: 'denied', code: CODE.CHANNEL_NOT_VISIBLE };
    let all: Array<ReadMessage> = [];
    let picked: Span = { slice: [], enough: false };
    const rungs =
      selection.mode === 'since' ? [selection.since ?? 0] : READ_LADDER_DAYS.map((days) => now - days * DAY_MS);
    for (const from of rungs) {
      all = typeof readRecord === 'function' ? await readRecord({ channelId: target, from }) : [];
      picked = pickSpan(all, selection);
      if (picked.enough) break;
    }
    let live: Array<ReadMessage> | null = null;
    let asked = false;
    if (!picked.enough && typeof fetchLive === 'function') {
      asked = true;
      const limit = askedLines(selection);
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
    if (selection.anchor && !all.some((message) => idText(message.id) === selection.anchor))
      return { status: 'invalid', code: CODE.UNKNOWN_MESSAGE, reason: `args.${selection.mode}` };
    const reachedStart =
      Array.isArray(live) &&
      live.length < askedLines(selection) &&
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
