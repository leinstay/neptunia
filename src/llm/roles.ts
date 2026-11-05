// The model roles: every LLM request names the model role it goes out on, and each model role has its own
// model with a built-in default (the same value config.json ships). The models sit in three
// groups, matching the status card:
// - `models.base.<role>`: her `core` and the other model roles, the model roles the bot's own requests go out on;
// - `models.errands.<role>`: the delegated agents, each with its own OpenCode loop, async;
// - `models.development.<role>`: the agents outside her, working on this repository.
// A model role never takes another model role's model: an unset model role is its own default, so
// changing one model role can never move another. `models.byPurpose` pins a single purpose (one role
// request, one kind of request) to a model of its own whatever its model role.
// models.base
// - `core`       speaks as the persona: the reply;
// - `memory`     her memory session and description review (src/memory/db/session.ts); its default
//                is the core's, it is not listed by `/nep model`, and its key never falls back;
// - `analyzer`   the core's classifier model: picks one of a few given options (address, room,
//                merge, route-channel, participation-pick, rewatch, split, gif-pick, missed),
//                plans a search and turns sources into notes (lookup, recall-summary,
//                search-summary, diary-plan);
// - `vision`     describes a picture (describe, relook, avatar);
// - `video`      watches a video and looks at it again;
// - `embedding`  turns text into vectors for search by meaning;
// - `speech`     speaks her text aloud (src/speech/, OpenRouter's speech endpoint: no chat completion
//                behind it, so nothing probes it with one);
// - `drawing`    generates the persona's pictures: one Images API request through the bot's own
//                client (src/llm/images.ts), no loop, with a bare OpenRouter image model id.
// models.errands
// - `scout`, `server`  the persona's errand agents (src/agent-runner/, profiles `scout` and `server`);
// models.development
// - `thinker`, `dev`  the development agents (outside this repository): `thinker` picks up and
//                steers the tasks, `dev` writes the code and the texts.
// No request of the bot goes out on an errand or development model role (OPENCODE_ROLES): they run on
// OpenCode, not through the bot's OpenRouter client, and their models are OpenCode model ids
// (`openrouter/<vendor>/<model>`), unlike the bare OpenRouter ids of the base model roles.
// `models.abilities.<model id>` lists what a model can do (modelAbilities), and ROLE_ABILITY names the ability each
// base role serves: the tool gateway routes a down tool role to the core model by them (src/tools/gateway.ts).
// Pure; every reader passes the live config read at the moment of use.

import { isObj, objOf } from '../tools/types.ts';

/** The core: the one model role that speaks and decides as the persona, its model under `models.base.core`. */
export const CORE_ROLE = 'core';

/**
 * Her memory session and description review (src/memory/db/session.ts): words in her voice, so the model role sits beside
 * the core (`models.base.memory`, built-in default the core's), but it is not one of ROLES: `/nep model` does not list it.
 * Its key (`llm.keyByRole.memory`) never falls back to another key.
 */
export const MEMORY_ROLE = 'memory';

/** The memory role's model while `models.base.memory` is unset: the core's built-in default, as config.json ships it. */
export const MEMORY_ROLE_DEFAULT = 'anthropic/claude-opus-4.6';

/**
 * Quick search's own binding target and request role: a key bound to it (`/keys bind search <name>`) leaves the analyzer's
 * key alone, and unbinding it goes back to the core keys. Its model is the setting `web.search.model`.
 */
export const SEARCH_ROLE = 'search';

/** The model of quick search and of the scout's web search; undefined until the owner sets one, as it has no default. */
export function searchModel(config: unknown): string | undefined {
  const model = objOf(objOf(objOf(config).web).search).model;
  return typeof model === 'string' && model !== '' ? model : undefined;
}

/** The model roles other than `core` that a turn calls, in display order. */
export const NON_CORE_ROLES = Object.freeze(['analyzer', 'vision', 'video', 'embedding', 'speech']);

/** The model roles the bot's chat and embedding requests go out on, in display order: the core, then the model roles other than `core`. */
export const CORE_ROLES = Object.freeze([CORE_ROLE, ...NON_CORE_ROLES]);

/** The base model roles, in display order: the core, NON_CORE_ROLES, then drawing. Their models sit under `models.base`. */
export const BASE_ROLES = Object.freeze([...CORE_ROLES, 'drawing']);

/** The errand model roles: their models sit under `models.errands`. */
export const ERRAND_ROLES = Object.freeze(['scout', 'server']);

/** The development model roles: their models sit under `models.development`. */
export const DEVELOPMENT_ROLES = Object.freeze(['thinker', 'dev']);

/** The model roles whose model an OpenCode worker runs on, never the bot's own client. */
export const OPENCODE_ROLES = Object.freeze([...ERRAND_ROLES, ...DEVELOPMENT_ROLES]);

