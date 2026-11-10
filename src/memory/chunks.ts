// What one vector of the meaning index holds (src/memory/vectors.ts): the text sent to the
// embedding model and the row's provenance. A record message is embedded with the lines before it
// in the same channel and the same layer (the place record, or one member's private record), so a
// short answer carries what it answers; an archive item (an episode, a lesson, an evicted item) is
// embedded alone. Pure: names are resolved by the caller's `nameOf`, nothing is read or written.
//
// A chunk line is `author: text`, the text on one line with every `<@id>` token resolved to the
// member's name, cut to `CHUNK_LINE_CHARS`, then the title and description of each link preview
// the line carries (its `links`, src/memory/record.ts#recordLinks), cut to the same length, so a
// link post is found by what it shows; the persona's own lines carry `selfName`. Row meta:
// `{ kind, id, revision, occurredAt, placeId, by, participants, sourceIds }`, where
// `participants` is the union over every line of the chunk and `sourceIds` the message ids of
// those lines, so a forget reaches a row through any line it holds.

import { clampChars, oneLine } from './clamp.ts';
import { fromTokens } from './mentions.ts';
import { isoOf } from './record.ts';
import { isFiniteNumber, isIntegerNumber } from './types.ts';
import type { Untyped } from './types.ts';
import type { RecordLine } from './record.ts';

/** Resolves a member id to the display name, or null when unknown. */
type NameOf = (id: string) => string | null;

/** The preceding lines of the same channel a record chunk carries. */
export const CHUNK_CONTEXT_LINES = 2;
/** The longest text of one chunk line, in characters. */
export const CHUNK_LINE_CHARS = 300;

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

/** The channel of a record line, or null. */
const channelOf = (line: Pick<RecordLine, 'scope'>) =>
  typeof line?.scope?.channel === 'string' && line.scope.channel ? line.scope.channel : null;

/** The layer of a record line: its private member, or '' for the place. */
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
      placeId: channelOf(line),
      by: typeof line.by === 'string' && line.by ? line.by : null,
      // The line's own members first, then its context's.
      participants: idList(...[line, ...lines.slice(0, -1)].map((item) => idList(item.participants, item.by))),
      sourceIds: idList(lines.map((item) => item.messageId)),
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
