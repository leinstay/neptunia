// The command table through `neptunia -p` (bin/neptunia.ts) against the core with its interfaces as units
// (tests/fixtures/core-units.ts): every command answers, the owner's commands run with the owner's rights while
// `bot.owners` is empty, `/tools grant` and `/tools revoke` change the persona's grants and so the next request's tools, the
// files a command writes hold what it was given, and the exit code says whether the command ran. The tests assert on
// data they put in (a model id, a cost, a rule's text, a unit name), on exit codes and on files, never on wording.
// `fetch` is replaced by a recorder that refuses every call, so no command reaches a provider.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { chmodSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path, { join, dirname, relative } from 'node:path';
import { createConsole } from '../../../../src/interface/commands/console.ts';
import type { ConsoleDeps, Answer } from '../../../../src/interface/commands/console.ts';
import { COMMANDS, parseCommandLine } from '../../../../src/interface/commands/table.ts';
import { NOT_GRANTABLE_TO_PERSONA } from '../../../../src/tools/access.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { personaKey } from '../../../../src/memory/db/unit-keys.ts';
import { applyUnitUpdate } from '../../../fixtures/memory-db/unit-writes.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import {
  ANSWER,
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
  query,
} from '../../../fixtures/core-units.ts';
import type { Dirs, Rig, Settings } from '../../../fixtures/core-units.ts';
import { chainsOf } from '../../../fixtures/chains.ts';
import type { Dialog } from '../../../../src/keys/commands.ts';
import type { BindConfirm, BindInput, BindResult } from '../../../../src/memory/db/person-bind.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import { addAccount } from '../../../fixtures/memory-db/opaque-people.ts';
import { createKeysCommands } from '../../../../src/keys/commands.ts';
import { createKeyStore } from '../../../../src/keys/store.ts';
import {
  BASE_URL,
  chainRing,
  everyKeyChains,
  fakeFetch,
  fakePause,
  scriptedDialog,
} from '../../../fixtures/keys-rig.ts';
import { createCommandDesk } from '../../../../src/interface/neptunia-cli.ts';
import { parseRequest } from '../../../../bin/neptunia-request.ts';
import { createInnerLife } from '../../../../src/behavior/inner.ts';
import { createEventDoor } from '../../../../src/interface/door.ts';
import { createIntentionService } from '../../../../src/intentions/service.ts';
import { createIntentionStores } from '../../../../src/intentions/store.ts';
import { wakeClockOf, serviceFamily } from '../../../../src/service/commands.ts';
import type { BackendResult } from '../../../../src/agent-runner/backend.ts';
import { actualTableNames, countOf, databaseDigest } from '../../../fixtures/memory-db/browser-world.ts';
import { fakeVendor } from '../../../fixtures/fake-vendor.ts';
import { readKeysFile, writeKeysFile } from '../../../fixtures/keys-file.ts';
import { openTestMemory } from '../../../fixtures/memory-db/service.ts';
import type { TestMemory } from '../../../fixtures/memory-db/service.ts';
import { ALEX, DM_ALEX, addSource, semanticWorld } from '../../../fixtures/memory-db/semantic-world.ts';
import { useIface, world as turnWorld } from '../../../fixtures/turn-world.ts';
import { readClaudeUsage } from '../../../../src/subharness/usage/claude.ts';
import type { BackendUsage, UsageMetric } from '../../../../src/subharness/usage.ts';
import type { EnableDeps } from '../../../../src/subharness/control.ts';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../../../../src/config.ts';
import { localConfigPath } from '../../../../src/config/files.ts';
import type { Parsed } from '../../../../src/interface/commands/table.ts';
import type { RunManager } from '../../../../src/service/manager.ts';
import { roleSources } from '../../../../src/subharness/model-capabilities.ts';
import type { RoleSources, SourceDescriptor } from '../../../../src/subharness/model-capabilities.ts';
import { subharnessPlace } from '../../../../src/subharness/place.ts';
import type { KeysFile } from '../../../fixtures/keys-file.ts';
import type { Call as CapabilitiesCall, Reply } from '../../../fixtures/keys-rig.ts';
import { ownerNamesOf, personDetail } from '../../../../src/memory/db/people-read.ts';
import type { Db } from '../../../../src/memory/db/types.ts';
import { internalContext } from '../../../../src/memory/db/scope.ts';
import { withIface } from '../../../../src/memory/db/current-iface.ts';
import { isOwnerId } from '../../../../src/tools/operations/grants.ts';
import { recordCoreCheck } from '../../../../src/setup/model-check.ts';
import type { ReadinessHealth } from '../../../../src/setup/readiness.ts';
import type { EffortLevel } from '../../../../src/llm/roles.ts';
import { subharnessCommand } from '../../../../src/interface/commands/subharness.ts';

const T0 = Date.parse('2026-10-31T12:00:00Z');

/** The commands of the table, as `/help` must list them. */
const TABLE = [
  'status',
  'doctor',
  'logs',
  // `services` holds the scheduled mechanisms.
  'services',
  'usage',
  'errands',
  // The owner's list of the agents on disk.
  'agents',
  'intentions',
  'pause',
  // The engine proxy's commands.
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
  // `/agent` holds the execution mode.
  'agent',
  // `/search` holds quick search's targeted settings.
  'search',
  // `/humanizer` switches the humanizer and shows its two roles.
  'humanizer',
  // `/mirror` is the owner's family over the diary's mirrors.
  'mirror',
  // The owner's `/mnemonic` shows and switches the language of the phrase-code word list.
  'mnemonic',
  'help',
  'clear',
];

/** The persona's own id on the fake interface (tests/fixtures/interfaces/fake/index.ts). */
const SELF_ID = 'self-id';

const p = (dirs: Dirs, line: string): ReturnType<typeof runCli> => runCli(dirs, ['-p', line]);

/** The private layer's config.local.json as it is on disk. */
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
  const options2 = rig.llm.options;
  const options = options2[index];
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
  applyUnitUpdate(seed, {
    op: 'value',
    key: personaKey('usage'),
    value: { v: 1, days: { [today]: { vision: row(3, 0.4321), analyzer: row(2, 0.0123) } } },
  });
  seed.close();
}

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
      // The reads of lore are place-qualified.
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

test('-p exits 2 for a line the table refuses', async () => {
  // A line the command table refuses is bad syntax, which exits 2 by the CLI's return codes; 1 is an operational failure.
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    // `/mirror` is a table command, so a word no command has stands for the refused line.
    for (const line of ['/memory', '/usage 90d', '/doctor disks', '/nosuchcommand list']) {
      const run = await p(dirs, line);
      assert.equal(run.code, 2, line);
      assert.notEqual(run.stderr.trim(), '', `${line}: the reason is on stderr`);
    }
  });
});

