// One retry of a refused answer (src/watcher/inspection.ts): the answer is kept privately, the agent is asked once more on
// the same run with the refusal's code and detail and the answer before, and a second refusal fails the run with the last
// good view kept. Cancel and the run timeout hold across both attempts, and filing waits for an answer that passes. The
// agent and the board are fakes and the clock is injected; one test runs the real worker over a stand-in binary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.ts';
import { localConfigPath } from '../src/config/files.ts';
import { serviceFamily } from '../src/service/commands.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import { readFilings } from '../src/watcher/filing.ts';
import { runInspection } from '../src/watcher/inspection.ts';
import type { InspectionAgentResult, InspectionDeps } from '../src/watcher/inspection.ts';
import { defaultProcessStart, lastRuns, readRun, requestCancel } from '../src/watcher/lifecycle.ts';
import { readReport, reportVersions } from '../src/watcher/read.ts';
import { checkTemplate } from '../src/watcher/report.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';
import {
  DAY,
  MINUTE,
  SELF,
  aborted,
  allTextUnder,
  answerOf,
  inspectionDeps,
  inspectionRig,
  said,
  templateOf,
} from './fixtures/watcher-inspection-rig.ts';
import type { InspectionRig } from './fixtures/watcher-inspection-rig.ts';
import { PLANTED_KEY, tasksBlock } from './fixtures/watcher-rig.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const RETRY_WORDS = 'RETRY-SENTINEL: answer again in the template.';
const REFUSED = `${templateOf({ bodies: { Memory: 'MARK-REFUSED' } })}\nOne more thought.\n`;
const GOOD = answerOf({ Memory: 'MARK-GOOD' });
const DRAFT = { kind: 'fix', finding: 'rail', title: 'Retry rail', evidence: 'src/a.ts:1', done: 'It holds' };

type Asked = { brief: string; timeoutMs: number; runId: string };

/** Deps whose agent gives `answers` in turn and records what each attempt was asked, with the retry prompt on disk. */
function scripted(
  rig: InspectionRig,
  answers: ReadonlyArray<InspectionAgentResult>,
  overrides: Partial<InspectionDeps> = {}
): { deps: InspectionDeps; asked: Array<Asked> } {
  const retry = path.join(rig.dir, 'retry.md');
  fs.writeFileSync(retry, RETRY_WORDS);
  const asked: Array<Asked> = [];
  const deps = inspectionDeps(rig, {
    retryPromptFiles: [retry],
    runAgent: (brief, options) => {
      asked.push({ brief, timeoutMs: options.timeoutMs, runId: options.runId });
      return Promise.resolve(answers[Math.min(asked.length - 1, answers.length - 1)] ?? said(''));
    },
    ...overrides,
  });
  return { deps, asked };
}

const refusedFile = (rig: InspectionRig, runId: string, attempt: number): string =>
  path.join(rig.reportsDir, 'refused', `${runId}-${attempt}.md`);

test('a refused answer gets one more attempt on the same run, and the good one is the report', async () => {
  // Bug: the second real inspection failed on one slip in one line, a whole day's report and five minutes of model lost.
  const rig = inspectionRig();
  const { deps, asked } = scripted(rig, [said(REFUSED), said(GOOD)]);
  const result = await runInspection(deps);
  assert.equal(result.state, 'succeeded', result.code ?? '');
  assert.equal(asked.length, 2);
  assert.equal(asked[1]?.runId, asked[0]?.runId);
  assert.equal(result.runId, asked[0]?.runId);
  assert.equal(readRun(rig.store, result.runId)?.attempts, 2);
  const day = readReport(rig.reportsDir, DAY);
  assert.ok(day.ok && day.report.text.includes('MARK-GOOD'));
  assert.equal(day.ok && day.report.text.includes('MARK-REFUSED'), false);
  assert.deepEqual(
    reportVersions(rig.reportsDir, DAY).map((one) => one.runId),
    [result.runId]
  );
});

