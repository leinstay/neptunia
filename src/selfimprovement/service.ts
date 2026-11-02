// She codes herself (docs/selfimprovement.md): her fix proposals on the task board become pull requests, and a merge reaches
// her wake. `createSelfimprovement` is three steps over injected edges, run one after the other by `beat` (bin/selfimprovement.ts) once
// the push-right check (src/selfimprovement/repository.ts) says her gh login may push to `selfimprovement.repository`. `intake` triages her `fix` proposals to the dev role and approves their plan, which is safe at risk
// `low` because nothing lands without a merge. `work` takes each approved fix, makes a worktree from the base branch,
// lets one dev run patch it, commits what it left, runs the tests of the touched modules itself and only then pushes and
// opens the pull request as a draft. `observe` looks at each open pull request: with every check green it marks the
// request ready for the owner (`selfimprovement.mode` `approve`) or merges it (`auto`), and a merge by the owner closes the
// task. A branch is deleted right after its merge in both modes. Branches are pushed to and deleted from
// `https://github.com/<selfimprovement.repository>.git`, and every `gh pr` call names that repository with `--repo`, so a
// deployment that named its fork never touches the checkout's `origin`.
// The board is called as the builtin principal `selfimprovement`. Git, gh, the test runner and the dev run are injected, one
// command at a time and never through a shell. The journal carries ids, counts and codes, never a diff or a message.

import { fillPromptTemplate } from '../turn/request/text.ts';
import type { Handoff, HandoffTest, TaskRecord } from '../board/board.ts';
import type { BoardCaller } from '../tools/impl/board.ts';
import type { RepositoryCheck } from './repository.ts';
import type { SelfimprovementSettings } from './settings.ts';

export type ExecResult = { code: number; stdout: string; stderr: string };
/** One command, never a shell. The engine passes it three ways: git, gh and the test runner. */
export type Exec = (file: string, args: ReadonlyArray<string>, options: { cwd: string }) => Promise<ExecResult>;
/** The subharness runner: one dev run on a brief in `cwd`. Production is an adapter over `Backend.run`. */
export type SubharnessRun = (request: {
  taskId: string;
  brief: string;
  cwd: string;
}) => Promise<{ ok: boolean; text: string; error?: string }>;

export type FixBrief = {
  id: string;
  title: string;
  evidence: string;
  acceptance: string | null;
  examples: Array<string>;
  counterexamples: Array<string>;
  benefit: string;
  evaluation: string;
};
export type SelfimprovementDeps = {
  /** called as the builtin principal `selfimprovement` (roles reviewer, worker) */
  board: BoardCaller;
  git: Exec;
  gh: Exec;
  tests: Exec;
  run: SubharnessRun;
  /** the model-facing text lives in prompts/, never in src/ */
  brief(task: FixBrief): string;
  /** hot: read at each use; the beat reads the mode, the base and the repository, never the checkout setup renders it over */
  settings(): Pick<SelfimprovementSettings, 'mode' | 'base' | 'repository'>;
  /** the push-right check of the beat: bin/selfimprovement.ts passes checkRepository over its gh runner and the labels */
  check(): Promise<RepositoryCheck>;
  /** `boardSettings(config).autoTriage` */
  triage(): { role: string; budget: number; steps: number; estimate: number };
  journal(line: Record<string, unknown>): void;
  fileExists(dir: string, relativePath: string): boolean;
  /** the checkout the worktrees hang off */
  repoDir: string;
  /** the folder that holds one directory per task */
  worktreeRoot: string;
};

