// Operations: `bot.pause|resume`: the owner's pause, which holds every turn and keeps what arrives for the resume.
// The handler bodies moved here from src/admin.ts unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import { log } from '../../log.ts';
import { defineOp, perEnv } from './registry.ts';
import { callMethod, objOf } from '../types.ts';
import type { OpContext, Untyped } from '../types.ts';

/** The store's `state.json` as the pause reads and writes it. */
type StoreState = { data: Record<string, Untyped>; markDirty(): void };

const handlers = perEnv((env) => {
  const { slash, resolvedPlaceId, journalSystem } = env;
  /** The store's `state.json`: its data and its dirty mark, read at each call. */
  const storeState = () => env.store.state as StoreState;

  /**
   * Sets `paused`/`pausedAt` (and `pausedBy`, the caller) in state.json FIRST (so a crash or restart
   * mid-pause comes back paused), then waits out a turn already running and a
   * GIF recache in flight. Only once
   * all are idle does it flush everything and drop every cache except state.json itself. The pending pings wait for
   * the resume, which hands them back. A second call reports the state, and a pause the core set with a reason
   * (`no-core-key`, `core-down`, `analyzer-down`, `memory-down`) becomes the owner's, so only his resume lifts it. Then the journal's `pause` record; nothing is posted to the chat (the persona learns
   * of the pause from the journal, src/memory/journal.ts#offPeriods).
   */
  async function cmdPause(context: OpContext): Promise<string> {
    const state = storeState().data;
    if (state.paused) {
      const held = objOf(state);
      if (held.pausedReason !== undefined) {
        delete held.pausedReason;
        if (context?.accountId) held.pausedBy = String(context.accountId);
        const store = objOf(env.store);
        callMethod(store.state, 'markDirty');
        callMethod(store, 'flush');
      }
      return [`Already paused (since ${state.pausedAt ?? '?'}).`, `Run ${slash('resume')} when done.`].join('\n');
    }

    state.paused = true;
    state.pausedAt = new Date().toISOString();
    // Who paused, for the status card; absent when the caller is unknown.
    if (context?.accountId) state.pausedBy = String(context.accountId);
    storeState().markDirty();
    env.store.flush();

    if (env.turns && typeof env.turns.waitIdle === 'function') {
      await env.turns.waitIdle();
    }

    // A GIF recache in flight writes the media cache: it stops before its
    // next GIF once `paused` is seen; wait for the one in flight.
    if (env.gifRecache && typeof env.gifRecache.waitIdle === 'function') {
      await env.gifRecache.waitIdle();
    }

    // A file held for the archive (an item rewritten in place) waits up to archive.holdMaxMs, then is written.
    const { hot } = env;
    if (typeof env.store.flushSettled === 'function')
      await env.store.flushSettled({ holdMaxMs: hot.config?.archive?.holdMaxMs ?? 5000 });
    else env.store.flush();
    const dropped = typeof env.store.dropCaches === 'function' ? env.store.dropCaches() : 0;

    log.info('admin: paused', { dropped });

    await journalSystem({ event: 'pause', by: 'owner' });

    return [
      'Paused. New turns wait, and the messages that arrive are held for the resume.',
      `Run ${slash('resume')} when done.`,
    ].join('\n');
  }

  /**
   * Reports "Not paused." when called while not paused, before anything else
   * (idempotent). Otherwise refuses (staying paused) if any `*.json` under
   * data/ fails to parse, naming the offending paths; else re-reads
   * state.json (the owner may have hand-edited data/ while paused) and clears
   * the pause flags, letting every other cache lazily re-populate from disk.
   * Then the journal's `resume` record; nothing is posted to the chat. Then `pending.drain(placeId)` hands back
   * what the pause kept (the core's held messages and queued pings), never awaited. Last, the meaning index's
   * catch-up pass starts in the background (`embedQueue.catchUp`, never awaited; it does nothing
   * with the index switches off). With `only`, a pause of another reason stays (the core's own resumes).
   */
  async function cmdResume(context: OpContext, only?: string): Promise<string> {
    if (!storeState().data.paused) return 'Not paused.';

    const badFiles = typeof env.store.validate === 'function' ? env.store.validate() : [];
    if (badFiles.length > 0) {
      return [
        'Still paused: these files under data/ hold invalid JSON. Fix or restore them and try again:',
        ...(badFiles as Array<string>).map((file) => `  ${file}`),
      ].join('\n');
    }

    if (typeof env.store.reloadState === 'function') env.store.reloadState();
    const state = storeState().data;
    if (!state.paused) {
      return 'Not paused.';
    }
    if (only !== undefined && objOf(state).pausedReason !== only) return 'Still paused: the pause has another reason.';

    delete state.paused;
    delete state.pausedAt;
    delete state.pausedBy;
    // The reason the core paused her itself (the last core key removed); an owner's pause has none.
    delete objOf(state).pausedReason;
    storeState().markDirty();
    env.store.flush();

    log.info('admin: resumed', {});

    const placeId = resolvedPlaceId(context);
    await journalSystem({ event: 'resume', by: 'owner' });

    // What the pause kept: the messages held for the resume, then the queued direct pings (src/core.ts). Never awaited.
    const drain = objOf(objOf(env).pending).drain;
    if (typeof drain === 'function') {
      Promise.resolve()
        .then(() => Reflect.apply(drain, objOf(env).pending, [placeId]) as unknown)
        .catch((err: unknown) => log.warn('admin: resume drain failed', { code: objOf(err).code ?? null }));
    }

    if (typeof env.embedQueue?.catchUp === 'function') {
      Promise.resolve()
        .then(() => env.embedQueue.catchUp())
        .catch((err: unknown) => log.warn('admin: embed catch-up failed', { code: objOf(err).code ?? null }));
    }

    return 'Resumed.';
  }

  return { cmdPause, cmdResume };
});

defineOp({
  name: 'bot.pause',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdPause(ctx),
});
defineOp({
  name: 'bot.resume',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdResume(ctx, typeof args.reason === 'string' ? args.reason : undefined),
});