test('the second attempt reads the brief, the retry prompt, the code and detail, and the answer before', async () => {
  // Bug: the agent is asked the same thing again, knows nothing of what was wrong, and repeats it.
  const rig = inspectionRig();
  const { deps, asked } = scripted(rig, [said(REFUSED), said(GOOD)]);
  await runInspection(deps);
  const refusal = checkTemplate(REFUSED);
  assert.ok(!refusal.ok);
  const second = asked[1]?.brief ?? '';
  assert.ok(second.includes(asked[0]?.brief.trim() ?? 'missing'), 'the first brief is in it whole');
  assert.ok(second.includes(RETRY_WORDS));
  assert.ok(second.includes(refusal.code));
  assert.ok(second.includes(refusal.detail));
  assert.ok(second.includes('MARK-REFUSED'));
  assert.equal(asked[0]?.brief.includes(RETRY_WORDS), false);
});

test('a refused answer is kept privately under its run and attempt, whole, and the report readers do not see it', async () => {
  // Bug: the refused text is lost, so nobody can tell why a day failed, or other users read it, or it passes for a report.
  const rig = inspectionRig();
  const { deps } = scripted(rig, [said(REFUSED), said(GOOD)]);
  const { runId } = await runInspection(deps);
  const file = refusedFile(rig, runId, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), REFUSED);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(refusedFile(rig, runId, 2)), false, 'an answer that passed is not kept as refused');
  assert.deepEqual(
    reportVersions(rig.reportsDir).map((one) => one.runId),
    [runId]
  );
});

test('a first answer that passes runs once and counts one attempt', async () => {
  // Bug: every run is asked twice, or the count starts at zero and status says something else.
  const rig = inspectionRig();
  const { deps, asked } = scripted(rig, [said(GOOD)]);
  const { runId } = await runInspection(deps);
  assert.equal(asked.length, 1);
  assert.equal(readRun(rig.store, runId)?.attempts, 1);
  assert.equal(fs.existsSync(path.join(rig.reportsDir, 'refused')), false);
});

test('a second refusal ends the run failed with its own code, keeps both answers and the last good view', async () => {
  // Bug: the first code is reported for the answer that really ended the run, or a third attempt spends another five minutes.
  const rig = inspectionRig();
  const kept = await runInspection(inspectionDeps(rig, { runAgent: () => Promise.resolve(said(GOOD)) }));
  rig.clock.t += MINUTE;
  const other = templateOf({ title: '# Report' });
  const { deps, asked } = scripted(rig, [said(REFUSED), said(other)]);
  const result = await runInspection(deps);
  assert.equal(asked.length, 2);
  assert.equal(result.state, 'failed');
  assert.equal(result.code, 'bad-title');
  assert.equal(readRun(rig.store, result.runId)?.attempts, 2);
  assert.equal(lastRuns(rig.store).lastFailure?.runId, result.runId);
  assert.equal(lastRuns(rig.store).lastSuccess?.runId, kept.runId);
  assert.equal(fs.readFileSync(refusedFile(rig, result.runId, 1), 'utf8'), REFUSED);
  assert.equal(fs.readFileSync(refusedFile(rig, result.runId, 2), 'utf8'), other);
  const day = readReport(rig.reportsDir, DAY);
  assert.ok(day.ok && day.report.text.includes('MARK-GOOD'));
});

for (const [name, answer] of [
  ['that ended with an exit code', { ok: false, text: '', exitCode: 3 }],
  ['that hit the timeout', { ok: false, text: '', exitCode: null, error: 'timeout' }],
] as const) {
  test(`an agent ${name} is no refusal and gets no second attempt`, async () => {
    // Bug: a backend that is down is asked twice, or a run past its timeout starts again.
    const rig = inspectionRig();
    const { deps, asked } = scripted(rig, [answer, said(GOOD)]);
    const result = await runInspection(deps);
    assert.equal(asked.length, 1);
    assert.equal(result.state, 'failed');
    assert.equal(readRun(rig.store, result.runId)?.attempts, 1);
  });
}

