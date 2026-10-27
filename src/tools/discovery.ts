// Discovery of the persona's skills (the skills design, phase 0): how she learns what she can
// do without the whole catalogue sitting in every request. The search classifier
// (prompts/lookup.md) and the turn planner (prompts/planner.md) may answer one more line,
// `skills: inventory` (the message asks what she can do: the turn then shows her the catalogue
// with her access, src/behavior/prompt.js) or `skills: <name>, <name>` (up to four registry
// skills relevant to the message: shadow only, logged and journaled, never rendered yet). The
// classifiers read the registry's names through `{{skills}}` (skillsIndex: static texts only, no
// grants). Behind `features.skills` and `features.skillsDiscovery` (a missing key counts as on).
// Apart from both, every turn shows her the names of the skills granted to her (grantedSkillNames,
// rendered in the request's cached stable part, src/behavior/prompt.js), so she knows what she
// can do without a classifier naming it.
// Pure; the texts are `hot.prompts.skills`, read by the caller at the moment of use.

import {
  CARRIED_OVER,
  NOT_GRANTABLE_TO_PERSONA,
  grantedToPersona,
  safeModeOn,
  skillFeatureOn,
  skillsOn,
} from './access.ts';
import { describeSkill, skillNames } from './registry.ts';
import { CODE } from './codes.ts';
import { objOf } from './types.ts';
import type { DescribedSkill, Skill } from './types.ts';

/** The skills that run inside the persona's turn and come back in it (src/tools/tools.ts; features.coreTools). */
// `conversation.read` and `media.find` are built on their own branches; a name with no registered skill is skipped everywhere it is used.
export const IN_TURN_TOOLS: ReadonlyArray<string> = Object.freeze([
  'web.search',
  'web.read',
  'media.look',
  'memory.search',
  'conversation.read',
  'media.find',
]);

/** The most skills one answer may name. */
export const MAX_PROPOSED = 4;

/** A `skills:` line of a classifier's answer; a list bullet or bold marks around the label are tolerated. */
export const SKILLS_LINE_RE = /^(?:[-*•>]\s*)*\**\s*skills\s*\**\s*:\s*\**\s*(.*)$/i;

