// The tool calls a stored answer wrote into its text as
// `<tool_call>{"name": "draw.create", "arguments": {...}}</tool_call>` blocks. The model-request archive holds
// answers that wrote their calls this way, and src/memory/db/own-time.ts reads them. Pure. A call has the shape of
// `toolCallsOf` (src/llm/openrouter.ts). A block is never seen inside a closed or unclosed think of either name, a
// code span or a fence.

import { thinkSpans } from './parse.ts';
import { isObj } from '../tools/types.ts';
import type { ParsedToolCall } from './openrouter.ts';

const OPEN = '<tool_call>';
const CLOSE = '</tool_call>';

/** `text` with every span `[from, to)` of `spans` blanked to spaces (same length, same positions). */
function blank(text: string, spans: ReadonlyArray<readonly [number, number]>): string {
  let out = text;
  for (const [from, to] of spans) out = `${out.slice(0, from)}${' '.repeat(to - from)}${out.slice(to)}`;
  return out;
}

/**
 * The text with what must never hold a call blanked out: closed and unclosed thinks of either name
 * (src/llm/parse.ts#thinkSpans), fences, code spans.
 */
function masked(text: string): string {
  let out = blank(text, thinkSpans(text));
  const code: Array<[number, number]> = [];
  for (const match of out.matchAll(/```[\s\S]*?(?:```|$)/g)) code.push([match.index, match.index + match[0].length]);
  out = blank(out, code);
  const inline: Array<[number, number]> = [];
  for (const match of out.matchAll(/`[^`\n]+`/g)) inline.push([match.index, match.index + match[0].length]);
  return blank(out, inline);
}

/** The call a block's body says, or the reason it cannot be read: `{ name, arguments, parsed, parseError }`. */
function callOf(body: string): ParsedToolCall {
  const fail = (parseError: string, name = ''): ParsedToolCall => ({
    id: null,
    name,
    arguments: body,
    parsed: null,
    parseError,
  });
  let value: unknown;
  try {
    value = JSON.parse(body.trim());
  } catch {
    return fail('malformed');
  }
  if (!isObj(value) || typeof value.name !== 'string' || value.name === '') return fail('malformed');
  const name = value.name;
  let given: unknown = value.arguments;
  if (given === undefined || given === null) given = {};
  if (typeof given === 'string') {
    try {
      given = given.trim() === '' ? {} : JSON.parse(given);
    } catch {
      return fail('malformed', name);
    }
  }
  if (!isObj(given)) return fail('malformed', name);
  return { id: null, name, arguments: JSON.stringify(given), parsed: given, parseError: null };
}

/**
 * The calls written in `text`, in order. Each `<tool_call>...</tool_call>` is one call:
 * `{ id: null, name, arguments, parsed, parseError }`. An unclosed one runs to the end and is `unclosed`; a body that
 * is not an object with a string `name` (and `arguments` absent, an object, or a string holding one) is `malformed`.
 */
export function parseToolCallBlocks(text: string): Array<ParsedToolCall> {
  const source = typeof text === 'string' ? text : '';
  const seen = masked(source);
  const calls: Array<ParsedToolCall> = [];
  let at = 0;
  for (;;) {
    const from = seen.indexOf(OPEN, at);
    if (from === -1) break;
    const bodyFrom = from + OPEN.length;
    const close = source.indexOf(CLOSE, bodyFrom);
    const body = source.slice(bodyFrom, close === -1 ? source.length : close);
    calls.push(
      close === -1 ? { id: null, name: '', arguments: body, parsed: null, parseError: 'unclosed' } : callOf(body)
    );
    at = close === -1 ? source.length : close + CLOSE.length;
  }
  return calls;
}
