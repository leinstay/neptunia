// Operations: `/nep pings`: a member's own notification switch, open to every member while features.memberCommands is on.
// The handler bodies moved here from src/admin.js unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import { PINGS_MODES } from '../discord/commands.js';
import { log } from '../log.js';
import { defineOp, perEnv, invalid } from './registry.js';

const handlers = perEnv((env) => {
  const { store, freshenIfPaused, requireGuildId } = env;

  /** `/nep pings [on|off]`: the caller's own notifications from the persona in this guild
   * (store.setPingsOff; src/behavior/turn.js reads them when it posts). No mode shows the state.
   * A member's own switch, not memory: it works while paused too (read fresh off disk then, and
   * written at once by the store). */
  function cmdPings(args, context) {
    const guildId = requireGuildId(context);
    const userId = context?.userId;
    if (!userId) throw invalid('no user');
    const mode = args?.mode;
    freshenIfPaused();
    if (mode === undefined || mode === null || mode === '') return pingsText(!store.isPingsOff(guildId, userId));
    if (!PINGS_MODES.includes(mode)) throw invalid(`mode must be one of: ${PINGS_MODES.join(', ')}`);
    const off = store.setPingsOff(guildId, userId, mode === 'off');
    log.info('admin: pings set', { guildId, userId, off });
    return pingsText(!off);
  }

  /** The one reply of `/nep pings`: the caller's state after the call. */
  function pingsText(on) {
    return on ? 'Pings: on' : 'Pings: off';
  }

  return { cmdPings, pingsText };
});

defineOp({
  name: 'pings.get',
  rights: { kind: 'read', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdPings({}, ctx),
});
defineOp({
  name: 'pings.set',
  rights: { kind: 'write', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdPings(args, ctx),
});
