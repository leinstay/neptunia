// `neptunia selfdev run` (bin/neptunia.ts hands it `runSelfdev`): one beat of her self-development
// (src/selfdev/service.ts, docs/selfdev.md). It connects to the core's socket as the client `NEPTUNIA_TASK_CLIENT`
// (default `selfdev`, whose token is `NEPTUNIA_TASK_TOKEN` or `<private>/clients/selfdev.token`; the board reads the
// name `selfdev` as its builtin principal), then runs `intake`, `work` and `observe` once and prints their counts. This
// file holds the edges the service takes as arguments: git and gh as child processes with no shell, the test runner
// with a minimal environment, and the dev run over the subharness seam (src/subharness/run.ts, the mode of `dev`). The settings are read
// from the config at each use, the brief from `prompts/selfdev.md` (or its local copy). Exit 0 when the beat ran, 1
// when the board could not be reached.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { boardSettings } from '../src/board/board.ts';
import { readConfig, ROOT_DIR } from '../src/config.ts';
import { createHot } from '../src/hot.ts';
import { log } from '../src/log.ts';
import { resolvePaths } from '../src/paths.ts';
import { briefFrom, createSelfdev } from '../src/selfdev/service.ts';
import type { Exec, SubharnessRun } from '../src/selfdev/service.ts';
import { selfdevSettings } from '../src/selfdev/settings.ts';
import { defaultDenyDir, runAgent } from '../src/subharness/run.ts';
import { openBoardCaller } from './neptunia-task.ts';

/** How long one dev run may take before its process group is killed (ms). */
const RUN_TIMEOUT_MS = 60 * 60 * 1000;
/** How long one git, gh or test command may take (ms). */
const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
/** The environment the test runner gets: no key of the deployment reaches code a dev run wrote. */
const TEST_ENV_NAMES = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'] as const;

/** One command, never a shell. `node` is the running Node, so the tests use the engine's own runtime. */
function execWith(env: () => NodeJS.ProcessEnv): Exec {
  return (file, args, options) =>
    new Promise((resolve) => {
      const program = file === 'node' ? process.execPath : file;
      execFile(
        program,
        [...args],
        { cwd: options.cwd, env: env(), timeout: COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
          resolve({ code, stdout, stderr: error !== null && stderr === '' ? error.message : stderr });
        }
      );
    });
}

const testEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    TEST_ENV_NAMES.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]]))
  );

/** The dev run: the subharness's backend, in the mode of `dev`, working in the worktree. */
function subharness(where: { rootDir: string; privateDir: string }): SubharnessRun {
  return async ({ brief, cwd }) => {
    const done = await runAgent(
      { agent: 'dev', brief, cwd, timeoutMs: RUN_TIMEOUT_MS },
      { privateDir: where.privateDir, denyDir: defaultDenyDir() }
    );
    return { ok: done.ok, text: done.text, ...(done.error === undefined ? {} : { error: done.error }) };
  };
}

export async function runSelfdev(argv: ReadonlyArray<string>): Promise<number> {
  if (argv.length !== 1 || argv[0] !== 'run') {
    console.error('usage: neptunia selfdev run');
    return 2;
  }
  const where = resolvePaths({ rootDir: ROOT_DIR });
  const opened = await openBoardCaller({
    ...process.env,
    NEPTUNIA_TASK_CLIENT: process.env.NEPTUNIA_TASK_CLIENT || 'selfdev',
  });
  if (typeof opened === 'string') {
    console.error(`the board is not reachable: ${opened}`);
    return 1;
  }
  try {
    const config = (): unknown => readConfig(where.rootDir, { privateDir: where.privateDir });
    const hot = createHot({ rootDir: where.rootDir, privateDir: where.privateDir });
    const template = typeof hot.prompts.selfdev === 'string' ? hot.prompts.selfdev : '';
    const worktreeRoot = path.join(where.dataDir, 'selfdev');
    fs.mkdirSync(worktreeRoot, { recursive: true });
    const service = createSelfdev({
      board: opened.board,
      git: execWith(() => process.env),
      gh: execWith(() => process.env),
      tests: execWith(testEnv),
      run: subharness(where),
      brief: (task) => briefFrom(template, task),
      settings: () => selfdevSettings(config()),
      triage: () => boardSettings(config()).autoTriage,
      journal: (line) => log.info('selfdev', line),
      fileExists: (dir, relative) => fs.existsSync(path.join(dir, relative)),
      repoDir: where.rootDir,
      worktreeRoot,
    });
    const taken = await service.intake();
    const reports = await service.work();
    const seen = await service.observe();
    console.log(
      `selfdev: ${taken.length} taken, ${reports.length} worked (${reports.filter((one) => one.outcome === 'submitted').length} submitted), ${seen.length} looked at`
    );
    return 0;
  } finally {
    opened.close();
  }
}
