// The subharness step of `neptunia setup` (src/setup/run.ts, docs/setup.md): which backends the persona's agents may
// run through, each installed into her place (src/subharness/install.ts) and connected after one check
// (src/subharness/control.ts). The owner names none, one or several. For `codex` and `claude` not yet connected the
// step shows the login line of her own binary (src/subharness/place.ts#loginCommand), waits until the owner has run
// it, then checks one reply; `opencode` is copied in from a path the owner gives and connected to one extra key after
// the key's check. A backend whose install or check fails is not stored, and the ones connected before it stay. No
// detail holds a key value. The step never runs the login itself.

import { BACKEND_NAMES } from '../agent-runner/profiles.ts';
import type { BackendName } from '../agent-runner/profiles.ts';
import { readKeys } from '../keys/file.ts';
import { enableSubharness } from '../subharness/control.ts';
import type { EnableDeps } from '../subharness/control.ts';
import { installSubharness } from '../subharness/install.ts';
import type { InstallRun } from '../subharness/install.ts';
import { isInstalled, loginCommand } from '../subharness/place.ts';
import type { Ask } from './mechanics.ts';

export type SubharnessStepDeps = {
  ask: Ask;
  install: InstallRun;
  hostEnv: Readonly<Record<string, string | undefined>>;
  /** the one-reply check of codex and claude */
  runBackend: EnableDeps['runBackend'];
  /** the `/auth/key` check of opencode's key */
  fetch: typeof fetch;
  baseUrl?: string;
};
export type SubharnessStepOutcome = {
  state: 'done' | 'already' | 'failed' | 'skipped';
  detail: string;
  /** the backends connected when the step ended */
  connected: Array<BackendName>;
};

/** The first question of the step. */
const CHOICE =
  'The subharness backends her agents may run through, separated by spaces (codex, claude, opencode; none for none):';

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

/** Installs and connects one backend; `already` when it was installed and connected and nothing ran. */
async function setUpOne(privateDir: string, name: BackendName, deps: SubharnessStepDeps): Promise<Result> {
  const wasInstalled = isInstalled(privateDir, name);
  const connected = readKeys(privateDir).subharness.backends.includes(name);
  if (wasInstalled && connected) return { name, state: 'already', detail: `${name} is installed and connected` };
  let source: string | undefined;
  if (name === 'opencode' && !wasInstalled)
    source = (await deps.ask('The path of the opencode executable to copy into her place:', null)).trim();
  const installed = await installSubharness(
    { privateDir, backend: name, hostEnv: deps.hostEnv, ...(source === undefined ? {} : { opencodeSource: source }) },
    deps.install
  );
  if (installed.state === 'failed') return { name, state: 'failed', detail: `${name}: ${installed.detail}` };
  if (connected) return { name, state: 'done', detail: `${name} installed, connected already` };
  let key: string | undefined;
  if (name === 'opencode') {
    const stored = readKeys(privateDir).subharness.key;
    const answer = (await deps.ask('The name of the extra key opencode runs on:', stored)).trim();
    key = answer === '' ? (stored ?? '') : answer;
  } else {
    const login = loginCommand(privateDir, name);
    await deps.ask(`Log in at this terminal, then press Enter: ${login?.text ?? name}`, null);
  }
  const enableDeps: EnableDeps = {
    privateDir,
    runBackend: deps.runBackend,
    fetch: deps.fetch,
    isInstalled: (backend) => isInstalled(privateDir, backend),
    ...(deps.baseUrl === undefined ? {} : { baseUrl: deps.baseUrl }),
  };
  const result = await enableSubharness(enableDeps, name, key);
  return result.ok
    ? { name, state: 'done', detail: result.message }
    : { name, state: 'failed', detail: `${name}: ${result.message}` };
}

export async function subharnessStep(
  options: { privateDir: string },
  deps: SubharnessStepDeps
): Promise<SubharnessStepOutcome> {
  const connectedNow = (): Array<BackendName> => readKeys(options.privateDir).subharness.backends;
  const before = connectedNow();
  const offered = before.length === 0 ? null : before.join(' ');
  const raw = (await deps.ask(CHOICE, offered)).trim();
  const answer = raw === '' ? (offered ?? '') : raw;
  if (answer === '' || answer.toLowerCase() === 'none')
    return { state: 'skipped', detail: 'no backend chosen', connected: before };
  const names = namesOf(answer);
  if (!Array.isArray(names))
    return {
      state: 'failed',
      detail: `${names.unknown} is no backend; use ${BACKEND_NAMES.join(', ')}`,
      connected: before,
    };
  const results: Array<Result> = [];
  for (const name of names) results.push(await setUpOne(options.privateDir, name, deps));
  const connected = connectedNow();
  const detail = results.map((one) => one.detail).join('; ');
  const state = results.some((one) => one.state === 'failed')
    ? 'failed'
    : results.every((one) => one.state === 'already')
      ? 'already'
      : 'done';
  return { state, detail, connected };
}
