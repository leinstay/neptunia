// Parses the model's tagged output (contract: prompts/format.md) into actions.
//   <think>…</think>          hidden planning, discarded
//   <msg reply="#87">…</msg>   a chat message, optionally a reply to message #87 (at most 3:
//                              any later one is joined into the third, a line each)
//   <react to="#87">💀</react> a reaction on message #87 (a custom emoji as :name: too); a tag of another
//                              action ends it, and a reaction inside a closed <msg> is cut from its words
//   <skip/>                    stay silent
// Her tool calls are not text any more: native tool calls come with the answer, and the text
// transport's `<tool_call>` blocks are cut out before this parser sees the text
// (src/llm/tool-text.ts). A leftover `<call>`, draw or `<gif>` tag (her history still holds some; a picture is the `draw.create` tool, a GIF the media pick's) is cut
// out wherever it stands outside code, never run, and told as a `retiredTag` diagnostic.
// `<audience>`, a selfreflection post's alone, is taken out before this parser runs (`takeAudience`, src/turn/phases/response.ts).
// The parser is forgiving about everything but her thinking: a missing tag wrapper falls back to a single plain
// message (`untagged`). An answer whose `<think>` is broken has no action at all and names its shape in `thinkLeak`:
// `unclosed` (a think left open, `thinkOpen`, its text so far kept in `think` for the journal) or `unopened` (a closing
// tag with no opening). A spelling of the tag other than plain `<think>` and `</think>` counts as broken, wherever it
// stands, and a think tag in code, a whole one too, so no think tag is ever in a message that comes out. The parser never repairs such an answer. It also accounts for
// what it did not use: `diagnostics`, one `{ kind, ... }` per thing it dropped, cut or joined
// (`retiredTag` with its `tag`, `msgMalformed` with its counts, `messagesMerged`, `thinkUnclosed`, `thinkUnopened`), so the
// caller can tell the persona what happened to her output (src/behavior/turn.ts).

import type { LimitsSink } from './limits.ts';

const MAX_MESSAGES = 3;
const MAX_FALLBACK_CHARS = 600;
// A reaction body: a short unicode emoji, or a custom one as `:name:` / `<a:name:id>` (src/behavior/emoji.ts).
const MAX_REACTION_CHARS = 16;
const CUSTOM_REACTION_RE = /^(?::[A-Za-z0-9_]{2,32}:|<a?:[A-Za-z0-9_]{2,32}:\d{1,25}>)$/;

// A retired tag written out in text: whole (closed or self-closing), or a lone opening. The call tag and the draw tag
// are tool calls now, and a GIF is the media pick's (src/behavior/media-pick.ts).
const RETIRED_TAGS = Object.freeze(['call', 'draw', 'gif']);
const RETIRED_TAG_RES = Object.freeze(
  Object.fromEntries(
    RETIRED_TAGS.map((tag) => [
      tag,
      [
        new RegExp(`<${tag}\\b[^>]*?/>`, 'gi'),
        new RegExp(`<${tag}\\b[^>]*?>[\\s\\S]*?</${tag}\\s*>`, 'gi'),
        new RegExp(`<${tag}\\b[^>]*>`, 'gi'),
      ],
    ])
  )
);

/**
 * `text` without the retired tags of `tags` written outside code (a code span or block keeps what
 * it shows): each one cut is a `retiredTag` diagnostic (`diagnostics`, with its `tag`). A closing
 * tag left alone is dropped too, uncounted.
 */
