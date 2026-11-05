// The account commands of one subharness: `login`, `status` and `logout`, the same words in a shell
// (`neptunia subharness codex login`) and in the chat. They change whether a source can run and nothing else: no role moves
// and no model is chosen. Installation happens only through `login`, after the owner's yes. A vendor login is interactive,
// so with no terminal it answers what is needed and starts nothing. opencode has no vendor login here: logging in names
// the extra key it runs on. `logout` refuses while a run of that backend is alive (src/subharness/activity.ts), and
// credential changes of one backend run one at a time across processes. The login runs under the backend's own home,
// never the installing user's. No answer carries a key value.

import { spawn } from 'node:child_process';
import type { StdioOptions } from 'node:child_process';
import { BACKEND_NAMES } from '../agent-runner/profiles.ts';
import type { BackendName } from '../agent-runner/profiles.ts';
import { hasExtraKey, readKeys, writeKeys } from '../keys/file.ts';
import { BackendLocked, backendBusy, withBackendLock } from './activity.ts';
import { installSubharness } from './install.ts';
import type { InstallRun } from './install.ts';
import { helpOfInstalled, isInstalled, loginCommand, subharnessPlace, vendorEnv } from './place.ts';
import { sourceState } from './sources.ts';

export type AccountAction = 'login' | 'status' | 'logout';

export type AccountDeps = {
  privateDir: string;
  /** the environment npm and the vendor's own commands take their plain variables from */
  hostEnv: Readonly<Record<string, string | undefined>>;
  install: InstallRun;
  /** asks the owner one question; null when nobody can answer, a process with no terminal */
  ask: ((question: string) => Promise<string>) | null;
  /** the login's stdio; `inherit` by default, the owner's terminal */
  loginStdio?: StdioOptions;
  /** the executable a login of an absent opencode copies in */
  opencodeSource?: string;
};

export type AccountAnswer = { status: 'ok' | 'failed'; code: string; text: string };

const ok = (text: string): AccountAnswer => ({ status: 'ok', code: 'ok', text });
const refused = (code: string, text: string): AccountAnswer => ({ status: 'failed', code, text });

const loginWord = (backend: string): string => `neptunia subharness ${backend} login`;

/** What the vendor's logout is, by CLI. */
const LOGOUT_ARGS: Readonly<Record<'codex' | 'claude', ReadonlyArray<string>>> = {
  codex: ['logout'],
  claude: ['auth', 'logout'],
};

/** How long the vendor's logout may take (ms). */
const LOGOUT_MS = 30_000;

/** The exit code of a process a terminal's interrupt ended. */
const INTERRUPTED_CODE = 130;

type VendorExit = { code: number | null; signal: NodeJS.Signals | null };

