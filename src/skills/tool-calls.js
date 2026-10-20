// The pure side of a tool call (native or text transport): what her answer's calls become before
// anything runs, the narrow repair of an argument's type, and the words of a call's result.
// `normalizeCalls` turns the transport's calls (`toolCallsOf` in src/llm/openrouter.js, or
// `parseToolCallBlocks` in src/llm/tool-text.js) into records the step engine plans one by one;
// `coerceArgs` reads `"true"` as true and `"5"` as 5 where the schema says so and tells which;
// `toolResultText` is the body of the result she reads for each call (the `<result>` block's body of
// the old loop, moved here; the old block stays in src/behavior/prompt.js until the cutover);
// `coversSpeech` says whether a finished call lets the speech of its step go out. No I/O, no clock,
// no state. Every word comes from the labels; ids, names and statuses are protocol tokens.

import { fill } from '../format.js';
import { clampWithEllipsis } from '../memory/clamp.js';
import { isPlainObject } from '../config.js';
import { CODE, reasonText } from './codes.js';
import { apiNameOf } from './definitions.js';
import { skillRegistry } from './registry.js';
import { skillNameOfToolCall } from './tools-json.js';

/** The statuses a result may have (src/skills/executors.js#RESULT_STATUSES; `refused` the old word for `denied`). */
const RESULT_STATUSES = new Set(['ok', 'denied', 'not_configured', 'invalid', 'unknown', 'partial', 'failed', 'refused']);

/** The label a status falls back to when its own is missing. */
const RESULT_LABEL_FALLBACK = Object.freeze({ denied: 'refused', invalid: 'refused', not_configured: 'failed', partial: 'failed' });

const INTEGER_TEXT = /^-?\d+$/;
const NUMBER_TEXT = /^-?\d+(?:\.\d+)?$/;
const BOOLEAN_TEXT = /^(?:true|false)$/i;

/**
 * The calls of one answer as records, in her order: `{ id, index, name, apiName, raw, args, problem }`.
 * `id` is hers, made unique within the answer (a repeat gets `~2`, `~3`, ...) or `s<step>c<n>` when
 * she gave none; `index` her position, from 0; `name` the dotted skill name (the native transport's
 * API name mapped back; the text transport's name as written, no repair), or what she wrote when no
 * skill has it; `apiName` the name the native transport carries; `raw` her arguments as text; `args`
 * the parsed object (`{}` when there is none); `problem` null or one of `truncated-call` (the answer
 * ran out of room: every call), `malformed-call` (the arguments could not be read), `unknown-skill`.
 * @param {{ calls?: object[], transport?: 'native'|'text', finishReason?: string|null, step?: number, registry?: Map<string, object> }} input
 *   `calls`: `{ id, name, arguments, parsed, parseError }` as `toolCallsOf` and `parseToolCallBlocks` give them.
 * @returns {{ id: string, index: number, name: string, apiName: string, raw: string, args: object, problem: string|null }[]}
 */
