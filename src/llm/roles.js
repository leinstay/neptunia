// The model roles: every LLM request names the role it goes out on, and each role has its own
// model with a built-in default (the same value config.json ships). The models sit in two
// sections: `models.base.<role>` for the core's own roles (thinking, seeing, speech) and
// `models.agents.<role>` for the agents. A role never takes another role's model: an unset role
// is its own default, so changing one role can never move another. `models.base.byPurpose` pins
// a single purpose (one helper, one kind of request) to a model of its own whatever its role.
// The role names are what the request does:
// models.base
// - `voice`      speaks as the persona: the reply and the memory texts worded in its voice;
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
// role, is refused at load (src/config.js).
// Pure; every reader passes the live config read at the moment of use.

import { isPlainObject } from '../config.js';

/** The core's roles, in display order: their models under `models.base`. */
export const BASE_ROLES = Object.freeze(['voice', 'analyzer', 'extractor', 'vision', 'video', 'embedding']);

/** The roles whose model an OpenCode worker runs on, never the bot's own client. */
export const OPENCODE_ROLES = Object.freeze(['web', 'server', 'thinker', 'dev', 'writer']);

/** The agents' roles, in display order: their models under `models.agents`. */
export const AGENT_ROLES = Object.freeze([...OPENCODE_ROLES, 'drawing']);

/** The roles, in display order (`/nep model`, the status card). */
export const ROLES = Object.freeze([...BASE_ROLES, ...AGENT_ROLES]);

/** Each role's model while its key is unset: config.json's values. */
export const ROLE_DEFAULTS = Object.freeze({
  voice: 'anthropic/claude-opus-4.6',
  analyzer: 'openai/gpt-6.1-sol',
  extractor: 'openai/gpt-6.1-sol',
  vision: 'google/gemini-3.8-flash',
  video: 'google/gemini-3.8-flash',
  embedding: 'openai/text-embedding-3-large',
  web: 'openrouter/openai/gpt-6.1-sol',
  server: 'openrouter/openai/gpt-6.1-sol',
  thinker: 'openrouter/anthropic/claude-opus-5.5',
  dev: 'openrouter/anthropic/claude-sonnet-5.5',
  writer: 'openrouter/anthropic/claude-opus-4.6',
  drawing: 'openai/gpt-image-2.5-flare',
});

/**
 * The section of `models` a role's model sits in: `base` or `agents`, undefined for a name that
 * is not a role.
 * @param {unknown} role
 * @returns {'base'|'agents'|undefined}
 */
export function roleSection(role) {
  if (BASE_ROLES.includes(role)) return 'base';
  if (AGENT_ROLES.includes(role)) return 'agents';
  return undefined;
}

/**
 * The config keys of a role's model (`['models', 'base', 'voice']`), undefined for a name that is
 * not a role.
 * @param {unknown} role
 * @returns {string[]|undefined}
 */
export function roleConfigKeys(role) {
  const section = roleSection(role);
  return section ? ['models', section, role] : undefined;
}

/**
 * The role each named purpose goes out on (the `purpose` of a request, logged on its
 * `llm: usage` line and the key of a `models.base.byPurpose` entry). Requests with no purpose of their
 * own (the memory analyzer's batches, the warmup family, a video, an index embedding, a drawing)
 * are not listed: they are named by their role alone.
 */
export const PURPOSE_ROLES = Object.freeze({
  reply: 'voice',
  'memory-voice': 'voice',
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
 * `models.base.byPurpose` entry for `purpose` when it is a non-empty string (an own key of a
 * plain object), else the role's own key (`models.base.<role>` or `models.agents.<role>`) when it
 * is a non-empty string, else the role's own default (ROLE_DEFAULTS). Never another role's
 * model. `undefined` only for a `role` that is not one of ROLES and no `byPurpose` entry.
 * @param {object|undefined} config  The whole live config, read at the moment of use.
 * @param {string} role
 * @param {string} [purpose]
 * @returns {string|undefined}
 */
export function roleModel(config, role, purpose) {
  const models = isPlainObject(config?.models) ? config.models : undefined;
  const base = isPlainObject(models?.base) ? models.base : undefined;
  const byPurpose = base?.byPurpose;
  if (typeof purpose === 'string' && isPlainObject(byPurpose) && Object.hasOwn(byPurpose, purpose)) {
    const pinned = byPurpose[purpose];
    if (typeof pinned === 'string' && pinned) return pinned;
  }
  const section = roleSection(role);
  if (!section) return undefined;
  const map = isPlainObject(models) && Object.hasOwn(models, section) && isPlainObject(models[section]) ? models[section] : undefined;
  const own = map && Object.hasOwn(map, role) ? map[role] : undefined;
  return typeof own === 'string' && own ? own : ROLE_DEFAULTS[role];
}
