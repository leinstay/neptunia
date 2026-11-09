// The watcher's durable run (src/watcher/lifecycle.ts) and one inspection under it (src/watcher/inspection.ts): one
// atomic claim for manual and timer starts, recovery of a stale claim, the five states, and cancellation at each
// phase. The clock and the table of live processes are injected. Two tests use real processes: racing claims across
// processes, and one cancellation down a real process group.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createBackend } from '../src/agent-runner/backend.ts';
import { readReport } from '../src/watcher/read.ts';
import * as reads from '../src/watcher/read.ts';
import { STUB, alive } from './fixtures/backend-rig.ts';
import { tempDir } from './fixtures/tmp.ts';
import {
  DAY,
  MINUTE,
  SELF,
  aborted,
  answerOf,
  inspectionDeps,
  inspectionRig,
  said,
} from './fixtures/watcher-inspection-rig.ts';

const lifecycle = () => import('../src/watcher/lifecycle.ts');
const inspection = () => import('../src/watcher/inspection.ts');

const CLAIM = { source: 'timer', owner: SELF, timeoutMs: 60 * MINUTE } as const;

// ---- the claim ------------------------------------------------------------------------------------------------------

test('a first start claims a run that a new reader finds by its identity, in state running', async () => {
  // Bug: the run lives in the process's memory, so status and cancel in another process see nothing.
  const { claimRun, readRun, currentRun } = await lifecycle();
  const { store } = inspectionRig();
  const claim = claimRun(store, CLAIM);
  assert.equal(claim.claimed, true);
  assert.equal(claim.run.state, 'running');
  assert.equal(readRun({ ...store }, claim.run.runId)?.state, 'running');
  assert.equal(currentRun({ ...store })?.runId, claim.run.runId);
});

test('a start during an active run answers that run, whichever way either came', async () => {
  // Bug: the manual path and the timer path keep separate claims, so a trigger races the midnight run.
  const { claimRun } = await lifecycle();
  const { store } = inspectionRig();
  const first = claimRun(store, { ...CLAIM, source: 'manual' });
  const second = claimRun(store, { ...CLAIM, source: 'timer' });
  assert.equal(second.claimed, false);
  assert.equal(second.run.runId, first.run.runId);
  assert.equal(second.run.source, 'manual');
});

test('racing processes get one claim between them', async () => {
  // Bug: the claim reads, then writes, so two workers started in the same second both inspect and both spend.
  await lifecycle();
  const { dir } = inspectionRig();
  const url = new URL('../src/watcher/lifecycle.ts', import.meta.url).href;
  const at = Date.now() + 500;
  const script = `
    const { claimRun, defaultProcessStart } = await import(${JSON.stringify(url)});
    const store = { dir: ${JSON.stringify(dir)}, now: Date.now, newRunId: () => 'run-' + process.pid, processStart: defaultProcessStart };
    await new Promise((done) => setTimeout(done, ${at} - Date.now()));
    const owner = { pid: process.pid, startId: defaultProcessStart(process.pid) };
    const claim = claimRun(store, { source: 'timer', owner, timeoutMs: 600000 });
    console.log(JSON.stringify({ claimed: claim.claimed, runId: claim.run.runId }));
    process.stdin.resume();
    process.stdin.on('end', () => process.exit(0));`;
  const children = Array.from({ length: 5 }, () =>
    spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'inherit'] })
  );
  try {
    const answers = await Promise.all(
      children.map(
        (child) =>
          new Promise<{ claimed: boolean; runId: string }>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('a claim did not answer')), 4_000);
            child.stdout.once('data', (chunk: Buffer) => {
              clearTimeout(timer);
              resolve(JSON.parse(chunk.toString()) as { claimed: boolean; runId: string });
            });
          })
      )
    );
    assert.equal(answers.filter((answer) => answer.claimed).length, 1);
    assert.equal(new Set(answers.map((answer) => answer.runId)).size, 1);
  } finally {
    for (const child of children) child.stdin.end();
  }
});

test('a claim whose owner died is recovered as failed and the next start gets a new run', async () => {
  // Bug: a worker killed in a power cut leaves `running` for ever, and no inspection runs again.
  const { claimRun, readRun } = await lifecycle();
  const rig = inspectionRig();
  const dead = claimRun(rig.store, CLAIM);
  rig.alive.delete(SELF.pid);
  const next = claimRun(rig.store, { ...CLAIM, owner: { pid: 7, startId: 'boot-b' } });
  assert.equal(next.claimed, true);
  assert.notEqual(next.run.runId, dead.run.runId);
  assert.equal(readRun(rig.store, dead.run.runId)?.state, 'failed');
});

