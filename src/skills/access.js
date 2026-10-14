// The persona's access to her skills: two levels, allowed or not. Default deny; only the owner's
// command (src/ops/skill.js) writes a record, `state.json` -> `skills.allowed[name] = { by, at }`.
// Her reply tags of today are carried over without a record, in the current conversation only, so
// nothing she does now is blocked (the skills design, "carry permissions over"): `<msg>` and
// `<gif>` are `message.send`, `<react>` is `message.react.add`, `<draw>` is `draw`. Two switches,
// read by the caller from the live config: `features.skills` false refuses every skill, and
// `skills.safeMode` true lets only the carried-over tags pass. Pure over the state data
// (`store.state.data`); the writers mutate it and leave marking it dirty to the caller.

import { isPlainObject } from '../config.js';

/** The skills behind the persona's current reply tags, allowed in the current conversation without a record. */
export const CARRIED_OVER = Object.freeze(['message.send', 'message.react.add', 'draw']);

/** True when `features.skills` is not false (a missing key counts as on). */
export function skillsOn(config) {
  return config?.features?.skills !== false;
}

/** True when `skills.safeMode` is exactly true. */
export function safeModeOn(config) {
  return config?.skills?.safeMode === true;
}

/**
 * Every well-formed allow record of `state` (`skills.allowed`), as a fresh object name ->
 * `{ by, at }`; a malformed (hand-edited) entry or section reads as no record.
 * @param {object} state  state.json's data.
 * @returns {Record<string, { by: string, at: string }>}
 */
export function allowedSkills(state) {
  const allowed = isPlainObject(state?.skills) && isPlainObject(state.skills.allowed) ? state.skills.allowed : {};
  const out = {};
  for (const [name, record] of Object.entries(allowed)) {
    if (isPlainObject(record) && typeof record.by === 'string' && typeof record.at === 'string') out[name] = { by: record.by, at: record.at };
  }
  return out;
}

/**
 * Records `name` allowed by `by` at `at` in `state.skills.allowed` (an existing record replaced).
 * @param {object} state
 * @param {string} name
 * @param {{ by: string, at: string }} record
 */
export function allowSkill(state, name, { by, at }) {
  const skills = isPlainObject(state.skills) ? state.skills : {};
  const allowed = isPlainObject(skills.allowed) ? skills.allowed : {};
  state.skills = { ...skills, allowed: { ...allowed, [name]: { by: String(by), at: String(at) } } };
}

/**
 * Drops the allow record of `name`; true when there was one.
 * @param {object} state
 * @param {string} name
 * @returns {boolean}
 */
export function denySkill(state, name) {
  if (!isPlainObject(state.skills) || !isPlainObject(state.skills.allowed) || !Object.hasOwn(state.skills.allowed, name)) return false;
  const { [name]: _dropped, ...rest } = state.skills.allowed;
  state.skills = { ...state.skills, allowed: rest };
  return true;
}

/**
 * Whether the persona may use `skill` now, before its arguments and targets are looked at:
 * `{ allowed, reason }` with, in order, `skills-off` (features.skills false), `owner-only`,
 * `carried-over` (a current tag aimed at the current conversation: `conversationId` absent or
 * equal to `currentConversationId`), `safe-mode` (skills.safeMode: nothing else passes),
 * `allowed` (an allow record, with its `by` and `at`), else `not-allowed`.
 * @param {{ skill: object, state: object, config: object, conversationId?: string|null, currentConversationId?: string|null }} args
 * @returns {{ allowed: boolean, reason: string, by?: string, at?: string }}
 */
export function skillAccess({ skill, state, config, conversationId = null, currentConversationId = null }) {
  if (!skillsOn(config)) return { allowed: false, reason: 'skills-off' };
  if (skill.ownerOnly === true) return { allowed: false, reason: 'owner-only' };
  const target = conversationId ?? currentConversationId;
  const here = target === null || target === undefined ? currentConversationId == null : String(target) === String(currentConversationId);
  if (CARRIED_OVER.includes(skill.name) && here) return { allowed: true, reason: 'carried-over' };
  if (safeModeOn(config)) return { allowed: false, reason: 'safe-mode' };
  const record = allowedSkills(state)[skill.name];
  if (record) return { allowed: true, reason: 'allowed', by: record.by, at: record.at };
  return { allowed: false, reason: 'not-allowed' };
}
