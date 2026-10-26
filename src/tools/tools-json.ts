// The skills as native tool definitions (OpenAI chat-completions `tools`): built from the registry
// rows granted to the persona, the wording from the skills layer (`hot.prompts.skills`, read by the
// caller at the moment of use). Our names stay dotted everywhere; only this boundary carries the API
// name (`draw.create` <-> `draw_create`, src/tools/definitions.ts). `buildTools` serves the live turn
// (src/behavior/turn.js) and the replay sandbox (src/behavior/sandbox.js); `canonicalJson` also keeps the
// text transport's description stable (src/llm/tool-text.js).

import { skillRegistry, describeSkill, skillArgTexts } from './registry.ts';
import { apiNameOf, skillNameOfApi } from './definitions.ts';

/** `value` with every object's keys in sorted order (arrays keep theirs): one stable JSON per definition set. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])])
    );
  }
  return value;
}

/** `text` with every `{{key}}` of `fill` replaced (an own key with a non-null value); other placeholders stay. */
function filled(text, fill) {
  if (!fill || typeof fill !== 'object') return text;
  return String(text).replace(/\{\{(\w+)\}\}/g, (all, key) =>
    Object.hasOwn(fill, key) && fill[key] != null ? String(fill[key]) : all
  );
}

const DEFAULT_STRING_MAX = 6000;

/**
 * A copy of a validation schema for the model: the keywords only the engine's validator needs
 * (`minLength: 1`, the default `maxLength` of 6000, `additionalProperties: false`) are left out;
 * type, enum, bounds, required and descriptions stay. The engine still validates with the full one.
 */
function leanSchema(node) {
  if (Array.isArray(node)) return node.map(leanSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'minLength' && value === 1) continue;
    if (key === 'maxLength' && value === DEFAULT_STRING_MAX) continue;
    if (key === 'additionalProperties' && value === false) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, leanSchema(sub)]));
    } else {
      out[key] = key === 'enum' || key === 'required' ? value : leanSchema(value);
    }
  }
  return out;
}

/** The skill's lean parameter schema with each argument's `description` from the skills layer, when it has one. */
function parametersOf(skill, texts, fill) {
  const schema = JSON.parse(JSON.stringify(skill.argsSchema));
  const described = skillArgTexts(skill, texts);
  for (const [name, text] of Object.entries(described)) {
    if (schema.properties && Object.hasOwn(schema.properties, name))
      schema.properties[name].description = filled(text, fill);
  }
  return leanSchema(schema);
}

/** Title, when to use and when not to, one per line, the empty ones left out. */
function descriptionOf(skill, texts, fill) {
  const { title, whenToUse, whenNotToUse } = describeSkill(skill, texts);
  return filled([title, whenToUse, whenNotToUse].filter(Boolean).join('\n'), fill);
}

/**
 * The `tools` array for the skills in `names`: `[{ type: 'function', function: { name, description,
 * parameters } }]` sorted by API name, keys in a fixed order. A name with no skill in `registry` or
 * no API name is left out. Same input, same bytes.
 * @param {string[]} names  Dotted skill names granted to the persona.
 * @param {{ registry?: Map<string, object>, texts?: object, fill?: object }} [options]  `texts`: `hot.prompts.skills`;
 *   `fill`: values for the `{{key}}` placeholders of the texts (`{ drawChars }`).
 * @returns {object[]}
 */
export function buildTools(names, { registry = skillRegistry(), texts, fill } = {}) {
  const tools = [];
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
      })
    );
  }
  return tools.sort((a, b) => (a.function.name < b.function.name ? -1 : a.function.name > b.function.name ? 1 : 0));
}

/** The dotted skill name of a tool call's API name, or null when no skill has it. */
export function skillNameOfToolCall(apiName) {
  return typeof apiName === 'string' ? skillNameOfApi(apiName) : null;
}
