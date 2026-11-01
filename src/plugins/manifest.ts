// `plugin.json`: what the core accepts as the declaration of a plugin. `parseManifest` takes the file's text and the
// name of the folder it sits in and answers the manifest, or the one code of what is wrong with it. The tools it
// declares are the only ones the registry (src/plugins/registry.ts) takes from the plugin. Pure; never throws.

import { TOOL_COSTS, TOOL_EFFECTS } from '../protocol/plugin.ts';
import type { PluginManifest, ToolDeclaration, ToolRights } from '../protocol/plugin.ts';

export type ManifestCode =
  | 'not-json'
  | 'not-object'
  | 'bad-name'
  | 'name-mismatch'
  | 'no-description'
  | 'bad-tools'
  | 'bad-tool'
  | 'tool-prefix'
  | 'tool-repeated'
  | 'bad-env'
  | 'bad-skills';

const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const UPPER_SNAKE = /^[A-Z][A-Z0-9_]*$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

function rightsOf(value: unknown): ToolRights | null {
  if (!isObject(value) || (value.kind !== 'read' && value.kind !== 'write')) return null;
  if (value.ownerOnly !== undefined && typeof value.ownerOnly !== 'boolean') return null;
  if (value.member !== undefined && typeof value.member !== 'boolean') return null;
  return {
    kind: value.kind,
    ...(value.ownerOnly === undefined ? {} : { ownerOnly: value.ownerOnly }),
    ...(value.member === undefined ? {} : { member: value.member }),
  };
}

/** The declaration `value` stands for, or null when a field is missing or of the wrong type. */
export function declarationOf(value: unknown): ToolDeclaration | null {
  if (!isObject(value) || !isText(value.name) || !isObject(value.schema) || !isObject(value.wording)) return null;
  const { title, whenToUse, whenNotToUse } = value.wording;
  if (typeof title !== 'string' || typeof whenToUse !== 'string' || typeof whenNotToUse !== 'string') return null;
  const { effect, cost } = value;
  const effects: ReadonlyArray<unknown> = TOOL_EFFECTS;
  const costs: ReadonlyArray<unknown> = TOOL_COSTS;
  if (!effects.includes(effect) || !costs.includes(cost)) return null;
  const rights = rightsOf(value.rights);
  if (rights === null) return null;
  return {
    name: value.name,
    schema: value.schema,
    wording: { title, whenToUse, whenNotToUse },
    effect: effect as ToolDeclaration['effect'],
    cost: cost as ToolDeclaration['cost'],
    rights,
  };
}

function listOf(value: unknown, pattern: RegExp): Array<string> | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === 'string' && pattern.test(item)) ? (value as Array<string>) : null;
}

export function parseManifest(
  text: string,
  folder: string
): { ok: true; manifest: PluginManifest } | { ok: false; code: ManifestCode } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: 'not-json' };
  }
  if (!isObject(parsed)) return { ok: false, code: 'not-object' };
  const { name, description } = parsed;
  if (typeof name !== 'string' || !KEBAB.test(name)) return { ok: false, code: 'bad-name' };
  if (name !== folder) return { ok: false, code: 'name-mismatch' };
  if (!isText(description)) return { ok: false, code: 'no-description' };
  if (!Array.isArray(parsed.tools)) return { ok: false, code: 'bad-tools' };
  const tools: Array<ToolDeclaration> = [];
  for (const entry of parsed.tools) {
    const tool = declarationOf(entry);
    if (tool === null) return { ok: false, code: 'bad-tool' };
    if (!tool.name.startsWith(`${name}.`)) return { ok: false, code: 'tool-prefix' };
    if (tools.some((known) => known.name === tool.name)) return { ok: false, code: 'tool-repeated' };
    tools.push(tool);
  }
  const env = listOf(parsed.env, UPPER_SNAKE);
  if (env === null) return { ok: false, code: 'bad-env' };
  const skills = listOf(parsed.skills, KEBAB);
  if (skills === null) return { ok: false, code: 'bad-skills' };
  return { ok: true, manifest: { name, description, tools, env, skills } };
}
