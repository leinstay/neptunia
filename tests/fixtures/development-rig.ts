// The world of the development worker's tests (src/development/worker.ts): a real task board over a memory database in
// memory, with the core's own builtin principals, and fakes for everything outside the process: git, gh, the test
// runner and the agent runs. Each fake records what it was asked and answers from `world`, which a test edits before
// the step it checks. Nothing here touches the network, a provider or a remote. Synthetic data only.
import fs from 'node:fs';
import path from 'node:path';
import { labelsFileOf } from '../../src/config/labels.ts';
import { openBoard } from '../../src/board/board.ts';
import type { Board, BoardOp, BoardResults, TaskRecord, TaskView } from '../../src/board/board.ts';
import type { BoardDb } from '../../src/board/schema.ts';
import { CORE_BUILTINS } from '../../src/board/writer.ts';
import type { BackendResult } from '../../src/agent-runner/backend.ts';
import { createDevelopmentWorker } from '../../src/development/worker.ts';
import type { DevelopmentDeps, DevelopmentWorker, SkillPackageAnswer } from '../../src/development/worker.ts';
import { checkRepository } from '../../src/selfimprovement/repository.ts';
import type { GhAnswer } from '../../src/selfimprovement/repository.ts';
import type { AgentRun } from '../../src/subharness/run.ts';
import type { BoardCaller } from '../../src/tools/impl/board.ts';
import { freshMemoryDb } from './memory-db-copy.ts';
import { tempDir } from './tmp.ts';

export const T0 = Date.parse('2026-11-04T10:00:00Z');
export const MINUTE = 60_000;
/** The principal the worker calls the board as (`CORE_BUILTINS.development`). */
export const WORKER = 'development';
export const PASSING_TAP = 'TAP version 13\n# tests 3\n# suites 0\n# pass 3\n# fail 0\n';
export const FAILING_TAP = 'TAP version 13\n# tests 3\n# suites 0\n# pass 2\n# fail 1\n';
export const HEAD = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
const ROOT = path.join(import.meta.dirname, '..', '..');
/** The shipped labels of the push-right check, as `hot.prompts.labels` holds them. */
const LABELS = labelsFileOf(JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'labels.json'), 'utf8'))).owner;

export type CheckState = 'SUCCESS' | 'FAILURE' | 'PENDING';
/** What gh says about the repository at the push-right check. */
export type Access = 'ok' | 'gh-missing' | 'gh-logged-out' | 'no-push';
export type AgentName = 'thinker' | 'dev';
/** One agent run as the worker asked for it, and whether the worker stopped it. */
export type RecordedRun = AgentRun & { aborted: boolean };

/** What the fake agent does during its run; its board acts come from here. No answer is a clean exit. */
export type AgentScript = (run: RecordedRun, turn: number) => void | BackendResult | Promise<void | BackendResult>;

export type FakePullRequest = {
  number: number;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft: boolean;
  head: string;
  branch: string;
  base: string;
  repository: string;
  title: string;
  body: string;
  checks: Array<CheckState>;
};

export type DevelopmentWorld = {
  board: Board;
  caller: BoardCaller;
  deps: DevelopmentDeps;
  repoDir: string;
  worktreeRoot: string;
  /** What happened, in order: `check`, `git worktree add`, `run thinker`, `run dev`, `tests`, `git push`, `gh pr create`, `gh pr merge`. */
  order: Array<string>;
  git: Array<{ args: ReadonlyArray<string>; cwd: string }>;
  gh: Array<{ args: ReadonlyArray<string>; cwd: string }>;
  tests: Array<{ file: string; args: ReadonlyArray<string>; cwd: string }>;
  runs: Array<RecordedRun>;
  journal: Array<Record<string, unknown>>;
  mode: 'approve' | 'auto';
  base: string;
  repository: string | null;
  access: Access;
  /** The paths the fake agent leaves changed in its worktree. */
  changed: Array<string>;
  /** The test files that exist in a worktree. */
  existing: Set<string>;
  testRun: { code: number; stdout: string };
  /** The local branches and the worktrees git knows. */
  branches: Set<string>;
  trees: Map<string, string>;
  /** `git rev-parse HEAD` in any worktree. */
  head: string;
  /** The pull request on the fake GitHub; `created` counts every `gh pr create`. */
  pr: FakePullRequest | null;
  created: number;
  /** What `gh pr create` fails with; null lets it succeed. */
  createError: string | null;
  mergeCode: number;
  scripts: Record<AgentName, AgentScript>;
  skillPackages: Array<{ task: TaskRecord; tree: string }>;
  skillAnswer: SkillPackageAnswer;
  /** The next run of `agent` waits for the release this returns, or for its signal. */
  hold(agent: AgentName): () => void;
  advance(ms: number): void;
  worker(): DevelopmentWorker;
  /** The view of a task, as the owner reads it. */
  show(id: string): TaskView;
  gitCalls(first: string): Array<ReadonlyArray<string>>;
  ghPr(sub: string): Array<ReadonlyArray<string>>;
  runsOf(agent: AgentName): Array<RecordedRun>;
};

