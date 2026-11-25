// The pure side of a tool call: what the persona's answer's calls become before anything runs, the narrow
// repair of an argument's type, and the words of a call's result.
// `normalizeCalls` turns the completion's calls (`toolCallsOf` in src/llm/openrouter.ts) into records
// the step engine plans one by one;
// `coerceArgs` reads `"true"` as true and `"5"` as 5 where the schema says so and tells which;
// `toolResultText` is the text of the result the persona reads for each call;
// `coversSpeech` says whether a finished call lets the speech of its step go out. No I/O, no clock,
// no state. Every word comes from the labels; ids, names and statuses are protocol tokens.

import { fill, mediaMarkTags } from '../format.ts';
import { clampWithEllipsis } from '../memory/clamp.ts';
import { reasonText } from './codes.ts';
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
/** What a provider's tool-call schema takes for a function name: a name outside it fails the whole request with a 400. */
const CALL_NAME = /^[a-zA-Z0-9_.-]*$/;
/** The longest function name the providers take. */
const CALL_NAME_CHARS = 64;

/** A name the provider and a result's attributes can carry: every run of other characters becomes one `_`. */
const carriableName = (written: string): string => written.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, CALL_NAME_CHARS);

/**
 * The calls of one answer as records, in the persona's order: `{ id, index, name, apiName, raw, args, problem }`.
 * `id` is the persona's, made unique within the answer (a repeat gets `~2`, `~3`, ...) or `s<step>c<n>` when
 * they gave none; `index` their position, from 0; `name` the dotted skill name (the API name mapped
 * back), or what they wrote when no skill has it; `apiName` the name the call carries; `raw` their
 * arguments as text; `args`
 * the parsed object (`{}` when there is none); `problem` null or one of `truncated-call` (the answer
 * ran out of room: every call), `malformed-call` (the arguments could not be read, or the name holds a quote, a space or
 * anything else no tool name holds; `name` and `apiName` then carry it with those characters replaced), `unknown-skill`.
 * `calls` are `{ id, name, arguments, parsed, parseError }` as `toolCallsOf` gives them.
 */
