// New reproductions, written from the risks the plan describes (timer races and double delivery after a restart); the
// original scenarios were not found. An errand's end reaches its result turn along three paths: the service reopening
// unseen ends at start, the door replaying an `errand.done` the core never marked delivered, and the retry timer of a
// turn that was held back. However they interleave, one end opens one turn. `createErrandTurns` runs with a fake turn
// runner, fake reads and a fake timer, so every order below is fixed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createErrandTurns, errandDoneEvent } from '../src/errands/turns.ts';
import type { ErrandRecord } from '../src/errands/types.ts';
import type { Reads } from '../src/interface/reads.ts';

const T0 = Date.UTC(2026, 10, 5, 9, 0, 0);
const MINUTE = 60_000;

const ERRAND = {
  id: 'errand-1',
  agent: 'scout',
  goal: 'find the opening hours',
  state: 'done',
  requester: { userId: 'u1', kind: 'member' },
  origin: { channelId: 'c1' },
} as unknown as ErrandRecord;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function rig({ busy = () => false }: { busy?: () => boolean } = {}) {
  let now = T0;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const turns: Array<Record<string, unknown>> = [];
  const held: Array<() => void> = [];
  let hold = false;
  const read = new Set<string>();
  const service = createErrandTurns({
    hot: { config: { errands: { resultRetrySeconds: 30 } } },
    // The fake holds the two reads a result turn uses.
    reads: {
      conversationInfo: () => Promise.resolve({ id: 'c1' }),
      fetchMessages: () => Promise.resolve({ messages: [] }),
    } as unknown as Reads,
    iface: () => 'fake',
    turns: {
      isBusy: busy,
      isAnyBusy: busy,
      runTurn: (input) => {
        turns.push(input);
        if (!hold) return Promise.resolve({ outcome: 'spoke' });
        return new Promise((resolve) => held.push(() => resolve({ outcome: 'spoke' })));
      },
    },
    errands: {
      markSeen: () => 1,
      markRead: ({ ids = [] }: { ids?: ReadonlyArray<string> }) => {
        for (const id of ids) read.add(id);
        return ids.length;
      },
      markResultFailed: () => 0,
      store: () =>
        ({ get: (id: string) => (read.has(id) ? { ...ERRAND, readAt: now } : ERRAND) }) as unknown as ReturnType<
          NonNullable<Parameters<typeof createErrandTurns>[0]['errands']>['store'] & object
        >,
    } as Parameters<typeof createErrandTurns>[0]['errands'],
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { at: now + ms, fn, live: true };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
  });
  return {
    service,
    turns,
    read,
    holdTurns: () => {
      hold = true;
    },
    finishHeld: () => {
      for (const finish of held.splice(0)) finish();
    },
    /** Moves the clock and fires every timer due by then. */
    advance: async (ms: number): Promise<void> => {
      now += ms;
      for (const timer of timers.filter((one) => one.live && one.at <= now)) {
        timer.live = false;
        timer.fn();
        await settle();
      }
    },
  };
}

test('new reproduction: the restart reopening an end and the door replaying it open one turn', async () => {
  // Bug: at a restart `start` calls onFinished for an unseen end while the door replays its errand.done, and neither
  // knows of the other, so two result turns answer one errand and she repeats herself in the channel.
  const { service, turns, holdTurns, finishHeld } = rig();
  holdTurns();
  const reopened = service.onFinished(ERRAND, 'g1');
  const replayed = service.onEvent(errandDoneEvent(ERRAND, 'g1', () => T0));
  await settle();
  finishHeld();
  await settle();
  await Promise.all([reopened, replayed]);
  assert.equal(turns.length, 1);
});

test('new reproduction: the same end replayed while its first turn runs opens no second turn', async () => {
  // Bug: `readAt` is only written when the turn ends, so a second delivery during the turn finds the end unread.
  const { service, turns, holdTurns, finishHeld, advance } = rig();
  holdTurns();
  const first = service.onEvent(errandDoneEvent(ERRAND, 'g1', () => T0));
  await settle();
  await service.onEvent(errandDoneEvent(ERRAND, 'g1', () => T0 + 1));
  await settle();
  finishHeld();
  await first;
  await advance(2 * MINUTE);
  finishHeld();
  await settle();
  assert.equal(turns.length, 1);
});

test('new reproduction: a retry timer that fires after the end was read opens no turn', async () => {
  // Bug: the timer holds the errand as it was when the turn was held back, and never asks whether she has read it since.
  let busy = true;
  const { service, turns, read, advance } = rig({ busy: () => busy });
  await service.onEvent(errandDoneEvent(ERRAND, 'g1', () => T0));
  assert.equal(turns.length, 0, 'held back by the attention');
  busy = false;
  read.add(ERRAND.id);
  await advance(MINUTE);
  assert.equal(turns.length, 0);
});

test('new reproduction: two deliveries held back at once arm one retry, so one turn comes of them', async () => {
  // Bug: the second retry overwrites the first in `waiting`, both timers stay armed, stop clears only the last, and
  // when the attention frees up each opens a turn.
  let busy = true;
  const { service, turns, advance } = rig({ busy: () => busy });
  await service.onEvent(errandDoneEvent(ERRAND, 'g1', () => T0));
  await service.onEvent(errandDoneEvent(ERRAND, 'g1', () => T0 + 1));
  busy = false;
  await advance(MINUTE);
  await advance(2 * MINUTE);
  assert.equal(turns.length, 1);
});
