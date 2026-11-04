// The development worker (docs/selfimprovement.md): a filed task starts development, and everything goes through the
// board. `wake`, run by `serveDevelopment` at each batch of board events, takes her `fix` and `skill` proposals to
// approved at risk `low`, starts one thinker run for each approved top-level dev task in that task's own branch and
// worktree, starts one dev run at a time for each dev task under it, and looks at the open pull requests.
//
// The thinker works in one-shot turns: a turn that ends with its task in_progress and nothing open means finished, and
// code then commits what is left, runs the tests of the touched modules, pushes and opens the pull request as a draft.
// A turn that filed dev tasks waits for them under the task's lease and gets another turn when the last one closed. A
// question or a block ends the turn and the task waits on the board. Each dev run's work is merged into the task's
// branch, and the dev task closes through the machine's `child` rule.
//
// Merging a pull request is this file's gate and no agent's: green checks on the persisted head, then `gh pr merge
// --match-head-commit`, only with `selfimprovement.mode` `auto`. `approve` marks the draft ready and waits for the owner.
//
// Recovery is the short lease with renewal: nothing here remembers a process across a restart. systemd's default
// KillMode takes the agents with the worker, the lease lapses, the reaper returns the task to approved, and the next
// claim finds the branch, the worktree and the pull request in `metadata.development`.
//
// `settings().startedAt` is the boundary of the first start: a task approved before it, or a proposal filed before it,
// is listed in `heldBack` and never started, unless the worker began it already or the owner admitted it with
// `metadata.admitted`.
//
// Git, gh, the test runner, the board and the agent runs are injected. The journal carries ids, counts and codes.

import type { BoardOp, BoardResults, Handoff, HandoffTest, TaskRecord, TaskView } from '../board/board.ts';
import { CLOSED } from '../board/machine.ts';
import type { BackendResult } from '../agent-runner/backend.ts';
import type { RepositoryCheck } from '../selfimprovement/repository.ts';
import type { SelfimprovementSettings } from '../selfimprovement/settings.ts';
import type { AgentRun } from '../subharness/run.ts';
import type { BoardCaller } from '../tools/impl/board.ts';
import { firstLine, linesOf, listedPullRequest, pathsOfStatus, pullRequestOf, tapCount, testsFor } from './changes.ts';
import type { PullRequest } from './changes.ts';

export type ExecResult = { code: number; stdout: string; stderr: string };
/** One command, never a shell. The engine passes it three ways: git, gh and the test runner. */
export type Exec = (file: string, args: ReadonlyArray<string>, options: { cwd: string }) => Promise<ExecResult>;
export type DevelopmentAgent = 'thinker' | 'dev';
/** A dev task as the thinker's next brief shows it. */
export type ChildReport = {
  id: string;
  title: string;
  status: string;
  closeReason: string | null;
  /** The dev run's final message. */
  report: string | null;
};
/** What one agent's brief is written from. */
export type DevelopmentBrief = {
  agent: DevelopmentAgent;
  task: TaskView;
  branch: string;
  generation: number;
  children: ReadonlyArray<ChildReport>;
};
/** What the seam of a skill task answers: the package waits for the owner, or why it does not. */
export type SkillPackageAnswer = { code: 'pending' } | { code: 'refused'; reason: string };

/** Read at each use. The last two are absent only where nothing bounds them: a test of something else. */
export type DevelopmentWorkerSettings = Pick<SelfimprovementSettings, 'mode' | 'base' | 'repository'> & {
  thinkerTurns?: number;
  startedAt?: string | null;
};

export type DevelopmentDeps = {
  /** called as the builtin principal `development` (roles reviewer, worker) */
  board: BoardCaller;
  runAgent(run: AgentRun): Promise<BackendResult>;
  /** the model-facing text lives in prompts/, never in src/ */
  brief(brief: DevelopmentBrief): string;
  /** what the agent's child gets beyond the engine's own PATH and key */
  agentEnv(agent: DevelopmentAgent, taskId: string): Record<string, string>;
  git: Exec;
  gh: Exec;
  tests: Exec;
  settings(): DevelopmentWorkerSettings;
  /** the push-right check before a top-level task claims any work */
  check(): Promise<RepositoryCheck>;
  /** `boardSettings(config).autoTriage` */
  triage(): { role: string; budget: number; steps: number; estimate: number };
  /** the seam of a skill task; the worker knows no more of a package than this answer */
  packageSkill(request: { task: TaskRecord; tree: string }): Promise<SkillPackageAnswer>;
  journal(line: Record<string, unknown>): void;
  fileExists(dir: string, relativePath: string): boolean;
  /** the checkout the worktrees hang off */
  repoDir: string;
  /** the folder that holds one directory per task */
  worktreeRoot: string;
  /** how long one agent run may take before its process group is killed (ms) */
  runTimeoutMs: number;
  leaseMinutes: number;
  leaseRenewMs: number;
};

