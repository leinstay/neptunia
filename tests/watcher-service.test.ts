// `neptunia service watcher trigger|cancel|status` (src/service/commands.ts) with no core: one run identity from one
// claim, cancel and disable apart, status read with no model request, the units on the same lifecycle, and the worker
// (bin/neptunia.ts) reporting with the board unreachable. The manager is a recorder. One test runs the real worker over
// a stand-in backend binary and connects to nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.ts';
import { localConfigPath } from '../src/config/files.ts';
import { serviceFamily } from '../src/service/commands.ts';
import type { ServiceAnswer } from '../src/service/commands.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';
import { answerOf } from './fixtures/watcher-inspection-rig.ts';
import { PLANTED_KEY } from './fixtures/watcher-rig.ts';

const lifecycle = () => import('../src/watcher/lifecycle.ts');
const filing = () => import('../src/watcher/filing.ts');

const REPO = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO, 'bin', 'neptunia.ts');
const NOW = Date.parse('2026-11-04T10:00:00Z');
const WORKER = 'neptunia-watcher.service';

type Rig = { data: string; dir: string; calls: Array<string>; failOn?: string };

function rig(watcher: Record<string, unknown> = { enabled: true, schedule: 'at 06:00' }): Rig {
  const data = tempDir('nep-watcher-service-');
  fs.mkdirSync(path.dirname(localConfigPath(data)), { recursive: true });
  fs.writeFileSync(localConfigPath(data), JSON.stringify({ watcher }));
  const dir = path.join(data, 'agents', 'watcher');
  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  return { data, dir, calls: [] };
}

const family = (where: Rig, action: string, args: Record<string, unknown> = {}): Promise<ServiceAnswer> =>
  serviceFamily(
    {
      rootDir: REPO,
      privateDir: where.data,
      dataDir: where.data,
      config: () => readConfig(REPO, { privateDir: where.data }),
      now: () => NOW,
      env: { NEPTUNIA_UNIT_SCOPE: 'user' },
      coreUp: false,
      run: (command, list) => {
        where.calls.push([command, ...list].join(' '));
        if (where.failOn !== undefined && list.includes(where.failOn))
          return Promise.resolve({ code: 1, stdout: '', stderr: 'zeta-refused' });
        if (list.includes('is-active')) return Promise.resolve({ code: 0, stdout: 'inactive\n', stderr: '' });
        if (list.includes('is-enabled')) return Promise.resolve({ code: 0, stdout: 'enabled\n', stderr: '' });
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      },
    },
    `service.watcher.${action}`,
    args
  );

const field = (text: string, key: string): string =>
  text
    .split('\n')
    .find((line) => line.startsWith(`${key}: `))
    ?.slice(key.length + 2) ?? assert.fail(`no ${key} in: ${text}`);

const started = (where: Rig): Array<string> => where.calls.filter((call) => call.split(' ').includes('start'));
const flag = (where: Rig): unknown =>
  (JSON.parse(fs.readFileSync(localConfigPath(where.data), 'utf8')) as { watcher: { enabled: unknown } }).watcher
    .enabled;

/** A store over the rig's folder with the real process check, as the commands read it. */
async function storeOf(where: Rig) {
  const { defaultProcessStart } = await lifecycle();
  return { dir: where.dir, now: () => NOW, newRunId: () => 'run-live', processStart: defaultProcessStart };
}

/** This test's own process as the owner of a running inspection. */
async function liveRun(where: Rig) {
  const { claimRun, defaultProcessStart } = await lifecycle();
  const owner = { pid: process.pid, startId: defaultProcessStart(process.pid) ?? 'none' };
  return claimRun(await storeOf(where), { source: 'timer', owner, timeoutMs: 3_600_000 }).run;
}

test('trigger starts the worker without waiting for it and answers the identity of the run', async () => {
  // Bug: a plain `start` on a oneshot blocks the shell for the whole inspection, or the answer names no run to watch.
  const { readRun } = await lifecycle();
  const where = rig();
  const done = await family(where, 'trigger');
  assert.equal(done.status, 'ok', done.text);
  const runId = field(done.text, 'run');
  assert.equal(readRun(await storeOf(where), runId)?.state, 'running');
  assert.equal(readRun(await storeOf(where), runId)?.source, 'manual');
  assert.equal(started(where).length, 1);
  assert.ok(started(where)[0]?.includes(WORKER));
  assert.ok(started(where)[0]?.includes('--no-block'));
});

test('a second trigger during the run answers that run and starts nothing', async () => {
  // Bug: each trigger starts another worker, or answers an error that hides the run in progress.
  const where = rig();
  const first = await family(where, 'trigger');
  const second = await family(where, 'trigger');
  assert.equal(second.status, 'ok', second.text);
  assert.equal(field(second.text, 'run'), field(first.text, 'run'));
  assert.equal(started(where).length, 1);
});

