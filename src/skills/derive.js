// The persona's skills derived from the owner's commands: every operation of the ops registry
// (src/ops/registry.js) is a skill of the same name, its arguments the options of the slash
// command that runs it, so she calls an operation with what the owner types. Nothing here is
// copied by hand: `commandSources` reads the command tree (src/ops/catalog.js#COMMAND_TABLE)
// and finds which command leaf -- with which fixed option value -- runs each operation by asking
// the command -> operation map (src/ops/index.js#resolveCommand) with probe values; `optionsSchema`
// turns a leaf's options into the argument schema (src/skills/schema.js); `toCall` maps her
// arguments through the leaf's own option mapper, exactly as a Discord interaction is mapped.
// Pure: the table and the resolver are injected (src/ops/index.js registers them), so this module
// imports only the effect table and is tested over fakes.

import { effectOf as opEffectOf } from '../ops/effects.js';

// Raw Discord API option-type numbers (application-command-option-type), as the tree uses them:
// https://discord.com/developers/docs/interactions/application-commands
const STRING = 3;
const INTEGER = 4;
const BOOLEAN = 5;
const USER = 6;
const CHANNEL = 7;
const ROLE = 8;
const NUMBER = 10;

/** The kind of argument each option type takes; a type not listed here is not offered. */
const KIND_OF = Object.freeze({ [STRING]: 'string', [INTEGER]: 'integer', [BOOLEAN]: 'boolean', [USER]: 'user', [CHANNEL]: 'channel', [ROLE]: 'role', [NUMBER]: 'number' });

/** Discord's cap on one string option's value, used when an option sets no `max_length`. */
const STRING_MAX = 6000;

/** An opaque reference (a member, a channel, a role), resolved by the server to an id. */
const REF = Object.freeze({ type: 'string', minLength: 1, maxLength: 100 });

/** The option the body of a `<call>` fills, when the leaf has it as a string and BODY_ARGS names none. */
export const BODY_OPTION = 'text';

/**
 * The argument each skill's `<call>` body fills when the call leaves it out: the skill's main
 * text (an errand's goal, her message, a rule, a scene to draw, an item or entry to keep). A skill
 * listed with null takes no body; a skill not listed falls back to its `text` option (BODY_OPTION)
 * when its command has one as a string. The named option must be a string option of the command,
 * else the skill takes no body.
 */
export const BODY_ARGS = Object.freeze({
  'task.run': 'goal',
  'message.create': 'text',
  'message.edit': 'text',
  'rule.add': 'text',
  'draw.create': 'text',
  'learning.add': 'text',
  'lore.add': 'text',
});

/** Every leaf of `table` as `{ key, leaf }`: `<group>.<name>` or a bare `<name>`, in order. */
function leavesOf(table) {
  const out = [];
  for (const node of Array.isArray(table) ? table : []) {
    if (Array.isArray(node?.subcommands)) for (const sub of node.subcommands) out.push({ key: `${node.name}.${sub.name}`, leaf: sub });
    else if (node) out.push({ key: node.name, leaf: node });
  }
  return out;
}

/**
 * True for a yes/no option sent to Discord as a STRING with exactly the choices `true` and
 * `false` (src/ops/catalog.js#FLAG_CHOICES: Discord shows a BOOLEAN as True/False).
 */
function isFlag(option) {
  if (option?.type !== STRING || !Array.isArray(option.choices) || option.choices.length !== 2) return false;
  return option.choices.map((choice) => choice?.value).sort().join(',') === 'false,true';
}

/** The options of `leaf` the persona can give, `{ name, kind, json }` in order: the command's,
 * then the ones only her own call gives (`personaOptions`, never shown to Discord). A yes/no
 * option (isFlag) is a `boolean` argument, as a BOOLEAN one. */
function optionsOf(leaf) {
  const persona = Array.isArray(leaf?.personaOptions) ? leaf.personaOptions : [];
  return [...(Array.isArray(leaf?.options) ? leaf.options : []), ...persona]
    .filter((option) => Object.hasOwn(KIND_OF, option?.type) && typeof option.name === 'string')
    .map((option) => ({ name: option.name, kind: isFlag(option) ? 'boolean' : KIND_OF[option.type], json: option }));
}

/**
 * A discord.js-like options reader over `given` (option name -> value; a member, channel or role
 * as its id): what the leaf's `args` mapper reads, a missing option being null.
 */
