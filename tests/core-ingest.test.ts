// Durable ingestion end to end: `startCore` (src/core.ts) over temporary data and private folders, a scripted model
// and the fake interface (src/interface/fake-interface.ts) on the real socket, with no clients.json, so the core's
// boot principal speaks for the fake. The core commits each event's `ingest` row together with the observation it
// makes, before the ack goes back, so a restart still knows every event it took. The fake numbers its events in an
// outbox; after a dropped link it reconnects and resends what the core had not acknowledged. The memory database is
// read through a second, read-only connection, because the core holds the writer lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore } from '../src/core.ts';
import { start } from '../src/interface/fake-interface.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { ANSWER, SELF, channelInfo, deliver, settle, until } from './fixtures/core-over-fake.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';

type Running = Awaited<ReturnType<typeof start>>;
type Row = Record<string, unknown>;
type Db = { prepare(sql: string): { all(...args: Array<unknown>): Array<Row> } };

const REPO = fileURLToPath(new URL('..', import.meta.url));
const PRIVATE_CONFIG = {
  bot: { timezone: 'UTC', owners: [], placeId: 'g1' },
  // No video role, so the start sends no canary probe to YouTube.
  models: { base: { video: false } },
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
    complete: (
      messages: unknown,
      given?: { purpose?: unknown }
    ): Promise<{ text: string; usage: object; estimated: number }> => {
      if (given?.purpose === 'address') return Promise.resolve({ text: 'yes', usage: {}, estimated: 1 });
      requests.push(messages);
      return Promise.resolve({ text: `<msg>${ANSWER}</msg>`, usage: {}, estimated: 10 });
    },
  };
}

/** One start of the core over `dirs`, with a fresh fake interface seeded with the conversation c1. */
async function boot(dirs: ReturnType<typeof folders>, llm: ReturnType<typeof scriptedLlm>) {
  let running: Running | null = null;
  const core = await startCore({
    paths: { rootDir: REPO, privateDir: dirs.privateDir, dataDir: dirs.dataDir },
    env: { OPENROUTER_CORE_KEY: 'test-key' },
    interfaces: [
      {
        name: 'fake',
        start: async (host) => {
          running = await start(host, { self: SELF, community: { id: 'g1', name: 'Alpha' } });
          return running;
        },
      },
    ],
    llm,
    embedder: { embed: () => Promise.resolve([]) },
  });
  if (running === null) throw new Error('the core never started the fake interface');
  const live: Running = running;
  live.adapter.seedConversation(channelInfo('c1'));
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

test('an event the core took before a restart is a duplicate after it, and a new one is still answered', async () => {
  await withFolders(async (dirs, llm) => {
    const first = await boot(dirs, llm);
    const event = deliver(first.live.adapter, { id: 'm1', text: 'hello bot', at: Date.now(), mention: true });
    assert.equal(await first.live.emit(event), 'ok');
    await until(() => first.posted().length === 1);
    await first.core.stop();

    const second = await boot(dirs, llm);
    try {
      assert.equal(await second.live.emit(event), 'duplicate');
      const next = deliver(second.live.adapter, { id: 'm2', text: 'and again', at: Date.now(), mention: true });
      assert.equal(await second.live.emit(next), 'ok');
      await until(() => second.posted().length === 1);
      await settle();
      assert.equal(llm.requests.length, 2, 'one turn for m1 before the restart and one for m2 after it');
    } finally {
      await second.core.stop();
    }
  });
});

test('when an emit resolves ok, the ingest row and the observed line of the event are both committed', async () => {
  await withFolders(async (dirs, llm) => {
    const rig = await boot(dirs, llm);
    try {
      const event = deliver(rig.live.adapter, { id: 'm1', text: 'just a line', at: Date.now() });
      assert.equal(await rig.live.emit(event), 'ok');
      const ingested = query(dirs, 'SELECT event_id, kind, conversation FROM ingest WHERE event_id = ?', event.id);
      assert.deepEqual(ingested, [{ event_id: event.id, kind: 'message.received', conversation: 'c1' }]);
      // The catalog retains native message IDs while sources.native_id stores an opaque family key.
      const seen = query(
        dirs,
        `SELECT f.message_id AS native_id FROM sources s
        LEFT JOIN message_families f ON f.iface = s.iface AND f.authority_id = s.authority_id
          AND f.native_kind = s.native_kind AND f.native_key = s.native_id AND f.generation = s.generation
        WHERE s.kind = 'seen'`
      );
      assert.deepEqual(
        seen.map((row) => row.native_id),
        ['m1']
      );
    } finally {
      await rig.core.stop();
    }
  });
});

test("the principal's acknowledged seq is kept in ingest_cursor", async () => {
  await withFolders(async (dirs, llm) => {
    const rig = await boot(dirs, llm);
    try {
      for (const id of ['m1', 'm2']) {
        const event = deliver(rig.live.adapter, { id, text: `line ${id}`, at: Date.now() });
        assert.equal(await rig.live.emit(event), 'ok');
      }
      const cursors = query(dirs, 'SELECT acked_seq FROM ingest_cursor');
      assert.deepEqual(
        cursors.map((row) => row.acked_seq),
        [2]
      );
    } finally {
      await rig.core.stop();
    }
  });
});

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

      // Changed: the owner's no-catch-up policy of 2026-11-02. The message resent after the lost link is kept as
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
