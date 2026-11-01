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
import { createDiscordInterface } from '../interfaces/discord/index.js';
import type { SkillsPort } from '../src/skills/port.ts';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { skillText, skillsRig } from './fixtures/skills-rig.ts';
import { tempDir } from './fixtures/tmp.js';

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
