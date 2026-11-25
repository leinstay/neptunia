// Tests for src/service/commands.ts: `/services list` over the two mechanisms, through the core's console and through
// `serviceFamily` with no core. The manager is a fake that records its calls, `fetch` refuses every call, and a read
// must leave every byte of the private folder as it was.
import { test, after, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, chmodSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../../../src/config.ts';
import { localConfigPath } from '../../../src/config/files.ts';
import { createConsole } from '../../../src/interface/commands/console.ts';
import type { ConsoleDeps } from '../../../src/interface/commands/console.ts';
import { parseCommandLine } from '../../../src/interface/commands/table.ts';
import type { Parsed } from '../../../src/interface/commands/table.ts';
import { openMemoryDb } from '../../../src/memory/db/open.ts';
import { serviceFamily, wakeClockOf } from '../../../src/service/commands.ts';
import type { WakeClock } from '../../../src/service/commands.ts';
import type { RunManager } from '../../../src/service/manager.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { parseRequest } from '../../../bin/neptunia-request.ts';
import { createInnerLife } from '../../../src/behavior/inner.ts';
import { createDiary } from '../../../src/behavior/diary.ts';
import { createEventDoor } from '../../../src/interface/door.ts';
import { createIntentionService } from '../../../src/intentions/service.ts';
import { createIntentionStores } from '../../../src/intentions/store.ts';
import type { ServiceName } from '../../../src/service/schedule.ts';
import { openTestMemorySync } from '../../fixtures/memory-db/service.ts';
import { useIface, world } from '../../fixtures/turn-world.ts';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));

const NOW = Date.parse('2026-11-04T12:00:00Z');

const MECHANICS = ['heartbeat', 'diary'] as const;

type Answer = { text: string; status: string };

/** The parse of a line, which must have stood. */
function assertParsed(line: string): Extract<Parsed, { ok: true }> {
  const parsed = parseCommandLine(line);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
  return parsed;
}

