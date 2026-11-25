// Tests for src/core-routing.ts: the core's read routes are qualified by the interface, since two interfaces may
// hold the same native root id and each asks its own. Over the real link with fake interfaces, a scripted model and
// temporary folders. The home root `home` is apart from the shared one, so what the core reads on its own never
// counts as a turn's read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  directIn,
  mentionIn,
  postedIn,
  readsOf,
  seedDm,
  seedPerson,
  seedRoom,
  waitFor,
  withFakes,
} from '../fixtures/two-fakes.ts';
import type { Running } from '../fixtures/two-fakes.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore } from '../../src/core.ts';
import { addClient } from '../../src/setup/clients.ts';
import { createKeyStore } from '../../src/keys/store.ts';
import { connectSocket } from '../../src/protocol/wire.ts';
import { createFakeAdapter } from '../../scripts/lib/fake.ts';
import { start as startFake } from '../../scripts/lib/fake-interface.ts';
import { deliver, channelInfo, until as fakeUntil } from '../fixtures/core-over-fake.ts';
import { withCapturedLogs } from '../fixtures/capture-logs.ts';
import { chainsOf } from '../fixtures/chains.ts';

const SHARED = [{ id: 'shared', name: 'Same id' }];
const NAMES = ['one', 'two'];
const ORDERS = [
  ['one', 'two'],
  ['two', 'one'],
] as const;

/** Sends a mention on `from` and answers the reads of the shared root its turn made, on both interfaces. */
async function turnReads(from: Running, other: Running, id: string): Promise<{ own: number; foreign: number }> {
  const room = `room-${from.iface}`;
  seedRoom(from, room, 'shared');
  const foreignBefore = readsOf(other, 'shared').length;
  const ownBefore = readsOf(from, 'shared').length;
  await mentionIn(from, room, 'shared', id);
  await waitFor(() => postedIn(from, room).length > 0, `the answer on ${from.iface}`);
  return {
    own: readsOf(from, 'shared').length - ownBefore,
    foreign: readsOf(other, 'shared').length - foreignBefore,
  };
}

for (const [first, second] of ORDERS) {
  test(`a turn on the first interface to connect reads its own shared root, ${first} before ${second}`, async () => {
    // Bug: the last hello overwrites the route of a native id, so the first interface's turn asks the second.
    await withFakes({ names: NAMES }, async ({ connect }) => {
      const earlier = await connect(first, SHARED);
      const later = await connect(second, SHARED);
      const reads = await turnReads(earlier, later, 'm1');
      assert.equal(reads.foreign, 0);
      assert.notEqual(reads.own, 0);
    });
  });
}

test('a DM gate on the first interface asks membership of its own shared root', async () => {
  // Bug: the root leaves the first interface's list when the second says hello, so its member is refused as a stranger.
  await withFakes({ owners: ['u1'], names: NAMES }, async ({ connect }) => {
    const earlier = await connect('one', SHARED);
    const later = await connect('two', SHARED);
    seedRoom(earlier, 'r1', 'shared');
    seedPerson(earlier, 'shared', 'u1', 'Eleni');
    await mentionIn(earlier, 'r1', 'shared', 'm1');
    await waitFor(() => postedIn(earlier, 'r1').length > 0, 'the answer in the room');
    seedDm(earlier, 'd1', 'u1');
    const before = readsOf(later, 'shared').length;
    await directIn(earlier, 'd1', 'u1', 'm2');
    await waitFor(() => postedIn(earlier, 'd1').length > 0, 'the answer to the DM');
    assert.equal(readsOf(later, 'shared').length, before);
  });
});

test('disconnecting one interface keeps the route of the other that shares its root id', async () => {
  // Bug: the route still names the closed link, so the remaining interface's reads answer nothing.
  await withFakes({ names: NAMES }, async ({ connect }) => {
    const staying = await connect('one', SHARED);
    const leaving = await connect('two', SHARED);
    await leaving.stop();
    const reads = await turnReads(staying, leaving, 'm1');
    assert.notEqual(reads.own, 0);
  });
});

test('a reconnect of one interface does not take the shared root from the other', async () => {
  // Bug: a reconnect says hello again, and the route of the shared id goes to whoever greeted last.
  await withFakes({ names: NAMES }, async ({ connect }) => {
    const steady = await connect('two', SHARED);
    const returning = await connect('one', SHARED);
    await steady.reconnect();
    await returning.reconnect();
    const reads = await turnReads(steady, returning, 'm1');
    assert.equal(reads.foreign, 0);
    assert.notEqual(reads.own, 0);
  });
});

