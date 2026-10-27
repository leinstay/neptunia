// The one rights evaluation of an operation for a caller, shared by src/tools/impl/index.ts#runOp (an
// owner command) and src/tools/gateway.ts (a member asking the persona to change shared state,
// so she is never a way around the member's own rights). Pure over the live config the caller
// reads at the moment of use; imports nothing that registers operations, so any module may use it.

import { isAllowed } from './grants.ts';
import { listOf, objOf } from '../types.ts';
import type { OpInfo } from '../types.ts';

/** The refusal code of a caller who may not run an operation. */
export type RightsRefusal = 'owner-only' | 'not-grantable' | 'not-granted';

/**
 * Null when the caller may run `op`, else the refusal code: src/tools/impl/grants.ts#isAllowed over
 * `bot.owners`, `bot.access` and `features`. `owner-only` for an owner-only operation,
 * `not-grantable` for one no grant opens (a member operation while `features.memberCommands` is
 * off included), else `not-granted`.
 */
export function rightsRefusal(
  op: Partial<OpInfo> | null | undefined,
  { userId, roleIds, config }: { userId?: unknown; roleIds?: ReadonlyArray<unknown>; config?: unknown } = {}
): RightsRefusal | null {
  const bot = objOf(objOf(config).bot);
  const allowed = isAllowed({
    op,
    member: { userId, roleIds: listOf(roleIds) },
    access: bot.access ?? {},
    owners: bot.owners ?? [],
    features: objOf(config).features,
  });
  if (allowed) return null;
  const rights = op?.rights;
  if (rights?.ownerOnly === true) return 'owner-only';
  if (rights?.grantable === false || rights?.member === true) return 'not-grantable';
  return 'not-granted';
}

/**
 * The config keys that govern authorization or the persona's own controls: who is an owner and
 * who may do what (`bot.owners`, `bot.access`, `features.adminCommands`, `features.memberCommands`),
 * her kill switch and her tools' settings, safe mode included (`features.tools`,
 * `features.toolsDiscovery`, `tools.*`, and the names they had before: `features.skills`, `features.skillsDiscovery`,
 * `skills.*`, which a local file may still carry), the journal that records what she does
 * (`features.journal`), and her inner life's switch, mode and caps (`features.innerLife`,
 * `innerLife.*`). The one list behind the non-delegable rule: she never changes her
 * effective authority, directly or indirectly (src/tools/impl/config.ts, src/tools/impl/access.ts).
 */
export const PERSONA_GOVERNED_CONFIG: ReadonlyArray<string> = Object.freeze([
  'bot.owners',
  'bot.access',
  'features.adminCommands',
  'features.memberCommands',
  'features.tools',
  'features.toolsDiscovery',
  'tools',
  'features.skills',
  'features.skillsDiscovery',
  'skills',
  'features.journal',
  'features.innerLife',
  'innerLife',
]);

/**
 * True when the dotted config path `key` is one of PERSONA_GOVERNED_CONFIG, lies under one, or
 * holds one (a whole section).
 */
export function governsPersona(key: unknown): boolean {
  const path = typeof key === 'string' ? key : '';
  if (!path) return false;
  return PERSONA_GOVERNED_CONFIG.some(
    (governed) => path === governed || path.startsWith(`${governed}.`) || governed.startsWith(`${path}.`)
  );
}