const flagOf = (args: ReadonlyArray<string>, name: string): string | null => {
  const at = args.indexOf(name);
  return at < 0 ? null : (args[at + 1] ?? null);
};
const ok = (stdout = ''): { code: number; stdout: string; stderr: string } => ({ code: 0, stdout, stderr: '' });
const refused = (stderr: string): { code: number; stdout: string; stderr: string } => ({ code: 1, stdout: '', stderr });

/** `gh pr view --json a,b`: only the fields asked for, as gh answers. */
function viewJson(pr: FakePullRequest, fields: ReadonlyArray<string>, files: ReadonlyArray<string>): string {
  const all: Record<string, unknown> = {
    number: pr.number,
    url: pr.url,
    state: pr.state,
    title: pr.title,
    isDraft: pr.isDraft,
    headRefName: pr.branch,
    headRefOid: pr.head,
    baseRefName: pr.base,
    files: files.map((one) => ({ path: one })),
    statusCheckRollup: pr.checks.map((state, n) => ({
      name: `check-${n}`,
      status: state === 'PENDING' ? 'IN_PROGRESS' : 'COMPLETED',
      conclusion: state === 'PENDING' ? '' : state,
    })),
  };
  return JSON.stringify(Object.fromEntries(fields.map((field) => [field, all[field]])));
}

type GitAnswer = { code: number; stdout: string; stderr: string };

/** `git worktree list` and `git worktree add -b <branch> <tree> <start>` or `add <tree> <branch>`; null for any other. */
function fakeWorktreeCall(world: DevelopmentWorld, args: ReadonlyArray<string>): GitAnswer | null {
  if (args[0] !== 'worktree') return null;
  if (args[1] === 'list') {
    return ok([...world.trees].map(([tree, branch]) => `worktree ${tree}\nbranch refs/heads/${branch}\n`).join('\n'));
  }
  if (args[1] !== 'add') return null;
  world.order.push('git worktree add');
  const hasB = args[2] === '-b';
  const branch = String(args[3]);
  const tree = String(hasB ? args[4] : args[2]);
  if (world.trees.has(tree)) return refused(`fatal: '${tree}' already exists`);
  if (hasB && world.branches.has(branch)) return refused(`fatal: a branch named '${branch}' already exists`);
  if (!hasB && !world.branches.has(branch)) return refused(`fatal: invalid reference: ${branch}`);
  fs.mkdirSync(tree, { recursive: true });
  world.branches.add(branch);
  world.trees.set(tree, branch);
  return ok();
}

/** `git rev-parse`, `git show-ref` and `git branch --list` over the branches the world knows; null for any other. */
function fakeRefCall(world: DevelopmentWorld, args: ReadonlyArray<string>): GitAnswer | null {
  const [first, second] = args;
  if (first === 'rev-parse' && args.includes('HEAD')) return ok(`${world.head}\n`);
  if (first === 'rev-parse' || first === 'show-ref') {
    const name = String(args.at(-1)).replace('refs/heads/', '');
    return world.branches.has(name) ? ok(`${world.head}\n`) : refused('fatal: not a valid ref');
  }
  if (first === 'branch' && second === '--list') {
    const name = String(args[2]);
    return ok(world.branches.has(name) ? `  ${name}\n` : '');
  }
  return null;
}

