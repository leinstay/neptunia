// Where a subharness backend lives: `<private>/subharness/<backend>/` holds the backend's binary and its home, so the
// persona's agents run on her own install and her own login, never on the installing user's CLI or its `~/.codex`.
// `npm install --prefix` puts the binary of `claude` and `codex` under `node_modules/.bin/`, and `opencode` is one
// executable under `bin/`. The home goes to every run (src/agent-runner/backend.ts, `createInstalledBackend`) and to
// the login the owner types (`neptunia setup subharness`), as the variable each CLI reads its home from. The paths are
// computed; `isInstalled` is the one look at the disk, and `helpOfInstalled` the one run of the binary outside an agent
// run, which reads its `--help` so the effort flag is offered only to a binary that takes it.

import { execFile } from 'node:child_process';
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
        env: { CLAUDE_CONFIG_DIR: home, DISABLE_AUTOUPDATER: '1' },
      };
    case 'codex':
      return { dir, binary: path.join(dir, 'node_modules', '.bin', 'codex'), env: { CODEX_HOME: home } };
    case 'opencode':
      return {
        dir,
        binary: path.join(dir, 'bin', 'opencode'),
        env: {
          XDG_CONFIG_HOME: path.join(home, 'config'),
          XDG_DATA_HOME: path.join(home, 'data'),
          OPENCODE_DISABLE_AUTOUPDATE: '1',
        },
      };
  }
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
  claude: ['login'],
};

/** A word as one shell word: bare when it holds only safe characters, else in single quotes. */
const shellWord = (word: string): string =>
  /^[\w./:=@%+-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * The commands a CLI's `--help` lists under its `Commands:` heading: the first word of each line at the column of the
 * heading's first entry. A deeper line is a wrapped description, whatever word it starts with.
 */
function commandsOf(help: string): Array<string> {
  const lines = help.split('\n');
  const start = lines.findIndex((line) => /^commands:\s*$/i.test(line.trim()));
  if (start === -1) return [];
  const words: Array<string> = [];
  let column = -1;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (column === -1) column = indent;
    if (indent === 0 || indent < column) break;
    if (indent > column) continue;
    const word = /^([a-z][\w-]*)/.exec(line.trimStart())?.[1];
    if (word !== undefined) words.push(word);
  }
  return words;
}

/** The login arguments the installed claude's `help` names; throws for a help that names none. */
function claudeLoginArgs(help: string): ReadonlyArray<string> {
  const commands = commandsOf(help);
  if (commands.includes('login')) return ['login'];
  if (commands.includes('auth')) return ['auth', 'login'];
  // On a release without the command, `claude login` is a prompt to the model: it spends a turn and logs nobody in.
  throw new Error('claude --help names neither auth nor login; read its help to find how this release logs in');
}

/**
 * The login of `backend` in `privateDir`, or null for opencode, which takes a key. `help` is the installed claude's
 * `--help`, and the login is the one it lists: `login`, else `auth login`. A help that lists neither throws.
 */
export function loginCommand(privateDir: string, backend: BackendName, help?: string): LoginCommand | null {
  const args = backend === 'claude' && help !== undefined ? claudeLoginArgs(help) : LOGIN_ARGS[backend];
  if (args === undefined) return null;
  const place = subharnessPlace(privateDir, backend);
  const env = { ...place.env };
  const assignments = Object.entries(env).map(([name, value]) => `${name}=${shellWord(value)}`);
  const text = [...assignments, shellWord(place.binary), ...args.map(shellWord)].join(' ');
  return { command: place.binary, args: [...args], env, text };
}

/** How long `--help` may take (ms). */
const HELP_MS = 10_000;

/** The `--help` output of the installed binary of `backend`, run with its home; rejects when it cannot run. */
export function helpOfInstalled(privateDir: string, backend: BackendName): Promise<string> {
  const place = subharnessPlace(privateDir, backend);
  return new Promise((resolve, reject) => {
    const child = execFile(
      place.binary,
      ['--help'],
      { timeout: HELP_MS, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...place.env } },
      (error, stdout) => {
        if (error === null) resolve(stdout);
        else reject(new Error(`${backend} --help did not run`));
      }
    );
    child.stdin?.end();
  });
}
