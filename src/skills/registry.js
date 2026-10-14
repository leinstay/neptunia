// The persona's skills: what she may do through the engine, named in an interface-neutral way
// (conversation, message, member) so a Discord adapter can be swapped later. A skill either runs
// one operation of the ops registry (src/ops/registry.js), from which it inherits `kind` and
// `ownerOnly`, or is an interface skill (`op: null`) an adapter implements later. Its wording --
// `title`, `whenToUse`, `whenNotToUse` -- lives in prompts/skills.json (the hot prompts layer,
// `hot.prompts.skills`), never here: `describeSkill` joins the two at the moment of use.
// Loading refuses a skill on an owner-only operation: no allow ever opens what only an owner may
// run. Phase 0: nothing here executes; src/skills/gateway.js answers whether a call may run.

import { getOp as registryGetOp } from '../ops/registry.js';

/** What a skill does to the world, one value per skill. */
export const EFFECTS = Object.freeze(['read', 'send', 'edit', 'delete', 'generate', 'shared-write']);

/** `free`, or `paid`: spends balance and needs a budget (src/skills/gateway.js). */
export const COST_CLASSES = Object.freeze(['free', 'paid']);

/**
 * Whose things a skill may touch: `self-messages` (only the persona's own messages, in a
 * conversation she may act in), `allowed-conversations` (the current conversation or one of
 * `skills.conversations`), `any`, or null (no target).
 */
export const TARGETS = Object.freeze(['self-messages', 'allowed-conversations', 'any', null]);

/** An opaque reference (conversation, message, member) as an argument. */
const REF = Object.freeze({ type: 'string', minLength: 1, maxLength: 100 });
/** A message body (Discord's cap on one message). */
const TEXT = Object.freeze({ type: 'string', minLength: 1, maxLength: 2000 });
/** One reaction emoji: a unicode emoji or a custom emoji's reference. */
const EMOJI = Object.freeze({ type: 'string', minLength: 1, maxLength: 100 });

/** An object schema with `properties`, `required` and no other key. */
function objectSchema(properties = {}, required = [], extra = {}) {
  return { type: 'object', properties, required, additionalProperties: false, ...extra };
}

/**
 * The structural definitions of the skills of phases 0-1 (docs: the skills design), in catalogue
 * order. No wording: the texts are prompts/skills.json's under the same names.
 */
export const SKILL_DEFINITIONS = Object.freeze([
  {
    name: 'message.send',
    family: 'message',
    op: null,
    argsSchema: objectSchema(
      { conversationId: REF, text: TEXT, replyTo: REF, media: { type: 'string', minLength: 1, maxLength: 200 } },
      [],
      { anyOf: [{ required: ['text'] }, { required: ['media'] }] },
    ),
    effects: 'send',
    sharedState: false,
    costClass: 'free',
    targets: 'allowed-conversations',
    interfaceCapability: 'message.send',
  },
  {
    name: 'message.edit',
    family: 'message',
    op: null,
    argsSchema: objectSchema({ conversationId: REF, messageId: REF, text: TEXT }, ['messageId', 'text']),
    effects: 'edit',
    sharedState: false,
    costClass: 'free',
    targets: 'self-messages',
    interfaceCapability: 'message.edit',
  },
  {
    name: 'message.delete',
    family: 'message',
    op: null,
    argsSchema: objectSchema({ conversationId: REF, messageId: REF }, ['messageId']),
    effects: 'delete',
    sharedState: false,
    costClass: 'free',
    targets: 'self-messages',
    interfaceCapability: 'message.delete',
  },
  {
    name: 'message.react.add',
    family: 'message',
    op: null,
    argsSchema: objectSchema({ conversationId: REF, messageId: REF, emoji: EMOJI }, ['messageId', 'emoji']),
    effects: 'send',
    sharedState: false,
    costClass: 'free',
    targets: 'allowed-conversations',
    interfaceCapability: 'message.react.add',
  },
  {
    name: 'message.react.remove',
    family: 'message',
    op: null,
    argsSchema: objectSchema({ conversationId: REF, messageId: REF, emoji: EMOJI }, ['messageId', 'emoji']),
    effects: 'delete',
    sharedState: false,
    costClass: 'free',
    targets: 'allowed-conversations',
    interfaceCapability: 'message.react.remove',
  },
  {
    name: 'draw',
    family: 'draw',
    op: 'draw.create',
    argsSchema: objectSchema({ conversationId: REF, prompt: TEXT, self: { type: 'boolean' } }, ['prompt']),
    effects: 'generate',
    sharedState: false,
    costClass: 'paid',
    targets: 'allowed-conversations',
    interfaceCapability: 'message.send',
  },
  {
    name: 'memory.read',
    family: 'memory',
    op: 'memory.profile.read',
    argsSchema: objectSchema({ memberId: REF }, ['memberId']),
    effects: 'read',
    sharedState: false,
    costClass: 'free',
    targets: null,
    interfaceCapability: null,
  },
  {
    name: 'status.show',
    family: 'status',
    op: 'status.show',
    argsSchema: objectSchema(),
    effects: 'read',
    sharedState: false,
    costClass: 'free',
    targets: null,
    interfaceCapability: null,
  },
  {
    name: 'skills.list',
    family: 'skills',
    op: null,
    argsSchema: objectSchema(),
    effects: 'read',
    sharedState: false,
    costClass: 'free',
    targets: null,
    interfaceCapability: null,
  },
  {
    name: 'access.request',
    family: 'access',
    op: null,
    argsSchema: objectSchema({ skill: { type: 'string', minLength: 1, maxLength: 64 }, reason: { type: 'string', minLength: 1, maxLength: 300 } }, ['skill']),
    effects: 'send',
    sharedState: false,
    costClass: 'free',
    targets: null,
    interfaceCapability: null,
  },
].map((definition) => Object.freeze(definition)));

