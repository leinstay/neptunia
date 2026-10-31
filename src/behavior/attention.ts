// Her attention as leases in the memory database (src/memory/db/wake-queue.ts): the turn runner's set of the
// conversations a turn runs in (src/behavior/turn.js, `attention`), each entry mirrored by the lease `attention:*`
// while `mention.oneAtATime` holds (the default: one turn anywhere), else `attention:<conversation>`. A lease lasts
// `context.turnLeaseMs` and is renewed while the turn runs, at a third of that; the turn's end lets it go. The set in
// process stays what decides whether a turn may start, because a turn takes the attention before anything is awaited;
// the lease is what another process sees, and one a stopped process left is taken over once it expired. The writes
// go through the memory database's writer and never hold a turn up: a failure is logged with its code. src/core.js
// builds it for the turn runner.

import { errorCode, objOf } from '../tools/types.ts';
import type { WakeQueueUpdate } from '../memory/db/wake-queue.ts';

/** How long a lease lasts when `context.turnLeaseMs` is not set (config.json's default). */
const TURN_LEASE_MS = 300_000;

/**
 * What the attention needs: the memory database (src/memory/db/service.js, its `memoryWrite`), the live config
 * (`hot.config`), a holder name, the clock and the log (its `warn`). The core's objects come from untyped JS, so they
 * are checked where they are used.
 */
export type AttentionOptions = {
  memoryDb: unknown;
  hot: unknown;
  holder: string;
  now?: () => number;
  log: unknown;
};

/** A method of `target` bound to it, or null. */
function methodOf(target: unknown, name: string): ((...args: Array<unknown>) => unknown) | null {
  const method: unknown = target !== null && typeof target === 'object' ? Reflect.get(target, name) : null;
  return typeof method === 'function'
    ? (...args: Array<unknown>): unknown => Reflect.apply(method, target, args)
    : null;
}

/** One held attention: its lease name, the token once granted, and the renewal timer. */
type Held = { name: string; token: number | null; timer: ReturnType<typeof setInterval> };

/** The turn runner's attention set, its entries mirrored as leases (see the head of this file). */
class LeasedAttention extends Set<string> {
  readonly #options: AttentionOptions;
  readonly #held = new Map<string, Held>();

  constructor(options: AttentionOptions) {
    super();
    this.#options = options;
  }

  add(conversationId: string): this {
    if (this.has(conversationId)) return this;
    super.add(conversationId);
    this.#take(conversationId);
    return this;
  }

  delete(conversationId: string): boolean {
    const removed = super.delete(conversationId);
    if (removed) this.#letGo(conversationId);
    return removed;
  }

  #settings(): { oneAtATime: boolean; ttlMs: number } {
    const config = objOf(objOf(this.#options.hot).config);
    const ttl = objOf(config.context).turnLeaseMs;
    return {
      oneAtATime: objOf(config.mention).oneAtATime !== false,
      ttlMs: typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 ? ttl : TURN_LEASE_MS,
    };
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #warn(message: string, fields: Record<string, unknown>): void {
    methodOf(this.#options.log, 'warn')?.(message, fields);
  }

  #write(update: WakeQueueUpdate): Promise<unknown> {
    const write = methodOf(this.#options.memoryDb, 'memoryWrite');
    if (!write) return Promise.resolve(null);
    return Promise.resolve()
      .then(() => write(update))
      .catch((err: unknown) => {
        this.#warn('attention: lease write failed', { op: update.op, code: errorCode(err) });
        return null;
      });
  }

  #take(conversationId: string): void {
    const { oneAtATime, ttlMs } = this.#settings();
    const name = oneAtATime ? 'attention:*' : `attention:${conversationId}`;
    const held: Held = {
      name,
      token: null,
      timer: setInterval(() => {
        if (held.token === null) return;
        void this.#write({ kind: 'wake-queue', op: 'lease-renew', name, token: held.token, now: this.#now(), ttlMs });
      }, ttlMs / 3),
    };
    held.timer.unref();
    this.#held.set(conversationId, held);
    const { holder } = this.#options;
    void this.#write({ kind: 'wake-queue', op: 'lease-acquire', name, holder, now: this.#now(), ttlMs }).then(
      (answer) => {
        const grant = objOf(answer);
        if (grant.ok === true && typeof grant.token === 'number') held.token = grant.token;
        else if (answer !== null) this.#warn('attention: lease held elsewhere', { name });
        // The turn ended before the grant came back: the lease goes at once.
        if (!this.#held.has(conversationId) && held.token !== null) this.#release(held);
      }
    );
  }

  #letGo(conversationId: string): void {
    const held = this.#held.get(conversationId);
    if (!held) return;
    this.#held.delete(conversationId);
    clearInterval(held.timer);
    if (held.token !== null) this.#release(held);
  }

  #release(held: Held): void {
    if (held.token === null) return;
    void this.#write({ kind: 'wake-queue', op: 'lease-release', name: held.name, token: held.token, now: this.#now() });
  }
}

/** The turn runner's attention over the memory database's leases. */
export function createLeasedAttention(options: AttentionOptions): Set<string> {
  return new LeasedAttention(options);
}
