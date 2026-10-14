// Discovery of the persona's skills (the skills design, phase 0): how she learns what she can
// do without the whole catalogue sitting in every request. The search classifier
// (prompts/lookup.md) and the turn planner (prompts/planner.md) may answer one more line,
// `skills: inventory` (the message asks what she can do: the turn then shows her the catalogue
// with her access, src/behavior/prompt.js) or `skills: <name>, <name>` (up to four registry
// skills relevant to the message: shadow only, logged and journaled, never rendered yet). The
// classifiers read the registry's names through `{{skills}}` (skillsIndex: static texts only, no
// grants). Behind `features.skills` and `features.skillsDiscovery` (a missing key counts as on).
// Pure; the texts are `hot.prompts.skills`, read by the caller at the moment of use.

import { skillsOn } from './access.js';
import { describeSkill, skillNames } from './registry.js';

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