function withoutRetiredTags(text: string, tags: ReadonlyArray<string>, diagnostics: Array<Diagnostic>): string {
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

// What the `<msg>` boundary reads, in order: the marks of code, the two message tags and the tags of other actions.
const MSG_TOKEN_RE = /```|`|<msg(\s[^>]*)?>|<\/msg\s*>|<(?:react|skip)(?:\s[^>]*)?\/?>/gi;
const MSG_TAG_RE = /<msg(?:\s[^>]*)?>|<\/msg\s*>/gi;

/**
 * The index just past the code span that opens at `at` with `mark`, or -1 when the mark opens none: nothing closes it, an
 * inline span would run past its line, or the span starts inside one message and ends inside the next, which makes
 * the two marks stray backticks of two messages.
 */
function codeSpanEnd(text: string, at: number, mark: string): number {
  const closing = text.indexOf(mark, at + mark.length);
  if (closing === -1) return -1;
  const span = text.slice(at, closing);
  if (mark === '`' && span.includes('\n')) return -1;
  const tags = span.match(MSG_TAG_RE) ?? [];
  const crossesMessages = tags[0]?.startsWith('</') === true && tags.some((tag) => !tag.startsWith('</'));
  return crossesMessages ? -1 : closing + mark.length;
}

/** A `<msg>` read and not closed yet: its attributes, where its words start, and the first tag of another action in it. */
type OpenMessage = { attributes: string; start: number; actionAt: number | null };

/** Where a `<react>` stands in the text, from its opening tag to the end of its closing one or the tag that ended it. */
type Span = { start: number; end: number };

/** `text` from `start` to `end` without the spans inside it, a run of blanks where one stood made one. */
function withoutSpans(text: string, start: number, end: number, spans: ReadonlyArray<Span>): string {
  const inside = spans.filter((span) => span.start >= start && span.end <= end);
  if (inside.length === 0) return text.slice(start, end);
  let out = '';
  let at = start;
  for (const span of inside) {
    out += text.slice(at, span.start);
    at = span.end;
  }
  return (out + text.slice(at, end)).replace(/[ \t]{2,}/g, ' ');
}

/**
 * The messages of `text`, read tag by tag outside code, with what was wrong at their boundary. A message left open
 * ends at the next opening or with the output, and at the first tag of another action before that, so no such tag
 * lands in its words. A closed message keeps its words around a reaction in it, without the reaction (`reactions`, the
 * spans `readReactions` found). `cutOff`: the last message left open is a fragment and is dropped, uncounted.
 */
function readMessages(text: string, cutOff: boolean, reactions: ReadonlyArray<Span>) {
  const bodies: Array<{ text: string; replyTo: number | null }> = [];
  const count = { nested: 0, unclosed: 0, stray: 0 };
  let open: OpenMessage | null = null;
  const deliver = (message: OpenMessage, end: number): void => {
    const body = withoutSpans(text, message.start, end, reactions).trim();
    if (!body) return;
    const reply = /reply\s*=\s*"([^"]*)"/i.exec(message.attributes);
    bodies.push({ text: body, replyTo: reply ? parseIndex(reply[1]) : null });
  };
  const tokens = new RegExp(MSG_TOKEN_RE);
  for (let match = tokens.exec(text); match; match = tokens.exec(text)) {
    const token = match[0];
    if (token.startsWith('`')) {
      const end = codeSpanEnd(text, match.index, token);
      if (end !== -1) tokens.lastIndex = end;
    } else if (token.startsWith('</')) {
      if (open) deliver(open, match.index);
      else count.stray += 1;
      open = null;
    } else if (/^<msg/i.test(token)) {
      if (open) {
        count.nested += 1;
        deliver(open, open.actionAt ?? match.index);
      }
      open = { attributes: match[1] ?? '', start: tokens.lastIndex, actionAt: null };
    } else if (open) {
      open.actionAt ??= match.index;
    }
  }
  if (open && !cutOff) {
    count.unclosed += 1;
    deliver(open, open.actionAt ?? text.length);
  }
  return { bodies, ...count };
}

// What the `<react>` boundary reads, in order: the marks of code, the two reaction tags and the tags of other actions.
const REACT_TOKEN_RE = /```|`|<react(\s[^>]*)?>|<\/react\s*>|<\/?msg(?:\s[^>]*)?>|<skip(?:\s[^>]*)?\/?>/gi;

