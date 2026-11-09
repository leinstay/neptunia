// The command table of PR 7a through `neptunia -p` (bin/neptunia.ts) against the core with its interfaces as units
// (tests/fixtures/core-units.ts): every command answers, the owner's commands run with the owner's rights while
// `bot.owners` is empty, `/tools grant` and `/tools revoke` change her grants and so her next request's tools, the
// files a command writes hold what it was given, and the exit code says whether the command ran. The tests assert on
// data they put in (a model id, a cost, a rule's text, a unit name), on exit codes and on files, never on wording.
// `fetch` is replaced by a recorder that refuses every call, so no command reaches a provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConsole } from '../src/interface/commands/console.ts';
import type { ConsoleDeps } from '../src/interface/commands/console.ts';
import { COMMANDS, parseCommandLine } from '../src/interface/commands/table.ts';
import { NOT_GRANTABLE_TO_PERSONA } from '../src/tools/access.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { personaKey } from '../src/memory/db/storage-keys.ts';
import { applyUnitWrite } from '../src/memory/db/unit-write.ts';
import { tempDir } from './fixtures/tmp.ts';
import {
  REPO,
  isRecord,
  mention,
  postedOnce,
  runCli,
  spawnCli,
  startUnitsCore,
  startedUnit,
  until,
  withRig,
} from './fixtures/core-units.ts';
import type { Dirs, Rig, Settings } from './fixtures/core-units.ts';

const T0 = Date.parse('2026-10-31T12:00:00Z');

/** The commands of the 4.3 table in PR 7a, as `/help` must list them. */
const TABLE = [
  'status',
  'doctor',
  'logs',
  // Changed: `/report` is retired, the report reads as `/logs watcher`, so the one new command is `services`.
  'services',
  'usage',
  'errands',
  'intentions',
  'pause',
  // Stage Z: the engine proxy's commands.
  'proxy',
  'resume',
  'config',
  'model',
  'routes',
  'memory',
  'rules',
  'tools',
  'skills',
  'interfaces',
  'keys',
  'subharness',
  // Changed: `/agent` holds the execution mode that left `/subharness`.
  'agent',
  // Changed: `/search` holds quick search's targeted settings.
  'search',
  // Changed: `/mirror` is the owner's family over the diary's mirrors.
  'mirror',
  'help',
  'clear',
];

/** Her own id on the fake interface (tests/fixtures/interfaces/fake/index.ts). */
const SELF_ID = 'self-id';

const p = (dirs: Dirs, line: string): ReturnType<typeof runCli> => runCli(dirs, ['-p', line]);

/** The private layer's config.local.json as it is on disk now. */
function localConfig(dirs: Dirs): Settings {
  const parsed: unknown = JSON.parse(readFileSync(join(dirs.privateDir, 'config', 'config.json'), 'utf8'));
  assert.ok(isRecord(parsed));
  return parsed;
}

/** `bot.access` of the local layer, `{}` when none is written. */
function accessOf(dirs: Dirs): Settings {
  const bot = localConfig(dirs).bot;
  const access = isRecord(bot) ? bot.access : undefined;
  return isRecord(access) ? access : {};
}

/** The users a grant of `name` names in the local layer. */
function grantedUsers(dirs: Dirs, name: string): Array<unknown> {
  const entry = accessOf(dirs)[name];
  return isRecord(entry) && Array.isArray(entry.users) ? (entry.users as Array<unknown>) : [];
}

/** The tool names of the model call `index`, as the native transport sends them (`web.search` is `web_search`). */
function toolsOf(rig: Rig, index: number): Array<string> {
  const options = rig.llm.options[index];
  const tools = isRecord(options) && Array.isArray(options.tools) ? (options.tools as Array<unknown>) : [];
  return tools.flatMap((tool) =>
    isRecord(tool) && isRecord(tool.function) && typeof tool.function.name === 'string' ? [tool.function.name] : []
  );
}

const digestOf = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Runs `body` with `fetch` refusing every call; resolves with the URLs that were asked for. */
async function withoutFetch(body: () => Promise<void>): Promise<Array<string>> {
  const asked: Array<string> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request): Promise<Response> => {
    asked.push(input instanceof Request ? input.url : String(input));
    return Promise.reject(new Error('no network in tests'));
  };
  try {
    await body();
  } finally {
    globalThis.fetch = real;
  }
  return asked;
}

