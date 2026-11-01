// What an agent principal may ask of the skills on the core socket (src/skills/agent-commands.ts): list the pending
// versions and activate one by name. The activation is recorded under the agent's name. Anything else is refused as
// invalid. Over a real port (tests/fixtures/skills-rig.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillCommand } from '../src/skills/agent-commands.ts';
import { skillText, skillsRig } from './fixtures/skills-rig.ts';

const HAND = { name: 'hand' };

test('skill.pending answers the pending versions as data', (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', skillText('look-it-up', 'd', ['web.search']));
  const answer = skillCommand(rig.port, HAND, 'skill.pending', {});
  assert.equal(answer.status, 'ok');
  assert.ok(Array.isArray(answer.data));
  assert.equal((answer.data as Array<{ skill: string }>)[0]?.skill, 'look-it-up');
});

test('skill.activate activates the newest candidate as agent:<name>', (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', skillText('look-it-up', 'd', ['web.search']));
  const answer = skillCommand(rig.port, HAND, 'skill.activate', { name: 'look-it-up' });
  assert.equal(answer.status, 'ok');
  assert.equal(rig.port.list()[0]?.active?.activatedBy, 'agent:hand');
  assert.equal(rig.port.active().length, 1);
});

test('skill.activate of a name with nothing pending fails and says why', (t) => {
  const rig = skillsRig(t);
  const answer = skillCommand(rig.port, HAND, 'skill.activate', { name: 'ghost' });
  assert.equal(answer.status, 'failed');
  assert.match(answer.text, /unknown-skill/);
});

test('skill.activate without a name, and any other command, is invalid and changes nothing', (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', skillText('look-it-up', 'd', ['web.search']));
  assert.equal(skillCommand(rig.port, HAND, 'skill.activate', {}).status, 'invalid');
  assert.equal(skillCommand(rig.port, HAND, 'skill.activate', { name: 7 }).status, 'invalid');
  assert.equal(skillCommand(rig.port, HAND, 'skill.rollback', { name: 'look-it-up' }).status, 'invalid');
  assert.equal(skillCommand(rig.port, HAND, 'skill.disable', { name: 'look-it-up' }).status, 'invalid');
  assert.equal(rig.port.active().length, 0);
});
