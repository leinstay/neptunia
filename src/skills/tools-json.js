// The skills as native tool definitions (OpenAI chat-completions `tools`): built from the registry
// rows granted to the persona, the wording from the skills layer (`hot.prompts.skills`, read by the
// caller at the moment of use). Our names stay dotted everywhere; only this boundary carries the API
// name (`draw.create` <-> `draw_create`, src/skills/definitions.js). Nothing uses it in a turn yet.

import { skillRegistry, describeSkill, skillArgTexts } from './registry.js';
import { apiNameOf, skillNameOfApi } from './definitions.js';

/** `value` with every object's keys in sorted order (arrays keep theirs): one stable JSON per definition set. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

/** The skill's parameter schema with each argument's `description` from the skills layer, when it has one. */
function parametersOf(skill, texts) {
  const schema = JSON.parse(JSON.stringify(skill.argsSchema));
  const described = skillArgTexts(skill, texts);
  for (const [name, text] of Object.entries(described)) {
    if (schema.properties && Object.hasOwn(schema.properties, name)) schema.properties[name].description = text;
  }
  return schema;
}

/** Title, when to use and when not to, one per line, the empty ones left out. */
function descriptionOf(skill, texts) {
  const { title, whenToUse, whenNotToUse } = describeSkill(skill, texts);
  return [title, whenToUse, whenNotToUse].filter(Boolean).join('\n');
}

/**
 * The `tools` array for the skills in `names`: `[{ type: 'function', function: { name, description,
 * parameters } }]` sorted by API name, keys in a fixed order. A name with no skill in `registry` or
 * no API name is left out. Same input, same bytes.
 * @param {string[]} names  Dotted skill names granted to the persona.
 * @param {{ registry?: Map<string, object>, texts?: object }} [options]  `texts`: `hot.prompts.skills`.
 * @returns {object[]}
 */
export function buildTools(names, { registry = skillRegistry(), texts } = {}) {
  const tools = [];
  for (const name of new Set(names ?? [])) {
    const skill = registry.get(name);
    const api = skill ? (skill.api ?? apiNameOf(name)) : null;
    if (!skill || !api) continue;
    tools.push(canonicalJson({
      type: 'function',
      function: { name: api, description: descriptionOf(skill, texts), parameters: parametersOf(skill, texts) },
    }));
  }
  return tools.sort((a, b) => (a.function.name < b.function.name ? -1 : a.function.name > b.function.name ? 1 : 0));
}

/** The dotted skill name of a tool call's API name, or null when no skill has it. */
export function skillNameOfToolCall(apiName) {
  return typeof apiName === 'string' ? skillNameOfApi(apiName) : null;
}