/**
 * The reactions of `text`, read tag by tag outside code, each with its target attributes, its emoji and its span. A
 * reaction ends at its closing tag, or at the first tag of a message, of another reaction or of `<skip/>` before that,
 * so its emoji is the text up to there and no other action's tag lands in it. A reaction that nothing ends is dropped.
 */
function readReactions(text: string): Array<Span & { attributes: string; emoji: string }> {
  const found: Array<Span & { attributes: string; emoji: string }> = [];
  let open: { attributes: string; start: number; body: number } | null = null;
  const end = (at: number, after: number): void => {
    if (open)
      found.push({
        attributes: open.attributes,
        emoji: text.slice(open.body, at).trim(),
        start: open.start,
        end: after,
      });
    open = null;
  };
  const tokens = new RegExp(REACT_TOKEN_RE);
  for (let match = tokens.exec(text); match; match = tokens.exec(text)) {
    const token = match[0];
    if (token.startsWith('`')) {
      const spanEnd = codeSpanEnd(text, match.index, token);
      if (spanEnd !== -1) tokens.lastIndex = spanEnd;
    } else if (/^<\/react/i.test(token)) {
      end(match.index, tokens.lastIndex);
    } else {
      end(match.index, match.index);
      if (/^<react/i.test(token)) open = { attributes: match[1] ?? '', start: match.index, body: tokens.lastIndex };
    }
  }
  return found;
}

/** What `takeAudience` leaves alone: a think block and code, where a tag is only being talked about. */
const AUDIENCE_EXEMPT_RE = /(<think>[\s\S]*?(?:<\/think>|$)|```[\s\S]*?(?:```|$)|`[^`\n]*`)/i;

/**
 * A selfreflection answer without its `<audience>` tags, and their bodies in order. A stray opening or closing tag counts as an
 * empty body: the caller reads that as malformed, so a tag she failed to close never reads as no restriction.
 */
export function takeAudience(raw: string): { text: string; audience: Array<string> } {
  const audience: Array<string> = [];
  const parts = raw.split(AUDIENCE_EXEMPT_RE).map((part, i) => {
    if (i % 2 === 1) return part;
    return part
      .replace(/<audience\b[^>]*>([\s\S]*?)<\/audience\s*>/gi, (_all, body: string) => {
        audience.push(body);
        return '';
      })
      .replace(/<\/?audience\b[^>]*>/gi, () => {
        audience.push('');
        return '';
      });
  });
  return { text: parts.join(''), audience };
}

function parseIndex(value: string | undefined): number | null {
  const match = /(\d+)/.exec(value ?? '');
  return match ? Number(match[1]) : null;
}

/** What the parser did not use, in order. */
export type Diagnostic =
  | { kind: 'retiredTag'; tag: string }
  | { kind: 'msgMalformed'; nested: number; unclosed: number; stray: number }
  | { kind: 'messagesMerged'; count: number }
  | { kind: 'thinkUnclosed' }
  | { kind: 'thinkUnopened' };

/** The shape of a broken `<think>`: a closing tag with no opening, or an opening never closed. */
export type ThinkLeak = 'unopened' | 'unclosed';

/** The actions the model's tagged output holds. */
export type ParsedOutput = {
  skip: boolean;
  messages: Array<{ text: string; replyTo: number | null }>;
  reactions: Array<{ to: number; emoji: string }>;
  untargetedReactions: Array<{ emoji: string }>;
  think: string;
  thinkOpen: boolean;
  thinkLeak: ThinkLeak | null;
  untagged: boolean;
  diagnostics: Array<Diagnostic>;
};

/** Any spelling of a think tag, opening or closing. */
const THINK_TAG_RE = /<\s*(\/?)\s*think\b/i;
/** One whole think, the one spelling an answer's own thinking has. */
const WHOLE_THINK_RE = /<think>([\s\S]*?)<\/think>/gi;

/** Whether `text` holds a think tag in any spelling. Outgoing text never may. */
export function hasThinkTag(text: string): boolean {
  return THINK_TAG_RE.test(text);
}

/** The shape of the broken think of a tag left over once the whole thinks are out, or null. */
function leakOfLeftover(leftover: string): ThinkLeak | null {
  const tag = THINK_TAG_RE.exec(leftover);
  if (tag === null) return null;
  return tag[1] === '/' ? 'unopened' : 'unclosed';
}

/**
 * The shape of the first think tag inside a code span or block of `raw`, or null for none. Read from the start: a whole
 * `<think>` outside code is her thinking and is passed over with the backticks in it, and a code span after it is
 * checked whole.
 */
function thinkInCode(raw: string): ThinkLeak | null {
  if (!raw.includes('`')) return null;
  const tokens = /```|`|<think>/gi;
  for (let match = tokens.exec(raw); match; match = tokens.exec(raw)) {
    const token = match[0];
    if (!token.startsWith('`')) {
      const closing = /<\/think>/gi;
      closing.lastIndex = tokens.lastIndex;
      if (closing.exec(raw) === null) return null;
      tokens.lastIndex = closing.lastIndex;
      continue;
    }
    const end = codeSpanEnd(raw, match.index, token);
    if (end === -1) continue;
    const leak = leakOfLeftover(raw.slice(match.index, end));
    if (leak !== null) return leak;
    tokens.lastIndex = end;
  }
  return null;
}

