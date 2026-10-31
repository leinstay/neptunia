// Operations: `/nep alias`: the owner confirms or removes a member's alias, and the owner's console read
// `/memory aliases list` (no operation, so no tool of hers) lists them.
// The handler bodies moved here from src/admin.js unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import { normalizeTopic, applyAliasOps } from '../../memory/index.js';
import { confirmTarget, formatAliasList } from './shared.ts';
import { defineOp, perEnv, invalid } from './registry.ts';
import { callMethod, idText, objOf, textOf } from '../types.ts';
import type { Env } from './env.ts';
import type { Obj, OpContext, Untyped } from '../types.ts';

const handlers = perEnv((env) => {
  const { hot, store, assertNotPaused, requireGuildId, requireProfile } = env;

  /**
   * `/nep alias add`: confirms the alias at once instead of
   * waiting for it to be sighted `memory.confirmAfter` times naturally —
   * store.applyProfileOps/src/memory/aliases.js has no option to set a
   * weight directly, so this calls it repeatedly with `confirmGapHours: 0`
   * (every call then counts as a fresh sighting regardless of the gap, see
   * src/memory/interests.js#applyRankedOps's `isFarEnough`) and the SAME
   * `seenAt`/`now` for every call, so the resulting item's `firstSeen` and
   * `lastSeen` both land on that one instant. Idempotent: already at or past
   * the target weight -> no call at all, nothing changes. Clamping to 40
   * chars and dropping a name equal to one of the member's display names are
   * both src/memory/aliases.js#applyAliasOps's own behaviour; the stored form
   * is worked out through that same function. A member with no profile is an error.
   */
  function cmdAliasAdd(args: Obj, context: OpContext) {
    assertNotPaused();
    const userId = idText(args.userId);
    if (!userId) throw invalid('a user is required');
    const guildId = requireGuildId(context);

    const name = textOf(args.name).trim();
    if (!name) throw invalid('a name is required');

    const before = requireProfile(guildId, userId);
    const memoryCfg = hot.config?.memory ?? {};
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
        guildId,
        userId,
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

    const after = store.getUser(guildId, userId);
    return formatAliasList(after, memoryCfg);
  }

  /** `/nep alias remove`: removes by name, case-insensitively (store.applyProfileOps
   * matches an alias's identity the same way, see src/memory/interests.js#normalizeTopic).
   * A member with no profile is an error. */
  function cmdAliasRemove(args: Obj, context: OpContext) {
    assertNotPaused();
    const userId = idText(args.userId);
    if (!userId) throw invalid('a user is required');
    const guildId = requireGuildId(context);

    const name = textOf(args.name).trim();
    if (!name) throw invalid('a name is required');

    requireProfile(guildId, userId);
    const memoryCfg = hot.config?.memory ?? {};
    store.applyProfileOps(
      guildId,
      userId,
      { aliases: { remove: [name] } },
      {
        maxAliases: memoryCfg.maxAliases,
        maxAliasesStored: memoryCfg.maxAliasesStored,
        aliasHalfLifeDays: memoryCfg.aliasHalfLifeDays,
      }
    );

    const after = store.getUser(guildId, userId);
    return formatAliasList(after, memoryCfg);
  }

  /** `/memory aliases list <user>`: the member's aliases, as `add` and `remove` answer them. A member with no
   * profile is an error. */
  function cmdAliasList(args: Obj, context: OpContext) {
    const userId = idText(args.userId);
    if (!userId) throw invalid('a user is required');
    const guildId = requireGuildId(context);
    requireProfile(guildId, userId);
    return formatAliasList(callMethod(store, 'getUser', guildId, userId), objOf(objOf(objOf(hot).config).memory));
  }

  return { cmdAliasAdd, cmdAliasRemove, cmdAliasList };
});

/** `/memory aliases list <user>` of the owner's console (src/interface/commands/console.ts), over the ops env `env`. */
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
