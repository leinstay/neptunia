// The skills port (src/skills/port.ts): the registry over the disk and the grants, as the persona's tools, the owner's
// `/skills` and an agent's commands use it. Every read looks at the skill folders first, so a file an agent wrote a
// moment ago is a pending version at once; only an activation puts a version in the persona's index; availability follows the persona's
// grants and the registry at the moment of the call and changes neither. A real memory database in memory and real
// temporary folders (tests/fixtures/skills-rig.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillText, skillsRig } from '../../fixtures/skills-rig.ts';

const LOOK = skillText(
  'look-it-up',
  'I check the web before I answer a fact',
  ['web.read', 'web.search'],
  'Search, read the best hit.'
);

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

// Changed: the tool a skill names is `voice.say`, since `pings.set` is no tool of the persona's.
test('a skill naming a tool the persona was not granted is active, listed unavailable with the tool and the reason, and the grants stay as they were', (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('ping-someone', skillText('ping-someone', 'I ping on request', ['voice.say']));
  const before = [...rig.granted].sort();
  rig.port.activate('ping-someone', 'agent:hand');
  const row = rig.port.list().find((one) => one.name === 'ping-someone');
  assert.deepEqual(row?.missing, [{ tool: 'voice.say', reason: 'not-granted' }]);
  assert.deepEqual([...rig.granted].sort(), before);
  assert.equal(rig.granted.has('voice.say'), false);
  assert.deepEqual(rig.port.active()[0]?.missing, [{ tool: 'voice.say', reason: 'not-granted' }]);
});

test('availability follows the grants at each call: granting the tool later makes the skill usable', (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('ping-someone', skillText('ping-someone', 'I ping on request', ['voice.say']));
  rig.port.activate('ping-someone', 'agent:hand');
  rig.granted.add('voice.say');
  assert.deepEqual(rig.port.list().find((one) => one.name === 'ping-someone')?.missing, []);
  rig.registered.delete('voice.say');
  assert.deepEqual(rig.port.list().find((one) => one.name === 'ping-someone')?.missing, [
    { tool: 'voice.say', reason: 'not-registered' },
  ]);
});

test('a skill that is only a candidate lists the missing tools of the version that would run', (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('ping-someone', skillText('ping-someone', 'I ping on request', ['voice.say']));
  const row = rig.port.list().find((one) => one.name === 'ping-someone');
  assert.equal(row?.active, null);
  assert.deepEqual(row?.missing, [{ tool: 'voice.say', reason: 'not-granted' }]);
});

test('show of an unknown name is null, and a skill with no active version shows no text', (t) => {
  const rig = skillsRig(t);
  assert.equal(rig.port.show('ghost'), null);
  rig.writeLocal('look-it-up', LOOK);
  assert.equal(rig.port.show('look-it-up')?.text, null);
});
