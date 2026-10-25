// The model roles: every LLM request names the role it goes out on, and each role has its own
// model with a built-in default (the same value config.json ships). The models sit in three
// groups, matching the status card:
// - `models.base.<role>`: her core and organs, the roles the bot's own requests go out on;
// - `models.errands.<role>`: the delegated agents, each with its own OpenCode loop, async;
// - `models.development.<role>`: the agents outside her, working on this repository.
// A role never takes another role's model: an unset role is its own default, so changing one role
// can never move another. `models.byPurpose` pins a single purpose (one helper, one kind of
// request) to a model of its own whatever its role.
// models.base
// - `core`       speaks as the persona: the reply;
// - `memory`     her memory session and description review (src/memory/db/session.js); its default
//                is the core's, it is not listed by `/nep model`, and its key never falls back;
// - `analyzer`   the core's helper model: picks one of a few given options (address, room,
//                merge, route-channel, participation-pick, rewatch, split, gif-pick, missed),
//                plans a search and turns sources into notes (lookup, planner, recall-summary,
//                search-summary, read-link, diary-plan) and runs the persona's raw web search
//                on the OpenRouter engine (web-search);
// - `vision`     describes a picture (describe, relook, avatar);
// - `video`      watches a video and looks at it again;
// - `embedding`  turns text into vectors for search by meaning;
// - `speech`     speaks her text aloud (src/speech/, OpenRouter's speech endpoint: no chat completion
//                behind it, so nothing probes it with one);
// - `drawing`    generates the persona's pictures: one Images API request through the bot's own
//                client (src/llm/images.js), no loop, with a bare OpenRouter image model id.
// models.errands
// - `scout`, `server`  the persona's errand agents (src/agent-runner/, profiles `scout` and `server`);
// models.development
// - `thinker`, `dev`, `writer`  the development agents (outside this repository): `thinker` picks
//                up and steers the tasks, `dev` writes the code, `writer` writes the texts.
// No request of the bot goes out on an errand or development role (OPENCODE_ROLES): they run on
// OpenCode, not through the bot's OpenRouter client, and their models are OpenCode model ids
// (`openrouter/<vendor>/<model>`), unlike the bare OpenRouter ids of the base roles.
// Pure; every reader passes the live config read at the moment of use.

import { isPlainObject } from '../config.js';

/** The core: the one role that speaks and decides as the persona, its model under `models.base.core`. */
export const CORE_ROLE = 'core';

/**
 * Her memory session and description review (src/memory/db/session.js): words in her voice, so the role sits beside
 * the core (`models.base.memory`, built-in default the core's), but it is not one of ROLES: `/nep model` does not list it.
 * Its key (`llm.keyByRole.memory`) never falls back to another key.
 */
export const MEMORY_ROLE = 'memory';

/** The memory role's model while `models.base.memory` is unset: the core's built-in default, as config.json ships it. */
export const MEMORY_ROLE_DEFAULT = 'anthropic/claude-opus-4.6';

/** The helper roles, in display order. */
export const HELPER_ROLES = Object.freeze(['analyzer', 'vision', 'video', 'embedding', 'speech']);

/** The roles the bot's chat and embedding requests go out on, in display order: the core, then the helpers. */
export const CORE_ROLES = Object.freeze([CORE_ROLE, ...HELPER_ROLES]);

/** The base roles, in display order: the core, the helpers, then drawing. Their models sit under `models.base`. */
export const BASE_ROLES = Object.freeze([...CORE_ROLES, 'drawing']);

/** The errand roles: their models sit under `models.errands`. */
export const ERRAND_ROLES = Object.freeze(['scout', 'server']);

/** The development roles: their models sit under `models.development`. */
export const DEVELOPMENT_ROLES = Object.freeze(['thinker', 'dev', 'writer']);

