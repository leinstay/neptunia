// The verbs of the system units in bin/neptunia-service.ts: `runUnitVerbs` refuses a mechanic's name in the place of a
// unit, before anything is spawned.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { runUnitVerbs } from '../../bin/neptunia-service.ts';
import { parseRequest } from '../../bin/neptunia-request.ts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join, relative } from 'node:path';
import { cliFolders, handled, runChild, startRecordingCore } from '../fixtures/recording-core.ts';
import type { RecordingCore } from '../fixtures/recording-core.ts';
import type { Dirs } from '../fixtures/core-units.ts';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localConfigPath } from '../../src/config/files.ts';
import { tempDir } from '../fixtures/tmp.ts';

const MECHANICS = ['heartbeat', 'diary'] as const;

/** Why `runUnitVerbs` refuses `words`: its refusal ends the process, so here it throws before anything is spawned. */
function unitVerbRefusal(words: ReadonlyArray<string>): string {
  try {
    runUnitVerbs(words, (reason) => {
      throw new Error(reason);
    });
  } catch (err) {
    return (err as Error).message;
  }
  return assert.fail(`${words.join(' ')} was not refused`);
}

for (const name of MECHANICS) {
  test(`services status ${name} is refused and names services ${name} status, with no manager called`, () => {
    // Catches: the mechanic's name reaches systemctl as a unit, so a wrong word order reports "unit not found".
    assert.ok(unitVerbRefusal(['status', name]).includes(`services ${name} status`));
  });
}

// ---- hints that name a command ---------------------------------------------------------------------------------------

/** The retired spelling of the family: `neptunia service` followed by anything but the plural's `s`. */
const RETIRED_SPELLING = /neptunia service(?!s)\b/;

/** What `refuse` threw, for a call of `runUnitVerbs` that must end in a refusal. */
class Refused extends Error {}

function refusalOf(words: ReadonlyArray<string>): string {
  try {
    runUnitVerbs(words, (reason) => {
      throw new Refused(reason);
    });
  } catch (err) {
    if (err instanceof Refused) return err.message;
    throw err;
  }
  return assert.fail(`${words.join(' ')} was not refused`);
}

test('the order of the unit verbs and a mechanism name is refused with a hint that parses', () => {
  // Catches: `services status heartbeat` is taken for a unit named heartbeat, or the hint names a spelling that is retired.
  // Changed: the watcher and its refusal are gone (maintainer, 2026-11-16).
  const hint = refusalOf(['status', 'heartbeat']);
  assert.equal(RETIRED_SPELLING.test(hint), false, hint);
  const named = /use neptunia (services heartbeat \w+)/.exec(hint)?.[1] ?? '';
  assert.notEqual(named, '', hint);
  assert.equal(parseRequest(named.split(' ')).parsed.ok, true, named);
});

// Changed: the watcher's evidence read is gone with the watcher (maintainer, 2026-11-16).
for (const words of [['list'], ['heartbeat', 'setup', '--every', '3h']]) {
  test(`neptunia services ${words.join(' ')} is the family and returns to its caller`, () => {
    // Catches: `list` is taken for a unit verb and refused, or a mechanism's word order stops reaching the family.
    assert.doesNotThrow(() =>
      runUnitVerbs(words, (reason) => {
        throw new Refused(reason);
      })
    );
  });
}

let online: Dirs;

let offline: Dirs;

let core: RecordingCore;

let bin: string;

let unitLog: string;

let journalLog: string;

const LOCAL = { PATH: '' };

before(async () => {
  online = cliFolders();
  core = await startRecordingCore(online, handled);
  offline = cliFolders();
  bin = join(offline.root, 'bin');
  unitLog = join(offline.root, 'units.log');
  journalLog = join(offline.root, 'journal.log');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\necho "$*" >> "${unitLog}"\necho "zeta-systemctl $*"\nexit 3\n`, {
    mode: 0o755,
  });
  writeFileSync(join(bin, 'journalctl'), `#!/bin/sh\necho "$*" >> "${journalLog}"\necho zeta-journal\nexit 0\n`, {
    mode: 0o755,
  });
  LOCAL.PATH = bin;
});

after(async () => {
  await core.close();
  rmSync(online.root, { recursive: true, force: true });
  rmSync(offline.root, { recursive: true, force: true });
});

/** The core emptied, and the fakes' logs. */
function fresh(): void {
  core.commands.length = 0;
  core.lines.length = 0;
  rmSync(unitLog, { force: true });
  rmSync(journalLog, { force: true });
}