/**
 * The shape of the broken `<think>` of an answer, null for a whole one or an answer with none. A think tag in code,
 * a whole one too, is broken and has the shape of its first tag there.
 */
export function thinkLeakOf(raw: string): ThinkLeak | null {
  return thinkInCode(raw) ?? leakOfLeftover(raw.replace(WHOLE_THINK_RE, ''));
}

/**
 * An answer in the shape every stored reply has: text with no think tag at all gets an empty `<think></think>` in front.
 * An answer with no text and an answer that holds any think tag, a broken one too, stay as they are.
 */
export function shapedThink(raw: string): string {
  if (raw.trim() === '' || hasThinkTag(raw)) return raw;
  return `<think></think>${raw}`;
}

/** Whether `leftover`, the text with its whole thinks out, holds a think tag: `result` then says so and has no action. */
function markThinkLeak(result: ParsedOutput, leftover: string): boolean {
  result.thinkLeak = leakOfLeftover(leftover);
  if (result.thinkLeak === null) return false;
  result.skip = true;
  if (result.thinkLeak === 'unopened') {
    result.diagnostics.push({ kind: 'thinkUnopened' });
    return true;
  }
  const sofar = leftover
    .slice(THINK_TAG_RE.exec(leftover)?.index ?? 0)
    .replace(/^[^>]*>?/, '')
    .trim();
  result.think = [result.think, sofar].filter(Boolean).join('\n');
  result.thinkOpen = true;
  result.diagnostics.push({ kind: 'thinkUnclosed' });
  return true;
}

/**
 * The model's tagged output as actions. A picture is never read from the text: the draw tag is a
 * retired one, cut out like the call tag.
 * @param options At most 3 messages come out: every `<msg>` past the
 *   third is joined into the third, each on its own line, its text unchanged (its own reply
 *   target is dropped). `limits` (src/llm/limits.ts#createLimits, optional) is told of such a
 *   join as a `message-merge` (`where: 'parse'`, `lost`: the messages joined). A message is never
 *   cut for its length: the adapter of the interface splits a long one. `cutOff`: the answer was
 *   cut at the output cap, so a last `<msg>` left open is dropped instead of delivered.
 * @returns `diagnostics`: what the parser did not use, in order -- `{ kind: 'retiredTag', tag: 'call'|'draw'|'gif' }`
 *   (a retired tag written outside code, cut out), at most one
 *   `{ kind: 'msgMalformed', nested, unclosed, stray }` (message tags out of place, counts only),
 *   `{ kind: 'messagesMerged', count }`, `{ kind: 'thinkUnclosed' }`, `{ kind: 'thinkUnopened' }`. `thinkLeak`: the shape of a
 *   broken think, whose answer has no action. `thinkOpen`: a `<think>` was never
 *   closed, with what it held so far appended to `think`. `untagged`: the one message is the
 *   plain text of an answer with no tag (the fallback), not a `<msg>`.
 */