/** Every file of `dir` with the hash of its bytes: two equal digests mean a read changed nothing. */
function digest(dir: string): string {
  const rows: Array<string> = [];
  const walk = (folder: string): void => {
    const entries = readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(folder, entry.name);
      const name = relative(dir, path);
      if (entry.isDirectory()) {
        rows.push(`d ${name}`);
        walk(path);
      } else {
        rows.push(`f ${name} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
      }
    }
  };
  walk(dir);
  return rows.join('\n');
}

/** A manager that records its calls and answers the reads the way an idle install does. */
function fakeManager(calls: Array<string>): RunManager {
  return (command, args) => {
    calls.push([command, ...args].join(' '));
    if (args.includes('is-active')) return Promise.resolve({ code: 0, stdout: 'inactive\n', stderr: '' });
    if (args.includes('is-enabled')) return Promise.resolve({ code: 0, stdout: 'disabled\n', stderr: '' });
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
}

/** The manager calls that change something: every read of the state left out. */
const changesOf = (calls: ReadonlyArray<string>): Array<string> =>
  calls.filter((line) => !/\b(is-active|is-enabled|show|status|list-timers)\b/.test(line));

type Rig = {
  dir: string;
  calls: Array<string>;
  ops: Array<string>;
  fetched: Array<string>;
  /** One line through the table and the core's console, as the owner's chat does. */
  say(line: string): Promise<Answer>;
  /** One line through the table and the handler of the family with no core. */
  sayOffline(line: string): Promise<Answer>;
  /** One command by the name the console answers, as a client that sends it raw would. */
  raw(name: string, args?: Record<string, unknown>): Promise<Answer>;
};

/** A console over a temporary private layer holding `local`, and an open memory database unless `memory` is false. */
function rig(local: Record<string, unknown> | null = null, memory = true): Rig {
  const dir = tempDir('nep-naming-');
  mkdirSync(join(dir, 'config'), { recursive: true });
  if (local !== null) writeFileSync(localConfigPath(dir), JSON.stringify(local));
  const calls: Array<string> = [];
  const ops: Array<string> = [];
  const fetched: Array<string> = [];
  const handle = memory ? openMemoryDb(':memory:') : null;
  const deps: ConsoleDeps = {
    runOp: (op) => {
      ops.push(op);
      return Promise.resolve({ status: 'ok', code: '', summary: 'done', data: null });
    },
    ownerReads: { lessons: () => '' },
    places: () => ['g1'],
    selfId: () => 'self-1',
    hot: {
      get config(): unknown {
        return readConfig(REPO, { privateDir: dir });
      },
    },
    privateDir: dir,
    dataDir: dir,
    memoryDb: { database: () => handle?.db ?? null },
    usage: null,
    metrics: { samples: () => [] },
    chatLines: () => [],
    now: () => NOW,
    serviceManager: fakeManager(calls),
  };
  const desk = createConsole(deps);
  const guarded = async (body: () => Promise<Answer>): Promise<Answer> => {
    const real = globalThis.fetch;
    globalThis.fetch = (input: string | URL | Request): Promise<Response> => {
      fetched.push(input instanceof Request ? input.url : String(input));
      return Promise.reject(new Error('no network in tests'));
    };
    try {
      return await body();
    } finally {
      globalThis.fetch = real;
    }
  };
  return {
    dir,
    calls,
    ops,
    fetched,
    say: (line) =>
      guarded(() => {
        const parsed = assertParsed(line);
        return desk.run(parsed.name, parsed.args, { id: 'owner-1' });
      }),
    sayOffline: (line) =>
      guarded(() => {
        const parsed = assertParsed(line);
        return serviceFamily(
          {
            rootDir: REPO,
            privateDir: dir,
            dataDir: dir,
            config: () => readConfig(REPO, { privateDir: dir }),
            now: () => NOW,
            env: { NEPTUNIA_UNIT_SCOPE: 'user', HOME: dir, XDG_CONFIG_HOME: join(dir, 'xdg') },
            run: fakeManager(calls),
            coreUp: false,
          },
          parsed.name,
          parsed.args
        );
      }),
    raw: (name, args = {}) => guarded(() => desk.run(name, args, { id: 'owner-1' })),
  };
}

/** Schedules that differ per mechanism, so a row of one status cannot be mistaken for another's. */
const LOCAL = {
  heartbeat: { enabled: false, schedule: 'every 2h' },
  diary: { enabled: true, schedule: 'at 09:15' },
};

// ---- /services list --------------------------------------------------------------------------------------------------

for (const [how, pick] of [
  ['in the core', (r: Rig) => r.say.bind(r)],
  ['with no core', (r: Rig) => r.sayOffline.bind(r)],
] as const) {
  test(`/services list ${how} shows the two mechanisms with every row their own status shows, and writes nothing`, async () => {
    // Catches: the list keeps a copy of its own, drops a mechanism, adds a process unit, or writes while it reads.
    const r = rig(LOCAL);
    const say = pick(r);
    const before = digest(r.dir);
    const list = await say('/services list');
    assert.equal(list.status, 'ok', list.text);
    for (const name of MECHANICS) {
      assert.ok(list.text.includes(name), name);
      const shown = await say(`/services ${name} status`);
      assert.equal(shown.status, 'ok', shown.text);
      const rows = shown.text.split('\n').filter((row) => row !== '' && !row.startsWith('service:'));
      assert.ok(rows.length > 0, 'a status has rows');
      for (const row of rows) assert.ok(list.text.includes(row), `${name}: ${row}`);
    }
    for (const unit of ['neptunia-core', 'agent-scout', 'agent-server', 'neptunia-interface'])
      assert.equal(list.text.includes(unit), false, unit);
    assert.equal(digest(r.dir), before, 'a read writes no setting');
    assert.deepEqual(changesOf(r.calls), [], 'a read moves no timer');
    assert.deepEqual(r.fetched, [], 'a read asks no provider');
  });
}

test('/services list asks no model: the only operation the console may run is the wakes read', async () => {
  // Catches: the list measures readiness with a live probe, so reading it spends a request.
  const r = rig(LOCAL);
  const list = await r.say('/services list');
  assert.equal(list.status, 'ok', list.text);
  assert.deepEqual(
    r.ops.filter((op) => op !== 'inner.status'),
    []
  );
});

test('/services list shows a mechanism as disabled after /services disable, from the same flag /config reads', async () => {
  // Catches: the list reads a flag of its own, so it disagrees with the setting a status and the settings panel show.
  const r = rig({ diary: { enabled: true, schedule: 'at 09:15' } });
  const before = await r.say('/services list');
  assert.equal((await r.say('/services diary disable')).status, 'ok');
  const after = await r.say('/services list');
  assert.notEqual(after.text, before.text);
  const status = await r.say('/services diary status');
  for (const row of status.text.split('\n').filter((one) => one !== '' && !one.startsWith('service:')))
    assert.ok(after.text.includes(row), row);
});

// The `/services` family in the command table (src/interface/commands/table.ts), in the panels (bin/chat-panels.ts) and in
// the core's console (src/interface/commands/console.ts): the one public control of the two scheduled mechanics, what
// the parse refuses before anything runs, the controls it replaces, and that a /config read sees what `setup` saved.
// The tests assert on parsed names, arguments, files and the commands a refusal names, never on wording.

const COMMANDS_SERVICE_REPO = fileURLToPath(new URL('../../..', import.meta.url));

/** A console over a temporary private layer whose `/config` reads the files as the core's hot settings do. */
function consoleOver(ran: Array<string> = []): { dir: string; run: (line: string) => ReturnType<typeof runIn> } {
  const dir = tempDir('nep-service-console-');
  mkdirSync(join(dir, 'config'), { recursive: true });
  const deps: ConsoleDeps = {
    runOp: (op) => {
      ran.push(op);
      return Promise.resolve({ status: 'ok', code: '', summary: 'done', data: null });
    },
    ownerReads: { lessons: () => '' },
    places: () => ['g1'],
    selfId: () => 'self-1',
    hot: {
      get config(): unknown {
        return readConfig(COMMANDS_SERVICE_REPO, { privateDir: dir });
      },
    },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => Date.parse('2026-11-04T12:00:00Z'),
  };
  const desk = createConsole(deps);
  return { dir, run: (line) => runIn(desk, line) };
}

async function runIn(desk: ReturnType<typeof createConsole>, line: string) {
  const parsed = parseCommandLine(line);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
  return desk.run(parsed.name, parsed.args, { id: 'owner-1' });
}

test('what setup saves in the chat is what a /config read answers', async () => {
  // Catches: the family keeps a store of its own, so `/config` and `/services` show two different schedules.
  const { run } = consoleOver();
  const saved = await run('/services heartbeat setup --every 2h');
  assert.equal(saved.status, 'ok', saved.text);
  const read = await run('/config get heartbeat.schedule');
  assert.equal(read.status, 'ok', read.text);
  assert.equal(JSON.parse(read.text), 'every 2h');
});

// Changed: the mechanic is diary, since selfimprovement is no service.
test('a schedule in the settings file, where /config set writes it, is what the family shows', async () => {
  // Catches: the family reads a copy of its own, so a change through the settings panel does not reach it.
  const { dir, run } = consoleOver();
  writeFileSync(localConfigPath(dir), JSON.stringify({ diary: { schedule: 'at 05:00' } }));
  const status = await run('/services diary status');
  const { status: statusValue } = status;
  assert.equal(statusValue, 'ok', status.text);
  assert.match(status.text, /^schedule: at 05:00$/m);
});

test('enable and disable in the chat move the same flag a /config read answers', async () => {
  // Catches: the chat path writes through another handler than the shell, and the flag lands under another key.
  const { run } = consoleOver();
  assert.equal((await run('/services diary disable')).status, 'ok');
  assert.equal(JSON.parse((await run('/config get diary.enabled')).text), false);
  assert.equal((await run('/services diary enable')).status, 'ok');
  assert.equal(JSON.parse((await run('/config get diary.enabled')).text), true);
});

test('setup in the chat writes the local settings file and leaves the flag as it was', async () => {
  // Catches: `setup` also switches the mechanic on, so configuring a time starts wakes the owner did not ask for.
  const { dir, run } = consoleOver();
  writeFileSync(localConfigPath(dir), JSON.stringify({ heartbeat: { enabled: false } }));
  assert.equal((await run('/services heartbeat setup --at 06:00,18:00')).status, 'ok');
  const local: unknown = JSON.parse(readFileSync(localConfigPath(dir), 'utf8'));
  assert.deepEqual(local, { heartbeat: { enabled: false, schedule: 'at 06:00,18:00' } });
});

test('status in the chat runs no operation that reaches a model', async () => {
  // Catches: readiness is measured with a live probe, so reading the status spends a paid request.
  const ran: Array<string> = [];
  const { run } = consoleOver(ran);
  const status = await run('/services heartbeat status');
  const { status: statusValue } = status;
  assert.equal(statusValue, 'ok', status.text);
  assert.match(status.text, /^enabled: (true|false)$/m);
  assert.deepEqual(
    ran.filter((op) => op !== 'inner.status'),
    []
  );
});

test('a failed setup in the chat writes nothing', async () => {
  // Catches: the handler trusts the table and a value that reached it by another route lands in the file.
  const { dir } = consoleOver();
  const desk = createConsole({
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: 'done', data: null }),
    ownerReads: { lessons: () => '' },
    places: () => ['g1'],
    selfId: () => 'self-1',
    hot: { config: {} },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => 0,
  });
  const answer = await desk.run('services.heartbeat.setup', { at: '25:00' }, { id: 'owner-1' });
  assert.equal(answer.status, 'invalid', answer.text);
  assert.equal(answer.text.includes('no such command'), false, answer.text);
  assert.equal(existsSync(localConfigPath(dir)), false);
});

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

const NEPTUNIA_SERVICE_REPO = fileURLToPath(new URL('../../..', import.meta.url));
const NEPTUNIA_SERVICE_MECHANICS = ['heartbeat', 'diary'] as const;
const WAKES = ['heartbeat', 'diary'] as const;
const CORE = 'neptunia-core.service';
/** The clock of the runs in this process, between the two slots most tests name. */
const NEPTUNIA_SERVICE_NOW = Date.parse('2026-11-04T10:00:00Z');

type Settings = Record<string, Record<string, unknown>>;
type Scope = 'user' | 'system';
type Run = { code: number | null; stdout: string; stderr: string; out: string };
type NeptuniaServiceRig = {
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
function neptuniaServiceRig(local: Settings | null = null, scope: Scope = 'user'): NeptuniaServiceRig {
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
  where: NeptuniaServiceRig,
  words: string,
  answers: ManagerAnswers = {},
  parse: (words: string) => Parsed = direct
): Promise<Run> {
  const parsed = parse(words);
  if (!parsed.ok) return { code: 2, stdout: '', stderr: parsed.reason, out: parsed.reason };
  const answer = await serviceFamily(
    {
      rootDir: NEPTUNIA_SERVICE_REPO,
      privateDir: where.data,
      dataDir: where.data,
      config: () => readConfig(NEPTUNIA_SERVICE_REPO, { privateDir: where.data }),
      now: () => NEPTUNIA_SERVICE_NOW,
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

const settingsOf = (where: NeptuniaServiceRig): Settings => {
  const file = localConfigPath(where.data);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Settings) : {};
};

/** The bytes of the local settings file, or null with no file. */
const rawSettings = (where: NeptuniaServiceRig): string | null => {
  const file = localConfigPath(where.data);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
};

/** The manager's calls that change something: every read of the state left out. */
const neptuniaServiceChangesOf = (calls: ReadonlyArray<string>): Array<string> =>
  calls.filter((line) => !/\b(is-active|is-enabled|show|status|list-timers)\b/.test(line));

const managerChanges = (where: NeptuniaServiceRig): Array<string> => neptuniaServiceChangesOf(where.calls);

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
    const where = neptuniaServiceRig();
    const done = await run(where, 'heartbeat setup --at 00:00,12:00', {}, parse);
    assert.equal(done.code, 0, done.stderr.slice(0, 300));
    assert.equal(settingsOf(where).heartbeat?.schedule, 'at 00:00,12:00');
    assert.equal(field(done.stdout, 'timezone'), 'UTC');
    const next = momentsOf(field(done.stdout, 'next'));
    assert.ok(next.length >= 2, `several next times: ${next.length}`);
    assert.equal(next[0], Date.parse('2026-11-04T12:00:00Z'));
    for (const moment of next) {
      assert.ok(moment > NEPTUNIA_SERVICE_NOW, 'a next time lies ahead');
      assert.ok(['00:00', '12:00'].includes(hhmm(moment)), hhmm(moment));
    }
  });
}

for (const name of NEPTUNIA_SERVICE_MECHANICS) {
  test(`services ${name} setup --every saves one interval and answers times one interval apart`, async () => {
    // Catches: one of the two keeps its own key or answers a time that is no step of its schedule.
    const where = neptuniaServiceRig();
    const done = await run(where, `${name} setup --every 6h`);
    assert.equal(done.code, 0, done.stderr.slice(0, 300));
    assert.equal(settingsOf(where)[name]?.schedule, 'every 6h');
    const [first, second] = momentsOf(field(done.stdout, 'next'));
    assert.equal((second ?? 0) - (first ?? 0), 6 * 3_600_000);
  });

  for (const enabled of [true, false]) {
    test(`services ${name} setup leaves a flag of ${enabled} as it was`, async () => {
      // Catches: `setup` turns the mechanic on, or writes off over a flag that was on.
      const where = neptuniaServiceRig({ [name]: { enabled } });
      assert.equal((await run(where, `${name} setup --at 06:00`)).code, 0);
      assert.equal(settingsOf(where)[name]?.enabled, enabled);
    });
  }
}

test('setup stores minutes that make whole hours in the one spelling of the setting', async () => {
  // Catches: the same schedule reads two ways through /config, depending on how it was typed.
  const where = neptuniaServiceRig();
  assert.equal((await run(where, 'diary setup --every 360m')).code, 0);
  assert.equal(settingsOf(where).diary?.schedule, 'every 6h');
});

// Changed: the mechanic is diary, since selfimprovement is no service.
test('setup takes an interval in minutes', async () => {
  // Catches: only hours are accepted, so the 90m of the plan is refused.
  const where = neptuniaServiceRig();
  assert.equal((await run(where, 'diary setup --every 90m')).code, 0);
  assert.equal(settingsOf(where).diary?.schedule, 'every 90m');
});

test('setup replaces the mode that was there, leaving no second schedule', async () => {
  // Catches: the at and the every of two runs both stay in the file and the evaluation picks one of them.
  const where = neptuniaServiceRig({ heartbeat: { schedule: 'every 6h' } });
  assert.equal((await run(where, 'heartbeat setup --at 03:00')).code, 0);
  assert.equal(settingsOf(where).heartbeat?.schedule, 'at 03:00');
});

// Changed: the lines that named selfimprovement name diary, since selfimprovement is no service.
for (const [what, words, names] of [
  ['mixed modes', 'heartbeat setup --at 00:00 --every 6h', '--every'],
  ['a duplicate slot', 'heartbeat setup --at 00:00,00:00', '--at'],
  ['a malformed time', 'diary setup --at 25:00', '--at'],
  ['a time missing its zero', 'heartbeat setup --at 7:00', '--at'],
  ['a trailing comma', 'heartbeat setup --at 00:00,', '--at'],
  ['a zero interval', 'diary setup --every 0h', '--every'],
  ['a zero interval in minutes', 'diary setup --every 0m', '--every'],
  ['a negative interval', 'heartbeat setup --every -1h', '--every'],
  ['an interval with no unit', 'heartbeat setup --every 6', '--every'],
  ['--jitter on diary', 'diary setup --every 6h --jitter 5m', '--jitter'],
  ['--jitter on daily times', 'heartbeat setup --at 06:00 --jitter 5m', '--jitter'],
  ['a negative jitter', 'heartbeat setup --every 3h --jitter -5m', '--jitter'],
  ['--at with no value', 'diary setup --at', '--at'],
] as const) {
  for (const { form, parse } of FORMS) {
    test(`${form}: setup refuses ${what} with exit 2, names ${names} and writes nothing`, async () => {
      // Catches: a value the schedule cannot run is stored, and the service then never falls due, or the manager reloads.
      const local = { diary: { enabled: true, schedule: 'at 01:00' }, heartbeat: { schedule: 'every 3h' } };
      const where = neptuniaServiceRig(local);
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
  const where = neptuniaServiceRig({ heartbeat: { schedule: 'every 4h', jitterMinutes: 45 } });
  assert.equal((await run(where, 'heartbeat setup --jitter 20m')).code, 0);
  assert.deepEqual(settingsOf(where).heartbeat, { schedule: 'every 4h', jitterMinutes: 20 });
});

test('services heartbeat setup --jitter 0m turns the jitter off', async () => {
  // Catches: zero is read as a missing or invalid duration, so a fixed interval cannot be asked for.
  const where = neptuniaServiceRig({ heartbeat: { schedule: 'every 4h', jitterMinutes: 45 } });
  assert.equal((await run(where, 'heartbeat setup --every 2h --jitter 0m')).code, 0);
  assert.deepEqual(settingsOf(where).heartbeat, { schedule: 'every 2h', jitterMinutes: 0 });
});

test('services heartbeat setup --jitter is refused while the schedule is daily times', async () => {
  // Catches: a stored `at` schedule takes a jitter that nothing applies, and the answer claims it.
  const where = neptuniaServiceRig({ heartbeat: { schedule: 'at 06:00' } });
  const before = rawSettings(where);
  const done = await run(where, 'heartbeat setup --jitter 20m');
  assert.equal(done.code, 2, done.out.slice(0, 300));
  assert.ok(done.stderr.includes('--jitter'), done.stderr.slice(0, 300));
  assert.equal(rawSettings(where), before);
});

for (const { form, parse } of FORMS) {
  test(`${form}: setup with no option names what is missing and saves nothing`, async () => {
    // Catches: the run saves a default where the owner gave none, or the answer leaves the owner without the flags.
    const where = neptuniaServiceRig();
    const done = await run(where, 'heartbeat setup', {}, parse);
    assert.equal(done.code, 2, done.out.slice(0, 300));
    assert.equal(done.stdout, '');
    assert.ok(done.stderr.includes('--at'), done.stderr.slice(0, 300));
    assert.ok(done.stderr.includes('--every'), done.stderr.slice(0, 300));
    assert.equal(rawSettings(where), null);
  });
}

for (const name of WAKES) {
  test(`services ${name} setup calls no manager: the persona's wakes run in the core`, async () => {
    // Catches: a persona wake gets a daemon or a timer of its own beside the core's scheduler.
    const where = neptuniaServiceRig();
    assert.equal((await run(where, `${name} setup --at 06:00`)).code, 0);
    assert.deepEqual(where.calls, []);
  });
}

// ---- enable and disable ---------------------------------------------------------------------------------------------

for (const name of WAKES) {
  for (const { form, parse } of FORMS) {
    test(`${form}: enable and disable of ${name} move its flag, with no manager and no core`, async () => {
      // Catches: the flag needs a core to be written, so a mechanic cannot be switched off while the core is down.
      const where = neptuniaServiceRig({ [name]: { enabled: false } });
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
  const where = neptuniaServiceRig({ heartbeat: { enabled: true, schedule: 'every 3h' } });
  const file = localConfigPath(where.data);
  const before = { text: readFileSync(file, 'utf8'), changed: statSync(file).mtimeMs };
  const done = await run(where, 'heartbeat enable');
  assert.equal(done.code, 0, done.out.slice(0, 300));
  assert.deepEqual({ text: readFileSync(file, 'utf8'), changed: statSync(file).mtimeMs }, before);
});

test('enable keeps the other settings of the file', async () => {
  // Catches: the flag is written over the section, and the owner's schedule and keys are lost.
  const where = neptuniaServiceRig({ heartbeat: { enabled: false, jitterMinutes: 45 }, bot: { timezone: 'UTC' } });
  assert.equal((await run(where, 'heartbeat enable')).code, 0);
  assert.deepEqual(settingsOf(where), { heartbeat: { enabled: true, jitterMinutes: 45 }, bot: { timezone: 'UTC' } });
});

// ---- status ---------------------------------------------------------------------------------------------------------

/** Every file and folder under `dir`, to prove a read wrote none. */
const treeOf = (dir: string): Array<string> =>
  (readdirSync(dir, { recursive: true }) as Array<string>).map(String).sort();

for (const { form, parse } of FORMS) {
  test(`${form}: status with no core answers each field apart and exits 0`, async () => {
    // Catches: the core being down reads as disabled, or status fails where the saved state could be read from disk.
    const where = neptuniaServiceRig({ heartbeat: { enabled: true, schedule: 'at 06:00,18:00' } });
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
  const where = neptuniaServiceRig({ heartbeat: { enabled: false, schedule: 'at 06:00' } });
  const done = await run(where, 'heartbeat status');
  assert.equal(field(done.stdout, 'enabled'), 'false');
  assert.equal(field(done.stdout, 'schedule'), 'at 06:00');
  assert.equal(field(done.stdout, 'next due'), 'none');
});

test('status writes nothing and starts no process that changes the manager', async () => {
  // Catches: reading the status creates the data folders or the database, so a read changes a stopped deployment.
  const where = neptuniaServiceRig({ heartbeat: { enabled: true, schedule: 'every 6h' } });
  const before = treeOf(where.root);
  const raw = rawSettings(where);
  assert.equal((await run(where, 'heartbeat status')).code, 0);
  assert.deepEqual(treeOf(where.root), before);
  assert.equal(rawSettings(where), raw);
  assert.deepEqual(managerChanges(where), []);
});

// `wakeClockOf` (src/service/commands.ts), the core's reading of a persona wake for `/services <name> status`: the running
// inner life and the running diary as src/core.ts hands them over, answered through the console as the owner reads it.
// The inner life and the diary are the real ones over a fake turn runner and an injected clock, so the state the clock
// reads is the state they write. The tests assert on the `key: value` lines of the answer, never on wording.

const ROOT = 'g1';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const iso = (ms: number): string => new Date(ms).toISOString();
const at = (text: string): number => Date.parse(text);

const OPENED: Array<{ close(): unknown }> = [];

/** What `/services <name> status` answers in a core whose wakes `wakeClock` reads. */
async function statusOf(
  name: ServiceName,
  config: unknown,
  now: number,
  wakeClock: (name: ServiceName) => WakeClock | null
): Promise<Map<string, string>> {
  const dir = tempDir('nep-clock-console-');
  const desk = createConsole({
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: 'done', data: null }),
    ownerReads: { lessons: () => '' },
    places: () => [ROOT],
    selfId: () => 'self-1',
    hot: { config },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => now,
    wakeClock,
  });
  const parsed = parseCommandLine(`/services ${name} status`);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
  const answer = await desk.run(parsed.name, parsed.args, { id: 'owner-1' });
  assert.equal(answer.status, 'ok', answer.text);
  return new Map(
    answer.text.split('\n').flatMap((line): Array<[string, string]> => {
      const found = /^([a-z ]+): (.*)$/.exec(line);
      return found === null ? [] : [[found[1] ?? '', found[2] ?? '']];
    })
  );
}

/** A real inner life over `sections`, whose turn runner waits for `release` when `held`. */
function lifeWith(sections: Record<string, unknown>, start: number) {
  const clock = { t: start };
  world().channel({ id: 'c1', name: 'chan-c1', placeId: ROOT, permissions: { send: true } });
  const hot = {
    config: {
      bot: { timezone: 'UTC' },
      features: { wakes: true, intentions: true, journal: true },
      mention: { oneAtATime: true },
      wakes: { mode: 'shadow', tickSeconds: 60, review: { enabled: false, historyDays: 14 }, caps: { perChain: 3 } },
      heartbeat: { enabled: false },
      ...sections,
    },
  };
  const service = createIntentionService({
    stores: createIntentionStores({ dataDir: tempDir('nep-clock-'), now: () => clock.t, log: SILENT }),
    hot,
    now: () => clock.t,
    log: SILENT,
  });
  const gate = { held: false, entered: 0, release: () => {} };
  const turns = {
    isAnyBusy: () => false,
    runTurn: async () => {
      gate.entered += 1;
      if (gate.held) await new Promise<void>((resolve) => (gate.release = resolve));
      return { outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], turnId: `t-${gate.entered}` } };
    },
  };
  let life: ReturnType<typeof createInnerLife> | null = null;
  const door = createEventDoor({ handlers: { 'inner.wake': (event: object) => life?.onWake(event) }, log: SILENT });
  life = createInnerLife({
    hot,
    dataDir: tempDir('nep-clock-inner-'),
    turns,
    intentions: service,
    journal: { inner: () => Promise.resolve(), read: () => [] },
    reads: world().reads,
    iface: () => 'fake',
    chatName: (id: string) => `chan-${id}`,
    submit: (event: object) => door.submit(event),
    store: { state: { data: {} } },
    meter: { run: async (fn: () => unknown) => ({ result: await fn(), usd: 0, requests: 1, voice: 0 }) },
    rng: () => 0.5,
    now: () => clock.t,
    log: SILENT,
  });
  return { clock, life, gate, hot };
}

