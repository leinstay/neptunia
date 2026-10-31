// `neptunia task <command>` (bin/neptunia.ts): the board's command line as a client of the core. It takes the
// commands and flags of the ledger's `task` CLI, reads its token from `NEPTUNIA_TASK_TOKEN`, connects to the core's
// socket as an agent and prints the answer: plain lines, or the answer's JSON with `--json`. It exits 0 when the core
// answers ok, 1 when the board refuses (the code first on stderr) or no core listens, and 2 for a usage error, which
// never reaches the core. The core runs in the test process as the units run it (tests/fixtures/core-units.ts); each
// `neptunia` is a child process over the real socket. The tests read ids, statuses, codes and exit codes, never a
// label's wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLI_CLIENT, runCli, spawnCli, startUnitsCore, withRig } from './fixtures/core-units.ts';
import type { Client, Dirs, Exit } from './fixtures/core-units.ts';

const T0 = Date.parse('2026-10-31T12:00:00Z');
const CONFIG = { board: { leaseTtlMinutes: 30, reapSeconds: 60, briefWaitMs: 1800000 } };
const CLIENTS: ReadonlyArray<Client> = [
  CLI_CLIENT,
  { name: 'boss', kind: 'agent', roles: ['owner'] },
  { name: 'hand', kind: 'agent', roles: ['worker'] },
];

type Run = Exit & { stdout: string; stderr: string };

const tokenOf = (dirs: Dirs, name: string): string =>
  readFileSync(join(dirs.privateDir, 'clients', `${name}.token`), 'utf8').trim();

/** Runs `neptunia task ...args` as the agent `name` to its end, with its input closed. */
async function task(dirs: Dirs, name: string, args: ReadonlyArray<string>, ms = 15000): Promise<Run> {
  const cli = spawnCli(dirs, ['task', ...args], { NEPTUNIA_TASK_TOKEN: tokenOf(dirs, name) });
  cli.end();
  const timer = setTimeout(() => void cli.kill(), ms);
  const exit = await cli.exited;
  clearTimeout(timer);
  assert.equal(exit.signal, null, `neptunia task ${args.join(' ')} did not end:\n${cli.stderr().slice(-2000)}`);
  return { ...exit, stdout: cli.stdout(), stderr: cli.stderr() };
}

/** `neptunia task add` as the owner agent: the id it prints. */
async function added(dirs: Dirs, title: string, extra: ReadonlyArray<string> = []): Promise<string> {
  const run = await task(dirs, 'boss', ['add', '--lane', 'dev', '--project', 'core', '--title', title, ...extra]);
  assert.equal(run.code, 0, run.stderr);
  const id = run.stdout.trim();
  assert.match(id, /^T-[a-z2-7]+$/);
  return id;
}

const withCore = (body: (dirs: Dirs) => Promise<void>): Promise<void> =>
  withRig({ config: CONFIG, clients: CLIENTS }, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    await body(dirs);
  });

test('task show prints the task with its id, status and title first, and --json parses to the same task', async () => {
  await withCore(async (dirs) => {
    const id = await added(dirs, 'Read the zeta71 tag');
    const plain = await task(dirs, 'boss', ['show', id]);
    assert.equal(plain.code, 0, plain.stderr);
    const first = plain.stdout.split('\n')[0] ?? '';
    assert.ok(first.startsWith(id), first);
    assert.ok(first.includes('proposed'), first);
    assert.ok(first.includes('Read the zeta71 tag'), first);
    const json = await task(dirs, 'boss', ['show', id, '--json']);
    assert.equal(json.code, 0, json.stderr);
    const view: unknown = JSON.parse(json.stdout);
    assert.ok(view !== null && typeof view === 'object' && 'task' in view);
    const shown = (view as { task: { id: string; title: string } }).task;
    assert.equal(shown.id, id);
    assert.equal(shown.title, 'Read the zeta71 tag');
  });
});

test('a refusal of the board exits 1 with its code first on stderr', async () => {
  await withCore(async (dirs) => {
    const id = await added(dirs, 'a plan');
    const triage = await task(dirs, 'boss', ['triage', id, '--role', 'dev', '--estimate', '20', '--budget', '2']);
    assert.equal(triage.code, 0, triage.stderr);
    const approve = await task(dirs, 'hand', ['approve', id]);
    assert.equal(approve.code, 1);
    assert.ok(approve.stderr.startsWith('forbidden:'), approve.stderr);
  });
});

test('a usage error exits 2: a show without an id and an unknown command', async () => {
  await withCore(async (dirs) => {
    assert.equal((await task(dirs, 'boss', ['show'])).code, 2);
    assert.equal((await task(dirs, 'boss', ['frobnicate'])).code, 2);
  });
});

test('task heartbeat without --generation is refused invalid, and with the generation task next gave it goes through', async () => {
  await withCore(async (dirs) => {
    const id = await added(dirs, 'work', ['--auto', '--no-brief']);
    const next = await task(dirs, 'hand', ['next', '--lane', 'dev', '--role', 'dev', '--json']);
    assert.equal(next.code, 0, next.stderr);
    const held = JSON.parse(next.stdout) as { id: string; lease_generation: number };
    assert.equal(held.id, id);
    const bare = await task(dirs, 'hand', ['heartbeat', id]);
    assert.equal(bare.code, 1);
    assert.ok(bare.stderr.startsWith('invalid:'), bare.stderr);
    const beat = await task(dirs, 'hand', ['heartbeat', id, '--generation', String(held.lease_generation)]);
    assert.equal(beat.code, 0, beat.stderr);
  });
});

test('with the core paused, task commands still answer', async () => {
  await withCore(async (dirs) => {
    const id = await added(dirs, 'while paused');
    const pause = await runCli(dirs, ['-p', 'pause']);
    assert.equal(pause.code, 0, pause.stderr);
    const list = await task(dirs, 'boss', ['list']);
    assert.equal(list.code, 0, list.stderr);
    assert.ok(list.stdout.includes(id), list.stdout);
  });
});

test('task exits 1 and says unavailable when no core listens', async () => {
  await withRig({ config: CONFIG, clients: CLIENTS }, async ({ dirs }) => {
    const run = await task(dirs, 'boss', ['list']);
    assert.equal(run.code, 1);
    assert.ok(run.stderr.startsWith('unavailable:'), run.stderr);
  });
});
