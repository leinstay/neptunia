// The GIF picker's pure side. The `<gifs>` block of a turn shows only the top
// of the library by popularity, so a GIF that carries the reaction of a short
// reply is rarely in front of the persona. After the reply is written, its
// first message, when short (at most `gifs.pick.maxChars` code points), goes
// to a cheap classifier (prompts/gif-pick.md) together with the chat line it
// answers and the WHOLE captioned library; when it names a handle, the GIF is
// posted in place of that first message and the rest follow as written
// (src/behavior/turn.ts). This module decides when the picker runs, chooses
// the chat lines of its `<context>`, renders the library it reads and reads
// its one-line answer.

import { isPlainObject } from '../config.ts';
import { gifCaption, gifLine } from './prompt.ts';
import type { Untyped } from '../tools/types.ts';

/** A library entry, as the caption and the line of `<gifs>` read it. */
type PickEntry = Parameters<typeof gifLine>[0];

/**
 * The GIF picker's measures: production values of the config cut of 2026-10-31 (`maxChars`, `contextMessages`,
 * `graceMs`), and the fallback of `gifs.pick.maxOutputTokens`.
 */
export const GIF_PICK_DEFAULTS = Object.freeze({
  maxChars: 160,
  contextMessages: 4,
  maxOutputTokens: 60,
  graceMs: 1000,
});

/**
 * The GIF picker's settings: GIF_PICK_DEFAULTS (`maxChars`, the longest message in code points the picker may
 * replace; `contextMessages`, the last chat lines its `<context>` shows; `graceMs`, how long the first message, once
 * its typing imitation is over, still waits for the picker's answer), with `gifs.pick.maxOutputTokens` read from the
 * live config (> 0, floored; a missing or unusable value takes the default).
 * @param config  The whole live config.
 */
