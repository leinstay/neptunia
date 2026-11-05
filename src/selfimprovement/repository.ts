// The repository her pull requests go to (docs/selfimprovement.md#configure): `selfimprovement.repository`, and the check
// that the system's gh login may push there. gh is the system's tool, run with the environment it is given and no config
// home of the engine's. `checkRepository` runs before a filed task claims work (src/development/edges.ts) and in the
// self-development step of `neptunia setup` (src/setup/selfimprovement.ts), and `checkDevelopment` puts the checkout's
// `node_modules` in front of it for the worker. An answer is a code and a line from `labels.selfimprovement.check`;
// nothing gh printed reaches the line, the journal or the owner.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fill } from '../format.ts';
import { repositoryName } from './settings.ts';

/** What one gh command came to; `found: false` when no gh is on PATH (spawn ENOENT). */
export type GhAnswer = { found: false } | { found: true; code: number; stdout: string; stderr: string };
/** One gh command, never a shell. */
export type GhRunner = (args: ReadonlyArray<string>) => Promise<GhAnswer>;

export type RepositoryFailure = 'gh-missing' | 'gh-logged-out' | 'no-push' | 'repository-unset' | 'failed';
export type RepositoryCheck = { code: 'ok'; repository: string } | { code: RepositoryFailure; line: string };
/** What the worker asks before a task claims work: the push right, and that the checkout can run a task's tests. */
export type DevelopmentCheck = RepositoryCheck | { code: 'no-modules'; line: string };
/** The failure codes, each with a label `labels.selfimprovement.check.<code>` in the `owner` section of config/labels.json. */
export const REPOSITORY_FAILURES: ReadonlyArray<RepositoryFailure> = [
  'gh-missing',
  'gh-logged-out',
  'no-push',
  'repository-unset',
  'failed',
];

/** How long one gh command of the check may take (ms). */
const GH_TIMEOUT_MS = 60_000;

/** The gh of the check as a child process with no shell, on `env`; no gh on PATH answers `found: false`. */
export function spawnGh(env: Readonly<NodeJS.ProcessEnv>): GhRunner {
  return (args) =>
    new Promise((resolve) => {
      const options = { env: { ...env }, timeout: GH_TIMEOUT_MS, encoding: 'utf8' as const };
      execFile('gh', [...args], options, (error, stdout, stderr) => {
        if (error !== null && error.code === 'ENOENT') return resolve({ found: false });
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ found: true, code, stdout, stderr });
      });
    });
}

/** The remote forms of github.com: https with or without `.git`, scp-like ssh, and ssh:// URLs. */
const REMOTE =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/;

/** `owner/name` of a github.com remote URL, or null. */
export function repositoryOfRemote(url: string): string | null {
  const found = REMOTE.exec(url.trim());
  return found === null ? null : repositoryName(found[1]);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** `labels.selfimprovement.check.<code>` with `{repository}` filled; the bare code when the label is missing. */
export function repositoryLine(
  labels: Readonly<Record<string, unknown>>,
  code: RepositoryFailure | 'no-modules',
  repository: string
): string {
  const section = isRecord(labels.selfimprovement) ? labels.selfimprovement : {};
  const check = isRecord(section.check) ? section.check : {};
  const label = check[code];
  return typeof label === 'string' && label !== '' ? fill(label, { repository }) : code;
}

/** Whether a `gh api repos/<owner>/<name>` answer grants a push; null when it is not JSON. */
function pushRight(stdout: string): boolean | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  return isRecord(data) && isRecord(data.permissions) && data.permissions.push === true;
}

/**
 * The push-right check: `repository-unset` without asking gh when `repository` is not `owner/name`, then
 * `gh auth status` and `gh api repos/<owner>/<name>`. `permissions.push` true is `ok`.
 */
export async function checkRepository(
  repository: string | null,
  gh: GhRunner,
  labels: Readonly<Record<string, unknown>>
): Promise<RepositoryCheck> {
  const named = repositoryName(repository);
  const refused = (code: RepositoryFailure): RepositoryCheck => ({
    code,
    line: repositoryLine(labels, code, named ?? repository ?? ''),
  });
  if (named === null) return refused('repository-unset');
  const auth = await gh(['auth', 'status']);
  if (!auth.found) return refused('gh-missing');
  if (auth.code !== 0) return refused('gh-logged-out');
  const api = await gh(['api', `repos/${named}`]);
  if (!api.found) return refused('gh-missing');
  if (api.code !== 0) return refused('failed');
  const push = pushRight(api.stdout);
  if (push === null) return refused('failed');
  return push ? { code: 'ok', repository: named } : refused('no-push');
}

/**
 * The worker's check: a checkout with no `node_modules` answers `no-modules` without asking gh, because a worktree under
 * it resolves its packages there and no test of a task could run. Otherwise `checkRepository`.
 */
export async function checkDevelopment(
  checkout: string,
  repository: string | null,
  gh: GhRunner,
  labels: Readonly<Record<string, unknown>>
): Promise<DevelopmentCheck> {
  if (!fs.existsSync(path.join(checkout, 'node_modules')))
    return { code: 'no-modules', line: repositoryLine(labels, 'no-modules', repository ?? '') };
  return await checkRepository(repository, gh, labels);
}