export type WakeReport = {
  started: Array<{ taskId: string; agent: DevelopmentAgent }>;
  /** the open pull requests the worker keeps looking at */
  watching: number;
  /** the tasks older than the boundary, which wait for the owner */
  heldBack?: Array<string>;
};

export type DevelopmentWorker = {
  /** One pass over the board. Resolves once every agent it starts has been handed its run. */
  wake(): Promise<WakeReport>;
  /** Resolves when no agent of this worker runs and no finish is in flight. */
  idle(): Promise<void>;
  /** Stops every run of this worker; the leases lapse and the next start recovers the tasks. */
  stop(): Promise<void>;
};

/** `metadata.development`: where a task's work is, kept for the next claim. */
type Development = {
  branch: string;
  worktree: string;
  pr: number | null;
  head: string | null;
  /** The thinker turns taken since the task last started or blocked. */
  turns: number;
  /** The questions answered when the last thinker turn started. */
  answered: number;
};

/** A task this process holds the lease of: running an agent or waiting for its dev tasks. */
type Held = {
  id: string;
  generation: number;
  agent: DevelopmentAgent;
  parent: string | null;
  branch: string;
  tree: string;
  answered: number;
  controller: AbortController;
  renew: NodeJS.Timeout;
  run: Promise<void> | null;
};

const PRINCIPAL = 'development';
const SELF = 'persona:self';
const THINKER_TURNS_DEFAULT = 12;
/** How often a write that lost to another writer's revision tries again. */
const STALE_TRIES = 3;
const PROPOSAL_KINDS: ReadonlyArray<unknown> = ['fix', 'skill'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The board's code of a refusal: a BoardError's own, or the `<status>: <text>` of the socket's caller. */
function codeOf(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string') return error.code;
  const message = error instanceof Error ? error.message : String(error);
  return /^([a-z-]+): /.exec(message)?.[1] ?? firstLine(message);
}

/** Whether the link to the core is gone, which only a restart of the worker mends. */
const isLinkLost = (error: unknown): boolean => ['unavailable', 'board-unavailable'].includes(codeOf(error));

function developmentOf(task: TaskRecord): Development | null {
  const saved = task.metadata?.development;
  if (!isRecord(saved) || typeof saved.branch !== 'string' || typeof saved.worktree !== 'string') return null;
  return {
    branch: saved.branch,
    worktree: saved.worktree,
    pr: typeof saved.pr === 'number' ? saved.pr : null,
    head: typeof saved.head === 'string' ? saved.head : null,
    turns: typeof saved.turns === 'number' ? saved.turns : 0,
    answered: typeof saved.answered === 'number' ? saved.answered : 0,
  };
}

const parentOf = (view: TaskView): string | null => {
  const row = view.dependencies.find((one) => one.type === 'parent-child');
  return typeof row?.depends_on_id === 'string' ? row.depends_on_id : null;
};

const childIdsOf = (view: TaskView): Array<string> =>
  view.dependents.filter((one) => one.type === 'parent-child').map((one) => String(one.task_id));

const answeredIn = (view: TaskView): number => view.questions.filter((one) => Boolean(one.answered_at)).length;

const isClosed = (status: TaskRecord['status']): boolean => CLOSED.includes(status);

/** The push URL of `owner/name`. */
const remoteOf = (repository: string): string => `https://github.com/${repository}.git`;
/** Where the fetch keeps the remote's base: never checked out, so git never refuses to move it. */
const trackingRefOf = (base: string): string => `refs/remotes/development/${base}`;

/** Whether `at` lies before the boundary; with no boundary nothing does. */
const predates = (at: string, startedAt: string | null | undefined): boolean =>
  startedAt != null && Date.parse(at) < Date.parse(startedAt);

/** Whether a ready top-level task waits for the owner: approved before the boundary, not begun, not admitted. */
function isHeldBack(view: TaskView, startedAt: string | null | undefined): boolean {
  const { task } = view;
  if (developmentOf(task) !== null || task.metadata?.admitted != null) return false;
  const approvals = view.approvals.filter((one) => one.decision === 'approve' && one.scope === 'plan');
  const at = approvals.at(-1)?.created_at;
  return predates(typeof at === 'string' ? at : task.created_at, startedAt);
}

/**
 * The tasks the boundary holds back, for the owner's `neptunia worker development held`: the ready top-level dev tasks
 * and her proposals of a kind, older than `startedAt` and neither begun nor admitted.
 */
export async function listHeldBack(board: BoardCaller, startedAt: string | null): Promise<Array<TaskRecord>> {
  const held: Array<TaskRecord> = [];
  for (const task of await board.call(PRINCIPAL, 'task.list', { lane: 'dev', ready: true })) {
    const view = await board.call(PRINCIPAL, 'task.show', { id: task.id });
    if (parentOf(view) === null && isHeldBack(view, startedAt)) held.push(task);
  }
  const proposed = await board.call(PRINCIPAL, 'task.list', { requester: SELF, status: 'proposed', lane: 'dev' });
  return [
    ...held,
    ...proposed.filter((task) => PROPOSAL_KINDS.includes(task.metadata?.kind) && predates(task.created_at, startedAt)),
  ];
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
    `Task ${task.id}, filed by ${task.requester}.`,
  ].join('\n\n');
}

