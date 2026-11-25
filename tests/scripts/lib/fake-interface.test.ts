// The fake interface (scripts/lib/fake-interface.ts) on the real socket of a core over temporary data and private
// folders and a scripted model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore } from '../../../src/core.ts';
import { start } from '../../../scripts/lib/fake-interface.ts';
import { openMemoryDb } from '../../../src/memory/db/open.ts';
import { ANSWER, SELF, channelInfo, deliver, settle, until } from '../../fixtures/core-over-fake.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import { createLoopback } from '../../fixtures/loopback.ts';
import { openAdapterLink } from '../../../src/interface/link.ts';
import { createEventDoor } from '../../../src/interface/door.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import type { InterfaceHost } from '../../../src/protocol/host.ts';

type Running = Awaited<ReturnType<typeof start>>;

type Row = Record<string, unknown>;

type Db = { prepare(sql: string): { all(...args: Array<unknown>): Array<Row> } };

const REPO = fileURLToPath(new URL('../../..', import.meta.url));

const PRIVATE_CONFIG = {
  bot: { timezone: 'UTC', owners: [], placeId: 'g1' },
  // No video role, so the start sends no canary probe to YouTube.
  models: { routes: chainsOf({ video: false }) },
  pace: { settleMs: 0, settleMaxMs: 0 },
  typing: { reactionDelayMs: [0, 0], betweenMessagesMs: [0, 0], minMs: 0, maxMs: 0 },
  features: {
    typingSimulation: false,
    spontaneous: false,
    eavesdrop: false,
    followUp: false,
    participation: false,
    customEmoji: false,
    gifs: false,
    offlineCatchUp: false,
    diary: false,
    mediaDescriptions: false,
    missedAnswers: false,
    channelRoute: false,
    recall: false,
    memoryPrefetch: false,
    channelPull: false,
    elsewhere: false,
    speech: false,
    pauseNotice: false,
  },
};

// Short folders: a Unix socket path is limited to 108 bytes.
function folders() {
  const root = mkdtempSync(join(tmpdir(), 'ci-'));
  const dataDir = join(root, 'd');
  // Runtime privateDir aliases the prepared persona data root.
  const privateDir = dataDir;
  mkdirSync(join(privateDir, 'config'), { recursive: true });
  writeFileSync(join(privateDir, 'config', 'config.json'), JSON.stringify(PRIVATE_CONFIG));
  return { root, dataDir, privateDir };
}

/** Every model request across every start of the core over the same folders. */
function scriptedLlm() {
  const requests: Array<unknown> = [];
  return {
    requests,
    // Plan 2026-11-04-cli-and-memory B1: the door asks the address classifier first; it says yes and is not recorded.
    complete: (messages: unknown, given?: unknown): Promise<{ text: string; usage: object; estimated: number }> => {
      if ((given as { purpose?: unknown } | undefined)?.purpose === 'address')
        return Promise.resolve({ text: 'yes', usage: {}, estimated: 1 });
      requests.push(messages);
      return Promise.resolve({ text: `<msg>${ANSWER}</msg>`, usage: {}, estimated: 10 });
    },
  };
}

/** One start of the core over `dirs`, with a fresh fake interface seeded with the chat c1. */
async function boot(dirs: ReturnType<typeof folders>, llm: ReturnType<typeof scriptedLlm>) {
  let running: Running | null = null;
  const core = await startCore({
    paths: { rootDir: REPO, privateDir: dirs.privateDir, dataDir: dirs.dataDir },
    env: { OPENROUTER_CORE_KEY: 'test-key' },
    interfaces: [
      {
        name: 'fake',
        start: async (host) => {
          running = await start(host, { self: SELF, root: { id: 'g1', name: 'Alpha' } });
          return running;
        },
      },
    ],
    llm,
    embedder: { embed: () => Promise.resolve([]) },
  });
  if (running === null) throw new Error('the core never started the fake interface');
  const live: Running = running;
  live.adapter.seedChat(channelInfo('c1'));
  const posted = (): Array<string> =>
    live.adapter
      .messagesIn('c1')
      .filter((message) => message.authorId === SELF.id)
      .map((message) => message.text);
  return { core, live, posted };
}

/** Runs `sql` over the memory database of `dirs` through a read-only connection. */
function query(dirs: ReturnType<typeof folders>, sql: string, ...args: Array<unknown>): Array<Row> {
  const handle = openMemoryDb(join(dirs.dataDir, 'memory.db'), { readOnly: true });
  try {
    return (handle.db as Db)
      .prepare(sql)
      .all(...args)
      .map((row) => ({ ...row }));
  } finally {
    handle.close();
  }
}

