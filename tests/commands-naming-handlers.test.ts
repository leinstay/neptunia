// What runs behind the renamed commands (the command naming spec of 2026-11-04), in this process: `/services list`
// over the four mechanisms, the merged `/doctor` scopes in the core's console, the stale names the console no longer
// answers, and that every command a hint or a worker prompt recommends is one the table parses. The handlers are
// `serviceFamily` (src/service/commands.ts) and `createConsole` (src/interface/commands/console.ts), called with the
// name the table gives the line, so the internal operation names stay the implementation's. The manager is a fake that
// records its calls, `fetch` refuses every call, and a read must leave every byte of the private folder as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_NAMES, parseRequest } from '../bin/neptunia-request.ts';
import { retiredSetupStep, runUnitVerbs } from '../bin/neptunia-service.ts';
import { readConfig } from '../src/config.ts';
import { localConfigPath } from '../src/config/files.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import type { ConsoleDeps } from '../src/interface/commands/console.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import type { Parsed } from '../src/interface/commands/table.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { serviceFamily } from '../src/service/commands.ts';
import type { RunManager } from '../src/service/manager.ts';
import { runSetup } from '../src/setup/run.ts';
import type { RunResult, SetupDeps, SetupOptions } from '../src/setup/run.ts';
import { tempDir } from './fixtures/tmp.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.parse('2026-11-04T12:00:00Z');
const MECHANICS = ['heartbeat', 'selfreflection', 'selfimprovement', 'watcher'] as const;

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
    ownerReads: { lessons: () => '', aliases: () => '' },
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
  selfreflection: { enabled: true, schedule: 'at 09:15' },
  selfimprovement: { enabled: true, schedule: 'at 03:40' },
  watcher: { enabled: false, schedule: 'at 00:20,12:20' },
};

// ---- /services list --------------------------------------------------------------------------------------------------