export type AttemptReport = {
  taskId: string;
  outcome: 'submitted' | 'refused' | 'failed';
  branch: string | null;
  pr: number | null;
  /** the refusal, or the failure code with its detail */
  reason: string | null;
};
export type Observation = {
  taskId: string;
  pr: number;
  action: 'merged-by-owner' | 'merged-auto' | 'waiting-ci' | 'waiting-owner' | 'closed';
};
export type BeatReport = {
  check: RepositoryCheck;
  taken: Array<string>;
  reports: Array<AttemptReport>;
  seen: Array<Observation>;
};
export type Selfimprovement = {
  /** Her fix proposals in `proposed`, triaged to dev at risk `low` with the plan approved. Returns the task ids. */
  intake(): Promise<Array<string>>;
  /** Works every approved fix task of hers, one after the other. */
  work(): Promise<Array<AttemptReport>>;
  /** Looks at every task in `needs_validation` with a pull request of this service. */
  observe(): Promise<Array<Observation>>;
  /**
   * The check first; on `ok` intake, work and observe once each. Otherwise nothing runs, and the journal says
   * `paused` with the check's code. A check that throws pauses with `failed`.
   */
  beat(): Promise<BeatReport>;
};

/** The name her tasks are filed under (src/tools/impl/board.ts). */
const SELF = 'persona:self';
/** The lease of a claimed task, and how often a run renews it (minutes). */
const LEASE_MINUTES = 90;
const RENEW_MINUTES = 20;
/** The refusal tag of the brief (prompts/selfimprovement.md, docs/prompt-contract.md). */
const REFUSED = /^REFUSED:[ \t]*(.*)$/;

