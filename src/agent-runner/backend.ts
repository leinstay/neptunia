// The backends an agent runs on: `codex exec`, `claude -p` or OpenCode, behind one interface. A CLI backend is one
// child process per run: the brief on stdin, a minimal environment (PATH, HOME, TMPDIR and the locale variables, plus
// what the caller adds; nothing of the bot's own environment), its own process group so that a timeout kills what the
// child spawned too. Which backend an agent runs on is the owner's switch, the subharness (src/subharness/): every
// agent run goes through `runAgent` (src/subharness/run.ts), which reads the switch and the agent's mode at the moment
// of the run. `createAgentEngine` gives the runner server (bin/neptunia.ts) its task engine: a runner that works a
// task's brief in a fresh directory through that seam and delivers the files the agent leaves there. The log line of a
// run carries the backend, the exit code, the duration and the tokens, never the brief or the text.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { log } from '../log.ts';
import { errorFields } from '../error-fields.ts';
import { scalarText } from '../tools/types.ts';
import {
  DEFAULT_OPENCODE_PATH,
  collectFiles,
  deliverableFiles,
  killTree,
  readPromptFile,
  taskPrompt,
} from './opencode.ts';
import type { RunnerDeps, Runner } from './opencode.ts';
import { redactorFor, scopeOf } from './policy.ts';
import { BACKEND_NAMES } from './profiles.ts';
import type { BackendName } from './profiles.ts';
import type { RunnerTask, TaskResult } from './protocol.ts';
import { runAgent } from '../subharness/run.ts';
import type { RunDeps } from '../subharness/run.ts';

export { BACKEND_NAMES };
export type { BackendName };

/** The environment variables a child inherits when the parent has them. */
const INHERITED_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'] as const;
/** The grace between SIGTERM and SIGKILL when a timeout stops the child (ms). */
const KILL_GRACE_MS = 5_000;
/** How much stdout is kept (bytes): the head for `claude`, the tail for `codex`, whose token count comes last. */
const STDOUT_KEEP = 256 * 1024;

/** What a run takes besides the brief. */
export type BackendRunOptions = {
  /** the child's working directory */
  cwd: string;
  /** past it the process group is killed */
  timeoutMs: number;
  /** added to the minimal child environment */
  env?: Record<string, string>;
  /** codex: adds `--search` */
  search?: boolean;
  /** codex: `-s <sandbox>`, `read-only` unless told otherwise; `none` runs without a sandbox (the modes full and sudo) */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access' | 'none';
  /** the model flag of the backend (`-m`, `--model`); absent runs the backend's own default */
  model?: string;
  /** codex: one `-i <path>` each */
  images?: ReadonlyArray<string>;
  /** aborting it kills the process group and answers `cancelled` */
  signal?: AbortSignal;
};

/** Why a run did not start or was stopped by us. */
export type BackendError = 'backend-missing' | 'empty-brief' | 'timeout' | 'spawn' | 'cancelled' | 'subharness-off';

/** What a run gives back. */
export type BackendResult = {
  /** exit code 0 and a non-empty final message */
  ok: boolean;
  /** the final message, empty when there is none */
  text: string;
  /** null when the child never ran or was killed */
  exitCode: number | null;
  /** codex: the number after the `tokens used` line of stdout */
  tokens?: number;
  error?: BackendError;
};

/** One way to run a brief. `run` resolves, never rejects. */
export type Backend = {
  name: BackendName;
  run(brief: string, options: BackendRunOptions): Promise<BackendResult>;
};

/** What `createBackend` takes. */
export type BackendDeps = {
  /** a path or a bare name; `codex`, `claude` or the OpenCode path by default */
  binary?: string;
  spawnImpl?: typeof spawn;
  /** read once at the start of a run and once at its end */
  now?: () => number;
};

/** The command line of one backend and what it takes from the run's output. */
type Recipe = {
  binary: string;
  /** the arguments, with the file the final message goes to when `outFile` is set */
  args(options: BackendRunOptions, outFile: string | undefined): Array<string>;
  /** the brief goes on stdin (else as the last argument) */
  stdin: boolean;
  /** the final message is read from a file the CLI writes */
  outFile: boolean;
  /** stdout keeps its tail (the token count is at the end) */
  tail: boolean;
};

const RECIPES: Readonly<Record<BackendName, Recipe>> = {
  codex: {
    binary: 'codex',
    stdin: true,
    outFile: true,
    tail: true,
    args: (options, outFile) => [
      'exec',
      '--skip-git-repo-check',
      ...(options.sandbox === 'none'
        ? ['--dangerously-bypass-approvals-and-sandbox']
        : ['-s', options.sandbox ?? 'read-only']),
      '-o',
      outFile ?? '',
      ...(options.model === undefined ? [] : ['-m', options.model]),
      ...(options.images ?? []).flatMap((image) => ['-i', image]),
      ...(options.search === true ? ['--search'] : []),
    ],
  },
  claude: {
    binary: 'claude',
    stdin: true,
    outFile: false,
    tail: false,
    args: (options) => ['-p', ...(options.model === undefined ? [] : ['--model', options.model])],
  },
  opencode: {
    binary: DEFAULT_OPENCODE_PATH,
    stdin: false,
    outFile: false,
    tail: false,
    args: (options) => ['run', ...(options.model === undefined ? [] : ['-m', options.model])],
  },
};

