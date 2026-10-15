// The model roles: every LLM request names the role it goes out on, and each role has its own
// model under `roles.<role>` with a built-in default (the same value config.json ships). A role
// never takes another role's model: an unset role is its own default, so changing one role can
// never move another. `roles.byPurpose` pins a single purpose (one helper, one kind of request)
// to a model of its own whatever its role. The role names are what the request does:
// - `voice`      speaks as the persona: the reply and the memory texts worded in its voice;
// - `analyzer`   picks one of a few given options: address, room, merge, route-channel,
//                participation-pick, rewatch, split, gif-pick;
// - `reasoner`   plans a search and turns sources into notes: lookup, planner, recall-summary,
//                search-summary, read-link, diary-plan;
// - `extractor`  turns conversations into stored memory: the memory analyzer's batches, the
//                portraits' stage A, the channel and server notes, the warmup, the backfill;
// - `vision`     describes a picture (describe, relook, avatar);
// - `video`      watches a video and looks at it again;
// - `embedding`  turns text into vectors for search by meaning;
// - `drawing`    generates the persona's pictures.
// Pure; every reader passes the live config read at the moment of use.

import { isPlainObject } from '../config.js';

/** The roles, in display order (`/nep model`, `/nep route`, the status card). */
export const ROLES = Object.freeze(['voice', 'analyzer', 'reasoner', 'extractor', 'vision', 'video', 'embedding', 'drawing']);

/** Each role's model while `roles.<role>` is unset: config.json's values. */
export const ROLE_DEFAULTS = Object.freeze({
  voice: 'anthropic/claude-opus-4.6',
  analyzer: 'openai/gpt-6.1-sol',
  reasoner: 'openai/gpt-6.1-sol',
  extractor: 'openai/gpt-6.1-sol',
  vision: 'google/gemini-3.8-flash',
  video: 'google/gemini-3.8-flash',
  embedding: 'openai/text-embedding-3-large',
  drawing: 'openai/gpt-image-2.5-flare',
});

/**
 * The role each named purpose goes out on (the `purpose` of a request, logged on its
 * `llm: usage` line and the key of a `roles.byPurpose` entry). Requests with no purpose of their
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
  lookup: 'reasoner',
  planner: 'reasoner',
  'recall-summary': 'reasoner',
  'search-summary': 'reasoner',
  'read-link': 'reasoner',
  'diary-plan': 'reasoner',
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
 * The model of one request, the one resolver every caller goes through: the `roles.byPurpose`
 * entry for `purpose` when it is a non-empty string (an own key of a plain object), else
 * `roles.<role>` when it is a non-empty string, else the role's own default (ROLE_DEFAULTS).
 * Never another role's model. `undefined` only for a `role` that is not one of ROLES and no
 * `byPurpose` entry.
 * @param {object|undefined} config  The whole live config, read at the moment of use.
 * @param {string} role
 * @param {string} [purpose]
 * @returns {string|undefined}
 */
export function roleModel(config, role, purpose) {
  const roles = config?.roles;
  const byPurpose = isPlainObject(roles) ? roles.byPurpose : undefined;
  if (typeof purpose === 'string' && isPlainObject(byPurpose) && Object.hasOwn(byPurpose, purpose)) {
    const pinned = byPurpose[purpose];
    if (typeof pinned === 'string' && pinned) return pinned;
  }
  if (!isRole(role)) return undefined;
  const own = isPlainObject(roles) && Object.hasOwn(roles, role) ? roles[role] : undefined;
  return typeof own === 'string' && own ? own : ROLE_DEFAULTS[role];
}
