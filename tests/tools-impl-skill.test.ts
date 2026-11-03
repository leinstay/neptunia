// Her skill tools (src/tools/impl/skill.ts): `skill.read` answers the whole stored text of an active skill, and
// `skill.disable` is her own switch, which the owner undoes with `/skills enable`. Neither is granted to her in the
// tracked config: the owner opens them with `/tools grant`. The operations' environment gets the skills port from the
// core (`createOpsEnv({ skills })`); a core with none answers failed. A real port over a memory database and real
// temporary folders (tests/fixtures/skills-rig.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOpPrechecked } from '../src/tools/impl/index.ts';
import { createOpsEnv } from '../src/tools/impl/env.ts';
import { SKILL_DEFINITIONS } from '../src/tools/definitions.ts';
import { grantedToPersona } from '../src/tools/access.ts';
import { createDiscordInterface } from '../interfaces/discord/index.ts';
import type { SkillsPort } from '../src/skills/port.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { skillText, skillsRig } from './fixtures/skills-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SELF_ID = '900';
const LOOK = skillText('look-it-up', 'I check the web first', ['web.search'], 'Search, then read the best hit.');

type Result = { status: string; code?: string | null; summary?: string; data?: unknown };

function envOf(skills: SkillsPort | null) {
  const hot = {
    config: { bot: { owners: ['42'], access: {} }, features: {} },
    prompts: { labels: {} },
    rootDir: tempDir('nep-tools-skill-root-'),
    reloadConfig: () => true,
  };
  return createOpsEnv({
    discord: createDiscordInterface().capabilities,
    hot,
    store: { state: { data: {}, markDirty() {} } },
    client: { channels: { cache: new Map() } },
    spontaneous: {},
    calibrator: { ratio: 1 },
    getGuildId: () => 'g1',
    board: null,
    skills,
  });
}

/** Her own call on an inner turn: nobody asks, the actor is the persona. */
async function callOf(skills: SkillsPort | null, name: string, args: Record<string, unknown>): Promise<Result> {
  const env = envOf(skills);
  const { result } = await withCapturedLogs(() =>
    runOpPrechecked(name, args, { env, guildId: 'g1', channelId: 'c1', userId: null, roleIds: [], actor: 'persona' })
  );
  return result;
}

test('skill.read answers the whole text of the active version with its id', async (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', LOOK);
  rig.port.activate('look-it-up', 'agent:hand');
  const result = await callOf(rig.port, 'skill.read', { name: 'look-it-up' });
  assert.equal(result.status, 'ok');
  assert.equal(result.summary, LOOK);
  assert.deepEqual(result.data, { name: 'look-it-up', versionId: rig.port.list()[0]?.active?.versionId, text: LOOK });
});

test('skill.read of a skill nobody activated fails and shows no text', async (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', LOOK);
  const result = await callOf(rig.port, 'skill.read', { name: 'look-it-up' });
  assert.equal(result.status, 'failed');
  assert.equal(String(result.summary ?? '').includes('Search, then read'), false);
});

test('skill.read of an unknown name and of a disabled skill fails', async (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', LOOK);
  rig.port.activate('look-it-up', 'agent:hand');
  assert.equal((await callOf(rig.port, 'skill.read', { name: 'ghost' })).status, 'failed');
  rig.port.disable('look-it-up', 'owner');
  assert.equal((await callOf(rig.port, 'skill.read', { name: 'look-it-up' })).status, 'failed');
});

test('skill.read without a name is invalid', async (t) => {
  const rig = skillsRig(t);
  assert.equal((await callOf(rig.port, 'skill.read', {})).status, 'invalid');
});

test('skill.disable takes the skill out of her index and the owner enables it again', async (t) => {
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', LOOK);
  rig.port.activate('look-it-up', 'agent:hand');
  assert.equal((await callOf(rig.port, 'skill.disable', { name: 'look-it-up' })).status, 'ok');
  assert.deepEqual(rig.port.active(), []);
  assert.equal(rig.port.list()[0]?.disabledBy, 'persona');
  rig.port.enable('look-it-up', 'owner');
  assert.equal(rig.port.active().length, 1);
});

