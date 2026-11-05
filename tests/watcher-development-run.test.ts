// One inspection in development mode, through `runInspection`. The dep `development` carries the mode, the topics of
// `watcher.auditTopics` and the read of the facts. With the mode on the brief holds `<development>` and one
// `<audit-topic>`, the scratch exists, and a finding's draft files only with the command that reproduces it: without one
// it stays a hypothesis. The queue moves once per run that committed its report, and its state lives in the watcher's
// folder. With the mode off, or no dep, no code is touched, nothing of this is in the brief, and the drafts file as ever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localConfigPath } from '../src/config/files.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import type { DevelopmentFacts, DevelopmentMode } from '../src/watcher/development.ts';
import { readFilings } from '../src/watcher/filing.ts';
import { runInspection } from '../src/watcher/inspection.ts';
import type { InspectionDeps } from '../src/watcher/inspection.ts';
import { lastRuns, requestCancel, runStoreOf } from '../src/watcher/lifecycle.ts';
import { readReportRun } from '../src/watcher/read.ts';
import { splitAnswer } from '../src/watcher/tasks.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';
import { FACTS, REFUSING_FLAG, devAnswer, sectionText, subsectionText } from './fixtures/watcher-development-rig.ts';
import { MINUTE, inspectionDeps, inspectionRig, said } from './fixtures/watcher-inspection-rig.ts';
import type { InspectionRig } from './fixtures/watcher-inspection-rig.ts';
import { tasksBlock } from './fixtures/watcher-rig.ts';

const development = () => import('../src/watcher/development.ts');

const REPO = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(REPO, 'bin', 'neptunia.ts');

const FOLDER = '/srv/dev-checkout';
const MODE_ON: DevelopmentMode = { on: true, checkout: FOLDER, repository: 'example/engine', base: 'trunk' };
const TOPICS = ['privacy-of-dm-paths', 'schema-against-code', 'dead-code'];
const COMMAND = `/usr/bin/node --test ${REFUSING_FLAG} tests/a.test.ts`;

type Options = { topics?: ReadonlyArray<string>; facts?: () => Promise<DevelopmentFacts> };

const on = (options: Options = {}): NonNullable<InspectionDeps['development']> => ({
  mode: MODE_ON,
  topics: options.topics ?? TOPICS,
  facts: options.facts ?? (() => Promise.resolve(FACTS)),
});

/** A run over `rig` whose agent answers `answer` and whose brief lands in `briefs`. */
function runDeps(
  rig: InspectionRig,
  briefs: Array<string>,
  answer: string = devAnswer(),
  over: Partial<InspectionDeps> = {}
): InspectionDeps {
  return inspectionDeps(rig, {
    development: on(),
    runAgent: (brief) => {
      briefs.push(brief);
      return Promise.resolve(said(answer));
    },
    ...over,
  });
}

const reportOf = (rig: InspectionRig, runId: string): string => {
  const read = readReportRun(rig.reportsDir, runId);
  assert.ok(read.ok, runId);
  return read.report.text;
};

const topicOf = (brief: string | undefined): string | null =>
  /<audit-topic>(.*?)<\/audit-topic>/.exec(brief ?? '')?.[1] ?? null;

const step = (rig: InspectionRig): void => {
  rig.clock.t += 10 * MINUTE;
};

// ---------- what the agent is given ----------

test('with the mode on the brief names the checkout, the one topic and the test form with its refusal', async () => {
  // Bug: the agent is told about the folder and runs tests in a form of its own, which reaches the real `systemctl`.
  const rig = inspectionRig();
  const briefs: Array<string> = [];
  await runInspection(runDeps(rig, briefs));
  const [brief] = briefs;
  assert.ok(brief?.includes('<development>'));
  assert.ok(brief?.includes(FOLDER));
  assert.ok(brief?.includes(REFUSING_FLAG));
  assert.equal(topicOf(brief), TOPICS[0]);
  assert.equal(brief?.match(/<audit-topic>/g)?.length, 1);
});