/** The text of prompts/selfimprovement.md with the fix's fields in their `{{placeholders}}` (docs/prompt-contract.md). */
export function briefFrom(template: string, task: FixBrief): string {
  const list = (items: ReadonlyArray<string>): string => items.map((one) => `- ${one}`).join('\n');
  return fillPromptTemplate(template, {
    id: task.id,
    title: task.title,
    evidence: task.evidence,
    acceptance: task.acceptance ?? '',
    examples: list(task.examples),
    counterexamples: list(task.counterexamples),
    benefit: task.benefit,
    evaluation: task.evaluation,
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const firstLine = (text: string): string =>
  text
    .split('\n')
    .find((line) => line.trim() !== '')
    ?.trim() ?? '';

const stringsOf = (value: unknown): Array<string> =>
  Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : [];

const lines = (text: string): Array<string> => text.split('\n').filter((line) => line.trim() !== '');

/** The paths of `git status --porcelain`: the new name of a rename, a quoted name unquoted. */
function pathsOfStatus(output: string): Array<string> {
  return lines(output).map((line) => {
    const named = line.slice(3);
    const arrow = named.indexOf(' -> ');
    const one = arrow < 0 ? named : named.slice(arrow + 4);
    if (!one.startsWith('"') || !one.endsWith('"')) return one;
    try {
      return String(JSON.parse(one));
    } catch {
      return one.slice(1, -1);
    }
  });
}

/** The test files a change calls for: a changed test as it is, a changed module's tests by the names of code-health. */
function testsFor(
  changed: ReadonlyArray<string>,
  exists: (relative: string) => boolean
): { files: Array<string>; uncovered: Array<string> } {
  const files = new Set<string>();
  const uncovered: Array<string> = [];
  for (const file of changed) {
    if (/^tests\/.+\.test\.[cm]?[jt]s$/.test(file)) {
      if (exists(file)) files.add(file);
      continue;
    }
    if (file.startsWith('tests/')) continue;
    const parts = file.replace(/\.[^./]+$/, '').split('/');
    const found = parts.map((_, at) => `tests/${parts.slice(at).join('-')}.test.ts`).filter((name) => exists(name));
    for (const name of found) files.add(name);
    if (found.length === 0) uncovered.push(file);
  }
  return { files: [...files], uncovered };
}

/** The count a TAP report states on a `# <name> N` line, or 0. */
function tapCount(output: string, name: string): number {
  const found = new RegExp(`^# ${name} (\\d+)`, 'm').exec(output);
  return found === null ? 0 : Number(found[1]);
}

/** Whether a check of `statusCheckRollup` finished successfully (a check run or a commit status). */
function succeeded(check: unknown): boolean {
  if (!isRecord(check)) return false;
  if (typeof check.state === 'string') return check.state === 'SUCCESS';
  return check.status === 'COMPLETED' && check.conclusion === 'SUCCESS';
}

type PullRequest = { state: string; title: string; files: Array<string>; checks: Array<unknown>; branch: string };

/** `gh pr view --json ...` as the fields the service reads, or null when the answer is not one. */
function pullRequestOf(stdout: string): PullRequest | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(data) || typeof data.state !== 'string') return null;
  const files = Array.isArray(data.files)
    ? data.files.map((one) => (isRecord(one) ? one.path : null)).filter((one): one is string => typeof one === 'string')
    : [];
  return {
    state: data.state,
    title: typeof data.title === 'string' ? data.title : '',
    files,
    checks: Array.isArray(data.statusCheckRollup) ? data.statusCheckRollup : [],
    branch: typeof data.headRefName === 'string' ? data.headRefName : '',
  };
}

/** The push URL of `owner/name`. */
const remoteOf = (repository: string): string => `https://github.com/${repository}.git`;

/** Thrown where a git or gh call needs `selfimprovement.repository` and it is unset; the beat checks first, so only a direct
 * call of a step meets it. */
class RepositoryUnset extends Error {
  code = 'repository-unset';
}

export function createSelfimprovement(deps: SelfimprovementDeps): Selfimprovement {
  /** `selfimprovement.repository` at the moment of use. */
  const repository = (): string => {
    const named = deps.settings().repository;
    if (named === null) throw new RepositoryUnset('selfimprovement.repository is unset');
    return named;
  };
  /** `gh pr <sub> --repo <repository> ...args` in `cwd`. */
  const pr = async (sub: string, args: ReadonlyArray<string>, cwd: string) =>
    await deps.gh('gh', ['pr', sub, '--repo', repository(), ...args], { cwd });
  const viewOf = async (id: string) => await Promise.resolve(deps.board.call('selfimprovement', 'task.show', { id }));
  const journal = (line: Record<string, unknown>): void => deps.journal({ kind: 'selfimprovement', ...line });

  /** Merges `metadata` into the task, at its current revision. */
  async function remember(id: string, metadata: Record<string, unknown>): Promise<void> {
    const { task } = await viewOf(id);
    await Promise.resolve(deps.board.call('selfimprovement', 'task.update', { id, revision: task.revision, metadata }));
  }

  /** The task failed or was refused: closed `failed` with the reason, which reaches her outbox. */
  async function close(id: string, status: 'failed' | 'cancelled', reason: string): Promise<void> {
    const { task } = await viewOf(id);
    await Promise.resolve(
      deps.board.call('selfimprovement', 'task.transition', {
        id,
        status,
        close_reason: reason,
        revision: task.revision,
      })
    );
  }

  const fixesIn = async (status: string): Promise<Array<TaskRecord>> =>
    (
      await Promise.resolve(deps.board.call('selfimprovement', 'task.list', { requester: SELF, status, lane: 'dev' }))
    ).filter((task) => task.metadata?.kind === 'fix');

  async function intake(): Promise<Array<string>> {
    const taken: Array<string> = [];
    for (const task of await fixesIn('proposed')) {
      const { role, budget, steps, estimate } = deps.triage();
      try {
        await Promise.resolve(
          deps.board.call('selfimprovement', 'task.transition', {
            id: task.id,
            status: 'triaged',
            revision: task.revision,
            set: { role, budget, steps, estimate, risk: 'low' },
          })
        );
        await Promise.resolve(
          deps.board.call('selfimprovement', 'task.approve', { id: task.id, scope: 'plan', note: 'selfimprovement' })
        );
        taken.push(task.id);
        journal({ event: 'intake', taskId: task.id });
      } catch (error) {
        journal({ event: 'intake-failed', taskId: task.id, code: codeOf(error) });
      }
    }
    return taken;
  }

  async function work(): Promise<Array<AttemptReport>> {
    const reports: Array<AttemptReport> = [];
    const approved = await Promise.resolve(
      deps.board.call('selfimprovement', 'task.list', { requester: SELF, status: 'approved', lane: 'dev', ready: true })
    );
    for (const task of approved) {
      if (task.metadata?.kind !== 'fix') continue;
      const report = await attempt(task.id).catch((error: unknown) => failedAttempt(task.id, error));
      journal({ event: 'attempt', taskId: task.id, outcome: report.outcome, reason: report.reason });
      reports.push(report);
    }
    return reports;
  }

  /** An attempt that threw: the task is closed `failed` if it still can be, so no beat takes it again. */
  async function failedAttempt(id: string, error: unknown): Promise<AttemptReport> {
    const reason = `error: ${codeOf(error)}`;
    await close(id, 'failed', reason).catch(() => undefined);
    return { taskId: id, outcome: 'failed', branch: null, pr: null, reason };
  }

  /** One fix, from the claim to the submitted pull request. */
  async function attempt(id: string): Promise<AttemptReport> {
    const claimed = await Promise.resolve(
      deps.board.call('selfimprovement', 'task.claim', { id, ttl_minutes: LEASE_MINUTES })
    );
    const generation = claimed.lease_generation;
    const renew = setInterval(() => {
      void Promise.resolve(
        deps.board.call('selfimprovement', 'task.heartbeat', { id, generation, ttl_minutes: LEASE_MINUTES })
      ).catch(() => undefined);
    }, RENEW_MINUTES * 60_000);
    renew.unref();
    try {
      return await fix(id, generation);
    } finally {
      clearInterval(renew);
    }
  }

  const stopped = async (
    id: string,
    outcome: 'refused' | 'failed',
    reason: string,
    branch: string | null = null
  ): Promise<AttemptReport> => {
    await close(id, 'failed', reason);
    return { taskId: id, outcome, branch, pr: null, reason };
  };

  async function fix(id: string, generation: number): Promise<AttemptReport> {
    const { task } = await viewOf(id);
    const { base } = deps.settings();
    const branch = `self/${id}`;
    const tree = `${deps.worktreeRoot}/${id}`;
    const added = await deps.git('git', ['worktree', 'add', '-b', branch, tree, base], { cwd: deps.repoDir });
    if (added.code !== 0) return await stopped(id, 'failed', `worktree-failed: ${firstLine(added.stderr)}`);

    const ran = await deps.run({ taskId: id, brief: deps.brief(briefOf(task)), cwd: tree });
    if (!ran.ok) return await stopped(id, 'failed', `run-failed: ${ran.error ?? 'no result'}`, branch);
    const refusal = REFUSED.exec(firstLine(ran.text));
    if (refusal !== null) return await stopped(id, 'refused', `refused: ${refusal[1] || 'no reason given'}`, branch);

    const changed = await commitChanges(tree, task.title, base);
    if (changed.length === 0) return await stopped(id, 'failed', 'no-change', branch);

    const { files, uncovered } = testsFor(changed, (relative) => deps.fileExists(tree, relative));
    const proof = await runTests(tree, files);
    if (proof !== null && !proof.green)
      return await stopped(id, 'failed', `tests-failed: ${proof.test.command}`, branch);

    const pushed = await deps.git('git', ['push', '-u', remoteOf(repository()), branch], { cwd: tree });
    if (pushed.code !== 0) return await stopped(id, 'failed', `push-failed: ${firstLine(pushed.stderr)}`, branch);
    const body = bodyOf(task, changed, proof?.test ?? null, uncovered);
    const opened = await pr(
      'create',
      ['--draft', '--base', base, '--head', branch, '--title', task.title, '--body', body],
      tree
    );
    const url = firstLine(opened.stdout);
    const number = Number(url.split('/').at(-1));
    if (opened.code !== 0) return await stopped(id, 'failed', `gh-failed: ${firstLine(opened.stderr)}`, branch);
    if (!Number.isInteger(number)) return await stopped(id, 'failed', 'gh-failed: no pull request url', branch);

    await remember(id, { pr: { number, url, branch } });
    await Promise.resolve(
      deps.board.call('selfimprovement', 'task.result', { id, generation, kind: 'pr', uri: url, body })
    );
    const handoff: Handoff = {
      result: `Pull request ${url}`,
      evidence: changed,
      artifacts: [branch, url],
      tests: proof === null ? [] : [proof.test],
      open_issues: uncovered.length === 0 ? [] : [`No test covers: ${uncovered.join(', ')}`],
    };
    await Promise.resolve(deps.board.call('selfimprovement', 'task.submit', { id, generation, handoff }));
    return { taskId: id, outcome: 'submitted', branch, pr: number, reason: null };
  }

  /** Commits what the agent left in the worktree; the paths that differ from the base after it. */
  async function commitChanges(tree: string, title: string, base: string): Promise<Array<string>> {
    const status = await deps.git('git', ['status', '--porcelain'], { cwd: tree });
    const left = pathsOfStatus(status.stdout);
    if (left.length > 0) {
      await deps.git('git', ['add', '--', ...left], { cwd: tree });
      await deps.git('git', ['commit', '-m', title], { cwd: tree });
    }
    const diff = await deps.git('git', ['diff', '--name-only', `${base}...HEAD`], { cwd: tree });
    return lines(diff.stdout);
  }

  /** The tests of the touched modules in one call; null when there is none to run. The exit code decides. */
  async function runTests(
    tree: string,
    files: ReadonlyArray<string>
  ): Promise<{ test: HandoffTest; green: boolean } | null> {
    if (files.length === 0) return null;
    const args = ['--test', '--test-reporter=tap', ...files];
    const done = await deps.tests('node', args, { cwd: tree });
    const passed = tapCount(done.stdout, 'pass');
    const failed = tapCount(done.stdout, 'fail');
    return {
      test: { command: `node ${args.join(' ')}`, passed, failed },
      green: done.code === 0 && failed === 0 && passed > 0,
    };
  }

  async function observe(): Promise<Array<Observation>> {
    const seen: Array<Observation> = [];
    const open = await Promise.resolve(deps.board.call('selfimprovement', 'task.list', { status: 'needs_validation' }));
    for (const task of open) {
      const pr = isRecord(task.metadata?.pr) ? task.metadata.pr : null;
      const number = typeof pr?.number === 'number' ? pr.number : null;
      if (number === null || pr?.branch !== `self/${task.id}`) continue;
      const one = await lookAt(task, number).catch((error: unknown) => {
        journal({ event: 'look-failed', taskId: task.id, pr: number, code: codeOf(error) });
        return null;
      });
      if (one !== null) seen.push(one);
    }
    return seen;
  }

  /** One look at one pull request; null when gh could not answer, which the next look tries again. */
  async function lookAt(task: TaskRecord, number: number): Promise<Observation | null> {
    const viewed = await pr(
      'view',
      [String(number), '--json', 'number,state,title,files,statusCheckRollup,headRefName'],
      deps.repoDir
    );
    const pull = viewed.code === 0 ? pullRequestOf(viewed.stdout) : null;
    if (pull === null || pull.branch !== `self/${task.id}`) {
      journal({ event: 'look-failed', taskId: task.id, pr: number, code: 'gh-failed' });
      return null;
    }
    const action = (name: Observation['action']): Observation => ({ taskId: task.id, pr: number, action: name });
    if (pull.state === 'MERGED') {
      const auto = task.metadata?.autoMerge === true;
      await land(task, number, pull, auto ? 'auto' : 'owner');
      if (!auto) await dropBranch(task, number);
      return action(auto ? 'merged-auto' : 'merged-by-owner');
    }
    if (pull.state === 'CLOSED') {
      await close(task.id, 'cancelled', 'pull request closed unmerged');
      journal({ event: 'closed', taskId: task.id, pr: number });
      await dropBranch(task, number);
      return action('closed');
    }
    return await waitingOrRelease(task, number, pull, action);
  }

  async function waitingOrRelease(
    task: TaskRecord,
    number: number,
    pull: PullRequest,
    action: (name: Observation['action']) => Observation
  ): Promise<Observation> {
    const green = pull.checks.length > 0 && pull.checks.every(succeeded);
    if (!green) return action('waiting-ci');
    if (deps.settings().mode !== 'auto') {
      await readyForOwner(task, number);
      return action('waiting-owner');
    }
    // The rule is written down before the merge, so a look that finds the pull request merged after a crash still
    // knows who decided.
    await remember(task.id, { autoMerge: true });
    const merged = await pr('merge', [String(number), '--squash', '--delete-branch'], deps.repoDir);
    if (merged.code !== 0) {
      await remember(task.id, { autoMerge: null });
      journal({ event: 'merge-failed', taskId: task.id, pr: number, code: 'gh-failed' });
      return action('waiting-ci');
    }
    await land(task, number, pull, 'auto');
    return action('merged-auto');
  }

  /** CI is green in `approve` mode: the draft becomes a request to the owner, once. */
  async function readyForOwner(task: TaskRecord, number: number): Promise<void> {
    if (task.metadata?.ready === true) return;
    const done = await pr('ready', [String(number)], deps.repoDir);
    if (done.code !== 0) {
      journal({ event: 'ready-failed', taskId: task.id, pr: number, code: 'gh-failed' });
      return;
    }
    await remember(task.id, { ready: true });
    journal({ event: 'ready', taskId: task.id, pr: number });
  }

  /** The branch is not needed once its pull request ended; a failure is journaled and the next look does not retry. */
  async function dropBranch(task: TaskRecord, number: number): Promise<void> {
    const done = await deps.git('git', ['push', remoteOf(repository()), '--delete', `self/${task.id}`], {
      cwd: deps.repoDir,
    });
    if (done.code !== 0) journal({ event: 'branch-delete-failed', taskId: task.id, pr: number, code: 'git-failed' });
  }

  /** The pull request merged: the task carries what landed, closes `done`, and the journal says who decided. */
  async function land(task: TaskRecord, number: number, pull: PullRequest, by: 'owner' | 'auto'): Promise<void> {
    const landed = { title: pull.title, files: pull.files, pr: number, decidedBy: by };
    await remember(task.id, { ...(by === 'auto' ? { ci: 'green' } : {}), landed, merged: { pr: number, by } });
    await Promise.resolve(deps.board.call('selfimprovement', 'task.review', { id: task.id, decision: 'accept' }));
    journal({ event: 'merged', taskId: task.id, pr: number, decidedBy: by, files: pull.files.length });
  }

  async function beat(): Promise<BeatReport> {
    const check = await deps.check().catch((): RepositoryCheck => ({ code: 'failed', line: 'failed' }));
    if (check.code !== 'ok') {
      journal({ event: 'paused', code: check.code });
      return { check, taken: [], reports: [], seen: [] };
    }
    const taken = await intake();
    const reports = await work();
    const seen = await observe();
    return { check, taken, reports, seen };
  }

  return { intake, work, observe, beat };
}

/** The brief's fields from a task as the board holds it. */
function briefOf(task: TaskRecord): FixBrief {
  const meta = task.metadata ?? {};
  return {
    id: task.id,
    title: task.title,
    evidence: task.description ?? '',
    acceptance: task.acceptance,
    examples: stringsOf(meta.examples),
    counterexamples: stringsOf(meta.counterexamples),
    benefit: typeof meta.benefit === 'string' ? meta.benefit : '',
    evaluation: typeof meta.evaluation === 'string' ? meta.evaluation : '',
  };
}

/** The pull request body: the evidence, the paths, the engine's own test counts and the task. */
function bodyOf(
  task: TaskRecord,
  changed: ReadonlyArray<string>,
  test: HandoffTest | null,
  uncovered: ReadonlyArray<string>
): string {
  const tests = test === null ? 'No test ran.' : `\`${test.command}\`: ${test.passed} passed, ${test.failed} failed.`;
  const open = uncovered.length === 0 ? '' : `\n\nNo test covers: ${uncovered.join(', ')}`;
  return [
    task.description ?? '',
    `Changed files:\n${changed.map((one) => `- ${one}`).join('\n')}`,
    `${tests}${open}`,
    `Task ${task.id}, filed by her through board.propose.`,
  ].join('\n\n');
}

/** A short code for a thrown value: a board error's code, else its first line. */
function codeOf(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string') return error.code;
  return error instanceof Error ? firstLine(error.message) : 'unknown';
}