/** Today's usage rows in the persona's `usage` unit before the core starts: two roles with costs no label holds. */
function seedUsage(dirs: Dirs): void {
  mkdirSync(dirs.dataDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const row = (requests: number, cost: number): Settings => ({
    requests,
    promptTokens: 1000 * requests,
    cachedTokens: 0,
    completionTokens: 10 * requests,
    cost,
  });
  const seed = openMemoryDb(join(dirs.dataDir, 'memory.db'));
  applyUnitWrite(seed, {
    op: 'value',
    key: personaKey('usage'),
    value: { v: 1, days: { [today]: { vision: row(3, 0.4321), analyzer: row(2, 0.0123) } } },
  });
  seed.close();
}

// Spec case 1.
test('/help lists exactly the commands of the table', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const run = await p(dirs, '/help');
    assert.equal(run.code, 0, run.stderr.slice(-2000));
    const listed = new Set(
      run.stdout.split('\n').flatMap((line) => {
        const found = /^\/(\S+)/.exec(line.trim());
        return found?.[1] === undefined ? [] : [found[1]];
      })
    );
    assert.deepEqual([...listed].sort(), [...TABLE].sort());
  });
});

// Spec case 1.
test('every read command of the table answers with exit 0 and asks no model', async (t) => {
  await withRig({ config: { features: { intentions: true } } }, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const lines = [
      '/status',
      '/status full',
      '/doctor core',
      '/doctor memory',
      '/usage',
      '/usage 7d',
      '/usage 30d',
      '/errands',
      '/errands list',
      '/intentions',
      '/intentions list',
      '/services list',
      '/config show',
      '/config get pace.settleMs',
      '/model',
      '/routes',
      '/memory recent --place g1',
      // Plan 2026-11-04-cli-and-memory task 8 retires `/memory lore`: its reads are place-qualified.
      '/memory places lore list g1',
      '/rules list',
      '/tools list',
      '/tools describe web.search',
      '/interfaces list',
    ];
    // `/services list` runs in the core, in this process, and reads the units.
    const manager = fakeManager(dirs.root);
    const asked = await withoutFetch(async () => {
      for (const line of lines)
        await t.test(line, async () => {
          const run = await withPath(manager, () => p(dirs, line));
          assert.equal(run.code, 0, `${line}: ${run.stdout.slice(-500)}${run.stderr.slice(-1000)}`);
          assert.notEqual(run.stdout.trim(), '', `${line} prints an answer`);
        });
    });
    assert.equal(llm.requests.length, 0, 'no command asks a model');
    assert.deepEqual(asked, [], 'no command calls fetch');
  });
});

// The parse error path of `-p`: the line never becomes a command.
test('/search status says off and unset while the persona chose no engine, as the shipped settings choose none', async () => {
  // Changed: quick search has no shipped engine, so `engine unset` is the true answer.
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const run = await p(dirs, '/search');
    assert.equal(run.code, 0, run.stderr.slice(-2000));
    assert.match(run.stdout, /quick search is off, engine unset/);
  });
});

test('-p exits 2 for a line the table refuses', async () => {
  // A line the command table refuses is bad syntax, which exits 2 by the CLI's return codes; 1 is an operational failure.
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    // Changed: the last example was `/mirror list`, and `/mirror` is a table command.
    for (const line of ['/memory', '/usage 90d', '/doctor disks', '/nosuchcommand list']) {
      const run = await p(dirs, line);
      assert.equal(run.code, 2, line);
      assert.notEqual(run.stderr.trim(), '', `${line}: the reason is on stderr`);
    }
  });
});

// Spec case 2. The card's fields became sections of text: the models of every role and today's costs per role.
test('/status full holds the models of every role and the costs of the day, and /status only the summary', async () => {
  const config = { models: { base: { core: 'zeta/core-71', drawing: 'zeta/draw-72' } } };
  await withRig({ config }, async ({ dirs, llm, cores }) => {
    seedUsage(dirs);
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    let full = { code: -1 as number | null, stdout: '' };
    let short = { code: -1 as number | null, stdout: '' };
    const asked = await withoutFetch(async () => {
      full = await p(dirs, '/status full');
      short = await p(dirs, '/status');
    });
    assert.equal(full.code, 0);
    assert.ok(full.stdout.includes('zeta/draw-72'), 'the drawing model, a field of the card');
    assert.ok(full.stdout.includes('0.4321'), "a role's cost of the day, a field the card shows the owner only");
    assert.equal(short.code, 0);
    assert.equal(short.stdout.includes('zeta/draw-72'), false, 'the summary lists no model per role');
    assert.equal(llm.requests.length, 0, 'the full status probes no model');
    assert.deepEqual(asked, [], 'the full status calls no provider');
  });
});

