// The development part of `neptunia setup` (src/setup/run.ts, docs/selfimprovement.md): a person gives a repository they can
// push to and a folder, and `developmentSetup` does the rest in order. `gh` is installed through `installGh` when it is
// absent, or the step stops and says what to install. Access is `gh auth status` and the push right on the repository. The
// folder is cloned when absent or empty, with `npm install` in the checkout and each `interfaces/<name>/`; a checkout of the
// same repository is only verified, and any other content is refused. The guard refuses the folder the running engine was
// started from, by real path, and proposes a sibling before anything is downloaded. Nothing is written to the settings until
// every step passed, and a stored value is not asked again.
//
// `offerDevelopment` is the setup step over it: with no checkout named it asks whether to set development up at all, and with
// one named the repository question of src/setup/selfimprovement.ts runs first. `installGhOfficially` is the real
// `installGh`, GitHub's documented apt route when this process is root or has passwordless sudo.

import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from '../config.ts';
import { localConfigPath } from '../config/files.ts';
import { liveCheckoutProblem } from '../development/edges.ts';
import { readLabels } from '../hot.ts';
import { checkRepository, repositoryLine, repositoryOfRemote } from '../selfimprovement/repository.ts';
import type { GhAnswer, GhRunner } from '../selfimprovement/repository.ts';
import { selfimprovementSettings } from '../selfimprovement/settings.ts';
import { readLocalConfig, setPath, writeLocalConfig } from '../tools/operations/shared.ts';
import { whyFailed } from './install.ts';
import type { RunResult } from './install.ts';
import { selfimprovementStep } from './selfimprovement.ts';

/** What an attempt to install gh came to: in place, or what the person has to do. */
export type GhInstall = { code: 'installed' } | { code: 'manual'; what: string };

export type DevelopmentRun = (
  command: string,
  args: ReadonlyArray<string>,
  options?: { cwd?: string; timeoutMs?: number }
) => Promise<RunResult>;

export type DevelopmentSetupDeps = {
  run: DevelopmentRun;
  ask(question: string, offered: string | null): Promise<string>;
  gh: GhRunner;
  installGh(): Promise<GhInstall>;
};

export type DevelopmentOutcome = {
  state: 'done' | 'already' | 'refused';
  step: 'gh' | 'access' | 'folder' | 'guard';
  detail: string;
};

type Where = { rootDir: string; privateDir: string };

// A clone and an install fetch whole trees; ten minutes covers a slow network.
const LONG_RUN_MS = 10 * 60 * 1000;

const refused = (step: DevelopmentOutcome['step'], detail: string): DevelopmentOutcome => ({
  state: 'refused',
  step,
  detail,
});

/** `gh auth status` with an install when gh is absent: the answer that says it is there, or the refusal. */
async function ghThere(
  deps: DevelopmentSetupDeps,
  labels: Record<string, unknown>
): Promise<GhAnswer | DevelopmentOutcome> {
  const first = await deps.gh(['auth', 'status']);
  if (first.found) return first;
  const install = await deps.installGh();
  if (install.code === 'manual') return refused('gh', install.what);
  const after = await deps.gh(['auth', 'status']);
  return after.found ? after : refused('gh', repositoryLine(labels, 'gh-missing', ''));
}

/** The packages of a checkout: the folders under `interfaces/` that hold a `package.json`. */
function interfacePackages(checkout: string): Array<string> {
  const root = path.join(checkout, 'interfaces');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'package.json')))
    .map((entry) => path.join(root, entry.name));
}

const isAbsentOrEmpty = (folder: string): boolean => !fs.existsSync(folder) || fs.readdirSync(folder).length === 0;

/** `gh repo clone`, then `npm install` in the checkout and each interface; why it stopped, or null. */
async function cloneInto(folder: string, repository: string, run: DevelopmentRun): Promise<string | null> {
  const clone = await run('gh', ['repo', 'clone', repository, folder], { timeoutMs: LONG_RUN_MS });
  if (clone.code !== 0) return `gh repo clone: ${whyFailed(clone)}`;
  for (const cwd of [folder, ...interfacePackages(folder)]) {
    const install = await run('npm', ['install'], { cwd, timeoutMs: LONG_RUN_MS });
    if (install.code !== 0) return `npm install in ${cwd}: ${whyFailed(install)}`;
  }
  return null;
}

/** Why an existing folder is no checkout of `repository`, or null. */
async function notThatCheckout(folder: string, repository: string, run: DevelopmentRun): Promise<string | null> {
  const origin = await run('git', ['-C', folder, 'remote', 'get-url', 'origin']);
  if (origin.code !== 0) return `${folder} holds files and is no git checkout; name an empty folder`;
  const found = repositoryOfRemote(origin.stdout);
  if (found?.toLowerCase() === repository.toLowerCase()) return null;
  return `${folder} is a checkout of ${found ?? 'a repository outside github.com'}, not ${repository}; name an empty folder`;
}

