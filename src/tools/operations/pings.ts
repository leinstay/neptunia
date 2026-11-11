// Operations: `pings.get|set`: a member's own notification switch.
// The handler bodies moved here from src/admin.ts unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import { PINGS_MODES } from './catalog.ts';
import { log } from '../../log.ts';
import { defineOp, perEnv, invalid } from './registry.ts';
import { objOf } from '../types.ts';
import type { Obj, OpContext } from '../types.ts';

const handlers = perEnv((env) => {
  const { store, freshenIfPaused, requirePlaceId } = env;

  /** `pings.get|set [on|off|clear]`: the caller's own ping state in this place (store.setPings; src/turn/mentions.ts
   * reads it when she posts). `on` and `off` win over the interface's silent switch, `clear` hands the choice back
   * to it. No mode shows the state. A member's own switch, not memory: it works while paused too (read fresh off disk
   * then, and written at once by the store). */
  function cmdPings(args: Obj, context: OpContext): string {
    const placeId = requirePlaceId(context);
    const accountId = context.accountId;
    if (!accountId) throw invalid('no user');
    const mode = objOf(args).mode;
    freshenIfPaused();
    if (mode === undefined || mode === null || mode === '') return pingsText(store.getPings(placeId, accountId));
    if (typeof mode !== 'string' || !PINGS_MODES.includes(mode))
      throw invalid(`mode must be one of: ${PINGS_MODES.join(', ')}`);
    const state = store.setPings(placeId, accountId, mode === 'clear' ? null : (mode as 'on' | 'off'));
    log.info('admin: pings set', { placeId, accountId, state: state ?? 'default' });
    return pingsText(state);
  }

  /** The one reply of `pings.get|set`: the caller's state after the call. */
  function pingsText(state: unknown): string {
    return state === 'on' || state === 'off' ? `Pings: ${state}` : 'Pings: default';
  }

  return { cmdPings, pingsText };
});

defineOp({
  name: 'pings.get',
  rights: { kind: 'read' },
  run: (args, ctx) => handlers(ctx.env).cmdPings({}, ctx),
});
defineOp({
  name: 'pings.set',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdPings(args, ctx),
});