test('a reused pid is an unrelated process: the claim is stale and that process stays alive', async () => {
  // Bug: recovery or cancel signals the recorded pid, which now belongs to somebody else's process.
  const { claimRun, currentRun, defaultProcessStart, requestCancel, readRun } = await lifecycle();
  const rig = inspectionRig();
  const unrelated = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    const pid = unrelated.pid ?? assert.fail('no sleep');
    const store = { ...rig.store, processStart: defaultProcessStart };
    const { run } = claimRun(store, { ...CLAIM, owner: { pid, startId: 'an-earlier-process' } });
    assert.equal(requestCancel(store), null);
    assert.equal(currentRun(store), null);
    assert.equal(readRun(store, run.runId)?.state, 'failed');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(alive(pid), true);
    assert.equal(unrelated.exitCode, null);
  } finally {
    unrelated.kill('SIGKILL');
  }
});

test('a live owner keeps its claim, however long it has been running within its timeout', async () => {
  // Bug: recovery goes by age alone and takes the claim away from a long honest inspection.
  const { claimRun } = await lifecycle();
  const rig = inspectionRig();
  const first = claimRun(rig.store, CLAIM);
  rig.clock.t += 59 * MINUTE;
  assert.equal(claimRun(rig.store, CLAIM).run.runId, first.run.runId);
});

test('a claim with no owner yet is adopted by the worker that starts, keeping its identity', async () => {
  // Bug: `trigger` answers one run id and the worker it started works under another, so the owner watches the wrong run.
  const { claimRun } = await lifecycle();
  const { store } = inspectionRig();
  const pending = claimRun(store, { source: 'manual', owner: null, timeoutMs: 60 * MINUTE });
  const adopted = claimRun(store, CLAIM);
  assert.equal(adopted.claimed, true);
  assert.equal(adopted.run.runId, pending.run.runId);
  assert.deepEqual(adopted.run.owner, SELF);
  assert.equal(adopted.run.source, 'manual');
});

test('a claim whose worker never came is stale past its timeout', async () => {
  // Bug: a start the manager lost holds the claim for ever, and every later trigger answers a run nothing works on.
  const { claimRun, readRun } = await lifecycle();
  const rig = inspectionRig();
  const pending = claimRun(rig.store, { source: 'manual', owner: null, timeoutMs: 60 * MINUTE });
  rig.clock.t += 60 * MINUTE + 1;
  const next = claimRun(rig.store, CLAIM);
  assert.notEqual(next.run.runId, pending.run.runId);
  assert.equal(readRun(rig.store, pending.run.runId)?.state, 'failed');
});

test('cancel with nothing active answers null, and a repeated cancel stays stopping', async () => {
  // Bug: a second cancel throws, flips the state back, or a cancel with no run writes a run.
  const { claimRun, currentRun, requestCancel } = await lifecycle();
  const { store } = inspectionRig();
  assert.equal(requestCancel(store), null);
  assert.equal(currentRun(store), null);
  const { run } = claimRun(store, CLAIM);
  assert.equal(requestCancel(store)?.state, 'stopping');
  const again = requestCancel(store);
  assert.equal(again?.state, 'stopping');
  assert.equal(again?.runId, run.runId);
});

test('a finished state is final', async () => {
  // Bug: a late cancel or a second finish rewrites `succeeded`, so a saved report reads as a cancelled run.
  const { claimRun, finishRun, readRun, requestCancel } = await lifecycle();
  const { store } = inspectionRig();
  const { run } = claimRun(store, CLAIM);
  finishRun(store, run.runId, { state: 'succeeded' });
  assert.equal(requestCancel(store), null);
  finishRun(store, run.runId, { state: 'cancelled' });
  assert.equal(readRun(store, run.runId)?.state, 'succeeded');
});

// ---- one inspection ----------------------------------------------------------------------------------------------

