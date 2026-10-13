// Operations: `/nep pause|resume`: the maintenance mode in which data/ may be edited by hand.
// The handler bodies moved here from src/admin.js unchanged; each `run` calls one of them with
// the operation's `ctx` as the command context.

import { log } from '../log.js';
import { defineOp, perEnv } from './registry.js';

const handlers = perEnv((env) => {
  const { hot, store, turns, memory, pending, warmup, gifRecache, slash, resolvedGuildId, journalSystem } = env;

  /**
   * Sets `paused`/`pausedAt` (and `pausedBy`, the caller) in state.json FIRST (so a crash or restart
   * mid-pause comes back paused), then waits out a turn already running, AND
   * a live-analyzer `run()` or voice run already in flight (its LLM call can take
   * 30-90s; `tick()`/`observe()` are already no-ops from the moment `paused`
   * is set, so no NEW run can start -- this only waits out one that started
   * before the pause), a warmup run or portrait refresh, and a GIF recache in flight. Only once
   * all are idle does it clear the pending-ping
   * queue, flush everything and drop every cache except state.json itself, so
   * nothing stale (or a late in-flight write) can land in data/ after the
   * owner starts editing it. Idempotent: a second call just reports the
   * state. Then the journal's `pause` record; nothing is posted to the chat (the persona learns
   * of the pause from the journal, src/memory/journal.js#offPeriods).
   */
  async function cmdPause(context) {
    const state = store.state.data;
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
    store.state.markDirty();
    store.flush();

    if (turns && typeof turns.waitIdle === 'function') {
      await turns.waitIdle();
    }

    // The live analyzer's own in-flight run (if any) must land on disk
    // BEFORE the flush + dropCaches below -- see the header comment above.
    // Its waitIdle also covers a voice run in flight, which writes nothing
    // once it sees `paused`.
    if (memory && typeof memory.waitIdle === 'function') {
      await memory.waitIdle();
    }

    // A warmup run/one-off target or a portrait refresh already in flight:
    // same rule. The run's loop stops after the request in flight once
    // `paused` is seen; a refresh whose answer arrives now writes nothing.
    if (warmup && typeof warmup.waitIdle === 'function') {
      await warmup.waitIdle();
    }

    // A GIF recache in flight writes the media cache: it stops before its
    // next GIF once `paused` is seen; wait for the one in flight.
    if (gifRecache && typeof gifRecache.waitIdle === 'function') {
      await gifRecache.waitIdle();
    }

    if (pending && typeof pending.clear === 'function') {
      pending.clear();
    }

    // A file held for the archive (an item rewritten in place) waits up to archive.holdMaxMs, then is written.
    if (typeof store.flushSettled === 'function') await store.flushSettled({ holdMaxMs: hot.config?.archive?.holdMaxMs ?? 5000 });
    else store.flush();
    const dropped = typeof store.dropCaches === 'function' ? store.dropCaches() : 0;

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
   * Then the journal's `resume` record; nothing is posted to the chat.
   */
  async function cmdResume(context) {
    if (!store.state.data.paused) return 'Not paused.';

    const badFiles = typeof store.validate === 'function' ? store.validate() : [];
    if (badFiles.length > 0) {
      return [
        'Still paused: found invalid JSON under data/, fix or restore these files and try again:',
        ...badFiles.map((file) => `  ${file}`),
      ].join('\n');
    }

    if (typeof store.reloadState === 'function') store.reloadState();
    const state = store.state.data;
    if (!state.paused) {
      return 'Not paused.';
    }

    delete state.paused;
    delete state.pausedAt;
    delete state.pausedBy;
    store.state.markDirty();
    store.flush();

    log.info('admin: resumed', {});

    await journalSystem(resolvedGuildId(context), { event: 'resume', by: 'owner' });

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
