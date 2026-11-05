// The CI summary of the watcher's development mode. `ciFacts` lists the runs of `main` with `gh run list` and the jobs of each
// with `gh run view --json jobs`, counts the shards (the jobs of a matrix, named `<name> (<n>)`) of the last seven days and of
// the seven before, and names the slowest test files from the log of the slowest shards. `ciLines` writes the counts as the
// lines of the section `Development`, none of them a finding. The agent judges, the code lists. Counts and names only: no
// log line but a test file's path and time is kept. src/watcher/development.ts calls these.

import { DAY_MS } from '../time.ts';

type Run = (command: string, args: ReadonlyArray<string>) => Promise<{ code: number; stdout: string }>;

export type CiWeek = {
  /** The runs of the week whose jobs were read. */
  runs: number;
  shards: number;
  /** Shards over `NEAR_LIMIT_SECONDS` that were not cancelled. */
  nearLimit: number;
  /** Shards cancelled at or past `LIMIT_CANCEL_SECONDS`: the job's time limit ended them. */
  cancelledAtLimit: number;
  /** The longest shard in seconds; null with no shard. */
  slowestSeconds: number | null;
};

export type CiFacts = {
  thisWeek: CiWeek;
  weekBefore: CiWeek;
  /** The runs listed whose jobs `gh` would not give; they are in neither week. */
  unreadRuns: number;
  /** How many logs of slow shards were asked for. */
  logsAsked: number;
  /** The test files of those logs, longest first. */
  slowestFiles: ReadonlyArray<{ file: string; ms: number }>;
};

/** The most runs of one week whose jobs are read, newest first. */
export const CI_RUNS_PER_WEEK_MAX = 12;
/** The most logs read in one summary. */
export const CI_LOGS_MAX = 2;
/** The most files the summary names. */
const FILES_MAX = 5;
/** The newest runs `gh` is asked to list: enough for two busy weeks. */
const LIST_LIMIT = 100;
/** A shard over four minutes is near the five-minute limit. */
const NEAR_LIMIT_SECONDS = 240;
/** A cancelled shard this long was ended by the limit, not by a person. */
const LIMIT_CANCEL_SECONDS = 295;
const WEEK_MS = 7 * DAY_MS;
const SHARD = /\(\d+\)$/;
const FILE_TIME = /(\S+\.test\.ts) \((\d+(?:\.\d+)?)ms\)/;

/** The JSON that `gh` printed, or null when it failed, would not start or printed something else. */
async function jsonOf(run: Run, args: ReadonlyArray<string>): Promise<unknown> {
  try {
    const done = await run('gh', args);
    return done.code === 0 ? (JSON.parse(done.stdout) as unknown) : null;
  } catch {
    return null;
  }
}

type Shard = { runId: number; jobId: number; seconds: number; cancelled: boolean };

/** The shards of a run, or null when the run's jobs cannot be read. */
async function shardsOf(run: Run, repository: string, runId: number): Promise<Array<Shard> | null> {
  const answer = await jsonOf(run, ['run', 'view', String(runId), '--repo', repository, '--json', 'jobs']);
  const jobs = (answer as { jobs?: unknown } | null)?.jobs;
  if (!Array.isArray(jobs)) return null;
  const shards: Array<Shard> = [];
  for (const job of jobs as Array<Record<string, unknown>>) {
    const started = Date.parse(String(job.startedAt));
    const ended = Date.parse(String(job.completedAt));
    if (typeof job.name !== 'string' || !SHARD.test(job.name) || Number.isNaN(started) || Number.isNaN(ended)) continue;
    shards.push({
      runId,
      jobId: Number(job.databaseId),
      seconds: Math.round((ended - started) / 1000),
      cancelled: job.conclusion === 'cancelled',
    });
  }
  return shards;
}

const weekOf = (runs: number, shards: ReadonlyArray<Shard>): CiWeek => ({
  runs,
  shards: shards.length,
  nearLimit: shards.filter((one) => !one.cancelled && one.seconds > NEAR_LIMIT_SECONDS).length,
  cancelledAtLimit: shards.filter((one) => one.cancelled && one.seconds >= LIMIT_CANCEL_SECONDS).length,
  slowestSeconds: shards.length === 0 ? null : Math.max(...shards.map((one) => one.seconds)),
});

/** The longest time of each test file in `log`, as the test reporter prints it. */
function filesOf(log: string, into: Map<string, number>): void {
  for (const line of log.split('\n')) {
    const found = FILE_TIME.exec(line);
    if (found === null) continue;
    const ms = Number(found[2]);
    if (ms > (into.get(found[1] ?? '') ?? -1)) into.set(found[1] ?? '', ms);
  }
}

/**
 * The summary of the CI of `main` in `repository`, or null when `gh` gave no list. Only completed runs of `main` from the last
 * two weeks count, at most `CI_RUNS_PER_WEEK_MAX` of each week. Nothing throws.
 */
