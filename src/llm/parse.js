// Parses the model's tagged output (contract: prompts/format.md) into actions.
//   <think>…</think>          hidden planning, discarded
//   <msg reply="#87">…</msg>   a chat message, optionally a reply to message #87
//   <react to="#87">💀</react> a reaction on message #87 (a custom emoji as :name: too)
//   <draw self="yes" reply="#87">…</draw>  a scene for the drawing sub-process: `draw` is the
//                              first one, `draws` every one in order (at most 10; a diary
//                              set post draws several, every other turn only the first)
//   <gif reply="#87">g12</gif> a GIF from the library by its handle (first valid one only)
//   <skip/>                    stay silent
// The parser is forgiving: a missing tag wrapper falls back to a single plain
// message, an unterminated <think> (output cut by max_tokens) means silence.

import { clampAtBoundary } from '../memory/clamp.js';

const MAX_MESSAGES = 3;
const MAX_MESSAGE_CHARS = 1900;
const MAX_FALLBACK_CHARS = 600;
// The default <draw> body cap: image.maxPromptChars in config.json (callers pass the live value).
const DEFAULT_MAX_DRAW_CHARS = 1600;
// The most <draw> tags read into `draws` (a diary set renders the first diary.set.pictures[1] of them).
const MAX_DRAWS = 10;
const SELF_YES = new Set(['yes', 'true', '1']);
// A reaction body: a short unicode emoji, or a custom one as `:name:` / `<a:name:id>` (src/discord/emoji.js).
const MAX_REACTION_CHARS = 16;
const CUSTOM_REACTION_RE = /^(?::[A-Za-z0-9_]{2,32}:|<a?:[A-Za-z0-9_]{2,32}:\d{1,25}>)$/;
// A GIF handle (src/memory/gifs.js): `g` and digits, any case.
const GIF_HANDLE_RE = /^g(\d{1,9})$/i;

function parseIndex(value) {
  const match = /(\d+)/.exec(value ?? '');
  return match ? Number(match[1]) : null;
}

/**
 * The model's tagged output as actions. `draw` is the first non-empty
 * `<draw>`, `draws` every non-empty one in order, at most 10 (`draw` is
 * `draws[0]`, or null when there is none).
 * @param {unknown} raw
 * @param {{ maxDrawChars?: number }} [options] `maxDrawChars`: the cap of one <draw> body, cut at a
 *   sentence or word boundary (clampAtBoundary); the live `image.maxPromptChars`, default 1600.
 * @returns {{ skip: boolean, messages: {text: string, replyTo: number|null}[],
 *             reactions: {to: number, emoji: string}[], think: string,
 *             draw: {text: string, self: boolean, replyTo: number|null}|null,
 *             draws: {text: string, self: boolean, replyTo: number|null}[],
 *             gif: {id: string, replyTo: number|null}|null }}
 */
export function parseOutput(raw, { maxDrawChars = DEFAULT_MAX_DRAW_CHARS } = {}) {
  const result = { skip: false, messages: [], reactions: [], think: '', draw: null, draws: [], gif: null };
  let text = String(raw ?? '');

  text = text.replace(/<think>([\s\S]*?)<\/think>/gi, (all, inner) => {
    result.think += inner.trim();
    return '';
  });
  if (/<think>/i.test(text)) {
    result.skip = true;
    return result;
  }

  for (const match of text.matchAll(/<msg(\s[^>]*)?>([\s\S]*?)<\/msg>/gi)) {
    const body = match[2].trim();
    if (!body) continue;
    const reply = /reply\s*=\s*"([^"]*)"/i.exec(match[1] ?? '');
    result.messages.push({
      text: body.slice(0, MAX_MESSAGE_CHARS),
      replyTo: reply ? parseIndex(reply[1]) : null,
    });
  }

  for (const match of text.matchAll(/<react\s+to\s*=\s*"([^"]*)"\s*>([\s\S]*?)<\/react>/gi)) {
    const to = parseIndex(match[1]);
    const emoji = match[2].trim();
    const fits = emoji.length <= MAX_REACTION_CHARS || CUSTOM_REACTION_RE.test(emoji);
    if (to !== null && emoji && fits) result.reactions.push({ to, emoji });
  }

  for (const match of text.matchAll(/<draw(\s[^>]*)?>([\s\S]*?)<\/draw>/gi)) {
    const body = match[2].trim();
    if (!body) continue;
    const attrs = match[1] ?? '';
    const self = /self\s*=\s*"([^"]*)"/i.exec(attrs);
    const reply = /reply\s*=\s*"([^"]*)"/i.exec(attrs);
    result.draws.push({
      text: clampAtBoundary(body, maxDrawChars),
      self: self ? SELF_YES.has(self[1].trim().toLowerCase()) : false,
      replyTo: reply ? parseIndex(reply[1]) : null,
    });
    if (result.draws.length >= MAX_DRAWS) break;
  }
  result.draw = result.draws[0] ?? null;

  for (const match of text.matchAll(/<gif(\s[^>]*)?>([\s\S]*?)<\/gif>/gi)) {
    const handle = GIF_HANDLE_RE.exec(match[2].trim());
    if (!handle) continue;
    const reply = /reply\s*=\s*"([^"]*)"/i.exec(match[1] ?? '');
    result.gif = { id: `g${Number(handle[1])}`, replyTo: reply ? parseIndex(reply[1]) : null };
    break;
  }

  result.messages = result.messages.slice(0, MAX_MESSAGES);

  if (result.messages.length === 0 && result.reactions.length === 0 && !result.draw && !result.gif) {
    const leftover = text.replace(/<skip\s*\/?>/gi, '').trim();
    const hasTags = /<\/?(msg|react|skip|draw|gif)\b/i.test(text);
    if (!hasTags && leftover && leftover.length <= MAX_FALLBACK_CHARS) {
      result.messages.push({ text: leftover, replyTo: null });
    } else {
      result.skip = true;
    }
  }

  return result;
}

/**
 * Parse the outermost `{...}` span of a model reply (from its first `{` to its
 * last `}`), tolerating code fences and chatter around it. Two objects in one
 * reply, or a stray `}` in trailing chatter, make the span invalid and throw.
 * @param {unknown} raw
 * @returns {any}
 * @throws {Error|SyntaxError} no `{...}` span, or one that is not valid JSON.
 */
export function parseJsonObject(raw) {
  const text = String(raw ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in the model reply');
  return JSON.parse(text.slice(start, end + 1));
}