/** The roles whose model an OpenCode worker runs on, never the bot's own client. */
export const OPENCODE_ROLES = Object.freeze([...ERRAND_ROLES, ...DEVELOPMENT_ROLES]);

/** The roles, in display order (`/nep model`, the status card). */
export const ROLES = Object.freeze([...BASE_ROLES, ...OPENCODE_ROLES]);

/** Each role's model while its key is unset: config.json's values. */
export const ROLE_DEFAULTS = Object.freeze({
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
  writer: 'openrouter/anthropic/claude-opus-4.6',
});

/**
 * The group of `models` a role's model sits in: `base`, `errands` or `development`, undefined for
 * a name that is not a role.
 * @param {unknown} role
 * @returns {'base'|'errands'|'development'|undefined}
 */
export function roleGroup(role) {
  if (role === MEMORY_ROLE || BASE_ROLES.includes(role)) return 'base';
  if (ERRAND_ROLES.includes(role)) return 'errands';
  if (DEVELOPMENT_ROLES.includes(role)) return 'development';
  return undefined;
}

/**
 * The config keys of a role's model (`['models', 'base', 'vision']`, `['models', 'errands', 'scout']`),
 * undefined for a name that is not a role.
 * @param {unknown} role
 * @returns {string[]|undefined}
 */
export function roleConfigKeys(role) {
  const group = roleGroup(role);
  return group ? ['models', group, role] : undefined;
}

/**
 * The role each named purpose goes out on (the `purpose` of a request, logged on its
 * `llm: usage` line and the key of a `models.byPurpose` entry). Requests with no purpose of their
 * own (a video, an index embedding, a drawing) are not listed: they are named by their role alone.
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
  planner: 'analyzer',
  'recall-summary': 'analyzer',
  'search-summary': 'analyzer',
  'read-link': 'analyzer',
  'diary-plan': 'analyzer',
  speech: 'analyzer',
  'web-search': 'analyzer',
  describe: 'vision',
  relook: 'vision',
  avatar: 'vision',
  'recall-query': 'embedding',
  probe: 'embedding',
});

/**
 * The purposes of the role `memory` (her memory session and description review, src/memory/db/session.js and
 * describe.js): not in PURPOSE_ROLES, as that role is not one of ROLES.
 */
export const MEMORY_PURPOSES = Object.freeze(['memory-session', 'description-draft', 'description-check']);

/**
 * Whether `role` is one of ROLES.
 * @param {unknown} role
 * @returns {boolean}
 */
export function isRole(role) {
  return typeof role === 'string' && ROLES.includes(role);
}

/**
 * The model of one request, the one resolver every caller goes through: the
 * `models.byPurpose` entry for `purpose` when it is a non-empty string (an own key of a
 * plain object), else the role's own key (`models.<group>.<role>`) when it is a non-empty string,
 * else the role's own default (ROLE_DEFAULTS). Never another role's model. `undefined` only for a
 * `role` that is not one of ROLES and no `byPurpose` entry.
 * @param {object|undefined} config  The whole live config, read at the moment of use.
 * @param {string} role
 * @param {string} [purpose]
 * @returns {string|undefined}
 */
export function roleModel(config, role, purpose) {
  const models = isPlainObject(config?.models) ? config.models : undefined;
  const byPurpose = models?.byPurpose;
  if (typeof purpose === 'string' && isPlainObject(byPurpose) && Object.hasOwn(byPurpose, purpose)) {
    const pinned = byPurpose[purpose];
    if (typeof pinned === 'string' && pinned) return pinned;
  }
  const group = roleGroup(role);
  if (!group) return undefined;
  const map = models && Object.hasOwn(models, group) && isPlainObject(models[group]) ? models[group] : undefined;
  const own = map && Object.hasOwn(map, role) ? map[role] : undefined;
  return typeof own === 'string' && own ? own : (role === MEMORY_ROLE ? MEMORY_ROLE_DEFAULT : ROLE_DEFAULTS[role]);
}