/** One vendor command to its end. While it holds the terminal, the owner's interrupt ends it and not this process. */
function vendorRun(
  deps: AccountDeps,
  backend: BackendName,
  args: ReadonlyArray<string>,
  stdio: StdioOptions,
  timeout?: number
): Promise<VendorExit> {
  const holdInterrupt = (): void => {};
  process.on('SIGINT', holdInterrupt);
  return new Promise<VendorExit>((resolve) => {
    const child = spawn(subharnessPlace(deps.privateDir, backend).binary, [...args], {
      stdio,
      env: vendorEnv(deps.privateDir, backend, deps.hostEnv),
      ...(timeout === undefined ? {} : { timeout }),
    });
    child.once('error', () => resolve({ code: 1, signal: null }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  }).finally(() => process.off('SIGINT', holdInterrupt));
}

/** The vendor's login under the backend's home, then what its own status says; an exit 0 with no login is a failure. */
async function vendorLogin(deps: AccountDeps, backend: 'codex' | 'claude'): Promise<AccountAnswer> {
  let args: ReadonlyArray<string> | undefined;
  try {
    const help = backend === 'claude' ? await helpOfInstalled(deps.privateDir, backend) : undefined;
    args = loginCommand(deps.privateDir, backend, help)?.args;
  } catch (error) {
    return refused('login-failed', (error as Error).message);
  }
  if (args === undefined) return refused('login-failed', `${backend} names no login`);
  const exit = await vendorRun(deps, backend, args, deps.loginStdio ?? 'inherit');
  if (exit.signal === 'SIGINT' || exit.code === INTERRUPTED_CODE)
    return refused('login-cancelled', `the login of ${backend} was cancelled; nothing changed`);
  if (exit.code !== 0) return refused('login-failed', `the login of ${backend} failed (exit ${exit.code ?? 'signal'})`);
  const state = await sourceState(deps.privateDir, backend);
  return state.authenticated
    ? ok(`${backend} is logged in`)
    : refused('login-failed', `the login of ${backend} ended, and ${backend} still says it is not logged in`);
}

/** opencode's login: the named extra key becomes the one it runs on. */
function opencodeLogin(deps: AccountDeps, key: string | undefined): AccountAnswer {
  const store = readKeys(deps.privateDir);
  if (key === undefined || !hasExtraKey(store, key))
    return refused(
      'key-unknown',
      key === undefined
        ? 'opencode logs in by naming an extra key: --key <name>'
        : `${key} is no extra key; an extra key is added with keys extra`
    );
  writeKeys(deps.privateDir, { ...store, subharness: { ...store.subharness, key } });
  return ok(`opencode runs on the extra key ${key}`);
}

/** The absent backend installed on the owner's yes, null when the login can go on; else the answer it ends with. */
async function offerInstall(deps: AccountDeps, backend: BackendName): Promise<AccountAnswer | null> {
  if (deps.ask === null)
    return refused(
      'install-required',
      `${backend} is not installed: run ${loginWord(backend)} at a terminal to install it and log in`
    );
  const answer = await deps.ask(`${backend} is not installed. Install it now? (yes or no):`);
  if (!/^y(es)?$/i.test(answer.trim())) return refused('install-declined', `${backend} was not installed`);
  const outcome = await installSubharness(
    {
      privateDir: deps.privateDir,
      backend,
      hostEnv: deps.hostEnv,
      ...(deps.opencodeSource === undefined ? {} : { opencodeSource: deps.opencodeSource }),
    },
    deps.install
  );
  return outcome.state === 'failed' ? refused('install-failed', `${backend}: ${outcome.detail}`) : null;
}

async function login(deps: AccountDeps, backend: BackendName, key: string | undefined): Promise<AccountAnswer> {
  // A key is checked before anything is offered: an install for a name that fails next would be for nothing.
  if (backend === 'opencode' && (key === undefined || !hasExtraKey(readKeys(deps.privateDir), key)))
    return opencodeLogin(deps, key);
  if (!isInstalled(deps.privateDir, backend)) {
    const stopped = await offerInstall(deps, backend);
    if (stopped !== null) return stopped;
  }
  if (backend === 'opencode')
    return withBackendLock(deps.privateDir, backend, () => Promise.resolve(opencodeLogin(deps, key)));
  if (deps.ask === null)
    return refused('terminal-required', `a login of ${backend} needs a terminal: run ${loginWord(backend)} in one`);
  return withBackendLock(deps.privateDir, backend, () => vendorLogin(deps, backend));
}

async function status(deps: AccountDeps, backend: BackendName): Promise<AccountAnswer> {
  const state = await sourceState(deps.privateDir, backend);
  if (state.code === 'not-installed') return refused('not-installed', `${backend} is not installed`);
  if (state.code === 'not-logged-in') return refused('not-logged-in', `${backend} is installed and not logged in`);
  return ok(`${backend} is installed and logged in`);
}

/** What the logout does under the lock: the run check again, then the vendor's own logout or the key's name removed. */
async function logoutLocked(deps: AccountDeps, backend: BackendName): Promise<AccountAnswer> {
  if (backendBusy(deps.privateDir, backend)) return busy(backend);
  if (backend === 'opencode') {
    const store = readKeys(deps.privateDir);
    writeKeys(deps.privateDir, { ...store, subharness: { ...store.subharness, key: null } });
    return ok('opencode has no key to run on now');
  }
  const exit = await vendorRun(deps, backend, LOGOUT_ARGS[backend], 'ignore', LOGOUT_MS);
  const state = await sourceState(deps.privateDir, backend);
  return exit.code === 0 && !state.authenticated
    ? ok(`${backend} is logged out; the roles that chose it stay on it, unavailable until the next login`)
    : refused('logout-failed', `the logout of ${backend} did not go through`);
}

const busy = (backend: string): AccountAnswer =>
  refused('busy', `${backend} is running an agent or the memory writer now; its login stays until that ends`);

async function logout(deps: AccountDeps, backend: BackendName): Promise<AccountAnswer> {
  if (!isInstalled(deps.privateDir, backend)) return refused('not-installed', `${backend} is not installed`);
  if (backendBusy(deps.privateDir, backend)) return busy(backend);
  return withBackendLock(deps.privateDir, backend, () => logoutLocked(deps, backend));
}

/** Runs one account command. Never installs except on a login's yes; a lock that stays taken answers `busy`. */
export async function accountCommand(
  deps: AccountDeps,
  backend: string,
  action: AccountAction,
  options: { key?: string } = {}
): Promise<AccountAnswer> {
  const name = BACKEND_NAMES.find((known) => known === backend);
  if (name === undefined)
    return refused('unknown-backend', `${backend} is no backend; use ${BACKEND_NAMES.join(', ')}`);
  try {
    if (action === 'status') return await status(deps, name);
    return await (action === 'login' ? login(deps, name, options.key) : logout(deps, name));
  } catch (error) {
    if (error instanceof BackendLocked) return refused('busy', error.message);
    throw error;
  }
}