/** The model roles, in display order (`/nep model`, the status card). */
export const ROLES = Object.freeze([...BASE_ROLES, ...OPENCODE_ROLES]);

/** The base roles that are always on: without them there is no persona. A null model for one is refused by the settings check. */
export const MANDATORY_ROLES = Object.freeze(['core', 'memory', 'analyzer', 'embedding'] as const);

/** The base roles an owner may leave off, in the order of the tool roles. Off while `models.base.<role>` is null, false or empty. */
export const OPTIONAL_ROLES = Object.freeze(['vision', 'video', 'drawing', 'speech'] as const);

/** Each model role's model while its key is unset: config.json's values. */
export const ROLE_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  core: 'anthropic/claude-opus-4.6',
  analyzer: 'openai/gpt-6.1-sol',
  vision: 'google/gemini-3.8-flash',
  video: 'google/gemini-3.8-flash',
  embedding: 'openai/text-embedding-3-large',
  speech: 'elevenlabs/eleven-v4',
  drawing: 'openai/gpt-image-2.5-flare',
  scout: 'openrouter/openai/gpt-6.1-sol',
  server: 'openrouter/openai/gpt-6.1-sol',
  thinker: 'openrouter/anthropic/claude-opus-5.5',
  dev: 'openrouter/anthropic/claude-sonnet-5.5',
});

/** What a model can do, as `models.abilities.<model id>` lists it. */
export const ABILITIES = Object.freeze(['text', 'imagesIn', 'imagesOut', 'videoIn', 'audioOut', 'embeddings']);

/** The ability each base model role other than `core` and `memory` serves. */
export const ROLE_ABILITY = Object.freeze({
  analyzer: 'text',
  vision: 'imagesIn',
  video: 'videoIn',
  embedding: 'embeddings',
  speech: 'audioOut',
  drawing: 'imagesOut',
});

/**
 * What `model` can do: the known abilities of its `models.abilities.<model id>` list (the local layer may add one or
 * replace it), `['text']` for a model without one.
 * @param config The whole live config, read at the moment of use.
 */
export function modelAbilities(config: unknown, model: unknown): Array<string> {
  const table = objOf(objOf(config).models).abilities;
  const listed: unknown =
    typeof model === 'string' && isObj(table) && Object.hasOwn(table, model) ? table[model] : null;
  if (!Array.isArray(listed)) return ['text'];
  return ABILITIES.filter((ability) => listed.includes(ability));
}

/**
 * The group of `models` a model role's model sits in: `base`, `errands` or `development`, undefined for
 * a name that is not a model role.
 */
export function roleGroup(role: unknown): 'base' | 'errands' | 'development' | undefined {
  if (typeof role !== 'string') return undefined;
  if (role === MEMORY_ROLE || BASE_ROLES.includes(role)) return 'base';
  if (ERRAND_ROLES.includes(role)) return 'errands';
  if (DEVELOPMENT_ROLES.includes(role)) return 'development';
  return undefined;
}

/**
 * The config keys of a model role's model (`['models', 'base', 'vision']`, `['models', 'errands', 'scout']`),
 * undefined for a name that is not a model role.
 */
export function roleConfigKeys(role: unknown): Array<string> | undefined {
  const group = roleGroup(role);
  return group ? ['models', group, String(role)] : undefined;
}

/**
 * The model role each named purpose goes out on (the `purpose` of a request, logged on its
 * `llm: usage` line and the key of a `models.byPurpose` entry). Requests with no purpose of their
 * own (a video, an index embedding, a drawing) are not listed: they are named by their model role alone.
 */
export const PURPOSE_ROLES = Object.freeze({
  reply: 'core',
  address: 'analyzer',
  room: 'analyzer',
  merge: 'analyzer',
  'route-channel': 'analyzer',
  'participation-pick': 'analyzer',
  rewatch: 'analyzer',
  split: 'analyzer',
  'gif-pick': 'analyzer',
  missed: 'analyzer',
  lookup: 'analyzer',
  'recall-summary': 'analyzer',
  'search-summary': 'analyzer',
  'diary-plan': 'analyzer',
  speech: 'analyzer',
  // Usage rows and `models.byPurpose` pins written before quick search took its own name still read as this.
  'web-search': 'analyzer',
  'quick-search': 'analyzer',
  describe: 'vision',
  relook: 'vision',
  avatar: 'vision',
  'recall-query': 'embedding',
  probe: 'embedding',
});

/**
 * The purposes of the model role `memory` (her memory session and description review, src/memory/db/session.ts and
 * describe.js): not in PURPOSE_ROLES, as that model role is not one of ROLES.
 */
export const MEMORY_PURPOSES = Object.freeze(['memory-session', 'description-draft', 'description-check']);