export async function ciFacts(input: { run: Run; repository: string; now: () => number }): Promise<CiFacts | null> {
  const { run, repository } = input;
  const now = input.now();
  const listed = await jsonOf(run, [
    'run',
    'list',
    '--repo',
    repository,
    '--branch',
    'main',
    '--limit',
    String(LIST_LIMIT),
    '--json',
    'databaseId,headBranch,status,conclusion,createdAt',
  ]);
  if (!Array.isArray(listed)) return null;
  const completed = (listed as Array<Record<string, unknown>>)
    .filter((one) => one.headBranch === 'main' && one.status === 'completed')
    .map((one) => ({ id: Number(one.databaseId), at: Date.parse(String(one.createdAt)) }))
    .filter((one) => !Number.isNaN(one.at) && one.at <= now && one.at > now - 2 * WEEK_MS)
    .sort((left, right) => right.at - left.at);
  const weeks = [
    completed.filter((one) => one.at > now - WEEK_MS).slice(0, CI_RUNS_PER_WEEK_MAX),
    completed.filter((one) => one.at <= now - WEEK_MS).slice(0, CI_RUNS_PER_WEEK_MAX),
  ];
  let unreadRuns = 0;
  const shardsOfWeek: Array<Array<Shard>> = [[], []];
  const readRuns = [0, 0];
  for (const [at, week] of weeks.entries()) {
    for (const one of week) {
      const shards = await shardsOf(run, repository, one.id);
      if (shards === null) unreadRuns += 1;
      else {
        readRuns[at] = (readRuns[at] ?? 0) + 1;
        shardsOfWeek[at]?.push(...shards);
      }
    }
  }
  const slow = (shardsOfWeek[0] ?? [])
    .filter((one) => one.seconds > NEAR_LIMIT_SECONDS)
    .sort((left, right) => right.seconds - left.seconds)
    .slice(0, CI_LOGS_MAX);
  const files = new Map<string, number>();
  for (const one of slow) {
    const log = await logOf(run, repository, one);
    if (log !== null) filesOf(log, files);
  }
  return {
    thisWeek: weekOf(readRuns[0] ?? 0, shardsOfWeek[0] ?? []),
    weekBefore: weekOf(readRuns[1] ?? 0, shardsOfWeek[1] ?? []),
    unreadRuns,
    logsAsked: slow.length,
    slowestFiles: [...files.entries()]
      .map(([file, ms]) => ({ file, ms }))
      .sort((left, right) => right.ms - left.ms)
      .slice(0, FILES_MAX),
  };
}

/** The log of one shard, or null when `gh` would not give it. */
async function logOf(run: Run, repository: string, shard: Shard): Promise<string | null> {
  try {
    const done = await run('gh', [
      'run',
      'view',
      String(shard.runId),
      '--repo',
      repository,
      '--job',
      String(shard.jobId),
      '--log',
    ]);
    return done.code === 0 ? done.stdout : null;
  } catch {
    return null;
  }
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

function weekLine(week: CiWeek): string {
  const slowest = week.slowestSeconds === null ? [] : [`slowest ${week.slowestSeconds} s`];
  return [
    plural(week.runs, 'run'),
    plural(week.shards, 'shard'),
    `${week.nearLimit} near the 5-minute limit`,
    `${week.cancelledAtLimit} cancelled by the limit`,
    ...slowest,
  ].join(', ');
}

/** This week's counts set against the week before's, or the week before alone when there is no week to set against. */
function trendLine(now: CiWeek, before: CiWeek): string {
  if (before.runs === 0) return '- CI week before: no runs';
  if (now.runs === 0) return `- CI week before: ${weekLine(before)}`;
  const slowest =
    now.slowestSeconds === null || before.slowestSeconds === null
      ? []
      : [`slowest ${now.slowestSeconds} s (before ${before.slowestSeconds} s)`];
  return [
    '- CI against the week before: ',
    [
      `near the limit ${now.nearLimit} (before ${before.nearLimit})`,
      `cancelled by the limit ${now.cancelledAtLimit} (before ${before.cancelledAtLimit})`,
      ...slowest,
    ].join(', '),
  ].join('');
}

/**
 * The lines of the summary for the section `Development`: counts under `inspected`, what could not be read under
 * `unavailable`. A null summary is `CI runs unavailable` and no count. No line carries a level.
 */
export function ciLines(facts: CiFacts | null): { inspected: Array<string>; unavailable: Array<string> } {
  if (facts === null) return { inspected: [], unavailable: ['- CI runs unavailable'] };
  const { thisWeek, weekBefore, unreadRuns, logsAsked, slowestFiles } = facts;
  return {
    inspected: [
      `- CI of main, last 7 days: ${thisWeek.runs === 0 ? 'no runs' : weekLine(thisWeek)}`,
      trendLine(thisWeek, weekBefore),
      ...(slowestFiles.length === 0
        ? []
        : [
            `- slowest test files in the slowest shards: ${slowestFiles
              .map((one) => `${one.file} ${Math.round(one.ms / 1000)} s`)
              .join(', ')}`,
          ]),
    ],
    unavailable: [
      ...(unreadRuns === 0 ? [] : [`- ${plural(unreadRuns, 'CI run')} of main could not be read`]),
      ...(logsAsked > 0 && slowestFiles.length === 0 ? ['- per-file test times unavailable in the logs read'] : []),
    ],
  };
}
