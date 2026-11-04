// Parses the model's tagged output (contract: prompts/format.md) into actions.
//   <think>…</think>          hidden planning, discarded
//   <msg reply="#87">…</msg>   a chat message, optionally a reply to message #87 (at most 3:
//                              any later one is joined into the third, a line each)
//   <react to="#87">💀</react> a reaction on message #87 (a custom emoji as :name: too)
//   <gif reply="#87">g12</gif> a GIF from the library by its handle (first valid one only)
//   <skip/>                    stay silent
// Her tool calls are not text any more: native tool calls come with the answer, and the text
// transport's `<tool_call>` blocks are cut out before this parser sees the text
// (src/llm/tool-text.ts). A leftover `<call>` or draw tag (her history still holds some; a picture is the `draw.create` tool now) is cut
// out wherever it stands outside code, never run, and told as a `retiredTag` diagnostic.
// `<audience>`, a diary post's alone, is taken out before this parser runs (`takeAudience`, src/turn/phases/response.ts).
// The parser is forgiving: a missing tag wrapper falls back to a single plain
// message (`untagged`), an unterminated <think> (output cut by max_tokens) means
// silence (`thinkOpen`, its text so far kept in `think` for the journal). It also accounts for
// what it did not use: `diagnostics`, one `{ kind, ... }` per thing it dropped, cut or joined
// (`retiredTag` with its `tag`, `msgMalformed` with its counts, `messagesMerged`, `thinkUnclosed`), so the
// caller can tell the persona what happened to her output (src/behavior/turn.ts).

import type { LimitsSink } from './limits.ts';

const MAX_MESSAGES = 3;
const MAX_FALLBACK_CHARS = 600;
// A reaction body: a short unicode emoji, or a custom one as `:name:` / `<a:name:id>` (src/behavior/emoji.ts).
const MAX_REACTION_CHARS = 16;
const CUSTOM_REACTION_RE = /^(?::[A-Za-z0-9_]{2,32}:|<a?:[A-Za-z0-9_]{2,32}:\d{1,25}>)$/;
// A GIF handle (src/memory/gifs.ts): `g` and digits, any case.
const GIF_HANDLE_RE = /^g(\d{1,9})$/i;

// A retired tag written out in text: whole (closed or self-closing), or a lone opening. Two kinds, the
// call tag and the draw tag: both are tool calls now.
const RETIRED_TAGS = Object.freeze(['call', 'draw']);
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
const MSG_TOKEN_RE = /```|`|<msg(\s[^>]*)?>|<\/msg\s*>|<(?:react|gif|skip)(?:\s[^>]*)?\/?>/gi;
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

/**
 * The messages of `text`, read tag by tag outside code, with what was wrong at their boundary. A message left open
 * ends at the next opening or with the output, and at the first tag of another action before that, so no such tag
 * lands in its words. `cutOff`: the last message left open is a fragment and is dropped, uncounted.
 */
function readMessages(text: string, cutOff: boolean) {
  const bodies: Array<{ text: string; replyTo: number | null }> = [];
  const count = { nested: 0, unclosed: 0, stray: 0 };
  let open: OpenMessage | null = null;
  const deliver = (message: OpenMessage, end: number): void => {
    const body = text.slice(message.start, end).trim();
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

/** What `takeAudience` leaves alone: a think block and code, where a tag is only being talked about. */
const AUDIENCE_EXEMPT_RE = /(<think>[\s\S]*?(?:<\/think>|$)|```[\s\S]*?(?:```|$)|`[^`\n]*`)/i;

/**
 * A diary answer without its `<audience>` tags, and their bodies in order. A stray opening or closing tag counts as an
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
  | { kind: 'thinkUnclosed' };

/** The actions the model's tagged output holds. */
export type ParsedOutput = {
  skip: boolean;
  messages: Array<{ text: string; replyTo: number | null }>;
  reactions: Array<{ to: number; emoji: string }>;
  untargetedReactions: Array<{ emoji: string }>;
  think: string;
  gif: { id: string; replyTo: number | null } | null;
  thinkOpen: boolean;
  untagged: boolean;
  diagnostics: Array<Diagnostic>;
};

/**
 * The model's tagged output as actions. A picture is never read from the text: the draw tag is a
 * retired one, cut out like the call tag.
 * @param options At most 3 messages come out: every `<msg>` past the
 *   third is joined into the third, each on its own line, its text unchanged (its own reply
 *   target is dropped). `limits` (src/llm/limits.ts#createLimits, optional) is told of such a
 *   join as a `message-merge` (`where: 'parse'`, `lost`: the messages joined). A message is never
 *   cut for its length: the adapter of the interface splits a long one. `cutOff`: the answer was
 *   cut at the output cap, so a last `<msg>` left open is dropped instead of delivered.
 * @returns `diagnostics`: what the parser did not use, in order -- `{ kind: 'retiredTag', tag: 'call'|'draw' }`
 *   (a retired tag written outside code, cut out), at most one
 *   `{ kind: 'msgMalformed', nested, unclosed, stray }` (message tags out of place, counts only),
 *   `{ kind: 'messagesMerged', count }`, `{ kind: 'thinkUnclosed' }`. `thinkOpen`: a `<think>` was never
 *   closed -- silence, with what it held so far appended to `think`. `untagged`: the one message is the
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
    gif: null,
    thinkOpen: false,
    untagged: false,
    diagnostics: [],
  };
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

  // The retired tags come out first: never a message, never run.
  text = withoutRetiredTags(text, RETIRED_TAGS, result.diagnostics);

  const { bodies, nested, unclosed, stray } = readMessages(text, cutOff);
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

  for (const match of text.matchAll(/<gif(\s[^>]*)?>([\s\S]*?)<\/gif>/gi)) {
    const handle = GIF_HANDLE_RE.exec(match[2].trim());
    if (!handle) continue;
    const reply = /reply\s*=\s*"([^"]*)"/i.exec(match[1] ?? '');
    result.gif = { id: `g${Number(handle[1])}`, replyTo: reply ? parseIndex(reply[1]) : null };
    break;
  }

  if (
    result.messages.length === 0 &&
    result.reactions.length === 0 &&
    result.untargetedReactions.length === 0 &&
    !result.gif
  ) {
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
 * @throws no `{...}` span, or one that is not valid JSON.
 */
export function parseJsonObject(raw: unknown): unknown {
  const text = String(raw ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in the model reply');
  return JSON.parse(text.slice(start, end + 1));
}
