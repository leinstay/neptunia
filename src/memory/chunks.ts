// What one vector of the meaning index holds (src/memory/vectors.ts): the text sent to the
// embedding model and the row's provenance. A record message is embedded with the lines before it
// in the same channel and the same layer (the guild record, or one member's private record), so a
// short answer carries what it answers; an archive item (an episode, a lesson, an evicted item) is
// embedded alone. Pure: names are resolved by the caller's `nameOf`, nothing is read or written.
//
// A chunk line is `author: text`, the text on one line with every `<@id>` token resolved to the
// member's name, cut to `CHUNK_LINE_CHARS`, then the title and description of each link preview
// the line carries (its `links`, src/memory/record.ts#recordLinks), cut to the same length, so a
// link post is found by what it shows; the persona's own lines carry `selfName`. Row meta:
// `{ kind, id, revision, occurredAt, channelId, by, participants, sourceIds }`, where
// `participants` is the union over every line of the chunk and `sourceIds` the message ids of
// those lines, so a forget reaches a row through any line it holds.

import { archiveText } from './archive.ts';
import { clampChars, oneLine } from './clamp.ts';
import { fromTokens } from './mentions.ts';
import { isoOf } from './record.ts';
import { isFiniteNumber, isIntegerNumber } from './types.ts';
import type { StoredRecord, Untyped } from './types.ts';
import type { RecordLine } from './record.ts';

/** Resolves a member id to the display name, or null when unknown. */
type NameOf = (id: string) => string | null;

/** The preceding lines of the same channel a record chunk carries. */
export const CHUNK_CONTEXT_LINES = 2;
/** The longest text of one chunk line, in characters. */
export const CHUNK_LINE_CHARS = 300;

/** The archive text fields that lead an item's chunk, first present wins. */
const ARCHIVE_MAIN_FIELDS = ['what', 'text', 'topic', 'name', 'gist', 'reason'];

/** Distinct non-empty strings of `values` (arrays or single values), in order. */
function idList(...values: Array<unknown>): Array<string> {
  const out: Array<string> = [];
  for (const value of values) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string' && item && !out.includes(item)) out.push(item);
    }
  }
  return out;
}

const revisionOf = (line: Pick<RecordLine, 'revision'> | null | undefined): number =>
  isIntegerNumber(line?.revision) && line.revision > 0 ? line.revision : 1;

