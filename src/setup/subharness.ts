// The subharness step of `neptunia setup` (src/setup/run.ts, docs/setup.md): which backends the persona's agents may
// run through, each installed into her place (src/subharness/install.ts) and logged in. The owner names none, one,
// several or all. A backend not yet logged in goes through the same login as `neptunia subharness <backend> login`
// (src/subharness/account.ts), at the owner's terminal; `opencode` is copied in from a path the owner gives and names one
// extra key. A backend whose install or login fails stays out, and the ones available before it stay. One that can run
// already is left alone, and no role and no model moves. No detail holds a key value.

import { BACKEND_NAMES } from '../agent-runner/profiles.ts';
import type { BackendName } from '../agent-runner/profiles.ts';
import type { StdioOptions } from 'node:child_process';
import { readRouting } from '../subharness/routing.ts';
import { accountCommand } from '../subharness/account.ts';
import { installSubharness } from '../subharness/install.ts';
import type { InstallRun } from '../subharness/install.ts';
import { isInstalled } from '../subharness/place.ts';
import { availableSources, sourceState } from '../subharness/sources.ts';
import type { Ask } from './mechanics.ts';

export type SubharnessStepDeps = {
  ask: Ask;
  install: InstallRun;
  hostEnv: Readonly<Record<string, string | undefined>>;
  /** the login's stdio; the owner's terminal by default */
  loginStdio?: StdioOptions;
};
export type SubharnessStepOutcome = {
  state: 'done' | 'already' | 'failed' | 'skipped';
  detail: string;
  /** the backends that can run when the step ended */
  available: Array<BackendName>;
};

/** The first question of the step. */
const CHOICE =
  'The subharness backends her agents may run through, separated by spaces (codex, claude, opencode; all for all, none for none):';

/** What one backend came to. */
type Result = { name: BackendName; state: 'done' | 'already' | 'failed'; detail: string };

/** The names of an answer, split on spaces or commas, in the order given, no name twice; the first word that is no backend. */
function namesOf(answer: string): Array<BackendName> | { unknown: string } {
  const names: Array<BackendName> = [];
  for (const word of answer.split(/[\s,]+/).filter(Boolean)) {
    const name = BACKEND_NAMES.find((one) => one === word.toLowerCase());
    if (name === undefined) return { unknown: word };
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Installs and logs in one backend; `already` when it could run and nothing was done. */
async function setUpOne(privateDir: string, name: BackendName, deps: SubharnessStepDeps): Promise<Result> {
  const wasInstalled = isInstalled(privateDir, name);
  if ((await sourceState(privateDir, name)).available)
    return { name, state: 'already', detail: `${name} is installed and logged in` };
  let source: string | undefined;
  if (name === 'opencode' && !wasInstalled)
    source = (await deps.ask('The path of the opencode executable to copy into her place:', null)).trim();
  const installed = await installSubharness(
    { privateDir, backend: name, hostEnv: deps.hostEnv, ...(source === undefined ? {} : { opencodeSource: source }) },
    deps.install
  );
  if (installed.state === 'failed') return { name, state: 'failed', detail: `${name}: ${installed.detail}` };
  if (name === 'opencode') {
    const stored = readRouting(privateDir).subharness.key;
    const answer = (await deps.ask('The name of the extra key opencode runs on:', stored)).trim();
    const given = await accountCommand(
      { privateDir, hostEnv: deps.hostEnv, install: deps.install, ask: null },
      name,
      'login',
      { key: answer === '' ? (stored ?? '') : answer }
    );
    return { name, state: given.status === 'ok' ? 'done' : 'failed', detail: given.text };
  }
  const login = await accountCommand(
    {
      privateDir,
      hostEnv: deps.hostEnv,
      install: deps.install,
      ask: (question) => deps.ask(question, null),
      ...(deps.loginStdio === undefined ? {} : { loginStdio: deps.loginStdio }),
    },
    name,
    'login'
  );
  return login.status === 'ok'
    ? { name, state: 'done', detail: `${name} is installed and logged in` }
    : { name, state: 'failed', detail: login.text };
}

export async function subharnessStep(
  options: { privateDir: string },
  deps: SubharnessStepDeps
): Promise<SubharnessStepOutcome> {
  const before = await availableSources(options.privateDir);
  const offered = before.length === 0 ? null : before.join(' ');
  const raw = (await deps.ask(CHOICE, offered)).trim();
  const answer = raw === '' ? (offered ?? '') : raw;
  if (answer === '' || answer.toLowerCase() === 'none')
    return { state: 'skipped', detail: 'no backend chosen', available: before };
  const names = answer.toLowerCase() === 'all' ? [...BACKEND_NAMES] : namesOf(answer);
  if (!Array.isArray(names))
    return {
      state: 'failed',
      detail: `${names.unknown} is no backend; use ${BACKEND_NAMES.join(', ')}`,
      available: before,
    };
  const results: Array<Result> = [];
  for (const name of names) results.push(await setUpOne(options.privateDir, name, deps));
  const detail = results.map((one) => one.detail).join('; ');
  const state = results.some((one) => one.state === 'failed')
    ? 'failed'
    : results.every((one) => one.state === 'already')
      ? 'already'
      : 'done';
  return { state, detail, available: await availableSources(options.privateDir) };
}
