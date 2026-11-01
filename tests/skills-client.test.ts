// The skills client (src/skills/client.ts): the port's calls over the memory writer, as the running core holds them.
// The writer is the real `applySkillsWrite` on an in-memory database behind a promise, wrapped to record the updates
// it was handed; the skill folders are real temporary folders (tests/fixtures/skills-rig.ts). A closed database is a
// write that rejects and a read connection that is null.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySkillsWrite } from '../src/memory/db/skills.ts';
import type { SkillsUpdate } from '../src/memory/db/skills.ts';
import { loadSkills } from '../src/skills/load.ts';
import { createSkillsClient } from '../src/skills/client.ts';
import { skillText, skillsRig, SKILLS_T0 } from './fixtures/skills-rig.ts';
import type { SkillsRig } from './fixtures/skills-rig.ts';

const LOOK = skillText(
  'look-it-up',
  'I check the web before I answer a fact',
  ['web.read', 'web.search'],
  'Search, read the best hit.',
  't0000001f'
);

/** A client over the rig's database; `updates` holds each write it made, in order. */
function clientOver(rig: SkillsRig) {
  const updates: Array<SkillsUpdate> = [];
  const client = createSkillsClient({
    write: (update) => {
      updates.push(update);
      return Promise.resolve(applySkillsWrite(rig.handle, update));
    },
    read: () => rig.handle,
    now: () => rig.clock.t,
    load: () => loadSkills(rig.folders),
    granted: () => rig.granted,
    registered: () => rig.registered,
    reviewDays: () => 30,
  });
  return { client, updates };
}

/** A client whose database is closed: every write rejects and there is no read connection. */
function closedClient(rig: SkillsRig) {
  return createSkillsClient({
    write: () => Promise.reject(new Error('memory database is not open')),
    read: () => null,
    now: () => rig.clock.t,
    load: () => loadSkills(rig.folders),
    granted: () => rig.granted,
    registered: () => rig.registered,
    reviewDays: () => 30,
  });
}

test('a skill file written a moment ago is activated in one call and then shows in active() with its stored text', async (t) => {
  // Catches a change that skips the sync: the write would answer unknown-skill for a file the disk already holds.
  const rig = skillsRig(t);
  const { client } = clientOver(rig);
  rig.writeLocal('look-it-up', LOOK);
  const answer = await client.activate('look-it-up', 'agent:hand');
  assert.equal(answer.ok, true);
  const [active] = await client.active();
  assert.equal(active?.name, 'look-it-up');
  assert.deepEqual(active?.tools, ['web.read', 'web.search']);
  assert.equal((await client.show('look-it-up'))?.text, LOOK);
  assert.deepEqual(await client.pending(), []);
});

test('a change carries the clock and the principal, and sync sends only name, tools, task, hash and source', async (t) => {
  // Catches a write that drops `at` or `by` (the activation history would lose who and when) or leaks the loader's
  // layer and dir into the registry's input.
  const rig = skillsRig(t);
  const { client, updates } = clientOver(rig);
  rig.writeLocal('look-it-up', LOOK);
  rig.clock.t = SKILLS_T0 + 5_000;
  await client.activate('look-it-up', 'agent:hand');
  const sync = updates.find((one) => one.op === 'sync');
  assert.deepEqual(Object.keys(sync?.files[0] ?? {}).sort(), ['contentHash', 'name', 'source', 'task', 'tools']);
  assert.equal(sync?.at, SKILLS_T0 + 5_000);
  const activate = updates.find((one) => one.op === 'activate');
  assert.equal(activate?.at, SKILLS_T0 + 5_000);
  assert.equal(activate?.by, 'agent:hand');
  assert.equal((await client.list())[0]?.active?.activatedBy, 'agent:hand');
});

test('disable and enable write the switch each way and active() follows', async (t) => {
  // Catches the two switches sharing one flag value: enable would leave the skill off.
  const rig = skillsRig(t);
  const { client } = clientOver(rig);
  rig.writeLocal('look-it-up', LOOK);
  await client.activate('look-it-up', 'agent:hand');
  assert.deepEqual(await client.disable('look-it-up', 'persona'), { ok: true, changed: true });
  assert.deepEqual(await client.active(), []);
  assert.deepEqual(await client.enable('look-it-up', 'owner'), { ok: true, changed: true });
  assert.equal((await client.active()).length, 1);
});