/** The environment of a child: the inherited variables the parent has, then `extra`. Nothing else. */
function childEnvOf(extra: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

/** Whether `binary` is an executable file, by its path or on the PATH of this process. */
function findBinary(binary: string): boolean {
  const candidates = binary.includes('/')
    ? [binary]
    : (process.env.PATH ?? '').split(path.delimiter).map((dir) => path.join(dir || '.', binary));
  return candidates.some((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

/** The number after the last `tokens used` label of codex's output, on the same line or the next, commas dropped. */
function tokensOf(output: string): number | undefined {
  const found = [...output.matchAll(/tokens used:?\s+([\d,]+)/g)].pop();
  if (!found) return undefined;
  const tokens = Number(found[1].replaceAll(',', ''));
  return Number.isFinite(tokens) ? tokens : undefined;
}

/** What a child process came to: its exit, its stdout, or why it never ran. */
type Outcome = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnCode: string | null;
  stopped: 'timeout' | 'cancelled' | null;
};

/** Runs `binary` once with `stdin` (or none) and collects its stdout. */
function runChild({
  binary,
  args,
  stdin,
  options,
  spawnImpl,
  tail,
}: {
  binary: string;
  args: Array<string>;
  stdin: string | undefined;
  options: BackendRunOptions;
  spawnImpl: typeof spawn;
  tail: boolean;
}): Promise<Outcome> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(binary, args, {
        cwd: options.cwd,
        env: childEnvOf(options.env),
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        exitCode: null,
        stdout: '',
        stderr: '',
        spawnCode: scalarText(errorFields(err).code ?? 'spawn'),
        stopped: null,
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let stopped: Outcome['stopped'] = null;
    let settled = false;
    const timers: Array<NodeJS.Timeout> = [];
    const settle = (outcome: Outcome): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const stop = (reason: 'timeout' | 'cancelled'): void => {
      if (stopped || settled) return;
      stopped = reason;
      killTree(child, 'SIGTERM');
      timers.push(
        setTimeout(() => {
          killTree(child, 'SIGKILL');
          timers.push(setTimeout(() => settle({ exitCode: null, stdout, stderr, spawnCode: null, stopped }), 1_000));
        }, KILL_GRACE_MS)
      );
    };
    const onAbort = (): void => stop('cancelled');
    timers.push(setTimeout(() => stop('timeout'), options.timeoutMs));
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > STDOUT_KEEP * 2) stdout = tail ? stdout.slice(-STDOUT_KEEP) : stdout.slice(0, STDOUT_KEEP);
    });
    child.stderr?.setEncoding('utf8');
    // codex prints its banner and the `tokens used` label to stderr; only the tail is kept and none of it is logged.
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDOUT_KEEP);
    });
    child.on('error', (err) =>
      settle({ exitCode: null, stdout, stderr, spawnCode: scalarText(errorFields(err).code ?? 'spawn'), stopped })
    );
    child.on('close', (code) => {
      // A killed group may leave the pipes open a moment; the exit is what counts.
      killTree(child, 'SIGKILL');
      settle({ exitCode: stopped ? null : code, stdout, stderr, spawnCode: null, stopped });
    });
    child.stdin?.on('error', () => {
      // the child closed stdin before reading the brief; its exit says why
    });
    child.stdin?.end(stdin);
  });
}

/** Why a child did not run to its own end: stopped by us, binary missing or unusable, or another spawn failure. */
function errorOf(outcome: Outcome): BackendError | undefined {
  if (outcome.stopped) return outcome.stopped;
  if (outcome.spawnCode === 'ENOENT' || outcome.spawnCode === 'EACCES') return 'backend-missing';
  return outcome.spawnCode ? 'spawn' : undefined;
}

/**
 * The backend `name`. Throws for a name outside BACKEND_NAMES.
 * @param deps.binary The command: a path, or a name looked up on PATH.
 */
