// The watcher under `/doctor watcher` (src/watcher/doctor.ts): `run` claims one run and has the core start its worker in
// the background, `stop` cancels it, `list` numbers every report from the oldest on and shows the newest first with its
// dates and state, `read` and `<n>` open one report with its dates. The run store, the clock, the table of live processes
// and the starter of the worker are fakes; no process is spawned and no agent is asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { claimRun, finishRun, readRun } from '../src/watcher/lifecycle.ts';
import { runInspection } from '../src/watcher/inspection.ts';
import { watcherList, watcherOpen, watcherRun, watcherStop, workerStarter } from '../src/watcher/doctor.ts';
import { MINUTE, NOW, SELF, answerOf, inspectionDeps, inspectionRig, said } from './fixtures/watcher-inspection-rig.ts';
import type { InspectionRig } from './fixtures/watcher-inspection-rig.ts';

const where = (rig: InspectionRig) => ({ store: rig.store, reportsDir: rig.reportsDir });
const CLAIM = { source: 'manual', owner: SELF, timeoutMs: 60 * MINUTE } as const;

/** One inspection that commits a report saying `mark`, ten minutes long; the clock moves on after it. */
async function reported(rig: InspectionRig, mark: string): Promise<string> {
  const result = await runInspection(
    inspectionDeps(rig, {
      runAgent: () => {
        rig.clock.t += 10 * MINUTE;
        return Promise.resolve(said(answerOf({ Project: mark })));
      },
    })
  );
  assert.equal(result.state, 'succeeded', result.code ?? '');
  rig.clock.t += 50 * MINUTE;
  return result.runId;
}

// ---- run -----------------------------------------------------------------------------------------------------------

test('run claims one run, starts its worker once and answers its number and start time', () => {
  // Bug: the answer comes only when the agent is done, or names no run the owner can open later.
  const rig = inspectionRig();
  const started: Array<string> = [];
  const answer = watcherRun({ ...where(rig), start: (runId) => (started.push(runId), null) });
  assert.equal(answer.status, 'ok');
  assert.equal(started.length, 1);
  assert.match(answer.text, /\breport 1\b/);
  assert.ok(answer.text.includes('2026-11-04 06:00 UTC'), answer.text);
  const run = readRun(rig.store, started[0] ?? '');
  assert.equal(run?.state, 'running');
  assert.equal(run?.owner, null);
});

test('run while a run is going answers that run and starts nothing', () => {
  // Bug: a second run asked during the first starts a second worker and two agents spend the allowance.
  const rig = inspectionRig();
  watcherRun({ ...where(rig), start: () => null });
  rig.clock.t += 5 * MINUTE;
  let starts = 0;
  const again = watcherRun({ ...where(rig), start: () => ((starts += 1), null) });
  assert.equal(again.status, 'ok');
  assert.equal(starts, 0);
  assert.match(again.text, /\breport 1\b/);
  assert.match(again.text, /running/);
  assert.ok(again.text.includes('2026-11-04 06:00 UTC'), again.text);
});

test('a worker that cannot be started fails the run at once with the reason', () => {
  // Bug: the claim waits an hour for a worker that never comes, and every run asked meanwhile answers it.
  const rig = inspectionRig();
  let runId = '';
  const answer = watcherRun({ ...where(rig), start: (id) => ((runId = id), 'ENOENT') });
  assert.equal(answer.status, 'failed');
  assert.ok(answer.text.includes('ENOENT'));
  const run = readRun(rig.store, runId);
  assert.equal(run?.state, 'failed');
  assert.equal(run?.code, 'start-failed');
  assert.equal(watcherRun({ ...where(rig), start: () => null }).status, 'ok', 'the next run is not blocked');
});