/** The packages a verified checkout cannot run a task's tests without, as a sentence; '' when all have their modules. */
function missingModules(folder: string): string {
  const missing = [folder, ...interfacePackages(folder)].filter(
    (dir) => !fs.existsSync(path.join(dir, 'node_modules'))
  );
  return missing.length === 0 ? '' : `; run npm install in ${missing.join(', ')}`;
}

export async function developmentSetup(options: Where, deps: DevelopmentSetupDeps): Promise<DevelopmentOutcome> {
  const { rootDir, privateDir } = options;
  const labels = readLabels(rootDir, privateDir);
  const auth = await ghThere(deps, labels);
  if ('state' in auth) return auth;
  if (auth.found && auth.code !== 0) return refused('access', repositoryLine(labels, 'gh-logged-out', ''));

  const settings = selfimprovementSettings(readConfig(rootDir, { privateDir }));
  const named =
    settings.repository ??
    (await deps.ask('The GitHub repository to develop on, your fork or upstream, as owner/name:', null));
  const access = await checkRepository(named.trim(), deps.gh, labels);
  if (access.code !== 'ok') return refused('access', access.line);
  const { repository } = access;

  const folder =
    settings.checkout ?? (await deps.ask('The absolute path of the folder for the development checkout:', null)).trim();
  if (!path.isAbsolute(folder))
    return refused('folder', `the development checkout needs an absolute path, not "${folder}"`);
  const live = liveCheckoutProblem(folder, rootDir);
  if (live !== null) return refused('guard', live);

  let detail: string;
  if (isAbsentOrEmpty(folder)) {
    const stopped = await cloneInto(folder, repository, deps.run);
    if (stopped !== null) return refused('folder', stopped);
    detail = `${repository} cloned into ${folder}, with its packages installed`;
  } else {
    const other = await notThatCheckout(folder, repository, deps.run);
    if (other !== null) return refused('folder', other);
    detail = `${folder} is a checkout of ${repository}${missingModules(folder)}`;
  }

  const file = localConfigPath(privateDir);
  const before = readLocalConfig(file);
  const after = setPath(
    setPath(before, ['selfimprovement', 'repository'], repository),
    ['selfimprovement', 'checkout'],
    folder
  );
  if (JSON.stringify(after) === JSON.stringify(before)) return { state: 'already', step: 'folder', detail };
  writeLocalConfig(file, after);
  return { state: 'done', step: 'folder', detail };
}

/** The setup step: optional while no checkout is named, and with one named the repository's own question comes first. */
export async function offerDevelopment(
  options: Where,
  deps: DevelopmentSetupDeps
): Promise<{ state: DevelopmentOutcome['state'] | 'skipped'; detail: string }> {
  const { checkout } = selfimprovementSettings(readConfig(options.rootDir, { privateDir: options.privateDir }));
  if (checkout === null) {
    const answer = (await deps.ask('Set up development, a repository and a folder for it? (yes or no)', 'no')).trim();
    if (!/^y(es)?$/i.test(answer)) return { state: 'skipped', detail: 'development is not set up' };
    return developmentSetup(options, deps);
  }
  const auth = await ghThere(deps, readLabels(options.rootDir, options.privateDir));
  if ('state' in auth) return auth;
  const repository = await selfimprovementStep(options, deps);
  if (repository.state === 'refused') return repository;
  return developmentSetup(options, deps);
}

const INSTALL_BY_HAND = 'Install the GitHub CLI from https://cli.github.com and run neptunia setup again.';

/** GitHub's documented apt install (cli.github.com, docs/install_linux.md), with `SUDO` the prefix this process needs. */
const APT_ROUTE = `set -e
out=$(mktemp)
wget -nv -O "$out" https://cli.github.com/packages/githubcli-archive-keyring.gpg
$SUDO mkdir -p -m 755 /etc/apt/keyrings /etc/apt/sources.list.d
$SUDO cp "$out" /etc/apt/keyrings/githubcli-archive-keyring.gpg
$SUDO chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | $SUDO tee /etc/apt/sources.list.d/github-cli.list > /dev/null
$SUDO apt-get update
$SUDO apt-get install -y gh`;

/** The real install of gh: the apt route with root or passwordless sudo on a system with apt, else what to do by hand. */
export async function installGhOfficially(run: DevelopmentRun, isRoot: boolean): Promise<GhInstall> {
  if (!isRoot && (await run('sudo', ['-n', 'true'])).code !== 0)
    return { code: 'manual', what: `No root and no passwordless sudo here. ${INSTALL_BY_HAND}` };
  const apt = await run('sh', ['-c', 'command -v apt-get && command -v wget']);
  if (apt.code !== 0) return { code: 'manual', what: `This system has no apt-get and wget. ${INSTALL_BY_HAND}` };
  const script = `SUDO=${isRoot ? '' : "'sudo -n'"}\n${APT_ROUTE}`;
  const done = await run('sh', ['-c', script], { timeoutMs: LONG_RUN_MS });
  return done.code === 0
    ? { code: 'installed' }
    : { code: 'manual', what: `The install stopped: ${whyFailed(done)}. ${INSTALL_BY_HAND}` };
}
