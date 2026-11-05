// The watcher's development mode. With `selfimprovement.enabled` not false, an absolute `selfimprovement.checkout` that is
// not the running install, an `owner/name` `selfimprovement.repository` and a backend for the agent `dev`, the watcher also
// checks the code in that folder, and its report holds the section `Development`. Anything less is off: no section, no
// code touched. `developmentFacts` reads the section's facts with no model call and no write to the checkout, counts and
// names only. `stampDevelopment` writes them into the section. A run audits one topic of `watcher.auditTopics`, and the
// queue moves once per run that committed its report. A test run from the checkout has one form (`singleTestCommand`), a
// finding's command is checked against it (`reproducingCommand`), and `selectRows` is the agent's read of the live database.
// src/watcher/inspection.ts, src/watcher/filing.ts, src/setup/units.ts and src/service/watcher.ts call these.

import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../memory/db/types.ts';
import { selfimprovementSettings } from '../selfimprovement/settings.ts';
import { DAY_MS } from '../time.ts';
import { ciFacts, ciLines } from './ci.ts';
import type { CiFacts } from './ci.ts';
import { DEVELOPMENT_SECTION, insertInspected, insertUnavailable, maskCredentials, removeSection } from './report.ts';
import { WATCHER_EVIDENCE_MAX_CHARS } from './requests.ts';

export type DevelopmentMode =
  | { on: true; checkout: string; repository: string; base: string }
  | { on: false; why: 'disabled' | 'no-checkout' | 'live-checkout' | 'no-repository' | 'no-agent' };

export type DevelopmentCi = 'failure' | 'pending' | 'success' | 'none';

export type DevelopmentFacts = {
  /** `behind` is null when the two refs could not be compared. */
  base: { name: string; behind: number | null };
  worktrees: ReadonlyArray<{ name: string; ageDays: number | null; taskId: string | null }>;
  branches: ReadonlyArray<{ name: string; taskId: string | null }>;
  tasks: {
    filed: number;
    running: number;
    failed: ReadonlyArray<{ id: string; finishReason: string | null }>;
    waiting: number;
    merged: number;
  } | null;
  pullRequests: ReadonlyArray<{ number: number; branch: string; ci: DevelopmentCi }> | null;
  /** The CI of `main`; null when `gh` gave no list, absent in facts of a caller that never asked. */
  ci?: CiFacts | null;
  worker: { state: string; since: string | null } | null;
  modules: boolean;
};

type Run = (command: string, args: ReadonlyArray<string>) => Promise<{ code: number; stdout: string; stderr?: string }>;

/** The unit of the development worker: a service with no timer of its own. */
const WORKER_UNIT = 'neptunia-development.service';
/** Where a worktree of the executor lives inside the checkout. */
const WORKTREES = '.worktrees';
/** The flag every test run from the checkout carries: its setup refuses the machine's service manager. */
const REFUSING_SETUP = '--test-global-setup=tests/fixtures/refuse-manager.ts';
const SCRATCH = 'scratch';
const QUEUE_FILE = 'audit-queue.json';
/** The most failed tasks the facts name, newest first: the board keeps every failure for good. */
const FAILED_TASKS_MAX = 20;
/** The most worktrees or branches the section names one by one. */
const NAMED_MAX = 20;
const PULL_REQUESTS_MAX = 100;
const SELECT_ROWS_MAX = 500;
/** The longest cell a read keeps. */
const SELECT_CELL_MAX = 4000;

/** Whether the settings make the mode on, and if not, what is missing. Read at the moment of use. */
export function developmentMode(input: { config: unknown; rootDir: string; devAgent: string | null }): DevelopmentMode {
  const { enabled, checkout, repository, base } = selfimprovementSettings(input.config);
  if (!enabled) return { on: false, why: 'disabled' };
  if (checkout === null) return { on: false, why: 'no-checkout' };
  if (path.resolve(checkout) === path.resolve(input.rootDir)) return { on: false, why: 'live-checkout' };
  if (repository === null) return { on: false, why: 'no-repository' };
  if (input.devAgent === null) return { on: false, why: 'no-agent' };
  return { on: true, checkout, repository, base };
}

