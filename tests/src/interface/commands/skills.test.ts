// Tests for src/interface/commands/skills.ts: the `/skills` commands of the console over a fake skills access.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { skillsCommand } from '../../../../src/interface/commands/skills.ts';
import type { SkillsAccess, SkillsPort } from '../../../../src/skills/port.ts';
import { createConsole } from '../../../../src/interface/commands/console.ts';
import type { ConsoleDeps } from '../../../../src/interface/commands/console.ts';
import { parseCommandLine } from '../../../../src/interface/commands/table.ts';
import { SKILLS_T0, skillText, skillsRig } from '../../../fixtures/skills-rig.ts';
import { tempDir } from '../../../fixtures/tmp.ts';

/** A skills access whose answers the test sets, recording the principal of every change. */
function fakeAccess(over: Partial<Record<keyof SkillsAccess, unknown>> = {}) {
  const principals: Array<string> = [];
  const change = (result: unknown) => (_skill: string, by: string) => {
    principals.push(by);
    return Promise.resolve(result);
  };
  const access = {
    list: () => Promise.resolve([]),
    problems: () => Promise.resolve([]),
    pending: () => Promise.resolve([]),
    review: () => Promise.resolve(null),
    activate: change({ ok: true, versionId: 'v2' }),
    rollback: change({ ok: true, active: 'v1' }),
    reject: change({ ok: true, rejected: 1 }),
    enable: change({ ok: true, changed: true }),
    disable: change({ ok: true, changed: false }),
    ...over,
  } as unknown as SkillsAccess;
  return { access, principals };
}

test('skillsCommand: every change runs as the principal owner', async () => {
  const { access, principals } = fakeAccess();
  for (const name of ['skills.activate', 'skills.rollback', 'skills.reject', 'skills.enable', 'skills.disable']) {
    await skillsCommand(access, name, { name: 'weather' });
  }
  assert.deepEqual(principals, ['owner', 'owner', 'owner', 'owner', 'owner']);
});

test('skillsCommand: a refused change fails with the command as typed and the registry code', async () => {
  const { access } = fakeAccess({ activate: () => Promise.resolve({ ok: false, code: 'skill-not-found' }) });
  assert.deepEqual(await skillsCommand(access, 'skills.activate', { name: 'weather' }), {
    text: '/skills activate weather: skill-not-found',
    status: 'failed',
  });
});

test('skillsCommand: an enable or disable that changes nothing says the switch was already in place', async () => {
  const { access } = fakeAccess();
  assert.equal((await skillsCommand(access, 'skills.disable', { name: 'weather' })).text, 'weather was already off');
  assert.equal((await skillsCommand(access, 'skills.enable', { name: 'weather' })).text, 'weather is on');
});

test('skillsCommand: the list names the states of a row and the refused folders', async () => {
  const row = {
    name: 'weather',
    active: { version: 'v3', activatedBy: 'owner', activatedAt: '2026-11-01T09:30:12.000Z' },
    disabled: true,
    disabledBy: 'owner',
    lifecycle: 'stale',
    missing: [{ tool: 'web.fetch', reason: 'not granted' }],
    rollbackTo: { version: 'v2' },
    candidates: 2,
  };
  const { access } = fakeAccess({
    list: () => Promise.resolve([row]),
    problems: () => Promise.resolve([{ dir: 'broken', code: 'bad-frontmatter' }]),
  });
  assert.deepEqual((await skillsCommand(access, 'skills.list', {})).text.split('\n'), [
    'weather  active; disabled by owner; stale, the file is gone; unavailable: web.fetch not granted  v3 by owner at 2026-11-01 09:30  rollback to v2  2 pending',
    'refused: broken (bad-frontmatter)',
  ]);
});

test('skillsCommand: review of an unknown skill fails and names it', async () => {
  const { access } = fakeAccess();
  assert.deepEqual(await skillsCommand(access, 'skills.review', { name: 'ghost' }), {
    text: '/skills review ghost: no skill named ghost',
    status: 'failed',
  });
});

test('skillsCommand: with no skills access every command fails', async () => {
  assert.deepEqual(await skillsCommand(null, 'skills.list', {}), {
    text: '/skills list: skills are not available here',
    status: 'failed',
  });
});

test('skillsCommand: an unknown subcommand fails and points to help', async () => {
  const { access } = fakeAccess();
  assert.equal((await skillsCommand(access, 'skills.nope', {})).text, '/skills nope: no such command; type /help');
});

const LOOK = skillText('look-it-up', 'I check the web first', ['web.search'], 'First body.');
const LOOK2 = skillText('look-it-up', 'I check the web twice', ['web.search', 'web.read'], 'Second body.');
// Changed: the tool a skill names is `voice.say`, since `pings.set` is no tool of the persona's.
const PING = skillText('ping-someone', 'I ping on request', ['voice.say']);

function desk(skills: SkillsPort | null) {
  const dir = tempDir('nep-skills-console-');
  const deps: ConsoleDeps = {
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: 'done', data: null }),
    ownerReads: { lessons: () => '' },
    places: () => ['g1'],
    selfId: () => 'self-1',
    hot: { config: { bot: { owners: [] } } },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
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
  rig.writeLocal('look-it-up', skillText('look-it-up', 'I check the web twice', ['voice.say'], 'Second body.'));
  rig.port.activate('look-it-up', 'agent:hand');
  const line = (await desk(rig.port)('/skills')).text.split('\n').find((one) => one.includes('look-it-up')) ?? '';
  assert.ok(line.includes('voice.say'), line);
  assert.ok(line.includes('not-granted'), line);
  assert.ok(line.includes(first), `the rollback target ${first} is shown: ${line}`);
});

test('pending lists the candidates with their tools', async (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', LOOK);
  const answer = await desk(rig.port)('/skills pending');
  assert.equal(answer.status, 'ok');
  for (const wanted of ['look-it-up', 'web.search']) assert.ok(answer.text.includes(wanted), wanted);
});

test('pending with nothing pending is ok and names no skill', async (t) => {
  const rig = skillsRig(t);
  const answer = await desk(rig.port)('/skills pending');
  assert.equal(answer.status, 'ok');
  assert.equal(answer.text.includes('look-it-up'), false);
});

test('review shows the text of the active version beside the candidate', async (t) => {
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

test('review of an unknown name fails naming it, and show is no command beside review', async (t) => {
  // Changed: `show` answered the active text that `review` shows with its candidates, so it is gone.
  // Catches: a typo reads as a skill with no versions, or the second word for one read comes back.
  const rig = skillsRig(t);
  const run = desk(rig.port);
  const missing = await run('/skills review ghost-skill');
  assert.notEqual(missing.status, 'ok');
  assert.ok(missing.text.includes('ghost-skill'));
  assert.equal(parseCommandLine('/skills show look-it-up').ok, false);
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

test("disable takes the skill out of the persona's index and enable brings it back", async (t) => {
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
