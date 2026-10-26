// The text transport of the tools: the description a model without native tools is given (a
// `<tools>` block body) and the parser of the calls it writes back as
// `<tool_call>{"name": "draw.create", "arguments": {...}}</tool_call>` blocks. Pure. The parser
// returns the shape of `toolCallsOf` (src/llm/openrouter.js) so the same normalisation serves both
// transports. A block is never seen inside a closed or unclosed `<think>`, a code span or a fence.

import { canonicalJson } from '../tools/tools-json.ts';
import { skillNameOfApi } from '../tools/definitions.ts';

const OPEN = '<tool_call>';
const CLOSE = '</tool_call>';

/**
 * The body of the `<tools>` block: `labels.skills.toolsText.lead`, one JSON line per tool
 * (`{ name, description, parameters }`, the dotted name, keys in canonical order, sorted by name),
 * then `labels.skills.toolsText.protocol`. '' without tools.
 * @param {object[]} tools  The native definitions (src/tools/tools-json.ts#buildTools).
 * @param {object} labels
 * @returns {string}
 */
export function toolsBlockText(tools, labels) {
  const list = Array.isArray(tools) ? tools : [];
  if (list.length === 0) return '';
  const lines = list
    .map((tool) => {
      const api = tool?.function?.name ?? '';
      return {
        name: skillNameOfApi(api) ?? api,
        description: tool?.function?.description ?? '',
        parameters: tool?.function?.parameters ?? {},
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => JSON.stringify(canonicalJson(entry)));
  const words = labels?.skills?.toolsText ?? {};
  return [words.lead, ...lines, words.protocol].filter((part) => typeof part === 'string' && part !== '').join('\n');
}

/** `text` with every span `[from, to)` of `spans` blanked to spaces (same length, same positions). */
function blank(text, spans) {
  let out = text;
  for (const [from, to] of spans) out = `${out.slice(0, from)}${' '.repeat(to - from)}${out.slice(to)}`;
  return out;
}

/** The text with what must never hold a call blanked out: closed and unclosed `<think>`, fences, code spans. */
function masked(text) {
  const spans = [];
  let at = 0;
  for (;;) {
    const from = text.indexOf('<think>', at);
    if (from === -1) break;
    const close = text.indexOf('</think>', from);
    const to = close === -1 ? text.length : close + '</think>'.length;
    spans.push([from, to]);
    at = to;
  }
  let out = blank(text, spans);
  const code = [];
  for (const match of out.matchAll(/```[\s\S]*?(?:```|$)/g)) code.push([match.index, match.index + match[0].length]);
  out = blank(out, code);
  const inline = [];
  for (const match of out.matchAll(/`[^`\n]+`/g)) inline.push([match.index, match.index + match[0].length]);
  return blank(out, inline);
}

/** The spans of the `<msg ...>` messages of `text` (an unclosed one runs to the end). */
function messageSpans(text) {
  const spans = [];
  for (const open of text.matchAll(/<msg\b[^>]*>/g)) {
    const close = text.indexOf('</msg>', open.index);
    spans.push([open.index, close === -1 ? text.length : close + '</msg>'.length]);
  }
  return spans;
}

/** The call a block's body says, or the reason it cannot be read: `{ name, arguments, parsed, parseError }`. */
function callOf(body) {
  const fail = (parseError, name = '') => ({ id: null, name, arguments: body, parsed: null, parseError });
  let value;
  try {
    value = JSON.parse(body.trim());
  } catch {
    return fail('malformed');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.name !== 'string' ||
    value.name === ''
  )
    return fail('malformed');
  let given = value.arguments;
  if (given === undefined || given === null) given = {};
  if (typeof given === 'string') {
    try {
      given = given.trim() === '' ? {} : JSON.parse(given);
    } catch {
      return fail('malformed', value.name);
    }
  }
  if (!given || typeof given !== 'object' || Array.isArray(given)) return fail('malformed', value.name);
  return { id: null, name: value.name, arguments: JSON.stringify(given), parsed: given, parseError: null };
}

/**
 * The calls written in `text` and the text without them. Each `<tool_call>...</tool_call>` at the top
 * level is one call: `{ id: null, name, arguments, parsed, parseError }`. A block inside a `<msg>` is
 * cut out and returned with `parseError: 'nested'`; an unclosed one is `truncated` when the finish
 * reason is `length`, else `unclosed`; a body that is not an object with a string `name` (and
 * `arguments` absent, an object, or a string holding one) is `malformed`. `rest` is the text with the
 * blocks removed; `diagnostics` lists each broken block as `{ kind, index }`.
 * @param {string} text
 * @param {{ finishReason?: string|null }} [options]
 * @returns {{ calls: object[], rest: string, diagnostics: { kind: string, index: number }[] }}
 */
export function parseToolCallBlocks(text, { finishReason = null } = {}) {
  const source = typeof text === 'string' ? text : '';
  const seen = masked(source);
  const messages = messageSpans(seen);
  const calls = [];
  const cuts = [];
  let at = 0;
  for (;;) {
    const from = seen.indexOf(OPEN, at);
    if (from === -1) break;
    const bodyFrom = from + OPEN.length;
    const close = source.indexOf(CLOSE, bodyFrom);
    const to = close === -1 ? source.length : close + CLOSE.length;
    const body = source.slice(bodyFrom, close === -1 ? source.length : close);
    let call;
    if (close === -1)
      call = {
        id: null,
        name: '',
        arguments: body,
        parsed: null,
        parseError: finishReason === 'length' ? 'truncated' : 'unclosed',
      };
    else {
      call = callOf(body);
      if (messages.some(([start, end]) => from > start && from < end))
        call = { ...call, parsed: null, parseError: 'nested' };
    }
    calls.push(call);
    cuts.push([from, to]);
    at = to;
  }
  let rest = '';
  let last = 0;
  for (const [from, to] of cuts) {
    rest += source.slice(last, from);
    last = to;
  }
  rest += source.slice(last);
  const diagnostics = calls
    .map((call, index) => (call.parseError ? { kind: call.parseError, index } : null))
    .filter(Boolean);
  return { calls, rest, diagnostics };
}