export function parseOutput(
  raw: unknown,
  { limits = null, cutOff = false }: { limits?: LimitsSink | null; cutOff?: boolean } = {}
): ParsedOutput {
  const result: ParsedOutput = {
    skip: false,
    messages: [],
    reactions: [],
    untargetedReactions: [],
    think: '',
    thinkOpen: false,
    thinkLeak: null,
    untagged: false,
    diagnostics: [],
  };
  let text = String(raw ?? '');

  // A think tag in code comes first: stripped as her thinking, it would leave the code around it in her words. Nothing
  // of the code moves into `think`.
  result.thinkLeak = thinkInCode(text);
  if (result.thinkLeak !== null) {
    result.skip = true;
    result.thinkOpen = result.thinkLeak === 'unclosed';
    result.diagnostics.push({ kind: result.thinkOpen ? 'thinkUnclosed' : 'thinkUnopened' });
    return result;
  }
  text = text.replace(WHOLE_THINK_RE, (all, inner) => {
    result.think += inner.trim();
    return '';
  });
  if (markThinkLeak(result, text)) return result;

  // The retired tags come out first: never a message, never run.
  text = withoutRetiredTags(text, RETIRED_TAGS, result.diagnostics);

  const reactions = readReactions(text);
  const { bodies, nested, unclosed, stray } = readMessages(text, cutOff, reactions);
  if (nested + unclosed + stray > 0) result.diagnostics.push({ kind: 'msgMalformed', nested, unclosed, stray });
  // Every message past the cap is joined into the last kept one, a line each, so no tail is
  // lost unseen; the last kept one keeps its own reply target, theirs are dropped.
  if (bodies.length > MAX_MESSAGES) {
    const extra = bodies.splice(MAX_MESSAGES);
    const last = bodies[MAX_MESSAGES - 1];
    last.text = [last.text, ...extra.map((item) => item.text)].join('\n');
    limits?.add({ kind: 'message-merge', where: 'parse', lost: extra.length });
    result.diagnostics.push({ kind: 'messagesMerged', count: extra.length });
  }
  for (const { text: body, replyTo } of bodies) result.messages.push({ text: body, replyTo });

  for (const { attributes, emoji } of reactions) {
    const target = /\bto\s*=\s*"([^"]*)"/i.exec(attributes);
    const to = target ? parseIndex(target[1]) : null;
    const fits = emoji.length <= MAX_REACTION_CHARS || CUSTOM_REACTION_RE.test(emoji);
    if (!emoji || !fits) continue;
    // A reaction that names no message is kept apart: an addressed turn ignores it, an inner turn refuses it.
    if (to !== null) result.reactions.push({ to, emoji });
    else result.untargetedReactions.push({ emoji });
  }

  if (result.messages.length === 0 && result.reactions.length === 0 && result.untargetedReactions.length === 0) {
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
 * The JSON object a strict `response_format` answer holds: `text` parsed whole, with nothing around it. Null for
 * anything else: no text, text that is not JSON (a bare word or a code fence included), or JSON that is not an object.
 */
export function strictJsonObject(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

/**
 * Parse the outermost `{...}` span of a model reply (from its first `{` to its
 * last `}`), tolerating code fences and chatter around it. Two objects in one
 * reply, or a stray `}` in trailing chatter, make the span invalid and throw.
 * @throws no `{...}` span, or one that is not valid JSON.
 */
export function parseJsonObject(raw: unknown): unknown {
  const text = String(raw ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in the model reply');
  return JSON.parse(text.slice(start, end + 1));
}
