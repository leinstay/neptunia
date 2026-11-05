// The one rights evaluation of an operation for a caller, shared by src/tools/impl/index.ts#runOp (an
// owner command) and src/tools/gateway.ts (a member asking the persona to change shared state,
// so she is never a way around the member's own rights). Pure over the live config the caller
// reads at the moment of use; imports nothing that registers operations, so any module may use it.

import { isAllowed, isOwnerId } from './grants.ts';
import { listOf, objOf } from '../types.ts';
import type { OpInfo } from '../types.ts';

/** The refusal code of a caller who may not run an operation. */
export type RightsRefusal = 'owner-only' | 'not-grantable' | 'not-granted';

/**
 * Null when the caller may run `op`, else the refusal code: the owner's console (`asOwner`) and the owner
 * (src/tools/impl/grants.ts#isOwnerId) always may, anyone else by src/tools/impl/grants.ts#isAllowed over
 * `bot.access`. `owner-only` for an owner-only operation, `not-grantable` for one no grant opens,
 * else `not-granted`.
 */
export function rightsRefusal(
  op: Partial<OpInfo> | null | undefined,
  {
    accountId,
    roleIds,
    config,
    asOwner = false,
  }: { accountId?: unknown; roleIds?: ReadonlyArray<unknown>; config?: unknown; asOwner?: boolean } = {}
): RightsRefusal | null {
  // The owner's console runs as the owner (src/tools/types.ts#OpContext.asOwner).
  if (asOwner || isOwnerId(config, accountId)) return null;
  const bot = objOf(objOf(config).bot);
  const allowed = isAllowed({
    op,
    member: { accountId, roleIds: listOf(roleIds) },
    access: bot.access ?? {},
  });
  if (allowed) return null;
  const rights = op?.rights;
  if (rights?.ownerOnly === true) return 'owner-only';
  if (rights?.grantable === false || rights?.member === true) return 'not-grantable';
  return 'not-granted';
}

/**
 * The config keys that govern authorization or the persona's own controls: who is an owner and
 * who may do what (`bot.owners`, `bot.ownerPerson`, `bot.access`), her tools' settings, safe mode included (`tools.*`, and the name it
 * had before, `skills.*`, which a local file may still carry), the wakes' mode, caps and limits (`wakes.*`, and the
 * old name `innerLife.*`, which src/config-moves.ts reads as `wakes.*`, `heartbeat.*` and `selfimprovement.*`), and the
 * heartbeat's and the selfimprovement wake's own limits (`heartbeat.*`, `selfimprovement.*`), and the boundary and limits
 * of the development worker (`development.*`).
 * The one list behind the non-delegable rule: she never changes her effective authority, directly or indirectly
 * (src/tools/impl/config.ts, src/tools/impl/access.ts).
 */
export const PERSONA_GOVERNED_CONFIG: ReadonlyArray<string> = Object.freeze([
  'bot.owners',
  'bot.ownerPerson',
  'bot.access',
  'tools',
  'skills',
  'wakes',
  'heartbeat',
  'selfimprovement',
  'development',
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
