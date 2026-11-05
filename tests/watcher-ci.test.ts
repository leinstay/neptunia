// The CI summary of the watcher's development mode, `ciFacts` and `ciLines` of src/watcher/ci.ts. The engine lists the runs of
// `main` with `gh run list` and the jobs of each with `gh run view --json jobs`, counts the shards (the jobs of a matrix, named
// `<name> (<n>)`) of this week and of the week before, and names the slowest test files when a log has them. The agent
// judges; the code lists. `gh` is a fake, the clock is injected, every run and job is synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CI_LOGS_MAX, CI_RUNS_PER_WEEK_MAX, ciFacts, ciLines } from '../src/watcher/ci.ts';

const NOW = Date.parse('2026-11-06T00:00:00Z');
const DAY = 86_400_000;
const REPOSITORY = 'example/engine';
const iso = (at: number): string => new Date(at).toISOString();

type Call = { command: string; args: ReadonlyArray<string> };
type Job = { id: number; name: string; seconds: number; conclusion: string };
type Run = { id: number; daysAgo: number; branch?: string; status?: string };

/** The jobs of one run as `gh run view --json jobs` gives them. */
const jobsJson = (jobs: ReadonlyArray<Job>): string =>
  JSON.stringify({
    jobs: jobs.map((one) => ({
      databaseId: one.id,
      name: one.name,
      status: 'completed',
      conclusion: one.conclusion,
      startedAt: iso(NOW - DAY),
      completedAt: iso(NOW - DAY + one.seconds * 1000),
    })),
  });

const job = (name: string, seconds: number, conclusion = 'success', id = seconds): Job => ({
  id,
  name,
  seconds,
  conclusion,
});

/**
 * A fake `gh`: the list answers `runs`, a view answers `jobs[run id]` or fails when the run has none, a log answers
 * `logs[job id]` or fails. Every call is kept.
 */
function fakeGh(
  runs: ReadonlyArray<Run>,
  jobs: Readonly<Record<number, ReadonlyArray<Job>>>,
  logs: Readonly<Record<number, string>> = {}
) {
  const calls: Array<Call> = [];
  const run = (command: string, args: ReadonlyArray<string>): Promise<{ code: number; stdout: string }> => {
    calls.push({ command, args });
    const fail = { code: 1, stdout: '' };
    if (command !== 'gh' || args[0] !== 'run') return Promise.resolve(fail);
    if (args[1] === 'list') {
      const listed = runs.map((one) => ({
        databaseId: one.id,
        headBranch: one.branch ?? 'main',
        status: one.status ?? 'completed',
        conclusion: one.status === undefined || one.status === 'completed' ? 'success' : '',
        createdAt: iso(NOW - one.daysAgo * DAY),
      }));
      return Promise.resolve({ code: 0, stdout: JSON.stringify(listed) });
    }
    if (args[1] === 'view') {
      const id = Number(args[2]);
      if (args.includes('--job')) {
        const jobId = Number(args[args.indexOf('--job') + 1]);
        return Promise.resolve(jobId in logs ? { code: 0, stdout: logs[jobId] ?? '' } : fail);
      }
      return Promise.resolve(id in jobs ? { code: 0, stdout: jobsJson(jobs[id] ?? []) } : fail);
    }
    return Promise.resolve(fail);
  };
  return { run, calls };
}

const viewed = (calls: ReadonlyArray<Call>): Array<number> =>
  calls.filter((one) => one.args[1] === 'view' && !one.args.includes('--job')).map((one) => Number(one.args[2]));

const logsAsked = (calls: ReadonlyArray<Call>): Array<string> =>
  calls.filter((one) => one.args.includes('--log')).map((one) => one.args[one.args.indexOf('--job') + 1] ?? '');