/** What is left of git: `status` and `diff` answer the changed paths, and a push moves the head of its open pull request. */
function fakeTreeCall(world: DevelopmentWorld, args: ReadonlyArray<string>): GitAnswer {
  const [first] = args;
  if (first === 'status') return ok(world.changed.map((one) => ` M ${one}`).join('\n'));
  if (first === 'diff') {
    return ok(args.includes('-z') ? world.changed.map((one) => `M\0${one}\0`).join('') : world.changed.join('\n'));
  }
  if (first === 'push') {
    world.order.push('git push');
    if (world.pr?.state === 'OPEN' && args.includes(world.pr.branch) && !args.includes('--delete')) {
      world.pr.head = world.head;
    }
  }
  return ok();
}

export function developmentWorld(
  t: { after: (fn: () => void | Promise<void>) => void },
  options: { modules?: boolean } = {}
): DevelopmentWorld {
  const dir = tempDir('nep-development-board-');
  fs.writeFileSync(
    path.join(dir, 'clients.json'),
    JSON.stringify({
      boss: { kind: 'agent', tokenFile: 'clients/boss.token', permissions: [], boardRoles: ['owner'] },
      watcher: { kind: 'agent', tokenFile: 'clients/watcher.token', permissions: [], boardRoles: ['watcher'] },
    })
  );
  const handle = freshMemoryDb();
  t.after(() => handle.close());
  let now = T0;
  const board = openBoard({
    // open.ts types the connection as `object`; it is node:sqlite's DatabaseSync, which has every method BoardDb names.
    db: handle.db as BoardDb,
    privateDir: dir,
    now: () => now,
    settings: () => ({
      leaseTtlMinutes: 30,
      autoTriage: { role: 'dev', budget: 4, steps: 80, estimate: 30 },
      projects: {},
    }),
    builtins: CORE_BUILTINS,
  });
  const caller: BoardCaller = {
    call<TOp extends BoardOp>(
      principal: string,
      op: TOp,
      args?: Readonly<Record<string, unknown>>,
      idempotency?: string | null
    ): BoardResults[TOp] {
      return board.call(principal, op, args, idempotency);
    },
  };
  const repoDir = tempDir('nep-development-repo-');
  // The worker links the checkout's node_modules into each worktree and refuses a checkout without them (placeTree), so the
  // rig's checkout holds a bin the way an installed one does; tests/development-worktree-modules.test.ts covers the rest.
  if (options.modules !== false) fs.mkdirSync(path.join(repoDir, 'node_modules', '.bin'), { recursive: true });
  const worktreeRoot = tempDir('nep-development-trees-');
  const holds: Record<AgentName, Array<Promise<void>>> = { thinker: [], dev: [] };
  const workers: Array<DevelopmentWorker> = [];
  const turns: Record<AgentName, number> = { thinker: 0, dev: 0 };

  const world: DevelopmentWorld = {
    board,
    caller,
    repoDir,
    worktreeRoot,
    order: [],
    git: [],
    gh: [],
    tests: [],
    runs: [],
    journal: [],
    mode: 'approve',
    base: 'main',
    repository: 'example/engine',
    access: 'ok',
    changed: ['src/web/read.ts', 'tests/web-read.test.ts'],
    existing: new Set(['tests/web-read.test.ts', 'tests/unrelated.test.ts']),
    testRun: { code: 0, stdout: PASSING_TAP },
    branches: new Set(['main']),
    trees: new Map(),
    head: HEAD,
    pr: null,
    created: 0,
    createError: null,
    mergeCode: 0,
    scripts: { thinker: () => undefined, dev: () => undefined },
    skillPackages: [],
    skillAnswer: { code: 'pending' },
    hold(agent) {
      let release = (): void => undefined;
      holds[agent].push(
        new Promise<void>((resolve) => {
          release = resolve;
        })
      );
      return () => release();
    },
    advance(ms) {
      now += ms;
    },
    worker() {
      const worker = createDevelopmentWorker(world.deps);
      workers.push(worker);
      return worker;
    },
    show: (id) => board.call('boss', 'task.show', { id }),
    gitCalls: (first) => world.git.filter((call) => call.args[0] === first).map((call) => call.args),
    ghPr: (sub) => world.gh.filter((call) => call.args[0] === 'pr' && call.args[1] === sub).map((call) => call.args),
    runsOf: (agent) => world.runs.filter((run) => run.agent === agent),
    deps: {
      board: caller,
      async runAgent(run) {
        const recorded: RecordedRun = { ...run, aborted: false };
        const agent: AgentName = run.agent === 'thinker' ? 'thinker' : 'dev';
        world.order.push(`run ${agent}`);
        world.runs.push(recorded);
        const held = holds[agent].shift();
        turns[agent] += 1;
        const turn = turns[agent];
        if (held !== undefined) {
          const stopped = new Promise<'stopped'>((resolve) => {
            if (run.signal?.aborted === true) resolve('stopped');
            run.signal?.addEventListener('abort', () => resolve('stopped'));
          });
          if ((await Promise.race([held, stopped])) === 'stopped') {
            recorded.aborted = true;
            return { ok: false, text: '', exitCode: null, error: 'cancelled' };
          }
        }
        const answer = await world.scripts[agent](recorded, turn);
        return answer ?? { ok: true, text: `${agent} finished its turn`, exitCode: 0 };
      },
      brief: ({ agent, task, branch, generation }) =>
        [
          `BRIEF ${agent} ${task.task.id} on ${branch} at ${generation}`,
          task.task.title,
          task.task.description ?? '',
          ...task.questions.map((question) => `answer: ${String(question.answer)}`),
          ...task.comments.map((comment) => `comment: ${comment.text}`),
        ].join('\n'),
      agentEnv(agent, taskId): Record<string, string> {
        return agent === 'thinker' ? { NEPTUNIA_TASK_CLIENT: WORKER, TASK_ID: taskId } : {};
      },
      git(_file, args, options) {
        world.git.push({ args, cwd: options.cwd });
        return Promise.resolve(fakeWorktreeCall(world, args) ?? fakeRefCall(world, args) ?? fakeTreeCall(world, args));
      },
      gh(_file, args, options) {
        world.gh.push({ args, cwd: options.cwd });
        if (args[0] !== 'pr') return Promise.resolve(refused(`unexpected gh ${args.join(' ')}`));
        const repo = flagOf(args, '--repo');
        if (args[1] === 'create') {
          world.order.push('gh pr create');
          world.created += 1;
          if (world.createError !== null) return Promise.resolve(refused(world.createError));
          const number = 12;
          world.pr = {
            number,
            url: `https://github.com/${repo}/pull/${number}`,
            state: 'OPEN',
            isDraft: args.includes('--draft'),
            head: world.head,
            branch: String(flagOf(args, '--head')),
            base: String(flagOf(args, '--base')),
            repository: String(repo),
            title: String(flagOf(args, '--title')),
            body: String(flagOf(args, '--body')),
            checks: ['PENDING'],
          };
          return Promise.resolve(ok(`${world.pr.url}\n`));
        }
        if (args[1] === 'list') {
          const asked = String(flagOf(args, '--json')).split(',');
          const found = world.pr !== null && world.pr.branch === flagOf(args, '--head') ? [world.pr] : [];
          const rows = found.map((one) => JSON.parse(viewJson(one, asked, world.changed)) as unknown);
          return Promise.resolve(ok(JSON.stringify(rows)));
        }
        // `gh pr <sub> --repo <repository> <number>` or `gh pr <sub> <number> --repo <repository>`.
        const number = Number(args[2] === '--repo' ? args[4] : args[2]);
        if (world.pr === null || world.pr.number !== number) return Promise.resolve(refused('no pull requests found'));
        const pr = world.pr;
        switch (args[1]) {
          case 'view':
            return Promise.resolve(ok(viewJson(pr, String(flagOf(args, '--json')).split(','), world.changed)));
          case 'ready':
            pr.isDraft = false;
            return Promise.resolve(ok());
          case 'merge': {
            world.order.push('gh pr merge');
            if (pr.isDraft) return Promise.resolve(refused('Pull request is still a draft'));
            const matched = flagOf(args, '--match-head-commit');
            if (matched !== null && matched !== pr.head) return Promise.resolve(refused('Head branch was modified'));
            if (world.mergeCode !== 0) return Promise.resolve(refused('merge refused'));
            pr.state = 'MERGED';
            return Promise.resolve(ok());
          }
          default:
            return Promise.resolve(refused(`unexpected gh ${args.join(' ')}`));
        }
      },
      tests(file, args, options) {
        world.order.push('tests');
        world.tests.push({ file, args, cwd: options.cwd });
        return Promise.resolve({ code: world.testRun.code, stdout: world.testRun.stdout, stderr: '' });
      },
      settings: () => ({ mode: world.mode, base: world.base, repository: world.repository }),
      async check() {
        world.order.push('check');
        const gh = (args: ReadonlyArray<string>): Promise<GhAnswer> => {
          if (world.access === 'gh-missing') return Promise.resolve({ found: false });
          if (args[0] === 'auth') {
            const code = world.access === 'gh-logged-out' ? 1 : 0;
            return Promise.resolve({ found: true, code, stdout: '', stderr: code === 0 ? '' : 'SECRET-FROM-GH' });
          }
          const push = world.access !== 'no-push';
          return Promise.resolve({ found: true, code: 0, stdout: JSON.stringify({ permissions: { push } }), stderr: '' });
        };
        return await checkRepository(world.repository, gh, LABELS);
      },
      triage: () => ({ role: 'dev', budget: 4, steps: 80, estimate: 30 }),
      packageSkill(request) {
        world.skillPackages.push(request);
        return Promise.resolve(world.skillAnswer);
      },
      journal: (line) => world.journal.push(line),
      fileExists: (_dir, relative) => world.existing.has(relative),
      repoDir,
      worktreeRoot,
      runTimeoutMs: 60 * MINUTE,
      leaseMinutes: 30,
      leaseRenewMs: 60 * MINUTE,
    },
  };
  t.after(async () => {
    for (const worker of workers) await worker.stop();
  });
  return world;
}

