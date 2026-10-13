// Operations: `/nep alias`: the owner confirms or removes a member's alias.
// The handler bodies moved here from src/admin.js unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import { normalizeTopic } from '../memory/interests.js';
import { applyAliasOps } from '../memory/aliases.js';
import { confirmTarget, formatAliasList } from './shared.js';
import { defineOp, perEnv, invalid } from './registry.js';

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
  function cmdAliasAdd(args, context) {
    assertNotPaused();
    const userId = args?.userId;
    if (!userId) throw invalid('a user is required');
    const guildId = requireGuildId(context);

    const name = String(args?.name ?? '').trim();
    if (!name) throw invalid('a name is required');

    const before = requireProfile(guildId, userId);
    const memoryCfg = hot.config?.memory ?? {};
    const target = confirmTarget(memoryCfg);

    // The identity the store keeps for `name` (clamped the store's way), to find it once stored.
    const key = normalizeTopic(applyAliasOps([], { add: [name] }, [])[0]?.name ?? name);
    const currentWeight = before.aliases?.find((a) => normalizeTopic(a.name) === key)?.weight ?? 0;
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
        },
      );
    }

    const after = store.getUser(guildId, userId);
    return formatAliasList(after, memoryCfg);
  }

  /** `/nep alias remove`: removes by name, case-insensitively (store.applyProfileOps
   * matches an alias's identity the same way, see src/memory/interests.js#normalizeTopic).
   * A member with no profile is an error. */
  function cmdAliasRemove(args, context) {
    assertNotPaused();
    const userId = args?.userId;
    if (!userId) throw invalid('a user is required');
    const guildId = requireGuildId(context);

    const name = String(args?.name ?? '').trim();
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
      },
    );

    const after = store.getUser(guildId, userId);
    return formatAliasList(after, memoryCfg);
  }

  return { cmdAliasAdd, cmdAliasRemove };
});

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
