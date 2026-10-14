// The persona's skills ARE the owner's /nep commands: one catalogue. Every registered operation
// (src/ops/registry.js) is a skill of the same name -- the vocabulary `/nep access grant` uses for
// people -- derived from the slash command that runs it (src/skills/derive.js): its arguments are
// that command's options, its `kind` and `ownerOnly` the operation's. No skill exists without an
// operation behind a command. Every skill is closed until the owner grants it to her
// (src/skills/access.js: `/nep access grant` with her as the user); an owner-only operation runs
// only when the member who asked is an owner (src/skills/gateway.js). Their wording -- `title`,
// `whenToUse`, `whenNotToUse` -- lives in prompts/skills.json, keyed by operation name (the hot
// prompts layer, `hot.prompts.skills`), never here: `describeSkill` joins the two at the moment of
// use, and a skill without texts is shown by its name alone.

import { getOp as registryGetOp, listOps } from '../ops/registry.js';
import { EFFECT_CLASSES } from '../ops/effects.js';
import { deriveSkillDefinitions } from './derive.js';

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
 * derived skill keeps its `command` (src/skills/derive.js) and is marked `derived`. Throws -- a programming
 * error, at startup -- on a missing or repeated name, an unknown effect, cost class or target, a
 * missing argument schema, an unknown operation, or a command without its `toCall`.
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
    if (!EFFECTS.includes(definition.effects)) throw new Error(`skill ${name}: effects must be one of ${EFFECTS.join(', ')}`);
    if (!COST_CLASSES.includes(definition.costClass)) throw new Error(`skill ${name}: costClass must be free or paid`);
    if (!TARGETS.includes(definition.targets ?? null)) throw new Error(`skill ${name}: targets must be one of ${TARGETS.filter(Boolean).join(', ')} or null`);
    if (!definition.argsSchema || typeof definition.argsSchema !== 'object') throw new Error(`skill ${name}: argsSchema is required`);
    const command = definition.command ?? null;
    if (command !== null && (typeof command.key !== 'string' || typeof command.toCall !== 'function')) throw new Error(`skill ${name}: command needs a key and toCall`);

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
    skills.set(name, Object.freeze({
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
      ...(command ? { derived: true, command } : {}),
    }));
  }
  return skills;
}

/**
 * The whole registry: one derived skill per operation of `ops`, in order
 * (src/skills/derive.js#deriveSkillDefinitions over the command `sources` and `resolve`). Without
 * sources (no command tree registered) none. Throws like loadSkills.
 * @param {{ ops?: { name: string, rights: object }[], sources?: Map<string, object>|null, resolve?: Function|null, getOp?: Function }} [input]
 * @returns {Map<string, object>}
 */
export function buildSkills({ ops = [], sources = null, resolve = null, getOp = registryGetOp } = {}) {
  const derived = sources && typeof resolve === 'function' ? deriveSkillDefinitions({ ops, sources, resolve }) : [];
  return loadSkills(derived, { getOp });
}

let loaded = null;
let commandTree = null;

/**
 * Registers the owner's command tree the derived skills come from: `sources()` (the command
 * sources, src/skills/derive.js#commandSources, computed on first use) and `resolve(key, args)`
 * (the command -> operation map). src/ops/index.js calls it once its operations are registered;
 * the registry is rebuilt on its next use.
 * @param {{ sources: () => Map<string, object>, resolve: Function }} tree
 */
export function useCommandTree(tree) {
  commandTree = tree;
  loaded = null;
}

/**
 * Every skill against the live ops registry and the registered command tree (buildSkills),
 * loaded once on first use (the operations and the tree register themselves when
 * src/ops/index.js is imported; src/index.js calls this at start so a bad definition fails
 * there). A load that throws is not kept.
 * @returns {Map<string, object>}
 */
export function skillRegistry() {
  if (!loaded) {
    loaded = buildSkills({
      ops: listOps(),
      sources: commandTree ? commandTree.sources() : null,
      resolve: commandTree?.resolve ?? null,
    });
  }
  return loaded;
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