async function withFolders(
  body: (dirs: ReturnType<typeof folders>, llm: ReturnType<typeof scriptedLlm>) => Promise<void>
) {
  const dirs = folders();
  try {
    await withCapturedLogs(() => body(dirs, scriptedLlm()));
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
}

test('after a dropped link the fake resends what was not acknowledged, kept as history with no turn over the backlog', async () => {
  await withFolders(async (dirs, llm) => {
    const rig = await boot(dirs, llm);
    try {
      const m1 = deliver(rig.live.adapter, { id: 'm1', text: 'hello bot', at: Date.now(), mention: true });
      assert.equal(await rig.live.emit(m1), 'ok');
      await until(() => rig.posted().length === 1);

      await rig.live.drop();
      const m2 = deliver(rig.live.adapter, { id: 'm2', text: 'are you there', at: Date.now(), mention: true });
      void rig.live.emit(m2);
      await rig.live.reconnect();

      // No catch-up: the message resent after the lost link is kept as
      // history and starts no turn, so a backlog is never answered by itself.
      await until(() => query(dirs, `SELECT 1 FROM sources WHERE kind = 'seen'`).length === 2);
      await settle();
      assert.equal(llm.requests.length, 1, 'one turn, for the message that arrived while connected');
      assert.deepEqual(rig.posted(), [ANSWER]);
      const m3 = deliver(rig.live.adapter, { id: 'm3', text: 'and now', at: Date.now(), mention: true });
      assert.equal(await rig.live.emit(m3), 'ok');
      await until(() => rig.posted().length === 2);
      // The catalog retains native message IDs while sources.native_id stores an opaque family key.
      const seen = query(
        dirs,
        `SELECT f.message_id AS native_id FROM sources s
        LEFT JOIN message_families f ON f.iface = s.iface AND f.authority_id = s.authority_id
          AND f.native_kind = s.native_kind AND f.native_key = s.native_id AND f.generation = s.generation
        WHERE s.kind = 'seen' ORDER BY s.rowid`
      );
      assert.deepEqual(
        seen.map((row) => row.native_id),
        ['m1', 'm2', 'm3']
      );
    } finally {
      await rig.core.stop();
    }
  });
});

const TOKEN = 'link-token';

const SELF_ID = 'self-id';

const CHAT = { iface: 'fake', chatId: 'c1' };

const quiet = { info(): void {}, warn(): void {}, error(): void {} };

function reaction(id: string): Record<string, unknown> {
  return {
    kind: 'reaction.changed',
    iface: 'fake',
    at: 1,
    id,
    chat: { id: 'c1', kind: 'channel' },
    messageId: 'm1',
    emoji: { name: 'x' },
    accountId: 'u1',
    added: true,
  };
}

// The core end (a door that records the ids it handled, the link) and the host that hands the interface the other end.
function rig() {
  const handled: Array<string> = [];
  const door = createEventDoor({
    handlers: { 'reaction.changed': (event: { id: string }) => void handled.push(event.id) },
    log: quiet,
  });
  const loop = createLoopback();
  const link = openAdapterLink({ transport: loop.core, door, token: TOKEN, log: quiet });
  const host: InterfaceHost = {
    connect: () => Promise.resolve(loop.client),
    token: TOKEN,
    env: {},
    config: () => ({}),
    onConfigChange: () => () => {},
    log: quiet,
  };
  return { host, link, loop, handled };
}

test('says hello as the fake interface with the capabilities of the fake adapter', async () => {
  const { host, link } = rig();
  const running = await start(host, { selfId: SELF_ID });
  const hello = await link.hello;
  const expected = createFakeAdapter().capabilities();
  assert.equal(running.iface, 'fake');
  assert.equal(hello.iface, 'fake');
  assert.deepEqual(hello.capabilities.operations, expected.operations);
  assert.equal(hello.capabilities.maxChars, expected.maxChars);
  await running.stop();
});

test('an emitted event reaches the door of the core and is acknowledged ok', async () => {
  const { host, link, handled } = rig();
  const running = await start(host, { selfId: SELF_ID });
  await link.hello;
  running.open();
  assert.equal(await running.emit(reaction('fake:reaction:1')), 'ok');
  assert.deepEqual(handled, ['fake:reaction:1']);
  await running.stop();
});

test('an event emitted twice is handled once and the second ack says duplicate', async () => {
  const { host, link, handled } = rig();
  const running = await start(host, { selfId: SELF_ID });
  await link.hello;
  running.open();
  const first = await running.emit(reaction('fake:reaction:2'));
  const second = await running.emit(reaction('fake:reaction:2'));
  assert.deepEqual([first, second], ['ok', 'duplicate']);
  assert.deepEqual(handled, ['fake:reaction:2']);
  await running.stop();
});

test('a send from the core lands in the stored messages of the fake as a message of the persona', async () => {
  const { host, link } = rig();
  const running = await start(host, { selfId: SELF_ID });
  await link.hello;
  running.open();
  const delivery = await link.adapter.send(CHAT, { text: 'καλημέρα' });
  assert.equal(delivery.status, 'ok');
  const stored = running.adapter.messagesIn('c1').map((message) => [message.authorId, message.text]);
  assert.deepEqual(stored, [[SELF_ID, 'καλημέρα']]);
  await running.stop();
});

test('stop closes the link, so the core sees its peer gone and a later send fails', async () => {
  const { host, link, loop } = rig();
  const running = await start(host, { selfId: SELF_ID });
  await link.hello;
  let closedWith: string | null = null;
  loop.core.onClose((reason) => {
    closedWith = reason;
  });
  await running.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closedWith, 'peer-closed');
  const delivery = await link.adapter.send(CHAT, { text: 'late' });
  assert.notEqual(delivery.status, 'ok');
  assert.equal(running.adapter.messagesIn('c1').length, 0);
});

test('an interface started over an adapter the caller keeps serves that adapter, and its chat survives a second start', async () => {
  const kept = createFakeAdapter({ selfId: SELF_ID });
  const before = rig();
  const first = await start(before.host, { adapter: kept });
  await before.link.hello;
  first.open();
  const adapter = before.link.adapter;
  await adapter.send(CHAT, { text: 'before the restart' });
  await first.stop();
  const after = rig();
  const second = await start(after.host, { adapter: kept });
  await after.link.hello;
  second.open();
  const adapter2 = after.link.adapter;
  await adapter2.send(CHAT, { text: 'after the restart' });
  assert.equal(second.adapter, kept);
  assert.deepEqual(
    kept.messagesIn('c1').map((message) => message.text),
    ['before the restart', 'after the restart']
  );
  await second.stop();
});