function fakeOptions(given) {
  const value = (name) => (Object.hasOwn(given, name) && given[name] !== undefined ? given[name] : null);
  const ref = (name) => (value(name) === null ? null : { id: String(value(name)) });
  return {
    getString: value,
    getInteger: value,
    getNumber: value,
    getBoolean: value,
    getUser: ref,
    getChannel: ref,
    getRole: ref,
    getMember: ref,
  };
}

/** The leaf's args for `given` (its mapper over fakeOptions), or null when the mapper throws. */
function mapArgs(leaf, given) {
  try {
    return typeof leaf?.args === 'function' ? (leaf.args(fakeOptions(given)) ?? {}) : {};
  } catch {
    return null;
  }
}

/** A value of `option`'s kind a probe gives it: inside its bounds, never a real id. */
function probeValue(option) {
  switch (option.kind) {
    case 'integer':
    case 'number':
      return option.json.min_value ?? option.json.max_value ?? 1;
    case 'boolean':
      return true;
    default:
      return `\u0000${option.name}`;
  }
}

/** The operation `key` runs for `given`, or null. */
function opFor(resolve, key, leaf, given) {
  const args = mapArgs(leaf, given);
  if (!args) return null;
  const target = resolve(key, args);
  return typeof target?.op === 'string' && target.op ? target.op : null;
}

/**
 * Which command leaf runs each operation, read off the tree with probes: the leaf's key, its
 * options, the option values a call must carry to reach that operation (`fixed`: the one choice
 * that picks it, e.g. `talk action:interject`), the options it must leave out (`drop`: the one
 * whose absence picks it, e.g. `pings` without `mode`) or must give (`require`: whose presence
 * picks it, e.g. `memory affinity score`), and an option's narrowed choices (`enums`). A leaf
 * whose operation no option changes runs it with all its options. The first leaf reaching an
 * operation is its source. Throws on a leaf where two options both pick the operation (a
 * programming error the derivation cannot express).
 * @param {{ table: object[], resolve: (key: string, args: object) => ({ op?: string } | { invalid: string } | null) }} input
 * @returns {Map<string, { key: string, leaf: object, options: object[], fixed: object, drop: string[], require: string[], enums: object }>}
 */
export function commandSources({ table, resolve }) {
  const sources = new Map();
  const add = (op, source) => {
    if (op && !sources.has(op)) sources.set(op, source);
  };
  for (const { key, leaf } of leavesOf(table)) {
    const options = optionsOf(leaf);
    // The base probe: every required option given, every optional one left out.
    const base = Object.fromEntries(options.filter((option) => option.json.required === true).map((option) => [option.name, probeValue(option)]));
    const baseOp = opFor(resolve, key, leaf, base);
    const selectors = [];
    for (const option of options) {
      const values = Array.isArray(option.json.choices) && option.json.choices.length > 0 ? option.json.choices.map((choice) => choice.value) : [probeValue(option)];
      const reached = values.map((value) => ({ value, op: opFor(resolve, key, leaf, { ...base, [option.name]: value }) }));
      if (reached.some((probe) => probe.op !== baseOp)) selectors.push({ option, reached });
    }
    const source = (extra) => ({ key, leaf, options, fixed: {}, drop: [], require: [], enums: {}, ...extra });
    if (selectors.length === 0) {
      add(baseOp, source({}));
      continue;
    }
    if (selectors.length > 1) throw new Error(`command ${key}: more than one option picks the operation (${selectors.map((s) => s.option.name).join(', ')})`);
    const [{ option, reached }] = selectors;
    // Absent: the base operation, when the selector is optional.
    if (baseOp && option.json.required !== true) add(baseOp, source({ drop: [option.name] }));
    const byOp = new Map();
    for (const { value, op } of reached) if (op && op !== baseOp) byOp.set(op, [...(byOp.get(op) ?? []), value]);
    const choiced = Array.isArray(option.json.choices) && option.json.choices.length > 0;
    for (const [op, values] of byOp) {
      if (!choiced) add(op, source({ require: [option.name] }));
      else if (values.length === 1) add(op, source({ fixed: { [option.name]: values[0] } }));
      else add(op, source({ require: [option.name], enums: { [option.name]: values } }));
    }
  }
  return sources;
}