/** The names of SKILL_DEFINITIONS, in order: the `/nep skill` autocomplete (no ops needed). */
export function skillNames() {
  return SKILL_DEFINITIONS.map((definition) => definition.name);
}

/**
 * The skills of `definitions` as a Map name -> frozen skill: the definition plus `kind`
 * (`read`|`write`) and `ownerOnly`, inherited from the operation it runs (`getOp`), or, for an
 * interface skill (`op: null`), `kind` from its effects and `ownerOnly` false. Throws -- a
 * programming error, at startup -- on a missing or repeated name, an unknown effect, cost class or
 * target, a missing argument schema, an unknown operation, or an owner-only one.
 * @param {object[]} [definitions]
 * @param {{ getOp?: (name: string) => ({ name: string, rights: object } | null) }} [options]
 * @returns {Map<string, object>}
 */
export function loadSkills(definitions = SKILL_DEFINITIONS, { getOp = registryGetOp } = {}) {
  const skills = new Map();
  for (const definition of definitions) {
    const { name, op } = definition ?? {};
    if (typeof name !== 'string' || !name) throw new Error('a skill needs a name');
    if (skills.has(name)) throw new Error(`skill defined twice: ${name}`);
    if (!EFFECTS.includes(definition.effects)) throw new Error(`skill ${name}: effects must be one of ${EFFECTS.join(', ')}`);
    if (!COST_CLASSES.includes(definition.costClass)) throw new Error(`skill ${name}: costClass must be free or paid`);
    if (!TARGETS.includes(definition.targets ?? null)) throw new Error(`skill ${name}: targets must be one of ${TARGETS.filter(Boolean).join(', ')} or null`);
    if (!definition.argsSchema || typeof definition.argsSchema !== 'object') throw new Error(`skill ${name}: argsSchema is required`);

    // An interface skill: its kind follows its effects. An operation's skill inherits both; an
    // owner-only operation never loads, so every loaded skill has `ownerOnly: false`.
    let kind = definition.effects === 'read' ? 'read' : 'write';
    const ownerOnly = false;
    if (op !== null && op !== undefined) {
      const operation = getOp(op);
      if (!operation) throw new Error(`skill ${name}: unknown operation ${op}`);
      if (operation.rights?.ownerOnly === true) throw new Error(`skill ${name}: operation ${op} is owner-only and can never be a persona skill`);
      kind = operation.rights.kind;
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
    }));
  }
  return skills;
}

let loaded = null;

/**
 * The skills of SKILL_DEFINITIONS against the live ops registry, loaded once on first use (the
 * operations register themselves when src/ops/index.js is imported; src/index.js calls this at
 * start so a bad definition fails there). A load that throws is not kept.
 * @returns {Map<string, object>}
 */
export function skillRegistry() {
  if (!loaded) loaded = loadSkills();
  return loaded;
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
