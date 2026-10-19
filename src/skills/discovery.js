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
// can do without a classifier naming it; behind `features.skillsAlwaysListed` as well.
// Pure; the texts are `hot.prompts.skills`, read by the caller at the moment of use.

import { isPlainObject } from '../config.js';
import { NOT_GRANTABLE_TO_PERSONA, grantedToPersona, safeModeOn, skillFeatureOn, skillsOn } from './access.js';
import { describeSkill, skillNames } from './registry.js';

/** The skills that run inside the persona's turn and come back in it (src/skills/tools.js; features.coreTools). */
export const IN_TURN_TOOLS = Object.freeze(['web.search', 'web.read', 'media.look', 'memory.search']);

/**
 * Her own tools listed in full on every turn under features.coreTools: the in-turn tools, the errand
 * hand-off, then the intention skills that set, change and drop one (no classifier names a skill for
 * her then, so this is the only place she learns how), then `places.list` (the places she can read,
 * docs/inner-life.md "Her attention"). `intent.list` stays out: the `<intentions>` block shows them.
 * Each row still needs her grant and its feature switch (grantedSkillNames).
 */
export const CORE_TOOL_SKILLS = Object.freeze([...IN_TURN_TOOLS, 'task.run', 'intent.set', 'intent.update', 'intent.cancel', 'places.list']);

/**
 * The posting skills an inner turn's tags stand for (docs/inner-life.md): shown in `<skills_tools>`
 * on an inner turn only, after the reads, with their arguments, because her output tags there are
 * these calls (src/behavior/inner-output.js). An addressed turn's tags post by themselves.
 */
export const INNER_POSTING_SKILLS = Object.freeze(['message.create', 'message.react.add', 'draw.create']);

/** CORE_TOOL_SKILLS as an inner turn lists them: the posting skills follow the reads, before the errand and the intentions. */
export const INNER_CORE_TOOL_SKILLS = Object.freeze([...IN_TURN_TOOLS, ...INNER_POSTING_SKILLS, ...CORE_TOOL_SKILLS.filter((name) => !IN_TURN_TOOLS.includes(name))]);

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
 * @param {object|null|undefined} config
 * @returns {boolean}
 */
export function discoveryOn(config) {
  return skillsOn(config) && config?.features?.skillsDiscovery !== false;
}

/**
 * Whether every turn lists the skills granted to the persona: discovery on (discoveryOn) and
 * `features.skillsAlwaysListed` not false (a missing key counts as on), read from the live config
 * at the moment of use.
 * @param {object|null|undefined} config
 * @returns {boolean}
 */
export function alwaysListedOn(config) {
  return discoveryOn(config) && config?.features?.skillsAlwaysListed !== false;
}

/**
 * The names of the registry skills granted to the persona (src/skills/access.js#grantedToPersona:
 * a `bot.access` entry naming her user id `selfId`), sorted by name (code-unit order, so the same
 * grants give the same list whatever the order they were stored or registered in). Only her
 * grants and the registry decide it -- never a requester, a channel or the time -- so the cached
 * part of the request it fills stays byte-identical until a grant changes. Left out: a skill no
 * grant opens for her (NOT_GRANTABLE_TO_PERSONA), a skill whose feature switch is off
 * (src/skills/access.js#skillFeatureOn); everything under safe mode or with
 * `features.skills` off. A carried-over skill is listed only when granted. Pure.
 * @param {{ config: object, selfId?: string|null, registry?: Map<string, object>|null }} input
 * @returns {string[]}
 */
