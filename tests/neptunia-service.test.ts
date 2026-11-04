// `neptunia service <name> setup|enable|disable|status` and `/service ...` through `-p`, at the real argv boundary: each
// run is a child process of bin/neptunia.ts over temporary folders, with no core, a PATH holding only a fake `systemctl`
// and a fake `sudo`, and an input left open so a question nobody answers fails by its time limit. A run asserts on exit
// codes, files, the manager's argv and the `key: value` lines of an answer, never on wording.
//
// The manager's scope is the watcher's installed timer: under `$XDG_CONFIG_HOME/systemd/user/` it is the user manager
// (`systemctl --user`), otherwise the system manager (`sudo systemctl`), and `NEPTUNIA_UNIT_SCOPE=user|system` says it
// outright. Exit codes: 0 success, 1 an operational failure, 2 bad syntax or missing input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localConfigPath } from '../src/config/files.ts';
import { reportsDirOf, watcherDir } from '../src/watcher/read.ts';
import { tempDir } from './fixtures/tmp.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(REPO, 'bin', 'neptunia.ts');
const MECHANICS = ['heartbeat', 'selfreflection', 'selfimprovement', 'watcher'] as const;
const WAKES = ['heartbeat', 'selfreflection', 'selfimprovement'] as const;
const TIMER = 'neptunia-watcher.timer';
const WORKER = 'neptunia-watcher.service';

type Settings = Record<string, Record<string, unknown>>;
type Scope = 'user' | 'system';
type Run = { code: number | null; stdout: string; stderr: string; out: string };
type Rig = { root: string; data: string; xdg: string; bin: string; log: string; env: NodeJS.ProcessEnv };

/** The two spellings of one command: the same words, directly and as a line of the chat. */
const FORMS: ReadonlyArray<{ form: string; argv: (words: string) => Array<string> }> = [
  { form: 'neptunia service', argv: (words) => ['service', ...words.split(' ')] },
  { form: 'neptunia -p', argv: (words) => ['-p', `/service ${words}`] },
];
const direct = (words: string): Array<string> => ['service', ...words.split(' ')];

/**
 * A fake manager: it logs its argv under its own name, prints `FAKE_IS_ACTIVE` and `FAKE_IS_ENABLED` for those reads, and
 * fails a call holding the word in `FAKE_FAIL`. The fake `sudo` logs itself and runs what it was given.
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

const TIMER_TEXT = `[Unit]
Description=neptunia watcher

[Timer]
OnCalendar=*-*-* 00:00:00 UTC
Persistent=true
Unit=${WORKER}

[Install]
WantedBy=timers.target
`;

/** Fresh folders with the settings of `local`, the fake manager on an otherwise empty PATH, and the timer of `scope`. */
function rig(local: Settings | null = null, scope: Scope = 'user', env: NodeJS.ProcessEnv = {}): Rig {
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
    writeFileSync(join(xdg, 'systemd', 'user', TIMER), TIMER_TEXT);
  }
  return {
    root,
    data,
    xdg,
    bin,
    log,
    env: {
      TMPDIR: process.env.TMPDIR,
      PATH: bin,
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      NEPTUNIA_PRIVATE_DIR: data,
      NEPTUNIA_DATA_DIR: data,
      NEPTUNIA_UNIT_SCOPE: scope,
      FAKE_LOG: log,
      ...env,
    },
  };
}

