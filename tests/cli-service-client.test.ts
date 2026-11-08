// The `service` client of the owner's command line: the lead, the development agents and scripts check the persona
// with `neptunia -p` as `NEPTUNIA_CLIENT=service`. Its line gets a turn and her answer, and neither the line nor her
// answer reaches her memory or a later turn of the owner's chat. Each test runs the real core and the real `neptunia`
// command over fresh folders, because the path spans the link, the door, the pipeline, the turn and the writer.
// Synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANSWER,
  CLI_CLIENT,
  FAKE_CLIENT,
  query,
  settle,
  spawnCli,
  startUnitsCore,
  withRig,
} from './fixtures/core-units.ts';
import type { Client, Dirs, Exit } from './fixtures/core-units.ts';

const SERVICE_CLIENT: Client = { name: 'service', kind: 'cli' };
const CLIENTS: ReadonlyArray<Client> = [FAKE_CLIENT, CLI_CLIENT, SERVICE_CLIENT];

/** Runs `neptunia <args>` to its end with `env` added, its input closed; a run past 20 s fails the test. */
async function run(
  dirs: Dirs,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = {}
): Promise<Exit & { stdout: string; stderr: string }> {
  const cli = spawnCli(dirs, args, env);
  cli.end();
  const timer = setTimeout(() => void cli.kill(), 20_000);
  const exit = await cli.exited;
  clearTimeout(timer);
  assert.equal(exit.signal, null, `neptunia ${args.join(' ')} did not end:\n${cli.stderr().slice(-2000)}`);
  return { ...exit, stdout: cli.stdout(), stderr: cli.stderr() };
}

const AS_SERVICE: NodeJS.ProcessEnv = { NEPTUNIA_CLIENT: 'service' };

const cliSources = (dirs: Dirs): Array<Record<string, unknown>> =>
  query(dirs, "SELECT kind, text FROM sources WHERE iface = 'cli' ORDER BY rowid");

const turnRecords = (dirs: Dirs): number =>
  Number(query(dirs, 'SELECT COUNT(*) AS n FROM day WHERE turn_id IS NOT NULL')[0]?.n ?? 0);

test('a service line is answered and neither the line nor her answer is stored', async () => {
  // Bug: every `neptunia -p` of the lead lands in `cli:dm:owner` as the owner's line and reaches her memory.
  await withRig({ clients: CLIENTS }, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    const done = await run(dirs, ['-p', 'service check ονομα-417 answer one word'], AS_SERVICE);
    assert.equal(done.code, 0, done.stderr.slice(-2000));
    assert.ok(done.stdout.includes(ANSWER), `her answer is printed: ${done.stdout}`);
    assert.equal(llm.requests.length > 0, true, 'her turn asked the model');
    await settle();
    assert.deepEqual(cliSources(dirs), []);
    assert.equal(turnRecords(dirs), 0, 'the journal keeps no record of the turn');
  });
});

test('the owner line is stored with her answer', async () => {
  // Bug: the service path swallows the owner's own lines too, so his chat forgets what he said.
  await withRig({ clients: CLIENTS }, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    const done = await run(dirs, ['-p', 'owner line ἀστέρι-528']);
    assert.equal(done.code, 0, done.stderr.slice(-2000));
    assert.ok(done.stdout.includes(ANSWER), `her answer is printed: ${done.stdout}`);
    await settle();
    const stored = cliSources(dirs);
    assert.ok(
      stored.some((row) => row.kind === 'seen' && String(row.text).includes('ἀστέρι-528')),
      `his line is stored: ${JSON.stringify(stored)}`
    );
    assert.ok(
      stored.some((row) => row.kind === 'said' && row.text === ANSWER),
      `her answer is stored: ${JSON.stringify(stored)}`
    );
    assert.ok(turnRecords(dirs) > 0, 'the journal keeps the turn');
  });
});

test('a service line never reaches the request of the owner next turn', async () => {
  // Bug: a check of the lead shows up in her `<chat>` the next time the owner writes, as something he said.
  await withRig({ clients: CLIENTS }, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    const checked = await run(dirs, ['-p', 'service probe κρυφό-639'], AS_SERVICE);
    assert.equal(checked.code, 0, checked.stderr.slice(-2000));
    const asked = llm.requests.length;
    const owner = await run(dirs, ['-p', 'owner follow-up φανάρι-640']);
    assert.equal(owner.code, 0, owner.stderr.slice(-2000));
    const later = JSON.stringify(llm.requests.slice(asked));
    assert.ok(later.includes('φανάρι-640'), 'the owner turn carries his own line');
    assert.equal(later.includes('κρυφό-639'), false, 'the owner turn carries nothing of the service line');
  });
});

test('a service command answers as the owner command does and leaves no memory trace', async () => {
  // Bug: the service principal is refused the chat's commands, or a command of it writes into her memory.
  await withRig({ clients: CLIENTS }, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    const owner = await run(dirs, ['-p', '/rules list']);
    const service = await run(dirs, ['-p', '/rules list'], AS_SERVICE);
    assert.equal(service.code, 0, service.stderr.slice(-2000));
    assert.equal(service.stdout, owner.stdout);
    await settle();
    assert.deepEqual(cliSources(dirs), []);
    assert.equal(llm.requests.length, 0, 'a command asks no model');
  });
});

test('an unknown client name exits 2 and connects as nobody', async () => {
  // Bug: a typo in NEPTUNIA_CLIENT falls back to the owner, so the check lands in his chat and her memory.
  await withRig({ clients: CLIENTS }, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    const done = await run(dirs, ['-p', 'a line under a misspelt client'], { NEPTUNIA_CLIENT: 'servcie' });
    assert.equal(done.code, 2);
    assert.match(done.stderr, /NEPTUNIA_CLIENT/);
    assert.equal(done.stdout, '');
    await settle();
    assert.deepEqual(cliSources(dirs), []);
    assert.equal(llm.requests.length, 0);
  });
});
