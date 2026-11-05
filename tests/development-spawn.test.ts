// The development worker at the spawn boundary: the real `runAgent` and the real backends over disposable fake
// executables in the private layer, each of which records its argv, working directory and environment and acts as told.
// git, gh and the tests stay the fakes of tests/fixtures/development-rig.ts. This proves what an in-process fake cannot:
// the argv each child gets from its own route in keys.json, what its environment holds, and that a stop reaches its
// whole process group. No provider and no real CLI runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { BackendName } from '../src/agent-runner/profiles.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import { runAgent } from '../src/subharness/run.ts';
import type { RunDeps } from '../src/subharness/run.ts';
import {
  MINUTE,
  WORKER,
  childrenOf,
  developmentWorld,
  fileDevTask,
  ownerTask,
  settle,
} from './fixtures/development-rig.ts';
import type { DevelopmentWorld } from './fixtures/development-rig.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

/**
 * The fake CLI. It records one file per run under `RECORD_DIR` (fixed in the script, the child's environment is minimal),
 * writes the final message where codex's `-o` names, and in `sleep` mode leaves a grandchild in its group and waits.
 */
function fakeCli(recordDir: string, behaviour: 'finish' | 'sleep'): string {
  return `#!/bin/sh
out="${recordDir}/$$.run"
{
  echo "cwd=$(pwd)"
  for arg in "$@"; do echo "arg=$arg"; done
  env | sed 's/^/env=/'
} > "$out"
previous=""
for arg in "$@"; do
  if [ "$previous" = "-o" ]; then echo "finished" > "$arg"; fi
  previous="$arg"
done
cat > /dev/null
${
  behaviour === 'sleep'
    ? `sleep 60 &
echo "$$ $!" > "${recordDir}/$$.pids"
wait`
    : 'echo finished'
}
`;
}

function installFake(privateDir: string, backend: BackendName, script: string): void {
  const { binary } = subharnessPlace(privateDir, backend);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, script, { mode: 0o755 });
}

/** The fake's pid and its grandchild's, written once the fake started in `sleep` mode. */
function pidsOf(recordDir: string): [number, number] {
  const name = fs.readdirSync(recordDir).find((one) => one.endsWith('.pids'));
  if (name === undefined) throw new Error('the dev child never started');
  const [child, grandchild] = fs.readFileSync(path.join(recordDir, name), 'utf8').trim().split(' ').map(Number);
  return [child ?? 0, grandchild ?? 0];
}

type Recorded = { cwd: string; args: Array<string>; env: Map<string, string> };

/** Every run the fake CLIs recorded, in no particular order. */
function recordedRuns(recordDir: string): Array<Recorded> {
  return fs
    .readdirSync(recordDir)
    .filter((name) => name.endsWith('.run'))
    .map((name) => {
      const lines = fs.readFileSync(path.join(recordDir, name), 'utf8').split('\n');
      const of = (prefix: string): Array<string> =>
        lines.filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length));
      const env = new Map(
        of('env=').map((line): [string, string] => [line.split('=')[0] ?? '', line.slice(line.indexOf('=') + 1)])
      );
      return { cwd: of('cwd=')[0] ?? '', args: of('arg='), env };
    });
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Polls until `check` holds; the kill grace is seconds at most, the fake ignores no signal. */
async function eventually(check: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 300; tries += 1) {
    if (check()) return;
    await delay(10);
  }
  assert.fail(`never happened: ${what}`);
}

type Rig = { world: DevelopmentWorld; privateDir: string; recordDir: string; realRun: RunDeps };

/** The world with its fake agent run replaced by the real `runAgent` over the fake CLIs; a thinker script still acts. */
function spawnRig(
  t: { after: (fn: () => void | Promise<void>) => void },
  subharness: Parameters<typeof writeKeysFile>[1]
): Rig {
  const world = developmentWorld(t);
  const privateDir = tempDir('nep-development-spawn-private-');
  const recordDir = tempDir('nep-development-spawn-record-');
  writeKeysFile(privateDir, subharness);
  const realRun: RunDeps = { privateDir, denyDir: path.join(tempDir('nep-development-spawn-deny-'), 'nosudo') };
  let turn = 0;
  world.deps.runAgent = async (run) => {
    const done = await runAgent(run, realRun);
    if (run.agent === 'thinker') {
      turn += 1;
      await world.scripts.thinker({ ...run, aborted: false }, turn);
    }
    return done;
  };
  return { world, privateDir, recordDir, realRun };
}