/** Three runs this week and one the week before, with the shard times the tests below count. */
const SCENE = {
  runs: [
    { id: 101, daysAgo: 1 },
    { id: 102, daysAgo: 3 },
    { id: 103, daysAgo: 5 },
    { id: 201, daysAgo: 9 },
  ] satisfies Array<Run>,
  jobs: {
    // 101: a guard job (no shard), shards of 100 s, 250 s (near), 300 s cancelled (the limit) and 30 s cancelled (a person).
    101: [
      job('guard', 10),
      job('tests (1)', 100, 'success', 1011),
      job('tests (2)', 250, 'success', 1012),
      job('tests (3)', 300, 'cancelled', 1013),
      job('tests (4)', 30, 'cancelled', 1014),
      job('test (26.x)', 5),
    ],
    // 102: 240 s exactly is not over four minutes.
    102: [job('tests (1)', 120, 'success', 1021), job('tests (2)', 240, 'success', 1022)],
    103: [],
    201: [job('tests (1)', 100, 'success', 2011), job('tests (2)', 260, 'success', 2012)],
  } satisfies Record<number, Array<Job>>,
};

test('counts the shards of this week and of the week before by their times', async () => {
  // Bug: the report says CI is slow without a number the owner can compare with last week.
  const { run } = fakeGh(SCENE.runs, SCENE.jobs);
  const facts = await ciFacts({ run, repository: REPOSITORY, now: () => NOW });
  assert.ok(facts !== null);
  assert.deepEqual(facts.thisWeek, { runs: 3, shards: 6, nearLimit: 1, cancelledAtLimit: 1, slowestSeconds: 300 });
  assert.deepEqual(facts.weekBefore, { runs: 1, shards: 2, nearLimit: 1, cancelledAtLimit: 0, slowestSeconds: 260 });
});

test('a job that is no shard is not counted, though it is the slowest', async () => {
  // Bug: the lint or types job passes for a shard and the near-limit count reads the wrong jobs.
  const { run } = fakeGh([{ id: 1, daysAgo: 1 }], {
    1: [job('types', 280), job('test (26.x)', 290), job('tests (1)', 60)],
  });
  const facts = await ciFacts({ run, repository: REPOSITORY, now: () => NOW });
  assert.deepEqual(facts?.thisWeek, { runs: 1, shards: 1, nearLimit: 0, cancelledAtLimit: 0, slowestSeconds: 60 });
});

test('a shard cancelled early by a person is no cancellation by the limit', async () => {
  // Bug: every cancelled push reads as the 5-minute limit biting.
  const { run } = fakeGh([{ id: 1, daysAgo: 1 }], { 1: [job('tests (1)', 40, 'cancelled'), job('tests (2)', 100)] });
  const facts = await ciFacts({ run, repository: REPOSITORY, now: () => NOW });
  assert.equal(facts?.thisWeek.cancelledAtLimit, 0);
  assert.equal(facts?.thisWeek.nearLimit, 0);
});

test('asks for main of the configured repository, and only views completed runs of main from the last two weeks', async () => {
  // Bug: a pull request's branch, a run in flight or a month-old run counts as the project's CI.
  const runs: Array<Run> = [
    { id: 1, daysAgo: 1 },
    { id: 2, daysAgo: 1, branch: 'work/T-1' },
    { id: 3, daysAgo: 1, status: 'in_progress' },
    { id: 4, daysAgo: 20 },
  ];
  const { run, calls } = fakeGh(runs, { 1: [job('tests (1)', 50)], 2: [job('tests (1)', 50)], 3: [], 4: [] });
  await ciFacts({ run, repository: REPOSITORY, now: () => NOW });
  const list = calls[0];
  assert.equal(list?.command, 'gh');
  assert.equal(list?.args[list.args.indexOf('--repo') + 1], REPOSITORY);
  assert.equal(list?.args[list.args.indexOf('--branch') + 1], 'main');
  assert.deepEqual(viewed(calls), [1]);
  for (const call of calls) assert.equal(call.args[call.args.indexOf('--repo') + 1], REPOSITORY);
});

test('views at most the newest runs of a week', async () => {
  // Bug: a busy week costs a `gh` call per run and the watcher's turn is spent on the API.
  const runs: Array<Run> = Array.from({ length: CI_RUNS_PER_WEEK_MAX + 3 }, (_one, at) => ({
    id: 500 + at,
    daysAgo: 1 + at * 0.1,
  }));
  const jobs = Object.fromEntries(runs.map((one) => [one.id, [job('tests (1)', 50)]]));
  const { run, calls } = fakeGh(runs, jobs);
  const facts = await ciFacts({ run, repository: REPOSITORY, now: () => NOW });
  assert.deepEqual(
    viewed(calls),
    runs.slice(0, CI_RUNS_PER_WEEK_MAX).map((one) => one.id)
  );
  assert.equal(facts?.thisWeek.runs, CI_RUNS_PER_WEEK_MAX);
});

