import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeadline, createPrepLedger, lateMediaTeller } from '../src/behavior/turn-parts.ts';

/** A clock and a scheduler the test moves by hand: `tick(ms)` advances time and runs what is due. */
function manual() {
  let at = 0;
  const timers: Array<{ fn: () => void; due: number; cancelled: boolean }> = [];
  return {
    clock: () => at,
    schedule: (fn: () => void, ms: number) => {
      const timer = { fn, due: at + ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    tick(ms: number) {
      at += ms;
      for (const timer of timers) {
        if (!timer.cancelled && timer.due <= at) {
          timer.cancelled = true;
          timer.fn();
        }
      }
    },
  };
}

test('createDeadline passes once its limit has passed and not before', async () => {
  const t = manual();
  const deadline = createDeadline({ clock: t.clock, startedAt: 0, schedule: t.schedule, limitMs: 100 });
  t.tick(99);
  assert.equal(deadline.passed, false);
  assert.equal(deadline.leftMs(), 1);
  t.tick(1);
  await deadline.reached;
  assert.equal(deadline.passed, true);
  assert.equal(deadline.leftMs(), 0);
});

test('createDeadline without a limit never passes until it is closed', () => {
  const t = manual();
  const deadline = createDeadline({ clock: t.clock, startedAt: 0, schedule: t.schedule, limitMs: null });
  t.tick(1_000_000);
  assert.equal(deadline.passed, false);
  assert.equal(deadline.leftMs(), null);
  deadline.close();
  assert.equal(deadline.passed, true);
});

test('createDeadline moves to a later limit when extended', () => {
  const t = manual();
  const deadline = createDeadline({ clock: t.clock, startedAt: 0, schedule: t.schedule, limitMs: 100 });
  deadline.extend(300);
  t.tick(150);
  assert.equal(deadline.passed, false);
  t.tick(150);
  assert.equal(deadline.passed, true);
});

test('createDeadline keeps a limit that passed from passing while held work runs and passes when it settles', async () => {
  const t = manual();
  const deadline = createDeadline({ clock: t.clock, startedAt: 0, schedule: t.schedule, limitMs: 100 });
  let finish: () => void = () => {};
  deadline.hold(new Promise<void>((resolve) => (finish = resolve)), 500);
  t.tick(100);
  assert.equal(deadline.passed, false, 'held past its limit');
  finish();
  await deadline.reached;
  assert.equal(deadline.passed, true);
});

test('createDeadline does not hold for a limit that is not later than its own', () => {
  const t = manual();
  const deadline = createDeadline({ clock: t.clock, startedAt: 0, schedule: t.schedule, limitMs: 100 });
  deadline.hold(new Promise(() => {}), 100);
  t.tick(100);
  assert.equal(deadline.passed, true);
});

function recordedOp(log: Array<string>) {
  return {
    opId: 'op1',
    started: () => undefined,
    succeeded: (result: Record<string, unknown>) => void log.push(`succeeded ${JSON.stringify(result)}`),
    failed: (code: string) => void log.push(`failed ${code}`),
    unknown: () => void log.push('unknown'),
  };
}

test('createPrepLedger writes a step as delivered once its result is taken into the request', async () => {
  const log: Array<string> = [];
  const ledger = createPrepLedger();
  const step = ledger.step('links', recordedOp(log));
  await step.succeeded({ count: 2 });
  assert.deepEqual(log, [], 'not written before the stage is taken');
  ledger.take('links', true);
  assert.deepEqual(log, ['succeeded {"count":2,"delivered":true}']);
});

test('createPrepLedger writes a result that nothing took as not delivered when everything is closed', async () => {
  const log: Array<string> = [];
  const ledger = createPrepLedger();
  await ledger.step('captions', recordedOp(log)).succeeded({ count: 1 });
  ledger.closeAll();
  assert.deepEqual(log, ['succeeded {"count":1,"delivered":false}']);
});

test('createPrepLedger holds the record of a stage taken still out until a later request tells it', async () => {
  const log: Array<string> = [];
  const ledger = createPrepLedger();
  const step = ledger.step('videos', recordedOp(log));
  ledger.take('videos', false, { hold: true });
  await step.succeeded({ count: 1 });
  assert.deepEqual(log, [], 'waits for the later request');
  ledger.tell('videos');
  assert.deepEqual(log, ['succeeded {"count":1,"delivered":true}']);
});

test('createPrepLedger passes a failure of a step on and writes nothing more for it', async () => {
  const log: Array<string> = [];
  const ledger = createPrepLedger();
  await ledger.step('links', recordedOp(log)).failed('timeout');
  ledger.closeAll();
  assert.deepEqual(log, ['failed timeout']);
});

function tellerOver(over: { done?: boolean; videoState?: string; captionsDone?: boolean } = {}) {
  const told: Array<string> = [];
  const render = (lines: ReadonlyArray<object>) =>
    lines.map((line) => ({ id: (line as { id: string }).id, text: `rendered ${(line as { id: string }).id}` }));
  const teller = lateMediaTeller({
    lines: [{ id: 'm1' }, { id: 'm2' }],
    idByIndex: new Map([
      [1, 'm1'],
      [2, 'm2'],
    ]),
    handles: null,
    selfName: 'Bot',
    videoStage: { done: over.done ?? true, value: { videos: new Map([['v1', { state: over.videoState ?? 'done' }]]) } },
    videoItems: [{ itemId: 'v1', messageId: 'm1' }],
    captions: { done: over.captionsDone ?? false, value: { descriptions: new Map() } },
    captionItems: [{ messageId: 'm2' }],
    pending: { videoIds: ['v1'], captions: true },
    onTold: (stage) => void told.push(stage),
    transcript: render,
  });
  return { teller, told };
}

test('lateMediaTeller tells a video that finished since the request, once', () => {
  const { teller, told } = tellerOver();
  assert.equal(teller(), 'rendered m1');
  assert.deepEqual(told, ['videos']);
  assert.equal(teller(), '', 'a line is told once');
});

test('lateMediaTeller says nothing while the video is still pending or its stage is out', () => {
  assert.equal(tellerOver({ videoState: 'pending' }).teller(), '');
  assert.equal(tellerOver({ done: false }).teller(), '');
});

test('lateMediaTeller tells the lines with pictures once the late captions are in', () => {
  const { teller, told } = tellerOver({ captionsDone: true, videoState: 'pending' });
  assert.equal(teller(), 'rendered m2');
  assert.deepEqual(told, ['captions']);
});
