// The persona's skills: one catalogue, defined by a table of their own (src/tools/definitions.ts).
// Every registered operation (src/tools/impl/registry.ts) is a skill of the same name -- the vocabulary
// `/nep access grant` uses for people -- its arguments the table's `params`, its `kind` and
// `ownerOnly` the operation's. No skill exists without an operation behind it; nothing here reads
// the owner's slash commands. Every skill is closed until the owner grants it to her
// (src/tools/access.ts: `/nep access grant` with her as the user); an owner-only operation runs
// only when the member who asked is an owner (src/tools/gateway.ts). Their wording -- `title`,
// `whenToUse`, `whenNotToUse` -- lives in prompts/skills.json, keyed by operation name (the hot
// prompts layer, `hot.prompts.tools`), never here: `describeSkill` joins the two at the moment of
// use, and a skill without texts is shown by its name alone.

import { getOp as registryGetOp } from './impl/registry.ts';
import { EFFECT_CLASSES } from './impl/effects.ts';
import { SKILL_DEFINITIONS, validateDefinitions, optionsOfDefinition } from './definitions.ts';
import type { Definition, Given } from './definitions.ts';
import { isObj, objOf } from './types.ts';
import type { DescribedSkill, Obj, Rights, Skill, SkillMap } from './types.ts';

/** What a skill does to the world, one value per skill: its operation's effect class (src/tools/impl/effects.ts). */
export const EFFECTS = EFFECT_CLASSES;

/** `free`, or `paid`: spends balance and needs a budget (src/tools/gateway.ts). */
export const COST_CLASSES: ReadonlyArray<string> = Object.freeze(['free', 'paid']);

/**
 * Whose things a skill may touch: `self-messages` (only the persona's own messages, in a
 * conversation she may act in), `allowed-conversations` (the current conversation or a text
 * channel of the served guild where the bot holds the platform permissions the operation needs,
 * src/tools/impl/shared.ts#postingConversation), `any`, or null (no target).
 */
export const TARGETS: ReadonlyArray<string | null> = Object.freeze([
  'self-messages',
  'allowed-conversations',
  'any',
  null,
]);

/** What `loadSkills` takes of a definition: the table's, or a test's stand-in with fewer fields. */
export type SkillInput = Partial<Omit<Definition, 'dispatch'>> & {
  name: string;
  family?: string;
  argsSchema: Definition['params'];
  costClass: Definition['costClass'];
  effects: Definition['effects'];
  sharedState?: boolean;
  targets?: string | null;
  interfaceCapability?: string | null;
  dispatch?: Skill['dispatch'] | null;
  op?: string | null;
};

/**
 * The skills of `definitions` as a Map name -> frozen skill: the definition plus `kind`
 * (`read`|`write`) and `ownerOnly`, inherited from the operation it runs (`getOp`); a definition
 * with no operation (tests' stand-ins) takes `kind` from its effects and `ownerOnly` false. A
 * skill with a `dispatch` (`{ op, body, options: [{ name, kind }], toOp(given) -> { op, args|null } }`:
 * how her call reaches the operation) keeps it and is marked `opBacked`; the table's `api`, `feature`
 * and `result` are kept when given. Throws -- a programming error, at startup -- on a missing or
 * repeated name, an unknown effect, cost class or target, a missing argument schema, an unknown
 * operation, or a dispatch without its `op` and `toOp`.
 */
