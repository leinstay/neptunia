// The model roles: every LLM request names the role it goes out on, and each role has its own
// model with a built-in default (the same value config.json ships). The models sit in three
// places: `models.core` for the core (the one model that speaks and decides as the persona),
// `models.helpers.<role>` for the helper roles (thinking for it, seeing, extracting, embedding) and
// `models.agents.<role>` for the agents. A role never takes another role's model: an unset role
// is its own default, so changing one role can never move another. `models.byPurpose` pins
// a single purpose (one helper, one kind of request) to a model of its own whatever its role.
// The role names are what the request does:
// models.core
// - `core`       speaks as the persona: the reply and the memory texts worded in its voice
//                (formerly the role `core`, 2026-10: the old key and role name are read as
//                aliases by src/config.js#adaptLegacyModelKeys and src/llm/openrouter.js#currentRoleName);
// models.helpers
// - `analyzer`   the core's helper model: picks one of a few given options (address, room,
//                merge, route-channel, participation-pick, rewatch, split, gif-pick, missed),
//                plans a search and turns sources into notes (lookup, planner, recall-summary,
//                search-summary, read-link, diary-plan) and runs the persona's raw web search
//                on the OpenRouter engine (web-search). The former `reasoner` role is merged
//                into it (2026-10): its purposes keep their names, for `byPurpose` and the logs;
// - `extractor`  turns conversations into stored memory: the memory analyzer's batches, the
//                portraits' stage A, the channel and server notes, the warmup, the backfill;
// - `vision`     describes a picture (describe, relook, avatar);
// - `video`      watches a video and looks at it again;
// - `embedding`  turns text into vectors for search by meaning;
// - `speech`    speaks her text aloud (src/speech/, OpenRouter's speech endpoint: no chat completion
//                behind it, so nothing probes it with one);
// models.agents
// - `web`, `server`  run the persona's errand agents (src/agent-runner/, profiles `web` and
//                `server`);
// - `thinker`, `dev`, `writer`  the development agents (outside this repository): `thinker` picks
//                up and steers the tasks, `dev` writes the code, `writer` writes the texts;
// - `drawing`    generates the persona's pictures (for now through the bot's own Images client,
//                src/llm/images.js, with a bare OpenRouter image model id).
// No request of the bot goes out on `web`, `server`, `thinker`, `dev` or `writer` (OPENCODE_ROLES): they run on
// OpenCode, not through the bot's OpenRouter client, and their models are OpenCode model ids
// (`openrouter/<vendor>/<model>`), unlike the bare OpenRouter ids of the other roles.
// A config that still carries the old flat `roles` map, or a model for the merged `reasoner`
// role, is refused at load (src/config.js); one that still carries `models.base.*` is read
// under the new keys with one warning.
// Pure; every reader passes the live config read at the moment of use.

import { isPlainObject } from '../config.js';

/** The core: the one role that speaks and decides as the persona, its model under `models.core`. */
export const CORE_ROLE = 'core';

/**
 * Her memory session and description review (src/memory/db/session.js): words in her voice, so the role sits beside
 * the core (`models.memory`, built-in default the core's), but it is not one of ROLES: `/nep model` does not list it.
 * Its key (`llm.keyByRole.memory`) never falls back to another key.
 */
export const MEMORY_ROLE = 'memory';

/** The memory role's model while `models.memory` is unset: the core's built-in default, as config.json ships it. */
export const MEMORY_ROLE_DEFAULT = 'anthropic/claude-opus-4.6';

/** The helper roles, in display order: their models under `models.helpers`. */
export const HELPER_ROLES = Object.freeze(['analyzer', 'extractor', 'vision', 'video', 'embedding', 'speech']);

/** The core's own roles (the core, then the helpers), in display order: the roles the bot's own requests go out on besides drawing. */
export const CORE_ROLES = Object.freeze([CORE_ROLE, ...HELPER_ROLES]);

