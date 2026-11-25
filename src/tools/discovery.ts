// Discovery of the persona's skills (the skills design, phase 0): how the persona learns what they can
// do without the whole catalogue sitting in every request: every turn shows them the names of the
// skills granted to them (grantedSkillNames, rendered in the request's cached stable part,
// src/behavior/prompt.ts), so they know what they can do.
// Pure; the texts are `hot.prompts.tools`, read by the caller at the moment of use.

import { CARRIED_OVER, NOT_GRANTABLE_TO_PERSONA, grantedToPersona, safeModeOn } from './access.ts';
import { describeSkill, openToolTexts } from './registry.ts';
import { opensPrivate } from '../memory/open-private.ts';
import { objOf } from './types.ts';
import { roleOn } from '../llm/roles.ts';
import type { DescribedSkill, Skill } from './types.ts';

/** The skills that run inside the persona's turn and come back in it (src/tools/tools.ts). */
// `conversation.read` and `media.find` are built on their own branches; a name with no registered skill is skipped everywhere it is used.
export const IN_TURN_TOOLS: ReadonlyArray<string> = Object.freeze([
  'web.search',
  'web.read',
  'media.look',
  'memory.search',
  'conversation.read',
  'memory.read',
  'media.find',
]);

/**
 * The narrow reads of one subject, left out of the list the persona is offered: their read of one subject is `memory.read`
 * (src/turn/memory-read.ts), which reads under the turn's memory context, and a grant of any of these opens it
 * (src/tools/operations/grants.ts#grantNamesFor). They stay registered, grantable operations that run when called.
 */
export const REPLACED_BY_MEMORY_READ: ReadonlyArray<string> = Object.freeze([
  'memory.profile.read',
  'memory.channel.read',
  'memory.server.read',
  'memory.recent.read',
  'lore.list',
  'lore.show',
]);

/**
 * The names of the registry skills granted to the persona (src/tools/access.ts#grantedToPersona:
 * a `bot.access` entry naming their user id `selfId`), sorted by name (code-unit order, so the same
 * grants give the same list whatever the order they were stored or registered in). Only their
 * grants and the registry decide it -- never a requester, a channel or the time -- so the cached
 * part of the request it fills stays byte-identical until a grant changes. Left out: a skill no
 * grant opens for them (NOT_GRANTABLE_TO_PERSONA), a narrow read memory.read replaces for them
 * (REPLACED_BY_MEMORY_READ), a skill whose feature switch is off
 * (src/tools/access.ts#skillFeatureOn); everything under safe mode or with
 * `features.tools` off. A carried-over skill is listed only when granted. Pure.
 */
