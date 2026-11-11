// Her skill tools (src/tools/operations/skill.ts): `skill.read` answers the whole stored text of an active skill, and
// `skill.disable` is her own switch, which the owner undoes with `/skills enable`. Neither is granted to her in the
// tracked config: the owner opens them with `/tools grant`. The operations' environment gets the skills port from the
// core (`createOpsEnv({ skills })`); a core with none answers failed. A real port over a memory database and real
// temporary folders (tests/fixtures/skills-rig.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// The owner's decision of 2026-11-10 removed the caller check, so runOp is the one runner.
import { runOp } from '../src/tools/operations/index.ts';
import { createOpsEnv } from '../src/tools/operations/env.ts';

import { createDiscordInterface } from '../interfaces/discord/index.ts';
import { packageHash } from '../src/skills/package.ts';
import type { SkillsPort } from '../src/skills/port.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { skillText, skillsRig } from './fixtures/skills-rig.ts';
import { tempDir } from './fixtures/tmp.ts';
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
    isServedRoot: (id: unknown) => id === 'g1',
    board: null,
    skills,
  });
}

/** Her own call on an inner turn: nobody asks, the actor is the persona. */
async function callOf(skills: SkillsPort | null, name: string, args: Record<string, unknown>): Promise<Result> {
  const env = envOf(skills);
  const { result } = await withCapturedLogs(() =>
    runOp(name, args, {
      env,
      placeId: 'g1',
      chatId: 'c1',
      accountId: null,
      roleIds: [],
      actor: 'persona',
    })
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

test('skill.run runs the activated version only, with the credentials its script declares', async () => {
  // Bug: `skill.run` runs a newer edit, a script nobody declared, or hands a script every credential.
  const dataDir = tempDir('nep-skill-tool-');
  const skillDir = path.join(dataDir, 'skills', 'echoer');
  // Stage AJ: `skill.run` hashes the snapshot again, so the fixture carries the real package hash, not a made-up one.
  const snapshotText = skillText('echoer', 'I repeat what I am told', ['skill.run']);
  const snapshot = path.join(skillDir, '.versions', 'building');
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
  fs.writeFileSync(path.join(snapshot, 'SKILL.md'), snapshotText);
  const hash = packageHash(snapshot, snapshotText, createHash('sha256').update(snapshotText).digest('hex'));
  fs.renameSync(snapshot, path.join(skillDir, '.versions', hash));
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
      runOp('skill.run', args, {
        env,
        placeId: 'g1',
        chatId: 'c1',
        accountId: null,
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
