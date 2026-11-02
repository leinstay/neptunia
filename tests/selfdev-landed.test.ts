// What a merge shows in her wake (src/selfdev/landed.ts): the title and the paths, once, in whichever of the
// selfimprovement and heartbeat wakes comes first. The board is real, the closing of the task is done through the
// board alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ackLanded, landedFor } from '../src/selfdev/landed.ts';
import { buildSelfimprovementFacts, proposalsOf } from '../src/behavior/selfimprovement-view.ts';
import { SELFDEV_T0, landTaskDirectly, selfdevWorld } from './fixtures/selfdev-rig.ts';

const LANDED = {
  title: 'Raise the web.read timeout',
  files: ['src/web/read.ts', 'tests/web-read.test.ts'],
  pr: 12,
  decidedBy: 'owner',
} as const;

test('a merged fix reaches her as its title and its paths, and nothing else', async (t) => {
  const world = selfdevWorld(t);
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
  const world = selfdevWorld(t);
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
  const world = selfdevWorld(t);
  landTaskDirectly(world, null);
  assert.deepEqual((await landedFor(world.caller)).landed, []);
});

test('the selfimprovement facts carry the landed change once, outside the plain outbox list', async (t) => {
  const world = selfdevWorld(t);
  landTaskDirectly(world, { ...LANDED, files: [...LANDED.files] });
  const view = await proposalsOf(world.caller);
  const { landed, seqs } = await landedFor(world.caller);
  const facts = await buildSelfimprovementFacts({
    guildId: 'g1',
    now: SELFDEV_T0,
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
