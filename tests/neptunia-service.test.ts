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
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRequest } from '../bin/neptunia-request.ts';
import { retiredSetupStep, runUnitVerbs } from '../bin/neptunia-service.ts';
import { readConfig } from '../src/config.ts';
import { localConfigPath } from '../src/config/files.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import type { Parsed } from '../src/interface/commands/table.ts';
import { serviceFamily } from '../src/service/commands.ts';
import { tempDir } from './fixtures/tmp.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(REPO, 'bin', 'neptunia.ts');
// Changed: the watcher left the services for `/doctor watcher` (owner, 2026-11-09).
const MECHANICS = ['heartbeat', 'selfreflection', 'selfimprovement'] as const;
const WAKES = ['heartbeat', 'selfreflection', 'selfimprovement'] as const;
const CORE = 'neptunia-core.service';
/** The clock of the runs in this process, between the two slots most tests name. */
const NOW = Date.parse('2026-11-04T10:00:00Z');

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
/** How the injected manager answers: the word a call fails on, the two reads, or no manager at all. */
type ManagerAnswers = { fail?: string; isActive?: string; isEnabled?: string; absent?: boolean };

const direct = (words: string): Parsed => parseRequest(['services', ...words.split(' ')]).parsed;
/** The two spellings of one command: the same words through the shell's parser and through the chat's. */
const FORMS: ReadonlyArray<{ form: string; parse: (words: string) => Parsed }> = [
  { form: 'neptunia services', parse: (words) => direct(words) },
  { form: 'neptunia -p', parse: (words) => parseCommandLine(`/services ${words}`) },
];

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