/** The topics of `watcher.auditTopics`, the usable words only. */
export function auditTopicsOf(config: unknown): Array<string> {
  const watcher = (config as { watcher?: { auditTopics?: unknown } } | null)?.watcher;
  const topics = watcher?.auditTopics;
  if (!Array.isArray(topics)) return [];
  return topics.filter((one): one is string => typeof one === 'string' && one.trim() !== '').map((one) => one.trim());
}

/** The folder under the watcher's own that a test run writes in. */
export const watcherScratch = (dir: string): string => path.join(dir, SCRATCH);

/** The scratch of a new run, empty: nothing of an earlier run's tests reaches this one. */
export function emptyScratch(dir: string): void {
  const scratch = watcherScratch(dir);
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
}

// ---------- the queue of topics ----------

type QueueState = { next: string; lastRun: string };

function readQueue(dir: string): QueueState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, QUEUE_FILE), 'utf8')) as Partial<QueueState> | null;
    return typeof parsed?.next === 'string' && typeof parsed.lastRun === 'string'
      ? { next: parsed.next, lastRun: parsed.lastRun }
      : null;
  } catch {
    return null;
  }
}

/** The topic of the next run: where the queue stands, or the first when its state or that topic is gone. Null with none. */
export function currentAuditTopic(dir: string, topics: ReadonlyArray<string>): string | null {
  const next = readQueue(dir)?.next;
  if (next !== undefined && topics.includes(next)) return next;
  return topics[0] ?? null;
}

/** Moves the queue one topic on for a run that committed its report; the same run a second time moves nothing. */
export function finishAuditTopic(dir: string, runId: string, topics: ReadonlyArray<string>): void {
  if (topics.length === 0 || readQueue(dir)?.lastRun === runId) return;
  const current = currentAuditTopic(dir, topics) ?? '';
  const next = topics[(topics.indexOf(current) + 1) % topics.length] ?? current;
  const file = path.join(dir, QUEUE_FILE);
  const state: QueueState = { next, lastRun: runId };
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
  fs.renameSync(`${file}.tmp`, file);
}

// ---------- one test file, in one form ----------

const TEST_FILE = /^tests\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.test\.ts$/;

