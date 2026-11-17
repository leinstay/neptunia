// Where a subharness backend lives: `<private>/subharness/<backend>/` holds the backend's binary and its home, so the
// persona's agents run on her own install and her own login, never on the installing user's CLI or its `~/.codex`.
// `npm install --prefix` puts the binary of `claude` and `codex` under `node_modules/.bin/`, and `opencode` is one
// executable under `bin/`. The home goes to every run (src/agent-runner/backend.ts, `createInstalledBackend`) and to
// the owner's login (src/subharness/account.ts), as the variable each CLI reads its home from. The paths are
// computed, and `isInstalled` is the one look at the disk. `CURL_HOME` points curl
// in every run at the home, where `writeHarnessCurlrc` keeps the `.curlrc` with the user agent `/proxy useragent` set.

import fs from 'node:fs';
import path from 'node:path';
import type { BackendName } from '../agent-runner/profiles.ts';

/** Where one backend lives inside the private layer, and the environment every run of it gets. */
export type SubharnessPlace = {
  /** `<privateDir>/subharness/<backend>` */
  dir: string;
  /** the executable a run starts */
  binary: string;
  /** the backend's home, every path inside `dir`, and the control that keeps a pinned CLI from updating itself */
  env: Readonly<Record<string, string>>;
};

/** The place of `backend` in `privateDir`. */
export function subharnessPlace(privateDir: string, backend: BackendName): SubharnessPlace {
  const dir = path.join(privateDir, 'subharness', backend);
  const home = path.join(dir, 'home');
  switch (backend) {
    case 'claude':
      return {
        dir,
        binary: path.join(dir, 'node_modules', '.bin', 'claude'),
        env: { CLAUDE_CONFIG_DIR: home, DISABLE_AUTOUPDATER: '1', CURL_HOME: home },
      };
    case 'codex':
      return {
        dir,
        binary: path.join(dir, 'node_modules', '.bin', 'codex'),
        env: { CODEX_HOME: home, CURL_HOME: home },
      };
    case 'opencode':
      return {
        dir,
        binary: path.join(dir, 'bin', 'opencode'),
        env: {
          XDG_CONFIG_HOME: path.join(home, 'config'),
          XDG_DATA_HOME: path.join(home, 'data'),
          XDG_CACHE_HOME: path.join(home, 'cache'),
          XDG_STATE_HOME: path.join(home, 'state'),
          OPENCODE_DISABLE_AUTOUPDATE: '1',
          CURL_HOME: home,
        },
      };
  }
}

/** The backends a `.curlrc` goes to; the order of `BACKEND_NAMES`, kept here so this module stays a leaf. */
const CURLRC_BACKENDS = ['codex', 'claude', 'opencode'] as const satisfies ReadonlyArray<BackendName>;

/**
 * Writes `user-agent = "<agent>"` as the `.curlrc` of the home of every installed backend (its folder exists), at mode
 * 600, a quote or a backslash of the agent escaped as curl reads them; a null or blank agent removes the file. Returns
 * the backends whose home was written or cleared.
 */
export function writeHarnessCurlrc(privateDir: string, agent: string | null): Array<BackendName> {
  const text = agent === null || agent.trim() === '' ? null : agent.trim();
  const done: Array<BackendName> = [];
  for (const backend of CURLRC_BACKENDS) {
    const { dir } = subharnessPlace(privateDir, backend);
    if (!fs.existsSync(dir)) continue;
    const file = path.join(dir, 'home', '.curlrc');
    if (text === null) {
      fs.rmSync(file, { force: true });
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, `user-agent = "${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"\n`, {
        mode: 0o600,
      });
      fs.chmodSync(file, 0o600);
    }
    done.push(backend);
  }
  return done;
}

/**
 * The model id opencode is started with: opencode names a model by its provider and the one provider it has is
 * OpenRouter, so an id that does not start with `openrouter/` gets it once. The other backends take the id as it is.
 */
export function modelOfBackend(backend: BackendName, model: string): string {
  return backend === 'opencode' && !model.startsWith('openrouter/') ? `openrouter/${model}` : model;
}

/** True when the binary of `backend` is a file (a link to one counts) this process may execute. */
export function isInstalled(privateDir: string, backend: BackendName): boolean {
  const { binary } = subharnessPlace(privateDir, backend);
  try {
    fs.accessSync(binary, fs.constants.X_OK);
    return fs.statSync(binary).isFile();
  } catch {
    return false;
  }
}

/** The host variables a vendor CLI inherits. */
const VENDOR_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'] as const;

/** The environment of a vendor command outside an agent run: the plain host variables, then the backend's home. */
export function vendorEnv(
  privateDir: string,
  backend: BackendName,
  host: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of VENDOR_ENV) {
    const value = host[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...subharnessPlace(privateDir, backend).env };
}

/** The login the owner runs at the terminal: her binary, with her home in the environment. */
export type LoginCommand = {
  command: string;
  args: Array<string>;
  env: Record<string, string>;
  /** one shell line: the `NAME=value` assignments of `env`, the binary, the args */
  text: string;
};

/** The login arguments of each backend that has one; opencode takes a key instead. */
const LOGIN_ARGS: Readonly<Partial<Record<BackendName, ReadonlyArray<string>>>> = {
  codex: ['login', '--device-auth'],
  // Read from claude 2.1.317 on 2026-11-17: its commands list `auth` and no `login`, and `claude auth` lists `login`.
  claude: ['auth', 'login'],
};

/** A word as one shell word: bare when it holds only safe characters, else in single quotes. */
const shellWord = (word: string): string =>
  /^[\w./:=@%+-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/** The login of `backend` in `privateDir`, or null for opencode, which takes a key. */
export function loginCommand(privateDir: string, backend: BackendName): LoginCommand | null {
  const args = LOGIN_ARGS[backend];
  if (args === undefined) return null;
  const place = subharnessPlace(privateDir, backend);
  const env = { ...place.env };
  const assignments = Object.entries(env).map(([name, value]) => `${name}=${shellWord(value)}`);
  const text = [...assignments, shellWord(place.binary), ...args.map(shellWord)].join(' ');
  return { command: place.binary, args: [...args], env, text };
}
