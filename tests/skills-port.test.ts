// The skills port (src/skills/port.ts): the registry over the disk and the grants, as her tools, the owner's
// `/skills` and an agent's commands use it. Every read looks at the skill folders first, so a file an agent wrote a
// moment ago is a pending version at once; only an activation puts a version in her index; availability follows her
// grants and the registry at the moment of the call and changes neither. A real memory database in memory and real
// temporary folders (tests/fixtures/skills-rig.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillText, skillsRig } from './fixtures/skills-rig.ts';

const LOOK = skillText(
  'look-it-up',
  'I check the web before I answer a fact',
  ['web.read', 'web.search'],
  'Search, read the best hit.',
  't0000001f'
);

test('a file written to skills.local is a pending version at the next read and not an active skill', (t) => {
  const rig = skillsRig(t);
  assert.deepEqual(rig.port.pending(), []);
  rig.writeLocal('look-it-up', LOOK);
  const pending = rig.port.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.skill, 'look-it-up');
  assert.equal(pending[0]?.task, 't0000001f');
  assert.deepEqual(rig.port.active(), []);
});

test('activating makes the skill active with its description and tools read from the stored text', (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', LOOK);
  assert.equal(rig.port.activate('look-it-up', 'agent:hand').ok, true);
  const [active] = rig.port.active();
  assert.equal(active?.name, 'look-it-up');
  assert.equal(active?.description, 'I check the web before I answer a fact');
  assert.deepEqual(active?.tools, ['web.read', 'web.search']);
  assert.deepEqual(active?.missing, []);
  assert.equal(rig.port.pending().length, 0);
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

test('a skill naming a tool she was not granted is active, listed unavailable with the tool and the reason, and her grants stay as they were', (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('ping-someone', skillText('ping-someone', 'I ping on request', ['pings.set']));
  const before = [...rig.granted].sort();
  rig.port.activate('ping-someone', 'agent:hand');
  const row = rig.port.list().find((one) => one.name === 'ping-someone');
  assert.deepEqual(row?.missing, [{ tool: 'pings.set', reason: 'not-granted' }]);
  assert.deepEqual([...rig.granted].sort(), before);
  assert.equal(rig.granted.has('pings.set'), false);
  assert.deepEqual(rig.port.active()[0]?.missing, [{ tool: 'pings.set', reason: 'not-granted' }]);
});

test('availability follows the grants at each call: granting the tool later makes the skill usable', (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('ping-someone', skillText('ping-someone', 'I ping on request', ['pings.set']));
  rig.port.activate('ping-someone', 'agent:hand');
  rig.granted.add('pings.set');
  assert.deepEqual(rig.port.list().find((one) => one.name === 'ping-someone')?.missing, []);
  rig.registered.delete('pings.set');
  assert.deepEqual(rig.port.list().find((one) => one.name === 'ping-someone')?.missing, [
    { tool: 'pings.set', reason: 'not-registered' },
  ]);
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

test('a skill that is only a candidate lists the missing tools of the version that would run', (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('ping-someone', skillText('ping-someone', 'I ping on request', ['pings.set']));
  const row = rig.port.list().find((one) => one.name === 'ping-someone');
  assert.equal(row?.active, null);
  assert.deepEqual(row?.missing, [{ tool: 'pings.set', reason: 'not-granted' }]);
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

test('a skill unread past reviewDays is marked for review in the list and stays listed', (t) => {
  const rig = skillsRig(t, { reviewDays: 10 });
  rig.writeLocal('look-it-up', LOOK);
  rig.port.activate('look-it-up', 'agent:hand');
  assert.equal(rig.port.list()[0]?.reviewDue, false);
  rig.clock.t += 11 * 86_400_000;
  assert.equal(rig.port.list()[0]?.reviewDue, true);
  assert.equal(rig.port.list().length, 1);
});

test('show of an unknown name is null, and a skill with no active version shows no text', (t) => {
  const rig = skillsRig(t);
  assert.equal(rig.port.show('ghost'), null);
  rig.writeLocal('look-it-up', LOOK);
  assert.equal(rig.port.show('look-it-up')?.text, null);
});

test('a file that does not parse is no skill and breaks nothing else', (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('broken-one', 'no front matter\n');
  rig.writeLocal('look-it-up', LOOK);
  assert.deepEqual(
    rig.port.pending().map((one) => one.skill),
    ['look-it-up']
  );
});