for (const [how, pick] of [
  ['in the core', (r: Rig) => r.say.bind(r)],
  ['with no core', (r: Rig) => r.sayOffline.bind(r)],
] as const) {
  test(`/services list ${how} shows the four mechanisms with every row their own status shows, and writes nothing`, async () => {
    // Catches: the list keeps a copy of its own, drops a mechanism, adds a process unit, or writes while it reads.
    const r = rig(LOCAL);
    const say = pick(r);
    const before = digest(r.dir);
    const list = await say('/services list');
    assert.equal(list.status, 'ok', list.text);
    for (const name of MECHANICS) {
      assert.ok(list.text.includes(name), name);
      const status = await say(`/services ${name} status`);
      assert.equal(status.status, 'ok', status.text);
      const rows = status.text.split('\n').filter((row) => row !== '' && !row.startsWith('service:'));
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
  const r = rig({ selfreflection: { enabled: true, schedule: 'at 09:15' } });
  const before = await r.say('/services list');
  assert.equal((await r.say('/services selfreflection disable')).status, 'ok');
  const after = await r.say('/services list');
  assert.notEqual(after.text, before.text);
  const status = await r.say('/services selfreflection status');
  for (const row of status.text.split('\n').filter((one) => one !== '' && !one.startsWith('service:')))
    assert.ok(after.text.includes(row), row);
});

// ---- names the console no longer answers -----------------------------------------------------------------------------

for (const [name, args] of [
  ['health', {}],
  ['health', { part: 'core' }],
  ['wakes.list', {}],
  ['wakes.stop', {}],
  ['wakes.start', {}],
] as const) {
  test(`a client that sends ${name} raw is refused, and nothing runs`, async () => {
    // Catches: the retired command lives on in the console, reachable by an old client or a script that skips the parse.
    const r = rig();
    const answer = await r.raw(name, args);
    assert.notEqual(answer.status, 'ok', answer.text);
    assert.deepEqual(r.ops, []);
    assert.deepEqual(r.fetched, []);
  });
}

// ---- /doctor scopes --------------------------------------------------------------------------------------------------

test('/doctor server, core and memory answer different reads, ask no model and write nothing', async () => {
  // Catches: the merged scopes answer the same text, reach the model probe, or move a setting.
  const r = rig();
  const before = digest(r.dir);
  const server = await r.say('/doctor server');
  const core = await r.say('/doctor core');
  const memory = await r.say('/doctor memory');
  assert.ok(server.text.includes(r.dir), 'the server scope reads the data folder it was given');
  assert.equal(core.status, 'ok', core.text);
  assert.equal(memory.status, 'ok', memory.text);
  assert.equal(new Set([server.text, core.text, memory.text]).size, 3);
  assert.ok(core.text.length > 0 && memory.text.length > 0);
  assert.deepEqual(r.ops, [], 'a scope runs no operation');
  assert.deepEqual(r.fetched, [], 'a scope asks no provider');
  assert.equal(digest(r.dir), before);
});

test('/doctor core and memory fail clearly while the memory database is closed, and the server scope still answers', async () => {
  // Catches: a closed core throws out of the console, or the server scope needs a database it never reads.
  const r = rig(null, false);
  for (const line of ['/doctor core', '/doctor memory']) {
    const answer = await r.say(line);
    assert.equal(answer.status, 'failed', line);
    assert.notEqual(answer.text, '', line);
  }
  const server = await r.say('/doctor server');
  assert.ok(server.text.includes(r.dir), server.text);
});

test('/doctor live is the one scope that probes the models, through an operation', async () => {
  // Catches: the probe runs on a plain /doctor, or disappears in the merge.
  const live = rig();
  await live.say('/doctor live');
  assert.ok(live.ops.length > 0, 'live runs the probe operation');
  const plain = rig();
  await plain.say('/doctor core');
  assert.deepEqual(plain.ops, []);
});

// ---- hints that name a command ---------------------------------------------------------------------------------------

/** The retired spelling of the family: `neptunia service` followed by anything but the plural's `s`. */
const RETIRED_SPELLING = /neptunia service(?!s)\b/;

test('a retired setup step is refused with a command of the table, in the new spelling', () => {
  // Catches: the refusal sends the owner to a spelling the table has retired.
  for (const step of ['watcher', 'selfimprovement', 'mechanics']) {
    const text = retiredSetupStep([step]) ?? '';
    assert.equal(RETIRED_SPELLING.test(text), false, text);
    const named = /use neptunia (services [^;]*)$/.exec(text)?.[1] ?? '';
    assert.notEqual(named, '', `${step}: ${text}`);
    if (!named.includes('<')) assertParsed(`/${named}`);
  }
});

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

test('the shell refuses an unknown first word after services with a usage in the new spelling', () => {
  // Catches: the usage still teaches `neptunia service`, which the table now refuses.
  const usage = refusalOf(['bogus']);
  assert.equal(RETIRED_SPELLING.test(usage), false, usage);
  assert.ok(usage.includes('neptunia services'), usage);
});

test('the order of the unit verbs and a mechanism name is refused with a hint that parses', () => {
  // Catches: `services status watcher` is taken for a unit named watcher, or the hint names a spelling that is retired.
  const hint = refusalOf(['status', 'watcher']);
  assert.equal(RETIRED_SPELLING.test(hint), false, hint);
  const named = /use neptunia (services watcher \w+)/.exec(hint)?.[1] ?? '';
  assert.notEqual(named, '', hint);
  assert.equal(parseRequest(named.split(' ')).parsed.ok, true, named);
});

for (const words of [['list'], ['watcher', 'status'], ['heartbeat', 'setup', '--every', '3h']]) {
  test(`neptunia services ${words.join(' ')} is the family and returns to its caller`, () => {
    // Catches: `list` is taken for a unit verb and refused, or a mechanism's word order stops reaching the family.
    assert.doesNotThrow(() =>
      runUnitVerbs(words, (reason) => {
        throw new Refused(reason);
      })
    );
  });
}

test('the commands setup says to type next begin with a command of the table', async () => {
  // Catches: the guide's last lines send the owner to a command that was renamed.
  const base = tempDir('nep-naming-setup-');
  const home = join(base, 'home');
  mkdirSync(home);
  const options: SetupOptions = {
    system: false,
    user: 'alice',
    group: 'alice',
    home,
    rootDir: REPO,
    privateDir: join(base, 'data'),
    dataDir: join(base, 'data'),
    node: '/usr/bin/node',
    xdgConfigHome: join(base, 'xdg'),
  };
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
  const state = { linger: false, active: false };
  const deps: SetupDeps = {
    run: (command, args) => {
      const line = [command, ...args].join(' ');
      if (line.startsWith('loginctl show-user')) return Promise.resolve(ok(`Linger=${state.linger ? 'yes' : 'no'}\n`));
      if (line.startsWith('loginctl enable-linger')) state.linger = true;
      if (line.includes('is-active')) return Promise.resolve({ code: state.active ? 0 : 3, stdout: '', stderr: '' });
      if (line.includes('enable --now')) state.active = true;
      return Promise.resolve(ok());
    },
    openChat: () => Promise.resolve(),
  };
  const report = await runSetup(options, deps);
  assert.ok(report.next.length > 0);
  for (const entry of report.next) {
    assert.ok(COMMAND_NAMES.includes(entry.split(' ')[0] ?? ''), entry);
    if (entry.includes('discord')) assertParsed(`/${entry}`);
  }
});

test('every neptunia command a worker prompt tells an agent to run is one the table parses', () => {
  // Catches: the watcher's agent is told to run a command spelling that was renamed, and its evidence read fails.
  const outside = new Set(['worker', 'task', 'tasks', 'setup', 'errand-runner', '-p']);
  let found = 0;
  for (const agent of readdirSync(join(REPO, 'agents'), { withFileTypes: true })) {
    if (!agent.isDirectory()) continue;
    const prompt = readFileSync(join(REPO, 'agents', agent.name, 'prompt.md'), 'utf8');
    for (const span of prompt.matchAll(/`neptunia ([^`]+)`/g)) {
      const words = (span[1] ?? '').split(' ').filter((word) => word !== '');
      if (outside.has(words[0] ?? '') || words.some((word) => /[<[]/.test(word))) continue;
      found += 1;
      const parsed = parseRequest(words).parsed;
      assert.ok(parsed.ok, `${agent.name}: neptunia ${words.join(' ')}`);
    }
  }
  assert.ok(found > 0, 'the watcher prompt names its evidence command');
});
