// Parses the model's tagged output (contract: prompts/format.md) into actions.
//   <think>…</think>          hidden planning, discarded
//   <msg reply="#87">…</msg>   a chat message, optionally a reply to message #87 (at most 3:
//                              any later one is joined into the third, a line each)
//   <react to="#87">💀</react> a reaction on message #87 (a custom emoji as :name: too)
//   <draw self="yes" reply="#87">…</draw>  a scene for the drawing sub-process, read only when the
//                              caller asks (`draws: true`, the diary post until it moves to the
//                              `draw.create` tool): `draw` is the first one, `draws` every one in
//                              order (at most 10). Anywhere else a picture is a tool call, and this
//                              tag is a retired one (below).
//   <gif reply="#87">g12</gif> a GIF from the library by its handle (first valid one only)
//   <skip/>                    stay silent
// Her tool calls are not text any more: native tool calls come with the answer, and the text
// transport's `<tool_call>` blocks are cut out before this parser sees the text
// (src/llm/tool-text.js). A leftover `<call>` or `<draw>` tag (her history still holds some) is cut
// out wherever it stands outside code, never run, and told as a `retiredTag` diagnostic.
// The parser is forgiving: a missing tag wrapper falls back to a single plain
// message (`untagged`), an unterminated <think> (output cut by max_tokens) means
// silence (`thinkOpen`, its text so far kept in `think` for the journal). It also accounts for
// what it did not use: `diagnostics`, one `{ kind, ... }` per thing it dropped, cut or joined
// (`retiredTag` with its `tag`, `messageCut`, `messagesMerged`, `thinkUnclosed`), so the caller can
// tell the persona what happened to her output (src/behavior/turn.js).

import { clampAtBoundary } from '../memory/clamp.js';

const MAX_MESSAGES = 3;
const MAX_MESSAGE_CHARS = 1900;
const MAX_FALLBACK_CHARS = 600;
// The default <draw> body cap: image.maxPromptChars in config.json (callers pass the live value).
const DEFAULT_MAX_DRAW_CHARS = 1600;
// The most <draw> tags read into `draws` (a diary set renders the first diary.set.pictures[1] of them).
const MAX_DRAWS = 10;
const SELF_YES = new Set(['yes', 'true', '1']);
// A reaction body: a short unicode emoji, or a custom one as `:name:` / `<a:name:id>` (src/behavior/emoji.js).
const MAX_REACTION_CHARS = 16;
const CUSTOM_REACTION_RE = /^(?::[A-Za-z0-9_]{2,32}:|<a?:[A-Za-z0-9_]{2,32}:\d{1,25}>)$/;
// A GIF handle (src/memory/gifs.js): `g` and digits, any case.
const GIF_HANDLE_RE = /^g(\d{1,9})$/i;

// A retired tag written out in text: whole (closed or self-closing), or a lone opening. Two kinds:
// `<call ...>` and `<draw ...>` (the latter only where the caller does not read pictures).
const RETIRED_TAG_RES = Object.freeze({
  call: [/<call\b[^>]*?\/>/gi, /<call\b[^>]*?>[\s\S]*?<\/call\s*>/gi, /<call\b[^>]*>/gi],
  draw: [/<draw\b[^>]*?\/>/gi, /<draw\b[^>]*?>[\s\S]*?<\/draw\s*>/gi, /<draw\b[^>]*>/gi],
});

/**
 * `text` without the retired tags of `tags` written outside code (a code span or block keeps what
 * it shows): each one cut is a `retiredTag` diagnostic (`diagnostics`, with its `tag`). A closing
 * tag left alone is dropped too, uncounted.
 */
function withoutRetiredTags(text, tags, diagnostics) {
  if (!tags.some((tag) => new RegExp(`<${tag}\\b`, 'i').test(text))) return text;
  const parts = text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      let out = part;
      for (const tag of tags) {
        for (const re of RETIRED_TAG_RES[tag]) {
          out = out.replace(re, () => {
            diagnostics.push({ kind: 'retiredTag', tag });
            return '';
          });
        }
        out = out.replace(new RegExp(`</${tag}\\s*>`, 'gi'), '');
      }
      return out === part ? part : out.replace(/[ \t]{2,}/g, ' ');
    })
    .join('');
}

function parseIndex(value) {
  const match = /(\d+)/.exec(value ?? '');
  return match ? Number(match[1]) : null;
}

