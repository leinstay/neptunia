// The one rights evaluation of an operation for a caller, shared by src/ops/index.js#runOp (an
// owner command) and src/skills/gateway.js (a member asking the persona to change shared state,
// so she is never a way around the member's own rights). Pure over the live config the caller
// reads at the moment of use; imports nothing that registers operations, so any module may use it.

import { isAllowed } from '../discord/access.js';

/**
 * Null when the caller may run `op`, else the refusal code: src/discord/access.js#isAllowed over
 * `bot.owners`, `bot.access` and `features`. `owner-only` for an owner-only operation,
 * `not-grantable` for one no grant opens (a member operation while `features.memberCommands` is
 * off included), else `not-granted`.
 * @param {{ name: string, rights: object }} op
 * @param {{ userId?: unknown, roleIds?: unknown[], config?: object }} caller
 * @returns {'owner-only'|'not-grantable'|'not-granted'|null}
 */
export function rightsRefusal(op, { userId, roleIds, config } = {}) {
  const allowed = isAllowed({
    op,
    member: { userId, roleIds },
    access: config?.bot?.access ?? {},
    owners: config?.bot?.owners ?? [],
    features: config?.features,
  });
  if (allowed) return null;
  const rights = op?.rights ?? {};
  if (rights.ownerOnly === true) return 'owner-only';
  if (rights.grantable === false || rights.member === true) return 'not-grantable';
  return 'not-granted';
}

/**
 * The config keys that govern authorization or the persona's own controls: who is an owner and
 * who may do what (`bot.owners`, `bot.access`, `features.adminCommands`, `features.memberCommands`),
 * her kill switch and her skills' settings, safe mode included (`features.skills`,
 * `features.skillsDiscovery`, `skills.*`), and the journal that records what she does
 * (`features.journal`). The one list behind the non-delegable rule: she never changes her
 * effective authority, directly or indirectly (src/ops/config.js, src/ops/access.js).
 */
export const PERSONA_GOVERNED_CONFIG = Object.freeze([
  'bot.owners',
  'bot.access',
  'features.adminCommands',
  'features.memberCommands',
  'features.skills',
  'features.skillsDiscovery',
  'features.skillsAlwaysListed',
  'skills',
  'features.journal',
]);

/**
 * True when the dotted config path `key` is one of PERSONA_GOVERNED_CONFIG, lies under one, or
 * holds one (a whole section).
 * @param {string} key
 * @returns {boolean}
 */
export function governsPersona(key) {
  const path = String(key ?? '');
  if (!path) return false;
  return PERSONA_GOVERNED_CONFIG.some((governed) => path === governed || path.startsWith(`${governed}.`) || governed.startsWith(`${path}.`));
}