/** Whether `role` is one of ROLES. */
export function isRole(role: unknown): boolean {
  return typeof role === 'string' && ROLES.includes(role);
}

/**
 * The model of one request, the one resolver every caller goes through: the
 * `models.byPurpose` entry for `purpose` when it is a non-empty string (an own key of a
 * plain object), else the model role's own key (`models.<group>.<role>`) when it is a non-empty string,
 * else the model role's own default (ROLE_DEFAULTS). Never another model role's model. `undefined` only for a
 * `role` that is not one of ROLES and no `byPurpose` entry.
 * @param config The whole live config, read at the moment of use.
 */
/** A model on the direct path as a source-qualified selection, as readiness records its check. */
export const directSelectionOf = (model: string): string => `openrouter:${model}`;

export function roleModel(config: unknown, role: string, purpose?: string): string | undefined {
  if (OPTIONAL_ROLES.includes(role as (typeof OPTIONAL_ROLES)[number]) && !roleOn(config, role)) return undefined;
  const models = objOf(config).models;
  const byPurpose = objOf(models).byPurpose;
  if (typeof purpose === 'string' && isObj(byPurpose) && Object.hasOwn(byPurpose, purpose)) {
    const pinned = byPurpose[purpose];
    if (typeof pinned === 'string' && pinned) return pinned;
  }
  const group = roleGroup(role);
  if (!group) return undefined;
  const groupMap = objOf(models)[group];
  const map = isObj(models) && Object.hasOwn(models, group) && isObj(groupMap) ? groupMap : undefined;
  const own = map && Object.hasOwn(map, role) ? map[role] : undefined;
  return typeof own === 'string' && own ? own : role === MEMORY_ROLE ? MEMORY_ROLE_DEFAULT : ROLE_DEFAULTS[role];
}

/**
 * Whether `role` is on. A mandatory role is always on. An optional role is on when `models.base.<role>` is a
 * non-empty string, and off when it is null, false or empty. An absent key is on with the role's built-in default, so
 * a config that names no models keeps working. Any other name is on.
 * @param config The whole live config, read at the moment of use.
 */
export function roleOn(config: unknown, role: string): boolean {
  if (!OPTIONAL_ROLES.includes(role as (typeof OPTIONAL_ROLES)[number])) return true;
  const base = objOf(objOf(config).models).base;
  if (!isObj(base) || !Object.hasOwn(base, role)) return true;
  const own = base[role];
  return typeof own === 'string' && own !== '';
}

/** The optional roles that are off, in the order of OPTIONAL_ROLES. */
export function offRoles(config: unknown): Array<string> {
  return OPTIONAL_ROLES.filter((role) => !roleOn(config, role));
}

/** The reasoning efforts a role or an agent runs at, OpenRouter's `reasoning.effort` levels that every backend takes. */
export const EFFORT_LEVELS = ['low', 'medium', 'high'] as const;

/** What keys.json can hold: EFFORT_LEVELS and the levels a CLI takes only when its own `--help` lists them. */
export const LISTED_EFFORT_LEVELS = [...EFFORT_LEVELS, 'xhigh', 'max'] as const;
export type EffortLevel = (typeof LISTED_EFFORT_LEVELS)[number];

/** Whether `value` is one of EFFORT_LEVELS. */
export const isEffortLevel = (value: unknown): value is (typeof EFFORT_LEVELS)[number] =>
  EFFORT_LEVELS.some((level) => level === value);

/** Whether `value` is one of LISTED_EFFORT_LEVELS. */
export const isListedEffort = (value: unknown): value is EffortLevel =>
  LISTED_EFFORT_LEVELS.some((level) => level === value);

/**
 * The base roles whose requests take OpenRouter's `reasoning.effort`: the chat completions other than the core's. The
 * core is left out on purpose, the owner's rule (2026-10-19): her written `<think>` is her thinking, never provider
 * reasoning. `embedding`, `speech` and `drawing` go to endpoints that take no reasoning.
 */
export const REASONING_ROLES: ReadonlyArray<string> = Object.freeze(['memory', 'analyzer', 'vision', 'video']);

/**
 * The `reasoning` of a request for `role`: `llm.reasoningByRole.<role>` when the role is one of REASONING_ROLES and the
 * entry holds a known effort, else undefined.
 * @param config The whole live config, read at the moment of use.
 */
export function reasoningOf(config: unknown, role: string): { effort: EffortLevel } | undefined {
  if (!REASONING_ROLES.includes(role)) return undefined;
  const byRole = objOf(objOf(config).llm).reasoningByRole;
  const entry: unknown = isObj(byRole) && Object.hasOwn(byRole, role) ? byRole[role] : undefined;
  const effort: unknown = isObj(entry) ? entry.effort : undefined;
  return isEffortLevel(effort) ? { effort } : undefined;
}
