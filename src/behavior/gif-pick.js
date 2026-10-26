// The GIF picker's pure side. The `<gifs>` block of a turn shows only the top
// of the library by popularity, so a GIF that carries the reaction of a short
// reply is rarely in front of the persona. After the reply is written, its
// first message, when short (at most `gifs.pick.maxChars` code points), goes
// to a cheap classifier (prompts/gif-pick.md) together with the chat line it
// answers and the WHOLE captioned library; when it names a handle, the GIF is
// posted in place of that first message and the rest follow as written
// (src/behavior/turn.js). This module decides when the picker runs, chooses
// the chat lines of its `<context>`, renders the library it reads and reads
// its one-line answer.

import { isPlainObject } from '../config.js';
import { gifCaption, gifLine } from './prompt.js';

/** config.json's `gifs.pick` values: the fallback of a missing or unusable key. */
export const GIF_PICK_DEFAULTS = Object.freeze({
  maxChars: 160,
  contextMessages: 4,
  maxOutputTokens: 60,
  graceMs: 1000,
});

/**
 * The `gifs.pick` settings of the live config, key by key: `maxChars` (the
 * longest message, in code points, the picker may replace; a finite number >= 0,
 * floored), `contextMessages` (the last chat lines its `<context>` shows; >= 0,
 * floored), `maxOutputTokens` (> 0, floored) and `graceMs` (how long the first
 * message, once its typing imitation is over, still waits for the picker's
 * answer; >= 0, floored; `null` = as long as the answer takes); a missing or
 * unusable key takes config.json's value (GIF_PICK_DEFAULTS).
 * @param {object} config  The whole live config.
 * @returns {{ maxChars: number, contextMessages: number, maxOutputTokens: number, graceMs: number|null }}
 */
export function gifPickSettings(config) {
  const group = isPlainObject(config?.gifs?.pick) ? config.gifs.pick : {};
  const read = (key, min) =>
    Number.isFinite(group[key]) && group[key] >= min ? Math.floor(group[key]) : GIF_PICK_DEFAULTS[key];
  return {
    maxChars: read('maxChars', 0),
    contextMessages: read('contextMessages', 0),
    maxOutputTokens: read('maxOutputTokens', 1),
    graceMs: group.graceMs === null ? null : read('graceMs', 0),
  };
}

/**
 * Whether the picker runs on a reply: the text it would replace (the turn's
 * first message) is not blank and holds at most `settings.maxChars` code
 * points, the turn posts no GIF of its own, and the library has at least one
 * captioned entry. Pure.
 * @param {{ text: string, postsGif: boolean, captioned: number }|null} reply
 *   `captioned`: how many entries renderGifLibrary listed.
 * @param {{ maxChars: number }} settings  gifPickSettings.
 * @returns {boolean}
 */
export function pickCandidates(reply, settings) {
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
 * @param {object[]} history  The turn's chat lines, oldest first (each with an `id`).
 * @param {{ contextMessages: number, answeredId?: string|null }} options
 * @returns {{ messages: object[], answeredIndex: number|null }}
 */
export function pickContext(history, { contextMessages, answeredId = null }) {
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
 * The entries of `entries` that have a caption (src/behavior/prompt.js#gifCaption),
 * in the order given: the ones the picker lists. Pure.
 * @param {object[]} entries  The library's entries (src/memory/gifs.js#rankGifs).
 * @param {object|null} mediaCache  The describer cache (store.getMediaCache), read only.
 * @param {number} actionChars  `gifs.actionChars` (0 = whole caption).
 * @returns {object[]}
 */
export function captionedEntries(entries, mediaCache, actionChars) {
  return Array.isArray(entries) ? entries.filter((entry) => gifCaption(entry, mediaCache, actionChars) !== '') : [];
}

/**
 * The picker's `<gifs>` lines: one per entry of `entries` that has a caption
 * (src/behavior/prompt.js#gifCaption), in the order given, rendered as the
 * turn's `<gifs>` block renders an entry (src/behavior/prompt.js#gifLine: the
 * three fields through `labels.gifs.entryFields`, an older caption through
 * `labels.gifs.entry`, the persona's own-post mark within `ownMarkHours`);
 * no header, no top slice. Entries carrying the own-mark come after all the
 * unmarked ones (each group keeps the given order). Entries without a caption are left out; `[]` when
 * the labels carry no `gifs.entry`. Pure.
 * @param {object[]} entries  The library's entries (src/memory/gifs.js#rankGifs).
 * @param {object|null} mediaCache  The describer cache (store.getMediaCache), read only.
 * @param {object} labels
 * @param {{ now: number, ownMarkHours: number, reactionChars: number, actionChars: number }} options
 *   `reactionChars` / `actionChars`: `gifs.reactionChars` / `gifs.actionChars`
 *   (src/behavior/prompt.js#gifFieldChars; 0 = no cut).
 * @returns {string[]}
 */
export function renderGifLibrary(entries, mediaCache, labels, { now, ownMarkHours, reactionChars, actionChars }) {
  if (!labels?.gifs?.entry) return [];
  // The own-marked entries (the mark changes with the clock) go after the unmarked ones, each group in the given
  // order, so the long stable head of the list stays identical between requests (the provider's prompt cache).
  const plain = [];
  const marked = [];
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
 * @param {unknown} text
 * @param {string[]} handles  The handles the request listed.
 * @returns {string|null}
 */
export function parseGifPick(text, handles) {
  if (typeof text !== 'string' || !Array.isArray(handles)) return null;
  const line = text.trim();
  if (line === '' || /[\r\n]/.test(line)) return null;
  const wanted = line.toLowerCase();
  return handles.find((handle) => String(handle).toLowerCase() === wanted) ?? null;
}
