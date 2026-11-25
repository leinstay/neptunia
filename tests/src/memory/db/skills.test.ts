// The skills registry in the memory database (src/memory/db/skills.ts, schema v11 tables): a synced SKILL.md becomes a
// candidate version, an agent or the owner activates it, nobody else does, and every activation can be rolled back. A
// memory database in memory on the calling thread, an injected clock, no disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import {
  activateSkill,
  activateVersion,
  listSkills,
  pendingVersions,
  rejectVersion,
  reviewOf,
  rollbackSkill,
  setDisabled,
  syncSkills,
} from '../../../../src/memory/db/skills.ts';
import type { SkillSource, SkillsHandle } from '../../../../src/memory/db/skills.ts';
import { skillText, skillsRig } from '../../../fixtures/skills-rig.ts';

const T0 = Date.parse('2026-11-01T09:00:00Z');
const AGENT = 'agent:hand';

/** A skill file as the loader hands it over: the text decides the hash. */
function skill(name: string, text = `v1 of ${name}`, tools: Array<string> = ['web.search']): SkillSource {
  const source = `---\nname: ${name}\n---\n${text}`;
  return { name, tools, source, contentHash: createHash('sha256').update(source).digest('hex') };
}

function open(t: { after: (fn: () => void) => void }): SkillsHandle {
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  return handle;
}

/** The active version id of a skill, from its row. */
const activeOf = (handle: SkillsHandle, name: string): string | null => {
  const row = listSkills(handle).find((one) => one.name === name);
  return row?.active?.versionId ?? null;
};

/** The id of the newest pending version of `name`. */
function pendingId(handle: SkillsHandle, name: string): string {
  const found = pendingVersions(handle)
    .filter((one) => one.skill === name)
    .at(-1);
  if (found === undefined) throw new Error(`no pending version of ${name}`);
  return found.versionId;
}

test('a synced file is one candidate version and nothing is active until someone activates it', (t) => {
  const handle = open(t);
  const counts = syncSkills(handle, [skill('look-it-up', 'v1', ['web.read', 'web.search'])], { at: T0 });
  assert.deepEqual(counts, { skills: 1, versions: 1, stale: 0 });
  const [row] = listSkills(handle);
  assert.equal(row?.name, 'look-it-up');
  assert.equal(row?.active, null);
  assert.equal(row?.candidates, 1);
  const [pending] = pendingVersions(handle);
  assert.deepEqual(pending?.tools, ['web.read', 'web.search']);
  assert.equal(pending?.status, 'candidate');
  assert.equal(pending?.source.endsWith('v1'), true);
});

test('syncing the same file again changes nothing', (t) => {
  const handle = open(t);
  syncSkills(handle, [skill('look-it-up')], { at: T0 });
  assert.deepEqual(syncSkills(handle, [skill('look-it-up')], { at: T0 + 1000 }), { skills: 0, versions: 0, stale: 0 });
  assert.equal(pendingVersions(handle).length, 1);
});

test('syncing no file registers nothing', (t) => {
  const handle = open(t);
  assert.deepEqual(syncSkills(handle, [], { at: T0 }), { skills: 0, versions: 0, stale: 0 });
  assert.deepEqual(listSkills(handle), []);
});

test('an agent activates the first version and the list shows who, when, and the activation as it stands', (t) => {
  const handle = open(t);
  syncSkills(handle, [skill('look-it-up')], { at: T0 });
  const done = activateSkill(handle, 'look-it-up', { at: T0 + 1000, by: AGENT });
  assert.equal(done.ok, true);
  const [row] = listSkills(handle);
  assert.equal(row?.active?.activatedBy, AGENT);
  assert.equal(row?.active?.activatedAt, new Date(T0 + 1000).toISOString());
  assert.equal(row?.candidates, 0);
  assert.equal(row?.rollbackTo, null, 'a first version has nothing to roll back to');
});

test('a later version waits as a candidate beside the active one, and activation retires the old one with a rollback', (t) => {
  const handle = open(t);
  syncSkills(handle, [skill('look-it-up', 'one')], { at: T0 });
  activateSkill(handle, 'look-it-up', { at: T0 + 1, by: AGENT });
  const first = activeOf(handle, 'look-it-up');
  syncSkills(handle, [skill('look-it-up', 'two')], { at: T0 + 2 });
  assert.equal(activeOf(handle, 'look-it-up'), first, 'a sync never moves the active version');
  const review = reviewOf(handle, 'look-it-up');
  assert.equal(review?.active?.versionId, first);
  assert.equal(review?.candidates.length, 1);
  const done = activateSkill(handle, 'look-it-up', { at: T0 + 3, by: 'owner' });
  assert.deepEqual(done.ok && done.previous, first);
  const [row] = listSkills(handle);
  assert.equal(row?.rollbackTo?.versionId, first);
  assert.equal(row?.active?.activatedBy, 'owner');
});