// The status holds sections of text: the models of every role and today's costs per role.
test('/status full holds the models of every role and the costs of the day, and /status only the summary', async () => {
  const config = { models: { routes: chainsOf({ core: 'zeta/core-71', drawing: 'zeta/draw-72' }) } };
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

test('/tools grant web.search opens the tool to the persona, and the next request carries it', async () => {
  await withRig({}, async (rig) => {
    const { dirs, llm, cores, units } = rig;
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const unit = await startedUnit(dirs);
    units.push(unit);
    const run = await p(dirs, '/tools grant web.search');
    assert.equal(run.code, 0, run.stdout + run.stderr.slice(-2000));
    assert.deepEqual(grantedUsers(dirs, 'web.search'), [SELF_ID], "the grant, by the persona's own id");
    assert.equal(await (await unit.emit(mention('m1', 'hello bot'))).acked, 'ok');
    await until(() => llm.requests.length >= 1, 'the turn after the grant');
    assert.ok(toolsOf(rig, 0).includes('web_search'), `the tools: ${toolsOf(rig, 0).join(', ')}`);
  });
});

test('/tools revoke web.search closes the tool again, and the next request lacks it', async () => {
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

// A grant is the persona's alone, so `/tools grant` takes no target.
test('/tools grant with a user target is refused and grants nobody', async () => {
  await withRig({}, async ({ dirs, llm, cores, units }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    units.push(await startedUnit(dirs));
    const run = await p(dirs, '/tools grant memory.profile.read user u-77');
    assert.notEqual(run.code, 0, run.stdout + run.stderr.slice(-2000));
    assert.deepEqual(grantedUsers(dirs, 'memory.profile.read'), []);
  });
});

test('/tools grant fails and writes nothing while no interface has said who the persona is', async () => {
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

test('/memory conversation prints a line of that chat and names the persona on their own line', async () => {
  // Bug: the persona's lines took the name of `bot.name`, which is no setting, so each read as `?: <text>`. The fake
  // interface's `hello` names the persona `Nova`.
  await withRig({}, async ({ dirs, llm, cores, units }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const unit = await startedUnit(dirs);
    units.push(unit);
    assert.equal(await (await unit.emit(mention('m1', 'the tower zeta71 has seven floors'))).acked, 'ok');
    await postedOnce(unit, 1);
    const run = await p(dirs, '/memory conversation c1');
    assert.equal(run.code, 0, run.stdout + run.stderr.slice(-2000));
    assert.ok(run.stdout.includes('the tower zeta71 has seven floors'));
    const own = run.stdout.split('\n').find((line) => line.endsWith(ANSWER));
    assert.equal(own, `Nova: ${ANSWER}`, run.stdout);
  });
});

// The operations of lore are place-qualified.
test('/memory places lore add stores an entry that /memory places lore list then names', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const added = await p(dirs, '/memory places lore add g1 Zetatower zetatower,spire The tower has seven floors');
    assert.equal(added.code, 0, added.stdout + added.stderr.slice(-2000));
    assert.ok((await p(dirs, '/memory places lore list g1')).stdout.includes('Zetatower'));
  });
});

// Open point 1 of the brief: no operation lists the lessons today.
// The list alone, since the memory session writes the lessons.
test('/memory lessons list answers for a place with no lesson', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const listed = await p(dirs, '/memory lessons list --place g1');
    assert.equal(listed.code, 0, listed.stdout + listed.stderr.slice(-2000));
    assert.ok(listed.stdout.includes('(none)'), listed.stdout);
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

// The turn hands the client the interface of its event, which the usage line then carries.
test('a turn of a line typed in the chat calls the model with the cli interface', async () => {
  await withRig({}, async ({ dirs, llm, cores, clis }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const chat = spawnCli(dirs, []);
    clis.push(chat);
    chat.type('hello from the console');
    await until(
      () => llm.requests.length >= 1,
      () => `the turn; stderr:\n${chat.stderr().slice(-2000)}`
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

// ---- the owner's operations ---------------------------------------------------------------------------------------

/** Every line of the table with its required arguments filled: a choice by its first value, anything else by `1`. */
function everyLine(): Array<string> {
  // The role of `/model set` and `/model sources` has no choice list, since the agents on disk are roles too, so
  // its word is the first model role.
  const filled = (
    args: ReadonlyArray<{ name: string; required: boolean; choices?: ReadonlyArray<string> }>
  ): Array<string> =>
    args.filter((one) => one.required).map((one) => one.choices?.[0] ?? (one.name === 'role' ? 'core' : '1'));
  return COMMANDS.flatMap((command) => {
    const subs = command.subcommands;
    if (subs.length === 0) return [['/' + command.name, ...filled(command.args)].join(' ')];
    return subs.map((one) => ['/' + command.name, ...one.name.split('.'), ...filled(one.args)].join(' '));
  });
}

// The operations no grant opens to the persona (src/tools/access.ts#NOT_GRANTABLE_TO_PERSONA) have no way to run but
// a command of the chat: the persona cannot run them for the owner. `/doctor` with its scopes and `/logs` run no operation and
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
  // The text is a rule's.
  const parsed = parseCommandLine('/rules add one -- two --place place:a');
  assert.ok(parsed.ok);
  assert.equal(parsed.args.place, 'place:a');
  assert.equal(parsed.args.text, 'one -- two');
});

test('every operation no grant opens to the persona runs from a command of the chat', async () => {
  const ran = new Set<string>();
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
    // No line moves a timer, but a status asks the manager; this keeps it fake.
    serviceManager: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }),
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
});

// `/memory bind <iface> <account> <person>` from the owner's line to the memory service: the console names the account by its interface and platform id, names `owner` by `bot.ownerPerson`, and
// before a merge asks one Y/n through the dialog that names the person it removes. A synthetic database and a recording
// memory service. The bind itself is tested in tests/src/memory/db/person-bind.test.ts.

const OWNER = 'person:0a1b-owner';
const REMOVED = { id: 'person:3c9d-other', name: 'Dima' };
const INTO = { id: 'person:7a1e-target', name: 'Mira' };

type Bind = { input: BindInput; confirmed: boolean | null };
type MemoryBindRig = {
  binds: Array<Bind>;
  asked: Array<string>;
  say: (line: string, answer: string | null) => Promise<Answer>;
};

/** A console over a database holding one account, with a service that asks its confirmation when it is given one. */
async function withConsole(body: (rig: MemoryBindRig) => Promise<void>): Promise<void> {
  const dir = tempDir('nep-commands-bind-');
  const handle = openMemoryDb(path.join(dir, 'memory.db'));
  addAccount(dbOf(handle), {
    id: 'account:t1',
    iface: 'telegram',
    authority: 'telegram/global',
    native: 't1',
    person: null,
  });
  const binds: Array<Bind> = [];
  const asked: Array<string> = [];
  const memoryDb = {
    database: () => dbOf(handle),
    personBind: async (input: BindInput, confirm: BindConfirm | null): Promise<BindResult> => {
      const confirmed = confirm === null ? null : await confirm({ removed: REMOVED, into: INTO });
      binds.push({ input, confirmed });
      if (confirmed === null) return { status: 'unconfirmed', removed: REMOVED.id };
      return confirmed
        ? { status: 'merged', person: input.personId, removed: REMOVED.id }
        : { status: 'declined', removed: REMOVED.id };
    },
  };
  const deps: ConsoleDeps = {
    runOp: () => Promise.resolve({ status: 'failed', code: 'NOT_HERE', summary: '', data: null }),
    ownerReads: { lessons: () => '' },
    places: () => [],
    selfId: () => null,
    hot: { config: { bot: { ownerPerson: OWNER } } },
    privateDir: dir,
    dataDir: dir,
    memoryDb,
    usage: null,
    metrics: { samples: () => [] },
    chatLines: () => [],
    now: () => Date.parse('2026-11-08T12:00:00Z'),
  };
  const desk = createConsole(deps);
  const say = (line: string, answer: string | null): Promise<Answer> => {
    const parsed = parseCommandLine(line);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
    const dialog: Dialog | null =
      answer === null
        ? null
        : {
            ask: (question) => {
              asked.push(question);
              return Promise.resolve(answer);
            },
          };
    return desk.run(parsed.name, parsed.args, { id: 'owner' }, dialog);
  };
  try {
    await body({ binds, asked, say });
  } finally {
    handle.close();
  }
}

test('a merge asks one Y/n that names the id and the name of the person it removes', async () => {
  // Bug: the question names only the target, or no question is asked and two people merge on the command alone.
  await withConsole(async ({ binds, asked, say }) => {
    const answer = await say(`/memory bind telegram t1 ${INTO.id}`, '');
    assert.equal(asked.length, 1);
    assert.ok(asked[0]?.includes(REMOVED.id) && asked[0]?.includes(REMOVED.name), asked[0]);
    assert.ok(asked[0]?.includes('Y/n'), asked[0]);
    assert.deepEqual(binds, [{ input: { accountId: 'account:t1', personId: INTO.id }, confirmed: true }]);
    assert.equal(answer.status, 'ok');
  });
});

test('an answer n declines the merge', async () => {
  // Bug: any answer counts as yes, so the owner cannot step back from a merge they did not mean.
  await withConsole(async ({ binds, say }) => {
    const answer = await say(`/memory bind telegram t1 ${INTO.id}`, 'n');
    assert.equal(binds[0]?.confirmed, false);
    assert.equal(answer.status, 'ok');
    assert.ok(answer.text.includes(REMOVED.id), answer.text);
  });
});

test('owner as the target names the meta-person of bot.ownerPerson', async () => {
  // Bug: the word `owner` is sent as a person id, or the account's own person is made the owner instead.
  await withConsole(async ({ binds, say }) => {
    await say('/memory bind telegram t1 owner', 'y');
    const [first] = binds;
    assert.equal(first?.input.personId, OWNER);
  });
});

test('a merge with no dialog is refused and says to run it in the chat', async () => {
  // Bug: `neptunia -p` merges two people with nobody asked.
  await withConsole(async ({ binds, say }) => {
    const answer = await say(`/memory bind telegram t1 ${INTO.id}`, null);
    assert.equal(binds[0]?.confirmed, null);
    assert.equal(answer.status, 'invalid');
  });
});

test('an account the persona has not met is refused before the service is asked', async () => {
  // Bug: a typo in the platform id creates a bind for an account nobody stored.
  await withConsole(async ({ binds, say }) => {
    const answer = await say(`/memory bind telegram nobody ${INTO.id}`, 'y');
    assert.equal(answer.status, 'invalid');
    assert.deepEqual(binds, []);
  });
});

// `/mnemonic` (src/interface/commands/table.ts, console.ts): the owner's command that shows the language of the
// phrase-code word list and switches it through `config.set` of `bot.mnemonic`. A recording `runOp` and a synthetic
// config only.

type Call = { op: string; args: Record<string, unknown>; context: Record<string, unknown> };

function deskOf(mnemonic: unknown): { run: ReturnType<typeof createConsole>['run']; calls: Array<Call> } {
  const calls: Array<Call> = [];
  const dir = tempDir('nep-mnemonic-');
  const deps: ConsoleDeps = {
    runOp: (op, args, context) => {
      calls.push({ op, args, context });
      return Promise.resolve({ status: 'ok', code: '', summary: 'set', data: null });
    },
    ownerReads: { lessons: () => '' },
    places: () => [],
    selfId: () => 'self-1',
    hot: { config: { bot: { mnemonic } } },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => Date.parse('2026-11-09T12:00:00Z'),
    serviceManager: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }),
  };
  const desk = createConsole(deps);
  return { run: (...given) => desk.run(...given), calls };
}

test('parses /mnemonic with no language, en or ru, and refuses another language', () => {
  assert.deepEqual(parseCommandLine('/mnemonic'), { ok: true, name: 'mnemonic', args: {} });
  assert.deepEqual(parseCommandLine('/mnemonic ru'), { ok: true, name: 'mnemonic', args: { language: 'ru' } });
  assert.equal(parseCommandLine('/mnemonic en').ok, true);
  assert.equal(parseCommandLine('/mnemonic de').ok, false);
});

test('shows the language the setting holds and changes nothing', async () => {
  const { run, calls } = deskOf('ru');
  const answer = await run('mnemonic', {}, { id: 'owner-1' });
  assert.equal(answer.status, 'ok');
  assert.match(answer.text, /ru/);
  assert.deepEqual(calls, []);
});

test('shows en while the setting holds no language', async () => {
  const { run } = deskOf(undefined);
  const answer = await run('mnemonic', {}, { id: 'owner-1' });
  assert.match(answer.text, /en/);
});

test('switches the language through config.set of bot.mnemonic as the owner', async () => {
  const { run, calls } = deskOf('en');
  const answer = await run('mnemonic', { language: 'ru' }, { id: 'owner-1' });
  assert.equal(answer.status, 'ok');
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call?.op, 'config.set');
  assert.deepEqual(call?.args, { path: 'bot.mnemonic', value: 'ru' });
  assert.equal(call?.context.asOwner, true);
});

test('reports a switch that config.set refused', async () => {
  const desk = createConsole({
    runOp: () => Promise.resolve({ status: 'failed', code: 'x', summary: 'could not write', data: null }),
    ownerReads: { lessons: () => '' },
    places: () => [],
    selfId: () => 'self-1',
    hot: { config: { bot: { mnemonic: 'en' } } },
    privateDir: tempDir('nep-mnemonic-'),
    dataDir: tempDir('nep-mnemonic-'),
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => 0,
    serviceManager: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }),
  });
  const answer = await desk.run('mnemonic', { language: 'ru' }, { id: 'owner-1' });
  assert.equal(answer.status, 'failed');
});