// Spec case 3, the grant.
test('/tools grant web.search opens the tool to her, and her next request carries it', async () => {
  await withRig({}, async (rig) => {
    const { dirs, llm, cores, units } = rig;
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const unit = await startedUnit(dirs);
    units.push(unit);
    const run = await p(dirs, '/tools grant web.search');
    assert.equal(run.code, 0, run.stdout + run.stderr.slice(-2000));
    assert.deepEqual(grantedUsers(dirs, 'web.search'), [SELF_ID], 'her grant, by her own id');
    assert.equal(await (await unit.emit(mention('m1', 'hello bot'))).acked, 'ok');
    await until(() => llm.requests.length >= 1, 'the turn after the grant');
    assert.ok(toolsOf(rig, 0).includes('web_search'), `her tools: ${toolsOf(rig, 0).join(', ')}`);
  });
});

// Spec case 3, the revoke.
test('/tools revoke web.search closes the tool again, and her next request lacks it', async () => {
  const config = { bot: { access: { 'web.search': { users: [SELF_ID] } } } };
  await withRig({ config }, async (rig) => {
    const { dirs, llm, cores, units } = rig;
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const unit = await startedUnit(dirs);
    units.push(unit);
    const run = await p(dirs, '/tools revoke web.search');
    assert.equal(run.code, 0, run.stdout + run.stderr.slice(-2000));
    assert.deepEqual(grantedUsers(dirs, 'web.search'), []);
    assert.equal(await (await unit.emit(mention('m1', 'hello bot'))).acked, 'ok');
    await until(() => llm.requests.length >= 1, 'the turn after the revoke');
    assert.equal(toolsOf(rig, 0).includes('web_search'), false);
  });
});

// Spec case 4.
test('/tools grant config.set is refused and writes no grant', async () => {
  await withRig({}, async ({ dirs, llm, cores, units }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    units.push(await startedUnit(dirs));
    const run = await p(dirs, '/tools grant config.set');
    assert.equal(run.code, 1);
    assert.ok((run.stdout + run.stderr).includes('config.set'), 'the refusal names the tool');
    assert.equal(Object.hasOwn(accessOf(dirs), 'config.set'), false);
  });
});

test('/tools grant with a user target grants that person and not her', async () => {
  await withRig({}, async ({ dirs, llm, cores, units }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    units.push(await startedUnit(dirs));
    const run = await p(dirs, '/tools grant memory.profile.read user u-77');
    assert.equal(run.code, 0, run.stdout + run.stderr.slice(-2000));
    assert.deepEqual(grantedUsers(dirs, 'memory.profile.read'), ['u-77']);
  });
});

test('/tools grant fails and writes nothing while no interface has said who she is', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const before = digestOf(join(dirs.privateDir, 'config', 'config.json'));
    const run = await p(dirs, '/tools grant web.search');
    assert.equal(run.code, 1);
    assert.ok((run.stdout + run.stderr).includes('web.search'), 'the refusal names the tool');
    assert.equal(digestOf(join(dirs.privateDir, 'config', 'config.json')), before);
  });
});

// The owner's rights: the rig's `bot.owners` is empty, and an owner-only operation still runs from the chat.
test('/rules add from the chat adds the rule while bot.owners is empty, and the tracked rules stay as they are', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const tracked = join(REPO, 'prompts', 'rules.md');
    const before = digestOf(tracked);
    const added = await p(dirs, '/rules add never answer before noon zeta71');
    assert.equal(added.code, 0, added.stdout + added.stderr.slice(-2000));
    const listed = await p(dirs, '/rules list');
    assert.ok(listed.stdout.includes('never answer before noon zeta71'), 'the whole text is one rule');
    assert.equal(digestOf(tracked), before);
  });
});

test('/config set writes the local layer and /config get reads the value back', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const set = await p(dirs, '/config set pace.settleMaxMs 4171');
    assert.equal(set.code, 0, set.stdout + set.stderr.slice(-2000));
    const pace = localConfig(dirs).pace;
    assert.ok(isRecord(pace));
    assert.equal(pace.settleMaxMs, 4171);
    const got = await p(dirs, '/config get pace.settleMaxMs');
    assert.equal(got.code, 0);
    assert.ok(got.stdout.includes('4171'));
  });
});

