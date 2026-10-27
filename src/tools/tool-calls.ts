// The pure side of a tool call (native or text transport): what her answer's calls become before
// anything runs, the narrow repair of an argument's type, and the words of a call's result.
// `normalizeCalls` turns the transport's calls (`toolCallsOf` in src/llm/openrouter.js, or
// `parseToolCallBlocks` in src/llm/tool-text.js) into records the step engine plans one by one;
// `coerceArgs` reads `"true"` as true and `"5"` as 5 where the schema says so and tells which;
// `toolResultText` is the text of the result she reads for each call;
// `coversSpeech` says whether a finished call lets the speech of its step go out. No I/O, no clock,
// no state. Every word comes from the labels; ids, names and statuses are protocol tokens.

import { fill } from '../format.js';
import { clampWithEllipsis } from '../memory/clamp.js';
import { CODE, reasonText } from './codes.ts';
import { apiNameOf } from './definitions.ts';
import type { Definition } from './definitions.ts';
import { skillRegistry } from './registry.ts';
import { skillNameOfToolCall } from './tools-json.ts';
import { isObj, objOf, textOf } from './types.ts';
import type { Obj, SkillMap } from './types.ts';

/** The statuses a result may have (src/tools/executors.ts#RESULT_STATUSES; `refused` the old word for `denied`). */
const RESULT_STATUSES = new Set([
  'ok',
  'denied',
  'not_configured',
  'invalid',
  'unknown',
  'partial',
  'failed',
  'refused',
]);

/** The label a status falls back to when its own is missing. */
const RESULT_LABEL_FALLBACK: Readonly<Record<string, string>> = Object.freeze({
  denied: 'refused',
  invalid: 'refused',
  not_configured: 'failed',
  partial: 'failed',
});

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
 * `calls` are `{ id, name, arguments, parsed, parseError }` as `toolCallsOf` and `parseToolCallBlocks` give them.
 */
