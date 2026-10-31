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
import { backupsIn } from '../src/memory/db/backup.js';
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
  'health',
  'logs',
  'usage',
  'errands',
  'intentions',
  'wakes',
  'pause',
  'resume',
  'config',
  'model',
  'route',
  'memory',
  'rules',
  'tools',
  'interface',
  'help',
  'clear',
];

/** Her own id on the fake interface (tests/fixtures/interfaces/fake/index.ts). */
const SELF_ID = 'self-id';

const p = (dirs: Dirs, line: string): ReturnType<typeof runCli> => runCli(dirs, ['-p', line]);

/** The private layer's config.local.json as it is on disk now. */
function localConfig(dirs: Dirs): Settings {
  const parsed: unknown = JSON.parse(readFileSync(join(dirs.privateDir, 'config.local.json'), 'utf8'));
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

/** Today's usage rows in `data/usage.json` before the core starts: two roles with costs no label holds. */
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
  writeFileSync(
    join(dirs.dataDir, 'usage.json'),
    JSON.stringify({ v: 1, days: { [today]: { vision: row(3, 0.4321), analyzer: row(2, 0.0123) } } })
  );
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
      '/health core',
      '/health memory',
      '/usage',
      '/usage 7d',
      '/usage 30d',
      '/errands',
      '/errands list',
      '/intentions',
      '/intentions list',
      '/wakes',
      '/config show',
      '/config get pace.settleMs',
      '/model',
      '/route',
      '/memory recent',
      '/memory lore list',
      '/rules list',
      '/tools list',
      '/tools describe web.search',
      '/interface list',
    ];
    const asked = await withoutFetch(async () => {
      for (const line of lines)
        await t.test(line, async () => {
          const run = await p(dirs, line);
          assert.equal(run.code, 0, `${line}: ${run.stdout.slice(-500)}${run.stderr.slice(-1000)}`);
          assert.notEqual(run.stdout.trim(), '', `${line} prints an answer`);
        });
    });
    assert.equal(llm.requests.length, 0, 'no command asks a model');
    assert.deepEqual(asked, [], 'no command calls fetch');
  });
});

// The parse error path of `-p`: the line never becomes a command.
test('-p exits 1 for a line the table refuses', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    for (const line of ['/memory', '/usage 90d', '/health disks', '/mirror list']) {
      const run = await p(dirs, line);
      assert.equal(run.code, 1, line);
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
    const before = digestOf(join(dirs.privateDir, 'config.local.json'));
    const run = await p(dirs, '/tools grant web.search');
    assert.equal(run.code, 1);
    assert.ok((run.stdout + run.stderr).includes('web.search'), 'the refusal names the tool');
    assert.equal(digestOf(join(dirs.privateDir, 'config.local.json')), before);
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

test('/config set without a value exits 1 and leaves the local layer as it was', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const before = digestOf(join(dirs.privateDir, 'config.local.json'));
    const run = await p(dirs, '/config set pace.settleMaxMs');
    assert.equal(run.code, 1);
    assert.notEqual(run.stderr.trim(), '', 'a refused parse says why on stderr');
    assert.equal(digestOf(join(dirs.privateDir, 'config.local.json')), before);
  });
});

test('/memory backup makes one backup in the backups folder and names it', async () => {
  await withRig({ config: { memoryDb: { backup: { dir: '../b' } } } }, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const run = await p(dirs, '/memory backup');
    assert.equal(run.code, 0, run.stdout + run.stderr.slice(-2000));
    const made = backupsIn(join(dirs.root, 'b'));
    assert.equal(made.length, 1);
    assert.ok(run.stdout.includes(made[0] ?? '?'), 'the answer lists the backup');
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

test('/memory conversation prints a line of that conversation', async () => {
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

test('/memory lore add stores an entry that /memory lore list then names', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const added = await p(dirs, '/memory lore add Zetatower zetatower,spire The tower has seven floors');
    assert.equal(added.code, 0, added.stdout + added.stderr.slice(-2000));
    assert.ok((await p(dirs, '/memory lore list')).stdout.includes('Zetatower'));
  });
});

// Open point 1 of the brief: no operation lists the lessons today.
test('/memory lessons add stores a lesson that /memory lessons list then shows', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const added = await p(dirs, '/memory lessons add zeta71 is spelled with a z');
    assert.equal(added.code, 0, added.stdout + added.stderr.slice(-2000));
    assert.ok((await p(dirs, '/memory lessons list')).stdout.includes('zeta71 is spelled with a z'));
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
    const direct = await runCli(dirs, ['doctor', '--json']);
    const checks = doctorChecks(direct.stdout);
    const chat = await p(dirs, '/doctor');
    assert.equal(chat.code, direct.code);
    for (const name of checks.keys()) assert.ok(chat.stdout.includes(name), `the chat's doctor names ${name}`);
  });
});