/** One command in this process, as the shell's exit codes and streams would show it. */
async function run(
  where: Rig,
  words: string,
  answers: ManagerAnswers = {},
  parse: (words: string) => Parsed = direct
): Promise<Run> {
  const parsed = parse(words);
  if (!parsed.ok) return { code: 2, stdout: '', stderr: parsed.reason, out: parsed.reason };
  const answer = await serviceFamily(
    {
      rootDir: REPO,
      privateDir: where.data,
      dataDir: where.data,
      config: () => readConfig(REPO, { privateDir: where.data }),
      now: () => NOW,
      env: where.env,
      coreUp: false,
      run: (command, args) => {
        if (answers.absent === true) return Promise.resolve({ code: 1, stdout: '', stderr: 'spawn ENOENT' });
        where.calls.push([command, ...args].join(' '));
        if (args.includes('is-active'))
          return Promise.resolve({ code: 0, stdout: `${answers.isActive ?? 'inactive'}\n`, stderr: '' });
        if (args.includes('is-enabled'))
          return Promise.resolve({ code: 0, stdout: `${answers.isEnabled ?? 'disabled'}\n`, stderr: '' });
        if (answers.fail !== undefined && args.includes(answers.fail))
          return Promise.resolve({ code: 1, stdout: '', stderr: 'zeta-manager-refused' });
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      },
    },
    parsed.name,
    parsed.args
  );
  const code = answer.status === 'ok' ? 0 : answer.status === 'invalid' ? 2 : 1;
  return {
    code,
    stdout: code === 0 ? answer.text : '',
    stderr: code === 0 ? '' : answer.text,
    out: answer.text,
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

/** The bytes of the local settings file, or null with no file. */
const rawSettings = (where: Rig): string | null => {
  const file = localConfigPath(where.data);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
};

/** The calls a child's fake manager logged. */
const childCalls = (where: Rig): Array<string> =>
  existsSync(where.log) ? readFileSync(where.log, 'utf8').split('\n').filter(Boolean) : [];

/** The manager's calls that change something: every read of the state left out. */
const changesOf = (calls: ReadonlyArray<string>): Array<string> =>
  calls.filter((line) => !/\b(is-active|is-enabled|show|status|list-timers)\b/.test(line));

const managerChanges = (where: Rig): Array<string> => changesOf(where.calls);

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

/** The moments of a comma-separated `next:` value. */
const momentsOf = (value: string): Array<number> => value.split(',').map((one) => Date.parse(one.trim()));

const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);

// ---- setup ----------------------------------------------------------------------------------------------------------

for (const { form, parse } of FORMS) {
  test(`${form}: setup --at saves the daily times and answers the timezone and the next times`, async () => {
    // Catches: the answer leaves the owner to work out the UTC offset, or the times are saved under another key.
    const where = rig();
    const done = await run(where, 'heartbeat setup --at 00:00,12:00', {}, parse);
    assert.equal(done.code, 0, done.stderr.slice(0, 300));
    assert.equal(settingsOf(where).heartbeat?.schedule, 'at 00:00,12:00');
    assert.equal(field(done.stdout, 'timezone'), 'UTC');
    const next = momentsOf(field(done.stdout, 'next'));
    assert.ok(next.length >= 2, `several next times: ${next.length}`);
    assert.equal(next[0], Date.parse('2026-11-04T12:00:00Z'));
    for (const moment of next) {
      assert.ok(moment > NOW, 'a next time lies ahead');
      assert.ok(['00:00', '12:00'].includes(hhmm(moment)), hhmm(moment));
    }
  });
}

for (const name of MECHANICS) {
  test(`services ${name} setup --every saves one interval and answers times one interval apart`, async () => {
    // Catches: one of the three keeps its own key or answers a time that is no step of its schedule.
    const where = rig();
    const done = await run(where, `${name} setup --every 6h`);
    assert.equal(done.code, 0, done.stderr.slice(0, 300));
    assert.equal(settingsOf(where)[name]?.schedule, 'every 6h');
    const [first, second] = momentsOf(field(done.stdout, 'next'));
    assert.equal((second ?? 0) - (first ?? 0), 6 * 3_600_000);
  });

  for (const enabled of [true, false]) {
    test(`services ${name} setup leaves a flag of ${enabled} as it was`, async () => {
      // Catches: `setup` turns the mechanic on, or writes off over a flag that was on.
      const where = rig({ [name]: { enabled } });
      assert.equal((await run(where, `${name} setup --at 06:00`)).code, 0);
      assert.equal(settingsOf(where)[name]?.enabled, enabled);
    });
  }
}

test('setup stores minutes that make whole hours in the one spelling of the setting', async () => {
  // Catches: the same schedule reads two ways through /config, depending on how it was typed.
  const where = rig();
  assert.equal((await run(where, 'selfreflection setup --every 360m')).code, 0);
  assert.equal(settingsOf(where).selfreflection?.schedule, 'every 6h');
});

test('setup takes an interval in minutes', async () => {
  // Catches: only hours are accepted, so the 90m of the plan is refused.
  const where = rig();
  assert.equal((await run(where, 'selfimprovement setup --every 90m')).code, 0);
  assert.equal(settingsOf(where).selfimprovement?.schedule, 'every 90m');
});

test('setup replaces the mode that was there, leaving no second schedule', async () => {
  // Catches: the at and the every of two runs both stay in the file and the evaluation picks one of them.
  const where = rig({ heartbeat: { schedule: 'every 6h' } });
  assert.equal((await run(where, 'heartbeat setup --at 03:00')).code, 0);
  assert.equal(settingsOf(where).heartbeat?.schedule, 'at 03:00');
});

for (const [what, words, names] of [
  ['mixed modes', 'heartbeat setup --at 00:00 --every 6h', '--every'],
  ['a duplicate slot', 'heartbeat setup --at 00:00,00:00', '--at'],
  ['a malformed time', 'selfreflection setup --at 25:00', '--at'],
  ['a time missing its zero', 'heartbeat setup --at 7:00', '--at'],
  ['a trailing comma', 'heartbeat setup --at 00:00,', '--at'],
  ['a zero interval', 'selfreflection setup --every 0h', '--every'],
  ['a zero interval in minutes', 'selfimprovement setup --every 0m', '--every'],
  ['a negative interval', 'heartbeat setup --every -1h', '--every'],
  ['an interval with no unit', 'heartbeat setup --every 6', '--every'],
  ['--jitter on selfreflection', 'selfreflection setup --every 6h --jitter 5m', '--jitter'],
  ['--jitter on selfimprovement', 'selfimprovement setup --every 6h --jitter 5m', '--jitter'],
  ['--jitter on daily times', 'heartbeat setup --at 06:00 --jitter 5m', '--jitter'],
  ['a negative jitter', 'heartbeat setup --every 3h --jitter -5m', '--jitter'],
  ['--at with no value', 'selfimprovement setup --at', '--at'],
] as const) {
  for (const { form, parse } of FORMS) {
    test(`${form}: setup refuses ${what} with exit 2, names ${names} and writes nothing`, async () => {
      // Catches: a value the schedule cannot run is stored, and the service then never falls due, or the manager reloads.
      const local = { selfreflection: { enabled: true, schedule: 'at 01:00' }, heartbeat: { schedule: 'every 3h' } };
      const where = rig(local);
      const before = rawSettings(where);
      const done = await run(where, words, {}, parse);
      assert.equal(done.code, 2, done.out.slice(0, 300));
      assert.ok(done.stderr.includes(names), done.stderr.slice(0, 300));
      assert.equal(rawSettings(where), before);
      assert.deepEqual(managerChanges(where), []);
    });
  }
}

test('services heartbeat setup --jitter alone changes the jitter and keeps the interval', async () => {
  // Catches: the jitter cannot be changed without retyping the schedule, or its run resets the schedule.
  const where = rig({ heartbeat: { schedule: 'every 4h', jitterMinutes: 45 } });
  assert.equal((await run(where, 'heartbeat setup --jitter 20m')).code, 0);
  assert.deepEqual(settingsOf(where).heartbeat, { schedule: 'every 4h', jitterMinutes: 20 });
});

test('services heartbeat setup --jitter 0m turns the jitter off', async () => {
  // Catches: zero is read as a missing or invalid duration, so a fixed interval cannot be asked for.
  const where = rig({ heartbeat: { schedule: 'every 4h', jitterMinutes: 45 } });
  assert.equal((await run(where, 'heartbeat setup --every 2h --jitter 0m')).code, 0);
  assert.deepEqual(settingsOf(where).heartbeat, { schedule: 'every 2h', jitterMinutes: 0 });
});

test('services heartbeat setup --jitter is refused while the schedule is daily times', async () => {
  // Catches: a stored `at` schedule takes a jitter that nothing applies, and the answer claims it.
  const where = rig({ heartbeat: { schedule: 'at 06:00' } });
  const before = rawSettings(where);
  const done = await run(where, 'heartbeat setup --jitter 20m');
  assert.equal(done.code, 2, done.out.slice(0, 300));
  assert.ok(done.stderr.includes('--jitter'), done.stderr.slice(0, 300));
  assert.equal(rawSettings(where), before);
});

for (const { form, parse } of FORMS) {
  test(`${form}: setup with no option names what is missing and saves nothing`, async () => {
    // Catches: the run saves a default where the owner gave none, or the answer leaves him without the flags.
    const where = rig();
    const done = await run(where, 'heartbeat setup', {}, parse);
    assert.equal(done.code, 2, done.out.slice(0, 300));
    assert.equal(done.stdout, '');
    assert.ok(done.stderr.includes('--at'), done.stderr.slice(0, 300));
    assert.ok(done.stderr.includes('--every'), done.stderr.slice(0, 300));
    assert.equal(rawSettings(where), null);
  });
}

for (const name of WAKES) {
  test(`services ${name} setup calls no manager: her wakes run in the core`, async () => {
    // Catches: a persona wake gets a daemon or a timer of its own beside the core's scheduler.
    const where = rig();
    assert.equal((await run(where, `${name} setup --at 06:00`)).code, 0);
    assert.deepEqual(where.calls, []);
  });
}

// ---- enable and disable ---------------------------------------------------------------------------------------------

for (const name of WAKES) {
  for (const { form, parse } of FORMS) {
    test(`${form}: enable and disable of ${name} move its flag, with no manager and no core`, async () => {
      // Catches: the flag needs a core to be written, so a mechanic cannot be switched off while the core is down.
      const where = rig({ [name]: { enabled: false } });
      assert.equal((await run(where, `${name} enable`, {}, parse)).code, 0);
      assert.equal(settingsOf(where)[name]?.enabled, true);
      assert.equal((await run(where, `${name} disable`, {}, parse)).code, 0);
      assert.equal(settingsOf(where)[name]?.enabled, false);
      assert.deepEqual(where.calls, []);
    });
  }
}

test('a second enable changes no byte of the settings file and succeeds', async () => {
  // Catches: the file is rewritten on every call, which wakes every reader of the hot settings for nothing.
  const where = rig({ heartbeat: { enabled: true, schedule: 'every 3h' } });
  const file = localConfigPath(where.data);
  const before = { text: readFileSync(file, 'utf8'), changed: statSync(file).mtimeMs };
  const done = await run(where, 'heartbeat enable');
  assert.equal(done.code, 0, done.out.slice(0, 300));
  assert.deepEqual({ text: readFileSync(file, 'utf8'), changed: statSync(file).mtimeMs }, before);
});

test('enable keeps the other settings of the file', async () => {
  // Catches: the flag is written over the section, and the owner's schedule and keys are lost.
  const where = rig({ heartbeat: { enabled: false, jitterMinutes: 45 }, bot: { timezone: 'UTC' } });
  assert.equal((await run(where, 'heartbeat enable')).code, 0);
  assert.deepEqual(settingsOf(where), { heartbeat: { enabled: true, jitterMinutes: 45 }, bot: { timezone: 'UTC' } });
});

test('selfimprovement enable saves the flag with no repository and no backend, and status says what is missing', async () => {
  // Catches: readiness refuses the flag, as the old setup step did, so the saved state cannot be set before the backend.
  const where = rig({ selfimprovement: { enabled: false } });
  assert.equal((await run(where, 'selfimprovement enable')).code, 0);
  assert.equal(settingsOf(where).selfimprovement?.enabled, true);
  const status = await run(where, 'selfimprovement status');
  assert.equal(field(status.stdout, 'enabled'), 'true');
  assert.match(field(status.stdout, 'readiness'), /^not ready/);
});

// ---- status ---------------------------------------------------------------------------------------------------------

/** Every file and folder under `dir`, to prove a read wrote none. */
const treeOf = (dir: string): Array<string> =>
  (readdirSync(dir, { recursive: true }) as Array<string>).map(String).sort();

for (const { form, parse } of FORMS) {
  test(`${form}: status with no core answers each field apart and exits 0`, async () => {
    // Catches: the core being down reads as disabled, or status fails where the saved state could be read from disk.
    const where = rig({ heartbeat: { enabled: true, schedule: 'at 06:00,18:00' } });
    const done = await run(where, 'heartbeat status', {}, parse);
    assert.equal(done.code, 0, done.out.slice(0, 300));
    assert.equal(field(done.stdout, 'service'), 'heartbeat');
    assert.equal(field(done.stdout, 'enabled'), 'true');
    assert.equal(field(done.stdout, 'running'), 'unknown');
    assert.match(field(done.stdout, 'readiness'), /^not ready.*core/);
    assert.equal(field(done.stdout, 'schedule'), 'at 06:00,18:00');
    assert.equal(Date.parse(field(done.stdout, 'next due')), Date.parse('2026-11-04T18:00:00Z'));
    assert.notEqual(field(done.stdout, 'last result'), '');
  });
}

test('status of a disabled service has no next time, and the same schedule', async () => {
  // Catches: a disabled service promises a next run, so the owner cannot tell the flag from the schedule.
  const where = rig({ heartbeat: { enabled: false, schedule: 'at 06:00' } });
  const done = await run(where, 'heartbeat status');
  assert.equal(field(done.stdout, 'enabled'), 'false');
  assert.equal(field(done.stdout, 'schedule'), 'at 06:00');
  assert.equal(field(done.stdout, 'next due'), 'none');
});

test('status writes nothing and starts no process that changes the manager', async () => {
  // Catches: reading the status creates the data folders or the database, so a read changes a stopped deployment.
  const where = rig({ heartbeat: { enabled: true, schedule: 'every 6h' } });
  const before = treeOf(where.root);
  const raw = rawSettings(where);
  assert.equal((await run(where, 'heartbeat status')).code, 0);
  assert.deepEqual(treeOf(where.root), before);
  assert.equal(rawSettings(where), raw);
  assert.deepEqual(managerChanges(where), []);
});

// ---- the verbs of the system units -----------------------------------------------------------------------------------

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

for (const verb of ['start', 'stop', 'restart']) {
  test(`services watcher ${verb} is refused and touches no unit`, async () => {
    // Catches: the two orders of the words are read as one family, so a mechanic is started through systemctl.
    const where = rig();
    const done = await run(where, `watcher ${verb}`);
    assert.equal(done.code, 2, done.out.slice(0, 300));
    assert.ok(done.stderr.includes('enable'), `it names the actions: ${done.stderr.slice(0, 300)}`);
    assert.deepEqual(where.calls, []);
  });
}

// ---- the competing controls -----------------------------------------------------------------------------------------

// Changed: the retired names are gone with the rest of the legacy, so such a line is refused like any line the table
// does not hold, and names no replacement.
for (const argv of [['watcher', 'run'], ['watcher'], ['selfimprovement', 'run'], ['selfimprovement'], ['report']]) {
  test(`neptunia ${argv.join(' ')} is refused before any handler`, () => {
    // Catches: the old form still parses into a command that runs an inspection or a beat.
    assert.equal(parseRequest(argv).parsed.ok, false);
  });
}

test('neptunia -p /report is refused before any handler', () => {
  // Catches: the line of the chat still reads a report, so the old command lives on behind -p.
  assert.equal(parseCommandLine('/report 2026-11-03').ok, false);
});

for (const [step, names] of [
  ['watcher', 'neptunia setup'],
  ['selfimprovement', 'services selfimprovement setup'],
  ['mechanics', 'neptunia services'],
] as const) {
  test(`neptunia setup ${step} is retired and names ${names}`, () => {
    // Catches: the step runs its old dialog, a second way to set what the family sets.
    assert.ok((retiredSetupStep([step]) ?? '').includes(names), step);
  });
}

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

test('child: neptunia watcher run exits 2, names the family and runs nothing', async () => {
  // Catches: the old form still runs an inspection, or stops at a usage text with no way forward.
  const where = rig({ watcher: { enabled: true } });
  const before = treeOf(where.root);
  const done = await child(where, ['watcher', 'run']);
  assert.equal(done.code, 2, done.out.slice(0, 300));
  assert.ok(done.stderr.includes('services watcher'), done.stderr.slice(0, 300));
  assert.deepEqual(treeOf(where.root), before);
});

test('child: service restart in a user install goes to the user manager', async () => {
  // Catches: the unit verbs ignore the scope, so a user install's restart asks the system manager for units it lacks.
  const where = rig();
  assert.equal((await child(where, ['services', 'restart', 'neptunia-core.service'])).code, 0);
  assert.deepEqual(childCalls(where), ['systemctl --user restart neptunia-core.service']);
});

test('child: the usage shows the family and none of the retired forms, and hides the worker the unit starts', async () => {
  // Catches: help keeps teaching the forms that now only explain themselves, or lists the internal entry point.
  const unit = readFileSync(join(REPO, 'deploy', 'neptunia-watcher.service'), 'utf8');
  const exec = /^ExecStart=\S+ bin\/neptunia\.ts (.+)$/m.exec(unit)?.[1] ?? assert.fail('it starts bin/neptunia.ts');
  const done = await child(rig(), ['no-such-word-71']);
  assert.equal(done.code, 2, done.out.slice(0, 300));
  assert.ok(done.stderr.includes('services <name>'), done.stderr.slice(0, 600));
  for (const gone of [
    'neptunia watcher run',
    'watcher trigger',
    'selfimprovement run',
    'mechanics',
    '/report',
    exec.split(' ')[0] ?? '',
  ])
    assert.equal(done.stderr.includes(gone), false, gone);
});

test('child: the worker the watcher unit starts is a word the command knows', async () => {
  // Catches: ExecStart names a command that was retired or never added, so every /doctor watcher run fails with usage.
  const unit = readFileSync(join(REPO, 'deploy', 'neptunia-watcher.service'), 'utf8');
  const exec = /^ExecStart=\S+ bin\/neptunia\.ts (.+)$/m.exec(unit)?.[1] ?? assert.fail('it starts bin/neptunia.ts');
  // No board and no backend here, so the worker ends by itself with its own failure, never with usage.
  const worker = await child(rig(), exec.split(' '), {}, 20_000);
  assert.notEqual(worker.code, 2, worker.out.slice(0, 300));
  assert.equal(worker.stderr.startsWith('neptunia: usage:'), false, worker.stderr.slice(0, 300));
});

test('children: concurrent setups of the three keep every schedule', async () => {
  // Catches: each process reads and rewrites the whole settings file, so the last writer drops the others' schedules.
  const where = rig({ bot: { timezone: 'UTC' } });
  const runs = await Promise.all(MECHANICS.map((name) => child(where, ['services', name, 'setup', '--at', '06:00'])));
  assert.deepEqual(
    runs.map((one) => one.code),
    [0, 0, 0]
  );
  const saved = settingsOf(where);
  for (const name of MECHANICS) assert.equal(saved[name]?.schedule, 'at 06:00', name);
  assert.deepEqual(saved.bot, { timezone: 'UTC' });
});
