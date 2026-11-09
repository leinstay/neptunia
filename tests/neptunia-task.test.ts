// `neptunia tasks <command>` (bin/neptunia.ts): the board's command line as a client of the core. It takes the
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
import { runTask } from '../bin/neptunia-task.ts';
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

/** Runs `neptunia tasks ...args` as the agent `name` to its end, with its input closed. */
async function task(dirs: Dirs, name: string, args: ReadonlyArray<string>, ms = 15000): Promise<Run> {
  const cli = spawnCli(dirs, ['tasks', ...args], { NEPTUNIA_TASK_TOKEN: tokenOf(dirs, name) });
  cli.end();
  const timer = setTimeout(() => void cli.kill(), ms);
  const exit = await cli.exited;
  clearTimeout(timer);
  assert.equal(exit.signal, null, `neptunia tasks ${args.join(' ')} did not end:\n${cli.stderr().slice(-2000)}`);
  return { ...exit, stdout: cli.stdout(), stderr: cli.stderr() };
}

/** `neptunia tasks add` as the owner agent: the id it prints. */
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
    // A `-p` text without a slash is one turn with the persona, so the command takes its slash.
    const pause = await runCli(dirs, ['-p', '/pause']);
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

// ---------- the line, refused or taken before any core is asked ----------

/** A client with no token, so a line the parser takes exits 1 with `unavailable:` and a refused one exits 2. */
const NO_TOKEN = { NEPTUNIA_TASK_CLIENT: 'zeta71-no-such-client' };

/** The exit code of `neptunia tasks ...argv` in this process, its output swallowed. */
async function exitOf(argv: ReadonlyArray<string>): Promise<number> {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    return await runTask(argv, NO_TOKEN);
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

test('a flag the command does not take exits 2 before any core is asked', async () => {
  // Bug: the parser stored any flag, so a misspelt `--prioirty` changed nothing and said nothing.
  assert.equal(await exitOf(['update', 'T-abcdef', '--prioirty', '1']), 2);
  assert.equal(await exitOf(['show', 'T-abcdef', '--reason', 'x']), 2);
  assert.equal(await exitOf(['list', '--ready', '--full']), 2);
});

test('each command takes the flags its usage names, and the common ones', async () => {
  // Bug: a per-command list of flags leaves out one the usage promises, so a valid line is refused.
  const lines: ReadonlyArray<ReadonlyArray<string>> = [
    ['update', 'T-abcdef', '--priority', '1', '--meta', 'admitted=yes', '--json', '--key', 'k1'],
    ['submit', 'T-abcdef', '--handoff', '-', '--generation', '2', '--attempt', 'A-1'],
    ['approve', 'T-abcdef', '--scope', 'merge', '--reject', '--note', 'not this way'],
    ['result', 'T-abcdef', '--kind', 'pr', '--uri', 'https://example.test/1', '--no-submit', '--generation', '1'],
    ['events', '--from', '3', '--limit', '1', '--socket', '/nonexistent/core.sock'],
  ];
  for (const line of lines) assert.equal(await exitOf(line), 1, line.join(' '));
});

test('a reject is approve --reject with its scope and a note, and the old reject word is gone', async () => {
  // Bug: `reject` hard-coded the plan scope, so a merge gate could only be refused through another command.
  assert.equal(await exitOf(['reject', 'T-abcdef', '--reason', 'no']), 2);
  assert.equal(await exitOf(['approve', 'T-abcdef', '--reject']), 2);
  assert.equal(await exitOf(['approve', 'T-abcdef', '--scope', 'merge', '--reject', '--note', 'no']), 1);
});

// ---------- the verbs over a running core ----------

/** The task `id` as `show --json` answers it. */
async function shown(dirs: Dirs, id: string): Promise<{ title: string; status: string }> {
  const run = await task(dirs, 'boss', ['show', id, '--json']);
  assert.equal(run.code, 0, run.stderr);
  return (JSON.parse(run.stdout) as { task: { title: string; status: string } }).task;
}

/** The ids `list --ready --json` answers. */
async function readyIds(dirs: Dirs): Promise<Array<string>> {
  const run = await task(dirs, 'boss', ['list', '--ready', '--json']);
  assert.equal(run.code, 0, run.stderr);
  return (JSON.parse(run.stdout) as Array<{ id: string }>).map((one) => one.id);
}

test('update changes a field at the revision the task has, and move closes it with its reason', async () => {
  // Bug: update or move sends a stale revision, or a field under the wrong board name, and the board refuses or drops it.
  await withCore(async (dirs) => {
    const id = await added(dirs, 'the first title');
    const update = await task(dirs, 'boss', ['update', id, '--title', 'the second title']);
    assert.equal(update.code, 0, update.stderr);
    assert.equal((await shown(dirs, id)).title, 'the second title');
    const move = await task(dirs, 'boss', ['move', id, 'cancelled', '--reason', 'not needed']);
    assert.equal(move.code, 0, move.stderr);
    assert.equal((await shown(dirs, id)).status, 'cancelled');
  });
});

test('depend holds a task back from the ready list, and undepend lets it go', async () => {
  // Bug: `--on` reaches the board under another name, so the dependency is never recorded or never removed.
  await withCore(async (dirs) => {
    const first = await added(dirs, 'first', ['--auto', '--no-brief']);
    const second = await added(dirs, 'second', ['--auto', '--no-brief']);
    assert.ok((await readyIds(dirs)).includes(second));
    const depend = await task(dirs, 'boss', ['depend', second, '--on', first]);
    assert.equal(depend.code, 0, depend.stderr);
    assert.ok(!(await readyIds(dirs)).includes(second));
    const undepend = await task(dirs, 'boss', ['undepend', second, '--on', first]);
    assert.equal(undepend.code, 0, undepend.stderr);
    assert.ok((await readyIds(dirs)).includes(second));
  });
});

test('events --limit answers that many events after --from', async () => {
  // Bug: `--limit` or `--from` is dropped on the way, so a reader gets the whole log or misses its place.
  await withCore(async (dirs) => {
    await added(dirs, 'one');
    await added(dirs, 'two');
    const page = await task(dirs, 'boss', ['events', '--from', '0', '--limit', '1', '--json']);
    assert.equal(page.code, 0, page.stderr);
    const events = JSON.parse(page.stdout) as Array<{ seq: number }>;
    assert.equal(events.length, 1);
    const after = await task(dirs, 'boss', ['events', '--from', String(events[0]?.seq), '--json']);
    assert.equal(after.code, 0, after.stderr);
    assert.ok((JSON.parse(after.stdout) as Array<{ seq: number }>).every((one) => one.seq > (events[0]?.seq ?? 0)));
  });
});
