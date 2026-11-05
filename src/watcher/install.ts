// What the watcher knows of the install it runs from, for its brief: the revision, how far it stands from `origin/main`, the
// modules, the dependencies and the active skills. Only `rootDir`, the running install, is ever read: a public install has no
// development checkout, and `selfimprovement.checkout` belongs to another mechanism. What cannot be learned is named in
// `unavailable`, by code, and the report carries it under `Unavailable checks`. Nothing fetches, so the divergence is from
// the last `origin/main` this install fetched.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../memory/db/open.ts';
import { listSkills } from '../memory/db/skills.ts';

export type InstallFacts = {
  revision: string | null;
  /** Commits only here and only on `origin/main`; null when that cannot be told. */
  divergence: { ahead: number; behind: number } | null;
  modules: Array<string>;
  dependencies: Record<string, string>;
  activeSkills: Array<string> | null;
  unavailable: Array<string>;
};

export type GitRunner = (rootDir: string, args: ReadonlyArray<string>) => string;

const GIT_MS = 5_000;

const runGit: GitRunner = (rootDir, args) =>
  execFileSync('git', ['-C', rootDir, ...args], {
    encoding: 'utf8',
    timeout: GIT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

const dirsIn = (dir: string): Array<string> => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
};

function dependenciesOf(file: string): Record<string, string> | null {
  try {
    const { dependencies } = JSON.parse(fs.readFileSync(file, 'utf8')) as { dependencies?: Record<string, string> };
    return dependencies ?? {};
  } catch {
    return null;
  }
}

function gitFacts(rootDir: string, git: GitRunner): Pick<InstallFacts, 'revision' | 'divergence' | 'unavailable'> {
  if (!fs.existsSync(path.join(rootDir, '.git'))) {
    return { revision: null, divergence: null, unavailable: ['no-git'] };
  }
  let revision: string;
  try {
    revision = git(rootDir, ['rev-parse', 'HEAD']);
  } catch {
    return { revision: null, divergence: null, unavailable: ['git-unreadable'] };
  }
  try {
    const [ahead, behind] = git(rootDir, ['rev-list', '--left-right', '--count', 'HEAD...origin/main'])
      .split(/\s+/)
      .map(Number);
    return { revision, divergence: { ahead: ahead ?? 0, behind: behind ?? 0 }, unavailable: [] };
  } catch {
    return { revision, divergence: null, unavailable: ['no-remote'] };
  }
}

function activeSkillsOf(dataDir: string): Array<string> | null {
  const file = path.join(dataDir, 'memory.db');
  if (!fs.existsSync(file)) return null;
  let handle: ReturnType<typeof openMemoryDb> | null = null;
  try {
    handle = openMemoryDb(file, { readOnly: true });
    return listSkills(handle)
      .filter((row) => row.active !== null && !row.disabled && row.lifecycle === 'active')
      .map((row) => `${row.name} ${row.active?.versionId ?? ''}`);
  } catch {
    return null;
  } finally {
    handle?.close();
  }
}

/** The facts of the install at `rootDir`, whose private data is at `dataDir`. Never throws. */
export function installFacts(input: { rootDir: string; dataDir: string; git?: GitRunner }): InstallFacts {
  const { rootDir, dataDir, git = runGit } = input;
  const facts = gitFacts(rootDir, git);
  const interfaces = dirsIn(path.join(rootDir, 'interfaces'));
  const dependencies: Record<string, string> = {};
  const unavailable = [...facts.unavailable];
  for (const [prefix, file] of [
    ['', path.join(rootDir, 'package.json')],
    ...interfaces.map((name) => [`${name}:`, path.join(rootDir, 'interfaces', name, 'package.json')] as const),
  ] as const) {
    const listed = dependenciesOf(file);
    if (listed === null && prefix === '') unavailable.push('no-package-json');
    for (const [name, version] of Object.entries(listed ?? {})) dependencies[`${prefix}${name}`] = version;
  }
  const activeSkills = activeSkillsOf(dataDir);
  if (activeSkills === null) unavailable.push('skills-unreadable');
  return {
    revision: facts.revision,
    divergence: facts.divergence,
    modules: [
      ...dirsIn(path.join(rootDir, 'src')).map((name) => `src/${name}`),
      ...interfaces.map((name) => `interfaces/${name}`),
    ],
    dependencies,
    activeSkills,
    unavailable,
  };
}