// Tests for the route of `keys.service.*` through the console (src/interface/commands/console.ts) with the real key
// commands (src/keys/commands.ts) behind `deps.keys`, as the engine builds it while keys.json is in use. The service
// commands are answered by src/keys/services.ts, not by the key commands, so the console must not hand them over.

const EXA_VALUE = 'exa-SECRETVALUE-0001-WXYZ';

function rig() {
  const dir = tempDir('console-keys-service-');
  const store = createKeyStore({ privateDir: dir });
  // Every role runs on its chain; here every role's chain names every key of the store.
  const chainOf = everyKeyChains(store, (role) => `current/${role}`);
  const ring = chainRing(store, chainOf);
  const keys = createKeysCommands({
    store,
    ring,
    chainOf,
    saveRoutes: () => Promise.resolve(),
    fetch: fakeFetch().fetch,
    baseUrl: () => BASE_URL,
    defaults: {},
    currentModel: () => '',
    pause: fakePause(),
  });
  const deps: ConsoleDeps = {
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
    keys: { enabled: () => true, run: (name, args, dialog) => keys.run(name, args, dialog) },
  };
  return { console_: createConsole(deps), file: path.join(dir, 'keys.json') };
}

const owner = { id: 'owner' };

test('keys service list answers ok with the service list while the key store is in use', async () => {
  // Bug: the console hands every `keys.` name to the key commands, which answer "no such command" for the service ones.
  const { console_ } = rig();
  const answer = await console_.run('keys.service.list', {}, owner, null);
  assert.equal(answer.status, 'ok');
  assert.match(answer.text, /exa: not set/);
});

test('keys service set writes the secret asked in the dialog under services and never echoes it', async () => {
  // Bug: the same route swallows `keys.service.set`, so the value is never asked and nothing is written.
  const { console_, file } = rig();
  const { dialog, asked } = scriptedDialog([EXA_VALUE]);
  const answer = await console_.run('keys.service.set', { name: 'exa' }, owner, dialog);
  assert.equal(answer.status, 'ok');
  assert.equal(asked[0]?.secret, true);
  assert.equal(answer.text.includes(EXA_VALUE), false);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { services?: Record<string, string> };
  assert.equal(stored.services?.exa, EXA_VALUE);
});

// Tests for the console's routing of the key commands (src/interface/commands/console.ts): `keys.*` always goes to the key
// commands with the dialog the caller gave, and `model.set` goes there only while the core takes its keys from the key
// store; before that it is the plain `model.set` operation, so a deployment on `.env` keeps its `/model set`.

function consoleKeysRig(enabled: boolean) {
  const dir = tempDir('console-keys-');
  const ops: Array<[string, Record<string, unknown>]> = [];
  const routed: Array<{ name: string; dialog: unknown }> = [];
  const deps: ConsoleDeps = {
    runOp: (op, args) => {
      ops.push([op, args]);
      return Promise.resolve({ status: 'ok', code: '', summary: 'done', data: null });
    },
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
    keys: {
      enabled: () => enabled,
      run: (name, _args, dialog) => {
        routed.push({ name, dialog });
        return Promise.resolve({ text: 'keys answered', status: 'ok' });
      },
    },
  };
  return { console_: createConsole(deps), ops, routed };
}
const dialog = { ask: () => Promise.resolve('') };

test('a keys command reaches the key commands with the dialog it was given, whether or not the store is in use', async () => {
  for (const enabled of [false, true]) {
    const { console_, routed, ops } = consoleKeysRig(enabled);
    const answer = await console_.run('keys.add', { name: 'core-1' }, owner, dialog);
    assert.equal(answer.text, 'keys answered');
    // Bug caught: the dialog dropped on the way, so the key value could never be asked.
    assert.deepEqual(routed, [{ name: 'keys.add', dialog }]);
    assert.deepEqual(ops, []);
  }
});

// One synthetic owner journey through both spellings of the command line, over the real console, the real
// memory service and a database the one writer filled. The owner's argv (`neptunia memory users show ...`, parsed by
// bin/neptunia-request.ts) and the chat's line (`/memory users show ...`, parsed by the table) reach the same desk, so a
// step runs once on each path and the two answers are the same text with the same status. The journey chooses a model
// whose check is a fake backend run, inspects one person and the DM of that person, runs a heartbeat on a real inner
// life over a fake turn runner and reads its clock back through `services`, reads the memory and exports it. No model is
// asked outside the one fake check, no request leaves the process, and the export reconciles with the database.
// Synthetic content only.

