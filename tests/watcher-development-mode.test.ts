// When the watcher's development mode is on, and the forms its agent runs. The mode comes from the settings alone: with
// `selfimprovement.enabled` not false, an absolute `selfimprovement.checkout` that is not the running install, an
// `owner/name` `selfimprovement.repository` and a backend for the agent `dev`, the watcher checks code in that folder.
// Anything less is off and it touches no code. A test run has one command form, which carries the refusing setup, and a
// finding's command that runs tests in another form reproduces nothing. The live database is read through
// `services watcher select`, one read-only connection with no copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.ts';
import { localConfigPath } from '../src/config/files.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { serviceFamily } from '../src/service/commands.ts';
import type { ServiceAnswer } from '../src/service/commands.ts';
import { WATCHER_EVIDENCE_MAX_CHARS } from '../src/watcher/requests.ts';
import { REFUSING_FLAG } from './fixtures/watcher-development-rig.ts';
import { PLANTED_KEY } from './fixtures/watcher-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const development = () => import('../src/watcher/development.ts');

const REPO = fileURLToPath(new URL('..', import.meta.url));
const ROOT = '/srv/install';
const FOLDER = '/srv/dev-checkout';
const SETTINGS = { checkout: FOLDER, repository: 'example/engine', base: 'trunk' };

const modeOf = async (selfimprovement: Record<string, unknown>, devAgent: string | null = 'claude') =>
  (await development()).developmentMode({ config: { selfimprovement }, rootDir: ROOT, devAgent });

test('the mode is on with a checkout, a repository and a development agent, and names what they are', async () => {
  // Bug: the code checks run from defaults, on `main` of the wrong folder, because the mode only says yes or no.
  // `selfimprovement.enabled` is unset here: everything else reads an unset switch as on.
  assert.deepEqual(await modeOf(SETTINGS), { on: true, checkout: FOLDER, repository: 'example/engine', base: 'trunk' });
});

const OFF: ReadonlyArray<{ name: string; settings: Record<string, unknown>; agent?: null; why: string }> = [
  { name: 'development is disabled', settings: { ...SETTINGS, enabled: false }, why: 'disabled' },
  { name: 'no checkout is named', settings: { repository: 'example/engine' }, why: 'no-checkout' },
  { name: 'the checkout is a relative path', settings: { ...SETTINGS, checkout: 'dev' }, why: 'no-checkout' },
  { name: 'no repository is named', settings: { checkout: FOLDER }, why: 'no-repository' },
  { name: 'the repository is no owner/name', settings: { ...SETTINGS, repository: 'engine' }, why: 'no-repository' },
  { name: 'the dev agent has no backend', settings: SETTINGS, agent: null, why: 'no-agent' },
  { name: 'the checkout is the running install', settings: { ...SETTINGS, checkout: ROOT }, why: 'live-checkout' },
  {
    name: 'the checkout is the install with a slash',
    settings: { ...SETTINGS, checkout: `${ROOT}/` },
    why: 'live-checkout',
  },
];

for (const { name, settings, agent, why } of OFF) {
  test(`the mode is off with the reason ${why} when ${name}`, async () => {
    // Bug: half a configuration turns the code checks on, against nothing or against the code that is running.
    assert.deepEqual(await modeOf(settings, agent === null ? null : 'claude'), { on: false, why });
  });
}

test('the audit topics come from `watcher.auditTopics`, and only its usable words count', async () => {
  // Bug: a typo in the local settings fails every inspection, when an audit is only one part of the run.
  const { auditTopicsOf } = await development();
  assert.deepEqual(auditTopicsOf({ watcher: { auditTopics: ['dead-code', '', 7, 'media-parity'] } }), [
    'dead-code',
    'media-parity',
  ]);
  assert.deepEqual(auditTopicsOf({ watcher: { auditTopics: 'dead-code' } }), []);
  assert.deepEqual(auditTopicsOf({}), []);
});

// ---------- one test file, in one form ----------

const form = async (file: string, checkout: string = FOLDER) =>
  (await development()).singleTestCommand({ checkout, scratch: '/scratch', file, node: '/usr/bin/node' });

test('a test run carries the refusing setup ahead of its one file, in the checkout, with its files in the scratch', async () => {
  // Bug: a dev folder's test reaches the real `systemctl` and moves the units of the server it runs on.
  const command = await form('tests/watcher-read.test.ts');
  assert.ok(command.ok);
  assert.equal(command.argv[0], '/usr/bin/node');
  assert.ok(command.argv.includes('--test'));
  const flag = command.argv.indexOf(REFUSING_FLAG);
  assert.ok(flag !== -1, command.argv.join(' '));
  assert.equal(command.argv.at(-1), 'tests/watcher-read.test.ts');
  assert.ok(flag < command.argv.length - 1);
  assert.equal(command.cwd, FOLDER);
  assert.equal(command.env.TMPDIR, '/scratch');
  assert.ok(command.line.includes(REFUSING_FLAG));
});

