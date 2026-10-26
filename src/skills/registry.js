// The persona's skills: one catalogue, defined by a table of their own (src/skills/definitions.js).
// Every registered operation (src/ops/registry.js) is a skill of the same name -- the vocabulary
// `/nep access grant` uses for people -- its arguments the table's `params`, its `kind` and
// `ownerOnly` the operation's. No skill exists without an operation behind it; nothing here reads
// the owner's slash commands. Every skill is closed until the owner grants it to her
// (src/skills/access.js: `/nep access grant` with her as the user); an owner-only operation runs
// only when the member who asked is an owner (src/skills/gateway.js). Their wording -- `title`,
// `whenToUse`, `whenNotToUse` -- lives in prompts/skills.json, keyed by operation name (the hot
// prompts layer, `hot.prompts.skills`), never here: `describeSkill` joins the two at the moment of
// use, and a skill without texts is shown by its name alone.

import { getOp as registryGetOp } from '../ops/registry.js';
import { EFFECT_CLASSES } from '../ops/effects.js';
import { SKILL_DEFINITIONS, validateDefinitions, optionsOfDefinition } from './definitions.js';

/** What a skill does to the world, one value per skill: its operation's effect class (src/ops/effects.js). */
export const EFFECTS = EFFECT_CLASSES;

/** `free`, or `paid`: spends balance and needs a budget (src/skills/gateway.js). */
export const COST_CLASSES = Object.freeze(['free', 'paid']);

/**
 * Whose things a skill may touch: `self-messages` (only the persona's own messages, in a
 * conversation she may act in), `allowed-conversations` (the current conversation or a text
 * channel of the served guild where the bot holds the Discord permissions the operation needs,
 * src/ops/shared.js#postingConversation), `any`, or null (no target).
 */
export const TARGETS = Object.freeze(['self-messages', 'allowed-conversations', 'any', null]);

/**
 * The skills of `definitions` as a Map name -> frozen skill: the definition plus `kind`
 * (`read`|`write`) and `ownerOnly`, inherited from the operation it runs (`getOp`); a definition
 * with no operation (tests' stand-ins) takes `kind` from its effects and `ownerOnly` false. A
 * skill with a `dispatch` (`{ op, body, options: [{ name, kind }], toOp(given) -> { op, args|null } }`:
 * how her call reaches the operation) keeps it and is marked `opBacked`; the table's `api`, `feature`
 * and `result` are kept when given. Throws -- a programming error, at startup -- on a missing or
 * repeated name, an unknown effect, cost class or target, a missing argument schema, an unknown
 * operation, or a dispatch without its `op` and `toOp`.
 * @param {object[]} [definitions]
 * @param {{ getOp?: (name: string) => ({ name: string, rights: object } | null) }} [options]
 * @returns {Map<string, object>}
 */
export function loadSkills(definitions = [], { getOp = registryGetOp } = {}) {
  const skills = new Map();
  for (const definition of definitions) {
    const { name, op } = definition ?? {};
    if (typeof name !== 'string' || !name) throw new Error('a skill needs a name');
    if (skills.has(name)) throw new Error(`skill defined twice: ${name}`);
    if (!EFFECTS.includes(definition.effects))
      throw new Error(`skill ${name}: effects must be one of ${EFFECTS.join(', ')}`);
    if (!COST_CLASSES.includes(definition.costClass)) throw new Error(`skill ${name}: costClass must be free or paid`);
    if (!TARGETS.includes(definition.targets ?? null))
      throw new Error(`skill ${name}: targets must be one of ${TARGETS.filter(Boolean).join(', ')} or null`);
    if (!definition.argsSchema || typeof definition.argsSchema !== 'object')
      throw new Error(`skill ${name}: argsSchema is required`);
    const dispatch = definition.dispatch ?? null;
    if (dispatch !== null && (typeof dispatch.op !== 'string' || typeof dispatch.toOp !== 'function'))
      throw new Error(`skill ${name}: dispatch needs an op and toOp`);

    // An operation's skill inherits both, an owner-only operation included: who may run it is the
    // requester's right (the gateway). Without an operation the kind follows the effects.
    let kind = definition.effects === 'read' ? 'read' : 'write';
    let ownerOnly = false;
    if (op !== null && op !== undefined) {
      const operation = getOp(op);
      if (!operation) throw new Error(`skill ${name}: unknown operation ${op}`);
      kind = operation.rights.kind;
      ownerOnly = operation.rights?.ownerOnly === true;
    }
    skills.set(
      name,
      Object.freeze({
        name,
        family: String(definition.family ?? name.split('.')[0]),
        op: op ?? null,
        kind,
        ownerOnly,
        argsSchema: definition.argsSchema,
        effects: definition.effects,
        sharedState: definition.sharedState === true,
        costClass: definition.costClass,
        targets: definition.targets ?? null,
        interfaceCapability: definition.interfaceCapability ?? null,
        ...(definition.api !== undefined ? { api: definition.api } : {}),
        ...(definition.feature !== undefined ? { feature: definition.feature } : {}),
        ...(definition.result !== undefined ? { result: definition.result } : {}),
        ...(dispatch ? { opBacked: true, dispatch } : {}),
      })
    );
  }
  return skills;
}