describe('one owner journey on argv and on the chat', () => {
  useIface('fake');

  const BOUNDS = { pageRows: 25, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300, maxSnapshots: 8 };
  const PRIVATE_LINE = 'zinnia-private: the garden plan is between us';
  const PUBLIC_LINE = 'zinnia-public: the room agreed on the garden plan';
  const START = Date.parse('2026-11-05T05:00:00Z');
  const HOUR = 3_600_000;
  const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

  type Journey = {
    memory: TestMemory;
    dir: string;
    checks: Array<{ model: string | undefined }>;
    fetched: Array<string>;
    clock: { t: number };
    life: ReturnType<typeof createInnerLife>;
    config: Record<string, unknown>;
    /** The owner's argv words, parsed as `neptunia <words>` and run on the desk. */
    argv(...words: Array<string>): Promise<Answer>;
    /** The chat's line, parsed by the table and run on the same desk. */
    chat(line: string): Promise<Answer>;
  };

  let journey: Journey;

  before(async () => {
    const worldOfMemory = semanticWorld();
    addSource(worldOfMemory, 'public', PUBLIC_LINE);
    addSource(worldOfMemory, 'alex', PRIVATE_LINE);
    worldOfMemory.handle.close();
    const dir = dirname(worldOfMemory.file);
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeKeysFile(dir, { subharness: { key: null, modes: {}, backends: ['claude'] } });
    fakeVendor(dir, 'claude', { loggedIn: true });
    const memory = await openTestMemory({ dataDir: dir, config: { memoryDb: { inspection: BOUNDS } } });

    // A heartbeat on a real inner life: the turn runner is a fake that skips, so the wake is handled and nothing is sent.
    const clock = { t: START };
    const config = {
      bot: { timezone: 'UTC', owners: [], placeId: 'g1' },
      features: { wakes: true, intentions: true, journal: true },
      mention: { oneAtATime: true },
      wakes: { mode: 'shadow', tickSeconds: 60, review: { enabled: false, historyDays: 14 }, caps: { perChain: 3 } },
      heartbeat: { enabled: true, schedule: 'every 4h', jitterMinutes: 0 },
      memoryDb: { inspection: BOUNDS },
    };
    const hot = { config, prompts: {} };
    turnWorld().channel({ id: 'c1', name: 'chan-c1', placeId: 'g1', permissions: { send: true } });
    const service = createIntentionService({
      stores: createIntentionStores({ dataDir: tempDir('nep-journey-'), now: () => clock.t, log: SILENT }),
      hot,
      now: () => clock.t,
      log: SILENT,
    });
    let life: ReturnType<typeof createInnerLife> | null = null;
    const door = createEventDoor({ handlers: { 'inner.wake': (event: object) => life?.onWake(event) }, log: SILENT });
    life = createInnerLife({
      hot,
      dataDir: tempDir('nep-journey-inner-'),
      turns: {
        isAnyBusy: () => false,
        runTurn: () =>
          Promise.resolve({ outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], turnId: 't-1' } }),
      },
      intentions: service,
      journal: { inner: () => Promise.resolve(), read: () => [] },
      reads: turnWorld().reads,
      iface: () => 'fake',
      chatName: (id: string) => `chan-${id}`,
      submit: (event: object) => door.submit(event),
      store: { state: { data: {} } },
      meter: { run: async (fn: () => unknown) => ({ result: await fn(), usd: 0, requests: 1, voice: 0 }) },
      rng: () => 0.5,
      now: () => clock.t,
      log: SILENT,
    });

    const checks: Journey['checks'] = [];
    const fetched: Array<string> = [];
    const provider = fakeFetch();
    const desk = createConsole({
      runOp: () => Promise.resolve({ status: 'failed', code: 'NOT_FOR_THIS_JOURNEY', summary: '', data: null }),
      ownerReads: { lessons: () => '' },
      places: () => ['g1'],
      selfId: () => null,
      hot: { config, prompts: {} },
      privateDir: dir,
      dataDir: memory.dataDir,
      memoryDb: memory.memoryDb,
      usage: null,
      metrics: { samples: () => [] },
      chatLines: () => [],
      now: () => clock.t,
      serviceManager: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }),
      wakeClock: (name) =>
        wakeClockOf(name, {
          now: clock.t,
          inner: life,
          diary: { status: () => ({ slots: [], done: [] }) },
        }),
      subharness: {
        runBackend: (_name, _brief, model): Promise<BackendResult> => {
          checks.push({ model });
          return Promise.resolve({ ok: true, text: 'ok', exitCode: 0 });
        },
        fetch: provider.fetch,
        applyMode: () => Promise.resolve('the unit took it'),
      },
    });
    const run = async (command: { name: string; args: Record<string, unknown> }): Promise<Answer> => {
      const real = globalThis.fetch;
      globalThis.fetch = (input) => {
        fetched.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        return Promise.reject(new Error('the journey reached the network'));
      };
      try {
        return await desk.run(command.name, command.args, { id: 'owner' });
      } finally {
        globalThis.fetch = real;
      }
    };
    journey = {
      memory,
      dir,
      checks,
      fetched,
      clock,
      life,
      config,
      argv: (...words) => {
        const parsed = parseRequest(words).parsed;
        assert.ok(parsed.ok, parsed.ok ? '' : `${words.join(' ')}: ${parsed.reason}`);
        return run(parsed);
      },
      chat: (line) => {
        const parsed = parseCommandLine(line);
        assert.ok(parsed.ok, parsed.ok ? '' : `${line}: ${parsed.reason}`);
        return run(parsed);
      },
    };
  });

  after(async () => {
    await journey?.memory.close();
  });

  const same = (one: Answer, two: Answer): void => {
    assert.equal(one.status, 'ok', one.text.slice(0, 300));
    assert.equal(two.status, 'ok', two.text.slice(0, 300));
    assert.equal(two.text, one.text);
  };

  test('a model chosen on argv and another on the chat are each checked once, saved, and read the same on both paths', async () => {
    // The routes are named direct-api, claude-harness, codex-harness and opencode-harness.
    // Bug: one spelling saves a choice the check never ran, or `model show` answers differently on the two paths.
    const first = await journey.argv('model', 'set', 'server', 'sonnet', '--via', 'claude-harness');
    assert.equal(first.status, 'ok', first.text);
    const second = await journey.chat('/model set scout haiku --via claude-harness');
    assert.equal(second.status, 'ok', second.text);
    assert.deepEqual(
      journey.checks.map((one) => one.model),
      ['sonnet', 'haiku']
    );
    const stored = readKeysFile(journey.dir).subharness;
    assert.deepEqual([stored.uses?.server, stored.models?.server], ['claude', 'sonnet']);
    assert.deepEqual([stored.uses?.scout, stored.models?.scout], ['claude', 'haiku']);
    const sources = await journey.argv('model', 'sources', 'server');
    same(sources, await journey.chat('/model sources server'));
  });

  test('the same person is the same answer on argv and on the chat', async () => {
    // Bug: the two parsers hand the handler different arguments, so one spelling shows another record.
    const argv = await journey.argv('memory', 'users', 'show', ALEX);
    same(argv, await journey.chat(`/memory users show ${ALEX}`));
    assert.ok(argv.text.includes(ALEX), 'the answer names the person');
  });

  test('the same DM is the same answer on both paths, and its private line is the DM source alone', async () => {
    // Bug: a DM read on one path drops its audience, so the private line reaches the other as a public record.
    same(await journey.argv('memory', 'users', 'private', ALEX), await journey.chat(`/memory users private ${ALEX}`));
    same(await journey.argv('memory', 'places', 'show', DM_ALEX), await journey.chat(`/memory places show ${DM_ALEX}`));
    const dmSource = await journey.argv('memory', 'sources', 'show', 'src:2');
    same(dmSource, await journey.chat('/memory sources show src:2'));
    assert.ok(dmSource.text.includes(PRIVATE_LINE), 'the DM source shows its private line');
    const publicSource = await journey.argv('memory', 'sources', 'show', 'src:1');
    assert.equal(publicSource.text.includes(PRIVATE_LINE), false);
  });

  test('a heartbeat runs on the inner life and both paths read its clock the same', async () => {
    // Bug: the status reads another field of the wake state than the run wrote, or one path shows a stale clock.
    await journey.life.tick();
    const before = await journey.argv('services', 'heartbeat', 'status');
    same(before, await journey.chat('/services heartbeat status'));
    assert.deepEqual(Object.keys(journey.life.state()?.handled ?? {}), []);
    journey.clock.t = START + 4 * HOUR + 60_000;
    await journey.life.tick();
    await journey.life.tick();
    const handled = Object.keys(journey.life.state()?.handled ?? {}).filter((id) => id.includes('heartbeat'));
    assert.equal(handled.length, 1, 'the heartbeat wake was handled once');
    const after = await journey.argv('services', 'heartbeat', 'status');
    same(after, await journey.chat('/services heartbeat status'));
    assert.notEqual(after.text, before.text, 'the status moved with the run');
    assert.ok(after.text.includes(new Date(journey.clock.t).toISOString().slice(0, 16)), after.text);
  });

  test('the memory export is the same row counts on both paths and reconciles with the database', async () => {
    // Bug: the export is short of a table the browser lists, or the two spellings write different files.
    const files = [join(journey.dir, 'argv.jsonl'), join(journey.dir, 'chat.jsonl')];
    const argv = await journey.argv('memory', 'inspect', 'export', files[0] ?? '');
    const chat = await journey.chat(`/memory inspect export ${files[1]}`);
    assert.equal(argv.status, 'ok', argv.text);
    assert.equal(chat.status, 'ok', chat.text);
    const manifests = [argv, chat].map(
      (one) => (JSON.parse(one.text) as { manifest: { rows: Record<string, number> } }).manifest.rows
    );
    assert.deepEqual(manifests[1], manifests[0]);
    // The memory service is named so the chain stays under the code-health depth (tests by the lead).
    const { memoryDb } = journey.memory;
    const db = memoryDb.database();
    assert.ok(db);
    assert.deepEqual(
      manifests[0],
      Object.fromEntries(actualTableNames(db).map((table) => [table, countOf(db, table)]))
    );
    const exported = readFileSync(files[0] ?? '', 'utf8')
      .split('\n')
      .filter((line) => line !== '');
    const rows = exported.filter((line) => (JSON.parse(line) as { kind: string }).kind === 'row');
    assert.equal(
      rows.length,
      Object.values(manifests[0] ?? {}).reduce((sum, n) => sum + n, 0)
    );
  });

  test('no step reached the network or asked a model beyond the two fake checks', () => {
    // Bug: a read command starts a provider request or a backend run the owner never asked for.
    assert.deepEqual(journey.fetched, []);
    assert.equal(journey.checks.length, 2);
  });
});

