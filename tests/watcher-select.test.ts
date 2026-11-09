// `neptunia services watcher select` (src/watcher/select.ts, `watcherSelect` of src/service/watcher.ts): the watcher's read
// of the live memory database, one read-only statement over one read-only connection with no copy. A write is refused, a
// key is masked, a large answer is cut at the evidence bound, and a missing database makes no file.
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
import { PLANTED_KEY } from './fixtures/watcher-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));

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

test('the real command line answers a select with spaces in its statement, with no core', () => {
  // Bug: the handler exists and the table does not hold it, or the shell's one argument is cut at its first space, and the
  // agent's read answers usage.
  const data = tempDir('nep-watcher-dev-rails-select-');
  fs.mkdirSync(path.dirname(localConfigPath(data)), { recursive: true });
  fs.writeFileSync(localConfigPath(data), '{}');
  const handle = openMemoryDb(path.join(data, 'memory.db'));
  dbOf(handle).exec("CREATE TABLE spec_rows (body TEXT); INSERT INTO spec_rows VALUES ('one')");
  handle.close();
  const done = spawnSync(
    process.execPath,
    [
      path.join(import.meta.dirname, '..', 'bin', 'neptunia.ts'),
      'services',
      'watcher',
      'select',
      '--sql',
      'SELECT body FROM spec_rows',
    ],
    {
      cwd: path.join(import.meta.dirname, '..'),
      encoding: 'utf8',
      timeout: 6_000,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: tempDir('nep-watcher-dev-rails-home-'),
        TMPDIR: process.env.TMPDIR,
        NEPTUNIA_DATA_DIR: data,
      },
    }
  );
  assert.equal(done.status, 0, String(done.stderr).slice(0, 300));
  assert.deepEqual((JSON.parse(done.stdout) as { rows: Array<unknown> }).rows, [{ body: 'one' }]);
});