/** One `neptunia` to its end, its input open; a run past `ms` is killed and fails the test. */
function run(where: Rig, argv: ReadonlyArray<string>, ms = 15_000, env: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...argv], {
      cwd: REPO,
      env: { ...where.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`neptunia ${argv.join(' ')} did not end within ${ms} ms: ${stderr.slice(-500)}`));
    }, ms);
    child.once('close', (code) => {
      clearTimeout(timer);
      child.stdin.destroy();
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

const managerCalls = (where: Rig): Array<string> =>
  existsSync(where.log) ? readFileSync(where.log, 'utf8').split('\n').filter(Boolean) : [];

/** The manager's calls that change something: every read of the state left out. */
const managerChanges = (where: Rig): Array<string> =>
  managerCalls(where).filter((line) => !/\b(is-active|is-enabled|show|status|list-timers)\b/.test(line));

const timerText = (where: Rig): string => readFileSync(join(where.xdg, 'systemd', 'user', TIMER), 'utf8');

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

for (const { form, argv } of FORMS) {
  test(`${form}: setup --at saves the daily times and answers the timezone and the next times`, async () => {
    // Catches: the answer leaves the owner to work out the UTC offset, or the times are saved under another key.
    const where = rig();
    const started = Date.now();
    const done = await run(where, argv('watcher setup --at 00:00,12:00'));
    assert.equal(done.code, 0, done.stderr.slice(0, 300));
    assert.equal(settingsOf(where).watcher?.schedule, 'at 00:00,12:00');
    assert.equal(field(done.stdout, 'timezone'), 'UTC');
    const next = momentsOf(field(done.stdout, 'next'));
    assert.ok(next.length >= 2, `several next times: ${next.length}`);
    for (const moment of next) {
      assert.ok(moment > started, 'a next time lies ahead');
      assert.ok(['00:00', '12:00'].includes(hhmm(moment)), hhmm(moment));
    }
  });
}

for (const name of MECHANICS) {
  test(`service ${name} setup --every saves one interval and answers times one interval apart`, async () => {
    // Catches: one of the four keeps its own key or answers a time that is no step of its schedule.
    const where = rig();
    const done = await run(where, direct(`${name} setup --every 6h`));
    assert.equal(done.code, 0, done.stderr.slice(0, 300));
    assert.equal(settingsOf(where)[name]?.schedule, 'every 6h');
    const [first, second] = momentsOf(field(done.stdout, 'next'));
    assert.equal((second ?? 0) - (first ?? 0), 6 * 3_600_000);
  });

  for (const enabled of [true, false]) {
    test(`service ${name} setup leaves a flag of ${enabled} as it was`, async () => {
      // Catches: `setup` turns the mechanic on, or writes off over a flag that was on.
      const where = rig({ [name]: { enabled } });
      assert.equal((await run(where, direct(`${name} setup --at 06:00`))).code, 0);
      assert.equal(settingsOf(where)[name]?.enabled, enabled);
    });
  }
}

test('setup stores minutes that make whole hours in the one spelling of the setting', async () => {
  // Catches: the same schedule reads two ways through /config, depending on how it was typed.
  const where = rig();
  assert.equal((await run(where, direct('selfreflection setup --every 360m'))).code, 0);
  assert.equal(settingsOf(where).selfreflection?.schedule, 'every 6h');
});

test('setup takes an interval in minutes', async () => {
  // Catches: only hours are accepted, so the 90m of the plan is refused.
  const where = rig();
  assert.equal((await run(where, direct('selfimprovement setup --every 90m'))).code, 0);
  assert.equal(settingsOf(where).selfimprovement?.schedule, 'every 90m');
});

test('setup replaces the mode that was there, leaving no second schedule', async () => {
  // Catches: the at and the every of two runs both stay in the file and the evaluation picks one of them.
  const where = rig({ watcher: { schedule: 'every 6h' } });
  assert.equal((await run(where, direct('watcher setup --at 03:00'))).code, 0);
  assert.equal(settingsOf(where).watcher?.schedule, 'at 03:00');
});

for (const [what, words, names] of [
  ['mixed modes', 'watcher setup --at 00:00 --every 6h', '--every'],
  ['a duplicate slot', 'watcher setup --at 00:00,00:00', '--at'],
  ['a malformed time', 'watcher setup --at 25:00', '--at'],
  ['a time missing its zero', 'heartbeat setup --at 7:00', '--at'],
  ['a trailing comma', 'heartbeat setup --at 00:00,', '--at'],
  ['a zero interval', 'selfreflection setup --every 0h', '--every'],
  ['a zero interval in minutes', 'selfimprovement setup --every 0m', '--every'],
  ['a negative interval', 'heartbeat setup --every -1h', '--every'],
  ['an interval with no unit', 'heartbeat setup --every 6', '--every'],
  ['--jitter on the watcher', 'watcher setup --every 6h --jitter 5m', '--jitter'],
  ['--jitter on selfreflection', 'selfreflection setup --every 6h --jitter 5m', '--jitter'],
  ['--jitter on selfimprovement', 'selfimprovement setup --every 6h --jitter 5m', '--jitter'],
  ['--jitter on daily times', 'heartbeat setup --at 06:00 --jitter 5m', '--jitter'],
  ['a negative jitter', 'heartbeat setup --every 3h --jitter -5m', '--jitter'],
  ['--at with no value', 'watcher setup --at', '--at'],
] as const) {
  for (const { form, argv } of FORMS) {
    test(`${form}: setup refuses ${what} with exit 2, names ${names} and writes nothing`, async () => {
      // Catches: a value the schedule cannot run is stored, and the service then never falls due, or the manager reloads.
      const local = { watcher: { enabled: true, schedule: 'at 01:00' }, heartbeat: { schedule: 'every 3h' } };
      const where = rig(local);
      const before = rawSettings(where);
      const timerBefore = timerText(where);
      const done = await run(where, argv(words));
      assert.equal(done.code, 2, done.out.slice(0, 300));
      assert.ok(done.stderr.includes(names), done.stderr.slice(0, 300));
      assert.equal(rawSettings(where), before);
      assert.equal(timerText(where), timerBefore);
      assert.deepEqual(managerChanges(where), []);
    });
  }
}

test('service heartbeat setup --jitter alone changes the jitter and keeps the interval', async () => {
  // Catches: the jitter cannot be changed without retyping the schedule, or its run resets the schedule.
  const where = rig({ heartbeat: { schedule: 'every 4h', jitterMinutes: 45 } });
  assert.equal((await run(where, direct('heartbeat setup --jitter 20m'))).code, 0);
  assert.deepEqual(settingsOf(where).heartbeat, { schedule: 'every 4h', jitterMinutes: 20 });
});

test('service heartbeat setup --jitter 0m turns the jitter off', async () => {
  // Catches: zero is read as a missing or invalid duration, so a fixed interval cannot be asked for.
  const where = rig({ heartbeat: { schedule: 'every 4h', jitterMinutes: 45 } });
  assert.equal((await run(where, direct('heartbeat setup --every 2h --jitter 0m'))).code, 0);
  assert.deepEqual(settingsOf(where).heartbeat, { schedule: 'every 2h', jitterMinutes: 0 });
});

test('service heartbeat setup --jitter is refused while the schedule is daily times', async () => {
  // Catches: a stored `at` schedule takes a jitter that nothing applies, and the answer claims it.
  const where = rig({ heartbeat: { schedule: 'at 06:00' } });
  const before = rawSettings(where);
  const done = await run(where, direct('heartbeat setup --jitter 20m'));
  assert.equal(done.code, 2, done.out.slice(0, 300));
  assert.ok(done.stderr.includes('--jitter'), done.stderr.slice(0, 300));
  assert.equal(rawSettings(where), before);
});

test('a jitter saved under the old keys survives a new interval, and the old interval key is gone', async () => {
  // Catches: the migration drops the owner's jitter, or `everyMinutes` stays beside `schedule` as a second truth.
  const where = rig({ heartbeat: { everyMinutes: 240, jitterMinutes: 45 } });
  const shown = await run(where, direct('heartbeat status'));
  assert.equal(shown.code, 0, shown.out.slice(0, 300));
  assert.equal(field(shown.stdout, 'schedule'), 'every 4h jitter 45m');
  assert.equal((await run(where, direct('heartbeat setup --every 2h'))).code, 0);
  assert.deepEqual(settingsOf(where).heartbeat, { schedule: 'every 2h', jitterMinutes: 45 });
  const again = await run(where, direct('heartbeat status'));
  assert.equal(field(again.stdout, 'schedule'), 'every 2h jitter 45m');
});

test('a watcher hour saved under the old key is shown as its schedule and replaced by a new one', async () => {
  // Catches: a deployment's `watcher.at` is forgotten on upgrade, or stays beside the new key.
  const where = rig({ watcher: { at: '06:30' } });
  assert.equal(field((await run(where, direct('watcher status'))).stdout, 'schedule'), 'at 06:30');
  assert.equal((await run(where, direct('watcher setup --at 07:00'))).code, 0);
  assert.deepEqual(settingsOf(where).watcher, { schedule: 'at 07:00' });
});

for (const { form, argv } of FORMS) {
  test(`${form}: setup with no option and no terminal names what is missing and ends at once`, async () => {
    // Catches: the dialog waits on a pipe nobody writes to, so a script hangs, or the run saves a default.
    const where = rig();
    const done = await run(where, argv('watcher setup'), 5000);
    assert.equal(done.code, 2, done.out.slice(0, 300));
    assert.equal(done.stdout, '');
    assert.ok(done.stderr.includes('--at'), done.stderr.slice(0, 300));
    assert.ok(done.stderr.includes('--every'), done.stderr.slice(0, 300));
    assert.equal(rawSettings(where), null);
  });
}

test('watcher setup renders the installed timer with every slot and reloads the manager, starting nothing', async () => {
  // Catches: the setting moves and the timer keeps its old hour, or the second daily time never reaches systemd.
  const where = rig({ watcher: { enabled: false } });
  const done = await run(where, direct('watcher setup --at 00:00,12:00'));
  assert.equal(done.code, 0, done.out.slice(0, 300));
  const text = timerText(where);
  assert.ok(text.includes('OnCalendar=*-*-* 00:00:00 UTC'), text);
  assert.ok(text.includes('OnCalendar=*-*-* 12:00:00 UTC'), text);
  assert.deepEqual(managerChanges(where), ['systemctl --user daemon-reload']);
});

test('watcher setup --every renders an interval timer in the same one file', async () => {
  // Catches: the interval gets a timer of its own beside the calendar one, a second scheduler of the same worker.
  const where = rig({ watcher: { enabled: true } });
  assert.equal((await run(where, direct('watcher setup --every 90m'))).code, 0);
  const text = timerText(where);
  assert.equal(text.includes('OnCalendar='), false, text);
  assert.ok(text.includes('OnUnitActiveSec=90min'), text);
  assert.deepEqual(readdirSync(join(where.xdg, 'systemd', 'user')), [TIMER]);
});

test('watcher setup whose reload fails reports desired against applied, keeps the setting and exits 1', async () => {
  // Catches: the command prints the new times as if they ran while systemd still holds the old ones.
  const where = rig({ watcher: { enabled: true } });
  const done = await run(where, direct('watcher setup --at 05:00'), 15_000, { FAKE_FAIL: 'daemon-reload' });
  assert.equal(done.code, 1, done.out.slice(0, 300));
  assert.equal(settingsOf(where).watcher?.schedule, 'at 05:00');
  assert.equal(field(done.out, 'desired'), 'at 05:00');
  assert.notEqual(field(done.out, 'applied'), 'at 05:00');
});

test('watcher setup in the system scope installs through sudo and reloads the system manager', async () => {
  // Catches: the render writes straight to /etc/systemd/system, or reloads the user's manager, which holds no such unit.
  const where = rig(null, 'system');
  assert.equal((await run(where, direct('watcher setup --at 05:00'))).code, 0);
  const calls = managerCalls(where);
  assert.ok(
    calls.some((line) => /^sudo install .*neptunia-watcher\.timer$/.test(line)),
    calls.join('\n')
  );
  assert.ok(calls.includes('sudo systemctl daemon-reload'), calls.join('\n'));
  assert.equal(calls.includes('systemctl --user daemon-reload'), false);
});

for (const name of WAKES) {
  test(`service ${name} setup calls no manager: her wakes run in the core`, async () => {
    // Catches: a persona wake gets a daemon or a timer of its own beside the core's scheduler.
    const where = rig();
    assert.equal((await run(where, direct(`${name} setup --at 06:00`))).code, 0);
    assert.deepEqual(managerCalls(where), []);
  });
}

// ---- enable and disable ---------------------------------------------------------------------------------------------

for (const name of WAKES) {
  for (const { form, argv } of FORMS) {
    test(`${form}: enable and disable of ${name} move its flag, with no manager and no core`, async () => {
      // Catches: the flag needs a core to be written, so a mechanic cannot be switched off while the core is down.
      const where = rig({ [name]: { enabled: false } });
      assert.equal((await run(where, argv(`${name} enable`))).code, 0);
      assert.equal(settingsOf(where)[name]?.enabled, true);
      assert.equal((await run(where, argv(`${name} disable`))).code, 0);
      assert.equal(settingsOf(where)[name]?.enabled, false);
      assert.deepEqual(managerCalls(where), []);
    });
  }
}

test('a second enable changes no byte of the settings file and succeeds', async () => {
  // Catches: the file is rewritten on every call, which wakes every reader of the hot settings for nothing.
  const where = rig({ heartbeat: { enabled: true, schedule: 'every 3h' } });
  const file = localConfigPath(where.data);
  const before = { text: readFileSync(file, 'utf8'), changed: statSync(file).mtimeMs };
  const done = await run(where, direct('heartbeat enable'));
  assert.equal(done.code, 0, done.out.slice(0, 300));
  assert.deepEqual({ text: readFileSync(file, 'utf8'), changed: statSync(file).mtimeMs }, before);
});

test('enable keeps the other settings of the file', async () => {
  // Catches: the flag is written over the section, and the owner's schedule and keys are lost.
  const where = rig({ heartbeat: { enabled: false, jitterMinutes: 45 }, bot: { timezone: 'UTC' } });
  assert.equal((await run(where, direct('heartbeat enable'))).code, 0);
  assert.deepEqual(settingsOf(where), { heartbeat: { enabled: true, jitterMinutes: 45 }, bot: { timezone: 'UTC' } });
});

test('selfimprovement enable saves the flag with no repository and no backend, and status says what is missing', async () => {
  // Catches: readiness refuses the flag, as the old setup step did, so the saved state cannot be set before the backend.
  const where = rig({ selfimprovement: { enabled: false } });
  assert.equal((await run(where, direct('selfimprovement enable'))).code, 0);
  assert.equal(settingsOf(where).selfimprovement?.enabled, true);
  const status = await run(where, direct('selfimprovement status'));
  assert.equal(field(status.stdout, 'enabled'), 'true');
  assert.match(field(status.stdout, 'readiness'), /^not ready/);
});

for (const [scope, enable, disable] of [
  [
    'user',
    'systemctl --user enable --now neptunia-watcher.timer',
    'systemctl --user disable --now neptunia-watcher.timer',
  ],
  [
    'system',
    'sudo systemctl enable --now neptunia-watcher.timer',
    'sudo systemctl disable --now neptunia-watcher.timer',
  ],
] as const) {
  test(`watcher enable in the ${scope} scope saves the flag and enables the timer only`, async () => {
    // Catches: the flag says on while no timer ever fires, or the worker starts at once on enable.
    const where = rig({ watcher: { enabled: false } }, scope);
    const done = await run(where, direct('watcher enable'));
    assert.equal(done.code, 0, done.out.slice(0, 300));
    assert.equal(settingsOf(where).watcher?.enabled, true);
    assert.deepEqual(
      managerChanges(where).filter((line) => !line.startsWith('systemctl enable')),
      [enable]
    );
    assert.equal(managerCalls(where).join('\n').includes(WORKER), false, 'the worker is not touched');
  });

  test(`watcher disable in the ${scope} scope stops the timer and leaves a running inspection alone`, async () => {
    // Catches: disable stops the worker, cutting an inspection off, where it should only prevent the next one.
    const where = rig({ watcher: { enabled: true } }, scope);
    const done = await run(where, direct('watcher disable'));
    assert.equal(done.code, 0, done.out.slice(0, 300));
    assert.equal(settingsOf(where).watcher?.enabled, false);
    assert.deepEqual(
      managerChanges(where).filter((line) => !line.startsWith('systemctl disable')),
      [disable]
    );
    assert.equal(managerCalls(where).join('\n').includes(WORKER), false, 'the worker is not touched');
  });

  test(`a failed watcher enable in the ${scope} scope reports desired against applied and exits 1`, async () => {
    // Catches: the flag says on and the command claims success while the timer never fires.
    const where = rig({ watcher: { enabled: false } }, scope);
    const done = await run(where, direct('watcher enable'), 15_000, { FAKE_FAIL: 'enable' });
    assert.equal(done.code, 1, done.out.slice(0, 300));
    assert.equal(settingsOf(where).watcher?.enabled, true, 'the wish is kept');
    assert.equal(field(done.out, 'desired'), 'enabled');
    assert.notEqual(field(done.out, 'applied'), 'enabled');
  });

  test(`a failed watcher disable in the ${scope} scope reports desired against applied and exits 1`, async () => {
    // Catches: the owner reads "disabled" while the timer goes on firing inspections.
    const where = rig({ watcher: { enabled: true } }, scope);
    const done = await run(where, direct('watcher disable'), 15_000, { FAKE_FAIL: 'disable' });
    assert.equal(done.code, 1, done.out.slice(0, 300));
    assert.equal(settingsOf(where).watcher?.enabled, false, 'the wish is kept');
    assert.equal(field(done.out, 'desired'), 'disabled');
    assert.notEqual(field(done.out, 'applied'), 'disabled');
  });
}

test('a second watcher enable after a failed one applies the timer and succeeds', async () => {
  // Catches: "already enabled" short-circuits on the saved flag, so a failed apply can never be repaired.
  const where = rig({ watcher: { enabled: false } });
  assert.equal((await run(where, direct('watcher enable'), 15_000, { FAKE_FAIL: 'enable' })).code, 1);
  const repaired = await run(where, direct('watcher enable'));
  assert.equal(repaired.code, 0, repaired.out.slice(0, 300));
  const enables = managerChanges(where).filter((line) => line.endsWith(`enable --now ${TIMER}`));
  assert.equal(enables.length, 2);
});

test('concurrent setups of the four keep every schedule', async () => {
  // Catches: each process reads and rewrites the whole settings file, so the last writer drops the others' schedules.
  const where = rig({ bot: { timezone: 'UTC' } });
  const runs = await Promise.all(MECHANICS.map((name) => run(where, direct(`${name} setup --at 06:00`))));
  assert.deepEqual(
    runs.map((one) => one.code),
    [0, 0, 0, 0]
  );
  const saved = settingsOf(where);
  for (const name of MECHANICS) assert.equal(saved[name]?.schedule, 'at 06:00', name);
  assert.deepEqual(saved.bot, { timezone: 'UTC' });
});

// ---- status ---------------------------------------------------------------------------------------------------------

/** Every file and folder under `dir`, to prove a read wrote none. */
const treeOf = (dir: string): Array<string> =>
  (readdirSync(dir, { recursive: true }) as Array<string>).map(String).sort();

for (const { form, argv } of FORMS) {
  test(`${form}: status with no core answers each field apart and exits 0`, async () => {
    // Catches: the core being down reads as disabled, or status fails where the saved state could be read from disk.
    const where = rig({ heartbeat: { enabled: true, schedule: 'at 06:00,18:00' } });
    const started = Date.now();
    const done = await run(where, argv('heartbeat status'));
    assert.equal(done.code, 0, done.out.slice(0, 300));
    assert.equal(field(done.stdout, 'service'), 'heartbeat');
    assert.equal(field(done.stdout, 'enabled'), 'true');
    assert.equal(field(done.stdout, 'running'), 'unknown');
    assert.match(field(done.stdout, 'readiness'), /^not ready.*core/);
    assert.equal(field(done.stdout, 'schedule'), 'at 06:00,18:00');
    const next = Date.parse(field(done.stdout, 'next due'));
    assert.ok(next > started && ['06:00', '18:00'].includes(hhmm(next)), field(done.stdout, 'next due'));
    assert.notEqual(field(done.stdout, 'last result'), '');
  });
}

test('status of a disabled service has no next time, and the same schedule', async () => {
  // Catches: a disabled service promises a next run, so the owner cannot tell the flag from the schedule.
  const where = rig({ watcher: { enabled: false, schedule: 'at 06:00' } });
  const done = await run(where, direct('watcher status'));
  assert.equal(field(done.stdout, 'enabled'), 'false');
  assert.equal(field(done.stdout, 'schedule'), 'at 06:00');
  assert.equal(field(done.stdout, 'next due'), 'none');
});

test('status writes nothing and starts no process that changes the manager', async () => {
  // Catches: reading the status creates the data folders or the database, so a read changes a stopped deployment.
  const where = rig({ watcher: { enabled: true, schedule: 'every 6h' } });
  const before = treeOf(where.root).filter((one) => !one.endsWith('manager.log'));
  const raw = rawSettings(where);
  assert.equal((await run(where, direct('watcher status'))).code, 0);
  assert.deepEqual(
    treeOf(where.root).filter((one) => !one.endsWith('manager.log')),
    before
  );
  assert.equal(rawSettings(where), raw);
  assert.deepEqual(managerChanges(where), []);
});

test('watcher status shows a run still going after disable: not enabled, and running', async () => {
  // Catches: the flag is reported as the running state, so an inspection finishing after disable is invisible.
  // A oneshot unit is `activating` for the whole of its run.
  const where = rig({ watcher: { enabled: false, schedule: 'at 06:00' } });
  const done = await run(where, direct('watcher status'), 15_000, { FAKE_IS_ACTIVE: 'activating' });
  assert.equal(field(done.stdout, 'enabled'), 'false');
  assert.equal(field(done.stdout, 'running'), 'true');
});

test('watcher status with no manager to ask says unknown for what only the manager knows', async () => {
  // Catches: a machine without systemctl makes status fail, or reads as not running.
  const where = rig({ watcher: { enabled: true, schedule: 'at 06:00' } });
  const empty = join(where.root, 'empty');
  mkdirSync(empty);
  const done = await run(where, direct('watcher status'), 15_000, { PATH: empty });
  assert.equal(done.code, 0, done.out.slice(0, 300));
  assert.equal(field(done.stdout, 'enabled'), 'true');
  assert.equal(field(done.stdout, 'running'), 'unknown');
  assert.equal(field(done.stdout, 'timer'), 'unknown');
});

test('watcher status after a failed enable shows the wish and the timer apart', async () => {
  // Catches: the desired-against-applied report lives only in the failed run, and every later read says all is well.
  const where = rig({ watcher: { enabled: true, schedule: 'at 06:00' } });
  const done = await run(where, direct('watcher status'), 15_000, { FAKE_IS_ENABLED: 'disabled' });
  assert.equal(field(done.stdout, 'enabled'), 'true');
  assert.equal(field(done.stdout, 'timer'), 'disabled');
});

test('watcher status names a missing backend under readiness, apart from the saved flag', async () => {
  // Catches: a missing subharness reads as "disabled", or as a schedule that will run.
  const where = rig({ watcher: { enabled: true, schedule: 'at 06:00' } });
  const done = await run(where, direct('watcher status'));
  assert.equal(field(done.stdout, 'enabled'), 'true');
  assert.match(field(done.stdout, 'readiness'), /^not ready.*subharness/);
});

test('watcher status names the newest saved report as its last result, with no core', async () => {
  // Catches: the last result is asked of the core, so it is missing exactly when the owner investigates a stopped one.
  const where = rig({ watcher: { enabled: true, schedule: 'at 06:00' } });
  const reports = reportsDirOf(where.data, watcherDir({}));
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, '2026-11-02.md'), '# older\n');
  writeFileSync(join(reports, '2026-11-03.md'), '# newer\n');
  const done = await run(where, direct('watcher status'));
  assert.ok(field(done.stdout, 'last result').includes('2026-11-03'), done.stdout);
});

