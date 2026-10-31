// Operations: `/nep pause|resume`: the maintenance mode in which data/ may be edited by hand.
// The handler bodies moved here from src/admin.js unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import { log } from '../../log.js';
import { defineOp, perEnv } from './registry.ts';
import { objOf } from '../types.ts';
import type { OpContext } from '../types.ts';

const handlers = perEnv((env) => {
  const { slash, resolvedGuildId, journalSystem } = env;

  /**
   * Sets `paused`/`pausedAt` (and `pausedBy`, the caller) in state.json FIRST (so a crash or restart
   * mid-pause comes back paused), then waits out a turn already running and a
   * GIF recache in flight. Only once
   * all are idle does it clear the pending-ping queue when the deps give a `pending.clear` (the core gives none:
   * its pings wait for the resume), flush everything and drop every cache except state.json itself, so
   * nothing stale (or a late in-flight write) can land in data/ after the
   * owner starts editing it. Idempotent: a second call just reports the
   * state. Then the journal's `pause` record; nothing is posted to the chat (the persona learns
   * of the pause from the journal, src/memory/journal.js#offPeriods).
   */
  async function cmdPause(context: OpContext): Promise<string> {
    const state = env.store.state.data;
    if (state.paused) {
      return [
        `Already paused (since ${state.pausedAt ?? '?'}).`,
        `Files under data/ can be edited freely. Run ${slash('resume')} when done.`,
      ].join('\n');
    }

    state.paused = true;
    state.pausedAt = new Date().toISOString();
    // Who paused, for the status card; absent when the caller is unknown.
    if (context?.userId) state.pausedBy = String(context.userId);
    env.store.state.markDirty();
    env.store.flush();

    if (env.turns && typeof env.turns.waitIdle === 'function') {
      await env.turns.waitIdle();
    }

    // A GIF recache in flight writes the media cache: it stops before its
    // next GIF once `paused` is seen; wait for the one in flight.
    if (env.gifRecache && typeof env.gifRecache.waitIdle === 'function') {
      await env.gifRecache.waitIdle();
    }

    if (env.pending && typeof env.pending.clear === 'function') {
      env.pending.clear();
    }

    // A file held for the archive (an item rewritten in place) waits up to archive.holdMaxMs, then is written.
    if (typeof env.store.flushSettled === 'function')
      await env.store.flushSettled({ holdMaxMs: env.hot.config?.archive?.holdMaxMs ?? 5000 });
    else env.store.flush();
    const dropped = typeof env.store.dropCaches === 'function' ? env.store.dropCaches() : 0;

    log.info('admin: paused', { dropped });

    await journalSystem(resolvedGuildId(context), { event: 'pause', by: 'owner' });

    return [
      'Paused. Memory is flushed to disk -- files under data/ can be edited safely now.',
      `Run ${slash('resume')} when done.`,
    ].join('\n');
  }

  /**
   * Reports "Not paused." when called while not paused, before anything else
   * (idempotent). Otherwise refuses (staying paused) if any `*.json` under
   * data/ fails to parse, naming the offending paths; else re-reads
   * state.json (the owner may have hand-edited data/ while paused) and clears
   * the pause flags, letting every other cache lazily re-populate from disk.
   * Then the journal's `resume` record; nothing is posted to the chat. Then `pending.drain(guildId)` hands back
   * what the pause kept (the core's held messages and queued pings), never awaited. Last, the meaning index's
   * catch-up pass starts in the background (`embedQueue.catchUp`, never awaited; it does nothing
   * with the index switches off).
   */
  async function cmdResume(context: OpContext): Promise<string> {
    if (!env.store.state.data.paused) return 'Not paused.';

    const badFiles = typeof env.store.validate === 'function' ? env.store.validate() : [];
    if (badFiles.length > 0) {
      return [
        'Still paused: found invalid JSON under data/, fix or restore these files and try again:',
        ...(badFiles as Array<string>).map((file) => `  ${file}`),
      ].join('\n');
    }

    if (typeof env.store.reloadState === 'function') env.store.reloadState();
    const state = env.store.state.data;
    if (!state.paused) {
      return 'Not paused.';
    }

    delete state.paused;
    delete state.pausedAt;
    delete state.pausedBy;
    env.store.state.markDirty();
    env.store.flush();

    log.info('admin: resumed', {});

    const guildId = resolvedGuildId(context);
    await journalSystem(guildId, { event: 'resume', by: 'owner' });

    // What the pause kept: the messages held for the resume, then the queued direct pings (src/core.js). Never awaited.
    const drain = objOf(objOf(env).pending).drain;
    if (typeof drain === 'function') {
      Promise.resolve()
        .then(() => Reflect.apply(drain, objOf(env).pending, [guildId]) as unknown)
        .catch((err: unknown) => log.warn('admin: resume drain failed', { code: objOf(err).code ?? null }));
    }

    if (guildId && typeof env.embedQueue?.catchUp === 'function') {
      Promise.resolve()
        .then(() => env.embedQueue.catchUp(guildId))
        .catch((err: unknown) => log.warn('admin: embed catch-up failed', { code: objOf(err).code ?? null, guildId }));
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
  run: (args, ctx) => handlers(ctx.env).cmdResume(ctx),
});