export function grantedSkillNames({ config, selfId = null, registry = null }) {
  if (!skillsOn(config) || safeModeOn(config) || !(registry instanceof Map)) return [];
  return [...registry.keys()]
    .filter((name) => typeof name === 'string' && !NOT_GRANTABLE_TO_PERSONA.includes(name) && skillFeatureOn(name, config) && grantedToPersona(config, selfId, name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** No `skills:` line at all: what an answer without one means (none). */
export const NO_SKILLS = Object.freeze({ state: 'missing', inventory: false, names: Object.freeze([]) });

/**
 * The `skills:` lines of a classifier's answer (`values`: what follows each label, in order).
 * `state`: `missing` (no line), `none` (the model said none), `inventory`, `named` (1..4 known
 * names, most relevant first, de-duplicated, matched to `names` in any letter case) or `invalid`
 * (two lines, or no known name). `inventory` wins over names on the same line; an unknown name is
 * dropped. Never throws.
 * @param {string[]} values
 * @param {string[]} [names]  The registry's skill names (default: every defined skill).
 * @returns {{ state: 'missing'|'none'|'inventory'|'named'|'invalid', inventory: boolean, names: string[] }}
 */
export function parseSkillsLines(values, names = skillNames()) {
  const list = Array.isArray(values) ? values : [];
  if (list.length === 0) return { ...NO_SKILLS, names: [] };
  if (list.length > 1) return { state: 'invalid', inventory: false, names: [] };
  const value = String(list[0] ?? '').replace(WRAPPING, '').trim();
  if (!value || NONE_RE.test(value)) return { state: 'none', inventory: false, names: [] };
  const known = new Map((Array.isArray(names) ? names : []).map((name) => [String(name).toLowerCase(), String(name)]));
  const tokens = value.split(SPLIT_RE).map((token) => token.replace(WRAPPING, '').trim().toLowerCase()).filter(Boolean);
  if (tokens.includes(INVENTORY)) return { state: 'inventory', inventory: true, names: [] };
  const picked = [];
  for (const token of tokens) {
    const name = known.get(token);
    if (name && !picked.includes(name)) picked.push(name);
    if (picked.length >= MAX_PROPOSED) break;
  }
  return picked.length > 0 ? { state: 'named', inventory: false, names: picked } : { state: 'invalid', inventory: false, names: [] };
}

/**
 * Splits the `skills:` lines out of a classifier's answer: `rest` is the answer without them
 * (for the parser of the other lines, unchanged), `values` what follows each `skills:` label.
 * @param {unknown} raw
 * @returns {{ rest: string, values: string[] }}
 */
export function takeSkillsLines(raw) {
  const values = [];
  const rest = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const match = SKILLS_LINE_RE.exec(line.trim());
    if (match) values.push(match[1]);
    else rest.push(line);
  }
  return { rest: rest.join('\n'), values };
}

/**
 * `items` (skills or catalogue rows, each with a `name`) grouped by family -- the part of the
 * name before its first dot -- the families in the order they first appear, each group in the
 * order given: how the skills are listed, so a family's skills stand together.
 * @template T
 * @param {T[]} items
 * @returns {T[][]}
 */
export function byFamily(items) {
  const groups = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const family = String(item?.name ?? '').split('.')[0];
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push(item);
  }
  return [...groups.values()];
}

/**
 * The registry as the classifiers read it through `{{skills}}`: one line per skill, grouped by
 * family (byFamily), `<name> | <whenToUse>` (the text from the skills layer), the name alone when
 * it has none. Static: no access, no grant, so the prompt it fills stays the same while the owner
 * toggles skills. Owner-only skills are listed too: they run for an owner who asks.
 * @param {Map<string, object>} registry
 * @param {object} [texts]  `hot.prompts.skills`.
 * @returns {string}
 */
export function skillsIndex(registry, texts) {
  const skills = [...(registry?.values?.() ?? [])].filter((skill) => typeof skill?.name === 'string');
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
 * read off its argument schema (src/skills/derive.js#optionsSchema: the command's option names)
 * in the schema's order, so the list is the same on every call: `{ name, required }` each, plus
 * `body: true` for the option a `<call>` body fills (`skill.command.body`), `values` (strings) for
 * an enum -- its first MAX_ARG_VALUES, `more: true` when it has more -- or a boolean (`true`,
 * `false`, the words a call's attribute is read as), and `minimum` / `maximum` for a number's
 * bounds the schema sets. [] without a schema or properties. Pure.
 * @param {{ argsSchema?: object, command?: { body?: string|null } }|null|undefined} skill
 * @returns {{ name: string, required: boolean, body?: true, values?: string[], more?: true, minimum?: number, maximum?: number }[]}
 */
export function skillArgs(skill) {
  const schema = skill?.argsSchema;
  const properties = isPlainObject(schema?.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const body = typeof skill?.command?.body === 'string' ? skill.command.body : null;
  return Object.entries(properties).map(([name, property]) => {
    const arg = { name, required: required.has(name) };
    if (name === body) arg.body = true;
    const values = Array.isArray(property?.enum) ? property.enum : property?.type === 'boolean' ? [true, false] : null;
    if (values) {
      arg.values = values.slice(0, MAX_ARG_VALUES).map(String);
      if (values.length > MAX_ARG_VALUES) arg.more = true;
    } else if (property?.type === 'integer' || property?.type === 'number') {
      if (Number.isFinite(property.minimum)) arg.minimum = property.minimum;
      if (Number.isFinite(property.maximum)) arg.maximum = property.maximum;
    }
    return arg;
  });
}

/**
 * The gateway's verdict on each named skill, from the catalogue rows of this requester and
 * conversation (src/skills/gateway.js#listSkills): `{ name, allowed, reason }` per name, in
 * order; a name with no row (not in the registry) is `{ allowed: false, reason: 'unknown-skill' }`.
 * @param {string[]} names
 * @param {{ name: string, allowed: boolean, reason: string }[]} rows
 * @returns {{ name: string, allowed: boolean, reason: string }[]}
 */
export function proposalVerdicts(names, rows) {
  const byName = new Map((Array.isArray(rows) ? rows : []).map((row) => [row.name, row]));
  return (Array.isArray(names) ? names : []).map((name) => {
    const row = byName.get(name);
    return row ? { name, allowed: row.allowed === true, reason: row.reason } : { name, allowed: false, reason: 'unknown-skill' };
  });
}

/**
 * The catalogue rows a request's `<skills>` shows for the skills a classifier named
 * (`proposals`: proposalVerdicts' answer, in the classifier's order): the row of each name the
 * catalogue (`rows`, listSkills') has, marked `proposed` -- src/behavior/prompt.js#skillsInventoryText
 * then shows the allowed ones and names the others as not switched on. Null when none is in it.
 * @param {{ name: string }[]} proposals
 * @param {{ name: string, allowed: boolean, reason: string }[]} rows
 * @returns {object[]|null}
 */
export function proposedRows(proposals, rows) {
  const byName = new Map((Array.isArray(rows) ? rows : []).map((row) => [row.name, row]));
  const shown = (Array.isArray(proposals) ? proposals : []).filter(({ name }) => byName.has(name)).map(({ name }) => ({ ...byName.get(name), proposed: true }));
  return shown.length > 0 ? shown : null;
}

/**
 * The rows `<skills_tools>` shows under features.coreTools (src/behavior/prompt.js): each skill of
 * CORE_TOOL_SKILLS, in that order, that the registry holds and that is granted to the persona
 * (grantedSkillNames: her grants only, never a requester or a channel), with its texts from the
 * skills layer (`texts`: `hot.prompts.skills`, read by the caller now) and its arguments
 * (skillArgs). The requester's own right is not reflected: the gateway still refuses per call.
 * On an inner turn (`inner`) the posting skills follow the reads (INNER_CORE_TOOL_SKILLS). Pure.
 * @param {{ config: object, selfId?: string|null, registry?: Map<string, object>|null, texts?: object, inner?: boolean }} input
 * @returns {object[]}
 */
export function coreToolRows({ config, selfId = null, registry = null, texts = undefined, inner = false }) {
  const granted = new Set(grantedSkillNames({ config, selfId, registry }));
  return (inner ? INNER_CORE_TOOL_SKILLS : CORE_TOOL_SKILLS).filter((name) => granted.has(name) && registry.has(name)).map((name) => {
    const skill = registry.get(name);
    return { ...describeSkill(skill, texts), args: skillArgs(skill) };
  });
}
