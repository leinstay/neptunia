// `neptunia worker selfimprovement` (bin/neptunia.ts hands it `runSelfimprovement`): one beat of her self-improvement's
// hands (src/selfimprovement/service.ts, docs/selfimprovement.md). While `selfimprovement.enabled` is false it prints
// that it is off and does nothing else. It connects to the core's socket as the client `NEPTUNIA_TASK_CLIENT` (default
// `selfimprovement`, whose token is `NEPTUNIA_TASK_TOKEN` or `<private>/clients/selfimprovement.token`; a deployment
// whose only token file is the older `clients/selfdev.token` connects as `selfdev`, LEGACY_CLIENT; the board reads
// both names as its builtin principal), then runs one `beat`: the push-right check of `selfimprovement.repository`,
// and on `ok` `intake`, `work` and `observe` once, and prints their counts or the code that paused it. This file
// holds the edges the service takes as arguments: git and gh as child processes with no shell, gh under her own gh
// home (`GH_CONFIG_DIR`, src/selfimprovement/repository.ts), the test runner with a minimal environment, and the dev
// run over the subharness seam (src/subharness/run.ts, the mode of `dev`). The settings are read from the config at
// each use, the brief from `prompts/selfimprovement.md` (or its local copy, `prompts.local/selfdev.md` too). Exit 0 when the beat ran, paused or is off, 1
// when the board could not be reached.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { boardSettings } from '../src/board/board.ts';
import { readConfig, ROOT_DIR } from '../src/config.ts';
import { createHot } from '../src/hot.ts';
import { log } from '../src/log.ts';
import { resolvePaths } from '../src/paths.ts';
import { checkRepository, ghEnv, spawnGh } from '../src/selfimprovement/repository.ts';
import { briefFrom, createSelfimprovement } from '../src/selfimprovement/service.ts';
import type { Exec, SubharnessRun } from '../src/selfimprovement/service.ts';
import { selfimprovementSettings } from '../src/selfimprovement/settings.ts';
import { defaultDenyDir, runAgent } from '../src/subharness/run.ts';
import { openBoardCaller } from './neptunia-task.ts';

/** How long one dev run may take before its process group is killed (ms). */
const RUN_TIMEOUT_MS = 60 * 60 * 1000;
/** How long one git, gh or test command may take (ms). */
const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
/** The client name of a deployment set up before the rename; its token file is `clients/selfdev.token`. */
const LEGACY_CLIENT = 'selfdev';

/** The client the beat connects as: `selfimprovement`, or LEGACY_CLIENT when only that client's token file exists. */
function clientOf(privateDir: string): string {
  const tokenOf = (name: string): string => path.join(privateDir, 'clients', `${name}.token`);
  return !fs.existsSync(tokenOf('selfimprovement')) && fs.existsSync(tokenOf(LEGACY_CLIENT))
    ? LEGACY_CLIENT
    : 'selfimprovement';
}

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

export async function runSelfimprovement(argv: ReadonlyArray<string>): Promise<number> {
  if (argv.length !== 1 || argv[0] !== 'run') {
    console.error('usage: neptunia worker selfimprovement');
    return 2;
  }
  const where = resolvePaths({ rootDir: ROOT_DIR });
  const config = (): unknown => readConfig(where.rootDir, { privateDir: where.privateDir });
  if (!selfimprovementSettings(config()).enabled) {
    console.log('selfimprovement: off (selfimprovement.enabled is false)');
    return 0;
  }
  const opened = await openBoardCaller({
    ...process.env,
    NEPTUNIA_TASK_CLIENT: process.env.NEPTUNIA_TASK_CLIENT || clientOf(where.privateDir),
  });
  if (typeof opened === 'string') {
    console.error(`the board is not reachable: ${opened}`);
    return 1;
  }
  try {
    const hot = createHot({ rootDir: where.rootDir, privateDir: where.privateDir });
    const template = typeof hot.prompts.selfimprovement === 'string' ? hot.prompts.selfimprovement : '';
    const worktreeRoot = path.join(where.dataDir, 'selfimprovement');
    fs.mkdirSync(worktreeRoot, { recursive: true });
    const service = createSelfimprovement({
      board: opened.board,
      git: execWith(() => process.env),
      gh: execWith(() => ghEnv(where.privateDir, process.env)),
      tests: execWith(testEnv),
      run: subharness(where),
      brief: (task) => briefFrom(template, task),
      settings: () => selfimprovementSettings(config()),
      check: () =>
        checkRepository(
          selfimprovementSettings(config()).repository,
          spawnGh(where.privateDir, process.env),
          (hot.prompts.labels ?? {}) as Record<string, unknown>
        ),
      triage: () => boardSettings(config()).autoTriage,
      journal: (line) => log.info('selfimprovement', line),
      fileExists: (dir, relative) => fs.existsSync(path.join(dir, relative)),
      repoDir: where.rootDir,
      worktreeRoot,
    });
    const { check, taken, reports, seen } = await service.beat();
    if (check.code !== 'ok') {
      console.log(`selfimprovement: paused (${check.code}): ${check.line}`);
      return 0;
    }
    console.log(
      `selfimprovement: ${taken.length} taken, ${reports.length} worked (${reports.filter((one) => one.outcome === 'submitted').length} submitted), ${seen.length} looked at`
    );
    return 0;
  } finally {
    opened.close();
  }
}
