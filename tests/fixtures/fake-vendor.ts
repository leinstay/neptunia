// A disposable vendor CLI for the subharness tests: a shell script at the place of the backend's binary
// (src/subharness/place.ts) that keeps its login as a file in the home its environment names, as the real CLIs do. It
// answers the commands the installed releases list in their help: `claude auth login|status|logout`, `codex login`,
// `codex login status`, `codex logout`. Anything else is a model run, which only records itself and can be held open.
// `install` is the fake of the npm runner, which puts the script in place. No test reaches a vendor, npm or a network.
import fs from 'node:fs';
import path from 'node:path';
import { subharnessPlace } from '../../src/subharness/place.ts';
import type { InstallRun } from '../../src/subharness/install.ts';
import { tempDir } from './tmp.ts';

/** What the vendor's login does: logs in, fails, is interrupted, or exits 0 having done nothing. */
export type FakeLogin = 'ok' | 'fail' | 'cancel' | 'no-effect';

export type FakeVendorOptions = {
  /** the binary is in place; false leaves it to `install`. Default true. */
  installed?: boolean;
  /** the home holds a login already. Default false. */
  loggedIn?: boolean;
  /** Default `ok`. */
  login?: FakeLogin;
  /** the npm fake exits with this code and installs nothing. Default 0. */
  installExit?: number;
};

export type FakeVendor = {
  binary: string;
  home: string;
  /** the argv of every call, joined with spaces, in order */
  calls(): Array<string>;
  /** the home each call saw, in order */
  homes(): Array<string>;
  /** the argv of every npm call */
  installs: Array<ReadonlyArray<string>>;
  install: InstallRun;
  loggedIn(): boolean;
  setLogin(login: FakeLogin): void;
  /** Keeps the next logins or model runs open until `release`. */
  hold(what: 'login' | 'run'): void;
  release(what: 'login' | 'run'): void;
  /** Resolves once a held login or model run has started. */
  started(what: 'login' | 'run'): Promise<void>;
  /** The folder of the script's control files, for a child process that shares the fake. */
  control: string;
};

const script = (control: string): string => `#!/bin/sh
PATH=/usr/bin:/bin
control='${control}'
home="\${CLAUDE_CONFIG_DIR:-$CODEX_HOME}"
printf '%s\\n' "$*" >> "$control/calls"
printf '%s\\n' "$home" >> "$control/homes"
case "$*" in
  --help)
    printf 'Commands:\\n  auth    Manage authentication\\n  login   Manage login\\n  logout  Log out\\n'
    exit 0
    ;;
  'auth login'|'login --device-auth')
    : > "$control/started-login"
    while [ -f "$control/hold-login" ]; do sleep 0.01; done
    case "$(cat "$control/login")" in
      ok) mkdir -p "$home"; : > "$home/credentials"; exit 0 ;;
      fail) echo 'vendor: login failed' >&2; exit 1 ;;
      cancel) kill -INT $$; exit 130 ;;
      *) exit 0 ;;
    esac
    ;;
  'auth status'|'login status')
    [ -f "$home/credentials" ]
    exit $?
    ;;
  'auth logout'|'logout')
    rm -f "$home/credentials"
    exit 0
    ;;
esac
: > "$control/started-run"
while [ -f "$control/hold-run" ]; do sleep 0.01; done
cat > /dev/null
echo ok
exit 0
`;

const linesOf = (file: string): Array<string> => {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '');
  } catch {
    return [];
  }
};

/** The fake of `backend` under `privateDir`; its control files stay outside the private layer. */
export function fakeVendor(
  privateDir: string,
  backend: 'codex' | 'claude',
  options: FakeVendorOptions = {}
): FakeVendor {
  const control = tempDir('nep-fake-vendor-');
  const place = subharnessPlace(privateDir, backend);
  const home = path.join(place.dir, 'home');
  const text = script(control);
  const put = (): void => {
    fs.mkdirSync(path.dirname(place.binary), { recursive: true });
    fs.writeFileSync(place.binary, text, { mode: 0o755 });
  };
  fs.writeFileSync(path.join(control, 'login'), options.login ?? 'ok');
  if (options.installed !== false) put();
  if (options.loggedIn === true) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'credentials'), '');
  }
  const installs: Array<ReadonlyArray<string>> = [];
  return {
    binary: place.binary,
    home,
    control,
    calls: () => linesOf(path.join(control, 'calls')),
    homes: () => linesOf(path.join(control, 'homes')),
    installs,
    install: (command, args) => {
      installs.push([command, ...args]);
      const code = options.installExit ?? 0;
      if (code === 0) put();
      return Promise.resolve({ code, stdout: '', stderr: code === 0 ? '' : 'npm: the registry refused' });
    },
    loggedIn: () => fs.existsSync(path.join(home, 'credentials')),
    setLogin: (login) => fs.writeFileSync(path.join(control, 'login'), login),
    hold: (what) => fs.writeFileSync(path.join(control, `hold-${what}`), ''),
    release: (what) => fs.rmSync(path.join(control, `hold-${what}`), { force: true }),
    async started(what) {
      const file = path.join(control, `started-${what}`);
      for (let waited = 0; waited < 3000 && !fs.existsSync(file); waited += 5)
        await new Promise((resolve) => setTimeout(resolve, 5));
      if (!fs.existsSync(file)) throw new Error(`the fake vendor's ${what} did not start`);
    },
  };
}

/** Every file under `dir` with its content, for a test that says nothing changed. */
export function treeOf(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    files[path.relative(dir, file)] = fs.readFileSync(file, 'utf8');
  }
  return files;
}
