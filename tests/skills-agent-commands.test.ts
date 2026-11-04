// What an agent principal may ask of the skills on the core socket (src/skills/agent-commands.ts): list the pending
// versions. Anything else, an activation included, is refused as invalid. Filing is tests/skills-filing.test.ts. Over
// a real port (tests/fixtures/skills-rig.ts).
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

// The owner's decision of 2026-11-04 reverses the agent's activation: `skill.activate` with a name was `ok` here and is
// `invalid` now, and the two tests of a successful or failed agent activation left with it.
test('skill.activate, with or without a name, and any other command, is invalid and changes nothing', (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', skillText('look-it-up', 'd', ['web.search']));
  assert.equal(skillCommand(rig.port, HAND, 'skill.activate', { name: 'look-it-up' }).status, 'invalid');
  assert.equal(skillCommand(rig.port, HAND, 'skill.activate', {}).status, 'invalid');
  assert.equal(skillCommand(rig.port, HAND, 'skill.activate', { name: 7 }).status, 'invalid');
  assert.equal(skillCommand(rig.port, HAND, 'skill.rollback', { name: 'look-it-up' }).status, 'invalid');
  assert.equal(skillCommand(rig.port, HAND, 'skill.disable', { name: 'look-it-up' }).status, 'invalid');
  assert.equal(rig.port.active().length, 0);
});