test('two starts at once run the agent once and both answer the same identity', async () => {
  // Bug: the second start waits and runs again, or spawns a second agent beside the first.
  const { runInspection } = await inspection();
  const rig = inspectionRig();
  let asked = 0;
  const runAgent = () => {
    asked += 1;
    return Promise.resolve(said(answerOf()));
  };
  const [one, two] = await Promise.all([
    runInspection(inspectionDeps(rig, { runAgent, source: 'manual' })),
    runInspection(inspectionDeps(rig, { runAgent, source: 'timer' })),
  ]);
  assert.equal(asked, 1);
  assert.equal(one.runId, two.runId);
  assert.deepEqual([one.started, two.started].sort(), [false, true]);
});

test('a good answer ends as succeeded, with a report under the run identity', async () => {
  // Bug: the state stays `running` after the report, so the next start answers a finished run.
  const { runInspection } = await inspection();
  const { readRun, currentRun } = await lifecycle();
  const rig = inspectionRig();
  const result = await runInspection(inspectionDeps(rig));
  assert.equal(result.state, 'succeeded');
  assert.equal(readRun(rig.store, result.runId)?.state, 'succeeded');
  assert.equal(currentRun(rig.store), null);
  const read = readReport(rig.reportsDir, DAY);
  assert.equal(read.ok && read.report.runId, result.runId);
});

test('the agent gets the abort signal, the finite timeout and the run identity', async () => {
  // Bug: the runner drops the signal, as bin/neptunia.ts does for its watcher call, and cancel cannot reach the child.
  const { runInspection } = await inspection();
  const rig = inspectionRig();
  const seen: Array<{ signal: boolean; timeoutMs: number; runId: string }> = [];
  const result = await runInspection(
    inspectionDeps(rig, {
      timeoutMs: 7 * MINUTE,
      runAgent: (_brief, options) => {
        seen.push({
          signal: options.signal instanceof AbortSignal,
          timeoutMs: options.timeoutMs,
          runId: options.runId,
        });
        return Promise.resolve(said(answerOf()));
      },
    })
  );
  assert.deepEqual(seen, [{ signal: true, timeoutMs: 7 * MINUTE, runId: result.runId }]);
});

test('an agent that hits the timeout fails the run with that code and leaves no report', async () => {
  // Bug: a timeout reads as cancelled, so the owner believes somebody stopped it.
  const { runInspection } = await inspection();
  const rig = inspectionRig();
  const result = await runInspection(
    inspectionDeps(rig, {
      runAgent: () => Promise.resolve({ ok: false, text: '', exitCode: null, error: 'timeout' }),
    })
  );
  assert.equal(result.state, 'failed');
  assert.equal(result.code, 'timeout');
  assert.equal(reads.reportDays(rig.reportsDir).length, 0);
});

// ---- cancellation ---------------------------------------------------------------------------------------------------

test('cancel kills the owned process group of a real child and keeps the last successful report', async () => {
  // Bug: the signal stops at the backend wrapper, and the grandchild lives on spending the account.
  const { runInspection } = await inspection();
  const { requestCancel, readRun } = await lifecycle();
  const rig = inspectionRig();
  const first = await runInspection(
    inspectionDeps(rig, { runAgent: () => Promise.resolve(said(answerOf({ Memory: 'MARK-KEPT' }))) })
  );
  const cwd = tempDir('nep-inspection-child-');
  const pidFile = path.join(cwd, 'pid');
  const backend = createBackend('claude', { binary: STUB });
  let grandchild = 0;
  try {
    const running = runInspection(
      inspectionDeps(rig, {
        runAgent: (brief, options) =>
          backend.run(brief, {
            cwd,
            timeoutMs: 20_000,
            signal: options.signal,
            env: { FAKE_MODE: 'hang', FAKE_PID_FILE: pidFile },
          }),
      })
    );
    const deadline = Date.now() + 3_000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.equal(requestCancel(rig.store)?.state, 'stopping');
    const result = await running;
    assert.equal(result.state, 'cancelled');
    assert.equal(readRun(rig.store, result.runId)?.state, 'cancelled');
    const gone = Date.now() + 2_000;
    while (alive(grandchild) && Date.now() < gone) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(alive(grandchild), false, 'the grandchild is dead');
    const read = readReport(rig.reportsDir, DAY);
    assert.equal(read.ok && read.report.runId, first.runId);
    assert.ok(read.ok && read.report.text.includes('MARK-KEPT'));
  } finally {
    if (grandchild > 0 && alive(grandchild)) process.kill(grandchild, 'SIGKILL');
  }
});