test('/config unset removes the key from the local layer', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const run = await p(dirs, '/config unset pace.settleMaxMs');
    assert.equal(run.code, 0, run.stdout + run.stderr.slice(-2000));
    const pace = localConfig(dirs).pace;
    assert.equal(isRecord(pace) && Object.hasOwn(pace, 'settleMaxMs'), false);
  });
});

test('/config set without a value exits 2 and leaves the local layer as it was', async () => {
  // A line the command table refuses is bad syntax, which exits 2 by the CLI's return codes; 1 is an operational failure.
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const before = digestOf(join(dirs.privateDir, 'config', 'config.json'));
    const run = await p(dirs, '/config set pace.settleMaxMs');
    assert.equal(run.code, 2);
    assert.notEqual(run.stderr.trim(), '', 'a refused parse says why on stderr');
    assert.equal(digestOf(join(dirs.privateDir, 'config', 'config.json')), before);
  });
});

test('/memory restore of an id no archive holds exits 1', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const run = await p(dirs, '/memory restore no-such-item-71');
    assert.equal(run.code, 1);
    assert.ok((run.stdout + run.stderr).includes('no-such-item-71'), 'the answer names the id');
  });
});

test('/memory conversation prints a line of that chat', async () => {
  await withRig({}, async ({ dirs, llm, cores, units }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const unit = await startedUnit(dirs);
    units.push(unit);
    assert.equal(await (await unit.emit(mention('m1', 'the tower zeta71 has seven floors'))).acked, 'ok');
    await postedOnce(unit, 1);
    const run = await p(dirs, '/memory conversation c1');
    assert.equal(run.code, 0, run.stdout + run.stderr.slice(-2000));
    assert.ok(run.stdout.includes('the tower zeta71 has seven floors'));
  });
});

// Plan 2026-11-04-cli-and-memory task 8 retires `/memory lore`: its operations are place-qualified.
test('/memory places lore add stores an entry that /memory places lore list then names', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const added = await p(dirs, '/memory places lore add g1 Zetatower zetatower,spire The tower has seven floors');
    assert.equal(added.code, 0, added.stdout + added.stderr.slice(-2000));
    assert.ok((await p(dirs, '/memory places lore list g1')).stdout.includes('Zetatower'));
  });
});

// Open point 1 of the brief: no operation lists the lessons today.
test('/memory lessons add stores a lesson that /memory lessons list then shows', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const added = await p(dirs, '/memory lessons add zeta71 is spelled with a z --place g1');
    assert.equal(added.code, 0, added.stdout + added.stderr.slice(-2000));
    assert.ok((await p(dirs, '/memory lessons list --place g1')).stdout.includes('zeta71 is spelled with a z'));
  });
});

test('/errands show, /errands cancel and /intentions cancel of an unknown id exit 1', async () => {
  await withRig({ config: { features: { intentions: true } } }, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    for (const line of ['/errands show no-such-71', '/errands cancel no-such-71', '/intentions cancel no-such-71']) {
      const run = await p(dirs, line);
      assert.equal(run.code, 1, line);
      assert.ok((run.stdout + run.stderr).includes('no-such-71'), `${line}: the answer names the id`);
    }
  });
});

// Spec case 7.
test('-p "/usage 7d" exits 0 and prints the roles of the usage rows', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    seedUsage(dirs);
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    let run = { code: -1 as number | null, stdout: '' };
    const asked = await withoutFetch(async () => {
      run = await p(dirs, '/usage 7d');
    });
    assert.equal(run.code, 0);
    for (const fact of ['vision', 'analyzer', '0.4321']) assert.ok(run.stdout.includes(fact), fact);
    assert.deepEqual(asked, []);
  });
});

// Spec case 7: the turn hands the client the interface of its event, which the usage line then carries.
test('a turn of a line typed in the chat calls the model with the cli interface', async () => {
  await withRig({}, async ({ dirs, llm, cores, clis }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const chat = spawnCli(dirs, []);
    clis.push(chat);
    chat.type('hello from the console');
    await until(
      () => llm.requests.length >= 1,
      () => `her turn; stderr:\n${chat.stderr().slice(-2000)}`
    );
    const options = llm.options[0];
    assert.ok(isRecord(options));
    assert.equal(options.iface, 'cli');
  });
});

