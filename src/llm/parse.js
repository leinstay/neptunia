// Parses the model's tagged output (contract: prompts/format.md) into actions.
//   <think>…</think>          hidden planning, discarded
//   <msg reply="#87">…</msg>   a chat message, optionally a reply to message #87 (at most 3:
//                              any later one is joined into the third, a line each)
//   <react to="#87">💀</react> a reaction on message #87 (a custom emoji as :name: too)
//   <draw self="yes" reply="#87">…</draw>  a scene for the drawing sub-process: `draw` is the
//                              first one, `draws` every one in order (at most 10; a diary
//                              set post draws several, every other turn only the first)
//   <gif reply="#87">g12</gif> a GIF from the library by its handle (first valid one only)
//   <skip/>                    stay silent
//   <call skill="name" key="value">text</call>  one skill call (src/skills/executors.js), or
//                              self-closing `<call skill="name" key="value"/>`; parsed strictly
//                              and only at the top level of the output: never inside another
//                              tag's body, a code span or block, or a quoted (`>`) line. The
//                              first one is `call`, any later one is only counted (`extraCalls`);
//                              `calls` holds every well-formed one in order (the tool loop of
//                              features.coreTools runs several, src/behavior/turn.js).
// The parser is forgiving: a missing tag wrapper falls back to a single plain
// message (`untagged`), an unterminated <think> (output cut by max_tokens) means
// silence (`thinkOpen`, its text so far kept in `think` for the journal). It also accounts for
// what it did not use: `diagnostics`, one `{ kind, ... }` per thing it dropped, cut or joined
// (`badCall` with its `reason`, `callInText`, `messageCut`, `messagesMerged`, `thinkUnclosed`),
// so the caller can tell the persona what happened to her output (src/behavior/turn.js).

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