/** The roles whose model an OpenCode worker runs on, never the bot's own client. */
export const OPENCODE_ROLES = Object.freeze(['web', 'server', 'thinker', 'dev', 'writer']);

/** The agents' roles, in display order: their models under `models.agents`. */
export const AGENT_ROLES = Object.freeze([...OPENCODE_ROLES, 'drawing']);

/** The roles, in display order (`/nep model`, the status card). */
export const ROLES = Object.freeze([...CORE_ROLES, ...AGENT_ROLES]);

/** Each role's model while its key is unset: config.json's values. */
export const ROLE_DEFAULTS = Object.freeze({
  core: 'anthropic/claude-opus-4.6',
  analyzer: 'openai/gpt-6.1-sol',
  extractor: 'openai/gpt-6.1-sol',
  vision: 'google/gemini-3.8-flash',
  video: 'google/gemini-3.8-flash',
  embedding: 'openai/text-embedding-3-large',
  speech: 'elevenlabs/eleven-v4',
  web: 'openrouter/openai/gpt-6.1-sol',
  server: 'openrouter/openai/gpt-6.1-sol',
  thinker: 'openrouter/anthropic/claude-opus-5.5',
  dev: 'openrouter/anthropic/claude-sonnet-5.5',
  writer: 'openrouter/anthropic/claude-opus-4.6',
  drawing: 'openai/gpt-image-2.5-flare',
});

/**
 * The section of `models` a role's model sits in: `core` (the core's model is `models.core`
 * itself), `helpers` or `agents`, undefined for a name that is not a role.
 * @param {unknown} role
 * @returns {'core'|'helpers'|'agents'|undefined}
 */
export function roleSection(role) {
  if (role === CORE_ROLE || role === MEMORY_ROLE) return 'core';
  if (HELPER_ROLES.includes(role)) return 'helpers';
  if (AGENT_ROLES.includes(role)) return 'agents';
  return undefined;
}

/**
 * The config keys of a role's model (`['models', 'core']`, `['models', 'helpers', 'vision']`,
 * `['models', 'agents', 'web']`), undefined for a name that is not a role.
 * @param {unknown} role
 * @returns {string[]|undefined}
 */
export function roleConfigKeys(role) {
  const section = roleSection(role);
  if (!section) return undefined;
  return section === 'core' ? ['models', role] : ['models', section, role];
}

/**
 * The role each named purpose goes out on (the `purpose` of a request, logged on its
 * `llm: usage` line and the key of a `models.byPurpose` entry). Requests with no purpose of their
 * own (the memory analyzer's batches, the warmup family, a video, an index embedding, a drawing)
 * are not listed: they are named by their role alone.
 */
export const PURPOSE_ROLES = Object.freeze({
  reply: 'core',
  'memory-voice': 'core',
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
  backfill: 'extractor',
  describe: 'vision',
  relook: 'vision',
  avatar: 'vision',
  'recall-query': 'embedding',
  probe: 'embedding',
});

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
 * plain object), else the role's own key (`models.core`, `models.helpers.<role>` or
 * `models.agents.<role>`) when it is a non-empty string, else the role's own default
 * (ROLE_DEFAULTS). Never another role's model. `undefined` only for a `role` that is not one of
 * ROLES and no `byPurpose` entry. The old keys (`models.base.*`) are not read here: a
 * config.local.json still holding them is moved at load (src/config.js#adaptLegacyModelKeys).
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
  const section = roleSection(role);
  if (!section) return undefined;
  let own;
  if (section === 'core') {
    own = models && Object.hasOwn(models, role) ? models[role] : undefined;
  } else {
    const map = models && Object.hasOwn(models, section) && isPlainObject(models[section]) ? models[section] : undefined;
    own = map && Object.hasOwn(map, role) ? map[role] : undefined;
  }
  return typeof own === 'string' && own ? own : (role === MEMORY_ROLE ? MEMORY_ROLE_DEFAULT : ROLE_DEFAULTS[role]);
}
