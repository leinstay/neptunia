// `skill.run` runs only the bytes that were validated (src/tools/operations/skill.ts, src/skills/package.ts). The activated
// version of a skill names the content hash of its package; the snapshot under `.versions/<hash>/` must still hash to
// it when the script is about to run. A snapshot whose bytes changed after the activation is refused before anything
// executes with `skill-tampered`, and a snapshot with its folder or the called script gone with `skill-missing`. Both
// codes are worded in the shipped labels like every skill failure code, and the log line names the skill and the
// version and carries no file content. A real port over a memory database and real temporary folders; the scripts
// leave a marker file when they run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { loadSkills } from '../src/skills/load.ts';
import { createSkillsPort } from '../src/skills/port.ts';
import type { SkillsPort } from '../src/skills/port.ts';
import { snapshotDir } from '../src/skills/package.ts';
import { runOpPrechecked } from '../src/tools/operations/index.ts';
import { createOpsEnv } from '../src/tools/operations/env.ts';
import { createDiscordInterface } from '../interfaces/discord/index.ts';
import { CATALOGUE, isCode } from '../src/tools/codes.ts';
import { joinLabels } from '../src/config/labels.ts';
import type { LabelsFile } from '../src/config/labels.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import type { LogEntry } from './fixtures/capture-logs.ts';
import { skillText } from './fixtures/skills-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'echoer';
const SECRET = 'TAMPERED-BODY-7731';

type Result = { status: string; code?: string | null; summary?: string; data?: unknown };

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
    reviewDays: () => 30,
  });
  assert.equal(port.activate(NAME, 'owner').ok, true);
  const active = port.list()[0]?.active;
  assert.ok(active, 'the version is active');
  const snapshot = snapshotDir(skillDir, active.contentHash);
  assert.ok(fs.existsSync(path.join(snapshot, 'scripts', 'say.cjs')), 'the snapshot holds the script');
  return { dataDir, skillDir, snapshot, port, active };
}

async function runOf(port: SkillsPort, dataDir: string): Promise<{ result: Result; logs: Array<LogEntry> }> {
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
    runOpPrechecked(
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

test('both refusal codes are catalogued as skill failures and worded in the shipped labels', () => {
  // Bug: a code outside the catalogue throws at its first use, and one without a label reaches her as `other`.
  const labels = joinLabels(
    JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'labels.json'), 'utf8')) as LabelsFile
  );
  const reasons = (labels as unknown as { tools: { result: { reasons: Record<string, unknown> } } }).tools.result
    .reasons;
  for (const code of ['skill-tampered', 'skill-missing']) {
    assert.equal(isCode(code), true, `${code} is in the catalogue`);
    const entry = (CATALOGUE as Record<string, { status: string; group: string }>)[code];
    assert.equal(entry?.group, 'skill');
    assert.equal(entry?.status, 'failed');
    // The lead: a label is a string; the lint refuses stringifying an unknown value and a bare type check.
    assert.match(reasons[code] as string, /\S/, `${code} has a label`);
  }
});