/** One option's schema: its kind, bounds and choices as the owner's command has them. */
function optionSchema(option, enumValues) {
  const json = option.json;
  // A yes/no option's choices are its boolean type, never an enum of strings.
  const choices = option.kind === 'boolean' ? null : enumValues ?? (Array.isArray(json.choices) && json.choices.length > 0 ? json.choices.map((choice) => choice.value) : null);
  let schema;
  switch (option.kind) {
    case 'string':
      schema = { type: 'string', minLength: Number.isFinite(json.min_length) ? Math.max(1, json.min_length) : 1, maxLength: Number.isFinite(json.max_length) ? json.max_length : STRING_MAX };
      break;
    case 'integer':
    case 'number':
      schema = { type: option.kind, ...(Number.isFinite(json.min_value) ? { minimum: json.min_value } : {}), ...(Number.isFinite(json.max_value) ? { maximum: json.max_value } : {}) };
      break;
    case 'boolean':
      schema = { type: 'boolean' };
      break;
    default:
      schema = { ...REF };
  }
  return choices ? { ...schema, enum: [...choices] } : schema;
}

/**
 * The argument schema of a source (commandSources'): one property per option the call may give
 * -- keyed by the option's own name, typed by its kind (a member, channel or role is a reference
 * the server resolves), with its bounds and choices -- the fixed and dropped options left out,
 * `required` as the command has it plus the options whose presence picks the operation.
 * @param {{ options: object[], fixed?: object, drop?: string[], require?: string[], enums?: object }} source
 * @returns {object}
 */
export function optionsSchema({ options, fixed = {}, drop = [], require = [], enums = {} }) {
  const properties = {};
  const required = [];
  for (const option of options) {
    if (Object.hasOwn(fixed, option.name) || drop.includes(option.name)) continue;
    properties[option.name] = optionSchema(option, enums[option.name]);
    if (option.json.required === true || require.includes(option.name)) required.push(option.name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * The command a derived skill runs: its key, the fixed option values, the options the call may
 * give (`{ name, kind }`, the fixed and dropped ones left out), the option a `<call>` body fills
 * (`bodyArgs[name]` when listed, else `text`; null when the leaf takes no such string option), and
 * `toCall(given)`: the persona's arguments (option names; ids for members, channels and roles)
 * with the fixed values, mapped through the leaf's own mapper and the command map ->
 * `{ key, args, op }`, `op` null when they reach no operation.
 */
function commandOf(name, source, resolve, bodyArgs) {
  const options = source.options
    .filter((option) => !Object.hasOwn(source.fixed, option.name) && !source.drop.includes(option.name))
    .map((option) => Object.freeze({ name: option.name, kind: option.kind }));
  const wanted = bodyArgs && Object.hasOwn(bodyArgs, name) ? bodyArgs[name] : BODY_OPTION;
  const body = typeof wanted === 'string' && options.some((option) => option.name === wanted && option.kind === 'string') ? wanted : null;
  const fixed = Object.freeze({ ...source.fixed });
  return Object.freeze({
    key: source.key,
    fixed,
    options: Object.freeze(options),
    body,
    toCall(given) {
      const args = mapArgs(source.leaf, { ...(given ?? {}), ...fixed });
      if (!args) return { key: source.key, args: null, op: null };
      const target = resolve(source.key, args);
      return { key: source.key, args: target?.args ?? args, op: typeof target?.op === 'string' ? target.op : null };
    },
  });
}

/**
 * One skill definition (src/skills/registry.js#loadSkills' shape) per operation of `ops`, in order:
 * name and operation the same, family the part before the first dot, the argument schema from
 * its command (optionsSchema), its effect class from src/ops/effects.js (`effectOf`; an operation
 * without a row: `read` or `write` by its kind), `paid` cost for a paid one, no target rule (the
 * operation's own rules and the requester's rights decide), and the `command` it runs
 * (commandOf, its body argument declared in `bodyArgs`, BODY_ARGS by default). An operation no
 * command runs is a programming error: throws.
 * @param {{ ops: { name: string, rights: object }[], sources: Map<string, object>, resolve: Function,
 *   effectOf?: (name: string) => string|null, bodyArgs?: Record<string, string|null> }} input
 * @returns {object[]}
 */
export function deriveSkillDefinitions({ ops, sources, resolve, effectOf = opEffectOf, bodyArgs = BODY_ARGS }) {
  const out = [];
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op?.name) continue;
    const source = sources?.get?.(op.name);
    if (!source) throw new Error(`operation ${op.name}: no command runs it, so no skill can be derived`);
    const effects = effectOf(op.name) ?? (op.rights?.kind === 'read' ? 'read' : 'write');
    out.push({
      name: op.name,
      family: op.name.split('.')[0],
      op: op.name,
      argsSchema: optionsSchema(source),
      effects,
      sharedState: effects !== 'read',
      costClass: effects === 'paid' ? 'paid' : 'free',
      targets: null,
      interfaceCapability: null,
      command: commandOf(op.name, source, resolve, bodyArgs),
    });
  }
  return out;
}
