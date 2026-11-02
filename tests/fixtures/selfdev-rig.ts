// The world of the self-development tests (src/selfdev/): a real task board over a memory database in memory, her
// `board.propose` as the operations run it, and fakes for everything outside the process: the subharness runner,
// `git`, `gh` and the test runner. Each fake records what it was asked, in `order` when the order matters, and answers
// from `world`, which a test edits before the step it checks. Nothing here touches the network, a provider or a
// remote. Synthetic data only.
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../../src/memory/db/open.ts';
import { openBoard } from '../../src/board/board.ts';
import type { Board, BoardOp, BoardResults } from '../../src/board/board.ts';
import type { BoardDb } from '../../src/board/schema.ts';
import type { SelfdevDeps } from '../../src/selfdev/service.ts';
import { runOpPrechecked } from '../../src/tools/impl/index.ts';
import { createOpsEnv } from '../../src/tools/impl/env.ts';
import type { BoardCaller } from '../../src/tools/impl/board.ts';
import { createDiscordInterface } from '../../interfaces/discord/index.ts';
import { withCapturedLogs } from './capture-logs.ts';
import { tempDir } from './tmp.ts';

export const SELFDEV_T0 = Date.parse('2026-11-02T10:00:00Z');
export const PR_URL = 'https://github.com/example/engine/pull/12';
export const PASSING_TAP = 'TAP version 13\n# tests 3\n# suites 0\n# pass 3\n# fail 0\n';
export const FAILING_TAP = 'TAP version 13\n# tests 3\n# suites 0\n# pass 2\n# fail 1\n';

/** The board operations that write, which `order` records as `board <op>`. */
const WRITES: ReadonlySet<string> = new Set([
  'task.claim',
  'task.update',
  'task.result',
  'task.submit',
  'task.review',
  'task.transition',
  'task.comment',
]);

export type CheckState = 'SUCCESS' | 'FAILURE' | 'PENDING';

export type SelfdevWorld = {
  board: Board;
  caller: BoardCaller;
  deps: SelfdevDeps;
  repoDir: string;
  worktreeRoot: string;
  /** What happened, in order: `git worktree add`, `run`, `tests`, `git push`, `gh pr create`, `board <write op>`. */
  order: Array<string>;
  journal: Array<Record<string, unknown>>;
  git: Array<{ args: ReadonlyArray<string>; cwd: string }>;
  gh: Array<{ args: ReadonlyArray<string>; cwd: string }>;
  tests: Array<{ file: string; args: ReadonlyArray<string>; cwd: string }>;
  runs: Array<{ taskId: string; brief: string; cwd: string }>;
  /** The `selfdev.mode` and the base branch the settings read. */
  mode: 'approve' | 'auto';
  base: string;
  /** The paths the fake agent leaves changed in its worktree. */
  changed: Array<string>;
  /** The test files that exist in a worktree. */
  existing: Set<string>;
  /** The final message of the fake agent. */
  agent: { ok: boolean; text: string };
  /** What the test runner answers. */
  testRun: { code: number; stdout: string };
  /** `gh pr create`: its exit code and stderr, and what it was given. */
  create: { code: number; stderr: string; title: string | null; body: string | null; base: string | null; head: string | null };
  /** The pull request as `gh pr view` shows it; `files` and `title` default to what was created. */
  pr: {
    state: 'OPEN' | 'MERGED' | 'CLOSED';
    title: string | null;
    files: Array<string> | null;
    checks: Array<CheckState>;
    mergeCode: number;
    /** `gh pr ready` ran: the draft is a request to the owner. */
    ready: boolean;
  };
};

/** The board with its builtin principal `selfdev`, a fake owner `boss`, and a caller that records the writes. */
function boardOf(t: { after: (fn: () => void) => void }, order: Array<string>) {
  const dir = tempDir('nep-selfdev-board-');
  fs.writeFileSync(
    path.join(dir, 'clients.json'),
    JSON.stringify({ boss: { kind: 'agent', tokenFile: 'clients/boss.token', permissions: [], boardRoles: ['owner'] } })
  );
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  const board = openBoard({
    // open.js types the connection as `object`; it is node:sqlite's DatabaseSync, which has every method BoardDb names.
    db: handle.db as BoardDb,
    privateDir: dir,
    now: () => SELFDEV_T0,
    settings: () => ({
      leaseTtlMinutes: 30,
      autoTriage: { role: 'dev', budget: 4, steps: 80, estimate: 30 },
      projects: {},
    }),
    builtins: { persona: ['persona'], selfdev: ['reviewer', 'worker'] },
  });
  const caller: BoardCaller = {
    call<TOp extends BoardOp>(
      principal: string,
      op: TOp,
      args?: Readonly<Record<string, unknown>>,
      idempotency?: string | null
    ): BoardResults[TOp] {
      if (WRITES.has(op)) order.push(`board ${op}`);
      return board.call(principal, op, args, idempotency);
    },
  };
  return { board, caller };
}

