// The owner's `/skills` commands through the console (src/interface/commands/console.ts) over a real skills port:
// list shows every skill with its activation, who made it, the version a rollback restores, and the tools it misses;
// pending, review and show read the registry; enable, disable, activate, rollback and reject change it as `owner`.
// The answers are text for the owner and the tests look for the names, versions, principals and tools they put in,
// never for wording. Without a port every command answers failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConsole } from '../src/interface/commands/console.ts';
import type { ConsoleDeps } from '../src/interface/commands/console.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import type { SkillsPort } from '../src/skills/port.ts';
import { SKILLS_T0, skillText, skillsRig } from './fixtures/skills-rig.ts';
import { tempDir } from './fixtures/tmp.js';

const LOOK = skillText('look-it-up', 'I check the web first', ['web.search'], 'First body.', 't0000001f');
const LOOK2 = skillText('look-it-up', 'I check the web twice', ['web.search', 'web.read'], 'Second body.');
const PING = skillText('ping-someone', 'I ping on request', ['pings.set']);

function desk(skills: SkillsPort | null) {
  const dir = tempDir('nep-skills-console-');
  const deps: ConsoleDeps = {
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: 'done', data: null }),
    ownerReads: { lessons: () => '', aliases: () => '' },
    guildId: () => 'g1',
    selfId: () => 'self-1',
    hot: { config: { bot: { owners: [] } } },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    conversationLines: () => [],
    now: () => SKILLS_T0,
    skills,
  };
  const console_ = createConsole(deps);
  return async (line: string) => {
    const parsed = parseCommandLine(line);
    assert.ok(parsed.ok, line);
    return console_.run(parsed.name, parsed.args, { id: 'owner-1' });
  };
}

test('list shows an activation with who made it and when, and a skill nobody activated as a candidate only', async (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', LOOK);
  rig.writeLocal('ping-someone', PING);
  rig.port.activate('look-it-up', 'agent:hand');
  const answer = await desk(rig.port)('/skills list');
  assert.equal(answer.status, 'ok');
  const lines = answer.text.split('\n');
  const look = lines.find((line) => line.includes('look-it-up')) ?? '';
  assert.ok(look.includes('agent:hand'), look);
  assert.ok(look.includes(rig.port.list()[0]?.active?.version ?? 'no-version'), look);
  const ping = lines.find((line) => line.includes('ping-someone')) ?? '';
  assert.equal(ping.includes('agent:hand'), false, 'nobody activated it');
});

test('list names the tool a skill misses with its reason, and shows the version a rollback restores', async (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', LOOK);
  rig.port.activate('look-it-up', 'agent:hand');
  const first = rig.port.list()[0]?.active?.version ?? 'no-version';
  rig.writeLocal('look-it-up', skillText('look-it-up', 'I check the web twice', ['pings.set'], 'Second body.'));
  rig.port.activate('look-it-up', 'agent:hand');
  const line = (await desk(rig.port)('/skills')).text.split('\n').find((one) => one.includes('look-it-up')) ?? '';
  assert.ok(line.includes('pings.set'), line);
  assert.ok(line.includes('not-granted'), line);
  assert.ok(line.includes(first), `the rollback target ${first} is shown: ${line}`);
});

test('pending lists the candidates with their tools and their task', async (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', LOOK);
  const answer = await desk(rig.port)('/skills pending');
  assert.equal(answer.status, 'ok');
  for (const wanted of ['look-it-up', 'web.search', 't0000001f']) assert.ok(answer.text.includes(wanted), wanted);
});

test('pending with nothing pending is ok and names no skill', async (t) => {
  const rig = skillsRig(t);
  const answer = await desk(rig.port)('/skills pending');
  assert.equal(answer.status, 'ok');
  assert.equal(answer.text.includes('look-it-up'), false);
});

test('review shows the text of the active version beside the candidate with the use counts', async (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', LOOK);
  rig.port.activate('look-it-up', 'agent:hand');
  rig.writeLocal('look-it-up', LOOK2);
  const answer = await desk(rig.port)('/skills review look-it-up');
  assert.equal(answer.status, 'ok');
  assert.ok(answer.text.includes('First body.'));
  assert.ok(answer.text.includes('Second body.'));
  assert.ok(answer.text.includes('web.read'));
});

test('show answers the active text, and an unknown name fails naming it', async (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', LOOK);
  rig.port.activate('look-it-up', 'agent:hand');
  const run = desk(rig.port);
  assert.ok((await run('/skills show look-it-up')).text.includes('First body.'));
  const missing = await run('/skills show ghost-skill');
  assert.notEqual(missing.status, 'ok');
  assert.ok(missing.text.includes('ghost-skill'));
});

test('activate, rollback and reject act as the owner', async (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', LOOK);
  const run = desk(rig.port);
  assert.equal((await run('/skills activate look-it-up')).status, 'ok');
  assert.equal(rig.port.list()[0]?.active?.activatedBy, 'owner');
  rig.writeLocal('look-it-up', LOOK2);
  assert.equal((await run('/skills reject look-it-up')).status, 'ok');
  assert.deepEqual(rig.port.pending(), []);
  rig.writeLocal('look-it-up', skillText('look-it-up', 'third', ['web.search'], 'Third body.'));
  await run('/skills activate look-it-up');
  assert.equal((await run('/skills rollback look-it-up')).status, 'ok');
  assert.equal(rig.port.show('look-it-up')?.text, LOOK);
});

test('disable takes the skill out of her index and enable brings it back', async (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', LOOK);
  rig.port.activate('look-it-up', 'agent:hand');
  const run = desk(rig.port);
  assert.equal((await run('/skills disable look-it-up')).status, 'ok');
  assert.deepEqual(rig.port.active(), []);
  assert.equal((await run('/skills enable look-it-up')).status, 'ok');
  assert.equal(rig.port.active().length, 1);
});

test('a refused change says which command and which name, and leaves the registry alone', async (t) => {
  const rig = skillsRig(t);
  const run = desk(rig.port);
  for (const line of ['/skills activate ghost-skill', '/skills rollback ghost-skill', '/skills disable ghost-skill']) {
    const answer = await run(line);
    assert.notEqual(answer.status, 'ok', line);
    assert.ok(answer.text.includes('ghost-skill'), line);
  }
  assert.deepEqual(rig.port.list(), []);
});

test('with no skills port every /skills command fails', async () => {
  const run = desk(null);
  for (const line of ['/skills', '/skills pending', '/skills activate look-it-up', '/skills disable look-it-up']) {
    assert.equal((await run(line)).status, 'failed', line);
  }
});
