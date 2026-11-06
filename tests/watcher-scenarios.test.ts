// Two of the situations the watcher is asked to catch, read through its public boundary on synthetic files and rows: a check it
// cannot run, and a skill whose executed bytes are not the validated ones. Idle memory and stalled eligible work are the
// watcher agent's findings from the evidence page, covered by the evidence tests. The agent's judgment is not tested here,
// only that its read paths (`services watcher select`, `services watcher evidence`, `installFacts`) hand it the fact and
// never a zero or an empty list in the place of a gap. Synthetic data only: no provider, no manager, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.ts';
import { localConfigPath } from '../src/config/files.ts';
import { serviceFamily } from '../src/service/commands.ts';
import type { ServiceAnswer } from '../src/service/commands.ts';
import { packageHash, snapshotDir } from '../src/skills/package.ts';
import { installFacts } from '../src/watcher/install.ts';
import { skillText, skillsRig } from './fixtures/skills-rig.ts';
import { tempDir } from './fixtures/tmp.ts';
import { answerOf, inspectionDeps, inspectionRig, said } from './fixtures/watcher-inspection-rig.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.parse('2026-11-04T10:00:00Z');

/** A persona folder with an empty local config, the way the family expects one. */
function folder(): string {
  const data = tempDir('nep-watcher-scenario-');
  fs.mkdirSync(path.dirname(localConfigPath(data)), { recursive: true });
  fs.writeFileSync(localConfigPath(data), '{}');
  return data;
}

/** One action of the `services watcher` family over `data`, every command the family runs answering "denied". */
function family(data: string, action: string, args: Record<string, unknown> = {}): Promise<ServiceAnswer> {
  return serviceFamily(
    {
      rootDir: REPO,
      privateDir: data,
      dataDir: data,
      config: () => readConfig(REPO, { privateDir: data }),
      now: () => NOW,
      env: { NEPTUNIA_PRIVATE_DIR: data, NEPTUNIA_UNIT_SCOPE: 'user', XDG_CONFIG_HOME: data },
      coreUp: false,
      run: () => Promise.resolve({ code: 1, stdout: '', stderr: 'permission denied' }),
    },
    `services.watcher.${action}`,
    args
  );
}

// ---- missing access ----------------------------------------------------------------------------------------------------

test('a select with no memory database is a refusal that names it, and makes no file', async () => {
  // Bug: the read opens a fresh empty database, so every later count reads as zero instead of "could not look".
  const data = folder();
  const answer = await family(data, 'select', { sql: 'SELECT 1 AS n' });
  assert.equal(answer.status, 'failed');
  assert.match(answer.text, /no memory database/);
  assert.equal(fs.existsSync(path.join(data, 'memory.db')), false);
});

test('the first page of evidence gives a null, not a zero count, for what the memory database could not answer', async () => {
  // Bug: `audit` and `standards` default to empty counts, and the agent reports a clean memory it never read.
  const data = folder();
  const answer = await family(data, 'evidence');
  assert.equal(answer.status, 'ok', answer.text.slice(0, 300));
  const page = JSON.parse(answer.text) as Record<string, unknown>;
  assert.equal(page.audit, null);
  assert.equal(page.standards, null);
});

test('skills that cannot be read are unavailable by code when the database is garbage, not an empty list', () => {
  // Bug: a corrupt registry reads as "no active skills", which clears a check nobody made.
  const rootDir = tempDir('nep-scenario-install-');
  fs.writeFileSync(path.join(rootDir, 'package.json'), '{}');
  const dataDir = tempDir('nep-scenario-install-data-');
  fs.writeFileSync(path.join(dataDir, 'memory.db'), 'this is not a database');
  const facts = installFacts({ rootDir, dataDir, git: () => assert.fail('no .git, no git') });
  assert.equal(facts.activeSkills, null);
  assert.ok(facts.unavailable.includes('skills-unreadable'));
});