// What the owner's commands refuse or report, each with its own code and each leaving the world as it was. A non-owner
// principal is refused at the desk. A closed memory database answers its code. An expired snapshot cursor and a stale
// model selection are refused. A model check that fails is reported with its reason, and native usage that cannot be
// read automatically is stated with the hand-off. In every case no model request goes out (the provider is a fetch
// that fails the test, and a backend run is counted), the memory database holds the same rows, and no key file moved
// but by the one choice a test makes on purpose. Synthetic content only.
describe('the refusals of the owner commands', () => {
  const T0 = Date.parse('2026-11-05T12:00:00.000Z');
  const BOUNDS = { pageRows: 25, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300, maxSnapshots: 8 };
  const OWNER = { id: 'owner' };

  const memories: Array<TestMemory> = [];
  after(async () => {
    for (const memory of memories) await memory.close();
  });

  /** The provider and the network as a test sees them: every request is recorded and fails. */
  function noNetwork() {
    const reached: Array<string> = [];
    const real = globalThis.fetch;
    globalThis.fetch = (input) => {
      reached.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return Promise.reject(new Error('the test reached the network'));
    };
    return { reached, restore: () => void (globalThis.fetch = real) };
  }

  type Rig = {
    memory: TestMemory;
    dir: string;
    clock: { at: number };
    checks: Array<{ model: string | undefined }>;
    run(line: string): Promise<Answer>;
    say(...words: Array<string>): Promise<Answer>;
    desk: ReturnType<typeof createConsole>;
    deps: ConsoleDeps;
  };

  /**
   * The console over the real memory service and a key file, with a backend check that is counted. `check` answers the
   * check of a model, and `extra` adds dependencies of the test.
   */
  async function rig(
    check: (model: string | undefined) => BackendResult | Promise<BackendResult> = () => ({
      ok: true,
      text: 'ok',
      exitCode: 0,
    }),
    extra: Partial<ConsoleDeps> = {}
  ): Promise<Rig> {
    const world = semanticWorld();
    addSource(world, 'alex', 'quince-private: kept for the DM alone');
    world.handle.close();
    const dir = dirname(world.file);
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeKeysFile(dir, { subharness: { key: null, modes: {}, backends: ['claude', 'codex'] } });
    fakeVendor(dir, 'claude', { loggedIn: true });
    fakeVendor(dir, 'codex', { loggedIn: true });
    const clock = { at: T0 };
    const memory = await openTestMemory({
      dataDir: dir,
      config: { memoryDb: { inspection: BOUNDS } },
      now: () => clock.at,
    });
    memories.push(memory);
    const checks: Rig['checks'] = [];
    const deps: ConsoleDeps = {
      runOp: () => Promise.resolve({ status: 'failed', code: 'NOT_FOR_THIS_CASE', summary: '', data: null }),
      ownerReads: { lessons: () => '' },
      places: () => ['g1'],
      selfId: () => null,
      hot: { config: { bot: { owners: [] }, memoryDb: { inspection: BOUNDS } } },
      privateDir: dir,
      dataDir: memory.dataDir,
      memoryDb: memory.memoryDb,
      usage: {
        byRole: () => [],
        sumDays: () => ({
          rows: [],
          interfaces: [],
          total: { requests: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 0 },
          since: '2026-11-05',
          partial: false,
        }),
      },
      metrics: { samples: () => [] },
      chatLines: () => [],
      now: () => clock.at,
      subharness: {
        runBackend: (_name, _brief, model) => {
          checks.push({ model });
          return Promise.resolve(check(model));
        },
        fetch: fakeFetch().fetch,
        applyMode: () => Promise.resolve('the unit took it'),
      },
      ...extra,
    };
    const desk = createConsole(deps);
    const say = (...words: Array<string>): Promise<Answer> => {
      const parsed = parseRequest(words).parsed;
      assert.ok(parsed.ok, parsed.ok ? '' : `${words.join(' ')}: ${parsed.reason}`);
      return desk.run(parsed.name, parsed.args, OWNER);
    };
    return { memory, dir, clock, checks, desk, deps, say, run: (line) => say(...line.split(' ')) };
  }

  const fileHash = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
  const digestOf = (one: Rig) => {
    // The memory service is named so the chain stays under the code-health depth (tests by the lead).
    const { memoryDb } = one.memory;
    const db = memoryDb.database();
    assert.ok(db);
    return databaseDigest(db);
  };

  test('a principal that is not the owner is refused at the desk and nothing behind it runs', async () => {
    // Bug: a link that says hello as an interface reaches the owner's console, which reads and writes everything.
    const one = await rig();
    const before = digestOf(one);
    const network = noNetwork();
    const reached: Array<string> = [];
    const desk = createCommandDesk({
      console: {
        run: (name) => {
          reached.push(name);
          return Promise.resolve({ text: 'ran', status: 'ok', data: null });
        },
      },
      interfaces: {
        list: () => [],
        enable: () => undefined,
        disable: () => Promise.resolve({ drained: 0, unknown: 0 }),
      },
      facts: () => {
        throw new Error('a refused command reads no fact');
      },
    });
    try {
      for (const name of ['memory.users.list', 'memory.inspect.export', 'model.set', 'status']) {
        const answer = await desk.run(
          { name, args: {}, chat: { id: 'c1' }, requester: { id: 'u1', roles: [] } },
          { kind: 'interface', name: 'fake' }
        );
        assert.equal(answer.status, 'denied', name);
      }
    } finally {
      network.restore();
    }
    assert.deepEqual(reached, []);
    assert.deepEqual(network.reached, []);
    assert.deepEqual(digestOf(one), before);
  });

  test('a closed memory database answers its code, asks no model and leaves the file as it was', async () => {
    // Bug: a read on a closed core throws through the console, or reopens the database to answer.
    const one = await rig();
    const file = join(one.memory.dataDir, 'memory.db');
    await one.memory.close();
    const before = fileHash(file);
    const network = noNetwork();
    let answer: Answer;
    try {
      answer = await one.say('memory', 'users', 'list');
    } finally {
      network.restore();
    }
    assert.notEqual(answer.status, 'ok');
    assert.equal(answer.status, 'failed');
    assert.ok(answer.text.includes('closed'), answer.text);
    assert.ok(
      typeof answer.code === 'string' && answer.code !== '',
      `the refusal names no code: ${JSON.stringify(answer)}`
    );
    assert.deepEqual(network.reached, []);
    assert.deepEqual(one.checks, []);
    assert.equal(fileHash(file), before);
  });

  test('a snapshot page continued after its snapshot expired is refused with the expiry code', async () => {
    // Bug: an old cursor reads a later moment of the database and the owner takes it for the one they opened.
    const one = await rig();
    const first = await one.say('memory', 'inspect', 'rows', 'meta', '--limit', '1');
    assert.equal(first.status, 'ok', first.text);
    const page = JSON.parse(first.text) as { snapshot: string; next: string | null };
    assert.ok(page.next, 'the first page leaves a cursor');
    const before = digestOf(one);
    one.clock.at += (BOUNDS.snapshotIdleSeconds + 1) * 1000;
    const network = noNetwork();
    let expired: Answer;
    try {
      expired = await one.say(
        'memory',
        'inspect',
        'rows',
        'meta',
        '--snapshot',
        page.snapshot,
        '--limit',
        '1',
        '--cursor',
        page.next
      );
    } finally {
      network.restore();
    }
    assert.notEqual(expired.status, 'ok');
    assert.equal(expired.code, 'INSPECTION_EXPIRED');
    assert.deepEqual(network.reached, []);
    assert.deepEqual(digestOf(one), before);
  });

  test('a model check that finished after the owner chose again is refused as stale and saves nothing', async () => {
    // The routes are named direct-api, claude-harness, codex-harness and opencode-harness.
    // Bug: the slow check of the first choice is written last, so the owner's newer choice silently disappears.
    let release: (value: BackendResult) => void = () => undefined;
    const held = new Promise<BackendResult>((resolve) => {
      release = resolve;
    });
    // The second choice waits for the first check to have reached the backend, not for a fixed time: a wait of 20 ms
    // failed on a loaded CI runner (run 42483439891) when the first check had not started yet.
    let started: () => void = () => undefined;
    const slowStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const one = await rig((model) => {
      if (model !== 'slow') return { ok: true, text: 'ok', exitCode: 0 };
      started();
      return held;
    });
    const before = digestOf(one);
    const slow = one.say('model', 'set', 'server', 'slow', '--via', 'claude-harness');
    await slowStarted;
    const quick = await one.say('model', 'set', 'server', 'quick', '--via', 'codex-harness');
    assert.equal(quick.status, 'ok', quick.text);
    release({ ok: true, text: 'ok', exitCode: 0 });
    const stale = await slow;
    assert.notEqual(stale.status, 'ok');
    assert.equal(stale.code, 'selection-changed');
    const stored = readKeysFile(one.dir).subharness;
    assert.deepEqual([stored.uses?.server, stored.models?.server], ['codex', 'quick']);
    assert.deepEqual(
      one.checks.map((entry) => entry.model),
      ['slow', 'quick']
    );
    assert.deepEqual(digestOf(one), before);
  });

  test('a model check that fails is reported with the reason it gave and saves nothing', async () => {
    // The routes are named direct-api, claude-harness, codex-harness and opencode-harness.
    // Bug: "gave no reply" for a rejection, or a model saved on a backend that refused it.
    const one = await rig(() => ({ ok: false, text: '', exitCode: 1, detail: 'that model is not on this plan' }));
    const before = digestOf(one);
    // The rig writes its list of backends as every agent's `models.agents.via`, so the agent's source before the
    // refusal is the list's first backend, and the refusal must leave it as it was.
    const sourceBefore = readKeysFile(one.dir).subharness.uses?.server;
    const network = noNetwork();
    let answer: Answer;
    try {
      answer = await one.say('model', 'set', 'server', 'sonnet', '--via', 'claude-harness');
    } finally {
      network.restore();
    }
    assert.notEqual(answer.status, 'ok');
    assert.equal(answer.code, 'model-rejected');
    assert.ok(answer.text.includes('that model is not on this plan'), answer.text);
    const stored = readKeysFile(one.dir).subharness;
    assert.equal(stored.uses?.server, sourceBefore);
    assert.equal(stored.models?.server, undefined);
    assert.equal(one.checks.length, 1, 'the one check the owner asked for');
    assert.deepEqual(network.reached, []);
    assert.deepEqual(digestOf(one), before);
  });

  test('native usage that cannot be read automatically is stated with its hand-off and starts no run', async () => {
    // Bug: empty metrics read as an unused account, or the read spends a generated turn on the subscription.
    const privateDir = tempDir('nep-refusals-usage-');
    const vendor = fakeVendor(privateDir, 'claude', { loggedIn: true });
    const spawned: Array<ReadonlyArray<string>> = [];
    const read = (): Promise<ReadonlyArray<BackendUsage>> =>
      readClaudeUsage({
        privateDir,
        now: () => T0,
        spawn: (_binary, args) => {
          spawned.push(args);
          throw new Error('this test starts no child');
        },
      }).then((usage) => [usage]);
    const one = await rig(undefined, { backendUsage: read });
    const before = digestOf(one);
    const network = noNetwork();
    let answer: Answer;
    try {
      answer = await one.say('usage');
    } finally {
      network.restore();
    }
    assert.equal(answer.status, 'ok', answer.text);
    assert.ok(answer.text.includes('no automatic read for this source'), answer.text);
    assert.ok(answer.text.includes('by hand:'), answer.text);
    assert.deepEqual(spawned, []);
    for (const call of vendor.calls()) assert.ok(['auth status', '--version'].includes(call), call);
    assert.deepEqual(one.checks, []);
    assert.deepEqual(digestOf(one), before);
  });
});

const SUBHARNESS_SECRET = 'sk-or-v1-oc-secret-0123456789';