/** Wakes until a wake starts nothing and nothing runs: what the board's events would do one by one. */
export async function settle(worker: DevelopmentWorker): Promise<void> {
  for (let pass = 0; pass < 12; pass += 1) {
    const report = await worker.wake();
    await worker.idle();
    if (report.started.length === 0) return;
  }
  throw new Error('the worker kept starting runs past twelve wakes');
}

/** A dev task the owner filed and approved at once; its id. */
export function ownerTask(world: DevelopmentWorld, over: Readonly<Record<string, unknown>> = {}): string {
  return world.board.call('boss', 'task.add', {
    lane: 'dev',
    title: 'Raise the web.read timeout',
    description: 'web.read timed out in three turns.',
    role: 'dev',
    risk: 'low',
    auto: true,
    no_brief: true,
    ...over,
  }).id;
}

/** The current lease generation of a task. */
export const generationOf = (world: DevelopmentWorld, id: string): number => world.show(id).task.lease_generation;

/** What a thinker does with `neptunia tasks add --parent`: one scoped dev task under its task; the new id. */
export function fileDevTask(world: DevelopmentWorld, parent: string, title: string): string {
  return world.board.call(WORKER, 'task.add', {
    parent,
    lane: 'dev',
    role: 'dev',
    risk: 'low',
    title,
    description: `The scoped plan: ${title}`,
    auto: true,
    no_brief: true,
  }).id;
}

/** What a thinker does with `neptunia tasks ask`: a question to the persona, as the holder of the task. */
export function askPersona(world: DevelopmentWorld, id: string, text: string): void {
  world.board.call(WORKER, 'task.ask', { id, generation: generationOf(world, id), text, to_whom: 'persona:self' });
}

/** The ids of the dev tasks filed under `parent`. */
export function childrenOf(world: DevelopmentWorld, parent: string): Array<string> {
  return world.show(parent).dependents.map((row) => String(row.task_id));
}

/** A pull request as the fake GitHub holds it after a crash or a finished earlier run. */
export function fakePr(world: DevelopmentWorld, branch: string, over: Partial<FakePullRequest> = {}): FakePullRequest {
  world.pr = {
    number: 12,
    url: 'https://github.com/example/engine/pull/12',
    state: 'OPEN',
    isDraft: true,
    head: world.head,
    branch,
    base: 'main',
    repository: 'example/engine',
    title: 'An earlier title',
    body: 'An earlier body',
    checks: ['SUCCESS'],
    ...over,
  };
  return world.pr;
}