test('a run whose jobs cannot be read is counted apart, not as a fast week', async () => {
  // Bug: a rate-limited `gh view` leaves a week with no shards, and no shards reads as nothing near the limit.
  const { run } = fakeGh(
    [
      { id: 1, daysAgo: 1 },
      { id: 2, daysAgo: 2 },
    ],
    { 1: [job('tests (1)', 260)] }
  );
  const facts = await ciFacts({ run, repository: REPOSITORY, now: () => NOW });
  assert.equal(facts?.unreadRuns, 1);
  assert.equal(facts?.thisWeek.runs, 1);
  assert.equal(facts?.thisWeek.nearLimit, 1);
});

test('names the slowest test files from the log of a slow shard, longest first, once each', async () => {
  // Bug: the owner learns a shard is near the limit and not which test file to look at.
  const log = [
    'tests (2)\tRun node --test\t2026-11-05T23:00:01.0Z ▶ tests/a.test.ts (41234.5ms)',
    'tests (2)\tRun node --test\t2026-11-05T23:00:02.0Z ▶ tests/b.test.ts (90100.2ms)',
    'tests (2)\tRun node --test\t2026-11-05T23:00:03.0Z ▶ tests/a.test.ts (12.0ms)',
    'tests (2)\tRun node --test\t2026-11-05T23:00:04.0Z ℹ duration_ms 70454.4',
  ].join('\n');
  const { run, calls } = fakeGh(
    [{ id: 1, daysAgo: 1 }],
    { 1: [job('tests (1)', 50, 'success', 11), job('tests (2)', 280, 'success', 12)] },
    { 12: log }
  );
  const facts = await ciFacts({ run, repository: REPOSITORY, now: () => NOW });
  assert.deepEqual(
    facts?.slowestFiles.map((one) => [one.file, Math.round(one.ms)]),
    [
      ['tests/b.test.ts', 90100],
      ['tests/a.test.ts', 41235],
    ]
  );
  // Only the slow shard's log was asked for, by its job id.
  assert.deepEqual(logsAsked(calls), ['12']);
});

test('reads no more than the allowed logs', async () => {
  // Bug: every slow shard of the week downloads its whole log.
  const shards = Array.from({ length: CI_LOGS_MAX + 2 }, (_one, at) =>
    job(`tests (${at + 1})`, 280, 'success', 700 + at)
  );
  const { run, calls } = fakeGh([{ id: 1, daysAgo: 1 }], { 1: shards }, {});
  await ciFacts({ run, repository: REPOSITORY, now: () => NOW });
  assert.equal(logsAsked(calls).length, CI_LOGS_MAX);
});

test('a log with no per-file times leaves the files empty and the counts standing', async () => {
  // Bug: a log that carries only the totals fails the whole CI read.
  const { run } = fakeGh(
    [{ id: 1, daysAgo: 1 }],
    { 1: [job('tests (1)', 280, 'success', 31)] },
    { 31: 'ℹ duration_ms 70454.4\n' }
  );
  const facts = await ciFacts({ run, repository: REPOSITORY, now: () => NOW });
  assert.deepEqual(facts?.slowestFiles, []);
  assert.equal(facts?.thisWeek.nearLimit, 1);
});

for (const [name, answer] of [
  ['exits non-zero', { code: 1, stdout: '' }],
  ['answers no JSON', { code: 0, stdout: 'not json' }],
  ['answers an object, not a list', { code: 0, stdout: '{}' }],
] as const) {
  test(`gives null when the list ${name}`, async () => {
    // Bug: a logged-out `gh` reads as a week with no run, and no run reads as no slow shard.
    const facts = await ciFacts({ run: () => Promise.resolve(answer), repository: REPOSITORY, now: () => NOW });
    assert.equal(facts, null);
  });
}