/**
 * The registry's definitions from the skills table: one per entry of `table` (validated), in
 * order, in loadSkills' shape -- `dispatch` runs the operation by name, `toOp(given)` mapping her
 * arguments to the operation's (`args` null when they map to nothing).
 * @param {object[]} [table]
 * @returns {object[]}
 */
export function definitionsOf(table = SKILL_DEFINITIONS) {
  return validateDefinitions(table).map((entry) => {
    const effects = entry.effects;
    return {
      name: entry.name,
      family: entry.name.split('.')[0],
      op: entry.op,
      argsSchema: entry.params,
      effects,
      sharedState: effects !== 'read',
      costClass: entry.costClass,
      targets: null,
      interfaceCapability: null,
      api: entry.api,
      feature: entry.feature,
      result: entry.result,
      dispatch: Object.freeze({
        op: entry.op,
        body: entry.body,
        options: Object.freeze(optionsOfDefinition(entry).map((option) => Object.freeze(option))),
        toOp(given) {
          let args = null;
          try {
            args = entry.toArgs(given ?? {});
          } catch {
            args = null;
          }
          return { op: entry.op, args: args ?? null };
        },
      }),
    };
  });
}

/**
 * The whole registry: one skill per entry of the skills table (src/skills/definitions.js), in
 * order. Throws like loadSkills. With `registered` true only the entries whose operation is
 * registered (src/ops/registry.js) are taken, as the live registry has always held only the
 * operations that exist: a process that never loaded src/ops/index.js has none.
 * @param {{ table?: object[], getOp?: Function, registered?: boolean }} [input]
 * @returns {Map<string, object>}
 */
export function buildSkills({ table = SKILL_DEFINITIONS, getOp = registryGetOp, registered = false } = {}) {
  const definitions = definitionsOf(table);
  return loadSkills(registered ? definitions.filter((definition) => getOp(definition.op)) : definitions, { getOp });
}

let loaded = null;

/**
 * Every skill against the live ops registry (buildSkills, the registered operations), loaded once on first use
 * (src/index.js calls this at start so a bad definition fails there). A load that throws is
 * not kept.
 * @returns {Map<string, object>}
 */
export function skillRegistry() {
  if (!loaded) loaded = buildSkills({ registered: true });
  return loaded;
}

/**
 * The names of the table's entries that have no skill in `registry`: an entry whose operation is
 * not registered (src/ops/registry.js) is left out of the live registry, so the start reports it
 * (src/index.js) instead of the persona silently lacking a skill.
 * @param {Map<string, object>} [registry]
 * @param {object[]} [table]
 * @returns {string[]}
 */
export function missingDefinitions(registry = skillRegistry(), table = SKILL_DEFINITIONS) {
  return table.filter((entry) => !registry.has(entry.name)).map((entry) => entry.name);
}

/** The names of every registry skill, in order: the operation names a grant to the persona may name. */
export function skillNames() {
  return [...skillRegistry().keys()];
}

/** One skill's text field from the skills layer, '' when absent or not a string. */
function textOf(texts, name, key) {
  const value = texts && typeof texts === 'object' ? texts[name]?.[key] : undefined;
  return typeof value === 'string' ? value : '';
}

/**
 * `skill` with its wording from the skills layer (`texts`: `hot.prompts.skills`, read by the
 * caller at the moment of use): `title`, `whenToUse`, `whenNotToUse`, each '' when missing.
 * @param {object} skill
 * @param {object} [texts]
 * @returns {object}
 */
export function describeSkill(skill, texts) {
  return {
    ...skill,
    title: textOf(texts, skill.name, 'title'),
    whenToUse: textOf(texts, skill.name, 'whenToUse'),
    whenNotToUse: textOf(texts, skill.name, 'whenNotToUse'),
  };
}

/**
 * The wording of `skill`'s arguments from the skills layer (`texts`: `hot.prompts.skills`, keyed
 * by name, `args` keyed by argument name): `{ <argument>: text }` for the arguments of the
 * skill that have one, a string each. {} when there are none. Nothing renders it yet.
 * @param {object} skill
 * @param {object} [texts]
 * @returns {Record<string, string>}
 */
export function skillArgTexts(skill, texts) {
  const args = texts && typeof texts === 'object' ? texts[skill?.name]?.args : undefined;
  if (!args || typeof args !== 'object') return {};
  const properties = skill?.argsSchema?.properties ?? {};
  return Object.fromEntries(
    Object.entries(args).filter(
      ([key, value]) => Object.hasOwn(properties, key) && typeof value === 'string' && value !== ''
    )
  );
}