/** A fake `journalctl` in `dir` that writes its arguments one per line to `argsFile` and prints two lines. */
function fakeJournalctl(dir: string, argsFile: string): void {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'journalctl');
  writeFileSync(
    script,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\necho 'zeta-journal-line-1'\necho 'zeta-journal-line-2'\n`
  );
  chmodSync(script, 0o755);
}

/** Runs `body` with `dir` first on PATH, where the core looks for `journalctl`. */
async function withPath<T>(dir: string, body: () => Promise<T>, only = false): Promise<T> {
  const real = process.env.PATH;
  process.env.PATH = only ? dir : `${dir}:${real ?? ''}`;
  try {
    return await body();
  } finally {
    process.env.PATH = real;
  }
}

/** A folder with a `systemctl` that answers `inactive` and moves nothing, for a read that runs in the core. */
function fakeManager(root: string): string {
  const bin = join(root, 'fakemanager');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'systemctl'), '#!/bin/sh\necho inactive\nexit 3\n', { mode: 0o755 });
  return bin;
}

/** The arguments the fake journalctl got. */
const argsOf = (file: string): Array<string> =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((arg) => arg !== '');

/** True when `args` holds `flag` followed by `value`. */
const pair = (args: ReadonlyArray<string>, flag: string, value: string): boolean =>
  args.some((arg, index) => arg === flag && args[index + 1] === value);

// Spec case 6.
test('/logs errors runs journalctl at priority err for the core unit and prints its lines', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    const bin = join(dirs.root, 'fakebin');
    const argsFile = join(dirs.root, 'journalctl.args');
    fakeJournalctl(bin, argsFile);
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const run = await withPath(bin, () => p(dirs, '/logs errors'));
    assert.equal(run.code, 0, run.stdout + run.stderr.slice(-2000));
    const args = argsOf(argsFile);
    assert.ok(pair(args, '-p', 'err'), args.join(' '));
    assert.ok(pair(args, '-u', 'neptunia-core.service'), args.join(' '));
    assert.ok(run.stdout.includes('zeta-journal-line-1') && run.stdout.includes('zeta-journal-line-2'));
  });
});

test('/logs without errors reads every priority', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    const bin = join(dirs.root, 'fakebin');
    const argsFile = join(dirs.root, 'journalctl.args');
    fakeJournalctl(bin, argsFile);
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const run = await withPath(bin, () => p(dirs, '/logs'));
    assert.equal(run.code, 0, run.stdout + run.stderr.slice(-2000));
    assert.equal(pair(argsOf(argsFile), '-p', 'err'), false);
  });
});

test('/logs exits 1 where journalctl does not exist', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    const empty = join(dirs.root, 'emptybin');
    mkdirSync(empty);
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const run = await withPath(empty, () => p(dirs, '/logs'), true);
    assert.equal(run.code, 1);
    assert.ok((run.stdout + run.stderr).includes('journalctl'), 'the answer names the missing program');
  });
});

/** The checks of `neptunia doctor --json` by name. */
function doctorChecks(stdout: string): Map<string, string> {
  const parsed: unknown = JSON.parse(stdout);
  assert.ok(isRecord(parsed) && Array.isArray(parsed.checks));
  return new Map(
    (parsed.checks as Array<unknown>).flatMap((check) =>
      isRecord(check) && typeof check.name === 'string' ? [[check.name, String(check.status)] as const] : []
    )
  );
}

test('/doctor in the chat runs the checks of neptunia doctor and ends as it ends', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    // The `runtime` check reads the server's units in the core, which runs in this process.
    const bin = fakeManager(dirs.root);
    const direct = await withPath(bin, () => runCli(dirs, ['doctor', '--json']));
    const checks = doctorChecks(direct.stdout);
    const chat = await withPath(bin, () => p(dirs, '/doctor'));
    assert.equal(chat.code, direct.code);
    for (const name of checks.keys()) assert.ok(chat.stdout.includes(name), `the chat's doctor names ${name}`);
  });
});

// ---- the owner's operations after `/nep` (PR 7b) ---------------------------------------------------------------