// ---- the verbs of the system units -----------------------------------------------------------------------------------

for (const name of MECHANICS) {
  test(`service status ${name} is refused and names service ${name} status, with no manager called`, async () => {
    // Catches: the mechanic's name reaches systemctl as a unit, so a wrong word order reports "unit not found".
    const where = rig();
    const done = await run(where, ['service', 'status', name]);
    assert.equal(done.code, 2, done.out.slice(0, 300));
    assert.ok(done.stderr.includes(`service ${name} status`), done.stderr.slice(0, 300));
    assert.deepEqual(managerCalls(where), []);
  });
}

for (const verb of ['start', 'stop', 'restart']) {
  test(`service watcher ${verb} is refused and touches no unit`, async () => {
    // Catches: the two orders of the words are read as one family, so a mechanic is started through systemctl.
    const where = rig();
    const done = await run(where, ['service', 'watcher', verb]);
    assert.equal(done.code, 2, done.out.slice(0, 300));
    assert.ok(done.stderr.includes('enable'), `it names the actions: ${done.stderr.slice(0, 300)}`);
    assert.deepEqual(managerCalls(where), []);
  });
}

test('service restart in a user install goes to the user manager', async () => {
  // Catches: the unit verbs ignore the scope, so a user install's restart asks the system manager for units it lacks.
  const where = rig();
  assert.equal((await run(where, ['service', 'restart', 'neptunia-core.service'])).code, 0);
  assert.deepEqual(managerCalls(where), ['systemctl --user restart neptunia-core.service']);
});