function subharnessRig() {
  const dir = tempDir('nep-cmd-sub-');
  writeKeysFile(dir, { extra: { opencode: SUBHARNESS_SECRET } });
  const deps: EnableDeps = {
    privateDir: dir,
    runBackend: () => Promise.resolve({ ok: true, text: 'ok', exitCode: 0 }),
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
  };
  return { dir, deps };
}

/** A console over fakes; `subharness` is the optional dep the commands need. */
function subharnessConsoleOver(dir: string, subharness: ConsoleDeps['subharness']) {
  const deps: ConsoleDeps = {
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: '', data: null }),
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
    now: () => 0,
    ...(subharness === undefined ? {} : { subharness }),
  };
  return createConsole(deps);
}

test('without the runner and fetch the console refuses a model selection and runs no model', async () => {
  // The routes are named direct-api, claude-harness, codex-harness and opencode-harness.
  // Bug: a console built without the check dependencies falls back to the real codex or the real network.
  // The selection is where a check runs.
  const { dir } = subharnessRig();
  const vendor = fakeVendor(dir, 'codex', { loggedIn: true });
  const desk = subharnessConsoleOver(dir, undefined);
  const answer = await desk.run(
    'model.set',
    { role: 'scout', model: 'gpt-6-sol', via: 'codex-harness' },
    { id: 'owner' }
  );
  assert.equal(answer.status, 'failed');
  assert.deepEqual(
    vendor.calls().filter((one) => one !== 'login status'),
    []
  );
  assert.equal(readKeysFile(dir).subharness.uses?.scout, undefined);
});

const NAMING_REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const NOW = Date.parse('2026-11-04T12:00:00Z');

type NamingAnswer = { text: string; status: string };

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
function namingFakeManager(calls: Array<string>): RunManager {
  return (command, args) => {
    calls.push([command, ...args].join(' '));
    if (args.includes('is-active')) return Promise.resolve({ code: 0, stdout: 'inactive\n', stderr: '' });
    if (args.includes('is-enabled')) return Promise.resolve({ code: 0, stdout: 'disabled\n', stderr: '' });
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
}

type NamingRig = {
  dir: string;
  calls: Array<string>;
  ops: Array<string>;
  fetched: Array<string>;
  /** One line through the table and the core's console, as the owner's chat does. */
  say(line: string): Promise<NamingAnswer>;
  /** One line through the table and the handler of the family with no core. */
  sayOffline(line: string): Promise<NamingAnswer>;
  /** One command by the name the console answers, as a client that sends it raw would. */
  raw(name: string, args?: Record<string, unknown>): Promise<NamingAnswer>;
};

/** A console over a temporary private layer holding `local`, and an open memory database unless `memory` is false. */
function namingRig(local: Record<string, unknown> | null = null, memory = true): NamingRig {
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
        return readConfig(NAMING_REPO, { privateDir: dir });
      },
    },
    privateDir: dir,
    dataDir: dir,
    memoryDb: { database: () => handle?.db ?? null },
    usage: null,
    metrics: { samples: () => [] },
    chatLines: () => [],
    now: () => NOW,
    serviceManager: namingFakeManager(calls),
  };
  const desk = createConsole(deps);
  const guarded = async (body: () => Promise<NamingAnswer>): Promise<NamingAnswer> => {
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
            rootDir: NAMING_REPO,
            privateDir: dir,
            dataDir: dir,
            config: () => readConfig(NAMING_REPO, { privateDir: dir }),
            now: () => NOW,
            env: { NEPTUNIA_UNIT_SCOPE: 'user', HOME: dir, XDG_CONFIG_HOME: join(dir, 'xdg') },
            run: namingFakeManager(calls),
            coreUp: false,
          },
          parsed.name,
          parsed.args
        );
      }),
    raw: (name, args = {}) => guarded(() => desk.run(name, args, { id: 'owner-1' })),
  };
}

// ---- /doctor scopes --------------------------------------------------------------------------------------------------

test('/doctor server, core and memory answer different reads, ask no model and write nothing', async () => {
  // Catches: the merged scopes answer the same text, reach the model probe, or move a setting.
  const r = namingRig();
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
  const r = namingRig(null, false);
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
  const live = namingRig();
  await live.say('/doctor live');
  assert.ok(live.ops.length > 0, 'live runs the probe operation');
  const plain = namingRig();
  await plain.say('/doctor core');
  assert.deepEqual(plain.ops, []);
});

// ---- /config check -------------------------------------------------------------------------------------------------

function desk(privateDir: string, config: Record<string, unknown>): ReturnType<typeof createConsole> {
  const deps: ConsoleDeps = {
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: 'done', data: null }),
    ownerReads: { lessons: () => '' },
    places: () => ['g1'],
    selfId: () => 'self-1',
    hot: { config },
    privateDir,
    dataDir: privateDir,
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => T0,
  };
  return createConsole(deps);
}

function localLayer(local: Record<string, unknown>): string {
  const dir = tempDir('nep-config-check-');
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', 'config.json'), JSON.stringify(local));
  return dir;
}

test('/config check names an unknown key and a key of the wrong type, and fails', async () => {
  const local = { llm: { maxRequestsPerDay: 'many' }, nosuch: { key: 1 } };
  const answer = await desk(localLayer(local), local).run('config.check', {}, { id: 'owner-1' });
  assert.equal(answer.status, 'failed');
  assert.ok(answer.text.includes('llm.maxRequestsPerDay'), answer.text);
  assert.ok(answer.text.includes('nosuch'), answer.text);
});

test('/config check names a chain and a provider route of a model role that does not exist, and fails', async () => {
  // Catches: a chain under the retired role `humanizer.linter` or a provider route `<model>@humanizer.writer` or
  // `<model>@search` sits in a map the schema leaves free, so the check passes a route that no request reads.
  const chain = [{ via: 'api', key: 'k', model: 'x/m', effort: null }];
  const local = {
    models: { routes: { 'humanizer.linter': chain, linter: chain, editor: chain } },
    llm: {
      providerByModel: {
        'x/@humanizer.writer': { only: ['p'] },
        'x/@search': { only: ['p'] },
        'x/@editor': { only: ['p'] },
        'x/': { only: ['p'] },
      },
    },
  };
  const answer = await desk(localLayer(local), local).run('config.check', {}, { id: 'owner-1' });
  assert.equal(answer.status, 'failed');
  assert.deepEqual(answer.text.split('\n'), [
    'models.routes.humanizer.linter: unknown key',
    'llm.providerByModel.x/@humanizer.writer: unknown key',
    'llm.providerByModel.x/@search: unknown key',
  ]);
});

test('/config check of a clean local layer answers ok', async () => {
  const local = { llm: { maxRequestsPerDay: 4000 } };
  const answer = await desk(localLayer(local), local).run('config.check', {}, { id: 'owner-1' });
  assert.equal(answer.status, 'ok', answer.text);
});

// Spec case 4 end to end: the core starts on a local layer the schema refuses, and the chat's check names both keys.
test('the core starts on a local layer with an unknown key and a wrong type, and /config check names both', async () => {
  const config = { llm: { maxRequestsPerDay: 'many' }, nosuch: { key: 1 } };
  await withRig({ config }, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const run = await runCli(dirs, ['-p', '/config check']);
    assert.equal(run.code, 1, run.stderr.slice(-2000));
    const printed = run.stdout + run.stderr;
    assert.ok(printed.includes('llm.maxRequestsPerDay'), printed.slice(-2000));
    assert.ok(printed.includes('nosuch'), printed.slice(-2000));
  });
});

const BASE = 'https://openrouter.test/api/v1';
const KEY_VALUES = ['or-value-secret', 'oc-value-secret'];

function listing(call: CapabilitiesCall): Reply {
  if (!call.url.endsWith('/models')) return { status: 200, body: {} };
  const text = { input_modalities: ['text'], output_modalities: ['text'] };
  return {
    status: 200,
    body: {
      data: [
        { id: 'vendor/text-1', architecture: text },
        { id: 'vendor/voice-1', architecture: { input_modalities: ['text'], output_modalities: ['audio'] } },
      ],
    },
  };
}

function capabilitiesRig(
  answer: (call: CapabilitiesCall) => Reply = listing,
  keys: Partial<KeysFile> = {},
  openRouterKey: string | null = KEY_VALUES[0] ?? null
) {
  const privateDir = tempDir('nep-capabilities-');
  writeKeysFile(privateDir, keys);
  const { fetch, calls } = fakeFetch(answer);
  return { privateDir, calls, deps: { privateDir, fetch, baseUrl: BASE, openRouterKey } };
}

/** Puts an opencode binary in place, on the extra key `oc`. */
function withOpencode(): ReturnType<typeof capabilitiesRig> {
  const made = capabilitiesRig(listing, {
    extra: { oc: KEY_VALUES[1] ?? '' },
    subharness: { key: 'oc', modes: {} },
  });
  const { binary } = subharnessPlace(made.privateDir, 'opencode');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return made;
}

const source = (read: RoleSources, via: SourceDescriptor['via']): SourceDescriptor => {
  const found = read.sources.find((one) => one.via === via);
  assert.ok(found, `a source with via ${String(via)}`);
  return found;
};

