// How her wake words and marks the merged fixes of her own code (src/behavior/selfimprovement-text.ts,
// src/selfimprovement/landed.ts), and the two board changes they rest on: the
// `merged` condition of the machine and `ack_seqs` of `outbox.pull`. Each test names the bug it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposalsOf } from '../src/behavior/selfimprovement-view.ts';
import { landedLines } from '../src/behavior/selfimprovement-text.ts';
import { BoardError, authorize } from '../src/board/machine.ts';
import type { Condition, Role } from '../src/board/machine.ts';
import { ackLanded, landedFor } from '../src/selfimprovement/landed.ts';
import type { Landed } from '../src/selfimprovement/landed.ts';
import { landTaskDirectly, selfimprovementWorld } from './fixtures/selfimprovement-rig.ts';

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

// The three tests of the heartbeat's landed facts and acknowledgement left here: landed results no longer belong to the
// heartbeat, and tests/wake-separation.test.ts covers that it leaves them undelivered.

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
