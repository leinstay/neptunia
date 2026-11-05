// The operation `inner.status` of the persona's inner life (src/behavior/inner.ts, docs/inner-life.md): it shows the
// mode, the stop, the queue, the day's review and what is left of each cap. Owner-only. Answers are operator lines
// (ids, codes, times, numbers).

import type { Untyped } from '../types.ts';
import { defineOp, perEnv } from './registry.ts';
import { CODE } from '../codes.ts';

/** The time of `ts` for an answer line (UTC, minutes), or `-`. */
function stamp(ts: number | null | undefined): string {
  return typeof ts === 'number' && Number.isFinite(ts)
    ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ')
    : '-';
}

const handlers = perEnv((env) => {
  /** The inner life, or an Error naming what is missing. */
  function inner() {
    if (!env.inner || typeof env.inner.status !== 'function')
      throw Object.assign(new Error('the inner life is not running'), { code: CODE.NOT_CONFIGURED });
    return env.inner;
  }

  function cmdStatus() {
    const s = inner().status();
    const lines = [`inner life: mode ${s.mode}, ${s.stopped ? `stopped since ${stamp(s.stoppedAt)}` : 'running'}`];
    lines.push(
      `queue: ${s.queue.length}${s.queue.length > 0 ? ` (${s.queue.map((wake: Untyped) => `${wake.kind} due ${stamp(wake.dueAt)}${wake.capped ? ` capped ${wake.capped}` : ''}`).join('; ')})` : ''}`
    );
    lines.push(
      `review: ${s.review ? `${s.review.day} ${s.review.done ? 'done' : `at ${stamp(s.review.at)}`}` : 'not drawn'}`
    );
    if (s.turnsToday != null) lines.push(`today: turns ${s.turnsToday}`);
    return lines.join('\n');
  }

  return { cmdStatus };
});

defineOp({
  name: 'inner.status',
  rights: { kind: 'read', ownerOnly: true },
  run: (...call) => handlers(call[1].env).cmdStatus(),
});