test('the line of a test run survives a shell from a folder with a space in its name', async () => {
  // Bug: the line cuts the path at the space, and the finding's command reproduces a `cd` error.
  const command = await form('tests/a.test.ts', '/srv/dev checkout');
  assert.ok(command.ok);
  assert.ok(command.line.includes("'/srv/dev checkout'"), command.line);
});

for (const file of [
  '',
  'tests',
  'tests/',
  'tests/*.test.ts',
  '../outside.test.ts',
  'tests/../../outside.test.ts',
  '/etc/outside.test.ts',
  'src/index.ts',
  'tests/a.test.ts; rm -rf x',
  'tests/a.test.ts tests/b.test.ts',
]) {
  test(`a test run of "${file}" is refused, since it is no single test file inside the checkout`, async () => {
    // Bug: a glob becomes the whole suite on the server, a climbing path runs code from outside, and `src/index.ts`
    // starts a second instance of the persona.
    assert.deepEqual(await form(file), { ok: false, code: 'not-a-test-file' });
  });
}

test('the form stops a test that reaches the service manager, in a real child', async () => {
  // Bug: the flag is spelled right and does nothing, because the setup is not found from the folder the run works in.
  const checkout = tempDir('nep-watcher-form-');
  fs.mkdirSync(path.join(checkout, 'tests', 'fixtures'), { recursive: true });
  fs.copyFileSync(
    path.join(REPO, 'tests', 'fixtures', 'refuse-manager.ts'),
    path.join(checkout, 'tests', 'fixtures', 'refuse-manager.ts')
  );
  fs.writeFileSync(
    path.join(checkout, 'tests', 'reach.test.ts'),
    `import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
test('reaches', () => { spawnSync('systemctl', ['status']); });
`
  );
  const command = (await development()).singleTestCommand({
    checkout,
    scratch: tempDir('nep-watcher-form-scratch-'),
    file: 'tests/reach.test.ts',
    node: process.execPath,
  });
  assert.ok(command.ok);
  const env: NodeJS.ProcessEnv = { ...process.env, ...command.env };
  delete env.NODE_TEST_CONTEXT;
  const done = spawnSync(command.argv[0] ?? '', command.argv.slice(1), { cwd: command.cwd, env, encoding: 'utf8' });
  assert.notEqual(done.status, 0);
  assert.match(`${done.stdout}${done.stderr}`, /service manager/);
});

// ---------- what counts as a reproducing command ----------

const READY = `/usr/bin/node --test ${REFUSING_FLAG} tests/a.test.ts`;

for (const [line, code] of [
  [undefined, 'missing'],
  ['', 'missing'],
  ['   ', 'missing'],
  [7, 'missing'],
  ['node --test tests/a.test.ts', 'test-without-refusal'],
  ['cd /srv/dev && /usr/bin/node --test tests/a.test.ts', 'test-without-refusal'],
  ['node --test --test-global-setup=tests/fixtures/other.ts tests/a.test.ts', 'test-without-refusal'],
  ['npm test', 'whole-suite'],
  ['npm run test', 'whole-suite'],
  [`node --test ${REFUSING_FLAG}`, 'whole-suite'],
] as ReadonlyArray<readonly [unknown, string]>) {
  test(`the command ${JSON.stringify(line)} reproduces nothing, with the code ${code}`, async () => {
    // Bug: a finding files on a command that cannot be run, or on one whose run moves the server's units.
    assert.deepEqual((await development()).reproducingCommand(line), { ok: false, code });
  });
}

for (const line of [
  READY,
  `cd /srv/dev && TMPDIR=/scratch ${READY}`,
  'rg -n "readOnly" src/memory/db/open.ts',
  `neptunia services watcher select --sql 'SELECT count(*) FROM board_tasks'`,
]) {
  test(`the command ${line} reproduces, and comes back trimmed`, async () => {
    // Bug: only test runs count, and a finding proven by a search or a SELECT never files.
    assert.deepEqual((await development()).reproducingCommand(`  ${line}\n`), { ok: true, command: line });
  });
}

test('the line of the form is itself a reproducing command', async () => {
  // Bug: the form and the check drift apart, and every finding that uses the form becomes a hypothesis.
  const command = await form('tests/a.test.ts');
  assert.ok(command.ok);
  assert.equal((await development()).reproducingCommand(command.line).ok, true);
});

