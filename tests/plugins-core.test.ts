// The plugin mechanism on the real core (PR 7f's spec tests 1, 5, 6 and 7): the core runs in the test process as the
// units run it, `/plugins enable echo` goes through `neptunia -p`, the echo plugin runs as `neptunia plugin run echo`
// in a child process, the member's message comes through the fake interface unit, and the model is scripted. The
// units of systemd are a recording stand-in. No provider and no platform is reached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coreSocketPath } from '../src/interface/socket.ts';
import {
  CLI_CLIENT,
  FAKE_CLIENT,
  helloTaken,
  mention,
  postedOnce,
  query,
  runCli,
  seenIds,
  settle,
  startedUnit,
  until,
  withRig,
} from './fixtures/core-units.ts';
import type { Dirs, LogEntry, Rig } from './fixtures/core-units.ts';
import { lineEvent } from './fixtures/core-over-fake.ts';
import {
  ANSWER,
  echoLlm,
  installEcho,
  pluginHello,
  rawOverSocket,
  recordingUnits,
  spawnPlugin,
  startPluginCore,
  statusOf,
  tokenOf,
} from './fixtures/plugin-rig.ts';
import type { EchoLlm, PluginUnit } from './fixtures/plugin-rig.ts';

const CONFIG = {
  bot: { access: { 'echo.say': { users: ['self-id'] } } },
  features: { innerLife: true, intentions: false },
  innerLife: { mode: 'shadow', tickSeconds: 1, review: { enabled: false }, heartbeat: { enabled: false } },
  plugins: { callDeadlineMs: 4000 },
};

const registrations = (logs: ReadonlyArray<LogEntry>): number =>
  logs.filter((entry) => entry.msg === 'plugins: tools registered' && entry.plugin === 'echo').length;

const abilityWakes = (dirs: Dirs): Array<Record<string, unknown>> =>
  query(dirs, "SELECT payload FROM wakes WHERE kind = 'heartbeat'")
    .map((row) => JSON.parse(String(row.payload)) as Record<string, unknown>)
    .filter((payload) => payload.reason === 'ability.added');

type Started = { rig: Rig; llm: EchoLlm; plugins: Array<PluginUnit> };

/** The core with the echo plugin installed and the recording units; `body` gets them. */
async function withEcho(body: (started: Started) => Promise<void>): Promise<void> {
  const clients = [FAKE_CLIENT, CLI_CLIENT];
  await withRig({ config: CONFIG, clients }, async (rig) => {
    installEcho(rig.dirs.privateDir);
    const llm = echoLlm('hello there');
    rig.cores.push(await startPluginCore(rig.dirs, llm, recordingUnits()));
    const plugins: Array<PluginUnit> = [];
    try {
      await body({ rig, llm, plugins });
    } finally {
      for (const plugin of plugins) await plugin.kill();
    }
  });
}

async function enabled({ rig, plugins }: Started): Promise<void> {
  const done = await runCli(rig.dirs, ['-p', '/plugins enable echo']);
  assert.equal(done.code, 0, done.stderr.slice(-2000));
  plugins.push(spawnPlugin(rig.dirs, 'echo'));
  await until(
    () => registrations(rig.logs) >= 1,
    () => `the echo plugin to register; its output:\n${plugins[0]?.output().slice(-1500) ?? ''}`
  );
}

test('a turn of hers that calls echo.say gets the plugin answer in the same turn', async () => {
  await withEcho(async (started) => {
    const { rig, llm } = started;
    await enabled(started);
    const unit = await startedUnit(rig.dirs);
    rig.units.push(unit);
    assert.equal(await (await unit.emit(mention('m1', 'does the echo plugin work'))).acked, 'ok');
    assert.deepEqual(await postedOnce(unit, 1), [ANSWER]);
    assert.deepEqual(
      llm.toolMessages().map((text) => text.includes('echo: hello there')),
      [true]
    );
    assert.equal(llm.requests.length, 2, 'one request with the call, one after its result, in one turn');
  });
});

test('enabling the plugin raises one wake with the cause and the tool names, and a reconnect raises none', async () => {
  await withEcho(async (started) => {
    const { rig, plugins } = started;
    await enabled(started);
    await until(() => abilityWakes(rig.dirs).length === 1, 'the ability wake');
    assert.deepEqual(abilityWakes(rig.dirs)[0]?.tools, ['echo.say']);
    await plugins[0]?.kill();
    plugins.push(spawnPlugin(rig.dirs, 'echo'));
    await until(() => registrations(rig.logs) >= 2, 'the second registration');
    await settle();
    assert.equal(abilityWakes(rig.dirs).length, 1);
  });
});

test('a plugin principal that sends a message.received event is answered invalid and the core observes nothing', async () => {
  await withEcho(async ({ rig, llm }) => {
    const done = await runCli(rig.dirs, ['-p', '/plugins enable echo']);
    assert.equal(done.code, 0, done.stderr.slice(-2000));
    const raw = await rawOverSocket(coreSocketPath(rig.dirs.dataDir));
    raw.transport.send(pluginHello('echo', tokenOf(rig.dirs, 'echo')));
    await raw.ack('h1');
    const event = {
      ...lineEvent({ id: 'p1', text: 'hello from a plugin', at: Date.now(), mention: true }),
      iface: 'plugin',
    };
    raw.send('event', event, event.id);
    assert.equal(statusOf(await raw.ack(event.id)), 'invalid');
    await settle();
    assert.deepEqual(seenIds(rig.dirs), []);
    assert.equal(llm.requests.length, 0);
    raw.transport.close();
  });
});

test('the skill the echo plugin ships is pending in /skills once the plugin is enabled, and its activation grants no tool', async () => {
  await withEcho(async ({ rig }) => {
    const before = await runCli(rig.dirs, ['-p', '/skills pending']);
    assert.equal(before.stdout.includes('echo-say'), false, 'a disabled plugin ships nothing');
    await runCli(rig.dirs, ['-p', '/plugins enable echo']);
    const pending = await runCli(rig.dirs, ['-p', '/skills pending']);
    assert.equal(pending.code, 0, pending.stderr.slice(-2000));
    assert.match(pending.stdout, /echo-say\s.*tools: echo\.say/);
    const activated = await runCli(rig.dirs, ['-p', '/skills activate echo-say']);
    assert.equal(activated.code, 0, activated.stderr.slice(-2000));
    const listed = await runCli(rig.dirs, ['-p', '/skills list']);
    assert.match(listed.stdout, /echo-say.*unavailable: echo\.say not-registered/);
  });
});

test('a plugin that says hello with the token of a disabled plugin is refused', async () => {
  await withEcho(async ({ rig }) => {
    await runCli(rig.dirs, ['-p', '/plugins enable echo']);
    const token = tokenOf(rig.dirs, 'echo');
    const off = await runCli(rig.dirs, ['-p', '/plugins disable echo']);
    assert.equal(off.code, 0, off.stderr.slice(-2000));
    const raw = await rawOverSocket(coreSocketPath(rig.dirs.dataDir));
    raw.transport.send(pluginHello('echo', token));
    await until(() => raw.closed() !== null, 'the core to close the link');
    assert.equal(helloTaken(rig.logs, 'echo'), false);
  });
});
