// Tests for the retry of a failed event on the serving side of the link (src/protocol/serve.ts with an outbox),
// end to end: the serving side over the loopback to the core's link (src/interface/link.ts) and its event door
// (src/interface/door.ts). The core answers `failed` while an event's observation is still being written past its
// deadline; its watermark stays below that event until the event is taken. The serving side sends a failed event again,
// marked `replayed`, after a delay on its injected timers, so the watermark moves on and the outbox drains without a
// reconnect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoopback } from '../src/protocol/index.ts';
import { serveAdapter } from '../src/protocol/serve.ts';
import type { Hello } from '../src/protocol/serve.ts';
import { createOutbox } from '../src/protocol/outbox.ts';
import type { Outbox } from '../src/protocol/outbox.ts';
import type { Capabilities } from '../src/protocol/adapter.ts';
import { openAdapterLink } from '../src/interface/link.ts';
import { createEventDoor } from '../src/interface/door.ts';
import type { EventHandlerContext, ObservationCommit } from '../src/interface/door.ts';
import { createFakeAdapter } from '../src/interface/fake.ts';
import { tempDir } from './fixtures/tmp.ts';

const quiet = { info() {}, warn() {}, error() {} };
const CAPABILITIES: Capabilities = {
  operations: ['message.send'],
  maxChars: 2000,
  maxFiles: 10,
  maxFileBytes: 4096,
  edit: { ownOnly: true, windowMs: null },
  history: true,
  threads: false,
  reactions: true,
  customEmoji: false,
  presence: false,
  voiceFormats: [],
  publish: [],
  search: false,
};
const HELLO: Hello = {
  iface: 'fake',
  self: { id: 'self-id', name: 'Nova' },
  root: { id: 'g1', name: 'Alpha' },
  capabilities: CAPABILITIES,
  resume: null,
};

function reaction(id: string): Record<string, unknown> {
  return {
    kind: 'reaction.changed',
    iface: 'fake',
    at: 1,
    id,
    chat: { id: 'c1', kind: 'channel' },
    messageId: 'm1',
    emoji: { name: 'x' },
    accountId: 'u1',
    added: true,
  };
}

async function until(check: () => boolean, ms = 500): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return true;
}

const settle = (): Promise<boolean> => until(() => false, 30);

/** Timers the test fires by hand: `fire` runs every timer set and not cleared so far. */
function handTimers() {
  type Timer = { fn: () => void; cleared: boolean };
  const queued: Array<Timer> = [];
  return {
    set(fn: () => void): unknown {
      const timer: Timer = { fn, cleared: false };
      queued.push(timer);
      return timer;
    },
    clear(timer: unknown): void {
      const found = queued.find((one) => one === timer);
      if (found !== undefined) found.cleared = true;
    },
    waiting: (): number => queued.filter((one) => !one.cleared).length,
    fire(): void {
      for (const timer of queued.splice(0)) if (!timer.cleared) timer.fn();
    },
  };
}

/**
 * The observation write of one event: the first write of `slowId` waits for `release` and then lands or fails by
 * `lateOutcome`; every other write lands at once. `stored` lists what landed, `replayed` what came marked so.
 */
function rig(options: { capacity: number; lateOutcome?: 'lands' | 'fails'; handledKind?: string }) {
  const stored: Array<string> = [];
  const replayed: Array<string> = [];
  const state = { slowWrites: 0, slowArrivals: 0 };
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = async (id: string): Promise<ObservationCommit> => {
    if (id === 'slow' && state.slowWrites++ === 0) {
      await gate;
      if (options.lateOutcome === 'fails') return { ok: false, code: 'DB_BUSY' };
    }
    stored.push(id);
    return { ok: true, sourceId: `src-${id}` };
  };
  const door = createEventDoor({
    handlers: {
      // The observe path: the write is claimed and awaited up to its deadline, which the slow one misses.
      [options.handledKind ?? 'reaction.changed']: (
        event: { id: string; replayed?: boolean },
        context: EventHandlerContext
      ) => {
        if (event.replayed === true) replayed.push(event.id);
        const missesDeadline = event.id === 'slow' && state.slowArrivals++ === 0;
        const pending = context.receipt?.observe(() => write(event.id));
        return missesDeadline ? undefined : pending;
      },
    },
    log: quiet,
  });
  const { core, client } = createLoopback();
  openAdapterLink({ transport: core, door, token: 'tok', log: quiet });
  const timers = handTimers();
  const outbox: Outbox = createOutbox({ dir: tempDir('nep-serve-retry-'), capacity: options.capacity });
  const serving = serveAdapter({
    transport: client,
    hello: HELLO,
    token: 'tok',
    adapter: createFakeAdapter({ selfId: 'self-id' }),
    log: quiet,
    outbox,
    timers,
  });
  const pendingIds = (): Array<unknown> => outbox.pending().map((entry) => entry.event.id);
  return { serving, outbox, timers, stored, replayed, release: () => release(), pendingIds };
}

test('a slow observation past its deadline does not hold the watermark back once its write lands', async () => {
  const run = rig({ capacity: 4 });
  assert.equal(await run.serving.emit(reaction('slow')), 'failed');
  run.release();
  for (const id of ['e2', 'e3']) assert.equal(await run.serving.emit(reaction(id)), 'ok');
  run.timers.fire();
  await until(() => run.outbox.pending().length === 0);
  assert.deepEqual(run.pendingIds(), []);
  // The outbox has room for every later event: none is lost to a full outbox.
  for (const id of ['e4', 'e5', 'e6', 'e7', 'e8']) assert.equal(await run.serving.emit(reaction(id)), 'ok');
  assert.equal(run.serving.status().outbox, 'ok');
  assert.deepEqual(run.stored, ['slow', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8']);
});

test('a late write that fails is run again from the outbox and stored, marked replayed', async () => {
  const run = rig({ capacity: 4, lateOutcome: 'fails' });
  assert.equal(await run.serving.emit(reaction('slow')), 'failed');
  run.release();
  assert.equal(await run.serving.emit(reaction('e2')), 'ok');
  await settle();
  run.timers.fire();
  await until(() => run.outbox.pending().length === 0);
  assert.deepEqual(run.pendingIds(), []);
  assert.deepEqual(run.stored, ['e2', 'slow']);
  assert.deepEqual(run.replayed, ['slow']);
});

test('an event still being written when its retry comes is tried again later', async () => {
  const run = rig({ capacity: 4 });
  assert.equal(await run.serving.emit(reaction('slow')), 'failed');
  run.timers.fire();
  await settle();
  assert.deepEqual(run.pendingIds(), ['slow']);
  assert.equal(run.timers.waiting(), 1);
  run.release();
  await settle();
  run.timers.fire();
  await until(() => run.outbox.pending().length === 0);
  assert.deepEqual(run.pendingIds(), []);
});

test('an event the core takes without a handler is never sent again', async () => {
  const run = rig({ capacity: 4, handledKind: 'presence.changed' });
  assert.equal(await run.serving.emit(reaction('e1')), 'unhandled');
  await settle();
  assert.equal(run.timers.waiting(), 0);
  assert.deepEqual(run.pendingIds(), []);
});

test('closing the link stops the retry of a failed event', async () => {
  const run = rig({ capacity: 4 });
  assert.equal(await run.serving.emit(reaction('slow')), 'failed');
  assert.equal(run.timers.waiting(), 1);
  run.serving.close();
  assert.equal(run.timers.waiting(), 0);
});