/** A real diary whose every post speaks, on the schedule of `diary`. */
function diaryWith(schedule: string, start: number) {
  const clock = { t: start };
  const memory = openTestMemorySync({ now: () => start });
  OPENED.push(memory);
  const hot = {
    config: { bot: { timezone: 'UTC' }, diary: { enabled: true, schedule, quietDayChance: 0 } },
    prompts: { labels: {} },
  };
  const store = {
    state: { data: {}, markDirty() {} },
    getDiary: () => ({ posts: [], updatedAt: 0 }),
    readMemory: (read: (db: unknown) => unknown) => read(memory.memoryDb.readHandle()?.db),
  };
  const diary = createDiary({
    hot,
    // @ts-expect-error: the stand-in store holds only the part of DiaryStore that the tick reads
    store,
    iface: () => 'fake',
    turns: {
      runTurn: () =>
        Promise.resolve({
          outcome: 'spoke',
          diary: { kind: 'thought', picture: false, search: false, messages: 1 },
        }),
    },
    isServedRoot: (id: unknown) => id === ROOT,
    rng: () => 0.5,
    now: () => clock.t,
  });
  return { clock, diary, hot };
}

// `/services diary status` while no `diary.schedule` is set (stage T.7 of the master plan): the diary
// is drawn from `diary.windows` in `bot.timezone`, and `next due` names the start of the next window that can
// post, as an ISO moment, instead of `unknown`. A window whose `posts` maximum is 0 never posts and is skipped. The core
// holds no wake clock here (`wakeClock` answers null), so the answer comes from the configuration alone.