test('a newer file retires the candidate it replaces before anyone activated that one', (t) => {
  const handle = open(t);
  syncSkills(handle, [skill('look-it-up', 'draft')], { at: T0 });
  syncSkills(handle, [skill('look-it-up', 'better draft')], { at: T0 + 1 });
  const pending = pendingVersions(handle);
  assert.equal(pending.length, 1);
  const newest = pending[0];
  assert.equal(newest?.source.endsWith('better draft'), true);
});

test('refuses to activate a version twice, a retired version, and a name nobody synced', (t) => {
  const handle = open(t);
  syncSkills(handle, [skill('look-it-up')], { at: T0 });
  const id = pendingId(handle, 'look-it-up');
  assert.equal(activateVersion(handle, id, { at: T0 + 1, by: AGENT }).ok, true);
  assert.deepEqual(activateVersion(handle, id, { at: T0 + 2, by: AGENT }), { ok: false, code: 'already-active' });
  assert.deepEqual(activateVersion(handle, 'skillver:nope', { at: T0, by: AGENT }), {
    ok: false,
    code: 'unknown-version',
  });
  assert.deepEqual(activateSkill(handle, 'ghost', { at: T0, by: AGENT }), { ok: false, code: 'unknown-skill' });
  assert.deepEqual(activateSkill(handle, 'look-it-up', { at: T0, by: AGENT }), { ok: false, code: 'no-candidate' });
});

test('a rejected candidate is retired, cannot be activated, and a sync of the same text does not bring it back', (t) => {
  const handle = open(t);
  syncSkills(handle, [skill('look-it-up')], { at: T0 });
  const id = pendingId(handle, 'look-it-up');
  assert.deepEqual(rejectVersion(handle, id, { at: T0 + 1, by: 'owner' }), { ok: true });
  assert.deepEqual(activateVersion(handle, id, { at: T0 + 2, by: AGENT }), { ok: false, code: 'not-candidate' });
  assert.deepEqual(rejectVersion(handle, id, { at: T0 + 3, by: 'owner' }), { ok: false, code: 'not-candidate' });
  syncSkills(handle, [skill('look-it-up')], { at: T0 + 4 });
  assert.deepEqual(pendingVersions(handle), []);
});

test('rollback restores the previous version, twice walks back two, and a first version has none', (t) => {
  const handle = open(t);
  const stamps = [T0 + 10, T0 + 20, T0 + 30];
  const ids: Array<string> = [];
  for (const [index, text] of ['one', 'two', 'three'].entries()) {
    syncSkills(handle, [skill('look-it-up', text)], { at: stamps[index] ?? T0 });
    ids.push(pendingId(handle, 'look-it-up'));
    activateSkill(handle, 'look-it-up', { at: (stamps[index] ?? T0) + 1, by: AGENT });
  }
  assert.equal(activeOf(handle, 'look-it-up'), ids[2]);
  const back = rollbackSkill(handle, 'look-it-up', { at: T0 + 40, by: 'owner' });
  assert.deepEqual(back, { ok: true, active: ids[1], retired: ids[2] });
  assert.deepEqual(rollbackSkill(handle, 'look-it-up', { at: T0 + 50, by: 'owner' }), {
    ok: true,
    active: ids[0],
    retired: ids[1],
  });
  assert.deepEqual(rollbackSkill(handle, 'look-it-up', { at: T0 + 60, by: 'owner' }), {
    ok: false,
    code: 'no-rollback',
  });
  assert.equal(activeOf(handle, 'look-it-up'), ids[0], 'the first version stays active');
  assert.deepEqual(rollbackSkill(handle, 'ghost', { at: T0, by: 'owner' }), { ok: false, code: 'unknown-skill' });
});

test('disabling is idempotent, keeps the active version, and enabling brings the switch back', (t) => {
  const handle = open(t);
  syncSkills(handle, [skill('look-it-up')], { at: T0 });
  activateSkill(handle, 'look-it-up', { at: T0 + 1, by: AGENT });
  const active = activeOf(handle, 'look-it-up');
  assert.deepEqual(setDisabled(handle, 'look-it-up', true, { at: T0 + 2, by: 'persona' }), { ok: true, changed: true });
  assert.deepEqual(setDisabled(handle, 'look-it-up', true, { at: T0 + 3, by: 'persona' }), {
    ok: true,
    changed: false,
  });
  const [off] = listSkills(handle);
  assert.equal(off?.disabled, true);
  assert.equal(off?.disabledBy, 'persona');
  assert.equal(off?.active?.versionId, active);
  assert.deepEqual(setDisabled(handle, 'look-it-up', false, { at: T0 + 4, by: 'owner' }), { ok: true, changed: true });
  assert.equal(listSkills(handle)[0]?.disabled, false);
  assert.deepEqual(setDisabled(handle, 'ghost', true, { at: T0, by: 'owner' }), { ok: false, code: 'unknown-skill' });
});