test('skill.disable of an unknown name fails and without a name is invalid', async (t) => {
  const rig = skillsRig(t);
  assert.equal((await callOf(rig.port, 'skill.disable', { name: 'ghost' })).status, 'failed');
  assert.equal((await callOf(rig.port, 'skill.disable', {})).status, 'invalid');
});

test('both tools fail when the core has no skills port', async () => {
  assert.equal((await callOf(null, 'skill.read', { name: 'look-it-up' })).status, 'failed');
  assert.equal((await callOf(null, 'skill.disable', { name: 'look-it-up' })).status, 'failed');
});

test('her skill tools exist with a required name and the tracked config grants neither to her', () => {
  for (const tool of ['skill.read', 'skill.disable']) {
    const definition = SKILL_DEFINITIONS.find((one) => one.name === tool);
    assert.ok(definition, `${tool} is defined`);
    assert.deepEqual(definition.params.required, ['name']);
  }
  const tracked: unknown = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'config.json'), 'utf8'));
  assert.equal(grantedToPersona(tracked, SELF_ID, 'skill.read'), false);
  assert.equal(grantedToPersona(tracked, SELF_ID, 'skill.disable'), false);
});

test('skill.run runs the activated version only, with the credentials its script declares', async () => {
  // Bug: `skill.run` runs a newer edit, a script nobody declared, or hands a script every credential.
  const dataDir = tempDir('nep-skill-tool-');
  const skillDir = path.join(dataDir, 'skills', 'echoer');
  const hash = 'h1';
  const snapshot = path.join(skillDir, '.versions', hash);
  fs.mkdirSync(path.join(snapshot, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(snapshot, 'setup.json'),
    JSON.stringify({
      settings: [],
      scripts: {
        'say.cjs': { args: { q: { type: 'string', required: true } }, credentials: ['token'] },
        'bare.cjs': { args: {} },
      },
    })
  );
  const echo = `console.log(JSON.stringify({ok:true,text:String(process.env.SKILL_TOKEN)+'/'+String(process.env.SKILL_OTHER)}))`;
  fs.writeFileSync(path.join(snapshot, 'scripts', 'say.cjs'), echo);
  fs.writeFileSync(path.join(snapshot, 'scripts', 'bare.cjs'), echo);
  fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'scripts', 'say.cjs'), `console.log(JSON.stringify({ok:true,text:'edited'}))`);
  fs.writeFileSync(path.join(skillDir, 'credentials.json'), JSON.stringify({ token: 'abc', other: 'nope' }));
  const skills = {
    show: () => ({
      row: { active: { versionId: 'v1', tools: ['skill.run'], contentHash: hash }, disabled: false },
      text: 'x',
    }),
  };
  const env = { ...envOf(skills as unknown as SkillsPort), dataDir };
  const run = async (args: Record<string, unknown>) => {
    const { result } = await withCapturedLogs(() =>
      runOpPrechecked('skill.run', args, {
        env,
        guildId: 'g1',
        channelId: 'c1',
        userId: null,
        roleIds: [],
        actor: 'persona',
      })
    );
    return result as Result;
  };
  const said = await run({ name: 'echoer', script: 'say.cjs', args: JSON.stringify({ q: 'hi' }) });
  assert.equal(said.status, 'ok');
  assert.equal(said.summary, 'abc/undefined');
  const bare = await run({ name: 'echoer', script: 'bare.cjs' });
  assert.equal(bare.summary, 'undefined/undefined');
  assert.equal((await run({ name: 'echoer', script: 'other.cjs' })).status, 'invalid');
  assert.equal((await run({ name: 'echoer', script: 'say.cjs', args: '[1]' })).status, 'invalid');
});
