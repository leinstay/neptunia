// One script of an activated skill as a separate process: `skill.run` (src/tools/impl/skill.ts) is the caller. The script
// comes from the activated package snapshot (package.ts). It takes its arguments as JSON on stdin and answers JSON on
// stdout: `{ ok, text?, data?, error?, files? }`. Its working directory is `data/skills/<name>/state/`, where it keeps
// its own state, and `SKILL_OUT_DIR` is one folder per run for files it returns. Its environment holds the host's PATH,
// HOME, TMPDIR and locale, those two folders and only the credentials its manifest names, as `SKILL_<KEY>`: nothing of
// the engine, no key store and no path of the memory database. A directory is no sandbox, so a script runs with the
// rights of the installing user and only an activated version runs. A deadline kills the whole process group and the
// outcome is `unknown`, since the script may have acted. No run is stored as pending, so a restart replays nothing.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type SkillRunResult = {
  status: 'ok' | 'failed' | 'unknown';
  code: string;
  text: string;
  data: unknown;
  files: Array<string>;
  stderr: string;
};

export type SkillRunInput = {
  dataDir: string;
  name: string;
  packageDir: string;
  script: string;
  args: unknown;
  credentials: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputBytes: number;
  runId: string;
};

const SKILL_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SCRIPT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*\.(ts|js|cjs|mjs|sh)$/;
/** The host variables a script inherits. */
const PASSED_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'] as const;
const STDERR_KEEP = 2000;
const HANDLE = /^skill:([a-z0-9-]+)\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/;

const failure = (code: string, stderr = ''): SkillRunResult => ({
  status: 'failed',
  code,
  text: '',
  data: null,
  files: [],
  stderr,
});

function environmentOf(input: SkillRunInput, stateDir: string, outDir: string): Record<string, string> {
  const env: Record<string, string> = { SKILL_STATE_DIR: stateDir, SKILL_OUT_DIR: outDir };
  for (const name of PASSED_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [key, value] of Object.entries(input.credentials)) env[`SKILL_${key.toUpperCase()}`] = value;
  return env;
}

/** The files a script named, as handles: plain names of files that exist in its own run folder. */
function handlesOf(input: SkillRunInput, outDir: string, named: unknown): Array<string> {
  if (!Array.isArray(named)) return [];
  return named.flatMap((file: unknown) => {
    const handle = `skill:${input.name}/${input.runId}/${String(file)}`;
    return HANDLE.test(handle) && !String(file).startsWith('.') && fs.existsSync(path.join(outDir, String(file)))
      ? [handle]
      : [];
  });
}

function parsedResult(input: SkillRunInput, outDir: string, stdout: string, stderr: string): SkillRunResult {
  let answer: unknown;
  try {
    answer = JSON.parse(stdout);
  } catch {
    return failure('bad-output', stderr);
  }
  if (typeof answer !== 'object' || answer === null) return failure('bad-output', stderr);
  const body = answer as { ok?: unknown; text?: unknown; data?: unknown; error?: unknown; files?: unknown };
  if (body.ok !== true) return failure(typeof body.error === 'string' ? body.error : 'script-failed', stderr);
  return {
    status: 'ok',
    code: 'ok',
    text: typeof body.text === 'string' ? body.text : '',
    data: body.data ?? null,
    files: handlesOf(input, outDir, body.files),
    stderr,
  };
}

/** Runs one script to its end, its deadline or its output limit. Never rejects. */
export function runSkillScript(input: SkillRunInput): Promise<SkillRunResult> {
  if (!SKILL_NAME.test(input.name) || !SCRIPT_NAME.test(input.script)) return Promise.resolve(failure('no-script'));
  const file = path.join(input.packageDir, 'scripts', input.script);
  if (!fs.existsSync(file)) return Promise.resolve(failure('no-script'));
  const home = path.join(input.dataDir, 'skills', input.name);
  const stateDir = path.join(home, 'state');
  const outDir = path.join(home, 'out', input.runId);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const shell = input.script.endsWith('.sh');
  return new Promise((resolve) => {
    const child = spawn(shell ? '/bin/sh' : process.execPath, shell ? [file] : ['--no-warnings', file], {
      cwd: stateDir,
      env: environmentOf(input, stateDir, outDir),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let ended: SkillRunResult | null = null;
    const stop = (result: SkillRunResult): void => {
      ended ??= result;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group has already gone.
      }
    };
    const timer = setTimeout(() => {
      stop({ status: 'unknown', code: 'timeout', text: '', data: null, files: [], stderr });
    }, input.timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > input.maxOutputBytes) stop(failure('output-too-large'));
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-STDERR_KEEP);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(failure('cannot-start', stderr));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (ended !== null) resolve({ ...ended, stderr });
      else if (code !== 0) resolve(failure(`exit-${String(code)}`, stderr));
      else resolve(parsedResult(input, outDir, stdout, stderr));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input.args ?? {}));
  });
}

/** The file of a `skill:<name>/<run>/<file>` handle, or null for any other string or a name that would leave its folder. */
export function skillOutputFile(dataDir: string, handle: string): { name: string; path: string } | null {
  const match = HANDLE.exec(handle);
  if (match === null) return null;
  const [, skill = '', run = '', name = ''] = match;
  if (name.startsWith('.')) return null;
  return { name, path: path.join(dataDir, 'skills', skill, 'out', run, name) };
}