/**
 * The model's tagged output as actions. With `draws: true` (the diary post), `draw` is the first
 * non-empty `<draw>`, `draws` every non-empty one in order, at most 10 (`draw` is `draws[0]`, or
 * null when there is none); otherwise a `<draw>` is a retired tag and none is read.
 * @param {unknown} raw
 * @param {{ maxDrawChars?: number, limits?: { add: Function }|null, draws?: boolean }} [options] `maxDrawChars`: the
 *   cap of one <draw> body, cut at a sentence or word boundary (clampAtBoundary); the live
 *   `image.maxPromptChars`, default 1600. At most 3 messages come out: every `<msg>` past the
 *   third is joined into the third, each on its own line, its text unchanged (its own reply
 *   target is dropped). `limits` (src/llm/limits.js#createLimits, optional) is told of such a
 *   join as a `message-merge` (`where: 'parse'`, `lost`: the messages joined) and of every
 *   `<msg>` (a joined one included) cut at 1900 characters as a `message-cut` (`where: 'parse'`)
 *   with the characters lost. `draws`: read `<draw>` tags (the diary post); default false.
 * @returns {{ skip: boolean, messages: {text: string, replyTo: number|null}[],
 *             reactions: {to: number, emoji: string}[], untargetedReactions: {emoji: string}[], think: string,
 *             draw: {text: string, self: boolean, replyTo: number|null}|null,
 *             draws: {text: string, self: boolean, replyTo: number|null}[],
 *             gif: {id: string, replyTo: number|null}|null,
 *             thinkOpen: boolean, untagged: boolean, diagnostics: object[] }}
 *   `diagnostics`: what the parser did not use, in order -- `{ kind: 'retiredTag', tag: 'call'|'draw' }`
 *   (a retired tag written outside code, cut out), `{ kind: 'messageCut', chars }`,
 *   `{ kind: 'messagesMerged', count }`, `{ kind: 'thinkUnclosed' }`. `thinkOpen`: a `<think>` was never
 *   closed -- silence, with what it held so far appended to `think`. `untagged`: the one message is the
 *   plain text of an answer with no tag (the fallback), not a `<msg>`.
 */
export function parseOutput(raw, { maxDrawChars = DEFAULT_MAX_DRAW_CHARS, limits = null, draws: readDraws = false } = {}) {
  const result = { skip: false, messages: [], reactions: [], untargetedReactions: [], think: '', draw: null, draws: [], gif: null, thinkOpen: false, untagged: false, diagnostics: [] };
  let text = String(raw ?? '');

  text = text.replace(/<think>([\s\S]*?)<\/think>/gi, (all, inner) => {
    result.think += inner.trim();
    return '';
  });
  const open = /<think>([\s\S]*)$/i.exec(text);
  if (open) {
    const sofar = open[1].trim();
    result.think = [result.think, sofar].filter(Boolean).join('\n');
    result.thinkOpen = true;
    result.skip = true;
    result.diagnostics.push({ kind: 'thinkUnclosed' });
    return result;
  }

  // The retired tags come out first: never a message, never run (`<draw>` stays for the diary post).
  text = withoutRetiredTags(text, readDraws ? ['call'] : ['call', 'draw'], result.diagnostics);

  const bodies = [];
  for (const match of text.matchAll(/<msg(\s[^>]*)?>([\s\S]*?)<\/msg>/gi)) {
    const body = match[2].trim();
    if (!body) continue;
    const reply = /reply\s*=\s*"([^"]*)"/i.exec(match[1] ?? '');
    bodies.push({ text: body, replyTo: reply ? parseIndex(reply[1]) : null });
  }
  // Every message past the cap is joined into the last kept one, a line each, so no tail is
  // lost unseen; the last kept one keeps its own reply target, theirs are dropped.
  if (bodies.length > MAX_MESSAGES) {
    const extra = bodies.splice(MAX_MESSAGES);
    const last = bodies[MAX_MESSAGES - 1];
    last.text = [last.text, ...extra.map((item) => item.text)].join('\n');
    limits?.add({ kind: 'message-merge', where: 'parse', lost: extra.length });
    result.diagnostics.push({ kind: 'messagesMerged', count: extra.length });
  }
  for (const { text: body, replyTo } of bodies) {
    if (body.length > MAX_MESSAGE_CHARS) {
      const lost = Array.from(body.slice(MAX_MESSAGE_CHARS)).length;
      limits?.add({ kind: 'message-cut', where: 'parse', lost });
      result.diagnostics.push({ kind: 'messageCut', chars: lost });
    }
    result.messages.push({ text: body.slice(0, MAX_MESSAGE_CHARS), replyTo });
  }

  for (const match of text.matchAll(/<react(\s[^>]*)?>([\s\S]*?)<\/react>/gi)) {
    const target = /\bto\s*=\s*"([^"]*)"/i.exec(match[1] ?? '');
    const to = target ? parseIndex(target[1]) : null;
    const emoji = match[2].trim();
    const fits = emoji.length <= MAX_REACTION_CHARS || CUSTOM_REACTION_RE.test(emoji);
    if (!emoji || !fits) continue;
    // A reaction that names no message is kept apart: an addressed turn ignores it, an inner turn refuses it.
    if (to !== null) result.reactions.push({ to, emoji });
    else result.untargetedReactions.push({ emoji });
  }

  if (readDraws) {
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
  }

  for (const match of text.matchAll(/<gif(\s[^>]*)?>([\s\S]*?)<\/gif>/gi)) {
    const handle = GIF_HANDLE_RE.exec(match[2].trim());
    if (!handle) continue;
    const reply = /reply\s*=\s*"([^"]*)"/i.exec(match[1] ?? '');
    result.gif = { id: `g${Number(handle[1])}`, replyTo: reply ? parseIndex(reply[1]) : null };
    break;
  }

  if (result.messages.length === 0 && result.reactions.length === 0 && result.untargetedReactions.length === 0 && !result.draw && !result.gif) {
    const leftover = text.replace(/<skip\s*\/?>/gi, '').trim();
    const hasTags = /<\/?(msg|react|skip|draw|gif|call|tool_call)\b/i.test(text);
    if (!hasTags && leftover && leftover.length <= MAX_FALLBACK_CHARS) {
      result.messages.push({ text: leftover, replyTo: null });
      result.untagged = true;
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