test('reject retires the pending versions and rollback walks back to the earlier one', async (t) => {
  const rig = skillsRig(t);
  const { client } = clientOver(rig);
  rig.writeLocal('look-it-up', LOOK);
  await client.activate('look-it-up', 'agent:hand');
  const second = skillText('look-it-up', 'second wording', ['web.search']);
  rig.writeLocal('look-it-up', second);
  await client.activate('look-it-up', 'agent:hand');
  assert.equal((await client.show('look-it-up'))?.text, second);
  const back = await client.rollback('look-it-up', 'owner');
  assert.equal(back.ok, true);
  assert.equal((await client.show('look-it-up'))?.text, LOOK);
  rig.writeLocal('look-it-up', skillText('look-it-up', 'third wording', ['web.search']));
  assert.deepEqual(await client.reject('look-it-up', 'owner'), { ok: true, rejected: 1 });
  assert.deepEqual(await client.pending(), []);
});

test('availability is read at each call from the grants the caller holds now', async (t) => {
  // Catches grants captured when the client was built.
  const rig = skillsRig(t, { granted: ['web.read'] });
  const { client } = clientOver(rig);
  rig.writeLocal('look-it-up', LOOK);
  await client.activate('look-it-up', 'agent:hand');
  assert.deepEqual((await client.active())[0]?.missing, [{ tool: 'web.search', reason: 'not-granted' }]);
  rig.granted.add('web.search');
  assert.deepEqual((await client.active())[0]?.missing, []);
});

test('record writes the use rows and answers how many were written', async (t) => {
  const rig = skillsRig(t);
  const { client } = clientOver(rig);
  rig.writeLocal('look-it-up', LOOK);
  await client.activate('look-it-up', 'agent:hand');
  const versionId = (await client.active())[0]?.versionId ?? '';
  const at = SKILLS_T0 + 1000;
  const written = await client.record([
    { skill: 'look-it-up', versionId, turnId: 'turn-1', kind: 'discovered', at },
    { skill: 'look-it-up', versionId, turnId: 'turn-1', kind: 'read', at },
  ]);
  assert.equal(written, 2);
});

test('an empty registry answers empty lists, null lookups and unknown-skill refusals', async (t) => {
  const rig = skillsRig(t);
  const { client } = clientOver(rig);
  assert.deepEqual(await client.sync(), { skills: 0, versions: 0, stale: 0 });
  assert.deepEqual(await client.list(), []);
  assert.deepEqual(await client.active(), []);
  assert.deepEqual(await client.pending(), []);
  assert.equal(await client.show('nothing'), null);
  assert.equal(await client.review('nothing'), null);
  assert.deepEqual(await client.activate('nothing', 'owner'), { ok: false, code: 'unknown-skill' });
  assert.deepEqual(await client.record([]), 0);
});

test('problems() reports the files that did not parse at the moment of the call', (t) => {
  const rig = skillsRig(t);
  const { client } = clientOver(rig);
  assert.deepEqual(client.problems(), []);
  rig.writeLocal('broken', 'no front matter here');
  assert.deepEqual(client.problems(), [{ dir: 'broken', code: 'no-front-matter' }]);
});

test('with the database closed lists are empty, changes are refused with db-closed and nothing throws', async (t) => {
  // Catches a rejected write escaping as an exception into the turn, or a closed database answering ok.
  const rig = skillsRig(t);
  const client = closedClient(rig);
  rig.writeLocal('look-it-up', LOOK);
  assert.deepEqual(await client.sync(), { skills: 0, versions: 0, stale: 0 });
  assert.deepEqual(await client.active(), []);
  assert.deepEqual(await client.list(), []);
  assert.deepEqual(await client.pending(), []);
  assert.equal(await client.show('look-it-up'), null);
  assert.equal(await client.review('look-it-up'), null);
  for (const answer of [
    await client.activate('look-it-up', 'owner'),
    await client.rollback('look-it-up', 'owner'),
    await client.reject('look-it-up', 'owner'),
    await client.disable('look-it-up', 'owner'),
    await client.enable('look-it-up', 'owner'),
  ]) {
    assert.deepEqual(answer, { ok: false, code: 'db-closed' });
  }
  assert.equal(
    await client.record([{ skill: 'look-it-up', versionId: 'v', turnId: 't', kind: 'read', at: SKILLS_T0 }]),
    0
  );
});

test('a database that closes after a sync still refuses the change instead of throwing', async (t) => {
  // The sync write succeeds and the change write rejects: the answer is db-closed, not a rejection.
  const rig = skillsRig(t);
  let calls = 0;
  const client = createSkillsClient({
    write: (update) => {
      calls += 1;
      if (update.op !== 'sync') return Promise.reject(new Error('closed'));
      return Promise.resolve(applySkillsWrite(rig.handle, update));
    },
    read: () => rig.handle,
    now: () => rig.clock.t,
    load: () => loadSkills(rig.folders),
    granted: () => rig.granted,
    registered: () => rig.registered,
    reviewDays: () => 30,
  });
  rig.writeLocal('look-it-up', LOOK);
  assert.deepEqual(await client.activate('look-it-up', 'owner'), { ok: false, code: 'db-closed' });
  assert.equal(calls, 2);
});