const handoffOf = (result: string, over: Partial<Handoff> = {}): Handoff => ({
  result,
  evidence: [],
  artifacts: [],
  tests: [],
  open_issues: [],
  ...over,
});

/** One worker's state: the leases it holds, its runs in flight and the timers that renew them. */
class Worker {
  readonly deps: DevelopmentDeps;
  readonly held = new Map<string, Held>();
  readonly inFlight = new Set<Promise<void>>();
  readonly devClosings = new Set<Promise<void>>();
  readonly toldHeldBack = new Set<string>();
  isStopping = false;

  constructor(deps: DevelopmentDeps) {
    this.deps = deps;
  }

  journal(line: Record<string, unknown>): void {
    this.deps.journal({ kind: 'development', ...line });
  }

  async call<TOp extends BoardOp>(op: TOp, args: Readonly<Record<string, unknown>> = {}): Promise<BoardResults[TOp]> {
    return await this.deps.board.call(PRINCIPAL, op, args);
  }

  async show(id: string): Promise<TaskView> {
    return await this.call('task.show', { id });
  }

  /** One write at the task's current revision, tried again when another writer got in between. */
  async atRevision(id: string, write: (revision: number) => Promise<unknown>): Promise<void> {
    for (let tries = 1; ; tries += 1) {
      const { task } = await this.show(id);
      try {
        await write(task.revision);
        return;
      } catch (error) {
        if (codeOf(error) !== 'stale' || tries >= STALE_TRIES) throw error;
      }
    }
  }

  async remember(id: string, metadata: Record<string, unknown>): Promise<void> {
    await this.atRevision(id, (revision) => this.call('task.update', { id, revision, metadata }));
  }

  async rememberDevelopment(id: string, development: Development): Promise<void> {
    await this.remember(id, { development });
  }

  async close(id: string, status: 'failed' | 'cancelled', reason: string): Promise<void> {
    await this.atRevision(id, (revision) =>
      this.call('task.transition', { id, status, close_reason: reason, revision })
    );
  }

  repository(): string {
    const named = this.deps.settings().repository;
    if (named === null) throw new Error('selfimprovement.repository is unset; run neptunia setup to name it');
    return named;
  }

  async pr(sub: string, args: ReadonlyArray<string>): Promise<ExecResult> {
    return await this.deps.gh('gh', ['pr', sub, '--repo', this.repository(), ...args], { cwd: this.deps.repoDir });
  }

  async git(args: ReadonlyArray<string>, cwd: string): Promise<ExecResult> {
    return await this.deps.git('git', args, { cwd });
  }

  // ---------- holding a lease ----------

  hold(entry: Omit<Held, 'controller' | 'renew' | 'run'>): Held {
    const renew = setInterval(() => {
      this.call('task.heartbeat', {
        id: entry.id,
        generation: entry.generation,
        ttl_minutes: this.deps.leaseMinutes,
      }).catch((error: unknown) => this.journal({ event: 'renew-failed', taskId: entry.id, code: codeOf(error) }));
    }, this.deps.leaseRenewMs);
    renew.unref();
    const one: Held = { ...entry, controller: new AbortController(), renew, run: null };
    this.held.set(entry.id, one);
    return one;
  }

  drop(entry: Held): void {
    clearInterval(entry.renew);
    if (this.held.get(entry.id) === entry) this.held.delete(entry.id);
  }

  /** The claim of `id`, or null when another worker won it or a blocker opened. */
  async claim(id: string): Promise<TaskRecord | null> {
    try {
      return await this.call('task.claim', { id, ttl_minutes: this.deps.leaseMinutes });
    } catch (error) {
      if (['claimed', 'blocked', 'invalid-transition'].includes(codeOf(error))) return null;
      throw error;
    }
  }

  async failAndDrop(entry: Held, reason: string): Promise<void> {
    await this.close(entry.id, 'failed', reason);
    this.journal({ event: 'failed', taskId: entry.id, reason: firstLine(reason) });
    this.drop(entry);
  }

  // ---------- the worktree of a task ----------