const flagAfter = (args: ReadonlyArray<string>, flag: string): string | undefined => args[args.indexOf(flag) + 1];

test('thinker and dev on different backends each run with the model and effort of their own route', async (t) => {
  // Catches: dev inherits the thinker's route, or a model or effort from a profile beats the owner's keys.json.
  const { world, privateDir, recordDir } = spawnRig(t, {
    subharness: {
      backends: ['claude', 'codex'],
      key: null,
      modes: { thinker: 'write', dev: 'write' },
      uses: { thinker: 'claude', dev: 'codex' },
      models: { thinker: 'thinker-model', dev: 'dev-model' },
      efforts: { thinker: 'high', dev: 'low' },
    },
  });
  installFake(privateDir, 'claude', fakeCli(recordDir, 'finish'));
  installFake(privateDir, 'codex', fakeCli(recordDir, 'finish'));
  const id = ownerTask(world);
  world.scripts.thinker = (_run, turn) => {
    if (turn === 1) fileDevTask(world, id, 'A step');
  };
  await settle(world.worker());
  const runs = recordedRuns(recordDir);
  const thinker = runs.filter((run) => run.args.includes('-p'));
  const dev = runs.filter((run) => run.args.includes('exec'));
  assert.equal(thinker.length, 2);
  assert.equal(dev.length, 1);
  assert.equal(flagAfter(thinker[0]?.args ?? [], '--model'), 'thinker-model');
  assert.equal(flagAfter(thinker[0]?.args ?? [], '--effort'), 'high');
  assert.equal(flagAfter(dev[0]?.args ?? [], '-m'), 'dev-model');
  assert.equal(flagAfter(dev[0]?.args ?? [], '-c'), 'model_reasoning_effort=low');
  assert.notEqual(dev[0]?.cwd, thinker[0]?.cwd);
  assert.equal(fs.realpathSync(thinker[0]?.cwd ?? ''), fs.realpathSync(path.join(world.worktreeRoot, id)));
});