// A skill name: lowercase dotted words (src/skills/registry.js).
const SKILL_NAME_RE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
// One attribute of a <call>: a name and a double-quoted value, nothing else.
const CALL_ATTR_RE = /\s+([A-Za-z][A-Za-z0-9_]*)="([^"]*)"/y;
// A <call> opening (self-closing or not) in the masked top-level text.
const CALL_OPEN_RE = /<call\b([^>]*?)(\/?)>/gi;
// What is no top level: the body of a closed tag, a tag left open (to the end), code, a quoted line.
const NOT_TOP_LEVEL = [
  /<(msg|draw|react|gif)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
  /<(?:msg|draw|react|gif)\b[\s\S]*$/i,
  /```[\s\S]*?(?:```|$)/g,
  /`[^`\n]*`/g,
  /^[ \t]*>.*$/gm,
];

/** `text` with every part that is no top level blanked out, position for position. */
function maskNested(text) {
  let masked = text;
  for (const re of NOT_TOP_LEVEL) masked = masked.replace(re, (all) => ' '.repeat(all.length));
  return masked;
}

/**
 * The attributes of a <call> (`raw`: what follows its name): `{ attrs }` when every one is
 * `name="value"`, each once; else `{ reason }`: `quotes` (a value in single quotes or none), or
 * `attribute` (anything else wrong: a repeated name, a stray word).
 */
function callAttributes(raw) {
  const rest = raw.replace(/\s+$/, '');
  const attrs = {};
  CALL_ATTR_RE.lastIndex = 0;
  let at = 0;
  while (at < rest.length) {
    CALL_ATTR_RE.lastIndex = at;
    const match = CALL_ATTR_RE.exec(rest);
    if (!match) return { reason: /^\s+[A-Za-z][A-Za-z0-9_]*\s*=\s*(?:'|[^"\s])/.test(rest.slice(at)) ? 'quotes' : 'attribute' };
    if (Object.hasOwn(attrs, match[1])) return { reason: 'attribute' };
    attrs[match[1]] = match[2];
    at = CALL_ATTR_RE.lastIndex;
  }
  return { attrs };
}

// A CDATA section: its text is the model's own, whatever tags or `</call>` it holds.
const CDATA_RE = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

/** A call body with every CDATA section unwrapped to the text inside it, wherever it sits. */
function unwrapCdata(body) {
  return body.replace(CDATA_RE, (all, inner) => inner).trim();
}

/** `text` with every CDATA section blanked out, position for position (what no tag in it can mask). */
function blankCdata(text) {
  return text.replace(CDATA_RE, (all) => ' '.repeat(all.length));
}

/**
 * The top-level <call> tags of `text`: `{ calls: [{ start, end, call, error }] }` in order, `call`
 * null for a malformed one with `error` its reason (`quotes`, `attribute`, `name`, `unclosed`;
 * `skill` the name when it reads as one). Every tag's span is where it sits in `text`, its body
 * included; a `</call>` inside a CDATA section does not end the call.
 */
function findCalls(text) {
  const masked = maskNested(blankCdata(text));
  const found = [];
  CALL_OPEN_RE.lastIndex = 0;
  for (let match = CALL_OPEN_RE.exec(masked); match; match = CALL_OPEN_RE.exec(masked)) {
    const start = match.index;
    let end = start + match[0].length;
    let body = '';
    let closed = match[2] === '/';
    if (!closed) {
      const close = /<\/call\s*>/gi;
      close.lastIndex = end;
      const closing = close.exec(masked);
      if (closing) {
        body = text.slice(end, closing.index);
        end = closing.index + closing[0].length;
        closed = true;
        CALL_OPEN_RE.lastIndex = end;
      }
    }
    const parsed = callAttributes(match[1]);
    const skill = parsed.attrs?.skill;
    const named = typeof skill === 'string' && SKILL_NAME_RE.test(skill);
    let call = null;
    let error = null;
    if (!closed) error = 'unclosed';
    else if (!parsed.attrs) error = parsed.reason;
    else if (!named) error = 'name';
    else {
      const { skill: _name, ...args } = parsed.attrs;
      call = { skill, args, body: unwrapCdata(body.trim()) };
    }
    found.push({ start, end, call, ...(error ? { error } : {}), ...(error && named ? { skill } : {}) });
  }
  return found;
}

// A <call> written out in text: whole (self-closing, or closed), the skill name in group 1 when it has one.
const CALL_IN_TEXT_RE = /<call\b(?=[^>]*?\bskill="([^"]*)")[^>]*?(?:\/>|>[\s\S]*?<\/call\s*>)|<call\b[^>]*?(?:\/>|>[\s\S]*?<\/call\s*>)/gi;

/**
 * The body of a `<msg>` without the `<call>` tags written in it outside code (they never run, so
 * they are not posted either): each one is a `callInText` diagnostic (`diagnostics`); a lone
 * `<call ...>` opening is cut out too. A call in a code span or block stays as typed.
 */
function withoutCallsInText(body, diagnostics) {
  if (!/<call\b/i.test(body)) return body;
  const parts = body.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      let out = part.replace(CALL_IN_TEXT_RE, (all, skill) => {
        diagnostics.push({ kind: 'callInText', ...(skill && SKILL_NAME_RE.test(skill) ? { skill } : {}), where: 'msg' });
        return '';
      });
      out = out.replace(/<call\b[^>]*>/gi, () => {
        diagnostics.push({ kind: 'callInText', where: 'msg' });
        return '';
      });
      return out === part ? part : out.replace(/[ \t]{2,}/g, ' ');
    })
    .join('');
}

function parseIndex(value) {
  const match = /(\d+)/.exec(value ?? '');
  return match ? Number(match[1]) : null;
}

/**
 * The model's tagged output as actions. `draw` is the first non-empty
 * `<draw>`, `draws` every non-empty one in order, at most 10 (`draw` is
 * `draws[0]`, or null when there is none).
 * @param {unknown} raw
 * @param {{ maxDrawChars?: number, limits?: { add: Function }|null }} [options] `maxDrawChars`: the
 *   cap of one <draw> body, cut at a sentence or word boundary (clampAtBoundary); the live
 *   `image.maxPromptChars`, default 1600. At most 3 messages come out: every `<msg>` past the
 *   third is joined into the third, each on its own line, its text unchanged (its own reply
 *   target is dropped). `limits` (src/llm/limits.js#createLimits, optional) is told of such a
 *   join as a `message-merge` (`where: 'parse'`, `lost`: the messages joined) and of every
 *   `<msg>` (a joined one included) cut at 1900 characters as a `message-cut` (`where: 'parse'`)
 *   with the characters lost.
 * @returns {{ skip: boolean, messages: {text: string, replyTo: number|null}[],
 *             reactions: {to: number, emoji: string}[], untargetedReactions: {emoji: string}[], think: string,
 *             draw: {text: string, self: boolean, replyTo: number|null}|null,
 *             draws: {text: string, self: boolean, replyTo: number|null}[],
 *             gif: {id: string, replyTo: number|null}|null,
 *             call: {skill: string, args: Record<string, string>, body: string}|null,
 *             calls: {skill: string, args: Record<string, string>, body: string}[],
 *             extraCalls: number, callError: 'malformed'|null, thinkOpen: boolean, untagged: boolean,
 *             diagnostics: object[] }}
 *   `calls`: every well-formed top-level `<call>` in order; a malformed one never takes the others
 *   with it. `call`: the first well-formed one (its attributes but `skill` as string `args`, its body
 *   trimmed with CDATA sections unwrapped, '' when self-closing or empty; a `</call>` inside CDATA does
 *   not end it); `extraCalls`: how many well-formed ones followed it, ignored; `callError`:
 *   `malformed` when any top-level `<call>` is not well formed. `diagnostics`: what the parser did
 *   not use, in order -- `{ kind: 'badCall', reason: 'quotes'|'attribute'|'name'|'unclosed', skill? }`,
 *   `{ kind: 'callInText', skill?, where: 'msg'|'code' }` (a `<call>` written inside a `<msg>` is cut out of it;
 *   in code it stays), `{ kind: 'messageCut', chars }`, `{ kind: 'messagesMerged', count }`,
 *   `{ kind: 'thinkUnclosed' }`. `thinkOpen`: a `<think>` was never closed --
 *   silence, with what it held so far appended to `think`. `untagged`: the one message is the
 *   plain text of an answer with no tag (the fallback), not a `<msg>`.
 */
export function parseOutput(raw, { maxDrawChars = DEFAULT_MAX_DRAW_CHARS, limits = null } = {}) {
  const result = { skip: false, messages: [], reactions: [], untargetedReactions: [], think: '', draw: null, draws: [], gif: null, call: null, calls: [], extraCalls: 0, callError: null, thinkOpen: false, untagged: false, diagnostics: [] };
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

  // The top-level <call> tags come out first: their bodies are their own, never a message here.
  const calls = findCalls(text);
  if (calls.length > 0) {
    // A malformed call is a diagnostic and never empties the others: the well-formed ones stand, in order.
    result.calls = calls.map((found) => found.call).filter(Boolean);
    result.call = result.calls[0] ?? null;
    result.callError = calls.some((found) => !found.call) ? 'malformed' : null;
    result.extraCalls = Math.max(0, result.calls.length - 1);
    for (const found of calls) if (!found.call) result.diagnostics.push({ kind: 'badCall', reason: found.error, ...(found.skill ? { skill: found.skill } : {}) });
    for (const { start, end } of [...calls].reverse()) text = `${text.slice(0, start)}${text.slice(end)}`;
  }
  // A <call> inside a code span or block (anywhere) is only shown, never run: told, left as typed.
  for (const code of [...text.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g)]) {
    for (const inner of code[0].matchAll(CALL_IN_TEXT_RE)) result.diagnostics.push({ kind: 'callInText', ...(inner[1] ? { skill: inner[1] } : {}), where: 'code' });
  }

  const bodies = [];
  for (const match of text.matchAll(/<msg(\s[^>]*)?>([\s\S]*?)<\/msg>/gi)) {
    const body = withoutCallsInText(match[2], result.diagnostics).trim();
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

  if (result.messages.length === 0 && result.reactions.length === 0 && result.untargetedReactions.length === 0 && !result.draw && !result.gif && !result.call) {
    const leftover = text.replace(/<skip\s*\/?>/gi, '').trim();
    const hasTags = calls.length > 0 || /<\/?(msg|react|skip|draw|gif|call)\b/i.test(text);
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
