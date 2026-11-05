// What the development worker (src/development/worker.ts) runs on, built by its entry point bin/development.ts. Its
// working repository is `selfimprovement.checkout`, and each task's worktree is `<checkout>/.worktrees/<task>`, excluded
// through `.git/info/exclude` so that git in the checkout never lists one and no tracked file changes. The worker's gh and
// git use the system's gh login with the environment they are given. An agent gets no gh access: each run has an empty gh
// home of its own in the temporary folder, removed when the run ends, and no gh token. The test runner gets a minimal
// environment, so no key of the deployment reaches code an agent wrote.

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { BackendResult } from '../agent-runner/backend.ts';
import { checkDevelopment, spawnGh } from '../selfimprovement/repository.ts';
import type { DevelopmentCheck } from '../selfimprovement/repository.ts';
import { runAgent } from '../subharness/run.ts';
import type { AgentRun } from '../subharness/run.ts';
import type { Exec } from './worker.ts';

export type DevelopmentEdges = {
  /** the working repository: `selfimprovement.checkout` */
  repoDir: string;
  /** the folder of the tasks' worktrees */
  worktreeRoot: string;
  /** Makes the worktree folder and excludes it from git. Throws when the checkout is no git repository. */
  prepare(): void;
  git: Exec;
  gh: Exec;
  tests: Exec;
  runAgent: (run: AgentRun) => Promise<BackendResult>;
  /** The check before a top-level task claims work, on the system's gh. */
  check(repository: string | null, labels: Readonly<Record<string, unknown>>): Promise<DevelopmentCheck>;
};

/** How long one git, gh or test command may take (ms). */
const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const WORKTREE_FOLDER = '.worktrees';
const EXCLUDE_LINE = `/${WORKTREE_FOLDER}/`;
/** The environment the test runner gets. */
const TEST_ENV_NAMES = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'] as const;
/** gh takes either for a login, and one of them would give an agent GitHub's merge past the empty gh home. */
const GH_TOKEN_NAMES: ReadonlyArray<string> = ['GH_TOKEN', 'GITHUB_TOKEN'];

/** One command, never a shell. `node` is the running Node, so the tests use the engine's own runtime. */
function execWith(env: NodeJS.ProcessEnv): Exec {
  return (file, args, options) =>
    new Promise((resolve) => {
      const program = file === 'node' ? process.execPath : file;
      execFile(
        program,
        [...args],
        { cwd: options.cwd, env, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
          resolve({ code, stdout, stderr: error !== null && stderr === '' ? error.message : stderr });
        }
      );
    });
}

/** Adds the exclusion to the checkout's `info/exclude` unless it is there; what the owner keeps there stays. */
function excludeWorktrees(checkout: string, env: NodeJS.ProcessEnv): void {
  // git says where the file is, which also holds for a checkout whose `.git` is a file.
  const answer = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
    cwd: checkout,
    env,
    stdio: 'pipe',
  });
  const file = path.resolve(checkout, answer.toString('utf8').trim());
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (text.split('\n').includes(EXCLUDE_LINE)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}${EXCLUDE_LINE}\n`);
}

/** Throws without a checkout: the worker must never fall back to the code it runs from. */
export function developmentEdges(options: {
  checkout: string | null;
  privateDir: string;
  dataDir: string;
  env: Readonly<NodeJS.ProcessEnv>;
  denyDir: string;
  tmpDir: string;
}): DevelopmentEdges {
  const { checkout, privateDir, denyDir, tmpDir } = options;
  if (checkout === null)
    throw new Error('selfimprovement.checkout is unset; name a development checkout there and run neptunia setup');
  const env = { ...options.env };
  const worktreeRoot = path.join(checkout, WORKTREE_FOLDER);
  const gh = spawnGh(env);
  // A push and a fetch of github.com authenticate through gh and never ask a terminal, because a unit has none.
  const gitEnv: NodeJS.ProcessEnv = {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: '!gh auth git-credential',
  };
  const testEnv: NodeJS.ProcessEnv = Object.fromEntries(
    TEST_ENV_NAMES.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]]))
  );
  return {
    repoDir: checkout,
    worktreeRoot,
    prepare() {
      fs.mkdirSync(worktreeRoot, { recursive: true });
      excludeWorktrees(checkout, env);
    },
    git: execWith(gitEnv),
    gh: execWith(env),
    tests: execWith(testEnv),
    async runAgent(run) {
      const given = Object.entries(run.env ?? {}).filter(([name]) => !GH_TOKEN_NAMES.includes(name));
      const home = fs.mkdtempSync(path.join(tmpDir, 'neptunia-no-gh-'));
      try {
        return await runAgent(
          { ...run, env: { ...Object.fromEntries(given), GH_CONFIG_DIR: home } },
          { privateDir, denyDir, hostEnv: env }
        );
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
    check: (repository, labels) => checkDevelopment(checkout, repository, gh, labels),
  };
}
