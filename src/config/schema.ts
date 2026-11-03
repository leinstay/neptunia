// The settings schema: every key of config/config.json with its JSON types, its reader (the module that reads it),
// its default and one line of text. A map, a section whose keys are free (`bot.access`, `models.abilities`), is one
// entry of type `map`. A segment `*` stands for any one name (`interfaces.*.enabled`) and gives no default. The
// entries live in src/config/schema/<section>.ts, one file per top-level section. `schemaDefaults` gives the settings
// the defaults make, which tests/config-schema.test.ts holds equal to config/config.json; src/config/check.ts checks a
// local layer and the readers against the schema, and scripts/config-doc.ts writes docs/configuration.md from it.

import { INTERFACES } from './schema/interfaces.ts';
import { BOT } from './schema/bot.ts';
import { MODELS } from './schema/models.ts';
import { LLM } from './schema/llm.ts';
import { MEMORY_DB } from './schema/memory-db.ts';
import { EMBED } from './schema/embed.ts';
import { CONTEXT } from './schema/context.ts';
import { MENTION } from './schema/mention.ts';
import { MISSED } from './schema/missed.ts';
import { TYPING } from './schema/typing.ts';
import { PACE } from './schema/pace.ts';
import { FORMAT } from './schema/format.ts';
import { SPLIT } from './schema/split.ts';
import { ROUTE } from './schema/route.ts';
import { MEMORY } from './schema/memory.ts';
import { MEDIA } from './schema/media.ts';
import { WEB } from './schema/web.ts';
import { PARTICIPATION } from './schema/participation.ts';
import { RECALL } from './schema/recall.ts';
import { IMAGE } from './schema/image.ts';
import { SPEECH } from './schema/speech.ts';
import { TOOLS } from './schema/tools.ts';
import { SKILLS } from './schema/skills.ts';
import { WATCHER } from './schema/watcher.ts';
import { SELFIMPROVEMENT } from './schema/selfimprovement.ts';
import { SELFREFLECTION } from './schema/selfreflection.ts';
import { GIFS } from './schema/gifs.ts';
import { PRIVATE } from './schema/private.ts';
import { ERRANDS } from './schema/errands.ts';
import { AGENTS } from './schema/agents.ts';
import { BOARD } from './schema/board.ts';
import { INTENTIONS } from './schema/intentions.ts';
import { WAKES } from './schema/wakes.ts';
import { HEARTBEAT } from './schema/heartbeat.ts';
import { APPEND_STORE } from './schema/append-store.ts';
import { ARCHIVE } from './schema/archive.ts';

export type ConfigType = 'boolean' | 'number' | 'string' | 'array' | 'null' | 'map';

export type SchemaEntry = {
  /** The dotted key; a map is one entry and its keys are free. */
  key: string;
  /** The JSON types the value may have; a nullable key lists `null` beside its type. */
  types: ReadonlyArray<ConfigType>;
  /** The repository-relative path of the module that reads the key. */
  reader: string;
  default: unknown;
  /** One line. */
  text: string;
};

/** Every key of the settings, in the order of config/config.json. */
export const CONFIG_SCHEMA: ReadonlyArray<SchemaEntry> = [
  ...INTERFACES,
  ...BOT,
  ...MODELS,
  ...LLM,
  ...MEMORY_DB,
  ...EMBED,
  ...CONTEXT,
  ...MENTION,
  ...MISSED,
  ...TYPING,
  ...PACE,
  ...FORMAT,
  ...SPLIT,
  ...ROUTE,
  ...MEMORY,
  ...MEDIA,
  ...WEB,
  ...PARTICIPATION,
  ...RECALL,
  ...IMAGE,
  ...SPEECH,
  ...TOOLS,
  ...SKILLS,
  ...WATCHER,
  ...SELFIMPROVEMENT,
  ...SELFREFLECTION,
  ...GIFS,
  ...PRIVATE,
  ...ERRANDS,
  ...AGENTS,
  ...BOARD,
  ...INTENTIONS,
  ...WAKES,
  ...HEARTBEAT,
  ...APPEND_STORE,
  ...ARCHIVE,
];

const isTree = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The nested settings object the defaults give; a map entry holds its whole default object. */
export function schemaDefaults(schema: ReadonlyArray<SchemaEntry>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of schema) {
    const keys = entry.key.split('.');
    if (keys.includes('*')) continue;
    let node = out;
    for (const key of keys.slice(0, -1)) {
      const next = node[key];
      node = isTree(next) ? next : (node[key] = {});
    }
    node[keys[keys.length - 1] ?? ''] = structuredClone(entry.default);
  }
  return out;
}
