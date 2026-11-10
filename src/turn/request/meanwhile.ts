// The body of `<meanwhile>`: her last messages in other places, each with a few lines around it, as background she is
// not asked about (docs/prompt-contract.md). Never a line of the current place. A one-to-one chat's lines only at the
// command line and in a chat with the same person; the reads already keep out what the turn's scope may not read. Windows of
// one place that overlap merge, and each window is headed by its place's path and date. A line's media follow its text
// as the chat renders stored media, so a post of a picture alone reads as its description. The request builder
// (src/turn/request/reader.ts) calls it. Pure apart from the reads.

import { fill, formatClock, formatDate, storedMediaTags } from '../../format.ts';
import { lineItemParts } from '../../memory/db/media-store.ts';
import type { LineMediaItem } from '../../memory/db/media-store.ts';
import type { Frame } from './frame.ts';
import { escapeStored, pathText } from './text.ts';
import type { Labels, NameOf } from './types.ts';

/**
 * A stored line as `<meanwhile>` reads it; `at` is epoch ms, `sourceId` its source row's id when the reads give it,
 * `authorName` the first name its author's rows hold (frame-reads.ts#FrameLine), `media` its media items in position
 * order.
 */
export type MeanwhileLine = {
  id: string;
  sourceId?: string;
  placeId: string;
  at: number;
  authorId: string | null;
  authorName?: string | null;
  self: boolean;
  text: string;
  media?: ReadonlyArray<LineMediaItem>;
};

/**
 * A line of hers, with the path of its place by names, whether that place is a one-to-one chat and that chat's partner
 * person when the reads know it.
 */
export type OwnMessage = MeanwhileLine & { path: ReadonlyArray<string>; dm: boolean; partner?: string | null };

/** The reads `<meanwhile>` takes: her newest lines, newest first, and the lines around one line, oldest first. */
export type MeanwhileReads = {
  ownMessages(limit: number): ReadonlyArray<OwnMessage>;
  around(placeId: string, at: number, count: number): ReadonlyArray<MeanwhileLine>;
};

/** `context.meanwhile`: how many of her lines, and how many lines before and after each. */
export type MeanwhileSettings = { messages: number; around: number };

/** The shipped values of `context.meanwhile` and `context.memory.serviceMessages`, for a key the live settings lack. */
const SHIPPED = { messages: 8, around: 2, serviceMessages: 100 };