const run = (dirs: Dirs, argv: ReadonlyArray<string>): ReturnType<typeof runChild> =>
  runChild(dirs, argv, { env: { PATH: LOCAL.PATH } });

/** Every file of `dir` with the hash of its bytes. */
function digest(dir: string): string {
  const rows: Array<string> = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        rows.push(`d ${relative(dir, path)}`);
        walk(path);
      } else {
        rows.push(`f ${relative(dir, path)} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
      }
    }
  };
  walk(dir);
  return rows.join('\n');
}

// Changed: `neptunia tasks` is gone with the board's command line (maintainer, 2026-11-16).

test('neptunia services list answers with no core, lists the two mechanisms and changes nothing', async () => {
  // Catches: the list needs the core, lists a unit, or writes a setting or moves a timer while it reads.
  fresh();
  const before = digest(offline.dataDir);
  const done = await run(offline, ['services', 'list']);
  assert.equal(done.code, 0, done.stderr.slice(0, 300));
  for (const name of ['heartbeat', 'diary']) assert.ok(done.stdout.includes(name), name);
  assert.equal(digest(offline.dataDir), before);
  const calls = existsSync(unitLog) ? readFileSync(unitLog, 'utf8').split('\n').filter(Boolean) : [];
  assert.deepEqual(
    calls.filter((line) => !/\b(is-active|is-enabled|show|status|list-timers)\b/.test(line)),
    []
  );
});

test('/services diary status gives the same answer from the chat line and from argv, with no core', async () => {
  // Catches: the two spellings of one command reach different handlers.
  // The diary, whose next time has no jitter, stands in for a service.
  fresh();
  const direct = await run(offline, ['services', 'diary', 'status']);
  const line = await run(offline, ['-p', '/services diary status']);
  assert.equal(direct.code, 0, direct.stderr.slice(0, 300));
  assert.equal(line.code, 0, line.stderr.slice(0, 300));
  assert.equal(line.stdout, direct.stdout);
  assert.ok(direct.stdout.includes('diary'));
});

const REPO = fileURLToPath(new URL('../..', import.meta.url));

const BIN = join(REPO, 'bin', 'neptunia.ts');

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

/** The bytes of the local settings file, or null with no file. */
const rawSettings = (where: Rig): string | null => {
  const file = localConfigPath(where.data);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
};

/** The calls a child's fake manager logged. */
const childCalls = (where: Rig): Array<string> =>
  existsSync(where.log) ? readFileSync(where.log, 'utf8').split('\n').filter(Boolean) : [];

/** The `key: value` lines of an answer. */
function fieldsOf(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) {
    const found = /^([a-z][a-z ]*): (.*)$/.exec(line);
    if (found !== null) fields.set(found[1] ?? '', found[2] ?? '');
  }
  return fields;
}

const field = (text: string, key: string): string => {
  const value = fieldsOf(text).get(key);
  return value ?? assert.fail(`no "${key}:" line in: ${text.slice(0, 400)}`);
};

// ---- the verbs of the system units -----------------------------------------------------------------------------------

// ---- what only a real process proves --------------------------------------------------------------------------------

test('child: -p reaches the same handler with no core and exits 0', async () => {
  // Catches: `-p` sends the line to a core that is down, so a mechanic cannot be read while it is down.
  const where = rig({ heartbeat: { enabled: true, schedule: 'at 06:00,18:00' } });
  const done = await child(where, ['-p', '/services heartbeat status']);
  assert.equal(done.code, 0, done.out.slice(0, 300));
  assert.equal(field(done.stdout, 'enabled'), 'true');
  assert.equal(field(done.stdout, 'running'), 'unknown');
});

test('child: setup with no option and no terminal exits 2 at once, with the input left open', async () => {
  // Catches: the dialog waits on a pipe nobody writes to, so a script hangs.
  const where = rig();
  const done = await child(where, ['services', 'heartbeat', 'setup'], {}, 5000);
  assert.equal(done.code, 2, done.out.slice(0, 300));
  assert.equal(done.stdout, '');
  assert.ok(done.stderr.includes('--at') && done.stderr.includes('--every'), done.stderr.slice(0, 300));
  assert.equal(rawSettings(where), null);
});

test('child: service restart in a user install goes to the user manager', async () => {
  // Catches: the unit verbs ignore the scope, so a user install's restart asks the system manager for units it lacks.
  const where = rig();
  assert.equal((await child(where, ['services', 'restart', 'neptunia-core.service'])).code, 0);
  assert.deepEqual(childCalls(where), ['systemctl --user restart neptunia-core.service']);
});