test('after a reconnect the returning interface reads its own root again', async () => {
  // Bug: the qualified origin is taken from the first hello only, so the new link serves no route.
  await withFakes({ names: NAMES }, async ({ connect }) => {
    const returning = await connect('one', SHARED);
    const steady = await connect('two', SHARED);
    await returning.reconnect();
    await steady.reconnect();
    const reads = await turnReads(returning, steady, 'm1');
    assert.equal(reads.foreign, 0);
    assert.notEqual(reads.own, 0);
  });
});

// --- two interfaces as units over the real socket ----------------------------------------------------------------

// Two interfaces connected to one core at once, as units, with several roots on one. A read of a root goes to the
// interface that serves it.
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const TWO_ANSWER = 'γεια σου';
const TWO_SELF = { id: 'self-id', name: 'Nova' };

type FakeRunning = Awaited<ReturnType<typeof startFake>>;

async function withTwoInterfaces(
  body: (rig: { fake: FakeRunning; other: FakeRunning; requests: Array<unknown>; dataDir: string }) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ti-'));
  const dataDir = join(root, 'd');
  mkdirSync(join(dataDir, 'config'), { recursive: true });
  writeFileSync(
    join(dataDir, 'config', 'config.json'),
    JSON.stringify({
      bot: { timezone: 'UTC', owners: ['u1'], placeId: 'g1' },
      dm: { enabled: true },
      private: { minAffinity: 0 },
      models: { routes: chainsOf({ video: false }) },
      interfaces: { mode: 'units', drainMs: 2000 },
      pace: { settleMs: 0, settleMaxMs: 0 },
      typing: { reactionDelayMs: [0, 0], betweenMessagesMs: [0, 0], minMs: 0, maxMs: 0 },
      gifs: { backfillMessages: 0 },
    })
  );
  createKeyStore({ privateDir: dataDir }).add({ name: 'core-1', value: 'test-key' });
  for (const name of ['fake', 'other']) {
    addClient(dataDir, name, { kind: 'interface', iface: name, permissions: [] });
  }
  const requests: Array<unknown> = [];
  const core = await startCore({
    paths: { rootDir: REPO, privateDir: dataDir, dataDir },
    env: {},
    interfaces: [],
    llm: {
      complete: (messages: unknown) => {
        requests.push(messages);
        return Promise.resolve({ text: `<msg>${TWO_ANSWER}</msg>`, usage: {}, estimated: 10 });
      },
    },
    embedder: { embed: () => Promise.resolve([]) },
  });
  const started: Array<FakeRunning> = [];
  const connect = async (name: string, roots: ReadonlyArray<{ id: string; name: string }>) => {
    const log = { info() {}, warn() {}, error() {}, debug() {} };
    const running = await startFake(
      {
        connect: () => connectSocket({ path: join(dataDir, 'run', 'core.sock'), maxFrameBytes: 16 * 1024 * 1024 }),
        token: readFileSync(join(dataDir, 'clients', `${name}.token`), 'utf8').trim(),
        dataDir: join(dataDir, 'interfaces', name),
        env: {},
        config: () => ({}),
        onConfigChange: () => () => {},
        log,
      },
      { adapter: createFakeAdapter({ iface: name, selfId: TWO_SELF.id }), self: TWO_SELF, roots }
    );
    started.push(running);
    return running;
  };
  try {
    const fake = await connect('fake', [
      { id: 'g1', name: 'Alpha' },
      { id: 'g2', name: 'Beta' },
    ]);
    const other = await connect('other', [{ id: 'g3', name: 'Gamma' }]);
    await body({ fake, other, requests, dataDir });
  } finally {
    for (const running of started) await running.stop();
    await core.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

test('a read of a root goes to the interface that serves it', async () => {
  // Bug: a member or emoji read of the second interface's root is asked of the first and answers nothing.
  await withCapturedLogs(async () => {
    await withTwoInterfaces(async ({ fake, other }) => {
      other.adapter.seedChat({ ...channelInfo('c1'), rootId: 'g3', iface: 'other' });
      const event = deliver(other.adapter, { id: 'm1', text: 'Nova, hello', at: Date.now(), mention: true });
      await other.emit({ ...event, iface: 'other', chat: { ...event.chat, rootId: 'g3' } });
      await fakeUntil(() => other.adapter.messagesIn('c1').some((message) => message.authorId === TWO_SELF.id));
      const rootReads = (running: FakeRunning) => {
        const { calls } = running.adapter;
        return calls.filter(
          (call) => call.args[0] === 'g3' || (call.args[0] as { placeId?: string })?.placeId === 'g3'
        );
      };
      assert.notEqual(rootReads(other).length, 0);
      assert.equal(rootReads(fake).length, 0);
    });
  });
});
