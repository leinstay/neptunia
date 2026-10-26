// The slice end to end: `startCore` (src/core.js) over temporary data and private directories, the tracked prompts, a
// scripted model and the fake interface (src/interface/fake-interface.ts) carrying the discord.js-shaped seams of
// tests/fixtures/fake-legacy.ts. One member message that names the persona goes through the link, the event door, the
// pipeline, a turn and the memory database, and her `<msg>` text comes back over the link to the fake adapter. The model
// is a function that records its requests, so nothing calls a provider, and the settings that would add helper requests
// or random behaviour are switched off in the private layer. The memory database is read through a second, read-only
// connection, because the core holds the writer lock. The link socket sits at `<data>/run/core.sock`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore } from '../src/core.js';
import { start } from '../src/interface/fake-interface.ts';
import { lockPathOf, openMemoryDb } from '../src/memory/db/open.js';
import { createFakeLegacy } from './fixtures/fake-legacy.ts';
import type { MemberMessage } from './fixtures/fake-legacy.ts';
import { withCapturedLogs } from './fixtures/capture-logs.js';

type Running = Awaited<ReturnType<typeof start>>;
type Row = Record<string, unknown>;

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SELF_ID = 'self-id';
const ANSWER = 'γεια σου, καλημέρα';
const PRIVATE_CONFIG = {
  bot: { timezone: 'UTC', owners: [], guildId: 'g1' },
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
function folders() {
  const root = mkdtempSync(join(tmpdir(), 'cs-'));
  const dataDir = join(root, 'd');
  const privateDir = join(root, 'p');
  mkdirSync(privateDir);
  writeFileSync(join(privateDir, 'config.local.json'), JSON.stringify(PRIVATE_CONFIG));
  return { root, dataDir, privateDir, paths: { rootDir: REPO, privateDir, dataDir } };
}

// The scripted model: it answers every request with `<msg>` + ANSWER and keeps the requests it got.
function scriptedLlm() {
  const requests: Array<unknown> = [];
  return {
    requests,
    complete: (messages: unknown): Promise<{ text: string; usage: object; estimated: number }> => {
      requests.push(messages);
      return Promise.resolve({ text: `<msg>${ANSWER}</msg>`, usage: {}, estimated: 10 });
    },
  };
}

async function withCore(body: (core: Awaited<ReturnType<typeof startCore>>, ctx: Context) => Promise<void>) {
  const dirs = folders();
  const fake = createFakeLegacy({ selfId: SELF_ID });
  const { legacy } = fake;
  const llm = scriptedLlm();
  let running: Running | null = null;
  const core = await startCore({
    paths: dirs.paths,
    env: { OPENROUTER_CORE_KEY: 'test-key' },
    interfaces: [
      {
        name: 'fake',
        start: async (host) => {
          running = await start(host, { legacy, selfId: SELF_ID });
          return running;
        },
      },
    ],
    llm: llm as never,
    embedder: { embed: () => Promise.resolve([]) },
  });
  if (running === null) throw new Error('the core never started the fake interface');
  const live: Running = running;
  const dbPath = join(dirs.dataDir, 'memory.db');
  const ctx: Context = {
    ...dirs,
    dbPath,
    llm,
    mentionEvent: (message) => fake.mentionEvent(message),
    emit: (event) => live.emit(event),
    posted: () =>
      live.adapter
        .messagesIn('c1')
        .filter((message) => message.authorId === SELF_ID)
        .map((message) => message.text),
    rows: (kind) => {
      const handle = openMemoryDb(dbPath, { readOnly: true });
      try {
        const sql = 'SELECT kind, native_id, text, direct FROM sources WHERE kind = ? ORDER BY rowid';
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
  mentionEvent(message: MemberMessage): Row;
  emit(event: Row): Promise<string>;
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

test('a private directory that does not exist rejects the start with an error and never exits the process', async () => {
  const dirs = folders();
  try {
    await withCapturedLogs(() =>
      assert.rejects(
        startCore({
          paths: { ...dirs.paths, privateDir: join(dirs.root, 'missing') },
          env: { OPENROUTER_CORE_KEY: 'test-key' },
          interfaces: [],
          llm: scriptedLlm() as never,
          embedder: { embed: () => Promise.resolve([]) },
        }),
        /private directory/
      )
    );
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
});