test('a tasks block the check refuses gets its retry too', async () => {
  // Bug: only the template earns a retry, and one bad draft still costs the day.
  const rig = inspectionRig();
  const { deps, asked } = scripted(rig, [said(`${templateOf()}\`\`\`tasks\nnot json\n\`\`\`\n`), said(GOOD)]);
  const result = await runInspection(deps);
  assert.equal(asked.length, 2);
  assert.equal(result.state, 'succeeded', result.code ?? '');
});

test('a credential in a refused answer reaches neither the file nor the second brief', async () => {
  // Bug: the private copy and the "answer before" carry the key the check exists to stop, to disk and back to the model.
  const rig = inspectionRig();
  const leak = answerOf({ 'The server': `journal line: ${PLANTED_KEY}` });
  const { deps, asked } = scripted(rig, [said(leak), said(leak)]);
  const result = await runInspection(deps);
  assert.equal(result.state, 'failed');
  assert.equal(result.code, 'secret');
  assert.equal(asked.length, 2);
  assert.equal(asked[1]?.brief.includes(PLANTED_KEY), false);
  assert.equal(allTextUnder(rig.dir).includes(PLANTED_KEY), false);
});

test('filing waits for an answer that passes, and only its drafts file', async () => {
  // Bug: the refused answer's drafts reach the board before the check of the retry, and the task outlives its report.
  const rig = inspectionRig();
  const refused = { ...DRAFT, finding: 'gone', title: 'A draft of the refused answer' };
  const first = `${templateOf({
    bodies: { Errors: { 'Observed defects': '- [high] gone: failed in src/z.ts:9' } },
  })}\nMore.\n${tasksBlock([refused])}`;
  const { deps } = scripted(rig, [said(first), said(answerOf({}, [DRAFT]))]);
  const { runId, state } = await runInspection(deps);
  assert.equal(state, 'succeeded');
  assert.deepEqual(
    rig.fake.adds.map((one) => one.title),
    [DRAFT.title]
  );
  assert.deepEqual(
    readFilings(rig.dir, runId).map((one) => one.finding),
    ['rail']
  );
});

test('a second refusal files nothing', async () => {
  // Bug: drafts of an answer that never passed are filed for a run that saved no report.
  const rig = inspectionRig();
  const bad = `${templateOf()}\nMore.\n${tasksBlock([DRAFT])}`;
  const { deps } = scripted(rig, [said(bad), said(bad)]);
  const { runId } = await runInspection(deps);
  assert.equal(readRun(rig.store, runId)?.attempts, 2);
  assert.equal(rig.fake.adds.length, 0);
  assert.deepEqual(readFilings(rig.dir, runId), []);
});

test('cancel during the second attempt reaches its signal and the run ends cancelled', async () => {
  // Bug: the abort controller belongs to the first attempt, and the retry runs on past the owner's cancel.
  const rig = inspectionRig();
  const { deps } = scripted(rig, [said(REFUSED)]);
  let attempt = 0;
  const result = await runInspection({
    ...deps,
    runAgent: async (_brief, options) => {
      attempt += 1;
      if (attempt === 1) return said(REFUSED);
      requestCancel(rig.store);
      await aborted(options.signal);
      return { ok: false, text: '', exitCode: null, error: 'cancelled' };
    },
  });
  assert.equal(attempt, 2);
  assert.equal(result.state, 'cancelled');
  assert.equal(readReport(rig.reportsDir, DAY).ok, false);
});