export function normalizeCalls({ calls, transport = 'native', finishReason = null, step = 1, registry = skillRegistry() } = {}) {
  const list = Array.isArray(calls) ? calls : [];
  const used = new Set();
  return list.map((call, index) => {
    const base = typeof call?.id === 'string' && call.id ? call.id : `s${step}c${index + 1}`;
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}~${n}`;
    used.add(id);
    const written = typeof call?.name === 'string' ? call.name : '';
    const dotted = transport === 'text' ? written : skillNameOfToolCall(written);
    const known = dotted !== null && dotted !== '' && registry.has(dotted);
    const name = known ? dotted : written;
    let problem = null;
    if (finishReason === 'length') problem = 'truncated-call';
    else if (call?.parseError === 'truncated') problem = 'truncated-call';
    else if (typeof call?.parseError === 'string' && call.parseError) problem = 'malformed-call';
    else if (!known) problem = 'unknown-skill';
    const apiName = transport === 'text' ? (known ? apiNameOf(name) ?? name : written) : written;
    return {
      id,
      index,
      name,
      apiName,
      raw: typeof call?.arguments === 'string' ? call.arguments : '',
      args: isPlainObject(call?.parsed) ? call.parsed : {},
      problem,
    };
  });
}

/**
 * The narrow repair of the top-level arguments against `schema`: a string `"true"`/`"false"` (any
 * case, trimmed) for a boolean, a string of digits for an integer, a decimal string for a number.
 * Anything else stays as she wrote it, so the schema check refuses it (`"yes"`, `"1"` for a boolean,
 * `null`, a nested value). Never mutates `args`.
 * @param {object} args
 * @param {object} schema  The skill's `argsSchema`.
 * @returns {{ args: object, coerced: { arg: string, to: boolean|number }[] }}
 */
export function coerceArgs(args, schema) {
  if (!isPlainObject(args)) return { args, coerced: [] };
  const properties = isPlainObject(schema?.properties) ? schema.properties : {};
  const out = { ...args };
  const coerced = [];
  for (const [arg, value] of Object.entries(args)) {
    if (typeof value !== 'string' || !Object.hasOwn(properties, arg)) continue;
    const type = properties[arg]?.type;
    const text = value.trim();
    let to;
    if (type === 'boolean' && BOOLEAN_TEXT.test(text)) to = text.toLowerCase() === 'true';
    else if (type === 'integer' && INTEGER_TEXT.test(text) && Number.isSafeInteger(Number(text))) to = Number(text);
    else if (type === 'number' && NUMBER_TEXT.test(text)) to = Number(text);
    if (to === undefined) continue;
    out[arg] = to;
    coerced.push({ arg, to });
  }
  return { args: out, coerced };
}

/**
 * What she reads for one call: the `labels.skills.result` line of its status (the status carried in
 * the words) with `{reason}` filled from `labels.skills.result.reasons[<code>]` (else `.other`, else
 * the code), then the call's data cut to `maxChars`; before them, one `labels.skills.result.coerced`
 * line (`{arg}`, `{value}`) per argument that was read in another type. '' for no result.
 * @param {{ status?: string, code?: string|null, reason?: string|null, values?: object|null, data?: { text?: string, rows?: object[] }|null }|null} result
 * @param {object} labels
 * @param {{ maxChars?: number, coerced?: { arg: string, to: unknown }[], rowsText?: (rows: object[], labels: object) => string }} [options]
 *   `rowsText` renders the rows of a catalogue answer (src/behavior/prompt.js#skillsInventoryText); without it they are JSON.
 * @returns {string}
 */
export function toolResultText(result, labels, { maxChars = 2000, coerced = [], rowsText = null } = {}) {
  if (!isPlainObject(result)) return '';
  const status = RESULT_STATUSES.has(result.status) ? result.status : 'failed';
  const words = isPlainObject(labels?.skills?.result) ? labels.skills.result : {};
  const reasons = isPlainObject(words.reasons) ? words.reasons : {};
  const code = typeof result.code === 'string' && result.code ? result.code : '';
  // A deleted message is its own reason of `unknown-message` (the machine reason names it).
  const worded = (result.reason === CODE.MESSAGE_DELETED ? reasonText(labels, CODE.MESSAGE_DELETED, result.values, fill) : null) ?? reasonText(labels, code, result.values, fill);
  const reason = worded ?? reasons.other ?? code;
  const word = typeof words[status] === 'string' ? words[status] : words[RESULT_LABEL_FALLBACK[status]];
  const lead = typeof word === 'string' ? fill(word, { reason }) : '';
  let data = '';
  if (result.data) {
    data = Array.isArray(result.data.rows)
      ? (typeof rowsText === 'function' ? rowsText(result.data.rows, labels) : JSON.stringify(result.data.rows))
      : String(result.data.text ?? '');
    if (Number.isFinite(maxChars) && maxChars > 0) data = clampWithEllipsis(data, maxChars);
  }
  const told = typeof words.coerced === 'string' && words.coerced
    ? (Array.isArray(coerced) ? coerced : []).map((item) => fill(words.coerced, { arg: item.arg, value: String(item.to) }))
    : [];
  return [...told, [lead, data].filter(Boolean).join('\n') || code].filter(Boolean).join('\n');
}

/**
 * Whether a finished call lets the speech of its step go out: it worked (`ok`) and its definition's
 * `result` is `effect` (a post, a reaction, a finished picture) or `job` (an errand handed off); a
 * `data` result never does, because she has to read it first.
 * @param {{ result?: string }|null|undefined} definition
 * @param {{ status?: string }|null|undefined} result
 * @returns {boolean}
 */
export function coversSpeech(definition, result) {
  return result?.status === 'ok' && (definition?.result === 'effect' || definition?.result === 'job');
}