// ---------- the live database, read-only ----------

/** A persona folder with a memory database holding one small table of `rows`. */
function database(rows: ReadonlyArray<string>) {
  const data = tempDir('nep-watcher-select-');
  fs.mkdirSync(path.dirname(localConfigPath(data)), { recursive: true });
  fs.writeFileSync(localConfigPath(data), '{}');
  const file = path.join(data, 'memory.db');
  const handle = openMemoryDb(file);
  dbOf(handle).exec('CREATE TABLE spec_rows (body TEXT)');
  for (const body of rows) dbOf(handle).prepare('INSERT INTO spec_rows (body) VALUES (?)').run(body);
  handle.close();
  return { data, file };
}

const select = (data: string, sql: unknown): Promise<ServiceAnswer> =>
  serviceFamily(
    {
      rootDir: REPO,
      privateDir: data,
      dataDir: data,
      config: () => readConfig(REPO, { privateDir: data }),
      now: () => Date.parse('2026-11-05T10:00:00Z'),
      env: { NEPTUNIA_UNIT_SCOPE: 'user' },
      coreUp: false,
      run: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }),
    },
    'service.watcher.select',
    { sql }
  );

const countOf = (file: string): number => {
  const handle = openMemoryDb(file, { readOnly: true });
  try {
    return Number(dbOf(handle).prepare('SELECT count(*) AS n FROM spec_rows').get()?.n);
  } finally {
    handle.close();
  }
};

test('a SELECT answers the rows of the live database as JSON', async () => {
  // Bug: the agent gets no way to read the database, as the host has no sqlite3, and a finding stays a guess.
  const { data } = database(['one', 'two']);
  const answer = await select(data, 'SELECT body FROM spec_rows ORDER BY body');
  assert.equal(answer.status, 'ok');
  const parsed = JSON.parse(answer.text) as { rows: Array<{ body: string }>; truncated: boolean };
  assert.deepEqual(
    parsed.rows.map((row) => row.body),
    ['one', 'two']
  );
  assert.equal(parsed.truncated, false);
});

for (const sql of [
  "INSERT INTO spec_rows (body) VALUES ('new')",
  'DELETE FROM spec_rows',
  'DROP TABLE spec_rows',
  'SELECT 1; DELETE FROM spec_rows',
]) {
  test(`the statement "${sql}" is refused and the database keeps its rows`, async () => {
    // Bug: an inspection changes her memory, which has one writer, or a statement after a SELECT slips through.
    const { data, file } = database(['one', 'two']);
    const answer = await select(data, sql);
    assert.equal(answer.status, 'failed');
    assert.equal(countOf(file), 2);
  });
}

test('a string shaped like a key is masked in the rows', async () => {
  // Bug: a stored request holds a key, the agent reads it and it reaches a report or a refused answer.
  const { data } = database([`before ${PLANTED_KEY} after`]);
  const answer = await select(data, 'SELECT body FROM spec_rows');
  assert.equal(answer.status, 'ok');
  assert.equal(answer.text.includes(PLANTED_KEY), false);
  assert.match(answer.text, /before .* after/);
});

test('a large answer stops at the evidence bound, parses and says it was cut', async () => {
  // Bug: `SELECT * FROM model_requests` fills the agent's context, and the run dies with no report.
  const { data } = database(Array.from({ length: 100 }, () => 'x'.repeat(2_000)));
  const answer = await select(data, 'SELECT body FROM spec_rows');
  assert.equal(answer.status, 'ok');
  assert.ok(answer.text.length <= WATCHER_EVIDENCE_MAX_CHARS, String(answer.text.length));
  const parsed = JSON.parse(answer.text) as { rows: Array<unknown>; truncated: boolean };
  assert.ok(parsed.rows.length > 0 && parsed.rows.length < 100, String(parsed.rows.length));
  assert.equal(parsed.truncated, true);
});

test('with no database the read fails and makes no file', async () => {
  // Bug: a read-write open makes an empty memory.db in the persona folder, which the core then takes for her memory.
  const data = tempDir('nep-watcher-select-none-');
  fs.mkdirSync(path.dirname(localConfigPath(data)), { recursive: true });
  fs.writeFileSync(localConfigPath(data), '{}');
  const answer = await select(data, 'SELECT 1');
  assert.equal(answer.status, 'failed');
  assert.equal(fs.existsSync(path.join(data, 'memory.db')), false);
});

test('a read with no statement is refused as invalid', async () => {
  // Bug: a missing flag reads as an empty answer, and the agent reports an empty table.
  const { data } = database([]);
  const answer = await select(data, undefined);
  assert.equal(answer.status, 'invalid');
  assert.match(answer.text, /--sql/);
});
