// The persona's skill tools (src/tools/operations/skill.ts): `skill.read` answers the whole stored text of an active skill, and
// `skill.disable` is the persona's own switch, which the owner undoes with `/skills enable`. Neither is granted to the
// persona in the tracked config: the owner opens them with `/tools grant`. The operations' environment gets the skills port from the
// core (`createOpsEnv({ skills })`); a core with none answers failed. A real port over a memory database and real
// temporary folders (tests/fixtures/skills-rig.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// runOp checks no caller, so it is the one runner.
import { runOp } from '../../../../src/tools/operations/index.ts';
import { createOpsEnv } from '../../../../src/tools/operations/env.ts';

import { createDiscordInterface } from '../../../../interfaces/discord/index.ts';
import { packageHash, snapshotDir } from '../../../../src/skills/package.ts';
import type { SkillsPort } from '../../../../src/skills/port.ts';
import { type LogEntry, withCapturedLogs } from '../../../fixtures/capture-logs.ts';
import { createSkillsPort, skillsRig, skillText } from '../../../fixtures/skills-rig.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { loadSkills } from '../../../../src/skills/load.ts';

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

/** The persona's own call on an inner turn: nobody asks, the actor is the persona. */
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

test("skill.disable takes the skill out of the persona's index and the owner enables it again", async (t) => {
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
  // `skill.run` hashes the snapshot again, so the fixture carries the real package hash, not a made-up one.
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

const NAME = 'echoer';

const SECRET = 'TAMPERED-BODY-7731';

type SkillsRunHashResult = { status: string; code?: string | null; summary?: string; data?: unknown };

const GOOD_SCRIPT = `require('node:fs').writeFileSync(require('node:path').join(process.env.SKILL_STATE_DIR, 'ran'), '1');
console.log(JSON.stringify({ ok: true, text: 'said ' + String(process.env.SKILL_TOKEN) }));`;

const EVIL_SCRIPT = `// ${SECRET}
require('node:fs').writeFileSync(require('node:path').join(process.env.SKILL_STATE_DIR, 'ran'), '1');
console.log(JSON.stringify({ ok: true, text: 'evil' }));`;

const SETUP = {
  settings: [],
  scripts: { 'say.cjs': { args: {}, credentials: ['token'] } },
};

/** A skill with one script, activated through a real port; the folder is `<dataDir>/skills/echoer`. */
function activated(t: { after: (fn: () => void) => void }) {
  const dataDir = tempDir('nep-skill-hash-');
  const localDir = path.join(dataDir, 'skills');
  const skillDir = path.join(localDir, NAME);
  fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillText(NAME, 'I repeat what I am told', ['skill.run']));
  fs.writeFileSync(path.join(skillDir, 'setup.json'), JSON.stringify(SETUP));
  fs.writeFileSync(path.join(skillDir, 'scripts', 'say.cjs'), GOOD_SCRIPT);
  fs.writeFileSync(path.join(skillDir, 'credentials.json'), JSON.stringify({ token: 'abc' }));
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  const names = new Set(['skill.run', 'skill.read']);
  const port = createSkillsPort({
    handle,
    now: () => Date.parse('2026-11-01T09:00:00Z'),
    load: () => loadSkills({ localDir }),
    granted: () => names,
    registered: () => names,
  });
  assert.equal(port.activate(NAME, 'owner').ok, true);
  const active = port.list()[0]?.active;
  assert.ok(active, 'the version is active');
  const snapshot = snapshotDir(skillDir, active.contentHash);
  assert.ok(fs.existsSync(path.join(snapshot, 'scripts', 'say.cjs')), 'the snapshot holds the script');
  return { dataDir, skillDir, snapshot, port, active };
}

async function runOf(
  port: SkillsPort,
  dataDir: string
): Promise<{ result: SkillsRunHashResult; logs: Array<LogEntry> }> {
  const env = {
    ...createOpsEnv({
      discord: createDiscordInterface().capabilities,
      hot: {
        config: { bot: { owners: ['42'], access: {} }, features: {} },
        prompts: { labels: {} },
        rootDir: tempDir('nep-skill-hash-root-'),
        reloadConfig: () => true,
      },
      store: { state: { data: {}, markDirty() {} } },
      client: { channels: { cache: new Map() } },
      spontaneous: {},
      calibrator: { ratio: 1 },
      isServedRoot: (id: unknown) => id === 'g1',
      board: null,
      skills: port,
    }),
    dataDir,
  };
  const { result, logs } = await withCapturedLogs(() =>
    runOp(
      'skill.run',
      { name: NAME, script: 'say.cjs' },
      { env, placeId: 'g1', chatId: 'c1', accountId: null, roleIds: [], actor: 'persona' }
    )
  );
  return { result: result, logs };
}

const ran = (skillDir: string): boolean => fs.existsSync(path.join(skillDir, 'state', 'ran'));

test('skill.run runs a snapshot that still hashes to the validated hash', async (t) => {
  // Bug: the integrity check refuses an intact snapshot.
  const { dataDir, skillDir, port } = activated(t);
  const { result } = await runOf(port, dataDir);
  assert.equal(result.status, 'ok');
  assert.equal(result.summary, 'said abc');
  assert.equal(ran(skillDir), true);
});

test('skill.run refuses a snapshot script edited after the activation, and nothing executes', async (t) => {
  // Bug: bytes that were never validated run with the skill's credentials.
  const { dataDir, skillDir, snapshot, port } = activated(t);
  fs.writeFileSync(path.join(snapshot, 'scripts', 'say.cjs'), EVIL_SCRIPT);
  const { result } = await runOf(port, dataDir);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'skill-tampered');
  assert.equal(ran(skillDir), false);
  assert.equal(String(result.summary ?? '').includes(SECRET), false);
});