test('a skill whose file is gone is stale, keeps its active version, and is active again when the file returns', (t) => {
  const handle = open(t);
  syncSkills(handle, [skill('look-it-up'), skill('other-one')], { at: T0 });
  activateSkill(handle, 'look-it-up', { at: T0 + 1, by: AGENT });
  assert.deepEqual(syncSkills(handle, [skill('other-one')], { at: T0 + 2 }), { skills: 0, versions: 0, stale: 1 });
  const gone = listSkills(handle).find((row) => row.name === 'look-it-up');
  assert.equal(gone?.lifecycle, 'stale');
  assert.equal(gone?.active?.activatedBy, AGENT);
  syncSkills(handle, [skill('look-it-up'), skill('other-one')], { at: T0 + 3 });
  assert.equal(listSkills(handle).find((row) => row.name === 'look-it-up')?.lifecycle, 'active');
});

test('review of an unknown skill is null and of a skill with no active version lists only its candidates', (t) => {
  const handle = open(t);
  assert.equal(reviewOf(handle, 'ghost'), null);
  syncSkills(handle, [skill('look-it-up')], { at: T0 });
  const review = reviewOf(handle, 'look-it-up');
  assert.equal(review?.active, null);
  assert.equal(review?.candidates.length, 1);
});

// The skills port (src/skills/port.ts): the registry over the disk and the grants, as the persona's tools, the owner's
// `/skills` and an agent's commands use it. Every read looks at the skill folders first, so a file an agent wrote a
// moment ago is a pending version at once; only an activation puts a version in their index; availability follows their
// grants and the registry at the moment of the call and changes neither. A real memory database in memory and real
// temporary folders (tests/fixtures/skills-rig.ts).

const LOOK = skillText(
  'look-it-up',
  'I check the web before I answer a fact',
  ['web.read', 'web.search'],
  'Search, read the best hit.'
);

test('a file written to skills.local is a pending version at the next read and not an active skill', (t) => {
  const rig = skillsRig(t);
  assert.deepEqual(rig.port.pending(), []);
  rig.writeLocal('look-it-up', LOOK);
  const pending = rig.port.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.skill, 'look-it-up');
  assert.deepEqual(rig.port.active(), []);
});

test('the active text stays the activated one when the file on disk is edited afterwards', (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', LOOK);
  rig.port.activate('look-it-up', 'agent:hand');
  rig.writeLocal('look-it-up', skillText('look-it-up', 'a new description', ['web.search'], 'A different body.'));
  assert.equal(rig.port.show('look-it-up')?.text, LOOK);
  assert.equal(rig.port.active()[0]?.description, 'I check the web before I answer a fact');
  assert.equal(rig.port.pending().length, 1, 'the edit waits as a candidate');
});

test('disabling takes the skill out of active() and enabling brings it back', (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', LOOK);
  rig.port.activate('look-it-up', 'agent:hand');
  assert.deepEqual(rig.port.disable('look-it-up', 'persona'), { ok: true, changed: true });
  assert.deepEqual(rig.port.active(), []);
  assert.equal(rig.port.list()[0]?.disabled, true);
  assert.deepEqual(rig.port.enable('look-it-up', 'owner'), { ok: true, changed: true });
  assert.equal(rig.port.active().length, 1);
});

test('rejecting retires every pending version of the name and refuses a name with none', (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', LOOK);
  assert.deepEqual(rig.port.reject('look-it-up', 'owner'), { ok: true, rejected: 1 });
  assert.deepEqual(rig.port.pending(), []);
  assert.deepEqual(rig.port.reject('look-it-up', 'owner'), { ok: false, code: 'no-candidate' });
  assert.deepEqual(rig.port.reject('ghost', 'owner'), { ok: false, code: 'unknown-skill' });
});

test('rolling back after a second activation restores the first text', (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', LOOK);
  rig.port.activate('look-it-up', 'agent:hand');
  const second = skillText('look-it-up', 'second words', ['web.search'], 'Second body.');
  rig.writeLocal('look-it-up', second);
  rig.port.activate('look-it-up', 'agent:hand');
  assert.equal(rig.port.show('look-it-up')?.text, second);
  assert.equal(rig.port.rollback('look-it-up', 'owner').ok, true);
  assert.equal(rig.port.show('look-it-up')?.text, LOOK);
});
