// The persona's access to her skills: two levels, allowed or not, granted the same way people's
// rights are -- `/nep access grant|revoke` (src/ops/access.js) with her (the bot's own user) as
// the target, stored in the same place, `bot.access[<skill name>].users` (src/ops/grants.js).
// Default deny; only a grant naming her user id opens a skill for her: a grant to everyone or to
// a role is people's and opens nothing for her, so no grant she could make for others widens her
// own rights. For her a grant may open an owner-only operation (it still runs only when an owner
// asks: src/skills/gateway.js), except the irreversible and administrative ones no grant opens
// for her yet (NOT_GRANTABLE_TO_PERSONA). Her reply tags of today are carried over without a grant, in the
// current conversation only, so nothing she does now is blocked (the skills design, "carry
// permissions over"): `<msg>` and `<gif>` are `message.create`, `<react>` is `message.react.add`,
// `<draw>` is `draw.create` -- the operations the owner's `/nep message` and `/nep draw` run. Two switches, read by the caller from the live config: `features.skills`
// false refuses every skill, and `skills.safeMode` true lets only the carried-over tags pass.
// Pure over the live config the caller reads at the moment of use.

import { isPlainObject } from '../config.js';

/** The skills behind the persona's current reply tags, allowed in the current conversation without a grant. */
export const CARRIED_OVER = Object.freeze(['message.create', 'message.react.add', 'draw.create']);

/**
 * The operations no grant opens for the persona yet (the owner's decision, 2026-10-14): the
 * irreversible and the administrative ones. Refused by `/nep access grant` with her as the target
 * (a group or `*` skips them) and again at every call (skillAccess: `not-grantable`), whatever
 * is stored. Everything else -- owner-only operations included -- is grantable to her.
 */
export const NOT_GRANTABLE_TO_PERSONA = Object.freeze([
  'memory.wipe',
  'memory.private.purge',
  'memory.forget',
  'memory.private.forget',
  'memory.restore',
  'rule.remove',
  'config.set',
  'config.unset',
  'model.set',
  'route.set',
  'route.remove',
  'access.grant',
  'access.revoke',
  'bot.pause',
  'bot.resume',
]);

/** True when `features.skills` is not false (a missing key counts as on). */
export function skillsOn(config) {
  return config?.features?.skills !== false;
}

/** True when `skills.safeMode` is exactly true. */
export function safeModeOn(config) {
  return config?.skills?.safeMode === true;
}

/**
 * True when `bot.access[name]` grants the skill to the persona: its `users` list her user id
 * (`selfId`, ids compared as strings). No id, no stored grant or a malformed one: false.
 * @param {object} config  The live merged config.
 * @param {string|null|undefined} selfId  The bot's own user id.
 * @param {string} name  A skill name (an operation's).
 * @returns {boolean}
 */
export function grantedToPersona(config, selfId, name) {
  if (selfId === undefined || selfId === null || selfId === '') return false;
  const access = config?.bot?.access;
  const entry = isPlainObject(access) && Object.hasOwn(access, name) ? access[name] : null;
  return isPlainObject(entry) && Array.isArray(entry.users) && entry.users.map(String).includes(String(selfId));
}

/**
 * Whether the persona may use `skill` now, before its arguments and targets are looked at:
 * `{ allowed, reason }` with, in order, `skills-off` (features.skills false), `carried-over` (a
 * current tag aimed at the current conversation: `conversationId` absent or equal to
 * `currentConversationId`), `safe-mode` (skills.safeMode: nothing else passes), `not-grantable`
 * (NOT_GRANTABLE_TO_PERSONA, whatever is stored), `allowed` (a
 * grant to her user id under its name, grantedToPersona), else `not-allowed`. An
 * owner-only skill is granted like any other: who may have it run is the requester's right
 * (src/skills/gateway.js).
 * @param {{ skill: object, config: object, selfId?: string|null, conversationId?: string|null, currentConversationId?: string|null }} args
 * @returns {{ allowed: boolean, reason: string }}
 */
export function skillAccess({ skill, config, selfId = null, conversationId = null, currentConversationId = null }) {
  if (!skillsOn(config)) return { allowed: false, reason: 'skills-off' };
  const target = conversationId ?? currentConversationId;
  const here = target === null || target === undefined ? currentConversationId == null : String(target) === String(currentConversationId);
  if (CARRIED_OVER.includes(skill.name) && here) return { allowed: true, reason: 'carried-over' };
  if (safeModeOn(config)) return { allowed: false, reason: 'safe-mode' };
  if (NOT_GRANTABLE_TO_PERSONA.includes(skill.name)) return { allowed: false, reason: 'not-grantable' };
  if (grantedToPersona(config, selfId, skill.name)) return { allowed: true, reason: 'allowed' };
  return { allowed: false, reason: 'not-allowed' };
}