test('a cancel that lands with the refused answer starts no second attempt', async () => {
  // Bug: the retry starts anyway, because the check happens only inside the agent run.
  const rig = inspectionRig();
  const { deps } = scripted(rig, [said(REFUSED)]);
  let attempt = 0;
  const result = await runInspection({
    ...deps,
    runAgent: () => {
      attempt += 1;
      requestCancel(rig.store);
      return Promise.resolve(said(REFUSED));
    },
  });
  assert.equal(attempt, 1);
  assert.equal(result.state, 'cancelled');
  assert.equal(readRun(rig.store, result.runId)?.attempts, 1);
});

test('the run timeout covers both attempts: the second gets what is left', async () => {
  // Bug: each attempt gets the whole hour, and one run holds its claim for two.
  const rig = inspectionRig();
  const seen: Array<number> = [];
  const { deps } = scripted(rig, [said(REFUSED)]);
  let attempt = 0;
  await runInspection({
    ...deps,
    timeoutMs: 60 * MINUTE,
    runAgent: (_brief, options) => {
      attempt += 1;
      seen.push(options.timeoutMs);
      rig.clock.t += 40 * MINUTE;
      return Promise.resolve(said(attempt === 1 ? REFUSED : GOOD));
    },
  });
  assert.deepEqual(seen, [60 * MINUTE, 20 * MINUTE]);
});

test('with no time left the refused answer starts no second attempt, and the run fails on its timeout', async () => {
  // Bug: a run that used its whole budget starts another agent with a timeout of zero or less.
  const rig = inspectionRig();
  const { deps, asked } = scripted(rig, [said(REFUSED)], { timeoutMs: 60 * MINUTE });
  const result = await runInspection({
    ...deps,
    runAgent: (brief, options) => {
      rig.clock.t += 60 * MINUTE;
      return deps.runAgent(brief, options);
    },
  });
  assert.equal(asked.length, 1);
  assert.equal(result.state, 'failed');
  assert.equal(result.code, 'timeout');
  assert.equal(fs.readFileSync(refusedFile(rig, result.runId, 1), 'utf8'), REFUSED);
});

test('a retry prompt that cannot be read fails the run with the refusal itself', async () => {
  // Bug: a missing prompt file turns into a crash that hides what the agent got wrong.
  const rig = inspectionRig();
  const { deps, asked } = scripted(rig, [said(REFUSED), said(GOOD)], {
    retryPromptFiles: [path.join(rig.dir, 'gone.md')],
  });
  const result = await runInspection(deps);
  assert.equal(asked.length, 1);
  assert.equal(result.state, 'failed');
  assert.equal(result.code, 'trailing-content');
  assert.equal(fs.readFileSync(refusedFile(rig, result.runId, 1), 'utf8'), REFUSED);
});

// ---- status ----------------------------------------------------------------------------------------------------------

function serviceRig() {
  const data = tempDir('nep-retry-service-');
  fs.mkdirSync(path.dirname(localConfigPath(data)), { recursive: true });
  fs.writeFileSync(localConfigPath(data), JSON.stringify({ watcher: { enabled: true, schedule: 'at 06:00' } }));
  const dir = path.join(data, 'agents', 'watcher');
  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompt.md'), 'PROMPT-SENTINEL');
  return { data, dir };
}

const statusOf = async (data: string): Promise<string> =>
  (
    await serviceFamily(
      {
        rootDir: REPO,
        privateDir: data,
        dataDir: data,
        config: () => readConfig(REPO, { privateDir: data }),
        now: () => Date.parse(`${DAY}T07:00:00Z`),
        env: { NEPTUNIA_UNIT_SCOPE: 'user', XDG_CONFIG_HOME: data },
        coreUp: false,
        run: () => Promise.resolve({ code: 1, stdout: '', stderr: 'unavailable here' }),
      },
      'service.watcher.status',
      {}
    )
  ).text;

const rowOf = (text: string, key: string): string | undefined =>
  text
    .split('\n')
    .find((line) => line.startsWith(`${key}: `))
    ?.slice(key.length + 2);