/** One word of a shell line, quoted only when it has to be. */
const shellWord = (word: string): string =>
  /^[A-Za-z0-9_./=:@%+-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

export type TestCommand =
  | {
      ok: true;
      argv: Array<string>;
      cwd: string;
      /** What the child's environment changes: an undefined name is taken out. */
      env: Record<string, string | undefined>;
      line: string;
    }
  | { ok: false; code: 'not-a-test-file' };

/**
 * The one form of a test run from the checkout: one file under `tests/`, the refusing setup ahead of it, working in the
 * checkout with its files in the scratch, and with the persona's folders out of its environment.
 */
export function singleTestCommand(input: {
  checkout: string;
  scratch: string;
  file: string;
  node: string;
}): TestCommand {
  const { checkout, scratch, file, node } = input;
  if (!TEST_FILE.test(file)) return { ok: false, code: 'not-a-test-file' };
  const argv = [node, '--test', '--test-reporter=dot', '--test-concurrency=1', REFUSING_SETUP, file];
  const line = [
    `cd ${shellWord(checkout)} &&`,
    'env -u NEPTUNIA_PRIVATE_DIR -u NEPTUNIA_DATA_DIR',
    `TMPDIR=${shellWord(scratch)}`,
    ...argv.map(shellWord),
  ].join(' ');
  return {
    ok: true,
    argv,
    cwd: checkout,
    env: { TMPDIR: scratch, NEPTUNIA_PRIVATE_DIR: undefined, NEPTUNIA_DATA_DIR: undefined },
    line,
  };
}

export type ReproducingCommand =
  { ok: true; command: string } | { ok: false; code: 'missing' | 'test-without-refusal' | 'whole-suite' };

const NPM_TEST = /(?:^|\s)npm\s+(?:run\s+)?(?:test|t)(?:\s|$)/;
const isRedirect = (word: string): boolean => /^\d*>/.test(word);
const unquoted = (word: string): string => word.replace(/^['"]|['"]$/g, '');

/** What is wrong with one command of a line that runs node's test runner; null for the one form. */
function testRunProblem(words: ReadonlyArray<string>): 'test-without-refusal' | 'whole-suite' | null {
  const after = words.slice(words.indexOf('--test') + 1).filter((word) => !word.startsWith('-') && !isRedirect(word));
  const [file] = after;
  const oneFile = after.length === 1 && file !== undefined && TEST_FILE.test(file) && !file.includes('/../');
  if (!oneFile) return 'whole-suite';
  return words.includes(REFUSING_SETUP) ? null : 'test-without-refusal';
}

/**
 * Whether `line` can stand as the command that reproduces a finding. A blank line or no string is `missing`. Any command may
 * prove a finding, but one that runs tests takes the form of `singleTestCommand`: it holds the refusing setup and one test
 * file. Without them it could move the server's units or run the whole suite on the server.
 */
export function reproducingCommand(line: unknown): ReproducingCommand {
  if (typeof line !== 'string' || line.trim() === '') return { ok: false, code: 'missing' };
  const command = line.trim();
  for (const part of command.split(/&&|\|\|?|;/)) {
    if (NPM_TEST.test(part)) return { ok: false, code: 'whole-suite' };
    const words = part.trim().split(/\s+/).map(unquoted);
    if (words.includes('--test')) {
      const problem = testRunProblem(words);
      if (problem !== null) return { ok: false, code: problem };
    }
  }
  return { ok: true, command };
}

// ---------- the facts ----------

/** The output of a command that may be missing, may fail and may refuse to start: null for any of those. */
async function outputOf(run: Run, command: string, args: ReadonlyArray<string>): Promise<string | null> {
  try {
    const done = await run(command, args);
    return done.code === 0 ? done.stdout : null;
  } catch {
    return null;
  }
}

/** The facts the board holds, read together over one connection. */
type BoardFacts = {
  tasks: DevelopmentFacts['tasks'];
  worktreeTasks: ReadonlyMap<string, string>;
  branchTasks: ReadonlyMap<string, string>;
};

const FILED: ReadonlyArray<string> = ['proposed', 'triaged', 'approved'];

function readBoard(db: Db): BoardFacts {
  const counts = db
    .prepare(
      `SELECT status, json_type(metadata, '$.merged') = 'object' AS merged, count(*) AS n
       FROM board_tasks WHERE lane = 'dev' GROUP BY status, merged`
    )
    .all();
  const sum = (holds: (row: Record<string, unknown>) => boolean): number =>
    counts.filter(holds).reduce((total, row) => total + Number(row.n), 0);
  const failed = db
    .prepare(
      `SELECT id, (SELECT finish_reason FROM board_attempts WHERE task_id = board_tasks.id ORDER BY n DESC LIMIT 1) AS reason
       FROM board_tasks WHERE lane = 'dev' AND status = 'failed' ORDER BY updated_at DESC LIMIT ?`
    )
    .all(FAILED_TASKS_MAX);
  const worktreeTasks = new Map<string, string>();
  const branchTasks = new Map<string, string>();
  const attempts = db
    .prepare(
      'SELECT task_id, worktree, branch FROM board_attempts WHERE worktree IS NOT NULL OR branch IS NOT NULL ORDER BY n'
    )
    .all();
  for (const { task_id: task, worktree, branch } of attempts) {
    if (typeof worktree === 'string') worktreeTasks.set(path.basename(worktree), String(task));
    if (typeof branch === 'string') branchTasks.set(branch, String(task));
  }
  return {
    tasks: {
      filed: sum((row) => FILED.includes(String(row.status))),
      running: sum((row) => row.status === 'in_progress'),
      failed: failed.map((row) => ({
        id: String(row.id),
        finishReason: typeof row.reason === 'string' ? row.reason : null,
      })),
      waiting: sum((row) => row.status === 'needs_validation'),
      merged: sum((row) => row.status === 'done' && row.merged === 1),
    },
    worktreeTasks,
    branchTasks,
  };
}

/** The worktrees of the executor among those git lists, with their ages. A folder that cannot be read has no age. */
function worktreesOf(listing: string | null, tasks: ReadonlyMap<string, string>, now: number) {
  const places = (listing ?? '').split('\n').flatMap((line) => (line.startsWith('worktree ') ? [line.slice(9)] : []));
  return places
    .filter((place) => path.basename(path.dirname(place)) === WORKTREES)
    .map((place) => {
      const name = path.basename(place);
      const modified = fs.statSync(place, { throwIfNoEntry: false })?.mtimeMs;
      return {
        name,
        ageDays: modified === undefined ? null : Math.floor((now - modified) / DAY_MS),
        taskId: tasks.get(name) ?? null,
      };
    });
}

const CI_FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'];
const CI_PASSED = ['SUCCESS', 'NEUTRAL', 'SKIPPED'];

/** The worst check of a pull request: a check run answers `conclusion`, a status context `state`. */
function ciOf(checks: unknown): DevelopmentCi {
  if (!Array.isArray(checks) || checks.length === 0) return 'none';
  const results = (checks as Array<{ conclusion?: string; state?: string }>).map(
    (one) => one.conclusion || one.state || ''
  );
  if (results.some((one) => CI_FAILED.includes(one))) return 'failure';
  return results.every((one) => CI_PASSED.includes(one)) ? 'success' : 'pending';
}

/** The open pull requests of the configured repository, or null when `gh` gave no list. No title is asked for or kept. */
async function pullRequestsOf(run: Run, repository: string): Promise<DevelopmentFacts['pullRequests']> {
  const listing = await outputOf(run, 'gh', [
    'pr',
    'list',
    '--repo',
    repository,
    '--state',
    'open',
    '--limit',
    String(PULL_REQUESTS_MAX),
    '--json',
    'number,headRefName,statusCheckRollup',
  ]);
  if (listing === null) return null;
  try {
    const parsed: unknown = JSON.parse(listing);
    if (!Array.isArray(parsed)) return null;
    return (parsed as Array<{ number?: unknown; headRefName?: unknown; statusCheckRollup?: unknown }>).map((one) => ({
      number: Number(one.number),
      branch: String(one.headRefName),
      ci: ciOf(one.statusCheckRollup),
    }));
  } catch {
    return null;
  }
}

/** The state of the worker's unit in the scope of this install, or null when the manager does not answer. */
async function workerOf(run: Run, scope: 'user' | 'system' | undefined): Promise<DevelopmentFacts['worker']> {
  const answer = await outputOf(run, 'systemctl', [
    ...(scope === 'user' ? ['--user'] : []),
    'show',
    WORKER_UNIT,
    '--property=ActiveState,ActiveEnterTimestamp',
  ]);
  if (answer === null) return null;
  const value = (name: string): string | undefined =>
    answer
      .split('\n')
      .find((line) => line.startsWith(`${name}=`))
      ?.slice(name.length + 1)
      .trim();
  const state = value('ActiveState');
  if (state === undefined || state === '') return null;
  const since = value('ActiveEnterTimestamp');
  return { state, since: since === undefined || since === '' || since === 'n/a' ? null : since };
}

/** `facts` with what looks like a key masked in every string: a branch's name can hold anything. */
const maskedFacts = (facts: DevelopmentFacts): DevelopmentFacts =>
  JSON.parse(JSON.stringify(facts), (_key, value: unknown) =>
    typeof value === 'string' ? maskCredentials(value).text : value
  ) as DevelopmentFacts;

/**
 * What the section says of the checkout, with no model call and no write: git only reads, `gh` lists and `systemctl` shows.
 * Each fact that could not be read is null or empty, and nothing throws.
 */
export async function developmentFacts(input: {
  mode: Extract<DevelopmentMode, { on: true }>;
  run: Run;
  readMemory: <T>(read: (db: Db) => T) => T | null;
  now: () => number;
  scope?: 'user' | 'system';
}): Promise<DevelopmentFacts> {
  const { mode, run, now } = input;
  const git = (...args: Array<string>): Promise<string | null> => outputOf(run, 'git', ['-C', mode.checkout, ...args]);
  const [behind, listing, branches, pullRequests, ci, worker] = await Promise.all([
    git('rev-list', '--count', `refs/heads/${mode.base}..refs/remotes/origin/${mode.base}`),
    git('worktree', 'list', '--porcelain'),
    git('for-each-ref', '--format=%(refname:short)', 'refs/heads'),
    pullRequestsOf(run, mode.repository),
    ciFacts({ run, repository: mode.repository, now }),
    workerOf(run, input.scope),
  ]);
  let board: BoardFacts | null = null;
  try {
    board = input.readMemory(readBoard);
  } catch {
    // A board that cannot be read is named under the section's `Unavailable checks`.
  }
  const counted = behind === null ? NaN : Number(behind.trim());
  return maskedFacts({
    base: { name: mode.base, behind: Number.isInteger(counted) ? counted : null },
    worktrees: worktreesOf(listing, board?.worktreeTasks ?? new Map<string, string>(), now()),
    branches: (branches ?? '')
      .split('\n')
      .map((name) => name.trim())
      .filter((name) => name !== '' && name !== mode.base)
      .map((name) => ({ name, taskId: board?.branchTasks.get(name) ?? null })),
    tasks: board?.tasks ?? null,
    pullRequests,
    ci,
    worker,
    modules: fs.statSync(path.join(mode.checkout, 'node_modules'), { throwIfNoEntry: false })?.isDirectory() === true,
  });
}

// ---------- the section ----------

/** The first of `lines`, and a line that counts the rest. */
const capped = (lines: ReadonlyArray<string>, what: string): Array<string> =>
  lines.length <= NAMED_MAX
    ? [...lines]
    : [...lines.slice(0, NAMED_MAX), `- and ${lines.length - NAMED_MAX} more ${what}`];

const taskWord = (taskId: string | null): string => (taskId === null ? 'no task' : `task ${taskId}`);

function gitLines(facts: DevelopmentFacts): Array<string> {
  const { base, worktrees, branches } = facts;
  if (base.behind === null) return [];
  return [
    `- base ${base.name}: behind origin/${base.name} by ${base.behind} commits`,
    `- worktrees left: ${worktrees.length}`,
    ...capped(
      worktrees.map(
        (one) =>
          `- worktree ${one.name}: ${one.ageDays === null ? 'age unknown' : `${one.ageDays} days old`}, ${taskWord(one.taskId)}`
      ),
      'worktrees'
    ),
    `- branches left: ${branches.length}`,
    ...capped(
      branches.map((one) => `- branch ${one.name}: ${taskWord(one.taskId)}`),
      'branches'
    ),
  ];
}

/** What was read, each line a count or a name and none a finding. */
function factLines(facts: DevelopmentFacts): Array<string> {
  const { tasks, pullRequests, worker, modules } = facts;
  return [
    ...gitLines(facts),
    ...(tasks === null
      ? []
      : [
          `- tasks: filed ${tasks.filed}, running ${tasks.running}, waiting ${tasks.waiting}, merged ${tasks.merged}`,
          ...tasks.failed.map((one) => `- failed task ${one.id}: ${one.finishReason ?? 'no finish reason'}`),
        ]),
    ...(pullRequests === null
      ? []
      : pullRequests.length === 0
        ? ['- open pull requests: 0']
        : pullRequests.map((one) => `- open pull request #${one.number} on ${one.branch}: CI ${one.ci}`)),
    ...(facts.ci === undefined || facts.ci === null ? [] : ciLines(facts.ci).inspected),
    ...(worker === null
      ? []
      : [`- worker ${WORKER_UNIT}: ${worker.state}${worker.since === null ? '' : ` since ${worker.since}`}`]),
    ...(modules ? ['- node_modules is there'] : []),
  ];
}

/** What could not be read, or stands in the way of the executor's tests. */
function gapLines(facts: DevelopmentFacts): Array<string> {
  const { base, tasks, pullRequests, worker, modules } = facts;
  return [
    ...(base.behind === null ? [`- base ${base.name} could not be compared with origin/${base.name}`] : []),
    ...(tasks === null ? ['- board tasks could not be read'] : []),
    ...(pullRequests === null ? ['- pull requests unavailable'] : []),
    ...(facts.ci === undefined ? [] : ciLines(facts.ci).unavailable),
    ...(worker === null ? [`- worker ${WORKER_UNIT} could not be read`] : []),
    ...(modules ? [] : ["- node_modules is missing, so the executor's tests cannot run"]),
  ];
}

/**
 * The section as the engine leaves it. With the mode off it does not exist, whatever the agent wrote there. With the mode on
 * the facts open `Inspected without a finding` and `Unavailable checks`, ahead of what the agent wrote, and its findings stay.
 */
export function stampDevelopment(
  report: string,
  mode: { on: false } | { on: true; facts: DevelopmentFacts | null }
): string {
  if (!mode.on) return removeSection(report, DEVELOPMENT_SECTION);
  const { facts } = mode;
  if (facts === null) return insertUnavailable(report, DEVELOPMENT_SECTION, ['- development facts unavailable']);
  const inspected = insertInspected(report, DEVELOPMENT_SECTION, factLines(facts));
  return insertUnavailable(inspected, DEVELOPMENT_SECTION, gapLines(facts));
}

/** The body of `<development>`: the folder, the test form and the facts, as JSON. */
export function developmentBrief(input: {
  mode: Extract<DevelopmentMode, { on: true }>;
  facts: DevelopmentFacts | null;
  scratch: string;
  node: string;
}): string {
  const { mode, facts, scratch, node } = input;
  const form = singleTestCommand({ checkout: mode.checkout, scratch, file: 'tests/MODULE.test.ts', node });
  const { checkout: folder, repository, base } = mode;
  const testForm = form.ok ? form.line : null;
  return JSON.stringify({ folder, repository, base, scratch, testForm, facts }, null, 2);
}

// ---------- the live database, read-only ----------

/** The statement with its strings, quoted names and comments blanked, so only its own words and semicolons are left. */
const bareSql = (sql: string): string =>
  sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').trim();

/** Why a statement is no single read; null when it may reach the database. */
export function selectRefusal(sql: string): string | null {
  const bare = bareSql(sql).replace(/;\s*$/, '');
  if (bare.includes(';')) return 'one statement only';
  return /^(?:select|with)\b/i.test(bare) ? null : 'only a SELECT reads here';
}

function maskedCell(value: unknown): { value: unknown; cut: boolean } {
  if (value instanceof Uint8Array) return { value: `[${value.length} bytes]`, cut: false };
  if (typeof value === 'bigint') return { value: String(value), cut: false };
  if (typeof value !== 'string') return { value, cut: false };
  const { text } = maskCredentials(value);
  return text.length > SELECT_CELL_MAX
    ? { value: `${text.slice(0, SELECT_CELL_MAX)}...`, cut: true }
    : { value: text, cut: false };
}

/**
 * The rows of one statement as JSON, `{ rows, truncated }`, its text inside `WATCHER_EVIDENCE_MAX_CHARS`. What looks like a
 * key is masked, a long cell is cut and a binary one becomes its length. The caller holds the read-only connection.
 */
export function selectRows(db: Db, sql: string): string {
  const rows: Array<Record<string, unknown>> = [];
  let chars = JSON.stringify({ rows: [], truncated: true }).length;
  let truncated = false;
  for (const row of db.prepare(sql).iterate()) {
    const kept: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(row)) {
      const cell = maskedCell(value);
      kept[maskCredentials(name).text] = cell.value;
      if (cell.cut) truncated = true;
    }
    chars += JSON.stringify(kept).length + 1;
    if (rows.length >= SELECT_ROWS_MAX || chars > WATCHER_EVIDENCE_MAX_CHARS) {
      truncated = true;
      break;
    }
    rows.push(kept);
  }
  return JSON.stringify({ rows, truncated });
}