test('the thinker gets its board client and dev gets none, and neither gets a gh login or a key', async (t) => {
  // Catches: a thinker able to merge by itself through `gh`, which would walk past the code's CI read.
  const { world, privateDir, recordDir } = spawnRig(t, {
    subharness: {
      backends: ['claude', 'codex'],
      key: null,
      modes: {},
      uses: { thinker: 'claude', dev: 'codex' },
    },
  });
  installFake(privateDir, 'claude', fakeCli(recordDir, 'finish'));
  installFake(privateDir, 'codex', fakeCli(recordDir, 'finish'));
  process.env.GH_CONFIG_DIR = '/nowhere/gh';
  process.env.GH_TOKEN = 'gh-secret';
  process.env.OPENROUTER_API_KEY = 'router-secret';
  t.after(() => {
    delete process.env.GH_CONFIG_DIR;
    delete process.env.GH_TOKEN;
    delete process.env.OPENROUTER_API_KEY;
  });
  const id = ownerTask(world);
  world.scripts.thinker = (_run, turn) => {
    if (turn === 1) fileDevTask(world, id, 'A step');
  };
  await settle(world.worker());
  const runs = recordedRuns(recordDir);
  const thinker = runs.find((run) => run.args.includes('-p'));
  const dev = runs.find((run) => run.args.includes('exec'));
  assert.equal(thinker?.env.get('NEPTUNIA_TASK_CLIENT'), WORKER);
  assert.equal(dev?.env.get('NEPTUNIA_TASK_CLIENT'), undefined);
  for (const run of [thinker, dev]) {
    for (const name of ['GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'OPENROUTER_API_KEY']) {
      assert.equal(run?.env.get(name), undefined, name);
    }
  }
});

test('an agent env cannot put its own PATH over the refusing sudo', async (t) => {
  // Catches: `AgentRun.env` laid over the environment `runAgent` built, which lifts the sudo stand-in.
  const { world, privateDir, recordDir, realRun } = spawnRig(t, {
    subharness: { backends: ['claude'], key: null, modes: { dev: 'write' } },
  });
  installFake(privateDir, 'claude', fakeCli(recordDir, 'finish'));
  await runAgent(
    { agent: 'dev', brief: 'Do it.', cwd: world.repoDir, timeoutMs: MINUTE, env: { PATH: '/evil', EXTRA: 'kept' } },
    realRun
  );
  // The agent's own run, past the `--help` read that asks whether the backend takes `--session-id`.
  const run = recordedRuns(recordDir).find((one) => one.args.includes('-p'));
  assert.ok((run?.env.get('PATH') ?? '').startsWith(realRun.denyDir));
  assert.equal(run?.env.get('EXTRA'), 'kept');
});

test('cancelling a task kills its dev child and what that child spawned, by process group', async (t) => {
  // Catches: only the direct child dies, and its grandchild keeps writing in the worktree.
  const { world, privateDir, recordDir } = spawnRig(t, {
    subharness: {
      backends: ['claude', 'codex'],
      key: null,
      modes: {},
      uses: { thinker: 'claude', dev: 'codex' },
    },
  });
  installFake(privateDir, 'claude', fakeCli(recordDir, 'finish'));
  installFake(privateDir, 'codex', fakeCli(recordDir, 'sleep'));
  const id = ownerTask(world);
  world.scripts.thinker = (_run, turn) => {
    if (turn === 1) fileDevTask(world, id, 'A long step');
  };
  const worker = world.worker();
  const pidsFile = (): string | undefined => fs.readdirSync(recordDir).find((name) => name.endsWith('.pids'));
  for (let tries = 0; tries < 300 && pidsFile() === undefined; tries += 1) {
    await worker.wake();
    await delay(10);
  }
  const [child, grandchild] = pidsOf(recordDir);
  assert.ok(isAlive(child) && isAlive(grandchild));
  const { revision } = world.show(id).task;
  world.board.call('boss', 'task.transition', { id, status: 'cancelled', close_reason: 'Not needed.', revision });
  await worker.wake();
  await eventually(() => !isAlive(child) && !isAlive(grandchild), 'both processes died');
  await worker.idle();
  assert.equal(world.show(childrenOf(world, id)[0] ?? '').task.status, 'cancelled');
});

test('a dev child past its timeout is killed by process group and its dev task fails with the timeout', async (t) => {
  // Catches: a hung agent holding its task for ever, or a timeout that leaves the grandchild behind.
  const { world, privateDir, recordDir } = spawnRig(t, {
    subharness: {
      backends: ['claude', 'codex'],
      key: null,
      modes: {},
      uses: { thinker: 'claude', dev: 'codex' },
    },
  });
  installFake(privateDir, 'claude', fakeCli(recordDir, 'finish'));
  installFake(privateDir, 'codex', fakeCli(recordDir, 'sleep'));
  world.deps.runTimeoutMs = 300;
  const id = ownerTask(world);
  world.scripts.thinker = (_run, turn) => {
    if (turn === 1) fileDevTask(world, id, 'A hung step');
  };
  await settle(world.worker());
  const [child, grandchild] = pidsOf(recordDir);
  assert.equal(isAlive(child), false);
  assert.equal(isAlive(grandchild), false);
  const devTask = world.show(childrenOf(world, id)[0] ?? '').task;
  assert.equal(devTask.status, 'failed');
  assert.match(devTask.close_reason ?? '', /timeout/);
});

test('recovering a lapsed lease signals no process named by what the board remembers', async (t) => {
  // Catches: a recycled pid from metadata gets killed, and an unrelated process dies with the recovery.
  const world = developmentWorld(t);
  const unrelated = spawn('sleep', ['60'], { stdio: 'ignore' });
  t.after(() => {
    unrelated.kill('SIGKILL');
  });
  const id = ownerTask(world);
  const branch = `self/${id}`;
  world.branches.add(branch);
  world.board.call(WORKER, 'task.claim', { id });
  const { task } = world.show(id);
  world.board.call(WORKER, 'task.update', {
    id,
    revision: task.revision,
    metadata: {
      development: { branch, worktree: path.join(world.worktreeRoot, id), pr: null, head: null, pid: unrelated.pid },
    },
  });
  world.advance(31 * MINUTE);
  world.board.reap();
  await settle(world.worker());
  await delay(50);
  assert.equal(isAlive(unrelated.pid ?? 0), true);
  assert.equal(world.runsOf('thinker').length, 1);
});
