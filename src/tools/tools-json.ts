// The skills as native tool definitions (OpenAI chat-completions `tools`): built from the registry
// rows granted to the persona, the wording from the skills layer (`hot.prompts.tools`, read by the
// caller at the moment of use). Our names stay dotted everywhere; only this boundary carries the API
// name (`draw.create` <-> `draw_create`, src/tools/definitions.ts). `buildTools` serves the live turn
// (src/behavior/turn.ts) and the replay sandbox (src/behavior/sandbox.ts); `canonicalJson` also keeps the
// text transport's description stable (src/llm/tool-text.ts).

import { skillRegistry, describeSkill, skillArgTexts } from './registry.ts';
import { apiNameOf, skillNameOfApi } from './definitions.ts';
import { idText, isObj, objOf } from './types.ts';
import type { Obj, Skill, SkillMap } from './types.ts';
import type { ActiveSkill } from '../skills/index-block.ts';

/** What a skill entry of the tools array is made from: her active skill as the skills port gives it. */
export type OfferedSkill = Pick<ActiveSkill, 'name' | 'description' | 'missing'>;

/** `value` with every object's keys in sorted order (arrays keep theirs): one stable JSON per definition set. */
export function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (isObj(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])])
    );
  }
  return value;
}

/** `text` with every `{{key}}` of `fill` replaced (an own key with a non-null value); other placeholders stay. */
function filled(text: string, fill: unknown): string {
  if (!isObj(fill)) return text;
  return text.replace(/\{\{(\w+)\}\}/g, (all: string, key: string) =>
    Object.hasOwn(fill, key) && fill[key] != null ? idText(fill[key]) : all
  );
}

const DEFAULT_STRING_MAX = 6000;

/**
 * A copy of a validation schema for the model: the keywords only the engine's validator needs
 * (`minLength: 1`, the default `maxLength` of 6000, `additionalProperties: false`) are left out;
 * type, enum, bounds, required and descriptions stay. The engine still validates with the full one.
 */
function leanSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(leanSchema);
  if (!isObj(node)) return node;
  const out: Obj = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'minLength' && value === 1) continue;
    if (key === 'maxLength' && value === DEFAULT_STRING_MAX) continue;
    if (key === 'additionalProperties' && value === false) continue;
    if (key === 'properties' && isObj(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, leanSchema(sub)]));
    } else {
      out[key] = key === 'enum' || key === 'required' ? value : leanSchema(value);
    }
  }
  return out;
}

/** The skill's lean parameter schema with each argument's `description` from the skills layer, when it has one. */
function parametersOf(skill: Skill, texts: unknown, fill: unknown): unknown {
  const schema = JSON.parse(JSON.stringify(skill.argsSchema)) as Obj;
  const described = skillArgTexts(skill, texts);
  const properties = objOf(schema.properties);
  for (const [name, text] of Object.entries(described)) {
    if (Object.hasOwn(properties, name)) objOf(properties[name]).description = filled(text, fill);
  }
  return leanSchema(schema);
}

/** Title, when to use and when not to, one per line, the empty ones left out. */
function descriptionOf(skill: Skill, texts: unknown, fill: unknown): string {
  const { title, whenToUse, whenNotToUse } = describeSkill(skill, texts);
  return filled([title, whenToUse, whenNotToUse].filter(Boolean).join('\n'), fill);
}

/** Code-unit order of two definitions by their function name. */
const byName = (a: ToolDefinition, b: ToolDefinition): number =>
  a.function.name < b.function.name ? -1 : a.function.name > b.function.name ? 1 : 0;

/**
 * The entries of her skills (docs/skills.md): one per skill whose tools are all registered and granted (`missing`
 * empty), sorted by name, named by the skill's name, described by its `description` line and then `procedure` (the
 * sentence that a call returns a procedure to follow), with no parameter.
 */
export function skillEntries(skills: ReadonlyArray<OfferedSkill>, procedure = ''): Array<ToolDefinition> {
  return skills
    .filter((skill) => skill.missing.length === 0 && typeof skill.name === 'string' && skill.name !== '')
    .map(
      (skill) =>
        canonicalJson({
          type: 'function',
          function: {
            name: skill.name,
            description: [skill.description, procedure].filter(Boolean).join('\n'),
            parameters: { type: 'object', properties: {} },
          },
        }) as ToolDefinition
    )
    .sort(byName);
}

/**
 * The `tools` array for the skills in `names`: `[{ type: 'function', function: { name, description,
 * parameters } }]` sorted by API name, keys in a fixed order, then the entries of her active `skills` (skillEntries,
 * with `procedure`). A name with no skill in `registry` or no API name is left out. Same input, same bytes.
 * `names` are the dotted skill names granted to the persona. `texts` is `hot.prompts.tools`;
 * `fill` holds the values for the `{{key}}` placeholders of the texts (`{ drawChars }`).
 */
export function buildTools(
  names: Iterable<string> | null | undefined,
  {
    registry = skillRegistry(),
    texts,
    fill,
    skills = [],
    procedure = '',
  }: {
    registry?: SkillMap;
    texts?: unknown;
    fill?: unknown;
    skills?: ReadonlyArray<OfferedSkill>;
    procedure?: string;
  } = {}
): Array<ToolDefinition> {
  const tools: Array<ToolDefinition> = [];
  for (const name of new Set(names ?? [])) {
    const skill = registry.get(name);
    const api = skill ? (skill.api ?? apiNameOf(name)) : null;
    if (!skill || !api) continue;
    tools.push(
      canonicalJson({
        type: 'function',
        function: {
          name: api,
          description: descriptionOf(skill, texts, fill),
          parameters: parametersOf(skill, texts, fill),
        },
      }) as ToolDefinition
    );
  }
  return [...tools.sort(byName), ...skillEntries(skills, procedure)];
}

/** The dotted skill name of a tool call's API name, or null when no skill has it. */
export function skillNameOfToolCall(apiName: unknown): string | null {
  return typeof apiName === 'string' ? skillNameOfApi(apiName) : null;
}

/** One native tool definition as the request carries it. */
export type ToolDefinition = {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
};