export function normalizeCalls({
  calls,
  finishReason = null,
  step = 1,
  registry = skillRegistry(),
  procedures = null,
}: {
  calls?: ReadonlyArray<unknown>;
  finishReason?: string | null;
  step?: number;
  registry?: SkillMap;
  /** The names of the persona's skills the tools array offered: a call of one is known under the skill's name. */
  procedures?: ReadonlyMap<string, unknown> | null;
} = {}): Array<NormalCall> {
  const list = Array.isArray(calls) ? (calls as ReadonlyArray<unknown>) : [];
  const used = new Set<string>();
  return list.map((entry, index) => {
    const call = objOf(entry);
    const base = typeof call.id === 'string' && call.id ? call.id : `s${step}c${index + 1}`;
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}~${n}`;
    used.add(id);
    const given = textOf(call.name);
    const isBrokenName = !CALL_NAME.test(given);
    const written = isBrokenName ? carriableName(given) : given;
    const { known, procedure } = isBrokenName
      ? { known: false, procedure: false }
      : knownName(written, { registry, procedures });
    const name = known && !procedure ? (skillNameOfToolCall(written) ?? written) : written;
    let problem: NormalCall['problem'] = null;
    if (finishReason === 'length') problem = 'truncated-call';
    else if (isBrokenName || (typeof call.parseError === 'string' && call.parseError)) problem = 'malformed-call';
    else if (!known) problem = 'unknown-skill';
    return {
      id,
      index,
      name,
      apiName: written,
      raw: textOf(call.arguments),
      args: objOf(call.parsed),
      problem,
    };
  });
}

/**
 * Whether a well-formed call name names something the persona may call: one of their skills the tools array offered, under the
 * skill's name, or a registered tool by its API name.
 */
function knownName(
  written: string,
  { registry, procedures }: { registry: SkillMap; procedures: ReadonlyMap<string, unknown> | null }
): { known: boolean; procedure: boolean } {
  if (procedures?.has(written) === true) return { known: true, procedure: true };
  const dotted = skillNameOfToolCall(written);
  return { known: dotted !== null && dotted !== '' && registry.has(dotted), procedure: false };
}

/** One call of the persona's answer as the step engine plans it. */
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
 * Anything else stays as the persona wrote it, so the schema check refuses it (`"yes"`, `"1"` for a boolean,
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
 * `data` cut to `maxChars` with an ellipsis, followed on a line of its own by `labels.task.step.cut` when anything was
 * cut; as it was when it fits or `maxChars` is no positive number.
 */
function cutAtLimit(data: string, maxChars: number, labels: unknown): string {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return data;
  const kept = clampWithEllipsis(data, maxChars);
  if (Array.from(data.trim()).length <= maxChars) return kept;
  const { cut } = objOf(objOf(objOf(labels).task).step);
  return typeof cut === 'string' && cut !== '' ? `${kept}\n${cut}` : kept;
}

/**
 * The words of a machine reason that has words of its own in `labels.tools.result.reasons`, read over the code: a
 * deleted message under `unknown-message`, the publication boundary under `not-allowed`. Null for a reason with none.
 */
function machineWords(
  reason: unknown,
  code: string,
  labels: unknown,
  values: Record<string, unknown> | null
): string | null {
  if (typeof reason !== 'string' || reason === '' || reason === code) return null;
  const reasons = objOf(objOf(objOf(objOf(labels).tools).result).reasons);
  return Object.hasOwn(reasons, reason) ? reasonText(labels, reason, values, fill) : null;
}

/**
 * What the persona's eyes saw of a picture they drew (src/turn/draw-gif.ts), after a result's data and outside its cap:
 * `data.description` through `labels.tools.result.seen`, a failed look through `.unseen`, else ''; then the marks of
 * their picture (`data.made`, `data.depicted`: src/format.ts#mediaMarkTags).
 */
function seenLine(body: Obj, labels: unknown): string {
  const words = objOf(objOf(objOf(labels).tools).result);
  const seen =
    typeof body.description === 'string' && typeof words.seen === 'string'
      ? fill(words.seen, { description: body.description })
      : body.descriptionFailed === true && typeof words.unseen === 'string'
        ? words.unseen
        : '';
  return [seen, ...mediaMarkTags(body, labels)].filter(Boolean).join(' ');
}

/**
 * What the persona reads for one call: the `labels.tools.result` line of its status (the status carried in
 * the words) with `{reason}` filled from `labels.tools.result.reasons[<code>]` (else `.other`, else
 * the code), then the call's data cut to `maxChars` (with the `labels.task.step.cut` line when it was cut), then what their eyes saw of a drawn picture (`labels.tools.result.seen`, `{description}`, or `.unseen` for
 * `data.descriptionFailed`), then the call's `memory` whole; before them, one `labels.tools.result.coerced`
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
  const worded = machineWords(result.reason, code, labels, values) ?? reasonText(labels, code, values, fill);
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
    data = cutAtLimit(data, maxChars, labels);
  }
  const seen = seenLine(body, labels);
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
  // What the persona's memory holds of the people of a read (src/turn/in-turn-tools.ts), after the data and outside its cap:
  // the graph reader cut it to the memory's budget already. What the engine noticed about a call comes last.
  const tail = [result.memory, result.note].filter((part): part is string => typeof part === 'string');
  return [...told, [lead, data, seen, ...tail].filter(Boolean).join('\n') || code].filter(Boolean).join('\n');
}

/**
 * Whether a finished call lets the speech of its step go out: it worked (`ok`) and its definition's
 * `result` is `effect` (a post, a reaction, a finished picture) or `job` (an errand handed off); a
 * `data` result never does, because the persona has to read it first.
 */
export function coversSpeech(
  definition: { result?: Definition['result'] } | null | undefined,
  result: { status?: string } | null | undefined
): boolean {
  return result?.status === 'ok' && (definition?.result === 'effect' || definition?.result === 'job');
}
