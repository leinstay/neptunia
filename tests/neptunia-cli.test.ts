// The `neptunia` command (bin/neptunia.ts) as the owner and the units run it: the chat with no argument, one command
// with `-p`, `doctor` with the core down, and `errand-runner`. The core runs in the test process with its interfaces as
// units (tests/fixtures/core-units.ts); each `neptunia` is a child process over the real socket, its stdin and stdout
// piped. The clients are the fake interface and the owner's `cli`, both written by tools/client-token.mjs. The chat is
// the `cli` interface: its one conversation is `cli:dm:owner`, of kind `dm`. A line starting with `/` is a command
// whose answer is printed for the owner and never reaches her memory or a request. The tests assert what is printed by
// the data they put in (an interface name, a key value), the exit codes and the memory rows, never a label's wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { lockPathOf, openMemoryDb } from '../src/memory/db/open.js';
import {
  ANSWER,
  CLI_CLIENT,
  addClient,
  folders,
  query,
  runCli,
  settle,
  spawnCli,
  startUnitsCore,
  until,
  withRig,
} from './fixtures/core-units.ts';
import type { Dirs } from './fixtures/core-units.ts';

const T0 = Date.parse('2026-10-31T12:00:00Z');

/** An interface the local layer names, so `/interface list` prints a name no label holds. */
const MARKED = { interfaces: { zeta71: { enabled: true } } };

const count = (text: string, part: string): number => text.split(part).length - 1;

/** The stdout lines that are log entries of src/log.js, which a script reading the answer must never get. */
const logLines = (stdout: string): Array<string> => stdout.split('\n').filter((line) => line.startsWith('{"level"'));

// Case 1 of PR D. A DM place has no native id (src/memory/db/ids.ts): its id is `<iface>:dm:<partner>`, and the
// chat's events name the partner `owner`.
test('a line typed in the chat reaches her, her reply is printed once, and the line is kept in the cli dm', async () => {
  await withRig({}, async ({ dirs, llm, clis, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const chat = spawnCli(dirs, []);
    clis.push(chat);
    chat.type('hello from the console');
    await until(
      () => chat.stdout().includes(ANSWER),
      () => `her reply in the chat; stderr:\n${chat.stderr().slice(-2000)}`
    );
    assert.equal(llm.requests.length, 1, 'one turn for the line');
    assert.ok(JSON.stringify(llm.requests[0]).includes('hello from the console'), 'the request carries the line');
    assert.deepEqual(
      query(
        dirs,
        `SELECT s.kind, s.scope_kind, s.scope_iface, p.id AS place
         FROM sources s JOIN places p ON p.id = s.place_id WHERE s.text = ?`,
        'hello from the console'
      ),
      [{ kind: 'seen', scope_kind: 'dm', scope_iface: 'cli', place: 'cli:dm:owner' }]
    );
    assert.deepEqual(
      query(
        dirs,
        `SELECT DISTINCT s.scope_kind FROM sources s JOIN places p ON p.id = s.place_id WHERE p.id = ?`,
        'cli:dm:owner'
      ).map((row) => row.scope_kind),
      ['dm'],
      'every line of the chat is dm-scoped'
    );
    await settle();
    assert.equal(count(chat.stdout(), ANSWER), 1, 'her reply is printed once');
    chat.end();
    assert.deepEqual(await chat.exited, { code: 0, signal: null }, 'the end of the input ends the chat');
  });
});

// Case 2 of PR D.
test("a command's answer is printed but never reaches her memory or her next request", async () => {
  await withRig({ config: MARKED }, async ({ dirs, llm, clis, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const chat = spawnCli(dirs, []);
    clis.push(chat);
    chat.type('/interface list');
    await until(
      () => chat.stdout().includes('zeta71'),
      () => `the command's answer; stderr:\n${chat.stderr().slice(-2000)}`
    );
    assert.equal(llm.requests.length, 0, 'a command runs no turn');
    chat.type('what is new');
    await until(() => chat.stdout().includes(ANSWER), 'her reply to the line after the command');
    assert.equal(llm.requests.length, 1);
    const request = JSON.stringify(llm.requests[0]);
    assert.ok(request.includes('what is new'));
    assert.equal(request.includes('zeta71'), false, "the command's answer is not in her request");
    assert.equal(request.includes('/interface'), false, 'the command is not in her request');
    assert.deepEqual(
      query(dirs, "SELECT kind FROM sources WHERE text LIKE '%zeta71%' OR text LIKE '%/interface%'"),
      [],
      'neither the command nor its answer is a line of her memory'
    );
  });
});

// Case 3 of PR D.
test('-p prints the answer of one command alone and exits 0', async () => {
  await withRig({ config: MARKED }, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const run = await runCli(dirs, ['-p', '/interface list']);
    assert.equal(run.code, 0, run.stderr.slice(-2000));
    assert.ok(run.stdout.includes('zeta71'), 'the answer names the interface of the local layer');
    assert.deepEqual(logLines(run.stdout), [], 'no log line on stdout');
  });
});

// Case 3 of PR D, the error path.
test('-p exits 1 for a command the core does not know', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const run = await runCli(dirs, ['-p', '/no-such-command']);
    assert.equal(run.code, 1, run.stderr.slice(-2000));
  });
});

// Case 3 of PR D, the status card without a live probe.
test('-p "/status" answers without asking any model', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const run = await runCli(dirs, ['-p', '/status']);
    assert.equal(run.code, 0, run.stderr.slice(-2000));
    assert.notEqual(run.stdout.trim(), '');
    assert.equal(llm.requests.length, 0, '/status probes no model');
  });
});