for (const [name, dep] of [
  ['no dep', undefined],
  [
    'the mode off',
    { mode: { on: false, why: 'no-checkout' }, topics: TOPICS, facts: () => Promise.reject(new Error('read')) },
  ],
] as ReadonlyArray<readonly [string, InspectionDeps['development']]>) {
  test(`with ${name} the brief holds no development, no topic and no test form`, async () => {
    // The owner's word: without development agents and a dev folder the watcher does not touch code.
    const rig = inspectionRig();
    const briefs: Array<string> = [];
    const done = await runInspection(runDeps(rig, briefs, devAnswer(), { development: dep }));
    assert.equal(done.state, 'succeeded');
    assert.equal(briefs[0]?.includes('<development'), false);
    assert.equal(briefs[0]?.includes('<audit-topic'), false);
    assert.equal(briefs[0]?.includes(REFUSING_FLAG), false);
  });

  test(`with ${name} the report has no section, and the watcher's folder holds no queue and no scratch`, async () => {
    // Bug: an off run reads the facts anyway and leaves state behind, as if development had been set up.
    // Changed by B12.1 of the plan: this test expected the line `not configured`, and the section does not exist.
    const rig = inspectionRig();
    const before = new Set(fs.readdirSync(rig.dir));
    const done = await runInspection(runDeps(rig, [], devAnswer(), { development: dep }));
    assert.equal(done.state, 'succeeded');
    assert.equal(reportOf(rig, done.runId).includes('## Development'), false);
    const made = fs.readdirSync(rig.dir).filter((name) => !before.has(name));
    assert.deepEqual(
      made.filter((name) => /audit|queue|scratch/.test(name)),
      []
    );
  });
}

test('with the mode off a finding the agent wrote under the section neither counts nor files', async () => {
  // Bug: the model invents a code finding with no dev folder, and the stamped section hides that it was counted.
  const rig = inspectionRig();
  const answer =
    devAnswer({ Development: { 'Observed defects': '- [high] made-up: src/a.ts:1 looks wrong' } }) +
    tasksBlock([{ kind: 'fix', finding: 'made-up', title: 'T', evidence: 'src/a.ts:1', done: 'D', command: COMMAND }]);
  const done = await runInspection(runDeps(rig, [], answer, { development: undefined }));
  assert.equal(done.state, 'succeeded');
  assert.match(reportOf(rig, done.runId), /^- New findings: 0, repeats: 0$/m);
  assert.deepEqual(rig.fake.adds, []);
});

test("the scratch exists under the watcher's folder while the agent runs", async () => {
  // Bug: the unit names a writable folder that nobody made, and the first test run dies with ENOENT in its TMPDIR.
  const rig = inspectionRig();
  const { watcherScratch } = await development();
  let there = false;
  await runInspection(
    runDeps(rig, [], devAnswer(), {
      runAgent: () => {
        there = fs.statSync(watcherScratch(rig.dir), { throwIfNoEntry: false })?.isDirectory() === true;
        return Promise.resolve(said(devAnswer()));
      },
    })
  );
  assert.equal(there, true);
  assert.ok(watcherScratch(rig.dir).startsWith(`${rig.dir}${path.sep}`));
});

// ---------- the facts in the report ----------

test('the committed report holds the facts under the section, and the agent was given them', async () => {
  // Bug: the facts are read and never reach the report, or the agent cannot weigh them against the code.
  const rig = inspectionRig();
  const briefs: Array<string> = [];
  const done = await runInspection(runDeps(rig, briefs));
  assert.equal(done.state, 'succeeded');
  const lines = subsectionText(sectionText(reportOf(rig, done.runId), 'Development'), 'Inspected without a finding');
  assert.match(lines, /T-2.*over-budget/);
  assert.ok(briefs[0]?.includes('over-budget'));
});

test('facts that throw leave a committed report that says they could not be read', async () => {
  // Bug: a broken probe of the checkout costs the owner the whole day's report.
  const rig = inspectionRig();
  const development = on({ facts: () => Promise.reject(new Error('EACCES')) });
  const done = await runInspection(runDeps(rig, [], devAnswer(), { development }));
  assert.equal(done.state, 'succeeded');
  const section = sectionText(reportOf(rig, done.runId), 'Development');
  assert.match(subsectionText(section, 'Unavailable checks'), /development facts unavailable/);
});

// ---------- the queue of topics ----------

test('the topic moves on after a run that committed, and comes round after the last', async () => {
  // Bug: the audit stays on its first topic for good, or the queue ends and later runs audit nothing.
  const rig = inspectionRig();
  const briefs: Array<string> = [];
  for (let run = 0; run < 4; run += 1) {
    await runInspection(runDeps(rig, briefs));
    step(rig);
  }
  assert.deepEqual(briefs.map(topicOf), [TOPICS[0], TOPICS[1], TOPICS[2], TOPICS[0]]);
});

