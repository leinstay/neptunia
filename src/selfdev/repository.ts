// The repository her pull requests go to (docs/selfdev.md#the-repository): `selfdev.repository`, and the check that
// her gh login may push there. gh runs under her own config home, `<private>/subharness/gh`, so her pull requests are
// never the installing user's. `checkRepository` runs before every beat (src/selfdev/service.ts) and in the
// self-development step of `neptunia setup` (src/setup/selfdev.ts). Its answer is a code and a line from
// `labels.selfdev.check`; nothing gh printed reaches the line, the journal or the owner.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fill } from '../format.ts';
import { repositoryName } from './settings.ts';

/** What one gh command came to; `found: false` when no gh is on PATH (spawn ENOENT). */
export type GhAnswer = { found: false } | { found: true; code: number; stdout: string; stderr: string };
/** One gh command, never a shell, with GH_CONFIG_DIR = ghConfigDir(privateDir) in its environment. */
export type GhRunner = (args: ReadonlyArray<string>) => Promise<GhAnswer>;

export type RepositoryFailure = 'gh-missing' | 'gh-logged-out' | 'no-push' | 'repository-unset' | 'failed';
export type RepositoryCheck = { code: 'ok'; repository: string } | { code: RepositoryFailure; line: string };
/** The failure codes, each with a label `labels.selfdev.check.<code>` in the `owner` section of config/labels.json. */
export const REPOSITORY_FAILURES: ReadonlyArray<RepositoryFailure> = [
  'gh-missing',
  'gh-logged-out',
  'no-push',
  'repository-unset',
  'failed',
];

/** `<privateDir>/subharness/gh`, her own gh home. */
export function ghConfigDir(privateDir: string): string {
  return path.join(privateDir, 'subharness', 'gh');
}

/** A copy of `env` with GH_CONFIG_DIR set to ghConfigDir(privateDir); `env` itself is not changed. */
export function ghEnv(privateDir: string, env: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  return { ...env, GH_CONFIG_DIR: ghConfigDir(privateDir) };
}

/** How long one gh command of the check may take (ms). */
const GH_TIMEOUT_MS = 60_000;

/** The gh of the check as a child process with no shell, under her gh home; no gh on PATH answers `found: false`. */
export function spawnGh(privateDir: string, env: Readonly<NodeJS.ProcessEnv>): GhRunner {
  return (args) =>
    new Promise((resolve) => {
      const options = { env: ghEnv(privateDir, env), timeout: GH_TIMEOUT_MS, encoding: 'utf8' as const };
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

/** `labels.selfdev.check.<code>` with `{repository}` filled; the bare code when the label is missing. */
function lineOf(labels: Readonly<Record<string, unknown>>, code: RepositoryFailure, repository: string): string {
  const section = isRecord(labels.selfdev) ? labels.selfdev : {};
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
    line: lineOf(labels, code, named ?? repository ?? ''),
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