// Case 3 of PR D, the core down.
// A usage error ends `neptunia` with 2, so 1 tells a script that the command did not reach a core.
test('-p exits 1 without waiting when no core listens', async () => {
  await withRig({}, async ({ dirs }) => {
    const run = await runCli(dirs, ['-p', '/status'], 10000);
    assert.equal(run.code, 1, run.stderr.slice(-2000));
  });
});

type Check = { name: string; status: string };

/** The checks of `neptunia doctor --json`: one JSON object `{ checks: [{ name, status }] }` on stdout. */
function checksOf(stdout: string): Map<string, string> {
  const parsed: unknown = JSON.parse(stdout);
  assert.ok(parsed !== null && typeof parsed === 'object' && Array.isArray(Reflect.get(parsed, 'checks')));
  const checks = Reflect.get(parsed, 'checks') as Array<Check>;
  return new Map(checks.map((check) => [check.name, check.status]));
}

const digestOf = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Folders with the cli client, a `.env` holding a key, and a memory database written and closed: no core runs. */
function coreDown(): { dirs: Dirs; db: string; key: string; token: string } {
  const dirs = folders({});
  addClient(dirs.privateDir, CLI_CLIENT);
  const key = 'sk-or-test-zeta-not-a-real-key';
  writeFileSync(join(dirs.privateDir, '.env'), `OPENROUTER_CORE_KEY=${key}\n`, { mode: 0o600 });
  mkdirSync(dirs.dataDir, { recursive: true });
  const db = join(dirs.dataDir, 'memory.db');
  openMemoryDb(db, { context: { dataDir: dirs.dataDir } }).close();
  const token = readFileSync(join(dirs.privateDir, 'clients', 'cli.token'), 'utf8').trim();
  return { dirs, db, key, token };
}

// Case 4 of PR D.
test('doctor with the core down reports the socket failed and the database sound, and changes nothing', async () => {
  const { dirs, db, key, token } = coreDown();
  const before = digestOf(db);
  const run = await runCli(dirs, ['doctor', '--json']);
  assert.equal(run.code, 1, 'a failed check ends doctor with 1');
  const checks = checksOf(run.stdout);
  assert.equal(checks.get('socket'), 'fail');
  assert.equal(checks.get('database'), 'ok');
  assert.equal(checks.get('tokens'), 'ok');
  for (const name of ['node', 'binaries', 'config', 'local-layer', 'env-keys'])
    assert.ok(checks.has(name), `doctor checks ${name}`);
  assert.equal(digestOf(db), before, 'the database is read only');
  assert.equal(existsSync(lockPathOf(db)), false, 'doctor takes no writer lock');
  assert.equal(existsSync(join(dirs.dataDir, 'run')), false, 'doctor makes no socket folder');
  const printed = run.stdout + run.stderr;
  assert.equal(printed.includes(key), false, 'no key value is printed');
  assert.equal(printed.includes(token), false, 'no token is printed');
});

// Case 4 of PR D, the error path.
test('doctor reports a database that is not one as failed and leaves the file as it was', async () => {
  const { dirs, db } = coreDown();
  writeFileSync(db, 'this file is not a database\n');
  const before = digestOf(db);
  const run = await runCli(dirs, ['doctor', '--json']);
  assert.equal(run.code, 1);
  assert.equal(checksOf(run.stdout).get('database'), 'fail');
  assert.equal(digestOf(db), before);
});

// PR 7a: the command line holds no key, so with the core down the provider probes are skipped, never run.
test('doctor --live with the core down reports the provider probes skipped and prints no key', async () => {
  const { dirs, key } = coreDown();
  const run = await runCli(dirs, ['doctor', '--live', '--json']);
  const checks = checksOf(run.stdout);
  assert.equal(checks.get('providers'), 'skipped');
  assert.equal(checks.get('socket'), 'fail', 'the core is down');
  assert.equal((run.stdout + run.stderr).includes(key), false, 'no key value is printed');
});

/** The first JSON line the runner answers on `socket` to one `ping`. */
function ping(socket: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socket);
    let buffer = '';
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error('the runner never answered the ping'));
    }, 5000);
    conn.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    conn.on('connect', () => conn.write(`${JSON.stringify({ op: 'ping' })}\n`));
    conn.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      clearTimeout(timer);
      conn.end();
      resolve(JSON.parse(buffer.slice(0, end)) as Record<string, unknown>);
    });
  });
}

// Case 9 of PR D.
test('errand-runner starts the scout runner on the socket of the local layer and stops on SIGTERM', async () => {
  const dirs = folders({});
  const socket = join(dirs.root, 's.sock');
  const out = join(dirs.root, 'out');
  // The socket and the output folder come from the private layer the runner is pointed at, never the checkout's.
  writeFileSync(join(dirs.privateDir, 'config.local.json'), JSON.stringify({ agents: { scout: { socket, out } } }));
  const runner = spawnCli(dirs, ['errand-runner', '--profile', 'scout']);
  try {
    await until(() => existsSync(socket) || runner.child.exitCode !== null, 'the runner socket');
    assert.ok(existsSync(socket), `the runner listens; stderr:\n${runner.stderr().slice(-2000)}`);
    const pong = await ping(socket);
    assert.equal(pong.event, 'pong');
    assert.equal(pong.profile, 'scout');
    runner.child.kill('SIGTERM');
    assert.deepEqual(await runner.exited, { code: 0, signal: null });
  } finally {
    await runner.kill();
  }
});