// Protocol tokens of the `skills:` line, not wording.
const NONE_RE = /^none\b/i;
const INVENTORY = 'inventory';
const SPLIT_RE = /[,;，、]/;
const WRAPPING = /^[\s"'`“”‘’«»*]+|[\s"'`“”‘’«»*.!?…]+$/gu;

/**
 * Whether discovery runs: `features.skills` and `features.skillsDiscovery` both not false (a
 * missing key counts as on), read from the live config at the moment of use.
 */
export function discoveryOn(config: unknown): boolean {
  return skillsOn(config) && objOf(objOf(config).features).skillsDiscovery !== false;
}

/**
 * The names of the registry skills granted to the persona (src/tools/access.ts#grantedToPersona:
 * a `bot.access` entry naming her user id `selfId`), sorted by name (code-unit order, so the same
 * grants give the same list whatever the order they were stored or registered in). Only her
 * grants and the registry decide it -- never a requester, a channel or the time -- so the cached
 * part of the request it fills stays byte-identical until a grant changes. Left out: a skill no
 * grant opens for her (NOT_GRANTABLE_TO_PERSONA), a skill whose feature switch is off
 * (src/tools/access.ts#skillFeatureOn); everything under safe mode or with
 * `features.skills` off. A carried-over skill is listed only when granted. Pure.
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
  if (!skillsOn(config) || safeModeOn(config) || !(registry instanceof Map)) return [];
  return [...registry.keys()]
    .filter(
      (name) =>
        typeof name === 'string' &&
        !NOT_GRANTABLE_TO_PERSONA.includes(name) &&
        skillFeatureOn(name, config) &&
        grantedToPersona(config, selfId, name)
    )
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The names of the skills one turn carries as her tools, the same list for every turn kind: the
 * skills granted to her (grantedSkillNames) and the carried-over ones (CARRIED_OVER: a post, a
 * reaction, a picture), each that the registry holds and whose feature switch is on, sorted by
 * name and de-duplicated. `draw.create` is listed only while `features.imageGeneration` is not
 * false. With `features.skills` off the list is empty; under safe mode it is the carried-over ones
 * alone. Only her grants, the registry and the live config decide it -- never a requester or a
 * channel -- so the tool list of a request stays byte-identical until a grant changes. Pure.
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
  if (!skillsOn(config) || !(registry instanceof Map)) return [];
  const names = safeModeOn(config)
    ? [...CARRIED_OVER]
    : [...grantedSkillNames({ config, selfId, registry }), ...CARRIED_OVER];
  const drawOn = objOf(objOf(config).features).imageGeneration !== false;
  return [...new Set(names)]
    .filter((name) => registry.has(name) && skillFeatureOn(name, config) && (name !== 'draw.create' || drawOn))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** No `skills:` line at all: what an answer without one means (none). */
export const NO_SKILLS: SkillsLines = Object.freeze({ state: 'missing', inventory: false, names: Object.freeze([]) });

/** What a classifier's `skills:` lines say. */
export type SkillsLines = {
  state: 'missing' | 'none' | 'inventory' | 'named' | 'invalid';
  inventory: boolean;
  names: ReadonlyArray<string>;
};

/**
 * The `skills:` lines of a classifier's answer (`values`: what follows each label, in order).
 * `state`: `missing` (no line), `none` (the model said none), `inventory`, `named` (1..4 known
 * names, most relevant first, de-duplicated, matched to `names` in any letter case) or `invalid`
 * (two lines, or no known name). `inventory` wins over names on the same line; an unknown name is
 * dropped. Never throws. `names` are the registry's skill names (default: every defined skill).
 */
export function parseSkillsLines(
  values: ReadonlyArray<unknown>,
  names: ReadonlyArray<string> = skillNames()
): SkillsLines {
  const list: ReadonlyArray<unknown> = Array.isArray(values) ? values : [];
  if (list.length === 0) return { ...NO_SKILLS, names: [] };
  if (list.length > 1) return { state: 'invalid', inventory: false, names: [] };
  const first = list[0];
  const value = (typeof first === 'string' ? first : '').replace(WRAPPING, '').trim();
  if (!value || NONE_RE.test(value)) return { state: 'none', inventory: false, names: [] };
  const known = new Map(names.map((name) => [name.toLowerCase(), name]));
  const tokens = value
    .split(SPLIT_RE)
    .map((token) => token.replace(WRAPPING, '').trim().toLowerCase())
    .filter(Boolean);
  if (tokens.includes(INVENTORY)) return { state: 'inventory', inventory: true, names: [] };
  const picked: Array<string> = [];
  for (const token of tokens) {
    const name = known.get(token);
    if (name && !picked.includes(name)) picked.push(name);
    if (picked.length >= MAX_PROPOSED) break;
  }
  return picked.length > 0
    ? { state: 'named', inventory: false, names: picked }
    : { state: 'invalid', inventory: false, names: [] };
}

/**
 * Splits the `skills:` lines out of a classifier's answer: `rest` is the answer without them
 * (for the parser of the other lines, unchanged), `values` what follows each `skills:` label.
 */
export function takeSkillsLines(raw: unknown): { rest: string; values: Array<string> } {
  const values: Array<string> = [];
  const rest: Array<string> = [];
  for (const line of (typeof raw === 'string' ? raw : '').split(/\r?\n/)) {
    const match = SKILLS_LINE_RE.exec(line.trim());
    if (match?.[1] !== undefined) values.push(match[1]);
    else rest.push(line);
  }
  return { rest: rest.join('\n'), values };
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

/**
 * The registry as the classifiers read it through `{{skills}}`: one line per skill, grouped by
 * family (byFamily), `<name> | <whenToUse>` (the text from the skills layer), the name alone when
 * it has none. Static: no access, no grant, so the prompt it fills stays the same while the owner
 * toggles skills. Owner-only skills are listed too: they run for an owner who asks. `texts` is `hot.prompts.skills`.
 */
export function skillsIndex(registry: ReadonlyMap<string, Skill> | null | undefined, texts?: unknown): string {
  const skills = [...(registry?.values() ?? [])].filter((skill) => typeof skill.name === 'string');
  return byFamily(skills)
    .flat()
    .map((skill) => {
      const whenToUse = describeSkill(skill, texts).whenToUse.trim();
      return whenToUse ? `${skill.name} | ${whenToUse}` : skill.name;
    })
    .join('\n');
}

/** The most allowed values one argument lists in `<skills>`; a longer list is marked `more`. */
export const MAX_ARG_VALUES = 12;

/**
 * The arguments of `skill` as `<skills>` lists them (src/behavior/prompt.js#skillsInventoryText),
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

/** The gateway's verdict on one skill: whether she may use it now and why. */
export type SkillRow = { name: string; allowed: boolean; reason: string };

/**
 * The gateway's verdict on each named skill, from the catalogue rows of this requester and
 * conversation (src/tools/gateway.ts#listSkills): `{ name, allowed, reason }` per name, in
 * order; a name with no row (not in the registry) is `{ allowed: false, reason: CODE.UNKNOWN_SKILL }`.
 */
export function proposalVerdicts(names: ReadonlyArray<string>, rows: ReadonlyArray<SkillRow>): Array<SkillRow> {
  const byName = new Map(rows.map((row) => [row.name, row]));
  return names.map((name) => {
    const row = byName.get(name);
    return row
      ? { name, allowed: row.allowed === true, reason: row.reason }
      : { name, allowed: false, reason: CODE.UNKNOWN_SKILL };
  });
}

/**
 * The catalogue rows a request's `<skills>` shows for the skills a classifier named
 * (`proposals`: proposalVerdicts' answer, in the classifier's order): the row of each name the
 * catalogue (`rows`, listSkills') has, marked `proposed` -- src/behavior/prompt.js#skillsInventoryText
 * then shows the allowed ones and names the others as not switched on. Null when none is in it.
 */
export function proposedRows<TRow extends SkillRow>(
  proposals: ReadonlyArray<{ name: string }>,
  rows: ReadonlyArray<TRow>
): Array<TRow & { proposed: true }> | null {
  const byName = new Map(rows.map((row) => [row.name, row]));
  const shown = proposals.flatMap(({ name }) => {
    const row = byName.get(name);
    return row === undefined ? [] : [{ ...row, proposed: true as const }];
  });
  return shown.length > 0 ? shown : null;
}

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
 * The skills `skills.describe` (src/tools/impl/skills.ts) answers for `name`: an exact skill name gives that skill in full
 * (title, when to use, when not to, arguments, as a core row), a family (`memory`, `intent`: the part of a name before
 * its first dot) gives each of its skills with no arguments, one line each; a name that is neither gives no row and the
 * closest skill names. Every row is `allowed: true` and its `reason` says whether she has the skill now (`allowed`, or
 * `not-allowed` for one not switched on for her: her grants only, as grantedSkillNames). Skills whose feature switch is off do not
 * exist for her. Matching ignores letter case and surrounding space. Pure.
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
  const skills = [...(registry as ReadonlyMap<string, Skill>).values()].filter((skill) =>
    skillFeatureOn(skill.name, config)
  );
  const row = (skill: Skill, withArgs: boolean): DescribedRow => ({
    ...describeSkill(skill, texts),
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

/** A skill in full as `tools.describe` answers it: its wording and arguments, and whether she has it now. */
export type DescribedRow = DescribedSkill & { args: Array<SkillArg>; allowed: true; reason: string };