test('every model an agent is offered through opencode is accepted by /model set with --via', async () => {
  // The lead: routes are named direct-api, claude-harness, codex-harness and opencode-harness (owner, 2026-11-06).
  // Catches: the chooser and the setter disagreeing, a row that only fails after the owner confirmed it.
  const { deps, privateDir } = withOpencode();
  const read = await roleSources(deps, 'server');
  const opencode = source(read, 'opencode');
  const desk = capabilitiesDeskOf(privateDir, deps.fetch);
  const firstModel = opencode.models[0];
  const model = firstModel?.id;
  const answer = await desk.run('model.set', { role: 'server', model, via: 'opencode-harness' }, { id: 'owner' });
  assert.equal(answer.status, 'ok', answer.text);
});

// The command

function capabilitiesDeskOf(privateDir: string, fetch: typeof globalThis.fetch) {
  const checks: Array<string> = [];
  const desk = createConsole({
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: '', data: null }),
    ownerReads: { lessons: () => '' },
    places: () => ['g1'],
    selfId: () => 'self-1',
    hot: { config: { bot: { owners: [] } } },
    privateDir,
    dataDir: privateDir,
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => 0,
    subharness: {
      runBackend: (name): Promise<BackendResult> => {
        checks.push(name);
        return Promise.resolve({ ok: true, text: 'ok', exitCode: 0 });
      },
      fetch,
      applyMode: () => Promise.resolve(''),
    },
  });
  return Object.assign(desk, { checks });
}

test('/model sources <role> parses on the table and answers the descriptors with no check', async () => {
  // Catches: a chooser with no read path to the core, or one that goes through a model check.
  assert.deepEqual(parseCommandLine('/model sources server'), {
    ok: true,
    name: 'model.sources',
    args: { role: 'server' },
  });
  const family = COMMANDS.find((one) => one.name === 'model');
  assert.equal(family?.defaultSubcommand, 'show');
  const { deps, privateDir } = capabilitiesRig();
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  const desk = capabilitiesDeskOf(privateDir, deps.fetch);
  const answer = await desk.run('model.sources', { role: 'server' }, { id: 'owner' });
  assert.equal(answer.status, 'ok', answer.text);
  const read = JSON.parse(answer.text) as RoleSources;
  assert.equal(read.role, 'server');
  assert.equal(source(read, 'claude').code, 'ok');
  assert.deepEqual(desk.checks, []);
});

const namesDbOf = (memoryDb: { readHandle(): unknown }): Db => (memoryDb.readHandle() as { db: Db }).db;

/** A console over the test memory, for the owner's command lines. */
function consoleOver(memoryDb: unknown) {
  const dir = tempDir('nep-owner-names-');
  const desk = createConsole({
    runOp: () => Promise.reject(new Error('a name on a person runs no operation')),
    ownerReads: { lessons: () => '' },
    places: () => [],
    selfId: () => 'self-1',
    hot: { config: { bot: { owners: [] } } },
    privateDir: dir,
    dataDir: dir,
    memoryDb,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => Date.now(),
  });
  return async (line: string) => {
    const parsed = parseCommandLine(line);
    assert.ok(parsed.ok, line);
    return desk.run(parsed.name, parsed.args, { id: 'owner-1' });
  };
}

test("the owner adds a name to person:self by the command, and the persona's names show it", async () => {
  // Bug: the command takes only an account, so the persona's own record cannot be given a name.
  const { memoryDb, close } = await openTestMemory();
  try {
    const run = consoleOver(memoryDb);
    assert.equal((await run('/memory users names add person:self Zefira')).status, 'ok');
    assert.deepEqual(ownerNamesOf(namesDbOf(memoryDb), 'person:self'), ['Zefira']);
    const view = personDetail(namesDbOf(memoryDb), 'person:self', internalContext());
    assert.ok(view.found && view.names.includes('Zefira'));
  } finally {
    await close();
  }
});

test('a name for a person no row holds is not written as an owner name', async () => {
  // Bug: any word that starts with `person:` passes as a person, and the name lands on a subject nobody has.
  const { memoryDb, close } = await openTestMemory();
  try {
    const run = consoleOver(memoryDb);
    // The word is no stored person, so the command goes on to the account operation, which this console refuses.
    await run('/memory users names add person:nobody Zefira').catch(() => null);
    assert.deepEqual(ownerNamesOf(namesDbOf(memoryDb), 'person:nobody'), []);
  } finally {
    await close();
  }
});

const ownerOn = (iface: string, native: string, config: object): boolean =>
  withIface(iface, () => isOwnerId(config, native));

test('/memory bind <iface> <account> owner makes that person the owner person in the running core', async () => {
  // Bug: the core never installs the account reader, or the command leaves the setting unwritten, and the owner
  // locks themselves out of every interface at the migration.
  await withRig({}, async ({ dirs, llm, units, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    const unit = await startedUnit(dirs);
    units.push(unit);
    const author = 'u1';
    await unit.emit(mention('m1', 'hello'));
    await until(
      () => query(dirs, 'SELECT 1 FROM accounts WHERE native_key = ?', author).length > 0,
      'the first sight of the author'
    );

    const unmet = await runCli(dirs, ['-p', '/memory bind fake nobody owner']);
    assert.notEqual(unmet.code, 0);

    const bound = await runCli(dirs, ['-p', `/memory bind fake ${author} owner`]);
    assert.equal(bound.code, 0, bound.stdout + bound.stderr.slice(-2000));
    const local = JSON.parse(readFileSync(path.join(dirs.privateDir, 'config', 'config.json'), 'utf8')) as {
      bot: { ownerPerson: string };
    };
    // A person's id is opaque and spells no account, so the setting is compared with the account's stored person.
    const [account] = query(dirs, 'SELECT person_id FROM accounts WHERE native_key = ?', author) as Array<{
      person_id: string;
    }>;
    assert.equal(local.bot.ownerPerson, account?.person_id);
    assert.equal(ownerOn('fake', author, local), true);
    assert.equal(ownerOn('fake', 'someone-else', local), false);
    assert.equal(ownerOn('telegram', author, local), false);
  });
});

test('status.readiness answers from what the core holds and sends no request', async () => {
  // Catches: the launch's health read spends a model request on every chat opened.
  const dir = tempDir('nep-readiness-console-');
  recordCoreCheck(dir, { selection: 'openrouter:vendor/core-1', ok: true, code: null, at: 5 });
  const { fetch, calls } = fakeFetch();
  const desk = createConsole({
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: '', data: null }),
    ownerReads: { lessons: () => '' },
    places: () => ['g1'],
    selfId: () => 'self-1',
    hot: { config: { bot: { owners: [] }, models: { routes: chainsOf({ core: 'vendor/core-1' }) } } },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => 0,
    subharness: { fetch, runBackend: () => Promise.reject(new Error('no model run')) },
  });
  const answer = await desk.run('status.readiness', {}, { id: 'owner' });
  assert.equal(answer.status, 'ok', answer.text);
  const read = JSON.parse(answer.text) as Pick<ReadinessHealth, 'model' | 'memory'>;
  assert.equal(read.model.selection, 'openrouter:vendor/core-1');
  const check = read.model.check;
  assert.equal(check?.ok, true);
  assert.equal(read.memory.service, 'down');
  assert.deepEqual(calls, []);
});

type Ran = { name: string; model: string | undefined; effort: EffortLevel | undefined };

/** keys.json with codex and claude connected; the runner answers for every model but `bad-model`. */
function pathsRig(options: { backends?: Array<'codex' | 'claude' | 'opencode'> } = {}) {
  const dir = tempDir('nep-paths-');
  writeKeysFile(dir, {
    subharness: { backends: options.backends ?? ['codex', 'claude'], key: null, modes: {}, models: {}, uses: {} },
  });
  // Changed: a selection reads the real source, so each backend a rig calls connected is installed and logged in.
  for (const backend of options.backends ?? (['codex', 'claude'] as const))
    if (backend !== 'opencode') fakeVendor(dir, backend, { loggedIn: true });
  const ran: Array<Ran> = [];
  const deps: EnableDeps = {
    privateDir: dir,
    runBackend: (name, _brief, model, effort) => {
      ran.push({ name, model, effort });
      const ok = model !== 'bad-model';
      return Promise.resolve({ ok, text: ok ? 'ok' : '', exitCode: ok ? 0 : 1 });
    },
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
  };
  return { dir, deps, ran };
}

// model set from the console

