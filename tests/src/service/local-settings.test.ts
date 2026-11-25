// `neptunia services <name> setup|enable|disable|status` and `/services ...`. The argument matrix and the answers run in
// this process: a line goes through the parser the shell and the chat use (`parseRequest`, `parseCommandLine`) into the
// handler (`serviceFamily`) over temporary folders, with the manager injected. A few children of bin/neptunia.ts hold
// what only a process proves: the direct form end to end, the exit codes, the real argv of a fake `systemctl` and `sudo`
// on an otherwise empty PATH in both scopes, a failed manager call, a retired command, and the file lock between
// processes. A test asserts on exit codes, files, the manager's argv and the `key: value` lines of an answer, never on
// wording.
//
// The manager's scope is the core's installed unit: under `$XDG_CONFIG_HOME/systemd/user/` it is the user manager
// (`systemctl --user`), otherwise the system manager (`sudo systemctl`), and `NEPTUNIA_UNIT_SCOPE=user|system` says it
// outright. Exit codes: 0 success, 1 an operational failure, 2 bad syntax or missing input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localConfigPath } from '../../../src/config/files.ts';
import { tempDir } from '../../fixtures/tmp.ts';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const BIN = join(REPO, 'bin', 'neptunia.ts');
const MECHANICS = ['heartbeat', 'diary'] as const;
const CORE = 'neptunia-core.service';

type Settings = Record<string, Record<string, unknown>>;
type Scope = 'user' | 'system';
type Run = { code: number | null; stdout: string; stderr: string; out: string };
type Rig = {
  root: string;
  data: string;
  xdg: string;
  log: string;
  /** The manager's calls of the runs in this process. */
  calls: Array<string>;
  env: NodeJS.ProcessEnv;
};

/**
 * A fake manager for a child: it logs its argv under its own name, prints `FAKE_IS_ACTIVE` and `FAKE_IS_ENABLED` for those
 * reads, and fails a call holding the word in `FAKE_FAIL`. The fake `sudo` logs itself and runs what it was given.
 */
const SYSTEMCTL = `#!/bin/sh
printf 'systemctl %s\\n' "$*" >> "$FAKE_LOG"
case " $* " in
  *" is-active "*) printf '%s\\n' "\${FAKE_IS_ACTIVE:-inactive}"; [ "\${FAKE_IS_ACTIVE:-inactive}" = active ]; exit $? ;;
  *" is-enabled "*) printf '%s\\n' "\${FAKE_IS_ENABLED:-disabled}"; [ "\${FAKE_IS_ENABLED:-disabled}" = enabled ]; exit $? ;;
esac
if [ -n "$FAKE_FAIL" ]; then
  case " $* " in *" $FAKE_FAIL "*) echo "zeta-manager-refused" >&2; exit 1 ;; esac
fi
exit 0
`;
const SUDO = `#!/bin/sh
[ "$1" = -n ] && shift
printf 'sudo %s\\n' "$*" >> "$FAKE_LOG"
if [ "$1" = systemctl ]; then shift; exec systemctl "$@"; fi
if [ -n "$FAKE_FAIL" ] && [ "$1" = "$FAKE_FAIL" ]; then exit 1; fi
exit 0
`;

const CORE_TEXT = '[Unit]\nDescription=neptunia core\n';

/** Fresh folders with the settings of `local`, the fake manager on an otherwise empty PATH, and the core unit of `scope`. */
function rig(local: Settings | null = null, scope: Scope = 'user'): Rig {
  const root = tempDir('nep-service-');
  const data = join(root, 'd');
  const home = join(root, 'home');
  const xdg = join(root, 'xdg');
  const bin = join(root, 'bin');
  const log = join(root, 'manager.log');
  mkdirSync(join(data, 'config'), { recursive: true });
  mkdirSync(home);
  mkdirSync(bin);
  if (local !== null) writeFileSync(localConfigPath(data), JSON.stringify(local));
  for (const [name, text] of [
    ['systemctl', SYSTEMCTL],
    ['sudo', SUDO],
  ] as const) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  if (scope === 'user') {
    mkdirSync(join(xdg, 'systemd', 'user'), { recursive: true });
    writeFileSync(join(xdg, 'systemd', 'user', CORE), CORE_TEXT);
  }
  return {
    root,
    data,
    xdg,
    log,
    calls: [],
    env: {
      TMPDIR: process.env.TMPDIR,
      PATH: bin,
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      NEPTUNIA_DATA_DIR: data,
      NEPTUNIA_UNIT_SCOPE: scope,
      FAKE_LOG: log,
    },
  };
}

/** One real `neptunia` to its end, its input open; a run past `ms` is killed and fails the test. */
function child(where: Rig, argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}, ms = 15_000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const started = spawn(process.execPath, [BIN, ...argv], {
      cwd: REPO,
      env: { ...where.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    started.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    started.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      started.kill('SIGKILL');
      reject(new Error(`neptunia ${argv.join(' ')} did not end within ${ms} ms: ${stderr.slice(-500)}`));
    }, ms);
    started.once('close', (code) => {
      clearTimeout(timer);
      started.stdin.destroy();
      resolve({ code, stdout, stderr, out: stdout + stderr });
    });
  });
}

const settingsOf = (where: Rig): Settings => {
  const file = localConfigPath(where.data);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Settings) : {};
};

test('children: concurrent setups of the two keep every schedule', async () => {
  // Catches: each process reads and rewrites the whole settings file, so the last writer drops the others' schedules.
  const where = rig({ bot: { timezone: 'UTC' } });
  const runs = await Promise.all(MECHANICS.map((name) => child(where, ['services', name, 'setup', '--at', '06:00'])));
  assert.deepEqual(
    runs.map((one) => one.code),
    [0, 0]
  );
  const saved = settingsOf(where);
  for (const name of MECHANICS) assert.equal(saved[name]?.schedule, 'at 06:00', name);
  assert.deepEqual(saved.bot, { timezone: 'UTC' });
});