test('the starter runs the worker of this install detached, with the data folder and no gh login', () => {
  // Bug: the worker dies with the terminal or the core's request, or a gh inside it finds the owner's login.
  const calls: Array<{ command: string; args: ReadonlyArray<string>; options: Record<string, unknown> }> = [];
  let unrefs = 0;
  const start = workerStarter({
    rootDir: '/install',
    dataDir: '/data',
    env: { PATH: '/usr/bin', GH_TOKEN: 'a-token' },
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { unref: () => (unrefs += 1), on: () => undefined };
    },
  });
  assert.equal(start('run-1'), null);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.deepEqual(call?.args, [path.join('/install', 'bin', 'neptunia.ts'), 'worker', 'watcher']);
  const options = call?.options ?? {};
  assert.equal(options.detached, true);
  assert.equal(options.stdio, 'ignore');
  // The fake records what the starter handed it; the env it builds is a record of strings.
  const env = options.env as Record<string, string>;
  assert.equal(env.NEPTUNIA_DATA_DIR, '/data');
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GH_CONFIG_DIR, path.join('/data', 'agents', 'watcher', 'no-gh-login'));
  assert.equal(unrefs, 1);
});

test('a starter whose spawn throws answers the reason', () => {
  // Bug: a missing node binary throws out of the core's command and the owner sees no answer at all.
  const start = workerStarter({
    rootDir: '/install',
    dataDir: '/data',
    env: {},
    spawn: () => {
      throw Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' });
    },
  });
  assert.equal(start('run-1'), 'ENOENT');
});

// ---- stop ----------------------------------------------------------------------------------------------------------

test('stop asks the running run to stop and names it', () => {
  // Bug: stop answers ok and the record never says stopping, so the worker runs to its end.
  const rig = inspectionRig();
  let runId = '';
  watcherRun({ ...where(rig), start: (id) => ((runId = id), null) });
  const answer = watcherStop(where(rig));
  assert.equal(answer.status, 'ok');
  assert.match(answer.text, /\breport 1\b/);
  assert.equal(readRun(rig.store, runId)?.state, 'stopping');
});

test('stop with nothing running says so and changes nothing', () => {
  // Bug: stop on an idle watcher fails, so a repeated stop reads as an error.
  const rig = inspectionRig();
  const answer = watcherStop(where(rig));
  assert.equal(answer.status, 'ok');
  assert.match(answer.text, /no watcher run/);
});

// ---- list ----------------------------------------------------------------------------------------------------------

test('list shows every run newest first, each with its number, start, finish and state', async () => {
  // Bug: the list holds only the successes, or numbers from the newest so a number changes with every run.
  const rig = inspectionRig();
  await reported(rig, 'MARK-ONE');
  const failed = claimRun(rig.store, CLAIM).run;
  rig.clock.t += 3 * MINUTE;
  finishRun(rig.store, failed.runId, { state: 'failed', code: 'timeout' });
  rig.clock.t += MINUTE;
  watcherRun({ ...where(rig), start: () => null });
  const lines = watcherList(where(rig)).text.split('\n');
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.match(lines[0] ?? '', /^3\b.*running.*2026-11-04 07:04 UTC/);
  assert.match(lines[1] ?? '', /^2\b.*failed.*timeout/);
  assert.ok(lines[1]?.includes('2026-11-04 07:00 UTC') && lines[1].includes('2026-11-04 07:03 UTC'), lines[1]);
  assert.match(lines[2] ?? '', /^1\b.*succeeded/);
  assert.ok(lines[2]?.includes('2026-11-04 06:00 UTC') && lines[2].includes('2026-11-04 06:10 UTC'), lines[2]);
});

test('list keeps a report from before run records, numbered among the others by its day', async () => {
  // Bug: the reports written before the move to doctor disappear from the list, or push every number by one later.
  const rig = inspectionRig();
  fs.writeFileSync(path.join(rig.reportsDir, '2026-11-01.md'), '# Watcher report 2026-11-01\n\nMARK-OLD\n');
  await reported(rig, 'MARK-NEW');
  const lines = watcherList(where(rig)).text.split('\n');
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[0] ?? '', /^2\b.*succeeded/);
  assert.match(lines[1] ?? '', /^1\b.*2026-11-01/);
  assert.ok(watcherOpen(where(rig), 1).text.includes('MARK-OLD'));
});

