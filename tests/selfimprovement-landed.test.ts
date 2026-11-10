// What a merge shows in her wake (src/selfimprovement/landed.ts): the title and the paths, once, in whichever of the
// selfimprovement and heartbeat wakes comes first. The board is real, the closing of the task is done through the
// board alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ackLanded, landedFor } from '../src/selfimprovement/landed.ts';
import { buildSelfimprovementFacts, proposalsOf } from '../src/behavior/selfimprovement-view.ts';
import { SELFIMPROVEMENT_T0, landTaskDirectly, selfimprovementWorld } from './fixtures/selfimprovement-rig.ts';
import { landedLines } from '../src/behavior/selfimprovement-text.ts';
import { BoardError, authorize } from '../src/board/machine.ts';
import type { Condition, Role } from '../src/board/machine.ts';
import type { Landed } from '../src/selfimprovement/landed.ts';

const LANDED = {
  title: 'Raise the web.read timeout',
  files: ['src/web/read.ts', 'tests/web-read.test.ts'],
  pr: 12,
  decidedBy: 'owner',
} as const;

test('a merged fix reaches her as its title and its paths, and nothing else', async (t) => {
  const world = selfimprovementWorld(t);
  const id = landTaskDirectly(world, { ...LANDED, files: [...LANDED.files] });
  const { landed, seqs } = await landedFor(world.caller);
  assert.equal(landed.length, 1);
  const [one] = landed;
  assert.equal(one?.taskId, id);
  assert.equal(one?.title, LANDED.title);
  assert.deepEqual(one?.files, LANDED.files);
  assert.equal(one?.decidedBy, 'owner');
  assert.deepEqual(seqs, [one?.seq]);
  // Bug: the diff or the evidence text rides along into her prompt.
  assert.deepEqual(Object.keys(one ?? {}).sort(), ['decidedBy', 'files', 'pr', 'seq', 'taskId', 'title']);
});

test('the event is shown until a wake commits, then never again, whichever wake takes it', async (t) => {
  const world = selfimprovementWorld(t);
  landTaskDirectly(world, { ...LANDED, files: [...LANDED.files] });
  const heartbeat = await landedFor(world.caller);
  // A wake that did not commit shows it again.
  assert.equal((await landedFor(world.caller)).landed.length, 1);
  await ackLanded(world.caller, heartbeat.seqs);
  // Bug: the selfimprovement wake that follows tells her about the same merge a second time.
  assert.equal((await landedFor(world.caller)).landed.length, 0);
  const view = await proposalsOf(world.caller);
  assert.deepEqual(view.outbox, []);
});

test('a finished skill task is not a landed change', async (t) => {
  const world = selfimprovementWorld(t);
  landTaskDirectly(world, null);
  assert.deepEqual((await landedFor(world.caller)).landed, []);
});

test('the selfimprovement facts carry the landed change once, outside the plain outbox list', async (t) => {
  const world = selfimprovementWorld(t);
  landTaskDirectly(world, { ...LANDED, files: [...LANDED.files] });
  const view = await proposalsOf(world.caller);
  const { landed, seqs } = await landedFor(world.caller);
  const facts = await buildSelfimprovementFacts({
    now: SELFIMPROVEMENT_T0,
    since: null,
    journal: null,
    granted: [],
    skills: [],
    proposals: view.entries,
    outbox: view.outbox,
    landed,
  });
  assert.equal(facts.news.landed.length, 1);
  assert.equal(facts.news.landed[0]?.title, LANDED.title);
  // Bug: the same row is listed twice, as a landed change and as a bare "done" outbox row.
  assert.deepEqual(facts.news.outbox, []);
  // The seqs of the landed rows are acknowledged with the rest, or the heartbeat shows them again.
  assert.deepEqual(facts.outboxSeqs, seqs);
});

// How her wake words and marks the merged fixes of her own code (src/behavior/selfimprovement-text.ts,
// src/selfimprovement/landed.ts), and the two board changes they rest on: the
// `merged` condition of the machine and `ack_seqs` of `outbox.pull`. Each test names the bug it catches.

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

test('a reviewer closes a merged task without green CI, and a scheduler never does', () => {
  assert.equal(verdict(['reviewer'], ['merged']), 'allowed');
  // Bug: the merged condition opens the review to roles that may not close a task.
  assert.equal(verdict(['scheduler'], ['merged']), 'forbidden');
  assert.equal(verdict(['reviewer'], []), 'forbidden');
});