// ---- the operations of one run --------------------------------------------------------------------------------------

for (const { form, argv } of FORMS) {
  test(`${form}: trigger refuses a disabled watcher, names enable, and enables nothing`, async () => {
    // Catches: trigger quietly enables the watcher to run it, or starts the worker of a service the owner switched off.
    const where = rig({ watcher: { enabled: false, schedule: 'at 06:00' } });
    const before = rawSettings(where);
    const done = await run(where, argv('watcher trigger'));
    assert.equal(done.code, 1, done.out.slice(0, 300));
    assert.ok(done.stderr.includes('service watcher enable'), done.stderr.slice(0, 300));
    assert.equal(rawSettings(where), before);
    assert.deepEqual(managerChanges(where), []);
  });
}

for (const words of ['watcher cancel', 'watcher report', 'watcher report 2026-11-03', 'watcher report run-71']) {
  test(`service ${words} is recognized by the shell`, async () => {
    // Catches: the table holds the operation while the direct form answers usage.
    const where = rig({ watcher: { enabled: true } });
    const done = await run(where, direct(words));
    assert.notEqual(done.code, 2, done.out.slice(0, 300));
    assert.equal(done.stderr.startsWith('neptunia: usage:'), false, done.stderr.slice(0, 300));
  });
}

// ---- the competing controls -----------------------------------------------------------------------------------------