test('list with no report says so', () => {
  // Bug: an empty list prints nothing, which reads as a hung command.
  const rig = inspectionRig();
  const answer = watcherList(where(rig));
  assert.equal(answer.status, 'ok');
  assert.match(answer.text, /no watcher report/);
});

// ---- read and <n> --------------------------------------------------------------------------------------------------

test('read opens the newest report with its number and dates, past a newer run that failed', async () => {
  // Bug: read opens the newest run, a failed one with no report, or a report with no date the owner can place.
  const rig = inspectionRig();
  await reported(rig, 'MARK-ONE');
  await reported(rig, 'MARK-TWO');
  const failed = claimRun(rig.store, CLAIM).run;
  finishRun(rig.store, failed.runId, { state: 'failed', code: 'agent-failed' });
  const answer = watcherOpen(where(rig), 'latest');
  assert.equal(answer.status, 'ok');
  assert.ok(answer.text.includes('MARK-TWO'));
  assert.equal(answer.text.includes('MARK-ONE'), false);
  const head = answer.text.split('\n').slice(0, 3).join('\n');
  assert.match(head, /\breport 2\b/);
  assert.ok(head.includes('2026-11-04 07:00 UTC') && head.includes('2026-11-04 07:10 UTC'), head);
});

test('a number opens that report of the list', async () => {
  // Bug: the number counts from the newest, and report 1 opens yesterday's report today and today's tomorrow.
  const rig = inspectionRig();
  await reported(rig, 'MARK-ONE');
  await reported(rig, 'MARK-TWO');
  const answer = watcherOpen(where(rig), 1);
  assert.equal(answer.status, 'ok');
  assert.ok(answer.text.includes('MARK-ONE'));
  assert.equal(answer.text.includes('MARK-TWO'), false);
});

test('a number past the list or of a run without a report is refused with the reason', async () => {
  // Bug: a wrong number opens the newest report, and the owner reads the wrong day without knowing it.
  const rig = inspectionRig();
  await reported(rig, 'MARK-ONE');
  const failed = claimRun(rig.store, CLAIM).run;
  finishRun(rig.store, failed.runId, { state: 'failed', code: 'timeout' });
  const past = watcherOpen(where(rig), 5);
  assert.equal(past.status, 'failed');
  assert.match(past.text, /no report 5/);
  const none = watcherOpen(where(rig), 2);
  assert.equal(none.status, 'failed');
  assert.match(none.text, /failed/);
  assert.match(none.text, /timeout/);
});

test('read with no report says so', () => {
  // Bug: an empty watcher folder throws out of the command.
  const rig = inspectionRig(NOW);
  const answer = watcherOpen(where(rig), 'latest');
  assert.equal(answer.status, 'failed');
  assert.match(answer.text, /no watcher report/);
});

// ---- the command table ---------------------------------------------------------------------------------------------

test('the table takes the five forms of /doctor watcher and refuses a word that is no number', () => {
  // Bug: `/doctor watcher 3` reads 3 as a subcommand and is refused, or `/doctor watcher soon` opens report NaN.
  for (const word of ['run', 'stop', 'read', 'list']) {
    const parsed = parseCommandLine(`/doctor watcher ${word}`);
    assert.ok(parsed.ok, word);
    assert.equal(parsed.ok && parsed.name, `doctor.watcher.${word}`);
  }
  const numbered = parseCommandLine('/doctor watcher 3');
  assert.ok(numbered.ok);
  assert.equal(numbered.ok && numbered.name, 'doctor.watcher');
  assert.equal(numbered.ok && numbered.args.number, '3');
  assert.equal(parseCommandLine('/doctor watcher soon').ok, false);
  assert.equal(parseCommandLine('/doctor watcher 0').ok, false);
});

test('run with no starter, as in a terminal with no core, is refused and claims nothing', async () => {
  // Bug: the terminal claims a run no core will ever start, and every run asked for the next hour answers it.
  const { watcherDoctor } = await import('../src/watcher/doctor.ts');
  const rig = inspectionRig();
  const answer = watcherDoctor('doctor.watcher.run', {}, where(rig));
  assert.equal(answer.status, 'failed');
  assert.match(watcherList(where(rig)).text, /no watcher report/);
});