export function gifPickSettings(config: Record<string, Untyped>): {
  maxChars: number;
  contextMessages: number;
  maxOutputTokens: number;
  graceMs: number | null;
} {
  const group: Record<string, unknown> = isPlainObject(config?.gifs?.pick) ? config.gifs.pick : {};
  const read = (key: 'maxOutputTokens', min: number): number => {
    const value = group[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= min
      ? Math.floor(value)
      : GIF_PICK_DEFAULTS[key];
  };
  return {
    maxChars: GIF_PICK_DEFAULTS.maxChars,
    contextMessages: GIF_PICK_DEFAULTS.contextMessages,
    maxOutputTokens: read('maxOutputTokens', 1),
    graceMs: GIF_PICK_DEFAULTS.graceMs,
  };
}

/**
 * Whether the picker runs on a reply: the text it would replace (the turn's
 * first message) is not blank and holds at most `settings.maxChars` code
 * points, the turn posts no GIF of its own, and the library has at least one
 * captioned entry. Pure.
 *   `captioned`: how many entries renderGifLibrary listed.
 * @param settings  gifPickSettings.
 */
export function pickCandidates(
  reply: { text: string; postsGif: boolean; captioned: number } | null,
  settings: { maxChars: number }
): boolean {
  if (!reply || typeof reply.text !== 'string' || reply.text.trim() === '') return false;
  if (reply.postsGif === true) return false;
  if (!(reply.captioned > 0)) return false;
  return [...reply.text].length <= settings.maxChars;
}

/**
 * The chat lines of the picker's `<context>`, oldest first: the last
 * `contextMessages` lines of `history`, and before them the line the reply
 * answers (`answeredId`) when it is in `history` but older than those; with
 * `answeredIndex` its 1-based place among the returned lines (the `#n` the
 * transcript gives it), or null when the answered line is unknown or not in
 * `history`. `contextMessages` 0 -> no lines at all. Pure.
 * @param history  The turn's chat lines, oldest first (each with an `id`).
 */
export function pickContext(
  history: Array<Record<string, Untyped>>,
  { contextMessages, answeredId = null }: { contextMessages: number; answeredId?: string | null }
): { messages: Array<Record<string, Untyped>>; answeredIndex: number | null } {
  const lines = Array.isArray(history) ? history : [];
  if (!(contextMessages > 0) || lines.length === 0) return { messages: [], answeredIndex: null };
  const last = lines.slice(-contextMessages);
  const answered = answeredId == null ? null : lines.find((message) => message?.id === answeredId);
  if (!answered) return { messages: last, answeredIndex: null };
  const inLast = last.indexOf(answered);
  if (inLast !== -1) return { messages: last, answeredIndex: inLast + 1 };
  return { messages: [answered, ...last], answeredIndex: 1 };
}

/**
 * The entries of `entries` that have a caption (src/behavior/prompt.ts#gifCaption),
 * in the order given: the ones the picker lists. Pure.
 * @param entries  The library's entries (src/memory/gifs.js#rankGifs).
 * @param mediaCache  The describer cache (store.getMediaCache), read only.
 * @param actionChars  `gifs.actionChars` (0 = whole caption).
 */
export function captionedEntries(
  entries: Array<PickEntry>,
  mediaCache: object | null | undefined,
  actionChars: number
): Array<PickEntry> {
  return Array.isArray(entries) ? entries.filter((entry) => gifCaption(entry, mediaCache, actionChars) !== '') : [];
}

/**
 * The picker's `<gifs>` lines: one per entry of `entries` that has a caption
 * (src/behavior/prompt.ts#gifCaption), in the order given, rendered as the
 * turn's `<gifs>` block renders an entry (src/behavior/prompt.ts#gifLine: the
 * three fields through `labels.gifs.entryFields`, an older caption through
 * `labels.gifs.entry`, the persona's own-post mark within `ownMarkHours`);
 * no header, no top slice. Entries carrying the own-mark come after all the
 * unmarked ones (each group keeps the given order). Entries without a caption are left out; `[]` when
 * the labels carry no `gifs.entry`. Pure.
 * @param entries  The library's entries (src/memory/gifs.js#rankGifs).
 * @param mediaCache  The describer cache (store.getMediaCache), read only.
 *   `reactionChars` / `actionChars`: `gifs.reactionChars` / `gifs.actionChars`
 *   (src/behavior/prompt.ts#gifFieldChars; 0 = no cut).
 */
export function renderGifLibrary(
  entries: Array<PickEntry>,
  mediaCache: object | null | undefined,
  labels: Record<string, Untyped>,
  {
    now,
    ownMarkHours,
    reactionChars,
    actionChars,
  }: { now: number; ownMarkHours: number; reactionChars: number; actionChars: number }
): Array<string> {
  if (!labels?.gifs?.entry) return [];
  // The own-marked entries (the mark changes with the clock) go after the unmarked ones, each group in the given
  // order, so the long stable head of the list stays identical between requests (the provider's prompt cache).
  const plain: Array<string> = [];
  const marked: Array<string> = [];
  for (const entry of captionedEntries(entries, mediaCache, actionChars)) {
    const line = gifLine(entry, mediaCache, labels, { reactionChars, actionChars, ownMarkHours, now });
    const bare = gifLine(entry, mediaCache, labels, { reactionChars, actionChars, ownMarkHours: 0, now });
    (line === bare ? plain : marked).push(line);
  }
  return [...plain, ...marked];
}

/**
 * The picker's answer read strictly: the trimmed text, one line, equal to one
 * of `handles` in any case -> that handle as listed; `none`, anything else,
 * several lines or no text -> null. Pure.
 * @param handles  The handles the request listed.
 */
export function parseGifPick(text: unknown, handles: Array<string>): string | null {
  if (typeof text !== 'string' || !Array.isArray(handles)) return null;
  const line = text.trim();
  if (line === '' || /[\r\n]/.test(line)) return null;
  const wanted = line.toLowerCase();
  return handles.find((handle) => String(handle).toLowerCase() === wanted) ?? null;
}