type Window = { from: number; to: number; posts: [number, number] };

/** The `key: value` lines of `/services diary status` for `config` at `now`. */
async function nextDueWindowsStatusOf(config: unknown, now: number): Promise<Map<string, string>> {
  const dir = tempDir('nep-next-due-');
  const desk = createConsole({
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: 'done', data: null }),
    ownerReads: { lessons: () => '' },
    places: () => ['g1'],
    selfId: () => 'self-1',
    hot: { config },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => now,
    wakeClock: () => null,
  });
  const parsed = parseCommandLine('/services diary status');
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
  const answer = await desk.run(parsed.name, parsed.args, { id: 'owner-1' });
  assert.equal(answer.status, 'ok', answer.text);
  return new Map(
    answer.text.split('\n').flatMap((line): Array<[string, string]> => {
      const found = /^([a-z ]+): (.*)$/.exec(line);
      return found === null ? [] : [[found[1] ?? '', found[2] ?? '']];
    })
  );
}

const config = (windows: Array<Window>, timezone = 'UTC') => ({
  bot: { timezone },
  diary: { enabled: true, windows },
});

const DAYTIME: Array<Window> = [
  { from: 7, to: 11, posts: [0, 1] },
  { from: 18, to: 1, posts: [0, 2] },
];
describe('the clock of a wake', () => {
  before(() => {
    useIface('fake');
  });
  after(() => {
    useIface('discord');
  });

  after(async () => {
    for (const memory of OPENED.splice(0)) await memory.close();
  });

  test('a heartbeat that has drawn its moment shows that moment as next due, none as last and no run', async () => {
    // Catches: the clock reads another field of the state, so status shows the schedule's time, not the drawn one.
    const start = at('2026-11-04T05:00:00Z');
    const run = lifeWith({ heartbeat: { schedule: 'every 4h', jitterMinutes: 0 } }, start);
    await run.life.tick();
    const read = (name: ServiceName) =>
      wakeClockOf(name, {
        now: start,
        inner: run.life,
        diary: { status: () => ({ slots: [], done: [] }) },
      });
    const fields = await statusOf('heartbeat', run.hot.config, start, read);
    assert.equal(fields.get('next due'), iso(start + 4 * HOUR));
    assert.equal(fields.get('last result'), 'none');
    assert.equal(fields.get('running'), 'false');
  });

  test('with no root known yet a wake reads unknown, apart from its saved flag', async () => {
    // Catches: a core before its first hello throws on `inner.state(null)`, so status fails in the window it is most read.
    const inner = {
      // The state is the persona's now, read with or without a root; before the first tick it holds nothing.
      state: () => null,
    };
    const read = (name: ServiceName) =>
      wakeClockOf(name, { now: 0, inner, diary: { status: () => ({ slots: [], done: [] }) } });
    const fields = await statusOf('heartbeat', { heartbeat: { enabled: true, schedule: 'every 4h' } }, 0, read);
    assert.equal(fields.get('enabled'), 'true');
    assert.equal(fields.get('running'), 'unknown');
    assert.equal(fields.get('last result'), 'unknown');
  });

  test('a diary between its slots names the next slot not yet done and the slot that ran', async () => {
    // Catches: the next slot is the first of the plan, so status promises a post that already went out.
    const run = diaryWith('at 09:00,10:00', at('2026-11-04T08:00:00Z'));
    await run.diary.tick();
    run.clock.t = at('2026-11-04T09:05:00Z');
    await run.diary.tick();
    const now = run.clock.t;
    const read = (name: ServiceName) => wakeClockOf(name, { now, inner: lifeWith({}, now).life, diary: run.diary });
    const fields = await statusOf('diary', run.hot.config, now, read);
    assert.equal(fields.get('next due'), iso(at('2026-11-04T10:00:00Z')));
    assert.equal(fields.get('last result'), iso(at('2026-11-04T09:00:00Z')));
  });

  test('a diary past its last slot of the day names the first slot of tomorrow', async () => {
    // Catches: an empty remainder of the plan reads as no next time for an enabled service.
    const run = diaryWith('at 09:00', at('2026-11-04T08:00:00Z'));
    await run.diary.tick();
    run.clock.t = at('2026-11-04T09:05:00Z');
    await run.diary.tick();
    const now = run.clock.t;
    const read = (name: ServiceName) => wakeClockOf(name, { now, inner: lifeWith({}, now).life, diary: run.diary });
    const fields = await statusOf('diary', run.hot.config, now, read);
    assert.equal(fields.get('next due'), iso(at('2026-11-05T09:00:00Z')));
  });

  test('a diary slot dropped past its grace is no last result: only a slot that ran is', async () => {
    // Catches: the dropped slot joins `done`, so status reports a post at a time when nothing was written.
    const run = diaryWith('at 09:00,10:00', at('2026-11-04T08:00:00Z'));
    await run.diary.tick();
    run.clock.t = at('2026-11-04T09:05:00Z');
    await run.diary.tick();
    run.clock.t = at('2026-11-04T15:00:00Z');
    await run.diary.tick();
    const now = run.clock.t;
    const read = (name: ServiceName) => wakeClockOf(name, { now, inner: lifeWith({}, now).life, diary: run.diary });
    const fields = await statusOf('diary', run.hot.config, now, read);
    assert.equal(fields.get('last result'), iso(at('2026-11-04T09:00:00Z')));
  });

  test("a diary's last result survives midnight", async () => {
    // Catches: the clock reads only today's plan, so every new day reads "none" for a diary that posted last night.
    const run = diaryWith('at 22:00', at('2026-11-04T21:00:00Z'));
    await run.diary.tick();
    run.clock.t = at('2026-11-04T22:05:00Z');
    await run.diary.tick();
    run.clock.t = at('2026-11-05T01:00:00Z');
    await run.diary.tick();
    const now = run.clock.t;
    const read = (name: ServiceName) => wakeClockOf(name, { now, inner: lifeWith({}, now).life, diary: run.diary });
    const fields = await statusOf('diary', run.hot.config, now, read);
    assert.equal(fields.get('last result'), iso(at('2026-11-04T22:00:00Z')));
  });

  test('between two windows, next due is the start of the next one', async () => {
    // Catches: status answers `unknown` for a diary that is on and has a window ahead.
    const fields = await nextDueWindowsStatusOf(config(DAYTIME), at('2026-11-05T12:00:00Z'));
    assert.equal(fields.get('next due'), '2026-11-05T18:00:00.000Z');
  });

  test('inside the last window of the day, next due is the first window of tomorrow', async () => {
    // Catches: the window being lived in counts as ahead, or the day ends with no next moment.
    const fields = await nextDueWindowsStatusOf(config(DAYTIME), at('2026-11-05T20:00:00Z'));
    assert.equal(fields.get('next due'), '2026-11-06T07:00:00.000Z');
  });

  test('the window hours are read in bot.timezone', async () => {
    // Catches: windows are laid on the UTC clock, so a diary in another zone is announced hours off.
    const fields = await nextDueWindowsStatusOf(config(DAYTIME, 'Europe/Berlin'), at('2026-11-05T05:00:00Z'));
    assert.equal(fields.get('next due'), '2026-11-05T06:00:00.000Z');
  });

  test('a window that cannot post is skipped', async () => {
    // Catches: status promises a post at the start of a window whose maximum is zero.
    const fields = await nextDueWindowsStatusOf(
      config([
        { from: 7, to: 11, posts: [0, 0] },
        { from: 12, to: 16, posts: [0, 1] },
      ]),
      at('2026-11-05T05:00:00Z')
    );
    assert.equal(fields.get('next due'), '2026-11-05T12:00:00.000Z');
  });
});
