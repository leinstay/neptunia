// Operations: `/nep alias`: the owner confirms or removes a member's alias, and the owner's console read
// `/memory users names` (no operation, so no tool of hers) lists them.
// The handler bodies moved here from src/admin.ts unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import { accountOf } from '../../memory/addresses.ts';
import { normalizeTopic, applyAliasOps } from '../../memory/index.ts';
import { confirmTarget, formatAliasList } from './shared.ts';
import { defineOp, perEnv, invalid } from './registry.ts';
import { callMethod, idText, objOf, textOf } from '../types.ts';
import type { Env } from './env.ts';
import type { Obj, OpContext, Untyped } from '../types.ts';
import { MEMORY_LIMITS } from '../../memory/text-limits.ts';

const handlers = perEnv((env) => {
  const { hot, store, assertNotPaused, requirePlaceId, requireProfile } = env;

  /**
   * `/nep alias add`: confirms the alias at once instead of
   * waiting for it to be sighted `memory.confirmAfter` times naturally —
   * store.applyProfileOps/src/memory/aliases.ts has no option to set a
   * weight directly, so this calls it repeatedly with `confirmGapHours: 0`
   * (every call then counts as a fresh sighting regardless of the gap, see
   * src/memory/interests.ts#applyRankedOps's `isFarEnough`) and the SAME
   * `seenAt`/`now` for every call, so the resulting item's `firstSeen` and
   * `lastSeen` both land on that one instant. Idempotent: already at or past
   * the target weight -> no call at all, nothing changes. Clamping to 40
   * chars and dropping a name equal to one of the member's display names are
   * both src/memory/aliases.ts#applyAliasOps's own behaviour; the stored form
   * is worked out through that same function. A member with no profile is an error.
   */
  function cmdAliasAdd(args: Obj, context: OpContext) {
    assertNotPaused();
    const accountId = idText(args.accountId);
    if (!accountId) throw invalid('a user is required');
    const placeId = requirePlaceId(context);

    const name = textOf(args.name).trim();
    if (!name) throw invalid('a name is required');

    const before = requireProfile(placeId, accountId);
    const memoryCfg = { ...hot.config?.memory, ...MEMORY_LIMITS };
    const target = confirmTarget(memoryCfg);

    // The identity the store keeps for `name` (clamped the store's way), to find it once stored.
    const key = normalizeTopic(
      (applyAliasOps([], { add: [name] }, [])[0] as { name?: string } | undefined)?.name ?? name
    );
    const currentWeight = before.aliases?.find((a: Untyped) => normalizeTopic(a.name) === key)?.weight ?? 0;
    const needed = Math.max(0, target - currentWeight);

    const now = Date.now();
    for (let i = 0; i < needed; i += 1) {
      store.applyProfileOps(
        accountOf(store, accountId),
        { aliases: { add: [name] } },
        {
          confirmGapHours: 0,
          seenAt: now,
          now,
          maxAliases: memoryCfg.maxAliases,
          maxAliasesStored: memoryCfg.maxAliasesStored,
          aliasHalfLifeDays: memoryCfg.aliasHalfLifeDays,
        }
      );
    }

    const after = store.getUser(accountOf(store, accountId));
    return formatAliasList(after, memoryCfg);
  }

  /** `/nep alias remove`: removes by name, case-insensitively (store.applyProfileOps
   * matches an alias's identity the same way, see src/memory/interests.ts#normalizeTopic).
   * A member with no profile is an error. */
  function cmdAliasRemove(args: Obj, context: OpContext) {
    assertNotPaused();
    const accountId = idText(args.accountId);
    if (!accountId) throw invalid('a user is required');
    const placeId = requirePlaceId(context);

    const name = textOf(args.name).trim();
    if (!name) throw invalid('a name is required');

    requireProfile(placeId, accountId);
    const memoryCfg = { ...hot.config?.memory, ...MEMORY_LIMITS };
    store.applyProfileOps(
      accountOf(store, accountId),
      { aliases: { remove: [name] } },
      {
        maxAliases: memoryCfg.maxAliases,
        maxAliasesStored: memoryCfg.maxAliasesStored,
        aliasHalfLifeDays: memoryCfg.aliasHalfLifeDays,
      }
    );

    const after = store.getUser(accountOf(store, accountId));
    return formatAliasList(after, memoryCfg);
  }

  /** The member's aliases, as `add` and `remove` answer them. A member with no
   * profile is an error. */
  function cmdAliasList(args: Obj, context: OpContext) {
    const accountId = idText(args.accountId);
    if (!accountId) throw invalid('a user is required');
    const placeId = requirePlaceId(context);
    requireProfile(placeId, accountId);
    return formatAliasList(callMethod(store, 'getUser', placeId, accountId), objOf(objOf(objOf(hot).config).memory));
  }

  return { cmdAliasAdd, cmdAliasRemove, cmdAliasList };
});

/** The member's aliases for the owner's console (src/interface/commands/console.ts), over the ops env `env`. */
export function listAliases(env: Env, args: Obj, context: OpContext): string {
  return handlers(env).cmdAliasList(args, context);
}

defineOp({
  name: 'alias.add',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdAliasAdd(args, ctx),
});
defineOp({
  name: 'alias.remove',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdAliasRemove(args, ctx),
});
