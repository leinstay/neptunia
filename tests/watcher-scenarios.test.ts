// The four situations the watcher is asked to catch, read through its public boundary on synthetic files and rows: a check it
// cannot run, a skill whose executed bytes are not the validated ones, a memory that applied nothing for longer than its window,
// and eligible work that no session picked up. The agent's judgment is not tested here, only that its read paths (`services
// watcher select`, `services watcher evidence`, `installFacts`) hand it the fact and never a zero or an empty list in the
// place of a gap. Synthetic data only: no provider, no manager, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.ts';
import { localConfigPath } from '../src/config/files.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { serviceFamily } from '../src/service/commands.ts';
import type { ServiceAnswer } from '../src/service/commands.ts';
import { packageHash, snapshotDir } from '../src/skills/package.ts';
import { installFacts } from '../src/watcher/install.ts';
import { skillText, skillsRig } from './fixtures/skills-rig.ts';
import { tempDir } from './fixtures/tmp.ts';
import { answerOf, inspectionDeps, inspectionRig, said } from './fixtures/watcher-inspection-rig.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.parse('2026-11-04T10:00:00Z');
const HOUR = 3_600_000;
const iso = (at: number): string => new Date(at).toISOString();

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

type Rows = { rows: Array<Record<string, unknown>>; truncated: boolean };
async function select(data: string, sql: string): Promise<Rows> {
  const answer = await family(data, 'select', { sql });
  assert.equal(answer.status, 'ok', answer.text.slice(0, 300));
  return JSON.parse(answer.text) as Rows;
}

/** A memory database file at `data` with `fill` run over it before it closes. */
function memoryAt(
  data: string,
  fill: (exec: (sql: string, ...params: Array<string | number | null>) => void) => void
): void {
  const handle = openMemoryDb(path.join(data, 'memory.db'));
  try {
    const db = dbOf(handle);
    fill((sql, ...params) => void db.prepare(sql).run(...params));
  } finally {
    handle.close();
  }
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

// ---- idle memory -------------------------------------------------------------------------------------------------------

const SESSION =
  'INSERT INTO session_runs (id, scope_key, mode, started_at, finished_at, outcome, applied) VALUES (?, ?, ?, ?, ?, ?, ?)';

test('the newest applied session is found older than the window, whatever a shadow run did since', async () => {
  // Bug: a shadow run counts as progress, so a memory that applied nothing for days reads as alive.
  const data = folder();
  memoryAt(data, (exec) => {
    exec(SESSION, 'applied-old', 'g1', 'apply', iso(NOW - 80 * HOUR), iso(NOW - 80 * HOUR), 'ok', 1);
    exec(SESSION, 'shadow-new', 'g1', 'shadow', iso(NOW - 2 * HOUR), iso(NOW - 2 * HOUR), 'ok', 0);
  });
  const { rows } = await select(data, 'SELECT MAX(finished_at) AS last FROM session_runs WHERE applied = 1');
  assert.equal(rows[0]?.last, iso(NOW - 80 * HOUR));
});

test('a window with an applied session has it, and a window without one has none and is not an error', async () => {
  // Bug: an empty window answers a failure or a zero row, and "idle" cannot be told from "unreadable".
  const data = folder();
  memoryAt(data, (exec) => {
    exec(SESSION, 'applied-old', 'g1', 'apply', iso(NOW - 80 * HOUR), iso(NOW - 80 * HOUR), 'ok', 1);
  });
  const from = iso(NOW - 24 * HOUR);
  const { rows } = await select(data, `SELECT id FROM session_runs WHERE applied = 1 AND finished_at >= '${from}'`);
  assert.deepEqual(rows, []);
});

// ---- stalled eligible work ---------------------------------------------------------------------------------------------

const LINE =
  'INSERT INTO sources (id, kind, iface, place_id, occurred_at, recorded_at, seen_at, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';

test('lines recorded in the window and no session in it are both readable, so eligible work with no session shows', async () => {
  // Bug: only the sessions are read, so a window with plenty of eligible lines and no session looks the same as a quiet one.
  const data = folder();
  memoryAt(data, (exec) => {
    for (let n = 0; n < 3; n += 1) {
      const at = iso(NOW - (n + 1) * HOUR);
      exec(LINE, `line-${n}`, 'message', 'fake', 'c1', at, at, at, `a line ${n}`);
    }
    exec(SESSION, 'applied-old', 'g1', 'apply', iso(NOW - 80 * HOUR), iso(NOW - 80 * HOUR), 'ok', 1);
  });
  const from = iso(NOW - 24 * HOUR);
  const lines = await select(data, `SELECT COUNT(*) AS n FROM sources WHERE recorded_at >= '${from}'`);
  const sessions = await select(data, `SELECT COUNT(*) AS n FROM session_runs WHERE started_at >= '${from}'`);
  assert.equal(lines.rows[0]?.n, 3);
  assert.equal(sessions.rows[0]?.n, 0);
});

test('a window with lines and a session that failed shows the session and its outcome, not silence', async () => {
  // Bug: only applied sessions are read, so a session that ran and failed reads as work no session ever tried.
  const data = folder();
  memoryAt(data, (exec) => {
    const at = iso(NOW - HOUR);
    exec(LINE, 'line-1', 'message', 'fake', 'c1', at, at, at, 'a line');
    exec(SESSION, 'failed-new', 'g1', 'apply', at, at, 'provider-error', 0);
  });
  const { rows } = await select(data, 'SELECT id, outcome, applied FROM session_runs');
  assert.deepEqual(rows, [{ id: 'failed-new', outcome: 'provider-error', applied: 0 }]);
});