test('a failed run leaves the topic where it was', async () => {
  // Bug: a crash skips a topic, and the privacy audit that never ran reads as done.
  const rig = inspectionRig();
  const briefs: Array<string> = [];
  const failing = await runInspection(
    runDeps(rig, briefs, devAnswer(), {
      runAgent: (brief) => {
        briefs.push(brief);
        return Promise.resolve({ ok: false, text: '', exitCode: 1 });
      },
    })
  );
  assert.equal(failing.state, 'failed');
  step(rig);
  await runInspection(runDeps(rig, briefs));
  assert.deepEqual(briefs.map(topicOf), [TOPICS[0], TOPICS[0]]);
});

test('a cancelled run leaves the topic where it was', async () => {
  // Bug: the owner's cancel skips a topic.
  const rig = inspectionRig();
  const briefs: Array<string> = [];
  const cancelled = await runInspection(
    runDeps(rig, briefs, devAnswer(), {
      runAgent: (brief) => {
        briefs.push(brief);
        requestCancel(rig.store);
        return Promise.resolve(said(devAnswer()));
      },
    })
  );
  assert.equal(cancelled.state, 'cancelled');
  step(rig);
  await runInspection(runDeps(rig, briefs));
  assert.deepEqual(briefs.map(topicOf), [TOPICS[0], TOPICS[0]]);
});

/** The prompt of the second attempt, as the worker names it. */
const retryFile = (rig: InspectionRig): Array<string> => {
  const file = path.join(rig.dir, 'retry.md');
  fs.writeFileSync(file, 'RETRY');
  return [file];
};

test('a run whose first answer was refused and whose second passed moves the topic once', async () => {
  // Bug: the queue moves per attempt, so a retried run skips the next topic.
  const rig = inspectionRig();
  const briefs: Array<string> = [];
  const answers = ['no template here', devAnswer()];
  const done = await runInspection(
    runDeps(rig, briefs, devAnswer(), {
      retryPromptFiles: retryFile(rig),
      runAgent: (brief) => {
        briefs.push(brief);
        return Promise.resolve(said(answers.shift() ?? ''));
      },
    })
  );
  assert.equal(done.state, 'succeeded');
  assert.equal(briefs.length, 2);
  assert.equal(topicOf(briefs[1]), TOPICS[0]);
  step(rig);
  const next: Array<string> = [];
  await runInspection(runDeps(rig, next));
  assert.equal(topicOf(next[0]), TOPICS[1]);
});

test('a run refused twice leaves the topic where it was', async () => {
  // Bug: the refused report read as finished work, and the topic is lost with it.
  const rig = inspectionRig();
  const failed = await runInspection(runDeps(rig, [], 'no template here', { retryPromptFiles: retryFile(rig) }));
  assert.equal(failed.state, 'failed');
  step(rig);
  const next: Array<string> = [];
  await runInspection(runDeps(rig, next));
  assert.equal(topicOf(next[0]), TOPICS[0]);
});

test('a second worker that finds the run in progress does not move the topic', async () => {
  // Bug: a timer start during a run answers that run and counts as one more finished run.
  const rig = inspectionRig();
  const during: Array<boolean> = [];
  const briefs: Array<string> = [];
  await runInspection(
    runDeps(rig, briefs, devAnswer(), {
      runAgent: async (brief) => {
        briefs.push(brief);
        during.push((await runInspection(runDeps(rig, []))).started);
        return said(devAnswer());
      },
    })
  );
  assert.deepEqual(during, [false]);
  step(rig);
  await runInspection(runDeps(rig, briefs));
  assert.deepEqual(briefs.map(topicOf), [TOPICS[0], TOPICS[1]]);
});

test("the state of the queue is in the watcher's folder, and a run after a restart of the worker reads it", async () => {
  // Bug: the position lives in memory, so every timer start audits the first topic.
  const rig = inspectionRig();
  const { currentAuditTopic, finishAuditTopic } = await development();
  assert.equal(currentAuditTopic(rig.dir, TOPICS), TOPICS[0]);
  finishAuditTopic(rig.dir, 'run-a', TOPICS);
  assert.equal(currentAuditTopic(rig.dir, TOPICS), TOPICS[1]);
});

test('one run moves the queue once, however often its end is reported', async () => {
  // Bug: recovery reports a committed run's end again, and a topic is skipped.
  const rig = inspectionRig();
  const { currentAuditTopic, finishAuditTopic } = await development();
  finishAuditTopic(rig.dir, 'run-a', TOPICS);
  finishAuditTopic(rig.dir, 'run-a', TOPICS);
  assert.equal(currentAuditTopic(rig.dir, TOPICS), TOPICS[1]);
});