export function createBackend(name: BackendName, deps: BackendDeps = {}): Backend {
  if (!BACKEND_NAMES.includes(name))
    throw new Error(`agent-runner: unknown backend "${String(name)}" (known: ${BACKEND_NAMES.join(', ')})`);
  const recipe = RECIPES[name];
  const { binary = recipe.binary, spawnImpl = spawn, now = Date.now } = deps;

  async function run(brief: string, options: BackendRunOptions): Promise<BackendResult> {
    const startedAt = now();
    let tokens: number | undefined;
    let result: BackendResult;
    let tmpDir: string | undefined;
    try {
      if (brief.trim() === '') {
        result = { ok: false, text: '', exitCode: null, error: 'empty-brief' };
      } else if (!findBinary(binary)) {
        result = { ok: false, text: '', exitCode: null, error: 'backend-missing' };
      } else {
        tmpDir = recipe.outFile ? await fsp.mkdtemp(path.join(os.tmpdir(), `${name}-`)) : undefined;
        const outFile = tmpDir && path.join(tmpDir, 'final.txt');
        const args = recipe.args(options, outFile);
        const outcome = await runChild({
          binary,
          args: recipe.stdin ? args : [...args, brief],
          stdin: recipe.stdin ? brief : undefined,
          options,
          spawnImpl,
          tail: recipe.tail,
        });
        if (name === 'codex') tokens = tokensOf(`${outcome.stderr}\n${outcome.stdout}`);
        let text = outcome.stdout.trim();
        if (outFile) text = (await fsp.readFile(outFile, 'utf8').catch(() => '')).trim();
        const error = errorOf(outcome);
        result = {
          ok: !error && outcome.exitCode === 0 && text !== '',
          text: outcome.exitCode === 0 || outFile ? text : '',
          exitCode: outcome.exitCode,
        };
        if (error) result.error = error;
      }
    } catch (err) {
      log.warn('agent-runner: backend failed', { backend: name, reason: scalarText(errorFields(err).code ?? 'error') });
      result = { ok: false, text: '', exitCode: null, error: 'spawn' };
    } finally {
      if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
    if (tokens !== undefined) result.tokens = tokens;
    log.info('agent-runner: backend run', {
      backend: name,
      exitCode: result.exitCode,
      durationMs: now() - startedAt,
      ...(tokens === undefined ? {} : { tokens }),
      ...(result.error ? { error: result.error } : {}),
    });
    return result;
  }

  return { name, run };
}

/** What `createAgentEngine` takes: the runner's deps, and the subharness seam every run goes through. */
export type EngineDeps = RunnerDeps & { subharness: RunDeps };

/** The seconds a task may run when neither it nor the profile says. */
const FALLBACK_SECONDS = 300;

/**
 * The task engine of a runner: it works the task's brief (the profile's prompt, the preamble, the goal and context)
 * in `<outDir>/<id>/` through `runAgent` (src/subharness/run.ts) and delivers the files left there. The agent runs as
 * the agent named like the profile, in the mode the owner set for it, and with `--search` when the profile asks. While
 * the subharness is off the task fails with `subharness-off`. A backend brings its own login: a task's `secrets` are
 * not passed on.
 */
export function createAgentEngine({ subharness, ...deps }: EngineDeps): Runner {
  const { profile, outDir } = deps;
  const checkPrompt = (): string => readPromptFile(profile.promptFiles);

  async function run(task: Omit<RunnerTask, 'onProgress'> & { onProgress?: RunnerTask['onProgress'] }) {
    const scope = scopeOf(task.context);
    const redact = redactorFor(scope);
    const failed = (error: string, text = '') => ({
      status: 'failed',
      error,
      result: { text: redact(text), sources: [], files: [] },
      usage: { input: 0, output: 0, usd: 0, steps: 0, seconds: 0 },
    });
    const dir = path.join(outDir, task.id);
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch {
      return failed('workdir');
    }
    let system: string;
    try {
      system = checkPrompt();
    } catch {
      return failed('no-prompt');
    }
    const preamble = typeof task.preamble === 'string' ? task.preamble.trim() : '';
    const brief = [preamble, system, taskPrompt(task.goal, task.context)].filter(Boolean).join('\n\n');
    const seconds = Number(task.limits?.seconds);
    const cap = Number.isFinite(seconds) && seconds > 0 ? seconds : (profile.defaultLimits.seconds ?? FALLBACK_SECONDS);
    const startedAt = (deps.now ?? Date.now)();
    const outcome = await runAgent(
      { agent: profile.name, brief, cwd: dir, timeoutMs: cap * 1000, search: profile.search, signal: task.signal },
      subharness
    );
    const usage = {
      input: 0,
      output: outcome.tokens ?? 0,
      usd: 0,
      steps: 0,
      seconds: Math.round(((deps.now ?? Date.now)() - startedAt) / 100) / 10,
    };
    const { files, dropped } = await deliverableFiles(await collectFiles(outDir, task.id), {
      scope,
      withheldCount: 0,
    });
    const result: TaskResult = {
      text: redact(outcome.text),
      sources: [],
      files,
    };
    if (dropped.length > 0) result.filesDropped = dropped;
    const base = { status: 'done', result, usage } as {
      status: string;
      result: typeof result;
      usage: typeof usage;
      error?: string;
    };
    const error = errorCodeOf(outcome, files.length > 0);
    if (error) {
      base.status = error === 'cancelled' ? 'cancelled' : 'failed';
      base.error = error;
    }
    return base;
  }

  return { run, checkPrompt };
}

/** The result code of a finished run, in the runner's own vocabulary (src/agent-runner/opencode.ts), or undefined. */
function errorCodeOf(outcome: BackendResult, hasFiles: boolean): string | undefined {
  if (outcome.error === 'timeout') return 'time-cap';
  if (outcome.error) return outcome.error;
  if (outcome.exitCode !== 0) return `exit-${outcome.exitCode ?? 'signal'}`;
  if (!outcome.text && !hasFiles) return 'empty-answer';
  return undefined;
}