for (const [argv, names] of [
  [['watcher', 'run'], 'service watcher'],
  [['watcher'], 'service watcher'],
  [['selfimprovement', 'run'], 'service selfimprovement'],
  [['selfimprovement'], 'service selfimprovement'],
  [['setup', 'watcher'], 'service watcher setup'],
  [['setup', 'selfimprovement'], 'service selfimprovement setup'],
  [['setup', 'mechanics'], 'neptunia service'],
  [['-p', '/report'], 'service watcher report'],
  [['-p', '/report 2026-11-03'], 'service watcher report'],
] as const) {
  test(`neptunia ${argv.join(' ')} exits 2, names ${names} and runs nothing`, async () => {
    // Catches: the old form still runs an inspection or a beat, or stops at a usage text with no way forward.
    const where = rig({ watcher: { enabled: true } });
    const reports = reportsDirOf(where.data, watcherDir({}));
    mkdirSync(reports, { recursive: true });
    writeFileSync(join(reports, '2026-11-03.md'), 'zeta-report-text\n');
    const before = treeOf(where.root).filter((one) => !one.endsWith('manager.log'));
    const raw = rawSettings(where);
    const done = await run(where, argv);
    assert.equal(done.code, 2, done.out.slice(0, 300));
    assert.ok(done.stderr.includes(names), done.stderr.slice(0, 300));
    assert.equal(done.out.includes('zeta-report-text'), false, 'no report is read');
    assert.equal(rawSettings(where), raw);
    assert.deepEqual(
      treeOf(where.root).filter((one) => !one.endsWith('manager.log')),
      before
    );
    assert.deepEqual(managerCalls(where), []);
  });
}

