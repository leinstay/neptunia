// Where the core's command intake (src/interface/neptunia-cli.ts) sends her posts in the owner's command line chat:
// to the client that sent the last line while it is connected, else to an open chat, a client that asked for the turn
// events with `turn.replay`. The clients are the real owner client (interfaces/cli/link.ts) over a loopback to the core's end
// of the link (src/interface/link.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLinkOver } from '../interfaces/cli/link.ts';
import { createEventDoor } from '../src/interface/door.ts';
import { openAdapterLink } from '../src/interface/link.ts';
import type { AdapterLink } from '../src/interface/link.ts';
import { createCommandIntake } from '../src/interface/neptunia-cli.ts';
import type { Principal } from '../src/interface/principals.ts';
import { createLoopback } from '../src/protocol/wire.ts';

const quiet = { info() {}, warn() {}, error() {} };
const OWNER: Principal = { name: 'owner', kind: 'cli', iface: 'cli', permissions: [] };
const principalOf = (token: string): Principal | null => (token === 'owner-token' ? OWNER : null);
const CHAT = { iface: 'cli', chatId: 'cli:dm:owner' };

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(done(), 'the condition was reached');
}

/** The core's intake and a way to connect an owner client to it; `print` null is a client that takes no replies. */
function rig() {
  const door = createEventDoor({ handlers: { 'message.received': () => {} }, log: quiet });
  const intake = createCommandIntake({
    door,
    ready: () => Promise.resolve(),
    desk: () => ({ run: () => Promise.resolve({ text: '', status: 'ok' }) }),
    log: quiet,
  });
  async function connect(print: ((text: string) => void) | null) {
    const { core, client } = createLoopback();
    const link: AdapterLink = openAdapterLink({
      transport: core,
      door: intake.doorOf(() => link),
      principalOf,
      log: quiet,
    });
    const cli = openLinkOver(client, { token: 'owner-token', print });
    await link.hello;
    return { link, cli };
  }
  return { intake, connect };
}

test('a post reaches the open chat when the client that sent the last line is gone', async () => {
  // Bug: posts go only to the client that sent the last line, so after a `-p` run ends the open chat gets nothing.
  const { intake, connect } = rig();
  const shown: Array<string> = [];
  const chat = await connect((text) => shown.push(text));
  const replay = await chat.cli.ask({ name: 'turn.replay', args: { after: 0 } });
  assert.equal(replay.status, 'ok');
  const once = await connect(() => {});
  assert.equal(await once.cli.say('remind me at nine'), 'ok');
  once.cli.close();
  await until(() => once.link.isClosed());
  // A client that only runs commands is open too, and is no chat.
  await connect(null);
  const sent = await intake.chat()?.send(CHAT, { text: 'it is nine' });
  assert.equal(sent?.status, 'ok');
  assert.deepEqual(shown, ['it is nine']);
});

test('a chat that connects again after a lost link takes posts before the owner types', async () => {
  // Bug: after a reconnect the new link is not where posts go until the owner sends a line.
  const { intake, connect } = rig();
  const first = await connect(() => {});
  await first.cli.ask({ name: 'turn.replay', args: { after: 0 } });
  assert.equal(await first.cli.say('hello'), 'ok');
  first.cli.close();
  await until(() => first.link.isClosed());
  const shown: Array<string> = [];
  const again = await connect((text) => shown.push(text));
  await again.cli.ask({ name: 'turn.replay', args: { after: 0 } });
  const sent = await intake.chat()?.send(CHAT, { text: 'welcome back' });
  assert.equal(sent?.status, 'ok');
  assert.deepEqual(shown, ['welcome back']);
});

test("the owner's line reaches the door under his person's name", async () => {
  // Bug: the line she answered was written by `owner`, and memory kept `owner` as his name.
  const names: Array<unknown> = [];
  const door = createEventDoor({
    handlers: {
      'message.received': (event: unknown) => {
        const { message, chat } = event as { message?: { author?: { name?: unknown } }; chat?: { name?: unknown } };
        names.push([message?.author?.name, chat?.name]);
      },
    },
    log: quiet,
  });
  const intake = createCommandIntake({
    door,
    ready: () => Promise.resolve(),
    desk: () => ({ run: () => Promise.resolve({ text: '', status: 'ok' }) }),
    ownerName: () => 'Robin',
    log: quiet,
  });
  const { core, client } = createLoopback();
  const link: AdapterLink = openAdapterLink({
    transport: core,
    door: intake.doorOf(() => link),
    principalOf,
    log: quiet,
  });
  const cli = openLinkOver(client, { token: 'owner-token', print: () => {} });
  await link.hello;
  assert.equal(await cli.say('hello there'), 'ok');
  await until(() => names.length > 0);
  assert.deepEqual(names, [['Robin', 'Robin']]);
});