test('skill.run refuses a snapshot whose setup.json was widened after the activation', async (t) => {
  // Bug: an edited manifest hands a validated script credentials its validated manifest never named.
  const { dataDir, skillDir, snapshot, port } = activated(t);
  const widened = { ...SETUP, scripts: { 'say.cjs': { args: {}, credentials: ['token', 'other'] } } };
  fs.writeFileSync(path.join(snapshot, 'setup.json'), JSON.stringify(widened));
  fs.writeFileSync(path.join(skillDir, 'credentials.json'), JSON.stringify({ token: 'abc', other: 'nope' }));
  const { result } = await runOf(port, dataDir);
  assert.equal(result.code, 'skill-tampered');
  assert.equal(ran(skillDir), false);
});

test('skill.run refuses a snapshot that gained a file after the activation', async (t) => {
  // Bug: a file added to the snapshot is part of the package nobody validated.
  const { dataDir, skillDir, snapshot, port } = activated(t);
  fs.writeFileSync(path.join(snapshot, 'scripts', 'extra.cjs'), EVIL_SCRIPT);
  const { result } = await runOf(port, dataDir);
  assert.equal(result.code, 'skill-tampered');
  assert.equal(ran(skillDir), false);
});

test('the refusal logs the skill name and version and no file content', async (t) => {
  // Bug: the refusal is silent in the journal, or the journal carries the bytes that were refused.
  const { dataDir, snapshot, port, active } = activated(t);
  fs.writeFileSync(path.join(snapshot, 'scripts', 'say.cjs'), EVIL_SCRIPT);
  const { logs } = await runOf(port, dataDir);
  const lines = logs.filter((entry) => entry.level === 'warn' || entry.level === 'error').map((e) => JSON.stringify(e));
  const line = lines.find(
    (one) => one.includes(NAME) && (one.includes(active.versionId) || one.includes(`"${active.version}"`))
  );
  assert.ok(line, 'a warn or error line names the skill and the version');
  for (const one of logs.map((e) => JSON.stringify(e))) {
    assert.equal(one.includes(SECRET), false, 'no log line holds file content');
    assert.equal(one.includes('console.log'), false, 'no log line holds file content');
  }
});

test('skill.run refuses a snapshot whose folder is gone with skill-missing', async (t) => {
  // Bug: a vanished snapshot reads as a script that was never declared and answers `invalid`.
  const { dataDir, skillDir, snapshot, port } = activated(t);
  fs.rmSync(snapshot, { recursive: true, force: true });
  const { result } = await runOf(port, dataDir);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'skill-missing');
  assert.equal(ran(skillDir), false);
});

test('skill.run refuses a snapshot whose called script file is gone with skill-missing', async (t) => {
  // Bug: a deleted script is told apart from an edited one by nobody, and the cause is lost.
  const { dataDir, skillDir, snapshot, port } = activated(t);
  fs.rmSync(path.join(snapshot, 'scripts', 'say.cjs'));
  const { result } = await runOf(port, dataDir);
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'skill-missing');
  assert.equal(ran(skillDir), false);
});