export function normalizeCalls({
  calls,
  transport = 'native',
  finishReason = null,
  step = 1,
  registry = skillRegistry(),
}: {
  calls?: ReadonlyArray<unknown>;
  transport?: 'native' | 'text';
  finishReason?: string | null;
  step?: number;
  registry?: SkillMap;
} = {}): Array<NormalCall> {
  const list = Array.isArray(calls) ? (calls as ReadonlyArray<unknown>) : [];
  const used = new Set<string>();
  return list.map((entry, index) => {
    const call = objOf(entry);
    const base = typeof call.id === 'string' && call.id ? call.id : `s${step}c${index + 1}`;
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}~${n}`;
    used.add(id);
    const written = textOf(call.name);
    const dotted = transport === 'text' ? written : skillNameOfToolCall(written);
    const known = dotted !== null && dotted !== '' && registry.has(dotted);
    const name = known ? dotted : written;
    let problem: NormalCall['problem'] = null;
    if (finishReason === 'length') problem = 'truncated-call';
    else if (call.parseError === 'truncated') problem = 'truncated-call';
    else if (typeof call.parseError === 'string' && call.parseError) problem = 'malformed-call';
    else if (!known) problem = 'unknown-skill';
    const apiName = transport === 'text' ? (known ? (apiNameOf(name) ?? name) : written) : written;
    return {
      id,
      index,
      name,
      apiName,
      raw: textOf(call.arguments),
      args: objOf(call.parsed),
      problem,
    };
  });
}

/** One call of her answer as the step engine plans it. */
export type NormalCall = {
  id: string;
  index: number;
  name: string;
  apiName: string;
  raw: string;
  args: Obj;
  problem: 'truncated-call' | 'malformed-call' | 'unknown-skill' | null;
};

/**
 * The narrow repair of the top-level arguments against `schema`: a string `"true"`/`"false"` (any
 * case, trimmed) for a boolean, a string of digits for an integer, a decimal string for a number.
 * Anything else stays as she wrote it, so the schema check refuses it (`"yes"`, `"1"` for a boolean,
 * `null`, a nested value). Never mutates `args`.
 * `schema` is the skill's `argsSchema`.
 */
export function coerceArgs(
  args: unknown,
  schema: unknown
): { args: unknown; coerced: Array<{ arg: string; to: boolean | number }> } {
  if (!isObj(args)) return { args, coerced: [] };
  const properties = objOf(objOf(schema).properties);
  const out: Obj = { ...args };
  const coerced: Array<{ arg: string; to: boolean | number }> = [];
  for (const [arg, value] of Object.entries(args)) {
    if (typeof value !== 'string' || !Object.hasOwn(properties, arg)) continue;
    const type = objOf(properties[arg]).type;
    const text = value.trim();
    let to: boolean | number | undefined;
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
 * What she reads for one call: the `labels.tools.result` line of its status (the status carried in
 * the words) with `{reason}` filled from `labels.tools.result.reasons[<code>]` (else `.other`, else
 * the code), then the call's data cut to `maxChars`; before them, one `labels.tools.result.coerced`
 * line (`{arg}`, `{value}`) per argument that was read in another type. '' for no result.
 * @param {{ status?: string, code?: string|null, reason?: string|null, values?: object|null, data?: { text?: string, rows?: object[] }|null }|null} result
 * @param {object} labels
 * @param {{ maxChars?: number, coerced?: { arg: string, to: unknown }[], rowsText?: (rows: object[], labels: object) => string, reasonOf?: (result: object) => string }} [options]
 *   `rowsText` renders the rows of a catalogue answer (src/behavior/prompt.js#skillsInventoryText); without it they are JSON.
 *   `reasonOf` words a call that did not work in detail (the argument that was wrong, what the skill takes: src/format.js#callReason
 *   over src/tools/executors.ts#outcomeDetail); '' or absent: the code's own words.
 */
export function toolResultText(
  result: unknown,
  labels: unknown,
  {
    maxChars = 2000,
    coerced = [],
    rowsText = null,
    reasonOf = null,
  }: {
    maxChars?: number;
    coerced?: ReadonlyArray<{ arg: string; to: unknown }>;
    rowsText?: ((rows: Array<unknown>, labels: unknown) => string) | null;
    reasonOf?: ((result: Obj) => string) | null;
  } = {}
): string {
  if (!isObj(result)) return '';
  const status = typeof result.status === 'string' && RESULT_STATUSES.has(result.status) ? result.status : 'failed';
  const words = objOf(objOf(objOf(labels).tools).result);
  const reasons = objOf(words.reasons);
  const code = typeof result.code === 'string' && result.code ? result.code : '';
  const values = isObj(result.values) ? result.values : null;
  // A deleted message is its own reason of `unknown-message` (the machine reason names it).
  const worded =
    (result.reason === CODE.MESSAGE_DELETED ? reasonText(labels, CODE.MESSAGE_DELETED, values, fill) : null) ??
    reasonText(labels, code, values, fill);
  const detailed = typeof reasonOf === 'function' && status !== 'ok' ? reasonOf(result) : '';
  const other = typeof reasons.other === 'string' ? reasons.other : code;
  const reason = detailed || (worded ?? other);
  const own = words[status];
  const fallbackKey = RESULT_LABEL_FALLBACK[status];
  const word = typeof own === 'string' ? own : fallbackKey === undefined ? undefined : words[fallbackKey];
  const lead = typeof word === 'string' ? fill(word, { reason }) : '';
  let data = '';
  const body = objOf(result.data);
  if (isObj(result.data)) {
    data = Array.isArray(body.rows)
      ? typeof rowsText === 'function'
        ? rowsText(body.rows as Array<unknown>, labels)
        : JSON.stringify(body.rows)
      : textOf(body.text);
    if (Number.isFinite(maxChars) && maxChars > 0) data = clampWithEllipsis(data, maxChars);
  }
  const coercedWord = words.coerced;
  const told =
    typeof coercedWord === 'string' && coercedWord
      ? (Array.isArray(coerced) ? coerced : []).map((item) =>
          fill(coercedWord, {
            arg: item.arg,
            value:
              typeof item.to === 'string' || typeof item.to === 'number' || typeof item.to === 'boolean'
                ? String(item.to)
                : '',
          })
        )
      : [];
  // What the engine noticed about a call that went through (a tag that named nobody), after the result.
  const note = typeof result.note === 'string' ? result.note : '';
  return [...told, [lead, data, note].filter(Boolean).join('\n') || code].filter(Boolean).join('\n');
}

/**
 * Whether a finished call lets the speech of its step go out: it worked (`ok`) and its definition's
 * `result` is `effect` (a post, a reaction, a finished picture) or `job` (an errand handed off); a
 * `data` result never does, because she has to read it first.
 */
export function coversSpeech(
  definition: Pick<Definition, 'result'> | null | undefined,
  result: { status?: string } | null | undefined
): boolean {
  return result?.status === 'ok' && (definition?.result === 'effect' || definition?.result === 'job');
}

/**
 * Which transport a turn's tools travel on: `tools.transport` (`'native'` or `'text'`, read once at the
 * turn's start and kept for the whole turn). Anything else is the default, `'native'`. Pure.
 * `config` is the live config.
 */
export function transportOf(config: unknown): 'native' | 'text' {
  return objOf(objOf(config).tools).transport === 'text' ? 'text' : 'native';
}