test('cancel during generation shows stopping, then cancelled, and the partial output is no report', async () => {
  // Bug: the text a killed agent printed passes as the day's report, or the state jumps past `stopping` unseen.
  const { runInspection } = await inspection();
  const { readRun, requestCancel } = await lifecycle();
  const rig = inspectionRig();
  const states: Array<string | undefined> = [];
  const result = await runInspection(
    inspectionDeps(rig, {
      runAgent: async (_brief, options) => {
        requestCancel(rig.store);
        states.push(readRun(rig.store, options.runId)?.state);
        await aborted(options.signal);
        return { ok: false, text: answerOf({ Memory: 'MARK-PARTIAL' }), exitCode: null, error: 'cancelled' };
      },
    })
  );
  assert.deepEqual(states, ['stopping']);
  assert.equal(result.state, 'cancelled');
  assert.equal(reads.reportDays(rig.reportsDir).length, 0);
  assert.equal(reads.reportVersions(rig.reportsDir).length, 0);
});

test('an agent that ends well just after a cancel is still cancelled', async () => {
  // Bug: the exit code wins the race, so a cancel the owner saw accepted ends in a saved report.
  const { runInspection } = await inspection();
  const { requestCancel } = await lifecycle();
  const rig = inspectionRig();
  const result = await runInspection(
    inspectionDeps(rig, {
      runAgent: () => {
        requestCancel(rig.store);
        return Promise.resolve(said(answerOf()));
      },
    })
  );
  assert.equal(result.state, 'cancelled');
  assert.equal(reads.reportDays(rig.reportsDir).length, 0);
});

test('cancel during validation saves nothing', async () => {
  // Bug: the run goes on to the commit once the agent has ended, whatever the cancel said.
  const { runInspection } = await inspection();
  const { requestCancel } = await lifecycle();
  const rig = inspectionRig();
  const result = await runInspection(
    inspectionDeps(rig, {
      runAgent: () => Promise.resolve(said(answerOf())),
      onPhase: (phase) => {
        if (phase === 'validating') requestCancel(rig.store);
      },
    })
  );
  assert.equal(result.state, 'cancelled');
  assert.equal(reads.reportDays(rig.reportsDir).length, 0);
});

test('cancel before the commit is cancelled, with no report', async () => {
  // Bug: the phase just before the write ignores the cancel, the last moment the owner can still stop a report.
  const { runInspection } = await inspection();
  const { requestCancel } = await lifecycle();
  const rig = inspectionRig();
  const result = await runInspection(
    inspectionDeps(rig, {
      onPhase: (phase) => {
        if (phase === 'committing') requestCancel(rig.store);
      },
    })
  );
  assert.equal(result.state, 'cancelled');
  assert.equal(reads.reportDays(rig.reportsDir).length, 0);
  assert.equal(reads.reportVersions(rig.reportsDir).length, 0);
});

test('cancel after the commit answers completion: succeeded, with the report', async () => {
  // Bug: a saved report sits under a run that says cancelled, so the next reader cannot tell what counts.
  const { runInspection } = await inspection();
  const { readRun, requestCancel } = await lifecycle();
  const rig = inspectionRig();
  const result = await runInspection(
    inspectionDeps(rig, {
      onPhase: (phase) => {
        if (phase === 'committed') requestCancel(rig.store);
      },
    })
  );
  assert.equal(result.state, 'succeeded');
  assert.equal(readRun(rig.store, result.runId)?.state, 'succeeded');
  assert.equal(readReport(rig.reportsDir, DAY).ok, true);
});

test('a failed run is the last failure, the successful one stays the last success', async () => {
  // Bug: status reads the newest run for both, so a failure hides the report the owner can still read.
  const { runInspection } = await inspection();
  const { lastRuns } = await lifecycle();
  const rig = inspectionRig();
  const good = await runInspection(inspectionDeps(rig));
  rig.clock.t += MINUTE;
  const bad = await runInspection(
    inspectionDeps(rig, { runAgent: () => Promise.resolve({ ok: false, text: '', exitCode: 3 }) })
  );
  const last = lastRuns(rig.store);
  assert.equal(last.lastSuccess?.runId, good.runId);
  assert.equal(last.lastFailure?.runId, bad.runId);
});