test('a queue state that cannot be read starts at the first topic, and a topic taken out of the settings too', async () => {
  // Bug: a torn state file or an edited list fails the inspection, when an audit is only one part of it.
  const rig = inspectionRig();
  const { currentAuditTopic, finishAuditTopic } = await development();
  finishAuditTopic(rig.dir, 'run-a', TOPICS);
  assert.equal(currentAuditTopic(rig.dir, ['other', 'list']), 'other');
  for (const name of fs.readdirSync(rig.dir)) {
    if (/audit/.test(name)) fs.writeFileSync(path.join(rig.dir, name), '{torn');
  }
  assert.equal(currentAuditTopic(rig.dir, TOPICS), TOPICS[0]);
});

test('with no topics the run has no topic and leaves no state', async () => {
  // Bug: `undefined` lands in the brief as the topic, and the agent audits it.
  const rig = inspectionRig();
  const briefs: Array<string> = [];
  const done = await runInspection(runDeps(rig, briefs, devAnswer(), { development: on({ topics: [] }) }));
  assert.equal(done.state, 'succeeded');
  assert.equal(briefs[0]?.includes('<audit-topic'), false);
  assert.equal(briefs[0]?.includes('<development>'), true);
  assert.deepEqual(
    fs.readdirSync(rig.dir).filter((name) => /audit/.test(name)),
    []
  );
});

// ---------- a finding with no command is a hypothesis ----------

const draft = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'fix',
  finding: 'stale-index',
  title: 'The index goes stale',
  evidence: 'src/memory/db/open.ts:220',
  done: 'The index is rebuilt',
  ...fields,
});

test("the tasks block keeps a draft's `command`, and a blank one counts as none", () => {
  // Bug: the parser drops the field it does not know, and every draft reads as having no command.
  const split = splitAnswer(devAnswer({}, [draft({ command: COMMAND }), draft({ finding: 'b', command: '  ' })]));
  assert.ok(split.ok);
  assert.equal(split.tasks[0]?.command, COMMAND);
  assert.equal(split.tasks[1]?.command, undefined);
});

test('a `command` that is no string is refused with the tasks block', () => {
  // Bug: an array of arguments passes as a command nobody can paste.
  const split = splitAnswer(devAnswer({}, [draft({ command: ['node'] })]));
  assert.equal(split.ok ? 'passed' : split.code, 'bad-tasks');
});

for (const [name, fields] of [
  ['no command', {}],
  ['a blank command', { command: '   ' }],
  ['a test run without the refusal', { command: 'node --test tests/a.test.ts' }],
  ['the whole suite', { command: 'npm test' }],
] as ReadonlyArray<readonly [string, Record<string, unknown>]>) {
  test(`with the mode on a draft with ${name} stays a hypothesis: the board is never asked`, async () => {
    // The owner's word: a finding carries the command that reproduces it, or stays a hypothesis not filed as a task.
    const rig = inspectionRig();
    let opened = 0;
    const done = await runInspection(
      runDeps(rig, [], devAnswer({}, [draft(fields)]), {
        openBoard: () => {
          opened += 1;
          return Promise.resolve(rig.fake.board);
        },
      })
    );
    assert.equal(done.state, 'succeeded');
    assert.equal(done.filing, 'none');
    assert.equal(opened, 0);
    assert.deepEqual(rig.fake.adds, []);
    assert.equal(readFilings(rig.dir, done.runId)[0]?.state, 'hypothesis');
  });
}

test('a hypothesis stays in the report, its finding counted and its filing line named', async () => {
  // Bug: the finding vanishes with its task, so the owner never hears of something worth checking by hand.
  const rig = inspectionRig();
  const done = await runInspection(runDeps(rig, [], devAnswer({}, [draft()])));
  const text = reportOf(rig, done.runId);
  assert.match(text, /^- \[medium\] stale-index: /m);
  assert.match(text, /^- New findings: 1, repeats: 0$/m);
  assert.match(subsectionText(sectionText(text, 'Tasks filed'), 'Observed defects'), /hypothesis.*stale-index/);
});

test("a later run does not file an earlier run's hypothesis", async () => {
  // Bug: the state reads as unsettled, the next inspection retries it, and the rule holds for one day.
  const rig = inspectionRig();
  const first = await runInspection(runDeps(rig, [], devAnswer({}, [draft()])));
  assert.equal(first.state, 'succeeded');
  step(rig);
  const second = await runInspection(runDeps(rig, []));
  assert.equal(second.state, 'succeeded');
  assert.deepEqual(rig.fake.adds, []);
  assert.equal(readFilings(rig.dir, first.runId)[0]?.state, 'hypothesis');
});

