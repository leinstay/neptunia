// The model roles: every LLM request names the model role it goes out on, and each model role has its own
// model: the model of the first route of the role's chain in `models.routes.<role>` (src/llm/route-chain.ts); a
// mandatory role with no chain has its built-in default, an optional one is off. The errand agents are no model role:
// each runs on its own route in `models.agents` (src/subharness/routing.ts).
// A model role never takes another model role's model: an unset model role is its own default, so
// changing one model role can never move another. `models.byPurpose` pins a single purpose (one role
// request, one kind of request) to a model of its own whatever its model role.
// the base roles
// - `core`       speaks as the persona: the reply;
// - `memory`     her memory session and description review (src/memory/db/session.ts); its default
//                is the core's, and it is not listed by `/nep model`;
// - `analyzer`   the core's classifier model: picks one of a few given options (address, room,
//                merge, rewatch, split, media-pick, missed),
//                plans a search and turns sources into notes (query-builder, recall-summary,
//                search-summary, diary-planner);
// - `vision`     describes a picture (describe, relook, avatar);
// - `video`      watches a video and looks at it again;
// - `embedding`  turns text into vectors for search by meaning;
// - `speech`     speaks her text aloud (src/speech/, OpenRouter's speech endpoint: no chat completion
//                behind it, so nothing probes it with one);
// - `drawing`    generates the persona's pictures: one Images API request through the bot's own
//                client (src/llm/images.ts), no loop, with a bare OpenRouter image model id.
// `models.abilities.<model id>` lists what a model can do (modelAbilities), and ROLE_ABILITY names the ability each
// base role serves: the tool gateway routes a down tool role to the core model by them (src/tools/gateway.ts).
// Pure; every reader passes the live config read at the moment of use.

import { isObj, objOf } from '../tools/types.ts';

/** The core: the one model role that speaks and decides as the persona, its model the first route of `models.routes.core`. */
export const CORE_ROLE = 'core';

/**
 * Her memory session and description review (src/memory/db/session.ts): words in her voice, so the model role sits beside
 * the core (its own chain, built-in default the core's), but it is not one of ROLES: `/nep model` does not list it.
 */
export const MEMORY_ROLE = 'memory';

/** The memory role's model while it has no chain: the core's built-in default. */
export const MEMORY_ROLE_DEFAULT = 'anthropic/claude-opus-4.6';

/**
 * Quick search's own request role, with a chain of routes of its own (`/model set search <key>/<model>`), apart from the
 * analyzer's. Its model is the first route's.
 */
export const SEARCH_ROLE = 'search';

/** The model of quick search and of the scout's web search; undefined until the owner sets a chain, as it has no default. */
export function searchModel(config: unknown): string | undefined {
  return chainModel(objOf(config).models, SEARCH_ROLE) ?? undefined;
}

/** The humanizer's roles (docs/humanizer.md); like `search` they have no built-in model, only their chains'. */
export const HUMANIZER_LINTER_ROLE = 'humanizer.linter';
export const HUMANIZER_WRITER_ROLE = 'humanizer.writer';
export const HUMANIZER_ROLES: ReadonlyArray<string> = Object.freeze([HUMANIZER_LINTER_ROLE, HUMANIZER_WRITER_ROLE]);

/**
 * The diary's scene helper (docs/diary.md), a role of its own whose chain is the analyzer's while it has no route of its
 * own, so its model is the analyzer's until one is set.
 */
export const DIARY_DIRECTOR_ROLE = 'diary.director';
/** The role whose chain and model the scene role takes while it has no route. */
export const DIARY_DIRECTOR_FALLBACK = 'analyzer';

/** The model roles other than `core` that a turn calls, in display order. */
export const NON_CORE_ROLES = Object.freeze(['analyzer', 'vision', 'video', 'embedding', 'speech']);

/** The model roles the bot's chat and embedding requests go out on, in display order: the core, then the model roles other than `core`. */
export const CORE_ROLES = Object.freeze([CORE_ROLE, ...NON_CORE_ROLES]);

/** The base model roles, in display order: the core, NON_CORE_ROLES, then drawing. Their models are their chains'. */
export const BASE_ROLES = Object.freeze([...CORE_ROLES, 'drawing']);

/** The base roles an owner may leave off, in the order of the tool roles. Off while their chain holds no route. */
export const OPTIONAL_ROLES = Object.freeze(['vision', 'video', 'drawing', 'speech'] as const);

/** Each base model role's built-in model, a mandatory role's while it has no chain. */
export const ROLE_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  core: 'anthropic/claude-opus-4.6',
  analyzer: 'openai/gpt-6.1-sol',
  vision: 'google/gemini-3.8-flash',
  video: 'google/gemini-3.8-flash',
  embedding: 'openai/text-embedding-3-large',
  speech: 'elevenlabs/eleven-v4',
  drawing: 'openai/gpt-image-2.5-flare',
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

/** Whether `role` is a model role: `memory` or one of BASE_ROLES. */
export function isModelRole(role: unknown): boolean {
  return typeof role === 'string' && (role === MEMORY_ROLE || BASE_ROLES.includes(role));
}