test('the usage shows the family and none of the retired forms', async () => {
  // Catches: help keeps teaching the forms that now only explain themselves.
  const where = rig();
  const done = await run(where, ['no-such-word-71']);
  assert.equal(done.code, 2, done.out.slice(0, 300));
  assert.ok(done.stderr.includes('service <name>'), done.stderr.slice(0, 600));
  for (const gone of ['watcher run', 'selfimprovement run', 'mechanics', '/report'])
    assert.equal(done.stderr.includes(gone), false, gone);
});

test('the worker the watcher unit starts is named in no help, and it is a word the command knows', async () => {
  // Catches: ExecStart names a command that was retired or never added, so the timer fires a usage error every day.
  const unit = readFileSync(join(REPO, 'deploy', WORKER), 'utf8');
  const exec = /^ExecStart=\S+ bin\/neptunia\.ts (.+)$/m.exec(unit)?.[1] ?? assert.fail('it starts bin/neptunia.ts');
  const words = exec.split(' ');
  const where = rig();
  const usage = await run(where, ['no-such-word-71']);
  assert.equal(usage.stderr.includes(words[0] ?? ''), false, `${words[0] ?? ''} is shown in the usage`);
  // No board and no backend here, so the worker ends by itself with its own failure, never with usage.
  const worker = await run(where, words, 20_000);
  assert.notEqual(worker.code, 2, worker.out.slice(0, 300));
  assert.equal(worker.stderr.startsWith('neptunia: usage:'), false, worker.stderr.slice(0, 300));
});