/** A number of the settings section `section` under `key`, read now; `fallback` for a missing or negative one. */
function settingOf(section: unknown, key: string, fallback: number): number {
  const value: unknown = section && typeof section === 'object' ? Reflect.get(section, key) : undefined;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * `context.meanwhile` for the frame, read now: a turn that is nowhere (a service) shows her last
 * `context.memory.serviceMessages` lines instead of `context.meanwhile.messages`.
 */
export function meanwhileSettingsOf(config: unknown, frame: Frame): MeanwhileSettings {
  const context: unknown = config && typeof config === 'object' ? Reflect.get(config, 'context') : null;
  const section = (key: string): unknown => (context && typeof context === 'object' ? Reflect.get(context, key) : null);
  const meanwhile = section('meanwhile');
  const messages =
    frame.place === null
      ? settingOf(section('memory'), 'serviceMessages', SHIPPED.serviceMessages)
      : settingOf(meanwhile, 'messages', SHIPPED.messages);
  return { messages, around: settingOf(meanwhile, 'around', SHIPPED.around) };
}

/** One window of lines in one place, oldest first. */
export type MeanwhileWindow = {
  placeId: string;
  path: ReadonlyArray<string>;
  dm: boolean;
  lines: Array<MeanwhileLine>;
};

/** The interface the owner's command line speaks as (src/interface/link.ts#CLI_IFACE). */
const CLI_IFACE = 'cli';

/** How many more of her lines are read than shown, so the lines left out here do not empty the block. */
const READ_AHEAD = 4;

/**
 * Whether the frame may show a line in the background. A group's line always. A one-to-one chat's line at the command
 * line, and in a direct chat when it is a chat with the same person over a linked account. A turn that is nowhere shows
 * none: a service reads the groups only.
 */
function shows(frame: Frame, line: OwnMessage): boolean {
  if (!line.dm || frame.interface === CLI_IFACE) return true;
  const partner = frame.counterpart?.personId ?? null;
  return frame.scope === 'dm' && partner !== null && line.partner === partner;
}

/** The time of a window's first line, 0 for an empty one. */
const firstAt = (window: MeanwhileWindow): number => window.lines.at(0)?.at ?? 0;

/** Windows of one place merged where they overlap in time, oldest first, each line once. */
function merged(windows: ReadonlyArray<MeanwhileWindow>): Array<MeanwhileWindow> {
  const sorted = [...windows].sort((a, b) => firstAt(a) - firstAt(b));
  const out: Array<MeanwhileWindow> = [];
  for (const window of sorted) {
    const last = out.at(-1);
    const lastAt = last?.lines.at(-1)?.at ?? -Infinity;
    if (last && last.placeId === window.placeId && firstAt(window) <= lastAt) {
      const ids = new Set(last.lines.map((line) => line.id));
      last.lines.push(...window.lines.filter((line) => !ids.has(line.id)));
      last.lines.sort((a, b) => a.at - b.at);
    } else out.push({ ...window, lines: [...window.lines] });
  }
  return out;
}

/** The windows around her last `settings.messages` lines the frame may show, merged, oldest first. */
export function meanwhileWindows(
  reads: MeanwhileReads,
  frame: Frame,
  settings: MeanwhileSettings
): Array<MeanwhileWindow> {
  const count = Math.max(0, Math.floor(settings.messages));
  if (count === 0) return [];
  const here = frame.place?.id ?? null;
  const own = reads
    .ownMessages(count * READ_AHEAD)
    .filter((line) => line.placeId !== here && shows(frame, line))
    .slice(0, count);
  const around = Math.max(0, Math.floor(settings.around));
  const windows = own.map((line) => {
    const lines = around > 0 ? [...reads.around(line.placeId, line.at, around)] : [];
    return { placeId: line.placeId, path: line.path, dm: line.dm, lines: lines.length > 0 ? lines : [line] };
  });
  const byPlace = new Map<string, Array<MeanwhileWindow>>();
  for (const window of windows) byPlace.set(window.placeId, [...(byPlace.get(window.placeId) ?? []), window]);
  return [...byPlace.values()].flatMap(merged).sort((a, b) => firstAt(a) - firstAt(b));
}

/** A line's text and the tags of its media as the chat renders them (`labels.transcript`), a picture alone included. */
function lineText(line: MeanwhileLine, labels: Labels): string {
  const tags = line.media?.length ? storedMediaTags(lineItemParts(line.media, line.id), labels) : [];
  return [line.text, ...tags].filter(Boolean).join(' ');
}

/**
 * The author of a line as a window names them: the name the line's stored rows hold, else `nameOf` of the platform id,
 * else the id itself. The stored name comes first because `nameOf` knows only the accounts of the turn's own interface.
 */
function authorOf(line: MeanwhileLine, nameOf: NameOf): string {
  if (line.authorName) return line.authorName;
  return (line.authorId && nameOf(line.authorId)) || line.authorId || '';
}

/** One window in the labels' words: the place's path and date, then each line with its time and author. */
export function windowText(
  window: MeanwhileWindow,
  frame: Frame,
  labels: Labels,
  nameOf: NameOf,
  handle: string | null = null
): string {
  const l = labels.meanwhile ?? {};
  const first = window.lines.at(0)?.at ?? frame.now;
  const head = fill(l.place ?? '{path}, {date}:', {
    path: pathText(window.path, labels.memory?.pathJoin),
    date: formatDate(first, frame.timezone, labels.locale),
  });
  const lines = window.lines.map((line) =>
    fill(l.line ?? '[{time}] {author}: {text}', {
      time: formatClock(line.at, frame.timezone, labels.locale),
      author: escapeStored(line.self ? (l.you ?? '') : authorOf(line, nameOf)),
      text: escapeStored(lineText(line, labels)),
    })
  );
  return [handle ? `#${handle} ${head}` : head, ...lines].join('\n');
}

/** The body of `<meanwhile>`, headed as background; '' with no line of hers elsewhere. */
export function meanwhileOf(
  reads: MeanwhileReads,
  frame: Frame,
  settings: MeanwhileSettings,
  labels: Labels,
  nameOf: NameOf
): string {
  return meanwhileText(meanwhileWindows(reads, frame, settings), frame, labels, nameOf);
}

/** The body of `<meanwhile>` over `windows`, headed as background; '' with no window. */
export function meanwhileText(
  windows: ReadonlyArray<MeanwhileWindow>,
  frame: Frame,
  labels: Labels,
  nameOf: NameOf,
  handleOf: (window: MeanwhileWindow) => string | null = () => null
): string {
  if (windows.length === 0) return '';
  const texts = windows.map((window) => windowText(window, frame, labels, nameOf, handleOf(window)));
  return [labels.meanwhile?.header ?? '', ...texts].filter(Boolean).join('\n\n');
}