/** Every line of the table with its required arguments filled: a choice by its first value, anything else by `1`. */
function everyLine(): Array<string> {
  const filled = (args: ReadonlyArray<{ required: boolean; choices?: ReadonlyArray<string> }>): Array<string> =>
    args.filter((one) => one.required).map((one) => one.choices?.[0] ?? '1');
  return COMMANDS.flatMap((command) => {
    const subs = command.subcommands;
    if (subs.length === 0) return [['/' + command.name, ...filled(command.args)].join(' ')];
    return subs.map((one) => ['/' + command.name, ...one.name.split('.'), ...filled(one.args)].join(' '));
  });
}

// The operations no grant opens to her (src/tools/access.ts#NOT_GRANTABLE_TO_PERSONA) have no way to run once `/nep`
// is gone but a command of the chat: she cannot run them for the owner. `/doctor` with its scopes and `/logs` run no operation and
// read the machine, so they are left out.
/** A console over `places`, its operations refusing a command with no place as the core's do. */
function placeConsole(places: Array<string>) {
  const seen: Array<unknown> = [];
  const dir = tempDir('nep-console-place-');
  const desk = createConsole({
    runOp: (_op, _args, context) => {
      seen.push(context.placeId);
      return Promise.resolve(
        context.placeId === null
          ? { status: 'failed', code: 'PLACE_REQUIRED', summary: 'no place resolved yet', data: null }
          : { status: 'ok', code: '', summary: 'done', data: null }
      );
    },
    ownerReads: { lessons: () => '' },
    places: () => places,
    selfId: () => 'self-1',
    hot: { config: { bot: { owners: [] } } },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => T0,
  });
  const run = (line: string) => {
    const parsed = parseCommandLine(line);
    assert.ok(parsed.ok);
    return desk.run(parsed.name, parsed.args, { id: 'owner-1' });
  };
  return { run, seen };
}

test('a command with no place named runs in the only place served', async () => {
  // Bug: with one server the owner has to name it on every line.
  const { run, seen } = placeConsole(['place:a']);
  assert.equal((await run('/memory recent')).status, 'ok');
  assert.deepEqual(seen, ['place:a']);
});

test('a command with no place named among several answers with the choices and picks none', async () => {
  // Bug: the first place stands in as a home, and the owner edits the wrong server's memory.
  const { run, seen } = placeConsole(['place:a', 'place:b']);
  const answer = await run('/memory recent');
  assert.notEqual(answer.status, 'ok');
  assert.ok(answer.text.includes('place:a') && answer.text.includes('place:b'), answer.text);
  assert.deepEqual(seen, [null]);
});

test('a command names its place with --place, the words before it kept', async () => {
  // Bug: a lore text that holds "--" loses its words to the flag parser.
  const { run, seen } = placeConsole(['place:a', 'place:b']);
  assert.equal((await run('/memory recent --place place:b')).status, 'ok');
  assert.deepEqual(seen, ['place:b']);
  const parsed = parseCommandLine('/memory lessons add one -- two --place place:a');
  assert.ok(parsed.ok);
  assert.equal(parsed.args.place, 'place:a');
  assert.equal(parsed.args.text, 'one -- two');
});

test('every operation no grant opens to her runs from a command of the chat', async () => {
  const ran = new Set<string>();
  const managerCalls: Array<string> = [];
  const dir = tempDir('nep-console-ops-');
  const deps: ConsoleDeps = {
    runOp: (op) => {
      ran.add(op);
      return Promise.resolve({ status: 'ok', code: '', summary: 'done', data: null });
    },
    ownerReads: { lessons: () => '' },
    places: () => ['g1'],
    selfId: () => 'self-1',
    hot: { config: { bot: { owners: [] } } },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => T0,
    // `/services watcher enable` and `disable` are lines of the table: without this they move the server's real timer.
    serviceManager: (command, args) => {
      managerCalls.push([command, ...args].join(' '));
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    },
  };
  const desk = createConsole(deps);
  for (const line of everyLine()) {
    const parsed = parseCommandLine(line);
    if (!parsed.ok || ['doctor', 'doctor.server', 'doctor.core', 'doctor.memory', 'logs'].includes(parsed.name))
      continue;
    await desk.run(parsed.name, parsed.args, { id: 'owner-1' });
  }
  assert.deepEqual(
    NOT_GRANTABLE_TO_PERSONA.filter((op) => !ran.has(op)),
    []
  );
  assert.ok(
    managerCalls.some((call) => call.endsWith('enable --now neptunia-watcher.timer')),
    managerCalls.join('\n')
  );
});