test('status shows the attempts of the latest run, and none before any', async () => {
  // Bug: a report that took two answers looks like a first-try success, and the template slips stay unseen.
  const { data, dir } = serviceRig();
  assert.equal(rowOf(await statusOf(data), 'attempts'), 'none');
  const rig = inspectionRig();
  const retry = path.join(dir, 'retry.md');
  fs.writeFileSync(retry, RETRY_WORDS);
  let attempt = 0;
  await runInspection(
    inspectionDeps(rig, {
      store: { dir, now: rig.store.now, newRunId: () => 'run-1', processStart: () => SELF.startId },
      reportsDir: path.join(dir, 'reports'),
      promptFiles: [path.join(dir, 'prompt.md')],
      retryPromptFiles: [retry],
      runAgent: () => {
        attempt += 1;
        return Promise.resolve(said(attempt === 1 ? REFUSED : GOOD));
      },
    })
  );
  assert.equal(rowOf(await statusOf(data), 'attempts'), '2');
});

test('the attempt count is on the record while the second attempt runs', async () => {
  // Bug: the count is written at the end, so a crash in the retry reads as one attempt.
  const rig = inspectionRig();
  const { deps } = scripted(rig, [said(REFUSED)]);
  const during: Array<number | undefined> = [];
  let attempt = 0;
  await runInspection({
    ...deps,
    runAgent: (_brief, options) => {
      attempt += 1;
      during.push(readRun(rig.store, options.runId)?.attempts);
      return Promise.resolve(said(attempt === 1 ? REFUSED : GOOD));
    },
  });
  assert.deepEqual(during, [1, 2]);
});

// ---- the worker ------------------------------------------------------------------------------------------------------

test('the real worker retries with the tracked retry prompt, and its text is in that file and not in src', async () => {
  // Bug: the prompt text lives in code, against the contract, or the worker never hands the file to the inspection.
  const tracked = fs.readFileSync(path.join(REPO, 'agents', 'watcher', 'retry.md'), 'utf8');
  const sentinel = tracked.split('\n').find((line) => line.trim() !== '') ?? assert.fail('retry.md is empty');
  const { data, dir } = serviceRig();
  writeKeysFile(data, {
    subharness: { backends: ['claude'], key: null, modes: {}, models: {}, uses: { watcher: 'claude' } },
  });
  const scratch = tempDir('nep-retry-worker-');
  fs.writeFileSync(path.join(scratch, 'answer-1'), REFUSED);
  fs.writeFileSync(path.join(scratch, 'answer-2'), GOOD);
  const { binary } = subharnessPlace(data, 'claude');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(
    binary,
    `#!/bin/sh
if [ "$1" = --help ]; then exit 0; fi
if [ -e ${scratch}/ran ]; then n=2; else n=1; touch ${scratch}/ran; fi
cat > ${scratch}/brief-$n
cat ${scratch}/answer-$n
`,
    { mode: 0o755 }
  );
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO, 'bin', 'neptunia.ts'), 'worker', 'watcher'], {
      cwd: REPO,
      env: {
        PATH: `${process.env.PATH ?? ''}`,
        HOME: tempDir('nep-retry-home-'),
        TMPDIR: process.env.TMPDIR,
        NEPTUNIA_PRIVATE_DIR: data,
        NEPTUNIA_DATA_DIR: data,
        NEPTUNIA_TASK_CLIENT: 'watcher',
      },
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('the worker did not end in time'));
    }, 8_000);
    child.once('close', (exit) => {
      clearTimeout(timer);
      resolve(exit);
    });
  });
  assert.equal(fs.existsSync(path.join(scratch, 'brief-2')), true, `exit ${code}: no second attempt`);
  assert.ok(fs.readFileSync(path.join(scratch, 'brief-2'), 'utf8').includes(sentinel));
  const store = { dir, now: Date.now, newRunId: () => '', processStart: defaultProcessStart };
  assert.equal(lastRuns(store).lastSuccess?.attempts, 2);
});
