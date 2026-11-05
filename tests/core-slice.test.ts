// The slice end to end: `startCore` (src/core.ts) over temporary data and private directories, the tracked prompts, a
// scripted model and the fake interface (src/interface/fake-interface.ts), which holds the conversation and answers the
// core's reads. One member message that names the persona goes through the link, the event door, the
// pipeline, a turn and the memory database, and her `<msg>` text comes back over the link to the fake adapter. The model
// is a function that records its requests, so nothing calls a provider, and the settings that would add helper requests
// or random behaviour are switched off in the private layer. The memory database is read through a second, read-only
// connection, because the core holds the writer lock. The link socket sits at `<data>/run/core.sock`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKeyStore } from '../src/keys/store.ts';
import { startCore } from '../src/core.ts';
import { start } from '../src/interface/fake-interface.ts';
import { lockPathOf, openMemoryDb } from '../src/memory/db/open.ts';
import { channelInfo, deliver } from './fixtures/core-over-fake.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';

type Running = Awaited<ReturnType<typeof start>>;
type Row = Record<string, unknown>;
type MemberMessage = { id: string; content: string; at: number };

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SELF_ID = 'self-id';
const ANSWER = 'γεια σου, καλημέρα';
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

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Short folders: a Unix socket path is limited to 108 bytes.
function folders(extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cs-'));
  const dataDir = join(root, 'd');
  // The runtime private alias and all prepared persona files use the selected data root.
  const privateDir = dataDir;
  mkdirSync(join(dataDir, 'config'), { recursive: true });
  writeFileSync(join(dataDir, 'config', 'config.json'), JSON.stringify({ ...PRIVATE_CONFIG, ...extra }));
  createKeyStore({ privateDir: dataDir }).addCore({ name: 'core-1', value: 'test-key' });
  return { root, dataDir, privateDir, paths: { rootDir: REPO, privateDir, dataDir } };
}

// The scripted model: it answers every request with `<msg>` + ANSWER and keeps the requests it got.
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

async function withCore(
  body: (core: Awaited<ReturnType<typeof startCore>>, ctx: Context) => Promise<void>,
  extra: Record<string, unknown> = {}
) {
  const dirs = folders(extra);
  const llm = scriptedLlm();
  let running: Running | null = null;
  const core = await startCore({
    paths: dirs.paths,
    env: {},
    interfaces: [
      {
        name: 'fake',
        start: async (host) => {
          running = await start(host, { selfId: SELF_ID });
          return running;
        },
      },
    ],
    llm,
    embedder: { embed: () => Promise.resolve([]) },
  });
  if (running === null) throw new Error('the core never started the fake interface');
  const live: Running = running;
  const dbPath = join(dirs.dataDir, 'memory.db');
  live.adapter.seedConversation(channelInfo('c1'));
  const ctx: Context = {
    ...dirs,
    dbPath,
    llm,
    mentionEvent: (message) =>
      deliver(live.adapter, { id: message.id, text: message.content, at: message.at, mention: true }),
    emit: (event) => live.emit(event),
    posted: () =>
      live.adapter
        .messagesIn('c1')
        .filter((message) => message.authorId === SELF_ID)
        .map((message) => message.text),
    rows: (kind) => {
      const handle = openMemoryDb(dbPath, { readOnly: true });
      try {
        // Catalog IDs preserve the protocol identity while source native_id values identify opaque families.
        const sql = `SELECT s.kind, f.message_id AS native_id, s.text, s.direct FROM sources s
          LEFT JOIN message_families f ON f.iface = s.iface AND f.authority_id = s.authority_id
          AND f.native_kind = s.native_kind AND f.native_key = s.native_id AND f.generation = s.generation
          WHERE s.kind = ? ORDER BY s.rowid`;
        return (handle.db as { prepare(sql: string): { all(kind: string): Array<Row> } })
          .prepare(sql)
          .all(kind)
          .map((row) => ({ ...row }));
      } finally {
        handle.close();
      }
    },
  };
  let stopped = false;
  ctx.stop = async () => {
    stopped = true;
    await core.stop();
  };
  try {
    await body(core, ctx);
  } finally {
    if (!stopped) await core.stop();
    rmSync(dirs.root, { recursive: true, force: true });
  }
}

