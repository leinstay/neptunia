// What the heartbeat does with the merged fixes of her own code (src/behavior/heartbeat-view.ts,
// src/behavior/inner/heartbeat.ts, src/behavior/selfimprovement-text.ts), and the two board changes they rest on: the
// `merged` condition of the machine and `ack_seqs` of `outbox.pull`. Each test names the bug it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHeartbeatFacts } from '../src/behavior/heartbeat-view.ts';
import { committedHeartbeat } from '../src/behavior/inner/heartbeat.ts';
import { proposalsOf } from '../src/behavior/selfimprovement-view.ts';
import { landedLines } from '../src/behavior/selfimprovement-text.ts';
import { BoardError, authorize } from '../src/board/machine.ts';
import type { Condition, Role } from '../src/board/machine.ts';
import { ackLanded, landedFor } from '../src/selfimprovement/landed.ts';
import type { Landed } from '../src/selfimprovement/landed.ts';
import { landTaskDirectly, selfimprovementWorld } from './fixtures/selfimprovement-rig.ts';
import type { InnerContext } from '../src/behavior/inner/types.ts';

const ONE: Landed = {
  seq: 7,
  taskId: 'T-1',
  title: 'Lift the timeout',
  files: ['src/web/read.ts'],
  pr: 12,
  decidedBy: 'owner',
};
const LABELS = {
  header: 'LANDED',
  item: '{task}|{title}|{who}|{files}',
  ownerMerged: 'OWNER',
  autoMerged: 'AUTO',
  filesMore: '+{count}',
};

test('the heartbeat facts carry the landed fixes they were given, and none by default', async () => {
  const withOne = await buildHeartbeatFacts({ guildId: 'g1', now: Date.UTC(2026, 10, 2), landed: [ONE] });
  assert.deepEqual(
    withOne.landed.map((one) => one.taskId),
    ['T-1']
  );
  // Bug: a heartbeat without the source shows a stale or undefined list.
  assert.deepEqual((await buildHeartbeatFacts({ guildId: 'g1', now: Date.UTC(2026, 10, 2) })).landed, []);
});

function lifeWith(ack: (seqs: ReadonlyArray<number>) => Promise<void>) {
  const warned: Array<string> = [];
  const life = {
    heartbeatSources: { ackLanded: ack },
    log: { warn: (message: string) => warned.push(message) },
  } as unknown as InnerContext;
  return { life, warned };
}

test('a committed heartbeat marks its landed rows delivered, and a turn that ended in an error marks none', async () => {
  const acked: Array<ReadonlyArray<number>> = [];
  const { life } = lifeWith((seqs) => {
    acked.push(seqs);
    return Promise.resolve();
  });
  const facts = await buildHeartbeatFacts({ guildId: 'g1', now: Date.UTC(2026, 10, 2), landed: [ONE] });
  await committedHeartbeat(life, 'g1', { facts, outcome: 'error' });
  // Bug: a failed turn consumes the news, and she never learns of the merge.
  assert.deepEqual(acked, []);
  await committedHeartbeat(life, 'g1', { facts, outcome: 'ok' });
  assert.deepEqual(acked, [[7]]);
});

test('a heartbeat whose acknowledgement fails logs it and does not throw', async () => {
  const { life, warned } = lifeWith(() => Promise.reject(new Error('board down')));
  const facts = await buildHeartbeatFacts({ guildId: 'g1', now: Date.UTC(2026, 10, 2), landed: [ONE] });
  await committedHeartbeat(life, 'g1', { facts, outcome: 'ok' });
  assert.equal(warned.length, 1);
});

test('acknowledging a landed row leaves the older outbox rows she was not shown', async (t) => {
  const world = selfimprovementWorld(t);
  // An older done row that is not a landed fix, then the landed one.
  landTaskDirectly(world, null);
  landTaskDirectly(world, { title: 'Fix', files: ['src/a.ts'], pr: 3, decidedBy: 'auto' });
  const { landed, seqs } = await landedFor(world.caller);
  assert.equal(landed.length, 1);
  await ackLanded(world.caller, seqs);
  // Bug: the cursor acknowledgement of the heartbeat marks the older row delivered unseen.
  const view = await proposalsOf(world.caller);
  assert.equal(view.outbox.length, 1);
  assert.equal((await landedFor(world.caller)).landed.length, 0);
});

test('the same landed fix in both wakes is listed once, oldest first, with its paths cut at eight', () => {
  const many = { ...ONE, seq: 9, taskId: 'T-2', files: Array.from({ length: 10 }, (_, n) => `f${n}.ts`) };
  const lines = landedLines([[many, ONE], [ONE]], LABELS);
  // Bug: a wake that carries both views repeats the fix, or lists an unbounded file list.
  assert.equal(lines[0], 'LANDED');
  assert.equal(lines.length, 3);
  assert.equal(lines[1], 'T-1|Lift the timeout|OWNER|src/web/read.ts');
  assert.ok(lines[2]?.endsWith('f7.ts+2'), lines[2]);
});

test('landed lines say who decided and are left out without their header or without a fix', () => {
  assert.ok(landedLines([[{ ...ONE, decidedBy: 'auto' }]], LABELS)[1]?.includes('AUTO'));
  assert.deepEqual(landedLines([[ONE]], { ...LABELS, header: '' }), []);
  assert.deepEqual(landedLines([[], undefined], LABELS), []);
});

function verdict(roles: ReadonlyArray<Role>, conditions: ReadonlyArray<Condition>): string {
  try {
    authorize({
      from: 'needs_validation',
      to: 'done',
      via: 'review',
      roles: new Set(roles),
      conditions: new Set(conditions),
    });
    return 'allowed';
  } catch (error) {
    if (error instanceof BoardError) return error.code;
    throw error;
  }
}

test('a reviewer closes a merged task without green CI, and a scheduler never does', () => {
  assert.equal(verdict(['reviewer'], ['merged']), 'allowed');
  // Bug: the merged condition opens the review to roles that may not close a task.
  assert.equal(verdict(['scheduler'], ['merged']), 'forbidden');
  assert.equal(verdict(['reviewer'], []), 'forbidden');
});
