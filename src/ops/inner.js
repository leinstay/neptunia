// Operations: `/nep task inner action:stop|start|status` -- the kill switch of the persona's inner
// life (src/behavior/inner.js, docs/inner-life.md). `inner.stop` stops it (persisted with its
// state, so a restart stays stopped), drops every queued wake and makes every action of an inner
// turn already running refused right before it would happen; `inner.start` releases it;
// `inner.status` shows the switch, the mode, the stop, the queue, the day's review and what is
// left of each cap. Owner-only. Answers are operator lines (ids, codes, times, numbers).

import { defineOp, perEnv } from './registry.js';
import { CODE } from '../skills/codes.js';

/** The time of `ts` for an answer line (UTC, minutes), or `-`. */
function stamp(ts) {
  return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : '-';
}

const handlers = perEnv((env) => {
  const { resolvedGuildId } = env;

  /** The inner life, or an Error naming what is missing. */
  function inner() {
    if (!env.inner || typeof env.inner.stop !== 'function')
      throw Object.assign(new Error('the inner life is not running'), { code: CODE.NOT_CONFIGURED });
    return env.inner;
  }

  function cmdStop(args, context) {
    const result = inner().stop(resolvedGuildId(context), { by: context?.userId ?? null });
    if (!result.ok)
      return { status: 'failed', code: result.code, summary: `inner life not stopped: ${result.code}`, data: null };
    const text = result.already
      ? `inner life already stopped; ${result.dropped} queued wakes dropped`
      : `inner life stopped; ${result.dropped} queued wakes dropped`;
    return { status: 'ok', code: CODE.OK, summary: text, data: { text, dropped: result.dropped } };
  }

  function cmdStart(args, context) {
    const result = inner().start(resolvedGuildId(context), { by: context?.userId ?? null });
    if (!result.ok)
      return { status: 'failed', code: result.code, summary: `inner life not started: ${result.code}`, data: null };
    const text = result.already ? 'inner life was not stopped' : 'inner life started';
    return { status: 'ok', code: CODE.OK, summary: text, data: { text } };
  }

  function cmdStatus(args, context) {
    const s = inner().status(resolvedGuildId(context));
    const lines = [
      `inner life: ${s.on ? 'on' : 'off (features.innerLife)'}, mode ${s.mode}, ${s.stopped ? `stopped since ${stamp(s.stoppedAt)}` : 'running'}`,
    ];
    lines.push(
      `queue: ${s.queue.length}${s.queue.length > 0 ? ` (${s.queue.map((wake) => `${wake.kind} due ${stamp(wake.dueAt)}${wake.capped ? ` capped ${wake.capped}` : ''}`).join('; ')})` : ''}`
    );
    lines.push(
      `review: ${s.review ? `${s.review.day} ${s.review.done ? 'done' : `at ${stamp(s.review.at)}`}` : 'not drawn'}`
    );
    if (s.turnsToday != null) lines.push(`today: turns ${s.turnsToday}`);
    return lines.join('\n');
  }

  return { cmdStop, cmdStart, cmdStatus };
});

defineOp({
  name: 'inner.stop',
  rights: { kind: 'write', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdStop(args, ctx),
});
defineOp({
  name: 'inner.start',
  rights: { kind: 'write', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdStart(args, ctx),
});
defineOp({
  name: 'inner.status',
  rights: { kind: 'read', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdStatus(args, ctx),
});