type Context = ReturnType<typeof folders> & {
  dbPath: string;
  llm: ReturnType<typeof scriptedLlm>;
  mentionEvent(message: MemberMessage): unknown;
  emit(event: unknown): Promise<string>;
  posted(): Array<string>;
  rows(kind: string): Array<Row>;
  stop?: () => Promise<void>;
};

test('one message that names her makes one observe row, one model request, her text at the fake and a said row', async () => {
  await withCapturedLogs(() =>
    withCore(async (_core, ctx) => {
      const status = await ctx.emit(ctx.mentionEvent({ id: 'm1', content: 'hello bot', at: Date.now() }));
      assert.equal(status, 'ok');
      await until(() => ctx.posted().length === 1 && ctx.rows('said').length === 1);
      assert.equal(ctx.llm.requests.length, 1, 'one model request');
      assert.deepEqual(ctx.posted(), [ANSWER], 'her text arrived unchanged');
      const seen = ctx.rows('seen').map((row) => [row.native_id, row.text]);
      assert.deepEqual(seen, [['m1', 'hello bot']], 'one observe row for the message');
      assert.deepEqual(
        ctx.rows('said').map((row) => row.text),
        [ANSWER]
      );
    })
  );
});

test('the same event emitted again is a duplicate and she answers once', async () => {
  await withCapturedLogs(() =>
    withCore(async (_core, ctx) => {
      const event = ctx.mentionEvent({ id: 'm2', content: 'hello again', at: Date.now() });
      assert.equal(await ctx.emit(event), 'ok');
      await until(() => ctx.posted().length === 1);
      assert.equal(await ctx.emit(event), 'duplicate');
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(ctx.llm.requests.length, 1);
      assert.deepEqual(ctx.posted(), [ANSWER]);
    })
  );
});

test('stop closes the memory database, releases its lock and removes the socket file', async () => {
  await withCapturedLogs(() =>
    withCore(async (_core, ctx) => {
      const socket = join(ctx.dataDir, 'run', 'core.sock');
      assert.equal(existsSync(socket), true, 'the core listens while it runs');
      assert.equal(existsSync(lockPathOf(ctx.dbPath)), true, 'the core holds the writer lock while it runs');
      await ctx.stop?.();
      assert.equal(existsSync(socket), false);
      assert.equal(existsSync(lockPathOf(ctx.dbPath)), false);
      // A writer opens at once: nothing of the core still holds the file.
      openMemoryDb(ctx.dbPath).close();
    })
  );
});

test('an absent canonical data directory is created and the fresh core shuts down cleanly', async () => {
  const dirs = folders();
  const dataDir = join(dirs.root, 'missing');
  const rootDir = join(dirs.root, 'engine');
  mkdirSync(rootDir);
  for (const folder of ['config', 'prompts', 'agents'])
    cpSync(join(REPO, folder), join(rootDir, folder), { recursive: true });
  writeFileSync(join(rootDir, 'config', 'config.json'), JSON.stringify(PRIVATE_CONFIG));
  assert.equal(existsSync(dataDir), false);
  try {
    await withCapturedLogs(async () => {
      // Fresh persona storage bootstraps without a pre-existing private layer.
      const core = await startCore({
        paths: { rootDir, privateDir: dataDir, dataDir },
        env: {},
        interfaces: [],
        llm: scriptedLlm(),
        embedder: { embed: () => Promise.resolve([]) },
      });
      try {
        assert.equal(existsSync(dataDir), true);
      } finally {
        await core.stop();
      }
      assert.equal(existsSync(join(dataDir, 'run', 'core.sock')), false);
      assert.equal(existsSync(lockPathOf(join(dataDir, 'memory.db'))), false);
    });
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('a core whose video role is off starts no yt-dlp probe of the YouTube canary', async () => {
  // `media.video.ytdlpPath` names a script that leaves a marker when it runs. The canary probe runs it at the start
  // when the video role is up, so an absent marker after the start shows the probe never began.
  const scratch = mkdtempSync(join(tmpdir(), 'cy-'));
  const marker = join(scratch, 'ran');
  const script = join(scratch, 'yt-dlp.sh');
  writeFileSync(script, `#!/bin/sh\necho ran > '${marker}'\nexit 1\n`);
  chmodSync(script, 0o755);
  try {
    await withCapturedLogs(() =>
      withCore(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 600));
          assert.equal(existsSync(marker), false);
        },
        { models: { base: { video: false } }, media: { video: { ytdlpPath: script } } }
      )
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