export function grantedSkillNames({
  config,
  selfId = null,
  registry = null,
}: {
  config: unknown;
  selfId?: string | null;
  registry?: ReadonlyMap<string, Skill> | null;
}): Array<string> {
  if (safeModeOn(config) || !(registry instanceof Map)) return [];
  return [...registry.keys()]
    .filter(
      (name) =>
        typeof name === 'string' &&
        !NOT_GRANTABLE_TO_PERSONA.includes(name) &&
        !REPLACED_BY_MEMORY_READ.includes(name) &&
        grantedToPersona(config, selfId, name)
    )
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Whether the skill needs a model role that is off: drawing, speech, or both vision and video for `media.look`. */
function servedByOffRole(config: unknown, name: string): boolean {
  // Quick search switched off: the tool leaves the persona's list, and reading a known page stays.
  if (name === 'web.search') return objOf(objOf(objOf(config).web).quickSearch).enabled === false;
  if (name === 'draw.create') return !roleOn(config, 'drawing');
  if (name === 'voice.say') return !roleOn(config, 'speech');
  if (name === 'media.look') return !roleOn(config, 'vision') && !roleOn(config, 'video');
  return false;
}

/**
 * The names of the skills one turn carries as the persona's tools, the same list for every turn kind: the
 * skills granted to them (grantedSkillNames) and the carried-over ones (CARRIED_OVER: a post, a
 * reaction, a picture), each that the registry holds and whose feature switch is on, sorted by
 * name and de-duplicated. `draw.create` is listed only while `features.imageGeneration` is not
 * false. With `features.tools` off the list is empty; under safe mode it is the carried-over ones
 * alone. Only their grants, the registry and the live config decide it -- never a requester, a
 * channel or a wake -- so the tool list of a request stays byte-identical until a grant changes. A wake refuses a
 * call outside its own set when the call is made (src/tools/wake-tools.ts#wakeRefusalCode). Pure.
 */
export function exposedSkillNames({
  config,
  selfId = null,
  registry = null,
}: {
  config: unknown;
  selfId?: string | null;
  registry?: ReadonlyMap<string, Skill> | null;
}): Array<string> {
  if (!(registry instanceof Map)) return [];
  const names = safeModeOn(config)
    ? [...CARRIED_OVER]
    : [...grantedSkillNames({ config, selfId, registry }), ...CARRIED_OVER];
  return [...new Set(names)]
    .filter((name) => registry.has(name) && !servedByOffRole(config, name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The members of `names` the interface of a turn's place can carry out: a skill that needs a port operation
 * (`interfaceCapability`) stays only when `operations`, what that interface declares, lists it. An interface that
 * declares no operation at all (a link that has not said hello) leaves every name in.
 */
export function placeSkillNames(
  names: ReadonlyArray<string>,
  registry: ReadonlyMap<string, Skill>,
  operations: ReadonlyArray<string>
): Array<string> {
  if (operations.length === 0) return [...names];
  return names.filter((name) => {
    const needed = registry.get(name)?.interfaceCapability ?? null;
    return needed === null || operations.includes(needed);
  });
}

/**
 * `items` (skills or catalogue rows, each with a `name`) grouped by family -- the part of the
 * name before its first dot -- the families in the order they first appear, each group in the
 * order given: how the skills are listed, so a family's skills stand together.
 */
export function byFamily<TItem extends { name: string }>(items: ReadonlyArray<TItem>): Array<Array<TItem>> {
  const groups = new Map<string, Array<TItem>>();
  for (const item of Array.isArray(items) ? (items as ReadonlyArray<TItem>) : []) {
    const family = (typeof item.name === 'string' ? item.name : '').split('.')[0] ?? '';
    const group = groups.get(family) ?? [];
    group.push(item);
    groups.set(family, group);
  }
  return [...groups.values()];
}

/** The most allowed values one argument lists in `<skills>`; a longer list is marked `more`. */
export const MAX_ARG_VALUES = 12;

/**
 * The arguments of `skill` as `<skills>` lists them (src/behavior/prompt.ts#skillsInventoryText),
 * read off its argument schema (the skills table's `params`, src/tools/definitions.ts)
 * in the schema's order, so the list is the same on every call: `{ name, required }` each, plus
 * `values` (strings) for
 * an enum -- its first MAX_ARG_VALUES, `more: true` when it has more -- or a boolean (`true`,
 * `false`, the words a call's attribute is read as), and `minimum` / `maximum` for a number's
 * bounds the schema sets. [] without a schema or properties. Pure.
 */
export function skillArgs(skill: { argsSchema?: unknown } | null | undefined): Array<SkillArg> {
  const schema = objOf(skill?.argsSchema);
  const properties = objOf(schema.properties);
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(properties).map(([name, value]) => {
    const property = objOf(value);
    const arg: SkillArg = { name, required: required.has(name) };
    const values: ReadonlyArray<unknown> | null = Array.isArray(property.enum)
      ? (property.enum as ReadonlyArray<unknown>)
      : property.type === 'boolean'
        ? ['true', 'false']
        : null;
    if (values) {
      arg.values = values.slice(0, MAX_ARG_VALUES).map((item) => (typeof item === 'string' ? item : ''));
      if (values.length > MAX_ARG_VALUES) arg.more = true;
    } else if (property.type === 'integer' || property.type === 'number') {
      if (typeof property.minimum === 'number' && Number.isFinite(property.minimum)) arg.minimum = property.minimum;
      if (typeof property.maximum === 'number' && Number.isFinite(property.maximum)) arg.maximum = property.maximum;
    }
    return arg;
  });
}

/** One argument of a skill as `<skills>` lists it. */
export type SkillArg = {
  name: string;
  required: boolean;
  values?: Array<string>;
  more?: true;
  minimum?: number;
  maximum?: number;
};

/** The gateway's verdict on one skill: whether the persona may use it now and why. */
export type SkillRow = { name: string; allowed: boolean; reason: string };

/** The edit distance of two short strings (insert, delete, replace), for the closest names of an unknown skill. */
function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1)
      next[j] = Math.min(
        (row[j] ?? 0) + 1,
        (next[j - 1] ?? 0) + 1,
        (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    row = next;
  }
  return row[b.length] ?? 0;
}

/** The most names an unknown skill answers with. */
export const MAX_CLOSEST = 5;

/**
 * The skills `tools.describe` (src/tools/operations/skills.ts) answers for `name`: an exact skill name gives that skill in full
 * (title, when to use, when not to, arguments, as a core row), a family (`memory`, `intent`: the part of a name before
 * its first dot) gives each of its skills with no arguments, one line each; a name that is neither gives no row and the
 * closest skill names. Every row is `allowed: true` and its `reason` says whether the persona has the skill now (`allowed`, or
 * `not-allowed` for one not switched on for them: their grants only, as grantedSkillNames). Skills whose feature switch is off do not
 * exist for them. Matching ignores letter case and surrounding space. Pure.
 */
export function describeRows({
  config,
  selfId = null,
  registry = null,
  texts = undefined,
  name = '',
}: {
  config: unknown;
  selfId?: string | null;
  registry?: ReadonlyMap<string, Skill> | null;
  texts?: unknown;
  name?: unknown;
}): { rows: Array<DescribedRow>; closest: Array<string> } {
  const wanted = (typeof name === 'string' ? name : '').trim().toLowerCase();
  if (!wanted || !(registry instanceof Map)) return { rows: [], closest: [] };
  const granted = new Set(grantedSkillNames({ config, selfId, registry }));
  const skills = [...(registry as ReadonlyMap<string, Skill>).values()];
  const row = (skill: Skill, withArgs: boolean): DescribedRow => ({
    ...describeSkill(skill, opensPrivate(config) ? openToolTexts(texts) : texts),
    args: withArgs ? skillArgs(skill) : [],
    allowed: true,
    reason: granted.has(skill.name) ? 'allowed' : 'not-allowed',
  });
  const exact = skills.find((skill) => skill.name.toLowerCase() === wanted);
  if (exact) return { rows: [row(exact, true)], closest: [] };
  const family = skills.filter((skill) => (skill.name.split('.')[0] ?? '').toLowerCase() === wanted);
  if (family.length > 0)
    return {
      rows: byFamily(family)
        .flat()
        .map((skill) => row(skill, false)),
      closest: [],
    };
  const closest = skills
    .map((skill) => ({
      name: skill.name,
      score:
        skill.name.toLowerCase().includes(wanted) || wanted.includes(skill.name.toLowerCase())
          ? 0
          : editDistance(wanted, skill.name.toLowerCase()),
    }))
    .filter((item) => item.score <= Math.max(3, Math.floor(wanted.length / 2)))
    .sort((a, b) => a.score - b.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, MAX_CLOSEST)
    .map((item) => item.name);
  return { rows: [], closest };
}

/** A skill in full as `tools.describe` answers it: its wording and arguments, and whether the persona has it now. */
export type DescribedRow = DescribedSkill & { args: Array<SkillArg>; allowed: true; reason: string };