/**
 * The model role each named purpose goes out on (the `purpose` of a request, logged on its
 * `llm: usage` line and the key of a `models.byPurpose` entry). Requests with no purpose of their
 * own (a video, an index embedding, a drawing) are not listed: they are named by their model role alone.
 */
export const PURPOSE_ROLES = Object.freeze({
  reply: 'core',
  address: 'analyzer',
  merge: 'analyzer',
  split: 'analyzer',
  'media-pick': 'analyzer',
  summarize: 'analyzer',
  missed: 'analyzer',
  'query-builder': 'analyzer',
  'recall-summary': 'analyzer',
  'diary-planner': 'analyzer',
  speech: 'analyzer',
  // Usage rows and `models.byPurpose` pins written before quick search took its own name still read as this.
  'web-search': 'analyzer',
  describe: 'vision',
  relook: 'vision',
  avatar: 'vision',
  watch: 'video',
  gif: 'video',
  voice: 'video',
  rewatch: 'video',
  'recall-query': 'embedding',
  probe: 'embedding',
});

/**
 * The purposes of the model role `memory` (her memory session, description review and the description merge of
 * `/memory bind`, src/memory/db/session.ts, describe.ts and person-bind.ts): not in PURPOSE_ROLES, as that model role
 * is not one of ROLES.
 */
export const MEMORY_PURPOSES = Object.freeze([
  'memory-session',
  'description-draft',
  'description-check',
  'description-merge',
]);

/** A model on the direct path as a source-qualified selection, as readiness records its check. */
export const directSelectionOf = (model: string): string => `openrouter:${model}`;

/**
 * The model of one request, the one resolver every caller goes through: the `models.byPurpose` entry for `purpose`
 * when it is a non-empty string (an own key of a plain object), else the model of the first route of the role's
 * chain, else the role's own default (ROLE_DEFAULTS; the core's for `memory`). Never another model role's model.
 * `undefined` for an optional role that is off, and for a `role` that is no model role with no `byPurpose` entry.
 * @param config The whole live config, read at the moment of use.
 */
export function roleModel(config: unknown, role: string, purpose?: string): string | undefined {
  if (OPTIONAL_ROLES.includes(role as (typeof OPTIONAL_ROLES)[number]) && !roleOn(config, role)) return undefined;
  const models = objOf(config).models;
  const byPurpose = objOf(models).byPurpose;
  if (typeof purpose === 'string' && isObj(byPurpose) && Object.hasOwn(byPurpose, purpose)) {
    const pinned = byPurpose[purpose];
    if (typeof pinned === 'string' && pinned) return pinned;
  }
  if (HUMANIZER_ROLES.includes(role)) return chainModel(models, role);
  if (role === DIARY_DIRECTOR_ROLE) return chainModel(models, role) ?? roleModel(config, DIARY_DIRECTOR_FALLBACK);
  if (!isModelRole(role)) return undefined;
  return chainModel(models, role) ?? (role === MEMORY_ROLE ? MEMORY_ROLE_DEFAULT : ROLE_DEFAULTS[role]);
}

/** The model of the first route of `models.routes.<role>` (src/llm/route-chain.ts), undefined with no route. */
function chainModel(models: unknown, role: string): string | undefined {
  const routes = objOf(objOf(models).routes);
  const chain: unknown = Object.hasOwn(routes, role) ? routes[role] : undefined;
  if (!Array.isArray(chain)) return undefined;
  const model: unknown = objOf(chain[0]).model;
  return typeof model === 'string' && model !== '' ? model : undefined;
}

/**
 * Whether `role` is on. A mandatory role is always on. An optional role is on while the first route of its chain names
 * a model, and off with no chain or an empty one. Any other name is on.
 * @param config The whole live config, read at the moment of use.
 */
export function roleOn(config: unknown, role: string): boolean {
  if (!OPTIONAL_ROLES.includes(role as (typeof OPTIONAL_ROLES)[number])) return true;
  return chainModel(objOf(config).models, role) !== undefined;
}

/** The optional roles that are off, in the order of OPTIONAL_ROLES. */
export function offRoles(config: unknown): Array<string> {
  return OPTIONAL_ROLES.filter((role) => !roleOn(config, role));
}

/** The reasoning efforts a role or an agent runs at, OpenRouter's `reasoning.effort` levels that every backend takes. */
export const EFFORT_LEVELS = ['low', 'medium', 'high'] as const;

/** What keys.json can hold: EFFORT_LEVELS and the levels past them that a backend takes (src/subharness/models.ts). */
export const LISTED_EFFORT_LEVELS = [...EFFORT_LEVELS, 'xhigh', 'max'] as const;
export type EffortLevel = (typeof LISTED_EFFORT_LEVELS)[number];

/** Whether `value` is one of EFFORT_LEVELS. */
export const isEffortLevel = (value: unknown): value is (typeof EFFORT_LEVELS)[number] =>
  EFFORT_LEVELS.some((level) => level === value);

/** Whether `value` is one of LISTED_EFFORT_LEVELS. */
export const isListedEffort = (value: unknown): value is EffortLevel =>
  LISTED_EFFORT_LEVELS.some((level) => level === value);