test('trigger during a timer run answers that run and starts nothing', async () => {
  // Bug: the manual path has its own guard, so the manager queues a second start behind the timer's.
  const where = rig();
  const run = await liveRun(where);
  const done = await family(where, 'trigger');
  assert.equal(field(done.text, 'run'), run.runId);
  assert.deepEqual(started(where), []);
});

test('a start the manager refuses fails that run, and the next trigger is free', async () => {
  // Bug: the claim outlives the refused start, and every trigger for an hour answers a run nothing works on.
  const { currentRun, readRun } = await lifecycle();
  const where: Rig = { ...rig(), failOn: 'start' };
  const done = await family(where, 'trigger');
  assert.equal(done.status, 'failed', done.text);
  assert.equal(currentRun(await storeOf(where)), null);
  assert.equal(readRun(await storeOf(where), field(done.text, 'run'))?.state, 'failed');
});

test('a disabled watcher refuses trigger, claims nothing and stays disabled', async () => {
  // Bug: the refusal comes after the claim, so a disabled watcher holds a run nobody started.
  const { currentRun } = await lifecycle();
  const where = rig({ enabled: false, schedule: 'at 06:00' });
  const done = await family(where, 'trigger');
  assert.equal(done.status, 'failed');
  assert.equal(flag(where), false);
  assert.equal(currentRun(await storeOf(where)), null);
  assert.deepEqual(started(where), []);
});

test('cancel with no run says so and succeeds, twice', async () => {
  // Bug: "nothing to cancel" is a failure, so the second of two cancels exits 1 in a script.
  const where = rig();
  for (let i = 0; i < 2; i += 1) {
    const done = await family(where, 'cancel');
    assert.equal(done.status, 'ok', done.text);
    assert.equal(field(done.text, 'run'), 'none');
  }
});

test('cancel asks the run to stop, repeats safely, and leaves the flag and the timer alone', async () => {
  // Bug: cancel disables the service, so the owner stops one run and silently loses all later ones.
  const { readRun } = await lifecycle();
  const where = rig();
  const run = await liveRun(where);
  for (let i = 0; i < 2; i += 1) {
    const done = await family(where, 'cancel');
    assert.equal(done.status, 'ok', done.text);
    assert.equal(field(done.text, 'run'), run.runId);
    assert.equal(field(done.text, 'state'), 'stopping');
  }
  assert.equal(readRun(await storeOf(where), run.runId)?.state, 'stopping');
  assert.equal(flag(where), true);
  assert.deepEqual(where.calls, []);
});

test('disable leaves a running inspection running', async () => {
  // Bug: disable cancels, so switching off future runs throws away the one the owner is waiting for.
  const { readRun } = await lifecycle();
  const where = rig();
  const run = await liveRun(where);
  const done = await family(where, 'disable');
  assert.equal(done.status, 'ok', done.text);
  assert.equal(flag(where), false);
  assert.equal(readRun(await storeOf(where), run.runId)?.state, 'running');
});

test('status with the core down shows the run, the last report and failure, the source, schedule and timeout', async () => {
  // Bug: status knows only the newest file and the manager's word, so a stuck run and its failure are invisible.
  const { claimRun, finishRun } = await lifecycle();
  const where = rig();
  writeKeysFile(where.data, {
    subharness: {
      backends: ['claude'],
      key: null,
      modes: {},
      models: { watcher: 'model-zeta' },
      efforts: { watcher: 'medium' },
      uses: { watcher: 'claude' },
    },
  });
  let made = 0;
  const live = {
    ...(await storeOf(where)),
    processStart: () => 'x',
    newRunId: () => {
      made += 1;
      return `run-${made}`;
    },
  };
  const claim = { source: 'timer', owner: { pid: process.pid, startId: 'x' }, timeoutMs: 1000 } as const;
  const good = claimRun(live, claim).run.runId;
  finishRun(live, good, { state: 'succeeded' });
  const bad = claimRun(live, claim).run.runId;
  finishRun(live, bad, { state: 'failed', code: 'agent-failed', detail: 'exit 3' });
  const current = (await liveRun(where)).runId;
  const done = await family(where, 'status');
  assert.equal(done.status, 'ok', done.text);
  assert.ok(field(done.text, 'current run').includes(current));
  assert.ok(field(done.text, 'current run').includes('running'));
  assert.ok(field(done.text, 'last success').includes(good));
  assert.ok(field(done.text, 'last failure').includes(bad));
  assert.ok(field(done.text, 'last failure').includes('agent-failed'));
  assert.deepEqual(field(done.text, 'source').split(' '), ['claude', 'model-zeta', 'medium']);
  assert.equal(field(done.text, 'schedule'), 'at 06:00');
  assert.match(field(done.text, 'next due'), /^2026-11-05T06:00/);
  assert.match(field(done.text, 'run timeout'), /^[1-9]\d*m$/);
});

