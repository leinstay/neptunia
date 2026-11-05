// What a test run from the development checkout gets and what it leaves, by the lead's rulings on stage S, and the real
// line of `select`. Each run starts on an empty scratch, and a run has no way to the persona's folders through its
// environment. The `.env` of the checkout is tests/watcher-development-unit.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { localConfigPath } from '../src/config/files.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { runInspection } from '../src/watcher/inspection.ts';
import { emptyScratch, singleTestCommand, watcherScratch } from '../src/watcher/development.ts';
import { tempDir } from './fixtures/tmp.ts';
import { FACTS, devAnswer } from './fixtures/watcher-development-rig.ts';
import { inspectionDeps, inspectionRig, said } from './fixtures/watcher-inspection-rig.ts';

const FORM = { checkout: '/srv/dev checkout', scratch: '/scratch', file: 'tests/a.test.ts', node: '/usr/bin/node' };

test('an inspection in the mode starts on an empty scratch', async () => {
  // Bug: an earlier run's test left a file there, and this run's test reads it and proves a finding that is not real.
  const rig = inspectionRig();
  fs.mkdirSync(watcherScratch(rig.dir), { recursive: true });
  const left = path.join(watcherScratch(rig.dir), 'left-by-an-earlier-run');
  fs.writeFileSync(left, 'x');
  let there: boolean | null = null;
  await runInspection(
    inspectionDeps(rig, {
      development: {
        mode: { on: true, checkout: '/srv/dev', repository: 'example/engine', base: 'trunk' },
        topics: [],
        facts: () => Promise.resolve(FACTS),
      },
      runAgent: () => {
        there = fs.existsSync(left);
        return Promise.resolve(said(devAnswer()));
      },
    })
  );
  assert.equal(there, false);
});

test('emptying a scratch that is not there makes it', () => {
  // Bug: the first run of an install fails on a folder nobody has made yet.
  const dir = tempDir('nep-watcher-dev-rails-');
  emptyScratch(dir);
  assert.deepEqual(fs.readdirSync(watcherScratch(dir)), []);
});

test("a test run's child has no persona folder in its environment and has the scratch for its TMPDIR", () => {
  // Bug: the worker's `NEPTUNIA_DATA_DIR` reaches a test, and it opens the live memory database instead of a fixture.
  const checkout = tempDir('nep-watcher-dev-rails-env-');
  const scratch = tempDir('nep-watcher-dev-rails-scratch-');
  fs.mkdirSync(path.join(checkout, 'tests', 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'tests', 'fixtures', 'refuse-manager.ts'), 'export function globalSetup() {}\n');
  const said = path.join(scratch, 'env.json');
  fs.writeFileSync(
    path.join(checkout, 'tests', 'env.test.ts'),
    `import { test } from 'node:test';
import fs from 'node:fs';
test('says', () => { fs.writeFileSync(${JSON.stringify(said)}, JSON.stringify({
  privateDir: process.env.NEPTUNIA_PRIVATE_DIR ?? null,
  dataDir: process.env.NEPTUNIA_DATA_DIR ?? null,
  tmp: process.env.TMPDIR ?? null,
})); });
`
  );
  const command = singleTestCommand({ checkout, scratch, file: 'tests/env.test.ts', node: process.execPath });
  assert.ok(command.ok);
  const base: NodeJS.ProcessEnv = { ...process.env, NEPTUNIA_PRIVATE_DIR: '/data', NEPTUNIA_DATA_DIR: '/data' };
  delete base.NODE_TEST_CONTEXT;
  const done = spawnSync(command.argv[0] ?? '', command.argv.slice(1), {
    cwd: command.cwd,
    env: { ...base, ...command.env },
    encoding: 'utf8',
  });
  assert.equal(done.status, 0, `${done.stdout}${done.stderr}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(said, 'utf8')), { privateDir: null, dataDir: null, tmp: scratch });
});

test('the line of a test run takes the persona folders out of the environment too', () => {
  // Bug: the agent pastes the line into a shell that holds the worker's environment, and only `argv` was safe.
  const command = singleTestCommand(FORM);
  assert.ok(command.ok);
  const shell = spawnSync(
    'sh',
    [
      '-c',
      command.line
        .replace(/^cd .*? && /, '')
        .replace(/\S+ --test .*$/, 'sh -c \'echo "$NEPTUNIA_DATA_DIR|$NEPTUNIA_PRIVATE_DIR|$TMPDIR"\''),
    ],
    {
      env: { PATH: process.env.PATH ?? '', NEPTUNIA_DATA_DIR: '/data', NEPTUNIA_PRIVATE_DIR: '/data' },
      encoding: 'utf8',
    }
  );
  assert.equal(shell.stdout.trim(), '||/scratch');
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
        NEPTUNIA_PRIVATE_DIR: data,
        NEPTUNIA_DATA_DIR: data,
      },
    }
  );
  assert.equal(done.status, 0, String(done.stderr).slice(0, 300));
  assert.deepEqual((JSON.parse(done.stdout) as { rows: Array<unknown> }).rows, [{ body: 'one' }]);
});