test('gives null when gh cannot be started', async () => {
  // Bug: a missing `gh` throws out of the facts and the whole Development section is lost.
  const facts = await ciFacts({
    run: () => Promise.reject(new Error('ENOENT')),
    repository: REPOSITORY,
    now: () => NOW,
  });
  assert.equal(facts, null);
});

// ---------- the lines ----------

const lines = async (scene: { runs: Array<Run>; jobs: Record<number, Array<Job>> } = SCENE, logs = {}) => {
  const { run } = fakeGh(scene.runs, scene.jobs, logs);
  return ciLines(await ciFacts({ run, repository: REPOSITORY, now: () => NOW }));
};

test('the lines carry the week, the near-limit and cancelled counts and the slowest shard', async () => {
  // Bug: the counts are computed and never reach the report.
  const { inspected } = await lines();
  const week = inspected.find((one) => /last 7 days/.test(one)) ?? assert.fail(inspected.join('\n'));
  assert.match(week, /3 runs/);
  assert.match(week, /6 shards/);
  assert.match(week, /1 near the 5-minute limit/);
  assert.match(week, /1 cancelled by the limit/);
  assert.match(week, /slowest 300 s/);
});

test('the lines set this week against the week before', async () => {
  // Bug: the owner sees a count with no trend and cannot tell a bad week from a normal one.
  const { inspected } = await lines();
  const trend = inspected.find((one) => /week before/.test(one)) ?? assert.fail(inspected.join('\n'));
  assert.match(trend, /near the limit 1 \(before 1\)/);
  assert.match(trend, /cancelled by the limit 1 \(before 0\)/);
  assert.match(trend, /slowest 300 s \(before 260 s\)/);
});

test('a week before with no run says so and gives no invented trend', async () => {
  // Bug: a new repository reads as "before: 0 near the limit", which reads as an improvement that never happened.
  const { inspected } = await lines({ runs: [{ id: 1, daysAgo: 1 }], jobs: { 1: [job('tests (1)', 50)] } });
  const trend = inspected.find((one) => /week before/.test(one)) ?? assert.fail(inspected.join('\n'));
  assert.match(trend, /no runs/);
  assert.doesNotMatch(trend, /\(before/);
});

test('the lines name the slowest files with their seconds', async () => {
  // Bug: the slow files are read and left out of the report.
  const log = '2026-11-05T23:00:02.0Z ▶ tests/b.test.ts (90100.2ms)';
  const { inspected } = await lines(
    { runs: [{ id: 1, daysAgo: 1 }], jobs: { 1: [job('tests (1)', 280, 'success', 12)] } },
    { 12: log }
  );
  assert.ok(
    inspected.some((one) => /tests\/b\.test\.ts/.test(one) && /\b90\b/.test(one)),
    inspected.join('\n')
  );
});

test('no per-file times say so under the unavailable checks', async () => {
  // Bug: an empty file list reads as "no slow file" when the log simply had no per-file times.
  const result = await lines({ runs: [{ id: 1, daysAgo: 1 }], jobs: { 1: [job('tests (1)', 280, 'success', 31)] } });
  assert.ok(
    result.unavailable.some((one) => /per-file/.test(one)),
    result.unavailable.join('\n')
  );
});

test('a null summary is a stated unavailable line and no count', () => {
  // Bug: `gh` failing leaves the section silent, and silence reads as green CI.
  const result = ciLines(null);
  assert.deepEqual(result.unavailable, ['- CI runs unavailable']);
  assert.deepEqual(result.inspected, []);
});

test('runs whose jobs could not be read are named under the unavailable checks', async () => {
  // Bug: the week is counted from a part of its runs and the report does not say so.
  const result = await lines({
    runs: [
      { id: 1, daysAgo: 1 },
      { id: 2, daysAgo: 2 },
    ],
    jobs: { 1: [job('tests (1)', 50)] },
  });
  assert.ok(
    result.unavailable.some((one) => /1 CI run.*could not be read/.test(one)),
    result.unavailable.join('\n')
  );
});

test('no line is shaped like a finding', async () => {
  // Bug: a fact line with a level counts toward the risk and files a task on its own.
  const result = await lines();
  for (const line of [...result.inspected, ...result.unavailable])
    assert.doesNotMatch(line, /^- \[(critical|high|medium|low)\]/);
});
