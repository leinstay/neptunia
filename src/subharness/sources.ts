// Whether a subharness can run anything now: `available` is `installed` and `authenticated`, read from the disk and from
// the backend itself at every call and stored nowhere. Installed is the binary in its folder of the private layer
// (src/subharness/place.ts). Authenticated is what the vendor's own status command answers under the backend's home, with
// no model request, and for opencode that the named key `models.agents.opencodeKey` names is still in keys.json, with no
// process.

import { execFile } from 'node:child_process';
import { BACKEND_NAMES } from '../agent-runner/profiles.ts';
import type { BackendName } from '../agent-runner/profiles.ts';
import { opencodeKey } from './routing.ts';
import { isInstalled, subharnessPlace, vendorEnv } from './place.ts';

export type SourceCode = 'ok' | 'not-installed' | 'not-logged-in';

export type SourceState = {
  backend: BackendName;
  installed: boolean;
  authenticated: boolean;
  available: boolean;
  code: SourceCode;
};

/** How long the vendor's status command may take (ms). */
const STATUS_MS = 15_000;

/** The status command of each CLI: exit 0 means logged in. */
const STATUS_ARGS: Readonly<Record<'codex' | 'claude', ReadonlyArray<string>>> = {
  codex: ['login', 'status'],
  claude: ['auth', 'status'],
};

function vendorSaysLoggedIn(privateDir: string, backend: 'codex' | 'claude'): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile(
      subharnessPlace(privateDir, backend).binary,
      [...STATUS_ARGS[backend]],
      { timeout: STATUS_MS, env: vendorEnv(privateDir, backend) },
      (error) => resolve(error === null)
    );
    child.stdin?.end();
  });
}

function opencodeKeyStored(privateDir: string): boolean {
  return opencodeKey(privateDir) !== null;
}

/** One backend as it stands now. Never rejects on a status command that fails: that reads as not logged in. */
export async function sourceState(privateDir: string, backend: BackendName): Promise<SourceState> {
  const installed = isInstalled(privateDir, backend);
  const authenticated = !installed
    ? false
    : backend === 'opencode'
      ? opencodeKeyStored(privateDir)
      : await vendorSaysLoggedIn(privateDir, backend);
  return {
    backend,
    installed,
    authenticated,
    available: authenticated,
    code: !installed ? 'not-installed' : authenticated ? 'ok' : 'not-logged-in',
  };
}

/** The backends that can run now, in the order of BACKEND_NAMES. */
export async function availableSources(privateDir: string): Promise<Array<BackendName>> {
  const states = await Promise.all(BACKEND_NAMES.map((backend) => sourceState(privateDir, backend)));
  return states.filter((state) => state.available).map((state) => state.backend);
}

/** Why `state` cannot run, with the command that repairs it. */
export function sourceProblem(state: SourceState): string {
  return state.code === 'not-installed'
    ? `${state.backend} is not installed: neptunia subharness ${state.backend} login`
    : `${state.backend} is not logged in: neptunia subharness ${state.backend} login`;
}