export function loadSkills(
  definitions: ReadonlyArray<SkillInput> = [],
  { getOp = registryGetOp }: { getOp?: (name: string) => { name: string; rights: Readonly<Rights> } | null } = {}
): SkillMap {
  const skills: SkillMap = new Map();
  for (const definition of definitions) {
    const { name, op } = definition;
    if (typeof name !== 'string' || !name) throw new Error('a skill needs a name');
    if (skills.has(name)) throw new Error(`skill defined twice: ${name}`);
    if (!(EFFECTS as ReadonlyArray<unknown>).includes(definition.effects))
      throw new Error(`skill ${name}: effects must be one of ${EFFECTS.join(', ')}`);
    if (!COST_CLASSES.includes(definition.costClass)) throw new Error(`skill ${name}: costClass must be free or paid`);
    if (!TARGETS.includes(definition.targets ?? null))
      throw new Error(`skill ${name}: targets must be one of ${TARGETS.filter(Boolean).join(', ')} or null`);
    if (!isObj(definition.argsSchema)) throw new Error(`skill ${name}: argsSchema is required`);
    const dispatch = definition.dispatch ?? null;
    if (dispatch !== null && (typeof dispatch.op !== 'string' || typeof dispatch.toOp !== 'function'))
      throw new Error(`skill ${name}: dispatch needs an op and toOp`);

    // An operation's skill inherits both, an owner-only operation included: who may run it is the
    // requester's right (the gateway). Without an operation the kind follows the effects.
    let kind: 'read' | 'write' = definition.effects === 'read' ? 'read' : 'write';
    let ownerOnly = false;
    if (op !== null && op !== undefined) {
      const operation = getOp(op);
      if (!operation) throw new Error(`skill ${name}: unknown operation ${op}`);
      kind = operation.rights.kind;
      ownerOnly = operation.rights.ownerOnly === true;
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
 */
export function definitionsOf(table: ReadonlyArray<unknown> = SKILL_DEFINITIONS): Array<SkillInput> {
  return validateDefinitions(table).map((entry): SkillInput => {
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
        toOp(given: Given) {
          let args: Obj | null = null;
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
 * The whole registry: one skill per entry of the skills table (src/tools/definitions.ts), in
 * order. Throws like loadSkills. With `registered` true only the entries whose operation is
 * registered (src/tools/impl/registry.ts) are taken, as the live registry has always held only the
 * operations that exist: a process that never loaded src/tools/impl/index.ts has none.
 */
export function buildSkills({
  table = SKILL_DEFINITIONS,
  getOp = registryGetOp,
  registered = false,
}: {
  table?: ReadonlyArray<unknown>;
  getOp?: (name: string) => { name: string; rights: Readonly<Rights> } | null;
  registered?: boolean;
} = {}): SkillMap {
  const definitions = definitionsOf(table);
  return loadSkills(
    registered ? definitions.filter((definition) => getOp(definition.op ?? '') !== null) : definitions,
    { getOp }
  );
}

let loaded: SkillMap | null = null;

/**
 * Every skill against the live ops registry (buildSkills, the registered operations), loaded once on first use
 * (src/index.js calls this at start so a bad definition fails there). A load that throws is
 * not kept.
 */
export function skillRegistry(): SkillMap {
  loaded ??= buildSkills({ registered: true });
  return loaded;
}

/**
 * The names of the table's entries that have no skill in `registry`: an entry whose operation is
 * not registered (src/tools/impl/registry.ts) is left out of the live registry, so the start reports it
 * (src/index.js) instead of the persona silently lacking a skill.
 */
export function missingDefinitions(
  registry: SkillMap = skillRegistry(),
  table: ReadonlyArray<Definition> = SKILL_DEFINITIONS
): Array<string> {
  return table.filter((entry) => !registry.has(entry.name)).map((entry) => entry.name);
}

/** The names of every registry skill, in order: the operation names a grant to the persona may name. */
export function skillNames(): Array<string> {
  return [...skillRegistry().keys()];
}

/** One skill's text field from the skills layer, '' when absent or not a string. */
function textOf(texts: unknown, name: string, key: string): string {
  const value = objOf(objOf(texts)[name])[key];
  return typeof value === 'string' ? value : '';
}

/**
 * `skill` with its wording from the skills layer (`texts`: `hot.prompts.tools`, read by the
 * caller at the moment of use): `title`, `whenToUse`, `whenNotToUse`, each '' when missing.
 */
export function describeSkill(skill: Skill, texts?: unknown): DescribedSkill {
  return {
    ...skill,
    title: textOf(texts, skill.name, 'title'),
    whenToUse: textOf(texts, skill.name, 'whenToUse'),
    whenNotToUse: textOf(texts, skill.name, 'whenNotToUse'),
  };
}

/**
 * The wording of `skill`'s arguments from the skills layer (`texts`: `hot.prompts.tools`, keyed
 * by name, `args` keyed by argument name): `{ <argument>: text }` for the arguments of the
 * skill that have one, a string each. {} when there are none. Nothing renders it yet.
 */
export function skillArgTexts(skill: Skill, texts?: unknown): Record<string, string> {
  const args = objOf(objOf(texts)[skill.name]).args;
  if (!isObj(args)) return {};
  const properties = skill.argsSchema.properties ?? {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    if (Object.hasOwn(properties, key) && typeof value === 'string' && value !== '') out[key] = value;
  }
  return out;
}