test('status with no run and no keys file answers none and unknown', async () => {
  // Bug: a fresh install makes status throw exactly when the owner first looks.
  const where = rig();
  const done = await family(where, 'status');
  assert.equal(done.status, 'ok', done.text);
  assert.equal(field(done.text, 'current run'), 'none');
  assert.equal(field(done.text, 'last failure'), 'none');
  assert.equal(field(done.text, 'source'), 'unknown');
});

test('status, cancel and report issue no model request and spawn no worker, and show no key', async () => {
  // Bug: "selected source" is learned by asking the backend, which spends the account on a read.
  const where = rig();
  writeKeysFile(where.data, {
    extra: { someKey: PLANTED_KEY },
    subharness: { backends: ['opencode'], key: 'someKey', modes: {}, models: {}, uses: { watcher: 'opencode' } },
  });
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = () => {
    fetched += 1;
    return Promise.reject(new Error('no network in a read'));
  };
  try {
    const status = await family(where, 'status');
    await family(where, 'cancel');
    await family(where, 'report');
    assert.equal(fetched, 0);
    assert.deepEqual(started(where), []);
    assert.equal(field(status.text, 'source').split(' ')[0], 'opencode');
    assert.equal(status.text.includes(PLANTED_KEY), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the unit gives a run longer than its timeout, and neither unit calls a retired word or starts itself', async () => {
  // Bug: `TimeoutStartSec=infinity` hides a hung worker from systemd; a shorter value kills an honest run at its limit;
  // an ExecStart on `service watcher trigger` starts the unit from inside itself.
  const { WATCHER_RUN_TIMEOUT_MS } = await lifecycle();
  const service = fs.readFileSync(path.join(REPO, 'deploy', 'neptunia-watcher.service'), 'utf8');
  const timer = fs.readFileSync(path.join(REPO, 'deploy', 'neptunia-watcher.timer'), 'utf8');
  const limit = /^TimeoutStartSec=(\d+)(s|min|h)?$/m.exec(service);
  if (limit === null) assert.fail('TimeoutStartSec is a finite number');
  const scale = { s: 1, min: 60, h: 3600 }[limit[2] ?? 's'] ?? 1;
  assert.ok(Number(limit[1]) * scale * 1000 > WATCHER_RUN_TIMEOUT_MS);
  const starts = service.split('\n').filter((line) => /^Exec/.test(line));
  assert.ok(starts.some((line) => /\bworker watcher$/.test(line)));
  for (const line of starts) assert.doesNotMatch(line, /\bservice watcher\b|\bwatcher run\b/);
  assert.doesNotMatch(service, /^(Restart=(always|on-)|OnFailure=)/m);
  assert.match(timer, /^Unit=neptunia-watcher\.service$/m);
});

test('the real worker writes a report with the board unreachable and marks the filing deferred', async () => {
  // Bug: bin/neptunia.ts opens the board before it starts inspecting, and dies with "the board is not reachable".
  const { readFilings } = await filing();
  const where = rig();
  writeKeysFile(where.data, {
    subharness: { backends: ['claude'], key: null, modes: {}, models: {}, uses: { watcher: 'claude' } },
  });
  const answer = path.join(where.data, 'answer.txt');
  fs.writeFileSync(
    answer,
    answerOf({ Memory: 'MARK-FROM-WORKER' }, [
      { kind: 'fix', finding: 'rail', title: 'Retry rail', evidence: 'src/a.ts:1', done: 'It holds' },
    ])
  );
  const { binary } = subharnessPlace(where.data, 'claude');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(
    binary,
    `#!/bin/sh\nif [ "$1" = --help ]; then echo '  --session-id <uuid>'; exit 0; fi\ncat > /dev/null\ncat ${JSON.stringify(answer)}\n`,
    { mode: 0o755 }
  );
  const home = tempDir('nep-watcher-worker-home-');
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'worker', 'watcher'], {
      cwd: REPO,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: home,
        TMPDIR: process.env.TMPDIR,
        NEPTUNIA_PRIVATE_DIR: where.data,
        NEPTUNIA_DATA_DIR: where.data,
        NEPTUNIA_TASK_CLIENT: 'watcher',
      },
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('the worker did not end in time'));
    }, 6_000);
    child.once('close', (exit) => {
      clearTimeout(timer);
      resolve(exit);
    });
  });
  const names = fs.readdirSync(path.join(where.dir, 'reports')).filter((name) => name.endsWith('.md'));
  assert.equal(names.length, 1, `exit ${code}: no report`);
  assert.ok(fs.readFileSync(path.join(where.dir, 'reports', names[0] ?? ''), 'utf8').includes('MARK-FROM-WORKER'));
  const { lastRuns } = await lifecycle();
  const last = lastRuns(await storeOf(where)).lastSuccess;
  assert.equal(readFilings(where.dir, last?.runId ?? '')[0]?.state, 'deferred');
  const { readSessionMap } = await import('../src/subharness/sessions.ts');
  const [session] = readSessionMap(where.data);
  assert.equal(session?.agent, 'watcher');
  assert.equal(session?.runId, last?.runId);
});
