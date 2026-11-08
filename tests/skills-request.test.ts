// Her skills as entries of the tools array in a live turn (plan 2026-11-06-turn-frame, slice 8): the array is the same
// for a reply in a room, a reply on the command line and a heartbeat; a call of a skill answers its text and a second
// call in the turn answers it again without a read; a wake refuses a skill outside its set by name. The real turn
// runner, the real operations and a real skills port over a memory database (tests/fixtures/skill-tool-turns.ts), a
// fake model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillTurn } from './fixtures/skill-tool-turns.ts';
import type { SkillTurn } from './fixtures/skill-tool-turns.ts';
import { skillText, skillsRig } from './fixtures/skills-rig.ts';
import type { SkillsRig } from './fixtures/skills-rig.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';

const BODY = 'Search first, then read the best hit and say where it came from.';

/** A rig with one active skill, `look-it-up`, which needs `web.search`. */
function withSkill(t: { after: (fn: () => void) => void }): SkillsRig {
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', skillText('look-it-up', 'I check the web first', ['web.search'], BODY));
  rig.port.activate('look-it-up', 'agent:hand');
  return rig;
}

/** The text of the last tool message of a request, '' with none. */
function lastToolResult(request: SkillTurn['requests'][number] | undefined): string {
  const message = [...(request ?? [])].reverse().find((one) => one.role === 'tool');
  return typeof message?.content === 'string' ? message.content : '';
}

test('the tools array is byte-identical between a reply in a room, a reply on the command line and a heartbeat', async (t) => {
  // Bug: a turn kind that filters its own tools breaks the one cached prefix and says another thing about what she can do.
  const rig = withSkill(t);
  const room = await skillTurn({ kind: 'discord-reply', answers: ['ok'], skills: rig.port });
  const cli = await skillTurn({ kind: 'cli-reply', answers: ['ok'], skills: rig.port });
  const heartbeat = await skillTurn({ kind: 'heartbeat', answers: ['ok'], skills: rig.port });
  assert.ok(room.offered.includes('look-it-up'), 'her active skill is an entry of the array');
  assert.equal(cli.toolsJson, room.toolsJson);
  assert.equal(heartbeat.toolsJson, room.toolsJson);
});

test('a call of a skill answers its text, and a second call in the same turn answers the same without a read', async (t) => {
  // Bug: every call reads the skill anew, so a version activated mid-turn changes the procedure she is following.
  const rig = withSkill(t);
  const run = await skillTurn({
    kind: 'discord-reply',
    answers: [toolAnswer('', [call('look-it-up')]), toolAnswer('', [call('look-it-up')]), 'done'],
    skills: rig.port,
  });
  assert.ok(lastToolResult(run.requests[1]).includes(BODY), 'the first call answers the text');
  assert.ok(lastToolResult(run.requests[2]).includes(BODY), 'the second call answers the same text');
  assert.deepEqual(run.readsAt.slice(1, 3), [1, 1]);
});

test('a heartbeat refuses a call of a skill outside its set with heartbeat-only', async (t) => {
  // Bug: a skill in the one tools array lets a heartbeat act before it decides on an intention.
  const rig = withSkill(t);
  const run = await skillTurn({
    kind: 'heartbeat',
    answers: [toolAnswer('', [call('look-it-up')]), 'ok'],
    skills: rig.port,
  });
  assert.ok(run.actions.includes('look-it-up:refused:heartbeat-only'), run.actions.join(', '));
  assert.equal(run.readsAt.at(-1), 0, 'the refused skill is never read');
});

test('a turn without the skill.read grant offers no skill entry', async (t) => {
  // Bug: the owner takes skill.read away and her skills are still offered and run as reads.
  const rig = withSkill(t);
  const grants = ['conversation.read', 'memory.search', 'message.create', 'web.search', 'skill.run', 'skill.disable'];
  const run = await skillTurn({ kind: 'discord-reply', answers: ['ok'], skills: rig.port, grants });
  assert.ok(run.offered.includes('web_search'), 'the granted tools are offered');
  assert.equal(run.offered.includes('look-it-up'), false);
});