test('with the mode on a draft with a command files, and the task carries the command', async () => {
  // Bug: the check passes and the command stays behind, so the implementer of the task cannot reproduce the finding.
  const rig = inspectionRig();
  const done = await runInspection(runDeps(rig, [], devAnswer({}, [draft({ command: COMMAND })])));
  assert.equal(done.filing, 'filed');
  assert.equal(rig.fake.adds.length, 1);
  assert.ok(JSON.stringify(rig.fake.adds[0]).includes(`--test ${REFUSING_FLAG}`));
  assert.equal(readFilings(rig.dir, done.runId)[0]?.state, 'filed');
});

test('one draft with a command and one without file one task', async () => {
  // Bug: the refusal is per answer, and one hypothesis costs the proven finding its task.
  const rig = inspectionRig();
  const done = await runInspection(
    runDeps(rig, [], devAnswer({}, [draft({ command: COMMAND }), draft({ finding: 'other', evidence: 'src/b.ts:2' })]))
  );
  assert.deepEqual(
    readFilings(rig.dir, done.runId).map((one) => one.state),
    ['filed', 'hypothesis']
  );
  assert.equal(rig.fake.adds.length, 1);
});

test('with the mode off a draft with no command files as it always has', async () => {
  // Bug: an install with no development can never file again, since its findings have no code to run a command against.
  const rig = inspectionRig();
  const done = await runInspection(runDeps(rig, [], devAnswer({}, [draft()]), { development: undefined }));
  assert.equal(done.filing, 'filed');
  assert.equal(rig.fake.adds.length, 1);
});

// ---------- the worker ----------

test('the real worker turns the mode on from the settings and hands its agent the development brief', async () => {
  // Bug: every part works and `bin/neptunia-watcher.ts` never passes `development`, so the mode stays off for good.
  const data = tempDir('nep-watcher-dev-worker-');
  const checkout = tempDir('nep-watcher-dev-worker-checkout-');
  fs.mkdirSync(path.dirname(localConfigPath(data)), { recursive: true });
  fs.writeFileSync(
    localConfigPath(data),
    JSON.stringify({
      watcher: { enabled: true, schedule: 'at 06:00', auditTopics: ['dead-code'] },
      selfimprovement: { checkout, repository: 'example/engine' },
    })
  );
  const dir = path.join(data, 'agents', 'watcher');
  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  writeKeysFile(data, {
    subharness: { backends: ['claude'], key: null, modes: {}, models: {}, uses: { watcher: 'claude', dev: 'claude' } },
  });
  const answer = path.join(data, 'answer.txt');
  fs.writeFileSync(answer, devAnswer());
  const seen = path.join(data, 'brief.txt');
  const { binary } = subharnessPlace(data, 'claude');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(
    binary,
    `#!/bin/sh\nif [ "$1" = --help ]; then echo '  --session-id <uuid>'; exit 0; fi\nprintf '%s\\n' "$@" > ${JSON.stringify(seen)}\ncat >> ${JSON.stringify(seen)}\ncat ${JSON.stringify(answer)}\n`,
    { mode: 0o755 }
  );
  // The worker's reads of `gh` and the manager meet these two, whatever the machine has.
  const tools = tempDir('nep-watcher-dev-worker-tools-');
  for (const name of ['gh', 'systemctl', 'sudo']) {
    fs.writeFileSync(path.join(tools, name), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  }
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'worker', 'watcher'], {
      cwd: REPO,
      env: {
        PATH: `${tools}:/usr/bin:/bin`,
        HOME: tempDir('nep-watcher-dev-worker-home-'),
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
    }, 20_000);
    child.once('close', (exit) => {
      clearTimeout(timer);
      resolve(exit);
    });
  });
  assert.equal(code, 0);
  const brief = fs.readFileSync(seen, 'utf8');
  assert.ok(brief.includes('<development>'));
  assert.ok(brief.includes(checkout));
  assert.equal(topicOf(brief), 'dead-code');
  const store = runStoreOf(dir, () => Date.now());
  const runId = lastRuns(store).lastSuccess?.runId ?? '';
  const read = readReportRun(path.join(dir, 'reports'), runId);
  assert.ok(read.ok);
  assert.match(
    subsectionText(sectionText(read.report.text, 'Development'), 'Unavailable checks'),
    /pull requests unavailable/
  );
});