/** Compare two message ids: a shorter snowflake is older, then by characters. */
function compareIds(a: string | undefined, b: string | undefined): number {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Order of two record lines in a channel: time, then message id.
 */
export function compareLines(
  a: Pick<RecordLine, 'occurredAt' | 'messageId'>,
  b: Pick<RecordLine, 'occurredAt' | 'messageId'>
): number {
  const x = Date.parse(a?.occurredAt);
  const y = Date.parse(b?.occurredAt);
  const dx = isFiniteNumber(x) ? x : 0;
  const dy = isFiniteNumber(y) ? y : 0;
  return dx !== dy ? dx - dy : compareIds(a?.messageId, b?.messageId);
}

/**
 * Whether a record line can be embedded or serve as context: a `seen` or `said` line with a
 * message id and some text.
 */
export function embeddableLine(line: RecordLine | null | undefined): boolean {
  return (
    (line?.kind === 'seen' || line?.kind === 'said') &&
    typeof line.messageId === 'string' &&
    line.messageId !== '' &&
    typeof line.text === 'string' &&
    line.text.trim() !== ''
  );
}

/**
 * The key of a channel's lines in one layer: the guild record (`privateUserId` null or empty) or
 * a member's private record, then the channel.
 */
export function layerChannelKey(privateUserId: string | null, channelId: string | null): string {
  return `${typeof privateUserId === 'string' ? privateUserId : ''}|${channelId ?? ''}`;
}

/** The channel of a record line, or null. */
const channelOf = (line: Pick<RecordLine, 'scope'>) =>
  typeof line?.scope?.channel === 'string' && line.scope.channel ? line.scope.channel : null;

/** The layer of a record line: its private member, or '' for the guild. */
const layerOf = (line: Pick<RecordLine, 'scope'>) =>
  line?.scope?.private === true && typeof line.scope.user === 'string' ? line.scope.user : '';

/**
 * The embeddable lines of `lines`, one per message: its newest revision, in channel order.
 */
export function newestRevisions(lines: Iterable<RecordLine>): Array<RecordLine> {
  const newest = new Map<string, RecordLine>();
  for (const line of lines ?? []) {
    if (!embeddableLine(line)) continue;
    const key = `${layerOf(line)}|${line.messageId}`;
    const held = newest.get(key);
    if (!held || revisionOf(line) > revisionOf(held)) newest.set(key, line);
  }
  return [...newest.values()].sort(compareLines);
}

/**
 * The up to `count` lines of `channelLines` (one channel, one layer, any order) that come right
 * before `line`, oldest first; the line's own message is never among them.
 */
export function contextFor(
  line: RecordLine,
  channelLines: Array<RecordLine>,
  count: number = CHUNK_CONTEXT_LINES
): Array<RecordLine> {
  const before = (Array.isArray(channelLines) ? channelLines : [])
    .filter((other) => embeddableLine(other) && other.messageId !== line?.messageId && compareLines(other, line) < 0)
    .sort(compareLines);
  return count > 0 ? before.slice(-count) : [];
}

/** One chunk line: `author: text`, then the line's link titles and descriptions. */
function chunkLine(
  line: RecordLine,
  { nameOf, selfName, lineChars }: { nameOf: NameOf | null; selfName: string; lineChars: number }
) {
  const resolve = (id: string) => (typeof nameOf === 'function' ? nameOf(id) : null);
  const by = typeof line.by === 'string' && line.by ? line.by : null;
  const author = line.kind === 'said' ? selfName : (by && oneLine(resolve(by))) || by || '';
  const text = clampChars(oneLine(fromTokens(line.text ?? '', resolve, 'chat')), lineChars);
  const links = (Array.isArray(line.links) ? line.links : [])
    .flatMap((link: Untyped) => [link?.title, link?.description])
    .filter((part: Untyped) => typeof part === 'string' && part);
  const shown = links.length > 0 ? clampChars(oneLine(links.join(' ')), lineChars) : '';
  return shown ? `${oneLine(author)}: ${text} ${shown}` : `${oneLine(author)}: ${text}`;
}

/**
 * The chunk of record `line` with `context` (its preceding lines, oldest first).
 */
export function recordChunk(
  record: object,
  context: Array<object> = [],
  {
    nameOf = null,
    selfName = '',
    lineChars = CHUNK_LINE_CHARS,
  }: { nameOf?: NameOf | null; selfName?: string; lineChars?: number } = {}
): { text: string; meta: object } {
  // A record chunk is made of record lines: the callers hold them as plain objects.
  const line = record as RecordLine;
  const lines = [...(Array.isArray(context) ? (context as Array<RecordLine>) : []), line];
  return {
    text: lines.map((item) => chunkLine(item, { nameOf, selfName, lineChars })).join('\n'),
    meta: {
      kind: 'record',
      id: line.messageId,
      revision: revisionOf(line),
      occurredAt: isoOf(line.occurredAt),
      channelId: channelOf(line),
      by: typeof line.by === 'string' && line.by ? line.by : null,
      // The line's own members first, then its context's.
      participants: idList(...[line, ...lines.slice(0, -1)].map((item) => idList(item.participants, item.by))),
      sourceIds: idList(lines.map((item) => item.messageId)),
    },
  };
}

/**
 * The chunks of every message of `lines` (record lines of any channels and layers; each message
 * by its newest revision), or of those whose `messageId:revision` is in `targets`, each with its
 * preceding lines of the same channel and layer.
 */
export function recordChunks(
  lines: Iterable<RecordLine>,
  {
    targets = null,
    contextLines = CHUNK_CONTEXT_LINES,
    ...options
  }: {
    nameOf?: Untyped;
    selfName?: string;
    lineChars?: number;
    contextLines?: number;
    targets?: Set<string> | null;
  } = {}
): Array<{ text: string; meta: object }> {
  const channels = new Map<string, Array<RecordLine>>();
  for (const line of newestRevisions(lines)) {
    const key = layerChannelKey(layerOf(line), channelOf(line));
    const list = channels.get(key) ?? [];
    channels.set(key, list);
    list.push(line);
  }
  const out: Array<{ text: string; meta: Record<string, Untyped> }> = [];
  for (const channelLines of channels.values()) {
    channelLines.forEach((line, i) => {
      if (targets && !targets.has(`${line.messageId}:${revisionOf(line)}`)) return;
      out.push(
        recordChunk(line, contextLines > 0 ? channelLines.slice(Math.max(0, i - contextLines), i) : [], options)
      );
    });
  }
  return out.sort((a, b) =>
    compareLines(
      { occurredAt: a.meta.occurredAt, messageId: a.meta.id },
      { occurredAt: b.meta.occurredAt, messageId: b.meta.id }
    )
  );
}

/** The text fields of an archive entry, as archive.ts keeps them for its kind. */
function entryFields(entry: Untyped): StoredRecord {
  return archiveText(entry?.itemKind, entry?.text && typeof entry.text === 'object' ? entry.text : {});
}

/**
 * Whether an archive entry gets a vector: not a `restored` lifecycle line, with an item id and
 * some text.
 */
export function isEmbeddableArchive(entry: Untyped): boolean {
  if (!entry || typeof entry !== 'object' || entry.event === 'restored') return false;
  if (typeof entry.itemId !== 'string' || !entry.itemId) return false;
  const fields = entryFields(entry);
  return [...ARCHIVE_MAIN_FIELDS, 'note', 'quote'].some(
    (field) => typeof fields[field] === 'string' && fields[field].trim() !== ''
  );
}

/**
 * The chunk of an archive entry: its leading text field (`what`, else `text`, ...), its note, and
 * its quote in quotation marks, on one line with `<@id>` tokens resolved.
 */
export function archiveChunk(
  entry: StoredRecord,
  { nameOf = null }: { nameOf?: NameOf | null } = {}
): { text: string; meta: object } {
  const fields = entryFields(entry);
  const resolve = (id: string) => (typeof nameOf === 'function' ? nameOf(id) : null);
  const clean = (value: Untyped) => (typeof value === 'string' ? oneLine(fromTokens(value, resolve, 'chat')) : '');
  const main = ARCHIVE_MAIN_FIELDS.map((field) => clean(fields[field])).find(Boolean) ?? '';
  const quote = clean(fields.quote);
  const text = [main, clean(fields.note), quote ? `"${quote}"` : ''].filter(Boolean).join(' ');
  return {
    text,
    meta: {
      kind: 'archive',
      id: entry.itemId,
      revision: typeof entry.revisionId === 'string' ? entry.revisionId : null,
      occurredAt: isoOf(entry.observedAt?.date) ?? isoOf(entry.recordedAt),
      channelId: null,
      by: null,
      participants: idList(entry.participants, entry.scope?.user),
      sourceIds: idList(
        (Array.isArray(entry.sourceRefs) ? entry.sourceRefs : []).map((ref: Untyped) => ref?.messageId)
      ),
    },
  };
}

/**
 * The identity of a row's content: `<kind>:<id>:<revision>`; two rows with one key embed the
 * same text version.
 */
export function chunkKey(meta: { kind?: string; id?: string; revision?: unknown }): string {
  return `${meta?.kind === 'archive' ? 'archive' : 'record'}:${meta?.id ?? ''}:${meta?.revision ?? ''}`;
}