test('an unavailable code in the install facts is in the brief and survives into the saved report', async () => {
  // Bug: the code is dropped between the brief and the report, so the owner reads a clean `Unavailable checks`.
  const { runInspection } = await import('../src/watcher/inspection.ts');
  const { readReport } = await import('../src/watcher/read.ts');
  const rig = inspectionRig();
  const briefs: Array<string> = [];
  const result = await runInspection(
    inspectionDeps(rig, {
      install: () => ({
        revision: null,
        divergence: null,
        modules: [],
        dependencies: {},
        activeSkills: null,
        unavailable: ['skills-unreadable'],
      }),
      runAgent: (brief) => {
        briefs.push(brief);
        return Promise.resolve(said(answerOf({}, [])));
      },
    })
  );
  assert.ok(briefs[0]?.includes('skills-unreadable'));
  const read = readReport(rig.reportsDir, result.day);
  assert.ok(read.ok);
  assert.match(read.report.text, /skills-unreadable|unavailable/i);
});

// ---- a suspicious skill change -----------------------------------------------------------------------------------------

const SETUP = JSON.stringify({ scripts: { 'say.mjs': { args: {} } } });

/** A skill with one script, activated, with its snapshot on disk: the validated bytes are the script below. */
function activeSkill(t: { after: (fn: () => void) => void }) {
  const rig = skillsRig(t, { granted: ['skill.run', 'web.read'], registered: ['skill.run', 'web.read'] });
  rig.writeLocal('say-it', skillText('say-it', 'd', ['skill.run'], 'The steps.'));
  const root = path.join(rig.folders.localDir, 'say-it');
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'setup.json'), SETUP);
  fs.writeFileSync(path.join(root, 'scripts', 'say.mjs'), 'console.log("validated");\n');
  assert.ok(rig.port.activate('say-it', 'owner').ok);
  const active = rig.port.list().find((row) => row.name === 'say-it')?.active ?? assert.fail('not active');
  return { rig, root, hash: active.contentHash };
}

test('a script edited after activation changes the folder hash and leaves the executed snapshot as validated', (t) => {
  // Bug: the run reads the live folder, so an edit that was never validated is what executes.
  const { root, hash, rig } = activeSkill(t);
  fs.writeFileSync(path.join(root, 'scripts', 'say.mjs'), 'console.log("edited");\n');
  assert.notEqual(rig.port.diskHash('say-it'), hash, 'the folder now differs from the validated version');
  const executed = fs.readFileSync(path.join(snapshotDir(root, hash), 'scripts', 'say.mjs'), 'utf8');
  assert.equal(executed, 'console.log("validated");\n');
});

test('the snapshot of an untouched active version hashes to the validated hash', (t) => {
  // Bug: the check that compares executed bytes with validated bytes always disagrees, and every skill reads as suspicious.
  const { root, hash } = activeSkill(t);
  const snapshot = snapshotDir(root, hash);
  const text = fs.readFileSync(path.join(snapshot, 'SKILL.md'), 'utf8');
  assert.equal(packageHash(snapshot, text, 'unused'), hash);
});

test('a snapshot whose script was rewritten no longer hashes to the validated hash', (t) => {
  // Bug: the executed copy can be changed in place and nothing tells, since the registry holds only the validated hash.
  const { root, hash } = activeSkill(t);
  const snapshot = snapshotDir(root, hash);
  fs.chmodSync(path.join(snapshot, 'scripts', 'say.mjs'), 0o600);
  fs.writeFileSync(path.join(snapshot, 'scripts', 'say.mjs'), 'console.log("swapped");\n');
  const text = fs.readFileSync(path.join(snapshot, 'SKILL.md'), 'utf8');
  assert.notEqual(packageHash(snapshot, text, 'unused'), hash);
});

test('the active version the watcher lists is the validated one, by name and version id', (t) => {
  // Bug: the install facts list the newest folder hash, so an unvalidated edit reads as the active skill.
  const { root, rig } = activeSkill(t);
  const validated = rig.port.list().find((row) => row.name === 'say-it')?.active?.versionId;
  fs.writeFileSync(path.join(root, 'scripts', 'say.mjs'), 'console.log("edited");\n');
  rig.port.sync();
  const still = rig.port.list().find((row) => row.name === 'say-it')?.active?.versionId;
  assert.equal(still, validated);
});