  /**
   * The task's worktree in place: there already, or added back on its branch, or new. Null when it is in place, else why
   * it cannot be. `start` is what a new branch forks from; a top-level task's base is fetched first, because a long-lived
   * worker's local ref goes stale.
   */
  async placeTree(
    where: { branch: string; tree: string },
    start: { kind: 'base'; base: string } | { kind: 'branch'; branch: string },
    wasPlaced: boolean
  ): Promise<string | null> {
    const { branch, tree } = where;
    const listed = await this.git(['worktree', 'list', '--porcelain'], this.deps.repoDir);
    if (linesOf(listed.stdout).includes(`worktree ${tree}`)) return null;
    const known = await this.git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], this.deps.repoDir);
    if (known.code === 0) {
      const back = await this.git(['worktree', 'add', tree, branch], this.deps.repoDir);
      return back.code === 0 ? null : `worktree-failed: ${firstLine(back.stderr)}`;
    }
    if (wasPlaced) return `branch-gone: ${branch}`;
    if (start.kind === 'branch') {
      const added = await this.git(['worktree', 'add', '-b', branch, tree, start.branch], this.deps.repoDir);
      return added.code === 0 ? null : `worktree-failed: ${firstLine(added.stderr)}`;
    }
    const tracking = trackingRefOf(start.base);
    const refspec = `+refs/heads/${start.base}:${tracking}`;
    const fetched = await this.git(['fetch', remoteOf(this.repository()), refspec], this.deps.repoDir);
    if (fetched.code !== 0) return `fetch-failed: ${firstLine(fetched.stderr)}`;
    const added = await this.git(['worktree', 'add', '-b', branch, tree, start.base], this.deps.repoDir);
    if (added.code !== 0) return `worktree-failed: ${firstLine(added.stderr)}`;
    const moved = await this.git(['reset', '--hard', tracking], tree);
    return moved.code === 0 ? null : `worktree-failed: ${firstLine(moved.stderr)}`;
  }

  /** Commits what the agent left in `tree`; why it could not, else null. */
  async commitLeftovers(tree: string, title: string): Promise<string | null> {
    const status = await this.git(['status', '--porcelain'], tree);
    const left = pathsOfStatus(status.stdout);
    if (left.length === 0) return null;
    const added = await this.git(['add', '--', ...left], tree);
    if (added.code !== 0) return `commit-failed: ${firstLine(added.stderr)}`;
    const committed = await this.git(['commit', '-m', title], tree);
    return committed.code === 0 ? null : `commit-failed: ${firstLine(committed.stderr)}`;
  }

  // ---------- agent runs ----------

  launch(entry: Held, brief: DevelopmentBrief, after: (done: BackendResult) => Promise<void>): void {
    const running = (async () => {
      const done = await this.deps.runAgent({
        agent: entry.agent,
        brief: this.deps.brief(brief),
        cwd: entry.tree,
        timeoutMs: this.deps.runTimeoutMs,
        signal: entry.controller.signal,
        env: this.deps.agentEnv(entry.agent, entry.id),
      });
      const closing = after(done);
      // A dev run's close is short, and the next thinker turn depends on it; a thinker's finish runs tests and waits for nobody.
      if (entry.agent === 'dev') this.devClosings.add(closing);
      try {
        await closing;
      } finally {
        this.devClosings.delete(closing);
      }
    })()
      .catch(async (error: unknown) => {
        this.journal({ event: 'run-error', taskId: entry.id, code: codeOf(error) });
        if (!entry.controller.signal.aborted)
          await this.failAndDrop(entry, `error: ${codeOf(error)}`).catch(() => undefined);
      })
      .finally(() => {
        entry.run = null;
        this.inFlight.delete(running);
      });
    entry.run = running;
    this.inFlight.add(running);
  }

  /** What an ended run leaves to do: null when the run was stopped or the task moved on, so nothing may be written. */
  async viewAfterRun(entry: Held, done: BackendResult): Promise<TaskView | null> {
    if (entry.controller.signal.aborted) {
      this.drop(entry);
      return null;
    }
    const view = await this.show(entry.id);
    if (view.task.lease_generation !== entry.generation || view.task.status !== 'in_progress') {
      this.drop(entry);
      return null;
    }
    if (!done.ok) {
      await this.failAndDrop(entry, `run-failed: ${done.error ?? `exit ${String(done.exitCode)}`}`);
      return null;
    }
    const uncommitted = await this.commitLeftovers(entry.tree, view.task.title);
    if (uncommitted !== null) {
      await this.failAndDrop(entry, uncommitted);
      return null;
    }
    return view;
  }

  async childReports(view: TaskView): Promise<Array<ChildReport>> {
    const reports: Array<ChildReport> = [];
    for (const id of childIdsOf(view)) {
      const child = await this.show(id);
      const last = child.results.at(-1)?.body;
      reports.push({
        id,
        title: child.task.title,
        status: child.task.status,
        closeReason: child.task.close_reason,
        report: typeof last === 'string' ? last : null,
      });
    }
    return reports;
  }

  /** The next thinker turn, or the block once the task has had its turns. */
  async startTurn(entry: Held, started: WakeReport['started']): Promise<void> {
    const view = await this.show(entry.id);
    const saved = developmentOf(view.task);
    if (saved === null) throw new Error(`task ${entry.id} has no development record to run a turn on`);
    const limit = this.deps.settings().thinkerTurns ?? THINKER_TURNS_DEFAULT;
    if (saved.turns >= limit) {
      await this.rememberDevelopment(entry.id, { ...saved, turns: 0 });
      await this.call('task.block', {
        id: entry.id,
        generation: entry.generation,
        reason: `thinker-turns: ${limit} turns ended with work still open`,
        unblocks: 'board.unblock with a decision',
      });
      this.journal({ event: 'blocked', taskId: entry.id, reason: 'thinker-turns' });
      this.drop(entry);
      return;
    }
    entry.answered = answeredIn(view);
    await this.rememberDevelopment(entry.id, { ...saved, turns: saved.turns + 1, answered: entry.answered });
    const brief: DevelopmentBrief = {
      agent: 'thinker',
      task: await this.show(entry.id),
      branch: entry.branch,
      generation: entry.generation,
      children: await this.childReports(view),
    };
    started.push({ taskId: entry.id, agent: 'thinker' });
    this.launch(entry, brief, (done) => this.afterTurn(entry, done));
  }

  /** Whether any dev task under `view` is still open. */
  async hasOpenChildren(view: TaskView): Promise<boolean> {
    for (const id of childIdsOf(view)) if (!isClosed((await this.show(id)).task.status)) return true;
    return false;
  }

  async afterTurn(entry: Held, done: BackendResult): Promise<void> {
    const view = await this.viewAfterRun(entry, done);
    if (view === null) return;
    const saved = developmentOf(view.task);
    if (saved === null) return await this.failAndDrop(entry, `no-record: ${entry.id}`);
    if ((await this.hasOpenChildren(view)) || answeredIn(view) > entry.answered) {
      // The write is what wakes the worker's loop: nothing else marks that this turn ended.
      await this.rememberDevelopment(entry.id, saved);
      return;
    }
    await this.finish(entry, view, saved);
  }

  async afterDev(entry: Held, done: BackendResult): Promise<void> {
    const view = await this.viewAfterRun(entry, done);
    if (view === null || entry.parent === null) return;
    const parent = developmentOf((await this.show(entry.parent)).task);
    if (parent === null) return await this.failAndDrop(entry, `no-record: ${entry.parent}`);
    const merged = await this.git(['merge', '--no-edit', entry.branch], parent.worktree);
    if (merged.code !== 0) {
      await this.git(['merge', '--abort'], parent.worktree);
      return await this.failAndDrop(
        entry,
        `merge-failed: ${entry.branch}: ${firstLine(merged.stderr || merged.stdout)}`
      );
    }
    if (done.text !== '') {
      await this.call('task.result', { id: entry.id, generation: entry.generation, kind: 'summary', body: done.text });
    }
    await this.atRevision(entry.id, (revision) =>
      this.call('task.transition', { id: entry.id, status: 'done', revision })
    );
    this.drop(entry);
  }

  // ---------- from a finished thinker to a pull request ----------

  async runTests(tree: string, files: ReadonlyArray<string>): Promise<{ test: HandoffTest; isGreen: boolean } | null> {
    if (files.length === 0) return null;
    const args = ['--test', '--test-reporter=tap', ...files];
    const done = await this.deps.tests('node', args, { cwd: tree });
    const passed = tapCount(done.stdout, 'pass');
    const failed = tapCount(done.stdout, 'fail');
    return {
      test: { command: `node ${args.join(' ')}`, passed, failed },
      isGreen: done.code === 0 && failed === 0 && passed > 0,
    };
  }

  async finishSkill(entry: Held, task: TaskRecord): Promise<void> {
    const answer = await this.deps.packageSkill({ task, tree: entry.tree });
    if (answer.code === 'refused') return await this.failAndDrop(entry, `skill-refused: ${answer.reason}`);
    const handoff = handoffOf(`Skill package of ${task.id} waits for the owner`);
    await this.call('task.submit', { id: entry.id, generation: entry.generation, handoff });
    this.drop(entry);
  }

  async finish(entry: Held, view: TaskView, saved: Development): Promise<void> {
    const { task } = view;
    if (task.metadata?.kind === 'skill') return await this.finishSkill(entry, task);
    const { base } = this.deps.settings();
    const diff = await this.git(['diff', '--name-only', `${trackingRefOf(base)}...HEAD`], entry.tree);
    const changed = linesOf(diff.stdout);
    if (changed.length === 0) return await this.failAndDrop(entry, 'no-change');
    const { files, uncovered } = testsFor(changed, (relative) => this.deps.fileExists(entry.tree, relative));
    const proof = await this.runTests(entry.tree, files);
    if (proof !== null && !proof.isGreen) return await this.failAndDrop(entry, `tests-failed: ${proof.test.command}`);
    const head = firstLine((await this.git(['rev-parse', 'HEAD'], entry.tree)).stdout);
    const pushed = await this.git(['push', '-u', remoteOf(this.repository()), entry.branch], entry.tree);
    if (pushed.code !== 0) return await this.failAndDrop(entry, `push-failed: ${firstLine(pushed.stderr)}`);
    const body = bodyOf(task, changed, proof?.test ?? null, uncovered);
    const opened = await this.pr('create', [
      '--draft',
      '--base',
      base,
      '--head',
      entry.branch,
      '--title',
      task.title,
      '--body',
      body,
    ]);
    if (opened.code !== 0) return await this.failAndDrop(entry, `gh-failed: ${firstLine(opened.stderr)}`);
    const url = firstLine(opened.stdout);
    const number = Number(url.split('/').at(-1));
    if (!Number.isInteger(number)) return await this.failAndDrop(entry, 'gh-failed: no pull request url');
    await this.rememberDevelopment(entry.id, { ...saved, pr: number, head });
    await this.call('task.result', { id: entry.id, generation: entry.generation, kind: 'pr', uri: url, body });
    const handoff = handoffOf(`Pull request ${url}`, {
      evidence: changed,
      artifacts: [entry.branch, url],
      tests: proof === null ? [] : [proof.test],
      open_issues: uncovered.length === 0 ? [] : [`No test covers: ${uncovered.join(', ')}`],
    });
    await this.call('task.submit', { id: entry.id, generation: entry.generation, handoff });
    this.journal({ event: 'submitted', taskId: entry.id, pr: number, files: changed.length });
    this.drop(entry);
  }

  /** A claimed task whose pull request exists: straight to waiting on it, with no agent. */
  async submitFound(id: string, generation: number, url: string): Promise<void> {
    await this.call('task.result', { id, generation, kind: 'pr', uri: url });
    await this.call('task.submit', { id, generation, handoff: handoffOf(`Pull request ${url}`, { artifacts: [url] }) });
  }

  // ---------- starting tasks ----------

  /** A claimed top-level task: its pull request if it has one, else its worktree and a thinker turn or the wait. */
  async enterTop(claimed: TaskRecord, started: WakeReport['started']): Promise<void> {
    const { id, lease_generation: generation } = claimed;
    const saved = developmentOf(claimed);
    const name = this.repository();
    if (saved?.pr != null) {
      return await this.submitFound(id, generation, `https://github.com/${name}/pull/${saved.pr}`);
    }
    if (saved !== null) {
      const listed = await this.pr('list', [
        '--head',
        saved.branch,
        '--state',
        'all',
        '--json',
        'number,url,headRefOid',
      ]);
      const found = listed.code === 0 ? listedPullRequest(listed.stdout) : null;
      if (found !== null) {
        await this.rememberDevelopment(id, { ...saved, pr: found.number, head: found.head });
        return await this.submitFound(id, generation, found.url);
      }
    }
    const branch = saved?.branch ?? `self/${id}`;
    const tree = saved?.worktree ?? `${this.deps.worktreeRoot}/${id}`;
    const placed = await this.placeTree(
      { branch, tree },
      { kind: 'base', base: this.deps.settings().base },
      saved !== null
    );
    if (placed !== null) {
      await this.close(id, 'failed', placed);
      this.journal({ event: 'failed', taskId: id, reason: firstLine(placed) });
      return;
    }
    if (saved === null) {
      await this.rememberDevelopment(id, { branch, worktree: tree, pr: null, head: null, turns: 0, answered: 0 });
    }
    const entry = this.hold({
      id,
      generation,
      agent: 'thinker',
      parent: null,
      branch,
      tree,
      answered: saved?.answered ?? 0,
    });
    // An unanswered wait on dev tasks of an earlier run goes on under this claim.
    if (!(await this.hasOpenChildren(await this.show(id)))) await this.startTurn(entry, started);
  }

  /** One dev run for a ready dev task, when its task is held, its thinker is between turns and no other dev runs. */
  async startChild(view: TaskView, parentId: string, started: WakeReport['started']): Promise<void> {
    const { id } = view.task;
    const parent = await this.show(parentId);
    if (isClosed(parent.task.status)) return await this.close(id, 'cancelled', `parent-closed: ${parentId}`);
    const saved = developmentOf(parent.task);
    if (parent.task.status !== 'in_progress' || saved === null) return;
    if (this.held.get(parentId)?.run != null) return;
    if ([...this.held.values()].some((one) => one.parent === parentId)) return;
    const claimed = await this.claim(id);
    if (claimed === null) return;
    const own = developmentOf(claimed);
    const branch = own?.branch ?? `self/${parentId}-${id}`;
    const tree = own?.worktree ?? `${this.deps.worktreeRoot}/${parentId}-${id}`;
    const placed = await this.placeTree({ branch, tree }, { kind: 'branch', branch: saved.branch }, own !== null);
    if (placed !== null) {
      await this.close(id, 'failed', placed);
      return;
    }
    if (own === null) {
      await this.rememberDevelopment(id, { branch, worktree: tree, pr: null, head: null, turns: 0, answered: 0 });
    }
    const generation = claimed.lease_generation;
    const entry = this.hold({ id, generation, agent: 'dev', parent: parentId, branch, tree, answered: 0 });
    const brief: DevelopmentBrief = {
      agent: 'dev',
      task: await this.show(id),
      branch,
      generation,
      children: [],
    };
    started.push({ taskId: id, agent: 'dev' });
    this.launch(entry, brief, (done) => this.afterDev(entry, done));
  }

  /** Her `fix` and `skill` proposals to approved at risk `low`: nothing lands without a merge. */
  async intake(heldBack: Array<string>): Promise<void> {
    const proposed = await this.call('task.list', { requester: SELF, status: 'proposed', lane: 'dev' });
    for (const task of proposed) {
      if (!PROPOSAL_KINDS.includes(task.metadata?.kind)) continue;
      if (predates(task.created_at, this.deps.settings().startedAt)) {
        heldBack.push(task.id);
        continue;
      }
      const { role, budget, steps, estimate } = this.deps.triage();
      await this.call('task.transition', {
        id: task.id,
        status: 'triaged',
        revision: task.revision,
        set: { role, budget, steps, estimate, risk: 'low' },
      });
      await this.call('task.approve', { id: task.id, scope: 'plan', note: PRINCIPAL });
      this.journal({ event: 'intake', taskId: task.id });
    }
  }

  async startReady(started: WakeReport['started'], heldBack: Array<string>): Promise<void> {
    const ready = await this.call('task.list', { lane: 'dev', ready: true });
    let access: RepositoryCheck | null = null;
    for (const { id } of ready) {
      const view = await this.show(id);
      const parent = parentOf(view);
      if (parent !== null) {
        await this.startChild(view, parent, started);
        continue;
      }
      if (isHeldBack(view, this.deps.settings().startedAt)) {
        heldBack.push(id);
        continue;
      }
      access ??= await this.deps.check().catch((): RepositoryCheck => ({ code: 'failed', line: 'failed' }));
      const claimed = await this.claim(id);
      if (claimed === null) continue;
      if (access.code !== 'ok') {
        await this.call('task.block', {
          id,
          generation: claimed.lease_generation,
          reason: access.line,
          unblocks: access.code,
        });
        this.journal({ event: 'blocked', taskId: id, reason: access.code });
        continue;
      }
      await this.enterTop(claimed, started);
    }
  }

  /** An answered question leaves its task in_progress with no run: the release hands it to one claim, of one worker. */
  async releaseAnswered(): Promise<void> {
    for (const task of await this.call('task.list', { lane: 'dev', status: 'in_progress' })) {
      const saved = developmentOf(task);
      if (this.held.has(task.id) || task.lease_owner !== PRINCIPAL || saved === null) continue;
      if (answeredIn(await this.show(task.id)) <= saved.answered) continue;
      try {
        await this.call('task.release', { id: task.id, generation: task.lease_generation });
      } catch (error) {
        if (!['stale-lease', 'invalid-transition', 'forbidden'].includes(codeOf(error))) throw error;
      }
    }
  }

  /** A thinker between turns goes on once its dev tasks closed. */
  async nextTurns(started: WakeReport['started']): Promise<void> {
    await Promise.allSettled([...this.devClosings]);
    for (const entry of [...this.held.values()]) {
      if (entry.agent !== 'thinker' || entry.run !== null) continue;
      if (!(await this.hasOpenChildren(await this.show(entry.id)))) await this.startTurn(entry, started);
    }
  }

  /** Stops what the board took away: a closed task, a lapsed lease, a released one; and a closed task's dev tasks. */
  async reconcile(): Promise<void> {
    for (const entry of [...this.held.values()]) {
      if (entry.parent !== null) continue;
      const view = await this.show(entry.id);
      if (!isClosed(view.task.status)) continue;
      for (const id of childIdsOf(view)) {
        if (!isClosed((await this.show(id)).task.status))
          await this.close(id, 'cancelled', `parent-closed: ${entry.id}`);
      }
    }
    for (const entry of [...this.held.values()]) {
      const { task } = await this.show(entry.id);
      const isGone = isClosed(task.status) || task.status === 'approved' || task.lease_generation !== entry.generation;
      if (!isGone) continue;
      entry.controller.abort();
      if (entry.run === null) this.drop(entry);
      else await entry.run;
    }
  }

  // ---------- pull requests ----------

  async land(task: TaskRecord, number: number, pull: PullRequest, by: 'owner' | 'auto'): Promise<void> {
    const landed = { title: pull.title, files: pull.files, pr: number, decidedBy: by };
    await this.remember(task.id, { ...(by === 'auto' ? { ci: 'green' } : {}), landed, merged: { pr: number, by } });
    await this.call('task.review', { id: task.id, decision: 'accept' });
    this.journal({ event: 'merged', taskId: task.id, pr: number, decidedBy: by, files: pull.files.length });
  }

  /** Green at the persisted head: the draft goes ready, and with `auto` this file merges exactly that head. */
  async releaseGreen(task: TaskRecord, number: number, pull: PullRequest, head: string): Promise<void> {
    if (pull.isDraft) {
      const ready = await this.pr('ready', [String(number)]);
      if (ready.code !== 0) return this.journal({ event: 'ready-failed', taskId: task.id, pr: number });
      this.journal({ event: 'ready', taskId: task.id, pr: number });
    }
    if (this.deps.settings().mode !== 'auto') return;
    // The rule is written down before the merge, so a look that finds the pull request merged after a crash still
    // knows who decided.
    await this.remember(task.id, { autoMerge: true });
    const merged = await this.pr('merge', [String(number), '--squash', '--delete-branch', '--match-head-commit', head]);
    if (merged.code !== 0) {
      await this.remember(task.id, { autoMerge: null });
      return this.journal({ event: 'merge-failed', taskId: task.id, pr: number });
    }
    await this.land(task, number, pull, 'auto');
  }

  /** One look at one pull request; whether it is still open and worth another look. */
  async lookAt(task: TaskRecord, saved: Development & { pr: number }): Promise<boolean> {
    const number = saved.pr;
    const viewed = await this.pr('view', [
      String(number),
      '--json',
      'number,state,title,isDraft,files,statusCheckRollup,headRefName,headRefOid',
    ]);
    const pull = viewed.code === 0 ? pullRequestOf(viewed.stdout) : null;
    if (pull === null || pull.branch !== saved.branch) {
      this.journal({ event: 'look-failed', taskId: task.id, pr: number });
      return true;
    }
    if (pull.state === 'MERGED') {
      await this.land(task, number, pull, task.metadata?.autoMerge === true ? 'auto' : 'owner');
      return false;
    }
    if (pull.state === 'CLOSED') {
      await this.close(task.id, 'cancelled', 'pull-request-closed-unmerged');
      this.journal({ event: 'closed', taskId: task.id, pr: number });
      return false;
    }
    if (pull.isGreen && saved.head !== null && pull.head === saved.head) {
      await this.releaseGreen(task, number, pull, saved.head);
    }
    return (await this.show(task.id)).task.status === 'needs_validation';
  }

  async watch(): Promise<number> {
    let watching = 0;
    for (const task of await this.call('task.list', { lane: 'dev', status: 'needs_validation' })) {
      const saved = developmentOf(task);
      if (saved === null || saved.pr === null) continue;
      try {
        if (await this.lookAt(task, { ...saved, pr: saved.pr })) watching += 1;
      } catch (error) {
        if (isLinkLost(error)) throw error;
        this.journal({ event: 'look-failed', taskId: task.id, pr: saved.pr, code: codeOf(error) });
        watching += 1;
      }
    }
    return watching;
  }

  async wake(): Promise<WakeReport> {
    if (this.isStopping) return { started: [], watching: 0 };
    await this.reconcile();
    const heldBack: Array<string> = [];
    await this.intake(heldBack);
    await this.releaseAnswered();
    const started: WakeReport['started'] = [];
    await this.nextTurns(started);
    await this.startReady(started, heldBack);
    const watching = await this.watch();
    for (const id of heldBack) {
      if (!this.toldHeldBack.has(id)) this.journal({ event: 'held-back', taskId: id });
      this.toldHeldBack.add(id);
    }
    return heldBack.length === 0 ? { started, watching } : { started, watching, heldBack };
  }

  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  async stop(): Promise<void> {
    this.isStopping = true;
    for (const entry of this.held.values()) {
      entry.controller.abort();
      clearInterval(entry.renew);
    }
    await Promise.all([...this.inFlight]);
    this.held.clear();
  }
}

export function createDevelopmentWorker(deps: DevelopmentDeps): DevelopmentWorker {
  const worker = new Worker(deps);
  return { wake: () => worker.wake(), idle: () => worker.idle(), stop: () => worker.stop() };
}

/**
 * The worker's loop: a wake, then a wait for the board's next events. The wait has a clock only while a pull request is
 * watched, because a merge on GitHub raises no board event. A lost link ends the loop with its error so systemd restarts
 * the worker; the signal ends it quietly. Every run stops on the way out.
 */
export async function serveDevelopment(options: {
  worker: DevelopmentWorker;
  waitForBoard: (from: number, waitMs: number | null) => Promise<ReadonlyArray<{ seq: number }>>;
  lookEveryMs: () => number;
  signal: AbortSignal;
}): Promise<void> {
  const { worker, waitForBoard, lookEveryMs, signal } = options;
  let from = 0;
  try {
    while (!signal.aborted) {
      const { watching } = await worker.wake();
      const rows = await waitForBoard(from, watching > 0 ? lookEveryMs() : null);
      for (const row of rows) from = Math.max(from, row.seq);
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    await worker.stop();
  }
}