/** A console over fakes whose runOp records each operation. */
function pathsConsoleOver(dir: string, subharness: ConsoleDeps['subharness']) {
  const ops: Array<string> = [];
  const deps: ConsoleDeps = {
    runOp: (op) => {
      ops.push(op);
      return Promise.resolve({ status: 'ok', code: '', summary: '', data: null });
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
    now: () => 0,
    keys: { enabled: () => true, run: () => Promise.resolve({ text: 'keys answered', status: 'ok' }) },
    ...(subharness === undefined ? {} : { subharness }),
  };
  return { desk: createConsole(deps), ops };
}

/** The console deps of a rig without its privateDir, which the console takes from the dir. */
function withoutPrivateDir<T extends { privateDir?: unknown }>(deps: T): Omit<T, 'privateDir'> {
  const copy: Record<string, unknown> = { ...deps };
  delete copy.privateDir;
  return copy as Omit<T, 'privateDir'>;
}

test('model set for an agent goes through its subharness with the effort, not to the key commands', async () => {
  // Catches: "/model set server" written into models.development.server, which no subharness run reads.
  const { dir, deps, ran } = pathsRig();
  const { desk, ops } = pathsConsoleOver(dir, withoutPrivateDir(deps));
  const answer = await desk.run('model.set', { role: 'server', model: 'gpt-6.1-sol', effort: 'low' }, { id: 'owner' });
  assert.equal(answer.status, 'ok');
  assert.notEqual(answer.text, 'keys answered');
  assert.deepEqual(ops, []);
  assert.equal(ran[0]?.effort, 'low');
  assert.equal(readKeysFile(dir).subharness.models?.server, 'gpt-6.1-sol');
});

const KEY = 'sk-or-v1-provider-fake-0123456789';
const MODEL = 'anthropic/claude-sonnet-5';
const PROVIDER_OWNER = { id: 'owner' };

/** The providers keys.json holds, by agent; the section is absent while nobody pinned one. */
const providersOf = (dir: string): unknown => (readKeysFile(dir).subharness as Record<string, unknown>).providers;

/** A private dir whose opencode is installed and logged in on the extra key `helpers`. */
function installed(): string {
  const dir = tempDir('nep-provider-');
  writeKeysFile(dir, { extra: { helpers: KEY }, subharness: { key: 'helpers', modes: {} } });
  const { binary } = subharnessPlace(dir, 'opencode');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\nexit 9\n', { mode: 0o755 });
  return dir;
}

const selectionDeps = (dir: string): EnableDeps => ({
  privateDir: dir,
  baseUrl: 'https://openrouter.test/api/v1',
  runBackend: () => Promise.resolve({ ok: true, text: 'ok', exitCode: 0 }),
  fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
});

/** The console over `dir`, as the owner's chat reaches it. */
function providerConsoleOver(dir: string) {
  return createConsole({
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: '', data: null }),
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
    now: () => 0,
    subharness: {
      runBackend: () => Promise.resolve({ ok: true, text: 'ok', exitCode: 0 }),
      fetch: fakeFetch().fetch,
    },
  });
}

// the commands

test('/model set <agent> <model> --via opencode --provider stores the provider and /subharness status shows it', async () => {
  // The lead: routes are named direct-api, claude-harness, codex-harness and opencode-harness (owner, 2026-11-06).
  // Catches: the console still refusing `--provider` for an agent, or the status leaving the pin out so the owner cannot check it.
  const dir = installed();
  const answer = await providerConsoleOver(dir).run(
    'model.set',
    { role: 'server', model: MODEL, via: 'opencode-harness', provider: 'google-vertex' },
    PROVIDER_OWNER
  );
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual(providersOf(dir), { server: 'google-vertex' });
  const status = await subharnessCommand(selectionDeps(dir), 'subharness.status', {});
  const row = status.text.split('\n').find((line) => line.trim().startsWith('server ')) ?? '';
  assert.ok(row.includes('google-vertex'), status.text);
});

test('/model set <agent> <model> --provider with no --via on a claude agent is refused with provider-unsupported', async () => {
  // The lead: routes are named direct-api, claude-harness, codex-harness and opencode-harness (owner, 2026-11-06).
  // Catches: the old blanket refusal text with no code, or the pin stored for an agent whose source takes none.
  const dir = installed();
  fakeVendor(dir, 'claude', { loggedIn: true });
  await providerConsoleOver(dir).run(
    'model.set',
    { role: 'server', model: 'sonnet', via: 'claude-harness' },
    PROVIDER_OWNER
  );
  const answer = await providerConsoleOver(dir).run(
    'model.set',
    { role: 'server', model: 'opus', provider: 'anthropic' },
    PROVIDER_OWNER
  );
  assert.equal(answer.code, 'provider-unsupported');
  assert.deepEqual(providersOf(dir) ?? {}, {});
});

const FOUR_NAMES = ['direct-api', 'claude-harness', 'codex-harness', 'opencode-harness'];
const ROUTE_OWNER = { id: 'owner' };

type RouteRan = { name: string; model: string | undefined };

/** keys.json with `subharness` laid over; claude and codex are installed and logged in, the runner answers every model. */
function routeRig(subharness: Partial<KeysFile['subharness']> = {}) {
  const dir = tempDir('nep-route-names-');
  writeKeysFile(dir, { subharness: { key: null, modes: {}, models: {}, uses: {}, ...subharness } });
  for (const backend of ['claude', 'codex'] as const) fakeVendor(dir, backend, { loggedIn: true });
  const ran: Array<RouteRan> = [];
  const deps: EnableDeps = {
    privateDir: dir,
    runBackend: (name, _brief, model) => {
      ran.push({ name, model });
      return Promise.resolve({ ok: true, text: 'ok', exitCode: 0 });
    },
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
  };
  return { dir, deps, ran };
}

/** A console over `deps`; `keys` answers the key commands, or `keys answered` when absent. */
function routeConsoleOver(dir: string, deps: EnableDeps, keys?: NonNullable<ConsoleDeps['keys']>) {
  const consoleDeps: ConsoleDeps = {
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: '', data: null }),
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
    now: () => 0,
    keys: keys ?? { enabled: () => true, run: () => Promise.resolve({ text: 'keys answered', status: 'ok' }) },
    subharness: {
      runBackend: (...args) => deps.runBackend(...args),
      fetch: (...args) => deps.fetch(...args),
    },
  };
  return createConsole(consoleDeps);
}

// what the owner types

test('model set scout --via opencode-harness stores uses opencode for the agent', async () => {
  // Catches: the agent path (setAgentModel) comparing the typed word with the stored names and refusing the new one.
  // The lead: opencode is installed and logged in on an extra key here, as tests/src/subharness/run.test.ts does,
  // because the rig installs only claude and codex and the answer was "opencode is not installed".
  const { dir, deps } = routeRig({ key: 'helpers' });
  const keys = readKeysFile(dir);
  writeKeysFile(dir, { ...keys, extra: { helpers: 'sk-or-invented' } });
  const { binary } = subharnessPlace(dir, 'opencode');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\nexit 9\n', { mode: 0o755 });
  const answer = await routeConsoleOver(dir, deps).run(
    'model.set',
    { role: 'scout', via: 'opencode-harness', model: 'vendor/invented-model' },
    ROUTE_OWNER
  );
  assert.equal(answer.status, 'ok', answer.text);
  assert.equal(readKeysFile(dir).subharness.uses?.scout, 'opencode');
});

test('model set scout --via a word that names no harness is refused as an unknown backend that names the four names', async () => {
  // Catches: a word that is no route name accepted and stored, or refused with a code the owner's tools do not know.
  const { dir, deps, ran } = routeRig();
  const before = JSON.stringify(readKeysFile(dir));
  const answer: Answer = await routeConsoleOver(dir, deps).run(
    'model.set',
    { role: 'scout', via: 'claude', model: 'invented-model' },
    ROUTE_OWNER
  );
  assert.equal(answer.code, 'unknown-backend', answer.text);
  assert.notEqual(answer.status, 'ok');
  for (const name of FOUR_NAMES) assert.ok(answer.text.includes(name), `${name} in "${answer.text}"`);
  assert.deepEqual(ran, []);
  assert.equal(JSON.stringify(readKeysFile(dir)), before);
});

const USAGE_T0 = 1_790_000_000_000;

const metric = (name: string, over: Partial<UsageMetric> = {}): UsageMetric => ({
  name,
  scope: 'account',
  unit: 'percent',
  value: 25,
  state: 'observed',
  ...over,
});
const subscription = (over: Partial<BackendUsage> = {}): BackendUsage => ({
  variant: 'subscription',
  source: 'codex',
  account: { label: 'one@example.test' },
  observedAt: USAGE_T0,
  availability: 'available',
  metrics: [metric('primary.usedPercent')],
  errors: [],
  handoff: null,
  ...over,
});

// /usage

function deskWith(backendUsage: () => Promise<ReadonlyArray<BackendUsage>>) {
  const checks: Array<string> = [];
  const zero = { requests: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 0 };
  const privateDir = tempDir('nep-usage-desk-');
  const desk = createConsole({
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: '', data: null }),
    ownerReads: { lessons: () => '' },
    places: () => [],
    selfId: () => 'self-1',
    hot: { config: { bot: { owners: [] } } },
    privateDir,
    dataDir: privateDir,
    memoryDb: null,
    usage: {
      byRole: () => [],
      sumDays: () => ({ rows: [], interfaces: [], total: zero, since: '2026-11-05', partial: false }),
    },
    metrics: null,
    chatLines: () => [],
    now: () => USAGE_T0,
    backendUsage,
    subharness: {
      runBackend: (name) => {
        checks.push(name);
        return Promise.resolve({ ok: true, text: 'ok', exitCode: 0 });
      },
      fetch: fakeFetch().fetch,
      applyMode: () => Promise.resolve(''),
    },
  });
  return { desk, checks };
}

test('/usage carries the native blocks beside the engine accounting, with no backend run', async () => {
  // Catches: native data replacing the engine's own numbers, or a model run behind a read.
  const { desk, checks } = deskWith(() => Promise.resolve([subscription()]));
  const answer = await desk.run('usage', { window: '' }, { id: 'owner' });
  assert.equal(answer.status, 'ok');
  assert.ok(answer.text.includes('one@example.test'), answer.text);
  assert.ok(answer.text.includes('2026-11-05'), answer.text);
  assert.deepEqual(checks, []);
});

test('/usage survives a native read that rejects, and says so', async () => {
  // Catches: a vendor problem taking the engine's own accounting down with it.
  const { desk } = deskWith(() => Promise.reject(new Error('sk-leaky-detail')));
  const answer = await desk.run('usage', { window: '' }, { id: 'owner' });
  assert.equal(answer.status, 'ok');
  assert.ok(answer.text.includes('2026-11-05'), answer.text);
  assert.equal(answer.text.includes('sk-leaky-detail'), false, answer.text);
});