const flagOf = (args: ReadonlyArray<string>, name: string): string | null => {
  const at = args.indexOf(name);
  return at < 0 ? null : (args[at + 1] ?? null);
};

export function selfdevWorld(t: { after: (fn: () => void) => void }): SelfdevWorld {
  const order: Array<string> = [];
  const { board, caller } = boardOf(t, order);
  const repoDir = tempDir('nep-selfdev-repo-');
  const worktreeRoot = tempDir('nep-selfdev-trees-');
  const world: SelfdevWorld = {
    board,
    caller,
    repoDir,
    worktreeRoot,
    order,
    journal: [],
    git: [],
    gh: [],
    tests: [],
    runs: [],
    mode: 'approve',
    base: 'main',
    changed: ['src/web/read.ts', 'tests/web-read.test.ts'],
    existing: new Set(['tests/web-read.test.ts', 'tests/unrelated.test.ts']),
    agent: { ok: true, text: 'Raised the limit and added a case. All 99 tests pass.' },
    testRun: { code: 0, stdout: PASSING_TAP },
    create: { code: 0, stderr: '', title: null, body: null, base: null, head: null },
    pr: { state: 'OPEN', title: null, files: null, checks: ['SUCCESS'], mergeCode: 0, ready: false },
    deps: undefined as unknown as SelfdevDeps,
  };
  world.deps = {
    board: caller,
    run: (request) => {
      order.push('run');
      world.runs.push(request);
      return Promise.resolve({ ...world.agent });
    },
    git: (file, args, options) => {
      world.git.push({ args, cwd: options.cwd });
      const stdout = (() => {
        switch (args[0]) {
          case 'worktree':
            order.push('git worktree add');
            fs.mkdirSync(String(args[4]), { recursive: true });
            return '';
          case 'status':
            return world.changed.map((one) => ` M ${one}`).join('\n');
          case 'diff':
            return world.changed.join('\n');
          case 'push':
            order.push('git push');
            return '';
          case 'commit':
            order.push('git commit');
            return '';
          default:
            return '';
        }
      })();
      return Promise.resolve({ code: 0, stdout, stderr: '' });
    },
    gh: (file, args, options) => {
      world.gh.push({ args, cwd: options.cwd });
      if (args[0] === 'pr' && args[1] === 'create') {
        order.push('gh pr create');
        world.create.title = flagOf(args, '--title');
        world.create.body = flagOf(args, '--body');
        world.create.base = flagOf(args, '--base');
        world.create.head = flagOf(args, '--head');
        const failed = world.create.code !== 0;
        return Promise.resolve({
          code: world.create.code,
          stdout: failed ? '' : `${PR_URL}\n`,
          stderr: world.create.stderr,
        });
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            number: 12,
            state: world.pr.state,
            title: world.pr.title ?? world.create.title ?? 'untitled',
            headRefName: world.create.head,
            files: (world.pr.files ?? world.changed).map((one) => ({ path: one })),
            statusCheckRollup: world.pr.checks.map((state, n) => ({
              name: `check-${n}`,
              status: state === 'PENDING' ? 'IN_PROGRESS' : 'COMPLETED',
              conclusion: state === 'PENDING' ? '' : state,
            })),
          }),
          stderr: '',
        });
      }
      if (args[0] === 'pr' && args[1] === 'ready') {
        world.pr.ready = true;
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      }
      if (args[0] === 'pr' && args[1] === 'merge') {
        if (world.pr.mergeCode === 0) world.pr.state = 'MERGED';
        return Promise.resolve({ code: world.pr.mergeCode, stdout: '', stderr: world.pr.mergeCode === 0 ? '' : 'refused' });
      }
      return Promise.resolve({ code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` });
    },
    tests: (file, args, options) => {
      order.push('tests');
      world.tests.push({ file, args, cwd: options.cwd });
      return Promise.resolve({ code: world.testRun.code, stdout: world.testRun.stdout, stderr: '' });
    },
    brief: (task) => `BRIEF ${task.id}: ${task.title}\n${task.evidence}`,
    settings: () => ({ mode: world.mode, base: world.base }),
    triage: () => ({ role: 'dev', budget: 4, steps: 80, estimate: 30 }),
    journal: (line) => world.journal.push(line),
    fileExists: (_dir, relative) => world.existing.has(relative),
    repoDir,
    worktreeRoot,
  };
  return world;
}

type Result = { status: string; summary?: string; data?: unknown };

/** Her tool calls as the operations' environment runs them, with the board the core gives it. */
export function herCalls(caller: BoardCaller) {
  const hot = {
    config: { bot: { owners: ['42'], access: {} }, features: {} },
    prompts: { labels: {} },
    rootDir: tempDir('nep-selfdev-root-'),
    reloadConfig: () => true,
  };
  const env = createOpsEnv({
    discord: createDiscordInterface().capabilities,
    hot,
    store: { state: { data: {}, markDirty() {} } },
    client: { channels: { cache: new Map() } },
    spontaneous: {},
    calibrator: { ratio: 1 },
    getGuildId: () => 'g1',
    board: caller,
    now: () => SELFDEV_T0,
  });
  return async (name: string, args: Record<string, unknown>): Promise<Result> => {
    const { result } = await withCapturedLogs(() =>
      runOpPrechecked(name, args, { env, guildId: 'g1', channelId: 'c1', userId: null, roleIds: [], actor: 'persona' })
    );
    return result;
  };
}

export const FIX_REQUEST = {
  title: 'Raise the web.read timeout',
  evidence:
    'web.read timed out in turns t1, t2 and t3 after 5 seconds. The limit is a constant in src/web/read.ts and the pages are slow, not broken.',
  examples: ['t3', 't2', 't1'],
  benefit: 'Fact lookups stop failing on slow pages.',
  evaluation: 'A page that answers in 8 seconds is read, not reported as a timeout.',
} as const;

/** Her scripted `board.propose` of kind `fix`; returns the task id. */
export async function proposeFix(
  world: SelfdevWorld,
  over: Partial<Record<string, unknown>> = {}
): Promise<string> {
  const her = herCalls(world.caller);
  const answer = await her('board.propose', { ...FIX_REQUEST, kind: 'fix', ...over });
  if (answer.status !== 'ok') throw new Error(`board.propose: ${answer.status} ${answer.summary ?? ''}`);
  return String((answer.data as { task: { id: string } }).task.id);
}

/**
 * A done task that carries `metadata.landed`, made through the board alone (no service): filed by her, worked by
 * `selfdev`, closed by its review. For the tests of what her wake is shown.
 */
export function landTaskDirectly(
  world: SelfdevWorld,
  landed: { title: string; files: Array<string>; pr: number; decidedBy: 'owner' | 'auto' } | null
): string {
  const { caller } = world;
  const task = caller.call('persona', 'task.add', {
    lane: 'dev',
    title: landed?.title ?? 'A skill',
    description: 'evidence',
    metadata: { kind: landed === null ? 'skill' : 'fix' },
    requester: 'persona:self',
    subscriber: 'persona:self',
  }) as BoardResults['task.add'];
  const revision = (): number => (caller.call('selfdev', 'task.show', { id: task.id }) as BoardResults['task.show']).task.revision;
  caller.call('selfdev', 'task.transition', {
    id: task.id,
    status: 'triaged',
    revision: task.revision,
    set: { role: 'dev', estimate: 30, budget: 4, risk: 'low' },
  });
  caller.call('selfdev', 'task.approve', { id: task.id, scope: 'plan' });
  const held = caller.call('selfdev', 'task.claim', { id: task.id }) as BoardResults['task.claim'];
  caller.call('selfdev', 'task.submit', {
    id: task.id,
    generation: held.lease_generation,
    handoff: { result: 'done', evidence: [], artifacts: [], tests: [], open_issues: [] },
  });
  caller.call('selfdev', 'task.update', {
    id: task.id,
    revision: revision(),
    metadata: { ci: 'green', ...(landed === null ? {} : { landed }) },
  });
  caller.call('selfdev', 'task.review', { id: task.id, decision: 'accept' });
  return task.id;
}
